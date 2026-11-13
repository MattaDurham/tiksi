// Model -> three.js scene generation.
// Plan coordinates are meters, x east / y south (canvas convention).
// World mapping: plan (x, y) -> world (x, z); height is world y.
//
// Walls become sets of prisms computed around openings (no CSG needed): full-height
// segments between openings, headers above doors/windows, sills below windows. In plan
// each wall end is closed against the walls that meet it: corners are mitred, a wall that
// abuts another mid-span is cut back to that wall's face, and a wall continuing straight
// on needs nothing. Every prism carries UV coordinates in METERS (u along the wall,
// v vertical) so the materials from textures.js tile at their real-world size, and the
// faces that look into a room can carry a different finish from the rest of the wall.
// On top of the bare solids the builder adds the things that make a house read as a
// house: door jambs, casings and leaves, window frames with sash and mullions and real
// glass, baseboards, ceilings, and a ground disc.

import { setModelXray } from './model-xray.js';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { materialById, ensureLevels, levelHeight, levelOfRoom, wallsOn, roomsOn, openingsOn } from './store.js';
import { materialFor } from './textures.js';
import { openingSpans, wallSolids, wallSides, wallInteriorMaterialId, wallFaceMaterialIds, pointInPoly, doorShownOpen, doorGlass, leafGlazing, plainOpening, doorDetail, windowDetail, baseboardDetail } from './wall-solids.js';
import { fixturesOn, fixtureParts, FIXTURE_FALLBACK } from './fixtures.js';
import { applyPlanTagVisibility } from './tags-scene.js';
import { cutPrism } from './section-planes.js';
import { thresholdFloors as derivedThresholdFloors } from './threshold-floors.js';

const FALLBACK_WALL = '#d8d4cc';
const FALLBACK_FLOOR = '#97999b';
const FALLBACK_TRIM = '#f3f1ec';
const FALLBACK_CEILING = '#f1efe9';

// A floor is a slab this thick whose top is the level's own height: the height walls, doors,
// fixtures and imported models stand at. (It used to sit on top of that height, which buried
// the foot of every piece of furniture and hid anything thinner, a rug or a hearth.)
export const FLOOR_T = 0.06;
export const CEILING_T = 0.027;
const EPS = 0.0005;               // buried-face margin so joined solids never share a plane
const JOIN_TOL = 0.012;           // wall endpoints closer than this meet at one joint
const COLLINEAR = 0.3;            // sin of the deflection below which a neighbour continues the wall

// ---------- materials ----------
// Local fallbacks are cached for the life of the page; they are ours to keep.
// Materials from textures.js are shared and cached there; we never dispose or mutate them.
const localMats = new Map();
function localMat(key, make) {
  if (!localMats.has(key)) { const m = make(); m.userData.local = true; localMats.set(key, m); }
  return localMats.get(key);
}
function flatMat(color, roughness, opts) {
  return localMat('flat|' + color + '|' + roughness + '|' + JSON.stringify(opts || {}), () => {
    const m = new THREE.MeshStandardMaterial(Object.assign({ color: new THREE.Color(color), roughness, metalness: 0.02 }, opts || {}));
    if (m.transparent) m.depthWrite = false;      // x-ray ghosts must not occlude one another
    return m;
  });
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
  // Reflection stays at the scene's IBL baseline: Fresnel already reaches 1 at grazing
  // angles, and anything brighter blooms into a white smear that swallows the sash.
  const m = new THREE.MeshPhysicalMaterial({
    color: 0xeaf4f8, transmission: 0.92, roughness: 0.08, metalness: 0, ior: 1.52, thickness: 0.006,
    specularIntensity: 0.6, transparent: true, opacity: 1, side: THREE.DoubleSide, envMapIntensity: 1.0,
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

// ---------- metric prism geometry ----------
// Vertical prism over a convex plan footprint given in wall-local coordinates (x along the
// wall, z across it) as [[x, z], ...] running along the +z side then back along the -z side,
// from y0 to y1. UVs are in meters: long faces (u = x, v = y), top/bottom (u = x, v = z),
// end faces (u = distance along the end edge, v = y). `faces` selects which faces to emit
// so a wall can hand its room-facing side to a different material: FACE_POS is the long
// +z face, FACE_NEG the long -z face, FACE_OTHER the ends, top and bottom.
export const FACE_POS = 1, FACE_NEG = 2, FACE_OTHER = 4, FACE_ALL = 7;
const FACE_END_A = 8, FACE_END_B = 16;
export function metricPrism(footprint, y0, y1, faces, edgeKinds) {
  if (faces == null) faces = FACE_ALL;
  const P = [], N = [], UV = [], I = [];
  let base = 0;
  const quad = (verts, n, uvs) => {
    for (let i = 0; i < 4; i++) { P.push(...verts[i]); N.push(...n); UV.push(...uvs[i]); }
    I.push(base, base + 1, base + 2, base, base + 2, base + 3);
    base += 4;
  };
  const n = footprint.length;
  for (let i = 0; i < n; i++) {
    const [ax, az] = footprint[i], [bx, bz] = footprint[(i + 1) % n];
    const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz);
    if (len < 1e-9) continue;
    const along = Math.abs(dz) < 1e-9;
    const kind = edgeKinds?.[i] ?? (along ? (dx > 0 ? FACE_POS : FACE_NEG) : FACE_OTHER);
    if (!(faces & kind)) continue;
    // Long faces keep u = x so the pattern runs unbroken across the pieces of a wall;
    // end faces measure u along their own edge.
    const ua = along ? ax : az, ub = along ? bx : az + (dz > 0 ? len : -len);
    quad([[ax, y0, az], [bx, y0, bz], [bx, y1, bz], [ax, y1, az]], [-dz / len, 0, dx / len],
      [[ua, y0], [ub, y0], [ub, y1], [ua, y1]]);
  }
  if (faces & FACE_OTHER) {
    // Top and bottom: fans over the convex footprint, the top facing +y.
    const tri = (order, y, ny) => {
      for (const j of order) { const [x, z] = footprint[j]; P.push(x, y, z); N.push(0, ny, 0); UV.push(x, z); }
      I.push(base, base + 1, base + 2);
      base += 3;
    };
    for (let i = 1; i + 1 < n; i++) { tri([0, i, i + 1], y1, 1); tri([0, i + 1, i], y0, -1); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2));
  g.setIndex(I);
  return g;
}

// Axis-aligned box from (x0,y0,z0) to (x1,y1,z1): a prism over a rectangle.
export function metricBox(x0, x1, y0, y1, z0, z1, faces) {
  return metricPrism([[x0, z1], [x1, z1], [x1, z0], [x0, z0]], y0, y1, faces);
}

function mergedMesh(geos, material, userData) {
  const live = geos.filter(g => g.index ? g.index.count > 0 : g.getAttribute('position').count > 0);
  for (const g of geos) if (!live.includes(g)) g.dispose();
  if (!live.length) return null;
  const g = live.length === 1 ? live[0] : mergeGeometries(live, false);
  if (live.length > 1) live.forEach(x => x.dispose());
  const m = new THREE.Mesh(g, material);
  m.castShadow = true; m.receiveShadow = true;
  m.userData = userData;
  return m;
}

// ---------- fixtures ----------
// One group per fixture (fixtures.js parts): a prism per part, merged by finish.
export function buildFixtureGroup(f, ctx) {
  const group = new THREE.Group();
  group.name = 'fixture:' + f.id;
  group.userData = { kind: 'fixture', id: f.id };
  const byFinish = new Map();
  for (const part of fixtureParts(f)) {
    if (part.pts.length < 3 || part.y1 - part.y0 < 1e-4) continue;
    let s = 0;
    for (let i = 0; i < part.pts.length; i++) { const [x1, z1] = part.pts[i], [x2, z2] = part.pts[(i + 1) % part.pts.length]; s += x1 * z2 - x2 * z1; }
    const key = (part.material || '') + '|' + part.role;
    if (!byFinish.has(key)) byFinish.set(key, { part, geos: [] });
    byFinish.get(key).geos.push(metricPrism(s > 0 ? part.pts.slice().reverse() : part.pts, part.y0, part.y1));   // metricPrism faces out for a clockwise ring
  }
  for (const { part, geos } of byFinish.values()) {
    const rough = part.role === 'top' ? 0.3 : part.role === 'appliance' ? 0.35 : 0.8;
    const m = mergedMesh(geos, matFor(part.material ? materialById(part.material) : null, FIXTURE_FALLBACK[part.role] || FIXTURE_FALLBACK.body, rough, ctx && ctx.matOpts), { kind: 'fixture', id: f.id });
    if (m) group.add(m);
  }
  return group;
}

// ---------- plan helpers ----------
// Room sides and the interior finish live in wall-solids.js (shared with the SketchUp mirror).
export { wallInteriorMaterialId };
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - ax - dx * t, py - ay - dy * t);
}

