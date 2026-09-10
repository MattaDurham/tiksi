// Scan to plan, three.js side. The geometry work is scan2plan-core.js (pure typed-array
// code that runs in a Web Worker so the console never freezes); this module pulls the
// triangles out of a loaded scan, runs the core, renders a textured top-down cut of every
// level as that level's plan underlay, and writes the proposal into a property: levels,
// walls, openings, rooms, the scan's transform, and a starter project with the takeoffs.
//
// The core works in the mesh's own frame; the result carries the transform (rotation about
// y, translation) that the scan record and the underlay renders both use, so the scan, the
// underlays and the proposed walls land on top of each other in PLAN and MODEL.

import * as THREE from 'three';
import { uid, touch } from './store.js';
import { loadMesh } from './scans.js';
import { scanToPlan } from './scan2plan-core.js';

const MAX_PX_PER_M = 64;    // underlay resolution cap: every level's image rides in localStorage
const UNDERLAY_CUT = 1.3;   // each level is rendered cut this far above its floor
const CANVAS_BG = 0x0a0e12;

// ---------- triangles ----------
// Positions and triangle indices of every mesh under `root`, in the root's own frame (the
// root's transform is ignored: the result describes the raw scan).
export function meshFromObject3D(root) {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const positions = [], indices = [];
  let vOffset = 0;
  root.traverse(o => {
    if (!o.isMesh || !o.geometry) return;
    const P = o.geometry.getAttribute('position');
    if (!P) return;
    const m = new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld);
    const nV = P.count, out = new Float32Array(nV * 3), v = new THREE.Vector3();
    for (let i = 0; i < nV; i++) { v.fromBufferAttribute(P, i).applyMatrix4(m); out[3 * i] = v.x; out[3 * i + 1] = v.y; out[3 * i + 2] = v.z; }
    positions.push(out);
    const ind = o.geometry.getIndex();
    const n = ind ? ind.count : nV;
    const arr = new Uint32Array(n);
    for (let i = 0; i < n; i++) arr[i] = (ind ? ind.getX(i) : i) + vOffset;
    indices.push(arr);
    vOffset += nV;
  });
  const nP = positions.reduce((n, p) => n + p.length, 0), nI = indices.reduce((n, p) => n + p.length, 0);
  const pos = new Float32Array(nP), idx = new Uint32Array(nI);
  let po = 0, io = 0;
  for (const p of positions) { pos.set(p, po); po += p.length; }
  for (const i of indices) { idx.set(i, io); io += i.length; }
  return { pos, idx };
}

// ---------- the core, in a worker ----------
function stageLabel(stage) {
  const map = { normals: 'Reading triangles', orientation: 'Finding the wall direction', levels: 'Finding the floor levels', rasterize: 'Rasterizing every level', done: 'Vectorized' };
  if (map[stage]) return map[stage];
  if (stage && stage.startsWith('level ')) return 'Tracing walls and rooms: ' + stage.slice(6);
  return stage || '';
}

function runCore(pos, idx, options, say) {
  return new Promise((resolve, reject) => {
    const inline = () => { try { resolve(scanToPlan(pos, idx, options, say)); } catch (e) { reject(e); } };
    let worker = null;
    try { worker = new Worker(new URL('./scan2plan.worker.js', import.meta.url), { type: 'module' }); }
    catch (e) { worker = null; }
    if (!worker) return inline();   // file://, CSP: run here instead
    let settled = false;
    worker.onmessage = e => {
      const m = e.data;
      if (m.type === 'progress') say && say(m.stage, m.frac);
      else if (m.type === 'done') { settled = true; worker.terminate(); resolve(m.result); }
      else if (m.type === 'error') { settled = true; worker.terminate(); reject(new Error(m.message)); }
    };
    worker.onerror = () => { if (settled) return; settled = true; worker.terminate(); inline(); };
    // The worker takes ownership of copies; the caller keeps its arrays.
    const p = new Float32Array(pos), i = new Uint32Array(idx);
    worker.postMessage({ pos: p, idx: i, options: options || {} }, [p.buffer, i.buffer]);
  });
}

function mainLevelIndex(levels) {
  // Land on the main storey: the largest floor among the ordinary levels.
  let best = 0, bestScore = -Infinity;
  levels.forEach((L, i) => {
    const score = (L.floorArea || 0) - (/basement|attic/i.test(L.name) ? 1000 : 0);
    if (score > bestScore) { bestScore = score; best = i; }
  });
  return best;
}

