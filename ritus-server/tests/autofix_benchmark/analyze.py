"""Summarise the benchmark: quality, cost, and how often the model just echoes."""
import difflib
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, "/Users/lukasz/Developer/ritus_plus/ritus-server")

from bench_common import load_examples, normalise, score, fmt_table
from transcription_autofix import apply_autofix

examples = {e["n"]: e for e in load_examples()}
results = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "results.json")))

ORDER = ["A_current_noFR", "B_current_FR", "C_context_FR", "D_ctxfullfunc_FR", "E_ctxshortfunc_FR"]
NAMES = {
    "A_current_noFR": "A  current prompt, F/R off  (= today)",
    "B_current_FR": "B  current prompt, F/R ON",
    "C_context_FR": "C  +context rules, F/R ON",
    "D_ctxfullfunc_FR": "D  +context +FULL funcs, F/R ON",
    "E_ctxshortfunc_FR": "E  +context +SHORT funcs, F/R ON",
}


def echo_ratio(entry):
    """1.0 means the model returned its input unchanged."""
    e = examples[entry["example"]]
    src = apply_autofix(e["ocr"]) if entry["find_replace"] else e["ocr"]
    return difflib.SequenceMatcher(None, normalise(src), normalise(entry["text"])).ratio()


# ---- reference points that need no model ----
raw = sum(score(e["ref"], e["ocr"])["similarity"] for e in examples.values()) / len(examples)
fr = sum(score(e["ref"], apply_autofix(e["ocr"]))["similarity"] for e in examples.values()) / len(examples)
raw_w = sum(score(e["ref"], e["ocr"])["wer"] for e in examples.values()) / len(examples)
fr_w = sum(score(e["ref"], apply_autofix(e["ocr"]))["wer"] for e in examples.values()) / len(examples)

print("No-model reference points (mean over 4 examples):")
print(f"  raw OCR, nothing applied     sim={raw:.4f}  wer={raw_w:.4f}")
print(f"  find/replace only, no AI     sim={fr:.4f}  wer={fr_w:.4f}")
print()

rows = []
for label in ORDER:
    entries = [v for v in results.values() if v["label"] == label]
    if not entries:
        continue
    n = len(entries)
    sim = sum(e["similarity"] for e in entries) / n
    wer = sum(e["wer"] for e in entries) / n
    sec = sum(e["seconds"] for e in entries) / n
    ptok = sum(e["prompt_tokens"] for e in entries) / n
    echo = sum(echo_ratio(e) for e in entries) / n
    rows.append([
        NAMES[label], n, f"{sim:.4f}", f"{sim - raw:+.4f}", f"{wer:.4f}",
        f"{echo:.3f}", f"{sec:.1f}s", f"{ptok:.0f}",
    ])

print("AI autofix results:")
print(fmt_table(rows, ["condition", "n", "sim", "vs raw", "wer", "echo", "time", "ptok"]))
print()
print("sim  = word similarity to the human correction (higher better)")
print("wer  = word error rate vs the human correction (lower better)")
print("echo = how much of the output is just the input copied back (1.000 = did nothing)")
print("ptok = prompt tokens consumed (context budget is 4096 total)")

print("\n\nPer-example similarity:")
per = [["example"] + ORDER]
rows2 = []
for n in sorted(examples):
    row = [f"ex{n}"]
    for label in ORDER:
        k = f"{label}|ex{n}"
        row.append(f"{results[k]['similarity']:.4f}" if k in results else "-")
    rows2.append(row)
print(fmt_table(rows2, ["ex"] + [l.split("_")[0] for l in ORDER]))
