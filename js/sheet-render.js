// Live drawing views for the DOCUMENTS workspace: every plan, section, elevation and 3D view on a
// sheet is rendered from the current model (the traced plan, fixtures and visible mesh models)
// with one offscreen WebGL renderer, so a sheet always shows the model as it is now.
//
// Plans also get a vector layer drawn from the plan data (cut walls, door swings, room names and
// areas, wall dimensions), which prints crisp at any scale.

import * as THREE from 'three';
import { buildPropertyGroup, wallCapRects, disposeBuilt, roomInteriorPoint } from './geometry.js';
import { loadScanObject, applyScanTransform, disposeScanObject } from './scans.js';
import { detectModelTags, applyModelTagVisibility, applyPlanTagVisibility } from './tags-scene.js';
import { pendingTextureJobs } from './textures.js';
import { wallsOn, roomsOn, openingsOn, levelHeight, polyArea, fmtLen, fmtArea, escapeHtml } from './store.js';
import { orthoFrame, sectionPlane, lineFrame } from './doc-sets.js';
import { doorSwings } from './wall-solids.js';
import { openingSchedule, openingFrame } from './opening-schedule.js';

let renderer = null;
const scene = new THREE.Scene();
let built = null;          // { sig, group }
const scanCache = new Map();   // scan id -> Promise<object|null>
const edgeCache = new WeakMap();   // geometry -> EdgesGeometry
let lights = null;
let busy = Promise.resolve();

function ensureRenderer() {
  if (renderer) return renderer;
  const canvas = document.createElement('canvas');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, alpha: false });
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.localClippingEnabled = true;
  lights = new THREE.Group();
  lights.add(new THREE.HemisphereLight(0xffffff, 0x8a8478, 2.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(6, 12, 9);
  lights.add(sun);
  const fill = new THREE.DirectionalLight(0xffffff, 0.6);
  fill.position.set(-8, 5, -6);
  lights.add(fill);
  scene.add(lights);
  return renderer;
}

// What the model looks like, cheaply: anything that changes the drawn geometry. A level's plan
// underlay is not drawn in these views (only its extent can frame them), so its image, often
// several megabytes of text, stands in by its length.
const levelSignature = l => (l && l.plan && l.plan.img ? { ...l, plan: { ...l.plan, img: l.plan.img.length } } : l);
export function geometrySignature(prop) {
  return JSON.stringify([prop.id, (prop.levels || []).map(levelSignature), prop.walls, prop.openings, prop.rooms, prop.fixtures, prop.trims, prop.wallHeight,
    (prop.scans || []).map(s => [s.id, s.kind, s.pos, s.rot, s.rotY, s.scale, s.visible, s.flip, s.partOffsets || null])]);
}

async function scanObject(scan) {
  if (!scanCache.has(scan.id)) {
    scanCache.set(scan.id, loadScanObject(scan, {}).then(obj => {
      if (!obj) return null;
      obj.traverse(o => { if (o.userData && (o.userData.pickBox || o.userData.helper)) o.visible = false; });
      return obj;
    }).catch(e => { console.error('drawing view: model failed to load', scan.name, e); return null; }));
  }
  return scanCache.get(scan.id);
}

// What decides which parts a view shows: the tags, every assignment and the view's own overrides.
export function tagSignature(prop, v) {
  return JSON.stringify([prop.tags, prop.tagOf, prop.tagDefaults, prop.tagUntaggedVisible, prop.hidden || null, (v && v.tags) || null]);
}
// Show or hide the built model's parts for one view (the group is shared between views).
function applyViewTags(prop, group, overrides) {
  for (const c of group.children) {
    if (c.userData.planGroup) applyPlanTagVisibility(prop, c, overrides);
    else if (c.userData.tagScan) applyModelTagVisibility(prop, c.userData.tagScan, c, overrides);
  }
}

// Build (or reuse) the model for this property: the traced plan plus visible mesh models.
async function modelFor(prop) {
  const sig = geometrySignature(prop);
  if (built && built.sig === sig) return built.group;
  if (built) { scene.remove(built.group); for (const c of [...built.group.children]) if (c.userData.planGroup) disposeBuilt(c); }
  const group = new THREE.Group();
  const plan = buildPropertyGroup(prop, {});
  plan.userData.planGroup = true;
  group.add(plan);
  for (const s of prop.scans || []) {
    if (s.visible === false || s.kind !== 'mesh') continue;
    const obj = await scanObject(s);
    if (!obj) continue;
    applyScanTransform(s, obj);
    // A model never opened in MODEL gets its tags here, the same way (tags-scene.js).
    detectModelTags(prop, s, obj);
    obj.visible = true;
    obj.userData.tagScan = s;
    group.add(obj);
  }
  // Scans no longer in the property are dropped from the cache.
  const live = new Set((prop.scans || []).map(s => s.id));
  for (const [id, p] of scanCache) if (!live.has(id)) { scanCache.delete(id); p.then(o => o && disposeScanObject(o)); }
  built = { sig, group };
  scene.add(group);
  return group;
}

export function modelBox(group) {
  const box = new THREE.Box3();
  group.traverse(o => {
    if (!o.visible || !(o.isMesh)) return;
    if (o.userData && (o.userData.pickBox || o.userData.helper)) return;
    o.geometry.computeBoundingBox();
    const b = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld);
    if (isFinite(b.min.x)) box.union(b);
  });
  return box;
}

