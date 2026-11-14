// SketchUp scenes as saved views (sketchup-scenes.js): a scene's camera lands where SketchUp had it
// through the imported model's placement, a parallel scene shows the same height, a plan becomes
// TOP with the scene's up at the top of the screen, a scene hides the model's tags it hid, and
// bringing the scenes in again updates their views instead of adding copies. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.indexedDB = { open() { throw new Error('no IndexedDB under Node'); } };
const store = await import('../js/store.js');
const SS = await import('../js/sketchup-scenes.js');
const SV = await import('../js/saved-views.js');
const T = await import('../js/tags.js');

const near = (a, b, msg) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-6, (msg || '') + ' ' + JSON.stringify(a) + ' vs ' + JSON.stringify(b)));
const overview = { name: '01 Overview', camera: { eye: [2, 3, 4], target: [0, 1, 0], up: [0, 1, 0], perspective: true, fov: 50 }, hiddenTags: ['Roof'], useCamera: true, useTags: true };
const plan = { name: 'A1 Plan', camera: { eye: [1, 15, -2], target: [1, 0, -2], up: [0, 0, -1], perspective: false, height: 5 }, hiddenTags: [], useTags: true };
const elevation = { name: 'A2 Elevation - backyard wall', camera: { eye: [10, 1, -2], target: [0, 1, -2], up: [0, 1, 0], perspective: false, height: 3 }, hiddenTags: ['Ceiling'] };

function property() {
  const p = store.propertyTemplate('Scenes');
  const roof = T.addTag(p, 'Roof'), walls = T.addTag(p, 'Walls of the model'), ceiling = T.tagById(p, T.CANON.ceiling.id), other = T.addTag(p, 'Someone else', { visible: false });
  const scan = { id: 'scan-a', name: 'Cellar.skp', pos: [0, 0, 0], rot: [0, 0, 0], scale: 1, sketchupScenes: [overview, plan, elevation] };
  p.scans = [scan];
  p.tagOf = { 'node:scan-a#0': roof.id, 'node:scan-a#1': walls.id, 'node:scan-b#0': other.id };
  return { p, scan, roof, walls, ceiling, other };
}

test('each scene becomes a saved view with its camera, its tags and the model shown', () => {
  const { p, scan, roof, walls, ceiling, other } = property();
  assert.deepEqual(SS.bringInScenes(p, scan), { added: 3, updated: 0, skipped: 0 });
  const [a, b, c] = p.savedViews;
  assert.deepEqual(p.savedViews.map(v => v.name), ['01 Overview', 'A1 Plan', 'A2 Elevation - backyard wall']);
  near(a.camera.position, [2, 3, 4]); near(a.camera.target, [0, 1, 0]);
  assert.equal(a.camera.fov, 50); assert.equal(a.camera.parallel, undefined); assert.equal(a.mode, 'orbit');
  // The model's tags: the hidden one off, the other on; a tag only the scene names (by name, any
  // case: here Tiksi's own Ceiling) is off too; a tag of another model is left alone.
  assert.deepEqual(a.tags, { [roof.id]: false, [walls.id]: true });
  assert.deepEqual(c.tags, { [roof.id]: true, [walls.id]: true, [ceiling.id]: false });
  assert.equal(other.id in a.tags, false);
  assert.deepEqual(a.models, { 'scan-a': true });
  assert.ok(a.hiddenLevels.length > 0);
  assert.deepEqual(a.hiddenLevels, p.levels.map(l => l.id), 'Tiksi\'s own walls and rooms are put away');
  assert.deepEqual(a.source, { app: 'sketchup', scan: 'scan-a', scene: '01 Overview' });
  // A parallel scene: Tiksi shows the height its camera sees at the target, d * tan(fov / 2) each way.
  for (const [v, h] of [[b, 5], [c, 3]]) {
    assert.equal(v.camera.parallel, true);
    const d = Math.hypot(...v.camera.position.map((x, i) => x - v.camera.target[i]));
    assert.ok(Math.abs(2 * d * Math.tan(v.camera.fov * Math.PI / 360) - h) < 1e-4, v.name + ' shows ' + h + ' m');
  }
  // The plan is TOP, a hair off plumb toward the bottom of the picture (the scene's up is -z).
  assert.equal(b.mode, 'top');
  assert.ok(b.camera.position[2] > b.camera.target[2] && b.camera.position[2] - b.camera.target[2] < 0.05);
  assert.equal(c.mode, 'orbit');
  near(c.camera.target, [0, 1, -2]); assert.ok(c.camera.position[0] > 0 && Math.abs(c.camera.position[1] - 1) < 1e-9);
  // Going to a view restores the tags as SketchUp had them.
  for (const t of p.tags) t.visible = true;
  SV.applySavedTags(p, a);
  assert.equal(T.tagById(p, roof.id).visible, false);
  assert.equal(T.tagById(p, other.id).visible, true);
});

