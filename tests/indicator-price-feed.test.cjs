// Price-feed regressions: exact instrument, live quotes, outages and switches.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const NOW = Date.UTC(2026, 10, 13, 12, 1);
function sandbox(file, hooks) {
  let now = NOW, symbol = 'XAUUSDm', tf = '5m';
  const pending = [], listeners = new Map(), elements = new Map();
  const mapping = {XAUUSDm: 'OANDA:XAUUSD', BTCUSDT: 'BINANCE:BTCUSDT'};
  const window = {
    SOFT_TV_ACTIVE: true, SOFT_TV_VISIBLE: false,
    TvChartHost: {symbolFor: s => mapping[s] || ''},
    SoftradeXTerminal: {getCurrentSymbol: () => symbol, getInterval: () => tf,
      MARKETS: {XAUUSDm: {decimals: 2}, BTCUSDT: {decimals: 2}}},
    addEventListener(n, fn) {if (!listeners.has(n)) listeners.set(n, []); listeners.get(n).push(fn);},
    dispatchEvent(ev) {for (const fn of listeners.get(ev.type) || []) fn(ev);}
  };
  const context = vm.createContext({window, console, AbortController,
    Date: class extends Date {static now() {return now;}},
    document: {readyState: 'loading', addEventListener() {}, querySelector() {return null;},
      getElementById(id) {
        if (file.includes('chart-indicators')) return null;
        if (!elements.has(id)) elements.set(id, {textContent: '--', className: '',
          classList: {add() {}, remove() {}}, style: {}});
        return elements.get(id);
      }},
    localStorage: {getItem() {return '["msb"]';}, setItem() {}},
    requestAnimationFrame() {}, setTimeout() {}, clearTimeout() {},
    setInterval() {}, clearInterval() {},
    fetch(url, options) {return new Promise(resolve => pending.push({url, options, resolve}));},
    CustomEvent: class {constructor(type, init) {this.type = type; this.detail = init.detail;}}
  });
  let code = fs.readFileSync(file, 'utf8');
  const end = code.lastIndexOf('})();');
  code = code.slice(0, end) + '\nwindow.__test = {' + hooks + '};\n' + code.slice(end);
  vm.runInContext(code, context, {filename: file});
  return {window, api: window.__test, pending, elements, time(t) {now = t;},
    select(s, interval = '5m') {symbol = s; tf = interval;}};
}
const flush = async () => {for (let i = 0; i < 20; i++) await Promise.resolve();};
const quote = (price = 3900, at = NOW) => ({symbol: 'XAUUSDm', tv_symbol: 'OANDA:XAUUSD', price, at, change: 0.5});
function answer(req, {symbol = 'XAUUSDm', tf = '5m', instrument = 'OANDA:XAUUSD', end = NOW - 60000} = {}) {
  req.resolve({ok: true, json: async () => ({ok: true, symbol, tf, tv_symbol: instrument,
    bars: [[end - 300000, 3898, 3900, 3897, 3899, 10], [end, 3899, 3901, 3898, 3900, 20]]})});
}
const indicator = () => sandbox('web/chart-indicators.js', 'loadBars,acceptQuote,rows(){return bars;}');

test('indicators request the exact embed instrument and follow TV quotes with iframe hidden', async () => {
  const s = indicator(); s.api.loadBars(); s.api.loadBars();
  assert.equal(s.pending.length, 1, 'duplicate in-flight request');
  const url = new URL(s.pending[0].url, 'http://localhost');
  assert.equal(url.pathname, '/api/chart/tvcandles');
  assert.equal(url.searchParams.get('tv_symbol'), 'OANDA:XAUUSD');
  answer(s.pending[0]); await flush();
  s.window.dispatchEvent({type: 'chart:tv-quote', detail: quote(3902)});
  assert.equal(s.window.ChartIndicators.state().price, 3902);
  assert.equal(s.api.rows()[1].c, 3902);
  assert.equal(s.api.rows()[1].h, 3902);
  assert.equal(s.api.rows()[0].c, 3899, 'closed candle must stay unchanged');
  assert.equal(s.window.ChartIndicators.state().tvSymbol, 'OANDA:XAUUSD');
});

