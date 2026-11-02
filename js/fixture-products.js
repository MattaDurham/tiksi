// Real product models on fixtures (fixtures.js product.asset): the manufacturer's or a
// 3D Warehouse model of the actual dishwasher, mini-split head or faucet, stored as a file in
// the project and drawn in place of the fixture's stand-in prisms, stretched to the measured
// box. The same triangles, in the fixture's own frame, go to the SketchUp mirror.
//
// Loading is asynchronous and cached per file; the 3D view draws the stand-in until the model
// is ready, then rebuilds once (onProductModelReady).

import * as THREE from 'three';
import { getFile, putFile, deleteFile, uid, touch } from './store.js';
import { loadMesh } from './scans.js';
import { prepareModelPackage } from './scanbundle.js';
import { beginGeometryEdit } from './edit-history.js';
import { normaliseFixture, productLevelMatrix, productLocalMatrix, transformPositions, fixtureShape } from './fixtures.js';

const cache = new Map();            // fileId -> Promise<THREE.Object3D | null>
const ready = new Map();            // fileId -> THREE.Object3D, once loaded
const failed = new Map();           // fileId -> message
const listeners = new Set();
export const MAX_PRODUCT_TRIANGLES = 400000;

export function onProductModelReady(fn) { listeners.add(fn); return () => listeners.delete(fn); }

function load(asset) {
  if (cache.has(asset.fileId)) return cache.get(asset.fileId);
  const job = (async () => {
    const rec = await getFile(asset.fileId);
    if (!rec || !rec.buffer) throw new Error('the model file is not in this browser');
    const obj = await loadMesh(rec.buffer, asset.format || rec.format || 'glb');
    obj.updateMatrixWorld(true);
    return obj;
  })().then(obj => { ready.set(asset.fileId, obj); listeners.forEach(fn => fn(asset.fileId)); return obj; },
    err => { failed.set(asset.fileId, String(err && err.message || err)); return null; });
  cache.set(asset.fileId, job);
  return job;
}

export function productModelError(f) {
  const a = f && f.product && f.product.asset;
  return a ? failed.get(a.fileId) || '' : '';
}

// The product model placed for the 3D view's level group, or null while it loads (the caller
// draws the stand-in) or when it cannot be read.
export function productObjectFor(f) {
  const a = f && f.product && f.product.asset;
  if (!a || fixtureShape(f) !== 'box') return null;
  const obj = ready.get(a.fileId);
  if (!obj) { load(a); return null; }
  const m = productLevelMatrix(f);
  if (!m) return null;
  const copy = obj.clone(true);
  const wrap = new THREE.Group();
  wrap.matrixAutoUpdate = false;
  wrap.matrix.fromArray(m);
  wrap.add(copy);
  copy.traverse(o => {
    if (!o.isMesh) return;
    // X-ray and disposal change materials in place: each placement gets its own.
    o.material = Array.isArray(o.material) ? o.material.map(cloneMat) : cloneMat(o.material);
    o.castShadow = true; o.receiveShadow = true;
    o.userData = { kind: 'fixture', id: f.id };
  });
  wrap.userData = { kind: 'fixture', id: f.id, product: true };
  return wrap;
}
function cloneMat(m) {
  if (!m) return m;
  const c = m.clone();
  c.userData = Object.assign({}, c.userData, { disposable: true });
  return c;
}

// Load every product model the property uses (exports build synchronously afterwards).
export async function preloadProductModels(prop) {
  const assets = (prop.fixtures || []).map(f => f.product && f.product.asset).filter(Boolean);
  await Promise.all(assets.map(load));
}

