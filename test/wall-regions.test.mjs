// Wall regions (js/wall-regions.js): a room face divided by its trim and casings into the pieces
// PAINT paints one at a time, the paint marks that give each its finish, and the meshes
// geometry.js draws them as. Synthetic plans only.
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
const { roomFaces } = await import('../js/room-faces.js');
const { faceRegions, paintRegion, paintFace, regionLabel, wallPaint } = await import('../js/wall-regions.js');
const { trimTemplate, trimProduct } = await import('../js/trims.js');
const { buildPropertyGroup } = await import('../js/geometry.js');

const T = 0.15, H = 2.5;
const wall = (id, ax, ay, bx, by, extra = {}) => ({ id, ax, ay, bx, by, thickness: T, height: H, level: 'l1', ...extra });
const near = (a, b, msg, tol = 1e-6) => assert.ok(Math.abs(a - b) < tol, `${msg}: ${a} is not ${b}`);

// The 8 x 4 m house of room-faces.test.mjs: a kitchen and a living room either side of a
// partition with a door; the living room's north wall is two walls in one line, with a window.
function house() {
  return {
    walls: [wall('n1', 0, 0, 5, 0), wall('n2', 5, 0, 8, 0), wall('e', 8, 0, 8, 4), wall('s', 8, 4, 0, 4), wall('w', 0, 4, 0, 0), wall('mid', 3, 0, 3, 4)],
    rooms: [{ id: 'k', name: 'Kitchen', level: 'l1', pts: [[0, 0], [3, 0], [3, 4], [0, 4]] }, { id: 'l', name: 'Living', level: 'l1', pts: [[3, 0], [8, 0], [8, 4], [3, 4]] }],
    openings: [{ id: 'door', wallId: 'mid', type: 'door', t: 0.5, width: 0.9, height: 2.03 },
      { id: 'win', wallId: 'n2', type: 'window', t: 0.5, width: 1.2, height: 1.2, sill: 0.9 }],
    trims: [],
    heightOf: () => H,
  };
}
const face = (h, label) => roomFaces(h).find(f => f.label === label);
const regionsOf = (h, label) => faceRegions(face(h, label), h);
const rail = (h, wallId, side, at = {}) => { const t = { ...trimTemplate('chair-rail', null, h.walls.find(w => w.id === wallId), side, { wallHeight: H, ...at }), id: 'rail-' + wallId }; h.trims.push(t); return t; };
const labels = (h, res) => res.regions.map(r => regionLabel(r, h.trims, res.regions.length));

test('a face with no trim and no opening is one region, the whole wall', () => {
  const h = house(), res = regionsOf(h, 'Kitchen, west wall');
  assert.equal(res.regions.length, 1);
  near(res.regions[0].area, (4 - T) * H, 'the face, floor to ceiling');
  assert.equal(regionLabel(res.regions[0], h.trims, 1), '');
  assert.equal(res.regions[0].finish, null, 'no mark: the face\'s own finish');
});

test('a short run at a room boundary draws every part of the finished wall once', () => {
  const h = house();
  h.walls = [wall('north', 0, 0, 5, 0)];
  h.rooms = [{ id: 'k', name: 'Kitchen', level: 'l1', pts: [[0.007, 0], [5, 0], [5, 4], [0.007, 4]] }];
  h.openings = [];
  h.levels = [{ id: 'l1', elevation: 0, height: H }];
  const group = buildPropertyGroup(h);
  const bounds = [];
  group.traverse(mesh => {
    if (mesh.userData.kind !== 'wall' || mesh.userData.side !== 1) return;
    mesh.geometry.computeBoundingBox();
    bounds.push([mesh.geometry.boundingBox.min.x, mesh.geometry.boundingBox.max.x]);
  });
  bounds.sort((a, b) => a[0] - b[0]);
  assert.equal(bounds.length, 2);
  near(bounds[0][0], 0, 'the short piece reaches the wall end');
  near(bounds[0][1], bounds[1][0], 'adjacent room faces meet without overlapping');
  near(bounds[1][1], 5, 'the main face reaches the opposite end');
});

test('a chair rail across a face makes the wall above it and the wall below it two regions', () => {
  const h = house();
  rail(h, 'n1', 1); rail(h, 'n2', 1);
  const res = regionsOf(h, 'Living, north wall');
  assert.deepEqual(labels(h, res), ['below the chair rail', 'above the chair rail']);
  const [below, above] = res.regions, W = trimProduct(h.trims[0]).W;
  near(below.y1, 0.84, 'the wall below stops at the rail\'s bottom edge');
  near(above.y0, 0.84 + W, 'the wall above starts at its top edge');
  assert.deepEqual([...new Set(above.cells.map(c => c.wallId))].sort(), ['n1', 'n2'], 'one region across both walls of the run');
  assert.ok(above.area > below.area && above.area < (5 - T) * (H - 0.84 - W), 'the window and its casing are not wall');
});

test('a door to the floor parts the wall beside it; over the door the wall is one piece', () => {
  const h = house();
  rail(h, 'mid', 1); rail(h, 'mid', -1);
  for (const label of ['Kitchen, east wall', 'Living, west wall']) {
    const res = regionsOf(h, label);
    assert.deepEqual(labels(h, res), ['below the chair rail', 'below the chair rail', 'above the chair rail'], label);
    assert.ok(res.regions[0].x1 < res.regions[1].x0, 'left and right of the door');
    near(res.regions[2].x1 - res.regions[2].x0, 4 - T, 'the wall above runs the whole face, over the door');
  }
});

