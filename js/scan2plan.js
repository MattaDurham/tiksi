// Scan to plan: turn a metric, gravity-aligned mesh (a Polycam or Scaniverse room capture,
// or any OBJ/GLB of an interior) into the plan data the rest of the console edits.
//
// The method is a surveyor's, not a neural net's: find the floor and ceiling as the two big
// horizontal planes, cut the mesh with horizontal planes at a few heights, square the scan
// up to its dominant wall direction, rasterise the cuts into occupancy grids, read wall
// faces off the grids as long straight runs, pair the two faces of a partition into one
// wall with its real thickness, flood the floor to find rooms, and classify the gaps in a
// wall's mid-height profile as doors (open to the floor) or windows (wall below the sill).
// A top-down orthographic render of the aligned mesh becomes the calibrated plan underlay,
// so tracing corrections happen over the scan itself.
//
// Everything works in the mesh's own frame first; the result carries the transform
// (rotation about y, translation) that the scan record and the render both use, so the
// scan, the underlay and the proposed walls land on top of each other in PLAN and MODEL.

import * as THREE from 'three';
import { uid, touch } from './store.js';
import { loadMesh } from './scans.js';

// Section heights above the detected floor. `top` is capped below a low ceiling.
const SECTION = { low: 0.35, sill: 0.8, mid: 1.25, high: 1.75, top: 2.15 };
const CELL = 0.025;                 // occupancy grid resolution, meters
const INT_THICK = 0.114;            // default thickness for a wall seen from one side only
const DOOR_H = 2.032, WIN_H = 1.219;
const MAX_TRIANGLES = 4000000;      // beyond this the analysis subsamples triangles

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// ---------- triangles ----------
// Flat [x0,y0,z0, x1,y1,z1, x2,y2,z2, ...] in the root's frame (root.matrixWorld ignored).
export function gatherTriangles(root) {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const chunks = [];
  let total = 0;
  root.traverse(o => {
    if (!o.isMesh || !o.geometry) return;
    const pos = o.geometry.getAttribute('position');
    if (!pos) return;
    const idx = o.geometry.index ? o.geometry.index.array : null;
    const n = Math.floor(idx ? idx.length / 3 : pos.count / 3);
    if (!n) return;
    chunks.push({ pos, idx, n, m: new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld) });
    total += n;
  });
  const stride = Math.max(1, Math.ceil(total / MAX_TRIANGLES));
  const count = Math.floor(total / stride);
  const tri = new Float32Array(count * 9);
  const v = new THREE.Vector3();
  let k = 0, seen = 0;
  for (const c of chunks) {
    for (let i = 0; i < c.n; i++, seen++) {
      if (seen % stride) continue;
      if (k >= count * 9) break;
      for (let j = 0; j < 3; j++) {
        const vi = c.idx ? c.idx[i * 3 + j] : i * 3 + j;
        v.fromBufferAttribute(c.pos, vi).applyMatrix4(c.m);
        tri[k++] = v.x; tri[k++] = v.y; tri[k++] = v.z;
      }
    }
  }
  return { tri, count: Math.floor(k / 9) };
}

// ---------- floor and ceiling ----------
// Area-weighted histogram of near-horizontal triangles by height. The floor is the lowest
// strong peak, the ceiling the highest strong peak at least two meters above it.
export function findLevels(tri, count) {
  const BIN = 0.02;
  let minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < count; i++) {
    for (let j = 1; j < 9; j += 3) { const y = tri[i * 9 + j]; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  }
  if (!(maxY > minY)) return null;
  const nb = Math.ceil((maxY - minY) / BIN) + 2;
  const hist = new Float64Array(nb);
  let flatArea = 0;
  for (let i = 0; i < count; i++) {
    const o = i * 9;
    const ax = tri[o], ay = tri[o + 1], az = tri[o + 2];
    const e1x = tri[o + 3] - ax, e1y = tri[o + 4] - ay, e1z = tri[o + 5] - az;
    const e2x = tri[o + 6] - ax, e2y = tri[o + 7] - ay, e2z = tri[o + 8] - az;
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-12) continue;
    if (Math.abs(ny / len) < 0.85) continue;
    const area = len / 2;
    const cy = (ay + tri[o + 4] + tri[o + 7]) / 3;
    hist[Math.floor((cy - minY) / BIN)] += area;
    flatArea += area;
  }
  // Smooth over five bins (10 cm) so a slightly bowed floor still reads as one peak.
  const sm = new Float64Array(nb);
  let peak = 0;
  for (let i = 0; i < nb; i++) {
    let s = 0;
    for (let j = -2; j <= 2; j++) s += hist[clamp(i + j, 0, nb - 1)];
    sm[i] = s;
    if (s > peak) peak = s;
  }
  if (!peak) return null;
  const strong = Math.max(0.5, peak * 0.2);
  let fb = -1;
  for (let i = 0; i < nb; i++) if (sm[i] >= strong && sm[i] >= sm[i + 1] * 0.9) { fb = i; break; }
  if (fb < 0) return null;
  // Refine the floor to the local maximum of the smoothed histogram within 15 cm, then take
  // the area-weighted mean height inside +-4 cm of it.
  let best = fb;
  for (let i = fb; i <= Math.min(nb - 1, fb + 7); i++) if (sm[i] > sm[best]) best = i;
  let wsum = 0, ysum = 0;
  for (let i = Math.max(0, best - 2); i <= Math.min(nb - 1, best + 2); i++) { wsum += hist[i]; ysum += hist[i] * (minY + (i + 0.5) * BIN); }
  const floor = wsum ? ysum / wsum : minY + (best + 0.5) * BIN;
  const floorArea = sm[best];

  let ceiling = null, ceilingArea = 0;
  const ceilStrong = Math.max(0.5, peak * 0.12);
  const from = Math.floor((floor + 2.0 - minY) / BIN);
  for (let i = nb - 1; i >= from; i--) {
    if (sm[i] >= ceilStrong) {
      let b = i;
      for (let j = i; j >= Math.max(from, i - 7); j--) if (sm[j] > sm[b]) b = j;
      let ws = 0, ys = 0;
      for (let j = Math.max(0, b - 2); j <= Math.min(nb - 1, b + 2); j++) { ws += hist[j]; ys += hist[j] * (minY + (j + 0.5) * BIN); }
      ceiling = ws ? ys / ws : minY + (b + 0.5) * BIN;
      ceilingArea = sm[b];
      break;
    }
  }
  return { floor, floorArea, ceiling, ceilingArea, minY, maxY, flatArea };
}

