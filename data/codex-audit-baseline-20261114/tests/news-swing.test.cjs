// Focused regressions: calendar lifecycle and the shared TradingView price.
// All quotes, candles and time are deterministic; no real API or order is used.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const NOW = Date.UTC(2026, 10, 13, 12);
function sandbox(file, hooks) {
  let now = NOW;
  class Clock extends Date { static now() { return now; } }
  const listeners = new Map(), pending = [], elements = new Map(), storage = new Map(), timers = new Map();
  let timerId = 0;
  const window = {
    addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
    dispatchEvent(ev) { for (const fn of listeners.get(ev.type) || []) fn(ev); }
  };
  const document = {
    readyState: 'loading', hidden: false, addEventListener() {}, querySelectorAll() { return []; },
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, {textContent: '', innerHTML: '', scrollTop: 0, style: {},
        classList: {add() {}, remove() {}, toggle() {}, contains() {return false;}}, addEventListener() {}, setAttribute() {}});
      return elements.get(id);
    }
  };
  const context = vm.createContext({ window, document, Date: Clock, console, AbortController,
    localStorage: {getItem(k) { return storage.get(k) || null; }, setItem(k,v) { storage.set(k,v); }},
    fetch(url, options) { return new Promise((resolve,reject) => {pending.push({url, options, resolve}); options?.signal?.addEventListener('abort',()=>reject(new Error('aborted')));}); },
    setTimeout(fn, ms) { const id=++timerId; timers.set(id,{fn,ms}); return id; }, clearTimeout(id) {timers.delete(id);}, setInterval() {},
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } }
  });
  if (file === 'web/chart-workspace.js') vm.runInContext(fs.readFileSync('web/news-direction.js','utf8'), context);
  let code = fs.readFileSync(file, 'utf8'), end = code.lastIndexOf('})();');
  code = code.slice(0, end) + '\nwindow.__test = {' + hooks + '};\n' + code.slice(end);
  vm.runInContext(code, context, {filename: file});
  return {api: window.__test, window, pending, elements, storage, time(value) { now = value; }, fireTimer(ms) {const entry=[...timers].find(([,t])=>t.ms===ms); assert.ok(entry,'missing timer '+ms); timers.delete(entry[0]); entry[1].fn();}};
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function respond(req, data) { req.resolve({ok: true, json: async () => data}); }
function quote(symbol = 'XAUUSDm', price = 3900) {
  return {ok: true, symbol, tv_symbol: symbol === 'XAUUSDm' ? 'OANDA:XAUUSD' : 'BINANCE:BTCUSDT', price, at: NOW};
}
function event(title, delta, impact = 'high') {
  return {title, ts: NOW / 1000 + delta, currency: 'USD', impact,
    impacted_markets: [{market: 'XAUUSDm', side: 'SELL', move_abs: 20, reason: 'USD release surprise'}]};
}
function newsSandbox() {
  return sandbox('web/chart-workspace.js', 'mergeNews,visibleEvents,entryTiming,levelPlan,predictionFor,directionalEstimate,renderNews,renderSources,relevanceFor,marketMatch,fetchNews,fetchExnessBrowser,exnessRows,restoreNews,init,setSources(st){sourceStatus=st;},seed(s){symbol=s;news=[];}');
}
function swingSandbox() {
  return sandbox('web/swing-ai.js', 'acceptQuote,loadPrice,loadCandles,setSymbol,init,seed(s){symbol=s;}');
}
const bars = (base = 100) => Array.from({length: 60}, (_, i) => {
  const c = base + i * 0.2;
  return [NOW - (60 - i) * 300000, c - 0.1, c + 0.3, c - 0.3, c, 100];
});

test('all running releases precede every upcoming event; expired/outside-24h rows disappear', () => {
  const s = newsSandbox(); s.api.seed('XAUUSDm');
  s.api.mergeNews([event('Next', 600), event('Running A', -30), event('Running B', -60),
    event('Expired low', -901, 'low'), event('Tomorrow', 86401), {...event('No mapping', 800), impacted_markets: []}]);
  assert.deepEqual(Array.from(s.api.visibleEvents(NOW / 1000), e => e.title), ['Running A', 'Running B', 'Next', 'No mapping']);
  // An upcoming-only refresh cannot discard a still-running release.
  s.api.mergeNews([event('Next', 600)]);
  assert.equal(s.api.visibleEvents(NOW / 1000).length, 3);
  s.time(NOW + 3601000);
  assert.equal(s.api.visibleEvents((NOW + 3601000) / 1000).some(e => e.title.startsWith('Running')), false);
});

