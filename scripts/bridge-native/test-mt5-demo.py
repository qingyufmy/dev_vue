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

SYSTEM_MAGIC = 234000


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
                      if int(getattr(position, "magic", 0) or 0) == SYSTEM_MAGIC
                      and str(getattr(position, "comment", "") or "") == comment), None)
        if match is not None:
            return match
        time.sleep(0.25)
    return None


def find_test_order(mt5, symbol: str, comment: str):
    for _ in range(20):
        orders = mt5.orders_get(symbol=symbol)
        if orders is None:
            raise RuntimeError("mt5_orders_query_failed")
        match = next((order for order in orders
                      if int(getattr(order, "magic", 0) or 0) == SYSTEM_MAGIC
                      and str(getattr(order, "comment", "") or "") == comment), None)
        if match is not None:
            return match
        time.sleep(0.25)
    return None


def expected_state(mt5, item, kind: str) -> dict:
    if kind == "position":
        direction = "buy" if int(item.type) == int(mt5.POSITION_TYPE_BUY) else "sell"
        volume = float(item.volume)
    else:
        buy_types = {
            int(mt5.ORDER_TYPE_BUY_LIMIT), int(mt5.ORDER_TYPE_BUY_STOP),
            int(mt5.ORDER_TYPE_BUY_STOP_LIMIT),
        }
        direction = "buy" if int(item.type) in buy_types else "sell"
        volume = float(getattr(item, "volume_current", 0)
                       or getattr(item, "volume_initial", 0) or 0)
    return {
        "ticket": str(item.ticket),
        "symbol": str(item.symbol),
        "direction": direction,
        "magic": int(item.magic),
        "volume": volume,
        "stop_loss": float(getattr(item, "sl", 0) or 0),
        "take_profit": float(getattr(item, "tp", 0) or 0),
    }


def normalized_price(info, value: float) -> float:
    tick_size = float(getattr(info, "trade_tick_size", 0)
                      or getattr(info, "point", 0) or 1e-8)
    digits = max(0, int(getattr(info, "digits", 0) or 0))
    return round(round(value / tick_size) * tick_size, digits)


def require_succeeded(label: str, result: dict) -> None:
    if result.get("status") != "succeeded":
        raise RuntimeError(f"{label}:{result.get('error_code') or result.get('status')}")


def cleanup_test_objects(mt5, executor: Mt5TradeExecutor, route: WorkerRoute,
                         symbol: str, comment: str, suffix: str) -> dict:
    cleanup: dict = {"orders": [], "positions": []}
    orders = mt5.orders_get(symbol=symbol)
    if orders is None:
        cleanup["orders_query"] = "failed"
    else:
        for order in orders:
            if int(getattr(order, "magic", 0) or 0) != SYSTEM_MAGIC \
                    or str(getattr(order, "comment", "") or "") != comment:
                continue
            result = executor.execute(command(route, "cancel_order", {
                "ticket": str(order.ticket),
                "expected_state": expected_state(mt5, order, "pending"),
            }, f"command_demo_cleanup_order_{suffix}_{order.ticket}"))
            cleanup["orders"].append({"ticket": str(order.ticket), **safe_result(result)})
    positions = mt5.positions_get(symbol=symbol)
    if positions is None:
        cleanup["positions_query"] = "failed"
    else:
        for position in positions:
            if int(getattr(position, "magic", 0) or 0) != SYSTEM_MAGIC \
                    or str(getattr(position, "comment", "") or "") != comment:
                continue
            result = executor.execute(command(route, "close_position", {
                "ticket": str(position.ticket),
                "volume": float(position.volume),
                "expected_state": expected_state(mt5, position, "position"),
            }, f"command_demo_cleanup_position_{suffix}_{position.ticket}"))
            cleanup["positions"].append({"ticket": str(position.ticket), **safe_result(result)})
    remaining_orders = mt5.orders_get(symbol=symbol)
    remaining_positions = mt5.positions_get(symbol=symbol)
    cleanup["cleaned"] = remaining_orders is not None and remaining_positions is not None \
        and not any(int(getattr(item, "magic", 0) or 0) == SYSTEM_MAGIC
                    and str(getattr(item, "comment", "") or "") == comment
                    for item in (*remaining_orders, *remaining_positions))
    return cleanup


