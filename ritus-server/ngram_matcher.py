"""
n-gram matcher: segmentation + formula lookup for "Full Automatic Lookup and Split".

This is the alternative to the legacy algorithm in batch_analysis.py. Both solve
the same problem - one unbroken stream of manuscript text has to be cut into
individual formulas, and each piece identified against formulas.csv - but they
search in opposite directions.

THE LEGACY ALGORITHM works forward through the text: it takes a ~5.6k-character
fragment and asks rapidfuzz to compare it against every one of the 13,228
reference formulas, keeps the best alignment, cuts it out, and repeats on what is
left over - then re-runs the whole sweep up to 13 more times on the unmatched
remainder. Every fragment is therefore compared against the entire corpus, many
times over, which is where essentially all of its runtime goes.

THE N-GRAM MATCHER inverts the lookup. The corpus is indexed ONCE by word
n-grams, so instead of asking "which of 13,228 formulas does this text look
like?", it asks "which formulas share any wording with this text at all?" and
gets back a handful of candidates directly from the index. Only those candidates
are ever scored. Concretely:

  1. Tokenize the stream, keeping each token's character offsets, and normalize
     each token INDIVIDUALLY so the normalized token list stays position-aligned
     with the raw one (offsets must survive normalization to reconstruct exact
     excerpts).
  2. Build an inverted index over the reference corpus: n-gram -> formula ids.
  3. Sweep the stream's own n-grams through that index. Every hit says "formula F
     shares wording with the stream near position P".
  4. Cluster each formula's hits into contiguous runs (small gaps tolerated - one
     garbled word inside a genuine quote must not break the run). Each run is a
     candidate span: "formula F probably occurs roughly here".
  5. VERIFY each candidate with rapidfuzz. Exact n-gram overlap alone is brittle:
     it cannot see word-order variation ("sic a te interius mundentur" vs "ita a
     te mundentur interius"), and it fires spuriously on short common phrases.
     So each candidate region is re-aligned with partial_ratio_alignment, which
     yields both a real edit-distance-based similarity AND precise character
     boundaries. Candidates below the similarity threshold are dropped here.
     This step is what makes the n-gram stage safe to run at a permissive n:
     the index only has to SUGGEST regions, it does not have to be right.
  6. Candidate spans overlap heavily - near-duplicate formulas in the corpus
     (first-person-singular vs plural variants of the same prayer, for instance)
     compete for the same stretch of text. Weighted interval scheduling, the
     classic O(n log n) DP, picks the non-overlapping set of spans maximizing
     total weight across the whole stream. Weight is similarity x matched length,
     NOT raw n-gram count: scoring by raw count makes the choice between two
     near-duplicate formulas a coin flip decided by a one-gram margin, whereas
     length-weighted similarity prefers the candidate that explains more of the
     text and explains it better. The chosen boundaries ARE the split points.
  7. RE-RANK the identification of each chosen span. The DP's weight is the right
     objective for deciding WHERE a segment is, but a poor one for deciding WHICH
     formula it is: partial_ratio is asymmetric, so a short sub-formula scores a
     perfect 100 sitting inside a long prayer, and among near-duplicate corpus
     entries the choice can turn on a hair. So once the boundaries are fixed,
     every candidate covering roughly the same span is reconsidered and scored by
     full-text similarity (fuzz.ratio is symmetric, so it penalises a candidate
     much shorter or longer than the span). Boundaries are untouched; only the
     formula_id can change. This is what lifts formula_id agreement from 81% to
     91% on Wr_Univ_I_F_366, and it runs over ~850 spans, so it costs nothing.
  8. Text between chosen spans is emitted as unmatched segments, flagged for
     review exactly as the legacy algorithm flags its own leftovers.

Results come back in the same shape batch_analysis builds, so reassign_data and
the Content-writing stage are shared unchanged between both methods.
"""

import bisect
import logging
import re
import time
import unicodedata
from collections import defaultdict

from rapidfuzz import fuzz

logger = logging.getLogger(__name__)

