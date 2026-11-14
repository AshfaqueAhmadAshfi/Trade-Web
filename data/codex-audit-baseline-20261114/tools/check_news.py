"""Diagnose the news feed: cache contents vs a live fetch, per source."""
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.news_bot import NewsFeed  # noqa: E402

CACHE = Path(__file__).resolve().parent.parent / "data" / "news_cache.json"
now = time.time()
print("now            :", int(now), time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime(now)))

if CACHE.exists():
    data = json.loads(CACHE.read_text(encoding="utf-8"))
    evs = data.get("events") if isinstance(data, dict) else data
    print("cache top keys :", list(data.keys()) if isinstance(data, dict) else "list")
    if isinstance(data, dict):
        for k in ("updated_at", "source", "saved_at"):
            if k in data:
                v = data[k]
                print("  cache.%-10s: %s  (%s)" % (
                    k, v, time.strftime("%Y-%m-%d %H:%M", time.gmtime(float(v)))
                    if str(v).startswith("17") else ""))
    evs = evs or []
    print("cache events   :", len(evs))
    if evs:
        tss = sorted(float(e.get("ts") or 0) for e in evs)
        print("  ts range     :", time.strftime("%Y-%m-%d %H:%M", time.gmtime(tss[0])),
              "->", time.strftime("%Y-%m-%d %H:%M", time.gmtime(tss[-1])))
        future = [t for t in tss if t >= now - 3600]
        print("  events now+  :", len(future))
        from collections import Counter
        print("  by source    :", dict(Counter(str(e.get("source")) for e in evs)))

print("\n--- live fetch_once (fresh NewsFeed, no cache) ---")
f = NewsFeed(cache_path=None)
t0 = time.time()
for name in ("_fetch_tradingview", "_fetch_forexfactory", "_fetch_investing_rss",
             "_fetch_yahoo_rss", "_fetch_google_news"):
    try:
        rows = getattr(f, name)()
        print("%-22s -> %4d rows" % (name.replace("_fetch_", ""), len(rows or [])))
    except Exception as exc:
        print("%-22s -> ERROR %s: %s" % (name.replace("_fetch_", ""), type(exc).__name__, str(exc)[:140]))
print("total time %.1fs" % (time.time() - t0))

n = f.fetch_once()
print("fetch_once     -> %d events | source=%s | updated_at=%d" % (n, f.source, f.updated_at))
up = [e for e in f.events if float(e.get("ts") or 0) >= now - 3600]
print("events now+    -> %d" % len(up))
for e in up[:5]:
    print("   ", time.strftime("%m-%d %H:%M", time.gmtime(float(e["ts"]))), e.get("impact"),
          str(e.get("country")), str(e.get("title"))[:60])
