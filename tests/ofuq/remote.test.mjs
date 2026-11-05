// Contract tests for the server-authoritative adapter.
//
// `createFakeSupabase` implements the same RPC contract as supabase/ofuq/schema.sql
// (auth, balance, ownership, idempotency, rent accrual). It lets the client adapter and
// the store's server mode be exercised end to end without a live project.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIdempotencyKey, createSupabaseBackend, describeError, snapshotToState } from '../../apps/ofuq/src/remote.js';
import { createMemoryStorage, createStore } from '../../apps/ofuq/src/store.js';

import { HOUR, createFakeSupabase, json, rentOf } from '../support/fake-supabase.mjs';


async function signedInBackend(fake, options = {}) {
  const backend = createSupabaseBackend({
    url: 'https://demo.supabase.co',
    publishableKey: 'sb_publishable_test',
    fetchImpl: fake.fetchImpl,
    storage: createMemoryStorage(),
    ...options
  });
  // sign-up is also the sign-in in this contract (the RPC surface needs a JWT).
  const created = await backend.signUp('nawaf@example.com', 'secret123', 'نواف');
  if (!created.ok) throw new Error(`fixture sign-up failed: ${created.message}`);
  return backend;
}

/* ------------------------------------------------------------------- auth --- */

test('sign-in stores a session and snapshot requires authentication', async () => {
  const fake = createFakeSupabase();
  const anonymous = createSupabaseBackend({
    url: 'https://demo.supabase.co',
    publishableKey: 'k',
    fetchImpl: fake.fetchImpl,
    storage: createMemoryStorage()
  });
  const denied = await anonymous.snapshot();
  assert.equal(denied.ok, false);
  assert.match(denied.message, /سجّل الدخول/);

  const backend = await signedInBackend(fake);
  assert.equal(backend.signedIn, true);
  const snapshot = await backend.snapshot();
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.snapshot.balance, 12000);
});

test('bad credentials surface a readable message instead of throwing', async () => {
  const fake = createFakeSupabase();
  const backend = createSupabaseBackend({
    url: 'https://demo.supabase.co',
    publishableKey: 'k',
    fetchImpl: fake.fetchImpl,
    storage: createMemoryStorage()
  });
  await backend.signUp('known@example.com', 'secret123', 'معروف');

  const result = await backend.signIn('known@example.com', 'wrong');
  assert.equal(result.ok, false);
  assert.match(result.message, /Invalid login credentials/);

  const ok = await backend.signIn('known@example.com', 'secret123');
  assert.equal(ok.ok, true);
});

/* --------------------------------------------------------------- purchase --- */

test('purchase debits once even when the same idempotency key is retried', async () => {
  const fake = createFakeSupabase();
  const backend = await signedInBackend(fake);

  const key = createIdempotencyKey('purchase');
  const first = await backend.purchasePlot({ districtId: 'harbor', plotNo: 1, idempotencyKey: key });
  assert.equal(first.ok, true);
  assert.equal(first.snapshot.balance, 11600);

  const retry = await backend.purchasePlot({ districtId: 'harbor', plotNo: 1, idempotencyKey: key });
  assert.equal(retry.ok, true, 'a retried request is not an error');
  assert.equal(retry.snapshot.balance, 11600, 'but it must not debit twice');
  assert.equal(fake.accounts.get('nawaf@example.com').balance, 11600);
});

