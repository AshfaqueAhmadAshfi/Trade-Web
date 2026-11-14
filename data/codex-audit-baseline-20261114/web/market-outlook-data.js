/* Independent daily candle reads for dashboard estimates.
   Two requests at a time, persistent ten-minute cache and event-market priority. */
(function (root) {
  'use strict';
  function create(options) {
    const now = options.now || Date.now;
    const cache = new Map(), queued = new Set(), pending = new Set(), queue = [], restored = new Set();
    const ttl = 10 * 60 * 1000, retry = 2 * 60 * 1000;
    const storagePrefix = 'softradex.outlook.daily.v1.';
    let priority = new Set();
    let watched = [], active = 0;
    const key = symbol => root.DashboardPanels.canonical(symbol);
    function cached(symbol) {
      const id = key(symbol);
      if (!cache.has(id) && !restored.has(id)) {
        restored.add(id);
        try {
          const saved = JSON.parse(options.storage && options.storage.getItem(storagePrefix + id) || 'null');
          if (saved && Number(saved.at) > 0 && now() - saved.at < ttl && saved.at <= now() + 5000 &&
              saved.read && saved.read.ready && Number.isFinite(saved.read.score) && Number.isFinite(saved.read.atr)) {
            cache.set(id, { at: Number(saved.at), until: Number(saved.at) + ttl,
              read: saved.read, source: saved.source });
          }
        } catch (_) { /* Storage can be disabled; live reads still work. */ }
      }
      return cache.get(id);
    }
    function get(symbol) {
      const row = cached(symbol);
      if (!row || !row.read || now() - row.at >= ttl) return null;
      return { symbol, fresh: true, source: row.source,
        vote: { score: row.read.score * 3 }, reads: { D1: row.read } };
    }
    async function load(symbol) {
      const id = key(symbol);
      pending.add(id);
      active++;
      try {
        const data = await options.request(symbol);
        if (key(data.symbol) !== id) throw new Error('Wrong market candle response');
        const time = now();
        const bars = (data.bars || []).filter(b => Array.isArray(b) && Number(b[0]) > 0 &&
          Number(b[0]) + 86400000 <= time).sort((a,b) => a[0]-b[0]);
        const last = bars[bars.length-1];
        if (!last || time - Number(last[0]) > 4 * 86400000) throw new Error('Daily history is stale');
        const reading = options.analyze(bars, Number(last[4]), 'D1');
        if (!reading || !reading.ready) throw new Error('Not enough closed daily candles');
        cache.set(id, { at: time, until: time + ttl, read: reading,
          source: data.meta && data.meta.source || 'public daily candles' });
        try {
          if (options.storage) options.storage.setItem(storagePrefix + id, JSON.stringify(cache.get(id)));
        } catch (_) { /* Quota/private mode must not block analysis. */ }
      } catch (error) {
        cache.set(id, { at: now(), until: now() + retry, error: String(error.message || error) });
      } finally {
        pending.delete(id);
        active--;
        if (options.notify) options.notify();
        pump();
      }
    }
    function pump() {
      while (active < 2 && queue.length) {
        const symbol = queue.shift();
        queued.delete(key(symbol));
        void load(symbol);
      }
    }
    function prioritize(symbols) {
      priority = new Set((symbols || []).map(key));
      queue.sort((a,b) => Number(priority.has(key(b))) - Number(priority.has(key(a))));
      pump();
    }
    function ensure(symbols, selected) {
      watched = root.DashboardPanels.marketList(symbols, selected);
      watched.forEach(symbol => {
        const id = key(symbol), row = cached(symbol);
        if (pending.has(id) || queued.has(id) || row && now() < row.until) return;
        queued.add(id);
        queue.push(symbol);
      });
      prioritize([...priority]);
    }
    function status() {
      return { total: watched.length, ready: watched.filter(s => get(s)).length,
        pending: pending.size + queue.length,
        unavailable: watched.filter(s => cache.get(key(s))?.error).length };
    }
    return { ensure, get, status, prioritize };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { create };
  if (root.document) {
    let repaint = null;
    root.MarketOutlookData = create({
      storage: { getItem: key => root.localStorage.getItem(key),
        setItem: (key, value) => root.localStorage.setItem(key, value) },
      request: async symbol => {
        const response = await fetch('/api/chart/candles?symbol=' + encodeURIComponent(symbol) + '&tf=1d&count=80',
          { cache: 'no-store', signal: AbortSignal.timeout(18000) });
        if (!response.ok) throw new Error('Daily candle API unavailable');
        return response.json();
      },
      analyze: (...args) => root.SwingAI.analyzeCandles(...args),
      notify: () => {
        if (repaint) return;
        repaint = setTimeout(() => {
          repaint = null;
          root.dispatchEvent(new CustomEvent('market:outlook-data'));
        }, 1000);
      }
    });
  }
})(typeof window === 'undefined' ? globalThis : window);