// ---------- wall joints ----------
function wallFrame(wall) {
  const L = Math.hypot(wall.bx - wall.ax, wall.by - wall.ay);
  const d = L || 1;
  const ux = (wall.bx - wall.ax) / d, uy = (wall.by - wall.ay) / d;
  return { L, ux, uy, nx: -uy, ny: ux, h: (wall.thickness || 0.114) / 2 };
}

// Parameter along (dx, dy) from (ax, ay) where that line meets the line through (bx, by)
// with direction (qx, qy); null when the lines are parallel.
function lineHit(ax, ay, dx, dy, bx, by, qx, qy) {
  const den = dx * qy - dy * qx;
  if (Math.abs(den) < 1e-6) return null;
  return ((bx - ax) * qy - (by - ay) * qx) / den;
}

// Two directions out of a shared point that run (nearly) opposite: one wall carrying on as the other.
function continues(ax, ay, bx, by) {
  return ax * bx + ay * by < 0 && Math.abs(ax * by - ay * bx) < COLLINEAR;
}

// Deterministic winner between two straight runs crossing at a point: thicker, then lower id,
// so both runs agree on which one passes through and which is cut at its face.
function outranks(p, q) {
  const tp = Math.max(p[0].thickness || 0.114, p[1].thickness || 0.114);
  const tq = Math.max(q[0].thickness || 0.114, q[1].thickness || 0.114);
  if (tp !== tq) return tp > tq;
  return [String(p[0].id), String(p[1].id)].sort()[0] < [String(q[0].id), String(q[1].id)].sort()[0];
}

