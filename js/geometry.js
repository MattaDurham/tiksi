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

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { materialById, ensureLevels, levelHeight, levelOfRoom, wallsOn, roomsOn, openingsOn } from './store.js';
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
export function metricPrism(footprint, y0, y1, faces) {
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
    const kind = along ? (dx > 0 ? FACE_POS : FACE_NEG) : FACE_OTHER;
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

// ---------- plan helpers ----------
function pointInPoly(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - ax - dx * t, py - ay - dy * t);
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
// The openings on one wall as spans along it: clamped to the wall, never overlapping an
// earlier opening (the later one gives way), too-narrow leftovers dropped. Solids and trim
// are both cut from these so they always agree.
function openingSpans(wall, openings, L) {
  const spans = openings
    .filter(o => o.wallId === wall.id)
    .map(o => {
      const w = Math.min(o.width || 0, L);
      const c = Math.min(Math.max((o.t || 0) * L, w / 2), L - w / 2);
      return { s0: Math.max(0, c - w / 2), s1: Math.min(L, c + w / 2), o };
    })
    .sort((a, b) => a.s0 - b.s0);
  const out = [];
  let cursor = 0;
  for (const sp of spans) {
    sp.s0 = Math.max(sp.s0, cursor);
    if (sp.s1 - sp.s0 < 0.05) continue;
    out.push(sp);
    cursor = sp.s1;
  }
  return out;
}

// Solid pieces of one wall in local coords: s along wall [0..L], v vertical [0..H].
export function wallSolids(wall, openings, defaultHeight) {
  const L = Math.hypot(wall.bx - wall.ax, wall.by - wall.ay);
  const H = wall.height || defaultHeight;
  if (L < 0.01) return { solids: [], glass: [], L, H };

  const solids = [];
  const glass = [];
  let cursor = 0;
  for (const { s0, s1, o } of openingSpans(wall, openings, L)) {
    if (s0 > cursor + 0.005) solids.push({ s0: cursor, s1: s0, v0: 0, v1: H });
    const top = Math.min((o.type === 'window' ? (o.sill || 0) + o.height : o.height), H);
    if (top < H - 0.01) solids.push({ s0, s1, v0: top, v1: H });          // header
    if (o.type === 'window' && (o.sill || 0) > 0.01) solids.push({ s0, s1, v0: 0, v1: o.sill }); // sill wall below
    if (o.type === 'window') glass.push({ s0, s1, v0: (o.sill || 0), v1: top, id: o.id });
    cursor = s1;
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
  const archway = w > 1.25 && interior;           // wide interior openings are cased, not hung
  if (!archway) {
    // A wide door to the outside is a pair (French doors, a slider drawn as a door): each
    // leaf hangs from its own jamb and they meet closed in the middle.
    const pair = w > 1.25;
    const leafW = pair ? (w - JAMB_W * 2 - 0.009) / 2 : w - JAMB_W * 2 - 0.006;
    const leafH = top - JAMB_W - 0.012;
    const swingSide = sides.pos ? 1 : -1;
    const swing = interior ? -swingSide * THREE.MathUtils.degToRad(25) : 0;
    g.add(doorLeaf(o, leafW, leafH, s0 + JAMB_W + 0.003, swing, ctx));
    if (pair) g.add(doorLeaf(o, leafW, leafH, s1 - JAMB_W - 0.003, Math.PI, ctx));
  }
  return g;
}

// One leaf on its hinge pivot: rotation 0 is closed, spanning +x from the pivot; Math.PI
// hangs it from the opposite jamb. In x-ray the leaf is a ghost slab with no hardware.
function doorLeaf(o, leafW, leafH, px, rotY, ctx) {
  const pivot = new THREE.Group();
  pivot.position.set(px, 0.01, 0);
  pivot.rotation.y = rotY;
  const ghost = !!(ctx.matOpts && ctx.matOpts.transparent);
  const leaf = new THREE.Mesh(new THREE.BoxGeometry(leafW, leafH, LEAF_T), ghost ? flatMat('#f1eee7', 0.45, ctx.matOpts) : leafMaterials());
  leaf.position.set(leafW / 2, leafH / 2, 0);
  leaf.castShadow = true; leaf.receiveShadow = true;
  leaf.userData = { kind: 'opening', id: o.id, wallId: ctx.wall.id, noCollide: true };
  pivot.add(leaf);
  if (ghost) return pivot;
  // Lever handles, both faces, by the free edge.
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
  return pivot;
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

  const outMat = matFor(materialById(wall.material), FALLBACK_WALL, 0.9, ctx.matOpts);
  // Faces that look into a room take the interior finish: an explicit one, else drywall on
  // an exterior wall (a room on one side only) and the wall's own finish on a partition.
  const exterior = !!sides.pos !== !!sides.neg;
  const inId = wall.materialIn || (exterior ? 'mat-drywall' : wall.material);
  const inMat = (sides.pos || sides.neg) && inId !== wall.material
    ? matFor(materialById(inId), FALLBACK_WALL, 0.9, ctx.matOpts) : outMat;
  // One mesh per distinct material, each taking the faces that wear it.
  const buckets = [];
  const bucket = (mat, mask) => {
    let b = buckets.find(x => x.mat === mat);
    if (!b) buckets.push(b = { mat, mask: 0, geos: [] });
    b.mask |= mask;
  };
  bucket(outMat, FACE_OTHER);
  bucket(sides.pos ? inMat : outMat, FACE_POS);
  bucket(sides.neg ? inMat : outMat, FACE_NEG);

  const baseGeos = [];
  let baseEnds = null;
  for (const s of solids) {
    const fp = solidFootprint(s, L, h, ends);
    const y1 = s.v1 >= H - 0.001 ? H + lift : s.v1;
    for (const b of buckets) b.geos.push(metricPrism(fp, s.v0, y1, b.mask));
    if (s.v0 < 0.001) {
      // Baseboard on every face that borders a room, only on floor-touching pieces, its
      // ends mitred like the face it sits on so it meets the neighbour's baseboard.
      baseEnds = baseEnds || wallEnds(wall, walls, BASEBOARD_D);
      for (const sgn of [1, -1]) {
        if (!(sgn > 0 ? sides.pos : sides.neg)) continue;
        const [i0, i1] = faceSpan(s, L, ends, sgn), [o0, o1] = faceSpan(s, L, baseEnds, sgn);
        const zi = sgn * h, zo = sgn * (h + BASEBOARD_D);
        const bfp = sgn > 0 ? [[o0, zo], [o1, zo], [i1, zi], [i0, zi]] : [[i0, zi], [i1, zi], [o1, zo], [o0, zo]];
        baseGeos.push(metricPrism(bfp, 0.06, 0.06 + BASEBOARD_H));
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
    out.push({ id: r.id, name: r.name, x: p.x, z: p.y, level: lvl.id, y: lvl.elevation, top: lvl.elevation + levelHeight(property, lvl.id) });
  }
  return out;
}

// ---------- property ----------
// opts: { xray: bool, hiddenLevels: Set of level ids }
// One group per level, lifted to its elevation, holding that level's floors, walls and a
// ceilings group; element groups keep their { kind, id } userData for picking. The root's
// userData lists the levels ({ id, name, group, ceilings, elevation, top }) and the shared glass.
export function buildPropertyGroup(property, opts) {
  opts = opts || {};
  if (!Array.isArray(property.levels) || !property.levels.length) ensureLevels(property);
  const root = new THREE.Group();
  root.name = 'property';
  const matOpts = opts.xray ? { transparent: true, opacity: 0.35 } : undefined;
  const glass = glassMat();
  if (opts.xray) { glass.transmission = 0; glass.opacity = 0.25; }
  const ctx = { matOpts, glass };
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
    view.walls.forEach((wall, index) => {
      lg.add(buildWallGroup(wall, openings, view, Object.assign({ index }, ctx)));
    });
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
  obj.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    for (const m of mats) if (m.userData && m.userData.disposable) m.dispose();
  });
}
