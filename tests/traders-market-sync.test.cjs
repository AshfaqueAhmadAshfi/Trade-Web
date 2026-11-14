const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function fixture(initial = 'BTCUSDTm') {
  let selected = initial;
  const listeners = new Map(), intervals = [], timers = [];
  const label = {textContent: ''}, tape = {innerHTML: ''}, status = {textContent: ''};
  const document = {
    hidden: false, readyState: 'complete',
    getElementById() { return null; },
    querySelectorAll(selector) {
      if (selector.includes('connected-symbol')) return [label];
      if (selector === '.tt-tape-body') return [tape];
      if (selector.includes('tt-status-text')) return [status];
      return [];
    }
  };
  const window = {
    SoftradeXTerminal: {getCurrentSymbol: () => selected},
    flowSymbol: () => 'XAUUSDm',
    addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
    dispatchEvent(event) { for (const fn of listeners.get(event.type) || []) fn(event); }
  };
  let source = fs.readFileSync('web/traders-terminal.js', 'utf8');
  const end = source.lastIndexOf('})();');
  source = source.slice(0, end) + '\nwindow.testState={totals, pause(value){paused=value;}};\n' + source.slice(end);
  vm.runInNewContext(source, {window, document, Date, Intl,
    setTimeout(fn) { timers.push(fn); return timers.length; },
    setInterval(fn) { intervals.push(fn); },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } }
  });
  const emit = (type, detail) => window.dispatchEvent({type, detail});
  return {window, document, label, tape, status,
    select(symbol, metadataOnly = false) {
      selected = symbol;
      emit('chart:market', metadataOnly ? {meta: {symbol}} : {symbol});
    },
    tick() { for (const fn of intervals) fn(); },
    print(symbol, price = 100, id = '1') {
      emit('orderflow:prints', {symbol, venue: 'binance', pair: symbol,
        trades: [{id, price, qty: 2, side: 'BUY', ts: Date.now()}]});
      while (timers.length) timers.shift()();
    }
  };
}

test('initial selection and periodic sync prefer the chart over an old backend market', () => {
  const f = fixture();
  assert.equal(f.window.TradersTerminal.getActiveSymbol(), 'BTCUSDTm');
  f.tick();
  assert.equal(f.window.TradersTerminal.getActiveSymbol(), 'BTCUSDTm');
  assert.equal(f.label.textContent, 'BTCUSDTM');
});

test('market switches reset flow and reject late prints from the previous market', () => {
  const f = fixture();
  f.print('BTCUSDm');
  assert.equal(f.window.testState.totals().totalVol, 200);
  f.select('ETHUSDm');
  assert.equal(f.window.testState.totals().totalVol, 0);
  assert.match(f.tape.innerHTML, /ETHUSDm/);
  f.print('BTCUSDTm', 999, 'late');
  assert.equal(f.window.testState.totals().totalVol, 0);
  f.print('ETHUSDT', 250, 'current');
  assert.equal(f.window.testState.totals().totalVol, 500);
  assert.doesNotMatch(f.tape.innerHTML, /999/);
});

test('changing market clears the displayed tape while paused and hidden', () => {
  const f = fixture();
  f.print('BTCUSDTm', 111);
  assert.match(f.tape.innerHTML, /111/);
  f.window.testState.pause(true);
  f.document.hidden = true;
  f.select('ETHUSDm');
  assert.doesNotMatch(f.tape.innerHTML, /111/);
  assert.match(f.tape.innerHTML, /ETHUSDm/);
  assert.equal(f.window.testState.totals().totalVol, 0);
});

test('aliases keep the same market prints while updating the selected symbol label', () => {
  const f = fixture('SOLUSDm');
  f.print('SOLUSDT', 50);
  f.select('SOLUSDTm');
  assert.equal(f.window.testState.totals().totalVol, 100);
  assert.equal(f.label.textContent, 'SOLUSDTM');
  f.tick();
  assert.equal(f.window.testState.totals().totalVol, 100);
});

test('metadata market events work and uncovered markets cannot retain another market tape', () => {
  const f = fixture();
  f.print('BTCUSDTm');
  f.select('EURUSDm', true);
  f.tick();
  f.print('BTCUSDTm', 100, 'old');
  assert.equal(f.window.TradersTerminal.getActiveSymbol(), 'EURUSDm');
  assert.equal(f.window.testState.totals().totalVol, 0);
  assert.match(f.status.textContent, /No public exchange tape for EURUSDm/);
});

test('pipeline market uses the current chart and retains its fallback before chart startup', () => {
  const source = fs.readFileSync('web/app.js', 'utf8');
  const start = source.indexOf('function flowSymbol()');
  const end = source.indexOf('/* Buyer / seller pressure', start);
  let selected = 'BTCUSDTm';
  const context = vm.createContext({window: {SoftradeXTerminal: {getCurrentSymbol: () => selected}}});
  vm.runInContext("let flowPick=''; const S={bot5:{ai:{symbol:'XAUUSDm'}}}; function flowBoard(){return S.bot5.ai;}" + source.slice(start, end), context);
  assert.equal(context.flowSymbol(), 'BTCUSDTm');
  selected = 'ETHUSDm';
  assert.equal(context.flowSymbol(), 'ETHUSDm');
  selected = '';
  assert.equal(context.flowSymbol(), 'XAUUSDm');
});

test('the selected watch dial resolves USD/USDT aliases without borrowing a different market', () => {
  const source = fs.readFileSync('web/app.js', 'utf8');
  const start = source.lastIndexOf('function findWatchForSymbol(');
  const end = source.indexOf('/* Collect a new price tick', start);
  const context = vm.createContext({marketWatches: [{symbol: 'XAUUSDm'}, {symbol: 'BTCUSDm'}, {symbol: 'SOLUSDm'}], _tickerData: new Map()});
  vm.runInContext(source.slice(start, end), context);
  assert.equal(context.findWatchForSymbol('BTCUSDTm').symbol, 'BTCUSDm');
  assert.equal(context.findWatchForSymbol('SOLUSDT').symbol, 'SOLUSDm');
  assert.equal(context.findWatchForSymbol('EURUSDm'), null);
});