// ---------- sections ----------
// Intersect every triangle with the plane y = h. Returns Float32Array [x0,z0,x1,z1,...].
export function sectionAt(tri, count, h) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const o = i * 9;
    const y0 = tri[o + 1], y1 = tri[o + 4], y2 = tri[o + 7];
    const lo = Math.min(y0, y1, y2), hi = Math.max(y0, y1, y2);
    if (h < lo || h > hi || lo === hi) continue;
    let n = 0;
    const px = [0, 0, 0], pz = [0, 0, 0];
    const edge = (a, b) => {
      const ya = tri[o + a * 3 + 1], yb = tri[o + b * 3 + 1];
      if ((ya < h && yb < h) || (ya > h && yb > h) || ya === yb) return;
      const t = (h - ya) / (yb - ya);
      if (t < 0 || t > 1) return;
      px[n] = tri[o + a * 3] + (tri[o + b * 3] - tri[o + a * 3]) * t;
      pz[n] = tri[o + a * 3 + 2] + (tri[o + b * 3 + 2] - tri[o + a * 3 + 2]) * t;
      n++;
    };
    edge(0, 1); if (n < 3) edge(1, 2); if (n < 3) edge(2, 0);
    if (n < 2) continue;
    // Three hits happen when a vertex sits exactly on the plane: keep the two farthest apart.
    let a = 0, b = 1;
    if (n === 3) {
      const d01 = Math.hypot(px[0] - px[1], pz[0] - pz[1]), d12 = Math.hypot(px[1] - px[2], pz[1] - pz[2]), d20 = Math.hypot(px[2] - px[0], pz[2] - pz[0]);
      if (d12 >= d01 && d12 >= d20) { a = 1; b = 2; } else if (d20 >= d01) { a = 2; b = 0; }
    }
    if (Math.hypot(px[a] - px[b], pz[a] - pz[b]) < 1e-4) continue;
    out.push(px[a], pz[a], px[b], pz[b]);
  }
  return Float32Array.from(out);
}

// Length-weighted histogram of segment directions modulo 90 degrees; the peak is the
// direction most walls run in. Returns the angle in radians mapped to (-45, 45] degrees
// and the share of total length within +-3 degrees of it (how rectilinear the scan is).
export function dominantAngle(segs) {
  const hist = new Float64Array(90);
  let total = 0;
  for (let i = 0; i < segs.length; i += 4) {
    const dx = segs[i + 2] - segs[i], dz = segs[i + 3] - segs[i + 1];
    const len = Math.hypot(dx, dz);
    if (len < 0.02) continue;
    let a = Math.atan2(dz, dx) * 180 / Math.PI;
    a = ((a % 90) + 90) % 90;
    hist[Math.floor(a) % 90] += len;
    total += len;
  }
  if (!total) return { angle: 0, score: 0 };
  let best = 0, bestV = -1;
  for (let i = 0; i < 90; i++) {
    let s = 0;
    for (let j = -3; j <= 3; j++) s += hist[((i + j) % 90 + 90) % 90];
    if (s > bestV) { bestV = s; best = i; }
  }
  // Sub-degree refinement: weighted mean around the peak bin.
  let ws = 0, as = 0;
  for (let j = -3; j <= 3; j++) { const w = hist[((best + j) % 90 + 90) % 90]; ws += w; as += w * (best + 0.5 + j); }
  let deg = ws ? as / ws : best + 0.5;
  deg = ((deg % 90) + 90) % 90;
  if (deg > 45) deg -= 90;
  return { angle: deg * Math.PI / 180, score: bestV / total };
}

// ---------- grids ----------
class Grid {
  constructor(ox, oz, w, h) { this.ox = ox; this.oz = oz; this.w = w; this.h = h; this.a = new Uint8Array(w * h); }
  ix(x) { return Math.floor((x - this.ox) / CELL); }
  iz(z) { return Math.floor((z - this.oz) / CELL); }
  get(i, j) { return (i >= 0 && j >= 0 && i < this.h && j < this.w) ? this.a[i * this.w + j] : 0; }
  set(i, j) { if (i >= 0 && j >= 0 && i < this.h && j < this.w) this.a[i * this.w + j] = 1; }
  fraction(x0, x1, z0, z1) {
    const j0 = this.ix(Math.min(x0, x1)), j1 = this.ix(Math.max(x0, x1)), i0 = this.iz(Math.min(z0, z1)), i1 = this.iz(Math.max(z0, z1));
    let n = 0, hit = 0;
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) { n++; if (this.get(i, j)) hit++; }
    return n ? hit / n : 0;
  }
}

function rasterSegments(grid, segs) {
  for (let i = 0; i < segs.length; i += 4) {
    const x0 = segs[i], z0 = segs[i + 1], x1 = segs[i + 2], z1 = segs[i + 3];
    const len = Math.hypot(x1 - x0, z1 - z0);
    const steps = Math.max(1, Math.ceil(len / (CELL * 0.5)));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      grid.set(grid.iz(z0 + (z1 - z0) * t), grid.ix(x0 + (x1 - x0) * t));
    }
  }
}

// Morphology on the binary grid (square structuring elements).
function dilate(g, r) {
  const out = new Grid(g.ox, g.oz, g.w, g.h);
  for (let i = 0; i < g.h; i++) for (let j = 0; j < g.w; j++) {
    if (!g.a[i * g.w + j]) continue;
    for (let di = -r; di <= r; di++) for (let dj = -r; dj <= r; dj++) out.set(i + di, j + dj);
  }
  return out;
}
function erode(g, r) {
  const out = new Grid(g.ox, g.oz, g.w, g.h);
  for (let i = 0; i < g.h; i++) for (let j = 0; j < g.w; j++) {
    let ok = true;
    for (let di = -r; di <= r && ok; di++) for (let dj = -r; dj <= r; dj++) if (!g.get(i + di, j + dj)) { ok = false; break; }
    if (ok) out.set(i, j);
  }
  return out;
}

