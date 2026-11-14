# Next Sell / Buy Swing AI — implementation and verification

Verified on 2026-11-14. Assets: `20261114_dualswing2`.

## Result

- The existing left panel is **NEXT SELL SWING AI**.
- **NEXT BUY SWING AI** sits immediately below Running News on the right.
- Both show the same six plan fields: entry, target, stop, reward/risk, duration
  and exit time, plus a phase/timer, signal strength and indicator evidence.
- Both panels read one engine and one active plan. The opposite panel shows
  WAIT and clears its entry/target/stop/timer fields. A running swing retains its
  side and levels despite an opposite vote, until observed target/stop or time
  exit. A confirmed reversal can replace an unfilled setup.
- Both panels may wait. Renaming the board does not force a signal or manufacture
  a BUY against the current evidence. These are model estimates, not placed trades.

## Admission and data handling

- Analyze EMA9/21/50, momentum, swing structure, RSI14, MACD12/26/9, Bollinger,
  VWAP and stochastic evidence over M1/M5/M15/H1/H4/D1.
- Require a fresh TradingView quote, closed/valid candles, at least 55% model
  signal strength, M5 alignment with M15 or H1, two nearby confluence levels,
  correctly ordered target/stop prices and reward/risk of at least 1.2.
- A recent miss raises that direction's requirements to 65% strength and three
  levels for 20 minutes. Performance history is stored per market and displayed
  separately for BUY and SELL. Strength is not a calibrated win probability.
- Reject stale/foreign/future quotes and wrong-market candle responses. Validate,
  sort and deduplicate closed candles. Expired candle checks cannot rearm a setup
  just because the quote is fresh. Feed requests have 12-second timeouts.
- Share the request pipeline: six candle requests initially, three fast frames
  on later cycles and a full refresh every third cycle. No second pipeline is
  created for the BUY panel. The hidden preview can load its initial TV quote.

## Checks actually run

**24 focused tests passed**:

- 13 direction/arbitration checks in `tests/swing-directions.test.cjs` (the final
  added SELL-running test was run separately after the first 12 passed).
- 11 affected existing swing/quote/liquidity checks in `tests/news-swing.test.cjs`.
- JavaScript syntax and whitespace checks passed. The direction test also checks
  panel placement and unique HTML IDs.

Fixtures confirmed actual bullish and bearish admission, both direction locks,
target/stop release, unfilled reversal, neutral/weak inputs, stale data, correct
bracket ordering, source validation, timeout recovery, shared requests and
separate histories. No real trade was opened/closed and no predictive accuracy
or profitable outcome was established by these implementation tests.

Main browser: <http://127.0.0.1:8777/>. Text and computed layout checks confirmed
the two names, direct BUY placement below Running News, matching white glass
surfaces, six BUY plan fields and no horizontal overflow at 1280px and 390px.
The existing liquidity panel retained its 260px height. Live refresh returned a
fresh TradingView price of 3884.685 and a SELL vote; entry confluence was missing,
so both panels correctly displayed WAIT. This did not simulate a BUY in the
production browser. The viewport was restored to 1600px afterward.

Console history still contained legacy 404/authentication and provider WebSocket
messages from earlier server/browser sessions. This was not a full-project audit.
No new screenshot or native-fullscreen verification was performed for this change.
