const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

test('public chart terminal starts REST polling without any local WebSocket attempt',()=>{
  const source=fs.readFileSync('web/softradex-terminal.js','utf8');let polls=0;
  const context=vm.createContext({window:{SOFTRADEX_PUBLIC_ONLY:true},startPolling(){polls++;},
    WebSocket:class{constructor(){assert.fail('Passenger cannot upgrade local WebSockets');}}});
  vm.runInContext(source.slice(source.indexOf('  function connectFeed()'),source.indexOf('  function handleFeedFrame')),context);
  context.connectFeed();assert.equal(polls,1);
});

test('large public executions follow the selected market, deduplicate and skip invalid or unrelated fills',()=>{
  const nodes=new Map(),rows=[],listeners={};
  const tape={children:[],innerHTML:'',firstChild:null,insertBefore(row){rows.unshift(row);this.children.unshift(row);},removeChild(){this.children.pop();}};
  const document={readyState:'loading',hidden:false,addEventListener(){},getElementById(id){
    if(id==='wf-tape')return tape;
    if(!nodes.has(id))nodes.set(id,{textContent:'',style:{},classList:{add(){},remove(){}},addEventListener(){}});
    return nodes.get(id);
  },createElement(){return {dataset:{},innerHTML:''};}};
  const window={SOFTRADEX_PUBLIC_ONLY:true,addEventListener(n,f){listeners[n]=f;}};
  const context=vm.createContext({document,window,Date,Set,isFinite,setInterval(){},setTimeout(){}});
  vm.runInContext(fs.readFileSync('web/dashboard-panels.js','utf8'),context);
  let source=fs.readFileSync('web/whale-flow.js','utf8'),end=source.lastIndexOf('})();');
  source=source.slice(0,end)+'window.check={followPublic,acceptPublic};'+source.slice(end);
  vm.runInContext(source,context);
  window.check.followPublic('BTCUSDTm');
  const trade={id:'one',price:60000,qty:1,ts:Date.now(),side:'BUY'};
  const feed={symbol:'BTCUSDm',venue:'binance',pair:'BTCUSDT',trades:[trade]};
  window.check.acceptPublic(feed);window.check.acceptPublic(feed);
  assert.equal(rows.length,1);assert.equal(nodes.get('wf-buy').textContent,'1');
  assert.match(rows[0].innerHTML,/60,000/);assert.match(rows[0].innerHTML,/BINANCE · BTCUSDT/);
  assert.match(rows[0].innerHTML,/Not published/);
  window.check.acceptPublic({...feed,symbol:'ETHUSDm',trades:[{...trade,id:'foreign'}]});
  window.check.acceptPublic({...feed,trades:[{...trade,id:'small',qty:0.1},{...trade,id:'stale',ts:Date.now()-400000},{...trade,id:'bad',price:Infinity}]});
  assert.equal(rows.length,1);
  window.check.followPublic('ETHUSDm');assert.equal(nodes.get('wf-buy').textContent,'0');
});
