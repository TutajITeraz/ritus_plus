"""Tests for the n-gram matcher used by "Full Automatic Lookup and Split".

Covers the normalization and n-gram primitives, the interval-scheduling
selection, and an end-to-end split over a synthetic stream. The heavier
accuracy benchmark against Wr_Univ_I_F_366 lives in
tests/benchmark_split_methods.py, which is not run as part of the unit suite.
"""
import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SRV = os.path.dirname(HERE)
sys.path.insert(0, SRV)


class _Skipped(unittest.SkipTest):
    """Raised by a test that needs a data file the repository does not ship
    (formulas.csv is supplied separately - see the README). pytest reports it
    as a skip; the standalone runner below prints it as one."""

import ngram_matcher as NM  # noqa: E402


# --- normalization ---------------------------------------------------------

def test_normalize_token_folds_medieval_latin_orthography():
    # j/i, v/u and ae/oe are scribal variants, not different words
    assert NM.normalize_token("Jesu") == NM.normalize_token("Iesu")
    assert NM.normalize_token("vivas") == NM.normalize_token("uiuas")
    assert NM.normalize_token("caelorum") == NM.normalize_token("celorum")
    assert NM.normalize_token("poena") == NM.normalize_token("pena")


def test_normalize_token_strips_accents_punctuation_and_digits():
    assert NM.normalize_token("Dómine,") == "domine"
    assert NM.normalize_token("(...)") == ""
    assert NM.normalize_token("123") == ""


def test_normalize_text_drops_empty_tokens():
    assert NM.normalize_text("Oremus. 123 Flectamus genua!") == "oremus flectamus genua"


# --- n-grams ---------------------------------------------------------------

def test_make_ngrams_basic():
    assert NM.make_ngrams(["a", "b", "c", "d"], 3) == ["a b c", "b c d"]


def test_short_text_falls_back_to_whole_phrase():
    # Short incipits must still be indexable, not silently produce zero grams
    assert NM.make_ngrams(["laudate", "dominum"], 3) == ["laudate dominum"]
    assert NM.make_ngrams([], 3) == []


# --- index -----------------------------------------------------------------

def test_build_formula_index_maps_grams_to_ids():
    phrases = {"1": "Dominus vobiscum et cum spiritu tuo", "2": "Oremus flectamus genua"}
    index, meta = NM.build_formula_index(phrases, n=3)
    assert "1" in index["dominus uobiscum et"]
    assert meta["1"]["n_tokens"] == 6
    # short phrase indexed under its whole normalized form
    assert "2" in index["oremus flectamus genua"]


# --- interval scheduling ---------------------------------------------------

def test_select_best_spans_picks_non_overlapping_max_weight():
    spans = [
        {"start_tok": 0, "end_tok": 10, "weight": 5.0},
        {"start_tok": 5, "end_tok": 15, "weight": 4.0},   # overlaps both
        {"start_tok": 10, "end_tok": 20, "weight": 6.0},
    ]
    chosen = NM.select_best_spans(spans)
    assert [(s["start_tok"], s["end_tok"]) for s in chosen] == [(0, 10), (10, 20)]


def test_select_best_spans_prefers_one_heavy_over_two_light():
    spans = [
        {"start_tok": 0, "end_tok": 5, "weight": 1.0},
        {"start_tok": 6, "end_tok": 10, "weight": 1.0},
        {"start_tok": 0, "end_tok": 10, "weight": 50.0},
    ]
    chosen = NM.select_best_spans(spans)
    assert [(s["start_tok"], s["end_tok"]) for s in chosen] == [(0, 10)]


def test_select_best_spans_empty():
    assert NM.select_best_spans([]) == []


def test_dedupe_spans_keeps_heaviest_per_interval():
    spans = [
        {"start_tok": 0, "end_tok": 4, "weight": 1.0, "phrase_id": "a"},
        {"start_tok": 0, "end_tok": 4, "weight": 9.0, "phrase_id": "b"},
    ]
    out = NM._dedupe_spans(spans)
    assert len(out) == 1 and out[0]["phrase_id"] == "b"


# --- identification re-rank ------------------------------------------------

