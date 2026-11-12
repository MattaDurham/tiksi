// The objects of an imported model (js/model-objects.js): what one click picks, going further
// in, and moving one object. Hiding one object (js/tags.js). Synthetic models only; no browser.
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
const T = await import('../js/tags.js');
const S = await import('../js/tags-scene.js');
const O = await import('../js/model-objects.js');

const box = (name, at) => { const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()); m.userData.name = name; m.position.set(...at); return m; };
const instance = (component, at, extra = {}) => { const g = new THREE.Group(); g.userData = { name: component, sketchupComponent: component, sketchupDefinitionId: 'guid-' + component, ...extra }; g.position.set(...at); return g; };
function wrap(id, ...children) {
  const wrapper = new THREE.Group(), inner = new THREE.Group(), scene = new THREE.Group();
  inner.name = 'inner'; if (children.length) scene.add(...children); inner.add(scene); wrapper.add(inner);
  wrapper.name = 'scan:' + id; wrapper.userData = { kind: 'scan', id, scanKind: 'mesh', inner };
  wrapper.updateMatrixWorld(true);
  return wrapper;
}
// A kitchen the way the SketchUp converter writes one: two cabinets of one definition, each
// with its own faces in two materials and a nested hinge; a group written as two meshes of
// one name; loose faces of the model itself.
function kitchen() {
  const cabinet = (at, label) => {
    const c = instance('Base cabinet', at, label ? { sketchupInstanceName: label } : {});
    c.add(box('Base cabinet', [0, 0, 0]), box('Base cabinet', [0, 1, 0]));
    const hinge = instance('Hinge', [0.4, 0.5, 0]);
    hinge.add(box('Hinge', [0, 0, 0]));
    const screw = instance('Screw', [0, 0.1, 0]);
    screw.add(box('Screw', [0, 0, 0]));
    hinge.add(screw);
    c.add(hinge);
    return c;
  };
  return wrap('scan-k', cabinet([0, 0, 0], 'Sink base'), cabinet([3, 0, 0]), box('Island', [6, 0, 0]), box('Island', [6, 1, 0]), box('Kitchen', [9, 0, 0]));
}

test('a click picks the whole object; a double-click goes one object further in', () => {
  const w = kitchen(), tree = O.modelObjectTree(w);
  assert.deepEqual(tree.roots.map(o => [o.kind, o.name, o.meshes.length]), [['component', 'Sink base', 4], ['component', 'Base cabinet', 4], ['part', 'Island', 2], ['part', 'Kitchen', 1]]);
  assert.equal(tree.whole, false);
  const sink = tree.roots[0];
  assert.equal(sink.component, 'Base cabinet', 'an instance with its own name keeps its definition name');
  assert.deepEqual(sink.children.map(o => o.name), ['Hinge'], 'the faces named after the component are the component itself');
  const screwMesh = sink.children[0].children[0].meshes[0];
  assert.equal(O.objectForClick(tree, screwMesh, null), sink, 'a click on the screw picks the cabinet it is in');
  const hinge = O.objectBelow(tree, screwMesh, sink.key);
  assert.equal(hinge.name, 'Hinge');
  const screw = O.objectBelow(tree, screwMesh, hinge.key);
  assert.equal(screw.name, 'Screw');
  assert.equal(O.objectBelow(tree, screwMesh, screw.key), screw, 'nothing further in: it stays');
  // With the hinge selected, a click on the cabinet's own face stays inside the cabinet:
  // there is no object there but the cabinet's faces, so the cabinet is picked.
  assert.equal(O.objectForClick(tree, sink.meshes[0], hinge.key), sink);
  // With the screw selected, a click elsewhere in the same hinge picks at the screw's depth.
  assert.equal(O.objectForClick(tree, screwMesh, screw.key), screw);
  assert.equal(O.objectForClick(tree, tree.roots[1].meshes[0], screw.key), tree.roots[1], 'a click outside goes back to whole objects');
  assert.equal(O.sameComponent(tree, sink).length, 2);
  // Every mesh key of an object is a real part key of the model.
  const partKeys = new Set(S.modelParts(w).map(p => S.partKey('scan-k', p)));
  for (const o of tree.byKey.values()) for (const k of o.meshKeys) assert.ok(partKeys.has(k), k);
  assert.equal(tree.roots[2].meshKeys.length, 2, 'a group written as two meshes is one object');
});

