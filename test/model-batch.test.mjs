// Grouped drawing of imported models (js/model-batch.js): parts that look alike share a draw,
// repeated geometry is instanced, and every part keeps its identity, its tag visibility, its
// picking and its material. Synthetic models only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import * as THREE from '../vendor/three.module.min.js';

const vendor = new URL('../vendor/', import.meta.url).href;
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'three') return { url: vendor + 'three.module.min.js', shortCircuit: true };
    return next(spec, ctx);
  },
});
const { ModelBatches, lookKey, INSTANCE_MIN } = await import('../js/model-batch.js');
const { modelParts, partKey, partKeyForObject } = await import('../js/tags-scene.js');
const { setModelXray } = await import('../js/model-xray.js');

const LOOKS = [0xb5651d, 0x4477aa, 0xdddddd];
// A loaded-model wrapper as scans.js builds it: wrapper > inner > glTF scene > parts. Every part
// has its own geometry and its own copy of its look's material (as the SketchUp converter
// writes them); `bottles` parts share one geometry and one material (component instances).
function model({ parts = 30, bottles = 12, mirrored = [] } = {}) {
  const wrapper = new THREE.Group(), inner = new THREE.Group(), scene = new THREE.Group();
  wrapper.add(inner); inner.add(scene);
  Object.assign(wrapper.userData, { kind: 'scan', id: 'scan-a', scanKind: 'mesh', inner });
  wrapper.name = 'scan:cellar.glb';
  for (let i = 0; i < parts; i++) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5 + (i % 4) * 0.1, 0.5), new THREE.MeshStandardMaterial({ color: LOOKS[i % 3], roughness: 0.7 }));
    m.name = 'Board ' + i; m.position.set(i % 6, Math.floor(i / 6), 0);
    if (mirrored.includes(i)) m.scale.set(-1, 1, 1);
    m.castShadow = true; m.receiveShadow = true;
    scene.add(m);
  }
  const bottle = new THREE.CylinderGeometry(0.04, 0.04, 0.3, 12), glass = new THREE.MeshStandardMaterial({ color: 0x113311 });
  for (let i = 0; i < bottles; i++) {
    const m = new THREE.Mesh(bottle, glass);
    m.name = 'Bottle ' + i; m.position.set(i * 0.1, 0, 2); m.rotation.x = Math.PI / 2;
    m.castShadow = true; m.receiveShadow = true;
    scene.add(m);
  }
  const world = new THREE.Scene();
  world.add(wrapper);
  wrapper.position.set(3, 0, -1); wrapper.rotation.y = 0.4;
  world.updateMatrixWorld(true);
  return { world, wrapper, inner, scene };
}
const frame = (b, wrapper) => { const r = b.beginFrame({ 'scan-a': wrapper }); b.endFrame(); return r; };
const proxyOf = (b, mesh) => b.members.get(mesh);

test('look keys ignore names and copies but not values or images', () => {
  const a = new THREE.MeshStandardMaterial({ color: 0xff0000, roughness: 0.5 }); a.name = 'Brick';
  const b = a.clone(); b.name = 'Brick copy 2'; b.userData.tiksiMaterialId = 'mat-1';
  assert.equal(lookKey(a), lookKey(b), 'a per-part copy is the same look');
  const c = a.clone(); c.roughness = 0.51;
  assert.notEqual(lookKey(a), lookKey(c), 'a different roughness is a different look');
  assert.notEqual(lookKey(a), lookKey(new THREE.MeshBasicMaterial({ color: 0xff0000 })), 'the material class counts');
  const image = { width: 2, height: 2 }, t1 = new THREE.Texture(image), t2 = t1.clone();
  const ta = a.clone(); ta.map = t1; const tb = a.clone(); tb.map = t2;
  assert.equal(lookKey(ta), lookKey(tb), 'two texture objects over one image are the same look');
  const tc = a.clone(); tc.map = new THREE.Texture({ width: 2, height: 2 });
  assert.notEqual(lookKey(ta), lookKey(tc), 'a different image is a different look');
  const td = a.clone(); td.map = t1.clone(); td.map.repeat.set(2, 2);
  assert.notEqual(lookKey(ta), lookKey(td), 'a different texture repeat is a different look');
});

