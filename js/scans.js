// Scan import and display: one entry point sniffs the file, stores the bytes in IndexedDB
// and returns the scan record; loadScanObject turns a record back into a three object
// (point cloud, mesh or Gaussian splat) wrapped in a transform group the inspector edits.
// Point clouds parse in a Worker created from a Blob URL so the UI never freezes.

import * as THREE from 'three';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { PCDLoader } from 'three/addons/loaders/PCDLoader.js';
import { XYZLoader } from 'three/addons/loaders/XYZLoader.js';
import { uid, touch, putFile, getFile } from './store.js';
import { isLAS, lasHeader, parseLAS, parsePLYHeader, parsePLYPoints, recentre } from './las.js';
import { makePointCloud, updatePointCloud, decimate, fromGeometry } from './pointcloud.js';
import { ensureSpark, loadSplat, disposeSplat, splatBounds, splatDrawables, splatBusy, releaseSplatRenderer } from './splats.js';

export { splatDrawables, splatBusy, releaseSplatRenderer };

export const SCAN_ACCEPT = '.ply,.splat,.spz,.ksplat,.sog,.obj,.glb,.gltf,.pcd,.xyz,.txt,.las,.laz,.e57';
const DEFAULT_BUDGET = 2000000;
const FLIP_X = new THREE.Quaternion(1, 0, 0, 0);     // 180 degrees about X: y-down captures become y-up

function ext(name) { return String(name || '').split('.').pop().toLowerCase(); }

// Decide what a file is from its bytes, not only its extension.
export function sniffKind(extension, buffer) {
  if (['splat', 'spz', 'ksplat', 'sog'].includes(extension)) return 'splat';
  if (['obj', 'glb', 'gltf'].includes(extension)) return 'mesh';
  if (['pcd', 'xyz', 'txt', 'las'].includes(extension)) return 'points';
  if (extension === 'ply') {
    const h = parsePLYHeader(buffer);
    if (h.isGaussian) return 'splat';
    return h.hasFaces ? 'mesh' : 'points';
  }
  if (isLAS(buffer)) return 'points';
  return 'points';
}

// ---------- import ----------
export async function importScanFile(file, prop, hooks) {
  if (!file) return null;
  const name = file.name;
  const e = ext(name);
  const say = (m, k) => hooks && hooks.toast && hooks.toast(m, k);
  if (e === 'laz') { say('LAZ is compressed LAS; export an uncompressed .las (or PLY) from your scanner app and import that.', 'warn'); return null; }
  if (e === 'e57') { say('E57 import is on the roadmap. Export PLY, LAS or a mesh from your scanner app for now.', 'warn'); return null; }
  if (!SCAN_ACCEPT.split(',').includes('.' + e)) { say('Unsupported file type .' + e + '. Supported: ' + SCAN_ACCEPT.replace(/\./g, '').replace(/,/g, ' '), 'warn'); return null; }
  hooks && hooks.progress && hooks.progress('Reading ' + name, 0.1);
  const buffer = await file.arrayBuffer();
  if (e === 'las' && isLAS(buffer) && lasHeader(buffer).compressed) { say('This LAS is LAZ-compressed inside; export it uncompressed.', 'warn'); hooks.progress(null); return null; }
  const kind = sniffKind(e, buffer);
  const id = uid('scan');
  hooks && hooks.progress && hooks.progress('Storing ' + name, 0.3);
  await putFile(id, buffer, { name, format: e, kind });
  const scan = {
    id, name, format: e, kind, pos: [0, 0, 0], rotY: 0, rot: [0, 0, 0], scale: 1, visible: true,
    pointSize: 0.02, pointColor: 'rgb', budget: DEFAULT_BUDGET, flip: kind === 'splat',
  };
  prop.scans = prop.scans || [];
  prop.scans.push(scan);
  touch();
  return scan;
}

