/**
 * OFUQ — the isometric city view.
 *
 * Two layers, separated on purpose:
 *
 *  • `buildCityModel()` turns a store snapshot into positioned plots. It is pure, it never
 *    touches WebGL, and it is what the tests pin down (`tests/ofuq/scene.test.mjs`).
 *  • `createCityScene()` draws that model with Three.js. It receives the `THREE` namespace
 *    from the caller, so importing this module in Node or in jsdom never pulls in WebGL
 *    code — the browser is the only place that loads `vendor/three.module.min.js`.
 *
 * The scene owns no game data: every frame is derived from the snapshot it was given. That
 * is why the same renderer works in local mode and in server mode, with no changes.
 */

import { ASSET_TYPES, DISTRICTS } from './config.js';
import { districtFor, pendingRent, plotKey, plotPrice } from './core.js';

export const PLOT_STATE = {
  free: 'free',
  owned: 'owned',
  built: 'built',
  locked: 'locked'
};

/** Filters are applied by dimming, never by removing meshes (the city stays whole). */
export const CITY_FILTERS = [
  { id: 'all', label: 'الكل' },
  { id: 'free', label: 'متاحة' },
  { id: 'mine', label: 'قطعتي' },
  { id: 'built', label: 'مطوّرة' },
  { id: 'ready', label: 'إيجار جاهز' }
];

const PITCH_X = 1.16;
const PITCH_Z = 2.7;
const PLOT_SIZE = 0.9;

const PALETTE = {
  free: 0xd8cbb2,
  freeEdge: 0xbfae90,
  owned: 0x9aa88b,
  locked: 0x5a5f68,
  ready: 0x4fd6a4,
  studio: 0xe4d3ae,
  retail: 0xe8ac68,
  office: 0x8ea8ca,
  hospitality: 0xc9a2e0
};

/** `OF-014` — the code players type into search. */
export function formatPlotCode(plotNo) {
  return `OF-${String(plotNo).padStart(3, '0')}`;
}

/** Position of a plot in the city layout. Districts run along Z, plots along X. */
export function plotPosition(districtIndex, plotNo) {
  return {
    x: (plotNo - 10.5) * PITCH_X,
    z: (districtIndex - (DISTRICTS.length - 1) / 2) * PITCH_Z
  };
}

function matchesFilter(entry, filter) {
  switch (filter) {
    case 'free':
      return entry.state === PLOT_STATE.free;
    case 'mine':
      return entry.state === PLOT_STATE.owned || entry.state === PLOT_STATE.built;
    case 'built':
      return entry.state === PLOT_STATE.built;
    case 'ready':
      return entry.ready;
    default:
      return true;
  }
}

/**
 * Snapshot → positioned plots.
 *
 * `ready` means "there is rent waiting to be collected", capped by the same 8-hour rule the
 * economy uses, so the glowing buildings never promise more than the ledger pays.
 */
