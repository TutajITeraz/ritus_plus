"""
layout_parser_preprocessing.py

Optional image-level layout analysis using the LayoutParser library. This is
the primary strategy behind the "Enhanced multi column detection" option;
krakenServer.py falls back to the purely geometric heuristic in
multi_column_layout.py if this module (or its underlying model) isn't
available.

Why add this on top of the geometric heuristic
------------------------------------------------
multi_column_layout.py reorders blla's output using only the OCR lines'
own geometry (baseline/boundary boxes). That's cheap and dependency-free,
but it's a heuristic: it has no idea an inline illustration is sitting in
the middle of a column, because kraken's line segmenter doesn't produce
lines over an image - the geometric heuristic never "sees" the image as an
obstacle, it only reasons about the text line boxes it's given.

LayoutParser runs an object-detection model trained specifically to find
page regions (text columns, titles, figures, tables) and gives us actual
detected region boxes, including regions with no text at all (e.g. a
figure). Those regions are used two ways:

  1. To compute a reading order between regions with a classic recursive
     XY-cut: find a full horizontal or vertical gap that cleanly separates
     the regions into two groups, recurse on each group, and fall back to
     a stable top-to-bottom/left-to-right sort if no clean cut exists (e.g.
     overlapping detections).
  2. To assign every kraken line to whichever region contains it (nearest
     region if none contains it exactly), so a line's final position in the
     output is "this region's reading-order rank, then top-to-bottom within
     the region".

This correctly keeps text that continues below an inserted illustration in
the same column's reading-order slot relative to the other column, which
the geometry-only heuristic in multi_column_layout.py has no way to know
about (it would just see two separate clusters of lines and try to guess).

Installation
------------
This module is entirely optional - if `layoutparser` isn't installed, or a
model can't be loaded (e.g. no internet access to download weights on
first use, or the backend package is missing), `is_available()` returns
False / `reorder_lines_using_layout_parser` returns None, and the caller
(krakenServer.py) falls back to `multi_column_layout.reorder_lines_for_multi_column`.

To enable it, install the EfficientDet backend - pure PyTorch, no C++
compilation required (unlike the Detectron2 backend, which is notoriously
hard to build on macOS, especially Apple Silicon):

    pip install "layoutparser[effdet]"

By default this uses the "lp://efficientdet/PubLayNet" model. PubLayNet is
trained on modern scientific journal layouts (classes: Text, Title, List,
Table, Figure), not historical manuscripts, so its box *labels* won't
always be meaningful for a liturgical manuscript page - but its box
*positions* (which is what reading order actually depends on here) still
generalize reasonably well to "this is a visually separate block".

If you can get the heavier Detectron2 backend installed, the "PrimaLayout"
model was trained specifically on historical/complex document layouts
(classes: TextRegion, ImageRegion, TableRegion, MathsRegion,
SeparatorRegion, OtherRegion) and should perform better on manuscripts:

    pip install layoutparser torchvision
    pip install "detectron2@git+https://github.com/facebookresearch/detectron2.git@v0.5#egg=detectron2"

Then set the RITUS_LAYOUT_MODEL environment variable before starting the
server:

    export RITUS_LAYOUT_MODEL="lp://PrimaLayout/mask_rcnn_R_50_FPN_3x/config"

Note: none of this has been exercised against the real model in this
environment (no network/installation access here) - the region-ordering
and line-assignment logic below (`_xy_cut_order`, `order_lines_by_regions`)
is unit tested independently of the model in test_layout_parser_preprocessing.py,
but the `detect_layout_regions`/model-loading path should be smoke-tested
once layoutparser is actually installed.
"""

import logging
import os
import threading

logger = logging.getLogger(__name__)

# Which LayoutParser model to load. Defaults to the EfficientDet-backed
# PubLayNet model since it installs without compiling anything. Override
# with e.g. "lp://PrimaLayout/mask_rcnn_R_50_FPN_3x/config" if the (heavier)
# Detectron2 backend is installed - PrimaLayout is trained on historical
# documents and should be a better match for manuscripts.
LAYOUT_MODEL_CONFIG = os.environ.get("RITUS_LAYOUT_MODEL", "lp://efficientdet/PubLayNet")

# LayoutParser-based reordering is opt-in, OFF by default, even if the
# package is installed and a model loads fine. Reason: the default
# PubLayNet model is trained on modern scientific-journal layouts (Text,
# Title, List, Table, Figure) - it can misdetect regions on historical /
# liturgical manuscript pages, in which case the geometric heuristic in
# multi_column_layout.py (which reasons purely about where kraken's own OCR
# lines actually sit, no model involved) gives a more reliable reading
# order. Set RITUS_ENABLE_LAYOUTPARSER=1 (or "true") in the environment
# before starting the server to opt in and use it.
ENABLE_LAYOUTPARSER = os.environ.get("RITUS_ENABLE_LAYOUTPARSER", "").strip().lower() in (
    "1", "true", "yes",
)