// Fill the floor grid from near-floor, near-horizontal triangles (already in the aligned frame).
function rasterFloor(grid, tri, count, xf, floorY) {
  const lo = floorY - 0.06, hi = floorY + 0.15;
  const X = [0, 0, 0], Z = [0, 0, 0];
  for (let i = 0; i < count; i++) {
    const o = i * 9;
    const cy = (tri[o + 1] + tri[o + 4] + tri[o + 7]) / 3;
    if (cy < lo || cy > hi) continue;
    const e1x = tri[o + 3] - tri[o], e1y = tri[o + 4] - tri[o + 1], e1z = tri[o + 5] - tri[o + 2];
    const e2x = tri[o + 6] - tri[o], e2y = tri[o + 7] - tri[o + 1], e2z = tri[o + 8] - tri[o + 2];
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-12 || Math.abs(ny / len) < 0.7) continue;
    for (let k = 0; k < 3; k++) { const p = xf(tri[o + k * 3], tri[o + k * 3 + 2]); X[k] = p[0]; Z[k] = p[1]; }
    const j0 = grid.ix(Math.min(X[0], X[1], X[2])), j1 = grid.ix(Math.max(X[0], X[1], X[2]));
    const i0 = grid.iz(Math.min(Z[0], Z[1], Z[2])), i1 = grid.iz(Math.max(Z[0], Z[1], Z[2]));
    // Tiny triangles (most of a scan) just mark the cells their vertices fall in.
    if (j1 - j0 <= 1 && i1 - i0 <= 1) { for (let k = 0; k < 3; k++) grid.set(grid.iz(Z[k]), grid.ix(X[k])); continue; }
    for (let ii = i0; ii <= i1; ii++) for (let jj = j0; jj <= j1; jj++) {
      const px = grid.ox + (jj + 0.5) * CELL, pz = grid.oz + (ii + 0.5) * CELL;
      const d0 = (X[1] - X[0]) * (pz - Z[0]) - (Z[1] - Z[0]) * (px - X[0]);
      const d1 = (X[2] - X[1]) * (pz - Z[1]) - (Z[2] - Z[1]) * (px - X[1]);
      const d2 = (X[0] - X[2]) * (pz - Z[2]) - (Z[0] - Z[2]) * (px - X[2]);
      if ((d0 >= 0 && d1 >= 0 && d2 >= 0) || (d0 <= 0 && d1 <= 0 && d2 <= 0)) grid.set(ii, jj);
    }
  }
}

// ---------- wall faces ----------
// Segments within 10 degrees of an axis, keyed by the coordinate across the wall (c) with an
// extent along it (s0..s1). 'v' faces run along z at a fixed x; 'h' faces run along x at a fixed z.
const AXIS_TAN = Math.tan(10 * Math.PI / 180);
function axisSegments(segs, axis) {
  const out = [];
  for (let i = 0; i < segs.length; i += 4) {
    const x0 = segs[i], z0 = segs[i + 1], x1 = segs[i + 2], z1 = segs[i + 3];
    const dx = Math.abs(x1 - x0), dz = Math.abs(z1 - z0);
    if (axis === 'v') { if (dx > dz * AXIS_TAN) continue; out.push({ c: (x0 + x1) / 2, s0: Math.min(z0, z1), s1: Math.max(z0, z1) }); }
    else { if (dz > dx * AXIS_TAN) continue; out.push({ c: (z0 + z1) / 2, s0: Math.min(x0, x1), s1: Math.max(x0, x1) }); }
  }
  return out;
}

// Merge sorted intervals; gaps up to `gap` close. Returns [{s0, s1}].
function mergeIntervals(iv, gap) {
  iv.sort((a, b) => a.s0 - b.s0);
  const out = [];
  for (const x of iv) {
    const last = out[out.length - 1];
    if (last && x.s0 <= last.s1 + gap) last.s1 = Math.max(last.s1, x.s1);
    else out.push({ s0: x.s0, s1: x.s1 });
  }
  return out;
}

// Cluster axis segments into face lines: a 1 cm histogram of length across the wall, its
// peaks become lines, each line's coverage becomes runs. Small gaps close; wider ones
// (an opening) bridge when both sides carry real wall, so a door does not split its wall.
function extractFaces(segs, axis, cmin, cmax, topGrid) {
  const BIN = 0.01;
  const nb = Math.ceil((cmax - cmin) / BIN) + 3;
  const hist = new Float64Array(nb);
  const list = axisSegments(segs, axis);
  for (const s of list) {
    const b = Math.floor((s.c - cmin) / BIN);
    if (b >= 0 && b < nb) hist[b] += s.s1 - s.s0;
  }
  const sm = new Float64Array(nb);
  for (let i = 0; i < nb; i++) { let v = 0; for (let j = -2; j <= 2; j++) v += hist[clamp(i + j, 0, nb - 1)]; sm[i] = v; }
  const peaks = [];
  for (let i = 0; i < nb; i++) {
    if (sm[i] < 0.5) continue;
    let isMax = true;
    for (let j = -5; j <= 5; j++) { if (!j) continue; const k = clamp(i + j, 0, nb - 1); if (sm[k] > sm[i] || (sm[k] === sm[i] && k < i)) { isMax = false; break; } }
    if (isMax) peaks.push({ bin: i, c: cmin + (i + 0.5) * BIN, segs: [] });
  }
  for (const s of list) {
    let best = null, bd = 0.05;
    for (const p of peaks) { const d = Math.abs(s.c - p.c); if (d < bd) { bd = d; best = p; } }
    if (best) best.segs.push(s);
  }
  const faces = [];
  for (const p of peaks) {
    if (!p.segs.length) continue;
    let ws = 0, cs = 0;
    for (const s of p.segs) { const w = s.s1 - s.s0; ws += w; cs += w * s.c; }
    const c = cs / ws;
    const runs = mergeIntervals(p.segs.map(s => ({ s0: s.s0, s1: s.s1 })), 0.12).filter(r => r.s1 - r.s0 >= 0.25);
    // Bridge openings: consecutive runs separated by at most 1.4 m become one face run.
    const bridged = [];
    for (const r of runs) {
      const last = bridged[bridged.length - 1];
      if (last && r.s0 - last.s1 <= 1.4 && (last.s1 - last.s0) >= 0.25 && (r.s1 - r.s0) >= 0.25) last.s1 = r.s1;
      else bridged.push({ s0: r.s0, s1: r.s1 });
    }
    for (const r of bridged) {
      if (r.s1 - r.s0 < 0.5) continue;
      // Furniture stops short of the ceiling; a wall is still there near the top. A face that
      // is missing at the top height along most of its run is a wardrobe, not a wall.
      if (topGrid) {
        const p = profile(topGrid, axis, c, r.s0, r.s1, 3);
        if (mean(p, 0, p.length - 1) < 0.35) continue;
      }
      faces.push({ axis, c, s0: r.s0, s1: r.s1, length: r.s1 - r.s0 });
    }
  }
  return faces;
}

function overlap(a, b) { return Math.min(a.s1, b.s1) - Math.max(a.s0, b.s0); }

