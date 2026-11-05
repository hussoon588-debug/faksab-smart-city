// The readiness card and the CSV export are the two places where the app can be *checked*
// rather than trusted: every 'ok' is a measured fact, and the export is the ledger itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildLedgerCsv, serverReadiness } from '../../apps/ofuq/src/core.js';
import { createSupabaseBackend } from '../../apps/ofuq/src/remote.js';
import { createMemoryStorage, createStore } from '../../apps/ofuq/src/store.js';
import { createFakeSupabase } from '../support/fake-supabase.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const STORE_URL = 'https://demo.supabase.co';

let JSDOM = null;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  JSDOM = null;
}

/* --------------------------------------------------------------------- csv --- */

test('the export is the ledger, row for row, with Arabic headers and a BOM', () => {
  const entries = [
    { ts: Date.UTC(2026, 10, 5, 12), reason: 'rent', amount: 102, balanceAfter: 11102, ref: 'harbor:1' },
    { ts: Date.UTC(2026, 10, 4, 9), reason: 'market_fee', amount: -24, balanceAfter: 11000, ref: null },
    { ts: Date.UTC(2026, 10, 3, 9), reason: 'lease_income', amount: 600, balanceAfter: 11024, ref: 'a,"b"' }
  ];

  const csv = buildLedgerCsv(entries);
  assert.ok(csv.startsWith('\ufeff'), 'Excel needs the BOM to read Arabic headers');
  const lines = csv.replace(/^\ufeff/, '').trimEnd().split('\r\n');
  assert.equal(lines.length, entries.length + 1, 'a header plus one line per movement');
  assert.equal(lines[0], 'التاريخ,السبب,البيان,المبلغ,الرصيد بعد,المرجع');
  assert.equal(lines[1], '2026-11-05T12:00:00.000Z,rent,إيجار محصّل,102,11102,harbor:1');
  assert.match(lines[2], /market_fee,عمولة سوق,-24,11000,/);
  assert.match(lines[3], /"a,""b"""/, 'quotes and commas are escaped, not mangled');
  assert.equal(buildLedgerCsv([]).replace(/^\ufeff/, '').trimEnd().split('\r\n').length, 1);
  assert.equal(buildLedgerCsv(entries, { withBom: false }).startsWith('\ufeff'), false);
});

/* --------------------------------------------------------------- readiness --- */

test('readiness reports what it can measure, and says what to do about the rest', () => {
  const local = serverReadiness({ mode: 'local' }, Date.UTC(2026, 10, 5, 12));
  assert.equal(local.total, 6);
  assert.equal(local.ready, false);
  assert.equal(local.items.find((item) => item.id === 'endpoint').ok, false);
  assert.match(local.items.find((item) => item.id === 'endpoint').hint, /SUPABASE_URL/);
  assert.match(local.items.find((item) => item.id === 'schema').hint, /schema\.sql/);
  assert.equal(local.items.find((item) => item.id === 'ledger').ok, true, 'an untouched wallet reconciles');

  const now = Date.UTC(2026, 10, 5, 12);
  const ready = serverReadiness(
    {
      mode: 'supabase',
      hasEndpoint: true,
      signedIn: true,
      syncedAt: now - 60_000,
      lastError: null,
      reconciles: true,
      roundTripMs: 42
    },
    now
  );
  assert.equal(ready.ready, true);
  assert.equal(ready.done, ready.total);
  assert.equal(ready.roundTripMs, 42);

  const stale = serverReadiness(
    { mode: 'supabase', hasEndpoint: true, signedIn: true, syncedAt: now - 20 * 60_000, roundTripMs: 30 },
    now
  );
  assert.equal(stale.items.find((item) => item.id === 'sync').ok, false, 'a stale snapshot is not a sync');
  assert.equal(stale.ready, false);

  const broken = serverReadiness(
    { mode: 'supabase', hasEndpoint: true, signedIn: false, lastError: 'السيولة غير كافية', reconciles: false },
    now
  );
  const errors = broken.items.find((item) => item.id === 'errors');
  assert.equal(errors.ok, false);
  assert.match(errors.hint, /السيولة غير كافية/, 'the last error is shown verbatim');
  assert.equal(broken.items.find((item) => item.id === 'session').ok, false);
});

