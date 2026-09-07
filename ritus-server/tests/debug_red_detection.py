#!/usr/bin/env python3
"""
Instrumented walk-through of the rubric (red ink) detection pipeline.

Re-implements, step by step, exactly what
``image_processing.split_line_boundary_by_color`` does to a single text line,
dumping every intermediate stage to ``dbg_imgs/`` as PNG figures: crops, the
polygon mask, H/S/L channels, the CLAHE-enhanced lightness, the three Gaussian
weight maps, the per-pixel redness map, the per-column redness trace with its
moving-average denoising and threshold, channel histograms, the resulting
red/black bands and the final tagged sub-polygons.

The instrumented result is cross-checked against the real production function so
the pictures cannot silently drift away from the shipping code.

Usage:
    python3 tests/debug_red_detection.py                       # auto-pick lines
    python3 tests/debug_red_detection.py --line 5              # a specific line
    python3 tests/debug_red_detection.py --threshold 5 --window 80
"""

import argparse
import json
import os
import sys

import matplotlib
matplotlib.use("Agg")

import cv2
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.patches import Rectangle
from PIL import Image as PILImage
from shapely.geometry import Polygon, box

FS_H1, FS_SUB = 31, 15.5
FS_TITLE, FS_LABEL, FS_CAP, FS_TICK = 21, 17, 15, 14

SERVER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, SERVER_DIR)

from image_processing import rgb_to_hsl, split_line_boundary_by_color  # noqa: E402

# ---------------------------------------------------------------------------
# Constants mirrored from image_processing.split_line_boundary_by_color
# ---------------------------------------------------------------------------
PADDING = 10                     # bbox padding around the line polygon, px
BG_GRAY = (128, 128, 128)        # colour painted outside the polygon
CLAHE_CLIP = 2.0
CLAHE_TILE = (8, 8)
SIGMA_H, SIGMA_L, SIGMA_S = 0.05, 0.15, 0.2
HUE_LO, HUE_HI = 0.1, 0.91       # hue gate: h <= 0.1 or h >= 0.91
L_LO, L_HI = 0.25, 0.8           # lightness gate
S_LO, S_HI = 0.3, 1.0            # saturation gate
MIN_REGION_PX = 5                # narrower runs are dropped (Kraken safeguard)

# UI sensitivity <-> threshold curve (ritus-client/src/utils/redSensitivity.js)
ANCHOR_SENSITIVITY, ANCHOR_THRESHOLD, GAMMA = 80.0, 5.0, 3.0


def sensitivity_to_threshold(sensitivity):
    if sensitivity <= 0:
        return 1_000_000.0
    return ANCHOR_THRESHOLD * ((100.0 - sensitivity) / (100.0 - ANCHOR_SENSITIVITY)) ** GAMMA


def threshold_to_sensitivity(threshold):
    return 100.0 - (threshold / ANCHOR_THRESHOLD) ** (1.0 / GAMMA) * (100.0 - ANCHOR_SENSITIVITY)


# ---------------------------------------------------------------------------
# Segmentation (cached, so repeated runs are instant)
# ---------------------------------------------------------------------------
def segment_lines(image_path, out_dir, device="cpu"):
    key = os.path.splitext(os.path.basename(image_path))[0]
    cache_path = os.path.join(out_dir, f"_segmentation_{key}.json")
    stamp = f"{os.path.abspath(image_path)}:{os.path.getmtime(image_path)}"
    if os.path.exists(cache_path):
        with open(cache_path) as fh:
            cached = json.load(fh)
        if cached.get("stamp") == stamp:
            print(f"[seg] reusing cached segmentation ({len(cached['lines'])} lines)")
            return cached["lines"]

    print("[seg] running kraken blla segmentation (first run only, slow)...")
    from kraken import blla
    from kraken.lib import vgsl

    model_path = os.path.join(SERVER_DIR, "models", "blla.mlmodel")
    model = vgsl.TorchVGSLModel.load_model(model_path)
    if hasattr(model, "to"):
        model = model.to(device=device) or model

    gray = PILImage.open(image_path).convert("L")
    seg = blla.segment(gray, model=model, device=device)
    lines = [
        {"baseline": [list(map(float, p)) for p in ln.baseline],
         "boundary": [list(map(float, p)) for p in ln.boundary]}
        for ln in seg.lines
    ]
    with open(cache_path, "w") as fh:
        json.dump({"stamp": stamp, "lines": lines}, fh)
    print(f"[seg] {len(lines)} lines segmented and cached")
    return lines


def text_block_left(line_dicts, page_width):
    """Left margin of the text block: where the long lines actually start."""
    xs = [min(x for x, _ in ld["boundary"]) for ld in line_dicts
          if len(ld["boundary"]) >= 3
          and (max(x for x, _ in ld["boundary"])
               - min(x for x, _ in ld["boundary"])) > 0.5 * page_width]
    return min(xs) if xs else 0.0


def extend_line_left(line_dict, x_target):
    """Grow a line polygon leftwards to the text-block margin.

    Kraken sometimes leaves a decorated initial out of the line polygon and
    sometimes swallows it. This makes the second case reproducible: it is the
    polygon the segmenter draws for every other line on the page.
    """
    b = np.array(line_dict["boundary"], dtype=float)
    y0, y1, x0 = b[:, 1].min(), b[:, 1].max(), b[:, 0].min()
    grown = Polygon([tuple(pt) for pt in b]).buffer(0).union(
        box(x_target, y0, x0 + 2, y1)).convex_hull
    bl = [tuple(pt) for pt in line_dict["baseline"]]
    return {"boundary": [list(pt) for pt in grown.exterior.coords[:-1]],
            "baseline": [[x_target + 4, bl[0][1]]] + [list(pt) for pt in bl]}


def edge_rows(line_dicts):
    """The leftmost line of the topmost row, and of the bottom-most row."""
    rows = []
    for i, ld in enumerate(line_dicts):
        if len(ld["baseline"]) < 2:
            continue
        ys = [pt[1] for pt in ld["baseline"]]
        rows.append((i, sum(ys) / len(ys), min(pt[0] for pt in ld["baseline"])))
    rows.sort(key=lambda r: r[1])
    top_y, bot_y = rows[0][1], rows[-1][1]
    top = min((r for r in rows if abs(r[1] - top_y) < 60), key=lambda r: r[2])
    bot = min((r for r in rows if abs(r[1] - bot_y) < 60), key=lambda r: r[2])
    return top[0], bot[0]


def ink_stats(color_image, line_dict):
    """Colour make-up of the ink inside a polygon - a stand-in ground truth."""
    b = np.array(line_dict["boundary"], dtype=float)
    l_, t_, r_, bo = b[:, 0].min(), b[:, 1].min(), b[:, 0].max(), b[:, 1].max()
    crop = np.array(color_image.crop((l_, t_, r_, bo)))
    mask = np.zeros(crop.shape[:2], np.uint8)
    cv2.fillPoly(mask, [np.array([(x - l_, y - t_) for x, y in b], np.int32)], 255)
    hsl = rgb_to_hsl(crop)
    h, s, lg = hsl[..., 0], hsl[..., 1], hsl[..., 2]
    ink = (mask > 0) & (lg < 0.55)
    if ink.sum() < 50:
        return 0.0, 0.0, int(ink.sum())
    red = ink & (((h <= 0.08) | (h >= 0.92)) & (s >= 0.3))
    black = ink & (s < 0.25)
    return red.sum() / ink.sum(), black.sum() / ink.sum(), int(ink.sum())


def pick_mixed_pair(color_image, line_dicts, stats=None):
    """The best black-text + rubric pair sitting on one physical row."""
    best, best_score = None, 0.0
    for a, b in find_same_row_pairs(line_dicts):
        ra = stats[a] if stats else ink_stats(color_image, line_dicts[a])
        rb = stats[b] if stats else ink_stats(color_image, line_dicts[b])
        wa = max(x for x, _ in line_dicts[a]["boundary"]) - min(x for x, _ in line_dicts[a]["boundary"])
        wb = max(x for x, _ in line_dicts[b]["boundary"]) - min(x for x, _ in line_dicts[b]["boundary"])
        if ra[2] < 500 or rb[2] < 200:
            continue
        score = (1 - ra[0]) * rb[0] * min(wb / 400.0, 1.0) * min(wa / 400.0, 1.0)
        if score > best_score:
            best, best_score = (a, b), score
    return best


