"""Accuracy + speed benchmark for "Full Automatic Lookup and Split".

Compares the n-gram matcher (ngram_matcher.py) against the legacy algorithm
(batch_analysis.py) on tests/Wr_Univ_I_F_366_merged.csv.

That file is one row holding all 1532 manuscript formula texts concatenated into
a single character stream with no boundaries, so the splitter has to find where
each prayer starts and ends. Ground truth is recoverable exactly: the stream is
the texts from tests/Wr_Univ_I_F_366_automatic_fill.csv concatenated in row
order, so walking that file locates every true boundary with no algorithm
involved.

Metrics
  boundary precision / recall - a predicted span counts as correct when it
    overlaps a true span by at least 50% IoU
  formula_id agreement        - among boundary-matched spans whose true
    formula_id is known, how often the predicted id agrees

Run:
    python tests/benchmark_split_methods.py              # n-gram only (seconds)
    python tests/benchmark_split_methods.py --legacy     # both (legacy is slow)

This is NOT part of the unit suite - it needs the full corpus and, with
--legacy, takes a long time.
"""
import argparse
import bisect
import json
import os
import re
import sys
import time
import types

HERE = os.path.dirname(os.path.abspath(__file__))
SRV = os.path.dirname(HERE)
sys.path.insert(0, SRV)

# batch_analysis binds a live SQLAlchemy session at import time; stub it so the
# pure pipeline functions can run without a database.
_stub = types.ModuleType("models")


class _Session:
    def commit(self):
        pass

    def refresh(self, obj):
        # batch_analysis.is_cancelled() re-reads the run's status from the
        # database before deciding, and treats any failure to do so as "the run
        # was cancelled". Without this no-op the stub raises AttributeError,
        # every cancel check reports True, and the legacy arm returns an empty
        # result list after running for several minutes.
        pass


_stub.db = types.SimpleNamespace(session=_Session())
_stub.Content = object
_stub.BatchProcessing = object
sys.modules.setdefault("models", _stub)

import pandas as pd  # noqa: E402

import batch_analysis as BA  # noqa: E402
import ngram_matcher as NM  # noqa: E402

# Legacy algorithm baseline, measured on this machine with --legacy at
# threshold 75 (it takes ~40 minutes, so it is recorded rather than re-run on
# every invocation). The n-gram matcher is expected to beat all four; regenerate
# with --legacy if the corpus or the legacy pipeline changes.
LEGACY_BASELINE = {
    "seconds": 2403.5,
    "precision": 41.11,
    "recall": 67.62,
    "f1": 51.14,
    "id_agreement": 85.92,
}

MERGED = os.path.join(HERE, "Wr_Univ_I_F_366_merged.csv")
SOURCE = os.path.join(HERE, "Wr_Univ_I_F_366_automatic_fill.csv")
FORMULAS = os.path.join(SRV, "static", "data", "formulas.csv")

_WORD_RE = re.compile(r"\S+")


class FakeProgress:
    status = "running"
    progress = 0
    total_rows = 0
    processed_rows = 0


class FakeRow:
    def __init__(self, rid, data):
        self.id = rid
        self.data = data


def build_ground_truth(stream):
    """Locate each known formula text in the stream, in row order."""
    src = pd.read_csv(SOURCE, dtype=str)
    src["formula_text_from_ms"] = src["formula_text_from_ms"].fillna("")
    src["formula_id"] = src["formula_id"].fillna("")
    truth = []
    cursor = 0
    for _, row in src.iterrows():
        piece = row["formula_text_from_ms"].strip()
        if not piece:
            continue
        idx = stream.find(piece, cursor)
        if idx == -1:
            continue
        truth.append({
            "start": idx,
            "end": idx + len(piece),
            "formula_id": row["formula_id"].strip(),
        })
        cursor = idx + len(piece)
    return truth


def build_char_map(stream):
    """positions[k] = offset in `stream` of its k-th non-whitespace character."""
    return [i for i, c in enumerate(stream) if not c.isspace()]


def spans_from_results(results, stream, positions):
    """Walk the emitted segments along the stream to recover char offsets.

    Walking by WORD would be wrong for the legacy algorithm: it cuts fragments at
    the character offsets rapidfuzz's partial_ratio_alignment returns, which can
    split a word in two ("alleluia" -> "a" + "lleluia"), and refine_text_tokens
    can merge two words into one. Either shifts the word sequence and makes every
    later span drift.

    Neither operation adds or drops a non-whitespace CHARACTER, so the stripped
    character sequence is walked instead. Verified for both methods: the
    concatenated segments reproduce the stream's non-whitespace characters
    exactly (assert_covers_stream below).
    """
    spans = []
    k = 0
    total = len(positions)
    for seg in results:
        count = sum(1 for c in seg["original_text"] if not c.isspace())
        if count == 0:
            continue
        if k >= total:
            break
        start_k = k
        k = min(k + count, total)
        spans.append({
            "start": positions[start_k],
            "end": positions[k - 1] + 1,
            "formula_id": str(seg.get("best_phrase_id") or ""),
        })
    return spans


