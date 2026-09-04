// Model -> three.js scene generation.
// Plan coordinates are meters, x east / y south (canvas convention).
// World mapping: plan (x, y) -> world (x, z); height is world y.
//
// Walls become sets of boxes computed around openings (no CSG needed): full-height
// segments between openings, headers above doors/windows, sills below windows.
// Every box carries UV coordinates in METERS (u along the wall, v vertical) so the
// materials from textures.js tile at their real-world size. On top of the bare
// solids the builder adds the things that make a house read as a house: door jambs,
// casings and leaves, window frames with sash and mullions and real glass,
// baseboards, ceilings, and a ground disc.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { materialById } from './store.js';
import { materialFor } from './textures.js';

const FALLBACK_WALL = '#d8d4cc';
const FALLBACK_FLOOR = '#97999b';
const FALLBACK_TRIM = '#f3f1ec';
const FALLBACK_CEILING = '#f1efe9';

const BASEBOARD_H = 0.14, BASEBOARD_D = 0.012;
const CASING_W = 0.07, CASING_D = 0.016;
const JAMB_W = 0.05;
const FRAME_W = 0.045, SASH_W = 0.035, MULLION_W = 0.022;
const LEAF_T = 0.045;
const EPS = 0.0005;               // buried-face margin so joined boxes never share a plane

// ---------- materials ----------
// Local fallbacks are cached for the life of the page; they are ours to keep.
// Materials from textures.js are shared and cached there; we never dispose or mutate them.
const localMats = new Map();
function localMat(key, make) {
  if (!localMats.has(key)) { const m = make(); m.userData.local = true; localMats.set(key, m); }
  return localMats.get(key);
}
function flatMat(color, roughness, opts) {
  return localMat('flat|' + color + '|' + roughness + '|' + JSON.stringify(opts || {}), () =>
    new THREE.MeshStandardMaterial(Object.assign({ color: new THREE.Color(color), roughness, metalness: 0.02 }, opts || {})));
}

// Resolve a material record to a three material, honoring x-ray by asking for a
// distinct transparent cache entry (never by mutating the shared one).
function matFor(record, fallbackColor, fallbackRough, opts) {
  let m = record ? materialFor(record, opts) : flatMat(fallbackColor, fallbackRough, opts);
  if (opts && opts.transparent && !m.transparent) {
    // The textures.js stub ignores opts; make a private transparent clone we can dispose.
    m = m.clone();
    m.transparent = true; m.opacity = opts.opacity == null ? 0.35 : opts.opacity; m.depthWrite = false;
    m.userData.local = true; m.userData.disposable = true;
  }
  return m;
}
function trimMat(opts) { return matFor(materialById('mat-trim'), FALLBACK_TRIM, 0.55, opts); }
function ceilingMat(id, opts) { return matFor(materialById(id || 'mat-ceiling'), FALLBACK_CEILING, 0.95, opts); }

function glassMat() {
  // One physical glass per build: reflects the environment, refracts what is behind it.
  const m = new THREE.MeshPhysicalMaterial({
    color: 0xeaf4f8, transmission: 0.92, roughness: 0.05, metalness: 0, ior: 1.52, thickness: 0.006,
    transparent: true, opacity: 1, side: THREE.DoubleSide, envMapIntensity: 3.5,
  });
  m.userData.local = true; m.userData.disposable = true; m.userData.glass = true;
  return m;
}
function metalMat() {
  return localMat('metal', () => new THREE.MeshStandardMaterial({ color: 0xb9bcc0, metalness: 0.95, roughness: 0.32 }));
}

