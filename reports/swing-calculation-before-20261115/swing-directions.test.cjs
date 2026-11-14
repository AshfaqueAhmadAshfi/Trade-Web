// Shared arbitration is tested with deterministic candles, quotes and clocks.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const START = Date.UTC(2026, 10, 14, 12);
const minutes = {'1m': 1, '5m': 5, '15m': 15, '1h': 60, '4h': 240, '1d': 1440};
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function bars(side, tf, now) {
  return Array.from({length: 140}, (_, i) => {
    const close = 100 + (side === 'BUY' ? 1 : -1) * (i - 139) * 0.1;
    return [now - (140 - i) * minutes[tf] * 60000, close, close + 1.3, close - 1.3, close, 100];
  });
}
function fixture(options = {}) {
  let now = options.now || START, timer = 0;
  const requests = [], elements = new Map(), listeners = new Map(), timers = new Map(), storage = options.storage || new Map();
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const document = {readyState: 'loading', hidden: false, addEventListener() {}, getElementById(id) {
    if (!elements.has(id)) elements.set(id, {textContent: '', innerHTML: '', style: {}, attrs: {},
      setAttribute(key, value) { this.attrs[key] = value; }});
    return elements.get(id);
  }};
  const window = {addEventListener(type, fn) { listeners.set(type, [...(listeners.get(type) || []), fn]); }};
  const context = vm.createContext({document, window, Date: Clock, AbortController, console,
    localStorage: {getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v)},
    setTimeout(fn, ms) { const id = ++timer; timers.set(id, {fn, ms}); return id; }, clearTimeout(id) { timers.delete(id); }, setInterval() {},
    fetch(url, options) { return new Promise((resolve, reject) => {
      requests.push({url, options, resolve, reject});
      options.signal.addEventListener('abort', () => reject(new Error('timeout')));
    }); }});
  let code = fs.readFileSync('web/swing-ai.js', 'utf8'), end = code.lastIndexOf('})();');
  code = code.slice(0, end) + '\nwindow.__test={acceptQuote,init,loadCandles,loadPrice,maybeRebuild,paint,combine,bracket,closedBars,setSymbol,loadLog,scoreLine,confluence,px,restorePlan,planPriceCrossed,' +
    'seed(){symbol="XAUUSDm";},setVote(v){vote=v;},setPlan(p){plan=p;},setLive(p,at){price=p;updatedAt=at;},busy(){return candleBusy;}};\n' + code.slice(end);
  vm.runInContext(code, context);
  const api = window.__test;
  api.seed();
  const quote = price => ({symbol: 'XAUUSDm', tv_symbol: 'OANDA:XAUUSD', price, at: now, ok: true});
  return {api, window, document, requests, elements, storage, timers, context,
    advance(ms = 1000) { now += ms; }, now: () => now,
    async candles(side, extra = {}) {
      const first = requests.length;
      api.loadCandles();
      for (const req of requests.slice(first)) {
        const tf = new URL('http://local' + req.url).searchParams.get('tf');
        req.resolve({ok: true, json: async () => ({ok:true,tf,source:'TradingView',tv_symbol:'OANDA:XAUUSD',symbol: 'XAUUSDm',
          bars: bars(typeof side === 'function' ? side(tf) : side, tf, now), ...extra})});
      }
      await flush();
    },
    quote(price = 100) {
      return context.window.__test.acceptQuote(quote(price));
    },
    state: () => window.SwingAI.state(),
    paint: () => api.paint(now)
  };
}

function assertExclusive(f, expected) {
  const state = f.state(), active = Object.values(state.panels).filter(p => p.active);
  assert.ok(active.length <= 1, 'two directions must never be active');
  assert.equal(state.activeSide, expected);
  f.paint();
  assert.equal(f.elements.get('sai-side').textContent, expected === 'SELL' ? '▼ SELL' : '◆ WAIT');
  assert.equal(f.elements.get('sbi-side').textContent, expected === 'BUY' ? '▲ BUY' : '◆ WAIT');
}

for (const side of ['BUY', 'SELL']) {
  test(`${side} conditions arm only the matching panel with valid levels`, async () => {
    const f = fixture();
    await f.candles(side); f.quote();
    assertExclusive(f, side);
    const p = f.state().plan;
    assert.ok(p.rr >= 1.2);
    assert.ok(side === 'BUY' ? p.stop < p.entry && p.entry < p.target : p.target < p.entry && p.entry < p.stop);
    const other = f.state().panels[side === 'BUY' ? 'SELL' : 'BUY'];
    assert.equal(other.plan, null);
    assert.equal(other.lockedBy, side);
  });
}