def merge_lines(a, b):
    """Fuse two polygons that sit on the same physical text row into one line.

    Kraken often returns the black text and the rubric that follows it on the
    same row as two separate polygons when the gap between them is wide. Fusing
    them gives the single mixed-colour line the splitter is actually designed
    for.
    """
    from shapely.geometry import MultiPoint
    hull = MultiPoint([tuple(p) for p in a["boundary"]] +
                      [tuple(p) for p in b["boundary"]]).convex_hull
    baseline = sorted([tuple(p) for p in a["baseline"]] +
                      [tuple(p) for p in b["baseline"]], key=lambda p: p[0])
    return {"boundary": [list(p) for p in hull.exterior.coords[:-1]],
            "baseline": [list(p) for p in baseline]}


def find_same_row_pairs(line_dicts):
    """Index pairs whose baselines share the same row and are side by side."""
    rows = []
    for i, ld in enumerate(line_dicts):
        ys = [p[1] for p in ld["baseline"]]
        xs = [p[0] for p in ld["baseline"]]
        if not ys:
            continue
        rows.append((i, min(xs), max(xs), sum(ys) / len(ys),
                     max(ys) - min(ys)))
    pairs = []
    for i, (ia, xa0, xa1, ya, _) in enumerate(rows):
        for ib, xb0, xb1, yb, hb in rows[i + 1:]:
            if abs(ya - yb) < 25 and xb0 > xa1 and xb0 - xa1 < 600:
                pairs.append((ia, ib))
    return pairs


def make_baseline_line(line_dict, index):
    from kraken.containers import BaselineLine
    return BaselineLine(
        id=str(index + 1),
        baseline=[tuple(p) for p in line_dict["baseline"]],
        boundary=[tuple(p) for p in line_dict["boundary"]],
    )


# ---------------------------------------------------------------------------
# The instrumented pipeline - each stage kept for plotting
# ---------------------------------------------------------------------------
class Stages(dict):
    __getattr__ = dict.__getitem__


def analyse_line(color_image, line, window_size=80, red_threshold=5.0):
    """Replicate split_line_boundary_by_color while keeping every intermediate."""
    xs, ys = zip(*line.boundary)
    left = max(0, min(xs) - PADDING)
    top = max(0, min(ys) - PADDING)
    right = min(color_image.width, max(xs) + PADDING)
    bottom = min(color_image.height, max(ys) + PADDING)

    crop = color_image.crop((left, top, right, bottom))
    rgb = np.array(crop)
    height, width = rgb.shape[:2]

    # --- STEP 2: polygon mask, background painted mid-gray -----------------
    mask = np.zeros((height, width), dtype=np.uint8)
    shifted = np.array([(x - left, y - top) for x, y in line.boundary], dtype=np.int32)
    cv2.fillPoly(mask, [shifted], 255)
    masked = rgb.copy()
    masked[mask == 0] = np.array(BG_GRAY, dtype=np.uint8)

    # --- STEP 3: RGB -> HSL ------------------------------------------------
    hsl = rgb_to_hsl(masked)
    h, s, l = hsl[:, :, 0], hsl[:, :, 1], hsl[:, :, 2]

    # --- STEP 4: CLAHE on the lightness channel ----------------------------
    l_scaled = (l * 255).astype(np.uint8)
    clahe = cv2.createCLAHE(clipLimit=CLAHE_CLIP, tileGridSize=CLAHE_TILE)
    l_enh = clahe.apply(l_scaled).astype(float) / 255.0

    # --- STEP 5: three gated Gaussian weights, per pixel -------------------
    hue_dist = np.minimum(np.abs(h), np.abs(h - 1))
    hue_gate = (h <= HUE_LO) | (h >= HUE_HI)
    w_h = np.where(hue_gate, np.exp(-(hue_dist ** 2) / (2 * SIGMA_H ** 2)), 0.0)

    l_gate = (l_enh >= L_LO) & (l_enh <= L_HI)
    w_l = np.where(l_gate, np.exp(-(np.abs(l_enh - 0.5) ** 2) / (2 * SIGMA_L ** 2)), 0.0)

    s_gate = (s >= S_LO) & (s <= S_HI)
    w_s = np.where(s_gate, np.exp(-(np.abs(s - 1.0) ** 2) / (2 * SIGMA_S ** 2)), 0.0)

    redness_px = w_h * w_l * w_s * 100.0            # per-pixel redness

    # --- STEP 6: collapse each column to one number ------------------------
    trace = redness_px.mean(axis=0) * 100.0          # column mean, rescaled
    peak_sat = s.max(axis=0)

    # --- STEP 7: moving-average denoising ----------------------------------
    k = min(window_size, width)
    denoised = np.convolve(trace, np.ones(k) / k, mode="same")

    # --- STEP 8: threshold -> runs, runs < 5 px absorbed by the previous ---
    regions, current, dropped = [], {"start": None, "above": None}, []
    for x in range(width):
        above = bool(denoised[x] >= red_threshold)
        if current["start"] is None:
            current = {"start": x, "above": above}
        elif current["above"] != above:
            if x - current["start"] >= MIN_REGION_PX:
                regions.append(current)
            else:
                dropped.append((current["start"], x, current["above"]))
            current = {"start": x, "above": above}
    if current["start"] is not None and width - current["start"] >= MIN_REGION_PX:
        regions.append(current)
    elif current["start"] is not None:
        dropped.append((current["start"], width, current["above"]))

    for i, reg in enumerate(regions):
        reg["end"] = width if i == len(regions) - 1 else regions[i + 1]["start"]
        reg["color"] = "red" if reg["above"] else "black"

    # --- STEP 9: intersect full-height bands with the line polygon ---------
    poly = Polygon([(x - left, y - top) for x, y in line.boundary])
    sub_polys = []
    for reg in regions:
        band = box(reg["start"], 0, reg["end"], height)
        inter = poly.buffer(0.01, resolution=1).intersection(band)
        if isinstance(inter, Polygon) and not inter.is_empty:
            sub_polys.append(list(inter.exterior.coords)[:-1])
        else:  # production fallback: the plain rectangle
            sub_polys.append([(reg["start"], 0), (reg["start"], height),
                              (reg["end"], height), (reg["end"], 0)])

    return Stages(
        offset=(left, top), size=(width, height), crop=rgb, mask=mask, masked=masked,
        h=h, s=s, l=l, l_enh=l_enh, w_h=w_h, w_l=w_l, w_s=w_s,
        redness_px=redness_px, trace=trace, denoised=denoised, peak_sat=peak_sat,
        regions=regions, dropped=dropped, sub_polys=sub_polys,
        threshold=red_threshold, window=window_size, poly=poly,
    )


def verify_against_production(color_image, line, idx, st):
    """The pictures must describe the shipping code, not a look-alike."""
    produced = split_line_boundary_by_color(
        color_image, line, idx, window_size=st.window, red_threshold=st.threshold
    )
    left, top = st.offset
    real = [(getattr(p, "color", "black"),
             round(min(x for x, _ in p.boundary) - left),
             round(max(x for x, _ in p.boundary) - left)) for p in produced]
    # compare against the polygon-clipped bands, which is what production emits
    mine = [(r["color"], round(min(x for x, _ in poly)), round(max(x for x, _ in poly)))
            for r, poly in zip(st.regions, st.sub_polys)]
    ok = len(real) == len(mine) and all(
        a[0] == b[0] and abs(a[1] - b[1]) <= 1 and abs(a[2] - b[2]) <= 1
        for a, b in zip(real, mine))
    return ok, real, mine


# ---------------------------------------------------------------------------
# Plot helpers
# ---------------------------------------------------------------------------
def _save(fig, out_dir, name):
    path = os.path.join(out_dir, name)
    fig.savefig(path, dpi=150, bbox_inches="tight", facecolor="white")
    plt.close(fig)
    print(f"  -> {name}")
    return path