// ---------- procedural door leaf texture (six-panel relief) ----------
let doorTex = null;
function doorTextures() {
  if (doorTex) return doorTex;
  const W = 256, H = 512;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  // Height field: 1 = leaf surface, panels recessed with a bevelled edge.
  const hgt = new Float32Array(W * H).fill(1);
  const panels = [];
  const cols = 2, rows = 3, mx = 24, my = 26, gx = 18, gy = 20;
  const pw = (W - mx * 2 - gx * (cols - 1)) / cols;
  const rh = [0.24, 0.38, 0.38];
  const usable = H - my * 2 - gy * (rows - 1);
  let y = my;
  for (let r = 0; r < rows; r++) {
    const ph = usable * rh[r];
    for (let col = 0; col < cols; col++) panels.push([mx + col * (pw + gx), y, pw, ph]);
    y += ph + gy;
  }
  const bevel = 7;
  for (const [px, py, pw2, ph2] of panels) {
    for (let yy = Math.floor(py); yy < py + ph2; yy++) for (let xx = Math.floor(px); xx < px + pw2; xx++) {
      const d = Math.min(xx - px, px + pw2 - xx, yy - py, py + ph2 - yy);
      const t = Math.min(1, d / bevel);
      hgt[yy * W + xx] = 1 - 0.55 * t;            // recess deepens across the bevel, flat inside
    }
  }
  // Albedo: warm white paint with the faint shading a recessed panel picks up.
  const img = ctx.createImageData(W, H);
  const nrm = ctx.createImageData(W, H);
  for (let yy = 0; yy < H; yy++) for (let xx = 0; xx < W; xx++) {
    const i = yy * W + xx;
    const l = hgt[Math.max(0, i - 1)], rr = hgt[Math.min(W * H - 1, i + 1)];
    const u = hgt[Math.max(0, i - W)], d = hgt[Math.min(W * H - 1, i + W)];
    const dx = (rr - l) * 4, dy = (d - u) * 4;
    const len = Math.hypot(dx, dy, 1);
    nrm.data[i * 4] = (-dx / len * 0.5 + 0.5) * 255;
    nrm.data[i * 4 + 1] = (dy / len * 0.5 + 0.5) * 255;
    nrm.data[i * 4 + 2] = (1 / len * 0.5 + 0.5) * 255;
    nrm.data[i * 4 + 3] = 255;
    const grain = (Math.sin(xx * 0.9 + Math.sin(yy * 0.02) * 3) * 0.5 + Math.random()) * 3;
    const shade = 1 - (1 - hgt[i]) * 0.08 + (dy + dx) * 0.05;
    img.data[i * 4] = Math.min(255, 244 * shade + grain);
    img.data[i * 4 + 1] = Math.min(255, 240 * shade + grain);
    img.data[i * 4 + 2] = Math.min(255, 232 * shade + grain);
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 4;
  const nc = document.createElement('canvas'); nc.width = W; nc.height = H;
  nc.getContext('2d').putImageData(nrm, 0, 0);
  const normalMap = new THREE.CanvasTexture(nc);
  doorTex = { map, normalMap };
  return doorTex;
}
function leafMaterials() {
  const { map, normalMap } = doorTextures();
  const face = localMat('leaf-face', () => new THREE.MeshStandardMaterial({
    map, normalMap, normalScale: new THREE.Vector2(0.9, 0.9), roughness: 0.45, metalness: 0,
  }));
  const edge = flatMat('#f1eee7', 0.45);
  return [edge, edge, edge, edge, face, face];
}

// ---------- metric box geometry ----------
// Axis-aligned box from (x0,y0,z0) to (x1,y1,z1) in wall-local coordinates, with UVs in
// meters: side faces (u = x, v = y), top/bottom (u = x, v = z), ends (u = z, v = y).
export function metricBox(x0, x1, y0, y1, z0, z1) {
  const P = [], N = [], UV = [], I = [];
  let base = 0;
  const face = (verts, n, uvs) => {
    for (let i = 0; i < 4; i++) { P.push(...verts[i]); N.push(...n); UV.push(...uvs[i]); }
    I.push(base, base + 1, base + 2, base, base + 2, base + 3);
    base += 4;
  };
  face([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1], [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
  face([[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], [0, 0, -1], [[x1, y0], [x0, y0], [x0, y1], [x1, y1]]);
  face([[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], [0, 1, 0], [[x0, z1], [x1, z1], [x1, z0], [x0, z0]]);
  face([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], [0, -1, 0], [[x0, z0], [x1, z0], [x1, z1], [x0, z1]]);
  face([[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], [1, 0, 0], [[z1, y0], [z0, y0], [z0, y1], [z1, y1]]);
  face([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], [-1, 0, 0], [[z0, y0], [z1, y0], [z1, y1], [z0, y1]]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2));
  g.setIndex(I);
  return g;
}

function mergedMesh(geos, material, userData) {
  if (!geos.length) return null;
  const g = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
  if (geos.length > 1) geos.forEach(x => x.dispose());
  const m = new THREE.Mesh(g, material);
  m.castShadow = true; m.receiveShadow = true;
  m.userData = userData;
  return m;
}

// ---------- plan helpers ----------
function pointInPoly(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function roomAt(rooms, x, y) {
  for (const r of rooms) if (r.pts && r.pts.length > 2 && pointInPoly(x, y, r.pts)) return r;
  return null;
}

// Which rooms border each side of a wall (+1 = local +z side, -1 = local -z side).
function wallSides(wall, rooms) {
  const L = Math.hypot(wall.bx - wall.ax, wall.by - wall.ay) || 1;
  const ux = (wall.bx - wall.ax) / L, uy = (wall.by - wall.ay) / L;
  const nx = -uy, ny = ux;                       // local +z direction in plan
  const th = wall.thickness || 0.114;
  const off = th / 2 + 0.08;
  const mx = (wall.ax + wall.bx) / 2, my = (wall.ay + wall.by) / 2;
  const probe = (sgn, f) => roomAt(rooms, mx + ux * (f - 0.5) * L * 0.6 + nx * off * sgn, my + uy * (f - 0.5) * L * 0.6 + ny * off * sgn);
  // Probe three points along the wall so a room that only covers part of a long wall still counts.
  const pos = probe(1, 0.5) || probe(1, 0.2) || probe(1, 0.8);
  const neg = probe(-1, 0.5) || probe(-1, 0.2) || probe(-1, 0.8);
  return { pos, neg };
}

// How far to extend each wall end so corners close: half the thickness of a wall whose
// endpoint coincides with ours, minus a hair so the buried end face never shares a plane.
function endExtensions(wall, walls) {
  const L = Math.hypot(wall.bx - wall.ax, wall.by - wall.ay) || 1;
  const ux = (wall.bx - wall.ax) / L, uy = (wall.by - wall.ay) / L;
  const ext = (px, py) => {
    let best = 0;
    for (const o of walls) {
      if (o === wall || o.id === wall.id) continue;
      const oL = Math.hypot(o.bx - o.ax, o.by - o.ay) || 1;
      const oux = (o.bx - o.ax) / oL, ouy = (o.by - o.ay) / oL;
      const sinA = Math.abs(ux * ouy - uy * oux);
      if (sinA < 0.3) continue;                  // collinear continuation: nothing to close
      for (const [ex, ey] of [[o.ax, o.ay], [o.bx, o.by]]) {
        if (Math.hypot(ex - px, ey - py) < 0.012) best = Math.max(best, (o.thickness || 0.114) / 2 - EPS);
      }
    }
    return best;
  };
  return { a: ext(wall.ax, wall.ay), b: ext(wall.bx, wall.by) };
}

// Solid pieces of one wall in local coords: s along wall [0..L], v vertical [0..H].
export function wallSolids(wall, openings, defaultHeight) {
  const L = Math.hypot(wall.bx - wall.ax, wall.by - wall.ay);
  const H = wall.height || defaultHeight;
  if (L < 0.01) return { solids: [], glass: [], L, H };

  const ops = openings
    .filter(o => o.wallId === wall.id)
    .map(o => {
      const c = Math.min(Math.max(o.t * L, o.width / 2), L - o.width / 2);
      return { s0: c - o.width / 2, s1: c + o.width / 2, o };
    })
    .filter(x => x.s1 > x.s0 + 0.01 && x.s0 < L)
    .sort((a, b) => a.s0 - b.s0);

  const solids = [];
  const glass = [];
  let cursor = 0;
  for (const { s0, s1, o } of ops) {
    if (s0 > cursor + 0.005) solids.push({ s0: cursor, s1: s0, v0: 0, v1: H });
    const top = Math.min((o.type === 'window' ? (o.sill || 0) + o.height : o.height), H);
    if (top < H - 0.01) solids.push({ s0, s1, v0: top, v1: H });          // header
    if (o.type === 'window' && (o.sill || 0) > 0.01) solids.push({ s0, s1, v0: 0, v1: o.sill }); // sill wall below
    if (o.type === 'window') glass.push({ s0, s1, v0: (o.sill || 0), v1: top, id: o.id });
    cursor = Math.max(cursor, s1);
  }
  if (cursor < L - 0.005) solids.push({ s0: cursor, s1: L, v0: 0, v1: H });
  return { solids, glass, L, H };
}

// ---------- doors ----------
function buildDoor(o, s0, s1, top, th, sides, ctx) {
  const g = new THREE.Group();
  g.userData = { kind: 'opening', id: o.id, wallId: ctx.wall.id };
  const trim = [];
  const w = s1 - s0;
  const tm = trimMat(ctx.matOpts);
  const proud = 0.008;
  // Jambs and head inside the rough opening.
  trim.push(metricBox(s0, s0 + JAMB_W, 0, top, -th / 2 - proud, th / 2 + proud));
  trim.push(metricBox(s1 - JAMB_W, s1, 0, top, -th / 2 - proud, th / 2 + proud));
  trim.push(metricBox(s0 + JAMB_W, s1 - JAMB_W, top - JAMB_W, top, -th / 2 - proud, th / 2 + proud));
  // Casing on every side that faces a room.
  for (const sgn of [1, -1]) {
    if (!(sgn > 0 ? sides.pos : sides.neg)) continue;
    const z0 = sgn > 0 ? th / 2 : -th / 2 - CASING_D, z1 = sgn > 0 ? th / 2 + CASING_D : -th / 2;
    trim.push(metricBox(s0 - CASING_W, s0 + 0.01, 0, top + CASING_W, z0, z1));
    trim.push(metricBox(s1 - 0.01, s1 + CASING_W, 0, top + CASING_W, z0, z1));
    trim.push(metricBox(s0 - CASING_W, s1 + CASING_W, top - 0.01, top + CASING_W, z0, z1));
  }
  const tmesh = mergedMesh(trim, tm, g.userData);
  if (tmesh) g.add(tmesh);

  const interior = !!(sides.pos && sides.neg);
  const archway = w > 1.25;                       // wide cased openings have no leaf
  if (!archway) {
    const leafW = w - JAMB_W * 2 - 0.006, leafH = top - JAMB_W - 0.012;
    const pivot = new THREE.Group();
    pivot.position.set(s0 + JAMB_W + 0.003, 0.01, 0);
    const swingSide = sides.pos ? 1 : -1;
    pivot.rotation.y = interior ? -swingSide * THREE.MathUtils.degToRad(25) : 0;
    const leaf = new THREE.Mesh(new THREE.BoxGeometry(leafW, leafH, LEAF_T), leafMaterials());
    leaf.position.set(leafW / 2, leafH / 2, 0);
    leaf.castShadow = true; leaf.receiveShadow = true;
    leaf.userData = { kind: 'opening', id: o.id, wallId: ctx.wall.id, noCollide: true };
    pivot.add(leaf);
    // Lever handles, both faces.
    const mm = metalMat();
    for (const sgn of [1, -1]) {
      const hx = leafW - 0.075, hy = 1.0;
      const rose = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.01, 24), mm);
      rose.rotation.x = Math.PI / 2;
      rose.position.set(hx, hy, sgn * (LEAF_T / 2 + 0.005));
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, 0.05, 16), mm);
      stem.rotation.x = Math.PI / 2;
      stem.position.set(hx, hy, sgn * (LEAF_T / 2 + 0.03));
      const lever = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.007, 0.12, 16), mm);
      lever.rotation.z = Math.PI / 2;
      lever.position.set(hx - 0.055, hy, sgn * (LEAF_T / 2 + 0.05));
      for (const p of [rose, stem, lever]) { p.castShadow = true; p.userData = leaf.userData; pivot.add(p); }
    }
    g.add(pivot);
  }
  return g;
}

