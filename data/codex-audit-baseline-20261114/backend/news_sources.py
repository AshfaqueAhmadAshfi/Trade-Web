"""Public news provenance, Investing calendar parsing and a rolling reading feed."""
from datetime import datetime, timezone
from html.parser import HTMLParser
import json
import re
import time
import urllib.request
import urllib.parse

SOURCES = ("tradingview", "forex-factory", "investing.com", "exness", "binance",
           "fxstreet", "forexlive", "actionforex", "cnbc", "marketwatch",
           "federal-reserve", "coindesk", "google-news")
WINDOWS = {"high": 3600, "medium": 1800, "low": 900}


def impact_window(row):
    """Estimated monitoring horizon, not proof an event still drives the price."""
    explicit = row.get("impact_window_sec")
    if explicit is not None:
        try:
            return min(21600, max(60, int(explicit)))
        except (ValueError, TypeError, OverflowError):
            pass
    title = str(row.get("title") or "").lower()
    if event_kind(row) == "calendar":
        if re.search(r"\b(cpi|ppi|pce|inflation|consumer price|producer price|non.?farm|payroll|interest rate|rate decision|monetary policy|fomc minutes)\b", title):
            return 21600
        if re.search(r"\b(fomc|fed|ecb|boe|boj|mpc|buba|central bank)\b.*\b(speak|speaks|speech|testimony|press conference)\b", title):
            return 7200
        if re.search(r"\b(gdp|retail sales|jobless|unemployment|employment|pmi)\b", title):
            return 7200
    return WINDOWS.get(row.get("impact"), 900)


def number(value):
    text = str(value if value is not None else "").strip().replace("%", "").replace(",", "")
    multiplier = {"k": 1000, "m": 1000000, "b": 1000000000}.get(text[-1:].lower(), 1)
    try:
        return float(text[:-1] if multiplier != 1 else text) * multiplier
    except ValueError:
        return None


class PlainText(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []

    def handle_data(self, data):
        self.parts.append(data)


def plain_text(value):
    parser = PlainText()
    parser.feed(str(value or ""))
    return " ".join(" ".join(parser.parts).split())[:3000]


class InvestingCalendar(HTMLParser):
    """Accept epoch/offset timestamps; never guess a site's local timezone."""
    def __init__(self):
        super().__init__()
        self.rows, self.row, self.cell, self.parts = [], None, None, []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "tr" and ("eventRowId" in a or "eventrowid" in a or "js-event-item" in a.get("class", "")):
            self.row = {"source": "investing.com", "kind": "calendar", "impact": "low"}
            stamp = a.get("data-event-timestamp") or a.get("data-timestamp") or ""
            try:
                ts = float(stamp)
                self.row["ts"] = ts / 1000 if ts > 1e11 else ts
            except ValueError:
                stamp = a.get("data-event-datetime", "").replace("/", "-")
                if re.search(r"(?:Z|[+-]\d\d:\d\d)$", stamp):
                    try:
                        self.row["ts"] = datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp()
                    except ValueError:
                        pass
        if self.row is None:
            return
        if tag == "td":
            self.cell, self.parts = a.get("class", ""), []
            importance = a.get("data-img_key", "")
            if importance:
                self.row["impact"] = "high" if "3" in importance else "medium" if "2" in importance else "low"
        if tag == "a" and self.cell and "event" in self.cell and a.get("href"):
            self.row["url"] = "https://www.investing.com" + a["href"] if a["href"].startswith("/") else a["href"]
        importance = a.get("title", "").lower()
        if "volatility" in importance:
            self.row["impact"] = "high" if "high" in importance else "medium" if "moderate" in importance else "low"

    def handle_data(self, data):
        if self.row is not None and self.cell is not None:
            self.parts.append(data)

    def handle_endtag(self, tag):
        if self.row is None:
            return
        if tag == "td" and self.cell is not None:
            value = " ".join(" ".join(self.parts).split())
            if "flagCur" in self.cell:
                self.row["country"] = value.upper()
            elif "event" in self.cell:
                self.row["title"] = value
            else:
                for field in ("actual", "forecast", "previous"):
                    if field in self.cell.lower():
                        self.row[field] = number(value)
            self.cell = None
        elif tag == "tr":
            if self.row.get("title") and self.row.get("country") and self.row.get("ts", 0) > 0:
                self.rows.append(self.row)
            self.row, self.cell = None, None


def investing_calendar():
    url = "https://sslecal2.investing.com?lang=1&calType=week"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=12) as response:
        parser = InvestingCalendar()
        parser.feed(response.read().decode("utf-8", "replace"))
    if not parser.rows:
        raise ValueError("Calendar returned no events with a verifiable timestamp")
    return parser.rows


