"""Read-only integration probe for MetaTrader 5 tick timestamp semantics.

Run manually while an authenticated MT5 terminal is open:

    python tests/integration/mt5_time_probe.py XAUUSD

The probe never sends an order. It compares ``symbol_info_tick().time_msc``
with the host's real UTC Unix clock and verifies the current AURUM assumption
that this broker exposes MT5 wall-clock time encoded as a UTC+3-like timestamp.
"""

from __future__ import annotations

import json
import sys
import time
import unittest
from datetime import datetime, timezone

import MetaTrader5 as mt5


EXPECTED_MT5_OFFSET_SECONDS = 3 * 60 * 60
MAX_LIVE_TICK_AGE_SECONDS = 30


def iso_utc(epoch_ms: int) -> str:
    return datetime.fromtimestamp(epoch_ms / 1000, timezone.utc).isoformat()


def resolve_symbol(requested: str) -> str:
    exact = mt5.symbol_info(requested)
    if exact is not None:
        return requested
    base = requested.upper()
    matches = [item.name for item in (mt5.symbols_get() or ()) if item.name.upper().startswith(base)]
    if not matches:
        raise AssertionError(f"MT5 symbol not found: {requested}")
    return matches[0]


class Mt5TimestampProbe(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if not mt5.initialize():
            raise AssertionError(f"mt5.initialize() failed: {mt5.last_error()}")
        cls.symbol = resolve_symbol(sys.argv[1] if len(sys.argv) > 1 else "XAUUSD")
        if not mt5.symbol_select(cls.symbol, True):
            raise AssertionError(f"mt5.symbol_select() failed: {mt5.last_error()}")

    @classmethod
    def tearDownClass(cls) -> None:
        mt5.shutdown()

    def test_tick_time_msc_is_mt5_utc_plus_3_wall_clock(self) -> None:
        captured_at_ms = time.time_ns() // 1_000_000
        tick = mt5.symbol_info_tick(self.symbol)
        self.assertIsNotNone(tick, f"symbol_info_tick() failed: {mt5.last_error()}")

        raw_tick_ms = int(tick.time_msc)
        raw_minus_host_seconds = (raw_tick_ms - captured_at_ms) / 1000
        normalized_tick_ms = raw_tick_ms - EXPECTED_MT5_OFFSET_SECONDS * 1000
        normalized_age_seconds = (captured_at_ms - normalized_tick_ms) / 1000

        evidence = {
            "symbol": self.symbol,
            "mt5_package_version": mt5.__version__,
            "host_utc": iso_utc(captured_at_ms),
            "tick_time": int(tick.time),
            "tick_time_msc": raw_tick_ms,
            "tick_time_msc_as_utc": iso_utc(raw_tick_ms),
            "raw_tick_minus_host_seconds": round(raw_minus_host_seconds, 3),
            "assumed_mt5_offset_seconds": EXPECTED_MT5_OFFSET_SECONDS,
            "normalized_tick_utc": iso_utc(normalized_tick_ms),
            "normalized_tick_age_seconds": round(normalized_age_seconds, 3),
        }
        print("\nMT5_TIME_PROBE=" + json.dumps(evidence, ensure_ascii=False, indent=2))

        self.assertAlmostEqual(
            raw_minus_host_seconds,
            EXPECTED_MT5_OFFSET_SECONDS,
            delta=MAX_LIVE_TICK_AGE_SECONDS,
            msg="time_msc is not approximately host UTC + 3 hours",
        )
        self.assertGreaterEqual(normalized_age_seconds, -5)
        self.assertLessEqual(normalized_age_seconds, MAX_LIVE_TICK_AGE_SECONDS)


if __name__ == "__main__":
    # Keep the optional symbol argument out of unittest's argument parser.
    symbol_arg = sys.argv[1] if len(sys.argv) > 1 else None
    sys.argv = [sys.argv[0]]
    if symbol_arg:
        # setUpClass reads the restored positional value.
        sys.argv.append(symbol_arg)
    unittest.main(argv=[sys.argv[0]], verbosity=2)
