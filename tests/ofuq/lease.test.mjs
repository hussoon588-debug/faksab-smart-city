// Leasing rents out the *income* of a developed plot, not the plot itself. Two real
// accounts, one fee, one window: the owner keeps the deed, the tenant keeps the rent until
// the clock runs out. Everything here runs against the in-memory server.
import test from 'node:test';
import assert from 'node:assert/strict';

import { ECONOMY } from '../../apps/ofuq/src/config.js';
import {
  isLeaseListing,
  isPlotLeased,
  leaseCollectible,
  leaseForPlot,
  leaseListingSummary,
  leaseRemainingMs,
  leaseSummary,
  liveLeases,
  marketFee,
  marketSummary,
  saleListings,
  suggestedLeaseFee,
  validateLeaseFee,
  validateLeaseHours
} from '../../apps/ofuq/src/core.js';
import { createSupabaseBackend } from '../../apps/ofuq/src/remote.js';
import { createMemoryStorage } from '../../apps/ofuq/src/store.js';
import { HOUR, createFakeSupabase } from '../support/fake-supabase.mjs';

const STORE_URL = 'https://demo.supabase.co';

function player(fake, email, name = 'لاعب') {
  const backend = createSupabaseBackend({
    url: STORE_URL,
    publishableKey: 'sb_publishable_test',
    fetchImpl: fake.fetchImpl,
    storage: createMemoryStorage()
  });
  return { backend, signUp: () => backend.signUp(email, 'secret123', name) };
}

/** A developed studio in the harbor, owned by `email`, plus its plot id. */
async function owner(fake, email = 'owner@example.com') {
  const me = player(fake, email, 'مالك');
  await me.signUp();
  const bought = await me.backend.purchasePlot({ districtId: 'harbor', plotNo: 1, idempotencyKey: `${email}-buy` });
  const plotId = bought.snapshot.plots[0].id;
  const developed = await me.backend.developPlot({ plotId, assetId: 'studio', idempotencyKey: `${email}-dev` });
  return { ...me, plotId, developed };
}

/* ------------------------------------------------------------------ maths --- */

test('the lease form refuses what the server would refuse', () => {
  assert.equal(validateLeaseFee(50).ok, false);
  assert.match(validateLeaseFee(50).error, /أقل مبلغ/);
  assert.equal(validateLeaseFee('abc').ok, false);
  assert.equal(validateLeaseFee(ECONOMY.lease.maxFee + 1).ok, false);
  const ok = validateLeaseFee(600);
  assert.equal(ok.ok, true);
  assert.equal(ok.platformFee, marketFee(600));
  assert.equal(ok.net, 600 - 24, 'the owner keeps the fee minus the 4%');

  assert.equal(validateLeaseHours(0).ok, false);
  assert.equal(validateLeaseHours(169).ok, false);
  assert.equal(validateLeaseHours('abc').ok, false);
  assert.equal(validateLeaseHours(24).hours, 24);

  // 34/h × 24h = 816 collectible; the suggestion is a realistic share of it.
  assert.equal(suggestedLeaseFee(34, 24), 490);
  assert.equal(suggestedLeaseFee(34, 1), ECONOMY.lease.minFee, 'a one hour lease still costs the floor');
});

test('the tenant’s clock caps at the same eight hours as an owned plot', () => {
  const now = Date.now();
  const lease = { startsAt: now - 3 * HOUR, lastCollectedAt: now - 3 * HOUR, endsAt: now + 21 * HOUR, rent: 34 };
  assert.equal(leaseCollectible(lease, now), 102);
  assert.equal(
    leaseCollectible({ ...lease, startsAt: now - 20 * HOUR, lastCollectedAt: now - 20 * HOUR }, now),
    8 * 34,
    'capped at 8h'
  );
  assert.equal(leaseCollectible({ ...lease, endsAt: now - 1 }, now), 0, 'an ended lease pays nothing');
  assert.equal(leaseCollectible({ ...lease, lastCollectedAt: now }, now), 0);
});

