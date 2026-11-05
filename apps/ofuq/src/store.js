/**
 * OFUQ — state container.
 *
 * Owns persistence (localStorage by default, any adapter in tests), schema
 * migration and every mutation. Actions return `{ ok, message }` so the UI never
 * has to re-derive why something failed. The store is the only place that writes.
 */
import { APP, ECONOMY, DISTRICTS } from './config.js';
import { createIdempotencyKey, snapshotToState } from './remote.js';
import {
  assetFor,
  challengeBoard,
  collectRent,
  districtFor,
  levelInfo,
  pendingRent,
  plotKey,
  plotPrice,
  plotValue,
  saleProceeds,
  upgradeCost,
  validatePlayerName,
  weekKey
} from './core.js';

const num = (value, fallback = 0) => (Number.isFinite(value) ? value : fallback);
const int = (value, fallback = 0) => (Number.isFinite(value) ? Math.trunc(value) : fallback);

export function createInitialState(now = Date.now()) {
  return {
    schemaVersion: APP.schemaVersion,
    playerName: APP.defaultPlayerName,
    createdAt: now,
    cash: ECONOMY.startCash,
    xp: 0,
    plots: {},
    claims: {},
    week: { key: weekKey(new Date(now)), developed: 0, collected: 0, upgraded: 0, bought: 0 },
    stats: { collected: 0, developed: 0, upgraded: 0, sold: 0, earned: 0 },
    settings: { haptics: true }
  };
}

/** Coerce anything found in storage into a valid state. Never throws. */
export function migrate(raw, now = Date.now()) {
  const base = createInitialState(now);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { state: base, migrated: false };

  const state = {
    ...base,
    playerName: validatePlayerName(raw.playerName).ok ? validatePlayerName(raw.playerName).value : base.playerName,
    createdAt: num(raw.createdAt, base.createdAt),
    cash: Math.max(0, num(raw.cash, base.cash)),
    xp: Math.max(0, num(raw.xp, 0)),
    plots: {},
    claims: {},
    week: { ...base.week, ...(typeof raw.week === 'object' && raw.week ? raw.week : {}) },
    stats: { ...base.stats, ...(typeof raw.stats === 'object' && raw.stats ? raw.stats : {}) },
    settings: { ...base.settings, ...(typeof raw.settings === 'object' && raw.settings ? raw.settings : {}) }
  };

  for (const [key, plot] of Object.entries(raw.plots ?? {})) {
    const district = districtFor(plot?.districtId);
    const plotNo = int(plot?.plotNo, 0);
    if (!district || plotNo < 1 || plotNo > district.plots) continue;
    const asset = plot.assetId ? assetFor(plot.assetId) : null;
    state.plots[plotKey(district.id, plotNo)] = {
      districtId: district.id,
      plotNo,
      assetId: asset ? asset.id : null,
      level: asset ? Math.min(ECONOMY.maxLevel, Math.max(1, int(plot.level, 1))) : 0,
      purchasedAt: num(plot.purchasedAt, now),
      lastCollectedAt: num(plot.lastCollectedAt, now)
    };
  }

  for (const [week, ids] of Object.entries(raw.claims ?? {})) {
    if (Array.isArray(ids)) state.claims[week] = ids.filter((id) => typeof id === 'string');
  }

  const migrated = raw.schemaVersion !== APP.schemaVersion;
  return { state, migrated };
}

export function createMemoryStorage(seed = null) {
  let value = seed;
  return {
    read: () => value,
    write: (next) => {
      value = next;
    },
    clear: () => {
      value = null;
    }
  };
}

function browserStorage() {
  try {
    const probe = '__ofuq_probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return {
      read: () => window.localStorage.getItem(APP.storageKey),
      write: (value) => window.localStorage.setItem(APP.storageKey, value),
      clear: () => window.localStorage.removeItem(APP.storageKey)
    };
  } catch {
    // Private mode / blocked storage: keep playing in memory, warn once.
    return { read: () => null, write: () => {}, clear: () => {}, ephemeral: true };
  }
}

