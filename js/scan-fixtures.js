// Fixture proposals from a scan mesh: counter runs, wall cabinets, tall appliances and the
// furniture that stands in the rooms. Pure typed-array code with no DOM or three.js, so it
// runs in a Web Worker (scan-fixtures.worker.js) and under Node for tests.
//
// Input: the mesh (positions, triangle indices) with a column-major 4x4 `matrix` from the
// mesh into the model's world (plan x = world x, plan y = world z, y up), and each level's
// floor elevation, height and walls. Every triangle is sampled onto a plan grid per level:
// up-facing and down-facing samples go into per-cell height histograms, vertical ones into a
// bitmask of 10 cm slices. Then:
//   counter runs    up-facing surfaces 0.80-0.98 m in a strip along a wall face; the depth
//                   is how far that surface reaches, the cabinet front the vertical faces of
//                   the 0.3-0.7 m slices. Runs on meeting walls join, diagonal corners kept.
//   wall cabinets   down-facing undersides 1.25-1.95 m along a wall; fronts and the top from
//                   the slices above the underside, up to a cabinet top or the ceiling.
//   tall appliance  an up-facing top 1.5-2.1 m about 0.6-0.8 m square with vertical sides.
//   furniture       isolated up-facing patches at characteristic heights with plausible
//                   footprints: bed, sofa (seat plus a back strip), table, desk, storage, tub.
// Everything comes back as a proposal with a confidence and the evidence it rests on. The
// person reviews each one; nothing here is final.

export const FIXTURE_DETECT = {
  cell: 0.05, bin: 0.02, slice: 0.1,
  flatNy: 0.85, vertNy: 0.35,
  counter: [0.80, 0.98], cabinet: [1.25, 1.95], tall: [1.5, 2.1],
  minRun: 0.35, maxGap: 0.2,
};

const median = a => { if (!a.length) return NaN; const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
const round = (v, k = 1000) => Math.round(v * k) / k;
const popcount = x => { x -= (x >>> 1) & 0x55555555; x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24; };
const sliceMask = (a, b) => { let m = 0; for (let s = Math.max(0, a); s <= Math.min(31, b); s++) m |= 1 << s; return m >>> 0; };

function toWorld(pos, m) {
  if (!m) return pos;
  const out = new Float32Array(pos.length);
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2];
    out[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
    out[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    out[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
  return out;
}
const det3 = m => m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);

// ---------- sampling ----------

function buildGrid(wp, idx, L, o, flipped) {
  const elev = L.elevation || 0, ceil = L.height || 2.6, top = ceil + 0.05;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const w of L.walls || []) { x0 = Math.min(x0, w.ax, w.bx); x1 = Math.max(x1, w.ax, w.bx); z0 = Math.min(z0, w.ay, w.by); z1 = Math.max(z1, w.ay, w.by); }
  if (Number.isFinite(x0)) { x0 -= 1; x1 += 1; z0 -= 1; z1 += 1; }
  else for (let i = 0; i < wp.length; i += 3) {
    const h = wp[i + 1] - elev;
    if (h < -0.05 || h > top) continue;
    x0 = Math.min(x0, wp[i]); x1 = Math.max(x1, wp[i]); z0 = Math.min(z0, wp[i + 2]); z1 = Math.max(z1, wp[i + 2]);
  }
  if (!Number.isFinite(x0)) return null;
  let cell = o.cell;
  while (((x1 - x0) / cell) * ((z1 - z0) / cell) > 1.5e6) cell *= 1.25;     // bounded memory on a huge site
  const W = Math.max(1, Math.ceil((x1 - x0) / cell)), D = Math.max(1, Math.ceil((z1 - z0) / cell));
  const NB = Math.ceil(top / o.bin) + 1;
  let up = new Uint8Array(W * D * NB), down = new Uint8Array(W * D * NB);
  const vert = new Uint32Array(W * D);
  // A half-cell grid of presence bits for edges: vertical slices, and flat surfaces in 5 cm
  // height bins (two words, 3.2 m), so depths and fronts are read to about a centimetre.
  const FW = W * 2, FD = D * 2, fine = cell / 2;
  const fvert = new Uint32Array(FW * FD);
  let fup = new Uint32Array(FW * FD * 2), fdown = new Uint32Array(FW * FD * 2);
  let floorUp = 0, floorDown = 0, samples = 0;
  const sign = flipped ? -1 : 1;
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ay = wp[a + 1] - elev, by = wp[b + 1] - elev, cy = wp[c + 1] - elev;
    if (Math.max(ay, by, cy) < -0.05 || Math.min(ay, by, cy) > top) continue;
    const ux = wp[b] - wp[a], uy = wp[b + 1] - wp[a + 1], uz = wp[b + 2] - wp[a + 2];
    const vx = wp[c] - wp[a], vy = wp[c + 1] - wp[a + 1], vz = wp[c + 2] - wp[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-12) continue;
    const k = sign * ny / len;
    const kind = k > o.flatNy ? 1 : k < -o.flatNy ? 2 : Math.abs(k) < o.vertNy ? 3 : 0;
    if (!kind) continue;
    const e = Math.max(Math.hypot(ux, uy, uz), Math.hypot(vx, vy, vz), Math.hypot(wp[c] - wp[b], wp[c + 1] - wp[b + 1], wp[c + 2] - wp[b + 2]));
    const n = Math.min(64, Math.max(1, Math.ceil(e / (cell * 0.7))));
    const arr = kind === 1 ? up : down;
    for (let i = 0; i < n; i++) for (let j = 0; i + j < n; j++) {
      for (let s = 0; s < 2; s++) {
        if (s && i + j >= n - 1) break;
        const p = (i + (s ? 2 : 1) / 3) / n, q = (j + (s ? 2 : 1) / 3) / n;
        const h = ay + uy * p + vy * q;
        if (h < -0.05 || h > top) continue;
        const fx = Math.floor((wp[a] + ux * p + vx * q - x0) / fine), fz = Math.floor((wp[a + 2] + uz * p + vz * q - z0) / fine);
        if (fx < 0 || fz < 0 || fx >= FW || fz >= FD) continue;
        const ci = (fz >> 1) * W + (fx >> 1), fi = fz * FW + fx;
        samples++;
        if (kind === 3) { const sl = Math.floor(h / o.slice); if (sl >= 0 && sl < 32) { vert[ci] |= 1 << sl; fvert[fi] |= 1 << sl; } continue; }
        const bi = ci * NB + Math.max(0, Math.floor(h / o.bin));
        if (arr[bi] < 255) arr[bi]++;
        const fb = Math.max(0, Math.floor(h / 0.05));
        if (fb < 64) (kind === 1 ? fup : fdown)[fi * 2 + (fb >> 5)] |= 1 << (fb & 31);
        if (Math.abs(h) < 0.06) { if (kind === 1) floorUp++; else floorDown++; }
      }
    }
  }
  // A mesh wound inside out shows its floor as facing down: read it the other way round.
  const inverted = floorDown > floorUp * 1.5 && floorDown > 50;
  if (inverted) { [up, down] = [down, up]; [fup, fdown] = [fdown, fup]; }
  return { x0, z0, W, D, cell, NB, up, down, vert, FW, FD, fine, fup, fdown, fvert, ceil, samples, inverted, bin: o.bin, slice: o.slice };
}

