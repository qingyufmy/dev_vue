# -*- coding: utf-8 -*-
"""Behavior tests for destructive Bridge commands using a simulated MT5 API."""
import os
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from types import MethodType, SimpleNamespace


AI_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "public", "ai"))
if AI_DIR not in sys.path:
    sys.path.insert(0, AI_DIR)

_original_appdata = os.environ.get("APPDATA")
_test_appdata = tempfile.TemporaryDirectory()
os.environ["APPDATA"] = _test_appdata.name
try:
    from aurum_bridge_gui import (
        BridgeWorker, _mask_log_text, find_mt5_terminal_executable,
        mt5_initialization_candidates, running_mt5_process_directories,
        version_is_newer,
    )
except ModuleNotFoundError as error:
    if error.name == "PySide6":
        raise unittest.SkipTest("Bridge GUI behavior tests require .venv-bridge") from error
    raise
finally:
    if _original_appdata is None:
        os.environ.pop("APPDATA", None)
    else:
        os.environ["APPDATA"] = _original_appdata


class _SignalRecorder:
    def __init__(self):
        self.messages = []

    def emit(self, message):
        self.messages.append(str(message))


class _FakeMt5:
    ORDER_TYPE_BUY = 0
    ORDER_TYPE_SELL = 1
    ORDER_TYPE_BUY_LIMIT = 2
    ORDER_TYPE_SELL_LIMIT = 3
    ORDER_TYPE_BUY_STOP = 4
    ORDER_TYPE_SELL_STOP = 5
    ORDER_TYPE_BUY_STOP_LIMIT = 6
    ORDER_TYPE_SELL_STOP_LIMIT = 7
    TRADE_ACTION_REMOVE = 8
    TRADE_ACTION_DEAL = 9
    TRADE_RETCODE_DONE = 10009
    TRADE_RETCODE_TIMEOUT = 10012

    def __init__(self):
        self.position_reads = []
        self.order_reads = []
        self.send_results = []
        self.sent_requests = []

    def account_info(self):
        return SimpleNamespace(server="Demo-Server", login=123456)

    def positions_get(self, **_kwargs):
        return self.position_reads.pop(0) if self.position_reads else []

    def orders_get(self, **_kwargs):
        return self.order_reads.pop(0) if self.order_reads else []

    def order_send(self, request):
        self.sent_requests.append(dict(request))
        return self.send_results.pop(0) if self.send_results else None

    def symbol_select(self, *_args):
        return True

    def last_error(self):
        return (1, "simulated MT5 query failure")


def _expected(ticket, *, symbol="XAUUSD", direction="buy", volume=0.1, magic=234000):
    return {
        "broker_server_key": "DEMO-SERVER",
        "login_account": "123456",
        "ticket": str(ticket),
        "symbol": symbol,
        "direction": direction,
        "volume": volume,
        "magic": magic,
    }


def _position(ticket=77, *, volume=0.1, magic=234000):
    return SimpleNamespace(
        ticket=ticket, symbol="XAUUSD", type=_FakeMt5.ORDER_TYPE_BUY,
        volume=volume, magic=magic,
    )


def _pending(ticket=88, *, volume=0.1, magic=234000):
    return SimpleNamespace(
        ticket=ticket, symbol="XAUUSD", type=_FakeMt5.ORDER_TYPE_BUY_LIMIT,
        volume=volume, volume_current=volume, volume_initial=volume, magic=magic,
    )


def _worker(mt5):
    worker = SimpleNamespace(
        mt5=mt5,
        _mt5_lock=threading.RLock(),
        _command_results={},
        _management_operation_results={},
        log_signal=_SignalRecorder(),
    )
    for method_name in (
        "_process_command", "_process_command_locked", "_management_precondition_error",
    ):
        setattr(worker, method_name, MethodType(getattr(BridgeWorker, method_name), worker))
    worker._get_filling_mode = lambda _symbol: 0
    worker._order_send_with_retry = lambda _symbol, _builder: (
        SimpleNamespace(retcode=mt5.TRADE_RETCODE_DONE, deal=901, order=902, price=1.0), None,
    )
    return worker


