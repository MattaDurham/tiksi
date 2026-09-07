// Scan import and display: one entry point sniffs the file, stores the bytes in IndexedDB
// and returns the scan record; loadScanObject turns a record back into a three object
// (point cloud, mesh or Gaussian splat) wrapped in a transform group the inspector edits.
// Point clouds parse in a Worker created from a Blob URL so the UI never freezes.

import * as THREE from 'three';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { PCDLoader } from 'three/addons/loaders/PCDLoader.js';
import { uid, touch, putFile, getFile } from './store.js';
import { isLAS, lasHeader, parsePLYHeader, parseAndRecentre, recentre } from './las.js';
import { makePointCloud, updatePointCloud, decimate, fromGeometry } from './pointcloud.js';
import { ensureSpark, loadSplat, disposeSplat, splatBounds, splatDrawables, splatBusy, releaseSplatRenderer } from './splats.js';

export { splatDrawables, splatBusy, releaseSplatRenderer };

export const SCAN_ACCEPT = '.ply,.splat,.spz,.ksplat,.sog,.obj,.glb,.gltf,.pcd,.xyz,.txt,.las,.laz,.e57';
const DEFAULT_BUDGET = 2000000;
const FLIP_X = new THREE.Quaternion(1, 0, 0, 0);     // 180 degrees about X: y-down captures become y-up
const FLIP_M = new THREE.Matrix4().makeRotationX(Math.PI);
const PARSE_TIMEOUT_MS = 180000;

function ext(name) { return String(name || '').split('.').pop().toLowerCase(); }
// Rejections are not always Error objects (Spark rejects with plain values): never show 'undefined'.
const errMsg = e => String(e && e.message || e);

// A text cloud must hold at least one row of three numbers (same tokens as parseXYZ). Only a
// file that fits the window can be refused: a longer one is left to the parser to judge.
const XYZ_SNIFF_BYTES = 1 << 20;
function hasXYZRow(buffer) {
  if (buffer.byteLength > XYZ_SNIFF_BYTES) return true;
  const text = new TextDecoder().decode(new Uint8Array(buffer));
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line[0] === '#' || line.startsWith('//')) continue;
    const t = line.split(/[\s,;]+/);
    if (t.length >= 3 && t[0] !== '' && isFinite(+t[0]) && isFinite(+t[1]) && isFinite(+t[2])) return true;
  }
  return false;
}

// Decide what a file is from its bytes, not only its extension.
export function sniffKind(extension, buffer) {
  if (['splat', 'spz', 'ksplat', 'sog'].includes(extension)) return 'splat';
  if (['obj', 'glb', 'gltf'].includes(extension)) return 'mesh';
  // A .las without the LASF signature can never display: refuse it here so no record is made.
  if (extension === 'las') {
    if (!isLAS(buffer)) throw new Error('Not a LAS file (missing LASF signature)');
    return 'points';
  }
  if (extension === 'xyz' || extension === 'txt') {
    if (!hasXYZRow(buffer)) throw new Error('No x y z number columns found');
    return 'points';
  }
  if (extension === 'pcd') return 'points';
  if (extension === 'ply') {
    const h = parsePLYHeader(buffer);
    if (h.isGaussian) return 'splat';
    return h.hasFaces ? 'mesh' : 'points';
  }
  if (isLAS(buffer)) return 'points';
  return 'points';
}

