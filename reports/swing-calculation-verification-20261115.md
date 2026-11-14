# BUY / SELL swing calculation verification

Updated the shared engine used by **NEXT SELL SWING AI** and **NEXT BUY SWING AI**.

## Result

- Scores use completed candle closes. Moving intrabar quotes cannot change the
  closed-candle structure vote. At least 60 valid bars seed EMA50 and MACD.
- Fibonacci retracements require a high/low impulse in the correct chronological
  direction. Local pivots need two completed confirmation bars on their right.
- Entry clusters require swing structure and at least one different indicator
  family. Overlapping windows with a maximum width of 0.42 M5 ATR prevent a
  greedy partition from hiding valid SELL or BUY confluence.
- Stops can use the nearest protected confirmed M5 pivot, with the existing
  volatility floor. Targets respect fresh opposing structure. Stale higher-frame
  levels and rejected candle refreshes cannot reconfirm an entry.
- Missing short intraday intervals block confirmation. Non-crypto gaps of at
  least one hour are permitted as session breaks; this is a duration-based
  allowance, not a full exchange holiday/session calendar. Recognized continuous
  crypto markets reject gaps.
- A new observed quote must cross the entry under the confirmed direction.
  Quote gaps above 15 seconds, entry overruns above 0.2 ATR, or observed reward
  per unit of risk below 1.2 leave the setup unfilled.
- **Swing Entry** shows the planned level while armed and the observed quote
  when running. Reward/risk and duration use that observed entry. The target and
  stop remain frozen. History records both planned and observed entry.
- Revised unfilled structures update the entry mode, duration and entry window
  together. Old calculation-version cached plans are recalculated.
- One shared arbiter still permits at most one active direction. These are
  dashboard model signals; no broker order is placed.

## Checks actually run

**46 focused JavaScript checks passed** on the final source:

```powershell
node --test tests/swing-directions.test.cjs
# 38 passed, 0 failed

node --test --test-name-pattern='swing|quotes alone|late old-market|a gap before entry' tests/news-swing.test.cjs
# 8 selected checks passed, 0 failed
```

Fixtures verify known EMA/Wilder ATR/RSI/MACD/Bollinger arithmetic, mirrored BUY
and SELL brackets, chronological Fibonacci anchors, pivot confirmation, missing
candles, session breaks, skipped entries, observed reward/risk, timer revision,
cache validation, quote freshness and the existing direction locks/outcomes.
Initial failing checks were repaired; the final affected checks above passed.
No broad backend suite or full dashboard interaction suite was run.

The running source preview is **http://127.0.0.1:8786/dashboard**, on owned Python
process **3180**, bound to **127.0.0.1:8786**. HTTP returned the dashboard with the
updated asset version. The existing server on 8777 belongs to another preview
thread and was left running.

Browser DOM/state inspection confirmed both panel names, **SWING ENTRY** labels,
the current script asset and WAIT states with blank levels when fresh intraday
confirmation is unavailable. No live running entry was established in the
browser; BUY/SELL entry transitions were verified using deterministic fixtures.
No screenshot or visual layout review was performed. Console inspection returned
content-visibility rendering messages; it is not a full-site error audit.

These checks establish implementation behavior and arithmetic, not future
prediction accuracy or profitability. Original versions of the edited files
are retained in `reports/swing-calculation-before-20261115/`.
