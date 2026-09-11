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
import logging
import os
import re
import time
import urllib.error
import urllib.request

from prompt_template import SYSTEM_PROMPT

# Uses the root logging config set up in krakenServer.py (console +
# logs/server.log). Do NOT use print() in this module - print() writes
# straight to stdout and bypasses that handler entirely, so it never shows
# up in server.log regardless of how the server process is launched.
logger = logging.getLogger(__name__)

# Some Ollama models (e.g. gemma) fall back to per-byte tokens for rare
# Unicode codepoints outside their vocabulary (ligatures like U+A753 "ꝓ").
# When streamed, each byte token can arrive as its own chunk before the full
# multi-byte sequence is complete, so llama.cpp emits it as a literal
# "<0xHH>" placeholder instead of the decoded character. Collapse runs of
# these placeholders back into the real UTF-8 character they represent.
_BYTE_FALLBACK_RUN_RE = re.compile(r"(?:<0x[0-9A-Fa-f]{2}>)+")
_BYTE_FALLBACK_TOKEN_RE = re.compile(r"<0x([0-9A-Fa-f]{2})>")


def _fix_byte_fallback_tokens(text):
    def _decode_run(match):
        raw = bytes(int(h, 16) for h in _BYTE_FALLBACK_TOKEN_RE.findall(match.group()))
        try:
            return raw.decode("utf-8")
        except UnicodeDecodeError:
            return match.group()

    return _BYTE_FALLBACK_RUN_RE.sub(_decode_run, text)

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


def _get_setting(config_attr, env_name, default, cast=lambda v: v):
    """Resolve a setting: config.py > env var > default (same precedence as get_ollama_model)."""
    try:
        import config

        value = getattr(config, config_attr, None)
        if value is not None:
            return cast(value)
    except ImportError:
        pass

    env_value = os.environ.get(env_name, "").strip()
    if env_value:
        try:
            return cast(env_value)
        except (TypeError, ValueError):
            pass

    return default


DEFAULT_MODEL = get_ollama_model()
DEFAULT_TEMPERATURE = 0.08
DEFAULT_TIMEOUT = 600  # seconds, hard cap on a single request
THINK_MODE = False     # no-think: disable Qwen/DeepSeek-style reasoning tokens

# Ollama runs on a shared host (an eScriptorium GPU worker shares the same
# card), so the model runner can still hit transient failures (e.g. a CUDA
# OOM if the GPU worker is mid-job when Ollama needs to reload). These
# knobs let gpt_autofix wait out a transient Ollama error instead of just
# surfacing a bare 500 to the user.
OLLAMA_MAX_RETRIES = _get_setting("OLLAMA_MAX_RETRIES", "OLLAMA_MAX_RETRIES", 2, int)
OLLAMA_RETRY_DELAY = _get_setting("OLLAMA_RETRY_DELAY", "OLLAMA_RETRY_DELAY", 10, float)
# Keep the model loaded on the GPU indefinitely (-1) rather than unloading
# it between requests: the GPU sits idle most of the time, and Ollama has
# no way to sense "someone else needs the GPU now" - keep_alive is a plain
# idle timer, not adaptive - so there's no safe shorter value that actually
# yields to other GPU work on demand. Lower this via config.py/env if VRAM
# contention with the eScriptorium GPU worker becomes a real problem.
#
# Ollama's API parses a *string* keep_alive with Go's time.ParseDuration,
# which requires a unit ("10m", "1h") and rejects a bare "-1" - -1 only
# means "never unload" when sent as a JSON number. So a plain integer/float
# setting is sent as-is (a number of seconds), while anything else is
# assumed to already be a valid duration string like "10m".
_raw_keep_alive = _get_setting("OLLAMA_KEEP_ALIVE", "OLLAMA_KEEP_ALIVE", -1)
try:
    OLLAMA_KEEP_ALIVE = int(_raw_keep_alive)
except (TypeError, ValueError):
    OLLAMA_KEEP_ALIVE = str(_raw_keep_alive)