// Triangles of the GLB in its own coordinates, grouped by finish: [{ name, color, opacity, positions }].
function triangles(obj) {
  const groups = new Map();
  let count = 0;
  obj.updateMatrixWorld(true);
  const v = new THREE.Vector3();
  obj.traverse(o => {
    if (!o.isMesh || !o.geometry) return;
    const g = o.geometry, pos = g.getAttribute('position');
    if (!pos) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const index = g.index;
    const spans = g.groups && g.groups.length ? g.groups : [{ start: 0, count: index ? index.count : pos.count, materialIndex: 0 }];
    for (const span of spans) {
      const mat = mats[span.materialIndex || 0] || mats[0];
      const color = mat && mat.color ? '#' + mat.color.getHexString() : '#c9cbcd';
      const name = (mat && mat.name) || 'Product';
      const key = name + '|' + color;
      if (!groups.has(key)) groups.set(key, { name, color, opacity: mat && mat.transparent ? mat.opacity : 1, positions: [] });
      const out = groups.get(key).positions;
      for (let k = span.start; k + 2 < span.start + span.count; k += 3) {
        for (let j = 0; j < 3; j++) {
          v.fromBufferAttribute(pos, index ? index.getX(k + j) : k + j).applyMatrix4(o.matrixWorld);
          out.push(v.x, v.y, v.z);
        }
        if (++count > MAX_PRODUCT_TRIANGLES) throw new Error('the model has more than ' + MAX_PRODUCT_TRIANGLES + ' triangles; simplify it first');
      }
    }
  });
  return [...groups.values()];
}

// What the SketchUp mirror draws for the fixture: triangles fitted to the box, in the
// fixture's local frame (u, v, h metres; see productLocalMatrix).
export async function productMeshPayload(f) {
  const a = f && f.product && f.product.asset;
  if (!a) return null;
  const obj = await load(a);
  if (!obj) throw new Error(failed.get(a.fileId) || 'the model could not be read');
  const m = productLocalMatrix(f);
  const r = v => Math.round(v * 1e5) / 1e5;
  return { format: 'tiksi-product-mesh', version: 1, name: a.name, meshes: triangles(obj).map(t => ({ ...t, positions: Array.from(transformPositions(m, t.positions), r) })) };
}

// Bounds of a loaded model in its own coordinates (metres for a GLB).
export function modelBounds(obj) {
  obj.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(obj);
  if (b.isEmpty()) throw new Error('the model has no geometry');
  return { min: b.min.toArray(), max: b.max.toArray() };
}

// Attach a product model file to a fixture: converted to a format the view loads when needed
// (the original kept byte for byte beside it), measured, and stored on the fixture.
// `meta`: { origin, originName, license, turn }. One undo step.
export async function attachProductModel(prop, f, file, meta = {}) {
  const original = await file.arrayBuffer();
  const prepared = await prepareModelPackage(original, file.name);
  const format = String(prepared.name || file.name).split('.').pop().toLowerCase();
  if (!['glb', 'obj', 'stl', 'ply'].includes(format)) throw new Error(file.name + ' is not a 3D model Tiksi can draw');
  const obj = await loadMesh(prepared.buffer.slice(0), format);
  const bounds = modelBounds(obj);
  const fileId = uid('product');
  await putFile(fileId, prepared.buffer, { name: prepared.name || file.name, format, kind: 'product' });
  let sourceFileId = null;
  if (prepared.buffer !== original) {
    sourceFileId = uid('source');
    try { await putFile(sourceFileId, original, { name: file.name, format: file.name.split('.').pop().toLowerCase(), kind: 'source' }); }
    catch (e) { await deleteFile(fileId); throw e; }
  }
  beginGeometryEdit(prop, 'attach product model');
  const p = f.product || { brand: '', evidence: [], sources: [] };
  p.asset = { fileId, format, name: file.name, sourceFileId, sourceName: sourceFileId ? file.name : '', origin: meta.origin || '', originName: meta.originName || '',
    license: meta.license || '', turn: meta.turn || 0, bounds };
  p.assetNote = '';
  f.product = p;
  normaliseFixture(f, new Set(prop.levels.map(l => l.id)));
  ready.delete(fileId); cache.delete(fileId);
  touch();
  return f.product.asset;
}
