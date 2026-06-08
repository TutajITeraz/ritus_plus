"""AI Autofix tool backed by a local Ollama instance.

This module is a drop-in replacement for the previous OpenAI Assistants
implementation (kept at `ai_tools_openai.py`). The public function
`gpt_autofix(question, user_api_key, cache)` keeps the same signature and
returns the same `{'text': ..., 'error': ...}` dict so callers in
`krakenServer.py` do not need to change.

`user_api_key` and `cache` are accepted for backwards compatibility but are
no longer used (Ollama runs locally).
"""

import json
import os
import time
import urllib.error
import urllib.request

from prompt_template import SYSTEM_PROMPT

OLLAMA_CHAT_URL = "http://127.0.0.1:11434/api/chat"
OLLAMA_TAGS_URL = "http://127.0.0.1:11434/api/tags"

# Production default; override locally via config.py (OLLAMA_MODEL) or env OLLAMA_MODEL.
_PRODUCTION_DEFAULT_MODEL = "gemma4:12b-it-qat" # "gemma4:26b"


def get_ollama_model():
    """Resolve Ollama model: config.py > OLLAMA_MODEL env > domain_config.json > default."""
    try:
        import config

        model = getattr(config, "OLLAMA_MODEL", None)
        if model:
            return str(model).strip()
    except ImportError:
        pass

    env_model = os.environ.get("OLLAMA_MODEL", "").strip()
    if env_model:
        return env_model

    config_path = os.path.join(os.path.dirname(__file__), "domain_config.json")
    if os.path.exists(config_path):
        try:
            with open(config_path, encoding="utf-8") as f:
                model = json.load(f).get("ollama_model", "").strip()
            if model:
                return model
        except (json.JSONDecodeError, OSError):
            pass

    return _PRODUCTION_DEFAULT_MODEL


DEFAULT_MODEL = get_ollama_model()
DEFAULT_TEMPERATURE = 0.08
DEFAULT_TIMEOUT = 600  # seconds, hard cap on a single request
THINK_MODE = False     # no-think: disable Qwen/DeepSeek-style reasoning tokens


def get_ollama_models():
    """Return the list of model names installed in the local Ollama instance."""
    try:
        req = urllib.request.Request(OLLAMA_TAGS_URL)
        with urllib.request.urlopen(req, timeout=10) as response:
            data = json.loads(response.read().decode("utf-8"))
        return [m.get("name", "") for m in data.get("models", []) if m.get("name")]
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as e:
        print(f"Cannot connect to Ollama: {e}")
        return []


