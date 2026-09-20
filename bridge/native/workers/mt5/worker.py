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

# The private embeddable runtime intentionally disables global/site paths.
# Resolve only the companion modules shipped beside this explicitly selected script.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from trade import Mt5TradeExecutor
from order_completion import history_order_completion_evidence

IPC_VERSION = 2
WORKER_VERSION = "3.0.4"
MAX_FRAME_BYTES = 4 * 1024 * 1024
MAX_SNAPSHOT_ITEMS = 10_000
MAX_HISTORY_BATCH_ITEMS = 250
MAX_HISTORY_CONTEXT_ITEMS = 4096
MAX_HISTORY_FALLBACK_QUERIES = 4
MAX_HISTORY_WINDOW_CACHE_ITEMS = 10_000
MAX_HISTORY_RANGE_FUTURE_MSC = 60_000
MAX_SYMBOL_ITEMS = 10_000
HISTORY_WINDOW_MSC = 30 * 24 * 60 * 60 * 1000
CLOCK_FRESHNESS_TOLERANCE_MS = 30_000
CLOCK_STALE_AFTER_MS = 120_000
CLOCK_INITIAL_PROBE_SECONDS = 2.0
CLOCK_INITIAL_POLL_SECONDS = 0.1
TERMINAL_SESSION_FATAL_ERRORS = frozenset({
    "mt5_account_unavailable",
    "mt5_terminal_disconnected",
})
# A single terminal-session read can fail while MT5 is reconnecting.  Keep the
# IPC session alive for a small bounded number of consecutive failures so the
# supervisor does not churn the worker on every transient disconnect.
TERMINAL_SESSION_FAILURE_THRESHOLD = 3
TERMINAL_LOGIN_WAIT_SECONDS = 30.0
TERMINAL_LOGIN_POLL_SECONDS = 0.5
RATE_TIMEFRAMES = frozenset({
    "M1", "M2", "M3", "M4", "M5", "M6", "M10", "M12", "M15", "M20", "M30",
    "H1", "H2", "H3", "H4", "H6", "H8", "H12", "D1", "W1", "MN1",
})
DIAGNOSTIC_PATH_ENV = "AURUM_BRIDGE_DIAGNOSTIC_PATH"
WORKER_ROLE_ENV = "AURUM_BRIDGE_WORKER_ROLE"
LIVE_CAPABILITIES = (
    "snapshot", "quote", "data", "execute_command", "query_execution"
)
ARCHIVE_CAPABILITIES = ("history_range_sync",)
MAX_DIAGNOSTIC_BYTES = 1024 * 1024


class WorkerError(RuntimeError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def _probe_error_code(code: str) -> str:
    """Map internal worker errors to the small, stable probe contract."""
    return {
        "mt5_terminal_not_found": "terminal_not_found",
        "mt5_terminal_not_running": "terminal_not_running",
        "mt5_initialize_failed": "initialize_failed",
        "mt5_account_unavailable": "account_unavailable",
        "mt5_terminal_disconnected": "disconnected",
        "mt5_terminal_path_mismatch": "terminal_path_mismatch",
        "mt5_terminal_data_path_mismatch": "data_path_mismatch",
        "mt5_terminal_location_unavailable": "terminal_location_unavailable",
    }.get(code, "probe_failed")


def _probe_last_error(mt5: Any) -> int | None:
    """Return only MetaTrader5's numeric last-error value, never its text."""
    try:
        value = mt5.last_error()
    except Exception:
        return None
    if isinstance(value, (tuple, list)):
        value = value[0] if value else None
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError, OverflowError):
        return None


def _report_unexpected_exception(stage: str, error: BaseException) -> None:
    """Persist only a redacted exception type; never serialize broker/user data or messages."""
    path = os.environ.get(DIAGNOSTIC_PATH_ENV, "").strip()
    if not path:
        return
    try:
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        record = {
            "observed_at_utc_msc": int(time.time() * 1000),
            "event": "mt5_worker_unexpected_exception",
            "stage": stage,
            "exception_type": type(error).__name__,
        }
        mode = "w" if target.is_file() and target.stat().st_size >= MAX_DIAGNOSTIC_BYTES else "a"
        with target.open(mode, encoding="utf-8", newline="\n") as stream:
            stream.write(json.dumps(record, ensure_ascii=True, separators=(",", ":")) + "\n")
    except (OSError, TypeError, ValueError):
        return


def _report_terminal_session_failure(error_code: str, consecutive_failures: int) -> None:
    """Persist one redacted record when terminal-session recovery is exhausted."""
    if error_code not in TERMINAL_SESSION_FATAL_ERRORS:
        return
    path = os.environ.get(DIAGNOSTIC_PATH_ENV, "").strip()
    if not path:
        return
    try:
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        record = {
            "observed_at_utc_msc": int(time.time() * 1000),
            "event": "mt5_worker_terminal_session_restart",
            "stage": "worker_request",
            "error_code": error_code,
            "consecutive_failures": int(consecutive_failures),
        }
        mode = "w" if target.is_file() and target.stat().st_size >= MAX_DIAGNOSTIC_BYTES else "a"
        with target.open(mode, encoding="utf-8", newline="\n") as stream:
            stream.write(json.dumps(record, ensure_ascii=True, separators=(",", ":")) + "\n")
    except (OSError, TypeError, ValueError):
        return


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


def _worker_role(value: str) -> str:
    role = str(value or "").strip().lower()
    if role not in {"live", "archive"}:
        raise WorkerError("worker_environment_invalid")
    return role


def role_from_environment() -> str:
    return _worker_role(_required_env(WORKER_ROLE_ENV))


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


def _history_item_in_utc_range(item: Any, range_start: int, range_end: int,
                               keys: tuple[str, ...] = (
                                   "time_utc_msc", "time_msc",
                               )) -> bool:
    if not isinstance(item, dict):
        return False
    for key in keys:
        value = item.get(key)
        if value is None:
            continue
        try:
            timestamp = int(value)
        except (TypeError, ValueError):
            return False
        return range_start <= timestamp < range_end
    return False


def sample_clock_evidence(mt5, clock_msc, preferred_symbol: str | None = None):
    """Capture bounded evidence without assuming tick time is broker wall time."""
    started = int(clock_msc())
    sample = None
    symbol_names: list[str] = []
    if preferred_symbol and 0 < len(preferred_symbol) <= 64:
        symbol_names.append(preferred_symbol)
    symbols = mt5.symbols_get() or ()
    for item in symbols[:32]:
        if not getattr(item, "visible", False):
            continue
        name = str(getattr(item, "name", "") or "")
        if not name or len(name) > 64 or name in symbol_names:
            continue
        symbol_names.append(name)
    for name in symbol_names:
        tick = mt5.symbol_info_tick(name)
        raw = getattr(tick, "time_msc", None) if tick else None
        if isinstance(raw, bool) or not isinstance(raw, int) or not 0 < raw <= 253402300799999:
            continue
        sample = (name, raw)
        break
    ended = int(clock_msc())
    usable = started > 0 and 0 <= ended - started <= 5000
    return {
        "server_time_utc_msc": None,
        "sampled_at_utc_msc": ended,
        "sampling_started_at_utc_msc": started,
        "timezone_offset_minutes": None,
        "clock_status": "unavailable",
        "source_kind": "mt5_tick_time_unverified",
        "sample_status": "captured" if sample and usable else "unavailable",
        "symbol": sample[0] if sample and usable else None,
        "raw_tick_time_msc": sample[1] if sample and usable else None,
    }


