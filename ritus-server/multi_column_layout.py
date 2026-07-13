"""
multi_column_layout.py

Post-processing helper for Kraken (blla) baseline segmentation output.

Problem
-------
Kraken's neural baseline segmenter (``kraken.blla.segment``) returns lines in
a "reading order" derived from heuristics baked into the segmentation model.
On manuscript/print pages with a centered title/heading above a multi-column
body, that heuristic regularly falls apart and interleaves lines from
different columns. Real pages make this worse in ways a naive "wide+centered
= title, then split remainder into exactly two halves" heuristic can't
handle:

  - Titles/subtitles are not always wide. A short subtitle sitting in the
    gap *between* two columns (e.g. a one-word section heading) doesn't
    look wide relative to the page, but it still needs to be read before/
    after the columns it separates, not interleaved into one of them.
  - Pages can have 3+ columns, not just 2.
  - Marginalia (folio/quire signatures, rubric labels, glosses) often sit in
    a narrow strip outside the main text columns and must not get dragged
    into the left or right column's text.
  - A page can have more than one spanning line (e.g. a header title AND a
    footer/colophon, or a title plus a mid-page subtitle breaking the
    columns into two vertical sections).

Approach
--------
Rather than classifying lines purely by width, this module uses each line's
*position relative to the other lines on the page*:

1. Compute a bounding box for every line (from its ``boundary`` polygon,
   falling back to ``baseline`` points).
2. Group lines into horizontal "rows" by clustering on vertical position: a
   row is a set of lines whose y-centers are close together relative to the
   page's typical single-line height. In a multi-column layout, the lines
   from each column that sit side-by-side end up in the same row; in a
   title/subtitle line that has nothing else typeset at its height, that
   line forms a row of its own.
3. Rows that contain 2+ lines reveal where the actual columns are: pool the
   x-centers of every line in every such row and look for horizontal gaps
   between them. Each gap wide enough to be a real column gutter becomes a
   boundary between two column "bands". This naturally produces however many
   bands the page actually has (2 columns, 3 columns, or main columns plus a
   narrow marginalia band), instead of assuming exactly two.
4. Any line alone in its row (no sibling at that height) is classified as
   "spanning" if it sits inside the combined left-right envelope of the
   detected bands - i.e. it occupies space between/over the columns - no
   matter how narrow it is. A lone line sitting *outside* that envelope
   (e.g. an isolated marginal note not aligned with a body line) is instead
   assigned to whichever band it's closest to.
5. The page is walked top-to-bottom; lines are queued per band, and every
   time a spanning line is reached the queued bands are flushed in
   left-to-right order, then the spanning line itself is emitted, before
   queuing resumes. This reproduces "title, then column 1, then column 2,
   ..." for the common case, but also handles a spanning line in the middle
   of the page (splitting the columns into two vertical sections) and
   multiple spanning lines (header + footer, or several subtitles).

If fewer than two column bands can be established (e.g. a genuine
single-column page), the input order is returned completely unchanged - this
is a safe no-op for pages that don't need reordering.

This module has no dependency on kraken itself - it only expects objects
with ``.baseline`` and/or ``.boundary`` attributes (both lists of ``(x, y)``
tuples), which is exactly what ``kraken.containers.BaselineLine`` provides.
That keeps it trivially unit-testable without a kraken/torch install.

Known limitations
------------------
This is a geometric heuristic, not full layout analysis. It assumes lines
from different columns that belong to the "same row" are roughly at the same
height (true for most justified multi-column typesetting, but a heavily
skewed scan or a page where one column's text is much larger than another's
can confuse the row-grouping step). Content that visually interrupts a
column (e.g. a large inline illustration) is not specially detected; lines
above/below it are still assigned to their column band by horizontal
position alone.
"""

import logging
from bisect import insort
from dataclasses import replace
from statistics import median

logger = logging.getLogger(__name__)


def _line_bbox(line):
    """Return ``(x_min, y_min, x_max, y_max)`` for a line, or None.

    Prefers the boundary polygon (a closer fit to the actual glyphs), falls
    back to the baseline points if no boundary is present.
    """
    points = getattr(line, "boundary", None) or getattr(line, "baseline", None)
    if not points:
        return None
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    if not xs or not ys:
        return None
    return min(xs), min(ys), max(xs), max(ys)


def _x_center(bbox):
    return (bbox[0] + bbox[2]) / 2.0


def _y_center(bbox):
    return (bbox[1] + bbox[3]) / 2.0


