# Autofix benchmark

Measures the two autofix layers against human-corrected pages:

1. **Mechanical find/replace** — `transcription_autofix.py` +
   `data/common_transcription_errors.tsv`.
2. **AI autofix** — `prompt_template.py` + a local Ollama model.

When each layer runs:

- **At transcription time** the two are separately switchable
  (`transcribe_image_by_id`), via two checkboxes present in all four
  transcription dialogs:
  - *"Automatically find and replace common mistakes"* — default **on**,
    runs layer 1 only.
  - *"Correct each page with AI"* — default **off**, runs layer 2, and always
    runs layer 1 first regardless of the other checkbox.
- **On the manual "AI Autofix" button** (`POST /api/ai-autofix`) both always
  run: the find/replace is applied to the submitted text before it goes to the
  model.

The find/replace is idempotent, so text that already went through it at
transcription time is unharmed by pressing the button again. In the
transcription path the AI step is best-effort (`ai_autofix_best_effort`): if
Ollama is down, times out, or returns nothing, the find/replace result is kept
rather than losing the page.

The conditions below measure the layers in isolation to justify the prompt
choice. "F/R ON" corresponds to both checkboxes on.

## Ground truth

`Transcription Tests.txt` in the repo root: 4 manuscript pages, each with the
raw Kraken OCR and a human correction. `bench_common.py` parses it. If you add
more examples, keep the `Example N` / `N. Original OCR` / `N. Fixed by human`
headings — the parser keys off them.

## Scripts

| script | needs Ollama | what it does |
|---|---|---|
| `audit_false_positives.py` | no | Fires every TSV rule at the **human-corrected** text. Any hit is a corruption by definition. **Run this after editing the TSV.** |
| `eval_findreplace.py` | no | Per-hit audit of find/replace on the OCR text, plus before/after scores. |
| `run_bench.py` | yes | 5 conditions x 4 examples. Writes `results.json` incrementally; re-running skips cached keys. ~12 min. |
| `analyze.py` | no | Summarises `results.json`. |
| `prompt_variants.py` | no | The candidate prompts. `P3` is what shipped. |

```sh
cd ritus-server
python3 tests/autofix_benchmark/audit_false_positives.py   # after any TSV edit
python3 tests/autofix_benchmark/run_bench.py               # then:
python3 tests/autofix_benchmark/analyze.py
```

## Metrics

- **sim** — word-level similarity to the human correction (higher better).
- **wer** — word error rate vs the human correction (lower better).
- **echo** — how much of the output is the input copied back. `1.000` means the
  model returned its input unchanged. This is the most useful diagnostic: the
  old prompt scored 0.972, i.e. it was very nearly a passthrough.

Both sides are normalised before comparison (lowercased, tags and punctuation
stripped, `j/i`, `u/v`, `ae/e`, `y/i` folded), because those variants are
spelling conventions rather than OCR errors and the human corrections are not
internally consistent about them. Consequence: the `j -> i` rule is invisible
to the score by construction, even though it is a real improvement.

## Results (gemma4:e4b, 2026-08-13)

| condition | sim | wer | echo | ptok |
|---|---|---|---|---|
| raw OCR | 0.5098 | 0.6121 | — | — |
| find/replace only | 0.5162 | 0.6062 | — | — |
| old prompt, F/R off | 0.5187 | 0.5934 | 0.972 | 502 |
| old prompt, F/R on | 0.5258 | 0.5882 | 0.967 | 503 |
| + context rules | 0.5144 | 0.6095 | 0.926 | 812 |
| + context + full 116 funcs | 0.5298 | 0.5851 | 0.928 | 1398 |
| **+ context + short funcs (shipped)** | **0.5363** | **0.5739** | 0.926 | 1021 |

n=4, so treat small gaps as directional. The shipped variant beats the old
behaviour on all four pages individually, which is the stronger claim.
