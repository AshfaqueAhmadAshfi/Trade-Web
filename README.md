# Best-AI-Software-SoftradeX-Trade

SoftradeX market dashboard: charts, market pressure, multi-venue order flow,
economic news, trading sessions and market analysis. One FastAPI process serves
the APIs and static UI. It runs entirely on public market APIs, with no MT5
software, terminal connection or broker account login.

## Run on this PC (Windows)

Double-click `start.bat` (or `python backend/app.py`), then open <http://127.0.0.1:8777/>.
The SoftradeX access website opens first. Click its central **Access** button to
enter the trading dashboard at `/dashboard`. Internet is required for ongoing live data.
Both the access website and dashboard interface use English, with no language switch.
**News · Next 24H** shows upcoming scheduled releases and relevant published
headlines from the last 24 hours, including Google News and the other providers.
Headlines stay labelled as unscheduled context, with their source links. At the release time, an
event moves exclusively to **Running News** and disappears when its estimated
impact window ends. Reading recency is separate from estimated market impact;
an explicit shorter headline monitoring deadline is still respected. Running
News also shows recent relevant headlines during their estimated 15/30/60-minute
monitoring window, newest first, with a WATCH LEFT countdown and source links.
These headlines remain in the 24-hour reading list and are labelled as monitoring;
publication is not a confirmed impact-start time. Newly arriving headlines keep
the five-second popup alert.
Expired news is rejected on refresh and cache restore, including the other news
cards, reading drawer and chart markers.
`setup.bat` installs the web dependencies; it does not install a terminal bridge.
Windows, Linux, Docker and cPanel all use public API data and HTTP polling.
Old `SOFTRADEX_MODE=mt5/local/desktop` settings cannot enable broker connections.

Charts and analysis use Binance spot and Yahoo Finance APIs; TradingView embeds
and quote endpoints use their configured TradingView instrument. Gold candles
from Binance use PAXGUSDT as a proxy. Provider quotes and update delays can differ.
If a provider is unavailable, the UI reports unavailable data or keeps its cached
data. Analysis is an estimate based on candles, news and flow.

The **Whale · Open Positions** panel beneath SL · Liquidity Zones scans public
Hyperliquid wallets for the selected supported dollar market. It discovers wallets
from recent fills and Hypurrscan's public USDC/HYPE holder lists, then verifies
their actual perpetual positions and average entry prices using Hyperliquid
wallet snapshots. Token balances only discover candidates; they do not establish
trades or positions. Positions qualify at $100,000; partial reductions remain tracked
until a successful wallet check confirms an exit. BUY/SELL counts are tracked
wallets, with a maximum of 24 per contract and partial market coverage. Company
and individual order names are not disclosed. Gold uses `xyz:GOLD`, Silver uses
`xyz:SILVER`, and supported crypto contracts are checked against provider metadata;
these perpetual contracts differ from spot/chart instruments. FX and other
unsupported markets show no public position coverage. Scans run on demand about
every 15 seconds while the page is visible, with up to 24 wallet checks and four
concurrent wallet requests; exit detection can take multiple scans. The first
snapshot also loads in a hidden desktop preview. Failed checks retain the last
verified rows. The server saves tracked holdings in `data/whale_positions.json`;
restored rows remain last verified until rechecked. If an older running server
lacks the route or current scanner, the browser reads the same public CORS APIs
directly and caches candidates and holdings locally. Authentication failures do
not trigger that fallback. Wallet links and Hypurrscan attribution are in the panel.

Broker login, EA ingestion and automated order execution endpoints are disabled.
The app does not place orders or require account credentials. Existing configured
dashboard password protection is separate from broker access and remains in place.

**Next Sell Swing AI** uses the existing left-side panel; **Next Buy Swing AI**
sits immediately below Running News on the right. Each direction evaluates its
own confirmation, entry clusters and risk/reward through one shared arbiter.
They read M1, M5, M15, H1, H4 and D1 candles from the exact TradingView chart
instrument; unavailable, stale or mismatched candles leave the panels on WAIT.
Quotes never stretch candle prices or move a displayed entry bracket. Unfilled
levels can be revised on new closed M5/M15/H1 structure; a running model keeps
its entry, target, stop and deadline. Only one direction can be armed/running.
These are automatic model estimates while the dashboard is visible, not orders.

