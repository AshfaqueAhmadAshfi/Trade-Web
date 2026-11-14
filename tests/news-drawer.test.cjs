const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function drawerUI() {
  class Element {
    constructor() {
      const classes = new Set();
      this.classList = {
        add: (...values) => values.forEach(value => classes.add(value)),
        remove: (...values) => values.forEach(value => classes.delete(value)),
        contains: value => classes.has(value),
        toggle(value, force = !classes.has(value)) {
          if (force) classes.add(value); else classes.delete(value);
          return force;
        }
      };
      this.dataset = {};
      this.attributes = {};
      this.listeners = {};
      this.textContent = '';
      this.hidden = true;
    }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(name, handler) { this.listeners[name] = handler; }
    click() { this.listeners.click?.({target: this}); }
  }
  const ids = ['dash', 'bots-drawer', 'positions-drawer', 'drawer-scrim',
    'rail-bots', 'rail-activity', 'rail-positions', 'rail-history',
    'tab-btn-bots', 'tab-btn-activity', 'view-bots', 'view-activity',
    'bots-fs-toggle', 'bots-fs-icon', 'bots-fs-label'];
  const elements = Object.fromEntries(ids.map(id => [id, new Element()]));
  const close = new Element(), body = new Element(), events = {};
  elements['tab-btn-bots'].classList.add('active');
  const source = fs.readFileSync('web/app.js', 'utf8');
  const context = vm.createContext({window: {}, S: null,
    $: id => elements[id] || null,
    document: {body, getElementById: id => elements[id] || null,
      querySelectorAll: selector => selector === '[data-drawer-close]' ? [close] : [],
      addEventListener(name, handler) { events[name] = handler; }},
    playTactileClick() {}, initSoftradeXTerminalUI() {}, setupFlowWires() {}});
  vm.runInContext(source.slice(source.indexOf('/* ----------------------------------------------------- the side drawers */'),
    source.indexOf('function initSoftradeXTerminalUI()')), context);
  context.initFlowUI();
  return {elements, body, close, context,
    escape() { events.keydown({key: 'Escape'}); },
    openFullscreen() {
      elements['rail-bots'].click();
      elements['bots-fs-toggle'].click();
      assert.equal(elements['bots-drawer'].classList.contains('fullscreen'), true);
    }};
}

for (const action of ['close button', 'Escape', 'backdrop', 'News button', 'session reset']) {
  test(`closing fullscreen News with ${action} restores the dashboard and a normal reopen`, () => {
    const s = drawerUI(), e = s.elements;
    s.openFullscreen();
    if (action === 'close button') s.close.click();
    else if (action === 'Escape') s.escape();
    else if (action === 'backdrop') e['drawer-scrim'].click();
    else if (action === 'News button') e['rail-bots'].click();
    else s.context.closeFlowDrawers();

    assert.equal(e['bots-drawer'].classList.contains('fullscreen'), false);
    assert.equal(e.dash.classList.contains('drawer-right-open'), false);
    assert.equal(s.body.classList.contains('no-scroll'), false);
    assert.equal(e['drawer-scrim'].hidden, true);
    assert.equal(e['bots-drawer'].attributes['aria-hidden'], 'true');
    assert.equal(e['rail-bots'].attributes['aria-expanded'], 'false');
    assert.equal(e['bots-fs-label'].textContent, 'Fullscreen');
    assert.equal(e['bots-fs-toggle'].attributes['aria-pressed'], 'false');

    e['rail-bots'].click();
    assert.equal(e.dash.classList.contains('drawer-right-open'), true);
    assert.equal(e['bots-drawer'].classList.contains('fullscreen'), false);
    assert.equal(e['bots-fs-label'].textContent, 'Fullscreen');
  });
}

test('switching from fullscreen News to the left drawer releases the fullscreen surface', () => {
  const s = drawerUI(), e = s.elements;
  s.openFullscreen();
  s.context.window.__setFlowDrawer('left');
  assert.equal(e['bots-drawer'].classList.contains('fullscreen'), false);
  assert.equal(e.dash.classList.contains('drawer-left-open'), true);
  assert.equal(e.dash.classList.contains('drawer-right-open'), false);
  assert.equal(e['bots-fs-label'].textContent, 'Fullscreen');
});
