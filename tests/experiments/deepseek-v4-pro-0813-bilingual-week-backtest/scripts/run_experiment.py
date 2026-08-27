"""Run the isolated DeepSeek bilingual 2x2 experiment.

The four cells are strategy-language x schema-language:
``zh_zh``, ``zh_en``, ``en_zh`` and ``en_en``.  Each cell receives the exact
same frozen market JSON at a decision point.  Successful calls are persisted
per decision/cell and are never silently repeated on a subsequent run.
"""

from __future__ import annotations

import argparse
import datetime as dt
import getpass
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Mapping

from common import (
    DATA_ROOT,
    EXPERIMENT_ROOT,
    PROTECTED_ENUM_TOKENS,
    PROTECTED_TOKEN_RE,
    RESULTS_ROOT,
    SOURCE_ROOT,
    SIGNAL_ENTRY_METHOD,
    bar_close_ms,
    bar_open_ms,
    direction_for_signal,
    ensure_dir,
    extract_json_object,
    git_commit,
    json_bytes,
    latency_summary,
    natural_language_adherence,
    parse_json_object_strict,
    normalize_data_plan,
    protected_tokens,
    redact_secrets,
    schema_key_coverage,
    sha256_bytes,
    sha256_file,
    simulate_outcome,
    utc_iso,
    validate_signal_output,
    validate_translation,
    write_json,
)


MODEL_NAME = "deepseek-v4-pro-0813"
DEFAULT_BASE_URL = "https://ai-api.finpoints.tech/v1"
DEFAULT_MAX_TOKENS = 8192
DEFAULT_TRANSLATION_MAX_TOKENS = 8192
DEFAULT_TEMPERATURE = 0.0
DEFAULT_TIMEOUT_SECONDS = 240
DEFAULT_RETRY_COUNT = 1
DEFAULT_TRANSLATION_TIMEOUT_SECONDS = 120
DEFAULT_TRANSLATION_RETRY_COUNT = 3
DEFAULT_FORMAL_THINKING_ENABLED = False
GROUPS = (
    ("zh_zh", "zh", "zh"),
    ("zh_en", "zh", "en"),
    ("en_zh", "en", "zh"),
    ("en_en", "en", "en"),
)
UTC = dt.timezone.utc
TRANSLATION_ALGORITHM = "protected-mask-v2"


class ExperimentError(RuntimeError):
    pass


class ApiError(ExperimentError):
    def __init__(self, message: str, *, attempts: list[dict[str, Any]] | None = None) -> None:
        super().__init__(message)
        self.attempts = list(attempts or [])


def normalize_base_url(base_url: str) -> str:
    """Return a persist-safe HTTPS API root or fail before any artifact write."""
    parsed = urllib.parse.urlsplit(str(base_url or "").strip())
    if (
        parsed.scheme != "https"
        or not parsed.netloc
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise ExperimentError("base_url_must_be_plain_https_without_credentials_or_query")
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path.rstrip("/"), "", ""))


def _safe_int(value: Any, fallback: int) -> int:
    try:
        parsed = int(value)
        return parsed if parsed >= 0 else fallback
    except (TypeError, ValueError):
        return fallback


def get_api_key() -> str:
    value = os.environ.get("FINPOINTS_API_KEY", "").strip()
    if value:
        return value
    if sys.stdin.isatty():
        value = getpass.getpass("FINPOINTS_API_KEY: ").strip()
        if value:
            return value
    raise ExperimentError("FINPOINTS_API_KEY_missing")


def _retry_after_seconds(headers: Any) -> float | None:
    raw = None
    try:
        raw = headers.get("Retry-After")
    except AttributeError:
        return None
    if raw is None:
        return None
    try:
        value = float(str(raw).strip())
        return max(0.0, min(value, 120.0))
    except ValueError:
        return None


class ChatClient:
    def __init__(
        self,
        api_key: str,
        *,
        base_url: str = DEFAULT_BASE_URL,
        model: str = MODEL_NAME,
        temperature: float = DEFAULT_TEMPERATURE,
        max_tokens: int = DEFAULT_MAX_TOKENS,
        timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
        retry_count: int = DEFAULT_RETRY_COUNT,
        thinking_enabled: bool = True,
        reasoning_effort: str = "max",
    ) -> None:
        self._api_key = api_key
        self.base_url = normalize_base_url(base_url)
        self.model = model
        self.temperature = float(temperature)
        self.max_tokens = int(max_tokens)
        self.timeout_seconds = int(timeout_seconds)
        self.retry_count = max(0, int(retry_count))
        self.thinking_enabled = bool(thinking_enabled)
        self.reasoning_effort = str(reasoning_effort or "max")

    def body_for(self, messages: list[dict[str, str]]) -> dict[str, Any]:
        body: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "max_tokens": self.max_tokens,
            "stream": False,
            "response_format": {"type": "json_object"},
        }
        if self.thinking_enabled:
            body["thinking"] = {"type": "enabled"}
            body["reasoning_effort"] = self.reasoning_effort
        else:
            body["thinking"] = {"type": "disabled"}
            body["temperature"] = self.temperature
            body["top_p"] = 1
        return body

    def request(self, messages: list[dict[str, str]], *, purpose: str) -> dict[str, Any]:
        body = self.body_for(messages)
        request_raw = json_bytes(body)
        request_hash = sha256_bytes(request_raw)
        endpoint = f"{self.base_url}/chat/completions"
        attempts: list[dict[str, Any]] = []
        last_status: int | None = None
        for attempt in range(self.retry_count + 1):
            started = time.perf_counter()
            request = urllib.request.Request(
                endpoint,
                data=request_raw,
                method="POST",
                headers={
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                    "Authorization": f"Bearer {self._api_key}",
                },
            )
            try:
                with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                    response_raw = response.read()
                    status = int(response.status)
                    elapsed = round((time.perf_counter() - started) * 1000, 3)
                    attempts.append({"attempt": attempt + 1, "http_status": status, "latency_ms": elapsed})
                    # A successful transport response is never retried, even
                    # if its content is malformed; repeating it could charge
                    # twice and hide a provider contract issue.
                    try:
                        response_json = json.loads(response_raw.decode("utf-8"))
                    except (UnicodeDecodeError, json.JSONDecodeError):
                        response_json = None
                    return {
                        "ok": 200 <= status < 300,
                        "purpose": purpose,
                        "request": body,
                        "request_sha256": request_hash,
                        "request_bytes": len(request_raw),
                        "response_sha256": sha256_bytes(response_raw),
                        "response_bytes": len(response_raw),
                        "latency_ms": elapsed,
                        "http_status": status,
                        "usage": response_json.get("usage") if isinstance(response_json, Mapping) else None,
                        "response_json": response_json,
                        "raw_response": response_raw.decode("utf-8", errors="replace"),
                        "attempts": attempts,
                    }
            except urllib.error.HTTPError as error:
                elapsed = round((time.perf_counter() - started) * 1000, 3)
                status = int(error.code)
                last_status = status
                retryable = status == 429 or 500 <= status <= 599
                retry_after = _retry_after_seconds(error.headers)
                attempts.append({
                    "attempt": attempt + 1,
                    "http_status": status,
                    "latency_ms": elapsed,
                    "retryable": retryable,
                    **({"retry_after_seconds": retry_after} if retry_after is not None else {}),
                })
                if not retryable or attempt >= self.retry_count:
                    break
                delay = retry_after if retry_after is not None else min(60.0, 1.0 * (2 ** attempt))
                time.sleep(delay)
            except (urllib.error.URLError, TimeoutError, OSError):
                elapsed = round((time.perf_counter() - started) * 1000, 3)
                attempts.append({"attempt": attempt + 1, "http_status": None, "latency_ms": elapsed, "retryable": True})
                if attempt >= self.retry_count:
                    break
                time.sleep(min(60.0, 1.0 * (2 ** attempt)))
        raise ApiError(f"api_request_failed:{last_status or 'network'}", attempts=attempts)