def plot_page_overview(image, lines, out_dir, highlight):
    fig, ax = plt.subplots(figsize=(9, 10))
    ax.imshow(image)
    for i, ln in enumerate(lines):
        pts = np.array(ln["boundary"])
        hot = i in highlight
        ax.plot(*np.vstack([pts, pts[:1]]).T, lw=1.6 if hot else 0.5,
                color="#d62728" if hot else "#3a7bd5", alpha=1.0 if hot else 0.45)
        if hot:
            ax.text(pts[:, 0].min() - 12, pts[:, 1].mean(), f"L{i + 1}",
                    color="#d62728", fontsize=8, ha="right", va="center", weight="bold")
    ax.set_title(f"Step 1 - Kraken baseline segmentation: {len(lines)} line polygons")
    ax.axis("off")
    return _save(fig, out_dir, "00_page_segmentation.png")


def plot_stage_strips(st, out_dir, tag):
    """Every image-space stage, stacked as full-width strips."""
    panels = [
        (st.crop, "1. Cropped line (bbox of polygon + 10 px padding)", None, None),
        (np.dstack([st.mask] * 3), "2. Polygon mask", "gray", None),
        (st.masked, "3. Masked crop - outside the polygon painted mid-gray (128,128,128)", None, None),
        (st.h, "4a. Hue H (0..1, red sits at both ends)", "hsv", (0, 1)),
        (st.s, "4b. Saturation S", "viridis", (0, 1)),
        (st.l, "4c. Lightness L", "gray", (0, 1)),
        (st.l_enh, "5. Lightness after CLAHE (clip 2.0, 8x8 tiles)", "gray", (0, 1)),
        (st.w_h, "6a. Hue weight  exp(-d(H,red)^2 / 2*0.05^2), gated H<=0.1 or H>=0.91", "magma", (0, 1)),
        (st.w_l, "6b. Lightness weight  exp(-(L-0.5)^2 / 2*0.15^2), gated 0.25<=L<=0.8", "magma", (0, 1)),
        (st.w_s, f"6c. Saturation weight  exp(-(S-1)^2 / 2*0.2^2), gated 0.3<=S<=1.0"
                 f"   [display scaled to max = {st.w_s.max():.3f}; the theoretical max is 1.0]",
         "magma", (0, max(st.w_s.max(), 1e-6))),
        (st.redness_px, f"7. Per-pixel redness = product of the three weights x 100"
                        f"   [display scaled to max = {st.redness_px.max():.2f}; "
                        f"the theoretical max is 100]", "inferno",
         (0, max(st.redness_px.max(), 1e-6))),
    ]
    fig, axes = plt.subplots(len(panels), 1, figsize=(13, 1.15 * len(panels) + 2))
    for ax, (data, title, cmap, lim) in zip(axes, panels):
        kw = {"cmap": cmap} if cmap else {}
        if lim:
            kw["vmin"], kw["vmax"] = lim
        ax.imshow(data, aspect="auto", **kw)
        ax.set_title(title, fontsize=9, loc="left", pad=3)
        ax.set_xticks([])
        ax.set_yticks([])
    fig.suptitle("Red-ink pipeline, image stages", fontsize=12, y=0.995)
    fig.tight_layout()
    return _save(fig, out_dir, f"{tag}_10_stages.png")


def plot_trace(st, out_dir, tag, title):
    """The money shot: crop on top, column redness trace + threshold below."""
    w = st.size[0]
    fig, (ax0, ax1, ax2) = plt.subplots(
        3, 1, figsize=(13, 7), sharex=True,
        gridspec_kw={"height_ratios": [1.1, 2.6, 1.1], "hspace": 0.12})

    ax0.imshow(st.crop, aspect="auto")
    ax0.set_yticks([])
    ax0.set_title("Line crop", fontsize=9, loc="left")

    ax1.bar(range(w), st.trace, color="#e74c3c", alpha=0.35, width=1.0,
            label="raw column redness")
    ax1.plot(st.denoised, color="#1a7f37", lw=2.0,
             label=f"moving average, window = {st.window} px")
    ax1.axhline(st.threshold, color="#333", ls="--", lw=1.4,
                label=f"threshold = {st.threshold:g}  "
                      f"(UI sensitivity {threshold_to_sensitivity(st.threshold):.0f}%)")
    for reg in st.regions:
        ax1.add_patch(Rectangle((reg["start"], 0), reg["end"] - reg["start"],
                                max(ax1.get_ylim()[1], 1), alpha=0.10,
                                color="#e74c3c" if reg["color"] == "red" else "#444",
                                zorder=0))
    ax1.set_ylabel("redness score")
    ax1.set_xlim(0, w)
    ax1.set_ylim(0, max(float(st.trace.max()) * 1.1, st.threshold * 2))
    ax1.legend(fontsize=8, loc="upper right")

    ax2.imshow(st.crop, aspect="auto")
    for reg, poly in zip(st.regions, st.sub_polys):
        pts = np.array(poly)
        col = "#e74c3c" if reg["color"] == "red" else "#111"
        ax2.plot(*np.vstack([pts, pts[:1]]).T, color=col, lw=1.8)
        if (reg["end"] - reg["start"]) / w > 0.045:   # skip unlabelable slivers
            ax2.text((reg["start"] + reg["end"]) / 2, 2, reg["color"].upper(),
                     color=col, fontsize=8, ha="center", va="top", weight="bold",
                     bbox=dict(fc="white", ec="none", alpha=0.75, pad=1.0))
    ax2.set_yticks([])
    ax2.set_xlabel("column x (px in the crop)   -   "
                   "sub-polygons handed back to Kraken, one OCR pass each")

    fig.suptitle(title, fontsize=12, y=0.97)
    return _save(fig, out_dir, f"{tag}_20_trace.png")


def plot_histograms(st, out_dir, tag):
    inside = st.mask > 0
    ink = inside & (st.l < 0.65)
    fig, axes = plt.subplots(2, 2, figsize=(11, 6.5))

    ax = axes[0, 0]
    ax.hist(st.h[ink] * 360, bins=90, range=(0, 360), color="#888")
    for lo, hi in [(0, HUE_LO * 360), (HUE_HI * 360, 360)]:
        ax.axvspan(lo, hi, color="#e74c3c", alpha=0.22)
    ax.set_title("Hue of ink pixels (deg) - shaded = accepted 'red' gate", fontsize=9)
    ax.set_xlabel("hue")

    ax = axes[0, 1]
    ax.hist(st.s[ink], bins=60, range=(0, 1), color="#888")
    ax.axvspan(S_LO, S_HI, color="#2e86de", alpha=0.22)
    ax.set_title("Saturation of ink pixels - shaded = accepted gate", fontsize=9)

    ax = axes[1, 0]
    ax.hist(st.l[inside], bins=60, range=(0, 1), color="#bbb", label="L before CLAHE")
    ax.hist(st.l_enh[inside], bins=60, range=(0, 1), histtype="step",
            color="#1a7f37", lw=1.8, label="L after CLAHE")
    ax.axvspan(L_LO, L_HI, color="#f39c12", alpha=0.18)
    ax.legend(fontsize=8)
    ax.set_title("Lightness inside the polygon - shaded = accepted gate", fontsize=9)

    ax = axes[1, 1]
    vals = st.redness_px[inside]
    ax.hist(vals[vals > 0.01], bins=60, color="#e74c3c")
    ax.set_yscale("log")
    ax.set_title("Per-pixel redness > 0.01 (log count)", fontsize=9)

    fig.suptitle("Channel histograms and where the hard gates cut", fontsize=12)
    fig.tight_layout()
    return _save(fig, out_dir, f"{tag}_30_histograms.png")