test('server rules reject owned plots, locked districts and overdrafts', async () => {
  const fake = createFakeSupabase();
  const backend = await signedInBackend(fake);

  await backend.purchasePlot({ districtId: 'harbor', plotNo: 2, idempotencyKey: createIdempotencyKey('p') });
  const owned = await backend.purchasePlot({ districtId: 'harbor', plotNo: 2, idempotencyKey: createIdempotencyKey('p') });
  assert.equal(owned.ok, false);
  assert.match(owned.message, /مملوكة بالفعل/);

  const locked = await backend.purchasePlot({ districtId: 'downtown', plotNo: 1, idempotencyKey: createIdempotencyKey('p') });
  assert.equal(locked.ok, false);
  assert.match(locked.message, /المستوى 2/);

  // Drain the wallet through the same RPC surface, then attempt one more purchase.
  const account = fake.accounts.get('nawaf@example.com');
  account.balance = 100;
  const overdraft = await backend.purchasePlot({ districtId: 'harbor', plotNo: 3, idempotencyKey: createIdempotencyKey('p') });
  assert.equal(overdraft.ok, false);
  assert.match(overdraft.message, /السيولة غير كافية/);
  assert.equal(account.balance, 100, 'a rejected purchase leaves the balance untouched');
});

/* ---------------------------------------------------------- game economy --- */

test('develop, upgrade, collect and sell follow the server-side economics', async () => {
  const fake = createFakeSupabase();
  const backend = await signedInBackend(fake);

  await backend.purchasePlot({ districtId: 'harbor', plotNo: 1, idempotencyKey: createIdempotencyKey('p') });
  const bought = await backend.snapshot();
  const plotId = bought.snapshot.plots[0].id;

  const developed = await backend.developPlot({ plotId, assetId: 'studio', idempotencyKey: createIdempotencyKey('d') });
  assert.equal(developed.ok, true);
  assert.equal(developed.snapshot.balance, 11600 - 1400);
  assert.equal(developed.snapshot.plots[0].level, 1);

  const gated = await backend.developPlot({ plotId, assetId: 'office', idempotencyKey: createIdempotencyKey('d') });
  assert.equal(gated.ok, false, 'a developed plot cannot be redeveloped');

  const upgraded = await backend.upgradePlot({ plotId, idempotencyKey: createIdempotencyKey('u') });
  assert.equal(upgraded.ok, true, `upgrade failed: ${upgraded.message}`);
  assert.equal(upgraded.snapshot.plots[0].level, 2);

  fake.clock.now += 3 * HOUR;
  const collected = await backend.collectRent({ plotId, idempotencyKey: createIdempotencyKey('c') });
  assert.equal(collected.ok, true);
  const expectedRent = 3 * rentOf('studio', 2, 1);
  assert.equal(collected.snapshot.balance, upgraded.snapshot.balance + expectedRent);

  const sold = await backend.sellPlot({ plotId, idempotencyKey: createIdempotencyKey('s') });
  assert.equal(sold.ok, true);
  assert.equal(sold.snapshot.plots.length, 0);
  assert.ok(sold.snapshot.balance > collected.snapshot.balance);
});

test('mission claims are refused twice and gated by real progress', async () => {
  const fake = createFakeSupabase();
  const backend = await signedInBackend(fake);

  const early = await backend.claimMission({ missionId: 'own4', idempotencyKey: createIdempotencyKey('m') });
  assert.equal(early.ok, false);
  assert.match(early.message, /لم يكتمل/);

  for (let no = 1; no <= 4; no += 1) {
    await backend.purchasePlot({ districtId: 'harbor', plotNo: no, idempotencyKey: createIdempotencyKey('p') });
  }
  const claim = await backend.claimMission({ missionId: 'own4', idempotencyKey: createIdempotencyKey('m') });
  assert.equal(claim.ok, true);

  const again = await backend.claimMission({ missionId: 'own4', idempotencyKey: createIdempotencyKey('m') });
  assert.equal(again.ok, false);
  assert.match(again.message, /استلمت مكافأة/);
});

/* ------------------------------------------------------------ error paths --- */