def _translation_token_pattern() -> re.Pattern[str]:
    enum_pattern = "|".join(sorted((re.escape(token) for token in PROTECTED_ENUM_TOKENS), key=len, reverse=True))
    return re.compile(
        rf"(?:{PROTECTED_TOKEN_RE.pattern})|(?<![A-Za-z0-9_])(?:{enum_pattern})(?![A-Za-z0-9_])",
        flags=re.IGNORECASE,
    )


TRANSLATION_TOKEN_PATTERN = _translation_token_pattern()


def _mask_translation_tokens(text: str, *, start_index: int = 0) -> tuple[str, list[tuple[str, str]]]:
    replacements: list[tuple[str, str]] = []

    def replace(match: re.Match[str]) -> str:
        sentinel = f"__AURUM_PROTECTED_{start_index + len(replacements):05d}__"
        replacements.append((sentinel, match.group(0)))
        return sentinel

    return TRANSLATION_TOKEN_PATTERN.sub(replace, text), replacements


def _unmask_translation_tokens(text: str, replacements: list[tuple[str, str]]) -> str:
    result = str(text or "")
    for sentinel, original in replacements:
        if result.count(sentinel) != 1:
            raise ExperimentError("translation_mask_invariant_failed")
        result = result.replace(sentinel, original)
    if "__AURUM_PROTECTED_" in result:
        raise ExperimentError("translation_mask_unknown_token")
    return result


def _mask_json_string_values(value: Any, replacements: list[tuple[str, str]]) -> Any:
    if isinstance(value, str):
        masked, added = _mask_translation_tokens(value, start_index=len(replacements))
        replacements.extend(added)
        return masked
    if isinstance(value, list):
        return [_mask_json_string_values(item, replacements) for item in value]
    if isinstance(value, Mapping):
        return {key: _mask_json_string_values(child, replacements) for key, child in value.items()}
    return value


def _strategy_translation_messages(chunk: str, index: int, total: int) -> list[dict[str, str]]:
    return [
        {
            "role": "system",
            "content": (
                "You are a strict Chinese-to-English technical translator for an AI trading strategy. "
                "Return only a JSON object with exactly one key, translation, whose value is the complete English "
                "translation of the supplied chunk. Preserve every Markdown marker and line boundary as closely as "
                "JSON permits. Preserve all numbers, percentages, enum/code tokens, timeframe tokens "
                "(M1/M5/M15/M30/H1/H4/D1/W1), placeholders such as {{...}}, JSON/dotted field paths, operators, "
                "and formulas exactly. Tokens named __AURUM_PROTECTED_#####__ are immutable placeholders and each "
                "must appear exactly once in the result. Never introduce an Arabic digit outside those placeholders; "
                "spell translated Chinese numeric concepts as English words. Translate every Chinese prose character; do not summarize, add, omit, "
                "explain, or wrap the translation in Markdown fences."
            ),
        },
        {
            "role": "user",
            "content": chunk,
        },
    ]


def _schema_translation_messages(schema_zh: Mapping[str, Any]) -> list[dict[str, str]]:
    source_schema = json.dumps(schema_zh, ensure_ascii=False, indent=2)
    return [
        {
            "role": "system",
            "content": (
                "You are a strict Chinese-to-English technical translator. Return only one JSON object with exactly "
                "one key, schema_en, whose value is the translated output-format object. Translate every Chinese "
                "string value into precise English. Preserve JSON keys, object/list shape, enum/code tokens, all "
                "numbers, timeframe tokens, placeholders such as {{...}}, and dotted field paths exactly. Tokens "
                "named __AURUM_PROTECTED_#####__ are immutable and each must appear exactly once. Never introduce "
                "an Arabic digit outside those placeholders; spell translated Chinese numeric concepts as English words. Do not "
                "add, remove, reorder, or explain content."
            ),
        },
        {"role": "user", "content": f"CHINESE OUTPUT SCHEMA JSON:\n{source_schema}"},
    ]


def _strategy_chunks(strategy_zh: str, max_chars: int = 4_000) -> list[str]:
    chunks: list[str] = []
    current: list[str] = []
    current_chars = 0
    for line in strategy_zh.splitlines():
        extra = len(line) + (1 if current else 0)
        if current and current_chars + extra > max_chars:
            chunks.append("\n".join(current))
            current = []
            current_chars = 0
        current.append(line)
        current_chars += len(line) + (1 if len(current) > 1 else 0)
    if current:
        chunks.append("\n".join(current))
    return chunks


def _assistant_mapping(response: Mapping[str, Any]) -> Mapping[str, Any]:
    response_json = response.get("response_json")
    content = None
    if isinstance(response_json, Mapping):
        choices = response_json.get("choices")
        if isinstance(choices, list) and choices and isinstance(choices[0], Mapping):
            content = (choices[0].get("message") or {}).get("content")
    parsed, parse_error = extract_json_object(content)
    if parse_error or not isinstance(parsed, Mapping):
        raise ExperimentError("translation_response_invalid_json")
    return parsed


def _translation_record(response: Mapping[str, Any], client: ChatClient, *, purpose: str) -> dict[str, Any]:
    return {
        "purpose": purpose,
        "request": response.get("request"),
        "request_sha256": response.get("request_sha256"),
        "request_bytes": response.get("request_bytes"),
        "response_sha256": response.get("response_sha256"),
        "response_bytes": response.get("response_bytes"),
        "latency_ms": response.get("latency_ms"),
        "http_status": response.get("http_status"),
        "usage": response.get("usage"),
        "raw_response": redact_secrets(response.get("raw_response"), client._api_key),
        "attempts": response.get("attempts", []),
    }