try:
    import layoutparser as lp  # noqa: N813
    LAYOUTPARSER_AVAILABLE = True
    _import_error = None
except Exception as exc:  # pragma: no cover - depends on the environment
    lp = None
    LAYOUTPARSER_AVAILABLE = False
    _import_error = exc


_model = None
_model_lock = threading.Lock()
_model_load_failed = False


def is_available():
    """Whether the ``layoutparser`` package itself could be imported.

    This does not guarantee a model can actually be loaded (that also needs
    the right backend package - effdet/detectron2/paddledetection - plus,
    on first use, a successful download of the pretrained weights).
    """
    return LAYOUTPARSER_AVAILABLE


def _get_model():
    """Lazily load and cache the layout detection model (once per process)."""
    global _model, _model_load_failed
    if _model is not None or _model_load_failed:
        return _model
    with _model_lock:
        if _model is not None or _model_load_failed:
            return _model
        try:
            logger.info("Loading LayoutParser model %s ...", LAYOUT_MODEL_CONFIG)
            _model = lp.AutoLayoutModel(LAYOUT_MODEL_CONFIG)
            logger.info("LayoutParser model loaded.")
        except Exception:
            logger.exception(
                "Failed to load LayoutParser model %s - enhanced multi column "
                "detection will fall back to the geometric heuristic instead.",
                LAYOUT_MODEL_CONFIG,
            )
            _model = None
            _model_load_failed = True
    return _model


class Region:
    """A detected page region, in the same pixel coordinate space as the
    source image (and therefore the same space as kraken's line boxes)."""

    __slots__ = ("left", "top", "right", "bottom", "label", "score")

    def __init__(self, left, top, right, bottom, label=None, score=None):
        self.left, self.top, self.right, self.bottom = left, top, right, bottom
        self.label = label
        self.score = score

    @property
    def x_center(self):
        return (self.left + self.right) / 2.0

    @property
    def y_center(self):
        return (self.top + self.bottom) / 2.0

    def __repr__(self):
        return (
            f"Region(label={self.label!r}, "
            f"box=({self.left:.0f},{self.top:.0f},{self.right:.0f},{self.bottom:.0f}))"
        )


def detect_layout_regions(image, score_threshold=0.5):
    """Run the LayoutParser model on ``image`` and return a list of
    :class:`Region`.

    ``image`` should be a PIL.Image (any mode; converted to RGB) or a numpy
    array in the same pixel coordinate space kraken segmented. Returns
    ``None`` if the model can't be loaded or detection fails for any reason
    (missing backend, first-use weight download failure, unexpected runtime
    error, ...).
    """
    model = _get_model()
    if model is None:
        logger.debug("detect_layout_regions: no model loaded, returning None")
        return None
    try:
        pil_image = image.convert("RGB") if hasattr(image, "convert") else image
        layout = model.detect(pil_image)
    except Exception:
        logger.exception("LayoutParser detection failed; skipping layout-based reordering")
        return None

    regions = []
    dropped_for_score = 0
    for block in layout:
        try:
            x1, y1, x2, y2 = block.coordinates
        except Exception:
            continue
        score = getattr(block, "score", None)
        if score is not None and score_threshold is not None and score < score_threshold:
            dropped_for_score += 1
            continue
        regions.append(Region(x1, y1, x2, y2, label=getattr(block, "type", None), score=score))
    logger.info(
        "detect_layout_regions: model returned %d raw block(s), %d kept "
        "(score_threshold=%s), %d dropped for low score: %s",
        len(layout), len(regions), score_threshold, dropped_for_score, regions,
    )
    return regions


def _xy_cut_order(regions):
    """Recursive XY-cut: order regions by repeatedly finding a full
    horizontal or vertical gap that cleanly separates them into two
    non-empty groups (top/bottom, then left/right). Falls back to a stable
    top-to-bottom-then-left-to-right sort if no clean cut can be found at
    all (e.g. overlapping detections from an imperfect model).

    This is the standard document-layout-analysis technique for turning a
    handful of (few, high-confidence) region boxes into a reading order,
    and it naturally handles a title above N columns, N columns with no
    title, a title plus a mid-page subtitle, marginal columns, etc. - the
    same set of cases multi_column_layout.py's line-level heuristic
    targets, but working on far fewer, semantically-labeled boxes instead
    of raw OCR line geometry.
    """
    if len(regions) <= 1:
        return list(regions)

    by_top = sorted(regions, key=lambda r: r.top)
    for i in range(1, len(by_top)):
        top_group, bottom_group = by_top[:i], by_top[i:]
        if max(r.bottom for r in top_group) <= min(r.top for r in bottom_group):
            return _xy_cut_order(top_group) + _xy_cut_order(bottom_group)

    by_left = sorted(regions, key=lambda r: r.left)
    for i in range(1, len(by_left)):
        left_group, right_group = by_left[:i], by_left[i:]
        if max(r.right for r in left_group) <= min(r.left for r in right_group):
            return _xy_cut_order(left_group) + _xy_cut_order(right_group)

    # No clean cut at all - fall back to a stable, deterministic ordering
    # rather than leaving the order to chance.
    return sorted(regions, key=lambda r: (r.top, r.left))


