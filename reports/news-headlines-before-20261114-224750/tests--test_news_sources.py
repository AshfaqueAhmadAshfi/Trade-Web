"""Public source provenance, complete rolling windows and honest failure handling."""
import unittest
from unittest.mock import patch, Mock
from backend.news_bot import NewsFeed
from backend.news_sources import (SOURCES, InvestingCalendar, StructuredCalendar, merge_sources, reading_payload, number,
                                  impact_window, parse_exness_events)

NOW = 1794571200


def row(title="CPI", delta=600, source="tradingview", **kwargs):
    return {"title":title,"country":"USD","ts":NOW+delta,"source":source,"impact":"high",**kwargs}


class NewsSourcesTests(unittest.TestCase):
    def test_tradingview_maps_country_only_events_and_preserves_schedule_context(self):
        response = Mock(status_code=200)
        response.json.return_value = {"result":[
            {"id":"fed-1", "title":"Federal Reserve Policy Address", "country":"US", "currency":None,
             "date":"2026-11-13T08:30:00.0000000-05:00", "importance":1, "actual":0,
             "comment":"<p>Federal Reserve policy and Treasury yields.</p>", "source":"Federal Reserve"},
            {"id":"ecb-1", "title":"President Speech", "country":"EU", "currency":"",
             "date":"2026-11-13T14:00:00Z", "importance":-1, "comment":"ECB President monetary policy speech"}]}
        with patch("backend.news_bot.requests.get", return_value=response):
            rows = NewsFeed()._fetch_tradingview()
        self.assertEqual([r["currency"] for r in rows],["USD","EUR"])
        self.assertEqual(rows[0]["country_code"],"US")
        self.assertEqual(rows[0]["ts"],1794576600)
        self.assertEqual(rows[0]["actual"],0)
        self.assertEqual(rows[0]["kind"],"calendar")
        self.assertEqual(rows[0]["description"],"Federal Reserve policy and Treasury yields.")
        self.assertEqual(rows[0]["tv_event_id"],"fed-1")
        self.assertEqual(rows[0]["url"],"https://www.tradingview.com/economic-calendar/")

    def test_tradingview_rejects_invalid_feed_and_does_not_guess_missing_timezone(self):
        response = Mock(status_code=200)
        with patch("backend.news_bot.requests.get", return_value=response):
            response.json.return_value = {"error":"unavailable"}
            with self.assertRaisesRegex(ValueError,"Invalid TradingView"):
                NewsFeed()._fetch_tradingview()
            response.json.return_value = {"result":[{"title":"Unknown timezone", "country":"US",
                                                       "date":"2026-11-13T08:30:00"}]}
            self.assertEqual(NewsFeed()._fetch_tradingview(),[])

    def test_macro_monitoring_keeps_ppi_after_an_hour_and_removes_it_at_expiry(self):
        feed = NewsFeed()
        feed.events = [row("PPI MoM", -5*3600, impact="medium"), row("FOMC Member Daly Speaks", -3600, impact="low")]
        events = reading_payload(feed, "XAUUSDm", NOW)["events"]
        self.assertEqual([e["impact_window_sec"] for e in events], [21600, 7200])
        self.assertEqual(reading_payload(feed, "XAUUSDm", NOW+7200)["events"], [])
        self.assertEqual(impact_window(row(impact_window_sec=600)), 600)
        self.assertEqual(impact_window(row(kind="headline")), 3600)

    def test_reload_scan_wakes_one_shared_fetch_and_respects_a_recent_scan(self):
        feed = NewsFeed()
        feed.updated_at = NOW-120
        with patch.object(feed, "ensure_started"), patch("backend.news_bot.time.time", return_value=NOW):
            self.assertTrue(feed.request_scan())
            self.assertTrue(feed._wake.is_set())
            self.assertFalse(feed.request_scan())
            feed._wake.clear()
            feed._last_scan_request = 0
            feed._fetch_lock.acquire()
            try:
                self.assertFalse(feed.request_scan())
                self.assertFalse(feed._wake.is_set())
            finally:
                feed._fetch_lock.release()

    def test_cross_source_event_merges_provenance_and_release_fields(self):
        rows=merge_sources([row(forecast=3),row(source="forex-factory",actual=3.4),
                            row("Very long release title first variation"),row("Very long release title second variation")])
        self.assertEqual(len(rows),3)
        self.assertEqual(set(rows[0]["sources"]),{"tradingview","forex-factory"})
        self.assertEqual(rows[0]["actual"],3.4)

    def test_entire_rolling_24h_is_untruncated_and_headlines_are_not_future_events(self):
        feed=NewsFeed()
        feed.events=[row("Release %s"%i,delta=i+1) for i in range(450)]
        feed.events += [row("Tomorrow",86401),row("Future RSS",50,"google-news"),
                        row("Gold research",-60,"google-news"),row("Old research",-86401,"google-news"),
                        row("Active",-10),row("Expired",-3601)]
        payload=reading_payload(feed,"EURUSDm",NOW)
        self.assertEqual(len(payload["events"]),452)
        self.assertEqual(payload["window_end"],NOW+86400)
        self.assertTrue(all(e["predicted_move"]["market"]=="EURUSDm" for e in payload["events"]))
        self.assertNotIn("Future RSS",[e["title"] for e in payload["events"]])

    def test_all_failed_sources_use_real_cache_and_never_fake_calendar(self):
        feed=NewsFeed(); feed.events=[row(),row("Fake",fallback=True)]
        methods=("_fetch_tradingview","_fetch_forexfactory","_fetch_investing_calendar",
                 "_fetch_investing_rss","_fetch_exness_calendar","_fetch_exness_rss","_fetch_binance_calendar","_fetch_binance_headlines",
                 "_fetch_fxstreet","_fetch_forexlive","_fetch_actionforex","_fetch_cnbc","_fetch_marketwatch",
                 "_fetch_federal_reserve","_fetch_coindesk","_fetch_google_news","_fetch_yahoo_rss")
        from contextlib import ExitStack
        with ExitStack() as stack:
            stack.enter_context(patch("backend.news_bot.time.time",return_value=NOW))
            for method in methods: stack.enter_context(patch.object(feed,method,side_effect=RuntimeError("HTTP 403")))
            self.assertEqual(feed.fetch_once(),1)
        self.assertEqual(feed.events[0]["title"],"CPI")
        self.assertEqual(feed.provider_status["tradingview"]["state"],"cached")
        self.assertEqual(feed.provider_status["investing.com"]["parts"]["calendar"]["state"],"unavailable")
        self.assertEqual(feed.provider_status["exness"]["parts"]["calendar"]["state"],"unavailable")
        empty=NewsFeed()
        with ExitStack() as stack:
            for method in methods: stack.enter_context(patch.object(empty,method,side_effect=RuntimeError("offline")))
            self.assertEqual(empty.fetch_once(),0)
        self.assertEqual(empty.events,[])

    def test_investing_only_accepts_verified_timestamps_and_preserves_zero_actual(self):
        parser=InvestingCalendar()
        parser.feed('<table><tr class="js-event-item" data-timestamp="1794571800"><td class="flagCur">USD</td>'
                    '<td class="event">CPI</td><td class="actual">0</td><td class="forecast">0.3%</td></tr>'
                    '<tr class="js-event-item" data-event-datetime="2026/11/13 12:00:00">'
                    '<td class="flagCur">USD</td><td class="event">Unknown timezone</td></tr></table>')
        self.assertEqual(len(parser.rows),1)
        self.assertEqual(parser.rows[0]["actual"],0)
        self.assertEqual(number("180K"),180000)

    def test_structured_calendar_preserves_verified_release_time_and_currency(self):
        parser = StructuredCalendar()
        parser.feed('<script type="application/json">{"events":['
                    '{"Event":"CPI","Country":"US","Date":"2026-11-13T08:30:00-05:00","Importance":3,"Actual":"0","Forecast":"0.3%"},'
                    '{"Event":"Unknown timezone","Country":"US","Date":"2026-11-13T08:30:00"}]}</script>')
        rows = parser.events("exness", "https://www.exness.com/calendar/")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["currency"], "USD")
        self.assertEqual(rows[0]["actual"], 0)
        self.assertEqual(rows[0]["ts"], 1794576600)
        self.assertEqual(rows[0]["kind"], "calendar")

    def test_exness_calendar_and_headlines_are_included_with_genuine_provenance(self):
        feed = NewsFeed()
        feed.events = [row("Exness release", source="exness", kind="calendar"),
                       row("Gold research", -60, "exness", kind="headline")]
        payload = reading_payload(feed, "XAUUSDm", NOW)
        self.assertEqual(len(payload["events"]), 2)
        self.assertTrue(all(e["sources"] == ["exness"] for e in payload["events"]))
        self.assertIn("exness", [s["name"] for s in payload["sources"]])

    def test_observed_exness_json_maps_currency_and_verifies_release_time(self):
        raw = {"title":"Fed Jefferson Speech", "country":"US", "currency":None,
               "time":"2026-11-14T00:00:00.000+00:00", "impact":"medium", "actual":0}
        rows = parse_exness_events([raw, {**raw,"time":"2026-11-14T00:00:00"},
                                    {**raw,"isDayLongEvent":True}])
        self.assertEqual(len(rows),1)
        self.assertEqual(rows[0]["currency"],"USD")
        self.assertEqual(rows[0]["ts"],1794614400)
        self.assertEqual(rows[0]["actual"],0)
        self.assertEqual(rows[0]["impact_window_sec"],7200)
        with self.assertRaisesRegex(ValueError,"Invalid Exness"):
            parse_exness_events({"message":"Forbidden"})

    def test_broker_exchange_and_wire_headlines_keep_genuine_provenance(self):
        feed = NewsFeed()
        feed.events = [row("Gold jumps as Fed signals a cut", -300, "fxstreet", kind="headline"),
                       row("Dollar slips before CPI", -600, "cnbc", kind="headline"),
                       row("Bitcoin ETF inflows rise", -900, "coindesk", kind="headline")]
        payload = reading_payload(feed, "XAUUSDm", NOW)
        self.assertEqual({e["title"]: e["sources"] for e in payload["events"]},
                         {"Gold jumps as Fed signals a cut":["fxstreet"],
                          "Dollar slips before CPI":["cnbc"],
                          "Bitcoin ETF inflows rise":["coindesk"]})
        names = [s["name"] for s in payload["sources"]]
        for provider in ("fxstreet", "forexlive", "actionforex", "cnbc", "marketwatch",
                         "federal-reserve", "coindesk"):
            self.assertIn(provider, names)
            self.assertIn(provider, SOURCES)

    def test_html_or_signin_page_is_not_reported_as_a_successful_empty_news_feed(self):
        feed = NewsFeed()
        with self.assertRaisesRegex(ValueError, "instead of an RSS"):
            feed._parse_headline_rss('<html><body>Sign in</body></html>', "exness")
        self.assertEqual(feed._parse_headline_rss('<rss><channel></channel></rss>', "exness"), [])


if __name__ == "__main__":
    unittest.main()