// Pair the two faces of a partition into one wall; a face seen from one side only gets the
// default thickness on its blind side (the side with no floor).
function pairFaces(allFaces, floorGrid) {
  const walls = [];
  for (const axis of ['v', 'h']) pairAxis(allFaces.filter(f => f.axis === axis), floorGrid, walls);
  return walls;
}
function pairAxis(faces, floorGrid, walls) {
  faces.sort((a, b) => a.c - b.c);
  const used = new Set();
  for (let i = 0; i < faces.length; i++) {
    if (used.has(i)) continue;
    const f = faces[i];
    let mate = -1, mateScore = 0;
    for (let j = i + 1; j < faces.length; j++) {
      if (used.has(j)) continue;
      const g = faces[j];
      const gap = g.c - f.c;
      if (gap > 0.45) break;
      if (gap < 0.05) continue;
      const ov = overlap(f, g);
      if (ov < 0.6 || ov < 0.5 * Math.min(f.length, g.length)) continue;
      // A real wall has little floor between its faces (a doorway's threshold at most); a
      // wardrobe front near a wall has floor all along. Raw floor, not the closed one.
      const s0 = Math.max(f.s0, g.s0), s1 = Math.min(f.s1, g.s1);
      const between = f.axis === 'v' ? floorGrid.fraction(f.c + 0.02, g.c - 0.02, s0, s1) : floorGrid.fraction(s0, s1, f.c + 0.02, g.c - 0.02);
      if (between > 0.45) continue;
      const score = ov / (1 + gap);
      if (score > mateScore) { mateScore = score; mate = j; }
    }
    if (mate >= 0) {
      const g = faces[mate];
      used.add(i); used.add(mate);
      walls.push({ axis: f.axis, c: (f.c + g.c) / 2, s0: Math.min(f.s0, g.s0), s1: Math.max(f.s1, g.s1), thickness: +(g.c - f.c).toFixed(3), faces: [f.c, g.c], paired: true });
    } else {
      used.add(i);
      const band = (side) => f.axis === 'v'
        ? floorGrid.fraction(f.c + side * 0.05, f.c + side * 0.3, f.s0, f.s1)
        : floorGrid.fraction(f.s0, f.s1, f.c + side * 0.05, f.c + side * 0.3);
      const plus = band(1), minus = band(-1);
      const body = plus < minus ? 1 : -1;   // the wall body is on the side without floor
      walls.push({ axis: f.axis, c: f.c + body * INT_THICK / 2, s0: f.s0, s1: f.s1, thickness: INT_THICK, faces: [f.c], paired: false, interior: -body });
    }
  }
}

// Collinear walls (same line, touching or overlapping) become one; ends snap to the
// centreline of a crossing wall so corners meet and the geometry builder can mitre them.
function tidyWalls(walls) {
  const byAxis = a => walls.filter(w => w.axis === a).sort((p, q) => p.c - q.c || p.s0 - q.s0);
  const merged = [];
  for (const axis of ['v', 'h']) {
    const list = byAxis(axis);
    for (const w of list) {
      const last = merged.find(m => m.axis === axis && Math.abs(m.c - w.c) < 0.04 && w.s0 <= m.s1 + 0.15 && w.s1 >= m.s0 - 0.15);
      if (last) { last.s0 = Math.min(last.s0, w.s0); last.s1 = Math.max(last.s1, w.s1); last.thickness = Math.max(last.thickness, w.thickness); last.faces = Array.from(new Set(last.faces.concat(w.faces))); }
      else merged.push(Object.assign({}, w));
    }
  }
  for (const w of merged) {
    const cross = merged.filter(o => o.axis !== w.axis && o.s0 - 0.35 <= w.c && o.s1 + 0.35 >= w.c);
    for (const end of ['s0', 's1']) {
      let best = null, bd = 0.4;
      for (const o of cross) { const d = Math.abs(o.c - w[end]); if (d < bd) { bd = d; best = o; } }
      if (best) w[end] = best.c;
    }
  }
  return merged.filter(w => w.s1 - w.s0 >= 0.3);
}

// ---------- rooms ----------
function components(grid) {
  const seen = new Uint8Array(grid.w * grid.h);
  const out = [];
  const stack = [];
  for (let i = 0; i < grid.h; i++) for (let j = 0; j < grid.w; j++) {
    const k = i * grid.w + j;
    if (!grid.a[k] || seen[k]) continue;
    const comp = new Grid(grid.ox, grid.oz, grid.w, grid.h);
    let n = 0;
    stack.push(k); seen[k] = 1;
    while (stack.length) {
      const q = stack.pop();
      comp.a[q] = 1; n++;
      const qi = Math.floor(q / grid.w), qj = q % grid.w;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ni = qi + di, nj = qj + dj;
        if (ni < 0 || nj < 0 || ni >= grid.h || nj >= grid.w) continue;
        const nk = ni * grid.w + nj;
        if (grid.a[nk] && !seen[nk]) { seen[nk] = 1; stack.push(nk); }
      }
    }
    out.push({ grid: comp, cells: n, area: n * CELL * CELL });
  }
  return out.sort((a, b) => b.cells - a.cells);
}

// Outer boundary of a component as a closed polyline of cell corners (crack following,
// inside on the right). Holes (a column in the middle of a room) are ignored on purpose.
function traceBoundary(comp) {
  let si = -1, sj = -1;
  for (let i = 0; i < comp.h && si < 0; i++) for (let j = 0; j < comp.w; j++) if (comp.a[i * comp.w + j]) { si = i; sj = j; break; }
  if (si < 0) return [];
  const pts = [];
  let ci = si, cj = sj, d = 0;   // 0 east, 1 south, 2 west, 3 north
  const AL = [[-1, 0], [0, 0], [0, -1], [-1, -1]], AR = [[0, 0], [0, -1], [-1, -1], [-1, 0]];
  const STEP = [[0, 1], [1, 0], [0, -1], [-1, 0]];
  let guard = comp.w * comp.h * 4 + 8;
  for (let n = 0; guard-- > 0; n++) {
    const al = comp.get(ci + AL[d][0], cj + AL[d][1]), ar = comp.get(ci + AR[d][0], cj + AR[d][1]);
    let nd = d;
    if (al) nd = (d + 3) % 4;
    else if (!ar) nd = (d + 1) % 4;
    // Back at the start corner and about to head east along the top edge again: the loop is closed.
    if (n && ci === si && cj === sj && nd === 0) break;
    if (!n || nd !== d) pts.push([comp.ox + cj * CELL, comp.oz + ci * CELL]);
    d = nd;
    ci += STEP[d][0]; cj += STEP[d][1];
  }
  return pts;
}

function perpDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L2 = dx * dx + dy * dy;
  if (L2 < 1e-12) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2, 0, 1);
  return Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dy * t));
}
function douglasPeucker(pts, eps) {
  if (pts.length < 3) return pts.slice();
  let maxD = 0, idx = 0;
  for (let i = 1; i < pts.length - 1; i++) { const d = perpDist(pts[i], pts[0], pts[pts.length - 1]); if (d > maxD) { maxD = d; idx = i; } }
  if (maxD <= eps) return [pts[0], pts[pts.length - 1]];
  const a = douglasPeucker(pts.slice(0, idx + 1), eps), b = douglasPeucker(pts.slice(idx), eps);
  return a.slice(0, -1).concat(b);
}

