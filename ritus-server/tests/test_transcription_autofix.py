"""
Lightweight, dependency-free tests for transcription_autofix.py.

Run directly with plain python3:

    python3 tests/test_transcription_autofix.py

(or with pytest, from ritus-server/ or from inside tests/)
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from transcription_autofix import apply_autofix


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


if __name__ == "__main__":
    tests = [v for k, v in list(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print(f"OK: {t.__name__}")
    print(f"\n{len(tests)} tests passed.")
