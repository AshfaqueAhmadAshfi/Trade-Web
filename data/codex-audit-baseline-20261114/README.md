# Best-AI-Software-SoftradeX-Trade

SoftradeX market dashboard: charts, market pressure, multi-venue order flow,
economic news, trading sessions and market analysis. One FastAPI process serves
the APIs and static UI. It runs entirely on public market APIs, with no MT5
software, terminal connection or broker account login.

## Run on this PC (Windows)

Double-click `start.bat` (or `python backend/app.py`), then open <http://127.0.0.1:8777/>.
The dashboard opens directly. Internet is required for ongoing live data.
`setup.bat` installs the web dependencies; it does not install a terminal bridge.
Windows, Linux, Docker and cPanel all use public API data and HTTP polling.
Old `SOFTRADEX_MODE=mt5/local/desktop` settings cannot enable broker connections.

Charts and analysis use Binance spot and Yahoo Finance APIs; TradingView embeds
and quote endpoints use their configured TradingView instrument. Gold candles
from Binance use PAXGUSDT as a proxy. Provider quotes and update delays can differ.
If a provider is unavailable, the UI reports unavailable data or keeps its cached
data. Analysis is an estimate based on candles, news and flow.

Broker login, EA ingestion and automated order execution endpoints are disabled.
The app does not place orders or require account credentials. Existing configured
dashboard password protection is separate from broker access and remains in place.

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
`passenger_wsgi.py`, `backend/`, `web/` and `requirements.txt` into the app root
created by *Setup Python App*, start it with `passenger_wsgi.py`, then RESTART.

Step-by-step: **[DEPLOY-CPANEL.md](DEPLOY-CPANEL.md)**
