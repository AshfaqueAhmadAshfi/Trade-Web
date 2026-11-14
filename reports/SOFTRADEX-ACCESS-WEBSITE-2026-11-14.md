# SoftradeX access website — 2026-11-14

The root URL now opens a dedicated access website. Its central Access button
opens the existing trading dashboard at `/dashboard`. `/access` is an alias for
the landing page. Existing dashboard authentication and market features are preserved.

## Website

- Dark green and mint design, ten animated feature cards orbiting the central
  Access button, and a Pause / Resume orbit control.
- Responsive layouts, keyboard focus states and reduced motion support.
- Live charts, news, order flow, extreme setups, market pressure, Swing AI,
  sessions, outlook, liquidity and indicators represented around the button.
- System overview, news and market source names, and the creator profile.
- Uses the existing `web/my-image.jpg` photograph. The profile currently uses
  “SoftradeX Creator & Developer”; no personal name was provided.

## WhatsApp

The access page and trading dashboard each include a fixed bottom-right WhatsApp
shortcut to `https://wa.me/8801531817299`, the international form of 01531817299.
The link opens a chat with a prepared message; the visitor presses Send to
deliver it. The website does not submit a message automatically.

The contact script also moves the shortcut into native fullscreen when the
browser supports the chart's Fullscreen API, then restores it to the body on exit.

## Verification

- Access and contact JavaScript syntax passed; existing frontend wiring passed.
- Both HTML pages checked for duplicate IDs and local asset references:
  20 landing-page IDs / 13 assets and 651 dashboard IDs / 44 assets; no errors.
- Twelve HTTP checks passed, including the landing page, `/dashboard`, public
  state API, stylesheet/script/photo assets and the deleted BD page returning 404.
- Browser: clicking central Access navigated to `/dashboard` and showed the
  existing dashboard; exactly one fixed WhatsApp shortcut was present.
- Animation advanced over time; Pause and Resume controls worked.
- Layout checked through DOM measurements at desktop 1280 px, mobile 390 px
  and narrow preview 251 px: no horizontal overflow. Measured orbit cards did
  not overlap at desktop or mobile widths. Portrait loaded successfully.
- The WhatsApp shortcut remained topmost at the bottom-right in the expanded
  chart workspace. Native browser fullscreen was unavailable in this preview,
  so native fullscreen relocation was inspected in code rather than exercised.
- Browser console showed no errors on the access page. This was a DOM and
  interaction review; no screenshot-based visual review or external WhatsApp
  message delivery test was performed.

Preview: <http://127.0.0.1:8784/>
HTTP evidence: `reports/codex-access-http-results.json`.

The pre-existing server on port 8777 must be restarted to load the new routes.
No production deployment or installer rebuild was performed. Changes are uncommitted.
