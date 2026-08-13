"""Autofix for common transcription (OCR) mistakes.

Rules are read from data/common_transcription_errors.tsv, a plain TSV with
columns: "is error a valid word in Latin", "is full word", "Mistake",
"Should be replaced with", "instructions". Only "Mistake", "Should be
replaced with" and "is full word" drive the autofix logic:

  - is full word == TRUE:  the mistake is only replaced when it occurs as a
    standalone word (not as part of a longer word).
  - is full word == FALSE: the mistake is replaced wherever it occurs,
    including inside other words (e.g. a single-letter substitution).

The TSV holds only mechanical, context-free replacements. Mistakes that need
to be judged from context (e.g. "quas" -> "quaesumus", which depends on the
surrounding words) are deliberately NOT here - they are handled by the AI
autofix prompt in prompt_template.py.

Two properties matter for correctness:

  - Single pass. All rules are compiled into one alternation and applied in
    a single left-to-right scan, so text that has already been produced by a
    replacement is never re-matched by another rule. Applying the rules
    sequentially instead would let them cascade in surprising ways as the
    list grows.
  - Tags are protected. The OCR text carries <red>/<func> markup; those
    spans are skipped so a substring rule can never corrupt a tag.

The file is reloaded automatically whenever it changes on disk, so the list
can be edited/extended without restarting the server.
"""
import csv
import os
import re
import threading

_DATA_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "common_transcription_errors.tsv")

# Markup emitted by the transcription pipeline; never rewritten by a rule.
_TAG_RE = re.compile(r"</?(?:red|func)>", re.IGNORECASE)

_lock = threading.Lock()
_cached_mtime = None
_cached_ruleset = None


class _RuleSet:
    """Compiled rules plus the single alternation regex that applies them."""

    def __init__(self, rules):
        self.rules = rules
        self.pattern = None
        self.replacements = {}
        if not rules:
            return
        # Longest mistakes first so that a longer rule always wins over a
        # shorter one starting at the same position ("Off." before "j").
        # Full-word rules win ties, since they are the more specific form.
        ordered = sorted(rules, key=lambda r: (-len(r["mistake"]), not r["full_word"]))
        parts = []
        for i, rule in enumerate(ordered):
            name = f"r{i}"
            self.replacements[name] = rule["replacement"]
            body = re.escape(rule["mistake"])
            if rule["full_word"]:
                body = r"(?<!\w)" + body + r"(?!\w)"
            parts.append(f"(?P<{name}>{body})")
        self.pattern = re.compile("|".join(parts))

    def apply(self, text):
        if self.pattern is None:
            return text
        return self.pattern.sub(
            lambda m: self.replacements[m.lastgroup],
            text,
        )


def _load_rules():
    rules = []
    if not os.path.exists(_DATA_PATH):
        return rules
    with open(_DATA_PATH, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f, delimiter="\t")
        for row in reader:
            mistake = (row.get("Mistake") or "").strip()
            replacement = (row.get("Should be replaced with") or "").strip()
            if not mistake or not replacement:
                continue
            rules.append({
                "mistake": mistake,
                "replacement": replacement,
                "full_word": (row.get("is full word") or "").strip().upper() == "TRUE",
            })
    return rules


def _get_ruleset():
    """Return the compiled ruleset, reloading if the TSV changed on disk."""
    global _cached_mtime, _cached_ruleset
    try:
        mtime = os.path.getmtime(_DATA_PATH)
    except OSError:
        return _RuleSet([])
    with _lock:
        if mtime != _cached_mtime or _cached_ruleset is None:
            _cached_ruleset = _RuleSet(_load_rules())
            _cached_mtime = mtime
        return _cached_ruleset


def get_rules():
    """Return the current rules as a list of dicts (mistake/replacement/full_word)."""
    return _get_ruleset().rules


def apply_autofix(text):
    """Find and replace common transcription mistakes in `text`.

    Markup tags (<red>, </red>, <func>, </func>) are left untouched.
    """
    if not text:
        return text
    ruleset = _get_ruleset()
    # Split on tags so rules only ever see the text between them.
    pieces = _TAG_RE.split(text)
    tags = _TAG_RE.findall(text)
    fixed = [ruleset.apply(p) for p in pieces]
    out = [fixed[0]]
    for tag, piece in zip(tags, fixed[1:]):
        out.append(tag)
        out.append(piece)
    return "".join(out)
