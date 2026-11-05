/**
 * OFUQ — view layer.
 *
 * Renders the whole shell from a store snapshot and routes every interaction
 * through `data-action` delegation, so there is no inline JS and no global state
 * beyond the current tab / open sheet.
 */
import { APP, ASSET_TYPES, DISTRICTS, ECONOMY } from './config.js';
import {
  assetFor,
  challengeBoard,
  districtFor,
  districtStats,
  formatCompact,
  formatNumber,
  groupLedger,
  ledgerLabel,
  ledgerReconciles,
  ledgerTotals,
  plotLedger,
  hourlyIncome,
  leaderboard,
  netWorth,
  netYield,
  pendingRent,
  plotKey,
  plotPrice,
  plotRent,
  plotValue,
  portfolioValue,
  saleProceeds,
  upgradeCost,
  weekDaysLeft
} from './core.js';
import {
  CITY_FILTERS,
  buildCityModel,
  citySummary,
  createCityScene,
  drawMinimap,
  matchPlots,
  minimapRect,
  plotLabel,
  supportsWebGL
} from './scene.js';

const $ = (id) => document.getElementById(id);

const ICONS = {
  home: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M10 21v-6h4v6"/></svg>',
  store: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h16v11H4z"/><path d="M3 9l2-5h14l2 5"/><path d="M9 20v-6h6v6"/></svg>',
  tower: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 21V6l6-3v18M12 21h7V11h-7"/><path d="M9 9v.01M9 13v.01M9 17v.01"/></svg>',
  star: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.9 6.1 21l1.2-6.5L2.5 9.9 9.1 9z"/></svg>',
  lock: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 018 0v3"/></svg>'
};

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

