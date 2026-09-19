from __future__ import annotations

import os
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from .storage import LabError, canonical, require, sha, strict_json, utc_now, write_json


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def invoke(profile: dict, prompt: str, payload: dict, record_path: Path) -> str:
    endpoint, model = profile.get("endpoint"), profile.get("name")
    require(isinstance(endpoint, str) and isinstance(model, str) and bool(model.strip()), "model_configuration_missing")
    parsed = urllib.parse.urlsplit(endpoint)
    require(parsed.scheme == "https" and bool(parsed.hostname) and not parsed.username and not parsed.password
            and not parsed.query and not parsed.fragment, "model_https_endpoint_required")
    key_name = profile.get("api_key_env")
    require(isinstance(key_name, str) and key_name.isidentifier(), "model_key_env_invalid")
    key = os.environ.get(key_name)
    require(bool(key), "model_key_missing")
    timeout = profile.get("timeout_seconds", 60)
    tokens = profile.get("max_tokens", 8192)
    require(type(timeout) in (int, float) and 1 <= timeout <= 300, "model_timeout_invalid")
    require(type(tokens) is int and 1 <= tokens <= 65536, "model_token_limit_invalid")
    options = profile.get("options", {})
    require(isinstance(options, dict) and set(options) <= {"temperature", "top_p", "thinking", "reasoning_effort"}, "model_options_invalid")
    messages = [{"role": "system", "content": prompt}, {"role": "user", "content": canonical(payload)}]
    body = {**options, "model": model, "messages": messages, "stream": False,
            "response_format": {"type": "json_object"}, "max_tokens": tokens}
    encoded = canonical(body).encode("utf-8")
    require(len(encoded) <= 1024 * 1024, "model_request_too_large")
    record = {"started_at": utc_now(), "profile_sha256": sha(canonical(profile)), "endpoint": endpoint,
              "requested_model": model, "options": options, "prompt_sha256": sha(prompt),
              "input_sha256": sha(canonical(payload)), "prompt": prompt, "input": payload,
              "status": "failed", "raw_response": None, "content": None}
    started = time.monotonic()
    try:
        request = urllib.request.Request(endpoint, data=encoded, method="POST",
                                         headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"})
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=timeout) as response:
            raw = response.read(4 * 1024 * 1024 + 1)
            require(len(raw) <= 4 * 1024 * 1024, "model_response_too_large")
            record["raw_response"] = raw.decode("utf-8")
        envelope = strict_json(record["raw_response"])
        require(isinstance(envelope, dict) and isinstance(envelope.get("choices"), list)
                and len(envelope["choices"]) == 1, "model_envelope_invalid")
        choice = envelope["choices"][0]
        require(isinstance(choice, dict), "model_choice_invalid")
        record["returned_model"] = envelope.get("model")
        record["usage"] = envelope.get("usage")
        record["finish_reason"] = choice.get("finish_reason")
        require(choice.get("finish_reason") == "stop", "model_incomplete_output")
        message = choice.get("message")
        require(isinstance(message, dict) and not message.get("tool_calls"), "model_tools_forbidden")
        content = message.get("content")
        record["content"] = content
        require(isinstance(content, str) and bool(content.strip()), "model_empty_output")
        # Keep raw failures; no fence stripping, silent repairs, or interpretation of reasoning_content.
        strict_json(content)
        record["status"] = "returned_json"
        return content
    except urllib.error.HTTPError as error:
        record["error"] = f"model_http_{error.code}"
        raise LabError(record["error"]) from error
    except (urllib.error.URLError, TimeoutError, socket.timeout, UnicodeDecodeError) as error:
        record["error"] = "model_transport_failed"
        raise LabError("model_transport_failed") from error
    except LabError as error:
        record["error"] = error.code
        raise
    finally:
        record["completed_at"] = utc_now()
        record["elapsed_seconds"] = round(time.monotonic() - started, 3)
        # Never store request headers or the key. Records are private, gitignored workspace files.
        write_json(record_path, record)
