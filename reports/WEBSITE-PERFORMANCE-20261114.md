# SoftradeX website performance check — 2026-11-14

Changes cover the access page and white dashboard. Existing market matching, stale-quote protection, public-feed behaviour and controls were preserved.

## Changes

- Access orbit uses direct transforms, caps position updates at 30 per second, and pauses when hidden, offscreen, hovered or manually paused. Reduced-motion preferences are respected.
- Google font styles load without blocking the page controls. Existing font choices and fallback fonts remain.
- Dashboard state polls run sequentially. Hidden tabs skip painting and retain the latest calendar/state for restoration.
- Closed News drawers defer their large calendar DOM. Opening the drawer renders the complete list in batches of at most 24 rows. Relative times update without rebuilding the list.
- Live execution tapes retain unchanged rows and format only newly inserted records. Market keys prevent rows from one instrument being reused for another.
- Indicator pane dimensions come from ResizeObserver, avoiding a forced page layout on every quote. Hidden tabs skip drawing.
- Redundant nested blur passes were removed; offscreen lower sections and News rows can skip rendering.
- Closed News drawers become hidden and release pointer input immediately, even while their slide transition finishes.
- News does not request an empty market during catalogue initialization.

## Checks

- 63 existing frontend checks had passed before the final focused edits; 6 new performance checks passed.
- After the live-tape edits: 11 performance/runtime checks passed.
- After the closed-drawer edit: 6 drawer lifecycle checks passed.
- After the indicator resize edit: 6 instrument/freshness checks passed.
- After the empty-market guard: 31 news/swing checks passed.
- Syntax checks passed for the affected scripts. Git whitespace checks passed.
- All 48 local asset references in the dashboard and 14 in the access page exist.
- Visible headless Chrome checked desktop (1280 × 900) and mobile-width (390 × 844) layouts and interactions.

- access page has English content and a centred access button
- orbit pause keeps cards still
- mobile access page has no horizontal overflow
- dashboard defers the closed News list
- live tapes preserve unchanged rows, remove expired rows and reset market keys
- all current economic News rows remain available
- News enters fullscreen
- closing fullscreen News restores scrolling and releases the overlay
- mobile dashboard header keeps Logout in the viewport
- mobile Escape closes fullscreen News
- Logout returns to the access page
- no uncaught page-script errors

- Current News rows loaded: 460.
- Uncaught page-script errors: 0.
- Recorded invalid HTTP responses (400/403/404/422/500): 0.

## Five-second frame samples

These are requestAnimationFrame intervals in an isolated headless Chrome session with real live feeds, not a controlled hardware benchmark. Startup, resizing and provider work can affect the samples.

| Page | Frame interval p95 | Long tasks (>50 ms) | Longest task |
|---|---:|---:|---:|
| desktop access | 16.9 ms | 2 | 99 ms |
| mobile access | 16.9 ms | 0 | 0 ms |
| desktop dashboard | 33.3 ms | 5 | 589 ms |
| mobile dashboard | 16.9 ms | 5 | 562 ms |

The access animation and main navigation checks passed. Dashboard samples still contain longer tasks during live-page activity; these results do not establish uninterrupted 60 FPS or zero lag. Public provider availability and embedded TradingView loading remain dependent on external services. The earlier shared preview recorded a TradingView loading timeout; a timeout banner and cached/unavailable feed states remain possible.

Raw results: [site-smoothness-results-20261114.json](site-smoothness-results-20261114.json).
Check runner: [verify-site-smoothness.py](verify-site-smoothness.py).

Local preview: http://127.0.0.1:8784/ (owned launcher PID 12704; listener PID 7344). No deployment or Git commit was made.
