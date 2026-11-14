# Dashboard startup and Running News repair

The two supplied screenshots showed an uninitialized server clock, empty session
and AI direction panels, and missing headline rows in Running News.

## Causes and changes

- `start.bat` set an environment variable named `PORT`. The backend deliberately
  treats a PORT-only launch as hosted and binds to `0.0.0.0`, which enables its
  dashboard session requirement. This desktop had no configured password. The
  original 8777 process therefore returned 401 for the state API while public
  exchange streams continued to show trades. The desktop launcher now also sets
  `HOST=127.0.0.1`; the explicit login policy and hosted authentication remain
  intact.
- An unauthorized initial state previously only set a footer message. The
  dashboard now opens its existing password dialog at signed-out startup or
  after session expiry, with duplicate-dialog protection. Its existing verified
  password submission restarts state loading.
- A hidden page now loads its first state before pausing background polling.
  Previously a hidden first launch or reload could indefinitely retain empty
  panels until the tab became visible.
- Running News computed recent headline rows but rendered scheduled releases
  alone. It now includes relevant recent headlines, sorted newest first, and
  counts releases and headlines separately. Headline rows show WATCH LEFT,
  source attribution, and an explicit monitoring label. This countdown makes
  no claim that publication confirms a price impact.
- Monitoring ends at the earlier of the existing impact window and any explicit
  headline reading deadline. The one-second timer removes expired monitoring
  rows. Longer-lived headlines stay in the Next 24H reading list until their own
  reading deadline. Existing five-second popup behavior remains in place.
- Updated the affected script versions and README. Existing unrelated checkout
  edits were preserved; no Git staging, commit or deployment was performed.

## Verification

- `tests/dashboard-runtime.test.cjs`: 14 passing tests, including signed-out
  startup, expired-session prompts, verified login recovery and a hidden initial
  state load with background polling paused afterwards.
- `tests/news-swing.test.cjs`: 39 passing tests after updating the old
  release-only expectation. Includes recent headline rendering, newest-first
  ordering, countdown ticks, exact monitoring expiry, a shorter explicit
  deadline, reading-list retention and popup behavior.
- The desktop launch environment with HOST=127.0.0.1 and PORT=8777 resolves to
  loopback and does not require login with the existing local configuration.
- Original process: `/api/auth` required a session and `/api/state` returned 401.
  Reloading its updated frontend correctly displayed the password dialog.
- Corrected source is running in a detached process at
  http://127.0.0.1:8785/dashboard. Launcher PID 18668, listener PID 19100.
  Its health and state APIs returned successfully without the accidental gate.
- The live browser state showed an advancing server clock, four populated
  session rows, Next Event and impacted-market content, AI Direction rows,
  82 relevant reading headlines and three monitored Running News headlines.
  Provider availability and these counts can change with later refreshes.
- A final reload while `document.hidden` was true populated the first snapshot,
  four session rows, the next event and the 102-market AI board. The loaded
  scripts were app runtime6 and Running News headlines3; monitored headline
  countdowns included their explicit deadline attributes.
- At a 1440px browser viewport, document width was 1429px. No application
  rendering exception was seen in the sampled console; verbose messages about
  content-visibility were present. This was a focused check, not an exhaustive
  review of all third-party feeds.
- Visual screenshot capture could not be completed: Freebuff reported that the
  preview had not been drawn while the window was minimized or covered. A
  malformed initial capture was removed. No verified screenshot is delivered.

## Running server limitation

Automatic approval review rejected stopping/restarting the existing 8777
server with the reason `blocked by policy`. It remains running. The repaired
app is usable on 8785 now; to return to 8777, close the original app terminal or
press Ctrl+C there, then launch the corrected `start.bat`.

The detached preview's launcher PID and logs are saved in
`dashboard-running-fix-server.pid`, `dashboard-running-fix.stdout.log` and
`dashboard-running-fix.stderr.log` in this report directory. The task-only diff
is `dashboard-running-fix-20261114.patch`; its source baseline is preserved in
`dashboard-running-fix-before-20261114-232739`.
