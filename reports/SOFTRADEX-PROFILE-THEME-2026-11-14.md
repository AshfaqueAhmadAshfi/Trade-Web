# SoftradeX profile, social links and shared theme — 2026-11-14

Follow-up: at the user's request, the dashboard was returned to its previous
white and blue glass theme. Its TradingView and local chart colours were also
restored to light colours. The access website retains its green theme; the
profile and four social links remain on both pages. The shared-theme details
below describe the earlier version.

The access website and trading dashboard now share dark green surfaces, mint
controls and ivory text. Existing dashboard geometry, authentication, market
calculations and provider connections were preserved in this UI update.

## Profile

- Ashfaque Ahmad Ashfi — Developer.
- Computer Science and Engineering student at American International
  University-Bangladesh (AIUB).
- The existing `web/my-image.jpg` portrait is used on the access page and in
  the dashboard's About Me panel.
- The access website and dashboard continue to use English without a
  language or translation button.

## Social shortcuts

Both pages have one fixed, vertical dock at the bottom-right. From top to bottom:

1. Facebook Profile — https://www.facebook.com/ashfak.ashfi
2. GitHub Profile — https://github.com/AshfaqueAhmadAshfi
3. SoftradeX Facebook Page — https://www.facebook.com/softradex
4. WhatsApp — https://wa.me/8801531817299

The two Facebook links have distinct tooltips; the page icon also has an SX
badge. Links open a new tab with `noopener noreferrer`. WhatsApp prepares a
chat to 01531817299; the visitor presses Send to deliver the message.

The dock adapts to small and short screens. The contact script moves the
entire dock into a native fullscreen element and restores it on exit.

## Theme

The shared palette is in `web/palette.css`; the final dashboard colour layer
is `web/dashboard-mint.css`. Dark surfaces also cover pressure gauges, live
tape, sessions, news, AI panels, drawers and modal dialogs. Buy/sell and
warning colours remain distinct, and existing inline data-status colours
are preserved. TradingView is configured with its dark theme. Local canvas
backgrounds and labels were adjusted for dark contrast.

## Checks completed for this update

- JavaScript syntax: contact, TradingView, indicators, terminal, app and
  chart-news scripts all passed `node --check`.
- `tools/check_wiring.py` passed.
- HTML asset and duplicate-ID checks passed: access page has 20 IDs and
  17 asset references; dashboard has 650 IDs and 49 asset references.
- `git diff --check` passed for the changed tracked HTML and JavaScript.
- Live access preview returned HTTP 200. Clicking the central Access link
  navigated to `/dashboard`.
- Browser DOM checks confirmed the name, AIUB education, loaded portrait,
  exact social URLs/order, loaded icons and fixed dock on both pages.
- Desktop and 390px mobile DOM measurements found no page-level horizontal
  overflow. Social buttons measured 60px on desktop and 48px on mobile.
- Dashboard About Me opened with the supplied profile and matching colours.
- In the expanded chart workspace, all four social buttons remained topmost
  and the workspace background matched the access page.
- Representative computed styles confirmed dark surfaces and readable
  foregrounds. Light-theme leftovers found during inspection were corrected.

This was a DOM, style and interaction review, not a screenshot-based visual
review. Native browser fullscreen and external messaging were not exercised.
The preview browser was hidden during a canvas-pixel probe, so actual canvas
painting was not verified; its source colours and TradingView configuration
were checked. Exchange socket-close warnings were captured during reloads;
no JavaScript exception appeared in the inspected console entries.

No full-project suite was rerun for this UI update. The earlier full audit is
documented separately in `reports/CODEX-PROJECT-CHECK-2026-11-14.md`.
No deployment, installer rebuild or Git commit was performed.

Preview: http://127.0.0.1:8784/
Dashboard: http://127.0.0.1:8784/dashboard
