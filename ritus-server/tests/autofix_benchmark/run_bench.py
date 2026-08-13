"""Run the AI autofix benchmark across prompt variants x find/replace on/off.

Writes results incrementally to results.json so progress survives interruption.
"""
import json
import os
import sys
import time
import urllib.request
import urllib.error

sys.path.insert(0, "/Users/lukasz/Developer/ritus_plus/ritus-server")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from bench_common import load_examples, score
from prompt_variants import VARIANTS
from transcription_autofix import apply_autofix

MODEL = "gemma4:e4b"
URL = "http://127.0.0.1:11434/api/chat"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "results.json")

# Same generation settings as ai_tools.py so the measurement reflects production.
OPTIONS = {"temperature": 0.08, "repeat_penalty": 1.12, "top_p": 0.92}


def call(system_prompt, ocr_text, timeout=900):
    body = {
        "model": MODEL,
        "stream": False,
        "think": False,
        "options": OPTIONS,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": ocr_text.strip()},
        ],
    }
    req = urllib.request.Request(
        URL, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}, method="POST"
    )
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = json.loads(r.read().decode())
    return {
        "text": (data.get("message") or {}).get("content", "").strip(),
        "seconds": round(time.time() - t0, 1),
        "prompt_tokens": data.get("prompt_eval_count", 0),
        "output_tokens": data.get("eval_count", 0),
    }


# (label, prompt variant, find/replace applied first?)
CONDITIONS = [
    ("A_current_noFR", "P0_current", False),   # today's production behaviour
    ("B_current_FR", "P0_current", True),
    ("C_context_FR", "P1_context", True),
    ("D_ctxfullfunc_FR", "P2_ctx_fullfunc", True),
    ("E_ctxshortfunc_FR", "P3_ctx_shortfunc", True),
]

examples = load_examples()
results = {}
if os.path.exists(OUT):
    results = json.load(open(OUT))

total = len(CONDITIONS) * len(examples)
done = 0
for label, variant, use_fr in CONDITIONS:
    for e in examples:
        key = f"{label}|ex{e['n']}"
        done += 1
        if key in results:
            print(f"[{done}/{total}] {key} (cached)", flush=True)
            continue
        src = apply_autofix(e["ocr"]) if use_fr else e["ocr"]
        print(f"[{done}/{total}] {key} running...", flush=True)
        try:
            r = call(VARIANTS[variant], src)
        except Exception as ex:
            print(f"   FAILED: {ex}", flush=True)
            continue
        s = score(e["ref"], r["text"])
        results[key] = {
            "label": label, "variant": variant, "find_replace": use_fr, "example": e["n"],
            "similarity": s["similarity"], "wer": s["wer"],
            "ref_words": s["ref_words"], "hyp_words": s["hyp_words"],
            "seconds": r["seconds"], "prompt_tokens": r["prompt_tokens"],
            "output_tokens": r["output_tokens"], "text": r["text"],
        }
        json.dump(results, open(OUT, "w"), indent=1)
        print(f"   sim={s['similarity']:.4f} wer={s['wer']:.4f} {r['seconds']}s "
              f"ptok={r['prompt_tokens']} otok={r['output_tokens']}", flush=True)

print("DONE", flush=True)