// Simplify a boundary into a rectilinear polygon whose edges sit on wall centrelines where
// a wall runs nearby, otherwise on the scanned floor edge.
function roomPolygon(boundary, walls) {
  if (boundary.length < 4) return null;
  // Closed ring for the simplifier: rotate the start to the sharpest corner is overkill; the
  // start is already a corner (top-left of the topmost row).
  let ring = douglasPeucker(boundary.concat([boundary[0]]), 0.07);
  ring.pop();
  // Edge classes, merging consecutive edges of one class.
  const edges = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const dx = Math.abs(b[0] - a[0]), dz = Math.abs(b[1] - a[1]);
    if (dx < 0.02 && dz < 0.02) continue;
    const axis = dx >= dz ? 'h' : 'v';
    const last = edges[edges.length - 1];
    if (last && last.axis === axis) { last.b = b; continue; }
    edges.push({ axis, a, b });
  }
  if (edges.length >= 2 && edges[0].axis === edges[edges.length - 1].axis) { edges[edges.length - 1].b = edges[0].b; edges.shift(); }
  if (edges.length < 4) return null;
  for (const e of edges) {
    e.c = e.axis === 'h' ? (e.a[1] + e.b[1]) / 2 : (e.a[0] + e.b[0]) / 2;
    e.s0 = e.axis === 'h' ? Math.min(e.a[0], e.b[0]) : Math.min(e.a[1], e.b[1]);
    e.s1 = e.axis === 'h' ? Math.max(e.a[0], e.b[0]) : Math.max(e.a[1], e.b[1]);
    // Snap to the nearest wall centreline of the same orientation that spans this edge.
    let best = null, bd = 0.32;
    for (const w of walls) {
      if (w.axis !== e.axis) continue;
      const ov = Math.min(w.s1, e.s1) - Math.max(w.s0, e.s0);
      if (ov < 0.3 * (e.s1 - e.s0) && ov < 0.5) continue;
      const d = Math.abs(w.c - e.c);
      if (d < bd) { bd = d; best = w; }
    }
    if (best) e.c = best.c;
  }
  // Consecutive edges of the same coordinate after snapping collapse into one.
  const pts = [];
  for (let i = 0; i < edges.length; i++) {
    const prev = edges[(i + edges.length - 1) % edges.length], e = edges[i];
    if (prev.axis === e.axis) continue;
    pts.push(prev.axis === 'h' ? [e.c, prev.c] : [prev.c, e.c]);
  }
  // Drop slivers: vertices that repeat or make an edge shorter than 12 cm.
  const clean = [];
  for (const p of pts) {
    const last = clean[clean.length - 1];
    if (last && Math.abs(last[0] - p[0]) < 0.12 && Math.abs(last[1] - p[1]) < 0.12) continue;
    clean.push([+p[0].toFixed(3), +p[1].toFixed(3)]);
  }
  while (clean.length > 3 && Math.abs(clean[0][0] - clean[clean.length - 1][0]) < 0.12 && Math.abs(clean[0][1] - clean[clean.length - 1][1]) < 0.12) clean.pop();
  if (clean.length < 4) return null;
  // Collinear leftovers (three points on one line) go too.
  const out = [];
  for (let i = 0; i < clean.length; i++) {
    const p = clean[(i + clean.length - 1) % clean.length], q = clean[i], r = clean[(i + 1) % clean.length];
    const cross = (q[0] - p[0]) * (r[1] - q[1]) - (q[1] - p[1]) * (r[0] - q[0]);
    if (Math.abs(cross) < 1e-4) continue;
    out.push(q);
  }
  return out.length >= 4 ? out : null;
}

// A sofa or a cabinet against a wall hides the floor behind it, so the traced room dips
// around it: an inward notch (reflex, convex, convex, reflex) whose far edge sits on no
// wall. Fill such notches back out to the wall line; alcoves and L-corners are left alone.
function fillNotches(pts, walls) {
  const n0 = pts.length;
  let area = 0;
  for (let i = 0; i < n0; i++) { const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % n0]; area += x1 * y2 - x2 * y1; }
  const orient = Math.sign(area) || 1;
  let out = pts.slice();
  for (let pass = 0; pass < 6; pass++) {
    const n = out.length;
    if (n < 6) break;
    const cross = i => {
      const p = out[(i + n - 1) % n], q = out[i], r = out[(i + 1) % n];
      return (q[0] - p[0]) * (r[1] - q[1]) - (q[1] - p[1]) * (r[0] - q[0]);
    };
    const reflex = i => Math.sign(cross(i)) === -orient;
    let done = true;
    for (let i = 0; i < n; i++) {
      const a = out[i], b = out[(i + 1) % n], c = out[(i + 2) % n], d = out[(i + 3) % n];
      if (!(reflex(i) && !reflex((i + 1) % n) && !reflex((i + 2) % n) && reflex((i + 3) % n))) continue;
      const depth1 = Math.hypot(b[0] - a[0], b[1] - a[1]), depth2 = Math.hypot(d[0] - c[0], d[1] - c[1]);
      const width = Math.hypot(c[0] - b[0], c[1] - b[1]);
      if (depth1 > 1.5 || depth2 > 1.5 || Math.abs(depth1 - depth2) > 0.15 || width > 3.5) continue;
      // The far edge (b-c) must not have a wall of its own orientation between it and the
      // wall line (a-d); an alcove with real walls stays.
      const axis = Math.abs(c[0] - b[0]) >= Math.abs(c[1] - b[1]) ? 'h' : 'v';
      const far = axis === 'h' ? b[1] : b[0], line = axis === 'h' ? a[1] : a[0];
      const lo = Math.min(far, line), hi = Math.max(far, line);
      const s0 = Math.min(axis === 'h' ? b[0] : b[1], axis === 'h' ? c[0] : c[1]), s1 = Math.max(axis === 'h' ? b[0] : b[1], axis === 'h' ? c[0] : c[1]);
      const walled = walls.some(w => w.axis === axis && w.c > lo - 0.06 && w.c < hi - 0.06 && Math.min(w.s1, s1) - Math.max(w.s0, s0) > 0.3);
      if (walled) continue;
      out = out.filter((p, k) => k !== (i + 1) % n && k !== (i + 2) % n);
      done = false;
      break;
    }
    if (done) break;
  }
  // Collinear leftovers after a fill.
  const clean = [];
  for (let i = 0; i < out.length; i++) {
    const p = out[(i + out.length - 1) % out.length], q = out[i], r = out[(i + 1) % out.length];
    const cr = (q[0] - p[0]) * (r[1] - q[1]) - (q[1] - p[1]) * (r[0] - q[0]);
    if (Math.abs(cr) < 1e-4) continue;
    clean.push(q);
  }
  return clean.length >= 4 ? clean : pts;
}

