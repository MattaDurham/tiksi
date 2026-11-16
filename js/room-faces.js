// Room faces: the wall surfaces a room actually shows, each one flat run from inside corner to
// inside corner, however the walls behind it were drawn. MODEL draws and selects walls by
// these faces, and its panel totals them (square feet gross and net of openings, face length
// and baseboard length). Pure plan maths, no three.js and no workspace state: callers pass one
// level's walls, rooms and openings.
//
// Use the exposed edges of the joined wall solids, including their ends. A face
// combines adjacent surfaces of a room along a run, up to its inside corners.
// Plan is x east, y south. In a part, s is local wall x on a long side, and
// local cross-wall z on a return. Cells describe the wall that physically shows.

import { openingSpans, pointInPoly } from './wall-solids.js';
import { wallSurfaces } from './wall-surfaces.js';

const PROBE = 0.05;
const TOUCH = 0.0015;
const SMALL_STEP = 0.025;
const PARALLEL = 0.99999;

const roomAt = (rooms, x, y) => rooms.find(r => r.pts && r.pts.length > 2 && pointInPoly(x, y, r.pts)) || null;

function pointOn(edge, s) {
  const t = (s - edge.s0) / (edge.s1 - edge.s0);
  const [a, b] = edge.reverse ? [edge.B, edge.A] : [edge.A, edge.B];
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

function frontAt({ wall, f, edge }, s, rooms) {
  const [x, y] = pointOn(edge, s), [nx, ny] = edge.N;
  const room = roomAt(rooms, x + nx * PROBE, y + ny * PROBE);
  if (room) return { key: 'room:' + room.id, room };
  let back;
  if (typeof edge.side === 'number') {
    const sb = Math.min(Math.max(s, Math.min(PROBE, f.L / 2)), f.L - Math.min(PROBE, f.L / 2));
    back = roomAt(rooms, wall.ax + f.ux * sb - nx * (f.h + PROBE), wall.ay + f.uy * sb - ny * (f.h + PROBE));
  } else {
    back = roomAt(rooms, x - nx * PROBE, y - ny * PROBE);
  }
  return { key: back ? 'outside' : 'none', room: null };
}

function splitByRoom(surface, rooms) {
  const { s0: a, s1: b, edge, f } = surface, runs = [], cuts = [a, b];
  const [x, y] = pointOn(edge, a), [ex, ey] = pointOn(edge, b);
  const dx = ex - x, dy = ey - y, [nx, ny] = edge.N;
  for (const offset of [PROBE, -(typeof edge.side === 'number' ? f.h * 2 + PROBE : PROBE)]) {
    const px = x + nx * offset, py = y + ny * offset;
    for (const { pts = [] } of rooms) for (let i = 0; i < pts.length; i++) {
      const [qx, qy] = pts[i], [rx, ry] = pts[(i + 1) % pts.length];
      const ux = rx - qx, uy = ry - qy, den = dx * uy - dy * ux;
      if (Math.abs(den) < 1e-10) continue;
      const t = ((qx - px) * uy - (qy - py) * ux) / den;
      const u = ((qx - px) * dy - (qy - py) * dx) / den;
      if (t > 0 && t < 1 && u >= 0 && u <= 1) cuts.push(a + (b - a) * t);
    }
  }
  cuts.sort((a, b) => a - b);
  for (let i = 1; i < cuts.length; i++) {
    const s0 = cuts[i - 1], s1 = cuts[i];
    if (s1 - s0 < 1e-8) continue;
    const front = frontAt(surface, (s0 + s1) / 2, rooms), prev = runs.at(-1);
    if (prev?.front.key === front.key) prev.s1 = s1;
    else runs.push({ s0, s1, front });
  }
  return runs;
}

const close = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < TOUCH;
const parallel = (a, b) => a.N[0] * b.N[0] + a.N[1] * b.N[1] > PARALLEL;

function groupsAlongWalls(parts) {
  for (const p of parts) {
    if (p.front.key !== 'none' || p.length > SMALL_STEP) continue;
    const neighbours = parts.filter(q => q.front.room && parallel(p, q) && (close(p.p0, q.p1) || close(p.p1, q.p0)));
    if (neighbours.length === 1) p.front = neighbours[0].front;
  }
  const sameRoom = (a, b) => a.front.key === b.front.key && Math.abs(a.H - b.H) < TOUCH;
  const joins = (a, b) => sameRoom(a, b) && parallel(a, b) && close(a.p1, b.p0);
  // A shallow built step connects two parts facing the same way. Include the
  // actual step in that face, along with both surfaces on either side of it.
  const steps = new Map();
  for (const step of parts) {
    if (step.length > SMALL_STEP) continue;
    const before = parts.find(p => p !== step && p.length > SMALL_STEP && sameRoom(p, step) && close(p.p1, step.p0));
    if (!before) continue;
    const after = parts.find(p => p !== step && p !== before && p.length > SMALL_STEP &&
      sameRoom(p, step) && parallel(before, p) && close(step.p1, p.p0));
    if (after) steps.set(step, { before, after });
  }
  const groups = [], todo = new Set(parts);
  const append = (a, b) => joins(a, b) || steps.get(a)?.after === b || steps.get(b)?.before === a;
  for (const p of parts) {
    if (!todo.delete(p)) continue;
    const chain = [p];
    for (let next; (next = [...todo].find(q => append(q, chain[0]) || append(chain.at(-1), q)));) {
      todo.delete(next);
      if (append(next, chain[0])) chain.unshift(next);
      else chain.push(next);
    }
    groups.push(chain);
  }
  return groups;
}

// Compass word for a plan direction (x east, y south).
function compass(dx, dy) { return Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'east' : 'west') : (dy > 0 ? 'south' : 'north'); }

