"""Active calendar recovery and release-result cache invalidation, without APIs."""
import importlib
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend import config as cfg
from backend.engine import Engine
from backend.news_bot import NewsBot, compute_market_impacts


class NewsLifecycleTests(unittest.TestCase):
    def test_actual_surprise_overrides_forecast_drift_and_equal_release_stays_unconfirmed(self):
        event = {"title": "CPI YoY", "country": "USD", "impact": "high",
                 "forecast": 3.0, "previous": 2.0, "actual": 2.5}
        markets = {r["market"]: r["side"] for r in compute_market_impacts(event)}
        self.assertEqual(markets["XAUUSDm"], "BUY")
        self.assertEqual(compute_market_impacts({**event, "actual": 3.0}), [])

    def test_all_running_releases_survive_reload_and_include_actual_result(self):
        now = 1794571200
        bot = NewsBot()
        bot.symbol = "XAUUSDm"
        bot.feed.events = [
            {"title": "CPI", "country": "USD", "ts": now - 600, "impact": "high",
             "source": "tradingview", "actual": 3.5, "forecast": 3.0, "previous": 2.9},
            {"title": "Claims", "country": "USD", "ts": now - 300, "impact": "medium", "source": "forex-factory"},
            {"title": "Expired", "country": "USD", "ts": now - 900, "impact": "low", "source": "tradingview"},
            {"title": "Future", "country": "JPY", "ts": now + 600, "impact": "low", "source": "tradingview"},
            {"title": "Investing release", "country": "USD", "ts": now - 100, "impact": "high", "source": "investing.com", "kind": "calendar"},
            {"title": "Exness release", "country": "USD", "ts": now - 100, "impact": "high", "source": "exness", "kind": "calendar"},
            {"title": "Exness headline", "country": "USD", "ts": now - 100, "impact": "high", "source": "exness", "kind": "headline"},
        ]
        with patch("backend.news_bot.time.time", return_value=now), \
                patch.object(bot, "ai_board", return_value={}), \
                patch.object(bot, "session_board", return_value={}), \
                patch.object(bot, "_market_outlook", return_value=[]):
            rows = bot.status()["news"]
        active = {r["title"]: r for r in rows if r.get("active")}
        self.assertEqual(set(active), {"CPI", "Claims", "Investing release", "Exness release"})
        self.assertEqual(active["CPI"]["actual"], 3.5)
        self.assertEqual(active["CPI"]["forecast"], 3.0)
        self.assertEqual(active["CPI"]["impact_window_sec"], 3600)
        self.assertFalse(active["CPI"]["complete"])
        self.assertNotIn("Expired", [r["title"] for r in rows])
        self.assertIn("Future", [r["title"] for r in rows])

    def test_news_signature_refreshes_release_content_but_ignores_countdown(self):
        already_imported = "backend.app" in sys.modules
        with tempfile.TemporaryDirectory(prefix="softradex-news-test-") as folder:
            with patch.object(cfg, "DB_FILE", Path(folder) / "test.db"), patch.object(Engine, "start"):
                module = importlib.import_module("backend.app")
            try:
                first = {"ts": 1794571200, "title": "CPI", "minutes_to": 1, "actual": None,
                         "impacted_markets": [{"market": "XAUUSDm", "side": "SELL"}]}
                sig = module._news_sig({"news": [first]})
                self.assertEqual(sig, module._news_sig({"news": [{**first, "minutes_to": 0}]}))
                self.assertNotEqual(sig, module._news_sig({"news": [{**first, "actual": 3.5}]}))
                changed = {**first, "impacted_markets": [{"market": "XAUUSDm", "side": "BUY"}]}
                self.assertNotEqual(sig, module._news_sig({"news": [changed]}))
            finally:
                if not already_imported:
                    module.store.close()


if __name__ == "__main__":
    unittest.main()