def assert_covers_stream(results, stream, label):
    """Guard the assumption span recovery rests on. If a method ever dropped or
    duplicated text, every metric below it would be silently meaningless."""
    emitted = "".join(
        c for c in " ".join(r["original_text"] for r in results) if not c.isspace())
    expected = "".join(c for c in stream if not c.isspace())
    if emitted != expected:
        print(f"  WARNING [{label}]: emitted text does not reproduce the stream "
              f"({len(emitted)} vs {len(expected)} non-whitespace chars) - "
              f"span recovery is unreliable, treat boundary metrics with suspicion.")
        return False
    return True


def _iou(a, b):
    inter = max(0, min(a["end"], b["end"]) - max(a["start"], b["start"]))
    if not inter:
        return 0.0
    union = max(a["end"], b["end"]) - min(a["start"], b["start"])
    return inter / union if union else 0.0


def score(pred, truth, label, elapsed):
    truth_sorted = sorted(truth, key=lambda t: t["start"])
    starts = [t["start"] for t in truth_sorted]
    matched = set()
    hit = id_ok = id_tot = 0
    for p in pred:
        i = bisect.bisect_left(starts, p["start"]) - 2
        best_j, best_v = None, 0.0
        for j in range(max(0, i), min(len(truth_sorted), i + 6)):
            v = _iou(p, truth_sorted[j])
            if v > best_v:
                best_v, best_j = v, j
        if best_j is None or best_v < 0.5:
            continue
        hit += 1
        matched.add(best_j)
        t = truth_sorted[best_j]
        if t["formula_id"]:
            id_tot += 1
            if p["formula_id"] and p["formula_id"] == t["formula_id"]:
                id_ok += 1

    precision = hit / len(pred) * 100 if pred else 0.0
    recall = len(matched) / len(truth) * 100 if truth else 0.0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0
    identified = sum(1 for p in pred if p["formula_id"])
    print(f"--- {label} ---")
    print(f"  wall time:            {elapsed:.1f}s")
    print(f"  segments produced:    {len(pred)}   (ground truth: {len(truth)})")
    print(f"  segments identified:  {identified}")
    print(f"  boundary precision:   {precision:.2f}%")
    print(f"  boundary recall:      {recall:.2f}%")
    print(f"  boundary F1:          {f1:.2f}")
    if id_tot:
        print(f"  formula_id agreement: {id_ok}/{id_tot} = {id_ok / id_tot * 100:.2f}%")
    print()
    return {
        "label": label, "seconds": round(elapsed, 2), "segments": len(pred),
        "identified": identified, "precision": round(precision, 2),
        "recall": round(recall, 2), "f1": round(f1, 2),
        "id_agreement": round(id_ok / id_tot * 100, 2) if id_tot else None,
    }


def run_ngram(tokens, phrases, threshold, n):
    t0 = time.perf_counter()
    results, timing = NM.split_and_match(tokens, phrases, similarity_threshold=threshold, n=n)
    return results, time.perf_counter() - t0, timing