// ---------- windows ----------
function buildWindow(o, s0, s1, v0, v1, th, sides, ctx) {
  const g = new THREE.Group();
  g.userData = { kind: 'opening', id: o.id, wallId: ctx.wall.id };
  const trim = [];
  const tm = trimMat(ctx.matOpts);
  const w = s1 - s0, h = v1 - v0;
  const fz0 = -th / 2 - 0.005, fz1 = th / 2 + 0.005;
  // Outer frame.
  trim.push(metricBox(s0, s0 + FRAME_W, v0, v1, fz0, fz1));
  trim.push(metricBox(s1 - FRAME_W, s1, v0, v1, fz0, fz1));
  trim.push(metricBox(s0 + FRAME_W, s1 - FRAME_W, v1 - FRAME_W, v1, fz0, fz1));
  trim.push(metricBox(s0 + FRAME_W, s1 - FRAME_W, v0, v0 + FRAME_W, fz0, fz1));
  // Sash.
  const sx0 = s0 + FRAME_W, sx1 = s1 - FRAME_W, sy0 = v0 + FRAME_W, sy1 = v1 - FRAME_W;
  const sz0 = -0.024, sz1 = 0.024;
  trim.push(metricBox(sx0, sx0 + SASH_W, sy0, sy1, sz0, sz1));
  trim.push(metricBox(sx1 - SASH_W, sx1, sy0, sy1, sz0, sz1));
  trim.push(metricBox(sx0 + SASH_W, sx1 - SASH_W, sy1 - SASH_W, sy1, sz0, sz1));
  trim.push(metricBox(sx0 + SASH_W, sx1 - SASH_W, sy0, sy0 + SASH_W, sz0, sz1));
  // Mullion grid: 2 columns up to ~1.1 m wide, 3 beyond; always 2 rows.
  const gx0 = sx0 + SASH_W, gx1 = sx1 - SASH_W, gy0 = sy0 + SASH_W, gy1 = sy1 - SASH_W;
  const cols = w >= 1.1 ? 3 : 2, rows = h >= 0.7 ? 2 : 1;
  for (let c = 1; c < cols; c++) {
    const x = gx0 + (gx1 - gx0) * c / cols;
    trim.push(metricBox(x - MULLION_W / 2, x + MULLION_W / 2, gy0, gy1, -0.016, 0.016));
  }
  for (let r = 1; r < rows; r++) {
    const y = gy0 + (gy1 - gy0) * r / rows;
    trim.push(metricBox(gx0, gx1, y - MULLION_W / 2, y + MULLION_W / 2, -0.016, 0.016));
  }
  // Stool, apron and casing on the room side; sill outside.
  const inSide = sides.pos ? 1 : (sides.neg ? -1 : 1);
  const bothRooms = !!(sides.pos && sides.neg);
  const roomSides = bothRooms ? [1, -1] : [inSide];
  for (const sgn of roomSides) {
    const face = sgn * th / 2;
    const out = (d) => face + sgn * d;
    trim.push(metricBox(s0 - 0.06, s1 + 0.06, v0 - 0.028, v0, Math.min(0, out(0.06)), Math.max(0, out(0.06))));
    trim.push(metricBox(s0 - CASING_W, s1 + CASING_W, v0 - 0.11, v0 - 0.028, Math.min(face, out(CASING_D)), Math.max(face, out(CASING_D))));
    trim.push(metricBox(s0 - CASING_W, s0 + 0.01, v0, v1 + CASING_W, Math.min(face, out(CASING_D)), Math.max(face, out(CASING_D))));
    trim.push(metricBox(s1 - 0.01, s1 + CASING_W, v0, v1 + CASING_W, Math.min(face, out(CASING_D)), Math.max(face, out(CASING_D))));
    trim.push(metricBox(s0 - CASING_W, s1 + CASING_W, v1 - 0.01, v1 + CASING_W, Math.min(face, out(CASING_D)), Math.max(face, out(CASING_D))));
  }
  if (!bothRooms) {
    const sgn = -inSide, face = sgn * th / 2, out = face + sgn * 0.045;
    trim.push(metricBox(s0 - 0.03, s1 + 0.03, v0 - 0.04, v0, Math.min(0, out), Math.max(0, out)));
  }
  const tmesh = mergedMesh(trim, tm, g.userData);
  if (tmesh) g.add(tmesh);
  // Glass: a single 6 mm pane behind the sash.
  const glass = new THREE.Mesh(metricBox(gx0, gx1, gy0, gy1, -0.003, 0.003), ctx.glass);
  glass.userData = { kind: 'opening', id: o.id, wallId: ctx.wall.id, glass: true };
  glass.castShadow = false; glass.receiveShadow = false;
  g.add(glass);
  return g;
}