export function buildCityModel(snapshot, { now = Date.now(), filter = 'all' } = {}) {
  const state = snapshot?.state ?? snapshot;
  const level = snapshot?.level?.level ?? 1;
  const plots = [];

  DISTRICTS.forEach((district, districtIndex) => {
    const locked = level < district.unlockLevel;
    const price = plotPrice(district);
    for (let plotNo = 1; plotNo <= district.plots; plotNo += 1) {
      const key = plotKey(district.id, plotNo);
      const plot = state?.plots?.[key];
      const { x, z } = plotPosition(districtIndex, plotNo);
      const built = Boolean(plot?.assetId);
      const ready = built ? pendingRent(plot, district, now) > 0 : false;
      const plotState = plot
        ? built
          ? PLOT_STATE.built
          : PLOT_STATE.owned
        : locked
          ? PLOT_STATE.locked
          : PLOT_STATE.free;

      const entry = {
        key,
        districtId: district.id,
        districtName: district.name,
        districtIndex,
        plotNo,
        code: formatPlotCode(plotNo),
        x,
        z,
        price,
        state: plotState,
        locked,
        assetId: plot?.assetId ?? null,
        assetName: plot?.assetId ? (ASSET_TYPES.find((type) => type.id === plot.assetId)?.name ?? 'أصل') : null,
        level: plot?.assetId ? plot.level : 0,
        ready,
        owned: Boolean(plot),
        // Height reads the level: a level-5 building is visibly a tower.
        height: built ? 0.34 + plot.level * 0.26 : 0.09,
        dimmed: !matchesFilter({ state: plotState, ready }, filter)
      };
      plots.push(entry);
    }
  });

  return {
    plots,
    districts: DISTRICTS.map((district, index) => ({
      ...district,
      index,
      locked: level < district.unlockLevel,
      owned: plots.filter((entry) => entry.districtId === district.id && entry.owned).length
    })),
    filter,
    now,
    bounds: {
      minX: -10.5 * PITCH_X - 0.6,
      maxX: 10.5 * PITCH_X + 0.6,
      minZ: -((DISTRICTS.length - 1) / 2) * PITCH_Z - 1.2,
      maxZ: ((DISTRICTS.length - 1) / 2) * PITCH_Z + 1.2
    }
  };
}

const normalize = (value) => String(value ?? '').trim().toLowerCase();

const DIGITS = /^(?:of[\s-]*)?(\d{1,3})$/i;

/**
 * Search box resolution: `14`, `OF-014`, `harbor`, `حي الميناء`, or an asset name.
 * Returns every match so the caller can decide between "focus one" and "these many".
 */
export function matchPlots(model, query) {
  const needle = normalize(query);
  if (!needle) return [];
  const digits = needle.match(DIGITS);
  if (digits) {
    const wanted = Number(digits[1]);
    return model.plots.filter((entry) => entry.plotNo === wanted);
  }
  return model.plots.filter(
    (entry) =>
      normalize(entry.districtId) === needle ||
      normalize(entry.districtName).includes(needle) ||
      normalize(entry.assetName ?? '').includes(needle) ||
      normalize(entry.code) === needle
  );
}

/** Counts for the HUD, so the numbers on screen are the numbers in the city. */
export function citySummary(model) {
  const summary = { total: model.plots.length, free: 0, mine: 0, built: 0, ready: 0, locked: 0 };
  for (const entry of model.plots) {
    if (entry.state === PLOT_STATE.free) summary.free += 1;
    if (entry.state === PLOT_STATE.locked) summary.locked += 1;
    if (entry.owned) summary.mine += 1;
    if (entry.state === PLOT_STATE.built) summary.built += 1;
    if (entry.ready) summary.ready += 1;
  }
  return summary;
}

/* --------------------------------------------------------------- minimap --- */

/**
 * Map a plot to minimap pixels. Pure arithmetic so it can be tested without a canvas.
 * `pad` keeps the outer cells inside the rounded frame.
 */
export function minimapRect(entry, { width, height, pad = 6 }) {
  const columns = 20;
  const rows = DISTRICTS.length;
  const cell = Math.min(
    (width - pad * 2) / columns,
    (height - pad * 2) / rows
  );
  return {
    x: pad + (entry.plotNo - 1) * cell,
    y: pad + entry.districtIndex * cell,
    size: Math.max(1, cell - 1)
  };
}

const minimapColor = (entry) => {
  if (entry.state === PLOT_STATE.locked) return 'rgba(120,126,138,0.5)';
  if (entry.state === PLOT_STATE.free) return 'rgba(216,203,178,0.45)';
  if (entry.state === PLOT_STATE.owned) return 'rgba(154,168,139,0.85)';
  return entry.ready ? 'rgba(79,214,164,0.95)' : 'rgba(142,168,202,0.9)';
};

/**
 * Draw the whole city plus the current camera footprint. Cheap: 100 rectangles.
 * `view` is `{ x, z, spanX, spanZ }` in world units, produced by the scene.
 */
