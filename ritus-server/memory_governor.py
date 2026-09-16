"""Bound how much page-sized kraken work is in flight at once.

Segmenting one manuscript page peaks at roughly 1.5 GB of RSS: blla upsamples a
per-class heatmap back to full page resolution, and that tensor, the page tensor
and the polygonisation are all alive at the same instant. (Measured on a
3280x4702 page with kraken 6.0.3 / torch 2.5.1: +1525 MB peak over a 528 MB
baseline.) Memory between pages is flat - there is no leak to chase - so the
only thing that can kill the server process is how many of those peaks overlap.

``transcription_workers`` used to size the batch pool on its own, so a config of
8 put eight peaks (~12 GB) in flight at once and the kernel OOM killer took the
whole service down mid-manuscript. Here concurrency is the smaller of the
configured worker count and what the machine's free RAM can actually hold, and a
page is refused admission outright while memory is already tight.

The check has to look at the whole box, not at this process: on the production
server Ollama alone holds ~20 GB of 31 GB and swap is exhausted, so the kernel
has nothing left to page out and an over-commit is an immediate OOM kill.
"""

import gc
import logging
import threading
import time
from contextlib import contextmanager

try:
    import psutil
except ImportError:  # the governor degrades to the configured limits
    psutil = None

logger = logging.getLogger(__name__)

# Budgeted peak RAM for one page, measured as above and rounded up.
DEFAULT_PAGE_MEMORY_MB = 2000
# RAM deliberately left unclaimed: the loaded models, Flask, SQLite, the page
# cache, and above all every other process on the box.
DEFAULT_MEMORY_HEADROOM_MB = 2048
# A page is never held back longer than this. A misreported memory figure must
# degrade throughput, never wedge a job forever.
DEFAULT_ADMISSION_TIMEOUT_S = 600

_MB = 1024 * 1024


def _read_cgroup_stat(paths):
    """First readable cgroup memory file among *paths*, in MB (None=unlimited)."""
    for path in paths:
        try:
            with open(path) as handle:
                raw = handle.read().strip()
        except OSError:
            continue
        if raw == "max":
            return None
        try:
            value = int(raw)
        except ValueError:
            continue
        # cgroup v1 spells "unlimited" as a nonsensically large number
        if value <= 0 or value > (1 << 50):
            return None
        return value / _MB
    return None


def available_memory_mb():
    """Memory this process may still take, in MB, or None if unknowable.

    Honours a cgroup ceiling (systemd ``MemoryMax``) when there is one, because
    that - not the size of the box - is what we would be killed against.
    """
    if psutil is None:
        return None
    try:
        available = psutil.virtual_memory().available / _MB
    except Exception:
        return None
    limit = _read_cgroup_stat((
        "/sys/fs/cgroup/memory.max",                     # cgroup v2
        "/sys/fs/cgroup/memory/memory.limit_in_bytes",   # cgroup v1
    ))
    if limit is not None:
        used = _read_cgroup_stat((
            "/sys/fs/cgroup/memory.current",
            "/sys/fs/cgroup/memory/memory.usage_in_bytes",
        ))
        if used is not None:
            available = min(available, max(0.0, limit - used))
    return available


def process_rss_mb():
    """This process's resident size in MB, or None when psutil is missing."""
    if psutil is None:
        return None
    try:
        return psutil.Process().memory_info().rss / _MB
    except Exception:
        return None


