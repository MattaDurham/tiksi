// Fill a room from its walls: the ROOM tool's single click inside a closed wall loop.
//
// Wall centre lines form a planar graph. Walls are split where another wall ends on them
// (a T-junction) or crosses them; a wall that stops short inside another wall's thickness is
// carried on to that wall's centre line; dangling stubs are pruned. Every bounded face of the
// graph is an enclosed area, and a click picks the smallest face that contains it. Corners
// come out on wall centre lines, the project's convention, so the new floor is attached to
// every wall around it (wallmove.js) and follows them when they move. Pure data: callers pass
// the walls of one level.

import { JOIN_TOL, floorCornerAttached } from './wallmove.js';

const PARALLEL = 0.02;   // sin of the angle below which two walls cannot meet end-on
const STRAIGHT = 0.001;  // m: a corner this close to the line through its neighbours is dropped
const MIN_AREA = 0.01;   // m²: smaller faces are slivers between overlapping wall ends

const cross = (ax, ay, bx, by) => ax * by - ay * bx;

function segOf(ax, ay, bx, by, h = 0) {
  const L = Math.hypot(bx - ax, by - ay);
  return { ax, ay, bx, by, L, ux: (bx - ax) / (L || 1), uy: (by - ay) / (L || 1), h };
}

// Short segments that carry a wall end on to the centre line of a wall it stops inside of.
// The end goes straight on along its own wall; when that meeting point lies just past the
// other wall's end (two walls drawn to an outside corner), that wall is carried on too.
function connectors(segs) {
  const out = [];
  for (const j of segs) {
    for (const [px, py, dx, dy] of [[j.ax, j.ay, -j.ux, -j.uy], [j.bx, j.by, j.ux, j.uy]]) {
      if (segs.some(o => o !== j && (Math.hypot(o.ax - px, o.ay - py) < JOIN_TOL || Math.hypot(o.bx - px, o.by - py) < JOIN_TOL))) continue;
      let best = null;
      for (const i of segs) {
        if (i === j) continue;
        const sin = cross(dx, dy, i.ux, i.uy);
        if (Math.abs(sin) < PARALLEL) continue;
        const reach = i.h + JOIN_TOL;
        if (Math.abs(cross(i.ux, i.uy, px - i.ax, py - i.ay)) > reach) continue;   // not inside wall i
        const t = cross(i.ax - px, i.ay - py, i.ux, i.uy) / sin;                   // ahead of the end
        if (t <= 0 || t > 2 * reach) continue;   // behind: the wall already crosses that line
        const x = px + dx * t, y = py + dy * t;
        const s = (x - i.ax) * i.ux + (y - i.ay) * i.uy;
        const slack = j.h + JOIN_TOL;
        if (s < -slack || s > i.L + slack) continue;
        if (!best || t < best.t) best = { t, x, y, i, s };
      }
      if (!best) continue;
      out.push(segOf(px, py, best.x, best.y));
      if (best.s < 0) out.push(segOf(best.i.ax, best.i.ay, best.x, best.y));
      else if (best.s > best.i.L) out.push(segOf(best.i.bx, best.i.by, best.x, best.y));
    }
  }
  return out;
}

// Undirected edges between clustered vertices: every segment is cut wherever another one
// ends on it or crosses it. Dangling stubs bound nothing and are pruned.
function graph(segs) {
  const verts = [];
  const vid = (x, y) => {
    for (let k = 0; k < verts.length; k++) if (Math.hypot(verts[k][0] - x, verts[k][1] - y) < JOIN_TOL) return k;
    verts.push([x, y]);
    return verts.length - 1;
  };
  for (const s of segs) { vid(s.ax, s.ay); vid(s.bx, s.by); }   // ends win as cluster representatives
  const edges = new Set();
  for (const k of segs) {
    const ts = [0, k.L];
    const along = (x, y) => Math.max(0, Math.min(k.L, (x - k.ax) * k.ux + (y - k.ay) * k.uy));
    for (const m of segs) {
      if (m === k) continue;
      for (const [x, y] of [[m.ax, m.ay], [m.bx, m.by]]) {
        const t = along(x, y);
        if (Math.hypot(k.ax + k.ux * t - x, k.ay + k.uy * t - y) < JOIN_TOL) ts.push(t);
      }
      const sin = cross(k.ux, k.uy, m.ux, m.uy);
      if (Math.abs(sin) < 1e-9) continue;
      const tk = cross(m.ax - k.ax, m.ay - k.ay, m.ux, m.uy) / sin;
      const tm = cross(m.ax - k.ax, m.ay - k.ay, k.ux, k.uy) / sin;
      if (tk > -JOIN_TOL && tk < k.L + JOIN_TOL && tm > -JOIN_TOL && tm < m.L + JOIN_TOL) ts.push(Math.max(0, Math.min(k.L, tk)));
    }
    ts.sort((p, q) => p - q);
    let prev = vid(k.ax, k.ay);
    for (const t of ts) {
      const v = vid(k.ax + k.ux * t, k.ay + k.uy * t);
      if (v !== prev) edges.add(Math.min(prev, v) + ':' + Math.max(prev, v));
      prev = v;
    }
  }
  const adj = verts.map(() => new Set());
  for (const e of edges) { const [a, b] = e.split(':').map(Number); adj[a].add(b); adj[b].add(a); }
  const stack = adj.map((n, k) => k).filter(k => adj[k].size === 1);
  while (stack.length) {
    const k = stack.pop();
    for (const n of adj[k]) { adj[n].delete(k); if (adj[n].size === 1) stack.push(n); }
    adj[k].clear();
  }
  return { verts, adj };
}