test('a running BUY keeps its lock and frozen levels after the vote turns SELL, then releases after target', async () => {
  const f = fixture();
  await f.candles('BUY'); f.quote();
  f.advance(); f.quote(f.state().plan.entry);
  assert.equal(f.state().plan.running, true);
  const held = {...f.state().plan};
  f.advance();
  // Higher timeframes refresh every third cycle; a fast-frame flip alone
  // must not be mistaken for a confirmed reversal of the whole market.
  for (let i=0;i<3;i++) await f.candles('SELL');
  assert.equal(f.state().vote.side, 'SELL');
  assertExclusive(f, 'BUY');
  for (const key of ['entry', 'target', 'stop', 'startAt', 'endAt']) assert.equal(f.state().plan[key], held[key]);
  f.advance(); f.quote(held.target);
  assert.equal(f.state().plan.hit, true);
  assertExclusive(f, 'NONE');
  f.advance(5000); f.quote(held.target);
  assertExclusive(f, 'SELL');
  assert.equal(f.elements.get('sbi-entry').textContent, '—');
});

test('an unfilled BUY is replaced by a confirmed SELL without leaving two armed panels', async () => {
  const f = fixture();
  await f.candles('BUY'); f.quote();
  assertExclusive(f, 'BUY');
  f.advance();
  for (let i=0;i<3;i++) await f.candles('SELL');
  assertExclusive(f, 'SELL');
  assert.equal(f.elements.get('sbi-entry').textContent, '—');
});

test('a running SELL blocks BUY until its observed stop, then releases BUY', async () => {
  const f=fixture();
  await f.candles('SELL'); f.quote();
  f.advance(); f.quote(f.state().plan.entry);
  const held={...f.state().plan};
  assert.equal(held.running,true);
  f.advance();
  for(let i=0;i<3;i++) await f.candles('BUY');
  assert.equal(f.state().vote.side,'BUY');
  assertExclusive(f,'SELL');
  f.advance(); f.quote(held.stop);
  assert.ok(f.state().plan.doneAt);
  assertExclusive(f,'NONE');
  f.advance(5000); f.quote(held.stop);
  assertExclusive(f,'BUY');
});

test('weak, neutral or unconfirmed readings clear an unfilled setup', async () => {
  for (const v of [{side:'NEUTRAL',confidence:0,score:0}, {side:'BUY',confidence:40,score:10}, {side:'SELL',confidence:90,score:-20}]) {
    const f = fixture();
    await f.candles('BUY'); f.quote();
    f.api.setVote(v); f.api.maybeRebuild(f.now());
    assert.equal(f.state().plan, null);
    assertExclusive(f, 'NONE');
  }
  const f = fixture();
  assert.equal(f.api.combine({M5:{ready:true,score:4},M15:{ready:true,score:4},H4:{ready:true,score:-4}},50).side,'NEUTRAL');
});

test('a stale quote pauses both panels, and stale candle history cannot rearm from a fresh quote', async () => {
  const f = fixture();
  await f.candles('BUY'); f.quote();
  f.advance(16000); assertExclusive(f, 'NONE');
  f.advance(80000); f.quote();
  assert.equal(f.state().plan, null);
  assertExclusive(f, 'NONE');
});

test('future/foreign quotes and wrong-market candles cannot create a direction', async () => {
  const f = fixture();
  await f.candles('BUY', {symbol:'BTCUSDT'}); f.quote();
  assert.equal(f.state().plan, null);
  assert.equal(f.api.acceptQuote({symbol:'XAUUSDm',tv_symbol:'OANDA:XAUUSD',price:100,at:f.now()+6000}),false);
  assert.equal(f.api.acceptQuote({symbol:'BTCUSDT',tv_symbol:'BINANCE:BTCUSDT',price:100,at:f.now()}),false);
});

test('closed-candle validation excludes forming/invalid bars and handles seconds, sorting and duplicates', () => {
  const f = fixture(), tf = {minutes:5};
  const old = [START-300000,100,102,98,101,10];
  const values = f.api.closedBars([old,[START,100,102,98,101,10], [START-600000,100,90,98,101,10],
    [START-900000,100,102,98,101,10], [old[0]/1000,...old.slice(1)]],tf,START);
  assert.equal(values.length,2);
  assert.equal(values[0][0],START-900000);
  assert.equal(values[1][0],START-300000);
});