// Close one end of a wall against the walls meeting it. Returns, in wall-local x, where the
// +z face (`pos`) and the -z face (`neg`) stop, plus `tip` (a local {x, z} between the two)
// when the end needs an extra corner: three or more walls meeting at a point, or a pair
// that jogs where we abut it. `inflate` thickens every wall by that much per side, which
// is how baseboards get mitres matching the faces they sit on.
function wallEnd(wall, end, walls, inflate) {
  inflate = inflate || 0;
  const f = wallFrame(wall);
  const h = f.h + inflate;
  const atStart = end === 'a';
  const px = atStart ? wall.ax : wall.bx, py = atStart ? wall.ay : wall.by;
  const dx = atStart ? -f.ux : f.ux, dy = atStart ? -f.uy : f.uy;   // outward along the axis
  const ex = -dx, ey = -dy;                                          // into this wall
  const local = (a) => atStart ? -a : f.L + a;
  // tip: [outward extension, local z] of an extra footprint vertex between the two face cuts.
  const result = (aPos, aNeg, tip) => ({ pos: local(aPos), neg: local(aNeg), tip: tip ? { x: local(tip[0]), z: tip[1] } : null });

  const joined = [], through = [];
  for (const o of walls) {
    if (o === wall || o.id === wall.id) continue;
    const g = wallFrame(o);
    if (g.L < 0.01) continue;
    const nearA = Math.hypot(o.ax - px, o.ay - py) < JOIN_TOL, nearB = Math.hypot(o.bx - px, o.by - py) < JOIN_TOL;
    if (nearA || nearB) {
      const s = nearA ? 1 : -1;
      const ix = g.ux * s, iy = g.uy * s;                             // from the joint into the neighbour
      if (ix * ex + iy * ey > 0 && Math.abs(ix * ey - iy * ex) < COLLINEAR) continue; // folds back over us
      joined.push({ o, g, ix, iy, cont: continues(ex, ey, ix, iy) });
    } else {
      // A wall running past our endpoint within its own thickness: we abut it mid-span.
      const t = (px - o.ax) * g.ux + (py - o.ay) * g.uy;
      const d = Math.abs((px - o.ax) * g.nx + (py - o.ay) * g.ny);
      if (t > JOIN_TOL && t < g.L - JOIN_TOL && d < g.h + JOIN_TOL) through.push({ o, g });
    }
  }

  // Where our face s (+1 / -1) meets face t of neighbour nb, as an outward extension.
  const hit = (s, nb, t, bury) => {
    const gh = nb.g.h + inflate;
    let a = lineHit(px + f.nx * h * s, py + f.ny * h * s, dx, dy,
      nb.o.ax + nb.g.nx * gh * t, nb.o.ay + nb.g.ny * gh * t, nb.g.ux, nb.g.uy);
    if (a == null) return 0;
    if (bury) a += EPS;                                   // stay a hair inside the wall we abut
    const reach = 6 * Math.max(f.h, nb.g.h);              // acute mitres run away: cap at three thicknesses
    return Math.max(-Math.min(reach, f.L * 0.45), Math.min(reach, a));
  };
  // Which of a corner neighbour's faces pairs with our face s: inner with inner, outer with outer.
  const pair = (s, nb) => s * Math.sign(f.nx * nb.ix + f.ny * nb.iy || 1) * Math.sign(nb.g.nx * ex + nb.g.ny * ey || 1);
  // The face of a passing wall on our side.
  const near = (nb) => Math.sign(nb.g.nx * ex + nb.g.ny * ey || 1);
  // Where face t of neighbour p meets face u of neighbour q, as [outward extension, local z].
  const meet = (p, t, q, u) => {
    const ph = p.g.h + inflate, qh = q.g.h + inflate;
    const ax = p.o.ax + p.g.nx * ph * t, ay = p.o.ay + p.g.ny * ph * t;
    const s = lineHit(ax, ay, p.g.ux, p.g.uy, q.o.ax + q.g.nx * qh * u, q.o.ay + q.g.ny * qh * u, q.g.ux, q.g.uy);
    if (s == null) return null;
    const qx = ax + p.g.ux * s - px, qy = ay + p.g.uy * s - py;
    return [qx * dx + qy * dy, qx * f.nx + qy * f.ny];
  };
  // Keep an extra vertex only if it sits within the wall's width and beyond the straight cut,
  // so the footprint stays convex.
  const beyond = (tip, aPos, aNeg) => {
    if (!tip || Math.abs(tip[1]) > h - 0.001) return null;
    const chord = aNeg + (tip[1] + h) / (2 * h) * (aPos - aNeg);
    return tip[0] > chord + 0.001 ? tip : null;
  };

  if (through.length) {
    const t = near(through[0]);
    return result(hit(1, through[0], t, true), hit(-1, through[0], t, true), null);
  }
  const corners = joined.filter(j => !j.cont);
  const conts = joined.filter(j => j.cont).sort((p, q) => Math.abs(p.ix * ey - p.iy * ex) - Math.abs(q.ix * ey - q.iy * ex));
  // Angular neighbours: the corner wall first met sweeping from our axis towards +z, and towards -z.
  for (const j of corners) j.phi = (Math.atan2(j.ix * f.nx + j.iy * f.ny, j.ix * ex + j.iy * ey) + 2 * Math.PI) % (2 * Math.PI);
  const posNb = corners.length ? corners.reduce((m, j) => j.phi < m.phi ? j : m) : null;
  const negNb = corners.length ? corners.reduce((m, j) => j.phi > m.phi ? j : m) : null;
  // A corner neighbour that carries straight on past the joint cuts us at its face.
  const passes = (nb) => joined.some(k => k !== nb && continues(nb.ix, nb.iy, k.ix, k.iy));

  if (conts.length) {
    const c = conts[0];
    // Two straight runs crossing here: the one that outranks passes, the other is cut.
    if (posNb && negNb && posNb !== negNb && continues(posNb.ix, posNb.iy, negNb.ix, negNb.iy) && outranks([posNb.o, negNb.o], [wall, c.o])) {
      return result(hit(1, posNb, pair(1, posNb), true), hit(-1, negNb, pair(-1, negNb), true), null);
    }
    // Straight on there is nothing to add; a slight jog mitres the faces by a few millimetres.
    return result(hit(1, c, pair(1, c), false), hit(-1, c, pair(-1, c), false), null);
  }
  if (!posNb) return result(0, 0, null);
  const buryPos = passes(posNb), buryNeg = passes(negNb);
  const tPos = pair(1, posNb), tNeg = pair(-1, negNb);
  const aPos = hit(1, posNb, tPos, buryPos), aNeg = hit(-1, negNb, tNeg, buryNeg);
  let tip = null;
  if (posNb !== negNb && !buryPos && !buryNeg) {
    // Three or more walls meeting at a point: the two face cuts leave a wedge in front of
    // the end; a tip on the centreline at the joint fills it, and the neighbours' tips meet it there.
    tip = [0, 0];
  } else if (posNb !== negNb && buryPos && buryNeg) {
    // Abutting a pair that jogs rather than runs straight: the end bends where the two
    // faces meet instead of cutting a straight line between them and leaving a notch.
    tip = meet(posNb, tPos, negNb, tNeg);
  }
  return result(aPos, aNeg, beyond(tip, aPos, aNeg));
}
function wallEnds(wall, walls, inflate) {
  return { a: wallEnd(wall, 'a', walls, inflate), b: wallEnd(wall, 'b', walls, inflate) };
}

// Where one face (side +1 / -1) of a solid piece starts and stops along the wall: pieces
// touching a wall end take that end's cut, the others keep their own span.
function faceSpan(s, L, ends, side) {
  const atA = s.s0 < 0.001, atB = s.s1 > L - 0.001;
  const e0 = side > 0 ? ends.a.pos : ends.a.neg, e1 = side > 0 ? ends.b.pos : ends.b.neg;
  return [atA ? Math.min(e0, s.s1 - 0.001) : s.s0, atB ? Math.max(e1, s.s0 + 0.001) : s.s1];
}
// Plan footprint of one solid piece in wall-local coords, in metricPrism order.
function solidFootprint(s, L, h, ends) {
  const [x0p, x1p] = faceSpan(s, L, ends, 1), [x0n, x1n] = faceSpan(s, L, ends, -1);
  const fp = [[x0p, h], [x1p, h]];
  if (s.s1 > L - 0.001 && ends.b.tip) fp.push([ends.b.tip.x, ends.b.tip.z]);
  fp.push([x1n, -h], [x0n, -h]);
  if (s.s0 < 0.001 && ends.a.tip) fp.push([ends.a.tip.x, ends.a.tip.z]);
  return fp;
}

// ---------- openings ----------
// Spans and solid pieces live in wall-solids.js (shared with the SketchUp mirror).
export { wallSolids };

