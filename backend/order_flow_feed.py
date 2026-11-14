"""Read-only public order-flow tapes for additional trading venues.

All thirteen venues have a same-origin REST path, including Binance's public
market-data endpoint. This also supplies the browser when a WebSocket or CORS
policy prevents a direct connection.

This module fetches those public tapes server-side and normalises every print
to one shape::

    {"id": "...", "side": "BUY" | "SELL", "price": 1.23,
     "qty": 4.56, "value": 5.61, "ts": 1700000000000}

Nothing here places an order and nothing is simulated: every row comes from
the venue's own public trade endpoint. Results are cached for a couple of
seconds so several browser tabs cannot hammer a venue.
"""
from __future__ import annotations

import hashlib
import json
import math
import time
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional, Tuple

_HTTP_TIMEOUT = 8.0
_TTL = 2.0
_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")

_CACHE: Dict[Tuple[str, str, int], Tuple[float, Dict[str, Any]]] = {}


class OrderFlowUnavailable(RuntimeError):
    """Raised when a venue's public tape cannot be read right now."""


def _http_json(url: str) -> Any:
    req = urllib.request.Request(url, headers={
        "User-Agent": _UA,
        "Accept": "application/json,text/plain,*/*",
    })
    with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT) as resp:
        raw = resp.read()
    return json.loads(raw.decode("utf-8", "replace"))


def _num(value: Any, default: float = 0.0) -> float:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return default
    return out if math.isfinite(out) else default


def _ms(value: Any) -> int:
    """Normalise seconds / milliseconds / nanoseconds to epoch milliseconds."""
    try:
        ts = int(float(value))
    except (TypeError, ValueError, OverflowError):
        return 0
    while ts > 10 ** 13:      # microseconds / nanoseconds
        ts //= 1000
    if 0 < ts < 10 ** 11:      # seconds (Gemini's fallback field)
        ts *= 1000
    return ts


def _row(trade_id: Any, side: Any, price: Any, qty: Any,
         ts: Any) -> Optional[Dict[str, Any]]:
    price_f = _num(price)
    qty_f = _num(qty)
    if price_f <= 0 or qty_f <= 0:
        return None
    when = _ms(ts)
    direction = str(side).upper()
    if when <= 0 or direction not in ("BUY", "SELL", "B", "S"):
        return None
    side_up = "BUY" if direction.startswith("B") else "SELL"
    pid = str(trade_id) if trade_id not in (None, "") else hashlib.sha1(
        ("%s|%s|%s|%s" % (when, price_f, qty_f, side_up)).encode("utf-8")
    ).hexdigest()[:20]
    return {
        "id": pid,
        "side": side_up,
        "price": price_f,
        "qty": qty_f,
        "value": price_f * qty_f,
        "ts": when,
    }


# ---------------------------------------------------------------------------
# Venue readers
# ---------------------------------------------------------------------------

def _binance(pair: str, limit: int) -> List[Dict[str, Any]]:
    query = urllib.parse.urlencode({"symbol": pair, "limit": limit})
    rows = _http_json("https://data-api.binance.vision/api/v3/aggTrades?" + query)
    if not isinstance(rows, list):
        raise OrderFlowUnavailable("Binance returned no trade list")
    return [r for t in rows if isinstance(t, dict)
            for r in [_row(t.get("a"), "SELL" if t.get("m") else "BUY",
                           t.get("p"), t.get("q"), t.get("T"))] if r]


def _coinbase(pair: str, limit: int) -> List[Dict[str, Any]]:
    rows = _http_json("https://api.exchange.coinbase.com/products/%s/trades?limit=%d"
                      % (urllib.parse.quote(pair), limit))
    if not isinstance(rows, list):
        raise OrderFlowUnavailable("Coinbase returned no trade list")
    from datetime import datetime
    out = []
    for t in rows:
        if not isinstance(t, dict) or t.get("side") not in ("buy", "sell"):
            continue
        try:
            when = datetime.fromisoformat(t["time"].replace("Z", "+00:00")).timestamp()
        except (KeyError, ValueError, TypeError):
            continue
        # Coinbase's trade feed reports the maker side; pressure uses the taker.
        r = _row(t.get("trade_id"), "SELL" if t["side"] == "buy" else "BUY",
                 t.get("price"), t.get("size"), when)
        if r:
            out.append(r)
    return out


