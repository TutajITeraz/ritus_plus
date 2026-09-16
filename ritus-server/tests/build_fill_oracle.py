"""Build the ground-truth oracle for the Automatic Fill benchmark.

For every manuscript row in tests/Wr_Univ_I_F_366_automatic_fill.csv, finds the
formula in the WHOLE corpus (all 13,228 rows of static/data/formulas.csv) with
the highest Levenshtein similarity. That exhaustive answer is what both matching
methods are approximating, so comparing each method's pick against it measures
precision directly rather than just measuring the two methods against each other.

Two oracles are written, because the two methods optimise slightly different
metrics and each must be scored on its own terms:

  oracle_raw.json  - similarity over raw lowercased text
                     (what the legacy algorithm's Levenshtein stage optimises)
  oracle_norm.json - similarity over Latin-normalized text
                     (what the n-gram matcher's re-rank stage optimises)

Where a real match exists the two agree on 98.9% of rows, so the comparison is
apples-to-apples in the range that matters; they diverge mainly on rows whose
best match is poor enough that the argmax is arbitrary.

Needs rapidfuzz (already a server dependency); takes ~25s for both oracles.

Run:
    python tests/build_fill_oracle.py [--source CSV] [--out-dir DIR]
"""
import argparse
import json
import os
import re
import time
import unicodedata

import pandas as pd
from rapidfuzz import process
from rapidfuzz.distance import Levenshtein

HERE = os.path.dirname(os.path.abspath(__file__))
SRV = os.path.dirname(HERE)
FORMULAS = os.path.join(SRV, "static", "data", "formulas.csv")
SOURCE = os.path.join(HERE, "Wr_Univ_I_F_366_automatic_fill.csv")

_PAREN = re.compile(r"\([^)]*\)")
_DIGIT = re.compile(r"\d+")
_PUNCT = re.compile(r"[^\w\s]", re.UNICODE)
_WS = re.compile(r"\s+")


def normalize_latin(s):
    """Mirror of normalizeLatin in ritus-client/src/utils/ngramLookup.jsx."""
    if not s:
        return ""
    s = _PAREN.sub(" ", s)
    s = "".join(c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c))
    s = s.lower()
    s = s.replace("j", "i").replace("v", "u").replace("w", "uu")
    s = s.replace("ae", "e").replace("oe", "e")
    return _WS.sub(" ", _PUNCT.sub(" ", _DIGIT.sub(" ", s))).strip()


def build(queries, corpus_texts, corpus_ids, label):
    t0 = time.perf_counter()
    sim = process.cdist(queries, corpus_texts,
                        scorer=Levenshtein.normalized_similarity,
                        workers=-1, dtype="float32")
    elapsed = time.perf_counter() - t0
    best_idx = sim.argmax(axis=1)
    best_val = sim.max(axis=1)
    print(f"  {label}: {len(queries)}x{len(corpus_texts)} = "
          f"{len(queries) * len(corpus_texts):,} comparisons in {elapsed:.1f}s")
    return best_idx, best_val


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", default=SOURCE,
                    help="manuscript CSV to build the oracle for "
                         "(default: Wr_Univ_I_F_366_automatic_fill.csv)")
    ap.add_argument("--out-dir", default=HERE)
    args = ap.parse_args()

    os.makedirs(args.out_dir, exist_ok=True)

    form = pd.read_csv(FORMULAS, dtype=str)
    form["text"] = form["text"].fillna("")
    ids = form["id"].tolist()
    raw_corpus = [t.lower() for t in form["text"]]
    norm_corpus = [normalize_latin(t) for t in form["text"]]

    df = pd.read_csv(args.source, dtype=str)
    df["formula_text_from_ms"] = df["formula_text_from_ms"].fillna("")
    rows = [(i, t.strip()) for i, t in enumerate(df["formula_text_from_ms"]) if t.strip()]
    print(f"{len(rows)} manuscript rows with text, {len(ids)} formulas")

    for name, corpus, prep in (
        ("oracle_raw.json", raw_corpus, lambda t: t.lower()),
        ("oracle_norm.json", norm_corpus, normalize_latin),
    ):
        queries = [prep(t) for _, t in rows]
        best_idx, best_val = build(queries, corpus, ids, name)
        out = {
            str(ri): {"formula_id": ids[int(best_idx[k])],
                      "similarity": round(float(best_val[k]) * 100, 4)}
            for k, (ri, _) in enumerate(rows)
        }
        path = os.path.join(args.out_dir, name)
        with open(path, "w") as f:
            json.dump(out, f)
        print(f"  wrote {path}")


if __name__ == "__main__":
    main()
