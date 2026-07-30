"""Autofix for common transcription (OCR) mistakes.

Rules are read from data/common_transcription_errors.tsv, a plain TSV with
columns: "is error a valid word in Latin", "is full word", "Mistake",
"Should be replaced with", "instructions". Only "Mistake", "Should be
replaced with" and "is full word" drive the autofix logic:

  - is full word == TRUE:  the mistake is only replaced when it occurs as a
    standalone word (not as part of a longer word).
  - is full word == FALSE: the mistake is replaced wherever it occurs,
    including inside other words (e.g. a single-letter substitution).

The file is reloaded automatically whenever it changes on disk, so the list
can be edited/extended without restarting the server.
"""
import csv
import os
import re
import threading

_DATA_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "common_transcription_errors.tsv")

_lock = threading.Lock()
_cached_mtime = None
_cached_rules = []


def _compile_rule(mistake, replacement, full_word):
    if full_word:
        pattern = re.compile(r"(?<!\w)" + re.escape(mistake) + r"(?!\w)")
    else:
        pattern = re.compile(re.escape(mistake))
    return {"mistake": mistake, "replacement": replacement, "pattern": pattern}


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
            full_word = (row.get("is full word") or "").strip().upper() == "TRUE"
            rules.append(_compile_rule(mistake, replacement, full_word))
    return rules


def get_rules():
    """Return the current ruleset, reloading from disk if the TSV changed."""
    global _cached_mtime, _cached_rules
    try:
        mtime = os.path.getmtime(_DATA_PATH)
    except OSError:
        return []
    with _lock:
        if mtime != _cached_mtime:
            _cached_rules = _load_rules()
            _cached_mtime = mtime
        return _cached_rules


def apply_autofix(text):
    """Find and replace common transcription mistakes in `text`."""
    if not text:
        return text
    for rule in get_rules():
        text = rule["pattern"].sub(lambda m, r=rule["replacement"]: r, text)
    return text
