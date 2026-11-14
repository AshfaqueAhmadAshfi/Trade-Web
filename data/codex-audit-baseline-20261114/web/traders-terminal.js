/* Anonymous executions from the same verified venue feeds as the board. */
(function () {
  'use strict';
  const FLOW_WINDOW = 45000, HISTORY_WINDOW = 300000;
  let activeSymbol = '', prints = [], seen = new Set(), filter = 'all', paused = false;
  let paintTimer = null, tapeSignature = '', lastPrice = 0;
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
  const canonical = v => {
    const key = String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/M$/, '');
    return ({XAU:'XAUUSD',GOLD:'XAUUSD',XAUUSD247:'XAUUSD',BTC:'BTCUSDT',BTCUSD:'BTCUSDT',ETH:'ETHUSDT',ETHUSD:'ETHUSDT',SOL:'SOLUSD'})[key] || key;
  };
  const money = v => {
    const n = Math.abs(Number(v) || 0);
    return '$' + (n >= 1e6 ? (n/1e6).toFixed(2)+'M' : n >= 1e3 ? (n/1e3).toFixed(1)+'K' : n.toFixed(2));
  };
  function set(selector, text) { document.querySelectorAll(selector).forEach(e => { e.textContent = text; }); }
  function selectedMarket() {
    return typeof window.flowSymbol === 'function' ? window.flowSymbol() :
      window.SoftradeXTerminal?.symbol?.() || document.getElementById('flow-symbol-label')?.textContent || '';
  }
  function trim() {
    prints = prints.filter(t => t.ts >= Date.now() - HISTORY_WINDOW);
    if (prints.length > 20000) prints.length = 20000;
  }
  function totals() {
    trim();
    const live = prints.filter(t => t.ts >= Date.now() - FLOW_WINDOW);
    const buy = live.filter(t => t.side === 'BUY'), sell = live.filter(t => t.side === 'SELL');
    const buyVol = buy.reduce((n,t) => n+t.value,0), sellVol = sell.reduce((n,t) => n+t.value,0), totalVol = buyVol+sellVol;
    return {symbol:activeSymbol,buyVol,sellVol,totalVol,buyPct:totalVol?buyVol/totalVol*100:50,sellPct:totalVol?sellVol/totalVol*100:50,
      buyCount:buy.length,sellCount:sell.length,openBuyVol:0,openSellVol:0,openBuyCount:0,openSellCount:0,openCount:0,closeCount:0,closeVol:0,
      netDelta:buyVol-sellVol,speed:prints.filter(t=>t.ts>=Date.now()-3000).length/3,lastPrice};
  }
  function receive(detail) {
    if (!detail || !activeSymbol || canonical(detail.symbol)!==canonical(activeSymbol)) return;
    for (const t of Array.isArray(detail.trades)?detail.trades:[]) {
      const price=Number(t.price),qty=Number(t.qty),ts=Number(t.ts),side=String(t.side).toUpperCase();
      if (!(price>0) || !(qty>0) || !(ts>0) || ts>Date.now()+5000 || ts<Date.now()-HISTORY_WINDOW || !['BUY','SELL'].includes(side)) continue;
      const id=[detail.venue,detail.pair,t.id||[ts,side,price,qty].join('|')].join(':');
      if(seen.has(id))continue;
      seen.add(id);if(seen.size>30000)seen.delete(seen.values().next().value);
      prints.push({id,side,price,qty,ts,value:price*qty,venue:detail.venue,pair:detail.pair});
    }
    prints.sort((a,b)=>b.ts-a.ts);
    if(prints.length)lastPrice=prints[0].price;
    schedulePaint();
  }
  function schedulePaint(){if(!paintTimer)paintTimer=setTimeout(()=>{paintTimer=null;paint();},100);}
  function paint(){
    const stats=totals();
    set('.tt-buy-vol-val',stats.buyPct.toFixed(0)+'% ('+money(stats.buyVol)+')');
    set('.tt-sell-vol-val',stats.sellPct.toFixed(0)+'% ('+money(stats.sellVol)+')');
    set('.tt-close-stat-val',(stats.buyCount+stats.sellCount)+' prints ('+money(stats.totalVol)+')');
    set('.tt-speed-val',stats.speed.toFixed(1)+' tx/s');
    document.querySelectorAll('.tt-meter-buy, #tt-meter-buy').forEach(e=>{e.style.width=stats.buyPct+'%';});
    document.querySelectorAll('.tt-meter-sell, #tt-meter-sell').forEach(e=>{e.style.width=stats.sellPct+'%';});
    document.querySelectorAll('.tt-foot-net-delta').forEach(e=>{e.innerHTML='DELTA: <b class="'+(stats.netDelta>=0?'pos':'neg')+'">'+(stats.netDelta>=0?'+':'-')+money(stats.netDelta)+'</b>';});
    const sources=window.MultiExchangeOrderFlow?.getBreakdown?.()||[];
    const healthy=sources.filter(s=>s.id!=='traders'&&['LIVE','QUIET'].includes(s.status)).length;
    const pairCount=sources.filter(s=>s.id!=='traders'&&s.pair).length;
    const status=paused?'Display paused · feed continues':healthy?healthy+'/'+pairCount+' feeds responding · anonymous executed flow · rolling 45s':pairCount?'Venue feeds unavailable / connecting · retrying':'No public exchange tape for '+(activeSymbol||'this market');
    set('.tt-status-text, #tt-status-text',status);
    for(const name of ['applyOrderFlowToWatchDials','applyOrderFlowToAiMarket'])if(typeof window[name]==='function')window[name](stats);
    window.dispatchEvent(new CustomEvent('traders:stats',{detail:stats}));
    if(paused)return;
    const visible=prints.filter(t=>filter==='buy'?t.side==='BUY':filter==='sell'?t.side==='SELL':filter==='whale'?t.value>=25000:filter!=='close').slice(0,80);
    const signature=activeSymbol+'|'+filter+'|'+visible.map(t=>t.id).join('|');
    if(signature===tapeSignature)return;tapeSignature=signature;
    const html=visible.length?visible.map(t=>{
      const side=t.side==='BUY'?'buy':'sell';
      return '<div class="tt-row '+side+(t.value>=25000?' whale-trade':'')+'"><span class="tt-cell-time">'+esc(new Date(t.ts).toLocaleTimeString([],{hour12:false}))+'</span><b class="tt-cell-side '+side+'">'+t.side+'</b><span class="tt-cell-action"><span class="tt-action-badge open">EXECUTED</span></span><span class="tt-cell-price">'+t.price.toLocaleString('en-US',{maximumFractionDigits:5})+'</span><span class="tt-cell-amount">'+t.qty.toLocaleString('en-US',{maximumFractionDigits:6})+'</span><strong class="tt-cell-total">'+money(t.value)+'</strong><span class="tt-cell-trader" title="'+esc(t.pair)+'">'+esc(String(t.venue).toUpperCase())+' · '+esc(t.pair)+'</span></div>';
    }).join(''):'<div class="tt-divider-row">No recent verified executions for '+esc(activeSymbol||'this market')+'.</div>';
    document.querySelectorAll('.tt-tape-body').forEach(e=>{e.innerHTML=html;});
    set('.tt-realized-val, .tt-unrealized-val, .tt-winrate-val, .tt-open-count-val','N/A');
    document.querySelectorAll('.tt-running-body').forEach(e=>{e.textContent='Public feeds do not publish running positions or SL/TP exits.';});
  }
  function switchMarket(symbol){
    const next=String(symbol||'').trim();
    if(canonical(next)===canonical(activeSymbol)){activeSymbol=next;return;}
    activeSymbol=next;prints=[];seen.clear();lastPrice=0;tapeSignature='';
    set('#tt-connected-symbol, .tt-connected-symbol, #tt-sidebar-connected-symbol',activeSymbol.toUpperCase());paint();
  }
  function init(){
    window.addEventListener('orderflow:prints',e=>receive(e.detail));
    window.addEventListener('chart:market',e=>switchMarket(e.detail?.symbol));
    document.querySelectorAll('.traders-terminal-panel').forEach(panel=>{
      panel.querySelectorAll('.tt-filter-btn').forEach(button=>{
        if(button.dataset.filter==='open')button.textContent='EXECUTED';
        if(button.dataset.filter==='close'){button.disabled=true;button.title='Position exits are not published by public trade APIs';}
        button.addEventListener('click',()=>{filter=button.dataset.filter||'all';document.querySelectorAll('.tt-filter-btn').forEach(e=>e.classList.toggle('active',e.dataset.filter===filter));tapeSignature='';paint();});
      });
      const closedLabel=panel.querySelector('.tt-close-stat .tt-stat-lbl');if(closedLabel)closedLabel.textContent='EXECUTED · 45s';
      const routeLabel=panel.querySelector('.tt-columns-head .tt-col-trader');if(routeLabel)routeLabel.textContent='VENUE / PAIR';
      panel.querySelector('[id$="pause-btn"], .tt-pause-btn')?.addEventListener('click',e=>{paused=!paused;e.currentTarget.textContent=paused?'▶':'⏸';tapeSignature='';paint();});
      panel.querySelector('[id$="clear-btn"], .tt-clear-btn')?.addEventListener('click',()=>{prints=[];tapeSignature='';paint();});
    });
    switchMarket(selectedMarket());
    setInterval(()=>{const symbol=selectedMarket();if(symbol&&canonical(symbol)!==canonical(activeSymbol))switchMarket(symbol);paint();},1000);
  }
  window.TradersTerminal={switchMarket,getActiveSymbol:()=>activeSymbol,onSnapshot:()=>{},onTradeClosed:()=>{},
    onPriceTick:(symbol,price)=>{if(canonical(symbol)===canonical(activeSymbol)&&Number(price)>0)lastPrice=Number(price);},
    addTrade:t=>{if(t?.verified)receive({symbol:t.symbol,venue:t.venue,pair:t.pair,trades:[t]});},
    getOpenVolume:()=>({openBuyVol:0,openSellVol:0,openBuyCount:0,openSellCount:0}),getRunningPositions:()=>[],
    getAnalysisStats:()=>({realizedPnl:null,unrealizedPnl:null,winCount:0,lossCount:0,openCount:0,turnover:totals().totalVol,lastPrice}),
    getCandleFlow:(time,interval)=>{const start=Number(time)<1e11?Number(time)*1000:Number(time),end=start+(Number(interval)||300)*1000;return prints.filter(t=>t.ts>=start&&t.ts<end).reduce((out,t)=>{out[t.side==='BUY'?'buy':'sell']+=t.value;return out;},{buy:0,sell:0});}
  };
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
