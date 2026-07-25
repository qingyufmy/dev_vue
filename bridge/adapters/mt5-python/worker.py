from __future__ import annotations

import argparse
import json
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
            result["positions"] = _plain(self.mt5.positions_get() or ())
        if "orders" in streams:
            result["orders"] = _plain(self.mt5.orders_get() or ())
        return result

    def execute(self, command: dict[str, Any]) -> dict[str, Any]:
        command_id = str(command.get("command_id") or "")
        if command_id in self._receipts:
            return self._receipts[command_id]
        self._validate_route(command)
        deadline = int(command.get("deadline_utc_msc") or 0)
        if deadline <= int(time.time() * 1000):
            return self._remember(command_id, self._result(command, "rejected", "command_expired"))
        self._ensure_identity()
        action = command.get("action")
        params = command.get("params")
        if not isinstance(params, dict):
            return self._remember(command_id, self._result(command, "rejected", "command_params_invalid"))
        try:
            if action == "place_order":
                result = self._place_order(command, params)
            elif action == "cancel_order":
                result = self._cancel_order(command, params)
            elif action == "modify_order":
                result = self._modify_order(command, params)
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

    def _close_position(self, command: dict[str, Any], params: dict[str, Any]) -> dict[str, Any]:
        ticket = int(self._required_text(params, "ticket"))
        positions = self.mt5.positions_get(ticket=ticket) or ()
        if len(positions) != 1:
            raise WorkerError("position_not_found")
        position = positions[0]
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

    def _query_execution(self, command: dict[str, Any], params: dict[str, Any]) -> dict[str, Any]:
        order_tickets: list[str] = []
        position_tickets: list[str] = []
        deal_tickets: list[str] = []
        ticket = params.get("ticket")
        if ticket is not None:
            order_tickets.extend(str(item.ticket) for item in (self.mt5.orders_get(ticket=int(ticket)) or ()))
            position_tickets.extend(str(item.ticket) for item in (self.mt5.positions_get(ticket=int(ticket)) or ()))
        from_time = int(params.get("from_time") or (time.time() - 7 * 86400))
        to_time = int(params.get("to_time") or time.time())
        deals = self.mt5.history_deals_get(from_time, to_time) or ()
        expected_position = str(params.get("position_ticket") or "")
        expected_order = str(params.get("order_ticket") or ticket or "")
        for deal in deals:
            if (expected_position and str(getattr(deal, "position_id", "")) == expected_position) or (
                expected_order and str(getattr(deal, "order", "")) == expected_order
            ):
                deal_tickets.append(str(deal.ticket))
        return self._result(command, "succeeded", raw_result={"query": "completed"}, evidence={
            "order_tickets": order_tickets,
            "position_tickets": position_tickets,
            "deal_tickets": deal_tickets,
        })

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
            else:
                response = {"v": 3, "type": "worker_error", "request_id": request.get("request_id"),
                            "error_code": "worker_request_type_unsupported"}
            write_frame(stream, response)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pipe", required=True)
    parser.add_argument("--terminal", required=True)
    parser.add_argument("--terminal-id", required=True)
    parser.add_argument("--broker-server", required=True)
    parser.add_argument("--login", required=True)
    parser.add_argument("--connection-epoch", required=True, type=int)
    args = parser.parse_args()
    import MetaTrader5 as mt5  # bundled module; intentionally imported only in the Worker entrypoint
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
