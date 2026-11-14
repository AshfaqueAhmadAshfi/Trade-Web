const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createObserver} = require('../web/running-news-alert.js');

function fixture() {
  const alerts = [], resets = [];
  const observer = createObserver((events, market) => alerts.push({events, market}), () => resets.push(true));
  const observe = (events, extra = {}) => observer.observe({market: 'XAUUSD', label: 'XAUUSDm', now: 1000, ready: true, events, ...extra});
  return {alerts, resets, observe};
}
const row = (key, extra = {}) => ({key, title: key, expiresAt: 2000, ...extra});

test('loading and the first news snapshot stay quiet; a repeated release result is not a new alert', () => {
  const f = fixture();
  f.observe([], {ready: false});
  f.observe([row('already running')]);
  f.observe([row('already running', {title: 'Updated release result'})]);
  assert.equal(f.alerts.length, 0);
});

test('simultaneous new news shares one alert and refetching it does not repeat the alert', () => {
  const f = fixture();
  f.observe([row('existing')]);
  f.observe([row('existing'), row('new release'), row('new headline', {headline: true})]);
  assert.equal(f.alerts.length, 1);
  assert.deepEqual(f.alerts[0].events.map(e => e.key), ['new release', 'new headline']);
  assert.equal(f.alerts[0].market, 'XAUUSDm');
  f.observe([row('new release'), row('new headline', {headline: true})]);
  assert.equal(f.alerts.length, 1);
});

test('expired news cannot alert, and switching markets treats the new market snapshot as existing news', () => {
  const f = fixture();
  f.observe([]);
  f.observe([row('expired', {expiresAt: 999})]);
  assert.equal(f.alerts.length, 0);
  f.observe([row('BTC existing')], {market: 'BTCUSDT', label: 'BTCUSDm'});
  assert.equal(f.alerts.length, 0);
  f.observe([row('BTC existing'), row('BTC new')], {market: 'BTCUSDT', label: 'BTCUSDm'});
  assert.equal(f.alerts.length, 1);
  assert.equal(f.alerts[0].market, 'BTCUSDm');
  assert.equal(f.resets.length, 2);
});
