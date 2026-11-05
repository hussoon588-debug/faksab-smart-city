// The market is between real players only: two accounts, one plot, one price, three ledger
// rows. These tests run the whole trade against the in-memory server and check both wallets.
import test from 'node:test';
import assert from 'node:assert/strict';

import { ECONOMY, DISTRICTS } from '../../apps/ofuq/src/config.js';
import {
  formatRemaining,
  marketFee,
  marketSummary,
  offerForPlot,
  offerProceeds,
  offerRemainingMs,
  validateOfferPrice
} from '../../apps/ofuq/src/core.js';
import { createIdempotencyKey, createSupabaseBackend } from '../../apps/ofuq/src/remote.js';
import { createMemoryStorage, createStore } from '../../apps/ofuq/src/store.js';
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

/* ------------------------------------------------------------------ maths --- */

test('the fee and the seller’s net are the same numbers the database writes', () => {
  assert.equal(marketFee(12500), 500);
  assert.equal(offerProceeds(12500), 12000);
  assert.equal(marketFee(0), 0);
  assert.equal(offerProceeds(100), 96);
  assert.equal(ECONOMY.market.feeRate, 0.04, 'the market fee is the published 4%');
});

test('a countdown reads as time a player can act on', () => {
  assert.equal(formatRemaining(0), 'انتهى');
  assert.equal(formatRemaining(45 * 60 * 1000), '45 دقيقة');
  assert.equal(formatRemaining(3 * HOUR), '3 ساعات');
  assert.equal(formatRemaining(2 * HOUR), 'ساعتان');
  assert.equal(formatRemaining(1 * 60 * 1000), 'دقيقة واحدة');
  assert.equal(formatRemaining(3 * HOUR + 45 * 60 * 1000), '3 ساعات و45 دقيقة');
  assert.equal(formatRemaining(20 * HOUR), '20 ساعة');
  assert.equal(offerRemainingMs({ expiresAt: Date.now() + 1000 }), 1001 - 1 > 0 ? offerRemainingMs({ expiresAt: Date.now() + 1000 }) : 0);
  assert.ok(offerRemainingMs({ expiresAt: 0 }) === 0);
});

test('the price form refuses what the server would refuse, and warns about a bad deal', () => {
  const district = DISTRICTS.find((item) => item.id === 'harbor');
  const plot = { districtId: 'harbor', plotNo: 1, assetId: 'studio', level: 1 };

  assert.equal(validateOfferPrice(50, plot, district).ok, false);
  assert.match(validateOfferPrice(50, plot, district).error, /أقل سعر/);
  assert.equal(validateOfferPrice('abc', plot, district).ok, false);
  assert.equal(validateOfferPrice(ECONOMY.market.maxPrice + 1, plot, district).ok, false);

  const fair = validateOfferPrice(2000, plot, district);
  assert.equal(fair.ok, true);
  assert.equal(fair.fee, 80);
  assert.equal(fair.net, 1920);
  assert.equal(fair.belowValue, false);

  const cheap = validateOfferPrice(500, plot, district);
  assert.equal(cheap.ok, true, 'selling cheap is allowed…');
  assert.equal(cheap.belowValue, true, '…but the sheet warns first');
  assert.ok(cheap.value > 500);
});

test('the board summary counts only live offers', () => {
  const now = Date.now();
  const offers = [
    { price: 900, expiresAt: now + 1000, mine: false },
    { price: 500, expiresAt: now + 1000, mine: true },
    { price: 100, expiresAt: now - 1, mine: false }
  ];
  assert.deepEqual(marketSummary(offers, now), { open: 2, mine: 1, cheapest: 500 });
  assert.equal(offerForPlot([{ plotId: 'p1', expiresAt: now + 1 }], 'p1', now).plotId, 'p1');
  assert.equal(offerForPlot([{ plotId: 'p1', expiresAt: now - 1 }], 'p1', now), null);
});

/* ------------------------------------------------------------- the trade --- */

