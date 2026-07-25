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


class FakeMt5:
    TRADE_ACTION_DEAL = 1
    TRADE_ACTION_PENDING = 5
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
    ORDER_TIME_GTC = 0
    ORDER_FILLING_RETURN = 2
    POSITION_TYPE_BUY = 0
    TRADE_RETCODE_PLACED = 10008
    TRADE_RETCODE_DONE = 10009
    TRADE_RETCODE_DONE_PARTIAL = 10010

    def __init__(self):
        self.sent = []

    def account_info(self): return Account(12345678, "Broker-Demo", 1000)
    def terminal_info(self): return Terminal(True)
    def positions_get(self, **kwargs): return ()
    def orders_get(self, **kwargs): return ()
    def history_deals_get(self, *args): return ()
    def symbol_info_tick(self, symbol): return Tick(2300.0, 2300.2)
    def order_send(self, request):
        self.sent.append(request)
        return Result(10009, 1001, 2001, "done")
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

    def test_returns_transient_quote_for_matching_route(self):
        adapter = self.adapter()
        request = self.command(
            type="quote_request", request_id="quote_01JWORKER01", symbol="XAUUSD")
        result = adapter.quote(request)
        self.assertEqual("succeeded", result["status"])
        self.assertEqual(2300.0, result["bid"])
        self.assertEqual(2300.2, result["ask"])
        self.assertNotIn("command_id", result)

    def test_rejects_cross_account_quote_route(self):
        adapter = self.adapter()
        request = self.command(
            type="quote_request", request_id="quote_01JWORKER02", symbol="XAUUSD",
            account_ref={"broker_server": "Broker-Demo", "login": "999"})
        result = adapter.quote(request)
        self.assertEqual("rejected", result["status"])
        self.assertEqual("command_route_mismatch", result["error_code"])

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