test('parts of one look share a draw, repeated geometry is instanced, the part tree is untouched', () => {
  const { wrapper, scene } = model({ parts: 30, bottles: INSTANCE_MIN + 4 });
  const keysBefore = modelParts(wrapper).map(p => partKey('scan-a', p));
  const b = new ModelBatches();
  frame(b, wrapper);
  const s = b.stats();
  assert.equal(s.models, 1);
  assert.equal(s.parts, 30 + INSTANCE_MIN + 4, 'every part is drawn by a proxy');
  assert.equal(s.proxies, 4, 'three looks and one repeated bottle: four draws instead of ' + s.parts);
  assert.equal(s.batched, 30); assert.equal(s.instanced, INSTANCE_MIN + 4); assert.equal(s.solo, 0);
  assert.equal(scene.children.length, 30 + INSTANCE_MIN + 4, 'the originals stay in the tree');
  assert.deepEqual(modelParts(wrapper).map(p => partKey('scan-a', p)), keysBefore, 'part keys (child-index paths) do not change');
  const bottle = proxyOf(b, scene.children[30]);
  assert.ok(bottle.proxy.isInstancedMesh, 'the bottles are one instanced draw');
  assert.equal(bottle.proxy.geometry, scene.children[30].geometry, 'instancing shares the part geometry, no copy');
  assert.ok(proxyOf(b, scene.children[0]).proxy.isBatchedMesh);
  assert.equal(proxyOf(b, scene.children[0]).proxy, proxyOf(b, scene.children[3]).proxy, 'two copies of one look share a batch');
  assert.notEqual(proxyOf(b, scene.children[0]).proxy, proxyOf(b, scene.children[1]).proxy);
});

test('proxies draw every part exactly where the part is, mirrored parts included', () => {
  const { world, wrapper, scene } = model({ parts: 12, bottles: INSTANCE_MIN, mirrored: [0, 3, 6] });
  const b = new ModelBatches();
  world.add(b.root);
  b.beginFrame({ 'scan-a': wrapper });
  world.updateMatrixWorld(true);
  const m = new THREE.Matrix4();
  for (const part of scene.children) {
    const { proxy, member } = proxyOf(b, part);
    if (proxy.isBatchedMesh) proxy.getMatrixAt(member.slot, m);
    else if (proxy.isInstancedMesh) proxy.getMatrixAt(member.slot, m);
    else m.identity();
    const drawn = new THREE.Matrix4().multiplyMatrices(proxy.matrixWorld, m);
    // Instance matrices are stored as 32-bit floats.
    drawn.elements.forEach((v, i) => assert.ok(Math.abs(v - part.matrixWorld.elements[i]) < 1e-6, part.name + ' is drawn at its own transform'));
    // A mirrored part is drawn by a proxy whose own matrix is mirrored, so three flips the
    // winding for it (instance matrices alone would turn it inside out).
    assert.equal(proxy.matrixWorld.determinant() < 0, part.matrixWorld.determinant() < 0, part.name + ' keeps its facing');
  }
  assert.notEqual(proxyOf(b, scene.children[0]).proxy, proxyOf(b, scene.children[9]).proxy, 'a mirrored copy of a look has its own group');
  b.endFrame();
});

test('parts that were moved are drawn where they now are', () => {
  const { world, wrapper, scene } = model({ parts: 12, bottles: INSTANCE_MIN, mirrored: [3] });
  const b = new ModelBatches();
  world.add(b.root);
  b.beginFrame({ 'scan-a': wrapper }); b.endFrame();
  // One board of a shared look, one mirrored board, one instanced bottle (hidden while it moves).
  const moved = [scene.children[1], scene.children[3], scene.children[12 + 2]];
  moved[2].visible = false;
  b.beginFrame({ 'scan-a': wrapper }); b.endFrame();
  for (const part of moved) { part.position.x += 1.25; part.position.y -= 0.5; part.updateMatrix(); }
  world.updateMatrixWorld(true);
  b.partsMoved(moved);
  moved[2].visible = true;
  b.beginFrame({ 'scan-a': wrapper });
  world.updateMatrixWorld(true);
  const m = new THREE.Matrix4();
  for (const part of scene.children) {
    const { proxy, member } = proxyOf(b, part);
    if (proxy.isBatchedMesh || proxy.isInstancedMesh) proxy.getMatrixAt(member.slot, m); else m.identity();
    const drawn = new THREE.Matrix4().multiplyMatrices(proxy.matrixWorld, m);
    drawn.elements.forEach((v, i) => assert.ok(Math.abs(v - part.matrixWorld.elements[i]) < 1e-6, part.name + ' is drawn where it stands' + (moved.includes(part) ? ' after its move' : '')));
  }
  b.endFrame();
  // A move that mirrors a part regroups the model instead of drawing it inside out.
  scene.children[5].scale.x = -1; scene.children[5].updateMatrix(); world.updateMatrixWorld(true);
  b.partsMoved([scene.children[5]]);
  b.beginFrame({ 'scan-a': wrapper });
  world.updateMatrixWorld(true);
  assert.equal(proxyOf(b, scene.children[5]).proxy.matrixWorld.determinant() < 0, true, 'the mirrored part is drawn by a mirrored group');
  b.endFrame();
});

