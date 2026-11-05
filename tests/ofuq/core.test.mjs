import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  accrualProgress,
  challengeBoard,
  collectRent,
  districtFor,
  formatCompact,
  formatNumber,
  hourlyIncome,
  leaderboard,
  levelInfo,
  netWorth,
  netYield,
  pendingRent,
  playerScore,
  plotPrice,
  plotRent,
  plotValue,
  portfolioValue,
  saleProceeds,
  upgradeCost,
  validatePlayerName,
  weekDaysLeft,
  weekKey
} from '../../apps/ofuq/src/core.js';
import { DISTRICTS, ECONOMY } from '../../apps/ofuq/src/config.js';

const HOUR = 60 * 60 * 1000;
const harbor = districtFor('harbor');
const garden = districtFor('garden');

const plotAt = (overrides = {}) => ({ districtId: 'harbor', plotNo: 1, assetId: 'studio', level: 1, lastCollectedAt: 0, ...overrides });

test('land price scales with the district tier and rounds to 50', () => {
  assert.deepEqual(
    DISTRICTS.map((district) => plotPrice(district)),
    [400, 450, 550, 650, 800]
  );
  assert.equal(plotPrice(null), 0);
});

test('rent grows with asset level and district tier', () => {
  const level1 = plotRent(plotAt({ level: 1 }), harbor);
  const level3 = plotRent(plotAt({ level: 3 }), harbor);
  const garden1 = plotRent(plotAt({ level: 1 }), garden);

  assert.equal(level1, 34);
  assert.ok(level3 > level1, 'higher level must pay more');
  assert.ok(garden1 > level1, 'higher tier must pay more');
  assert.equal(plotRent(plotAt({ assetId: null }), harbor), 0, 'bare land earns nothing');
  assert.equal(plotRent(plotAt({ level: 99 }), harbor), plotRent(plotAt({ level: ECONOMY.maxLevel }), harbor));
});

test('accrual is capped and progress is bounded', () => {
  const plot = plotAt({ lastCollectedAt: 0 });
  assert.equal(pendingRent(plot, harbor, 2 * HOUR), 68);
  const cap = ECONOMY.accrualCapHours;
  assert.equal(pendingRent(plot, harbor, 40 * HOUR), 34 * cap, 'accrual stops at the cap');
  assert.equal(accrualProgress(plot, 4 * HOUR), 0.5);
  assert.equal(accrualProgress(plot, 99 * HOUR), 1);
  assert.equal(pendingRent({ assetId: null, lastCollectedAt: 0 }, harbor, 5 * HOUR), 0);
});

test('collectRent moves the anchor forward and discards overflow past the cap', () => {
  const plot = plotAt({ lastCollectedAt: 0 });
  const short = collectRent(plot, harbor, 2 * HOUR);
  assert.equal(short.amount, 68);
  assert.equal(short.lastCollectedAt, 2 * HOUR);

  const long = collectRent(plot, harbor, 30 * HOUR);
  assert.equal(long.amount, 34 * ECONOMY.accrualCapHours);
  assert.equal(long.lastCollectedAt, 30 * HOUR, 'overflow beyond the cap is discarded');

  assert.deepEqual(collectRent({ assetId: null, lastCollectedAt: 0 }, harbor, HOUR), { amount: 0, lastCollectedAt: 0 });
});

test('valuation, sale proceeds and upgrade pricing follow the economy constants', () => {
  const plot = plotAt();
  assert.equal(plotValue(plot, harbor), 400 + Math.round(1400 * 0.9));
  assert.equal(saleProceeds(plot, harbor), Math.round(1660 * (1 - ECONOMY.saleFeeRate)));
  assert.equal(upgradeCost(plot, harbor), 750);
  assert.equal(upgradeCost(plot, garden), 650);
});