// ---------- import ----------
// Nothing is stored and no record is created until the bytes have at least been sniffed, so a
// file that is not what its extension claims never leaves a record that errors on every mount.
export async function importScanFile(file, prop, hooks, extra) {
  if (!file) return null;
  const name = file.name;
  const e = ext(name);
  const say = (m, k) => hooks && hooks.toast && hooks.toast(m, k);
  const progress = (l, f) => hooks && hooks.progress && hooks.progress(l, f);
  if (e === 'laz') { say('LAZ is compressed LAS; export an uncompressed .las (or PLY) from your scanner app and import that.', 'warn'); return null; }
  if (e === 'e57') { say('E57 import is on the roadmap. Export PLY, LAS or a mesh from your scanner app for now.', 'warn'); return null; }
  if (!SCAN_ACCEPT.split(',').includes('.' + e)) { say('Unsupported file type .' + e + '. Supported: ' + SCAN_ACCEPT.replace(/\./g, '').replace(/,/g, ' '), 'warn'); return null; }
  progress('Reading ' + name, 0.1);
  const buffer = await file.arrayBuffer();
  return importScanBytes(buffer, name, prop, hooks, extra);
}

// Same contract for bytes that did not arrive as a File (a download from a share link).
// `extra` is merged into the record (a source link, for instance). Throws on a file the
// sniffer refuses; returns null for a supported-but-not-yet type after a toast.
export async function importScanBytes(buffer, name, prop, hooks, extra) {
  const e = ext(name);
  const say = (m, k) => hooks && hooks.toast && hooks.toast(m, k);
  const progress = (l, f) => hooks && hooks.progress && hooks.progress(l, f);
  if (e === 'las' && isLAS(buffer) && lasHeader(buffer).compressed) { say('This LAS is LAZ-compressed inside; export it uncompressed.', 'warn'); progress(null); return null; }
  let kind;
  try { kind = sniffKind(e, buffer); }
  catch (err) { progress(null); throw new Error(name + ': ' + errMsg(err)); }
  const id = uid('scan');
  progress('Storing ' + name, 0.3);
  await putFile(id, buffer, { name, format: e, kind });
  const scan = Object.assign({
    id, name, format: e, kind, pos: [0, 0, 0], rotY: 0, rot: [0, 0, 0], scale: 1, visible: true,
    pointSize: 0.02, pointColor: 'rgb', budget: DEFAULT_BUDGET, flip: kind === 'splat',
  }, extra || {});
  prop.scans = prop.scans || [];
  prop.scans.push(scan);
  touch();
  return scan;
}

// ---------- worker parsing ----------
// Two failure classes are kept apart: the worker itself being unavailable (file://, CSP, the
// module failing to load) falls back to a main-thread parse; a parser error or the watchdog is
// final and is reported as-is, so a file is never parsed twice and a wedged worker is killed.
let worker = null, workerUrl = null, msgId = 0, workerBroken = false;
const pending = {};
function unavailable(msg) { const err = new Error(msg); err.workerUnavailable = true; return err; }
function getWorker() {
  if (worker) return worker;
  if (workerBroken) throw unavailable('scan worker unavailable');
  const modUrl = new URL('./las.js', import.meta.url).href;
  // Messages can arrive before the dynamic import settles, so queue them until it does.
  const src = `const q = []; self.onmessage = e => q.push(e);
    import(${JSON.stringify(modUrl)}).then(m => { m.workerMain(self); for (const e of q) self.onmessage(e); })
      .catch(e => self.postMessage({ fatal: String(e && e.message || e) }));`;
  workerUrl = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
  try { worker = new Worker(workerUrl, { type: 'module' }); }
  catch (e) { workerBroken = true; URL.revokeObjectURL(workerUrl); workerUrl = null; throw unavailable('scan worker: ' + errMsg(e)); }
  worker.onmessage = e => {
    const d = e.data;
    // The module could not load inside the worker: that will not change, stop trying.
    if (d.fatal) { workerBroken = true; failWorker(unavailable('scan worker: ' + d.fatal)); return; }
    const p = pending[d.id];
    if (!p) return;
    if (d.progress != null && d.ok == null) { p.onProgress && p.onProgress(d.progress); return; }
    delete pending[d.id];
    d.ok ? p.resolve(d) : p.reject(new Error(d.error));
  };
  worker.onerror = err => failWorker(unavailable('scan worker failed: ' + (err && err.message || 'unknown')));
  return worker;
}
function failWorker(err) {
  for (const id of Object.keys(pending)) { pending[id].reject(err); delete pending[id]; }
  if (worker) worker.terminate();
  worker = null;
  if (workerUrl) { URL.revokeObjectURL(workerUrl); workerUrl = null; }
}
function parseInWorker(format, buffer, name, onProgress) {
  return new Promise((resolve, reject) => {
    let w;
    try { w = getWorker(); } catch (e) { reject(e); return; }
    const id = ++msgId;
    // Watchdog: a wedged worker must not leave the import spinning forever. Terminating it
    // rejects every pending parse; the next request starts a fresh worker.
    const timer = setTimeout(() => { if (pending[id]) failWorker(new Error('Parsing ' + name + ' timed out')); }, PARSE_TIMEOUT_MS);
    pending[id] = { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); }, onProgress };
    // A detached or non-transferable buffer throws synchronously; that must settle the promise too.
    try { w.postMessage({ id, format, buffer }, [buffer]); }
    catch (e) { delete pending[id]; clearTimeout(timer); reject(e); }
  });
}

