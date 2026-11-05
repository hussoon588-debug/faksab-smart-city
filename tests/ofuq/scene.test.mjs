import test from 'node:test';
import assert from 'node:assert/strict';

import { DISTRICTS, ECONOMY } from '../../apps/ofuq/src/config.js';
import { plotRent } from '../../apps/ofuq/src/core.js';
import { createMemoryStorage, createStore } from '../../apps/ofuq/src/store.js';
import {
  CITY_FILTERS,
  PLOT_STATE,
  buildCityModel,
  citySummary,
  createCityScene,
  drawMinimap,
  formatPlotCode,
  matchPlots,
  minimapRect,
  plotPosition,
  supportsWebGL
} from '../../apps/ofuq/src/scene.js';

const HOUR = 60 * 60 * 1000;

function freshStore() {
  return createStore({ storage: createMemoryStorage() });
}

function snapshotOf(store, now) {
  return store.snapshot(now);
}

test('formatPlotCode pads to three digits like the published build', () => {
  assert.equal(formatPlotCode(1), 'OF-001');
  assert.equal(formatPlotCode(14), 'OF-014');
  assert.equal(formatPlotCode(100), 'OF-100');
});

test('the city model covers every plot exactly once', () => {
  const store = freshStore();
  const model = buildCityModel(snapshotOf(store, Date.now()));
  const keys = new Set(model.plots.map((entry) => entry.key));

  assert.equal(model.plots.length, 100);
  assert.equal(keys.size, 100);
  assert.equal(model.districts.length, DISTRICTS.length);
  assert.deepEqual(
    model.districts.map((district) => district.owned),
    model.districts.map(() => 0)
  );
});

test('plots line up in rows: same number shares x, districts step along z', () => {
  const model = buildCityModel(snapshotOf(freshStore(), Date.now()));
  const byDistrict = (id) => model.plots.filter((entry) => entry.districtId === id);

  for (const district of model.districts) {
    const row = byDistrict(district.id);
    assert.equal(row.length, 20);
    assert.deepEqual(
      row.map((entry) => entry.x),
      model.plots.slice(0, 20).map((entry) => entry.x),
      'rows share the same x ladder'
    );
  }

  const zs = model.districts.map((district) => byDistrict(district.id)[0].z);
  assert.deepEqual(zs, [...zs].sort((a, b) => a - b), 'districts are ordered front to back');
  assert.equal(new Set(zs).size, model.districts.length);
  assert.deepEqual(plotPosition(0, 1), { x: model.plots[0].x, z: model.plots[0].z });
});

test('states follow the snapshot: free, owned, built and locked districts', () => {
  const store = freshStore();
  const before = buildCityModel(snapshotOf(store, Date.now()));

  assert.equal(before.plots.find((entry) => entry.key === 'harbor:1').state, PLOT_STATE.free);
  assert.equal(before.plots.find((entry) => entry.key === 'horizon:1').state, PLOT_STATE.locked);
  assert.equal(before.plots.find((entry) => entry.key === 'horizon:1').locked, true);

  assert.equal(store.dispatch('buy', { districtId: 'harbor', plotNo: 1 }).ok, true);
  const owned = buildCityModel(snapshotOf(store, Date.now()));
  assert.equal(owned.plots.find((entry) => entry.key === 'harbor:1').state, PLOT_STATE.owned);

  assert.equal(store.dispatch('develop', { plotKey: 'harbor:1', assetId: 'studio' }).ok, true);
  const built = buildCityModel(snapshotOf(store, Date.now()));
  const plot = built.plots.find((entry) => entry.key === 'harbor:1');
  assert.equal(plot.state, PLOT_STATE.built);
  assert.equal(plot.assetId, 'studio');
  assert.equal(plot.assetName, 'سكني');
  assert.equal(plot.level, 1);
  assert.equal(built.districts.find((district) => district.id === 'harbor').owned, 1);
});

test('building height reads the level, so a level-5 tower is visibly taller', () => {
  const store = freshStore();
  store.dispatch('buy', { districtId: 'harbor', plotNo: 1 });
  store.dispatch('develop', { plotKey: 'harbor:1', assetId: 'studio' });

  const level1 = buildCityModel(snapshotOf(store, Date.now())).plots.find((entry) => entry.key === 'harbor:1');
  store.state.plots['harbor:1'].level = ECONOMY.maxLevel;
  const level5 = buildCityModel(snapshotOf(store, Date.now())).plots.find((entry) => entry.key === 'harbor:1');

  assert.equal(level1.level, 1);
  assert.equal(level5.level, ECONOMY.maxLevel);
  assert.ok(level5.height > level1.height * 2, 'the tower is more than twice the height');
  assert.ok(level1.height > buildCityModel(snapshotOf(freshStore(), Date.now())).plots[0].height);
});

