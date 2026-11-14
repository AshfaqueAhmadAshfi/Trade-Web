/* Chart workspace controls: expanded/fullscreen chart + order-flow + 24h news.
   The calculations shown here are explicitly estimates; no signal is a promise. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var section, workspace, button, icon, label, symbol = '', news = [], newsSig = '';
  var refreshTimer = null;

  function marketKey(v) { return String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
  function marketMatch(a, b) {
    var x = marketKey(a), y = marketKey(b);
    if (!x || !y) return false;
    if (x === y) return true;
    var gold = function (s) { return s.indexOf('XAU') === 0 || s.indexOf('GOLD') === 0; };
    if (gold(x) && gold(y)) return true;
    var s = x.length < y.length ? x : y, l = x.length < y.length ? y : x;
    return s.length >= 5 && l.indexOf(s) === 0 && l.length - s.length <= 4;
  }
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function(c) { return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function impactFor(ev) {
    var arr = Array.isArray(ev.impacted_markets) ? ev.impacted_markets : (Array.isArray(ev.impacted) ? ev.impacted : []);
    for (var i = 0; i < arr.length; i++) if (marketMatch(arr[i].market, symbol)) return arr[i];
    return null;
  }
  function normSide(v) {
    v = String(v || '').toUpperCase();
    return /BUY|UP|BULL/.test(v) ? 'BUY' : /SELL|DOWN|BEAR/.test(v) ? 'SELL' : 'WAIT';
  }
  function moveFor(ev, imp) {
    var p = (imp && (imp.move_abs != null ? imp.move_abs : imp.move_dollar));
    if (p == null && ev.predicted_move) p = ev.predicted_move.move_abs != null ? ev.predicted_move.move_abs : ev.predicted_move.move_dollar;
    p = Math.abs(Number(p) || 0);
    if (!p) return '—';
    return '$' + (p >= 100 ? p.toFixed(0) : p >= 1 ? p.toFixed(2) : p.toFixed(4)).replace(/\.?0+$/, '');
  }
  function eventTime(ts) {
    return new Date(Number(ts) * 1000).toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  function renderNews() {
    var list = $('mnt-list'), count = $('mnt-count'), market = $('mnt-market');
    if (!list) return;
    if (market) market.textContent = symbol || 'MARKET';
    var now = Date.now() / 1000, end = now + 24 * 3600;
    var rows = news.map(function(ev) { return { ev: ev, imp: impactFor(ev) }; })
      .filter(function(x) { var t = Number(x.ev.ts); return t >= now - 120 && t <= end && !!x.imp; })
      .sort(function(a, b) { return Number(a.ev.ts) - Number(b.ev.ts); });
    if (count) count.textContent = rows.length + (rows.length === 1 ? ' EVENT' : ' EVENTS');
    if (!rows.length) {
      list.innerHTML = '<div class="mnt-empty">No verified ' + esc(symbol || 'selected-market') + ' event in the next 24 hours.</div>';
      return;
    }
    list.innerHTML = rows.map(function(x) {
      var ev = x.ev, imp = x.imp;
      var impact = String(ev.impact || 'low').toLowerCase();
      if (['low','medium','high'].indexOf(impact) < 0) impact = 'low';
      var side = normSide(imp.side || imp.direction || ev.side);
      var signed = side === 'BUY' ? '+' : side === 'SELL' ? '−' : '±';
      return '<article class="mnt-row ' + impact + '">' +
        '<time>' + esc(eventTime(ev.ts)) + '</time>' +
        '<span class="mnt-impact">' + impact.toUpperCase() + '</span>' +
        '<div class="mnt-event"><b>' + esc(ev.title || ev.event || 'Economic event') + '</b><small>' + esc(ev.currency || ev.country || '') + ' · ' + esc(ev.source || 'calendar') + '</small></div>' +
        '<span class="mnt-side ' + side.toLowerCase() + '">' + side + '</span>' +
        '<strong class="mnt-move ' + side.toLowerCase() + '">' + signed + moveFor(ev, imp) + '</strong>' +
      '</article>';
    }).join('');
  }
  function fetchNews() {
    fetch('/api/state' + (newsSig ? '?have=' + encodeURIComponent(newsSig) : ''), { cache: 'no-store' })
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(st) {
        if (st && st.bot5) {
          if (st.bot5.news_sig) newsSig = st.bot5.news_sig;
          if (Array.isArray(st.bot5.news)) news = st.bot5.news;
        }
        var o = window.ChartNewsOverlay;
        if ((!news.length) && o && typeof o.getEvents === 'function') news = o.getEvents() || [];
        renderNews();
      }).catch(renderNews);
  }
  function renderPressure() {
    var flow = window.MultiExchangeOrderFlow;
    var t = flow && typeof flow.getOpenTotals === 'function' ? flow.getOpenTotals() : null;
    var buy = Number(t && t.buy) || 0, sell = Number(t && t.sell) || 0, total = buy + sell;
    var pct = total ? Math.round(buy / total * 100) : 50;
    var edge = Math.abs(pct - 50) * 2;
    var side = edge < 12 ? 'WAIT' : pct > 50 ? 'BUY' : 'SELL';
    var s = $('vfb-advisory-side'), c = $('vfb-advisory-confidence'), bar = $('vfb-advisory-buy'), reason = $('vfb-advisory-reason');
    if (s) { s.textContent = side; s.className = side.toLowerCase(); }
    if (c) c.textContent = edge + '% confidence';
    if (bar) bar.style.width = pct + '%';
    if (reason) reason.textContent = total ? ('Verified venue/open-position flow: BUY ' + pct + '% · SELL ' + (100-pct) + '%. Advisory, not a guarantee.') : 'Waiting for verified live flow. Estimates are not trade guarantees.';
    window.dispatchEvent(new CustomEvent('chart:pressure', { detail: { symbol: symbol, buyPct: pct, sellPct: 100-pct, side: side, confidence: edge, buy: buy, sell: sell } }));
  }
  function expanded() { return section && section.classList.contains('workspace-expanded'); }
  function syncButton() {
    var on = expanded();
    if (button) { button.setAttribute('aria-pressed', on ? 'true' : 'false'); button.classList.toggle('active', on); }
    if (icon) icon.textContent = on ? '✕' : '⛶';
    if (label) label.textContent = on ? 'Exit' : 'Expand';
  }
  function setExpanded(on) {
    if (!section) return;
    section.classList.toggle('workspace-expanded', !!on);
    document.documentElement.classList.toggle('chart-workspace-open', !!on);
    syncButton();
    setTimeout(function() { window.dispatchEvent(new Event('resize')); }, 80);
  }
  function toggle() {
    if (expanded()) {
      if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(function(){});
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (section.requestFullscreen) section.requestFullscreen({ navigationUI: 'hide' }).catch(function(){});
  }
  function init() {
    section = $('binance-terminal-section'); workspace = $('binance-term-workspace'); button = $('binance-term-expand');
    icon = $('b-expand-icon'); label = $('b-expand-text');
    if (!section || !workspace || !button) return;
    button.addEventListener('click', toggle);
    document.addEventListener('fullscreenchange', function() { if (!document.fullscreenElement && expanded()) setExpanded(false); });
    document.addEventListener('keydown', function(e) { if (e.key === 'Escape' && expanded() && !document.fullscreenElement) setExpanded(false); });
    var t = window.SoftradeXTerminal;
    symbol = t && t.getCurrentSymbol ? String(t.getCurrentSymbol() || '') : 'XAUUSDm';
    window.addEventListener('chart:market', function(e) { var d = e.detail || {}; symbol = String(d.symbol || (d.meta && d.meta.symbol) || symbol); renderNews(); renderPressure(); });
    window.addEventListener('chart:refresh', function() { fetchNews(); renderPressure(); });
    window.addEventListener('orderflow:update', function(e) {
      var d = (e && e.detail) || {};
      if (!d.symbol || marketMatch(d.symbol, symbol)) renderPressure();
    });
    refreshTimer = setInterval(function() { if (!document.hidden) { fetchNews(); renderPressure(); } }, 15000);
    fetchNews(); renderPressure(); syncButton();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  window.ChartWorkspace = { expand: function(){setExpanded(true);}, close: function(){setExpanded(false);}, refresh: function(){fetchNews();renderPressure();} };
})();
