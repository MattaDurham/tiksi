// Declared planar mirror surfaces: geometry, transform and ownership regressions.
// All scenes and materials are synthetic; reflected pixels are checked in the browser suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import * as THREE from '../vendor/three.module.min.js';

const vendor = new URL('../vendor/', import.meta.url).href;
registerHooks({ resolve(spec, ctx, next) {
  if (spec === 'three') return { url: vendor + 'three.module.min.js', shortCircuit: true };
  if (spec.startsWith('three/addons/')) return { url: vendor + 'addons/' + spec.slice(13), shortCircuit: true };
  return next(spec, ctx);
} });
globalThis.indexedDB = { open() { throw new Error('no IndexedDB under Node'); } };
const { ModelMirrors, planarSurface } = await import('../js/model-mirrors.js');
const { materialLook, shareModelMaterials } = await import('../js/model-materials.js');

const close = (a, b, message, tolerance = 2e-6) => assert.ok(a.distanceTo(b) < tolerance, message + ': ' + a.toArray() + ' versus ' + b.toArray());
function material(side = THREE.FrontSide) {
  const m = new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.04, metalness: 1, side });
  m.name = 'Synthetic polished surface'; m.userData.tiksiMirror = { type: 'planar' }; return m;
}
function scene(geometry = new THREE.PlaneGeometry(2, 1), surfaceMaterial = material()) {
  const world = new THREE.Scene(), wrapper = new THREE.Group(), parent = new THREE.Group();
  const mesh = new THREE.Mesh(geometry, surfaceMaterial);
  world.add(wrapper); wrapper.add(parent); parent.add(mesh);
  const mirrors = new ModelMirrors(); world.add(mirrors.root);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 100);
  camera.position.set(0, 0, 5); camera.lookAt(0, 0, 0); camera.updateMatrixWorld(true);
  return { world, wrapper, parent, mesh, mirrors, camera, update(options) { mirrors.update({ model: wrapper }, camera, options); } };
}

test('only explicit mirror declarations get reflections; sharing keeps identical unmarked materials separate', () => {
  const plain = material(); delete plain.userData.tiksiMirror;
  const marked = plain.clone(); marked.userData.tiksiMirror = { type: 'planar' };
  const copy = marked.clone();
  assert.notEqual(materialLook(marked), materialLook(plain), 'rendering semantics are part of the sharing key');
  assert.equal(materialLook(marked), materialLook(copy), 'two equivalent declarations can still share');
  const s = scene(undefined, plain);
  const a = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), marked);
  const b = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), copy);
  s.parent.add(a, b);
  assert.equal(shareModelMaterials(s.wrapper).slots.length, 2);
  assert.equal(a.material, b.material);
  assert.notEqual(a.material, s.mesh.material);
  s.update();
  assert.equal(s.mirrors.entries.size, 2);
  assert.equal(s.mirrors.entries.has(s.mesh), false, 'name, metalness and polish do not imply a mirror');
  s.mirrors.dispose();
});

test('runtime mirror vertices preserve transformed surfaces without editing imported geometry, materials or hierarchy', () => {
  const transforms = [
    new THREE.Matrix4().compose(new THREE.Vector3(2, -1, -3), new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, 0.6, -0.2)), new THREE.Vector3(2, 0.7, 1.3)),
    new THREE.Matrix4().compose(new THREE.Vector3(-2, 1, -2), new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.2, 0.4, 0.3)), new THREE.Vector3(-1.4, 0.6, 2)),
    new THREE.Matrix4().set(1.2, 0.4, 0.1, 2, 0.1, 0.8, 0.2, 1, 0, 0.2, 1.1, -3, 0, 0, 0, 1),
  ];
  for (const transform of transforms) {
    const s = scene();
    s.wrapper.matrixAutoUpdate = false; s.wrapper.matrix.copy(transform);
    s.mesh.position.set(0.1, 0.2, 0.3); s.mesh.rotation.set(0.2, -0.1, 0.4);
    s.world.updateMatrixWorld(true);
    const sourceGeometry = s.mesh.geometry, sourceMaterial = s.mesh.material;
    const positions = Array.from(sourceGeometry.attributes.position.array), indices = Array.from(sourceGeometry.index.array);
    const worldCenter = new THREE.Vector3().applyMatrix4(s.mesh.matrixWorld);
    const normal = new THREE.Vector3(0, 0, 1).applyMatrix3(new THREE.Matrix3().getNormalMatrix(s.mesh.matrixWorld)).normalize();
    s.camera.position.copy(worldCenter).addScaledVector(normal, 5); s.camera.lookAt(worldCenter);
    s.update();
    const e = s.mirrors.entries.get(s.mesh), runtime = e.reflector;
    assert.ok(runtime.visible, 'front face remains visible through the affine transform');
    for (let i = 0; i < sourceGeometry.attributes.position.count; i++) {
      const expected = new THREE.Vector3().fromBufferAttribute(sourceGeometry.attributes.position, i).applyMatrix4(s.mesh.matrixWorld);
      const actual = new THREE.Vector3().fromBufferAttribute(runtime.geometry.attributes.position, i).applyMatrix4(runtime.matrixWorld);
      close(actual, expected, 'world vertex ' + i);
    }
    close(e.normal, normal, 'normal uses the inverse transpose, including negative scales');
    const basis = [0, 1, 2].map(column => new THREE.Vector3().setFromMatrixColumn(runtime.matrixWorld, column));
    for (const axis of basis) assert.ok(Math.abs(axis.length() - 1) < 1e-10);
    for (const [a, b] of [[0, 1], [1, 2], [0, 2]]) assert.ok(Math.abs(basis[a].dot(basis[b])) < 1e-10, 'reflection frame is orthogonal after shear');
    assert.equal(s.mesh.geometry, sourceGeometry); assert.equal(s.mesh.material, sourceMaterial);
    assert.deepEqual(Array.from(sourceGeometry.attributes.position.array), positions);
    assert.deepEqual(Array.from(sourceGeometry.index.array), indices);
    assert.deepEqual(s.parent.children, [s.mesh], 'no runtime children are inserted into source paths');
    assert.equal(s.mesh.visible, true);
    assert.equal(runtime.raycast(new THREE.Raycaster(), []), undefined, 'overlay cannot replace the pickable source');
    s.mirrors.dispose();
  }
});

