/**
 * OFUQ — pure simulation core.
 *
 * No DOM, no storage, no clock of its own: every function takes what it needs and
 * returns a value. That keeps the economy unit-testable and lets the UI stay dumb.
 */
import { APP, ECONOMY, LEVELS, DISTRICTS, ASSET_TYPES, RIVALS, WEEKLY_CHALLENGES } from './config.js';

export const HOUR_MS = 60 * 60 * 1000;

/* ------------------------------------------------------------------ utils --- */

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function roundTo(value, step = 50) {
  return Math.round(value / step) * step;
}

export function formatNumber(value) {
  const n = Number.isFinite(value) ? value : 0;
  return n.toLocaleString(APP.numberLocale);
}

export function formatCompact(value) {
  const n = Math.abs(Number.isFinite(value) ? value : 0);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  return formatNumber(Math.round(n));
}

export const districtFor = (id) => DISTRICTS.find((district) => district.id === id) ?? null;
export const assetFor = (id) => ASSET_TYPES.find((asset) => asset.id === id) ?? null;

/* --------------------------------------------------------------- economy --- */

export function plotPrice(district) {
  if (!district) return 0;
  return roundTo(ECONOMY.plotBasePrice * district.tier, 50);
}

/** Hourly rent for one developed plot at a given level. */
export function plotRent(plot, district) {
  const asset = assetFor(plot?.assetId);
  if (!asset || !district) return 0;
  const level = clamp(plot.level ?? 1, 1, ECONOMY.maxLevel);
  const tierBoost = 1 + ECONOMY.tierIncomeRate * (district.tier - 1);
  return Math.round(asset.rent * (1 + ECONOMY.upgradeIncomeRate * (level - 1)) * tierBoost);
}

export function upgradeCost(plot, district) {
  const asset = assetFor(plot?.assetId);
  if (!asset) return 0;
  const level = clamp(plot.level ?? 1, 1, ECONOMY.maxLevel);
  return roundTo(asset.cost * ECONOMY.upgradeCostRate * level / district.tier, 50);
}

export const accrualCapMs = () => ECONOMY.accrualCapHours * HOUR_MS;

/** Rent accrued since the last collection, capped at `accrualCapHours`. */
export function pendingRent(plot, district, now) {
  if (!plot?.assetId) return 0;
  const rate = plotRent(plot, district);
  if (rate <= 0) return 0;
  const elapsed = clamp(now - (plot.lastCollectedAt ?? now), 0, accrualCapMs());
  return Math.floor((elapsed / HOUR_MS) * rate);
}

/** Collect accrued rent: returns the amount and the new accrual anchor. */
export function collectRent(plot, district, now) {
  const last = plot?.lastCollectedAt ?? now;
  const rate = plotRent(plot, district);
  if (!plot?.assetId || rate <= 0) return { amount: 0, lastCollectedAt: last };
  const elapsed = Math.max(0, now - last);
  const capped = Math.min(elapsed, accrualCapMs());
  const amount = Math.floor((capped / HOUR_MS) * rate);
  // Time beyond the cap is lost, exactly like the cap itself says.
  return { amount, lastCollectedAt: elapsed > accrualCapMs() ? now : last + capped };
}

/** Accrual progress 0..1 toward the cap — used by the UI ring. */
export function accrualProgress(plot, now) {
  if (!plot?.assetId) return 0;
  return clamp((now - (plot.lastCollectedAt ?? now)) / accrualCapMs(), 0, 1);
}

/** Book value of a plot: land price plus depreciated development cost. */
export function plotValue(plot, district) {
  if (!plot || !district) return 0;
  const land = plotPrice(district);
  const asset = assetFor(plot.assetId);
  if (!asset) return land;
  const level = clamp(plot.level ?? 1, 1, ECONOMY.maxLevel);
  const build = asset.cost * (1 + ECONOMY.upgradeIncomeRate * (level - 1)) * 0.9;
  return Math.round(land + build);
}

export const saleProceeds = (plot, district) => Math.round(plotValue(plot, district) * (1 - ECONOMY.saleFeeRate));

export const listPlots = (state) => Object.values(state.plots ?? {});