def plot_parameters(st, out_dir, tag):
    fig, axes = plt.subplots(2, 2, figsize=(11, 6.5))

    ax = axes[0, 0]
    hv = np.linspace(0, 1, 1000)
    d = np.minimum(hv, np.abs(hv - 1))
    ax.plot(hv, np.where((hv <= HUE_LO) | (hv >= HUE_HI),
                         np.exp(-d ** 2 / (2 * SIGMA_H ** 2)), 0), color="#e74c3c")
    ax.plot(hv, np.exp(-d ** 2 / (2 * SIGMA_H ** 2)), color="#e74c3c", ls=":", alpha=0.5)
    ax.set_title(f"Hue kernel, sigma={SIGMA_H} + hard gate", fontsize=9)
    ax.set_xlabel("H")

    ax = axes[0, 1]
    lv = np.linspace(0, 1, 1000)
    ax.plot(lv, np.where((lv >= L_LO) & (lv <= L_HI),
                         np.exp(-(lv - 0.5) ** 2 / (2 * SIGMA_L ** 2)), 0), color="#f39c12")
    ax.plot(lv, np.exp(-(lv - 0.5) ** 2 / (2 * SIGMA_L ** 2)), color="#f39c12", ls=":", alpha=0.5)
    ax.set_title(f"Lightness kernel, sigma={SIGMA_L} + hard gate", fontsize=9)
    ax.set_xlabel("L")

    ax = axes[1, 0]
    sv = np.linspace(0, 1, 1000)
    ax.plot(sv, np.where((sv >= S_LO) & (sv <= S_HI),
                         np.exp(-(sv - 1) ** 2 / (2 * SIGMA_S ** 2)), 0), color="#2e86de")
    ax.plot(sv, np.exp(-(sv - 1) ** 2 / (2 * SIGMA_S ** 2)), color="#2e86de", ls=":", alpha=0.5)
    ax.set_title(f"Saturation kernel, sigma={SIGMA_S} + hard gate", fontsize=9)
    ax.set_xlabel("S")

    ax = axes[1, 1]
    sens = np.linspace(1, 100, 400)
    ax.plot(sens, [sensitivity_to_threshold(v) for v in sens], color="#111")
    ax.axhline(ANCHOR_THRESHOLD, ls="--", color="#e74c3c", lw=1)
    ax.axvline(ANCHOR_SENSITIVITY, ls="--", color="#e74c3c", lw=1)
    ax.set_yscale("log")
    ax.set_title("UI sensitivity -> threshold (anchor 80% = 5.0, gamma 3)", fontsize=9)
    ax.set_xlabel("sensitivity %")
    ax.set_ylabel("red_threshold")

    fig.suptitle("Tunable parameters of the redness score", fontsize=12)
    fig.tight_layout()
    return _save(fig, out_dir, f"{tag}_40_parameters.png")


def plot_sweeps(st, out_dir, tag):
    w = st.size[0]
    fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(11, 6))

    for win in (1, 20, 40, 80, 160):
        k = min(win, w)
        ax1.plot(np.convolve(st.trace, np.ones(k) / k, mode="same"),
                 lw=1.4, label=f"window {win}")
    ax1.axhline(st.threshold, ls="--", color="#333", lw=1)
    ax1.set_xlim(0, w)
    ax1.legend(fontsize=8, ncol=5)
    ax1.set_title("Effect of the moving-average window on the trace "
                  "(wide window = colour decisions bleed across the boundary)", fontsize=9)

    ths = np.logspace(-2, 2, 220)
    frac = [(np.convolve(st.trace, np.ones(min(st.window, w)) / min(st.window, w),
                         mode="same") >= t).mean() for t in ths]
    ax2.plot(ths, frac, color="#e74c3c")
    ax2.axvline(st.threshold, ls="--", color="#333", lw=1,
                label=f"current threshold {st.threshold:g}")
    ax2.set_xscale("log")
    ax2.set_xlabel("red_threshold")
    ax2.set_ylabel("fraction of columns tagged red")
    ax2.legend(fontsize=8)
    ax2.set_title("Threshold sweep for this line", fontsize=9)

    fig.tight_layout()
    return _save(fig, out_dir, f"{tag}_50_sweeps.png")


def plot_accuracy(rows, out_dir):
    """Per-line: how much of the ink is really red vs how much got tagged red."""
    rows = [r for r in rows if r["ink_px"] > 200]
    idx = np.arange(len(rows))
    fig, (ax, ax2) = plt.subplots(2, 1, figsize=(12, 6.5),
                                  gridspec_kw={"height_ratios": [2, 1]})
    ax.bar(idx - 0.2, [100 * r["red_ink"] for r in rows], width=0.4,
           color="#e74c3c", label="red ink in the line (reference)")
    ax.bar(idx + 0.2, [100 * r["red_fraction"] for r in rows], width=0.4,
           color="#2e86de", label="columns tagged RED by the algorithm")
    ax.set_xticks(idx)
    ax.set_xticklabels([f"L{r['line']}" for r in rows], fontsize=7, rotation=90)
    ax.set_ylabel("% of line")
    ax.legend(fontsize=8)
    ax.set_title("Detected rubric vs. actual red ink, per line", fontsize=11)

    ax2.bar(idx, [r["n_regions"] for r in rows], color="#555")
    ax2.axhline(1, color="#e74c3c", ls="--", lw=1, label="ideal for a single-colour line")
    ax2.set_xticks(idx)
    ax2.set_xticklabels([f"L{r['line']}" for r in rows], fontsize=7, rotation=90)
    ax2.set_ylabel("# sub-lines emitted")
    ax2.legend(fontsize=8)
    ax2.set_title("Fragmentation: how many separate OCR passes each line is cut into",
                  fontsize=11)
    fig.tight_layout()
    return _save(fig, out_dir, "02_page_accuracy.png")


def _overlay_trace(ax, st, show_threshold=True, ymax=None, xlim=None, labels=False):
    """Draw the crop with the redness trace laid over it - compact and readable."""
    h, w = st.size[1], st.size[0]
    ax.imshow(st.crop, aspect="auto", extent=(0, w, h, 0))
    ymax = ymax or max(float(st.denoised.max()) * 1.6, st.threshold * 3)
    to_y = lambda v: h - np.clip(v, 0, ymax) / ymax * h * 0.92
    x0, x1 = xlim or (0, w)
    for reg in st.regions:
        red = reg["color"] == "red"
        ax.axvspan(reg["start"], reg["end"], color="#c1543a" if red else "#9aa0a6",
                   alpha=0.20 if red else 0.09, lw=0)
        if labels and (min(reg["end"], x1) - max(reg["start"], x0)) > (x1 - x0) * 0.035:
            ax.text((max(reg["start"], x0) + min(reg["end"], x1)) / 2, h * 0.055,
                    reg["color"].upper(), color="#c1543a" if red else "#1b1815",
                    fontsize=FS_CAP, ha="center", va="center", weight="bold",
                    bbox=dict(fc="white", ec="none", alpha=0.85, pad=2.2))
    ax.fill_between(np.arange(w), to_y(st.trace), h, color="#c1543a", alpha=0.20, lw=0)
    ax.plot(np.arange(w), to_y(st.denoised), color="#12703a", lw=3.0)
    if show_threshold:
        ax.axhline(to_y(st.threshold), color="#1b1815", ls="--", lw=2.0)
    ax.set_xlim(x0, x1)
    ax.set_ylim(h, 0)
    ax.set_xticks([])
    ax.set_yticks([])
    for sp in ax.spines.values():
        sp.set_color("#d9d4c9")
    return ymax


def _slide_header(fig, title, kicker=None):
    """Headline block drawn inside the 16:9 figure, so the slide *is* the image."""
    fig.text(0.033, 0.955, title, fontsize=FS_H1, color="#1b1815", va="top", ha="left")
    if kicker:
        fig.text(0.033, 0.885, kicker, fontsize=FS_SUB, color="#6f685c",
                 va="top", ha="left")
    fig.add_artist(plt.Line2D([0.033, 0.967], [0.845, 0.845], color="#e6e1d6",
                              lw=1.2, transform=fig.transFigure))


def _pct(a, q=99.0, floor=1e-6):
    """Display scale for a very dim map: the q-th percentile of its non-zeros."""
    nz = a[a > 0]
    return max(float(np.percentile(nz, q)) if nz.size else 1.0, floor)


