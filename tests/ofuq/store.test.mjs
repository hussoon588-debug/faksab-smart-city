import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, createMemoryStorage, createStore, migrate } from '../../apps/ofuq/src/store.js';
import { APP, ECONOMY } from '../../apps/ofuq/src/config.js';
import { plotKey } from '../../apps/ofuq/src/core.js';

const HOUR = 60 * 60 * 1000;

function setup({ seed = null, start = Date.UTC(2026, 10, 5, 9, 0, 0) } = {}) {
  const clock = { now: start };
  const storage = createMemoryStorage(seed);
  const store = createStore({ storage, now: () => clock.now });
  return { store, clock, storage };
}

const xpFor = (level) => [0, 700, 1800, 3600, 6000, 9000][level - 1];

test('a fresh store starts from the configured economy', () => {
  const { store } = setup();
  assert.equal(store.state.cash, ECONOMY.startCash);
  assert.equal(store.state.xp, 0);
  assert.deepEqual(store.state.plots, {});
  assert.equal(store.state.playerName, APP.defaultPlayerName);
});

test('buying a plot spends cash, grants XP and records the plot', () => {
  const { store } = setup();
  const result = store.buy('harbor', 1);
  assert.equal(result.ok, true);
  assert.equal(store.state.cash, ECONOMY.startCash - 400);
  assert.equal(store.state.xp, ECONOMY.xp.buy);
  assert.equal(store.state.plots[plotKey('harbor', 1)].plotNo, 1);

  assert.equal(store.buy('harbor', 1).ok, false, 'the same plot cannot be bought twice');
  assert.equal(store.buy('harbor', 0).ok, false, 'plot numbers are validated');
  assert.equal(store.buy('harbor', 21).ok, false, 'plot numbers stay inside the district');
  assert.equal(store.buy('nope', 1).ok, false, 'unknown districts are rejected');
  assert.equal(store.buy('downtown', 1).ok, false, 'level-gated districts are locked');
});

test('purchases are refused when cash is insufficient', () => {
  const { store } = setup();
  store.state.cash = 300;
  const result = store.buy('harbor', 1);
  assert.equal(result.ok, false);
  assert.match(result.message, /السيولة/);
  assert.equal(Object.keys(store.state.plots).length, 0, 'a refused purchase must not create a plot');

  store.state.cash = 400;
  assert.equal(store.buy('harbor', 1).ok, true, 'exact change is accepted');
  assert.equal(store.state.cash, 0);
});

test('development requires an unlocked asset type and enough cash', () => {
  const { store } = setup();
  store.buy('harbor', 1);
  const key = plotKey('harbor', 1);

  assert.equal(store.develop(key, 'office').ok, false, 'office needs level 3');
  assert.equal(store.develop(key, 'nope').ok, false, 'unknown asset type');
  assert.equal(store.develop('harbor:9', 'studio').ok, false, 'plot must be owned');

  const cashBefore = store.state.cash;
  const result = store.develop(key, 'studio');
  assert.equal(result.ok, true);
  plotLevelIs(store, key, 1);
  assert.equal(store.state.cash, cashBefore - 1400);
  assert.equal(store.state.plots[key].assetId, 'studio');
  assert.equal(store.develop(key, 'studio').ok, false, 'a developed plot cannot be redeveloped');
});

function plotLevelIs(store, key, level) {
  assert.equal(store.state.plots[key].level, level);
}

test('upgrades respect the level cap and the cash balance', () => {
  const { store } = setup();
  store.buy('harbor', 1);
  const key = plotKey('harbor', 1);
  assert.equal(store.upgrade(key).ok, false, 'bare land cannot be upgraded');

  store.develop(key, 'studio');
  const upgrade = store.upgrade(key);
  assert.equal(upgrade.ok, true);
  plotLevelIs(store, key, 2);

  store.state.cash = 0;
  assert.equal(store.upgrade(key).ok, false, 'upgrades need liquidity');

  store.state.cash = 10_000_000;
  for (let level = 2; level < ECONOMY.maxLevel; level += 1) store.upgrade(key);
  plotLevelIs(store, key, ECONOMY.maxLevel);
  assert.equal(store.upgrade(key).ok, false, 'the cap stops further upgrades');
});

test('rent accrues over time and collection credits cash exactly once', () => {
  const { store, clock } = setup();
  store.buy('harbor', 1);
  const key = plotKey('harbor', 1);
  store.develop(key, 'studio');

  assert.equal(store.collect(key).ok, false, 'nothing accrued yet');
  clock.now += 2 * HOUR;
  const before = store.state.cash;
  const result = store.collect(key);
  assert.equal(result.ok, true);
  assert.equal(result.amount, 68);
  assert.equal(store.state.cash, before + 68);
  assert.equal(store.state.stats.collected, 1);
  assert.equal(store.state.week.collected, 1);
  assert.equal(store.collect(key).ok, false, 'double collection is impossible');
});

test('collectAll sweeps every asset and reports a total', () => {
  const { store, clock } = setup();
  store.buy('harbor', 1);
  store.buy('harbor', 2);
  store.develop(plotKey('harbor', 1), 'studio');
  store.develop(plotKey('harbor', 2), 'studio');
  clock.now += HOUR;

  const before = store.state.cash;
  const result = store.collectAll();
  assert.equal(result.ok, true);
  assert.equal(result.amount, 68);
  assert.equal(store.state.cash, before + 68);
  assert.equal(store.state.week.collected, 2);
  assert.equal(store.collectAll().ok, false, 'nothing left to collect');
});

