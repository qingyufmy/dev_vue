"""Shared, side-effect-free helpers for the isolated DeepSeek experiment.

The experiment deliberately keeps these helpers independent of the AURUM
runtime.  The only runtime code that is imported is used by the Node market
context helper, where it is needed to reproduce the production market/Chan
calculation on a frozen, local snapshot.
"""

from __future__ import annotations

import csv
import datetime as dt
import hashlib
import json
import math
import os
import re
import statistics
import subprocess
from collections import Counter
from pathlib import Path
from typing import Any, Iterable, Mapping


EXPERIMENT_ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS_ROOT = EXPERIMENT_ROOT / "artifacts"
SOURCE_ROOT = ARTIFACTS_ROOT / "source"
DATA_ROOT = ARTIFACTS_ROOT / "data"
RESULTS_ROOT = ARTIFACTS_ROOT / "results"

UTC = dt.timezone.utc
TIMEFRAME_MINUTES: dict[str, int] = {
    "M1": 1,
    "M5": 5,
    "M15": 15,
    "M30": 30,
    "H1": 60,
    "H4": 240,
    "D1": 1440,
    "W1": 10080,
}
CHAN_POLICY = {
    "M5": {"target": 1800, "validators": [1400, 1600, 1800]},
    "M15": {"target": 2000, "validators": [1600, 1800, 2000]},
    "H1": {"target": 1800, "validators": [1400, 1600, 1800]},
    "H4": {"target": 1000, "validators": [600, 800, 1000]},
}
CHAN_POLICY_VERSION = "chan_window_v7"
CHAN_POLICY_ID = "dao_xau_v1"
VALID_ENTRY_METHODS = ("market", "limit", "stop", "stop_limit")
SIGNAL_BY_METHOD = {
    "market": ("buy", "sell"),
    "limit": ("buy_limit", "sell_limit"),
    "stop": ("buy_stop", "sell_stop"),
    "stop_limit": ("buy_stop_limit", "sell_stop_limit"),
}
SIGNAL_ENTRY_METHOD = {
    "buy": "market",
    "sell": "market",
    "buy_limit": "limit",
    "sell_limit": "limit",
    "buy_stop": "stop",
    "sell_stop": "stop",
    "buy_stop_limit": "stop_limit",
    "sell_stop_limit": "stop_limit",
    "hold": "observe",
}


def ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def json_bytes(value: Any, *, pretty: bool = False) -> bytes:
    if pretty:
        text = json.dumps(value, ensure_ascii=False, indent=2, sort_keys=False)
    else:
        text = json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=False)
    return text.encode("utf-8")


def write_json(path: Path, value: Any, *, pretty: bool = True) -> str:
    ensure_dir(path.parent)
    raw = json_bytes(value, pretty=pretty)
    path.write_bytes(raw + b"\n")
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def sha256_bytes(value: bytes | str) -> str:
    if isinstance(value, str):
        value = value.encode("utf-8")
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def utc_now_ms() -> int:
    return int(dt.datetime.now(UTC).timestamp() * 1000)