export function drawMinimap(ctx, model, view = null) {
  if (!ctx) return;
  const { width, height } = ctx.canvas;
  const bounds = model.bounds;
  ctx.clearRect(0, 0, width, height);

  for (const entry of model.plots) {
    const cell = minimapRect(entry, { width, height });
    ctx.fillStyle = minimapColor(entry);
    ctx.fillRect(cell.x, cell.y, cell.size, cell.size);
  }

  if (!view) return;
  const spanX = Math.max(1, bounds.maxX - bounds.minX);
  const spanZ = Math.max(1, bounds.maxZ - bounds.minZ);
  const pad = 6;
  const px = pad + ((view.x - view.spanX / 2 - bounds.minX) / spanX) * (width - pad * 2);
  const py = pad + ((view.z - view.spanZ / 2 - bounds.minZ) / spanZ) * (height - pad * 2);
  const pw = Math.max(4, (view.spanX / spanX) * (width - pad * 2));
  const ph = Math.max(4, (view.spanZ / spanZ) * (height - pad * 2));
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(px, py, pw, ph);
}

/* ---------------------------------------------------------------- scene --- */

const CAMERA_DIR = { x: 0.62, y: 0.78, z: 0.62 };
const DEFAULT_SPAN = 24;

/**
 * WebGL renderer for the city.
 *
 * The caller passes `THREE` so this module stays importable where WebGL does not exist.
 * Everything is drawn once per change (`requestFrame`), never in a permanent loop — an idle
 * city costs nothing, which matters when the app is installed on a phone.
 */