# Word n-gram size for candidate generation. Larger n is more specific and yields
# a shorter candidate list, but only survives on the more literal matches, so it
# finds fewer true boundaries. Since step 5 verifies every candidate with
# rapidfuzz, a loose suggestion here costs a little time, never accuracy - so the
# size is tuned for recall. n=2 is what makes this method beat the legacy
# algorithm on boundary recall as well as precision (see
# tests/benchmark_split_methods.py). passim's own n=10 default is unusable on
# this material: short incipits produce zero 10-grams and can never match.
DEFAULT_NGRAM_SIZE = 2

# Tokens allowed to be missing inside one candidate span before it is split in
# two. A garbled or unreadable word in the middle of a genuine quote should not
# end the run, but tolerating too much lets one run swallow a real boundary.
DEFAULT_MAX_GAP = 2

# A candidate must share at least this fraction of the reference formula's own
# n-grams before it is worth verifying. Purely a cost control on step 5.
DEFAULT_MIN_COVERAGE = 0.1

_TOKEN_RE = re.compile(r"\S+")
_KEEP_RE = re.compile(r"[^a-z]")


def normalize_token(token):
    """Per-token normalization for medieval Latin, position-preserving.

    Folds the purely orthographic variation (j/i, v/u, w/uu, ae/oe -> e, accents)
    that would otherwise make identical prayers look like different text. Returns
    "" for tokens that are pure punctuation or digits; callers keep those
    positions so raw/normalized token lists stay index-aligned.
    """
    if not token:
        return ""
    t = unicodedata.normalize("NFKD", token)
    t = "".join(c for c in t if not unicodedata.combining(c))
    t = t.lower()
    t = t.replace("j", "i").replace("v", "u").replace("w", "uu")
    t = t.replace("ae", "e").replace("oe", "e")
    return _KEEP_RE.sub("", t)


def normalize_text(text):
    """Whole-string normalization, used for reference formulas."""
    if not text:
        return ""
    return " ".join(t for t in (normalize_token(w) for w in text.split()) if t)


def make_ngrams(tokens, n):
    """Word n-grams; texts shorter than n tokens fall back to a single gram
    holding the whole phrase, so short incipits still get indexed."""
    if not tokens:
        return []
    if len(tokens) < n:
        return [" ".join(tokens)]
    return [" ".join(tokens[i:i + n]) for i in range(len(tokens) - n + 1)]


# How often the long sweeps ask whether the run has been cancelled. The check
# is a DB round-trip on the caller's side, so it cannot run per item; a few
# thousand tokens/spans is well under a second of work.
CANCEL_CHECK_INTERVAL = 2000


def build_formula_index(phrases, n=DEFAULT_NGRAM_SIZE):
    """Inverted index n-gram -> set of phrase ids, built once for the corpus.

    `phrases` is {phrase_id: text}, as load_phrases returns.
    Returns (index, meta) where meta[phrase_id] carries the normalized text,
    token count and n-gram count needed for scoring.
    """
    index = defaultdict(set)
    meta = {}
    for phrase_id, text in phrases.items():
        norm = normalize_text(str(text))
        tokens = norm.split() if norm else []
        grams = make_ngrams(tokens, n)
        meta[phrase_id] = {
            "norm": norm,
            "text": str(text),
            "n_tokens": len(tokens),
            "n_grams": max(1, len(grams)),
        }
        for gram in grams:
            index[gram].add(phrase_id)
    logger.info("n-gram index: %d grams over %d formulas (n=%d)", len(index), len(phrases), n)
    return index, meta


def _tokenize_stream(text_tokens):
    """Flatten the token list built by batch_analysis.build_text_tokens into one
    stream, keeping for each token its raw text, its normalized form, and its
    character offsets inside the reconstructed stream.

    The stream is rebuilt by joining the tokens with single spaces, which is
    exactly how build_text_tokens took them apart, so offsets stay meaningful.
    """
    raw_words = []
    norm_words = []
    raw_starts = []
    norm_starts = []
    raw_pos = 0
    norm_pos = 0
    for token in text_tokens:
        word = token.get("original_word", "") or ""
        norm = normalize_token(word)
        raw_starts.append(raw_pos)
        raw_words.append(word)
        raw_pos += len(word) + 1
        norm_starts.append(norm_pos)
        norm_words.append(norm)
        # Empty normalizations still occupy a position so the two lists stay
        # index-aligned; they simply contribute no characters plus one space.
        norm_pos += len(norm) + 1
    return {
        "raw_words": raw_words,
        "norm_words": norm_words,
        "raw_starts": raw_starts,
        "norm_starts": norm_starts,
        "norm_stream": " ".join(norm_words),
    }