export function mount(store) {
  const view = {
    current: 'city',
    district: DISTRICTS[0].id,
    sheetKey: null,
    settingsOpen: false,
    // City view: `city` is the WebGL scene once (and only if) it exists.
    filter: 'all',
    ledgerFilter: 'all',
    city: null,
    cityStatus: 'idle',
    cityModel: null
  };
  let toastTimer = 0;
  let searchTimer = 0;
  let authBusy = false;
  let resetArmed = false;

  /* --------------------------------------------------------------- helpers */

  const vibrate = (ms) => {
    if (!store.state.settings?.haptics) return;
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') navigator.vibrate(ms);
  };

  function toast(message, kind = 'ok') {
    const node = $('toast');
    node.textContent = message;
    node.classList.toggle('is-bad', kind === 'bad');
    node.classList.add('is-open');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove('is-open'), 2600);
  }

  // Local mode answers synchronously, server mode answers with a promise. This keeps
  // click handlers synchronous in local mode (a tap still closes its sheet in the same tick).
  const after = (result, run) => (result && typeof result.then === 'function' ? result.then(run) : run(result));

  // Actions may be synchronous (local mode) or promises (server mode).
  const act = (result, haptic = 12) => {
    if (result && typeof result.then === 'function') return result.then((resolved) => act(resolved, haptic));
    if (result?.message) toast(result.message, result.ok ? 'ok' : 'bad');
    if (result?.ok) vibrate(haptic);
    return result;
  };

  /* ---------------------------------------------------------------- render */

  function render() {
    const snap = store.snapshot();
    renderHeader(snap);
    renderCity(snap);
    renderCityMap(snap);
    renderPortfolio(snap);
    renderLedger(snap);
    renderLeague(snap);
    if (view.sheetKey) renderSheet(snap);
    renderSettingsState();
  }

  function renderHeader(snap) {
    const { state } = snap;
    const pending = Object.values(snap.pending).reduce((sum, value) => sum + value, 0);
    const readyCount = Object.values(snap.pending).filter((value) => value > 0).length;

    $('netWorth').textContent = formatCompact(netWorth(state));
    $('cash').textContent = formatCompact(state.cash);
    $('income').textContent = `${formatCompact(hourlyIncome(state))}`;

    $('levelNum').textContent = String(snap.level.level);
    $('levelName').textContent = snap.level.name;
    $('levelNext').textContent = snap.level.maxed ? 'أعلى مستوى' : `${formatCompact(snap.level.xpForNext)} خبرة للمستوى ${snap.level.level + 1}`;
    const bar = $('levelBar');
    bar.firstElementChild.style.width = `${Math.round(snap.level.progress * 100)}%`;
    bar.setAttribute('aria-valuenow', String(Math.round(snap.level.progress * 100)));

    $('collectAll').disabled = pending <= 0;
    $('collectHint').textContent =
      pending > 0
        ? `${readyCount} أصل جاهز · ${formatNumber(pending)} عملة قابلة للتحصيل`
        : 'الإيجار يتراكم تلقائياً حتى ٨ ساعات وأنت بعيد.';

    $('citySummary').textContent = `${Object.keys(state.plots).length} قطعة من ${DISTRICTS.reduce((sum, d) => sum + d.plots, 0)}`;
    $('versionLabel').textContent = `${APP.nameEn} ${APP.version}`;
    const serverMode = store.mode === 'supabase';
    $('modeLabel').textContent = serverMode
      ? store.remote?.signedIn ? 'مدينة مشتركة' : 'خادم · بحاجة لتسجيل الدخول'
      : 'وضع محلي';
    $('storageWarn').hidden = !store.ephemeral;
  }

  function renderCity(snap) {
    const { state } = snap;
    const level = snap.level.level;

    $('districtTabs').innerHTML = DISTRICTS.map((district) => {
      const locked = level < district.unlockLevel;
      const active = district.id === view.district;
      return `<button type="button" class="chip ${active ? 'is-active' : ''} ${locked ? 'is-locked' : ''}"
        role="tab" aria-selected="${active}" data-district="${district.id}"
        title="${locked ? `يُفتح في المستوى ${district.unlockLevel}` : district.name}">
        ${district.name}${locked ? ' 🔒' : ''}</button>`;
    }).join('');

    const district = districtFor(view.district) ?? DISTRICTS[0];
    const stats = districtStats(state, district);
    const locked = level < district.unlockLevel;
    const price = plotPrice(district);
    $('districtMeta').textContent = locked
      ? `يُفتح ${district.name} في المستوى ${district.unlockLevel} — أكمل استثمارك في الأحياء المتاحة.`
      : `${district.name} · سعر القطعة ${formatNumber(price)} عملة · تملك ${stats.owned} من ${stats.total} · تطوير ${stats.developed}`;

    const now = Date.now();
    const plots = [];
    for (let no = 1; no <= district.plots; no += 1) {
      const key = plotKey(district.id, no);
      const plot = state.plots[key];
      const pending = plot ? pendingRent(plot, district, now) : 0;
      const built = Boolean(plot?.assetId);
      const classes = ['plot'];
      if (!plot) classes.push(locked ? 'is-locked' : 'is-free');
      else if (!built) classes.push('is-owned');
      else classes.push('is-built');
      if (pending > 0) classes.push('is-ready');
      const label = !plot
        ? `${formatCompact(price)}`
        : built
          ? `${formatCompact(pending)}`
          : 'أرض';
      const aria = !plot
        ? `قطعة ${no} متاحة بسعر ${formatNumber(price)} عملة`
        : built
          ? `قطعة ${no} عليها أصل مستوى ${plot.level}، إيجار جاهز ${formatNumber(pending)}`
          : `قطعة ${no} مملوكة وغير مطوّرة`;
      plots.push(
        `<button type="button" class="${classes.join(' ')}" data-plot="${key}" aria-label="${escapeHtml(aria)}" ${locked && !plot ? 'disabled' : ''}>
          <span>${no}</span><small>${label}</small>${built ? `<span class="lvl">${plot.level}</span>` : ''}
        </button>`
      );
    }
    $('plotGrid').innerHTML = plots.join('');
  }

  /* ------------------------------------------------------- the city scene --- */

  const cityModelFor = (snap) => buildCityModel(snap, { filter: view.filter });

  function renderCityFilters() {
    $('cityFilters').innerHTML = CITY_FILTERS.map(
      (filter) =>
        `<button type="button" data-filter="${filter.id}" class="${filter.id === view.filter ? 'is-active' : ''}" aria-pressed="${filter.id === view.filter}">${filter.label}</button>`
    ).join('');
  }

  /**
   * The badge states the truth in every mode: local, waiting for a session, or shared.
   * It never says "connected" when there is nothing to connect to.
   */
  function modeLabel() {
    if (store.mode !== 'supabase') return 'وضع محلي';
    return store.remote?.signedIn ? 'مدينة مشتركة' : 'خادم · بحاجة لتسجيل الدخول';
  }

  function renderCityMap(snap) {
    const model = cityModelFor(snap);
    view.cityModel = model;
    renderCityFilters();

    const summary = citySummary(model);
    const mapState =
      view.cityStatus === 'ready' ? '' : view.cityStatus === 'unsupported' ? ' · عرض شبكي' : ' · جارٍ التحميل';
    const node = $('cityMode');
    if (node) node.textContent = `${modeLabel()}${mapState}`;

    if (view.city) {
      view.city.update(model);
      return;
    }
    // Without WebGL the minimap still works: it is plain 2D canvas, and it keeps the
    // whole city (100 plots) visible on devices that cannot render the 3D view.
    if (view.cityStatus === 'unsupported') {
      // Same painter as the 3D scene, so both views always agree on colours and layout.
      const minimap = $('cityMinimap');
      try {
        drawMinimap(minimap?.getContext?.('2d') ?? null, model);
      } catch (error) {
        console.warn('[ofuq] minimap', error);
      }
    }
  }

  function markCityUnsupported() {
    view.cityStatus = 'unsupported';
    $('cityStage')?.classList.add('is-unsupported');
    const fallback = $('cityFallback');
    if (fallback) fallback.hidden = false;
    const hint = $('cityHint');
    if (hint) hint.textContent = 'كل الوظائف متاحة من شبكة القطع أدناه.';
  }

  /** Boots the 3D view. Failure is not fatal: the grid below stays fully usable. */
  async function initCity() {
    if (!supportsWebGL(document)) {
      markCityUnsupported();
      return renderCityMap(store.snapshot());
    }
    try {
      // Loaded on demand: the 600 KB renderer never blocks first paint, and a device
      // without WebGL never downloads it.
      const THREE = await import('../vendor/three.module.min.js');
      const canvas = $('cityCanvas');
      if (!canvas) throw new Error('canvas missing');
      view.city = createCityScene({
        THREE,
        canvas,
        minimap: $('cityMinimap')?.getContext?.('2d') ?? null,
        model: cityModelFor(store.snapshot()),
        onSelect: (key) => selectCityPlot(key)
      });
      view.cityStatus = 'ready';
      view.city.focusDistrict(view.district);
      renderCityMap(store.snapshot());
    } catch (error) {
      console.warn('[ofuq] city scene unavailable', error);
      markCityUnsupported();
    }
  }

  /** A tap on a building in the 3D city opens the same sheet as a tap on the grid. */
  function selectCityPlot(key) {
    const district = districtFor(String(key).split(':')[0]);
    const snap = store.snapshot();
    if (district && snap.level.level < district.unlockLevel && !snap.state.plots[key]) {
      return act({ ok: false, message: `${district.name} يُفتح في المستوى ${district.unlockLevel}.` });
    }
    view.district = district?.id ?? view.district;
    vibrate(8);
    render();
    return openSheet(key);
  }

  function applySearch(rawQuery) {
    const query = String(rawQuery ?? '').trim();
    if (!query) return;
    const model = view.cityModel ?? cityModelFor(store.snapshot());
    const district = model.districts.find(
      (item) => item.id === query.toLowerCase() || item.name === query || item.name.includes(query)
    );
    if (district && !/\d/.test(query)) {
      view.city?.focusDistrict(district.id);
      return toast(`${district.name} · ${district.owned} قطعة لك`);
    }
    const matches = matchPlots(model, query);
    if (matches.length === 0) return toast('لا توجد قطعة أو حي بهذا الاسم.', 'bad');
    view.city?.focusPlot(matches[0].key);
    return toast(matches.length > 1 ? `${plotLabel(matches[0])} · ${matches.length} نتيجة` : plotLabel(matches[0]));
  }

  function onMinimapTap(event) {
    const model = view.cityModel;
    const canvas = event.currentTarget;
    if (!model || !canvas?.getBoundingClientRect) return;
    const rect = canvas.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / Math.max(1, rect.width)) * canvas.width;
    const y = ((event.clientY - rect.top) / Math.max(1, rect.height)) * canvas.height;
    const plot = model.plots.find((entry) => {
      const cell = minimapRect(entry, { width: canvas.width, height: canvas.height });
      return x >= cell.x && x <= cell.x + cell.size && y >= cell.y && y <= cell.y + cell.size;
    });
    if (!plot) return;
    view.city?.focusPlot(plot.key);
    toast(plotLabel(plot));
  }

  function renderPortfolio(snap) {
    const { state } = snap;
    const value = portfolioValue(state);
    const income = hourlyIncome(state);
    const plots = Object.entries(state.plots);

    $('pfValue').textContent = formatCompact(value);
    $('pfIncome').textContent = formatCompact(income);
    $('pfYield').textContent = `${(netYield(state) * 100).toFixed(1)}%`;
    $('pfCount').textContent = String(plots.length);

    $('emptyPortfolio').hidden = plots.length > 0;
    $('assetList').innerHTML = plots
      .sort(([, a], [, b]) => (b.assetId ? 1 : 0) - (a.assetId ? 1 : 0) || a.plotNo - b.plotNo)
      .map(([key, plot]) => {
        const district = districtFor(plot.districtId);
        const asset = assetFor(plot.assetId);
        const rent = asset ? plotRent(plot, district) : 0;
        const icon = ICONS[asset?.icon ?? 'home'] ?? ICONS.home;
        return `<button type="button" class="asset" data-plot="${key}" style="text-align:start;font-family:inherit">
          <span class="asset-ico">${icon}</span>
          <span class="asset-main">
            <b>${escapeHtml(asset ? asset.name : 'قطعة أرض')} · ${escapeHtml(district?.name ?? '')} #${plot.plotNo}</b>
            <small>${asset ? `المستوى ${plot.level} · ${formatNumber(rent)} عملة/ساعة` : 'جاهزة للتطوير'}</small>
          </span>
          <span class="asset-side">
            <b>${formatCompact(plotValue(plot, district))}</b>
            <small>القيمة</small>
          </span>
        </button>`;
      })
      .join('');
  }

  /* ---------------------------------------------------------------- wallet --- */

  const LEDGER_FILTERS = [
    { id: 'all', label: 'الكل' },
    { id: 'in', label: 'داخل' },
    { id: 'out', label: 'خارج' },
    { id: 'rent', label: 'إيجار' }
  ];

  const ledgerMatches = (entry, filter) => {
    if (filter === 'in') return entry.amount > 0;
    if (filter === 'out') return entry.amount < 0;
    if (filter === 'rent') return entry.reason === 'rent';
    return true;
  };

  const clock = (ts) => {
    try {
      return new Date(ts).toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit' });
    } catch {
      return '';
    }
  };

  /** Where the money went: the plot code when the row references one. */
  function ledgerSubtitle(entry) {
    if (!entry.ref) return clock(entry.ts);
    if (String(entry.ref).includes(':')) {
      const [districtId, no] = String(entry.ref).split(':');
      const district = districtFor(districtId);
      return `${district?.name ?? districtId} · قطعة ${no} · ${clock(entry.ts)}`;
    }
    return `${entry.ref} · ${clock(entry.ts)}`;
  }

  function renderLedger(snap) {
    const { state } = snap;
    const entries = Array.isArray(state.ledger) ? state.ledger : [];
    const list = $('ledgerList');
    const node = $('ledgerState');
    if (!list || !node) return;

    $('ledgerFilters').innerHTML = LEDGER_FILTERS.map(
      (filter) =>
        `<button type="button" data-ledger="${filter.id}" class="${filter.id === view.ledgerFilter ? 'is-active' : ''}" aria-pressed="${filter.id === view.ledgerFilter}">${filter.label}</button>`
    ).join('');

    const totals = ledgerTotals(entries);
    const reconciles = ledgerReconciles(entries, state.cash);
    node.textContent = `+${formatCompact(totals.inflow)} / −${formatCompact(totals.outflow)}`;

    const visible = entries.filter((entry) => ledgerMatches(entry, view.ledgerFilter));
    $('ledgerEmpty').hidden = visible.length > 0;
    list.innerHTML = groupLedger(visible)
      .map((group) => {
        const sign = group.net >= 0 ? 'pos' : 'neg';
        const rows = group.entries
          .map((entry) => {
            const kind = entry.amount >= 0 ? 'in' : 'out';
            return `<li class="ledger-row">
              <span class="ledger-ico ${kind}" aria-hidden="true">${kind === 'in' ? '↓' : '↑'}</span>
              <span class="ledger-main">
                <b>${escapeHtml(ledgerLabel(entry.reason))}</b>
                <small>${escapeHtml(ledgerSubtitle(entry))}</small>
              </span>
              <span class="ledger-amt ${kind}">${entry.amount > 0 ? '+' : '−'}${formatNumber(Math.abs(entry.amount))}</span>
            </li>`;
          })
          .join('');
        return `<div class="ledger-day"><span>${escapeHtml(group.label)}</span>
          <b class="${sign}">${group.net >= 0 ? '+' : '−'}${formatNumber(Math.abs(group.net))}</b></div>
          <ul class="ledger-rows">${rows}</ul>`;
      })
      .join('');

    // The point of the ledger: if it does not explain the balance, say so out loud.
    const verdict = document.createElement('p');
    verdict.className = `ledger-verdict ${reconciles ? 'ok' : 'bad'}`;
    verdict.textContent = reconciles
      ? `الرصيد ${formatNumber(state.cash)} — مطابق للسجل.`
      : 'تنبيه: السجل لا يطابق الرصيد. أعد مزامنة المدينة قبل أي عملية.';
    list.append(verdict);
  }

  function renderPlotHistory(key, state) {
    const entries = plotLedger(Array.isArray(state.ledger) ? state.ledger : [], key).slice(0, 4);
    if (entries.length === 0) return '';
    const rows = entries
      .map(
        (entry) =>
          `<li><span>${escapeHtml(ledgerLabel(entry.reason))}</span>
           <span class="${entry.amount >= 0 ? 'ledger-amt in' : 'ledger-amt out'}">${entry.amount > 0 ? '+' : '−'}${formatNumber(Math.abs(entry.amount))}</span></li>`
      )
      .join('');
    return `<div class="sheet-history"><h3>سجل هذه القطعة</h3><ul>${rows}</ul></div>`;
  }

  function renderLeague(snap) {
    const { state } = snap;
    const rows = leaderboard(state);
    const me = rows.find((row) => row.you);
    $('rankBadge').textContent = `#${me.rank}`;
    $('scoreValue').textContent = formatCompact(me.score);
    $('weekLeft').textContent = `${weekDaysLeft()} يوم على إغلاق الدوري`;

    const board = challengeBoard(state);
    $('challengeList').innerHTML = board
      .map((challenge) => {
        const pct = Math.round((challenge.progress / challenge.target) * 100);
        const status = challenge.claimed ? 'تم الاستلام' : challenge.done ? 'جاهز' : `${challenge.progress}/${challenge.target}`;
        return `<div class="challenge">
          <div class="challenge-top">
            <div><b>${escapeHtml(challenge.title)}</b><small>${escapeHtml(challenge.desc)}</small></div>
            <span class="pill">${status}</span>
          </div>
          <div class="challenge-track"><i style="width:${pct}%"></i></div>
          <div class="challenge-foot">
            <small>+${formatNumber(challenge.reward)} عملة · ${challenge.xp} خبرة</small>
            <button type="button" class="btn ${challenge.claimable ? 'btn-gold' : 'btn-ghost'} sm"
              data-claim="${challenge.id}" ${challenge.claimable ? '' : 'disabled'}>
              ${challenge.claimed ? 'مستلم' : challenge.done ? 'استلام' : 'غير مكتمل'}
            </button>
          </div>
        </div>`;
      })
      .join('');

    $('leaderboard').innerHTML = rows
      .map(
        (row) => `<div class="board-row ${row.you ? 'is-you' : ''}">
          <span class="board-rank">${row.rank}</span>
          <span class="board-name"><b>${escapeHtml(row.name)}</b><small>${escapeHtml(row.tag)}</small></span>
          <span class="board-score">${formatCompact(row.score)}</span>
        </div>`
      )
      .join('');
  }

  /* ----------------------------------------------------------------- sheet */

  function openSheet(key) {
    view.sheetKey = key;
    renderSheet(store.snapshot());
    $('sheet').hidden = false;
    $('scrim').hidden = false;
    $('sheetClose').focus();
  }

  function closeSheet() {
    view.sheetKey = null;
    $('sheet').hidden = true;
    if ($('settings').hidden) $('scrim').hidden = true;
  }

  function renderSheet(snap) {
    const { state } = snap;
    const key = view.sheetKey;
    const plot = state.plots[key];
    const [districtId, rawNo] = key.split(':');
    const district = districtFor(districtId);
    const no = Number(rawNo);
    if (!district) return;

    $('sheetTitle').textContent = `قطعة ${no} · ${district.name}`;
    const level = snap.level.level;

    if (!plot) {
      const price = plotPrice(district);
      const locked = level < district.unlockLevel;
      $('sheetBody').innerHTML = `
        <p class="sheet-note">قطعة أرض في ${escapeHtml(district.name)} بمعامل سعر ${district.tier.toFixed(2)}×. بناؤها يرفع دخل المحفظة وقيمتها الدفترية.</p>
        <div class="kv"><span>سعر القطعة</span><b>${formatNumber(price)}</b></div>
        <div class="kv"><span>سيولتك الحالية</span><b>${formatNumber(state.cash)}</b></div>
        <div class="kv"><span>أقل دخل بعد التطوير</span><b>${formatNumber(plotRent({ assetId: ASSET_TYPES[0].id, level: 1 }, district))} / ساعة</b></div>
        <button type="button" class="btn btn-gold" data-action="buy" ${locked || state.cash < price ? 'disabled' : ''}>
          ${locked ? `يُفتح في المستوى ${district.unlockLevel}` : state.cash < price ? 'السيولة غير كافية' : `شراء القطعة · ${formatNumber(price)}`}
        </button>
        ${renderPlotHistory(key, state)}`;
      return;
    }

    if (!plot.assetId) {
      const options = ASSET_TYPES.map((asset) => {
        const unlocked = level >= asset.unlockLevel;
        const rent = plotRent({ assetId: asset.id, level: 1 }, district);
        const afford = state.cash >= asset.cost;
        return `<div class="option">
          <span>
            <b>${escapeHtml(asset.name)}</b>
            <small>${formatNumber(rent)} عملة/ساعة · التكلفة ${formatNumber(asset.cost)}</small>
          </span>
          <button type="button" class="btn ${unlocked && afford ? 'btn-gold' : 'btn-ghost'} sm"
            data-action="develop" data-asset="${asset.id}" ${unlocked && afford ? '' : 'disabled'}>
            ${!unlocked ? `مستوى ${asset.unlockLevel}` : afford ? 'تطوير' : 'رصيد'}
          </button>
        </div>`;
      }).join('');
      $('sheetBody').innerHTML = `
        <p class="sheet-note">القطعة مملوكة وتنتظر التطوير. اختر نوع الأصل — كل مستوى إضافي يرفع الإيجار ${Math.round(ECONOMY.upgradeIncomeRate * 100)}%.</p>
        ${options}
        ${renderPlotHistory(key, state)}`;
      return;
    }

    const asset = assetFor(plot.assetId);
    const rent = plotRent(plot, district);
    const pending = pendingRent(plot, district, Date.now());
    const upgrade = plot.level < ECONOMY.maxLevel ? upgradeCost(plot, district) : 0;
    $('sheetBody').innerHTML = `
      <div class="kv"><span>الأصل</span><b>${escapeHtml(asset?.name ?? '')} · المستوى ${plot.level}</b></div>
      <div class="kv"><span>الإيجار</span><b>${formatNumber(rent)} / ساعة</b></div>
      <div class="kv"><span>جاهز للتحصيل</span><b>${formatNumber(pending)}</b></div>
      <div class="kv"><span>القيمة الدفترية</span><b>${formatNumber(plotValue(plot, district))}</b></div>
      <div class="kv"><span>البيع الصافي (بعد ${Math.round(ECONOMY.saleFeeRate * 100)}%)</span><b>${formatNumber(saleProceeds(plot, district))}</b></div>
      <button type="button" class="btn btn-gold" data-action="collect" ${pending > 0 ? '' : 'disabled'}>
        ${pending > 0 ? `تحصيل ${formatNumber(pending)}` : 'لا يوجد إيجار جاهز'}
      </button>
      <button type="button" class="btn btn-ghost" data-action="upgrade" ${plot.level < ECONOMY.maxLevel && state.cash >= upgrade ? '' : 'disabled'}>
        ${plot.level >= ECONOMY.maxLevel ? 'أعلى مستوى' : `ترقية إلى المستوى ${plot.level + 1} · ${formatNumber(upgrade)}`}
      </button>
      <button type="button" class="btn btn-danger" data-action="sell">بيع القطعة</button>
      ${renderPlotHistory(key, state)}`;
  }

  /* -------------------------------------------------------------- settings */

  function openSettings() {
    view.settingsOpen = true;
    $('playerName').value = store.state.playerName;
    $('settings').hidden = false;
    $('scrim').hidden = false;
    renderSettingsState();
    $('playerName').focus();
  }

  function closeSettings() {
    view.settingsOpen = false;
    resetArmed = false;
    $('resetGame').textContent = 'حذف التقدم والبدء من جديد';
    $('settings').hidden = true;
    if ($('sheet').hidden) $('scrim').hidden = true;
  }

  function renderSettingsState() {
    const state = store.state;
    $('settingsVersion').textContent = APP.version;
    $('hapticsToggle').textContent = state.settings?.haptics ? 'مفعّل' : 'مغلق';
    $('hapticsToggle').setAttribute('aria-pressed', String(Boolean(state.settings?.haptics)));
    $('syncState').textContent = store.ephemeral
      ? 'الحفظ غير متاح — الجلسة مؤقتة'
      : store.mode === 'supabase'
        ? store.auth.signedIn
          ? 'خادم مشترك'
          : 'خادم — بلا جلسة'
        : 'محلي على هذا الجهاز';
    renderAccount();
  }

  /**
   * The account panel is the only place that can create a session, so it states exactly
   * what is possible right now instead of showing a disabled button with no explanation.
   */
  function renderAccount() {
    const state = $('accountState');
    const form = $('authForm');
    const session = $('accountSession');
    if (!state || !form || !session) return;

    const reset = $('resetGame');
    const canReset = store.mode !== 'supabase';
    if (reset) {
      reset.disabled = !canReset;
      reset.textContent = canReset ? 'حذف التقدم والبدء من جديد' : 'لا يمكن حذف التقدم في المدينة المشتركة';
    }

    if (!store.auth.available) {
      state.textContent =
        'هذه النسخة تعمل محلياً: التقدم محفوظ على هذا الجهاز فقط، والرصيد محاكاة داخل اللعبة. لتفعيل المدينة المشتركة أضف مشروع Supabase في الإعدادات وعدّل config.js.';
      form.hidden = true;
      session.hidden = true;
      return;
    }

    if (store.auth.signedIn) {
      state.textContent = 'أنت داخل المدينة المشتركة: الرصيد والملكية والإيجار كلها على الخادم.';
      form.hidden = true;
      session.hidden = false;
      $('accountEmail').textContent = store.auth.email ?? 'حساب مسجّل';
      return;
    }

    state.textContent = 'الخادم مُهيّأ. سجّل الدخول أو أنشئ حساباً لتشارك المدينة مع لاعبين آخرين.';
    form.hidden = false;
    session.hidden = true;
  }

  /**
   * Runs an auth call with a visible busy state and a single honest toast.
   * A second tap while a request is in flight is ignored — double-submitting a sign-up
   * would create two sessions and two ledger rows for the same intent.
   */
  async function runAuth(button, task, busyLabel) {
    if (authBusy) return { ok: false, message: 'جارٍ التنفيذ — لحظة.' };
    authBusy = true;
    if (button) {
      button.setAttribute('aria-busy', 'true');
      button.dataset.label = button.textContent;
      button.textContent = busyLabel;
    }
    try {
      const result = await task();
      act(result, 24);
      return result;
    } catch (error) {
      console.warn('[ofuq] auth', error);
      return act({ ok: false, message: 'تعذر الاتصال بالخادم — حاول مرة أخرى.' });
    } finally {
      authBusy = false;
      if (button) {
        button.removeAttribute('aria-busy');
        if (button.dataset.label) button.textContent = button.dataset.label;
      }
      renderAccount();
    }
  }

  function authCredentials() {
    const email = $('authEmail')?.value ?? '';
    const password = $('authPassword')?.value ?? '';
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email.trim())) {
      return { ok: false, message: 'أدخل بريداً إلكترونياً صحيحاً.' };
    }
    if (password.length < 6) return { ok: false, message: 'كلمة المرور يجب أن تكون ٦ أحرف أو أكثر.' };
    return { ok: true, email: email.trim(), password };
  }

  async function submitAuth(mode) {
    if (!store.auth.available) return act({ ok: false, message: 'لا يوجد خادم مُهيّأ في هذه النسخة.' });
    const creds = authCredentials();
    if (!creds.ok) return act(creds);
    const button = $(mode === 'signup' ? 'authSignUp' : 'authSignIn');
    const result = await runAuth(
      button,
      () =>
        mode === 'signup'
          ? store.auth.signUp(creds.email, creds.password, $('playerName')?.value || APP.defaultPlayerName)
          : store.auth.signIn(creds.email, creds.password),
      mode === 'signup' ? 'جارٍ الإنشاء…' : 'جارٍ الدخول…'
    );
    if (result.ok) {
      $('authPassword').value = '';
      closeSettings();
      render();
    }
    return result;
  }

  /* ---------------------------------------------------------------- events */

  function switchView(next) {
    if (next === view.current) return;
    view.current = next;
    for (const tab of document.querySelectorAll('[data-view]')) {
      const active = tab.dataset.view === next;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', String(active));
    }
    for (const panel of document.querySelectorAll('.view')) {
      const active = panel.id === `view-${next}`;
      panel.classList.toggle('is-active', active);
      panel.hidden = !active;
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-view],[data-district],[data-plot],[data-claim],[data-action],[data-filter],[data-ledger],#collectAll,#settingsBtn,#sheetClose,#settingsClose,#saveName,#hapticsToggle,#resetGame,#scrim');
    if (!target) return;

    if (target.dataset.view) return switchView(target.dataset.view);

    if (target.dataset.ledger) {
      view.ledgerFilter = target.dataset.ledger;
      vibrate(4);
      return render();
    }

    if (target.dataset.filter) {
      view.filter = target.dataset.filter;
      vibrate(6);
      return render();
    }

    if (target.dataset.action?.startsWith('zoom-')) {
      const zoom = { 'zoom-in': 'zoomIn', 'zoom-out': 'zoomOut', 'zoom-reset': 'reset' }[target.dataset.action];
      view.city?.[zoom]?.();
      return undefined;
    }

    if (target.dataset.district) {
      const district = districtFor(target.dataset.district);
      if (!district) return;
      if (store.snapshot().level.level < district.unlockLevel) {
        return act({ ok: false, message: `${district.name} يُفتح في المستوى ${district.unlockLevel}.` });
      }
      view.district = district.id;
      view.city?.focusDistrict(district.id);
      vibrate(8);
      return render();
    }

    if (target.dataset.plot) return openSheet(target.dataset.plot);

    if (target.dataset.claim) return act(store.dispatch('claim', { challengeId: target.dataset.claim }), 30);

    if (target.id === 'collectAll') {
      return act(store.dispatch('collectAll'), 18);
    }

    if (target.id === 'settingsBtn') return openSettings();
    if (target.id === 'sheetClose') return closeSheet();
    if (target.id === 'settingsClose') return closeSettings();
    if (target.id === 'scrim') {
      closeSheet();
      return closeSettings();
    }

    if (target.id === 'saveName') {
      const result = store.dispatch('setName', { name: $('playerName').value });
      return act(after(result, (resolved) => {
        if (resolved?.ok) closeSettings();
        return resolved;
      }));
    }

    if (target.id === 'hapticsToggle') return act(store.dispatch('toggleHaptics'));

    if (target.id === 'resetGame') {
      if (!resetArmed) {
        resetArmed = true;
        target.textContent = 'اضغط مرة أخرى للتأكيد النهائي';
        setTimeout(() => {
          resetArmed = false;
          target.textContent = 'حذف التقدم والبدء من جديد';
        }, 4000);
        return;
      }
      resetArmed = false;
      target.textContent = 'حذف التقدم والبدء من جديد';
      const result = store.dispatch('reset');
      closeSettings();
      return act(result);
    }

    if (target.dataset.action && view.sheetKey) {
      const action = target.dataset.action;
      let result = { ok: false, message: '' };
      if (action === 'buy') {
        const [districtId, no] = view.sheetKey.split(':');
        result = store.dispatch('buy', { districtId, plotNo: Number(no) });
      } else if (action === 'develop') {
        result = store.dispatch('develop', { plotKey: view.sheetKey, assetId: target.dataset.asset });
      } else if (action === 'upgrade') {
        result = store.dispatch('upgrade', { plotKey: view.sheetKey });
      } else if (action === 'collect') {
        result = store.dispatch('collect', { plotKey: view.sheetKey });
      } else if (action === 'sell') {
        result = after(store.dispatch('sell', { plotKey: view.sheetKey }), (resolved) => {
          if (resolved?.ok) closeSheet();
          return resolved;
        });
      }
      return act(result);
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!view.sheetKey && !view.settingsOpen) return;
    closeSheet();
    closeSettings();
  });

  const authForm = $('authForm');
  authForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    submitAuth('signin');
  });
  $('authSignUp')?.addEventListener('click', () => submitAuth('signup'));
  $('authSync')?.addEventListener('click', () =>
    runAuth($('authSync'), async () => {
      const result = await store.syncFromServer();
      return result.ok ? { ok: true, message: result.message } : result;
    }, 'جارٍ…')
  );
  $('authSignOut')?.addEventListener('click', () =>
    runAuth($('authSignOut'), () => store.auth.signOut(), 'جارٍ…')
  );

  const searchInput = $('citySearch');
  if (searchInput) {
    searchInput.addEventListener('input', (event) => {
      const value = event.target.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => applySearch(value), 200);
    });
    searchInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      clearTimeout(searchTimer);
      applySearch(event.target.value);
    });
  }

  const minimapNode = $('cityMinimap');
  if (minimapNode) minimapNode.addEventListener('click', onMinimapTap);

  /* ------------------------------------------------------------------ tick */
  // Accrued rent changes continuously; refresh the derived UI without persisting.
  const ticker = setInterval(() => {
    if (document.hidden || view.settingsOpen) return;
    render();
  }, 12000);
  ticker.unref?.(); // lets headless test runs exit cleanly

  const onVisibility = () => {
    if (!document.hidden) render();
  };
  document.addEventListener('visibilitychange', onVisibility);

  // Every store mutation re-renders; the UI never holds a stale copy of the state.
  const unsubscribe = store.subscribe(() => render());
  render();
  // Fire-and-forget: the shell is already interactive before the renderer arrives.
  initCity();

  /** Detach timers/listeners — used by the DOM smoke test. */
  function destroy() {
    clearInterval(ticker);
    clearTimeout(searchTimer);
    document.removeEventListener('visibilitychange', onVisibility);
    minimapNode?.removeEventListener('click', onMinimapTap);
    view.city?.dispose?.();
    view.city = null;
    unsubscribe();
  }

  return { render, openSheet, closeSheet, toast, destroy };
}
