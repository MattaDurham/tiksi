// Saved views (saved-views.js): records survive the project file and hostile input; a view
// keeps the tags it was saved with and gives them back. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.indexedDB = { open() { throw new Error('no IndexedDB under Node'); } };
const store = await import('../js/store.js');
const SV = await import('../js/saved-views.js');
const T = await import('../js/tags.js');

const state = (x = 5) => ({ camera: { position: [x, 4, 6], target: [0, 1, 0], fov: 45 }, mode: 'orbit', section: { on: true, height: 1.1 }, xray: false, hiddenLevels: [] });

test('a saved view keeps its camera and the tags shown when it was saved, and gives them back', () => {
  const p = store.propertyTemplate('Views');
  assert.deepEqual(p.savedViews, []);
  T.setTagShown(p, T.CANON.ceiling.id, false);
  const roof = T.ensureCanonTag(p, 'roof');
  roof.visible = false;
  const inside = SV.addSavedView(p, '', state());
  assert.equal(inside.name, 'View 1');
  assert.equal(inside.tags[T.CANON.ceiling.id], false);
  assert.equal(inside.tags[roof.id], false);
  assert.equal(inside.tags._untagged, true);
  // Everything shown again, then back to the view.
  for (const t of p.tags) t.visible = true;
  const later = T.addTag(p, 'Made later', { visible: false });
  assert.equal(SV.applySavedTags(p, inside), 2);
  assert.equal(T.tagById(p, roof.id).visible, false);
  assert.equal(T.tagById(p, T.CANON.walls.id).visible, true);
  assert.equal(later.visible, false, 'a tag made after the view keeps its own visibility');
  assert.equal(SV.addSavedView(p, '  Kitchen  ', state(7)).name, 'Kitchen');
  assert.equal(SV.nextViewName(p), 'View 3');
  // Update, rename, reorder, delete.
  SV.updateSavedView(p, inside.id, state(9));
  assert.deepEqual(p.savedViews[0].camera.position, [9, 4, 6]);
  assert.equal(p.savedViews[0].id, inside.id);
  assert.ok(SV.renameSavedView(p, inside.id, 'Cellar, roof off'));
  assert.equal(SV.renameSavedView(p, inside.id, '   '), false);
  assert.ok(SV.moveSavedView(p, inside.id, 1));
  assert.deepEqual(p.savedViews.map(v => v.name), ['Kitchen', 'Cellar, roof off']);
  assert.equal(SV.moveSavedView(p, inside.id, 1), false, 'the last tab cannot move right');
  assert.ok(SV.deleteSavedView(p, inside.id));
  assert.deepEqual(p.savedViews.map(v => v.name), ['Kitchen']);
});

test('hostile saved views are cleaned or dropped; the views travel in the project file', () => {
  const p = store.propertyTemplate('Hostile views');
  p.savedViews = [
    { id: 'v1', name: 'Good', camera: { position: [1, 2, 3], target: [0, 0, 0], fov: 500 }, mode: 'walk', tags: { 'tag-roof': false, bad: 'no', '../x': true }, section: { on: 'yes', height: 'x' }, xray: 1, hiddenLevels: ['lvl-0', 'lvl-0', 5, '../x'] },
    { id: 'v1', name: 'Same id', camera: { position: [1, 2, 3], target: [0, 0, 0] } },
    { id: 'v3', name: 'No camera' },
    { id: 'v4', name: 'NaN camera', camera: { position: [NaN, 0, 0], target: [0, 0, 0] } },
    { id: 'v5', name: 'Huge', camera: { position: [1e9, 0, 0], target: [0, 0, 0] } },
    null, 'view', [],
    { name: 'x'.repeat(200) + '\u0000', camera: { position: ['1', '2', '3'], target: [0, 0, 0] } },
  ];
  SV.normalizeSavedViews(p);
  assert.equal(p.savedViews.length, 3);
  const [a, b, c] = p.savedViews;
  assert.deepEqual(a, { id: 'v1', name: 'Good', camera: { position: [1, 2, 3], target: [0, 0, 0], fov: 150 }, mode: 'orbit', tags: { 'tag-roof': false }, section: { on: false, height: 1.2 }, xray: false, hiddenLevels: ['lvl-0'] });
  assert.notEqual(b.id, 'v1', 'a repeated id is replaced');
  assert.equal(c.name.length, 60);
  assert.deepEqual(c.camera.position, [1, 2, 3]);
  const again = JSON.parse(JSON.stringify(p));
  SV.normalizeSavedViews(again);
  assert.deepEqual(again.savedViews, p.savedViews, 'normalising twice changes nothing');
  store.ws.data = store.emptyWorkspace();
  store.ws.data.properties.push(p);
  const file = JSON.parse(JSON.stringify(store.projectSlice(p.id)));
  store.ws.data = store.emptyWorkspace();
  store.mergeWorkspace(file, { fromFile: true });
  assert.deepEqual(store.ws.data.properties.find(x => x.id === p.id).savedViews, p.savedViews);
  assert.throws(() => SV.addSavedView(p, 'Broken', { camera: { position: [0, 0], target: [0, 0, 0] } }));
});

