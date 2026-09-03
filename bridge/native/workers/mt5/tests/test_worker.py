from __future__ import annotations

import io
import json
import math
import sys
import tempfile
import time
import unittest
from collections import namedtuple
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

WORKER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(WORKER_DIR))

from worker import (  # noqa: E402
    ARCHIVE_CAPABILITIES,
    IPC_VERSION,
    LIVE_CAPABILITIES,
    BrokerClock,
    ReadOnlyMt5Adapter,
    Mt5Worker,
    WorkerError,
    WorkerRoute,
    _probe_error_code,
    _probe_last_error,
    _normalized_terminal_path,
    _terminal_process_running,
    main,
    probe_terminal,
    read_frame,
    role_from_environment,
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
Deal = namedtuple(
    "Deal", "ticket order position_id symbol type entry magic reason comment volume price profit commission swap fee sl tp time time_msc")
HistoryOrder = namedtuple(
    "HistoryOrder", "ticket position_id symbol type state magic reason comment volume_initial volume_current price_open sl tp time_setup time_done time_setup_msc time_done_msc")


class FakeMt5:
    TIMEFRAME_M5 = 5
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
    DEAL_ENTRY_IN = 0
    DEAL_ENTRY_OUT = 1
    DEAL_ENTRY_INOUT = 2
    DEAL_ENTRY_OUT_BY = 3
    DEAL_TYPE_BUY = 0

    def __init__(self, now: int):
        self.now = now
        self.initialized = False
        self.sent = []
        self.checks = []
        self.history_order_queries = []
        self.history_deal_queries = []
        self.positions = [Position(101, "XAUUSD.s", 0.01, 0, 234000, 2290.0, 2320.0)]
        self.orders = [Order(202, "XAUUSD.s", 0.02, 0.02, 2, 234000, "AI-PENDING",
                             2280.0, 2270.0, 2310.0, 0.0, 0)]
        event_utc_seconds = now // 1000 - 60
        event_seconds = event_utc_seconds + 180 * 60
        self.history_deals = [
            Deal(4001, 3001, 2001, "XAUUSD.s", 0, 0, 234000, 0, "open",
                 0.01, 2295.0, 0.0, 0.0, 0.0, 0.0, 2285.0, 2315.0,
                 event_seconds - 60, (event_seconds - 60) * 1000),
            Deal(4002, 3002, 2001, "XAUUSD.s", 1, 1, 234000, 0, "close",
                 0.01, 2305.0, 10.0, -0.2, -0.1, 0.0, 0.0, 0.0,
                 event_seconds, event_seconds * 1000),
        ]
        self.history_orders = {
            3001: HistoryOrder(3001, 2001, "XAUUSD.s", 0, 4, 234000, 0, "open",
                               0.01, 0.0, 2295.0, 2285.0, 2315.0,
                               event_seconds - 60, event_seconds - 60,
                               (event_seconds - 60) * 1000, (event_seconds - 60) * 1000),
            3002: HistoryOrder(3002, 2001, "XAUUSD.s", 1, 4, 234000, 0, "close",
                               0.01, 0.0, 2305.0, 0.0, 0.0,
                               event_seconds, event_seconds,
                               event_seconds * 1000, event_seconds * 1000),
        }

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

    def copy_rates_from_pos(self, _symbol, _timeframe, _offset, count):
        server_now = self.now // 1000 + 180 * 60
        return tuple(
            (server_now - (count - index) * 300, 2300.0 + index, 2301.0 + index,
             2299.0 + index, 2300.5 + index, 100 + index, 20)
            for index in range(count)
        )

    def copy_rates_range(self, symbol, timeframe, _start, _end):
        return self.copy_rates_from_pos(symbol, timeframe, 0, 3)

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
                sl=request.get("sl", item.sl),
                tp=request.get("tp", item.tp),
                price_stoplimit=request.get("stoplimit", item.price_stoplimit),
                time_expiration=request.get("expiration", item.time_expiration),
            ) if item.ticket == request["order"] else item for item in self.orders]
        elif action == self.TRADE_ACTION_DEAL and request.get("position"):
            self.positions = [
                item._replace(volume=round(item.volume - request["volume"], 8))
                if item.ticket == request["position"] and request["volume"] < item.volume
                else item
                for item in self.positions
                if item.ticket != request["position"] or request["volume"] < item.volume
            ]
        return SimpleNamespace(retcode=10009, order=1001, deal=2001, comment="done")

    def history_orders_get(self, *args, **kwargs):
        self.history_order_queries.append((args, dict(kwargs)))
        ticket = kwargs.get("ticket")
        if ticket is not None:
            return (self.history_orders[ticket],) if ticket in self.history_orders else ()
        if len(args) == 2:
            start, end = args
            return tuple(item for item in self.history_orders.values()
                         if start.timestamp() <= item.time_done <= end.timestamp())
        return ()

    def history_deals_get(self, *args, **kwargs):
        self.history_deal_queries.append((args, dict(kwargs)))
        position = kwargs.get("position")
        ticket = kwargs.get("ticket")
        if position is not None or ticket is not None:
            return tuple(item for item in self.history_deals
                         if (position is None or item.position_id == position)
                         and (ticket is None or item.order == ticket))
        if len(args) == 2:
            start, end = args
            return tuple(item for item in self.history_deals
                         if start.timestamp() <= item.time <= end.timestamp())
        return ()


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.terminal_running = patch(
            "worker._terminal_process_running", return_value=True
        )
        self.terminal_running.start()
        self.addCleanup(self.terminal_running.stop)
        self.now = 1_800_000_000_000
        self.route = WorkerRoute("terminal_01", "mt5", "Broker-Demo", "123456", 7)
        self.temporary = tempfile.TemporaryDirectory()
        self.terminal_path = Path(self.temporary.name) / "terminal64.exe"
        self.terminal_path.touch()
        self.mt5 = FakeMt5(self.now)
        self.clock_state_path = Path(self.temporary.name) / "clock.json"
        self.clock_state_path.write_text(
            '{"version":1,"timezone_offset_minutes":180}', encoding="utf-8")
        self.adapter = ReadOnlyMt5Adapter(
            self.mt5,
            str(self.terminal_path),
            self.route,
            clock_msc=lambda: self.now,
            clock_state_path=self.clock_state_path,
            clock_probe_seconds=0.01,
            clock_poll_seconds=0.01,
        )
        self.adapter.connect()
        self.worker = Mt5Worker(self.adapter, self.route)
        self.archive_worker = Mt5Worker(self.adapter, self.route, role="archive")
        self.worker.trade._clock_msc = lambda: self.now

    def test_probe_terminal_returns_only_strict_identity_and_closes_mt5(self):
        with tempfile.TemporaryDirectory() as directory:
            terminal = Path(directory) / "terminal64.exe"
            terminal.write_bytes(b"terminal")
            result = probe_terminal(self.mt5, str(terminal))
        self.assertEqual(1, result["probe_version"])
        self.assertEqual(str(terminal.resolve()), result["terminal_path"])
        self.assertEqual(
            {"broker_server": "Broker-Demo", "login": "123456"},
            result["account_ref"],
        )
        self.assertFalse(self.mt5.initialized)

    def test_probe_main_emits_stable_structured_failure_and_numeric_last_error(self):
        with tempfile.TemporaryDirectory() as directory:
            terminal = Path(directory) / "terminal64.exe"
            terminal.write_bytes(b"terminal")
            self.mt5.initialize = lambda **_kwargs: False
            self.mt5.last_error = lambda: (-10004, "private diagnostic text")
            output = io.StringIO()
            with (
                patch("sys.stdout", output),
                self.assertRaises(SystemExit) as raised,
            ):
                main(self.mt5, ["--probe", "--terminal", str(terminal)])

        self.assertEqual(2, raised.exception.code)
        payload = json.loads(output.getvalue())
        self.assertEqual(1, payload["probe_version"])
        self.assertEqual("initialize_failed", payload["error_code"])
        self.assertEqual(-10004, payload["last_error"])
        self.assertNotIn("private diagnostic text", output.getvalue())

    def test_probe_error_mapping_accepts_only_stable_codes(self):
        self.mt5.last_error = lambda: (-10004, "private diagnostic text")
        self.assertEqual("terminal_not_found", _probe_error_code("mt5_terminal_not_found"))
        self.assertEqual("terminal_not_running", _probe_error_code("mt5_terminal_not_running"))
        self.assertEqual("initialize_failed", _probe_error_code("mt5_initialize_failed"))
        self.assertEqual("account_unavailable", _probe_error_code("mt5_account_unavailable"))
        self.assertEqual("disconnected", _probe_error_code("mt5_terminal_disconnected"))
        self.assertEqual("probe_failed", _probe_error_code("unexpected_internal_error"))
        self.assertEqual(-10004, _probe_last_error(self.mt5))

    def test_connect_waits_for_saved_account_session_to_be_restored(self):
        with tempfile.TemporaryDirectory() as directory:
            terminal = Path(directory) / "terminal64.exe"
            terminal.write_bytes(b"terminal")
            mt5 = FakeMt5(self.now)
            account_info = mt5.account_info
            calls = 0

            def delayed_account_info():
                nonlocal calls
                calls += 1
                return None if calls < 3 else account_info()

            mt5.account_info = delayed_account_info
            adapter = ReadOnlyMt5Adapter(
                mt5,
                str(terminal),
                self.route,
                clock_msc=lambda: self.now,
                login_wait_seconds=0.2,
                login_poll_seconds=0.01,
            )

            adapter.connect()

            self.assertGreaterEqual(calls, 3)
            self.assertTrue(mt5.initialized)
            adapter.shutdown()

    def test_connect_rejects_closed_terminal_without_starting_it(self):
        with tempfile.TemporaryDirectory() as directory:
            terminal = Path(directory) / "terminal64.exe"
            terminal.write_bytes(b"terminal")
            mt5 = FakeMt5(self.now)
            adapter = ReadOnlyMt5Adapter(
                mt5,
                str(terminal),
                self.route,
                clock_msc=lambda: self.now,
            )
            with (
                patch("worker._terminal_process_running", return_value=False),
                self.assertRaisesRegex(WorkerError, "mt5_terminal_not_running"),
            ):
                adapter.connect()

            self.assertFalse(mt5.initialized)

    def test_terminal_process_detection_matches_windows_verbatim_drive_path(self):
        ordinary = r"D:\Program Files\MetaTrader 5\terminal64.exe"
        verbatim = r"\\?\D:\Program Files\MetaTrader 5\terminal64.exe"

        with patch("worker._running_windows_process_paths", return_value=(ordinary,)):
            self.assertTrue(_terminal_process_running(verbatim))

    def test_terminal_path_normalization_matches_windows_verbatim_unc_path(self):
        ordinary = r"\\server\share\MetaTrader 5\terminal64.exe"
        verbatim = r"\\?\UNC\server\share\MetaTrader 5\terminal64.exe"

        self.assertEqual(
            _normalized_terminal_path(ordinary),
            _normalized_terminal_path(verbatim),
        )

    def test_probe_rejects_closed_terminal_without_starting_it(self):
        with tempfile.TemporaryDirectory() as directory:
            terminal = Path(directory) / "terminal64.exe"
            terminal.write_bytes(b"terminal")
            mt5 = FakeMt5(self.now)
            with (
                patch("worker._terminal_process_running", return_value=False),
                self.assertRaisesRegex(WorkerError, "mt5_terminal_not_running"),
            ):
                probe_terminal(mt5, str(terminal))

            self.assertFalse(mt5.initialized)

    def test_fresh_install_closed_market_fails_until_a_progressing_tick_calibrates_clock(self):
        adapter = ReadOnlyMt5Adapter(
            self.mt5, str(self.terminal_path), self.route,
            clock_msc=lambda: self.now, clock_probe_seconds=0,
        )
        adapter.connect()
        worker = Mt5Worker(adapter, self.route)
        self.mt5.now = self.now - 18 * 60 * 60_000

        quote_response = worker.handle(self.request("quote", {"symbol": "XAUUSD"}))

        self.assertEqual("error", quote_response["outcome"])
        self.assertEqual("mt5_clock_unverified", quote_response["payload"]["error_code"])

    def test_closed_market_sample_is_not_persisted_as_trusted(self):
        with tempfile.TemporaryDirectory() as directory:
            state_path = Path(directory) / "clock.json"
            clock = BrokerClock(state_path, lambda: self.now)

            with self.assertRaisesRegex(WorkerError, "mt5_clock_unverified"):
                clock.calibrate(self.now + 180 * 60_000 - 18 * 60 * 60_000)

            self.assertEqual("calibrating", clock.status)
            self.assertFalse(state_path.exists())

    def test_fresh_install_uses_progressing_tick_to_calibrate_against_utc(self):
        host_samples = iter((self.now, self.now + 1_000))
        clock = BrokerClock(None, lambda: next(host_samples))

        with self.assertRaisesRegex(WorkerError, "mt5_clock_unverified"):
            clock.calibrate(self.now + 180 * 60_000)
        observed = clock.calibrate(self.now + 1_000 + 180 * 60_000)

        self.assertEqual(self.now + 1_000, observed)
        self.assertEqual(180, clock.offset_minutes)
        self.assertEqual("verified", clock.status)

    def test_closed_preferred_symbol_uses_another_progressing_symbol_for_initial_calibration(self):
        adapter = ReadOnlyMt5Adapter(
            self.mt5, str(self.terminal_path), self.route,
            clock_msc=lambda: self.now, clock_probe_seconds=0.02,
            clock_poll_seconds=0.001,
        )
        adapter.connect()
        secondary_samples = iter((self.now + 180 * 60_000,
                                  self.now + 180 * 60_000 + 1_000))
        last_secondary = self.now + 180 * 60_000 + 1_000
        self.mt5.symbols_get = lambda: (
            self.mt5.symbol_info("XAUUSD.s")._replace(name="XAUUSD.s"),
            self.mt5.symbol_info("EURUSD.s")._replace(name="EURUSD.s"),
        )

        def symbol_tick(symbol):
            if symbol == "XAUUSD.s":
                return Tick(2300.0, 2300.2, 2300.1,
                            self.now + 180 * 60_000 - 18 * 60 * 60_000)
            try:
                raw = next(secondary_samples)
            except StopIteration:
                raw = last_secondary
            return Tick(1.1, 1.1002, 1.1001, raw)

        self.mt5.symbol_info_tick = symbol_tick

        adapter._calibrate_terminal_clock("XAUUSD.s")

        self.assertEqual(180, adapter.clock.offset_minutes)
        self.assertEqual("verified", adapter.clock.status)

    def test_future_clock_sample_still_fails_closed(self):
        self.mt5.now = self.now + 60 * 60_000

        response = self.worker.handle(self.request("quote", {"symbol": "XAUUSD"}))

        self.assertEqual("error", response["outcome"])
        self.assertEqual("mt5_clock_unverified", response["payload"]["error_code"])

    def tearDown(self):
        self.temporary.cleanup()

    def request(self, operation, payload, request_id="request_01JTEST001"):
        return {
            "ipc_v": IPC_VERSION,
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

    def test_data_rates_are_bounded_suffix_resolved_and_utc_normalized(self):
        response = self.worker.handle(self.request("data", {
            "action": "rates",
            "params": {"symbol": "XAUUSD", "timeframe": "M5", "count": 4},
        }))
        self.assertEqual("data", response["outcome"])
        result = response["payload"]["data"]
        self.assertEqual("rates", result["action"])
        self.assertEqual(self.now, result["observed_at_utc_msc"])
        payload = result["payload"]
        self.assertEqual("XAUUSD.s", payload["symbol"])
        self.assertEqual(4, payload["count"])
        self.assertEqual(self.now - 4 * 300_000, payload["rates"][0]["time_utc_msc"])
        self.assertEqual(180, payload["timezone_offset_minutes"])
        self.assertEqual("verified", payload["clock_status"])

        ranged = self.worker.handle(self.request("data", {
            "action": "rates",
            "params": {
                "symbol": "XAUUSD",
                "timeframe": "M5",
                "count": 2,
                "start_utc_msc": self.now - 3_600_000,
                "end_utc_msc": self.now,
            },
        }, "request_01JRANGEDATA1"))["payload"]["data"]["payload"]
        self.assertTrue(ranged["range_complete"])
        self.assertEqual(2, ranged["count"])
        self.assertEqual(self.now - 3_600_000, ranged["range_start_utc_msc"])
        self.assertEqual(self.now, ranged["range_end_utc_msc"])

    def test_data_symbols_are_sorted_and_invalid_data_params_fail_closed(self):
        self.mt5.symbols_get = lambda: (
            self.mt5.symbol_info("XAUUSD.s")._replace(name="XAUUSD.s"),
            self.mt5.symbol_info("AUDUSD.s")._replace(name="AUDUSD.s"),
        )
        response = self.worker.handle(self.request("data", {
            "action": "symbols", "params": {},
        }))
        self.assertEqual(["AUDUSD.s", "XAUUSD.s"], [
            item["name"] for item in response["payload"]["data"]["payload"]["symbols"]
        ])

        invalid = self.worker.handle(self.request("data", {
            "action": "rates",
            "params": {"symbol": "XAUUSD", "timeframe": "S1", "count": 4},
        }, "request_01JINVALIDDATA"))
        self.assertEqual("error", invalid["outcome"])
        self.assertEqual("worker_rates_params_invalid", invalid["payload"]["error_code"])

    def test_symbol_resolution_rejects_ambiguous_broker_suffixes(self):
        self.mt5.symbols_get = lambda: (
            self.mt5.symbol_info("XAUUSD.s")._replace(name="XAUUSD.s"),
            self.mt5.symbol_info("XAUUSD.c")._replace(name="XAUUSD.c"),
        )

        response = self.worker.handle(self.request("quote", {"symbol": "XAUUSD"}))

        self.assertEqual("error", response["outcome"])
        self.assertEqual("symbol_ambiguous", response["payload"]["error_code"])

    def test_unexpected_worker_exception_writes_only_redacted_diagnostic(self):
        with tempfile.TemporaryDirectory() as root:
            diagnostic = Path(root) / "worker.jsonl"
            self.adapter.quote = lambda _symbol: (_ for _ in ()).throw(
                RuntimeError("account=123456 secret-token")
            )
            with patch.dict("os.environ", {
                "AURUM_BRIDGE_DIAGNOSTIC_PATH": str(diagnostic),
            }):
                response = self.worker.handle(self.request("quote", {"symbol": "XAUUSD"}))

            self.assertEqual("mt5_worker_internal_error", response["payload"]["error_code"])
            payload = diagnostic.read_text(encoding="utf-8")
            self.assertIn('"exception_type":"RuntimeError"', payload)
            self.assertNotIn("123456", payload)
            self.assertNotIn("secret-token", payload)

    def test_extended_read_only_data_contracts_preserve_identity_and_clock(self):
        symbol = self.worker.handle(self.request("data", {
            "action": "symbol_snapshot", "params": {"symbol": "XAUUSD"},
        }, "request_01JSYMBOLSNAP"))["payload"]["data"]["payload"]
        self.assertEqual("XAUUSD.s", symbol["symbol"])
        self.assertEqual(0.01, symbol["instrument"]["volume_min"])
        self.assertEqual(10_000.0, symbol["account"]["balance"])

        diagnostics = self.worker.handle(self.request("data", {
            "action": "diagnostics", "params": {},
        }, "request_01JDIAGNOSTIC"))["payload"]["data"]["payload"]
        self.assertTrue(diagnostics["mt5_connected"])
        self.assertEqual(123456, diagnostics["account"]["login"])

        pending = self.worker.handle(self.request("data", {
            "action": "pending_order_state", "params": {"ticket": "202"},
        }, "request_01JPENDINGSTATE"))["payload"]["data"]["payload"]
        self.assertEqual("pending", pending["current_state"])
        self.assertEqual(202, pending["order"]["ticket"])

        event_day = datetime.fromtimestamp(
            self.mt5.history_deals[-1].time, timezone.utc).strftime("%Y-%m-%d")
        performance = self.worker.handle(self.request("data", {
            "action": "performance_daily",
            "params": {"date_from": event_day, "date_to": event_day},
        }, "request_01JPERFORMANCE"))["payload"]["data"]["payload"]
        self.assertEqual(1, performance["performance_version"])
        self.assertEqual(1, performance["daily"][0]["closed_position_count"])
        self.assertAlmostEqual(9.7, performance["daily"][0]["realized_net"])

        risk = self.worker.handle(self.request("data", {
            "action": "risk_snapshot",
            "params": {"symbol": "XAUUSD", "last_deal_time_msc": 0,
                       "last_deal_ticket": 0,
                       "baseline_from_utc_msc": self.mt5.history_deals[0].time_msc - 180 * 60_000 - 1},
        }, "request_01JRISKDATA"))["payload"]["data"]["payload"]
        self.assertEqual(1, risk["snapshot_version"])
        self.assertEqual(self.now, risk["time_utc_msc"])
        self.assertEqual(180, risk["timezone_offset_minutes"])
        self.assertIn("XAUUSD.s", risk["instruments"])
        self.assertEqual(1, len(risk["increment"]["closed_positions"]))

    def test_extended_data_rejects_unknown_parameters_before_mt5_queries(self):
        response = self.worker.handle(self.request("data", {
            "action": "symbol_snapshot", "params": {"symbol": "XAUUSD", "extra": True},
        }, "request_01JINVALIDEXT"))
        self.assertEqual("error", response["outcome"])
        self.assertEqual("worker_symbol_snapshot_params_invalid",
                         response["payload"]["error_code"])

    def test_history_sync_is_bounded_cursor_ordered_and_builds_related_evidence(self):
        cursor_time = self.mt5.history_deals[0].time_msc - 180 * 60_000 - 1
        first = self.archive_worker.handle(self.request("history_range_sync", {
            "range_start_utc_msc": cursor_time,
            "range_end_utc_msc": self.now + 1,
            "cursor": {"time_msc": cursor_time, "ticket": "0"}, "limit": 1
        }))
        self.assertEqual("history_batch", first["outcome"])
        first_batch = first["payload"]["batch"]
        self.assertEqual([4001], [item["deal_ticket"] for item in first_batch["deals"]])
        self.assertEqual(cursor_time + 1, first_batch["deals"][0]["time_utc_msc"])
        self.assertEqual(self.mt5.history_deals[0].time_msc,
                         first_batch["deals"][0]["time_server_msc"])
        self.assertEqual("4001", first_batch["next_cursor"]["ticket"])
        self.assertTrue(first_batch["has_more"])
        self.assertEqual([], first_batch["trades"])

        second = self.archive_worker.handle(self.request("history_range_sync", {
            "range_start_utc_msc": cursor_time,
            "range_end_utc_msc": self.now + 1,
            "cursor": first_batch["next_cursor"], "limit": 250
        }, "request_01JHISTORY02"))
        second_batch = second["payload"]["batch"]
        self.assertEqual([4002], [item["deal_ticket"] for item in second_batch["deals"]])
        self.assertEqual(1, len(second_batch["trades"]))
        self.assertAlmostEqual(9.7, second_batch["trades"][0]["net_profit"])
        self.assertEqual(3002, second_batch["trades"][0]["order_ticket"])
        self.assertEqual(4002, second_batch["trades"][0]["close_deal_ticket"])
        self.assertIn("close_time_utc_msc", second_batch["trades"][0])
        self.assertIn("close_business_date", second_batch["trades"][0])
        self.assertEqual(2285.0, second_batch["trades"][0]["stop_loss"])
        self.assertEqual(2315.0, second_batch["trades"][0]["take_profit"])
        self.assertEqual(
            [3002, 3001],
            [item["ticket"] for item in second_batch["history_orders"]],
        )
        self.assertEqual(1, len(self.mt5.history_deal_queries))
        self.assertEqual(1, len(self.mt5.history_order_queries))
        self.assertTrue(all(not kwargs for _, kwargs in self.mt5.history_deal_queries))
        self.assertTrue(all(not kwargs for _, kwargs in self.mt5.history_order_queries))

    def test_history_range_pages_standalone_orders_and_keeps_same_pair_atomic(self):
        event_one = self.now - 5_000
        event_two = self.now - 4_000

        def order(ticket: int, event_utc_msc: int) -> HistoryOrder:
            server_seconds = event_utc_msc // 1000 + 180 * 60
            return HistoryOrder(
                ticket, 0, "XAUUSD.s", 2, 2, 234000, 0, "cancelled",
                0.01, 0.0, 2280.0, 0.0, 0.0,
                server_seconds, server_seconds,
                server_seconds * 1000, server_seconds * 1000,
            )

        self.mt5.history_deals = []
        self.mt5.history_orders = {
            3101: order(3101, event_one),
            3102: order(3102, event_two),
        }
        payload = {
            "range_start_utc_msc": self.now - 10_000,
            "range_end_utc_msc": self.now,
            "cursor": {"time_msc": self.now - 10_000, "ticket": "0"},
            "limit": 1,
        }
        first = self.archive_worker.handle(
            self.request("history_range_sync", payload, "request_01JORDERPAGE01")
        )
        self.assertEqual("history_batch", first["outcome"], first)
        first_batch = first["payload"]["batch"]
        self.assertEqual([], first_batch["deals"])
        self.assertEqual([3101], [item["ticket"] for item in first_batch["history_orders"]])
        self.assertTrue(first_batch["has_more"])

        second = self.archive_worker.handle(self.request(
            "history_range_sync",
            {**payload, "cursor": first_batch["next_cursor"]},
            "request_01JORDERPAGE02",
        ))
        self.assertEqual("history_batch", second["outcome"], second)
        second_batch = second["payload"]["batch"]
        self.assertEqual([3102], [item["ticket"] for item in second_batch["history_orders"]])
        self.assertFalse(second_batch["has_more"])
        self.assertEqual(
            {"time_msc": payload["range_end_utc_msc"], "ticket": "0"},
            second_batch["next_cursor"],
        )

        # A deal and order with the same pair are one compound cursor group;
        # a page boundary must not return only one and skip the other.
        event = self.now - 3_000
        server_seconds = event // 1000 + 180 * 60
        self.mt5.history_deals = [Deal(
            3200, 3200, 0, "XAUUSD.s", 0, 0, 234000, 0, "open",
            0.01, 2295.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
            server_seconds, server_seconds * 1000,
        )]
        self.mt5.history_orders = {
            3200: order(3200, event),
        }
        compound = self.archive_worker.handle(self.request(
            "history_range_sync",
            {
                "range_start_utc_msc": event - 1_000,
                "range_end_utc_msc": event + 1_000,
                "cursor": {"time_msc": event - 1_000, "ticket": "0"},
                "limit": 1,
            },
            "request_01JORDERCOMPOUND",
        ))
        self.assertEqual("history_batch", compound["outcome"], compound)
        compound_batch = compound["payload"]["batch"]
        self.assertEqual([3200], [item["deal_ticket"] for item in compound_batch["deals"]])
        self.assertEqual([3200], [item["ticket"] for item in compound_batch["history_orders"]])
        self.assertFalse(compound_batch["has_more"])
        self.assertEqual(
            {"time_msc": event + 1_000, "ticket": "0"},
            compound_batch["next_cursor"],
        )

    def test_history_range_rejects_fanout_instead_of_slicing_wire_items(self):
        event = self.now - 3_000
        original_batch = self.adapter._history_batch

        def oversized_batch(_raw_deals, _raw_orders, next_time, next_ticket,
                            has_more, observed_at):
            return {
                "deals": [],
                "history_orders": [
                    {"ticket": 3301, "time_utc_msc": event},
                    {"ticket": 3302, "time_utc_msc": event},
                ],
                "trades": [],
                "next_cursor": {"time_msc": next_time, "ticket": str(next_ticket)},
                "has_more": has_more,
                "observed_at_utc_msc": observed_at,
                "timezone_offset_minutes": self.adapter.clock.offset_minutes,
                "clock_status": self.adapter.clock.status,
            }

        self.adapter._history_batch = oversized_batch
        try:
            response = self.archive_worker.handle(self.request(
                "history_range_sync",
                {
                    "range_start_utc_msc": event - 500,
                    "range_end_utc_msc": event + 500,
                    "cursor": {"time_msc": event - 500, "ticket": "0"},
                    "limit": 1,
                },
                "request_01JFANOUTDENSE",
            ))
        finally:
            self.adapter._history_batch = original_batch
        self.assertEqual("error", response["outcome"], response)
        self.assertEqual(
            "mt5_history_range_too_dense",
            response["payload"]["error_code"],
        )

    def test_dense_history_uses_two_bulk_queries_without_per_item_mt5_calls(self):
        start_seconds = int(time.time()) - 10_000
        deals = []
        orders = {}
        for index in range(100):
            position_id = 20_000 + index
            open_order = 30_000 + index * 2
            close_order = open_order + 1
            open_deal = 40_000 + index * 2
            close_deal = open_deal + 1
            opened_utc = start_seconds + index * 2
            closed_utc = opened_utc + 1
            opened = opened_utc + 180 * 60
            closed = closed_utc + 180 * 60
            deals.extend([
                Deal(open_deal, open_order, position_id, "XAUUSD.s", 0, 0,
                     234000, 0, "open", 0.01, 2295.0, 0.0, 0.0, 0.0,
                     0.0, 2285.0, 2315.0, opened, opened * 1000),
                Deal(close_deal, close_order, position_id, "XAUUSD.s", 1, 1,
                     234000, 0, "close", 0.01, 2305.0, 10.0, -0.2, -0.1,
                     0.0, 0.0, 0.0, closed, closed * 1000),
            ])
            orders[open_order] = HistoryOrder(
                open_order, position_id, "XAUUSD.s", 0, 4, 234000, 0, "open",
                0.01, 0.0, 2295.0, 2285.0, 2315.0, opened, opened,
                opened * 1000, opened * 1000)
            orders[close_order] = HistoryOrder(
                close_order, position_id, "XAUUSD.s", 1, 4, 234000, 0, "close",
                0.01, 0.0, 2305.0, 0.0, 0.0, closed, closed,
                closed * 1000, closed * 1000)
        self.mt5.history_deals = deals
        self.mt5.history_orders = orders
        self.mt5.history_deal_queries.clear()
        self.mt5.history_order_queries.clear()

        response = self.archive_worker.handle(self.request("history_range_sync", {
            "range_start_utc_msc": start_seconds * 1000 - 1,
            "range_end_utc_msc": start_seconds * 1000 + 30 * 24 * 60 * 60 * 1000 - 1,
            "cursor": {"time_msc": start_seconds * 1000 - 1, "ticket": "0"},
            "limit": 250,
        }, "request_01JDENSEHISTORY"))

        self.assertEqual("history_batch", response["outcome"], response)
        batch = response["payload"]["batch"]
        self.assertEqual(200, len(batch["deals"]))
        self.assertEqual(100, len(batch["trades"]))
        self.assertEqual(200, len(batch["history_orders"]))
        self.assertEqual(1, len(self.mt5.history_deal_queries))
        self.assertEqual(1, len(self.mt5.history_order_queries))
        self.assertFalse(self.mt5.history_deal_queries[0][1])
        self.assertFalse(self.mt5.history_order_queries[0][1])

    def test_cross_window_evidence_is_resolved_in_bounded_retry_batches(self):
        close_start = int(time.time()) - 1_000
        deals = []
        orders = {}
        for index in range(6):
            position_id = 50_000 + index
            open_order = 60_000 + index * 2
            close_order = open_order + 1
            open_deal = 70_000 + index * 2
            close_deal = open_deal + 1
            opened_utc = close_start - 40 * 24 * 60 * 60 - index
            closed_utc = close_start + index
            opened = opened_utc + 180 * 60
            closed = closed_utc + 180 * 60
            deals.extend([
                Deal(open_deal, open_order, position_id, "XAUUSD.s", 0, 0,
                     234000, 0, "open", 0.01, 2295.0, 0.0, 0.0, 0.0,
                     0.0, 2285.0, 2315.0, opened, opened * 1000),
                Deal(close_deal, close_order, position_id, "XAUUSD.s", 1, 1,
                     234000, 0, "close", 0.01, 2305.0, 10.0, -0.2, -0.1,
                     0.0, 0.0, 0.0, closed, closed * 1000),
            ])
            orders[open_order] = HistoryOrder(
                open_order, position_id, "XAUUSD.s", 0, 4, 234000, 0, "open",
                0.01, 0.0, 2295.0, 2285.0, 2315.0, opened, opened,
                opened * 1000, opened * 1000)
            orders[close_order] = HistoryOrder(
                close_order, position_id, "XAUUSD.s", 1, 4, 234000, 0, "close",
                0.01, 0.0, 2305.0, 0.0, 0.0, closed, closed,
                closed * 1000, closed * 1000)
        self.mt5.history_deals = deals
        self.mt5.history_orders = orders
        self.mt5.history_deal_queries.clear()
        self.mt5.history_order_queries.clear()
        payload = {
            "range_start_utc_msc": close_start * 1000 - 1,
            "range_end_utc_msc": close_start * 1000 + 30 * 24 * 60 * 60 * 1000 - 1,
            "cursor": {"time_msc": close_start * 1000 - 1, "ticket": "0"},
            "limit": 250,
        }

        attempts = []
        for index in range(4):
            before = len(self.mt5.history_deal_queries) + len(self.mt5.history_order_queries)
            response = self.archive_worker.handle(self.request(
                "history_range_sync", payload, f"request_01JBOUNDED{index}"))
            after = len(self.mt5.history_deal_queries) + len(self.mt5.history_order_queries)
            attempts.append(after - before)
            if response["outcome"] == "history_batch":
                break
            self.assertEqual("mt5_history_evidence_pending",
                             response["payload"]["error_code"])

        self.assertEqual("history_batch", response["outcome"], response)
        self.assertEqual(6, len(response["payload"]["batch"]["trades"]))
        # Each attempt has two bulk calls and no more than four targeted fallbacks.
        self.assertTrue(all(count <= 6 for count in attempts), attempts)
        self.assertGreater(len(attempts), 1)

    def test_history_sync_rejects_zero_cursor_and_oversized_limit_before_mt5_query(self):
        for payload in (
            {"range_start_utc_msc": 1,
             "range_end_utc_msc": 1 + 30 * 24 * 60 * 60 * 1000,
             "cursor": {"time_msc": 0, "ticket": "0"}, "limit": 250},
            {"range_start_utc_msc": 1,
             "range_end_utc_msc": 1 + 30 * 24 * 60 * 60 * 1000,
             "cursor": {"time_msc": 1, "ticket": "0"}, "limit": 251},
        ):
            with self.subTest(payload=payload):
                response = self.archive_worker.handle(self.request("history_range_sync", payload))
                self.assertEqual("error", response["outcome"])
                expected = ("worker_history_range_cursor_invalid"
                            if payload["cursor"]["time_msc"] == 0
                            else "worker_history_limit_invalid")
                self.assertEqual(expected, response["payload"]["error_code"])

    def test_worker_roles_fail_closed_and_archive_range_is_half_open(self):
        range_start = self.mt5.history_deals[0].time_msc - 180 * 60_000
        range_end = self.mt5.history_deals[1].time_msc - 180 * 60_000
        request = self.request("history_range_sync", {
            "range_start_utc_msc": range_start,
            "range_end_utc_msc": range_end,
            "cursor": {"time_msc": range_start, "ticket": "0"},
            "limit": 250,
        }, "request_01JRANGEBOUNDARY")
        live = self.worker.handle(request)
        self.assertEqual("worker_role_operation_forbidden", live["payload"]["error_code"])
        archive = self.archive_worker.handle(request)
        self.assertEqual("history_batch", archive["outcome"])
        batch = archive["payload"]["batch"]
        self.assertEqual([4001], [item["deal_ticket"] for item in batch["deals"]])
        self.assertFalse(batch["has_more"])
        self.assertEqual({"time_msc": range_end, "ticket": "0"}, batch["next_cursor"])
        self.assertEqual(
            "worker_role_operation_forbidden",
            self.archive_worker.handle(
                self.request("collect_snapshot", {"streams": ["account"]})
            )["payload"]["error_code"],
        )
        self.assertEqual(
            "worker_role_operation_forbidden",
            self.archive_worker.handle(
                self.request("history_sync", {
                    "cursor": {"time_msc": range_start, "ticket": "0"},
                    "limit": 1,
                })
            )["payload"]["error_code"],
        )

    def test_role_environment_and_hello_capabilities_are_minimal(self):
        self.assertEqual(
            ("snapshot", "quote", "data", "execute_command", "query_execution"),
            LIVE_CAPABILITIES,
        )
        self.assertEqual(("history_range_sync",), ARCHIVE_CAPABILITIES)
        with patch.dict("os.environ", {"AURUM_BRIDGE_WORKER_ROLE": "archive"}):
            self.assertEqual("archive", role_from_environment())
        with patch.dict("os.environ", {"AURUM_BRIDGE_WORKER_ROLE": "live"}):
            self.assertEqual("live", role_from_environment())
        with patch.dict("os.environ", {"AURUM_BRIDGE_WORKER_ROLE": "history"}):
            with self.assertRaisesRegex(WorkerError, "worker_environment_invalid"):
                role_from_environment()
    def test_history_range_rejects_invalid_future_and_dense_requests_fail_closed(self):
        cases = [
            ({
                "range_start_utc_msc": self.now,
                "range_end_utc_msc": self.now + 1,
                "cursor": {"time_msc": self.now + 1, "ticket": "1"},
                "limit": 1,
            }, "worker_history_range_cursor_invalid"),
            ({
                "range_start_utc_msc": self.now - 1,
                "range_end_utc_msc": self.now + 61_000,
                "cursor": {"time_msc": self.now - 1, "ticket": "0"},
                "limit": 1,
            }, "worker_history_range_future"),
            ({
                "range_start_utc_msc": self.now - 1,
                "range_end_utc_msc": self.now - 1 + 30 * 24 * 60 * 60 * 1000 + 1,
                "cursor": {"time_msc": self.now - 1, "ticket": "0"},
                "limit": 1,
            }, "worker_history_range_invalid"),
        ]
        for payload, expected in cases:
            with self.subTest(expected=expected):
                response = self.archive_worker.handle(
                    self.request("history_range_sync", payload)
                )
                self.assertEqual("error", response["outcome"])
                self.assertEqual(expected, response["payload"]["error_code"])

        original_budget = __import__("worker").MAX_HISTORY_WINDOW_CACHE_ITEMS
        try:
            __import__("worker").MAX_HISTORY_WINDOW_CACHE_ITEMS = 1
            response = self.archive_worker.handle(self.request("history_range_sync", {
                "range_start_utc_msc": self.mt5.history_deals[0].time_msc - 180 * 60_000 - 1,
                "range_end_utc_msc": self.now + 1,
                "cursor": {
                    "time_msc": self.mt5.history_deals[0].time_msc - 180 * 60_000 - 1,
                    "ticket": "0",
                },
                "limit": 250,
            }, "request_01JRANGEDENSE"))
            self.assertEqual("mt5_history_range_too_dense",
                             response["payload"]["error_code"])
        finally:
            __import__("worker").MAX_HISTORY_WINDOW_CACHE_ITEMS = original_budget

    def test_history_range_rejects_items_without_a_trusted_utc_time(self):
        from worker import _history_item_in_utc_range

        self.assertFalse(_history_item_in_utc_range({"ticket": 1}, 100, 200))
        self.assertFalse(_history_item_in_utc_range(
            {"time_utc_msc": 200}, 100, 200))

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
        self.assertIsNone(self.worker.restart_error_code)

    def test_single_terminal_session_loss_stays_in_worker_for_recovery(self):
        self.mt5.account_info = lambda: None

        response = self.worker.handle(self.request("collect_snapshot", {"streams": ["account"]}))

        self.assertEqual("error", response["outcome"])
        self.assertEqual("mt5_account_unavailable", response["payload"]["error_code"])
        self.assertIsNone(self.worker.restart_error_code)
        self.assertEqual(1, self.worker.consecutive_terminal_failures)

    def test_single_disconnected_terminal_stays_in_worker_for_recovery(self):
        self.mt5.terminal_info = lambda: Terminal(False, True, False)

        response = self.worker.handle(self.request("collect_snapshot", {"streams": ["account"]}))

        self.assertEqual("error", response["outcome"])
        self.assertEqual("mt5_terminal_disconnected", response["payload"]["error_code"])
        self.assertIsNone(self.worker.restart_error_code)
        self.assertEqual(1, self.worker.consecutive_terminal_failures)

    def test_sustained_terminal_session_loss_requests_a_supervised_worker_restart(self):
        self.mt5.account_info = lambda: None

        for index in range(2):
            response = self.worker.handle(self.request(
                "collect_snapshot", {"streams": ["account"]},
                f"request_01JRESTARTFAIL{index}",
            ))
            self.assertEqual("error", response["outcome"])
            self.assertIsNone(self.worker.restart_error_code)
            self.assertEqual(index + 1, self.worker.consecutive_terminal_failures)

        response = self.worker.handle(self.request(
            "collect_snapshot", {"streams": ["account"]}, "request_01JRESTARTFAIL2"
        ))
        self.assertEqual("error", response["outcome"])
        self.assertEqual("mt5_account_unavailable", self.worker.restart_error_code)
        self.assertEqual(3, self.worker.consecutive_terminal_failures)

    def test_successful_request_clears_terminal_session_failure_counter(self):
        self.mt5.account_info = lambda: None
        failed = self.worker.handle(self.request(
            "collect_snapshot", {"streams": ["account"]}, "request_01JRESTARTRESET0"
        ))
        self.assertEqual("mt5_account_unavailable", failed["payload"]["error_code"])
        self.assertEqual(1, self.worker.consecutive_terminal_failures)

        self.mt5.account_info = lambda: Account(
            123456, "Broker-Demo", 10_000.0, 10_000.0, 10_000.0, True, True
        )
        recovered = self.worker.handle(self.request(
            "collect_snapshot", {"streams": ["account"]}, "request_01JRESTARTRESET1"
        ))
        self.assertEqual("snapshot", recovered["outcome"])
        self.assertIsNone(self.worker.restart_error_code)
        self.assertEqual(0, self.worker.consecutive_terminal_failures)

        self.mt5.account_info = lambda: None
        sparse = self.worker.handle(self.request(
            "collect_snapshot", {"streams": ["account"]}, "request_01JRESTARTRESET2"
        ))
        self.assertEqual("mt5_account_unavailable", sparse["payload"]["error_code"])
        self.assertIsNone(self.worker.restart_error_code)
        self.assertEqual(1, self.worker.consecutive_terminal_failures)

    def test_terminal_restart_threshold_writes_one_redacted_diagnostic(self):
        self.mt5.account_info = lambda: None
        with tempfile.TemporaryDirectory() as root:
            diagnostic = Path(root) / "worker.jsonl"
            with patch.dict("os.environ", {
                "AURUM_BRIDGE_DIAGNOSTIC_PATH": str(diagnostic),
            }):
                for index in range(3):
                    self.worker.handle(self.request(
                        "collect_snapshot", {"streams": ["account"]},
                        f"request_01JRESTARTDIAG{index}",
                    ))

            payload = diagnostic.read_text(encoding="utf-8")
            records = [json.loads(line) for line in payload.splitlines()]
            self.assertEqual(1, len(records))
            self.assertEqual({
                "event": "mt5_worker_terminal_session_restart",
                "stage": "worker_request",
                "error_code": "mt5_account_unavailable",
                "consecutive_failures": 3,
            }, {key: records[0][key] for key in (
                "event", "stage", "error_code", "consecutive_failures")})
            self.assertGreater(records[0]["observed_at_utc_msc"], 0)
            self.assertNotIn("Broker-Demo", payload)
            self.assertNotIn("123456", payload)

    def test_trade_request_detects_terminal_loss_before_execution(self):
        self.mt5.account_info = lambda: None

        response = self.worker.handle(self.command_request("execute_command", self.command()))

        self.assertEqual("error", response["outcome"])
        self.assertEqual("mt5_account_unavailable", response["payload"]["error_code"])
        self.assertIsNone(self.worker.restart_error_code)
        self.assertEqual(1, self.worker.consecutive_terminal_failures)
        self.assertEqual([], self.mt5.checks)
        self.assertEqual([], self.mt5.sent)

    def test_terminal_loss_during_trade_precheck_is_uncertain_without_immediate_restart(self):
        original_account_info = self.mt5.account_info
        calls = 0

        def account_info():
            nonlocal calls
            calls += 1
            return original_account_info() if calls == 1 else None

        self.mt5.account_info = account_info

        response = self.worker.handle(self.command_request("execute_command", self.command()))

        result = response["payload"]["result"]
        self.assertEqual("uncertain", result["status"])
        self.assertEqual("mt5_execution_exception", result["error_code"])
        self.assertIsNone(self.worker.restart_error_code)
        self.assertEqual(1, self.worker.consecutive_terminal_failures)
        self.assertEqual([], self.mt5.checks)
        self.assertEqual([], self.mt5.sent)

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
            "expected_state": {
                "ticket": "303", "symbol": "XAUUSD.s", "direction": "buy",
                "magic": 234000, "volume": 0.02,
            },
        }, "command_01JMODIFY01")
        modified = self.worker.handle(self.command_request("execute_command", modify))
        self.assertEqual("succeeded", modified["payload"]["result"]["status"])
        self.assertEqual(self.mt5.TRADE_ACTION_MODIFY, self.mt5.sent[-1]["action"])

    def test_modify_pending_order_rejects_a_stale_target_snapshot_before_send(self):
        modify = self.command("modify_order", {
            "ticket": "202", "price": 2299.0,
            "expected_state": {
                "ticket": "202", "symbol": "XAUUSD.s", "direction": "buy",
                "magic": 234000, "volume": 0.03,
            },
        }, "command_01JMODSTALE")
        response = self.worker.handle(self.command_request("execute_command", modify))
        self.assertEqual("rejected", response["payload"]["result"]["status"])
        self.assertEqual(
            "management_volume_mismatch", response["payload"]["result"]["error_code"]
        )
        self.assertEqual([], self.mt5.sent)

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

    def test_position_protection_can_be_removed_explicitly(self):
        expected = {"ticket": "101", "symbol": "XAUUSD.s", "direction": "buy",
                    "magic": 234000, "volume": 0.01,
                    "stop_loss": 2290.0, "take_profit": 2320.0}
        command = self.command("modify_position", {
            "ticket": "101", "remove_stop_loss": True, "remove_take_profit": True,
            "expected_state": expected,
        }, "command_01JREMOVEPT")

        response = self.worker.handle(self.command_request("execute_command", command))

        self.assertEqual("succeeded", response["payload"]["result"]["status"])
        self.assertEqual(0.0, self.mt5.sent[-1]["sl"])
        self.assertEqual(0.0, self.mt5.sent[-1]["tp"])
        self.assertEqual(0.0, self.mt5.positions[0].sl)
        self.assertEqual(0.0, self.mt5.positions[0].tp)

    def test_pending_order_protection_and_expiration_can_be_removed_explicitly(self):
        self.mt5.orders = [Order(303, "XAUUSD.s", 0.02, 0.02, 2, 234000,
                                 "AI-MODIFY", 2280.0, 2270.0, 2310.0, 0.0, 1900000000)]
        command = self.command("modify_order", {
            "ticket": "303", "remove_stop_loss": True, "remove_take_profit": True,
            "remove_expiration": True,
            "expected_state": {
                "ticket": "303", "symbol": "XAUUSD.s", "direction": "buy",
                "magic": 234000, "volume": 0.02,
            },
        }, "command_01JREMOVEPO")

        response = self.worker.handle(self.command_request("execute_command", command))

        self.assertEqual("succeeded", response["payload"]["result"]["status"])
        self.assertEqual(0.0, self.mt5.sent[-1]["sl"])
        self.assertEqual(0.0, self.mt5.sent[-1]["tp"])
        self.assertEqual(0, self.mt5.sent[-1]["expiration"])
        self.assertEqual(0.0, self.mt5.orders[0].sl)
        self.assertEqual(0.0, self.mt5.orders[0].tp)
        self.assertEqual(0, self.mt5.orders[0].time_expiration)

    def test_requested_partial_close_succeeds_only_at_the_exact_remaining_volume(self):
        self.mt5.positions = [Position(404, "XAUUSD.s", 0.02, 0, 234000, 2290.0, 2320.0)]
        expected = {
            "ticket": "404", "symbol": "XAUUSD.s", "direction": "buy",
            "magic": 234000, "volume": 0.02,
            "stop_loss": 2290.0, "take_profit": 2320.0,
        }
        partial = self.command("close_position", {
            "ticket": "404", "volume": 0.01, "expected_state": expected,
        }, "command_01JPARTCLOSE")
        result = self.worker.handle(self.command_request("execute_command", partial))
        raw = result["payload"]["result"]["raw_result"]
        self.assertEqual("succeeded", result["payload"]["result"]["status"])
        self.assertEqual(0.01, raw["remaining_volume"])
        self.assertTrue(raw["partial_close"])
        self.assertEqual(0.01, self.mt5.positions[0].volume)

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

    def test_query_execution_uses_exact_ticket_history_without_date_range_scan(self):
        self.mt5.positions = []
        self.mt5.orders = []
        self.mt5.history_orders = {}
        self.mt5.history_deals = [
            SimpleNamespace(
                ticket=9001, order=8001, position_id=501, symbol="XAUUSD.s",
                type=0, entry=0, magic=234000, reason=0, comment="BROKER-REWRITTEN",
                volume=0.01, price=2295.0, profit=0.0, commission=0.0, swap=0.0,
                fee=0.0, sl=2285.0, tp=2315.0, time=1_800_000_000,
                time_msc=1_800_000_000_000,
            ),
        ]
        command = self.command("query_execution", {
            "symbol": "XAUUSD", "expected_kind": "trade", "trade_ticket": "501",
            "bridge_command_ref": "AI-LOOKUP", "lookback_seconds": 10 * 365 * 24 * 60 * 60,
        }, "command_01JEXACTTICKET")

        response = self.worker.handle(self.command_request("query_execution", command))

        result = response["payload"]["result"]
        self.assertTrue(result["raw_result"]["found"])
        self.assertTrue(result["raw_result"]["complete"])
        self.assertEqual("history_deal", result["raw_result"]["current_state"])
        self.assertTrue(any(kwargs.get("position") == 501 for _, kwargs in self.mt5.history_deal_queries))
        self.assertTrue(all(len(args) == 0 for args, _ in self.mt5.history_deal_queries))
        self.assertTrue(all(len(args) == 0 for args, _ in self.mt5.history_order_queries))

    def test_reference_history_budget_returns_incomplete_instead_of_absence(self):
        self.mt5.positions = []
        self.mt5.orders = []
        history_rows = [SimpleNamespace(
            ticket=index, position_id=0, symbol="XAUUSD.s", magic=234000,
            comment="OTHER", state=self.mt5.ORDER_STATE_FILLED,
        ) for index in range(self.worker.trade.MAX_HISTORY_ROWS + 1)]
        self.mt5.history_orders_get = lambda *args, **_kwargs: history_rows if len(args) == 2 else ()
        self.mt5.history_deals_get = lambda *args, **_kwargs: () if len(args) == 2 else ()
        command = self.command("query_execution", {
            "symbol": "XAUUSD", "expected_kind": "trade",
            "bridge_command_ref": "AI-MISSING",
            "lookback_seconds": self.worker.trade.MAX_LOOKBACK_SECONDS + 1,
        }, "command_01JBUDGETBOUND")

        response = self.worker.handle(self.command_request("query_execution", command))

        raw = response["payload"]["result"]["raw_result"]
        self.assertFalse(raw["found"])
        self.assertFalse(raw["complete"])
        self.assertEqual("history_lookup_budget_exhausted", raw["reason"])
        self.assertEqual(self.worker.trade.MAX_LOOKBACK_SECONDS, raw["lookback_seconds"])
        self.assertEqual(self.worker.trade.MAX_LOOKBACK_SECONDS + 1,
                         raw["requested_lookback_seconds"])

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

    def test_partial_and_unverified_broker_results_are_uncertain_and_never_replayed(self):
        def partial_send(request):
            self.mt5.sent.append(dict(request))
            return SimpleNamespace(
                retcode=self.mt5.TRADE_RETCODE_DONE_PARTIAL,
                order=7001, deal=8001, comment="partial",
            )

        self.mt5.order_send = partial_send
        partial_command = self.command(command_id="command_01JPARTIAL01")
        partial_request = self.command_request("execute_command", partial_command)
        first = self.worker.handle(partial_request)
        second = self.worker.handle(partial_request)
        self.assertEqual("uncertain", first["payload"]["result"]["status"])
        self.assertEqual(
            "mt5_execution_requires_reconciliation",
            first["payload"]["result"]["error_code"],
        )
        self.assertEqual(first, second)
        self.assertEqual(1, len(self.mt5.sent))

        def ineffective_cancel(request):
            self.mt5.sent.append(dict(request))
            return SimpleNamespace(retcode=10009, order=202, deal=0, comment="done")

        self.mt5.order_send = ineffective_cancel
        cancel = self.command("cancel_order", {
            "ticket": "202",
            "expected_state": {
                "ticket": "202", "symbol": "XAUUSD.s", "direction": "buy",
                "magic": 234000, "volume": 0.02,
            },
        }, "command_01JVERIFYCAN")
        cancel_request = self.command_request("execute_command", cancel)
        cancelled = self.worker.handle(cancel_request)
        repeated = self.worker.handle(cancel_request)
        self.assertEqual("uncertain", cancelled["payload"]["result"]["status"])
        self.assertEqual(
            "pending_order_still_active", cancelled["payload"]["result"]["error_code"]
        )
        self.assertEqual(cancelled, repeated)
        self.assertEqual(2, len(self.mt5.sent))

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

    def _resolve_reconciliation(self, action, observed, source, original_params,
                                elapsed_msc=0):
        params = {
            "original_action": action,
            "original_params": original_params,
            "original_issued_at_utc_msc": self.now,
            "settle_after_msc": 15_000,
        }
        self.worker.trade._clock_msc = lambda: self.now + elapsed_msc
        return self.worker.trade._resolve_reconciliation(params, observed, source)

    def test_cancel_reconciliation_requires_complete_history_before_final_failure(self):
        missing = {"found": False, "complete": True}
        self.assertEqual(
            {"status": "pending", "error_code": "reconciliation_settlement_pending"},
            self._resolve_reconciliation("cancel_order", missing, "", {"ticket": "999"}),
        )
        self.assertEqual(
            {"status": "failed", "error_code": "pending_order_history_unverified"},
            self._resolve_reconciliation("cancel_order", missing, "", {"ticket": "999"}, 15_001),
        )
        incomplete = {"found": False, "complete": False}
        self.assertEqual(
            {"status": "pending", "error_code": "reconciliation_settlement_pending"},
            self._resolve_reconciliation("cancel_order", incomplete, "", {"ticket": "999"}, 15_001),
        )

    def test_cancel_reconciliation_requires_positive_terminal_order_evidence(self):
        original = {"ticket": "202"}
        self.assertEqual(
            {"status": "succeeded"},
            self._resolve_reconciliation("cancel_order", {
                "found": True, "complete": True, "pending_state": "cancelled",
            }, "history_order", original),
        )
        self.assertEqual(
            {"status": "failed", "error_code": "pending_order_already_filled"},
            self._resolve_reconciliation("cancel_order", {
                "found": True, "complete": True, "pending_state": "filled",
            }, "history_order", original, 15_001),
        )
        self.assertEqual(
            {"status": "pending", "error_code": "reconciliation_settlement_pending"},
            self._resolve_reconciliation("cancel_order", {
                "found": True, "complete": True, "pending_state": "pending",
            }, "active_order", original),
        )
        self.assertEqual(
            {"status": "failed", "error_code": "pending_order_still_active"},
            self._resolve_reconciliation("cancel_order", {
                "found": True, "complete": True, "pending_state": "pending",
            }, "active_order", original, 15_001),
        )
        self.assertEqual(
            {"status": "failed", "error_code": "pending_order_evidence_incomplete"},
            self._resolve_reconciliation("cancel_order", {
                "found": True, "complete": True, "pending_state": "unknown",
            }, "history_order", original, 15_001),
        )

    def test_close_reconciliation_requires_history_or_verified_volume_reduction(self):
        original = {"ticket": "501", "volume": 0.005,
                    "expected_state": {"volume": 0.01}}
        missing = {"found": False, "complete": True}
        self.assertEqual(
            {"status": "pending", "error_code": "reconciliation_settlement_pending"},
            self._resolve_reconciliation("close_position", missing, "", original),
        )
        self.assertEqual(
            {"status": "failed", "error_code": "position_history_unverified"},
            self._resolve_reconciliation("close_position", missing, "", original, 15_001),
        )
        self.assertEqual(
            {"status": "succeeded"},
            self._resolve_reconciliation("close_position", {
                "found": True, "complete": True,
            }, "history_deal", original),
        )
        self.assertEqual(
            {"status": "succeeded"},
            self._resolve_reconciliation("close_position", {
                "found": True, "complete": True, "volume": 0.005,
            }, "active_position", original),
        )
        active = {"found": True, "complete": True, "volume": 0.007}
        self.assertEqual(
            {"status": "pending", "error_code": "reconciliation_settlement_pending"},
            self._resolve_reconciliation("close_position", active, "active_position", original),
        )
        self.assertEqual(
            {"status": "failed", "error_code": "position_still_open"},
            self._resolve_reconciliation("close_position", active, "active_position", original, 15_001),
        )

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
            {"status": "pending", "error_code": "reconciliation_settlement_pending"},
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
