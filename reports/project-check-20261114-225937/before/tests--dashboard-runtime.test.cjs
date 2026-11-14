const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function exchange(file) {
  const listeners = {}, sockets = [];
  class Socket {
    constructor(url) { this.url = url; this.readyState = 0; this.closes = 0; sockets.push(this); }
    send() {}
    close() { assert.notEqual(this.readyState, 0, 'must not cancel a pending handshake'); this.closes++; this.readyState = 3; }
  }
  const window = {addEventListener(n, fn) { listeners[n] = fn; }, dispatchEvent() {}, setInterval() {}};
  const context = vm.createContext({window,
    document: {readyState: 'complete', querySelectorAll() { return []; },
      getElementById(id) { return id === 'tt-sidebar-connected-symbol' ? {textContent: 'BTCUSDm'} : null; }},
    WebSocket: Socket, CustomEvent: class {}, Date, AbortSignal,
    setTimeout() { return 1; }, clearTimeout() {}, setInterval() {}, clearInterval() {},
    fetch() { return new Promise(() => {}); }});
  vm.runInContext(fs.readFileSync(file, 'utf8'), context);
  return {window, sockets, select(symbol) { listeners['chart:market']({detail: {symbol}}); }};
}

test('market aliases reuse exchange sockets and a new market retires pending sockets safely', () => {
  const s = exchange('web/multi-exchange-order-flow.js');
  assert.equal(s.sockets.length, 3);
  s.select('BTCUSDTm');
  assert.equal(s.sockets.length, 3, 'one stream for aliases of the same market');
  const old = s.sockets.slice();
  s.select('XAUUSDm');
  assert.equal(s.sockets.length, 6);
  for (const socket of old) {
    assert.equal(socket.closes, 0);
    assert.equal(socket.onmessage, null, 'retired stream cannot publish into the new market');
    socket.readyState = 1;
    socket.onopen();
    assert.equal(socket.closes, 1);
  }
  assert.equal(s.window.MultiExchangeOrderFlow.getBreakdown().find(v => v.id === 'coinbase').pair, 'PAXG-USD');
});

test('Binance market switches retire a pending handshake without marking the new feed connected', () => {
  const s = exchange('web/binance-order-flow-terminal.js');
  assert.equal(s.sockets.length, 1);
  const old = s.sockets[0];
  s.select('XAUUSDm');
  assert.equal(s.sockets.length, 2);
  assert.equal(old.closes, 0);
  assert.equal(old.onmessage, null);
  old.readyState = 1;
  old.onopen();
  assert.equal(old.closes, 1);
  assert.equal(s.window.BinanceOrderFlowBridge.getTotals().pair, 'PAXGUSDT');
  assert.equal(s.window.BinanceOrderFlowBridge.getTotals().status, 'CONNECTING');
});

test('disabled bot countdown sends no mutation and manual setup refresh uses the public analyser', async () => {
  const source = fs.readFileSync('web/app.js', 'utf8');
  let refreshes = 0;
  const context = vm.createContext({window: {TvSetups: {refresh() { refreshes++; }}},
    fetch() { assert.fail('disabled bot must not send a request'); }});
  vm.runInContext('let botsEnabled=false; const CFG={order_execution:false};' +
    source.slice(source.indexOf('let bot3RecalcRemaining'), source.indexOf('/* ------------------------------------------------------------------- 3D Tilt')), context);
  for (let i = 0; i < 120; i++) context.tickBot3RecalcTimer();
  await context.triggerBot3Recalculate();
  assert.equal(refreshes, 0);
  await context.triggerBot3Recalculate(true);
  assert.equal(refreshes, 1);
});

function navigation() {
  let click;
  const requests = [], destinations = [], errors = [], label = {textContent: 'Logout'};
  const button = {disabled: false, querySelector() { return label; }, addEventListener(n, fn) { click = fn; }};
  vm.runInNewContext(fs.readFileSync('web/dashboard-navigation.js', 'utf8'), {
    document: {getElementById() { return button; }}, AbortSignal,
    window: {location: {replace(url) { destinations.push(url); }}, toast(kind, message) { errors.push({kind, message}); }},
    fetch(url, options) { return new Promise(resolve => requests.push({url, options, resolve})); }
  });
  return {button, label, requests, destinations, errors, click: () => click()};
}

test('Logout waits for session revocation and ignores duplicate clicks', async () => {
  const s = navigation();
  const first = s.click();
  await s.click();
  assert.equal(s.requests.length, 1);
  assert.equal(s.requests[0].url, '/api/logout');
  assert.equal(s.requests[0].options.method, 'POST');
  assert.equal(s.requests[0].options.credentials, 'same-origin');
  assert.equal(s.button.disabled, true);
  assert.deepEqual(s.destinations, []);
  s.requests[0].resolve({ok: true, json: async () => ({ok: true})});
  await first;
  assert.deepEqual(s.destinations, ['/access']);
});

test('Logout failure stays on the dashboard and allows retry', async () => {
  const s = navigation();
  const first = s.click();
  s.requests[0].resolve({ok: false, json: async () => ({ok: false})});
  await first;
  assert.deepEqual(s.destinations, []);
  assert.equal(s.button.disabled, false);
  assert.equal(s.label.textContent, 'Logout');
  assert.equal(s.errors[0].kind, 'error');
  const retry = s.click();
  s.requests[1].resolve({ok: true, json: async () => ({ok: true})});
  await retry;
  assert.deepEqual(s.destinations, ['/access']);
});