def test_rerank_prefers_the_candidate_matching_the_whole_span():
    """partial_ratio scores a short sub-phrase 100 inside a longer prayer, so the
    DP can pick it. With boundaries fixed, full-text similarity must prefer the
    candidate that accounts for the WHOLE span."""
    long_text = "exorcizo te creatura salis per deum uiuum per deum uerum et per deum sanctum"
    phrases = {"short": "per deum uiuum", "long": long_text}
    _, meta = NM.build_formula_index(phrases, n=2)
    tokens = _tokens_from(long_text)
    stream = NM._tokenize_stream(tokens)
    end = len(tokens)

    # the DP picked the short formula for a span covering the whole text
    selected = [{"start_tok": 0, "end_tok": end, "phrase_id": "short"}]
    verified = [
        {"start_tok": 0, "end_tok": end, "phrase_id": "short"},
        {"start_tok": 0, "end_tok": end, "phrase_id": "long"},
    ]
    NM.rerank_identifications(stream, selected, verified, meta)
    assert selected[0]["phrase_id"] == "long"
    # boundaries must be untouched
    assert selected[0]["start_tok"] == 0 and selected[0]["end_tok"] == end


def test_rerank_ignores_candidates_that_barely_overlap():
    text = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu"
    phrases = {"a": "alpha beta gamma delta", "z": "lambda mu"}
    _, meta = NM.build_formula_index(phrases, n=2)
    tokens = _tokens_from(text)
    stream = NM._tokenize_stream(tokens)

    selected = [{"start_tok": 0, "end_tok": 4, "phrase_id": "a"}]
    verified = [
        {"start_tok": 0, "end_tok": 4, "phrase_id": "a"},
        {"start_tok": 10, "end_tok": 12, "phrase_id": "z"},  # disjoint
    ]
    NM.rerank_identifications(stream, selected, verified, meta)
    assert selected[0]["phrase_id"] == "a"


def test_rerank_handles_empty_inputs():
    _, meta = NM.build_formula_index({"a": "alpha beta"}, n=2)
    stream = NM._tokenize_stream(_tokens_from("alpha beta"))
    assert NM.rerank_identifications(stream, [], [], meta) == []


def test_split_and_match_records_the_rerank_stage():
    phrases = {"10": FORMULA_A, "20": FORMULA_B}
    tokens = _tokens_from(f"{FORMULA_A} {FORMULA_B}")
    _, timing = NM.split_and_match(tokens, phrases, similarity_threshold=75)
    assert "rerank" in timing


# --- defaults --------------------------------------------------------------

def test_defaults_are_the_benchmarked_ones():
    """These three were tuned together against tests/benchmark_split_methods.py
    so the n-gram matcher beats the legacy algorithm on boundary precision,
    boundary recall AND formula_id agreement. Changing one alone will regress at
    least one of them - re-run the benchmark if you do."""
    assert NM.DEFAULT_NGRAM_SIZE == 2
    assert NM.DEFAULT_MAX_GAP == 2
    assert NM.DEFAULT_MIN_COVERAGE == 0.1


# --- end to end ------------------------------------------------------------

def _tokens_from(text, content_data=None):
    """Build the token list shape batch_analysis.build_text_tokens produces."""
    content_data = content_data or {"where_in_ms_from": "1r", "where_in_ms_to": "1r"}
    return [
        {
            "page_name": "1r",
            "original_word": w,
            "word_number": str(i + 1),
            "corcordance_id": None,
            "content_data": dict(content_data),
        }
        for i, w in enumerate(text.split())
    ]


FORMULA_A = ("Exorcizo te creatura salis per Deum vivum per Deum verum "
             "et per Deum sanctum qui te in salutem credentium esse iussit")
FORMULA_B = ("Immensam clementiam tuam omnipotens aeterne Deus humiliter imploramus "
             "ut hanc creaturam salis benedicere et sanctificare digneris")


def test_split_and_match_finds_both_formulas_and_the_gap():
    phrases = {"10": FORMULA_A, "20": FORMULA_B}
    filler = "hic sequitur aliud quiddam prorsus ignotum nulli formulae simile omnino"
    stream = f"{FORMULA_A} {filler} {FORMULA_B}"
    tokens = _tokens_from(stream)

    results, timing = NM.split_and_match(tokens, phrases, similarity_threshold=75, n=3)

    ids = [r["best_phrase_id"] for r in results]
    assert "10" in ids and "20" in ids
    # the filler between them must come back as an unmatched, flagged segment
    unmatched = [r for r in results if not r["best_phrase_id"]]
    assert unmatched, "expected the non-matching filler to be emitted"
    assert all(r["check_again"] == "1" for r in unmatched)
    assert all(r["check_again"] == "0" for r in results if r["best_phrase_id"])
    assert timing["total"] >= 0


