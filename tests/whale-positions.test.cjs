const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../web/whale-positions.js'), 'utf8');
const wallet = n => '0x' + n.toString(16).padStart(40, '0');
const position = (n, side = 'BUY', extra = {}) => ({wallet: wallet(n), side,
  contract: 'xyz:GOLD', entry_price: 3900, size: 30, value_usd: 117000, verified_at: 1000000, ...extra});
const payload = (positions = [], extra = {}) => ({market: 'XAUUSDm', contract: 'xyz:GOLD',
  contract_label: 'Gold perpetual', provider: 'Hyperliquid', scanner_version: 2, status: 'ok', scanning: false, positions, ...extra});

function fixture(options = {}) {
  const elements = Object.fromEntries(['whale-positions-panel', 'whp-market', 'whp-contract', 'whp-status',
    'whp-note', 'whp-foot', 'whp-buy-count', 'whp-sell-count', 'whp-buy-list', 'whp-sell-list']
    .map(id => [id, {textContent: '', innerHTML: '', dataset: {}}]));
  const requests = [], timers = new Map(), events = {};
  let nextTimer = 0, now = 1000000;
  const listen = (type, fn) => (events[type] ||= []).push(fn);
  const document = {hidden: !!options.hidden, readyState: 'complete', getElementById: id => elements[id], addEventListener: listen};
  const window = {SoftradeXTerminal: {getCurrentSymbol: () => 'XAUUSDm'}, addEventListener: listen};
  if (options.feed) window.PublicWhaleFeed = {create: () => options.feed};
  class Clock extends Date { static now() { return now; } }
  const context = vm.createContext({window, document, Date: Clock, AbortController,
    setTimeout: (fn, delay) => { const id = ++nextTimer; timers.set(id, {fn, delay}); return id; },
    clearTimeout: id => timers.delete(id),
    fetch: (url, options) => new Promise((resolve, reject) => requests.push({url, options, resolve, reject}))});
  vm.runInContext(source, context);
  const dispatch = (type, detail) => (events[type] || []).forEach(fn => fn({detail}));
  const flush = () => new Promise(resolve => setImmediate(resolve));
  async function answer(index, data) {
    requests[index].resolve({ok: true, json: async () => data});
    await flush();
  }
  function poll() {
    const pending = [...timers].find(([, timer]) => timer.delay === 15000 || timer.delay === 2000);
    assert.ok(pending, 'a polling timer exists');
    timers.delete(pending[0]);
    pending[1].fn();
  }
  return {elements, requests, document, dispatch, answer, poll, flush, timers, setNow: value => { now = value; }};
}

test('BUY/SELL counts, wallet links and average entries are selected-market positions', async () => {
  const f = fixture();
  assert.match(f.requests[0].url, /market=XAUUSDm/);
  await f.answer(0, payload([position(1), position(2, 'SELL'), position(1)]));
  assert.equal(f.elements['whp-buy-count'].textContent, '1');
  assert.equal(f.elements['whp-sell-count'].textContent, '1');
  assert.match(f.elements['whp-buy-list'].innerHTML, /AVG\. ENTRY/);
  assert.match(f.elements['whp-buy-list'].innerHTML, /3,900/);
  assert.match(f.elements['whp-buy-list'].innerHTML, new RegExp(wallet(1)));
  assert.match(f.elements['whp-contract'].textContent, /Gold perpetual \(xyz:GOLD\)/);
});

test('a reduced hold stays visible, then a successful exit snapshot removes it', async () => {
  const f = fixture();
  await f.answer(0, payload([position(1)]));
  f.poll();
  await f.answer(1, payload([position(1, 'BUY', {size: 1, value_usd: 3900})]));
  assert.equal(f.elements['whp-buy-count'].textContent, '1');
  f.poll();
  await f.answer(2, payload([]));
  assert.equal(f.elements['whp-buy-count'].textContent, '0');
  assert.doesNotMatch(f.elements['whp-buy-list'].innerHTML, /whp-wallet/);
});

test('fetch failures and unavailable empty snapshots keep last verified rows', async () => {
  const f = fixture();
  await f.answer(0, payload([position(1)]));
  f.poll();
  f.requests[1].reject(new Error('offline'));
  await f.flush();
  assert.equal(f.elements['whp-buy-count'].textContent, '1');
  assert.match(f.elements['whp-buy-list'].innerHTML, /LAST VERIFIED/);
  f.poll();
  await f.answer(2, payload([], {status: 'unavailable', message: 'Provider unavailable'}));
  assert.equal(f.elements['whp-buy-count'].textContent, '1');
  assert.match(f.elements['whp-foot'].textContent, /Provider unavailable/);
});

