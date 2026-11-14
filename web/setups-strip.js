/* All available extreme levels in one compact grid, nearest first. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };

  var POLL_MS = 2000;

  var track = null;
  var heading = null;
  var sig = '';

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function px(v) {
    var n = Number(v);
    if (!isFinite(n) || n <= 0) return '—';
    var decimals = n >= 1000 ? 2 : n >= 10 ? 3 : 5;
    return n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  }
  function pct(v) {
    if (v == null) return '—';
    var n = Number(v);
    return isFinite(n) && n >= 0 ? n.toFixed(2) + '%' : '—';
  }

  function chips(levels, price) {
    return levels.map(function (lv) {
      var buy = String(lv.action || '').toUpperCase() === 'BUY';
      var cls = buy ? 'buy' : 'sell';
      var dist = price > 0 ? Math.abs(price - Number(lv.price)) / price * 100 : null;
      return '<div class="bset-chip ' + cls + '" title="' + esc(lv.label + ' · ' + (lv.scope || '') + ' · ' + (buy ? 'BUY' : 'SELL')) + '">' +
        '<span class="bset-side">' + (buy ? '▲' : '▼') + '</span>' +
        '<span class="bset-body"><b>' + esc(lv.label || 'Level') + '</b>' +
        '<small>' + esc(lv.scope || '') + '</small></span>' +
        '<span class="bset-dist">' + pct(dist) + '</span>' +
        '<span class="bset-price">' + px(lv.price) + '</span>' +
      '</div>';
    }).join('');
  }

  function render(levels, price) {
    if (!track) return;
    var sorted = levels.slice().sort(function (a, b) {
      return Math.abs(price - Number(a.price)) - Math.abs(price - Number(b.price));
    });
    track.innerHTML = chips(sorted, price) || '<div class="bset-empty">Waiting for daily levels…</div>';
    if (heading) heading.textContent = sorted.length ? 'NEXT ' + sorted.length + ' EXTREME SETUPS' : 'EXTREME SETUPS';
  }

  function poll() {
    var st = window.TvSetups && typeof window.TvSetups.state === 'function'
      ? window.TvSetups.state() : null;
    if (!st || !Array.isArray(st.levels)) return;
    var levels = st.levels;
    var price = Number(st.price) || 0;
    var next = JSON.stringify([st.symbol, price, levels]);
    if (next === sig) return;
    sig = next;
    render(levels, price);
  }

  function init() {
    track = $('bset-track');
    var strip = $('b-strip-setups');
    if (!track || !strip) return;
    heading = $('bset-heading');

    poll();
    setInterval(poll, POLL_MS);
    window.addEventListener('chart:refresh', poll);
    window.addEventListener('chart:market', poll);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
