// Tags (tags.js, tags-scene.js): detection rules, hostile records, tag edits, visibility, and the
// tags of a synthetic model with a roof. Synthetic data only; no browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import * as THREE from '../vendor/three.module.min.js';

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
const T = await import('../js/tags.js');
const S = await import('../js/tags-scene.js');
const { buildPropertyGroup } = await import('../js/geometry.js');

test('names: Roof anywhere wins, otherwise the earliest building word decides', () => {
  const cases = {
    'Wall - door side (48 in wall + 32 in door)': 'walls',
    'Door 32 in (swings out)': 'openings',
    'Racking - north wall (bins)': 'furniture',
    'Roof deck and soffit over ceiling': 'roof',
    'Context - barn roof (metal)': 'roof',
    'house roof': 'roof',
    'Ceiling board under the rafters': 'ceiling',
    'Floor (stone tile)': 'floor',
    'Bottle (back)': 'furniture',
    'Landing counter - pool end': 'furniture',
    'Context - pool deck (concrete)': 'site',
    'Window, kitchen': 'openings',
    'Condensate drain line': null,
    '': null,
    'Mesh 12': null,
  };
  for (const [name, want] of Object.entries(cases)) assert.equal(T.nameTag(name), want, name);
  // Plural and case do not matter; words inside other words do not count.
  assert.equal(T.nameTag('ROOFS'), 'roof');
  assert.equal(T.nameTag('Wallpaper sample'), null, '"wall" inside "wallpaper" is not a wall');
  assert.equal(T.nameTag('Showcase'), null);
  assert.equal(T.nameTag('Roof_shingles_over_ceiling'), 'roof', 'underscores (GLTF node names) read as spaces');
  assert.equal(T.nameTag('Wall_-_door_side'), 'walls');
});

const level = { elevation: 0, height: 2.4 };
const stats = o => Object.assign({ area: 10, up: 0, down: 0, vertical: 0, sloped: 0, y0: 0, y1: 0 }, o);
test('shape: roof above the storey, floor at its foot, ceiling at its top, tall vertical walls, the rest furniture', () => {
  assert.equal(T.geometryTag(stats({ up: 5, down: 5, y0: 2.45, y1: 2.6 }), level), 'roof', 'flat slab above the level height');
  assert.equal(T.geometryTag(stats({ sloped: 9, vertical: 1, y0: 2.3, y1: 4 }), level), 'roof', 'pitched planes from the eaves up');
  assert.equal(T.geometryTag(stats({ sloped: 9, vertical: 1, y0: 0.2, y1: 0.9 }), level), 'furniture', 'a low sloped piece (a ramp, a lounger) is not a roof');
  assert.equal(T.geometryTag(stats({ up: 5, down: 5, y0: -0.05, y1: 0.02 }), level), 'floor');
  assert.equal(T.geometryTag(stats({ up: 5, down: 5, y0: 2.3, y1: 2.38 }), level), 'ceiling');
  assert.equal(T.geometryTag(stats({ vertical: 9, up: 1, y0: 0, y1: 2.4 }), level), 'walls');
  assert.equal(T.geometryTag(stats({ vertical: 9, up: 1, y0: 0, y1: 0.9 }), level), 'furniture', 'a low vertical box (a cabinet) is not a wall');
  assert.equal(T.geometryTag(stats({ up: 4, vertical: 6, y0: 0, y1: 0.75 }), level), 'furniture');
  // Measured from the storey it stands on.
  assert.equal(T.geometryTag(stats({ up: 5, down: 5, y0: 3.0, y1: 3.05 }), { elevation: 3, height: 2.4 }), 'floor');
  assert.equal(T.geometryTag(null, level), null);
  assert.equal(T.geometryTag(stats({ area: 0 }), level), null);
  assert.equal(T.geometryTag(stats({ y0: NaN }), level), null);
});

test('levels: a part belongs to the highest floor at or below its base', () => {
  const levels = [{ id: 'b', elevation: 3, height: 2.5 }, { id: 'a', elevation: 0, height: 2.7 }];
  assert.equal(T.levelFor(levels, 0.4).id, 'a');
  assert.equal(T.levelFor(levels, 2.9).id, 'b', 'a floor slab just under the upper floor counts as upstairs');
  assert.equal(T.levelFor(levels, -2).id, 'a', 'below every level: the lowest');
  assert.deepEqual(T.levelFor([], 1), { elevation: 0, height: 2.44 });
});

