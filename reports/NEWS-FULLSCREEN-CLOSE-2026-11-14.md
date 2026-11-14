# News fullscreen close fix

Closing the right-hand News drawer left its `fullscreen` class active. Its contents became hidden while the fixed white drawer surface remained across the viewport.

The shared close handler now clears fullscreen mode, resets the button and accessibility state, hides the backdrop and releases scrolling. The close button, Escape, backdrop, rail toggle, session reset and switching to the left drawer all use that cleanup. The fullscreen CSS applies only while the right drawer is open. Updated asset versions load the fix on refresh.

Verification:

- Six regression tests reproduced the stale fullscreen state before the fix and pass after it: `node --test tests/news-drawer.test.cjs`.
- `node --check web/app.js` passed, and the affected tracked files passed `git diff --check`.
- Before the fix, the running browser confirmed that a closed drawer still had `fullscreen`, occupied the viewport and covered its centre while its contents were hidden.
- After the fix, a JavaScript-driven News → Fullscreen → Close sequence ran the real click handlers in the running dashboard. It confirmed fullscreen entry, removal on close, the restored Fullscreen label, hidden backdrop and unlocked scrolling. A subsequent browser geometry/hit-test check confirmed the drawer was offscreen and no longer covered the dashboard.
- The separate pointer-driven browser attempt became unresponsive while opening the live News drawer. The completed browser check used the real handlers as described above; it was not an exhaustive interaction or performance test.

The dashboard colours and layout were not changed.
