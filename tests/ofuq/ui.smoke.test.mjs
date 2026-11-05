// DOM smoke test for the OFUQ shell. `jsdom` is a dev-only dependency; when it is
// not installed the suite skips instead of failing, so `npm test` still works offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

let JSDOM = null;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  JSDOM = null;
}

const HOUR = 60 * 60 * 1000;

async function boot() {
  const html = await readFile(path.join(ROOT, 'apps/ofuq/index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost:8000/apps/ofuq/', pretendToBeVisual: true });
  dom.window.scrollTo = () => {};
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};

  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });

  const { createMemoryStorage, createStore } = await import('../../apps/ofuq/src/store.js');
  const { mount } = await import('../../apps/ofuq/src/ui.js');

  const clock = { now: Date.now() };
  const store = createStore({ storage: createMemoryStorage(), now: () => clock.now });
  const ui = mount(store);
  return { dom, store, ui, clock, $: (id) => dom.window.document.getElementById(id) };
}

test('OFUQ shell renders and the investment loop works end to end', { skip: !JSDOM && 'jsdom not installed (run npm install)' }, async (t) => {
  const { dom, store, ui, clock, $ } = await boot();
  t.after(() => {
    ui.destroy();
    dom.window.close();
  });

  // --- initial render -------------------------------------------------------
  assert.equal($('cash').textContent, '12K');
  assert.equal($('netWorth').textContent, '12K');
  assert.equal($('levelNum').textContent, '1');
  assert.equal($('levelName').textContent, 'مستثمر جديد');
  assert.equal($('plotGrid').children.length, 20, 'the active district renders 20 plots');
  assert.equal($('districtTabs').children.length, 5, 'five districts are listed');
  assert.equal($('collectAll').disabled, true, 'nothing to collect on a fresh wallet');

  // --- buy a plot ----------------------------------------------------------
  dom.window.document.querySelector('[data-plot="harbor:1"]').click();
  assert.equal($('sheet').hidden, false, 'tapping a plot opens the sheet');
  assert.match($('sheetTitle').textContent, /قطعة 1/);
  dom.window.document.querySelector('[data-action="buy"]').click();
  assert.equal(store.state.cash, 11600);
  assert.ok(store.state.plots['harbor:1'], 'the plot is now owned');

  // --- develop it ----------------------------------------------------------
  const developBtn = dom.window.document.querySelector('[data-action="develop"][data-asset="studio"]');
  assert.ok(developBtn, 'asset options are rendered for an empty plot');
  developBtn.click();
  assert.equal(store.state.plots['harbor:1'].assetId, 'studio');
  assert.equal(store.state.cash, 10200);

  // --- upgrade it ----------------------------------------------------------
  dom.window.document.querySelector('[data-action="upgrade"]').click();
  assert.equal(store.state.plots['harbor:1'].level, 2);

  // --- accrue then collect -------------------------------------------------
  store.state.plots['harbor:1'].lastCollectedAt = clock.now - 3 * HOUR;
  clock.now += 1;
  ui.render();
  const collectBtn = dom.window.document.querySelector('[data-action="collect"]');
  assert.equal(collectBtn.disabled, false);
  const cashBefore = store.state.cash;
  collectBtn.click();
  assert.ok(store.state.cash > cashBefore, 'collecting rent credits the wallet');
  assert.equal($('toast').classList.contains('is-open'), true, 'actions surface a toast');

  // --- tabs ----------------------------------------------------------------
  dom.window.document.querySelector('[data-view="portfolio"]').click();
  assert.equal($('view-portfolio').hidden, false);
  assert.equal($('view-city').hidden, true);
  assert.equal($('assetList').children.length, 1, 'the portfolio lists the developed asset');
  assert.equal($('emptyPortfolio').hidden, true);
  assert.match($('pfYield').textContent, /%$/);

  dom.window.document.querySelector('[data-view="league"]').click();
  assert.equal($('view-league').hidden, false);
  assert.equal($('leaderboard').children.length, 8, 'seven rivals plus the player');
  assert.equal($('challengeList').children.length, 4);
  assert.match($('rankBadge').textContent, /^#\d+$/);

  // --- sell closes the sheet and frees the plot ----------------------------
  dom.window.document.querySelector('[data-view="city"]').click();
  dom.window.document.querySelector('[data-plot="harbor:1"]').click();
  dom.window.document.querySelector('[data-action="sell"]').click();
  assert.equal(store.state.plots['harbor:1'], undefined);
  assert.equal($('sheet').hidden, true, 'selling closes the action sheet');
});

test('settings rename the investor and reset the wallet', { skip: !JSDOM && 'jsdom not installed (run npm install)' }, async (t) => {
  const { dom, store, ui, $ } = await boot();
  t.after(() => {
    ui.destroy();
    dom.window.close();
  });

  $('settingsBtn').click();
  assert.equal($('settings').hidden, false);

  $('playerName').value = '  شركة   أفق  ';
  $('saveName').click();
  assert.equal(store.state.playerName, 'شركة أفق');
  assert.equal($('settings').hidden, true, 'saving the name closes the sheet');

  // The league picks the new name up without a reload.
  dom.window.document.querySelector('[data-view="league"]').click();
  assert.match($('leaderboard').textContent, /شركة أفق/);

  // Reset requires a second confirmation tap.
  store.buy('harbor', 1);
  const spent = store.state.cash;
  $('settingsBtn').click();
  $('resetGame').click();
  assert.match($('resetGame').textContent, /تأكيد/, 'first tap only arms the reset');
  assert.equal(store.state.cash, spent, 'arming the reset changes nothing');
  $('resetGame').click();
  assert.equal(store.state.cash, 12000, 'second tap resets the wallet');
  assert.deepEqual(store.state.plots, {});
});

test('locked districts cannot be selected from the city view', { skip: !JSDOM && 'jsdom not installed (run npm install)' }, async (t) => {
  const { dom, store, ui, $ } = await boot();
  t.after(() => {
    ui.destroy();
    dom.window.close();
  });

  const locked = dom.window.document.querySelector('[data-district="horizon"]');
  assert.match(locked.className, /is-locked/);
  locked.click();
  assert.equal($('toast').textContent.includes('يُفتح'), true);
  assert.equal(store.state.plots['horizon:1'], undefined, 'no purchase happened');
});
