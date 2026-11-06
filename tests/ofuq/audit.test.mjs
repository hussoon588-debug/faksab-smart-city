// The audit is arithmetic the player can redo on paper: every row must land on the balance its
// predecessor left, and the newest row must equal the cash in hand. No trust required.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { auditLedger, buildLedgerCsv } from '../../apps/ofuq/src/core.js';
import { createMemoryStorage, createStore } from '../../apps/ofuq/src/store.js';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const DAY = 24 * 60 * 60 * 1000;

const opening = { id: 'l1', seq: 1, ts: 1000, reason: 'signup_bonus', amount: 12000, balanceAfter: 12000 };
const purchase = { id: 'l2', seq: 2, ts: 2000, reason: 'plot_purchase', amount: -400, balanceAfter: 11600 };
const rent = { id: 'l3', seq: 3, ts: 3000, reason: 'rent', amount: 102, balanceAfter: 11702 };

let JSDOM = null;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  JSDOM = null;
}

test('a clean ledger audits clean — and it is not a rubber stamp', () => {
  const clean = auditLedger([rent, opening, purchase], 11702);
  assert.equal(clean.ok, true);
  assert.equal(clean.checked, 3, 'storage order does not matter, the chain is rebuilt');
  assert.equal(clean.issues.length, 0);
  assert.equal(clean.firstAt, 1000);

  // One digit changed anywhere must be caught.
  const wrongAmount = auditLedger([opening, { ...purchase, amount: -500 }, rent], 11702);
  assert.equal(wrongAmount.ok, false);
  assert.equal(wrongAmount.issues[0].code, 'break');
  assert.equal(wrongAmount.issues[0].expected, 11500, '12,000 − 500, not the 11,600 the row claims');
  assert.equal(wrongAmount.issues[0].actual, 11600);
  assert.equal(wrongAmount.issues[0].reason, 'plot_purchase');

  const wrongBalance = auditLedger([opening, { ...purchase, balanceAfter: 11000 }], 11000);
  assert.equal(wrongBalance.ok, false, 'the cash matches the tampered row, the chain still breaks');
  assert.equal(wrongBalance.issues[0].code, 'break');
});

test('a missing row, a repeated row and a bad opening are all caught', () => {
  const gap = auditLedger([opening, rent], 11702);
  assert.equal(gap.ok, false, 'the purchase vanished: the chain jumps');
  assert.equal(gap.issues[0].code, 'break');

  const duplicated = auditLedger([opening, purchase, purchase], 11600);
  assert.equal(duplicated.ok, false);
  assert.ok(duplicated.issues.some((issue) => issue.code === 'duplicate'));

  const noOpening = auditLedger([purchase, rent], 11702);
  assert.equal(noOpening.ok, false);
  assert.equal(noOpening.issues[0].code, 'opening');

  const badOpening = auditLedger([{ ...opening, balanceAfter: 9000 }], 9000);
  assert.equal(badOpening.ok, false);
  assert.equal(badOpening.issues[0].code, 'opening');

  const negative = auditLedger([opening, { ...purchase, amount: -20000, balanceAfter: -8000 }], -8000);
  assert.equal(negative.ok, false);
  assert.ok(negative.issues.some((issue) => issue.code === 'negative'));
});

test('the audit compares the newest row with the cash on hand', () => {
  const drift = auditLedger([opening, purchase, rent], 999);
  assert.equal(drift.ok, false);
  const cashIssue = drift.issues.find((issue) => issue.code === 'cash');
  assert.ok(cashIssue);
  assert.equal(cashIssue.expected, 11702);
  assert.equal(cashIssue.actual, 999);

  const empty = auditLedger([], 0);
  assert.equal(empty.ok, true);
  assert.equal(empty.checked, 0, 'an empty ledger is not a failure, it is an absence');

  const span = auditLedger([{ ...opening, ts: 0 }, { ...purchase, ts: 3 * DAY }], 11600);
  assert.equal(span.spanDays, 3);
});

test('the audit survives a real session, and it agrees with the export', () => {
  const store = createStore({ storage: createMemoryStorage() });
  assert.equal(auditLedger(store.state.ledger, store.state.cash).ok, true, 'a fresh wallet audits clean');

  store.dispatch('buy', { districtId: 'harbor', plotNo: 1 });
  store.dispatch('develop', { plotKey: 'harbor:1', assetId: 'studio' });
  store.dispatch('collect', { plotKey: 'harbor:1' });
  store.dispatch('upgrade', { plotKey: 'harbor:1' });

  const report = auditLedger(store.state.ledger, store.state.cash);
  assert.equal(report.ok, true, 'four real actions leave a clean chain');
  assert.equal(report.checked, store.state.ledger.length);

  const csv = buildLedgerCsv(store.state.ledger);
  assert.equal(csv.trimEnd().split('\r\n').length, report.checked + 1, 'the export and the audit see the same rows');
});

test('the wallet shows the audit, and it flips when the ledger is broken', { skip: !JSDOM && 'jsdom not installed' }, async (t) => {
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
  store.dispatch('buy', { districtId: 'harbor', plotNo: 1 });
  assert.equal($('auditState').textContent, 'سليم');
  assert.match($('auditList').textContent, /حركة/);
  assert.match($('auditList').textContent, /يساوي رصيد المحفظة/);

  // Break one row behind the UI's back: the card must notice on the next render.
  store.state.ledger[0] = { ...store.state.ledger[0], balanceAfter: store.state.ledger[0].balanceAfter + 5 };
  store.refresh();
  assert.match($('auditState').textContent, /ملاحظة/);
  assert.match($('auditList').textContent, /لا يطابق|لا تتصل/);
});