test('the ready marker respects the eight-hour accrual cap', () => {
  const store = freshStore();
  store.dispatch('buy', { districtId: 'harbor', plotNo: 1 });
  store.dispatch('develop', { plotKey: 'harbor:1', assetId: 'studio' });

  const district = DISTRICTS.find((item) => item.id === 'harbor');
  const rate = plotRent(store.state.plots['harbor:1'], district);
  const started = store.state.plots['harbor:1'].lastCollectedAt;

  const justBuilt = buildCityModel(snapshotOf(store, started), { now: started });
  assert.equal(justBuilt.plots.find((entry) => entry.key === 'harbor:1').ready, false);

  const overnight = buildCityModel(snapshotOf(store, started + 20 * HOUR), { now: started + 20 * HOUR });
  const plot = overnight.plots.find((entry) => entry.key === 'harbor:1');
  assert.equal(plot.ready, true);
  assert.equal(store.snapshot(started + 20 * HOUR).pending['harbor:1'], rate * ECONOMY.accrualCapHours);
});

test('filters dim plots instead of deleting them and never inflate the counts', () => {
  const store = freshStore();
  store.dispatch('buy', { districtId: 'harbor', plotNo: 2 });
  const snapshot = snapshotOf(store, Date.now());

  const all = buildCityModel(snapshot, { filter: 'all' });
  const mine = buildCityModel(snapshot, { filter: 'mine' });
  const free = buildCityModel(snapshot, { filter: 'free' });

  assert.equal(mine.plots.length, all.plots.length, 'the city never shrinks');
  assert.equal(mine.plots.filter((entry) => !entry.dimmed).length, 1);
  assert.equal(free.plots.filter((entry) => !entry.dimmed).length, all.plots.filter((entry) => entry.state === 'free').length);
  assert.ok(CITY_FILTERS.some((filter) => filter.id === 'ready'));

  const summary = citySummary(all);
  assert.equal(summary.total, 100);
  assert.equal(summary.mine, 1);
  assert.equal(summary.free + summary.mine + summary.locked, summary.total);
});

test('search resolves plot codes, bare numbers, districts and asset names', () => {
  const store = freshStore();
  store.dispatch('buy', { districtId: 'harbor', plotNo: 14 });
  store.dispatch('develop', { plotKey: 'harbor:14', assetId: 'studio' });
  const model = buildCityModel(snapshotOf(store, Date.now()));

  assert.deepEqual(matchPlots(model, 'OF-014').map((entry) => entry.key), [
    'harbor:14',
    'garden:14',
    'downtown:14',
    'tech:14',
    'horizon:14'
  ]);
  assert.equal(matchPlots(model, '14').length, 5);
  assert.equal(matchPlots(model, 'harbor').length, 20);
  assert.equal(matchPlots(model, 'حي الميناء').length, 20);
  assert.equal(matchPlots(model, 'سكني').length, 1);
  assert.equal(matchPlots(model, 'OF-999').length, 0);
  assert.equal(matchPlots(model, '   ').length, 0);
});

test('minimap cells stay inside the frame and follow the grid', () => {
  const model = buildCityModel(snapshotOf(freshStore(), Date.now()));
  const frame = { width: 180, height: 96, pad: 6 };

  for (const entry of model.plots) {
    const cell = minimapRect(entry, frame);
    assert.ok(cell.x >= frame.pad - 0.001, 'left edge inside');
    assert.ok(cell.y >= frame.pad - 0.001, 'top edge inside');
    assert.ok(cell.x + cell.size <= frame.width - frame.pad + 0.001, 'right edge inside');
    assert.ok(cell.y + cell.size <= frame.height - frame.pad + 0.001, 'bottom edge inside');
    assert.ok(cell.size >= 1);
  }

  const first = minimapRect(model.plots[0], frame);
  const nextInRow = minimapRect(model.plots[1], frame);
  const nextRow = minimapRect(model.plots[20], frame);
  assert.equal(first.y, nextInRow.y);
  assert.ok(nextInRow.x > first.x);
  assert.ok(nextRow.y > first.y);
});

test('drawMinimap paints one cell per plot plus the camera footprint', () => {
  const model = buildCityModel(snapshotOf(freshStore(), Date.now()));
  const calls = { rects: 0, strokes: 0, clears: 0 };
  const ctx = {
    canvas: { width: 180, height: 96 },
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    clearRect: () => {
      calls.clears += 1;
    },
    fillRect: () => {
      calls.rects += 1;
    },
    strokeRect: () => {
      calls.strokes += 1;
    }
  };

  drawMinimap(ctx, model);
  assert.equal(calls.clears, 1);
  assert.equal(calls.rects, 100);
  assert.equal(calls.strokes, 0, 'no viewport before the scene reports one');

  drawMinimap(ctx, model, { x: 0, z: 0, spanX: 12, spanZ: 6 });
  assert.equal(calls.strokes, 1);

  assert.doesNotThrow(() => drawMinimap(null, model), 'a missing canvas is not a crash');
});

test('the scene reports WebGL support instead of throwing', () => {
  assert.equal(supportsWebGL(undefined), false);
  assert.equal(supportsWebGL({ createElement: () => ({ getContext: () => null }) }), false);
  assert.equal(supportsWebGL({ createElement: () => ({ getContext: () => ({}) }) }), true);
  assert.equal(
    supportsWebGL({
      createElement: () => ({
        getContext: () => {
          throw new Error('blocked');
        }
      })
    }),
    false
  );
});

