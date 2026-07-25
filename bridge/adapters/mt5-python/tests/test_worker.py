import io
import sys
import time
import unittest
from collections import namedtuple
from pathlib import Path
from types import SimpleNamespace
import importlib.util

MODULE_PATH = Path(__file__).resolve().parents[1] / "worker.py"
SPEC = importlib.util.spec_from_file_location("aurum_mt5_worker", MODULE_PATH)
worker = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = worker
SPEC.loader.exec_module(worker)


Account = namedtuple("Account", "login server balance")
Terminal = namedtuple("Terminal", "connected")
Tick = namedtuple("Tick", "bid ask")
Result = namedtuple("Result", "retcode order deal comment")
Deal = namedtuple("Deal", "ticket time time_msc type entry position_id profit commission swap fee")


class FakeMt5:
    TIMEFRAME_M1 = 1
    TIMEFRAME_M5 = 5
    TIMEFRAME_M15 = 15
    TIMEFRAME_M30 = 30
    TIMEFRAME_H1 = 60
    TIMEFRAME_H4 = 240
    TIMEFRAME_D1 = 1440
    TRADE_ACTION_DEAL = 1
    TRADE_ACTION_PENDING = 5
    TRADE_ACTION_MODIFY = 7
    TRADE_ACTION_REMOVE = 8
    TRADE_ACTION_SLTP = 6
    ORDER_TYPE_BUY = 0
    ORDER_TYPE_SELL = 1
    ORDER_TYPE_BUY_LIMIT = 2
    ORDER_TYPE_SELL_LIMIT = 3
    ORDER_TYPE_BUY_STOP = 4
    ORDER_TYPE_SELL_STOP = 5
    ORDER_TYPE_BUY_STOP_LIMIT = 6
    ORDER_TYPE_SELL_STOP_LIMIT = 7
    ORDER_TIME_GTC = 0
    ORDER_FILLING_RETURN = 2
    POSITION_TYPE_BUY = 0
    TRADE_RETCODE_PLACED = 10008
    TRADE_RETCODE_DONE = 10009
    TRADE_RETCODE_DONE_PARTIAL = 10010

    def __init__(self):
        self.sent = []
        self.calculations = []

    def account_info(self): return Account(12345678, "Broker-Demo", 1000)
    def terminal_info(self): return Terminal(True)
    def positions_get(self, **kwargs): return ()
    def orders_get(self, **kwargs): return ()
    def history_deals_get(self, *args): return ()
    def history_orders_get(self, *args): return ()
    def symbol_info_tick(self, symbol): return Tick(2300.0, 2300.2)
    def symbol_info(self, symbol): return SimpleNamespace(trade_mode=4)
    def symbol_select(self, symbol, enabled): return True
    def copy_rates_from_pos(self, symbol, timeframe, offset, count):
        return [(1_700_000_000, 2300.0, 2301.0, 2299.0, 2300.5, 42, 12)]
    def copy_rates_range(self, symbol, timeframe, start, end):
        return self.copy_rates_from_pos(symbol, timeframe, 0, 1)
    def order_send(self, request):
        self.sent.append(request)
        return Result(10009, 1001, 2001, "done")
    def order_calc_profit(self, order_type, symbol, volume, entry, stop_loss):
        self.calculations.append(("profit", order_type, symbol, volume, entry, stop_loss))
        return -100.0
    def order_calc_margin(self, order_type, symbol, volume, entry):
        self.calculations.append(("margin", order_type, symbol, volume, entry))
        return 250.0
    def last_error(self): return (0, "ok")
    def initialize(self, **kwargs): return True
    def shutdown(self): pass