test('front, back and double-sided surfaces keep their authored facing semantics', () => {
  for (const side of [THREE.FrontSide, THREE.BackSide, THREE.DoubleSide]) {
    const s = scene(undefined, material(side));
    for (const z of [5, -5, 5]) {
      s.camera.position.set(0, 0, z); s.camera.lookAt(0, 0, 0); s.update();
      const e = s.mirrors.entries.get(s.mesh);
      assert.equal(e.reflector.visible, side === THREE.DoubleSide || (side === THREE.FrontSide ? z > 0 : z < 0));
      if (e.reflector.visible) assert.ok(e.normal.z * z > 0, 'capture plane faces the viewing side');
      assert.equal(s.mesh.material.side, side, 'runtime facing does not rewrite the source');
    }
    s.mirrors.dispose();
  }
});

test('an irregular oblique triangle uses its actual plane rather than its off-plane box center', () => {
  const geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1], 3));
  const surface = planarSurface(geometry);
  assert.ok(surface);
  assert.ok(Math.abs(surface.center.x + surface.center.y + surface.center.z - 1) < 1e-10, 'the reflection origin is on x+y+z=1');
  const s = scene(geometry);
  s.camera.position.copy(surface.center).addScaledVector(surface.normal, 4); s.camera.lookAt(surface.center);
  s.update();
  const e = s.mirrors.entries.get(s.mesh);
  assert.equal(e.reflector.visible, true);
  close(e.center, surface.center, 'reflection origin remains coplanar');
  for (let i = 0; i < 3; i++) {
    const p = new THREE.Vector3().fromBufferAttribute(e.reflector.geometry.attributes.position, i);
    assert.ok(Math.abs(p.z) < 1e-7, 'canonical reflector plane contains every triangle vertex');
    close(p.applyMatrix4(e.reflector.matrixWorld), new THREE.Vector3().fromBufferAttribute(geometry.attributes.position, i), 'oblique vertex ' + i);
  }
  s.mirrors.dispose();
});

test('unsupported geometry remains ordinary model geometry instead of fabricating a planar reflection', () => {
  const bent = new THREE.PlaneGeometry(2, 1); bent.attributes.position.setZ(0, 0.2);
  const degenerate = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0], 3));
  const mixed = new THREE.PlaneGeometry(2, 1); const mixedIndex = mixed.index.array; [mixedIndex[3], mixedIndex[4]] = [mixedIndex[4], mixedIndex[3]];
  const partial = new THREE.PlaneGeometry(2, 1); partial.setDrawRange(0, 3);
  const morph = new THREE.PlaneGeometry(2, 1); morph.morphAttributes.position = [morph.attributes.position.clone()];
  for (const geometry of [new THREE.BoxGeometry(2, 1, 0.1), new THREE.SphereGeometry(1, 8, 8), bent, degenerate, mixed, partial, morph]) {
    const s = scene(geometry), positions = Array.from(geometry.attributes.position.array);
    assert.equal(planarSurface(geometry), null);
    s.update();
    assert.equal(s.mirrors.entries.size, 0); assert.equal(s.mirrors.stats().rejected, 1);
    assert.equal(s.mesh.geometry, geometry); assert.equal(s.mesh.visible, true);
    assert.deepEqual(Array.from(geometry.attributes.position.array), positions);
    s.mirrors.dispose();
  }
});