test('an old market response is rejected even if its aborted request resolves late', async () => {
  const f = fixture();
  f.dispatch('chart:market', {symbol: 'BTCUSDTm'});
  assert.equal(f.requests[0].options.signal.aborted, true);
  assert.equal(f.elements['whp-buy-count'].textContent, '0');
  await f.answer(1, payload([position(2, 'SELL', {contract: 'BTC'})], {
    market: 'BTCUSDTm', contract: 'BTC', contract_label: 'BTC perpetual'}));
  await f.answer(0, payload([position(1)]));
  assert.equal(f.elements['whp-market'].textContent, 'BTCUSDTm');
  assert.equal(f.elements['whp-buy-count'].textContent, '0');
  assert.equal(f.elements['whp-sell-count'].textContent, '1');
  assert.doesNotMatch(f.elements['whp-sell-list'].innerHTML, /GOLD/);
});

test('invalid or wrong-contract snapshots cannot clear known holdings', async () => {
  const f = fixture();
  await f.answer(0, payload([position(1)]));
  f.poll();
  await f.answer(1, payload([position(2, 'SELL', {contract: 'BTC'})]));
  assert.equal(f.elements['whp-buy-count'].textContent, '1');
  assert.equal(f.elements['whp-sell-count'].textContent, '0');
  assert.match(f.elements['whp-buy-list'].innerHTML, /LAST VERIFIED/);
});

test('unsupported markets explicitly report no coverage and do not show prior market rows', async () => {
  const f = fixture();
  await f.answer(0, payload([position(1)]));
  f.dispatch('chart:market', {symbol: 'EURUSDm'});
  await f.answer(1, payload([], {market: 'EURUSDm', contract: '', contract_label: '',
    status: 'unsupported', message: 'No public held-position coverage for this market'}));
  assert.equal(f.elements['whp-buy-count'].textContent, '0');
  assert.match(f.elements['whp-buy-list'].innerHTML, /No public coverage/);
});

test('hidden pages pause polling and aged positions are labeled last verified', async () => {
  const f = fixture();
  await f.answer(0, payload([position(1)]));
  f.document.hidden = true;
  f.dispatch('visibilitychange');
  assert.equal(f.timers.size, 0);
  f.setNow(1061000);
  f.document.hidden = false;
  f.dispatch('visibilitychange');
  assert.match(f.elements['whp-buy-list'].innerHTML, /LAST VERIFIED/);
  assert.equal(f.requests.length, 2);
  // Another visibility event cannot overlap the in-flight snapshot request.
  f.dispatch('visibilitychange');
  assert.equal(f.requests.length, 2);
});

test('the whale panel stays in the live sidebar and has two count boxes', () => {
  const html = fs.readFileSync(path.join(__dirname, '../web/index.html'), 'utf8');
  assert.match(html, /<aside[^>]*id="market-live-sidebar"[^]*?id="whale-positions-panel"[^]*?<\/aside>/);
  assert.match(html, /BUY <span id="whp-buy-count">/);
  assert.match(html, /SELL <span id="whp-sell-count">/);
});

test('a hidden page still loads its first snapshot, then pauses periodic scans', async () => {
  const f = fixture({hidden: true});
  assert.equal(f.requests.length, 1);
  await f.answer(0, payload([position(1)]));
  assert.equal(f.elements['whp-buy-count'].textContent, '1');
  assert.equal(f.timers.size, 0);
});

test('a missing legacy API switches to public feeds and does not retry the 404 every poll', async () => {
  let scans = 0;
  const feed = {snapshot: () => payload([], {status: 'scanning'}),
    scan: async () => { scans++; return payload([position(2, 'SELL')]); }};
  const f = fixture({feed});
  f.requests[0].resolve({ok: false, status: 404});
  await f.flush();
  assert.equal(f.elements['whp-sell-count'].textContent, '1');
  f.poll();
  await f.flush();
  assert.equal(scans, 2);
  assert.equal(f.requests.length, 1);
});

test('an old cached API version uses the broader public scanner', async () => {
  let scans = 0;
  const feed = {snapshot: () => payload([], {status: 'scanning'}),
    scan: async () => { scans++; return payload([position(2, 'SELL')]); }};
  const f = fixture({feed});
  await f.answer(0, payload([position(1)], {scanner_version: undefined}));
  assert.equal(scans, 1);
  assert.equal(f.elements['whp-buy-count'].textContent, '0');
  assert.equal(f.elements['whp-sell-count'].textContent, '1');
});
