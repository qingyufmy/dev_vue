import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from order_completion import native_order_completion_time, history_order_completion_evidence


class OrderCompletionTests(unittest.TestCase):
    def test_sidecar_filters_to_selected_emitted_terminal_orders(self):
        class Clock:
            def normalize(self, value): return value
            def require_offset_minutes(self): return 0
        rows = [{'ticket': 1, 'state': 2, 'time_done_msc': 1000},
                {'ticket': 2, 'state': 3, 'time_done_msc': 1000},
                {'ticket': 3, 'state': 4, 'time_setup': 1},
                {'ticket': 4, 'state': 4, 'time_done_msc': 1000}]
        result = history_order_completion_evidence(rows, [{'ticket': n} for n in [1, 2, 3]], Clock(), 2000)
        self.assertEqual(['1'], [item['ticket'] for item in result['items']])
        self.assertEqual(1, result['version'])
        self.assertNotIn('completed_at_utc_msc', rows[0])

    def test_preserves_milliseconds_and_applies_verified_offset(self):
        self.assertEqual(native_order_completion_time({'time_done_msc': 10801234, 'time_done': 10801},
                         lambda value: value - 10800000, 2000), 1234)

    def test_seconds_only(self):
        self.assertEqual(native_order_completion_time({'time_done': 2}, lambda value: value, 3000), 2000)

    def test_missing_done_never_uses_setup(self):
        for row in [{}, {'time_done': 0, 'time_done_msc': 0, 'time_setup': 10}, {'time_done': None}]:
            self.assertIsNone(native_order_completion_time(row, lambda _: self.fail('normalized missing evidence'), 2000))

    def test_conflicting_native_clocks(self):
        with self.assertRaisesRegex(ValueError, 'conflict'):
            native_order_completion_time({'time_done': 1, 'time_done_msc': 2000}, lambda value: value, 3000)

    def test_invalid_native_values(self):
        for value in [True, False, '1000', 1.5, -1, 9007199254740992]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                native_order_completion_time({'time_done_msc': value}, lambda v: v, 2000)

    def test_invalid_or_future_utc(self):
        for result in [0, -1, True, 3001]:
            with self.subTest(result=result), self.assertRaises(ValueError):
                native_order_completion_time({'time_done_msc': 1000}, lambda _: result, 3000)

    def test_untrusted_clock_error_propagates(self):
        def untrusted(_):
            raise RuntimeError('mt5_clock_unverified')
        with self.assertRaisesRegex(RuntimeError, 'mt5_clock_unverified'):
            native_order_completion_time({'time_done': 1}, untrusted, 3000)


if __name__ == '__main__':
    unittest.main()