test('portfolio aggregates value, income and yield', () => {
  const state = {
    cash: 1000,
    xp: 0,
    plots: {
      'harbor:1': plotAt({ plotNo: 1 }),
      'harbor:2': plotAt({ plotNo: 2, level: 2 }),
      'garden:1': plotAt({ districtId: 'garden', plotNo: 1, assetId: null, level: 0 })
    }
  };
  const value = portfolioValue(state);
  assert.ok(value > 0);
  assert.equal(hourlyIncome(state), plotRent(state.plots['harbor:1'], harbor) + plotRent(state.plots['harbor:2'], harbor));
  assert.equal(netWorth(state), 1000 + value);
  assert.ok(netYield(state) > 0);
  assert.equal(netYield({ cash: 0, plots: {} }), 0);
});

test('level ladder is monotonic and progress is clamped', () => {
  assert.deepEqual(levelInfo(0), { ...levelInfo(0), level: 1, name: 'مستثمر جديد', progress: 0 });
  assert.equal(levelInfo(699).level, 1);
  assert.equal(levelInfo(700).level, 2);
  assert.equal(levelInfo(32000).level, 10);
  assert.equal(levelInfo(999999).maxed, true);
  assert.equal(levelInfo(999999).progress, 1);
  assert.equal(levelInfo(1750).xpForNext, 1800 - 1750);
});

test('formatting stays readable in both compact and full form', () => {
  assert.equal(formatNumber(1234567), '1,234,567');
  assert.equal(formatCompact(9999), '9,999');
  assert.equal(formatCompact(12500), '12.5K');
  assert.equal(formatCompact(2_500_000), '2.5M');
  assert.equal(formatNumber(undefined), '0');
});

test('ISO week keys roll over on Monday', () => {
  assert.equal(weekKey(new Date('2026-01-01T12:00:00')), '2026-W01');
  assert.equal(weekKey(new Date('2026-01-04T12:00:00')), '2026-W01');
  assert.equal(weekKey(new Date('2026-01-05T12:00:00')), '2026-W02');
  assert.equal(weekDaysLeft(new Date('2026-01-04T12:00:00')), 1);
  assert.equal(weekDaysLeft(new Date('2026-01-05T12:00:00')), 7);
});

test('player names are validated and normalised', () => {
  assert.equal(validatePlayerName('  شركة   أفق  ').value, 'شركة أفق');
  assert.equal(validatePlayerName('  شركة   أفق  ').ok, true);
  assert.equal(validatePlayerName('أ').ok, false);
  assert.equal(validatePlayerName('<script>').ok, false);
  assert.equal(validatePlayerName('x'.repeat(30)).value.length, 24);
  assert.equal(validatePlayerName(null).ok, false);
});

test('challenge board reports progress and claimability per week', () => {
  const state = {
    xp: 0,
    cash: 0,
    plots: { 'harbor:1': plotAt(), 'harbor:2': plotAt({ plotNo: 2 }) },
    week: { key: weekKey(), developed: 3, collected: 8, upgraded: 0, bought: 2 },
    claims: { [weekKey()]: ['collect8'] }
  };
  const board = challengeBoard(state);
  const develop = board.find((item) => item.id === 'develop3');
  const collect = board.find((item) => item.id === 'collect8');
  const own = board.find((item) => item.id === 'own4');

  assert.equal(develop.done, true);
  assert.equal(develop.claimable, true);
  assert.equal(collect.done, true);
  assert.equal(collect.claimed, true);
  assert.equal(collect.claimable, false);
  assert.equal(own.progress, 2);
  assert.equal(own.done, false);
});

test('the leaderboard is deterministic per week and always ranks the player', () => {
  const state = { xp: 3600, cash: 5000, plots: { 'harbor:1': plotAt() }, playerName: 'أفق', stats: {} };
  const today = new Date('2026-11-05T09:00:00');
  const first = leaderboard(state, today);
  const second = leaderboard(state, today);
  assert.deepEqual(first, second, 'same week must produce the same rivals');
  assert.equal(first.filter((row) => row.you).length, 1);
  assert.deepEqual([...first].sort((a, b) => a.rank - b.rank).map((row) => row.rank), first.map((_, i) => i + 1));
  assert.ok(playerScore(state) > 0);
  assert.notDeepEqual(leaderboard(state, new Date('2026-11-12T09:00:00')).map((r) => r.score), first.map((r) => r.score));
});