def utc_iso(value_ms: int | float | None) -> str | None:
    if value_ms is None:
        return None
    try:
        value = float(value_ms)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(value):
        return None
    return dt.datetime.fromtimestamp(value / 1000, UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_utc_ms(value: Any) -> int | None:
    """Parse an explicit UTC timestamp; naive timestamps are rejected."""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        number = float(value)
        if math.isfinite(number):
            if abs(number) < 1_000_000_000_000:
                number *= 1000
            return int(number)
        return None
    text = str(value or "").strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = dt.datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return int(parsed.astimezone(UTC).timestamp() * 1000)


def timeframe_minutes(timeframe: str) -> int:
    key = str(timeframe or "").strip().upper()
    if key not in TIMEFRAME_MINUTES:
        raise ValueError(f"unsupported_timeframe:{key or 'empty'}")
    return TIMEFRAME_MINUTES[key]


def bar_open_ms(bar: Mapping[str, Any]) -> int | None:
    for key in ("time_utc_msc", "time_utc", "time_msc"):
        parsed = parse_utc_ms(bar.get(key))
        if parsed is not None and parsed > 0:
            return parsed
    return parse_utc_ms(bar.get("time"))


def bar_close_ms(bar: Mapping[str, Any], timeframe: str) -> int | None:
    opened = bar_open_ms(bar)
    return opened + timeframe_minutes(timeframe) * 60_000 if opened is not None else None


def normalize_data_plan(value: Any, *, fallback_prompt: str = "") -> dict[str, Any]:
    """Normalize the VM plan without changing its declared timeframe order."""
    parsed = value
    if isinstance(parsed, str):
        try:
            parsed = json.loads(parsed)
        except json.JSONDecodeError:
            parsed = None
    if not isinstance(parsed, Mapping):
        parsed = {}
    raw_items = parsed.get("timeframes")
    if not isinstance(raw_items, list):
        raw_items = []
    items: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in raw_items:
        if not isinstance(item, Mapping):
            continue
        timeframe = str(item.get("timeframe", item.get("tf", ""))).strip().upper()
        if timeframe not in TIMEFRAME_MINUTES or timeframe in seen:
            continue
        raw_count = item.get("kline_count", item.get("count", 100))
        try:
            count = int(float(raw_count))
        except (TypeError, ValueError):
            count = 100
        count = max(10, min(500, count))
        items.append({"timeframe": timeframe, "kline_count": count})
        seen.add(timeframe)
    if not items:
        # This fallback is only for offline fixtures.  A live run requires the
        # export artifact and therefore cannot silently use this value.
        found = re.findall(r"\b(?:M1|M5|M15|M30|H1|H4|D1|W1)\b", fallback_prompt.upper())
        timeframe = found[0] if found else "M30"
        items = [{"timeframe": timeframe, "kline_count": 100}]
    requested_primary = str(parsed.get("primary_timeframe", "")).strip().upper()
    primary = requested_primary if requested_primary in seen else items[0]["timeframe"]
    items.sort(key=lambda item: 0 if item["timeframe"] == primary else 1)
    return {"primary_timeframe": primary, "timeframes": items}


def strategy_chan_policy(timeframe: str) -> dict[str, Any]:
    key = str(timeframe or "").upper()
    configured = CHAN_POLICY.get(key)
    if configured is None:
        return {
            "timeframe": key,
            "target": 0,
            "validators": [],
            "maximum_history_count": 0,
            "window_policy_version": "unsupported",
            "policy_id": CHAN_POLICY_ID,
            "supported": False,
            "reason": "unsupported_timeframe_policy",
        }
    return {
        "timeframe": key,
        "target": configured["target"],
        "validators": list(configured["validators"]),
        "maximum_history_count": configured["target"],
        "window_policy_version": CHAN_POLICY_VERSION,
        "policy_id": CHAN_POLICY_ID,
        "supported": True,
    }


def redact_secrets(text: Any, secret: str | None = None) -> str:
    result = str(text or "")
    if secret:
        result = result.replace(secret, "[REDACTED]")
    result = re.sub(r"(?i)(authorization\s*:\s*bearer\s+)[^\s,}\"]+", r"\1[REDACTED]", result)
    result = re.sub(r"(?i)(bearer\s+)[A-Za-z0-9._~+/=-]{12,}", r"\1[REDACTED]", result)
    result = re.sub(r"(?i)(api[_ -]?key\s*[:=]\s*)[^\s,}\"]+", r"\1[REDACTED]", result)
    return result


def git_commit(path: Path = EXPERIMENT_ROOT.parent.parent.parent) -> str | None:
    """Return the repository HEAD without mutating the worktree."""
    try:
        result = subprocess.run(
            ["git", "-C", str(path), "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    value = result.stdout.strip()
    return value if result.returncode == 0 and re.fullmatch(r"[0-9a-fA-F]{40}", value) else None


def extract_json_object(content: Any) -> tuple[Any | None, str | None]:
    """Parse only assistant content, tolerating a surrounding code fence."""
    if isinstance(content, list):
        pieces = []
        for item in content:
            if isinstance(item, Mapping):
                pieces.append(str(item.get("text", item.get("content", ""))))
            else:
                pieces.append(str(item))
        text = "".join(pieces).strip()
    elif isinstance(content, Mapping):
        text = json.dumps(content, ensure_ascii=False)
    else:
        text = str(content or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.I)
        text = re.sub(r"\s*```$", "", text).strip()
    try:
        return json.loads(text), None
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start >= 0 and end > start:
            try:
                return json.loads(text[start : end + 1]), None
            except json.JSONDecodeError:
                pass
    return None, "assistant_content_not_valid_json"


def parse_json_object_strict(content: Any) -> tuple[Any | None, str | None]:
    """Parse formal output without fences, prefix/suffix trimming, or repair."""
    if not isinstance(content, str):
        return None, "assistant_content_not_json_string"
    try:
        return json.loads(content), None
    except json.JSONDecodeError:
        return None, "assistant_content_not_valid_json"


PROTECTED_ENUM_TOKENS = {
    "buy", "sell", "hold", "buy_limit", "sell_limit", "buy_stop", "sell_stop",
    "buy_stop_limit", "sell_stop_limit", "market", "limit", "stop", "stop_limit",
    "observe", "probe", "light", "standard", "open", "hold_no_add", "allow_add",
    "none", "keep", "cancel", "pass", "fail", "not_applicable",
}
PROTECTED_TOKEN_RE = re.compile(
    r"\{\{[^{}]+\}\}|(?:M15|M30|M1|M5|H1|H4|D1|W1)|"
    r"(?<![A-Za-z0-9_])[-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:%|倍|[xX])?|"
    r"(?<![A-Za-z0-9_])[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+(?![A-Za-z0-9_])"
)


def protected_tokens(value: str, *, include_enums: bool = True) -> Counter[str]:
    tokens = Counter(PROTECTED_TOKEN_RE.findall(str(value or "")))
    if include_enums:
        lower = str(value or "").lower()
        for token in PROTECTED_ENUM_TOKENS:
            tokens[token] += len(re.findall(rf"(?<![A-Za-z0-9_]){re.escape(token)}(?![A-Za-z0-9_])", lower))
    return tokens


def _compare_translated_values(source: Any, target: Any, path: str = "$") -> list[str]:
    if isinstance(source, Mapping):
        if not isinstance(target, Mapping) or list(source.keys()) != list(target.keys()):
            return [f"schema_shape:{path}"]
        errors: list[str] = []
        for key in source:
            errors.extend(_compare_translated_values(source[key], target[key], f"{path}.{key}"))
        return errors
    if isinstance(source, list):
        if not isinstance(target, list) or len(source) != len(target):
            return [f"schema_shape:{path}"]
        errors: list[str] = []
        for index, child in enumerate(source):
            errors.extend(_compare_translated_values(child, target[index], f"{path}[{index}]"))
        return errors
    if isinstance(source, str):
        if not isinstance(target, str):
            return [f"schema_value_type:{path}"]
        missing = protected_tokens(source) - protected_tokens(target)
        return [f"schema_tokens_changed:{path}:{dict(missing)}"] if missing else []
    return [] if source == target else [f"schema_literal_changed:{path}"]


def validate_translation(
    strategy_zh: str,
    strategy_en: str,
    schema_zh: Mapping[str, Any],
    schema_en: Any,
) -> dict[str, Any]:
    errors: list[str] = []
    if not isinstance(strategy_en, str) or not strategy_en.strip():
        errors.append("strategy_en_empty")
    if not isinstance(schema_en, Mapping) or isinstance(schema_en, list):
        errors.append("schema_en_not_object")
    else:
        errors.extend(_compare_translated_values(schema_zh, schema_en))
    strategy_missing = protected_tokens(strategy_zh, include_enums=False) - protected_tokens(strategy_en or "", include_enums=False)
    if strategy_missing:
        errors.append(f"strategy_tokens_changed:{dict(strategy_missing)}")
    return {
        "passed": not errors,
        "errors": errors,
        "strategy_protected_tokens_zh": dict(protected_tokens(strategy_zh, include_enums=False)),
        "strategy_protected_tokens_en": dict(protected_tokens(strategy_en or "", include_enums=False)),
        "schema_keys_zh": list(schema_zh.keys()),
        "schema_keys_en": list(schema_en.keys()) if isinstance(schema_en, Mapping) else [],
    }


def direction_for_signal(signal_type: Any) -> str:
    value = str(signal_type or "").strip().lower()
    if value in {"buy", "buy_limit", "buy_stop", "buy_stop_limit"}:
        return "buy"
    if value in {"sell", "sell_limit", "sell_stop", "sell_stop_limit"}:
        return "sell"
    if value == "hold":
        return "hold"
    return "unknown"


def schema_key_coverage(parsed: Any, schema: Mapping[str, Any]) -> dict[str, Any]:
    if not isinstance(parsed, Mapping):
        return {"schema_keys": len(schema), "response_keys": 0, "missing": list(schema), "extra": []}
    keys = set(parsed)
    expected = set(schema)
    return {
        "schema_keys": len(expected),
        "response_keys": len(keys),
        "missing": [key for key in schema if key not in keys],
        "extra": sorted(keys - expected),
    }


def validate_signal_output(
    parsed: Any,
    schema: Mapping[str, Any],
    allowed_methods: Iterable[str],
    market_price: float | None = None,
) -> dict[str, Any]:
    errors: list[str] = []
    coverage = schema_key_coverage(parsed, schema)
    if not isinstance(parsed, Mapping) or isinstance(parsed, list):
        return {"passed": False, "errors": ["response_not_object"], "coverage": coverage}
    errors.extend(f"schema_key_missing:{key}" for key in coverage.get("missing", []))
    errors.extend(f"schema_key_extra:{key}" for key in coverage.get("extra", []))
    methods = {str(value).lower() for value in allowed_methods}
    allowed_signals = {"hold"}
    for method in methods:
        allowed_signals.update(SIGNAL_BY_METHOD.get(method, ()))
    signal = str(parsed.get("signal_type", "")).strip().lower()
    entry = str(parsed.get("entry_method", "")).strip().lower()
    if signal not in allowed_signals:
        errors.append("signal_type_invalid")
    if entry not in methods | {"observe"}:
        errors.append("entry_method_invalid")
    if SIGNAL_ENTRY_METHOD.get(signal) != entry:
        errors.append("signal_entry_method_mismatch")
    confidence = parsed.get("confidence")
    try:
        if isinstance(confidence, bool) or not 0 <= float(confidence) <= 1:
            errors.append("confidence_out_of_range")
    except (TypeError, ValueError):
        errors.append("confidence_not_number")
    required = (
        "signal_type", "entry_method", "confidence", "position_size_tier", "position_size_reason",
        "position_action", "pending_action", "pending_action_reason", "management_direction",
        "hard_gate_status", "hard_gate_failures", "minimum_reward_to_risk", "recommended_reward_to_risk",
        "reward_to_risk_status", "recommended_take_profit_tier", "decision_summary", "trigger_condition",
        "invalidation_condition", "key_reasons", "risk_factors", "analysis", "reasoning", "experience_usage",
    )
    errors.extend(f"required_field_missing:{key}" for key in required if key not in parsed)
    failures = parsed.get("hard_gate_failures")
    if not isinstance(failures, list):
        errors.append("hard_gate_failures_not_array")
    for key in ("key_reasons", "risk_factors"):
        if not isinstance(parsed.get(key), list):
            errors.append(f"{key}_not_array")
    for key in ("bullish_score", "bearish_score"):
        if key not in schema or parsed.get(key) is None:
            continue
        if isinstance(parsed.get(key), bool) or _number(parsed.get(key)) is None:
            errors.append(f"{key}_not_number")
    experience = parsed.get("experience_usage")
    if not isinstance(experience, Mapping):
        errors.append("experience_usage_not_object")
    else:
        # This isolated replay never supplies memory/reference material.  The
        # VM schema explicitly requires empty arrays and an empty influence in
        # that case; echoing the schema's instructional prose is not compliant.
        for key in ("considered_refs", "used_refs", "rejected_refs", "considered_ids", "used_ids", "rejected_ids"):
            value = experience.get(key)
            if not isinstance(value, list):
                errors.append(f"experience_{key}_not_array")
            elif value:
                errors.append(f"experience_{key}_nonempty_without_memory")
        influence = experience.get("influence")
        if not isinstance(influence, str):
            errors.append("experience_influence_not_string")
        elif influence.strip():
            errors.append("experience_influence_nonempty_without_memory")
    position_action = str(parsed.get("position_action", "")).lower()
    gate = str(parsed.get("hard_gate_status", "")).lower()
    if signal == "hold":
        if entry != "observe":
            errors.append("hold_entry_not_observe")
        if position_action not in {"observe", "hold_no_add"}:
            errors.append("hold_position_action_invalid")
        if gate != "fail":
            errors.append("hold_hard_gate_not_fail")
        if not isinstance(failures, list) or not failures:
            errors.append("hold_hard_gate_failures_empty")
        if parsed.get("recommended_take_profit_tier") is not None:
            errors.append("hold_tp_tier_not_null")
        if parsed.get("position_size_tier") != "observe":
            errors.append("hold_position_size_tier_not_observe")
    else:
        if position_action not in {"open", "allow_add"}:
            errors.append("trade_position_action_invalid")
        if gate != "pass":
            errors.append("trade_hard_gate_not_pass")
        if isinstance(failures, list) and failures:
            errors.append("trade_hard_gate_failures_not_empty")
        if parsed.get("position_size_tier") not in {"probe", "light", "standard"}:
            errors.append("trade_position_size_tier_invalid")
        try:
            tier = int(parsed.get("recommended_take_profit_tier"))
            if tier not in {1, 2, 3}:
                raise ValueError
        except (TypeError, ValueError):
            errors.append("trade_tp_tier_invalid")
        # The production schema intentionally has no mandatory reference_price
        # field for market orders: the latest closed price is part of the
        # frozen market snapshot.  For pending orders, market_price is the
        # frozen current price and is the only price used for mechanical
        # pending-direction checks.  A model-supplied reference_price can be
        # used only as the optional market-order anchor.
        direction = direction_for_signal(signal)
        current_price = _number(market_price)
        reference = None
        if entry == "market":
            reference = _number(parsed.get("reference_price"))
            if reference is None:
                reference = current_price
            if reference is None:
                errors.append("execution_reference_price_unavailable")
        elif entry in {"limit", "stop", "stop_limit"}:
            trigger_or_limit = _number(parsed.get("limit_price"))
            if trigger_or_limit is None:
                errors.append("pending_limit_price_missing")
            else:
                if current_price is None:
                    errors.append("pending_reference_price_unavailable")
                elif direction in {"buy", "sell"}:
                    if entry == "limit":
                        direction_invalid = (
                            trigger_or_limit >= current_price
                            if direction == "buy"
                            else trigger_or_limit <= current_price
                        )
                    else:
                        # stop and stop_limit use limit_price as the trigger;
                        # a buy trigger must be above current and a sell
                        # trigger must be below current.
                        direction_invalid = (
                            trigger_or_limit <= current_price
                            if direction == "buy"
                            else trigger_or_limit >= current_price
                        )
                    if direction_invalid:
                        errors.append("pending_price_direction_invalid")

                if entry == "stop_limit":
                    stop_limit_price = _number(parsed.get("stop_limit_price"))
                    if stop_limit_price is None:
                        errors.append("stop_limit_price_required")
                    else:
                        if direction == "buy" and stop_limit_price > trigger_or_limit:
                            errors.append("stop_limit_price_relation_invalid")
                        elif direction == "sell" and stop_limit_price < trigger_or_limit:
                            errors.append("stop_limit_price_relation_invalid")
                        # A stop-limit becomes a limit order at this price;
                        # SL/TP must be anchored to the actual limit entry,
                        # not to the trigger price.
                        reference = stop_limit_price
                else:
                    # limit_price is both the pending entry and the SL/TP
                    # anchor for ordinary limit/stop orders.
                    reference = trigger_or_limit
        actual_rr = None
        try:
            sl = float(parsed.get("stop_loss_price"))
            tp = float(parsed.get(f"take_profit_{int(parsed.get('recommended_take_profit_tier'))}_price"))
            reference_number = float(reference)
            if direction == "buy" and not (sl < reference_number < tp):
                errors.append("buy_price_direction_invalid")
            if direction == "sell" and not (sl > reference_number > tp):
                errors.append("sell_price_direction_invalid")
            risk = abs(reference_number - sl)
            reward = abs(tp - reference_number)
            if risk <= 0:
                errors.append("reward_risk_zero")
            else:
                actual_rr = reward / risk
        except (TypeError, ValueError):
            errors.append("trade_price_fields_missing")
        declared_rr = _number(parsed.get("recommended_reward_to_risk"))
        minimum_rr = _number(parsed.get("minimum_reward_to_risk"))
        if declared_rr is not None and actual_rr is not None and abs(declared_rr - actual_rr) > max(0.05, actual_rr * 0.05):
            errors.append("recommended_reward_risk_inconsistent")
        declared_status = str(parsed.get("reward_to_risk_status", "")).lower()
        if minimum_rr is not None and actual_rr is not None:
            expected_status = "pass" if actual_rr >= minimum_rr else "fail"
            if declared_status != expected_status:
                errors.append("reward_risk_status_inconsistent")
        elif declared_status not in {"not_applicable", "pass", "fail"}:
            errors.append("reward_risk_status_invalid")
    if str(parsed.get("pending_action", "")).lower() not in {"none", "keep", "cancel"}:
        errors.append("pending_action_invalid")
    if str(parsed.get("management_direction", "")).lower() not in {"buy", "sell", "none"}:
        errors.append("management_direction_invalid")
    if str(parsed.get("reward_to_risk_status", "")).lower() not in {"pass", "fail", "not_applicable"}:
        errors.append("reward_to_risk_status_invalid")
    return {"passed": not errors, "errors": errors, "coverage": coverage}


NARRATIVE_FIELDS = (
    "decision_summary", "trigger_condition", "invalidation_condition", "position_size_reason",
    "pending_action_reason", "analysis", "reasoning", "key_reasons", "risk_factors",
)


def natural_language_adherence(parsed: Any, language: str) -> dict[str, Any]:
    """Measure output-language shape; this is a language proxy, not truth QA."""
    values: list[str] = []
    if isinstance(parsed, Mapping):
        for key in NARRATIVE_FIELDS:
            value = parsed.get(key)
            if isinstance(value, str):
                values.append(value)
            elif isinstance(value, list):
                values.extend(item for item in value if isinstance(item, str))
        experience = parsed.get("experience_usage")
        if isinstance(experience, Mapping) and isinstance(experience.get("influence"), str):
            values.append(experience["influence"])
    checks = []
    for value in values:
        if not value.strip():
            continue
        has_cjk = bool(re.search(r"[\u3400-\u9fff]", value))
        has_latin = bool(re.search(r"[A-Za-z]", value))
        # Chinese prose may legitimately retain technical abbreviations such
        # as ATR/EMA; English prose is required to contain no Chinese prose.
        passed = has_cjk if language == "zh" else (has_latin and not has_cjk)
        checks.append({"passed": passed, "has_cjk": has_cjk, "has_latin": has_latin})
    return {
        "language": language,
        "fields_checked": len(checks),
        "passed_fields": sum(item["passed"] for item in checks),
        "rate": sum(item["passed"] for item in checks) / len(checks) if checks else None,
        "checks": checks,
        "interpretation": "language adherence proxy only; not a hallucination or factuality verdict",
    }


def structural_contract_eligibility(validation: Mapping[str, Any] | None) -> dict[str, Any]:
    """Return whether a parsed response may enter the market replay.

    The experiment has no memory input.  The VM schema nevertheless contains
    instructional prose for ``experience_usage`` and a model can echo that
    prose into one of the fields.  Those narrowly-scoped
    ``experience_*_nonempty_without_memory`` errors remain useful for strict
    contract reporting, but do not invalidate a market replay by themselves.
    Every other validation error, including a missing/failed validation, is a
    hard replay gate.
    """
    if not isinstance(validation, Mapping):
        return {
            "eligible": False,
            "strict_passed": False,
            "errors": ["validation_missing"],
            "blocked_errors": ["validation_missing"],
            "exempted_errors": [],
            "reason": "validation_missing",
        }

    raw_errors = validation.get("errors")
    if isinstance(raw_errors, (list, tuple, set)):
        errors = [str(error).split(":", 1)[0] for error in raw_errors if str(error)]
    elif raw_errors:
        errors = [str(raw_errors).split(":", 1)[0]]
    else:
        errors = []
    exempted = [
        error
        for error in errors
        if error.startswith("experience_") and error.endswith("_nonempty_without_memory")
    ]
    blocked = [error for error in errors if error not in exempted]
    strict_passed = validation.get("passed") is True and not errors
    # A false validation with no detail must not become a fail-open replay.
    if validation.get("passed") is not True and not errors:
        blocked = ["contract_validation_failed"]
    eligible = not blocked
    if strict_passed:
        reason = "strict_contract_pass"
    elif eligible:
        reason = "only_no_memory_instruction_echo"
    else:
        reason = "blocked_contract_errors"
    return {
        "eligible": eligible,
        "strict_passed": strict_passed,
        "errors": errors,
        "blocked_errors": blocked,
        "exempted_errors": exempted,
        "reason": reason,
    }


def structural_contract_passed(validation: Mapping[str, Any] | None) -> bool:
    """Convenient boolean form of :func:`structural_contract_eligibility`."""
    return bool(structural_contract_eligibility(validation)["eligible"])


def _number(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _future_direction(close: float | None, reference: float | None, direction: str) -> float | None:
    if close is None or reference is None or reference == 0 or direction not in {"buy", "sell"}:
        return None
    sign = 1 if direction == "buy" else -1
    return sign * (close - reference) / abs(reference) * 100


def _bars_until(bars: list[Mapping[str, Any]], start_ms: int, end_ms: int) -> list[Mapping[str, Any]]:
    return [bar for bar in bars if (opened := bar_open_ms(bar)) is not None and start_ms <= opened < end_ms]


def _m1_window_coverage(bars: list[Mapping[str, Any]], start_ms: int, end_ms: int) -> dict[str, Any]:
    window = _bars_until(bars, start_ms, end_ms)
    observed = {bar_open_ms(bar) for bar in window}
    expected = set(range(start_ms, end_ms, 60_000))
    missing = sorted(value for value in expected if value not in observed)
    return {
        "status": "available" if not missing else ("unavailable" if not window else "partial"),
        "expected_bars": len(expected),
        "observed_bars": len(observed & expected),
        "missing_bars": len(missing),
        "first_missing_utc_msc": missing[0] if missing else None,
    }


def simulate_outcome(
    parsed: Any,
    market_data: Mapping[str, Any],
    market_snapshot: Mapping[str, Any],
    decision_ms: int,
    validation: Mapping[str, Any] | None = None,
    contract_eligible: bool | Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Conservative read-only M1 replay shared by all four experiment cells."""
    result: dict[str, Any] = {
        "same_bar_policy": "stop_loss_first",
        "filled": False,
        "status": "not_applicable",
        "entry_price": None,
        "exit_price": None,
        "mfe_price": None,
        "mae_price": None,
        "direction_return_pct": None,
        "direction_return_4h_pct": None,
        "direction_return_12h_pct": None,
        "future_data_4h": "unavailable",
        "future_data_12h": "unavailable",
        "performance_eligible": False,
        "performance_exclusion_reason": "not_evaluated",
    }

    # A replay must never turn a malformed model response into a performance
    # observation.  Keep the gate optional for backwards-compatible offline
    # fixtures that call this helper without validation metadata; production
    # experiment callers should always pass the validation result (or its
    # derived eligibility).
    eligibility: dict[str, Any] | None = None
    if validation is not None:
        eligibility = structural_contract_eligibility(validation)
    if contract_eligible is not None:
        if isinstance(contract_eligible, Mapping):
            # Accept either the helper's result object or a raw validation
            # object so callers do not have to branch on which form they have.
            if "eligible" in contract_eligible:
                eligibility = dict(contract_eligible)
            else:
                eligibility = structural_contract_eligibility(contract_eligible)
        else:
            eligibility = {
                "eligible": bool(contract_eligible),
                "strict_passed": bool(contract_eligible),
                "errors": [],
                "blocked_errors": [] if contract_eligible else ["contract_ineligible"],
                "exempted_errors": [],
                "reason": "caller_supplied_eligibility" if contract_eligible else "caller_supplied_ineligible",
            }
    if eligibility is not None:
        result["contract_eligibility"] = eligibility
        result["contract_eligible"] = bool(eligibility.get("eligible"))
        if not result["contract_eligible"]:
            result["status"] = "invalid_contract"
            result["performance_exclusion_reason"] = "invalid_contract"
            return result

    m1_frame = (market_data.get("timeframes") or {}).get("M1") or {}
    bars = list(m1_frame.get("bars") or m1_frame.get("klines") or [])
    bars = sorted((bar for bar in bars if isinstance(bar, Mapping)), key=lambda bar: bar_open_ms(bar) or 0)
    future_12h = _bars_until(bars, decision_ms, decision_ms + 12 * 3_600_000)
    direction = direction_for_signal(parsed.get("signal_type") if isinstance(parsed, Mapping) else None)
    if direction == "unknown":
        result["status"] = "invalid"
        result["performance_exclusion_reason"] = "unknown_direction"
        return result
    primary = str(market_snapshot.get("primary_timeframe") or "M1").upper()
    reference = _number(market_snapshot.get("latest_price"))
    if reference is None:
        frame = (market_snapshot.get("strategy_context") or {}).get("timeframes", {}).get(primary, {})
        reference = _number((frame.get("summary") or {}).get("latest_price"))
    for hours in (4, 12):
        target = decision_ms + hours * 3_600_000
        candidates = _bars_until(bars, decision_ms, target)
        coverage = _m1_window_coverage(bars, decision_ms, target)
        result[f"future_coverage_{hours}h"] = coverage
        result[f"future_data_{hours}h"] = coverage["status"]
        if candidates and coverage["status"] == "available":
            close = _number(candidates[-1].get("close"))
            result[f"direction_return_{hours}h_pct"] = _future_direction(close, reference, direction)
    if direction == "hold":
        result["status"] = "not_applicable"
        result["performance_exclusion_reason"] = "hold_has_no_trade_replay"
        return result
    if result.get("future_data_12h") != "available":
        result["status"] = "insufficient_future"
        result["performance_exclusion_reason"] = "incomplete_future_m1"
        return result
    if not isinstance(parsed, Mapping):
        result["status"] = "invalid"
        result["performance_exclusion_reason"] = "response_not_object"
        return result
    signal = str(parsed.get("signal_type", "")).lower()
    entry_method = str(parsed.get("entry_method", "")).lower()
    if entry_method == "stop_limit" or "stop_limit" in signal:
        result["status"] = "unsupported_stop_limit"
        result["performance_exclusion_reason"] = "unsupported_stop_limit_replay"
        return result
    sl = _number(parsed.get("stop_loss_price"))
    tier = parsed.get("recommended_take_profit_tier")
    try:
        tier_number = int(tier)
    except (TypeError, ValueError):
        tier_number = 1
    tp = _number(parsed.get(f"take_profit_{tier_number}_price")) or _number(parsed.get("take_profit_1_price"))
    limit_price = _number(parsed.get("limit_price"))
    if sl is None or tp is None:
        result["status"] = "invalid"
        result["performance_exclusion_reason"] = "missing_trade_prices"
        return result
    result["performance_eligible"] = True
    result["performance_exclusion_reason"] = None
    fill_index: int | None = None
    fill_price: float | None = None
    for index, bar in enumerate(future_12h):
        high = _number(bar.get("high"))
        low = _number(bar.get("low"))
        opened = _number(bar.get("open"))
        if high is None or low is None:
            continue
        if entry_method == "market":
            if opened is not None:
                fill_index, fill_price = index, opened
                break
        elif entry_method == "limit" and limit_price is not None:
            if (direction == "buy" and low <= limit_price) or (direction == "sell" and high >= limit_price):
                fill_index, fill_price = index, limit_price
                break
        elif entry_method == "stop" and limit_price is not None:
            if (direction == "buy" and high >= limit_price) or (direction == "sell" and low <= limit_price):
                fill_index, fill_price = index, limit_price
                break
    if fill_index is None or fill_price is None:
        result["status"] = "no_trigger" if entry_method != "market" else "invalid"
        return result
    result["filled"] = True
    result["entry_price"] = fill_price
    favorable = []
    adverse = []
    exit_status = "timeout"
    exit_price = None
    exit_index = len(future_12h) - 1
    for index in range(fill_index, len(future_12h)):
        bar = future_12h[index]
        high = _number(bar.get("high"))
        low = _number(bar.get("low"))
        close = _number(bar.get("close"))
        if high is None or low is None:
            continue
        if direction == "buy":
            favorable.append(high - fill_price)
            adverse.append(fill_price - low)
            sl_hit = low <= sl
            tp_hit = high >= tp
        else:
            favorable.append(fill_price - low)
            adverse.append(high - fill_price)
            sl_hit = high >= sl
            tp_hit = low <= tp
        if sl_hit:
            exit_status, exit_price, exit_index = "sl", sl, index
            break
        if tp_hit:
            exit_status, exit_price, exit_index = "tp", tp, index
            break
        if index == len(future_12h) - 1:
            exit_price = close
    result.update({
        "status": exit_status,
        "exit_price": exit_price,
        "mfe_price": max(favorable) if favorable else 0.0,
        "mae_price": max(adverse) if adverse else 0.0,
        "exit_time_utc": utc_iso((bar_open_ms(future_12h[exit_index]) or 0)) if future_12h else None,
    })
    if exit_price is not None:
        result["return_price"] = (exit_price - fill_price) if direction == "buy" else (fill_price - exit_price)
        result["return_pct"] = result["return_price"] / abs(fill_price) * 100 if fill_price else None
    return result


def percentile(values: Iterable[float], p: float) -> float | None:
    cleaned = sorted(float(value) for value in values if value is not None and math.isfinite(float(value)))
    if not cleaned:
        return None
    if len(cleaned) == 1:
        return cleaned[0]
    index = (len(cleaned) - 1) * p
    low = math.floor(index)
    high = math.ceil(index)
    if low == high:
        return cleaned[low]
    return cleaned[low] + (cleaned[high] - cleaned[low]) * (index - low)


def latency_summary(records: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
    latencies = [float(record["latency_ms"]) for record in records if record.get("latency_ms") is not None]
    return {"count": len(latencies), "p50_ms": percentile(latencies, 0.5), "p95_ms": percentile(latencies, 0.95)}


def write_pairwise_csv(path: Path, rows: Iterable[Mapping[str, Any]]) -> None:
    rows = list(rows)
    ensure_dir(path.parent)
    fields = [
        "sample_index", "decision_time_utc", "pair_id", "strategy_language", "schema_language",
        "signal_type", "entry_method", "contract_passed", "parse_passed", "latency_ms",
        "request_bytes", "response_bytes", "usage_prompt_tokens", "usage_completion_tokens",
        "backtest_status", "filled", "return_pct", "mfe_price", "mae_price",
    ]
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow({field: row.get(field) for field in fields})
