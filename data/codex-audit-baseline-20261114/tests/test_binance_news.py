"""Binance provenance, verified schedules and shared bounded scanning."""
import unittest
from unittest.mock import patch
from pathlib import Path
import tempfile

from backend import binance_news
from backend.news_sources import reading_payload
from backend.news_bot import NewsFeed

NOW = 1794614400  # 2026-11-14 00:00 UTC


def article(body, title="Binance Will Launch BTCUSDT Trading", **kwargs):
    return {"code":"abcd12345678", "title":title, "publishDate":(NOW-60)*1000,
            "body":body, **kwargs}


class BinanceNewsTests(unittest.TestCase):
    def test_real_schedule_is_separate_from_publication_and_offsets_are_converted(self):
        rows = binance_news.parse_announcement(article("Trading opens at 2026-11-14 09:00 (UTC+8)."), NOW)
        self.assertEqual([r["kind"] for r in rows],["headline","calendar"])
        self.assertEqual(rows[0]["ts"],NOW-60)
        self.assertEqual(rows[1]["ts"],NOW+3600)
        self.assertIn("BTCUSDT",rows[1]["markets"])
        self.assertEqual(rows[1]["source"],"binance")
        self.assertIn("binance.com/en/support/announcement/detail/",rows[1]["url"])

    def test_ambiguous_dates_delays_and_examples_never_become_scheduled_releases(self):
        for text,title in (("Trading opens on 2026-11-14.","New BTC listing"),
                           ("2026-11-14 01:00", "New BTC listing"),
                           ("Originally 2026-11-14 01:00 (UTC)","BTC launch delayed"),
                           ("Example: 2026-11-14 01:00 (UTC)","BTC product update")):
            rows = binance_news.parse_announcement(article(text,title), NOW)
            self.assertTrue(all(r["kind"]=="headline" for r in rows))

    def test_cms_nodes_keep_multiple_assets_and_times_and_ignore_social_footer(self):
        def paragraph(text): return {"node":"element","tag":"p","child":[{"node":"text","text":text}]}
        body = {"node":"root","child":[paragraph("2026-11-14 01:00 (UTC): ETHUSDT launch"),
                paragraph("2026-11-14 01:00 (UTC): XRPUSDT launch"),
                paragraph("2026-11-14 02:00 (UTC): SOLUSDT launch"),paragraph("Binance Team"),paragraph("Bitcoin") ]}
        rows = binance_news.parse_announcement(article(body,"Multiple Contracts Launch"),NOW)
        events = [r for r in rows if r["kind"]=="calendar"]
        self.assertEqual(len(events),2)
        self.assertEqual(events[0]["markets"],["ETHUSDT","XRPUSDT"])
        self.assertEqual(events[1]["markets"],["SOLUSDT"])
        self.assertNotIn("BTCUSDT",rows[0]["markets"])

    def test_only_rolling_window_and_genuine_binance_rows_reach_market_payload(self):
        feed=NewsFeed()
        feed.events=binance_news.parse_announcement(article("2026-11-14 01:00 (UTC) BTCUSDT; 2026-11-16 01:00 (UTC) BTCUSDT"),NOW)
        payload=reading_payload(feed,"BTCUSDT",NOW)
        self.assertEqual(len(payload["events"]),2)
        self.assertTrue(all(r["sources"]==["binance"] for r in payload["events"]))
        self.assertIn("binance",[r["name"] for r in payload["sources"]])

    def test_calendar_and_headline_jobs_share_one_scan(self):
        result={"calendar":[{"kind":"calendar"}],"headline":[{"kind":"headline"}],"error":"","updated":NOW}
        with patch.object(binance_news,"_cached",None),patch.object(binance_news,"_expires",0), \
             patch.object(binance_news,"_last_error",""),patch.object(binance_news,"_restore_cache",return_value=None), \
             patch.object(binance_news,"_save_cache"), \
             patch.object(binance_news,"_scan",return_value=result) as scan:
            self.assertEqual(len(binance_news.fetch_binance("calendar")),1)
            self.assertEqual(len(binance_news.fetch_binance("headline")),1)
            scan.assert_called_once()

    def test_disk_cache_survives_restart_and_rate_limit_does_not_repeat_each_job(self):
        result={"calendar":[{"ts":NOW,"article_code":"abcd"}],"headline":[],"error":"","updated":NOW}
        with tempfile.TemporaryDirectory() as directory,patch.object(binance_news,"CACHE_PATH",Path(directory)/"cache.json"), \
             patch.object(binance_news.time,"time",return_value=NOW),patch.object(binance_news,"_cached",None), \
             patch.object(binance_news,"_expires",0),patch.object(binance_news,"_last_error",""):
            binance_news._save_cache(result)
            with patch.object(binance_news,"_scan") as scan:
                self.assertEqual(len(binance_news.fetch_binance("calendar")),1)
                scan.assert_not_called()
            # A later 429 keeps real cached rows and only attempts one shared scan.
            with patch.object(binance_news.time,"time",return_value=NOW+301), \
                 patch.object(binance_news,"_scan",side_effect=RuntimeError("HTTP 429")) as scan:
                cached=binance_news.fetch_binance("calendar")
                self.assertEqual(cached.provider_state,"cached")
                binance_news.fetch_binance("headline")
                scan.assert_called_once()

    def test_cold_rate_limit_attempts_one_scan_and_reports_unavailable(self):
        with patch.object(binance_news,"_cached",None),patch.object(binance_news,"_expires",0), \
             patch.object(binance_news,"_last_error",""),patch.object(binance_news,"_restore_cache",return_value=None), \
             patch.object(binance_news,"_scan",side_effect=RuntimeError("HTTP 429")) as scan:
            for part in ("calendar","headline"):
                with self.assertRaisesRegex(RuntimeError,"HTTP 429"):
                    binance_news.fetch_binance(part)
            scan.assert_called_once()

    def test_catalog_pagination_reads_the_entire_recent_window(self):
        current=[{"code":f"abcd{i:08d}","title":f"Coin notice {i}","releaseDate":(NOW-60)*1000} for i in range(50)]
        old={"code":"old00000","releaseDate":(NOW-31*86400)*1000}
        def get(path,query,deadline):
            if path=="list/query":
                return {"catalogs":[{"catalogId":49,"articles":current if query["pageNo"]==1 else [old]}]}
            a=next(a for a in current if a["code"]==query["articleCode"])
            return {**a,"publishDate":a["releaseDate"],"body":"No verified schedule"}
        with patch.object(binance_news,"_get",side_effect=get) as request,patch.object(binance_news.time,"time",return_value=NOW):
            result=binance_news._scan()
        self.assertEqual(result["articles_scanned"],50)
        self.assertEqual(len(result["headline"]),50)
        self.assertEqual(result["calendar"],[])
        self.assertTrue(any(c.args[1].get("pageNo")==2 for c in request.call_args_list))


if __name__=="__main__":
    unittest.main()