def _kraken(pair: str, limit: int) -> List[Dict[str, Any]]:
    data = _http_json("https://api.kraken.com/0/public/Trades?pair=" +
                      urllib.parse.quote(pair.replace("/", "")))
    if data.get("error"):
        raise OrderFlowUnavailable("Kraken: " + str(data["error"]))
    out = []
    for key, rows in (data.get("result") or {}).items():
        if key == "last":
            continue
        for t in rows:
            if not isinstance(t, list) or len(t) < 4:
                continue
            r = _row(t[6] if len(t) > 6 else None, t[3], t[0], t[1], t[2])
            if r:
                out.append(r)
    return out


def _okx(pair: str, limit: int) -> List[Dict[str, Any]]:
    data = _http_json("https://www.okx.com/api/v5/market/trades?" +
                      urllib.parse.urlencode({"instId": pair, "limit": min(limit, 100)}))
    if str(data.get("code")) != "0":
        raise OrderFlowUnavailable("OKX: " + str(data.get("msg", "API error")))
    return [r for t in data.get("data") or []
            for r in [_row(t.get("tradeId"), t.get("side"), t.get("px"), t.get("sz"), t.get("ts"))] if r]


def _bitget(pair: str, limit: int) -> List[Dict[str, Any]]:
    data = _http_json("https://api.bitget.com/api/v2/spot/market/fills?" +
                      urllib.parse.urlencode({"symbol": pair, "limit": min(limit, 100)}))
    if str(data.get("code")) != "00000":
        raise OrderFlowUnavailable("Bitget: " + str(data.get("msg", "API error")))
    return [r for t in data.get("data") or []
            for r in [_row(t.get("tradeId"), t.get("side"), t.get("price"), t.get("size"), t.get("ts"))] if r]


def _gate(pair: str, limit: int) -> List[Dict[str, Any]]:
    rows = _http_json("https://api.gateio.ws/api/v4/spot/trades?" +
                      urllib.parse.urlencode({"currency_pair": pair, "limit": min(limit, 100)}))
    if not isinstance(rows, list):
        raise OrderFlowUnavailable("Gate.io returned no trade list")
    return [r for t in rows for r in [_row(t.get("id"), t.get("side"), t.get("price"),
            t.get("amount"), t.get("create_time_ms") or t.get("create_time"))] if r]


def _bybit(pair: str, limit: int) -> List[Dict[str, Any]]:
    data = _http_json("https://api.bybit.com/v5/market/recent-trade?" +
                      urllib.parse.urlencode({"category": "spot", "symbol": pair, "limit": min(limit, 60)}))
    if data.get("retCode") != 0:
        raise OrderFlowUnavailable("Bybit: " + str(data.get("retMsg", "API error")))
    return [r for t in (data.get("result") or {}).get("list") or []
            for r in [_row(t.get("execId"), t.get("side"), t.get("price"), t.get("size"), t.get("time"))] if r]

def _kucoin(pair: str, limit: int) -> List[Dict[str, Any]]:
    url = ("https://api.kucoin.com/api/v1/market/histories?symbol=%s"
           % urllib.parse.quote(pair))
    data = _http_json(url)
    if isinstance(data, dict) and str(data.get("code")) != "200000":
        raise OrderFlowUnavailable("KuCoin: " + str(data.get("msg", "API error")))
    rows = (data or {}).get("data") if isinstance(data, dict) else data
    out: List[Dict[str, Any]] = []
    for tr in rows or []:
        row = _row(tr.get("tradeId"), tr.get("side"), tr.get("price"),
                   tr.get("size"), tr.get("time"))
        if row:
            out.append(row)
    return out


def _bitfinex(pair: str, limit: int) -> List[Dict[str, Any]]:
    url = ("https://api-pub.bitfinex.com/v2/trades/t%s/hist?limit=%d"
           % (urllib.parse.quote(pair), limit))
    rows = _http_json(url)
    if not isinstance(rows, list) or (rows and rows[0] == "error"):
        raise OrderFlowUnavailable("Bitfinex returned an API error")
    out: List[Dict[str, Any]] = []
    for tr in rows or []:
        if not isinstance(tr, (list, tuple)) or len(tr) < 4:
            continue
        amount = _num(tr[2])
        # Bitfinex signs the amount: positive is the taker buying.
        side = "BUY" if amount >= 0 else "SELL"
        row = _row(tr[0], side, tr[3], abs(amount), tr[1])
        if row:
            out.append(row)
    return out