export async function modelBounds3d(prop) {
  const g = await modelFor(prop);
  g.updateMatrixWorld(true);
  return modelBox(g);
}

const white = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.FrontSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
const whiteBoth = white.clone(); whiteBoth.side = THREE.DoubleSide;
const poche = new THREE.MeshBasicMaterial({ color: 0xa3a3a3, side: THREE.BackSide });   // cut model solids: mid grey, so the plan's black walls read first
const edgeMat = new THREE.LineBasicMaterial({ color: 0x111111 });

// Edges of every visible mesh, built once per geometry. Long, flat models stay cheap.
function edgeLines(group) {
  const out = new THREE.Group();
  group.updateMatrixWorld(true);
  group.traverse(o => {
    if (!o.isMesh || !o.visible || !o.geometry || o.material?.visible === false) return;
    let vis = true;
    for (let p = o; p; p = p.parent) if (!p.visible) { vis = false; break; }
    if (!vis) return;
    let e = edgeCache.get(o.geometry);
    if (!e) { e = new THREE.EdgesGeometry(o.geometry, 28); edgeCache.set(o.geometry, e); }
    const l = new THREE.LineSegments(e, edgeMat);
    l.matrixAutoUpdate = false;
    l.matrix.copy(o.matrixWorld);
    l.matrixWorld.copy(o.matrixWorld);
    out.add(l);
  });
  return out;
}

// Ceilings belong in sections and 3D views but would cover a plan seen from above; a plan's
// cut takes them away anyway, so they are only hidden for an uncut view from above.
// Only the ceilings groups themselves: a level group carries a reference to its ceilings in
// userData too, and hiding the level would hide the whole floor.
function setCeilings(group, on) {
  group.traverse(o => { if (o.userData && o.userData.ceilings === true) o.visible = on; });
}

// Render one camera to a canvas: { camera, clip (THREE.Plane[]), style, width, height }.
function draw({ camera, clip, style, width, height }) {
  const r = ensureRenderer();
  r.setSize(width, height, false);
  r.clippingPlanes = clip || [];
  r.setClearColor(0xffffff, 1);
  r.autoClear = false;
  r.clear();
  const lines = style === 'lines' || style === 'shaded-lines';
  const shaded = style !== 'lines';
  let edges = null;
  if (lines) { edges = edgeLines(built.group); scene.add(edges); edges.visible = false; }
  // Cut solids show dark where the cut opens them: back faces first, then the front faces.
  if (clip && clip.length) {
    scene.overrideMaterial = poche;
    r.render(scene, camera);
  }
  if (shaded) {
    scene.overrideMaterial = null;
    const restore = [];
    if (clip && clip.length) built.group.traverse(o => {
      for (const m of Array.isArray(o.material) ? o.material : o.material ? [o.material] : []) if (m.side === THREE.DoubleSide) { restore.push(m); m.side = THREE.FrontSide; }
    });
    r.render(scene, camera);
    for (const m of restore) m.side = THREE.DoubleSide;
  } else {
    scene.overrideMaterial = clip && clip.length ? white : whiteBoth;
    r.render(scene, camera);
    scene.overrideMaterial = null;
  }
  if (edges) {
    built.group.visible = false; lights.visible = false; edges.visible = true;
    r.render(scene, camera);
    built.group.visible = true; lights.visible = true;
    scene.remove(edges);
  }
  scene.overrideMaterial = null;
  r.autoClear = true;
  const out = document.createElement('canvas');
  out.width = width; out.height = height;
  out.getContext('2d').drawImage(r.domElement, 0, 0);
  return out;
}

