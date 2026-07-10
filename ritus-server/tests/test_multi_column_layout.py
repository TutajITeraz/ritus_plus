"""
Lightweight, dependency-free tests for multi_column_layout.py.

These do NOT require kraken/torch/the venv - they only need the standard
library, so they can be run directly with plain python3:

    python3 test_multi_column_layout.py

(If you want to run it inside the project's venv instead:
    cd ritus-server && source .venv/bin/activate && python3 test_multi_column_layout.py
)
"""

import os
import sys
from dataclasses import dataclass, field
from typing import List, Tuple

# This file lives in tests/, but multi_column_layout.py lives one directory
# up (ritus-server/). Make sure that directory is on sys.path so the import
# below works no matter what the current working directory is when this is
# run (plain `python3 tests/test_multi_column_layout.py`, `pytest` from
# ritus-server/, or `pytest` from inside tests/ all work).
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from multi_column_layout import reorder_lines_for_multi_column


@dataclass
class FakeLine:
    """Minimal stand-in for kraken.containers.BaselineLine."""
    id: str
    baseline: List[Tuple[int, int]]
    boundary: List[Tuple[int, int]] = field(default_factory=list)


def make_line(id_, x0, y0, x1, y1):
    """Build a FakeLine with a simple rectangular boundary/baseline."""
    baseline = [(x0, y1), (x1, y1)]
    boundary = [(x0, y0), (x1, y0), (x1, y1), (x0, y1), (x0, y0)]
    return FakeLine(id=id_, baseline=baseline, boundary=boundary)


PAGE_W, PAGE_H = 1000, 1500


def test_title_then_two_columns_scrambled_order():
    """
    The realistic bug scenario: blla emits a centered title, then a body
    that's actually two columns, but interleaves left/right lines because
    the title threw its heuristics off.
    """
    lines = [
        make_line("title", 150, 50, 850, 100),      # wide, centered -> title
        make_line("L1", 100, 150, 450, 190),
        make_line("R1", 550, 155, 900, 195),
        make_line("L2", 100, 200, 450, 240),
        make_line("R2", 550, 205, 900, 245),
        make_line("R3", 550, 255, 900, 295),          # right col out of order vs L3
        make_line("L3", 100, 250, 450, 290),
        make_line("L4", 100, 300, 450, 340),
        make_line("R4", 550, 305, 900, 345),
    ]

    result = reorder_lines_for_multi_column(lines, PAGE_W, PAGE_H)
    order = [l.id for l in result]

    assert order == ["title", "L1", "L2", "L3", "L4", "R1", "R2", "R3", "R4"], order
    print("PASS: test_title_then_two_columns_scrambled_order ->", order)


def test_single_column_untouched():
    """A normal single-column page should be returned completely unchanged."""
    lines = [
        make_line("1", 100, 50, 900, 90),
        make_line("2", 100, 100, 900, 140),
        make_line("3", 100, 150, 900, 190),
        make_line("4", 100, 200, 900, 240),
    ]
    result = reorder_lines_for_multi_column(lines, PAGE_W, PAGE_H)
    order = [l.id for l in result]
    assert order == ["1", "2", "3", "4"], order
    print("PASS: test_single_column_untouched ->", order)


def test_two_columns_no_title():
    """Two columns with no title line at all should still get grouped."""
    lines = [
        make_line("R1", 550, 60, 900, 100),
        make_line("L1", 100, 55, 450, 95),
        make_line("R2", 550, 110, 900, 150),
        make_line("L2", 100, 105, 450, 145),
        make_line("L3", 100, 155, 450, 195),
        make_line("R3", 550, 160, 900, 200),
    ]
    result = reorder_lines_for_multi_column(lines, PAGE_W, PAGE_H)
    order = [l.id for l in result]
    assert order == ["L1", "L2", "L3", "R1", "R2", "R3"], order
    print("PASS: test_two_columns_no_title ->", order)


def test_title_with_footer():
    """Header title above the columns, footer/colophon-style title below."""
    lines = [
        make_line("title", 150, 20, 850, 60),
        make_line("L1", 100, 100, 450, 140),
        make_line("R1", 550, 105, 900, 145),
        make_line("R2", 550, 155, 900, 195),
        make_line("L2", 100, 150, 450, 190),
        make_line("footer", 150, 250, 850, 290),
    ]
    result = reorder_lines_for_multi_column(lines, PAGE_W, PAGE_H)
    order = [l.id for l in result]
    assert order == ["title", "L1", "L2", "R1", "R2", "footer"], order
    print("PASS: test_title_with_footer ->", order)