test('same-time releases retain separate rows and release results replace cached predictions', () => {
  const s = newsSandbox(); s.api.seed('XAUUSDm');
  const a = event('CPI', -30), b = event('Claims', -30);
  s.api.mergeNews([a, b]);
  s.api.mergeNews([{...a, actual: 5, impacted_markets: [{market: 'XAUUSDm', side: 'BUY', move_abs: 25}]}]);
  const rows = s.api.visibleEvents(NOW / 1000);
  assert.equal(rows.length, 2);
  assert.equal(rows.find(e => e.title === 'CPI').impacted_markets[0].side, 'BUY');
});

test('SELL retrace and downside level use current TV quote; stale quotes cannot price entry', () => {
  const s = newsSandbox(); s.api.seed('XAUUSDm'); s.window.SOFT_TV_QUOTE = quote();
  const ev = event('Release', 600), plan = s.api.levelPlan(ev, ev.impacted_markets[0], 'SELL', NOW / 1000);
  assert.equal(plan.reference, 3900); assert.equal(plan.down, 3880); assert.equal(plan.move, 20);
  assert.ok(plan.entryLow > plan.reference); assert.ok(plan.invalidation > plan.entryHigh);
  assert.match(s.api.entryTiming(ev, NOW / 1000), /VOLATILITY RISK/);
  assert.match(s.api.entryTiming(event('Release', -60), NOW / 1000), /CONFIRMATION WAIT/);
  s.time(NOW + 16000);
  assert.equal(s.api.levelPlan(ev, ev.impacted_markets[0], 'SELL', NOW / 1000), null);
});

test('running news locks its reference; mixed evidence uses labelled low-strength TV bias', () => {
  const s = newsSandbox(); s.api.seed('XAUUSDm'); s.window.SOFT_TV_QUOTE = quote();
  const ev = event('Release', -60);
  const first = s.api.levelPlan(ev, ev.impacted_markets[0], 'SELL', NOW / 1000);
  s.window.SOFT_TV_QUOTE = quote('XAUUSDm', 3910);
  assert.equal(s.api.levelPlan(ev, ev.impacted_markets[0], 'SELL', NOW / 1000).reference, first.reference);
  assert.equal(s.api.predictionFor({predicted_move: {market: 'BTCUSDTm', side: 'SELL'}}, null), null);
  s.api.mergeNews([{...ev, impacted_markets: [], predicted_move: {market: 'XAUUSDm', side: '', move_abs: 20}}]);
  s.api.renderNews();
  assert.match(s.elements.get('running-news-list').innerHTML, /DOWN-SPIKE BUY ZONE/);
  assert.match(s.elements.get('running-news-list').innerHTML, /20% MODEL STRENGTH/);
  assert.doesNotMatch(s.elements.get('running-news-list').innerHTML, /UP-SPIKE SELL ZONE/);
});

test('actual CPI and inverse claims surprise outweigh opposing live trend', () => {
  const s=newsSandbox(); s.api.seed('XAUUSDm');
  s.window.SOFT_TV_QUOTE={...quote(),change:0.8};
  const cpi={...event('CPI',-10),actual:3.5,forecast:3,previous:2.8};
  assert.equal(s.api.directionalEstimate(cpi,NOW/1000).side,'SELL');
  const claims={...event('Jobless claims',-10),actual:250000,forecast:220000,previous:210000};
  assert.equal(s.api.directionalEstimate(claims,NOW/1000).side,'BUY');
});

test('running BUY/SELL bias is fixed through updated results and market round-trip', () => {
  const s=newsSandbox(); s.api.seed('XAUUSDm'); s.window.SOFT_TV_QUOTE=quote();
  const ev=event('CPI',-10), first=s.api.directionalEstimate(ev,NOW/1000);
  assert.equal(first.side,'SELL'); assert.equal(first.locked,true);
  const revised={...ev,actual:2.5,forecast:3,previous:3.2,impacted_markets:[{market:'XAUUSDm',side:'BUY',move_abs:25}]};
  assert.equal(s.api.directionalEstimate(revised,NOW/1000).side,'SELL');
  s.api.seed('EURUSDm'); s.api.seed('XAUUSDm');
  assert.equal(s.api.directionalEstimate(revised,NOW/1000).side,'SELL');
  assert.match(s.storage.get('softradex.news.bias.v1'),/"side":"SELL"/);
});

