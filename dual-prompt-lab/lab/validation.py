"""Offline contract checks. These never grant execution/risk authorization."""
from __future__ import annotations

import re
from decimal import Decimal
from typing import Any

from .storage import require, strict_json, timestamp


REVISIONS = ("analysisRevision", "subscriptionRevision", "accountRevision", "positionsRevision",
             "pendingOrdersRevision", "quoteRevision", "contractRevision", "riskRevision")
ACTIONS = {"hold", "market_order", "pending_order", "modify_position", "close_position", "modify_order", "cancel_order"}
ANALYST_FIELDS = {"marketBias", "opportunity", "confidence", "bullishScore", "bearishScore", "summary", "marketRegime",
                  "supportingEvidence", "counterEvidence", "keyLevels", "invalidation", "dataGaps", "analysisBody", "analyzedAt", "validUntil"}
TRADER_FIELDS = {"action", "side", "confidence", "bullishScore", "bearishScore", "summary", "actions", "reasoning"}


def decimal(value: Any, *, positive: bool = True) -> Decimal:
    require(isinstance(value, str) and re.fullmatch(r"(?:0|[1-9][0-9]{0,29})(?:\.[0-9]{1,18})?", value) is not None,
            "decimal_string_required")
    number = Decimal(value)
    require(number > 0 if positive else number >= 0, "decimal_out_of_range")
    return number


def validate_input(role: str, value: dict) -> None:
    require(role in ("analyst", "trader") and isinstance(value, dict), "input_invalid")
    require(value.get("kind") == ("analysis" if role == "analyst" else "trader"), "input_role_mismatch")
    captured = timestamp(value.get("capturedAt"))
    require(isinstance(value.get("strategy"), dict), "strategy_identity_required")

    def walk(node: Any) -> None:
        if isinstance(node, list):
            for child in node:
                walk(child)
        elif isinstance(node, dict):
            for key, child in node.items():
                require(key not in {"conversation_id", "previous_response_id", "thread_id", "chat_history", "messages"},
                        "implicit_context_forbidden")
                if key in {"available_at", "availableAt", "confirmedAt"} and child is not None:
                    require(timestamp(child) <= captured, "future_evidence_forbidden")
                walk(child)

    walk(value)
    if role == "analyst":
        require(isinstance(value.get("market"), dict), "market_required")
        require(not ({"account", "positions", "pendingOrders", "risk"} & value.keys()), "analyst_account_context_forbidden")
    else:
        for key in ("analysis", "account", "quote", "contract", "risk"):
            require(isinstance(value.get(key), dict), "trader_input_object_required", key)
        require(isinstance(value["analysis"].get("result"), dict), "analysis_result_required")
        for key in ("positions", "pendingOrders"):
            require(isinstance(value.get(key), list) and all(isinstance(item, dict) for item in value[key]), "inventory_required", key)
            tickets = [item.get("ticket") for item in value[key]]
            require(all(isinstance(ticket, str) and ticket for ticket in tickets) and len(tickets) == len(set(tickets)),
                    "inventory_ticket_invalid")
        for key in REVISIONS:
            require(type(value.get(key)) is int and value[key] >= 1, "snapshot_revision_required", key)


def scores(value: dict) -> None:
    require(type(value.get("confidence")) in (int, float) and 0 <= value["confidence"] <= 100, "confidence_invalid")
    pair = [value.get("bullishScore"), value.get("bearishScore")]
    require(pair == [None, None] or (all(type(v) in (int, float) and 0 <= v <= 100 for v in pair)
                                    and sum(pair) > 0), "direction_scores_invalid")


