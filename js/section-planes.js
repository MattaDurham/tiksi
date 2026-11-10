// Section planes: the cuts MODEL makes through the building. Pure data and math only (no DOM,
// no three.js), so Node tests run it; viewer3d.js draws each plane as a transparent floating
// sheet with move and rotate handles and clips the model with it.
//
// A plane = { id, kind, q: [x, y, z, w], pos: [x, y, z] } in world metres (y up, plan y = world z).
// It passes through `pos`; its local +Z, turned by the quaternion `q`, points at the part that
// is cut away. `kind` is only where it started: 'level' cuts the top off and slides up and down,
// 'side' slides side to side (along world x), 'front' slides front to back (along world z), and
// 'custom' starts facing the camera. Every kind can be moved and rotated afterwards.

export const SECTION_KINDS = ['level', 'side', 'front', 'custom'];
export const SECTION_LABELS = { level: 'UP AND DOWN', side: 'SIDE TO SIDE', front: 'FRONT TO BACK', custom: 'CUSTOM' };
export const MAX_SECTIONS = 6;
export const TURN_SNAP_DEG = 15;
const M_PER_IN = 0.0254;
const R = Math.SQRT1_2;
const ID_RE = /^[\w.:-]{1,80}$/;
const num = v => (typeof v === 'number' || (typeof v === 'string' && v.trim())) ? Number(v) : NaN;

// How far a snapped plane moves per step: 5 cm, or 1 inch in feet and inches.
export function moveSnapStep(units) { return units === 'metric' ? 0.05 : M_PER_IN; }
export function snapTo(v, step) { return step > 0 ? Math.round(v / step) * step : v; }

// ---------- quaternions as [x, y, z, w] ----------
export function quatRotate(q, v) {
  const [x, y, z, w] = q, [vx, vy, vz] = v;
  const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
  return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)];
}
export function quatMul(a, b) {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
}
function quatUnit(q) {
  const l = Math.hypot(q[0], q[1], q[2], q[3]);
  if (Math.abs(l - 1) < 1e-9) return q.slice();   // already unit: reading a file back changes nothing
  return l > 1e-9 ? q.map(c => c / l) : [0, 0, 0, 1];
}
const yawQuat = a => [0, Math.sin(a / 2), 0, Math.cos(a / 2)];

// Where each kind starts: the cut-away side is up, +x, +z, or the side nearest the camera.
// `forward` is the camera's viewing direction; with `snap` the custom plane's compass angle
// lands on a multiple of TURN_SNAP_DEG.
export function startQuat(kind, forward, snap) {
  if (kind === 'level') return [-R, 0, 0, R];
  if (kind === 'side') return [0, R, 0, R];
  if (kind === 'custom' && forward && Math.hypot(forward[0], forward[2]) > 1e-6) {
    let yaw = Math.atan2(-forward[0], -forward[2]);
    if (snap) yaw = snapTo(yaw, TURN_SNAP_DEG * Math.PI / 180);
    return yawQuat(yaw);
  }
  return [0, 0, 0, 1];
}

// The plane as n . p = d; a point with n . p > d is cut away.
export function planeNormal(q) { return quatRotate(q, [0, 0, 1]); }
export function planeOf(sec) {
  const n = planeNormal(sec.q);
  return { n, d: n[0] * sec.pos[0] + n[1] * sec.pos[1] + n[2] * sec.pos[2] };
}
// Turn the plane over: the other side is cut away. Half a turn about the plane's own x axis.
export function flipped(q) { return quatUnit(quatMul(q, [1, 0, 0, 0])); }

// The reach of a box { min: [x, y, z], max: [x, y, z] } along a direction: where a plane with
// that normal first touches the box and where it leaves it.
export function rangeAlong(n, box) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < 8; i++) {
    const d = n[0] * (i & 1 ? box.max[0] : box.min[0]) + n[1] * (i & 2 ? box.max[1] : box.min[1]) + n[2] * (i & 4 ? box.max[2] : box.min[2]);
    lo = Math.min(lo, d); hi = Math.max(hi, d);
  }
  return [lo, hi];
}
// The point on the plane nearest `p`: the sheet is drawn centred there so it always covers the model.
export function nearestOnPlane(sec, p) {
  const { n, d } = planeOf(sec);
  const k = d - (n[0] * p[0] + n[1] * p[1] + n[2] * p[2]);
  return [p[0] + n[0] * k, p[1] + n[1] * k, p[2] + n[2] * k];
}
// Slide the plane along its own normal until it sits at distance `d` from the world origin.
export function movedTo(sec, d) {
  const { n, d: now } = planeOf(sec);
  return sec.pos.map((c, i) => c + n[i] * (d - now));
}

