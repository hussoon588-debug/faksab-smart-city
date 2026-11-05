// The market tab is where two accounts meet. These tests drive the real DOM: one browser
// lists a plot, the other sees it on the board and buys it with a two-tap confirmation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSupabaseBackend } from '../../apps/ofuq/src/remote.js';
import { createMemoryStorage, createStore } from '../../apps/ofuq/src/store.js';
import { createFakeSupabase } from '../support/fake-supabase.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

let JSDOM = null;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  JSDOM = null;
}

const flush = async (rounds = 8) => {
  for (let index = 0; index < rounds; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

async function boot({ remote = false, fake = createFakeSupabase() } = {}) {
  const html = await readFile(path.join(ROOT, 'apps/ofuq/index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost:8000/apps/ofuq/', pretendToBeVisual: true });
  dom.window.scrollTo = () => {};
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};

  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });

  const { mount } = await import('../../apps/ofuq/src/ui.js');
  const backend = remote
    ? createSupabaseBackend({
        url: 'https://demo.supabase.co',
        publishableKey: 'sb_publishable_test',
        fetchImpl: fake.fetchImpl,
        storage: createMemoryStorage()
      })
    : null;
  const store = createStore({ storage: createMemoryStorage(), now: () => fake.clock.now, remote: backend });
  const ui = mount(store);
  const $ = (id) => dom.window.document.getElementById(id);
  const view = (name) => dom.window.document.querySelector(`[data-view="${name}"]`).click();
  return { dom, store, ui, fake, backend, $, view };
}

test('local mode refuses to invent a market', { skip: !JSDOM && 'jsdom not installed' }, async (t) => {
  const { dom, store, ui, $, view } = await boot();
  t.after(() => {
    ui.destroy();
    dom.window.close();
  });

  store.dispatch('buy', { districtId: 'harbor', plotNo: 1 });
  store.dispatch('develop', { plotKey: 'harbor:1', assetId: 'studio' });

  view('market');
  assert.equal($('marketGate').hidden, false, 'the gate explains why the board is empty');
  assert.match($('marketNote').textContent, /محلياً/);
  assert.equal($('marketList').children.length, 0);
  assert.equal($('marketCount').textContent, 'لا عروض');

  ui.openSheet('harbor:1');
  assert.equal($('sheetBody').querySelector('#offerPrice'), null, 'no price form without a server');
  assert.match($('sheetBody').textContent, /البيع الفوري/);

  // The gate button must actually open the account panel instead of doing nothing.
  dom.window.document.querySelector('[data-action="open-account"]').click();
  assert.equal($('settings').hidden, false);
});

test('signed out, the board asks for a session before anything else', { skip: !JSDOM && 'jsdom not installed' }, async (t) => {
  const { dom, ui, $, view } = await boot({ remote: true });
  t.after(() => {
    ui.destroy();
    dom.window.close();
  });

  view('market');
  assert.equal($('marketGate').hidden, false);
  assert.match($('marketNote').textContent, /سجّل الدخول/);
  assert.equal($('marketList').children.length, 0);
});

test('a seller lists from the plot sheet and sees it on the board', { skip: !JSDOM && 'jsdom not installed' }, async (t) => {
  const { dom, store, ui, fake, $, view } = await boot({ remote: true });
  t.after(() => {
    ui.destroy();
    dom.window.close();
  });

  await store.auth.signUp('seller@example.com', 'secret123', 'بائع');
  await flush();
  await store.dispatch('buy', { districtId: 'harbor', plotNo: 2 });
  await store.dispatch('develop', { plotKey: 'harbor:2', assetId: 'studio' });
  await flush();

  ui.openSheet('harbor:2');
  const input = $('sheetBody').querySelector('#offerPrice');
  assert.ok(input, 'a signed-in owner gets the price form');
  assert.equal(Number(input.value), 1660, 'the default price is the book value');

  input.value = '4000';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.match($('offerNet').textContent, /3,840/, 'the net after the 4% fee is shown before publishing');

  $('sheetBody').querySelector('[data-action="list-offer"]').click();
  await flush();

  view('market');
  const rows = $('marketList').querySelectorAll('.market-row');
  assert.equal(rows.length, 1);
  assert.match(rows[0].textContent, /عرضك/);
  assert.match(rows[0].textContent, /4,000/);
  assert.equal($('marketGate').hidden, true);
  assert.match($('marketCount').textContent, /1 عرض/);

  // The sheet now reports the live offer instead of offering a second one.
  ui.openSheet('harbor:2');
  assert.equal($('sheetBody').querySelector('#offerPrice'), null);
  assert.match($('sheetBody').textContent, /معروض في السوق/);
  assert.match($('sheetBody').textContent, /3,840/, 'net to the seller is stated');
});