// ---------- doors ----------
function buildDoor(o, s0, s1, top, th, sides, ctx) {
  const g = new THREE.Group();
  g.userData = { kind: 'opening', id: o.id, wallId: ctx.wall.id };
  // A plain opening has no frame: the wall's own returns and the header above are all there is.
  if (plainOpening(o)) return g;
  const trim = [];
  const w = s1 - s0;
  const tm = trimMat(ctx.matOpts);
  const proud = 0.008;
  const interior = !!(sides.pos && sides.neg);
  const detail = doorDetail(o, w, top, interior, sides);
  const { jambWidth: JAMB_W, casingWidth: CASING_W, casingDepth: CASING_D } = detail;
  g.userData.detailWarnings = detail.warnings;
  // Jambs and head inside the rough opening.
  trim.push(metricBox(s0, s0 + JAMB_W, 0, top, -th / 2 - proud, th / 2 + proud));
  trim.push(metricBox(s1 - JAMB_W, s1, 0, top, -th / 2 - proud, th / 2 + proud));
  trim.push(metricBox(s0 + JAMB_W, s1 - JAMB_W, top - JAMB_W, top, -th / 2 - proud, th / 2 + proud));
  // Casing on every side that faces a room.
  for (const sgn of [1, -1]) {
    if (!CASING_W || !CASING_D) continue;
    if (!(sgn > 0 ? sides.pos : sides.neg)) continue;
    const z0 = sgn > 0 ? th / 2 : -th / 2 - CASING_D, z1 = sgn > 0 ? th / 2 + CASING_D : -th / 2;
    trim.push(metricBox(s0 - CASING_W, s0 + 0.01, 0, top + CASING_W, z0, z1));
    trim.push(metricBox(s1 - 0.01, s1 + CASING_W, 0, top + CASING_W, z0, z1));
    trim.push(metricBox(s0 - CASING_W, s1 + CASING_W, top - 0.01, top + CASING_W, z0, z1));
  }
  const tmesh = mergedMesh(trim, tm, g.userData);
  if (tmesh) g.add(tmesh);

  const leaves = detail.leaves;      // 0: wide interior openings are cased, not hung
  if (leaves) {
    // A pair (French doors, a slider drawn as a door): each leaf hangs from its own jamb and
    // they meet in the middle, closed outside, both ajar to the same side inside; o.doorState
    // shuts or opens either kind (doorShownOpen). An open door swings into the room side.
    const pair = leaves === 2;
    const leafW = detail.leafWidth, leafH = detail.leafHeight;
    const swing = doorShownOpen(o, interior) ? -detail.swingSide * THREE.MathUtils.degToRad(25) : 0;
    if (pair || detail.hinge === 'start') g.add(doorLeaf(o, leafW, leafH, s0 + JAMB_W + 0.003, swing, ctx, detail));
    if (pair || detail.hinge === 'end') g.add(doorLeaf(o, leafW, leafH, s1 - JAMB_W - 0.003, Math.PI - swing, ctx, detail));
  }
  return g;
}

// One leaf on its hinge pivot: rotation 0 is closed, spanning +x from the pivot; Math.PI
// hangs it from the opposite jamb. In x-ray the leaf is a ghost slab with no hardware.
function doorLeaf(o, leafW, leafH, px, rotY, ctx, detail) {
  const LEAF_T = detail.leafThickness;
  const pivot = new THREE.Group();
  pivot.position.set(px, 0.01, 0);
  pivot.rotation.y = rotY;
  const ghost = !!(ctx.matOpts && ctx.matOpts.transparent);
  const leafFinish = detail.leafMaterial ? matFor(materialById(detail.leafMaterial), '#f1eee7', 0.45, ctx.matOpts) : flatMat('#f1eee7', 0.45, ctx.matOpts);
  const userData = { kind: 'opening', id: o.id, wallId: ctx.wall.id, noCollide: true };
  const glazing = ghost ? null : leafGlazing(doorGlass(o), leafW, leafH);
  if (glazing) {
    // A glazed leaf (o.glass): painted stiles and rails around a pane the sun shines through,
    // over a recessed solid panel when only the upper half is glass.
    const [gx0, gx1, gy0, gy1] = glazing.glass, h = LEAF_T / 2;
    const parts = [metricBox(0, gx0, 0, leafH, -h, h), metricBox(gx1, leafW, 0, leafH, -h, h),
      metricBox(gx0, gx1, gy1, leafH, -h, h), metricBox(gx0, gx1, 0, glazing.panel ? glazing.panel[2] : gy0, -h, h)];
    if (glazing.panel) {
      parts.push(metricBox(gx0, gx1, glazing.panel[3], gy0, -h, h));
      parts.push(metricBox(gx0, gx1, glazing.panel[2], glazing.panel[3], -h + 0.012, h - 0.012));
    }
    const frame = mergedMesh(parts, leafFinish, userData);
    frame.userData.leafWidth = leafW;
    pivot.add(frame);
    const glass = new THREE.Mesh(metricBox(gx0, gx1, gy0, gy1, -0.003, 0.003), ctx.glass || flatMat('#d2e7ee', 0.1, { transparent: true, opacity: 0.35 }));
    glass.userData = Object.assign({ glass: true }, userData);
    glass.castShadow = false; glass.receiveShadow = false;
    pivot.add(glass);
  } else if (!ghost && (o.detail?.door || o.profile) && detail.style === 'six-panel') {
    // Explicit construction uses actual recessed fields, including when the leaf has a
    // wood finish; a paint-only normal texture must not erase that recorded form.
    const mx = leafW * 24 / 256, my = leafH * 26 / 512, gx = leafW * 18 / 256, gy = leafH * 20 / 512;
    const usable = leafH - 2 * my - 2 * gy, half = (leafW - gx) / 2, h = LEAF_T / 2;
    const parts = [metricBox(0, mx, 0, leafH, -h, h), metricBox(leafW - mx, leafW, 0, leafH, -h, h), metricBox(half, half + gx, 0, leafH, -h, h)];
    let z = my, previous = 0;
    for (const proportion of [0.38, 0.38, 0.24]) {
      const top = z + usable * proportion;
      parts.push(metricBox(mx, leafW - mx, previous, z, -h, h));
      for (const [x0, x1] of [[mx, half], [half + gx, leafW - mx]]) parts.push(metricBox(x0, x1, z, top, -h + 0.004, h - 0.004));
      previous = top; z = top + gy;
    }
    parts.push(metricBox(mx, leafW - mx, previous, leafH, -h, h));
    const leaf = mergedMesh(parts, leafFinish, userData);
    leaf.userData.leafWidth = leafW; pivot.add(leaf);
  } else {
    const leaf = new THREE.Mesh(new THREE.BoxGeometry(leafW, leafH, LEAF_T), ghost || detail.leafMaterial || detail.style === 'slab' ? leafFinish : leafMaterials());
    leaf.position.set(leafW / 2, leafH / 2, 0);
    leaf.castShadow = true; leaf.receiveShadow = true;
    leaf.userData = userData;
    pivot.add(leaf);
  }
  if (ghost || detail.hardware === 'none') return pivot;
  // Handles, both faces, by the free edge.
  const mm = detail.hardwareFinish === 'brass' ? flatMat('#b29350', 0.3, { metalness: 0.85 })
    : detail.hardwareFinish === 'dark' ? flatMat('#332e29', 0.4, { metalness: 0.7 }) : metalMat();
  const knobMat = detail.hardwareFinish === 'glass' ? (ctx.glass || glassMat()) : mm;
  for (const sgn of [1, -1]) {
    const hx = leafW - detail.handleBackset, hy = Math.min(detail.handleHeight, leafH - 0.1);
    const rose = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.01, 24), mm);
    rose.rotation.x = Math.PI / 2;
    rose.position.set(hx, hy, sgn * (LEAF_T / 2 + 0.005));
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, 0.05, 16), mm);
    stem.rotation.x = Math.PI / 2;
    stem.position.set(hx, hy, sgn * (LEAF_T / 2 + 0.03));
    const handle = detail.hardware === 'knob'
      ? new THREE.Mesh(detail.knobShape === 'faceted' ? new THREE.IcosahedronGeometry(detail.knobRadius, 1) : new THREE.SphereGeometry(detail.knobRadius, 20, 12), knobMat)
      : new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.007, 0.12, 16), mm);
    if (detail.hardware === 'knob') handle.scale.z = 0.85; else handle.rotation.z = Math.PI / 2;
    handle.position.set(hx - (detail.hardware === 'knob' ? 0 : 0.055), hy, sgn * (LEAF_T / 2 + 0.05));
    handle.userData.hardware = detail.hardware;
    for (const p of [rose, stem, handle]) { p.castShadow = true; p.userData = { ...p.userData, ...userData }; pivot.add(p); }
  }
  return pivot;
}