def find_candidate_spans(stream, index, meta, n, min_coverage, max_gap,
                         should_cancel=None):
    """Steps 3-4: sweep the stream's n-grams through the index and cluster each
    formula's hits into contiguous candidate spans (token index, end exclusive).

    Returns None if `should_cancel` reports the run was cancelled mid-sweep."""
    norm_words = stream["norm_words"]
    total = len(norm_words)
    hits = defaultdict(list)

    # Positions holding an empty normalized token cannot start a gram.
    for i in range(0, total - n + 1):
        if (should_cancel is not None and i % CANCEL_CHECK_INTERVAL == 0
                and should_cancel()):
            return None
        window = norm_words[i:i + n]
        if not all(window):
            continue
        gram = " ".join(window)
        found = index.get(gram)
        if not found:
            continue
        for phrase_id in found:
            hits[phrase_id].append(i)

    spans = []
    for phrase_id, positions in hits.items():
        positions.sort()
        clusters = []
        current = [positions[0]]
        for p in positions[1:]:
            if p - current[-1] <= max_gap:
                current.append(p)
            else:
                clusters.append(current)
                current = [p]
        clusters.append(current)

        formula_grams = meta[phrase_id]["n_grams"]
        for cluster in clusters:
            shared = len(cluster)
            coverage = min(1.0, shared / formula_grams)
            if coverage < min_coverage:
                continue
            spans.append({
                "phrase_id": phrase_id,
                "start_tok": cluster[0],
                "end_tok": min(total, cluster[-1] + n),
                "shared": shared,
                "coverage": coverage,
            })
    return spans


