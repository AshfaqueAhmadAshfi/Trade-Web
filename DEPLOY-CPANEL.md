# SoftradeX: cPanel / Passenger deployment

এই app Python FastAPI + static HTML/CSS/JavaScript দিয়ে চলে। Passenger-এর WSGI
adapter ব্যবহার হবে; browser-এর নিজস্ব app data HTTP polling ব্যবহার করে। Public
exchange-এর browser WebSocket আলাদা—সেটি Passenger upgrade নয়।

## 1. Hosting requirements

- cPanel **Setup Python App / Passenger** থাকতে হবে। শুধু PHP/static hosting যথেষ্ট নয়।
- **Python 3.11 বা নতুন** বেছে নিন; 3.12 হলে সেটি ব্যবহার করতে পারেন।
- App একটি **domain বা subdomain-এর root URL**-এ বসান, যেমন
  `https://dashboard.example.com/`। `/some-folder/` mounted URL এই release-এ
  সমর্থিত নয়; frontend `/api` ও `/static` root paths ব্যবহার করে।
- SSL চালু করুন। App root web document root-এর বাইরে রাখুন, যেমন
  `/home/USER/softradex`; private config/database `public_html`-এ রাখবেন না।
- Outbound HTTPS এবং secure WebSocket (port 443) public market providers-এ
  অনুমোদিত হতে হবে। Exact TradingView candles-এর জন্য backend outbound WSS
  প্রয়োজন, যদিও browser-to-Passenger WebSocket প্রয়োজন নেই।
- App user-এর application root-এ `data/` ও `config/` তৈরি/লেখার permission চাই।

## 2. Upload package

প্রস্তুত ZIP: `dist/softradex-cpanel-ready.zip`। File Manager দিয়ে private app root-এ
upload এবং extract করুন। এর মধ্যে `passenger_wsgi.py`, `backend/`, `web/`, পরীক্ষিত
dependency versions-সহ `requirements.txt`, deployment guide ও manifest আছে।

আবার package বানাতে: `.venv/Scripts/python.exe tools/build_cpanel.py`।

Package local passwords, `.env`, local config, database, news cache, tests, Git,
Windows launcher, virtual environment বা reports নেয় না। Static asset-এর version
content hash দিয়ে তৈরি হয়, ফলে update-এর পর পুরোনো JS/CSS আটকে থাকবে না।

## 3. Create the Python application

1. cPanel → **Software → Setup Python App → Create Application**।
2. Python **3.11+**, application root **softradex**।
3. Application URL আপনার domain/subdomain-এর **root**।
4. Startup file: **passenger_wsgi.py**।
5. Application entry point: **application**।
6. Environment variables-এ **SOFTRADEX_DASHBOARD_PASSWORD** দিন—নিজের নতুন,
   শক্ত password। এটি **বাধ্যতামূলক**; app-এ default password নেই। Password
   browser source/ZIP/chat-এ দেবেন না।
7. **SOFTRADEX_MODE=public** দিতে পারেন; Passenger নিজেই public mode ব্যবহার করে।
8. Create করুন, তারপর app root-এ ZIP extract করুন।

পুরোনো PC-এর `config/config.json` কপি করবেন না। এতে private settings বা
`require_login=false` থাকতে পারে। প্রয়োজনীয় market/settings সাইটে নতুন করে দিন।

## 4. Install dependencies and restart

cPanel যে virtual-environment activation command দেখায়, সেটি ব্যবহার করুন।
নিচের USER/path আপনার panel-এর তথ্য দিয়ে বদলাতে হবে:

```bash
source /home/USER/virtualenv/softradex/3.11/bin/activate
cd /home/USER/softradex
python -m pip install -r requirements.txt
python -m pip check
```

তারপর **Restart** চাপুন। Node build, MT5 software, broker credential বা Metatrader
Python package লাগে না। Folder permission সমস্যা হলে app user-এর ownership
ঠিক করুন; directories সাধারণত 755 এবং private files 600/644 যথেষ্ট। 777 দেবেন না।

## 5. Live verification

1. `https://YOUR-DOMAIN/api/health` JSON দেখাবে এবং `ok: true` থাকবে।
2. `/access` বা `/`-এ access website খুলবে; Access চাপলে `/dashboard` খুলবে।
3. Password dialog-এ cPanel-এ দেওয়া password দিয়ে ঢুকুন। Session cookie
   HttpOnly/SameSite হবে, এবং HTTPS-এ Secure।
