// The leasing screen in jsdom: the board lists real lease offers, the plot sheet can sign
// one, and the tenant's rent shows up in the portfolio with a working collect button.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSupabaseBackend } from '../../apps/ofuq/src/remote.js';
import { createMemoryStorage, createStore } from '../../apps/ofuq/src/store.js';
import { HOUR, createFakeSupabase } from '../support/fake-supabase.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const STORE_URL = 'https://demo.supabase.co';

let JSDOM = null;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  JSDOM = null;
}

function backendFor(fake) {
  return createSupabaseBackend({
    url: STORE_URL,
    publishableKey: 'sb_publishable_test',
    fetchImpl: fake.fetchImpl,
    storage: createMemoryStorage()
  });
}

async function boot(fake, { signedIn = true, email = 'tenant@example.com' } = {}) {
  const backend = backendFor(fake);
  if (signedIn) {
    const signed = await backend.signUp(email, 'secret123', 'مستأجر');
    assert.equal(signed.ok, true, signed.message);
  }

  const html = await readFile(path.join(ROOT, 'apps/ofuq/index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost:8000/apps/ofuq/', pretendToBeVisual: true });
  dom.window.scrollTo = () => {};
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });

  const { mount } = await import('../../apps/ofuq/src/ui.js');
  const store = createStore({ storage: createMemoryStorage(), now: () => fake.clock.now, remote: backend });
  const ui = mount(store);
  if (signedIn) await store.syncFromServer();

  return { dom, store, ui, backend, $: (id) => dom.window.document.getElementById(id) };
}

/** An owner with a developed studio, plus a live lease offer on it. */
async function listedLease(fake) {
  const lessor = backendFor(fake);
  await lessor.signUp('owner@example.com', 'secret123', 'مالك');
  const bought = await lessor.purchasePlot({ districtId: 'harbor', plotNo: 2, idempotencyKey: 'o-buy' });
  const plotId = bought.snapshot.plots[0].id;
  await lessor.developPlot({ plotId, assetId: 'studio', idempotencyKey: 'o-dev' });
  const listed = await lessor.listLease({ plotId, fee: 500, hours: 12, windowHours: 48, idempotencyKey: 'o-lease' });
  assert.equal(listed.ok, true, listed.message);
  return { lessor, plotId, offerId: listed.snapshot.offers[0].id };
}

test('the lease board shows real offers and hides itself behind an honest gate', { skip: !JSDOM && 'jsdom not installed' }, async (t) => {
  const fake = createFakeSupabase();
  const { offerId } = await listedLease(fake);

  const { store, ui, $, dom } = await boot(fake);
  t.after(() => {
    ui.destroy();
    dom.window.close();
  });

  assert.equal($('leaseGate').hidden, true, 'signed in, so no gate');
  assert.match($('leaseCount').textContent, /1 عرض/);
  const row = $('leaseList').querySelector('.market-row');
  assert.ok(row, 'the lease listing is rendered');
  assert.match(row.textContent, /استئجار بـ 500/);
  assert.match(row.textContent, /مدة العقد 12 ساعة/, 'the contract length is spelled out');
  assert.equal(row.querySelector('[data-action="accept-lease"]').dataset.offer, offerId);

  // The first tap only arms: money leaves the wallet, so it needs a second one.
  row.querySelector('[data-action="accept-lease"]').click();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match($('leaseList').textContent, /تأكيد الاستئجار بـ 500/);
  assert.equal(store.state.leases.length, 0, 'nothing was signed on the first tap');

  $('leaseList').querySelector('[data-action="accept-lease"]').click();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(store.state.leases.length, 1, 'the second tap signs the lease');
  assert.equal(store.state.leases[0].tenant, true);
  assert.equal(store.state.leases[0].rent, 34);

  // The portfolio card appears with the collectible amount.
  assert.equal($('leaseCard').hidden, false);
  assert.match($('myLeaseList').textContent, /مستأجرة من/);
  assert.match($('myLeaseCount').textContent, /1 عقد/);
});