test('a frame swaps the originals out and the proxies in, and back', () => {
  const { wrapper, inner } = model();
  const b = new ModelBatches();
  assert.equal(b.root.visible, false);
  b.beginFrame({ 'scan-a': wrapper });
  assert.equal(inner.visible, false, 'the originals are not drawn during the frame');
  assert.equal(b.root.visible, true);
  b.endFrame();
  assert.equal(inner.visible, true, 'outside a frame the model is exactly as loaded');
  assert.equal(b.root.visible, false, 'and the proxies are out of every other render');
  wrapper.visible = false;
  b.beginFrame({ 'scan-a': wrapper });
  assert.equal(b.entries.get('scan-a').group.visible, false, 'a hidden model hides its proxies');
  b.endFrame();
});

test('hiding parts (tags) hides exactly their slots and asks for a shadow refresh', () => {
  const { wrapper, scene } = model({ parts: 30, bottles: INSTANCE_MIN + 2 });
  const b = new ModelBatches();
  frame(b, wrapper);
  assert.equal(frame(b, wrapper), false, 'nothing changed: no shadow refresh');
  const hidden = new Set([2, 5, 7, 31]);
  for (const i of hidden) scene.children[i].visible = false;
  assert.equal(frame(b, wrapper), true, 'a visibility change refreshes the shadow map');
  scene.children.forEach((part, i) => {
    assert.equal(b.drawsPart(part), !hidden.has(i), part.name + (hidden.has(i) ? ' is hidden' : ' is drawn'));
    const { proxy, member } = proxyOf(b, part);
    if (proxy.isBatchedMesh) assert.equal(proxy.getVisibleAt(member.slot), !hidden.has(i));
    if (proxy.isInstancedMesh) {
      const m = new THREE.Matrix4(); proxy.getMatrixAt(member.slot, m);
      assert.equal(m.determinant() !== 0, !hidden.has(i), 'a hidden instance collapses to nothing');
    }
  });
  scene.children[5].visible = true;
  frame(b, wrapper);
  assert.equal(b.drawsPart(scene.children[5]), true, 'shown again');
});

test('x-ray and material swaps carry over to the groups', () => {
  const { wrapper, scene } = model({ parts: 12, bottles: INSTANCE_MIN });
  const b = new ModelBatches();
  frame(b, wrapper);
  const batch = proxyOf(b, scene.children[0]).proxy;
  setModelXray(wrapper, 0.3);
  assert.equal(frame(b, wrapper), true, 'x-ray changes what casts shadows');
  assert.equal(proxyOf(b, scene.children[0]).proxy, batch, 'x-ray on a whole model keeps its groups');
  assert.equal(batch.material.transparent, true); assert.equal(batch.material.opacity, 0.3);
  assert.equal(batch.castShadow, false, 'x-ray parts cast no shadow, nor do their proxies');
  setModelXray(wrapper, null);
  frame(b, wrapper);
  assert.equal(batch.material.transparent, false); assert.equal(batch.castShadow, true);
  // A material bound to one part only (the MATERIALS binding) splits that part off its group.
  const other = model({ parts: 6, bottles: 0 });
  other.wrapper.userData.id = 'scan-b';
  const both = { 'scan-a': wrapper, 'scan-b': other.wrapper };
  b.beginFrame(both); b.endFrame();
  const red = new THREE.MeshStandardMaterial({ color: 0xff0000 });
  scene.children[3].material = red;
  b.beginFrame(both); b.endFrame();
  assert.equal(b.drawsPart(other.scene.children[0]), true, 'regrouping one model leaves the other model grouped');
  assert.ok(b.entries.get('scan-b').proxies);
  frame(b, wrapper);
  const moved = proxyOf(b, scene.children[3]);
  assert.equal(moved.proxy.material, red, 'the re-bound part is drawn with its new material');
  assert.notEqual(proxyOf(b, scene.children[0]).proxy.material, red, 'its old look-mates are not');
  assert.equal(b.stats().parts, 12 + INSTANCE_MIN, 'every part is still drawn');
});

