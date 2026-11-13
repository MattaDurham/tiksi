// Wall trim (trims.js, trim-catalog.js, geometry.js): the catalog, a section's layout around
// doors and windows, its boxes and their widths, swapping products, moving and resizing, the
// 3D sections and their mitres, and walls drawn with no baseboard of their own. Synthetic walls only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const vendor = new URL('../vendor/', import.meta.url).href;
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'three') return { url: vendor + 'three.module.min.js', shortCircuit: true };
    if (spec.startsWith('three/addons/')) return { url: vendor + 'addons/' + spec.slice(13), shortCircuit: true };
    return next(spec, ctx);
  },
});
globalThis.indexedDB = { open() { throw new Error('no IndexedDB under Node'); } };
const store = await import('../js/store.js');
store.ws.data = store.emptyWorkspace();
const { buildWallGroup, buildTrimGroup } = await import('../js/geometry.js');
const T = await import('../js/trims.js');
const { TRIM_CATALOG, catalogItem, catalogFor } = await import('../js/trim-catalog.js');
const { sectionOf } = await import('../js/trim-profiles.js');

const X = { matOpts: { transparent: true, opacity: 0.5 } };
const WALL = { id: 'w1', ax: 0, ay: 0, bx: 4, by: 0, thickness: 0.114, height: 2.44, level: 'l1' };
const ROOM = { id: 'r1', pts: [[0, 0], [4, 0], [4, 3], [0, 3]] };
const DOOR = { id: 'd1', wallId: 'w1', t: 0.5, type: 'door', width: 0.8, height: 2.03 };
const near = (a, b, what, tol = 1e-6) => assert.ok(Math.abs(a - b) < tol, `${what}: ${a} is not ${b}`);

