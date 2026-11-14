const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {test} = require('node:test');
const panels = require('../web/dashboard-panels.js');

test('next event excludes headlines, expired releases and other markets, then sorts', () => {
  const relevant = (e, s) => e.market === s;
  const row = (ts, market='GOLD') => ({ts,market,impact:'high'});
  const late=row(1300), next=row(1200);
  assert.equal(panels.selectEvent([row(100,'BTC'),late,{...row(1000),kind:'headline'},row(1),next], 'GOLD','high',1100,relevant),next);
});

function eventRules() {
  const window={};
  const context={window,document:{readyState:'loading',addEventListener(){}},setInterval(){},Date};
  vm.createContext(context);
  for(const file of ['news-direction.js','chart-workspace.js']) {
    vm.runInContext(fs.readFileSync(require.resolve('../web/'+file),'utf8'),context);
  }
  return window;
}

test('next event impacts derive relevant pair directions even when the backend mapping is empty', () => {
  const rules=eventRules(),now=Date.now()/1000;
  const event={title:'MPC Member Greene Speaks',currency:'GBP',impact:'low',ts:now+3600,impacted_markets:[]};
  const headline={kind:'headline',title:'BoE signals rate hike',currency:'GBP',ts:now-60};
  const rows=panels.eventImpacts(event,['XAUUSDm','GBPUSDm','EURGBPm','EURUSDm','BTCUSDTm'],
    'XAUUSDm',now,rules.ChartWorkspace.relevanceFor,
    (event,symbol,context)=>rules.NewsDirection.estimate({event,symbol,now,...context}),null,[headline]);
  assert.deepEqual(rows.map(r=>r.market),['XAUUSDm','GBPUSDm','EURGBPm']);
  assert.equal(rows.find(r=>r.market==='GBPUSDm').side,'BUY');
  assert.equal(rows.find(r=>r.market==='EURGBPm').side,'SELL');
  assert.equal(rows.find(r=>r.market==='XAUUSDm').side,'');
});

test('next event impacts keep missing evidence explicit and reject another market quote or estimate', () => {
  const rules=eventRules(),now=Date.now()/1000;
  const event={title:'MPC Member Greene Speaks',currency:'GBP',impact:'low',ts:now+3600,impacted_markets:[]};
  const rows=panels.eventImpacts(event,['GBPUSDm'],'GBPUSDm',now,rules.ChartWorkspace.relevanceFor,
    (event,symbol,context)=>{
      assert.equal(context.quote,null);assert.equal(context.market,null);
      return rules.NewsDirection.estimate({event,symbol,now,...context});
    },()=>({quote:{symbol:'XAUUSDm',price:4000,change:1,at:now*1000},
      market:{symbol:'XAUUSDm',fresh:true,vote:{score:9},reads:{}}}),[]);
  assert.equal(rows.length,1);assert.equal(rows[0].side,'');assert.equal(rows[0].move_abs,0);
  assert.match(rows[0].reason,/directional evidence/i);
  const wrong=panels.eventImpacts(event,['GBPUSDm'],'GBPUSDm',now,()=>true,
    ()=>({market:'XAUUSDm',side:'SELL',move_abs:25}));
  assert.equal(wrong[0].side,'');assert.equal(wrong[0].move_abs,0);
  assert.deepEqual(panels.eventImpacts(null,['GBPUSDm'],'GBPUSDm',now,()=>true,()=>null),[]);
});

test('tomorrow uses local calendar midnights including DST', () => {
  const previous=process.env.TZ;
  process.env.TZ='Asia/Dhaka';
  let w=panels.tomorrowWindow(Date.parse('2026-11-14T20:00:00Z')/1000);
  assert.equal(new Date(w.start*1000).toISOString(),'2026-11-15T18:00:00.000Z');
  process.env.TZ='America/New_York';
  w=panels.tomorrowWindow(Date.parse('2026-10-31T16:00:00Z')/1000);
  assert.equal(w.end-w.start,25*3600);
  if(previous===undefined)delete process.env.TZ;else process.env.TZ=previous;
});

