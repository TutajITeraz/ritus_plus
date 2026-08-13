"""Evaluate the mechanical find/replace on its own, and audit every hit."""
import re
import sys
from collections import Counter

from bench_common import load_examples, score, fmt_table
from transcription_autofix import apply_autofix, _get_ruleset

examples = load_examples()

print("=" * 78)
print("PART 1 - what the find/replace actually changes, hit by hit")
print("=" * 78)

ruleset = _get_ruleset()
all_hits = Counter()
for e in examples:
    hits = []
    for m in ruleset.pattern.finditer(e["ocr"]):
        repl = ruleset.replacements[m.lastgroup]
        s = max(0, m.start() - 22)
        ctx = e["ocr"][s:m.end() + 22].replace("\n", " ")
        hits.append((m.group(), repl, ctx))
        all_hits[(m.group(), repl)] += 1
    print(f"\n--- Example {e['n']}: {len(hits)} replacement(s) ---")
    for got, repl, ctx in hits:
        print(f"  {got!r:>14} -> {repl!r:<22} ...{ctx}...")

print("\n--- totals per rule ---")
for (got, repl), n in all_hits.most_common():
    print(f"  {n:>3}x  {got!r} -> {repl!r}")

print()
print("=" * 78)
print("PART 2 - does find/replace alone move the text toward the human version?")
print("=" * 78)
rows = []
for e in examples:
    before = score(e["ref"], e["ocr"])
    after = score(e["ref"], apply_autofix(e["ocr"]))
    rows.append([
        f"#{e['n']}",
        f"{before['similarity']:.4f}",
        f"{after['similarity']:.4f}",
        f"{after['similarity'] - before['similarity']:+.4f}",
        f"{before['wer']:.4f}",
        f"{after['wer']:.4f}",
        f"{after['wer'] - before['wer']:+.4f}",
    ])
mb = sum(score(e["ref"], e["ocr"])["similarity"] for e in examples) / len(examples)
ma = sum(score(e["ref"], apply_autofix(e["ocr"]))["similarity"] for e in examples) / len(examples)
wb = sum(score(e["ref"], e["ocr"])["wer"] for e in examples) / len(examples)
wa = sum(score(e["ref"], apply_autofix(e["ocr"]))["wer"] for e in examples) / len(examples)
rows.append(["MEAN", f"{mb:.4f}", f"{ma:.4f}", f"{ma - mb:+.4f}", f"{wb:.4f}", f"{wa:.4f}", f"{wa - wb:+.4f}"])
print(fmt_table(rows, ["ex", "sim_before", "sim_after", "d_sim", "wer_before", "wer_after", "d_wer"]))
print("\n(similarity: higher better. WER: lower better.)")
