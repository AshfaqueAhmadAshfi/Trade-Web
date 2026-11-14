const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const panels = require('../web/dashboard-panels.js');

function calendar(file) {
  const listeners = new Map(), requests = [];
  const window = {DashboardPanels: panels,
    addEventListener(name, fn) {
      const group = listeners.get(name) || [];
      group.push(fn); listeners.set(name, group);
    },
    dispatchEvent(event) { for (const fn of listeners.get(event.type) || []) fn(event); }};
  const context = vm.createContext({window, Date,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
    document: {hidden: true, readyState: 'loading', getElementById() { return null; }, addEventListener() {}},
    setInterval() {}, setTimeout() {},
    fetch(url) { return new Promise(resolve => requests.push({url, resolve})); }});
  const source = fs.readFileSync(file, 'utf8');
  const end = source.lastIndexOf('})();');
  const names = file.includes('chart-news-events')
    ? '{refresh: refreshNews, rows: () => events.slice()}'
    : '{refresh: refreshNewsSource, rows: () => newsRows.slice()}';
  vm.runInContext(source.slice(0, end) + 'window.__calendar = ' + names + ';' + source.slice(end), context);
  const app = fs.readFileSync('web/app.js', 'utf8');
  vm.runInContext(app.slice(app.indexOf('function setPrivateStateReady'), app.indexOf('async function loadMore')), context);
  return {window, requests, refresh: window.__calendar.refresh, rows: window.__calendar.rows,
    ready(value) { context.setPrivateStateReady(value); }};
}

const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function reply(request, title) {
  request.resolve({ok: true, json: async () => ({bot5: {news_sig: title, news: [{
    title, ts: Date.now() / 1000, kind: 'headline', impact: 'high', impact_window_sec: 900,
    headline_window_sec: 86400, headline_expire_ts: 123456,
    impacted_markets: [{market: 'BTCUSDTm', side: 'BUY'}]
  }]}})});
}

for (const file of ['web/chart-news-events.js', 'web/chart-overlay.js']) {
  test(`${file}: calendar waits for login, retains metadata and stops on logout`, async () => {
    const s = calendar(file);
    s.refresh(); assert.equal(s.requests.length, 0, 'no config/login readiness yet');
    s.ready(false); s.refresh(); assert.equal(s.requests.length, 0);
    s.ready(true); assert.equal(s.requests.length, 1, 'login wakes the reader immediately');
    s.refresh(); assert.equal(s.requests.length, 1, 'a slow host cannot overlap requests');
    reply(s.requests[0], 'verified headline'); await settle();
    assert.equal(s.rows()[0].title, 'verified headline');
    assert.equal(s.rows()[0].headline_window_sec, 86400);
    assert.equal(s.rows()[0].headline_expire_ts, 123456);
    s.refresh(); assert.match(s.requests[1].url, /have=verified%20headline/);
    s.ready(false); assert.equal(s.rows().length, 0);
    reply(s.requests[1], 'after logout'); await settle();
    assert.equal(s.rows().length, 0, 'in-flight private data is discarded after logout');
    s.refresh(); assert.equal(s.requests.length, 2);
  });

  test(`${file}: a new login discards an older response and promptly fetches fresh data`, async () => {
    const s = calendar(file);
    s.ready(true); s.ready(false); s.ready(true);
    assert.equal(s.requests.length, 1);
    reply(s.requests[0], 'older session'); await settle();
    assert.equal(s.rows().length, 0);
    assert.equal(s.requests.length, 2);
    assert.equal(s.requests[1].url, '/api/state', 'a new session has no old calendar signature');
    reply(s.requests[1], 'new session'); await settle();
    assert.equal(s.rows()[0].title, 'new session');
  });
}