class _Band:
    """A left-to-right horizontal zone on the page (a column, or a
    marginalia strip), accumulated from the bounding boxes of the lines
    assigned to it."""

    __slots__ = ("left", "right", "members")

    def __init__(self, left, right):
        self.left = left
        self.right = right
        self.members = []  # line indices

    def extend(self, bbox):
        self.left = min(self.left, bbox[0])
        self.right = max(self.right, bbox[2])

    @property
    def center(self):
        return (self.left + self.right) / 2.0


def _group_into_rows(bboxes_by_index, row_gap_ratio=0.55):
    """Group lines into horizontal "rows" by clustering their y-centers.

    Lines are sorted by y-center; whenever the gap to the next line's
    y-center exceeds ``row_gap_ratio`` times the page's typical single-line
    height, a new row starts. Lines from different columns typeset side by
    side land in the same row because their y-centers are nearly identical;
    consecutive rows differ by roughly a full line height, which is much
    larger than the threshold.

    Returns a list of rows (top to bottom), each row a list of line indices
    (not yet ordered left-to-right).
    """
    items = sorted(bboxes_by_index.items(), key=lambda kv: _y_center(kv[1]))
    if not items:
        return []

    heights = [bbox[3] - bbox[1] for _, bbox in items if bbox[3] > bbox[1]]
    median_height = median(heights) if heights else 1.0
    threshold = max(1.0, row_gap_ratio * median_height)

    rows = [[items[0][0]]]
    prev_y = _y_center(items[0][1])
    for idx, bbox in items[1:]:
        y = _y_center(bbox)
        if (y - prev_y) > threshold:
            rows.append([idx])
        else:
            rows[-1].append(idx)
        prev_y = y
    return rows


def _find_column_bands(multi_line_rows, bboxes, page_width, gap_ratio=0.045):
    """Discover column bands from rows where 2+ lines sit side by side.

    Pools the x-centers of every line in every multi-line row and looks for
    horizontal gaps between consecutive (sorted) x-centers. Any gap wider
    than ``gap_ratio * page_width`` starts a new band. This yields however
    many bands the page actually has - two main columns, three columns, or
    main columns plus a narrow marginalia strip - rather than assuming a
    fixed count.

    Returns a list of ``_Band`` sorted left-to-right, or ``[]`` if fewer
    than two bands are found (i.e. no confident multi-column layout).
    """
    # A baseline segmenter occasionally joins the left and right text on a
    # row into one very wide line. Such a line has its centre in the gutter,
    # so including it here invents a third, central "column". It is useful
    # later (we can split it once the real columns are known), but must not
    # participate in discovering those columns.
    max_column_width = 0.60 * page_width
    samples = []  # (index, bbox)
    for row in multi_line_rows:
        for idx in row:
            bbox = bboxes[idx]
            if (bbox[2] - bbox[0]) <= max_column_width:
                samples.append((idx, bbox))

    if len(samples) < 2:
        return []

    # Do not cluster raw x-centres. Ragged right edges make otherwise
    # identical column lines have quite different centres (particularly in
    # narrow early-print type), which used to turn one column into several
    # artificial bands. Lines belonging to a column instead form an
    # overlapping chain of horizontal intervals.
    ordered_by_left = sorted(samples, key=lambda sample: sample[1][0])
    min_gap = gap_ratio * page_width

    bands = []
    first_idx, first_bbox = ordered_by_left[0]
    current = _Band(first_bbox[0], first_bbox[2])
    current.members.append(first_idx)
    for idx, bbox in ordered_by_left[1:]:
        # An overlap joins two samples into one candidate column. Separate
        # interval groups are still subject to the slider below.
        # Touching at a single x coordinate is not an overlap. In
        # particular, halves created at the gutter share that boundary and
        # must remain separate bands on the recursive pass.
        if bbox[0] >= current.right:
            bands.append(current)
            current = _Band(bbox[0], bbox[2])
        else:
            current.extend(bbox)
        current.members.append(idx)
    bands.append(current)

    # The sensitivity slider is deliberately applied after forming stable
    # interval bands: it decides whether two nearby candidates are distinct
    # columns, without allowing uneven line lengths to fragment either one.
    merged_bands = [bands[0]]
    for band in bands[1:]:
        previous = merged_bands[-1]
        if band.center - previous.center <= min_gap:
            previous.left = min(previous.left, band.left)
            previous.right = max(previous.right, band.right)
            previous.members.extend(band.members)
        else:
            merged_bands.append(band)
    bands = merged_bands

    return bands if len(bands) >= 2 else []