class StructuredCalendar(HTMLParser):
    """Read public JSON calendar data only when its release time is verifiable.

    HTML clock labels and publication timestamps cannot establish release times.
    A provider returning only a JS shell must report unavailable data.
    """
    def __init__(self):
        super().__init__()
        self.blocks, self.parts, self.in_json = [], [], False

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "script" and a.get("type") in ("application/json", "application/ld+json"):
            self.in_json, self.parts = True, []

    def handle_data(self, data):
        if self.in_json:
            self.parts.append(data)

    def handle_endtag(self, tag):
        if tag == "script" and self.in_json:
            try:
                self.blocks.append(json.loads("".join(self.parts)))
            except ValueError:
                pass
            self.in_json = False

    def events(self, source, url):
        countries = {"US":"USD", "UNITED STATES":"USD", "GB":"GBP", "UNITED KINGDOM":"GBP",
                     "EA":"EUR", "EU":"EUR", "EURO AREA":"EUR", "DE":"EUR", "FR":"EUR",
                     "JP":"JPY", "JAPAN":"JPY", "CN":"CNY", "CHINA":"CNY", "AU":"AUD",
                     "AUSTRALIA":"AUD", "CA":"CAD", "CANADA":"CAD", "CH":"CHF", "NZ":"NZD"}
        out, pending = [], list(self.blocks)
        while pending:
            item = pending.pop()
            if isinstance(item, list):
                pending.extend(item)
                continue
            if not isinstance(item, dict):
                continue
            fields = {str(k).lower():v for k,v in item.items()}
            title = fields.get("event") or ((fields.get("name") or fields.get("title")) if fields.get("@type") == "Event" else None)
            stamp = fields.get("startdate") or fields.get("date") or fields.get("timestamp")
            country = fields.get("currency") or fields.get("country")
            if isinstance(country, dict):
                country = country.get("code") or country.get("name")
            if title and stamp and isinstance(country, str):
                ts = None
                if isinstance(stamp, (int, float)):
                    ts = stamp/1000 if stamp > 1e11 else stamp
                elif isinstance(stamp, str) and re.search(r"(?:Z|[+-]\d\d:\d\d)$", stamp):
                    try:
                        ts = datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp()
                    except ValueError:
                        pass
                if ts and ts > 0:
                    ccy = countries.get(country.upper(), country.upper())
                    importance = str(fields.get("importance", fields.get("impact", "low"))).lower()
                    impact = "high" if importance in ("3", "high") else "medium" if importance in ("2", "medium") else "low"
                    out.append({"title":str(title), "country":ccy, "currency":ccy, "ts":ts,
                                "impact":impact, "kind":"calendar", "source":source, "url":url,
                                **{k:number(fields.get(k)) for k in ("actual", "forecast", "previous")}})
            pending.extend(v for v in item.values() if isinstance(v, (dict, list)))
        return out


