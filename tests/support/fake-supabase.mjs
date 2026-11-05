/**
 * In-memory stand-in for the Supabase schema in `supabase/ofuq/schema.sql`.
 *
 * It mirrors the RPC contract (names, payloads, Arabic errors, idempotent replay and the
 * same economics) so the client can be tested without a database — and so the auth UI can
 * be exercised end to end in jsdom. Keep it in sync with the SQL, not with the client.
 */
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
  const accounts = new Map(); // email -> { balance, xp, plots, claims, ledger:Set (idempotency), rows:[] (money) }
  const plots = new Map(); // key -> { id, districtId, plotNo, owner, assetId, level, lastCollectedAt }
  const offers = new Map(); // id -> { id, kind, plotId, sellerId, price|fee, hours, createdAt, expiresAt, status, buyerId }
  const leases = new Map(); // id -> { id, offerId, plotId, lessorId, lesseeId, fee, startsAt, endsAt }
  let calls = 0;
  let offerSeq = 0;
  let leaseSeq = 0;

  const accountFor = (email) => {
    if (!accounts.has(email)) {
      accounts.set(email, { balance: 12000, xp: 0, plots: new Set(), claims: new Set(), ledger: new Set(), requests: new Set(), rows: [] });
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

  const plotById = (id) => [...plots.values()].find((candidate) => candidate.id === id) ?? null;

  const plotValueOf = (plot) =>
    plot.assetId
      ? plot.price + Math.round(ASSETS[plot.assetId].cost * (1 + 0.35 * (plot.level - 1)) * 0.9)
      : plot.price;

  function expireOffers() {
    for (const offer of offers.values()) {
      if (offer.status === 'open' && offer.expiresAt <= clock.now) offer.status = 'expired';
    }
  }

  /** The lease currently running on a plot, if any — ownership never moves. */
  function activeLease(plotId) {
    return [...leases.values()].find((lease) => lease.plotId === plotId && lease.endsAt > clock.now) ?? null;
  }

  /** Accrued rent belongs to whoever owns the plot when the lease starts: settle it first. */
  function settleAccrued(plot) {
    if (!plot.assetId || plot.owner === null) return 0;
    const owner = accountFor(plot.owner);
    const rate = rentOf(plot.assetId, plot.level, DISTRICTS[plot.districtId].tier);
    const elapsed = (clock.now - (plot.lastCollectedAt ?? clock.now)) / HOUR;
    const amount = Math.floor(Math.min(Math.max(elapsed, 0), 8) * rate);
    if (amount <= 0) return 0;
    owner.balance += amount;
    rowId += 1;
    owner.rows.unshift({
      id: rowId,
      ts: new Date(clock.now).toISOString(),
      reason: 'rent',
      amount,
      balanceAfter: owner.balance,
      ref: plot.id
    });
    plot.lastCollectedAt = clock.now;
    return amount;
  }

  function liveLeases(email) {
    return [...leases.values()]
      .filter((lease) => lease.endsAt > clock.now && (lease.lessorId === email || lease.lesseeId === email))
      .sort((a, b) => b.startsAt - a.startsAt)
      .map((lease) => {
        const plot = plotById(lease.plotId);
        return {
          id: lease.id,
          plotId: lease.plotId,
          districtId: plot.districtId,
          plotNo: plot.plotNo,
          assetId: plot.assetId,
          level: plot.level,
          rent: plot.assetId ? rentOf(plot.assetId, plot.level, DISTRICTS[plot.districtId].tier) : 0,
          fee: lease.fee,
          lessorId: `user-${lease.lessorId}`,
          lessorName: lease.lessorId.split('@')[0],
          lesseeId: `user-${lease.lesseeId}`,
          lesseeName: lease.lesseeId.split('@')[0],
          startsAt: new Date(lease.startsAt).toISOString(),
          endsAt: new Date(lease.endsAt).toISOString(),
          lastCollectedAt: new Date(plot.lastCollectedAt ?? lease.startsAt).toISOString(),
          tenant: lease.lesseeId === email,
          owner: lease.lessorId === email
        };
      });
  }

  function liveOffers(email) {
    expireOffers();
    return [...offers.values()]
      .filter((offer) => offer.status === 'open')
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((offer) => {
        const plot = plotById(offer.plotId);
        return {
          id: offer.id,
          plotId: offer.plotId,
          districtId: plot.districtId,
          plotNo: plot.plotNo,
          assetId: plot.assetId,
          level: plot.level,
          sellerId: `user-${offer.sellerId}`,
          sellerName: offer.sellerId.split('@')[0],
          price: offer.price ?? 0,
          fee: offer.fee ?? 0,
          kind: offer.kind,
          hours: offer.hours ?? null,
          value: plotValueOf(plot),
          expiresAt: new Date(offer.expiresAt).toISOString(),
          createdAt: new Date(offer.createdAt).toISOString(),
          mine: offer.sellerId === email
        };
      });
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
      claims: [...account.claims],
      offers: liveOffers(email),
      leases: liveLeases(email),
      ledger: account.rows.slice(0, 100).map((row, index) => ({ ...row, seq: index }))
    };
  }

  let rowId = 0;
  function spend(account, email, key, delta, reason = 'admin_adjustment', ref = null) {
    if (key && account.ledger.has(key)) return { replayed: true };
    if (account.balance + delta < 0) throw new Error('السيولة غير كافية');
    account.balance += delta;
    if (key) account.ledger.add(key);
    rowId += 1;
    account.rows.unshift({
      id: rowId,
      ts: new Date(clock.now).toISOString(),
      reason,
      amount: delta,
      balanceAfter: account.balance,
      ref
    });
    if (account.rows.length > 100) account.rows.length = 100;
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
      if (spend(account, email, p_idempotency, -plot.price, 'plot_purchase', `${p_district}:${p_plot_no}`).replayed) return snapshot(email);
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
      if (spend(account, email, p_idempotency, -asset.cost, 'development', `${plot.districtId}:${plot.plotNo}`).replayed) return snapshot(email);
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
      if (spend(account, email, p_idempotency, -cost, 'upgrade', `${plot.districtId}:${plot.plotNo}`).replayed) return snapshot(email);
      plot.level += 1;
      account.xp += 90;
      return snapshot(email);
    },

    ofuq_collect_rent: (email, { p_plot, p_idempotency }) => {
      const plot = [...plots.values()].find((candidate) => candidate.id === p_plot);
      if (!plot) throw new Error('القطعة غير موجودة');
      const lease = activeLease(plot.id);
      const tenant = lease && lease.lesseeId === email;
      if (plot.owner !== email && !tenant) throw new Error('هذه القطعة ليست لك');
      // While a lease runs the income belongs to the tenant — the owner already took the fee.
      if (lease && plot.owner === email) throw new Error('القطعة مؤجَّرة — الإيجار للمستأجر حتى نهاية المدة');
      if (!plot.assetId) throw new Error('لا يوجد أصل على هذه القطعة');
      const account = accountFor(email);
      if (p_idempotency && account.ledger.has(p_idempotency)) return snapshot(email);
      const rate = rentOf(plot.assetId, plot.level, DISTRICTS[plot.districtId].tier);
      const elapsed = (clock.now - (plot.lastCollectedAt ?? clock.now)) / HOUR;
      const amount = Math.floor(Math.min(Math.max(elapsed, 0), 8) * rate);
      if (amount <= 0) throw new Error('لم يتراكم إيجار كافٍ بعد');
      account.balance += amount;
      rowId += 1;
      account.rows.unshift({
        id: rowId,
        ts: new Date(clock.now).toISOString(),
        reason: 'rent',
        amount,
        balanceAfter: account.balance,
        ref: plot.id
      });
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
      if (activeLease(plot.id)) throw new Error('القطعة مؤجَّرة — انتظر انتهاء الإيجار قبل البيع');
      const account = accountFor(email);
      const build = plot.assetId ? Math.round(ASSETS[plot.assetId].cost * (1 + 0.35 * (plot.level - 1)) * 0.9) : 0;
      const proceeds = Math.round((plot.price + build) * 0.96);
      if (spend(account, email, p_idempotency, proceeds, 'sale', `${plot.districtId}:${plot.plotNo}`).replayed) return snapshot(email);
      plot.owner = null;
      plot.assetId = null;
      plot.level = 0;
      plot.lastCollectedAt = null;
      account.plots.delete(`${plot.districtId}:${plot.plotNo}`);
      account.xp += 50;
      return snapshot(email);
    },

    ofuq_list_offer: (email, { p_plot, p_price, p_hours, p_idempotency }) => {
      const account = accountFor(email);
      if (p_idempotency && account.requests.has(p_idempotency)) return snapshot(email);
      expireOffers();
      const plot = plotById(p_plot);
      if (!plot) throw new Error('القطعة غير موجودة');
      if (plot.owner !== email) throw new Error('هذه القطعة ليست لك');
      if (!plot.assetId) throw new Error('طوّر القطعة قبل عرضها للبيع');
      if (activeLease(plot.id)) throw new Error('القطعة مؤجَّرة — انتظر انتهاء الإيجار قبل البيع');
      const price = Math.round(Number(p_price) || 0);
      if (price < 100) throw new Error('أقل سعر مسموح 100 عملة');
      if (price > 100000000) throw new Error('السعر أعلى من الحد المسموح');
      const hours = Math.min(168, Math.max(1, Math.round(Number(p_hours) || 48)));
      for (const offer of offers.values()) {
        if (offer.plotId === p_plot && offer.status === 'open') offer.status = 'cancelled';
      }
      offerSeq += 1;
      const id = `offer-${offerSeq}`;
      offers.set(id, {
        id,
        kind: 'sale',
        plotId: p_plot,
        sellerId: email,
        price,
        createdAt: clock.now,
        expiresAt: clock.now + hours * HOUR,
        status: 'open',
        buyerId: null
      });
      if (p_idempotency) account.requests.add(p_idempotency);
      return snapshot(email);
    },

    ofuq_cancel_offer: (email, { p_offer, p_idempotency }) => {
      const account = accountFor(email);
      if (p_idempotency && account.requests.has(p_idempotency)) return snapshot(email);
      const offer = offers.get(p_offer);
      if (!offer) throw new Error('العرض غير موجود');
      if (offer.sellerId !== email) throw new Error('هذا العرض ليس لك');
      expireOffers();
      if (offer.status !== 'open') throw new Error('العرض لم يعد مفتوحاً');
      offer.status = 'cancelled';
      if (p_idempotency) account.requests.add(p_idempotency);
      return snapshot(email);
    },

    ofuq_accept_offer: (email, { p_offer, p_idempotency }) => {
      const buyer = accountFor(email);
      if (p_idempotency && buyer.requests.has(p_idempotency)) return snapshot(email);
      expireOffers();
      const offer = offers.get(p_offer);
      if (!offer) throw new Error('العرض غير موجود');
      if (offer.status !== 'open') throw new Error('العرض لم يعد متاحاً');
      if (offer.kind === 'lease') throw new Error('هذا عرض إيجار — استخدم استئجار الأصل');
      if (offer.sellerId === email) throw new Error('لا يمكنك قبول عرضك');
      const plot = plotById(offer.plotId);
      if (plot.owner !== offer.sellerId) throw new Error('العرض غير صالح — تغيّرت ملكية القطعة');

      const seller = accountFor(offer.sellerId);
      const key = `${plot.districtId}:${plot.plotNo}`;
      const fee = Math.round(offer.price * 0.04);

      // Buyer pays in full; the seller is credited and charged as two separate rows.
      if (spend(buyer, email, p_idempotency && `${p_idempotency}:buy`, -offer.price, 'plot_purchase', key).replayed) {
        return snapshot(email);
      }
      spend(seller, offer.sellerId, null, offer.price, 'sale', key);
      spend(seller, offer.sellerId, null, -fee, 'market_fee', key);

      plot.owner = email;
      plot.lastCollectedAt = clock.now;
      seller.plots.delete(key);
      buyer.plots.add(key);
      buyer.xp += 40;
      seller.xp += 50;

      offer.status = 'accepted';
      offer.buyerId = email;
      if (p_idempotency) buyer.requests.add(p_idempotency);
      return snapshot(email);
    },

    ofuq_list_lease: (email, { p_plot, p_fee, p_hours, p_window, p_idempotency }) => {
      const account = accountFor(email);
      if (p_idempotency && account.requests.has(p_idempotency)) return snapshot(email);
      expireOffers();
      const plot = plotById(p_plot);
      if (!plot) throw new Error('القطعة غير موجودة');
      if (plot.owner !== email) throw new Error('هذه القطعة ليست لك');
      if (!plot.assetId) throw new Error('طوّر القطعة قبل تأجيرها');
      if (activeLease(plot.id)) throw new Error('القطعة مؤجَّرة بالفعل');
      if ([...offers.values()].some((offer) => offer.plotId === p_plot && offer.status === 'open')) {
        throw new Error('هذه القطعة معروضة بالفعل — ألغِ العرض أولاً');
      }
      const fee = Math.round(Number(p_fee) || 0);
      if (fee < 100) throw new Error('أقل مبلغ مسموح 100 عملة');
      if (fee > 100000000) throw new Error('المبلغ أعلى من الحد المسموح');
      const hours = Math.round(Number(p_hours) || 24);
      if (hours < 1 || hours > 168) throw new Error('مدة الإيجار بين 1 و168 ساعة');
      const windowHours = Math.min(168, Math.max(1, Math.round(Number(p_window) || 48)));
      offerSeq += 1;
      const id = `offer-${offerSeq}`;
      offers.set(id, {
        id,
        kind: 'lease',
        plotId: p_plot,
        sellerId: email,
        fee,
        hours,
        createdAt: clock.now,
        expiresAt: clock.now + windowHours * HOUR,
        status: 'open',
        buyerId: null
      });
      if (p_idempotency) account.requests.add(p_idempotency);
      return snapshot(email);
    },

    ofuq_accept_lease: (email, { p_offer, p_idempotency }) => {
      const tenant = accountFor(email);
      if (p_idempotency && tenant.requests.has(p_idempotency)) return snapshot(email);
      expireOffers();
      const offer = offers.get(p_offer);
      if (!offer) throw new Error('العرض غير موجود');
      if (offer.kind !== 'lease') throw new Error('هذا عرض بيع — استخدم شراء القطعة');
      if (offer.status !== 'open') throw new Error('العرض لم يعد متاحاً');
      if (offer.sellerId === email) throw new Error('لا يمكنك استئجار أصلك');
      const plot = plotById(offer.plotId);
      if (plot.owner !== offer.sellerId) throw new Error('العرض غير صالح — تغيّرت ملكية القطعة');
      if (activeLease(plot.id)) throw new Error('القطعة مؤجَّرة بالفعل');

      const lessor = accountFor(offer.sellerId);
      const key = `${plot.districtId}:${plot.plotNo}`;
      const platformFee = Math.round(offer.fee * 0.04);

      // The owner keeps the rent that accrued before the lease: settle it, then hand over.
      settleAccrued(plot);

      if (spend(tenant, email, p_idempotency && `${p_idempotency}:pay`, -offer.fee, 'lease_payment', key).replayed) {
        return snapshot(email);
      }
      spend(lessor, offer.sellerId, null, offer.fee, 'lease_income', key);
      spend(lessor, offer.sellerId, null, -platformFee, 'market_fee', key);

      leaseSeq += 1;
      leases.set(`lease-${leaseSeq}`, {
        id: `lease-${leaseSeq}`,
        offerId: offer.id,
        plotId: plot.id,
        lessorId: offer.sellerId,
        lesseeId: email,
        fee: offer.fee,
        startsAt: clock.now,
        endsAt: clock.now + offer.hours * HOUR
      });
      plot.lastCollectedAt = clock.now;
      offer.status = 'accepted';
      offer.buyerId = email;
      tenant.xp += 30;
      lessor.xp += 40;
      if (p_idempotency) tenant.requests.add(p_idempotency);
      return snapshot(email);
    },

    ofuq_claim_mission: (email, { p_mission, p_idempotency }) => {
      const account = accountFor(email);
      if (p_idempotency && account.ledger.has(p_idempotency)) return snapshot(email);
      if (account.claims.has(p_mission)) throw new Error('استلمت مكافأة هذا التحدي');
      const rewards = { own4: 800, develop3: 600 };
      if (!(p_mission in rewards)) throw new Error('التحدي غير معروف');
      if (p_mission === 'own4' && account.plots.size < 4) throw new Error('لم يكتمل التحدي بعد');
      if (spend(account, email, p_idempotency, rewards[p_mission], 'mission_reward', p_mission).replayed) return snapshot(email);
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

// Helpers the contract tests need in order to speak the same numbers as the server.
export { createFakeSupabase, HOUR, DISTRICTS, ASSETS, LEVELS, json, plotPrice, levelOf, rentOf, upgradeCost };
