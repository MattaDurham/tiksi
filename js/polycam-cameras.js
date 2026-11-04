// Polycam "raw data" exports: every keyframe records its camera (lens, position, direction), a
// small depth map and the time it was taken. Tiksi keeps the cameras as a camera set on the
// property, lines each tracking session up with the model once, and uses them to place photos.
// Pure: no DOM, no three.js. PNG decoding uses DecompressionStream (browsers and Node 18+).
//
// prop.cameraSets = [{ id, name, source: 'polycam', importedAt, folder,
//   sessions: { '<segment>': { matrix: [16] Polycam world -> model, row-major, method, fitM, inliers } },
//   keyframes: [[stem, segment, takenAtMs, fx, fy, cx, cy, w, h, blur, t00..t23 (12)]] }]
// Keyframe poses are camera-to-world in ARKit's convention (+x right, +y up, looking down -z),
// the same as three.js cameras.

import { mulMatrix, to4, transformPoint } from './camera-solve.js';

export const KF = { stem: 0, seg: 1, t: 2, fx: 3, fy: 4, cx: 5, cy: 6, w: 7, h: 8, blur: 9, pose: 10 };
const r5 = v => Math.round(v * 1e5) / 1e5;

// One camera JSON (cameras/<stem>.json) to a compact keyframe row, or null.
export function keyframeRow(json, stem) {
  if (!json || typeof json !== 'object') return null;
  const pose = [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 4; j++) pose.push(Number(json['t_' + i + j]));
  const lens = ['fx', 'fy', 'cx', 'cy', 'width', 'height'].map(k => Number(json[k]));
  if (!pose.every(Number.isFinite) || !lens.every(Number.isFinite) || !(lens[0] > 0)) return null;
  const ex = json.exif || {};
  let t = NaN;
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(ex.DateTimeOriginal || '');
  if (m) {
    const sub = /^\d+$/.test(String(ex.SubsecTimeOriginal || '')) ? '.' + String(ex.SubsecTimeOriginal).padEnd(3, '0').slice(0, 3) : '';
    const off = /^[+-]\d{2}:\d{2}$/.test(ex.OffsetTimeOriginal || '') ? ex.OffsetTimeOriginal : 'Z';
    t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${sub}${off}`);
  }
  const seg = Number.isInteger(json.tracking_segment) ? json.tracking_segment : 0;
  const blur = Number.isFinite(Number(json.blur_score)) ? r5(Number(json.blur_score)) : null;
  return [String(stem), seg, Number.isFinite(t) ? t : null, ...lens.map(r5), blur, ...pose.map(r5)];
}

export function keyframePose(row) { return row.slice(KF.pose, KF.pose + 12); }
export function segmentsOf(set) { return [...new Set((set.keyframes || []).map(k => k[KF.seg]))].sort((a, b) => a - b); }

// A keyframe's camera in the model: { R, C } (camera-solve.js pose) or null when its session has
// not been lined up yet.
export function keyframeModelPose(set, row) {
  const s = set.sessions && set.sessions[String(row[KF.seg])];
  if (!s || !Array.isArray(s.matrix)) return null;
  const m = mulMatrix(s.matrix, to4(keyframePose(row)));
  return { R: [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]], C: [m[3], m[7], m[11]] };
}

export function keyframeLens(row) {
  return { fx: row[KF.fx], fy: row[KF.fy], cx: row[KF.cx], cy: row[KF.cy], w: row[KF.w], h: row[KF.h] };
}

// The keyframe taken closest in time to `ms`, among lined-up sessions; null when none is within
// `maxGapMs` (default 30 minutes).
export function nearestKeyframe(set, ms, maxGapMs = 30 * 60 * 1000) {
  if (!set || !Number.isFinite(ms)) return null;
  let best = null, gap = Infinity;
  for (const row of set.keyframes || []) {
    if (row[KF.t] == null || !(set.sessions || {})[String(row[KF.seg])]) continue;
    const g = Math.abs(row[KF.t] - ms);
    if (g < gap) { gap = g; best = row; }
  }
  return best && gap <= maxGapMs ? { row: best, gapMs: gap } : null;
}

// Sharp keyframes spread through the walk: of each run of `every` keyframes, the one with the
// highest blur score (Polycam's score rises as the image gets sharper: on a real export
// it ranks +0.81 with measured sharpness).
export function sharpKeyframes(set, every = 60) {
  const rows = (set.keyframes || []).slice().sort((a, b) => a[KF.stem] < b[KF.stem] ? -1 : 1);
  const out = [];
  for (let i = 0; i < rows.length; i += every) {
    const run = rows.slice(i, i + every);
    run.sort((a, b) => (b[KF.blur] ?? -1) - (a[KF.blur] ?? -1));
    if (run[0]) out.push(run[0]);
  }
  return out;
}

// ---- 16-bit greyscale PNG (Polycam depth maps, millimetres) ----
export async function decodePng16(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!sig.every((v, i) => u8[i] === v)) throw new Error('not a PNG');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let w = 0, h = 0, depth = 0, colour = 0, interlace = 0, p = 8;
  const idat = [];
  while (p + 8 <= u8.length) {
    const n = dv.getUint32(p), type = String.fromCharCode(u8[p + 4], u8[p + 5], u8[p + 6], u8[p + 7]);
    const data = u8.subarray(p + 8, p + 8 + n);
    if (type === 'IHDR') { w = dv.getUint32(p + 8); h = dv.getUint32(p + 12); depth = u8[p + 16]; colour = u8[p + 17]; interlace = u8[p + 20]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + n;
  }
  if (colour !== 0 || (depth !== 16 && depth !== 8) || interlace) throw new Error('unsupported PNG (need non-interlaced greyscale)');
  const joined = new Uint8Array(idat.reduce((s, a) => s + a.length, 0));
  let o = 0; for (const a of idat) { joined.set(a, o); o += a.length; }
  const raw = new Uint8Array(await new Response(new Blob([joined]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
  const bpp = depth / 8, stride = w * bpp, out = depth === 16 ? new Uint16Array(w * h) : new Uint8Array(w * h);
  let prev = new Uint8Array(stride), cur = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[x] = v & 255;
    }
    for (let x = 0; x < w; x++) out[y * w + x] = depth === 16 ? (cur[x * 2] << 8) | cur[x * 2 + 1] : cur[x];
    [prev, cur] = [cur, prev];
  }
  return { w, h, data: out };
}

// Points in Polycam world from one keyframe's depth map: every `step`-th depth pixel with good
// confidence (255, or any when no confidence map) between 0.2 and 5 m.
export function depthPoints(row, depth, confidence, step = 4) {
  const lens = keyframeLens(row), pose = keyframePose(row);
  const sx = lens.w / depth.w, sy = lens.h / depth.h, out = [];
  for (let j = Math.floor(step / 2); j < depth.h; j += step) for (let i = Math.floor(step / 2); i < depth.w; i += step) {
    const k = j * depth.w + i;
    if (confidence && confidence.data[k] < 255) continue;
    const d = depth.data[k] / 1000;
    if (!(d > 0.2 && d < 5)) continue;
    const u = (i + 0.5) * sx, v = (j + 0.5) * sy;
    out.push(transformPoint(pose, [(u - lens.cx) / lens.fx * d, -(v - lens.cy) / lens.fy * d, -d]));
  }
  return out;
}

// ---- lining a session up with the model: yaw + translation (both frames have gravity as up) ----
export function pointIndex(points, cell = 0.05) {
  const map = new Map();
  for (const p of points) {
    const key = Math.floor(p[0] / cell) + ',' + Math.floor(p[1] / cell) + ',' + Math.floor(p[2] / cell);
    let a = map.get(key); if (!a) map.set(key, a = []); a.push(p);
  }
  return { cell, map };
}
// Nearest indexed point within `maxDist` (at most a few cells), or null.
export function nearest(index, p, maxDist) {
  const { cell, map } = index, r = Math.max(1, Math.ceil(maxDist / cell));
  const cx = Math.floor(p[0] / cell), cy = Math.floor(p[1] / cell), cz = Math.floor(p[2] / cell);
  let best = null, bd = maxDist * maxDist;
  for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) for (let k = -r; k <= r; k++) {
    const a = map.get((cx + i) + ',' + (cy + j) + ',' + (cz + k)); if (!a) continue;
    for (const q of a) { const d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2; if (d < bd) { bd = d; best = q; } }
  }
  return best;
}
// Occupancy grid for fast scoring: does the model have a surface within one cell of p?
const ckey = (x, y, z) => ((x + 4096) * 8192 + (y + 4096)) * 8192 + (z + 4096);
export function occupancy(points, cell) {
  const set = new Set();
  for (const p of points) {
    const x = Math.floor(p[0] / cell), y = Math.floor(p[1] / cell), z = Math.floor(p[2] / cell);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++) set.add(ckey(x + i, y + j, z + k));
  }
  return { cell, set };
}
const hit = (occ, p) => occ.set.has(ckey(Math.floor(p[0] / occ.cell), Math.floor(p[1] / occ.cell), Math.floor(p[2] / occ.cell)));

export function yawMatrix(yawDeg, t) {
  const a = yawDeg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  return [c, 0, s, t[0], 0, 1, 0, t[1], -s, 0, c, t[2], 0, 0, 0, 1];
}
function score(occ, pts, m) { let n = 0; for (const p of pts) if (hit(occ, transformPoint(m, p))) n++; return n / (pts.length || 1); }

// Best yaw + translation taking the session's points onto the model's points. Tries `init` first
// (a matrix or a list of them: the scan's own placement, sessions already lined up), then a coarse
// search over yaw and position inside the model's box,
// then refines by iterative closest point. Returns { matrix, inliers (share within 5 cm), fitM
// (rms of those), method } or null.
export function alignSession(sessionPts, modelPts, init, opts = {}) {
  if (sessionPts.length < 50 || modelPts.length < 50) return null;
  const sample = (a, n) => a.length <= n ? a : Array.from({ length: n }, (_, i) => a[Math.floor(i * a.length / n)]);
  const few = sample(sessionPts, opts.searchPoints || 250);
  const indexes = { 0.3: pointIndex(modelPts, 0.3), 0.15: pointIndex(modelPts, 0.15), 0.08: pointIndex(modelPts, 0.08), 0.05: pointIndex(modelPts, 0.05) };
  const coarse = occupancy(sample(modelPts, 60000), 0.2);
  // Starting guesses: the scan's own placement, and sessions already lined up (Polycam sessions
  // of one capture often share a frame). Each promising one is refined; the full search runs
  // whenever none of them fits well, and the best fit wins.
  const inits = (Array.isArray(init) && Array.isArray(init[0]) ? init : init ? [init] : []).map(to4);
  const pts = sample(sessionPts, opts.icpPoints || 3000);
  const results = [];
  const scored = inits.map((m, k) => ({ m, s: score(coarse, few, m), method: k ? 'another session' : 'scan placement' })).filter(x => x.s > 0.4).sort((a, b) => b.s - a.s).slice(0, 3);
  for (const g of scored) results.push({ ...refineYaw(g.m, pts, indexes), method: g.method, searchScore: r5(g.s) });
  if (!results.some(r => r.inliers >= (opts.goodEnough ?? 0.8))) {
    let best = { m: yawMatrix(0, [0, 0, 0]), s: 0 };
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const p of modelPts) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
    const mean = [0, 1, 2].map(k => few.reduce((s, p) => s + p[k], 0) / few.length);
    const my = modelPts.reduce((s, p) => s + p[1], 0) / modelPts.length;
    const step = opts.step || 0.4, yawStep = opts.yawStep || 10;
    for (let yaw = 0; yaw < 360; yaw += yawStep) {
      const R = yawMatrix(yaw, [0, 0, 0]), rm = transformPoint(R, mean);
      // the session's centroid goes to (x, model mean height +- 0.6 m, z) inside the model's box
      for (let x = lo[0]; x <= hi[0]; x += step) for (let z = lo[2]; z <= hi[2]; z += step) for (let dy = -0.6; dy <= 0.61; dy += 0.2) {
        const m = yawMatrix(yaw, [x - rm[0], my + dy - rm[1], z - rm[2]]);
        const sc = score(coarse, few, m);
        if (sc > best.s) best = { m, s: sc };
      }
    }
    results.push({ ...refineYaw(best.m, pts, indexes), method: 'search', searchScore: r5(best.s) });
  }
  results.sort((a, b) => b.inliers - a.inliers || (a.fitM ?? 1) - (b.fitM ?? 1));
  return results[0];
}
// Iterative closest point from `m`, yaw + translation only, with shrinking match distances.
function refineYaw(m, pts, indexes) {
  let last = Infinity;
  for (let it = 0; it < 40; it++) {
    const maxD = it < 10 ? 0.3 : it < 25 ? 0.15 : 0.08, index = indexes[maxD];
    const P = [], Q = [];
    for (const p of pts) { const q0 = transformPoint(m, p), q = nearest(index, q0, maxD); if (q) { P.push(q0); Q.push(q); } }
    if (P.length < 30) break;
    m = mulMatrix(rigidYaw(P, Q), m);
    const err = Math.sqrt(P.reduce((s, p, i) => s + (p[0] - Q[i][0]) ** 2 + (p[1] - Q[i][1]) ** 2 + (p[2] - Q[i][2]) ** 2, 0) / P.length);
    if (Math.abs(last - err) < 1e-5 && it > 25) break;
    last = err;
  }
  let inl = 0, ss = 0;
  for (const p of pts) { const q0 = transformPoint(m, p), q = nearest(indexes[0.05], q0, 0.05); if (q) { inl++; ss += (q[0] - q0[0]) ** 2 + (q[1] - q0[1]) ** 2 + (q[2] - q0[2]) ** 2; } }
  return { matrix: m.map(r5), inliers: r5(inl / pts.length), fitM: inl ? r5(Math.sqrt(ss / inl)) : null };
}
// Yaw about y and translation that best take P onto Q (2D Procrustes in x-z, mean height in y).
function rigidYaw(P, Q) {
  const n = P.length, mp = [0, 0, 0], mq = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) { mp[k] += P[i][k] / n; mq[k] += Q[i][k] / n; }
  let sxx = 0, sxz = 0;
  for (let i = 0; i < n; i++) {
    const px = P[i][0] - mp[0], pz = P[i][2] - mp[2], qx = Q[i][0] - mq[0], qz = Q[i][2] - mq[2];
    sxx += px * qx + pz * qz; sxz += pz * qx - px * qz;
  }
  const yaw = Math.atan2(sxz, sxx) * 180 / Math.PI;
  const R = yawMatrix(yaw, [0, 0, 0]), rp = transformPoint(R, mp);
  return yawMatrix(yaw, [mq[0] - rp[0], mq[1] - rp[1], mq[2] - rp[2]]);
}
