/* Authoritative public wallet snapshots only; executions are not holdings. */
(function () {
  'use strict';
  var symbol = '', generation = 0, timer = null, controller = null, snapshot = null;
  var publicFeed = window.PublicWhaleFeed ? window.PublicWhaleFeed.create() : null, transport = 'server';
  var POLL_MS = 15000, STALE_MS = 60000;
  var $ = function (id) { return document.getElementById(id); };
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return {'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c];
    });
  }
  function number(value, max) {
    return Number(value).toLocaleString('en-US', {maximumFractionDigits: max});
  }
  function valid(data, market) {
    return data && data.market === market && Array.isArray(data.positions) &&
      ['ok', 'scanning', 'partial', 'unavailable', 'unsupported'].indexOf(data.status) >= 0 &&
      data.positions.every(function (row) {
        return row.contract === data.contract && /^0x[0-9a-f]{40}$/i.test(row.wallet) &&
          (row.side === 'BUY' || row.side === 'SELL') &&
          [row.entry_price, row.size, row.value_usd, row.verified_at].every(function (v) { return Number.isFinite(v) && v > 0; });
      });
  }
  function paint() {
    if (!$('whale-positions-panel')) return;
    var data = snapshot, rows = data ? data.positions : [], now = Date.now();
    var status = data ? data.status : 'scanning';
    $('whp-market').textContent = symbol || 'MARKET';
    $('whp-contract').textContent = !data ? 'Hyperliquid · verifying contract' :
      data.contract ? 'Hyperliquid · ' + data.contract_label + ' (' + data.contract + ')' : 'Hyperliquid · no position coverage';
    $('whp-status').textContent = data && data.scanning ? 'SCANNING' : status === 'ok' ? 'LIVE' : status.toUpperCase();
    $('whp-status').dataset.state = status;
    $('whp-note').textContent = data && status === 'unsupported' ? data.message :
      '$100,000+ to qualify · avg. entry · perpetual exposure differs from spot';
    ['BUY', 'SELL'].forEach(function (side) {
      // Counts refer to unique tracked wallets, not all market participants.
      var seen = Object.create(null);
      var selected = rows.filter(function (row) {
        if (row.side !== side || seen[row.wallet.toLowerCase()]) return false;
        seen[row.wallet.toLowerCase()] = true;
        return true;
      });
      var key = side.toLowerCase();
      $('whp-' + key + '-count').textContent = String(selected.length);
      var html = selected.map(function (row) {
        var stale = row.stale || now - row.verified_at > STALE_MS;
        var wallet = row.wallet, short = wallet.slice(0, 6) + '…' + wallet.slice(-4);
        var time = new Date(row.verified_at).toLocaleTimeString('en-US', {hour12: false});
        return '<div class="whp-row' + (stale ? ' stale' : '') + '">' +
          '<a class="whp-wallet" href="https://app.hyperliquid.xyz/explorer/address/' + esc(wallet) + '" target="_blank" rel="noopener noreferrer" title="Public wallet: ' + esc(wallet) + '" aria-label="View public wallet ' + esc(wallet) + '">Wallet ' + esc(short) + ' ↗</a>' +
          '<b class="whp-entry"><small>AVG. ENTRY</small>' + esc(number(row.entry_price, row.entry_price < 10 ? 6 : 2)) + '</b>' +
          '<span class="whp-value" title="Position value in USD">$' + esc(number(row.value_usd, 0)) + '</span>' +
          '<span class="whp-size">' + esc(number(row.size, 5)) + ' ' + esc(data.contract.split(':').pop()) + '</span>' +
          '<span class="whp-holding">' + (stale ? 'LAST VERIFIED · ' : 'OPEN AT CHECK · ') + esc(time) + '</span></div>';
      }).join('');
      if (!html) {
        var empty = status === 'unsupported' ? 'No public coverage for this market.' :
          status === 'unavailable' || status === 'partial' ? 'Coverage incomplete. Waiting for verified data.' :
          !data || status === 'scanning' ? 'Discovering wallets…' : 'No qualifying ' + side + ' wallets discovered.';
        html = '<p class="whp-empty">' + esc(empty) + '</p>';
      }
      var list = $('whp-' + key + '-list');
      if (list.innerHTML !== html) list.innerHTML = html;
    });
    var staleCount = rows.filter(function (row) { return row.stale || now - row.verified_at > STALE_MS; }).length;
    $('whp-foot').textContent = (data && data.updated_at ? 'Scan ' + new Date(data.updated_at).toLocaleTimeString('en-US', {hour12:false}) + ' · ' : '') +
      (data && data.wallets_checked ? data.wallets_checked + ' wallets checked · ' : '') +
      (staleCount ? staleCount + ' last verified · ' : '') +
      (data && (status === 'unavailable' || status === 'partial') ? data.message + '. ' : '') +
      'Holdings: Hyperliquid · discovery: Hypurrscan + recent fills. Partial coverage; company names undisclosed. Auto scan ~15s; exits removed after verified checks.';
    var foot = $('whp-foot');
    if (document.createElement && foot.appendChild) {
      var attribution = document.createElement('a');
      attribution.href = 'https://hypurrscan.io/about'; attribution.target = '_blank'; attribution.rel = 'noopener noreferrer';
      attribution.textContent = ' Hypurrscan source'; foot.appendChild(attribution);
    }
  }
  function schedule(delay) {
    clearTimeout(timer);
    timer = setTimeout(scan, delay);
  }
  function scan(initial) {
    clearTimeout(timer);
    if ((!initial && document.hidden) || !symbol || controller) return;
    var requested = symbol, token = generation, current = new AbortController();
    controller = current;
    var timeout = setTimeout(function () { current.abort(); }, 8000);
    function directScan() {
      if (!publicFeed || token !== generation) throw new Error('Public scanner unavailable');
      clearTimeout(timeout);
      if (current.signal.aborted) { current = new AbortController(); controller = current; }
      timeout = setTimeout(function () { current.abort(); }, 30000);
      transport = 'public';
      var task = publicFeed.scan(requested, current.signal);
      snapshot = publicFeed.snapshot(requested); paint();
      return task;
    }
    var task = transport === 'public' ? directScan() : fetch('/api/whales/positions?market=' + encodeURIComponent(requested), {
      cache: 'no-store', credentials: 'same-origin', signal: current.signal
    }).then(function (response) {
      if (!response.ok) {
        var error = new Error('Position feed unavailable');
        error.auth = response.status === 401 || response.status === 403;
        throw error;
      }
      return response.json().then(function(data) {
        // Older running Python instances can serve new assets but lack the new
        // route/scanner. Read the same public feeds directly until restarted.
        return publicFeed && data.scanner_version !== 2 ? directScan() : data;
      });
    }).catch(function(error) {
      if (publicFeed && !error.auth && token === generation) return directScan();
      throw error;
    });
    task.then(function (data) {
      if (token !== generation || requested !== symbol) return;
      if (!valid(data, requested)) throw new Error('Invalid position snapshot');
      // An unavailable/initial scan is not evidence that prior holdings exited.
      if (snapshot && snapshot.contract === data.contract &&
          (data.status === 'unavailable' || data.status === 'unsupported' || data.status === 'scanning')) {
        var returned = Object.create(null);
        data.positions.forEach(function (row) { returned[row.wallet.toLowerCase()] = true; });
        data.positions = data.positions.concat(snapshot.positions.filter(function (row) {
          return !returned[row.wallet.toLowerCase()];
        }).map(function (row) { return Object.assign({}, row, {stale: true}); }));
      }
      snapshot = data;
      paint();
    }).catch(function () {
      if (token !== generation || requested !== symbol) return;
      snapshot = Object.assign({}, snapshot || {positions: [], contract: '', contract_label: ''}, {
        status: 'unavailable', scanning: false, message: 'Feed unavailable; keeping last verified positions',
        positions: (snapshot ? snapshot.positions : []).map(function (row) { return Object.assign({}, row, {stale: true}); })
      });
      paint();
    }).finally(function () {
      clearTimeout(timeout);
      if (controller === current) controller = null;
      if (token === generation && !document.hidden) schedule(snapshot && snapshot.scanning ? 2000 : POLL_MS);
    });
  }
  function setMarket(next) {
    next = String(next || '').trim();
    if (!next || next === symbol) return;
    generation++;
    clearTimeout(timer);
    if (controller) controller.abort();
    controller = null;
    symbol = next;
    snapshot = null;
    if (publicFeed) {
      var saved = publicFeed.snapshot(next);
      if (saved.positions.length) snapshot = saved;
    }
    paint();
    // Always perform the first snapshot, including inside a hidden preview.
    // Later periodic scans still pause while the page is hidden.
    scan(true);
  }
  function init() {
    if (!$('whale-positions-panel')) return;
    var terminal = window.SoftradeXTerminal;
    setMarket((terminal && terminal.getCurrentSymbol ? terminal.getCurrentSymbol() : '') || 'XAUUSDm');
    window.addEventListener('chart:market', function (event) {
      var data = event.detail || {};
      setMarket(data.symbol || (data.meta && data.meta.symbol));
    });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        clearTimeout(timer);
      } else {
        paint();
        scan();
      }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
