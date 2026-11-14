const {test} = require('node:test');
const assert = require('node:assert/strict');
const {create, parsePosition, holderWallets, contractFor} = require('../web/public-whale-feed.js');
const wallet = n => '0x' + n.toString(16).padStart(40, '0');
const position = (size = 30, value = 120000, coin = 'xyz:GOLD') => ({assetPositions: [{position: {
  coin, szi: String(size), entryPx: '4000', positionValue: String(value)}}]});
function fixture(storage) {
  let now = 1000000;
  const calls = [], positions = new Map([[wallet(1), position()], [wallet(2), position(-5000, 20000000)]]);
  let discovery = [wallet(1), wallet(2)], recent = [];
  const info = async body => {
    calls.push(body);
    if (body.type === 'meta') return {universe: [{name: body.dex ? 'xyz:GOLD' : 'BTC'}]};
    if (body.type === 'recentTrades') return recent.length ? [{coin: body.coin, users: recent}] : [];
    const data = positions.get(body.user) || {assetPositions: []};
    if (data instanceof Error) throw data;
    return data;
  };
  const options = {info, discovery: async () => discovery, clock: () => now, storage};
  const feed = create(options);
  return {feed, options, calls, positions, advance() { now += 16000; },
    recent(values) { recent = values; }, discovery(values) { discovery = values; }};
}

test('broader public addresses discover BUY and SELL holds absent from recent trades', async () => {
  const f = fixture();
  const data = await f.feed.scan('XAUUSDm');
  assert.equal(data.buy_count, 1);
  assert.equal(data.sell_count, 1);
  assert.equal(data.positions[0].entry_price, 4000);
  assert.equal(data.wallets_checked, 2);
  assert.ok(f.calls.filter(row => row.type === 'clearinghouseState').every(row => row.dex === 'xyz'));
});

test('partial reductions remain tracked and verified exits remove positions', async () => {
  const f = fixture();
  await f.feed.scan('XAUUSDm');
  f.advance();
  f.positions.set(wallet(1), position(1, 4000));
  assert.equal((await f.feed.scan('XAUUSDm')).buy_count, 1);
  f.advance();
  f.positions.set(wallet(1), {assetPositions: []});
  assert.equal((await f.feed.scan('XAUUSDm')).buy_count, 0);
});

test('failed or malformed wallet snapshots retain the last verified holding', async () => {
  const f = fixture();
  await f.feed.scan('XAUUSDm');
  f.advance();
  f.positions.set(wallet(1), new Error('timeout'));
  f.positions.set(wallet(2), {error: 'offline'});
  const data = await f.feed.scan('XAUUSDm');
  assert.equal(data.status, 'partial');
  assert.equal(data.positions.length, 2);
  assert.ok(data.positions.every(row => row.stale));
});

test('cached tracked positions survive reload and stay stale until rechecked', async () => {
  const values = new Map(), storage = {getItem: key => values.get(key), setItem: (key, value) => values.set(key, value)};
  const f = fixture(storage);
  await f.feed.scan('XAUUSDm');
  f.advance();
  const restored = create(f.options);
  assert.equal(restored.snapshot('XAUUSDm').positions.length, 2);
  assert.ok(restored.snapshot('XAUUSDm').positions.every(row => row.stale));
  f.positions.set(wallet(1), position(1, 4000));
  assert.equal((await restored.scan('XAUUSDm')).buy_count, 1);
});

test('wallet balances are discovery only; small or absent perp positions do not qualify', async () => {
  const f = fixture();
  f.positions.set(wallet(1), position(1, 4000));
  f.positions.set(wallet(2), {assetPositions: []});
  assert.deepEqual((await f.feed.scan('XAUUSDm')).positions, []);
  assert.deepEqual(holderWallets({holders: {[wallet(1)]: 1e9, [wallet(2)]: 2e9, bad: 10}}), [wallet(2), wallet(1)]);
  assert.deepEqual(holderWallets({addresses: {[wallet(1)]: 1}}), [wallet(1)]);
});

test('missing and invalid position numbers never become fabricated exits', () => {
  for (const bad of [null, '', ' ', 'NaN', true]) {
    const data = position(); data.assetPositions[0].position.szi = bad;
    assert.throws(() => parsePosition(data, 'xyz:GOLD'));
  }
  assert.equal(parsePosition(position(10, 100000, 'BTC'), 'xyz:GOLD'), null);
});

test('scans are bounded and quiet candidates rotate instead of starving later holders', async () => {
  const f = fixture();
  f.discovery(Array.from({length: 40}, (_, index) => wallet(index + 1)));
  f.positions.clear(); f.positions.set(wallet(17), position());
  assert.equal((await f.feed.scan('XAUUSDm')).buy_count, 0);
  f.advance();
  assert.equal((await f.feed.scan('XAUUSDm')).buy_count, 1);
  assert.ok(f.calls.filter(row => row.type === 'clearinghouseState').length <= 48);
});

test('unsupported FX has no invented coverage and unsupported metadata cannot remain scanning', async () => {
  const f = fixture();
  assert.equal((await f.feed.scan('EURUSDm')).status, 'unsupported');
  assert.equal(f.calls.length, 0);
  const bad = create({info: async () => ({universe: []}), discovery: async () => [], storage: null});
  const data = await bad.scan('XAUUSDm');
  assert.equal(data.status, 'unsupported');
  assert.equal(data.scanning, false);
  assert.equal(contractFor('BTCUSDTm').coin, 'BTC');
  assert.equal(contractFor('XAUGBPm'), null);
});
