// Contract tests for the server-authoritative adapter.
//
// `createFakeSupabase` implements the same RPC contract as supabase/ofuq/schema.sql
// (auth, balance, ownership, idempotency, rent accrual). It lets the client adapter and
// the store's server mode be exercised end to end without a live project.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIdempotencyKey, createSupabaseBackend, describeError, snapshotToState } from '../../apps/ofuq/src/remote.js';
import { createMemoryStorage, createStore } from '../../apps/ofuq/src/store.js';

const HOUR = 60 * 60 * 1000;
const DISTRICTS = {
  harbor: { tier: 1, unlockLevel: 1, plots: 20 },
  garden: { tier: 1.15, unlockLevel: 1, plots: 20 },
  downtown: { tier: 1.35, unlockLevel: 2, plots: 20 }
};
const ASSETS = { studio: { cost: 1400, rent: 34, unlockLevel: 1 }, office: { cost: 5600, rent: 168, unlockLevel: 3 } };
const LEVELS = [0, 700, 1800, 3600, 6000, 9000];

const plotPrice = (tier) => Math.round((400 * tier) / 50) * 50;
const levelOf = (xp) => LEVELS.filter((threshold) => xp >= threshold).length;
const rentOf = (assetId, level, tier) =>
  Math.round(ASSETS[assetId].rent * (1 + 0.35 * (level - 1)) * (1 + 0.15 * (tier - 1)));
const upgradeCost = (assetId, level, tier) => Math.round((ASSETS[assetId].cost * 0.55 * level) / tier / 50) * 50;

function json(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload) };
}

