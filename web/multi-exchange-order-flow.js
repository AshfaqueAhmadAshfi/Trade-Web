/**
 * Additional public exchange order-flow terminals.
 * These streams are read-only and never place orders.
 */
(function () {
  'use strict';

  const EXCHANGES = [
    { id: 'coinbase', name: 'COINBASE', pairs: { BTC: 'BTC-USD', ETH: 'ETH-USD', SOL: 'SOL-USD', XAU: 'PAXG-USD', GOLD: 'PAXG-USD' } },
    { id: 'kraken', name: 'KRAKEN', pairs: { BTC: 'BTC/USD', ETH: 'ETH/USD', SOL: 'SOL/USD', XAU: 'PAXG/USD', GOLD: 'PAXG/USD' } },
    { id: 'okx', name: 'OKX', pairs: { BTC: 'BTC-USDT', ETH: 'ETH-USDT', SOL: 'SOL-USDT', XAU: 'PAXG-USDT', GOLD: 'PAXG-USDT' } },
    { id: 'bitget', name: 'BITGET', pairs: { BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT', XAU: 'PAXGUSDT', GOLD: 'PAXGUSDT' } },
    { id: 'gate', name: 'GATE.IO', pairs: { BTC: 'BTC_USDT', ETH: 'ETH_USDT', SOL: 'SOL_USDT', XAU: 'PAXG_USDT', GOLD: 'PAXG_USDT' } },
    // Bitstamp serves the right headers by handshake but drops them once it
    // throttles the 3s poll, so the browser blocks it. Bybit answers CORS and
    // its spot book lists XAUT (Tether Gold) for the gold view.
    { id: 'bybit', name: 'BYBIT', pairs: { BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT', XAU: 'XAUTUSDT', GOLD: 'XAUTUSDT' } },
    // These six publish a keyless trade API without CORS headers, so their
    // public tapes are normalised by /api/orderflow/trades on our backend.
    { id: 'kucoin', name: 'KUCOIN', proxy: true, pairs: { BTC: 'BTC-USDT', ETH: 'ETH-USDT', SOL: 'SOL-USDT', XAU: 'PAXG-USDT', GOLD: 'PAXG-USDT' } },
    { id: 'bitfinex', name: 'BITFINEX', proxy: true, pairs: { BTC: 'BTCUSD', ETH: 'ETHUSD', SOL: 'SOLUSD', XAU: 'XAUT:USD', GOLD: 'XAUT:USD' } },
    { id: 'mexc', name: 'MEXC', proxy: true, pairs: { BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT' } },
    { id: 'gemini', name: 'GEMINI', proxy: true, pairs: { BTC: 'btcusd', ETH: 'ethusd', SOL: 'solusd', XAU: 'paxgusd', GOLD: 'paxgusd' } },
    { id: 'deribit', name: 'DERIBIT', proxy: true, pairs: { BTC: 'BTC-PERPETUAL', ETH: 'ETH-PERPETUAL', SOL: 'SOL_USDC-PERPETUAL' } },
    { id: 'htx', name: 'HTX', proxy: true, pairs: { BTC: 'btcusdt', ETH: 'ethusdt', SOL: 'solusdt', XAU: 'xautusdt', GOLD: 'xautusdt' } }
  ];
  // Binance and the Traders Order Flow terminal live on the same board as the
  // 12 public tapes. They are not exchange entries (no pair / proxy), so they
  // are appended as explicit sources instead of being folded into EXCHANGES.
  const BOARD_SOURCES = EXCHANGES.concat([
    { id: 'binance', name: 'BINANCE', extra: true },
    { id: 'traders', name: 'TRADERS ORDER FLOW', extra: true }
  ]);
  const totals = {};
  const LIVE_WINDOW_MS = 45000;
  let selectedSymbol = '';
  let selectedMarket = '';
  let marketGeneration = 0;
  let sockets = {};
  let pollTimer = null;

  const $ = id => document.getElementById(id);
  const priceFormat = new Intl.NumberFormat('en-US', {maximumFractionDigits: 5});
  const qtyFormat = new Intl.NumberFormat('en-US', {maximumFractionDigits: 6});
  const timeFormat = new Intl.DateTimeFormat(undefined, {hour: 'numeric', minute: '2-digit', second: '2-digit'});
  const compact = n => {
    n = Number(n) || 0;
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + n.toFixed(2);
  };
  const symbolKey = symbol => {
    const s = String(symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    return ['BTC', 'ETH', 'SOL', 'XAU', 'GOLD'].find(key => s.indexOf(key) === 0) || '';
  };
  const state = id => totals[id] || (totals[id] = { buy: 0, sell: 0, trades: [], seen: new Set() });
  const set = (id, text) => { if ($(id)) $(id).textContent = text; };

  // ------------------------------------------------------------------
  // Combined board: every venue keeps its own BUY / SELL totals, then the
  // Traders terminal's running open-position amounts are added to the
  // grand total that feeds the BUY OPEN / SELL OPEN chips.
  // ------------------------------------------------------------------
  let boardRefs = null;

  function venueBreakdown() {
    return EXCHANGES.reduce((out, ex) => {
      const s = state(ex.id);
      pruneLiveTrades(s);
      recalculate(s);
      const live = (sockets[ex.id] && sockets[ex.id].readyState === 1) ||
        Date.now() - (s.lastPollAt || 0) < 15000 || Date.now() - (s.lastDataAt || 0) < 15000;
      out.push({ id: ex.id, name: ex.name, buy: s.buy, sell: s.sell, pair: s.pair || '',
        count: s.trades.length, price: s.lastPrice || 0, updatedAt: s.lastPollAt || s.lastDataAt || 0,
        status: !s.pair ? 'NO PAIR' : live ? (s.trades.length ? 'LIVE' : 'QUIET') : s.lastError ? 'UNAVAILABLE' : 'CONNECTING' });
      return out;
    }, []);
  }

  function venueTotals() {
    return venueBreakdown().reduce((out, venue) => {
      out.buy += venue.buy;
      out.sell += venue.sell;
      return out;
    }, { buy: 0, sell: 0 });
  }

  function binanceVolumes() {
    const bridge = window.BinanceOrderFlowBridge;
    if (!bridge || typeof bridge.getTotals !== 'function') {
      return { buy: 0, sell: 0, pair: '' };
    }
    try {
      const volume = bridge.getTotals() || {};
      if (symbolKey(volume.symbol) !== selectedSymbol) return {buy:0,sell:0,pair:"",status:"CONNECTING"};
      return {
        buy: Number(volume.buy) || 0,
        sell: Number(volume.sell) || 0,
        pair: symbolKey(volume.symbol) === selectedSymbol ? String(volume.pair || '') : '',
        status: symbolKey(volume.symbol) === selectedSymbol ? volume.status || 'CONNECTING' : 'CONNECTING',
        count: volume.count || 0, updatedAt: volume.updatedAt || 0
      };
    } catch (e) {
      return { buy: 0, sell: 0, pair: '' };
    }
  }

  function traderVolumes() {
    const terminal = window.TradersTerminal;
    if (!terminal || typeof terminal.getOpenVolume !== 'function') {
      return { buy: 0, sell: 0, count: 0 };
    }
    try {
      const volume = terminal.getOpenVolume() || {};
      return {
        buy: Number(volume.openBuyVol) || 0,
        sell: Number(volume.openSellVol) || 0,
        count: (Number(volume.openBuyCount) || 0) + (Number(volume.openSellCount) || 0)
      };
    } catch (e) {
      return { buy: 0, sell: 0, count: 0 };
    }
  }

  // Every source that contributes to the board: the 12 public tapes, Binance's
  // own aggregate-trade flow, then the Traders terminal's running positions.
  function sourceBreakdown() {
    const rows = venueBreakdown();
    const binance = binanceVolumes();
    rows.push({
      id: 'binance', name: 'BINANCE', buy: binance.buy, sell: binance.sell,
      pair: binance.pair, status: binance.status, count: binance.count, updatedAt: binance.updatedAt, extra: true
    });
    const traders = traderVolumes();
    rows.push({
      id: 'traders', name: 'TRADERS ORDER FLOW', buy: traders.buy, sell: traders.sell,
      pair: 'POSITIONS', extra: true, count: traders.count
    });
    return rows;
  }

  function openTotals() {
    const breakdown = sourceBreakdown();
    const totals = breakdown.filter(source => source.id !== 'traders').reduce((out, source) => {
      out.buy += source.buy;
      out.sell += source.sell;
      return out;
    }, { buy: 0, sell: 0 });
    const venues = breakdown.filter(source => !source.extra).reduce((out, venue) => {
      out.buy += venue.buy;
      out.sell += venue.sell;
      return out;
    }, { buy: 0, sell: 0 });
    const binance = breakdown.find(source => source.id === 'binance') || { buy: 0, sell: 0 };
    const traders = breakdown.find(source => source.id === 'traders') ||
      { buy: 0, sell: 0, count: 0 };
    return {
      buy: totals.buy,
      sell: totals.sell,
      venueBuy: venues.buy,
      venueSell: venues.sell,
      binanceBuy: binance.buy || 0,
      binanceSell: binance.sell || 0,
      tradersBuy: traders.buy || 0,
      tradersSell: traders.sell || 0,
      tradersCount: traders.count || 0,
      breakdown
    };
  }

  function boardUi() {
    if (boardRefs) return boardRefs;
    const root = $('venue-flow-board');
    const list = $('vfb-list');
    if (!root || !list) return null;
    boardRefs = {
      root, list,
      market: $('vfb-market'),
      buy: $('vfb-buy'), sell: $('vfb-sell'),
      buyPct: $('vfb-buy-pct'), sellPct: $('vfb-sell-pct'),
      barBuy: $('vfb-bar-buy'), barSell: $('vfb-bar-sell'),
      venueBuy: $('vfb-venue-buy'), venueSell: $('vfb-venue-sell'),
      binanceBuy: $('vfb-binance-buy'), binanceSell: $('vfb-binance-sell'),
      posBuy: $('vfb-pos-buy'), posSell: $('vfb-pos-sell'),
      updated: $('vfb-updated'),
      rows: Object.create(null)
    };
    if (list.dataset.ready !== '1') {
      list.innerHTML = BOARD_SOURCES.map(source => `
        <div class="vfb-venue${source.extra ? ' extra' : ''}" data-vfb="${source.id}">
          <div class="vfb-venue-top"><b>${source.name}</b><em class="vfb-venue-pct">0%</em></div>
          <div class="vfb-venue-vals"><span class="buy">B <b>$0.00</b></span><span class="sell">S <b>$0.00</b></span></div>
          <div class="vfb-venue-bar"><i class="buy"></i><i class="sell"></i></div>
        </div>`).join('');
      list.dataset.ready = '1';
      BOARD_SOURCES.forEach(source => {
        const row = list.querySelector(`[data-vfb="${source.id}"]`);
        if (!row) return;
        boardRefs.rows[source.id] = {
          root: row,
          pct: row.querySelector('.vfb-venue-pct'),
          buy: row.querySelector('.vfb-venue-vals .buy b'),
          sell: row.querySelector('.vfb-venue-vals .sell b'),
          barBuy: row.querySelector('.vfb-venue-bar .buy'),
          barSell: row.querySelector('.vfb-venue-bar .sell')
        };
      });
    }
    return boardRefs;
  }

  function updateBoard() {
    if (document.hidden) return;
    const ui = boardUi();
    if (!ui) return;
    const totals = openTotals();
    const grand = totals.buy + totals.sell;
    const buyPct = grand ? Math.round(totals.buy / grand * 100) : 0;
    const sellPct = grand ? 100 - buyPct : 0;

    set('vfb-market', selectedSymbol || '—');
    set('vfb-buy', compact(totals.buy));
    set('vfb-sell', compact(totals.sell));
    set('vfb-buy-pct', buyPct + '%');
    set('vfb-sell-pct', sellPct + '%');
    set('vfb-venue-buy', compact(totals.venueBuy));
    set('vfb-venue-sell', compact(totals.venueSell));
    set('vfb-binance-buy', compact(totals.binanceBuy));
    set('vfb-binance-sell', compact(totals.binanceSell));
    set('vfb-pos-buy', compact(totals.tradersBuy));
    set('vfb-pos-sell', compact(totals.tradersSell));
    if (ui.barBuy) ui.barBuy.style.width = buyPct + '%';
    if (ui.barSell) ui.barSell.style.width = sellPct + '%';

    totals.breakdown.forEach(entry => {
      const row = ui.rows[entry.id];
      if (!row) return;
      const total = entry.buy + entry.sell;
      const pct = total ? Math.round(entry.buy / total * 100) : 0;
      const live = entry.id === 'traders' ? true : !!entry.pair;
      row.root.classList.toggle('off', !live);
      if (row.pct) {
        if (entry.id === 'traders') row.pct.textContent = entry.count ? entry.count + ' POS' : 'NO POS';
        else if (!live) row.pct.textContent = entry.id === 'binance' ? 'WAITING' : 'NO PAIR';
        else row.pct.textContent = ['UNAVAILABLE','CONNECTING','QUIET'].includes(entry.status) ? entry.status : pct + '% BUY';
      }
      if (row.buy) row.buy.textContent = compact(entry.buy);
      if (row.sell) row.sell.textContent = compact(entry.sell);
      if (row.barBuy) row.barBuy.style.width = pct + '%';
      if (row.barSell) row.barSell.style.width = (total ? 100 - pct : 0) + '%';
    });
    if (ui.updated) ui.updated.textContent = 'UPDATED ' + new Date().toLocaleTimeString();
    // Public aggregate for chart-workspace.js. This identifies pressure, not
    // the owner of anonymous exchange prints; never label it as a company.
    // `breakdown` carries every venue's own BUY / SELL dollars so the
    // 12-venue terminal beside the sessions board can draw its table.
    window.dispatchEvent(new CustomEvent('orderflow:update', {
      detail: {
        symbol: selectedMarket, buy: totals.buy, sell: totals.sell, buyPct, sellPct,
        breakdown: totals.breakdown
      }
    }));
  }

  function render(id, withTape) {
    if (document.hidden) return;
    if (withTape === undefined) withTape = true;
    const s = state(id);
    pruneLiveTrades(s);
    recalculate(s);
    set(`mof-${id}-buy`, compact(s.buy));
    set(`mof-${id}-sell`, compact(s.sell));
    // A single exchange WebSocket can stay down while its REST poll keeps
    // answering; the badge follows the data, not the socket only.
    const live = (sockets[id] && sockets[id].readyState === 1) || Date.now() - (s.lastPollAt || 0) < 15000;
    set(`mof-${id}-status`, !s.pair ? 'NO PAIR' : live ? (s.trades.length ? 'CONNECTED' : 'QUIET') : s.lastError ? 'UNAVAILABLE' : 'CONNECTING');
    const total = s.buy + s.sell;
    set(`mof-${id}-buy-pct`, total ? Math.round(s.buy / total * 100) + '%' : '0%');
    set(`mof-${id}-sell-pct`, total ? Math.round(s.sell / total * 100) + '%' : '0%');
    const tape = $(`mof-${id}-tape`);
    if (tape && withTape) {
      // Rebuilding twelve 60-row tapes once a second was enough to block the
      // main thread. Summary chips still tick every second; the DOM only
      // changes when a new print actually arrives or an old one ages out.
      const first = s.trades[0];
      const last = s.trades[s.trades.length - 1];
      const key = s.trades.length + '|' + (first ? first.id || first.ts : '') +
        '|' + (last ? last.ts : '');
      if (key !== s.tapeKey) {
        s.tapeKey = key;
        const rows = s.trades.slice(0, 60);
        const rowHtml = tr => `
          <div class="mof-row ${tr.side === 'BUY' ? 'buy' : 'sell'}">
            <span>${timeFormat.format(tr.ts)}</span>
            <b>${tr.side}</b>
            <span>${priceFormat.format(Number(tr.price))}</span>
            <span>${qtyFormat.format(Number(tr.qty))}</span>
            <strong>${compact(tr.value)} <small>EXECUTED</small></strong>
          </div>`;
        if (window.LiveTapeRenderer) window.LiveTapeRenderer.render(tape, rows,
          tr => s.pair + '|' + tr.id, rowHtml, '');
        else tape.innerHTML = rows.map(rowHtml).join('');
      }
    }
  }

  // A REST poll can deliver dozens of prints at once. Rendering the whole
  // tape for every print made twelve terminals fight the main thread, so a
  // burst is coalesced into one paint.
  const renderTimers = Object.create(null);
  function scheduleRender(id) {
    if (renderTimers[id]) return;
    renderTimers[id] = setTimeout(() => {
      delete renderTimers[id];
      render(id);
      const current = state(id), batch = current.pendingTrades || [];
      current.pendingTrades = [];
      if (batch.length) window.dispatchEvent(new CustomEvent('orderflow:prints', {
        detail: { symbol: selectedMarket, venue: id, pair: current.pair, trades: batch }
      }));
      const bridge = window.BinanceOrderFlowBridge;
      if (bridge && typeof bridge.refresh === 'function') bridge.refresh();
    }, 40);
  }

  function pruneLiveTrades(s) {
    const cutoff = Date.now() - LIVE_WINDOW_MS;
    s.trades = s.trades.filter(tr => tr.ts >= cutoff);
  }

  function recalculate(s) {
    s.buy = s.trades.reduce((sum, tr) => sum + (tr.side === 'BUY' ? tr.value : 0), 0);
    s.sell = s.trades.reduce((sum, tr) => sum + (tr.side === 'SELL' ? tr.value : 0), 0);
  }

  function close(id) {
    if (sockets[id]) {
      const old = sockets[id];
      delete sockets[id];
      old.onmessage = old.onerror = old.onclose = null;
      // Let a pending handshake finish before closing it. Closing CONNECTING
      // sockets causes Chrome's "closed before ... established" warning.
      old.onopen = null;
      if (old.readyState === 0) {
        old.onopen = () => { old.onopen = null; old.close(); };
      } else if (old.readyState === 1) {
        old.close();
      }
    }
  }

  function addTrade(id, side, price, qty, tradeId, ts) {
    const s = state(id);
    const value = Number(price) * Number(qty);
    if (!(value > 0)) return;
    if (tradeId && s.seen.has(String(tradeId))) return;
    if (tradeId) {
      s.seen.add(String(tradeId));
      if (s.seen.size > 30000) s.seen.delete(s.seen.values().next().value);
    }
    // Kraken's REST feed encodes the taker side as 'b'/'s' while the other
    // exchanges send 'buy'/'sell' or 'Buy'/'Sell'. Classify by the first
    // letter, or every Kraken buy was booked as a sell and its BUY total
    // stayed empty while the tape showed a BUY row.
    const direction = String(side).toUpperCase();
    const when = Number(ts);
    if (!['BUY','SELL','B','S'].includes(direction) || !Number.isFinite(when) || when <= 0 || when > Date.now() + 5000) return;
    const isBuy = direction.charAt(0) === 'B';
    s.lastDataAt = Date.now();
    const trade = { id: tradeId || [when,direction,price,qty].join('|'), side: isBuy ? 'BUY' : 'SELL',
      price: Number(price), qty: Number(qty), value, ts: when };
    s.trades.unshift(trade);
    (s.pendingTrades || (s.pendingTrades = [])).push(trade);
    if (when >= (s.lastTradeAt || 0)) { s.lastTradeAt = when; s.lastPrice = trade.price; }
    if (s.trades.length > 20000) s.trades.length = 20000;
    scheduleRender(id);
  }

  async function pollTrades(ex, pair) {
    if (document.hidden) return;
    const s = state(ex.id), generation = marketGeneration, market = selectedMarket;
    if (s.pollBusy) return;
    s.pollBusy = true;
    try {
      const response = await fetch(`/api/orderflow/trades?venue=${encodeURIComponent(ex.id)}&market=${encodeURIComponent(market)}&limit=100`,
        { cache:'no-store', signal:AbortSignal.timeout(12000) });
      if (generation !== marketGeneration || pair !== s.pair) return;
      if (!response.ok) { s.lastError = 'HTTP ' + response.status; return; }
      const data = await response.json();
      if (generation !== marketGeneration || pair !== s.pair || data.pair !== pair) return;
      s.lastPollAt = Date.now(); s.lastError = '';
      (Array.isArray(data.trades) ? data.trades : []).forEach(t => addTrade(ex.id,t.side,t.price,t.qty,t.id,t.ts));
      render(ex.id);
    } catch (e) { if (generation === marketGeneration) s.lastError = 'Feed unavailable'; }
    finally { if (generation === marketGeneration) s.pollBusy = false; }
  }

  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      EXCHANGES.forEach(ex => {
        const pair = state(ex.id).pair;
        if (pair) {
          pollTrades(ex, pair);
          // Once per poll is enough to drop prints that aged out of the live
          // window; the key guard inside render() keeps an unchanged tape
          // from being rebuilt.
          render(ex.id, true);
        }
      });
    }, 3000);
    setInterval(() => {
      EXCHANGES.forEach(ex => render(ex.id, false));
      // Trades age out of the 45s window without a new print; refresh the
      // combined board and BUY OPEN / SELL OPEN chips so they fall with the
      // tapes and with the Traders terminal's running positions.
      updateBoard();
      const bridge = window.BinanceOrderFlowBridge;
      if (bridge && typeof bridge.refresh === 'function') bridge.refresh();
    }, 1000);
    // The chips refresh every 500ms; keep the combined board on the same
    // cadence so the venue + position totals never look out of step.
    setInterval(updateBoard, 500);
  }

  function connectCoinbase(pair, id) {
    const ws = sockets[id] = new WebSocket('wss://advanced-trade-ws.coinbase.com/ws');
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'subscribe', channel: 'market_trades', product_ids: [pair] }));
      state(id).connected = true; render(id);
    };
    const generation = marketGeneration;
    ws.onmessage = event => {
      if (generation !== marketGeneration) return;
      try {
        const msg = JSON.parse(event.data);
        (msg.events || []).forEach(ev => (ev.trades || []).forEach(tr => {
          addTrade(id, String(tr.side).toUpperCase() === 'SELL' ? 'BUY' : 'SELL', tr.price, tr.size,
                   tr.trade_id, Date.parse(tr.time));
        }));
      } catch (e) {}
    };
    ws.onclose = () => { state(id).connected = false; render(id); };
  }

  function connectKraken(pair, id) {
    const ws = sockets[id] = new WebSocket('wss://ws.kraken.com/v2');
    ws.onopen = () => {
      ws.send(JSON.stringify({ method: 'subscribe', params: { channel: 'trade', symbol: [pair] } }));
      state(id).connected = true; render(id);
    };
    const generation = marketGeneration;
    ws.onmessage = event => {
      if (generation !== marketGeneration) return;
      try {
        const msg = JSON.parse(event.data);
        // Keep the exchange trade id: the REST poll returns the same trades,
        // and without the id every one of them is counted twice.
        (msg.data || []).forEach(tr => addTrade(id, String(tr.side).toUpperCase(), tr.price, tr.qty,
          tr.trade_id, Date.parse(tr.timestamp)));
      } catch (e) {}
    };
    ws.onclose = () => { state(id).connected = false; render(id); };
  }

  function connectOkx(pair, id) {
    const ws = sockets[id] = new WebSocket('wss://ws.okx.com:8443/ws/v5/public');
    ws.onopen = () => {
      ws.send(JSON.stringify({ op: 'subscribe', args: [{ channel: 'trades', instId: pair }] }));
      state(id).connected = true; render(id);
    };
    const generation = marketGeneration;
    ws.onmessage = event => {
      if (generation !== marketGeneration) return;
      try {
        const msg = JSON.parse(event.data);
        (msg.data || []).forEach(tr => addTrade(id, tr.side === 'sell' ? 'SELL' : 'BUY', tr.px, tr.sz,
          tr.tradeId, Number(tr.ts)));
      } catch (e) {}
    };
    ws.onclose = () => { state(id).connected = false; render(id); };
  }

  function switchMarket(symbol) {
    const nextKey = symbolKey(symbol);
    // The chart fires chart:market for the same market more than once while
    // it boots; reconnecting every exchange each time only churns sockets.
    if (nextKey === selectedSymbol && (nextKey || selectedMarket === String(symbol || ''))) {
      selectedMarket = String(symbol || '');
      updateBoard();
      return;
    }
    selectedSymbol = nextKey; selectedMarket = String(symbol || ''); marketGeneration++;
    EXCHANGES.forEach(ex => {
      close(ex.id);
      const s = state(ex.id);
      s.buy = 0;
      s.sell = 0;
      s.trades = [];
      s.seen = new Set();
      s.tapeKey = '';
      s.pair = ex.pairs[selectedSymbol] || '';
      s.connected = false;
      s.lastDataAt = 0;
      s.lastPollAt = 0; s.lastError = ''; s.pollBusy = false; s.pendingTrades = []; s.lastTradeAt = 0; s.lastPrice = 0;
      render(ex.id);
      if (!s.pair) return;
      pollTrades(ex, s.pair);
      if (ex.id === 'coinbase') connectCoinbase(s.pair, ex.id);
      if (ex.id === 'kraken') connectKraken(s.pair, ex.id);
      if (ex.id === 'okx') connectOkx(s.pair, ex.id);
    });
    updateBoard();
  }

  function bind() {
    window.MultiExchangeOrderFlow = {
      // Venue-only totals (12 public tapes).
      getTotals: venueTotals,
      // One entry per contributing source (12 venues + Binance + Traders), so
      // the board and the chip tooltip can show exactly where each amount came
      // from.
      getBreakdown: sourceBreakdown,
      // Every source above. This is the number that feeds BUY OPEN / SELL
      // OPEN, and it includes Binance and the Traders running positions once.
      getOpenTotals: openTotals
    };
    window.addEventListener('chart:market', e => switchMarket(e.detail && e.detail.symbol));
    const first = $('tt-sidebar-connected-symbol') || $('tt-connected-symbol');
    switchMarket(first ? first.textContent : '');
    updateBoard();
    startPolling();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();