test('outlook deduplicates sources and excludes the following day', () => {
  const now=Date.now()/1000,w=panels.tomorrowWindow(now),event={title:'CPI',currency:'USD',impact:'high',ts:w.start+60};
  const result=panels.outlook([event,{...event,source:'another'},{...event,ts:w.end}], 'XAUUSDm',now,()=>true,()=>({side:'BUY'}),null,null);
  assert.equal(result.buy,1);assert.equal(result.verdict,'BUY');assert.equal(result.forecast_dollar,null);
});

test('outlook price range requires measured daily ATR and a fresh matching quote', () => {
  const now=Date.now()/1000,market={symbol:'XAUUSDm',fresh:true,vote:{score:-5},reads:{D1:{ready:true,atr:25}}};
  const read=q=>panels.outlook([], 'XAUUSDm',now,()=>true,()=>null,market,q);
  assert.equal(read({symbol:'XAUUSDm',price:4000,at:now*1000}).forecast_dollar,-25);
  assert.equal(read({symbol:'BTCUSDm',price:4000,at:now*1000}).forecast_dollar,null);
  assert.equal(read({symbol:'XAUUSDm',price:4000,at:now*1000-30000}).forecast_dollar,null);
});

test('all-market outlook covers the whole catalogue and keeps selected aliases first', () => {
  const symbols = ['XAUUSDm', 'BTCUSDTm', 'EURUSDm', 'JPMm', ...Array.from({length:98}, (_,i)=>'TEST'+i+'m')];
  const rows = panels.outlookAll([], [...symbols, 'BTCUSDm'], 'BTCUSDm', Date.now()/1000, () => true, () => null);
  assert.equal(rows.length, 102);
  assert.equal(rows[0].market, 'BTCUSDm');
  assert.deepEqual(rows.slice(1,4).map(r=>r.market), ['XAUUSDm','EURUSDm','JPMm']);
  assert.equal(new Set(rows.map(r=>panels.canonical(r.market))).size, 102);
  assert.equal(rows.at(-1).market, 'TEST97m');
  assert.equal(panels.canonical('JPM'), panels.canonical('JPMm'));
  assert.ok(rows.every(r=>r.verdict==='DATA UNAVAILABLE' && r.forecast_dollar===null));
});

test('all-market outlook isolates event estimates, headlines, candles and quotes per row', () => {
  const now=Date.now()/1000, w=panels.tomorrowWindow(now), seen=[];
  const markets=['XAUUSDm','EURUSDm','USDJPYm','BTCUSDTm'];
  const event=(market,side)=>({market,side,title:'CPI',currency:'USD',impact:'high',ts:w.start+60});
  const events=[event('XAUUSDm','SELL'), event('EURUSDm','BUY'),
    {market:'EURUSDm',title:'Euro rises',kind:'headline',ts:now-60}];
  const market={symbol:'XAUUSDm',fresh:true,vote:{score:-5},reads:{D1:{ready:true,atr:25}}};
  const quote={symbol:'XAUUSDm',price:4000,at:now*1000};
  const rows=panels.outlookAll(events,markets,'XAUUSDm',now,(e,s)=>e.market===s,
    (e,s,c)=>{seen.push({symbol:s,...c});return {side:e.side};},()=>({market,quote}));
  assert.deepEqual(rows.map(r=>r.verdict), ['SELL','BUY','DATA UNAVAILABLE','DATA UNAVAILABLE']);
  assert.deepEqual(rows.map(r=>r.forecast_dollar), [-25,null,null,null]);
  assert.equal(seen[0].quote,quote);
  assert.equal(seen[1].market,null);
  assert.equal(seen[1].quote,null);
  assert.deepEqual(seen[1].headlines,[events[2]]);
  assert.deepEqual(seen[0].headlines,[]);
});

