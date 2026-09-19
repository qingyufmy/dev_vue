from __future__ import annotations

import re
from pathlib import Path

from .materials import read_source
from .storage import identifier, read_json, require, timestamp


STAGES = {
    "analyst": {"context": "市场背景", "structure": "结构与位置", "opportunity": "机会条件",
                "invalidation": "失效与更新", "wait": "等待与缺失信息"},
    "trader": {"wait": "等待条件", "entry": "入场", "cancel": "挂单取消",
               "protection": "保护与目标管理", "exit": "退出"},
}
ORIGINS = {"explicit_statement", "observed_behavior", "engineered_definition", "empirical_optimization"}
DEPENDENCIES = re.compile(r"\{\{|\}\}|\bTODO\b|\bTBD\b|待填写|待补充|请读取|读取本地|见参考文件|调用MT5|调用 MT5|\$[A-Za-z_]")


def text(value: object, code: str = "rule_text_required") -> str:
    require(isinstance(value, str) and 0 < len(value.strip()) <= 12000, code)
    require(not DEPENDENCIES.search(value), "prompt_unresolved_dependency")
    return value.strip()


def validate_rule(rule: dict, root: Path, mode: str, approved: bool = False) -> None:
    require(isinstance(rule, dict), "rule_object_required")
    identifier(rule.get("id"))
    role = rule.get("role")
    require(role in STAGES and rule.get("stage") in STAGES[role], "rule_stage_invalid")
    require(rule.get("origin") in ORIGINS, "rule_origin_invalid")
    text(rule.get("statement"))
    for name in ("conditions", "invalidation"):
        require(isinstance(rule.get(name), list) and 0 < len(rule[name]) <= 20, "rule_conditions_required", name)
        for item in rule[name]:
            text(item)
    require(isinstance(rule.get("required_inputs"), list) and bool(rule["required_inputs"]), "rule_inputs_required")
    for path in rule["required_inputs"]:
        require(isinstance(path, str) and re.fullmatch(r"[A-Za-z][A-Za-z0-9_.]*", path) is not None,
                "rule_input_path_invalid")
        if role == "analyst":
            require(path.split(".")[0] in ("market", "macro", "capturedAt"), "analyst_account_dependency_forbidden")
    require(rule.get("conflicts") == [], "rule_conflict_unresolved")
    evidence = rule.get("evidence")
    require(isinstance(evidence, list) and 0 < len(evidence) <= 30, "rule_evidence_required")
    for item in evidence:
        require(isinstance(item, dict), "evidence_invalid")
        source = read_source(root, item.get("source_id", ""))
        require(source["mode"] == mode and source["status"] == "ready", "evidence_source_unavailable")
        quote = item.get("quote")
        require(isinstance(quote, str) and bool(quote.strip()) and quote in source["text"], "evidence_quote_not_found")
        require(isinstance(item.get("locator"), str) and bool(item["locator"].strip()), "evidence_locator_required")
        if rule["origin"] in ("explicit_statement", "observed_behavior"):
            require(source["channel"] == "author", "system_feedback_is_not_author_evidence")
    review = rule.get("review", {})
    require(isinstance(review, dict) and review.get("status") in ("pending", "approved", "rejected"), "review_status_invalid")
    if approved:
        require(review.get("status") == "approved", "rule_not_reviewed")
        text(review.get("reviewer"), "reviewer_required")
        timestamp(review.get("reviewed_at"))


def load_approved(path: Path, root: Path, mode: str) -> list[dict]:
    document = read_json(path)
    require(isinstance(document, dict) and document.get("schema_version") == 1
            and isinstance(document.get("rules"), list), "rules_document_invalid")
    require(0 < len(document["rules"]) <= 200, "rules_empty_or_too_many")
    seen: set[str] = set()
    approved = []
    for rule in document["rules"]:
        require(isinstance(rule, dict), "rule_object_required")
        rule_id = identifier(rule.get("id"))
        require(rule_id not in seen, "rule_id_duplicate", rule_id)
        seen.add(rule_id)
        if rule.get("review", {}).get("status") != "approved":
            continue
        validate_rule(rule, root, mode, approved=True)
        approved.append(rule)
    for role, stages in STAGES.items():
        actual = {rule["stage"] for rule in approved if rule["role"] == role}
        require(actual == set(stages), "rule_coverage_incomplete", f"{role}: {','.join(sorted(set(stages) - actual))}")
    return sorted(approved, key=lambda item: (item["role"], list(STAGES[item["role"]]).index(item["stage"]), item["id"]))
