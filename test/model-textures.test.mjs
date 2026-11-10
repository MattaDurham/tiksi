// What an imported model does with textures (js/model-materials.js): which ones it may free,
// and which ones it must leave exactly as the library made them. Synthetic materials only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import * as THREE from '../vendor/three.module.min.js';

const vendor = new URL('../vendor/', import.meta.url).href;
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'three') return { url: vendor + 'three.module.min.js', shortCircuit: true };
    if (spec.startsWith('three/addons/')) return { url: vendor + 'addons/' + spec.slice('three/addons/'.length), shortCircuit: true };
    return next(spec, ctx);
  },
});
const { materialTextures, ownedTextures, sharpenModelTextures } = await import('../js/model-materials.js');

const tex = () => new THREE.DataTexture(new Uint8Array(4), 1, 1);

test('every texture a material holds is found, the less common kinds too, each once', () => {
  const shared = tex();
  const m = new THREE.MeshPhysicalMaterial();
  Object.assign(m, { map: tex(), normalMap: tex(), roughnessMap: shared, metalnessMap: shared, clearcoatMap: tex(), sheenColorMap: tex(), transmissionMap: tex(), specularColorMap: tex(), lightMap: tex(), displacementMap: tex() });
  const found = materialTextures(m);
  assert.equal(found.length, 9, 'ten slots, one texture shared by two of them');
  for (const key of ['map', 'normalMap', 'roughnessMap', 'clearcoatMap', 'sheenColorMap', 'transmissionMap', 'specularColorMap', 'lightMap', 'displacementMap']) assert.ok(found.includes(m[key]), key + ' is found');
  assert.deepEqual(materialTextures(null), []);
  assert.deepEqual(materialTextures(new THREE.MeshStandardMaterial()), []);
});

test('a model frees all of its own textures but only the copies made for a library stand-in', () => {
  const own = new THREE.MeshPhysicalMaterial();
  Object.assign(own, { map: tex(), clearcoatMap: tex(), sheenColorMap: tex() });
  assert.equal(ownedTextures(own).length, 3);
  // The scene's lighting can sit on a material; it is shared and stays.
  own.envMap = tex();
  assert.equal(ownedTextures(own).length, 3);
  assert.ok(!ownedTextures(own).includes(own.envMap));

  const standIn = new THREE.MeshPhysicalMaterial();
  const libraryOnly = tex();
  Object.assign(standIn, { map: tex(), normalMap: tex(), clearcoatMap: libraryOnly });
  standIn.userData.modelReplacement = true;
  const owned = ownedTextures(standIn);
  assert.equal(owned.length, 2);
  assert.ok(!owned.includes(libraryOnly), 'a texture the library still holds is not the model\'s to free');
});

test('sharpening touches the model\'s own textures and leaves library stand-ins as the library made them', () => {
  const own = new THREE.MeshStandardMaterial({ map: tex(), normalMap: tex() });
  const standIn = new THREE.MeshStandardMaterial({ map: tex(), roughnessMap: tex() });
  standIn.map.anisotropy = 8; standIn.roughnessMap.anisotropy = 8;
  standIn.userData.modelReplacement = true;
  const before = { map: standIn.map.version, rough: standIn.roughnessMap.version };
  const root = new THREE.Group();
  root.add(new THREE.Mesh(new THREE.BoxGeometry(), own), new THREE.Mesh(new THREE.BoxGeometry(), [standIn, own]));
  sharpenModelTextures(root, 16);
  assert.equal(own.map.anisotropy, 16);
  assert.equal(own.normalMap.anisotropy, 16);
  // The same settings mean the graphics card keeps one upload for the library and the model.
  assert.equal(standIn.map.anisotropy, 8, 'the stand-in keeps the library\'s sharpness');
  assert.equal(standIn.roughnessMap.anisotropy, 8);
  assert.deepEqual({ map: standIn.map.version, rough: standIn.roughnessMap.version }, before, 'and is not sent to the graphics card again');
});