// ---------- openings ----------
// Presence of scan surface at height `grid` within a band across a face line, sampled along it.
function profile(grid, axis, c, s0, s1, band) {
  const n = Math.max(1, Math.round((s1 - s0) / CELL));
  const out = new Uint8Array(n + 1);
  const cc = axis === 'v' ? grid.ix(c) : grid.iz(c);
  for (let k = 0; k <= n; k++) {
    const s = s0 + (s1 - s0) * (k / n);
    const ss = axis === 'v' ? grid.iz(s) : grid.ix(s);
    let hit = 0;
    for (let b = -band; b <= band && !hit; b++) hit = axis === 'v' ? grid.get(ss, cc + b) : grid.get(cc + b, ss);
    out[k] = hit;
  }
  return out;
}
function orProfiles(a, b) { const o = new Uint8Array(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] | (b[i] || 0); return o; }
function mean(p, k0, k1) { let s = 0, n = 0; for (let k = k0; k <= k1; k++) { s += p[k]; n++; } return n ? s / n : 0; }

function findOpenings(wall, grids, wallH) {
  const out = [];
  const L = wall.s1 - wall.s0;
  if (L < 0.8) return out;
  const prof = h => wall.faces.map(c => profile(grids[h], wall.axis, c, wall.s0, wall.s1, 3)).reduce(orProfiles);
  const mid = prof('mid'), low = prof('low'), sill = prof('sill'), high = prof('high');
  const n = mid.length;
  const interior = wall.interior || 0;
  let k = 0;
  while (k < n) {
    if (mid[k]) { k++; continue; }
    let e = k;
    while (e < n && !mid[e]) e++;
    const g0 = wall.s0 + k * CELL, g1 = wall.s0 + e * CELL;
    const width = g1 - g0;
    k = e;
    if (width < 0.5 || width > 3.2) continue;
    if (g0 < wall.s0 + 0.1 || g1 > wall.s1 - 0.1) continue;   // a gap at the very end is just where the wall stops
    // Something parallel and close on the room side at mid height means the wall is hidden
    // behind furniture, not open: skip rather than invent a door.
    if (interior) {
      let blocked = false;
      for (let off = 4; off <= 24 && !blocked; off += 2) {
        const c = wall.faces[0] + interior * off * CELL;
        const p = profile(grids.mid, wall.axis, c, g0, g1, 1);
        if (mean(p, 0, p.length - 1) > 0.6) blocked = true;
      }
      if (blocked) continue;
    }
    const ks = Math.max(0, e - Math.round(width / CELL)), ke = Math.min(n - 1, e - 1);
    const lowF = mean(low, ks, ke), sillF = mean(sill, ks, ke), highF = mean(high, ks, ke);
    const t = ((g0 + g1) / 2 - wall.s0) / L;
    if (lowF < 0.35) {
      out.push({ type: 'door', t, width: +clamp(width, 0.6, 3.0).toFixed(3), height: +Math.min(DOOR_H, wallH - 0.1).toFixed(3) });
    } else if (lowF >= 0.55) {
      const sillH = sillF >= 0.5 ? 0.914 : 0.61;
      const h = Math.min(highF >= 0.6 ? 0.9 : WIN_H, wallH - sillH - 0.15);
      if (h > 0.3) out.push({ type: 'window', t, width: +clamp(width, 0.4, 4).toFixed(3), height: +h.toFixed(3), sill: sillH });
    }
  }
  return out;
}

// ---------- underlay ----------
// Orthographic top-down render of the aligned mesh with everything above the cut height
// clipped away: the plan underlay, calibrated by construction (1 px = mPerPx meters).
function renderUnderlay(object, bounds, floorY, cutY) {
  const margin = 0.4;
  const x0 = bounds.minX - margin, x1 = bounds.maxX + margin, z0 = bounds.minZ - margin, z1 = bounds.maxZ + margin;
  const span = Math.max(x1 - x0, z1 - z0);
  const pxPerM = Math.min(100, 1600 / span);
  const w = Math.max(64, Math.round((x1 - x0) * pxPerM)), h = Math.max(64, Math.round((z1 - z0) * pxPerM));
  let renderer = null;
  const swapped = [];
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: false });
    renderer.setPixelRatio(1);
    renderer.setSize(w, h, false);
    renderer.setClearColor(0x0a0e12, 1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.clippingPlanes = [new THREE.Plane(new THREE.Vector3(0, -1, 0), cutY)];
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
        // Baked-in lighting in scan textures reads right unlit; bare geometry gets a soft shade.
        return map || hasColor
          ? new THREE.MeshBasicMaterial({ map, vertexColors: hasColor && !map, side: THREE.DoubleSide })
          : new THREE.MeshLambertMaterial({ color: 0xb8c0c8, side: THREE.DoubleSide });
      });
      swapped.push([o, orig]);
      o.material = Array.isArray(orig) ? repl : repl[0];
    });
    scene.add(object);
    // Camera looks down -y with up = -z, so screen x = world x and screen y (down) = world z;
    // the frustum edges are expressed in that frame.
    const cam = new THREE.OrthographicCamera(x0, x1, -z0, -z1, 0.1, 100);
    cam.position.set(0, floorY + 40, 0);
    cam.up.set(0, 0, -1);
    cam.lookAt(0, floorY, 0);
    cam.updateProjectionMatrix();
    renderer.render(scene, cam);
    const canvas = renderer.domElement;
    let img = canvas.toDataURL('image/webp', 0.82);
    if (!img.startsWith('data:image/webp')) img = canvas.toDataURL('image/jpeg', 0.82);
    scene.remove(object);
    return { img, imgW: w, imgH: h, mPerPx: 1 / pxPerM, offsetX: x0, offsetY: z0 };
  } finally {
    for (const [o, orig] of swapped) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) if (m && m.dispose) m.dispose();
      o.material = orig;
    }
    if (renderer) { renderer.dispose(); renderer.forceContextLoss(); }
  }
}