class MemoryGovernor:
    """Process-wide admission control for page-sized kraken work.

    Every path that segments a full page - the batch pool and the single-page
    API alike - passes through :meth:`page`, so the ceiling holds even when a
    user transcribes a page by hand while a batch job is running.
    """

    def __init__(self, config_loader=None, device="cpu",
                 admission_timeout_s=DEFAULT_ADMISSION_TIMEOUT_S,
                 available_memory=available_memory_mb):
        self._config_loader = config_loader or (lambda: {})
        self._device = device
        self._admission_timeout_s = admission_timeout_s
        self._available_memory = available_memory
        self._cond = threading.Condition()
        self._active = 0
        self._limit = 1

    # -- configuration -----------------------------------------------------

    def _config_mb(self, key, default):
        try:
            return max(256, int(self._config_loader().get(key, default)))
        except (AttributeError, TypeError, ValueError):
            return default

    def page_memory_mb(self):
        """Budgeted peak RAM for one page (domain_config.json may override)."""
        return self._config_mb("transcription_page_memory_mb", DEFAULT_PAGE_MEMORY_MB)

    def headroom_mb(self):
        """RAM left unclaimed for everything else (domain_config.json may override)."""
        return self._config_mb("transcription_memory_headroom_mb", DEFAULT_MEMORY_HEADROOM_MB)

    def set_limit(self, limit):
        with self._cond:
            self._limit = max(1, int(limit))
            self._cond.notify_all()

    def snapshot(self):
        with self._cond:
            return {"limit": self._limit, "active": self._active}

    # -- sizing ------------------------------------------------------------

    def cap_workers(self, configured):
        """Lower *configured* to the number of page peaks RAM can hold at once."""
        configured = max(1, int(configured))
        available = self._available_memory()
        if available is None:
            logger.warning(
                "Cannot read available memory (psutil missing?) - running the "
                "configured %d transcription worker(s) unchecked", configured,
            )
            return configured
        page_mb = self.page_memory_mb()
        headroom_mb = self.headroom_mb()
        affordable = int((available - headroom_mb) // page_mb)
        capped = max(1, min(configured, affordable))
        if capped < configured:
            logger.warning(
                "Capping transcription workers %d -> %d: %.0f MB available, "
                "%.0f MB budgeted per page plus %.0f MB headroom",
                configured, capped, available, page_mb, headroom_mb,
            )
        else:
            logger.info(
                "Transcription workers: %d (%.0f MB available, %.0f MB per page)",
                capped, available, page_mb,
            )
        return capped

    # -- admission ---------------------------------------------------------

    @contextmanager
    def page(self, label):
        self._acquire(label)
        try:
            yield
        finally:
            self._release()

    def _acquire(self, label):
        page_mb = self.page_memory_mb()
        headroom_mb = self.headroom_mb()
        deadline = time.monotonic() + self._admission_timeout_s
        warned = False
        with self._cond:
            while True:
                # One page always runs. Throttling may slow a job down but must
                # never stall it outright, and holding back the only page in
                # flight would buy nothing: nothing else is going to free the
                # memory it is waiting for.
                if self._active == 0:
                    break
                if self._active < self._limit:
                    available = self._available_memory()
                    if available is None or available >= page_mb + headroom_mb:
                        break
                    if not warned:
                        logger.warning(
                            "Holding %s: only %.0f MB free, a page needs "
                            "~%.0f MB (%d already in flight)",
                            label, available, page_mb, self._active,
                        )
                        warned = True
                if time.monotonic() >= deadline:
                    logger.warning(
                        "Admitting %s after %ds of memory pressure rather than "
                        "stalling the job", label, self._admission_timeout_s,
                    )
                    break
                self._cond.wait(timeout=2.0)
            self._active += 1

    def _release(self):
        with self._cond:
            self._active -= 1
            self._cond.notify_all()

    # -- housekeeping ------------------------------------------------------

    def release_page_memory(self):
        """Hand a finished page's tensors back before the next one is admitted."""
        gc.collect()
        if self._device.startswith("cuda"):
            try:
                import torch
                torch.cuda.empty_cache()
            except Exception:
                logger.debug("torch.cuda.empty_cache() failed", exc_info=True)

    def log_state(self, context):
        """Log the whole machine's memory picture, not just our slice of it.

        An OOM kill here is usually somebody else's doing - Ollama growing, swap
        already gone - so the log has to show the box, or the next post-mortem
        is guesswork again.
        """
        if psutil is None:
            return
        try:
            vm = psutil.virtual_memory()
            sw = psutil.swap_memory()
        except Exception:
            return
        logger.info(
            "Memory at %s: %.0f/%.0f MB used, %.0f MB available, swap "
            "%.0f/%.0f MB used, this process rss=%.0f MB",
            context, (vm.total - vm.available) / _MB, vm.total / _MB,
            vm.available / _MB, sw.used / _MB, sw.total / _MB,
            process_rss_mb() or 0.0,
        )
        if sw.total and sw.used / sw.total > 0.95:
            logger.warning(
                "Swap is essentially full (%.0f/%.0f MB) - the kernel has "
                "nothing left to page out, so an over-commit here is an "
                "outright OOM kill", sw.used / _MB, sw.total / _MB,
            )