async function parsePoints(buffer, e, name, hooks) {
  const prog = f => hooks && hooks.progress && hooks.progress('Parsing ' + name, 0.3 + f * 0.6);
  if (e === 'pcd') {
    const pts = new PCDLoader().parse(buffer);
    const r = fromGeometry(pts.geometry);
    pts.geometry.dispose(); pts.material.dispose();
    recentre(r.positions);
    return r;
  }
  const format = e === 'las' ? 'las' : (e === 'ply' ? 'ply' : 'xyz');
  try {
    const copy = buffer.slice(0);   // the worker takes ownership of its copy
    const r = await parseInWorker(format, copy, name, prog);
    return { positions: r.positions, colors: r.colors, count: r.count, hasColor: r.hasColor };
  } catch (err) {
    if (!err.workerUnavailable) throw err;
    // No worker (file://, CSP): parse here instead; the console freezes for large files.
    return parseAndRecentre(format, buffer, prog);
  }
}

export async function loadMesh(buffer, e) {
  let obj;
  if (e === 'ply') {
    const geo = new PLYLoader().parse(buffer);
    const hasColor = !!geo.getAttribute('color');
    if (!geo.getAttribute('normal')) geo.computeVertexNormals();
    obj = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: hasColor ? 0xffffff : 0x9fb3c2, vertexColors: hasColor, roughness: 0.9 }));
  } else if (e === 'obj') {
    obj = new OBJLoader().parse(new TextDecoder().decode(buffer));
    obj.traverse(o => { if (o.isMesh) o.material = new THREE.MeshStandardMaterial({ color: 0x9fb3c2, roughness: 0.9 }); });
  } else {
    obj = (await new GLTFLoader().parseAsync(buffer, '')).scene;
  }
  // A plan proposed from the scan puts model faces exactly on the scanned surfaces; the
  // scan wins those coplanar fights so the reference reads through instead of speckling.
  obj.traverse(o => {
    if (!o.isMesh) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (!m) continue;
      m.polygonOffset = true; m.polygonOffsetFactor = -1; m.polygonOffsetUnits = -2;
    }
  });
  return obj;
}

