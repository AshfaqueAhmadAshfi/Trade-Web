/* Smart Money Order Blocks / FVG & Profit Radar TP/SL + Risk Sizer.
   --------------------------------------------------------------------------
   Fills the two workspace slots with institutional trading intelligence:
   1. #smart-money-panel (left sidebar beneath NEXT SELL SWING AI):
      Detects unmitigated Bullish/Bearish Order Blocks (OB), Fair Value Gaps
      (FVG) and Fibonacci Golden Pocket (OTE 61.8%-70.5%) entry zones from
      closed M5 / M15 / H1 candles projected to the live TradingView quote.
   2. #profit-radar-panel (center bottom row beside SL · LIQUIDITY ZONES):
      Synthesizes 6-Timeframe Trend, VWAP, 13-Venue Order Flow, Stop-Liquidity
      Sweep Protection and ATR into an executable Entry / Safe-SL / Break-Even /
      TP1 / TP2 plan plus a $10 / $25 / $50 / $100 Risk & Lot Size calculator.
   -------------------------------------------------------------------------- */
(function (root) {
  'use strict';

  var document = root.document;
  var $ = function (id) { return document ? document.getElementById(id) : null; };
  var QUOTE_MS = 15000;
  var RISK_TIERS = [10, 25, 50, 100];

  var symbol = '';
  var quote = null;
  var smcZones = { buy: [], sell: [] };
  var radarPlan = null;
  var lastStructureAt = 0;

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function cleanSymbol(v) {
    return String(v || '').trim().replace(/m$/i, '').toUpperCase();
  }

  function canonicalSymbol(v) {
    if (root.DashboardPanels && typeof root.DashboardPanels.canonical === 'function') {
      return root.DashboardPanels.canonical(v);
    }
    var key = cleanSymbol(v).replace(/[^A-Z0-9]/g, '');
    return ({
      XAUUSD247: 'XAUUSD',
      GOLD: 'XAUUSD',
      BTCUSD: 'BTCUSDT',
      ETHUSD: 'ETHUSDT',
      NAS100: 'USTEC',
      USTECX100: 'USTEC',
      NDX: 'USTEC'
    })[key] || key;
  }

  function px(v, sym) {
    var n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return '—';
    var clean = cleanSymbol(sym || symbol);
    var digits = n < 0.01 ? 6 : n < 1 ? 5 : n < 10 ? 5
      : /JPY/.test(clean) && n < 1000 ? 3 : 2;
    return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }

  function money(v) {
    var n = Number(v);
    if (!Number.isFinite(n)) return '$0.00';
    return (n < 0 ? '-$' : '+$') + Math.abs(n).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  function barTime(v) {
    var n = Number(v);
    return n < 1e11 ? n * 1000 : n;
  }

  function barsFor(rows, duration, nowMs) {
    var cutoff = Number(nowMs) || Date.now();
    return (rows || []).filter(function (b) {
      return Array.isArray(b) && b.length >= 5 && barTime(b[0]) + duration <= cutoff &&
        [1, 2, 3, 4].every(function (i) { return Number.isFinite(Number(b[i])) && Number(b[i]) > 0; });
    }).slice().sort(function (a, b) { return barTime(a[0]) - barTime(b[0]); });
  }

  function atrOf(bars) {
    if (!bars || bars.length < 2) return 0;
    var values = [];
    for (var i = Math.max(1, bars.length - 14); i < bars.length; i++) {
      var h = Number(bars[i][2]), l = Number(bars[i][3]), prevC = Number(bars[i - 1][4]);
      values.push(Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC)));
    }
    return values.length ? values.reduce(function (a, b) { return a + b; }, 0) / values.length : 0;
  }

  // Contract value per 1.00 standard MT5 lot for 1.0 price-unit move.
  function lotUnitValue(sym, currentPrice) {
    var s = cleanSymbol(sym);
    var p = Number(currentPrice) || 1;
    if (/^(XAU|GOLD)/.test(s)) return { mult: 100, unit: '100 oz/lot', minLot: 0.01 };
    if (/^(XAG|SILVER)/.test(s)) return { mult: 5000, unit: '5,000 oz/lot', minLot: 0.01 };
    if (/^(USOIL|UKOIL|XTI|XBR|WTI|CL)/.test(s)) return { mult: 1000, unit: '1,000 bbl/lot', minLot: 0.01 };
    if (/^(BTC|ETH|SOL|BNB|BCH|LTC|AVAX|LINK|DOT|AAVE)/.test(s)) return { mult: 1, unit: '1 coin/lot', minLot: 0.01 };
    if (/^(XRP|ADA|DOGE|TRX|TON|SUI|NEAR|APT|UNI|ONDO|SHIB|PEPE)/.test(s)) {
      var scale = p < 0.01 ? 100000 : p < 1 ? 1000 : 100;
      return { mult: scale, unit: scale.toLocaleString('en-US') + ' coins/lot', minLot: 0.01 };
    }
    if (/^(USTEC|NAS100|US30|US500|SPX|DE40|UK100|JP225|DXY|USDX)/.test(s)) {
      return { mult: 1, unit: '1 idx/lot', minLot: 0.01 };
    }
    if (/JPY$/.test(s) && p > 10) {
      return { mult: 100000 / p, unit: '100k FX/lot', minLot: 0.01 };
    }
    if (/^[A-Z]{6}$/.test(s)) {
      return { mult: 100000, unit: '100k FX/lot', minLot: 0.01 };
    }
    return { mult: 1, unit: '1 unit/lot', minLot: 0.01 };
  }

  // Detect unmitigated Order Blocks (OB), Fair Value Gaps (FVG) & OTE 61.8% zones.
  function detectSmartMoney(frames, livePrice, nowMs) {
    var price = Number(livePrice);
    if (!(price > 0) || !frames) return { buy: [], sell: [] };
    var candidates = [];
    var tfDefs = [
      { key: 'M5', duration: 300000, weight: 1 },
      { key: 'M15', duration: 900000, weight: 2 },
      { key: 'H1', duration: 3600000, weight: 3 }
    ];

    tfDefs.forEach(function (tf) {
      var bars = barsFor(frames[tf.key], tf.duration, nowMs);
      if (bars.length < 15) return;
      var lastClose = Number(bars[bars.length - 1][4]);
      if (!(lastClose > 0)) return;
      var scale = price / lastClose;
      var a = atrOf(bars) * scale;
      if (!(a > 0)) return;

      var startIdx = Math.max(3, bars.length - 55);
      for (var i = startIdx; i < bars.length - 2; i++) {
        var b = bars[i];
        var open = Number(b[1]) * scale;
        var high = Number(b[2]) * scale;
        var low = Number(b[3]) * scale;
        var close = Number(b[4]) * scale;
        var later = bars.slice(i + 2);

        // 1. Bullish & Bearish Fair Value Gaps (3-candle imbalance).
        var bPrev = bars[i - 1];
        var bNext = bars[i + 1];
        var prevHigh = Number(bPrev[2]) * scale;
        var prevLow = Number(bPrev[3]) * scale;
        var nextHigh = Number(bNext[2]) * scale;
        var nextLow = Number(bNext[3]) * scale;

        if (nextLow > prevHigh && (nextLow - prevHigh) >= a * 0.12) {
          var fvgBuyEntry = prevHigh + (nextLow - prevHigh) * 0.5;
          var fvgBuyMitigated = later.some(function (n) { return Number(n[3]) * scale <= prevHigh; });
          if (!fvgBuyMitigated && fvgBuyEntry <= price * 1.0015 && prevHigh < price) {
            var fvgBuyStop = Math.min(prevLow, prevHigh - a * 0.35);
            var fvgBuyRisk = Math.max(a * 0.4, fvgBuyEntry - fvgBuyStop);
            candidates.push({
              id: tf.key + ':BU-FVG:' + barTime(b[0]),
              side: 'buy',
              kind: 'BU-FVG',
              tf: tf.key,
              weight: tf.weight,
              entry: fvgBuyEntry,
              zoneLow: prevHigh,
              zoneHigh: nextLow,
              stop: fvgBuyEntry - fvgBuyRisk,
              tp1: fvgBuyEntry + fvgBuyRisk * 1.5,
              tp2: fvgBuyEntry + fvgBuyRisk * 2.5,
              band: a * 0.22,
              time: barTime(b[0]),
              note: tf.key + ' Bullish Fair Value Gap (unfilled 3-bar displacement imbalance)'
            });
          }
        }

        if (nextHigh < prevLow && (prevLow - nextHigh) >= a * 0.12) {
          var fvgSellEntry = prevLow - (prevLow - nextHigh) * 0.5;
          var fvgSellMitigated = later.some(function (n) { return Number(n[2]) * scale >= prevLow; });
          if (!fvgSellMitigated && fvgSellEntry >= price * 0.9985 && prevLow > price) {
            var fvgSellStop = Math.max(prevHigh, prevLow + a * 0.35);
            var fvgSellRisk = Math.max(a * 0.4, fvgSellStop - fvgSellEntry);
            candidates.push({
              id: tf.key + ':BE-FVG:' + barTime(b[0]),
              side: 'sell',
              kind: 'BE-FVG',
              tf: tf.key,
              weight: tf.weight,
              entry: fvgSellEntry,
              zoneLow: nextHigh,
              zoneHigh: prevLow,
              stop: fvgSellEntry + fvgSellRisk,
              tp1: fvgSellEntry - fvgSellRisk * 1.5,
              tp2: fvgSellEntry - fvgSellRisk * 2.5,
              band: a * 0.22,
              time: barTime(b[0]),
              note: tf.key + ' Bearish Fair Value Gap (unfilled 3-bar supply imbalance)'
            });
          }
        }

        // 2. Bullish Order Block (last bearish candle before bullish displacement + structure break).
        var lookAhead = bars.slice(i + 1, Math.min(bars.length, i + 4));
        var maxAfterClose = Math.max.apply(null, lookAhead.map(function (n) { return Number(n[4]) * scale; }));
        var minAfterClose = Math.min.apply(null, lookAhead.map(function (n) { return Number(n[4]) * scale; }));
        var priorHigh = Math.max.apply(null, bars.slice(Math.max(0, i - 3), i).map(function (n) { return Number(n[2]) * scale; }));
        var priorLow = Math.min.apply(null, bars.slice(Math.max(0, i - 3), i).map(function (n) { return Number(n[3]) * scale; }));

        if (close <= open && (maxAfterClose - low) >= a * 0.85 && maxAfterClose > priorHigh) {
          var obBuyInvalidated = later.some(function (n) { return Number(n[3]) * scale < low; });
          var obBuyEntry = low + (high - low) * 0.6;
          if (!obBuyInvalidated && obBuyEntry <= price * 1.001 && low < price) {
            var obBuyStop = low - a * 0.25;
            var obBuyRisk = Math.max(a * 0.45, obBuyEntry - obBuyStop);
            candidates.push({
              id: tf.key + ':BU-OB:' + barTime(b[0]),
              side: 'buy',
              kind: 'BU-OB',
              tf: tf.key,
              weight: tf.weight + 1,
              entry: obBuyEntry,
              zoneLow: low,
              zoneHigh: high,
              stop: obBuyEntry - obBuyRisk,
              tp1: obBuyEntry + obBuyRisk * 1.5,
              tp2: obBuyEntry + obBuyRisk * 2.5,
              band: a * 0.25,
              time: barTime(b[0]),
              note: tf.key + ' Bullish Order Block (unmitigated institutional demand before BOS)'
            });
          }
        }

        // 3. Bearish Order Block (last bullish candle before bearish displacement + structure break).
        if (close >= open && (high - minAfterClose) >= a * 0.85 && minAfterClose < priorLow) {
          var obSellInvalidated = later.some(function (n) { return Number(n[2]) * scale > high; });
          var obSellEntry = high - (high - low) * 0.6;
          if (!obSellInvalidated && obSellEntry >= price * 0.999 && high > price) {
            var obSellStop = high + a * 0.25;
            var obSellRisk = Math.max(a * 0.45, obSellStop - obSellEntry);
            candidates.push({
              id: tf.key + ':BE-OB:' + barTime(b[0]),
              side: 'sell',
              kind: 'BE-OB',
              tf: tf.key,
              weight: tf.weight + 1,
              entry: obSellEntry,
              zoneLow: low,
              zoneHigh: high,
              stop: obSellEntry + obSellRisk,
              tp1: obSellEntry - obSellRisk * 1.5,
              tp2: obSellEntry - obSellRisk * 2.5,
              band: a * 0.25,
              time: barTime(b[0]),
              note: tf.key + ' Bearish Order Block (unmitigated institutional supply before BOS)'
            });
          }
        }
      }

      // 4. Fibonacci OTE (61.8% - 70.5% Golden Pocket) on recent 30-bar swing range.
      var win = bars.slice(-30);
      var hiIdx = 0, loIdx = 0;
      win.forEach(function (row, idx) {
        if (Number(row[2]) >= Number(win[hiIdx][2])) hiIdx = idx;
        if (Number(row[3]) <= Number(win[loIdx][3])) loIdx = idx;
      });
      var swingHi = Number(win[hiIdx][2]) * scale;
      var swingLo = Number(win[loIdx][3]) * scale;
      var span = swingHi - swingLo;
      if (span >= a * 1.4) {
        var oteBuy618 = swingHi - span * 0.618;
        var oteBuy705 = swingHi - span * 0.705;
        if (oteBuy618 < price && swingLo < oteBuy705) {
          var oteBuyRisk = Math.max(a * 0.5, oteBuy618 - (swingLo - a * 0.15));
          candidates.push({
            id: tf.key + ':BU-OTE:' + barTime(win[loIdx][0]),
            side: 'buy',
            kind: 'OTE 61.8%',
            tf: tf.key,
            weight: tf.weight,
            entry: oteBuy618,
            zoneLow: oteBuy705,
            zoneHigh: oteBuy618,
            stop: oteBuy618 - oteBuyRisk,
            tp1: oteBuy618 + oteBuyRisk * 1.5,
            tp2: Math.max(swingHi, oteBuy618 + oteBuyRisk * 2.5),
            band: a * 0.2,
            time: barTime(win[loIdx][0]),
            note: tf.key + ' Golden Pocket OTE (61.8%–70.5% Fibonacci discount pullback)'
          });
        }
        var oteSell618 = swingLo + span * 0.618;
        var oteSell705 = swingLo + span * 0.705;
        if (oteSell618 > price && swingHi > oteSell705) {
          var oteSellRisk = Math.max(a * 0.5, (swingHi + a * 0.15) - oteSell618);
          candidates.push({
            id: tf.key + ':BE-OTE:' + barTime(win[hiIdx][0]),
            side: 'sell',
            kind: 'OTE 61.8%',
            tf: tf.key,
            weight: tf.weight,
            entry: oteSell618,
            zoneLow: oteSell618,
            zoneHigh: oteSell705,
            stop: oteSell618 + oteSellRisk,
            tp1: oteSell618 - oteSellRisk * 1.5,
            tp2: Math.min(swingLo, oteSell618 - oteSellRisk * 2.5),
            band: a * 0.2,
            time: barTime(win[hiIdx][0]),
            note: tf.key + ' Golden Pocket OTE (61.8%–70.5% Fibonacci premium rally)'
          });
        }
      }
    });

    function mergeSide(side) {
      var list = candidates.filter(function (c) { return c.side === side; })
        .sort(function (a, b) { return a.entry - b.entry; });
      var groups = [];
      list.forEach(function (c) {
        var cur = groups[groups.length - 1];
        var tol = Math.max(c.band || 0, price * 0.0005);
        if (!cur || Math.abs(c.entry - cur.entry) > tol) {
          groups.push(Object.assign({}, c, { count: 1, tags: [c.kind + ' · ' + c.tf] }));
          return;
        }
        cur.count += 1;
        if (c.weight >= cur.weight) {
          cur.kind = c.kind;
          cur.tf = c.tf;
          cur.note = c.note;
        }
        cur.weight += c.weight;
        cur.entry = (cur.entry + c.entry) / 2;
        cur.zoneLow = Math.min(cur.zoneLow, c.zoneLow);
        cur.zoneHigh = Math.max(cur.zoneHigh, c.zoneHigh);
        cur.stop = side === 'buy' ? Math.min(cur.stop, c.stop) : Math.max(cur.stop, c.stop);
        var risk = Math.abs(cur.entry - cur.stop);
        cur.tp1 = side === 'buy' ? cur.entry + risk * 1.5 : cur.entry - risk * 1.5;
        cur.tp2 = side === 'buy' ? cur.entry + risk * 2.5 : cur.entry - risk * 2.5;
        var tag = c.kind + ' · ' + c.tf;
        if (cur.tags.indexOf(tag) < 0) cur.tags.push(tag);
      });
      return groups.map(function (g) {
        var distPct = Math.abs(price - g.entry) / price * 100;
        var inZone = price >= g.zoneLow && price <= g.zoneHigh || distPct <= 0.08;
        var state = inZone ? 'IN ZONE' : distPct <= 0.35 ? 'NEAR' : 'READY';
        return Object.assign(g, { distPct: distPct, state: state });
      }).sort(function (a, b) {
        return a.distPct - b.distPct || b.weight - a.weight;
      }).slice(0, 6);
    }

    return {
      buy: mergeSide('buy'),
      sell: mergeSide('sell')
    };
  }

  // Synthesize 6-Factor Confluence, Safe SL (beyond SL liquidity clusters) & Lot Sizing.
  function computeProfitRadar(ctx) {
    var sym = (ctx && ctx.symbol) || symbol || 'XAUUSDm';
    var price = Number(ctx && ctx.price) || (quote ? quote.price : 0);
    if (!(price > 0)) return null;

    var swing = (ctx && ctx.swing) || (root.SwingAI && typeof root.SwingAI.state === 'function' ? root.SwingAI.state() : null) || {};
    var reads = swing.reads || {};
    var m5 = reads.M5 || {};
    var m15 = reads.M15 || {};
    var h1 = reads.H1 || {};
    var h4 = reads.H4 || {};
    var d1 = reads.D1 || {};
    var slState = (ctx && ctx.stopLiquidity) || (root.StopLiquidity && typeof root.StopLiquidity.state === 'function' ? root.StopLiquidity.state() : null) || {};
    var slZones = Array.isArray(slState.zones) ? slState.zones : [];
    var flowTotals = (ctx && ctx.orderFlow) || (root.MultiExchangeOrderFlow && typeof root.MultiExchangeOrderFlow.getOpenTotals === 'function' ? root.MultiExchangeOrderFlow.getOpenTotals() : null) || {};
    var smc = (ctx && ctx.smc) || smcZones || { buy: [], sell: [] };

    // 1. HTF Trend Score (H1 + H4 + D1)
    var htfScore = (Number(h1.score) || 0) + (Number(h4.score) || 0) * 1.2 + (Number(d1.score) || 0) * 1.5;
    var htfSide = htfScore >= 2 ? 'BUY' : htfScore <= -2 ? 'SELL' : 'NEUTRAL';

    // 2. LTF Momentum Score (M5 + M15)
    var ltfScore = (Number(m5.score) || 0) + (Number(m15.score) || 0) * 1.25;
    var ltfSide = ltfScore >= 2 ? 'BUY' : ltfScore <= -2 ? 'SELL' : 'NEUTRAL';

    // 3. Institutional VWAP Position
    var refVwap = Number(m5.vwap) || Number(m15.vwap) || 0;
    var vwapSide = refVwap > 0 ? (price > refVwap * 1.0001 ? 'BUY' : price < refVwap * 0.9999 ? 'SELL' : 'NEUTRAL') : 'NEUTRAL';

    // 4. 13-Venue Order Flow Bias (45s)
    var flowBuy = Number(flowTotals.buy) || 0;
    var flowSell = Number(flowTotals.sell) || 0;
    var flowPct = (flowBuy + flowSell) > 0
      ? Math.round((flowBuy / (flowBuy + flowSell)) * 100)
      : Math.round(Number(swing.flowBias) || 50);
    var flowSide = flowPct >= 55 ? 'BUY' : flowPct <= 45 ? 'SELL' : 'NEUTRAL';

    // 5. Smart Money Demand / Supply Proximity
    var nearBuyOb = smc.buy && smc.buy[0];
    var nearSellOb = smc.sell && smc.sell[0];
    var smcSide = nearBuyOb && (!nearSellOb || nearBuyOb.distPct <= nearSellOb.distPct) ? 'BUY'
      : nearSellOb ? 'SELL' : 'NEUTRAL';

    // 6. Determine dominant trade direction & confluence percentage
    var buyPoints = 0, sellPoints = 0;
    if (htfSide === 'BUY') buyPoints += 28; else if (htfSide === 'SELL') sellPoints += 28;
    if (ltfSide === 'BUY') buyPoints += 24; else if (ltfSide === 'SELL') sellPoints += 24;
    if (vwapSide === 'BUY') buyPoints += 16; else if (vwapSide === 'SELL') sellPoints += 16;
    if (flowSide === 'BUY') buyPoints += 16; else if (flowSide === 'SELL') sellPoints += 16;
    if (smcSide === 'BUY') buyPoints += 16; else if (smcSide === 'SELL') sellPoints += 16;

    var activePlan = swing.plan && !swing.plan.doneAt && !swing.plan.hit ? swing.plan : null;
    var side = activePlan ? activePlan.side
      : buyPoints > sellPoints ? 'BUY'
      : sellPoints > buyPoints ? 'SELL'
      : (swing.vote && (swing.vote.side === 'BUY' || swing.vote.side === 'SELL') ? swing.vote.side : 'BUY');

    var alignedPoints = side === 'BUY' ? buyPoints : sellPoints;
    var edgePct = activePlan ? Math.max(alignedPoints, Number(activePlan.confidence) || 65) : alignedPoints;
    var strongEdge = (side === 'BUY' && buyPoints >= 52 && buyPoints >= sellPoints + 12) ||
      (side === 'SELL' && sellPoints >= 52 && sellPoints >= buyPoints + 12) || !!activePlan;

    // ATR fallback (M5 -> M15 -> H1 -> 0.25% of price)
    var baseAtr = Number(m5.atr) || (Number(m15.atr) ? Number(m15.atr) * 0.65 : 0) || (price * 0.0022);
    if (m5.close > 0 && Math.abs(price - m5.close) / price > 0.02) {
      baseAtr = baseAtr * (price / m5.close);
    }

    // Entry & Stop-Hunt Protected SL calculation
    var isBuy = side === 'BUY';
    var entry = activePlan ? Number(activePlan.observedEntry || activePlan.entry)
      : isBuy && nearBuyOb && nearBuyOb.distPct <= 0.35 ? nearBuyOb.entry
      : !isBuy && nearSellOb && nearSellOb.distPct <= 0.35 ? nearSellOb.entry
      : price;

    var rawStop = activePlan ? Number(activePlan.stop)
      : isBuy ? entry - baseAtr * 1.35 : entry + baseAtr * 1.35;

    // Protect SL against nearby Stop-Liquidity Pools (place SL beyond the pool!)
    var slPoolProtected = false;
    var sameSidePools = slZones.filter(function (z) {
      return z.side === (isBuy ? 'buy' : 'sell') &&
        (isBuy ? z.price < entry && z.price >= entry - baseAtr * 2.6
               : z.price > entry && z.price <= entry + baseAtr * 2.6);
    });
    if (!activePlan && sameSidePools.length) {
      var nearestPool = sameSidePools[0].price;
      var safeStop = isBuy ? nearestPool - baseAtr * 0.25 : nearestPool + baseAtr * 0.25;
      if (isBuy ? safeStop < rawStop : safeStop > rawStop) {
        rawStop = safeStop;
        slPoolProtected = true;
      }
    }

    var stopDist = Math.max(price * 0.0004, Math.abs(entry - rawStop));
    var stop = isBuy ? entry - stopDist : entry + stopDist;
    var beTrigger = isBuy ? entry + stopDist : entry - stopDist;
    var tp1 = isBuy ? entry + stopDist * 1.5 : entry - stopDist * 1.5;
    var tp2 = activePlan && Number(activePlan.target) > 0
      ? Number(activePlan.target)
      : (isBuy ? entry + stopDist * 2.5 : entry - stopDist * 2.5);
    var rr = Math.abs(tp2 - entry) / stopDist;

    // 6-Factor Checklist items
    var checks = [
      { label: 'HTF Trend (H1/H4/D1)', ok: htfSide === side, value: htfSide },
      { label: 'LTF Structure (M5/M15)', ok: ltfSide === side, value: ltfSide },
      { label: 'Session VWAP Bias', ok: vwapSide === side, value: refVwap > 0 ? px(refVwap, sym) : 'WAIT' },
      { label: '13-Venue Order Flow', ok: flowSide === side, value: flowPct + '% BUY' },
      { label: 'SMC Demand/Supply', ok: smcSide === side, value: smcSide === 'BUY' && nearBuyOb ? nearBuyOb.kind : smcSide === 'SELL' && nearSellOb ? nearSellOb.kind : 'SCAN' },
      { label: 'SL Hunt Protection', ok: true, value: slPoolProtected ? 'POOL BUFFERED' : 'ATR BUFFERED' }
    ];

    // Position sizing for $10, $25, $50, $100 risk tiers
    var spec = lotUnitValue(sym, price);
    var lossPerOneLot = Math.max(0.0001, stopDist * spec.mult);
    var sizing = RISK_TIERS.map(function (riskUsd) {
      var rawLots = riskUsd / lossPerOneLot;
      var lots = Math.max(spec.minLot, Math.floor(rawLots * 100) / 100);
      var actualRisk = lots * lossPerOneLot;
      var profitTp1 = actualRisk * 1.5;
      var profitTp2 = actualRisk * rr;
      return {
        riskUsd: riskUsd,
        lots: lots,
        actualRisk: actualRisk,
        profitTp1: profitTp1,
        profitTp2: profitTp2,
        unitLabel: spec.unit
      };
    });

    return {
      symbol: sym,
      price: price,
      side: side,
      strongEdge: strongEdge,
      edgePct: Math.min(95, Math.max(15, Math.round(edgePct))),
      entry: entry,
      stop: stop,
      stopDist: stopDist,
      stopPct: (stopDist / entry) * 100,
      beTrigger: beTrigger,
      tp1: tp1,
      tp2: tp2,
      rr: rr,
      slPoolProtected: slPoolProtected,
      checks: checks,
      sizing: sizing,
      unitLabel: spec.unit
    };
  }

  function paintSmartMoney() {
    var panel = $('smart-money-panel');
    if (!panel) return;
    if ($('smc-market')) $('smc-market').textContent = symbol || 'MARKET';
    if ($('smc-price')) $('smc-price').textContent = quote ? px(quote.price) : '—';
    var totalZones = (smcZones.buy ? smcZones.buy.length : 0) + (smcZones.sell ? smcZones.sell.length : 0);
    if ($('smc-status')) {
      $('smc-status').textContent = !quote
        ? 'Waiting for live quote'
        : totalZones
          ? 'M5 / M15 / H1 · ' + totalZones + ' active zones'
          : 'M5 / M15 / H1 · scanning…';
    }

    ['buy', 'sell'].forEach(function (side) {
      var listEl = $('smc-' + side + '-list');
      var countEl = $('smc-' + side + '-count');
      var rows = (smcZones && smcZones[side]) || [];
      if (countEl) countEl.textContent = rows.length + ' zones';
      if (!listEl) return;
      var opened = Object.create(null);
      if (listEl.querySelectorAll) {
        Array.prototype.forEach.call(listEl.querySelectorAll('details[open]'), function (el) {
          opened[el.dataset.key] = true;
        });
      }
      var html = rows.map(function (z) {
        var badge = z.state === 'IN ZONE' ? 'IN ZONE' : z.distPct.toFixed(2) + '%';
        return '<details class="slz-row smc-row ' + side + '" data-key="' + esc(z.id) + '"' + (opened[z.id] ? ' open' : '') + '>' +
          '<summary>' +
            '<b>' + esc(px(z.entry)) + '</b>' +
            '<span>' + esc(z.kind + ' · ' + z.tf) + '</span>' +
            '<em>' + esc(badge) + '</em>' +
            '<i>›</i>' +
          '</summary>' +
          '<div class="slz-details smc-details">' +
            '<b>' + (side === 'buy' ? 'BUY DEMAND PLAN' : 'SELL SUPPLY PLAN') + ':</b> ' +
            'Entry <b>' + esc(px(z.entry)) + '</b> · Safe SL <b>' + esc(px(z.stop)) + '</b> · ' +
            'TP1 (1.5R) <b>' + esc(px(z.tp1)) + '</b> · TP2 (2.5R) <b>' + esc(px(z.tp2)) + '</b><br>' +
            'Zone band: ' + esc(px(z.zoneLow)) + ' – ' + esc(px(z.zoneHigh)) + ' (' + esc(z.tags.join(' + ')) + ').<br>' +
            esc(z.note) + '.' +
          '</div>' +
        '</details>';
      }).join('') || '<div class="slz-empty">No unmitigated ' + (side === 'buy' ? 'BUY demand OB/FVG' : 'SELL supply OB/FVG') + ' confirmed yet.</div>';
      if (listEl.innerHTML !== html) listEl.innerHTML = html;
    });
  }

  function paintProfitRadar() {
    var panel = $('profit-radar-panel');
    if (!panel) return;
    if ($('prp-market')) $('prp-market').textContent = symbol || 'MARKET';
    if (!radarPlan) {
      if ($('prp-verdict')) $('prp-verdict').textContent = 'SCANNING';
      return;
    }
    var p = radarPlan;
    var isBuy = p.side === 'BUY';
    var sideCls = isBuy ? 'buy' : 'sell';
    var verdictText = (p.strongEdge ? (isBuy ? '▲ BUY EDGE ' : '▼ SELL EDGE ') : (isBuy ? '◆ BUY BIAS ' : '◆ SELL BIAS ')) + p.edgePct + '%';
    if ($('prp-verdict')) {
      $('prp-verdict').textContent = verdictText;
      $('prp-verdict').className = 'prp-verdict ' + (p.strongEdge ? sideCls : 'wait');
    }
    if ($('prp-edge-badge')) {
      $('prp-edge-badge').textContent = p.strongEdge ? (isBuy ? 'HIGH PROB BUY' : 'HIGH PROB SELL') : 'WAIT TRIGGER';
    }
    var passedChecks = p.checks.filter(function (c) { return c.ok; }).length;
    if ($('prp-status')) {
      $('prp-status').textContent = passedChecks + '/6 confluence checks · R:R 1:' + p.rr.toFixed(2);
    }
    if ($('prp-rule')) {
      $('prp-rule').textContent = p.slPoolProtected
        ? 'SL Hunt Guard: SL buffered beyond liquidity pool · BE at ' + px(p.beTrigger)
        : 'ATR Guard: Lock 50% at TP1 (' + px(p.tp1) + ') · move SL to BE (' + px(p.beTrigger) + ')';
    }
    if ($('prp-rr-badge')) $('prp-rr-badge').textContent = '1 : ' + p.rr.toFixed(2) + ' R:R · SL ' + p.stopPct.toFixed(2) + '%';

    var planList = $('prp-plan-list');
    if (planList) {
      var openedPlan = Object.create(null);
      if (planList.querySelectorAll) {
        Array.prototype.forEach.call(planList.querySelectorAll('details[open]'), function (el) {
          openedPlan[el.dataset.key] = true;
        });
      }
      var checkSummary = p.checks.map(function (c) {
        return (c.ok ? '✓ ' : '• ') + c.label + ': ' + c.value;
      }).join('<br>');

      var planRows = [
        {
          key: 'entry',
          cls: sideCls,
          title: (isBuy ? '▲ BUY ENTRY · ' : '▼ SELL ENTRY · ') + px(p.entry),
          sub: (p.strongEdge ? 'CONFIRMED SNIPER SETUP' : 'WATCH TRIGGER') + ' · ' + passedChecks + '/6 CONFLUENCE',
          tag: p.edgePct + '% EDGE',
          details: '<b>6-Factor Profit Confluence (' + passedChecks + '/6):</b><br>' + checkSummary
        },
        {
          key: 'sl-be',
          cls: 'sell',
          title: 'SAFE SL · ' + px(p.stop),
          sub: 'BREAK-EVEN (+1R) @ ' + px(p.beTrigger) + (p.slPoolProtected ? ' · POOL GUARD' : ' · ATR GUARD'),
          tag: '-' + p.stopPct.toFixed(2) + '%',
          details: '<b>Stop-Loss & Break-Even Protection:</b><br>' +
            'Safe Stop-Loss: <b>' + esc(px(p.stop)) + '</b> (' + (p.slPoolProtected ? 'placed beyond SL liquidity cluster' : '1.35x ATR structural stop') + ').<br>' +
            'Break-Even Trigger (+1.0R): <b>' + esc(px(p.beTrigger)) + '</b> — move SL to Entry (' + esc(px(p.entry)) + ') once reached.'
        },
        {
          key: 'tp',
          cls: 'buy',
          title: 'TP1 · ' + px(p.tp1) + '   |   TP2 · ' + px(p.tp2),
          sub: 'Lock 50% at TP1 (1.5R) & move SL to BE · Trail 50% to TP2',
          tag: '1:' + p.rr.toFixed(2) + ' R:R',
          details: '<b>Take-Profit Scaling Plan:</b><br>' +
            'TP1 (1.5R Safe Lock): <b>' + esc(px(p.tp1)) + '</b> — close 50% of position & lock Break-Even.<br>' +
            'TP2 (' + p.rr.toFixed(2) + 'R Target): <b>' + esc(px(p.tp2)) + '</b> — trail remaining 50% for full swing target.'
        },
        {
          key: 'checks',
          cls: sideCls,
          title: 'CONFLUENCE · ' + passedChecks + '/6 CHECKS PASSED',
          sub: 'HTF · VWAP · 13-VENUE FLOW · LIQUIDITY · SMC · NEWS',
          tag: p.slPoolProtected ? 'POOL SL' : 'ATR SL',
          details: '<b>Confluence Breakdown:</b><br>' + checkSummary
        }
      ];

      var planHtml = planRows.map(function (r) {
        return '<details class="slz-row prp-row ' + r.cls + '" data-key="' + r.key + '"' + (openedPlan[r.key] ? ' open' : '') + '>' +
          '<summary>' +
            '<b>' + esc(r.title) + '</b>' +
            '<span>' + esc(r.sub) + '</span>' +
            '<em>' + esc(r.tag) + '</em>' +
            '<i>›</i>' +
          '</summary>' +
          '<div class="slz-details prp-details">' + r.details + '</div>' +
        '</details>';
      }).join('');
      if (planList.innerHTML !== planHtml) planList.innerHTML = planHtml;
    }
  }

  function refreshAll() {
    var q = root.SOFT_TV_QUOTE;
    if (q && canonicalSymbol(q.symbol) === canonicalSymbol(symbol) && Number(q.price) > 0) {
      var at = Number(q.at) || Date.now();
      if (Date.now() - at <= QUOTE_MS && at <= Date.now() + 5000) {
        quote = { price: Number(q.price), at: at, tv_symbol: q.tv_symbol || '' };
      }
    }
    var swingState = root.SwingAI && typeof root.SwingAI.state === 'function' ? root.SwingAI.state() : null;
    if (!quote && swingState && canonicalSymbol(swingState.symbol) === canonicalSymbol(symbol) && Number(swingState.price) > 0) {
      quote = { price: Number(swingState.price), at: Number(swingState.updatedAt) || Date.now(), tv_symbol: swingState.tvSymbol || '' };
    }
    if (quote && root.SwingAI && typeof root.SwingAI.structure === 'function') {
      var h = root.SwingAI.structure();
      if (h && canonicalSymbol(h.symbol) === canonicalSymbol(symbol) && h.frames) {
        smcZones = detectSmartMoney(h.frames, quote.price, Date.now());
        lastStructureAt = Number(h.at) || Date.now();
      }
    }
    if (quote) {
      radarPlan = computeProfitRadar({
        symbol: symbol,
        price: quote.price,
        swing: swingState,
        smc: smcZones
      });
    }
    paintSmartMoney();
    paintProfitRadar();
  }

  function setSymbol(next) {
    var s = String(next || '').trim();
    if (!s || s === symbol) return;
    symbol = s;
    quote = null;
    smcZones = { buy: [], sell: [] };
    radarPlan = null;
    lastStructureAt = 0;
    refreshAll();
  }

  function acceptQuote(q) {
    if (!q || canonicalSymbol(q.symbol) !== canonicalSymbol(symbol) || !(Number(q.price) > 0)) return false;
    var at = Number(q.at) || Date.now();
    if (Date.now() - at > QUOTE_MS || at > Date.now() + 5000) return false;
    quote = { price: Number(q.price), at: at, tv_symbol: q.tv_symbol || '' };
    refreshAll();
    return true;
  }

  function init() {
    if (!$('smart-money-panel') && !$('profit-radar-panel')) return;
    var term = root.SoftradeXTerminal;
    setSymbol(term && typeof term.getCurrentSymbol === 'function' ? term.getCurrentSymbol() : 'XAUUSDm');
    root.addEventListener('chart:market', function (ev) {
      var d = (ev && ev.detail) || {};
      setSymbol(d.symbol || (d.meta && d.meta.symbol));
    });
    root.addEventListener('chart:tv-quote', function (ev) { acceptQuote(ev && ev.detail); });
    root.addEventListener('orderflow:update', refreshAll);
    root.addEventListener('chart:liquidity-zones', refreshAll);
    root.addEventListener('chart:refresh', refreshAll);
    if (document) {
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden) refreshAll();
      });
    }
    setInterval(function () {
      if (!document || !document.hidden) refreshAll();
    }, 2500);
    refreshAll();
  }

  var api = {
    detectSmartMoney: detectSmartMoney,
    computeProfitRadar: computeProfitRadar,
    lotUnitValue: lotUnitValue,
    setSymbol: setSymbol,
    acceptQuote: acceptQuote,
    refresh: refreshAll,
    state: function () {
      return {
        symbol: symbol,
        price: quote ? quote.price : 0,
        smc: smcZones,
        radar: radarPlan,
        structureAt: lastStructureAt
      };
    }
  };

  root.SmartMoneyZones = api;
  root.ProfitRadar = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (document) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  }
})(typeof window === 'undefined' ? globalThis : window);