// One level's faces. `heightOf(wall)` is the wall's height (defaults to wall.height or 2.44 m).
export function roomFaces({ walls = [], rooms = [], openings = [], heightOf } = {}) {
  const H = w => (heightOf ? heightOf(w) : w.height) || 2.44;
  const byWall = new Map();
  for (const o of openings) {
    if (!byWall.has(o.wallId)) byWall.set(o.wallId, []);
    byWall.get(o.wallId).push(o);
  }
  const parts = wallSurfaces(walls, byWall, H).flatMap(surface => {
    const { wall, f, edge, H: height, open, cells } = surface;
    const scale = edge.length / (edge.s1 - edge.s0);
    return splitByRoom(surface, rooms).map(({ s0, s1, front }) => {
      const distance = (s1 - s0) * scale;
      const clip = rows => rows.flatMap(r => {
        const a = Math.max(r.s0, s0), b = Math.min(r.s1, s1);
        return b > a ? [{ ...r, s0: a, s1: b }] : [];
      });
      const [p0, p1] = edge.reverse ? [pointOn(edge, s0), pointOn(edge, s1)] : [pointOn(edge, s1), pointOn(edge, s0)];
      return { wall, wallId: wall.id, L: f.L, side: edge.side, s0, s1, front, H: height,
        N: edge.N, p0, p1, length: distance, scale, reverse: !edge.reverse,
        ...(typeof edge.side === 'string' ? { edge: { start: edge.start, end: edge.end, s0: edge.s0, s1: edge.s1 } } : {}),
        open: clip(open), cells: clip(cells) };
    });
  });
  return groupsAlongWalls(parts).map(g => {
    const first = g[0], last = g.at(-1), height = first.H;
    // Keep the identity tied to the main run when a return extends it.
    const anchor = g.find(p => typeof p.side === 'number' && p.length > SMALL_STEP) || first;
    const length = g.reduce((n, p) => n + p.length, 0);
    const holes = [];
    let gross = 0, baseboard = 0;
    for (const p of g) {
      gross += p.open.reduce((n, r) => n + (r.s1 - r.s0) * p.scale * (r.v1 - r.v0), 0);
      baseboard += p.cells.filter(r => r.v0 === 0).reduce((n, r) => n + (r.s1 - r.s0) * p.scale, 0);
      if (typeof p.side !== 'number') continue;
      for (const { s0, s1, o } of openingSpans(p.wall, byWall.get(p.wallId) || [], p.L)) {
        const bottom = o.type === 'window' ? Math.max(0, o.sill || 0) : 0, top = Math.min(height, bottom + (o.height || 0));
        const width = Math.min(s1, p.s1) - Math.max(s0, p.s0);
        if (width < 0.001 || top <= bottom) continue;
        const area = p.open.reduce((n, r) => n + Math.max(0, Math.min(s1, r.s1) - Math.max(s0, r.s0)) *
          Math.max(0, Math.min(top, r.v1) - Math.max(bottom, r.v0)), 0);
        if (area > 0) holes.push({ id: o.id, type: o.type === 'window' ? 'window' : 'door', wallId: p.wallId, width, area });
      }
    }
    const openingArea = holes.reduce((n, h) => n + h.area, 0);
    const room = first.front.room;
    const kind = room ? 'room' : first.front.key;     // 'room' | 'outside' | 'none'
    // A room's wall is named by where it stands in the room (the kitchen's north wall faces
    // south); an outside face by the way it looks.
    const where = room ? compass(-anchor.N[0], -anchor.N[1]) : compass(anchor.N[0], anchor.N[1]);
    const label = room ? (room.name || 'Room') + ', ' + where + ' wall' : kind === 'outside' ? 'Outside, ' + where + ' face' : 'No room, ' + where + ' face';
    return {
      id: 'face:' + (room ? room.id : kind) + ':' + anchor.wallId + ':' + (anchor.side === 1 ? 'p' : anchor.side === -1 ? 'n' : anchor.side) + ':' + Math.round(anchor.s0 * 1000),
      kind, roomId: room ? room.id : null, label, compass: where,
      normal: anchor.N.slice(), a: first.p0.slice(), b: last.p1.slice(), height,
      parts: g.map(p => ({
        wallId: p.wallId, side: p.side, s0: p.s0, s1: p.s1, reverse: p.reverse, scale: p.scale, edge: p.edge, cells: p.cells,
        ...(p !== anchor && (p.edge || !parallel(p, anchor)) && { finishFrom: { wallId: anchor.wallId, side: anchor.side } }),
      })),
      length, gross, net: gross - openingArea, openings: holes, openingArea,
      baseboard,
    };
  });
}

// Totals for several faces: what MODEL's panel shows for a selection.
export function faceTotals(faces) {
  const sum = k => faces.reduce((n, f) => n + f[k], 0);
  return { count: faces.length, length: sum('length'), gross: sum('gross'), net: sum('net'), baseboard: sum('baseboard'),
    openings: new Set(faces.flatMap(f => f.openings.map(o => f.id + '|' + o.id))).size };
}