def plot_slide_stages(st, out_dir, name="slide_stages.png"):
    """16:9 slide - every image stage of the pipeline as a labelled strip."""
    w_s_max, red_max = _pct(st.w_s), _pct(st.redness_px)
    panels = [
        (st.crop,       None,      "1\nCrop",            None),
        (st.masked,     None,      "2\nMask",            None),
        (st.h,          "hsv",     "3\nHue  H",          (0, 1)),
        (st.s,          "viridis", "4\nSaturation  S",   (0, 1)),
        (st.l_enh,      "gray",    "5\nLightness  L",    (0, 1)),
        (st.w_h,        "magma",   "6\nHue weight",      (0, 1)),
        (st.w_s,        "magma",   f"7\nSat. weight\n×{1 / w_s_max:.0f}", (0, w_s_max)),
        (st.redness_px, "inferno", f"8\nRedness\n×{100 / red_max:.0f}",   (0, red_max)),
    ]
    fig = plt.figure(figsize=(16, 9), facecolor="white")
    _slide_header(fig, "Eight views of one line",
                  "Everything the splitter computes before it decides anything - "
                  "crop, mask, colour channels, weights, score")
    gs = fig.add_gridspec(len(panels), 1, hspace=0.13,
                          left=0.125, right=0.985, top=0.805, bottom=0.02)
    for i, (data, cmap, label, lim) in enumerate(panels):
        ax = fig.add_subplot(gs[i, 0])
        kw = {"cmap": cmap} if cmap else {}
        if lim:
            kw["vmin"], kw["vmax"] = lim
        ax.imshow(data, aspect="auto", **kw)
        ax.set_xticks([]); ax.set_yticks([])
        for sp in ax.spines.values():
            sp.set_color("#d9d4c9")
        ax.set_ylabel(label, rotation=0, ha="right", va="center",
                      fontsize=FS_LABEL, labelpad=16, color="#1b1815",
                      linespacing=1.35)
    return _save(fig, out_dir, name)


def ink_masks(st):
    """Split the pixels inside the polygon into red ink, black ink and parchment."""
    inside = st.mask > 0
    red = inside & (st.s >= 0.32) & ((st.h <= 0.08) | (st.h >= 0.92)) & (st.l < 0.62)
    black = inside & (st.s < 0.25) & (st.l < 0.50)
    parchment = inside & (st.l > 0.75)
    return inside, red, black, parchment


def _w_l(x):
    return np.where((x >= L_LO) & (x <= L_HI),
                    np.exp(-(x - 0.5) ** 2 / (2 * SIGMA_L ** 2)), 0.0)


def plot_slide_clahe(st, out_dir, name="slide_clahe.png"):
    """16:9 slide - what CLAHE really does, and what it costs the redness score."""
    inside, red, black, parch = ink_masks(st)
    fig = plt.figure(figsize=(16, 9), facecolor="white")
    _slide_header(fig, "What CLAHE actually does",
                  "It does not move the parchment - it stretches local contrast, which "
                  "makes the ink darker. The lightness kernel then likes it less.")
    gs = fig.add_gridspec(3, 2, height_ratios=[1, 1, 3.0], width_ratios=[1.75, 1],
                          hspace=0.44, wspace=0.16,
                          left=0.05, right=0.985, top=0.775, bottom=0.075)

    for row, (data, title) in enumerate([
            (st.l, "Lightness L, straight from the HSL conversion"),
            (st.l_enh, "Lightness L after CLAHE  -  clip limit 2.0, 8x8 tiles")]):
        ax = fig.add_subplot(gs[row, :])
        ax.imshow(data, cmap="gray", vmin=0, vmax=1, aspect="auto")
        ax.set_xticks([]); ax.set_yticks([])
        ax.set_title(title, fontsize=FS_LABEL, loc="left", pad=6, color="#1b1815")

    # ---- histogram -----------------------------------------------------
    ax = fig.add_subplot(gs[2, 0])
    bins = np.linspace(0.15, 1.0, 110)
    ax.hist(st.l[inside], bins=bins, color="#c4bdae", label="before CLAHE")
    ax.hist(st.l_enh[inside], bins=bins, histtype="step", lw=2.8,
            color="#12703a", label="after CLAHE")
    ax.axvspan(L_LO, L_HI, color="#a0432a", alpha=0.08, lw=0)
    ax.axvline(L_HI, color="#a0432a", lw=1.6, ls="--")
    ax.set_xlim(0.15, 1.0)
    ax.set_yscale("log")
    ax.set_ylim(20, ax.get_ylim()[1] * 3)
    top = ax.get_ylim()[1]
    ax.annotate("parchment peak\ndoes not move",
                xy=(0.835, top * 0.030), xytext=(0.605, top * 0.030),
                fontsize=FS_CAP, color="#4a443a", va="center", ha="right",
                arrowprops=dict(arrowstyle="->", color="#4a443a", lw=1.4))
    ax.annotate("ink moves darker\nand spreads out",
                xy=(0.37, top * 0.0016), xytext=(0.22, top * 0.02),
                fontsize=FS_CAP, color="#12703a", va="center", ha="left",
                arrowprops=dict(arrowstyle="->", color="#12703a", lw=1.4))
    ax.text(L_HI - 0.008, top * 0.45, "gate edge 0.80  ", fontsize=FS_CAP,
            ha="right", va="top", color="#a0432a")
    ax.set_xlabel("lightness", fontsize=FS_CAP)
    ax.set_ylabel("pixels in the line  (log)", fontsize=FS_CAP)
    ax.tick_params(labelsize=FS_TICK)
    ax.legend(fontsize=FS_CAP, loc="upper left", frameon=False)
    for sp in ("top", "right"):
        ax.spines[sp].set_visible(False)

    # ---- what it costs the score ---------------------------------------
    ax = fig.add_subplot(gs[2, 1])
    groups = [("red ink", red, "#a0432a"), ("black ink", black, "#4c4337")]
    x = np.arange(len(groups))
    before = [float(_w_l(st.l[msk]).mean()) for _, msk, _ in groups]
    after = [float(_w_l(st.l_enh[msk]).mean()) for _, msk, _ in groups]
    ax.bar(x - 0.20, before, width=0.38, color="#c4bdae", label="before")
    ax.bar(x + 0.20, after, width=0.38, color="#12703a", label="after")
    for xi, (b, a) in enumerate(zip(before, after)):
        ax.text(xi - 0.20, b + 0.025, f"{b:.2f}", ha="center", fontsize=FS_CAP, color="#4a443a")
        ax.text(xi + 0.20, a + 0.025, f"{a:.2f}", ha="center", fontsize=FS_CAP, color="#12703a")
        ax.text(xi, max(b, a) + 0.14, f"{(a - b) / b * 100:+.0f}%", ha="center",
                fontsize=FS_LABEL, color="#a0432a", weight="bold")
    ax.set_xticks(x)
    ax.set_xticklabels([g[0] for g in groups], fontsize=FS_LABEL)
    ax.set_ylim(0, 1.22)
    ax.set_yticks([0, 0.5, 1.0])
    ax.tick_params(labelsize=FS_TICK)
    ax.legend(fontsize=FS_CAP, loc="upper right", frameon=False, ncol=2)
    for sp in ("top", "right"):
        ax.spines[sp].set_visible(False)
    ax.set_title("Lightness weight the pixels earn", fontsize=FS_LABEL,
                 loc="left", pad=6, color="#1b1815")
    return _save(fig, out_dir, name)


def _gradient_bar(ax, kind):
    """A colour ramp under a kernel plot, dimmed wherever the gate rejects."""
    n = 600
    v = np.linspace(0, 1, n)
    if kind == "hue":
        rgb = plt.get_cmap("hsv")(v)[:, :3]
        keep = (v <= HUE_LO) | (v >= HUE_HI)
    elif kind == "light":
        rgb = np.repeat(v[:, None], 3, axis=1)
        keep = (v >= L_LO) & (v <= L_HI)
    else:
        base = np.array([0.62, 0.24, 0.14])
        grey = np.array([0.72, 0.70, 0.67])
        rgb = grey[None, :] * (1 - v[:, None]) + base[None, :] * v[:, None]
        keep = (v >= S_LO) & (v <= S_HI)
    rgb = np.where(keep[:, None], rgb, rgb * 0.25 + 0.75)
    ax.imshow(rgb[None, :, :], aspect="auto", extent=(0, 1, 0, 1))
    ax.set_xticks([]); ax.set_yticks([])
    for sp in ax.spines.values():
        sp.set_color("#d9d4c9")