test('local mode never invents a lease', { skip: !JSDOM && 'jsdom not installed' }, async (t) => {
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
  assert.equal($('leaseGate').hidden, false, 'the gate explains why the board is empty');
  assert.match($('leaseGate').textContent, /جلسة خادم/);
  assert.equal($('leaseList').textContent.trim(), '');
  assert.equal($('leaseCard').hidden, true, 'no lease card without a lease');

  // A developed plot shows the leasing form gated, with the honest economics of the rent.
  store.dispatch('buy', { districtId: 'harbor', plotNo: 4 });
  store.dispatch('develop', { plotKey: 'harbor:4', assetId: 'studio' });
  dom.window.document.querySelector('[data-plot="harbor:4"]')?.click();
  const sheet = $('sheet');
  if (sheet && !sheet.hidden) {
    assert.match(sheet.textContent, /تأجير دخل هذا الأصل يحتاج خادماً|انشر عرض الإيجار/);
  }
});

test('a tenant collects the rent from the portfolio card', { skip: !JSDOM && 'jsdom not installed' }, async (t) => {
  const fake = createFakeSupabase();
  const { offerId } = await listedLease(fake);
  const { store, ui, $, dom } = await boot(fake);
  t.after(() => {
    ui.destroy();
    dom.window.close();
  });

  const signed = await store.dispatch('acceptLease', { offerId });
  assert.equal(signed.ok, true, signed.message);
  assert.equal(store.state.cash, 12000 - 500);

  fake.clock.now += 2 * HOUR;
  store.refresh();
  assert.match($('myLeaseList').textContent, /68/, '2h × 34/h is shown as collectible');

  const collect = $('myLeaseList').querySelector('[data-action="collect-lease"]');
  assert.equal(collect.disabled, false);
  collect.click();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(store.state.cash, 12000 - 500 + 68, 'the rent landed in the tenant’s wallet');
  assert.equal(store.state.leases[0].lastCollectedAt, fake.clock.now);
});

test('the plot sheet signs a lease and shows the running contract', { skip: !JSDOM && 'jsdom not installed' }, async (t) => {
  const fake = createFakeSupabase();
  const lessor = backendFor(fake);
  await lessor.signUp('owner@example.com', 'secret123', 'مالك');
  const bought = await lessor.purchasePlot({ districtId: 'harbor', plotNo: 3, idempotencyKey: 'o-buy' });
  const plotId = bought.snapshot.plots[0].id;
  await lessor.developPlot({ plotId, assetId: 'studio', idempotencyKey: 'o-dev' });

  const { store, ui, $, dom } = await boot(fake, { email: 'owner@example.com' });
  t.after(() => {
    ui.destroy();
    dom.window.close();
  });

  assert.equal(store.state.plots['harbor:3'].id, plotId);
  dom.window.document.querySelector('[data-plot="harbor:3"]')?.click();
  const sheet = $('sheet');
  assert.ok(sheet && !sheet.hidden, 'the plot sheet opened');
  const feeInput = $('leaseFee');
  assert.ok(feeInput, 'the leasing form is rendered for a developed plot');
  assert.equal(feeInput.value, '490', 'the suggestion is a realistic share of 24h of rent');
  assert.match($('leaseNet').textContent, /صافي لك بعد العمولة: 470/);

  feeInput.value = '600';
  $('leaseHours').value = '24';
  $('sheet').querySelector('[data-action="list-lease"]').click();
  await new Promise((resolve) => setTimeout(resolve, 60));

  const listing = (store.state.offers ?? []).find((offer) => offer.kind === 'lease');
  assert.ok(listing, 'the lease listing was published');
  assert.equal(listing.fee, 600);
  assert.equal(listing.hours, 24);
  assert.match($('sheet').textContent, /معروض في السوق|انشر عرض الإيجار/);
});