def test_split_and_match_covers_every_token_in_order():
    """reassign_data walks results and tokens in lockstep, so the emitted
    segments must reproduce the stream's words in order with none lost."""
    phrases = {"10": FORMULA_A, "20": FORMULA_B}
    stream = f"aliquid ante {FORMULA_A} interponitur {FORMULA_B} et post"
    tokens = _tokens_from(stream)

    results, _ = NM.split_and_match(tokens, phrases, similarity_threshold=75, n=3)

    emitted = " ".join(r["original_text"] for r in results).split()
    assert emitted == stream.split()


def test_split_and_match_tolerates_scribal_variation():
    """The whole point of verifying candidates with rapidfuzz: a span with
    altered spelling and word order must still be found."""
    phrases = {"10": FORMULA_A}
    garbled = ("Exorciso te creatura salis per Deum uiuum per Deum uerum "
               "et per Deum sanctum qui te in salutem credencium iussit esse")
    tokens = _tokens_from(garbled)

    results, _ = NM.split_and_match(tokens, phrases, similarity_threshold=75, n=3)
    assert any(r["best_phrase_id"] == "10" for r in results)


def test_split_and_match_rejects_unrelated_text():
    phrases = {"10": FORMULA_A}
    tokens = _tokens_from("nihil hic simile est nec ullo modo congruit cum formula ulla")

    results, _ = NM.split_and_match(tokens, phrases, similarity_threshold=75, n=3)
    assert all(not r["best_phrase_id"] for r in results)


def test_split_and_match_handles_empty_input():
    results, _ = NM.split_and_match([], {"10": FORMULA_A}, similarity_threshold=75)
    assert results == []


def test_higher_threshold_is_stricter():
    phrases = {"10": FORMULA_A}
    garbled = ("Exorciso te creatura salis per Deum uiuum per aliud quiddam "
               "omnino diuersum atque alienum a formula")
    tokens = _tokens_from(garbled)
    lenient, _ = NM.split_and_match(tokens, phrases, similarity_threshold=60, n=3)
    strict, _ = NM.split_and_match(tokens, phrases, similarity_threshold=99, n=3)
    n_lenient = sum(1 for r in lenient if r["best_phrase_id"])
    n_strict = sum(1 for r in strict if r["best_phrase_id"])
    assert n_strict <= n_lenient


# --- integration with the existing pipeline --------------------------------

def _stub_models():
    """batch_analysis imports a live SQLAlchemy session at module level; stub it
    so the pure pipeline functions can be exercised without a database."""
    import types

    stub = types.ModuleType("models")

    class _Session:
        def commit(self):
            pass

        def refresh(self, obj):
            # is_cancelled() re-reads the run's status before deciding; with no
            # database here the object is already current.
            pass

        def rollback(self):
            pass

    stub.db = types.SimpleNamespace(session=_Session())
    stub.Content = object
    stub.BatchProcessing = object
    sys.modules.setdefault("models", stub)


def test_results_are_consumable_by_reassign_data():
    """The n-gram matcher's output feeds batch_analysis.reassign_data unchanged;
    this guards that contract."""
    _stub_models()
    import batch_analysis

    phrases = {"10": FORMULA_A, "20": FORMULA_B}
    stream = f"{FORMULA_A} quaedam interposita verba {FORMULA_B}"
    tokens = _tokens_from(stream)
    results, _ = NM.split_and_match(tokens, phrases, similarity_threshold=75, n=3)

    reassigned = batch_analysis.reassign_data(results, tokens)
    assert len(reassigned) == len(results)
    for r in reassigned:
        assert "where_in_ms_from" in r["content_data"]
        assert "where_in_ms_to" in r["content_data"]