def get_ollama_models():
    """Return the list of model names installed in the local Ollama instance."""
    try:
        req = urllib.request.Request(OLLAMA_TAGS_URL)
        with urllib.request.urlopen(req, timeout=10) as response:
            data = json.loads(response.read().decode("utf-8"))
        return [m.get("name", "") for m in data.get("models", []) if m.get("name")]
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as e:
        logger.warning("Cannot connect to Ollama: %s", e)
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
        # Unload the model soon after answering so it doesn't sit resident in
        # RAM competing with other services on the host between requests.
        "keep_alive": OLLAMA_KEEP_ALIVE,
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
                    logger.warning("Ollama HARD TIMEOUT reached (%ss) - truncating response", timeout)
                    break
                if now - t_last_activity > 60:
                    logger.warning("Ollama STALL DETECTED (no data for 60s) - aborting sample")
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

    except urllib.error.HTTPError as e:
        try:
            body = e.read().decode("utf-8", errors="replace")
        except OSError:
            body = ""
        try:
            detail = json.loads(body).get("error", body) if body else str(e)
        except json.JSONDecodeError:
            detail = body or str(e)
        # Ollama itself only returns 5xx when its model runner crashed or was
        # killed (most often OOM-killed on this host - see ai_tools module
        # docstring / server runbook), not because of anything in our
        # request. Treat 5xx as worth retrying; 4xx means our request itself
        # is malformed and retrying won't help.
        transient = e.code >= 500
        logger.error("Ollama HTTP %s: %s (transient=%s)", e.code, detail, transient)
        return {
            "predicted": f"[ERROR: HTTP {e.code}: {detail}]",
            "transient": transient,
            "thinking_text": "",
            "thinking_time": 0,
            "response_time": 0,
            "total_time": 0,
            "tokens_generated": 0,
            "tokens_per_sec": 0,
            "has_thinking": False,
        }
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        logger.error("Ollama connection error: %s", e)
        return {
            "predicted": f"[ERROR: {e}]",
            "transient": True,
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
        "predicted": _fix_byte_fallback_tokens("".join(collected_response).strip()),
        "transient": False,
        "thinking_text": _fix_byte_fallback_tokens("".join(collected_thinking).strip()),
        "thinking_time": thinking_time,
        "response_time": response_time,
        "total_time": total_time,
        "tokens_generated": eval_count,
        "tokens_per_sec": round(tokens_per_sec, 1),
        "has_thinking": has_thinking,
    }


_MEMORY_PRESSURE_MESSAGE = (
    "The AI correction service is temporarily overloaded on the server and "
    "could not process your request. Please try again in a minute."
)


def gpt_autofix(question, user_api_key=None, cache=None):
    """Correct OCR text using a local Ollama model.

    Backwards-compatible signature with the previous OpenAI-based
    implementation. `user_api_key` and `cache` are accepted but ignored.

    Ollama runs on a GPU shared with an eScriptorium worker container, so it
    can occasionally fail transiently (e.g. a CUDA OOM while the model
    reloads and the other worker is mid-job) with an HTTP 500 that has
    nothing to do with the input text. Rather than fail immediately, this
    retries transient (5xx/connection) errors a few times before giving up
    with a clear, user-facing message.

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
        logger.error("Error in gpt_autofix: %s", response["error"])
        return response

    model = get_ollama_model()
    attempts = OLLAMA_MAX_RETRIES + 1

    for attempt in range(1, attempts + 1):
        try:
            result = _run_ollama_chat(
                model=model,
                ocr_text=question,
                system_prompt=SYSTEM_PROMPT,
                temperature=DEFAULT_TEMPERATURE,
                timeout=DEFAULT_TIMEOUT,
                think=THINK_MODE,
            )
        except Exception as e:
            logger.exception("Unexpected error calling Ollama")
            response["error"] = str(e)
            return response

        predicted = result.get("predicted", "")
        if predicted.startswith("[ERROR:"):
            logger.error(
                "Ollama call failed (attempt %d/%d): %s", attempt, attempts, predicted
            )
            if result.get("transient") and attempt < attempts:
                time.sleep(OLLAMA_RETRY_DELAY)
                continue
            response["error"] = (
                _MEMORY_PRESSURE_MESSAGE if result.get("transient") else predicted
            )
            return response

        response["text"] = predicted
        # Surface a few timing details to the server logs.
        logger.info(
            "Ollama autofix: model=%s total=%.2fs tokens=%s tps=%s thinking=%s attempt=%d/%d",
            model,
            result.get("total_time", 0),
            result.get("tokens_generated", 0),
            result.get("tokens_per_sec", 0),
            result.get("has_thinking", False),
            attempt,
            attempts,
        )
        if result.get("has_thinking") and result.get("thinking_text"):
            logger.debug("--- thinking ---\n%s", result["thinking_text"][:600])
        return response

    return response


__all__ = ["gpt_autofix", "get_ollama_models", "get_ollama_model", "DEFAULT_MODEL"]