def validate_output(role: str, raw: str, snapshot: dict, max_validity: int) -> dict:
    validate_input(role, snapshot)
    value = strict_json(raw)
    require(isinstance(value, dict) and set(value) == (ANALYST_FIELDS if role == "analyst" else TRADER_FIELDS),
            "output_fields_invalid")
    scores(value)
    require(isinstance(value["summary"], str) and bool(value["summary"].strip()), "summary_required")
    if role == "analyst":
        require(value["marketBias"] in ("bullish", "bearish", "neutral", "uncertain"), "market_bias_invalid")
        require(value["opportunity"] in ("none", "long_setup", "short_setup"), "opportunity_invalid")
        for key in ("marketRegime", "analysisBody"):
            require(isinstance(value[key], str) and bool(value[key].strip()), "analysis_text_invalid")
        for key in ("supportingEvidence", "counterEvidence", "dataGaps"):
            require(isinstance(value[key], list) and all(isinstance(item, str) for item in value[key]), "analysis_evidence_invalid")
        require(isinstance(value["keyLevels"], dict) and isinstance(value["invalidation"], dict), "analysis_structure_invalid")
        start, end = timestamp(value["analyzedAt"]), timestamp(value["validUntil"])
        require(start == timestamp(snapshot["capturedAt"]), "analysis_time_mismatch")
        require(0 < (end - start).total_seconds() <= max_validity, "analysis_validity_invalid")
    else:
        validate_trader(value, snapshot)
    return value


def validate_trader(value: dict, snapshot: dict) -> None:
    require(isinstance(value["action"], str) and value["action"] in ACTIONS and value["side"] in (None, "buy", "sell"), "trader_action_invalid")
    require(isinstance(value["reasoning"], str) and bool(value["reasoning"].strip()), "reasoning_required")
    actions = value["actions"]
    require(isinstance(actions, list) and len(actions) <= 16, "actions_invalid")
    if value["action"] == "hold":
        require(actions == [] and value["side"] is None, "hold_actions_forbidden")
        return
    require(bool(actions) and all(isinstance(action, dict) for action in actions), "actions_required")
    require(any(a.get("kind") == value["action"] for a in actions), "action_summary_mismatch")
    ids: set[str] = set()
    targets: set[tuple[str, str]] = set()
    event_ids: set[str] = set()
    for action in actions:
        require(set(action) == {"actionId", "kind", "parameters", "expectedState"}, "action_fields_invalid")
        require(isinstance(action["actionId"], str) and bool(action["actionId"]) and action["actionId"] not in ids,
                "action_id_invalid_or_duplicate")
        ids.add(action["actionId"])
        kind, parameters = action["kind"], action["parameters"]
        require(isinstance(kind, str) and kind in ACTIONS - {"hold"} and isinstance(parameters, dict), "action_structure_invalid")
        require(action["expectedState"] == {key: snapshot[key] for key in REVISIONS}, "expected_state_mismatch")
        require("after_close_target" not in parameters, "reserved_execution_field")
        opening = kind in ("market_order", "pending_order")
        if opening:
            validate_open(kind, parameters, snapshot, event_ids)
        else:
            require(not {"entry_event_id", "position_size_tier", "risk_ceiling_percent"} & parameters.keys(), "opening_field_on_management")
            inventory = "positions" if kind in ("modify_position", "close_position") else "pendingOrders"
            ticket = parameters.get("ticket")
            require(isinstance(ticket, str) and ticket in {item["ticket"] for item in snapshot[inventory]}, "target_not_in_account")
            key = (inventory, ticket)
            require(key not in targets, "conflicting_target_actions")
            targets.add(key)
            if kind.startswith("modify_"):
                require(bool(set(parameters) & {"stop_loss", "take_profit", "sl", "tp", "price", "expiration_utc_msc", "stop_limit_price",
                                               "remove_stop_loss", "remove_take_profit", "remove_expiration"}), "empty_modification")
        for field in ("volume", "price", "stop_limit_price"):
            if field in parameters:
                decimal(parameters[field])
        for field in ("stop_loss", "take_profit", "sl", "tp"):
            if field in parameters:
                decimal(parameters[field], positive=False)
        if "close_percent" in parameters:
            require(kind == "close_position" and "volume" not in parameters, "partial_close_conflict")
            require(decimal(parameters["close_percent"]) < 100, "partial_close_percent_invalid")
        if "after_close_protection" in parameters:
            protection = parameters["after_close_protection"]
            require(kind == "close_position" and bool({"close_percent", "volume"} & parameters.keys())
                    and isinstance(protection, dict) and 0 < len(protection) <= 2
                    and set(protection) <= {"stop_loss", "take_profit"}, "after_close_protection_invalid")
            for price in protection.values():
                decimal(price)