class WorkerTests(unittest.TestCase):
    def adapter(self):
        return worker.Mt5Adapter(FakeMt5(), __file__, worker.WorkerIdentity(
            "terminal_01JWORKER01", "Broker-Demo", "12345678", 7))

    def command(self, **overrides):
        value = {
            "v": 3, "type": "command", "command_id": "command_01JWORKER01",
            "terminal_instance_id": "terminal_01JWORKER01",
            "account_ref": {"broker_server": "Broker-Demo", "login": "12345678"},
            "connection_epoch": 7, "deadline_utc_msc": int(time.time() * 1000) + 5000,
            "action": "place_order", "params": {"symbol": "XAUUSD", "side": "buy", "volume": "0.01"},
        }
        value.update(overrides)
        return value

    def test_frame_round_trip(self):
        stream = io.BytesIO()
        worker.write_frame(stream, {"v": 3, "type": "collect", "text": "交易"})
        stream.seek(0)
        self.assertEqual("交易", worker.read_frame(stream)["text"])

    def test_rejects_oversized_frame_before_reading_payload(self):
        stream = io.BytesIO((worker.MAX_FRAME_BYTES + 1).to_bytes(4, "little"))
        with self.assertRaisesRegex(worker.WorkerError, "worker_frame_size_invalid"):
            worker.read_frame(stream)

    def test_collection_failure_cannot_be_reported_as_an_empty_trade_snapshot(self):
        for stream, method_name, error_code in (
            ("positions", "positions_get", "mt5_positions_unavailable"),
            ("orders", "orders_get", "mt5_orders_unavailable"),
        ):
            with self.subTest(stream=stream):
                adapter = self.adapter()
                setattr(adapter.mt5, method_name, lambda **kwargs: None)
                with self.assertRaises(worker.WorkerError) as raised:
                    adapter.collect([stream])
                self.assertEqual(error_code, raised.exception.code)

    def test_executes_matching_command_and_caches_result(self):
        adapter = self.adapter()
        command = self.command()
        first = adapter.execute(command)
        second = adapter.execute(command)
        self.assertEqual("succeeded", first["status"])
        self.assertEqual(first, second)
        self.assertEqual(1, len(adapter.mt5.sent))
        self.assertEqual("AURUM:" + command["command_id"][-20:], adapter.mt5.sent[0]["comment"])

    def test_rejects_cross_account_route_before_order_send(self):
        adapter = self.adapter()
        command = self.command(account_ref={"broker_server": "Broker-Demo", "login": "999"})
        result = adapter.execute(command)
        self.assertEqual("rejected", result["status"])
        self.assertEqual("command_route_mismatch", result["error_code"])
        self.assertEqual([], adapter.mt5.sent)

    def test_rejects_expired_command_without_order_send(self):
        adapter = self.adapter()
        result = adapter.execute(self.command(deadline_utc_msc=1))
        self.assertEqual("rejected", result["status"])
        self.assertEqual("command_expired", result["error_code"])
        self.assertEqual([], adapter.mt5.sent)

    def test_management_close_revalidates_target_immediately_before_send(self):
        adapter = self.adapter()
        adapter.mt5.positions_get = lambda **kwargs: (SimpleNamespace(
            ticket=10, symbol="XAUUSD", type=0, volume=0.05, magic=234000),)
        expected = {
            "ticket": "10", "symbol": "XAUUSD", "direction": "buy",
            "volume": 0.1, "magic": 234000,
        }
        result = adapter.execute(self.command(
            action="close_position",
            params={"ticket": "10", "volume": 0.1, "expected_state": expected},
        ))
        self.assertEqual("rejected", result["status"])
        self.assertEqual("management_volume_mismatch", result["error_code"])
        self.assertEqual([], adapter.mt5.sent)

    def test_management_close_matching_position_sends_inverse_market_order(self):
        adapter = self.adapter()
        position = SimpleNamespace(ticket=10, symbol="XAUUSD", type=0, volume=0.1,
                                   magic=234000)
        adapter.mt5.positions_get = lambda **kwargs: (position,)
        expected = {
            "ticket": "10", "symbol": "XAUUSD", "direction": "buy",
            "volume": 0.1, "magic": 234000,
        }
        result = adapter.execute(self.command(
            action="close_position",
            params={"ticket": "10", "volume": 0.1, "expected_state": expected},
        ))
        self.assertEqual("succeeded", result["status"])
        request = adapter.mt5.sent[0]
        self.assertEqual(1, request["action"])
        self.assertEqual(10, request["position"])
        self.assertEqual(1, request["type"])
        self.assertEqual(2300.0, request["price"])

    def test_management_cancel_is_idempotent_when_target_is_absent(self):
        adapter = self.adapter()
        expected = {
            "ticket": "20", "symbol": "XAUUSD", "direction": "buy",
            "volume": 0.1, "magic": 234000,
        }
        result = adapter.execute(self.command(
            action="cancel_order", params={"ticket": "20", "expected_state": expected},
        ))
        self.assertEqual("succeeded", result["status"])
        self.assertTrue(result["raw_result"]["already_absent"])
        self.assertEqual([], adapter.mt5.sent)

    def test_management_cancel_existing_pending_order_sends_remove(self):
        adapter = self.adapter()
        order = SimpleNamespace(ticket=20, symbol="XAUUSD", type=2, volume_current=0.1,
                                volume_initial=0.1, magic=234000)
        adapter.mt5.orders_get = lambda **kwargs: (order,)
        expected = {
            "ticket": "20", "symbol": "XAUUSD", "direction": "buy",
            "volume": 0.1, "magic": 234000,
        }
        result = adapter.execute(self.command(
            action="cancel_order", params={"ticket": "20", "expected_state": expected},
        ))
        self.assertEqual("succeeded", result["status"])
        self.assertEqual(8, adapter.mt5.sent[0]["action"])
        self.assertEqual(20, adapter.mt5.sent[0]["order"])

    def test_modify_pending_order_sends_requested_prices(self):
        adapter = self.adapter()
        result = adapter.execute(self.command(action="modify_order", params={
            "ticket": "20", "price": 2299.0, "stop_loss": 2290.0,
            "take_profit": 2320.0, "expiration": 1_900_000_000,
        }))
        self.assertEqual("succeeded", result["status"])
        request = adapter.mt5.sent[0]
        self.assertEqual(7, request["action"])
        self.assertEqual(20, request["order"])
        self.assertEqual(2299.0, request["price"])
        self.assertEqual(2290.0, request["sl"])
        self.assertEqual(2320.0, request["tp"])

    def test_modify_position_revalidates_and_verifies_protection(self):
        adapter = self.adapter()
        before = SimpleNamespace(ticket=10, symbol="XAUUSD", type=0, volume=0.1,
                                 magic=234000, sl=2290.0, tp=2320.0)
        after = SimpleNamespace(ticket=10, symbol="XAUUSD", type=0, volume=0.1,
                                magic=234000, sl=2295.0, tp=2320.0)
        adapter.mt5.positions_get = lambda **kwargs: (after if adapter.mt5.sent else before,)
        adapter.mt5.symbol_info = lambda symbol: SimpleNamespace(
            point=0.01, trade_tick_size=0.01, digits=2,
            trade_stops_level=10, trade_freeze_level=0)
        expected = {
            "ticket": "10", "symbol": "XAUUSD", "direction": "buy", "volume": 0.1,
            "magic": 234000, "stop_loss": 2290.0, "take_profit": 2320.0,
        }
        result = adapter.execute(self.command(action="modify_position", params={
            "ticket": "10", "stop_loss": 2295.0, "take_profit": None,
            "magic": 234000, "expected_state": expected,
        }))
        self.assertEqual("succeeded", result["status"])
        self.assertEqual(2295.0, result["raw_result"]["stop_loss"])
        self.assertEqual(6, adapter.mt5.sent[0]["action"])

    def test_modify_position_rejects_changed_protection_without_send(self):
        adapter = self.adapter()
        current = SimpleNamespace(ticket=10, symbol="XAUUSD", type=0, volume=0.1,
                                  magic=234000, sl=2291.0, tp=2320.0)
        adapter.mt5.positions_get = lambda **kwargs: (current,)
        adapter.mt5.symbol_info = lambda symbol: SimpleNamespace(
            point=0.01, trade_tick_size=0.01, digits=2,
            trade_stops_level=10, trade_freeze_level=0)
        result = adapter.execute(self.command(action="modify_position", params={
            "ticket": "10", "stop_loss": 2295.0,
            "expected_state": {"ticket": "10", "symbol": "XAUUSD", "direction": "buy",
                               "volume": 0.1, "magic": 234000,
                               "stop_loss": 2290.0, "take_profit": 2320.0},
        }))
        self.assertEqual("rejected", result["status"])
        self.assertEqual("position_stop_loss_changed", result["error_code"])
        self.assertEqual([], adapter.mt5.sent)

    def test_returns_transient_quote_for_matching_route(self):
        adapter = self.adapter()
        request = self.command(
            type="quote_request", request_id="quote_01JWORKER01", symbol="XAUUSD")
        result = adapter.quote(request)
        self.assertEqual("succeeded", result["status"])
        self.assertEqual(2300.0, result["bid"])
        self.assertEqual(2300.2, result["ask"])
        self.assertEqual(4, result["symbol_trade_mode"])
        self.assertTrue(result["terminal_connected"])
        self.assertNotIn("command_id", result)

    def test_rejects_cross_account_quote_route(self):
        adapter = self.adapter()
        request = self.command(
            type="quote_request", request_id="quote_01JWORKER02", symbol="XAUUSD",
            account_ref={"broker_server": "Broker-Demo", "login": "999"})
        result = adapter.quote(request)
        self.assertEqual("rejected", result["status"])
        self.assertEqual("command_route_mismatch", result["error_code"])

    def test_returns_rates_over_transient_data_channel(self):
        adapter = self.adapter()
        request = self.command(
            type="data_request", request_id="data_01JWORKER01", action="rates",
            params={"symbol": "XAUUSD", "timeframe": "M30", "count": 100})
        result = adapter.data(request)
        self.assertEqual("succeeded", result["status"])
        self.assertEqual("rates", result["action"])
        self.assertEqual(1, result["payload"]["count"])
        self.assertEqual(1_700_000_000_000, result["payload"]["rates"][0]["time_utc_msc"])
        self.assertNotIn("command_id", result)

    def test_rejects_invalid_rates_before_mt5_query(self):
        adapter = self.adapter()
        request = self.command(
            type="data_request", request_id="data_01JWORKER02", action="rates",
            params={"symbol": "XAUUSD", "timeframe": "S1", "count": 100})
        result = adapter.data(request)
        self.assertEqual("rejected", result["status"])
        self.assertEqual("rates_timeframe_invalid", result["error_code"])

    def test_returns_lightweight_symbol_snapshot(self):
        adapter = self.adapter()
        adapter.mt5.symbol_info = lambda symbol: SimpleNamespace(
            name=symbol, digits=2, trade_mode=4, point=0.01,
            trade_tick_size=0.01, trade_tick_value=1.0,
            trade_contract_size=100.0, volume_min=0.01,
            volume_max=100.0, volume_step=0.01)
        adapter.mt5.order_calc_margin = lambda order_type, symbol, volume, price: 1000.0 * volume
        result = adapter.data(self.command(
            type="data_request", request_id="data_01JWORKER03", action="symbol_snapshot",
            params={"symbol": "XAUUSD"}))
        self.assertEqual("succeeded", result["status"])
        self.assertEqual(100.0, result["payload"]["instrument"]["contract_size"])
        self.assertEqual(1000.0, result["payload"]["instrument"]["margin_per_lot_buy"])
        self.assertNotIn("positions", result["payload"])

    def test_risk_snapshot_uses_time_and_ticket_as_incremental_cursor(self):
        adapter = self.adapter()
        event_time = 1_700_000_000_000
        adapter.mt5.history_deals_get = lambda *args, **kwargs: (
            Deal(10, event_time // 1000, event_time, 2, 0, 0, 100.0, 0.0, 0.0, 0.0),
            Deal(11, event_time // 1000, event_time, 2, 0, 0, -25.0, 0.0, 0.0, 0.0),
        )
        result = adapter.data(self.command(
            type="data_request", request_id="data_01JWORKER04", action="risk_snapshot",
            params={"symbol": "XAUUSD", "last_deal_time_msc": event_time,
                    "last_deal_ticket": 10, "baseline_from_utc_msc": 0,
                    "proposed_order": {"symbol": "XAUUSD", "order_type": "buy_limit",
                                       "volume": 0.1, "entry_price": 2300.0, "sl": 2290.0}}))
        self.assertEqual("succeeded", result["status"])
        snapshot = result["payload"]
        self.assertTrue(snapshot["complete"])
        self.assertEqual(1, snapshot["increment"]["new_deal_count"])
        self.assertEqual(11, snapshot["increment"]["account_events"][0]["ticket"])
        self.assertEqual({"time_msc": event_time, "ticket": 11},
                         snapshot["increment"]["through_cursor"])
        self.assertEqual("utc_direct", snapshot["clock_status"])
        self.assertEqual(0, adapter.mt5.calculations[0][1])
        self.assertEqual(100.0, snapshot["broker_calculation"]["loss_to_sl"])

    def test_query_execution_matches_exact_durable_comment(self):
        adapter = self.adapter()
        adapter.mt5.positions_get = lambda **kwargs: (
            SimpleNamespace(ticket=501, position_id=501, symbol="XAUUSD", magic=234000,
                            comment="intent:abc"),
            SimpleNamespace(ticket=999, position_id=999, symbol="XAUUSD", magic=234000,
                            comment="intent:other"),
        )
        result = adapter.execute(self.command(
            command_id="command_01JWORKER_LOOKUP", action="query_execution",
            params={"symbol": "XAUUSD", "expected_kind": "trade",
                    "bridge_command_ref": "intent:abc", "trade_ticket": "999",
                    "lookback_seconds": 3600}))
        self.assertEqual("succeeded", result["status"])
        self.assertTrue(result["raw_result"]["found"])
        self.assertEqual(501, result["raw_result"]["position_id"])
        self.assertEqual(["501"], result["evidence"]["position_tickets"])

    def test_query_execution_accepts_ticket_without_symbol(self):
        adapter = self.adapter()
        adapter.mt5.orders_get = lambda **kwargs: ()
        history_queries = []
        adapter.mt5.history_orders_get = lambda *args, **kwargs: history_queries.append((args, kwargs)) or ()
        result = adapter.execute(self.command(
            command_id="command_01JWORKER_LOOKUP_TICKET", action="query_execution",
            params={"expected_kind": "pending", "pending_ticket": "5003",
                    "lookback_seconds": 3600}))
        self.assertEqual("succeeded", result["status"])
        self.assertFalse(result["raw_result"]["found"])
        self.assertTrue(result["raw_result"]["complete"])
        self.assertEqual([((), {"ticket": 5003})], history_queries)

    def test_probe_returns_read_only_account_identity(self):
        result = worker.probe(FakeMt5(), __file__)
        self.assertEqual("mt5_probe", result["type"])
        self.assertEqual("12345678", result["account_ref"]["login"])
        self.assertEqual("Broker-Demo", result["account_ref"]["broker_server"])

    def test_probe_rejects_missing_terminal_before_initialize(self):
        with self.assertRaisesRegex(worker.WorkerError, "mt5_terminal_not_found"):
            worker.probe(FakeMt5(), str(Path(__file__).with_name("missing-terminal.exe")))


if __name__ == "__main__":
    unittest.main()
