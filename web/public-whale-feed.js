/* Public wallet discovery + authoritative holdings; works without a proxy route. */
(function (root) {
  'use strict';
  const INFO = 'https://api.hyperliquid.xyz/info';
  const SOURCES = ['USDC', 'HYPE'].map(token => 'https://api.hypurrscan.io/holdersWithLimit/' + token + '/100');
  const ADDRESS = /^0x[0-9a-f]{40}$/i, MIN = 100000, MAX = 24;
  const CRYPTO = 'BTC ETH SOL XRP DOGE ADA BNB LTC AVAX LINK DOT BCH TRX SUI TON NEAR APT SHIB PEPE UNI AAVE ONDO'.split(' ');
  const unique = values => [...new Set(values)];
  function contractFor(market) {
    const key = String(market).trim().toUpperCase().replace(/M$/, '');
    if (['GOLD', 'XAUUSD', 'XAUUSD247'].includes(key)) return {coin: 'xyz:GOLD', dex: 'xyz', label: 'Gold perpetual'};
    if (['SILVER', 'XAGUSD'].includes(key)) return {coin: 'xyz:SILVER', dex: 'xyz', label: 'Silver perpetual'};
    const coin = CRYPTO.find(base => [base, base + 'USD', base + 'USDT', base + 'USDC'].includes(key));
    return coin ? {coin, dex: '', label: coin + ' perpetual'} : null;
  }
  function number(value) {
    if (value == null || typeof value === 'boolean' || (typeof value === 'string' && !value.trim()) ||
        !Number.isFinite(Number(value))) throw new Error('Invalid position number');
    return Number(value);
  }
  function parsePosition(data, coin) {
    if (!data || !Array.isArray(data.assetPositions)) throw new Error('Invalid position snapshot');
    const matched = [];
    for (const item of data.assetPositions) {
      const p = item && item.position;
      if (!p || typeof p.coin !== 'string') throw new Error('Invalid position snapshot');
      const size = number(p.szi);
      if (p.coin !== coin) continue;
      if (matched.length) throw new Error('Duplicate position');
      matched.push(p);
      if (size !== 0 && (number(p.entryPx) <= 0 || number(p.positionValue) <= 0)) throw new Error('Invalid open position');
    }
    if (!matched.length || number(matched[0].szi) === 0) return null;
    const p = matched[0], size = number(p.szi);
    return {side: size > 0 ? 'BUY' : 'SELL', size: Math.abs(size), entry_price: number(p.entryPx), value_usd: number(p.positionValue)};
  }
  function holderWallets(data) {
    const holders = data && (data.holders || data.addresses);
    if (!holders || typeof holders !== 'object' || Array.isArray(holders)) throw new Error('Invalid public wallet list');
    return Object.entries(holders).slice(0, 1000).filter(([wallet, value]) => ADDRESS.test(wallet) && Number(value) > 0 && Number.isFinite(Number(value)))
      .sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 100).map(([wallet]) => wallet.toLowerCase());
  }
  async function http(url, body, signal) {
    const controller = new AbortController(), abort = () => controller.abort();
    if (signal && signal.aborted) abort();
    if (signal) signal.addEventListener('abort', abort, {once: true});
    const timer = setTimeout(abort, 6000);
    try {
      const response = await root.fetch(url, {method: body ? 'POST' : 'GET', signal: controller.signal,
        headers: body ? {'Content-Type': 'application/json'} : {}, body: body ? JSON.stringify(body) : undefined});
      if (!response.ok) throw new Error('Public feed returned HTTP ' + response.status);
      return await response.json();
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', abort);
    }
  }
  async function discover(signal) {
    const results = await Promise.allSettled(SOURCES.map(url => http(url, null, signal).then(holderWallets)));
    const groups = results.filter(result => result.status === 'fulfilled').map(result => result.value);
    if (!groups.length) throw new Error('Public wallet discovery unavailable');
    const wallets = [];
    for (let i = 0; i < Math.max(...groups.map(group => group.length)); i++) {
      for (const group of groups) if (group[i]) wallets.push(group[i]);
    }
    return {wallets: unique(wallets).slice(0, 200), partial: groups.length !== SOURCES.length};
  }
  function create(options = {}) {
    const info = options.info || ((body, signal) => http(INFO, body, signal));
    const discovery = options.discovery || discover;
    const clock = options.clock || Date.now;
    let storage = options.storage;
    if (storage === undefined) { try { storage = root.localStorage; } catch (_) {} }
    const states = new Map();
    let pool = [], poolAt = 0, poolPartial = false;
    function read(key) { try { return storage && JSON.parse(storage.getItem(key)); } catch (_) { return null; } }
    function write(key, value) { try { if (storage) storage.setItem(key, JSON.stringify(value)); } catch (_) {} }
    const savedPool = read('softradex.whales.discovery.v2');
    if (savedPool && Array.isArray(savedPool.wallets)) {
      pool = savedPool.wallets.filter(wallet => typeof wallet === 'string' && ADDRESS.test(wallet)).slice(0, 200);
      poolAt = Number(savedPool.at) || 0;
    }
    function stateFor(mapping) {
      if (!states.has(mapping.coin)) {
        const state = {mapping, rows: new Map(), checked: new Map(), updated: 0, metadataAt: 0,
          busy: false, status: 'scanning', message: 'Scanning public wallets', total: 0, count: 0};
        const saved = read('softradex.whales.positions.v2.' + mapping.coin);
        for (const row of (saved && Array.isArray(saved.positions) ? saved.positions : []).slice(0, MAX)) {
          if (row.contract === mapping.coin && ADDRESS.test(row.wallet) && ['BUY', 'SELL'].includes(row.side) &&
              ['size', 'entry_price', 'value_usd', 'verified_at', 'first_seen_at'].every(key => Number.isFinite(row[key]) && row[key] > 0)) {
            state.rows.set(row.wallet.toLowerCase(), {...row, failed: true});
          }
        }
        states.set(mapping.coin, state);
      }
      return states.get(mapping.coin);
    }
    function snapshot(market) {
      const mapping = contractFor(market);
      const base = {market, scanner_version: 2, provider: 'Hyperliquid', threshold_usd: MIN, scan_seconds: 15,
        max_tracked: MAX, discovery_sources: ['Hyperliquid recent trades', 'Hypurrscan public holders']};
      if (!mapping) return {...base, contract: '', contract_label: '', positions: [], buy_count: 0, sell_count: 0,
        status: 'unsupported', scanning: false, message: 'No public held-position coverage for this market', updated_at: 0};
      const state = stateFor(mapping);
      const positions = [...state.rows.values()].map(row => ({...row, stale: row.failed || clock() - row.verified_at > 60000}))
        .sort((a, b) => b.value_usd - a.value_usd);
      return {...base, contract: mapping.coin, contract_label: mapping.label, positions,
        buy_count: positions.filter(row => row.side === 'BUY').length, sell_count: positions.filter(row => row.side === 'SELL').length,
        status: state.status, scanning: state.busy, message: state.message, updated_at: state.updated,
        wallets_checked: state.count, candidates_total: state.total};
    }
    async function scan(market, signal) {
      const mapping = contractFor(market);
      if (!mapping) return snapshot(market);
      const state = stateFor(mapping);
      if (state.busy) return snapshot(market);
      state.busy = true;
      let failures = 0;
      try {
        if (!state.metadataAt || clock() - state.metadataAt > 3600000) {
          const meta = await info({type: 'meta', ...(mapping.dex ? {dex: mapping.dex} : {})}, signal);
          if (!meta || !Array.isArray(meta.universe)) throw new Error('Invalid contract metadata');
          if (!meta.universe.some(row => row.name === mapping.coin)) {
            const error = new Error('Selected contract is not listed by the provider');
            error.unsupported = true; throw error;
          }
          state.metadataAt = clock();
        }
        if (!poolAt || clock() - poolAt >= 900000) {
          try {
            const result = await discovery(signal), wallets = Array.isArray(result) ? result : result.wallets;
            if (!Array.isArray(wallets)) throw new Error('Invalid discovery response');
            pool = unique(wallets.filter(wallet => typeof wallet === 'string' && ADDRESS.test(wallet)).map(wallet => wallet.toLowerCase())).slice(0, 200);
            poolAt = clock(); poolPartial = !!result.partial;
            write('softradex.whales.discovery.v2', {wallets: pool, at: poolAt});
          } catch (_) { failures++; }
        }
        if (poolPartial) failures++;
        let recent = [];
        try {
          const trades = await info({type: 'recentTrades', coin: mapping.coin}, signal);
          if (!Array.isArray(trades)) throw new Error('Invalid recent trades');
          for (const trade of trades.slice(0, 50)) {
            if (!trade || trade.coin !== mapping.coin || !Array.isArray(trade.users)) throw new Error('Invalid recent trades');
            recent.push(...trade.users.filter(wallet => typeof wallet === 'string' && ADDRESS.test(wallet)).map(wallet => wallet.toLowerCase()));
          }
          recent = unique(recent);
        } catch (_) { failures++; }
        const order = wallets => wallets.filter(wallet => !state.rows.has(wallet))
          .sort((a, b) => (state.checked.get(a) || 0) - (state.checked.get(b) || 0));
        const broad = order(pool), fresh = order(recent);
        const added = unique([...broad.slice(0, 12), ...fresh.slice(0, 4), ...broad.slice(12), ...fresh.slice(4)])
          .slice(0, Math.min(16, MAX - state.rows.size));
        const tracked = [...state.rows.keys()].sort((a, b) => (state.checked.get(a) || 0) - (state.checked.get(b) || 0));
        const wallets = [...tracked.slice(0, 24 - added.length), ...added];
        state.total = unique([...pool, ...recent, ...tracked]).length; state.count = 0;
        for (let i = 0; i < wallets.length; i += 4) {
          if (signal && signal.aborted) throw new Error('Scan interrupted');
          const batch = wallets.slice(i, i + 4);
          const results = await Promise.allSettled(batch.map(wallet => info({type: 'clearinghouseState', user: wallet,
            ...(mapping.dex ? {dex: mapping.dex} : {})}, signal).then(data => parsePosition(data, mapping.coin))));
          results.forEach((result, index) => {
            const wallet = batch[index], previous = state.rows.get(wallet), at = clock();
            state.checked.set(wallet, at); state.count++;
            if (result.status === 'rejected') {
              failures++; if (previous) state.rows.set(wallet, {...previous, failed: true}); return;
            }
            const position = result.value;
            if (!position || (position.value_usd < MIN && (!previous || previous.side !== position.side))) state.rows.delete(wallet);
            else state.rows.set(wallet, {...position, wallet, contract: mapping.coin, verified_at: at, failed: false,
              first_seen_at: previous ? previous.first_seen_at : at});
          });
        }
        const retained = new Set([...pool, ...recent, ...state.rows.keys()]);
        for (const wallet of state.checked.keys()) if (!retained.has(wallet)) state.checked.delete(wallet);
        state.status = failures ? state.rows.size || wallets.length ? 'partial' : 'unavailable' : 'ok';
        state.message = failures ? 'Some public checks failed; keeping last verified holdings' : 'Public wallet scan complete';
      } catch (error) {
        state.status = error.unsupported ? 'unsupported' : 'unavailable';
        state.message = error.unsupported ? error.message : 'Public feeds unavailable; keeping last verified holdings';
        for (const [wallet, row] of state.rows) state.rows.set(wallet, {...row, failed: true});
      } finally {
        state.busy = false; state.updated = clock();
        write('softradex.whales.positions.v2.' + mapping.coin, {positions: [...state.rows.values()]});
      }
      return snapshot(market);
    }
    return {scan, snapshot};
  }
  const api = {create, contractFor, parsePosition, holderWallets};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PublicWhaleFeed = api;
})(typeof window === 'undefined' ? globalThis : window);
