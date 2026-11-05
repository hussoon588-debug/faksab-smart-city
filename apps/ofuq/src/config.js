/**
 * OFUQ (أفق) — application configuration.
 *
 * Pure data only. Everything the simulation needs to be balanceable lives here so
 * that `core.js` can stay a set of pure functions and `tests/ofuq/*` can pin the
 * numbers down without touching the DOM.
 */

export const APP = {
  id: 'ofuq',
  name: 'أفق',
  nameEn: 'OFUQ',
  tagline: 'استثمار حضري ذكي',
  version: '0.4.0',
  storageKey: 'ofuq:v1',
  schemaVersion: 1,
  numberLocale: 'en-US',
  defaultPlayerName: 'مستثمر أفق',
  // Where the app is published from. Relative so the same build works locally,
  // under /apps/ofuq/ on GitHub Pages, and at a domain root.
  backend: {
    // 'local'    → offline shell: the wallet lives on this device only.
    // 'supabase' → the server owns balance, ownership and income
    //              (apply supabase/ofuq/schema.sql, then fill the two fields below).
    // The UI is identical in both modes; only `store.dispatch` changes behaviour.
    mode: 'local',
    supabaseUrl: '',
    publishableKey: ''
  }
};

export const ECONOMY = {
  startCash: 12000,
  plotBasePrice: 400,
  /** Accrued rent is capped so an idle week does not break the economy. */
  accrualCapHours: 8,
  /** Platform fee taken when selling an asset back to the market. */
  saleFeeRate: 0.04,
  /** Each upgrade level adds this share of rent… */
  upgradeIncomeRate: 0.35,
  /** …and costs this share of the asset price per level. */
  upgradeCostRate: 0.55,
  maxLevel: 5,
  /** Districts with a higher tier charge more and pay better. */
  tierIncomeRate: 0.15,
  xp: { buy: 40, develop: 120, upgrade: 90, collect: 6, sell: 50 }
};

/** Level ladder: cumulative XP thresholds, index + 1 = level. */
export const LEVELS = [
  { xp: 0, name: 'مستثمر جديد' },
  { xp: 700, name: 'مالك قطعة' },
  { xp: 1800, name: 'مطوّر ناشئ' },
  { xp: 3600, name: 'مستثمر محلي' },
  { xp: 6000, name: 'مطوّر حضري' },
  { xp: 9000, name: 'مستثمر إقليمي' },
  { xp: 13000, name: 'شريك تطوير' },
  { xp: 18000, name: 'صندوق عقاري' },
  { xp: 24500, name: 'مستثمر استراتيجي' },
  { xp: 32000, name: 'قطب حضري' }
];

/** Five districts, twenty plots each: the city is a 100-plot grid. */
export const DISTRICTS = [
  { id: 'harbor', name: 'حي الميناء', tier: 1.0, unlockLevel: 1, accent: '#3ad6ff', plots: 20 },
  { id: 'garden', name: 'حي الحدائق', tier: 1.15, unlockLevel: 1, accent: '#33e08c', plots: 20 },
  { id: 'downtown', name: 'المركز التجاري', tier: 1.35, unlockLevel: 2, accent: '#ffd24a', plots: 20 },
  { id: 'tech', name: 'وادي التقنية', tier: 1.6, unlockLevel: 3, accent: '#8a6bff', plots: 20 },
  { id: 'horizon', name: 'أفق الشمال', tier: 2.0, unlockLevel: 4, accent: '#ff8a5c', plots: 20 }
];

/** Developable asset classes. Cheaper assets pay less per hour. */
export const ASSET_TYPES = [
  { id: 'studio', name: 'سكني', cost: 1400, rent: 34, unlockLevel: 1, icon: 'home' },
  { id: 'retail', name: 'تجاري', cost: 3000, rent: 82, unlockLevel: 2, icon: 'store' },
  { id: 'office', name: 'مكتبي', cost: 5600, rent: 168, unlockLevel: 3, icon: 'tower' },
  { id: 'hospitality', name: 'فندقي', cost: 9500, rent: 300, unlockLevel: 5, icon: 'star' }
];

/**
 * Weekly challenges. `metric` is resolved by `core.challengeProgress` so the
 * rules stay declarative and testable.
 */
export const WEEKLY_CHALLENGES = [
  { id: 'develop3', title: 'ثلاثة أصول', desc: 'طوّر ثلاثة أصول هذا الأسبوع', metric: 'developed', target: 3, reward: 600, xp: 90 },
  { id: 'collect8', title: 'حصّاد الإيجارات', desc: 'حصّل الإيجارات 8 مرات', metric: 'collected', target: 8, reward: 750, xp: 110 },
  { id: 'upgrade2', title: 'رفع السقف', desc: 'رقِّ أصلين إلى مستوى أعلى', metric: 'upgraded', target: 2, reward: 650, xp: 100 },
  { id: 'own4', title: 'محفظة متنوعة', desc: 'امتلك 4 قطع في المدينة', metric: 'plotsOwned', target: 4, reward: 800, xp: 120 }
];

/** Deterministic rival league (no server needed for the foundation). */
export const RIVALS = [
  { name: 'صندوق المدى', tag: 'مؤسسي' },
  { name: 'شركة الواجهة', tag: 'تطوير' },
  { name: 'بيت العمران', tag: 'عائلي' },
  { name: 'مجموعة النخيل', tag: 'استثماري' },
  { name: 'أبراج السرو', tag: 'تجاري' },
  { name: 'رائد الأفق', tag: 'فردي' },
  { name: 'مدينة الغد', tag: 'حضري' }
];