def detect_column_bands(lines, page_width, row_gap_ratio=0.55,
                        column_gap_ratio=0.045):
    """Return detected horizontal bands as ``(left, right)`` pairs.

    This small public entry point lets the OCR pipeline segment each body
    column independently when post-processing line order is too late.
    """
    bboxes = {i: bbox for i, line in enumerate(lines)
              if (bbox := _line_bbox(line)) is not None}
    if len(bboxes) < 4 or not page_width or page_width <= 0:
        return []
    rows = _group_into_rows(bboxes, row_gap_ratio)
    bands = _find_column_bands(
        [row for row in rows if len(row) > 1], bboxes, page_width,
        column_gap_ratio,
    )
    return [(band.left, band.right) for band in sorted(bands, key=lambda band: band.center)]


def _split_merged_column_lines(lines, bboxes, bands, page_width):
    """Split blla lines which span the two detected main columns.

    CATMUS recognition cannot recover reading order after blla has made one
    crop containing both columns.  Crop such a baseline at the detected
    gutter before recognition, producing independent left/right lines.
    A line must reach both outer edges of the main columns; this deliberately
    leaves a centred title or a wide subtitle intact.
    """
    # Marginalia may be detected as narrow bands too. Main text columns are
    # materially wider, so use the two widest bands to establish this split.
    main_bands = sorted(bands, key=lambda band: band.right - band.left, reverse=True)[:2]
    if len(main_bands) != 2:
        return None
    left_band, right_band = sorted(main_bands, key=lambda band: band.center)
    if right_band.center <= left_band.center:
        return None

    gutter = (left_band.right + right_band.left) / 2.0
    # Use typical line edges rather than a band's extreme bounds. Marginal
    # labels and ragged line endings can otherwise make a genuine merged
    # line appear not to reach a column, or make a centred title look like
    # it does.
    left_start = median(bboxes[idx][0] for idx in left_band.members)
    right_end = median(bboxes[idx][2] for idx in right_band.members)
    edge_tolerance = 0.10 * min(
        left_band.right - left_band.left,
        right_band.right - right_band.left,
    )
    split_indices = set()
    for idx, bbox in bboxes.items():
        x0, _y0, x1, _y1 = bbox
        if (
            x0 <= left_start + edge_tolerance
            and x1 >= right_end - edge_tolerance
            and x0 < gutter < x1
        ):
            split_indices.add(idx)

    if not split_indices:
        return None

    split_lines = []
    for idx, line in enumerate(lines):
        if idx not in split_indices:
            split_lines.append(line)
            continue
        x0, y0, x1, y1 = bboxes[idx]
        # Rectangles are intentional: recognition uses the line polygon as
        # its crop, and a simple half-line crop is more robust than trying to
        # clip blla's irregular outline at the gutter.
        left_boundary = [(x0, y0), (gutter, y0), (gutter, y1), (x0, y1), (x0, y0)]
        right_boundary = [(gutter, y0), (x1, y0), (x1, y1), (gutter, y1), (gutter, y0)]
        baseline_y = _y_center(bboxes[idx])
        try:
            split_lines.extend((
                replace(line, id=f"{line.id}:left", baseline=[(x0, baseline_y), (gutter, baseline_y)], boundary=left_boundary),
                replace(line, id=f"{line.id}:right", baseline=[(gutter, baseline_y), (x1, baseline_y)], boundary=right_boundary),
            ))
        except (TypeError, AttributeError):
            # This helper is intentionally generic; if a caller supplies an
            # immutable/non-dataclass line type, leave it untouched.
            split_lines.append(line)
    return split_lines


def reorder_lines_for_multi_column(lines, page_width, page_height,
                                    row_gap_ratio=0.55,
                                    column_gap_ratio=0.045,
                                    envelope_tolerance_ratio=0.03):
    """Re-sort ``lines`` into a multi-column-aware reading order.

    Meant to run right after ``blla.segment()`` and before recognition
    (``rpred``), so that OCR text for a multi-column page comes out in a
    sensible order: any title/heading (however wide) first, then each
    column left to right, top to bottom within each column, with any
    mid-page subtitles or a trailing footer handled the same way.

    Args:
        lines: list of line objects (e.g. ``kraken.containers.BaselineLine``)
            each exposing ``.baseline`` and/or ``.boundary`` as lists of
            ``(x, y)`` tuples.
        page_width: width in px of the source image.
        page_height: height in px of the source image (kept for API
            symmetry / potential future use, currently unused).
        row_gap_ratio: fraction of the median line height used as the
            "same row" threshold when clustering lines vertically.
        column_gap_ratio: fraction of the page width a horizontal gap
            between line x-centers must exceed to be treated as a real
            column gutter.
        envelope_tolerance_ratio: fraction of the page width by which a lone
            line's center may fall outside the detected bands' combined
            envelope and still count as "inside" (i.e. a title/subtitle
            rather than an off-to-the-side marginal note).

    Returns:
        A new list with the same line objects, reordered. Never mutates the
        input list. On any unexpected error, or if fewer than two confident
        column bands are found, the original order is returned unchanged.
    """
    if not lines:
        return []
    logger.debug(
        "reorder_lines_for_multi_column: %d input lines, page=%sx%s, "
        "row_gap_ratio=%s, column_gap_ratio=%s, envelope_tolerance_ratio=%s",
        len(lines), page_width, page_height, row_gap_ratio, column_gap_ratio,
        envelope_tolerance_ratio,
    )
    try:
        return _reorder_lines_for_multi_column(
            lines, page_width, row_gap_ratio, column_gap_ratio, envelope_tolerance_ratio
        )
    except Exception:
        logger.exception(
            "Enhanced multi-column detection failed; falling back to original line order"
        )
        return list(lines)


