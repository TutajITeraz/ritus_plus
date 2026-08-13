"""Safety audit: fire every rule at the HUMAN-CORRECTED text.

The reference text is already correct, so any rule that matches there is by
definition producing a corruption. This is the cheapest strong signal we have
for whether a rule is safe to apply blindly.
"""
from collections import Counter

from bench_common import load_examples
from transcription_autofix import _get_ruleset

examples = load_examples()
ruleset = _get_ruleset()

print("Rules firing on already-correct human text (each one is a FALSE POSITIVE):\n")
bad = Counter()
for e in examples:
    for m in ruleset.pattern.finditer(e["ref"]):
        repl = ruleset.replacements[m.lastgroup]
        if m.group() == "j":
            continue  # j->i is an orthographic normalisation, not an error fix
        s = max(0, m.start() - 30)
        ctx = e["ref"][s:m.end() + 30].replace("\n", " ")
        bad[(m.group(), repl)] += 1
        print(f"  ex{e['n']}  {m.group()!r} -> {repl!r}")
        print(f"        ...{ctx}...")

print("\nSummary:")
if not bad:
    print("  none - no rule corrupts the human text")
for (got, repl), n in bad.most_common():
    print(f"  {n:>3}x  {got!r} -> {repl!r}   <-- UNSAFE")
