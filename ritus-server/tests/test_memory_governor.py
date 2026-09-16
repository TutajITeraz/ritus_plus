"""Tests for the transcription memory governor.

The production failure these guard against: eight batch workers each peaking at
~1.5 GB while Ollama held 20 GB of the box's 31 GB and swap was exhausted, so
the kernel OOM killer took the whole service down mid-manuscript.
"""
import os
import sys
import threading
import time

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from memory_governor import (  # noqa: E402
    DEFAULT_MEMORY_HEADROOM_MB,
    DEFAULT_PAGE_MEMORY_MB,
    MemoryGovernor,
    _read_cgroup_stat,
)


def governor(available_mb, config=None, timeout_s=60):
    """A governor whose view of free memory is whatever the test says it is."""
    box = {"available": available_mb}
    gov = MemoryGovernor(
        config_loader=lambda: (config or {}),
        admission_timeout_s=timeout_s,
        available_memory=lambda: box["available"],
    )
    return gov, box


# --- worker sizing ---------------------------------------------------------

def test_cap_workers_uses_configured_count_when_ram_is_plentiful():
    gov, _ = governor(64_000)
    assert gov.cap_workers(8) == 8


def test_cap_workers_caps_to_what_ram_holds():
    # The production box: ~8.5 GB free of 31 GB, the rest held by Ollama.
    gov, _ = governor(8_500)
    # (8500 - 2048) // 2000 == 3
    assert gov.cap_workers(8) == 3


def test_cap_workers_never_returns_zero():
    """Starving the box must slow transcription down, not stop it happening."""
    gov, _ = governor(100)
    assert gov.cap_workers(8) == 1


def test_cap_workers_falls_back_to_config_when_memory_is_unreadable():
    gov = MemoryGovernor(config_loader=dict, available_memory=lambda: None)
    assert gov.cap_workers(8) == 8


def test_cap_workers_honours_config_overrides():
    gov, _ = governor(8_500, config={
        "transcription_page_memory_mb": 1000,
        "transcription_memory_headroom_mb": 500,
    })
    # (8500 - 500) // 1000 == 8
    assert gov.cap_workers(8) == 8


def test_config_overrides_survive_junk_values():
    gov, _ = governor(8_500, config={"transcription_page_memory_mb": "not a number"})
    assert gov.page_memory_mb() == DEFAULT_PAGE_MEMORY_MB
    assert gov.headroom_mb() == DEFAULT_MEMORY_HEADROOM_MB


# --- admission -------------------------------------------------------------

def test_admission_respects_the_limit():
    gov, _ = governor(64_000)
    gov.set_limit(2)
    entered = threading.Semaphore(0)
    release = threading.Event()

    def hold():
        with gov.page("page"):
            entered.release()
            release.wait(5)

    threads = [threading.Thread(target=hold, daemon=True) for _ in range(2)]
    for t in threads:
        t.start()
    assert entered.acquire(timeout=5)
    assert entered.acquire(timeout=5)
    assert gov.snapshot() == {"limit": 2, "active": 2}

    third = threading.Thread(target=hold, daemon=True)
    third.start()
    assert not entered.acquire(timeout=0.5), "third page ran past a limit of 2"

    release.set()
    for t in threads + [third]:
        t.join(5)
    assert gov.snapshot()["active"] == 0


def test_a_single_page_always_runs_however_tight_memory_is():
    """With nothing else in flight there is no other page left to wait for."""
    gov, _ = governor(10)
    gov.set_limit(4)
    with gov.page("page"):
        assert gov.snapshot()["active"] == 1


def test_second_page_waits_while_memory_is_tight_then_proceeds():
    gov, box = governor(2_500)  # below one page + headroom
    gov.set_limit(4)
    started = threading.Event()
    admitted = threading.Event()

    def second():
        started.set()
        with gov.page("second"):
            admitted.set()

    with gov.page("first"):
        t = threading.Thread(target=second, daemon=True)
        t.start()
        assert started.wait(5)
        assert not admitted.wait(1.0), "admitted a second page with no RAM for it"
        box["available"] = 64_000  # e.g. Ollama unloaded its model
        assert admitted.wait(10), "stayed blocked after memory freed up"
    t.join(5)


def test_memory_pressure_eventually_yields_rather_than_wedging_the_job():
    gov, _ = governor(10, timeout_s=1)
    gov.set_limit(4)
    admitted = threading.Event()

    def second():
        with gov.page("second"):
            admitted.set()

    with gov.page("first"):
        t = threading.Thread(target=second, daemon=True)
        t.start()
        assert admitted.wait(15), "a job stayed blocked past the admission timeout"
    t.join(5)


def test_slot_is_released_when_the_page_raises():
    gov, _ = governor(64_000)
    with pytest.raises(ValueError):
        with gov.page("page"):
            raise ValueError("segmentation blew up")
    assert gov.snapshot()["active"] == 0


def test_unreadable_memory_falls_back_to_the_limit_alone():
    gov = MemoryGovernor(config_loader=dict, available_memory=lambda: None)
    gov.set_limit(2)
    with gov.page("first"):
        with gov.page("second"):
            assert gov.snapshot()["active"] == 2


# --- cgroup ceilings -------------------------------------------------------

def test_cgroup_stat_reads_a_byte_count(tmp_path):
    path = tmp_path / "memory.max"
    path.write_text(str(4 * 1024 * 1024 * 1024))
    assert _read_cgroup_stat((str(path),)) == 4096


def test_cgroup_stat_treats_max_as_unlimited(tmp_path):
    path = tmp_path / "memory.max"
    path.write_text("max")
    assert _read_cgroup_stat((str(path),)) is None


def test_cgroup_stat_treats_the_v1_sentinel_as_unlimited(tmp_path):
    path = tmp_path / "memory.limit_in_bytes"
    path.write_text("9223372036854771712")
    assert _read_cgroup_stat((str(path),)) is None


def test_cgroup_stat_skips_missing_files(tmp_path):
    present = tmp_path / "memory.current"
    present.write_text(str(512 * 1024 * 1024))
    assert _read_cgroup_stat((str(tmp_path / "nope"), str(present))) == 512
