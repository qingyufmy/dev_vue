from __future__ import annotations

import io
import math
import sys
import tempfile
import time
import unittest
from collections import namedtuple
from pathlib import Path
from types import SimpleNamespace

WORKER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(WORKER_DIR))

from worker import (  # noqa: E402
    ReadOnlyMt5Adapter,
    Mt5Worker,
    WorkerError,
    WorkerRoute,
    read_frame,
    write_frame,
)

Account = namedtuple(
    "Account", "login server balance equity margin_free trade_allowed trade_expert")
Terminal = namedtuple("Terminal", "connected trade_allowed tradeapi_disabled")
Position = namedtuple("Position", "ticket symbol volume type magic sl tp")
Order = namedtuple(
    "Order",
    "ticket symbol volume_initial volume_current type magic comment price_open sl tp price_stoplimit time_expiration",
)
Symbol = namedtuple(
    "Symbol", "name trade_mode digits point trade_tick_size volume_min volume_max volume_step filling_mode")
Tick = namedtuple("Tick", "bid ask last time_msc")


class FakeMt5:
    TRADE_ACTION_DEAL = 1
    TRADE_ACTION_PENDING = 5
    TRADE_ACTION_SLTP = 6
    TRADE_ACTION_MODIFY = 7
    TRADE_ACTION_REMOVE = 8
    ORDER_TYPE_BUY = 0
    ORDER_TYPE_SELL = 1
    ORDER_TYPE_BUY_LIMIT = 2
    ORDER_TYPE_SELL_LIMIT = 3
    ORDER_TYPE_BUY_STOP = 4
    ORDER_TYPE_SELL_STOP = 5
    ORDER_TYPE_BUY_STOP_LIMIT = 6
    ORDER_TYPE_SELL_STOP_LIMIT = 7
    POSITION_TYPE_BUY = 0
    ORDER_TIME_GTC = 0
    ORDER_FILLING_FOK = 0
    ORDER_FILLING_IOC = 1
    ORDER_FILLING_RETURN = 2
    TRADE_RETCODE_PLACED = 10008
    TRADE_RETCODE_DONE = 10009
    TRADE_RETCODE_DONE_PARTIAL = 10010
    ORDER_STATE_CANCELED = 2
    ORDER_STATE_PARTIAL = 3
    ORDER_STATE_FILLED = 4
    ORDER_STATE_REJECTED = 5
    ORDER_STATE_EXPIRED = 6

    def __init__(self, now: int):
        self.now = now
        self.initialized = False
        self.sent = []
        self.checks = []
        self.positions = [Position(101, "XAUUSD.s", 0.01, 0, 234000, 2290.0, 2320.0)]
        self.orders = [Order(202, "XAUUSD.s", 0.02, 0.02, 2, 234000, "AI-PENDING",
                             2280.0, 2270.0, 2310.0, 0.0, 0)]

    def initialize(self, **_kwargs):
        self.initialized = True
        return True

    def shutdown(self):
        self.initialized = False

    def account_info(self):
        return Account(123456, "Broker-Demo", 10_000.0, 10_025.0, 9_500.0, True, True)

    def terminal_info(self):
        return Terminal(True, True, False)

    def positions_get(self, **kwargs):
        ticket = kwargs.get("ticket")
        symbol = kwargs.get("symbol")
        return tuple(item for item in self.positions
                     if (ticket is None or item.ticket == ticket)
                     and (symbol is None or item.symbol == symbol))

    def orders_get(self, **kwargs):
        ticket = kwargs.get("ticket")
        symbol = kwargs.get("symbol")
        return tuple(item for item in self.orders
                     if (ticket is None or item.ticket == ticket)
                     and (symbol is None or item.symbol == symbol))

    def symbols_get(self):
        return (self.symbol_info("XAUUSD.s"),)

    def symbol_select(self, _symbol, _enabled):
        return True

    def symbol_info(self, _symbol):
        return Symbol("XAUUSD.s", 4, 2, 0.01, 0.01, 0.01, 100.0, 0.01, 2)

    def symbol_info_tick(self, _symbol):
        return Tick(2300.0, 2300.2, 2300.1, self.now + 180 * 60_000)

    def order_check(self, request):
        self.checks.append(dict(request))
        return SimpleNamespace(retcode=0, comment="ok")

    def order_send(self, request):
        self.sent.append(dict(request))
        action = request["action"]
        if action == self.TRADE_ACTION_REMOVE:
            self.orders = [item for item in self.orders if item.ticket != request["order"]]
        elif action == self.TRADE_ACTION_SLTP:
            self.positions = [item._replace(sl=request["sl"], tp=request["tp"])
                              if item.ticket == request["position"] else item
                              for item in self.positions]
        elif action == self.TRADE_ACTION_MODIFY:
            self.orders = [item._replace(
                price_open=request.get("price", item.price_open),
            ) if item.ticket == request["order"] else item for item in self.orders]
        elif action == self.TRADE_ACTION_DEAL and request.get("position"):
            self.positions = [item for item in self.positions
                              if item.ticket != request["position"]]
        return SimpleNamespace(retcode=10009, order=1001, deal=2001, comment="done")

    def history_orders_get(self, *_args, **_kwargs):
        return ()

    def history_deals_get(self, *_args, **_kwargs):
        return ()


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.now = 1_800_000_000_000
        self.route = WorkerRoute("terminal_01", "mt5", "Broker-Demo", "123456", 7)
        self.temporary = tempfile.TemporaryDirectory()
        self.terminal_path = Path(self.temporary.name) / "terminal64.exe"
        self.terminal_path.touch()
        self.mt5 = FakeMt5(self.now)
        self.adapter = ReadOnlyMt5Adapter(
            self.mt5,
            str(self.terminal_path),
            self.route,
            clock_msc=lambda: self.now,
        )
        self.adapter.connect()
        self.worker = Mt5Worker(self.adapter, self.route)
        self.worker.trade._clock_msc = lambda: self.now

    def tearDown(self):
        self.temporary.cleanup()

    def request(self, operation, payload, request_id="request_01JTEST001"):
        return {
            "ipc_v": 1,
            "type": "worker_request",
            "request_id": request_id,
            "route": self.route.payload(),
            "operation": operation,
            "payload": {"request": payload},
        }

    def command(self, action="place_order", params=None,
                command_id="command_01JTEST001"):
        return {
            "v": 3,
            "type": "command",
            "message_id": "message_01JTEST001",
            "sent_at_utc_msc": self.now,
            "command_id": command_id,
            "terminal_instance_id": self.route.terminal_instance_id,
            "account_ref": {"broker_server": self.route.broker_server,
                            "login": self.route.login},
            "connection_epoch": self.route.connection_epoch,
            "issued_at_utc_msc": self.now,
            "deadline_utc_msc": self.now + 10_000,
            "action": action,
            "params": params or {"symbol": "XAUUSD", "side": "buy", "volume": 0.01},
        }

    def command_request(self, operation, command):
        request = self.request(operation, {}, command["command_id"])
        request["payload"] = {"command": command}
        return request

    def test_snapshot_preserves_account_positions_and_orders(self):
        response = self.worker.handle(self.request("collect_snapshot", {
            "streams": ["account", "positions", "orders"]
        }))
        self.assertEqual("snapshot", response["outcome"])
        snapshot = response["payload"]["snapshot"]
        self.assertGreater(snapshot["source_time_msc"], 0)
        self.assertEqual(123456, snapshot["streams"]["account"]["login"])
        self.assertTrue(snapshot["streams"]["account"]["terminal_trade_allowed"])
        self.assertEqual(101, snapshot["streams"]["positions"][0]["ticket"])
        self.assertEqual(202, snapshot["streams"]["orders"][0]["ticket"])

    def test_quote_resolves_suffix_and_normalizes_broker_time(self):
        response = self.worker.handle(self.request("quote", {"symbol": "XAUUSD"}))
        self.assertEqual("quote", response["outcome"])
        quote = response["payload"]["quote"]
        self.assertEqual("XAUUSD", quote["requested_symbol"])
        self.assertEqual("XAUUSD.s", quote["symbol"])
        self.assertEqual(self.now, quote["observed_at_utc_msc"])
        self.assertEqual(180, quote["timezone_offset_minutes"])
        self.assertEqual("verified", quote["clock_status"])

    def test_cross_account_request_is_rejected(self):
        request = self.request("quote", {"symbol": "XAUUSD"})
        request["route"]["account_ref"]["login"] = "999999"
        response = self.worker.handle(request)
        self.assertEqual("error", response["outcome"])
        self.assertEqual("worker_request_route_mismatch", response["payload"]["error_code"])

    def test_unknown_request_fields_are_rejected(self):
        request = self.request("quote", {"symbol": "XAUUSD"})
        request["unexpected"] = True
        response = self.worker.handle(request)
        self.assertEqual("worker_request_protocol_invalid", response["payload"]["error_code"])

    def test_identity_change_fails_closed_on_every_request(self):
        self.mt5.account_info = lambda: Account(
            999999, "Broker-Demo", 10_000.0, 10_000.0, 10_000.0, True, True
        )
        response = self.worker.handle(self.request("collect_snapshot", {"streams": ["account"]}))
        self.assertEqual("mt5_login_mismatch", response["payload"]["error_code"])

    def test_non_finite_json_is_not_written(self):
        with self.assertRaises(WorkerError) as context:
            write_frame(io.BytesIO(), {"value": math.nan})
        self.assertEqual("worker_frame_json_invalid", context.exception.code)

    def test_frame_round_trip_uses_little_endian_length_prefix(self):
        stream = io.BytesIO()
        write_frame(stream, {"ok": True})
        stream.seek(0)
        self.assertEqual({"ok": True}, read_frame(stream))

    def test_market_order_is_prechecked_sent_once_and_cached(self):
        command = self.command(params={
            "symbol": "XAUUSD", "side": "buy", "volume": 0.01,
            "stop_loss": 2290.0, "take_profit": 2320.0, "comment": "AI-2S",
        })
        request = self.command_request("execute_command", command)

        first = self.worker.handle(request)
        second = self.worker.handle(request)

        self.assertEqual("command_result", first["outcome"])
        self.assertEqual("succeeded", first["payload"]["result"]["status"])
        self.assertEqual(first, second)
        self.assertEqual(1, len(self.mt5.checks))
        self.assertEqual(1, len(self.mt5.sent))
        self.assertEqual("XAUUSD.s", self.mt5.sent[0]["symbol"])
        self.assertEqual("AI-2S", self.mt5.sent[0]["comment"])

    def test_every_order_kind_maps_to_the_exact_mt5_request(self):
        cases = (
            ("market", "buy", self.mt5.TRADE_ACTION_DEAL, self.mt5.ORDER_TYPE_BUY),
            ("market", "sell", self.mt5.TRADE_ACTION_DEAL, self.mt5.ORDER_TYPE_SELL),
            ("limit", "buy", self.mt5.TRADE_ACTION_PENDING, self.mt5.ORDER_TYPE_BUY_LIMIT),
            ("limit", "sell", self.mt5.TRADE_ACTION_PENDING, self.mt5.ORDER_TYPE_SELL_LIMIT),
            ("stop", "buy", self.mt5.TRADE_ACTION_PENDING, self.mt5.ORDER_TYPE_BUY_STOP),
            ("stop", "sell", self.mt5.TRADE_ACTION_PENDING, self.mt5.ORDER_TYPE_SELL_STOP),
            ("stop_limit", "buy", self.mt5.TRADE_ACTION_PENDING,
             self.mt5.ORDER_TYPE_BUY_STOP_LIMIT),
            ("stop_limit", "sell", self.mt5.TRADE_ACTION_PENDING,
             self.mt5.ORDER_TYPE_SELL_STOP_LIMIT),
        )
        for index, (kind, side, expected_action, expected_type) in enumerate(cases):
            with self.subTest(kind=kind, side=side):
                params = {"symbol": "XAUUSD", "side": side, "order_kind": kind,
                          "volume": 0.01, "price": 2300.1}
                if kind == "stop_limit":
                    params["stop_limit_price"] = 2300.0
                command = self.command("place_order", params, f"command_01JKIND{index:02d}")
                response = self.worker.handle(self.command_request("execute_command", command))
                self.assertEqual("succeeded", response["payload"]["result"]["status"])
                request = self.mt5.sent[-1]
                self.assertEqual(expected_action, request["action"])
                self.assertEqual(expected_type, request["type"])
                if kind == "stop_limit":
                    self.assertEqual(2300.0, request["stoplimit"])

    def test_trade_permission_is_revalidated_immediately_before_send(self):
        self.mt5.terminal_info = lambda: Terminal(True, True, True)
        response = self.worker.handle(self.command_request(
            "execute_command", self.command()))

        result = response["payload"]["result"]
        self.assertEqual("rejected", result["status"])
        self.assertEqual("mt5_trade_api_disabled", result["error_code"])
        self.assertEqual([], self.mt5.checks)
        self.assertEqual([], self.mt5.sent)

    def test_order_check_rejection_never_calls_order_send(self):
        self.mt5.order_check = lambda request: SimpleNamespace(retcode=10013, comment="invalid")

        response = self.worker.handle(self.command_request("execute_command", self.command()))

        result = response["payload"]["result"]
        self.assertEqual("rejected", result["status"])
        self.assertEqual("mt5_check_retcode_10013", result["error_code"])
        self.assertEqual([], self.mt5.sent)

    def test_account_route_drift_is_rejected_before_trade_adapter(self):
        command = self.command()
        command["account_ref"]["login"] = "999999"

        response = self.worker.handle(self.command_request("execute_command", command))

        self.assertEqual("error", response["outcome"])
        self.assertEqual("worker_request_route_mismatch", response["payload"]["error_code"])
        self.assertEqual([], self.mt5.sent)

    def test_cancel_and_modify_pending_orders_use_exact_mt5_actions(self):
        cancel = self.command("cancel_order", {"ticket": "202"}, "command_01JCANCEL01")
        cancelled = self.worker.handle(self.command_request("execute_command", cancel))
        self.assertEqual("succeeded", cancelled["payload"]["result"]["status"])
        self.assertEqual(self.mt5.TRADE_ACTION_REMOVE, self.mt5.sent[-1]["action"])

        self.mt5.orders = [Order(303, "XAUUSD.s", 0.02, 0.02, 2, 234000,
                                 "AI-MODIFY", 2280.0, 2270.0, 2310.0, 0.0, 0)]
        modify = self.command("modify_order", {
            "ticket": "303", "price": 2299.0,
        }, "command_01JMODIFY01")
        modified = self.worker.handle(self.command_request("execute_command", modify))
        self.assertEqual("succeeded", modified["payload"]["result"]["status"])
        self.assertEqual(self.mt5.TRADE_ACTION_MODIFY, self.mt5.sent[-1]["action"])

    def test_guarded_position_modify_and_close_are_post_verified(self):
        expected = {"ticket": "101", "symbol": "XAUUSD.s", "direction": "buy",
                    "magic": 234000, "volume": 0.01,
                    "stop_loss": 2290.0, "take_profit": 2320.0}
        modify = self.command("modify_position", {
            "ticket": "101", "symbol": "XAUUSD.s", "side": "buy",
            "volume": 0.01, "magic": 234000, "stop_loss": 2295.0,
            "take_profit": None, "expected_state": expected,
        }, "command_01JPROTECT1")
        modified = self.worker.handle(self.command_request("execute_command", modify))
        self.assertEqual("succeeded", modified["payload"]["result"]["status"])
        self.assertEqual(2295.0, self.mt5.positions[0].sl)

        expected["stop_loss"] = 2295.0
        close = self.command("close_position", {
            "ticket": "101", "volume": 0.01, "expected_state": expected,
        }, "command_01JCLOSE001")
        closed = self.worker.handle(self.command_request("execute_command", close))
        self.assertEqual("succeeded", closed["payload"]["result"]["status"])
        self.assertEqual([], self.mt5.positions)

    def test_query_execution_is_read_only_and_matches_durable_comment(self):
        self.mt5.positions = [Position(501, "XAUUSD.s", 0.01, 0, 234000, 0.0, 0.0)]
        self.mt5.positions[0] = SimpleNamespace(**self.mt5.positions[0]._asdict(), comment="AI-LOOKUP")
        command = self.command("query_execution", {
            "symbol": "XAUUSD", "expected_kind": "trade",
            "bridge_command_ref": "AI-LOOKUP", "lookback_seconds": 3600,
        }, "command_01JQUERY001")

        response = self.worker.handle(self.command_request("query_execution", command))

        result = response["payload"]["result"]
        self.assertEqual("succeeded", result["status"])
        self.assertTrue(result["raw_result"]["found"])
        self.assertEqual(["501"], result["evidence"]["position_tickets"])
        self.assertEqual([], self.mt5.checks)
        self.assertEqual([], self.mt5.sent)

    def test_missing_order_result_is_uncertain_and_never_replayed(self):
        self.mt5.order_send = lambda request: self.mt5.sent.append(dict(request))
        command = self.command(command_id="command_01JUNCERTAIN")
        request = self.command_request("execute_command", command)

        first = self.worker.handle(request)
        second = self.worker.handle(request)

        self.assertEqual("uncertain", first["payload"]["result"]["status"])
        self.assertEqual("mt5_order_result_missing", first["payload"]["result"]["error_code"])
        self.assertEqual(first, second)
        self.assertEqual(1, len(self.mt5.sent))

    def test_broker_rejection_and_send_exception_have_distinct_finality(self):
        self.mt5.order_send = lambda request: SimpleNamespace(
            retcode=10013, order=0, deal=0, comment="invalid")
        rejected_command = self.command(command_id="command_01JREJECTED")
        rejected = self.worker.handle(self.command_request("execute_command", rejected_command))
        self.assertEqual("rejected", rejected["payload"]["result"]["status"])
        self.assertEqual("mt5_retcode_10013", rejected["payload"]["result"]["error_code"])

        def fail_send(_request):
            raise RuntimeError("transport failed")

        self.mt5.order_send = fail_send
        uncertain_command = self.command(command_id="command_01JEXCEPTION")
        uncertain = self.worker.handle(self.command_request("execute_command", uncertain_command))
        self.assertEqual("uncertain", uncertain["payload"]["result"]["status"])
        self.assertEqual("mt5_order_send_exception", uncertain["payload"]["result"]["error_code"])

    def test_query_execution_maps_historical_pending_final_state(self):
        self.mt5.orders = []
        self.mt5.history_orders_get = lambda *_args, **_kwargs: (
            SimpleNamespace(ticket=202, order=202, position_id=501,
                            symbol="XAUUSD.s", magic=234000, comment="AI-PENDING",
                            state=self.mt5.ORDER_STATE_FILLED),
        )
        command = self.command("query_execution", {
            "symbol": "XAUUSD", "expected_kind": "pending",
            "pending_ticket": "202", "lookback_seconds": 3600,
        }, "command_01JQUERYPEND")

        response = self.worker.handle(self.command_request("query_execution", command))

        lookup = response["payload"]["result"]["raw_result"]
        self.assertTrue(lookup["found"])
        self.assertEqual("filled", lookup["pending_state"])
        self.assertEqual("filled", lookup["final_state"])
        self.assertEqual("history_order", lookup["current_state"])

    def test_place_order_reconciliation_waits_before_final_not_found(self):
        self.mt5.positions = []
        original = {"symbol": "XAUUSD", "side": "buy", "volume": 0.01}
        params = {
            "symbol": "XAUUSD", "expected_kind": "trade",
            "bridge_command_ref": "AI-MISSING", "magic": 234000,
            "lookback_seconds": 3600, "original_action": "place_order",
            "original_params": original, "original_command_id": "command_01JORIGINAL1",
            "original_issued_at_utc_msc": self.now, "settle_after_msc": 15_000,
        }

        pending = self.worker.handle(self.command_request(
            "query_execution",
            self.command("query_execution", params, "query_01JRECON001"),
        ))
        self.assertEqual(
            {"status": "pending", "error_code": "reconciliation_settlement_pending"},
            pending["payload"]["result"]["raw_result"]["resolution"],
        )

        self.now += 15_001
        failed = self.worker.handle(self.command_request(
            "query_execution",
            self.command("query_execution", params, "query_01JRECON002"),
        ))
        self.assertEqual(
            {"status": "failed", "error_code": "execution_not_found_after_settlement"},
            failed["payload"]["result"]["raw_result"]["resolution"],
        )
        self.assertEqual([], self.mt5.sent)

    def test_reconciliation_resolves_observed_place_cancel_and_position_modify(self):
        self.mt5.positions = [SimpleNamespace(
            ticket=501, symbol="XAUUSD.s", volume=0.01, type=0, magic=777,
            sl=2295.0, tp=2325.0, comment="AI-OBSERVED",
        )]
        place_params = {
            "symbol": "XAUUSD", "expected_kind": "trade",
            "bridge_command_ref": "AI-OBSERVED", "magic": 777,
            "original_action": "place_order",
            "original_params": {"symbol": "XAUUSD", "side": "buy", "volume": 0.01,
                                "magic": 777, "comment": "AI-OBSERVED"},
            "original_command_id": "command_01JPLACE001",
            "original_issued_at_utc_msc": self.now, "settle_after_msc": 15_000,
        }
        placed = self.worker.handle(self.command_request(
            "query_execution", self.command("query_execution", place_params, "query_01JPLACE001")
        ))
        placed_raw = placed["payload"]["result"]["raw_result"]
        self.assertEqual({"status": "succeeded"}, placed_raw["resolution"])
        self.assertEqual(777, placed_raw["magic"])

        cancel_params = {
            "expected_kind": "pending", "ticket": "999",
            "original_action": "cancel_order", "original_params": {"ticket": "999"},
            "original_command_id": "command_01JCANCEL99",
            "original_issued_at_utc_msc": self.now, "settle_after_msc": 15_000,
        }
        cancelled = self.worker.handle(self.command_request(
            "query_execution", self.command("query_execution", cancel_params, "query_01JCANCEL99")
        ))
        self.assertEqual(
            {"status": "succeeded"},
            cancelled["payload"]["result"]["raw_result"]["resolution"],
        )

        modify_params = {
            "expected_kind": "trade", "ticket": "501", "symbol": "XAUUSD",
            "original_action": "modify_position",
            "original_params": {"ticket": "501", "symbol": "XAUUSD",
                                "side": "buy", "volume": 0.01, "magic": 777,
                                "stop_loss": 2295.0, "take_profit": 2325.0},
            "original_command_id": "command_01JMODPOS01",
            "original_issued_at_utc_msc": self.now, "settle_after_msc": 15_000,
        }
        modified = self.worker.handle(self.command_request(
            "query_execution", self.command("query_execution", modify_params, "query_01JMODPOS01")
        ))
        self.assertEqual(
            {"status": "succeeded"},
            modified["payload"]["result"]["raw_result"]["resolution"],
        )
        self.assertEqual([], self.mt5.sent)

    def test_reconciliation_prefers_durable_ticket_when_broker_changes_comment(self):
        self.mt5.positions = [SimpleNamespace(
            ticket=501, symbol="XAUUSD.s", volume=0.01, type=0, magic=777,
            sl=0.0, tp=0.0, comment="BROKER-REWRITTEN",
        )]
        params = {
            "symbol": "XAUUSD", "expected_kind": "trade", "ticket": "501",
            "bridge_command_ref": "AI-ORIGINAL", "magic": 777,
            "original_action": "place_order",
            "original_params": {"symbol": "XAUUSD", "side": "buy", "volume": 0.01,
                                "magic": 777, "comment": "AI-ORIGINAL"},
            "original_command_id": "command_01JTICKET01",
            "original_issued_at_utc_msc": self.now, "settle_after_msc": 15_000,
        }
        response = self.worker.handle(self.command_request(
            "query_execution", self.command("query_execution", params, "query_01JTICKET01")
        ))
        raw = response["payload"]["result"]["raw_result"]
        self.assertTrue(raw["found"])
        self.assertEqual("BROKER-REWRITTEN", raw["comment"])
        self.assertEqual({"status": "succeeded"}, raw["resolution"])


if __name__ == "__main__":
    unittest.main()