// ---------- scene objects ----------
// Each builder fills `inner` and returns the stats the inspector shows.
async function buildPoints(buffer, e, scan, inner, wrapper, hooks) {
  hooks && hooks.progress && hooks.progress('Parsing ' + scan.name, 0.3);
  let data = await parsePoints(buffer, e, scan.name, hooks);
  // An empty cloud would import "successfully" and sit invisibly in the list forever.
  if (!data.count) throw new Error('No points found in ' + scan.name);
  const total = data.count;
  data = decimate(data, scan.budget || DEFAULT_BUDGET);
  const pts = makePointCloud(data, scan);
  inner.add(pts);
  wrapper.userData.points = pts;
  return { count: data.count, label: data.count.toLocaleString() + (data.decimatedFrom ? ' of ' + total.toLocaleString() : '') + ' points' };
}
async function buildMesh(buffer, e, scan, inner, hooks) {
  hooks && hooks.progress && hooks.progress('Loading ' + scan.name, 0.5);
  const obj = await loadMesh(buffer, e);
  let count = 0;
  obj.traverse(o => { if (o.isMesh) { o.receiveShadow = true; count += o.geometry.index ? o.geometry.index.count / 3 : o.geometry.getAttribute('position').count / 3; } });
  inner.add(obj);
  return { count, label: Math.round(count).toLocaleString() + ' triangles' };
}
async function buildSplat(buffer, e, scan, inner, wrapper, hooks) {
  hooks && hooks.progress && hooks.progress('Loading splat renderer', 0.2);
  await ensureSpark(hooks.renderer, hooks.scene, () => hooks.requestRender && hooks.requestRender());
  hooks && hooks.progress && hooks.progress('Unpacking ' + scan.name, 0.5);
  const { mesh, count } = await loadSplat(buffer, e, scan.name, hooks);
  inner.add(mesh);
  wrapper.userData.splat = mesh;
  return { count, label: count.toLocaleString() + ' splats' };
}

export async function loadScanObject(scan, hooks) {
  const rec = await getFile(scan.id);
  if (!rec || !rec.buffer) {
    hooks && hooks.toast && hooks.toast('Scan "' + scan.name + '" is missing from browser storage; re-import it.', 'warn');
    return null;
  }
  const buffer = rec.buffer;
  const e = scan.format || ext(scan.name);
  let kind = scan.kind || sniffKind(e, buffer);
  // A record written before splat detection was strict may say 'splat' for a plain .ply.
  if (kind === 'splat' && e === 'ply' && !parsePLYHeader(buffer).isGaussian) { kind = 'points'; scan.flip = false; }
  scan.kind = kind;
  const wrapper = new THREE.Group();
  wrapper.name = 'scan:' + scan.name;
  const inner = new THREE.Group();
  inner.name = 'inner';
  wrapper.add(inner);
  wrapper.userData = { kind: 'scan', id: scan.id, scanKind: kind, inner };
  let stats;
  if (kind === 'points') stats = await buildPoints(buffer, e, scan, inner, wrapper, hooks);
  else if (kind === 'mesh') stats = await buildMesh(buffer, e, scan, inner, hooks);
  else {
    try { stats = await buildSplat(buffer, e, scan, inner, wrapper, hooks); }
    catch (err) {
      // A .ply the splat renderer rejects (a record from before detection was strict, or an
      // export it cannot read) is still a point cloud: show it as one instead of failing.
      if (e !== 'ply') throw err;
      hooks && hooks.toast && hooks.toast(scan.name + ' is not a Gaussian splat the renderer can read (' + errMsg(err) + '); showing it as a point cloud.', 'warn');
      kind = scan.kind = wrapper.userData.scanKind = 'points';
      scan.flip = false;   // the y-down default only applies to splat captures
      stats = await buildPoints(buffer, e, scan, inner, wrapper, hooks);
    }
  }
  wrapper.userData.stats = stats;
  // Bounds in wrapper space (after the up-axis flip) drive the selection box and the pick proxy.
  applyFlip(scan, wrapper);
  wrapper.updateMatrixWorld(true);
  let box;
  if (kind === 'splat') box = splatBounds(wrapper.userData.splat, THREE.Box3).applyMatrix4(inner.matrix);
  else box = new THREE.Box3().setFromObject(inner);
  if (!isFinite(box.min.x)) box = new THREE.Box3(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 1, 1));
  wrapper.userData.bounds = box;
  wrapper.userData.builtFlip = !!scan.flip;   // the flip these bounds describe; see applyScanTransform
  const size = new THREE.Vector3(), centre = new THREE.Vector3();
  box.getSize(size); box.getCenter(centre);
  const pickMat = new THREE.MeshBasicMaterial({ visible: false });
  const pick = new THREE.Mesh(new THREE.BoxGeometry(Math.max(size.x, 0.05), Math.max(size.y, 0.05), Math.max(size.z, 0.05)), pickMat);
  pick.position.copy(centre);
  pick.userData = { pickBox: true, kind: 'scan', id: scan.id };
  wrapper.add(pick);
  wrapper.userData.pick = pick;
  const helper = new THREE.Box3Helper(box, 0xe8973a);
  helper.material.transparent = true; helper.material.opacity = 0.9; helper.material.depthTest = false;
  helper.visible = false;
  helper.userData = { kind: 'scan', id: scan.id, helper: true };
  wrapper.add(helper);
  wrapper.userData.box = helper;
  hooks && hooks.progress && hooks.progress(null);
  return wrapper;
}