// ---------- windows ----------
function buildWindow(o, s0, s1, v0, v1, th, sides, ctx) {
  const g = new THREE.Group();
  g.userData = { kind: 'opening', id: o.id, wallId: ctx.wall.id };
  const trim = [];
  const tm = trimMat(ctx.matOpts);
  const w = s1 - s0, h = v1 - v0;
  const detail = windowDetail(o, w, h);
  const { frameWidth: FRAME_W, sashWidth: SASH_W, muntinWidth: MULLION_W, casingWidth: CASING_W, casingDepth: CASING_D } = detail;
  const fz0 = -th / 2 - 0.005, fz1 = th / 2 + 0.005;
  // Outer frame.
  trim.push(metricBox(s0, s0 + FRAME_W, v0, v1, fz0, fz1));
  trim.push(metricBox(s1 - FRAME_W, s1, v0, v1, fz0, fz1));
  trim.push(metricBox(s0 + FRAME_W, s1 - FRAME_W, v1 - FRAME_W, v1, fz0, fz1));
  trim.push(metricBox(s0 + FRAME_W, s1 - FRAME_W, v0, v0 + FRAME_W, fz0, fz1));
  // Each double-hung sash has its own rails and grille. A clear lower sash must not
  // inherit the upper sash's grille, and the meeting rail is not a decorative muntin.
  const sx0 = s0 + FRAME_W, sx1 = s1 - FRAME_W, sy0 = v0 + FRAME_W, sy1 = v1 - FRAME_W;
  const panes = [];
  const sash = (y0, y1, z, grid) => {
    const sz0 = z - 0.024, sz1 = z + 0.024;
    trim.push(metricBox(sx0, sx0 + SASH_W, y0, y1, sz0, sz1));
    trim.push(metricBox(sx1 - SASH_W, sx1, y0, y1, sz0, sz1));
    trim.push(metricBox(sx0 + SASH_W, sx1 - SASH_W, y1 - SASH_W, y1, sz0, sz1));
    trim.push(metricBox(sx0 + SASH_W, sx1 - SASH_W, y0, y0 + SASH_W, sz0, sz1));
    const gx0 = sx0 + SASH_W, gx1 = sx1 - SASH_W, gy0 = y0 + SASH_W, gy1 = y1 - SASH_W;
    if (gx1 <= gx0 || gy1 <= gy0) return;
    for (let c = 1; c < grid.columns; c++) {
      const x = gx0 + (gx1 - gx0) * c / grid.columns;
      trim.push(metricBox(x - MULLION_W / 2, x + MULLION_W / 2, gy0, gy1, z - 0.016, z + 0.016));
    }
    for (let r = 1; r < grid.rows; r++) {
      const y = gy0 + (gy1 - gy0) * r / grid.rows;
      trim.push(metricBox(gx0, gx1, y - MULLION_W / 2, y + MULLION_W / 2, z - 0.016, z + 0.016));
    }
    panes.push({ gx0, gx1, gy0, gy1, z });
  };
  const inSide = sides.pos ? 1 : (sides.neg ? -1 : 1);
  if (detail.type === 'double-hung') {
    const mid = (sy0 + sy1) / 2;
    sash(sy0, mid + SASH_W / 2, inSide * 0.025, detail.lower);
    sash(mid - SASH_W / 2, sy1, -inSide * 0.025, detail.upper);
  } else sash(sy0, sy1, 0, detail);
  // Stool, apron and casing on the room side; sill outside.
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
  // Separate glazing planes for separate sashes; grids are part of their corresponding sash.
  for (const { gx0, gx1, gy0, gy1, z } of panes) {
    const glass = new THREE.Mesh(metricBox(gx0, gx1, gy0, gy1, z - 0.003, z + 0.003), ctx.glass);
    glass.userData = { kind: 'opening', id: o.id, wallId: ctx.wall.id, glass: true };
    glass.castShadow = false; glass.receiveShadow = false;
    g.add(glass);
  }
  return g;
}