// ---------- walls ----------
export function buildWallGroup(wall, openings, property, ctx) {
  ctx = ctx || {};
  const { solids, L, H } = wallSolids(wall, openings, property.wallHeight);
  const group = new THREE.Group();
  group.userData = { kind: 'wall', id: wall.id };
  if (L < 0.01) return group;

  const ux = (wall.bx - wall.ax) / L, uy = (wall.by - wall.ay) / L;
  group.position.set(wall.ax, 0, wall.ay);
  group.rotation.y = -Math.atan2(uy, ux);
  const th = wall.thickness || 0.114;
  const rooms = property.rooms || [];
  const sides = wallSides(wall, rooms);
  const ext = endExtensions(wall, property.walls || []);
  // Stagger each wall's top by a fifth of a millimetre: coplanar tops at corners never fight.
  const lift = (ctx.index || 0) * 0.0002;

  const wallMaterial = matFor(materialById(wall.material), FALLBACK_WALL, 0.9, ctx.matOpts);
  const geos = [];
  const baseGeos = [];
  for (const s of solids) {
    const x0 = s.s0 < 0.001 ? -ext.a : s.s0;
    const x1 = s.s1 > L - 0.001 ? L + ext.b : s.s1;
    const y1 = s.v1 >= H - 0.001 ? H + lift : s.v1;
    geos.push(metricBox(x0, x1, s.v0, y1, -th / 2, th / 2));
    if (s.v0 < 0.001) {
      // Baseboard on every face that borders a room, only on floor-touching pieces.
      for (const sgn of [1, -1]) {
        if (!(sgn > 0 ? sides.pos : sides.neg)) continue;
        const z0 = sgn > 0 ? th / 2 : -th / 2 - BASEBOARD_D, z1 = sgn > 0 ? th / 2 + BASEBOARD_D : -th / 2;
        baseGeos.push(metricBox(x0, x1, 0.06, 0.06 + BASEBOARD_H, z0, z1));
      }
    }
  }
  const solidMesh = mergedMesh(geos, wallMaterial, { kind: 'wall', id: wall.id });
  if (solidMesh) group.add(solidMesh);
  const baseMesh = mergedMesh(baseGeos, trimMat(ctx.matOpts), { kind: 'wall', id: wall.id });
  if (baseMesh) group.add(baseMesh);

  // Openings.
  for (const o of openings) {
    if (o.wallId !== wall.id) continue;
    const c = Math.min(Math.max(o.t * L, o.width / 2), L - o.width / 2);
    const s0 = c - o.width / 2, s1 = c + o.width / 2;
    if (s1 <= s0 + 0.01) continue;
    const octx = { wall, glass: ctx.glass, matOpts: ctx.matOpts };
    if (o.type === 'window') {
      const v0 = o.sill || 0, v1 = Math.min(v0 + o.height, H);
      if (v1 > v0 + 0.05) group.add(buildWindow(o, s0, s1, v0, v1, th, sides, octx));
    } else {
      group.add(buildDoor(o, s0, s1, Math.min(o.height, H), th, sides, octx));
    }
  }
  return group;
}

