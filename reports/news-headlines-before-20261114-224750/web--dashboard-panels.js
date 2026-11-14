/* Shared data rules for dashboard cards and the all-market next-day outlook. */
(function (root) {
  'use strict';
  function canonical(value) {
    const key = String(value || '').replace(/m$/, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    return ({ XAUUSD247: 'XAUUSD', GOLD: 'XAUUSD', BTCUSD: 'BTCUSDT', ETHUSD: 'ETHUSDT',
      NAS100: 'USTEC', USTECX100: 'USTEC', NDX: 'USTEC' })[key] || key;
  }
  function marketList(symbols, selected) {
    const seen = new Set(), rows = [];
    // Keep catalogue order; selecting a market only moves its row to the top.
    [selected].concat(symbols || []).forEach(value => {
      const symbol = typeof value === 'string' ? value : value && value.symbol;
      const key = canonical(symbol);
      if (!key || seen.has(key)) return;
      seen.add(key);
      rows.push(symbol);
    });
    return rows;
  }
  function impactSeconds(event) {
    return Math.min(21600, Math.max(60, Number(event.impact_window_sec) ||
      ({ high: 3600, medium: 1800, low: 900 })[event.impact] || 900));
  }
  function newsKind(event) {
    return event.kind || (['google-news', 'investing.com', 'yahoo-finance', 'exness', 'binance'].includes(event.source)
      ? 'headline' : 'calendar');
  }
  function newsExpires(event) {
    return Number(event.ts) + impactSeconds(event);
  }
  function newsPhase(event, now) {
    const start = Number(event.ts);
    if (!(start > 0) || !Number.isFinite(start) || now >= newsExpires(event)) return 'expired';
    if (newsKind(event) === 'headline') return now < start ? 'expired' : 'context';
    return now < start ? 'upcoming' : 'running';
  }
  function selectEvent(events, symbol, impact, now, relevant) {
    const rows = (events || []).filter(e => e && newsKind(e) !== 'headline' &&
      newsPhase(e, now) !== 'expired' && (!impact || e.impact === impact) && relevant(e, symbol));
    rows.sort((a, b) => Number(a.ts) - Number(b.ts));
    return rows.find(e => Number(e.ts) > now) || rows[rows.length - 1] || null;
  }
  function eventImpacts(event, symbols, selected, now, relevant, estimate, contextFor, news) {
    if (!event) return [];
    const headlines = (news || []).filter(e => e && newsPhase(e, now) === 'context');
    return marketList(symbols, selected).filter(symbol => relevant(event, symbol)).map(symbol => {
      const context = contextFor ? contextFor(symbol) || {} : {};
      const market = context.market && canonical(context.market.symbol) === canonical(symbol)
        ? { ...context.market, symbol } : null;
      const quote = context.quote && canonical(context.quote.symbol) === canonical(symbol)
        ? { ...context.quote, symbol } : null;
      let reading = estimate(event, symbol, { market, quote,
        headlines: headlines.filter(e => relevant(e, symbol)) });
      if (reading && reading.market && canonical(reading.market) !== canonical(symbol)) reading = null;
      const side = reading && ['BUY', 'SELL'].includes(reading.side) ? reading.side : '';
      return { market: symbol, side, direction: side === 'BUY' ? 'UP' : side === 'SELL' ? 'DOWN' : '',
        strength: side ? Math.max(0, Math.min(90, Number(reading.strength) || 0)) : 0,
        move_abs: side ? Math.max(0, Number(reading.move_abs) || 0) : 0,
        reason: reading && reading.reason || 'Relevant event; directional evidence is not available yet.' };
    });
  }
  function tomorrowWindow(now) {
    const start = new Date(now * 1000);
    start.setDate(start.getDate() + 1);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return { start: start.getTime() / 1000, end: end.getTime() / 1000 };
  }
  function outlook(events, symbol, now, relevant, estimate, market, quote) {
    const window = tomorrowWindow(now), seen = new Set();
    let buy = 0, sell = 0, buyPoints = 0, sellPoints = 0, top = null;
    (events || []).filter(e => e && e.kind !== 'headline' && Number(e.ts) >= window.start &&
      Number(e.ts) < window.end && relevant(e, symbol)).sort((a, b) => a.ts - b.ts).forEach(e => {
        const key = [e.ts, e.currency || e.country, String(e.title || '').toLowerCase()].join('|');
        if (seen.has(key)) return;
        seen.add(key);
        const reading = estimate(e);
        if (!reading || !['BUY', 'SELL'].includes(reading.side)) return;
        const weight = ({ high: 3, medium: 2, low: 1 })[e.impact] || 1;
        if (reading.side === 'BUY') { buy++; buyPoints += weight; }
        else { sell++; sellPoints += weight; }
        if (!top) top = e;
      });
    const same = market && canonical(market.symbol) === canonical(symbol);
    const technical = same && market.fresh && market.vote ? Number(market.vote.score) || 0 : 0;
    let verdict = buyPoints > sellPoints ? 'BUY' : sellPoints > buyPoints ? 'SELL' :
      technical >= 2 ? 'BUY' : technical <= -2 ? 'SELL' :
        buy + sell || (same && market.fresh && market.vote) ? 'MIXED' : 'DATA UNAVAILABLE';
    const confidence = buyPoints !== sellPoints
      ? Math.min(90, Math.round(100 * Math.abs(buyPoints - sellPoints) / (buyPoints + sellPoints)))
      : Math.min(75, Math.round(Math.abs(technical) * 3));
    const daily = same && market.fresh && market.reads && market.reads.D1;
    const atr = daily && daily.ready ? Number(daily.atr) || 0 : 0;
    const quoteFresh = quote && canonical(quote.symbol) === canonical(symbol) && Number(quote.price) > 0 &&
      now * 1000 - Number(quote.at) <= 15000 && Number(quote.at) <= now * 1000 + 5000;
    const move = atr > 0 && quoteFresh ? atr : null;
    const signed = move !== null && verdict === 'BUY' ? move : move !== null && verdict === 'SELL' ? -move : null;
    const precision = atr >= 1 ? 2 : 5;
    const text = signed !== null ? (signed > 0 ? '+' : '-') + Math.abs(signed).toFixed(precision) +
      (signed > 0 ? ' UP · est.' : ' DOWN · est.') : move !== null ? '~' + move.toFixed(precision) + ' RANGE · est.' : 'Price range unavailable';
    return { market: symbol, verdict, confidence, buy, sell, signals: buy + sell,
      forecast_dollar: signed, forecast_text: text, source: buyPoints !== sellPoints ? 'news' : technical ? 'market structure' : 'flat',
      top_event: top ? top.title : '', top_ts: top ? Number(top.ts) : 0,
      window_start: window.start, window_end: window.end,
      reason: move !== null ? 'Estimated travel from measured D1 ATR; signal strength is not a probability.' : 'Fresh daily candles and quote are required for a price-range estimate.' };
  }
  function outlookAll(events, symbols, selected, now, relevant, estimate, contextFor) {
    const window = tomorrowWindow(now);
    // Filter the time window once. Hundreds of past headlines should not be
    // scanned against every market on every live dashboard repaint.
    const upcoming = (events || []).filter(e => e && e.kind !== 'headline' &&
      Number(e.ts) >= window.start && Number(e.ts) < window.end);
    const published = (events || []).filter(e => e && newsPhase(e, now) === 'context');
    return marketList(symbols, selected).map(symbol => {
      const context = contextFor ? contextFor(symbol) || {} : {};
      // News, quote and candle context must belong to this row, even when the
      // caller supplies the currently selected market's snapshot for every row.
      const market = context.market && canonical(context.market.symbol) === canonical(symbol) ? context.market : null;
      const quote = context.quote && canonical(context.quote.symbol) === canonical(symbol) ? context.quote : null;
      const news = upcoming.filter(e => relevant(e, symbol));
      const headlines = news.length ? published.filter(e => relevant(e, symbol)) : [];
      return outlook(news, symbol, now, relevant,
        event => estimate(event, symbol, { market, quote, headlines }), market, quote);
    });
  }
  const api = { canonical, marketList, impactSeconds, newsKind, newsExpires, newsPhase, selectEvent, eventImpacts, tomorrowWindow, outlook, outlookAll };
  root.DashboardPanels = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window === 'undefined' ? globalThis : window);