test('listings and leases are counted separately, and a plot is never both', () => {
  const now = Date.now();
  const offers = [
    { id: 'o1', kind: 'sale', price: 4000, fee: 0, expiresAt: now + 1000, mine: false },
    { id: 'o2', kind: 'lease', price: 0, fee: 600, expiresAt: now + 1000, mine: true },
    { id: 'o3', kind: 'lease', price: 0, fee: 300, expiresAt: now - 1, mine: false }
  ];
  assert.equal(saleListings(offers).length, 1);
  assert.equal(isLeaseListing(offers[1]), true);
  assert.deepEqual(leaseListingSummary(offers, now), { open: 1, mine: 1, cheapest: 600 });
  assert.deepEqual(marketSummary(offers, now), { open: 1, mine: 0, cheapest: 4000 }, 'the sale board ignores leases');

  const leases = [
    { id: 'l1', districtId: 'harbor', plotNo: 1, endsAt: now + HOUR, tenant: true, owner: false, rent: 34, startsAt: now - 2 * HOUR, lastCollectedAt: now - 2 * HOUR },
    { id: 'l2', districtId: 'garden', plotNo: 2, endsAt: now - HOUR, tenant: true, owner: false, rent: 50, startsAt: now, lastCollectedAt: now }
  ];
  assert.equal(liveLeases(leases, now).length, 1);
  assert.equal(leaseSummary(leases, now).rented, 1);
  assert.equal(leaseSummary(leases, now).collectible, 68);
  assert.equal(leaseRemainingMs(leases[0], now), HOUR);
  const state = { leases };
  assert.equal(leaseForPlot(state, 'harbor', 1, now).id, 'l1');
  assert.equal(leaseForPlot(state, 'garden', 2, now), null, 'the ended one no longer covers its plot');
  assert.equal(isPlotLeased(state, 'harbor', 1, now), true);
  assert.equal(isPlotLeased(state, 'harbor', 9, now), false);
});

/* ------------------------------------------------------------ the handover --- */

test('the owner keeps the deed, the tenant gets the income, and both ledgers explain it', async () => {
  const fake = createFakeSupabase();
  const lessor = await owner(fake);
  const tenant = player(fake, 'tenant@example.com', 'مستأجر');
  await tenant.signUp();

  const listed = await lessor.backend.listLease({
    plotId: lessor.plotId,
    fee: 600,
    hours: 24,
    windowHours: 48,
    idempotencyKey: 'o-lease'
  });
  assert.equal(listed.ok, true, listed.message);
  assert.equal(listed.snapshot.offers.length, 1);
  const listing = listed.snapshot.offers[0];
  assert.equal(listing.kind, 'lease');
  assert.equal(listing.fee, 600);
  assert.equal(listing.hours, 24);
  assert.equal(listing.mine, true);

  const board = await tenant.backend.snapshot();
  assert.equal(board.snapshot.offers.length, 1, 'the lease listing is on the public board');

  const deal = await tenant.backend.acceptLease({ offerId: listing.id, idempotencyKey: 't-accept' });
  assert.equal(deal.ok, true, deal.message);
  assert.equal(deal.snapshot.balance, 12000 - 600, 'the tenant paid the fee');
  assert.equal(deal.snapshot.plots.length, 0, 'the plot never entered the tenant’s wallet');
  assert.equal(deal.snapshot.leases.length, 1);
  const lease = deal.snapshot.leases[0];
  assert.equal(lease.tenant, true);
  assert.equal(lease.owner, false);
  assert.equal(lease.rent, 34, 'the server publishes the rent the lease pays');
  assert.equal(Date.parse(lease.endsAt) - Date.parse(lease.startsAt), 24 * HOUR);

  const lessorAfter = await lessor.backend.snapshot();
  assert.equal(lessorAfter.snapshot.plots.length, 1, 'the owner still holds the plot');
  assert.equal(lessorAfter.snapshot.plots[0].id, lessor.plotId);
  assert.deepEqual(
    lessorAfter.snapshot.ledger.slice(0, 2).map((row) => [row.reason, row.amount]),
    [
      ['market_fee', -24],
      ['lease_income', 600]
    ]
  );
  assert.equal(lessorAfter.snapshot.balance, 12000 - 400 - 1400 + 600 - 24);
});