// ---------- cutting a wall solid ----------
// The polygon where the plane n . p = d crosses an upright prism: `footprint` is its plan
// outline as [x, z] corners, standing from y0 to y1. Returns the corners as [x, y, z] in order
// round the polygon, or null when the plane misses the prism (or only grazes an edge).
export function cutPrism(footprint, y0, y1, n, d) {
  const k = footprint.length;
  if (k < 3 || !(y1 > y0)) return null;
  const V = [];
  for (const y of [y0, y1]) for (const [x, z] of footprint) V.push([x, y, z]);
  const S = V.map(p => n[0] * p[0] + n[1] * p[1] + n[2] * p[2] - d);
  const EPS = 1e-7, pts = [];
  const add = p => { if (!pts.some(o => Math.abs(o[0] - p[0]) + Math.abs(o[1] - p[1]) + Math.abs(o[2] - p[2]) < 1e-6)) pts.push(p); };
  const edge = (a, b) => {
    const sa = S[a], sb = S[b];
    if (Math.abs(sa) <= EPS) add(V[a]);
    if (Math.abs(sb) <= EPS) add(V[b]);
    if ((sa > EPS && sb < -EPS) || (sa < -EPS && sb > EPS)) {
      const t = sa / (sa - sb);
      add([V[a][0] + (V[b][0] - V[a][0]) * t, V[a][1] + (V[b][1] - V[a][1]) * t, V[a][2] + (V[b][2] - V[a][2]) * t]);
    }
  };
  for (let i = 0; i < k; i++) {
    const j = (i + 1) % k;
    edge(i, j); edge(k + i, k + j); edge(i, k + i);
  }
  if (pts.length < 3) return null;
  // Order the corners by angle round their centre, measured in the plane.
  const c = [0, 1, 2].map(i => pts.reduce((s, p) => s + p[i], 0) / pts.length);
  const ref = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let u = [ref[1] * n[2] - ref[2] * n[1], ref[2] * n[0] - ref[0] * n[2], ref[0] * n[1] - ref[1] * n[0]];
  const ul = Math.hypot(u[0], u[1], u[2]) || 1;
  u = u.map(x => x / ul);
  const v = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
  const ang = p => Math.atan2((p[0] - c[0]) * v[0] + (p[1] - c[1]) * v[1] + (p[2] - c[2]) * v[2], (p[0] - c[0]) * u[0] + (p[1] - c[1]) * u[1] + (p[2] - c[2]) * u[2]);
  return pts.map(p => [p, ang(p)]).sort((a, b) => a[1] - b[1]).map(x => x[0]);
}

// ---------- stored planes (saved views) ----------
let counter = 0;
export const newSectionId = () => 'cut-' + Date.now().toString(36) + (counter++).toString(36) + Math.random().toString(36).slice(2, 6);
export function makeSection(kind, pos, forward, snap) {
  return { id: newSectionId(), kind: SECTION_KINDS.includes(kind) ? kind : 'custom', q: startQuat(kind, forward, snap), pos: pos.slice(0, 3) };
}
const vec = (v, n) => Array.isArray(v) && v.length === n && v.every(x => Number.isFinite(num(x)) && Math.abs(num(x)) < 1e6) ? v.map(num) : null;
// Planes as a saved view keeps them: anything unusable is dropped, never guessed at.
export function normalizeSections(list) {
  const out = [], taken = new Set();
  for (const s of Array.isArray(list) ? list : []) {
    if (out.length >= MAX_SECTIONS || !s || typeof s !== 'object') continue;
    const q = vec(s.q, 4), pos = vec(s.pos, 3);
    if (!q || !pos || Math.hypot(...q) < 1e-6) continue;
    let id = typeof s.id === 'string' && ID_RE.test(s.id) && !taken.has(s.id) ? s.id : newSectionId();
    while (taken.has(id)) id = newSectionId();
    taken.add(id);
    out.push({ id, kind: SECTION_KINDS.includes(s.kind) ? s.kind : 'custom', q: quatUnit(q), pos });
  }
  return out;
}
// The height of the first flat, top-off plane, for files read by a version that only knows
// one cut height; null when there is none.
export function levelHeightOf(list) {
  for (const s of list || []) { const n = planeNormal(s.q); if (n[1] > 0.9999) return s.pos[1]; }
  return null;
}
