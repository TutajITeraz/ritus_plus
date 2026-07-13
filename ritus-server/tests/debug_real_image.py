"""
debug_real_image.py

Manual diagnostic script (NOT a pytest test - it's not deterministic and
depends on optional heavy dependencies / a real image, so it isn't run as
part of the automated test suite). Use this to compare local vs production
behavior of the "enhanced multi column detection" feature on one real page.

Why this exists
----------------
test_multi_column_layout.py and test_layout_parser_preprocessing.py are
deliberately dependency-free: they build synthetic FakeLine/Region objects
by hand so they can run without kraken/torch/layoutparser installed. That's
great for testing the *ordering logic*, but it never exercises the one path
that actually depends on the environment: layout_parser_preprocessing.py's
`detect_layout_regions()`, which loads a real LayoutParser model and runs it
on a real image. If local and production disagree, this is almost always
where the difference comes from (see the diagnostic report this script
prints - most likely LAYOUTPARSER_AVAILABLE differs between the two
machines, or the loaded model differs).

Usage
-----
1. Drop a real page image into this tests/ directory, named `rest_real.png`
   (or pass a path as the first argument).
2. Activate the server venv and run this from anywhere:

     cd ritus-server
     source .venv/bin/activate
     python3 tests/debug_real_image.py
     # or: python3 tests/debug_real_image.py /path/to/some_other_page.png

3. Run the exact same command on the production machine (same venv
   activation, same image file - copy it over) and compare the two reports.
   Whatever differs between the two outputs (layoutparser availability,
   model config, detected region count/labels, resulting line order) is your
   root cause.

This script never asserts anything and never raises on missing optional
dependencies - it degrades gracefully and just reports what it found, so it
is safe to run in either environment.
"""
import hashlib
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import logging

logging.basicConfig(level=logging.DEBUG, format="%(asctime)s %(levelname)s [%(name)s] %(message)s")

import layout_parser_preprocessing as lpp
from multi_column_layout import reorder_lines_for_multi_column


def _section(title):
    print("\n" + "=" * 70)
    print(title)
    print("=" * 70)