def _cached_translation_source_binding(
    *,
    source_root: Path,
    strategy_zh: str,
    strategy_en: str,
    schema_zh: Mapping[str, Any],
    schema_en: Mapping[str, Any],
) -> dict[str, Any]:
    """Prove that final English files were built from the current Chinese files.

    Token/shape invariants alone cannot detect a Chinese prose-only update.  The
    chunk cache records the SHA of each exact source chunk, so bind the assembled
    English files to those records before reusing them.
    """
    chunks = _strategy_chunks(strategy_zh)
    chunk_root = source_root / "translation-chunks"
    translated_chunks: list[str] = []
    chunk_bindings: list[dict[str, Any]] = []
    for index, chunk in enumerate(chunks):
        chunk_path = chunk_root / f"strategy-{index + 1:02d}-of-{len(chunks):02d}.json"
        try:
            record = json.loads(chunk_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise ExperimentError("cached_translation_chunk_missing_or_invalid") from exc
        source_hash = sha256_bytes(chunk)
        translated = record.get("translation")
        if record.get("source_sha256") != source_hash or not isinstance(translated, str):
            raise ExperimentError("cached_translation_chunk_source_mismatch")
        translated_chunks.append(translated.strip("\r\n"))
        chunk_bindings.append({
            "index": index + 1,
            "source_sha256": source_hash,
            "translation_sha256": sha256_bytes(translated),
        })
    if "\n".join(translated_chunks) != strategy_en:
        raise ExperimentError("cached_strategy_translation_assembly_mismatch")

    schema_source_text = json.dumps(schema_zh, ensure_ascii=False, separators=(",", ":"))
    schema_source_hash = sha256_bytes(schema_source_text)
    schema_cache_path = chunk_root / "schema.json"
    try:
        schema_record = json.loads(schema_cache_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ExperimentError("cached_schema_translation_missing_or_invalid") from exc
    if schema_record.get("source_sha256") != schema_source_hash:
        raise ExperimentError("cached_schema_translation_source_mismatch")
    if schema_record.get("schema_en") != schema_en:
        raise ExperimentError("cached_schema_translation_assembly_mismatch")
    return {
        "source_binding_verified": True,
        "strategy_source_sha256": sha256_bytes(strategy_zh),
        "schema_source_sha256": schema_source_hash,
        "strategy_translation_sha256": sha256_bytes(strategy_en),
        "schema_translation_sha256": sha256_bytes(
            json.dumps(schema_en, ensure_ascii=False, separators=(",", ":"))
        ),
        "strategy_chunk_bindings": chunk_bindings,
        "schema_request_sha256": schema_record.get("request_sha256"),
        "schema_response_sha256": schema_record.get("response_sha256"),
    }


def load_or_translate(
    client: ChatClient | None,
    *,
    strategy_zh: str,
    schema_zh: Mapping[str, Any],
    source_root: Path = SOURCE_ROOT,
    force: bool = False,
) -> tuple[str, dict[str, Any], dict[str, Any]]:
    strategy_en_path = source_root / "strategy.en.md"
    schema_en_path = source_root / "output-schema.en.json"
    if strategy_en_path.exists() and schema_en_path.exists() and not force:
        strategy_en = strategy_en_path.read_text(encoding="utf-8")
        schema_en = json.loads(schema_en_path.read_text(encoding="utf-8"))
        if not isinstance(schema_en, Mapping):
            raise ExperimentError("cached_schema_translation_not_object")
        source_binding = _cached_translation_source_binding(
            source_root=source_root,
            strategy_zh=strategy_zh,
            strategy_en=strategy_en,
            schema_zh=schema_zh,
            schema_en=schema_en,
        )
        audit = validate_translation(strategy_zh, strategy_en, schema_zh, schema_en)
        translation_calls_path = source_root / "translation-calls.json"
        cached_calls: list[Any] = []
        if translation_calls_path.exists():
            try:
                loaded_calls = json.loads(translation_calls_path.read_text(encoding="utf-8"))
                cached_calls = loaded_calls if isinstance(loaded_calls, list) else []
            except (OSError, json.JSONDecodeError):
                cached_calls = []
        audit.update({
            "source": "model_chunked_cached" if cached_calls else "provided",
            "model": MODEL_NAME if cached_calls else None,
            "translation_calls": len(cached_calls) if cached_calls else None,
            "strategy_chunk_count": max(0, len(cached_calls) - 1) if cached_calls else None,
            "translation_algorithm": TRANSLATION_ALGORITHM if cached_calls else None,
            **source_binding,
            "passed": bool(audit["passed"]),
        })
        if not audit["passed"]:
            raise ExperimentError("provided_translation_invariant_failed")
        write_json(source_root / "translation-audit.json", audit)
        return strategy_en, schema_en, audit
    if client is None:
        raise ExperimentError("translation_required")
    chunks = _strategy_chunks(strategy_zh)
    chunk_root = source_root / "translation-chunks"
    ensure_dir(chunk_root)
    translated_chunks: list[str] = []
    call_records: list[dict[str, Any]] = []
    chunk_audits: list[dict[str, Any]] = []
    for index, chunk in enumerate(chunks):
        source_hash = sha256_bytes(chunk)
        chunk_path = chunk_root / f"strategy-{index + 1:02d}-of-{len(chunks):02d}.json"
        translated_chunk = None
        record = None
        if chunk_path.exists() and not force:
            cached = json.loads(chunk_path.read_text(encoding="utf-8"))
            if cached.get("source_sha256") != source_hash:
                raise ExperimentError("translation_chunk_source_hash_mismatch")
            cached_translation = cached.get("translation")
            cached_valid = (
                isinstance(cached_translation, str)
                and not re.search(r"[\u3400-\u9fff]", cached_translation)
                and protected_tokens(chunk, include_enums=False)
                == protected_tokens(cached_translation, include_enums=False)
            )
            if str(cached.get("translation_algorithm") or "").startswith("protected-mask-v") and cached_valid:
                translated_chunk = cached_translation
                record = cached
            else:
                rejected_algorithm = str(cached.get("translation_algorithm") or "unmasked")
                rejected_path = chunk_path.with_name(chunk_path.stem + f".rejected-{rejected_algorithm}.json")
                if not rejected_path.exists():
                    write_json(rejected_path, cached)
        if record is None:
            masked_chunk, replacements = _mask_translation_tokens(chunk)
            response = client.request(
                _strategy_translation_messages(masked_chunk, index, len(chunks)),
                purpose=f"translation:strategy:{index + 1}/{len(chunks)}",
            )
            masked_translation = _assistant_mapping(response).get("translation")
            try:
                translated_chunk = _unmask_translation_tokens(masked_translation, replacements)
            except ExperimentError:
                write_json(chunk_path, {
                    "translation_algorithm": TRANSLATION_ALGORITHM,
                    "source_sha256": source_hash,
                    "source_chars": len(chunk),
                    "protected_placeholder_count": len(replacements),
                    "masked_translation": masked_translation,
                    "invariant_passed": False,
                    "invariant_error": "translation_mask_invariant_failed",
                    **_translation_record(response, client, purpose=f"strategy:{index + 1}/{len(chunks)}"),
                })
                raise
            record = {
                "translation_algorithm": TRANSLATION_ALGORITHM,
                "source_sha256": source_hash,
                "source_chars": len(chunk),
                "protected_placeholder_count": len(replacements),
                "translation": translated_chunk,
                **_translation_record(response, client, purpose=f"strategy:{index + 1}/{len(chunks)}"),
            }
        if not isinstance(translated_chunk, str) or not translated_chunk.strip():
            record.update({"invariant_passed": False, "invariant_error": "translation_chunk_empty"})
            write_json(chunk_path, record)
            raise ExperimentError("translation_chunk_empty")
        source_tokens = protected_tokens(chunk, include_enums=False)
        target_tokens = protected_tokens(translated_chunk, include_enums=False)
        cjk_count = len(re.findall(r"[\u3400-\u9fff]", translated_chunk))
        chunk_audit = {
            "index": index + 1,
            "source_sha256": source_hash,
            "translation_sha256": sha256_bytes(translated_chunk),
            "protected_tokens_exact": source_tokens == target_tokens,
            "remaining_cjk_chars": cjk_count,
        }
        chunk_audit["invariant_passed"] = bool(chunk_audit["protected_tokens_exact"] and cjk_count == 0)
        record.update(chunk_audit)
        write_json(chunk_path, record)
        if not chunk_audit["invariant_passed"]:
            raise ExperimentError(f"translation_chunk_invariant_failed:{index + 1}")
        translated_chunks.append(translated_chunk.strip("\r\n"))
        call_records.append(record)
        chunk_audits.append(chunk_audit)
    strategy_en = "\n".join(translated_chunks)

    schema_source_text = json.dumps(schema_zh, ensure_ascii=False, separators=(",", ":"))
    schema_source_hash = sha256_bytes(schema_source_text)
    schema_cache_path = chunk_root / "schema.json"
    schema_replacements: list[tuple[str, str]] = []
    masked_schema = _mask_json_string_values(schema_zh, schema_replacements)
    schema_record = None
    if schema_cache_path.exists() and not force:
        cached_schema = json.loads(schema_cache_path.read_text(encoding="utf-8"))
        if cached_schema.get("source_sha256") != schema_source_hash:
            raise ExperimentError("translation_schema_source_hash_mismatch")
        cached_schema_en = cached_schema.get("schema_en")
        cached_schema_text = json.dumps(cached_schema_en, ensure_ascii=False, separators=(",", ":"))
        cached_schema_valid = (
            not re.search(r"[\u3400-\u9fff]", cached_schema_text)
            and protected_tokens(schema_source_text, include_enums=False)
            == protected_tokens(cached_schema_text, include_enums=False)
        )
        if cached_schema.get("translation_algorithm") == TRANSLATION_ALGORITHM and cached_schema_valid:
            schema_record = cached_schema
            schema_en = cached_schema_en
    if schema_record is None:
        schema_response = client.request(_schema_translation_messages(masked_schema), purpose="translation:schema")
        masked_schema_en = _assistant_mapping(schema_response).get("schema_en")
        try:
            masked_schema_text = json.dumps(masked_schema_en, ensure_ascii=False, separators=(",", ":"))
            schema_en = json.loads(_unmask_translation_tokens(masked_schema_text, schema_replacements))
        except (ExperimentError, json.JSONDecodeError):
            write_json(schema_cache_path, {
                "translation_algorithm": TRANSLATION_ALGORITHM,
                "source_sha256": schema_source_hash,
                "protected_placeholder_count": len(schema_replacements),
                "masked_schema_en": masked_schema_en,
                "invariant_passed": False,
                "invariant_error": "translation_schema_mask_invariant_failed",
                **_translation_record(schema_response, client, purpose="schema"),
            })
            raise ExperimentError("translation_schema_mask_invariant_failed")
        schema_record = {
            "translation_algorithm": TRANSLATION_ALGORITHM,
            "source_sha256": schema_source_hash,
            "protected_placeholder_count": len(schema_replacements),
            "schema_en": schema_en,
            **_translation_record(schema_response, client, purpose="schema"),
        }
    if isinstance(schema_en, str):
        try:
            schema_en = json.loads(schema_en)
        except json.JSONDecodeError as exc:
            raise ExperimentError("translation_schema_invalid_json") from exc
    schema_target_text = json.dumps(schema_en, ensure_ascii=False, separators=(",", ":"))
    # Existing enum literals were masked and restored exactly.  New English
    # prose may legitimately use words such as "hold", "market" or "stop";
    # do not misclassify those natural-language occurrences as enum changes.
    schema_tokens_exact = (
        protected_tokens(schema_source_text, include_enums=False)
        == protected_tokens(schema_target_text, include_enums=False)
    )
    schema_remaining_cjk = len(re.findall(r"[\u3400-\u9fff]", schema_target_text))
    audit = validate_translation(strategy_zh, strategy_en, schema_zh, schema_en)
    audit.update({
        "source": "model_chunked",
        "model": client.model,
        "source_binding_verified": True,
        "strategy_source_sha256": sha256_bytes(strategy_zh),
        "schema_source_sha256": schema_source_hash,
        "strategy_translation_sha256": sha256_bytes(strategy_en),
        "schema_translation_sha256": sha256_bytes(schema_target_text),
        "strategy_chunk_count": len(chunks),
        "strategy_chunks": chunk_audits,
        "schema_request_sha256": schema_record.get("request_sha256"),
        "schema_response_sha256": schema_record.get("response_sha256"),
        "schema_protected_tokens_exact": schema_tokens_exact,
        "schema_remaining_cjk_chars": schema_remaining_cjk,
        "translation_calls": len(chunks) + 1,
        "max_tokens": client.max_tokens,
    })
    audit["passed"] = bool(audit["passed"] and schema_tokens_exact and schema_remaining_cjk == 0)
    if not schema_tokens_exact:
        audit.setdefault("errors", []).append("schema_protected_tokens_not_exact")
    if schema_remaining_cjk:
        audit.setdefault("errors", []).append("schema_contains_chinese")
    schema_record.update({
        "protected_tokens_exact": schema_tokens_exact,
        "remaining_cjk_chars": schema_remaining_cjk,
        "invariant_passed": bool(schema_tokens_exact and schema_remaining_cjk == 0 and audit.get("passed")),
    })
    write_json(schema_cache_path, schema_record)
    if not audit["passed"]:
        write_json(source_root / "translation-audit.json", audit)
        raise ExperimentError("translation_invariant_failed")
    strategy_en_path.write_bytes(strategy_en.encode("utf-8"))
    write_json(schema_en_path, schema_en)
    write_json(source_root / "translation-audit.json", audit)
    call_records.append(schema_record)
    write_json(source_root / "translation-calls.json", call_records)
    return strategy_en, schema_en, audit


def decision_points(market_data: Mapping[str, Any], requested: int = 8) -> list[dict[str, Any]]:
    plan = normalize_data_plan(market_data.get("plan"))
    primary = plan["primary_timeframe"]
    frame = (market_data.get("timeframes") or {}).get(primary) or {}
    bars = sorted(frame.get("bars") or [], key=lambda bar: bar_open_ms(bar) or 0)
    window = market_data.get("window") or {}
    start = int(window.get("start_utc_msc") or 0)
    end = int(window.get("end_utc_msc") or 0)
    outcome_hours = int(window.get("outcome_hours") or 12)
    m1_bars = sorted(((market_data.get("timeframes") or {}).get("M1") or {}).get("bars") or [], key=lambda bar: bar_open_ms(bar) or 0)

    def has_future(decision_ms: int) -> bool:
        if not m1_bars:
            return False
        latest = bar_open_ms(m1_bars[-1]) or 0
        return latest + 60_000 >= decision_ms + outcome_hours * 3_600_000

    candidates = []
    for bar in bars:
        close = bar_close_ms(bar, primary)
        if close is None or close < start or close > end:
            continue
        candidates.append({"decision_time_utc_msc": close, "decision_time_utc": utc_iso(close), "has_12h_future": has_future(close)})
    with_future = [item for item in candidates if item["has_12h_future"]]
    candidates = with_future or candidates
    candidates = sorted({item["decision_time_utc_msc"]: item for item in candidates}.values(), key=lambda item: item["decision_time_utc_msc"])
    if not candidates:
        raise ExperimentError("decision_points_unavailable")
    count = max(1, int(requested))
    if len(candidates) <= count:
        selected = candidates
    elif count == 1:
        selected = [candidates[len(candidates) // 2]]
    else:
        indices = [round(index * (len(candidates) - 1) / (count - 1)) for index in range(count)]
        selected = [candidates[index] for index in indices]
    for index, item in enumerate(selected):
        item["sample_index"] = index
        item["decision_id"] = f"{primary.lower()}-{item['decision_time_utc_msc']}"
    return selected


def _build_context_snapshots(decisions: list[dict[str, Any]], *, market_path: Path, metadata_path: Path, output_path: Path, node: str = "node") -> dict[str, Any]:
    helper = EXPERIMENT_ROOT / "scripts" / "build_market_context.mjs"
    command = [node, str(helper), "--market-data", str(market_path), "--runtime-metadata", str(metadata_path), "--output", str(output_path)]
    for decision in decisions:
        command.extend(["--decision-time", str(decision["decision_time_utc_msc"])])
    try:
        result = __import__("subprocess").run(
            command,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
            timeout=120,
        )
    except OSError as exc:
        raise ExperimentError("node_context_helper_unavailable") from exc
    if result.returncode != 0:
        raise ExperimentError("context_build_failed")
    try:
        return json.loads(output_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ExperimentError("context_output_invalid") from exc


def _load_verified_snapshot_cache(
    *,
    snapshot_path: Path,
    decisions: list[Mapping[str, Any]],
    metadata: Mapping[str, Any],
    market_data: Mapping[str, Any],
    vm_commit: str,
) -> dict[str, Any]:
    """Fail closed when reusing snapshots produced by the clean VM commit."""
    try:
        payload = json.loads(snapshot_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ExperimentError("verified_snapshot_cache_missing_or_invalid") from exc
    verification_path = snapshot_path.with_name("snapshot-clean-runtime-verification.json")
    try:
        verification = json.loads(verification_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ExperimentError("verified_snapshot_cache_clean_runtime_evidence_missing") from exc
    if (
        verification.get("exact_clean_rebuild_match") is not True
        or verification.get("runtime_diff_exit") != 0
        or verification.get("clean_worktree_commit") != vm_commit
        or verification.get("snapshot_sha256") != sha256_file(snapshot_path)
    ):
        raise ExperimentError("verified_snapshot_cache_clean_runtime_evidence_mismatch")
    expected = {
        "vm_commit": vm_commit,
        "local_repo_commit": vm_commit,
        "strategy_body_sha256": metadata.get("strategy_body_sha256"),
        "output_schema_sha256": metadata.get("output_schema_sha256"),
        "market_data_sha256": market_data.get("market_data_sha256"),
        "chan_window_policy_version": metadata.get("chan_window_policy_version"),
    }
    for key, value in expected.items():
        if not value or payload.get(key) != value:
            raise ExperimentError(f"verified_snapshot_cache_provenance_mismatch:{key}")
    snapshots = payload.get("snapshots")
    if not isinstance(snapshots, list) or len(snapshots) != len(decisions):
        raise ExperimentError("verified_snapshot_cache_count_mismatch")
    actual_times = [item.get("decision_time_utc_msc") for item in snapshots if isinstance(item, Mapping)]
    expected_times = [item.get("decision_time_utc_msc") for item in decisions]
    if actual_times != expected_times:
        raise ExperimentError("verified_snapshot_cache_decisions_mismatch")
    if any(item.get("future_leakage") is not False for item in snapshots if isinstance(item, Mapping)):
        raise ExperimentError("verified_snapshot_cache_future_leakage")
    return payload


def _runtime_paths_clean() -> bool:
    repo_root = EXPERIMENT_ROOT.parent.parent.parent
    try:
        result = subprocess.run(
            ["git", "status", "--porcelain", "--", "server/routes/ai"],
            cwd=repo_root,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return result.returncode == 0 and not result.stdout.strip()


def _output_language_instruction(schema_language: str) -> str:
    """Render the same production output-language rule in the cell language.

    The VM contract requires user-visible narrative values to remain Simplified
    Chinese.  The 2x2 factor is the language used to *describe* the contract,
    not a change to the response language.  Changing the required response
    language would alter semantics and confound the prompt-language comparison.
    """
    if schema_language == "zh":
        return (
            "最后优先规则：JSON keys 和枚举 token 必须保持原样；所有自然语言字段（包括 analysis、reasoning、"
            "decision_summary、trigger_condition、invalidation_condition、key_reasons、risk_factors、"
            "position_size_reason、pending_action_reason、experience_usage.influence）必须使用简体中文。"
        )
    return (
        "Final priority rule: keep JSON keys and enum tokens exactly unchanged; all natural-language fields "
        "(including analysis, reasoning, decision_summary, trigger_condition, invalidation_condition, key_reasons, "
        "risk_factors, position_size_reason, pending_action_reason, and experience_usage.influence) must be in "
        "Simplified Chinese."
    )


def _compact_market_input_rule(strategy_language: str) -> str:
    if strategy_language == "zh":
        return (
            "## 市场数据紧凑编码\n"
            "strategy_context.input_encoding 说明模型输入的无损编码。各周期 klines 中每个数组元素严格依次对应 "
            "kline_fields；字段包括原始时间、UTC 毫秒时间、交易服务器毫秒时间、采集 UTC 毫秒时间、开高低收、"
            "Tick 成交量和点差，null 表示该原始字段未提供，数组元素数量就是 K 线根数。"
        )
    return (
        "## Compact market-data encoding\n"
        "strategy_context.input_encoding describes the lossless model-input encoding. In every timeframe's klines, "
        "each array element corresponds exactly, in order, to kline_fields: raw time, UTC time in milliseconds, "
        "trading-server time in milliseconds, capture UTC time in milliseconds, open, high, low, close, tick volume, "
        "and spread. null means that the raw field was not provided; the number of array elements is the number of bars."
    )


def build_formal_messages(
    strategy_text: str,
    schema: Mapping[str, Any],
    market: Mapping[str, Any],
    schema_language: str,
    strategy_language: str | None = None,
) -> list[dict[str, str]]:
    strategy_language = strategy_language or ("zh" if schema_language == "zh" else "en")
    market_json = json.dumps(market, ensure_ascii=False, separators=(",", ":"))
    schema_json = json.dumps(schema, ensure_ascii=False, indent=2)
    if schema_language == "zh":
        schema_heading = "## 输出格式\n你必须返回以下 JSON 结构："
    else:
        schema_heading = "## Output format\nYou must return the following JSON structure:"
    # Production appends the dynamic output contract to the system prompt.
    # Keep that role boundary here so the 2x2 experiment changes only the
    # strategy prose and contract-description languages, not message priority.
    system = (
        f"{strategy_text.strip()}\n\n{_compact_market_input_rule(strategy_language)}"
        f"\n\n{_output_language_instruction(schema_language)}"
        f"\n\n{schema_heading}\n{schema_json}"
    )
    # Freeze the user wrapper across all four cells.  The schema factor must
    # change only the output-contract block above, never the task instruction
    # or market heading.
    user = (
        "仅根据策略正文和冻结市场事实作答。严格返回一个 JSON 对象，不要 Markdown，不要补充 JSON 之外的文字。"
        f"\n\n冻结市场数据 JSON：\n{market_json}"
    )
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def _call_path(decision_id: str, group: str, results_root: Path) -> Path:
    safe_decision = re.sub(r"[^A-Za-z0-9_.-]", "_", decision_id)
    return results_root / "calls" / f"{safe_decision}__{group}.json"


def _load_success(path: Path, expected_request_hash: str, *, force: bool) -> dict[str, Any] | None:
    if not path.exists() or force:
        return None
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ExperimentError("call_record_invalid") from exc
    if record.get("status") != "success":
        return None
    if record.get("request_sha256") != expected_request_hash:
        raise ExperimentError("idempotency_request_hash_mismatch")
    record["resumed"] = True
    return record


def _persist_call(path: Path, record: Mapping[str, Any]) -> None:
    ensure_dir(path.parent)
    temporary = path.with_suffix(path.suffix + ".tmp")
    write_json(temporary, dict(record))
    temporary.replace(path)


def _response_content(response_json: Any) -> tuple[Any, Any]:
    if not isinstance(response_json, Mapping):
        return None, None
    choices = response_json.get("choices")
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], Mapping):
        return None, None
    message = choices[0].get("message") or {}
    return message.get("content"), message.get("reasoning_content")


def run_formal_calls(
    *,
    client: ChatClient,
    snapshots: list[Mapping[str, Any]],
    strategies: Mapping[str, str],
    schemas: Mapping[str, Mapping[str, Any]],
    allowed_methods: list[str],
    market_data: Mapping[str, Any],
    results_root: Path = RESULTS_ROOT,
    force: bool = False,
) -> list[dict[str, Any]]:
    all_results: list[dict[str, Any]] = []
    base_groups = list(GROUPS)
    for sample_index, snapshot in enumerate(snapshots):
        decision_id = str(snapshot.get("decision_id") or f"sample-{sample_index}")
        # A rotation is a Latin-style schedule: each cell occupies each call
        # position across four consecutive decision points.
        rotation = sample_index % len(base_groups)
        ordered = base_groups[rotation:] + base_groups[:rotation]
        if sample_index % 2:
            ordered = [ordered[0], *reversed(ordered[1:])]
        market = snapshot.get("market") or {}
        market_hash = sha256_bytes(json_bytes(market))
        for call_index, (group, strategy_language, schema_language) in enumerate(ordered):
            messages = build_formal_messages(
                strategies[strategy_language], schemas[schema_language], market, schema_language, strategy_language
            )
            body = client.body_for(messages)
            request_hash = sha256_bytes(json_bytes(body))
            call_path = _call_path(decision_id, group, results_root)
            resumed = _load_success(call_path, request_hash, force=force)
            if resumed is not None:
                parsed = resumed.get("parsed_output")
                try:
                    market_price = float(market.get("latest_price"))
                except (TypeError, ValueError):
                    market_price = None
                validation = validate_signal_output(parsed, schemas[schema_language], allowed_methods, market_price)
                resumed.update({
                    "natural_language_adherence": natural_language_adherence(parsed, "zh"),
                    "schema_key_coverage": schema_key_coverage(parsed, schemas[schema_language]),
                    "validation": validation,
                    "contract_passed": bool(resumed.get("parse_error") is None and validation.get("passed")),
                    "backtest": simulate_outcome(
                        parsed if isinstance(parsed, Mapping) else {},
                        market_data,
                        market,
                        int(snapshot["decision_time_utc_msc"]),
                        validation=validation,
                    ),
                })
                _persist_call(call_path, resumed)
                all_results.append(resumed)
                continue
            try:
                response = client.request(messages, purpose=f"formal:{group}")
                content, reasoning_content = _response_content(response.get("response_json"))
                parsed, parse_error = parse_json_object_strict(content)
                market_price = None
                try:
                    market_price = float(market.get("latest_price"))
                except (TypeError, ValueError):
                    pass
                validation = validate_signal_output(parsed, schemas[schema_language], allowed_methods, market_price)
                outcome = simulate_outcome(
                    parsed if isinstance(parsed, Mapping) else {},
                    market_data,
                    market,
                    int(snapshot["decision_time_utc_msc"]),
                    validation=validation,
                )
                record = {
                    "status": "success",
                    "pair_id": decision_id,
                    "sample_index": sample_index,
                    "decision_id": decision_id,
                    "decision_time_utc": snapshot.get("decision_time_utc"),
                    "strategy_language": strategy_language,
                    "schema_language": schema_language,
                    "group": group,
                    "call_order": call_index,
                    "model": client.model,
                    "temperature": None if client.thinking_enabled else client.temperature,
                    "thinking": {"type": "enabled", "reasoning_effort": client.reasoning_effort}
                    if client.thinking_enabled else {"type": "disabled"},
                    "max_tokens": client.max_tokens,
                    "market_data_sha256": market_data.get("market_data_sha256"),
                    "market_payload_sha256": market_hash,
                    "request_sha256": response.get("request_sha256", request_hash),
                    "request_bytes": response.get("request_bytes", len(json_bytes(body))),
                    "request": response.get("request", body),
                    "response_sha256": response.get("response_sha256"),
                    "response_bytes": response.get("response_bytes"),
                    "latency_ms": response.get("latency_ms"),
                    "http_status": response.get("http_status"),
                    "usage": response.get("usage"),
                    "attempts": response.get("attempts", []),
                    "raw_response": redact_secrets(response.get("raw_response"), client._api_key),
                    "reasoning_content": redact_secrets(reasoning_content, client._api_key) if reasoning_content is not None else None,
                    "parsed_output": parsed,
                    "parse_error": parse_error,
                    # Both contract-language variants preserve the VM's actual
                    # Simplified-Chinese response requirement.  Measure that
                    # shared requirement rather than the schema prose language.
                    "natural_language_adherence": natural_language_adherence(parsed, "zh"),
                    "schema_key_coverage": schema_key_coverage(parsed, schemas[schema_language]),
                    "validation": validation,
                    "contract_passed": bool(parse_error is None and validation.get("passed")),
                    "backtest": outcome,
                }
            except (ApiError, ExperimentError) as exc:
                record = {
                    "status": "failed",
                    "pair_id": decision_id,
                    "sample_index": sample_index,
                    "decision_id": decision_id,
                    "decision_time_utc": snapshot.get("decision_time_utc"),
                    "strategy_language": strategy_language,
                    "schema_language": schema_language,
                    "group": group,
                    "call_order": call_index,
                    "model": client.model,
                    "request_sha256": request_hash,
                    "request_bytes": len(json_bytes(body)),
                    "request": body,
                    "error": str(exc),
                    "attempts": exc.attempts if isinstance(exc, ApiError) else [],
                    "contract_passed": False,
                }
            _persist_call(call_path, record)
            all_results.append(record)
    return all_results


def run(
    *,
    samples: int = 8,
    base_url: str = DEFAULT_BASE_URL,
    terminal_node: str = "node",
    force: bool = False,
    dry_run: bool = False,
    max_tokens: int = DEFAULT_MAX_TOKENS,
    translation_max_tokens: int = DEFAULT_TRANSLATION_MAX_TOKENS,
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
    retry_count: int = DEFAULT_RETRY_COUNT,
    formal_thinking_enabled: bool = DEFAULT_FORMAL_THINKING_ENABLED,
    reuse_verified_snapshots: bool = False,
) -> dict[str, Any]:
    if formal_thinking_enabled:
        raise ExperimentError("thinking_enabled_not_allowed_in_primary_results; use a separate pilot directory")
    base_url = normalize_base_url(base_url)
    strategy_path = SOURCE_ROOT / "strategy.zh.md"
    schema_path = SOURCE_ROOT / "output-schema.zh.json"
    metadata_path = SOURCE_ROOT / "runtime-metadata.json"
    market_path = DATA_ROOT / "market-data.json"
    data_metadata_path = DATA_ROOT / "metadata.json"
    for path in (strategy_path, schema_path, metadata_path, market_path, data_metadata_path):
        if not path.exists():
            raise ExperimentError(f"source_missing:{path.name}")
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    market_data = json.loads(market_path.read_text(encoding="utf-8"))
    data_metadata = json.loads(data_metadata_path.read_text(encoding="utf-8"))
    vm_commit = str(metadata.get("source", {}).get("git_commit") or "")
    local_commit = git_commit()
    if not re.fullmatch(r"[0-9a-fA-F]{40}", vm_commit) or not local_commit:
        raise ExperimentError("vm_or_local_commit_missing")
    if vm_commit.lower() != local_commit.lower() and not reuse_verified_snapshots:
        raise ExperimentError("vm_local_commit_mismatch")
    if str(metadata.get("source", {}).get("git_status_porcelain") or "").strip():
        raise ExperimentError("vm_source_worktree_dirty")
    runtime_paths_clean = _runtime_paths_clean()
    if not runtime_paths_clean and not reuse_verified_snapshots:
        raise ExperimentError("local_runtime_paths_dirty_or_unverifiable")
    if metadata.get("chan_window_policy_version") and metadata.get("chan_window_policy_version") != "chan_window_v7":
        raise ExperimentError("chan_policy_version_mismatch")
    expected_data_hash = data_metadata.get("market_data_sha256")
    if not isinstance(expected_data_hash, str) or not re.fullmatch(r"[0-9a-f]{64}", expected_data_hash):
        raise ExperimentError("market_data_hash_missing")
    if expected_data_hash != market_data.get("market_data_sha256"):
        raise ExperimentError("market_data_hash_mismatch")
    canonical_market = dict(market_data)
    canonical_market.pop("market_data_sha256", None)
    if sha256_bytes(json_bytes(canonical_market)) != expected_data_hash:
        raise ExperimentError("market_data_canonical_hash_mismatch")
    if sha256_file(market_path) != data_metadata.get("market_data_file_sha256"):
        raise ExperimentError("market_data_file_hash_mismatch")
    if json_bytes(metadata.get("data_plan") or {}) != json_bytes(data_metadata.get("plan") or {}):
        raise ExperimentError("runtime_and_capture_data_plan_mismatch")
    capture_source = data_metadata.get("source") or {}
    for key in ("vm_commit", "local_commit"):
        if not re.fullmatch(r"[0-9a-fA-F]{40}", str(capture_source.get(key) or "")):
            raise ExperimentError(f"capture_{key}_missing")
    if str(capture_source.get("vm_commit")).lower() != str(capture_source.get("local_commit")).lower():
        raise ExperimentError("capture_vm_local_commit_mismatch")
    if data_metadata.get("accounts_exported") is not False:
        raise ExperimentError("capture_account_export_boundary_invalid")
    strategy_zh = strategy_path.read_text(encoding="utf-8")
    schema_zh = json.loads(schema_path.read_text(encoding="utf-8"))
    if sha256_file(strategy_path) != metadata.get("strategy_body_sha256"):
        raise ExperimentError("strategy_source_hash_mismatch")
    if sha256_file(schema_path) != metadata.get("output_schema_sha256"):
        raise ExperimentError("schema_source_hash_mismatch")
    if not isinstance(schema_zh, Mapping):
        raise ExperimentError("schema_zh_not_object")
    api_key = None if dry_run else get_api_key()
    client = None if dry_run else ChatClient(
        api_key,
        base_url=base_url,
        max_tokens=max_tokens,
        timeout_seconds=timeout_seconds,
        retry_count=retry_count,
        thinking_enabled=formal_thinking_enabled,
        reasoning_effort="max",
    )
    translation_client = None if dry_run else ChatClient(
        api_key,
        base_url=base_url,
        max_tokens=translation_max_tokens,
        timeout_seconds=DEFAULT_TRANSLATION_TIMEOUT_SECONDS,
        retry_count=DEFAULT_TRANSLATION_RETRY_COUNT,
        thinking_enabled=False,
    )
    english_files_exist = (SOURCE_ROOT / "strategy.en.md").exists() and (SOURCE_ROOT / "output-schema.en.json").exists()
    if dry_run and not english_files_exist:
        # Snapshot construction is language-independent.  A zero-call preflight
        # must therefore be possible before paying for the first translation.
        strategy_en, schema_en = strategy_zh, dict(schema_zh)
        translation_audit = {
            "source": "not_run_dry_run",
            "passed": None,
            "errors": [],
        }
    else:
        strategy_en, schema_en, translation_audit = load_or_translate(
            translation_client,
            strategy_zh=strategy_zh,
            schema_zh=schema_zh,
            source_root=SOURCE_ROOT,
            force=force,
        )
    english_files_exist = (SOURCE_ROOT / "strategy.en.md").exists() and (SOURCE_ROOT / "output-schema.en.json").exists()
    decisions = decision_points(market_data, samples)
    snapshot_path = DATA_ROOT / "strategy-snapshots.json"
    if reuse_verified_snapshots:
        snapshots_payload = _load_verified_snapshot_cache(
            snapshot_path=snapshot_path,
            decisions=decisions,
            metadata=metadata,
            market_data=market_data,
            vm_commit=vm_commit,
        )
        snapshot_build_mode = "verified_cache_from_clean_vm_commit"
    else:
        snapshots_payload = _build_context_snapshots(
            decisions,
            market_path=market_path,
            metadata_path=metadata_path,
            output_path=snapshot_path,
            node=terminal_node,
        )
        snapshot_build_mode = "rebuilt_from_clean_local_runtime"
    snapshots = snapshots_payload.get("snapshots")
    if not isinstance(snapshots, list) or len(snapshots) != len(decisions):
        raise ExperimentError("snapshot_count_mismatch")
    for item, decision in zip(snapshots, decisions):
        item["decision_id"] = decision["decision_id"]
        if item.get("decision_time_utc_msc") != decision["decision_time_utc_msc"]:
            raise ExperimentError("snapshot_decision_time_mismatch")
        if item.get("future_leakage") is not False:
            raise ExperimentError("snapshot_future_leakage")
    strategies = {"zh": strategy_zh, "en": strategy_en}
    schemas = {"zh": schema_zh, "en": schema_en}
    policy = metadata.get("policy") or {}
    allowed_methods = [str(value).lower() for value in policy.get("entry_methods") or metadata.get("entry_methods") or ["market"]]
    results = []
    if client is not None:
        results = run_formal_calls(
            client=client,
            snapshots=snapshots,
            strategies=strategies,
            schemas=schemas,
            allowed_methods=allowed_methods,
            market_data=market_data,
            results_root=RESULTS_ROOT,
            force=force,
        )
    output = {
        "experiment_version": "deepseek-v4-pro-0813-bilingual-2x2-v3",
        "model": MODEL_NAME,
        "base_url": base_url,
        "parameters": {
            "temperature": None if client and client.thinking_enabled else (client.temperature if client else None),
            "top_p": None if client and client.thinking_enabled else 1,
            "max_tokens": client.max_tokens if client else DEFAULT_MAX_TOKENS,
            "translation_max_tokens": translation_max_tokens,
            "formal_timeout_seconds": timeout_seconds,
            "formal_retry_count": retry_count,
            "formal_thinking": (
                {"type": "enabled", "reasoning_effort": "max"}
                if formal_thinking_enabled else {"type": "disabled"}
            ),
            "translation_thinking": {"type": "disabled"},
            "stream": False,
            "response_format": {"type": "json_object"},
        },
        "design": {
            "cells": [{"group": group, "strategy_language": strategy_language, "schema_language": schema_language} for group, strategy_language, schema_language in GROUPS],
            "requested_samples": samples,
            "actual_samples": len(decisions),
            "formal_calls_expected": len(decisions) * len(GROUPS),
            "market_payload_shared": True,
            "response_language": "zh-CN (fixed across all cells by the VM contract)",
            "strategy_factor": "strategy body plus its compact-input rule language; semantics intended equivalent",
            "schema_factor": "output-contract block language only; task wrapper, keys, enums, response language, and semantics fixed",
            "user_wrapper_language": "zh-CN (fixed across all cells)",
            "position_management_schema": "not included; empty-account historical replay",
            "snapshot_build_mode": snapshot_build_mode,
            "local_runtime_paths_clean_at_run": runtime_paths_clean,
        },
        "source_hashes": {
            "strategy_zh_sha256": sha256_file(strategy_path),
            "schema_zh_sha256": sha256_file(schema_path),
            "strategy_en_sha256": sha256_file(SOURCE_ROOT / "strategy.en.md") if english_files_exist else None,
            "schema_en_sha256": sha256_file(SOURCE_ROOT / "output-schema.en.json") if english_files_exist else None,
            "runtime_metadata_sha256": sha256_file(metadata_path),
            "market_data_file_sha256": sha256_file(market_path),
            "market_data_payload_sha256": market_data.get("market_data_sha256"),
        },
        "source_sizes": {
            "strategy_zh_chars": len(strategy_zh),
            "strategy_zh_bytes": len(strategy_zh.encode("utf-8")),
            "strategy_en_chars": len(strategy_en),
            "strategy_en_bytes": len(strategy_en.encode("utf-8")),
            "schema_zh_bytes": len(json_bytes(schema_zh)),
            "schema_en_bytes": len(json_bytes(schema_en)),
        },
        "source": {
            "vm_commit": vm_commit,
            "local_commit": local_commit,
            "snapshot_runtime_commit": vm_commit if reuse_verified_snapshots else local_commit,
            "vm_branch": metadata.get("source", {}).get("git_branch"),
            "vm_exported_at_utc": metadata.get("exported_at_utc"),
            "symbol": market_data.get("symbol"),
            "strategy": metadata.get("strategy"),
            "strategy_body_sha256": metadata.get("strategy_body_sha256"),
            "output_schema_version": metadata.get("output_schema_version"),
            "output_schema_sha256": metadata.get("output_schema_sha256"),
            "latest_inference_snapshot": metadata.get("latest_inference_snapshot"),
            "runtime_data_plan": metadata.get("data_plan"),
            "entry_methods": metadata.get("entry_methods"),
            "chan_window_policy_version": metadata.get("chan_window_policy_version"),
            "market_window": market_data.get("window"),
            "data_metadata": data_metadata,
        },
        "decisions": decisions,
        "translation_audit": translation_audit,
        "out_of_band_attempts": (
            json.loads((RESULTS_ROOT / "out-of-band-attempts.json").read_text(encoding="utf-8"))
            if (RESULTS_ROOT / "out-of-band-attempts.json").exists() else None
        ),
        "snapshots_file": str(snapshot_path),
        "snapshots_file_sha256": sha256_file(snapshot_path),
        "calls": results,
        "dry_run": dry_run,
        "generated_at_utc": dt.datetime.now(UTC).isoformat(),
    }
    write_json(RESULTS_ROOT / "experiment.json", output)
    if not dry_run:
        try:
            from build_report import build_report
            build_report(experiment_path=RESULTS_ROOT / "experiment.json")
        except ImportError as exc:
            raise ExperimentError("report_builder_unavailable") from exc
    return output


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="DeepSeek bilingual XAUUSD frozen replay")
    parser.add_argument("--samples", type=int, default=8)
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--node", default="node")
    parser.add_argument("--force", action="store_true", help="explicitly replace successful per-cell records")
    parser.add_argument("--dry-run", action="store_true", help="build/validate snapshots without provider calls")
    parser.add_argument("--max-tokens", type=int, default=DEFAULT_MAX_TOKENS)
    parser.add_argument("--translation-max-tokens", type=int, default=DEFAULT_TRANSLATION_MAX_TOKENS)
    parser.add_argument("--timeout-seconds", type=int, default=DEFAULT_TIMEOUT_SECONDS)
    parser.add_argument("--retry-count", type=int, default=DEFAULT_RETRY_COUNT)
    parser.add_argument("--thinking-mode", choices=("disabled", "enabled"), default="disabled")
    parser.add_argument(
        "--reuse-verified-snapshots",
        action="store_true",
        help="reuse a snapshot file whose source hashes and clean VM/local commit provenance all match",
    )
    args = parser.parse_args(argv)
    try:
        result = run(
            samples=max(1, args.samples),
            base_url=args.base_url,
            terminal_node=args.node,
            force=args.force,
            dry_run=args.dry_run,
            max_tokens=max(512, args.max_tokens),
            translation_max_tokens=max(4096, args.translation_max_tokens),
            timeout_seconds=max(30, args.timeout_seconds),
            retry_count=max(0, args.retry_count),
            formal_thinking_enabled=args.thinking_mode == "enabled",
            reuse_verified_snapshots=args.reuse_verified_snapshots,
        )
    except ExperimentError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print(json.dumps({
        "ok": True,
        "samples": result["design"]["actual_samples"],
        "formal_calls_expected": result["design"]["formal_calls_expected"],
        "dry_run": result["dry_run"],
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
