/* The combined venue table shows public executions, never account identities. */
(function () {
  'use strict';
  const ORDER=['binance','coinbase','kraken','okx','bitget','gate','bybit','kucoin','bitfinex','mexc','gemini','deribit','htx'];
  const NAMES={binance:'BINANCE',coinbase:'COINBASE',kraken:'KRAKEN',okx:'OKX',bitget:'BITGET',gate:'GATE.IO',bybit:'BYBIT',kucoin:'KUCOIN',bitfinex:'BITFINEX',mexc:'MEXC',gemini:'GEMINI',deribit:'DERIBIT',htx:'HTX'};
  const $=id=>document.getElementById(id);
  const esc=v=>String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
  const money=v=>{const n=Number(v)||0;return '$'+(n>=1e6?(n/1e6).toFixed(2)+'M':n>=1e3?(n/1e3).toFixed(1)+'K':n.toFixed(2));};
  let refs=null;
  function build(){
    const box=$('vft-rows');if(!box)return;
    box.innerHTML=ORDER.map(id=>'<div class="vft-row" data-vft="'+id+'"><span class="vft-company">'+NAMES[id]+'</span><span class="vft-pos">CONNECTING</span><span class="vft-amount">$0.00</span><span class="vft-buy">$0.00</span><span class="vft-sell">$0.00</span><span class="vft-pair">Connecting</span><span class="vft-status">CONNECTING</span></div>').join('');
    refs={};for(const id of ORDER){const row=box.querySelector('[data-vft="'+id+'"]');refs[id]={row,fields:[...row.children]};}
  }
  function paint(detail){
    if(!refs)build();if(!refs)return;
    const entries=new Map((detail?.breakdown||[]).map(e=>[e.id,e]));
    let buyTotal=0,sellTotal=0,healthy=0;
    for(const id of ORDER){
      const e=entries.get(id)||{status:'CONNECTING'},fields=refs[id].fields;
      const status=e.status||(!e.pair?'NO PAIR':'CONNECTING');
      const buy=Math.max(0,Number(e.buy)||0),sell=Math.max(0,Number(e.sell)||0),available=!!e.pair;
      if(available){buyTotal+=buy;sellTotal+=sell;}
      if(['LIVE','QUIET'].includes(status))healthy++;
      const side=!available?'N/A':buy+sell===0?'QUIET':buy===sell?'BALANCED':buy>sell?'BUY':'SELL';
      const values=[NAMES[id],side,available?money(Math.max(buy,sell)):'N/A',available?money(buy):'N/A',available?money(sell):'N/A',e.pair||'No market pair',status];
      fields.forEach((field,index)=>{if(field.textContent!==values[index])field.textContent=values[index];});
      fields[1].classList.toggle('buy',side==='BUY');fields[1].classList.toggle('sell',side==='SELL');
      refs[id].row.dataset.status=status;
      fields[6].title=status==='QUIET'?'Feed is responding; no executions in the last 45 seconds':status==='NO PAIR'?'This venue has no supported tape for the selected market':status==='UNAVAILABLE'?'Public API is unavailable; retrying':status;
    }
    if($('vft-buy'))$('vft-buy').textContent=money(buyTotal);
    if($('vft-sell'))$('vft-sell').textContent=money(sellTotal);
    if($('vft-updated'))$('vft-updated').textContent=(detail?.symbol||'Selected market')+' · '+healthy+'/13 responding · 45s';
  }
  function refresh(){paint({symbol:window.TradersTerminal?.getActiveSymbol?.(),breakdown:window.MultiExchangeOrderFlow?.getBreakdown?.()||[]});}
  function init(){build();refresh();window.addEventListener('orderflow:update',e=>paint(e.detail));}
  window.VenuesFlowTerminal={refresh};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