function applyFlip(scan, wrapper) {
  const inner = wrapper.userData.inner;
  if (!inner) return;
  inner.quaternion.copy(scan.flip ? FLIP_X : new THREE.Quaternion());
  inner.updateMatrix();
}

// The bounds, pick proxy and selection helper were built for one flip state; toggling FLIP UP
// AXIS mirrors the content about X, so mirror them too (the helper shares the same Box3) or
// drop-to-floor, centre-on-model, picking and the orange box all follow the old placement.
function refreshBounds(scan, obj) {
  const u = obj.userData;
  if (!u.bounds || !!scan.flip === u.builtFlip) return;
  u.bounds.applyMatrix4(FLIP_M);
  if (u.pick) u.bounds.getCenter(u.pick.position);
  u.builtFlip = !!scan.flip;
}

export function applyScanTransform(scan, obj) {
  if (!obj) return;
  const pos = scan.pos || [0, 0, 0];
  obj.position.set(pos[0] || 0, pos[1] || 0, pos[2] || 0);
  const rot = scan.rot || [0, scan.rotY || 0, 0];
  obj.rotation.set(THREE.MathUtils.degToRad(rot[0] || 0), THREE.MathUtils.degToRad(rot[1] || 0), THREE.MathUtils.degToRad(rot[2] || 0));
  obj.scale.setScalar(scan.scale || 1);
  obj.visible = scan.visible !== false;
  applyFlip(scan, obj);
  refreshBounds(scan, obj);
  if (obj.userData.points) updatePointCloud(obj.userData.points, scan);
  obj.updateMatrixWorld(true);
}

export function scanStats(obj) {
  return (obj && obj.userData && obj.userData.stats) || { count: 0, label: '-' };
}

// World-space bounds of the scan as currently placed.
function worldBounds(obj) {
  obj.updateMatrixWorld(true);
  return obj.userData.bounds.clone().applyMatrix4(obj.matrixWorld);
}

export function dropScanToFloor(scan, obj) {
  const b = worldBounds(obj);
  if (!isFinite(b.min.y)) return;
  scan.pos[1] = (scan.pos[1] || 0) - b.min.y;
}

// Translate so the scan's footprint centre lands on the model's centre, resting on the floor.
export function centerScanOnModel(scan, obj, bounds) {
  const b = worldBounds(obj);
  if (!isFinite(b.min.x)) return;
  const c = new THREE.Vector3(); b.getCenter(c);
  const cx = (bounds.minX + bounds.maxX) / 2, cz = (bounds.minY + bounds.maxY) / 2;
  scan.pos = [(scan.pos[0] || 0) + cx - c.x, (scan.pos[1] || 0) - b.min.y, (scan.pos[2] || 0) + cz - c.z];
}

export function disposeScanObject(obj) {
  if (!obj) return;
  if (obj.userData.splat) disposeSplat(obj.userData.splat);
  obj.traverse(o => {
    if (o.userData && o.userData.splat) return;
    if (o.geometry) o.geometry.dispose();
    const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    for (const m of mats) {
      for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap']) if (m[k] && m[k].dispose) m[k].dispose();
      m.dispose();
    }
  });
}