test('selling returns net proceeds and frees the plot', () => {
  const { store } = setup();
  store.buy('harbor', 1);
  const key = plotKey('harbor', 1);
  store.develop(key, 'studio');
  const before = store.state.cash;

  const result = store.sell(key);
  assert.equal(result.ok, true);
  assert.equal(store.state.plots[key], undefined);
  assert.equal(store.state.cash, before + 1594);
  assert.equal(store.state.stats.sold, 1);
  assert.equal(store.sell(key).ok, false);
});

test('weekly challenges can only be claimed once', () => {
  const { store } = setup();
  store.buy('harbor', 1);
  store.buy('harbor', 2);
  store.buy('harbor', 3);
  store.buy('harbor', 4);
  const cashBefore = store.state.cash;

  const claim = store.claim('own4');
  assert.equal(claim.ok, true);
  assert.equal(store.state.cash, cashBefore + 800);
  assert.equal(store.claim('own4').ok, false, 'already claimed this week');
  assert.equal(store.claim('missing').ok, false, 'unknown challenge');
});

test('player name and settings are validated then persisted', () => {
  const { store } = setup();
  assert.equal(store.setName('أ').ok, false);
  assert.equal(store.setName('شركة أفق').ok, true);
  assert.equal(store.state.playerName, 'شركة أفق');

  assert.equal(store.state.settings.haptics, true);
  store.toggleHaptics();
  assert.equal(store.state.settings.haptics, false);
});

test('state survives a reload through the storage adapter', () => {
  const storage = createMemoryStorage();
  const first = createStore({ storage, now: () => Date.UTC(2026, 10, 5, 9) });
  first.buy('harbor', 1);
  first.develop(plotKey('harbor', 1), 'studio');
  first.setName('مستثمر الاختبار');

  const second = createStore({ storage, now: () => Date.UTC(2026, 10, 5, 9) });
  assert.equal(second.state.playerName, 'مستثمر الاختبار');
  assert.equal(second.state.plots[plotKey('harbor', 1)].assetId, 'studio');
  assert.equal(second.state.cash, first.state.cash);
});

test('reset returns to a clean wallet without touching other tabs', () => {
  const { store } = setup();
  store.buy('harbor', 1);
  store.setName('شركة');
  const result = store.reset();
  assert.equal(result.ok, true);
  assert.deepEqual(store.state.plots, {});
  assert.equal(store.state.cash, ECONOMY.startCash);
  assert.equal(store.state.xp, 0);
});

test('corrupt or hostile storage never crashes the app', () => {
  assert.deepEqual(migrate(null).state.plots, {});
  assert.deepEqual(migrate('nonsense').state.plots, {});
  const hostile = migrate({
    cash: -500,
    xp: Number.NaN,
    playerName: '<img src=x onerror=alert(1)>',
    plots: {
      'harbor:1': { districtId: 'harbor', plotNo: 1, assetId: 'castle', level: 99 },
      'moon:4': { districtId: 'moon', plotNo: 4, assetId: 'studio', level: 1 },
      'harbor:999': { districtId: 'harbor', plotNo: 999, assetId: 'studio', level: 1 }
    },
    claims: { '2026-W45': ['own4', 42] }
  }).state;

  assert.equal(hostile.cash, 0);
  assert.equal(hostile.xp, 0);
  assert.equal(hostile.playerName, APP.defaultPlayerName, 'invalid names fall back to the default');
  assert.deepEqual(Object.keys(hostile.plots), ['harbor:1'], 'only valid plots are kept');
  assert.equal(hostile.plots['harbor:1'].assetId, null, 'unknown asset types are dropped');
  assert.deepEqual(hostile.claims['2026-W45'], ['own4'], 'non-string claims are filtered');

  const { store } = setup({ seed: '{"broken": ' });
  assert.equal(store.state.cash, ECONOMY.startCash, 'unparsable storage falls back to a fresh state');
});

test('the week rolls over and resets weekly counters', () => {
  const { store, clock } = setup();
  store.buy('harbor', 1);
  store.develop(plotKey('harbor', 1), 'studio');
  assert.equal(store.state.week.developed, 1);

  const firstWeek = store.state.week.key;
  clock.now += 8 * 24 * HOUR;
  store.buy('harbor', 2);
  assert.notEqual(store.state.week.key, firstWeek);
  assert.equal(store.state.week.developed, 0, 'weekly counters reset with the week');
  assert.equal(store.state.week.bought, 1);
});

test('xp thresholds drive district unlocks end to end', () => {
  const { store } = setup();
  store.state.cash = 1_000_000;
  store.state.xp = xpFor(3);
  assert.equal(store.buy('downtown', 1).ok, true, 'level 3 unlocks the business district');
  assert.equal(store.buy('tech', 10).ok, true, 'level 3 unlocks the tech valley');
  assert.equal(store.buy('horizon', 1).ok, false, 'level 4 is still required for the north');

  store.state.xp = xpFor(4);
  assert.equal(store.buy('horizon', 1).ok, true);
});

test('createInitialState is a snapshot, not shared mutable state', () => {
  const a = createInitialState(1);
  const b = createInitialState(1);
  a.plots['harbor:1'] = { fake: true };
  a.week.bought = 5;
  assert.deepEqual(b.plots, {});
  assert.equal(b.week.bought, 0);
});