def _run_ollama_chat(
    model,
    ocr_text,
    system_prompt,
    temperature=DEFAULT_TEMPERATURE,
    timeout=DEFAULT_TIMEOUT,
    think=THINK_MODE,
):
    """Call Ollama /api/chat with streaming enabled.

    Returns a dict with keys:
        predicted, thinking_text, thinking_time, response_time, total_time,
        tokens_generated, tokens_per_sec, has_thinking.
    """
    request_body = {
        "model": model,
        "stream": True,
        "options": {
            "temperature": temperature,
            "repeat_penalty": 1.12,
            "top_p": 0.92,
        },
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": ocr_text.strip()},
        ],
    }
    # Only attach "think" when we want to force a value; for no-think models
    # we explicitly set it to False so the server does not engage thinking.
    request_body["think"] = bool(think)

    payload = json.dumps(request_body).encode("utf-8")
    req = urllib.request.Request(
        OLLAMA_CHAT_URL,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    collected_response = []
    collected_thinking = []
    t_start = time.time()
    t_first_response = None
    t_thinking_end = None
    is_thinking = False
    has_thinking = False
    eval_count = 0
    eval_duration_ns = 0
    t_last_activity = time.time()

    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            for line in response:
                now = time.time()
                if now - t_start > timeout:
                    print(f"   HARD TIMEOUT reached ({timeout}s) - truncating response")
                    break
                if now - t_last_activity > 60:
                    print(f"   STALL DETECTED (no data for 60s) - aborting sample")
                    break
                if not line.strip():
                    continue
                t_last_activity = now

                try:
                    chunk = json.loads(line.decode("utf-8"))
                except json.JSONDecodeError:
                    continue

                msg = chunk.get("message", {}) or {}

                if msg.get("thinking"):
                    has_thinking = True
                    is_thinking = True
                    token = msg.get("content", "")
                    if token:
                        collected_thinking.append(token)
                else:
                    if is_thinking:
                        # Transition from thinking -> response
                        is_thinking = False
                        t_thinking_end = now
                    token = msg.get("content", "")
                    if token:
                        if t_first_response is None:
                            t_first_response = now
                        collected_response.append(token)

                if chunk.get("done", False):
                    eval_count = chunk.get("eval_count", 0) or 0
                    eval_duration_ns = chunk.get("eval_duration", 0) or 0
                    break

    except (urllib.error.URLError, TimeoutError, OSError) as e:
        return {
            "predicted": f"[ERROR: {e}]",
            "thinking_text": "",
            "thinking_time": 0,
            "response_time": 0,
            "total_time": 0,
            "tokens_generated": 0,
            "tokens_per_sec": 0,
            "has_thinking": False,
        }

    t_end = time.time()
    total_time = t_end - t_start

    if has_thinking and t_thinking_end:
        thinking_time = t_thinking_end - t_start
        response_time = t_end - t_thinking_end
    elif t_first_response:
        # Without thinking: t_first_response marks end of prompt processing
        thinking_time = t_first_response - t_start
        response_time = t_end - t_first_response
    else:
        thinking_time = 0
        response_time = total_time

    tokens_per_sec = (eval_count / (eval_duration_ns / 1e9)) if eval_duration_ns > 0 else 0

    return {
        "predicted": "".join(collected_response).strip(),
        "thinking_text": "".join(collected_thinking).strip(),
        "thinking_time": thinking_time,
        "response_time": response_time,
        "total_time": total_time,
        "tokens_generated": eval_count,
        "tokens_per_sec": round(tokens_per_sec, 1),
        "has_thinking": has_thinking,
    }


def gpt_autofix(question, user_api_key=None, cache=None):
    """Correct OCR text using a local Ollama model.

    Backwards-compatible signature with the previous OpenAI-based
    implementation. `user_api_key` and `cache` are accepted but ignored.

    Returns:
        dict: {"text": str, "error": str}
    """
    response = {"text": "", "error": ""}

    if not question or not question.strip():
        response["error"] = "Empty question"
        return response

    # Best-effort: warn early if Ollama is not reachable.
    try:
        urllib.request.urlopen(OLLAMA_TAGS_URL, timeout=5).read()
    except Exception as e:
        response["error"] = f"Ollama is not reachable at {OLLAMA_TAGS_URL}: {e}"
        print(f"Error in gpt_autofix: {response['error']}")
        return response

    model = get_ollama_model()

    try:
        result = _run_ollama_chat(
            model=model,
            ocr_text=question,
            system_prompt=SYSTEM_PROMPT,
            temperature=DEFAULT_TEMPERATURE,
            timeout=DEFAULT_TIMEOUT,
            think=THINK_MODE,
        )
        predicted = result.get("predicted", "")
        if predicted.startswith("[ERROR:"):
            response["error"] = predicted
            print(f"Error in gpt_autofix: {response['error']}")
            return response

        response["text"] = predicted
        # Surface a few timing details to the server logs.
        print(
            "Ollama autofix: model={model} total={total:.2f}s "
            "tokens={tok} tps={tps} thinking={think}".format(
                model=model,
                total=result.get("total_time", 0),
                tok=result.get("tokens_generated", 0),
                tps=result.get("tokens_per_sec", 0),
                think=result.get("has_thinking", False),
            )
        )
        if result.get("has_thinking") and result.get("thinking_text"):
            print("--- thinking ---\n" + result["thinking_text"][:600])
    except Exception as e:
        response["error"] = str(e)
        print(f"Error in gpt_autofix: {response['error']}")

    return response


__all__ = ["gpt_autofix", "get_ollama_models", "get_ollama_model", "DEFAULT_MODEL"]
