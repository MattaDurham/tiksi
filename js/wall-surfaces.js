// The vertical boundary of the joined wall solids in plan and elevation.
// Each edge keeps its original wall and coordinates for finishes, tags and picks.

import { wallEnds, wallFootprint, wallFrame, wallSliceFootprint } from './wall-joins.js';
import { wallSolids } from './wall-solids.js';

const EPS = 1e-8;
const OUT = 1e-6;
const cross = (ax, az, bx, bz) => ax * bz - az * bx;

// Clip a line segment to a clockwise convex polygon. t runs from 0 to 1.
function intersection(a, b, points) {
  let lo = 0, hi = 1;
  const dx = b[0] - a[0], dz = b[1] - a[1];
  for (let i = 0; i < points.length; i++) {
    const [x, z] = points[i], [ex, ez] = points[(i + 1) % points.length];
    const p = cross(ex - x, ez - z, a[0] - x, a[1] - z);
    const q = cross(ex - x, ez - z, dx, dz);
    if (Math.abs(q) < EPS) {
      if (p > EPS) return null;
    } else if (q > 0) hi = Math.min(hi, -p / q);
    else lo = Math.max(lo, -p / q);
    if (hi - lo <= EPS) return null;
  }
  return [lo, hi];
}

function bounds(points) {
  const xs = points.map(p => p[0]), zs = points.map(p => p[1]);
  return [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)];
}

function overlap(a, b) {
  return a[0] <= b[2] + OUT && b[0] <= a[2] + OUT && a[1] <= b[3] + OUT && b[1] <= a[3] + OUT;
}

function outline(footprint, toPlan, L, h) {
  return footprint.flatMap((a, i) => {
    const b = footprint[(i + 1) % footprint.length];
    const A = toPlan(a), B = toPlan(b), dx = B[0] - A[0], dz = B[1] - A[1], length = Math.hypot(dx, dz);
    if (length < EPS) return [];
    const side = a[1] === b[1] && Math.abs(a[1]) === h ? Math.sign(a[1]) : (a[0] + b[0]) / 2 < L / 2 ? 'endA' : 'endB';
    const axis = typeof side === 'number' ? 0 : 1;
    const reverse = a[axis] > b[axis];
    const s0 = Math.min(a[axis], b[axis]), s1 = Math.max(a[axis], b[axis]);
    const [start, end] = reverse ? [b, a] : [a, b];
    return [{ A, B, start, end, s0, s1, side, reverse, length, N: [-dz / length, dx / length],
      box: bounds([A, B]) }];
  });
}

const shifted = (p, n) => [p[0] + n[0] * OUT, p[1] + n[1] * OUT];

function samePlane(a, b) {
  const [nx, nz] = a.N;
  return nx * b.N[0] + nz * b.N[1] >= 1 - EPS &&
    Math.abs((b.A[0] - a.A[0]) * nx + (b.A[1] - a.A[1]) * nz) < EPS;
}

// Prefer a long side when two outlines cover the same plane, then keep a stable
// owner over the shared area. A coincident end uses whatever portion is exposed.
function precedes(a, wall, other, candidate) {
  return typeof a.side === typeof candidate.side
    ? String(other.id) < String(wall.id)
    : typeof candidate.side === 'number';
}

function sections(edge, wall, others, slices, H) {
  const a = shifted(edge.A, edge.N), b = shifted(edge.B, edge.N);
  const [lo, hi] = [edge.s0, edge.s1];
  const toS = t => edge.reverse ? hi - t * (hi - lo) : lo + t * (hi - lo);
  const covered = [];
  for (const other of others) {
    if (wall === other.wall || !overlap(edge.box, other.box)) continue;
    const coincident = other.edges.some(e => samePlane(edge, e) && precedes(edge, wall, other.wall, e));
    for (const slice of other.slices) {
      if (!overlap(edge.box, slice.box)) continue;
      const outward = intersection(a, b, slice.points);
      const hit = (outward || coincident) && (intersection(edge.A, edge.B, slice.points) || outward);
      if (!hit) continue;
      const [x, y] = hit.map(toS);
      covered.push({ s0: Math.min(x, y), s1: Math.max(x, y), v0: slice.v0, v1: slice.v1 });
    }
  }
  const xs = [lo, ...covered.flatMap(r => [r.s0, r.s1]), hi].sort((x, y) => x - y);
  const own = slices.flatMap(slice => {
    const hit = intersection(edge.A, edge.B, slice.points);
    if (!hit) return [];
    const [x, y] = hit.map(toS);
    return [{ s0: Math.min(x, y), s1: Math.max(x, y), v0: slice.v0, v1: slice.v1 }];
  });
  const runs = [];
  for (let i = 1; i < xs.length; i++) {
    const s0 = xs[i - 1], s1 = xs[i], mid = (s0 + s1) / 2;
    if (s1 - s0 < OUT) continue;
    let v0 = 0;
    const open = [];
    for (const cover of covered.filter(r => r.s0 < mid && r.s1 > mid).sort((x, y) => x.v0 - y.v0)) {
      if (cover.v0 > v0) open.push({ s0, s1, v0, v1: Math.min(H, cover.v0) });
      v0 = Math.max(v0, cover.v1);
      if (v0 >= H) break;
    }
    if (v0 < H) open.push({ s0, s1, v0, v1: H });
    if (!open.length) continue;
    const run = runs.at(-1);
    if (run && s0 - run.s1 < OUT) { run.s1 = s1; run.open.push(...open); }
    else runs.push({ s0, s1, open });
  }
  return runs.map(run => ({ ...run, cells: run.open.flatMap(o => own.flatMap(r => {
    const s0 = Math.max(o.s0, r.s0), s1 = Math.min(o.s1, r.s1);
    const v0 = Math.max(o.v0, r.v0), v1 = Math.min(o.v1, r.v1);
    return s1 - s0 > OUT && v1 - v0 > OUT ? [{ s0, s1, v0, v1 }] : [];
  })) }));
}

export function wallSurfaces(walls, byWall, heightOf) {
  const data = [];
  for (const wall of walls) {
    const f = wallFrame(wall);
    if (f.L < 0.01) continue;
    const toPlan = ([x, z]) => [wall.ax + f.ux * x + f.nx * z, wall.ay + f.uy * x + f.ny * z];
    const ends = wallEnds(wall, walls, 0), foot = wallFootprint(ends, f.h);
    const { solids, H } = wallSolids(wall, byWall.get(wall.id) || [], heightOf(wall));
    const slices = solids.flatMap(s => {
      const points = wallSliceFootprint(s, f, ends).map(toPlan);
      return points.length < 3 ? [] : [{ ...s, points, box: bounds(points) }];
    });
    data.push({ wall, f, H, edges: outline(foot, toPlan, f.L, f.h), slices, box: bounds(foot.map(toPlan)) });
  }
  return data.flatMap(({ wall, f, edges, slices, H }) => edges.flatMap(edge =>
    sections(edge, wall, data, slices, H).map(run => ({ wall, f, edge, H, ...run }))));
}
