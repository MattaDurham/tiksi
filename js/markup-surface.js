// Markup ink on the model's own surfaces, and the line tool's SketchUp-style snapping. Pure
// maths on [x, y, z] arrays (no DOM, no three.js), so Node tests run it; markup-layer.js and
// markup-model.js use it.
//
// World axes are three.js's: y is up. They take SketchUp's colours: red is x, green is z (the
// other horizontal), blue is y (up).

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = a => Math.hypot(a[0], a[1], a[2]);
const unit = a => { const l = len(a); return l > 0 ? scale(a, 1 / l) : [0, 0, 0]; };
const dist2d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const vec = { sub, add, scale, dot, cross, len, unit };

// Where a ray (origin o, direction d) meets the plane through p with normal n, or null when it
// runs along the plane or the plane is behind it.
export function rayPlane(o, d, p, n) {
  const den = dot(d, n);
  if (Math.abs(den) < 1e-6) return null;
  const t = dot(sub(p, o), n) / den;
  return t > 0 ? add(o, scale(d, t)) : null;
}

// The parameter t of the point p + t·dir nearest to a ray (o, d): where the line comes closest
// to what is under the pointer. Null when the two run parallel.
export function lineNearRay(p, dir, o, d) {
  const w = sub(p, o), a = dot(dir, dir), b = dot(dir, d), c = dot(d, d), e = dot(dir, w), f = dot(d, w);
  const den = a * c - b * b;
  if (Math.abs(den) < 1e-9 * a * c) return null;
  return (b * f - c * e) / den;
}
// The point of the segment a–b nearest to a ray.
export function segmentNearRay(a, b, o, d) {
  const dir = sub(b, a), t = lineNearRay(a, dir, o, d);
  return add(a, scale(dir, t === null ? 0 : Math.min(1, Math.max(0, t))));
}

// ---------- freehand ink on surfaces ----------
// A freehand stroke can stay on the face where the pointer first went down. Object identity
// alone is not enough: imported models often put a whole room into one mesh. Keep the starting
// plane and normal as well, allowing a little noise in reconstructed surfaces but not a corner
// or a parallel face elsewhere. The mesh is an in-memory token, never saved with a stroke.
// Points have no face normal; they can only be restricted to their own object. The distance
// discontinuity check in dropOntoSurfaces still prevents them joining across a depth jump.
export function makeSurfaceLock(hit, { planeTolerance = 0.01, angleTolerance = 12 } = {}) {
  if (!hit || !Array.isArray(hit.p) || hit.p.length !== 3 || !hit.p.every(Number.isFinite)) return null;
  const normal = Array.isArray(hit.n) && hit.n.length === 3 && hit.n.every(Number.isFinite) && len(hit.n) > 0.5 ? unit(hit.n) : null;
  const ref = typeof hit.ref === 'string' ? hit.ref : '';
  if (!normal && !hit.mesh && !ref) return null;   // no face or object to identify
  return {
    p: hit.p.slice(), n: normal, mesh: hit.mesh || null, ref, kind: hit.kind || '',
    planeTolerance: Number.isFinite(planeTolerance) && planeTolerance >= 0 ? planeTolerance : 0.01,
    normalDot: Math.cos((Number.isFinite(angleTolerance) ? Math.max(0, Math.min(45, angleTolerance)) : 12) * Math.PI / 180),
  };
}

export function onLockedSurface(lock, hit) {
  if (!lock || !hit || !Array.isArray(hit.p) || hit.p.length !== 3 || !hit.p.every(Number.isFinite)) return false;
  if (lock.mesh && hit.mesh !== lock.mesh) return false;
  if (lock.ref && (hit.ref !== lock.ref || (hit.kind || '') !== lock.kind)) return false;
  const normal = Array.isArray(hit.n) && hit.n.length === 3 && hit.n.every(Number.isFinite) && len(hit.n) > 0.5 ? unit(hit.n) : null;
  if (!lock.n) return !normal;   // never hop from a point cloud onto a mesh face
  if (!normal || Math.abs(dot(lock.n, normal)) < lock.normalDot) return false;
  return Math.abs(dot(sub(hit.p, lock.p), lock.n)) <= lock.planeTolerance;
}