def main():
    image_path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "rest_real.png"
    )

    _section("1. Environment diagnostics")
    print(f"Python: {sys.version}")
    print(f"Running from: {os.path.abspath(__file__)}")
    print(f"LAYOUTPARSER_AVAILABLE: {lpp.LAYOUTPARSER_AVAILABLE}")
    print(f"layoutparser import error (if any): {lpp._import_error!r}")
    print(f"LAYOUT_MODEL_CONFIG: {lpp.LAYOUT_MODEL_CONFIG}")
    print(f"ENABLE_LAYOUTPARSER (opt-in, defaults to off): {lpp.ENABLE_LAYOUTPARSER}")

    try:
        import kraken  # noqa: F401
        kraken_available = True
        kraken_error = None
    except Exception as exc:  # pragma: no cover
        kraken_available = False
        kraken_error = exc
    print(f"kraken importable: {kraken_available} (error={kraken_error!r})")
    if kraken_available:
        try:
            from importlib.metadata import version as _pkg_version
            _kraken_version = _pkg_version("kraken")
        except Exception:
            _kraken_version = getattr(kraken, "__version__", "unknown")
        print(f"kraken version: {_kraken_version}")

    try:
        import torch
        print(f"torch.__version__: {torch.__version__}")
    except Exception as exc:
        print(f"torch not importable: {exc!r}")
    try:
        import numpy
        print(f"numpy.__version__: {numpy.__version__}")
    except Exception as exc:
        print(f"numpy not importable: {exc!r}")

    # models/ is gitignored (see .gitignore) - the blla.mlmodel file is not
    # version-controlled, so nothing guarantees local and production have
    # byte-identical weights even when the code is identical. Fingerprint it
    # here so the two environments' reports can be diffed directly.
    _model_path_for_hash = os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "..", "models", "blla.mlmodel"
    )
    if os.path.exists(_model_path_for_hash):
        _stat = os.stat(_model_path_for_hash)
        with open(_model_path_for_hash, "rb") as _f:
            _sha256 = hashlib.sha256(_f.read()).hexdigest()
        print(
            f"models/blla.mlmodel fingerprint: size={_stat.st_size} "
            f"sha256={_sha256} mtime={_stat.st_mtime}"
        )
    else:
        print(f"models/blla.mlmodel not found at {_model_path_for_hash}")

    _section("2. Image")
    if not os.path.exists(image_path):
        print(f"No image found at {image_path}.")
        print(
            "Drop a real page image at tests/rest_real.png (or pass a path as "
            "argv[1]) to exercise detect_layout_regions() against a real "
            "model on a real page - that's the one code path the synthetic "
            "unit tests can't cover."
        )
        return
    print(f"Using image: {image_path}")

    try:
        from PIL import Image as PILImage
        image = PILImage.open(image_path)
        print(f"Image size: {image.size}, mode: {image.mode}")
    except Exception as exc:
        print(f"Failed to open image: {exc!r}")
        return

    _section("3. LayoutParser region detection (the environment-dependent path)")
    if not lpp.ENABLE_LAYOUTPARSER:
        print(
            "RITUS_ENABLE_LAYOUTPARSER is not set (defaults to off) - this "
            "matches the live server, which never loads the LayoutParser "
            "model in this configuration. Skipping the model-loading probe "
            "below by default, since loading it has been observed to "
            "segfault the whole process on at least one machine (likely a "
            "torch/effdet native-extension ABI mismatch) - that crash would "
            "kill this script before it reaches section 4, which is usually "
            "the part you actually want. Set RITUS_ENABLE_LAYOUTPARSER=1 "
            "before running this script if you specifically want to probe "
            "the LayoutParser model-loading path."
        )
    elif not lpp.LAYOUTPARSER_AVAILABLE:
        print(
            "layoutparser is not importable in this environment - "
            "'enhanced multi column detection' will use ONLY the geometric "
            "fallback (multi_column_layout.py) here. If the other "
            "environment DOES have layoutparser installed and working, that "
            "fully explains a difference in results between the two."
        )
    else:
        regions = lpp.detect_layout_regions(image)
        if regions is None:
            print(
                "detect_layout_regions() returned None - the layoutparser "
                "package imports fine, but the model itself failed to load "
                "or run (check the DEBUG/ERROR log lines above for the "
                "actual exception - e.g. missing backend package, or no "
                "network access to download model weights on first use)."
            )
        else:
            print(f"Detected {len(regions)} region(s):")
            for r in regions:
                print(f"  {r}")
            if len(regions) >= 2:
                ordered = lpp._xy_cut_order(regions)
                print("Reading order (XY-cut) of regions:")
                for r in ordered:
                    print(f"  {r}")
            else:
                print(
                    "Fewer than 2 regions detected - reordering by region is "
                    "a no-op here; the geometric fallback would be used "
                    "instead in the real pipeline."
                )

    _section("4. End-to-end (only if kraken + a baseline model are available)")
    if not kraken_available:
        print("Skipping - kraken is not importable in this environment.")
        return

    try:
        from kraken.lib import vgsl
        from kraken import blla
    except Exception as exc:
        print(f"Skipping - failed to import kraken.blla/vgsl: {exc!r}")
        return

    model_path = os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "..", "models", "blla.mlmodel"
    )
    if not os.path.exists(model_path):
        print(f"Skipping - baseline model not found at {model_path}")
        return

    try:
        baseline_model = vgsl.TorchVGSLModel.load_model(model_path)
        ocr_image = image.convert("L") if image.mode != "L" else image
        seg = blla.segment(ocr_image, model=baseline_model, device="cpu", text_direction="horizontal-tb")
        print(f"Kraken segmented {len(seg.lines)} line(s).")

        page_width, page_height = ocr_image.size
        geometric_order = reorder_lines_for_multi_column(seg.lines, page_width, page_height)
        print(f"Geometric heuristic order (first 10 of {len(geometric_order)}):")
        for line in geometric_order[:10]:
            print(f"  id={getattr(line, 'id', '?')}")

        if not lpp.ENABLE_LAYOUTPARSER:
            print(
                "Skipping LayoutParser-based order: RITUS_ENABLE_LAYOUTPARSER "
                "is off (see section 3) - the live server only ever uses the "
                "geometric heuristic order above in this configuration."
            )
        elif lpp.LAYOUTPARSER_AVAILABLE:
            # Note: this calls detect_layout_regions()/order_lines_by_regions()
            # directly, bypassing the RITUS_ENABLE_LAYOUTPARSER opt-in gate in
            # reorder_lines_using_layout_parser(), so this diagnostic always
            # shows you what LayoutParser *would* produce on this page,
            # regardless of whether it's actually enabled in the running
            # server.
            regions = lpp.detect_layout_regions(image)
            if regions:
                lp_order = lpp.order_lines_by_regions(seg.lines, regions)
                print(f"LayoutParser-based order (first 10 of {len(lp_order)}):")
                for line in lp_order[:10]:
                    print(f"  id={getattr(line, 'id', '?')}")
            else:
                print("LayoutParser detected no usable regions on this page (see section 3 above for why).")
    except Exception as exc:
        print(f"End-to-end run failed: {exc!r}")


if __name__ == "__main__":
    main()