test('detection order: the file tag, then the whole record, then names (nearest first), then shape', () => {
  const roofShape = stats({ up: 10, y0: 3, y1: 3.1 });
  assert.deepEqual(T.detectTag({ fileTag: '  Room - Ceiling ', names: ['Roof shingles'], stats: roofShape, level }), { name: 'Room - Ceiling', from: 'file' });
  assert.deepEqual(T.detectTag({ names: ['Roof'], record: 'scan' }), { tag: 'scan', from: 'record' });
  assert.deepEqual(T.detectTag({ names: ['Door'], record: 'furnishings' }), { tag: 'furniture', from: 'record' });
  assert.deepEqual(T.detectTag({ names: ['Mesh 3', 'Front door', 'Roof'], stats: roofShape, level }), { tag: 'openings', from: 'name' });
  assert.deepEqual(T.detectTag({ names: ['Mesh 3'], stats: roofShape, level }), { tag: 'roof', from: 'geometry' });
  assert.deepEqual(T.detectTag({ names: [] }), { tag: 'furniture', from: 'geometry' });
});

test('hostile tag records are cleaned, and a clean record survives normalising unchanged', () => {
  const p = store.propertyTemplate('Hostile');
  p.walls = [{ id: 'w1', ax: 0, ay: 0, bx: 3, by: 0 }];
  p.scans = [{ id: 'scan-a', name: 'm.glb', kind: 'mesh' }];
  p.tags = [
    { id: 'tag-ok', name: 'Roof', visible: false, color: '#AABBCC' },
    { id: 'tag-ok', name: 'Duplicate id', visible: true },
    { id: '../evil', name: 'Bad id' },
    { id: 'tag-ctl', name: 'Ro\u0000of\n', color: 'red' },
    { id: 'tag-long', name: 'x'.repeat(500), visible: 'no' },
    { id: 'tag-empty', name: 42 },
    'not a tag', null, [],
  ];
  p.tagOf = JSON.parse('{"__proto__": "tag-ok", "wall:w1": "tag-ok", "wall:gone": "tag-ok", "node:scan-a#0/1": "tag-ctl", "node:scan-gone#0": "tag-ok", "node:scan-a#../x": "tag-ok", "opening:o1": "tag-missing", "room:r1": 7, "wall:w1x": ""}');
  p.tagDefaults = { wall: 'tag-missing', room: 5, ceiling: '', opening: 'tag-long', bogus: 'tag-ok' };
  p.tagUntaggedVisible = 'yes';
  T.normalizeTags(p);
  assert.deepEqual(p.tags.map(t => t.id), ['tag-ok', 'tag-ctl', 'tag-long', 'tag-empty']);
  assert.deepEqual(p.tags[0], { id: 'tag-ok', name: 'Roof', visible: false, color: '#aabbcc' });
  assert.equal(p.tags[1].name, 'Ro of', 'control characters become spaces');
  assert.equal(p.tags.filter(t => t.name === 'Roof').length, 1, 'no two tags share a name');
  assert.match(p.tags[1].color, /^#[0-9a-f]{6}$/);
  assert.equal(p.tags[2].name.length, 80);
  assert.equal(p.tags[2].visible, true, 'only false hides');
  assert.equal(p.tags[3].name, 'Tag');
  assert.deepEqual(Object.keys(p.tagOf).sort(), ['node:scan-a#0/1', 'wall:w1']);
  assert.equal(Object.getPrototypeOf(p.tagOf), Object.prototype, 'no prototype was replaced');
  assert.deepEqual(p.tagDefaults, { wall: '', room: '', ceiling: '', opening: 'tag-long', fixture: '', furniture: '' });
  assert.equal(p.tagUntaggedVisible, true);
  const again = JSON.parse(JSON.stringify(p));
  T.normalizeTags(again);
  assert.deepEqual(again, JSON.parse(JSON.stringify(p)), 'normalising twice changes nothing');
  for (const bad of [null, 5, 'tags', {}]) {
    const q = { walls: [], scans: [], tags: bad, tagOf: bad, tagDefaults: bad };
    T.normalizeTags(q);
    assert.ok(Array.isArray(q.tags) && typeof q.tagOf === 'object' && typeof q.tagDefaults === 'object');
  }
});

test('a property gets the plan tags; the old FURNITURE switch becomes the furniture tag', () => {
  const p = store.propertyTemplate('New');
  assert.deepEqual(p.tags.map(t => t.name), ['Walls', 'Floor', 'Ceiling', 'Doors and windows', 'Cabinets and built-ins', 'Furniture and fixtures']);
  assert.equal(p.tagDefaults.wall, T.CANON.walls.id);
  const old = { walls: [], scans: [], env: { hideFurniture: true } };
  T.normalizeTags(old);
  assert.equal(T.tagById(old, T.CANON.furniture.id).visible, false);
  assert.equal(T.tagById(old, T.CANON.builtins.id).visible, true, 'built-ins stay, as before');
  assert.equal('hideFurniture' in old.env, false);
});

test('plan elements follow their kind until moved; deleting a tag moves its objects to Untagged', () => {
  const p = store.propertyTemplate('Edits');
  p.walls = [{ id: 'w1' }, { id: 'w2' }];
  p.rooms = [{ id: 'r1', pts: [] }];
  p.openings = [{ id: 'o1', wallId: 'w1' }];
  p.fixtures = [{ id: 'f1', kind: 'furniture' }, { id: 'f2', kind: 'base-run' }];
  assert.equal(T.tagIdOf(p, 'wall:w1'), T.CANON.walls.id);
  assert.equal(T.tagIdOf(p, 'ceiling:r1'), T.CANON.ceiling.id);
  assert.equal(T.tagIdOf(p, 'fixture:f1'), T.CANON.furniture.id);
  assert.equal(T.tagIdOf(p, 'fixture:f2'), T.CANON.builtins.id);
  assert.equal(T.tagIdOf(p, 'node:scan-x#0'), undefined, 'a model part waits for detection');
  const red = T.addTag(p, 'Demolish', { color: '#ff0000' });
  assert.equal(T.addTag(p, 'demolish').name, 'demolish (2)', 'names stay unique, ignoring case');
  assert.equal(T.assignTag(p, ['wall:w2', 'opening:o1', 'not a key'], red.id), 2);
  assert.throws(() => T.assignTag(p, ['wall:w1'], 'tag-nope'));
  assert.equal(T.tagCounts(p).get(red.id), 2);
  assert.equal(T.tagCounts(p).get(T.CANON.walls.id), 1);
  assert.ok(T.renameTag(p, red.id, '  Demolition  '));
  assert.equal(T.tagById(p, red.id).name, 'Demolition');
  assert.equal(T.renameTag(p, red.id, '   '), false, 'a blank name is refused');
  T.deleteTag(p, T.CANON.walls.id);
  assert.equal(T.tagIdOf(p, 'wall:w1'), '', 'the wall that followed Walls is Untagged now');
  assert.equal(T.tagIdOf(p, 'wall:w2'), red.id, 'a moved wall stays where it was put');
  T.deleteTag(p, red.id, T.CANON.floor.id);
  assert.equal(T.tagIdOf(p, 'wall:w2'), T.CANON.floor.id, 'a delete can move objects to another tag');
  assert.deepEqual(T.keysOnTag(p, '').sort(), ['wall:w1']);
});

test('visibility: a hidden tag hides its objects; a view may override any tag', () => {
  const p = store.propertyTemplate('Vis');
  p.walls = [{ id: 'w1' }];
  T.setTagShown(p, T.CANON.walls.id, false);
  assert.equal(T.keyShown(p, 'wall:w1'), false);
  assert.equal(T.keyShown(p, 'wall:w1', { [T.CANON.walls.id]: true }), true, 'a view shows a tag the model hides');
  assert.equal(T.keyShown(p, 'room:r1'), true);
  assert.equal(T.keyShown(p, 'room:r1', { [T.CANON.floor.id]: false }), false);
  T.assignTag(p, ['wall:w1'], '');
  assert.equal(T.keyShown(p, 'wall:w1'), true);
  T.setTagShown(p, '', false);
  assert.equal(T.keyShown(p, 'wall:w1'), false, 'Untagged can be hidden too');
  assert.equal(T.keyShown(p, 'wall:w1', { _untagged: true }), true);
});

// A synthetic model: one flat roof slab above a 2.4 m storey, a wall, a floor, a chair, and a
// part the file put on a SketchUp tag.
function syntheticModel() {
  const wrapper = new THREE.Group(), inner = new THREE.Group(), scene = new THREE.Group();
  wrapper.name = 'scan:shed.glb';
  wrapper.userData = { kind: 'scan', id: 'scan-shed', scanKind: 'mesh', inner };
  wrapper.add(inner); inner.add(scene);
  const box = (name, w, h, d, x, y, z, ud) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d)); m.name = name; m.position.set(x, y, z); if (ud) m.userData = ud; scene.add(m); return m; };
  const roof = box('Mesh 0', 4, 0.12, 3, 0, 2.6, 0);
  const wall = box('Mesh 1', 4, 2.4, 0.1, 0, 1.2, -1.5);
  const floor = box('Mesh 2', 4, 0.05, 3, 0, 0, 0);
  const chair = box('Mesh 3', 0.5, 0.9, 0.5, 1, 0.45, 0);
  const tagged = box('Shed door', 0.9, 2, 0.05, -1, 1, 1.5, { sketchupTag: 'Openings - shed' });
  wrapper.updateMatrixWorld(true);
  return { wrapper, roof, wall, floor, chair, tagged };
}

