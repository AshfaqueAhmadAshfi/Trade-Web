"""Official Binance announcements and explicitly scheduled exchange events."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from html import unescape
import json
import re
import threading
import time
import urllib.parse
import urllib.request
import urllib.error

from .news_sources import plain_text
from .config import DATA_DIR

API = "https://www.binance.com/bapi/composite/v1/public/cms/article/"
_lock = threading.Lock()
_cached = None
_expires = 0
_last_error = ""
_blocked_until = 0
_request_lock = threading.Lock()
_next_request = 0
CACHE_PATH = DATA_DIR / "binance_news_cache.json"
_TIME = re.compile(r"\b(20\d\d-\d\d-\d\d)(?:\s+at)?[ T]+(\d\d?:\d\d(?::\d\d)?)\s*\(?UTC(?:\s*([+-])\s*(\d{1,2})(?::(\d\d))?)?\)?", re.I)


def content_blocks(body):
    """Read CMS text nodes, preserving paragraph/table-row schedule context."""
    if isinstance(body, str):
        try:
            body = json.loads(body)
        except ValueError:
            return [plain_text(unescape(body))]
    def walk(node):
        if isinstance(node, list):
            return "".join(walk(n) for n in node)
        if not isinstance(node, dict):
            return ""
        if node.get("node") == "text":
            return unescape(str(node.get("text") or ""))
        text = walk(node.get("child", []))
        tag = node.get("tag")
        return text + ("\n" if tag in ("p", "li", "tr", "h1", "h2", "h3") else " " if tag in ("td", "th", "br") else "")
    blocks = []
    for line in walk(body).splitlines():
        line = " ".join(line.split())
        if line == "Binance Team" or line.startswith("Thank you for your support"):
            break  # Footer app / social links are not affected assets.
        if line:
            blocks.append(line)
    return blocks


def affected_markets(text):
    upper = text.upper()
    assets = set()
    for m in re.finditer(r"\b([A-Z0-9]{2,20})/?(?:USDT|USDC|FDUSD|BUSD|USD)\b", upper):
        assets.add(m.group(1))
    for m in re.finditer(r"\(([A-Z0-9]{2,15})\)", text):
        if m.group(1) not in ("UTC", "ET", "ETF", "API", "APR", "VIP", "USDT", "USDC", "USD", "NYSE"):
            assets.add(m.group(1))
    names = {"bitcoin":"BTC", "ethereum":"ETH", "bnb":"BNB", "solana":"SOL", "dogecoin":"DOGE",
             "xrp":"XRP", "cardano":"ADA", "litecoin":"LTC", "pax gold":"PAXG"}
    for name, asset in names.items():
        if re.search(r"\b"+re.escape(name)+r"\b", text, re.I):
            assets.add(asset)
    markets = {asset+"USDT" for asset in assets}
    if assets & {"PAXG", "XAU"} or re.search(r"\b(gold|xau)\b", text, re.I):
        markets.add("XAUUSDm")
    if "XAG" in assets or re.search(r"\bsilver\b", text, re.I):
        markets.add("XAGUSDm")
    return sorted(markets)


def parse_announcement(article, now=None):
    now = time.time() if now is None else now
    title, code = str(article.get("title") or "").strip(), str(article.get("code") or "")
    if not title or not re.fullmatch(r"[a-zA-Z0-9]{8,64}", code):
        return []
    blocks = content_blocks(article.get("body") or "")
    text = title+"\n"+"\n".join(blocks)
    markets = affected_markets(text)
    scope = "exchange" if re.search(r"\b(security incident|proof of reserves|exchange.wide|system upgrade|system maintenance)\b", title, re.I) and not affected_markets(title) else "asset"
    impact = "high" if re.search(r"\b(security incident|hack|delist)\b", title, re.I) else "low" if re.search(r"\b(rewards|promotion|competition|quiz)\b", title, re.I) else "medium"
    common = {"title":title, "country":"CRYPTO", "currency":"CRYPTO", "source":"binance", "sources":["binance"],
              "url":"https://www.binance.com/en/support/announcement/detail/"+code, "article_code":code,
              "markets":markets, "market_scope":scope, "impact":impact,
              "description":" ".join(blocks)[:3000], "actual":None, "forecast":None, "previous":None}
    rows = []
    published = article.get("publishDate", article.get("releaseDate"))
    try:
        published = float(published)/1000
        if now-86400 <= published <= now:
            rows.append({**common, "ts":published, "kind":"headline"})
    except (TypeError, ValueError):
        pass
    if re.search(r"\b(cancelled|canceled|postponed|delayed)\b", title, re.I):
        return rows
    scheduled = {}
    in_example = False
    for block in blocks:
        if re.match(r"example\b",block,re.I):
            in_example = True
        if re.match(r"(?:further information|notes?\b)",block,re.I):
            in_example = False
        if in_example:
            continue
        if re.search(r"\b(example|previous|originally|historical)\b", block, re.I):
            continue
        for match in _TIME.finditer(block):
            date, clock, sign, hours, minutes = match.groups()
            try:
                offset = timedelta(hours=int(hours or 0), minutes=int(minutes or 0))
                if int(hours or 0)>14 or int(minutes or 0)>59:
                    continue
                zone = timezone(-offset if sign == "-" else offset)
                ts = datetime.fromisoformat(date+"T"+clock).replace(tzinfo=zone).timestamp()
            except ValueError:
                continue
            local_markets = affected_markets(block) or markets
            if not now-21600 < ts <= now+86400:
                continue
            if ts in scheduled:
                scheduled[ts]["markets"] = sorted(set(scheduled[ts]["markets"]) | set(local_markets))
                continue
            scheduled[ts] = {**common, "ts":ts, "kind":"calendar", "markets":local_markets,
                             "schedule_context":block[:1000], "impact_window_sec":3600 if impact=="high" else 1800 if impact=="medium" else 900}
    rows.extend(scheduled.values())
    return rows


def _get(path, query, deadline):
    global _blocked_until, _next_request
    with _request_lock:
        if time.time() < _blocked_until:
            raise RuntimeError("Binance rate limited; retry after cooldown")
        pause = max(0, _next_request-time.monotonic())
        if pause:
            time.sleep(pause)
        _next_request = time.monotonic()+0.15
    remaining = deadline-time.monotonic()
    if remaining <= 0:
        raise TimeoutError("Binance announcement scan timed out")
    url = API+path+"?"+urllib.parse.urlencode(query)
    req = urllib.request.Request(url, headers={"User-Agent":"Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, timeout=min(10, remaining)) as response:
            payload = json.load(response)
    except urllib.error.HTTPError as exc:
        if exc.code in (429,418):
            try:
                retry = min(3600,max(60,int(exc.headers.get("Retry-After",300))))
            except (TypeError,ValueError):
                retry = 300
            _blocked_until = time.time()+retry
        raise
    if not isinstance(payload, dict) or payload.get("code") != "000000" or not isinstance(payload.get("data"), dict):
        raise ValueError("Invalid Binance announcement API response")
    return payload["data"]


def _scan():
    now, deadline = time.time(), time.monotonic()+45
    cutoff = now-30*86400
    first = _get("list/query", {"type":1,"pageNo":1,"pageSize":50}, deadline)
    catalogs = first.get("catalogs")
    if not isinstance(catalogs, list) or not catalogs:
        raise ValueError("Binance returned no announcement catalogs")
    candidates = {}
    for catalog in catalogs:
        page, articles = 1, catalog.get("articles") or []
        while True:
            for a in articles:
                if float(a.get("releaseDate") or 0)/1000 >= cutoff:
                    candidates[a["code"]] = a
            if len(articles)<50 or min(float(a.get("releaseDate") or 0)/1000 for a in articles)<cutoff:
                break
            page += 1
            if page>20:
                raise ValueError("Binance catalog pagination incomplete")
            data = _get("list/query", {"type":1,"pageNo":page,"pageSize":50,"catalogId":catalog["catalogId"]}, deadline)
            articles = [a for c in data.get("catalogs", []) for a in c.get("articles", [])]
    # Publication timestamps establish headlines even when article details fail.
    calendar, headlines, errors = [], [], []
    def detail(a):
        return _get("detail/query", {"articleCode":a["code"]}, deadline)
    with ThreadPoolExecutor(max_workers=4) as pool:
        pending = [(a,pool.submit(detail,a)) for a in candidates.values()]
        for a, future in pending:
            try:
                rows = parse_announcement(future.result(), now)
            except Exception as exc:
                errors.append(str(exc))
                rows = parse_announcement(a, now)
            calendar.extend(r for r in rows if r["kind"]=="calendar")
            headlines.extend(r for r in rows if r["kind"]=="headline")
    return {"calendar":calendar,"headline":headlines,"error":"; ".join(dict.fromkeys(errors))[:180],
            "articles_scanned":len(candidates), "updated":now}


class ProviderRows(list):
    def __init__(self, rows, state="ok", error="", updated=0):
        super().__init__(rows)
        self.provider_state, self.provider_error, self.provider_updated = state,error,updated


def _restore_cache():
    try:
        data = json.loads(CACHE_PATH.read_text(encoding="utf-8"))
        age = time.time()-float(data["updated"])
        if 0 <= age < 86400 and all(isinstance(data.get(k),list) for k in ("calendar","headline")):
            return data
    except (OSError,ValueError,KeyError,TypeError):
        pass
    return None


def _save_cache(data):
    try:
        CACHE_PATH.parent.mkdir(parents=True,exist_ok=True)
        temporary = CACHE_PATH.with_suffix(".tmp")
        temporary.write_text(json.dumps(data,ensure_ascii=False),encoding="utf-8")
        temporary.replace(CACHE_PATH)
    except OSError:
        pass


def fetch_binance(kind):
    global _cached, _expires, _last_error
    with _lock:
        if _cached is None and not _last_error:
            _cached = _restore_cache()
            if _cached:
                _expires = float(_cached["updated"])+300
        if time.time() >= _expires:
            try:
                fresh = _scan()
                if fresh.get("error") and _cached:
                    # Keep verified rows from earlier coverage during a partial scan.
                    for part in ("calendar","headline"):
                        previous = { (r.get("article_code"),r["ts"]):r for r in _cached[part] }
                        previous.update({(r.get("article_code"),r["ts"]):r for r in fresh[part]})
                        fresh[part] = list(previous.values())
                _cached = fresh
                _last_error = ""
                _save_cache(fresh)
            except Exception as exc:
                _last_error = str(exc)
            _expires = max(time.time()+300,_blocked_until)
        if _cached is None:
            raise RuntimeError(_last_error or "Binance announcement data unavailable")
        error = _last_error or (_cached.get("error") if kind=="calendar" else "")
        state = "cached" if _last_error else "partial" if error else "ok"
        return ProviderRows(_cached[kind],state,error,float(_cached["updated"]))