def validate_open(kind: str, p: dict, snapshot: dict, event_ids: set[str]) -> None:
    analysis = snapshot["analysis"]["result"]
    require(timestamp(analysis.get("validUntil")) > timestamp(snapshot["capturedAt"]), "analysis_expired")
    require(analysis.get("opportunity") in ("long_setup", "short_setup"), "entry_opportunity_missing")
    require(bool(snapshot["risk"]) and bool(snapshot["contract"]) and bool(snapshot["account"]), "entry_context_missing")
    require(snapshot["risk"].get("status") not in ("unavailable", "blocked", "stale", "unknown"), "entry_risk_unavailable")
    require(isinstance(p.get("symbol"), str) and p["symbol"] == snapshot["quote"].get("symbol"), "entry_symbol_mismatch")
    if kind == "market_order":
        require(p.get("side") in ("buy", "sell"), "entry_side_invalid")
        side, method = p["side"], "market"
    else:
        order_type = p.get("type")
        require(isinstance(order_type, str) and order_type in {f"{side}_{suffix}" for side in ("buy", "sell") for suffix in ("limit", "stop", "stop_limit")},
                "pending_type_invalid")
        side, method = order_type.split("_", 1)
        decimal(p.get("price"))
        if method == "stop_limit":
            decimal(p.get("stop_limit_price"))
    require(side == ("buy" if analysis["opportunity"] == "long_setup" else "sell"), "entry_analysis_direction_mismatch")
    if "entryMethods" in snapshot:
        require(method in snapshot["entryMethods"], "entry_method_forbidden")
    if "position_size_tier" in p:
        require(p["position_size_tier"] in ("probe", "light", "standard") and not {"volume", "position_size_factor"} & p.keys(),
                "position_size_mode_conflict")
        decimal(p.get("stop_loss", p.get("sl")))
    else:
        decimal(p.get("volume"))
    if "risk_ceiling_percent" in p:
        require(decimal(p["risk_ceiling_percent"]) <= 100, "risk_ceiling_invalid")
    if "executionPreferences" in snapshot:
        prices = p.get("take_profit_prices")
        tier = p.get("recommended_take_profit_tier")
        require("take_profit_prices" in p and "recommended_take_profit_tier" in p and isinstance(prices, list) and len(prices) == 3,
                "take_profit_preferences_required")
        require(tier is None or (type(tier) is int and tier in (1, 2, 3)), "take_profit_tier_invalid")
        for price in prices:
            if price is not None:
                decimal(price)
    if "entryEventPolicy" in snapshot or "entry_event_id" in p:
        event_id = p.get("entry_event_id")
        require(isinstance(event_id, str) and re.fullmatch(r"event:[a-f0-9]{64}", event_id) is not None and event_id not in event_ids,
                "entry_event_invalid_or_duplicate")
        event_ids.add(event_id)
        catalogue = snapshot.get("marketEntryEvents", {})
        require(catalogue.get("analysisId") == snapshot["analysis"].get("id"), "entry_event_analysis_mismatch")
        matches = []
        for timeframe, raw in catalogue.get("timeframes", {}).items():
            if not isinstance(raw, dict) or raw.get("state") != "ready":
                continue
            if (raw.get("timeframe") != timeframe or raw.get("symbol") != p["symbol"]
                    or raw.get("sourceAccountId") != catalogue.get("sourceAccountId")):
                continue
            for event in raw.get("events", []):
                if event.get("id") == event_id:
                    require(event.get("stillValid") is True and event.get("direction") == ("up" if side == "buy" else "down")
                            and timestamp(event.get("confirmedAt")) <= timestamp(snapshot["capturedAt"]), "entry_event_not_admissible")
                    policy = snapshot.get("entryEventPolicy")
                    require(policy is None or (policy.get("version") == 1 and policy.get("mode") == "required" and policy.get("timeframe") == timeframe),
                            "entry_event_policy_mismatch")
                    matches.append(event)
        require(len(matches) == 1, "entry_event_missing_or_ambiguous")
        usage = snapshot.get("entryEventUsage", {})
        require(usage.get("state") == "read" and usage.get("accountId") == snapshot["account"].get("id")
                and usage.get("strategyId") == snapshot["strategy"].get("id"), "entry_event_usage_unavailable")
        records = [item for item in usage.get("items", []) if item.get("eventId") == event_id]
        require(len(records) == 1 and records[0].get("state") == "available", "entry_event_not_available")
