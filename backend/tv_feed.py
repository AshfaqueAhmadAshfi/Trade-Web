"""TradingView quote + extreme-levels adapter.

The dashboard's chart is TradingView.  This module reads the same public
TradingView quote page (scanner) instead of MT5, so the "Next 5 Extreme
Execution Setups" panel keeps working when MetaTrader is not connected.

Only values TradingView actually returns are used:

* ``close`` / ``high`` / ``low`` - live quote and current day range
* ``High.1M`` / ``Low.1M``      - current month range
* ``price_52_week_high/low``   - 52-week extremes

There is no synthetic candle or invented level.  When TradingView does not
answer, ``quote()`` raises and the API reports the failure; the browser shows
"TradingView feed unavailable" instead of making a setup up.
"""
from __future__ import annotations

import json
import re
import threading
import time
import urllib.parse
import urllib.request
import uuid
from websockets.sync.client import connect
from typing import Any, Dict, List, Optional

_SCANNER = "https://scanner.tradingview.com/symbol?symbol=%s&fields=%s"
_FIELDS = (
    "close,change,change_abs,open,high,low,"
    "High.1M,Low.1M,price_52_week_high,price_52_week_low,"
    "Recommend.All,description,exchange,update_mode"
)
_TIMEOUT = 7.0
_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
)
_CACHE_SEC = 2.0   # the header ribbon follows the chart, so keep it fresh
_QUOTES: Dict[str, tuple] = {}
_LOCK = threading.Lock()
_BAR_CACHE: Dict[tuple, tuple] = {}
_BAR_LOCKS: Dict[tuple, threading.Lock] = {}
_RESOLUTIONS = {"1m": "1", "5m": "5", "15m": "15", "1h": "60", "4h": "240", "1d": "D"}


def _target(symbol: str, target: Optional[str] = None) -> str:
    tv = target or tv_symbol(symbol)
    if not re.fullmatch(r"[A-Z0-9_]+:[A-Za-z0-9.!/_+-]{1,40}", tv):
        raise TradingViewError("No valid TradingView instrument for %s" % symbol)
    return tv