test('a saved view keeps the objects hidden one by one, the models shown, pins and notes, and gives them back', () => {
  const p = store.propertyTemplate('Everything hidden');
  p.scans = [{ id: 'scan-a', name: 'Before', visible: true }, { id: 'scan-b', name: 'After', visible: false }];
  T.setHidden(p, ['wall:w-1', 'opening:o-2'], true);
  const v = SV.addSavedView(p, 'Clean cut', {
    ...state(), section: { on: true, height: 1.1, planes: [{ id: 'cut-1', kind: 'side', q: [0, Math.SQRT1_2, 0, Math.SQRT1_2], pos: [1, 1, 1] }], active: 'cut-1', done: true },
    models: SV.modelState(p), compare: 'after', markers: { pins: false, notes: true }, xrayOpacity: 0.4, uncertainty: true,
  });
  assert.deepEqual(v.hidden.sort(), ['opening:o-2', 'wall:w-1']);
  assert.deepEqual(v.models, { 'scan-a': true, 'scan-b': false });
  assert.equal(v.section.done, true, 'the section is saved clean');
  assert.deepEqual(v.markers, { pins: false, notes: true });
  assert.equal(v.compare, 'after');
  assert.equal(v.xrayOpacity, 0.4);
  assert.equal(v.uncertainty, true);
  // Something else hidden and the wall shown again; the view puts back exactly what it had.
  T.setHidden(p, ['wall:w-1'], false);
  T.setHidden(p, ['room:r-9', 'node:scan-a#0/3'], true);
  assert.equal(SV.applySavedHidden(p, v), 3, 'the wall back, the room and the model part shown');
  assert.deepEqual(SV.hiddenObjects(p).sort(), ['opening:o-2', 'wall:w-1']);
  assert.equal(SV.applySavedHidden(p, v), 0, 'nothing to change the second time');
  // A view from before Tiksi kept these leaves them as they are.
  const old = SV.normalizeSavedView({ name: 'Old', camera: { position: [1, 2, 3], target: [0, 0, 0] } });
  for (const k of ['hidden', 'models', 'compare', 'markers', 'xrayOpacity', 'uncertainty']) assert.equal(k in old, false, k);
  assert.equal('done' in old.section, false);
  assert.equal(SV.applySavedHidden(p, old), 0);
  assert.deepEqual(SV.hiddenObjects(p).sort(), ['opening:o-2', 'wall:w-1']);
  // Updating the view takes what is hidden now.
  T.showAllHidden(p);
  SV.updateSavedView(p, v.id, state());
  assert.deepEqual(p.savedViews.find(x => x.id === v.id).hidden, []);
});

