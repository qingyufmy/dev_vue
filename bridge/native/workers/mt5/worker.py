from __future__ import annotations

import hashlib
import json
import math
import os
import struct
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, BinaryIO

from trade import Mt5TradeExecutor

IPC_VERSION = 1
WORKER_VERSION = "3.0.0"
MAX_FRAME_BYTES = 4 * 1024 * 1024
MAX_SNAPSHOT_ITEMS = 10_000
MAX_HISTORY_BATCH_ITEMS = 250
MAX_SYMBOL_ITEMS = 10_000
HISTORY_WINDOW_MSC = 30 * 24 * 60 * 60 * 1000
DEFAULT_TIMEZONE_OFFSET_MINUTES = 180
CLOCK_FRESHNESS_TOLERANCE_MS = 30_000
CLOCK_STALE_AFTER_MS = 120_000
TERMINAL_SESSION_FATAL_ERRORS = frozenset({
    "mt5_account_unavailable",
    "mt5_terminal_disconnected",
})
TERMINAL_LOGIN_WAIT_SECONDS = 30.0
TERMINAL_LOGIN_POLL_SECONDS = 0.5
RATE_TIMEFRAMES = frozenset({
    "M1", "M2", "M3", "M4", "M5", "M6", "M10", "M12", "M15", "M20", "M30",
    "H1", "H2", "H3", "H4", "H6", "H8", "H12", "D1", "W1", "MN1",
})


class WorkerError(RuntimeError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def _normalized_terminal_path(value: str | Path) -> str:
    normalized = os.path.normcase(os.path.abspath(os.fspath(value)))
    folded = normalized.casefold()
    if folded.startswith("\\\\?\\unc\\"):
        normalized = "\\\\" + normalized[8:]
    elif folded.startswith("\\\\?\\"):
        normalized = normalized[4:]
    return normalized.casefold()


def _running_windows_process_paths() -> tuple[str, ...]:
    if os.name != "nt":
        return ()
    import ctypes
    from ctypes import wintypes

    class ProcessEntry32W(ctypes.Structure):
        _fields_ = [
            ("dwSize", wintypes.DWORD),
            ("cntUsage", wintypes.DWORD),
            ("th32ProcessID", wintypes.DWORD),
            ("th32DefaultHeapID", ctypes.c_size_t),
            ("th32ModuleID", wintypes.DWORD),
            ("cntThreads", wintypes.DWORD),
            ("th32ParentProcessID", wintypes.DWORD),
            ("pcPriClassBase", wintypes.LONG),
            ("dwFlags", wintypes.DWORD),
            ("szExeFile", wintypes.WCHAR * 260),
        ]

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    kernel32.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(ProcessEntry32W)]
    kernel32.Process32FirstW.restype = wintypes.BOOL
    kernel32.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(ProcessEntry32W)]
    kernel32.Process32NextW.restype = wintypes.BOOL
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.QueryFullProcessImageNameW.argtypes = [
        wintypes.HANDLE,
        wintypes.DWORD,
        wintypes.LPWSTR,
        ctypes.POINTER(wintypes.DWORD),
    ]
    kernel32.QueryFullProcessImageNameW.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL

    snapshot = kernel32.CreateToolhelp32Snapshot(0x00000002, 0)
    if snapshot in (None, wintypes.HANDLE(-1).value):
        return ()
    paths: list[str] = []
    try:
        entry = ProcessEntry32W()
        entry.dwSize = ctypes.sizeof(ProcessEntry32W)
        available = bool(kernel32.Process32FirstW(snapshot, ctypes.byref(entry)))
        while available:
            if str(entry.szExeFile).lower() in {"terminal64.exe", "terminal.exe"}:
                process = kernel32.OpenProcess(0x1000, False, entry.th32ProcessID)
                if process:
                    try:
                        buffer = ctypes.create_unicode_buffer(32_768)
                        length = wintypes.DWORD(len(buffer))
                        if kernel32.QueryFullProcessImageNameW(
                            process, 0, buffer, ctypes.byref(length)
                        ):
                            paths.append(buffer.value)
                    finally:
                        kernel32.CloseHandle(process)
            available = bool(kernel32.Process32NextW(snapshot, ctypes.byref(entry)))
    finally:
        kernel32.CloseHandle(snapshot)
    return tuple(paths)


def _terminal_process_running(terminal_path: str | Path) -> bool:
    expected = _normalized_terminal_path(terminal_path)
    return any(
        _normalized_terminal_path(path) == expected
        for path in _running_windows_process_paths()
    )


def _require_terminal_running(terminal_path: str | Path) -> None:
    if not _terminal_process_running(terminal_path):
        raise WorkerError("mt5_terminal_not_running")


@dataclass(frozen=True)
class WorkerRoute:
    terminal_instance_id: str
    platform: str
    broker_server: str
    login: str
    connection_epoch: int

    def payload(self) -> dict[str, Any]:
        return {
            "terminal_instance_id": self.terminal_instance_id,
            "platform": self.platform,
            "account_ref": {"broker_server": self.broker_server, "login": self.login},
            "connection_epoch": self.connection_epoch,
        }


def _required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise WorkerError("worker_environment_invalid")
    return value


def route_from_environment() -> WorkerRoute:
    try:
        route = WorkerRoute(
            terminal_instance_id=_required_env("AURUM_BRIDGE_WORKER_TERMINAL_ID"),
            platform=_required_env("AURUM_BRIDGE_WORKER_PLATFORM").lower(),
            broker_server=_required_env("AURUM_BRIDGE_WORKER_BROKER_SERVER"),
            login=_required_env("AURUM_BRIDGE_WORKER_LOGIN"),
            connection_epoch=int(_required_env("AURUM_BRIDGE_WORKER_CONNECTION_EPOCH")),
        )
    except ValueError as error:
        raise WorkerError("worker_environment_invalid") from error
    if route.platform != "mt5" or route.connection_epoch <= 0:
        raise WorkerError("worker_environment_invalid")
    return route


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
    try:
        payload = json.loads(_read_exact(stream, length).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise WorkerError("worker_frame_json_invalid") from error
    if not isinstance(payload, dict):
        raise WorkerError("worker_frame_object_required")
    return payload


def write_frame(stream: BinaryIO, message: dict[str, Any]) -> None:
    try:
        payload = json.dumps(
            message, ensure_ascii=False, allow_nan=False, separators=(",", ":")
        ).encode("utf-8")
    except (TypeError, ValueError) as error:
        raise WorkerError("worker_frame_json_invalid") from error
    if not payload or len(payload) > MAX_FRAME_BYTES:
        raise WorkerError("worker_frame_too_large")
    stream.write(struct.pack("<I", len(payload)))
    stream.write(payload)
    stream.flush()


def _plain(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, bool)):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise WorkerError("mt5_data_non_finite")
        return value
    if hasattr(value, "_asdict"):
        return {str(key): _plain(item) for key, item in value._asdict().items()}
    if isinstance(value, dict):
        return {str(key): _plain(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(item) for item in value]
    return str(value)


class BrokerClock:
    def __init__(self, state_path: Path | None, clock_msc: Any | None = None):
        self._state_path = state_path
        self._clock_msc = clock_msc or (lambda: int(time.time() * 1000))
        self.offset_minutes = DEFAULT_TIMEZONE_OFFSET_MINUTES
        self.status = "fallback"
        self.residual_ms: int | None = None
        self._trusted = False
        self._last_raw_msc = 0
        self._last_host_msc = 0
        self._load()

    def _load(self) -> None:
        if self._state_path is None or not self._state_path.is_file():
            return
        try:
            state = json.loads(self._state_path.read_text(encoding="utf-8"))
            offset = int(state["timezone_offset_minutes"])
            if state.get("version") == 1 and -720 <= offset <= 840:
                self.offset_minutes = offset
                self.status = "persisted"
                self._trusted = True
        except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError):
            pass

    def _save(self) -> None:
        if self._state_path is None or not self._trusted:
            return
        try:
            self._state_path.parent.mkdir(parents=True, exist_ok=True)
            temporary = self._state_path.with_suffix(".tmp")
            temporary.write_text(json.dumps({
                "version": 1,
                "timezone_offset_minutes": self.offset_minutes,
            }, separators=(",", ":")), encoding="utf-8")
            temporary.replace(self._state_path)
        except OSError:
            pass

    def normalize(self, raw_msc: int) -> int:
        return raw_msc - self.offset_minutes * 60_000

    def server_from_utc(self, utc_msc: int) -> int:
        return utc_msc + self.offset_minutes * 60_000

    def now_utc_msc(self) -> int:
        return int(self._clock_msc())

    def calibrate(self, raw_msc: int) -> int:
        host_msc = int(self._clock_msc())
        if raw_msc <= 0:
            raise WorkerError("mt5_clock_unverified")
        residual = self.normalize(raw_msc) - host_msc
        self.residual_ms = residual
        if abs(residual) <= CLOCK_FRESHNESS_TOLERANCE_MS:
            self.status = "verified"
            self._trusted = True
        elif (raw_msc == self._last_raw_msc and self._last_host_msc
              and host_msc - self._last_host_msc >= CLOCK_STALE_AFTER_MS):
            self.status = "stale"
        elif self._last_raw_msc and raw_msc > self._last_raw_msc:
            raw_progress = raw_msc - self._last_raw_msc
            host_progress = host_msc - self._last_host_msc
            candidate = round((raw_msc - host_msc) / 900_000) * 15
            candidate_residual = raw_msc - candidate * 60_000 - host_msc
            if (abs(raw_progress - host_progress) <= CLOCK_FRESHNESS_TOLERANCE_MS
                    and -720 <= candidate <= 840
                    and abs(candidate_residual) <= CLOCK_FRESHNESS_TOLERANCE_MS):
                self.offset_minutes = candidate
                self.residual_ms = candidate_residual
                self.status = "verified"
                self._trusted = True
            else:
                self.status = "calibrating"
        else:
            self.status = "calibrating"
        self._last_raw_msc = raw_msc
        self._last_host_msc = host_msc
        if self._trusted:
            if self.status != "verified":
                self.status = "persisted_stale"
        elif residual < -CLOCK_FRESHNESS_TOLERANCE_MS:
            # A fresh install can start while the market is closed. MT5 then
            # returns the final quote from the previous session, so there is no
            # advancing sample from which to calibrate a broker offset. Keep
            # the default offset provisional and expose the stale read model;
            # never persist it as a trusted calibration. The server classifies
            # the old observed timestamp as a closed/stale market and therefore
            # keeps automated execution disabled.
            self.status = "provisional_stale"
        else:
            raise WorkerError("mt5_clock_unverified")
        self._save()
        return self.normalize(raw_msc)


