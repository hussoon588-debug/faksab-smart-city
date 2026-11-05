/**
 * OFUQ — state container.
 *
 * Owns persistence (localStorage by default, any adapter in tests), schema
 * migration and every mutation. Actions return `{ ok, message }` so the UI never
 * has to re-derive why something failed. The store is the only place that writes.
 */
import { APP, ECONOMY, DISTRICTS } from './config.js';
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

export function createStore({ storage = browserStorage(), now = () => Date.now(), onError = () => {} } = {}) {
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