export function portfolioValue(state) {
  return listPlots(state).reduce((sum, plot) => sum + plotValue(plot, districtFor(plot.districtId)), 0);
}

export function hourlyIncome(state) {
  return listPlots(state).reduce((sum, plot) => sum + plotRent(plot, districtFor(plot.districtId)), 0);
}

export const netWorth = (state) => (state.cash ?? 0) + portfolioValue(state);

export function netYield(state) {
  const value = portfolioValue(state);
  if (value <= 0) return 0;
  return (hourlyIncome(state) * 24 * 365) / value;
}

export const pendingTotal = (state, now) =>
  listPlots(state).reduce((sum, plot) => sum + pendingRent(plot, districtFor(plot.districtId), now), 0);

/** League score blends wealth, progress and activity so it cannot be bought alone. */
export function playerScore(state) {
  const stats = state.stats ?? {};
  return Math.round(
    netWorth(state) +
      (state.xp ?? 0) * 8 +
      (stats.collected ?? 0) * 30 +
      (stats.developed ?? 0) * 120 +
      levelInfo(state.xp ?? 0).level * 400
  );
}

/* ----------------------------------------------------------------- levels --- */

export function levelInfo(xp = 0) {
  const safeXp = Math.max(0, xp);
  let index = 0;
  for (let i = 0; i < LEVELS.length; i += 1) if (safeXp >= LEVELS[i].xp) index = i;
  const current = LEVELS[index];
  const next = LEVELS[index + 1] ?? null;
  const span = next ? next.xp - current.xp : 1;
  const into = safeXp - current.xp;
  return {
    level: index + 1,
    name: current.name,
    xp: safeXp,
    xpIntoLevel: into,
    xpForNext: next ? next.xp - safeXp : 0,
    progress: next ? clamp(into / span, 0, 1) : 1,
    maxed: !next
  };
}

/* ------------------------------------------------------------------ weeks --- */

const DAY_MS = 24 * HOUR_MS;