function cellAt(G, x, y) {
  const gx = Math.floor((x - G.x0) / G.cell), gz = Math.floor((y - G.z0) / G.cell);
  return gx < 0 || gz < 0 || gx >= G.W || gz >= G.D ? -1 : gz * G.W + gx;
}
function fineAt(G, x, y) {
  const fx = Math.floor((x - G.x0) / G.fine), fz = Math.floor((y - G.z0) / G.fine);
  return fx < 0 || fz < 0 || fx >= G.FW || fz >= G.FD ? -1 : fz * G.FW + fx;
}
// A flat sample within [lo, hi] in the half-cell at (x, y); `arr` is G.fup or G.fdown.
function flatAt(G, arr, x, y, lo, hi) {
  const fi = fineAt(G, x, y);
  if (fi < 0) return false;
  for (let b = Math.max(0, Math.floor(lo / 0.05)); b <= Math.min(63, Math.floor(hi / 0.05)); b++) if (arr[fi * 2 + (b >> 5)] & (1 << (b & 31))) return true;
  return false;
}
const vertAt = (G, x, y) => { const fi = fineAt(G, x, y); return fi < 0 ? 0 : G.fvert[fi]; };
function countIn(G, arr, ci, lo, hi) {
  if (ci < 0) return 0;
  let n = 0;
  const b0 = Math.max(0, Math.floor(lo / G.bin)), b1 = Math.min(G.NB - 1, Math.floor(hi / G.bin)), base = ci * G.NB;
  for (let b = b0; b <= b1; b++) n += arr[base + b];
  return n;
}
// The most common height of samples in [lo, hi] over `cells` (bins smoothed over 3).
function modeHeight(G, arr, cells, lo, hi) {
  const b0 = Math.max(0, Math.floor(lo / G.bin)), b1 = Math.min(G.NB - 1, Math.floor(hi / G.bin));
  const h = new Float64Array(b1 - b0 + 1);
  for (const ci of cells) if (ci >= 0) for (let b = b0; b <= b1; b++) h[b - b0] += arr[ci * G.NB + b];
  let best = -1, bestV = 0;
  for (let i = 0; i < h.length; i++) { const v = h[i] + 0.5 * ((h[i - 1] || 0) + (h[i + 1] || 0)); if (v > bestV) { bestV = v; best = i; } }
  if (best < 0) return NaN;
  // Centre of mass of the peak and its neighbours, for sub-bin height.
  let s = 0, w = 0;
  for (let i = Math.max(0, best - 1); i <= Math.min(h.length - 1, best + 1); i++) { s += h[i] * (b0 + i + 0.5) * G.bin; w += h[i]; }
  return s / w;
}

// ---------- runs along walls ----------

function wallSides(walls) {
  const out = [];
  for (const w of walls || []) {
    const L = Math.hypot(w.bx - w.ax, w.by - w.ay);
    if (L < 0.3) continue;
    const u = [(w.bx - w.ax) / L, (w.by - w.ay) / L], n = [-u[1], u[0]];
    for (const side of [1, -1]) out.push({ wall: w, L, u, n, side, face: (w.thickness || 0.1) / 2, a: [w.ax, w.ay] });
  }
  return out;
}
const at = (S, s, d) => [S.a[0] + S.u[0] * s + S.n[0] * S.side * (S.face + d), S.a[1] + S.u[1] * s + S.n[1] * S.side * (S.face + d)];

// spec: { arr, band, probe: [d0, d1], cover, lower, absent, maxDepth, depthClamp,
//         frontSlices(h) -> [s0, s1], frontRange(depth) -> [d0, d1], top? }
// A column across the strip is a hit when enough of its cells hold the surface and few show
// a lower one instead; things standing on a counter, a sink or a cooktop leave it unknown,
// and only `absent` evidence (the floor seen, the ceiling seen) ends a run quickly.
function runsAlong(G, S, spec, o) {
  const step = G.cell, K = Math.floor(S.L / step), cols = new Array(K);
  const arr = G[spec.arr];
  for (let k = 0; k < K; k++) {
    const s = (k + 0.5) * S.L / K, cells = [];
    for (let d = spec.probe[0]; d <= spec.probe[1] + 1e-9; d += step) cells.push(cellAt(G, ...at(S, s, d)));
    let hit = 0, miss = 0, absent = 0;
    for (const ci of cells) {
      const inBand = countIn(G, arr, ci, spec.band[0], spec.band[1]) > 0;
      if (inBand) { hit++; continue; }
      const gone = countIn(G, arr, ci, spec.absent[0], spec.absent[1]) > 0;
      if (gone) absent++;
      if (gone || (spec.lower && countIn(G, arr, ci, spec.lower[0], spec.lower[1]) > 0)) miss++;
    }
    cols[k] = hit >= 3 && hit / (hit + miss) >= spec.cover ? { s, cells, h: modeHeight(G, arr, cells, spec.band[0], spec.band[1]) }
      : absent >= cells.length * 0.5 ? 'absent' : null;
  }
  const runs = [], maxGap = Math.round(o.maxGap / step), maxUnknown = Math.round(0.8 / step);
  let cur = null, gap = 0, unknown = 0;
  const close = () => { if (cur && (cur.k1 - cur.k0 + 1) * S.L / K >= o.minRun) runs.push(cur); cur = null; };
  for (let k = 0; k < K; k++) {
    const c = cols[k];
    if (c && c !== 'absent') {
      // Clutter on a counter can outvote its top in one column: the run's own height decides.
      let h = c.h;
      if (cur) {
        const lo = cur.h - 0.04, hi = cur.h + 0.04;
        if (c.cells.filter(ci => countIn(G, arr, ci, lo, hi) > 0).length >= 3) h = modeHeight(G, arr, c.cells, lo, hi);
        else close();
      }
      if (!cur) cur = { k0: k, k1: k, hs: [], ks: [] };
      cur.k1 = k; cur.hs.push(h); cur.ks.push(k); cur.h = median(cur.hs); gap = 0; unknown = 0;
    } else if (cur && ((c === 'absent' && ++gap > maxGap) || (!c && ++unknown > maxUnknown))) close();
  }
  close();
  return runs.map(r => measureRun(G, S, spec, r, K));
}