4. Server clock, চারটি trading session, Next Event, news ও AI rows দেখুন। নিচে
   **http: live (polling)** থাকা স্বাভাবিক। First cold start-এ কিছু সময় লাগতে পারে।
5. Gold থেকে BTC বদলে chart/quote/news/flow/whale coverage একই market-এ আছে দেখুন।
6. Running News-এ সাম্প্রতিক relevant headline monitoring countdown থাকবে;
   scheduled release শুরু হলে running হয়, deadline শেষে সরে যায়।
7. Logout চাপলে access page খুলবে; password ছাড়া private state পড়া যাবে না।

Session ও login rate limit private `data/auth.sqlite3`-এ hashed token দিয়ে shared
হয়। Passenger worker বদলালেও login থাকবে; logout সব worker-এ কার্যকর। Password
বদলালে আগের session invalid হয়। Raw session token database-এ রাখা হয় না।

## 6. Feature scope and provider access

| Feature | cPanel behavior |
|---|---|
| TradingView chart / quotes | Actual provider data; provider delay বা closed market দেখা যেতে পারে |
| Exact candle indicators / Swing AI | TradingView outbound WSS data লাগে; unavailable/stale হলে WAIT |
| Sessions / Next Event / AI Direction | HTTP snapshot ও public data; estimates হিসেবে labelled |
| News / Running News | Calendar/RSS, source status, expiry ও monitoring countdown |
| Venue order flow | Browser public exchange feeds + bounded HTTP fallback/proxies |
| Large execution tape | Selected market-এর $25,000+ verified anonymous venue executions |
| Whale Open Positions | Supported Hyperliquid contracts; bounded public-wallet scans, partial coverage |
| Automated broker orders / MT5 account history | এই public dashboard-এ disabled |

Gold-এর কিছু feeds PAXG proxy/Hyperliquid perpetual, chart instrument থেকে আলাদা।
FX বা unsupported contract-এ coverage না থাকলে app জানায়। Provider blocked বা
rate-limited হলে unavailable/cached/WAIT দেখানো সঠিক; বানানো quote/trade দিয়ে
সব status green করা হয় না। Hosting-এর provider access, CPU, memory ও worker
limits কোড থেকে নিশ্চিত করা যায় না।

## 7. Common deployment problems

| Symptom | Check |
|---|---|
| 500 / app could not start | Private Passenger log; Python version, dependencies, folder permissions |
| ModuleNotFoundError | App virtual environment-এ requirements install, তারপর Restart |
| Password rejected / panels blank | Mandatory password variable, completed login, `/api/auth` ও `/api/health` |
| Login works then disappears | Writable shared `data/auth.sqlite3`, latest files ও app Restart |
| HTTPS login returns 403 | Actual origin, SSL ও Apache/Passenger HTTPS environment; proxy headers দিয়ে bypass করবেন না |
| Static/API 404 | Domain/subdomain root URL ও ZIP directory structure |
| SQLITE unable to open / read-only | App owner ও writable `data/`; actual database delete করবেন না |
| TradingView candles / Swing WAIT | Hosting outbound HTTPS/WSS ও provider restrictions |
| Some exchange/news feeds unavailable | Source status ও provider/network limits |
| Old JS/CSS after upload | New package extract, app Restart, browser hard refresh |

Startup error details browser-এ দেখানো হয় না; private Passenger log-এ থাকে।

## 8. Updating a running site

New ZIP extract করে source/static files replace করুন, প্রয়োজন হলে dependencies
install করুন, তারপর **Restart**। Existing `data/`, `config/` ও environment variables
ধরে রাখুন। First install-এ ZIP empty runtime state দিয়ে শুরু করে; update পুরোনো
database/settings মুছে দেয় না।

একই Passenger path লোকালে চালাতে:

```powershell
.venv/Scripts/python.exe serve_cpanel_local.py --port 8799
```

এই preview-ও hosted authentication ব্যবহার করে; test password environment-এ
দিন। Offline tests: `python tests/run_tests.py`। Syntax/assets audit:
`python tools/audit_project.py`।