test('a buyer sees the offer, confirms in two taps, and owns the building', { skip: !JSDOM && 'jsdom not installed' }, async (t) => {
  const fake = createFakeSupabase();

  // --- seller ---------------------------------------------------------------
  const seller = await boot({ remote: true, fake });
  await seller.store.auth.signUp('seller@example.com', 'secret123', 'بائع');
  await flush();
  await seller.store.dispatch('buy', { districtId: 'harbor', plotNo: 3 });
  await seller.store.dispatch('develop', { plotKey: 'harbor:3', assetId: 'studio' });
  await seller.ui.openSheet('harbor:3');
  seller.$('sheetBody').querySelector('#offerPrice').value = '2500';
  seller.$('sheetBody').querySelector('[data-action="list-offer"]').click();
  await flush();
  assert.equal(seller.store.state.offers.length, 1);
  seller.ui.destroy();
  seller.dom.window.close();

  // --- buyer ----------------------------------------------------------------
  const buyer = await boot({ remote: true, fake });
  t.after(() => {
    buyer.ui.destroy();
    buyer.dom.window.close();
  });

  await buyer.store.auth.signUp('buyer@example.com', 'secret123', 'مشتر');
  await flush();
  buyer.view('market');

  const row = buyer.$('marketList').querySelector('.market-row');
  assert.ok(row, 'the buyer sees the seller’s plot');
  assert.doesNotMatch(row.textContent, /عرضك/);
  assert.match(row.textContent, /2,500/);

  const button = () => buyer.$('marketList').querySelector('[data-action="accept-offer"]');
  button().click();
  await flush();
  assert.equal(buyer.store.state.offers.length, 1, 'the first tap only arms the button');
  assert.match(button().textContent, /تأكيد الشراء/);

  button().click();
  await flush();

  assert.equal(buyer.store.state.offers.length, 0, 'the board is empty again');
  assert.equal(buyer.store.state.cash, 12000 - 2500);
  assert.equal(buyer.store.state.plots['harbor:3']?.assetId, 'studio', 'the building came with the plot');
  assert.equal(buyer.store.state.ledger[0].reason, 'plot_purchase');
  assert.match(buyer.$('marketEmpty').textContent, /لا توجد عروض/);
  assert.equal(buyer.$('marketEmpty').hidden, false);

  // The seller's side of the same trade: full credit, then the fee as its own row.
  const sellerBackend = createSupabaseBackend({
    url: 'https://demo.supabase.co',
    publishableKey: 'sb_publishable_test',
    fetchImpl: fake.fetchImpl,
    storage: createMemoryStorage()
  });
  await sellerBackend.signIn('seller@example.com', 'secret123');
  const after = await sellerBackend.snapshot();
  assert.deepEqual(
    after.snapshot.ledger.slice(0, 2).map((row) => [row.reason, row.amount]),
    [
      ['market_fee', -100],
      ['sale', 2500]
    ]
  );
  assert.equal(after.snapshot.balance, 12000 - 400 - 1400 + 2500 - 100);
  assert.equal(after.snapshot.plots.length, 0, 'the plot left the seller');
});

test('cancelling from the board returns the plot to the wallet', { skip: !JSDOM && 'jsdom not installed' }, async (t) => {
  const { dom, store, ui, $, view } = await boot({ remote: true });
  t.after(() => {
    ui.destroy();
    dom.window.close();
  });

  await store.auth.signUp('seller@example.com', 'secret123', 'بائع');
  await flush();
  await store.dispatch('buy', { districtId: 'garden', plotNo: 4 });
  await store.dispatch('develop', { plotKey: 'garden:4', assetId: 'studio' });
  await flush();

  ui.openSheet('garden:4');
  $('sheetBody').querySelector('#offerPrice').value = '3000';
  $('sheetBody').querySelector('[data-action="list-offer"]').click();
  await flush();

  view('market');
  $('marketList').querySelector('[data-action="cancel-offer"]').click();
  await flush();

  assert.equal(store.state.offers.length, 0);
  assert.ok(store.state.plots['garden:4'], 'the plot never left the wallet');
  assert.equal($('marketEmpty').hidden, false);
});
