// Isolated audit reproductions. Loads project scripts in a fake browser;
// never calls a real API, places a trade, or changes the running dashboard.
const fs = require('node:fs');
const vm = require('node:vm');

function sandbox(file, exports) {
  const pending = [];
  const elements = new Map();
  const values = new Map();
  const window = { addEventListener() {}, dispatchEvent() {} };
  const document = {
    readyState: 'loading', hidden: false, addEventListener() {},
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, {
        textContent: '', innerHTML: '', className: '', style: {},
        classList: { toggle() {}, add() {}, remove() {} },
        querySelector() { return null; }
      });
      return elements.get(id);
    }
  };
  const context = vm.createContext({
    window, document, Date, console,
    localStorage: { getItem(k) { return values.get(k) || null; }, setItem(k,v) { values.set(k,v); } },
    fetch(url) { return new Promise(resolve => pending.push({url, resolve})); },
    setTimeout() {}, clearTimeout() {}, setInterval() {}, clearInterval() {},
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } }
  });
  let code = fs.readFileSync(file, 'utf8');
  const end = code.lastIndexOf('})();');
  if (end < 0) throw new Error('Missing module closure: ' + file);
  code = code.slice(0, end) + '\nwindow.__audit = {' + exports + '};\n' + code.slice(end);
  vm.runInContext(code, context, {filename: file});
  return { api: window.__audit, window, elements, pending };
}
const flush = async () => { for (let i=0;i<12;i++) await Promise.resolve(); };
const reply = (request, data) => request.resolve({ok: true, json: async () => data});
const bars = Array.from({length:60}, (_,i) => [Date.UTC(2026,10,13)-(59-i)*86400000,3890,3900,3800,3890,100]);

(async () => {
  const findings = [];
  const tv = sandbox('web/tv-chart.js', 'pollTvQuote, seed(s){ourSymbol=s;tvSymbol=s;}');
  tv.api.seed('XAUUSDm'); tv.api.pollTvQuote();
  tv.api.seed('BTCUSDT');
  reply(tv.pending[0], {ok:true,symbol:'XAUUSDm',tv_symbol:'OANDA:XAUUSD',price:3900});
  await flush();
  findings.push({issue:'TradingView quote race', requested:tv.pending[0].url, stored:tv.window.SOFT_TV_QUOTE});

  const levels = sandbox('web/tv-setups.js', 'loadLevels, setSymbol, seed(s){symbol=s;}');
  levels.api.seed('XAUUSDm'); levels.api.loadLevels(); levels.api.setSymbol('BTCUSDT');
  reply(levels.pending[0], {symbol:'XAUUSDm',bars}); await flush();
  findings.push({issue:'Setup levels race', state:levels.window.TvSetups.state()});

  const swing = sandbox('web/swing-ai.js',
    'loadCandles, setSymbol, paint, planPriceCrossed, seed(s,p,v){symbol=s;plan=p;price=v;vote={side:"BUY",confidence:80,score:4};}');
  swing.api.seed('XAUUSDm',null,3890); swing.api.loadCandles(); swing.api.setSymbol('BTCUSDT');
  for (const request of swing.pending.filter(x=>x.url.includes('/candles'))) reply(request,{symbol:'XAUUSDm',bars});
  await flush();
  const state = swing.window.SwingAI.state();
  findings.push({issue:'Swing candle race', symbol:state.symbol, price:state.price, m5Close:state.reads.M5?.close});

  const makePlan = () => ({side:'BUY',entry:100,perfect:100,target:110,stop:90,rr:1,atr:2,etaMin:1,
    created:1000,startAt:1500,endAt:10000,running:false,hit:false,hitAt:0,doneAt:0,touches:1,labels:[]});
  swing.api.seed('TEST',makePlan(),95); swing.api.paint(2000);
  findings.push({issue:'Unconfirmed entry shown as running',entry:100,price:95,
    running:swing.window.SwingAI.state().plan.running,phase:swing.elements.get('sai-phase').textContent});
  swing.api.seed('TEST',makePlan(),111); swing.api.paint(1200);
  findings.push({issue:'Unarmed target counted as success',now:1200,startAt:1500,
    hit:swing.window.SwingAI.state().plan.hit,phase:swing.elements.get('sai-phase').textContent});
  swing.api.seed('TEST',makePlan(),95); swing.api.paint(20000);
  findings.push({issue:'Expired plan still running',now:20000,endAt:10000,
    phase:swing.elements.get('sai-phase').textContent,clock:swing.elements.get('sai-clock').textContent});
  fs.writeFileSync('reports/audit-diagnostic-results.json',JSON.stringify(findings,null,2));
  for (const f of findings) {
    if (f.issue==='Setup levels race') console.log(JSON.stringify({issue:f.issue,symbol:f.state.symbol,price:f.state.price,firstLevel:f.state.levels[0]}));
    else console.log(JSON.stringify(f));
  }
})();