async function settled(deadlineMs = 15000) {
  const end = performance.now() + deadlineMs;
  while (pendingTextureJobs() && performance.now() < end) await new Promise(r => setTimeout(r, 60));
}

// A viewport's model image at `width` x `height` pixels (a canvas), or null when it has no model view.
export function renderViewport(prop, v, width, height) {
  const job = busy.then(() => renderNow(prop, v, Math.max(16, Math.round(width)), Math.max(16, Math.round(height))));
  busy = job.catch(() => {});
  return job;
}

async function renderNow(prop, v, width, height) {
  if (!['plan', 'section', 'elevation', 'view3d'].includes(v.kind)) return null;
  if (v.kind === 'plan' && v.layers && !v.layers.model) return null;
  const group = await modelFor(prop);
  await settled();
  applyViewTags(prop, group, v.tags || null);
  group.updateMatrixWorld(true);
  const box = modelBox(group);
  const size = box.getSize(new THREE.Vector3()), mid = box.getCenter(new THREE.Vector3());
  const reach = Math.max(size.length(), 10) * 2;
  let camera, clip = [];
  setCeilings(group, v.ceilings !== false);
  if (v.kind === 'view3d') {
    const c = v.camera;
    camera = new THREE.PerspectiveCamera(c.fov, width / height, 0.05, reach * 4);
    camera.position.set(...c.position);
    camera.up.set(0, 1, 0);
    camera.lookAt(new THREE.Vector3(...c.target));
  } else {
    const f = orthoFrame(v);
    const hw = f.w / 2, hh = f.h / 2;
    camera = new THREE.OrthographicCamera(-hw, hw, hh, -hh, 0.01, reach * 4);
    const dir = new THREE.Vector3(...f.dir);
    if (v.kind === 'plan') {
      const lvl = (prop.levels || []).find(l => l.id === v.levelId) || (prop.levels || [])[0];
      const cutY = (lvl ? lvl.elevation : 0) + v.cut;
      camera.position.set(f.center[0], cutY + 1, f.center[2]);
      camera.near = 0.01; camera.far = cutY + 1 - (isFinite(box.min.y) ? box.min.y : -5) + 5;
      clip = [new THREE.Plane(new THREE.Vector3(0, -1, 0), cutY)];
    } else {
      // Back the camera off past the model so nothing in front of the cut is lost to the near plane.
      const back = reach;
      camera.position.set(f.center[0] - dir.x * back, f.center[1], f.center[2] - dir.z * back);
      if (v.clip) {
        const p = sectionPlane(v);
        clip = [new THREE.Plane(new THREE.Vector3(...p.normal), p.constant)];
        if (v.depth > 0) clip.push(new THREE.Plane(new THREE.Vector3(...p.normal).negate(), -p.constant + v.depth));
      }
    }
    camera.up.set(...f.up);
    camera.lookAt(camera.position.clone().add(dir));
    camera.updateProjectionMatrix();
  }
  camera.updateMatrixWorld();
  return draw({ camera, clip, style: v.style, width, height });
}

// ---------- vector layer for plans ----------

// Paper points per plan metre, and plan metres -> viewport points.
function planMap(v) {
  const k = 72 / (0.0254 * v.scale);
  const W = v.w * 72, H = v.h * 72;
  return { k, W, H, X: x => (x - v.center[0]) * k + W / 2, Y: y => (y - v.center[1]) * k + H / 2 };
}

const n3 = x => Math.round(x * 100) / 100;