test('a model with a roof: parts are detected, stored, hidden by tag and found by key', () => {
  const p = store.propertyTemplate('Shed');
  p.levels[0].height = 2.4;
  const scan = { id: 'scan-shed', name: 'shed.glb', kind: 'mesh' };
  p.scans = [scan];
  const m = syntheticModel();
  assert.equal(S.detectModelTags(p, scan, m.wrapper), 5);
  const tagOf = o => T.tagById(p, p.tagOf[S.partKeyForObject(m.wrapper, o)]).name;
  assert.equal(tagOf(m.roof), 'Roof');
  assert.equal(tagOf(m.wall), 'Walls');
  assert.equal(tagOf(m.floor), 'Floor');
  assert.equal(tagOf(m.chair), 'Furniture and fixtures');
  assert.equal(tagOf(m.tagged), 'Openings - shed', 'the SketchUp tag wins over the name');
  assert.equal(S.detectModelTags(p, scan, m.wrapper), 0, 'a second load keeps what was stored');
  // The owner's correction survives a re-detect.
  const chairKey = S.partKeyForObject(m.wrapper, m.chair);
  T.assignTag(p, [chairKey], T.CANON.builtins.id);
  S.detectModelTags(p, scan, m.wrapper);
  assert.equal(p.tagOf[chairKey], T.CANON.builtins.id);
  // Hiding Roof hides the slab only.
  T.setTagShown(p, T.CANON.roof.id, false);
  S.applyModelTagVisibility(p, scan, m.wrapper);
  assert.deepEqual([m.roof, m.wall, m.floor, m.chair, m.tagged].map(o => o.visible), [false, true, true, true, true]);
  S.applyModelTagVisibility(p, scan, m.wrapper, { [T.CANON.roof.id]: true });
  assert.equal(m.roof.visible, true, 'a view that shows Roof shows the slab');
  assert.equal(S.partName(S.partByKey(m.wrapper, chairKey)), 'Mesh 3');
  // Assignments travel through the project file and come back.
  store.ws.data = store.emptyWorkspace();
  store.ws.data.properties.push(p);
  const file = JSON.parse(JSON.stringify(store.projectSlice(p.id)));
  store.ws.data = store.emptyWorkspace();
  store.mergeWorkspace(file, { fromFile: true });
  const back = store.ws.data.properties.find(x => x.id === p.id);
  assert.equal(back.tagOf[chairKey], T.CANON.builtins.id);
  assert.equal(T.tagById(back, T.CANON.roof.id).visible, false);
  T.forgetScanTags(back, 'scan-shed');
  assert.equal(T.scanHasTags(back, 'scan-shed'), false);
});