// ---------- the pipeline ----------
// object: a three Object3D holding the mesh (its own transform is ignored: the scan record's
// transform is what the result describes). Returns null when the mesh has no floor at all.
export async function analyseMesh(object, hooks) {
  const say = (m, f) => { if (hooks && hooks.progress) hooks.progress(m, f); };
  const tick = () => new Promise(r => setTimeout(r, 0));
  say('Reading the mesh', 0.05);
  await tick();
  const { tri, count } = gatherTriangles(object);
  if (!count) return null;
  say('Finding the floor', 0.12);
  await tick();
  const lv = findLevels(tri, count);
  if (!lv) return null;
  const floorY = lv.floor;
  const wallH = lv.ceiling ? clamp(lv.ceiling - floorY, 2.0, 4.5) : 2.44;
  const heights = Object.assign({}, SECTION);
  if (lv.ceiling) heights.top = Math.min(heights.top, lv.ceiling - floorY - 0.2);
  heights.top = Math.max(heights.top, heights.high + 0.15);

  say('Cutting sections', 0.2);
  await tick();
  const raw = {};
  for (const k of Object.keys(heights)) raw[k] = sectionAt(tri, count, floorY + heights[k]);
  const upper = new Float32Array(raw.mid.length + raw.high.length + raw.top.length);
  upper.set(raw.mid, 0); upper.set(raw.high, raw.mid.length); upper.set(raw.top, raw.mid.length + raw.high.length);
  const { angle, score } = dominantAngle(upper);
  const cos = Math.cos(angle), sin = Math.sin(angle);
  // Aligned frame: rotate by `angle` about y (three's rotation.y convention), then translate
  // so the scan's plan extent starts at the origin and the floor sits at y = 0.
  const rot = (x, z) => [x * cos + z * sin, -x * sin + z * cos];
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  const eat = p => { if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0]; if (p[1] < minZ) minZ = p[1]; if (p[1] > maxZ) maxZ = p[1]; };
  for (let i = 0; i < upper.length; i += 2) eat(rot(upper[i], upper[i + 1]));
  for (let i = 0; i < count; i++) {
    const o = i * 9, cy = (tri[o + 1] + tri[o + 4] + tri[o + 7]) / 3;
    if (Math.abs(cy - floorY) < 0.12) eat(rot(tri[o], tri[o + 2]));
  }
  if (!isFinite(minX)) return null;
  const tx = -minX, tz = -minZ, ty = -floorY;
  const xf = (x, z) => { const p = rot(x, z); return [p[0] + tx, p[1] + tz]; };
  const segsAligned = {};
  for (const k of Object.keys(raw)) {
    const s = raw[k], out = new Float32Array(s.length);
    for (let i = 0; i < s.length; i += 4) { const a = xf(s[i], s[i + 1]), b = xf(s[i + 2], s[i + 3]); out[i] = a[0]; out[i + 1] = a[1]; out[i + 2] = b[0]; out[i + 3] = b[1]; }
    segsAligned[k] = out;
  }
  const bounds = { minX: 0, maxX: maxX - minX, minZ: 0, maxZ: maxZ - minZ };
  const transform = { pos: [+tx.toFixed(4), +ty.toFixed(4), +tz.toFixed(4)], rot: [0, +(angle * 180 / Math.PI).toFixed(3), 0] };

  say('Rasterising', 0.4);
  await tick();
  const margin = 0.5;
  const gw = Math.ceil((bounds.maxX + 2 * margin) / CELL), gh = Math.ceil((bounds.maxZ + 2 * margin) / CELL);
  if (gw * gh > 40e6) throw new Error('Scan footprint is too large to plan (' + Math.round(bounds.maxX) + ' x ' + Math.round(bounds.maxZ) + ' m)');
  const grids = {};
  for (const k of Object.keys(segsAligned)) { grids[k] = new Grid(-margin, -margin, gw, gh); rasterSegments(grids[k], segsAligned[k]); }
  const floorGrid = new Grid(-margin, -margin, gw, gh);
  rasterFloor(floorGrid, tri, count, xf, floorY);

  say('Proposing walls', 0.55);
  await tick();
  const upperAligned = new Float32Array(segsAligned.mid.length + segsAligned.high.length + segsAligned.top.length);
  upperAligned.set(segsAligned.mid, 0); upperAligned.set(segsAligned.high, segsAligned.mid.length); upperAligned.set(segsAligned.top, segsAligned.mid.length + segsAligned.high.length);
  // A scan that never reached the top of the walls cannot use the top-height test.
  const cells = g => { let n = 0; for (let k = 0; k < g.a.length; k++) n += g.a[k]; return n; };
  const topGrid = cells(grids.top) >= 0.2 * cells(grids.mid) ? grids.top : null;
  const faces = extractFaces(upperAligned, 'v', -margin, bounds.maxX + margin, topGrid).concat(extractFaces(upperAligned, 'h', -margin, bounds.maxZ + margin, topGrid));
  const floorClosed = erode(dilate(floorGrid, 4), 4);
  const walls = tidyWalls(pairFaces(faces, floorGrid));

  say('Finding rooms', 0.7);
  await tick();
  const wallBodies = new Grid(-margin, -margin, gw, gh);
  for (const w of walls) {
    const h = w.thickness / 2 + CELL;
    const j0 = wallBodies.ix(w.axis === 'v' ? w.c - h : w.s0), j1 = wallBodies.ix(w.axis === 'v' ? w.c + h : w.s1);
    const i0 = wallBodies.iz(w.axis === 'v' ? w.s0 : w.c - h), i1 = wallBodies.iz(w.axis === 'v' ? w.s1 : w.c + h);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) wallBodies.set(i, j);
  }
  const free = new Grid(-margin, -margin, gw, gh);
  for (let k = 0; k < free.a.length; k++) free.a[k] = floorClosed.a[k] && !wallBodies.a[k] ? 1 : 0;
  const rooms = [];
  for (const comp of components(erode(free, 1))) {
    if (comp.area < 1.5) break;
    const poly = roomPolygon(traceBoundary(dilate(comp.grid, 1)), walls);
    if (poly) rooms.push({ pts: fillNotches(poly, walls), area: comp.area });
  }

  say('Reading doors and windows', 0.8);
  await tick();
  const openings = [];
  walls.forEach((w, i) => { for (const o of findOpenings(w, grids, wallH)) openings.push(Object.assign({ wall: i }, o)); });

  const totalWall = walls.reduce((n, w) => n + (w.s1 - w.s0), 0);
  const roomLike = lv.floorArea >= 2 && totalWall >= 4 && walls.length >= 2;
  say(null);
  return {
    transform, wallHeight: +wallH.toFixed(3), floorY, ceilingY: lv.ceiling, floorArea: lv.floorArea,
    angle, rectilinear: score, bounds, walls, rooms, openings, roomLike, triangles: count, heights,
  };
}

