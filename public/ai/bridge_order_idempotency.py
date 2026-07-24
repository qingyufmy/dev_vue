# -*- coding: utf-8 -*-
"""MT5-side execution lookup used to make new-order delivery idempotent."""
from datetime import datetime, timedelta, timezone


def _text(value):
    return str(value or "").strip()


def _number_text(value):
    text = _text(value)
    return text if text not in ("", "0") else ""


def reference_matches(expected, actual):
    """Bridge references are short enough for an exact MT5 comment match."""
    expected_text = _text(expected)
    return bool(expected_text) and _text(actual) == expected_text


def _matches(row, symbol, command_ref, expected_tickets, system_magic):
    if symbol and _text(getattr(row, "symbol", "")) != symbol:
        return False
    if int(getattr(row, "magic", 0) or 0) != int(system_magic):
        return False
    # A durable command reference is stronger than a broker ticket. If both
    # are supplied, never let a ticket from another AI intent bypass the exact
    # comment check. Ticket-only matching remains available for legacy rows.
    if command_ref:
        return reference_matches(command_ref, getattr(row, "comment", ""))
    row_tickets = {
        _number_text(getattr(row, "ticket", "")),
        _number_text(getattr(row, "order", "")),
        _number_text(getattr(row, "position_id", "")),
    }
    row_tickets.discard("")
    return bool(row_tickets.intersection(expected_tickets))


def _pending_state(mt5, state):
    value = int(state if state is not None else -1)
    if value == int(getattr(mt5, "ORDER_STATE_FILLED", 4)):
        return "filled"
    if value == int(getattr(mt5, "ORDER_STATE_PARTIAL", 3)):
        return "partially_filled"
    if value == int(getattr(mt5, "ORDER_STATE_CANCELED", 2)):
        return "cancelled"
    if value == int(getattr(mt5, "ORDER_STATE_EXPIRED", 6)):
        return "expired"
    return "pending"


def _active_pending(row):
    ticket = getattr(row, "ticket", None) or getattr(row, "order", None)
    return {
        "status": "success", "found": True, "kind": "pending",
        "ticket": ticket, "order": ticket,
        "symbol": _text(getattr(row, "symbol", "")),
        "comment": _text(getattr(row, "comment", "")),
        "pending_state": "pending",
    }


def _active_trade(row):
    position_id = getattr(row, "ticket", None) or getattr(row, "position_id", None)
    return {
        "status": "success", "found": True, "kind": "trade",
        "ticket": position_id, "position_id": position_id,
        "symbol": _text(getattr(row, "symbol", "")),
        "comment": _text(getattr(row, "comment", "")),
    }


def _historical_order(mt5, row, expected_kind):
    order_ticket = getattr(row, "ticket", None) or getattr(row, "order", None)
    position_id = getattr(row, "position_id", None) or None
    state = int(getattr(row, "state", -1) if getattr(row, "state", None) is not None else -1)
    result = {
        "status": "success", "found": True, "kind": expected_kind,
        "ticket": order_ticket if expected_kind == "pending" else (position_id or order_ticket),
        "order": order_ticket, "position_id": position_id,
        "symbol": _text(getattr(row, "symbol", "")),
        "comment": _text(getattr(row, "comment", "")),
        "order_state": state,
    }
    if state == int(getattr(mt5, "ORDER_STATE_REJECTED", 5)):
        result["kind"] = "rejected"
        result["final_state"] = "rejected"
    elif expected_kind == "pending":
        result["pending_state"] = _pending_state(mt5, state)
    return result


def _historical_deal(row, expected_kind):
    order_ticket = getattr(row, "order", None) or getattr(row, "ticket", None)
    position_id = getattr(row, "position_id", None) or None
    ticket = order_ticket if expected_kind == "pending" else (position_id or order_ticket)
    result = {
        "status": "success", "found": True, "kind": expected_kind,
        "ticket": ticket, "order": order_ticket, "position_id": position_id,
        "deal": getattr(row, "ticket", None),
        "symbol": _text(getattr(row, "symbol", "")),
        "comment": _text(getattr(row, "comment", "")),
    }
    if expected_kind == "pending":
        result["pending_state"] = "filled"
    return result


def lookup_existing_execution(mt5, params, system_magic, resolve_symbol, now=None):
    """Return one compact matching execution or a complete not-found result."""
    params = params if isinstance(params, dict) else {}
    expected_kind = _text(params.get("expected_kind")).lower()
    if expected_kind not in ("pending", "trade"):
        return {"status": "rejected", "message": "expected_kind_required"}
    requested_symbol = _text(params.get("symbol"))
    symbol = resolve_symbol(requested_symbol) if requested_symbol else ""
    command_ref = _text(params.get("bridge_command_ref") or params.get("comment"))
    expected_tickets = {
        _number_text(value) for value in (
            params.get("trade_ticket"), params.get("pending_ticket"), params.get("ticket"),
        )
    }
    expected_tickets.discard("")
    if not command_ref and not expected_tickets:
        return {"status": "rejected", "message": "bridge_reference_required"}
    try:
        lookback_seconds = max(3600, min(int(params.get("lookback_seconds") or 172800), 315360000))
    except (TypeError, ValueError):
        lookback_seconds = 172800
    date_to = (now or datetime.now(timezone.utc)) + timedelta(minutes=5)
    date_from = date_to - timedelta(seconds=lookback_seconds)

    if expected_kind == "pending":
        active_orders = mt5.orders_get(symbol=symbol) if symbol else mt5.orders_get()
        if active_orders is None:
            return {"status": "error", "message": f"orders_get failed: {mt5.last_error()}"}
        for row in active_orders:
            if _matches(row, symbol, command_ref, expected_tickets, system_magic):
                return _active_pending(row)

        historical_orders = mt5.history_orders_get(date_from, date_to)
        if historical_orders is None:
            return {"status": "error", "message": f"history_orders_get failed: {mt5.last_error()}"}
        for row in reversed(historical_orders):
            if _matches(row, symbol, command_ref, expected_tickets, system_magic):
                return _historical_order(mt5, row, "pending")

        historical_deals = mt5.history_deals_get(date_from, date_to)
        if historical_deals is None:
            return {"status": "error", "message": f"history_deals_get failed: {mt5.last_error()}"}
        for row in reversed(historical_deals):
            if _matches(row, symbol, command_ref, expected_tickets, system_magic):
                return _historical_deal(row, "pending")
    else:
        active_positions = mt5.positions_get(symbol=symbol) if symbol else mt5.positions_get()
        if active_positions is None:
            return {"status": "error", "message": f"positions_get failed: {mt5.last_error()}"}
        for row in active_positions:
            if _matches(row, symbol, command_ref, expected_tickets, system_magic):
                return _active_trade(row)

        historical_deals = mt5.history_deals_get(date_from, date_to)
        if historical_deals is None:
            return {"status": "error", "message": f"history_deals_get failed: {mt5.last_error()}"}
        for row in reversed(historical_deals):
            if _matches(row, symbol, command_ref, expected_tickets, system_magic):
                return _historical_deal(row, "trade")

        historical_orders = mt5.history_orders_get(date_from, date_to)
        if historical_orders is None:
            return {"status": "error", "message": f"history_orders_get failed: {mt5.last_error()}"}
        for row in reversed(historical_orders):
            if _matches(row, symbol, command_ref, expected_tickets, system_magic):
                return _historical_order(mt5, row, "trade")

    return {
        "status": "success", "found": False, "complete": True,
        "lookback_seconds": lookback_seconds,
    }
