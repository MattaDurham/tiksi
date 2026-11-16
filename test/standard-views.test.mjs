// The standard view set (js/standard-views.js) and saved views as scenes of the SketchUp sync
// file (js/mirror-views.js): the rules match the fixture the Python copy is held to, a refresh
// keeps ids and the owner's names and work, and a view becomes the scene SketchUp needs.
// Synthetic data only; test/test_scene_sync.py runs the same through real SketchUp files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.indexedDB = { open() { throw new Error('no IndexedDB under Node'); } };
const store = await import('../js/store.js');
const SV = await import('../js/standard-views.js');
const saved = await import('../js/saved-views.js');
const MV = await import('../js/mirror-views.js');
const mirror = await import('../js/sketchup-mirror.js');
const T = await import('../js/tags.js');

const fixture = JSON.parse(readFileSync(new URL('./fixtures/standard-views.json', import.meta.url), 'utf8'));
function close(got, want, path = 'set') {
  if (Array.isArray(want)) { assert.equal(got.length, want.length, path); want.forEach((w, i) => close(got[i], w, path + '[' + i + ']')); }
  else if (want && typeof want === 'object') { assert.deepEqual(Object.keys(got).sort(), Object.keys(want).sort(), path); for (const k of Object.keys(want)) close(got[k], want[k], path + '.' + k); }
  else if (typeof want === 'number') assert.ok(Math.abs(got - want) < 2e-6, path + ': ' + got + ' vs ' + want);
  else assert.equal(got, want, path);
}

function property() {
  const p = store.propertyTemplate('Standard views');
  const L = p.levels[0].id;
  p.rooms.push({ id: 'r-k', level: L, name: 'Kitchen', pts: [[0, 0], [4, 0], [4, 3], [0, 3]] });
  p.rooms.push({ id: 'r-d', level: L, name: 'Den', pts: [[4, 0], [7, 0], [7, 3], [4, 3]] });
  return p;
}

test('the rules make the fixture\'s sets, which the Python copy is held to', () => {
  for (const c of fixture.cases) close(SV.standardSet(c.input), c.views, c.about);
});

test('a property gets an overview, a plan and an elevation for each wall of each room', () => {
  const p = property();
  assert.deepEqual(SV.refreshStandardViews(p), { added: 10, updated: 0, removed: 0, skipped: 0 });
  assert.deepEqual(p.savedViews.map(v => v.name), ['Overview', 'Plan', 'Kitchen, north wall', 'Kitchen, east wall', 'Kitchen, south wall', 'Kitchen, west wall', 'Den, north wall', 'Den, east wall', 'Den, south wall', 'Den, west wall']);
  const plan = p.savedViews[1], north = p.savedViews[2];
  assert.equal(plan.mode, 'top'); assert.equal(plan.camera.parallel, true);
  assert.ok(plan.camera.position[1] > plan.camera.target[1]);
  assert.deepEqual(plan.section.planes[0].pos.map(v => Math.round(v * 1e4) / 1e4), [3.5, 1.2192, 1.5]);   // 4'-0" up, over the middle
  // The north wall (plan y = 0 with north up the plan): looked at from the south, cut 1" short of the far wall.
  assert.equal(north.camera.parallel, true);
  assert.ok(north.camera.position[2] > 0 && north.camera.target[2] === 0);
  assert.ok(Math.abs(north.section.planes[0].pos[2] - (3 - 0.0254)) < 1e-6);
  assert.equal(north.section.on, true); assert.equal(north.section.done, true);
  // Elevations are framed for the wall: the kitchen's 13'-1 1/2" (4 m) wall and 8'-0" (2.44 m) room.
  const halfH = Math.hypot(...north.camera.position.map((v, i) => v - north.camera.target[i])) * Math.tan(25 * Math.PI / 180);
  assert.ok(Math.abs(halfH - Math.max(2.44, 4 / 1.5) / 2 * 1.12) < 1e-5);
});

