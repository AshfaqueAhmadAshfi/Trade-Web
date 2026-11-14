/* ==========================================================================
   Chart indicators (chart-indicators.js)
   --------------------------------------------------------------------------
   The three Pine Script indicators shipped in /Indicator, ported to this
   dashboard's own engine and drawn as THREE SEPARATE PANES inside the chart
   panel - one study per pane, never mixed on a single surface:

     1. MSB · OB      Indicator/Chart Indicator 1.txt  (EmreKb, Pine v5)
                      candles + zigzag structure, MSB lines/labels and the
                      Bu-OB / Be-OB / Bu-BB / Be-BB boxes.
     2. WaveTrend     Indicator/chart indicator 2.txt  (LazyBear, Pine v4)
                      oscillator pane: WT1 / WT2 with the +-53 / +-60 bands and
                      the WT1-WT2 area.
     3. ICT Killzones Indicator/chart indicator 3.txt  (TFO, Pine v6)
                      candles + Asia/London/NY AM/NY PM session boxes, session
                      high/low pivots (extended until mitigated) and previous
                      day/week high, low and midline levels. The script's stats
                      table and its text_area driven level/opening-price lists
                      are not drawn; everything else follows its defaults.

   Why a port: the hosted TradingView embed refuses custom Pine ("It is not
   possible to add pine scripts to widgets at this time"), and a cross-origin
   iframe cannot be painted into. The panes therefore read the same
   TradingView instrument's /api/chart/tvcandles series and share its bar geometry
   (chart:geometry), so every study lines up with the candles.

   Nothing here invents prices: with no bars the panes stay empty.
   ========================================================================== */