test('picking still lands on the original parts', () => {
  const { world, wrapper, scene } = model({ parts: 12, bottles: INSTANCE_MIN });
  const b = new ModelBatches();
  world.add(b.root);
  frame(b, wrapper);
  world.updateMatrixWorld(true);
  const target = scene.children[4];
  const at = new THREE.Vector3().setFromMatrixPosition(target.matrixWorld);
  const ray = new THREE.Raycaster(at.clone().add(new THREE.Vector3(0, 0, 5)), new THREE.Vector3(0, 0, -1));
  // Proxies shown (as during a frame) or not, a ray only ever meets original parts.
  for (const shown of [false, true]) {
    b.root.visible = shown;
    const hits = ray.intersectObject(world, true);
    assert.ok(hits.length > 0);
    assert.ok(hits.every(h => !h.object.userData.drawingProxy), 'no hit on a proxy');
    assert.equal(hits[0].object, target);
    assert.equal(partKeyForObject(wrapper, hits[0].object), partKey('scan-a', modelParts(wrapper).find(p => p.object === target)));
  }
  b.root.visible = false;
});

test('an outline pass outlines the selected part by a stand-in and empties its slot meanwhile', () => {
  const { world, wrapper, scene } = model({ parts: 12, bottles: INSTANCE_MIN });
  const b = new ModelBatches();
  world.add(b.root);
  const part = scene.children[4], plain = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  const pass = { selectedObjects: [plain, part] };
  b.beginFrame({ 'scan-a': wrapper });
  world.updateMatrixWorld(true);
  const { proxy, member } = proxyOf(b, part);
  const restore = b.beginOutline(pass);
  assert.equal(pass.selectedObjects[0], plain, 'objects that are not grouped pass through');
  const stand = pass.selectedObjects[1];
  assert.notEqual(stand, part); assert.equal(stand.geometry, part.geometry); assert.equal(stand.material, part.material);
  assert.equal(stand.visible, true);
  assert.deepEqual(stand.matrix.elements, part.matrixWorld.elements, 'the stand-in sits where the part is');
  assert.equal(proxy.getVisibleAt(member.slot), false, 'the part does not hide its own outline');
  restore();
  assert.deepEqual(pass.selectedObjects, [plain, part]);
  assert.equal(stand.visible, false);
  assert.equal(proxy.getVisibleAt(member.slot), true);
  b.endFrame();
  assert.equal(b.beginOutline(pass)(), undefined, 'outside a frame nothing is swapped');
});

test('models that cannot be grouped draw as loaded; reloaded or removed models are dropped', () => {
  const { wrapper, inner, scene } = model({ parts: 6, bottles: 0 });
  scene.add(new THREE.PointLight());
  const b = new ModelBatches();
  b.beginFrame({ 'scan-a': wrapper });
  assert.equal(inner.visible, true, 'a model with its own light is drawn by its own meshes');
  b.endFrame();
  assert.equal(b.stats().models, 0);
  const next = model({ parts: 9, bottles: 0 });
  frame(b, next.wrapper);
  assert.equal(b.stats().parts, 9, 'a reloaded model (new wrapper) is grouped afresh');
  const again = model({ parts: 6, bottles: 0 });
  frame(b, again.wrapper);
  assert.equal(b.stats().parts, 6);
  b.beginFrame({}); b.endFrame();
  assert.equal(b.stats().models, 0, 'a removed model leaves no proxies behind');
  assert.equal(b.root.children.length, 1, 'only the outline holder is left');
  frame(b, again.wrapper);
  b.setEnabled(false);
  b.beginFrame({ 'scan-a': again.wrapper });
  assert.equal(again.inner.visible, true, 'grouping switched off draws the originals');
  b.endFrame();
});