def execute_rejection_matrix(mt5, executor: Mt5TradeExecutor, route: WorkerRoute,
                             requested_symbol: str, symbol: str, info, volume: float) -> dict:
    suffix = str(int(time.time() * 1000))[-10:]
    comment = f"LJ3R-{suffix}"
    report: dict = {"comment": comment}
    try:
        below_minimum = max(volume / 2, 1e-10)
        local_rejection = executor.execute(command(route, "place_order", {
            "symbol": requested_symbol,
            "side": "buy",
            "order_kind": "market",
            "volume": below_minimum,
            "magic": SYSTEM_MAGIC,
            "comment": comment,
        }, f"command_demo_local_rejection_{suffix}"))
        report["local_validation"] = safe_result(local_rejection)
        if local_rejection.get("status") != "rejected" \
                or local_rejection.get("error_code") != "order_volume_below_minimum":
            raise RuntimeError("local_validation_rejection_mismatch")

        tick = mt5.symbol_info_tick(symbol)
        if tick is None:
            raise RuntimeError("symbol_tick_unavailable")
        point = float(getattr(info, "point", 0) or 0)
        minimum_points = max(int(getattr(info, "trade_stops_level", 0) or 0), 10)
        invalid_stop = normalized_price(info, float(tick.ask) + point * minimum_points)
        broker_rejection = executor.execute(command(route, "place_order", {
            "symbol": requested_symbol,
            "side": "buy",
            "order_kind": "market",
            "volume": volume,
            "stop_loss": invalid_stop,
            "magic": SYSTEM_MAGIC,
            "comment": comment,
        }, f"command_demo_broker_rejection_{suffix}"))
        raw = broker_rejection.get("raw_result") or {}
        check = raw.get("check") if isinstance(raw, dict) else None
        report["broker_rule"] = {
            **safe_result(broker_rejection),
            "check_retcode": check.get("retcode") if isinstance(check, dict) else None,
        }
        error_code = str(broker_rejection.get("error_code") or "")
        if broker_rejection.get("status") != "rejected" \
                or not error_code.startswith(("mt5_check_retcode_", "mt5_retcode_")):
            raise RuntimeError("broker_rule_rejection_mismatch")
    except Exception as error:
        report["failure"] = str(error)
    finally:
        report["cleanup"] = cleanup_test_objects(
            mt5, executor, route, symbol, comment, suffix
        )
    report["passed"] = "failure" not in report and report["cleanup"]["cleaned"] is True
    return report


