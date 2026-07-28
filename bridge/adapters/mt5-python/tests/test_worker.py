import io
import sys
import tempfile
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
Tick = namedtuple("Tick", "bid ask time_msc", defaults=(0,))
Result = namedtuple("Result", "retcode order deal comment")
Deal = namedtuple("Deal", "ticket time time_msc type entry position_id profit commission swap fee")
HistoryDeal = namedtuple(
    "HistoryDeal",
    "ticket order time time_msc type entry position_id symbol volume price profit commission swap fee comment",
)
HistoryOrder = namedtuple(
    "HistoryOrder",
    "ticket position_id symbol type state magic reason comment volume_initial volume_current price_open price_current sl tp time_setup time_done",
)


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
        self.selected = []
        self.symbols_calls = 0

    def account_info(self): return Account(12345678, "Broker-Demo", 1000)
    def terminal_info(self): return Terminal(True)
    def positions_get(self, **kwargs): return ()
    def orders_get(self, **kwargs): return ()
    def history_deals_get(self, *args): return ()
    def history_orders_get(self, *args, **kwargs): return ()
    def symbols_get(self):
        self.symbols_calls += 1
        return (SimpleNamespace(name="XAUUSD"),)
    def symbol_info_tick(self, symbol):
        return Tick(2300.0, 2300.2, int(time.time() * 1000) + 180 * 60_000)
    def symbol_info(self, symbol): return SimpleNamespace(trade_mode=4)
    def symbol_select(self, symbol, enabled):
        self.selected.append((symbol, enabled))
        return True
    def copy_rates_from_pos(self, symbol, timeframe, offset, count):
        return [(1_700_010_800, 2300.0, 2301.0, 2299.0, 2300.5, 42, 12)]
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
    def adapter(self, mt5=None, clock_msc=None, clock_state_path=None):
        return worker.Mt5Adapter(mt5 or FakeMt5(), __file__, worker.WorkerIdentity(
            "terminal_01JWORKER01", "Broker-Demo", "12345678", 7),
            clock_msc=clock_msc, clock_state_path=clock_state_path)

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

    def test_collects_deals_in_bounded_cursor_order_without_skipping_same_millisecond(self):
        adapter = self.adapter()
        event_ms = 1_800_000_000_000
        adapter.mt5.history_deals_get = lambda *args: (
            Deal(103, event_ms + 1, event_ms + 1, 0, 1, 7001, 3.0, 0.0, 0.0, 0.0),
            Deal(102, event_ms, event_ms, 0, 1, 7001, 2.0, 0.0, 0.0, 0.0),
            Deal(101, event_ms, event_ms, 0, 1, 7001, 1.0, 0.0, 0.0, 0.0),
        )
        first = adapter.collect(
            ["deals"],
            {"time_msc": event_ms - 1, "ticket": "0", "limit": 2},
            now_utc_msc=event_ms + 5_000)["deals"]
        second = adapter.collect(
            ["deals"], {**first["next_cursor"], "limit": 2},
            now_utc_msc=event_ms + 5_000)["deals"]

        self.assertEqual([101, 102], [item["ticket"] for item in first["items"]])
        self.assertTrue(first["has_more"])
        self.assertEqual({"time_msc": event_ms, "ticket": "102"}, first["next_cursor"])
        self.assertEqual([103], [item["ticket"] for item in second["items"]])
        self.assertFalse(second["has_more"])

    def test_empty_deal_window_advances_scan_cursor_and_query_failure_fails_closed(self):
        adapter = self.adapter()
        cursor_time = 1_700_000_000_000
        adapter.mt5.history_deals_get = lambda *args: ()

        result = adapter.collect(
            ["deals"], {"time_msc": cursor_time, "ticket": "0"},
            now_utc_msc=cursor_time + worker.DEAL_WINDOW_MSC * 2)["deals"]

        self.assertEqual([], result["items"])
        self.assertEqual(cursor_time + worker.DEAL_WINDOW_MSC, result["next_cursor"]["time_msc"])
        self.assertTrue(result["has_more"])

        adapter.mt5.history_deals_get = lambda *args: None
        with self.assertRaises(worker.WorkerError) as raised:
            adapter.collect(
                ["deals"], result["next_cursor"],
                now_utc_msc=cursor_time + worker.DEAL_WINDOW_MSC * 2)
        self.assertEqual("mt5_deals_unavailable", raised.exception.code)

    def test_returns_bounded_daily_performance_without_exporting_raw_deals(self):
        adapter = self.adapter()
        event_ms = 1_767_312_000_000  # 2026-01-02T12:00:00Z
        adapter.mt5.history_deals_get = lambda *args: (
            Deal(501, event_ms // 1000, event_ms, 0, 1, 7001,
                 12.5, -0.5, -0.25, 0.0),
        )
        request = {
            "v": 3, "type": "data_request", "request_id": "data_01JPERFORMANCE",
            "terminal_instance_id": "terminal_01JWORKER01",
            "account_ref": {"broker_server": "Broker-Demo", "login": "12345678"},
            "connection_epoch": 7, "action": "performance_daily",
            "params": {"date_from": "2026-01-02", "date_to": "2026-01-02"},
        }

        result = adapter.data(request)

        self.assertEqual("succeeded", result["status"])
        self.assertEqual(1, result["payload"]["scanned_deal_count"])
        self.assertEqual(11.75, result["payload"]["daily"][0]["realized_net"])
        self.assertEqual(1, result["payload"]["daily"][0]["closed_position_count"])
        self.assertNotIn("deals", result["payload"])

    def test_rejects_performance_ranges_larger_than_31_days_before_history_query(self):
        adapter = self.adapter()
        called = []
        adapter.mt5.history_deals_get = lambda *args: called.append(args) or ()
        result = adapter.data({
            "v": 3, "type": "data_request", "request_id": "data_01JPERFORMANCE",
            "terminal_instance_id": "terminal_01JWORKER01",
            "account_ref": {"broker_server": "Broker-Demo", "login": "12345678"},
            "connection_epoch": 7, "action": "performance_daily",
            "params": {"date_from": "2026-01-01", "date_to": "2026-02-02"},
        })
        self.assertEqual("rejected", result["status"])
        self.assertEqual("performance_date_range_too_large", result["error_code"])
        self.assertEqual([], called)

    def test_executes_matching_command_and_caches_result(self):
        adapter = self.adapter()
        command = self.command()
        first = adapter.execute(command)
        second = adapter.execute(command)
        self.assertEqual("succeeded", first["status"])
        self.assertEqual(first, second)
        self.assertEqual(1, len(adapter.mt5.sent))
        self.assertEqual("AURUM:" + command["command_id"][-20:], adapter.mt5.sent[0]["comment"])

    def test_places_every_supported_order_kind_for_both_sides(self):
        cases = (
            ("market", "buy", FakeMt5.TRADE_ACTION_DEAL, FakeMt5.ORDER_TYPE_BUY),
            ("market", "sell", FakeMt5.TRADE_ACTION_DEAL, FakeMt5.ORDER_TYPE_SELL),
            ("limit", "buy", FakeMt5.TRADE_ACTION_PENDING, FakeMt5.ORDER_TYPE_BUY_LIMIT),
            ("limit", "sell", FakeMt5.TRADE_ACTION_PENDING, FakeMt5.ORDER_TYPE_SELL_LIMIT),
            ("stop", "buy", FakeMt5.TRADE_ACTION_PENDING, FakeMt5.ORDER_TYPE_BUY_STOP),
            ("stop", "sell", FakeMt5.TRADE_ACTION_PENDING, FakeMt5.ORDER_TYPE_SELL_STOP),
            ("stop_limit", "buy", FakeMt5.TRADE_ACTION_PENDING, FakeMt5.ORDER_TYPE_BUY_STOP_LIMIT),
            ("stop_limit", "sell", FakeMt5.TRADE_ACTION_PENDING, FakeMt5.ORDER_TYPE_SELL_STOP_LIMIT),
        )
        for index, (kind, side, action, order_type) in enumerate(cases):
            with self.subTest(kind=kind, side=side):
                adapter = self.adapter()
                params = {
                    "symbol": "XAUUSD", "side": side, "order_kind": kind,
                    "volume": 0.01, "price": 2300.1,
                    "stop_loss": 2290.0, "take_profit": 2320.0,
                }
                if kind == "stop_limit":
                    params["stop_limit_price"] = 2300.0
                command = self.command(
                    command_id=f"command_01JORDERKIND{index:02d}", params=params)

                result = adapter.execute(command)

                self.assertEqual("succeeded", result["status"])
                request = adapter.mt5.sent[0]
                self.assertEqual(action, request["action"])
                self.assertEqual(order_type, request["type"])
                self.assertEqual(2300.1, request["price"])
                self.assertEqual(2290.0, request["sl"])
                self.assertEqual(2320.0, request["tp"])
                if kind == "stop_limit":
                    self.assertEqual(2300.0, request["stoplimit"])

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
        position_queries = iter(((position,), ()))
        adapter.mt5.positions_get = lambda **kwargs: next(position_queries)
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
        order_queries = iter(((order,), ()))
        adapter.mt5.orders_get = lambda **kwargs: next(order_queries)
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
        self.assertEqual(180, result["timezone_offset_minutes"])
        self.assertEqual("verified", result["clock_status"])
        self.assertLess(abs(result["observed_at_utc_msc"] - int(time.time() * 1000)), 30_000)
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
        self.assertEqual(1_700_010_800_000, result["payload"]["rates"][0]["time_server_msc"])
        self.assertEqual(180, result["payload"]["timezone_offset_minutes"])
        self.assertNotIn("command_id", result)

    def test_calibrates_non_default_broker_offset_after_advancing_tick(self):
        now = [1_800_000_000_000]
        mt5 = FakeMt5()
        mt5.symbol_info_tick = lambda symbol: Tick(
            2300.0, 2300.2, now[0] + 120 * 60_000)
        adapter = self.adapter(mt5=mt5, clock_msc=lambda: now[0])
        request = self.command(
            type="quote_request", request_id="quote_01JCLOCK", symbol="XAUUSD")

        first = adapter.quote(request)
        now[0] += 1_000
        second = adapter.quote({**request, "request_id": "quote_01JCLOCK2"})

        self.assertEqual("rejected", first["status"])
        self.assertEqual("mt5_clock_unverified", first["error_code"])
        self.assertEqual("succeeded", second["status"])
        self.assertEqual(120, second["timezone_offset_minutes"])
        self.assertEqual(now[0], second["observed_at_utc_msc"])

    def test_persists_verified_offset_for_restart_with_stale_market_tick(self):
        now = [1_800_000_000_000]
        mt5 = FakeMt5()
        current_tick = [now[0] + 120 * 60_000]
        mt5.symbol_info_tick = lambda symbol: Tick(2300.0, 2300.2, current_tick[0])
        request = self.command(
            type="quote_request", request_id="quote_01JPERSIST", symbol="XAUUSD")
        with tempfile.TemporaryDirectory() as directory:
            state_path = Path(directory) / "clock.json"
            adapter = self.adapter(mt5=mt5, clock_msc=lambda: now[0],
                                   clock_state_path=state_path)
            self.assertEqual("rejected", adapter.quote(request)["status"])
            now[0] += 1_000
            current_tick[0] += 1_000
            self.assertEqual("succeeded", adapter.quote(request)["status"])
            self.assertTrue(state_path.is_file())

            now[0] += 300_000
            restarted = self.adapter(mt5=mt5, clock_msc=lambda: now[0],
                                     clock_state_path=state_path)
            result = restarted.quote({**request, "request_id": "quote_01JPERSIST2"})

            self.assertEqual("succeeded", result["status"])
            self.assertEqual(120, result["timezone_offset_minutes"])

    def test_resolves_requested_symbol_to_broker_suffix(self):
        adapter = self.adapter()
        adapter.mt5.symbols_get = lambda: (SimpleNamespace(name="XAUUSD.s"),)
        request = self.command(
            type="data_request", request_id="data_01JWORKER_SUFFIX", action="rates",
            params={"symbol": "XAUUSD", "timeframe": "M30", "count": 100})

        result = adapter.data(request)

        self.assertEqual("succeeded", result["status"])
        self.assertEqual("XAUUSD.s", result["payload"]["symbol"])
        self.assertEqual(("XAUUSD.s", True), adapter.mt5.selected[-1])

    def test_preserves_zero_magic_for_direct_user_order(self):
        adapter = self.adapter()

        result = adapter.execute(self.command(params={
            "symbol": "XAUUSD", "side": "buy", "volume": 0.01, "magic": 0,
        }))

        self.assertEqual("succeeded", result["status"])
        self.assertEqual(0, adapter.mt5.sent[0]["magic"])

    def test_resolves_broker_suffix_before_sending_market_order(self):
        adapter = self.adapter()
        adapter.mt5.symbols_get = lambda: (SimpleNamespace(name="XAUUSD.s"),)

        result = adapter.execute(self.command(params={
            "symbol": "XAUUSD", "side": "buy", "volume": 0.01,
        }))

        self.assertEqual("succeeded", result["status"])
        self.assertEqual("XAUUSD.s", adapter.mt5.sent[0]["symbol"])
        self.assertEqual(("XAUUSD.s", True), adapter.mt5.selected[-1])

    def test_retries_only_quote_refresh_rejections_and_uses_latest_price(self):
        adapter = self.adapter()
        responses = iter((Result(10004, 0, 0, "requote"), Result(10009, 1001, 2001, "done")))
        ticks = iter((Tick(2300.0, 2300.2), Tick(2301.0, 2301.2)))
        adapter.mt5.symbol_info_tick = lambda symbol: next(ticks)
        adapter.mt5.order_send = lambda request: adapter.mt5.sent.append(dict(request)) or next(responses)

        result = adapter.execute(self.command(params={
            "symbol": "XAUUSD", "side": "buy", "volume": 0.01,
        }))

        self.assertEqual("succeeded", result["status"])
        self.assertEqual(2, len(adapter.mt5.sent))
        self.assertEqual(2301.2, adapter.mt5.sent[1]["price"])

    def test_reuses_resolved_symbol_without_rescanning_all_mt5_symbols(self):
        adapter = self.adapter()
        first = self.command(
            type="data_request", request_id="data_01JWORKER_CACHE1", action="rates",
            params={"symbol": "XAUUSD", "timeframe": "M30", "count": 100})
        second = {**first, "request_id": "data_01JWORKER_CACHE2"}

        self.assertEqual("succeeded", adapter.data(first)["status"])
        self.assertEqual("succeeded", adapter.data(second)["status"])
        self.assertEqual(1, adapter.mt5.symbols_calls)

    def test_returns_symbols_history_and_chart_over_transient_data_channel(self):
        adapter = self.adapter()
        adapter.mt5.symbols_get = lambda: (SimpleNamespace(
            name="XAUUSD.s", description="Gold", digits=2, trade_mode=4,
            point=0.01, trade_tick_size=0.01, trade_tick_value=1.0,
            trade_contract_size=100.0, volume_min=0.01, volume_max=100.0,
            volume_step=0.01),)
        event_time = 1_767_312_000
        adapter.mt5.history_deals_get = lambda *args: (
            HistoryDeal(600, 500, event_time - 60, 0, 0, 0, 700, "XAUUSD.s",
                        0.1, 2300.0, 0.0, 0.0, 0.0, 0.0, "open"),
            HistoryDeal(601, 501, event_time, 0, 1, 1, 700, "XAUUSD.s",
                        0.1, 2310.0, 12.0, -0.5, -0.25, -0.25, "close"),
        )
        base = self.command(type="data_request", params={})

        symbols = adapter.data({**base, "request_id": "data_01JWORKER_SYMBOLS",
                                "action": "symbols"})
        history = adapter.data({**base, "request_id": "data_01JWORKER_HISTORY",
                                "action": "history",
                                "params": {"date_from": "2026-01-02",
                                           "date_to": "2026-01-02", "page": 1,
                                           "page_size": 20}})
        chart = adapter.data({**base, "request_id": "data_01JWORKER_CHART",
                              "action": "chart_data",
                              "params": {"date_from": "2026-01-02",
                                         "date_to": "2026-01-02"}})

        self.assertEqual("XAUUSD.s", symbols["payload"]["symbols"][0]["name"])
        self.assertEqual(11.0, history["payload"]["statistics"]["total_profit"])
        self.assertEqual(1, history["payload"]["pagination"]["total_count"])
        self.assertEqual(11.0, chart["payload"]["daily"][0]["profit"])
        self.assertEqual(1, chart["payload"]["stats"]["total_trades"])

    def test_history_preserves_visible_protection_and_full_evidence_contract(self):
        adapter = self.adapter()
        event_time = 1_767_312_000
        adapter.mt5.history_deals_get = lambda *args: (
            HistoryDeal(600, 500, event_time - 60, 0, 0, 0, 700, "XAUUSD",
                        0.1, 2300.0, 0.0, 0.0, 0.0, 0.0, "open"),
            HistoryDeal(601, 501, event_time, 0, 1, 1, 700, "XAUUSD",
                        0.1, 2310.0, 12.0, -0.5, -0.25, -0.25, "close"),
        )
        order = HistoryOrder(500, 700, "XAUUSD", 2, 4, 234000, 0, "AI-1",
                             0.1, 0.0, 2300.0, 2310.0, 2290.0, 2320.0,
                             event_time - 60, event_time)
        adapter.mt5.history_orders_get = lambda *args, **kwargs: (order,)
        base = self.command(type="data_request", action="history",
                            request_id="data_01JWORKER_HISTORY_EVIDENCE")

        visible = adapter.data({**base, "params": {
            "date_from": "2026-01-02", "date_to": "2026-01-02",
            "page": 1, "page_size": 20,
        }})
        evidence = adapter.data({**base, "request_id": "data_01JWORKER_HISTORY_FULL",
                                 "params": {"date_from": "2026-01-02",
                                            "date_to": "2026-01-02", "page": 1,
                                            "page_size": 5000, "include_deals": True}})

        self.assertEqual(2290.0, visible["payload"]["orders"][0]["stop_loss"])
        self.assertEqual(2320.0, visible["payload"]["orders"][0]["take_profit"])
        self.assertEqual(2, len(evidence["payload"]["deals"]))
        self.assertEqual(2290.0, evidence["payload"]["history_orders"][0]["sl"])

    def test_returns_pending_terminal_state_and_diagnostics(self):
        adapter = self.adapter()
        historical = SimpleNamespace(
            ticket=5001, position_id=7001, symbol="XAUUSD", type=2, state=2,
            volume_initial=0.1, volume_current=0.0, price_open=2290.0,
            magic=234000, comment="AI-1")
        adapter.mt5.history_orders_get = lambda *args, **kwargs: (historical,)
        expected = {"ticket": "5001", "symbol": "XAUUSD", "direction": "buy",
                    "volume": 0.1, "magic": 234000}
        base = self.command(type="data_request", params={})

        state = adapter.data({**base, "request_id": "data_01JWORKER_PENDING_STATE",
                              "action": "pending_order_state",
                              "params": {"ticket": "5001", "expected_state": expected}})
        diagnostics = adapter.data({**base, "request_id": "data_01JWORKER_DIAGNOSTICS",
                                    "action": "diagnostics"})

        self.assertEqual("succeeded", state["status"])
        self.assertEqual("cancelled", state["payload"]["final_state"])
        self.assertEqual(7001, state["payload"]["position_id"])
        self.assertEqual("succeeded", diagnostics["status"])
        self.assertTrue(diagnostics["payload"]["mt5_connected"])
        self.assertEqual(12345678, diagnostics["payload"]["account"]["login"])

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

    def test_collect_snapshot_separates_source_capture_time_for_bridge(self):
        result = worker.collect_snapshot(
            {"request_id": "collect_01JWORKER", "streams": ["account", "positions"]},
            self.adapter(),
            1_799_999_999_900)

        self.assertEqual(1_799_999_999_900, result["source_time_msc"])
        self.assertEqual(1_799_999_999_900, result["observed_at_utc_msc"])
        self.assertIn("account", result["streams"])
        self.assertIn("positions", result["streams"])

    def test_probe_rejects_missing_terminal_before_initialize(self):
        with self.assertRaisesRegex(worker.WorkerError, "mt5_terminal_not_found"):
            worker.probe(FakeMt5(), str(Path(__file__).with_name("missing-terminal.exe")))


if __name__ == "__main__":
    unittest.main()
