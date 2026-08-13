"""Shared harness: load the 4 test examples, normalise, score."""
import difflib
import re
import sys
import os

sys.path.insert(0, "/Users/lukasz/Developer/ritus_plus/ritus-server")

TESTS = "/Users/lukasz/Developer/ritus_plus/Transcription Tests.txt"


def load_examples():
    raw = open(TESTS, encoding="utf-8").read()
    lines = raw.split("\n")
    # Blocks are introduced by "N. Original OCR" and "N. Fixed by human"
    examples = []
    cur = None
    mode = None
    for ln in lines:
        s = ln.strip()
        m_ex = re.match(r"^Example (\d+)\s*(.*)$", s)
        if m_ex:
            if cur:
                examples.append(cur)
            cur = {"n": int(m_ex.group(1)), "source": m_ex.group(2), "ocr": [], "ref": []}
            mode = None
            continue
        if re.match(r"^\d+\.\s*Original OCR$", s):
            mode = "ocr"
            continue
        if re.match(r"^\d+\.\s*Fixed by human$", s):
            mode = "ref"
            continue
        if cur and mode:
            cur[mode].append(ln)
    if cur:
        examples.append(cur)
    for e in examples:
        e["ocr"] = "\n".join(e["ocr"]).strip()
        e["ref"] = "\n".join(e["ref"]).strip()
    return [e for e in examples if e["ocr"] and e["ref"]]


_TAG = re.compile(r"</?(?:red|func)>", re.I)
_PUNCT = re.compile(r"[^\w\s]", re.UNICODE)


def normalise(text):
    """Lowercase word list, tags/punctuation/prayer-separators removed.

    Comparison is about the words the model recovered, not about markup or
    spacing, so both sides are reduced to a bare word sequence.
    """
    t = _TAG.sub(" ", text or "")
    t = t.replace("⏎", " ")  # the prayer separator
    t = _PUNCT.sub(" ", t)
    t = t.lower()
    # medieval spelling variants that both sides use interchangeably and that
    # would otherwise dominate the score
    t = t.replace("j", "i").replace("v", "u").replace("ae", "e").replace("y", "i")
    return [w for w in t.split() if w]


def wer(ref_words, hyp_words):
    """Word error rate via edit distance (lower is better)."""
    n, m = len(ref_words), len(hyp_words)
    if n == 0:
        return 0.0 if m == 0 else 1.0
    prev = list(range(m + 1))
    for i in range(1, n + 1):
        cur = [i] + [0] * m
        for j in range(1, m + 1):
            cost = 0 if ref_words[i - 1] == hyp_words[j - 1] else 1
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
        prev = cur
    return prev[m] / n


def score(reference, hypothesis):
    r = normalise(reference)
    h = normalise(hypothesis)
    return {
        "similarity": difflib.SequenceMatcher(None, r, h).ratio(),
        "wer": wer(r, h),
        "ref_words": len(r),
        "hyp_words": len(h),
    }


def fmt_table(rows, headers):
    widths = [max(len(str(r[i])) for r in [headers] + rows) for i in range(len(headers))]
    out = [" | ".join(str(headers[i]).ljust(widths[i]) for i in range(len(headers)))]
    out.append("-|-".join("-" * w for w in widths))
    for r in rows:
        out.append(" | ".join(str(r[i]).ljust(widths[i]) for i in range(len(headers))))
    return "\n".join(out)