// ---------- walls ----------
// `property` is the level view the wall sits on: { walls, rooms, wallHeight } for that level
// (buildPropertyGroup makes one per level), so joints and room faces only consider neighbours
// on the same storey. Local y runs from the level's floor; the level group carries the elevation.
export function buildWallGroup(wall, openings, property, ctx) {
  ctx = ctx || {};
  const { solids, L, H } = wallSolids(wall, openings, property.wallHeight || 2.44);
  const group = new THREE.Group();
  group.userData = { kind: 'wall', id: wall.id };
  if (L < 0.01) return group;

  const f = wallFrame(wall);
  group.position.set(wall.ax, 0, wall.ay);
  group.rotation.y = -Math.atan2(f.uy, f.ux);
  const th = wall.thickness || 0.114, h = th / 2;
  const rooms = property.rooms || [];
  const sides = wallSides(wall, rooms);
  const walls = property.walls || [];
  const ends = wallEnds(wall, walls, 0);
  // Stagger wall tops by a fifth of a millimetre per wall, cycling every ten, so any two
  // coplanar tops that still meet (walls drawn across each other) never fight; joined
  // ends are mitred or cut, so on a clean plan nothing overlaps in the first place.
  const lift = ((ctx.index || 0) % 10) * 0.0002;

  // Each face's finish (wall-solids.js wallFaceMaterialIds, shared with the SketchUp mirror):
  // its own if set, else the interior finish where it looks into a room, the exterior grey on an
  // exterior wall's unrecorded outside, and the interior finish on ends, top and reveals.
  const faceIds = wallFaceMaterialIds(wall, rooms);
  const mats = new Map();
  const matOf = id => {
    if (!mats.has(id)) mats.set(id, matFor(materialById(id), FALLBACK_WALL, 0.9, ctx.matOpts));
    return mats.get(id);
  };
  // One mesh per distinct material, each taking the faces that wear it.
  const buckets = [];
  const bucket = (mat, mask) => {
    let b = buckets.find(x => x.mat === mat);
    if (!b) buckets.push(b = { mat, mask: 0, geos: [] });
    b.mask |= mask;
  };
  bucket(matOf(faceIds.other), FACE_OTHER);
  bucket(matOf(faceIds.pos), FACE_POS);
  bucket(matOf(faceIds.neg), FACE_NEG);
  if (faceIds.endA) bucket(matOf(faceIds.endA), FACE_END_A);
  if (faceIds.endB) bucket(matOf(faceIds.endB), FACE_END_B);

  const baseGeos = [];
  const baseEnds = new Map();
  const endsAtDepth = depth => {
    if (!baseEnds.has(depth)) baseEnds.set(depth, wallEnds(wall, walls, depth));
    return baseEnds.get(depth);
  };
  for (const s of solids) {
    const fp = solidFootprint(s, L, h, ends);
    // The footprint runs A+ -> B+ -> optional B tip -> B- -> A- -> optional A tip.
    // Only pieces that reach a real wall endpoint get its override; the vertical
    // edges at an opening remain ordinary reveals, even when their normal matches.
    const atA = s.s0 < 0.001, atB = s.s1 > L - 0.001;
    const negEdge = 2 + (atB && ends.b.tip ? 1 : 0);
    const edgeKinds = fp.map((_, i) => i > 0 && i < negEdge && atB && faceIds.endB ? FACE_END_B
      : i > negEdge && atA && faceIds.endA ? FACE_END_A : undefined);
    const y1 = s.v1 >= H - 0.001 ? H + lift : s.v1;
    for (const b of buckets) b.geos.push(metricPrism(fp, s.v0, y1, b.mask, edgeKinds));
    if (s.v0 < 0.001) {
      // Baseboard on every face that borders a room, only on floor-touching pieces, its
      // ends mitred like the face it sits on so it meets the neighbour's baseboard.
      for (const sgn of [1, -1]) {
        if (!(sgn > 0 ? sides.pos : sides.neg)) continue;
        const detail = baseboardDetail(wall, sgn);
        detail.height = Math.min(detail.height, s.v1);
        detail.radius = Math.min(detail.radius, detail.height);
        if (!detail.height || !detail.depth) continue;
        const [i0, i1] = faceSpan(s, L, ends, sgn), zi = sgn * h;
        const footprint = depth => {
          const [o0, o1] = faceSpan(s, L, endsAtDepth(depth), sgn), zo = sgn * (h + depth);
          return sgn > 0 ? [[o0, zo], [o1, zo], [i1, zi], [i0, zi]] : [[i0, zi], [i1, zi], [o1, zo], [o0, zo]];
        };
        if (detail.profile === 'rectangular') baseGeos.push(metricPrism(footprint(detail.depth), 0, detail.height));
        else {
          const { height, depth, radius } = detail;
          baseGeos.push(metricPrism(footprint(depth), 0, height - radius));
          for (let band = 0; band < 4; band++) {
            const a = band * Math.PI / 8, b = (band + 1) * Math.PI / 8;
            const low = footprint(depth - radius + radius * Math.cos(a)), high = footprint(depth - radius + radius * Math.cos(b));
            const y0 = height - radius + radius * Math.sin(a), y1 = height - radius + radius * Math.sin(b);
            const geo = metricPrism(low, y0, y1), pos = geo.getAttribute('position');
            // Loft matching footprints so the outside top edge rounds back toward the wall.
            for (let v = 0; v < pos.count; v++) if (Math.abs(pos.getY(v) - y1) < 1e-6) {
              const k = low.findIndex(([x, z]) => pos.getX(v) === Math.fround(x) && pos.getZ(v) === Math.fround(z));
              if (k >= 0) pos.setXYZ(v, high[k][0], y1, high[k][1]);
            }
            geo.computeVertexNormals(); baseGeos.push(geo);
          }
        }
      }
    }
  }
  for (const b of buckets) {
    const m = mergedMesh(b.geos, b.mat, { kind: 'wall', id: wall.id });
    if (m) group.add(m);
  }
  const baseMesh = mergedMesh(baseGeos, trimMat(ctx.matOpts), { kind: 'wall', id: wall.id });
  if (baseMesh) group.add(baseMesh);

  // Openings, on the same clipped spans the solids were cut around.
  for (const { s0, s1, o } of openingSpans(wall, openings, L)) {
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
  const geo = new THREE.ExtrudeGeometry(roomShape(room), { depth: FLOOR_T, bevelEnabled: false });
  // Shape lies in XY; rotate so plan-y becomes world-z, extrusion goes down from the level's
  // height, where the floor's top is. UVs stay in meters.
  geo.rotateX(Math.PI / 2);
  const mat = matFor(materialById(room.material), FALLBACK_FLOOR, 0.85, ctx && ctx.matOpts);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true; mesh.castShadow = true;
  mesh.userData = { kind: 'room', id: room.id, ...(room.thresholdOf ? { inferredThreshold: true } : {}) };
  const group = new THREE.Group();
  group.userData = { kind: 'room', id: room.id };
  group.add(mesh);
  return group;
}

// Backward-compatible public signature for callers using three arrays; all consumers
// use the same exact gap subtraction, so an already continuous floor is never doubled.
export function thresholdFloors(walls, openings, rooms) {
  if (!Array.isArray(walls)) return derivedThresholdFloors(walls);
  return derivedThresholdFloors({ walls, openings, rooms })
    .sort((a, b) => rooms.findIndex(r => r.id === a.roomId) - rooms.findIndex(r => r.id === b.roomId))
    .map(patch => ({ ...patch, id: patch.roomId, thresholdOf: patch.openingId }));
}

export function buildRoomCeiling(room, H, ctx) {
  if (!room.pts || room.pts.length < 3) return null;
  H = Number.isFinite(room.ceilingHeight) && room.ceilingHeight > 0 ? room.ceilingHeight : H;
  const geo = new THREE.ExtrudeGeometry(roomShape(room), { depth: CEILING_T, bevelEnabled: false });
  geo.rotateX(Math.PI / 2);
  const mesh = new THREE.Mesh(geo, ceilingMat(room.ceilingMaterial, ctx && ctx.matOpts));
  mesh.position.y = H + CEILING_T;               // H is the finished underside, not the slab top
  mesh.receiveShadow = true; mesh.castShadow = true;
  mesh.userData = { kind: 'ceiling', id: room.id };
  return mesh;
}

// A point safely inside a room polygon (plan coords): the area centroid when it lies inside
// with some clearance, otherwise the interior point farthest from every edge. The vertex
// average lands in the notch of an L-shaped room, i.e. outside it or in the room next door.
export function roomInteriorPoint(pts) {
  const n = pts.length;
  let ax = 0, ay = 0, area = 0, cx = 0, cy = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    const w = xj * yi - xi * yj;
    area += w; cx += (xj + xi) * w; cy += (yj + yi) * w;
    ax += xi; ay += yi;
  }
  if (Math.abs(area) < 1e-9) return { x: ax / n, y: ay / n };
  cx /= 3 * area; cy /= 3 * area;
  const clearance = (x, y) => {
    let d = Infinity;
    for (let i = 0, j = n - 1; i < n; j = i++) d = Math.min(d, segDist(x, y, pts[j][0], pts[j][1], pts[i][0], pts[i][1]));
    return d;
  };
  if (pointInPoly(cx, cy, pts) && clearance(cx, cy) > 0.2) return { x: cx, y: cy };
  // Pole of inaccessibility: a coarse grid over the bounding box, refined around the best cell.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  let best = null, bestD = -1;
  const sample = (x0, y0, x1, y1, steps) => {
    for (let i = 0; i < steps; i++) for (let j = 0; j < steps; j++) {
      const x = x0 + (x1 - x0) * (i + 0.5) / steps, y = y0 + (y1 - y0) * (j + 0.5) / steps;
      if (!pointInPoly(x, y, pts)) continue;
      const d = clearance(x, y);
      if (d > bestD) { bestD = d; best = { x, y }; }
    }
  };
  sample(minX, minY, maxX, maxY, 24);
  if (best) {
    const r = Math.max(maxX - minX, maxY - minY) / 24;
    sample(best.x - r, best.y - r, best.x + r, best.y + r, 12);
  }
  return best || { x: cx, y: cy };
}

