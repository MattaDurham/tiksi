// Room faces: the wall surfaces a room actually shows, each one flat run from inside corner to
// inside corner, however the walls behind it were drawn. MODEL draws and selects walls by
// these faces, and its panel totals them (square feet gross and net of openings, face length
// and baseboard length). Pure plan maths, no three.js and no workspace state: callers pass one
// level's walls, rooms and openings.
//
// A wall's long side, as built (its ends trimmed at every joint by wall-joins.js), is cut where
// another wall butts into it, and where the room in front of it changes. Each piece belongs to
// the room in front of it; a piece with no room in front but one behind is the outside of the
// house. Pieces of the same room that lie on one line and touch (one straight run drawn as two
// walls) join into one face. A face never includes a wall's top, bottom or ends, or the reveals
// of its openings: those are the wall's, and belong to no room.
//
// Plan coordinates are metres, x east and y south. Each face lists its `parts`: the wall, the
// side (+1 is the side the normal (-uy, ux) of a -> b points to) and the span [s0, s1] along
// the wall where the face lies on it. Faces carry stable ids made from their room and first
// part, so a selection survives a rebuild that leaves the walls alone.

import { wallFrame, wallEnds } from './wall-joins.js';
import { openingSpans, pointInPoly } from './wall-solids.js';

const JOIN_TOL = 0.012;     // m: as wall-joins.js, ends this close share a joint
const MIN_PART = 0.01;      // m: a sliver shorter than this is no face
const PROBE = 0.05;         // m past the face where the room in front is looked for
const STEP = 0.05;          // m between probes along a face, to find where its room changes
const LINE_TOL = 0.002;     // m: parts this close in line and gap are one straight run

const BURY = 0.0005;        // m: wall-joins.js tucks an end this far into a wall it butts into mid-span

const roomAt = (rooms, x, y) => rooms.find(r => r.pts && r.pts.length > 2 && pointInPoly(x, y, r.pts)) || null;

// Where the line through p with direction d meets the line through q with direction e, as a
// parameter along d; null for parallel lines.
function hitAlong(px, py, dx, dy, qx, qy, ex, ey) {
  const den = dx * ey - dy * ex;
  if (Math.abs(den) < 1e-9) return null;
  return ((qx - px) * ey - (qy - py) * ex) / den;
}

// The spans along wall w's side `side` that other walls butt into, in w's own coordinate.
function abutted(w, f, side, walls) {
  const out = [];
  const fx = w.ax + f.nx * f.h * side, fy = w.ay + f.ny * f.h * side;   // a point on the face line
  for (const o of walls) {
    if (o === w || o.id === w.id) continue;
    const g = wallFrame(o);
    if (g.L < 0.01) continue;
    for (const [px, py, qx, qy] of [[o.ax, o.ay, o.bx, o.by], [o.bx, o.by, o.ax, o.ay]]) {
      // A joint at one of w's own ends is closed by the mitres already.
      if (Math.hypot(px - w.ax, py - w.ay) < JOIN_TOL || Math.hypot(px - w.bx, py - w.by) < JOIN_TOL) continue;
      const t = (px - w.ax) * f.ux + (py - w.ay) * f.uy, d = (px - w.ax) * f.nx + (py - w.ay) * f.ny;
      if (Math.abs(d) > f.h + JOIN_TOL || t < -JOIN_TOL || t > f.L + JOIN_TOL) continue;
      if (((qx - w.ax) * f.nx + (qy - w.ay) * f.ny) * side <= f.h) continue;    // runs off the other side
      const ts = [-1, 1].map(k => hitAlong(fx, fy, f.ux, f.uy, px + g.nx * g.h * k, py + g.ny * g.h * k, g.ux, g.uy)).filter(v => v != null);
      if (ts.length === 2) out.push([Math.min(...ts), Math.max(...ts)]);
    }
  }
  return out.sort((a, b) => a[0] - b[0]);
}

// Whether wall w's end at (px, py) stops against another wall it meets mid-span.
function butts(w, px, py, walls) {
  for (const o of walls) {
    if (o === w || o.id === w.id) continue;
    if (Math.hypot(o.ax - px, o.ay - py) < JOIN_TOL || Math.hypot(o.bx - px, o.by - py) < JOIN_TOL) return false;
  }
  return walls.some(o => {
    if (o === w || o.id === w.id) return false;
    const g = wallFrame(o);
    const t = (px - o.ax) * g.ux + (py - o.ay) * g.uy, d = Math.abs((px - o.ax) * g.nx + (py - o.ay) * g.ny);
    return t > JOIN_TOL && t < g.L - JOIN_TOL && d < g.h + JOIN_TOL;
  });
}