test('transport errors are mapped to player-safe Arabic messages', async () => {
  assert.match(describeError(401, {}), /انتهت الجلسة/);
  assert.match(describeError(500, {}), /غير متاحة/);
  assert.match(describeError(429, {}), /محاولات كثيرة/);
  assert.equal(describeError(400, { message: 'P0001: السيولة غير كافية' }), 'السيولة غير كافية');

  const fake = createFakeSupabase();
  // Auth keeps working; only the game RPCs fail, which is the case a player actually hits.
  const backend = await signedInBackend(fake, {
    fetchImpl: async (url, init) =>
      String(url).includes('/rest/v1/rpc/') ? json({ message: 'upstream down' }, 500) : fake.fetchImpl(url, init)
  });
  const result = await backend.purchasePlot({ districtId: 'harbor', plotNo: 1, idempotencyKey: 'k1' });
  assert.equal(result.ok, false);
  assert.match(result.message, /غير متاحة/, 'a 5xx must never look like a successful purchase');
});

/* ------------------------------------------------------------------ store --- */

test('snapshotToState maps the authoritative snapshot without inventing data', () => {
  const state = snapshotToState({
    player: { name: 'نواف', xp: 950 },
    balance: 4300,
    week: '2026-W45',
    plots: [{ id: 'p1', districtId: 'harbor', plotNo: 7, assetId: 'studio', level: 2, purchasedAt: '2026-11-04T10:00:00Z', lastCollectedAt: '2026-11-05T09:00:00Z', rent: 46, value: 1660 }],
    weekly: { bought: 2, developed: 1, upgraded: 1, collected: 3 },
    claims: ['develop3']
  });
  assert.equal(state.cash, 4300);
  assert.equal(state.xp, 950);
  assert.equal(state.plots['harbor:7'].level, 2);
  assert.equal(state.plots['harbor:7'].id, 'p1');
  assert.deepEqual(state.claims['2026-W45'], ['develop3']);
  assert.equal(state.week.bought, 2);
  assert.equal(snapshotToState(null), null);
  assert.deepEqual(snapshotToState({ balance: 0, plots: [] }).plots, {});
});

test('the store delegates to the server in remote mode and adopts its snapshot', async () => {
  const fake = createFakeSupabase();
  const backend = await signedInBackend(fake);
  const store = createStore({ storage: createMemoryStorage(), remote: backend, now: () => fake.clock.now });

  assert.equal(store.mode, 'supabase');

  const buy = await store.dispatch('buy', { districtId: 'harbor', plotNo: 1 });
  assert.equal(buy.ok, true);
  assert.equal(store.state.cash, 11600, 'the local mirror follows the server');
  assert.ok(store.state.plots['harbor:1'].id, 'the server plot id is kept for later calls');

  const develop = await store.dispatch('develop', { plotKey: 'harbor:1', assetId: 'studio' });
  assert.equal(develop.ok, true, `develop failed: ${develop.message}`);
  assert.equal(store.state.plots['harbor:1'].assetId, 'studio');

  const duplicate = await store.dispatch('develop', { plotKey: 'harbor:1', assetId: 'studio' });
  assert.equal(duplicate.ok, false);
  assert.equal(store.state.cash, 10200, 'a rejected action must not mutate the mirror');
});

test('a failed server call never changes local state', async () => {
  const fake = createFakeSupabase();
  const backend = await signedInBackend(fake);
  const store = createStore({ storage: createMemoryStorage(), remote: backend, now: () => fake.clock.now });

  await store.dispatch('buy', { districtId: 'harbor', plotNo: 5 });
  const cashBefore = store.state.cash;

  backend.purchasePlot = async () => ({ ok: false, message: 'السيولة غير كافية' });
  const result = await store.dispatch('buy', { districtId: 'harbor', plotNo: 6 });
  assert.equal(result.ok, false);
  assert.equal(store.state.cash, cashBefore);
  assert.equal(store.state.plots['harbor:6'], undefined);
});

test('local mode keeps the synchronous offline behaviour and is labelled as such', () => {
  const store = createStore({ storage: createMemoryStorage() });
  assert.equal(store.mode, 'local');
  const result = store.dispatch('buy', { districtId: 'harbor', plotNo: 1 });
  assert.equal(typeof result.then, 'undefined', 'local mode must stay synchronous for the UI');
  assert.equal(result.ok, true);
  assert.equal(store.state.cash, 11600);
});
