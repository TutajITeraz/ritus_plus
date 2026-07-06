"""
Dependency-free tests for the model-independent parts of
layout_parser_preprocessing.py: the recursive XY-cut region-ordering
(`_xy_cut_order`) and the line-to-region assignment/ordering
(`order_lines_by_regions`, `_assign_line_to_region`).

These do NOT need layoutparser, detectron2, effdet, or any model weights
installed - they operate purely on plain `Region` objects and fake line
objects, so they exercise exactly the logic this module adds on top of
whatever `layoutparser` model.detect() returns. Run with:

    python3 test_layout_parser_preprocessing.py
"""

from dataclasses import dataclass, field
from typing import List, Tuple

from layout_parser_preprocessing import (
    Region,
    _xy_cut_order,
    _assign_line_to_region,
    order_lines_by_regions,
)


@dataclass
class FakeLine:
    """Minimal stand-in for kraken.containers.BaselineLine."""
    id: str
    baseline: List[Tuple[int, int]]
    boundary: List[Tuple[int, int]] = field(default_factory=list)


def make_line(id_, x0, y0, x1, y1):
    baseline = [(x0, y1), (x1, y1)]
    boundary = [(x0, y0), (x1, y0), (x1, y1), (x0, y1), (x0, y0)]
    return FakeLine(id=id_, baseline=baseline, boundary=boundary)


def test_xy_cut_title_above_two_columns():
    title = Region(200, 20, 800, 60, label="Title")
    col_l = Region(100, 100, 450, 400, label="Text")
    col_r = Region(550, 100, 900, 400, label="Text")
    order = _xy_cut_order([col_r, title, col_l])  # deliberately shuffled input
    assert order == [title, col_l, col_r], order
    print("PASS: test_xy_cut_title_above_two_columns")


def test_xy_cut_three_columns_side_by_side():
    c1 = Region(100, 50, 350, 400, label="Text")
    c2 = Region(450, 50, 700, 400, label="Text")
    c3 = Region(800, 50, 1050, 400, label="Text")
    order = _xy_cut_order([c3, c1, c2])
    assert order == [c1, c2, c3], order
    print("PASS: test_xy_cut_three_columns_side_by_side")


def test_xy_cut_no_clean_cut_falls_back_to_stable_sort():
    """Two overlapping regions (no full horizontal or vertical gap between
    them) should fall back to a deterministic (top, left) sort rather than
    erroring or producing an arbitrary order."""
    a = Region(100, 100, 500, 300, label="Text")
    b = Region(400, 150, 900, 350, label="Text")  # overlaps both axes with a
    order = _xy_cut_order([b, a])
    expected = sorted([b, a], key=lambda r: (r.top, r.left))
    assert order == expected, order
    print("PASS: test_xy_cut_no_clean_cut_falls_back_to_stable_sort")


def test_order_lines_by_regions_title_and_two_columns():
    title = Region(200, 20, 800, 60, label="Title")
    col_l = Region(100, 100, 450, 400, label="Text")
    col_r = Region(550, 100, 900, 400, label="Text")

    lines = [
        make_line("R1", 560, 110, 890, 150),
        make_line("title", 250, 30, 750, 55),
        make_line("L1", 110, 110, 440, 150),
        make_line("L2", 110, 200, 440, 240),
        make_line("R2", 560, 200, 890, 240),
    ]
    result = order_lines_by_regions(lines, [col_r, title, col_l])
    order = [l.id for l in result]
    assert order == ["title", "L1", "L2", "R1", "R2"], order
    print("PASS: test_order_lines_by_regions_title_and_two_columns ->", order)


def test_order_lines_by_regions_figure_splits_column():
    """
    The scenario the geometric heuristic in multi_column_layout.py cannot
    handle: an inline illustration splits the right column into a "top"
    and "bottom" piece. LayoutParser detects three separate regions for the
    right side (text-above-figure, the figure itself, text-below-figure);
    kraken never produces OCR lines over the figure region itself. The
    output must still read: title, left column straight through, then the
    right column's text above the figure followed by the right column's
    text below the figure.
    """
    title = Region(200, 20, 800, 60, label="Title")
    col_l = Region(100, 100, 450, 400, label="Text")
    col_r_top = Region(550, 100, 900, 190, label="Text")
    figure = Region(550, 200, 900, 300, label="Figure")
    col_r_bottom = Region(550, 310, 900, 400, label="Text")

    lines = [
        make_line("title", 250, 30, 750, 55),
        make_line("L1", 110, 110, 440, 150),
        make_line("L2", 110, 180, 440, 220),
        make_line("L3", 110, 250, 440, 290),
        make_line("L4", 110, 320, 440, 360),
        make_line("R1", 560, 110, 890, 150),
        make_line("R2", 560, 150, 890, 185),
        make_line("R3", 560, 320, 890, 355),
        make_line("R4", 560, 360, 890, 395),
    ]
    regions = [title, col_l, col_r_top, figure, col_r_bottom]
    result = order_lines_by_regions(lines, regions)
    order = [l.id for l in result]
    assert order == [
        "title", "L1", "L2", "L3", "L4", "R1", "R2", "R3", "R4"
    ], order
    print("PASS: test_order_lines_by_regions_figure_splits_column ->", order)


def test_order_lines_by_regions_fewer_than_two_regions_unchanged():
    lines = [make_line("1", 100, 50, 900, 90), make_line("2", 100, 100, 900, 140)]
    result = order_lines_by_regions(lines, [Region(0, 0, 1000, 1000)])
    assert [l.id for l in result] == ["1", "2"]
    result = order_lines_by_regions(lines, [])
    assert [l.id for l in result] == ["1", "2"]
    print("PASS: test_order_lines_by_regions_fewer_than_two_regions_unchanged")


def test_order_lines_by_regions_empty_lines():
    assert order_lines_by_regions([], [Region(0, 0, 10, 10), Region(20, 0, 30, 10)]) == []
    print("PASS: test_order_lines_by_regions_empty_lines")


def test_line_outside_all_regions_assigned_to_nearest_region():
    col_l = Region(100, 100, 450, 400, label="Text")
    col_r_top = Region(550, 100, 900, 190, label="Text")
    figure = Region(550, 200, 900, 300, label="Figure")
    col_r_bottom = Region(550, 310, 900, 400, label="Text")
    regions = [col_l, col_r_top, figure, col_r_bottom]

    # Sits below every region (imprecise detection at the bottom of the
    # page) but horizontally aligned with the right column -> should land
    # on col_r_bottom, not col_l or the figure.
    stray_bbox = (600, 410, 850, 440)
    idx = _assign_line_to_region(stray_bbox, regions)
    assert regions[idx] is col_r_bottom, regions[idx]
    print("PASS: test_line_outside_all_regions_assigned_to_nearest_region")


if __name__ == "__main__":
    test_xy_cut_title_above_two_columns()
    test_xy_cut_three_columns_side_by_side()
    test_xy_cut_no_clean_cut_falls_back_to_stable_sort()
    test_order_lines_by_regions_title_and_two_columns()
    test_order_lines_by_regions_figure_splits_column()
    test_order_lines_by_regions_fewer_than_two_regions_unchanged()
    test_order_lines_by_regions_empty_lines()
    test_line_outside_all_regions_assigned_to_nearest_region()
    print("\nAll tests passed.")