test('a refresh keeps ids, places and the owner\'s names, takes away views of walls that are gone and leaves the owner\'s views alone', () => {
  const p = property();
  SV.refreshStandardViews(p);
  const ids = p.savedViews.map(v => v.id);
  const own = saved.addSavedView(p, 'My corner', { camera: { position: [1, 1.6, 1], target: [3, 1, 2], fov: 50 }, mode: 'orbit', section: { on: false, height: 1.2 }, xray: false, hiddenLevels: [] });
  saved.renameSavedView(p, ids[2], 'Kitchen, range wall');
  saved.moveSavedView(p, ids[3], -1);
  // The den is gone; the kitchen is now 15'-0" (4.572 m) deep.
  p.rooms = p.rooms.filter(r => r.id !== 'r-d');
  p.rooms[0].pts = [[0, 0], [4, 0], [4, 4.572], [0, 4.572]];
  assert.deepEqual(SV.refreshStandardViews(p), { added: 0, updated: 6, removed: 4, skipped: 0 });
  assert.deepEqual(p.savedViews.map(v => v.name), ['Overview', 'Plan', 'Kitchen, east wall', 'Kitchen, range wall', 'Kitchen, south wall', 'Kitchen, west wall', 'My corner']);
  assert.deepEqual(p.savedViews.slice(0, 6).map(v => v.id), [ids[0], ids[1], ids[3], ids[2], ids[4], ids[5]]);
  assert.ok(Math.abs(p.savedViews[3].section.planes[0].pos[2] - (4.572 - 0.0254)) < 1e-6);
  assert.equal(p.savedViews[6], own);
  // A view of the set updated by hand is the owner's: the refresh makes a fresh one beside it.
  saved.updateSavedView(p, ids[0], { camera: { position: [9, 9, 9], target: [0, 0, 0], fov: 50 } });
  assert.equal(SV.isStandard(p.savedViews[0]), false);
  assert.equal(SV.refreshStandardViews(p).added, 1);
  assert.deepEqual(p.savedViews[0].camera.position, [9, 9, 9]);
  assert.equal(p.savedViews.at(-1).name, 'Overview');
});

test('an empty property gets no views; a property keeps at most 100', () => {
  const p = store.propertyTemplate('Empty');
  assert.deepEqual(SV.refreshStandardViews(p), { added: 0, updated: 0, removed: 0, skipped: 0 });
  const big = property();
  big.savedViews = Array.from({ length: 95 }, (_, i) => saved.normalizeSavedView({ name: 'V' + i, camera: { position: [0, 1, 5], target: [0, 1, 0] } }));
  const r = SV.refreshStandardViews(big);
  assert.equal(r.added, 5); assert.equal(r.skipped, 5); assert.equal(big.savedViews.length, 100);
});

test('a saved view becomes the scene SketchUp needs, and an imported model\'s view stays out of the sync file', () => {
  const p = property();
  const furniture = T.addTag(p, 'Furniture');
  SV.refreshStandardViews(p);
  const plan = MV.viewScene(p, p.savedViews[1]);
  assert.equal(plan.camera.perspective, false);
  // Straight down: the top of the picture is north (plan -y, world -z).
  assert.ok(plan.camera.up[2] < -0.99, JSON.stringify(plan.camera.up));
  assert.ok(Math.abs(plan.camera.height - 2 * Math.hypot(...p.savedViews[1].camera.position.map((v, i) => v - p.savedViews[1].camera.target[i])) * Math.tan(25 * Math.PI / 180)) < 1e-5);
  assert.deepEqual(plan.cut.normal, [0, 1, 0]);
  const v = p.savedViews[2];
  v.tags = { [furniture.id]: false };
  p.levels.push({ id: 'lvl-up', name: 'Upper', elevation: 3, height: 2.4 });
  v.hiddenLevels = ['lvl-up'];
  assert.deepEqual(MV.viewScene(p, v).hidden, ['Furniture', 'Tiksi: Upper']);
  p.savedViews.push({ ...v, id: 'view-imported', source: { app: 'sketchup', scan: 'scan-a', scene: 'A1' } });
  const spec = mirror.mirrorSpec(p, []);
  assert.equal(spec.views.length, 10);
  assert.ok(!spec.views.some(s => s.id === 'view-imported'));
  assert.ok(!('view-imported' in spec.elements));
  assert.equal(spec.elements[v.id].kind, 'view');
});

test('a view\'s fingerprint ignores what SketchUp cannot change the picture by', () => {
  const p = property();
  SV.refreshStandardViews(p);
  const f = MV.viewForm(p, p.savedViews[2]);
  // A parallel camera further back along its line shows the same picture.
  const back = { ...f, eye: f.eye.map((x, i) => x + (f.eye[i] - f.target[i])) };
  assert.equal(MV.viewSig(back), MV.viewSig(f));
  assert.notEqual(MV.viewSig({ ...f, height: f.height + 0.01 }), MV.viewSig(f));
  assert.notEqual(MV.viewSig({ ...f, name: 'Other' }), MV.viewSig(f));
  // Tiksi's TOP leans a hair off plumb; SketchUp's plan looks straight down: the same.
  const plan = MV.viewForm(p, p.savedViews[1]);
  assert.equal(MV.viewSig({ ...plan, eye: [plan.target[0], plan.eye[1], plan.target[2]] }), MV.viewSig(plan));
});