test('a paint mark stays with its region when the rail moves, and wins when the rail goes', () => {
  const h = house();
  const r1 = rail(h, 'n1', 1), r2 = rail(h, 'n2', 1);
  let res = regionsOf(h, 'Living, north wall');
  paintRegion(res, res.regions[1], h.walls, 'mat-paint-navy');
  assert.equal(h.walls.flatMap(wallPaint).length, 1, 'one mark for one region, however many walls it lies on');
  res = regionsOf(h, 'Living, north wall');
  assert.deepEqual(res.regions.map(r => r.finish), [null, 'mat-paint-navy']);
  r1.y = r2.y = 1.1;
  res = regionsOf(h, 'Living, north wall');
  assert.deepEqual(res.regions.map(r => r.finish), [null, 'mat-paint-navy'], 'the rail moved up; the paint is still above it');
  paintRegion(res, res.regions[1], h.walls, 'mat-paint-sage');
  assert.equal(h.walls.flatMap(wallPaint).length, 1, 'repainting replaces the mark');
  h.trims.length = 0;
  res = regionsOf(h, 'Living, north wall');
  assert.deepEqual(res.regions.map(r => r.finish), ['mat-paint-sage'], 'no rail: one region in the paint that was put on');
  paintRegion(res, res.regions[0], h.walls, '');
  assert.equal(h.walls.flatMap(wallPaint).length, 0);
  assert.ok(h.walls.every(w => !('paint' in w)), 'no empty list is left on the wall');
});

test('a rail that stops a few inches short of the corner still divides; one that stops well short does not', () => {
  const h = house();
  rail(h, 'w', 1, { f0: 0.03, f1: 0.98 });
  assert.equal(regionsOf(h, 'Kitchen, west wall').regions.length, 2);
  h.trims[0].f0 = 0.25;
  const res = regionsOf(h, 'Kitchen, west wall');
  assert.equal(res.regions.length, 1, 'the wall runs round the end of the rail');
  near(res.regions[0].area, (4 - T) * H - (res.regions[0].hidden.reduce((n, c) => n + (c.s1 - c.s0) * (c.v1 - c.v0), 0)), 'all of it but the strip behind the rail');
});

test('the wall inside a board and batten field is a region of its own; picture-frame boxes divide nothing', () => {
  const h = house();
  const w = h.walls.find(x => x.id === 'w');
  h.trims.push({ ...trimTemplate('board-batten', null, w, 1, { wallHeight: H }), id: 'bb' });
  let res = regionsOf(h, 'Kitchen, west wall');
  const inside = res.regions.find(r => r.field === 'bb');
  assert.ok(inside, 'the field\'s wall');
  assert.equal(regionLabel(inside, h.trims, res.regions.length), 'inside the board and batten');
  const over = res.regions.find(r => !r.field && r.y0 >= inside.y1 - 1e-6);
  assert.ok(over, 'and the wall over it');
  assert.equal(regionLabel(over, h.trims, res.regions.length), 'above the board and batten');
  assert.ok(res.regions.every(r => r.y1 - r.y0 > 0.05 && r.x1 - r.x0 > 0.05), 'no sliver between the floor and the field');
  h.trims = [{ ...trimTemplate('picture-frame', null, w, 1, { wallHeight: H }), id: 'pf' }];
  res = regionsOf(h, 'Kitchen, west wall');
  assert.equal(res.regions.length, 1);
});

test('painting a whole face sets its side\'s own finish and clears the marks on it', () => {
  const h = house();
  rail(h, 'w', 1);
  const res = regionsOf(h, 'Kitchen, west wall');
  paintRegion(res, res.regions[0], h.walls, 'mat-paint-navy');
  paintRegion(res, res.regions[1], h.walls, 'mat-paint-sage');
  const w = h.walls.find(x => x.id === 'w');
  assert.equal(wallPaint(w).length, 2);
  paintFace(face(h, 'Kitchen, west wall'), h.walls, 'mat-paint-terra');
  assert.equal(w.materialPos, 'mat-paint-terra');
  assert.equal(wallPaint(w).length, 0);
  paintFace(face(h, 'Kitchen, west wall'), h.walls, '');
  assert.ok(!('materialPos' in w));
});

test('the 3D view draws each region as its own mesh, named by its face and region', () => {
  const h = house();
  rail(h, 'w', 1);
  const res = regionsOf(h, 'Kitchen, west wall');
  paintRegion(res, res.regions[1], h.walls, 'mat-paint-navy');
  const prop = { id: 'p', levels: [{ id: 'l1', name: 'Main', elevation: 0, height: H }], wallHeight: H, walls: h.walls, rooms: h.rooms, openings: h.openings, trims: h.trims, fixtures: [], tags: [] };
  const root = buildPropertyGroup(prop, { tags: false });
  const id = face(h, 'Kitchen, west wall').id, meshes = [];
  root.traverse(o => { if (o.isMesh && o.userData.faceId === id) meshes.push(o); });
  assert.deepEqual(meshes.map(m => m.userData.region).sort(), res.regions.map(r => r.key).sort());
  const level = root.userData.levels[0].group;
  assert.equal(level.userData.regions.get(id).regions[1].finish, 'mat-paint-navy', 'the level keeps its faces\' regions for the viewer');
  // Each mesh covers its own region and nothing else.
  for (const m of meshes) {
    const r = res.regions.find(x => x.key === m.userData.region);
    m.geometry.computeBoundingBox();
    near(m.geometry.boundingBox.min.y, Math.min(r.y0, ...r.hidden.map(c => c.v0)), r.key + ' bottom', 1e-3);
    near(m.geometry.boundingBox.max.y, Math.max(r.y1, ...r.hidden.map(c => c.v1)), r.key + ' top', 2e-3);
  }
});