test('editing a cached plane or replacing its material invalidates only its owned reflection', () => {
  const s = scene(); s.update();
  const original = s.mirrors.entries.get(s.mesh).reflector;
  let disposed = 0; original.geometry.addEventListener('dispose', () => disposed++);
  s.mesh.geometry.attributes.position.setZ(0, 0.1); s.mesh.geometry.attributes.position.needsUpdate = true;
  s.update();
  assert.equal(s.mirrors.entries.size, 0); assert.equal(disposed, 1);
  s.mesh.geometry.attributes.position.setZ(0, 0); s.mesh.geometry.attributes.position.needsUpdate = true;
  s.update(); assert.equal(s.mirrors.entries.size, 1);
  const replacement = new THREE.MeshStandardMaterial({ metalness: 1, roughness: 0 });
  s.mesh.material = replacement; s.update();
  assert.equal(s.mirrors.entries.size, 0); assert.equal(s.mesh.material, replacement);
  s.mirrors.dispose();
});

test('ancestor visibility, diagnostic modes and the camera frustum control only the reflection overlay', () => {
  const s = scene(); s.update();
  assert.equal(s.mirrors.stats().surfaces[0].visible, true);
  s.parent.visible = false; s.update();
  assert.equal(s.mirrors.stats().surfaces[0].visible, false); assert.equal(s.parent.visible, false); assert.equal(s.mesh.visible, true);
  s.parent.visible = true; s.update({ enabled: false });
  assert.equal(s.mirrors.stats().surfaces[0].visible, false); assert.equal(s.mesh.visible, true);
  s.update({ enabled: true }); assert.equal(s.mirrors.stats().surfaces[0].visible, true);
  s.mesh.material.visible = false; s.update();
  assert.equal(s.mirrors.stats().surfaces[0].visible, false, 'an explicitly hidden source material stays hidden');
  assert.equal(s.mesh.material.visible, false);
  s.mesh.material.visible = true; s.mesh.layers.set(2); s.update();
  assert.equal(s.mirrors.stats().surfaces[0].visible, false, 'a source outside the camera layers is not reflected');
  s.camera.layers.enable(2); s.update();
  assert.equal(s.mirrors.stats().surfaces[0].visible, true);
  assert.equal(s.mirrors.entries.get(s.mesh).reflector.layers.mask, s.mesh.layers.mask);
  assert.equal(s.mesh.layers.mask, 1 << 2, 'runtime rendering does not alter source layer membership');
  s.camera.lookAt(20, 0, 5); s.update();
  assert.equal(s.mirrors.stats().surfaces[0].visible, false, 'offscreen surfaces need no capture');
  s.mirrors.dispose();
});

test('the overlay depth bias is relative to the source bias and does not rewrite it', () => {
  const s = scene(); s.update();
  const overlay = s.mirrors.entries.get(s.mesh).reflector.material;
  assert.equal(overlay.polygonOffset, true);
  assert.equal(overlay.polygonOffsetFactor, 0);
  assert.equal(overlay.polygonOffsetUnits, -1);
  Object.assign(s.mesh.material, { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
  s.update();
  assert.equal(overlay.polygonOffsetFactor, -1, 'keep the source slope bias');
  assert.equal(overlay.polygonOffsetUnits, -3, 'move exactly one unit ahead of the already biased source');
  assert.equal(s.mesh.material.polygonOffsetFactor, -1);
  assert.equal(s.mesh.material.polygonOffsetUnits, -2);
  s.mesh.material.polygonOffset = false; s.update();
  assert.equal(overlay.polygonOffsetFactor, 0, 'disabled source settings do not leak into the runtime bias');
  assert.equal(overlay.polygonOffsetUnits, -1);
  assert.equal(s.mesh.material.polygonOffset, false);
  s.mirrors.dispose();
});

test('reflection resources are freed on model removal and disposal without disposing source resources', () => {
  const s = scene(); s.update();
  const e = s.mirrors.entries.get(s.mesh), counts = { target: 0, runtimeGeometry: 0, runtimeMaterial: 0, sourceGeometry: 0, sourceMaterial: 0 };
  for (const [object, key] of [[e.reflector.getRenderTarget(), 'target'], [e.reflector.geometry, 'runtimeGeometry'], [e.reflector.material, 'runtimeMaterial'], [s.mesh.geometry, 'sourceGeometry'], [s.mesh.material, 'sourceMaterial']]) object.addEventListener('dispose', () => counts[key]++);
  s.mirrors.update({}, s.camera);
  assert.deepEqual(counts, { target: 1, runtimeGeometry: 1, runtimeMaterial: 1, sourceGeometry: 0, sourceMaterial: 0 });
  assert.equal(s.mirrors.root.children.length, 0); assert.equal(s.parent.children[0], s.mesh);
  s.update(); assert.equal(s.mirrors.entries.size, 1, 'the unchanged source can be loaded again');
  s.mirrors.dispose(); s.mirrors.dispose();
  assert.equal(s.mirrors.root.parent, null); assert.equal(s.mesh.parent, s.parent);
  assert.equal(counts.sourceGeometry, 0); assert.equal(counts.sourceMaterial, 0);
});