function measureRun(G, S, spec, r, K) {
  const farr = spec.arr === 'up' ? G.fup : G.fdown, h = r.h, step = G.fine, fronts = [];
  let depths = [];
  for (const k of r.ks) {
    const s = (k + 0.5) * S.L / K;
    let last = -1, miss = 0;
    for (let d = step / 2; d <= spec.maxDepth; d += step) {
      if (flatAt(G, farr, ...at(S, s, d), h - 0.03, h + 0.03)) { last = d; miss = 0; }
      else if (last >= 0 && ++miss >= 3) break;
    }
    if (last >= 0) depths.push({ s, v: last + step / 2 });
  }
  // Things on a counter cut the reach short, never lengthen it: a high percentile, taken
  // away from the run's ends where the other arm of a corner reaches further.
  const inner = depths.filter(d => d.s - r.k0 * S.L / K >= 0.7 && (r.k1 + 1) * S.L / K - d.s >= 0.7);
  depths = (inner.length >= 5 ? inner : depths).map(d => d.v).sort((x, y) => x - y);
  const depth = Math.min(spec.depthClamp[1], Math.max(spec.depthClamp[0], depths[Math.floor(depths.length * 0.7)] || spec.depthClamp[0]));
  const [sa, sb] = spec.frontSlices(h), mask = sliceMask(sa, sb), need = Math.max(2, Math.ceil((sb - sa + 1) * 0.5));
  const [f0, f1] = spec.frontRange(depth);
  const tops = [];
  for (const k of r.ks) {
    const s = (k + 0.5) * S.L / K;
    let best = -1, bestN = 0;
    for (let d = f0; d <= f1 + 1e-9; d += G.fine) {
      const nb = popcount(vertAt(G, ...at(S, s, d)) & mask);
      if (nb > bestN) { bestN = nb; best = d; }
    }
    if (best >= 0 && bestN >= need) {
      fronts.push(best);
      if (spec.top) tops.push(spec.top(G, S, s, best, h, depth));
    }
  }
  const s0 = r.k0 * S.L / K, s1 = (r.k1 + 1) * S.L / K;
  return {
    S, s0: s0 < 0.1 ? 0 : s0, s1: S.L - s1 < 0.1 ? S.L : s1, h, depth,
    front: fronts.length ? median(fronts) : null, frontShare: fronts.length / r.ks.length,
    top: tops.filter(Number.isFinite).length ? median(tops.filter(Number.isFinite)) : null,
    coverage: r.ks.length / (r.k1 - r.k0 + 1), cover: r.ks.length,
  };
}

// A wall cabinet's top seen at its front: the highest run of covered slices above the
// underside, an up-facing cabinet top, or the ceiling when the boxes reach it.
function cabinetTop(G, S, s, front, under, depth) {
  const v = vertAt(G, ...at(S, s, front)) | vertAt(G, ...at(S, s, front - G.fine)) | vertAt(G, ...at(S, s, front + G.fine));
  let t = Math.floor(under / G.slice), missed = 0, topS = null;
  for (let sl = t + 1; sl < 32 && sl * G.slice < G.ceil; sl++) {
    if (v & (1 << sl)) { topS = (sl + 1) * G.slice; missed = 0; } else if (++missed > 1) break;
  }
  const cells = [];
  for (let d = 0.05; d < depth - 0.03; d += G.cell) cells.push(cellAt(G, ...at(S, s, d)));
  const lo = under + 0.25, hi = G.ceil - 0.03;
  const hit = cells.filter(ci => countIn(G, G.up, ci, lo, hi) > 0).length;
  if (cells.length && hit / cells.length >= 0.4) return modeHeight(G, G.up, cells, lo, hi);
  if (topS == null) return null;
  return topS >= G.ceil - 0.25 ? G.ceil : topS;
}

