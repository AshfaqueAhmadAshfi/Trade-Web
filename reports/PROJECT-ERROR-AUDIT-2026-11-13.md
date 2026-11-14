# SoftradeX project error audit — 13 November 2026

Audit of the current local checkout on branch `main`. Existing uncommitted source changes were preserved. This review creates reports and isolated diagnostic artifacts; it does not fix production code or place, change, or close any trade.

**Result: 18 substantive findings (2 critical, 10 high, 6 medium), plus 3 maintenance notes.** Severity describes the impact when the affected feature/deployment is used; it does not mean every issue is happening on the current public-feed dashboard.

## Checks actually completed

| Check | Result |
|---|---|
| Python AST syntax, excluding the virtual environment/build output | 49 files, no syntax errors |
| JavaScript syntax (`node --check`) | 20 files, no syntax errors |
| HTML asset references, duplicate IDs, inline script syntax | Main and BD pages pass; two existing screenshot harness pages also pass |
| PowerShell parser | 1 installer helper, no parse errors |
| Installed dependency consistency (`pip check`) | No broken requirements |
| `python -m pytest tests -q --disable-warnings --tb=short` | **292 passed, 3 failed**, 23 warnings, 42.06 s |
| Legacy `tests/run_tests.py`, in an isolated source copy | Final run: **247 passed, 3 failed** checks; includes an aggregate result for 286 unit tests |
| `tools/check_wiring.py` | Exit 1: six missing legacy element IDs; references are guarded |
| Local WSGI HTTP probes on port 8799 | 22 requests: 21 HTTP 200; one expected 422 from an audit request with `limit=5` below the API's minimum 10 |
| Extra TradingView quote probes | `AAPLm`: 503, no mapping. `ADAUSDm`: 503, upstream 404 from incorrect mapping |
| Browser checks | Existing page state, header/setups/swing state, loaded versions, console and network logs inspected |
| Controlled JavaScript reproductions | Six bugs reproduced using fake requests and a fake DOM; no live dashboard state modified |
| Controlled authentication/data probes | Password defaults, deployment detection, stale quote freshness, anonymous HTTP data and foreign-Origin WebSocket data reproduced in isolation |

The legacy runner initially needed additional UI/EA/startup files in its isolated copy. Those setup errors were corrected before the final result above. The final two pre-login failures saw an empty initial snapshot after the runner's fixed 0.6 s sleep; this is a startup/readiness concern in that test, not proof of a successful unauthorized account login. Its third failure is the aggregate session-suite failure. The aggregate runner suppresses individual unit-test tracebacks.

### Current pytest failures

1. `tests/test_webauth.py::DashboardPasswordTests::test_missing_password_has_no_public_default`: expected empty password, got `0186` — real authentication defect, finding 01.
2. `tests/test_webauth.py::DashboardPasswordTests::test_environment_password_overrides_config`: expected environment password, got configuration password — real authentication defect, finding 03.
3. `tests/test_sessions.py::TestNewsBotSessions::test_clock_only_board_without_a_terminal`: expected `clock`, got `tradingview+public` — stale test contract/live-network dependency, finding 18.

## Critical

### 01. Missing password accepts a published default password

