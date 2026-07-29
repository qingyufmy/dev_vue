from __future__ import annotations

import hashlib
import json
import math
import os
import struct
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO

IPC_VERSION = 1
WORKER_VERSION = "3.0.0-alpha.1"
MAX_FRAME_BYTES = 4 * 1024 * 1024
MAX_SNAPSHOT_ITEMS = 10_000
DEFAULT_TIMEZONE_OFFSET_MINUTES = 180
CLOCK_FRESHNESS_TOLERANCE_MS = 30_000
CLOCK_STALE_AFTER_MS = 120_000


class WorkerError(RuntimeError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


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
        if not self._trusted:
            raise WorkerError("mt5_clock_unverified")
        self._save()
        return self.normalize(raw_msc)


class ReadOnlyMt5Adapter:
    def __init__(self, mt5: Any, terminal_path: str, route: WorkerRoute,
                 clock_msc: Any | None = None, clock_state_path: Path | None = None):
        self.mt5 = mt5
        self.terminal_path = str(Path(terminal_path).resolve())
        self.route = route
        self.clock = BrokerClock(clock_state_path, clock_msc)
        self._resolved_symbols: dict[str, str] = {}

    def connect(self) -> None:
        if not Path(self.terminal_path).is_file():
            raise WorkerError("mt5_terminal_not_found")
        if not self.mt5.initialize(path=self.terminal_path, timeout=10_000, portable=False):
            raise WorkerError("mt5_initialize_failed")
        self._ensure_identity()

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


class ReadOnlyWorker:
    def __init__(self, adapter: ReadOnlyMt5Adapter, route: WorkerRoute):
        self.adapter = adapter
        self.route = route

    def handle(self, request: dict[str, Any]) -> dict[str, Any]:
        request_id = str(request.get("request_id") or "")
        try:
            self._validate_request(request)
            operation = request["operation"]
            body = request.get("payload")
            if (not isinstance(body, dict) or set(body) != {"request"}
                    or not isinstance(body.get("request"), dict)):
                raise WorkerError("worker_request_payload_invalid")
            payload = body["request"]
            if operation == "collect_snapshot":
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
                if set(payload) != {"symbol"}:
                    raise WorkerError("worker_request_payload_invalid")
                symbol = payload.get("symbol")
                if not isinstance(symbol, str) or symbol.strip() != symbol or not symbol or len(symbol) > 64:
                    raise WorkerError("worker_quote_symbol_invalid")
                return self._response(request_id, "quote", {"quote": self.adapter.quote(symbol)})
            raise WorkerError("worker_operation_unsupported")
        except WorkerError as error:
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
    worker = ReadOnlyWorker(adapter, route)
    try:
        with open(rf"\\.\pipe\{pipe_name}", "r+b", buffering=0) as stream:
            write_frame(stream, {
                "ipc_v": IPC_VERSION,
                "type": "worker_hello",
                "session_nonce": nonce,
                "worker_version": WORKER_VERSION,
                "route": route.payload(),
                "capabilities": ["snapshot", "quote"],
            })
            while True:
                write_frame(stream, worker.handle(read_frame(stream)))
    except EOFError:
        pass
    finally:
        adapter.shutdown()


if __name__ == "__main__":
    import MetaTrader5 as mt5

    run(mt5)