const pt = (S, s) => at(S, s, 0);
function lineX(p, u, q, v) {
  const den = u[0] * v[1] - u[1] * v[0];
  if (Math.abs(den) < 1e-6) return null;
  const t = ((q[0] - p[0]) * v[1] - (q[1] - p[1]) * v[0]) / den;
  return [p[0] + u[0] * t, p[1] + u[1] * t];
}
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// Runs on walls that meet become one polyline: the back corner is where the two wall faces
// cross, and each chain keeps the side its depth extends to.
function chainRuns(runs) {
  // Near a corner, the strip along the other wall sees the same counter sideways for one
  // depth: a run that short, lying inside a longer run's depth at their corner, is dropped.
  runs = runs.filter(R => !runs.some(Q => {
    if (Q === R || Q.s1 - Q.s0 <= R.s1 - R.s0 || Math.abs(Q.S.u[0] * R.S.u[1] - Q.S.u[1] * R.S.u[0]) < 0.3) return false;
    const X = lineX(pt(Q.S, 0), Q.S.u, pt(R.S, 0), R.S.u);
    if (!X) return false;
    const nQ = [Q.S.n[0] * Q.S.side, Q.S.n[1] * Q.S.side];
    const ends = [pt(R.S, R.s0), pt(R.S, R.s1)].map(p => [dist(p, X), (p[0] - X[0]) * nQ[0] + (p[1] - X[1]) * nQ[1]]);
    const qNear = Math.min(dist(pt(Q.S, Q.s0), X), dist(pt(Q.S, Q.s1), X));
    return qNear < R.depth + 0.25 && Math.min(ends[0][0], ends[1][0]) < 0.15 && Math.max(ends[0][0], ends[1][0]) <= Q.depth + 0.1 && ends.every(e => e[1] > -0.05);
  }));
  let chains = runs.map(r => ({ pts: [pt(r.S, r.s0), pt(r.S, r.s1)], dirs: [r.S.u], side: r.S.side, runs: [r], h: r.h, depth: r.depth }));
  const reverse = c => ({ ...c, pts: c.pts.slice().reverse(), dirs: c.dirs.slice().reverse().map(u => [-u[0], -u[1]]), side: -c.side });
  for (let merged = true; merged;) {
    merged = false;
    outer: for (let i = 0; i < chains.length; i++) for (let j = 0; j < chains.length; j++) {
      if (i === j) continue;
      for (const A of [chains[i], reverse(chains[i])]) for (const B of [chains[j], reverse(chains[j])]) {
        if (A.side !== B.side || Math.abs(A.h - B.h) > 0.05) continue;
        const uA = A.dirs[A.dirs.length - 1], uB = B.dirs[0];
        if (Math.abs(uA[0] * uB[1] - uA[1] * uB[0]) < 0.3) continue;      // parallel walls do not join
        const eA = A.pts[A.pts.length - 1], sB = B.pts[0];
        const X = lineX(eA, uA, sB, uB);
        const reach = Math.max(A.depth, B.depth) + 0.25;
        if (!X || dist(X, eA) > reach || dist(X, sB) > reach) continue;
        // X must lie ahead of A's end and behind B's start, not across the room.
        if ((X[0] - A.pts[A.pts.length - 2][0]) * uA[0] + (X[1] - A.pts[A.pts.length - 2][1]) * uA[1] < 0) continue;
        if ((B.pts[1][0] - X[0]) * uB[0] + (B.pts[1][1] - X[1]) * uB[1] < 0) continue;
        // The depth must extend to the inside of the turn on both walls.
        const nA = [-uA[1] * A.side, uA[0] * A.side];
        if ((uB[0] * nA[0] + uB[1] * nA[1]) < 0.2) continue;
        const pts = A.pts.slice(0, -1).concat([X], B.pts.slice(1));
        const n = A.runs.length + B.runs.length;
        const next = { pts, dirs: A.dirs.concat(B.dirs), side: A.side, runs: A.runs.concat(B.runs),
          h: (A.h * A.runs.length + B.h * B.runs.length) / n, depth: (A.depth * A.runs.length + B.depth * B.runs.length) / n };
        chains = chains.filter((_, k) => k !== i && k !== j).concat([next]);
        merged = true;
        break outer;
      }
    }
  }
  return chains;
}

// Reach of the surface along each inner corner's bisector: a 45° front is longer than the
// square corner's mitre.
function cornerReaches(G, farr, c) {
  const out = c.pts.map(() => null);
  for (let i = 1; i + 1 < c.pts.length; i++) {
    const C = c.pts[i], uA = c.dirs[i - 1], uB = c.dirs[i];
    const nA = [-uA[1] * c.side, uA[0] * c.side], nB = [-uB[1] * c.side, uB[0] * c.side];
    const den = 1 + nA[0] * nB[0] + nA[1] * nB[1];
    if (den < 0.15) continue;
    const m = [(nA[0] + nB[0]) / den * c.depth, (nA[1] + nB[1]) / den * c.depth];
    const mitre = Math.hypot(m[0], m[1]), b = [m[0] / mitre, m[1] / mitre];
    if (-uA[0] * b[0] - uA[1] * b[1] < 0.05) continue;           // outer corner: no diagonal
    let last = 0, miss = 0;
    for (let r = G.fine / 2; r < mitre + 1.2; r += G.fine / 2) {
      if (flatAt(G, farr, C[0] + b[0] * r, C[1] + b[1] * r, c.h - 0.03, c.h + 0.03)) { last = r; miss = 0; }
      else if (++miss >= 4) break;
    }
    if (last > mitre + 0.12) out[i] = round(last + G.fine / 4, 100);
  }
  return out;
}

// ---------- components ----------

function close1(mask, W, D) {
  const grow = new Uint8Array(W * D), out = new Uint8Array(W * D);
  for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) {
    let on = 0;
    for (let dz = -1; dz <= 1 && !on; dz++) for (let dx = -1; dx <= 1; dx++) {
      const X = x + dx, Z = z + dz;
      if (X >= 0 && Z >= 0 && X < W && Z < D && mask[Z * W + X]) { on = 1; break; }
    }
    grow[z * W + x] = on;
  }
  for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) {
    let all = 1;
    for (let dz = -1; dz <= 1 && all; dz++) for (let dx = -1; dx <= 1; dx++) {
      const X = x + dx, Z = z + dz;
      if (X >= 0 && Z >= 0 && X < W && Z < D && !grow[Z * W + X]) { all = 0; break; }
    }
    out[z * W + x] = all && grow[z * W + x] ? 1 : mask[z * W + x];
  }
  return out;
}

// Square dilation / erosion by r cells (separable), for closing holes and opening necks.
function dilateR(mask, W, D, r) {
  const tmp = new Uint8Array(W * D), out = new Uint8Array(W * D);
  for (let z = 0; z < D; z++) { let last = -1e9; for (let x = 0; x < W; x++) { if (mask[z * W + x]) last = x; if (x - last <= r) tmp[z * W + x] = 1; } last = 1e9; for (let x = W - 1; x >= 0; x--) { if (mask[z * W + x]) last = x; if (last - x <= r) tmp[z * W + x] = 1; } }
  for (let x = 0; x < W; x++) { let last = -1e9; for (let z = 0; z < D; z++) { if (tmp[z * W + x]) last = z; if (z - last <= r) out[z * W + x] = 1; } last = 1e9; for (let z = D - 1; z >= 0; z--) { if (tmp[z * W + x]) last = z; if (last - z <= r) out[z * W + x] = 1; } }
  return out;
}
function erodeR(mask, W, D, r) {
  const inv = new Uint8Array(W * D);
  for (let i = 0; i < W * D; i++) inv[i] = mask[i] ? 0 : 1;
  const grown = dilateR(inv, W, D, r), out = new Uint8Array(W * D);
  for (let i = 0; i < W * D; i++) out[i] = grown[i] ? 0 : 1;
  return out;
}
const cleanMask = (mask, W, D, closeR, openR) => { const c = erodeR(dilateR(mask, W, D, closeR), W, D, closeR); return dilateR(erodeR(c, W, D, openR), W, D, openR); };