// The components converter's shape (GLTFLoader output): one material per look, every rack an
// instance node over the rack definition's shared board meshes, and bottle instances nested
// inside each rack over one shared bottle mesh. Instance nodes carry their extras.
function componentModel({ racks = 22, boards = 20, bottles = 14 } = {}) {
  const wrapper = new THREE.Group(), inner = new THREE.Group(), scene = new THREE.Group();
  wrapper.add(inner); inner.add(scene);
  Object.assign(wrapper.userData, { kind: 'scan', id: 'scan-a', scanKind: 'mesh', inner });
  const looks = LOOKS.map(color => new THREE.MeshStandardMaterial({ color }));
  const boardGeometries = Array.from({ length: boards }, (_, i) => new THREE.BoxGeometry(0.9, 0.02 + i * 0.001, 0.3));
  const bottleGeometry = new THREE.CylinderGeometry(0.04, 0.04, 0.3, 12), glass = new THREE.MeshStandardMaterial({ color: 0x113311 });
  for (let r = 0; r < racks; r++) {
    const rack = new THREE.Group();
    rack.name = 'Rack ' + r; rack.position.set(r, 0, 0);
    rack.userData = { name: 'Rack ' + r, sketchupComponent: 'Wine rack', sketchupDefinitionId: 'def-rack', sketchupInstance: 'inst-r' + r };
    boardGeometries.forEach((g, i) => { const m = new THREE.Mesh(g, looks[i % 3]); m.position.y = i * 0.1; m.userData.sourceMaterials = [looks[i % 3]]; rack.add(m); });
    for (let b = 0; b < bottles; b++) {
      const inst = new THREE.Group();
      inst.userData = { sketchupComponent: 'Bottle', sketchupDefinitionId: 'def-bottle', sketchupInstance: 'inst-' + r + '-' + b };
      inst.position.set(b * 0.06, 0.5, 0);
      const m = new THREE.Mesh(bottleGeometry, glass); m.userData.sourceMaterials = [glass];
      inst.add(m); rack.add(inst);
    }
    scene.add(rack);
  }
  const world = new THREE.Scene();
  world.add(wrapper);
  world.updateMatrixWorld(true);
  return { world, wrapper, scene };
}

test('the components shape: shared boards batch by look, nested bottles instance, instance nodes stay', () => {
  const { world, wrapper, scene } = componentModel();
  const snapshot = o => ({ name: o.name, children: o.children.length, userData: JSON.stringify(Object.keys(o.userData)) });
  const before = [];
  scene.traverse(o => before.push(snapshot(o)));
  const keys = modelParts(wrapper).map(p => partKey('scan-a', p));
  const b = new ModelBatches();
  world.add(b.root);
  frame(b, wrapper);
  const s = b.stats();
  assert.equal(s.parts, 22 * (20 + 14));
  assert.equal(s.instanced, 22 * 14, 'the nested bottles are one instanced draw');
  assert.equal(s.batched, 22 * 20, 'the shared boards are batched by look');
  assert.equal(s.proxies, 3 + 1, 'three looks and the bottle: four draws for ' + s.parts + ' parts');
  const after = [];
  scene.traverse(o => after.push(snapshot(o)));
  assert.deepEqual(after, before, 'instance nodes, their meshes and their user data are untouched');
  assert.deepEqual(modelParts(wrapper).map(p => partKey('scan-a', p)), keys);
  const bottle = scene.children[3].children[25].children[0];
  assert.equal(bottle.userData.sourceMaterials[0], bottle.material);
  // Hiding one instance node (a components list toggling it) hides its parts only.
  scene.children[3].children[25].visible = false;
  frame(b, wrapper);
  assert.equal(b.drawsPart(bottle), false, 'a hidden instance hides its mesh');
  assert.equal(b.drawsPart(scene.children[3].children[26].children[0]), true, 'its neighbour stays');
  assert.equal(b.drawsPart(scene.children[4].children[25].children[0]), true, 'and so does the same bottle in the next rack');
  // Selecting an instance node outlines every part below it.
  const rack = scene.children[5], pass = { selectedObjects: [rack] };
  b.beginFrame({ 'scan-a': wrapper });
  world.updateMatrixWorld(true);
  const restore = b.beginOutline(pass);
  const stands = pass.selectedObjects.filter(o => o.userData.drawingProxy);
  assert.equal(stands.length, 20 + 14, 'one stand-in per mesh of the rack, nested bottles included');
  assert.ok(stands.every(o => o.visible));
  restore();
  assert.deepEqual(pass.selectedObjects, [rack]);
  b.endFrame();
});