def run_legacy(tokens, phrases, threshold):
    """Drive the legacy pipeline exactly as batch_process_project does."""
    bp = FakeProgress()
    t0 = time.perf_counter()
    _, conc_by_word = BA.build_phrases_concordance(phrases)
    BA.build_phrases_tokens(phrases, conc_by_word)
    annotated = BA.annotate_text_tokens(tokens, conc_by_word, threshold, batch_process=bp)
    refined = BA.refine_text_tokens(annotated, conc_by_word, threshold, batch_process=bp)
    results = BA.search_phrases_in_text_by_fragment(refined, phrases, threshold, batch_process=bp)
    changes = len(results)
    passes = 0
    while changes > 0 and passes < 15:
        new_results = BA.research_unfound_phrases(
            results, phrases, threshold, batch_process=bp, is_rite=False,
            progress_min=0, progress_max=100)
        passes += 1
        changes = len(new_results) - len(results)
        results = list(new_results)
    for r in results:
        if r["best_phrase_id"] == "":
            r["check_again"] = "1"
    return results, time.perf_counter() - t0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--legacy", action="store_true",
                    help="also run the legacy algorithm (slow: tens of minutes)")
    ap.add_argument("--threshold", type=float, default=75.0)
    ap.add_argument("--n", type=int, default=NM.DEFAULT_NGRAM_SIZE)
    ap.add_argument("--json", help="write metrics to this path")
    ap.add_argument("--save-segments", metavar="DIR",
                    help="also dump each method's raw segments there, so the "
                         "scoring can be revisited without re-running the split")
    args = ap.parse_args()

    stream = pd.read_csv(MERGED, dtype=str)["formula_text_from_ms"].iloc[0]
    truth = build_ground_truth(stream)
    phrases = BA.load_phrases(FORMULAS)
    tokens = BA.build_text_tokens(
        [FakeRow(1, json.dumps({"formula_text_from_ms": stream,
                                "where_in_ms_from": "1r", "where_in_ms_to": "1r"}))],
        FakeProgress())

    print(f"\nstream: {len(stream)} chars / {len(tokens)} tokens")
    print(f"corpus: {len(phrases)} formulas")
    print(f"ground truth: {len(truth)} segments "
          f"({sum(1 for t in truth if t['formula_id'])} with a known formula_id)")
    print(f"threshold: {args.threshold}\n")

    positions = build_char_map(stream)

    def dump(results, name):
        if not args.save_segments:
            return
        os.makedirs(args.save_segments, exist_ok=True)
        path = os.path.join(args.save_segments, f"{name}_segments.json")
        with open(path, "w") as f:
            json.dump([{"original_text": r["original_text"],
                        "best_phrase_id": r.get("best_phrase_id", ""),
                        "similarity_percentage": r.get("similarity_percentage", 0)}
                       for r in results], f)
        print(f"  saved raw segments -> {path}")

    out = []
    results, elapsed, timing = run_ngram(tokens, phrases, args.threshold, args.n)
    dump(results, "ngram")
    assert_covers_stream(results, stream, "n-gram matcher")
    m = score(spans_from_results(results, stream, positions), truth,
              f"N-GRAM MATCHER (n={args.n})", elapsed)
    m["stage_timing"] = {k: round(v, 3) for k, v in timing.items()}
    print(f"  stage breakdown: {m['stage_timing']}\n")
    out.append(m)

    if args.legacy:
        print("running the legacy algorithm - this takes a long time...\n", flush=True)
        results, elapsed = run_legacy(tokens, phrases, args.threshold)
        dump(results, "legacy")
        assert_covers_stream(results, stream, "legacy algorithm")
        out.append(score(spans_from_results(results, stream, positions), truth,
                         "LEGACY ALGORITHM", elapsed))

    if len(out) == 2:
        a, b = out[0], out[1]
        print("=== HEAD TO HEAD ===")
        print(f"  speed:        n-gram {a['seconds']}s vs legacy {b['seconds']}s "
              f"({b['seconds'] / a['seconds']:.1f}x faster)")
        print(f"  boundary F1:  n-gram {a['f1']} vs legacy {b['f1']}")
        print(f"  identified:   n-gram {a['identified']} vs legacy {b['identified']}")

    # Regression gate: the n-gram matcher must not fall behind the legacy
    # algorithm on any accuracy axis, nor stop being dramatically faster.
    baseline = out[1] if len(out) == 2 else LEGACY_BASELINE
    source = "this run" if len(out) == 2 else "recorded baseline"
    ngram = out[0]
    print(f"=== CHECKS (vs legacy algorithm, {source}) ===")
    checks = [
        ("boundary precision", ngram["precision"], baseline["precision"]),
        ("boundary recall", ngram["recall"], baseline["recall"]),
        ("boundary F1", ngram["f1"], baseline["f1"]),
        # A method that matched no boundary at all has no agreement figure;
        # scoring that as 0 keeps the gate reporting a failure instead of
        # crashing on the comparison.
        ("formula_id agreement", ngram["id_agreement"] or 0, baseline["id_agreement"] or 0),
    ]
    failures = 0
    for name, got, want in checks:
        ok = got >= want
        if not ok:
            failures += 1
        print(f"  {'ok  ' if ok else 'FAIL'} {name}: {got:.2f} vs legacy {want:.2f}")
    faster = ngram["seconds"] < baseline["seconds"]
    if not faster:
        failures += 1
    print(f"  {'ok  ' if faster else 'FAIL'} speed: {ngram['seconds']}s vs legacy "
          f"{baseline['seconds']}s ({baseline['seconds'] / ngram['seconds']:.0f}x faster)")
    print(f"\n{len(checks) + 1 - failures}/{len(checks) + 1} checks passed")

    if args.json:
        with open(args.json, "w") as f:
            json.dump(out, f, indent=1)
        print(f"wrote {args.json}")

    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
