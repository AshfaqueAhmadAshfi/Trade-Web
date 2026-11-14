/* Selected-market directional estimates from release data, RSS text and live
   structure. Signal strength is a model score, not a calibrated probability. */
(function () {
  'use strict';
  function base(v) {
    var key = String(v || '').replace(/m$/, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    return ({XAUUSD247:'XAUUSD',BTCUSD:'BTCUSDT',ETHUSD:'ETHUSDT',USTECX100:'USTEC',NAS100:'USTEC'})[key] || key;
  }
  function sign(n) { return n > 0 ? 1 : n < 0 ? -1 : 0; }
  function clamp(n, limit) { return Math.max(-limit, Math.min(limit, n)); }
  function side(v) { return /BUY|UP|BULL/i.test(v || '') ? 1 : /SELL|DOWN|BEAR/i.test(v || '') ? -1 : 0; }
  function currencySign(symbol, currency) {
    var key = base(symbol), c = String(currency || '').toUpperCase();
    if (c === key || (c === 'TECH' && /USTEC|US500|US30|^[A-Z]{2,5}$/.test(key))) return 1;
    if (c === 'OIL' && /USOIL|UKOIL|XNG/.test(key)) return 1;
    if (c === 'BTC' && /^(BTC|ETH|SOL|XRP|BNB|DOGE|ADA|LTC)/.test(key)) return 1;
    if (/^(XAU|XAG|XPT|XPD)/.test(key) && c === key.slice(0,3)) return 1;
    if (/^[A-Z]{6}$/.test(key) && c === key.slice(0,3)) return 1;
    if (/^[A-Z]{6}$/.test(key) && c === key.slice(3)) return -1;
    if (c === 'USD') {
      if (key === 'DXY' || /^USD/.test(key)) return 1;
      if (/USD[T]?$/.test(key) || /^(USTEC|US500|US30|USOIL|UKOIL|[A-Z]{2,5})$/.test(key)) return -1;
    }
    return 0;
  }
  function textBias(text, symbol, currency) {
    var t = String(text || '').toLowerCase(), key = base(symbol);
    var names = /^XAU/.test(key) ? 'gold|bullion' : /^XAG/.test(key) ? 'silver' : /^BTC/.test(key) ? 'bitcoin|btc' : /^ETH/.test(key) ? 'ethereum|ether' : /USOIL|UKOIL/.test(key) ? 'oil|crude|brent|wti' : /USTEC/.test(key) ? 'nasdaq|tech stocks' : '';
    var up = 'rall(?:y|ies)|ris(?:e|es|ing)|gain(?:s|ing)?|jump(?:s)?|surge(?:s)?|rebound(?:s)?|bullish|upside';
    var down = 'fall(?:s|ing)?|drop(?:s|ping)?|slip(?:s|ping)?|slide(?:s|ing)?|sell.?off|bearish|headwinds|downside|declin(?:e|es|ing)';
    if (names) {
      var pos = new RegExp('\\b(?:' + names + ')\\b.{0,35}\\b(?:' + up + ')\\b').test(t);
      var neg = new RegExp('\\b(?:' + names + ')\\b.{0,35}\\b(?:' + down + ')\\b').test(t);
      if (pos !== neg) return pos ? 1 : -1;
    }
    // Policy wording concerns the named central bank's currency, even when
    // the headline was classified as a gold story by the RSS parser.
    var policyCurrency = /\b(fed|fomc|federal reserve)\b/.test(t) ? 'USD' : /\becb\b/.test(t) ? 'EUR' : /\bboe\b/.test(t) ? 'GBP' : /\bboj\b/.test(t) ? 'JPY' : currency;
    var hawk = /\b(hawkish|rate hike|hike rates|tightening|higher for longer)\b/.test(t);
    var dove = /\b(dovish|rate cut|cut rates|easing)\b/.test(t);
    if (hawk !== dove) return (hawk ? 1 : -1) * currencySign(symbol, policyCurrency);
    var positive = new RegExp('\\b(?:' + up + '|stronger)\\b').test(t);
    var negative = new RegExp('\\b(?:' + down + '|weaker)\\b').test(t);
    return positive === negative ? 0 : (positive ? 1 : -1) * currencySign(symbol, currency);
  }
  function topics(text) {
    var t = String(text || '').toLowerCase();
    return ['fed|fomc|rate|central bank','inflation|cpi|pce|ppi','jobs|payroll|nfp|claims|unemployment',
      'oil|crude|opec|energy','bitcoin|crypto|ethereum','gold|bullion|silver','gdp|growth|pmi|retail',
      'stock|nasdaq|earnings|equities'].filter(function(k) { return new RegExp('\\b(?:'+k+')\\b').test(t); });
  }
  function estimate(input) {
    var ev = input.event, symbol = input.symbol, now = input.now || Date.now()/1000;
    var score = 0, evidence = [], basis = 'MODEL BIAS', q = input.quote, market = input.market;
    function add(n, reason) { if (n) { score += n; evidence.push(reason); } }
    var actual = ev.actual != null && ev.actual !== '' ? Number(ev.actual) : NaN;
    var forecast = ev.forecast != null && ev.forecast !== '' ? Number(ev.forecast) : NaN;
    var previous = ev.previous != null && ev.previous !== '' ? Number(ev.previous) : NaN;
    var comparison = isFinite(actual) && isFinite(forecast) ? forecast : previous;
    var value = isFinite(actual) ? actual : forecast;
    var inverse = /unemployment|jobless|claims|job cut|oil inventories|oil stocks/.test(String(ev.title || '').toLowerCase());
    var delta = isFinite(value) && isFinite(comparison) ? sign(value-comparison) * (inverse ? -1 : 1) : 0;
    if (delta && currencySign(symbol, ev.currency || ev.country)) {
      add(delta * currencySign(symbol, ev.currency || ev.country) * (isFinite(actual) ? 6 : 3),
        isFinite(actual) ? 'Actual vs forecast/previous surprise' : 'Forecast vs previous: pre-release estimate');
      if (isFinite(actual)) basis = 'RELEASE + MODEL';
    } else if (input.impact && side(input.impact.side || input.impact.direction)) {
      add(side(input.impact.side || input.impact.direction) * (isFinite(actual) ? 5 : 3), input.impact.reason || 'Market-specific event effect');
      if (isFinite(actual)) basis = 'RELEASE + MODEL';
    }
    add(textBias(ev.title + ' ' + (ev.description || ''), symbol, ev.currency || ev.country) * 2, 'Headline / RSS excerpt wording');
    var matched = topics(ev.title), seen = Object.create(null), related = [], contextScore = 0;
    (input.headlines || []).filter(function(h) { return h.ts <= now && h.ts >= now-86400; })
      .sort(function(a,b) { return b.ts-a.ts; }).forEach(function(h) {
        var key = String(h.title || '').toLowerCase();
        if (seen[key] || key === String(ev.title || '').toLowerCase() || related.length >= 40) return;
        if (matched.length && !matched.some(function(k) { return new RegExp('\\b(?:'+k+')\\b','i').test(h.title || ''); })) return;
        seen[key] = true;
        var bias = textBias(h.title + ' ' + (h.description || ''), symbol, h.currency || h.country);
        if (bias) { contextScore += bias * Math.exp(-(now-h.ts)/21600); related.push({title:h.title,source:h.source,ts:h.ts}); }
      });
    add(clamp(contextScore,2), related.length + ' related published headline(s)');
    if (market && market.symbol === symbol && market.fresh && market.vote) {
      add(clamp(Number(market.vote.score) / 12 || 0, 1.5), 'Live multi-timeframe price structure');
    }
    if (q && q.symbol === symbol && now*1000-q.at <= 15000 && q.at <= now*1000+5000 && Number(q.price)>0) {
      add(clamp(Number(q.change) / 0.3 || 0, 1), 'TradingView daily price change');
      // Resolve an otherwise tied model using observed market continuation.
      if (!score) { score = Number(q.change) < 0 ? -0.05 : 0.05; evidence.push('Flat/mixed evidence: low-strength continuation bias'); }
    }
    if (!evidence.length) return null;
    var chosen = score >= 0 ? 'BUY' : 'SELL', prediction = input.prediction || {};
    var atr = market && market.symbol === symbol && market.fresh && market.reads.M5 ? Number(market.reads.M5.atr) : 0;
    var move = Math.abs(Number(prediction.move_abs != null ? prediction.move_abs : prediction.move_dollar) || 0);
    if (!move && atr) move = atr * ({high:3,medium:2,low:1.25}[ev.impact] || 1.25);
    return {market:symbol,side:chosen,direction:chosen === 'BUY' ? 'UP' : 'DOWN',move_abs:move,
      strength:Math.min(90,Math.round(20+Math.abs(score)*9)),score:Math.round(score*100)/100,
      basis:basis,reason:evidence.join(' · '),related:related.slice(0,4),at:now*1000};
  }
  window.NewsDirection = {estimate:estimate};
})();
