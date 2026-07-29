from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
import time


REPOSITORY = Path(__file__).resolve().parents[2]
WORKER_DIRECTORY = REPOSITORY / "bridge" / "native" / "workers" / "mt5"
sys.path.insert(0, str(WORKER_DIRECTORY))

from trade import Mt5TradeExecutor  # noqa: E402
from worker import ReadOnlyMt5Adapter, WorkerRoute  # noqa: E402


def command(route: WorkerRoute, action: str, params: dict, command_id: str) -> dict:
    now = int(time.time() * 1000)
    return {
        "v": 3,
        "type": "command",
        "message_id": f"message_{command_id}",
        "sent_at_utc_msc": now,
        "command_id": command_id,
        "terminal_instance_id": route.terminal_instance_id,
        "account_ref": {"broker_server": route.broker_server, "login": route.login},
        "connection_epoch": route.connection_epoch,
        "issued_at_utc_msc": now,
        "deadline_utc_msc": now + 30_000,
        "action": action,
        "params": params,
    }


def safe_result(result: dict) -> dict:
    return {
        "status": result.get("status"),
        "error_code": result.get("error_code"),
        "evidence": result.get("evidence"),
    }


def find_test_position(mt5, symbol: str, comment: str):
    for _ in range(20):
        positions = mt5.positions_get(symbol=symbol)
        if positions is None:
            raise RuntimeError("mt5_positions_query_failed")
        match = next((position for position in positions
                      if int(getattr(position, "magic", 0) or 0) == 234000
                      and str(getattr(position, "comment", "") or "") == comment), None)
        if match is not None:
            return match
        time.sleep(0.25)
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify the native MT5 adapter on a demo account")
    parser.add_argument("--terminal", required=True)
    parser.add_argument("--symbol", required=True)
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args()

    import MetaTrader5 as mt5

    terminal_path = str(Path(args.terminal).resolve())
    if not mt5.initialize(path=terminal_path, timeout=10_000, portable=False):
        raise RuntimeError("mt5_initialize_failed")
    account = mt5.account_info()
    if account is None:
        raise RuntimeError("mt5_account_unavailable")
    route = WorkerRoute(
        "mt5_demo_acceptance_01",
        "mt5",
        str(account.server),
        str(account.login),
        1,
    )
    adapter = ReadOnlyMt5Adapter(mt5, terminal_path, route)
    try:
        adapter._ensure_identity()
        symbol = adapter._resolve_symbol(args.symbol)
        info = mt5.symbol_info(symbol)
        terminal = mt5.terminal_info()
        existing = mt5.positions_get(symbol=symbol)
        readiness = {
            "account": str(account.login),
            "server": str(account.server),
            "demo": int(getattr(account, "trade_mode", -1))
            == int(getattr(mt5, "ACCOUNT_TRADE_MODE_DEMO", 0)),
            "symbol": symbol,
            "existing_positions": len(existing) if existing is not None else None,
            "volume_min": float(getattr(info, "volume_min", 0) or 0) if info else None,
            "account_trade_allowed": bool(getattr(account, "trade_allowed", False)),
            "account_trade_expert": bool(getattr(account, "trade_expert", False)),
            "terminal_trade_allowed": bool(getattr(terminal, "trade_allowed", False)),
            "terminal_tradeapi_disabled": bool(getattr(terminal, "tradeapi_disabled", False)),
        }
        if not args.execute:
            print(json.dumps({"mode": "read_only", "readiness": readiness}, ensure_ascii=False))
            return 0
        if not readiness["demo"]:
            raise RuntimeError("demo_account_required")
        if existing is None or existing:
            raise RuntimeError("test_symbol_must_have_no_existing_position")
        if not info or not readiness["volume_min"]:
            raise RuntimeError("symbol_trade_contract_unavailable")
        if not (readiness["account_trade_allowed"] and readiness["account_trade_expert"]
                and readiness["terminal_trade_allowed"]
                and not readiness["terminal_tradeapi_disabled"]):
            raise RuntimeError("mt5_trade_permission_unavailable")

        executor = Mt5TradeExecutor(mt5, route, adapter._ensure_identity, adapter._resolve_symbol)
        suffix = str(int(time.time() * 1000))[-10:]
        trade_comment = f"LJ3-{suffix}"
        opened = executor.execute(command(route, "place_order", {
            "symbol": args.symbol,
            "side": "buy",
            "order_kind": "market",
            "volume": readiness["volume_min"],
            "magic": 234000,
            "comment": trade_comment,
        }, f"command_demo_open_{suffix}"))
        position = find_test_position(mt5, symbol, trade_comment)
        if position is None:
            print(json.dumps({"mode": "execute", "readiness": readiness,
                              "open": safe_result(opened), "cleanup": "position_not_found"},
                             ensure_ascii=False))
            return 2
        expected = {
            "ticket": str(position.ticket),
            "symbol": str(position.symbol),
            "direction": "buy" if int(position.type) == int(mt5.POSITION_TYPE_BUY) else "sell",
            "magic": int(position.magic),
            "volume": float(position.volume),
        }
        closed = executor.execute(command(route, "close_position", {
            "ticket": str(position.ticket),
            "volume": float(position.volume),
            "expected_state": expected,
        }, f"command_demo_close_{suffix}"))
        remaining = mt5.positions_get(ticket=position.ticket)
        cleaned = remaining is not None and len(remaining) == 0
        print(json.dumps({"mode": "execute", "readiness": readiness,
                          "open": safe_result(opened), "close": safe_result(closed),
                          "position_ticket": str(position.ticket), "cleaned": cleaned},
                         ensure_ascii=False))
        return 0 if opened.get("status") == "succeeded" and cleaned else 3
    finally:
        mt5.shutdown()


if __name__ == "__main__":
    raise SystemExit(main())
