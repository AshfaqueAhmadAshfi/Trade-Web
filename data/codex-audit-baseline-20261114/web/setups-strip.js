/* Setups strip - the extreme execution levels as a sliding ticker.
   --------------------------------------------------------------------------
   The chart header used to show 24h high / low / tick volume there. Those three
   numbers are gone; in their place the same ten levels the setups board prices
   (/api/chart/candles daily + /api/chart/ticker) slide through here:

     · three levels side by side
     · ‹ / › slide one page (three levels) at a time
     · a page turns itself every 10 s, and the clock restarts on any click or
       while the pointer rests on the strip - hover means "I am reading this".
   -------------------------------------------------------------------------- */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };

  var PAGE_SIZE = 3;
  var AUTO_MS = 10000;
  var POLL_MS = 2000;

  var track = null;
  var index = 0;
  var pages = 0;
  var sig = '';
  var timer = null;
  var hovering = false;
  var lastLevels = null;

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
  function pct(v) {
    var n = Number(v);
    return isFinite(n) && n >= 0 ? n.toFixed(2) + '%' : '—';
  }

  function chips(levels, price) {
    return levels.map(function (lv) {
      var buy = String(lv.action || '').toUpperCase() === 'BUY';
      var cls = buy ? 'buy' : 'sell';
      var dist = price > 0 ? Math.abs(price - Number(lv.price)) / price * 100 : null;
      return '<div class="bset-chip ' + cls + '">' +
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
    var html = '';
    for (var i = 0; i < sorted.length; i += PAGE_SIZE) {
      html += '<div class="bset-page">' + chips(sorted.slice(i, i + PAGE_SIZE), price) + '</div>';
    }
    track.innerHTML = html || '<div class="bset-empty">No daily levels yet.</div>';
    pages = Math.ceil(sorted.length / PAGE_SIZE);
    if (index >= pages) index = 0;
    move(false);
  }

  function move(animate) {
    if (!track) return;
    track.style.transition = animate === false ? 'none' : 'transform .45s cubic-bezier(.4,0,.2,1)';
    track.style.transform = 'translateX(' + (-index * 100) + '%)';
  }

  function step(dir) {
    if (pages <= 1) return;
    index = (index + dir + pages) % pages;
    move();
    restart();
  }

  function restart() {
    if (timer) clearInterval(timer);
    timer = setInterval(function () {
      if (hovering || pages <= 1) return;
      index = (index + 1) % pages;
      move();
    }, AUTO_MS);
  }

  function poll() {
    var st = window.TvSetups && typeof window.TvSetups.state === 'function'
      ? window.TvSetups.state() : null;
    if (!st || !Array.isArray(st.levels) || !st.levels.length) return;
    var levels = st.levels;
    var price = Number(st.price) || 0;
    var next = levels.map(function (l) { return l.label + l.price; }).join('|') + '#' + Math.round(price * 100);
    if (next === sig) return;
    sig = next;
    lastLevels = levels;
    render(levels, price);
  }

  function init() {
    track = $('bset-track');
    var strip = $('b-strip-setups');
    if (!track || !strip) return;

    var prev = $('bset-prev');
    var next = $('bset-next');
    if (prev) prev.addEventListener('click', function () { step(-1); });
    if (next) next.addEventListener('click', function () { step(1); });

    strip.addEventListener('mouseenter', function () { hovering = true; });
    strip.addEventListener('mouseleave', function () { hovering = false; restart(); });
    strip.addEventListener('focusin', function () { hovering = true; });
    strip.addEventListener('focusout', function () { hovering = false; restart(); });

    poll();
    restart();
    setInterval(poll, POLL_MS);
    window.addEventListener('chart:refresh', poll);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
