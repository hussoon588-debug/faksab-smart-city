// The account panel is the only door into the shared city, so it is tested the way a player
// meets it: the real index.html, the real ui.js, a store wired to the in-memory fake server.
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

const flush = async (rounds = 6) => {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

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
  const backend = remote
    ? createSupabaseBackend({
        url: 'https://demo.supabase.co',
        publishableKey: 'sb_publishable_test',
        fetchImpl: fake.fetchImpl,
        storage: createMemoryStorage()
      })
    : null;

  const store = createStore({
    storage: createMemoryStorage(),
    now: () => fake.clock.now,
    remote: backend
  });
  const ui = mount(store);
  const $ = (id) => dom.window.document.getElementById(id);
  return { dom, store, ui, fake, backend, $ };
}

test('the account panel never offers a door that cannot open', { skip: !JSDOM && 'jsdom not installed' }, async (t) => {
  const { dom, store, ui, $ } = await boot();
  t.after(() => {
    ui.destroy();
    dom.window.close();
  });

  assert.equal(store.mode, 'local');
  assert.equal(store.auth.available, false);
  assert.equal($('authForm').hidden, true, 'no login form without a server');
  assert.equal($('accountSession').hidden, true);
  assert.match($('accountState').textContent, /تعمل محلياً/);
  assert.equal($('syncState').textContent, 'محلي على هذا الجهاز');
  assert.equal($('resetGame').disabled, false, 'a local wallet can still be reset');

  const reset = store.dispatch('reset');
  assert.equal(reset.ok, true);
  const refused = await store.auth.signIn('a@b.co', 'secret123');
  assert.equal(refused.ok, false);
  assert.match(refused.message, /لا يوجد خادم/);
});

test('server mode asks for a session and states it is not connected yet', { skip: !JSDOM && 'jsdom not installed' }, async (t) => {
  const { dom, store, ui, $ } = await boot({ remote: true });
  t.after(() => {
    ui.destroy();
    dom.window.close();
  });

  assert.equal(store.mode, 'supabase');
  assert.equal(store.auth.signedIn, false);
  assert.equal($('authForm').hidden, false, 'the form is the only way in');
  assert.equal($('accountSession').hidden, true);
  assert.match($('accountState').textContent, /سجّل الدخول/);
  assert.equal($('syncState').textContent, 'خادم — بلا جلسة');
  assert.match($('cityMode').textContent, /بحاجة لتسجيل الدخول/);

  // Nothing may be written before a session exists, and the message says exactly that.
  const refused = await store.dispatch('buy', { districtId: 'harbor', plotNo: 1 });
  assert.equal(refused.ok, false);
  assert.match(refused.message, /سجّل الدخول/);
  assert.equal(store.state.plots['harbor:1'], undefined, 'a refused write leaves no trace');
});

test('bad credentials are reported in Arabic and leave the wallet untouched', { skip: !JSDOM && 'jsdom not installed' }, async (t) => {
  const { dom, store, ui, $ } = await boot({ remote: true });
  t.after(() => {
    ui.destroy();
    dom.window.close();
  });

  await store.auth.signUp('nawaf@example.com', 'secret123', 'نواف');
  await store.auth.signOut();
  assert.equal(store.auth.signedIn, false);

  $('authEmail').value = 'nawaf@example.com';
  $('authPassword').value = 'wrong-password';
  $('authSignIn').click();
  await flush();

  assert.equal(store.auth.signedIn, false);
  assert.equal($('authForm').hidden, false);
  assert.match($('toast').textContent, /Invalid login credentials/);
  assert.equal(store.state.cash, 12000, 'no phantom balance change');
});

test('the form validates before it reaches the network', { skip: !JSDOM && 'jsdom not installed' }, async (t) => {
  const { dom, store, ui, $ } = await boot({ remote: true });
  t.after(() => {
    ui.destroy();
    dom.window.close();
  });

  $('authEmail').value = 'not-an-email';
  $('authPassword').value = 'secret123';
  $('authSignIn').click();
  await flush();
  assert.match($('toast').textContent, /بريداً إلكترونياً صحيحاً/);

  $('authEmail').value = 'nawaf@example.com';
  $('authPassword').value = '123';
  $('authSignIn').click();
  await flush();
  assert.match($('toast').textContent, /٦ أحرف/);
  assert.equal(store.auth.signedIn, false);
});

