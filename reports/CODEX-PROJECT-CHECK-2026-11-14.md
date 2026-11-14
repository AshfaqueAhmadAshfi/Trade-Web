# SoftradeX project check and repairs — 14 November 2026

The current source checkout was checked and repaired on branch `main`. Existing
uncommitted work was preserved. This audit did not stage, commit, push or publish
the project. The layout and CSS were retained; frontend edits correct data,
request handling and status text. HTML changes only update asset versions.

## Results

| Check | Result |
|---|---|
| Initial Python suite | 305 passed, 14 failed |
| Complete repaired Python suite | **332 passed**, 11 subtests passed |
| Complete JavaScript suite | **52 passed, 0 failed** |
| Final additional access/freshness regressions | **11 passed** after the last test-isolation refinement |
| Python source syntax inventory | 61 files, no syntax failures |
| JavaScript source syntax inventory | 28 files, no syntax failures |
| JSON syntax inventory | 14 files, no failures |
| Main and Bangladesh HTML assets, duplicate IDs and inline scripts | Both pages pass |
| Ruff undefined-name and syntax checks | Pass for backend, tests, tools and root Python entry points |
| Installed dependency consistency | `pip check` passes |
| Private configuration | Valid JSON object; nested bot configuration types checked without printing credentials |
| Frontend wiring and English/Bangla dictionary keys | Pass; seven absent legacy controls are optional and null-guarded |
| PowerShell EA installer helper | Parser passes |
| Docker Compose configuration | Valid; Docker daemon is unavailable, so an image/container build was not run |
| Local HTTP smoke checks | **35/35 HTTP 200** across both pages and every API group |
| Passenger/WSGI health request | HTTP 200, no WSGI errors |
| Final restarted server | Health HTTP 200; public-mode `all_accounts` history is empty |

The Python suite retains one upstream `websockets.legacy` deprecation warning.
The project's deprecated UTC timestamp calls were replaced. The full test runner
now reports failures directly instead of hiding tracebacks in the old aggregate
runner.

## Repairs

### Access and deployment

- Removed the known fallback dashboard password. An empty password denies login.
- Added the environment password override while keeping explicitly configured
  dashboard passwords usable. An EA token no longer unlocks a browser session.
- Matched authentication policy to the actual bind host, including PORT-only
  deployments, and marked Passenger deployments explicitly.
- Protected private state/history/event/bot reads and both WebSocket endpoints.
- Added browser Origin checks and private/no-store API response headers.
- Stopped trusting arbitrary forwarded headers for login rate-limit identity;
  the Uvicorn proxy allowlist is now explicit.
- Implemented the rate-limit window, bounded its memory and corrected the
  attempt threshold.
- Prevented public-only mode from exposing stored broker history through the
  `all_accounts` option.
- Docker now passes the configured dashboard password/proxy variables.

### Market data and frontend state

- Preserved provider quote timestamps and marked outage fallbacks stale.
  Quotes older than the bounded fallback interval are rejected; cached candles
  also have a bounded outage fallback.
- Corrected backend/frontend stock, exotic forex and crypto TradingView
  mappings, including COIN and WMT exchange identities.
- Corrected cached TradingView quote aliases so the response belongs to the
  market requested by the caller.
- Daily setups now request the exact TradingView instrument where supported,
  share the matching live quote, discard old-market responses and abort stalled
  requests. A candle close cannot overwrite the displayed live quote.
- Swing plans remain armed until an observed entry trigger. The actual entry
  starts the exit timer and freezes running levels. Gaps past an unfilled setup
  do not count as wins/losses; running plans have a timed exit.
- Removed hardcoded ticker prices and disconnected random price movement.
  Normalized market aliases update the original ticker rows.
- Removed fabricated offline market-watch quotes and public-feed spreads.
  Unavailable prices remain unavailable; forex precision follows the catalogue.
- Failed candle requests consume the public download budget too.
- Removed the hardcoded Gold fallback from the order-flow AI target calculation.
- Added a DOM-ready guard to dashboard initialization.
- Fixed duplicate Bangladesh setup IDs and missing bid/ask midpoint handling.