// object: a three Object3D holding the mesh (its own transform is ignored). Resolves to
// the core result plus the transform and summary fields, or null when no floor exists.
export async function analyseMesh(object, hooks) {
  const say = (m, f) => { if (hooks && hooks.progress) hooks.progress(m, f); };
  say('Reading the mesh', 0.05);
  await new Promise(r => setTimeout(r, 0));
  const { pos, idx } = meshFromObject3D(object);
  const triangles = (idx.length / 3) | 0;
  if (triangles < 100) return null;
  let core;
  try { core = await runCore(pos, idx, {}, (stage, frac) => say(stageLabel(stage), 0.1 + 0.7 * frac)); }
  catch (e) { if (/no floor/i.test(String(e && e.message))) return null; throw e; }
  const levels = core.levels;
  const mi = mainLevelIndex(levels);
  const roomLike = levels.some(l => l.walls.length >= 3 && l.rooms.length >= 1);
  return Object.assign(core, {
    triangles, roomLike, mainLevelIndex: mi,
    transform: { pos: [0, -core.baseY, 0], rot: [0, core.rotationDeg, 0] },
    wallHeight: levels[mi] ? levels[mi].height : 2.44,
    floorArea: levels.reduce((n, l) => n + (l.floorArea || 0), 0),
    angle: core.rotationDeg * Math.PI / 180, rectilinear: core.manhattanShare,
  });
}

// ---------- underlays ----------
// One textured top-down cut per level, in plan coordinates, aligned to the result's grid so
// every level's image shares the same frame. Needs a WebGL context; returns an array with a
// null for any level that failed.
export function underlaysFor(object, result) {
  const { W, H, ox, oz, cell } = result.grid;
  const x0 = ox, z0 = oz, wM = W * cell, hM = H * cell;
  const pxPerM = Math.min(MAX_PX_PER_M, 1600 / Math.max(wM, hM));
  const w = Math.max(64, Math.round(wM * pxPerM)), h = Math.max(64, Math.round(hM * pxPerM));
  const group = new THREE.Group();
  group.position.fromArray(result.transform.pos);
  group.rotation.set(0, result.transform.rot[1] * Math.PI / 180, 0);
  const parent = object.parent, oldPos = object.position.clone(), oldRot = object.rotation.clone(), oldScale = object.scale.clone();
  object.position.set(0, 0, 0); object.rotation.set(0, 0, 0); object.scale.setScalar(1);
  group.add(object);
  let renderer = null;
  const swapped = [];
  const out = [];
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: false });
    renderer.setPixelRatio(1);
    renderer.setSize(w, h, false);
    renderer.setClearColor(CANVAS_BG, 1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.2);
    sun.position.set(2, 6, 3);
    scene.add(sun);
    object.traverse(o => {
      if (!o.isMesh) return;
      const orig = o.material;
      const mats = Array.isArray(orig) ? orig : [orig];
      const hasColor = !!o.geometry.getAttribute('color');
      const repl = mats.map(m => {
        const map = m && m.map ? m.map : null;
        // Scan textures carry their own baked lighting and read right unlit; bare geometry gets a soft shade.
        return map || hasColor
          ? new THREE.MeshBasicMaterial({ map, vertexColors: hasColor && !map, side: THREE.DoubleSide })
          : new THREE.MeshLambertMaterial({ color: 0xb8c0c8, side: THREE.DoubleSide });
      });
      swapped.push([o, orig]);
      o.material = Array.isArray(orig) ? repl : repl[0];
    });
    scene.add(group);
    // Camera looks down -y with up = -z: screen x = world x, screen y (down) = world z.
    const cam = new THREE.OrthographicCamera(x0, x0 + wM, -z0, -(z0 + hM), 0.1, 200);
    cam.up.set(0, 0, -1);
    for (const L of result.levels) {
      try {
        const cut = L.elevation + Math.min(UNDERLAY_CUT, Math.max(0.6, L.height - 0.3));
        renderer.clippingPlanes = [
          new THREE.Plane(new THREE.Vector3(0, -1, 0), cut),                  // keep y <= cut
          new THREE.Plane(new THREE.Vector3(0, 1, 0), -(L.elevation - 0.08)),  // keep y >= floor - 0.08
        ];
        cam.position.set(0, cut + 60, 0);
        cam.lookAt(0, L.elevation, 0);
        cam.updateProjectionMatrix();
        renderer.render(scene, cam);
        const canvas = renderer.domElement;
        let img = canvas.toDataURL('image/webp', 0.82);
        if (!img.startsWith('data:image/webp')) img = canvas.toDataURL('image/jpeg', 0.82);
        out.push({ img, imgW: w, imgH: h, mPerPx: 1 / pxPerM, offsetX: x0, offsetY: z0 });
      } catch (e) { console.error('underlay render failed for ' + L.name, e); out.push(null); }
    }
    scene.remove(group);
  } finally {
    for (const [o, orig] of swapped) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) if (m && m.dispose) m.dispose();
      o.material = orig;
    }
    group.remove(object);
    object.position.copy(oldPos); object.rotation.copy(oldRot); object.scale.copy(oldScale);
    if (parent) parent.add(object);
    if (renderer) { renderer.clippingPlanes = []; renderer.dispose(); renderer.forceContextLoss(); }
  }
  return out;
}