export function createCityScene({ THREE, canvas, minimap = null, model, onSelect = () => {}, onFocus = () => {} }) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio ?? 1, 2));
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 260);
  const city = new THREE.Group();
  scene.add(city);

  const hemi = new THREE.HemisphereLight(0xfff4e0, 0x2a3340, 0.95);
  const sun = new THREE.DirectionalLight(0xfff0cf, 0.85);
  sun.position.set(9, 16, 11);
  scene.add(hemi, sun);

  const plotGroup = new THREE.Group();
  const districtGroup = new THREE.Group();
  city.add(districtGroup, plotGroup);

  const plotGeometry = new THREE.BoxGeometry(PLOT_SIZE, 1, PLOT_SIZE);
  const slabGeometry = new THREE.BoxGeometry(PLOT_SIZE + 0.08, 0.05, PLOT_SIZE + 0.08);
  const markerGeometry = new THREE.SphereGeometry(0.09, 10, 8);

  const districtPlates = new Map();
  const meshes = new Map();

  let currentModel = model;
  let span = DEFAULT_SPAN;
  const target = { x: 0, z: 0 };
  let highlighted = null;

  for (const district of model.districts) {
    const plate = new THREE.Mesh(
      new THREE.PlaneGeometry(10.4 * PITCH_X * 2 - 2.2, PITCH_Z - 0.8),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(district.accent), transparent: true, opacity: 0.1, depthWrite: false })
    );
    plate.rotation.x = -Math.PI / 2;
    plate.position.set(
      0,
      0.002,
      (district.index - (DISTRICTS.length - 1) / 2) * PITCH_Z
    );
    plate.userData.districtId = district.id;
    districtGroup.add(plate);
    districtPlates.set(district.id, plate);
  }

  for (const entry of model.plots) {
    const slab = new THREE.Mesh(
      slabGeometry,
      new THREE.MeshLambertMaterial({ color: PALETTE.freeEdge, transparent: true })
    );
    slab.position.set(entry.x, 0.03, entry.z);

    const material = new THREE.MeshLambertMaterial({ color: PALETTE.free, transparent: true });
    const body = new THREE.Mesh(plotGeometry, material);
    body.position.set(entry.x, 0.05 + entry.height / 2, entry.z);
    body.scale.y = entry.height;
    body.userData.key = entry.key;

    const marker = new THREE.Mesh(
      markerGeometry,
      new THREE.MeshBasicMaterial({ color: PALETTE.ready, transparent: true, opacity: 0.95 })
    );
    marker.position.set(entry.x, 0.05 + entry.height + 0.16, entry.z);
    marker.visible = false;
    marker.userData.key = entry.key;

    plotGroup.add(slab, body, marker);
    meshes.set(entry.key, { slab, body, marker, material, entry });
  }

  function paint() {
    for (const [, item] of meshes) {
      const { entry, body, marker, material, slab } = item;
      const dim = entry.dimmed ? 0.16 : 1;
      let color = PALETTE.free;
      if (entry.state === PLOT_STATE.locked) color = PALETTE.locked;
      else if (entry.state === PLOT_STATE.owned) color = PALETTE.owned;
      else if (entry.state === PLOT_STATE.built) color = PALETTE[entry.assetId] ?? PALETTE.office;
      material.color.setHex(color);
      material.opacity = entry.state === PLOT_STATE.locked ? 0.55 * dim : dim;
      material.transparent = true;
      body.scale.y = Math.max(0.02, entry.height);
      body.position.y = 0.05 + body.scale.y / 2;
      slab.material.opacity = 0.55 * dim;
      marker.visible = entry.ready && !entry.dimmed;
      marker.position.y = 0.05 + body.scale.y + 0.16;
      const isHot = highlighted === entry.key;
      body.scale.x = isHot ? 1.08 : 1;
      body.scale.z = isHot ? 1.08 : 1;
    }
  }

  function applyCamera() {
    const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
    const halfW = span / 2;
    const halfH = halfW / Math.max(0.4, aspect);
    camera.left = -halfW;
    camera.right = halfW;
    camera.top = halfH;
    camera.bottom = -halfH;
    camera.position.set(
      target.x + CAMERA_DIR.x * 60,
      CAMERA_DIR.y * 60,
      target.z + CAMERA_DIR.z * 60
    );
    camera.lookAt(target.x, 0, target.z);
    camera.updateProjectionMatrix();
  }

  // jsdom and a few embedded webviews have no requestAnimationFrame; a timer keeps the
  // renderer usable (and testable) there without changing browser behaviour.
  const raf = globalThis.requestAnimationFrame ?? ((callback) => setTimeout(() => callback(Date.now()), 16));
  const cancelRaf = globalThis.cancelAnimationFrame ?? clearTimeout;

  let frame = 0;
  let disposed = false;

  function draw() {
    frame = 0;
    if (disposed) return;
    renderer.render(scene, camera);
    if (minimap) {
      drawMinimap(minimap, currentModel, {
        x: target.x,
        z: target.z,
        spanX: span,
        spanZ: span / Math.max(0.4, canvas.clientWidth / Math.max(1, canvas.clientHeight))
      });
    }
  }

  function requestFrame() {
    if (frame || disposed) return;
    frame = raf(draw);
  }

  function resize() {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    applyCamera();
    requestFrame();
  }

  function update(nextModel) {
    if (disposed) return;
    currentModel = nextModel;
    for (const entry of nextModel.plots) {
      const item = meshes.get(entry.key);
      if (!item) continue;
      item.entry = entry;
      item.body.userData.key = entry.key;
    }
    paint();
    requestFrame();
  }

  /* ------------------------------------------------------------ pointer --- */

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const pointers = new Map();
  let dragOrigin = null;
  let moved = 0;
  let pinchStart = 0;

  const localPoint = (event) => {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top, rect };
  };

  function pick(event) {
    const { x, y, rect } = localPoint(event);
    ndc.x = (x / rect.width) * 2 - 1;
    ndc.y = -(y / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(
      [...meshes.values()].map((item) => item.body),
      false
    );
    return hits[0]?.object?.userData?.key ?? null;
  }

  function onPointerDown(event) {
    canvas.setPointerCapture?.(event.pointerId);
    pointers.set(event.pointerId, localPoint(event));
    dragOrigin = { x: event.clientX, y: event.clientY, tx: target.x, tz: target.z, span };
    moved = 0;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchStart = Math.hypot(a.x - b.x, a.y - b.y);
    }
  }

  function onPointerMove(event) {
    const previous = pointers.get(event.pointerId);
    if (!previous) return;
    const point = localPoint(event);
    pointers.set(event.pointerId, point);

    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchStart > 0) zoomBy(pinchStart / Math.max(1, distance));
      pinchStart = distance;
      return;
    }

    if (!dragOrigin) return;
    const dx = event.clientX - dragOrigin.x;
    const dy = event.clientY - dragOrigin.y;
    moved = Math.max(moved, Math.hypot(dx, dy));
    if (moved < 4) return;
    const perPixel = span / Math.max(1, canvas.clientWidth);
    target.x = dragOrigin.tx - (dx * perPixel) / CAMERA_DIR.x * 0.7;
    target.z = dragOrigin.tz - (dy * perPixel) / CAMERA_DIR.z * 1.05;
    clampTarget();
    applyCamera();
    requestFrame();
  }

  function onPointerUp(event) {
    const wasDrag = moved >= 6;
    pointers.delete(event.pointerId);
    if (pointers.size === 0) pinchStart = 0;
    dragOrigin = null;
    if (wasDrag) return;
    const key = pick(event);
    if (key) onSelect(key);
  }

  function onWheel(event) {
    event.preventDefault();
    zoomBy(event.deltaY > 0 ? 1.08 : 0.92);
  }

  function zoomBy(factor) {
    if (disposed) return;
    const next = Math.min(60, Math.max(6, span * factor));
    if (Math.abs(next - span) < 0.001) return;
    span = next;
    applyCamera();
    requestFrame();
  }

  function clampTarget() {
    const { bounds } = currentModel;
    target.x = Math.min(bounds.maxX, Math.max(bounds.minX, target.x));
    target.z = Math.min(bounds.maxZ, Math.max(bounds.minZ, target.z));
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });

  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
  observer?.observe(canvas);

  paint();
  resize();
  requestFrame();

  return {
    update,
    resize,
    zoomIn: () => zoomBy(0.85),
    zoomOut: () => zoomBy(1.18),
    reset() {
      if (disposed) return;
      span = DEFAULT_SPAN;
      target.x = 0;
      target.z = 0;
      applyCamera();
      requestFrame();
    },
    focusDistrict(districtId) {
      if (disposed) return;
      const district = currentModel.districts.find((item) => item.id === districtId);
      if (!district) return;
      target.x = 0;
      target.z = (district.index - (DISTRICTS.length - 1) / 2) * PITCH_Z;
      span = 13;
      applyCamera();
      requestFrame();
    },
    focusPlot(key) {
      if (disposed) return false;
      const entry = currentModel.plots.find((item) => item.key === key);
      if (!entry) return false;
      target.x = entry.x;
      target.z = entry.z;
      span = Math.min(span, 10);
      highlighted = key;
      paint();
      applyCamera();
      requestFrame();
      onFocus(entry);
      return true;
    },
    dispose() {
      disposed = true;
      observer?.disconnect();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('wheel', onWheel);
      if (frame) cancelRaf(frame);
      plotGeometry.dispose();
      slabGeometry.dispose();
      markerGeometry.dispose();
      for (const item of meshes.values()) item.material.dispose();
      renderer.dispose();
    }
  };
}

/** True when a WebGL context can actually be created (jsdom and locked-down browsers: false). */
export function supportsWebGL(documentRef = globalThis.document) {
  if (!documentRef?.createElement) return false;
  try {
    const probe = documentRef.createElement('canvas');
    return Boolean(probe.getContext?.('webgl2') || probe.getContext?.('webgl'));
  } catch {
    return false;
  }
}

/** Convenience for the UI: the district a plot belongs to, as a label. */
export function plotLabel(entry) {
  return `${entry.code} · ${districtFor(entry.districtId)?.name ?? entry.districtName}`;
}
