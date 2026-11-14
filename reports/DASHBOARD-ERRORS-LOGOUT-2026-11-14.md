# Dashboard screenshot errors and Logout

Date: 2026-11-14

## Changes verified

- Exchange order-flow streams reuse a connection when the selected market's alias maps to the same stream. Retired sockets detach their data handlers; a connecting socket closes after its handshake rather than cancelling that handshake.
- TradingView's chart iframe explicitly allows `unload` for its own source origin. This addresses the vendor widget's permissions-policy warnings.
- The disabled bot recalculation timer does not call `/api/bot3/recalculate`. Manual public setup refresh delegates to the public analyser.
- The dashboard's top-right header contains an English **Logout** button. It waits for successful `POST /api/logout`, then opens `/access`. Duplicate clicks are ignored while the request is pending. A failed logout keeps the dashboard open and allows retry.
- Updated asset version strings load the corrected dashboard scripts and button styles.

## Verification performed

- `node --test tests/dashboard-runtime.test.cjs tests/dashboard-panels.test.cjs tests/indicator-price-feed.test.cjs`: **26 passed, 0 failed**.
- `.venv/Scripts/python.exe -m pytest tests/test_webauth.py tests/test_api_only.py -q`: **10 passed, 5 subtests passed**. One dependency warning concerns the deprecated `websockets.legacy` module.
- An isolated ASGI request checked that `/api/logout` returns HTTP 200, revokes a real in-memory session token, expires the session cookie with `Max-Age=0`, and sends `Cache-Control: private, no-store`. It used a temporary database and did not change the running server's sessions or configuration.
- The existing local browser preview at `http://127.0.0.1:8784/dashboard` loaded the updated scripts. The Logout button was visible in the header at the upper right, and the chart iframe's `unload` permission was enabled.
- After clearing captured logs and reloading the dashboard, none of the three errors shown in the attachment reappeared during this check. The browser made no `/api/bot3/recalculate` request.
- Clicking Logout in the browser produced `POST /api/logout → 200` and `GET /access → 200`. The access page loaded successfully.

## Scope

This was a focused verification of the attached console errors and the new Logout flow. It does not establish that every external market provider will remain available or that every project feature has been retested.
