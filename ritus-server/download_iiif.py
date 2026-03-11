"""
download_iiif.py – IIIF download module used by krakenServer.py.

Provides:
  - download_iiif_manifest(url)  – fetch & return parsed JSON manifest
  - get_labels_and_urls(manifest) – extract ordered list of (label, image_url, service_url)
  - run_iiif_download(...)        – full background download with retry, progress
                                    callback and cancellation support
"""

import os
import time
import logging
import requests
from io import BytesIO
from PIL import Image as PILImage

logger = logging.getLogger(__name__)

# Retry delays in seconds after consecutive failures (index 0 = 1st retry, etc.)
RETRY_DELAYS = [5, 10, 15, 30, 60]


# ---------------------------------------------------------------------------
# Manifest helpers
# ---------------------------------------------------------------------------

def download_iiif_manifest(url):
    """Download and return a parsed IIIF manifest JSON."""
    logger.info(f"Downloading IIIF manifest from: {url}")
    response = requests.get(url, timeout=30)
    response.raise_for_status()
    logger.info("IIIF manifest downloaded successfully.")
    return response.json()


def get_labels_and_urls(manifest):
    """
    Parse manifest and return an ordered list of (label, image_url, service_url).
    Uses a list to preserve page order and allow duplicate labels.
    """
    pages = []
    logger.info("Parsing IIIF manifest to extract labels and image URLs...")

    def _safe_label(raw):
        if not raw:
            return "untitled"
        if isinstance(raw, str):
            return raw
        if isinstance(raw, list):
            return raw[0] if raw else "untitled"
        if isinstance(raw, dict):
            for key in ("none", "pl", "en"):
                val = raw.get(key)
                if val:
                    return val[0] if isinstance(val, list) else str(val)
            first = next(iter(raw.values()), None)
            if first:
                return first[0] if isinstance(first, list) else str(first)
        return "untitled"

    # --- First pass: collect raw (label, image_url, service_url) tuples ---
    raw_pages = []  # list of (raw_label, image_url, service_url)

    # IIIF Presentation API v3
    if "items" in manifest:
        for item in manifest["items"]:
            if item.get("type") != "Canvas":
                continue
            raw_label = _safe_label(item.get("label"))
            image_url = None
            service_url = None

            for ann_page in item.get("items", []):
                if ann_page.get("type") != "AnnotationPage":
                    continue
                for ann in ann_page.get("items", []):
                    if ann.get("type") == "Annotation" and ann.get("motivation") == "painting":
                        body = ann.get("body", {})
                        if body.get("type") == "Image" and body.get("id"):
                            image_url = body["id"]
                            svc = body.get("service")
                            if isinstance(svc, dict):
                                service_url = svc.get("@id") or svc.get("id")
                            elif isinstance(svc, list) and svc:
                                service_url = svc[0].get("@id") or svc[0].get("id")
                            break
                if image_url:
                    break

            if image_url:
                raw_pages.append((raw_label, image_url, service_url))

    # IIIF Presentation API v2
    elif "sequences" in manifest:
        for sequence in manifest.get("sequences", []):
            for canvas in sequence.get("canvases", []):
                raw_label = _safe_label(canvas.get("label"))
                image_url = None
                service_url = None

                for img in canvas.get("images", []):
                    resource = img.get("resource", {})
                    image_url = resource.get("@id")
                    if image_url:
                        svc = resource.get("service", {})
                        service_url = (svc.get("@id") or svc.get("id")) if isinstance(svc, dict) else None
                        break

                if image_url:
                    raw_pages.append((raw_label, image_url, service_url))

    # --- Second pass: add _N suffix only for duplicate labels ---
    from collections import Counter
    label_counts = Counter(raw_label for raw_label, _, __ in raw_pages)
    label_seen = {}  # raw_label -> how many times seen so far
    for seq_num, (raw_label, image_url, service_url) in enumerate(raw_pages, start=1):
        if label_counts[raw_label] > 1:
            label_seen[raw_label] = label_seen.get(raw_label, 0) + 1
            label = f"{raw_label}_{label_seen[raw_label]}"
        else:
            label = raw_label
        logger.info(f"  Page {seq_num}: {label} -> {image_url}")
        pages.append((label, image_url, service_url))

    logger.info(f"Total pages found in manifest: {len(pages)}")
    return pages


# ---------------------------------------------------------------------------
# Image download with retry
# ---------------------------------------------------------------------------

def fetch_image_with_retry(image_url, service_url=None, stop_event=None):
    """
    Download an image, retrying with increasing delays on failure.
    Raises RuntimeError if all attempts fail, InterruptedError if cancelled.
    Returns a PIL Image object.
    """
    last_error = None
    retry_delays = RETRY_DELAYS + [None]  # None signals last attempt
    for attempt, delay in enumerate(retry_delays, start=1):
        if stop_event and stop_event.is_set():
            raise InterruptedError("Download cancelled")
        try:
            return _fetch_once(image_url, service_url)
        except Exception as e:
            last_error = e
            if delay is None:
                break
            logger.warning(
                f"Attempt {attempt} failed for {image_url}: {e}. "
                f"Retrying in {delay}s..."
            )
            for _ in range(delay * 2):
                if stop_event and stop_event.is_set():
                    raise InterruptedError("Download cancelled")
                time.sleep(0.5)

    raise RuntimeError(
        f"Failed to download image after {len(RETRY_DELAYS) + 1} attempts: {last_error}"
    )