// ---------- rooms ----------
function roomShape(room) {
  const shape = new THREE.Shape();
  shape.moveTo(room.pts[0][0], room.pts[0][1]);
  for (let i = 1; i < room.pts.length; i++) shape.lineTo(room.pts[i][0], room.pts[i][1]);
  shape.closePath();
  return shape;
}

export function buildRoomFloor(room, ctx) {
  if (!room.pts || room.pts.length < 3) return null;
  const geo = new THREE.ExtrudeGeometry(roomShape(room), { depth: 0.06, bevelEnabled: false });
  // Shape lies in XY; rotate so plan-y becomes world-z, extrusion goes down. UVs stay in meters.
  geo.rotateX(Math.PI / 2);
  const mat = matFor(materialById(room.material), FALLBACK_FLOOR, 0.85, ctx && ctx.matOpts);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = 0.06;
  mesh.receiveShadow = true; mesh.castShadow = true;
  mesh.userData = { kind: 'room', id: room.id };
  const group = new THREE.Group();
  group.userData = { kind: 'room', id: room.id };
  group.add(mesh);
  return group;
}

export function buildRoomCeiling(room, H, ctx) {
  if (!room.pts || room.pts.length < 3) return null;
  const geo = new THREE.ExtrudeGeometry(roomShape(room), { depth: 0.027, bevelEnabled: false });
  geo.rotateX(Math.PI / 2);
  const mesh = new THREE.Mesh(geo, ceilingMat(room.ceilingMaterial, ctx && ctx.matOpts));
  mesh.position.y = H - 0.003;                    // slab hangs just under the wall tops
  mesh.receiveShadow = true; mesh.castShadow = true;
  mesh.userData = { kind: 'ceiling', id: room.id };
  return mesh;
}