export function createStore({ storage = browserStorage(), now = () => Date.now(), onError = () => {}, remote = null } = {}) {
  const listeners = new Set();
  let state;
  let ephemeral = Boolean(storage.ephemeral);

  try {
    const raw = storage.read();
    const parsed = raw ? JSON.parse(raw) : null;
    state = migrate(parsed, now()).state;
  } catch (error) {
    onError('تعذر قراءة الحفظ السابق، بدأنا نسخة جديدة.', error);
    state = createInitialState(now());
  }

  function rollWeek() {
    const key = weekKey(new Date(now()));
    if (state.week?.key !== key) {
      state.week = { key, developed: 0, collected: 0, upgraded: 0, bought: 0 };
    }
  }

  function persist() {
    rollWeek();
    try {
      storage.write(JSON.stringify(state));
    } catch (error) {
      ephemeral = true;
      onError('تعذر حفظ التقدم على هذا الجهاز.', error);
    }
  }

  function emit() {
    persist();
    for (const listener of listeners) listener(state);
  }

  const level = () => levelInfo(state.xp).level;

  const actions = {
    buy(districtId, plotNo) {
      rollWeek();
      const district = districtFor(districtId);
      if (!district) return { ok: false, message: 'الحي غير معروف.' };
      if (level() < district.unlockLevel) {
        return { ok: false, message: `${district.name} يُفتح في المستوى ${district.unlockLevel}.` };
      }
      const no = int(plotNo);
      if (no < 1 || no > district.plots) return { ok: false, message: 'رقم القطعة خارج نطاق الحي.' };
      const key = plotKey(district.id, no);
      if (state.plots[key]) return { ok: false, message: 'هذه القطعة مملوكة لك بالفعل.' };
      const price = plotPrice(district);
      if (state.cash < price) return { ok: false, message: 'السيولة غير كافية لشراء هذه القطعة.' };

      const stamp = now();
      state.cash -= price;
      state.plots[key] = { districtId: district.id, plotNo: no, assetId: null, level: 0, purchasedAt: stamp, lastCollectedAt: stamp };
      state.xp += ECONOMY.xp.buy;
      state.week.bought += 1;
      emit();
      return { ok: true, message: `تملك قطعة ${no} في ${district.name}. طوّرها لتبدأ الدخل.` };
    },

    develop(key, assetId) {
      rollWeek();
      const plot = state.plots[key];
      if (!plot) return { ok: false, message: 'القطعة غير موجودة في محفظتك.' };
      if (plot.assetId) return { ok: false, message: 'القطعة مطوّرة بالفعل.' };
      const asset = assetFor(assetId);
      if (!asset) return { ok: false, message: 'نوع الأصل غير معروف.' };
      if (level() < asset.unlockLevel) return { ok: false, message: `الأصل ${asset.name} يُفتح في المستوى ${asset.unlockLevel}.` };
      if (state.cash < asset.cost) return { ok: false, message: 'السيولة غير كافية لبناء هذا الأصل.' };

      state.cash -= asset.cost;
      plot.assetId = asset.id;
      plot.level = 1;
      plot.lastCollectedAt = now();
      state.xp += ECONOMY.xp.develop;
      state.stats.developed += 1;
      state.week.developed += 1;
      emit();
      return { ok: true, message: `تم تطوير أصل ${asset.name} — يبدأ الإيجار بالتراكم.` };
    },

    upgrade(key) {
      rollWeek();
      const plot = state.plots[key];
      if (!plot?.assetId) return { ok: false, message: 'طوّر القطعة أولاً.' };
      if (plot.level >= ECONOMY.maxLevel) return { ok: false, message: 'وصل الأصل إلى أعلى مستوى.' };
      const cost = upgradeCost(plot, districtFor(plot.districtId));
      if (state.cash < cost) return { ok: false, message: 'السيولة غير كافية للترقية.' };

      state.cash -= cost;
      plot.level += 1;
      state.xp += ECONOMY.xp.upgrade;
      state.stats.upgraded += 1;
      state.week.upgraded += 1;
      emit();
      return { ok: true, message: `تمت الترقية إلى المستوى ${plot.level}.` };
    },

    collect(key) {
      rollWeek();
      const plot = state.plots[key];
      if (!plot?.assetId) return { ok: false, message: 'لا يوجد أصل على هذه القطعة.' };
      const { amount, lastCollectedAt } = collectRent(plot, districtFor(plot.districtId), now());
      if (amount <= 0) return { ok: false, message: 'لم يتراكم إيجار كافٍ بعد.' };

      plot.lastCollectedAt = lastCollectedAt;
      state.cash += amount;
      state.xp += ECONOMY.xp.collect;
      state.stats.collected += 1;
      state.stats.earned += amount;
      state.week.collected += 1;
      emit();
      return { ok: true, amount, message: `تم تحصيل ${amount.toLocaleString(APP.numberLocale)} عملة.` };
    },

    collectAll() {
      rollWeek();
      const stamp = now();
      let total = 0;
      let count = 0;
      for (const plot of Object.values(state.plots)) {
        const { amount, lastCollectedAt } = collectRent(plot, districtFor(plot.districtId), stamp);
        if (amount <= 0) continue;
        plot.lastCollectedAt = lastCollectedAt;
        total += amount;
        count += 1;
      }
      if (total <= 0) return { ok: false, message: 'لا يوجد إيجار جاهز للتحصيل.' };

      state.cash += total;
      state.xp += ECONOMY.xp.collect * count;
      state.stats.collected += count;
      state.stats.earned += total;
      state.week.collected += count;
      emit();
      return { ok: true, amount: total, message: `تم تحصيل ${total.toLocaleString(APP.numberLocale)} عملة من ${count} أصل.` };
    },

    sell(key) {
      rollWeek();
      const plot = state.plots[key];
      if (!plot) return { ok: false, message: 'القطعة غير موجودة.' };
      const district = districtFor(plot.districtId);
      const proceeds = saleProceeds(plot, district);
      const value = plotValue(plot, district);
      delete state.plots[key];
      state.cash += proceeds;
      state.xp += ECONOMY.xp.sell;
      state.stats.sold += 1;
      emit();
      return {
        ok: true,
        message: `تم البيع بـ ${proceeds.toLocaleString(APP.numberLocale)} عملة (قيمة ${value.toLocaleString(APP.numberLocale)} بعد عمولة ${Math.round(ECONOMY.saleFeeRate * 100)}%).`
      };
    },

    claim(challengeId) {
      rollWeek();
      const week = weekKey(new Date(now()));
      const challenge = challengeBoard(state, week).find((item) => item.id === challengeId);
      if (!challenge) return { ok: false, message: 'التحدي غير معروف.' };
      if (challenge.claimed) return { ok: false, message: 'استلمت مكافأة هذا التحدي.' };
      if (!challenge.done) return { ok: false, message: 'لم يكتمل التحدي بعد.' };

      state.claims[week] = [...(state.claims[week] ?? []), challenge.id];
      state.cash += challenge.reward;
      state.xp += challenge.xp;
      state.stats.earned += challenge.reward;
      emit();
      return { ok: true, message: `مكافأة التحدي: ${challenge.reward.toLocaleString(APP.numberLocale)} عملة.` };
    },

    setName(rawName) {
      const result = validatePlayerName(rawName);
      if (!result.ok) return { ok: false, message: result.error };
      state.playerName = result.value;
      emit();
      return { ok: true, message: 'تم تحديث اسم المستثمر.' };
    },

    toggleHaptics() {
      state.settings.haptics = !state.settings.haptics;
      emit();
      return { ok: true, message: state.settings.haptics ? 'الاهتزاز مفعّل.' : 'الاهتزاز مغلق.' };
    },

    reset() {
      // In the shared city the wallet belongs to the server: wiping the local mirror
      // would hide (not delete) the real account, which is exactly the lie to avoid.
      if (remote) return { ok: false, message: 'لا يمكن حذف التقدم في المدينة المشتركة — سجّل الخروج أولاً.' };
      state = createInitialState(now());
      state.playerName = APP.defaultPlayerName;
      emit();
      return { ok: true, message: 'بدأت محفظة جديدة.' };
    },

    /** Called by the UI on a timer; it only refreshes the view, nothing is written. */
    refresh() {
      for (const listener of listeners) listener(state);
    }
  };

  /** Replace server-owned fields with the authoritative snapshot (remote mode). */
  function applySnapshot(snapshot) {
    const next = snapshotToState(snapshot, state);
    if (!next) return false;
    state = next;
    emit();
    return true;
  }

  const localHandlers = {
    buy: ({ districtId, plotNo }) => actions.buy(districtId, plotNo),
    develop: ({ plotKey: key, assetId }) => actions.develop(key, assetId),
    upgrade: ({ plotKey: key }) => actions.upgrade(key),
    collect: ({ plotKey: key }) => actions.collect(key),
    collectAll: () => actions.collectAll(),
    sell: ({ plotKey: key }) => actions.sell(key),
    claim: ({ challengeId }) => actions.claim(challengeId),
    setName: ({ name }) => actions.setName(name),
    toggleHaptics: () => actions.toggleHaptics(),
    reset: () => actions.reset()
  };

  /**
   * Single entry point used by the UI. In local mode it runs the local reducer; in
   * server mode it sends *intent only* (plus an idempotency key) and adopts whatever
   * snapshot the server returns. The UI code does not change between modes.
   */
  function dispatch(type, payload = {}) {
    const local = localHandlers[type];
    if (!local) return { ok: false, message: `إجراء غير معروف: ${type}` };
    // Local mode stays synchronous, so the UI renders in the same tick.
    return remote ? dispatchRemote(type, payload) : local(payload);
  }

  async function dispatchRemote(type, payload = {}) {
    const local = localHandlers[type];
    const before = state.cash;
    const plotFor = () => state.plots[payload.plotKey] ?? null;

    try {
      let result;
      switch (type) {
        case 'buy':
          result = await remote.purchasePlot({
            districtId: payload.districtId,
            plotNo: payload.plotNo,
            idempotencyKey: payload.idempotencyKey ?? createIdempotencyKey('purchase')
          });
          break;
        case 'develop':
        case 'upgrade':
        case 'collect':
        case 'sell': {
          const plot = plotFor();
          if (!plot?.id) return { ok: false, message: 'هذه القطعة غير مسجّلة على الخادم بعد.' };
          const call = { develop: 'developPlot', upgrade: 'upgradePlot', collect: 'collectRent', sell: 'sellPlot' }[type];
          result = await remote[call]({
            plotId: plot.id,
            assetId: payload.assetId,
            idempotencyKey: payload.idempotencyKey ?? createIdempotencyKey(type)
          });
          break;
        }
        case 'collectAll': {
          const ready = Object.values(state.plots).filter((plot) => plot.id);
          if (ready.length === 0) return { ok: false, message: 'لا يوجد إيجار جاهز للتحصيل.' };
          let collected = 0;
          for (const plot of ready) {
            const one = await remote.collectRent({ plotId: plot.id, idempotencyKey: createIdempotencyKey('collect') });
            if (one.ok && one.snapshot) applySnapshot(one.snapshot);
            else if (one.message && !/لم يتراكم/.test(one.message)) return { ok: false, message: one.message };
            else collected += 1;
          }
          if (collected === 0) return { ok: false, message: 'لا يوجد إيجار جاهز للتحصيل.' };
          return { ok: true, message: `تم تحصيل ${(state.cash - before).toLocaleString(APP.numberLocale)} عملة.` };
        }
        case 'claim':
          result = await remote.claimMission({
            missionId: payload.challengeId,
            idempotencyKey: payload.idempotencyKey ?? createIdempotencyKey('claim')
          });
          break;
        case 'setName':
          // Profile text is local; the server keeps the display name it was created with.
          return local(payload);
        default:
          return local(payload);
      }

      if (!result.ok) return { ok: false, message: result.message || 'تعذر تنفيذ الطلب.' };
      if (result.snapshot) applySnapshot(result.snapshot);

      const gained = state.cash - before;
      const messages = {
        buy: `تملك قطعة ${payload.plotNo} — طوّرها لتبدأ الدخل.`,
        develop: 'تم تطوير الأصل — يبدأ الإيجار بالتراكم.',
        upgrade: 'تمت الترقية.',
        collect: `تم تحصيل ${gained.toLocaleString(APP.numberLocale)} عملة.`,
        sell: `تم البيع بـ ${gained.toLocaleString(APP.numberLocale)} عملة.`,
        claim: `تم استلام مكافأة التحدي (${gained.toLocaleString(APP.numberLocale)} عملة).`
      };
      return { ok: true, message: messages[type] ?? 'تم التنفيذ.' };
    } catch (error) {
      onError('تعذر إكمال العملية على الخادم.', error);
      return { ok: false, message: error?.message || 'تعذر الاتصال بالمدينة المشتركة.' };
    }
  }

  /* ------------------------------------------------------------------ auth --- */

  const NO_SERVER = { ok: false, message: 'هذه النسخة تعمل محلياً — لا يوجد خادم مُهيّأ.' };

  /**
   * Account API. Local mode answers honestly instead of offering a button that cannot work;
   * server mode delegates to `remote` and adopts the snapshot the server returns.
   */
  const auth = {
    get available() {
      return Boolean(remote);
    },
    get signedIn() {
      return Boolean(remote?.signedIn);
    },
    get email() {
      return remote?.user?.email ?? null;
    },

    /** Try the stored session on boot. Never toasts on the "no session" path. */
    async restore() {
      if (!remote) return NO_SERVER;
      const result = await remote.restoreSession();
      if (!result?.ok) return { ok: false, message: result?.message ?? 'لا توجد جلسة محفوظة.' };
      if (result.snapshot) applySnapshot(result.snapshot);
      return { ok: true, message: 'مرحباً بعودتك.' };
    },

    async signIn(email, password) {
      if (!remote) return NO_SERVER;
      const result = await remote.signIn(String(email ?? '').trim(), String(password ?? ''));
      if (!result.ok) return { ok: false, message: result.message };
      const sync = await syncFromServer();
      return sync.ok
        ? { ok: true, message: 'تم تسجيل الدخول ومزامنة المدينة.' }
        : { ok: true, message: 'تم تسجيل الدخول — تعذر تحميل المدينة الآن.' };
    },

    async signUp(email, password, displayName) {
      if (!remote) return NO_SERVER;
      const result = await remote.signUp(String(email ?? '').trim(), String(password ?? ''), displayName);
      if (!result.ok) return { ok: false, message: result.message };
      const sync = await syncFromServer();
      return sync.ok
        ? { ok: true, message: 'تم إنشاء الحساب ومزامنة المدينة.' }
        : { ok: true, message: 'تم إنشاء الحساب — تعذر تحميل المدينة الآن.' };
    },

    /** The mirror stays on screen (the city is still readable) but nothing can be written. */
    async signOut() {
      if (!remote) return NO_SERVER;
      const result = await remote.signOut();
      emit();
      return result;
    }
  };

  async function syncFromServer() {
    if (!remote?.snapshot) return { ok: false, message: 'لا يوجد خادم مُهيّأ.' };
    const result = await remote.snapshot();
    if (!result.ok) return result;
    applySnapshot(result.snapshot);
    return { ok: true, message: 'تمت مزامنة المدينة.' };
  }

  rollWeek();
  persist();

  return {
    get state() {
      rollWeek();
      return state;
    },
    get ephemeral() {
      return ephemeral;
    },
    /** 'local' (offline shell) or 'supabase' (server owns balance + ownership). */
    get mode() {
      return remote ? 'supabase' : 'local';
    },
    get remote() {
      return remote;
    },
    dispatch,
    syncFromServer,
    auth,
    applySnapshot,
    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    /** Read-only snapshot helper for the UI (pending rents, level, board). */
    snapshot(stamp = now()) {
      rollWeek();
      return {
        state,
        level: levelInfo(state.xp),
        pending: Object.fromEntries(
          Object.entries(state.plots).map(([key, plot]) => [key, pendingRent(plot, districtFor(plot.districtId), stamp)])
        ),
        challenges: challengeBoard(state),
        districts: DISTRICTS
      };
    },
    ...actions
  };
}