function components(mask, W, D) {
  const seen = new Uint8Array(W * D), out = [];
  for (let i = 0; i < W * D; i++) {
    if (!mask[i] || seen[i]) continue;
    const comp = [i], stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const c = stack.pop(), x = c % W, z = (c / W) | 0;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const X = x + dx, Z = z + dz;
        if (X < 0 || Z < 0 || X >= W || Z >= D) continue;
        const j = Z * W + X;
        if (mask[j] && !seen[j]) { seen[j] = 1; comp.push(j); stack.push(j); }
      }
    }
    out.push(comp);
  }
  return out;
}

const centreOf = (G, ci) => [G.x0 + ((ci % G.W) + 0.5) * G.cell, G.z0 + (((ci / G.W) | 0) + 0.5) * G.cell];

// Oriented box of a patch: principal axes, snapped to a wall direction within 10°; w >= d.
function obbOf(G, cells, wallAngles) {
  let mx = 0, my = 0;
  const P = cells.map(ci => centreOf(G, ci));
  for (const p of P) { mx += p[0]; my += p[1]; }
  mx /= P.length; my /= P.length;
  let sxx = 0, syy = 0, sxy = 0;
  for (const [x, y] of P) { sxx += (x - mx) ** 2; syy += (y - my) ** 2; sxy += (x - mx) * (y - my); }
  let a = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  for (const wa of wallAngles) {
    const d = ((a - wa) % (Math.PI / 2) + Math.PI * 2.5) % (Math.PI / 2);
    const off = Math.min(d, Math.PI / 2 - d);
    if (off < 10 * Math.PI / 180) { a = a - (d < Math.PI / 4 ? d : d - Math.PI / 2); break; }
  }
  const c = Math.cos(a), s = Math.sin(a);
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const [x, y] of P) { const u = (x - mx) * c + (y - my) * s, v = -(x - mx) * s + (y - my) * c; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
  u0 -= G.cell / 2; u1 += G.cell / 2; v0 -= G.cell / 2; v1 += G.cell / 2;
  const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
  let box = { x: mx + cu * c - cv * s, y: my + cu * s + cv * c, a, w: u1 - u0, d: v1 - v0 };
  if (box.d > box.w) box = { ...box, a: a + Math.PI / 2, w: box.d, d: box.w };
  const area = cells.length * G.cell * G.cell;
  return Object.assign(box, { area, fill: area / (box.w * box.d) });
}
const plan = (b, u, v) => { const c = Math.cos(b.a), s = Math.sin(b.a); return [b.x + u * c - v * s, b.y + u * s + v * c]; };

function segDist(p, w) {
  const dx = w.bx - w.ax, dy = w.by - w.ay, L2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p[0] - w.ax) * dx + (p[1] - w.ay) * dy) / L2));
  return Math.hypot(p[0] - w.ax - dx * t, p[1] - w.ay - dy * t) - (w.thickness || 0.1) / 2;
}
// Which long side of a box (+1 = +v, -1 = -v) sits within `tol` of a wall face, or 0.
function againstWall(b, walls, tol = 0.15) {
  for (const sv of [1, -1]) {
    const pts = [-0.4, -0.2, 0, 0.2, 0.4].map(f => plan(b, f * b.w, sv * b.d / 2));
    if ((walls || []).length && pts.every(p => walls.some(w => segDist(p, w) <= tol))) return sv;
  }
  return 0;
}

function inPoly(x, y, pts) {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}

// ---------- the detector ----------

// options: { matrix, levels: [{ id, elevation, height, walls: [{ ax, ay, bx, by, thickness }] }],
//   debug: [] to collect every patch considered }
// Resolves { fixtures: [proposal], levels: [{ id, samples, inverted }] }. Proposals are fixture
// records (fixtures.js) without an id, with provenance { source: 'scan', confidence } and an
// `evidence` line for the review list.
export function detectFixtures(pos, idx, options, progress) {
  const o = Object.assign({}, FIXTURE_DETECT, options || {});
  const m = o.matrix || null;
  const wp = toWorld(pos, m);
  const flipped = !!m && det3(m) < 0;
  const fixtures = [], levels = [];
  (o.levels || []).forEach((L, li) => {
    if (progress) progress('level ' + (L.name || L.id), li / o.levels.length);
    const G = buildGrid(wp, idx, L, o, flipped);
    if (!G) { levels.push({ id: L.id, samples: 0, inverted: false }); return; }
    levels.push({ id: L.id, samples: G.samples, inverted: G.inverted });
    for (const f of detectLevel(G, L, o)) fixtures.push(Object.assign({ level: L.id }, f));
  });
  if (progress) progress('done', 1);
  fixtures.sort((a, b) => b.provenance.confidence - a.provenance.confidence);
  // Levels whose height envelopes overlap see the same object twice: keep the surer one.
  const elev = new Map((o.levels || []).map(L => [L.id, L.elevation || 0]));
  const where = f => { const p = f.pts ? f.pts.reduce((s, q) => [s[0] + q[0] / f.pts.length, s[1] + q[1] / f.pts.length], [0, 0]) : [f.x, f.y]; return [p[0], p[1], elev.get(f.level) + (f.y0 || 0) + f.h]; };
  const kept = [];
  for (const f of fixtures) {
    const w = where(f);
    if (!kept.some(k => k.kind === f.kind && k.subtype === f.subtype && k.level !== f.level && (q => Math.hypot(q[0] - w[0], q[1] - w[1]) < 0.3 && Math.abs(q[2] - w[2]) < 0.25)(where(k)))) kept.push(f);
  }
  fixtures.length = 0; fixtures.push(...kept);
  return o.debug ? { fixtures, levels, debug: o.debug } : { fixtures, levels };
}

const conf = v => round(Math.max(0.05, Math.min(0.99, v)), 100);
const cm = v => Math.round(v * 100) / 100;