// SVG markup (no outer <svg>) for a plan viewport in viewport points (0..w*72, 0..h*72).
export function planVectorSvg(prop, v) {
  const lvl = (prop.levels || []).find(l => l.id === v.levelId) || (prop.levels || [])[0];
  if (!lvl) return '';
  const m = planMap(v);
  const out = [];
  const H = levelHeight(prop, lvl.id);
  const cut = Math.min(v.cut, H - 0.01);
  // Room fills and labels under the walls.
  const rooms = roomsOn(prop, lvl.id);
  if (v.layers.rooms) {
    for (const r of rooms) {
      if (!r.pts || r.pts.length < 3) continue;
      out.push(`<polygon points="${r.pts.map(([x, y]) => n3(m.X(x)) + ',' + n3(m.Y(y))).join(' ')}" fill="${v.layers.model ? 'none' : '#f6f4ef'}" stroke="none"/>`);
    }
  }
  // Walls cut at the cut height: solid poché.
  for (const q of wallCapRects(prop, lvl.elevation + cut, { hiddenLevels: new Set(prop.levels.filter(l => l.id !== lvl.id).map(l => l.id)) })) {
    out.push(`<polygon points="${q.map(([x, y]) => n3(m.X(x)) + ',' + n3(m.Y(y))).join(' ')}" fill="#1d1d1d" stroke="#1d1d1d" stroke-width="0.3"/>`);
  }
  // Doors: leaf and swing, drawn on the wall's positive side; windows: two lines in the gap.
  const walls = wallsOn(prop, lvl.id);
  for (const o of openingsOn(prop, lvl.id)) {
    const w = walls.find(x => x.id === o.wallId);
    if (!w) continue;
    const L = Math.hypot(w.bx - w.ax, w.by - w.ay);
    if (L < 0.01) continue;
    const ux = (w.bx - w.ax) / L, uy = (w.by - w.ay) / L, nx = -uy, ny = ux;
    const c = o.t * L, half = o.width / 2, t2 = (w.thickness || 0.12) / 2;
    const P = (s, d) => [w.ax + ux * s + nx * d, w.ay + uy * s + ny * d];
    if (o.type === 'door') {
      // The leaves PLAN and MODEL draw (wall-solids.js): one leaf, or a pair meeting in the
      // middle. Each opens on the wall's positive side from its hinge to its swing arc.
      for (const sw of doorSwings(o)) {
        const [hx, hy] = P(c + sw.s, t2), [ex, ey] = P(c + sw.s, t2 + sw.r), [fx, fy] = P(c + sw.s + sw.dir * sw.r, t2);
        const H = [m.X(hx), m.Y(hy)], E = [m.X(ex), m.Y(ey)], F = [m.X(fx), m.Y(fy)];
        out.push(`<line x1="${n3(H[0])}" y1="${n3(H[1])}" x2="${n3(E[0])}" y2="${n3(E[1])}" stroke="#1d1d1d" stroke-width="0.9"/>`);
        const r = sw.r * m.k;
        const sweep = (E[0] - H[0]) * (F[1] - H[1]) - (E[1] - H[1]) * (F[0] - H[0]) > 0 ? 1 : 0;
        out.push(`<path d="M ${n3(E[0])} ${n3(E[1])} A ${n3(r)} ${n3(r)} 0 0 ${sweep} ${n3(F[0])} ${n3(F[1])}" fill="none" stroke="#555" stroke-width="0.45" stroke-dasharray="2 1.5"/>`);
      }
    } else {
      for (const d of [-t2 * 0.35, t2 * 0.35]) {
        const [x1, y1] = P(c - half, d), [x2, y2] = P(c + half, d);
        out.push(`<line x1="${n3(m.X(x1))}" y1="${n3(m.Y(y1))}" x2="${n3(m.X(x2))}" y2="${n3(m.Y(y2))}" stroke="#1d1d1d" stroke-width="0.5"/>`);
      }
      const [a1, b1] = P(c - half, -t2), [a2, b2] = P(c - half, t2), [a3, b3] = P(c + half, -t2), [a4, b4] = P(c + half, t2);
      out.push(`<line x1="${n3(m.X(a1))}" y1="${n3(m.Y(b1))}" x2="${n3(m.X(a2))}" y2="${n3(m.Y(b2))}" stroke="#1d1d1d" stroke-width="0.5"/>`);
      out.push(`<line x1="${n3(m.X(a3))}" y1="${n3(m.Y(b3))}" x2="${n3(m.X(a4))}" y2="${n3(m.Y(b4))}" stroke="#1d1d1d" stroke-width="0.5"/>`);
    }
  }
  // Wall dimensions: centreline length, on the wall's negative side, a half metre out.
  if (v.layers.dims) {
    for (const w of walls) {
      const L = Math.hypot(w.bx - w.ax, w.by - w.ay);
      if (L * m.k < 18) continue;
      const ux = (w.bx - w.ax) / L, uy = (w.by - w.ay) / L, nx = uy, ny = -ux;
      const off = (w.thickness || 0.12) / 2 + 14 / m.k;
      const x1 = m.X(w.ax + nx * off), y1 = m.Y(w.ay + ny * off), x2 = m.X(w.bx + nx * off), y2 = m.Y(w.by + ny * off);
      const tick = (x, y) => `<line x1="${n3(x - 3)}" y1="${n3(y + 3)}" x2="${n3(x + 3)}" y2="${n3(y - 3)}" stroke="#333" stroke-width="0.6"/>`;
      let ang = Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI;
      if (ang > 90) ang -= 180; if (ang <= -90) ang += 180;
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      out.push(`<line x1="${n3(x1)}" y1="${n3(y1)}" x2="${n3(x2)}" y2="${n3(y2)}" stroke="#333" stroke-width="0.4"/>`, tick(x1, y1), tick(x2, y2),
        `<text x="${n3(mx)}" y="${n3(my - 2)}" transform="rotate(${n3(ang)} ${n3(mx)} ${n3(my)})" text-anchor="middle" font-size="6.5" font-family="Helvetica, Arial, sans-serif" fill="#222">${escapeHtml(fmtLen(L))}</text>`);
    }
  }
  // Door and window numbers: each opening's mark from the door and window schedule (D1, W1...),
  // in a circle on the wall, so the drawing and the schedule sheet read together.
  if (v.layers.numbers) {
    const marks = new Map(openingSchedule(prop, lvl.id).map(r => [r.id, r]));
    for (const o of openingsOn(prop, lvl.id)) {
      const row = marks.get(o.id), f = row && openingFrame(prop, o);
      if (!f) continue;
      const x = m.X(f.cx), y = m.Y(f.cy), r = 6.5;
      out.push(`<circle cx="${n3(x)}" cy="${n3(y)}" r="${r}" fill="#fff" stroke="#1d1d1d" stroke-width="0.6"/>`,
        `<text x="${n3(x)}" y="${n3(y + 2.2)}" text-anchor="middle" font-size="6" font-weight="700" font-family="Helvetica, Arial, sans-serif" fill="#111">${escapeHtml(row.number)}</text>`);
    }
  }
  if (v.layers.rooms) {
    for (const r of rooms) {
      if (!r.pts || r.pts.length < 3) continue;
      const { x: cx, y: cy } = roomInteriorPoint(r.pts);
      const x = m.X(cx), y = m.Y(cy);
      out.push(`<text x="${n3(x)}" y="${n3(y)}" text-anchor="middle" font-size="7.5" font-weight="700" font-family="Helvetica, Arial, sans-serif" fill="#111" stroke="#fff" stroke-width="2.4" paint-order="stroke">${escapeHtml((r.name || 'Room').toUpperCase())}</text>`,
        `<text x="${n3(x)}" y="${n3(y + 9)}" text-anchor="middle" font-size="6.5" font-family="Helvetica, Arial, sans-serif" fill="#333" stroke="#fff" stroke-width="2.4" paint-order="stroke">${escapeHtml(fmtArea(Math.abs(polyArea(r.pts))))}</text>`);
    }
  }
  return out.join('');
}