(function () {
  'use strict';

  var STORE_KEY = 'softradex.chart.ind2';   // v2: the study bar now opens with MSB · OB on
  var TF_SECONDS = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 };
  var CANDLE_COUNT = 500;
  var REFRESH_MS = 15000;
  var paneSizes = new WeakMap();
  var paneObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(function (entries) {
    var changed = false;
    entries.forEach(function (entry) {
      var width = Math.round(entry.contentRect.width), height = Math.round(entry.contentRect.height);
      var previous = paneSizes.get(entry.target);
      if (!previous || previous.width !== width || previous.height !== height) {
        paneSizes.set(entry.target, {width: width, height: height});
        changed = true;
      }
    });
    if (changed) schedule();
  }) : null;

  var INDICATORS = [
    {
      id: 'msb',
      label: 'MSB · OB',
      sub: 'Chart Indicator 1 · Market Structure Break & Order Block',
      title: 'Market Structure Break & Order Block (Indicator/Chart Indicator 1.txt) — zigzag MSB, Bu-OB / Be-OB and break blocks'
    },
    {
      id: 'wavetrend',
      label: 'WaveTrend',
      sub: 'chart indicator 2 · WaveTrend [LazyBear]',
      title: 'WaveTrend [LazyBear] (Indicator/chart indicator 2.txt) — WT1 / WT2 with ±53 and ±60 bands'
    },
    {
      id: 'killzones',
      label: 'ICT Killzones',
      sub: 'chart indicator 3 · ICT Killzones & Pivots [TFO]',
      title: 'ICT Killzones & Pivots [TFO] (Indicator/chart indicator 3.txt) — Asia/London/NY session boxes, session pivots, previous day and week levels'
    }
  ];

  var COLORS = {
    background: '#ffffff',
    up: '#089981',
    upFill: 'rgba(8, 153, 129, 0.16)',
    upLine: 'rgba(8, 153, 129, 0.75)',
    down: '#f23645',
    downFill: 'rgba(242, 54, 69, 0.16)',
    downLine: 'rgba(242, 54, 69, 0.75)',
    structure: '#64748b',
    text: '#1f2937',
    muted: '#64748b',
    grid: '#e6edf9'
  };

  /* ------------------------------------------------------------ state ---- */
  var enabled = {};
  (function restore() {
    var saved = null;
    try { saved = localStorage.getItem(STORE_KEY); } catch (e) { /* private mode */ }
    // First visit: the chart opens with the market-structure study already on,
    // so the site lands on candles + MSB / OB instead of a bare chart. A saved
    // choice (including "everything off") is always respected - with no study
    // on, the TradingView chart is what shows.
    if (saved === null) {
      enabled.msb = true;
      savePrefs();
      return;
    }
    try {
      var raw = JSON.parse(saved || '[]');
      if (Array.isArray(raw)) raw.forEach(function (id) { enabled[String(id)] = true; });
    } catch (e) {
      enabled.msb = true;
    }
  })();

  var bars = [];              // [{ t, o, h, l, c, v }] oldest -> newest
  var dataSymbol = '';
  var dataTf = '';
  var dataInstrument = '';
  var dataError = '';
  var barsRequest = null;
  var barsRequestKey = '';
  var livePrice = 0;
  var livePriceAt = 0;
  var dataToken = 0;
  var loading = false;
  var refreshTimer = null;

  var geometry = null;        // chart:geometry (bar slot, price band, pan)
  var stack = null;           // #chart-indicator-stack
  // shared viewport for every pane: how many bars are in view and how far
  // back the reader panned (TradingView style wheel zoom + drag pan)
  // 78 bars fills the pane like a TradingView chart; 140 made every candle a
  // hairline. offset 0 = the newest bar sits on the right edge.
  var view = { bars: 78, offset: 0 };
  var MIN_BARS = 24;
  var MAX_BARS = 420;
  var rafPending = false;
  var toastTimer = null;

  function $(id) { return document.getElementById(id); }

  function anyEnabled() {
    return INDICATORS.some(function (ind) { return enabled[ind.id] === true; });
  }

  function savePrefs() {
    var list = INDICATORS.filter(function (ind) { return enabled[ind.id]; })
      .map(function (ind) { return ind.id; });
    try { localStorage.setItem(STORE_KEY, JSON.stringify(list)); } catch (e) {}
  }

  function currentSymbol() {
    var terminal = window.SoftradeXTerminal;
    if (terminal && typeof terminal.getCurrentSymbol === 'function') {
      return String(terminal.getCurrentSymbol() || '');
    }
    return dataSymbol;
  }

  function currentTf() {
    // softradex-terminal.js exports getInterval(); other builds expose
    // getCurrentInterval(). Reading only one of them left the studies stuck on
    // the timeframe they were first loaded with, so both are accepted here.
    var terminal = window.SoftradeXTerminal || window.BinanceTerminal;
    if (terminal) {
      var tf = '';
      if (typeof terminal.getCurrentInterval === 'function') tf = String(terminal.getCurrentInterval() || '');
      else if (typeof terminal.getInterval === 'function') tf = String(terminal.getInterval() || '');
      if (TF_SECONDS[tf]) return tf;
    }
    return dataTf || '5m';
  }

  function tfSeconds() {
    return TF_SECONDS[dataTf] || TF_SECONDS[currentTf()] || 300;
  }

  /* ------------------------------------------------------------- data ---- */
  function mappedInstrument(symbol) {
    var host = window.TvChartHost;
    var terminal = window.SoftradeXTerminal || window.BinanceTerminal;
    var meta = terminal && terminal.MARKETS && terminal.MARKETS[symbol];
    return host && typeof host.symbolFor === 'function' ? host.symbolFor(symbol, meta || {}) : '';
  }

  function acceptQuote(q) {
    if (!dataInstrument || !q || q.symbol !== dataSymbol || q.tv_symbol !== dataInstrument ||
        currentSymbol() !== dataSymbol || currentTf() !== dataTf) return false;
    var price = Number(q.price), at = Number(q.at), now = Date.now();
    if (!(price > 0) || !isFinite(price) || !at || at < livePriceAt ||
        now - at > 25000 || at > now + 2000) return false;
    livePrice = price;
    livePriceAt = at;
    // Scanner timestamps are fetch times, not exchange tick times. Update only
    // an existing open candle; never manufacture a weekend or gap candle.
    var last = bars[bars.length - 1];
    if (last && Math.floor(at / (tfSeconds() * 1000)) * tfSeconds() * 1000 === last.t) {
      bars = bars.slice();
      bars[bars.length - 1] = { t: last.t, o: last.o, h: Math.max(last.h, price),
        l: Math.min(last.l, price), c: price, v: last.v };
    }
    schedule();
    return true;
  }

  function normalise(rows) {
    if (!Array.isArray(rows)) return [];
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (!Array.isArray(row) || row.length < 5) continue;
      var o = Number(row[1]), h = Number(row[2]), l = Number(row[3]), c = Number(row[4]);
      if (!isFinite(o) || !isFinite(h) || !isFinite(l) || !isFinite(c)) continue;
      // the feed answers in seconds; the chart's own klines carry milliseconds
      var t = Math.round(Number(row[0]));
      if (t > 0 && t < 1e11) t *= 1000;
      out.push({ t: t, o: o, h: h, l: l, c: c, v: Number(row[5]) || 0 });
    }
    return out;
  }

  function loadBars() {
    var symbol = currentSymbol();
    var tf = currentTf();
    if (!symbol) return;
    var instrument = mappedInstrument(symbol);
    var key = symbol + '|' + tf + '|' + instrument;
    if (barsRequest && barsRequestKey === key) return;
    if (barsRequest) barsRequest.abort();
    var token = ++dataToken;
    var controller = new AbortController();
    barsRequest = controller;
    barsRequestKey = key;
    if (dataSymbol !== symbol || dataTf !== tf || dataInstrument !== instrument) {
      bars = [];
      livePrice = livePriceAt = 0;
    }
    dataSymbol = symbol;
    dataTf = tf;
    dataInstrument = instrument;
    dataError = '';
    loading = true;
    syncButtons();
    schedule();
    var timeout = setTimeout(function () { controller.abort(); }, 25000);
    var url = (instrument ? '/api/chart/tvcandles' : '/api/chart/candles') +
      '?symbol=' + encodeURIComponent(symbol) + '&tf=' + encodeURIComponent(tf) + '&count=' + CANDLE_COUNT;
    if (instrument) url += '&tv_symbol=' + encodeURIComponent(instrument);
    fetch(url, { cache: 'no-store', signal: controller.signal })
      .then(function (response) { return response.ok ? response.json() : null; })
      .then(function (data) {
        if (token !== dataToken || symbol !== currentSymbol() || tf !== currentTf()) return;
        if (instrument && (!data || !data.ok || data.symbol !== symbol ||
            data.tf !== tf || data.tv_symbol !== instrument)) throw new Error('TradingView candles unavailable');
        var next = normalise(data && data.bars);
        if (!next.length) throw new Error('Candles unavailable');
        bars = next;
        acceptQuote(window.SOFT_TV_QUOTE);
        schedule();
      })
      .catch(function () {
        if (token !== dataToken) return;
        dataError = instrument ? 'TradingView candles unavailable' : 'Market candles unavailable';
        // Keep only this instrument's cached bars. No proxy-feed fallback.
      })
      .finally(function () {
        clearTimeout(timeout);
        if (token !== dataToken) return;
        barsRequest = null;
        loading = false;
        syncButtons();
        schedule();
      });
  }

  function armRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(function () {
      if (anyEnabled()) loadBars();
    }, REFRESH_MS);
  }

  /* ================================================== 1. MSB-OB ========== */
  // Direct port of the Pine v5 script. The whole series is replayed from the
  // first loaded bar every time the data changes: the Pine script keeps its
  // state in `var` arrays, so a deterministic replay gives the same pivots,
  // market flips and boxes without holding session state across refreshes.
  function computeMSB(series) {
    var LEN = 9;            // zigzag_len
    var FIB = 0.33;         // fib_factor
    var n = series.length;
    var result = { zigzag: [], msb: [], boxes: [] };
    if (n < LEN * 3) return result;

    var toUp = new Array(n);
    var toDown = new Array(n);
    var i, k;
    for (i = 0; i < n; i++) {
      var hi = -Infinity, lo = Infinity;
      for (k = Math.max(0, i - LEN + 1); k <= i; k++) {
        if (series[k].h > hi) hi = series[k].h;
        if (series[k].l < lo) lo = series[k].l;
      }
      toUp[i] = series[i].h >= hi;
      toDown[i] = series[i].l <= lo;
    }

    function lastTrue(flags, end) {
      for (var j = end; j >= 0; j--) if (flags[j]) return j;
      return -1;
    }

    var lowVal = new Array(n), lowIdx = new Array(n);
    var highVal = new Array(n), highIdx = new Array(n);
    var lowFlag = new Array(n), highFlag = new Array(n);

    for (i = 0; i < n; i++) {
      var upSince = lastTrue(toUp, i - 1);
      var upWin = (upSince >= 0 && (i - 1 - upSince) > 0) ? (i - 1 - upSince) : 1;
      var lo2 = Infinity;
      for (k = Math.max(0, i - upWin + 1); k <= i; k++) if (series[k].l < lo2) lo2 = series[k].l;
      lowVal[i] = lo2;
      lowFlag[i] = lowVal[i] === series[i].l;

      var downSince = lastTrue(toDown, i - 1);
      var downWin = (downSince >= 0 && (i - 1 - downSince) > 0) ? (i - 1 - downSince) : 1;
      var hi2 = -Infinity;
      for (k = Math.max(0, i - downWin + 1); k <= i; k++) if (series[k].h > hi2) hi2 = series[k].h;
      highVal[i] = hi2;
      highFlag[i] = highVal[i] === series[i].h;
    }
    for (i = 0; i < n; i++) {
      lowIdx[i] = lastTrue(lowFlag, i);
      highIdx[i] = lastTrue(highFlag, i);
    }

    var trend = 1;
    var market = 1;
    var highPts = [];
    var lowPts = [];
    var lastL0 = NaN;
    var lastH0 = NaN;
    var buOb = [], beOb = [], buBb = [], beBb = [];

    for (i = 0; i < n; i++) {
      var prevTrend = trend;
      if (trend === 1 && toDown[i]) trend = -1;
      else if (trend === -1 && toUp[i]) trend = 1;
      var trendChanged = trend !== prevTrend;

      if (trendChanged) {
        if (trend === 1 && lowIdx[i] >= 0) lowPts.push({ i: lowIdx[i], p: lowVal[i] });
        if (trend === -1 && highIdx[i] >= 0) highPts.push({ i: highIdx[i], p: highVal[i] });
      }

      if (highPts.length < 2 || lowPts.length < 2) continue;

      var h0 = highPts[highPts.length - 1];
      var h1 = highPts[highPts.length - 2];
      var l0 = lowPts[lowPts.length - 1];
      var l1 = lowPts[lowPts.length - 2];

      if (trendChanged) {
        if (trend === 1) result.zigzag.push({ x1: h0.i, y1: h0.p, x2: l0.i, y2: l0.p });
        else result.zigzag.push({ x1: l0.i, y1: l0.p, x2: h0.i, y2: h0.p });
      }

      var before = market;
      if (!(lastL0 === l0.p || lastH0 === h0.p)) {
        if (market === 1 && l0.p < l1.p && l0.p < l1.p - Math.abs(h0.p - l1.p) * FIB) market = -1;
        else if (market === -1 && h0.p > h1.p && h0.p > h1.p + Math.abs(h1.p - l0.p) * FIB) market = 1;
      }
      var marketChanged = market !== before;
      if (marketChanged) {
        lastL0 = l0.p;
        lastH0 = h0.p;
      }

      if (marketChanged) {
        var buObIdx = i, buBbIdx = i, beObIdx = i, beBbIdx = i;
        if (market === 1) {
          result.msb.push({ dir: 1, i0: h1.i, i1: h0.i, p: h1.p, labelI: Math.round((h1.i + l0.i) / 2), labelP: h1.p });
          var scanEnd = (i - LEN >= 0 && lowIdx[i - LEN] >= 0) ? lowIdx[i - LEN] : i;
          for (k = Math.max(0, h1.i); k <= Math.min(scanEnd, i - 1); k++) {
            if (series[k].o > series[k].c) buObIdx = k;
          }
          for (k = Math.max(0, l1.i - LEN); k <= Math.min(h1.i, i - 1); k++) {
            if (series[k].o < series[k].c) buBbIdx = k;
          }
          buOb.push(makeBox(series, buObIdx, i, 'Bu-OB', 1));
          buBb.push(makeBox(series, buBbIdx, i, l0.p < l1.p ? 'Bu-BB' : 'Bu-MB', 1));
        } else {
          result.msb.push({ dir: -1, i0: l1.i, i1: l0.i, p: l1.p, labelI: Math.round((l1.i + h0.i) / 2), labelP: l1.p });
          var scanEnd2 = (i - LEN >= 0 && highIdx[i - LEN] >= 0) ? highIdx[i - LEN] : i;
          for (k = Math.max(0, l1.i); k <= Math.min(scanEnd2, i - 1); k++) {
            if (series[k].o < series[k].c) beObIdx = k;
          }
          for (k = Math.max(0, h1.i - LEN); k <= Math.min(l1.i, i - 1); k++) {
            if (series[k].o > series[k].c) beBbIdx = k;
          }
          beOb.push(makeBox(series, beObIdx, i, 'Be-OB', -1));
          beBb.push(makeBox(series, beBbIdx, i, h0.p > h1.p ? 'Be-BB' : 'Be-MB', -1));
        }
      }

      maintain(buOb, series[i], i, 1);
      maintain(beOb, series[i], i, -1);
      maintain(buBb, series[i], i, 1);
      maintain(beBb, series[i], i, -1);
    }

    result.boxes = buOb.concat(buBb, beOb, beBb).filter(function (b) { return !b.gone; });
    return result;
  }

  function makeBox(series, from, created, text, dir) {
    var bar = series[Math.max(0, Math.min(from, series.length - 1))];
    return {
      from: from,
      right: Math.min(series.length - 1, created + 10),
      top: bar.h,
      bottom: bar.l,
      text: text,
      dir: dir,
      gone: false
    };
  }

  function maintain(list, bar, i, dir) {
    for (var k = 0; k < list.length; k++) {
      var b = list[k];
      if (b.gone) continue;
      if (dir === 1) {
        if (bar.c < b.bottom) b.gone = true;
        else if (bar.c < b.top) { /* price inside the demand block */ }
        else b.right = i;
      } else {
        if (bar.c > b.top) b.gone = true;
        else if (bar.c > b.bottom) { /* price inside the supply block */ }
        else b.right = i;
      }
    }
  }

  /* ============================================ 2. WaveTrend ============== */
  function ema(values, length) {
    var out = new Array(values.length);
    var k = 2 / (length + 1);
    var prev = null;
    for (var i = 0; i < values.length; i++) {
      var v = values[i];
      if (!isFinite(v)) { out[i] = null; continue; }
      prev = prev === null ? v : v * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  }

  function sma(values, length) {
    var out = new Array(values.length);
    for (var i = 0; i < values.length; i++) {
      if (i < length - 1) { out[i] = null; continue; }
      var sum = 0, ok = true;
      for (var k = i - length + 1; k <= i; k++) {
        if (!isFinite(values[k])) { ok = false; break; }
        sum += values[k];
      }
      out[i] = ok ? sum / length : null;
    }
    return out;
  }

  function computeWaveTrend(series) {
    var N1 = 10, N2 = 21;
    var ap = series.map(function (b) { return (b.h + b.l + b.c) / 3; });
    var esa = ema(ap, N1);
    var dev = ap.map(function (v, i) { return Math.abs(v - esa[i]); });
    var d = ema(dev, N1);
    var ci = ap.map(function (v, i) {
      var denom = 0.015 * d[i];
      return denom ? (v - esa[i]) / denom : 0;
    });
    var wt1 = ema(ci, N2);
    var wt2 = sma(wt1, 4);
    return { wt1: wt1, wt2: wt2 };
  }

  /* ======================================== 3. ICT Killzones ============== */
  var NY_FMT = null;
  function nyStamp(ts) {
    if (!NY_FMT) {
      try {
        NY_FMT = new Intl.DateTimeFormat('en-US', {
          timeZone: 'America/New_York',
          year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', hour12: false
        });
      } catch (e) { NY_FMT = null; }
    }
    if (!NY_FMT) return null;
    // normalise() keeps the feed's milliseconds; older feeds answered in
    // seconds. Multiplying milliseconds by 1000 again shifted every session
    // to a year ~58,000, so no killzone ever matched a bar.
    var ms = ts > 0 && ts < 1e11 ? ts * 1000 : ts;
    var date = new Date(ms);
    if (!isFinite(date.getTime())) return null;
    var parts = NY_FMT.formatToParts(date);
    var out = { y: 0, m: 0, d: 0, h: 0, min: 0 };
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (p.type === 'year') out.y = Number(p.value);
      else if (p.type === 'month') out.m = Number(p.value);
      else if (p.type === 'day') out.d = Number(p.value);
      else if (p.type === 'hour') out.h = Number(p.value) % 24;
      else if (p.type === 'minute') out.min = Number(p.value);
    }
    out.minutes = out.h * 60 + out.min;
    out.dayKey = out.y + '-' + out.m + '-' + out.d;
    var dow = new Date(Date.UTC(out.y, out.m - 1, out.d)).getUTCDay();
    var back = dow === 0 ? 6 : dow - 1;                     // Monday based week
    out.weekKey = new Date(Date.UTC(out.y, out.m - 1, out.d - back)).toISOString().slice(0, 10);
    return out;
  }

  // Defaults from the script's inputs: KZ1 Asia 20:00-00:00, KZ2 London
  // 02:00-05:00, KZ3 NY AM 09:30-11:00, KZ5 NY PM 13:30-16:00 (KZ4 and KZ6 are
  // off by default). All times follow America/New_York, like the script.
  var KILLZONES = [
    { id: 'ASIA', from: 20 * 60, to: 24 * 60, color: '#2196f3' },
    { id: 'LNDN', from: 2 * 60, to: 5 * 60, color: '#f23645' },
    { id: 'NYAM', from: 9 * 60 + 30, to: 11 * 60, color: '#089981' },
    { id: 'NYPM', from: 13 * 60 + 30, to: 16 * 60, color: '#e040fb' }
  ];
  var SESSION_LIMIT = 3;   // max_days input
  // A session replay formats every bar with Intl. The panes repaint on every
  // wheel step / pan, so the result is cached for the current bar series.
  var kzCache = { src: null, res: null };

  function inSession(minutes, kz) {
    if (kz.to <= 24 * 60) return minutes >= kz.from && minutes < kz.to;
    return minutes >= kz.from || minutes < (kz.to - 24 * 60);
  }

  function computeKillzones(series) {
    if (kzCache.src === series && kzCache.res) return kzCache.res;
    var blocks = [];
    var stamps = series.map(function (b) { return nyStamp(b.t); });

    KILLZONES.forEach(function (kz) {
      var run = null;
      for (var i = 0; i < series.length; i++) {
        var st = stamps[i];
        var on = st && inSession(st.minutes, kz);
        if (on) {
          if (!run) {
            run = { kz: kz, i0: i, i1: i, high: series[i].h, low: series[i].l };
            blocks.push(run);
          }
          run.i1 = i;
          if (series[i].h > run.high) run.high = series[i].h;
          if (series[i].l < run.low) run.low = series[i].l;
        } else if (run) {
          run = null;
        }
      }
    });

    var byKz = {};
    blocks.forEach(function (b) {
      (byKz[b.kz.id] = byKz[b.kz.id] || []).push(b);
    });
    var kept = [];
    Object.keys(byKz).forEach(function (id) {
      kept = kept.concat(byKz[id].slice(-SESSION_LIMIT));
    });

    // pivots extend to the right until price trades through them
    kept.forEach(function (b) {
      var hiEnd = b.i1;
      var loEnd = b.i1;
      for (var j = b.i1 + 1; j < series.length; j++) {
        if (hiEnd === b.i1 && series[j].h > b.high) hiEnd = j;
        if (loEnd === b.i1 && series[j].l < b.low) loEnd = j;
        if (hiEnd !== b.i1 && loEnd !== b.i1) break;
      }
      b.hiEnd = hiEnd;
      b.loEnd = loEnd;
    });

    // previous day / week highs, lows and midlines (dhl, dmid, whl, wmid)
    var days = [];
    var weeks = [];
    for (var i = 0; i < series.length; i++) {
      var st = stamps[i];
      if (!st) continue;
      var day = days[days.length - 1];
      if (!day || day.key !== st.dayKey) {
        day = { key: st.dayKey, i0: i, high: series[i].h, low: series[i].l };
        days.push(day);
      }
      day.i1 = i;
      if (series[i].h > day.high) day.high = series[i].h;
      if (series[i].l < day.low) day.low = series[i].l;

      var week = weeks[weeks.length - 1];
      if (!week || week.key !== st.weekKey) {
        week = { key: st.weekKey, i0: i, high: series[i].h, low: series[i].l };
        weeks.push(week);
      }
      week.i1 = i;
      if (series[i].h > week.high) week.high = series[i].h;
      if (series[i].l < week.low) week.low = series[i].l;
    }

    var levels = [];
    var prevDay = days.length > 1 ? days[days.length - 2] : null;
    var prevWeek = weeks.length > 1 ? weeks[weeks.length - 2] : null;
    if (prevDay) {
      levels.push({ i0: prevDay.i1, p: prevDay.high, label: 'PDH', color: '#0ea5e9' });
      levels.push({ i0: prevDay.i1, p: prevDay.low, label: 'PDL', color: '#0ea5e9' });
      levels.push({ i0: prevDay.i1, p: (prevDay.high + prevDay.low) / 2, label: 'PDM', color: '#94a3b8' });
    }
    if (prevWeek) {
      levels.push({ i0: prevWeek.i1, p: prevWeek.high, label: 'PWH', color: '#8b5cf6' });
      levels.push({ i0: prevWeek.i1, p: prevWeek.low, label: 'PWL', color: '#8b5cf6' });
      levels.push({ i0: prevWeek.i1, p: (prevWeek.high + prevWeek.low) / 2, label: 'PWM', color: '#c4b5fd' });
    }

    var latest = {};
    kept.forEach(function (b) {
      if (!latest[b.kz.id] || b.i1 > latest[b.kz.id]) latest[b.kz.id] = b.i1;
    });

    kzCache = { src: series, res: { blocks: kept, levels: levels, latest: latest } };
    return kzCache.res;
  }

  /* ================================================= pane geometry ======= */
  // Each pane maps bars the way the main chart does: one slot per bar, the
  // right edge three slots away from the price axis, the reader's pan in
  // pixels (scaled to the pane width). The price band is per pane, from the
  // candles it actually has on screen.
  function candleView(w, h) {
    var axisW = 56;
    var padT = 6;
    var padB = 12;
    var chartW = Math.max(48, w - axisW);
    // the panes show more history than the main chart: the studies need
    // enough swings (zigzag 9) for their structure to read at this size
    var total = bars.length;
    var wantBars = isFinite(view.bars) ? view.bars : 140;
    var wantBack = isFinite(view.offset) ? Math.max(0, view.offset) : 0;
    var visible = Math.max(8, Math.min(wantBars, total));
    var slot = chartW / Math.max(8, visible);
    var rightEdgeX = chartW - slot;
    var end = Math.max(visible, Math.min(total, total - wantBack));
    var start = Math.max(0, Math.min(end, total) - visible);

    // index mapping only: no clock arithmetic, so the candles always land
    // inside the pane even when the feed's stamps and the chart's differ
    function xAt(index) { return rightEdgeX - (end - 1 - index) * slot; }

    var min = Infinity, max = -Infinity;
    for (var i = start; i < end && i < total; i++) {
      if (!bars[i]) break;
      if (bars[i].l < min) min = bars[i].l;
      if (bars[i].h > max) max = bars[i].h;
    }
    if (end === total && livePrice > 0) {
      min = Math.min(min, livePrice);
      max = Math.max(max, livePrice);
    }
    if (!isFinite(min) || !isFinite(max) || max <= min) {
      min = isFinite(min) ? min * 0.999 : 0;
      max = isFinite(max) ? max * 1.001 : 1;
      if (max <= min) max = min + 1;
    }
    var pad = (max - min) * 0.04;   // tighter price band = bigger candles
    var plotMin = min - pad;
    var plotMax = max + pad;
    var plotH = Math.max(20, h - padT - padB);

    return {
      w: w, h: h, chartW: chartW, axisW: axisW, padT: padT, plotH: plotH,
      slot: slot, rightEdgeX: rightEdgeX, start: start, end: end,
      plotMin: plotMin, plotMax: plotMax,
      xAt: xAt,
      yOf: function (p) {
        return padT + plotH - ((p - plotMin) / (plotMax - plotMin)) * plotH;
      }
    };
  }

  /* ================================================= painters ============ */
  function line(c, x1, y1, x2, y2, color, width, dash) {
    if (!isFinite(x1) || !isFinite(y1) || !isFinite(x2) || !isFinite(y2)) return;
    c.save();
    c.strokeStyle = color;
    c.lineWidth = width || 1;
    if (dash) c.setLineDash(dash);
    c.beginPath();
    c.moveTo(x1, y1);
    c.lineTo(x2, y2);
    c.stroke();
    c.restore();
  }

  function tag(c, text, x, y, color, align, limitX) {
    if (!isFinite(x) || !isFinite(y)) return;
    c.save();
    c.font = '600 9px "JetBrains Mono", monospace';
    c.textAlign = align || 'left';
    c.textBaseline = 'middle';
    var w = c.measureText(text).width + 6;
    var bx = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    var maxX = (limitX || Infinity) - w - 2;
    if (bx > maxX) bx = Math.max(2, maxX);
    c.fillStyle = 'rgba(255, 255, 255, 0.88)';
    c.fillRect(bx, y - 6, w, 12);
    c.fillStyle = color;
    c.fillText(text, bx + 3, y);
    c.restore();
  }

  function hexAlpha(hex, alpha) {
    var h = String(hex || '').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (h.length !== 6) return 'rgba(100, 116, 139, ' + alpha + ')';
    var r = parseInt(h.slice(0, 2), 16);
    var g = parseInt(h.slice(2, 4), 16);
    var b = parseInt(h.slice(4, 6), 16);
    return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + alpha + ')';
  }

  function drawCandles(c, v) {
    var barW = Math.max(1, Math.min(9, v.slot * 0.66));
    for (var i = v.start; i < v.end; i++) {
      var b = bars[i];
      var x = v.xAt(i);
      if (x < -v.slot || x > v.chartW + v.slot) continue;
      var up = b.c >= b.o;
      var yH = v.yOf(b.h);
      var yL = v.yOf(b.l);
      var yO = v.yOf(b.o);
      var yC = v.yOf(b.c);
      c.strokeStyle = up ? 'rgba(8, 153, 129, 0.85)' : 'rgba(242, 54, 69, 0.85)';
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(x, yH);
      c.lineTo(x, yL);
      c.stroke();
      var top = Math.min(yO, yC);
      var height = Math.max(1, Math.abs(yC - yO));
      c.fillStyle = up ? 'rgba(8, 153, 129, 0.9)' : 'rgba(242, 54, 69, 0.9)';
      c.fillRect(x - barW / 2, top, barW, height);
    }
  }

  function drawLivePrice(c, v, digits) {
    if (!livePrice || v.end !== bars.length) return;
    var y = v.yOf(livePrice);
    var last = bars[bars.length - 1];
    var color = last && livePrice < last.o ? COLORS.down : COLORS.up;
    line(c, 0, y, v.chartW, y, color, 1, [3, 3]);
    c.save();
    c.fillStyle = color;
    c.fillRect(v.chartW, y - 8, v.axisW, 16);
    c.font = '600 9px "JetBrains Mono", monospace';
    c.textAlign = 'left';
    c.textBaseline = 'middle';
    c.fillStyle = '#ffffff';
    c.fillText(livePrice.toFixed(digits), v.chartW + 3, y);
    c.restore();
  }

  function liquidityLevels() {
    var engine = window.StopLiquidity;
    if (!engine || typeof engine.state !== 'function') return [];
    var state = engine.state();
    if (!state || state.symbol !== dataSymbol || state.tvSymbol !== dataInstrument || !dataInstrument ||
        currentSymbol() !== dataSymbol || currentTf() !== dataTf) return [];
    // Exactly the top four BUY and SELL levels shown by the side panel.
    return (state.visibleZones || []).filter(function (z) {
      return (z.side === 'buy' || z.side === 'sell') && isFinite(Number(z.price)) && Number(z.price) > 0;
    }).map(function (z) {
      return {id:z.id, side:z.side, price:Number(z.price), touches:z.touches, fresh:state.fresh};
    });
  }

  function drawLiquidityZones(c, v, digits) {
    var levels = liquidityLevels();
    if (!levels.length) return;
    var top = v.padT + 9, bottom = v.padT + v.plotH - 9;
    var rows = levels.map(function (z) {
      var y = v.yOf(z.price);
      return {zone:z, y:y, target:Math.max(top, Math.min(bottom, y)), labelY:0};
    }).sort(function (a,b) {return a.target-b.target || b.zone.price-a.zone.price;});
    var gap = Math.min(18, (bottom-top) / Math.max(1, rows.length-1));
    rows.forEach(function (r,i) { r.labelY = Math.max(r.target, i ? rows[i-1].labelY+gap : top); });
    rows[rows.length-1].labelY = Math.min(bottom, rows[rows.length-1].labelY);
    for (var i=rows.length-2; i>=0; i--) rows[i].labelY = Math.min(rows[i].labelY, rows[i+1].labelY-gap);
    rows.forEach(function (r) {
      var z = r.zone, color = z.side === 'buy' ? COLORS.up : COLORS.down;
      var inRange = r.y >= v.padT && r.y <= v.padT+v.plotH;
      var price = z.price.toLocaleString('en-US', {minimumFractionDigits:digits, maximumFractionDigits:digits});
      var text = (inRange ? '' : (r.y < top ? '↑ ' : '↓ ')) +
        z.side.toUpperCase() + ' SL · ' + price + ' · EST';
      c.save();
      if (!z.fresh) c.globalAlpha = 0.5;
      c.font = '600 9px "JetBrains Mono", monospace';
      var labelW = c.measureText(text).width + 10;
      var labelX = Math.max(2, v.chartW-labelW-4);
      if (inRange) {
        c.fillStyle = hexAlpha(color, 0.09);
        c.fillRect(0, r.y-3, v.chartW, 6);
        line(c, 0, r.y, v.chartW, r.y, color, 1, [5,3]);
        if (Math.abs(r.y-r.labelY) > 3) line(c, labelX-4, r.y, labelX, r.labelY, color, 1);
      }
      c.fillStyle = z.side === 'buy' ? '#e6f5ef' : '#fdebef';
      c.fillRect(labelX, r.labelY-7, labelW, 14);
      c.strokeStyle = color;
      c.lineWidth = 1;
      c.strokeRect(labelX, r.labelY-7, labelW, 14);
      c.fillStyle = color;
      c.textAlign = 'left';
      c.textBaseline = 'middle';
      c.fillText(text, labelX+5, r.labelY);
      c.restore();
    });
  }

  function drawGrid(c, v, digits) {
    c.save();
    c.strokeStyle = COLORS.grid;
    c.lineWidth = 1;
    c.fillStyle = COLORS.muted;
    c.font = '600 8px "JetBrains Mono", monospace';
    c.textAlign = 'left';
    c.textBaseline = 'middle';
    for (var g = 0; g <= 3; g++) {
      var y = v.padT + v.plotH * (g / 3);
      c.beginPath();
      c.moveTo(0, y);
      c.lineTo(v.chartW, y);
      c.stroke();
      if (digits > 0) {
        var price = v.plotMax - (g / 3) * (v.plotMax - v.plotMin);
        c.fillText(price.toFixed(digits), v.chartW + 5, y);
      }
    }
    c.restore();
  }

  function drawMSB(c, v) {
    var res = computeMSB(bars);
    var i, x1, x2, y;

    for (i = 0; i < res.zigzag.length; i++) {
      var z = res.zigzag[i];
      line(c, v.xAt(z.x1), v.yOf(z.y1), v.xAt(z.x2), v.yOf(z.y2), COLORS.structure, 1);
    }

    for (i = 0; i < res.boxes.length; i++) {
      var b = res.boxes[i];
      x1 = v.xAt(b.from);
      x2 = v.xAt(b.right);
      var yTop = v.yOf(b.top);
      var yBottom = v.yOf(b.bottom);
      if (!isFinite(x1) || !isFinite(x2) || !isFinite(yTop) || !isFinite(yBottom)) continue;
      if (x2 < -20 || x1 > v.chartW) continue;
      var up = b.dir === 1;
      var boxW = Math.max(2, x2 - x1);
      var boxH = Math.max(1, yBottom - yTop);
      c.fillStyle = up ? COLORS.upFill : COLORS.downFill;
      c.fillRect(x1, yTop, boxW, boxH);
      c.strokeStyle = up ? COLORS.upLine : COLORS.downLine;
      c.lineWidth = 1;
      c.strokeRect(x1 + 0.5, yTop + 0.5, boxW, boxH);
      tag(c, b.text, Math.min(x2, v.chartW - 2), yBottom - 7, up ? COLORS.up : COLORS.down, 'right', v.chartW);
    }

    for (i = 0; i < res.msb.length; i++) {
      var m = res.msb[i];
      var color = m.dir === 1 ? COLORS.up : COLORS.down;
      line(c, v.xAt(m.i0), v.yOf(m.p), v.xAt(m.i1), v.yOf(m.p), color, 2);
      tag(c, 'MSB', v.xAt(m.labelI), v.yOf(m.labelP) + (m.dir === 1 ? -9 : 9), color, 'center', v.chartW);
    }
  }

  function drawKillzones(c, v) {
    var res = computeKillzones(bars);
    var i, j;

    for (i = 0; i < res.blocks.length; i++) {
      var b = res.blocks[i];
      var x0 = v.xAt(b.i0);
      var x1 = v.xAt(b.i1);
      var yTop = v.yOf(b.high);
      var yBottom = v.yOf(b.low);
      if (!isFinite(x0) || !isFinite(x1) || !isFinite(yTop) || !isFinite(yBottom)) continue;
      if (x1 < -20 || x0 > v.chartW) continue;
      c.save();
      c.fillStyle = hexAlpha(b.kz.color, 0.10);
      c.fillRect(x0, yTop, Math.max(1, x1 - x0), Math.max(1, yBottom - yTop));
      c.strokeStyle = hexAlpha(b.kz.color, 0.45);
      c.lineWidth = 1;
      c.strokeRect(x0 + 0.5, yTop + 0.5, Math.max(1, x1 - x0), Math.max(1, yBottom - yTop));
      c.restore();

      line(c, x0, yTop, v.xAt(b.hiEnd), yTop, hexAlpha(b.kz.color, 0.85), 1, [4, 3]);
      line(c, x0, yBottom, v.xAt(b.loEnd), yBottom, hexAlpha(b.kz.color, 0.85), 1, [4, 3]);
      if (b.i1 === res.latest[b.kz.id]) {
        tag(c, b.kz.id + ' H', v.xAt(b.hiEnd), yTop - 7, b.kz.color, 'right', v.chartW);
        tag(c, b.kz.id + ' L', v.xAt(b.loEnd), yBottom + 8, b.kz.color, 'right', v.chartW);
      }
    }

    for (j = 0; j < res.levels.length; j++) {
      var lv = res.levels[j];
      var lx = v.xAt(lv.i0);
      var ly = v.yOf(lv.p);
      if (!isFinite(lx) || !isFinite(ly)) continue;
      line(c, lx, ly, v.chartW, ly, hexAlpha(lv.color, 0.7), 1, [2, 3]);
      tag(c, lv.label, v.chartW - 2, ly, lv.color, 'right', v.chartW);
    }
  }

  function drawWaveTrend(c, v) {
    var res = computeWaveTrend(bars);
    var values = [];
    res.wt1.forEach(function (val) { if (isFinite(val)) values.push(val); });
    res.wt2.forEach(function (val) { if (isFinite(val)) values.push(val); });
    if (!values.length) return;

    var min = Math.min(-62, Math.min.apply(null, values));
    var max = Math.max(62, Math.max.apply(null, values));
    var span = (max - min) || 1;
    var top = v.padT;
    var height = v.plotH;

    function yOf(val) { return top + height - ((val - min) / span) * height; }

    [[60, COLORS.down], [53, COLORS.down], [0, '#94a3b8'], [-53, COLORS.up], [-60, COLORS.up]]
      .forEach(function (lvl) {
        line(c, 0, yOf(lvl[0]), v.chartW, yOf(lvl[0]), lvl[1], 1, lvl[0] === 0 ? null : [3, 3]);
        c.save();
        c.font = '600 8px "JetBrains Mono", monospace';
        c.fillStyle = lvl[1];
        c.textAlign = 'left';
        c.textBaseline = 'middle';
        c.fillText(String(lvl[0]), v.chartW + 5, yOf(lvl[0]));
        c.restore();
      });

    c.save();
    c.beginPath();
    var started = false, i, x;
    for (i = 0; i < bars.length; i++) {
      if (!isFinite(res.wt1[i])) continue;
      x = v.xAt(i);
      if (!isFinite(x)) continue;
      if (!started) { c.moveTo(x, yOf(res.wt1[i])); started = true; }
      else c.lineTo(x, yOf(res.wt1[i]));
    }
    for (i = bars.length - 1; i >= 0; i--) {
      if (!isFinite(res.wt2[i])) continue;
      x = v.xAt(i);
      if (!isFinite(x)) continue;
      c.lineTo(x, yOf(res.wt2[i]));
    }
    c.closePath();
    c.fillStyle = 'rgba(59, 130, 246, 0.18)';
    c.fill();
    c.restore();

    function plot(arr, color, dash) {
      c.save();
      c.strokeStyle = color;
      c.lineWidth = 1.5;
      if (dash) c.setLineDash(dash);
      c.beginPath();
      var on = false;
      for (var k = 0; k < bars.length; k++) {
        if (!isFinite(arr[k])) { on = false; continue; }
        var xx = v.xAt(k);
        if (!isFinite(xx)) { on = false; continue; }
        if (!on) { c.moveTo(xx, yOf(arr[k])); on = true; }
        else c.lineTo(xx, yOf(arr[k]));
      }
      c.stroke();
      c.restore();
    }

    plot(res.wt1, COLORS.up, null);
    plot(res.wt2, COLORS.down, [4, 3]);

    var last = -1;
    for (i = bars.length - 1; i >= 0; i--) { if (isFinite(res.wt1[i])) { last = i; break; } }
    if (last >= 0) tag(c, 'WT ' + res.wt1[last].toFixed(1), 4, top + 8, COLORS.text, 'left', v.chartW);
  }

  /* ================================================= stack + panes ======= */
  function ensureStack() {
    var wrap = document.querySelector('.binance-chart-wrapper');
    if (!wrap) return null;
    var el = document.getElementById('chart-indicator-stack');
    if (!el) {
      el = document.createElement('div');
      el.id = 'chart-indicator-stack';
      el.className = 'chart-indicator-stack';
      INDICATORS.forEach(function (ind) {
        var pane = document.createElement('div');
        pane.className = 'chart-ind-pane';
        pane.setAttribute('data-pane', ind.id);
        pane.innerHTML = '<div class="chart-ind-pane-head"><b>' + ind.label + '</b><span>' + ind.sub + '</span>' +
          '<em class="chart-ind-pane-zoom">scroll = zoom · drag = pan</em></div>' +
          '<div class="chart-ind-pane-canvas"><canvas></canvas></div>';
        el.appendChild(pane);
      });
      el.querySelectorAll('.chart-ind-pane-canvas').forEach(function (holder) {
        bindPaneInput(holder);
        if (paneObserver) {
          paneSizes.set(holder, {width: 0, height: 0});
          paneObserver.observe(holder);
        }
      });
      var anchor = wrap.querySelector('.binance-canvas-box');
      if (anchor && anchor.nextSibling) wrap.insertBefore(el, anchor.nextSibling);
      else wrap.appendChild(el);
    }
    stack = el;
    return el;
  }

  // TradingView-style navigation: the wheel zooms (shift/wheel-x pans) and a
  // drag moves the window back through history. Every pane shares the view.
  function clampOffset(value) {
    if (!isFinite(value)) return 0;
    var maxOffset = Math.max(0, bars.length - Math.max(MIN_BARS, Math.min(view.bars, bars.length)));
    return Math.max(0, Math.min(maxOffset, Math.round(value)));
  }

  function paneSlot(holder) {
    if (!holder) return 8;
    var chartW = Math.max(48, holder.clientWidth - 56);
    var visible = Math.max(8, Math.min(view.bars, bars.length || view.bars));
    return chartW / visible;
  }

  function bindPaneInput(holder) {
    if (!holder || holder.dataset.bound === '1') return;
    holder.dataset.bound = '1';

    holder.addEventListener('wheel', function (ev) {
      var horizontal = ev.shiftKey || Math.abs(ev.deltaX) > Math.abs(ev.deltaY);
      if (horizontal) {
        ev.preventDefault();
        view.offset = clampOffset(view.offset + ((ev.deltaX || ev.deltaY) / paneSlot(holder)));
        schedule();
        return;
      }
      ev.preventDefault();
      var step = Math.max(1, Math.round(view.bars * 0.16));
      var next = ev.deltaY > 0 ? view.bars + step : view.bars - step;   // down = zoom out
      view.bars = Math.max(MIN_BARS, Math.min(MAX_BARS, next));
      view.offset = clampOffset(view.offset);
      schedule();
    }, { passive: false });

    var drag = null;
    holder.addEventListener('pointerdown', function (ev) {
      if (ev.button !== 0) return;
      drag = { x: ev.clientX, offset: view.offset };
      holder.classList.add('dragging');
      if (holder.setPointerCapture) holder.setPointerCapture(ev.pointerId);
    });
    holder.addEventListener('pointermove', function (ev) {
      if (!drag) return;
      view.offset = clampOffset(drag.offset + ((ev.clientX - drag.x) / paneSlot(holder)));
      schedule();
    });
    function stopDrag() { drag = null; holder.classList.remove('dragging'); }
    holder.addEventListener('pointerup', stopDrag);
    holder.addEventListener('pointercancel', stopDrag);
    holder.addEventListener('pointerleave', function () { if (drag) stopDrag(); });
  }

  /* The TradingView overlay layer (large-flow tape, market news, pressure)
     stays on screen above the panes, so it has to start where the pane stack
     starts — measured, because the legend and the indicator bar above it can
     wrap to different heights. */
  function syncStackTop() {
    var wrap = document.querySelector('.binance-chart-wrapper');
    var el = document.getElementById('chart-indicator-stack');
    if (!wrap) return;
    if (wrap.classList.contains('ind-stack-on') && el) {
      wrap.style.setProperty('--ind-stack-top', el.offsetTop + 'px');
    } else {
      wrap.style.removeProperty('--ind-stack-top');
    }
  }

  function applyStack() {
    var wrap = document.querySelector('.binance-chart-wrapper');
    var el = ensureStack();
    if (!wrap || !el) return;
    var on = anyEnabled();
    wrap.classList.toggle('ind-stack-on', on);
    INDICATORS.forEach(function (ind) {
      var pane = el.querySelector('[data-pane="' + ind.id + '"]');
      if (pane) pane.classList.toggle('on', enabled[ind.id] === true);
    });
    if (on) schedule();
    requestAnimationFrame(syncStackTop);
  }

  window.addEventListener('resize', syncStackTop);

  function schedule() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(function () {
      rafPending = false;
      render();
    });
  }

  function digitsFor(price) {
    var terminal = window.SoftradeXTerminal || window.BinanceTerminal;
    var meta = terminal && terminal.MARKETS && terminal.MARKETS[dataSymbol];
    if (meta && Number.isInteger(meta.decimals) && meta.decimals >= 0 && meta.decimals <= 8) return meta.decimals;
    if (price >= 1000) return 2;
    if (price >= 10) return 3;
    return 5;
  }

  function paintPane(canvas, id) {
    var holder = canvas.parentNode;
    // ResizeObserver measures after layout. Reading dimensions on every quote
    // forced pending live-tape changes to lay out the entire dashboard here.
    var size = paneSizes.get(holder);
    var w = size ? size.width : holder.clientWidth;
    var h = size ? size.height : holder.clientHeight;
    if (!w || !h) return;
    var dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
    }
    var c = canvas.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    c.fillStyle = COLORS.background;
    c.fillRect(0, 0, w, h);

    if (!bars.length) {
      c.fillStyle = COLORS.muted;
      c.font = '12px sans-serif';
      c.textAlign = 'center';
      c.fillText(dataError || (loading ? 'Loading candles…' : 'Waiting for market data…'), w / 2, h / 2);
      return;
    }

    if (id === 'wavetrend') {
      var vOsc = candleView(w, h);
      drawGrid(c, vOsc, 0);
      drawWaveTrend(c, vOsc);
      return;
    }

    var v = candleView(w, h);
    var digits = digitsFor((v.plotMax + v.plotMin) / 2);
    drawGrid(c, v, digits);
    drawCandles(c, v);
    if (id === 'msb') drawMSB(c, v);
    else if (id === 'killzones') drawKillzones(c, v);
    drawLiquidityZones(c, v, digits);
    drawLivePrice(c, v, digits);
  }

  function render() {
    if (document.hidden) return;
    var el = stack || ensureStack();
    var wrap = document.querySelector('.binance-chart-wrapper');
    if (!el || !wrap || !wrap.classList.contains('ind-stack-on')) return;
    if (currentSymbol() && dataSymbol &&
        (currentSymbol() !== dataSymbol || currentTf() !== dataTf)) {
      if (!loading) loadBars();
      return;
    }
    INDICATORS.forEach(function (ind) {
      if (!enabled[ind.id]) return;
      var pane = el.querySelector('[data-pane="' + ind.id + '"]');
      var canvas = pane && pane.querySelector('canvas');
      if (canvas) paintPane(canvas, ind.id);
      var zoom = pane && pane.querySelector('.chart-ind-pane-zoom');
      if (zoom) zoom.textContent = view.bars + (view.offset ? ' bars · ' + Math.round(view.offset) + ' back' : ' bars');
    });
  }

  /* ======================================================== UI =========== */
  function flashNote(text) {
    var el = document.getElementById('chart-ind-toast');
    if (!el) {
      var host = ensureStack();
      if (!host) return;
      el = document.createElement('div');
      el.id = 'chart-ind-toast';
      el.className = 'chart-ind-toast';
      host.appendChild(el);
    }
    el.textContent = text;
    el.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 5200);
  }

  function syncButtons() {
    var bar = $('chart-indicator-bar');
    if (!bar) return;
    INDICATORS.forEach(function (ind) {
      var btn = bar.querySelector('[data-indicator="' + ind.id + '"]');
      if (!btn) return;
      var on = enabled[ind.id] === true;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    var hint = bar.querySelector('.chart-indicator-hint');
    if (hint) {
      hint.textContent = anyEnabled() && dataInstrument
        ? 'TradingView · ' + dataInstrument + (dataError ? ' · unavailable' : '')
        : (anyEnabled() ? 'separate pane · own study' : 'Pine port · separate panes');
    }
  }

  function toggle(id) {
    if (enabled[id]) delete enabled[id];
    else enabled[id] = true;
    // Opening a study always starts on the latest candles - it used to keep
    // whatever pan/zoom the pane had and opened far back in the history.
    view.offset = 0;
    if (!isFinite(view.bars) || view.bars > MAX_BARS) view.bars = 78;
    savePrefs();
    syncButtons();
    applyStack();
    if (anyEnabled()) {
      flashNote('TradingView\u2019s widget cannot run Pine scripts \u2014 the study opens in its own pane inside the chart.');
      if (!bars.length || currentSymbol() !== dataSymbol || currentTf() !== dataTf) loadBars();
    }
    schedule();
  }

  function bindButtons() {
    var bar = $('chart-indicator-bar');
    if (!bar) return;
    INDICATORS.forEach(function (ind) {
      var btn = bar.querySelector('[data-indicator="' + ind.id + '"]');
      if (!btn) return;
      btn.addEventListener('click', function () { toggle(ind.id); });
    });
    syncButtons();
    applyStack();
  }

  /* ==================================================== wiring =========== */
  window.addEventListener('chart:geometry', function (ev) {
    geometry = ev.detail || null;
    if (anyEnabled()) schedule();
  });

  window.addEventListener('chart:tv-quote', function (ev) { acceptQuote(ev.detail); });
  window.addEventListener('chart:liquidity-zones', function () { if (anyEnabled()) schedule(); });

  window.addEventListener('chart:price-range', function (ev) {
    if (!geometry) return;
    var d = ev.detail || {};
    if (isFinite(d.min) && isFinite(d.max) && d.max > d.min) {
      geometry.plotMin = d.min;
      geometry.plotMax = d.max;
    }
    if (anyEnabled()) schedule();
  });

  window.addEventListener('chart:market', function (ev) {
    var symbol = (ev.detail && ev.detail.symbol) || '';
    if (symbol && symbol !== dataSymbol) {
      ++dataToken;
      if (barsRequest) barsRequest.abort();
      barsRequest = null;
      loading = false;
      bars = [];
      livePrice = livePriceAt = 0;
      view.offset = 0;
      if (anyEnabled()) loadBars();
    }
    schedule();
  });

  window.addEventListener('chart:interval', function (ev) {
    var tf = (ev.detail && ev.detail.tf) || '';
    if (tf && tf !== dataTf) {
      ++dataToken;
      if (barsRequest) barsRequest.abort();
      barsRequest = null;
      loading = false;
      bars = [];
      livePrice = livePriceAt = 0;
      view.offset = 0;
      if (anyEnabled()) loadBars();
    }
    schedule();
  });

  window.addEventListener('resize', function () { schedule(); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) schedule(); });

  document.addEventListener('DOMContentLoaded', function () {
    bindButtons();
    if (anyEnabled()) loadBars();
    armRefresh();
    schedule();
  });

  window.ChartIndicators = {
    list: function () { return INDICATORS.slice(); },
    active: function () {
      return INDICATORS.filter(function (ind) { return enabled[ind.id]; })
        .map(function (ind) { return ind.id; });
    },
    setEnabled: function (id, on) {
      if (on) enabled[id] = true;
      else delete enabled[id];
      view.offset = 0;
      if (!isFinite(view.bars) || view.bars > MAX_BARS) view.bars = 78;
      savePrefs();
      syncButtons();
      applyStack();
      if (anyEnabled()) loadBars();
      schedule();
    },
    toggle: toggle,
    liquidity: liquidityLevels,
    debug: function () {
      var pane = document.querySelector('[data-pane="msb"] canvas');
      if (!pane) return null;
      var v = candleView(pane.clientWidth, pane.clientHeight);
      return {
        bars: bars.length,
        first: bars[0] || null,
        last: bars[bars.length - 1] || null,
        tf: dataTf,
        view: { bars: view.bars, offset: view.offset, slot: v.slot, start: v.start, end: v.end },
        plotMin: v.plotMin,
        plotMax: v.plotMax,
        slot: v.slot,
        rightEdgeX: v.rightEdgeX,
        paneSize: [pane.clientWidth, pane.clientHeight]
      };
    },
    // diagnostic view of the ICT session replay (used to verify the pane and
    // to compare the boxes against the feed's bar timestamps)
    killzones: function () {
      if (!bars.length) return null;
      var res = computeKillzones(bars);
      return {
        blocks: res.blocks.map(function (b) {
          return {
            id: b.kz.id, i0: b.i0, i1: b.i1, high: b.high, low: b.low,
            hiEnd: b.hiEnd, loEnd: b.loEnd,
            t0: bars[b.i0].t, t1: bars[b.i1].t
          };
        }),
        latest: res.latest,
        levels: res.levels
      };
    },
    state: function () {
      return {
        active: window.ChartIndicators.active(),
        bars: bars.length,
        symbol: dataSymbol,
        tf: dataTf,
        tvSymbol: dataInstrument,
        price: livePrice,
        priceAt: livePriceAt,
        loading: loading,
        error: dataError,
        geometry: geometry,
        stack: !!stack && stack.classList.contains('on'),
        panes: INDICATORS.filter(function (ind) {
          var pane = document.querySelector('[data-pane="' + ind.id + '"]');
          return pane && pane.classList.contains('on');
        }).map(function (ind) { return ind.id; })
      };
    }
  };
})();