test('foreign, stale and out-of-order quotes cannot change the indicator price', async () => {
  const s = indicator(); s.api.loadBars(); answer(s.pending[0]); await flush();
  assert.equal(s.api.acceptQuote(quote()), true);
  assert.equal(s.api.acceptQuote({...quote(70000), symbol: 'BTCUSDT', tv_symbol: 'BINANCE:BTCUSDT'}), false);
  assert.equal(s.api.acceptQuote({...quote(70000), tv_symbol: 'BINANCE:PAXGUSDT'}), false);
  assert.equal(s.api.acceptQuote(quote(3901, NOW - 1000)), false);
  s.time(NOW + 26000);
  assert.equal(s.api.acceptQuote(quote(3901)), false);
  assert.equal(s.window.ChartIndicators.state().price, 3900);
});

test('a fetched quote never creates weekend candles or rewrites closed history', async () => {
  const s = indicator(); s.api.loadBars(); answer(s.pending[0], {end: NOW - 86400000}); await flush();
  const before = JSON.stringify(s.api.rows());
  assert.equal(s.api.acceptQuote(quote(3902)), true);
  assert.equal(JSON.stringify(s.api.rows()), before);
  assert.equal(s.window.ChartIndicators.state().price, 3902);
});

test('late old-market and old-timeframe bars cannot replace the selected indicator series', async () => {
  const s = indicator(); s.api.loadBars();
  s.select('BTCUSDT'); s.api.loadBars();
  assert.equal(s.pending[0].options.signal.aborted, true);
  answer(s.pending[0]); await flush();
  assert.equal(s.window.ChartIndicators.state().bars, 0);
  assert.equal(s.window.ChartIndicators.state().symbol, 'BTCUSDT');
  s.select('BTCUSDT', '1h'); s.api.loadBars();
  answer(s.pending[1], {symbol: 'BTCUSDT', instrument: 'BINANCE:BTCUSDT'}); await flush();
  assert.equal(s.window.ChartIndicators.state().bars, 0);
  answer(s.pending[2], {symbol: 'BTCUSDT', tf: '1h', instrument: 'BINANCE:BTCUSDT'}); await flush();
  assert.equal(s.window.ChartIndicators.state().bars, 2);
  assert.equal(s.window.ChartIndicators.state().tf, '1h');
});

test('TradingView candle outage never falls back to a different provider', async () => {
  const s = indicator(); s.api.loadBars();
  s.pending[0].resolve({ok: false}); await flush();
  assert.match(s.window.ChartIndicators.state().error, /TradingView/);
  assert.equal(s.window.ChartIndicators.state().bars, 0);
  assert.equal(s.pending.length, 1);
  s.api.loadBars();
  assert.ok(s.pending[1].url.startsWith('/api/chart/tvcandles?'));
});

test('header stays on TV price when indicators hide the iframe and when TV becomes stale', () => {
  const s = sandbox('web/softradex-terminal.js',
    'updateTickerDisplay,seed(){currentSymbol="XAUUSDm";MARKETS.XAUUSDm={decimals:2};}');
  s.api.seed(); s.window.SOFT_TV_QUOTE = quote();
  s.api.updateTickerDisplay({price: 3870, change: -1});
  assert.equal(s.elements.get('b-live-price').textContent, '3,900.00');
  s.window.SOFT_TV_VISIBLE = true;
  s.window.dispatchEvent({type: 'chart:tv-visible', detail: {visible: true}});
  assert.equal(s.elements.get('b-live-price').textContent, '3,900.00');
  s.time(NOW + 26000);
  s.api.updateTickerDisplay({price: 3875, change: -2});
  assert.equal(s.elements.get('b-live-price').textContent, '3,900.00');
});