def _fetch_once(image_url, service_url=None):
    """Single download attempt, falls back to IIIF Image API service URL if needed."""
    resp = requests.get(image_url, timeout=60)
    resp.raise_for_status()
    try:
        img = PILImage.open(BytesIO(resp.content))
        img.load()
        return img
    except Exception:
        pass

    if service_url:
        for size_param in ("full/full", "full/max", "full/2048,"):
            fallback_url = f"{service_url}/{size_param}/0/default.jpg"
            logger.info(f"  Direct URL failed, trying IIIF service: {fallback_url}")
            resp2 = requests.get(fallback_url, timeout=60)
            if resp2.status_code == 200:
                try:
                    img = PILImage.open(BytesIO(resp2.content))
                    img.load()
                    return img
                except Exception:
                    continue

    raise RuntimeError(f"Could not parse a valid image from {image_url}")


# ---------------------------------------------------------------------------
# Main background download runner
# ---------------------------------------------------------------------------

def run_iiif_download(
    project_id,
    iiif_url,
    upload_folder,
    start_page,
    flask_app,
    on_progress,
    stop_event,
):
    """
    Full server-side IIIF download – meant to run in a background thread.

    Parameters
    ----------
    project_id   : int
    iiif_url     : str
    upload_folder: str    path like "uploads"
    start_page   : int    1-based; pass len(existing_images)+1 to append
    flask_app    : Flask  application instance for DB context
    on_progress  : callable(current_page, total_pages, status, error=None)
                   status in {"running", "completed", "failed", "cancelled"}
    stop_event   : threading.Event – set externally to cancel
    """
    from models import db, Image as ImageModel  # avoid circular import at module level

    try:
        # --- 1. Download manifest (with retry) ---
        manifest = None
        last_error = None
        for attempt, delay in enumerate(RETRY_DELAYS + [None], start=1):
            if stop_event.is_set():
                on_progress(0, 0, "cancelled")
                return
            try:
                manifest = download_iiif_manifest(iiif_url)
                break
            except Exception as e:
                last_error = e
                if delay is None:
                    break
                logger.warning(f"Manifest download attempt {attempt} failed: {e}. Retrying in {delay}s...")
                for _ in range(delay * 2):
                    if stop_event.is_set():
                        on_progress(0, 0, "cancelled")
                        return
                    time.sleep(0.5)

        if manifest is None:
            on_progress(0, 0, "failed", error=f"Could not download manifest: {last_error}")
            return

        # --- 2. Parse pages ---
        all_pages = get_labels_and_urls(manifest)
        total_pages = len(all_pages)
        if total_pages == 0:
            on_progress(0, 0, "failed", error="Manifest contains no pages.")
            return

        start_idx = max(0, start_page - 1)  # convert to 0-based
        pages_to_download = all_pages[start_idx:]
        pages_done = 0

        on_progress(start_page - 1, total_pages, "running")

        # --- 3. Prepare output folder ---
        project_folder = os.path.join(upload_folder, f"project_{project_id}")
        os.makedirs(project_folder, exist_ok=True)

        # --- 4. Download each page ---
        for label, image_url, service_url in pages_to_download:
            if stop_event.is_set():
                on_progress(start_page - 1 + pages_done, total_pages, "cancelled")
                return

            try:
                img = fetch_image_with_retry(image_url, service_url, stop_event=stop_event)
            except InterruptedError:
                on_progress(start_page - 1 + pages_done, total_pages, "cancelled")
                return
            except Exception as e:
                on_progress(
                    start_page - 1 + pages_done,
                    total_pages,
                    "failed",
                    error=f"Failed to download page '{label}': {e}",
                )
                return

            # Sanitize label for use as filename
            sanitized = "".join(
                c for c in label if c.isalnum() or c in (" ", "_", "-")
            ).strip().replace(" ", "_")
            if not sanitized:
                sanitized = f"page_{start_page + pages_done}"

            temp_path = os.path.join(project_folder, f"temp_{project_id}_{sanitized}.jpg")

            with flask_app.app_context():
                try:
                    if img.mode not in ("RGB", "L"):
                        img = img.convert("RGB")

                    img.save(temp_path, "JPEG", quality=90)

                    image_record = ImageModel(
                        project_id=project_id,
                        name=sanitized,
                        original=temp_path,
                    )
                    db.session.add(image_record)
                    db.session.flush()

                    final_filename = f"{sanitized}_{image_record.id}.jpg"
                    final_path = os.path.join(project_folder, final_filename)
                    os.rename(temp_path, final_path)
                    image_record.original = f"uploads/project_{project_id}/{final_filename}"

                    # Create thumbnail
                    thumbnail_filename = f"{sanitized}_{image_record.id}_thumbnail.jpg"
                    thumbnail_path = os.path.join(project_folder, thumbnail_filename)
                    thumb = img.copy()
                    thumb.thumbnail((360, 240))
                    if thumb.mode not in ("RGB", "L"):
                        thumb = thumb.convert("RGB")
                    thumb.save(thumbnail_path, "JPEG", quality=85)

                    db.session.commit()
                    logger.info(f"Saved page {start_page + pages_done}: {final_filename}")

                except Exception as e:
                    db.session.rollback()
                    if os.path.exists(temp_path):
                        os.remove(temp_path)
                    on_progress(
                        start_page - 1 + pages_done,
                        total_pages,
                        "failed",
                        error=f"DB/filesystem error saving '{label}': {e}",
                    )
                    return

            pages_done += 1
            on_progress(start_page - 1 + pages_done, total_pages, "running")

        on_progress(start_page - 1 + pages_done, total_pages, "completed")

    except Exception as e:
        logger.exception(f"Unexpected error in run_iiif_download: {e}")
        on_progress(0, 0, "failed", error=str(e))