test('the model\'s placement moves, turns and scales every scene camera with it', () => {
  const { p, scan } = property();
  scan.pos = [10, 0, 5]; scan.rot = [0, 90, 0]; scan.scale = 2;
  SS.bringInScenes(p, scan);
  // A quarter turn about Y takes (x, y, z) to (z, y, -x); then x2, then moved.
  near(p.savedViews[0].camera.position, [10 + 8, 6, 5 - 4]);
  near(p.savedViews[0].camera.target, [10, 2, 5]);
  scan.flip = true; scan.rot = [0, 0, 0]; scan.scale = 1; scan.pos = [0, 0, 0];
  SS.bringInScenes(p, scan);
  near(p.savedViews[0].camera.position, [2, -3, -4], 'a flipped model turns its cameras over too');
});

test('bringing the scenes in again updates their views in place, and keeps other views', () => {
  const { p, scan } = property();
  SV.addSavedView(p, 'Mine', { camera: { position: [1, 1, 1], target: [0, 0, 0], fov: 40 } });
  SS.bringInScenes(p, scan);
  const ids = p.savedViews.map(v => v.id);
  SV.moveSavedView(p, ids[3], -2);   // the elevation swapped places with the overview
  scan.sketchupScenes = [{ ...overview, camera: { ...overview.camera, eye: [5, 5, 5] } }, plan, elevation, { ...overview, name: '02 New' }];
  assert.deepEqual(SS.bringInScenes(p, scan), { added: 1, updated: 3, skipped: 0 });
  assert.deepEqual(p.savedViews.map(v => v.name), ['Mine', 'A2 Elevation - backyard wall', 'A1 Plan', '01 Overview', '02 New']);
  near(p.savedViews[3].camera.position, [5, 5, 5]);
  assert.equal(p.savedViews[3].id, ids[1]);
  assert.equal(SS.scenesShown(p, scan), 4);
  // The views and their link to the scenes survive the project file.
  const back = SV.normalizeSavedViews(JSON.parse(JSON.stringify({ savedViews: p.savedViews })));
  assert.deepEqual(back.savedViews.map(v => v.source && v.source.scene), [undefined, 'A2 Elevation - backyard wall', 'A1 Plan', '01 Overview', '02 New']);
});

test('hostile or partial scenes are cleaned or left out, and a full property takes no more', () => {
  const clean = SS.normalizeScenes([null, 'x', { name: 'No camera' }, { name: 'Bad', camera: { eye: [0, 0, 'x'], target: [0, 0, 0] } },
    { name: '  A\u0000B  ', camera: { eye: [0, 1, 2], target: [0, 1, 0], perspective: true, fov: 400 }, hiddenTags: ['T', 'T', 7, ''] },
    { camera: { eye: [0, 1, 2], target: [0, 1, 0], up: [0, 0, 0], perspective: false, height: -1 } }]);
  assert.equal(clean.length, 2);
  assert.equal(clean[0].name, 'A B'); assert.equal(clean[0].camera.fov, undefined); assert.deepEqual(clean[0].hiddenTags, ['T']);
  assert.equal(clean[1].name, 'Scene 2'); assert.deepEqual(clean[1].camera.up, [0, 1, 0]); assert.equal(clean[1].camera.height, undefined);
  assert.deepEqual(SS.normalizeScenes({}), []);
  const { p, scan } = property();
  for (let i = 0; i < 99; i++) SV.addSavedView(p, 'V' + i, { camera: { position: [1, 1, 1 + i], target: [0, 0, 0], fov: 40 } });
  assert.deepEqual(SS.bringInScenes(p, scan), { added: 1, updated: 0, skipped: 2 });
  assert.equal(p.savedViews.length, 100);
});

test('a scene that keeps no tags leaves every tag as it is', () => {
  const { p, scan } = property();
  scan.sketchupScenes = [{ ...overview, useTags: false }];
  SS.bringInScenes(p, scan);
  assert.deepEqual(p.savedViews[0].tags, {});
});