def test_batch_analysis_exposes_both_methods():
    _stub_models()
    import batch_analysis

    assert batch_analysis.METHOD_NGRAM == "ngram"
    assert batch_analysis.METHOD_LEGACY == "legacy"
    # the n-gram matcher is the default for new runs
    assert batch_analysis.DEFAULT_METHOD == batch_analysis.METHOD_NGRAM


# --- batch status polling --------------------------------------------------
# is_cancelled() decides whether a run that is already tens of minutes in should
# be thrown away, so what it does when the database is momentarily unavailable
# matters as much as what it does on a real cancel.

class _Row:
    def __init__(self, status="running"):
        self.status = status


class _Session:
    """db.session stand-in. `raises` is raised by refresh(); `becomes` is the
    status refresh() finds on the row, as another session would have left it."""

    def __init__(self, raises=None, becomes=None):
        self.raises = raises
        self.becomes = becomes
        self.rolled_back = False

    def commit(self):
        pass

    def rollback(self):
        self.rolled_back = True

    def refresh(self, obj):
        if self.raises is not None:
            raise self.raises
        if self.becomes is not None:
            obj.status = self.becomes


def _is_cancelled_with(session, row):
    _stub_models()
    import batch_analysis

    original = batch_analysis.db.session
    batch_analysis.db.session = session
    try:
        return batch_analysis.is_cancelled(row)
    finally:
        batch_analysis.db.session = original


def test_is_cancelled_false_while_the_run_is_still_running():
    assert _is_cancelled_with(_Session(), _Row("running")) is False


def test_is_cancelled_true_once_another_session_flips_the_status():
    assert _is_cancelled_with(_Session(becomes="cancelled"), _Row("running")) is True


def test_is_cancelled_true_when_the_row_was_deleted():
    from sqlalchemy.orm.exc import ObjectDeletedError

    session = _Session(raises=ObjectDeletedError.__new__(ObjectDeletedError))
    assert _is_cancelled_with(session, _Row("running")) is True


def test_a_transient_database_error_does_not_abort_the_run():
    """A locked database says nothing about whether the user pressed Cancel.
    Treating it as a cancel silently discarded runs tens of minutes long."""
    from sqlalchemy.exc import OperationalError

    session = _Session(raises=OperationalError("SELECT 1", {}, Exception("database is locked")))
    assert _is_cancelled_with(session, _Row("running")) is False
    assert session.rolled_back, "the failed refresh must leave the session usable"


def test_is_cancelled_ignores_a_missing_batch_process():
    _stub_models()
    import batch_analysis

    assert batch_analysis.is_cancelled(None) is False


# --- page ranges through merges and splits ---------------------------------

def _rows_to_tokens(rows):
    """Mirror build_text_tokens: one token per whitespace-separated word,
    carrying its source row's page range."""
    tokens = []
    for page_from, page_to, text in rows:
        content = {"where_in_ms_from": page_from, "where_in_ms_to": page_to}
        for word in text.split():
            tokens.append({
                "page_name": page_from,
                "page_name_to": page_to,
                "original_word": word,
                "word_number": str(len(tokens) + 1),
                "corcordance_id": None,
                "content_data": dict(content),
            })
    return tokens


def _segments(tokens, cuts):
    """Cut the token stream at the given indices, the way a splitter would."""
    out, prev = [], 0
    for cut in list(cuts) + [len(tokens)]:
        chunk = tokens[prev:cut]
        prev = cut
        if not chunk:
            continue
        out.append({
            "original_text": " ".join(t["original_word"] for t in chunk),
            "best_phrase_id": "",
            "best_phrase_text": "",
            "similarity_percentage": 0,
            "content_data": dict(chunk[0]["content_data"]),
            "check_again": "1",
        })
    return out


# Punctuation-only tokens are the ones that used to be dropped from the walk.
PAGE_ROWS = [
    ("1r", "1r", "primum . uerbum sequens"),
    ("2r", "2r", "alterum , textus ; hic"),
    ("3r", "3r", "tertium uerbum"),
    ("4r", "4r", ". quartum uerbum aliud"),
    ("5r", "5r", "quintum . ultimum"),
]