class ReadOnlyMt5Adapter:
    def __init__(self, mt5: Any, terminal_path: str, route: WorkerRoute,
                 clock_msc: Any | None = None, clock_state_path: Path | None = None,
                 login_wait_seconds: float = TERMINAL_LOGIN_WAIT_SECONDS,
                 login_poll_seconds: float = TERMINAL_LOGIN_POLL_SECONDS):
        self.mt5 = mt5
        self.terminal_path = str(Path(terminal_path).resolve())
        self.route = route
        self.clock = BrokerClock(clock_state_path, clock_msc)
        self._resolved_symbols: dict[str, str] = {}
        self.login_wait_seconds = max(0.0, float(login_wait_seconds))
        self.login_poll_seconds = max(0.01, float(login_poll_seconds))

    def connect(self) -> None:
        if not Path(self.terminal_path).is_file():
            raise WorkerError("mt5_terminal_not_found")
        _require_terminal_running(self.terminal_path)
        if not self.mt5.initialize(path=self.terminal_path, timeout=10_000, portable=False):
            raise WorkerError("mt5_initialize_failed")
        self._wait_for_identity()

    def _wait_for_identity(self) -> tuple[Any, Any]:
        deadline = time.monotonic() + self.login_wait_seconds
        while True:
            try:
                return self._ensure_identity()
            except WorkerError as error:
                if (error.code not in TERMINAL_SESSION_FATAL_ERRORS
                        or time.monotonic() >= deadline):
                    raise
                time.sleep(self.login_poll_seconds)

    def shutdown(self) -> None:
        self.mt5.shutdown()

    def _ensure_identity(self) -> tuple[Any, Any]:
        account = self.mt5.account_info()
        if account is None:
            raise WorkerError("mt5_account_unavailable")
        if str(getattr(account, "login", "")) != self.route.login:
            raise WorkerError("mt5_login_mismatch")
        if str(getattr(account, "server", "")) != self.route.broker_server:
            raise WorkerError("mt5_broker_server_mismatch")
        terminal = self.mt5.terminal_info()
        if terminal is None or not bool(getattr(terminal, "connected", False)):
            raise WorkerError("mt5_terminal_disconnected")
        return account, terminal

    def collect_snapshot(self, streams: list[str]) -> dict[str, Any]:
        account, terminal = self._ensure_identity()
        result: dict[str, Any] = {}
        if "account" in streams:
            payload = _plain(account)
            if not isinstance(payload, dict):
                raise WorkerError("mt5_account_invalid")
            payload["terminal_trade_allowed"] = bool(getattr(terminal, "trade_allowed", False))
            payload["terminal_connected"] = bool(getattr(terminal, "connected", False))
            result["account"] = payload
        if "positions" in streams:
            result["positions"] = self._items(self.mt5.positions_get(), "mt5_positions_unavailable")
        if "orders" in streams:
            result["orders"] = self._items(self.mt5.orders_get(), "mt5_orders_unavailable")
        return {"source_time_msc": int(time.time() * 1000), "streams": result}

    def _items(self, values: Any, unavailable_code: str) -> list[dict[str, Any]]:
        if values is None:
            raise WorkerError(unavailable_code)
        if len(values) > MAX_SNAPSHOT_ITEMS:
            raise WorkerError("mt5_snapshot_too_large")
        items = _plain(values)
        if not isinstance(items, list) or any(
            not isinstance(item, dict) or int(item.get("ticket") or 0) <= 0 for item in items
        ):
            raise WorkerError("mt5_snapshot_items_invalid")
        return items

    def quote(self, requested_symbol: str) -> dict[str, Any]:
        self._ensure_identity()
        symbol = self._resolve_symbol(requested_symbol)
        tick = self.mt5.symbol_info_tick(symbol)
        if tick is None:
            raise WorkerError("symbol_tick_unavailable")
        info = self.mt5.symbol_info(symbol)
        terminal = self.mt5.terminal_info()
        if info is None or terminal is None:
            raise WorkerError("symbol_info_unavailable")
        bid = float(tick.bid)
        ask = float(tick.ask)
        last = float(getattr(tick, "last", 0.0) or 0.0)
        point = float(getattr(info, "point", 0.0) or 0.0)
        if (not all(math.isfinite(value) for value in (bid, ask, last, point))
                or bid <= 0 or ask < bid or last < 0 or point <= 0):
            raise WorkerError("symbol_tick_invalid")
        raw_msc = int(getattr(tick, "time_msc", 0) or 0)
        observed_at = self.clock.calibrate(raw_msc)
        return {
            "requested_symbol": requested_symbol,
            "symbol": symbol,
            "observed_at_utc_msc": observed_at,
            "raw_observed_at_msc": raw_msc,
            "bid": bid,
            "ask": ask,
            "last": last,
            "symbol_trade_mode": int(getattr(info, "trade_mode", -1)),
            "terminal_connected": bool(getattr(terminal, "connected", False)),
            "digits": int(getattr(info, "digits", 0)),
            "point": point,
            "timezone_offset_minutes": self.clock.offset_minutes,
            "clock_status": self.clock.status,
        }

    def history_sync(self, cursor: dict[str, Any], limit: int) -> dict[str, Any]:
        self._ensure_identity()
        try:
            cursor_time = int(cursor.get("time_msc"))
            cursor_ticket = int(cursor.get("ticket"))
            limit = int(limit)
        except (TypeError, ValueError) as error:
            raise WorkerError("worker_history_cursor_invalid") from error
        now_msc = int(time.time() * 1000)
        if (cursor_time <= 0 or cursor_time > now_msc or cursor_ticket < 0
                or limit < 1 or limit > MAX_HISTORY_BATCH_ITEMS):
            raise WorkerError("worker_history_cursor_invalid")
        window_end = min(cursor_time + HISTORY_WINDOW_MSC, now_msc)
        if window_end <= cursor_time:
            return self._history_batch([], cursor_time, cursor_ticket, False, now_msc)
        date_from = datetime.fromtimestamp(max(0, cursor_time - 1_000) / 1000,
                                           tz=timezone.utc)
        date_to = datetime.fromtimestamp((window_end + 999) / 1000, tz=timezone.utc)
        raw_deals = self.mt5.history_deals_get(date_from, date_to)
        if raw_deals is None:
            raise WorkerError("mt5_history_deals_unavailable")
        rows: list[tuple[int, int, dict[str, Any]]] = []
        for value in raw_deals:
            raw = _plain(value)
            if not isinstance(raw, dict):
                raise WorkerError("mt5_history_deal_invalid")
            try:
                ticket = int(raw.get("ticket") or 0)
                event_msc = int(raw.get("time_msc") or int(raw.get("time") or 0) * 1000)
            except (TypeError, ValueError) as error:
                raise WorkerError("mt5_history_deal_invalid") from error
            if ticket <= 0 or event_msc <= 0:
                raise WorkerError("mt5_history_deal_invalid")
            if (event_msc, ticket) > (cursor_time, cursor_ticket) and event_msc <= window_end:
                rows.append((event_msc, ticket, raw))
        rows.sort(key=lambda item: (item[0], item[1]))
        selected = rows[:limit]
        if len(rows) > limit:
            next_time, next_ticket = selected[-1][0], selected[-1][1]
            has_more = True
        else:
            next_time = window_end
            next_ticket = selected[-1][1] if selected and selected[-1][0] == window_end else 0
            has_more = window_end < now_msc
        return self._history_batch(
            [item[2] for item in selected], next_time, next_ticket, has_more, now_msc)

    def data(self, action: str, params: dict[str, Any]) -> dict[str, Any]:
        self._ensure_identity()
        if action == "rates":
            return self._rates(params)
        if action == "symbol_snapshot":
            return self._symbol_snapshot(params)
        if action == "risk_snapshot":
            return self._risk_snapshot(params)
        if action == "performance_daily":
            return self._performance_daily(params)
        if action == "pending_order_state":
            return self._pending_order_state(params)
        if action == "diagnostics":
            if params:
                raise WorkerError("worker_data_params_invalid")
            return self._diagnostics()
        if action == "symbols":
            if params:
                raise WorkerError("worker_data_params_invalid")
            return self._symbols()
        raise WorkerError("worker_data_action_invalid")

    def _rates(self, params: dict[str, Any]) -> dict[str, Any]:
        allowed = {"symbol", "timeframe", "count", "start_utc_msc", "end_utc_msc"}
        if set(params) - allowed:
            raise WorkerError("worker_rates_params_invalid")
        symbol = self._resolve_symbol(params.get("symbol"))
        timeframe = str(params.get("timeframe") or "").strip().upper()
        try:
            count = int(params.get("count"))
            start_utc_msc = int(params.get("start_utc_msc") or 0)
            end_utc_msc = int(params.get("end_utc_msc") or 0)
        except (TypeError, ValueError) as error:
            raise WorkerError("worker_rates_params_invalid") from error
        if (timeframe not in RATE_TIMEFRAMES or count < 2 or count > 5_000
                or start_utc_msc < 0 or end_utc_msc < 0
                or ((start_utc_msc or end_utc_msc)
                    and not (start_utc_msc > 0 and end_utc_msc > start_utc_msc))):
            raise WorkerError("worker_rates_params_invalid")
        tick = self.mt5.symbol_info_tick(symbol)
        if tick is None:
            raise WorkerError("symbol_tick_unavailable")
        self.clock.calibrate(int(getattr(tick, "time_msc", 0) or 0))
        timeframe_value = getattr(self.mt5, f"TIMEFRAME_{timeframe}", None)
        if timeframe_value is None:
            raise WorkerError("rates_timeframe_unavailable")
        range_complete = bool(start_utc_msc and end_utc_msc)
        if range_complete:
            raw_start_msc = self.clock.server_from_utc(start_utc_msc)
            raw_end_msc = self.clock.server_from_utc(end_utc_msc)
            rates = self.mt5.copy_rates_range(
                symbol,
                timeframe_value,
                datetime.fromtimestamp(raw_start_msc / 1000.0, timezone.utc),
                datetime.fromtimestamp(raw_end_msc / 1000.0, timezone.utc),
            )
            if rates is not None and len(rates) > count:
                rates = rates[-count:]
        else:
            rates = self.mt5.copy_rates_from_pos(symbol, timeframe_value, 0, count)
        if rates is None:
            raise WorkerError("rates_unavailable")
        captured_at = self.clock.now_utc_msc()
        output: list[dict[str, Any]] = []
        for rate in rates:
            server_msc = int(rate[0]) * 1000
            utc_msc = self.clock.normalize(server_msc)
            if utc_msc > captured_at + CLOCK_FRESHNESS_TOLERANCE_MS:
                continue
            output.append({
                "time": datetime.fromtimestamp(server_msc / 1000.0, timezone.utc).strftime(
                    "%Y-%m-%d %H:%M:%S"),
                "time_msc": server_msc,
                "time_server_msc": server_msc,
                "time_utc_msc": utc_msc,
                "open": float(rate[1]),
                "high": float(rate[2]),
                "low": float(rate[3]),
                "close": float(rate[4]),
                "tick_volume": int(rate[5]),
                "spread": int(rate[6]) if len(rate) > 6 else 0,
                "captured_at_utc_msc": captured_at,
                "timezone_offset_minutes": self.clock.offset_minutes,
                "clock_status": self.clock.status,
            })
        if len(rates) and not output:
            raise WorkerError("rates_future_timestamp_invalid")
        return {
            "symbol": symbol,
            "timeframe": timeframe,
            "count": len(output),
            "rates": output,
            "source": "mt5",
            "range_complete": range_complete,
            "range_start_utc_msc": start_utc_msc or None,
            "range_end_utc_msc": end_utc_msc or None,
            "timezone_offset_minutes": self.clock.offset_minutes,
            "clock_status": self.clock.status,
        }

    def _symbol_snapshot(self, params: dict[str, Any]) -> dict[str, Any]:
        if set(params) != {"symbol"}:
            raise WorkerError("worker_symbol_snapshot_params_invalid")
        symbol = self._resolve_symbol(params.get("symbol"))
        info = self.mt5.symbol_info(symbol)
        account = self.mt5.account_info()
        tick = self.mt5.symbol_info_tick(symbol)
        if info is None:
            raise WorkerError("symbol_info_unavailable")
        if account is None:
            raise WorkerError("mt5_account_unavailable")
        buy_price = float(getattr(tick, "ask", 0.0) or 0.0) if tick else 0.0
        sell_price = float(getattr(tick, "bid", 0.0) or 0.0) if tick else 0.0
        minimum = float(getattr(info, "volume_min", 0.0) or 0.0)
        maximum = float(getattr(info, "volume_max", 0.0) or 0.0)
        step = float(getattr(info, "volume_step", 0.0) or 0.0)
        probe = max(minimum, min(1.0, maximum)) if maximum > 0 else 1.0
        if step > 0:
            probe = max(minimum, min(round(probe / step) * step, maximum))

        def margin_per_lot(order_type: int, price: float) -> float | None:
            calculator = getattr(self.mt5, "order_calc_margin", None)
            if not callable(calculator) or price <= 0 or probe <= 0:
                return None
            try:
                value = calculator(order_type, symbol, probe, price)
                return float(value) / probe if value is not None and float(value) >= 0 else None
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
            "margin_per_lot_buy": margin_per_lot(self.mt5.ORDER_TYPE_BUY, buy_price),
            "margin_per_lot_sell": margin_per_lot(self.mt5.ORDER_TYPE_SELL, sell_price),
            "margin_reference_price_buy": buy_price if buy_price > 0 else None,
            "margin_reference_price_sell": sell_price if sell_price > 0 else None,
            "margin_profile_currency": str(getattr(account, "currency", "") or ""),
            "margin_profile_volume": probe,
            "volume_min": minimum,
            "volume_max": maximum,
            "volume_step": step,
            "volume_limit": float(getattr(info, "volume_limit", 0.0) or 0.0),
            "swap_mode": int(getattr(info, "swap_mode", 0) or 0),
            "swap_rollover3days": int(getattr(info, "swap_rollover3days", 0) or 0),
            "swap_long": float(getattr(info, "swap_long", 0.0) or 0.0),
            "swap_short": float(getattr(info, "swap_short", 0.0) or 0.0),
            "currency_base": str(getattr(info, "currency_base", "") or ""),
            "currency_profit": str(getattr(info, "currency_profit", "") or ""),
            "currency_margin": str(getattr(info, "currency_margin", "") or ""),
        }
        for day in ("sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"):
            value = getattr(info, f"swap_{day}", None)
            instrument[f"swap_{day}"] = float(value) if value is not None else None
        return {
            "symbol": symbol,
            "source": "mt5",
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

    def _diagnostics(self) -> dict[str, Any]:
        account, terminal = self._ensure_identity()
        return {
            "mt5_connected": bool(getattr(terminal, "connected", False)),
            "account": {
                "login": getattr(account, "login", None),
                "server": getattr(account, "server", None),
                "balance": float(getattr(account, "balance", 0.0) or 0.0),
                "equity": float(getattr(account, "equity", 0.0) or 0.0),
                "trade_allowed": bool(getattr(account, "trade_allowed", False)),
                "trade_expert": bool(getattr(account, "trade_expert", False)),
            },
            "terminal": {
                "build": int(getattr(terminal, "build", 0) or 0),
                "connected": bool(getattr(terminal, "connected", False)),
                "trade_allowed": bool(getattr(terminal, "trade_allowed", False)),
            },
            "source": "mt5",
        }

    def _pending_order_state(self, params: dict[str, Any]) -> dict[str, Any]:
        if set(params) - {"ticket", "expected_state"}:
            raise WorkerError("worker_pending_order_state_params_invalid")
        try:
            ticket = int(str(params.get("ticket") or ""))
        except (TypeError, ValueError) as error:
            raise WorkerError("ticket_required") from error
        if ticket <= 0:
            raise WorkerError("ticket_required")
        account = self.mt5.account_info()
        if account is None:
            raise WorkerError("mt5_account_unavailable")
        expected = params.get("expected_state")
        if expected is not None and not isinstance(expected, dict):
            raise WorkerError("management_expected_state_invalid")
        current = self.mt5.orders_get(ticket=ticket)
        if current is None:
            raise WorkerError("orders_query_failed")
        account_row = {"login": getattr(account, "login", None), "server": getattr(account, "server", None)}
        if current:
            order = current[0]
            row = self._pending_order_row(order)
            error = self._expected_order_error(expected, order) if expected else None
            return {"account": account_row, "current_state": "identity_changed" if error else "pending",
                    "final_state": "unknown" if error else None, "order": row,
                    **({"precondition_error": error} if error else {}), "source": "mt5"}
        history = self.mt5.history_orders_get(ticket=ticket)
        if history is None:
            raise WorkerError("history_orders_query_failed")
        if not history:
            return {"account": account_row, "current_state": "absent", "final_state": "unknown",
                    "order": None, "source": "mt5"}
        order = history[-1]
        row = self._pending_order_row(order)
        error = self._expected_order_error(expected, order) if expected else None
        states = {
            int(getattr(self.mt5, "ORDER_STATE_FILLED", 4)): "filled",
            int(getattr(self.mt5, "ORDER_STATE_PARTIAL", 3)): "partially_filled",
            int(getattr(self.mt5, "ORDER_STATE_CANCELED", 2)): "cancelled",
            int(getattr(self.mt5, "ORDER_STATE_EXPIRED", 6)): "expired",
            int(getattr(self.mt5, "ORDER_STATE_REJECTED", 5)): "rejected",
        }
        return {"account": account_row, "current_state": "history",
                "final_state": "unknown" if error else states.get(int(getattr(order, "state", -1)), "unknown"),
                "position_id": row.get("position_id"), "order": row,
                **({"precondition_error": error} if error else {}), "source": "mt5"}

    def _pending_order_row(self, order: Any) -> dict[str, Any]:
        buy_types = {int(self.mt5.ORDER_TYPE_BUY_LIMIT), int(self.mt5.ORDER_TYPE_BUY_STOP),
                     int(self.mt5.ORDER_TYPE_BUY_STOP_LIMIT)}
        order_type = int(getattr(order, "type", -1))
        return {"ticket": getattr(order, "ticket", None),
                "position_id": getattr(order, "position_id", 0) or None,
                "symbol": str(getattr(order, "symbol", "") or ""),
                "side": "buy" if order_type in buy_types else "sell",
                "type": order_type, "state": int(getattr(order, "state", -1)),
                "volume_initial": float(getattr(order, "volume_initial", 0.0) or 0.0),
                "volume": float(getattr(order, "volume_current", 0.0) or 0.0),
                "price": float(getattr(order, "price_open", 0.0) or 0.0),
                "magic": int(getattr(order, "magic", 0) or 0),
                "comment": str(getattr(order, "comment", "") or "")}

    def _expected_order_error(self, expected: dict[str, Any], order: Any) -> str | None:
        checks = (("ticket", str(getattr(order, "ticket", "")), "management_ticket_mismatch"),
                  ("symbol", str(getattr(order, "symbol", "")), "management_symbol_mismatch"),
                  ("magic", int(getattr(order, "magic", 0) or 0), "management_magic_mismatch"))
        for key, actual, code in checks:
            if key not in expected or str(expected[key]) != str(actual):
                return code
        actual_volume = float(getattr(order, "volume_current", 0.0)
                              or getattr(order, "volume_initial", 0.0) or 0.0)
        if "volume" not in expected or abs(float(expected["volume"]) - actual_volume) > 1e-8:
            return "management_volume_mismatch"
        buy_types = {int(self.mt5.ORDER_TYPE_BUY_LIMIT), int(self.mt5.ORDER_TYPE_BUY_STOP),
                     int(self.mt5.ORDER_TYPE_BUY_STOP_LIMIT)}
        direction = "buy" if int(getattr(order, "type", -1)) in buy_types else "sell"
        if str(expected.get("direction") or "").lower() != direction:
            return "management_direction_mismatch"
        if expected.get("broker_server_key") and str(expected["broker_server_key"]).upper() != self.route.broker_server.upper():
            return "management_account_server_mismatch"
        if expected.get("login_account") and str(expected["login_account"]) != self.route.login:
            return "management_account_login_mismatch"
        return None

    def _performance_daily(self, params: dict[str, Any]) -> dict[str, Any]:
        if set(params) != {"date_from", "date_to"}:
            raise WorkerError("worker_performance_daily_params_invalid")
        try:
            start_date = datetime.strptime(str(params["date_from"]), "%Y-%m-%d")
            end_date = datetime.strptime(str(params["date_to"]), "%Y-%m-%d")
        except (TypeError, ValueError) as error:
            raise WorkerError("performance_date_range_required") from error
        if end_date < start_date:
            raise WorkerError("performance_date_range_invalid")
        if (end_date - start_date).days > 30:
            raise WorkerError("performance_date_range_too_large")
        account = self.mt5.account_info()
        if account is None:
            raise WorkerError("performance_account_unavailable")
        deals = self.mt5.history_deals_get(
            (start_date - timedelta(days=1)).replace(tzinfo=timezone.utc),
            (end_date + timedelta(days=2)).replace(tzinfo=timezone.utc),
        )
        if deals is None:
            raise WorkerError("performance_history_unavailable")
        trade_types = {int(getattr(self.mt5, "DEAL_TYPE_BUY", 0)),
                       int(getattr(self.mt5, "DEAL_TYPE_SELL", 1))}
        balance_type = int(getattr(self.mt5, "DEAL_TYPE_BALANCE", 2))
        credit_type = int(getattr(self.mt5, "DEAL_TYPE_CREDIT", 3))
        other_capital = {int(getattr(self.mt5, name, value)) for name, value in
                         (("DEAL_TYPE_CORRECTION", 5), ("DEAL_TYPE_BONUS", 6))}
        adjustments = {int(getattr(self.mt5, name, value)) for name, value in (
            ("DEAL_TYPE_CHARGE", 4), ("DEAL_TYPE_COMMISSION", 7),
            ("DEAL_TYPE_COMMISSION_DAILY", 8), ("DEAL_TYPE_COMMISSION_MONTHLY", 9),
            ("DEAL_TYPE_COMMISSION_AGENT_DAILY", 10),
            ("DEAL_TYPE_COMMISSION_AGENT_MONTHLY", 11), ("DEAL_TYPE_INTEREST", 12),
            ("DEAL_TYPE_DIVIDEND", 15), ("DEAL_TYPE_DIVIDEND_FRANKED", 16),
            ("DEAL_TYPE_TAX", 17))}
        exits = {int(getattr(self.mt5, name, value)) for name, value in (
            ("DEAL_ENTRY_OUT", 1), ("DEAL_ENTRY_INOUT", 2), ("DEAL_ENTRY_OUT_BY", 3))}

        def empty_day(day: str) -> dict[str, Any]:
            return {"business_date": day, "trade_profit": 0.0, "commission": 0.0,
                    "swap": 0.0, "fee": 0.0, "pnl_adjustment": 0.0,
                    "realized_net": 0.0, "deposit": 0.0, "withdrawal": 0.0,
                    "credit_change": 0.0, "other_capital_change": 0.0,
                    "exit_deal_count": 0, "closed_position_count": 0,
                    "winning_exit_count": 0, "losing_exit_count": 0,
                    "closed_volume": 0.0, "first_deal_time_msc": 0,
                    "last_deal_time_msc": 0, "last_deal_ticket": 0,
                    "data_complete": True, "data_issues": [], "_positions": set()}

        start_text, end_text = start_date.strftime("%Y-%m-%d"), end_date.strftime("%Y-%m-%d")
        daily: dict[str, dict[str, Any]] = {}
        for item in deals:
            raw = _plain(item)
            if not isinstance(raw, dict):
                raise WorkerError("performance_history_invalid")
            event_ms = int(raw.get("time_msc") or int(raw.get("time") or 0) * 1000)
            day = datetime.fromtimestamp(event_ms / 1000.0, timezone.utc).strftime("%Y-%m-%d")
            if not start_text <= day <= end_text:
                continue
            row = daily.setdefault(day, empty_day(day))
            ticket = int(raw.get("ticket") or 0)
            if not row["first_deal_time_msc"] or event_ms < row["first_deal_time_msc"]:
                row["first_deal_time_msc"] = event_ms
            if (event_ms, ticket) > (row["last_deal_time_msc"], row["last_deal_ticket"]):
                row["last_deal_time_msc"], row["last_deal_ticket"] = event_ms, ticket
            deal_type = int(raw.get("type") if raw.get("type") is not None else -1)
            values = {key: float(raw.get(key) or 0.0) for key in ("profit", "commission", "swap", "fee")}
            net = sum(values.values())
            if deal_type in trade_types:
                for key in ("trade_profit", "commission", "swap", "fee"):
                    row[key] += values["profit" if key == "trade_profit" else key]
                row["realized_net"] += net
                if int(raw.get("entry") if raw.get("entry") is not None else -1) in exits:
                    row["exit_deal_count"] += 1
                    row["closed_volume"] += float(raw.get("volume") or 0.0)
                    if int(raw.get("position_id") or 0):
                        row["_positions"].add(int(raw["position_id"]))
                    row["winning_exit_count" if net > 0 else "losing_exit_count" if net < 0 else "exit_deal_count"] += int(net != 0)
            elif deal_type == balance_type:
                row["deposit" if net >= 0 else "withdrawal"] += abs(net)
            elif deal_type == credit_type:
                row["credit_change"] += net
            elif deal_type in other_capital:
                row["other_capital_change"] += net
            elif deal_type in adjustments:
                row["pnl_adjustment"] += net
                row["realized_net"] += net
            else:
                row["data_complete"] = False
                row["data_issues"].append(f"unknown_deal_type:{deal_type}")
        numeric = ("trade_profit", "commission", "swap", "fee", "pnl_adjustment",
                   "realized_net", "deposit", "withdrawal", "credit_change",
                   "other_capital_change", "closed_volume")
        rows = []
        for day in sorted(daily):
            row = daily[day]
            row["closed_position_count"] = len(row.pop("_positions"))
            row["data_issues"] = sorted(set(row["data_issues"]))
            for field in numeric:
                row[field] = round(float(row[field]), 8)
            digest = json.dumps(row, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
            row["source_hash"] = hashlib.sha256(digest.encode("utf-8")).hexdigest()
            rows.append(row)
        return {"performance_version": 1, "date_from": start_text, "date_to": end_text,
                "timezone_offset_minutes": 0, "clock_status": "utc_direct",
                "account": {"login": int(account.login), "server": str(account.server),
                            "currency": str(getattr(account, "currency", "") or "")},
                "daily": rows, "scanned_deal_count": len(deals), "source": "mt5"}

    def _risk_snapshot(self, params: dict[str, Any]) -> dict[str, Any]:
        allowed = {"symbol", "last_deal_time_msc", "last_deal_ticket",
                   "baseline_from_utc_msc", "proposed_order"}
        if set(params) - allowed:
            raise WorkerError("worker_risk_snapshot_params_invalid")
        symbol = self._resolve_symbol(params.get("symbol"))
        try:
            requested_ms = int(params.get("last_deal_time_msc") or 0)
            requested_ticket = int(params.get("last_deal_ticket") or 0)
            baseline_ms = int(params.get("baseline_from_utc_msc") or 0)
        except (TypeError, ValueError) as error:
            raise WorkerError("risk_snapshot_cursor_invalid") from error
        if min(requested_ms, requested_ticket, baseline_ms) < 0:
            raise WorkerError("risk_snapshot_cursor_invalid")
        account = self.mt5.account_info()
        positions, pending = self.mt5.positions_get(), self.mt5.orders_get()
        if account is None:
            raise WorkerError("risk_snapshot_account_unavailable")
        if positions is None:
            raise WorkerError("risk_snapshot_positions_unavailable")
        if pending is None:
            raise WorkerError("risk_snapshot_orders_unavailable")
        position_rows = [{"ticket": int(item.ticket),
                          "identifier": int(getattr(item, "identifier", item.ticket) or item.ticket),
                          "symbol": str(item.symbol),
                          "type": "buy" if int(item.type) == int(getattr(self.mt5, "POSITION_TYPE_BUY", 0)) else "sell",
                          "volume": float(item.volume), "price_open": float(getattr(item, "price_open", 0.0) or 0.0),
                          "price_current": float(getattr(item, "price_current", 0.0) or 0.0),
                          "profit": float(getattr(item, "profit", 0.0) or 0.0),
                          "swap": float(getattr(item, "swap", 0.0) or 0.0)} for item in positions]
        pending_names = {int(getattr(self.mt5, "ORDER_TYPE_BUY_LIMIT", 2)): "buy_limit",
                         int(getattr(self.mt5, "ORDER_TYPE_SELL_LIMIT", 3)): "sell_limit",
                         int(getattr(self.mt5, "ORDER_TYPE_BUY_STOP", 4)): "buy_stop",
                         int(getattr(self.mt5, "ORDER_TYPE_SELL_STOP", 5)): "sell_stop",
                         int(getattr(self.mt5, "ORDER_TYPE_BUY_STOP_LIMIT", 6)): "buy_stop_limit",
                         int(getattr(self.mt5, "ORDER_TYPE_SELL_STOP_LIMIT", 7)): "sell_stop_limit"}
        pending_rows = [{"ticket": int(item.ticket), "symbol": str(item.symbol),
                         "type": pending_names.get(int(item.type), str(item.type)),
                         "volume": float(getattr(item, "volume_current", 0.0)
                                         or getattr(item, "volume_initial", 0.0) or 0.0),
                         "volume_current": float(getattr(item, "volume_current", 0.0) or 0.0),
                         "volume_initial": float(getattr(item, "volume_initial", 0.0) or 0.0),
                         "price": float(getattr(item, "price_open", 0.0) or 0.0)} for item in pending]
        raw_start = requested_ms or baseline_ms or self.clock.now_utc_msc()
        deals = self.mt5.history_deals_get(
            datetime.fromtimestamp(max(0, raw_start - 300_000) / 1000.0, timezone.utc),
            datetime.now(timezone.utc) + timedelta(days=1))
        if deals is None:
            raise WorkerError("risk_snapshot_deals_unavailable")
        deal_rows = [_plain(item) for item in deals]
        if not all(isinstance(item, dict) for item in deal_rows):
            raise WorkerError("risk_snapshot_deals_invalid")
        deal_rows.sort(key=lambda item: (int(item.get("time_msc") or int(item.get("time") or 0) * 1000),
                                         int(item.get("ticket") or 0)))
        cursor = (requested_ms or raw_start, requested_ticket)
        new_deals = [item for item in deal_rows if
                     (int(item.get("time_msc") or int(item.get("time") or 0) * 1000),
                      int(item.get("ticket") or 0)) > cursor]
        trade_types = {int(getattr(self.mt5, "DEAL_TYPE_BUY", 0)), int(getattr(self.mt5, "DEAL_TYPE_SELL", 1))}
        exits = {int(getattr(self.mt5, name, value)) for name, value in
                 (("DEAL_ENTRY_OUT", 1), ("DEAL_ENTRY_INOUT", 2), ("DEAL_ENTRY_OUT_BY", 3))}
        active_ids = {int(getattr(item, "identifier", item.ticket) or item.ticket) for item in positions}
        closed, issues, seen = [], [], set()
        for deal in new_deals:
            if int(deal.get("type", -1)) not in trade_types or int(deal.get("entry", -1)) not in exits:
                continue
            position_id = int(deal.get("position_id") or 0)
            if not position_id or position_id in active_ids or position_id in seen:
                continue
            seen.add(position_id)
            group = self.mt5.history_deals_get(position=position_id)
            if group is None:
                issues.append("position_history_unavailable")
                continue
            net = sum(sum(float(getattr(item, key, 0.0) or 0.0)
                          for key in ("profit", "commission", "swap", "fee")) for item in group)
            close_ms = int(deal.get("time_msc") or int(deal.get("time") or 0) * 1000)
            closed.append({"position_id": position_id, "close_time_msc": close_ms,
                           "close_time_utc_msc": close_ms, "close_deal_ticket": int(deal.get("ticket") or 0),
                           "business_date": datetime.fromtimestamp(close_ms / 1000.0, timezone.utc).strftime("%Y-%m-%d"),
                           "net": round(net, 8)})
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
        account_events = []
        for deal in new_deals:
            deal_type = int(deal.get("type", -1))
            if deal_type in trade_types:
                continue
            amount = sum(float(deal.get(key) or 0.0)
                         for key in ("profit", "commission", "swap", "fee"))
            event_ms = int(deal.get("time_msc") or int(deal.get("time") or 0) * 1000)
            if deal_type in capital_types:
                category = "capital"
            elif deal_type in adjustment_types:
                category = "pnl_adjustment"
            else:
                category = "unknown"
                issues.append(f"unknown_deal_type:{deal_type}")
            account_events.append({"ticket": int(deal.get("ticket") or 0),
                                   "time_msc": event_ms,
                                   "business_date": datetime.fromtimestamp(
                                       event_ms / 1000.0, timezone.utc).strftime("%Y-%m-%d"),
                                   "deal_type": deal_type, "category": category,
                                   "amount": round(amount, 8)})
        relevant = {row["symbol"] for row in position_rows + pending_rows if row.get("symbol")} | {symbol}
        instruments = {}
        for name in relevant:
            info = self.mt5.symbol_info(name)
            if info is None:
                issues.append(f"symbol_info_unavailable:{name}")
                continue
            instruments[name] = {"name": str(getattr(info, "name", name) or name),
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
                                 "currency_margin": str(getattr(info, "currency_margin", "") or "")}
        broker_calculation, warnings = None, []
        proposed = params.get("proposed_order")
        if proposed:
            try:
                side = str(proposed.get("order_type") or "").lower()
                order_type = self.mt5.ORDER_TYPE_BUY if side.startswith("buy") else self.mt5.ORDER_TYPE_SELL
                values = {key: float(proposed.get(key) or 0.0) for key in ("volume", "entry_price", "sl")}
                loss = self.mt5.order_calc_profit(order_type, str(proposed["symbol"]), values["volume"], values["entry_price"], values["sl"])
                margin = self.mt5.order_calc_margin(order_type, str(proposed["symbol"]), values["volume"], values["entry_price"])
                if loss is not None and margin is not None:
                    broker_calculation = {"symbol": str(proposed["symbol"]), "order_type": side,
                                          **values, "loss_to_sl": round(abs(float(loss)), 8),
                                          "required_margin": round(float(margin), 8)}
            except (AttributeError, KeyError, TypeError, ValueError, RuntimeError) as error:
                warnings.append(f"broker_calculation_unavailable:{type(error).__name__}")
        through = cursor if not new_deals else (
            int(new_deals[-1].get("time_msc") or int(new_deals[-1].get("time") or 0) * 1000),
            int(new_deals[-1].get("ticket") or 0))
        tick = self.mt5.symbol_info_tick(symbol)
        if tick is None:
            raise WorkerError("symbol_tick_unavailable")
        raw_observed = int(getattr(tick, "time_msc", 0) or 0)
        observed = self.clock.calibrate(raw_observed)
        return {"snapshot_version": 1, "source": "mt5", "complete": not issues,
                "incomplete_reasons": sorted(set(issues)), "warnings": sorted(set(warnings)),
                "business_date": datetime.fromtimestamp(observed / 1000.0, timezone.utc).strftime("%Y-%m-%d"),
                "mt5_time_msc": raw_observed, "time_msc": raw_observed, "time_utc_msc": observed,
                "timezone_offset_minutes": self.clock.offset_minutes, "clock_status": self.clock.status,
                "clock_residual_ms": self.clock.residual_ms, "captured_at_utc_msc": self.clock.now_utc_msc(),
                "account": {"login": int(account.login), "server": str(account.server),
                            "currency": str(getattr(account, "currency", "") or ""),
                            **{key: float(getattr(account, key, 0.0) or 0.0) for key in
                               ("balance", "equity", "credit", "profit", "margin", "margin_free", "margin_level")},
                            "leverage": int(getattr(account, "leverage", 0) or 0),
                            "margin_mode": int(getattr(account, "margin_mode", 0) or 0),
                            "margin_so_mode": int(getattr(account, "margin_so_mode", 0) or 0),
                            "margin_so_call": float(getattr(account, "margin_so_call", 0.0) or 0.0),
                            "margin_so_so": float(getattr(account, "margin_so_so", 0.0) or 0.0)},
                "positions": position_rows, "pending": pending_rows, "instruments": instruments,
                "increment": {"requested_cursor": {"time_msc": requested_ms, "ticket": requested_ticket},
                              "through_cursor": {"time_msc": through[0], "ticket": through[1]},
                              "closed_positions": closed, "account_events": account_events,
                              "scanned_deal_count": len(deal_rows), "new_deal_count": len(new_deals)},
                "broker_calculation": broker_calculation}

    def _symbols(self) -> dict[str, Any]:
        values = self.mt5.symbols_get()
        if values is None:
            raise WorkerError("mt5_symbols_unavailable")
        if len(values) > MAX_SYMBOL_ITEMS:
            raise WorkerError("mt5_symbols_too_large")
        rows = []
        for value in values:
            name = str(getattr(value, "name", "") or "").strip()
            if not name:
                continue
            rows.append({
                "name": name,
                "description": str(getattr(value, "description", "") or ""),
                "digits": int(getattr(value, "digits", 0) or 0),
                "trade_mode": int(getattr(value, "trade_mode", 0) or 0),
                "point": float(getattr(value, "point", 0.0) or 0.0),
                "tick_size": float(getattr(value, "trade_tick_size", 0.0) or 0.0),
                "tick_value": float(getattr(value, "trade_tick_value", 0.0) or 0.0),
                "contract_size": float(getattr(value, "trade_contract_size", 0.0) or 0.0),
                "volume_min": float(getattr(value, "volume_min", 0.0) or 0.0),
                "volume_max": float(getattr(value, "volume_max", 0.0) or 0.0),
                "volume_step": float(getattr(value, "volume_step", 0.0) or 0.0),
            })
        rows.sort(key=lambda item: item["name"].upper())
        return {"symbols": rows, "count": len(rows), "source": "mt5"}

    def _history_batch(self, raw_deals: list[dict[str, Any]], next_time: int,
                       next_ticket: int, has_more: bool, observed_at: int) -> dict[str, Any]:
        deals: list[dict[str, Any]] = []
        history_orders: list[dict[str, Any]] = []
        trades: list[dict[str, Any]] = []
        orders_by_ticket: dict[int, dict[str, Any]] = {}
        position_deals: dict[int, list[dict[str, Any]]] = {}
        entry_in = int(getattr(self.mt5, "DEAL_ENTRY_IN", 0))
        exit_entries = {
            int(getattr(self.mt5, "DEAL_ENTRY_OUT", 1)),
            int(getattr(self.mt5, "DEAL_ENTRY_INOUT", 2)),
            int(getattr(self.mt5, "DEAL_ENTRY_OUT_BY", 3)),
        }
        buy_type = int(getattr(self.mt5, "DEAL_TYPE_BUY", 0))
        for raw in raw_deals:
            deals.append(self._history_deal_row(raw))
            try:
                entry = int(raw.get("entry") if raw.get("entry") is not None else -1)
                position_id = int(raw.get("position_id") or 0)
                order_ticket = int(raw.get("order") or 0)
            except (TypeError, ValueError) as error:
                raise WorkerError("mt5_history_item_invalid") from error
            if order_ticket > 0 and order_ticket not in orders_by_ticket:
                values = self.mt5.history_orders_get(ticket=order_ticket)
                if values is None:
                    raise WorkerError("mt5_history_orders_unavailable")
                if values:
                    order = self._history_order_row(_plain(values[-1]))
                    orders_by_ticket[order_ticket] = order
                    history_orders.append(order)
            if entry not in exit_entries:
                continue
            if position_id > 0 and position_id not in position_deals:
                values = self.mt5.history_deals_get(position=position_id)
                if values is None:
                    raise WorkerError("mt5_history_deals_unavailable")
                position_deals[position_id] = [_plain(value) for value in values]
            group = position_deals.get(position_id, [])
            origin = next((value for value in group
                           if isinstance(value, dict)
                           and int(value.get("entry") if value.get("entry") is not None else -1)
                           == entry_in), raw)
            trades.append({
                "ticket": origin.get("order") or position_id or raw.get("ticket"),
                "deal_ticket": raw.get("ticket"),
                "order": origin.get("order") or order_ticket or position_id,
                "order_ticket": order_ticket or origin.get("order") or position_id,
                "position_id": position_id or raw.get("order") or raw.get("ticket"),
                "symbol": raw.get("symbol") or origin.get("symbol") or "",
                "type": "BUY" if int(origin.get("type") or 0) == buy_type else "SELL",
                "volume": float(raw.get("volume") or 0.0),
                "entry_price": float(origin.get("price") or 0.0),
                "exit_price": float(raw.get("price") or 0.0),
                "price": float(raw.get("price") or 0.0),
                "profit": float(raw.get("profit") or 0.0),
                "swap": float(raw.get("swap") or 0.0),
                "commission": float(raw.get("commission") or 0.0),
                "fee": float(raw.get("fee") or 0.0),
                "net_profit": sum(float(raw.get(key) or 0.0)
                                  for key in ("profit", "swap", "commission", "fee")),
                "entry_time": self._history_time(origin.get("time")),
                "close_time": self._history_time(raw.get("time")),
                "close_time_msc": int(raw.get("time_msc") or int(raw.get("time") or 0) * 1000),
                "time": self._history_time(raw.get("time")),
                "time_msc": int(raw.get("time_msc") or int(raw.get("time") or 0) * 1000),
                "comment": str(raw.get("comment") or ""),
                "take_profit": float(orders_by_ticket.get(order_ticket, {}).get("tp") or 0.0),
                "stop_loss": float(orders_by_ticket.get(order_ticket, {}).get("sl") or 0.0),
            })
        return {
            "deals": deals,
            "history_orders": history_orders,
            "trades": trades,
            "next_cursor": {"time_msc": next_time, "ticket": str(next_ticket)},
            "has_more": has_more,
            "observed_at_utc_msc": observed_at,
        }

    @staticmethod
    def _history_time(value: Any) -> str:
        try:
            return datetime.fromtimestamp(int(value or 0), tz=timezone.utc).isoformat().replace(
                "+00:00", "Z")
        except (OSError, OverflowError, TypeError, ValueError) as error:
            raise WorkerError("mt5_history_time_invalid") from error

    def _history_deal_row(self, row: dict[str, Any]) -> dict[str, Any]:
        return {
            "deal_ticket": row.get("ticket"), "ticket": row.get("ticket"),
            "order": row.get("order"), "order_ticket": row.get("order"),
            "position_id": row.get("position_id"), "symbol": row.get("symbol"),
            "type": row.get("type"), "entry": row.get("entry"), "magic": row.get("magic"),
            "reason": row.get("reason"), "comment": row.get("comment"),
            "volume": row.get("volume"), "price": row.get("price"),
            "profit": row.get("profit"), "commission": row.get("commission"),
            "swap": row.get("swap"), "fee": row.get("fee"), "sl": row.get("sl"),
            "tp": row.get("tp"), "time": self._history_time(row.get("time")),
            "time_msc": int(row.get("time_msc") or int(row.get("time") or 0) * 1000),
        }

    def _history_order_row(self, row: Any) -> dict[str, Any]:
        if not isinstance(row, dict):
            raise WorkerError("mt5_history_order_invalid")
        return {
            "ticket": row.get("ticket"), "order": row.get("ticket"),
            "order_ticket": row.get("ticket"), "position_id": row.get("position_id"),
            "symbol": row.get("symbol"), "type": row.get("type"), "state": row.get("state"),
            "magic": row.get("magic"), "reason": row.get("reason"),
            "comment": row.get("comment"), "volume_initial": row.get("volume_initial"),
            "volume_current": row.get("volume_current"), "price_open": row.get("price_open"),
            "sl": row.get("sl"), "tp": row.get("tp"),
            "time_setup": self._history_time(row.get("time_setup")),
            "time_done": self._history_time(row.get("time_done") or row.get("time_setup")),
            "time_msc": int(row.get("time_done_msc") or row.get("time_setup_msc")
                            or int(row.get("time_done") or row.get("time_setup") or 0) * 1000),
        }

    def _resolve_symbol(self, requested: str) -> str:
        requested = str(requested or "").strip()
        if not requested or len(requested) > 64:
            raise WorkerError("symbol_invalid")
        key = requested.upper()
        if key in self._resolved_symbols:
            return self._resolved_symbols[key]
        symbols = self.mt5.symbols_get()
        if symbols is None:
            raise WorkerError("mt5_symbols_unavailable")
        names = [str(getattr(item, "name", "") or "") for item in symbols]
        folded = requested.upper()
        resolved = next((name for name in names if name == requested), None)
        resolved = resolved or next((name for name in names if name.upper() == folded), None)
        suffixes = (".s", "m", ".c", "_", ".micro")
        resolved = resolved or next((
            name for suffix in suffixes for name in names
            if name.upper() == f"{folded}{suffix}".upper()
        ), None)
        resolved = resolved or next((name for name in names if name.upper().startswith(folded)), None)
        if not resolved:
            raise WorkerError("symbol_not_found")
        select = getattr(self.mt5, "symbol_select", None)
        if callable(select) and not select(resolved, True):
            raise WorkerError("symbol_select_failed")
        self._resolved_symbols[key] = resolved
        return resolved


class Mt5Worker:
    def __init__(self, adapter: ReadOnlyMt5Adapter, route: WorkerRoute):
        self.adapter = adapter
        self.route = route
        self.restart_error_code: str | None = None
        self.trade = Mt5TradeExecutor(
            adapter.mt5,
            route,
            self._ensure_trade_identity,
            adapter._resolve_symbol,
        )

    def _ensure_trade_identity(self) -> tuple[Any, Any]:
        try:
            return self.adapter._ensure_identity()
        except WorkerError as error:
            self._record_restart_error(error.code)
            raise

    def _record_restart_error(self, error_code: str) -> None:
        if error_code in TERMINAL_SESSION_FATAL_ERRORS:
            self.restart_error_code = error_code

    def handle(self, request: dict[str, Any]) -> dict[str, Any]:
        request_id = str(request.get("request_id") or "")
        try:
            self._validate_request(request)
            operation = request["operation"]
            body = request.get("payload")
            if not isinstance(body, dict):
                raise WorkerError("worker_request_payload_invalid")
            if operation == "collect_snapshot":
                payload = self._request_payload(body)
                if set(payload) != {"streams"}:
                    raise WorkerError("worker_request_payload_invalid")
                streams = payload.get("streams")
                if (not isinstance(streams, list) or not streams or len(streams) > 3
                        or len(set(streams)) != len(streams)
                        or any(item not in {"account", "positions", "orders"} for item in streams)):
                    raise WorkerError("worker_snapshot_streams_invalid")
                return self._response(request_id, "snapshot", {
                    "snapshot": self.adapter.collect_snapshot(streams)
                })
            if operation == "quote":
                payload = self._request_payload(body)
                if set(payload) != {"symbol"}:
                    raise WorkerError("worker_request_payload_invalid")
                symbol = payload.get("symbol")
                if not isinstance(symbol, str) or symbol.strip() != symbol or not symbol or len(symbol) > 64:
                    raise WorkerError("worker_quote_symbol_invalid")
                return self._response(request_id, "quote", {"quote": self.adapter.quote(symbol)})
            if operation == "history_sync":
                payload = self._request_payload(body)
                if set(payload) != {"cursor", "limit"} or not isinstance(payload.get("cursor"), dict):
                    raise WorkerError("worker_request_payload_invalid")
                cursor = payload["cursor"]
                if set(cursor) != {"time_msc", "ticket"}:
                    raise WorkerError("worker_history_cursor_invalid")
                return self._response(request_id, "history_batch", {
                    "batch": self.adapter.history_sync(cursor, payload.get("limit"))
                })
            if operation == "data":
                payload = self._request_payload(body)
                if set(payload) != {"action", "params"} or not isinstance(payload.get("params"), dict):
                    raise WorkerError("worker_request_payload_invalid")
                action = payload.get("action")
                if action not in {"rates", "symbols", "symbol_snapshot", "risk_snapshot",
                                  "performance_daily", "pending_order_state", "diagnostics"}:
                    raise WorkerError("worker_data_action_invalid")
                return self._response(request_id, "data", {"data": {
                    "action": action,
                    "observed_at_utc_msc": self.adapter.clock.now_utc_msc(),
                    "payload": self.adapter.data(action, payload["params"]),
                }})
            if operation in {"execute_command", "query_execution"}:
                if set(body) != {"command"} or not isinstance(body.get("command"), dict):
                    raise WorkerError("worker_request_payload_invalid")
                command = body["command"]
                self._validate_command(request_id, operation, command)
                self.adapter._ensure_identity()
                result = self.trade.execute(command, read_only=operation == "query_execution")
                return self._response(request_id, "command_result", {"result": result})
            raise WorkerError("worker_operation_unsupported")
        except WorkerError as error:
            self._record_restart_error(error.code)
            return self._response(request_id, "error", {"error_code": error.code})
        except Exception:
            return self._response(request_id, "error", {"error_code": "mt5_worker_internal_error"})

    def _validate_request(self, request: dict[str, Any]) -> None:
        if set(request) != {"ipc_v", "type", "request_id", "route", "operation", "payload"}:
            raise WorkerError("worker_request_protocol_invalid")
        if request.get("ipc_v") != IPC_VERSION or request.get("type") != "worker_request":
            raise WorkerError("worker_request_protocol_invalid")
        request_id = request.get("request_id")
        if not isinstance(request_id, str) or not request_id or len(request_id) > 128:
            raise WorkerError("worker_request_id_invalid")
        if request.get("route") != self.route.payload():
            raise WorkerError("worker_request_route_mismatch")

    @staticmethod
    def _request_payload(body: dict[str, Any]) -> dict[str, Any]:
        if set(body) != {"request"} or not isinstance(body.get("request"), dict):
            raise WorkerError("worker_request_payload_invalid")
        return body["request"]

    def _validate_command(self, request_id: str, operation: str,
                          command: dict[str, Any]) -> None:
        account = command.get("account_ref")
        if (command.get("v") != 3 or command.get("type") != "command"
                or command.get("command_id") != request_id
                or command.get("terminal_instance_id") != self.route.terminal_instance_id
                or command.get("connection_epoch") != self.route.connection_epoch
                or account != {"broker_server": self.route.broker_server, "login": self.route.login}
                or not isinstance(command.get("params"), dict)):
            raise WorkerError("worker_request_route_mismatch")
        action = command.get("action")
        if operation == "query_execution" and action != "query_execution":
            raise WorkerError("worker_query_action_invalid")
        if operation == "execute_command" and action not in {
            "place_order", "cancel_order", "modify_order", "modify_position", "close_position"
        }:
            raise WorkerError("worker_execute_action_invalid")

    def _response(self, request_id: str, outcome: str, payload: dict[str, Any]) -> dict[str, Any]:
        return {
            "ipc_v": IPC_VERSION,
            "type": "worker_response",
            "request_id": request_id,
            "route": self.route.payload(),
            "outcome": outcome,
            "payload": payload,
        }


def _clock_state_path(route: WorkerRoute) -> Path | None:
    base = os.environ.get("LOCALAPPDATA")
    if not base:
        return None
    identity = f"{route.terminal_instance_id}|{route.broker_server}|{route.login}".encode("utf-8")
    return Path(base) / "AURUM" / "Bridge" / "clock" / f"{hashlib.sha256(identity).hexdigest()}.json"


def run(mt5: Any) -> None:
    if int(_required_env("AURUM_BRIDGE_WORKER_IPC_VERSION")) != IPC_VERSION:
        raise WorkerError("worker_environment_invalid")
    route = route_from_environment()
    terminal_path = _required_env("AURUM_BRIDGE_WORKER_TERMINAL_PATH")
    adapter = ReadOnlyMt5Adapter(mt5, terminal_path, route, clock_state_path=_clock_state_path(route))
    adapter.connect()
    pipe_name = _required_env("AURUM_BRIDGE_WORKER_PIPE")
    nonce = _required_env("AURUM_BRIDGE_WORKER_NONCE")
    worker = Mt5Worker(adapter, route)
    try:
        with open(rf"\\.\pipe\{pipe_name}", "r+b", buffering=0) as stream:
            write_frame(stream, {
                "ipc_v": IPC_VERSION,
                "type": "worker_hello",
                "session_nonce": nonce,
                "worker_version": WORKER_VERSION,
                "route": route.payload(),
                "capabilities": [
                    "snapshot", "quote", "data", "history_sync",
                    "execute_command", "query_execution"
                ],
            })
            while True:
                write_frame(stream, worker.handle(read_frame(stream)))
                if worker.restart_error_code is not None:
                    return
    except EOFError:
        pass
    finally:
        adapter.shutdown()


def probe_terminal(mt5: Any, terminal_path: str) -> dict[str, Any]:
    resolved_path = str(Path(terminal_path).resolve())
    if not Path(resolved_path).is_file():
        raise WorkerError("mt5_terminal_not_found")
    _require_terminal_running(resolved_path)
    if not mt5.initialize(path=resolved_path, timeout=10_000, portable=False):
        raise WorkerError("mt5_initialize_failed")
    try:
        account = mt5.account_info()
        terminal = mt5.terminal_info()
        broker_server = str(getattr(account, "server", "") or "").strip()
        login = str(getattr(account, "login", "") or "").strip()
        if account is None or terminal is None or not broker_server or not login:
            raise WorkerError("mt5_account_unavailable")
        if not bool(getattr(terminal, "connected", False)):
            raise WorkerError("mt5_terminal_disconnected")
        return {
            "probe_version": 1,
            "terminal_path": resolved_path,
            "account_ref": {"broker_server": broker_server, "login": login},
        }
    finally:
        mt5.shutdown()


def main(mt5: Any, arguments: list[str]) -> None:
    if arguments:
        if len(arguments) != 3 or arguments[0] != "--probe" or arguments[1] != "--terminal":
            raise WorkerError("worker_arguments_invalid")
        print(json.dumps(probe_terminal(mt5, arguments[2]), ensure_ascii=False,
                         separators=(",", ":")))
        return
    run(mt5)


if __name__ == "__main__":
    import MetaTrader5 as mt5

    main(mt5, sys.argv[1:])