def plot_slide_params(out_dir, name="slide_params.png"):
    """16:9 slide - the three gates, each over its own colour ramp."""
    fig = plt.figure(figsize=(16, 9), facecolor="white")
    _slide_header(fig, "Three gates, one score")
    gs = fig.add_gridspec(3, 3, height_ratios=[6, 0.55, 2.4], hspace=0.14,
                          wspace=0.16, left=0.055, right=0.985, top=0.775, bottom=0.045)
    v = np.linspace(0, 1, 1200)
    specs = [
        ("hue", "#a0432a", "Hue",
         np.where((v <= HUE_LO) | (v >= HUE_HI),
                  np.exp(-np.minimum(v, np.abs(v - 1)) ** 2 / (2 * SIGMA_H ** 2)), 0),
         np.exp(-np.minimum(v, np.abs(v - 1)) ** 2 / (2 * SIGMA_H ** 2)),
         "Keep only hues within 36 deg of pure red.\nEverything green, blue or violet is zeroed.\n"
         "Iron-gall ink is brown - it survives this gate too.",
         [(0, "0 deg"), (0.5, "180 deg"), (1, "360 deg")]),
        ("light", "#8a6d1f", "Lightness",
         np.where((v >= L_LO) & (v <= L_HI),
                  np.exp(-(v - 0.5) ** 2 / (2 * SIGMA_L ** 2)), 0),
         np.exp(-(v - 0.5) ** 2 / (2 * SIGMA_L ** 2)),
         "Keep only mid-tones, 0.25 to 0.80.\nPale parchment above and near-black\n"
         "below are zeroed - ink, not page, not shadow.",
         [(0, "black"), (0.5, "mid"), (1, "white")]),
        ("sat", "#1f5f8a", "Saturation",
         np.where((v >= S_LO) & (v <= S_HI),
                  np.exp(-(v - 1) ** 2 / (2 * SIGMA_S ** 2)), 0),
         np.exp(-(v - 1) ** 2 / (2 * SIGMA_S ** 2)),
         "Keep only pixels above 0.30, and reward\nfull chroma. Real minium sits near 0.42,\n"
         "so it scores about 0.04 out of 1.",
         [(0, "grey"), (0.5, "0.5"), (1, "full")]),
    ]
    for col, (kind, colour, title, gated, raw, caption, ticks) in enumerate(specs):
        ax = fig.add_subplot(gs[0, col])
        ax.plot(v, raw, color=colour, ls=":", lw=2.0, alpha=0.55)
        ax.plot(v, gated, color=colour, lw=3.4)
        ax.fill_between(v, gated, color=colour, alpha=0.12)
        ax.set_ylim(-0.03, 1.08)
        ax.set_xlim(0, 1)
        ax.set_xticks([])
        ax.set_yticks([0, 0.5, 1])
        ax.tick_params(labelsize=FS_TICK)
        for sp in ("top", "right"):
            ax.spines[sp].set_visible(False)
        ax.set_title(title, fontsize=FS_TITLE, loc="left", pad=10, color="#1b1815")

        bar = fig.add_subplot(gs[1, col])
        _gradient_bar(bar, kind)
        for x, lab in ticks:
            bar.text(x, -0.55, lab, fontsize=FS_TICK - 1, color="#6f685c",
                     ha={0: "left", 1: "right"}.get(x, "center"), va="top",
                     transform=bar.transData)

        cap = fig.add_subplot(gs[2, col])
        cap.axis("off")
        cap.text(0, 0.82, caption, fontsize=FS_CAP, va="top", ha="left",
                 color="#4a443a", linespacing=1.6, transform=cap.transAxes)

    fig.text(0.033, 0.885,
             r"redness$(x,y)\;=\;w_H \cdot w_L \cdot w_S \times 100$"
             "        -  every $w$ is a Gaussian weight, forced to zero outside its gate",
             fontsize=FS_SUB + 3, color="#6f685c", va="top")
    return _save(fig, out_dir, name)


def plot_slide_sensitivity(out_dir, default_threshold=5.0, name="slide_sensitivity.png"):
    """16:9 slide - how the UI slider maps onto the decision threshold."""
    fig = plt.figure(figsize=(16, 9), facecolor="white")
    _slide_header(fig, "What the sensitivity slider does",
                  "0-100% in the UI maps onto the decision threshold along a power "
                  "curve; 0% switches colour detection off entirely")
    ax = fig.add_axes([0.075, 0.10, 0.58, 0.68])
    sens = np.linspace(1, 99.5, 800)
    ax.plot(sens, [sensitivity_to_threshold(v) for v in sens], color="#a0432a", lw=3.4)
    ax.set_yscale("log")
    ax.set_xlim(0, 100)
    ax.set_ylim(1e-3, 1e3)
    ax.set_xlabel("sensitivity slider  (%)", fontsize=FS_LABEL)
    ax.set_ylabel("red_threshold  (log scale)", fontsize=FS_LABEL)
    ax.tick_params(labelsize=FS_TICK)
    ax.grid(True, which="major", color="#ece9e2", lw=1)
    ax.set_axisbelow(True)
    for sp in ("top", "right"):
        ax.spines[sp].set_visible(False)

    t80 = sensitivity_to_threshold(80)
    ax.plot([80], [t80], "o", ms=13, color="#a0432a", zorder=5)
    ax.annotate("default  80% = 5.0", (80, t80), textcoords="offset points",
                xytext=(-24, 52), fontsize=FS_LABEL, color="#a0432a",
                ha="right", weight="bold")
    ax.axvline(80, color="#a0432a", lw=1.2, ls="--", alpha=0.6)
    ax.annotate("less sensitive\n(only vivid rubrics)", (24, sensitivity_to_threshold(24)),
                textcoords="offset points", xytext=(12, 26), fontsize=FS_CAP, color="#6f685c")
    ax.annotate("more sensitive\n(faint ink, more false alarms)", (95, sensitivity_to_threshold(95)),
                textcoords="offset points", xytext=(-20, -80), fontsize=FS_CAP,
                color="#6f685c", ha="right")

    ax2 = fig.add_axes([0.71, 0.10, 0.275, 0.68])
    ax2.axis("off")
    rows = [("0 %", "detection off"), ("20 %", f"{sensitivity_to_threshold(20):.0f}"),
            ("40 %", f"{sensitivity_to_threshold(40):.0f}"),
            ("60 %", f"{sensitivity_to_threshold(60):.0f}"),
            ("80 %", f"{sensitivity_to_threshold(80):.1f}"),
            ("90 %", f"{sensitivity_to_threshold(90):.2f}"),
            ("95 %", f"{sensitivity_to_threshold(95):.3f}")]
    ax2.text(0, 1.0, "slider", fontsize=FS_CAP, color="#6f685c", transform=ax2.transAxes)
    ax2.text(0.62, 1.0, "threshold", fontsize=FS_CAP, color="#6f685c", transform=ax2.transAxes)
    for i, (a, b) in enumerate(rows):
        y = 0.90 - i * 0.115
        bold = a.startswith("80")
        ax2.plot([0, 1], [y + 0.058, y + 0.058], color="#ece9e2", lw=1,
                 transform=ax2.transAxes, clip_on=False)
        ax2.text(0, y, a, fontsize=FS_LABEL, transform=ax2.transAxes,
                 color="#a0432a" if bold else "#1b1815",
                 weight="bold" if bold else "normal")
        ax2.text(0.62, y, b, fontsize=FS_LABEL, transform=ax2.transAxes,
                 color="#a0432a" if bold else "#1b1815",
                 weight="bold" if bold else "normal", family="monospace")
    ax2.text(0, 0.02, "power curve, exponent 3,\nanchored so 80% always means 5.0",
             fontsize=FS_CAP, color="#6f685c", transform=ax2.transAxes, linespacing=1.5)
    return _save(fig, out_dir, name)


