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

function privateState(auth = {}) {
  const source = fs.readFileSync('web/app.js','utf8'), requests = [], painted = [], timers = new Map();
  let next = 0;
  const foot = {textContent:'',style:{}}, settings = {...auth};
  const context = vm.createContext({CFG:settings,window:{SOFTRADEX_PUBLIC_ONLY:true,dispatchEvent(){}}, CustomEvent:class{},
    document:{hidden:false},Date,AbortController,$:()=>foot,
    setTimeout(fn,ms){const id=++next;timers.set(id,{fn,ms});return id;},clearTimeout(id){timers.delete(id);},
    fetch(){return new Promise(resolve=>requests.push(resolve));},
    queueStateFrame:data=>{if(!context.document.hidden)painted.push(data);},
    applyState:data=>{painted.push(data);vm.runInContext('S=true',context);}});
  vm.runInContext("let S=null,httpPollTimer=null,httpPollGeneration=0,wakeHttpPoll=null,newsHaveSig='',lastServerMsgAt=0," +
    "dashboardPreviewUnlocked=false,wsReconnectTimer=null,ws=null,wsAlive=false;" +
    source.slice(source.indexOf('function setPrivateStateReady'),source.indexOf('async function loadMore')) +
    source.slice(source.indexOf('function startHttpPoll'),source.indexOf('/* The engine pushes')) +
    source.slice(source.indexOf('async function loadInitial'),source.indexOf('/* Order execution is unavailable')),context);
  return {context,settings,requests,painted,timers,foot};
}
const settle = async()=>{for(let i=0;i<12;i++)await Promise.resolve();};

test('a hidden page loads its first state then pauses background polling',async()=>{
  const s=privateState();s.context.document.hidden=true;s.context.startHttpPoll();
  assert.equal(s.requests.length,1);
  s.requests[0]({ok:true,status:200,json:async()=>({version:1})});await settle();
  assert.equal(s.painted.length,1);
  vm.runInContext('S={version:1}',s.context);
  [...s.timers.values()].find(t=>t.ms===2500).fn();await settle();
  assert.equal(s.requests.length,1);
});

test('signed-out private state never starts polling or requests an initial snapshot',async()=>{
  const s=privateState({auth_required:true,authed:false});
  s.context.connectWS();s.context.startHttpPoll();await s.context.loadInitial();
  assert.equal(s.requests.length,0);assert.equal(s.timers.size,0);
  assert.match(s.foot.textContent,/sign in required/);
});

test('signed-out startup and an expired session expose the dashboard password dialog',async()=>{
  const s=privateState({auth_required:true,authed:false});let prompts=0;
  s.context.window.requestDashboardLogin=()=>{prompts++;};
  s.context.connectWS();
  assert.equal(prompts,1);assert.equal(s.requests.length,0);
  s.settings.authed=true;s.context.startHttpPoll();
  s.requests[0]({ok:false,status:401});await settle();
  assert.equal(prompts,2);assert.equal(s.settings.authed,false);
});

for(const status of [401,403])test(`private state ${status} stops retries and never paints the error response`,async()=>{
  const s=privateState({auth_required:true,authed:true});
  s.context.startHttpPoll();
  s.requests[0]({ok:false,status,json:async()=>({ok:false,error:'login required'})});await settle();
  assert.equal(s.settings.authed,false);assert.equal(s.timers.size,0);assert.equal(s.painted.length,0);
  assert.match(s.foot.textContent,/sign in required/);
  s.context.connectWS();await s.context.loadInitial();assert.equal(s.requests.length,1);
});

test('a superseded unauthorized response cannot revoke the newly resumed state poll',async()=>{
  const s=privateState({auth_required:true,authed:true});
  s.context.startHttpPoll();s.context.stopHttpPoll();s.context.startHttpPoll();
  s.requests[0]({ok:false,status:401});await settle();
  assert.equal(s.settings.authed,true);
  s.requests[1]({ok:true,status:200,json:async()=>({version:2})});await settle();
  assert.equal(s.painted[0].version,2);
});

test('an initial snapshot failure cannot paint an API error as dashboard state',async()=>{
  const s=privateState();const initial=s.context.loadInitial();
  s.requests[0]({ok:false,status:500,json:async()=>({error:'unavailable'})});await initial;
  assert.equal(s.painted.length,0);
});

function passwordLogin(result) {
  const source=fs.readFileSync('web/app.js','utf8');let submit;
  const settings={auth_required:true,authed:false},error={textContent:''},closed=[],actions=[];
  const input={value:'test-password',select(){},focus(){}};
  const form={addEventListener(name,fn){submit=fn;}};
  vm.runInNewContext(source.slice(source.indexOf("  const passwordForm = $('dashboard-password-form');"),
    source.indexOf("  const passwordCancel = $('dashboard-password-cancel');")),{
    CFG:settings,httpPollTimer:null,$:id=>({'dashboard-password-form':form,'dashboard-password-input':input,'dashboard-password-error':error}[id]),
    fetch:async()=>({ok:true,json:async()=>result}),closeDashboardPassword:value=>closed.push(value),
    stopHttpPoll:()=>actions.push('stop'),setPrivateStateReady:ready=>actions.push('ready:'+ready),
    connectWS:()=>actions.push('connect'),loadInitial:()=>actions.push('initial')});
  return {settings,error,closed,actions,submit:()=>submit({preventDefault(){}})};
}

test('HTTP 200 with a rejected password keeps the dialog locked and shows the API error',async()=>{
  const s=passwordLogin({ok:false,error:'incorrect password'});await s.submit();
  assert.equal(s.settings.authed,false);assert.deepEqual(s.closed,[]);assert.deepEqual(s.actions,[]);
  assert.equal(s.error.textContent,'incorrect password');
});

test('a verified login restarts private state and closes the password dialog',async()=>{
  const s=passwordLogin({ok:true,authed:true});await s.submit();
  assert.equal(s.settings.authed,true);assert.deepEqual(s.actions,['stop','ready:true','connect','initial']);assert.deepEqual(s.closed,[true]);
});