test('one solid, a scan mesh or a point cloud is a single object', () => {
  assert.equal(O.modelObjectTree(wrap('scan-a', box('Mesh', [0, 0, 0]))).whole, true);
  const cloud = wrap('scan-b'); cloud.userData.scanKind = 'points';
  const t = O.modelObjectTree(cloud);
  assert.equal(t.whole, true);
  assert.deepEqual(t.roots[0].meshKeys, ['node:scan-b#*']);
  // A glTF mesh with several materials loads as a named group of bare meshes: one object.
  const multi = new THREE.Group(); multi.userData.name = 'Sofa'; multi.add(box('Sofa_1', [0, 0, 0]), box('Sofa_2', [0, 0, 0]));
  const lamp = box('Lamp', [2, 0, 0]);
  const t2 = O.modelObjectTree(wrap('scan-c', multi, lamp));
  assert.deepEqual(t2.roots.map(o => [o.kind, o.name, o.children.length, o.meshes.length]), [['group', 'Sofa', 0, 2], ['part', 'Lamp', 0, 1]]);
  // A plain file: separately named meshes straight under the file's named top node are
  // separate objects, not one.
  const top = new THREE.Group(); top.userData.name = 'AuxScene';
  top.add(box('Box 0 0', [0, 0, 0]), box('Box 0 1', [1, 0, 0]), box('Box 0 2', [2, 0, 0]));
  const flat = new THREE.Group(), flatInner = new THREE.Group();
  flatInner.add(top); flat.add(flatInner); flat.name = 'scan:flat'; flat.userData = { kind: 'scan', id: 'scan-d', scanKind: 'mesh', inner: flatInner };
  const t3 = O.modelObjectTree(flat);
  assert.equal(t3.whole, false);
  assert.deepEqual(t3.roots.map(o => [o.kind, o.name]), [['part', 'Box 0 0'], ['part', 'Box 0 1'], ['part', 'Box 0 2']]);
  assert.equal(O.objectForClick(t3, top.children[1], null), t3.roots[1], 'a click picks the one box');
});

test('hiding one object leaves its tag and the other objects alone', () => {
  const w = kitchen(), tree = O.modelObjectTree(w);
  const prop = T.normalizeTags({ scans: [{ id: 'scan-k' }], walls: [{ id: 'w1' }], rooms: [], openings: [], fixtures: [] });
  const tag = T.addTag(prop, 'Cabinets');
  for (const o of tree.roots) T.assignTag(prop, o.meshKeys, tag.id);
  const [sink, other] = tree.roots;
  assert.equal(T.setHidden(prop, sink.meshKeys, true), 4);
  S.applyModelTagVisibility(prop, { id: 'scan-k' }, w);
  assert.ok(sink.meshes.every(m => !m.visible), 'the hidden cabinet is not drawn');
  assert.ok(other.meshes.every(m => m.visible), 'the other cabinet on the same tag still is');
  assert.equal(T.tagById(prop, tag.id).visible, true, 'the tag itself was not touched');
  assert.equal(T.setHidden(prop, ['wall:w1', 'nonsense'], true), 1, 'plan objects hide the same way; bad keys are ignored');
  assert.equal(T.keyShown(prop, 'wall:w1'), false);
  // A reload keeps what is hidden and drops keys that name nothing.
  prop.hidden['wall:gone'] = true; prop.hidden['node:scan-x#0'] = true; prop.hidden['wall:w1'] = 'yes';
  const again = T.normalizeTags(JSON.parse(JSON.stringify(prop)));
  assert.deepEqual(Object.keys(again.hidden).sort(), sink.meshKeys.slice().sort());
  assert.deepEqual(T.showAllHidden(again).length, 4);
  S.applyModelTagVisibility(again, { id: 'scan-k' }, w);
  assert.ok(sink.meshes.every(m => m.visible), 'show all brings it back');
  T.setHidden(prop, sink.meshKeys, true);
  T.forgetScanTags(prop, 'scan-k');
  assert.deepEqual(Object.keys(prop.hidden).filter(k => k.startsWith('node:scan-k#')), [], 'a deleted model takes its hidden objects with it');
});

