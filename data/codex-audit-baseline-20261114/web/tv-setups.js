/* Next extreme execution setups, priced live from the chart.
   --------------------------------------------------------------------------
   Ten levels, all measured on the daily candles the chart itself draws:

     Today Low · Today High
     Previous Day Low · Previous Day High
     This Week Low · This Week High
     Previous Week Low · Previous Week High
     This Month Low · This Month High

   Two feeds keep the panel honest:

   1. /api/chart/candles (tf=1d) - the daily bars behind those ten levels.
   2. /api/chart/ticker          - the live price, polled every 5 s, so the
      price and every distance next to it move with the chart.
   -------------------------------------------------------------------------- */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };

  var LEVELS_MS = 30000;   // re-read the daily extremes
  var PRICE_MS = 5000;     // follow the chart price
  var LEVEL_COUNT = 10;    // today/prev-day/week/prev-week/month, low + high
  var WEEK_MS = 7 * 24 * 60 * 60 * 1000;

  var symbol = '';
  var levels = [];         // [{ action, label, scope, price }]
  var livePrice = 0;
  var updatedAt = 0;
  var feedNote = '';
  var levelsBusy = false;
  var priceBusy = false;
  var levelsTimer = null;
  var priceTimer = null;

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtPrice(v) {
    var n = Number(v);
    if (!isFinite(n) || n <= 0) return '—';
    var d = n >= 1000 ? 2 : n >= 10 ? 3 : 5;
    return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function fmtPct(v) {
    var n = Number(v);
    return isFinite(n) && n >= 0 ? n.toFixed(2) + '%' : '—';
  }
  function cleanSymbol(v) { return String(v || '').replace(/m$/, ''); }

  // UTC Monday 00:00 of the week that holds ts - the same week boundary the
  // chart's daily bars fall on, so "this week" means the current calendar week.
  function weekStartUTC(ts) {
    var d = new Date(Number(ts));
    var back = (d.getUTCDay() + 6) % 7;   // Sunday(0) -> 6, Monday(1) -> 0
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back);
  }

  function statusFor(level, price) {
    if (!(level > 0) || !(price > 0)) {
      return { status: 'PENDING', cls: 'pending', pct: null, dist: Infinity };
    }
    var dist = Math.abs(price - level);
    var pct = (dist / price) * 100;
    if (dist <= price * 0.0006) return { status: 'AT LEVEL', cls: 'trigger', pct: pct, dist: dist };
    if (pct <= 0.35) return { status: 'IMMINENT', cls: 'imminent', pct: pct, dist: dist };
    if (pct <= 1.2) return { status: 'APPROACHING', cls: 'approaching', pct: pct, dist: dist };
    return { status: 'PENDING', cls: 'pending', pct: pct, dist: dist };
  }

  function paint() {
    var list = $('tvs-list');
    if (!list) return;
    var symEl = $('tvs-symbol');
    if (symEl) symEl.textContent = cleanSymbol(symbol) || 'XAUUSD';
    var priceEl = $('tvs-price');
    if (priceEl) priceEl.textContent = fmtPrice(livePrice);
    var updEl = $('tvs-updated');
    if (updEl) {
      updEl.textContent = updatedAt
        ? new Date(updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
        : '—';
    }
    var countEl = $('tvs-count');
    if (countEl) countEl.textContent = levels.length + ' / ' + LEVEL_COUNT;

    if (!levels.length) {
      list.innerHTML = '<div class="tvs-empty">' + esc(feedNote || 'Loading the daily levels…') + '</div>';
      return;
    }

    var price = livePrice > 0 ? livePrice : 0;
    var rows = levels.map(function (row) {
      return { row: row, st: statusFor(Number(row.price), price) };
    }).sort(function (a, b) { return a.st.dist - b.st.dist; });

    list.innerHTML = rows.map(function (item, i) {
      var row = item.row;
      var st = item.st;
      var buy = String(row.action || '').toUpperCase() === 'BUY';
      var cls = buy ? 'buy' : 'sell';
      return '<div class="tvs-row ' + cls + '">' +
        '<span class="tvs-rank">#' + (i + 1) + '</span>' +
        '<span class="tvs-action ' + cls + '">' + (buy ? '▲ BUY' : '▼ SELL') + '</span>' +
        '<span class="tvs-main"><b>' + esc(row.label || 'Extreme level') + '</b>' +
          '<small><span class="tvs-status status-' + esc(st.cls) + '">' + esc(st.status) + '</span> · ' + esc(row.scope || '') + '</small></span>' +
        '<span class="tvs-level">' + fmtPrice(row.price) + '</span>' +
        '<span class="tvs-dist ' + cls + '">' + fmtPct(st.pct) + '</span>' +
      '</div>';
    }).join('');
  }

  /* ------------------------------------------------ levels from the chart */
  function loadLevels() {
    if (levelsBusy || !symbol) return;
    levelsBusy = true;
    fetch('/api/chart/candles?symbol=' + encodeURIComponent(symbol) +
      '&tf=1d&count=400', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        var bars = (data && Array.isArray(data.bars) ? data.bars : []).filter(function (b) {
          return Array.isArray(b) && isFinite(Number(b[2])) && isFinite(Number(b[3]));
        });
        if (bars.length < 2) {
          levels = [];
          feedNote = 'No daily candles for ' + (cleanSymbol(symbol) || 'this market') + ' yet.';
          paint();
          return;
        }
        var last = bars[bars.length - 1];
        var prev = bars[bars.length - 2];
        var price = Number(last[4]) || Number(last[1]) || 0;
        if (price > 0) livePrice = price;

        var lastDate = new Date(Number(last[0]));
        var thisWeekStart = weekStartUTC(lastDate.getTime());
        var prevWeekStart = thisWeekStart - WEEK_MS;
        var monthHigh = -Infinity, monthLow = Infinity;
        var weekHigh = -Infinity, weekLow = Infinity;
        var prevWeekHigh = -Infinity, prevWeekLow = Infinity;
        bars.forEach(function (b) {
          var ts = Number(b[0]);
          var d = new Date(ts);
          var h = Number(b[2]), l = Number(b[3]);
          if (d.getUTCFullYear() === lastDate.getUTCFullYear() &&
              d.getUTCMonth() === lastDate.getUTCMonth()) {
            if (h > monthHigh) monthHigh = h;
            if (l < monthLow) monthLow = l;
          }
          if (ts >= thisWeekStart) {
            if (h > weekHigh) weekHigh = h;
            if (l < weekLow) weekLow = l;
          } else if (ts >= prevWeekStart) {
            if (h > prevWeekHigh) prevWeekHigh = h;
            if (l < prevWeekLow) prevWeekLow = l;
          }
        });

        levels = [
          { action: 'BUY', label: 'Today Low', scope: 'DAY', price: Number(last[3]) },
          { action: 'SELL', label: 'Today High', scope: 'DAY', price: Number(last[2]) },
          { action: 'BUY', label: 'Previous Day Low', scope: 'PREV DAY', price: Number(prev[3]) },
          { action: 'SELL', label: 'Previous Day High', scope: 'PREV DAY', price: Number(prev[2]) },
          { action: 'BUY', label: 'This Week Low', scope: 'WEEK', price: weekLow },
          { action: 'SELL', label: 'This Week High', scope: 'WEEK', price: weekHigh },
          { action: 'BUY', label: 'Previous Week Low', scope: 'PREV WEEK', price: prevWeekLow },
          { action: 'SELL', label: 'Previous Week High', scope: 'PREV WEEK', price: prevWeekHigh },
          { action: 'SELL', label: 'This Month High', scope: 'MONTH', price: monthHigh },
          { action: 'BUY', label: 'This Month Low', scope: 'MONTH', price: monthLow }
        ].filter(function (row) {
          return isFinite(Number(row.price)) && Number(row.price) > 0;
        });

        updatedAt = Date.now();
        feedNote = levels.length ? '' : 'No extreme level inside the chart window.';
        paint();
      })
      .catch(function () {
        levels = [];
        feedNote = 'The chart feed is not answering right now.';
        paint();
      })
      .finally(function () { levelsBusy = false; });
  }

  /* ---------------------------------------------------- price from chart */
  function loadPrice() {
    if (priceBusy || !symbol) return;
    priceBusy = true;
    fetch('/api/chart/ticker?symbol=' + encodeURIComponent(symbol), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (t) {
        var p = t && Number(t.price);
        if (!(p > 0)) return;
        if (p !== livePrice) {
          livePrice = p;
          updatedAt = Date.now();
        }
        paint();
      })
      .catch(function () { /* keep the last price */ })
      .finally(function () { priceBusy = false; });
  }

  function setSymbol(next) {
    var s = String(next || '');
    if (!s || s === symbol) return;
    symbol = s;
    levels = [];
    livePrice = 0;
    updatedAt = 0;
    feedNote = 'Loading the daily levels…';
    paint();
    loadPrice();
    loadLevels();
  }

  function init() {
    var term = window.SoftradeXTerminal;
    symbol = (term && typeof term.getCurrentSymbol === 'function')
      ? String(term.getCurrentSymbol() || '') : '';
    if (!symbol) symbol = 'XAUUSDm';
    paint();
    loadPrice();
    loadLevels();

    window.addEventListener('chart:market', function (ev) {
      var d = (ev && ev.detail) || {};
      setSymbol(d.symbol || (d.meta && d.meta.symbol) || '');
    });
    window.addEventListener('chart:refresh', function () { loadPrice(); loadLevels(); });

    if (levelsTimer) clearInterval(levelsTimer);
    levelsTimer = setInterval(function () { if (!document.hidden) loadLevels(); }, LEVELS_MS);
    if (priceTimer) clearInterval(priceTimer);
    priceTimer = setInterval(function () { if (!document.hidden) loadPrice(); }, PRICE_MS);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) { loadPrice(); loadLevels(); }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.TvSetups = {
    refresh: function () { loadPrice(); loadLevels(); },
    state: function () { return { symbol: symbol, price: livePrice, levels: levels }; }
  };
})();