// [x0, x1] minus the sorted spans.
function subtract(x0, x1, spans) {
  const out = [];
  let cur = x0;
  for (const [a, b] of spans) {
    if (b <= cur) continue;
    if (a >= x1) break;
    if (a > cur) out.push([cur, Math.min(a, x1)]);
    cur = Math.max(cur, b);
  }
  if (cur < x1) out.push([cur, x1]);
  return out.filter(([a, b]) => b - a >= MIN_PART);
}

// What lies in front of wall w's side at s: a room, the outside (a room behind it only), or nothing.
function frontAt(w, f, side, s, rooms) {
  const cx = w.ax + f.ux * s, cy = w.ay + f.uy * s, off = f.h + PROBE;
  const front = roomAt(rooms, cx + f.nx * off * side, cy + f.ny * off * side);
  if (front) return { key: 'room:' + front.id, room: front };
  // Behind, looked for within the wall's own length: an outside corner runs past the room.
  const sb = Math.min(Math.max(s, Math.min(PROBE, f.L / 2)), f.L - Math.min(PROBE, f.L / 2));
  const bx = w.ax + f.ux * sb, by = w.ay + f.uy * sb;
  const back = roomAt(rooms, bx - f.nx * off * side, by - f.ny * off * side);
  return back ? { key: 'outside', room: null } : { key: 'none', room: null };
}

// Split [a, b] where the room in front changes, to the millimetre.
function splitByRoom(w, f, side, a, b, rooms) {
  const runs = [];
  const n = Math.max(1, Math.ceil((b - a) / STEP));
  let start = a, cur = frontAt(w, f, side, Math.min(b, a + 0.005), rooms);
  for (let i = 1; i <= n; i++) {
    const s = i === n ? b - 0.005 : a + (b - a) * i / n;
    const here = frontAt(w, f, side, s, rooms);
    if (here.key === cur.key) continue;
    let lo = a + (b - a) * (i - 1) / n, hi = s;
    for (let k = 0; k < 14; k++) { const m = (lo + hi) / 2; if (frontAt(w, f, side, m, rooms).key === cur.key) lo = m; else hi = m; }
    runs.push({ s0: start, s1: hi, front: cur });
    start = hi; cur = here;
  }
  runs.push({ s0: start, s1: b, front: cur });
  return runs.filter(r => r.s1 - r.s0 >= MIN_PART);
}

// Compass word for a plan direction (x east, y south).
function compass(dx, dy) { return Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'east' : 'west') : (dy > 0 ? 'south' : 'north'); }

