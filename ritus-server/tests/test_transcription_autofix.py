"""
Lightweight, dependency-free tests for transcription_autofix.py.

Run directly with plain python3:

    python3 tests/test_transcription_autofix.py

(or with pytest, from ritus-server/ or from inside tests/)
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from transcription_autofix import apply_autofix, get_rules


def test_full_word_mistake_replaced_only_standalone():
    # "colis" -> "collecta" is a full-word mistake: standalone occurrence is fixed...
    assert apply_autofix("Oremus colis Deum") == "Oremus collecta Deum"
    # ...but it must not touch "colis" when it's part of a longer word.
    assert apply_autofix("discolis") == "discolis"


def test_non_full_word_mistake_replaced_inside_words():
    # "j" -> "i" is not a full-word mistake: replace even mid-word.
    assert apply_autofix("adjutor meus") == "adiutor meus"


def test_leaves_unrelated_text_untouched():
    text = "Et in terra pax hominibus"
    assert apply_autofix(text) == text


def test_multiple_rules_apply_in_one_pass():
    # "Off." is itself the mistake (trailing period included), so it is
    # replaced wholesale by "Offertorium" - the period is not preserved.
    assert apply_autofix("Ps. Off. dees") == "Psalmus. Offertorium deus"


def test_empty_and_none_safe():
    assert apply_autofix("") == ""
    assert apply_autofix(None) is None


def test_markup_tags_are_never_rewritten():
    # Tags must survive verbatim, and text inside them is still corrected.
    text = "<red>Off.</red> dees <func>Ps</func>"
    assert apply_autofix(text) == "<red>Offertorium</red> deus <func>Psalmus</func>"


def test_replacement_output_is_not_re_matched():
    # Single-pass: "des" -> "deus" must not then be re-read by another rule,
    # and a replacement containing a substring-rule trigger stays intact.
    assert apply_autofix("des") == "deus"
    # "deliqu" -> "derelequ" (substring rule); the output must not cascade.
    assert apply_autofix("deliquit") == "derelequit"


def test_longest_mistake_wins_over_shorter_overlap():
    # "officialis" (full word) must beat nothing shorter that also matches.
    assert apply_autofix("officialis") == "Offertorium"


def test_contextual_mistakes_are_not_in_the_mechanical_ruleset():
    # These need surrounding-word judgement and belong to the AI prompt, not
    # to blind find/replace. Guard against them being pasted back into the TSV.
    mistakes = {r["mistake"] for r in get_rules()}
    for contextual in ("quas", "quam", "spem", "rel", "tius", "dies", "eria", "Pes"):
        assert contextual not in mistakes, f"{contextual!r} must stay out of the mechanical ruleset"


def test_no_circular_rules():
    # A rule whose replacement is another rule's mistake would flip-flop
    # depending on ordering (the sheet contained quaesumus <-> quesumus).
    rules = get_rules()
    mistakes = {r["mistake"] for r in rules}
    for r in rules:
        assert r["replacement"] not in mistakes, (
            f"circular rule: {r['mistake']!r} -> {r['replacement']!r} which is itself a mistake"
        )


if __name__ == "__main__":
    tests = [v for k, v in list(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print(f"OK: {t.__name__}")
    print(f"\n{len(tests)} tests passed.")