test('invalid or wrong-side structural stops never produce an inverted bracket', () => {
  const f = fixture();
  const m5={atr:2,swingLow:101,swingHigh:104};
  assert.ok(f.api.bracket('BUY',100,m5).stop<100);
  assert.ok(f.api.bracket('SELL',105,m5).stop>105);
  assert.equal(f.api.bracket('SELL',1,{atr:10,swingLow:1,swingHigh:2}),null);
});

test('two panels share one initial request batch and stalled requests time out before retry', async () => {
  const f = fixture(); f.api.init();
  assert.equal(f.requests.filter(r=>r.url.includes('/tvcandles')).length,6);
  assert.equal(f.requests.filter(r=>r.url.includes('/tvquote')).length,1);
  for(const item of [...f.timers.values()]) if(item.ms===12000) item.fn();
  await flush();
  assert.equal(f.api.busy(),false);
  f.api.loadCandles();
  assert.equal(f.requests.filter(r=>r.url.includes('/tvcandles')).length,9);
});

test('a recent BUY miss raises only BUY requirements, with separate direction histories', async () => {
  const f=fixture();
  await f.candles('BUY'); f.quote();
  f.storage.set('softradex.swing.log.XAUUSDm',JSON.stringify([{t:f.now(),side:'BUY',kind:'miss'}]));
  f.api.loadLog(); f.api.setPlan(null); f.api.setVote({side:'BUY',confidence:60,score:12});
  f.api.maybeRebuild(f.now());
  assert.equal(f.state().plan,null);
  assert.equal(f.api.scoreLine('BUY'),'last 1: 0H / 1M');
  assert.equal(f.api.scoreLine('SELL'),'');
  for(let i=0;i<3;i++) await f.candles('SELL');
  assertExclusive(f,'SELL');
  f.api.setSymbol('BTCUSDT');
  assert.equal(f.api.scoreLine('BUY'),'');
  assertExclusive(f,'NONE');
});

test('Buy panel follows Running News and both panel IDs are unique', () => {
  const html=fs.readFileSync('web/index.html','utf8');
  assert.match(html,/id="running-news-list"[^]*?<\/section>\s*<section[^>]*id="buy-swing-ai-board"/);
  assert.match(html,/>NEXT SELL SWING AI</);
  assert.match(html,/>NEXT BUY SWING AI</);
  const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);
  assert.equal(new Set(ids).size,ids.length);
});

test('BUY and SELL compute separate models, and fast/higher timeframe conflict leaves both waiting', async () => {
  const f=fixture(); await f.candles('BUY'); f.quote();
  assert.equal(f.state().models.BUY.eligible,true);
  assert.equal(f.state().models.SELL.eligible,false);
  assert.ok(f.state().models.BUY.confidence > f.state().models.SELL.confidence);
  const mixed=fixture();
  await mixed.candles(tf => tf === '5m' ? 'SELL' : 'BUY'); mixed.quote();
  assertExclusive(mixed,'NONE');
  assert.equal(mixed.state().models.BUY.eligible,false);
  assert.equal(mixed.state().models.SELL.eligible,false);
});

test('moving quotes preserve exact candle prices and the displayed entry bracket', async () => {
  const f=fixture(); await f.candles('BUY'); f.quote();
  const before=JSON.parse(JSON.stringify(f.state().plan)), close=f.state().reads.M5.close;
  f.advance(); f.quote(100.25);
  assert.equal(f.state().price,100.25);
  assert.equal(f.state().reads.M5.close,close);
  assert.equal(close,100);
  for(const key of ['entry','target','stop','startAt','endAt']) assert.equal(f.state().plan[key],before[key]);
});

test('unavailable, proxy, wrong-instrument and wrong-timeframe candles never create a plan', async () => {
  for(const extra of [{source:'public'}, {tv_symbol:'BINANCE:BTCUSDT'}, {tf:'unsupported'}, {bars:[]}, {ok:false}]) {
    const f=fixture(); await f.candles('BUY',extra); f.quote();
    assertExclusive(f,'NONE');
  }
});

test('one timeframe and a saturated flow bias cannot replace broad candle confirmation', () => {
  const f=fixture(), v=f.api.combine({M5:{ready:true,score:8}},100);
  assert.ok(v.confidence < 55);
  assert.ok(v.models.BUY.confidence < 55);
  assert.equal(v.models.SELL.confidence,0);
});