// ---------- apply ----------
// Write the proposal into a property: levels (each with its underlay), walls, openings,
// rooms, the scan record's transform. Replaces whatever plan geometry was there.
export function applyProposal(prop, scan, result, underlays) {
  const levels = [], walls = [], openings = [], rooms = [];
  result.levels.forEach((L, li) => {
    const lvl = { id: uid('lvl'), name: L.name, elevation: L.elevation, height: L.height, plan: null };
    const u = underlays && underlays[li];
    if (u) lvl.plan = Object.assign({ opacity: 0.6, calibrated: true, source: 'scan' }, u);
    levels.push(lvl);
    const ids = {};
    for (const w of L.walls) {
      const id = uid('w'); ids[w.id] = id;
      walls.push({ id, level: lvl.id, ax: w.ax, ay: w.ay, bx: w.bx, by: w.by, thickness: w.thickness, height: null, material: w.exterior ? 'mat-fiber' : 'mat-drywall' });
    }
    for (const o of L.openings) {
      if (!ids[o.wallId]) continue;
      const rec = { id: uid('o'), wallId: ids[o.wallId], type: o.type, t: o.t, width: o.width, height: o.height };
      if (o.type === 'window') rec.sill = o.sill;
      openings.push(rec);
    }
    L.rooms.forEach((r, ri) => rooms.push({ id: uid('r'), level: lvl.id, name: 'Room ' + (ri + 1), material: null, ceilingMaterial: null, pts: r.pts }));
  });
  prop.levels = levels;
  prop.activeLevelId = (levels[result.mainLevelIndex] || levels[0]).id;
  prop.wallHeight = result.wallHeight;
  prop.walls = walls;
  prop.openings = openings;
  prop.rooms = rooms;
  if (scan) {
    scan.pos = result.transform.pos.slice();
    scan.rot = result.transform.rot.slice();
    scan.rotY = scan.rot[1];
    scan.scale = 1;
    scan.flip = false;
    scan.planned = new Date().toISOString();
  }
  touch();
  return { levels, walls, openings, rooms };
}

// ---------- the pipeline ----------
// buffer: the scan file's bytes; scan: its record in prop.scans. Resolves { result, applied }.
export async function planFromScanBytes(prop, scan, buffer, hooks, opts) {
  opts = opts || {};
  const say = (m, f) => { if (hooks && hooks.progress) hooks.progress(m, f); };
  say('Parsing ' + scan.name, 0.02);
  const obj = await loadMesh(buffer, scan.format || String(scan.name || '').split('.').pop().toLowerCase());
  try {
    const result = await analyseMesh(obj, hooks);
    if (!result) throw new Error('no floor could be found in ' + scan.name);
    let underlays = null;
    if (opts.underlay !== false) {
      say('Rendering the underlays', 0.9);
      await new Promise(r => setTimeout(r, 0));
      try { underlays = underlaysFor(obj, result); } catch (e) { console.error('underlay render failed', e); }
    }
    let applied = null;
    if (result.roomLike && opts.geometry !== false) applied = applyProposal(prop, scan, result, underlays);
    else {
      // Not a room (an object, a facade, a garden): keep any traced plan, place the scan.
      scan.pos = result.transform.pos.slice(); scan.rot = result.transform.rot.slice(); scan.rotY = scan.rot[1]; scan.flip = false;
      if (!prop.levels || !prop.levels.length) prop.levels = [{ id: 'lvl-0', name: 'Main level', elevation: 0, height: prop.wallHeight || 2.44, plan: null }];
      const u = underlays && underlays[result.mainLevelIndex];
      const lvl = prop.levels[0];
      if (u && !(lvl.plan && lvl.plan.img)) lvl.plan = Object.assign({ opacity: 0.6, calibrated: true, source: 'scan' }, u);
      touch();
    }
    say(null);
    return { result, applied };
  } finally {
    obj.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
      for (const m of mats) { for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap']) if (m[k] && m[k].dispose) m[k].dispose(); m.dispose(); }
    });
  }
}