def test_short_subtitle_between_columns():
    """
    The case a pure width-ratio heuristic misses: a short, narrow subtitle
    (e.g. a single word like "SHORT") sitting centered in the gutter between
    two columns, splitting the body into two vertical sections. It must be
    treated as a spanning/title-like line - and placed between the two
    sections - purely because nothing else is typeset at its height and it
    sits inside the columns' combined envelope, NOT because it's wide.
    """
    lines = [
        make_line("title", 200, 20, 800, 60),      # a real wide title
        make_line("L1a", 100, 100, 450, 140),
        make_line("R1a", 550, 105, 900, 145),
        make_line("L2a", 100, 150, 450, 190),
        make_line("R2a", 550, 155, 900, 195),
        make_line("SHORT", 460, 250, 540, 290),     # narrow! only 80px wide
        make_line("L1b", 100, 340, 450, 380),
        make_line("R1b", 550, 345, 900, 385),
        make_line("L2b", 100, 390, 450, 430),
        make_line("R2b", 550, 395, 900, 435),
    ]
    result = reorder_lines_for_multi_column(lines, PAGE_W, PAGE_H)
    order = [l.id for l in result]
    assert order == [
        "title", "L1a", "L2a", "R1a", "R2a", "SHORT", "L1b", "L2b", "R1b", "R2b"
    ], order
    print("PASS: test_short_subtitle_between_columns ->", order)


def test_three_columns():
    """A three-column layout (no title) should produce three groups."""
    lines = [
        make_line("C1_1", 100, 50, 350, 90),
        make_line("C2_1", 450, 55, 700, 95),
        make_line("C3_1", 800, 60, 1050, 100),
        make_line("C1_2", 100, 100, 350, 140),
        make_line("C2_2", 450, 105, 700, 145),
        make_line("C3_2", 800, 110, 1050, 150),
    ]
    result = reorder_lines_for_multi_column(lines, 1200, PAGE_H)
    order = [l.id for l in result]
    assert order == ["C1_1", "C1_2", "C2_1", "C2_2", "C3_1", "C3_2"], order
    print("PASS: test_three_columns ->", order)


def test_marginalia_band_kept_separate():
    """
    Narrow marginalia strips (e.g. folio/quire signatures) on the far left
    and far right, each paired with the first row of body text, must form
    their own bands instead of corrupting the two main columns' order.
    """
    lines = [
        make_line("margL1", 20, 50, 90, 90),
        make_line("L1", 200, 55, 600, 95),
        make_line("R1", 700, 60, 1100, 100),
        make_line("margR1", 1200, 65, 1280, 105),
        make_line("L2", 200, 100, 600, 140),
        make_line("R2", 700, 105, 1100, 145),
        make_line("L3", 200, 150, 600, 190),
        make_line("R3", 700, 155, 1100, 195),
    ]
    result = reorder_lines_for_multi_column(lines, 1300, PAGE_H)
    order = [l.id for l in result]
    assert order == ["margL1", "L1", "L2", "L3", "R1", "R2", "R3", "margR1"], order
    print("PASS: test_marginalia_band_kept_separate ->", order)


def test_isolated_marginal_note_not_treated_as_title():
    """
    A marginal note that is alone in its row (no body line at that height)
    but sits off to the side (outside the columns' envelope) must NOT be
    mistaken for a spanning title - it should fold into the nearest column
    instead.
    """
    lines = [
        make_line("L1", 200, 100, 600, 140),
        make_line("R1", 700, 105, 1100, 145),
        make_line("L2", 200, 150, 600, 190),
        make_line("R2", 700, 155, 1100, 195),
        make_line("marg_alone", 20, 300, 90, 340),  # alone in its row, far left
    ]
    result = reorder_lines_for_multi_column(lines, PAGE_W, PAGE_H)
    order = [l.id for l in result]
    assert order == ["L1", "L2", "marg_alone", "R1", "R2"], order
    print("PASS: test_isolated_marginal_note_not_treated_as_title ->", order)


def test_narrow_gap_between_two_paragraphs_not_treated_as_columns():
    """
    A couple of short lines that don't form a real recurring multi-line row
    pattern (a single-column page with a couple of shorter lines) should not
    be mis-split into columns.
    """
    lines = [
        make_line("1", 100, 50, 900, 90),
        make_line("2", 100, 100, 900, 140),
        make_line("3", 100, 150, 300, 190),   # short line, left side
        make_line("4", 700, 200, 900, 240),   # short line, right side
    ]
    result = reorder_lines_for_multi_column(lines, PAGE_W, PAGE_H)
    order = [l.id for l in result]
    assert order == ["1", "2", "3", "4"], order
    print("PASS: test_narrow_gap_between_two_paragraphs_not_treated_as_columns ->", order)


def test_empty_and_degenerate_input():
    assert reorder_lines_for_multi_column([], PAGE_W, PAGE_H) == []
    assert reorder_lines_for_multi_column(None, PAGE_W, PAGE_H) == []
    one = [make_line("1", 100, 50, 900, 90)]
    assert [l.id for l in reorder_lines_for_multi_column(one, PAGE_W, PAGE_H)] == ["1"]
    print("PASS: test_empty_and_degenerate_input")


if __name__ == "__main__":
    test_title_then_two_columns_scrambled_order()
    test_single_column_untouched()
    test_two_columns_no_title()
    test_title_with_footer()
    test_short_subtitle_between_columns()
    test_three_columns()
    test_marginalia_band_kept_separate()
    test_isolated_marginal_note_not_treated_as_title()
    test_narrow_gap_between_two_paragraphs_not_treated_as_columns()
    test_empty_and_degenerate_input()
    print("\nAll tests passed.")