test('signing in adopts the server snapshot and unlocks writing', { skip: !JSDOM && 'jsdom not installed' }, async (t) => {
  const { dom, store, ui, $ } = await boot({ remote: true });
  t.after(() => {
    ui.destroy();
    dom.window.close();
  });

  await store.auth.signUp('nawaf@example.com', 'secret123', 'نواف');
  await store.auth.signOut();
  await flush();

  $('authEmail').value = 'nawaf@example.com';
  $('authPassword').value = 'secret123';
  $('authSignIn').click();
  await flush();

  assert.equal(store.auth.signedIn, true);
  assert.equal(store.auth.email, 'nawaf@example.com');
  assert.equal($('authForm').hidden, true);
  assert.equal($('accountSession').hidden, false);
  assert.equal($('accountEmail').textContent, 'nawaf@example.com');
  assert.equal($('syncState').textContent, 'خادم مشترك');
  assert.match($('cityMode').textContent, /مدينة مشتركة/);
  assert.equal($('resetGame').disabled, true, 'a shared wallet cannot be wiped from the device');
  assert.match($('resetGame').textContent, /المدينة المشتركة/);

  // The server is the truth: a purchase debits its wallet, not the local simulation.
  const bought = await store.dispatch('buy', { districtId: 'harbor', plotNo: 1 });
  assert.equal(bought.ok, true, bought.message);
  assert.equal(store.state.cash, 11600);
  assert.ok(store.state.plots['harbor:1'].id, 'the server id is kept for later calls');

  // Server mode answers with a promise: the same dispatch is async, never fire-and-forget.
  const guarded = await store.dispatch('reset');
  assert.equal(guarded.ok, false);
  assert.match(guarded.message, /لا يمكن حذف التقدم/);
  assert.equal(store.state.cash, 11600, 'the mirror is untouched by a refused reset');
});

test('signing out closes the door without pretending the wallet is local', { skip: !JSDOM && 'jsdom not installed' }, async (t) => {
  const { dom, store, ui, $ } = await boot({ remote: true });
  t.after(() => {
    ui.destroy();
    dom.window.close();
  });

  await store.auth.signUp('nawaf@example.com', 'secret123', 'نواف');
  await flush();
  assert.equal(store.auth.signedIn, true);

  const out = await store.auth.signOut();
  assert.equal(out.ok, true);
  await flush();

  assert.equal(store.auth.signedIn, false);
  assert.equal($('authForm').hidden, false);
  assert.equal($('accountSession').hidden, true);
  assert.match($('cityMode').textContent, /بحاجة لتسجيل الدخول/);

  const refused = await store.dispatch('buy', { districtId: 'garden', plotNo: 2 });
  assert.equal(refused.ok, false);
  assert.match(refused.message, /سجّل الدخول/);
});

test('a stored session is restored on boot without asking again', { skip: !JSDOM && 'jsdom not installed' }, async (t) => {
  const { dom, store, ui, backend, $ } = await boot({ remote: true });
  t.after(() => {
    ui.destroy();
    dom.window.close();
  });

  await backend.signUp('returning@example.com', 'secret123', 'عائد');
  await backend.purchasePlot({ districtId: 'harbor', plotNo: 4, idempotencyKey: 'seed-1' });
  await flush();

  const restored = await store.auth.restore();
  assert.equal(restored.ok, true, restored.message);
  await flush();

  assert.equal(store.auth.signedIn, true);
  assert.equal(store.auth.email, 'returning@example.com');
  assert.equal(store.state.plots['harbor:4']?.districtId, 'harbor', 'the server city arrived with the session');
  assert.equal(store.state.cash, 11600);
  assert.equal($('accountSession').hidden, false);
});
