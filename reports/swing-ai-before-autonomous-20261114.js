/* NEXT SELL / BUY SWING AI - two direction-only boards, one shared swing plan.
   --------------------------------------------------------------------------
   Everything it needs is computed from live public data, every few seconds:

     candles    M1 · M5 · M15 · H1 · H4 · D1  (/api/chart/candles, 140 bars)
     price      TradingView's shared quote   (independent of indicator visibility)
     flow       orderflow:update             (12 venue tapes + Binance)
     levels     window.TvSetups.state()      (day / week / month extremes)

   Per timeframe it scores eight reads (backend/market_ai.py's
   engine plus three more), so one timeframe can never call a side on a hunch:

     EMA9 / EMA21 separation        trend
     5-candle momentum vs ATR       thrust
     20-candle swing break          structure
     Wilder RSI14                   stretch
     MACD 12/26/9 vs signal         momentum
     Bollinger 20/2 position        mean reversion
     VWAP (volume weighted)         institutional bias
     Stochastic 14/3                exhaustion

   The six timeframes then vote with the AI's own weights (0.8 → 3.0) and the
   confidence is alignment x participation, nudged by the live venue flow.

   From that read the board builds the trade:
     PERFECT SWING  the confluence price - where swing level, EMA21, VWAP,
                    Bollinger band and the 0.618 retrace agree; the cluster
                    with the most weight on the pullback side of price wins
     TARGET / STOP  measured move (0.618 x impulse or 1.6 x ATR) with the stop
                    behind the structure, and the R:R between them
     TIMER          the next M5 close starts the swing; the duration is the
                    distance divided by how far one M5 candle carries in this
                    session (London/NY overlap moves ~30% more than Asia), and
                    the same clock counts down to the exit once it is running.
   -------------------------------------------------------------------------- */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };

  var TFS = [
    { key: 'M1', tf: '1m', minutes: 1, weight: 0.8 },
    { key: 'M5', tf: '5m', minutes: 5, weight: 1.0 },
    { key: 'M15', tf: '15m', minutes: 15, weight: 1.5 },
    { key: 'H1', tf: '1h', minutes: 60, weight: 2.0 },
    { key: 'H4', tf: '4h', minutes: 240, weight: 2.5 },
    { key: 'D1', tf: '1d', minutes: 1440, weight: 3.0 }
  ];
  var EMA_FAST = 9, EMA_SLOW = 21, EMA_TREND = 50;
  var RSI_N = 14, ATR_N = 14, MOMENTUM_BARS = 5, SWING = 20;
  var BB_N = 20, BB_K = 2, STOCH_N = 14, STOCH_SMOOTH = 3;
  var MACD_FAST = 12, MACD_SLOW = 26, MACD_SIGNAL = 9;
  var ATR_MOMENTUM = 0.25, EMA_TOL = 0.05, RSI_BULL = 58, RSI_BEAR = 42;
  var SIDE_SCORE = 2, MIN_BARS = 40;
  var MIN_CONFIDENCE = 55, MIN_RR = 1.2;
  var BASE_MS = 5 * 60 * 1000;        // the M5 candle the plan is timed on
  var CANDLES_MS = 30000;             // re-read the candles (one small burst)
  var PRICE_MS = 4000;                // follow the live price
  var REBUILD_MS = 30000;             // pause after a finished swing
  var FAIL_REBUILD_MS = 4000;         // a miss is re-calculated at once
  var MAX_ETA_MIN = 240, MIN_ETA_MIN = 5;
  var LOG_KEY = 'softradex.swing.log';

  var symbol = '';
  var price = 0;
  var updatedAt = 0;
  var reads = {};         // key -> timeframe read
  var vote = null;        // { side, score, confidence, reasons }
  var plan = null;
  var flowBias = 0;       // 0-100 buy share from the venue tapes
  var candleBusy = false;
  var priceBusy = false;
  var marketGeneration = 0;
  var candleBars = {};
  var candleSeenAt = {};
  var structureAt = 0;
  var quoteMaxAge = 15000;
  var tvInstrument = '';
  var lastLevels = [];    // TvSetups day/week/month extremes
  var candleRound = 0;    // rotates the slow timeframes
  var planNote = '';      // why there is no plan right now
  var log = [];           // [{ t, side, kind }] last calls, newest last
  var flowAt = 0;
  var BOARDS = [{id: 'swing-ai-board', prefix: 'sai-', side: 'SELL'},
    {id: 'buy-swing-ai-board', prefix: 'sbi-', side: 'BUY'}];

  /* ---------------------------------------------------------------- maths */
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function px(v) {
    var n = Number(v);
    if (!isFinite(n) || n <= 0) return '—';
    return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function num(v, d) { var n = Number(v); return isFinite(n) ? n.toFixed(d) : '—'; }
  function clock(ms) {
    ms = Math.max(0, Math.round(ms / 1000));
    var m = Math.floor(ms / 60), s = ms % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }
  function hhmm(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  function cleanSymbol(v) { return String(v || '').replace(/m$/, ''); }
  function mean(a) { var s = 0, i; for (i = 0; i < a.length; i++) s += a[i]; return a.length ? s / a.length : 0; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function ema(values, n) {
    if (!values.length) return 0;
    if (values.length < n || n <= 1) return mean(values);
    var k = 2 / (n + 1), e = mean(values.slice(0, n)), i;
    for (i = n; i < values.length; i++) e = values[i] * k + e * (1 - k);
    return e;
  }

  function rsi(closes, n) {
    n = n || RSI_N;
    if (closes.length < n + 1) return 50;
    var gains = 0, losses = 0, i, d;
    for (i = 1; i <= n; i++) { d = closes[i] - closes[i - 1]; if (d > 0) gains += d; else losses -= d; }
    var ag = gains / n, al = losses / n;
    for (i = n + 1; i < closes.length; i++) {
      d = closes[i] - closes[i - 1];
      ag = (ag * (n - 1) + Math.max(d, 0)) / n;
      al = (al * (n - 1) + Math.max(-d, 0)) / n;
    }
    if (al <= 0) return ag > 0 ? 100 : 50;
    return 100 - (100 / (1 + ag / al));
  }

  function atr(highs, lows, closes, n) {
    n = n || ATR_N;
    if (closes.length < n + 1) return 0;
    var trs = [], i;
    for (i = 1; i < closes.length; i++) {
      trs.push(Math.max(highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1])));
    }
    var a = mean(trs.slice(0, n));
    for (i = n; i < trs.length; i++) a = (a * (n - 1) + trs[i]) / n;
    return a;
  }

  function macdOf(closes) {
    if (closes.length < MACD_SLOW + MACD_SIGNAL) return null;
    var line = [], i, fast, slow;
    // walk the series so the histogram has a history to compare against
    for (i = MACD_SLOW; i <= closes.length; i++) {
      var slice = closes.slice(0, i);
      fast = ema(slice, MACD_FAST);
      slow = ema(slice, MACD_SLOW);
      line.push(fast - slow);
    }
    var sig = ema(line, MACD_SIGNAL);
    var last = line[line.length - 1];
    var prev = line.length > 1 ? line[line.length - 2] : last;
    return { line: last, signal: sig, hist: last - sig, rising: last > prev };
  }

  function bollinger(closes) {
    if (closes.length < BB_N) return null;
    var win = closes.slice(-BB_N);
    var mid = mean(win);
    var varr = win.reduce(function (s, v) { return s + (v - mid) * (v - mid); }, 0) / win.length;
    var sd = Math.sqrt(varr);
    var up = mid + BB_K * sd, low = mid - BB_K * sd;
    var last = closes[closes.length - 1];
    return {
      mid: mid, up: up, low: low,
      pctB: up > low ? (last - low) / (up - low) * 100 : 50,
      width: mid > 0 ? (up - low) / mid * 100 : 0
    };
  }

  // VWAP over whatever bars we hold (140 M5 bars ~ 11.6 hours of tape). It is
  // the price the day's volume is actually sitting at - the pullback magnet.
  function vwapOf(rows) {
    var pv = 0, vol = 0, i;
    for (i = 0; i < rows.length; i++) {
      var r = rows[i];
      var v = Number(r[5]) || 0;
      if (v <= 0) continue;
      pv += ((Number(r[2]) + Number(r[3]) + Number(r[4])) / 3) * v;
      vol += v;
    }
    return vol > 0 ? pv / vol : 0;
  }

  function stochOf(highs, lows, closes) {
    if (closes.length < STOCH_N + STOCH_SMOOTH) return null;
    var ks = [];
    for (var i = STOCH_N - 1; i < closes.length; i++) {
      var hh = Math.max.apply(null, highs.slice(i - STOCH_N + 1, i + 1));
      var ll = Math.min.apply(null, lows.slice(i - STOCH_N + 1, i + 1));
      ks.push(hh > ll ? (closes[i] - ll) / (hh - ll) * 100 : 50);
    }
    var k = ks[ks.length - 1];
    var d = mean(ks.slice(-STOCH_SMOOTH));
    return { k: k, d: d };
  }

  /* -------------------------------------------------------- one timeframe */
  function read(bars, last, key) {
    var rows = (bars || []).filter(function (b) {
      return Array.isArray(b) && isFinite(Number(b[2])) && isFinite(Number(b[3])) && isFinite(Number(b[4]));
    });
    if (rows.length < MIN_BARS) {
      return { key: key, ready: false, score: 0, verdict: 'NEUTRAL', atr: 0, reasons: ['not enough closed candles'] };
    }

    var highs = rows.map(function (b) { return Number(b[2]); });
    var lows = rows.map(function (b) { return Number(b[3]); });
    var closes = rows.map(function (b) { return Number(b[4]); });
    var close = closes[closes.length - 1];
    var ref = last > 0 ? last : close;

    var eF = ema(closes, EMA_FAST);
    var eS = ema(closes, EMA_SLOW);
    var eT = ema(closes, EMA_TREND);
    var r = rsi(closes);
    var a = atr(highs, lows, closes);
    var swingHigh = Math.max.apply(null, highs.slice(-(SWING + 1), -1));
    var swingLow = Math.min.apply(null, lows.slice(-(SWING + 1), -1));
    var idx = Math.max(0, closes.length - 1 - MOMENTUM_BARS);
    var momentum = close - closes[idx];
    var macd = macdOf(closes);
    var bb = bollinger(closes);
    var vwap = vwapOf(rows);
    var stoch = stochOf(highs, lows, closes);

    var score = 0, reasons = [];

    var sep = eF - eS, tol = Math.max(a * EMA_TOL, 1e-9);
    if (sep > tol && close > eS) { score += 1; reasons.push('EMA9 > EMA21'); }
    else if (-sep > tol && close < eS) { score -= 1; reasons.push('EMA9 < EMA21'); }

    var thr = a * ATR_MOMENTUM;
    if (thr > 0 && momentum > thr) { score += 1; reasons.push('momentum up'); }
    else if (thr > 0 && momentum < -thr) { score -= 1; reasons.push('momentum down'); }

    if (ref > swingHigh) { score += 1; reasons.push('above swing high'); }
    else if (ref < swingLow) { score -= 1; reasons.push('below swing low'); }

    if (r >= RSI_BULL) { score += 1; reasons.push('RSI ' + Math.round(r)); }
    else if (r <= RSI_BEAR) { score -= 1; reasons.push('RSI ' + Math.round(r)); }

    if (macd) {
      if (macd.hist > 0 && macd.line > 0) { score += 1; reasons.push('MACD +'); }
      else if (macd.hist < 0 && macd.line < 0) { score -= 1; reasons.push('MACD -'); }
    }

    if (bb) {
      if (bb.pctB > 55 && close > bb.mid) { score += 1; reasons.push('above BB mid'); }
      else if (bb.pctB < 45 && close < bb.mid) { score -= 1; reasons.push('below BB mid'); }
    }

    if (vwap > 0) {
      if (close > vwap) { score += 1; reasons.push('over VWAP'); }
      else { score -= 1; reasons.push('under VWAP'); }
    }

    if (stoch) {
      if (stoch.k > stoch.d && stoch.k < 80) { score += 1; reasons.push('Stoch up'); }
      else if (stoch.k < stoch.d && stoch.k > 20) { score -= 1; reasons.push('Stoch down'); }
    }

    return {
      key: key,
      ready: true,
      score: score,
      verdict: score >= SIDE_SCORE ? 'BUY' : score <= -SIDE_SCORE ? 'SELL' : 'NEUTRAL',
      rsi: r, atr: a, emaFast: eF, emaSlow: eS, emaTrend: eT,
      momentum: momentum, swingHigh: swingHigh, swingLow: swingLow, close: close,
      macd: macd, bb: bb, vwap: vwap, stoch: stoch,
      reasons: reasons
    };
  }

  /* ---------------------------------------------------- the weighted vote */
  function combine(list, bias) {
    var bull = 0, bear = 0, bullW = 0, bearW = 0, totalW = 0, voters = 0, score = 0;
    TFS.forEach(function (tf) {
      var row = list[tf.key];
      if (!row || !row.ready) return;
      totalW += tf.weight;
      score += row.score;
      if (row.score >= SIDE_SCORE) { bull += tf.weight * row.score; bullW += tf.weight; voters++; }
      else if (row.score <= -SIDE_SCORE) { bear += tf.weight * Math.abs(row.score); bearW += tf.weight; voters++; }
    });
    if (!voters) return { side: 'NEUTRAL', score: 0, confidence: 0, reasons: ['the AI has no reading yet'] };

    var side = 'NEUTRAL', sideW = 0, reasons = [];
    if (bullW > bearW && bullW >= 2.0) { side = 'BUY'; sideW = bullW; reasons.push('timeframes lean BUY'); }
    else if (bearW > bullW && bearW >= 2.0) { side = 'SELL'; sideW = bearW; reasons.push('timeframes lean SELL'); }
    else reasons.push('timeframes disagree');

    var align = Math.abs(bull - bear) / Math.max(1e-9, bull + bear);
    var participation = totalW > 0 ? sideW / totalW : 0;
    var conf = 100 * align * participation;
    if (side === 'BUY' && bias > 50) conf += Math.min(5, (bias - 50) * 0.2);
    if (side === 'SELL' && bias > 0 && bias < 50) conf += Math.min(5, (50 - bias) * 0.2);
    if (side === 'NEUTRAL') conf = Math.min(20, conf);

    return {
      side: side, score: score, voters: voters,
      confidence: Math.max(0, Math.min(100, Math.round(conf))),
      reasons: reasons
    };
  }

  /* ------------------------------------------------- the confluence price */
  // Where the swing should be bought / sold: every level the trade can lean on,
  // clustered by price. The heaviest cluster on the pullback side of the live
  // price wins, and its weighted mean is the "perfect swing" price.
  function confluence(side, livePrice) {
    var m5 = reads.M5, m15 = reads.M15, h1 = reads.H1;
    if (!m5 || !m5.ready) return null;
    var a = m5.atr;
    if (!(a > 0)) return null;

    var buy = side === 'BUY';
    var span = m5.swingHigh - m5.swingLow;
    var cands = [];
    function add(v, w, label) {
      v = Number(v);
      if (isFinite(v) && v > 0) cands.push({ v: v, w: w, label: label });
    }

    if (buy) {
      add(m5.swingLow, 1.4, 'M5 swing low');
      add(m15 && m15.ready && m15.swingLow, 1.6, 'M15 swing low');
      add(h1 && h1.ready && h1.swingLow, 1.8, 'H1 swing low');
      add(m5.emaSlow, 1.2, 'EMA21');
      add(m5.emaTrend, 1.0, 'EMA50');
      add(m5.bb && m5.bb.low, 1.1, 'BB lower');
      add(m5.vwap, 1.3, 'VWAP');
      if (span > 0) add(m5.swingHigh - span * 0.618, 1.5, '0.618 fib');
      if (span > 0) add(m5.swingHigh - span * 0.5, 1.0, '0.5 fib');
    } else {
      add(m5.swingHigh, 1.4, 'M5 swing high');
      add(m15 && m15.ready && m15.swingHigh, 1.6, 'M15 swing high');
      add(h1 && h1.ready && h1.swingHigh, 1.8, 'H1 swing high');
      add(m5.emaSlow, 1.2, 'EMA21');
      add(m5.emaTrend, 1.0, 'EMA50');
      add(m5.bb && m5.bb.up, 1.1, 'BB upper');
      add(m5.vwap, 1.3, 'VWAP');
      if (span > 0) add(m5.swingLow + span * 0.618, 1.5, '0.618 fib');
      if (span > 0) add(m5.swingLow + span * 0.5, 1.0, '0.5 fib');
    }
    // the day / week / month extremes the setups board is already tracking
    lastLevels.forEach(function (lv) {
      var label = String(lv.label || '');
      var isLow = /low/i.test(label);
      if (buy && isLow) add(lv.price, 1.2, label);
      if (!buy && !isLow) add(lv.price, 1.2, label);
    });

    if (!cands.length) return null;

    // keep the levels that are still tradeable: on the pullback side of price
    // and within three ATRs of it
    var band = a * 0.42;
    var usable = cands.filter(function (c) {
      var near = Math.abs(c.v - livePrice) <= a * 3.2;
      var sideOk = buy ? c.v <= livePrice + a * 0.35 : c.v >= livePrice - a * 0.35;
      return near && sideOk;
    });
    if (!usable.length) {
      usable = cands.slice().sort(function (x, y) {
        return Math.abs(x.v - livePrice) - Math.abs(y.v - livePrice);
      }).slice(0, 3);
    }

    usable.sort(function (x, y) { return x.v - y.v; });
    var clusters = [], cur = null;
    usable.forEach(function (c) {
      if (!cur || Math.abs(c.v - cur.mean) <= band) {
        if (!cur) { cur = { items: [], sum: 0, wsum: 0 }; clusters.push(cur); }
        cur.items.push(c);
        cur.sum += c.v * c.w;
        cur.wsum += c.w;
        cur.mean = cur.sum / cur.wsum;
      } else {
        cur = { items: [c], sum: c.v * c.w, wsum: c.w, mean: c.v };
        clusters.push(cur);
      }
    });

    clusters.forEach(function (cl) {
      var dist = Math.abs(cl.mean - livePrice);
      // weight first, then proximity - a far cluster has to be much stronger
      cl.score = cl.wsum - (dist / a) * 0.25;
      cl.dist = dist;
    });
    clusters.sort(function (x, y) { return y.score - x.score; });
    var best = clusters[0];
    if (!best) return null;

    return {
      entry: best.mean,
      touches: best.items.length,
      labels: best.items.map(function (i) { return i.label; }).slice(0, 4),
      weight: best.wsum,
      dist: best.dist
    };
  }

  /* ------------------------------------------------------------- timing */
  function sessionFactor() {
    var h = new Date().getUTCHours();
    if (h >= 13 && h < 17) return { f: 1.3, name: 'LONDON + NEW YORK' };
    if (h >= 7 && h < 13) return { f: 1.1, name: 'LONDON' };
    if (h >= 17 && h < 21) return { f: 1.05, name: 'NEW YORK' };
    if (h >= 21 || h < 1) return { f: 0.85, name: 'LATE NEW YORK' };
    return { f: 0.8, name: 'ASIA' };
  }

  function nextBarOpen(now) { return Math.ceil(now / BASE_MS) * BASE_MS; }

  function shortSession(name) {
    return name === 'LONDON + NEW YORK' ? 'LDN/NY'
      : name === 'LATE NEW YORK' ? 'LATE NY'
        : name === 'NEW YORK' ? 'NY' : name;
  }

  /* ------------------------------------------------------- track record --- */
  // Every finished call is kept, so a miss cannot be forgotten: the next plan
  // is only issued once the confluence is strong enough (see buildPlan).
  function loadLog() {
    try {
      var raw = JSON.parse(localStorage.getItem(LOG_KEY + '.' + symbol) || '[]');
      log = Array.isArray(raw) ? raw.slice(-20) : [];
    } catch (e) { log = []; }
  }

  function pushLog(kind) {
    if (!plan || plan.logged) return;
    plan.logged = true;
    log.push({ t: Date.now(), side: plan.side, entry: Math.round(plan.entry * 100) / 100, kind: kind });
    log = log.slice(-20);
    try { localStorage.setItem(LOG_KEY + '.' + symbol, JSON.stringify(log)); } catch (e) { /* private mode */ }
  }

  function scoreLine(side) {
    var last = log.filter(function (r) { return (!side || r.side === side) && (r.kind === 'hit' || r.kind === 'miss'); }).slice(-5);
    if (!last.length) return '';
    var hits = last.filter(function (r) { return r.kind === 'hit'; }).length;
    return 'last ' + last.length + ': ' + hits + 'H / ' + (last.length - hits) + 'M';
  }

  function maybeRebuild(now) {
    if (!quoteFresh(now)) return;
    planPriceCrossed(now);
    if (!planIsStale(now)) { retune(); return; }
    var failed = !!(plan && (plan.hit || plan.doneAt));
    // a wrong call is re-calculated immediately, on freshly loaded candles
    if (failed && !candleBusy) loadCandles();
    buildPlan(now);
  }

  function currentFlow(now) { return flowAt && now - flowAt <= quoteMaxAge ? flowBias : 50; }
  function readingFresh(key, now) {
    var tf = TFS.find(function (item) { return item.key === key; });
    var bars = candleBars[key], at = candleSeenAt[key];
    if (!tf || !at || !bars || !bars.length || now - at > (tf.minutes < 60 ? 90000 : 180000)) return false;
    var last = Number(bars[bars.length - 1][0]);
    if (last < 1e11) last *= 1000;
    var end = last + tf.minutes * 60000;
    return end <= now && now - end <= Math.max(120000, tf.minutes * 120000);
  }
  function setupBlock(now, v) {
    if (!quoteFresh(now)) return 'Waiting for a fresh TradingView quote';
    if (!v || (v.side !== 'BUY' && v.side !== 'SELL')) return 'Timeframes disagree · both directions wait';
    if (v.confidence < MIN_CONFIDENCE) return 'Signal strength below ' + MIN_CONFIDENCE + '% · waiting for agreement';
    var sign = v.side === 'BUY' ? 1 : -1;
    function aligned(key) {
      return reads[key] && reads[key].ready && readingFresh(key, now) && reads[key].score * sign >= SIDE_SCORE;
    }
    if (!aligned('M5')) return 'Waiting for fresh M5 confirmation of the ' + v.side + ' swing';
    if (!aligned('M15') && !aligned('H1')) return 'Waiting for M15 or H1 confirmation of the ' + v.side + ' swing';
    return '';
  }
  function bracket(side, entry, m5) {
    var buy = side === 'BUY', a = m5.atr, span = Math.max(0, m5.swingHigh - m5.swingLow);
    var move = Math.max(a * 1.6, span * 0.618), risk = Math.max(a, span * 0.382);
    var target = entry + (buy ? move : -move), stop = entry - (buy ? risk : -risk);
    var structural = buy ? m5.swingLow - a * 0.2 : m5.swingHigh + a * 0.2;
    if (structural > 0 && (buy ? structural < entry : structural > entry) && Math.abs(structural - entry) <= a * 1.6) stop = structural;
    var rr = Math.abs(target - entry) / Math.abs(stop - entry);
    if (![entry, target, stop, rr].every(function (n) { return Number.isFinite(n) && n > 0; }) ||
        !(buy ? stop < entry && entry < target : target < entry && entry < stop) || rr < MIN_RR) return null;
    return {target: target, stop: stop, rr: rr};
  }

  function buildPlan(now) {
    var m5 = reads.M5;
    var v = vote || { side: 'NEUTRAL', confidence: 0, score: 0, reasons: [] };
    var blocked = setupBlock(now, v);
    if (!m5 || !m5.ready || blocked) {
      plan = null;
      planNote = blocked || 'Waiting for candles and a live price';
      return;
    }

    var side = v.side;
    var buy = side === 'BUY';
    var a = m5.atr;
    if (!(a > 0)) { plan = null; planNote = 'no ATR yet'; return; }

    var conf = confluence(side, price);
    if (!conf || conf.touches < 2 || conf.dist > a * 3.2) {
      plan = null; planNote = 'Waiting for two nearby entry levels to agree'; return;
    }
    // A recent miss tightens only that direction, not the opposite panel.
    var previous = log.filter(function (row) { return row.side === side && (row.kind === 'hit' || row.kind === 'miss'); }).slice(-1)[0];
    if (previous && previous.kind === 'miss' && now - Number(previous.t) < 20 * 60000 &&
        (conf.touches < 3 || v.confidence < 65)) {
      plan = null;
      planNote = 'last call missed - waiting for real confluence (levels ' + (conf ? conf.touches : 0) +
        ', confidence ' + v.confidence + '%)';
      return;
    }
    planNote = '';
    var entry = conf.entry;

    var entryMode = (buy ? price < entry : price > entry) ? 'breakout' : 'retrace';

    var bounds = bracket(side, entry, m5);
    if (!bounds) { plan = null; planNote = 'Waiting for valid target/stop levels and at least 1 : ' + MIN_RR + ' risk/reward'; return; }

    var sess = sessionFactor();
    var speedPerMin = Math.max(1e-9, (a / 5) * sess.f);       // price per minute
    var etaMin = clamp(Math.round(Math.abs(bounds.target - entry) / speedPerMin), MIN_ETA_MIN, MAX_ETA_MIN);
    var startAt = nextBarOpen(now);

    plan = {
      side: side,
      entry: entry,
      perfect: conf ? conf.entry : entry,
      touches: conf ? conf.touches : 1,
      labels: conf ? conf.labels : [],
      target: bounds.target,
      stop: bounds.stop,
      rr: bounds.rr,
      atr: a,
      etaMin: etaMin,
      session: sess.name,
      confidence: v.confidence,
      score: v.score,
      created: now,
      priceAt: price,
      quoteAt: updatedAt,
      priceSource: 'TradingView',
      startAt: startAt,
      endAt: startAt + etaMin * 60000,
      running: false,
      entryMode: entryMode,
      hit: false,
      hitAt: 0,
      doneAt: 0,
      reasons: (m5.reasons || []).slice(0, 3).concat(v.reasons || [])
    };
  }

  function planIsStale(now) {
    if (!plan) return true;
    if (plan.hit || plan.doneAt) return now - (plan.hitAt || plan.doneAt) > FAIL_REBUILD_MS;
    if (plan.running) return false;
    if (setupBlock(now, vote)) return true;
    if (vote && vote.side !== 'NEUTRAL' && vote.side !== plan.side) return true;     // AI flipped
    if (now > plan.endAt + REBUILD_MS) return true;                                  // window over
    return false;
  }

  /* The price moving is not a new plan: the countdown must keep running while
     the entry / target / stop follow the market. This re-clusters the levels
     and keeps every timestamp, so the timer never resets under the reader. */
  function retune() {
    if (!plan || plan.hit || plan.doneAt || plan.running) return;
    var m5 = reads.M5;
    if (!m5 || !m5.ready || !(price > 0)) return;

    var conf = confluence(plan.side, price);
    if (!conf || conf.touches < 2 || conf.dist > m5.atr * 3.2) { plan = null; planNote = 'Entry confluence no longer confirmed'; return; }
    var a = m5.atr;
    var entry = conf.entry;
    var bounds = bracket(plan.side, entry, m5);
    if (!bounds) { plan = null; planNote = 'Updated entry no longer has valid risk/reward'; return; }

    plan.perfect = entry;
    plan.entry = entry;
    plan.touches = conf.touches;
    plan.labels = conf.labels;
    plan.target = bounds.target;
    plan.stop = bounds.stop;
    plan.rr = bounds.rr;
    plan.priceAt = price;
    plan.quoteAt = updatedAt;
    plan.atr = a;
    plan.confidence = vote.confidence;
    plan.score = vote.score;
  }

  function planPriceCrossed(now) {
    if (!plan || !quoteFresh(now) || plan.hit || plan.doneAt) return;
    var buy = plan.side === 'BUY';
    if (now >= plan.endAt) {
      plan.doneAt = now;
      plan.outcome = plan.running ? 'timeout' : 'unfilled';
      pushLog(plan.outcome);
      return;
    }
    if (!plan.running) {
      var reached = plan.entryMode === 'retrace'
        ? (buy ? price <= plan.entry : price >= plan.entry)
        : (buy ? price >= plan.entry : price <= plan.entry);
      if (!reached) return;
      // A gap past the outcome boundaries is an unfilled setup, not a win.
      if (price >= Math.max(plan.target, plan.stop) || price <= Math.min(plan.target, plan.stop)) {
        plan.doneAt = now;
        plan.outcome = 'unfilled';
        pushLog('unfilled');
        return;
      }
      plan.running = true;
      plan.startAt = now;
      plan.endAt = now + plan.etaMin * 60000;
      plan.startedQuoteAt = updatedAt;
      return;
    }
    if (updatedAt <= (plan.startedQuoteAt || 0)) return;
    if (buy ? price >= plan.target : price <= plan.target) {
      plan.hit = true;
      plan.hitAt = now;
      pushLog('hit');       // logged where it happens, not only on the next paint
      return;
    }
    if (buy ? price <= plan.stop : price >= plan.stop) {
      plan.doneAt = now;
      pushLog('miss');
    }
  }

  /* ------------------------------------------------------------ painting */
  function factorsHtml() {
    var m5 = reads.M5;
    if (!m5 || !m5.ready) return '';
    var chips = [];
    chips.push(['RSI', Math.round(m5.rsi), m5.rsi >= 58 ? 'up' : m5.rsi <= 42 ? 'down' : 'flat']);
    if (m5.macd) {
      var hist = m5.macd.hist;
      chips.push(['MACD', (hist >= 0 ? '+' : '') + num(hist, Math.abs(hist) < 1 ? 3 : 2),
        hist >= 0 ? 'up' : 'down']);
    }
    if (m5.bb) chips.push(['BB', Math.round(m5.bb.pctB) + '%', m5.bb.pctB >= 55 ? 'up' : m5.bb.pctB <= 45 ? 'down' : 'flat']);
    if (m5.vwap) chips.push(['VWAP', px(m5.vwap), m5.close >= m5.vwap ? 'up' : 'down']);
    if (m5.stoch) chips.push(['STOCH', Math.round(m5.stoch.k), m5.stoch.k >= 80 ? 'down' : m5.stoch.k <= 20 ? 'up' : 'flat']);
    var bias = currentFlow(Date.now());
    chips.push(['FLOW', flowAt && Date.now() - flowAt <= quoteMaxAge ? Math.round(bias) + '% B' : 'NO LIVE FLOW', bias >= 52 ? 'up' : bias <= 48 ? 'down' : 'flat']);
    chips.push(['SESS', shortSession(sessionFactor().name), 'flat']);
    return chips.map(function (c) {
      return '<span class="sai-chip ' + c[2] + '"><i>' + esc(c[0]) + '</i>' + esc(String(c[1])) + '</span>';
    }).join('');
  }

  // Both panels are projections of ONE plan, never two independent orders.
  function sideView(side, now) {
    now = now || Date.now();
    var matching = plan && plan.side === side;
    var open = plan && !plan.hit && !plan.doneAt;
    var activeSide = quoteFresh(now) && open ? plan.side : 'NONE';
    return {side: side, active: activeSide === side, activeSide: activeSide,
      lockedBy: activeSide !== 'NONE' && activeSide !== side ? activeSide : '',
      plan: matching ? plan : null,
      status: !quoteFresh(now) ? 'paused' : matching ? plan.hit ? 'complete' : plan.doneAt ? 'finished' : plan.running ? 'running' : 'armed'
        : activeSide !== 'NONE' ? 'blocked' : 'waiting'};
  }
  function paint(now) {
    now = now || Date.now();
    if (plan && !plan.hit && !plan.doneAt) planPriceCrossed(now);
    if (plan && !plan.logged && (plan.hit || plan.doneAt)) pushLog(plan.outcome || (plan.hit ? 'hit' : 'miss'));
    BOARDS.forEach(function (board) { paintBoard(now, board); });
  }
  function paintBoard(now, board) {
    var root = $(board.id);
    if (!root) return;
    var view = sideView(board.side, now), plan = view.plan;
    function field(name) { return $(board.prefix + name); }
    root.setAttribute('data-active-side', view.active ? board.side : 'NONE');

    var symEl = field('symbol');
    if (symEl) symEl.textContent = cleanSymbol(symbol) || 'XAUUSD';
    var priceEl = field('price');
    if (priceEl) priceEl.textContent = px(price);
    var updEl = field('updated');
    if (updEl) updEl.textContent = updatedAt ? hhmm(updatedAt) : '—';

    var v = vote || { side: 'NEUTRAL', confidence: 0, score: 0, reasons: [] };
    var sideEl = field('side'), confEl = field('conf'), scoreEl = field('score');
    if (sideEl) {
      var buy = view.active && board.side === 'BUY', sell = view.active && board.side === 'SELL';
      sideEl.textContent = buy ? '▲ BUY' : sell ? '▼ SELL' : '◆ WAIT';
      sideEl.className = 'sai-side ' + (buy ? 'buy' : sell ? 'sell' : 'wait');
    }
    if (confEl) confEl.textContent = (view.active ? Number(plan.confidence) || 0 : 0) + '% signal strength';
    if (scoreEl) scoreEl.textContent = 'market score ' + (v.score > 0 ? '+' : '') + v.score;

    var fac = field('factors');
    if (fac) fac.innerHTML = factorsHtml();

    var srcEl = field('src');
    if (srcEl) {
      var bits = [quoteFresh(now) ? 'TradingView · ' + tvInstrument + ' · LIVE reference'
        : 'TradingView quote unavailable / stale · calculation paused'];
      bits.push('Public candle structure projected to this live price');
      srcEl.className = 'sai-src ' + (quoteFresh(now) ? 'ok' : 'warn');
      var line = scoreLine(board.side);
      if (line) bits.push(line);
      srcEl.textContent = bits.join('  ·  ');
    }

    var phaseEl = field('phase'), clockEl = field('clock'), barEl = field('bar');
    var labelEl = field('phase-label');
    var entryEl = field('entry'), tgtEl = field('target'), stopEl = field('stop');
    var rrEl = field('rr'), etaEl = field('eta'), exitEl = field('exit');
    var whyEl = field('why');

    function setBar(f) { if (barEl) barEl.style.width = clamp(f, 0, 1) * 100 + '%'; }
    function setPhase(text, cls, label) {
      if (phaseEl) { phaseEl.textContent = text; phaseEl.className = 'sai-phase ' + cls; }
      if (labelEl) { labelEl.textContent = label; labelEl.className = 'sai-plabel ' + cls; }
      if (barEl) barEl.className = 'sai-fill ' + cls;
    }

    if (!quoteFresh(now) || !plan) {
      setPhase(!quoteFresh(now) ? 'WAITING FOR LIVE TRADINGVIEW PRICE' : view.lockedBy
        ? view.lockedBy + ' SWING ACTIVE · ' + board.side + ' WAITING' : 'WAITING FOR ' + board.side + ' SETUP', 'wait', view.lockedBy ? 'WAIT' : 'NO TRADE');
      if (clockEl) clockEl.textContent = '--:--';
      setBar(0);
      [entryEl, tgtEl, stopEl, rrEl, etaEl, exitEl].forEach(function (el) { if (el) el.textContent = '—'; });
      if (whyEl) {
        whyEl.textContent = !quoteFresh(now) ? 'No fallback to an old candle or a different price feed.'
          : view.lockedBy ? 'One swing at a time. ' + view.lockedBy + ' owns the active entry/exit plan; ' + board.side + ' stays on WAIT.'
            : planNote || 'Waiting for confirmed ' + board.side + ' conditions · both directions share one arbiter';
      }
      return;
    }

    if (plan.hit) {
      setPhase('TARGET HIT · SWING COMPLETE', 'done', 'DONE');
      if (clockEl) clockEl.textContent = clock(plan.hitAt - plan.startAt);
      setBar(1);
    } else if (plan.doneAt) {
      setPhase(plan.outcome === 'timeout' ? 'TIME EXIT · SWING COMPLETE'
        : plan.outcome === 'unfilled' ? 'ENTRY NOT FILLED · RE-CALCULATING'
        : 'STOPPED OUT · RE-CALCULATING', 'fail', plan.outcome ? 'EXPIRED' : 'FAILED');
      if (clockEl) clockEl.textContent = clock(plan.doneAt - plan.startAt);
      setBar(1);
    } else if (!plan.running) {
      setPhase(now < plan.startAt ? 'SWING STARTS IN' : 'WAITING FOR ENTRY', 'wait', 'ARMED');
      if (clockEl) clockEl.textContent = clock(plan.startAt - now);
      setBar((now - plan.created) / Math.max(1, plan.startAt - plan.created));
    } else {
      setPhase('SWING RUNNING · OPEN ' + clock(now - plan.startAt), 'live', 'RUNNING');
      if (clockEl) clockEl.textContent = clock(plan.endAt - now);
      setBar((now - plan.startAt) / Math.max(1, plan.endAt - plan.startAt));
    }

    if (entryEl) entryEl.textContent = px(plan.entry);
    if (tgtEl) tgtEl.textContent = px(plan.target);
    if (stopEl) stopEl.textContent = px(plan.stop);
    if (rrEl) rrEl.textContent = '1 : ' + num(plan.rr, 2);
    if (etaEl) etaEl.textContent = plan.etaMin + ' min';
    if (exitEl) exitEl.textContent = hhmm(plan.endAt);
    if (whyEl && price > 0) {
      var toEntry = Math.abs(price - plan.entry) / Math.max(1e-9, price) * 100;
      whyEl.textContent = (plan.touches > 1
        ? plan.touches + ' levels agree (' + (plan.labels || []).join(' · ') + ')'
        : 'structure at ' + px(plan.perfect)) +
        ' · ' + toEntry.toFixed(2) + '% from price · ' + plan.session + ' session · ATR ' + px(plan.atr);
    }
  }

  /* --------------------------------------------------------------- feeds */
  function quoteFresh(now) {
    return price > 0 && updatedAt > 0 && now - updatedAt <= quoteMaxAge && updatedAt <= now + 5000;
  }

  // Public candles may be a proxy (gold uses PAXG). Preserve their relative
  // structure/volatility, but express every price level on the live TV scale.
  // An old candle close is never allowed to supply the current price.
  function rebuildReads() {
    if (!quoteFresh(Date.now())) return;
    Object.keys(candleBars).forEach(function (key) {
      if (!readingFresh(key, Date.now())) {
        reads[key] = {key: key, ready: false, score: 0, verdict: 'NEUTRAL', atr: 0, reasons: ['Candle history is stale']};
        return;
      }
      var bars = candleBars[key];
      var close = bars.length ? Number(bars[bars.length - 1][4]) : 0;
      if (!(close > 0)) return;
      var scale = price / close;
      var projected = bars.map(function (b) {
        var row = b.slice();
        for (var i = 1; i <= 4; i++) row[i] = Number(row[i]) * scale;
        return row;
      });
      reads[key] = read(projected, price, key);
    });
    vote = combine(reads, currentFlow(Date.now()));
    lastLevels = [];
    if (window.TvSetups && typeof window.TvSetups.state === 'function') {
      var st = window.TvSetups.state();
      // The daily setup levels also come from public candles. Translate their
      // distances to TV rather than importing absolute prices from that feed.
      if (st && st.symbol === symbol && Number(st.price) > 0 && Array.isArray(st.levels)) {
        lastLevels = st.levels.map(function (lv) {
          return { label: lv.label, price: Number(lv.price) * price / Number(st.price) };
        });
      }
    }
  }

  function acceptQuote(q) {
    if (!q || q.symbol !== symbol || !q.tv_symbol || !Number.isFinite(Number(q.price)) || !(Number(q.price) > 0)) return false;
    var at = Number(q.at) || Number(q.updated) * 1000;
    if (!(at > 0) || at > Date.now() + 5000 || Date.now() - at > quoteMaxAge || at < updatedAt) return false;
    if (at === updatedAt && Number(q.price) === price) return true;
    price = Number(q.price);
    updatedAt = at;
    tvInstrument = q.tv_symbol;
    rebuildReads();
    var now = Date.now();
    maybeRebuild(now);
    paint(now);
    return true;
  }

  function loadPrice() {
    if (priceBusy || !symbol) return;
    if (acceptQuote(window.SOFT_TV_QUOTE)) return;
    var host = window.TvChartHost;
    if (!document.hidden && host && typeof host.refreshQuote === 'function') { host.refreshQuote(); return; }
    var requestedSymbol = symbol, generation = marketGeneration;
    priceBusy = true;
    fetchJSON('/api/chart/tvquote?symbol=' + encodeURIComponent(requestedSymbol))
      .then(function (t) {
        if (generation !== marketGeneration || requestedSymbol !== symbol || !t || !t.ok) return;
        acceptQuote(t);
      })
      .catch(function () { /* keep the last price */ })
      .finally(function () { if (generation === marketGeneration) priceBusy = false; });
  }

  function fetchJSON(url) {
    var controller = new AbortController();
    var timeout = setTimeout(function () { controller.abort(); }, 12000);
    return fetch(url, {cache: 'no-store', signal: controller.signal})
      .then(function (response) { return response.ok ? response.json() : null; })
      .finally(function () { clearTimeout(timeout); });
  }
  function closedBars(rows, tf, now) {
    var unique = Object.create(null), duration = tf.minutes * 60000;
    (rows || []).forEach(function (b) {
      if (!Array.isArray(b) || b.length < 5) return;
      var time = Number(b[0]);
      if (time < 1e11) time *= 1000;
      var values = b.slice(1, 5).map(Number);
      if (!Number.isFinite(time) || time <= 0 || time + duration > now ||
          !values.every(function (n) { return Number.isFinite(n) && n > 0; }) ||
          values[1] < Math.max(values[0], values[2], values[3]) || values[2] > Math.min(values[0], values[3])) return;
      var volume = Number(b[5]);
      unique[time] = [time].concat(values, [Number.isFinite(volume) && volume > 0 ? volume : 0]);
    });
    return Object.keys(unique).map(function (key) { return unique[key]; })
      .sort(function (a, b) { return a[0] - b[0]; }).slice(-140);
  }

  function loadCandles() {
    if (candleBusy || !symbol) return;
    var requestedSymbol = symbol, generation = marketGeneration;
    candleBusy = true;
    // The fast timeframes are re-read every cycle; H1 / H4 / D1 change slowly,
    // so reading them every third cycle keeps the same vote with half the
    // requests on the single-worker backend.
    var slow = { H1: 1, H4: 1, D1: 1 };
    var list = candleRound % 3 === 0
      ? TFS
      : TFS.filter(function (tf) { return !slow[tf.key]; });
    candleRound++;
    var jobs = list.map(function (tf) {
      return fetchJSON('/api/chart/candles?symbol=' + encodeURIComponent(requestedSymbol) +
        '&tf=' + tf.tf + '&count=140')
        .then(function (d) { return { key: tf.key, bars: d && d.ok !== false && (!d.symbol || d.symbol === requestedSymbol) && Array.isArray(d.bars)
          ? closedBars(d.bars, tf, Date.now()) : [] }; })
        .catch(function () { return { key: tf.key, bars: [] }; });
    });
    Promise.all(jobs).then(function (results) {
      if (generation !== marketGeneration || requestedSymbol !== symbol) return;
      var changed = false;
      results.forEach(function (res) {
        if (res.bars.length >= MIN_BARS) {
          candleBars[res.key] = res.bars; candleSeenAt[res.key] = Date.now(); changed = true;
        }
      });
      if (changed) structureAt = Date.now();
      rebuildReads();
      var now = Date.now();
      maybeRebuild(now);
      paint(now);
    }).finally(function () { if (generation === marketGeneration) candleBusy = false; });
  }

  function setSymbol(next) {
    var s = String(next || '');
    if (!s || s === symbol) return;
    symbol = s;
    marketGeneration++;
    priceBusy = false;
    candleBusy = false;
    candleRound = 0;
    price = 0;
    updatedAt = 0;
    tvInstrument = '';
    candleBars = {};
    candleSeenAt = {};
    structureAt = 0;
    lastLevels = [];
    flowBias = 0;
    flowAt = 0;
    reads = {};
    vote = null;
    plan = null;
    planNote = '';
    log = [];
    loadLog();
    paint();
    loadPrice();
    loadCandles();
  }

  function init() {
    if (!BOARDS.some(function (board) { return !!$(board.id); })) return;
    var term = window.SoftradeXTerminal;
    symbol = (term && typeof term.getCurrentSymbol === 'function') ? String(term.getCurrentSymbol() || '') : '';
    if (!symbol) symbol = 'XAUUSDm';

    window.addEventListener('orderflow:update', function (ev) {
      var d = (ev && ev.detail) || {};
      if (d.symbol !== symbol) return;
      var buy = Number(d.buy), sell = Number(d.sell);
      if (!Number.isFinite(buy) || !Number.isFinite(sell) || buy < 0 || sell < 0) return;
      if (buy + sell > 0) { flowBias = (buy / (buy + sell)) * 100; flowAt = Date.now(); }
      vote = combine(reads, currentFlow(Date.now()));
      // the flow tapes tick about once a second: keep the countdown smooth and
      // let a finished plan be re-calculated without waiting for the price poll
      var now = Date.now();
      maybeRebuild(now);
      paint(now);
    });
    window.addEventListener('chart:market', function (ev) {
      var d = (ev && ev.detail) || {};
      setSymbol(d.symbol || (d.meta && d.meta.symbol) || '');
    });
    window.addEventListener('chart:refresh', function () { loadPrice(); loadCandles(); });
    window.addEventListener('chart:tv-quote', function (ev) { acceptQuote(ev.detail); });

    loadLog();
    paint();
    loadPrice();
    loadCandles();
    setInterval(function () { if (!document.hidden) loadPrice(); }, PRICE_MS);
    setInterval(function () { if (!document.hidden) loadCandles(); }, CANDLES_MS);
    setInterval(function () {
      if (document.hidden) return;
      var now = Date.now();
      maybeRebuild(now);
      paint(now);
    }, 1000);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) { loadPrice(); loadCandles(); }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.SwingAI = {
    refresh: function () { loadPrice(); loadCandles(); },
    structure: function () {
      return { symbol: symbol, at: structureAt, source: 'public', frames: {
        M5: (candleBars.M5 || []).map(function(b) { return b.slice(); }),
        M15: (candleBars.M15 || []).map(function(b) { return b.slice(); })
      } };
    },
    // Pure candle analysis shared with the independent all-market daily reads.
    analyzeCandles: read,
    state: function () {
      return { symbol: symbol, price: price, updatedAt: updatedAt, priceSource: 'TradingView',
        tvSymbol: tvInstrument, fresh: quoteFresh(Date.now()), vote: vote, plan: plan, reads: reads, flowBias: currentFlow(Date.now()),
        activeSide: sideView('BUY').activeSide,
        panels: {SELL: sideView('SELL'), BUY: sideView('BUY')} };
    }
  };
})();
