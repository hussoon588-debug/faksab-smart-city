// The weekly report and the milestone board are derived, never stored: they read the same
// ledger rows the wallet shows, so they cannot tell a different story than the balance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ECONOMY } from '../../apps/ofuq/src/config.js';
import { ACHIEVEMENTS, achievementBoard, weekBounds, weeklyReport } from '../../apps/ofuq/src/core.js';
import { createMemoryStorage, createStore } from '../../apps/ofuq/src/store.js';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// Thursday 5 November 2026, 12:00 local — its ISO week starts Monday the 2nd.
const THURSDAY = new Date(2026, 10, 5, 12, 0, 0).getTime();
const MONDAY = new Date(2026, 10, 2, 0, 0, 0).getTime();

function clocked(start = THURSDAY) {
  const clock = { now: start };
  const store = createStore({ storage: createMemoryStorage(), now: () => clock.now });
  return { store, clock };
}

test('the week starts on Monday at midnight, in the player’s own timezone', () => {
  const bounds = weekBounds(THURSDAY);
  assert.equal(bounds.start, MONDAY);
  assert.equal(bounds.end - bounds.start, 7 * DAY);
  assert.equal(new Date(bounds.start).getDay(), 1, 'Monday');
  assert.deepEqual(weekBounds(MONDAY).start, MONDAY, 'Monday belongs to its own week');
  assert.equal(weekBounds(MONDAY - 1).end, MONDAY, 'Sunday night belongs to the previous week');
});

test('the report counts this week only and compares it with the last one', () => {
  const state = {
    ledger: [
      { ts: THURSDAY, amount: 500, reason: 'rent', ref: 'harbor:1' },
      { ts: THURSDAY, amount: -400, reason: 'plot_purchase', ref: 'harbor:1' },
      { ts: THURSDAY - 8 * DAY, amount: 900, reason: 'rent', ref: 'harbor:1' },
      { ts: THURSDAY - 15 * DAY, amount: 10, reason: 'rent' }
    ],
    plots: { 'harbor:1': { districtId: 'harbor', plotNo: 1, assetId: 'studio', level: 1 } },
    stats: {},
    cash: 1000,
    xp: 0
  };

  const report = weeklyReport(state, THURSDAY);
  assert.equal(report.count, 2, 'only this week’s rows');
  assert.equal(report.totals.inflow, 500);
  assert.equal(report.totals.outflow, 400);
  assert.equal(report.totals.net, 100);
  assert.equal(report.previous.net, 900);
  assert.equal(report.hasPrevious, true);
  assert.equal(report.netChange, Math.round(((100 - 900) / 900) * 100));
  assert.equal(report.topEarner.key, 'harbor:1');
  assert.equal(report.topEarner.amount, 500);
  assert.equal(report.topEarner.plot.districtId, 'harbor');
});

test('the seven bars add up to the week’s net, and a bad day is still a day', () => {
  const state = {
    ledger: [
      { ts: MONDAY + 9 * HOUR, amount: 300, reason: 'rent' },
      { ts: MONDAY + 10 * HOUR, amount: -400, reason: 'plot_purchase' },
      { ts: MONDAY + 3 * DAY + 5 * HOUR, amount: 120, reason: 'rent' },
      { ts: MONDAY + 4 * DAY, amount: -10, reason: 'market_fee' }
    ],
    plots: {},
    stats: {},
    cash: 0,
    xp: 0
  };

  const report = weeklyReport(state, THURSDAY);
  assert.equal(report.days.length, 7);
  assert.equal(
    report.days.reduce((sum, day) => sum + day.net, 0),
    report.totals.net,
    'nothing is lost between the rows and the chart'
  );
  assert.equal(report.days[0].net, -100, 'Monday is a net loss of 100');
  assert.equal(report.days[0].count, 2);
  assert.equal(report.days[3].net, 120);
  assert.equal(report.bestDay.index, 3, 'the best day is the one with the highest net');
  assert.equal(report.daysLeft > 0, true);
});

test('a first week says so instead of inventing a comparison', () => {
  const report = weeklyReport({ ledger: [{ ts: THURSDAY, amount: 50, reason: 'rent' }], plots: {}, stats: {}, cash: 0, xp: 0 }, THURSDAY);
  assert.equal(report.hasPrevious, false);
  assert.equal(report.incomeChange, null);
  assert.equal(weeklyReport({ ledger: [], plots: {}, stats: {}, cash: 0, xp: 0 }, THURSDAY).count, 0);
});