def _reorder_lines_for_multi_column(lines, page_width, row_gap_ratio,
                                     column_gap_ratio, envelope_tolerance_ratio):
    if not lines or not page_width or page_width <= 0:
        return list(lines)

    bboxes = {}
    for i, line in enumerate(lines):
        bbox = _line_bbox(line)
        if bbox is not None:
            bboxes[i] = bbox

    # Need a reasonable number of geometrically-valid lines to even attempt
    # column detection.
    if len(bboxes) < 4:
        logger.debug(
            "Only %d/%d lines had a usable bbox (need >= 4) - skipping "
            "column detection, returning original order", len(bboxes), len(lines),
        )
        return list(lines)

    rows = _group_into_rows(bboxes, row_gap_ratio)
    multi_line_rows = [row for row in rows if len(row) > 1]
    logger.debug(
        "Grouped %d lines into %d row(s), %d of which have 2+ lines",
        len(bboxes), len(rows), len(multi_line_rows),
    )

    bands = _find_column_bands(multi_line_rows, bboxes, page_width, column_gap_ratio)
    if not bands:
        # No confident multi-column layout detected - leave order untouched.
        logger.debug(
            "No confident column bands found (fewer than 2) - returning original order"
        )
        return list(lines)

    split_lines = _split_merged_column_lines(lines, bboxes, bands, page_width)
    if split_lines is not None:
        logger.info(
            "Split %d merged line(s) at detected column gutter before reordering",
            len(split_lines) - len(lines),
        )
        # Recompute rows and bands from the individual half-lines. This also
        # prevents the newly created line halves from being split again.
        return _reorder_lines_for_multi_column(
            split_lines, page_width, row_gap_ratio, column_gap_ratio,
            envelope_tolerance_ratio,
        )
    bands.sort(key=lambda b: b.center)
    logger.debug(
        "Detected %d column band(s): %s",
        len(bands), [(round(b.left), round(b.right)) for b in bands],
    )

    band_of = {}
    for band_no, band in enumerate(bands):
        for idx in band.members:
            band_of[idx] = band_no

    tolerance = envelope_tolerance_ratio * page_width
    # The envelope should reflect the main text column(s), not marginalia
    # strips. A marginalia band (folio signature, gloss column) typically
    # has far fewer members than a real text column; if it's allowed to
    # widen the envelope, its own extremal left/right edge can push the
    # envelope out to nearly the full page width. That makes an isolated
    # marginal note anywhere on the page look "within the envelope" and
    # get misclassified as a spanning title/subtitle - which forces a
    # premature flush of whatever's queued so far, stranding later lines
    # from the same column until the next flush (or the final one),
    # displacing them after content from other bands. Bands with at least
    # half as many members as the largest band are treated as "main"
    # columns for this calculation; if that excludes everything (e.g. all
    # bands are similarly sized), fall back to all bands.
    max_members = max(len(b.members) for b in bands)
    core_bands = [b for b in bands if len(b.members) >= max_members / 2.0] or bands
    envelope_left = min(b.left for b in core_bands) - tolerance
    envelope_right = max(b.right for b in core_bands) + tolerance

    # y-centers of each band's already-paired (2+-per-row) members, used
    # below to tell a genuine page-wide break from a line that simply
    # failed to pair with a same-row sibling (columns' line pitch can drift
    # by a fraction of a line height) but still clearly sits in the middle
    # of that band's ongoing text at its normal line spacing.
    band_ys = {b: sorted(_y_center(bboxes[i]) for i in band.members) for b, band in enumerate(bands)}

    def _best_fitting_band(idx):
        """Return the band this lone line fits into at that band's own
        normal line pitch (closest such band by x-distance if more than
        one qualifies), or None if it doesn't fit any band's flow.

        Checked across *all* bands, not just the x-nearest one: the
        x-nearest band can be a spurious single-member band (e.g. a stray
        fragment) with no pitch of its own to judge by, while the line
        actually continues a real column's text at that column's normal
        spacing - just a bit further from that column's typical x-center
        than most of its lines (a row-pairing miss, not a section break,
        which would instead show as an abnormally large gap relative to
        the column's typical line spacing)."""
        y = _y_center(bboxes[idx])
        fitting = []
        for b, ys in band_ys.items():
            if len(ys) < 2:
                continue
            before = [o for o in ys if o < y]
            after = [o for o in ys if o > y]
            if not before or not after:
                continue
            gap = min(after) - max(before)
            diffs = [y2 - y1 for y1, y2 in zip(ys, ys[1:]) if y2 > y1]
            pitch = median(diffs) if diffs else None
            if pitch and pitch > 0 and gap <= 2.0 * pitch:
                fitting.append(b)
        if not fitting:
            return None
        center = _x_center(bboxes[idx])
        return min(fitting, key=lambda b: abs(center - bands[b].center))

    # rows is already in top-to-bottom (y) order, so lone rows are visited
    # in that order below. Each lone line resolved into a band is folded
    # into band_ys immediately (not just at the end), so a short run of
    # several consecutive lone lines in the same column (e.g. a stretch
    # where the columns' line pitch drifts apart for a few lines) can still
    # confirm continuity against each other, not only against the
    # originally row-paired members.
    spanning = set()
    for row in rows:
        if len(row) != 1:
            continue
        idx = row[0]
        if idx in band_of:
            continue
        # A column can legitimately have a line without a same-height peer
        # when the other column contains an illustration, initial, or blank
        # space. If this line is materially contained by one band, it is
        # column text rather than a section break. This is especially common
        # in early-print pages with decorated initials.
        x0, _y0, x1, _y1 = bboxes[idx]
        line_width = x1 - x0
        containing = []
        if line_width > 0:
            for b, band in enumerate(bands):
                overlap = max(0.0, min(x1, band.right) - max(x0, band.left))
                if overlap >= 0.65 * line_width:
                    containing.append(b)
        if containing:
            center = _x_center(bboxes[idx])
            fitted = min(containing, key=lambda b: abs(center - bands[b].center))
            band_of[idx] = fitted
            insort(band_ys[fitted], _y_center(bboxes[idx]))
            continue
        fitting = _best_fitting_band(idx)
        if fitting is not None:
            # Continues some band's text at that band's normal line
            # spacing - a row-pairing miss, not a real break.
            band_of[idx] = fitting
            insort(band_ys[fitting], _y_center(bboxes[idx]))
            continue
        center = _x_center(bboxes[idx])
        if envelope_left <= center <= envelope_right:
            # Sits over/between the columns with nothing beside it, and
            # doesn't fit any band's normal flow -> a title/heading/
            # subtitle, regardless of how narrow it is.
            spanning.add(idx)
        else:
            # Off to the side (e.g. an isolated marginal note not lined up
            # with a body line this time) -> nearest band.
            nearest = min(range(len(bands)), key=lambda b: abs(center - bands[b].center))
            band_of[idx] = nearest
            insort(band_ys[nearest], _y_center(bboxes[idx]))

    # Defensive: any bbox-having line still unclassified gets the nearest band.
    for idx, bbox in bboxes.items():
        if idx in spanning or idx in band_of:
            continue
        center = _x_center(bbox)
        nearest = min(range(len(bands)), key=lambda b: abs(center - bands[b].center))
        band_of[idx] = nearest

    # Walk the page top-to-bottom, queueing lines per band and flushing all
    # bands (left to right) whenever a spanning line is reached.
    y_ordered = sorted(bboxes.keys(), key=lambda i: _y_center(bboxes[i]))
    pending = {b: [] for b in range(len(bands))}
    new_order = []

    def flush():
        for b in range(len(bands)):
            if pending[b]:
                new_order.extend(pending[b])
                pending[b] = []

    spanning_count = 0
    for idx in y_ordered:
        if idx in spanning:
            flush()
            new_order.append(idx)
            spanning_count += 1
        else:
            pending[band_of[idx]].append(idx)
    flush()

    # Lines without a usable bbox (shouldn't normally happen) are appended at
    # the end in their original relative order, so we never silently drop a
    # line.
    missing = [i for i in range(len(lines)) if i not in bboxes]
    new_order += missing

    logger.info(
        "Enhanced multi-column detection: %d band(s), %d spanning line(s) (of %d total)",
        len(bands), spanning_count, len(lines),
    )

    return [lines[i] for i in new_order]