function detectLevel(G, L, o) {
  const walls = L.walls || [], sides = wallSides(walls), out = [];
  const ceil = G.ceil;
  // Counter runs.
  const counter = { arr: 'up', band: o.counter, probe: [0.05, 0.45], cover: 0.6, lower: [0.3, o.counter[0] - 0.02], absent: [-0.05, 0.25], maxDepth: 1.0, depthClamp: [0.3, 1.0],
    frontSlices: () => [3, 6], frontRange: depth => [0.2, depth + 0.1] };
  const baseRuns = sides.flatMap(S => runsAlong(G, S, counter, o));
  const baseChains = chainRuns(baseRuns);
  for (const c of baseChains) {
    const runs = c.runs, len = c.pts.reduce((n, p, i) => i ? n + dist(p, c.pts[i - 1]) : 0, 0);
    const fronts = runs.map(r => r.front).filter(v => v != null);
    const front = fronts.length ? median(fronts) : null;
    const share = runs.reduce((n, r) => n + r.frontShare * r.cover, 0) / runs.reduce((n, r) => n + r.cover, 0);
    const coverage = runs.reduce((n, r) => n + r.coverage * r.cover, 0) / runs.reduce((n, r) => n + r.cover, 0);
    // The top always reaches the fronts; clutter can only make it look shorter.
    if (front != null && front + 0.02 > c.depth) c.depth = front + 0.02;
    const overhang = front != null && c.depth - front > 0.005 && c.depth - front < 0.12 ? cm(c.depth - front) : 0.025;
    const corners = cornerReaches(G, G.fup, c);
    out.push({
      kind: 'base-run', name: '', pts: c.pts.map(p => [round(p[0]), round(p[1])]), side: c.side, depth: cm(c.depth), y0: 0, h: cm(c.h),
      counterT: 0.03, toeKick: 0.1, toeDepth: 0.06, overhang, corners, material: 'mat-quartz', bodyMaterial: 'mat-trim',
      provenance: { source: 'scan', confidence: conf(0.45 * coverage + 0.25 * share + 0.15 * Math.min(1, len / 1.2) + 0.15 * (c.h > 0.85 && c.h < 0.95 ? 1 : 0.5)) },
      evidence: 'counter top ' + cm(c.h) + ' m, ' + cm(c.depth) + ' m deep' + (front != null ? ', fronts ' + cm(front) + ' m from the wall' : ', no fronts seen') +
        ', ' + cm(len) + ' m long' + (c.pts.length > 2 ? ', ' + (c.pts.length - 1) + ' walls' : '') + (corners.some(Boolean) ? ', diagonal corner' : ''),
    });
  }
  // Wall cabinets.
  const cabinet = { arr: 'down', band: o.cabinet, probe: [0.05, 0.25], cover: 0.5, absent: [ceil - 0.1, ceil + 0.05], maxDepth: 0.6, depthClamp: [0.2, 0.5],
    frontSlices: h => [Math.floor(h / G.slice) + 1, Math.min(Math.floor((ceil - 0.05) / G.slice), Math.floor(h / G.slice) + 5)],
    frontRange: depth => [0.15, depth + 0.08], top: cabinetTop };
  const wallRuns = sides.flatMap(S => runsAlong(G, S, cabinet, o)).filter(r => r.frontShare > 0.2 || r.top != null);
  for (const c of chainRuns(wallRuns)) {
    const tops = c.runs.map(r => r.top).filter(v => v != null);
    let top = tops.length ? median(tops) : Math.min(ceil, c.h + 0.75);
    if (top >= ceil - 0.12) top = ceil;
    const len = c.pts.reduce((n, p, i) => i ? n + dist(p, c.pts[i - 1]) : 0, 0);
    const share = c.runs.reduce((n, r) => n + r.frontShare * r.cover, 0) / c.runs.reduce((n, r) => n + r.cover, 0);
    out.push({
      kind: 'wall-run', name: '', pts: c.pts.map(p => [round(p[0]), round(p[1])]), side: c.side, depth: cm(c.depth), y0: cm(c.h), h: cm(Math.max(0.2, top - c.h)),
      corners: cornerReaches(G, G.fdown, c), material: null, bodyMaterial: 'mat-trim',
      provenance: { source: 'scan', confidence: conf(0.4 + 0.3 * share + 0.15 * Math.min(1, len / 1.0) + (tops.length ? 0.1 : 0)) },
      evidence: 'underside ' + cm(c.h) + ' m, top ' + cm(top) + ' m' + (top === ceil ? ' (ceiling)' : '') + ', ' + cm(c.depth) + ' m deep, ' + cm(len) + ' m long',
    });
  }

  // Masks for patches: walls themselves and the runs found above are not furniture.
  const N = G.W * G.D, blockWall = new Uint8Array(N), blockRun = new Uint8Array(N), blockUpper = new Uint8Array(N);
  const outlines = out.map(f => ({ kind: f.kind, ring: runRing(f) }));
  // Only the cells under each wall's or run's bounds are tested.
  const paint = (xs, ys, pad, test, mask) => {
    const gx0 = Math.max(0, Math.floor((Math.min(...xs) - pad - G.x0) / G.cell)), gx1 = Math.min(G.W - 1, Math.floor((Math.max(...xs) + pad - G.x0) / G.cell));
    const gz0 = Math.max(0, Math.floor((Math.min(...ys) - pad - G.z0) / G.cell)), gz1 = Math.min(G.D - 1, Math.floor((Math.max(...ys) + pad - G.z0) / G.cell));
    for (let gz = gz0; gz <= gz1; gz++) for (let gx = gx0; gx <= gx1; gx++) { const ci = gz * G.W + gx; if (test(centreOf(G, ci))) mask[ci] = 1; }
  };
  for (const w of walls) paint([w.ax, w.bx], [w.ay, w.by], (w.thickness || 0.1) / 2 + 0.05, p => segDist(p, w) <= 0.04, blockWall);
  for (const r of outlines) paint(r.ring.map(p => p[0]), r.ring.map(p => p[1]), 0, p => inPoly(p[0], p[1], r.ring), r.kind === 'base-run' ? blockRun : blockUpper);
  const wallAngles = walls.map(w => Math.atan2(w.by - w.ay, w.bx - w.ax));
  // Patches of up-facing surface in [lo, hi]; `clean` = [closeR, openR] fills holes and cuts
  // off thin attachments (a nightstand against a bed) before the patches are boxed.
  const patches = (lo, hi, extra, clean) => {
    const mask = new Uint8Array(N);
    for (let ci = 0; ci < N; ci++) if (!blockWall[ci] && !(extra && extra[ci]) && countIn(G, G.up, ci, lo, hi) > 0) mask[ci] = 1;
    const list = components(clean ? cleanMask(mask, G.W, G.D, clean[0], clean[1]) : close1(mask, G.W, G.D), G.W, G.D).filter(c => c.length * G.cell * G.cell >= 0.12)
      .map(cells => Object.assign(obbOf(G, cells, wallAngles), { cells, h: modeHeight(G, G.up, cells, lo, hi) }));
    if (o.debug) for (const b of list) o.debug.push({ band: [lo, hi], x: round(b.x, 100), y: round(b.y, 100), w: cm(b.w), d: cm(b.d), h: cm(b.h), area: cm(b.area), fill: cm(b.fill), wall: againstWall(b, walls) });
    return list;
  };
  // The part of a patch within `tol` of its own height, as one box.
  const refine = (b, tol) => {
    const keep = new Uint8Array(N);
    for (const ci of b.cells) if (countIn(G, G.up, ci, b.h - tol, b.h + tol) > 0) keep[ci] = 1;
    const best = components(cleanMask(keep, G.W, G.D, 1, 2), G.W, G.D).sort((x, y) => y.length - x.length)[0];
    return best && best.length * G.cell * G.cell >= 0.12 ? Object.assign(obbOf(G, best, wallAngles), { cells: best, h: modeHeight(G, G.up, best, b.h - tol, b.h + tol) }) : null;
  };
  const box = (kind, subtype, b, h, extra, confidence, evidence) => out.push(Object.assign({
    kind, subtype, name: '', x: round(b.x), y: round(b.y), rot: round(((b.a * 180 / Math.PI) % 360 + 360) % 360, 10), w: cm(b.w), d: cm(b.d), y0: 0, h: cm(h),
    material: kind === 'appliance' ? 'mat-stainless' : null, provenance: { source: 'scan', confidence: conf(confidence) }, evidence }, extra || {}));

  // Tall appliances: a closed top at fridge or stacked-laundry height with sides below it.
  const tallBlock = new Uint8Array(N);
  for (let ci = 0; ci < N; ci++) tallBlock[ci] = blockUpper[ci] | blockRun[ci];
  for (const b0 of patches(o.tall[0], o.tall[1], tallBlock)) {
    const b = refine(b0, 0.05);
    if (o.debug && b) o.debug.push({ refined: true, x: round(b.x, 100), y: round(b.y, 100), w: cm(b.w), d: cm(b.d), h: cm(b.h), area: cm(b.area), fill: cm(b.fill) });
    if (!b || b.w < 0.45 || b.w > 1.0 || b.d < 0.4 || b.d > 0.9 || b.fill < 0.45) continue;
    const mask = sliceMask(3, Math.floor((b.h - 0.1) / G.slice)), need = Math.max(3, Math.floor(popcount(mask) * 0.5));
    let ring = 0, good = 0;
    for (let u = -b.w / 2 - 0.05; u <= b.w / 2 + 0.05; u += G.cell) for (let v = -b.d / 2 - 0.05; v <= b.d / 2 + 0.05; v += G.cell) {
      if (Math.abs(u) < b.w / 2 - 0.06 && Math.abs(v) < b.d / 2 - 0.06) continue;
      ring++;
      if (popcount((G.vert[cellAt(G, ...plan(b, u, v))] || 0) & mask) >= need) good++;
    }
    const support = ring ? good / ring : 0;
    if (support < 0.15) continue;
    const kitchen = outlines.some(r => r.kind === 'base-run' && r.ring.some(p => Math.hypot(p[0] - b.x, p[1] - b.y) < Math.max(b.w, b.d) / 2 + 0.45));
    // A recess faces the room: put the box's back (+v) to the wall when there is one.
    const sv = againstWall(b, walls, 0.25);
    const bb = sv < 0 ? { ...b, a: b.a + Math.PI } : b;
    box('appliance', kitchen ? 'fridge' : 'washer-dryer', bb, b.h, null, 0.35 + 0.4 * support + 0.15 * b.fill + (kitchen ? 0.05 : 0),
      (kitchen ? 'tall box beside the counter' : 'tall box') + ', top ' + cm(b.h) + ' m, ' + cm(b.w) + ' x ' + cm(b.d) + ' m, sides seen ' + Math.round(support * 100) + '%');
  }

  // Beds first: a mattress top with bedding heaped on it spans 0.47-1.0 m, and its cells
  // are then kept out of the sofa and storage pass.
  const bedBlock = blockRun.slice();
  for (const b of patches(0.47, 1.0, blockRun, [2, 3])) {
    const h = modeHeight(G, G.up, b.cells, 0.42, 0.72);
    if (!(h >= 0.42 && h <= 0.72) || b.area < 1.4 || b.area > 4.6 || b.fill < 0.6 || b.d < 0.85 || b.d > 2.1 || b.w < 1.7 || b.w > 2.4) continue;
    // A sofa's back is a raised strip along one long side; bedding heaps up anywhere.
    const high = b.cells.filter(ci => countIn(G, G.up, ci, h + 0.18, 1.0) > 0 && !countIn(G, G.up, ci, h - 0.06, h + 0.06));
    const edge = high.filter(ci => Math.abs(Math.abs(-(centreOf(G, ci)[0] - b.x) * Math.sin(b.a) + (centreOf(G, ci)[1] - b.y) * Math.cos(b.a)) - b.d / 2) < 0.35);
    if (high.length > b.cells.length * 0.12 && edge.length > high.length * 0.7) continue;
    for (const ci of b.cells) bedBlock[ci] = 1;
    const sv = againstWall(b, walls);
    box('furniture', 'bed', sv < 0 ? { ...b, a: b.a + Math.PI } : b, h, null, 0.45 + 0.3 * b.fill + 0.15 * (b.area >= 2 && b.area <= 4 ? 1 : 0.4),
      'top ' + cm(h) + ' m, ' + cm(b.w) + ' x ' + cm(b.d) + ' m, ' + cm(b.area) + ' m² of top');
  }
  // Then sofas, tubs and storage. The sofa back's cells are kept out of the table band.
  const backCells = new Uint8Array(N);
  const low = patches(0.36, 0.72, bedBlock);
  for (const b of low) {
    const own = new Set(b.cells);
    let back = null;
    for (const sv of [1, -1]) {
      const vs = [], hs = [];
      for (let u = -b.w / 2; u <= b.w / 2; u += G.cell) for (let v = b.d / 2 - 0.05; v <= b.d / 2 + 0.4; v += G.cell) {
        const ci = cellAt(G, ...plan(b, u, sv * v));
        if (ci < 0 || own.has(ci) || blockWall[ci] || !countIn(G, G.up, ci, 0.68, 0.98)) continue;
        vs.push(v); hs.push(ci);
      }
      const area = vs.length * G.cell * G.cell;
      if (area >= 0.3 * b.w * 0.12 && (!back || area > back.area)) back = { sv, area, outer: vs.sort((x, y) => x - y)[Math.floor(vs.length * 0.9)] + G.cell / 2, cells: hs };
    }
    if (back && b.h >= 0.36 && b.h <= 0.56 && b.area >= 0.4 && b.area <= 3.5) {
      const backH = modeHeight(G, G.up, back.cells, 0.68, 0.98);
      for (const ci of back.cells) backCells[ci] = 1;
      const extend = Math.max(0.1, back.outer - b.d / 2);
      // Local +v is the back: centre moves half the back strip toward it.
      const a = back.sv > 0 ? b.a : b.a + Math.PI;
      const sb = { ...b, a, d: b.d + extend };
      const c = plan(b, 0, back.sv * extend / 2);
      sb.x = c[0]; sb.y = c[1];
      box('furniture', 'sofa', sb, backH, { seat: cm(b.h) }, 0.45 + 0.25 * Math.min(1, back.area / (b.w * 0.2)) + 0.2 * b.fill,
        'seat ' + cm(b.h) + ' m, back ' + cm(backH) + ' m, ' + cm(sb.w) + ' x ' + cm(sb.d) + ' m');
      continue;
    }
    const wallSide = againstWall(b, walls);
    if (wallSide && b.h >= 0.4 && b.h <= 0.66 && b.w >= 1.3 && b.w <= 1.9 && b.d >= 0.6 && b.d <= 0.9 && b.fill >= 0.15 && b.fill <= 0.65) {
      box('bath', 'tub', wallSide < 0 ? { ...b, a: b.a + Math.PI } : b, b.h, null, 0.4 + 0.3 * (1 - b.fill), 'rim ' + cm(b.h) + ' m, ' + cm(b.w) + ' x ' + cm(b.d) + ' m, open inside');
      continue;
    }
    if (wallSide && b.h >= 0.45 && b.h <= 0.72 && b.area >= 0.25 && b.area <= 1.6 && b.d >= 0.3 && b.d <= 0.65 && b.w >= 0.6 && b.fill >= 0.6) {
      box('furniture', 'storage', wallSide < 0 ? { ...b, a: b.a + Math.PI } : b, b.h, null, 0.35 + 0.3 * b.fill, 'top ' + cm(b.h) + ' m against a wall, ' + cm(b.w) + ' x ' + cm(b.d) + ' m');
    }
  }
  const tableBlock = new Uint8Array(N);
  for (let ci = 0; ci < N; ci++) tableBlock[ci] = blockRun[ci] | backCells[ci];
  for (const b of patches(0.68, 0.80, tableBlock)) {
    if (b.area < 0.3 || b.area > 3.5 || b.d < 0.45 || b.fill < 0.6) continue;
    const wallSide = againstWall(b, walls);
    if (Math.abs(b.w - b.d) / b.w <= 0.15 && b.fill >= 0.62 && b.fill <= 0.88) {
      const dia = (b.w + b.d) / 2;
      box('furniture', 'table-round', { ...b, a: 0, w: dia, d: dia }, b.h, null, 0.45 + 0.4 * (1 - Math.abs(b.fill - Math.PI / 4) / 0.2), 'round top ' + cm(b.h) + ' m, Ø ' + cm(dia) + ' m');
    } else if (wallSide && b.d <= 0.9) {
      box('furniture', 'desk', wallSide < 0 ? { ...b, a: b.a + Math.PI } : b, b.h, null, 0.4 + 0.35 * b.fill, 'top ' + cm(b.h) + ' m against a wall, ' + cm(b.w) + ' x ' + cm(b.d) + ' m');
    } else if (b.fill >= 0.8) {
      box('furniture', 'table-rect', b, b.h, null, 0.35 + 0.4 * b.fill, 'top ' + cm(b.h) + ' m, ' + cm(b.w) + ' x ' + cm(b.d) + ' m');
    }
  }
  // Free-standing counters (an island): the counter band away from every wall.
  for (const b of patches(o.counter[0], o.counter[1], blockRun)) {
    if (b.area < 0.4 || b.w < 0.8 || b.d < 0.45 || b.d > 1.3 || b.fill < 0.75 || againstWall(b, walls, 0.2)) continue;
    out.push({
      kind: 'base-run', name: '', pts: [plan(b, -b.w / 2, -b.d / 2), plan(b, b.w / 2, -b.d / 2)].map(p => [round(p[0]), round(p[1])]), side: 1,
      depth: cm(b.d), y0: 0, h: cm(b.h), counterT: 0.03, toeKick: 0.1, toeDepth: 0.06, overhang: 0.025, corners: [], material: 'mat-quartz', bodyMaterial: 'mat-trim',
      provenance: { source: 'scan', confidence: conf(0.3 + 0.4 * b.fill) }, evidence: 'free-standing counter ' + cm(b.h) + ' m, ' + cm(b.w) + ' x ' + cm(b.d) + ' m',
    });
  }
  return out;
}

// A run's plan outline, enough for masking (mitred front, no diagonals).
function runRing(f) {
  const pts = f.pts, n = pts.length, front = [];
  for (let i = 0; i < n; i++) {
    const a = i > 0 ? [pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]] : [pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]];
    const b = i < n - 1 ? [pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]] : a;
    const la = Math.hypot(...a) || 1, lb = Math.hypot(...b) || 1;
    const na = [-a[1] / la, a[0] / la], nb = [-b[1] / lb, b[0] / lb], den = 1 + na[0] * nb[0] + na[1] * nb[1];
    const mm = den < 0.15 ? nb : [(na[0] + nb[0]) / den, (na[1] + nb[1]) / den];
    front.push([pts[i][0] + mm[0] * f.side * f.depth, pts[i][1] + mm[1] * f.side * f.depth]);
  }
  return pts.concat(front.reverse());
}

export const _internals = { buildGrid, wallSides, runsAlong, chainRuns, countIn, cellAt, modeHeight, toWorld };
