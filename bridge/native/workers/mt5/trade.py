from __future__ import annotations

from collections import OrderedDict
from datetime import datetime, timedelta, timezone
import math
import time
from typing import Any, Callable


class TradeError(RuntimeError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


class Mt5TradeExecutor:
    """Strict MT5 mutation/query adapter for the native Worker IPC."""

    def __init__(self, mt5: Any, route: Any, ensure_identity: Callable[[], tuple[Any, Any]],
                 resolve_symbol: Callable[[str], str], clock_msc: Callable[[], int] | None = None,
                 report_exception: Callable[[str, BaseException], None] | None = None):
        self.mt5 = mt5
        self.route = route
        self._ensure_identity = ensure_identity
        self._resolve_symbol = resolve_symbol
        self._clock_msc = clock_msc or (lambda: int(time.time() * 1000))
        self._report_exception = report_exception or (lambda _stage, _error: None)
        self._receipts: OrderedDict[str, dict[str, Any]] = OrderedDict()

    def execute(self, command: dict[str, Any], read_only: bool = False) -> dict[str, Any]:
        command_id = str(command.get("command_id") or "")
        cached = self._receipts.get(command_id)
        if cached is not None:
            return cached
        try:
            deadline = int(command.get("deadline_utc_msc") or 0)
            if deadline <= self._clock_msc():
                result = self._result(command, "rejected", "command_expired")
            else:
                action = str(command.get("action") or "")
                params = command.get("params")
                if not isinstance(params, dict):
                    raise TradeError("command_params_invalid")
                if read_only:
                    if action != "query_execution":
                        raise TradeError("worker_query_action_invalid")
                    self._ensure_identity()
                    result = self._query_execution(command, params)
                else:
                    if action == "query_execution":
                        raise TradeError("worker_execute_action_invalid")
                    handlers = {
                        "place_order": self._place_order,
                        "cancel_order": self._cancel_order,
                        "modify_order": self._modify_order,
                        "modify_position": self._modify_position,
                        "close_position": self._close_position,
                    }
                    handler = handlers.get(action)
                    if handler is None:
                        raise TradeError("command_action_unsupported")
                    result = handler(command, params)
        except TradeError as error:
            result = self._result(command, "rejected", error.code)
        except Exception as error:
            try:
                self._report_exception("trade_execute", error)
            except Exception:
                pass
            result = self._result(command, "uncertain", "mt5_execution_exception")
        self._remember(command_id, result)
        return result

    def _ensure_trade_allowed(self) -> None:
        account, terminal = self._ensure_identity()
        if not bool(getattr(account, "trade_allowed", False)):
            raise TradeError("mt5_account_trade_disabled")
        if hasattr(account, "trade_expert") and not bool(account.trade_expert):
            raise TradeError("mt5_account_expert_disabled")
        if not bool(getattr(terminal, "trade_allowed", False)):
            raise TradeError("mt5_terminal_trade_disabled")
        if bool(getattr(terminal, "tradeapi_disabled", False)):
            raise TradeError("mt5_trade_api_disabled")

    def _place_order(self, command: dict[str, Any], params: dict[str, Any]) -> dict[str, Any]:
        symbol = self._resolve_symbol(str(params["symbol"]))
        side = str(params["side"]).lower()
        kind = str(params.get("order_kind") or "market").lower()
        volume = self._positive(params["volume"], "volume")
        info = self.mt5.symbol_info(symbol)
        tick = self.mt5.symbol_info_tick(symbol)
        if info is None:
            raise TradeError("symbol_info_unavailable")
        if tick is None:
            raise TradeError("symbol_tick_unavailable")
        self._validate_volume(info, volume)
        order_types = {
            ("market", "buy"): self.mt5.ORDER_TYPE_BUY,
            ("market", "sell"): self.mt5.ORDER_TYPE_SELL,
            ("limit", "buy"): self.mt5.ORDER_TYPE_BUY_LIMIT,
            ("limit", "sell"): self.mt5.ORDER_TYPE_SELL_LIMIT,
            ("stop", "buy"): self.mt5.ORDER_TYPE_BUY_STOP,
            ("stop", "sell"): self.mt5.ORDER_TYPE_SELL_STOP,
            ("stop_limit", "buy"): self.mt5.ORDER_TYPE_BUY_STOP_LIMIT,
            ("stop_limit", "sell"): self.mt5.ORDER_TYPE_SELL_STOP_LIMIT,
        }
        order_type = order_types.get((kind, side))
        if order_type is None:
            raise TradeError("order_kind_invalid")
        is_market = kind == "market"
        request: dict[str, Any] = {
            "action": self.mt5.TRADE_ACTION_DEAL if is_market else self.mt5.TRADE_ACTION_PENDING,
            "symbol": symbol,
            "volume": volume,
            "type": order_type,
            "price": self._positive(
                params.get("price") or (tick.ask if side == "buy" else tick.bid), "price"),
            "deviation": int(params.get("deviation") or 20),
            "magic": int(params["magic"]) if params.get("magic") is not None else 234000,
            "comment": str(params.get("comment") or f"AURUM:{str(command['command_id'])[-20:]}"),
            "type_time": int(params.get("type_time") or getattr(self.mt5, "ORDER_TIME_GTC", 0)),
            "type_filling": int(params.get("type_filling") if params.get("type_filling") is not None
                                else self._filling_mode(info, not is_market)),
        }
        for source, target in (("stop_loss", "sl"), ("take_profit", "tp"),
                               ("stop_limit_price", "stoplimit")):
            if params.get(source) is not None:
                request[target] = self._positive(params[source], source)
        if params.get("expiration") is not None:
            request["expiration"] = int(params["expiration"])
        return self._send(command, request)

    def _cancel_order(self, command: dict[str, Any], params: dict[str, Any]) -> dict[str, Any]:
        ticket = self._ticket(params["ticket"])
        orders = self.mt5.orders_get(ticket=ticket)
        if orders is None:
            raise TradeError("orders_query_failed")
        if not orders:
            return self._result(command, "succeeded", raw={"already_absent": True, "order": ticket})
        if len(orders) != 1:
            raise TradeError("management_target_ambiguous")
        if isinstance(params.get("expected_state"), dict):
            self._validate_target(params["expected_state"], orders[0], "pending")
        sent = self._send(command, {"action": self.mt5.TRADE_ACTION_REMOVE, "order": ticket})
        if sent["status"] == "rejected":
            return sent
        remaining = self.mt5.orders_get(ticket=ticket)
        if remaining is None:
            return self._result(command, "uncertain", "cancel_order_verify_failed",
                                raw=sent.get("raw_result"), evidence=sent.get("evidence"))
        if remaining:
            return self._result(command, "uncertain", "pending_order_still_active",
                                raw=sent.get("raw_result"), evidence=sent.get("evidence"))
        raw = dict(sent.get("raw_result") or {})
        raw.update({"already_absent": False, "order": ticket})
        return self._result(command, "succeeded", raw=raw, evidence=sent.get("evidence"))

    def _modify_order(self, command: dict[str, Any], params: dict[str, Any]) -> dict[str, Any]:
        ticket = self._ticket(params["ticket"])
        current = self.mt5.orders_get(ticket=ticket)
        if current is None:
            raise TradeError("orders_query_failed")
        if len(current) != 1:
            raise TradeError("pending_order_not_found")
        expected = params.get("expected_state")
        if not isinstance(expected, dict):
            raise TradeError("management_expected_state_required")
        self._validate_target(expected, current[0], "pending")
        request: dict[str, Any] = {
            "action": self.mt5.TRADE_ACTION_MODIFY,
            "order": ticket,
        }
        for source, target in (("price", "price"), ("stop_loss", "sl"),
                               ("take_profit", "tp"), ("stop_limit_price", "stoplimit")):
            if params.get(source) is not None:
                request[target] = self._positive(params[source], source)
        if params.get("expiration") is not None:
            request["expiration"] = int(params["expiration"])
        sent = self._send(command, request)
        if sent["status"] == "rejected":
            return sent
        verified = self.mt5.orders_get(ticket=ticket)
        if verified is None or len(verified) != 1:
            return self._result(command, "uncertain", "modify_order_verify_failed",
                                raw=sent.get("raw_result"), evidence=sent.get("evidence"))
        aliases = {"price": "price_open", "stop_loss": "sl", "take_profit": "tp",
                   "stop_limit_price": "price_stoplimit", "expiration": "time_expiration"}
        for source, target in aliases.items():
            if params.get(source) is None:
                continue
            actual = float(getattr(verified[0], target, 0) or 0)
            if abs(actual - float(params[source])) > self._price_tolerance(verified[0].symbol):
                return self._result(command, "uncertain", "pending_order_change_not_applied",
                                    raw=sent.get("raw_result"), evidence=sent.get("evidence"))
        raw = dict(sent.get("raw_result") or {})
        raw["order"] = ticket
        return self._result(command, "succeeded", raw=raw, evidence=sent.get("evidence"))

    def _modify_position(self, command: dict[str, Any], params: dict[str, Any]) -> dict[str, Any]:
        ticket = self._ticket(params["ticket"])
        positions = self.mt5.positions_get(ticket=ticket)
        if positions is None:
            raise TradeError("positions_query_failed")
        if len(positions) != 1:
            raise TradeError("system_position_not_found")
        position = positions[0]
        expected = params.get("expected_state")
        if not isinstance(expected, dict):
            raise TradeError("management_expected_state_required")
        self._validate_target(expected, position, "position")
        self._validate_protection_snapshot(expected, position)
        info = self.mt5.symbol_info(position.symbol)
        tick = self.mt5.symbol_info_tick(position.symbol)
        if info is None or tick is None:
            raise TradeError("position_symbol_quote_unavailable")
        point = float(getattr(info, "point", 0) or 0)
        tick_size = float(getattr(info, "trade_tick_size", 0) or point or 1e-8)
        digits = max(0, int(getattr(info, "digits", 0) or 0))

        def normalized(value: Any, current: Any) -> float:
            if value is None:
                return float(current or 0)
            price = self._positive(value, "protection_price")
            return round(round(price / tick_size) * tick_size, digits)

        next_sl = normalized(params.get("stop_loss"), position.sl)
        next_tp = normalized(params.get("take_profit"), position.tp)
        minimum_points = max(int(getattr(info, "trade_stops_level", 0) or 0),
                             int(getattr(info, "trade_freeze_level", 0) or 0))
        minimum_distance = minimum_points * point
        is_buy = int(position.type) == int(self.mt5.POSITION_TYPE_BUY)
        if params.get("stop_loss") is not None:
            valid = next_sl < float(tick.bid) - minimum_distance if is_buy \
                else next_sl > float(tick.ask) + minimum_distance
            if not valid:
                raise TradeError("stop_loss_direction_or_distance_invalid")
        if params.get("take_profit") is not None:
            valid = next_tp > float(tick.ask) + minimum_distance if is_buy \
                else next_tp < float(tick.bid) - minimum_distance
            if not valid:
                raise TradeError("take_profit_direction_or_distance_invalid")
        tolerance = max(point / 2, tick_size / 2, 1e-8)
        if abs(float(position.sl or 0) - next_sl) <= tolerance \
                and abs(float(position.tp or 0) - next_tp) <= tolerance:
            return self._result(command, "succeeded", raw={
                "position": ticket, "stop_loss": next_sl, "take_profit": next_tp,
                "already_applied": True,
            }, evidence={"observed_at_utc_msc": self._clock_msc(),
                         "order_tickets": [], "position_tickets": [str(ticket)],
                         "deal_tickets": [], "broker_retcode": None})
        sent = self._send(command, {
            "action": self.mt5.TRADE_ACTION_SLTP,
            "position": ticket,
            "symbol": position.symbol,
            "sl": next_sl,
            "tp": next_tp,
            "magic": int(params.get("magic") or 234000),
        })
        if sent["status"] == "rejected":
            return sent
        current = self.mt5.positions_get(ticket=ticket)
        if current is None or len(current) != 1:
            return self._result(command, "uncertain", "modify_position_verify_failed",
                                raw=sent.get("raw_result"), evidence=sent.get("evidence"))
        if abs(float(current[0].sl or 0) - next_sl) > tolerance \
                or abs(float(current[0].tp or 0) - next_tp) > tolerance:
            return self._result(command, "uncertain", "position_protection_not_applied",
                                raw=sent.get("raw_result"), evidence=sent.get("evidence"))
        raw = dict(sent.get("raw_result") or {})
        raw.update({"position": ticket, "stop_loss": next_sl, "take_profit": next_tp})
        return self._result(command, "succeeded", raw=raw, evidence=sent.get("evidence"))

    def _close_position(self, command: dict[str, Any], params: dict[str, Any]) -> dict[str, Any]:
        ticket = self._ticket(params["ticket"])
        positions = self.mt5.positions_get(ticket=ticket)
        if positions is None:
            raise TradeError("positions_query_failed")
        if not positions and isinstance(params.get("expected_state"), dict):
            return self._result(command, "succeeded", raw={"already_absent": True, "position": ticket})
        if len(positions) != 1:
            raise TradeError("position_not_found")
        position = positions[0]
        if isinstance(params.get("expected_state"), dict):
            self._validate_target(params["expected_state"], position, "position")
        volume = float(params.get("volume") or position.volume)
        if not math.isfinite(volume) or volume <= 0 or volume > float(position.volume):
            raise TradeError("close_volume_invalid")
        tick = self.mt5.symbol_info_tick(position.symbol)
        info = self.mt5.symbol_info(position.symbol)
        if tick is None or info is None:
            raise TradeError("position_symbol_quote_unavailable")
        is_buy = int(position.type) == int(self.mt5.POSITION_TYPE_BUY)
        sent = self._send(command, {
            "action": self.mt5.TRADE_ACTION_DEAL,
            "position": ticket,
            "symbol": position.symbol,
            "volume": volume,
            "type": self.mt5.ORDER_TYPE_SELL if is_buy else self.mt5.ORDER_TYPE_BUY,
            "price": float(tick.bid if is_buy else tick.ask),
            "deviation": int(params.get("deviation") or 20),
            "magic": int(params["magic"]) if params.get("magic") is not None else 234000,
            "comment": f"AURUM:{str(command['command_id'])[-20:]}",
            "type_filling": self._filling_mode(info, False),
        })
        if sent["status"] == "rejected":
            return sent
        remaining = self.mt5.positions_get(ticket=ticket)
        if remaining is None:
            return self._result(command, "uncertain", "close_position_verify_failed",
                                raw=sent.get("raw_result"), evidence=sent.get("evidence"))
        raw = dict(sent.get("raw_result") or {})
        raw["position"] = ticket
        expected_remaining = max(0.0, float(position.volume) - volume)
        volume_step = float(getattr(info, "volume_step", 0) or 0)
        volume_tolerance = max(1e-8, volume_step / 2)
        if not remaining and expected_remaining <= volume_tolerance:
            return self._result(command, "succeeded", raw=raw, evidence=sent.get("evidence"))
        if len(remaining) == 1:
            actual_remaining = float(remaining[0].volume)
            raw["remaining_volume"] = actual_remaining
            if abs(actual_remaining - expected_remaining) <= volume_tolerance:
                raw["partial_close"] = expected_remaining > volume_tolerance
                return self._result(command, "succeeded", raw=raw,
                                    evidence=sent.get("evidence"))
            error = "close_position_volume_mismatch" \
                if actual_remaining < float(position.volume) else "position_still_open"
        else:
            error = "close_position_volume_mismatch"
        return self._result(command, "uncertain", error,
                            raw=raw, evidence=sent.get("evidence"))

    def _send(self, command: dict[str, Any], request: dict[str, Any]) -> dict[str, Any]:
        self._ensure_trade_allowed()
        check = self.mt5.order_check(request)
        if check is None:
            return self._result(command, "rejected", "mt5_order_check_failed")
        check_retcode = int(getattr(check, "retcode", -1))
        if check_retcode not in (0, int(getattr(self.mt5, "TRADE_RETCODE_DONE", 10009))):
            return self._result(command, "rejected", f"mt5_check_retcode_{check_retcode}",
                                raw={"check": self._plain(check)})
        # The account may be switched or AutoTrading may be disabled while order_check runs.
        self._ensure_trade_allowed()
        try:
            result = self.mt5.order_send(request)
        except Exception as error:
            try:
                self._report_exception("order_send", error)
            except Exception:
                pass
            return self._result(command, "uncertain", "mt5_order_send_exception")
        if result is None:
            return self._result(command, "uncertain", "mt5_order_result_missing")
        retcode = int(getattr(result, "retcode", -1))
        is_pending = int(request.get("action", -1)) == int(self.mt5.TRADE_ACTION_PENDING)
        if retcode == int(getattr(self.mt5, "TRADE_RETCODE_DONE", 10009)) \
                or (is_pending and retcode == int(getattr(self.mt5, "TRADE_RETCODE_PLACED", 10008))):
            status, error = "succeeded", None
        elif retcode == int(getattr(self.mt5, "TRADE_RETCODE_DONE_PARTIAL", 10010)) \
                or int(getattr(result, "order", 0) or 0) > 0 \
                or int(getattr(result, "deal", 0) or 0) > 0:
            status, error = "uncertain", "mt5_execution_requires_reconciliation"
        else:
            status, error = "rejected", f"mt5_retcode_{retcode}"
        evidence = {
            "observed_at_utc_msc": self._clock_msc(),
            "order_tickets": [str(result.order)] if getattr(result, "order", 0) else [],
            "position_tickets": [],
            "deal_tickets": [str(result.deal)] if getattr(result, "deal", 0) else [],
            "broker_retcode": retcode,
        }
        return self._result(command, status, error, raw=self._plain(result), evidence=evidence)

    def _query_execution(self, command: dict[str, Any], params: dict[str, Any]) -> dict[str, Any]:
        kind = str(params["expected_kind"])
        symbol = self._resolve_symbol(str(params["symbol"])) if params.get("symbol") else ""
        reference = str(params.get("bridge_command_ref") or "")
        expected_magic = params.get("magic")
        tickets = {str(params.get(key) or "") for key in ("trade_ticket", "pending_ticket", "ticket")}
        tickets.discard("")
        lookback = int(params.get("lookback_seconds") or 172_800)

        def matches(row: Any) -> bool:
            if symbol and str(getattr(row, "symbol", "")) != symbol:
                return False
            if expected_magic is not None \
                    and int(getattr(row, "magic", 0) or 0) != int(expected_magic):
                return False
            row_tickets = {str(getattr(row, field, "") or "")
                           for field in ("ticket", "order", "position_id")}
            if tickets:
                return bool(tickets & row_tickets)
            return bool(reference) and str(getattr(row, "comment", "") or "") == reference

        active = self.mt5.orders_get(symbol=symbol) if kind == "pending" and symbol \
            else self.mt5.orders_get() if kind == "pending" \
            else self.mt5.positions_get(symbol=symbol) if symbol else self.mt5.positions_get()
        if active is None:
            raise TradeError("orders_query_failed" if kind == "pending" else "positions_query_failed")
        row = next((item for item in active if matches(item)), None)
        source = "active_order" if row is not None and kind == "pending" \
            else "active_position" if row is not None else ""
        deal = None
        if row is None:
            date_to = datetime.now(timezone.utc) + timedelta(minutes=5)
            date_from = date_to - timedelta(seconds=lookback)
            history_orders = self.mt5.history_orders_get(date_from, date_to)
            if history_orders is None:
                raise TradeError("history_orders_query_failed")
            row = next((item for item in reversed(history_orders) if matches(item)), None)
            if row is not None:
                source = "history_order"
            if row is None:
                history_deals = self.mt5.history_deals_get(date_from, date_to)
                if history_deals is None:
                    raise TradeError("history_deals_query_failed")
                deal = next((item for item in reversed(history_deals) if matches(item)), None)
                if deal is not None:
                    source = "history_deal"
        found = row or deal
        raw: dict[str, Any] = {"found": found is not None, "complete": True,
                               "lookback_seconds": lookback}
        evidence = None
        if found is not None:
            order = getattr(found, "order", None) or (getattr(found, "ticket", None) if kind == "pending" else None)
            position = getattr(found, "position_id", None) or (getattr(found, "ticket", None)
                                                                if kind == "trade" and row is not None else None)
            deal_ticket = getattr(deal, "ticket", None) if deal is not None else None
            raw.update({"kind": kind, "ticket": position or order, "order": order,
                        "position_id": position, "deal": deal_ticket,
                        "symbol": getattr(found, "symbol", symbol),
                        "magic": int(getattr(found, "magic", 0) or 0),
                        "volume": float(getattr(found, "volume", None)
                                        or getattr(found, "volume_current", None)
                                        or getattr(found, "volume_initial", 0) or 0),
                        "price": float(getattr(found, "price_open", 0) or 0),
                        "stop_loss": float(getattr(found, "sl", 0) or 0),
                        "take_profit": float(getattr(found, "tp", 0) or 0),
                        "stop_limit_price": float(getattr(found, "price_stoplimit", 0) or 0),
                        "expiration": int(getattr(found, "time_expiration", 0) or 0),
                        "comment": str(getattr(found, "comment", "") or ""),
                        "current_state": source})
            if kind == "pending":
                if source == "active_order":
                    raw["pending_state"] = "pending"
                elif source == "history_deal":
                    raw.update({"pending_state": "filled", "final_state": "filled"})
                else:
                    state = int(getattr(found, "state", -1))
                    states = {
                        int(getattr(self.mt5, "ORDER_STATE_CANCELED", 2)): "cancelled",
                        int(getattr(self.mt5, "ORDER_STATE_PARTIAL", 3)): "partially_filled",
                        int(getattr(self.mt5, "ORDER_STATE_FILLED", 4)): "filled",
                        int(getattr(self.mt5, "ORDER_STATE_REJECTED", 5)): "rejected",
                        int(getattr(self.mt5, "ORDER_STATE_EXPIRED", 6)): "expired",
                    }
                    pending_state = states.get(state, "pending")
                    raw["pending_state"] = pending_state
                    if pending_state != "pending":
                        raw["final_state"] = pending_state
            evidence = {
                "observed_at_utc_msc": self._clock_msc(),
                "order_tickets": [str(order)] if order else [],
                "position_tickets": [str(position)] if position else [],
                "deal_tickets": [str(deal_ticket)] if deal_ticket else [],
                "broker_retcode": None,
            }
        if params.get("original_action"):
            raw["resolution"] = self._resolve_reconciliation(params, raw, source)
        return self._result(command, "succeeded", raw=raw, evidence=evidence)

    def _resolve_reconciliation(self, params: dict[str, Any], observed: dict[str, Any],
                                source: str) -> dict[str, Any]:
        action = str(params["original_action"])
        original = params["original_params"]
        elapsed = self._clock_msc() - int(params["original_issued_at_utc_msc"])
        settled = elapsed >= int(params.get("settle_after_msc") or 15_000)

        def unresolved(code: str) -> dict[str, Any]:
            return {"status": "failed", "error_code": code} if settled \
                else {"status": "pending", "error_code": "reconciliation_settlement_pending"}

        if action == "place_order":
            if not observed["found"]:
                return unresolved("execution_not_found_after_settlement")
            if observed.get("pending_state") in {"cancelled", "rejected", "expired"}:
                return {"status": "failed",
                        "error_code": f"pending_order_{observed['pending_state']}"}
            return {"status": "succeeded"}

        if action == "cancel_order":
            if source == "active_order":
                return unresolved("pending_order_still_active")
            if observed.get("pending_state") in {"filled", "partially_filled"}:
                return {"status": "failed", "error_code": "pending_order_already_filled"}
            return {"status": "succeeded"}

        if action == "close_position":
            if source != "active_position":
                return {"status": "succeeded"}
            expected = original.get("expected_state") or {}
            before = float(expected.get("volume") or 0)
            requested = float(original.get("volume") or before)
            if before > 0 and float(observed.get("volume") or 0) <= max(0.0, before - requested) + 1e-8:
                return {"status": "succeeded"}
            return unresolved("position_still_open")

        if action == "modify_order":
            if source != "active_order":
                return unresolved("pending_order_not_active")
            aliases = {"price": "price", "stop_loss": "stop_loss",
                       "take_profit": "take_profit", "stop_limit_price": "stop_limit_price",
                       "expiration": "expiration"}
            tolerance = self._price_tolerance(str(observed.get("symbol") or ""))
            for expected_key, actual_key in aliases.items():
                if expected_key not in original:
                    continue
                expected = float(original[expected_key])
                actual = float(observed.get(actual_key) or 0)
                if expected_key == "expiration":
                    if int(expected) != int(actual):
                        return unresolved("pending_order_change_not_applied")
                elif abs(expected - actual) > tolerance:
                    return unresolved("pending_order_change_not_applied")
            return {"status": "succeeded"}

        if action == "modify_position":
            if source != "active_position":
                return unresolved("position_not_active")
            tolerance = self._price_tolerance(str(observed.get("symbol") or ""))
            for expected_key in ("stop_loss", "take_profit"):
                if expected_key not in original:
                    continue
                expected = float(original[expected_key] or 0)
                actual = float(observed.get(expected_key) or 0)
                if abs(expected - actual) > tolerance:
                    return unresolved("position_protection_not_applied")
            return {"status": "succeeded"}

        return {"status": "pending", "error_code": "reconciliation_action_unsupported"}

    def _validate_target(self, expected: dict[str, Any], target: Any, kind: str) -> None:
        if str(expected["ticket"]) != str(getattr(target, "ticket", "")):
            raise TradeError("management_ticket_mismatch")
        if str(expected["symbol"]) != str(getattr(target, "symbol", "")):
            raise TradeError("management_symbol_mismatch")
        if int(expected["magic"]) != int(getattr(target, "magic", 0) or 0):
            raise TradeError("management_magic_mismatch")
        actual_volume = getattr(target, "volume", None)
        if actual_volume is None:
            actual_volume = getattr(target, "volume_current", None) or getattr(target, "volume_initial", 0)
        if abs(float(expected["volume"]) - float(actual_volume)) > 1e-8:
            raise TradeError("management_volume_mismatch")
        if kind == "position":
            direction = "buy" if int(target.type) == int(self.mt5.POSITION_TYPE_BUY) else "sell"
        else:
            buy_types = {int(self.mt5.ORDER_TYPE_BUY_LIMIT), int(self.mt5.ORDER_TYPE_BUY_STOP),
                         int(self.mt5.ORDER_TYPE_BUY_STOP_LIMIT)}
            direction = "buy" if int(target.type) in buy_types else "sell"
        if str(expected["direction"]).lower() != direction:
            raise TradeError("management_direction_mismatch")
        if expected.get("broker_server_key") and str(expected["broker_server_key"]).upper() \
                != str(self.route.broker_server).upper():
            raise TradeError("management_account_server_mismatch")
        if expected.get("login_account") and str(expected["login_account"]) != str(self.route.login):
            raise TradeError("management_account_login_mismatch")

    def _validate_protection_snapshot(self, expected: dict[str, Any], position: Any) -> None:
        tolerance = self._price_tolerance(position.symbol)
        for field, actual, code in (("stop_loss", float(position.sl or 0), "position_stop_loss_changed"),
                                    ("take_profit", float(position.tp or 0), "position_take_profit_changed")):
            if expected.get(field) is not None and abs(float(expected[field]) - actual) > tolerance:
                raise TradeError(code)

    def _price_tolerance(self, symbol: str) -> float:
        info = self.mt5.symbol_info(symbol)
        if info is None:
            raise TradeError("symbol_info_unavailable")
        return max(float(getattr(info, "point", 0) or 0) / 2,
                   float(getattr(info, "trade_tick_size", 0) or 0) / 2, 1e-8)

    def _filling_mode(self, info: Any, pending: bool) -> int:
        if pending:
            return int(getattr(self.mt5, "ORDER_FILLING_RETURN", 2))
        filling = int(getattr(info, "filling_mode", 0) or 0)
        if filling & 2:
            return int(getattr(self.mt5, "ORDER_FILLING_IOC", 1))
        if filling & 1:
            return int(getattr(self.mt5, "ORDER_FILLING_FOK", 0))
        return int(getattr(self.mt5, "ORDER_FILLING_IOC", 1))

    @staticmethod
    def _positive(value: Any, field: str) -> float:
        try:
            number = float(value)
        except (TypeError, ValueError, OverflowError) as error:
            raise TradeError(f"{field}_invalid") from error
        if not math.isfinite(number) or number <= 0:
            raise TradeError(f"{field}_invalid")
        return number

    @staticmethod
    def _ticket(value: Any) -> int:
        try:
            ticket = int(value)
        except (TypeError, ValueError, OverflowError) as error:
            raise TradeError("ticket_required") from error
        if ticket <= 0:
            raise TradeError("ticket_required")
        return ticket

    @staticmethod
    def _validate_volume(info: Any, volume: float) -> None:
        minimum = float(getattr(info, "volume_min", 0) or 0)
        maximum = float(getattr(info, "volume_max", 0) or 0)
        step = float(getattr(info, "volume_step", 0) or 0)
        epsilon = max(1e-9, step * 1e-6)
        if minimum and volume < minimum - epsilon:
            raise TradeError("order_volume_below_minimum")
        if maximum and volume > maximum + epsilon:
            raise TradeError("order_volume_above_maximum")
        if step and abs(round(volume / step) * step - volume) > epsilon:
            raise TradeError("order_volume_step_invalid")

    @staticmethod
    def _plain(value: Any) -> Any:
        if value is None or isinstance(value, (str, int, bool)):
            return value
        if isinstance(value, float):
            if not math.isfinite(value):
                raise TradeError("mt5_result_non_finite")
            return value
        if hasattr(value, "_asdict"):
            return {str(key): Mt5TradeExecutor._plain(item) for key, item in value._asdict().items()}
        if hasattr(value, "__dict__"):
            return {str(key): Mt5TradeExecutor._plain(item) for key, item in vars(value).items()}
        if isinstance(value, dict):
            return {str(key): Mt5TradeExecutor._plain(item) for key, item in value.items()}
        if isinstance(value, (list, tuple)):
            return [Mt5TradeExecutor._plain(item) for item in value]
        return str(value)

    def _result(self, command: dict[str, Any], status: str, error: str | None = None,
                raw: dict[str, Any] | None = None,
                evidence: dict[str, Any] | None = None) -> dict[str, Any]:
        now = self._clock_msc()
        proof = evidence or {"observed_at_utc_msc": now, "order_tickets": [],
                             "position_tickets": [], "deal_tickets": [], "broker_retcode": None}
        return {
            "v": 3,
            "type": "command_result",
            "message_id": f"result_{command.get('command_id')}_{now}",
            "sent_at_utc_msc": now,
            "command_id": command.get("command_id"),
            "terminal_instance_id": self.route.terminal_instance_id,
            "account_ref": {"broker_server": self.route.broker_server, "login": self.route.login},
            "connection_epoch": self.route.connection_epoch,
            "status": status,
            "completed_at_utc_msc": now,
            "error_code": error,
            "raw_result": raw,
            "evidence": proof,
        }

    def _remember(self, command_id: str, result: dict[str, Any]) -> None:
        self._receipts[command_id] = result
        self._receipts.move_to_end(command_id)
        while len(self._receipts) > 2_000:
            self._receipts.popitem(last=False)