// One entry per room with a point inside it (plan coords) and where its level sits in world
// Y: `y` is the floor, `top` the ceiling, so a lamp or a label can hang at the right height.
export function roomCentres(property) {
  const out = [];
  for (const r of property.rooms || []) {
    if (!r.pts || r.pts.length < 3) continue;
    const p = roomInteriorPoint(r.pts);
    const lvl = levelOfRoom(property, r);
    out.push({ id: r.id, name: r.name, x: p.x, z: p.y, level: lvl.id, y: lvl.elevation, top: lvl.elevation + (Number.isFinite(r.ceilingHeight) && r.ceilingHeight > 0 ? r.ceilingHeight : levelHeight(property, lvl.id)) });
  }
  return out;
}

// ---------- property ----------
// opts: { xray: bool, xrayOpacity: number, hiddenLevels: Set of level ids }
// One group per level, lifted to its elevation, holding that level's floors, walls and a
// ceilings group; element groups keep their { kind, id } userData for picking. The root's
// userData lists the levels ({ id, name, group, ceilings, elevation, top }) and the shared glass.
export function buildPropertyGroup(property, opts) {
  opts = opts || {};
  if (!Array.isArray(property.levels) || !property.levels.length) ensureLevels(property);
  const root = new THREE.Group();
  root.name = 'property';
  const glass = glassMat();
  const ctx = { glass };
  const hidden = opts.hiddenLevels || null;
  const levels = [];

  for (const lvl of property.levels) {
    const H = levelHeight(property, lvl.id);
    const view = { walls: wallsOn(property, lvl.id), rooms: roomsOn(property, lvl.id), wallHeight: H };
    const openings = openingsOn(property, lvl.id);
    const lg = new THREE.Group();
    lg.name = 'level:' + lvl.id;
    lg.userData = { kind: 'level', id: lvl.id, name: lvl.name };
    lg.position.y = lvl.elevation;
    lg.visible = !(hidden && hidden.has(lvl.id));

    for (const room of view.rooms) {
      const g = buildRoomFloor(room, ctx);
      if (g) lg.add(g);
    }
    for (const patch of derivedThresholdFloors({ ...view, openings })) {
      const floor = buildRoomFloor({ ...patch, id: patch.roomId, thresholdOf: patch.openingId }, ctx);
      if (floor) { floor.userData.threshold = patch.openingId; lg.add(floor); }
    }
    view.walls.forEach((wall, index) => {
      lg.add(buildWallGroup(wall, openings, view, Object.assign({ index }, ctx)));
    });
    for (const f of fixturesOn(property, lvl.id)) lg.add(buildFixtureGroup(f, ctx));
    const ceilings = new THREE.Group();
    ceilings.name = 'ceilings';
    ceilings.userData = { ceilings: true, level: lvl.id };
    for (const room of view.rooms) {
      const m = buildRoomCeiling(room, H, ctx);
      if (m) ceilings.add(m);
    }
    lg.add(ceilings);
    lg.userData.ceilings = ceilings;
    lg.userData.top = lvl.elevation + H;
    root.add(lg);
    levels.push({ id: lvl.id, name: lvl.name, group: lg, ceilings, elevation: lvl.elevation, top: lvl.elevation + H });
  }
  root.userData = { levels, glass };
  // Hidden tags hide their elements (tags.js); `opts.tags` is a viewport's own visibility, and
  // false builds everything shown (exports carry hidden tags too).
  if (opts.tags !== false && Array.isArray(property.tags)) applyPlanTagVisibility(property, root, opts.tags || null);
  if (opts.xray) setModelXray(root, opts.xrayOpacity ?? 0.35);
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
// The ground lies 2 mm under the ground-level floors' tops. Drawn a fixed few depth steps further
// back than it is, it never shows through a floor from far away, where 2 mm is finer than the
// depth buffer. No slope factor: that pushes the ground back by centimetres at a shallow angle,
// and what lies just under the ground then shows through it.
const GROUND_BEHIND = { polygonOffset: true, polygonOffsetFactor: 0, polygonOffsetUnits: 8 };

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
    ? localMat('ground-studio', () => new THREE.MeshStandardMaterial({ color: 0x1c2229, roughness: 0.85, metalness: 0, ...GROUND_BEHIND }))
    : localMat('ground', () => new THREE.MeshStandardMaterial({ map: tex, roughness: 1, metalness: 0, ...GROUND_BEHIND }));
  if (mat.map) mat.map.repeat.set(1 / 3, 1 / 3);
  const disc = new THREE.Mesh(geo, mat);
  disc.position.set(cx, -0.002, cz);
  disc.receiveShadow = true;
  disc.userData = { kind: 'ground' };
  group.add(disc);
  if (opts.showGrid) {
    const size = Math.ceil(span * 2 / 2) * 2 + 8;
    const grid = new THREE.GridHelper(size, size, 0x2e3c48, 0x2a343d);
    grid.position.set(Math.round(cx), -0.001, Math.round(cz));     // over the ground, under the floors
    grid.material.transparent = true; grid.material.opacity = 0.55;
    grid.userData = { kind: 'grid', local: true };
    group.add(grid);
  }
  return group;
}

