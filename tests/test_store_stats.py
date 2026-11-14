"""Database scoping and financial aggregation, retained from the legacy runner."""
import tempfile
import unittest
from pathlib import Path

from backend.stats import compute_stats
from backend.store import Store


class StoreAndStatsTests(unittest.TestCase):
    def test_profit_buckets_and_time_windows(self):
        trades = [{'close_time': 1000, 'net_profit': 50, 'volume': .1},
                  {'close_time': 2000, 'net_profit': -20, 'volume': .2},
                  {'close_time': 3000, 'net_profit': 30, 'volume': .1}]
        stats = compute_stats(trades)
        self.assertEqual(stats['net_profit'], 60)
        self.assertEqual(stats['profit_factor'], 4)
        self.assertEqual(stats['win_rate'], 66.67)
        self.assertEqual(compute_stats(trades, start_ts=2000, end_ts=3000)['net_profit'], -20)
        self.assertEqual(compute_stats([{'net_profit': 0}])['breakeven'], 1)
        self.assertEqual(compute_stats([], [{'profit': 5, 'swap': -1}])['floating'], 4)

    def test_upsert_is_idempotent_and_scoped_per_account(self):
        with tempfile.TemporaryDirectory() as folder:
            store = Store(Path(folder) / 'test.db')
            try:
                row = {'position_id': '1', 'symbol': 'XAUUSDm', 'close_time': 1000,
                       'net_profit': 5, 'volume': .1, 'source': 'test'}
                store.upsert_trades([row], account='111')
                store.upsert_trades([row], account='111')
                self.assertEqual(store.count_trades(), 1)
                store.upsert_trades([{**row, 'net_profit': 9}], account='111')
                store.upsert_trades([{**row, 'position_id': '2'}], account='222')
                self.assertEqual(store.get_trades(account='111')[0]['net_profit'], 9)
                self.assertEqual([r['position_id'] for r in store.get_trades(account='222')], ['2'])
                self.assertEqual(store.count_trades('111'), 1)
            finally:
                store.close()