test('two players trade a plot and both ledgers explain it', async () => {
  const fake = createFakeSupabase();
  const seller = player(fake, 'seller@example.com', 'بائع');
  const buyer = player(fake, 'buyer@example.com', 'مشتر');

  await seller.signUp();
  const bought = await seller.backend.purchasePlot({ districtId: 'harbor', plotNo: 1, idempotencyKey: 's-buy' });
  assert.equal(bought.ok, true, bought.message);
  const plotId = bought.snapshot.plots[0].id;
  await seller.backend.developPlot({ plotId, assetId: 'studio', idempotencyKey: 's-dev' });

  const listed = await seller.backend.listOffer({ plotId, price: 5000, hours: 24, idempotencyKey: 's-list' });
  assert.equal(listed.ok, true, listed.message);
  assert.equal(listed.snapshot.offers.length, 1);
  assert.equal(listed.snapshot.offers[0].mine, true);
  assert.equal(listed.snapshot.offers[0].price, 5000);
  assert.equal(listed.snapshot.offers[0].sellerName, 'seller');

  await buyer.signUp();
  const board = await buyer.backend.snapshot();
  assert.equal(board.snapshot.offers.length, 1, 'the board is visible to other players');
  assert.equal(board.snapshot.offers[0].mine, false);
  const offerId = board.snapshot.offers[0].id;

  const deal = await buyer.backend.acceptOffer({ offerId, idempotencyKey: 'b-accept' });
  assert.equal(deal.ok, true, deal.message);
  assert.equal(deal.snapshot.balance, 7000, 'buyer paid the full price');
  assert.equal(deal.snapshot.plots.length, 1, 'the plot changed hands');
  assert.equal(deal.snapshot.plots[0].id, plotId);
  assert.equal(deal.snapshot.plots[0].assetId, 'studio', 'the building is inherited');
  assert.deepEqual(deal.snapshot.offers, [], 'the offer closed');

  const buyerRows = deal.snapshot.ledger;
  assert.equal(buyerRows[0].reason, 'plot_purchase');
  assert.equal(buyerRows[0].amount, -5000);

  const sellerAfter = await seller.backend.snapshot();
  assert.deepEqual(
    sellerAfter.snapshot.ledger.slice(0, 2).map((row) => [row.reason, row.amount]),
    [
      ['market_fee', -200],
      ['sale', 5000]
    ],
    'the seller is credited in full and charged the 4% as its own row'
  );
  assert.equal(sellerAfter.snapshot.balance, 12000 - 400 - 1400 + 5000 - 200);
  assert.equal(sellerAfter.snapshot.plots.length, 0, 'the plot left the seller’s wallet');
});

test('an offer cannot be accepted twice, and a retried request never charges twice', async () => {
  const fake = createFakeSupabase();
  const seller = player(fake, 'seller@example.com');
  const buyer = player(fake, 'buyer@example.com');
  const rival = player(fake, 'rival@example.com');

  await seller.signUp();
  const bought = await seller.backend.purchasePlot({ districtId: 'harbor', plotNo: 2, idempotencyKey: 's-buy' });
  await seller.backend.developPlot({ plotId: bought.snapshot.plots[0].id, assetId: 'studio', idempotencyKey: 's-dev' });
  await seller.backend.listOffer({ plotId: bought.snapshot.plots[0].id, price: 3000, idempotencyKey: 's-list' });

  await buyer.signUp();
  const board = await buyer.backend.snapshot();
  const offerId = board.snapshot.offers[0].id;

  const first = await buyer.backend.acceptOffer({ offerId, idempotencyKey: 'b-first' });
  assert.equal(first.ok, true);
  assert.equal(first.snapshot.balance, 9000);

  // Same key: a replay must be a no-op that returns the truth.
  const replay = await buyer.backend.acceptOffer({ offerId, idempotencyKey: 'b-first' });
  assert.equal(replay.ok, true);
  assert.equal(replay.snapshot.balance, first.snapshot.balance, 'no second debit');

  // New key, closed offer: refused, and the wallet is untouched.
  const second = await buyer.backend.acceptOffer({ offerId, idempotencyKey: 'b-second' });
  assert.equal(second.ok, false);
  assert.match(second.message, /لم يعد متاحاً/);

  const buyerAgain = await buyer.backend.snapshot();
  assert.equal(buyerAgain.snapshot.balance, 9000, 'one 3000 purchase, charged once');

  // A rival cannot buy what is already sold.
  await rival.signUp();
  const rivalDeal = await rival.backend.acceptOffer({ offerId, idempotencyKey: 'r-1' });
  assert.equal(rivalDeal.ok, false);
});

test('a player cannot buy their own listing, and only the owner can cancel', async () => {
  const fake = createFakeSupabase();
  const seller = player(fake, 'seller@example.com');
  const other = player(fake, 'other@example.com');

  await seller.signUp();
  const bought = await seller.backend.purchasePlot({ districtId: 'garden', plotNo: 3, idempotencyKey: 's-buy' });
  const plotId = bought.snapshot.plots[0].id;
  await seller.backend.developPlot({ plotId, assetId: 'studio', idempotencyKey: 's-dev' });
  const listed = await seller.backend.listOffer({ plotId, price: 2500, idempotencyKey: 's-list' });
  const offerId = listed.snapshot.offers[0].id;

  const self = await seller.backend.acceptOffer({ offerId, idempotencyKey: 's-accept' });
  assert.equal(self.ok, false);
  assert.match(self.message, /عرضك/);

  await other.signUp();
  const foreign = await other.backend.cancelOffer({ offerId, idempotencyKey: 'o-cancel' });
  assert.equal(foreign.ok, false);
  assert.match(foreign.message, /ليس لك/);

  const cancelled = await seller.backend.cancelOffer({ offerId, idempotencyKey: 's-cancel' });
  assert.equal(cancelled.ok, true);
  assert.deepEqual(cancelled.snapshot.offers, []);

  const twice = await seller.backend.cancelOffer({ offerId, idempotencyKey: 's-cancel-2' });
  assert.equal(twice.ok, false);
  assert.match(twice.message, /لم يعد مفتوحاً/);
});

