// Camera poses for photos: conversions between the stored view and a full pose, projection, and
// the four-point fit (click a spot in the photo and the same spot in the model, four or more
// times; the camera that best explains the clicks is solved by Levenberg-Marquardt).
// Pure maths, no three.js and no DOM.
//
// A pose is { R: [9] row-major camera-to-model rotation, C: [x, y, z] camera position } in the
// three.js camera convention: the columns of R are the camera's right, up and back axes, so the
// camera looks down its -z. Image pixels run right (u) and down (v) from the top-left corner.
// A lens is { fx, fy, cx, cy } in pixels of the photo as shown (after the phone's rotation).

const DEG = Math.PI / 180;

export function lookAtPose(position, target, rollDeg = 0) {
  const C = position.slice(0, 3);
  let f = norm(sub(target, position));
  let r = cross(f, [0, 1, 0]);
  if (len(r) < 1e-6) r = cross(f, [0, 0, -1]);
  r = norm(r);
  let u = cross(r, f);
  if (rollDeg) { const a = rollDeg * DEG, c = Math.cos(a), s = Math.sin(a); const r2 = add(scale(r, c), scale(u, s)); u = add(scale(u, c), scale(r, -s)); r = r2; }
  const b = scale(f, -1);
  return { R: [r[0], u[0], b[0], r[1], u[1], b[1], r[2], u[2], b[2]], C };
}

export function poseFromView(view) {
  if (!view || !Array.isArray(view.position) || !Array.isArray(view.target)) return null;
  return lookAtPose(view.position, view.target, Number(view.roll) || 0);
}

// The stored view of a pose: where it stands, a point `dist` metres ahead, the horizontal field
// of view of `lens` (or `hfov`), and the roll about the view direction in degrees.
export function viewFromPose(pose, hfov, dist = 2) {
  const fwd = scale(col(pose.R, 2), -1), up = col(pose.R, 1);
  const level = lookAtPose(pose.C, add(pose.C, fwd), 0);
  const lr = col(level.R, 0), lu = col(level.R, 1);
  const roll = Math.atan2(dot(up, scale(lr, -1)), dot(up, lu)) / DEG;
  return { position: pose.C.slice(), target: add(pose.C, scale(fwd, dist)), fov: hfov, roll: Math.abs(roll) < 0.05 ? 0 : round(roll, 3) };
}

// Row-major 4 x 4 camera-to-model matrix (the photo placement helper's output) to a pose.
export function poseFromMatrix(m) {
  if (!Array.isArray(m) || m.length < 12 || !m.every(Number.isFinite)) return null;
  const R = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
  return orthonormal({ R, C: [m[3], m[7], m[11]] });
}
// Row-major 3 x 4 or 4 x 4 multiplication helpers for alignment matrices.
export function mulMatrix(a, b) {
  const A = to4(a), B = to4(b), out = new Array(16).fill(0);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) out[i * 4 + j] += A[i * 4 + k] * B[k * 4 + j];
  return out;
}
export function to4(m) { return m.length === 16 ? m.slice() : [...m.slice(0, 12), 0, 0, 0, 1]; }
export function transformPoint(m, p) {
  return [m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3], m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7], m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11]];
}

// Pixel [u, v] of a model point, or null when it is behind the camera.
export function project(pose, lens, X) {
  const d = sub(X, pose.C), R = pose.R;
  const xc = R[0] * d[0] + R[3] * d[1] + R[6] * d[2];
  const yc = R[1] * d[0] + R[4] * d[1] + R[7] * d[2];
  const zc = R[2] * d[0] + R[5] * d[1] + R[8] * d[2];
  if (zc > -1e-6) return null;
  return [lens.cx + lens.fx * xc / -zc, lens.cy - lens.fy * yc / -zc];
}