def _mexc(pair: str, limit: int) -> List[Dict[str, Any]]:
    url = ("https://api.mexc.com/api/v3/aggTrades?symbol=%s&limit=%d"
           % (urllib.parse.quote(pair), limit))
    rows = _http_json(url)
    if not isinstance(rows, list):
        raise OrderFlowUnavailable("MEXC returned an API error")
    out: List[Dict[str, Any]] = []
    for tr in rows or []:
        if not isinstance(tr, dict):
            continue
        # m=true means the buyer was the maker, i.e. the taker sold.
        side = "SELL" if tr.get("m") else "BUY"
        row = _row(tr.get("a"), side, tr.get("p"), tr.get("q"), tr.get("T"))
        if row:
            out.append(row)
    return out


def _gemini(pair: str, limit: int) -> List[Dict[str, Any]]:
    url = ("https://api.gemini.com/v1/trades/%s?limit_trades=%d"
           % (urllib.parse.quote(pair), limit))
    rows = _http_json(url)
    if not isinstance(rows, list):
        raise OrderFlowUnavailable("Gemini returned an API error")
    out: List[Dict[str, Any]] = []
    for tr in rows or []:
        if not isinstance(tr, dict):
            continue
        row = _row(tr.get("tid"), tr.get("type"), tr.get("price"),
                   tr.get("amount"), tr.get("timestampms") or tr.get("timestamp"))
        if row:
            out.append(row)
    return out


def _deribit(pair: str, limit: int) -> List[Dict[str, Any]]:
    url = ("https://www.deribit.com/api/v2/public/get_last_trades_by_instrument"
           "?instrument_name=%s&count=%d"
           % (urllib.parse.quote(pair), limit))
    data = _http_json(url)
    if data.get("error"):
        raise OrderFlowUnavailable("Deribit returned an API error")
    rows = (((data or {}).get("result") or {}).get("trades") or [])
    out: List[Dict[str, Any]] = []
    for tr in rows:
        if not isinstance(tr, dict):
            continue
        price = _num(tr.get("price"))
        amount = _num(tr.get("amount"))
        # BTC/ETH perpetuals quote amount in USD; SOL_USDC quotes it in SOL.
        qty = amount if pair.startswith("SOL") else (amount / price if price > 0 else 0)
        row = _row(tr.get("trade_seq") or tr.get("trade_id"), tr.get("direction"),
                   price, qty, tr.get("timestamp"))
        if row:
            out.append(row)
    return out


def _htx(pair: str, limit: int) -> List[Dict[str, Any]]:
    url = ("https://api.huobi.pro/market/history/trade?symbol=%s&size=%d"
           % (urllib.parse.quote(pair), limit))
    data = _http_json(url)
    if data.get("status") != "ok":
        raise OrderFlowUnavailable("HTX: " + str(data.get("err-msg", "API error")))
    out: List[Dict[str, Any]] = []
    for group in (data or {}).get("data") or []:
        for tr in (group or {}).get("data") or []:
            if not isinstance(tr, dict):
                continue
            row = _row(tr.get("trade-id"), tr.get("direction"), tr.get("price"),
                       tr.get("amount"), tr.get("ts"))
            if row:
                out.append(row)
    return out