test('the rent that accrued before the lease is settled to the owner, not given away', async () => {
  const fake = createFakeSupabase();
  const lessor = await owner(fake);
  const tenant = player(fake, 'tenant@example.com');
  await tenant.signUp();

  // Three hours pass with the plot earning for its owner.
  fake.clock.now += 3 * HOUR;

  const listed = await lessor.backend.listLease({ plotId: lessor.plotId, fee: 300, hours: 6, idempotencyKey: 'l1' });
  const offerId = listed.snapshot.offers[0].id;
  const deal = await tenant.backend.acceptLease({ offerId, idempotencyKey: 'a1' });
  assert.equal(deal.ok, true, deal.message);

  const lessorAfter = await lessor.backend.snapshot();
  const rentRow = lessorAfter.snapshot.ledger.find((row) => row.reason === 'rent');
  assert.ok(rentRow, 'the owner was credited the accrued rent first');
  assert.equal(rentRow.amount, 102, '3h × 34/h');
  assert.equal(Date.parse(deal.snapshot.leases[0].lastCollectedAt), fake.clock.now, 'the tenant starts from zero');
});

test('the tenant collects while the lease runs, the owner cannot, and the plot reverts', async () => {
  const fake = createFakeSupabase();
  const lessor = await owner(fake);
  const tenant = player(fake, 'tenant@example.com');
  await tenant.signUp();

  const listed = await lessor.backend.listLease({ plotId: lessor.plotId, fee: 300, hours: 4, idempotencyKey: 'l1' });
  const deal = await tenant.backend.acceptLease({ offerId: listed.snapshot.offers[0].id, idempotencyKey: 'a1' });
  assert.equal(deal.ok, true, deal.message);

  fake.clock.now += 2 * HOUR;
  const tenantCollect = await tenant.backend.collectRent({ plotId: lessor.plotId, idempotencyKey: 't-collect' });
  assert.equal(tenantCollect.ok, true, tenantCollect.message);
  assert.equal(tenantCollect.snapshot.balance, 12000 - 300 + 68, '2h × 34/h for the tenant');

  const ownerCollect = await lessor.backend.collectRent({ plotId: lessor.plotId, idempotencyKey: 'o-collect' });
  assert.equal(ownerCollect.ok, false, 'the owner cannot drain the lease');
  assert.match(ownerCollect.message, /مؤجَّرة/);

  // The lease ends: collection rights go home.
  fake.clock.now += 3 * HOUR;
  const afterEnd = await lessor.backend.snapshot();
  assert.deepEqual(afterEnd.snapshot.leases, [], 'the lease is no longer live');
  const tenantLocked = await tenant.backend.collectRent({ plotId: lessor.plotId, idempotencyKey: 't-late' });
  assert.equal(tenantLocked.ok, false, 'the tenant cannot collect after the window');
  const ownerBack = await lessor.backend.collectRent({ plotId: lessor.plotId, idempotencyKey: 'o-back' });
  assert.equal(ownerBack.ok, true, ownerBack.message);
});

