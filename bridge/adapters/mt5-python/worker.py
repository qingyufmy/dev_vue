from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import json
import math
import os
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
DEAL_BATCH_LIMIT = 250
DEAL_WINDOW_MSC = 24 * 60 * 60 * 1000
DEFAULT_MT5_TIMEZONE_OFFSET_MINUTES = 180
MT5_CLOCK_FRESHNESS_TOLERANCE_MS = 30_000
MT5_CLOCK_STALE_AFTER_MS = 120_000
MT5_CLOCK_OFFSET_STEP_MINUTES = 15
MT5_CLOCK_MIN_OFFSET_MINUTES = -720
MT5_CLOCK_MAX_OFFSET_MINUTES = 840


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
    def __init__(self, mt5: Any, terminal_path: str, identity: WorkerIdentity,
                 clock_msc: Any | None = None, clock_state_path: Path | None = None):
        self.mt5 = mt5
        self.terminal_path = str(Path(terminal_path).resolve())
        self.identity = identity
        self._receipts: OrderedDict[str, dict[str, Any]] = OrderedDict()
        self._resolved_symbols: dict[str, str] = {}
        self._clock_msc = clock_msc or (lambda: int(time.time() * 1000))
        self._clock_state_path = clock_state_path
        self._timezone_offset_minutes = DEFAULT_MT5_TIMEZONE_OFFSET_MINUTES
        self._clock_status = "fallback"
        self._clock_residual_ms: int | None = None
        self._clock_trusted = False
        self._last_raw_tick_msc = 0
        self._last_host_tick_msc = 0
        self._load_clock_state()

    def _load_clock_state(self) -> None:
        if self._clock_state_path is None or not self._clock_state_path.is_file():
            return
        try:
            state = json.loads(self._clock_state_path.read_text(encoding="utf-8"))
            offset = int(state.get("timezone_offset_minutes"))
            if (int(state.get("version") or 0) == 1
                    and MT5_CLOCK_MIN_OFFSET_MINUTES <= offset <= MT5_CLOCK_MAX_OFFSET_MINUTES):
                self._timezone_offset_minutes = offset
                self._clock_status = "persisted"
                self._clock_trusted = True
        except (OSError, TypeError, ValueError, json.JSONDecodeError):
            return

    def _save_clock_state(self) -> None:
        if self._clock_state_path is None or not self._clock_trusted:
            return
        try:
            self._clock_state_path.parent.mkdir(parents=True, exist_ok=True)
            temporary = self._clock_state_path.with_suffix(self._clock_state_path.suffix + ".tmp")
            temporary.write_text(json.dumps({
                "version": 1,
                "timezone_offset_minutes": self._timezone_offset_minutes,
                "verified_at_utc_msc": self._clock_msc(),
            }, separators=(",", ":")), encoding="utf-8")
            temporary.replace(self._clock_state_path)
        except OSError:
            # Clock persistence improves restart/weekend behavior, but a read-only
            # profile must not stop the bridge while the live clock is verified.
            return

    def _clock_fields(self) -> dict[str, Any]:
        return {
            "timezone_offset_minutes": self._timezone_offset_minutes,
            "clock_status": self._clock_status,
            "clock_residual_ms": self._clock_residual_ms,
        }

    def _normalize_server_msc(self, raw_msc: int) -> int:
        return int(raw_msc) - self._timezone_offset_minutes * 60_000

    def _server_from_utc_msc(self, utc_msc: int) -> int:
        return int(utc_msc) + self._timezone_offset_minutes * 60_000

    def _calibrate_mt5_clock(self, tick: Any) -> None:
        raw_msc = int(getattr(tick, "time_msc", 0) or 0)
        host_msc = int(self._clock_msc())
        if raw_msc <= 0:
            self._clock_status = "unverified"
            self._clock_residual_ms = None
            return
        normalized = self._normalize_server_msc(raw_msc)
        residual = normalized - host_msc
        self._clock_residual_ms = residual
        if abs(residual) <= MT5_CLOCK_FRESHNESS_TOLERANCE_MS:
            self._clock_status = "verified"
            self._clock_trusted = True
            self._last_raw_tick_msc = raw_msc
            self._last_host_tick_msc = host_msc
            self._save_clock_state()
            return
        if (raw_msc == self._last_raw_tick_msc
                and self._last_host_tick_msc
                and host_msc - self._last_host_tick_msc >= MT5_CLOCK_STALE_AFTER_MS):
            self._clock_status = "stale"
            return
        if self._last_raw_tick_msc and raw_msc > self._last_raw_tick_msc:
            raw_progress = raw_msc - self._last_raw_tick_msc
            host_progress = host_msc - self._last_host_tick_msc
            if abs(raw_progress - host_progress) <= MT5_CLOCK_FRESHNESS_TOLERANCE_MS:
                candidate = round((raw_msc - host_msc) / 900_000) * MT5_CLOCK_OFFSET_STEP_MINUTES
                candidate_residual = raw_msc - candidate * 60_000 - host_msc
                if (MT5_CLOCK_MIN_OFFSET_MINUTES <= candidate <= MT5_CLOCK_MAX_OFFSET_MINUTES
                        and abs(candidate_residual) <= MT5_CLOCK_FRESHNESS_TOLERANCE_MS):
                    self._timezone_offset_minutes = candidate
                    self._clock_residual_ms = candidate_residual
                    self._clock_status = "verified"
                    self._clock_trusted = True
                    self._last_raw_tick_msc = raw_msc
                    self._last_host_tick_msc = host_msc
                    self._save_clock_state()
                    return
        self._clock_status = "calibrating"
        self._last_raw_tick_msc = raw_msc
        self._last_host_tick_msc = host_msc

    def _calibrate_symbol_clock(self, symbol: str) -> Any:
        tick = self.mt5.symbol_info_tick(symbol)
        if tick is None:
            raise WorkerError("symbol_tick_unavailable")
        self._calibrate_mt5_clock(tick)
        if not self._clock_trusted:
            raise WorkerError("mt5_clock_unverified")
        return tick

    def connect(self) -> dict[str, Any]:
        if not Path(self.terminal_path).is_file():
            raise WorkerError("mt5_terminal_not_found")
        if not self.mt5.initialize(path=self.terminal_path, timeout=10_000, portable=False):
            raise WorkerError("mt5_initialize_failed", str(self.mt5.last_error()))
        return self._ensure_identity()

    def shutdown(self) -> None:
        self.mt5.shutdown()

    def _resolve_symbol(self, requested: Any) -> str:
        symbol = str(requested or "").strip()
        if not symbol or len(symbol) > 64:
            raise WorkerError("symbol_invalid")
        cache_key = symbol.upper()
        if cache_key in self._resolved_symbols:
            return self._resolved_symbols[cache_key]
        symbols = self.mt5.symbols_get()
        if symbols is None:
            raise WorkerError("mt5_symbols_unavailable")
        names = [str(getattr(item, "name", "") or "") for item in symbols]
        exact = next((name for name in names if name == symbol), None)
        if exact:
            self._resolved_symbols[cache_key] = exact
            return exact
        folded = symbol.upper()
        case_match = next((name for name in names if name.upper() == folded), None)
        if case_match:
            self._resolved_symbols[cache_key] = case_match
            return case_match
        suffixes = (".s", "m", ".c", "_", ".micro")
        suffixed = next((name for suffix in suffixes for name in names
                         if name.upper() == f"{folded}{suffix}".upper()), None)
        if suffixed:
            self._resolved_symbols[cache_key] = suffixed
            return suffixed
        prefix_match = next((name for name in names if name.upper().startswith(folded)), None)
        if prefix_match:
            self._resolved_symbols[cache_key] = prefix_match
            return prefix_match
        raise WorkerError("symbol_not_found")

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

    def collect(self, streams: list[str], deal_cursor: dict[str, Any] | None = None,
                now_utc_msc: int | None = None) -> dict[str, Any]:
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
        if "deals" in streams:
            result["deals"] = self._collect_deals(
                deal_cursor or {}, now_utc_msc=now_utc_msc)
        return result

    def _collect_deals(self, cursor: dict[str, Any],
                       now_utc_msc: int | None = None) -> dict[str, Any]:
        try:
            cursor_time = int(cursor.get("time_msc") or cursor.get("from_utc_msc") or 0)
            cursor_ticket = int(cursor.get("ticket") or 0)
            limit = int(cursor.get("limit") or DEAL_BATCH_LIMIT)
        except (TypeError, ValueError) as error:
            raise WorkerError("mt5_deals_cursor_invalid") from error
        now_msc = int(now_utc_msc if now_utc_msc is not None else time.time() * 1000)
        if cursor_time <= 0 or cursor_time > now_msc or cursor_ticket < 0:
            raise WorkerError("mt5_deals_cursor_invalid")
        if limit < 1 or limit > DEAL_BATCH_LIMIT:
            raise WorkerError("mt5_deals_limit_invalid")
        window_end = min(cursor_time + DEAL_WINDOW_MSC, now_msc)
        if window_end <= cursor_time:
            return {"items": [], "next_cursor": {"time_msc": cursor_time,
                    "ticket": str(cursor_ticket)}, "has_more": False}
        date_from = datetime.fromtimestamp(max(0, cursor_time - 1_000) / 1000, tz=timezone.utc)
        date_to = datetime.fromtimestamp((window_end + 999) / 1000, tz=timezone.utc)
        deals = self.mt5.history_deals_get(date_from, date_to)
        if deals is None:
            raise WorkerError("mt5_deals_unavailable", str(self.mt5.last_error()))
        rows: list[tuple[int, int, dict[str, Any]]] = []
        for item in deals:
            raw = _plain(item)
            if not isinstance(raw, dict):
                raise WorkerError("mt5_deals_invalid")
            try:
                ticket = int(raw.get("ticket") or 0)
                event_msc = int(raw.get("time_msc") or int(raw.get("time") or 0) * 1000)
            except (TypeError, ValueError) as error:
                raise WorkerError("mt5_deals_invalid") from error
            if ticket <= 0 or event_msc <= 0:
                raise WorkerError("mt5_deals_invalid")
            if (event_msc, ticket) > (cursor_time, cursor_ticket) and event_msc <= window_end:
                rows.append((event_msc, ticket, raw))
        rows.sort(key=lambda value: (value[0], value[1]))
        selected = rows[:limit]
        if len(rows) > limit:
            next_cursor = {"time_msc": selected[-1][0], "ticket": str(selected[-1][1])}
            has_more = True
        else:
            boundary_ticket = (str(selected[-1][1])
                               if selected and selected[-1][0] == window_end else "0")
            next_cursor = {"time_msc": window_end, "ticket": boundary_ticket}
            has_more = window_end < now_msc
        return {"items": [value[2] for value in selected],
                "next_cursor": next_cursor, "has_more": has_more}

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
            symbol = self._resolve_symbol(request.get("symbol"))
            tick = self._calibrate_symbol_clock(symbol)
            info = self.mt5.symbol_info(symbol)
            terminal = self.mt5.terminal_info()
            bid = float(tick.bid)
            ask = float(tick.ask)
            last = float(getattr(tick, "last", 0.0) or 0.0)
            if not math.isfinite(bid) or not math.isfinite(ask) or bid <= 0 or ask <= 0 or ask < bid:
                raise WorkerError("symbol_tick_invalid")
            if not math.isfinite(last) or last < 0:
                last = 0.0
            raw_observed_at = int(getattr(tick, "time_msc", 0) or 0)
            observed_at = self._normalize_server_msc(raw_observed_at)
            return self._quote_result(
                request, "succeeded", observed_at, bid=bid, ask=ask, last=last,
                raw_observed_at=raw_observed_at,
                symbol_trade_mode=(int(getattr(info, "trade_mode", -1)) if info is not None else None),
                terminal_connected=(bool(getattr(terminal, "connected", True)) if terminal is not None else None),
                digits=(int(getattr(info, "digits", 0)) if info is not None else None),
                point=(float(getattr(info, "point", 0.0)) if info is not None else None),
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
            if action not in {"rates", "symbol_snapshot", "risk_snapshot", "performance_daily",
                              "symbols", "history", "chart_data", "pending_order_state",
                              "diagnostics"}:
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
            elif action == "performance_daily":
                payload = self._performance_daily(params)
            elif action == "symbols":
                payload = self._symbols()
            elif action == "history":
                payload = self._history(params)
            elif action == "pending_order_state":
                payload = self._pending_order_state(params)
            elif action == "diagnostics":
                payload = self._diagnostics()
            else:
                payload = self._chart_data(params)
            return self._data_result(request, "succeeded", payload=payload)
        except WorkerError as error:
            return self._data_result(request, "rejected", error_code=error.code)
        except Exception:
            return self._data_result(request, "rejected", error_code="mt5_data_request_exception")

    def _rates(self, params: dict[str, Any]) -> dict[str, Any]:
        symbol = self._resolve_symbol(params.get("symbol"))
        self._calibrate_symbol_clock(symbol)
        timeframe = str(params.get("timeframe") or "M30").strip().upper()
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
            raw_start_msc = self._server_from_utc_msc(start_utc_msc)
            raw_end_msc = self._server_from_utc_msc(end_utc_msc)
            rates = self.mt5.copy_rates_range(
                symbol, timeframe_value,
                datetime.fromtimestamp(raw_start_msc / 1000.0, timezone.utc),
                datetime.fromtimestamp(raw_end_msc / 1000.0, timezone.utc))
            if rates is not None and len(rates) > count:
                rates = rates[-count:]
        else:
            rates = self.mt5.copy_rates_from_pos(symbol, timeframe_value, 0, count)
        if rates is None:
            raise WorkerError("rates_unavailable", str(self.mt5.last_error()))
        captured_at = int(self._clock_msc())
        output: list[dict[str, Any]] = []
        for rate in rates:
            server_msc = int(rate[0]) * 1000
            epoch_msc = self._normalize_server_msc(server_msc)
            if epoch_msc > captured_at + MT5_CLOCK_FRESHNESS_TOLERANCE_MS:
                continue
            output.append({
                "time": datetime.fromtimestamp(server_msc / 1000.0, timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
                "time_msc": server_msc,
                "time_server_msc": server_msc,
                "time_utc_msc": epoch_msc,
                "open": float(rate[1]), "high": float(rate[2]),
                "low": float(rate[3]), "close": float(rate[4]),
                "tick_volume": int(rate[5]), "spread": int(rate[6]) if len(rate) > 6 else 0,
                "captured_at_utc_msc": captured_at,
                **self._clock_fields(),
            })
        if rates is not None and len(rates) and not output:
            raise WorkerError("rates_future_timestamp_invalid")
        return {
            "symbol": symbol, "timeframe": timeframe, "count": len(output),
            "rates": output, "source": "mt5", "range_complete": range_complete,
            "range_start_utc_msc": start_utc_msc or None,
            "range_end_utc_msc": end_utc_msc or None,
            **self._clock_fields(),
        }

    def _symbol_snapshot(self, params: dict[str, Any]) -> dict[str, Any]:
        symbol = self._resolve_symbol(params.get("symbol"))
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

    def _symbols(self) -> dict[str, Any]:
        symbols = self.mt5.symbols_get()
        if symbols is None:
            raise WorkerError("mt5_symbols_unavailable", str(self.mt5.last_error()))
        rows = []
        for item in symbols:
            name = str(getattr(item, "name", "") or "").strip()
            if not name:
                continue
            rows.append({
                "name": name,
                "description": str(getattr(item, "description", "") or ""),
                "digits": int(getattr(item, "digits", 0) or 0),
                "trade_mode": int(getattr(item, "trade_mode", 0) or 0),
                "point": float(getattr(item, "point", 0.0) or 0.0),
                "tick_size": float(getattr(item, "trade_tick_size", 0.0) or 0.0),
                "tick_value": float(getattr(item, "trade_tick_value", 0.0) or 0.0),
                "contract_size": float(getattr(item, "trade_contract_size", 0.0) or 0.0),
                "volume_min": float(getattr(item, "volume_min", 0.0) or 0.0),
                "volume_max": float(getattr(item, "volume_max", 0.0) or 0.0),
                "volume_step": float(getattr(item, "volume_step", 0.0) or 0.0),
            })
        rows.sort(key=lambda row: row["name"].upper())
        return {"symbols": rows, "count": len(rows), "source": "mt5"}

    @staticmethod
    def _history_time(value: Any) -> str:
        try:
            timestamp = int(value or 0)
        except (TypeError, ValueError):
            return ""
        if timestamp <= 0:
            return ""
        return datetime.fromtimestamp(timestamp, timezone.utc).strftime("%Y-%m-%d %H:%M:%S")

    @staticmethod
    def _history_range(params: dict[str, Any]) -> tuple[datetime, datetime]:
        try:
            start = (datetime.strptime(str(params.get("date_from") or "2000-01-01")[:10],
                                       "%Y-%m-%d").replace(tzinfo=timezone.utc))
            end = (datetime.strptime(str(params.get("date_to") or
                                         datetime.now(timezone.utc).strftime("%Y-%m-%d"))[:10],
                                     "%Y-%m-%d").replace(tzinfo=timezone.utc)
                   + timedelta(days=1))
        except (TypeError, ValueError) as error:
            raise WorkerError("history_date_range_invalid") from error
        if end <= start:
            raise WorkerError("history_date_range_invalid")
        return start, end

    def _history_deals(self, params: dict[str, Any]) -> list[dict[str, Any]]:
        date_from, date_to = self._history_range(params)
        deals = self.mt5.history_deals_get(date_from, date_to)
        if deals is None:
            raise WorkerError("history_deals_unavailable", str(self.mt5.last_error()))
        rows = [_plain(item) for item in deals]
        if not all(isinstance(item, dict) for item in rows):
            raise WorkerError("history_deals_invalid")
        return rows

    def _closed_history_rows(self, params: dict[str, Any]) -> tuple[list[dict[str, Any]], dict[str, float]]:
        deal_rows = self._history_deals(params)
        entry_in = int(getattr(self.mt5, "DEAL_ENTRY_IN", 0))
        exit_entries = {
            int(getattr(self.mt5, "DEAL_ENTRY_OUT", 1)),
            int(getattr(self.mt5, "DEAL_ENTRY_INOUT", 2)),
            int(getattr(self.mt5, "DEAL_ENTRY_OUT_BY", 3)),
        }
        buy_type = int(getattr(self.mt5, "DEAL_TYPE_BUY", 0))
        balance_type = int(getattr(self.mt5, "DEAL_TYPE_BALANCE", 2))
        credit_type = int(getattr(self.mt5, "DEAL_TYPE_CREDIT", 3))
        grouped: dict[Any, list[dict[str, Any]]] = {}
        deposit = withdrawal = credit = 0.0
        for deal in deal_rows:
            deal_type = int(deal.get("type") if deal.get("type") is not None else -1)
            amount = float(deal.get("profit") or 0.0)
            if deal_type == balance_type:
                if amount >= 0:
                    deposit += amount
                else:
                    withdrawal += abs(amount)
            elif deal_type == credit_type:
                credit += amount
            key = deal.get("position_id") or deal.get("order") or deal.get("ticket")
            grouped.setdefault(key, []).append(deal)

        rows: list[dict[str, Any]] = []
        for deal in deal_rows:
            try:
                entry = int(deal.get("entry") if deal.get("entry") is not None else -1)
            except (TypeError, ValueError):
                continue
            if entry not in exit_entries:
                continue
            position_id = deal.get("position_id") or deal.get("order") or deal.get("ticket")
            group = grouped.get(position_id, [])
            opened = next((item for item in group
                           if int(item.get("entry") if item.get("entry") is not None else -1)
                           == entry_in), None)
            origin = opened or deal
            order_ticket = origin.get("order") or position_id
            net_profit = sum(float(deal.get(field) or 0.0)
                             for field in ("profit", "swap", "commission", "fee"))
            rows.append({
                "ticket": order_ticket,
                "deal_ticket": deal.get("ticket"),
                "order": order_ticket,
                "position_id": position_id,
                "symbol": deal.get("symbol") or origin.get("symbol") or "",
                "type": "BUY" if int(origin.get("type") or 0) == buy_type else "SELL",
                "volume": float(deal.get("volume") or 0.0),
                "entry_price": float(origin.get("price") or 0.0),
                "exit_price": float(deal.get("price") or 0.0),
                "price": float(deal.get("price") or 0.0),
                "profit": float(deal.get("profit") or 0.0),
                "swap": float(deal.get("swap") or 0.0),
                "commission": float(deal.get("commission") or 0.0),
                "fee": float(deal.get("fee") or 0.0),
                "net_profit": net_profit,
                "entry_time": self._history_time(origin.get("time")),
                "close_time": self._history_time(deal.get("time")),
                "time": self._history_time(deal.get("time")),
                "comment": str(deal.get("comment") or ""),
                "take_profit": 0.0,
                "stop_loss": 0.0,
            })
        rows.sort(key=lambda row: row.get("close_time") or row.get("entry_time") or "",
                  reverse=True)
        direction = str(params.get("direction") or "").upper()
        profit_filter = str(params.get("profit_filter") or "").lower()
        entry_from = str(params.get("entry_from") or "")[:10]
        entry_to = str(params.get("entry_to") or "")[:10]
        if direction:
            rows = [row for row in rows if row["type"] == direction]
        if profit_filter == "profit":
            rows = [row for row in rows if row["profit"] > 0]
        elif profit_filter == "loss":
            rows = [row for row in rows if row["profit"] < 0]
        if entry_from:
            rows = [row for row in rows if row["entry_time"][:10] >= entry_from]
        if entry_to:
            rows = [row for row in rows if row["entry_time"][:10] <= entry_to]
        return rows, {"deposit": deposit, "withdrawal": withdrawal, "credit": credit}

    def _history(self, params: dict[str, Any]) -> dict[str, Any]:
        try:
            page = int(params.get("page") or 1)
            page_size = int(params.get("page_size") or 20)
        except (TypeError, ValueError) as error:
            raise WorkerError("history_pagination_invalid") from error
        if page < 1 or page_size < 1 or page_size > 10_000:
            raise WorkerError("history_pagination_invalid")
        rows, capital = self._closed_history_rows(params)
        if params.get("compact") is True:
            compact_rows = [{
                "t": row["close_time"], "p": row["profit"], "y": row["type"],
            } for row in rows]
            return {"orders": compact_rows, "total_count": len(compact_rows), "source": "mt5"}
        total = len(rows)
        start = (page - 1) * page_size
        visible = rows[start:start + page_size]
        include_deals = params.get("include_deals") is True
        history_orders: list[dict[str, Any]] = []
        raw_deals: list[dict[str, Any]] = []
        if include_deals:
            date_from, date_to = self._history_range(params)
            orders = self.mt5.history_orders_get(date_from, date_to)
            if orders is None:
                raise WorkerError("history_orders_unavailable", str(self.mt5.last_error()))
            for item in orders:
                row = _plain(item)
                if not isinstance(row, dict):
                    raise WorkerError("history_orders_invalid")
                history_orders.append({
                    "ticket": row.get("ticket"), "position_id": row.get("position_id"),
                    "symbol": row.get("symbol"), "type": row.get("type"),
                    "state": row.get("state"), "magic": row.get("magic"),
                    "reason": row.get("reason"), "comment": row.get("comment"),
                    "volume_initial": row.get("volume_initial"),
                    "volume_current": row.get("volume_current"),
                    "price_open": row.get("price_open"),
                    "price_current": row.get("price_current"),
                    "sl": float(row.get("sl") or 0.0), "tp": float(row.get("tp") or 0.0),
                    "time_setup": self._history_time(row.get("time_setup")),
                    "time_done": self._history_time(row.get("time_done")),
                })
            for row in self._history_deals(params):
                raw_deals.append({
                    "deal_ticket": row.get("ticket"), "ticket": row.get("ticket"),
                    "order": row.get("order"), "position_id": row.get("position_id"),
                    "symbol": row.get("symbol"), "type": row.get("type"),
                    "entry": row.get("entry"), "magic": row.get("magic"),
                    "reason": row.get("reason"), "comment": row.get("comment"),
                    "volume": row.get("volume"), "price": row.get("price"),
                    "profit": row.get("profit"), "commission": row.get("commission"),
                    "swap": row.get("swap"), "fee": row.get("fee"),
                    "sl": row.get("sl"), "tp": row.get("tp"),
                    "time": self._history_time(row.get("time")), "time_msc": row.get("time_msc"),
                })
        else:
            for row in visible:
                try:
                    orders = self.mt5.history_orders_get(ticket=int(row.get("ticket") or 0))
                except (TypeError, ValueError):
                    orders = None
                if not orders:
                    continue
                order = orders[-1]
                row["take_profit"] = float(getattr(order, "tp", 0.0) or 0.0)
                row["stop_loss"] = float(getattr(order, "sl", 0.0) or 0.0)
        total_profit = sum(row["net_profit"] for row in rows)
        net_result = total_profit + capital["credit"] + capital["deposit"] - capital["withdrawal"]
        account = self.mt5.account_info()
        balance = float(getattr(account, "balance", 0.0) or 0.0) if account else 0.0
        return {
            "orders": visible,
            "deals": raw_deals,
            "history_orders": history_orders,
            "statistics": {
                "account_principal": round(balance - net_result, 2),
                "account_balance": round(balance, 2),
                "total_profit": round(total_profit, 2),
                "credit": round(capital["credit"], 2),
                "deposit": round(capital["deposit"], 2),
                "withdrawal": round(capital["withdrawal"], 2),
                "net_result": round(net_result, 2),
                "trade_count": total,
                "total_volume": round(sum(row["volume"] for row in rows), 2),
            },
            "pagination": {
                "current_page": page,
                "page_size": page_size,
                "total_count": total,
                "total_pages": max(math.ceil(total / page_size), 1),
            },
            "source": "mt5",
        }

    def _pending_order_state(self, params: dict[str, Any]) -> dict[str, Any]:
        try:
            ticket = int(str(params.get("ticket") or ""))
        except (TypeError, ValueError) as error:
            raise WorkerError("ticket_required") from error
        if ticket <= 0:
            raise WorkerError("ticket_required")
        account = self.mt5.account_info()
        if account is None:
            raise WorkerError("mt5_account_unavailable")
        account_row = {"login": getattr(account, "login", None),
                       "server": getattr(account, "server", None)}
        current = self.mt5.orders_get(ticket=ticket)
        if current is None:
            raise WorkerError("orders_query_failed", str(self.mt5.last_error()))
        expected = params.get("expected_state")
        if expected is not None and not isinstance(expected, dict):
            raise WorkerError("management_expected_state_invalid")
        if current:
            order = current[0]
            order_row = self._pending_order_state_row(order)
            if expected:
                try:
                    self._validate_management_target(expected, order, "pending")
                except WorkerError as error:
                    return {"account": account_row, "current_state": "identity_changed",
                            "final_state": "unknown", "order": order_row,
                            "precondition_error": error.code, "source": "mt5"}
            return {"account": account_row, "current_state": "pending", "final_state": None,
                    "order": order_row, "source": "mt5"}
        history = self.mt5.history_orders_get(ticket=ticket)
        if history is None:
            raise WorkerError("history_orders_query_failed", str(self.mt5.last_error()))
        if not history:
            return {"account": account_row, "current_state": "absent", "final_state": "unknown",
                    "order": None, "source": "mt5"}
        order = history[-1]
        order_row = self._pending_order_state_row(order)
        if expected:
            try:
                self._validate_management_target(expected, order, "pending")
            except WorkerError as error:
                return {"account": account_row, "current_state": "history",
                        "final_state": "unknown", "order": order_row,
                        "precondition_error": error.code, "source": "mt5"}
        states = {
            int(getattr(self.mt5, "ORDER_STATE_FILLED", 4)): "filled",
            int(getattr(self.mt5, "ORDER_STATE_PARTIAL", 3)): "partially_filled",
            int(getattr(self.mt5, "ORDER_STATE_CANCELED", 2)): "cancelled",
            int(getattr(self.mt5, "ORDER_STATE_EXPIRED", 6)): "expired",
            int(getattr(self.mt5, "ORDER_STATE_REJECTED", 5)): "rejected",
        }
        final_state = states.get(int(getattr(order, "state", -1)), "unknown")
        return {"account": account_row, "current_state": "history", "final_state": final_state,
                "position_id": order_row.get("position_id"), "order": order_row, "source": "mt5"}

    def _pending_order_state_row(self, order: Any) -> dict[str, Any]:
        buy_types = {int(self.mt5.ORDER_TYPE_BUY_LIMIT), int(self.mt5.ORDER_TYPE_BUY_STOP),
                     int(self.mt5.ORDER_TYPE_BUY_STOP_LIMIT)}
        order_type = int(getattr(order, "type", -1))
        return {
            "ticket": getattr(order, "ticket", None),
            "position_id": getattr(order, "position_id", 0) or None,
            "symbol": str(getattr(order, "symbol", "") or ""),
            "side": "buy" if order_type in buy_types else "sell",
            "type": order_type, "state": int(getattr(order, "state", -1)),
            "volume_initial": float(getattr(order, "volume_initial", 0.0) or 0.0),
            "volume": float(getattr(order, "volume_current", 0.0) or 0.0),
            "price": float(getattr(order, "price_open", 0.0) or 0.0),
            "magic": int(getattr(order, "magic", 0) or 0),
            "comment": str(getattr(order, "comment", "") or ""),
        }

    def _diagnostics(self) -> dict[str, Any]:
        account = self.mt5.account_info()
        terminal = self.mt5.terminal_info()
        if account is None or terminal is None:
            raise WorkerError("mt5_account_unavailable")
        return {
            "mt5_connected": bool(getattr(terminal, "connected", True)),
            "account": {"login": getattr(account, "login", None),
                        "server": getattr(account, "server", None),
                        "balance": float(getattr(account, "balance", 0.0) or 0.0),
                        "equity": float(getattr(account, "equity", 0.0) or 0.0),
                        "trade_allowed": bool(getattr(account, "trade_allowed", False)),
                        "trade_expert": bool(getattr(account, "trade_expert", False))},
            "terminal": {"build": int(getattr(terminal, "build", 0) or 0),
                         "connected": bool(getattr(terminal, "connected", True)),
                         "trade_allowed": bool(getattr(terminal, "trade_allowed", False))},
            "source": "mt5",
        }

    def _chart_data(self, params: dict[str, Any]) -> dict[str, Any]:
        rows, _ = self._closed_history_rows(params)
        rows.sort(key=lambda row: row.get("close_time") or "")
        daily_map: dict[str, dict[str, Any]] = {}
        for row in rows:
            day = str(row.get("close_time") or "")[:10]
            if not day:
                continue
            entry = daily_map.setdefault(day, {
                "date": day, "profit": 0.0, "trade_count": 0, "wins": 0, "losses": 0,
            })
            profit = float(row["net_profit"])
            entry["profit"] += profit
            entry["trade_count"] += 1
            if profit > 0:
                entry["wins"] += 1
            elif profit < 0:
                entry["losses"] += 1
        daily = sorted(daily_map.values(), key=lambda item: item["date"])
        for item in daily:
            item["profit"] = round(item["profit"], 2)
        account = self.mt5.account_info()
        balance = float(getattr(account, "balance", 0.0) or 0.0) if account else 0.0
        initial_capital = max(0.0, balance - sum(row["net_profit"] for row in rows))
        cumulative: list[float] = []
        drawdown: list[float] = []
        running = 0.0
        peak = initial_capital
        max_drawdown = 0.0
        for item in daily:
            running = round(running + item["profit"], 2)
            cumulative.append(running)
            equity = initial_capital + running
            peak = max(peak, equity)
            value = round((1 - equity / peak) * 100, 2) if peak > 0 else 0.0
            drawdown.append(value)
            max_drawdown = max(max_drawdown, value)
        wins = [row["net_profit"] for row in rows if row["net_profit"] > 0]
        losses = [row["net_profit"] for row in rows if row["net_profit"] < 0]
        gross_profit = sum(wins)
        gross_loss = abs(sum(losses))
        average_win = gross_profit / len(wins) if wins else 0.0
        average_loss = gross_loss / len(losses) if losses else 0.0
        return {
            "daily": daily,
            "cumulative": cumulative,
            "drawdown": drawdown,
            "stats": {
                "total_trades": len(rows),
                "win_rate": round(len(wins) / len(rows) * 100, 2) if rows else 0.0,
                "profit_factor": (round(average_win / average_loss, 2)
                                  if average_loss > 0 else (999 if average_win > 0 else 0)),
                "max_drawdown": max_drawdown,
                "gross_profit": round(gross_profit, 2),
                "gross_loss": round(gross_loss, 2),
            },
            "source": "mt5",
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
        symbol = self._resolve_symbol(params.get("symbol"))
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
        symbol = self._resolve_symbol(params.get("symbol"))
        select = getattr(self.mt5, "symbol_select", None)
        if callable(select) and not select(symbol, True):
            raise WorkerError("symbol_select_failed")
        side = self._required_text(params, "side").lower()
        if side not in {"buy", "sell"}:
            raise WorkerError("order_side_invalid")
        volume = self._positive_float(params, "volume")
        kind = str(params.get("order_kind") or "market").lower()
        info = self.mt5.symbol_info(symbol)
        if info is None:
            raise WorkerError("symbol_info_unavailable")
        self._validate_order_volume(info, volume)
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
        price = self._positive_price(params.get("price") or (tick.ask if side == "buy" else tick.bid),
                                     "price")
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
            "type_filling": int(params.get("type_filling") if params.get("type_filling") is not None
                                else self._filling_mode(info, pending=not is_market)),
        }
        for source, target in (("stop_loss", "sl"), ("take_profit", "tp"), ("stop_limit_price", "stoplimit")):
            if params.get(source) is not None:
                request[target] = self._positive_price(params[source], source)
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
        result = self._send_order(command, {"action": self.mt5.TRADE_ACTION_REMOVE, "order": ticket})
        remaining = self.mt5.orders_get(ticket=ticket)
        if remaining is None:
            return self._result(command, "uncertain", "cancel_order_verify_failed",
                                raw_result=result.get("raw_result"))
        if len(remaining) == 0:
            raw = dict(result.get("raw_result") or {})
            raw.update({"already_absent": False, "order": ticket})
            return self._result(command, "succeeded", raw_result=raw,
                                evidence=result.get("evidence"))
        if result.get("status") == "rejected":
            return result
        return self._result(command, "uncertain", "pending_order_still_active",
                            raw_result=result.get("raw_result"), evidence=result.get("evidence"))

    def _modify_order(self, command: dict[str, Any], params: dict[str, Any]) -> dict[str, Any]:
        request: dict[str, Any] = {
            "action": self.mt5.TRADE_ACTION_MODIFY,
            "order": int(self._required_text(params, "ticket")),
        }
        for source, target in (("price", "price"), ("stop_loss", "sl"), ("take_profit", "tp"),
                               ("stop_limit_price", "stoplimit")):
            if params.get(source) is not None:
                request[target] = self._positive_price(params[source], source)
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
            "type_filling": self._filling_mode(self.mt5.symbol_info(position.symbol), pending=False),
        }
        result = self._send_order(command, request)
        remaining = self.mt5.positions_get(ticket=ticket)
        if remaining is None:
            return self._result(command, "uncertain", "close_position_verify_failed",
                                raw_result=result.get("raw_result"), evidence=result.get("evidence"))
        if len(remaining) == 0:
            raw = dict(result.get("raw_result") or {})
            raw["position"] = ticket
            return self._result(command, "succeeded", raw_result=raw,
                                evidence=result.get("evidence"))
        remaining_volume = float(getattr(remaining[0], "volume", 0.0) or 0.0)
        raw = dict(result.get("raw_result") or {})
        raw.update({"position": ticket, "remaining_volume": remaining_volume})
        if remaining_volume < float(position.volume):
            return self._result(command, "uncertain", "close_position_partial",
                                raw_result=raw, evidence=result.get("evidence"))
        if result.get("status") == "rejected":
            return result
        return self._result(command, "uncertain", "position_still_open",
                            raw_result=raw, evidence=result.get("evidence"))

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
        if symbol:
            symbol = self._resolve_symbol(symbol)
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
        retryable = {
            int(getattr(self.mt5, "TRADE_RETCODE_REQUOTE", 10004)),
            int(getattr(self.mt5, "TRADE_RETCODE_PRICE_CHANGED", 10020)),
            int(getattr(self.mt5, "TRADE_RETCODE_PRICE_OFF", 10021)),
        }
        result = None
        for attempt in range(4):
            result = self.mt5.order_send(request)
            retcode = int(getattr(result, "retcode", -1)) if result is not None else -1
            if retcode not in retryable or attempt == 3:
                break
            symbol = str(request.get("symbol") or "")
            tick = self.mt5.symbol_info_tick(symbol) if symbol else None
            if tick is None:
                break
            buy_types = {int(self.mt5.ORDER_TYPE_BUY), int(self.mt5.ORDER_TYPE_BUY_LIMIT),
                         int(self.mt5.ORDER_TYPE_BUY_STOP), int(self.mt5.ORDER_TYPE_BUY_STOP_LIMIT)}
            if int(request.get("action") or -1) == int(self.mt5.TRADE_ACTION_DEAL):
                request = dict(request)
                raw_order_type = request.get("type")
                order_type = int(raw_order_type if raw_order_type is not None else -1)
                request["price"] = float(tick.ask if order_type in buy_types
                                         else tick.bid)
            time.sleep(0.15)
        if result is None:
            return self._result(command, "uncertain", "mt5_order_result_missing", str(self.mt5.last_error()),
                                raw_result={"request": request})
        raw = _plain(result)
        retcode = int(result.retcode)
        is_pending = int(request.get("action") or -1) == int(self.mt5.TRADE_ACTION_PENDING)
        if retcode == int(getattr(self.mt5, "TRADE_RETCODE_DONE", 10009)) \
                or (is_pending and retcode == int(getattr(self.mt5, "TRADE_RETCODE_PLACED", 10008))):
            status, error_code = "succeeded", None
        elif retcode == int(getattr(self.mt5, "TRADE_RETCODE_DONE_PARTIAL", 10010)) \
                or int(getattr(result, "order", 0) or 0) > 0 \
                or int(getattr(result, "deal", 0) or 0) > 0:
            status, error_code = "uncertain", "mt5_execution_requires_reconciliation"
        else:
            status, error_code = "rejected", f"mt5_retcode_{retcode}"
        evidence = {
            "broker_retcode": retcode,
            "order_tickets": [str(result.order)] if getattr(result, "order", 0) else [],
            "deal_tickets": [str(result.deal)] if getattr(result, "deal", 0) else [],
        }
        return self._result(command, status, error_code, getattr(result, "comment", None), raw, evidence)

    def _filling_mode(self, info: Any, pending: bool) -> int:
        if pending:
            return int(getattr(self.mt5, "ORDER_FILLING_RETURN", 2))
        filling = int(getattr(info, "filling_mode", 0) or 0) if info is not None else 0
        if filling & 2:
            return int(getattr(self.mt5, "ORDER_FILLING_IOC", 1))
        if filling & 1:
            return int(getattr(self.mt5, "ORDER_FILLING_FOK", 0))
        return int(getattr(self.mt5, "ORDER_FILLING_IOC",
                           getattr(self.mt5, "ORDER_FILLING_RETURN", 2)))

    @staticmethod
    def _validate_order_volume(info: Any, volume: float) -> None:
        volume_min = float(getattr(info, "volume_min", 0.0) or 0.0)
        volume_max = float(getattr(info, "volume_max", 0.0) or 0.0)
        volume_step = float(getattr(info, "volume_step", 0.0) or 0.0)
        epsilon = max(1e-9, volume_step * 1e-6)
        if volume_min > 0 and volume < volume_min - epsilon:
            raise WorkerError("order_volume_below_minimum")
        if volume_max > 0 and volume > volume_max + epsilon:
            raise WorkerError("order_volume_above_maximum")
        if volume_step > 0 and abs(round(volume / volume_step) * volume_step - volume) > epsilon:
            raise WorkerError("order_volume_step_invalid")

    @staticmethod
    def _positive_price(value: Any, field: str) -> float:
        try:
            number = float(value)
        except (TypeError, ValueError, OverflowError) as error:
            raise WorkerError(f"{field}_invalid") from error
        if not math.isfinite(number) or number <= 0:
            raise WorkerError(f"{field}_invalid")
        return number

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
                      raw_observed_at: int | None = None,
                      symbol_trade_mode: int | None = None,
                      terminal_connected: bool | None = None,
                      digits: int | None = None, point: float | None = None) -> dict[str, Any]:
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
            result.update(self._clock_fields())
            if raw_observed_at is not None:
                result["observed_at_server_msc"] = raw_observed_at
            if symbol_trade_mode is not None and 0 <= symbol_trade_mode <= 4:
                result["symbol_trade_mode"] = symbol_trade_mode
            if terminal_connected is not None:
                result["terminal_connected"] = terminal_connected
            if digits is not None and digits >= 0:
                result["digits"] = digits
            if point is not None and math.isfinite(point) and point > 0:
                result["point"] = point
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


def collect_snapshot(request: dict[str, Any], adapter: Mt5Adapter,
                     source_time_msc: int | None = None) -> dict[str, Any]:
    captured_at = source_time_msc if source_time_msc is not None else int(time.time() * 1000)
    return {"v": 3, "type": "snapshot", "request_id": request.get("request_id"),
            "source_time_msc": captured_at,
            # Retained for rolling compatibility with Bridge Core 3.0.0.
            "observed_at_utc_msc": captured_at,
            "streams": adapter.collect(
                list(request.get("streams") or []),
                request.get("deal_cursor"),
                now_utc_msc=captured_at)}


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
                response = collect_snapshot(request, adapter)
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
    identity = WorkerIdentity(
        args.terminal_id, args.broker_server, args.login, args.connection_epoch)
    clock_key = hashlib.sha256(
        f"{identity.broker_server.strip().lower()}|{identity.login}".encode("utf-8")).hexdigest()[:24]
    app_data = Path(os.environ.get("APPDATA") or (Path.home() / "AppData" / "Roaming"))
    adapter = Mt5Adapter(mt5, args.terminal, identity,
                         clock_state_path=app_data / "AURUM" / "BridgeV3" / "clock" / f"mt5-{clock_key}.json")
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