// ---------- worker parsing ----------
let worker = null, workerUrl = null, msgId = 0;
const pending = {};
function getWorker() {
  if (worker) return worker;
  const modUrl = new URL('./las.js', import.meta.url).href;
  // Messages can arrive before the dynamic import settles, so queue them until it does.
  const src = `const q = []; self.onmessage = e => q.push(e);
    import(${JSON.stringify(modUrl)}).then(m => { m.workerMain(self); for (const e of q) self.onmessage(e); })
      .catch(e => self.postMessage({ fatal: String(e && e.message || e) }));`;
  workerUrl = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
  worker = new Worker(workerUrl, { type: 'module' });
  worker.onmessage = e => {
    const d = e.data;
    if (d.fatal) { failWorker(new Error('scan worker: ' + d.fatal)); return; }
    const p = pending[d.id];
    if (!p) return;
    if (d.progress != null && d.ok == null) { p.onProgress && p.onProgress(d.progress); return; }
    delete pending[d.id];
    d.ok ? p.resolve(d) : p.reject(new Error(d.error));
  };
  worker.onerror = err => failWorker(new Error('scan worker failed: ' + (err.message || 'unknown')));
  return worker;
}
function failWorker(err) {
  for (const id of Object.keys(pending)) { pending[id].reject(err); delete pending[id]; }
  if (worker) worker.terminate();
  worker = null;
}
function parseInWorker(format, buffer, onProgress) {
  return new Promise((resolve, reject) => {
    let w;
    try { w = getWorker(); } catch (e) { reject(e); return; }
    const id = ++msgId;
    // Watchdog: a wedged worker must not leave the import spinning forever.
    const timer = setTimeout(() => { if (pending[id]) { delete pending[id]; reject(new Error('scan parse timed out')); } }, 180000);
    pending[id] = { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); }, onProgress };
    w.postMessage({ id, format, buffer }, [buffer]);
  });
}

async function parsePoints(buffer, e, name, hooks) {
  const prog = f => hooks && hooks.progress && hooks.progress('Parsing ' + name, 0.3 + f * 0.6);
  if (e === 'las' || e === 'ply') {
    try {
      const copy = buffer.slice(0);   // the worker takes ownership of its copy
      const r = await parseInWorker(e, copy, prog);
      return { positions: r.positions, colors: r.colors, count: r.count, hasColor: r.hasColor };
    } catch (err) {
      // Worker unavailable (file://, CSP) or the file tripped it: parse here instead.
      const r = e === 'las' ? parseLAS(buffer, { onProgress: prog }) : parsePLYPoints(buffer, null, { onProgress: prog });
      recentre(r.positions);
      return r;
    }
  }
  if (e === 'pcd') {
    const pts = new PCDLoader().parse(buffer);
    const r = fromGeometry(pts.geometry);
    pts.geometry.dispose(); pts.material.dispose();
    recentre(r.positions);
    return r;
  }
  // xyz / txt
  const geo = new XYZLoader().parse(new TextDecoder().decode(buffer));
  const r = fromGeometry(geo);
  geo.dispose();
  recentre(r.positions);
  return r;
}

async function loadMesh(buffer, e) {
  if (e === 'ply') {
    const geo = new PLYLoader().parse(buffer);
    const hasColor = !!geo.getAttribute('color');
    if (!geo.getAttribute('normal')) geo.computeVertexNormals();
    return new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: hasColor ? 0xffffff : 0x9fb3c2, vertexColors: hasColor, roughness: 0.9 }));
  }
  if (e === 'obj') {
    const obj = new OBJLoader().parse(new TextDecoder().decode(buffer));
    obj.traverse(o => { if (o.isMesh) o.material = new THREE.MeshStandardMaterial({ color: 0x9fb3c2, roughness: 0.9 }); });
    return obj;
  }
  const gltf = await new GLTFLoader().parseAsync(buffer, '');
  return gltf.scene;
}

