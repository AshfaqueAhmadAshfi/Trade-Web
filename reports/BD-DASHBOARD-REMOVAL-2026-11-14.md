# BD dashboard removal — 2026-11-14

The active application source no longer includes the Bangladesh / DSE dashboard.
The main trading dashboard keeps its existing layout and market features.

## Removed

- Dedicated files: `backend/bd_feed.py`, `web/bd.html`, `web/bd-app.js`,
  `web/bd.css`, `web/glass-bd.css` and the cached BD Python bytecode.
- The main page's BD Stock Market Access card and its shared stylesheet rules.
- `/bd`, `/bd.html`, `/api/bd/watch` and `/api/bd/state` route registrations.
- The chart catalogue's BD dispatcher and the DSE candle, tick, metadata and
  volume adapters in `backend/chart_feed.py`.
- BD-specific shared terminal references and currency formatting.
- The deleted feature's regression test, runtime probe entries and README paragraph.
- A search of active backend, frontend, tests and tools found no remaining BD
  dashboard integrations. Bengali locale and timezone support remains present.

Changed CSS and terminal JavaScript have fresh asset version parameters.

## Verification

- `pytest tests/test_chart_feed.py tests/test_api_only.py tests/test_runtime_regressions.py -q --disable-warnings --tb=short`:
  **40 passed, 5 subtests passed**, with one warning.
- `python tools/check_wiring.py`: passed.
- `node --check web/softradex-terminal.js`: passed.
- Targeted source/HTML check: 4 Python files parsed; the main HTML page's
  651 IDs, 41 asset references and one inline script checked without errors.
- HTTP removal checks: 11 expected responses passed. Main page, health and chart
  catalogue returned 200; removed pages, APIs and static assets returned 404.
- Final loopback preview checks also confirmed `/api/state` returned 200 in
  public mode and the removed BD page/API returned 404.
- Browser check: main dashboard visible, login view hidden, zero BD Access cards
  and zero BD links. This was a targeted DOM/accessibility check, not a screenshot
  review or a complete market-feed interaction test.
- HTTP evidence: `reports/codex-bd-removal-http-results.json`.

## Preview and existing copies

Updated local preview: <http://127.0.0.1:8783/>. The preview server explicitly
uses a loopback HOST so the desktop tool's inherited PORT does not classify
this local preview as public hosting.

The pre-existing user server on port 8777 was not restarted. Restart it to load
the backend changes. Previous changes remain uncommitted.

Historical audit snapshots and reports, the old installer staging directory,
and previously generated ZIP/EXE packages were not rewritten or rebuilt. They
can still contain the old BD implementation; the removal applies to the active
source and the updated preview.