test('the new view fields are cleaned of hostile input', () => {
  const v = SV.normalizeSavedView({
    name: 'Hostile', camera: { position: [1, 2, 3], target: [0, 0, 0] },
    hidden: ['wall:w-1', 'wall:w-1', 'nonsense', 5, '../../etc', 'x'.repeat(600)],
    models: { 'scan-a': true, 'bad id!': true, 'scan-b': 'yes' },
    compare: 'sideways', markers: { pins: 'no', notes: false, other: true }, xrayOpacity: 7, uncertainty: 'on',
    section: { on: true, done: 'yes' },
  });
  assert.deepEqual(v.hidden, ['wall:w-1']);
  assert.deepEqual(v.models, { 'scan-a': true });
  assert.equal('compare' in v, false);
  assert.deepEqual(v.markers, { notes: false });
  assert.equal(v.xrayOpacity, 1);
  assert.equal('uncertainty' in v, false);
  assert.equal('done' in v.section, false);
});

test('a saved view keeps the existing and proposed halves shown, and gives them back; older views leave them', async () => {
  const MV = await import('../js/mirror-views.js');
  const p = store.propertyTemplate('Halves');
  const furn = T.CANON.furniture.id;
  T.setPhaseShown(p, furn, 'e', false);
  T.setPhaseShown(p, '', 'p', false);
  const v = SV.addSavedView(p, 'Proposed furniture only', state());
  assert.equal(v.tags[T.phaseOverrideKey(furn, 'e')], false);
  assert.equal(v.tags[T.phaseOverrideKey(furn, 'p')], true);
  assert.equal(v.tags[T.phaseOverrideKey('', 'p')], false);
  T.setPhaseShown(p, furn, 'e', true); T.setPhaseShown(p, '', 'p', true);
  assert.equal(SV.applySavedTags(p, v), 2);
  assert.deepEqual(T.tagById(p, furn).phases, { e: false, p: true });
  assert.deepEqual(p.phaseShown, { e: true, p: false });
  const old = SV.normalizeSavedView({ name: 'Old', camera: state().camera, tags: { [furn]: true } }, new Set());
  assert.equal(SV.applySavedTags(p, old), 0, 'a view saved before the halves changes neither');
  // As a SketchUp scene: hidden halves by name, and back.
  const form = MV.viewForm(p, v);
  assert.ok(form.hidden.includes('Furniture and fixtures_e'));
  assert.ok(form.hidden.includes('Walls_p'), 'every proposed half hides with the whole-model switch');
  assert.ok(!form.hidden.includes('Walls_e'));
  assert.ok(!form.hidden.includes('Furniture and fixtures'), 'no plain tag names');
  const scene = { name: v.name, camera: { eye: [5, 6, -4], target: [0, 0, -1], perspective: true, fov: 45 }, hiddenTags: form.hidden.filter(n => n !== 'Furniture and fixtures_e'), origin: 'tiksi' };
  const now = MV.sceneForm(p, scene);
  const back = MV.applySceneToView(p, v, scene, now, form);
  assert.equal(back.tags[T.phaseOverrideKey(furn, 'e')], true, 'the half shown in SketchUp shows again');
  const fresh = MV.viewFromScene(p, { name: 'S', camera: scene.camera, hiddenTags: ['Walls_e'] }, null, new Set());
  assert.equal(fresh.tags[T.phaseOverrideKey(T.CANON.walls.id, 'e')], false);
  assert.equal(fresh.tags[T.phaseOverrideKey(T.CANON.walls.id, 'p')], true);
  // Shown in SketchUp while the view hides the whole tag: the tag shows, its other half hides.
  const whole = { ...v, tags: { ...v.tags, [T.CANON.walls.id]: false } };
  const wform = MV.viewForm(p, whole);
  const wscene = { ...scene, hiddenTags: wform.hidden.filter(n => n !== 'Walls_e') };
  const wback = MV.applySceneToView(p, whole, wscene, MV.sceneForm(p, wscene), wform);
  assert.equal(wback.tags[T.CANON.walls.id], true);
  assert.equal(wback.tags[T.phaseOverrideKey(T.CANON.walls.id, 'e')], true);
  assert.equal(wback.tags[T.phaseOverrideKey(T.CANON.walls.id, 'p')], false);
});
