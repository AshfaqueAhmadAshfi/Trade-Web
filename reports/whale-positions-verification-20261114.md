# Whale · Open Positions — repair and verification

Verified on 2026-11-14. Scanner version: 2. Browser assets: `20261114_whales3`.

## Why the panel stayed empty

- Port 8777 returned 404 for the whale API and `/dashboard`, while `/` served the dashboard and current static assets.
- Port 8785 exposed an older scanner that discovered only recent traders.
- The frontend skipped its initial request in a hidden desktop preview.
- Recent-trade-only discovery missed older, large held positions.

## Repair

- Discover candidates from recent Hyperliquid fills and Hypurrscan's public USDC/HYPE top-holder lists. Token balances never establish positions.
- Verify each candidate's exact contract using Hyperliquid `clearinghouseState`. Display wallet, BUY/SELL, average entry, current size/value and check time.
- Qualify at $100,000; retain same-side reductions below the threshold. Remove only after a valid snapshot confirms exit, zero size or a nonqualifying reversal. Failed checks retain last-verified holdings.
- Rotate quiet candidates; check up to 24 wallets with four concurrent requests per scan, and track at most 24 holdings per contract. Discovery lists cache for 15 minutes.
- Save server holdings atomically in `data/whale_positions.json`. The direct browser adapter caches candidates and holdings in localStorage. Restored holdings remain stale until rechecked.
- Always load the initial snapshot, including hidden previews. Later polling pauses while hidden and resumes while visible, about 15 seconds after a completed scan. Exit detection can require multiple scans.
- Use direct public CORS APIs when an older server lacks the route or current scanner. Remember fallback mode rather than repeating the 404 each poll. HTTP 401/403 does not trigger the fallback.
- Preserve selected-market isolation, late-response protection and the white dashboard layout. Include public wallet links and Hypurrscan attribution.

## Checks actually performed

- `pytest tests/test_whale_positions.py -q`: **21 passed**.
- `node --test tests/whale-positions.test.cjs tests/public-whale-feed.test.cjs`: **19 passed**.
- Focused Ruff checks, Python compilation and both whale JavaScript syntax checks: passed.
- Fresh version-2 Python adapter using real APIs: **ok**, `xyz:GOLD`, 200 candidates, 16 wallets checked, **BUY 2 / SELL 3**, in 2.67 seconds.
- Live holdings saved to a temporary cache and loaded into a new adapter: all five retained and stale when rechecking was deliberately unavailable.
- Main browser at <http://127.0.0.1:8777/> loaded the new assets, received the legacy whale route's 404, used public feeds and displayed **LIVE**, **BUY 2 / SELL 3**, entries and values. Network logs confirmed 200 responses from both Hypurrscan lists and Hyperliquid checks. This initial scan completed while the page was hidden; holdings were also saved locally.
- Earlier browser check on 8785 confirmed fallback from its older scanner.
- Real exits were not induced. Fixtures verified confirmed exits, reductions, invalid responses, reloads and market switches. No broad project suite or new screenshot review was performed for this repair.

Live examples at approximately 20:29 Asia/Dhaka; values change:

| Wallet | Side | Average entry | Position value |
|---|---|---:|---:|
| `0x5b5d51203a0f9079f8aeb098a6523a13f298c060` | SELL | 4185.46 | $24,861,332 |
| `0xb83de012dba672c76a7dbbbf3e459cb59d7d6e36` | SELL | 4216.96 | $23,699,062 |
| `0x33ad48ed92e3e91a98278f0f7456eae6eafa516e` | SELL | 3885.11 | $431,364 |
| `0xbe3f79ae0ab3294aaa3230c1155e912c05b6a55b` | BUY | 3892.42 | $271,368 |
| `0x28473085ba4aa761eb541914f50a75dd685cd47b` | BUY | 3914.62 | $118,028 |

## Data limits and server state

Wallet addresses are public identities; company and individual order names are not disclosed. These feeds cannot expose every worldwide company's or private broker customer's positions. Gold/Silver use Hyperliquid `xyz:GOLD` / `xyz:SILVER` perpetual exposure, which differs from chart spot instruments. Supported native crypto contracts require exact provider metadata matches. Unsupported FX/cross markets explicitly show no coverage. Coverage is partial.

Existing processes were not restarted; the main browser now works through the public fallback. Backend version 2 was verified separately against live data. A normal future app restart loads the updated server implementation. The browser tab shows port 8777; the preexisting preview registration belongs to 8784. Earlier automatic approval review rejected a combined shell restart with “blocked by policy”; the working fallback avoided that action. No server-stop action was repeated.

Provider references:

- [Hyperliquid perpetual API](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals)
- [Hypurrscan API schema](https://api.hypurrscan.io/openapi.json)
- [Hypurrscan attribution](https://hypurrscan.io/about)