// One-line summary for toasts and logs.
export function proposalSummary(result, applied) {
  if (!applied) return 'the scan is placed on the floor; it does not read as a room, so no walls were proposed';
  const doors = applied.openings.filter(o => o.type === 'door').length, wins = applied.openings.length - doors;
  const n = applied.levels ? applied.levels.length : 1;
  const plural = (k, w) => k + ' ' + w + (k === 1 ? '' : 's');
  return (n > 1 ? plural(n, 'level') + ', ' : '') + applied.walls.length + ' walls, ' + plural(applied.rooms.length, 'room') + ', ' +
    plural(doors, 'door') + ', ' + plural(wins, 'window') + (n > 1 ? '' : ', ceiling ' + result.wallHeight.toFixed(2) + ' m');
}

// A starter project whose scope items carry the takeoffs from the proposal, each linked to
// the elements it came from, so cut sheets and the budget have something real to show.
// Quantities come from the geometry; prices stay blank.
export function seedProject(prop, applied, label) {
  const M2_PER_SF = 0.09290304;
  const sf = m2 => Math.round(m2 / M2_PER_SF);
  const area = pts => { let s = 0; for (let i = 0; i < pts.length; i++) { const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length]; s += x1 * y2 - x2 * y1; } return Math.abs(s) / 2; };
  const levels = applied.levels || prop.levels || [];
  const multi = levels.length > 1;
  const levelName = id => { const l = levels.find(x => x.id === id); return l ? l.name : ''; };
  const heightOf = w => { const l = levels.find(x => x.id === w.level); return w.height || (l && l.height) || prop.wallHeight || 2.44; };
  const items = [];
  for (const r of applied.rooms) {
    const a = area(r.pts);
    const where = multi ? levelName(r.level) + ', ' + r.name : r.name;
    items.push({ id: uid('it'), name: 'Flooring: ' + where, qty: sf(a), unit: 'sf', low: 0, likely: 0, high: 0, durationDays: 0, deps: [], elementIds: [r.id], notes: 'Takeoff from the scan: ' + a.toFixed(1) + ' m2 floor.' });
  }
  for (const l of levels) {
    const walls = applied.walls.filter(w => w.level === l.id);
    if (!walls.length) continue;
    const wallArea = walls.reduce((n, w) => n + Math.hypot(w.bx - w.ax, w.by - w.ay) * heightOf(w), 0);
    items.push({ id: uid('it'), name: 'Paint walls' + (multi ? ': ' + l.name : ''), qty: sf(wallArea), unit: 'sf', low: 0, likely: 0, high: 0, durationDays: 0, deps: [], elementIds: walls.map(w => w.id), notes: 'One face per wall from the scan; openings not deducted.' });
  }
  const doors = applied.openings.filter(o => o.type === 'door'), wins = applied.openings.filter(o => o.type === 'window');
  if (doors.length) items.push({ id: uid('it'), name: 'Doors', qty: doors.length, unit: 'ea', low: 0, likely: 0, high: 0, durationDays: 0, deps: [], elementIds: Array.from(new Set(doors.map(o => o.wallId))), notes: 'Openings read from the scan.' });
  if (wins.length) items.push({ id: uid('it'), name: 'Windows', qty: wins.length, unit: 'ea', low: 0, likely: 0, high: 0, durationDays: 0, deps: [], elementIds: Array.from(new Set(wins.map(o => o.wallId))), notes: 'Openings read from the scan.' });
  if (!items.length) return null;
  return {
    id: uid('proj'), name: label || 'Scope from scan', propertyId: prop.id, category: 'interior', status: 'idea', selected: false, startDate: '',
    notes: 'Quantities came from the scan-to-plan proposal. Prices are blank until you scope them.', items,
  };
}