def _line_bbox(line):
    points = getattr(line, "boundary", None) or getattr(line, "baseline", None)
    if not points:
        return None
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    if not xs or not ys:
        return None
    return min(xs), min(ys), max(xs), max(ys)


def _assign_line_to_region(bbox, regions):
    """Return the index (into ``regions``) of the region whose box contains
    the line's centroid, or - if none does - the region whose center is
    nearest to the line's centroid. A line is never dropped for lack of a
    containing region."""
    cx = (bbox[0] + bbox[2]) / 2.0
    cy = (bbox[1] + bbox[3]) / 2.0
    for i, r in enumerate(regions):
        if r.left <= cx <= r.right and r.top <= cy <= r.bottom:
            return i
    best_i, best_dist = 0, None
    for i, r in enumerate(regions):
        dist = (cx - r.x_center) ** 2 + (cy - r.y_center) ** 2
        if best_dist is None or dist < best_dist:
            best_dist, best_i = dist, i
    return best_i


def order_lines_by_regions(lines, regions):
    """Given kraken ``lines`` and already-detected ``regions``, return a new
    list of lines ordered by (region reading-order rank, y-position within
    that region).

    This function does not call the model or import layoutparser at all, so
    it is fully unit-testable independent of whether layoutparser (or a
    backend/model) is actually installed - see
    test_layout_parser_preprocessing.py.

    Returns the input order unchanged (as a new list) if there are fewer
    than two regions to work with, or if ``lines`` is empty.
    """
    if not lines:
        return []
    if not regions or len(regions) < 2:
        return list(lines)

    ordered_regions = _xy_cut_order(regions)
    region_rank = {id(r): rank for rank, r in enumerate(ordered_regions)}

    bboxes = {}
    for i, line in enumerate(lines):
        bbox = _line_bbox(line)
        if bbox is not None:
            bboxes[i] = bbox

    assigned_rank = {}
    y_within_region = {}
    for i, bbox in bboxes.items():
        region_idx = _assign_line_to_region(bbox, regions)
        assigned_rank[i] = region_rank[id(regions[region_idx])]
        y_within_region[i] = (bbox[1] + bbox[3]) / 2.0

    indexed = list(bboxes.keys())
    indexed.sort(key=lambda i: (assigned_rank[i], y_within_region[i]))

    # Lines without a usable bbox (shouldn't normally happen) are appended
    # at the end in their original relative order, so we never silently
    # drop a line.
    missing = [i for i in range(len(lines)) if i not in bboxes]
    final_order = indexed + missing
    return [lines[i] for i in final_order]


def reorder_lines_using_layout_parser(lines, image, score_threshold=0.5):
    """Main entry point: detect page regions with LayoutParser and use them
    to reorder ``lines``.

    Returns the reordered list on success - including the case where
    detection ran fine but found fewer than two usable regions, in which
    case the original order is returned unchanged. Returns ``None`` if
    LayoutParser (or its model) isn't usable at all, which signals the
    caller to fall back to
    ``multi_column_layout.reorder_lines_for_multi_column`` instead.
    """
    if not ENABLE_LAYOUTPARSER:
        logger.debug(
            "reorder_lines_using_layout_parser: disabled by default - set "
            "RITUS_ENABLE_LAYOUTPARSER=1 to opt in - using geometric fallback"
        )
        return None
    if not LAYOUTPARSER_AVAILABLE:
        logger.debug(
            "reorder_lines_using_layout_parser: layoutparser package not "
            "importable (import_error=%r) - returning None so caller falls "
            "back to the geometric heuristic", _import_error,
        )
        return None
    if not lines:
        return []
    try:
        regions = detect_layout_regions(image, score_threshold=score_threshold)
        if regions is None:
            logger.info(
                "reorder_lines_using_layout_parser: no regions detected "
                "(model unavailable or detection failed) - returning None"
            )
            return None
        if len(regions) < 2:
            logger.info(
                "reorder_lines_using_layout_parser: only %d region(s) detected "
                "(need >= 2) - order_lines_by_regions will return lines unchanged",
                len(regions),
            )
        result = order_lines_by_regions(lines, regions)
        logger.info(
            "reorder_lines_using_layout_parser: reordered %d line(s) using %d region(s)",
            len(lines), len(regions),
        )
        return result
    except Exception:
        logger.exception("Layout-parser based reordering failed unexpectedly")
        return None