VENUES: Dict[str, Dict[str, Any]] = {
    "binance": {"name": "BINANCE", "pairs": {"BTC": "BTCUSDT", "ETH": "ETHUSDT", "SOL": "SOLUSDT", "XAU": "PAXGUSDT"}, "fetch": _binance},
    "coinbase": {"name": "COINBASE", "pairs": {"BTC": "BTC-USD", "ETH": "ETH-USD", "SOL": "SOL-USD", "XAU": "PAXG-USD"}, "fetch": _coinbase},
    "kraken": {"name": "KRAKEN", "pairs": {"BTC": "BTC/USD", "ETH": "ETH/USD", "SOL": "SOL/USD", "XAU": "PAXG/USD"}, "fetch": _kraken},
    "okx": {"name": "OKX", "pairs": {"BTC": "BTC-USDT", "ETH": "ETH-USDT", "SOL": "SOL-USDT", "XAU": "PAXG-USDT"}, "fetch": _okx},
    "bitget": {"name": "BITGET", "pairs": {"BTC": "BTCUSDT", "ETH": "ETHUSDT", "SOL": "SOLUSDT", "XAU": "PAXGUSDT"}, "fetch": _bitget},
    "gate": {"name": "GATE.IO", "pairs": {"BTC": "BTC_USDT", "ETH": "ETH_USDT", "SOL": "SOL_USDT", "XAU": "PAXG_USDT"}, "fetch": _gate},
    "bybit": {"name": "BYBIT", "pairs": {"BTC": "BTCUSDT", "ETH": "ETHUSDT", "SOL": "SOLUSDT", "XAU": "XAUTUSDT"}, "fetch": _bybit},
    "kucoin": {
        "name": "KUCOIN",
        "pairs": {"BTC": "BTC-USDT", "ETH": "ETH-USDT", "SOL": "SOL-USDT",
                  "XAU": "PAXG-USDT"},
        "fetch": _kucoin,
    },
    "bitfinex": {
        "name": "BITFINEX",
        "pairs": {"BTC": "BTCUSD", "ETH": "ETHUSD", "SOL": "SOLUSD",
                  "XAU": "XAUT:USD"},
        "fetch": _bitfinex,
    },
    "mexc": {
        "name": "MEXC",
        "pairs": {"BTC": "BTCUSDT", "ETH": "ETHUSDT", "SOL": "SOLUSDT"},
        "fetch": _mexc,
    },
    "gemini": {
        "name": "GEMINI",
        "pairs": {"BTC": "btcusd", "ETH": "ethusd", "SOL": "solusd",
                  "XAU": "paxgusd"},
        "fetch": _gemini,
    },
    "deribit": {
        "name": "DERIBIT",
        "pairs": {"BTC": "BTC-PERPETUAL", "ETH": "ETH-PERPETUAL",
                  "SOL": "SOL_USDC-PERPETUAL"},
        "fetch": _deribit,
    },
    "htx": {
        "name": "HTX",
        "pairs": {"BTC": "btcusdt", "ETH": "ethusdt", "SOL": "solusdt",
                  "XAU": "xautusdt"},
        "fetch": _htx,
    },
}


def catalogue() -> List[Dict[str, Any]]:
    """Venue metadata the UI can display (no network access)."""
    return [
        {"id": vid, "name": spec["name"], "markets": sorted(spec["pairs"])}
        for vid, spec in VENUES.items()
    ]


def trades(venue: str, market: str = "BTC", limit: int = 80) -> Dict[str, Any]:
    """Return the venue's latest public prints, oldest first."""
    vid = str(venue or "").strip().lower()
    spec = VENUES.get(vid)
    if not spec:
        raise OrderFlowUnavailable("unknown venue: %s" % venue)

    key = str(market or "BTC").strip().upper()
    key = next((k for k in ("BTC", "ETH", "SOL", "XAU", "GOLD") if key.startswith(k)), key)
    key = "XAU" if key == "GOLD" else key
    pair = spec["pairs"].get(key)
    if not pair:
        raise OrderFlowUnavailable("%s has no public %s tape" % (spec["name"], key))

    limit = max(10, min(int(limit or 80), 200))
    cache_key = (vid, key, limit)
    now = time.time()
    cached = _CACHE.get(cache_key)
    if cached and now - cached[0] < _TTL:
        return cached[1]

    try:
        rows = spec["fetch"](pair, limit)
        rows = [row for row in rows if row]
        rows.sort(key=lambda row: (row["ts"], row["id"]))
        rows = rows[-limit:]
    except OrderFlowUnavailable:
        raise
    except Exception as exc:
        raise OrderFlowUnavailable(
            "%s public tape unavailable: %s" % (spec["name"], exc)
        ) from exc

    payload = {"venue": vid, "name": spec["name"], "market": key,
               "pair": pair, "trades": rows, "updated_at": int(time.time() * 1000)}
    _CACHE[cache_key] = (now, payload)
    return payload


def reset_cache() -> None:
    """Drop cached tapes (tests / manual refresh)."""
    _CACHE.clear()