// The camera that best explains the point pairs [{ img: [u, v], world: [x, y, z] }], starting from
// `init` (a pose; the view being lined up by eye is a good start). With `solveFocal` and at least
// five pairs the focal length is fitted too. Returns { pose, lens, rmsPx, errors: [px per pair],
// iterations } or null when there are too few pairs or it cannot converge.
export function solvePose(pairs, lens, init, opts = {}) {
  const pts = (pairs || []).filter(p => p && Array.isArray(p.img) && Array.isArray(p.world) && [...p.img, ...p.world].every(Number.isFinite));
  if (pts.length < 4 || !init) return null;
  const withF = !!opts.solveFocal && pts.length >= 5;
  const n = withF ? 7 : 6;
  const lensOf = q => withF ? { ...lens, fx: lens.fx * Math.exp(q[6]), fy: lens.fy * Math.exp(q[6]) } : lens;
  const poseOf = q => ({ R: mul3(init.R, expSO3(q[0], q[1], q[2])), C: [init.C[0] + q[3], init.C[1] + q[4], init.C[2] + q[5]] });
  const BIG = Math.max(lens.cx, lens.cy) * 4;
  const resid = q => {
    const P = poseOf(q), L = lensOf(q), r = [];
    for (const p of pts) { const uv = project(P, L, p.world); if (!uv) r.push(BIG, BIG); else r.push(uv[0] - p.img[0], uv[1] - p.img[1]); }
    return r;
  };
  let q = new Array(n).fill(0), r = resid(q), cost = sumSq(r), lambda = 1e-3, it = 0;
  for (; it < 200; it++) {
    const J = [];
    for (let k = 0; k < n; k++) {
      const h = k < 3 ? 1e-6 : k < 6 ? 1e-6 * Math.max(1, len(init.C)) : 1e-6;
      const q2 = q.slice(); q2[k] += h;
      const r2 = resid(q2);
      J.push(r2.map((v, i) => (v - r[i]) / h));
    }
    const A = Array.from({ length: n }, (_, a) => Array.from({ length: n }, (_, b) => J[a].reduce((s, v, i) => s + v * J[b][i], 0)));
    const g = J.map(Ja => Ja.reduce((s, v, i) => s + v * r[i], 0));
    let improved = false;
    for (let tries = 0; tries < 12; tries++) {
      const M = A.map((row, a) => row.map((v, b) => a === b ? v * (1 + lambda) + 1e-12 : v));
      const step = solveLinear(M, g.map(v => -v));
      if (!step) { lambda *= 10; continue; }
      const q2 = q.map((v, k) => v + step[k]);
      const r2 = resid(q2), c2 = sumSq(r2);
      if (c2 < cost) {
        const done = cost - c2 < 1e-10 * (1 + cost) || Math.max(...step.map(Math.abs)) < 1e-10;
        q = q2; r = r2; cost = c2; lambda = Math.max(1e-9, lambda / 5); improved = true;
        if (done) it = 1e9;
        break;
      }
      lambda *= 8;
    }
    if (!improved) break;
  }
  const pose = orthonormal(poseOf(q)), L = lensOf(q);
  const errors = pts.map(p => { const uv = project(pose, L, p.world); return uv ? Math.hypot(uv[0] - p.img[0], uv[1] - p.img[1]) : Infinity; });
  if (!errors.every(Number.isFinite)) return null;
  const rmsPx = Math.sqrt(errors.reduce((s, e) => s + e * e, 0) / errors.length);
  return { pose, lens: L, rmsPx, errors, iterations: Math.min(it, 200) };
}

// Horizontal field of view of a lens, in degrees.
export function hfovOfLens(lens) { return 2 * Math.atan(lens.w / (2 * lens.fx)) / DEG; }
// A centred lens from a horizontal field of view for a w x h image.
export function lensFromHfov(hfov, w, h) {
  const fx = w / (2 * Math.tan(hfov * DEG / 2));
  return { fx, fy: fx, cx: w / 2, cy: h / 2, w, h };
}

// ---- small linear algebra ----
function expSO3(x, y, z) {
  const t = Math.hypot(x, y, z);
  if (t < 1e-12) return [1, -z, y, z, 1, -x, -y, x, 1];
  const kx = x / t, ky = y / t, kz = z / t, c = Math.cos(t), s = Math.sin(t), v = 1 - c;
  return [c + kx * kx * v, kx * ky * v - kz * s, kx * kz * v + ky * s,
    ky * kx * v + kz * s, c + ky * ky * v, ky * kz * v - kx * s,
    kz * kx * v - ky * s, kz * ky * v + kx * s, c + kz * kz * v];
}
function mul3(a, b) {
  const o = new Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return o;
}
function orthonormal(p) {
  let r = col(p.R, 0), u = col(p.R, 1);
  r = norm(r); u = norm(sub(u, scale(r, dot(u, r)))); const b = cross(r, u);
  return { R: [r[0], u[0], b[0], r[1], u[1], b[1], r[2], u[2], b[2]], C: p.C.slice() };
}
function solveLinear(A, b) {
  const n = b.length, M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-18) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((row, i) => row[n] / row[i]);
}
const col = (R, j) => [R[j], R[3 + j], R[6 + j]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = a => Math.hypot(a[0], a[1], a[2]);
const norm = a => { const L = len(a) || 1; return [a[0] / L, a[1] / L, a[2] / L]; };
const sumSq = r => r.reduce((s, v) => s + v * v, 0);
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