// Samples along a stroke on the screen, each { o, d (its ray), px: [x, y], hit: { p, n } | null }
// (n is null where the surface has no facing, a scan's points), become pieces of 3D line, each
// { w: [x, y, z, ...], first, last } (the samples it covers), lifted `lift` metres off the
// surface so the paint does not hide it.
// - A sample over empty space (a window opening, past the edge of the model) stays on the plane
//   of the surface just before it (or the first one after it, at the start of a stroke).
// - Where neighbouring samples are far apart in the model but close on the screen (the pen
//   crossed the edge of a near wall onto the room behind it), the line breaks: no ink is drawn
//   through the air between them.
// `mPerPx(p)` is how many metres one screen pixel spans at the depth of p. Returns [] when the
// stroke touched nothing at all: it is then ink on the screen, as before.
// With `surfaceLock`, missing hits and hits on other faces are gaps, never projected or joined.
// A stroke starting off a surface must be rejected by the caller rather than given a null lock.
export function dropOntoSurfaces(samples, { lift = 0.004, mPerPx, breakRatio = 10, surfaceLock = null } = {}) {
  const n = samples.length;
  if (!samples.some(s => s.hit)) return [];
  const flat = s => s.hit && s.hit.n && len(s.hit.n) > 0.5;
  const pts = new Array(n).fill(null);
  // The plane each sample over empty space is dropped onto: the last surface with a facing.
  let plane = null;
  const firstFlat = samples.find(flat);
  for (let i = 0; i < n; i++) {
    const s = samples[i];
    if (surfaceLock && !onLockedSurface(surfaceLock, s.hit)) continue;
    if (s.hit) {
      const nn = flat(s) ? unit(s.hit.n) : null;
      // The lift goes towards the viewer: a wall seen from behind is lifted on the seen side.
      const towards = nn ? (dot(nn, s.d) > 0 ? scale(nn, -1) : nn) : scale(unit(s.d), -1);
      pts[i] = add(s.hit.p, scale(towards, lift));
      if (nn) plane = { p: s.hit.p, n: towards };
      continue;
    }
    const pl = plane || (firstFlat ? { p: firstFlat.hit.p, n: dot(firstFlat.hit.n, firstFlat.d) > 0 ? scale(unit(firstFlat.hit.n), -1) : unit(firstFlat.hit.n) } : null);
    const q = pl ? rayPlane(s.o, s.d, pl.p, pl.n) : null;
    if (q) pts[i] = add(q, scale(pl.n, lift));
  }
  // Samples still without a point (no plane to land on, or the plane turned away): the nearest
  // landed point along the stroke stands in for them.
  for (let i = 0; !surfaceLock && i < n; i++) {
    if (pts[i]) continue;
    let k = 1;
    while (k < n && !(pts[i - k] || pts[i + k])) k++;
    pts[i] = (pts[i - k] || pts[i + k] || null);
  }
  // Each piece is { w, first, last }: its points and the samples it was made from.
  const pieces = [];
  let cur = null;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    if (!p) { if (cur) { pieces.push(cur); cur = null; } continue; }
    if (cur) {
      const w = cur.w, prev = [w[w.length - 3], w[w.length - 2], w[w.length - 1]];
      const onScreen = Math.max(1, dist2d(samples[i].px, samples[cur.last].px));
      const reach = mPerPx ? onScreen * mPerPx(add(scale(prev, 0.5), scale(p, 0.5))) : Infinity;
      if (len(sub(p, prev)) > Math.max(0.03, breakRatio * reach)) { pieces.push(cur); cur = null; }
    }
    if (!cur) cur = { w: [], first: i, last: i };
    cur.w.push(p[0], p[1], p[2]); cur.last = i;
  }
  if (cur) pieces.push(cur);
  return pieces;
}

// Fewer points for the same 3D line (Ramer-Douglas-Peucker): a point stays when it is further
// than `tol` metres from the straight line between its kept neighbours. The ends stay.
export function simplify3(pts, tol) {
  const n = Math.floor(pts.length / 3);
  if (n <= 2 || !(tol > 0)) return pts.slice(0, n * 3);
  const at = i => [pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]];
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const A = at(a), D = sub(at(b), A), L2 = dot(D, D);
    let worst = -1, far = 0;
    for (let i = a + 1; i < b; i++) {
      const P = sub(at(i), A), t = L2 > 0 ? Math.min(1, Math.max(0, dot(P, D) / L2)) : 0;
      const d = len(sub(P, scale(D, t)));
      if (d > far) { far = d; worst = i; }
    }
    if (worst > 0 && far > tol) { keep[worst] = 1; stack.push([a, worst], [worst, b]); }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(...at(i));
  return out;
}

// ---------- the line tool's snapping ----------
export const AXES = [
  { d: [1, 0, 0], kind: 'red', label: 'On red axis', color: '#e0312a' },
  { d: [0, 0, 1], kind: 'green', label: 'On green axis', color: '#1a9c4b' },
  { d: [0, 1, 0], kind: 'blue', label: 'On blue axis', color: '#2f6ee5' },
];
export const SNAP_STYLE = {
  endpoint: { label: 'Endpoint', color: '#18a84a' },
  midpoint: { label: 'Midpoint', color: '#19b4d2' },
  edge: { label: 'On edge', color: '#e0312a' },
  face: { label: 'On face', color: '#2f6ee5' },
  parallel: { label: 'Parallel to edge', color: '#d23cc8' },
  perpendicular: { label: 'Perpendicular to edge', color: '#d23cc8' },
  free: { label: '', color: '#111111' },
};
const PT_PX = 12, EDGE_PX = 8, DIR_PX = 10, PLANE_TOL = 0.02, IN_PLANE = 0.03;

