"""Build reproducible JSON/CSV/Markdown comparisons from experiment records."""

from __future__ import annotations

import argparse
import csv
import json
import math
import re
import statistics
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable, Mapping

from common import (
    EXPERIMENT_ROOT,
    RESULTS_ROOT,
    direction_for_signal,
    ensure_dir,
    json_bytes,
    latency_summary,
    percentile,
    sha256_bytes,
    structural_contract_eligibility,
    write_json,
)


GROUP_NAMES = ("zh_zh", "zh_en", "en_zh", "en_en")
DETERMINISTIC_CONTRADICTION_ERRORS = {
    "signal_entry_method_mismatch",
    "hold_entry_not_observe",
    "hold_position_action_invalid",
    "hold_hard_gate_not_fail",
    "hold_hard_gate_failures_empty",
    "hold_tp_tier_not_null",
    "hold_position_size_tier_not_observe",
    "trade_position_action_invalid",
    "trade_hard_gate_not_pass",
    "trade_hard_gate_failures_not_empty",
    "buy_price_direction_invalid",
    "sell_price_direction_invalid",
    "pending_price_direction_invalid",
    "stop_limit_price_relation_invalid",
    "recommended_reward_risk_inconsistent",
    "reward_risk_status_inconsistent",
}
CORE_NARRATIVE_FIELDS = (
    "decision_summary", "trigger_condition", "invalidation_condition", "position_size_reason",
    "pending_action_reason", "analysis", "reasoning", "key_reasons", "risk_factors",
)


def _number(value: Any) -> float | None:
    try:
        value = float(value)
    except (TypeError, ValueError):
        return None
    return value if math.isfinite(value) else None


def _records(experiment: Mapping[str, Any]) -> list[dict[str, Any]]:
    return [record for record in experiment.get("calls", []) if isinstance(record, Mapping)]


def _usage_value(record: Mapping[str, Any], key: str) -> int | None:
    usage = record.get("usage")
    if not isinstance(usage, Mapping):
        return None
    aliases = {
        "prompt_tokens": ("prompt_tokens", "input_tokens"),
        "completion_tokens": ("completion_tokens", "output_tokens"),
        "total_tokens": ("total_tokens",),
        "reasoning_tokens": ("reasoning_tokens",),
    }
    for alias in aliases.get(key, (key,)):
        value = _number(usage.get(alias))
        if value is not None:
            return int(value)
    return None


