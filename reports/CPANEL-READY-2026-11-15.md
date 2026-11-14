# SoftradeX — cPanel upload handoff

প্রস্তুত ZIP: [softradex-cpanel-ready.zip](dist/softradex-cpanel-ready.zip)

নির্দেশিকা: [DEPLOY-CPANEL.md](DEPLOY-CPANEL.md)

Package: 89 files, 920,002 bytes (প্রায় 898 KiB)।

SHA256: `2787f8f750497a2f45f3b7b015a0dfaa66bf7fdaec178e20cdbe1aab1e3b9329`

## সমস্যাগুলো ও সংশোধন

- Screenshot-এর server clock/session/AI blank হওয়ার authentication ও initial
  snapshot সমস্যা সংশোধন। Local launcher loopback host স্পষ্ট করে; hosted
  dashboard password dialog দেখায়। Hidden tab-এ প্রথম snapshot লোড হয়, পরের
  background polling বিরতি নেয়।
- Running News relevant recent headlines দেখায়, আলাদা headline/release counts
  এবং monitoring countdown দেয়। Scheduled release start ও expiry boundary,
  headline reading recency ও impact window আলাদা থাকে। Expired news বাদ যায়।
- cPanel-এর Passenger workers private SQLite-তে hashed sessions, logout,
  expiry এবং login limits share করে। Password rotation পুরোনো session বাতিল করে।
- Passenger-এর আসল WSGI entry point-এর মাধ্যমে ASGI adapter ও hosted auth
  চালু হয়। Trusted Apache HTTPS environment দিয়ে secure cookie scheme ঠিক হয়;
  browser-এ startup traceback প্রকাশ করা হয় না।
- Public mode chart local WebSocket upgrade চেষ্টা না করে HTTP polling নেয়।
  Large execution tape browser-এর public venue feeds থেকে selected market-এর
  $25,000+ executions নেয়; anonymous execution, position ও exit data আলাদা
  করে জানায়। Old market-এর rows নতুন market-এ থাকে না।
- Provider cache writes unique temporary files দিয়ে atomic replace করে;
  Passenger refresh interval ও frontend polling bounded থাকে।
- Password field-এ numeric keyboard বাধ্যবাধকতা সরানো এবং current-password
  autocomplete যোগ করা হয়েছে। Mobile-এ alphanumeric password ব্যবহার করা যায়।
- Chart news readers configuration/login readiness-এর জন্য অপেক্ষা করে,
  login-এ সঙ্গে সঙ্গে refresh করে এবং আগের session-এর in-flight response বাদ
  দেয়। News lifecycle metadata বজায় থাকে। Auxiliary fallback-ও overlapping
  requests আটকায় ও upcoming তালিকা থেকে expired/published rows বাদ দেয়।
- Clean whitelist ZIP স্থানীয় passwords, .env, config, database, caches, logs,
  reports, tests, Git ও virtual environment নেয় না। JS/CSS content hashes দিয়ে
  asset versions তৈরি হয়। Manifest ও exact tested dependency versions আছে।

## যাচাইয়ের প্রমাণ

| Check | Result | Evidence |
|---|---|---|
| Full offline backend suite, cPanel implementation-এর পরে | 362 passed; 11 subtests passed | [test log](reports/cpanel-final-tests-20261114.log) |
| Full offline frontend suite, final readiness edit-এর আগে | 145 passed | একই full test log |
| Final readiness/login/news changes-এর affected frontend checks | 42 passed, including 4 new session/calendar regressions | [focused frontend log](reports/cpanel-final-frontend-20261115.log) |
| Final package boundary/content check | 1 passed | [package test log](reports/cpanel-final-package-20261115.log) |
| Source audit, final readiness edit-এর আগে | 67 Python, 43 JS, 2 HTML; no failures | [static log](reports/cpanel-static-final-20261114.log) |
| Final ZIP build | Python syntax and HTML asset/duplicate-ID validation passed | [build receipt](reports/cpanel-final-build-20261115.json) |
| Dependency health | pip check: no broken requirements | Local installed environment |
| Linux Python 3.11 x86_64 dependency resolution | All 20 required wheels downloaded | [wheel log](reports/cpanel-linux-wheels-20261114.log) |
| Packaged Passenger/WSGI runtime | 40/40 existing routes HTTP 200 | [live runtime JSON](reports/cpanel-live-runtime-20261114.json) |
| Hosted authentication/cache behavior | Eight checks passed: signed-out 401, foreign-Origin 403, accepted login, HttpOnly cookie, unchanged calendar thinning, private/no-store, logout, revoked-session 401 | একই runtime JSON |
| HTTPS WSGI and shared-session regressions | Passed within backend suite: Secure cookie, Apache scheme, cross-process acceptance/revocation/password rotation | Full test log; relevant WSGI/session tests |
| Updated package in browser | First state loaded; clock, four sessions, six AI timeframes, 419 news rows observed | [browser evidence](reports/cpanel-final-browser-20261115.json) |
| Browser signed-out/login/logout | No /api/state request before login; dialog visible; login resumes readers; Logout returns /access | একই browser evidence |
| Gold → BTC market switch | Chart, Binance/venue flow, execution tape and Hyperliquid BTC position panel aligned | একই browser evidence |