class BrokerClock:
    def __init__(self, state_path: Path | None, clock_msc: Any | None = None):
        self._state_path = state_path
        self._clock_msc = clock_msc or (lambda: int(time.time() * 1000))
        self.offset_minutes: int | None = None
        self.status = "unavailable"
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

    def require_offset_minutes(self) -> int:
        if self.offset_minutes is None:
            raise WorkerError("mt5_clock_unverified")
        return self.offset_minutes

    def normalize(self, raw_msc: int) -> int:
        return raw_msc - self.require_offset_minutes() * 60_000

    def server_from_utc(self, utc_msc: int) -> int:
        return utc_msc + self.require_offset_minutes() * 60_000

    def now_utc_msc(self) -> int:
        return int(self._clock_msc())

    def calibrate(self, raw_msc: int) -> int:
        host_msc = int(self._clock_msc())
        if raw_msc <= 0:
            raise WorkerError("mt5_clock_unverified")
        residual = (self.normalize(raw_msc) - host_msc
                    if self.offset_minutes is not None else raw_msc - host_msc)
        self.residual_ms = residual
        if (self.offset_minutes is not None
                and abs(residual) <= CLOCK_FRESHNESS_TOLERANCE_MS):
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
        if (self._trusted and self.status != "verified"
                and residual > CLOCK_FRESHNESS_TOLERANCE_MS):
            raise WorkerError("mt5_clock_unverified")
        if self._trusted:
            if self.status != "verified":
                self.status = "persisted_stale"
        else:
            raise WorkerError("mt5_clock_unverified")
        self._save()
        return self.normalize(raw_msc)