test('entry selection rejects far levels and a target obstructed before minimum reward', async () => {
  const f=fixture(); await f.candles('BUY'); f.quote();
  assert.equal(f.api.confluence('BUY',1000),null);
  assert.equal(f.api.bracket('BUY',100,{atr:2,swingLow:99,swingHigh:100.5}),null);
  assert.equal(f.api.bracket('SELL',100,{atr:2,swingLow:99.5,swingHigh:101}),null);
});

test('a running setup times out on its wall-clock deadline even when the quote is stale', async () => {
  const f=fixture(); await f.candles('BUY'); f.quote();
  f.advance(); f.quote(f.state().plan.entry);
  const end=f.state().plan.endAt;
  f.advance(end-f.now()); f.paint();
  assert.equal(f.state().plan.outcome,'timeout');
  assert.equal(f.state().activeSide,'NONE');
  assert.equal(f.api.scoreLine('BUY'),'');
});

test('a data gap leaves any later boundary exit unverified instead of reporting a win', async () => {
  const f=fixture(); await f.candles('BUY'); f.quote();
  f.advance(); f.quote(f.state().plan.entry);
  const held={...f.state().plan};
  f.advance(20000); f.quote(held.entry);
  assert.equal(f.state().plan.coverageGap,true);
  f.advance(); f.quote(held.target);
  assert.equal(f.state().plan.outcome,'unverified');
  assert.equal(f.state().plan.hit,false);
  assert.equal(f.api.scoreLine('BUY'),'');
  assertExclusive(f,'NONE');
});

test('active setup levels survive reload and a market round trip without duplicating the direction', async () => {
  const f=fixture(); await f.candles('BUY'); f.quote();
  f.advance(); f.quote(f.state().plan.entry);
  const held={...f.state().plan};
  const restored=fixture({now:f.now(),storage:f.storage});
  restored.api.restorePlan(); restored.advance(); restored.quote(held.entry);
  assertExclusive(restored,'BUY');
  for(const key of ['entry','target','stop','startAt','endAt']) assert.equal(restored.state().plan[key],held[key]);
  f.api.setSymbol('BTCUSDT'); assertExclusive(f,'NONE');
  f.api.setSymbol('XAUUSDm'); f.advance(); f.quote(held.entry);
  assertExclusive(f,'BUY');
  assert.equal(f.state().plan.endAt,held.endAt);
});

test('same-time revised quotes are rejected and a completed structure cannot immediately rearm', async () => {
  const f=fixture(); await f.candles('BUY'); f.quote();
  assert.equal(f.api.acceptQuote({symbol:'XAUUSDm',tv_symbol:'OANDA:XAUUSD',price:101,at:f.now()}),false);
  f.advance(); f.quote(f.state().plan.entry);
  f.advance(); f.quote(f.state().plan.target);
  const signal=f.state().plan.signalId;
  f.advance(5000); f.quote(100);
  assertExclusive(f,'NONE');
  assert.ok(!f.state().plan || f.state().plan.signalId !== signal);
  assert.match(f.state().models.BUY.reason,/already completed/);
});

test('the panels retain useful price precision for forex and small crypto values', () => {
  const f=fixture(); f.api.setSymbol('EURUSDm');
  assert.equal(f.api.px(1.08321),'1.08321');
  f.api.setSymbol('USDJPYm'); assert.equal(f.api.px(153.127),'153.127');
  assert.equal(f.api.px(0.00001234),'0.00001234');
});

test('confirmation cannot replay a quote that was already evaluated while the signal was weak', async () => {
  const f=fixture(); await f.candles('BUY'); f.quote();
  const entry=f.state().plan.entry;
  f.advance(); f.api.setVote({side:'NEUTRAL',confidence:0,score:0}); f.api.setLive(entry,f.now());
  f.api.planPriceCrossed(f.now());
  assert.equal(f.state().plan.running,false);
  f.api.setVote({side:'BUY',confidence:90,score:20}); f.api.planPriceCrossed(f.now());
  assert.equal(f.state().plan.running,false);
  f.advance(); f.quote(entry);
  assert.equal(f.state().plan.running,true);
});

test('malformed or expired cached plans cannot become an active direction', async () => {
  const original=fixture(); await original.candles('BUY'); original.quote();
  const saved=JSON.parse(original.storage.get('softradex.swing.plan.v2.XAUUSDm'));
  for(const change of [{stop:saved.plan.target+1}, {endAt:START-1}, {candleSource:'public'}, {etaMin:0}]) {
    const f=fixture(); f.storage.set('softradex.swing.plan.v2.XAUUSDm',JSON.stringify({...saved,plan:{...saved.plan,...change}}));
    f.api.restorePlan(); assert.equal(f.state().plan,null);
  }
});