test('the store records the facts the card shows rather than assuming them', async () => {
  const fake = createFakeSupabase();
  const backend = createSupabaseBackend({
    url: STORE_URL,
    publishableKey: 'sb_publishable_test',
    fetchImpl: fake.fetchImpl,
    storage: createMemoryStorage()
  });
  const signed = await backend.signUp('player@example.com', 'secret123', 'لاعب');
  assert.equal(signed.ok, true, signed.message);

  const store = createStore({ storage: createMemoryStorage(), now: () => fake.clock.now, remote: backend });
  assert.deepEqual(store.health, { lastSyncAt: 0, lastError: null, roundTripMs: null }, 'nothing measured yet');

  const synced = await store.checkServer();
  assert.equal(synced.ok, true, synced.message);
  assert.equal(store.health.lastSyncAt, fake.clock.now);
  assert.equal(store.health.lastError, null);
  assert.equal(typeof store.health.roundTripMs, 'number');

  const broken = createSupabaseBackend({
    url: STORE_URL,
    publishableKey: 'sb_publishable_test',
    fetchImpl: async () => {
      throw new Error('الشبكة غير متاحة');
    },
    storage: createMemoryStorage()
  });
  const offline = createStore({ storage: createMemoryStorage(), remote: broken });
  const failed = await offline.checkServer();
  assert.equal(failed.ok, false);
  assert.ok(offline.health.lastError, 'a failure is recorded, not swallowed');
  assert.equal(offline.health.roundTripMs, null);
});

/* ---------------------------------------------------------------------- ui --- */

async function bootUI({ fake = null, email = 'player@example.com' } = {}) {
  const html = await readFile(path.join(ROOT, 'apps/ofuq/index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost:8000/apps/ofuq/', pretendToBeVisual: true });
  dom.window.scrollTo = () => {};
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};

  let downloaded = null;
  dom.window.URL.createObjectURL = (blob) => {
    downloaded = blob;
    return 'blob:ofuq';
  };
  dom.window.URL.revokeObjectURL = () => {};
  const clicks = [];
  dom.window.HTMLAnchorElement.prototype.click = function click() {
    clicks.push(this.download);
  };

  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });

  const { mount } = await import('../../apps/ofuq/src/ui.js');
  let store;
  if (fake) {
    const backend = createSupabaseBackend({
      url: STORE_URL,
      publishableKey: 'sb_publishable_test',
      fetchImpl: fake.fetchImpl,
      storage: createMemoryStorage()
    });
    await backend.signUp(email, 'secret123', 'لاعب');
    store = createStore({ storage: createMemoryStorage(), now: () => fake.clock.now, remote: backend });
  } else {
    store = createStore({ storage: createMemoryStorage() });
  }
  const ui = mount(store);
  return { dom, store, ui, $: (id) => dom.window.document.getElementById(id), getDownloaded: () => downloaded, clicks };
}

test('the readiness card lists six measured items and disables the check without a server', { skip: !JSDOM && 'jsdom not installed' }, async (t) => {
  const { dom, ui, $ } = await bootUI();
  t.after(() => {
    ui.destroy();
    dom.window.close();
  });

  assert.equal($('healthList').querySelectorAll('.health-row').length, 6);
  assert.match($('healthState').textContent, /محلي على هذا الجهاز/);
  assert.equal($('healthCheck').disabled, true, 'no server, no round trip to offer');
  assert.equal($('healthList').querySelectorAll('.health-row.is-ok').length >= 1, true);
});

test('the check button performs a real round trip and updates the card', { skip: !JSDOM && 'jsdom not installed' }, async (t) => {
  const fake = createFakeSupabase();
  const { dom, store, ui, $ } = await bootUI({ fake });
  t.after(() => {
    ui.destroy();
    dom.window.close();
  });

  assert.equal($('healthCheck').disabled, false);
  assert.match($('healthState').textContent, /demo\.supabase\.co/, 'the endpoint is named without the key');

  $('healthCheck').click();
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.equal(store.health.lastError, null);
  assert.ok(store.health.lastSyncAt > 0, 'the round trip stamped a sync');
  assert.match($('healthState').textContent, /ms/);
  assert.equal($('healthList').querySelectorAll('.health-row.is-ok').length >= 5, true, 'the server path checks out');
});

test('the export button writes the ledger to a file, not a summary of it', { skip: !JSDOM && 'jsdom not installed' }, async (t) => {
  const { dom, store, ui, $, clicks } = await bootUI();
  t.after(() => {
    ui.destroy();
    dom.window.close();
  });

  store.dispatch('buy', { districtId: 'harbor', plotNo: 1 });
  store.dispatch('develop', { plotKey: 'harbor:1', assetId: 'studio' });

  $('exportCsv').click();
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(clicks.length, 1, 'a download was triggered');
  assert.match(clicks[0], /^ofuq-ledger-\d{4}-\d{2}-\d{2}\.csv$/);
  assert.match($('toast').textContent, /تم تصدير/, 'and the player is told what happened');
});