class ReadOnlyMt5Adapter:
    def __init__(self, mt5: Any, terminal_path: str, route: WorkerRoute,
                 clock_msc: Any | None = None, clock_state_path: Path | None = None,
                 login_wait_seconds: float = TERMINAL_LOGIN_WAIT_SECONDS,
                 login_poll_seconds: float = TERMINAL_LOGIN_POLL_SECONDS,
                 clock_probe_seconds: float = CLOCK_INITIAL_PROBE_SECONDS,
                 clock_poll_seconds: float = CLOCK_INITIAL_POLL_SECONDS,
                 portable: bool = False, expected_data_path: str | None = None):
        self.mt5 = mt5
        self.terminal_path = str(Path(terminal_path).resolve())
        self.portable = portable
        self.expected_data_path = expected_data_path
        self.route = route
        self.clock = BrokerClock(clock_state_path, clock_msc)
        self._resolved_symbols: dict[str, str] = {}
        self._preferred_clock_symbol: str | None = None
        self._history_orders_by_ticket: dict[int, dict[str, Any]] = {}
        self._history_positions: dict[int, dict[str, Any]] = {}
        self._history_window_cursor: tuple[int, int] | None = None
        self._history_window_end = 0
        self._history_window_truncated = False
        self._history_window_rows: list[tuple[int, int, dict[str, Any]]] = []
        self._history_range_cache_key: tuple[int, int, int, int] | None = None
        # Range pages are driven by both deal and history-order events.  The
        # final tuple element is the event kind (0=deal, 1=order); the wire
        # cursor remains the pair (time, ticket), and pages never split a
        # compound pair so a same-time/same-ticket event cannot be skipped.
        self._history_range_rows: list[tuple[int, int, int, dict[str, Any]]] = []
        self._history_range_truncated = False
        self.login_wait_seconds = max(0.0, float(login_wait_seconds))
        self.login_poll_seconds = max(0.01, float(login_poll_seconds))
        self.clock_probe_seconds = max(0.0, float(clock_probe_seconds))
        self.clock_poll_seconds = max(0.01, float(clock_poll_seconds))

    def connect(self) -> None:
        if not Path(self.terminal_path).is_file():
            raise WorkerError("mt5_terminal_not_found")
        _require_terminal_running(self.terminal_path)
        if not self.mt5.initialize(path=self.terminal_path, timeout=10_000, portable=self.portable):
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
        _verify_terminal_location(terminal, self.terminal_path, self.expected_data_path)
        return account, terminal

    def collect_snapshot(self, streams: list[str]) -> dict[str, Any]:
        account, terminal = self._ensure_identity()
        result: dict[str, Any] = {}
        if "account" in streams:
            payload = _plain(account)
            if not isinstance(payload, dict):
                raise WorkerError("mt5_account_invalid")
            terminal_trade_allowed = getattr(terminal, "trade_allowed", None)
            if isinstance(terminal_trade_allowed, bool):
                payload["terminal_trade_allowed"] = terminal_trade_allowed
            # Read-only display evidence; missing values must remain unknown.
            tradeapi_disabled = getattr(terminal, "tradeapi_disabled", None)
            if isinstance(tradeapi_disabled, bool):
                payload["terminal_tradeapi_disabled"] = tradeapi_disabled
            payload["terminal_connected"] = bool(getattr(terminal, "connected", False))
            evidence = None
            check_now = time.monotonic()
            if check_now >= getattr(self, "_next_display_clock_check", 0):
                evidence = sample_clock_evidence(
                    self.mt5, self.clock.now_utc_msc, self._preferred_clock_symbol)
            if evidence and evidence["sample_status"] == "captured":
                payload["clock_sample"] = {
                    "symbol": evidence["symbol"],
                    "raw_time_msc": evidence["raw_tick_time_msc"],
                    "started_at_msc": evidence["sampling_started_at_utc_msc"],
                    "sampled_at_msc": evidence["sampled_at_utc_msc"],
                    "monotonic_msc": int(time.monotonic() * 1000),
                }
                previous = getattr(self, "_previous_display_clock_sample", None)
                current = payload["clock_sample"]
                # Scheduling only: the server remains responsible for accepting calibration.
                if previous and current["symbol"] == previous["symbol"]:
                    elapsed = current["sampled_at_msc"] - previous["sampled_at_msc"]
                    progress = current["raw_time_msc"] - previous["raw_time_msc"]
                    candidate = round((current["raw_time_msc"] - current["sampled_at_msc"]) / 900000) * 15
                    if (500 <= elapsed <= 60000 and progress > 0 and abs(progress - elapsed) <= 5000
                            and abs(elapsed - (current["monotonic_msc"] - previous["monotonic_msc"])) <= 250
                            and -720 <= candidate <= 840
                            and all(abs(v["raw_time_msc"] - candidate * 60000 - v["sampled_at_msc"]) <= 5000 for v in (previous, current))):
                        self._next_display_clock_check = check_now + 86400
                        self._confirmed_display_clock_sample = dict(current, previous=dict(previous))
                self._previous_display_clock_sample = current
            confirmed = getattr(self, "_confirmed_display_clock_sample", None)
            if confirmed and 0 <= self.clock.now_utc_msc() - confirmed["sampled_at_msc"] <= 60000:
                payload["clock_sample"] = confirmed
            result["account"] = payload
        if "positions" in streams:
            result["positions"] = self._items(self.mt5.positions_get(), "mt5_positions_unavailable")
        if "orders" in streams:
            result["orders"] = self._items(self.mt5.orders_get(), "mt5_orders_unavailable")
        # Preserve raw fields for existing query consumers. UTC fields require the
        # adapter's clock conversion; never label broker-wall timestamps as UTC.
        for stream in ("positions", "orders"):
            for row in result.get(stream, []):
                self._calibrate_terminal_clock(str(row["symbol"]))
                if stream == "positions":
                    raw = int(row.get("time_msc") or int(row.get("time") or 0) * 1000)
                    row["open_time_utc_msc"] = self.clock.normalize(raw) if raw > 0 else None
                else:
                    raw = int(row.get("time_setup_msc") or int(row.get("time_setup") or 0) * 1000)
                    row["create_time_utc_msc"] = self.clock.normalize(raw) if raw > 0 else None
                    expiry = int(row.get("time_expiration") or 0)
                    row["expiration_time_utc_msc"] = self.clock.normalize(expiry * 1000) if expiry else None
        self._ensure_identity()
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

    def _calibrate_terminal_clock(self, preferred_symbol: str | None = None) -> int:
        symbol_names: list[str] = []
        if preferred_symbol:
            symbol_names.append(preferred_symbol)
        symbols = self.mt5.symbols_get()
        if symbols is None and not symbol_names:
            raise WorkerError("mt5_symbols_unavailable")
        if symbols is not None:
            for item in symbols[:MAX_SYMBOL_ITEMS]:
                name = str(getattr(item, "name", "") or "").strip()
                if name and name not in symbol_names:
                    symbol_names.append(name)
        deadline = time.monotonic() + self.clock_probe_seconds
        last_error: WorkerError | None = None
        while True:
            candidates: list[int] = []
            for name in symbol_names:
                tick = self.mt5.symbol_info_tick(name)
                raw_msc = int(getattr(tick, "time_msc", 0) or 0) if tick else 0
                if raw_msc > 0:
                    candidates.append(raw_msc)
            if candidates:
                host_msc = self.clock.now_utc_msc()
                persisted_offset = self.clock.offset_minutes

                def sample_score(raw_msc: int) -> int:
                    if persisted_offset is not None:
                        return abs(raw_msc - persisted_offset * 60_000 - host_msc)
                    candidate = round((raw_msc - host_msc) / 900_000) * 15
                    if not -720 <= candidate <= 840:
                        return 2**63 - 1
                    return abs(raw_msc - candidate * 60_000 - host_msc)

                try:
                    observed = self.clock.calibrate(min(candidates, key=sample_score))
                    if self.clock.status == "verified" or time.monotonic() >= deadline:
                        return observed
                except WorkerError as error:
                    last_error = error
            if time.monotonic() >= deadline:
                if self.clock.offset_minutes is not None:
                    # A closed market cannot provide a progressing tick. Keep
                    # the last verified terminal offset, but never derive a new
                    # offset from the age of the stale quote.
                    observed = self.clock.normalize(max(candidates))
                    if observed > self.clock.now_utc_msc() + CLOCK_FRESHNESS_TOLERANCE_MS:
                        raise last_error or WorkerError("mt5_clock_unverified")
                    self.clock.status = "persisted_stale"
                    return observed
                raise last_error or WorkerError("mt5_clock_unverified")
            time.sleep(self.clock_poll_seconds)

    def quote(self, requested_symbol: str) -> dict[str, Any]:
        self._ensure_identity()
        symbol = self._resolve_symbol(requested_symbol)
        self._preferred_clock_symbol = symbol
        self._calibrate_terminal_clock(symbol)
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
        observed_at = self.clock.normalize(raw_msc)
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
        now_msc = self.clock.now_utc_msc()
        if (cursor_time <= 0 or cursor_time > now_msc or cursor_ticket < 0
                or limit < 1 or limit > MAX_HISTORY_BATCH_ITEMS):
            raise WorkerError("worker_history_cursor_invalid")
        self._calibrate_terminal_clock()
        request_cursor = (cursor_time, cursor_ticket)
        if self._history_window_cursor != request_cursor:
            window_end = min(cursor_time + HISTORY_WINDOW_MSC, now_msc)
            if window_end <= cursor_time:
                return self._history_batch(
                    [], [], cursor_time, cursor_ticket, False, now_msc)
            server_from = self.clock.server_from_utc(max(0, cursor_time - 1_000))
            server_to = self.clock.server_from_utc(window_end + 999)
            date_from = datetime.fromtimestamp(server_from / 1000,
                                               tz=timezone.utc)
            date_to = datetime.fromtimestamp(server_to / 1000, tz=timezone.utc)
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
                    event_server_msc = int(raw.get("time_msc")
                                           or int(raw.get("time") or 0) * 1000)
                except (TypeError, ValueError) as error:
                    raise WorkerError("mt5_history_deal_invalid") from error
                if ticket <= 0 or event_server_msc <= 0:
                    raise WorkerError("mt5_history_deal_invalid")
                event_utc_msc = self.clock.normalize(event_server_msc)
                if ((event_utc_msc, ticket) > request_cursor
                        and event_utc_msc <= window_end):
                    rows.append((event_utc_msc, ticket, raw))
            rows.sort(key=lambda item: (item[0], item[1]))
            self._history_window_cursor = request_cursor
            self._history_window_end = window_end
            self._history_window_truncated = len(rows) > MAX_HISTORY_WINDOW_CACHE_ITEMS
            self._history_window_rows = rows[:MAX_HISTORY_WINDOW_CACHE_ITEMS]
        rows = self._history_window_rows
        window_end = self._history_window_end
        selected = rows[:limit]
        remaining = rows[len(selected):]
        if remaining or self._history_window_truncated:
            next_time, next_ticket = selected[-1][0], selected[-1][1]
            has_more = True
        else:
            next_time = window_end
            next_ticket = selected[-1][1] if selected and selected[-1][0] == window_end else 0
            has_more = window_end < now_msc
        raw_orders: list[Any] = []
        if selected:
            order_from = datetime.fromtimestamp(
                self.clock.server_from_utc(max(0, cursor_time - 1_000)) / 1000,
                                                tz=timezone.utc)
            order_to = datetime.fromtimestamp(
                self.clock.server_from_utc(selected[-1][0] + 999) / 1000,
                                              tz=timezone.utc)
            values = self.mt5.history_orders_get(order_from, order_to)
            if values is None:
                raise WorkerError("mt5_history_orders_unavailable")
            if len(values) > MAX_HISTORY_CONTEXT_ITEMS:
                raise WorkerError("mt5_history_range_too_dense")
            raw_orders = [_plain(item) for item in values]
        batch = self._history_batch(
            [item[2] for item in selected], raw_orders,
            next_time, next_ticket, has_more, now_msc)
        if remaining:
            self._history_window_rows = remaining
            self._history_window_cursor = (next_time, next_ticket)
        else:
            self._history_window_rows = []
            self._history_window_cursor = None
            self._history_window_end = 0
            self._history_window_truncated = False
        return batch

    def history_range_sync(self, range_start_utc_msc: int, range_end_utc_msc: int,
                           cursor: dict[str, Any], limit: int) -> dict[str, Any]:
        """Read one explicit UTC half-open history range with a bounded cursor page."""
        self._ensure_identity()
        try:
            values = (range_start_utc_msc, range_end_utc_msc, limit,
                      cursor.get("time_msc"), cursor.get("ticket"))
            if any(isinstance(value, bool) for value in values):
                raise ValueError
            range_start = int(range_start_utc_msc)
            range_end = int(range_end_utc_msc)
            cursor_time = int(cursor.get("time_msc"))
            cursor_ticket = int(cursor.get("ticket"))
            page_limit = int(limit)
        except (AttributeError, TypeError, ValueError) as error:
            raise WorkerError("worker_history_range_invalid") from error
        now_msc = self.clock.now_utc_msc()
        if (range_start <= 0 or range_end <= range_start
                or range_end - range_start > HISTORY_WINDOW_MSC):
            raise WorkerError("worker_history_range_invalid")
        if now_msc <= 0 or range_end > now_msc + MAX_HISTORY_RANGE_FUTURE_MSC:
            raise WorkerError("worker_history_range_future")
        if (cursor_time < range_start or cursor_time > range_end
                or cursor_ticket < 0
                or (cursor_time == range_end and cursor_ticket != 0)):
            raise WorkerError("worker_history_range_cursor_invalid")
        if page_limit < 1 or page_limit > MAX_HISTORY_BATCH_ITEMS:
            raise WorkerError("worker_history_limit_invalid")

        self._calibrate_terminal_clock()
        if cursor_time == range_end:
            self._history_range_rows = []
            self._history_range_cache_key = None
            self._history_range_truncated = False
            return self._history_batch([], [], range_end, 0, False, now_msc)
        cache_key = (range_start, range_end, cursor_time, cursor_ticket)
        range_cache_hit = self._history_range_cache_key == cache_key
        bulk_raw_orders: list[dict[str, Any]] = []
        entry_order_by_position: dict[int, int] = {}
        if not range_cache_hit:
            server_from = self.clock.server_from_utc(max(0, range_start - 1_000))
            server_to = self.clock.server_from_utc(range_end + 999)
            date_from = datetime.fromtimestamp(server_from / 1000, tz=timezone.utc)
            date_to = datetime.fromtimestamp(server_to / 1000, tz=timezone.utc)
            raw_deals = self.mt5.history_deals_get(date_from, date_to)
            if raw_deals is None:
                raise WorkerError("mt5_history_deals_unavailable")
            raw_orders = self.mt5.history_orders_get(date_from, date_to)
            if raw_orders is None:
                raise WorkerError("mt5_history_orders_unavailable")
            if len(raw_orders) > MAX_HISTORY_CONTEXT_ITEMS:
                raise WorkerError("mt5_history_range_too_dense")
            bulk_raw_orders = [_plain(item) for item in raw_orders]
            for value in bulk_raw_orders:
                if not isinstance(value, dict):
                    raise WorkerError("mt5_history_order_invalid")
                try:
                    ticket = int(value.get("ticket") or 0)
                except (TypeError, ValueError) as error:
                    raise WorkerError("mt5_history_order_invalid") from error
                if ticket <= 0:
                    raise WorkerError("mt5_history_order_invalid")
                self._remember_history_context(
                    self._history_orders_by_ticket,
                    ticket,
                    self._history_order_row(value),
                )
            rows: list[tuple[int, int, int, dict[str, Any]]] = []
            entry_in = int(getattr(self.mt5, "DEAL_ENTRY_IN", 0))
            for value in raw_deals:
                raw = _plain(value)
                if not isinstance(raw, dict):
                    raise WorkerError("mt5_history_deal_invalid")
                try:
                    ticket = int(raw.get("ticket") or 0)
                    order_ticket = int(raw.get("order") or 0)
                    position_id = int(raw.get("position_id") or 0)
                    entry = int(raw.get("entry") if raw.get("entry") is not None else -1)
                    event_server_msc = int(
                        raw.get("time_msc") or int(raw.get("time") or 0) * 1000
                    )
                except (TypeError, ValueError) as error:
                    raise WorkerError("mt5_history_deal_invalid") from error
                if ticket <= 0 or event_server_msc <= 0:
                    raise WorkerError("mt5_history_deal_invalid")
                if entry == entry_in and position_id > 0 and order_ticket > 0:
                    entry_order_by_position[position_id] = order_ticket
                event_utc_msc = self.clock.normalize(event_server_msc)
                if (range_start <= event_utc_msc < range_end
                        and (event_utc_msc, ticket) > (cursor_time, cursor_ticket)):
                    rows.append((event_utc_msc, ticket, 0, raw))
            seen_order_events: set[tuple[int, int]] = set()
            for value in raw_orders:
                raw = _plain(value)
                if not isinstance(raw, dict):
                    raise WorkerError("mt5_history_order_invalid")
                try:
                    ticket = int(raw.get("ticket") or 0)
                    event_server_msc = int(
                        raw.get("time_done_msc")
                        or raw.get("time_setup_msc")
                        or int(raw.get("time_done") or raw.get("time_setup") or 0) * 1000
                    )
                except (TypeError, ValueError) as error:
                    raise WorkerError("mt5_history_order_invalid") from error
                if ticket <= 0 or event_server_msc <= 0:
                    raise WorkerError("mt5_history_order_invalid")
                event_utc_msc = self.clock.normalize(event_server_msc)
                event_key = (event_utc_msc, ticket)
                if (range_start <= event_utc_msc < range_end
                        and event_key > (cursor_time, cursor_ticket)
                        and event_key not in seen_order_events):
                    seen_order_events.add(event_key)
                    rows.append((event_utc_msc, ticket, 1, raw))
            rows.sort(key=lambda item: (item[0], item[1], item[2]))
            if len(rows) > MAX_HISTORY_WINDOW_CACHE_ITEMS:
                raise WorkerError("mt5_history_range_too_dense")
            self._history_range_truncated = False
            self._history_range_rows = rows
            self._history_range_cache_key = cache_key

        rows = self._history_range_rows
        for _, _, kind, raw in rows:
            if kind != 0:
                continue
            entry = int(raw.get("entry") if raw.get("entry") is not None else -1)
            position_id = int(raw.get("position_id") or 0)
            order_ticket = int(raw.get("order") or 0)
            if entry == int(getattr(self.mt5, "DEAL_ENTRY_IN", 0)) \
                    and position_id > 0 and order_ticket > 0:
                entry_order_by_position[position_id] = order_ticket
        selected: list[tuple[int, int, int, dict[str, Any]]] = []
        selected_deal_count = 0
        selected_order_count = 0
        selected_order_tickets: set[int] = set()
        exit_entries = {
            int(getattr(self.mt5, "DEAL_ENTRY_OUT", 1)),
            int(getattr(self.mt5, "DEAL_ENTRY_INOUT", 2)),
            int(getattr(self.mt5, "DEAL_ENTRY_OUT_BY", 3)),
        }
        index = 0
        while index < len(rows):
            group_key = rows[index][:2]
            group_end = index + 1
            while group_end < len(rows) and rows[group_end][:2] == group_key:
                group_end += 1
            group = rows[index:group_end]
            group_deals = sum(item[2] == 0 for item in group)
            group_orders = sum(item[2] == 1 for item in group)
            group_order_tickets: set[int] = set()
            for _, _, kind, raw in group:
                if kind == 1:
                    group_order_tickets.add(int(raw.get("ticket") or 0))
                    continue
                order_ticket = int(raw.get("order") or 0)
                if order_ticket > 0:
                    group_order_tickets.add(order_ticket)
                entry = int(raw.get("entry") if raw.get("entry") is not None else -1)
                position_id = int(raw.get("position_id") or 0)
                if entry in exit_entries and position_id > 0:
                    origin_order = entry_order_by_position.get(position_id, 0)
                    context = self._history_positions.get(position_id)
                    if isinstance(context, dict):
                        origin = context.get("origin")
                        if isinstance(origin, dict):
                            origin_order = int(origin.get("order") or origin_order)
                    if origin_order > 0:
                        group_order_tickets.add(origin_order)
            projected_order_count = len(selected_order_tickets | group_order_tickets)
            if group_deals > page_limit or group_orders > page_limit:
                raise WorkerError("mt5_history_range_too_dense")
            if selected and (selected_deal_count + group_deals > page_limit
                             or selected_order_count + group_orders > page_limit
                             or projected_order_count > page_limit):
                break
            if not selected and projected_order_count > page_limit:
                raise WorkerError("mt5_history_range_too_dense")
            selected.extend(group)
            selected_deal_count += group_deals
            selected_order_count += group_orders
            selected_order_tickets.update(group_order_tickets)
            index = group_end
            if selected_deal_count == page_limit and selected_order_count == page_limit:
                break
        remaining = rows[len(selected):]
        has_more = bool(remaining or self._history_range_truncated)
        if selected and has_more:
            next_time, next_ticket = selected[-1][0], selected[-1][1]
        else:
            next_time, next_ticket = range_end, 0
            has_more = False
        raw_deals = [item[3] for item in selected if item[2] == 0]
        # The immutable fixed-range snapshot already fetched all order
        # evidence on its first page.  Continuations reuse the cached order
        # rows (and still emit standalone order rows selected on that page)
        # instead of issuing another history_orders_get call.
        raw_orders = [item[3] for item in selected if item[2] == 1]
        batch = self._history_batch(
            raw_deals, raw_orders,
            next_time, next_ticket, has_more, now_msc,
        )
        batch["deals"] = [
            item for item in batch["deals"]
            if _history_item_in_utc_range(item, range_start, range_end)
        ]
        batch["history_orders"] = [
            item for item in batch["history_orders"]
            if _history_item_in_utc_range(item, range_start, range_end)
        ]
        batch["trades"] = [
            item for item in batch["trades"]
            if _history_item_in_utc_range(item, range_start, range_end,
                                          keys=("close_time_utc_msc", "time_utc_msc"))
        ]
        for key in ("deals", "history_orders", "trades"):
            # Never silently discard a fan-out item: the Rust contract treats
            # each collection's page limit independently, so an oversized
            # collection is a dense range that must be retried with a smaller
            # window rather than marked complete.
            if len(batch[key]) > page_limit:
                raise WorkerError("mt5_history_range_too_dense")
        try:
            batch["order_completion_evidence"] = history_order_completion_evidence(
                raw_orders, batch["history_orders"], self.clock, now_msc)
        except ValueError as error:
            raise WorkerError(str(error)) from error
        if has_more:
            self._history_range_rows = remaining
            self._history_range_cache_key = (
                range_start, range_end, next_time, next_ticket
            )
            self._history_range_truncated = False
        else:
            self._history_range_rows = []
            self._history_range_cache_key = None
            self._history_range_truncated = False
        return batch

    def data(self, action: str, params: dict[str, Any]) -> dict[str, Any]:
        self._ensure_identity()
        if action == "terminal_clock":
            if params:
                raise WorkerError("worker_data_params_invalid")
            evidence = None
            check_now = time.monotonic()
            if check_now >= getattr(self, "_next_display_clock_check", 0):
                evidence = sample_clock_evidence(
                    self.mt5, self.clock.now_utc_msc, self._preferred_clock_symbol)
            self._ensure_identity()
            return evidence
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
        self._preferred_clock_symbol = symbol
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
        self._calibrate_terminal_clock(symbol)
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
        self._preferred_clock_symbol = symbol
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
        self._calibrate_terminal_clock()
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
            event_server_msc = int(raw.get("time_msc") or int(raw.get("time") or 0) * 1000)
            event_utc_msc = self.clock.normalize(event_server_msc)
            day = datetime.fromtimestamp(event_server_msc / 1000.0, timezone.utc).strftime("%Y-%m-%d")
            if not start_text <= day <= end_text:
                continue
            row = daily.setdefault(day, empty_day(day))
            ticket = int(raw.get("ticket") or 0)
            if not row["first_deal_time_msc"] or event_utc_msc < row["first_deal_time_msc"]:
                row["first_deal_time_msc"] = event_utc_msc
            if (event_utc_msc, ticket) > (row["last_deal_time_msc"], row["last_deal_ticket"]):
                row["last_deal_time_msc"], row["last_deal_ticket"] = event_utc_msc, ticket
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
                "timezone_offset_minutes": self.clock.offset_minutes,
                "clock_status": self.clock.status,
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
        observed = self._calibrate_terminal_clock(symbol)
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
        utc_start = requested_ms or baseline_ms or self.clock.now_utc_msc()
        deals = self.mt5.history_deals_get(
            datetime.fromtimestamp(
                self.clock.server_from_utc(max(0, utc_start - 300_000)) / 1000.0,
                timezone.utc),
            datetime.fromtimestamp(
                self.clock.server_from_utc(self.clock.now_utc_msc() + 86_400_000) / 1000.0,
                timezone.utc))
        if deals is None:
            raise WorkerError("risk_snapshot_deals_unavailable")
        deal_rows = [_plain(item) for item in deals]
        if not all(isinstance(item, dict) for item in deal_rows):
            raise WorkerError("risk_snapshot_deals_invalid")
        deal_rows.sort(key=lambda item: (self.clock.normalize(
                                             int(item.get("time_msc") or int(item.get("time") or 0) * 1000)),
                                         int(item.get("ticket") or 0)))
        cursor = (requested_ms or utc_start, requested_ticket)
        new_deals = [item for item in deal_rows if
                     (self.clock.normalize(int(item.get("time_msc")
                                               or int(item.get("time") or 0) * 1000)),
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
            close_server_msc = int(deal.get("time_msc") or int(deal.get("time") or 0) * 1000)
            close_utc_msc = self.clock.normalize(close_server_msc)
            closed.append({"position_id": position_id, "close_time_msc": close_utc_msc,
                           "close_time_utc_msc": close_utc_msc,
                           "close_time_server_msc": close_server_msc,
                           "close_deal_ticket": int(deal.get("ticket") or 0),
                           "business_date": datetime.fromtimestamp(
                               close_server_msc / 1000.0, timezone.utc).strftime("%Y-%m-%d"),
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
            event_server_msc = int(deal.get("time_msc") or int(deal.get("time") or 0) * 1000)
            event_utc_msc = self.clock.normalize(event_server_msc)
            if deal_type in capital_types:
                category = "capital"
            elif deal_type in adjustment_types:
                category = "pnl_adjustment"
            else:
                category = "unknown"
                issues.append(f"unknown_deal_type:{deal_type}")
            account_events.append({"ticket": int(deal.get("ticket") or 0),
                                   "time_msc": event_utc_msc,
                                   "time_utc_msc": event_utc_msc,
                                   "time_server_msc": event_server_msc,
                                   "business_date": datetime.fromtimestamp(
                                       event_server_msc / 1000.0, timezone.utc).strftime("%Y-%m-%d"),
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
            self.clock.normalize(int(new_deals[-1].get("time_msc")
                                     or int(new_deals[-1].get("time") or 0) * 1000)),
            int(new_deals[-1].get("ticket") or 0))
        tick = self.mt5.symbol_info_tick(symbol)
        if tick is None:
            raise WorkerError("symbol_tick_unavailable")
        raw_observed = int(getattr(tick, "time_msc", 0) or 0)
        observed = self.clock.normalize(raw_observed)
        return {"snapshot_version": 1, "source": "mt5", "complete": not issues,
                "incomplete_reasons": sorted(set(issues)), "warnings": sorted(set(warnings)),
                "business_date": datetime.fromtimestamp(
                    raw_observed / 1000.0, timezone.utc).strftime("%Y-%m-%d"),
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
                "selected": bool(getattr(value, "select", False)),
                "visible": bool(getattr(value, "visible", False)),
                "currency_base": str(getattr(value, "currency_base", "") or ""),
                "currency_profit": str(getattr(value, "currency_profit", "") or ""),
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

    def _history_batch(self, raw_deals: list[dict[str, Any]], raw_orders: list[Any],
                       next_time: int, next_ticket: int, has_more: bool,
                       observed_at: int) -> dict[str, Any]:
        deals: list[dict[str, Any]] = []
        history_orders: list[dict[str, Any]] = []
        trades: list[dict[str, Any]] = []
        orders_by_ticket: dict[int, dict[str, Any]] = {}
        fallback_queries = 0
        entry_in = int(getattr(self.mt5, "DEAL_ENTRY_IN", 0))
        exit_entries = {
            int(getattr(self.mt5, "DEAL_ENTRY_OUT", 1)),
            int(getattr(self.mt5, "DEAL_ENTRY_INOUT", 2)),
            int(getattr(self.mt5, "DEAL_ENTRY_OUT_BY", 3)),
        }
        buy_type = int(getattr(self.mt5, "DEAL_TYPE_BUY", 0))

        for value in raw_orders:
            if not isinstance(value, dict):
                raise WorkerError("mt5_history_order_invalid")
            try:
                ticket = int(value.get("ticket") or 0)
            except (TypeError, ValueError) as error:
                raise WorkerError("mt5_history_order_invalid") from error
            if ticket <= 0:
                raise WorkerError("mt5_history_order_invalid")
            order_row = self._history_order_row(value)
            orders_by_ticket[ticket] = order_row
            self._remember_history_context(
                self._history_orders_by_ticket, ticket, order_row)
            if order_row not in history_orders:
                history_orders.append(order_row)

        def consume_fallback_budget() -> None:
            nonlocal fallback_queries
            if fallback_queries >= MAX_HISTORY_FALLBACK_QUERIES:
                raise WorkerError("mt5_history_evidence_pending")
            fallback_queries += 1

        def history_order(order_ticket: int) -> dict[str, Any]:
            if order_ticket <= 0:
                return {}
            if order_ticket not in orders_by_ticket:
                cached = self._history_orders_by_ticket.get(order_ticket)
                if cached is not None:
                    orders_by_ticket[order_ticket] = cached
                    return cached
                consume_fallback_budget()
                values = self.mt5.history_orders_get(ticket=order_ticket)
                if values is None:
                    raise WorkerError("mt5_history_orders_unavailable")
                if values:
                    order = self._history_order_row(_plain(values[-1]))
                    orders_by_ticket[order_ticket] = order
                    self._remember_history_context(
                        self._history_orders_by_ticket, order_ticket, order)
                else:
                    self._remember_history_context(
                        self._history_orders_by_ticket, order_ticket, {})
            return orders_by_ticket.get(order_ticket, {})

        for raw in raw_deals:
            deals.append(self._history_deal_row(raw))
            try:
                entry = int(raw.get("entry") if raw.get("entry") is not None else -1)
                position_id = int(raw.get("position_id") or 0)
                order_ticket = int(raw.get("order") or 0)
            except (TypeError, ValueError) as error:
                raise WorkerError("mt5_history_item_invalid") from error
            related_order = history_order(order_ticket)
            if related_order and related_order not in history_orders:
                history_orders.append(related_order)
            if entry == entry_in and position_id > 0:
                context = {"origin": raw, "protection_order": related_order}
                self._remember_history_context(self._history_positions, position_id, context)
            if entry not in exit_entries:
                continue
            context = self._history_positions.get(position_id, {}) if position_id > 0 else {}
            origin = context.get("origin") if isinstance(context, dict) else None
            if not isinstance(origin, dict) and position_id > 0:
                consume_fallback_budget()
                values = self.mt5.history_deals_get(position=position_id)
                if values is None:
                    raise WorkerError("mt5_history_deals_unavailable")
                group = [_plain(value) for value in values]
                origin = next((value for value in group
                               if isinstance(value, dict)
                               and int(value.get("entry") if value.get("entry") is not None else -1)
                               == entry_in), raw)
            if not isinstance(origin, dict):
                origin = raw
            try:
                origin_order_ticket = int(origin.get("order") or 0)
            except (TypeError, ValueError) as error:
                raise WorkerError("mt5_history_item_invalid") from error
            protection_order = context.get("protection_order", {}) if isinstance(context, dict) else {}
            if not isinstance(protection_order, dict) or not protection_order:
                protection_order = history_order(origin_order_ticket)
            if protection_order and protection_order not in history_orders:
                history_orders.append(protection_order)
            if position_id > 0:
                self._remember_history_context(self._history_positions, position_id, {
                    "origin": origin,
                    "protection_order": protection_order,
                })
            close_server_msc = int(
                raw.get("time_msc") or int(raw.get("time") or 0) * 1000
            )
            close_utc_msc = self.clock.normalize(close_server_msc)
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
                "entry_time_server_msc": int(origin.get("time_msc")
                                             or int(origin.get("time") or 0) * 1000),
                "entry_time_utc_msc": self.clock.normalize(int(
                    origin.get("time_msc") or int(origin.get("time") or 0) * 1000)),
                "close_time": self._history_time(raw.get("time")),
                "close_time_server_msc": close_server_msc,
                "close_time_utc_msc": close_utc_msc,
                "close_time_msc": close_utc_msc,
                "close_deal_ticket": raw.get("ticket"),
                "close_timezone_offset_minutes": self.clock.offset_minutes,
                "close_business_date": datetime.fromtimestamp(
                    close_server_msc / 1000, tz=timezone.utc).strftime("%Y-%m-%d"),
                "time": self._history_time(raw.get("time")),
                "time_server_msc": int(raw.get("time_msc")
                                       or int(raw.get("time") or 0) * 1000),
                "time_utc_msc": self.clock.normalize(int(
                    raw.get("time_msc") or int(raw.get("time") or 0) * 1000)),
                "time_msc": self.clock.normalize(int(
                    raw.get("time_msc") or int(raw.get("time") or 0) * 1000)),
                "comment": str(raw.get("comment") or ""),
                "take_profit": float(protection_order.get("tp") or 0.0),
                "stop_loss": float(protection_order.get("sl") or 0.0),
            })
        return {
            "deals": deals,
            "history_orders": history_orders,
            "trades": trades,
            "next_cursor": {"time_msc": next_time, "ticket": str(next_ticket)},
            "has_more": has_more,
            "observed_at_utc_msc": observed_at,
            "timezone_offset_minutes": self.clock.offset_minutes,
            "clock_status": self.clock.status,
        }

    @staticmethod
    def _remember_history_context(cache: dict[int, Any], key: int, value: Any) -> None:
        cache.pop(key, None)
        cache[key] = value
        while len(cache) > MAX_HISTORY_CONTEXT_ITEMS:
            cache.pop(next(iter(cache)))

    @staticmethod
    def _history_time(value: Any) -> str:
        try:
            return datetime.fromtimestamp(int(value or 0), tz=timezone.utc).strftime(
                "%Y-%m-%d %H:%M:%S")
        except (OSError, OverflowError, TypeError, ValueError) as error:
            raise WorkerError("mt5_history_time_invalid") from error

    def _history_deal_row(self, row: dict[str, Any]) -> dict[str, Any]:
        server_msc = int(row.get("time_msc") or int(row.get("time") or 0) * 1000)
        utc_msc = self.clock.normalize(server_msc)
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
            "time_msc": utc_msc, "time_utc_msc": utc_msc,
            "time_server_msc": server_msc,
            "timezone_offset_minutes": self.clock.offset_minutes,
        }

    def _history_order_row(self, row: Any) -> dict[str, Any]:
        if not isinstance(row, dict):
            raise WorkerError("mt5_history_order_invalid")
        server_msc = int(row.get("time_done_msc") or row.get("time_setup_msc")
                         or int(row.get("time_done") or row.get("time_setup") or 0) * 1000)
        utc_msc = self.clock.normalize(server_msc)
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
            "time_msc": utc_msc, "time_utc_msc": utc_msc,
            "time_server_msc": server_msc,
            "timezone_offset_minutes": self.clock.offset_minutes,
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
        named = [(str(getattr(item, "name", "") or ""), item) for item in symbols]
        names = [name for name, _ in named if name]
        folded = requested.upper()
        resolved = next((name for name in names if name == requested), None)
        resolved = resolved or next((name for name in names if name.upper() == folded), None)
        if resolved is None:
            candidates = [
                (name, item) for name, item in named
                if name.upper().startswith(folded)
                and self._valid_broker_symbol_suffix(name[len(requested):])
            ]
            visible = [
                (name, item) for name, item in candidates
                if bool(getattr(item, "visible", False))
            ]
            viable = visible if visible else candidates
            if len(viable) == 1:
                resolved = viable[0][0]
            elif len(viable) > 1:
                raise WorkerError("symbol_ambiguous")
        if not resolved:
            raise WorkerError("symbol_not_found")
        select = getattr(self.mt5, "symbol_select", None)
        if callable(select) and not select(resolved, True):
            raise WorkerError("symbol_select_failed")
        self._resolved_symbols[key] = resolved
        return resolved

    @staticmethod
    def _valid_broker_symbol_suffix(suffix: str) -> bool:
        if not suffix:
            return False
        # No suffix-name whitelist or independent suffix-length cap. The full
        # symbol still follows the existing transport's 64-character boundary.
        return all(character.isalnum() or character in "._-" for character in suffix)


class Mt5Worker:
    def __init__(self, adapter: ReadOnlyMt5Adapter, route: WorkerRoute,
                 role: str = "live"):
        self.adapter = adapter
        self.route = route
        self.role = _worker_role(role)
        self.restart_error_code: str | None = None
        self.consecutive_terminal_failures = 0
        self._request_terminal_failure = False
        self._request_failure_recorded = False
        self._restart_diagnostic_reported = False
        self.trade = Mt5TradeExecutor(
            adapter.mt5,
            route,
            self._ensure_trade_identity,
            adapter._resolve_symbol,
            report_exception=_report_unexpected_exception,
        )

    def _ensure_trade_identity(self) -> tuple[Any, Any]:
        try:
            return self.adapter._ensure_identity()
        except WorkerError as error:
            self._record_restart_error(error.code)
            raise

    def _record_restart_error(self, error_code: str) -> None:
        if error_code not in TERMINAL_SESSION_FATAL_ERRORS:
            return
        self._request_terminal_failure = True
        # An identity check can be reported both through the trade callback and
        # the outer WorkerError handler.  Count one terminal fault per request,
        # not one fault per stack frame.
        if self._request_failure_recorded:
            return
        self._request_failure_recorded = True
        self.consecutive_terminal_failures = min(
            self.consecutive_terminal_failures + 1,
            TERMINAL_SESSION_FAILURE_THRESHOLD,
        )
        if self.consecutive_terminal_failures >= TERMINAL_SESSION_FAILURE_THRESHOLD:
            self.restart_error_code = error_code
            if not self._restart_diagnostic_reported:
                _report_terminal_session_failure(
                    error_code, self.consecutive_terminal_failures
                )
                self._restart_diagnostic_reported = True

    def _complete_successful_request(self, response: dict[str, Any]) -> dict[str, Any]:
        if not self._request_terminal_failure:
            self.consecutive_terminal_failures = 0
            self.restart_error_code = None
            self._restart_diagnostic_reported = False
        return response

    def handle(self, request: dict[str, Any]) -> dict[str, Any]:
        request_id = str(request.get("request_id") or "")
        self._request_terminal_failure = False
        self._request_failure_recorded = False
        try:
            self._validate_request(request)
            operation = request["operation"]
            self._validate_role_operation(operation)
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
                return self._complete_successful_request(self._response(request_id, "snapshot", {
                    "snapshot": self.adapter.collect_snapshot(streams)
                }))
            if operation == "quote":
                payload = self._request_payload(body)
                if set(payload) != {"symbol"}:
                    raise WorkerError("worker_request_payload_invalid")
                symbol = payload.get("symbol")
                if not isinstance(symbol, str) or symbol.strip() != symbol or not symbol or len(symbol) > 64:
                    raise WorkerError("worker_quote_symbol_invalid")
                return self._complete_successful_request(
                    self._response(request_id, "quote", {"quote": self.adapter.quote(symbol)})
                )
            if operation == "history_sync":
                payload = self._request_payload(body)
                if set(payload) != {"cursor", "limit"} or not isinstance(payload.get("cursor"), dict):
                    raise WorkerError("worker_request_payload_invalid")
                cursor = payload["cursor"]
                if set(cursor) != {"time_msc", "ticket"}:
                    raise WorkerError("worker_history_cursor_invalid")
                return self._complete_successful_request(self._response(request_id, "history_batch", {
                    "batch": self.adapter.history_sync(cursor, payload.get("limit"))
                }))
            if operation == "history_range_sync":
                payload = self._request_payload(body)
                if (set(payload) != {
                        "range_start_utc_msc", "range_end_utc_msc", "cursor", "limit"
                } or not isinstance(payload.get("cursor"), dict)):
                    raise WorkerError("worker_request_payload_invalid")
                cursor = payload["cursor"]
                if set(cursor) != {"time_msc", "ticket"}:
                    raise WorkerError("worker_history_range_cursor_invalid")
                return self._complete_successful_request(self._response(
                    request_id, "history_batch", {"batch": self.adapter.history_range_sync(
                        payload.get("range_start_utc_msc"),
                        payload.get("range_end_utc_msc"),
                        cursor,
                        payload.get("limit"),
                    )}
                ))
            if operation == "data":
                payload = self._request_payload(body)
                if set(payload) != {"action", "params"} or not isinstance(payload.get("params"), dict):
                    raise WorkerError("worker_request_payload_invalid")
                action = payload.get("action")
                if action not in {"rates", "symbols", "symbol_snapshot", "risk_snapshot",
                                  "performance_daily", "pending_order_state", "diagnostics", "terminal_clock"}:
                    raise WorkerError("worker_data_action_invalid")
                return self._complete_successful_request(self._response(request_id, "data", {"data": {
                    "action": action,
                    "observed_at_utc_msc": self.adapter.clock.now_utc_msc(),
                    "payload": self.adapter.data(action, payload["params"]),
                }}))
            if operation in {"execute_command", "query_execution"}:
                if set(body) != {"command"} or not isinstance(body.get("command"), dict):
                    raise WorkerError("worker_request_payload_invalid")
                command = body["command"]
                self._validate_command(request_id, operation, command)
                self.adapter._ensure_identity()
                result = self.trade.execute(command, read_only=operation == "query_execution")
                return self._complete_successful_request(
                    self._response(request_id, "command_result", {"result": result})
                )
            raise WorkerError("worker_operation_unsupported")
        except WorkerError as error:
            self._record_restart_error(error.code)
            return self._response(request_id, "error", {"error_code": error.code})
        except Exception as error:
            _report_unexpected_exception("worker_handle", error)
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

    def _validate_role_operation(self, operation: Any) -> None:
        if self.role == "live":
            if operation in {"history_sync", "history_range_sync"}:
                raise WorkerError("worker_role_operation_forbidden")
            return
        if operation != "history_range_sync":
            raise WorkerError("worker_role_operation_forbidden")

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
    role = role_from_environment()
    terminal_path = _required_env("AURUM_BRIDGE_WORKER_TERMINAL_PATH")
    portable = os.environ.get("AURUM_BRIDGE_WORKER_PORTABLE", "0")
    if portable not in ("0", "1"):
        raise WorkerError("worker_environment_invalid")
    adapter = ReadOnlyMt5Adapter(mt5, terminal_path, route, clock_state_path=_clock_state_path(route),
                                portable=portable == "1", expected_data_path=os.environ.get("AURUM_BRIDGE_WORKER_DATA_PATH"))
    adapter.connect()
    pipe_name = _required_env("AURUM_BRIDGE_WORKER_PIPE")
    nonce = _required_env("AURUM_BRIDGE_WORKER_NONCE")
    worker = Mt5Worker(adapter, route, role=role)
    try:
        with open(rf"\\.\pipe\{pipe_name}", "r+b", buffering=0) as stream:
            write_frame(stream, {
                "ipc_v": IPC_VERSION,
                "type": "worker_hello",
                "session_nonce": nonce,
                "worker_version": WORKER_VERSION,
                "route": route.payload(),
                "role": role,
                "capabilities": list(
                    ARCHIVE_CAPABILITIES if role == "archive" else LIVE_CAPABILITIES
                ),
            })
            while True:
                write_frame(stream, worker.handle(read_frame(stream)))
                if worker.restart_error_code is not None:
                    return
    except EOFError:
        pass
    finally:
        adapter.shutdown()


def _verify_terminal_location(terminal: Any, requested_path: str, expected_data_path: str | None) -> tuple[str, str]:
    actual_directory = str(getattr(terminal, "path", "") or "")
    actual_data = str(getattr(terminal, "data_path", "") or "")
    if not actual_directory or not actual_data or not Path(actual_directory).is_absolute() or not Path(actual_data).is_absolute():
        raise WorkerError("mt5_terminal_location_unavailable")
    actual_executable = str(Path(actual_directory) / "terminal64.exe")
    if _normalized_terminal_path(actual_executable) != _normalized_terminal_path(requested_path):
        raise WorkerError("mt5_terminal_path_mismatch")
    if expected_data_path and _normalized_terminal_path(actual_data) != _normalized_terminal_path(expected_data_path):
        raise WorkerError("mt5_terminal_data_path_mismatch")
    return str(Path(actual_executable).resolve()), str(Path(actual_data).resolve())


def probe_terminal(mt5: Any, terminal_path: str, portable: bool = False,
                   expected_data_path: str | None = None) -> dict[str, Any]:
    resolved_path = str(Path(terminal_path).resolve())
    if not Path(resolved_path).is_file():
        raise WorkerError("mt5_terminal_not_found")
    _require_terminal_running(resolved_path)
    try:
        initialized = mt5.initialize(path=resolved_path, timeout=10_000, portable=portable)
    except Exception as error:
        raise WorkerError("mt5_initialize_failed") from error
    if not initialized:
        raise WorkerError("mt5_initialize_failed")
    try:
        try:
            account = mt5.account_info()
        except Exception as error:
            raise WorkerError("mt5_account_unavailable") from error
        broker_server = str(getattr(account, "server", "") or "").strip()
        login = str(getattr(account, "login", "") or "").strip()
        if account is None or not broker_server or not login:
            raise WorkerError("mt5_account_unavailable")
        try:
            terminal = mt5.terminal_info()
        except Exception as error:
            raise WorkerError("mt5_terminal_disconnected") from error
        if terminal is None or not bool(getattr(terminal, "connected", False)):
            raise WorkerError("mt5_terminal_disconnected")
        actual_path, actual_data = _verify_terminal_location(terminal, resolved_path, expected_data_path)
        return {
            "probe_version": 1,
            "terminal_path": actual_path,
            "data_path": actual_data,
            "account_ref": {"broker_server": broker_server, "login": login},
        }
    finally:
        try:
            mt5.shutdown()
        except Exception:
            # A failed cleanup must not replace the structured probe result.
            pass


def main(mt5: Any, arguments: list[str]) -> None:
    if arguments:
        if len(arguments) not in (3, 4) or arguments[0] != "--probe" or arguments[1] != "--terminal" or (len(arguments) == 4 and arguments[3] != "--portable"):
            raise WorkerError("worker_arguments_invalid")
        terminal_path = str(Path(arguments[2]).resolve())
        try:
            result = probe_terminal(mt5, arguments[2], len(arguments) == 4,
                                    os.environ.get("AURUM_BRIDGE_WORKER_DATA_PATH"))
        except WorkerError as error:
            print(json.dumps({
                "probe_version": 1,
                "terminal_path": terminal_path,
                "error_code": _probe_error_code(error.code),
                "last_error": _probe_last_error(mt5),
            }, ensure_ascii=False, separators=(",", ":")))
            raise SystemExit(2) from error
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
        return
    run(mt5)


if __name__ == "__main__":
    import MetaTrader5 as mt5

    main(mt5, sys.argv[1:])
