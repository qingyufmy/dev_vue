from __future__ import annotations

import io
import math
import sys
import tempfile
import unittest
from collections import namedtuple
from pathlib import Path

WORKER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(WORKER_DIR))

from worker import (  # noqa: E402
    ReadOnlyMt5Adapter,
    ReadOnlyWorker,
    WorkerError,
    WorkerRoute,
    read_frame,
    write_frame,
)

Account = namedtuple("Account", "login server balance equity margin_free trade_allowed")
Terminal = namedtuple("Terminal", "connected trade_allowed")
Position = namedtuple("Position", "ticket symbol volume")
Order = namedtuple("Order", "ticket symbol volume_initial")
Symbol = namedtuple("Symbol", "name trade_mode digits point")
Tick = namedtuple("Tick", "bid ask last time_msc")


class FakeMt5:
    def __init__(self, now: int):
        self.now = now
        self.initialized = False

    def initialize(self, **_kwargs):
        self.initialized = True
        return True

    def shutdown(self):
        self.initialized = False

    def account_info(self):
        return Account(123456, "Broker-Demo", 10_000.0, 10_025.0, 9_500.0, True)

    def terminal_info(self):
        return Terminal(True, True)

    def positions_get(self):
        return (Position(101, "XAUUSD.s", 0.01),)

    def orders_get(self):
        return (Order(202, "XAUUSD.s", 0.02),)

    def symbols_get(self):
        return (Symbol("XAUUSD.s", 4, 2, 0.01),)

    def symbol_select(self, _symbol, _enabled):
        return True

    def symbol_info(self, _symbol):
        return Symbol("XAUUSD.s", 4, 2, 0.01)

    def symbol_info_tick(self, _symbol):
        return Tick(2300.0, 2300.2, 2300.1, self.now + 180 * 60_000)


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
        self.worker = ReadOnlyWorker(self.adapter, self.route)

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
            999999, "Broker-Demo", 10_000.0, 10_000.0, 10_000.0, True
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


if __name__ == "__main__":
    unittest.main()