def test_page_range_survives_merging_and_splitting_rows():
    """Every segment must report the folios of the tokens it actually covers,
    whether it merged several source rows or is one piece of a single row."""
    _stub_models()
    import batch_analysis

    tokens = _rows_to_tokens(PAGE_ROWS)
    # cuts that both merge rows (a segment crossing a row boundary) and split
    # them (several segments inside one row)
    results = _segments(tokens, [2, 5, 9, 11, 14])
    reassigned = batch_analysis.reassign_data(results, tokens)

    w = 0
    for seg in reassigned:
        span = tokens[w:w + len(seg["original_text"].split())]
        w += len(span)
        assert seg["content_data"]["where_in_ms_from"] == span[0]["page_name"], seg
        assert seg["content_data"]["where_in_ms_to"] == span[-1]["page_name_to"], seg


def test_punctuation_only_tokens_do_not_shift_the_page_walk():
    """reassign_data used to count a segment's words with a \\W+ split, which
    drops "." and ";" - the walk then ran ahead of the token stream and later
    segments were labelled with the wrong folio."""
    _stub_models()
    import batch_analysis

    tokens = _rows_to_tokens(PAGE_ROWS)
    # one segment per source row: each must come back on its own folio
    cuts, n = [], 0
    for _, _, text in PAGE_ROWS[:-1]:
        n += len(text.split())
        cuts.append(n)
    reassigned = batch_analysis.reassign_data(_segments(tokens, cuts), tokens)

    pages = [(r["content_data"]["where_in_ms_from"], r["content_data"]["where_in_ms_to"])
             for r in reassigned]
    assert pages == [("1r", "1r"), ("2r", "2r"), ("3r", "3r"), ("4r", "4r"), ("5r", "5r")]


def test_a_source_row_spanning_several_folios_keeps_both_ends():
    """One row covering 1r-188r (a whole manuscript pasted into a single row)
    must not have its pieces all attributed to 1r."""
    _stub_models()
    import batch_analysis

    tokens = _rows_to_tokens([("1r", "188r", "alpha beta gamma delta epsilon")])
    reassigned = batch_analysis.reassign_data(_segments(tokens, [2, 4]), tokens)

    assert len(reassigned) == 3
    for seg in reassigned:
        assert seg["content_data"]["where_in_ms_from"] == "1r"
        assert seg["content_data"]["where_in_ms_to"] == "188r"


# --- Test1: fragmented rows must merge back into whole formulas -------------
# tests/Test1_split_test.csv is one manuscript whose three prayers have been
# chopped into 12 rows at arbitrary points (mid-sentence, mid-phrase, and in one
# case two prayers share a row). tests/Test1_perfect_result.csv is the answer:
# the same three prayers, whole, each carrying its formula_id. This is the
# smallest end-to-end case for what the split is actually for - putting a
# fragmented transcription back together - and it runs in under a second.
#
# The legacy algorithm gets 5 segments out of this instead of 3: it splits "vd"
# off as a 2-character row of its own, loses formula 3613 entirely and invents
# 35157. The n-gram matcher reproduces the expected file exactly.

TEST1_SPLIT = os.path.join(HERE, "Test1_split_test.csv")
TEST1_PERFECT = os.path.join(HERE, "Test1_perfect_result.csv")
FORMULAS_CSV = os.path.join(SRV, "static", "data", "formulas.csv")


def _require_test1():
    for path in (TEST1_SPLIT, TEST1_PERFECT, FORMULAS_CSV):
        if not os.path.exists(path):
            raise _Skipped(f"missing {os.path.relpath(path, SRV)}")
    try:
        import pandas  # noqa: F401
    except ImportError:
        raise _Skipped("pandas is not installed")


def _run_test1():
    """Split Test1_split_test.csv with the n-gram matcher, through the same
    pipeline batch_process_project uses."""
    import json

    import pandas as pd

    _stub_models()
    import batch_analysis as BA

    class _Progress:
        status = "running"
        progress = 0
        total_rows = 0
        processed_rows = 0

    class _Row:
        def __init__(self, rid, data):
            self.id, self.data = rid, data

    source = pd.read_csv(TEST1_SPLIT, dtype=str).fillna("")
    rows = [_Row(i + 1, json.dumps(r.to_dict())) for i, r in source.iterrows()]
    tokens = BA.build_text_tokens(rows, _Progress())
    phrases = BA.load_phrases(FORMULAS_CSV)
    results, _ = NM.split_and_match(tokens, phrases, similarity_threshold=75)
    return BA.reassign_data(results, tokens), pd.read_csv(TEST1_PERFECT, dtype=str).fillna("")


