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