// What the next point of a line is, SketchUp's way. `q` = {
//   ray: { o, d }, cursor: [x, y] px, project(p) -> [x, y] | null,
//   hit: { p } | null (the surface under the pointer),
//   prev: the line's last point, or null for its first,
//   plane: { p, n } | null (lines stay on the plane of the face they start on),
//   points: [p, ...] (ends of lines already drawn, this line's own points),
//   edges: [[a, b], ...] (the model's edges near the pointer),
//   refs: [{ d, edge? }, ...] (edges to be parallel or perpendicular to: the one hovered last,
//          this line's last segment),
//   lock: a direction result found earlier ({ dir, kind, label, color }) held with Shift, or null,
//   visible(p) -> false for a point hidden behind a surface (optional) }
// Returns { p, kind, label, color, dir?, edge? } or null when the pointer is over nothing.
// Points win over edges and edges over directions, as in SketchUp; among the same sort the one
// nearest the pointer wins.
export function inferPoint(q) {
  const { ray, cursor, project } = q;
  const plane = q.plane || null;
  const inPlane = p => !plane || Math.abs(dot(sub(p, plane.p), plane.n)) < PLANE_TOL;
  const dirOk = d => !plane || Math.abs(dot(unit(d), plane.n)) < IN_PLANE;
  const away = p => { const s = project(p); return s ? dist2d(s, cursor) : Infinity; };
  // Only what can be seen is snapped to: the edge of a floor under a wall is not.
  const seen = p => !q.visible || q.visible(p);
  const style = (kind, extra) => ({ kind, label: SNAP_STYLE[kind].label, color: SNAP_STYLE[kind].color, ...extra });

  // A held direction: the point is wherever along it the pointer is nearest.
  if (q.lock && q.prev) {
    const t = lineNearRay(q.prev, q.lock.dir, ray.o, ray.d);
    if (t === null) return null;
    return { ...q.lock, p: add(q.prev, scale(q.lock.dir, t)), locked: true };
  }
  // 1. Points: ends and middles of edges, ends of lines already drawn.
  let best = null;
  const tryPoint = (p, kind, edge) => {
    if (!inPlane(p)) return;
    const d = away(p);
    if (d <= PT_PX && (!best || d < best.d) && seen(p)) best = { d, r: style(kind, { p: p.slice(), edge }) };
  };
  for (const p of q.points || []) tryPoint(p, 'endpoint');
  for (const e of q.edges || []) { tryPoint(e[0], 'endpoint', e); tryPoint(e[1], 'endpoint', e); tryPoint(scale(add(e[0], e[1]), 0.5), 'midpoint', e); }
  if (best) return best.r;
  // 2. Along an edge.
  let edge = null;
  for (const e of q.edges || []) {
    if (!inPlane(e[0]) || !inPlane(e[1])) continue;
    const p = segmentNearRay(e[0], e[1], ray.o, ray.d), d = away(p);
    if (d <= EDGE_PX && (!edge || d < edge.d) && seen(p)) edge = { d, r: style('edge', { p, edge: e }) };
  }
  // 3. Directions from the last point: the axes, then parallel and perpendicular to the edges
  //    of reference.
  let dir = null;
  if (q.prev) {
    const dirs = AXES.map(a => ({ d: a.d, r: { kind: a.kind, label: a.label, color: a.color } }));
    for (const ref of q.refs || []) {
      const e = unit(ref.d);
      if (len(e) < 0.5) continue;
      // A direction along an axis is already offered as that axis.
      const onAxis = v => AXES.some(a => Math.abs(Math.abs(dot(a.d, v)) - 1) < 1e-4);
      if (!onAxis(e)) dirs.push({ d: e, r: style('parallel', { edge: ref.edge }) });
      if (plane) {
        const perp = unit(cross(plane.n, e));
        if (len(perp) > 0.5 && !onAxis(perp)) dirs.push({ d: perp, r: style('perpendicular', { edge: ref.edge }) });
      }
    }
    for (const c of dirs) {
      if (!dirOk(c.d)) continue;
      const t = lineNearRay(q.prev, c.d, ray.o, ray.d);
      if (t === null || Math.abs(t) < 1e-4) continue;
      const p = add(q.prev, scale(c.d, t)), d = away(p);
      if (d <= DIR_PX && (!dir || d < dir.d)) dir = { d, r: { ...c.r, p, dir: unit(c.d) } };
    }
  }
  if (edge && (!dir || edge.d <= dir.d)) return edge.r;
  if (dir) return dir.r;
  // 4. On the face (on the line's own plane once it has one).
  if (plane) { const p = rayPlane(ray.o, ray.d, plane.p, plane.n); if (p) return style(q.hit ? 'face' : 'free', { p }); }
  if (q.hit) return style('face', { p: q.hit.p.slice() });
  return null;
}