def _collapse(text):
    return re.sub(r"\s+", " ", text).strip()


def test_test1_fragmented_rows_merge_into_the_expected_formulas():
    _require_test1()
    results, expected = _run_test1()
    assert len(results) == len(expected), (
        f"expected {len(expected)} merged formulas, got {len(results)}")
    assert [r["best_phrase_id"] for r in results] == expected["formula_id"].tolist()


def test_test1_merged_text_matches_the_expected_file_exactly():
    _require_test1()
    results, expected = _run_test1()
    for i, result in enumerate(results):
        assert _collapse(result["original_text"]) == _collapse(
            expected["formula_text_from_ms"].iloc[i]), f"segment {i} text differs"


def test_test1_merged_rows_keep_the_folio_range_they_cover():
    """Rows 0-3 all sit on 1r, so the prayer they form must stay on 1r; the
    later prayers merge rows that run from 1r to 3r and must span that."""
    _require_test1()
    results, _ = _run_test1()
    ranges = [(r["content_data"].get("where_in_ms_from"),
               r["content_data"].get("where_in_ms_to")) for r in results]
    assert ranges[0] == ("1r", "1r"), ranges
    for first, last in ranges:
        assert first and last, ranges


# --- cancellation ----------------------------------------------------------

def test_split_and_match_stops_when_should_cancel_fires():
    """'Cancel Process' has to reach inside the matcher: on a real manuscript
    the candidate/verify sweeps are most of the run."""
    phrases = {"10": FORMULA_A, "20": FORMULA_B}
    tokens = _tokens_from(f"{FORMULA_A} et deinde {FORMULA_B}")

    results, timing = NM.split_and_match(
        tokens, phrases, similarity_threshold=75, n=3,
        should_cancel=lambda: True,
    )

    # None, not [], so the caller can tell a cancel from "nothing matched"
    assert results is None
    assert "index" in timing


def test_split_and_match_ignores_a_should_cancel_that_never_fires():
    phrases = {"10": FORMULA_A}
    tokens = _tokens_from(FORMULA_A)

    results, _ = NM.split_and_match(
        tokens, phrases, similarity_threshold=75, n=3,
        should_cancel=lambda: False,
    )

    assert results is not None
    assert any(r["best_phrase_id"] == "10" for r in results)


def test_candidate_and_verify_sweeps_return_none_when_cancelled():
    phrases = {"10": FORMULA_A}
    index, meta = NM.build_formula_index(phrases, 3)
    stream = NM._tokenize_stream(_tokens_from(FORMULA_A))

    assert NM.find_candidate_spans(
        stream, index, meta, 3, NM.DEFAULT_MIN_COVERAGE, NM.DEFAULT_MAX_GAP,
        should_cancel=lambda: True,
    ) is None

    spans = NM.find_candidate_spans(
        stream, index, meta, 3, NM.DEFAULT_MIN_COVERAGE, NM.DEFAULT_MAX_GAP,
    )
    assert spans
    assert NM.verify_spans(stream, spans, meta, 75, should_cancel=lambda: True) is None


def _run_standalone():
    """Minimal runner so the suite works without pytest installed."""
    tests = sorted(
        (name, fn) for name, fn in globals().items()
        if name.startswith("test_") and callable(fn)
    )
    failed = []
    skipped = []
    for name, fn in tests:
        try:
            fn()
        except _Skipped as e:
            skipped.append(name)
            print(f"skip {name}: {e}")
        except Exception as e:  # noqa: BLE001
            failed.append((name, e))
            print(f"FAIL {name}: {type(e).__name__}: {e}")
        else:
            print(f"ok   {name}")
    passed = len(tests) - len(failed) - len(skipped)
    print(f"\n{passed}/{len(tests) - len(skipped)} passed"
          + (f" ({len(skipped)} skipped)" if skipped else ""))
    return 1 if failed else 0


if __name__ == "__main__":
    try:
        import pytest
    except ImportError:
        sys.exit(_run_standalone())
    sys.exit(pytest.main([__file__, "-v"]))
