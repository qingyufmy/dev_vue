import os
import sys
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace


AI_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "public", "ai"))
if AI_DIR not in sys.path:
    sys.path.insert(0, AI_DIR)

from bridge_order_idempotency import lookup_existing_execution, reference_matches


MAGIC = 234000


class FakeMt5:
    ORDER_STATE_CANCELED = 2
    ORDER_STATE_PARTIAL = 3
    ORDER_STATE_FILLED = 4
    ORDER_STATE_REJECTED = 5
    ORDER_STATE_EXPIRED = 6

    def __init__(self, orders=(), positions=(), history_orders=(), history_deals=()):
        self.orders = orders
        self.positions = positions
        self.historical_orders = history_orders
        self.historical_deals = history_deals

    def orders_get(self, **_kwargs):
        return self.orders

    def positions_get(self, **_kwargs):
        return self.positions

    def history_orders_get(self, _date_from, _date_to):
        return self.historical_orders

    def history_deals_get(self, _date_from, _date_to):
        return self.historical_deals

    def last_error(self):
        return (0, "ok")


def row(**values):
    return SimpleNamespace(**values)


def lookup(mt5, kind, command_ref="AI-1"):
    return lookup_existing_execution(
        mt5,
        {"symbol": "XAUUSD", "bridge_command_ref": command_ref, "expected_kind": kind},
        MAGIC,
        lambda value: value,
        now=datetime(2026, 7, 24, tzinfo=timezone.utc),
    )


class BridgeOrderIdempotencyTests(unittest.TestCase):
    def test_reference_match_is_exact_and_cannot_confuse_prefixes(self):
        self.assertTrue(reference_matches("AI-1", "AI-1"))
        self.assertFalse(reference_matches("AI-1", "AI-10"))
        result = lookup(FakeMt5(orders=(
            row(ticket=10, symbol="XAUUSD", magic=MAGIC, comment="AI-10"),
        )), "pending", "AI-1")
        self.assertFalse(result["found"])
        self.assertTrue(result["complete"])

    def test_active_trade_replays_the_position_ticket(self):
        result = lookup(FakeMt5(positions=(
            row(ticket=7001, symbol="XAUUSD", magic=MAGIC, comment="AI-7"),
        )), "trade", "AI-7")
        self.assertEqual(result["kind"], "trade")
        self.assertEqual(result["ticket"], 7001)
        self.assertEqual(result["position_id"], 7001)

    def test_exact_reference_cannot_be_bypassed_by_a_conflicting_ticket(self):
        result = lookup_existing_execution(
            FakeMt5(positions=(
                row(ticket=7001, symbol="XAUUSD", magic=MAGIC, comment="AI-OTHER"),
            )),
            {
                "symbol": "XAUUSD", "bridge_command_ref": "AI-7",
                "trade_ticket": 7001, "expected_kind": "trade",
            },
            MAGIC,
            lambda value: value,
            now=datetime(2026, 7, 24, tzinfo=timezone.utc),
        )
        self.assertFalse(result["found"])
        self.assertTrue(result["complete"])

    def test_immediately_filled_pending_order_remains_a_pending_execution(self):
        result = lookup(FakeMt5(history_orders=(
            row(ticket=8001, position_id=9001, state=FakeMt5.ORDER_STATE_FILLED,
                symbol="XAUUSD", magic=MAGIC, comment="AI-8"),
        )), "pending", "AI-8")
        self.assertEqual(result["kind"], "pending")
        self.assertEqual(result["ticket"], 8001)
        self.assertEqual(result["order"], 8001)
        self.assertEqual(result["position_id"], 9001)
        self.assertEqual(result["pending_state"], "filled")

    def test_historical_market_deal_prefers_position_identity(self):
        result = lookup(FakeMt5(history_deals=(
            row(ticket=3001, order=4001, position_id=5001,
                symbol="XAUUSD", magic=MAGIC, comment="AI-9"),
        )), "trade", "AI-9")
        self.assertEqual(result["ticket"], 5001)
        self.assertEqual(result["order"], 4001)
        self.assertEqual(result["deal"], 3001)

    def test_history_failure_never_proves_absence(self):
        mt5 = FakeMt5()
        mt5.history_orders_get = lambda *_args: None
        result = lookup(mt5, "pending", "AI-11")
        self.assertEqual(result["status"], "error")
        self.assertNotIn("complete", result)


if __name__ == "__main__":
    unittest.main()