test('a leased plot cannot be sold or listed, and the lease survives a retried request', async () => {
  const fake = createFakeSupabase();
  const lessor = await owner(fake);
  const tenant = player(fake, 'tenant@example.com');
  await tenant.signUp();

  const listed = await lessor.backend.listLease({ plotId: lessor.plotId, fee: 300, hours: 2, idempotencyKey: 'l1' });
  const offerId = listed.snapshot.offers[0].id;
  const first = await tenant.backend.acceptLease({ offerId, idempotencyKey: 'same-key' });
  assert.equal(first.ok, true, first.message);
  const replay = await tenant.backend.acceptLease({ offerId, idempotencyKey: 'same-key' });
  assert.equal(replay.ok, true, 'a retried request replays instead of failing');
  assert.equal(replay.snapshot.balance, 12000 - 300, 'and never charges twice');
  assert.equal(replay.snapshot.leases.length, 1);

  const sellWhileLeased = await lessor.backend.sellPlot({ plotId: lessor.plotId, idempotencyKey: 's-sell' });
  assert.equal(sellWhileLeased.ok, false);
  assert.match(sellWhileLeased.message, /مؤجَّرة/);
  const listWhileLeased = await lessor.backend.listOffer({ plotId: lessor.plotId, price: 5000, hours: 24, idempotencyKey: 's-list' });
  assert.equal(listWhileLeased.ok, false, 'no sale listing while the lease runs');

  const third = player(fake, 'third@example.com');
  const thirdSignUp = await third.signUp();
  assert.equal(thirdSignUp.ok, true, thirdSignUp.message);
  const late = await third.backend.acceptLease({ offerId, idempotencyKey: 'third-accept' });
  assert.equal(late.ok, false, 'the offer closed when the lease started');
  assert.match(late.message, /لم يعد متاحاً/);

  fake.clock.now += 3 * HOUR;
  const sellAfter = await lessor.backend.sellPlot({ plotId: lessor.plotId, idempotencyKey: 's-sell-2' });
  assert.equal(sellAfter.ok, true, 'once the lease ends the owner is free to sell');
});

test('a lease cannot be self-served, and the two kinds of offer are not interchangeable', async () => {
  const fake = createFakeSupabase();
  const lessor = await owner(fake);
  const tenant = player(fake, 'tenant@example.com');
  await tenant.signUp();

  const listed = await lessor.backend.listLease({ plotId: lessor.plotId, fee: 300, hours: 2, idempotencyKey: 'l1' });
  const offerId = listed.snapshot.offers[0].id;

  const self = await lessor.backend.acceptLease({ offerId, idempotencyKey: 'self' });
  assert.equal(self.ok, false);
  assert.match(self.message, /لا يمكنك استئجار أصلك/);

  const wrongKind = await tenant.backend.acceptOffer({ offerId, idempotencyKey: 'wrong' });
  assert.equal(wrongKind.ok, false, 'accepting a lease as a purchase must fail');
  assert.match(wrongKind.message, /عرض إيجار/);

  const duplicate = await lessor.backend.listLease({ plotId: lessor.plotId, fee: 400, hours: 2, idempotencyKey: 'l2' });
  assert.equal(duplicate.ok, false, 'a plot can only be listed once at a time');
  assert.match(duplicate.message, /معروضة بالفعل|مؤجَّرة/);

  const cheap = await lessor.backend.listLease({ plotId: lessor.plotId, fee: 10, hours: 2, idempotencyKey: 'l3' });
  assert.equal(cheap.ok, false);
  const long = await lessor.backend.listLease({ plotId: lessor.plotId, fee: 300, hours: 500, idempotencyKey: 'l4' });
  assert.equal(long.ok, false);
});

test('the client store adopts the lease snapshot and refuses it locally', async () => {
  const { createStore } = await import('../../apps/ofuq/src/store.js');
  const local = createStore({ storage: createMemoryStorage() });
  const blocked = await local.dispatch('listLease', { plotKey: 'harbor:1', fee: 300, hours: 24 });
  assert.equal(blocked.ok, false);
  assert.match(blocked.message, /جلسة خادم/, 'local mode says so instead of pretending');

  const fake = createFakeSupabase();
  const lessor = await owner(fake);
  const tenantBackend = player(fake, 'tenant@example.com');
  await tenantBackend.signUp();

  const tenantStore = createStore({ storage: createMemoryStorage(), remote: tenantBackend.backend });
  const synced = await tenantStore.syncFromServer();
  assert.equal(synced.ok, true, synced.message);
  const listed = await lessor.backend.listLease({ plotId: lessor.plotId, fee: 300, hours: 4, idempotencyKey: 'l1' });
  assert.equal(listed.ok, true, listed.message);

  const refreshed = await tenantStore.dispatch('acceptLease', { offerId: listed.snapshot.offers[0].id });
  assert.equal(refreshed.ok, true, refreshed.message);
  assert.equal(tenantStore.state.leases.length, 1);
  assert.equal(tenantStore.state.leases[0].tenant, true);
  assert.match(refreshed.message, /تم استئجار الأصل/);
});
