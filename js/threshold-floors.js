// Floor infill through internal doorways. This is derived display geometry, not a new room:
// only the empty area between floors already present on both sides is filled. Splitting at
// room-edge intersections keeps the patches exact for angled/nonrectangular room outlines.
import { openingSpans } from './wall-solids.js';

const EPS = 1e-9;
const NEAR_FACE = 0.08; // tolerate a room outline stopping a little behind the wall face
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const at = (edge, s) => edge.a[1] + (s - edge.a[0]) * (edge.b[1] - edge.a[1]) / (edge.b[0] - edge.a[0]);

function intersections(edges, s0, s1, reach) {
  const events = [s0, s1];
  const add = s => { if (s > s0 + EPS && s < s1 - EPS) events.push(s); };
  for (const e of edges) {
    add(e.a[0]); add(e.b[0]);
    // Boundary selection changes where a room edge crosses either side's probe.
    if (Math.abs(e.b[1] - e.a[1]) > EPS) for (const t of [-reach, reach]) {
      const f = (t - e.a[1]) / (e.b[1] - e.a[1]);
      if (f > 0 && f < 1) add(e.a[0] + f * (e.b[0] - e.a[0]));
    }
  }
  // Overlapping room polygons can exchange which edge bounds their union inside a strip.
  for (let i = 0; i < edges.length; i++) for (let j = i + 1; j < edges.length; j++) {
    const a = edges[i], b = edges[j], da = sub(a.b, a.a), db = sub(b.b, b.a);
    const den = cross(da, db);
    if (Math.abs(den) < EPS) continue;
    const d = sub(b.a, a.a), u = cross(d, db) / den, v = cross(d, da) / den;
    if (u > 0 && u < 1 && v > 0 && v < 1) add(a.a[0] + u * da[0]);
  }
  return events.sort((a, b) => a - b).filter((s, i, all) => !i || s - all[i - 1] > EPS);
}

function coverage(localRooms, s) {
  const intervals = [];
  for (const r of localRooms) {
    const crossings = r.edges.filter(e => s > Math.min(e.a[0], e.b[0]) && s < Math.max(e.a[0], e.b[0]))
      .map(edge => ({ edge, t: at(edge, s) })).sort((a, b) => a.t - b.t);
    for (let i = 0; i + 1 < crossings.length; i += 2) {
      intervals.push({ lo: crossings[i], hi: crossings[i + 1], left: r.room, right: r.room });
    }
  }
  intervals.sort((a, b) => a.lo.t - b.lo.t || b.hi.t - a.hi.t);
  const merged = [];
  for (const span of intervals) {
    const prev = merged[merged.length - 1];
    if (!prev || span.lo.t > prev.hi.t + EPS) merged.push({ ...span });
    else if (span.hi.t > prev.hi.t) { prev.hi = span.hi; prev.right = span.right; }
  }
  return merged;
}

// Input can be a single-level view or a property with explicit level ids. Output polygons
// lie at their room's floor datum and retain its material/id so the renderer and SketchUp
// mirror can include them without inflating room counts or changing the saved floor plan.
export function thresholdFloors({ walls = [], openings = [], rooms = [] } = {}) {
  const out = [];
  for (const wall of walls) {
    const dx = wall.bx - wall.ax, dy = wall.by - wall.ay, L = Math.hypot(dx, dy);
    if (!(L > 0.01)) continue;
    const ux = dx / L, uy = dy / L, nx = -uy, ny = ux;
    const toLocal = ([x, y]) => [(x - wall.ax) * ux + (y - wall.ay) * uy, (x - wall.ax) * nx + (y - wall.ay) * ny];
    const toPlan = ([s, t]) => [wall.ax + ux * s + nx * t, wall.ay + uy * s + ny * t];
    const localRooms = rooms.filter(r => r.pts?.length >= 3 && !(wall.level && r.level && wall.level !== r.level)).map(room => {
      const pts = room.pts.map(toLocal);
      return { room, edges: pts.map((a, i) => ({ a, b: pts[(i + 1) % pts.length] })) };
    });
    const reach = (wall.thickness || 0.114) / 2 + NEAR_FACE;
    for (const { o, s0, s1 } of openingSpans(wall, openings, L)) {
      if (o.type === 'window' || o.floorContinuity === false) continue;
      const relevant = localRooms.filter(r => r.edges.some(e => Math.max(e.a[0], e.b[0]) >= s0 && Math.min(e.a[0], e.b[0]) <= s1));
      const edges = relevant.flatMap(r => r.edges).filter(e =>
        Math.max(e.a[0], e.b[0]) >= s0 && Math.min(e.a[0], e.b[0]) <= s1 &&
        Math.max(e.a[1], e.b[1]) >= -reach && Math.min(e.a[1], e.b[1]) <= reach);
      const events = intersections(edges, s0, s1, reach);
      for (let i = 0; i + 1 < events.length; i++) {
        const a = events[i], b = events[i + 1], middle = (a + b) / 2;
        if (b - a < EPS) continue;
        const spans = coverage(relevant, middle);
        const first = spans.findIndex(p => p.lo.t <= -reach + EPS && p.hi.t >= -reach - EPS);
        const last = spans.findIndex(p => p.lo.t <= reach + EPS && p.hi.t >= reach - EPS);
        // No exterior doorstep, speculative stair landing, or floor across an unknown void.
        if (first < 0 || last <= first) continue;
        for (let j = first; j < last; j++) {
          const left = spans[j], right = spans[j + 1];
          if (right.lo.t - left.hi.t < EPS) continue;
          const low = [at(left.hi.edge, a), at(left.hi.edge, b)];
          const high = [at(right.lo.edge, a), at(right.lo.edge, b)];
          const mid = [(low[0] + high[0]) / 2, (low[1] + high[1]) / 2];
          const emit = (lo, hi, room) => {
            const pts = [[a, lo[0]], [b, lo[1]], [b, hi[1]], [a, hi[0]]].map(toPlan);
            out.push({ id: `${o.id}:floor:${out.length}`, openingId: o.id, wallId: wall.id,
              roomId: room.id, level: room.level, material: room.material, pts });
          };
          if (left.right.id === right.left.id) emit(low, high, left.right);
          else { emit(low, mid, left.right); emit(mid, high, right.left); }
        }
      }
    }
  }
  return out;
}
