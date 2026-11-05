// The ledger is the product's credibility: every number on screen must be explainable by
// one row, and the rows must add up to the balance the player sees.
import test from 'node:test';
import assert from 'node:assert/strict';

import { ECONOMY } from '../../apps/ofuq/src/config.js';
import {
  LEDGER_REASONS,
  groupLedger,
  ledgerLabel,
  ledgerReconciles,
  ledgerTotals,
  plotLedger
} from '../../apps/ofuq/src/core.js';
import { createInitialState, createMemoryStorage, createStore, migrate } from '../../apps/ofuq/src/store.js';

const HOUR = 60 * 60 * 1000;

function clockedStore(start = Date.UTC(2026, 10, 5, 9, 0, 0)) {
  const clock = { now: start };
  const store = createStore({ storage: createMemoryStorage(), now: () => clock.now });
  return { store, clock };
}

test('a new wallet starts with one row that explains the starting balance', () => {
  const { store } = clockedStore();
  const { ledger, cash } = store.state;

  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].reason, 'signup_bonus');
  assert.equal(ledger[0].amount, ECONOMY.startCash);
  assert.equal(ledger[0].balanceAfter, cash);
  assert.equal(ledgerReconciles(ledger, cash), true);
  assert.equal(ledgerLabel('signup_bonus'), 'رصيد البداية');
});

test('every action writes exactly one row with a known reason', () => {
  const { store, clock } = clockedStore();
  const rowsAfter = () => store.state.ledger.length;

  const before = rowsAfter();
  assert.equal(store.dispatch('buy', { districtId: 'harbor', plotNo: 1 }).ok, true);
  assert.equal(rowsAfter(), before + 1);
  assert.equal(store.state.ledger[0].reason, 'plot_purchase');
  assert.equal(store.state.ledger[0].amount, -400);
  assert.equal(store.state.ledger[0].ref, 'harbor:1');

  assert.equal(store.dispatch('develop', { plotKey: 'harbor:1', assetId: 'studio' }).ok, true);
  assert.equal(store.state.ledger[0].reason, 'development');
  assert.equal(store.state.ledger[0].amount, -1400);

  assert.equal(store.dispatch('upgrade', { plotKey: 'harbor:1' }).ok, true);
  assert.equal(store.state.ledger[0].reason, 'upgrade');
  assert.ok(store.state.ledger[0].amount < 0);

  clock.now += 3 * HOUR;
  const collected = store.dispatch('collect', { plotKey: 'harbor:1' });
  assert.equal(collected.ok, true);
  assert.equal(store.state.ledger[0].reason, 'rent');
  assert.equal(store.state.ledger[0].amount, collected.amount);

  const sell = store.dispatch('sell', { plotKey: 'harbor:1' });
  assert.equal(sell.ok, true);
  assert.equal(store.state.ledger[0].reason, 'sale');
  assert.ok(store.state.ledger[0].amount > 0);

  for (const row of store.state.ledger) {
    assert.ok(row.reason in LEDGER_REASONS, `unlabelled reason: ${row.reason}`);
    assert.equal(typeof row.balanceAfter, 'number');
    assert.equal(typeof row.ts, 'number');
  }
});

test('the rows add up to the balance after a full session', () => {
  const { store, clock } = clockedStore();
  // No cash is injected here on purpose: the point is that the *starting* balance is the
  // first row, so everything after it must reconcile without help.
  store.dispatch('buy', { districtId: 'harbor', plotNo: 2 });
  store.dispatch('develop', { plotKey: 'harbor:2', assetId: 'studio' });
  store.dispatch('upgrade', { plotKey: 'harbor:2' });
  clock.now += 5 * HOUR;
  store.dispatch('collect', { plotKey: 'harbor:2' });
  store.dispatch('sell', { plotKey: 'harbor:2' });

  const { ledger, cash } = store.state;
  const totals = ledgerTotals(ledger);
  assert.equal(totals.net, cash, 'inflow minus outflow equals the wallet');
  assert.equal(ledger[ledger.length - 1].reason, 'signup_bonus', 'the first row is still the origin');
  assert.equal(ledgerReconciles(ledger, cash), true);
  assert.ok(totals.outflow >= 400 + 1400, 'purchases and works are counted as outflow');
  assert.ok(totals.inflow > 0);
});

