// The wallet screen is the promise that nothing on it is invented: every row is a movement
// the player made, and the rows must reconcile with the balance in the header.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSupabaseBackend } from '../../apps/ofuq/src/remote.js';
import { createMemoryStorage, createStore } from '../../apps/ofuq/src/store.js';
import { createFakeSupabase } from '../support/fake-supabase.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const HOUR = 60 * 60 * 1000;

let JSDOM = null;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  JSDOM = null;
}

async function boot({ remote = false } = {}) {
  const html = await readFile(path.join(ROOT, 'apps/ofuq/index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost:8000/apps/ofuq/', pretendToBeVisual: true });
  dom.window.scrollTo = () => {};
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};

  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });

  const { mount } = await import('../../apps/ofuq/src/ui.js');
  const fake = createFakeSupabase();
  const clock = fake.clock; // the store and the fake server must share one clock
  const backend = remote
    ? createSupabaseBackend({
        url: 'https://demo.supabase.co',
        publishableKey: 'sb_publishable_test',
        fetchImpl: fake.fetchImpl,
        storage: createMemoryStorage()
      })
    : null;
  const store = createStore({ storage: createMemoryStorage(), now: () => clock.now, remote: backend });
  const ui = mount(store);
  const $ = (id) => dom.window.document.getElementById(id);
  return { dom, store, ui, fake, clock, $ };
}

const rows = ($) => [...$('ledgerList').querySelectorAll('.ledger-row')];

test('a fresh wallet shows one row and proves itself', { skip: !JSDOM && 'jsdom not installed' }, async (t) => {
  const { dom, ui, $ } = await boot();
  t.after(() => {
    ui.destroy();
    dom.window.close();
  });

  const list = rows($);
  assert.equal(list.length, 1);
  assert.match(list[0].textContent, /رصيد البداية/);
  assert.match(list[0].textContent, /\+12,000/);
  assert.match($('ledgerList').textContent, /مطابق للسجل/);
  assert.equal($('ledgerEmpty').hidden, true);
});

test('the wallet records a session and the filters tell the truth', { skip: !JSDOM && 'jsdom not installed' }, async (t) => {
  const { dom, store, ui, clock, $ } = await boot();
  t.after(() => {
    ui.destroy();
    dom.window.close();
  });

  store.dispatch('buy', { districtId: 'harbor', plotNo: 3 });
  store.dispatch('develop', { plotKey: 'harbor:3', assetId: 'studio' });
  clock.now += 3 * HOUR;
  store.dispatch('collect', { plotKey: 'harbor:3' });

  const all = rows($);
  assert.equal(all.length, 4, 'bonus + buy + develop + rent');
  assert.match($('ledgerList').textContent, /مطابق للسجل/);
  assert.match($('ledgerState').textContent, /\+12\.1K/);

  const click = (filter) => dom.window.document.querySelector(`[data-ledger="${filter}"]`).click();

  click('out');
  const out = rows($);
  assert.deepEqual(out.map((row) => row.textContent.includes('−')), [true, true]);
  assert.equal(out.length, 2, 'purchase and works are the only outflows');

  click('in');
  const inflow = rows($);
  assert.equal(inflow.length, 2, 'bonus and rent are the inflows');
  assert.ok(inflow.every((row) => row.textContent.includes('+')));

  click('rent');
  const rent = rows($);
  assert.equal(rent.length, 1);
  assert.match(rent[0].textContent, /إيجار محصّل/);
  assert.match(rent[0].textContent, /حي الميناء/);

  click('all');
  assert.equal(rows($).length, 4);
});

test('the plot sheet lists that plot’s own history', { skip: !JSDOM && 'jsdom not installed' }, async (t) => {
  const { dom, store, ui, clock, $ } = await boot();
  t.after(() => {
    ui.destroy();
    dom.window.close();
  });

  store.dispatch('buy', { districtId: 'garden', plotNo: 7 });
  store.dispatch('develop', { plotKey: 'garden:7', assetId: 'studio' });
  clock.now += 2 * HOUR;
  store.dispatch('collect', { plotKey: 'garden:7' });

  ui.openSheet('garden:7');
  const history = $('sheetBody').querySelector('.sheet-history');
  assert.ok(history, 'the sheet carries a history block');
  assert.match(history.textContent, /سجل هذه القطعة/);
  assert.match(history.textContent, /تحصيل|إيجار محصّل/);
  assert.match(history.textContent, /تطوير أصل/);
  assert.match(history.textContent, /شراء قطعة/);

  // A plot with no movements has no block at all — no empty decoration.
  ui.openSheet('harbor:12');
  assert.equal($('sheetBody').querySelector('.sheet-history'), null);
});

test('server mode renders the server ledger, not a local guess', { skip: !JSDOM && 'jsdom not installed' }, async (t) => {
  const { dom, store, ui, clock, $ } = await boot({ remote: true });
  t.after(() => {
    ui.destroy();
    dom.window.close();
  });

  await store.auth.signUp('nawaf@example.com', 'secret123', 'نواف');
  await store.dispatch('buy', { districtId: 'harbor', plotNo: 1 });
  await store.dispatch('develop', { plotKey: 'harbor:1', assetId: 'studio' });
  clock.now += 2 * HOUR;
  await store.dispatch('collect', { plotKey: 'harbor:1' });

  const list = rows($);
  assert.equal(list.length, 3, 'buy + develop + rent, straight from the server snapshot');
  assert.match(list[0].textContent, /إيجار محصّل/);
  assert.match($('ledgerList').textContent, /مطابق للسجل/);
  assert.equal(store.state.ledger[0].balanceAfter, store.state.cash);
});