// ---------- scene objects ----------
export async function loadScanObject(scan, hooks) {
  const rec = await getFile(scan.id);
  if (!rec || !rec.buffer) {
    hooks && hooks.toast && hooks.toast('Scan "' + scan.name + '" is missing from browser storage; re-import it.', 'warn');
    return null;
  }
  const buffer = rec.buffer;
  const e = scan.format || ext(scan.name);
  const kind = scan.kind || sniffKind(e, buffer);
  scan.kind = kind;
  const wrapper = new THREE.Group();
  wrapper.name = 'scan:' + scan.name;
  const inner = new THREE.Group();
  inner.name = 'inner';
  wrapper.add(inner);
  wrapper.userData = { kind: 'scan', id: scan.id, scanKind: kind, inner };
  let count = 0, label = '';
  if (kind === 'points') {
    hooks && hooks.progress && hooks.progress('Parsing ' + scan.name, 0.3);
    let data = await parsePoints(buffer, e, scan.name, hooks);
    const total = data.count;
    data = decimate(data, scan.budget || DEFAULT_BUDGET);
    const pts = makePointCloud(data, scan);
    inner.add(pts);
    wrapper.userData.points = pts;
    count = data.count;
    label = count.toLocaleString() + (data.decimatedFrom ? ' of ' + total.toLocaleString() : '') + ' points';
  } else if (kind === 'mesh') {
    hooks && hooks.progress && hooks.progress('Loading ' + scan.name, 0.5);
    const obj = await loadMesh(buffer, e);
    obj.traverse(o => { if (o.isMesh) { o.receiveShadow = true; count += o.geometry.index ? o.geometry.index.count / 3 : o.geometry.getAttribute('position').count / 3; } });
    inner.add(obj);
    label = Math.round(count).toLocaleString() + ' triangles';
  } else {
    hooks && hooks.progress && hooks.progress('Loading splat renderer', 0.2);
    await ensureSpark(hooks.renderer, hooks.scene, () => hooks.requestRender && hooks.requestRender());
    hooks && hooks.progress && hooks.progress('Unpacking ' + scan.name, 0.5);
    const { mesh, count: n } = await loadSplat(buffer, e, scan.name, hooks);
    inner.add(mesh);
    wrapper.userData.splat = mesh;
    count = n;
    label = count.toLocaleString() + ' splats';
  }
  wrapper.userData.stats = { count, label };
  // Bounds in wrapper space (after the up-axis flip) drive the selection box and the pick proxy.
  applyFlip(scan, wrapper);
  wrapper.updateMatrixWorld(true);
  let box;
  if (kind === 'splat') box = splatBounds(wrapper.userData.splat, THREE.Box3).applyMatrix4(inner.matrix);
  else box = new THREE.Box3().setFromObject(inner);
  if (!isFinite(box.min.x)) box = new THREE.Box3(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 1, 1));
  wrapper.userData.bounds = box;
  const size = new THREE.Vector3(), centre = new THREE.Vector3();
  box.getSize(size); box.getCenter(centre);
  const pickMat = new THREE.MeshBasicMaterial({ visible: false });
  const pick = new THREE.Mesh(new THREE.BoxGeometry(Math.max(size.x, 0.05), Math.max(size.y, 0.05), Math.max(size.z, 0.05)), pickMat);
  pick.position.copy(centre);
  pick.userData = { pickBox: true, kind: 'scan', id: scan.id };
  wrapper.add(pick);
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

export function applyScanTransform(scan, obj) {
  if (!obj) return;
  const pos = scan.pos || [0, 0, 0];
  obj.position.set(pos[0] || 0, pos[1] || 0, pos[2] || 0);
  const rot = scan.rot || [0, scan.rotY || 0, 0];
  obj.rotation.set(THREE.MathUtils.degToRad(rot[0] || 0), THREE.MathUtils.degToRad(rot[1] || 0), THREE.MathUtils.degToRad(rot[2] || 0));
  obj.scale.setScalar(scan.scale || 1);
  obj.visible = scan.visible !== false;
  applyFlip(scan, obj);
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