def plot_slide_pipeline(st, out_dir, name="slide_pipeline.png"):
    """16:9 slide - the score, the threshold, and the sub-lines that come out."""
    fig = plt.figure(figsize=(16, 9), facecolor="white")
    _slide_header(fig, "From score to tagged sub-lines",
                  "One line: black prayer text, then the red rubric AD COMPL")
    gs = fig.add_gridspec(3, 1, height_ratios=[1.05, 2.4, 1.05], hspace=0.34,
                          left=0.033, right=0.985, top=0.795, bottom=0.03)
    w = st.size[0]

    ax = fig.add_subplot(gs[0, 0])
    ax.imshow(st.crop, aspect="auto")
    ax.set_xticks([]); ax.set_yticks([])
    ax.set_title("The line as the splitter receives it",
                 fontsize=FS_LABEL, loc="left", pad=8, color="#1b1815")

    ax = fig.add_subplot(gs[1, 0])
    ax.bar(range(w), st.trace, color="#c1543a", alpha=0.30, width=1.0)
    ax.plot(st.denoised, color="#12703a", lw=3.0)
    ax.axhline(st.threshold, color="#1b1815", ls="--", lw=2.0)
    ax.set_xlim(0, w)
    top = max(float(np.percentile(st.trace, 99.4)) * 1.15, st.threshold * 4)
    ax.set_ylim(0, top)
    ax.text(w * 0.004, st.threshold + top * 0.02, f"threshold {st.threshold:g}",
            fontsize=FS_LABEL, color="#1b1815", va="bottom")
    ax.text(w * 0.30, top * 0.88, "raw score, one value per pixel column",
            fontsize=FS_LABEL, color="#c1543a")
    ax.text(w * 0.30, top * 0.76, "smoothed over an 80 px window",
            fontsize=FS_LABEL, color="#12703a")
    ax.set_xticks([]); ax.set_yticks([])
    for sp in ("top", "right", "bottom"):
        ax.spines[sp].set_visible(False)
    ax.set_title("Score every column, smooth it, then cut where it crosses the line",
                 fontsize=FS_LABEL, loc="left", pad=8, color="#1b1815")

    ax = fig.add_subplot(gs[2, 0])
    ax.imshow(st.crop, aspect="auto")
    for reg, poly in zip(st.regions, st.sub_polys):
        pts = np.array(poly)
        col = "#c1543a" if reg["color"] == "red" else "#1b1815"
        ax.plot(*np.vstack([pts, pts[:1]]).T, color=col, lw=2.6)
        if (reg["end"] - reg["start"]) / w > 0.05:
            ax.text((reg["start"] + reg["end"]) / 2, 4, reg["color"].upper(),
                    color=col, fontsize=FS_CAP, ha="center", va="top", weight="bold",
                    bbox=dict(fc="white", ec="none", alpha=0.85, pad=2.0))
    ax.set_xticks([]); ax.set_yticks([])
    ax.set_title("Each band becomes its own line, tagged and sent to OCR separately",
                 fontsize=FS_LABEL, loc="left", pad=8, color="#1b1815")
    return _save(fig, out_dir, name)


def plot_slide_errors(cases, out_dir, name="slide_errors.png"):
    """16:9 slide - one strip per failure case, trace drawn over the manuscript.

    Rows are sized from each crop's aspect ratio, so both strips are squashed by
    the same factor rather than one being stretched into a smear.
    """
    ratios = []
    for st, xlim, _, _ in cases:
        x0, x1 = xlim or (0, st.size[0])
        ratios.append(st.size[1] / max(x1 - x0, 1))
    fig = plt.figure(figsize=(16, 9), facecolor="white")
    _slide_header(fig, "Where it goes wrong",
                  "Two false positives with one cause: red pigment that belongs to a "
                  "decorated initial, sitting inside a black line's polygon")
    gs = fig.add_gridspec(len(cases), 1, height_ratios=ratios, hspace=0.42,
                          left=0.03, right=0.985, top=0.765, bottom=0.045)
    for i, (st, xlim, title, sub) in enumerate(cases):
        ax = fig.add_subplot(gs[i, 0])
        _overlay_trace(ax, st, ymax=st.threshold * 10, xlim=xlim, labels=True)
        ax.set_title(title, fontsize=FS_TITLE, loc="left", pad=40, color="#1b1815")
        ax.text(0, 1.045, sub, fontsize=FS_CAP, color="#6f685c",
                transform=ax.transAxes, va="bottom")
    return _save(fig, out_dir, name)


def plot_page_result(image, per_line, out_dir):
    fig, ax = plt.subplots(figsize=(9, 10))
    ax.imshow(image)
    for idx, st in per_line:
        left, top = st.offset
        for reg, poly in zip(st.regions, st.sub_polys):
            pts = np.array(poly) + np.array([left, top])
            ax.plot(*np.vstack([pts, pts[:1]]).T, lw=1.2,
                    color="#e74c3c" if reg["color"] == "red" else "#1b1b1b")
    ax.set_title("Final result - every line split into red / black sub-polygons")
    ax.axis("off")
    return _save(fig, out_dir, "01_page_result.png")


