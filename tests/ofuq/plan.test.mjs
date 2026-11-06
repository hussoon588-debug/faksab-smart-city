// The plan is arithmetic the player can check: what the next level costs, how much rent it adds,
// and how many hours of that added rent pay it back. No advice, no promises — just the numbers
// the store will charge and pay.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ECONOMY, DISTRICTS } from '../../apps/ofuq/src/config.js';
import { bestPurchase, districtFor, plotPrice, plotRent, portfolioPlan, upgradeCost, upgradePlan } from '../../apps/ofuq/src/core.js';
import { createMemoryStorage, createStore } from '../../apps/ofuq/src/store.js';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const harbor = districtFor('harbor');
const garden = districtFor('garden');

let JSDOM = null;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  JSDOM = null;
}

test('an upgrade plan says exactly what the next level costs and pays', () => {
  const plot = { districtId: 'harbor', plotNo: 1, assetId: 'studio', level: 1 };
  const plan = upgradePlan(plot, harbor);

  assert.equal(plan.level, 1);
  assert.equal(plan.nextLevel, 2);
  assert.equal(plan.maxed, false);
  assert.equal(plan.cost, upgradeCost(plot, harbor), 'the price comes from the same function the store charges');
  assert.equal(plan.rentNow, plotRent(plot, harbor));
  assert.equal(plan.rentNext, plotRent({ ...plot, level: 2 }, harbor));
  assert.equal(plan.delta, plan.rentNext - plan.rentNow);
  assert.equal(plan.paybackHours, Math.ceil(plan.cost / plan.delta));

  // 750 coins for +12/h is 62.5 hours of added rent — rounded up, never claimed as faster.
  assert.equal(plan.cost, 750);
  assert.equal(plan.delta, 12);
  assert.equal(plan.paybackHours, 63);

  assert.equal(upgradePlan({ ...plot, assetId: null }, harbor), null, 'a bare plot has nothing to upgrade');
  assert.equal(upgradePlan(plot, null), null, 'no district, no numbers');
  const top = upgradePlan({ ...plot, level: ECONOMY.maxLevel }, harbor);
  assert.equal(top.maxed, true);
  assert.equal(top.cost, 0);
  assert.equal(top.paybackHours, null);
});

test('the plan ranks by payback, and every row names a real plot', () => {
  const state = {
    cash: 5000,
    xp: 0,
    plots: {
      'harbor:1': { districtId: 'harbor', plotNo: 1, assetId: 'studio', level: 1 },
      'garden:4': { districtId: 'garden', plotNo: 4, assetId: 'office', level: 1 },
      'harbor:2': { districtId: 'harbor', plotNo: 2, assetId: 'studio', level: 5 }
    }
  };

  const rows = portfolioPlan(state);
  assert.equal(rows.length, 2, 'a maxed plot is not a step anyone can take');
  for (const row of rows) {
    assert.ok(row.plot, 'each row carries its plot, so the button can open it');
    assert.equal(row.key, `${row.plot.districtId}:${row.plot.plotNo}`);
    assert.equal(row.affordable, state.cash >= row.cost);
    assert.ok(row.district.name);
  }
  const paybacks = rows.map((row) => row.paybackHours);
  assert.deepEqual(paybacks, [...paybacks].sort((a, b) => a - b), 'fastest payback first');

  // Affordability is the wallet's opinion, not an assumption.
  const broke = portfolioPlan({ ...state, cash: 0 });
  assert.equal(broke.every((row) => row.affordable === false), true);
});

test('the suggested purchase is the best plot actually reachable with this wallet', () => {
  const fresh = { cash: ECONOMY.startCash, xp: 0, plots: {} };
  const pick = bestPurchase(fresh);
  assert.ok(pick, 'a player with money always has an option');
  assert.equal(pick.district.unlockLevel <= 1, true, 'level 1 cannot reach a locked district');
  assert.equal(pick.price, plotPrice(pick.district));
  assert.equal(pick.price <= fresh.cash, true);
  assert.equal(pick.districtId, 'garden', 'the highest tier it can afford wins over the cheapest');

  // Buying the best plot 20 times over removes them from the suggestions one by one.
  const owned = {};
  for (let no = 1; no <= 20; no += 1) owned[`garden:${no}`] = { districtId: 'garden', plotNo: no };
  const nextPick = bestPurchase({ ...fresh, plots: owned });
  assert.equal(nextPick.districtId, 'harbor', 'the garden is exhausted, the harbor is next');

  assert.equal(bestPurchase({ cash: 10, xp: 0, plots: {} }), null, 'no money, no promise');
  assert.equal(bestPurchase({ cash: 1e9, xp: 999999, plots: {} }).districtId, DISTRICTS.at(-1).id, 'the top district once unlocked');
});

test('the plan survives a real session against the wallet', () => {
  const store = createStore({ storage: createMemoryStorage() });
  assert.equal(portfolioPlan(store.state).length, 0, 'nothing owned, nothing to plan');

  store.dispatch('buy', { districtId: 'harbor', plotNo: 1 });
  assert.equal(portfolioPlan(store.state).length, 0, 'a bare plot has no upgrade to plan');

  store.dispatch('develop', { plotKey: 'harbor:1', assetId: 'studio' });
  const [plan] = portfolioPlan(store.state);
  const cashBefore = store.state.cash;
  store.dispatch('upgrade', { plotKey: 'harbor:1' });
  assert.equal(cashBefore - store.state.cash, plan.cost, 'the plan quoted the price the store charged');
  assert.equal(store.state.plots['harbor:1'].level, 2);
  assert.equal(plotRent(store.state.plots['harbor:1'], harbor), plan.rentNext, 'and the rent it promised');
});

test('the portfolio shows the plan with its numbers', { skip: !JSDOM && 'jsdom not installed' }, async (t) => {
  const html = await readFile(path.join(ROOT, 'apps/ofuq/index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost:8000/apps/ofuq/', pretendToBeVisual: true });
  dom.window.scrollTo = () => {};
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });

  const { mount } = await import('../../apps/ofuq/src/ui.js');
  const store = createStore({ storage: createMemoryStorage() });
  const ui = mount(store);
  t.after(() => {
    ui.destroy();
    dom.window.close();
  });

  const $ = (id) => dom.window.document.getElementById(id);
  assert.match($('planNote').textContent, /لم تبدأ بعد/);

  store.dispatch('buy', { districtId: 'harbor', plotNo: 1 });
  store.dispatch('develop', { plotKey: 'harbor:1', assetId: 'studio' });

  assert.match($('planState').textContent, /1 خطوة/);
  const row = $('planList').querySelector('.market-row');
  assert.ok(row);
  assert.match(row.textContent, /750/, 'the cost');
  assert.match(row.textContent, /\+12\/ساعة/, 'the added rent');
  assert.match(row.textContent, /يسترد نفسه في 63 ساعة/, 'the payback, in hours');
  assert.match(row.textContent, /حي الميناء/);
  assert.match($('planNote').textContent, /أفضل شراء متاح الآن/);

  // The button opens the plot it talks about, rather than a generic screen.
  row.querySelector('[data-action="open-plot"]').click();
  assert.equal($('sheet').hidden, false);
  assert.match($('sheetTitle').textContent, /قطعة 1/);
});