test('daily market reads limit concurrency, isolate responses and retry failed feeds', async () => {
  const {create}=require('../web/market-outlook-data.js');
  let now=Date.now();
  const requests=[], analyses=[];
  const scanner=create({now:()=>now,
    request:symbol=>new Promise(resolve=>requests.push({symbol,resolve})),
    analyze:(bars,price)=>{analyses.push({bars,price});return {ready:bars.length>=40,score:price>50?2:-2,atr:1};}});
  const symbols=['XAUUSDm','EURUSDm','BTCUSDTm'];
  const bars=price=>Array.from({length:46},(_,i)=>[now-(45-i)*86400000,price,price+1,price-1,price,100]);
  scanner.ensure(symbols,'EURUSDm');scanner.ensure(symbols,'EURUSDm');
  assert.deepEqual(requests.map(r=>r.symbol),['EURUSDm','XAUUSDm']);
  assert.equal(scanner.status().pending,3);
  requests[0].resolve({symbol:'EURUSDm',bars:bars(1),meta:{source:'Yahoo'}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(requests[2].symbol,'BTCUSDTm');
  assert.equal(analyses[0].bars.length,45); // drop the forming daily candle
  requests[1].resolve({symbol:'XAUUSDm',bars:bars(4000)});
  requests[2].resolve({symbol:'XAUUSDm',bars:bars(4000)}); // wrong market must not be stored
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(scanner.get('EURUSDm').vote.score,-6);
  assert.equal(scanner.get('XAUUSDm').vote.score,6);
  assert.equal(scanner.get('BTCUSDTm'),null);
  scanner.ensure(symbols,'EURUSDm');assert.equal(requests.length,3);
  now+=120001;
  scanner.ensure(symbols,'EURUSDm');assert.equal(requests.length,4);
  assert.equal(requests[3].symbol,'BTCUSDTm');
  requests[3].resolve({symbol:'BTCUSDTm',bars:bars(90000)});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(scanner.status().ready,3);
  now+=600001;
  assert.equal(scanner.get('EURUSDm'),null);
});

test('daily analysis cache survives reload without refetching and expires on time', async () => {
  const {create}=require('../web/market-outlook-data.js');
  let now=Date.now(),calls=0;
  const saved=new Map(),storage={getItem:k=>saved.get(k)||null,setItem:(k,v)=>saved.set(k,v)};
  const bars=Array.from({length:45},(_,i)=>[now-(45-i)*86400000,1,2,.5,1,100]);
  const options={now:()=>now,storage,request:async symbol=>{calls++;return {symbol,bars};},
    analyze:()=>({ready:true,score:2,atr:.01})};
  const first=create(options);first.ensure(['GBPUSDm'],'GBPUSDm');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls,1);
  const reloaded=create(options);reloaded.ensure(['GBPUSDm'],'GBPUSDm');
  assert.equal(reloaded.get('GBPUSDm').vote.score,6);
  assert.equal(reloaded.status().ready,1);assert.equal(calls,1);
  now+=600001;
  const expired=create(options);assert.equal(expired.get('GBPUSDm'),null);
  expired.ensure(['GBPUSDm'],'GBPUSDm');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls,2);
});

test('event markets move ahead of unrelated queued daily reads without duplicate requests', async () => {
  const {create}=require('../web/market-outlook-data.js');
  const now=Date.now(),requests=[];
  const bars=Array.from({length:45},(_,i)=>[now-(45-i)*86400000,1,2,.5,1,100]);
  const scanner=create({now:()=>now,request:symbol=>new Promise(resolve=>requests.push({symbol,resolve})),
    analyze:()=>({ready:true,score:2,atr:1})});
  const symbols=['XAUUSDm','BTCUSDTm','ETHUSDm','EURUSDm','GBPUSDm'];
  scanner.ensure(symbols,'XAUUSDm');
  scanner.prioritize(['GBPUSDm']);scanner.ensure(symbols,'XAUUSDm');
  assert.equal(requests.length,2);
  requests[0].resolve({symbol:requests[0].symbol,bars});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(requests[2].symbol,'GBPUSDm');
  for(let i=1;i<requests.length;i++) {
    requests[i].resolve({symbol:requests[i].symbol,bars});
    await new Promise(resolve=>setImmediate(resolve));
  }
  assert.equal(new Set(requests.map(r=>r.symbol)).size,5);
  assert.equal(scanner.status().ready,5);
});

test('all-market outlook skips irrelevant history before per-market relevance work', () => {
  const now=Date.now()/1000, w=panels.tomorrowWindow(now);
  const events=Array.from({length:500},(_,i)=>({title:'Old headline '+i,kind:'headline',ts:now-i}));
  events.push({title:'Following day event',ts:w.end});
  let relevanceCalls=0;
  const rows=panels.outlookAll(events,Array.from({length:102},(_,i)=>'MARKET'+i+'m'),null,now,
    ()=>{relevanceCalls++;return true;},()=>null);
  assert.equal(rows.length,102);
  assert.equal(relevanceCalls,0);
});