def execute_full_matrix(mt5, executor: Mt5TradeExecutor, route: WorkerRoute,
                        requested_symbol: str, symbol: str, info, volume: float) -> dict:
    suffix = str(int(time.time() * 1000))[-10:]
    comment = f"LJ3M-{suffix}"
    report: dict = {"comment": comment}
    try:
        volume_step = float(getattr(info, "volume_step", 0) or volume)
        volume_max = float(getattr(info, "volume_max", 0) or 0)
        matrix_volume = round(volume + volume_step, 8)
        if volume_max and matrix_volume > volume_max + 1e-8:
            raise RuntimeError("partial_close_volume_unavailable")
        tick = mt5.symbol_info_tick(symbol)
        if tick is None:
            raise RuntimeError("symbol_tick_unavailable")
        point = float(getattr(info, "point", 0) or 0)
        minimum_points = max(int(getattr(info, "trade_stops_level", 0) or 0),
                             int(getattr(info, "trade_freeze_level", 0) or 0), 100)
        distance = max(point * minimum_points, float(getattr(info, "trade_tick_size", 0) or 0) * 10)
        pending_price = normalized_price(info, float(tick.bid) - distance * 2)
        changed_price = normalized_price(info, pending_price - distance)

        placed = executor.execute(command(route, "place_order", {
            "symbol": requested_symbol,
            "side": "buy",
            "order_kind": "limit",
            "volume": volume,
            "price": pending_price,
            "magic": SYSTEM_MAGIC,
            "comment": comment,
        }, f"command_demo_pending_{suffix}"))
        report["pending_place"] = safe_result(placed)
        require_succeeded("pending_place", placed)
        pending = find_test_order(mt5, symbol, comment)
        if pending is None:
            raise RuntimeError("pending_order_not_found")
        report["pending_ticket"] = str(pending.ticket)

        modified = executor.execute(command(route, "modify_order", {
            "ticket": str(pending.ticket),
            "price": changed_price,
            "expected_state": expected_state(mt5, pending, "pending"),
        }, f"command_demo_pending_modify_{suffix}"))
        report["pending_modify"] = safe_result(modified)
        require_succeeded("pending_modify", modified)
        refreshed = mt5.orders_get(ticket=pending.ticket)
        if refreshed is None or len(refreshed) != 1:
            raise RuntimeError("modified_pending_order_not_found")
        if abs(float(refreshed[0].price_open) - changed_price) > max(point / 2, 1e-8):
            raise RuntimeError("modified_pending_price_mismatch")

        cancelled = executor.execute(command(route, "cancel_order", {
            "ticket": str(refreshed[0].ticket),
            "expected_state": expected_state(mt5, refreshed[0], "pending"),
        }, f"command_demo_pending_cancel_{suffix}"))
        report["pending_cancel"] = safe_result(cancelled)
        require_succeeded("pending_cancel", cancelled)
        if mt5.orders_get(ticket=pending.ticket) != ():
            raise RuntimeError("cancelled_pending_order_still_active")

        opened = executor.execute(command(route, "place_order", {
            "symbol": requested_symbol,
            "side": "buy",
            "order_kind": "market",
            "volume": matrix_volume,
            "magic": SYSTEM_MAGIC,
            "comment": comment,
        }, f"command_demo_open_{suffix}"))
        report["open"] = safe_result(opened)
        require_succeeded("open", opened)
        position = find_test_position(mt5, symbol, comment)
        if position is None:
            raise RuntimeError("test_position_not_found")
        report["position_ticket"] = str(position.ticket)

        tick = mt5.symbol_info_tick(symbol)
        if tick is None:
            raise RuntimeError("symbol_tick_unavailable")
        protection_distance = distance * 2
        stop_loss = normalized_price(info, float(tick.bid) - protection_distance)
        take_profit = normalized_price(info, float(tick.ask) + protection_distance)
        protected = executor.execute(command(route, "modify_position", {
            "ticket": str(position.ticket),
            "symbol": str(position.symbol),
            "side": "buy",
            "volume": float(position.volume),
            "magic": SYSTEM_MAGIC,
            "stop_loss": stop_loss,
            "take_profit": take_profit,
            "expected_stop_loss": float(position.sl or 0),
            "expected_take_profit": float(position.tp or 0),
            "expected_state": expected_state(mt5, position, "position"),
        }, f"command_demo_protect_{suffix}"))
        report["position_modify"] = safe_result(protected)
        require_succeeded("position_modify", protected)
        refreshed_position = mt5.positions_get(ticket=position.ticket)
        if refreshed_position is None or len(refreshed_position) != 1:
            raise RuntimeError("protected_position_not_found")

        partially_closed = executor.execute(command(route, "close_position", {
            "ticket": str(refreshed_position[0].ticket),
            "volume": volume,
            "expected_state": expected_state(mt5, refreshed_position[0], "position"),
        }, f"command_demo_partial_close_{suffix}"))
        report["partial_close"] = safe_result(partially_closed)
        require_succeeded("partial_close", partially_closed)
        remaining_position = mt5.positions_get(ticket=position.ticket)
        if remaining_position is None or len(remaining_position) != 1:
            raise RuntimeError("partial_close_remaining_position_missing")
        if abs(float(remaining_position[0].volume) - volume) > max(volume_step / 2, 1e-8):
            raise RuntimeError("partial_close_remaining_volume_mismatch")

        closed = executor.execute(command(route, "close_position", {
            "ticket": str(remaining_position[0].ticket),
            "volume": float(remaining_position[0].volume),
            "expected_state": expected_state(mt5, remaining_position[0], "position"),
        }, f"command_demo_close_{suffix}"))
        report["close"] = safe_result(closed)
        require_succeeded("close", closed)
        if mt5.positions_get(ticket=position.ticket) != ():
            raise RuntimeError("closed_position_still_active")
    except Exception as error:
        report["failure"] = str(error)
    finally:
        report["cleanup"] = cleanup_test_objects(mt5, executor, route, symbol, comment, suffix)
    report["passed"] = "failure" not in report and report["cleanup"]["cleaned"] is True
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify the native MT5 adapter on a demo account")
    parser.add_argument("--terminal", required=True)
    parser.add_argument("--symbol", required=True)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--matrix", action="store_true",
                        help="exercise pending, modify, cancel, protection and close")
    parser.add_argument("--faults", action="store_true",
                        help="exercise local and broker rejection paths without leaving trades")
    args = parser.parse_args()
    if (args.matrix or args.faults) and not args.execute:
        parser.error("--matrix and --faults require --execute")
    if args.matrix and args.faults:
        parser.error("--matrix and --faults are mutually exclusive")

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
        existing_orders = mt5.orders_get(symbol=symbol)
        readiness = {
            "account": str(account.login),
            "server": str(account.server),
            "demo": int(getattr(account, "trade_mode", -1))
            == int(getattr(mt5, "ACCOUNT_TRADE_MODE_DEMO", 0)),
            "symbol": symbol,
            "existing_positions": len(existing) if existing is not None else None,
            "existing_orders": len(existing_orders) if existing_orders is not None else None,
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
        if existing_orders is None:
            raise RuntimeError("test_symbol_orders_unavailable")
        if args.matrix and any(int(getattr(order, "magic", 0) or 0) == SYSTEM_MAGIC
                               for order in existing_orders):
            raise RuntimeError("test_symbol_must_have_no_existing_system_order")
        if not info or not readiness["volume_min"]:
            raise RuntimeError("symbol_trade_contract_unavailable")
        if not (readiness["account_trade_allowed"] and readiness["account_trade_expert"]
                and readiness["terminal_trade_allowed"]
                and not readiness["terminal_tradeapi_disabled"]):
            raise RuntimeError("mt5_trade_permission_unavailable")

        executor = Mt5TradeExecutor(mt5, route, adapter._ensure_identity, adapter._resolve_symbol)
        if args.faults:
            faults = execute_rejection_matrix(
                mt5, executor, route, args.symbol, symbol, info, readiness["volume_min"]
            )
            print(json.dumps({"mode": "faults", "readiness": readiness, **faults},
                             ensure_ascii=False))
            return 0 if faults["passed"] else 5
        if args.matrix:
            matrix = execute_full_matrix(
                mt5, executor, route, args.symbol, symbol, info, readiness["volume_min"]
            )
            print(json.dumps({"mode": "matrix", "readiness": readiness, **matrix},
                             ensure_ascii=False))
            return 0 if matrix["passed"] else 4
        suffix = str(int(time.time() * 1000))[-10:]
        trade_comment = f"LJ3-{suffix}"
        opened = executor.execute(command(route, "place_order", {
            "symbol": args.symbol,
            "side": "buy",
            "order_kind": "market",
            "volume": readiness["volume_min"],
            "magic": SYSTEM_MAGIC,
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