export function roomCentres(property) {
  const out = [];
  for (const r of property.rooms || []) {
    if (!r.pts || r.pts.length < 3) continue;
    let x = 0, y = 0;
    for (const p of r.pts) { x += p[0]; y += p[1]; }
    out.push({ id: r.id, name: r.name, x: x / r.pts.length, z: y / r.pts.length });
  }
  return out;
}

// ---------- property ----------
// opts: { xray: bool }
export function buildPropertyGroup(property, opts) {
  opts = opts || {};
  const root = new THREE.Group();
  root.name = 'property';
  const matOpts = opts.xray ? { transparent: true, opacity: 0.35 } : undefined;
  const glass = glassMat();
  if (opts.xray) { glass.transmission = 0; glass.opacity = 0.25; }
  const ctx = { matOpts, glass };

  for (const room of property.rooms || []) {
    const g = buildRoomFloor(room, ctx);
    if (g) root.add(g);
  }
  (property.walls || []).forEach((wall, index) => {
    root.add(buildWallGroup(wall, property.openings || [], property, Object.assign({ index }, ctx)));
  });
  const ceilings = new THREE.Group();
  ceilings.name = 'ceilings';
  ceilings.userData = { ceilings: true };
  for (const room of property.rooms || []) {
    const m = buildRoomCeiling(room, property.wallHeight || 2.44, ctx);
    if (m) ceilings.add(m);
  }
  root.add(ceilings);
  root.userData = { ceilings, glass };
  return root;
}