Full suites were not rerun unnecessarily after the last frontend edit. The
affected checks above were rerun and the final ZIP rebuilt. One upstream
websockets.legacy deprecation warning occurred in the Python suite.

Browser checks used actual page DOM/runtime. The desktop preview was hidden
(`document.hidden=true`); existing button.click() and form.requestSubmit() were
used for market switching, logout and login. This confirms those event/data
paths; it is not a visible screenshot/layout or physical mobile-keyboard test.

## cPanel setup

1. Hosting-এ Setup Python App / Passenger এবং Python 3.11+ লাগবে। Verified Linux
   dependency resolution Python 3.11-এর জন্য; এটিই প্রথম পছন্দ করুন।
2. Private application root-এ ZIP extract করুন, যেমন /home/USER/softradex।
   backend/config/database public_html-এ রাখবেন না।
3. Application URL domain/subdomain root, যেমন https://dashboard.example.com/।
   /some-folder/ mounted URL সমর্থিত নয়।
4. Startup file passenger_wsgi.py; entry point application।
5. cPanel environment-এ নিজের শক্ত SOFTRADEX_DASHBOARD_PASSWORD দিন। Default
   password নেই। Password source/ZIP/chat-এ লিখবেন না।
6. App virtual environment activate করে python -m pip install -r requirements.txt
   এবং python -m pip check চালান; তারপর Restart।
7. SSL, writable private data/config folders এবং provider outbound HTTPS/WSS
   access নিশ্চিত করুন। Exact TradingView candles-এর backend WSS লাগবে।
8. /api/health, /dashboard login, clock/sessions/news, market switch ও logout
   actual domain-এ পরীক্ষা করুন। Detailed guide-এ troubleshooting আছে।

Update করলে existing data/config/environment রাখুন; নতুন package runtime data
মুছে দেয় না।

## Local preview এবং সীমা

Package preview: http://127.0.0.1:8799/dashboard

- Extracted app: dist/cpanel-preview-20261114/
- Listener PID 12020; launcher PID 6596; reports/cpanel-preview.pid records launcher.
- Logs: [stdout](reports/cpanel-preview.stdout.log), [stderr](reports/cpanel-preview.stderr.log).
- Preview uses a loopback-only test password in the process environment; its
  value is not in this report or the upload ZIP. Use your own password in cPanel.
- Existing 8777/8785 servers were retained. Preview registration conflicted with
  the existing registered server; the new package was opened in the Browser panel
  without replacing that process.

Actual cPanel/domain has not been deployed or verified: no hosting connection was
provided. Outbound provider restrictions, API quotas, provider delays and host
CPU/memory/worker limits still depend on the actual environment. Missing/stale
exact candles should show WAIT/unavailable rather than fabricated signals.

Gold data may use PAXG proxy/Hyperliquid perpetual contracts distinct from the
chart instrument; FX and unsupported contracts can lack public position coverage.
Whale wallet coverage is bounded and partial. Automated broker orders and MT5
account history remain disabled in this public market dashboard.

Existing unrelated checkout edits were preserved. No changes were staged or
committed.