// One level's faces. `heightOf(wall)` is the wall's height (defaults to wall.height or 2.44 m).
export function roomFaces({ walls = [], rooms = [], openings = [], heightOf } = {}) {
  const H = w => (heightOf ? heightOf(w) : w.height) || 2.44;
  const parts = [];
  for (const w of walls) {
    const f = wallFrame(w);
    if (f.L < 0.01) continue;
    const ends = wallEnds(w, walls, 0);
    // An end that butts into another wall mid-span is tucked a hair inside it, so the faces
    // never share a plane; the face itself stops at that wall's face.
    const tuckA = butts(w, w.ax, w.ay, walls) ? BURY : 0, tuckB = butts(w, w.bx, w.by, walls) ? BURY : 0;
    for (const side of [1, -1]) {
      const x0 = (side > 0 ? ends.a.pos : ends.a.neg) + tuckA, x1 = (side > 0 ? ends.b.pos : ends.b.neg) - tuckB;
      if (x1 - x0 < MIN_PART) continue;
      for (const [a, b] of subtract(x0, x1, abutted(w, f, side, walls))) {
        for (const run of splitByRoom(w, f, side, a, b, rooms)) {
          // The face's own direction: N points away from the wall into what is in front.
          const Nx = f.nx * side, Ny = f.ny * side;
          const px = w.ax + f.nx * f.h * side, py = w.ay + f.ny * f.h * side;
          // Along the face, left to right as seen from in front of it: T = (-Ny, Nx).
          const Tx = -Ny, Ty = Nx;
          const pa = [px + f.ux * run.s0, py + f.uy * run.s0], pb = [px + f.ux * run.s1, py + f.uy * run.s1];
          const ta = pa[0] * Tx + pa[1] * Ty, tb = pb[0] * Tx + pb[1] * Ty;
          parts.push({ wall: w, wallId: w.id, side, s0: run.s0, s1: run.s1, front: run.front, H: H(w),
            N: [Nx, Ny], T: [Tx, Ty], c: px * Nx + py * Ny, t0: Math.min(ta, tb), t1: Math.max(ta, tb),
            p0: ta <= tb ? pa : pb, p1: ta <= tb ? pb : pa });
        }
      }
    }
  }
  // Join parts of one room on one straight line that touch.
  // Sorted so the parts of one straight run come together, left to right (angles and lines
  // compared to a hair, so float noise cannot split a run).
  const q = (v, k) => Math.round(v / k);
  parts.sort((p, r) => p.front.key.localeCompare(r.front.key) || q(Math.atan2(p.N[1], p.N[0]), 1e-4) - q(Math.atan2(r.N[1], r.N[0]), 1e-4) || q(p.c, LINE_TOL) - q(r.c, LINE_TOL) || p.t0 - r.t0);
  const groups = [];
  for (const p of parts) {
    const g = groups[groups.length - 1], last = g && g[g.length - 1];
    const joins = last && last.front.key === p.front.key && last.N[0] * p.N[0] + last.N[1] * p.N[1] > 0.99999 &&
      Math.abs(last.c - p.c) < LINE_TOL && Math.abs(last.H - p.H) < LINE_TOL && p.t0 - last.t1 < LINE_TOL && p.t0 > last.t0;
    if (joins) g.push(p); else groups.push([p]);
  }
  const byWall = new Map();
  for (const o of openings) { if (!byWall.has(o.wallId)) byWall.set(o.wallId, []); byWall.get(o.wallId).push(o); }
  return groups.map(g => {
    const first = g[0], last = g[g.length - 1], height = first.H;
    const length = g.reduce((n, p) => n + (p.s1 - p.s0), 0);
    const holes = [];
    for (const p of g) {
      const L = wallFrame(p.wall).L;
      for (const { s0, s1, o } of openingSpans(p.wall, byWall.get(p.wallId) || [], L)) {
        const a = Math.max(s0, p.s0), b = Math.min(s1, p.s1);
        if (b - a < 0.001) continue;
        const bottom = o.type === 'window' ? Math.max(0, o.sill || 0) : 0, top = Math.min(height, bottom + (o.height || 0));
        if (top <= bottom) continue;
        holes.push({ id: o.id, type: o.type === 'window' ? 'window' : 'door', wallId: p.wallId, width: b - a, area: (b - a) * (top - bottom) });
      }
    }
    const gross = length * height, openingArea = holes.reduce((n, h) => n + h.area, 0);
    const doorWidth = holes.filter(h => h.type === 'door').reduce((n, h) => n + h.width, 0);
    const room = first.front.room;
    const kind = room ? 'room' : first.front.key;     // 'room' | 'outside' | 'none'
    // A room's wall is named by where it stands in the room (the kitchen's north wall faces
    // south); an outside face by the way it looks.
    const where = room ? compass(-first.N[0], -first.N[1]) : compass(first.N[0], first.N[1]);
    const label = room ? (room.name || 'Room') + ', ' + where + ' wall' : kind === 'outside' ? 'Outside, ' + where + ' face' : 'No room, ' + where + ' face';
    return {
      id: 'face:' + (room ? room.id : kind) + ':' + first.wallId + ':' + (first.side > 0 ? 'p' : 'n') + ':' + Math.round(first.s0 * 1000),
      kind, roomId: room ? room.id : null, label, compass: where,
      normal: first.N.slice(), a: first.p0.slice(), b: last.p1.slice(), height,
      parts: g.map(p => ({ wallId: p.wallId, side: p.side, s0: p.s0, s1: p.s1 })),
      length, gross, net: gross - openingArea, openings: holes, openingArea,
      baseboard: Math.max(0, length - doorWidth),
    };
  });
}

// Totals for several faces: what MODEL's panel shows for a selection.
export function faceTotals(faces) {
  const sum = k => faces.reduce((n, f) => n + f[k], 0);
  return { count: faces.length, length: sum('length'), gross: sum('gross'), net: sum('net'), baseboard: sum('baseboard'),
    openings: new Set(faces.flatMap(f => f.openings.map(o => f.id + '|' + o.id))).size };
}