// ---------- ground ----------
let groundTex = null;
function groundTexture() {
  if (groundTex) return groundTex;
  const S = 512;
  const c = document.createElement('canvas'); c.width = S; c.height = S;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#5c6e40';
  ctx.fillRect(0, 0, S, S);
  // Mowing stripes, a few broad soft patches, then fine speckle: a lawn at any distance.
  for (let i = 0; i < 6; i++) {
    ctx.fillStyle = i % 2 ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.035)';
    ctx.fillRect(0, i * S / 6, S, S / 6);
  }
  for (let i = 0; i < 40; i++) {
    const x = Math.random() * S, y = Math.random() * S, r = 60 + Math.random() * 120;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const tone = Math.random() < 0.5 ? '78,96,54' : '118,132,78';
    g.addColorStop(0, 'rgba(' + tone + ',0.28)');
    g.addColorStop(1, 'rgba(' + tone + ',0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  const img = ctx.getImageData(0, 0, S, S);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 40;
    img.data[i] += n; img.data[i + 1] += n * 1.15; img.data[i + 2] += n * 0.7;
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  groundTex = tex;
  return tex;
}

// opts: { showGrid, studio }
export function buildGround(property, opts) {
  opts = opts || {};
  const b = modelBounds(property);
  const cx = (b.minX + b.maxX) / 2, cz = (b.minY + b.maxY) / 2;
  const span = Math.max(b.maxX - b.minX, b.maxY - b.minY, 8);
  // Reach out to the true horizon so no dark sky shows beneath it from any sensible height.
  const R = 2400;
  const group = new THREE.Group();
  group.name = 'ground';
  const geo = new THREE.CircleGeometry(R, 128);
  geo.rotateX(-Math.PI / 2);
  // CircleGeometry UVs span 0..1 across the disc; rescale to meters so the lawn tiles at 3 m.
  const uv = geo.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 2 * R, uv.getY(i) * 2 * R);
  const tex = groundTexture();
  // Studio mode swaps the lawn for a dark matte floor so the model sits on a stage.
  const mat = opts.studio
    ? localMat('ground-studio', () => new THREE.MeshStandardMaterial({ color: 0x1c2229, roughness: 0.85, metalness: 0 }))
    : localMat('ground', () => new THREE.MeshStandardMaterial({ map: tex, roughness: 1, metalness: 0 }));
  if (mat.map) mat.map.repeat.set(1 / 3, 1 / 3);
  const disc = new THREE.Mesh(geo, mat);
  disc.position.set(cx, -0.002, cz);
  disc.receiveShadow = true;
  disc.userData = { kind: 'ground' };
  group.add(disc);
  if (opts.showGrid) {
    const size = Math.ceil(span * 2 / 2) * 2 + 8;
    const grid = new THREE.GridHelper(size, size, 0x2e3c48, 0x2a343d);
    grid.position.set(Math.round(cx), 0.004, Math.round(cz));
    grid.material.transparent = true; grid.material.opacity = 0.55;
    grid.userData = { kind: 'grid', local: true };
    group.add(grid);
  }
  return group;
}

