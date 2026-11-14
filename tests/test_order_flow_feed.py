"""Public feed normalization and failure states without network access."""
import unittest
from unittest.mock import patch
from backend import order_flow_feed as feed


class PublicTapeTests(unittest.TestCase):
    def tearDown(self):
        feed.reset_cache()

    def test_timestamps_and_missing_trade_fields(self):
        ms = 1794600000000
        for value in (ms, ms / 1000, ms * 1000, ms * 1000000):
            self.assertEqual(feed._ms(value), ms)
        self.assertIsNone(feed._row("1", "BUY", 1, 2, None))
        self.assertIsNone(feed._row("1", "unknown", 1, 2, ms))

    def test_coinbase_maker_sell_is_taker_buy(self):
        with patch.object(feed, "_http_json", return_value=[{
            "trade_id": 123, "side": "sell", "price": "100", "size": "2",
            "time": "2026-11-14T05:00:00Z"}]) as request:
            data = feed.trades("coinbase", "BTCUSDm", 80)
        self.assertEqual(data["pair"], "BTC-USD")
        self.assertEqual(data["trades"][0]["side"], "BUY")
        self.assertEqual(data["trades"][0]["value"], 200)
        self.assertEqual(request.call_count, 1)

    def test_binance_and_mexc_preserve_execution_id_and_taker(self):
        row = {"a": 42, "m": True, "p": "4000", "q": ".1", "T": 1794600000000}
        with patch.object(feed, "_http_json", return_value=[row]):
            data = feed.trades("binance", "XAUUSDm")
            mexc = feed._mexc("BTCUSDT", 10)
        self.assertEqual(data["pair"], "PAXGUSDT")
        self.assertEqual(data["trades"][0]["id"], "42")
        self.assertEqual(data["trades"][0]["side"], "SELL")
        self.assertEqual(mexc[0]["id"], "42")

    def test_api_errors_are_unavailable_not_quiet(self):
        cases = [(feed._bybit, {"retCode": 10001}), (feed._okx, {"code": "51000"}),
                 (feed._kucoin, {"code": "400100"}), (feed._gemini, {"result": "error"}),
                 (feed._deribit, {"error": {"code": 1}}), (feed._htx, {"status": "error"})]
        for reader, data in cases:
            with self.subTest(reader=reader.__name__), patch.object(feed, "_http_json", return_value=data):
                with self.assertRaises(feed.OrderFlowUnavailable):
                    reader("BTCUSD", 10)

    def test_quiet_success_is_cached(self):
        with patch.object(feed, "_http_json", return_value={"code": "0", "data": []}) as request:
            data = feed.trades("okx", "XAUUSDm")
            again = feed.trades("okx", "GOLD")
        self.assertEqual(data["trades"], [])
        self.assertEqual(data, again)
        self.assertEqual(request.call_count, 1)

    def test_all_venues_listed_and_unsupported_gold_is_explicit(self):
        self.assertEqual(len(feed.catalogue()), 13)
        for venue in ("mexc", "deribit"):
            with self.assertRaises(feed.OrderFlowUnavailable):
                feed.trades(venue, "XAUUSDm")


if __name__ == "__main__":
    unittest.main()