New setups require a fresh TradingView quote, at least 60 valid closed candles per
participating timeframe, M5 agreement
with M15 or H1, at least 55% model signal strength, two nearby entry-confluence
levels from swing structure and a different indicator family, correctly ordered
target/stop prices and at least 1.2 reward per unit of
risk. After a recent miss, that direction requires 65% strength and three levels
for 20 minutes. Recent model outcomes are stored per selected market and shown
separately for BUY and SELL. Missing timeframe coverage reduces model strength;
one timeframe or venue flow cannot force a setup. Targets respect known opposing
levels, with a volatility floor for stop distance. Duration uses recent measured
candle travel and ATR. Entry requires a new observed quote, and deadlines expire
even if quotes go stale. A data gap makes later outcomes unverified, keeping them
out of the hit/miss counts. Closed-candle scores do not change with intrabar quotes.
Fibonacci anchors follow an ordered impulse; local pivots require two closed bars
of confirmation. Entry clusters use overlapping windows bounded to 0.42 M5 ATR,
so a valid BUY or SELL cluster is not lost through greedy partitioning. Stale
higher-frame levels and failed candle refreshes cannot confirm a new entry.
Missing short intraday intervals block confirmation; non-crypto session breaks
of at least an hour remain allowed, while continuous crypto gaps block entry.
The displayed **Swing Entry** changes from planned to observed price only when
the model starts on a new quote crossing. A gap over 15 seconds, an entry overrun
above 0.2 ATR or observed reward/risk below 1.2 leaves it unfilled. Target/stop
stay fixed; reward/risk and duration use the observed entry. Revised unfilled
structures reset their entry window and duration together. Active plans survive
reload and market switching; older calculation-version plans are recalculated;
a completed structure needs a new closed candle before the same direction can
rearm. Signal strength is not a calibrated win probability.

## Put it on a domain (upload → live)

```bash
cp .env.example .env      # DOMAIN=yourdomain.com
docker compose up -d --build
```

See the project's Docker configuration for domain hosting; for shared hosting use
the cPanel guide below.

## cPanel / shared hosting (no MT5, API data)

cPanel runs Python apps through Passenger (WSGI, no WebSocket). Prices come from
public market APIs and the browser polls HTTP. Upload
the clean `dist/softradex-cpanel-ready.zip` into a private application root
created by *Setup Python App*. Use Python 3.11+, a domain/subdomain root URL,
startup file `passenger_wsgi.py`, entry point `application`, and set your own
`SOFTRADEX_DASHBOARD_PASSWORD` in cPanel before restarting. The ZIP's
`requirements.txt` uses the tested dependency set from `requirements-cpanel.txt`.
Build it again with `python tools/build_cpanel.py`. It excludes local passwords,
config, databases and caches and versions static assets using content hashes.
Passenger workers share hashed sessions/logout and login limits through private
SQLite storage. Provider cache writes use separate temporary files. The local
WSGI checker imports the actual Passenger entry point, including authentication.

Step-by-step: **[DEPLOY-CPANEL.md](DEPLOY-CPANEL.md)**

## Password and local checks

For a domain, Docker or Passenger deployment, set your own
`SOFTRADEX_DASHBOARD_PASSWORD` in the hosting environment. Alternatively set
`dashboard_password` in the private local configuration. There is no built-in
password, and an EA token cannot unlock the dashboard. Loopback development
keeps the existing `require_login` policy. Only explicitly configured
`FORWARDED_ALLOW_IPS` addresses are trusted as reverse proxies.

Install the test dependencies with
`python -m pip install -r requirements-dev.txt`, then run
`python tests/run_tests.py` for the offline Python and JavaScript suites (Node.js
is also required). `python tools/audit_project.py` checks source syntax, HTML
asset references and duplicate IDs and writes a per-file report. The tests use
fake provider responses and temporary databases; live feed availability is a
separate runtime check.