def _group_summary(records: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
    rows = list(records)
    transport = [row for row in rows if row.get("status") == "success" and int(row.get("http_status") or 0) in range(200, 300)]
    parsed = [row for row in transport if row.get("parse_error") is None and isinstance(row.get("parsed_output"), Mapping)]
    contract = [row for row in parsed if row.get("contract_passed") is True]
    signals = Counter(str((row.get("parsed_output") or {}).get("signal_type", "unknown")).lower() for row in parsed)
    entries = Counter(str((row.get("parsed_output") or {}).get("entry_method", "unknown")).lower() for row in parsed)
    hard_gates = Counter(str((row.get("parsed_output") or {}).get("hard_gate_status", "unknown")).lower() for row in parsed)
    hard_gate_failures = Counter(
        str(item)
        for row in parsed
        for item in ((row.get("parsed_output") or {}).get("hard_gate_failures") or [])
    )
    outcomes = Counter(str((row.get("backtest") or {}).get("status", "unavailable")) for row in parsed)
    performance = [row for row in parsed if (row.get("backtest") or {}).get("performance_eligible") is True]
    exclusions = Counter(
        str((row.get("backtest") or {}).get("performance_exclusion_reason") or "unspecified")
        for row in parsed
        if (row.get("backtest") or {}).get("performance_eligible") is not True
    )
    fills = [row for row in performance if (row.get("backtest") or {}).get("filled") is True]
    wins = [row for row in fills if (row.get("backtest") or {}).get("status") == "tp"]
    mfe = [_number((row.get("backtest") or {}).get("mfe_price")) for row in performance]
    mae = [_number((row.get("backtest") or {}).get("mae_price")) for row in performance]
    returns = [_number((row.get("backtest") or {}).get("return_pct")) for row in fills]
    four_hour = [_number((row.get("backtest") or {}).get("direction_return_4h_pct")) for row in performance]
    twelve_hour = [_number((row.get("backtest") or {}).get("direction_return_12h_pct")) for row in performance]
    lat = latency_summary(transport)
    def clean(values: Iterable[float | None]) -> list[float]:
        return [value for value in values if value is not None]
    prompt_tokens = [value for value in (_usage_value(row, "prompt_tokens") for row in transport) if value is not None]
    completion_tokens = [value for value in (_usage_value(row, "completion_tokens") for row in transport) if value is not None]
    reasoning_tokens = [value for value in (_usage_value(row, "reasoning_tokens") for row in transport) if value is not None]
    confidences = [value for value in (_number((row.get("parsed_output") or {}).get("confidence")) for row in parsed) if value is not None]
    bullish_scores = [value for value in (_number((row.get("parsed_output") or {}).get("bullish_score")) for row in parsed) if value is not None]
    bearish_scores = [value for value in (_number((row.get("parsed_output") or {}).get("bearish_score")) for row in parsed) if value is not None]
    instruction_echo_rows = [
        row for row in parsed
        if str((((row.get("parsed_output") or {}).get("experience_usage") or {}).get("influence")) or "").strip()
    ]
    language_rates = [
        _number((row.get("natural_language_adherence") or {}).get("rate"))
        for row in parsed
    ]
    language_rates = [value for value in language_rates if value is not None]
    core_narrative_deviation_rows = []
    for row in parsed:
        output = row.get("parsed_output") or {}
        values: list[str] = []
        for field in CORE_NARRATIVE_FIELDS:
            value = output.get(field)
            if isinstance(value, str):
                values.append(value)
            elif isinstance(value, list):
                values.extend(str(item) for item in value if isinstance(item, str))
        if any(value.strip() and not re.search(r"[\u3400-\u9fff]", value) for value in values):
            core_narrative_deviation_rows.append(row)
    validation_errors = Counter()
    contradiction_rows = 0
    structural_contract_rows = 0
    for row in parsed:
        errors = (row.get("validation") or {}).get("errors") or []
        normalized = {str(error).split(":", 1)[0] for error in errors}
        validation_errors.update(normalized)
        if structural_contract_eligibility(row.get("validation"))["eligible"]:
            structural_contract_rows += 1
        if normalized & DETERMINISTIC_CONTRADICTION_ERRORS:
            contradiction_rows += 1
    return {
        "total_calls": len(rows),
        "transport_success": len(transport),
        "json_parse_success": len(parsed),
        "contract_success": len(contract),
        "structural_contract_success": structural_contract_rows,
        "transport_success_rate": len(transport) / len(rows) if rows else None,
        "json_parse_rate": len(parsed) / len(rows) if rows else None,
        "contract_compliance_rate": len(contract) / len(rows) if rows else None,
        "structural_contract_compliance_rate": structural_contract_rows / len(rows) if rows else None,
        "natural_language_adherence_rate": statistics.mean(language_rates) if language_rates else None,
        "core_narrative_chinese_compliance_count": len(parsed) - len(core_narrative_deviation_rows),
        "core_narrative_chinese_compliance_rate": (
            (len(parsed) - len(core_narrative_deviation_rows)) / len(parsed) if parsed else None
        ),
        "validation_error_distribution": dict(validation_errors),
        "deterministic_contradiction_count": contradiction_rows,
        "deterministic_contradiction_rate": contradiction_rows / len(parsed) if parsed else None,
        "deterministic_contradiction_interpretation": (
            "cross-field/price/RR inconsistency proxy; not a complete hallucination verdict"
        ),
        "signal_distribution": dict(signals),
        "entry_method_distribution": dict(entries),
        "hard_gate_distribution": dict(hard_gates),
        "hard_gate_failure_distribution": dict(hard_gate_failures),
        "confidence_mean": statistics.mean(confidences) if confidences else None,
        "confidence_min": min(confidences) if confidences else None,
        "confidence_max": max(confidences) if confidences else None,
        "bullish_score_mean": statistics.mean(bullish_scores) if bullish_scores else None,
        "bearish_score_mean": statistics.mean(bearish_scores) if bearish_scores else None,
        "no_memory_instruction_echo_count": len(instruction_echo_rows),
        "no_memory_instruction_echo_rate": len(instruction_echo_rows) / len(parsed) if parsed else None,
        "no_memory_instruction_echo_interpretation": (
            "non-empty experience_usage.influence despite no memory input; semantic contract failure, not a market-fact hallucination"
        ),
        "backtest_status_distribution": dict(outcomes),
        "performance_eligible": len(performance),
        "performance_excluded": len(parsed) - len(performance),
        "performance_exclusion_distribution": dict(exclusions),
        "filled": len(fills),
        "wins_tp": len(wins),
        "fill_rate": len(fills) / len(performance) if performance else None,
        "win_rate_among_filled": len(wins) / len(fills) if fills else None,
        "mfe_price_mean": statistics.mean(clean(mfe)) if clean(mfe) else None,
        "mae_price_mean": statistics.mean(clean(mae)) if clean(mae) else None,
        "return_pct_mean_filled": statistics.mean(clean(returns)) if clean(returns) else None,
        "direction_return_4h_pct_mean": statistics.mean(clean(four_hour)) if clean(four_hour) else None,
        "direction_return_12h_pct_mean": statistics.mean(clean(twelve_hour)) if clean(twelve_hour) else None,
        "latency": lat,
        "request_bytes_total": sum(int(row.get("request_bytes") or 0) for row in rows),
        "response_bytes_total": sum(int(row.get("response_bytes") or 0) for row in rows),
        "prompt_tokens_total": sum(prompt_tokens) if prompt_tokens else None,
        "completion_tokens_total": sum(completion_tokens) if completion_tokens else None,
        "reasoning_tokens_total": sum(reasoning_tokens) if reasoning_tokens else None,
        "prompt_tokens_mean": statistics.mean(prompt_tokens) if prompt_tokens else None,
        "completion_tokens_mean": statistics.mean(completion_tokens) if completion_tokens else None,
    }


def _parsed(record: Mapping[str, Any]) -> Mapping[str, Any] | None:
    value = record.get("parsed_output")
    return value if isinstance(value, Mapping) else None


def _price_diff(left: Mapping[str, Any] | None, right: Mapping[str, Any] | None) -> dict[str, float | None]:
    fields = ("limit_price", "stop_limit_price", "stop_loss_price", "take_profit_1_price", "take_profit_2_price", "take_profit_3_price")
    result: dict[str, float | None] = {}
    for field in fields:
        a = _number(left.get(field)) if left else None
        b = _number(right.get(field)) if right else None
        result[field] = abs(a - b) if a is not None and b is not None else None
    return result


def _pairwise(experiment: Mapping[str, Any]) -> list[dict[str, Any]]:
    by_pair: dict[str, dict[str, Mapping[str, Any]]] = defaultdict(dict)
    decisions = {str(item.get("decision_id")): item for item in experiment.get("decisions", []) if isinstance(item, Mapping)}
    for record in _records(experiment):
        pair = str(record.get("pair_id") or record.get("decision_id") or "")
        group = str(record.get("group") or "")
        if pair and group:
            by_pair[pair][group] = record
    rows = []
    for pair, groups in sorted(by_pair.items(), key=lambda item: item[0]):
        parsed = {group: _parsed(groups.get(group, {})) for group in GROUP_NAMES}
        dirs = {group: direction_for_signal(value.get("signal_type") if value else None) for group, value in parsed.items()}
        entries = {group: str(value.get("entry_method", "unknown")).lower() if value else "missing" for group, value in parsed.items()}
        observed_dirs = [value for value in dirs.values() if value != "unknown"]
        observed_entries = [value for value in entries.values() if value != "missing"]
        row: dict[str, Any] = {
            "pair_id": pair,
            "decision_time_utc": decisions.get(pair, {}).get("decision_time_utc"),
            "direction_agreement_all": bool(observed_dirs) and len(set(observed_dirs)) == 1 and len(observed_dirs) == len(GROUP_NAMES),
            "entry_method_agreement_all": bool(observed_entries) and len(set(observed_entries)) == 1 and len(observed_entries) == len(GROUP_NAMES),
            "zh_zh_vs_en_en_direction_same": dirs["zh_zh"] == dirs["en_en"] and dirs["zh_zh"] != "unknown",
            "zh_zh_vs_en_en_entry_same": entries["zh_zh"] == entries["en_en"] and entries["zh_zh"] != "missing",
        }
        confidence_values: list[float] = []
        bullish_values: list[float] = []
        bearish_values: list[float] = []
        hard_gate_values: list[str] = []
        for group in GROUP_NAMES:
            value = parsed[group]
            record = groups.get(group, {})
            backtest = record.get("backtest") or {}
            confidence = _number(value.get("confidence")) if value else None
            bullish = _number(value.get("bullish_score")) if value else None
            bearish = _number(value.get("bearish_score")) if value else None
            hard_gate = str(value.get("hard_gate_status")) if value and value.get("hard_gate_status") is not None else None
            if confidence is not None:
                confidence_values.append(confidence)
            if bullish is not None:
                bullish_values.append(bullish)
            if bearish is not None:
                bearish_values.append(bearish)
            if hard_gate is not None:
                hard_gate_values.append(hard_gate)
            row.update({
                f"{group}_signal_type": value.get("signal_type") if value else None,
                f"{group}_entry_method": value.get("entry_method") if value else None,
                f"{group}_contract_passed": record.get("contract_passed"),
                f"{group}_confidence": confidence,
                f"{group}_bullish_score": bullish,
                f"{group}_bearish_score": bearish,
                f"{group}_hard_gate_status": hard_gate,
                f"{group}_latency_ms": record.get("latency_ms"),
                f"{group}_backtest_status": backtest.get("status"),
                f"{group}_filled": backtest.get("filled"),
                f"{group}_return_pct": backtest.get("return_pct"),
                f"{group}_mfe_price": backtest.get("mfe_price"),
                f"{group}_mae_price": backtest.get("mae_price"),
                f"{group}_direction_return_4h_pct": backtest.get("direction_return_4h_pct"),
                f"{group}_direction_return_12h_pct": backtest.get("direction_return_12h_pct"),
            })
        row["confidence_span_all"] = max(confidence_values) - min(confidence_values) if len(confidence_values) == len(GROUP_NAMES) else None
        row["bullish_score_span_all"] = max(bullish_values) - min(bullish_values) if len(bullish_values) == len(GROUP_NAMES) else None
        row["bearish_score_span_all"] = max(bearish_values) - min(bearish_values) if len(bearish_values) == len(GROUP_NAMES) else None
        row["hard_gate_agreement_all"] = len(hard_gate_values) == len(GROUP_NAMES) and len(set(hard_gate_values)) == 1
        row["zh_zh_vs_en_en_price_abs_diff"] = _price_diff(parsed["zh_zh"], parsed["en_en"])
        rows.append(row)
    return rows


def _mean_metric(summaries: Mapping[str, Mapping[str, Any]], groups: Iterable[str], metric: str) -> float | None:
    values = [_number(summaries[group].get(metric)) for group in groups]
    values = [value for value in values if value is not None]
    return statistics.mean(values) if values else None


def _effects(summaries: Mapping[str, Mapping[str, Any]]) -> dict[str, Any]:
    metrics = (
        "transport_success_rate", "json_parse_rate", "contract_compliance_rate", "structural_contract_compliance_rate",
        "natural_language_adherence_rate", "core_narrative_chinese_compliance_rate",
        "deterministic_contradiction_rate", "fill_rate",
        "win_rate_among_filled", "latency.p50_ms", "latency.p95_ms", "request_bytes_total",
        "response_bytes_total", "prompt_tokens_mean", "completion_tokens_mean", "confidence_mean",
        "bullish_score_mean", "bearish_score_mean", "no_memory_instruction_echo_rate",
    )
    result: dict[str, Any] = {}
    for metric in metrics:
        def value(group: str) -> float | None:
            target: Any = summaries[group]
            for part in metric.split("."):
                target = target.get(part) if isinstance(target, Mapping) else None
            return _number(target)
        values = {group: value(group) for group in GROUP_NAMES}
        strategy_zh = [values["zh_zh"], values["zh_en"]]
        strategy_en = [values["en_zh"], values["en_en"]]
        schema_zh = [values["zh_zh"], values["en_zh"]]
        schema_en = [values["zh_en"], values["en_en"]]
        def avg(items: Iterable[float | None]) -> float | None:
            usable = [item for item in items if item is not None]
            return statistics.mean(usable) if usable else None
        strategy_effect = (avg(strategy_en) - avg(strategy_zh)) if avg(strategy_en) is not None and avg(strategy_zh) is not None else None
        schema_effect = (avg(schema_en) - avg(schema_zh)) if avg(schema_en) is not None and avg(schema_zh) is not None else None
        interaction = None
        if all(values[group] is not None for group in GROUP_NAMES):
            interaction = (values["en_en"] - values["en_zh"]) - (values["zh_en"] - values["zh_zh"])
        result[metric] = {
            "by_group": values,
            "strategy_language_effect_en_minus_zh": strategy_effect,
            "schema_language_effect_en_minus_zh": schema_effect,
            "interaction": interaction,
        }
    return result


def _factor_contrast(values: Mapping[str, float | None]) -> dict[str, Any]:
    def avg(groups: Iterable[str]) -> float | None:
        usable = [_number(values.get(group)) for group in groups]
        usable = [value for value in usable if value is not None]
        return statistics.mean(usable) if usable else None
    strategy_zh = avg(("zh_zh", "zh_en"))
    strategy_en = avg(("en_zh", "en_en"))
    contract_zh = avg(("zh_zh", "en_zh"))
    contract_en = avg(("zh_en", "en_en"))
    interaction = None
    if all(_number(values.get(group)) is not None for group in GROUP_NAMES):
        interaction = (float(values["en_en"]) - float(values["en_zh"])) - (
            float(values["zh_en"]) - float(values["zh_zh"])
        )
    return {
        "by_group": dict(values),
        "strategy_language_effect_en_minus_zh": (
            strategy_en - strategy_zh if strategy_en is not None and strategy_zh is not None else None
        ),
        "output_contract_language_effect_en_minus_zh": (
            contract_en - contract_zh if contract_en is not None and contract_zh is not None else None
        ),
        "interaction": interaction,
    }


def _csv_value(value: Any) -> Any:
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return value


def _write_csv(path: Path, rows: list[Mapping[str, Any]]) -> None:
    ensure_dir(path.parent)
    fields: list[str] = []
    for row in rows:
        for key in row:
            if key not in fields:
                fields.append(key)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow({key: _csv_value(row.get(key)) for key in fields})


def _load_json_records(path: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    if not path.exists():
        return records
    for item in sorted(path.glob("*.json")):
        try:
            value = json.loads(item.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(value, Mapping):
            records.append(dict(value))
    return records


def formal_record_binding(records: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
    """Canonical binding used to prevent a stale manual audit being reused."""
    entries = sorted(
        (
            {
                "decision_id": str(row.get("decision_id") or ""),
                "group": str(row.get("group") or ""),
                "request_sha256": str(row.get("request_sha256") or ""),
                "response_sha256": str(row.get("response_sha256") or ""),
            }
            for row in records
            if row.get("status") == "success"
        ),
        key=lambda row: (row["decision_id"], row["group"]),
    )
    return {
        "formal_records": len(entries),
        "formal_record_set_sha256": sha256_bytes(json_bytes(entries)),
        "records": entries,
    }


def validate_narrative_audit(
    audit: Any,
    records: Iterable[Mapping[str, Any]],
) -> dict[str, Any] | None:
    if audit is None:
        return None
    if not isinstance(audit, Mapping):
        raise ValueError("narrative_audit_not_object")
    binding = formal_record_binding(records)
    scope = audit.get("scope") or {}
    if scope.get("formal_records_audited") != binding["formal_records"]:
        raise ValueError("narrative_audit_record_count_mismatch")
    if scope.get("formal_record_set_sha256") != binding["formal_record_set_sha256"]:
        raise ValueError("narrative_audit_record_hash_mismatch")
    results = audit.get("results") or {}
    contradictory = int(results.get("explicitly_contradictory_records") or 0)
    by_group = results.get("explicit_contradictions_by_group") or {}
    if sum(int(value or 0) for value in by_group.values()) != contradictory:
        raise ValueError("narrative_audit_group_sum_mismatch")
    return dict(audit)


def _excluded_preexperiment_batches(output_root: Path) -> list[dict[str, Any]]:
    batches: list[dict[str, Any]] = []
    for path in sorted(output_root.glob("rejected-preexperiment-*")):
        if not path.is_dir():
            continue
        records = _load_json_records(path / "calls")
        batches.append({"name": path.name, "records": len(records)})
    return batches


def _pilot_summary(output_root: Path) -> dict[str, Any]:
    records = _load_json_records(output_root / "max-thinking-pilot" / "calls")
    successes = [row for row in records if row.get("status") == "success"]
    failures = [row for row in records if row.get("status") != "success"]
    attempts = [
        attempt
        for row in records
        for attempt in (row.get("attempts") or [])
        if isinstance(attempt, Mapping)
    ]
    return {
        "included_in_primary_effects": False,
        "thinking": {"type": "enabled", "reasoning_effort": "max"},
        "persisted_records": len(records),
        "successes": len(successes),
        "failures": len(failures),
        "successful_latency_ms": [row.get("latency_ms") for row in successes],
        "attempts": attempts,
        "timeout_or_network_attempts": sum(attempt.get("http_status") is None for attempt in attempts),
        "usage": [row.get("usage") for row in successes if isinstance(row.get("usage"), Mapping)],
        "failure_errors": [row.get("error") for row in failures],
        "interpretation": "transport-tail pilot only; excluded from all language main effects and interactions",
    }


def _md_table(rows: list[list[Any]], headers: list[str]) -> str:
    lines = ["| " + " | ".join(headers) + " |", "| " + " | ".join("---" for _ in headers) + " |"]
    for row in rows:
        def display(value: Any) -> str:
            if value is None:
                return ""
            if isinstance(value, float):
                value = f"{value:.6g}"
            return str(value)[:160].replace("|", "\\|").replace("\n", " ")
        lines.append("| " + " | ".join(display(value) for value in row) + " |")
    return "\n".join(lines)


def _build_markdown(experiment: Mapping[str, Any], summary: Mapping[str, Any], pairs: list[Mapping[str, Any]]) -> str:
    source = summary.get("source", {})
    data_metadata = source.get("data_metadata") or {}
    hashes = summary.get("source_hashes", {})
    sizes = summary.get("source_sizes", {})
    groups = summary.get("groups", {})
    overall = summary.get("overall_zhzh_vs_enen", {})
    successful_calls = sum(int((groups.get(group) or {}).get("transport_success") or 0) for group in GROUP_NAMES)
    strict_contracts = sum(int((groups.get(group) or {}).get("contract_success") or 0) for group in GROUP_NAMES)
    structural_contracts = sum(int((groups.get(group) or {}).get("structural_contract_success") or 0) for group in GROUP_NAMES)
    instruction_echoes = sum(int((groups.get(group) or {}).get("no_memory_instruction_echo_count") or 0) for group in GROUP_NAMES)
    contradictions = sum(int((groups.get(group) or {}).get("deterministic_contradiction_count") or 0) for group in GROUP_NAMES)
    prompt_tokens = sum(int((groups.get(group) or {}).get("prompt_tokens_total") or 0) for group in GROUP_NAMES)
    completion_tokens = sum(int((groups.get(group) or {}).get("completion_tokens_total") or 0) for group in GROUP_NAMES)
    confidence_means = {group: round(float((groups.get(group) or {}).get("confidence_mean") or 0), 4) for group in GROUP_NAMES}
    echo_rates = {group: round(float((groups.get(group) or {}).get("no_memory_instruction_echo_rate") or 0), 4) for group in GROUP_NAMES}
    core_chinese_rates = {group: round(float((groups.get(group) or {}).get("core_narrative_chinese_compliance_rate") or 0), 4) for group in GROUP_NAMES}
    narrative_audit = summary.get("narrative_fact_audit") or {}
    narrative_results = narrative_audit.get("results") or {}
    narrative_scope = narrative_audit.get("scope") or {}
    narrative_effects = summary.get("narrative_contradiction_effects") or {}
    integrity = summary.get("integrity_checks") or {}
    binding = integrity.get("formal_record_binding") or {}
    integrity_display = {
        "formal_records": binding.get("formal_records"),
        "formal_record_set_sha256": binding.get("formal_record_set_sha256"),
        "call_order_balance": integrity.get("call_order_balance"),
        "each_group_occupied_each_order_twice": integrity.get("each_group_occupied_each_order_twice"),
        "same_market_payload_within_each_pair": integrity.get("same_market_payload_within_each_pair"),
    }
    signal_counts: Counter[str] = Counter()
    for group in GROUP_NAMES:
        signal_counts.update((groups.get(group) or {}).get("signal_distribution") or {})
    filled_total = sum(int((groups.get(group) or {}).get("filled") or 0) for group in GROUP_NAMES)
    performance_eligible = sum(int((groups.get(group) or {}).get("performance_eligible") or 0) for group in GROUP_NAMES)
    if narrative_audit:
        narrative_summary_line = (
            f"绑定当前响应哈希的逐条叙述审计覆盖 {narrative_scope.get('formal_records_audited')}/{successful_calls} 条，"
            f"发现 {narrative_results.get('explicitly_contradictory_records')} 条可直接证伪记录，"
            f"组别分布为 `{narrative_results.get('explicit_contradictions_by_group')}`。"
        )
    else:
        narrative_summary_line = "逐条叙述事实审计尚未生成；当前报告不对自然语言事实矛盾率下结论。"
    lines = [
        "# DeepSeek v4 Pro 中英文策略/输出合同 2×2 历史模拟",
        "",
        "> 这是使用冻结历史行情的模型行为对照，不是交易建议，也不是统计显著性结论。所有差异只能作为本样本描述。",
        "",
        "## 结论摘要",
        "",
        f"- 方向/入场一致率：all-cell direction={overall.get('all_cell_direction_agreement')}，entry={overall.get('all_cell_entry_agreement')}；正式响应 signal 分布为 `{dict(signal_counts)}`。",
        f"- 四组平均 confidence 为 `{confidence_means}`；逐点四组 confidence 平均跨度为 `{float(overall.get('confidence_span_mean_all_cells') or 0):.4f}`。只有少量决策点，不作显著性结论。",
        f"- JSON/结构合同为 {structural_contracts}/{successful_calls}；严格语义合同为 {strict_contracts}/{successful_calls}。差额来自 {instruction_echoes}/{successful_calls} 条“无记忆时 influence 应为空、模型却抄入说明句”的 instruction echo；各组率为 `{echo_rates}`。",
        f"- 排除 experience_usage.influence 后，核心叙述保持简体中文的记录率为 `{core_chinese_rates}`；该指标只测输出语言，不测事实正确性。",
        f"- 自动跨字段/价格/RR 代理为 {contradictions}/{successful_calls}。{narrative_summary_line}",
        f"- 可进入交易绩效分母的记录 {performance_eligible}/{successful_calls}，实际成交 {filled_total}；结构合同无效、未来 M1 不完整和不支持的 stop-limit 均被排除。",
        f"- 主批次用量：prompt tokens={prompt_tokens}，completion tokens={completion_tokens}；最大思考模式试验另行排除，不进入上述语言效应。",
        "",
        "## 实验边界与基线证据",
        "",
        f"- 模型：`{summary.get('model')}`；API base URL：`{summary.get('base_url')}`。",
        f"- VM 权威运行时：`{source.get('vm_branch')}` / `{source.get('vm_commit')}`；当前主工作树 HEAD：`{source.get('local_commit')}`；冻结快照运行时：`{source.get('snapshot_runtime_commit')}`；最终只读复核导出时间：`{source.get('vm_exported_at_utc')}`。若主工作树已前进，只允许复用 clean detached worktree 在 VM commit 上重建且文件哈希完全相同的快照，不能混入新本地 runtime。",
        f"- MT5 数据捕获时的代码 commit：`{(data_metadata.get('source') or {}).get('local_commit')}`；其 data plan 已与本次 VM runtime plan 做逐字段等值校验。行情文件本身来自本机 MT5，不由该代码 commit 生成报价。",
        f"- 品种：`{source.get('symbol')}`；策略版本：`{(source.get('strategy') or {}).get('version')}`；决策点：`{(experiment.get('design') or {}).get('actual_samples')}`；正式调用目标：`{(experiment.get('design') or {}).get('formal_calls_expected')}`。",
        f"- 计分窗口：`{(source.get('market_window') or {}).get('start_utc')}` 至 `{(source.get('market_window') or {}).get('end_utc')}`（最近 7 个日历日）；各周期 bars：`{data_metadata.get('bar_counts')}`；未来回放最多 12 小时。",
        f"- 本机 MT5：`{data_metadata.get('terminal_path')}`；Python 包 `MetaTrader5 {data_metadata.get('metatrader5_python_version')}`，仓库 Worker 锁定 `5.0.5735`；broker offset：`{(data_metadata.get('clock') or {}).get('broker_offset_seconds')}` 秒。",
        f"- 动态输出合同版本 SHA-256：`{source.get('output_schema_version')}`；最近 inference snapshot 交叉验证：`{source.get('latest_inference_snapshot')}`。",
        f"- 策略正文 SHA-256：`{hashes.get('strategy_zh_sha256')}`；中文 schema：`{hashes.get('schema_zh_sha256')}`；英文正文：`{hashes.get('strategy_en_sha256')}`；英文 schema：`{hashes.get('schema_en_sha256')}`。",
        f"- 语言文件大小：`{sizes}`；不同语言的 token/字节长度并不相同，因此报告同时列出 prompt tokens 与 request bytes。",
        f"- 市场数据 payload SHA-256：`{hashes.get('market_data_payload_sha256')}`；文件 SHA-256：`{hashes.get('market_data_file_sha256')}`。",
        "- 四个 cell：ZH-ZH（中文策略+中文输出合同）、ZH-EN、EN-ZH、EN-EN。策略因子切换正文及等义紧凑输入规则；输出合同因子只切换 system 中的合同块（标题、说明、固定响应语言规则），user task/market heading、keys、枚举、语义和简体中文响应要求均保持不变。",
        f"- 隔离校验：`{integrity_display}`。每组在调用顺序 0/1/2/3 各出现两次，同一决策点四组市场 payload hash 必须相同。",
        f"- 主批次参数：`{experiment.get('parameters')}`。主效应只使用 thinking-disabled 正式记录。",
        f"- 正式记录之外的预检/中断尝试：`{len((experiment.get('out_of_band_attempts') or {}).get('events') or [])}` 组事件；这些请求无完整 usage，潜在计费未知，详见 experiment.json。",
        f"- 被排除的预实验：`{summary.get('excluded_preexperiment_batches')}`，共 `{summary.get('excluded_preexperiment_records')}` 条；不进入任何分组统计。",
        "",
        "## 翻译不变量",
        "",
        f"- 来源：`{(summary.get('translation_audit') or {}).get('source')}`；通过：`{(summary.get('translation_audit') or {}).get('passed')}`；与当前中文 source SHA 绑定：`{(summary.get('translation_audit') or {}).get('source_binding_verified')}`。",
        f"- 错误：`{(summary.get('translation_audit') or {}).get('errors') or []}`。JSON keys、枚举 token、周期、数字、占位符、字段路径必须保持不变。",
        "",
        "## 分组指标",
        "",
    ]
    group_rows = []
    for group in GROUP_NAMES:
        item = summary["groups"].get(group, {})
        group_rows.append([
            group,
            item.get("total_calls"), item.get("transport_success"), item.get("json_parse_success"),
            item.get("contract_success"), item.get("structural_contract_success"), item.get("signal_distribution"), item.get("entry_method_distribution"),
            item.get("confidence_mean"), item.get("bullish_score_mean"), item.get("bearish_score_mean"),
            item.get("latency", {}).get("p50_ms"), item.get("latency", {}).get("p95_ms"),
            item.get("request_bytes_total"), item.get("response_bytes_total"), item.get("prompt_tokens_total"),
            item.get("completion_tokens_total"), item.get("reasoning_tokens_total"),
            item.get("natural_language_adherence_rate"), item.get("core_narrative_chinese_compliance_rate"),
            item.get("no_memory_instruction_echo_rate"), item.get("deterministic_contradiction_rate"),
            item.get("performance_eligible"), item.get("performance_exclusion_distribution"),
            item.get("fill_rate"), item.get("win_rate_among_filled"), item.get("mfe_price_mean"),
            item.get("mae_price_mean"), item.get("direction_return_4h_pct_mean"), item.get("direction_return_12h_pct_mean"),
        ])
    lines.append(_md_table(group_rows, ["cell", "calls", "HTTP 2xx", "JSON", "strict contract", "structural contract", "signals", "entries", "confidence", "bull score", "bear score", "p50 ms", "p95 ms", "req B", "resp B", "prompt tok", "completion tok", "reason tok", "all text Chinese", "core narrative Chinese", "no-memory instruction echo", "contradiction proxy", "performance eligible", "performance excluded", "fill", "win/filled", "MFE", "MAE", "4h %", "12h %"]))
    lines.extend(["", "### 合同错误与自动交叉字段矛盾代理", ""])
    error_rows = []
    for group in GROUP_NAMES:
        item = summary["groups"].get(group, {})
        error_rows.append([
            group,
            item.get("validation_error_distribution"),
            item.get("deterministic_contradiction_count"),
            item.get("deterministic_contradiction_rate"),
        ])
    lines.append(_md_table(error_rows, ["cell", "validation errors", "automatic proxy rows", "automatic proxy rate"]))
    lines.extend([
        "",
        "`strict contract` 包含所有结构、字段关系和“无记忆时必须为空”的语义要求；`structural contract` 只豁免无记忆说明句回声，其他错误仍失败。成交回放采用 structural contract 作为机械资格门槛：单纯的 experience_usage 说明句回声不改变 signal、entry、价格或保护字段，因此保留为严格语义失败指标，但不单独使一个本可执行的信号失去回放资格。contradiction proxy 只统计可由 JSON 内部关系或价格/RR 算术直接证伪的矛盾；无法从结构化行情自动核验的自然语言陈述不计入，因此它不是完整幻觉率。语言偏离单独作为 adherence 指标，也不自动算幻觉。`no-memory instruction echo` 指模型没有按要求返回空字符串，反而抄写 schema 说明句；它是语义合同失败，不是市场事实幻觉。",
    ])
    if narrative_audit:
        audited = narrative_scope.get("formal_records_audited")
        lines.extend([
            "",
            f"## {audited}/{successful_calls} 叙述事实审计",
            "",
            "该层逐条核对 `analysis/reasoning/key_reasons/risk_factors` 与同一请求的冻结 market JSON；审计 JSON 的 formal_record_set_sha256 必须与当前正式 request/response 哈希集合一致，否则报告构建会失败。完整逐条结论与证据路径见 `narrative-fact-audit.md/json`。",
            "",
            _md_table([[
                narrative_results.get("explicitly_contradictory_records"),
                narrative_results.get("explicit_contradiction_rate"),
                narrative_results.get("explicit_contradictions_by_group"),
                narrative_results.get("invented_numeric_values_found"),
                narrative_results.get("records_with_at_least_one_not_independently_verifiable_path_claim"),
                narrative_results.get("fully_supported_entire_narratives"),
                narrative_results.get("gate_failure_sequence_self_consistent"),
                narrative_results.get("gate_failure_sequence_inconsistent"),
                narrative_results.get("h1_unclear_but_h4_not_enabled"),
            ]], ["explicit contradictions", "rate", "by group", "invented numbers", "contains unverifiable path claim", "fully supported whole narrative", "gate sequence consistent", "gate sequence inconsistent", "H1 unclear but H4 disabled"]),
            "",
            _md_table([[
                narrative_effects.get("by_group"),
                narrative_effects.get("strategy_language_effect_en_minus_zh"),
                narrative_effects.get("output_contract_language_effect_en_minus_zh"),
                narrative_effects.get("interaction"),
            ]], ["contradiction rate by group", "strategy EN-ZH", "output-contract EN-ZH", "interaction"]),
            "",
            "这里的直接矛盾率只统计能由同一冻结请求直接证伪的陈述；无法独立核验的形态/路径判断单列，不能被解释为已证实正确。样本规模有限，组间差异仅作描述。",
        ])
    else:
        lines.extend([
            "",
            "## 叙述事实审计（待完成）",
            "",
            "当前尚无与正式 request/response 哈希集合绑定的逐条审计，因此本版报告不输出自然语言事实矛盾率。",
        ])
    lines.extend(["", "## 主效应与交互（描述性）", "", "策略语言、输出合同块语言的差值和交互项均来自四个 cell 的样本均值；不作显著性推断。", ""])
    effect_rows = []
    for metric, value in summary.get("effects", {}).items():
        effect_rows.append([metric, value.get("strategy_language_effect_en_minus_zh"), value.get("schema_language_effect_en_minus_zh"), value.get("interaction")])
    lines.append(_md_table(effect_rows, ["metric", "strategy EN-ZH", "output-contract EN-ZH", "interaction"]))
    pilot = summary.get("max_thinking_pilot") or {}
    pilot_usage = (pilot.get("usage") or [{}])[0]
    pilot_completion_details = pilot_usage.get("completion_tokens_details") or {}
    lines.extend([
        "",
        "## 最大思考模式尾延迟试验（不纳入语言效应）",
        "",
        "该试验使用同一模型与 `thinking.type=enabled / reasoning_effort=max`，只用于判断传输尾延迟是否足以淹没语言差异。",
        "",
        _md_table([[
            pilot.get("persisted_records"), pilot.get("successes"), pilot.get("failures"),
            pilot.get("successful_latency_ms"), pilot.get("timeout_or_network_attempts"),
            pilot_usage.get("prompt_tokens"), pilot_usage.get("completion_tokens"),
            pilot_completion_details.get("reasoning_tokens"), pilot.get("failure_errors"),
        ]], ["persisted", "success", "failed", "successful latency ms", "network/timeout attempts", "prompt tok", "completion tok", "reasoning tok", "failure errors"]),
        "",
        "未取得 HTTP 响应的中断/超时请求是否计费无法从客户端判定，须以供应商账单为准。",
    ])
    lines.extend(["", "## ZH-ZH 与 EN-EN 对照", ""])
    price_differences = overall.get("price_differences") or []
    price_diff_display: Any = price_differences
    if price_differences and all(
        isinstance(item, Mapping) and all(value is None for value in item.values())
        for item in price_differences
    ):
        price_diff_display = "n/a (all hold)"
    lines.append(_md_table([
        [overall.get("direction_agreement"), overall.get("entry_method_agreement"), overall.get("all_cell_direction_agreement"),
         overall.get("all_cell_entry_agreement"), overall.get("contract_both"), overall.get("confidence_span_mean_all_cells"),
         overall.get("bullish_score_span_mean_all_cells"), overall.get("bearish_score_span_mean_all_cells"), price_diff_display],
    ], ["ZH-ZH vs EN-EN direction", "ZH-ZH vs EN-EN entry", "all-cell direction", "all-cell entry", "both contract pass", "mean confidence span", "mean bull-score span", "mean bear-score span", "absolute price diffs"])); lines.extend(["", "## 逐样本四格对照", ""])
    sample_rows = []
    for pair in pairs:
        sample_rows.append([
            pair.get("pair_id"), pair.get("decision_time_utc"),
            "/".join(str(pair.get(f"{group}_signal_type") or "-") for group in GROUP_NAMES),
            "/".join(str(pair.get(f"{group}_entry_method") or "-") for group in GROUP_NAMES),
            "/".join(str(pair.get(f"{group}_confidence") if pair.get(f"{group}_confidence") is not None else "-") for group in GROUP_NAMES),
            pair.get("confidence_span_all"), pair.get("bullish_score_span_all"), pair.get("bearish_score_span_all"),
            pair.get("direction_agreement_all"), pair.get("entry_method_agreement_all"),
            "/".join(str(pair.get(f"{group}_backtest_status") or "-") for group in GROUP_NAMES),
            "/".join(str(pair.get(f"{group}_return_pct") or "-") for group in GROUP_NAMES),
        ])
    lines.append(_md_table(sample_rows, ["pair", "decision UTC", "signals ZH-ZH/ZH-EN/EN-ZH/EN-EN", "entries", "confidence", "confidence span", "bull-score span", "bear-score span", "all direction same", "all entry same", "backtest status", "return %"]))
    lines.extend([
        "",
        "## 回测规则",
        "",
        "- 只使用决策点之后的 M1；同一根 M1 同时触发止损和止盈时止损优先。市价单按首根未来 M1 开盘价，限价/止损按触发价；stop-limit 明确标记 unsupported，不猜测成交。",
        "- 输出 `filled`、TP/SL/timeout/no_trigger、MFE、MAE、4h/12h 方向收益；hold 不进行成交回放，也不计算方向收益，只记录未来窗口覆盖状态。",
        "",
        "## 局限性与风险",
        "",
        "- 这是有限决策点的历史模拟，样本量小，不能代表未来效果，也不能据此声称统计显著。",
        "- MT5 数据使用本机终端和 broker server epoch 校准；窗口、缺口、报价、点差、滑点、成交延迟、资金费和真实账户风控未完全模拟。",
        "- 本实验固定空仓、无持仓管理 schema；模型输出自然语言可能存在不可验证陈述，JSON 合同合规不等于事实正确。",
        "- 英文策略与 schema 由同一模型分块翻译；已验证 key/枚举/周期/数字/路径和残留中文，但没有独立人工逐句认证语义等价。翻译措辞或篇幅差异仍可能是观测差异的一部分。",
        "- 幻觉代理只覆盖结构化交叉字段、价格方向和实际盈亏比等确定性矛盾；未做外部事实检索，也未把语言不遵从当作事实幻觉。",
        "- Python MetaTrader5 包版本、VM 与本地代码版本及模型服务端行为均是环境依赖；结果必须结合 sidecar hashes、请求/响应哈希和原始 JSON 审核。",
        "- 供应商响应中的 model 字段回显为 `deepseek-v4-pro-0813`，但第三方兼容 API 背后的实际权重、路由与服务端版本无法由客户端独立证明。",
        "- API 429/5xx/网络错误按受限指数退避；成功请求按 decision_id+cell 单独落盘，默认重跑跳过成功记录。成本应以 usage、request/response bytes 为准。",
    ])
    return "\n".join(lines) + "\n"


def build_report(*, experiment_path: Path = RESULTS_ROOT / "experiment.json") -> dict[str, Any]:
    experiment = json.loads(experiment_path.read_text(encoding="utf-8"))
    output_root = experiment_path.parent
    records = _records(experiment)
    if any((row.get("thinking") or {}).get("type") != "disabled" for row in records):
        raise ValueError("primary_report_contains_non_disabled_thinking_record")
    groups = {group: _group_summary([row for row in records if row.get("group") == group]) for group in GROUP_NAMES}
    pairs = _pairwise(experiment)
    pair_direction = [row for row in pairs if row.get("zh_zh_signal_type") and row.get("en_en_signal_type")]
    pair_entry = [row for row in pairs if row.get("zh_zh_entry_method") and row.get("en_en_entry_method")]
    both_contract = [row for row in pairs if row.get("zh_zh_contract_passed") is True and row.get("en_en_contract_passed") is True]
    complete_pairs = [row for row in pairs if all(row.get(f"{group}_signal_type") for group in GROUP_NAMES)]
    confidence_spans = [_number(row.get("confidence_span_all")) for row in complete_pairs]
    bullish_spans = [_number(row.get("bullish_score_span_all")) for row in complete_pairs]
    bearish_spans = [_number(row.get("bearish_score_span_all")) for row in complete_pairs]
    narrative_audit_path = output_root / "narrative-fact-audit.json"
    raw_narrative_audit = json.loads(narrative_audit_path.read_text(encoding="utf-8")) if narrative_audit_path.exists() else None
    narrative_audit = validate_narrative_audit(raw_narrative_audit, records)
    audit_binding = formal_record_binding(records)
    excluded_batches = _excluded_preexperiment_batches(output_root)
    narrative_contradiction_effects = None
    if narrative_audit:
        contradiction_counts = (narrative_audit.get("results") or {}).get("explicit_contradictions_by_group") or {}
        contradiction_rates = {
            group: (
                int(contradiction_counts.get(group) or 0) / int(groups[group].get("total_calls") or 0)
                if int(groups[group].get("total_calls") or 0) else None
            )
            for group in GROUP_NAMES
        }
        narrative_contradiction_effects = _factor_contrast(contradiction_rates)
    call_order_balance = {
        group: dict(Counter(int(row.get("call_order")) for row in records if row.get("group") == group and row.get("call_order") is not None))
        for group in GROUP_NAMES
    }
    market_hashes_by_pair: dict[str, set[str]] = defaultdict(set)
    for row in records:
        if row.get("pair_id") and row.get("market_payload_sha256"):
            market_hashes_by_pair[str(row["pair_id"])].add(str(row["market_payload_sha256"]))
    summary = {
        "report_version": "deepseek-v4-pro-0813-bilingual-2x2-report-v3",
        "model": experiment.get("model"),
        "base_url": experiment.get("base_url"),
        "parameters": experiment.get("parameters"),
        "design": experiment.get("design"),
        "source": experiment.get("source"),
        "source_hashes": experiment.get("source_hashes"),
        "source_sizes": experiment.get("source_sizes"),
        "translation_audit": experiment.get("translation_audit"),
        "out_of_band_attempts": experiment.get("out_of_band_attempts"),
        "excluded_preexperiment_records": sum(batch["records"] for batch in excluded_batches),
        "excluded_preexperiment_batches": excluded_batches,
        "max_thinking_pilot": _pilot_summary(output_root),
        "narrative_fact_audit": narrative_audit,
        "narrative_contradiction_effects": narrative_contradiction_effects,
        "integrity_checks": {
            "formal_record_binding": audit_binding,
            "call_order_balance": call_order_balance,
            "each_group_occupied_each_order_twice": all(
                set(counts) == {0, 1, 2, 3} and set(counts.values()) == {2}
                for counts in call_order_balance.values()
            ),
            "same_market_payload_within_each_pair": bool(market_hashes_by_pair) and all(len(values) == 1 for values in market_hashes_by_pair.values()),
            "pair_market_payload_hash_counts": {pair: len(values) for pair, values in market_hashes_by_pair.items()},
        },
        "groups": groups,
        "effects": _effects(groups),
        "overall_zhzh_vs_enen": {
            "pair_count": len(pairs),
            "direction_agreement_count": sum(bool(row.get("zh_zh_vs_en_en_direction_same")) for row in pair_direction),
            "direction_agreement": sum(bool(row.get("zh_zh_vs_en_en_direction_same")) for row in pair_direction) / len(pair_direction) if pair_direction else None,
            "entry_method_agreement_count": sum(bool(row.get("zh_zh_vs_en_en_entry_same")) for row in pair_entry),
            "entry_method_agreement": sum(bool(row.get("zh_zh_vs_en_en_entry_same")) for row in pair_entry) / len(pair_entry) if pair_entry else None,
            "all_cell_direction_agreement_count": sum(bool(row.get("direction_agreement_all")) for row in complete_pairs),
            "all_cell_direction_agreement": sum(bool(row.get("direction_agreement_all")) for row in complete_pairs) / len(complete_pairs) if complete_pairs else None,
            "all_cell_entry_agreement_count": sum(bool(row.get("entry_method_agreement_all")) for row in complete_pairs),
            "all_cell_entry_agreement": sum(bool(row.get("entry_method_agreement_all")) for row in complete_pairs) / len(complete_pairs) if complete_pairs else None,
            "contract_both_count": len(both_contract),
            "contract_both": len(both_contract) / len(pairs) if pairs else None,
            "confidence_span_mean_all_cells": statistics.mean(value for value in confidence_spans if value is not None) if any(value is not None for value in confidence_spans) else None,
            "bullish_score_span_mean_all_cells": statistics.mean(value for value in bullish_spans if value is not None) if any(value is not None for value in bullish_spans) else None,
            "bearish_score_span_mean_all_cells": statistics.mean(value for value in bearish_spans if value is not None) if any(value is not None for value in bearish_spans) else None,
            "price_differences": [row.get("zh_zh_vs_en_en_price_abs_diff") for row in pairs],
        },
        "limitations": [
            "small descriptive sample; no significance claim",
            "historical simulation only, not trading advice",
            "empty-account replay without position-management schema",
            "future M1 availability and stop-limit support are explicitly status-coded",
        ],
    }
    write_json(output_root / "summary.json", summary)
    _write_csv(output_root / "pairwise.csv", pairs)
    (output_root / "report.md").write_text(_build_markdown(experiment, summary, pairs), encoding="utf-8")
    return summary


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build experiment report")
    parser.add_argument("--experiment", type=Path, default=RESULTS_ROOT / "experiment.json")
    args = parser.parse_args(argv)
    summary = build_report(experiment_path=args.experiment)
    print(json.dumps({"ok": True, "groups": list(summary["groups"]), "pair_count": summary["overall_zhzh_vs_enen"]["pair_count"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
