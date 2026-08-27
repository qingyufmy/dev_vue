"""Offline integrity verification for the completed bilingual experiment."""

from __future__ import annotations

import json
from collections import Counter
from pathlib import Path
from typing import Any, Mapping

from common import (
    DATA_ROOT,
    RESULTS_ROOT,
    SOURCE_ROOT,
    json_bytes,
    sha256_bytes,
    sha256_file,
)
from build_report import formal_record_binding
from run_experiment import build_formal_messages


class VerificationError(RuntimeError):
    pass


def _load(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise VerificationError(f"invalid_json:{path.name}") from exc


def _require(condition: bool, code: str) -> None:
    if not condition:
        raise VerificationError(code)


def verify() -> dict[str, Any]:
    experiment = _load(RESULTS_ROOT / "experiment.json")
    summary = _load(RESULTS_ROOT / "summary.json")
    metadata = _load(SOURCE_ROOT / "runtime-metadata.json")
    data_metadata = _load(DATA_ROOT / "metadata.json")
    market_data = _load(DATA_ROOT / "market-data.json")
    snapshots = _load(DATA_ROOT / "strategy-snapshots.json")
    snapshot_verification = _load(DATA_ROOT / "snapshot-clean-runtime-verification.json")
    audit = _load(SOURCE_ROOT / "translation-audit.json")
    narrative_audit = _load(RESULTS_ROOT / "narrative-fact-audit.json")
    strategy_zh = (SOURCE_ROOT / "strategy.zh.md").read_text(encoding="utf-8")
    strategy_en = (SOURCE_ROOT / "strategy.en.md").read_text(encoding="utf-8")
    schema_zh = _load(SOURCE_ROOT / "output-schema.zh.json")
    schema_en = _load(SOURCE_ROOT / "output-schema.en.json")

    call_files = sorted((RESULTS_ROOT / "calls").glob("*.json"))
    calls = [_load(path) for path in call_files]
    _require(len(calls) == 32, "formal_call_count_not_32")
    _require(all(isinstance(row, Mapping) and row.get("status") == "success" for row in calls), "formal_call_not_success")
    _require(Counter(row.get("group") for row in calls) == Counter({"zh_zh": 8, "zh_en": 8, "en_zh": 8, "en_en": 8}), "group_balance_invalid")
    _require(all(sha256_bytes(json_bytes(row.get("request"))) == row.get("request_sha256") for row in calls), "request_hash_mismatch")
    _require(all(sha256_bytes(str(row.get("raw_response") or "").encode("utf-8")) == row.get("response_sha256") for row in calls), "response_hash_mismatch")
    _require(all(row.get("model") == "deepseek-v4-pro-0813" for row in calls), "model_mismatch")
    _require(all((row.get("thinking") or {}).get("type") == "disabled" for row in calls), "primary_thinking_mode_not_disabled")
    _require(all(len(row.get("attempts") or []) >= 1 for row in calls), "formal_attempt_metadata_missing")

    snapshot_market_by_time = {
        str(row.get("decision_time_utc")): row.get("market")
        for row in snapshots.get("snapshots") or []
        if isinstance(row, Mapping)
    }
    _require(len(snapshot_market_by_time) == 8, "snapshot_market_index_invalid")
    strategies = {"zh": strategy_zh, "en": strategy_en}
    schemas = {"zh": schema_zh, "en": schema_en}
    user_hashes_by_pair: dict[str, set[str]] = {}
    for row in calls:
        messages = (row.get("request") or {}).get("messages") or []
        _require(len(messages) == 2 and messages[0].get("role") == "system" and messages[1].get("role") == "user", "formal_message_shape_invalid")
        strategy_language = str(row.get("strategy_language") or "")
        schema_language = str(row.get("schema_language") or "")
        market = snapshot_market_by_time.get(str(row.get("decision_time_utc")))
        _require(strategy_language in strategies and schema_language in schemas and isinstance(market, Mapping), "formal_prompt_source_missing")
        expected_messages = build_formal_messages(
            strategies[strategy_language],
            schemas[schema_language],
            market,
            schema_language,
            strategy_language,
        )
        _require(messages == expected_messages, "formal_messages_not_reproducible_from_frozen_sources")
        system = str(messages[0].get("content") or "")
        user = str(messages[1].get("content") or "")
        if row.get("strategy_language") == "zh":
            _require("## 市场数据紧凑编码" in system and "strategy_context.input_encoding" in system, "compact_rule_zh_missing")
        else:
            _require("## Compact market-data encoding" in system and "strategy_context.input_encoding" in system, "compact_rule_en_missing")
        user_hashes_by_pair.setdefault(str(row.get("pair_id")), set()).add(sha256_bytes(user))
    _require(all(len(values) == 1 for values in user_hashes_by_pair.values()), "schema_factor_changed_user_wrapper")

    by_pair: dict[str, set[str]] = {}
    for row in calls:
        by_pair.setdefault(str(row.get("pair_id")), set()).add(str(row.get("market_payload_sha256")))
    _require(len(by_pair) == 8 and all(len(values) == 1 for values in by_pair.values()), "market_payload_not_shared_within_pair")

    experiment_calls = experiment.get("calls") or []
    _require(len(experiment_calls) == len(calls), "experiment_call_count_mismatch")
    disk_index = {(row.get("decision_id"), row.get("group")): row.get("request_sha256") for row in calls}
    experiment_index = {(row.get("decision_id"), row.get("group")): row.get("request_sha256") for row in experiment_calls}
    _require(disk_index == experiment_index, "experiment_call_index_mismatch")

    _require(sha256_file(SOURCE_ROOT / "strategy.zh.md") == metadata.get("strategy_body_sha256"), "strategy_source_hash_mismatch")
    _require(sha256_file(SOURCE_ROOT / "output-schema.zh.json") == metadata.get("output_schema_sha256"), "schema_source_hash_mismatch")
    _require(sha256_file(DATA_ROOT / "market-data.json") == data_metadata.get("market_data_file_sha256"), "market_data_file_hash_mismatch")
    _require(market_data.get("market_data_sha256") == data_metadata.get("market_data_sha256"), "market_data_payload_hash_mismatch")
    _require(metadata.get("data_plan") == data_metadata.get("plan"), "runtime_capture_plan_mismatch")
    _require(audit.get("passed") is True and audit.get("errors") == [], "translation_audit_failed")
    _require(audit.get("source_binding_verified") is True, "translation_source_binding_missing")
    _require(audit.get("strategy_source_sha256") == sha256_bytes(strategy_zh), "translation_strategy_source_binding_mismatch")
    _require(audit.get("schema_source_sha256") == sha256_bytes(json_bytes(schema_zh)), "translation_schema_source_binding_mismatch")
    _require(audit.get("strategy_translation_sha256") == sha256_bytes(strategy_en), "translation_strategy_output_binding_mismatch")
    _require(audit.get("schema_translation_sha256") == sha256_bytes(json_bytes(schema_en)), "translation_schema_output_binding_mismatch")

    snapshot_rows = snapshots.get("snapshots") or []
    _require(len(snapshot_rows) == 8, "snapshot_count_not_8")
    _require(all(row.get("future_leakage") is False for row in snapshot_rows), "snapshot_future_leakage")
    _require(snapshot_verification.get("exact_clean_rebuild_match") is True, "snapshot_clean_rebuild_not_verified")
    _require(snapshot_verification.get("runtime_diff_exit") == 0, "snapshot_clean_runtime_diff_invalid")
    _require(snapshot_verification.get("clean_worktree_commit") == metadata.get("source", {}).get("git_commit"), "snapshot_clean_commit_mismatch")
    _require(snapshot_verification.get("snapshot_sha256") == sha256_file(DATA_ROOT / "strategy-snapshots.json"), "snapshot_clean_hash_mismatch")
    _require((experiment.get("design") or {}).get("snapshot_build_mode") == "verified_cache_from_clean_vm_commit", "snapshot_build_mode_invalid")
    integrity = summary.get("integrity_checks") or {}
    _require(integrity.get("each_group_occupied_each_order_twice") is True, "call_order_not_balanced")
    _require(integrity.get("same_market_payload_within_each_pair") is True, "summary_market_hash_check_failed")
    narrative_results = narrative_audit.get("results") or {}
    binding = formal_record_binding(calls)
    scope = narrative_audit.get("scope") or {}
    _require(scope.get("formal_records_audited") == len(calls), "narrative_audit_coverage_invalid")
    _require(scope.get("formal_record_set_sha256") == binding["formal_record_set_sha256"], "narrative_audit_binding_invalid")
    contradictory = narrative_results.get("explicitly_contradictory_records")
    _require(isinstance(contradictory, int) and 0 <= contradictory <= len(calls), "narrative_audit_count_invalid")
    by_group = narrative_results.get("explicit_contradictions_by_group") or {}
    _require(set(by_group) == {"zh_zh", "zh_en", "en_zh", "en_en"}, "narrative_audit_groups_invalid")
    _require(sum(int(value) for value in by_group.values()) == contradictory, "narrative_audit_group_sum_invalid")
    _require((summary.get("integrity_checks") or {}).get("formal_record_binding", {}).get("formal_record_set_sha256") == binding["formal_record_set_sha256"], "summary_record_binding_invalid")

    return {
        "ok": True,
        "formal_calls": len(calls),
        "pairs": len(by_pair),
        "strategy_sha256": metadata.get("strategy_body_sha256"),
        "output_schema_version": metadata.get("output_schema_version"),
        "market_data_sha256": data_metadata.get("market_data_sha256"),
    }


if __name__ == "__main__":
    print(json.dumps(verify(), ensure_ascii=False))