test('every trim style has real store products with a size, a page and a known section', () => {
  for (const style of Object.keys(T.TRIM_STYLES)) assert.ok(catalogFor(style).length >= 1, style + ' has products');
  const ids = new Set();
  for (const p of TRIM_CATALOG) {
    assert.ok(!ids.has(p.id), 'unique id ' + p.id); ids.add(p.id);
    assert.ok(T.TRIM_STYLES[p.style], p.id + ' style');
    assert.match(p.url, /^https:\/\/www\.(homedepot|lowes)\.com\//, p.id + ' is a Home Depot or Lowe\'s page');
    assert.ok(/Home Depot|Lowe's/.test(p.store), p.id + ' store');
    assert.ok(p.W > 0.005 && p.W < 1.3 && p.T > 0.002 && p.T < 0.2, p.id + ' size in metres');
    assert.ok(sectionOf(p.profile, p.W, p.T).length >= 4, p.id + ' section');
  }
});

test('a wall draws no baseboard of its own: only its solids and its door', () => {
  const g = buildWallGroup(WALL, [DOOR], { walls: [WALL], rooms: [ROOM], wallHeight: 2.44 }, X);
  const meshes = []; g.traverse(o => { if (o.isMesh && o.userData.kind === 'wall') meshes.push(o); });
  for (const m of meshes) {
    m.geometry.computeBoundingBox();
    const b = m.geometry.boundingBox;
    // A baseboard stood 12 mm proud of the face; the wall now stops at its own faces.
    assert.ok(b.max.z <= WALL.thickness / 2 + 1e-6 && b.min.z >= -WALL.thickness / 2 - 1e-6, 'nothing proud of the wall faces');
  }
});

test('a baseboard stops at the door casing and keeps its height, and reaches the wall ends', () => {
  const t = T.trimTemplate('baseboard', 'hd-10000558', WALL, 1, { wallHeight: 2.44 });
  const lay = T.trimLayout(t, WALL, [DOOR], { H: 2.44 });
  assert.equal(lay.parts.length, 2, 'two pieces, one each side of the door');
  const [a, b] = lay.parts.sort((p, q) => p.x0 - q.x0);
  near(a.x0, 0, 'starts at the wall end'); near(b.x1, 4, 'ends at the wall end');
  near(a.x1, 2 - 0.4 - 0.07, 'stops at the left casing'); near(b.x0, 2 + 0.4 + 0.07, 'starts at the right casing');
  assert.ok(a.mitreA && !a.mitreB && !b.mitreA && b.mitreB, 'mitred only where it meets the next wall');
  near(a.W, 3.25 * 0.0254, 'its height is the product\'s width', 1e-4);
});

test('trim cuts use measured door and window casing widths before legacy profiles', () => {
  for (const type of ['door', 'window']) {
    for (const [measured, legacy] of [[0.18, 0.09], [0.025, 0.18], [0, 0.14]]) {
      const o = { ...DOOR, type, sill: type === 'window' ? 0.5 : 0, height: 1.5,
        profile: { casingWidth: legacy }, detail: { [type]: { casingWidth: measured } } };
      const [block] = T.openingBlocks(WALL, [o], 4, 2.44);
      near(block.x0, 1.6 - measured, type + ' left casing boundary');
      near(block.x1, 2.4 + measured, type + ' right casing boundary');
      near(block.y1, o.sill + o.height + measured, type + ' upper casing boundary');
      const t = T.trimTemplate('chair-rail', null, WALL, 1, { wallHeight: 2.44 });
      const pieces = T.trimLayout(t, WALL, [o], { H: 2.44 }).parts;
      assert.equal(pieces.length, 2, type + ' cuts the rail into two pieces');
      near(pieces[0].x1, block.x0, type + ' left rail meets casing');
      near(pieces[1].x0, block.x1, type + ' right rail meets casing');
    }
  }
});

test('trim cuts retain legacy casing and default dimensions when measured details omit them', () => {
  for (const type of ['door', 'window']) {
    for (const [profile, expected] of [[undefined, 0.07], [{ casingWidth: 0.04 }, 0.04], [{ casingWidth: 0.36 }, 0.36]]) {
      const o = { ...DOOR, type, profile, detail: { [type]: {} } };
      const [block] = T.openingBlocks(WALL, [o], 4, 2.44);
      near(block.x0, 1.6 - expected, type + ' fallback left casing boundary');
      near(block.x1, 2.4 + expected, type + ' fallback right casing boundary');
    }
  }
});

test('plain doors and passages have no casing cuts even when their profiles and details specify it', () => {
  for (const type of ['door', 'opening']) {
    const o = { ...DOOR, type, plain: true, profile: { casingWidth: 0.12 }, detail: { door: { casingWidth: 0.2 } } };
    const [block] = T.openingBlocks(WALL, [o], 4, 2.44);
    near(block.x0, 1.6, type + ' left edge is the aperture');
    near(block.x1, 2.4, type + ' right edge is the aperture');
    near(block.y1, DOOR.height, type + ' upper edge is the aperture');
  }
  const win = { ...DOOR, type: 'window', plain: true, sill: 0.3, detail: { window: { casingWidth: 0.12 } } };
  near(T.openingBlocks(WALL, [win], 4, 2.44)[0].x0, 1.48, 'plain does not remove a window casing');
});

test('zero-depth door casing leaves no casing clearance, matching the rendered opening', () => {
  const o = { ...DOOR, profile: { casingWidth: .12, casingDepth: .02 }, detail: { door: { casingDepth: 0 } } };
  const [block] = T.openingBlocks(WALL, [o], 4, 2.44);
  near(block.x0, 1.6, 'no left casing'); near(block.x1, 2.4, 'no right casing');
  near(block.y1, DOOR.height, 'no head casing');
});

test('a chair rail passes under a window\'s casing only where it clears it', () => {
  const win = { id: 'win', wallId: 'w1', t: 0.5, type: 'window', width: 1, height: 1.2, sill: 0.9 };
  const t = T.trimTemplate('chair-rail', null, WALL, 1, { wallHeight: 2.44 });
  assert.equal(T.trimLayout(t, WALL, [win], { H: 2.44 }).parts.length, 2, 'cut by the window and its apron at 0.84 m');
  t.y = 0.5;
  assert.equal(T.trimLayout(t, WALL, [win], { H: 2.44 }).parts.length, 1, 'runs unbroken below the apron');
});

test('picture-frame boxes: a set count, widths typed for each, and a field that continues under a window', () => {
  const t = T.trimTemplate('picture-frame', null, WALL, 1, { wallHeight: 2.44 });
  let lay = T.trimLayout(t, WALL, [], { H: 2.44 });
  assert.equal(lay.boxes.length, lay.cols, 'one row of boxes');
  assert.ok(lay.cols >= 4 && lay.cols <= 6, 'boxes about 30 in wide fit a 13 ft wall (' + lay.cols + ')');
  t.cols = 3;
  lay = T.trimLayout(t, WALL, [], { H: 2.44 });
  assert.equal(lay.boxes.length, 3, 'three boxes when the owner says three');
  const gap = lay.boxes[1].x0 - lay.boxes[0].x1;
  near(gap, 0.1, 'a 4 in gap between boxes', 1e-9);
  t.widths = [2, 1, 1];
  lay = T.trimLayout(t, WALL, [], { H: 2.44 });
  near(lay.boxes[0].x1 - lay.boxes[0].x0, 2 * (lay.boxes[1].x1 - lay.boxes[1].x0), 'the first box twice the others', 1e-9);
  t.rows = 2; t.heights = [3, 1];
  lay = T.trimLayout(t, WALL, [], { H: 2.44 });
  assert.equal(lay.boxes.length, 6, 'two rows of three');
  const low = lay.boxes.find(b => b.row === 0 && b.col === 0), high = lay.boxes.find(b => b.row === 1 && b.col === 0);
  near((low.y1 - low.y0) / (high.y1 - high.y0), 3, 'rows split by their shares', 1e-9);
  // A window whose apron sits above the field's bottom: the field continues beneath it.
  const win = { id: 'win', wallId: 'w1', t: 0.5, type: 'window', width: 1, height: 1.2, sill: 0.6 };
  const u = T.trimTemplate('picture-frame', null, WALL, 1, { wallHeight: 2.44 });
  u.y = 0.1; u.h = 0.7;
  const rects = T.trimLayout(u, WALL, [win], { H: 2.44 }).rects;
  assert.ok(rects.some(r => !r.full && r.y1 <= 0.6 - 0.11 + 1e-9), 'a lower stretch under the window');
  assert.equal(rects.filter(r => r.full).length, 2, 'full stretches either side');
});

test('board and batten: battens at both ends and between bays, a top rail along the top', () => {
  const t = T.trimTemplate('board-batten', 'hd-424600', WALL, 1, { wallHeight: 2.44 });
  t.cols = 5;
  const lay = T.trimLayout(t, WALL, [], { H: 2.44 });
  const vert = lay.parts.filter(p => p.kind === 'board' && p.dir === 'v');
  assert.equal(vert.length, 6, 'six battens for five bays');
  near(vert[0].x0, 0, 'first batten at the wall end'); near(vert[vert.length - 1].x1, 4, 'last at the other end');
  const rail = lay.parts.find(p => p.dir === 'h');
  near(rail.y1, t.y + t.h, 'the top rail is the field\'s top');
});

test('swapping a product keeps the height within a kind and takes the new style\'s height across kinds', () => {
  const t = T.trimTemplate('chair-rail', null, WALL, 1, { wallHeight: 2.44 });
  t.y = 0.95;
  assert.ok(T.swapTrimProduct(t, 'hd-10001778', 2.44));
  assert.equal(t.y, 0.95, 'another chair rail keeps 0.95 m');
  assert.ok(T.swapTrimProduct(t, 'hd-10000558', 2.44));
  assert.equal(t.style, 'baseboard'); assert.equal(t.y, 0.95, 'a run swapped to another run keeps its height');
  assert.ok(T.swapTrimProduct(t, 'hd-wpkp56x03ds', 2.44));
  assert.equal(t.style, 'shaker'); assert.ok(t.h > 0.3, 'a field gets a field\'s height'); assert.equal(t.y, T.TRIM_STYLES.shaker.y);
  assert.ok(!T.swapTrimProduct(t, 'no-such-product', 2.44), 'an unknown product is refused');
});

test('dragging: a section moves inside its wall, a field\'s edges resize it', () => {
  const t = T.trimTemplate('picture-frame', null, WALL, 1, { wallHeight: 2.44 });
  T.setTrimY(t, 5, 2.44);
  near(t.y + t.h, 2.44, 'stops at the top of the wall');
  T.setTrimY(t, -1, 2.44);
  near(t.y, 0, 'stops at the floor');
  T.setFieldEdge(t, 'top', 1.0, 2.44);
  near(t.y + t.h, 1.0, 'top edge dragged to 1 m');
  T.setFieldEdge(t, 'bottom', 0.3, 2.44);
  near(t.y, 0.3, 'bottom edge'); near(t.y + t.h, 1.0, 'top stays put');
  T.setFieldEdge(t, 'bottom', 0.99, 2.44);
  assert.ok(t.h >= 0.08 - 1e-9, 'never thinner than 8 cm');
});

test('records from a file are made safe; a section on a missing wall is dropped', () => {
  const prop = { walls: [WALL] };
  const list = T.normaliseTrims([
    { id: 'a', style: 'baseboard', wallId: 'w1', side: 7, f0: 1.4, f1: -2, y: 'x', cols: 2.5, widths: [1, -1], gap: 'no' },
    { id: 'b', style: 'nonsense', wallId: 'w1' },
    { id: 'c', style: 'crown', wallId: 'gone' },
  ], prop);
  assert.equal(list.length, 1);
  const t = list[0];
  assert.equal(t.side, 1); assert.equal(t.f0, 0); assert.equal(t.f1, 1); assert.equal(t.y, 0);
  assert.equal(t.cols, null); assert.equal(t.widths, null); assert.equal(t.gap, null);
  assert.equal(t.product, catalogFor('baseboard')[0].id); assert.equal(t.level, 'l1');
});

test('the 3D section stands on the face, as deep as the product, and mitres to meet the next wall', () => {
  const W2 = { id: 'w2', ax: 4, ay: 0, bx: 4, by: 3, thickness: 0.114, height: 2.44, level: 'l1' };
  const view = { walls: [WALL, W2], rooms: [ROOM], wallHeight: 2.44 };
  // The room lies on the wall's +y side, its left normal: side +1.
  const t = Object.assign(T.trimTemplate('baseboard', 'hd-10000558', WALL, 1, { wallHeight: 2.44 }), { id: 'trim-1' });
  const g = buildTrimGroup(t, WALL, view, [], X);
  const mesh = g.children.find(o => o.isMesh);
  assert.ok(mesh, 'a mesh'); assert.equal(mesh.userData.kind, 'trim');
  mesh.geometry.computeBoundingBox();
  const b = mesh.geometry.boundingBox, p = catalogItem('hd-10000558');
  near(b.min.y, 0, 'on the floor'); near(b.max.y, p.W, 'its height', 1e-6);
  near(b.min.z, WALL.thickness / 2, 'against the face', 1e-6); near(b.max.z, WALL.thickness / 2 + p.T, 'its depth', 1e-6);
  // At the inside corner with the wall at x = 4 the face stops at that wall's face; the front of the
  // baseboard stops a baseboard's depth earlier, where the other wall's baseboard front runs.
  near(b.max.x, 4 - 0.057, 'the back of the mitre meets the corner', 1e-3);
  const front = [];
  const pos = mesh.geometry.getAttribute('position');
  for (let i = 0; i < pos.count; i++) if (Math.abs(pos.getZ(i) - (WALL.thickness / 2 + p.T)) < 1e-6) front.push(pos.getX(i));
  near(Math.max(...front), 4 - 0.057 - p.T, 'the front of the mitre is shorter by its depth', 1e-3);
});

test('crown sits at the ceiling; fields draw every part', () => {
  const view = { walls: [WALL], rooms: [ROOM], wallHeight: 2.44 };
  const crown = Object.assign(T.trimTemplate('crown', null, WALL, 1, { wallHeight: 2.44 }), { id: 'c' });
  const m = buildTrimGroup(crown, WALL, view, [], X).children[0];
  m.geometry.computeBoundingBox();
  near(m.geometry.boundingBox.max.y, 2.44, 'touches the ceiling', 1e-6);
  for (const style of ['picture-frame', 'board-batten', 'grid', 'shaker', 'raised-panel', 'beadboard', 'v-groove', 'shiplap', 'slat', 'fluted']) {
    const t = Object.assign(T.trimTemplate(style, null, WALL, -1, { wallHeight: 2.44 }), { id: style });
    const g = buildTrimGroup(t, WALL, view, [DOOR], X);
    const mesh = g.children.find(o => o.isMesh);
    assert.ok(mesh && mesh.geometry.getAttribute('position').count > 0, style + ' draws');
    mesh.geometry.computeBoundingBox();
    assert.ok(mesh.geometry.boundingBox.max.z <= -WALL.thickness / 2 + 1e-6, style + ' sits on the other face');
    const n = mesh.geometry.getAttribute('normal');
    for (let i = 0; i < n.count; i++) assert.ok(Number.isFinite(n.getX(i)), style + ' normals');
  }
});