test('moving one object moves it and nothing else, and can be put back', () => {
  const w = kitchen(), tree = O.modelObjectTree(w), scan = { id: 'scan-k' };
  w.position.set(10, 0, 0); w.rotation.y = Math.PI / 2; w.scale.setScalar(2); w.updateMatrixWorld(true);
  const [sink, other, island] = tree.roots;
  const centre = o => O.objectBox(o).getCenter(new THREE.Vector3());
  const before = [sink, other, island].map(centre);
  O.setObjectOffset(scan, sink, [1, 0, 0]);
  const meshes = O.applyPartOffsets(scan, w);
  assert.equal(meshes.length, 4, 'the four meshes of the cabinet moved');
  // One metre along the model's own x: the model is turned a quarter and doubled, so two
  // metres along world -z.
  const d = centre(sink).sub(before[0]);
  assert.ok(Math.abs(d.x) < 1e-6 && Math.abs(d.y) < 1e-6 && Math.abs(d.z + 2) < 1e-6, d.toArray().join(','));
  assert.ok(centre(other).distanceTo(before[1]) < 1e-9 && centre(island).distanceTo(before[2]) < 1e-9, 'the others stay');
  // Applying again does not move it twice.
  O.applyPartOffsets(scan, w);
  assert.ok(Math.abs(centre(sink).sub(before[0]).z + 2) < 1e-6);
  // A nested object moves inside a turned parent by the same rule (model frame).
  const hinge = sink.children[0];
  sink.nodes[0].rotation.y = Math.PI / 2; sink.nodes[0].updateMatrix(); w.updateMatrixWorld(true);
  const hingeBefore = centre(hinge);
  O.setObjectOffset(scan, hinge, [0, 0.5, 0]);
  O.applyPartOffsets(scan, w);
  const dh = centre(hinge).sub(hingeBefore);
  assert.ok(Math.abs(dh.y - 1) < 1e-6 && Math.abs(dh.x) < 1e-6 && Math.abs(dh.z) < 1e-6, dh.toArray().join(','));
  // A group written as several meshes moves as one.
  O.setObjectOffset(scan, island, [0, 0, 1]);
  assert.equal(O.applyPartOffsets(scan, w).length >= 2, true);
  // Back to where the file has them.
  O.setObjectOffset(scan, sink, [0, 0, 0]); O.setObjectOffset(scan, hinge, [0, 0, 0]); O.setObjectOffset(scan, island, [0, 0, 0]);
  assert.equal(scan.partOffsets, undefined, 'no offsets left on the record');
  O.applyPartOffsets(scan, w);
  sink.nodes[0].rotation.y = 0; sink.nodes[0].updateMatrix(); w.updateMatrixWorld(true);
  assert.ok(centre(sink).distanceTo(before[0]) < 1e-6 && centre(island).distanceTo(before[2]) < 1e-6);
  // Hostile records are ignored, not applied.
  assert.deepEqual(O.partOffsets({ partOffsets: { '0/0': [1, 2, 3], '../x': [1, 1, 1], '0/1': [1, NaN, 0], '0/2': 'far', '*': [1, 1, 1], '0/3': [0, 0, 0], '0/4': [1e9, 0, 0] } }), { '0/0': [1, 2, 3] });
});