// Plan-space rectangles (4 corners, world x/z) of every wall solid that a horizontal cut at
// `height` passes through; the viewer draws these as dark section caps over the clipped walls.
export function wallCapRects(property, height) {
  const rects = [];
  for (const wall of property.walls || []) {
    const { solids, L } = wallSolids(wall, property.openings || [], property.wallHeight || 2.44);
    if (L < 0.01) continue;
    const ux = (wall.bx - wall.ax) / L, uy = (wall.by - wall.ay) / L;
    const nx = -uy, ny = ux;
    const th = (wall.thickness || 0.114) / 2;
    const ext = endExtensions(wall, property.walls || []);
    for (const s of solids) {
      if (s.v0 > height || s.v1 < height) continue;
      const x0 = s.s0 < 0.001 ? -ext.a : s.s0;
      const x1 = s.s1 > L - 0.001 ? L + ext.b : s.s1;
      const c = (t, side) => [wall.ax + ux * t + nx * th * side, wall.ay + uy * t + ny * th * side];
      rects.push([c(x0, 1), c(x1, 1), c(x1, -1), c(x0, -1)]);
    }
  }
  return rects;
}

export function modelBounds(property) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const eat = (x, y) => {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  };
  for (const w of property.walls || []) { eat(w.ax, w.ay); eat(w.bx, w.by); }
  for (const r of property.rooms || []) for (const [x, y] of r.pts || []) eat(x, y);
  if (property.plan && property.plan.img) {
    eat(property.plan.offsetX || 0, property.plan.offsetY || 0);
    eat((property.plan.offsetX || 0) + property.plan.imgW * property.plan.mPerPx,
        (property.plan.offsetY || 0) + property.plan.imgH * property.plan.mPerPx);
  }
  if (minX === Infinity) return { minX: -5, minY: -5, maxX: 5, maxY: 5 };
  return { minX, minY, maxX, maxY };
}

// Dispose geometries and the materials this module created for one build.
// Shared materials (textures.js cache, module-level fallbacks) are left alone.
export function disposeBuilt(obj) {
  obj.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    for (const m of mats) if (m.userData && m.userData.disposable) m.dispose();
  });
}