class BridgeManagementCommandTests(unittest.TestCase):
    def test_mt5_initialization_prefers_running_terminal_over_stale_registry(self):
        with tempfile.TemporaryDirectory() as root:
            registered = os.path.join(root, "registered")
            running = os.path.join(root, "running")
            os.makedirs(registered)
            os.makedirs(running)
            open(os.path.join(registered, "terminal64.exe"), "wb").close()
            open(os.path.join(running, "terminal64.exe"), "wb").close()

            candidates = mt5_initialization_candidates(None, [
                (registered, "注册表(HKCU)"),
                (running, "运行中进程"),
            ])

        self.assertEqual(candidates, [os.path.join(running, "terminal64.exe")])

    def test_mt5_initialization_uses_default_then_discovered_when_not_running(self):
        with tempfile.TemporaryDirectory() as root:
            open(os.path.join(root, "terminal64.exe"), "wb").close()
            candidates = mt5_initialization_candidates(None, [(root, "文件系统")])
        self.assertEqual(candidates, [None, os.path.join(root, "terminal64.exe")])

    def test_semantic_version_comparison_normalizes_zeroes_and_prereleases(self):
        self.assertFalse(version_is_newer("v2.4", "v2.4.0"))
        self.assertTrue(version_is_newer("v2.4.10", "v2.4.9"))
        self.assertFalse(version_is_newer("v2.4.7-beta.1", "v2.4.7"))
        self.assertTrue(version_is_newer("v2.4.8-beta.1", "v2.4.7"))
        self.assertFalse(version_is_newer("not-a-version", "v2.4.7"))

    def test_order_prices_reject_non_finite_values_and_optional_zero(self):
        for value in (float("nan"), float("inf"), float("-inf"), -1, True, "invalid"):
            parsed, error = BridgeWorker._parse_order_price(value, "price", required=True)
            self.assertIsNone(parsed)
            self.assertIsNotNone(error)
        self.assertEqual(BridgeWorker._parse_order_price(0, "stop loss"), (None, None))
        self.assertEqual(BridgeWorker._parse_order_price("1.25", "price", required=True), (1.25, None))

    def test_order_comment_is_single_line_and_matches_mt5_limit(self):
        normalized = BridgeWorker._normalize_order_comment("AI-123\n" + "X" * 40, "fallback")
        self.assertEqual(len(normalized), 31)
        self.assertNotIn("\n", normalized)
        self.assertTrue(normalized.startswith("AI-123 "))

    def test_log_masking_covers_passwords_tokens_and_nested_sequences(self):
        masked = _mask_log_text({
            "password": "plain-password",
            "nested": [{"api_key": "plain-key", "message": "safe"}],
        })
        self.assertNotIn("plain-password", masked)
        self.assertNotIn("plain-key", masked)
        self.assertIn("safe", masked)
        self.assertNotIn("ticket-value", _mask_log_text("?ticket=ticket-value"))

    def test_auth_token_save_updates_only_credentials(self):
        worker = BridgeWorker("http://localhost:3000", "new-access", refresh_token="new-refresh")
        with patch("aurum_bridge_gui.update_config", return_value=True) as update:
            self.assertTrue(worker._save_auth_tokens())
        update.assert_called_once_with({
            "token": "new-access", "refresh_token": "new-refresh",
        })

    def test_stopped_worker_cannot_restore_logged_out_credentials(self):
        worker = BridgeWorker("http://localhost:3000", "new-access", refresh_token="new-refresh")
        worker.stop()
        with patch("aurum_bridge_gui.update_config", return_value=True) as update:
            self.assertFalse(worker._save_auth_tokens())
        update.assert_not_called()

    def test_refresh_accepts_a_rotated_refresh_token(self):
        worker = BridgeWorker("http://localhost:3000", "expired", refresh_token="old-refresh")
        with patch("aurum_bridge_gui.http_post_json", return_value=(200, {
            "token": "new-access", "refreshToken": "rotated-refresh",
        })), patch("aurum_bridge_gui.update_config", return_value=True) as update:
            self.assertTrue(worker._renew_access_token(force=True))
        self.assertEqual(worker.token, "new-access")
        self.assertEqual(worker.refresh_token, "rotated-refresh")
        update.assert_called_once_with({
            "token": "new-access", "refresh_token": "rotated-refresh",
        })

    def test_mt5_directory_requires_a_real_terminal_executable(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertIsNone(find_mt5_terminal_executable(directory))
            terminal = os.path.join(directory, "terminal64.exe")
            with open(terminal, "wb") as handle:
                handle.write(b"test")
            self.assertEqual(find_mt5_terminal_executable(directory), terminal)

    @unittest.skipUnless(os.name == "nt", "native MT5 process discovery is Windows-only")
    def test_native_mt5_process_discovery_returns_unique_absolute_directories(self):
        directories = running_mt5_process_directories()
        keys = [os.path.normcase(os.path.abspath(item)) for item in directories]
        self.assertEqual(len(keys), len(set(keys)))
        self.assertTrue(all(os.path.isabs(item) for item in directories))

    def test_manual_close_requires_confirmation_and_complete_expected_state(self):
        mt5 = _FakeMt5()
        worker = _worker(mt5)

        no_confirmation = worker._process_command({
            "action": "close", "params": {"ticket": "77", "expected_state": _expected(77)},
        })
        self.assertEqual(no_confirmation["status"], "rejected")
        self.assertEqual(no_confirmation["message"], "manual_confirmation_required")

        mt5.position_reads = [[_position()]]
        no_snapshot = worker._process_command({
            "action": "close", "params": {"ticket": "77", "confirm": True},
        })
        self.assertEqual(no_snapshot["status"], "rejected")
        self.assertEqual(no_snapshot["message"], "management_expected_state_required")
        self.assertEqual(mt5.sent_requests, [])

    def test_manual_close_rejects_changed_volume_before_sending(self):
        mt5 = _FakeMt5()
        mt5.position_reads = [[_position(volume=0.2)]]
        worker = _worker(mt5)
        result = worker._process_command({
            "action": "close",
            "params": {"ticket": "77", "confirm": True, "expected_state": _expected(77, volume=0.1)},
        })
        self.assertEqual(result["status"], "rejected")
        self.assertEqual(result["message"], "management_volume_mismatch")
        self.assertEqual(mt5.sent_requests, [])

    def test_manual_close_requires_exact_broker_account_identity(self):
        mt5 = _FakeMt5()
        mt5.position_reads = [[_position()]]
        worker = _worker(mt5)
        expected = _expected(77)
        expected.pop("broker_server_key")
        result = worker._process_command({
            "action": "close",
            "params": {"ticket": "77", "confirm": True, "expected_state": expected},
        })
        self.assertEqual(result["message"], "management_expected_broker_server_required")
        self.assertEqual(mt5.sent_requests, [])

    def test_manual_close_succeeds_only_after_position_disappears(self):
        mt5 = _FakeMt5()
        mt5.position_reads = [[_position()], []]
        worker = _worker(mt5)
        result = worker._process_command({
            "action": "close",
            "params": {"ticket": "77", "confirm": True, "expected_state": _expected(77)},
        })
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["ticket"], 77)

    def test_cancel_reconciles_missing_send_result_when_order_is_absent(self):
        mt5 = _FakeMt5()
        mt5.order_reads = [[_pending()], []]
        worker = _worker(mt5)
        result = worker._process_command({
            "action": "cancel_pending",
            "params": {"ticket": "88", "expected_state": _expected(88)},
        })
        self.assertEqual(result["status"], "success")
        self.assertIn("warning", result)
        self.assertEqual(len(mt5.sent_requests), 1)

    def test_cancel_returns_uncertain_when_post_send_query_fails(self):
        mt5 = _FakeMt5()
        mt5.order_reads = [[_pending()], None]
        mt5.send_results = [SimpleNamespace(retcode=mt5.TRADE_RETCODE_TIMEOUT, comment="timeout")]
        worker = _worker(mt5)
        result = worker._process_command({
            "action": "cancel_pending",
            "params": {"ticket": "88", "expected_state": _expected(88)},
        })
        self.assertEqual(result["status"], "uncertain")
        self.assertEqual(result["retcode"], mt5.TRADE_RETCODE_TIMEOUT)

    def test_operation_id_replays_exact_request_and_rejects_conflict(self):
        mt5 = _FakeMt5()
        mt5.position_reads = [[_position()], []]
        worker = _worker(mt5)
        command = {
            "action": "close",
            "params": {
                "ticket": "77", "confirm": True, "operation_id": "close-once",
                "expected_state": _expected(77),
            },
        }
        first = worker._process_command(command)
        replay = worker._process_command(command)
        conflict = worker._process_command({
            "action": "close",
            "params": {
                "ticket": "78", "confirm": True, "operation_id": "close-once",
                "expected_state": _expected(78),
            },
        })
        self.assertEqual(first["status"], "success")
        self.assertTrue(replay["idempotent_replay"])
        self.assertEqual(conflict["status"], "rejected")
        self.assertEqual(conflict["message"], "operation_id_conflict")

    def test_command_id_replays_only_the_exact_same_request(self):
        mt5 = _FakeMt5()
        mt5.position_reads = [[_position()], []]
        worker = _worker(mt5)
        command = {
            "command_id": "command-once",
            "action": "close",
            "params": {"ticket": "77", "confirm": True, "expected_state": _expected(77)},
        }
        first = worker._process_command(command)
        replay = worker._process_command(command)
        conflict = worker._process_command({
            "command_id": "command-once", "action": "pending_list", "params": {},
        })
        self.assertEqual(first["status"], "success")
        self.assertTrue(replay["idempotent_replay"])
        self.assertEqual(conflict["message"], "command_id_conflict")

    def test_trade_toggle_requires_a_real_boolean(self):
        mt5 = _FakeMt5()
        worker = _worker(mt5)
        worker._trade_enabled = False
        result = worker._process_command({
            "action": "toggle_trade", "params": {"enable": "false"},
        })
        self.assertEqual(result["message"], "trade_toggle_boolean_required")
        self.assertFalse(worker._trade_enabled)

    def test_unexpected_command_exception_is_not_returned_to_server(self):
        mt5 = _FakeMt5()
        worker = _worker(mt5)
        result = worker._process_command({
            "action": "close",
            "params": {"ticket": "not-an-integer", "confirm": True,
                       "expected_state": _expected("not-an-integer")},
        })
        self.assertEqual(result, {"status": "error", "message": "bridge_command_failed"})
        self.assertTrue(any("invalid literal" in item for item in worker.log_signal.messages))


if __name__ == "__main__":
    unittest.main()