// Plan-space quads (4 corners, world x/z) covering every wall solid that a horizontal cut at
// world `height` passes through, on every level the cut runs through (a wall spans its level's
// elevation to elevation + height); the viewer draws these as dark section caps over the
// clipped walls. opts.hiddenLevels (Set of level ids) leaves those levels out.
export function wallCapRects(property, height, opts) {
  const rects = [];
  if (!Array.isArray(property.levels) || !property.levels.length) ensureLevels(property);
  const hidden = opts && opts.hiddenLevels;
  for (const lvl of property.levels) {
    if (hidden && hidden.has(lvl.id)) continue;
    const local = height - lvl.elevation;           // cut height in the level's own frame
    const H = levelHeight(property, lvl.id);
    if (local < 0 || local > H) continue;
    const walls = wallsOn(property, lvl.id);
    const openings = openingsOn(property, lvl.id);
    for (const wall of walls) {
      const { solids, L } = wallSolids(wall, openings, H);
      if (L < 0.01) continue;
      const f = wallFrame(wall);
      const ends = wallEnds(wall, walls, 0);
      for (const s of solids) {
        if (s.v0 > local || s.v1 < local) continue;
        const fp = solidFootprint(s, L, f.h, ends).map(([x, z]) => [wall.ax + f.ux * x + f.nx * z, wall.ay + f.uy * x + f.ny * z]);
        // The viewer draws four-corner quads: fan a pointed footprint into quads, repeating the last corner.
        for (let i = 1; i + 1 < fp.length; i += 2) rects.push([fp[0], fp[i], fp[i + 1], fp[Math.min(i + 2, fp.length - 1)]]);
      }
    }
  }
  return rects;
}

// The same caps for a cut along any plane: one polygon ([x, y, z] world corners, in order) for
// every wall solid the plane n . p = d passes through. Each solid is an upright prism (its plan
// footprint standing from the bottom to the top of the piece), so its cut is one convex polygon.
export function wallCapPolygons(property, n, d, opts) {
  const polys = [];
  if (!Array.isArray(property.levels) || !property.levels.length) ensureLevels(property);
  const hidden = opts && opts.hiddenLevels;
  for (const lvl of property.levels) {
    if (hidden && hidden.has(lvl.id)) continue;
    const H = levelHeight(property, lvl.id);
    const walls = wallsOn(property, lvl.id);
    const openings = openingsOn(property, lvl.id);
    for (const wall of walls) {
      const { solids, L } = wallSolids(wall, openings, H);
      if (L < 0.01) continue;
      const f = wallFrame(wall);
      const ends = wallEnds(wall, walls, 0);
      for (const s of solids) {
        const fp = solidFootprint(s, L, f.h, ends).map(([x, z]) => [wall.ax + f.ux * x + f.nx * z, wall.ay + f.uy * x + f.ny * z]);
        const poly = cutPrism(fp, lvl.elevation + s.v0, lvl.elevation + s.v1, n, d);
        if (poly) polys.push(poly);
      }
    }
  }
  return polys;
}

// Extent of the traced model in plan. The floorplan underlay only counts when there is
// nothing else to frame (or with opts.plan), so a scanned sheet with wide margins does not
// push the house off-centre or coarsen its shadows.
export function modelBounds(property, opts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const eat = (x, y) => {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  };
  for (const w of property.walls || []) { eat(w.ax, w.ay); eat(w.bx, w.by); }
  for (const r of property.rooms || []) for (const [x, y] of r.pts || []) eat(x, y);
  if (minX === Infinity || (opts && opts.plan)) {
    // Underlays live on the levels (and on the property itself in pre-level data).
    const plans = (property.levels || []).map(l => l && l.plan).concat([property.plan]);
    for (const pl of plans) {
      if (!pl || !pl.img) continue;
      eat(pl.offsetX || 0, pl.offsetY || 0);
      eat((pl.offsetX || 0) + pl.imgW * pl.mPerPx, (pl.offsetY || 0) + pl.imgH * pl.mPerPx);
    }
  }
  if (minX === Infinity) return { minX: -5, minY: -5, maxX: 5, maxY: 5 };
  return { minX, minY, maxX, maxY };
}

// Dispose geometries and the materials this module created for one build.
// Shared materials (textures.js cache, module-level fallbacks) are left alone.
export function disposeBuilt(obj) {
  setModelXray(obj, null);
  obj.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    for (const m of mats) if (m.userData && m.userData.disposable) m.dispose();
  });
}