test('an expired offer leaves the board and cannot be bought', async () => {
  const fake = createFakeSupabase();
  const seller = player(fake, 'seller@example.com');
  const buyer = player(fake, 'buyer@example.com');

  await seller.signUp();
  const bought = await seller.backend.purchasePlot({ districtId: 'harbor', plotNo: 4, idempotencyKey: 's-buy' });
  const plotId = bought.snapshot.plots[0].id;
  await seller.backend.developPlot({ plotId, assetId: 'studio', idempotencyKey: 's-dev' });
  const listed = await seller.backend.listOffer({ plotId, price: 2000, hours: 1, idempotencyKey: 's-list' });
  const offerId = listed.snapshot.offers[0].id;

  fake.clock.now += 2 * HOUR;

  await buyer.signUp();
  const board = await buyer.backend.snapshot();
  assert.deepEqual(board.snapshot.offers, [], 'the clock closed the offer');

  const late = await buyer.backend.acceptOffer({ offerId, idempotencyKey: 'b-late' });
  assert.equal(late.ok, false);
  assert.match(late.message, /لم يعد متاحاً/);
});

test('listing is refused for a plot that is not yours or not developed', async () => {
  const fake = createFakeSupabase();
  const owner = player(fake, 'owner@example.com');
  const stranger = player(fake, 'stranger@example.com');

  await owner.signUp();
  const bought = await owner.backend.purchasePlot({ districtId: 'harbor', plotNo: 5, idempotencyKey: 'o-buy' });
  const plotId = bought.snapshot.plots[0].id;

  await stranger.signUp();
  const notMine = await stranger.backend.listOffer({ plotId, price: 2000, idempotencyKey: 'x-1' });
  assert.equal(notMine.ok, false);
  assert.match(notMine.message, /ليست لك/);

  const bare = await owner.backend.listOffer({ plotId, price: 2000, idempotencyKey: 'o-bare' });
  assert.equal(bare.ok, false);
  assert.match(bare.message, /طوّر القطعة/);

  const tooCheap = await owner.backend.developPlot({ plotId, assetId: 'studio', idempotencyKey: 'o-dev' })
    .then(() => owner.backend.listOffer({ plotId, price: 10, idempotencyKey: 'o-cheap' }));
  assert.equal(tooCheap.ok, false);
  assert.match(tooCheap.message, /أقل سعر/);
});

/* -------------------------------------------------------------- the store --- */

test('local mode says the market needs a session instead of faking one', async () => {
  const store = createStore({ storage: createMemoryStorage() });
  await store.dispatch('buy', { districtId: 'harbor', plotNo: 1 });
  await store.dispatch('develop', { plotKey: 'harbor:1', assetId: 'studio' });

  for (const [type, payload] of [
    ['listOffer', { plotKey: 'harbor:1', price: 3000 }],
    ['acceptOffer', { offerId: 'x' }],
    ['cancelOffer', { offerId: 'x' }]
  ]) {
    const result = await store.dispatch(type, payload);
    assert.equal(result.ok, false, `${type} must not work offline`);
    assert.match(result.message, /يحتاج جلسة خادم/);
  }
  assert.deepEqual(store.state.offers, [], 'no invented board offline');
});

test('the store lists, reads and accepts offers through the server', async () => {
  const fake = createFakeSupabase();
  const seller = player(fake, 'seller@example.com');
  const buyer = player(fake, 'buyer@example.com');

  await seller.signUp();
  const sellerStore = createStore({ storage: createMemoryStorage(), remote: seller.backend, now: () => fake.clock.now });
  assert.equal((await sellerStore.dispatch('buy', { districtId: 'harbor', plotNo: 6 })).ok, true);
  assert.equal((await sellerStore.dispatch('develop', { plotKey: 'harbor:6', assetId: 'studio' })).ok, true);

  const tooCheap = await sellerStore.dispatch('listOffer', { plotKey: 'harbor:6', price: 10 });
  assert.equal(tooCheap.ok, false, 'the store enforces the floor before the network');

  const listed = await sellerStore.dispatch('listOffer', { plotKey: 'harbor:6', price: 4000 });
  assert.equal(listed.ok, true, listed.message);
  assert.equal(sellerStore.state.offers.length, 1);
  assert.equal(sellerStore.state.offers[0].mine, true);

  await buyer.signUp();
  const buyerStore = createStore({ storage: createMemoryStorage(), remote: buyer.backend, now: () => fake.clock.now });
  await buyerStore.syncFromServer();
  assert.equal(buyerStore.state.offers.length, 1);
  const offerId = buyerStore.state.offers[0].id;

  const deal = await buyerStore.dispatch('acceptOffer', { offerId });
  assert.equal(deal.ok, true, deal.message);
  assert.equal(buyerStore.state.cash, 8000);
  assert.deepEqual(buyerStore.state.offers, []);
  assert.equal(buyerStore.state.plots['harbor:6'].assetId, 'studio', 'the plot arrived with its building');
  assert.equal(buyerStore.state.ledger[0].reason, 'plot_purchase');
});