test('headline publication never becomes an impact countdown or a confirmed active release', () => {
  const s=newsSandbox(); s.api.seed('XAUUSDm'); s.window.SOFT_TV_QUOTE=quote();
  s.api.mergeNews([{...event('Gold rises on Fed rate cut',-7200),source:'google-news',kind:'headline'},
    {...event('New gold headline',-60),source:'google-news',kind:'headline'},
    {...event('Future headline timestamp',600),source:'google-news',kind:'headline'},event('Next release',600)]);
  assert.deepEqual(Array.from(s.api.visibleEvents(NOW/1000),e=>e.title),['Next release','New gold headline','Gold rises on Fed rate cut']);
  s.api.renderNews();
  assert.match(s.elements.get('mnt-list').innerHTML,/HEADLINES · UNSCHEDULED IMPACT/);
  assert.match(s.elements.get('mnt-list').innerHTML,/IMPACT IN/);
  const headlineRows = s.elements.get('mnt-list').innerHTML.split('<details').filter(row => row.includes('data-kind="headline"'));
  assert.equal(headlineRows.length, 2);
  for (const row of headlineRows) {
    assert.match(row, /UNSCHEDULED/);
    assert.doesNotMatch(row, /class="mnt-timer|class="mnt-start"|PUBLISHED AGO/);
  }
  assert.match(s.elements.get('running-news-list').innerHTML,/New gold headline/);
  assert.match(s.elements.get('running-news-list').innerHTML,/IMPACT UNCONFIRMED/);
  assert.doesNotMatch(s.elements.get('running-news-list').innerHTML,/class="mnt-timer/);
  assert.doesNotMatch(s.elements.get('mnt-list').innerHTML,/Future headline timestamp/);
});

test('news filters include Gold policy spillovers and exclude unrelated USD company headlines', () => {
  const s = newsSandbox(); s.api.seed('XAUUSDm');
  assert.ok(s.api.relevanceFor({...event('MPC Member Greene Speaks',600),currency:'GBP',impacted_markets:[]}));
  assert.equal(s.api.relevanceFor({...event('Apple quarterly earnings',-60),kind:'headline'}),null);
  assert.ok(s.api.relevanceFor({...event('Treasury yields climb after PPI',-60),kind:'headline'}));
  assert.equal(s.api.relevanceFor(event('Baker Hughes Oil Rig Count',600)),null);
  s.api.seed('EURUSDm');
  assert.equal(s.api.relevanceFor({...event('Gold rallies',-60),country:'XAU',currency:'XAU',kind:'headline',impacted_markets:[]}),null);
});

test('news reload restores unexpired market cache and immediately asks for a fresh scan', () => {
  const s = newsSandbox();
  s.storage.set('softradex.news.snapshot.v1.XAUUSD',JSON.stringify({symbol:'XAUUSDm',at:NOW,events:[event('Cached release',600),event('Expired low',-1000,'low')]}));
  s.api.init();
  assert.match(s.elements.get('mnt-list').innerHTML,/Cached release/);
  assert.doesNotMatch(s.elements.get('mnt-list').innerHTML,/Expired low/);
  assert.ok(s.pending[0].url.includes('scan=1'));
  const other = newsSandbox(); other.api.seed('BTCUSDT');
  other.storage.set('softradex.news.snapshot.v1.BTCUSDT',s.storage.get('softradex.news.snapshot.v1.XAUUSD'));
  other.api.restoreNews();
  assert.equal(other.api.visibleEvents(NOW/1000).length,0);
});

test('news timeout releases the request and retries without losing cached rows', async () => {
  const s = newsSandbox(); s.api.seed('XAUUSDm'); s.api.mergeNews([event('Cached release',600)]); s.api.fetchNews(true);
  s.fireTimer(12000); await flush();
  assert.match(s.elements.get('mnt-list').innerHTML,/Cached release/);
  assert.match(s.elements.get('mnt-count').textContent,/RETRYING/);
  s.fireTimer(2000);
  assert.equal(s.pending.length,2);
  respond(s.pending[1],{ok:true,symbol:'XAUUSDm',events:[event('Fresh release',700)],sources:[]});await flush();
  assert.match(s.elements.get('mnt-list').innerHTML,/Fresh release/);
  assert.doesNotMatch(s.elements.get('mnt-count').textContent,/RETRYING/);
});

test('news market switch discards a late response and restores only the selected market', async () => {
  const s = newsSandbox(); s.api.init();
  s.window.dispatchEvent({type:'chart:market',detail:{symbol:'EURUSDm'}});
  respond(s.pending[0],{ok:true,symbol:'XAUUSDm',events:[event('Old Gold response',600)]});
  respond(s.pending[1],{ok:true,symbol:'EURUSDm',events:[{...event('EUR release',600),currency:'EUR',impacted_markets:[]}],sources:[]});
  await flush();
  assert.match(s.elements.get('mnt-list').innerHTML,/EUR release/);
  assert.doesNotMatch(s.elements.get('mnt-list').innerHTML,/Old Gold response/);
});

test('swing price comes from TV, never from a candle close, ticker, or indicator mode', async () => {
  const s = swingSandbox(); s.api.seed('XAUUSDm'); s.api.loadCandles();
  for (const req of s.pending) respond(req, {bars: bars()});
  await flush();
  assert.equal(s.window.SwingAI.state().price, 0);
  assert.equal(s.window.SwingAI.state().plan, null);
  s.api.acceptQuote(quote());
  assert.equal(s.window.SwingAI.state().price, 3900);
  assert.ok(Math.abs(s.window.SwingAI.state().reads.M5.close - 3900) < 1e-8);
  assert.equal(s.window.SwingAI.state().plan.priceSource, 'TradingView');
  assert.equal(s.window.SwingAI.state().plan.priceAt, 3900);
  const before = JSON.stringify(s.window.SwingAI.state().plan);
  s.window.SOFT_TV_VISIBLE = false;
  s.window.dispatchEvent({type: 'chart:tv-visible', detail: {visible: false}});
  assert.equal(JSON.stringify(s.window.SwingAI.state().plan), before);
  assert.equal(s.api.acceptQuote(quote('BTCUSDT', 70000)), false);
  assert.equal(s.window.SwingAI.state().price, 3900);
  s.time(NOW + 16000);
  assert.equal(s.api.acceptQuote(quote()), false);
  assert.equal(s.window.SwingAI.state().fresh, false);
});

test('waiting setup retunes from newer TV price while preserving countdown timestamps', async () => {
  const s = swingSandbox(); s.time(NOW + 1000); s.api.seed('XAUUSDm'); s.api.loadCandles();
  for (const req of s.pending) respond(req, {bars: bars()});
  await flush(); s.api.acceptQuote(quote());
  const plan = s.window.SwingAI.state().plan;
  const start = plan.startAt, end = plan.endAt;
  s.time(NOW + 2000); s.api.acceptQuote({...quote('XAUUSDm', 3902), at: NOW + 2000});
  assert.equal(s.window.SwingAI.state().plan.priceAt, 3902);
  assert.equal(s.window.SwingAI.state().plan.startAt, start);
  assert.equal(s.window.SwingAI.state().plan.endAt, end);
});

test('late old-market quote/candles cannot contaminate a newly selected swing market', async () => {
  const s = swingSandbox(); s.api.seed('XAUUSDm'); s.api.loadPrice(); s.api.loadCandles();
  const old = s.pending.slice(); s.api.setSymbol('BTCUSDT');
  for (const req of old) respond(req, req.url.includes('tvquote') ? {...quote(), updated: NOW / 1000} : {bars: bars()});
  await flush();
  assert.equal(s.window.SwingAI.state().symbol, 'BTCUSDT');
  assert.equal(s.window.SwingAI.state().price, 0);
  assert.equal(s.window.SwingAI.state().reads.M5, undefined);
  assert.ok(s.pending.every(req => !req.url.includes('/ticker')));
});

test('shared TV quote publisher rejects late old-market responses', async () => {
  const s = sandbox('web/tv-chart.js', 'pollTvQuote,seed(s,t){ourSymbol=s;tvSymbol=t;}');
  s.api.seed('XAUUSDm', 'OANDA:XAUUSD'); s.api.pollTvQuote();
  s.api.seed('BTCUSDT', 'BINANCE:BTCUSDT');
  respond(s.pending[0], {...quote(), updated: NOW / 1000}); await flush();
  assert.equal(s.window.SOFT_TV_QUOTE, undefined);
  s.api.pollTvQuote(); respond(s.pending[1], {...quote('BTCUSDT', 70000), updated: NOW / 1000}); await flush();
  assert.equal(s.window.SOFT_TV_QUOTE.price, 70000);
  assert.equal(s.window.SOFT_TV_QUOTE.symbol, 'BTCUSDT');
});

test('selected-market filter includes direct/currency/cross effects but ignores generic forecast mapping', () => {
  const s = newsSandbox(); s.api.seed('XAUUSDm');
  const usd = {...event('US rate decision', 600), impacted_markets: []};
  const foreign = {...event('Colombia GDP', 700), currency: 'COP', impacted_markets: [],
    predicted_move: {market:'XAUUSDm', move_abs:20}};
  const cross = {...event('JPY shock spills into gold', 800), currency:'JPY'};
  const crypto = {...event('Bitcoin network upgrade', 900), impacted_markets: []};
  const generic = {...event('Saudi inflation rate', 1000),currency:'SAR',
    impacted_markets:[{market:'XAUUSDm',side:'SELL',move_abs:20,reason:'Gold dips on firmer currency sentiment'}]};
  const rigs = {...event('Baker Hughes Gas Rig Count', 1100),impacted_markets:[]};
  s.api.mergeNews([usd, foreign, cross, crypto, generic, rigs]);
  assert.deepEqual(Array.from(s.api.visibleEvents(NOW/1000), e=>e.title), ['US rate decision','JPY shock spills into gold']);
  assert.equal(s.api.marketMatch('XAUGBPm','XAUUSDm'), false);
  assert.equal(s.api.marketMatch('BTCUSDm','BTCUSDT'), true);
  s.api.seed('EURUSDm');
  assert.ok(s.api.relevanceFor({...usd,currency:'EUR'}));
  assert.equal(s.api.relevanceFor({...usd,currency:'JPY'}), null);
  s.api.seed('USDCLPm');
  assert.ok(s.api.relevanceFor({...usd,currency:'CLP'}));
});

test('gold keeps major policy and macro spillovers from all providers, including Exness', () => {
  const s = newsSandbox(); s.api.seed('XAUUSDm');
  const rows = [
    {...event('PBOC Interest Rate Decision', 600),currency:'CNY',source:'exness',kind:'calendar',impacted_markets:[]},
    {...event('Euro Area Inflation Rate YoY', 700, 'medium'),currency:'EUR',source:'tradingview',kind:'calendar',impacted_markets:[]},
    {...event('China GDP', 800, 'medium'),currency:'CNY',source:'investing.com',kind:'calendar',impacted_markets:[]},
    {...event('Canadian local house prices', 900, 'low'),currency:'CAD',kind:'calendar',impacted_markets:[]}
  ];
  s.api.mergeNews(rows);
  assert.deepEqual(Array.from(s.api.visibleEvents(NOW/1000),e=>e.title), rows.slice(0,3).map(e=>e.title));
});

test('Binance events follow the selected asset and exchange spillovers stay on crypto markets', () => {
  const s = newsSandbox();
  const btc = {...event('Binance BTCUSDT launch',600),source:'binance',sources:['binance'],kind:'calendar',currency:'CRYPTO',markets:['BTCUSDT']};
  const eth = {...btc,title:'Binance Ethereum maintenance',markets:['ETHUSDT']};
  const exchange = {...btc,title:'Binance security incident',markets:[],market_scope:'exchange'};
  const gold = {...btc,title:'Binance Gold contract update',markets:['XAUUSDm']};
  s.api.seed('XAUUSDm'); s.api.mergeNews([btc,eth,exchange,gold]);
  assert.deepEqual(Array.from(s.api.visibleEvents(NOW/1000),e=>e.title),[gold.title]);
  s.api.seed('BTCUSDm'); s.api.mergeNews([btc,eth,exchange,gold]);
  assert.deepEqual(new Set(Array.from(s.api.visibleEvents(NOW/1000),e=>e.title)),new Set([btc.title,exchange.title]));
  s.api.seed('ETHUSDT'); s.api.mergeNews([btc,eth,exchange,gold]);
  assert.deepEqual(new Set(Array.from(s.api.visibleEvents(NOW/1000),e=>e.title)),new Set([eth.title,exchange.title]));
  const bnb = {...btc,title:'Binance BNB announcement',markets:['BNBUSDT']};
  s.api.seed('BNBUSDm'); s.api.mergeNews([bnb,btc,exchange]);
  assert.deepEqual(new Set(Array.from(s.api.visibleEvents(NOW/1000),e=>e.title)),new Set([bnb.title,exchange.title]));
  s.api.seed('EURUSDm'); s.api.mergeNews([btc,eth,exchange,gold]);
  assert.equal(s.api.visibleEvents(NOW/1000).length,0);
});

test('provider report distinguishes blocked calendar, usable headlines and an empty relevant window', () => {
  const s = newsSandbox(); s.api.seed('XAUUSDm');
  s.api.setSources([
    {name:'tradingview',state:'ok',parts:{calendar:{state:'ok'}}},
    {name:'investing.com',state:'partial',parts:{calendar:{state:'unavailable',error:'HTTP 403'},headline:{state:'ok'}}},
    {name:'exness',state:'ok',parts:{calendar:{state:'ok'}}}
  ]);
  const headlines = Array.from({length:4},(_,i)=>({...event('Gold research '+i,-60-i),kind:'headline',sources:['investing.com']}));
  s.api.renderSources(headlines);
  const html = s.elements.get('mnt-sources').innerHTML;
  assert.match(html,/No relevant release in this 24h window/);
  assert.match(html,/Calendar unavailable: HTTP 403/);
  assert.match(html,/0 upcoming · 0 running · 4 headlines/);
  assert.match(html,/Exness/);
  assert.match(s.elements.get('mnt-source-summary').textContent,/1 CALENDAR FEEDS UNAVAILABLE/);
});

test('public Exness parser uses real release offsets and country currency, never article timestamps', () => {
  const s = newsSandbox();
  const raw = {title:'BoE GreeneSpeech',country:'GB',currency:null,time:'2026-11-13T13:00:00+00:00',impact:'low'};
  const rows = s.api.exnessRows([raw,{...raw,time:'2026-11-13T13:00:00'},
    {...raw,isDayLongEvent:true},{title:'Article',datePublished:raw.time}]);
  assert.equal(rows.length,1);
  assert.equal(rows[0].currency,'GBP');
  assert.equal(rows[0].title,'BoE Greene Speech');
  assert.equal(rows[0].ts,Date.UTC(2026,10,13,13)/1000);
  assert.equal(rows[0].impact_window_sec,7200);
});

test('public Exness fallback paginates without credentials and combines genuine speech sources', async () => {
  const s = newsSandbox(); s.api.seed('XAUUSDm');
  s.api.setSources([{name:'exness',state:'unavailable',parts:{calendar:{state:'unavailable',error:'HTTP 403'}}}]);
  s.api.mergeNews([{...event('FOMC Member Jefferson Speaks',600),kind:'calendar',source:'forex-factory',sources:['forex-factory']}]);
  const request = s.api.fetchExnessBrowser();
  const first = Array.from({length:50},(_,i)=>({title:i ? 'US release '+i : 'Fed Jefferson Speech',country:'US',
    time:new Date(NOW+(600+i)*1000).toISOString(),impact:'medium'}));
  assert.equal(s.pending[0].options.credentials,'omit');
  assert.match(s.pending[0].url,/page=1$/);
  respond(s.pending[0],first); await flush();
  assert.match(s.pending[1].url,/page=2$/);
  respond(s.pending[1],[{title:'BoE GreeneSpeech',country:'GB',time:new Date(NOW+7200000).toISOString(),impact:'low'}]);
  await request;
  const rows = s.api.visibleEvents(NOW/1000);
  assert.equal(rows.length,51);
  const speech = rows.find(e=>/Jefferson/.test(e.title));
  assert.deepEqual(Array.from(speech.sources),['forex-factory','exness']);
  assert.equal(speech.impact,'high');
  assert.match(s.elements.get('mnt-sources').innerHTML,/Live calendar via public browser feed/);
  assert.equal(s.api.fetchExnessBrowser(),undefined); // shared five-minute refresh, across markets
  s.api.seed('EURJPYm'); s.api.mergeNews(rows);
  assert.equal(s.api.visibleEvents(NOW/1000).length,0);
});

test('failed public Exness fallback reports unavailable and keeps the server calendar rows', async () => {
  const s = newsSandbox(); s.api.seed('XAUUSDm');
  s.api.setSources([{name:'exness',state:'unavailable',parts:{calendar:{state:'unavailable',error:'HTTP 403'}}}]);
  s.api.mergeNews([event('US scheduled release',600)]);
  const request = s.api.fetchExnessBrowser();
  s.pending[0].resolve({ok:false,status:403}); await request;
  assert.equal(s.api.visibleEvents(NOW/1000).length,1);
  assert.match(s.elements.get('mnt-sources').innerHTML,/Exness browser HTTP 403/);
});

function stopSandbox() {
  const s = sandbox('web/stop-liquidity.js', 'setSymbol,acceptQuote,scan');
  // Three repeated, unswept low/high pivots; ordinary neighbours are flat.
  const frames = Array.from({length:60}, (_,i) => {
    const low = [8,24,40].includes(i) ? 95 : 98;
    const high = [14,30,46].includes(i) ? 105 : 102;
    return [NOW-(60-i)*300000,100,high,low,100,100];
  });
  const history = {symbol:'XAUUSDm',at:NOW,frames:{M5:frames,M15:frames}};
  s.window.SwingAI = {structure() { return history; }};
  s.api.setSymbol('XAUUSDm');
  return {...s,history};
}

test('estimated SL zones rank repeated structure, separate below/above and reuse existing history', () => {
  const s = stopSandbox(); s.api.acceptQuote(quote('XAUUSDm',100));
  const state = s.window.StopLiquidity.state();
  assert.equal(state.zones.length, 2);
  assert.ok(state.zones.find(z=>z.side==='buy').price < 100);
  assert.ok(state.zones.find(z=>z.side==='sell').price > 100);
  assert.equal(state.zones.find(z=>z.side==='buy').touches, 3);
  assert.match(state.source, /estimated/);
  assert.equal(s.pending.length, 0); // no additional quote/candle network poll
});

test('SL prices stay fixed as quotes and identical source scans update', () => {
  const s = stopSandbox(); s.api.acceptQuote(quote('XAUUSDm',100));
  const before = s.window.StopLiquidity.state().zones.map(z=>z.price);
  s.time(NOW+2000); s.history.at = NOW+2000;
  s.api.acceptQuote({...quote('XAUUSDm',103),at:NOW+2000});
  assert.deepEqual(Array.from(s.window.StopLiquidity.state().zones,z=>z.price),Array.from(before));
});

test('crossed BUY SL zone disappears and its old evidence cannot return after rescan/reload', () => {
  const s = stopSandbox(); s.api.acceptQuote(quote('XAUUSDm',100));
  s.time(NOW+2000); s.api.acceptQuote({...quote('XAUUSDm',93),at:NOW+2000});
  assert.equal(s.window.StopLiquidity.state().zones.filter(z=>z.side==='buy').length,0);
  assert.equal(s.window.StopLiquidity.state().removed,1);
  s.history.at = NOW+2000; s.api.scan();
  assert.equal(s.window.StopLiquidity.state().zones.filter(z=>z.side==='buy').length,0);
  s.api.setSymbol('BTCUSDT'); s.api.setSymbol('XAUUSDm');
  s.api.acceptQuote({...quote('XAUUSDm',100),at:NOW+2000});
  assert.equal(s.window.StopLiquidity.state().zones.filter(z=>z.side==='buy').length,0);
});

test('stale or foreign-market quote cannot falsely remove a stop zone', () => {
  const s = stopSandbox(); s.api.acceptQuote(quote('XAUUSDm',100));
  s.api.acceptQuote(quote('BTCUSDT',93));
  assert.equal(s.window.StopLiquidity.state().price,100);
  s.time(NOW+16000); s.api.acceptQuote(quote('XAUUSDm',93));
  assert.equal(s.window.StopLiquidity.state().zones.length,2);
  assert.equal(s.window.StopLiquidity.state().fresh,false);
  s.api.setSymbol('BTCUSDT'); s.api.acceptQuote({...quote('BTCUSDT',70000),at:NOW+16000});
  assert.equal(s.window.StopLiquidity.state().zones.length,0); // old gold history is rejected
});