test('session countdown advances between server snapshots and crosses open', () => {
  let now=1000000,text='',live=false;
  const el={dataset:{key:'london'},querySelector:s=>s==='.sess-count'?{set textContent(v){text=v;}}:{style:{}},classList:{toggle:(s,v)=>{if(s==='live')live=v;}}};
  const context={Date:{now:()=>now},document:{querySelectorAll:()=>[el]},sessionsBoard:{sessions:[{key:'london',state:'closed',open_ts:1010,close_ts:1100}]},sessionsClockAnchor:{server:1000,received:now},sessWhen:(r,s)=>r.state+':'+s};
  vm.createContext(context);
  const source=fs.readFileSync(require.resolve('../web/app.js'),'utf8');
  vm.runInContext(source.slice(source.indexOf('function tickSessionsClock()'),source.indexOf('async function sessPost(')),context);
  context.tickSessionsClock();assert.equal(text,'closed:10');
  now+=2000;context.tickSessionsClock();assert.equal(text,'closed:8');
  now+=8000;context.tickSessionsClock();assert.equal(live,true);assert.equal(text,'open:90');
});

test('public trader tape ignores duplicate, wrong-market and account positions', () => {
  const listeners={};const window={flowSymbol:()=> 'XAUUSDm',addEventListener:(n,f)=>{listeners[n]=f;},dispatchEvent:()=>{}};
  const context={window,document:{readyState:'complete',querySelectorAll:()=>[]},CustomEvent:class {},setTimeout:()=>1,setInterval:()=>1,console,Date};
  vm.createContext(context);vm.runInContext(fs.readFileSync(require.resolve('../web/traders-terminal.js'),'utf8'),context);
  const t={id:1,side:'BUY',price:4000,qty:.5,ts:Date.now()};
  const emit=s=>listeners['orderflow:prints']({detail:{symbol:s,venue:'binance',pair:'PAXGUSDT',trades:[t]}});
  emit('XAUUSDm');emit('XAUUSDm');emit('BTCUSDm');
  assert.equal(window.TradersTerminal.getAnalysisStats().turnover,2000);
  window.TradersTerminal.onSnapshot({positions:[{symbol:'XAUUSDm',volume:100}]});
  assert.equal(window.TradersTerminal.getOpenVolume().openBuyVol,0);
  window.TradersTerminal.switchMarket('BTCUSDm');assert.equal(window.TradersTerminal.getAnalysisStats().turnover,0);
});

test('late REST responses cannot contaminate a newly selected market', async () => {
  const listeners={}, requests=[];
  const window={addEventListener:(name,fn)=>{listeners[name]=fn;},dispatchEvent:()=>{}};
  class Socket { constructor(){this.readyState=0;} close(){this.readyState=3;} send(){} }
  const context={window,document:{readyState:'complete',getElementById:id=>id==='tt-sidebar-connected-symbol'?{textContent:'XAUUSDm'}:null},
    WebSocket:Socket,CustomEvent:class {},Date,AbortSignal,setTimeout:()=>1,setInterval:()=>1,
    fetch:url=>new Promise(resolve=>requests.push({url,resolve}))};
  vm.createContext(context);vm.runInContext(fs.readFileSync(require.resolve('../web/multi-exchange-order-flow.js'),'utf8'),context);
  const old=requests.find(r=>r.url.includes('venue=okx'));
  listeners['chart:market']({detail:{symbol:'BTCUSDm'}});
  const current=requests.filter(r=>r.url.includes('venue=okx')).at(-1);
  old.resolve({ok:true,json:async()=>({pair:'PAXG-USDT',trades:[{id:'old',side:'BUY',price:4000,qty:99,ts:Date.now()}]})});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(window.MultiExchangeOrderFlow.getBreakdown().find(r=>r.id==='okx').buy,0);
  current.resolve({ok:true,json:async()=>({pair:'BTC-USDT',trades:[{id:'new',side:'BUY',price:100,qty:2,ts:Date.now()}]})});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(window.MultiExchangeOrderFlow.getBreakdown().find(r=>r.id==='okx').buy,200);
});