**Location:** [backend/webauth.py:44](../backend/webauth.py#L44), [expected_password:81](../backend/webauth.py#L81).

`expected_password()` returns `DEFAULT_PASSWORD = "0186"` when no dashboard password is configured. `password_ok("0186", {}.get)` returns true. This contradicts the module's documented fail-closed policy and the new regression test.

**Impact:** A reachable dashboard can be unlocked using a known credential. Privileged endpoints become available, including account connection and, when enabled, bot controls.

**Fix:** Remove the public default, reject login when no password is configured, and provide an explicit setup state. Keep constant-time comparison.

### 02. Public deployment detection can leave authentication disabled

**Location:** [backend/webauth.py:68](../backend/webauth.py#L68), [backend/app.py:1317](../backend/app.py#L1317), [passenger_wsgi.py:25](../passenger_wsgi.py#L25).

Authentication decides whether the server is public using `HOST` or the configuration's `host`. The actual server startup also binds `0.0.0.0` when only `PORT` is set. Passenger sets public-feed mode but does not set a public bind host. With the default configuration host `127.0.0.1`, both `SOFTRADEX_MODE=public` and a PORT-only deployment can therefore produce `auth_required=False` even when publicly served.

**Evidence:** Isolated public-mode and PORT-only examples both returned false. The local WSGI server also reports false, which is acceptable for its actual loopback listener; the defect is reusing that configuration behind a public Passenger host.

**Fix:** Derive authentication policy from the effective deployment mode/bind settings. Require authentication by default on externally reachable deployments, preserving the deliberate local desktop policy.

## High

### 03. Environment password override is ignored

**Location:** [backend/webauth.py:81](../backend/webauth.py#L81).

`SOFTRADEX_DASHBOARD_PASSWORD` is never consulted. A supplied environment password does not work; the old configuration/default password remains accepted. The environment-override regression test fails.

**Fix:** Read the environment override first, then the configured password, and avoid logging either value. Document/pass the variable in the deployment configuration.

### 04. Account data remains accessible without a session, including through foreign-Origin WebSockets

**Location:** [HTTP gate:255](../backend/app.py#L255), [state endpoint:421](../backend/app.py#L421), [Hub.register:116](../backend/app.py#L116), [WebSocket endpoint:1272](../backend/app.py#L1272).

The gate covers mutating requests only. `/api/state` and other account/history read routes stay open. The WebSocket accepts the connection without session or Origin checks and sends the account snapshot. Browser CORS restrictions do not supply WebSocket authentication.

**Evidence:** In an isolated app with `require_login=True` and a fake account snapshot, anonymous `/api/state` returned 200 with account data, while anonymous POST `/api/settings` correctly returned 401. A fake socket carrying a foreign Origin was accepted and received account data. No real account data was used for this reproduction.

**Fix:** Keep public prices separate from private account state. Require sessions on private HTTP/WS endpoints, validate WebSocket Origin, and use private/no-store responses for account data.

### 06. Chart and header use incompatible symbol maps

**Location:** [frontend map:41](../web/tv-chart.js#L41), [frontend mapping function:113](../web/tv-chart.js#L113), [backend map:49](../backend/tv_feed.py#L49), [backend mapping function:83](../backend/tv_feed.py#L83).

All **21 explicit stock mappings** in the frontend are missing from the backend quote map. Example: the chart uses `NASDAQ:AAPL`, while `/api/chart/tvquote?symbol=AAPLm` returns 503. Exotic forex differs too: `USDTRYm` becomes `FX_IDC:USDTRY` in the chart and `OANDA:USDTRY` in the quote adapter. Some crypto USD symbols become forex tickers: `ADAUSDm` becomes `OANDA:ADAUSD` instead of `BINANCE:ADAUSDT`.

**Fix:** Use one canonical instrument map shared by chart configuration and quote/candle providers. Handle asset kind and aliases explicitly.

### 07. A delayed quote can put Gold's price under BTC's header

**Location:** [web/tv-chart.js:371](../web/tv-chart.js#L371).

`pollTvQuote()` reads the mutable `ourSymbol` again when the response arrives. It does not capture/check the request's symbol or verify `d.symbol`.

**Reproduction:** Request XAUUSD, switch to BTC before resolving the request, then return Gold price 3900. `SOFT_TV_QUOTE` becomes `{symbol:"BTCUSDT", tv_symbol:"OANDA:XAUUSD", price:3900}`. The downstream symbol check accepts the incorrectly labeled quote.

**Fix:** Capture the requested symbol and a request generation, reject superseded responses, and cancel obsolete requests when switching markets.

### 08. Delayed daily candles can populate the new market with old setup levels

**Location:** [web/tv-setups.js:116](../web/tv-setups.js#L116), [setSymbol:207](../web/tv-setups.js#L207).

The levels/price requests do not check their original symbol when applying responses. A symbol switch clears the view, but busy guards can defer the new requests while old responses refill it.

**Reproduction:** XAUUSD daily candles returned after a BTC switch produced `symbol=BTCUSDT`, price 3890, and a Today Low of 3800.

**Fix:** Capture/check the symbol for both requests and fetch the new market immediately after cancellation or completion of the old generation.

### 09. Swing analysis has the same market-switch race

**Location:** [web/swing-ai.js:736](../web/swing-ai.js#L736), [loadCandles:752](../web/swing-ai.js#L752), [setSymbol:786](../web/swing-ai.js#L786).

The six candle jobs and price requests are not scoped to a request generation. Responses from the previous market write into the new market's cleared `reads`, vote, and plan.

**Reproduction:** After switching from XAUUSD to BTC, old candle responses produced BTC swing state with Gold's M5 close/price 3890.

**Fix:** Scope every price/candle result to symbol and generation. Reset market-specific flow/source/level state at the same time.

### 10. Swing starts because a clock boundary passed, without an entry fill

**Location:** [plan timing:528](../web/swing-ai.js#L528), [paint phase:710](../web/swing-ai.js#L710).

The waiting start is the next five-minute boundary. After that time `paint()` displays `RUNNING` regardless of whether price reached entry. `plan.running` is not updated during this transition.

**Evidence:** The live page showed RUNNING while its plan still had `running=false`. Controlled BUY example: entry 100, price 95, time beyond start — UI said `SWING RUNNING`.

**Fix:** Keep predicted start separate from confirmed entry. Enter RUNNING only on a defined price/structure trigger, and start the exit countdown from that confirmed timestamp.

### 11. A target hit or stop can be recorded before the swing starts

**Location:** [planPriceCrossed:597](../web/swing-ai.js#L597), [paint:697](../web/swing-ai.js#L697).

Target/stop checks run even for an ARMED, unfilled plan. The local hit/miss history can count an outcome for a trade that was never entered.

**Reproduction:** BUY plan with start 1500, current time 1200, price beyond target — recorded `hit=true` and `TARGET HIT · SWING COMPLETE` before start.

**Fix:** Track explicit ARMED/RUNNING/COMPLETE states and only evaluate trade outcomes after a confirmed entry.

### 14. Expired cached quotes can be presented with a new timestamp

**Location:** [backend/public_feed.py:431](../backend/public_feed.py#L431), [expired fallback:447](../backend/public_feed.py#L447), [backend/chart_feed.py:900](../backend/chart_feed.py#L900).

When all providers fail, `ticker()` returns the old cache without a maximum stale age. The chart adapter then replaces `updated_at` with the current time. Candle fallback can also return expired history without indicating its age.

**Reproduction:** A quote expired one hour ago with no available provider was returned successfully. Its raw age was 3600 seconds; the API payload's age was approximately 0 seconds and its source remained `public`.

**Fix:** Preserve provider timestamps, expose age/stale status, set bounded fallback age, and pause price-dependent analysis/entry signals when the data is too old.

### 15. TradingView chart and execution analysis still use different instruments

**Location:** [backend/public_feed.py:108](../backend/public_feed.py#L108), [web/tv-setups.js:116](../web/tv-setups.js#L116), [web/swing-ai.js:736](../web/swing-ai.js#L736), [backend/tv_feed.py:49](../backend/tv_feed.py#L49).

The Gold embed uses OANDA spot XAUUSD; public candles/ticker used for setups/swing use the Binance PAXG token proxy, with Yahoo futures as another provider fallback. These are related markets with different prices and ranges. Switching the header source does not make those analysis levels belong to the visible TradingView chart.

**Live comparison:** OANDA quote 3895.19, high/low 3923.09/3875.23; public ticker 3886.11; public daily candle high/low 3918.05/3880.97. Samples are close in time rather than atomic, but the provider/instrument mismatch is confirmed in code.

**Fix:** Bind the chart, header, and execution analysis to one instrument/provider identity. Preserve accurate proxy labels if a proxy is intentionally retained. Exact tick synchronization with a third-party iframe requires a supported shared data integration; a two-second scanner poll alone cannot guarantee it.

## Medium

### 05. Login rate limiting trusts a spoofable forwarded header

**Location:** [backend/webauth.py:169](../backend/webauth.py#L169), [proxy configuration:1340](../backend/app.py#L1340).

`client_ip()` unconditionally takes the first `X-Forwarded-For` value. A direct client can change that header to obtain a fresh rate-limit key. Uvicorn also trusts forwarded headers from all peers. Behavior behind a correctly sanitizing proxy can differ, but direct exposure is vulnerable.

**Fix:** Trust forwarding headers only from configured reverse proxies; otherwise use the actual peer address. Enforce bounded rate-limit state and test blocked attempts from spoofed headers.

### 12. A displayed running swing can still have its trade levels moved

**Location:** [web/swing-ai.js:567](../web/swing-ai.js#L567).

`retune()` stops only when `plan.running` is true. Finding 10's clock-based transition does not set it. Entry, target, stop and R:R can therefore move after the UI says RUNNING, while the timestamps remain unchanged.

**Fix:** Freeze the filled entry and outcome boundaries when a trade starts. Any deliberate trailing adjustment needs explicit rules and visible state.

### 13. Exit countdown reaches zero but the swing remains RUNNING

**Location:** [staleness:556](../web/swing-ai.js#L556), [running clock:715](../web/swing-ai.js#L715).

There is no explicit time-expired outcome. `paint()` continues displaying RUNNING with `00:00` after `endAt`. Rebuilding begins only after another 30 seconds, and a time exit is not logged as an outcome.

**Reproduction:** Time beyond `endAt` displayed `SWING RUNNING · OPEN 00:19` with `00:00` exit countdown.

**Fix:** Transition at `endAt` to a clear timed-exit/expired state, record the result, then rebuild after the intended delay.

### 16. Every market is cross-checked against Gold PAXG

**Location:** [web/swing-ai.js:457](../web/swing-ai.js#L457), [buildPlan:480](../web/swing-ai.js#L480).

`checkSources()` always requests `PAXGUSDT`, including when the selected market is BTC, EURUSD or a stock. This creates meaningless disagreement warnings. The computed `src.ok` is not a condition for issuing a plan, despite comments suggesting unconfirmed prices would prevent planning. Source state is not cleared on market switch.

**Fix:** Choose a genuinely equivalent verification instrument per market, reset source state, and define how stale/disagreeing sources affect confidence and planning.

### 17. Hosted mode keeps retrying unsupported WebSockets

**Location:** [web/app.js:570](../web/app.js#L570), [reconnect:638](../web/app.js#L638), [web/softradex-terminal.js:612](../web/softradex-terminal.js#L612).

`/api/config` correctly returns `live_stream=false` on the WSGI server, but these clients still open/retry `/ws` and `/ws/chart`. HTTP fallback works, while retries continue against a transport the server cannot serve.

**Evidence:** Numerous repeated 404 WebSocket handshake errors in the current browser console; ongoing HTTP market requests returned 200.

**Fix:** Start HTTP polling directly when streaming is unavailable. Reserve retries/backoff for deployments that actually support WebSockets.

### 18. Session test still expects no public data when MT5 is absent

**Location:** [tests/test_sessions.py:332](../tests/test_sessions.py#L332), [backend/news_bot.py:2822](../backend/news_bot.py#L2822), [session source:2936](../backend/news_bot.py#L2936).

The test patches MT5 to None and expects a clock-only board. The implementation now reads public history, so it returns `tradingview+public` when available. The test can depend on real provider/network behavior and fail even though the new fallback is intentional.

**Fix:** Mock the public provider. Test successful public fallback and unavailable-public-data/clock-only behavior separately. Do not remove the public fallback merely to satisfy the old assertion.

## Maintenance notes

1. **Legacy test runner coverage/readiness:** [tests/run_tests.py:1105](../tests/run_tests.py#L1105) omits `test_webauth` and `test_market_watch`; it therefore does not cover all 295 pytest tests. Its pre-login checks use a fixed 0.6 s sleep and failed on the final isolated run with an empty snapshot. Use discovered tests and an explicit bounded readiness condition. See [custom runner log](audit-custom-tests.log).
2. **Stale wiring checks:** [tools/check_wiring.py](../tools/check_wiring.py) reports six removed IDs: `rail-bot-count`, `rail-hist-count`, `rail-history`, `rail-pos-count`, `rail-positions`, `tab-badge-bots`. Their current code references are null-guarded, so the checker failure is not evidence of a runtime null dereference. Remove obsolete references or update the checker to understand optional/removed UI.
3. **Missing deployment guide:** [README.md:23](../README.md#L23) points to `DEPLOY.md`, which does not exist in this checkout. The cPanel guide does exist. Restore the referenced VPS/Docker guide or update the link.

## Fix order

1. Fix password defaults/environment handling, public deployment authentication, private HTTP/WS access and trusted proxy handling (01–05).
2. Unify instrument identity and reject superseded market requests (06–09, 15).
3. Add an explicit swing entry/outcome/time-exit state machine (10–13).
4. Preserve data freshness and correct source verification (14, 16).
5. Honor hosted transport capability and repair deterministic test/wiring coverage (17–18 and maintenance notes).

## Evidence artifacts

- [Runtime HTTP probes](audit-runtime-results.json)
- [Symbol mapping mismatches and HTTP failures](audit-mapping-results.json)
- [JavaScript reproduction source](audit-diagnostics.cjs) and [results](audit-diagnostic-results.json)
- [Password/deployment probes](audit-auth-results.json)
- [Anonymous HTTP/WebSocket probes](audit-private-data-results.json)
- [Stale timestamp reproduction](audit-stale-data-results.json)
- [Live provider comparison](audit-feed-comparison.json)
- [Static page checks](audit-static-results.json) and [Python syntax results](audit-python-syntax.json)
- [Final isolated custom-runner log](audit-custom-tests.log)

## Verification limits

This is a source/test/API/state audit, not proof that the project has no other defects. No real MT5 orders were executed, no real account data was used in the security reproduction, and no production deployment was changed. The EA bridge and installer were read; MQL5 compilation, Inno Setup compilation, Docker/Passenger production deployment and every responsive/browser interaction were not executed. The TradingView iframe's actual internal tick/price scale was not visually verified; header-versus-iframe exact synchronization remains a limitation of the current design.

Ruff/pyflakes and httpx are not installed in the current virtual environment. Python syntax checking does not replace undefined-name/static-lint coverage. The existing root API/WSGI smoke scripts were not separately rerun; live HTTP requests provided the read-only smoke coverage instead.

One isolated security probe left a temporary test database open during cleanup. The probe results were saved successfully. A subsequent attempt to remove that temporary audit folder was rejected by automatic approval review with the generic reason `blocked by policy`; the folder may remain under the OS temporary directory. This is audit cleanup, not a production-project finding.