def _frame(payload: str) -> str:
    return "~m~%s~m~%s" % (len(payload.encode("utf-16-le")) // 2, payload)


class _Frames:
    """TradingView frames use JavaScript (UTF-16) character counts."""
    def __init__(self):
        self.buffer = b""

    def feed(self, text):
        self.buffer += text.encode("utf-16-le")
        marker = "~m~".encode("utf-16-le")
        messages = []
        while self.buffer:
            if not self.buffer.startswith(marker):
                raise TradingViewError("Invalid TradingView frame")
            end = self.buffer.find(marker, len(marker))
            if end < 0:
                break
            try:
                size = int(self.buffer[len(marker):end].decode("utf-16-le"))
            except ValueError as exc:
                raise TradingViewError("Invalid TradingView frame length") from exc
            if size < 0 or size > 2_000_000:
                raise TradingViewError("TradingView frame is too large")
            start = end + len(marker)
            finish = start + size * 2
            if len(self.buffer) < finish:
                break
            messages.append(self.buffer[start:finish].decode("utf-16-le"))
            self.buffer = self.buffer[finish:]
        return messages


def _fetch_candles(tv: str, resolution: str, count: int) -> List[list]:
    session = "cs_" + uuid.uuid4().hex[:12]
    frames = _Frames()
    rows = {}
    with connect("wss://data.tradingview.com/socket.io/websocket?from=chart",
                 origin="https://www.tradingview.com", user_agent_header=_UA,
                 open_timeout=8, close_timeout=2, max_size=4_000_000) as ws:
        def send(method, params):
            ws.send(_frame(json.dumps({"m": method, "p": params}, separators=(",", ":"))))
        send("set_auth_token", ["unauthorized_user_token"])
        send("chart_create_session", [session, ""])
        send("resolve_symbol", [session, "symbol_1", "=" + json.dumps(
            {"symbol": tv, "adjustment": "splits", "session": "regular"}, separators=(",", ":"))])
        send("create_series", [session, "series_1", "s1", "symbol_1", resolution, count, ""])
        deadline = time.monotonic() + 12
        complete = False
        while not complete and time.monotonic() < deadline:
            try:
                raw = ws.recv(timeout=max(0.1, deadline-time.monotonic()))
            except TimeoutError:
                break
            for payload in frames.feed(raw):
                if payload.startswith("~h~"):
                    ws.send(_frame(payload))
                    continue
                message = json.loads(payload)
                if not isinstance(message, dict):
                    continue
                method, params = message.get("m"), message.get("p", [])
                if method in ("symbol_error", "series_error", "critical_error", "protocol_error"):
                    raise TradingViewError("TradingView candle error: " + str(params)[:200])
                if not params or params[0] != session:
                    continue
                if method in ("timescale_update", "du") and len(params) > 1:
                    series = params[1].get("series_1", {})
                    for item in series.get("s", []):
                        values = item.get("v", [])
                        if len(values) < 5:
                            continue
                        ts = _num(values[0])
                        prices = [_num(v) for v in values[1:5]]
                        o, h, l, c = prices
                        if ts <= 0 or min(prices) <= 0 or h < max(o, l, c) or l > min(o, h, c):
                            continue
                        rows[ts] = [int(ts * 1000), *prices, _num(values[5]) if len(values) > 5 else 0]
                if method == "series_completed" or len(rows) >= count:
                    complete = True
    if not rows:
        raise TradingViewError("TradingView returned no candles for %s" % tv)
    return [rows[t] for t in sorted(rows)][-count:]


def candles(symbol: str, tf: str, count: int = 500, target: Optional[str] = None) -> Dict[str, Any]:
    """Real bars of the exact embed instrument; never use a proxy fallback."""
    tv = _target(symbol, target)
    if tf not in _RESOLUTIONS or not 50 <= count <= 2000:
        raise TradingViewError("Unsupported candle interval or count")
    key = (tv, tf)
    with _LOCK:
        lock = _BAR_LOCKS.setdefault(key, threading.Lock())
    with lock:
        now = time.time()
        with _LOCK:
            cached = _BAR_CACHE.get(key)
        if cached and now < cached[0] and cached[1] >= count:
            bars, updated = cached[2], cached[3]
        else:
            try:
                bars = _fetch_candles(tv, _RESOLUTIONS[tf], count)
            except TradingViewError:
                raise
            except Exception as exc:
                raise TradingViewError("TradingView candles unavailable: %s" % exc) from exc
            updated = int(time.time())
            with _LOCK:
                _BAR_CACHE[key] = (time.time()+12, count, bars, updated)
        return {"ok": True, "symbol": symbol, "tv_symbol": tv, "tf": tf,
                "source": "TradingView", "updated": updated,
                "bars": [list(b) for b in bars[-count:]]}


class TradingViewError(RuntimeError):
    """Raised when TradingView does not return a usable quote."""


# Explicit symbols from tv-chart.js.  The chart and this panel must analyse the
# same instrument, otherwise a "level" would belong to a different market.
_EXPLICIT = {
    "XAUUSD": "OANDA:XAUUSD",
    "XAUUSD247": "OANDA:XAUUSD",
    "GOLD": "OANDA:XAUUSD",
    "XAGUSD": "OANDA:XAGUSD",
    "XPTUSD": "OANDA:XPTUSD",
    "XPDUSD": "OANDA:XPDUSD",
    "USOIL": "NYMEX:CL1!",
    "UKOIL": "ICEEUR:BRN1!",
    "XNGUSD": "NYMEX:NG1!",
    "USTEC": "NASDAQ:NDX",
    "NAS100": "NASDAQ:NDX",
    "US500": "SP:SPX",
    "US30": "DJ:DJI",
    "DE30": "XETR:DAX",
    "FR40": "EURONEXT:CAC",
    "AUS200": "ASX:AXJO",
    "AAPL": "NASDAQ:AAPL", "MSFT": "NASDAQ:MSFT", "AMZN": "NASDAQ:AMZN",
    "GOOGL": "NASDAQ:GOOGL", "TSLA": "NASDAQ:TSLA", "NVDA": "NASDAQ:NVDA",
    "META": "NASDAQ:META", "INTC": "NASDAQ:INTC", "AMD": "NASDAQ:AMD",
    "NEFL": "NASDAQ:NFLX", "NFLX": "NASDAQ:NFLX", "JPM": "NYSE:JPM",
    "BA": "NYSE:BA", "DIS": "NYSE:DIS", "NKE": "NYSE:NKE", "COIN": "NASDAQ:COIN",
    "PFE": "NYSE:PFE", "V": "NYSE:V", "MA": "NYSE:MA", "KO": "NYSE:KO",
    "WMT": "NASDAQ:WMT", "XOM": "NYSE:XOM",
    "BTCUSDT": "BINANCE:BTCUSDT",
    "BTCUSD": "BINANCE:BTCUSDT",
    "ETHUSDT": "BINANCE:ETHUSDT",
    "ETHUSD": "BINANCE:ETHUSDT",
    "SOLUSDT": "BINANCE:SOLUSDT",
    "EURUSD": "OANDA:EURUSD",
    "GBPUSD": "OANDA:GBPUSD",
    "USDJPY": "OANDA:USDJPY",
    "AUDUSD": "OANDA:AUDUSD",
    "USDCAD": "OANDA:USDCAD",
    "USDCHF": "OANDA:USDCHF",
    "NZDUSD": "OANDA:NZDUSD",
    "EURJPY": "OANDA:EURJPY",
    "GBPJPY": "OANDA:GBPJPY",
}
_FOREX_EXOTIC = frozenset({"USDSGD", "USDHKD", "USDTRY", "USDZAR", "USDMXN", "USDCNH",
                          "USDSEK", "USDNOK", "USDDKK", "USDPLN", "USDTHB", "EURTRY", "EURSGD"})


def tv_symbol(symbol: str) -> str:
    """Map a broker symbol (``XAUUSDm``) to a real TradingView ticker."""
    raw = str(symbol or "").strip().upper()
    if not raw:
        return ""
    key = re.sub(r"[^A-Z0-9]", "", raw)
    if key in _EXPLICIT:
        return _EXPLICIT[key]
    base = key[:-1] if key.endswith("M") and key not in _EXPLICIT else key
    if base in _EXPLICIT:
        return _EXPLICIT[base]
    from .chart_feed import CATALOG
    kind = next((item["kind"] for item in CATALOG
                 if any(str(alt).upper() in (key, base) for alt in item["alts"])), "")
    if kind == "crypto":
        return "BINANCE:" + re.sub(r"USDT?$", "", base) + "USDT"
    if base in _FOREX_EXOTIC:
        return "FX_IDC:" + base
    if base.endswith("USDT") and len(base) > 4:
        return "BINANCE:" + base
    if re.fullmatch(r"[A-Z]{6}", base):
        return "OANDA:" + base
    return ""


def _num(value: Any, default: float = 0.0) -> float:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return default
    return out if out == out and abs(out) != float("inf") else default


def _http_json(url: str) -> Dict[str, Any]:
    req = urllib.request.Request(url, headers={
        "User-Agent": _UA,
        "Accept": "application/json,text/plain,*/*",
        "Referer": "https://www.tradingview.com/",
    })
    with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
        raw = resp.read()
    data = json.loads(raw.decode("utf-8", "replace"))
    return data if isinstance(data, dict) else {}


def quote(symbol: str, force: bool = False, target: Optional[str] = None) -> Dict[str, Any]:
    """Return the public TradingView quote for ``symbol`` (cached 10 s)."""
    tv = _target(symbol, target)
    now = time.time()
    with _LOCK:
        hit = _QUOTES.get(tv)
        if hit and not force and now < hit[0]:
            return dict(hit[1], symbol=str(symbol or ""))
    url = _SCANNER % (urllib.parse.quote(tv), urllib.parse.quote(_FIELDS))
    try:
        raw = _http_json(url)
    except Exception as exc:
        raise TradingViewError("TradingView request failed: %s" % exc) from exc
    price = _num(raw.get("close"))
    if price <= 0:
        raise TradingViewError("TradingView returned no live price for %s" % tv)
    out = {
        "symbol": str(symbol or ""),
        "tv_symbol": tv,
        "source": "TradingView",
        "price": price,
        "close": price,
        "open": _num(raw.get("open")),
        "high": _num(raw.get("high")),
        "low": _num(raw.get("low")),
        "change": _num(raw.get("change")),
        "change_abs": _num(raw.get("change_abs")),
        "month_high": _num(raw.get("High.1M")),
        "month_low": _num(raw.get("Low.1M")),
        "week52_high": _num(raw.get("price_52_week_high")),
        "week52_low": _num(raw.get("price_52_week_low")),
        "rating": _num(raw.get("Recommend.All")),
        "description": str(raw.get("description") or ""),
        "exchange": str(raw.get("exchange") or ""),
        "update_mode": str(raw.get("update_mode") or ""),
        "updated": int(now),
    }
    with _LOCK:
        _QUOTES[tv] = (now + _CACHE_SEC, dict(out))
    return out


def _candidate(action: str, label: str, scope: str, level: float,
               price: float, reason: str) -> Optional[Dict[str, Any]]:
    if not level or level <= 0 or price <= 0:
        return None
    distance = abs(price - level)
    if distance <= max(price * 0.00002, 0.00001):
        distance = 0.0
    pct = (distance / price) * 100.0
    if distance <= price * 0.0006:
        status, cls = "AT LEVEL", "trigger"
    elif pct <= 0.35:
        status, cls = "IMMINENT", "imminent"
    elif pct <= 1.2:
        status, cls = "APPROACHING", "approaching"
    else:
        status, cls = "PENDING", "pending"
    return {
        "action": action,
        "label": label,
        "scope": scope,
        "price": level,
        "distance": round(distance, 4),
        "dist_pct": round(pct, 3),
        "status": status,
        "status_cls": cls,
        "reason": reason,
        "source": "TradingView",
    }


def setups(symbol: str) -> Dict[str, Any]:
    """Build the five nearest real TradingView extreme levels."""
    q = quote(symbol)
    price = float(q["price"])
    raw_levels = [
        ("BUY", "Day Low", "D1", q.get("low"), "Today's low from the live TradingView quote"),
        ("SELL", "Day High", "D1", q.get("high"), "Today's high from the live TradingView quote"),
        ("BUY", "Month Low", "1M", q.get("month_low"), "Current month low from TradingView"),
        ("SELL", "Month High", "1M", q.get("month_high"), "Current month high from TradingView"),
        ("BUY", "52W Low", "52W", q.get("week52_low"), "52-week low from TradingView"),
        ("SELL", "52W High", "52W", q.get("week52_high"), "52-week high from TradingView"),
    ]
    levels: List[Dict[str, Any]] = []
    for action, label, scope, level, reason in raw_levels:
        row = _candidate(action, label, scope, _num(level), price, reason)
        if not row:
            continue
        # The same month/52-week extreme must not occupy two of the five slots.
        if any(abs(row["price"] - old["price"]) <= max(price * 0.0004, 0.01)
               for old in levels):
            continue
        levels.append(row)
    levels.sort(key=lambda r: r["distance"])
    levels = levels[:5]
    for i, row in enumerate(levels, start=1):
        row["priority_rank"] = i
    if not levels:
        raise TradingViewError("TradingView returned no usable extreme levels for %s" % q["tv_symbol"])
    return {
        "ok": True,
        "symbol": str(symbol or ""),
        "tv_symbol": q["tv_symbol"],
        "price": price,
        "change": q.get("change"),
        "change_abs": q.get("change_abs"),
        "source": "TradingView",
        "updated": q["updated"],
        "levels": levels,
    }