// Run the whole thing on a stored scan: parse the bytes, analyse, render the underlay,
// write the proposal (or, for a scan that is not a room, just place it on the floor).
// Resolves { result, applied } ; `applied` is null when nothing was written.
export async function planFromScanBytes(prop, scan, buffer, hooks, opts) {
  opts = opts || {};
  const say = (m, f) => { if (hooks && hooks.progress) hooks.progress(m, f); };
  say('Parsing ' + scan.name, 0.02);
  const obj = await loadMesh(buffer, scan.format || String(scan.name || '').split('.').pop().toLowerCase());
  try {
    const result = await analyseMesh(obj, hooks);
    if (!result) throw new Error('no floor could be found in ' + scan.name);
    let underlay = null;
    if (opts.underlay !== false) {
      say('Rendering the underlay', 0.9);
      await new Promise(r => setTimeout(r, 0));
      try { underlay = underlayFor(obj, result); } catch (e) { console.error('underlay render failed', e); }
    }
    let applied = null;
    if (result.roomLike && opts.geometry !== false) applied = applyProposal(prop, scan, result, underlay);
    else {
      // Not a room (an object, a facade, a garden): keep any traced plan, place the scan.
      scan.pos = result.transform.pos.slice(); scan.rot = result.transform.rot.slice(); scan.rotY = scan.rot[1]; scan.flip = false;
      if (underlay && !(prop.plan && prop.plan.img)) prop.plan = Object.assign({ opacity: 0.6, calibrated: true, source: 'scan' }, underlay);
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
  return applied.walls.length + ' walls, ' + applied.rooms.length + ' room' + (applied.rooms.length === 1 ? '' : 's') + ', ' + doors + ' door' + (doors === 1 ? '' : 's') + ', ' + wins + ' window' + (wins === 1 ? '' : 's') + ', ceiling ' + result.wallHeight.toFixed(2) + ' m';
}

// Render the underlay for a result (needs the live object and a WebGL context).
export function underlayFor(object, result) {
  const g = new THREE.Group();
  g.position.fromArray(result.transform.pos);
  g.rotation.set(0, result.transform.rot[1] * Math.PI / 180, 0);
  const parent = object.parent, oldPos = object.position.clone(), oldRot = object.rotation.clone(), oldScale = object.scale.clone();
  g.add(object);
  try { return renderUnderlay(g, result.bounds, 0, Math.min(1.6, result.wallHeight - 0.4)); }
  finally {
    g.remove(object);
    object.position.copy(oldPos); object.rotation.copy(oldRot); object.scale.copy(oldScale);
    if (parent) parent.add(object);
  }
}

// ---------- apply ----------
// Write the proposal into a property: walls, openings, rooms, wall height, the underlay and
// the scan record's transform, replacing whatever plan geometry was there.
export function applyProposal(prop, scan, result, underlay) {
  const walls = result.walls.map(w => ({
    id: uid('w'),
    ax: +(w.axis === 'v' ? w.c : w.s0).toFixed(3), ay: +(w.axis === 'v' ? w.s0 : w.c).toFixed(3),
    bx: +(w.axis === 'v' ? w.c : w.s1).toFixed(3), by: +(w.axis === 'v' ? w.s1 : w.c).toFixed(3),
    height: null, thickness: w.thickness, material: 'mat-drywall',
  }));
  const openings = result.openings.map(o => {
    const rec = { id: uid('o'), wallId: walls[o.wall].id, type: o.type, t: +o.t.toFixed(4), width: o.width, height: o.height };
    if (o.type === 'window') rec.sill = o.sill;
    return rec;
  });
  const rooms = result.rooms.map((r, i) => ({ id: uid('r'), name: roomName(r, i, result.rooms.length), material: null, ceilingMaterial: null, pts: r.pts }));
  prop.wallHeight = result.wallHeight;
  prop.walls = walls;
  prop.openings = openings;
  prop.rooms = rooms;
  if (underlay) prop.plan = Object.assign({ opacity: 0.6, calibrated: true, source: 'scan' }, underlay);
  if (scan) {
    scan.pos = result.transform.pos.slice();
    scan.rot = result.transform.rot.slice();
    scan.rotY = scan.rot[1];
    scan.scale = 1;
    scan.flip = false;
    scan.planned = new Date().toISOString();
  }
  touch();
  return { walls, openings, rooms };
}

function roomName(r, i, n) {
  if (n === 1) return 'Room';
  const a = r.area;
  if (i === 0 && a > 14) return 'Living';
  return 'Room ' + (i + 1);
}

// A starter project whose scope items carry the takeoffs from the proposal, each linked to
// the elements it came from, so cut sheets and the budget have something real to show.
export function seedProject(prop, applied, label) {
  const M2_PER_SF = 0.09290304;
  const sf = m2 => Math.round(m2 / M2_PER_SF);
  const items = [];
  const area = pts => { let s = 0; for (let i = 0; i < pts.length; i++) { const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length]; s += x1 * y2 - x2 * y1; } return Math.abs(s) / 2; };
  for (const r of applied.rooms) {
    const a = area(r.pts);
    items.push({ id: uid('it'), name: 'Flooring: ' + r.name, qty: sf(a), unit: 'sf', low: 0, likely: 0, high: 0, durationDays: 0, deps: [], elementIds: [r.id], notes: 'Takeoff from the scan: ' + a.toFixed(1) + ' m2 floor.' });
  }
  const wallArea = applied.walls.reduce((n, w) => n + Math.hypot(w.bx - w.ax, w.by - w.ay) * (w.height || prop.wallHeight), 0);
  if (applied.walls.length) items.push({ id: uid('it'), name: 'Paint walls', qty: sf(wallArea), unit: 'sf', low: 0, likely: 0, high: 0, durationDays: 0, deps: [], elementIds: applied.walls.map(w => w.id), notes: 'One face per wall from the scan; openings not deducted.' });
  const doors = applied.openings.filter(o => o.type === 'door'), wins = applied.openings.filter(o => o.type === 'window');
  if (doors.length) items.push({ id: uid('it'), name: 'Doors', qty: doors.length, unit: 'ea', low: 0, likely: 0, high: 0, durationDays: 0, deps: [], elementIds: doors.map(o => o.wallId), notes: 'Openings read from the scan.' });
  if (wins.length) items.push({ id: uid('it'), name: 'Windows', qty: wins.length, unit: 'ea', low: 0, likely: 0, high: 0, durationDays: 0, deps: [], elementIds: wins.map(o => o.wallId), notes: 'Openings read from the scan.' });
  if (!items.length) return null;
  const project = {
    id: uid('proj'), name: label || 'Scope from scan', propertyId: prop.id, category: 'interior', status: 'idea', selected: false, startDate: '',
    notes: 'Quantities came from the scan-to-plan proposal. Prices are blank until you scope them.', items,
  };
  return project;
}

export { CELL, SECTION };
