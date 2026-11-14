/* Estimated SL concentrations, never private stop orders.
   Reuses SwingAI's public M5/M15 candles and the shared TradingView quote.
   Confirmed, unswept swing pivots provide evidence; repeated levels cluster.
   Zones keep their first projected TV price so they cannot follow price away
   from a hit. Observed crossings suppress the same pivot evidence on reload. */
(function () {
  'use strict';
  var symbol = '', quote = null, zones = [], suppressed = Object.create(null);
  var lastStructureAt = 0, hitCount = 0, note = 'Waiting for market structure';
  var KEEP_MS = 3 * 86400000, QUOTE_MS = 15000;
  var $ = function(id) { return document.getElementById(id); };
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function(c) {
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
  }); }
  function px(v) { return Number(v).toLocaleString('en-US', {
    minimumFractionDigits: v < 10 ? 5 : 2, maximumFractionDigits: v < 10 ? 5 : 2
  }); }
  function fresh() { return !!(quote && Date.now() - quote.at <= QUOTE_MS && quote.at <= Date.now() + 5000); }
  function storageKey() { return 'softradex.slzones.v1.' + symbol; }
  function save() {
    try { localStorage.setItem(storageKey(), JSON.stringify({zones:zones, suppressed:suppressed})); } catch(e) {}
  }
  function restore() {
    zones = []; suppressed = Object.create(null);
    try {
      var saved = JSON.parse(localStorage.getItem(storageKey()) || '{}');
      var cutoff = Date.now() - KEEP_MS;
      if (Array.isArray(saved.zones)) zones = saved.zones.filter(function(z) {
        return (z.side === 'buy' || z.side === 'sell') && Number(z.price) > 0 && z.created > cutoff && Array.isArray(z.evidence);
      });
      Object.keys(saved.suppressed || {}).forEach(function(k) {
        if (Number(saved.suppressed[k]) > cutoff) suppressed[k] = Number(saved.suppressed[k]);
      });
    } catch(e) {}
  }
  function setSymbol(next) {
    if (!next || next === symbol) return;
    symbol = String(next); quote = null; lastStructureAt = 0; hitCount = 0;
    note = 'Waiting for selected-market structure'; restore(); paint();
  }
  function pruneHits() {
    if (!fresh()) return;
    var removed = false;
    zones = zones.filter(function(z) {
      var crossed = z.side === 'buy' ? quote.price <= z.price : quote.price >= z.price;
      if (crossed) {
        z.evidence.forEach(function(key) { suppressed[key] = Date.now(); });
        hitCount++; removed = true;
      }
      return !crossed && z.created > Date.now() - KEEP_MS;
    });
    if (removed) save();
  }
  function acceptQuote(q) {
    if (!q || q.symbol !== symbol || !q.tv_symbol || !(Number(q.price) > 0) || !Number(q.at)) return;
    if (Date.now() - q.at > QUOTE_MS || q.at > Date.now() + 5000 || (quote && q.at < quote.at)) return;
    quote = {price:Number(q.price), at:Number(q.at), tv_symbol:q.tv_symbol};
    pruneHits(); scan(); paint();
  }
  function barTime(v) { return Number(v) < 1e11 ? Number(v) * 1000 : Number(v); }
  function barsFor(rows, duration) {
    return (rows || []).filter(function(b) {
      return Array.isArray(b) && b.length >= 5 && barTime(b[0]) + duration <= Date.now() &&
        [1,2,3,4].every(function(i) { return isFinite(Number(b[i])) && Number(b[i]) > 0; });
    }).slice().sort(function(a,b) { return Number(a[0]) - Number(b[0]); });
  }
  function atrOf(bars) {
    var values = [];
    for (var i = Math.max(1, bars.length - 14); i < bars.length; i++) {
      values.push(Math.max(bars[i][2] - bars[i][3], Math.abs(bars[i][2] - bars[i-1][4]), Math.abs(bars[i][3] - bars[i-1][4])));
    }
    return values.length ? values.reduce(function(a,b) { return a+b; }, 0) / values.length : 0;
  }
  function pivotEvidence(rows, tf, duration, price) {
    var bars = barsFor(rows, duration), out = [];
    if (bars.length < 15) return out;
    var scale = price / Number(bars[bars.length - 1][4]);
    var a = atrOf(bars), buffer = Math.max(a * 0.12, Number(bars[bars.length - 1][4]) * 0.000015);
    for (var i = 2; i < bars.length - 2; i++) {
      var b = bars[i], neighbours = [bars[i-2],bars[i-1],bars[i+1],bars[i+2]];
      ['buy','sell'].forEach(function(side) {
        var index = side === 'buy' ? 3 : 2, value = Number(b[index]);
        var pivot = neighbours.every(function(n) { return side === 'buy' ? value <= n[index] : value >= n[index]; }) &&
          neighbours.some(function(n) { return value !== Number(n[index]); });
        if (!pivot) return;
        var stop = value + (side === 'buy' ? -buffer : buffer);
        // Ignore levels already swept in their own source history.
        var swept = bars.slice(i+1).some(function(n) { return side === 'buy' ? n[3] <= stop : n[2] >= stop; });
        var projected = stop * scale, key = tf + ':' + side + ':' + barTime(b[0]);
        if (swept || suppressed[key] || !(projected > 0)) return;
        if (side === 'buy' ? projected >= price : projected <= price) return;
        out.push({side:side, price:projected, key:key, time:barTime(b[0]), tf:tf, band:a * scale * 0.18});
      });
    }
    return out;
  }
  function groupEvidence(candidates, price) {
    var groups = [];
    ['buy','sell'].forEach(function(side) {
      var cur = null;
      candidates.filter(function(c) { return c.side === side; }).sort(function(a,b) { return a.price-b.price; }).forEach(function(c) {
        var band = Math.max(c.band, price * 0.00004);
        if (!cur || Math.abs(c.price - cur.price) > band) {
          cur = {side:side, price:c.price, members:[]}; groups.push(cur);
        }
        cur.members.push(c);
        cur.price = cur.members.reduce(function(sum,m) { return sum+m.price; }, 0) / cur.members.length;
      });
    });
    return groups;
  }
  function scan() {
    if (!fresh() || !window.SwingAI || typeof window.SwingAI.structure !== 'function') return;
    var h = window.SwingAI.structure();
    if (!h || h.symbol !== symbol || !h.at || h.at === lastStructureAt) return;
    var frames = h.frames || {}, candidates = pivotEvidence(frames.M5, 'M5', 300000, quote.price)
      .concat(pivotEvidence(frames.M15, 'M15', 900000, quote.price));
    var groups = groupEvidence(candidates, quote.price), previous = zones, used = Object.create(null);
    zones = groups.map(function(g) {
      var evidence = g.members.map(function(m) { return m.key; }).sort();
      var old = previous.find(function(z) {
        return !used[z.id] && z.side === g.side && z.evidence.some(function(k) { return evidence.indexOf(k) >= 0; });
      });
      var touches = Object.create(null);
      g.members.forEach(function(m) { touches[Math.floor(m.time / 300000)] = true; });
      var id = old ? old.id : evidence[0]; used[id] = true;
      return {id:id, side:g.side, price:old ? old.price : g.price, evidence:evidence,
        touches:Object.keys(touches).length, frames:Array.from(new Set(g.members.map(function(m) { return m.tf; }))),
        created:old ? old.created : Date.now(), updated:Date.now()};
    });
    lastStructureAt = h.at;
    note = 'M5 / M15 · public structure';
    pruneHits(); save();
  }
  function ranked(side) {
    return zones.filter(function(z) { return z.side === side; }).sort(function(a,b) {
      return b.touches-a.touches || Math.abs(a.price-(quote ? quote.price : 0))-Math.abs(b.price-(quote ? quote.price : 0));
    });
  }
  function paint() {
    if (!$('stop-liquidity-panel')) return;
    if ($('slz-market')) $('slz-market').textContent = symbol || 'MARKET';
    if ($('slz-price')) $('slz-price').textContent = quote ? px(quote.price) : '—';
    if ($('slz-status')) $('slz-status').textContent = !fresh() ? 'TV quote stale / unavailable' : note;
    ['buy','sell'].forEach(function(side) {
      var list = $('slz-' + side + '-list'), rows = ranked(side), opened = Object.create(null);
      if (!list) return;
      if (list.querySelectorAll) Array.prototype.forEach.call(list.querySelectorAll('details[open]'), function(el) { opened[el.dataset.key] = true; });
      if ($('slz-' + side + '-count')) $('slz-' + side + '-count').textContent = (rows.length > 4 ? 'Top 4 / ' : '') + rows.length + ' zones';
      var html = rows.slice(0,4).map(function(z) {
        var density = z.touches >= 4 ? 'HIGH' : z.touches >= 2 ? 'MED' : 'LOW';
        var dist = quote ? Math.abs(z.price-quote.price)/quote.price*100 : 0;
        return '<details class="slz-row ' + side + '" data-key="' + esc(z.id) + '"' + (opened[z.id] ? ' open' : '') + '><summary>' +
          '<b>' + esc(px(z.price)) + '</b><span>' + z.touches + ' touches</span><em>' + density + '</em><i>›</i></summary>' +
          '<div class="slz-details">Estimated stop area for ' + (side === 'buy' ? 'long / BUY' : 'short / SELL') + ' positions · ' + dist.toFixed(2) + '% from TV price.<br>' +
          esc(z.frames.join(' + ')) + ' confirmed pivots; concentration ranks repeated structure, not actual SL order counts.<br>' +
          'First model level at ' + esc(new Date(z.created).toLocaleTimeString()) + '. Removed on an observed TV-price crossing.</div></details>';
      }).join('') || '<div class="slz-empty">No unswept ' + (side === 'buy' ? 'lower' : 'upper') + ' zone confirmed yet.</div>';
      if (list.innerHTML !== html) list.innerHTML = html;
    });
    if ($('slz-foot')) $('slz-foot').textContent = (hitCount ? hitCount + ' crossed zone(s) removed · ' : '') +
      'Estimated levels · TV quote crossings only; brief touches between quotes may be missed.';
    window.dispatchEvent(new CustomEvent('chart:liquidity-zones', {detail:snapshot()}));
  }
  function refresh() { acceptQuote(window.SOFT_TV_QUOTE); scan(); paint(); }
  function init() {
    if (!$('stop-liquidity-panel')) return;
    var term = window.SoftradeXTerminal;
    setSymbol(term && term.getCurrentSymbol ? term.getCurrentSymbol() : 'XAUUSDm');
    window.addEventListener('chart:market', function(ev) { var d = ev.detail || {}; setSymbol(d.symbol || (d.meta && d.meta.symbol)); refresh(); });
    window.addEventListener('chart:tv-quote', function(ev) { acceptQuote(ev.detail); });
    window.addEventListener('chart:refresh', refresh);
    document.addEventListener('visibilitychange', function() { if (!document.hidden) refresh(); });
    setInterval(function() { if (!document.hidden) refresh(); }, 3000);
    refresh();
  }
  function snapshot() {
    var visible = ranked('buy').slice(0,4).concat(ranked('sell').slice(0,4));
    return {symbol:symbol, price:quote ? quote.price : 0, fresh:fresh(), source:'estimated public structure',
      tvSymbol:quote ? quote.tv_symbol : '',
      zones:zones.map(function(z) { return Object.assign({}, z); }),
      visibleZones:visible.map(function(z) { return Object.assign({}, z); }), removed:hitCount, structureAt:lastStructureAt};
  }
  window.StopLiquidity = {refresh:refresh, state:snapshot};
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