def exness_calendar():
    # This is the public endpoint used by Exness's own Economic Calendar.
    # Some hosts block server HTTP clients; the UI can read the same public
    # feed directly, without sending any broker credentials.
    base = "https://pwapi.ex2b.com/api/v1/calendar/events/"
    now, deadline = time.time(), time.monotonic() + 20
    rows = []
    for page in range(1, 21):
        query = urllib.parse.urlencode({
            "start": datetime.fromtimestamp(now-21600, timezone.utc).isoformat(),
            "end": datetime.fromtimestamp(now+86400, timezone.utc).isoformat(),
            "lang": "en", "page": page})
        remaining = deadline-time.monotonic()
        if remaining <= 0:
            raise TimeoutError("Exness calendar pagination timed out")
        req = urllib.request.Request(base+"?"+query, headers={"User-Agent":"Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=min(12, remaining)) as response:
            data = json.loads(response.read().decode("utf-8", "replace"))
        rows.extend(parse_exness_events(data))
        if len(data) < 50:
            return rows
    raise ValueError("Exness calendar pagination incomplete")


def parse_exness_events(data):
    """Parse Exness's observed public JSON schema, with real release offsets."""
    if not isinstance(data, list):
        raise ValueError("Invalid Exness calendar payload")
    currencies = {"US":"USD", "GB":"GBP", "EU":"EUR", "EA":"EUR", "DE":"EUR", "FR":"EUR",
                  "IT":"EUR", "ES":"EUR", "NL":"EUR", "BE":"EUR", "AT":"EUR", "PT":"EUR",
                  "IE":"EUR", "FI":"EUR", "GR":"EUR", "JP":"JPY", "CN":"CNY", "AU":"AUD",
                  "NZ":"NZD", "CA":"CAD", "CH":"CHF", "IN":"INR", "BR":"BRL", "ZA":"ZAR",
                  "MX":"MXN", "RU":"RUB", "SG":"SGD", "HK":"HKD", "KR":"KRW", "TR":"TRY",
                  "NO":"NOK", "SE":"SEK", "DK":"DKK", "PL":"PLN", "CZ":"CZK", "HU":"HUF",
                  "CL":"CLP", "CO":"COP", "SA":"SAR"}
    rows = []
    for item in data:
        if not isinstance(item, dict) or not item.get("title") or item.get("isDayLongEvent"):
            continue
        stamp = item.get("time")
        if not isinstance(stamp, str) or not re.search(r"(?:Z|[+-]\d\d:\d\d)$", stamp):
            continue
        try:
            ts = datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp()
        except ValueError:
            continue
        country = str(item.get("country") or "").upper()
        ccy = str(item.get("currency") or currencies.get(country, country)).upper()
        if not re.fullmatch(r"[A-Z]{3}", ccy):
            continue
        row = {"title":re.sub(r"([a-z])Speech\b", r"\1 Speech", str(item["title"])),
               "country":ccy, "currency":ccy, "ts":ts, "kind":"calendar", "source":"exness",
               "url":"https://my.exness.com/pa/analytics/economic-calendar",
               "impact":item.get("impact") if item.get("impact") in WINDOWS else "low",
               "description":plain_text(item.get("description")),
               **{k:number(item.get(k)) for k in ("actual", "forecast", "previous")}}
        row["impact_window_sec"] = impact_window(row)
        rows.append(row)
    return rows


def event_kind(row):
    return row.get("kind") or ("headline" if row.get("source") in ("google-news", "investing.com", "yahoo-finance", "exness", "binance") else "calendar")


def merge_sources(rows):
    """Keep full event names and all provider provenance, fill missing results."""
    merged = {}
    for item in rows:
        if item.get("fallback") or not item.get("ts"):
            continue
        row = dict(item)
        row["kind"] = event_kind(row)
        title = re.sub(r"[^a-z0-9]+", "", str(row.get("title", "")).lower())
        key = (row["kind"], str(row.get("country") or row.get("currency") or ""), title, int(float(row["ts"]) // 60))
        provenance = row.get("sources") or [row.get("source", "calendar")]
        if key not in merged:
            row["sources"] = list(dict.fromkeys(provenance))
            merged[key] = row
        else:
            old = merged[key]
            old["sources"] = list(dict.fromkeys(old["sources"] + list(provenance)))
            for field in ("actual", "forecast", "previous", "description", "url", "publisher"):
                if old.get(field) in (None, "") and row.get(field) not in (None, ""):
                    old[field] = row[field]
            if WINDOWS.get(row.get("impact"), 900) > WINDOWS.get(old.get("impact"), 900):
                old["impact"] = row["impact"]
    return sorted(merged.values(), key=lambda r: float(r["ts"]))


def reading_payload(feed, symbol, now=None):
    from .news_bot import compute_market_impacts, predict_dollar_move
    now = time.time() if now is None else now
    with feed.lock:
        raw = [dict(r) for r in feed.events]
        statuses = {k: dict(v) for k, v in getattr(feed, "provider_status", {}).items()}
        updated = feed.updated_at
    rows = []
    for ev in merge_sources(raw):
        providers = [s for s in ev["sources"] if s in SOURCES]
        if not providers:
            continue
        ts = float(ev["ts"])
        win = impact_window(ev)
        if ev["kind"] == "headline":
            if not now - 86400 <= ts <= now:
                continue  # published headlines never become invented future releases
        elif not now - win < ts <= now + 86400:
            continue
        ev.update(currency=ev.get("country") or ev.get("currency"), sources=providers,
                  impact_window_sec=win, predicted_move=predict_dollar_move(ev, symbol),
                  impacted_markets=compute_market_impacts(ev))
        rows.append(ev)
    return {"ok": True, "symbol": symbol, "now": now, "window_end": now + 86400,
            "updated": updated, "events": rows,
            "scan": {"state": "scanning" if feed._fetch_lock.locked() or feed._wake.is_set() else "idle", "updated": updated},
            "sources": [{"name": s, **statuses.get(s, {"state": "loading", "updated": updated})} for s in SOURCES],
            "method": "Public calendars, official exchange announcements and published RSS excerpts; directions are estimates"}
