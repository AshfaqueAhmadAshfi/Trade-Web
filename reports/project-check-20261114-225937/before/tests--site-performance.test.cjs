const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {create} = require('../web/news-list-renderer.js');

function newsRenderer() {
  let visible = false, next = 0;
  const timers = new Map(), batches = [];
  const element = {innerHTML: 'old', scrollTop: 0, scrollHeight: 1000, clientHeight: 100,
    insertAdjacentHTML(where, html) { batches.push(html); this.innerHTML += html; }};
  const renderer = create({element, batchSize: 24, visible: () => visible,
    schedule(fn) { const id = ++next; timers.set(id, fn); return id; },
    cancel(id) { timers.delete(id); }});
  return {renderer, element, batches, timers,
    show(value = true) { visible = value; if (value) renderer.resume(); else renderer.pause(); },
    step() { const [id, fn] = timers.entries().next().value; timers.delete(id); fn(); }};
}

test('a large News list waits for visibility and yields between bounded batches without losing rows', () => {
  const s = newsRenderer(), rows = Array.from({length: 460}, (_, i) => i);
  const render = n => `[${n}]`;
  s.renderer.update(rows, 'first', render);
  assert.equal(s.timers.size, 0);
  assert.equal(s.element.innerHTML, 'old');
  s.show(); s.step();
  assert.equal(s.batches[0], rows.slice(0, 24).map(render).join(''));
  assert.equal(s.timers.size, 1);
  s.show(false);
  assert.equal(s.timers.size, 0);
  s.show();
  while (s.timers.size) s.step();
  assert.equal(s.element.innerHTML, rows.map(render).join(''));
  assert.equal(s.batches.length, Math.ceil(460 / 24));
  s.renderer.update(rows, 'first', render);
  assert.equal(s.timers.size, 0, 'unchanged data must not rebuild the list');
});

test('new News filters cancel an unfinished batch and retain the latest feed only', () => {
  const s = newsRenderer();
  s.show(); s.renderer.update(Array.from({length: 90}, (_, i) => i), 'old', n => `[${n}]`); s.step();
  s.renderer.update(['latest'], 'new', n => n);
  assert.equal(s.timers.size, 1);
  s.step();
  assert.equal(s.element.innerHTML, 'latest');
  assert.equal(s.timers.size, 0);
});

test('hidden state frames retain the newest data and calendar until the page resumes', () => {
  const source = fs.readFileSync('web/app.js', 'utf8');
  const painted = [], timers = new Map();
  const context = vm.createContext({document: {hidden: true}, Date,
    applyState: value => painted.push(value), setTimeout(fn) { timers.set(1, fn); return 1; },
    clearTimeout(id) { timers.delete(id); }});
  vm.runInContext(source.slice(source.indexOf('let _statePending'), source.indexOf('function scheduleReconnect')), context);
  context.queueStateFrame({version: 1, bot5: {news: ['new release'], news_sig: 'new'}});
  context.queueStateFrame({version: 2, bot5: {news_sig: 'new'}});
  assert.equal(painted.length, 0); assert.equal(timers.size, 0);
  context.document.hidden = false;
  context.applyPendingState();
  assert.equal(painted.length, 1); assert.equal(painted[0].version, 2);
  assert.deepEqual(painted[0].bot5.news, ['new release']);
});

test('disabled trading cards do not repaint when the economic News drawer opens', () => {
  const source = fs.readFileSync('web/app.js', 'utf8');
  const context = vm.createContext(Object.fromEntries(['renderBot', 'renderBot2', 'renderBot3', 'renderBot4', 'renderBot6', 'renderBot7']
    .map(name => [name, () => assert.fail('disabled card rendered')])));
  vm.runInContext('const botsEnabled=false, CFG={order_execution:false};' +
    source.slice(source.indexOf('function renderBotsPanels'), source.indexOf('/* Wipe every trace')), context);
  context.renderBotsPanels({connected: true});
});

test('HTTP polling waits for a slow response, skips hidden pages and cannot restart after stopping', async () => {
  const source = fs.readFileSync('web/app.js', 'utf8');
  let next = 0;
  const timers = new Map(), requests = [], painted = [];
  const context = vm.createContext({document: {hidden: false}, Date, AbortController,
    setTimeout(fn, ms) { const id = ++next; timers.set(id, {fn, ms}); return id; },
    clearTimeout(id) { timers.delete(id); }, $: () => null, queueStateFrame: d => painted.push(d),
    fetch() { return new Promise(resolve => requests.push(resolve)); }});
  vm.runInContext("let httpPollTimer=null,httpPollGeneration=0,wakeHttpPoll=null,newsHaveSig='',lastServerMsgAt=0;" +
    source.slice(source.indexOf('function startHttpPoll'), source.indexOf('function connectWS')), context);
  context.startHttpPoll(); context.startHttpPoll();
  assert.equal(requests.length, 1);
  assert.equal([...timers.values()].filter(t => t.ms === 2500).length, 0);
  requests[0]({ok: true, json: async () => ({version: 1})});
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(painted.length, 1);
  const poll = [...timers.entries()].find(([, t]) => t.ms === 2500);
  context.document.hidden = true; timers.delete(poll[0]); await poll[1].fn();
  assert.equal(requests.length, 1);
  context.stopHttpPoll(); context.document.hidden = false; context.startHttpPoll();
  assert.equal(requests.length, 2);
  context.stopHttpPoll();
  requests[1]({ok: true, json: async () => ({version: 2})});
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(painted.length, 1);
  assert.equal([...timers.values()].filter(t => t.ms === 2500).length, 0);
});

test('access-page orbit pauses offscreen or in a hidden tab and preserves the manual pause preference', () => {
  const frames = new Map(), events = {}, controls = {}, styles = [];
  let id = 0, observer;
  const card = {style: {getPropertyValue: () => '0deg', set transform(value) { styles.push(value); }},
    addEventListener(name, fn) { controls[name] = fn; }};
  const stage = {classList: {toggle() {}}, querySelector: () => ({clientWidth: 840, clientHeight: 424}),
    querySelectorAll: () => [card]};
  const toggle = {setAttribute() {}, querySelector: () => ({}), addEventListener(name, fn) { controls.click = fn; }};
  const document = {hidden: false, getElementById: id => id === 'systems' ? stage : toggle,
    addEventListener(name, fn) { events[name] = fn; }};
  vm.runInNewContext(fs.readFileSync('web/access.js', 'utf8'), {document,
    window: {matchMedia: () => ({matches: false, addEventListener() {}}), addEventListener() {}},
    requestAnimationFrame(fn) { frames.set(++id, fn); return id; }, cancelAnimationFrame(id) { frames.delete(id); },
    IntersectionObserver: class {constructor(fn) { observer = fn; } observe() {}},
    ResizeObserver: class {observe() {}}});
  assert.equal(styles[0], 'translate(-50%, -50%) translate3d(420.00px,0.00px,0)');
  assert.equal(frames.size, 1);
  observer([{isIntersecting: false}]); assert.equal(frames.size, 0);
  observer([{isIntersecting: true}]); assert.equal(frames.size, 1);
  document.hidden = true; events.visibilitychange(); assert.equal(frames.size, 0);
  document.hidden = false; events.visibilitychange(); assert.equal(frames.size, 1);
  controls.click(); assert.equal(frames.size, 0);
  document.hidden = true; events.visibilitychange();
  document.hidden = false; events.visibilitychange(); assert.equal(frames.size, 0);
  controls.click(); assert.equal(frames.size, 1);
  controls.pointerenter(); assert.equal(frames.size, 0);
  controls.pointerleave(); assert.equal(frames.size, 1);
});