# ---------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", default=os.path.join(SERVER_DIR, "tests", "test_red1.jpg"))
    ap.add_argument("--out", default=os.path.join(SERVER_DIR, "dbg_imgs"))
    ap.add_argument("--line", type=int, default=None, help="1-based line number")
    ap.add_argument("--threshold", type=float, default=5.0)
    ap.add_argument("--window", type=int, default=80)
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--merge", default=None,
                    help="fuse two 1-based line numbers into one mixed line, e.g. 11,12")
    ap.add_argument("--no-merge", action="store_true",
                    help="do not auto-fuse a black+rubric row pair")
    ap.add_argument("--slide-threshold", type=float, default=2.5,
                    help="threshold used for the slide figures")
    ap.add_argument("--fp-image",
                    default=os.path.join(SERVER_DIR, "tests", "test_red2.jpg"))
    ap.add_argument("--fp-lines", default=None,
                    help="1-based line numbers for the false-positive slide")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    image = PILImage.open(args.image).convert("RGB")
    line_dicts = segment_lines(args.image, args.out, args.device)

    print("[run] analysing every line...")
    per_line, report = [], []
    for i, ld in enumerate(line_dicts):
        if len(ld["boundary"]) < 3:
            continue
        line = make_baseline_line(ld, i)
        st = analyse_line(image, line, args.window, args.threshold)
        per_line.append((i, st))
        w = st.size[0]
        red_frac = sum(r["end"] - r["start"] for r in st.regions if r["color"] == "red") / w
        red_ink, black_ink, ink_px = ink_stats(image, ld)
        report.append({
            "line": i + 1, "width": w, "height": st.size[1],
            "regions": [{"color": r["color"], "start": r["start"], "end": r["end"]}
                        for r in st.regions],
            "n_regions": len(st.regions),
            "red_fraction": round(red_frac, 3),
            "red_ink": round(float(red_ink), 3),
            "black_ink": round(float(black_ink), 3),
            "ink_px": ink_px,
            "max_raw": round(float(st.trace.max()), 2),
            "max_denoised": round(float(st.denoised.max()), 2),
            "dropped_narrow_runs": len(st.dropped),
        })
    by_line = {r["line"]: r for r in report}

    # --- the main illustration: a line holding both black text and a rubric.
    # Kraken usually splits those into two polygons (the gap between them is
    # wide), so fuse the best black + rubric pair on the same row.
    merged_dict = None
    if args.merge:
        a, b = (int(v) - 1 for v in args.merge.split(","))
        merged_dict = merge_lines(line_dicts[a], line_dicts[b])
        merged_from = (a, b)
    elif not args.no_merge and not args.line:
        best, best_score = None, 0.0
        for a, b in find_same_row_pairs(line_dicts):
            ra, rb = by_line.get(a + 1), by_line.get(b + 1)
            if not ra or not rb or ra["ink_px"] < 500 or rb["ink_px"] < 200:
                continue
            score = (1 - ra["red_ink"]) * rb["red_ink"] * min(rb["width"] / 400.0, 1.0)
            if score > best_score:
                best, best_score = (a, b), score
        if best:
            merged_dict = merge_lines(line_dicts[best[0]], line_dicts[best[1]])
            merged_from = best

    if args.line:
        main_idx, main_st = next(x for x in per_line if x[0] == args.line - 1)
        main_line = make_baseline_line(line_dicts[main_idx], main_idx)
        main_name = f"line{main_idx + 1:02d}"
        main_title = f"Line {main_idx + 1}"
    elif merged_dict:
        main_idx = merged_from[0]
        main_line = make_baseline_line(merged_dict, main_idx)
        main_st = analyse_line(image, main_line, args.window, args.threshold)
        main_name = f"mixed_L{merged_from[0] + 1}+L{merged_from[1] + 1}"
        main_title = (f"Mixed line (L{merged_from[0] + 1} + L{merged_from[1] + 1} fused): "
                      f"black text followed by a red rubric")
        print(f"[run] fused L{merged_from[0] + 1} + L{merged_from[1] + 1} "
              f"into one mixed black+red line")
    else:
        def mixed_score(item):
            _, st = item
            w = st.size[0]
            red = sum(r["end"] - r["start"] for r in st.regions if r["color"] == "red") / w
            return min(red, 1 - red) * min(w / 600.0, 1.0)
        main_idx, main_st = max(per_line, key=mixed_score)
        main_line = make_baseline_line(line_dicts[main_idx], main_idx)
        main_name = f"line{main_idx + 1:02d}"
        main_title = f"Line {main_idx + 1}"

    # a likely false positive: a short red run at the very start of an
    # otherwise black line == decorated initial mistaken for a rubric
    suspects = []
    for idx, st in per_line:
        w = st.size[0]
        if not st.regions:
            continue
        first = st.regions[0]
        rest_black = all(r["color"] == "black" for r in st.regions[1:])
        if first["color"] == "red" and rest_black and (first["end"] - first["start"]) / w < 0.35:
            suspects.append((idx, st, (first["end"] - first["start"]) / w))
    suspects.sort(key=lambda t: -t[2])

    print(f"[run] main illustration: {main_name}")
    ok, real, mine = verify_against_production(image, main_line, main_idx, main_st)
    print(f"[check] instrumented regions match production output: {ok}")
    if not ok:
        print(f"        production={real}\n        instrumented={mine}")

    highlight = {main_idx} | {s[0] for s in suspects[:1]}
    plot_page_overview(image, line_dicts, args.out, highlight)
    plot_page_result(image, per_line, args.out)
    plot_accuracy(report, args.out)

    tag = main_name
    plot_stage_strips(main_st, args.out, tag)
    plot_trace(main_st, args.out, tag,
               main_title + " - column redness, denoising and thresholding")
    plot_histograms(main_st, args.out, tag)
    plot_parameters(main_st, args.out, tag)
    plot_sweeps(main_st, args.out, tag)

    if suspects:
        s_idx, s_st, s_frac = suspects[0]
        stag = f"fp_line{s_idx + 1:02d}"
        print(f"[run] false-positive candidate: L{s_idx + 1} "
              f"(leading red run = {s_frac:.0%} of the line)")
        plot_trace(s_st, args.out, stag,
                   f"Line {s_idx + 1} - decorated initial scored as a rubric "
                   f"({s_frac:.0%} of the line tagged red)")
        plot_stage_strips(s_st, args.out, stag)
        plot_histograms(s_st, args.out, stag)

    # a pure rubric shredded into many alternating bands
    frag = [r for r in report if r["red_ink"] > 0.6 and r["n_regions"] > 3]
    frag.sort(key=lambda r: -r["n_regions"])
    if frag:
        f_idx = frag[0]["line"] - 1
        f_st = dict(per_line)[f_idx]
        print(f"[run] fragmentation example: L{f_idx + 1} "
              f"({frag[0]['n_regions']} sub-lines, {100 * frag[0]['red_ink']:.0f}% red ink)")
        plot_trace(f_st, args.out, f"frag_line{f_idx + 1:02d}",
                   f"Line {f_idx + 1} - a fully red rubric cut into "
                   f"{frag[0]['n_regions']} alternating sub-lines")

    # a whole rubric line missed completely
    missed = [r for r in report if r["red_ink"] > 0.6 and r["red_fraction"] < 0.05
              and r["ink_px"] > 500]
    if missed:
        m_idx = missed[0]["line"] - 1
        m_st = dict(per_line)[m_idx]
        print(f"[run] missed-rubric example: L{m_idx + 1} "
              f"({100 * missed[0]['red_ink']:.0f}% red ink, tagged 0% red)")
        plot_trace(m_st, args.out, f"missed_line{m_idx + 1:02d}",
                   f"Line {m_idx + 1} - {100 * missed[0]['red_ink']:.0f}% red ink, "
                   f"but the trace never reaches the threshold")

    # ---------------- slide figures ----------------
    slide_st = analyse_line(image, main_line, args.window, args.slide_threshold)
    plot_slide_stages(slide_st, args.out)
    plot_slide_params(args.out)
    plot_slide_sensitivity(args.out, args.threshold)
    plot_slide_pipeline(slide_st, args.out)

    # False positives come from a second page, where two distinct mistakes are
    # visible on the first and the last line.
    fp_image_path = args.fp_image
    if fp_image_path and os.path.exists(fp_image_path):
        fp_image = PILImage.open(fp_image_path).convert("RGB")
        fp_lines = segment_lines(fp_image_path, args.out, args.device)

        # CLAHE is best shown on a line that carries both inks at once.
        pair = pick_mixed_pair(fp_image, fp_lines)
        if pair:
            clahe_line = make_baseline_line(
                merge_lines(fp_lines[pair[0]], fp_lines[pair[1]]), pair[0])
            print(f"[run] CLAHE example: {os.path.basename(fp_image_path)} "
                  f"L{pair[0] + 1} + L{pair[1] + 1} fused")
        else:
            clahe_line = main_line
        plot_slide_clahe(analyse_line(fp_image if pair else image, clahe_line,
                                      args.window, args.slide_threshold), args.out)
        margin = text_block_left(fp_lines, fp_image.width)
        if args.fp_lines:
            picks = [int(v) - 1 for v in args.fp_lines.split(",")]
        else:
            picks = list(edge_rows(fp_lines))
        captions = [
            ("A red-filled letter inside black text",
             "The bowl of the initial Q is painted red, so the very first word of an "
             "otherwise black line is cut out and tagged RED."),
            ("A red initial reaching into the line below",
             "The initial M belongs to the line above, but its stroke crosses this "
             "polygon - so the first letters of \u201ctui\u201d are tagged RED."),
        ]
        fp_cases = []
        for n, (idx, (title, sub)) in enumerate(zip(picks, captions)):
            line = make_baseline_line(
                extend_line_left(fp_lines[idx], margin - 10), idx)
            st = analyse_line(fp_image, line, args.window, args.slide_threshold)
            span = st.size[1] * 5.5          # show ~5.5 line-heights of context
            fp_cases.append((st, (0, min(st.size[0], span)), title, sub))
            plot_trace(st, args.out, f"fp2_line{idx + 1:02d}",
                       f"{os.path.basename(fp_image_path)} line {idx + 1} - {title}")
            print(f"[run] false positive {n + 1}: {os.path.basename(fp_image_path)} "
                  f"line {idx + 1}, "
                  f"{sum(1 for r in st.regions if r['color'] == 'red')} red band(s)")
        if fp_cases:
            plot_slide_errors(fp_cases, args.out)

    summary = {
        "image": args.image, "threshold": args.threshold, "window": args.window,
        "sensitivity_percent": round(threshold_to_sensitivity(args.threshold), 1),
        "lines": len(per_line),
        "illustration": main_name,
        "false_positive_candidates": [s[0] + 1 for s in suspects],
        "matches_production": ok,
        "per_line": report,
    }
    with open(os.path.join(args.out, "red_detection_report.json"), "w") as fh:
        json.dump(summary, fh, indent=2)
    print(f"[done] figures + red_detection_report.json in {args.out}")


if __name__ == "__main__":
    main()