test('a point cloud is one part on Scan capture; the plan model hides walls by tag', () => {
  const p = store.propertyTemplate('Cloud');
  const scan = { id: 'scan-pc', name: 'survey.ply', kind: 'points' };
  const wrapper = new THREE.Group(), inner = new THREE.Group();
  wrapper.userData = { kind: 'scan', id: 'scan-pc', scanKind: 'points', inner };
  wrapper.add(inner); inner.add(new THREE.Points(new THREE.BufferGeometry()));
  assert.equal(S.detectModelTags(p, scan, wrapper), 1);
  assert.equal(p.tagOf['node:scan-pc#*'], T.CANON.scan.id);
  // Plan: walls hidden, the floor stays.
  p.walls = [{ id: 'w1', ax: 0, ay: 0, bx: 4, by: 0, thickness: 0.1, level: p.levels[0].id }];
  p.rooms = [{ id: 'r1', level: p.levels[0].id, pts: [[0, 0], [4, 0], [4, 3], [0, 3]] }];
  T.setTagShown(p, T.CANON.walls.id, false);
  const root = buildPropertyGroup(p, {});
  const shown = kind => { const out = []; root.traverse(o => { if (o.isMesh && S.planKeyOf(o)?.startsWith(kind + ':')) out.push(o.visible); }); return out; };
  assert.ok(shown('wall').length && shown('wall').every(v => v === false), 'every wall mesh hidden');
  assert.ok(shown('room').length && shown('room').every(Boolean), 'the floor shows');
  const all = buildPropertyGroup(p, { tags: false });
  const walls = []; all.traverse(o => { if (o.isMesh && S.planKeyOf(o)?.startsWith('wall:')) walls.push(o.visible); });
  assert.ok(walls.every(Boolean), 'an export build keeps hidden tags');
});