/** In-memory stand-in for the SQL functions. Mirrors the security rules, not the storage. */
function createFakeSupabase({ clock = { now: Date.UTC(2026, 10, 5, 9) } } = {}) {
  const users = new Map(); // email -> password
  const tokens = new Map(); // token -> email
  const accounts = new Map(); // email -> { balance, xp, plots, claims, ledger:Set }
  const plots = new Map(); // key -> { id, districtId, plotNo, owner, assetId, level, lastCollectedAt }
  let calls = 0;

  const accountFor = (email) => {
    if (!accounts.has(email)) {
      accounts.set(email, { balance: 12000, xp: 0, plots: new Set(), claims: new Set(), ledger: new Set() });
    }
    return accounts.get(email);
  };

  for (const [districtId, district] of Object.entries(DISTRICTS)) {
    for (let no = 1; no <= district.plots; no += 1) {
      const key = `${districtId}:${no}`;
      plots.set(key, {
        id: `plot-${key}`,
        districtId,
        plotNo: no,
        price: plotPrice(district.tier),
        owner: null,
        assetId: null,
        level: 0,
        lastCollectedAt: null
      });
    }
  }

  function snapshot(email) {
    const account = accountFor(email);
    const owned = [...plots.values()].filter((plot) => plot.owner === email);
    return {
      player: { id: `user-${email}`, name: email.split('@')[0], xp: account.xp, level: levelOf(account.xp) },
      balance: account.balance,
      week: '2026-W45',
      plots: owned.map((plot) => ({
        id: plot.id,
        districtId: plot.districtId,
        plotNo: plot.plotNo,
        assetId: plot.assetId,
        level: plot.level,
        purchasedAt: new Date(clock.now).toISOString(),
        lastCollectedAt: new Date(plot.lastCollectedAt ?? clock.now).toISOString(),
        rent: plot.assetId ? rentOf(plot.assetId, plot.level, DISTRICTS[plot.districtId].tier) : 0,
        value: plot.price
      })),
      weekly: { bought: 0, developed: 0, upgraded: 0, collected: 0 },
      claims: [...account.claims]
    };
  }

  function spend(account, email, key, delta) {
    if (key && account.ledger.has(key)) return { replayed: true };
    if (account.balance + delta < 0) throw new Error('السيولة غير كافية');
    account.balance += delta;
    if (key) account.ledger.add(key);
    return { replayed: false };
  }

  const handlers = {
    ofuq_snapshot: (email) => snapshot(email),

    ofuq_purchase_plot: (email, { p_district, p_plot_no, p_idempotency }) => {
      const district = DISTRICTS[p_district];
      if (!district) throw new Error('الحي غير معروف');
      const account = accountFor(email);
      if (p_idempotency && account.ledger.has(p_idempotency)) return snapshot(email);
      if (levelOf(account.xp) < district.unlockLevel) throw new Error(`هذا الحي يُفتح في المستوى ${district.unlockLevel}`);
      const plot = plots.get(`${p_district}:${p_plot_no}`);
      if (!plot) throw new Error('القطعة غير موجودة');
      if (plot.owner) throw new Error('هذه القطعة مملوكة بالفعل');
      if (spend(account, email, p_idempotency, -plot.price).replayed) return snapshot(email);
      plot.owner = email;
      account.plots.add(`${p_district}:${p_plot_no}`);
      account.xp += 40;
      return snapshot(email);
    },

    ofuq_develop_plot: (email, { p_plot, p_asset, p_idempotency }) => {
      const accountEarly = accountFor(email);
      if (p_idempotency && accountEarly.ledger.has(p_idempotency)) return snapshot(email);
      const plot = [...plots.values()].find((candidate) => candidate.id === p_plot);
      if (!plot) throw new Error('القطعة غير موجودة');
      if (plot.owner !== email) throw new Error('هذه القطعة ليست لك');
      if (plot.assetId) throw new Error('القطعة مطوّرة بالفعل');
      const asset = ASSETS[p_asset];
      if (!asset) throw new Error('نوع الأصل غير معروف');
      const account = accountFor(email);
      if (levelOf(account.xp) < asset.unlockLevel) throw new Error(`هذا الأصل يُفتح في المستوى ${asset.unlockLevel}`);
      if (spend(account, email, p_idempotency, -asset.cost).replayed) return snapshot(email);
      plot.assetId = p_asset;
      plot.level = 1;
      plot.lastCollectedAt = clock.now;
      account.xp += 120;
      return snapshot(email);
    },

    ofuq_upgrade_plot: (email, { p_plot, p_idempotency }) => {
      if (p_idempotency && accountFor(email).ledger.has(p_idempotency)) return snapshot(email);
      const plot = [...plots.values()].find((candidate) => candidate.id === p_plot);
      if (!plot) throw new Error('القطعة غير موجودة');
      if (plot.owner !== email) throw new Error('هذه القطعة ليست لك');
      if (!plot.assetId) throw new Error('طوّر القطعة أولاً');
      if (plot.level >= 5) throw new Error('وصل الأصل إلى أعلى مستوى');
      const account = accountFor(email);
      const cost = upgradeCost(plot.assetId, plot.level, DISTRICTS[plot.districtId].tier);
      if (spend(account, email, p_idempotency, -cost).replayed) return snapshot(email);
      plot.level += 1;
      account.xp += 90;
      return snapshot(email);
    },

    ofuq_collect_rent: (email, { p_plot, p_idempotency }) => {
      const plot = [...plots.values()].find((candidate) => candidate.id === p_plot);
      if (!plot) throw new Error('القطعة غير موجودة');
      if (plot.owner !== email) throw new Error('هذه القطعة ليست لك');
      if (!plot.assetId) throw new Error('لا يوجد أصل على هذه القطعة');
      const account = accountFor(email);
      if (p_idempotency && account.ledger.has(p_idempotency)) return snapshot(email);
      const rate = rentOf(plot.assetId, plot.level, DISTRICTS[plot.districtId].tier);
      const elapsed = (clock.now - (plot.lastCollectedAt ?? clock.now)) / HOUR;
      const amount = Math.floor(Math.min(Math.max(elapsed, 0), 8) * rate);
      if (amount <= 0) throw new Error('لم يتراكم إيجار كافٍ بعد');
      account.balance += amount;
      if (p_idempotency) account.ledger.add(p_idempotency);
      plot.lastCollectedAt = clock.now;
      account.xp += 6;
      return snapshot(email);
    },

    ofuq_sell_plot: (email, { p_plot, p_idempotency }) => {
      if (p_idempotency && accountFor(email).ledger.has(p_idempotency)) return snapshot(email);
      const plot = [...plots.values()].find((candidate) => candidate.id === p_plot);
      if (!plot) throw new Error('القطعة غير موجودة');
      if (plot.owner !== email) throw new Error('هذه القطعة ليست لك');
      const account = accountFor(email);
      const build = plot.assetId ? Math.round(ASSETS[plot.assetId].cost * (1 + 0.35 * (plot.level - 1)) * 0.9) : 0;
      const proceeds = Math.round((plot.price + build) * 0.96);
      if (spend(account, email, p_idempotency, proceeds).replayed) return snapshot(email);
      plot.owner = null;
      plot.assetId = null;
      plot.level = 0;
      plot.lastCollectedAt = null;
      account.plots.delete(`${plot.districtId}:${plot.plotNo}`);
      account.xp += 50;
      return snapshot(email);
    },

    ofuq_claim_mission: (email, { p_mission, p_idempotency }) => {
      const account = accountFor(email);
      if (p_idempotency && account.ledger.has(p_idempotency)) return snapshot(email);
      if (account.claims.has(p_mission)) throw new Error('استلمت مكافأة هذا التحدي');
      const rewards = { own4: 800, develop3: 600 };
      if (!(p_mission in rewards)) throw new Error('التحدي غير معروف');
      if (p_mission === 'own4' && account.plots.size < 4) throw new Error('لم يكتمل التحدي بعد');
      if (spend(account, email, p_idempotency, rewards[p_mission]).replayed) return snapshot(email);
      account.claims.add(p_mission);
      return snapshot(email);
    }
  };

  const fetchImpl = async (url, init = {}) => {
    calls += 1;
    const path = new URL(url).pathname + (url.includes('?') ? `?${url.split('?')[1]}` : '');
    const body = init.body ? JSON.parse(init.body) : {};

    if (path === '/auth/v1/signup') {
      users.set(body.email, body.password);
      const token = `tok-${body.email}`;
      tokens.set(token, body.email);
      return json({ access_token: token, refresh_token: 'rt', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: `user-${body.email}`, email: body.email } });
    }
    if (path === '/auth/v1/token?grant_type=password') {
      if (users.get(body.email) !== body.password) return json({ message: 'Invalid login credentials' }, 400);
      const token = `tok-${body.email}`;
      tokens.set(token, body.email);
      return json({ access_token: token, refresh_token: 'rt', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: `user-${body.email}`, email: body.email } });
    }
    if (path === '/auth/v1/logout') return json({});

    if (path.startsWith('/rest/v1/rpc/')) {
      const auth = init.headers?.Authorization ?? '';
      const token = auth.replace('Bearer ', '');
      const email = tokens.get(token);
      if (!email) return json({ message: 'JWT expired' }, 401);
      const fn = path.split('/').pop();
      try {
        const result = handlers[fn](email, body);
        return json(result);
      } catch (error) {
        return json({ message: `P0001: ${error.message}` }, 400);
      }
    }
    if (path === '/__boom') return json({ message: 'down' }, 500);
    return json({ message: 'not found' }, 404);
  };

  return {
    fetchImpl,
    clock,
    plots,
    accounts,
    get calls() {
      return calls;
    }
  };
}

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