/** ISO-8601 week key, e.g. 2026-W45. Weeks start on Monday. */
export function weekKey(date = new Date()) {
  const utc = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((utc - yearStart) / DAY_MS + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export const weekDaysLeft = (date = new Date()) => 8 - (date.getDay() || 7);

/* --------------------------------------------------------------- rivals ---- */

/** Deterministic 0..1 stream seeded by the week, so rivals are stable per week. */
function seeded(seedString) {
  let h = 2166136261;
  for (let i = 0; i < seedString.length; i += 1) {
    h ^= seedString.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function rivalRows(state, date = new Date()) {
  const random = seeded(`${weekKey(date)}:ofuq`);
  const scale = 1 + Math.min(levelInfo(state.xp ?? 0).level, 10) * 0.06;
  return RIVALS.map((rival) => ({
    name: rival.name,
    tag: rival.tag,
    score: Math.round((52000 + random() * 46000) * scale),
    you: false
  }));
}

export function leaderboard(state, date = new Date()) {
  const rows = [
    ...rivalRows(state, date),
    { name: state.playerName || APP.defaultPlayerName, tag: 'أنت', score: playerScore(state), you: true }
  ].sort((a, b) => b.score - a.score);
  return rows.map((row, index) => ({ ...row, rank: index + 1 }));
}

/* ------------------------------------------------------------ challenges --- */

export function challengeMetric(state, metric, week = weekKey()) {
  const weekly = state.week?.key === week ? state.week : {};
  switch (metric) {
    case 'developed':
      return weekly.developed ?? 0;
    case 'collected':
      return weekly.collected ?? 0;
    case 'upgraded':
      return weekly.upgraded ?? 0;
    case 'plotsOwned':
      return listPlots(state).length;
    default:
      return 0;
  }
}

export function challengeBoard(state, week = weekKey()) {
  const claimed = state.claims?.[week] ?? [];
  return WEEKLY_CHALLENGES.map((challenge) => {
    const progress = Math.min(challengeMetric(state, challenge.metric, week), challenge.target);
    const done = progress >= challenge.target;
    return {
      ...challenge,
      progress,
      done,
      claimed: claimed.includes(challenge.id),
      claimable: done && !claimed.includes(challenge.id)
    };
  });
}

/* -------------------------------------------------------------- validation --- */

export function validatePlayerName(rawName) {
  const name = String(rawName ?? '').trim().replace(/\s+/g, ' ');
  if (name.length < 2) return { ok: false, value: name, error: 'الاسم قصير جداً (حرفان على الأقل).' };
  if (name.length > 24) return { ok: false, value: name.slice(0, 24), error: 'الاسم طويل جداً (24 حرفاً كحد أقصى).' };
  if (/[<>]/.test(name)) return { ok: false, value: name, error: 'استخدم حروفاً وأرقاماً فقط.' };
  return { ok: true, value: name, error: '' };
}

export const plotKey = (districtId, plotNo) => `${districtId}:${plotNo}`;

export function districtStats(state, district) {
  const plots = listPlots(state).filter((plot) => plot.districtId === district.id);
  return {
    total: district.plots,
    owned: plots.length,
    developed: plots.filter((plot) => plot.assetId).length,
    value: plots.reduce((sum, plot) => sum + plotValue(plot, district), 0)
  };
}

/** Assets the player may build right now (level gate only). */
export const unlockedAssets = (level) => ASSET_TYPES.filter((asset) => asset.unlockLevel <= level);

/* ----------------------------------------------------------------- ledger --- */

/**
 * Every movement of money has a reason, and the reasons are the same strings the
 * database writes (`ofuq_ledger.reason`), so a local ledger and a server ledger read
 * identically in the UI.
 */
export const LEDGER_REASONS = {
  signup_bonus: { label: 'رصيد البداية', kind: 'in' },
  opening_balance: { label: 'رصيد افتتاحي', kind: 'in' },
  plot_purchase: { label: 'شراء قطعة', kind: 'out' },
  development: { label: 'تطوير أصل', kind: 'out' },
  upgrade: { label: 'ترقية أصل', kind: 'out' },
  rent: { label: 'إيجار محصّل', kind: 'in' },
  sale: { label: 'بيع أصل', kind: 'in' },
  mission_reward: { label: 'مكافأة تحدي', kind: 'in' },
  market_fee: { label: 'عمولة سوق', kind: 'out' },
  admin_adjustment: { label: 'تعديل إداري', kind: 'in' }
};

export const ledgerLabel = (reason) => LEDGER_REASONS[reason]?.label ?? 'حركة غير معروفة';

/** Totals for the wallet header. `net` is what the balance should have moved by. */
export function ledgerTotals(entries = []) {
  let inflow = 0;
  let outflow = 0;
  for (const entry of entries) {
    const amount = Number(entry?.amount ?? 0);
    if (amount >= 0) inflow += amount;
    else outflow += -amount;
  }
  return { inflow, outflow, net: inflow - outflow, count: entries.length };
}

/** Entries that touched one plot — the plot sheet's own history. */
export const plotLedger = (entries = [], key) => entries.filter((entry) => entry.ref === key);

/**
 * The ledger is trustworthy only if it explains the balance. The newest entry records the
 * balance after it, so the two must agree; an empty ledger is trivially consistent only
 * when the wallet is untouched.
 */
export function ledgerReconciles(entries = [], cash = 0) {
  if (entries.length === 0) return true;
  const newest = entries.reduce((latest, entry) => (entry.ts > latest.ts ? entry : latest), entries[0]);
  return Number(newest.balanceAfter) === Number(cash);
}

/** Group newest-first entries by calendar day for the wallet list. */
export function groupLedger(entries = [], now = Date.now()) {
  const today = new Date(now);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const groups = new Map();
  for (const entry of entries) {
    const date = new Date(entry.ts);
    const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    const key = String(dayStart);
    if (!groups.has(key)) {
      const dayIndex = Math.round((startOfToday - dayStart) / DAY_MS);
      const label =
        dayIndex === 0
          ? 'اليوم'
          : dayIndex === 1
            ? 'أمس'
            : date.toLocaleDateString('ar', { day: 'numeric', month: 'long' });
      groups.set(key, { key, label, entries: [], net: 0 });
    }
    const group = groups.get(key);
    group.entries.push(entry);
    group.net += Number(entry.amount ?? 0);
  }
  return [...groups.values()];
}