test('collecting everything writes one row per building, so each rent is traceable', () => {
  const { store, clock } = clockedStore();
  store.state.cash = 40000;
  store.dispatch('buy', { districtId: 'harbor', plotNo: 1 });
  store.dispatch('buy', { districtId: 'harbor', plotNo: 2 });
  store.dispatch('develop', { plotKey: 'harbor:1', assetId: 'studio' });
  store.dispatch('develop', { plotKey: 'harbor:2', assetId: 'studio' });
  clock.now += 4 * HOUR;

  const rowsBefore = store.state.ledger.length;
  const result = store.dispatch('collectAll');
  assert.equal(result.ok, true);
  const rentRows = store.state.ledger.slice(0, store.state.ledger.length - rowsBefore);
  assert.equal(rentRows.length, 2);
  assert.deepEqual(rentRows.map((row) => row.reason), ['rent', 'rent']);
  assert.deepEqual(new Set(rentRows.map((row) => row.ref)), new Set(['harbor:1', 'harbor:2']));
  assert.equal(
    rentRows.reduce((sum, row) => sum + row.amount, 0),
    result.amount,
    'the rows sum to the collected total'
  );
});

test('a plot keeps its history after it is sold', () => {
  const { store, clock } = clockedStore();
  store.state.cash = 40000;
  store.dispatch('buy', { districtId: 'garden', plotNo: 5 });
  store.dispatch('develop', { plotKey: 'garden:5', assetId: 'studio' });
  clock.now += 2 * HOUR;
  store.dispatch('collect', { plotKey: 'garden:5' });
  store.dispatch('sell', { plotKey: 'garden:5' });

  assert.equal(store.state.plots['garden:5'], undefined, 'the plot is gone from the portfolio');
  const history = plotLedger(store.state.ledger, 'garden:5');
  assert.deepEqual(history.map((row) => row.reason), ['sale', 'rent', 'development', 'plot_purchase']);
  assert.equal(plotLedger(store.state.ledger, 'tech:9').length, 0);
});

test('migration keeps valid rows, drops garbage and dates the gap honestly', () => {
  const now = Date.UTC(2026, 10, 5, 9);
  const legacy = {
    schemaVersion: 0,
    cash: 3450,
    createdAt: now - 5 * 24 * HOUR,
    plots: {},
    claims: {},
    ledger: [
      { id: 'x1', ts: now - 1000, reason: 'rent', amount: 120, balanceAfter: 3450, ref: 'harbor:3' },
      { id: 'x2', ts: 'not a date', reason: 'rent', amount: 50, balanceAfter: 3400 },
      { id: 'x3', ts: now - 2000, reason: 42, amount: 50, balanceAfter: 3400 },
      { ts: now - 3000, reason: 'plot_purchase', amount: -400, balanceAfter: 3350 }
    ]
  };

  const { state } = migrate(legacy, now);
  assert.equal(state.ledger.length, 2, 'the malformed date and the unknown reason are dropped');
  assert.deepEqual(
    state.ledger.map((row) => row.ts),
    [now - 1000, now - 3000],
    'newest first'
  );
  assert.ok(state.ledger.every((row) => typeof row.id === 'string'));

  const { state: gap } = migrate({ schemaVersion: 1, cash: 5000, createdAt: now - 9 * 24 * HOUR }, now);
  assert.equal(gap.ledger.length, 1);
  assert.equal(gap.ledger[0].reason, 'opening_balance');
  assert.equal(gap.ledger[0].amount, 5000);
  assert.equal(ledgerReconciles(gap.ledger, gap.cash), true);

  const fresh = createInitialState(now);
  assert.equal(fresh.ledger.length, 1);
  assert.equal(fresh.ledger[0].reason, 'signup_bonus');
});

test('the ledger is capped so a long game cannot grow storage without bound', () => {
  const now = Date.UTC(2026, 10, 5, 9);
  const rows = Array.from({ length: 900 }, (_, index) => ({
    id: `r${index}`,
    ts: now - index * 1000,
    reason: 'rent',
    amount: 10,
    balanceAfter: 1000
  }));
  const { state } = migrate({ schemaVersion: 1, cash: 1000, ledger: rows, ledgerSeq: 900 }, now);
  assert.equal(state.ledger.length, 400);
  assert.equal(state.ledgerSeq, 900);
});

test('day groups label today and yesterday, and carry their own net', () => {
  const now = Date.UTC(2026, 10, 5, 12);
  const entries = [
    { ts: now, amount: 100, reason: 'rent' },
    { ts: now - 1000, amount: -40, reason: 'development' },
    { ts: now - 24 * HOUR, amount: 7, reason: 'rent' }
  ];
  const groups = groupLedger(entries, now);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].label, 'اليوم');
  assert.equal(groups[0].net, 60);
  assert.equal(groups[1].label, 'أمس');
  assert.equal(groups[1].net, 7);
});

test('reconciliation fails loudly when the rows and the balance disagree', () => {
  const entries = [{ ts: 2, amount: 5, balanceAfter: 105, reason: 'rent' }];
  assert.equal(ledgerReconciles(entries, 105), true);
  assert.equal(ledgerReconciles(entries, 999), false);
  assert.equal(ledgerReconciles([], 0), true);
});