/* ------------------------------------------------------------- renderer --- */

/**
 * A stub of the slice of Three.js the scene uses. It cannot prove the picture looks good,
 * but it proves the renderer wires the model to meshes without calling a missing API —
 * which is exactly the class of bug that only shows up on a device with WebGL.
 */
function stubThree() {
  const calls = { meshes: 0, renders: 0, materials: new Set() };

  class Vector2 {
    constructor(x = 0, y = 0) {
      this.x = x;
      this.y = y;
    }
  }
  class Vector3 {
    constructor(x = 0, y = 0, z = 0) {
      Object.assign(this, { x, y, z });
    }
    set(x, y, z) {
      Object.assign(this, { x, y, z });
      return this;
    }
  }
  class Color {
    constructor(hex) {
      this.hex = hex;
    }
    setHex(hex) {
      this.hex = hex;
      return this;
    }
  }
  const object = (extra = {}) =>
    Object.assign(
      {
        position: new Vector3(),
        scale: new Vector3(1, 1, 1),
        rotation: new Vector3(),
        userData: {},
        visible: true,
        children: [],
        add(...nodes) {
          this.children.push(...nodes);
        }
      },
      extra
    );

  class Mesh extends Object {
    constructor(geometry, material) {
      super();
      calls.meshes += 1;
      Object.assign(this, { geometry, material }, object());
      calls.materials.add(material);
    }
  }
  class Geometry {
    dispose() {
      this.disposed = true;
    }
  }
  class Material {
    constructor(options = {}) {
      Object.assign(this, options, { color: new Color(options.color ?? 0xffffff) });
      this.disposed = false;
    }
    dispose() {
      this.disposed = true;
    }
  }

  return {
    calls,
    Vector2,
    Vector3,
    Color,
    Scene: class extends Object {
      constructor() {
        super();
        Object.assign(this, object());
      }
    },
    Group: class extends Object {
      constructor() {
        super();
        Object.assign(this, object());
      }
    },
    OrthographicCamera: class extends Object {
      constructor(left, right, top, bottom, near, far) {
        super();
        Object.assign(this, object({ left, right, top, bottom, near, far, updateProjectionMatrix() {} }));
      }
      lookAt() {}
      updateProjectionMatrix() {}
    },
    HemisphereLight: class extends Object {
      constructor() {
        super();
        Object.assign(this, object());
      }
    },
    DirectionalLight: class extends Object {
      constructor() {
        super();
        Object.assign(this, object());
      }
    },
    BoxGeometry: Geometry,
    PlaneGeometry: Geometry,
    SphereGeometry: Geometry,
    MeshLambertMaterial: class extends Material {},
    MeshBasicMaterial: class extends Material {},
    Mesh,
    Raycaster: class {
      setFromCamera() {}
      intersectObjects() {
        return [];
      }
    },
    WebGLRenderer: class {
      constructor(params) {
        this.params = params;
        this.disposed = false;
      }
      setPixelRatio() {}
      setClearColor() {}
      setSize() {}
      render() {
        calls.renders += 1;
      }
      dispose() {
        this.disposed = true;
      }
    }
  };
}

function stubCanvas(width = 640, height = 400) {
  return {
    clientWidth: width,
    clientHeight: height,
    events: new Map(),
    addEventListener(type, handler) {
      this.events.set(type, handler);
    },
    removeEventListener(type) {
      this.events.delete(type);
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, width, height }),
    setPointerCapture() {}
  };
}

test('the renderer maps the model onto meshes and repaints on update', () => {
  const THREE = stubThree();
  const canvas = stubCanvas();
  const store = freshStore();
  store.dispatch('buy', { districtId: 'harbor', plotNo: 3 });
  store.dispatch('develop', { plotKey: 'harbor:3', assetId: 'studio' });

  const model = buildCityModel(snapshotOf(store, Date.now()));
  const scene = createCityScene({ THREE, canvas, model, onSelect: () => {} });

  // One slab + one body + one marker per plot, plus one ground plate per district.
  assert.equal(THREE.calls.meshes, 100 * 3 + DISTRICTS.length);
  assert.equal(THREE.calls.materials.size > 0, true);

  const built = model.plots.find((entry) => entry.key === 'harbor:3');
  assert.equal(built.state, 'built');

  const focused = scene.focusPlot('harbor:3');
  assert.equal(focused, true);
  assert.equal(scene.focusPlot('nowhere:1'), false);

  const filtered = buildCityModel(snapshotOf(store, Date.now()), { filter: 'free' });
  assert.doesNotThrow(() => scene.update(filtered));
  assert.doesNotThrow(() => scene.zoomIn());
  assert.doesNotThrow(() => scene.zoomOut());
  assert.doesNotThrow(() => scene.reset());
  assert.doesNotThrow(() => scene.focusDistrict('horizon'));
  assert.doesNotThrow(() => scene.resize());

  scene.dispose();
  assert.equal(scene.focusPlot('harbor:3'), false, 'a disposed scene stops answering');
});