function signedArea(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
  return a / 2;
}

export function pointInPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Drop corners the outline runs straight through (within `straight` m; a wall meeting it from
// the other side), then start at the top-left corner so the same area always reads the same.
function tidy(pts, straight = STRAIGHT) {
  const out = pts.map(p => [p[0], p[1]]);
  for (let changed = true; changed && out.length > 3;) {
    changed = false;
    for (let i = 0; i < out.length && out.length > 3; i++) {
      const a = out[(i + out.length - 1) % out.length], b = out[i], c = out[(i + 1) % out.length];
      const L = Math.hypot(c[0] - a[0], c[1] - a[1]);
      const off = L > 1e-9 ? Math.abs(cross(c[0] - a[0], c[1] - a[1], b[0] - a[0], b[1] - a[1])) / L : 0;
      if (off < straight && (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]) >= 0) {
        out.splice(i, 1); changed = true; i--;
      }
    }
  }
  let k = 0;
  out.forEach((p, i) => { if (p[1] < out[k][1] - 1e-9 || (Math.abs(p[1] - out[k][1]) <= 1e-9 && p[0] < out[k][0])) k = i; });
  return out.slice(k).concat(out.slice(0, k));
}

// Every area the walls enclose, as {pts, area}. Corners sit on wall centre lines.
export function wallFaces(walls) {
  const segs = walls.map(w => segOf(w.ax, w.ay, w.bx, w.by, (w.thickness || 0.114) / 2)).filter(s => s.L >= JOIN_TOL);
  const { verts, adj } = graph(segs.concat(connectors(segs)));
  // Neighbours in angle order. Walking each edge and taking the most clockwise turn at every
  // vertex traces a face with its inside on the left: positive area when it is bounded.
  const angle = (k, n) => Math.atan2(verts[n][1] - verts[k][1], verts[n][0] - verts[k][0]);
  const order = adj.map((ns, k) => [...ns].sort((p, q) => angle(k, p) - angle(k, q)));
  const seen = new Set(), faces = [];
  order.forEach((ns, u) => ns.forEach(v => {
    const loop = [];
    for (let a = u, b = v; !seen.has(a + ':' + b);) {
      seen.add(a + ':' + b);
      loop.push(verts[a]);
      const around = order[b];
      [a, b] = [b, around[(around.indexOf(a) + around.length - 1) % around.length]];
    }
    if (loop.length < 3 || signedArea(loop) < MIN_AREA) return;
    const pts = tidy(loop);
    faces.push({ pts, area: signedArea(pts) });
  }));
  return faces;
}

// The smallest enclosed area containing (x, y), or null.
export function faceAt(faces, x, y) {
  let best = null;
  for (const f of faces) if ((!best || f.area < best.area) && pointInPolygon(x, y, f.pts)) best = f;
  return best;
}

// The floor outline a click at (x, y) fills, or null when the click is on a wall as drawn or
// outside every closed wall loop. Pass `faces` (from wallFaces) to reuse them between calls.
export function roomFromWalls(walls, x, y, faces = wallFaces(walls)) {
  if (floorCornerAttached(walls, x, y)) return null;
  const f = faceAt(faces, x, y);
  return f ? f.pts.map(p => [p[0], p[1]]) : null;
}

// An existing floor with the same outline (each corner within `tol` of one of the other's,
// ignoring corners an outline runs straight through), or null.
export function sameFloor(rooms, pts, tol = 0.02) {
  const has = (qs, p) => qs.some(q => Math.hypot(q[0] - p[0], q[1] - p[1]) <= tol);
  const mine = tidy(pts, tol);
  return rooms.find(r => {
    if (!r.pts || r.pts.length < 3) return false;
    const qs = tidy(r.pts, tol);
    return qs.length === mine.length && mine.every(p => has(qs, p)) && qs.every(q => has(mine, q));
  }) || null;
}