### Configuration, startup and tests

- Restored the missing `_ERROR_HINTS` definition that caused undefined-name errors.
- Deep-copied nested configuration defaults.
- Declared and installed `requests`, and raised the WebSocket minimum version
  to match the sync client API used by this project.
- Fixed setup's Python executable quoting for paths containing spaces.
- Added checks/repair for an existing virtual environment missing runtime packages.
- Added a development dependency file and an offline network fixture.
- Updated legacy MT5 tests to use their fake adapter explicitly, preserving
  production's public-only guard.
- Mocked all newly added news providers in the isolated aggregation test.
- Prevented public AI test workers from leaking into subsequent tests.
- Replaced the obsolete aggregate runner with the current complete Python and
  JavaScript runner; retained financial/store checks in dedicated unit tests.
- Added reproducible per-file static and read-only runtime audit tools.

## Browser checks

The main dashboard and the Bangladesh dashboard were inspected in the browser.
The chart host, indicators, Swing, stop-zone, setup and trader modules loaded.
Gold was switched to BTC: the quote, chart selection, setup state and Swing state
all followed BTC. The chart timeframe changed from 5m to 1h. The inspected
desktop pages had no horizontal document overflow.

The Bangladesh page reports `SIM FEED · DSE`, loaded 22 market rows, and showed
five unique setup IDs. Its existing deterministic simulation is retained and
documented; this is not a live DSE integration.

Browser logs contained third-party exchange socket-close warnings during
reload/market transitions. No uncaught application exception was found in the
inspected console output. REST venue data and all runtime smoke routes succeeded.
A narrow-viewport check was interrupted by human browser input and is not
claimed as verified.

## Provider availability and practical limits

The live news scan included all 13 configured source names. Its first snapshot
contained 460 rolling-window events. TradingView, ForexLive, ActionForex, CNBC,
MarketWatch, the Federal Reserve, CoinDesk and Google News returned usable rows.
Forex Factory used genuine cached rows. Investing and Binance had partial
availability; Exness's server calendar was unavailable. FXStreet was unavailable
in that snapshot but a separate live retry returned **30 rows**.

These external HTTP/anti-bot/feed failures can change independently of this
repository. Cached/partial/unavailable states are retained honestly; no calendar
release or quote is invented to make the status green.

Docker Desktop's Linux-engine pipe was absent. Inno Setup and MetaEditor
compilers were not available. Docker image builds, installer EXE builds and
MQL5 EA/indicator compilation therefore remain **unverified**. Existing binaries
in build output were not rebuilt. No hosted deployment or real order execution
was performed.

## Running and repeating the checks

The repaired source runs in the Preview panel at **http://127.0.0.1:8781/**.
The owned server's current launcher PID is stored in
`data/codex-audit-server-launcher.pid`; its logs are
`data/codex-audit-server.stdout.log` and `data/codex-audit-server.stderr.log`.
An already-running server on 8777 belongs to the pre-existing session. Restart
that app normally to load the Python repairs; `start.bat` otherwise reuses it.

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.\.venv\Scripts\python.exe tests/run_tests.py
.\.venv\Scripts\python.exe tools/audit_project.py
.\.venv\Scripts\python.exe tools/check_runtime.py --base-url http://127.0.0.1:8781
```

For public hosting, configure your own `SOFTRADEX_DASHBOARD_PASSWORD` or the
private local `dashboard_password` setting. There is no built-in password.

## Evidence

- [Per-file static inventory](codex-audit-static-results.json)
- [Read-only runtime results](codex-audit-runtime-results.json)
- [Complete test output](codex-audit-all-tests-final.log)
- [Initial Python failures](codex-audit-pytest-baseline.log)
- [Files changed from the audit's starting source snapshot](codex-audit-changed-files.json)

The changed-file inventory contains existing files only; new audit tools, tests
and this report are additional files. The original source snapshot is retained
under the ignored local `data/codex-audit-baseline-20261114` directory.