// Section and elevation marks on a plan: the cut line with arrows toward the look direction
// and the drawing number of the view they belong to.
export function planMarksSvg(v, others) {
  const m = planMap(v);
  const out = [];
  for (const o of others) {
    if (o.kind !== 'section') continue;
    const f = lineFrame(o);
    const [ax, ay, bx, by] = o.line;
    const x1 = m.X(ax), y1 = m.Y(ay), x2 = m.X(bx), y2 = m.Y(by);
    out.push(`<line x1="${n3(x1)}" y1="${n3(y1)}" x2="${n3(x2)}" y2="${n3(y2)}" stroke="#b3261e" stroke-width="0.8" stroke-dasharray="7 2 1.5 2"/>`);
    for (const [x, y] of [[x1, y1], [x2, y2]]) {
      const tx = x + f.nx * 10, ty = y + f.ny * 10;
      out.push(`<circle cx="${n3(x)}" cy="${n3(y)}" r="6" fill="#fff" stroke="#b3261e" stroke-width="0.8"/>`,
        `<path d="M ${n3(x + f.ny * 4)} ${n3(y - f.nx * 4)} L ${n3(tx)} ${n3(ty)} L ${n3(x - f.ny * 4)} ${n3(y + f.nx * 4)} Z" fill="#b3261e"/>`,
        `<text x="${n3(x)}" y="${n3(y + 2.4)}" text-anchor="middle" font-size="6.5" font-weight="700" font-family="Helvetica, Arial, sans-serif" fill="#b3261e">${o.number || ''}</text>`);
    }
  }
  return out.join('');
}

export function releaseRenderer() {
  if (built) { scene.remove(built.group); for (const c of built.group.children) if (c.userData.planGroup) disposeBuilt(c); built = null; }
  for (const p of scanCache.values()) p.then(o => o && disposeScanObject(o));
  scanCache.clear();
  if (renderer) { renderer.dispose(); renderer.forceContextLoss(); renderer = null; scene.remove(lights); lights = null; }
}