test('the report reads the ledger the store actually wrote', () => {
  const { store, clock } = clocked(MONDAY + 9 * HOUR);
  store.dispatch('buy', { districtId: 'harbor', plotNo: 1 });
  store.dispatch('develop', { plotKey: 'harbor:1', assetId: 'studio' });
  clock.now += 3 * HOUR;
  store.dispatch('collect', { plotKey: 'harbor:1' });

  const report = weeklyReport(store.state, clock.now);
  const weekRows = store.state.ledger.filter(
    (row) => row.ts >= report.start && row.ts < report.end && row.reason !== 'signup_bonus'
  );
  assert.equal(report.count, weekRows.length);
  assert.equal(report.totals.net, weekRows.reduce((sum, row) => sum + row.amount, 0));
  assert.equal(store.state.cash, ECONOMY.startCash + report.totals.net, 'the balance is the start plus this week');

  // The starting grant is not income: it is where the wallet began.
  const withBonus = weeklyReport(
    { ledger: [{ ts: THURSDAY, amount: ECONOMY.startCash, reason: 'signup_bonus' }], plots: {}, stats: {}, cash: 0, xp: 0 },
    THURSDAY
  );
  assert.equal(withBonus.count, 0);
  assert.equal(withBonus.totals.inflow, 0);
});

test('milestones are derived from the wallet, with progress capped at the target', () => {
  const { store } = clocked();
  const fresh = achievementBoard(store.state);
  assert.equal(fresh.length, ACHIEVEMENTS.length);
  assert.equal(fresh.filter((item) => item.done).length, 0, 'a new wallet has nothing to show off');
  assert.equal(fresh.find((item) => item.id === 'auditor').value, 1, 'the opening row counts as a movement');

  store.dispatch('buy', { districtId: 'harbor', plotNo: 1 });
  store.dispatch('develop', { plotKey: 'harbor:1', assetId: 'studio' });

  const after = achievementBoard(store.state);
  assert.equal(after.find((item) => item.id === 'first_plot').done, true);
  assert.equal(after.find((item) => item.id === 'first_build').done, true);
  assert.equal(after.find((item) => item.id === 'five_plots').done, false);
  assert.equal(after.find((item) => item.id === 'five_plots').progress, 0.2);

  store.state.plots['harbor:1'].level = ECONOMY.maxLevel;
  assert.equal(achievementBoard(store.state).find((item) => item.id === 'tower').done, true);

  for (const item of achievementBoard(store.state)) {
    assert.ok(item.progress >= 0 && item.progress <= 1, `${item.id} progress is a ratio`);
    assert.ok(item.value <= item.target, `${item.id} never overshoots its target`);
  }
});

/* --------------------------------------------------------------------- UI --- */

let JSDOM = null;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  JSDOM = null;
}

async function bootUI() {
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
  return { dom, store, ui, $: (id) => dom.window.document.getElementById(id) };
}

test('the league tab shows the report and the board', { skip: !JSDOM && 'jsdom not installed' }, async (t) => {
  const { dom, store, ui, $ } = await bootUI();
  t.after(() => {
    ui.destroy();
    dom.window.close();
  });

  // A fresh wallet: the report must say "nothing yet" rather than show an empty chart.
  assert.match($('rpNote').textContent, /لا حركات مالية|أول أسبوع/);
  assert.equal($('rpChart').children.length, 7);
  assert.match($('achievementCount').textContent, /0 \/ \d+/);

  store.dispatch('buy', { districtId: 'harbor', plotNo: 1 });
  store.dispatch('develop', { plotKey: 'harbor:1', assetId: 'studio' });

  assert.match($('rpNote').textContent, /لا بيانات للأسبوع الماضي|مقارنة/);
  assert.match($('achievementCount').textContent, /2 \/ \d+/);
  const done = $('achievementList').querySelectorAll('.achievement.is-done');
  assert.equal(done.length, 2, 'buying and building light up two badges');
  assert.match($('achievementList').textContent, /أول قطعة/);
});
