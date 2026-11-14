/* ==========================================================================
   Chart overlay (chart-overlay.js)
   --------------------------------------------------------------------------
   Two live cards that sit INSIDE the TradingView chart box, because the
   TradingView embed draws its own canvas and the built-in overlay (the news
   rails drawn by chart-news-events.js) cannot paint on top of it:

   1. WHALES - the big prints of the charted market, split into BUY and SELL,
      with the participation of each side and the last few prints.
      Source: /api/chart/tape (the same tape the whale board reads).

   2. NEWS - the next economic events that carry a predicted move for THIS
      market, each with its direction and the amount it is expected to move,
      plus the summed UP / DOWN expectation.
      Source: window.ChartNewsOverlay.getEvents() - the calendar the news
      section already refreshes - with /api/state as the fallback.

   Nothing here invents numbers: a row without a predicted move is not given
   one, and the card simply stays empty until the feeds answer.
   ========================================================================== */
(function () {
  'use strict';

  var TAPE_MS = 12000;        // whale tape refresh
  var NEWS_MS = 20000;        // news card repaint
  var MAX_NEWS = 50;          // all selected-market events in the 24h window
  var MAX_WHALES = 6;
  var HORIZON_SEC = 24 * 3600;

  var $ = function (id) { return document.getElementById(id); };

  var root = null;
  var box = null;
  var symbol = '';
  var digits = 2;

  // LARGE FLOW is a floating readout: the reader can park it anywhere over the
  // chart (TradingView frame or the indicator panes) and the spot survives
  // reloads. Stored as a fraction of the free travel so it stays put when the
  // chart box changes size between the two chart modes.
  var DRAG_KEY = 'softradex.chart.flowcard';
  var dragPos = null;

  var prints = [];
  var tapeAt = 0;
  var tapeBusy = false;

  var newsRows = [];
  var newsSig = '';

  /* ----------------------------------------------------------- helpers -- */
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function marketKey(v) {
    return String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  function marketMatch(a, b) {
    var x = marketKey(a);
    var y = marketKey(b);
    if (!x || !y) return false;
    if (x === y) return true;
    var short = x.length <= y.length ? x : y;
    var long = x.length <= y.length ? y : x;
    return short.length >= 5 && long.indexOf(short) === 0 && long.length - short.length <= 4;
  }

  function fmtPrice(p) {
    var v = Number(p);
    if (!isFinite(v)) return '—';
    var d = v >= 1000 ? 2 : digits;
    return v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  function fmtClock(ms) {
    var d = new Date(Number(ms) || Date.now());
    return String(d.getHours()).padStart(2, '0') + ':' +
      String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0');
  }

  function fmtMin(ts) {
    var mins = Math.max(0, Math.round((ts - Date.now() / 1000) / 60));
    if (mins < 60) return 'in ' + mins + 'm';
    var h = Math.floor(mins / 60);
    var m = mins % 60;
    if (h < 24) return m ? 'in ' + h + 'h ' + m + 'm' : 'in ' + h + 'h';
    return 'in ' + Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
  }

  function fmtMoney(v) {
    var n = Math.abs(Number(v) || 0);
    if (!isFinite(n) || n === 0) return '';
    var txt = n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : n.toFixed(4);
    return txt.replace(/\.?0+$/, '');
  }

  function normSide(v) {
    var s = String(v || '').toLowerCase();
    if (s === 'buy' || s === 'up' || s === 'bullish') return 'UP';
    if (s === 'sell' || s === 'down' || s === 'bearish') return 'DOWN';
    return '';
  }

  /* ------------------------------------------------------------- whales -- */
  function fetchTape() {
    if (tapeBusy || !symbol) return;
    tapeBusy = true;
    fetch('/api/chart/tape?symbol=' + encodeURIComponent(symbol) + '&limit=40', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data || symbol !== (data.symbol || symbol)) return;
        var meta = data.meta || null;
        if (meta && meta.digits !== undefined) digits = Number(meta.digits) || digits;
        prints = Array.isArray(data.prints) ? data.prints : [];
        tapeAt = Date.now();
        renderWhales();
        // The candle chart listens for this and marks the exact candles the
        // whales bought / sold in (markers cannot be drawn inside the
        // TradingView frame, so the tape feeds both views).
        window.dispatchEvent(new CustomEvent('whale:prints', {
          detail: { symbol: symbol, prints: prints }
        }));
      })
      .catch(function () { /* keep the last tape */ })
      .finally(function () { tapeBusy = false; });
  }

  function whaleStats() {
    var buy = 0;
    var sell = 0;
    var buyPart = 0;
    var sellPart = 0;
    for (var i = 0; i < prints.length; i++) {
      var p = prints[i];
      var side = String(p.side || '').toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
      var part = Math.max(1, Number(p.ticks) || 1);
      if (side === 'BUY') { buy++; buyPart += part; } else { sell++; sellPart += part; }
    }
    var total = buy + sell;
    return {
      buy: buy, sell: sell, buyPart: buyPart, sellPart: sellPart,
      buyPct: total ? Math.round((buy / total) * 100) : 0,
      partPct: (buyPart + sellPart) ? Math.round((buyPart / (buyPart + sellPart)) * 100) : 0,
      total: total
    };
  }

  function renderWhales() {
    var wrap = $('tvo-w-body');
    if (!wrap) return;
    var st = whaleStats();
    if (!st.total) {
      wrap.innerHTML = '<div class="tvo-empty">waiting for large-flow prints…</div>';
      return;
    }
    var bias = st.partPct >= 56 ? 'BUY' : st.partPct <= 44 ? 'SELL' : 'WAIT';
    var confidence = Math.min(100, Math.abs(st.partPct - 50) * 2);
    var rows = prints.slice(0, MAX_WHALES).map(function (p) {
      var isBuy = String(p.side || '').toUpperCase() !== 'SELL';
      var part = Math.max(1, Number(p.ticks) || 1);
      return '<li class="tvo-w-row">' +
        '<span class="tvo-w-time">' + esc(fmtClock(p.tm)) + '</span>' +
        '<span class="tvo-w-side ' + (isBuy ? 'buy' : 'sell') + '">' + (isBuy ? '▲ BUY' : '▼ SELL') + '</span>' +
        '<span class="tvo-w-px">' + esc(fmtPrice(p.px)) + '</span>' +
        '<span class="tvo-w-part">' + part + 't</span>' +
        '</li>';
    }).join('');

    wrap.innerHTML =
      '<div class="tvo-flow-call ' + bias.toLowerCase() + '"><span>LARGE-FLOW ADVISORY</span><b>' + bias + '</b><em>' + confidence + '% confidence</em></div>' +
      '<div class="tvo-w-split">' +
        '<div class="tvo-w-col buy"><span>BUY</span><b>' + st.buy + '</b><em>' + st.buyPart + ' trades</em></div>' +
        '<div class="tvo-w-col sell"><span>SELL</span><b>' + st.sell + '</b><em>' + st.sellPart + ' trades</em></div>' +
      '</div>' +
      '<div class="tvo-bar"><i class="buy" style="width:' + st.partPct + '%"></i><i class="sell" style="width:' + (100 - st.partPct) + '%"></i></div>' +
      '<div class="tvo-w-cap"><span>BUY ' + st.partPct + '%</span><span>SELL ' + (100 - st.partPct) + '%</span></div>' +
      '<ul class="tvo-w-list">' + rows + '</ul>';
  }

  /* --------------------------------------------------------------- news -- */
  function eventsFromCalendar() {
    var overlay = window.ChartNewsOverlay;
    if (overlay && typeof overlay.getEvents === 'function') {
      var rows = overlay.getEvents();
      if (rows && rows.length) return rows;
    }
    return newsRows;
  }

  function impactFor(ev) {
    var impacts = Array.isArray(ev.impacted) ? ev.impacted
      : (Array.isArray(ev.impacted_markets) ? ev.impacted_markets : []);
    for (var i = 0; i < impacts.length; i++) {
      if (marketMatch(impacts[i].market, symbol)) return impacts[i];
    }
    return null;
  }

  function eventSide(ev, imp) {
    if (imp) {
      var d = normSide(imp.side) || normSide(imp.direction);
      if (d) return d;
    }
    return normSide(ev.side) || 'WAIT';
  }

  function eventMove(ev, imp) {
    if (!imp) return { amount: 0, text: '' };
    var raw = imp.move_abs !== undefined ? imp.move_abs : imp.move_dollar;
    var amount = Math.abs(Number(raw) || 0);
    var text = String(imp.move_text_en || '').replace(/\s*(UP|DOWN)\s*$/i, '').trim();
    if (!text && amount) text = fmtMoney(amount);
    return { amount: amount, text: text };
  }

  function upcomingForMarket() {
    var nowSec = Date.now() / 1000;
    var all = eventsFromCalendar() || [];
    var out = [];
    for (var i = 0; i < all.length; i++) {
      var e = all[i];
      var ts = Number(e.ts);
      if (!(ts > nowSec - 120) || ts > nowSec + HORIZON_SEC) continue;
      out.push(e);
    }
    // Only events mapped by backend.news_bot.compute_market_impacts onto THIS
    // market. Keep low + medium + high, sort by release time, and preserve the
    // complete next-24-hour list; the scrollable terminal owns presentation.
    return out.filter(function (e) { return !!impactFor(e); })
      .sort(function (a, b) { return Number(a.ts) - Number(b.ts); })
      .slice(0, MAX_NEWS);
  }

  function renderNews() {
    var wrap = $('tvo-n-body');
    if (!wrap) return;
    var rows = upcomingForMarket();
    var up = 0;
    var down = 0;
    var html = rows.map(function (e) {
      var imp = impactFor(e);
      var side = eventSide(e, imp);
      var mv = eventMove(e, imp);
      var level = String(e.impact || 'low').toLowerCase();
      if (['low', 'medium', 'high'].indexOf(level) < 0) level = 'low';
      if (side === 'UP') up += mv.amount;
      else if (side === 'DOWN') down += mv.amount;
      var cls = side === 'UP' ? 'buy' : side === 'DOWN' ? 'sell' : 'wait';
      var chip = side === 'UP' ? '▲ BUY' : side === 'DOWN' ? '▼ SELL' : '• WAIT';
      var move = mv.text ? '<b class="tvo-n-move ' + cls + '">' + esc(mv.text) + '</b>' : '';
      var at = new Date(Number(e.ts) * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return '<li class="tvo-n-row impact-' + level + '">' +
        '<span class="tvo-n-level">' + level.toUpperCase() + '</span>' +
        '<span class="tvo-n-chip ' + cls + '">' + chip + '</span>' +
        '<span class="tvo-n-main">' +
          '<span class="tvo-n-title">' + esc(String(e.title || '—')) + '</span>' +
          '<span class="tvo-n-sub">' + esc(at) + ' · ' + esc(String(e.currency || '')) + ' · ' + esc(fmtMin(Number(e.ts))) + '</span>' +
        '</span>' + move +
        '</li>';
    }).join('');

    if (!rows.length) {
      wrap.innerHTML = '<div class="tvo-empty">no news mapped to ' + esc(symbol || 'this market') + ' yet</div>';
      return;
    }

    var upTxt = up ? '+$' + fmtMoney(up) : '—';
    var downTxt = down ? '-$' + fmtMoney(down) : '—';
    var upPct = (up + down) ? Math.round((up / (up + down)) * 100) : 50;

    wrap.innerHTML =
      '<div class="tvo-n-totals">' +
        '<div class="tvo-n-total buy"><span>EST. UP · 24H</span><b>' + upTxt + '</b></div>' +
        '<div class="tvo-n-total sell"><span>EST. DOWN · 24H</span><b>' + downTxt + '</b></div>' +
      '</div>' +
      '<div class="tvo-bar news"><i class="buy" style="width:' + upPct + '%"></i><i class="sell" style="width:' + (100 - upPct) + '%"></i></div>' +
      '<ul class="tvo-n-list">' + html + '</ul>';
  }

  function refreshNewsSource() {
    var overlay = window.ChartNewsOverlay;
    if (overlay && typeof overlay.getEvents === 'function') {
      var rows = overlay.getEvents();
      if (rows && rows.length) { renderNews(); return; }
    }
    fetch('/api/state' + (newsSig ? '?have=' + encodeURIComponent(newsSig) : ''),
      { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (st) {
        // "news_omitted" means the feed left the calendar out because this
        // browser already has it - keep the last list rather than clearing it.
        if (!(st && st.bot5 && Array.isArray(st.bot5.news))) { renderNews(); return; }
        var rows = st.bot5.news;
        if (st.bot5.news_sig) newsSig = st.bot5.news_sig;
        newsRows = rows.map(function (r) {
          return {
            ts: Number(r.ts) || 0,
            title: r.title || r.event || '—',
            currency: r.currency || '',
            impact: String(r.impact || 'low').toLowerCase(),
            side: r.side || '',
            impacted: Array.isArray(r.impacted_markets) ? r.impacted_markets : []
          };
        }).filter(function (r) { return r.ts > 0; });
        renderNews();
      })
      .catch(function () { renderNews(); });
  }

  /* -------------------------------------------------------------- mount -- */
  function build() {
    box = $('tv-chart-box');
    if (!box || root) return;
    root = document.createElement('div');
    root.className = 'tvo';
    root.id = 'tv-chart-overlay';
    root.innerHTML =
        '<div class="tvo-card tvo-whales">' +
        '<div class="tvo-head"><span class="tvo-dot"></span>LARGE FLOW · CHART' +
          '<button type="button" class="tvo-hint" id="tvo-candle-hint"' +
            ' title="Whale buy/sell arrows on the candles - opens the candle chart">🐋 arrows</button>' +
          '<em id="tvo-w-src">TAPE</em></div>' +
        '<div id="tvo-w-body"><div class="tvo-empty">loading big prints…</div></div>' +
      '</div>' +
        '<div class="tvo-card tvo-news">' +
        '<div class="tvo-head"><span class="tvo-dot news"></span>MARKET NEWS · NEXT 24H' +
          '<em id="tvo-n-src">AI ESTIMATE</em></div>' +
        '<div id="tvo-n-body"><div class="tvo-empty">loading the calendar…</div></div>' +
      '</div>';
    box.appendChild(root);
  }

  /* ------------------------------------------------------ drag position -- */
  function loadDragPos() {
    try {
      var raw = JSON.parse(localStorage.getItem(DRAG_KEY) || 'null');
      if (raw && isFinite(raw.x) && isFinite(raw.y)) {
        return { x: Math.max(0, Math.min(1, Number(raw.x))), y: Math.max(0, Math.min(1, Number(raw.y))) };
      }
    } catch (e) { /* a broken preference just keeps the default corner */ }
    return null;
  }

  function applyDragPos() {
    var card = root && root.querySelector('.tvo-whales');
    if (!card || !box) return;
    if (!dragPos) {
      card.classList.remove('tvo-free');
      card.style.left = '';
      card.style.top = '';
      card.style.right = '';
      return;
    }
    card.classList.add('tvo-free');
    var freeX = Math.max(0, box.clientWidth - card.offsetWidth);
    var freeY = Math.max(0, box.clientHeight - card.offsetHeight);
    card.style.left = Math.round(dragPos.x * freeX) + 'px';
    card.style.top = Math.round(dragPos.y * freeY) + 'px';
    card.style.right = 'auto';
  }

  function makeDraggable() {
    var card = root.querySelector('.tvo-whales');
    var head = card && card.querySelector('.tvo-head');
    if (!head) return;
    var drag = null;

    head.addEventListener('pointerdown', function (ev) {
      if (ev.button !== 0) return;
      // the whale-arrow hint inside the head stays a button, not a handle
      if (ev.target && ev.target.closest && ev.target.closest('button')) return;
      var rect = card.getBoundingClientRect();
      var boxRect = box.getBoundingClientRect();
      drag = {
        id: ev.pointerId,
        dx: ev.clientX - rect.left,
        dy: ev.clientY - rect.top,
        w: rect.width,
        h: rect.height,
        boxRect: boxRect
      };
      card.classList.add('dragging');
      try { if (head.setPointerCapture) head.setPointerCapture(ev.pointerId); } catch (e) {}
      ev.preventDefault();
    });

    head.addEventListener('pointermove', function (ev) {
      if (!drag || ev.pointerId !== drag.id) return;
      var maxX = Math.max(0, drag.boxRect.width - drag.w);
      var maxY = Math.max(0, drag.boxRect.height - drag.h);
      var x = Math.max(0, Math.min(maxX, ev.clientX - drag.boxRect.left - drag.dx));
      var y = Math.max(0, Math.min(maxY, ev.clientY - drag.boxRect.top - drag.dy));
      card.style.left = Math.round(x) + 'px';
      card.style.top = Math.round(y) + 'px';
      card.style.right = 'auto';
      ev.preventDefault();
    });

    function endDrag() {
      if (!drag) return;
      card.classList.remove('dragging');
      var maxX = Math.max(0, drag.boxRect.width - drag.w);
      var maxY = Math.max(0, drag.boxRect.height - drag.h);
      var x = parseFloat(card.style.left) || 0;
      var y = parseFloat(card.style.top) || 0;
      dragPos = { x: maxX > 0 ? x / maxX : 0, y: maxY > 0 ? y / maxY : 0 };
      try { localStorage.setItem(DRAG_KEY, JSON.stringify(dragPos)); } catch (e) {}
      drag = null;
    }

    head.addEventListener('pointerup', endDrag);
    head.addEventListener('pointercancel', endDrag);
  }

  function onMarket(sym, meta) {
    var next = String(sym || '');
    if (!next) return;
    var changed = next !== symbol;
    symbol = next;
    if (meta && meta.digits !== undefined) digits = Number(meta.digits) || digits;
    if (changed) {
      prints = [];
      renderWhales();
      renderNews();
      fetchTape();
    }
  }

  function init() {
    build();
    if (!root) return;

    dragPos = loadDragPos();
    makeDraggable();
    applyDragPos();
    // The chart box resizes between the TradingView frame and the indicator
    // panes (and on window resize): keep the parked card inside it.
    window.addEventListener('resize', applyDragPos);
    window.addEventListener('chart:refresh', applyDragPos);
    if (typeof ResizeObserver === 'function') {
      try { new ResizeObserver(function () { applyDragPos(); }).observe(box); } catch (e) {}
    }

    // One click back to the candle chart, where the whale markers sit on the
    // exact candle the print happened in.
    var hint = $('tvo-candle-hint');
    if (hint) {
      hint.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        var toggle = $('tv-chart-toggle');
        if (toggle) toggle.click();
      });
    }

    var term = window.SoftradeXTerminal;
    var cur = term && typeof term.getCurrentSymbol === 'function' ? term.getCurrentSymbol() : '';
    if (cur) onMarket(cur, null);

    window.addEventListener('chart:market', function (ev) {
      var d = (ev && ev.detail) || {};
      onMarket(d.symbol || (d.meta && d.meta.symbol), d.meta);
    });

    window.addEventListener('chart:snapshot', function (ev) {
      var d = (ev && ev.detail) || {};
      if (d.symbol && d.symbol !== symbol) onMarket(d.symbol, d.meta);
      if (!tapeAt || Date.now() - tapeAt > TAPE_MS) fetchTape();
    });

    // TradingView mounted/toggled: rebuild the tape + calendar for the market
    // that is on screen right now.
    window.addEventListener('chart:refresh', function () {
      fetchTape();
      refreshNewsSource();
    });

    // Buyer/seller pressure aggregated by chart-workspace.js from the open
    // multi-venue board. It is overlaid on the chart but remains an advisory.
    window.addEventListener('chart:pressure', function (ev) {
      var d = (ev && ev.detail) || {};
      if (d.symbol && !marketMatch(d.symbol, symbol)) return;
      var el = $('tvo-pressure');
      if (!el) {
        el = document.createElement('div');
        el.id = 'tvo-pressure';
        el.className = 'tvo-pressure';
        box.appendChild(el);
      }
      var side = String(d.side || 'WAIT');
      el.className = 'tvo-pressure ' + side.toLowerCase();
      el.innerHTML = '<span>BUYER ' + esc(d.buyPct) + '%</span><b>' + esc(side) + '</b><span>SELLER ' + esc(d.sellPct) + '%</span><em>' + esc(d.confidence) + '% confidence · advisory</em>';
    });

    setInterval(function () { if (!document.hidden) fetchTape(); }, TAPE_MS);
    setInterval(function () { if (!document.hidden) refreshNewsSource(); }, NEWS_MS);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) { fetchTape(); refreshNewsSource(); }
    });

    refreshNewsSource();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    setTimeout(init, 300);
  }

  window.ChartOverlay = {
    current: function () { return { symbol: symbol, prints: prints.length }; },
    refresh: function () { fetchTape(); refreshNewsSource(); }
  };
})();