def verify_spans(stream, spans, meta, similarity_threshold, should_cancel=None):
    """Step 5: re-align each candidate with rapidfuzz to get a real similarity
    and exact boundaries, dropping anything under the threshold.

    The search window is widened around the n-gram cluster to at least the length
    of the reference formula, because the cluster only covers the part that
    matched exactly - the formula's opening or closing words may have been
    garbled and produced no n-gram hit at all.

    Returns None if `should_cancel` reports the run was cancelled mid-pass.
    """
    norm_starts = stream["norm_starts"]
    norm_words = stream["norm_words"]
    norm_stream = stream["norm_stream"]
    total = len(norm_words)
    verified = []

    for idx, span in enumerate(spans):
        if (should_cancel is not None and idx % CANCEL_CHECK_INTERVAL == 0
                and should_cancel()):
            return None
        info = meta[span["phrase_id"]]
        formula_norm = info["norm"]
        if not formula_norm:
            continue
        pad = max(4, info["n_tokens"] // 2)
        lo_tok = max(0, span["start_tok"] - pad)
        hi_tok = min(total, span["end_tok"] + pad)
        win_start = norm_starts[lo_tok]
        win_end = (norm_starts[hi_tok - 1] + len(norm_words[hi_tok - 1])) if hi_tok > 0 else win_start
        window = norm_stream[win_start:win_end]
        if not window:
            continue

        try:
            alignment = fuzz.partial_ratio_alignment(
                window, formula_norm, score_cutoff=similarity_threshold
            )
        except Exception as e:  # pragma: no cover - defensive, matches legacy style
            logger.error("alignment failed for phrase %s: %s", span["phrase_id"], e)
            continue
        if not alignment or alignment.score < similarity_threshold:
            continue

        abs_start = win_start + alignment.src_start
        abs_end = win_start + alignment.src_end
        if abs_end <= abs_start:
            continue

        # Snap the character alignment back to whole-token boundaries.
        start_tok = bisect.bisect_right(norm_starts, abs_start) - 1
        start_tok = max(0, min(start_tok, total - 1))
        end_tok = bisect.bisect_left(norm_starts, abs_end)
        end_tok = max(start_tok + 1, min(end_tok, total))

        matched_len = abs_end - abs_start
        verified.append({
            "phrase_id": span["phrase_id"],
            "start_tok": start_tok,
            "end_tok": end_tok,
            "score": alignment.score,
            "shared": span["shared"],
            "coverage": span["coverage"],
            # Longer, better-scoring matches explain more of the stream. Raw
            # n-gram count would let a one-gram margin decide between two
            # near-duplicate formulas.
            "weight": (alignment.score / 100.0) * matched_len,
        })
    return verified


def _dedupe_spans(spans):
    """Keep only the best-weighted candidate per identical (start, end) pair, so
    near-duplicate formulas competing for the same stretch do not all enter the
    DP with nearly equal weight."""
    best = {}
    for span in spans:
        key = (span["start_tok"], span["end_tok"])
        current = best.get(key)
        if current is None or span["weight"] > current["weight"]:
            best[key] = span
    return list(best.values())


def select_best_spans(spans):
    """Step 6: weighted interval scheduling over token intervals [start, end).

    Picks the non-overlapping subset maximizing total weight - the chosen
    boundaries are the predicted split points.
    """
    if not spans:
        return []
    ordered = sorted(spans, key=lambda s: s["end_tok"])
    ends = [s["end_tok"] for s in ordered]
    count = len(ordered)

    # prev[i] = index of the last span ending at or before span i starts
    prev = []
    for i in range(count):
        prev.append(bisect.bisect_right(ends, ordered[i]["start_tok"]) - 1)

    dp = [0.0] * (count + 1)
    take = [False] * (count + 1)
    for i in range(1, count + 1):
        include = ordered[i - 1]["weight"] + (dp[prev[i - 1] + 1] if prev[i - 1] >= 0 else 0.0)
        exclude = dp[i - 1]
        if include > exclude:
            dp[i] = include
            take[i] = True
        else:
            dp[i] = exclude

    selected = []
    i = count
    while i > 0:
        if take[i]:
            selected.append(ordered[i - 1])
            i = prev[i - 1] + 1
        else:
            i -= 1
    selected.reverse()
    return selected


# A candidate must overlap the chosen span by at least this much (intersection
# over union) to be considered a competing identification for it.
RERANK_MIN_IOU = 0.5

# How far either side of a span to look for competing candidates, in tokens.
_RERANK_WINDOW = 60


def rerank_identifications(stream, selected, verified, meta, min_iou=RERANK_MIN_IOU):
    """Step 7: with boundaries fixed, re-decide which formula each span is.

    Mutates `selected` in place, changing only "phrase_id" (and recording the
    full-text score as "identity_score"). Span boundaries are never altered.
    """
    if not selected or not verified:
        return selected
    norm_starts = stream["norm_starts"]
    norm_words = stream["norm_words"]
    norm_stream = stream["norm_stream"]

    ordered = sorted(verified, key=lambda s: s["start_tok"])
    starts = [s["start_tok"] for s in ordered]

    for span in selected:
        a0, a1 = span["start_tok"], span["end_tok"]
        text = norm_stream[norm_starts[a0]:norm_starts[a1 - 1] + len(norm_words[a1 - 1])]
        if not text:
            continue
        # Only candidates starting near this span can overlap it enough to matter.
        lo = bisect.bisect_left(starts, a0 - _RERANK_WINDOW)
        hi = bisect.bisect_right(starts, a1 + _RERANK_WINDOW)
        best_id, best_score = span["phrase_id"], -1.0
        for cand in ordered[lo:hi]:
            b0, b1 = cand["start_tok"], cand["end_tok"]
            intersection = min(a1, b1) - max(a0, b0)
            if intersection <= 0:
                continue
            union = max(a1, b1) - min(a0, b0)
            if union and intersection / union < min_iou:
                continue
            score = fuzz.ratio(text, meta[cand["phrase_id"]]["norm"])
            if score > best_score:
                best_score, best_id = score, cand["phrase_id"]
        if best_score >= 0:
            span["phrase_id"] = best_id
            span["identity_score"] = best_score
    return selected


def _emit(results, tokens, lo, hi, phrase_id, phrase_text, score, content_data):
    """Build one result row in the shape batch_analysis.reassign_data expects."""
    words = [t.get("original_word", "") or "" for t in tokens[lo:hi]]
    text = " ".join(w for w in words if w)
    if not text.strip():
        return
    results.append({
        "original_text": text,
        "best_phrase_id": str(phrase_id) if phrase_id else "",
        "best_phrase_text": phrase_text or "",
        "similarity_percentage": score,
        "content_data": content_data.copy(),
        "check_again": "0" if phrase_id else "1",
    })


def split_and_match(text_tokens, phrases, similarity_threshold=75,
                    n=DEFAULT_NGRAM_SIZE, min_coverage=DEFAULT_MIN_COVERAGE,
                    max_gap=DEFAULT_MAX_GAP, batch_process=None,
                    progress_min=20, progress_max=90, index=None, meta=None,
                    should_cancel=None):
    """Segment the manuscript stream and identify each segment.

    `text_tokens` is the token list from batch_analysis.build_text_tokens;
    `phrases` is {phrase_id: text}. Returns results in batch_analysis's shape:
    matched segments interleaved with unmatched ones flagged check_again="1",
    covering the stream in order so reassign_data can walk both in lockstep.

    `should_cancel` is an optional callable polled between and inside the long
    phases; when it returns True the run stops early and (None, timing) is
    returned, so the caller can tell a cancellation from an empty result.
    """
    timing = {}
    t0 = time.perf_counter()

    if index is None or meta is None:
        index, meta = build_formula_index(phrases, n)
    timing["index"] = time.perf_counter() - t0

    if should_cancel is not None and should_cancel():
        return None, timing

    if batch_process is not None:
        batch_process.progress = progress_min + (progress_max - progress_min) * 0.15

    t = time.perf_counter()
    stream = _tokenize_stream(text_tokens)
    timing["tokenize"] = time.perf_counter() - t

    t = time.perf_counter()
    candidates = find_candidate_spans(stream, index, meta, n, min_coverage,
                                      max_gap, should_cancel=should_cancel)
    timing["candidates"] = time.perf_counter() - t
    if candidates is None:
        return None, timing
    logger.info("n-gram matcher: %d candidate spans", len(candidates))

    if batch_process is not None:
        batch_process.progress = progress_min + (progress_max - progress_min) * 0.45

    t = time.perf_counter()
    verified = verify_spans(stream, candidates, meta, similarity_threshold,
                            should_cancel=should_cancel)
    timing["verify"] = time.perf_counter() - t
    if verified is None:
        return None, timing
    logger.info("n-gram matcher: %d spans passed verification", len(verified))

    if batch_process is not None:
        batch_process.progress = progress_min + (progress_max - progress_min) * 0.8

    if should_cancel is not None and should_cancel():
        return None, timing

    t = time.perf_counter()
    selected = select_best_spans(_dedupe_spans(verified))
    timing["select"] = time.perf_counter() - t
    logger.info("n-gram matcher: %d spans selected", len(selected))

    t = time.perf_counter()
    rerank_identifications(stream, selected, verified, meta)
    timing["rerank"] = time.perf_counter() - t

    # --- emit results covering the whole stream, in order ---
    results = []
    total = len(text_tokens)
    default_content = text_tokens[0]["content_data"] if text_tokens else {}
    cursor = 0
    for span in selected:
        lo, hi = span["start_tok"], span["end_tok"]
        if lo > cursor:
            _emit(results, text_tokens, cursor, lo, "", "",
                  0, text_tokens[cursor]["content_data"])
        info = meta[span["phrase_id"]]
        _emit(results, text_tokens, lo, hi, span["phrase_id"], info["text"],
              span["score"], text_tokens[lo]["content_data"])
        cursor = hi
    if cursor < total:
        _emit(results, text_tokens, cursor, total, "", "", 0,
              text_tokens[cursor]["content_data"] if cursor < total else default_content)

    timing["total"] = time.perf_counter() - t0
    if batch_process is not None:
        batch_process.progress = progress_max
        batch_process.processed_rows = len(results)

    logger.info("n-gram matcher finished in %.1fs: %d segments (%d identified)",
                timing["total"], len(results),
                sum(1 for r in results if r["best_phrase_id"]))
    return results, timing
