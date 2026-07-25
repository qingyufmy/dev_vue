from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import json
import math
import struct
import sys
import time
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO

PROTOCOL_VERSION = 3
MAX_FRAME_BYTES = 4 * 1024 * 1024
ACCEPTED_RESULT_CACHE = 2_000
RATE_TIMEFRAMES = {"M1", "M5", "M15", "M30", "H1", "H4", "D1"}


class WorkerError(RuntimeError):
    def __init__(self, code: str, message: str | None = None):
        super().__init__(message or code)
        self.code = code


def _read_exact(stream: BinaryIO, size: int) -> bytes:
    chunks: list[bytes] = []
    remaining = size
    while remaining:
        chunk = stream.read(remaining)
        if not chunk:
            raise EOFError("pipe_closed")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def read_frame(stream: BinaryIO) -> dict[str, Any]:
    length = struct.unpack("<I", _read_exact(stream, 4))[0]
    if length <= 0 or length > MAX_FRAME_BYTES:
        raise WorkerError("worker_frame_size_invalid")
    payload = json.loads(_read_exact(stream, length).decode("utf-8"))
    if not isinstance(payload, dict):
        raise WorkerError("worker_frame_object_required")
    return payload


def write_frame(stream: BinaryIO, message: dict[str, Any]) -> None:
    payload = json.dumps(message, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(payload) > MAX_FRAME_BYTES:
        raise WorkerError("worker_frame_too_large")
    stream.write(struct.pack("<I", len(payload)))
    stream.write(payload)
    stream.flush()


def _plain(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if hasattr(value, "_asdict"):
        return {key: _plain(item) for key, item in value._asdict().items()}
    if isinstance(value, dict):
        return {str(key): _plain(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(item) for item in value]
    return str(value)


@dataclass(frozen=True)
class WorkerIdentity:
    terminal_instance_id: str
    broker_server: str
    login: str
    connection_epoch: int


class Mt5Adapter:
    def __init__(self, mt5: Any, terminal_path: str, identity: WorkerIdentity):
        self.mt5 = mt5
        self.terminal_path = str(Path(terminal_path).resolve())
        self.identity = identity
        self._receipts: OrderedDict[str, dict[str, Any]] = OrderedDict()

    def connect(self) -> dict[str, Any]:
        if not Path(self.terminal_path).is_file():
            raise WorkerError("mt5_terminal_not_found")
        if not self.mt5.initialize(path=self.terminal_path, timeout=10_000, portable=False):
            raise WorkerError("mt5_initialize_failed", str(self.mt5.last_error()))
        return self._ensure_identity()

    def shutdown(self) -> None:
        self.mt5.shutdown()

    def _ensure_identity(self) -> dict[str, Any]:
        account = self.mt5.account_info()
        terminal = self.mt5.terminal_info()
        if account is None or terminal is None:
            raise WorkerError("mt5_account_unavailable")
        if str(account.login) != self.identity.login:
            raise WorkerError("mt5_login_mismatch")
        if str(account.server).strip().lower() != self.identity.broker_server.strip().lower():
            raise WorkerError("mt5_broker_server_mismatch")
        if getattr(terminal, "connected", True) is False:
            raise WorkerError("mt5_terminal_disconnected")
        return {"account": _plain(account), "terminal": _plain(terminal)}

    def collect(self, streams: list[str]) -> dict[str, Any]:
        identity = self._ensure_identity()
        result: dict[str, Any] = {}
        if "account" in streams:
            result["account"] = identity["account"]
        if "positions" in streams:
            positions = self.mt5.positions_get()
            if positions is None:
                raise WorkerError("mt5_positions_unavailable", str(self.mt5.last_error()))
            result["positions"] = _plain(positions)
        if "orders" in streams:
            orders = self.mt5.orders_get()
            if orders is None:
                raise WorkerError("mt5_orders_unavailable", str(self.mt5.last_error()))
            result["orders"] = _plain(orders)
        return result

    def execute(self, command: dict[str, Any]) -> dict[str, Any]:
        command_id = str(command.get("command_id") or "")
        if command_id in self._receipts:
            return self._receipts[command_id]
        try:
            self._validate_route(command)
            deadline = int(command.get("deadline_utc_msc") or 0)
            if deadline <= int(time.time() * 1000):
                result = self._result(command, "rejected", "command_expired")
                return self._remember(command_id, result)
            self._ensure_identity()
            action = command.get("action")
            params = command.get("params")
            if not isinstance(params, dict):
                result = self._result(command, "rejected", "command_params_invalid")
                return self._remember(command_id, result)
            if action == "place_order":
                result = self._place_order(command, params)
            elif action == "cancel_order":
                result = self._cancel_order(command, params)
            elif action == "modify_order":
                result = self._modify_order(command, params)
            elif action == "modify_position":
                result = self._modify_position(command, params)
            elif action == "close_position":
                result = self._close_position(command, params)
            elif action == "query_execution":
                result = self._query_execution(command, params)
            else:
                result = self._result(command, "rejected", "command_action_unsupported")
        except WorkerError as error:
            result = self._result(command, "rejected", error.code, str(error))
        except Exception as error:
            result = self._result(command, "uncertain", "mt5_execution_exception", str(error))
        return self._remember(command_id, result)

    def quote(self, request: dict[str, Any]) -> dict[str, Any]:
        try:
            self._validate_route(request)
            self._ensure_identity()
            symbol = str(request.get("symbol") or "")
            if not symbol or symbol != symbol.strip() or len(symbol) > 64:
                raise WorkerError("symbol_invalid")
            tick = self.mt5.symbol_info_tick(symbol)
            if tick is None:
                raise WorkerError("symbol_tick_unavailable")
            info = self.mt5.symbol_info(symbol)
            terminal = self.mt5.terminal_info()
            bid = float(tick.bid)
            ask = float(tick.ask)
            last = float(getattr(tick, "last", 0.0) or 0.0)
            if not math.isfinite(bid) or not math.isfinite(ask) or bid <= 0 or ask <= 0 or ask < bid:
                raise WorkerError("symbol_tick_invalid")
            if not math.isfinite(last) or last < 0:
                last = 0.0
            observed_at = int(getattr(tick, "time_msc", 0) or 0)
            if observed_at <= 0:
                observed_at = int(time.time() * 1000)
            return self._quote_result(
                request, "succeeded", observed_at, bid=bid, ask=ask, last=last,
                symbol_trade_mode=(int(getattr(info, "trade_mode", -1)) if info is not None else None),
                terminal_connected=(bool(getattr(terminal, "connected", True)) if terminal is not None else None),
            )
        except WorkerError as error:
            return self._quote_result(request, "rejected", int(time.time() * 1000), error_code=error.code)
        except Exception:
            return self._quote_result(
                request, "rejected", int(time.time() * 1000), error_code="mt5_quote_exception")

    def data(self, request: dict[str, Any]) -> dict[str, Any]:
        try:
            self._validate_route(request)
            self._ensure_identity()
            action = request.get("action")
            if action not in {"rates", "symbol_snapshot", "risk_snapshot", "performance_daily"}:
                raise WorkerError("terminal_data_action_unsupported")
            params = request.get("params")
            if not isinstance(params, dict):
                raise WorkerError("rates_params_invalid")
            if action == "rates":
                payload = self._rates(params)
            elif action == "symbol_snapshot":
                payload = self._symbol_snapshot(params)
            elif action == "risk_snapshot":
                payload = self._risk_snapshot(params)
            else:
                payload = self._performance_daily(params)
            return self._data_result(request, "succeeded", payload=payload)
        except WorkerError as error:
            return self._data_result(request, "rejected", error_code=error.code)
        except Exception:
            return self._data_result(request, "rejected", error_code="mt5_data_request_exception")

    def _rates(self, params: dict[str, Any]) -> dict[str, Any]:
        symbol = str(params.get("symbol") or "").strip()
        timeframe = str(params.get("timeframe") or "M30").strip().upper()
        if not symbol or len(symbol) > 64:
            raise WorkerError("symbol_invalid")
        if timeframe not in RATE_TIMEFRAMES:
            raise WorkerError("rates_timeframe_invalid")
        try:
            count = int(params.get("count", 100))
            start_utc_msc = int(params.get("start_utc_msc") or 0)
            end_utc_msc = int(params.get("end_utc_msc") or 0)
        except (TypeError, ValueError) as error:
            raise WorkerError("rates_params_invalid") from error
        if count < 2 or count > 5_000:
            raise WorkerError("rates_count_invalid")
        if ((start_utc_msc or end_utc_msc)
                and not (start_utc_msc > 0 and end_utc_msc > start_utc_msc)):
            raise WorkerError("rates_range_invalid")
        timeframe_value = getattr(self.mt5, f"TIMEFRAME_{timeframe}", None)
        if timeframe_value is None:
            raise WorkerError("rates_timeframe_unavailable")
        select = getattr(self.mt5, "symbol_select", None)
        if callable(select) and not select(symbol, True):
            raise WorkerError("symbol_select_failed")
        range_complete = bool(start_utc_msc and end_utc_msc)
        if range_complete:
            rates = self.mt5.copy_rates_range(
                symbol, timeframe_value,
                datetime.fromtimestamp(start_utc_msc / 1000.0, timezone.utc),
                datetime.fromtimestamp(end_utc_msc / 1000.0, timezone.utc))
            if rates is not None and len(rates) > count:
                rates = rates[-count:]
        else:
            rates = self.mt5.copy_rates_from_pos(symbol, timeframe_value, 0, count)
        if rates is None:
            raise WorkerError("rates_unavailable", str(self.mt5.last_error()))
        captured_at = int(time.time() * 1000)
        output: list[dict[str, Any]] = []
        for rate in rates:
            epoch_msc = int(rate[0]) * 1000
            output.append({
                "time": datetime.fromtimestamp(epoch_msc / 1000.0, timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
                "time_msc": epoch_msc,
                "time_utc_msc": epoch_msc,
                "open": float(rate[1]), "high": float(rate[2]),
                "low": float(rate[3]), "close": float(rate[4]),
                "tick_volume": int(rate[5]), "spread": int(rate[6]) if len(rate) > 6 else 0,
                "captured_at_utc_msc": captured_at,
            })
        return {
            "symbol": symbol, "timeframe": timeframe, "count": len(output),
            "rates": output, "source": "mt5", "range_complete": range_complete,
            "range_start_utc_msc": start_utc_msc or None,
            "range_end_utc_msc": end_utc_msc or None,
        }

    def _symbol_snapshot(self, params: dict[str, Any]) -> dict[str, Any]:
        symbol = str(params.get("symbol") or "").strip()
        if not symbol or len(symbol) > 64:
            raise WorkerError("symbol_invalid")
        select = getattr(self.mt5, "symbol_select", None)
        if callable(select) and not select(symbol, True):
            raise WorkerError("symbol_select_failed")
        info = self.mt5.symbol_info(symbol)
        account = self.mt5.account_info()
        if info is None:
            raise WorkerError("symbol_info_unavailable")
        if account is None:
            raise WorkerError("mt5_account_unavailable")
        tick = self.mt5.symbol_info_tick(symbol)
        reference_buy = float(getattr(tick, "ask", 0.0) or 0.0) if tick else 0.0
        reference_sell = float(getattr(tick, "bid", 0.0) or 0.0) if tick else 0.0
        volume_min = float(getattr(info, "volume_min", 0.0) or 0.0)
        volume_max = float(getattr(info, "volume_max", 0.0) or 0.0)
        volume_step = float(getattr(info, "volume_step", 0.0) or 0.0)
        margin_probe_volume = max(volume_min, min(1.0, volume_max)) if volume_max > 0 else 1.0
        if volume_step > 0:
            margin_probe_volume = round(margin_probe_volume / volume_step) * volume_step
            margin_probe_volume = max(volume_min, min(margin_probe_volume, volume_max))

        def margin_per_lot(order_type: int, price: float) -> float | None:
            calculator = getattr(self.mt5, "order_calc_margin", None)
            if not callable(calculator) or price <= 0 or margin_probe_volume <= 0:
                return None
            try:
                value = calculator(order_type, symbol, margin_probe_volume, price)
                return float(value) / margin_probe_volume if value is not None and float(value) >= 0 else None
            except (TypeError, ValueError, RuntimeError):
                return None

        instrument = {
            "name": str(getattr(info, "name", symbol) or symbol),
            "digits": int(getattr(info, "digits", 0) or 0),
            "trade_mode": int(getattr(info, "trade_mode", 0) or 0),
            "trade_calc_mode": int(getattr(info, "trade_calc_mode", 0) or 0),
            "trade_exemode": int(getattr(info, "trade_exemode", 0) or 0),
            "trade_stops_level": int(getattr(info, "trade_stops_level", 0) or 0),
            "trade_freeze_level": int(getattr(info, "trade_freeze_level", 0) or 0),
            "filling_mode": int(getattr(info, "filling_mode", 0) or 0),
            "order_mode": int(getattr(info, "order_mode", 0) or 0),
            "point": float(getattr(info, "point", 0.0) or 0.0),
            "spread": int(getattr(info, "spread", 0) or 0),
            "spread_float": bool(getattr(info, "spread_float", False)),
            "tick_size": float(getattr(info, "trade_tick_size", 0.0) or 0.0),
            "tick_value": float(getattr(info, "trade_tick_value", 0.0) or 0.0),
            "contract_size": float(getattr(info, "trade_contract_size", 0.0) or 0.0),
            "margin_initial": float(getattr(info, "margin_initial", 0.0) or 0.0),
            "margin_maintenance": float(getattr(info, "margin_maintenance", 0.0) or 0.0),
            "margin_hedged": float(getattr(info, "margin_hedged", 0.0) or 0.0),
            "margin_per_lot_buy": margin_per_lot(self.mt5.ORDER_TYPE_BUY, reference_buy),
            "margin_per_lot_sell": margin_per_lot(self.mt5.ORDER_TYPE_SELL, reference_sell),
            "margin_reference_price_buy": reference_buy if reference_buy > 0 else None,
            "margin_reference_price_sell": reference_sell if reference_sell > 0 else None,
            "margin_profile_currency": str(getattr(account, "currency", "") or ""),
            "margin_profile_volume": margin_probe_volume,
            "volume_min": volume_min, "volume_max": volume_max, "volume_step": volume_step,
            "volume_limit": float(getattr(info, "volume_limit", 0.0) or 0.0),
            "swap_mode": int(getattr(info, "swap_mode", 0) or 0),
            "swap_rollover3days": int(getattr(info, "swap_rollover3days", 0) or 0),
            "swap_long": float(getattr(info, "swap_long", 0.0) or 0.0),
            "swap_short": float(getattr(info, "swap_short", 0.0) or 0.0),
            **{f"swap_{day}": (float(getattr(info, f"swap_{day}"))
                if getattr(info, f"swap_{day}", None) is not None else None)
               for day in ("sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday")},
            "currency_base": str(getattr(info, "currency_base", "") or ""),
            "currency_profit": str(getattr(info, "currency_profit", "") or ""),
            "currency_margin": str(getattr(info, "currency_margin", "") or ""),
        }
        return {
            "symbol": symbol, "source": "mt5",
            "account": {
                "currency": str(getattr(account, "currency", "") or ""),
                "balance": float(getattr(account, "balance", 0.0) or 0.0),
                "equity": float(getattr(account, "equity", 0.0) or 0.0),
                "leverage": int(getattr(account, "leverage", 0) or 0),
                "margin_mode": int(getattr(account, "margin_mode", 0) or 0),
                "margin_so_mode": int(getattr(account, "margin_so_mode", 0) or 0),
                "margin_so_call": float(getattr(account, "margin_so_call", 0.0) or 0.0),
                "margin_so_so": float(getattr(account, "margin_so_so", 0.0) or 0.0),
            },
            "instrument": instrument,
        }

    def _performance_daily(self, params: dict[str, Any]) -> dict[str, Any]:
        try:
            start_date = datetime.strptime(str(params.get("date_from") or "")[:10], "%Y-%m-%d")
            end_date = datetime.strptime(str(params.get("date_to") or "")[:10], "%Y-%m-%d")
        except (TypeError, ValueError) as error:
            raise WorkerError("performance_date_range_required") from error
        if end_date < start_date:
            raise WorkerError("performance_date_range_invalid")
        if (end_date - start_date).days > 30:
            raise WorkerError("performance_date_range_too_large")

        account = self.mt5.account_info()
        if account is None:
            raise WorkerError("performance_account_unavailable")
        date_from = (start_date - timedelta(days=1)).replace(tzinfo=timezone.utc)
        date_to = (end_date + timedelta(days=2)).replace(tzinfo=timezone.utc)
        deals = self.mt5.history_deals_get(date_from, date_to)
        if deals is None:
            raise WorkerError("performance_history_unavailable", str(self.mt5.last_error()))

        trade_types = {int(getattr(self.mt5, "DEAL_TYPE_BUY", 0)),
                       int(getattr(self.mt5, "DEAL_TYPE_SELL", 1))}
        balance_type = int(getattr(self.mt5, "DEAL_TYPE_BALANCE", 2))
        credit_type = int(getattr(self.mt5, "DEAL_TYPE_CREDIT", 3))
        other_capital_types = {int(getattr(self.mt5, name, value)) for name, value in (
            ("DEAL_TYPE_CORRECTION", 5), ("DEAL_TYPE_BONUS", 6))}
        adjustment_types = {int(getattr(self.mt5, name, value)) for name, value in (
            ("DEAL_TYPE_CHARGE", 4), ("DEAL_TYPE_COMMISSION", 7),
            ("DEAL_TYPE_COMMISSION_DAILY", 8), ("DEAL_TYPE_COMMISSION_MONTHLY", 9),
            ("DEAL_TYPE_COMMISSION_AGENT_DAILY", 10),
            ("DEAL_TYPE_COMMISSION_AGENT_MONTHLY", 11), ("DEAL_TYPE_INTEREST", 12),
            ("DEAL_TYPE_DIVIDEND", 15), ("DEAL_TYPE_DIVIDEND_FRANKED", 16),
            ("DEAL_TYPE_TAX", 17))}
        exit_entries = {int(getattr(self.mt5, name, value)) for name, value in (
            ("DEAL_ENTRY_OUT", 1), ("DEAL_ENTRY_INOUT", 2), ("DEAL_ENTRY_OUT_BY", 3))}

        def empty_day(day: str) -> dict[str, Any]:
            return {
                "business_date": day, "trade_profit": 0.0, "commission": 0.0,
                "swap": 0.0, "fee": 0.0, "pnl_adjustment": 0.0,
                "realized_net": 0.0, "deposit": 0.0, "withdrawal": 0.0,
                "credit_change": 0.0, "other_capital_change": 0.0,
                "exit_deal_count": 0, "closed_position_count": 0,
                "winning_exit_count": 0, "losing_exit_count": 0,
                "closed_volume": 0.0, "first_deal_time_msc": 0,
                "last_deal_time_msc": 0, "last_deal_ticket": 0,
                "data_complete": True, "data_issues": [], "_positions": set(),
            }

        daily: dict[str, dict[str, Any]] = {}
        start_text = start_date.strftime("%Y-%m-%d")
        end_text = end_date.strftime("%Y-%m-%d")
        for item in deals:
            raw = _plain(item)
            if not isinstance(raw, dict):
                raise WorkerError("performance_history_invalid")
            event_ms = int(raw.get("time_msc") or int(raw.get("time") or 0) * 1000)
            day = datetime.fromtimestamp(event_ms / 1000.0, timezone.utc).strftime("%Y-%m-%d")
            if day < start_text or day > end_text:
                continue
            row = daily.setdefault(day, empty_day(day))
            ticket = int(raw.get("ticket") or 0)
            if not row["first_deal_time_msc"] or event_ms < row["first_deal_time_msc"]:
                row["first_deal_time_msc"] = event_ms
            if (event_ms, ticket) > (row["last_deal_time_msc"], row["last_deal_ticket"]):
                row["last_deal_time_msc"], row["last_deal_ticket"] = event_ms, ticket
            deal_type = int(raw.get("type") if raw.get("type") is not None else -1)
            profit = float(raw.get("profit") or 0.0)
            commission = float(raw.get("commission") or 0.0)
            swap = float(raw.get("swap") or 0.0)
            fee = float(raw.get("fee") or 0.0)
            net = profit + commission + swap + fee
            if deal_type in trade_types:
                row["trade_profit"] += profit
                row["commission"] += commission
                row["swap"] += swap
                row["fee"] += fee
                row["realized_net"] += net
                if int(raw.get("entry") if raw.get("entry") is not None else -1) in exit_entries:
                    row["exit_deal_count"] += 1
                    row["closed_volume"] += float(raw.get("volume") or 0.0)
                    position_id = int(raw.get("position_id") or 0)
                    if position_id:
                        row["_positions"].add(position_id)
                    if net > 0:
                        row["winning_exit_count"] += 1
                    elif net < 0:
                        row["losing_exit_count"] += 1
            elif deal_type == balance_type:
                if net >= 0:
                    row["deposit"] += net
                else:
                    row["withdrawal"] += abs(net)
            elif deal_type == credit_type:
                row["credit_change"] += net
            elif deal_type in other_capital_types:
                row["other_capital_change"] += net
            elif deal_type in adjustment_types:
                row["pnl_adjustment"] += net
                row["realized_net"] += net
            else:
                row["data_complete"] = False
                row["data_issues"].append(f"unknown_deal_type:{deal_type}")

        numeric_fields = ("trade_profit", "commission", "swap", "fee", "pnl_adjustment",
                          "realized_net", "deposit", "withdrawal", "credit_change",
                          "other_capital_change", "closed_volume")
        rows: list[dict[str, Any]] = []
        for day in sorted(daily):
            row = daily[day]
            row["closed_position_count"] = len(row.pop("_positions"))
            row["data_issues"] = sorted(set(row["data_issues"]))
            for field in numeric_fields:
                row[field] = round(float(row[field]), 8)
            digest = json.dumps(row, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
            row["source_hash"] = hashlib.sha256(digest.encode("utf-8")).hexdigest()
            rows.append(row)
        return {
            "performance_version": 1, "date_from": start_text, "date_to": end_text,
            "timezone_offset_minutes": 0, "clock_status": "utc_direct",
            "account": {"login": int(account.login), "server": str(account.server),
                        "currency": str(getattr(account, "currency", "") or "")},
            "daily": rows, "scanned_deal_count": len(deals), "source": "mt5",
        }

    def _risk_snapshot(self, params: dict[str, Any]) -> dict[str, Any]:
        symbol = str(params.get("symbol") or "").strip()
        if not symbol or len(symbol) > 64:
            raise WorkerError("symbol_invalid")
        try:
            requested_cursor_ms = int(params.get("last_deal_time_msc") or 0)
            requested_cursor_ticket = int(params.get("last_deal_ticket") or 0)
            baseline_utc_ms = int(params.get("baseline_from_utc_msc") or 0)
        except (TypeError, ValueError) as error:
            raise WorkerError("risk_snapshot_cursor_invalid") from error
        if min(requested_cursor_ms, requested_cursor_ticket, baseline_utc_ms) < 0:
            raise WorkerError("risk_snapshot_cursor_invalid")
        account = self.mt5.account_info()
        if account is None:
            raise WorkerError("risk_snapshot_account_unavailable")
        positions = self.mt5.positions_get()
        pending = self.mt5.orders_get()
        if positions is None:
            raise WorkerError("risk_snapshot_positions_unavailable")
        if pending is None:
            raise WorkerError("risk_snapshot_orders_unavailable")

        position_rows = [{
            "ticket": int(p.ticket),
            "identifier": int(getattr(p, "identifier", p.ticket) or p.ticket),
            "symbol": str(p.symbol),
            "type": "buy" if int(p.type) == int(getattr(self.mt5, "POSITION_TYPE_BUY", 0)) else "sell",
            "volume": float(p.volume), "price_open": float(p.price_open),
            "price_current": float(p.price_current), "profit": float(p.profit),
            "swap": float(getattr(p, "swap", 0.0) or 0.0),
        } for p in positions]
        pending_type_names = {
            int(getattr(self.mt5, "ORDER_TYPE_BUY_LIMIT", 2)): "buy_limit",
            int(getattr(self.mt5, "ORDER_TYPE_SELL_LIMIT", 3)): "sell_limit",
            int(getattr(self.mt5, "ORDER_TYPE_BUY_STOP", 4)): "buy_stop",
            int(getattr(self.mt5, "ORDER_TYPE_SELL_STOP", 5)): "sell_stop",
            int(getattr(self.mt5, "ORDER_TYPE_BUY_STOP_LIMIT", 6)): "buy_stop_limit",
            int(getattr(self.mt5, "ORDER_TYPE_SELL_STOP_LIMIT", 7)): "sell_stop_limit",
        }
        pending_rows = [{
            "ticket": int(order.ticket), "symbol": str(order.symbol),
            "type": pending_type_names.get(int(order.type), str(order.type)),
            "volume": float(getattr(order, "volume_current", 0.0)
                            or getattr(order, "volume_initial", 0.0) or 0.0),
            "volume_current": float(getattr(order, "volume_current", 0.0) or 0.0),
            "volume_initial": float(getattr(order, "volume_initial", 0.0) or 0.0),
            "price": float(getattr(order, "price_open", 0.0) or 0.0),
        } for order in pending]

        raw_start_ms = requested_cursor_ms or baseline_utc_ms or int(time.time() * 1000)
        date_from = datetime.fromtimestamp(max(0, raw_start_ms - 300_000) / 1000.0, timezone.utc)
        date_to = datetime.now(timezone.utc) + timedelta(days=1)
        deals = self.mt5.history_deals_get(date_from, date_to)
        if deals is None:
            raise WorkerError("risk_snapshot_deals_unavailable")
        deal_rows = [_plain(item) for item in deals]
        if not all(isinstance(item, dict) for item in deal_rows):
            raise WorkerError("risk_snapshot_deals_invalid")
        deal_rows.sort(key=lambda item: (
            int(item.get("time_msc") or int(item.get("time") or 0) * 1000),
            int(item.get("ticket") or 0)))
        cursor_pair = (requested_cursor_ms or raw_start_ms, requested_cursor_ticket)
        new_deals = [item for item in deal_rows if (
            int(item.get("time_msc") or int(item.get("time") or 0) * 1000),
            int(item.get("ticket") or 0)) > cursor_pair]

        trade_types = {int(getattr(self.mt5, "DEAL_TYPE_BUY", 0)),
                       int(getattr(self.mt5, "DEAL_TYPE_SELL", 1))}
        capital_types = {int(getattr(self.mt5, name, value)) for name, value in (
            ("DEAL_TYPE_BALANCE", 2), ("DEAL_TYPE_CREDIT", 3),
            ("DEAL_TYPE_CORRECTION", 5), ("DEAL_TYPE_BONUS", 6))}
        adjustment_types = {int(getattr(self.mt5, name, value)) for name, value in (
            ("DEAL_TYPE_CHARGE", 4), ("DEAL_TYPE_COMMISSION", 7),
            ("DEAL_TYPE_COMMISSION_DAILY", 8), ("DEAL_TYPE_COMMISSION_MONTHLY", 9),
            ("DEAL_TYPE_COMMISSION_AGENT_DAILY", 10),
            ("DEAL_TYPE_COMMISSION_AGENT_MONTHLY", 11), ("DEAL_TYPE_INTEREST", 12),
            ("DEAL_TYPE_DIVIDEND", 15), ("DEAL_TYPE_DIVIDEND_FRANKED", 16),
            ("DEAL_TYPE_TAX", 17))}
        exit_entries = {int(getattr(self.mt5, name, value)) for name, value in (
            ("DEAL_ENTRY_OUT", 1), ("DEAL_ENTRY_INOUT", 2), ("DEAL_ENTRY_OUT_BY", 3))}
        active_position_ids = {int(getattr(p, "identifier", p.ticket) or p.ticket) for p in positions}
        closed_positions: list[dict[str, Any]] = []
        seen_positions: set[int] = set()
        incomplete_reasons: list[str] = []
        for deal in new_deals:
            if int(deal.get("type", -1)) not in trade_types or int(deal.get("entry", -1)) not in exit_entries:
                continue
            position_id = int(deal.get("position_id") or 0)
            if not position_id or position_id in active_position_ids or position_id in seen_positions:
                continue
            seen_positions.add(position_id)
            position_deals = self.mt5.history_deals_get(position=position_id)
            if position_deals is None:
                incomplete_reasons.append("position_history_unavailable")
                continue
            net = sum(sum(float(getattr(item, field, 0.0) or 0.0)
                          for field in ("profit", "commission", "swap", "fee"))
                      for item in position_deals)
            close_ms = int(deal.get("time_msc") or int(deal.get("time") or 0) * 1000)
            closed_positions.append({
                "position_id": position_id, "close_time_msc": close_ms,
                "close_time_utc_msc": close_ms,
                "close_deal_ticket": int(deal.get("ticket") or 0),
                "business_date": datetime.fromtimestamp(close_ms / 1000.0, timezone.utc).strftime("%Y-%m-%d"),
                "net": round(net, 8),
            })
        closed_positions.sort(key=lambda item: (item["close_time_msc"], item["close_deal_ticket"]))

        account_events = []
        known_nontrade = capital_types | adjustment_types
        for deal in new_deals:
            deal_type = int(deal.get("type", -1))
            if deal_type in trade_types:
                continue
            amount = sum(float(deal.get(field) or 0.0)
                         for field in ("profit", "commission", "swap", "fee"))
            event_ms = int(deal.get("time_msc") or int(deal.get("time") or 0) * 1000)
            category = "capital" if deal_type in capital_types else (
                "pnl_adjustment" if deal_type in adjustment_types else "unknown")
            if deal_type not in known_nontrade:
                incomplete_reasons.append(f"unknown_deal_type:{deal_type}")
            account_events.append({
                "ticket": int(deal.get("ticket") or 0), "time_msc": event_ms,
                "business_date": datetime.fromtimestamp(event_ms / 1000.0, timezone.utc).strftime("%Y-%m-%d"),
                "deal_type": deal_type, "category": category, "amount": round(amount, 8),
            })

        relevant_symbols = {item["symbol"] for item in position_rows + pending_rows if item.get("symbol")}
        relevant_symbols.add(symbol)
        instruments: dict[str, dict[str, Any]] = {}
        for item_symbol in relevant_symbols:
            info = self.mt5.symbol_info(item_symbol)
            if info is None:
                incomplete_reasons.append(f"symbol_info_unavailable:{item_symbol}")
                continue
            instruments[item_symbol] = {
                "name": str(getattr(info, "name", item_symbol) or item_symbol),
                "digits": int(getattr(info, "digits", 0) or 0),
                "trade_mode": int(getattr(info, "trade_mode", 0) or 0),
                "trade_calc_mode": int(getattr(info, "trade_calc_mode", 0) or 0),
                "point": float(getattr(info, "point", 0.0) or 0.0),
                "tick_size": float(getattr(info, "trade_tick_size", 0.0) or 0.0),
                "tick_value": float(getattr(info, "trade_tick_value", 0.0) or 0.0),
                "contract_size": float(getattr(info, "trade_contract_size", 0.0) or 0.0),
                "margin_initial": float(getattr(info, "margin_initial", 0.0) or 0.0),
                "volume_min": float(getattr(info, "volume_min", 0.0) or 0.0),
                "volume_max": float(getattr(info, "volume_max", 0.0) or 0.0),
                "volume_step": float(getattr(info, "volume_step", 0.0) or 0.0),
                "currency_profit": str(getattr(info, "currency_profit", "") or ""),
                "currency_margin": str(getattr(info, "currency_margin", "") or ""),
            }

        broker_calculation = None
        warnings: list[str] = []
        proposed = params.get("proposed_order")
        if proposed:
            try:
                proposed_symbol = str(proposed.get("symbol") or "").strip()
                side = str(proposed.get("order_type") or "").lower()
                order_type = self.mt5.ORDER_TYPE_BUY if side.startswith("buy") else self.mt5.ORDER_TYPE_SELL
                volume = float(proposed.get("volume") or 0.0)
                entry = float(proposed.get("entry_price") or 0.0)
                stop_loss = float(proposed.get("sl") or 0.0)
                loss = self.mt5.order_calc_profit(order_type, proposed_symbol, volume, entry, stop_loss)
                margin = self.mt5.order_calc_margin(order_type, proposed_symbol, volume, entry)
                if loss is not None and margin is not None:
                    broker_calculation = {
                        "symbol": proposed_symbol, "order_type": side, "volume": volume,
                        "entry_price": entry, "sl": stop_loss,
                        "loss_to_sl": round(abs(float(loss)), 8),
                        "required_margin": round(float(margin), 8),
                    }
            except (AttributeError, TypeError, ValueError, RuntimeError) as error:
                warnings.append(f"broker_calculation_unavailable:{type(error).__name__}")

        through_ms, through_ticket = cursor_pair
        if new_deals:
            last = new_deals[-1]
            through_ms = int(last.get("time_msc") or int(last.get("time") or 0) * 1000)
            through_ticket = int(last.get("ticket") or 0)
        tick = self.mt5.symbol_info_tick(symbol)
        observed_at = int(getattr(tick, "time_msc", 0) or int(time.time() * 1000))
        return {
            "snapshot_version": 1, "source": "mt5",
            "complete": not incomplete_reasons,
            "incomplete_reasons": sorted(set(incomplete_reasons)),
            "warnings": sorted(set(warnings)),
            "business_date": datetime.fromtimestamp(observed_at / 1000.0, timezone.utc).strftime("%Y-%m-%d"),
            "mt5_time_msc": observed_at, "time_msc": observed_at,
            "time_utc_msc": observed_at, "timezone_offset_minutes": 0,
            "clock_status": "utc_direct", "clock_residual_ms": 0,
            "captured_at_utc_msc": int(time.time() * 1000),
            "account": {
                "login": int(account.login), "server": str(account.server),
                "currency": str(getattr(account, "currency", "") or ""),
                **{field: float(getattr(account, field, 0.0) or 0.0)
                   for field in ("balance", "equity", "credit", "profit", "margin", "margin_free", "margin_level")},
                "leverage": int(getattr(account, "leverage", 0) or 0),
                "margin_mode": int(getattr(account, "margin_mode", 0) or 0),
                "margin_so_mode": int(getattr(account, "margin_so_mode", 0) or 0),
                "margin_so_call": float(getattr(account, "margin_so_call", 0.0) or 0.0),
                "margin_so_so": float(getattr(account, "margin_so_so", 0.0) or 0.0),
            },
            "positions": position_rows, "pending": pending_rows, "instruments": instruments,
            "increment": {
                "requested_cursor": {"time_msc": requested_cursor_ms, "ticket": requested_cursor_ticket},
                "through_cursor": {"time_msc": through_ms, "ticket": through_ticket},
                "closed_positions": closed_positions, "account_events": account_events,
                "scanned_deal_count": len(deal_rows), "new_deal_count": len(new_deals),
            },
            "broker_calculation": broker_calculation,
        }

    def _validate_route(self, command: dict[str, Any]) -> None:
        account_ref = command.get("account_ref") or {}
        if (
            command.get("terminal_instance_id") != self.identity.terminal_instance_id
            or int(command.get("connection_epoch") or 0) != self.identity.connection_epoch
            or str(account_ref.get("login") or "") != self.identity.login
            or str(account_ref.get("broker_server") or "").strip().lower()
            != self.identity.broker_server.strip().lower()
        ):
            raise WorkerError("command_route_mismatch")

    def _place_order(self, command: dict[str, Any], params: dict[str, Any]) -> dict[str, Any]:
        symbol = self._required_text(params, "symbol")
        side = self._required_text(params, "side").lower()
        if side not in {"buy", "sell"}:
            raise WorkerError("order_side_invalid")
        volume = self._positive_float(params, "volume")
        kind = str(params.get("order_kind") or "market").lower()
        tick = self.mt5.symbol_info_tick(symbol)
        if tick is None:
            raise WorkerError("symbol_tick_unavailable")
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
            raise WorkerError("order_kind_invalid")
        is_market = kind == "market"
        price = float(params.get("price") or (tick.ask if side == "buy" else tick.bid))
        request = {
            "action": self.mt5.TRADE_ACTION_DEAL if is_market else self.mt5.TRADE_ACTION_PENDING,
            "symbol": symbol,
            "volume": volume,
            "type": order_type,
            "price": price,
            "deviation": int(params.get("deviation") or 20),
            "magic": int(params.get("magic") or 234000),
            "comment": f"AURUM:{str(command['command_id'])[-20:]}",
            "type_time": int(params.get("type_time") or self.mt5.ORDER_TIME_GTC),
            "type_filling": int(params.get("type_filling") or self.mt5.ORDER_FILLING_RETURN),
        }
        for source, target in (("stop_loss", "sl"), ("take_profit", "tp"), ("stop_limit_price", "stoplimit")):
            if params.get(source) is not None:
                request[target] = float(params[source])
        if params.get("expiration") is not None:
            request["expiration"] = int(params["expiration"])
        return self._send_order(command, request)

    def _cancel_order(self, command: dict[str, Any], params: dict[str, Any]) -> dict[str, Any]:
        ticket = int(self._required_text(params, "ticket"))
        if isinstance(params.get("expected_state"), dict):
            orders = self.mt5.orders_get(ticket=ticket)
            if orders is None:
                raise WorkerError("orders_query_failed")
            if len(orders) == 0:
                return self._result(command, "succeeded", raw_result={"already_absent": True, "order": ticket})
            if len(orders) != 1:
                raise WorkerError("management_target_ambiguous")
            self._validate_management_target(params["expected_state"], orders[0], "pending")
        return self._send_order(command, {"action": self.mt5.TRADE_ACTION_REMOVE, "order": ticket})

    def _modify_order(self, command: dict[str, Any], params: dict[str, Any]) -> dict[str, Any]:
        request: dict[str, Any] = {
            "action": self.mt5.TRADE_ACTION_MODIFY,
            "order": int(self._required_text(params, "ticket")),
        }
        for source, target in (("price", "price"), ("stop_loss", "sl"), ("take_profit", "tp"),
                               ("stop_limit_price", "stoplimit")):
            if params.get(source) is not None:
                request[target] = float(params[source])
        if params.get("expiration") is not None:
            request["expiration"] = int(params["expiration"])
        return self._send_order(command, request)

    def _modify_position(self, command: dict[str, Any], params: dict[str, Any]) -> dict[str, Any]:
        ticket = int(self._required_text(params, "ticket"))
        positions = self.mt5.positions_get(ticket=ticket)
        if positions is None:
            raise WorkerError("positions_query_failed")
        if len(positions) != 1:
            raise WorkerError("system_position_not_found")
        position = positions[0]
        expected = params.get("expected_state")
        if not isinstance(expected, dict):
            raise WorkerError("management_expected_state_required")
        self._validate_management_target(expected, position, "position")

        info = self.mt5.symbol_info(position.symbol)
        tick = self.mt5.symbol_info_tick(position.symbol)
        if info is None or tick is None:
            raise WorkerError("position_symbol_quote_unavailable")
        point = float(getattr(info, "point", 0) or 0)
        tick_size = float(getattr(info, "trade_tick_size", 0) or point or 0.00000001)
        digits = max(0, int(getattr(info, "digits", 0) or 0))
        tolerance = max(point / 2.0, tick_size / 2.0, 0.00000001)
        for field, actual, code in (
            ("stop_loss", float(position.sl or 0), "position_stop_loss_changed"),
            ("take_profit", float(position.tp or 0), "position_take_profit_changed"),
        ):
            if expected.get(field) is None:
                continue
            try:
                expected_value = float(expected[field])
            except (TypeError, ValueError) as error:
                raise WorkerError(f"position_expected_{field}_invalid") from error
            if not math.isfinite(expected_value) or expected_value < 0:
                raise WorkerError(f"position_expected_{field}_invalid")
            if abs(actual - expected_value) > tolerance:
                raise WorkerError(code)

        requested_sl = params.get("stop_loss")
        requested_tp = params.get("take_profit")
        if requested_sl is None and requested_tp is None:
            raise WorkerError("protection_price_required")

        def normalize(value: Any, current: Any) -> float:
            if value is None:
                return float(current or 0)
            try:
                number = float(value)
            except (TypeError, ValueError) as error:
                raise WorkerError("protection_price_invalid") from error
            if not math.isfinite(number) or number <= 0:
                raise WorkerError("protection_price_invalid")
            normalized = round(round(number / tick_size) * tick_size, digits)
            if normalized <= 0:
                raise WorkerError("protection_price_invalid")
            return normalized

        next_sl = normalize(requested_sl, position.sl)
        next_tp = normalize(requested_tp, position.tp)
        min_points = max(int(getattr(info, "trade_stops_level", 0) or 0),
                         int(getattr(info, "trade_freeze_level", 0) or 0))
        min_distance = min_points * point
        is_buy = int(position.type) == int(self.mt5.POSITION_TYPE_BUY)
        if requested_sl is not None:
            valid = next_sl < float(tick.bid) - min_distance if is_buy else next_sl > float(tick.ask) + min_distance
            if not valid:
                raise WorkerError("stop_loss_direction_or_distance_invalid")
        if requested_tp is not None:
            valid = next_tp > float(tick.ask) + min_distance if is_buy else next_tp < float(tick.bid) - min_distance
            if not valid:
                raise WorkerError("take_profit_direction_or_distance_invalid")

        if abs(float(position.sl or 0) - next_sl) <= tolerance \
                and abs(float(position.tp or 0) - next_tp) <= tolerance:
            return self._result(command, "succeeded", raw_result={
                "position": ticket, "stop_loss": next_sl, "take_profit": next_tp,
                "already_applied": True,
            }, evidence={"position_tickets": [str(ticket)]})

        result = self.mt5.order_send({
            "action": self.mt5.TRADE_ACTION_SLTP,
            "position": ticket,
            "symbol": position.symbol,
            "sl": next_sl,
            "tp": next_tp,
            "magic": int(params.get("magic") or 234000),
        })
        verified = self.mt5.positions_get(ticket=ticket)
        if verified is None:
            return self._result(command, "uncertain", "position_protection_verify_failed",
                                raw_result={"stop_loss": next_sl, "take_profit": next_tp})
        if len(verified) != 1:
            return self._result(command, "rejected", "position_closed_during_protection_update")
        current = verified[0]
        applied = abs(float(current.sl or 0) - next_sl) <= tolerance \
            and abs(float(current.tp or 0) - next_tp) <= tolerance
        retcode = int(getattr(result, "retcode", -1)) if result is not None else -1
        if applied:
            return self._result(command, "succeeded", raw_result={
                "position": ticket,
                "stop_loss": float(current.sl or 0),
                "take_profit": float(current.tp or 0),
                "retcode": retcode,
            }, evidence={"position_tickets": [str(ticket)], "broker_retcode": retcode})
        return self._result(command, "rejected", "position_protection_not_applied",
                            getattr(result, "comment", None) if result is not None else None,
                            raw_result={"stop_loss": float(current.sl or 0),
                                        "take_profit": float(current.tp or 0), "retcode": retcode},
                            evidence={"position_tickets": [str(ticket)], "broker_retcode": retcode})

    def _close_position(self, command: dict[str, Any], params: dict[str, Any]) -> dict[str, Any]:
        ticket = int(self._required_text(params, "ticket"))
        positions = self.mt5.positions_get(ticket=ticket)
        if positions is None:
            raise WorkerError("positions_query_failed")
        if len(positions) == 0 and isinstance(params.get("expected_state"), dict):
            return self._result(command, "succeeded", raw_result={"already_absent": True, "position": ticket})
        if len(positions) != 1:
            raise WorkerError("position_not_found")
        position = positions[0]
        if isinstance(params.get("expected_state"), dict):
            self._validate_management_target(params["expected_state"], position, "position")
        volume = float(params.get("volume") or position.volume)
        if volume <= 0 or volume > float(position.volume):
            raise WorkerError("close_volume_invalid")
        tick = self.mt5.symbol_info_tick(position.symbol)
        if tick is None:
            raise WorkerError("symbol_tick_unavailable")
        is_buy = int(position.type) == int(self.mt5.POSITION_TYPE_BUY)
        request = {
            "action": self.mt5.TRADE_ACTION_DEAL,
            "position": ticket,
            "symbol": position.symbol,
            "volume": volume,
            "type": self.mt5.ORDER_TYPE_SELL if is_buy else self.mt5.ORDER_TYPE_BUY,
            "price": tick.bid if is_buy else tick.ask,
            "deviation": int(params.get("deviation") or 20),
            "magic": int(params.get("magic") or 234000),
            "comment": f"AURUM:{str(command['command_id'])[-20:]}",
        }
        return self._send_order(command, request)

    def _validate_management_target(self, expected: dict[str, Any], target: Any, kind: str) -> None:
        expected_server = str(expected.get("broker_server_key") or "").strip().upper()
        expected_login = str(expected.get("login_account") or "").strip()
        if expected_server and expected_server != self.identity.broker_server.strip().upper():
            raise WorkerError("management_account_server_mismatch")
        if expected_login and expected_login != self.identity.login:
            raise WorkerError("management_account_login_mismatch")
        if str(expected.get("ticket") or "").strip() != str(getattr(target, "ticket", "")):
            raise WorkerError("management_ticket_mismatch")
        if str(expected.get("symbol") or "").strip() != str(getattr(target, "symbol", "")):
            raise WorkerError("management_symbol_mismatch")
        if int(expected.get("magic") or 0) != int(getattr(target, "magic", 0) or 0):
            raise WorkerError("management_magic_mismatch")
        actual_volume = getattr(target, "volume", None)
        if actual_volume is None:
            actual_volume = getattr(target, "volume_current", None)
        if kind == "pending" and float(actual_volume or 0) <= 0:
            actual_volume = getattr(target, "volume_initial", actual_volume)
        if abs(float(expected.get("volume") or 0) - float(actual_volume or 0)) > 1e-8:
            raise WorkerError("management_volume_mismatch")
        if kind == "position":
            direction = "buy" if int(target.type) == int(self.mt5.POSITION_TYPE_BUY) else "sell"
        else:
            buy_types = {
                int(self.mt5.ORDER_TYPE_BUY_LIMIT), int(self.mt5.ORDER_TYPE_BUY_STOP),
                int(self.mt5.ORDER_TYPE_BUY_STOP_LIMIT),
            }
            direction = "buy" if int(target.type) in buy_types else "sell"
        if str(expected.get("direction") or "").strip().lower() != direction:
            raise WorkerError("management_direction_mismatch")

    def _query_execution(self, command: dict[str, Any], params: dict[str, Any]) -> dict[str, Any]:
        expected_kind = str(params.get("expected_kind") or "").strip().lower()
        symbol = str(params.get("symbol") or "").strip()
        command_ref = str(params.get("bridge_command_ref") or params.get("comment") or "").strip()
        if expected_kind not in {"trade", "pending"}:
            raise WorkerError("expected_kind_required")
        if len(symbol) > 64:
            raise WorkerError("symbol_invalid")
        expected_tickets = {str(params.get(key) or "").strip()
                            for key in ("trade_ticket", "pending_ticket", "ticket")}
        expected_tickets.discard("")
        if not command_ref and not expected_tickets:
            raise WorkerError("bridge_reference_required")
        if any(not ticket.isdigit() or len(ticket) > 32 for ticket in expected_tickets):
            raise WorkerError("order_lookup_ticket_invalid")
        try:
            lookback_seconds = int(params.get("lookback_seconds") or 172_800)
        except (TypeError, ValueError) as error:
            raise WorkerError("order_lookup_params_invalid") from error
        if lookback_seconds < 3_600 or lookback_seconds > 315_360_000:
            raise WorkerError("order_lookup_params_invalid")
        direct_ticket = int(next(iter(expected_tickets))) if not command_ref and len(expected_tickets) == 1 else None

        def matches(row: Any) -> bool:
            if symbol and str(getattr(row, "symbol", "") or "").strip() != symbol:
                return False
            if int(getattr(row, "magic", 0) or 0) != 234000:
                return False
            if command_ref:
                return str(getattr(row, "comment", "") or "").strip() == command_ref
            row_tickets = {str(getattr(row, field, "") or "").strip()
                           for field in ("ticket", "order", "position_id")}
            row_tickets.discard("")
            return bool(row_tickets & expected_tickets)

        def active_pending(row: Any) -> dict[str, Any]:
            ticket = getattr(row, "ticket", None) or getattr(row, "order", None)
            return {"found": True, "kind": "pending", "ticket": ticket, "order": ticket,
                    "symbol": symbol, "comment": str(getattr(row, "comment", "") or "").strip(),
                    "pending_state": "pending", "lookback_seconds": lookback_seconds}

        def active_trade(row: Any) -> dict[str, Any]:
            position_id = getattr(row, "ticket", None) or getattr(row, "position_id", None)
            return {"found": True, "kind": "trade", "ticket": position_id,
                    "position_id": position_id, "symbol": symbol,
                    "comment": str(getattr(row, "comment", "") or "").strip(),
                    "lookback_seconds": lookback_seconds}

        def historical_order(row: Any) -> dict[str, Any]:
            order_ticket = getattr(row, "ticket", None) or getattr(row, "order", None)
            position_id = getattr(row, "position_id", None) or None
            state = int(getattr(row, "state", -1) if getattr(row, "state", None) is not None else -1)
            kind = expected_kind
            result = {"found": True, "kind": kind,
                      "ticket": order_ticket if kind == "pending" else (position_id or order_ticket),
                      "order": order_ticket, "position_id": position_id, "symbol": symbol,
                      "comment": str(getattr(row, "comment", "") or "").strip(),
                      "order_state": state, "lookback_seconds": lookback_seconds}
            if state == int(getattr(self.mt5, "ORDER_STATE_REJECTED", 5)):
                result.update({"kind": "rejected", "final_state": "rejected"})
            elif kind == "pending":
                states = {
                    int(getattr(self.mt5, "ORDER_STATE_FILLED", 4)): "filled",
                    int(getattr(self.mt5, "ORDER_STATE_PARTIAL", 3)): "partially_filled",
                    int(getattr(self.mt5, "ORDER_STATE_CANCELED", 2)): "cancelled",
                    int(getattr(self.mt5, "ORDER_STATE_EXPIRED", 6)): "expired",
                }
                result["pending_state"] = states.get(state, "pending")
            return result

        def historical_deal(row: Any) -> dict[str, Any]:
            order_ticket = getattr(row, "order", None) or getattr(row, "ticket", None)
            position_id = getattr(row, "position_id", None) or None
            result = {"found": True, "kind": expected_kind,
                      "ticket": order_ticket if expected_kind == "pending" else (position_id or order_ticket),
                      "order": order_ticket, "position_id": position_id,
                      "deal": getattr(row, "ticket", None), "symbol": symbol,
                      "comment": str(getattr(row, "comment", "") or "").strip(),
                      "lookback_seconds": lookback_seconds}
            if expected_kind == "pending":
                result["pending_state"] = "filled"
            return result

        date_to = datetime.now(timezone.utc) + timedelta(minutes=5)
        date_from = date_to - timedelta(seconds=lookback_seconds)
        if expected_kind == "pending":
            active = self.mt5.orders_get(symbol=symbol) if symbol else self.mt5.orders_get()
            if active is None:
                raise WorkerError("orders_query_failed")
            found = next((active_pending(row) for row in active if matches(row)), None)
            if found is None:
                history_orders = (self.mt5.history_orders_get(ticket=direct_ticket)
                                  if direct_ticket is not None
                                  else self.mt5.history_orders_get(date_from, date_to))
                if history_orders is None:
                    raise WorkerError("history_orders_query_failed")
                found = next((historical_order(row) for row in reversed(history_orders) if matches(row)), None)
            if found is None and direct_ticket is None:
                history_deals = self.mt5.history_deals_get(date_from, date_to)
                if history_deals is None:
                    raise WorkerError("history_deals_query_failed")
                found = next((historical_deal(row) for row in reversed(history_deals) if matches(row)), None)
        else:
            active = self.mt5.positions_get(symbol=symbol) if symbol else self.mt5.positions_get()
            if active is None:
                raise WorkerError("positions_query_failed")
            found = next((active_trade(row) for row in active if matches(row)), None)
            if found is None:
                history_deals = (self.mt5.history_deals_get(position=direct_ticket)
                                 if direct_ticket is not None
                                 else self.mt5.history_deals_get(date_from, date_to))
                if history_deals is None:
                    raise WorkerError("history_deals_query_failed")
                found = next((historical_deal(row) for row in reversed(history_deals) if matches(row)), None)
            if found is None:
                history_orders = (self.mt5.history_orders_get(position=direct_ticket)
                                  if direct_ticket is not None
                                  else self.mt5.history_orders_get(date_from, date_to))
                if history_orders is None:
                    raise WorkerError("history_orders_query_failed")
                found = next((historical_order(row) for row in reversed(history_orders) if matches(row)), None)
        lookup = found or {"found": False, "complete": True, "lookback_seconds": lookback_seconds}
        evidence = {"order_tickets": [], "position_tickets": [], "deal_tickets": []}
        if lookup.get("order"):
            evidence["order_tickets"] = [str(lookup["order"])]
        if lookup.get("position_id"):
            evidence["position_tickets"] = [str(lookup["position_id"])]
        if lookup.get("deal"):
            evidence["deal_tickets"] = [str(lookup["deal"])]
        return self._result(command, "succeeded", raw_result=lookup, evidence=evidence)

    def _send_order(self, command: dict[str, Any], request: dict[str, Any]) -> dict[str, Any]:
        result = self.mt5.order_send(request)
        if result is None:
            return self._result(command, "uncertain", "mt5_order_result_missing", str(self.mt5.last_error()),
                                raw_result={"request": request})
        raw = _plain(result)
        accepted = {
            int(getattr(self.mt5, "TRADE_RETCODE_DONE", 10009)),
            int(getattr(self.mt5, "TRADE_RETCODE_PLACED", 10008)),
            int(getattr(self.mt5, "TRADE_RETCODE_DONE_PARTIAL", 10010)),
        }
        status = "succeeded" if int(result.retcode) in accepted else "rejected"
        error_code = None if status == "succeeded" else f"mt5_retcode_{int(result.retcode)}"
        evidence = {
            "broker_retcode": int(result.retcode),
            "order_tickets": [str(result.order)] if getattr(result, "order", 0) else [],
            "deal_tickets": [str(result.deal)] if getattr(result, "deal", 0) else [],
        }
        return self._result(command, status, error_code, getattr(result, "comment", None), raw, evidence)

    def _result(self, command: dict[str, Any], status: str, error_code: str | None = None,
                error_message: str | None = None, raw_result: dict[str, Any] | None = None,
                evidence: dict[str, Any] | None = None) -> dict[str, Any]:
        now = int(time.time() * 1000)
        proof = {"observed_at_utc_msc": now, "order_tickets": [], "position_tickets": [],
                 "deal_tickets": [], "broker_retcode": None}
        proof.update(evidence or {})
        return {
            "v": PROTOCOL_VERSION,
            "type": "command_result",
            "message_id": f"result_{command.get('command_id')}_{now}",
            "sent_at_utc_msc": now,
            "command_id": command.get("command_id"),
            "terminal_instance_id": self.identity.terminal_instance_id,
            "account_ref": {"broker_server": self.identity.broker_server, "login": self.identity.login},
            "connection_epoch": self.identity.connection_epoch,
            "status": status,
            "completed_at_utc_msc": now,
            "error_code": error_code,
            "error_message": error_message,
            "raw_result": raw_result,
            "evidence": proof,
        }

    def _quote_result(self, request: dict[str, Any], status: str, observed_at: int,
                      bid: float | None = None, ask: float | None = None,
                      last: float | None = None, error_code: str | None = None,
                      symbol_trade_mode: int | None = None,
                      terminal_connected: bool | None = None) -> dict[str, Any]:
        result: dict[str, Any] = {
            "v": PROTOCOL_VERSION,
            "type": "quote",
            "message_id": f"quote_{request.get('request_id')}_{observed_at}",
            "sent_at_utc_msc": int(time.time() * 1000),
            "request_id": request.get("request_id"),
            "terminal_instance_id": self.identity.terminal_instance_id,
            "account_ref": {"broker_server": self.identity.broker_server, "login": self.identity.login},
            "connection_epoch": self.identity.connection_epoch,
            "symbol": request.get("symbol"),
            "observed_at_utc_msc": observed_at,
            "status": status,
        }
        if status == "succeeded":
            result.update({"bid": bid, "ask": ask, "last": last})
            if symbol_trade_mode is not None and 0 <= symbol_trade_mode <= 4:
                result["symbol_trade_mode"] = symbol_trade_mode
            if terminal_connected is not None:
                result["terminal_connected"] = terminal_connected
        else:
            result["error_code"] = error_code or "quote_rejected"
        return result

    def _data_result(self, request: dict[str, Any], status: str,
                     payload: dict[str, Any] | None = None,
                     error_code: str | None = None) -> dict[str, Any]:
        now = int(time.time() * 1000)
        result: dict[str, Any] = {
            "v": PROTOCOL_VERSION, "type": "data_response",
            "message_id": f"data_{request.get('request_id')}_{now}",
            "sent_at_utc_msc": now, "request_id": request.get("request_id"),
            "terminal_instance_id": self.identity.terminal_instance_id,
            "account_ref": {"broker_server": self.identity.broker_server, "login": self.identity.login},
            "connection_epoch": self.identity.connection_epoch,
            "action": request.get("action"), "params": request.get("params") or {},
            "observed_at_utc_msc": now, "status": status,
        }
        if status == "succeeded":
            result["payload"] = payload or {}
        else:
            result["error_code"] = error_code or "terminal_data_request_rejected"
        return result

    def _remember(self, command_id: str, result: dict[str, Any]) -> dict[str, Any]:
        self._receipts[command_id] = result
        self._receipts.move_to_end(command_id)
        while len(self._receipts) > ACCEPTED_RESULT_CACHE:
            self._receipts.popitem(last=False)
        return result

    @staticmethod
    def _required_text(params: dict[str, Any], key: str) -> str:
        value = str(params.get(key) or "").strip()
        if not value:
            raise WorkerError(f"{key}_required")
        return value

    @classmethod
    def _positive_float(cls, params: dict[str, Any], key: str) -> float:
        try:
            value = float(cls._required_text(params, key))
        except ValueError as error:
            raise WorkerError(f"{key}_invalid") from error
        if value <= 0:
            raise WorkerError(f"{key}_invalid")
        return value


def run(pipe_name: str, adapter: Mt5Adapter) -> int:
    pipe_path = rf"\\.\pipe\{pipe_name}"
    with open(pipe_path, "r+b", buffering=0) as stream:
        identity = adapter.connect()
        write_frame(stream, {"v": 3, "type": "worker_hello", "platform": "mt5",
                             "terminal_instance_id": adapter.identity.terminal_instance_id,
                             "connection_epoch": adapter.identity.connection_epoch, **identity})
        while True:
            request = read_frame(stream)
            request_type = request.get("type")
            if request_type == "shutdown":
                write_frame(stream, {"v": 3, "type": "shutdown_ack"})
                return 0
            if request_type == "collect":
                response = {"v": 3, "type": "snapshot", "request_id": request.get("request_id"),
                            "observed_at_utc_msc": int(time.time() * 1000),
                            "streams": adapter.collect(list(request.get("streams") or []))}
            elif request_type == "command":
                response = adapter.execute(request)
            elif request_type == "quote_request":
                response = adapter.quote(request)
            elif request_type == "data_request":
                response = adapter.data(request)
            else:
                response = {"v": 3, "type": "worker_error", "request_id": request.get("request_id"),
                            "error_code": "worker_request_type_unsupported"}
            write_frame(stream, response)


def probe(mt5: Any, terminal_path: str) -> dict[str, Any]:
    resolved_path = str(Path(terminal_path).resolve())
    if not Path(resolved_path).is_file():
        raise WorkerError("mt5_terminal_not_found")
    if not mt5.initialize(path=resolved_path, timeout=10_000, portable=False):
        raise WorkerError("mt5_initialize_failed", str(mt5.last_error()))
    account = mt5.account_info()
    terminal = mt5.terminal_info()
    if account is None or terminal is None:
        raise WorkerError("mt5_account_unavailable")
    if getattr(terminal, "connected", True) is False:
        raise WorkerError("mt5_terminal_disconnected")
    return {
        "v": 3,
        "type": "mt5_probe",
        "terminal_path": resolved_path,
        "account_ref": {
            "broker_server": str(account.server).strip(),
            "login": str(account.login),
        },
        "account": _plain(account),
        "terminal": _plain(terminal),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--probe", action="store_true")
    parser.add_argument("--pipe")
    parser.add_argument("--terminal", required=True)
    parser.add_argument("--terminal-id")
    parser.add_argument("--broker-server")
    parser.add_argument("--login")
    parser.add_argument("--connection-epoch", type=int)
    args = parser.parse_args()
    import MetaTrader5 as mt5  # bundled module; intentionally imported only in the Worker entrypoint
    if args.probe:
        try:
            print(json.dumps(probe(mt5, args.terminal), ensure_ascii=False, separators=(",", ":")))
            return 0
        finally:
            mt5.shutdown()
    required = {
        "pipe": args.pipe,
        "terminal-id": args.terminal_id,
        "broker-server": args.broker_server,
        "login": args.login,
        "connection-epoch": args.connection_epoch,
    }
    missing = [name for name, value in required.items() if value is None or value == ""]
    if missing:
        parser.error(f"missing required arguments: {', '.join(missing)}")
    adapter = Mt5Adapter(mt5, args.terminal, WorkerIdentity(
        args.terminal_id, args.broker_server, args.login, args.connection_epoch))
    try:
        return run(args.pipe, adapter)
    finally:
        adapter.shutdown()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({"type": "fatal", "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        raise
