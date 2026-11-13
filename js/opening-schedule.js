import { doorDimensions } from './opening-dimensions.js';
// Opening schedule: every door and window numbered (D1.., W1..) with the rooms it joins and
// its size, for an owner to correct by number. Pure data, no DOM; PLAN draws the tags.
//
// Numbers run over the whole property: levels bottom to top, then a reading-order sweep of
// each level (bands of BAND m from the top of the plan, left to right inside a band, id last).
// A number depends only on where openings sit, so editing a size, a wall finish or another
// level never renumbers anything; adding or moving an opening shifts only the ones after it.
import { openingProblems } from './opening-validation.js';
import { wallFaces, faceAt, pointInPolygon } from './roomfill.js';

export const BAND = 1.5;            // m: openings this close in plan y read as one row
const PROBE = 0.2;                  // m beyond the wall face where the rooms either side are sampled
export const MIN_SIZE = 0.05;       // m: the smallest width or height an edit accepts
const END_GAP = 0.02;               // m: an opening keeps this much wall at each end

function levelOf(prop, wall) {
  const levels = prop.levels || [];
  const low = levels.reduce((a, l) => (!a || l.elevation < a.elevation ? l : a), null);
  return levels.find(l => l.id === wall.level) || low;
}

// Where an opening sits: its wall, the wall's unit direction and the centre on the centre line.
export function openingFrame(prop, o) {
  const w = (prop.walls || []).find(w => w.id === o.wallId);
  if (!w) return null;
  const L = Math.hypot(w.bx - w.ax, w.by - w.ay);
  if (L < 1e-6) return null;
  const ux = (w.bx - w.ax) / L, uy = (w.by - w.ay) / L, c = (Number(o.t) || 0) * L;
  return { w, L, ux, uy, cx: w.ax + ux * c, cy: w.ay + uy * c };
}

// The room on one side: the smallest floor containing the probe point, else a wall-enclosed
// area nobody outlined yet, else outside every wall loop.
function sideName(rooms, faces, x, y) {
  let best = null, bestA = Infinity;
  for (const r of rooms) {
    if (!r.pts || r.pts.length < 3 || !pointInPolygon(x, y, r.pts)) continue;
    const a = Math.abs(area(r.pts));
    if (a < bestA) { best = r; bestA = a; }
  }
  if (best) return { roomId: best.id, name: (best.name || '').trim() || 'Unnamed room' };
  return faceAt(faces, x, y) ? { roomId: null, name: 'Unoutlined space' } : { roomId: null, name: 'Exterior' };
}
function area(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
  return a / 2;
}

// Rows for every opening on the property (or on `levelId` only), numbered as described above.
export function openingSchedule(prop, levelId = null) {
  const levels = (prop.levels || []).slice().sort((a, b) => a.elevation - b.elevation || String(a.id).localeCompare(String(b.id)));
  const levelRank = new Map(levels.map((l, i) => [l.id, i]));
  const none = { id: '', name: '', elevation: 0 }, lv = rec => levelOf(prop, rec) || none;
  const placed = [];
  for (const o of prop.openings || []) {
    const f = openingFrame(prop, o);
    if (!f) continue;
    const level = lv(f.w);
    placed.push({ o, f, level, rank: levelRank.get(level.id) ?? 0 });
  }
  placed.sort((a, b) => a.rank - b.rank || Math.floor(a.f.cy / BAND) - Math.floor(b.f.cy / BAND) ||
    a.f.cx - b.f.cx || String(a.o.id).localeCompare(String(b.o.id)));
  const count = { door: 0, window: 0 }, ctx = new Map();
  const rows = [];
  for (const { o, f, level } of placed) {
    const type = o.type === 'window' ? 'window' : 'door';
    const number = (type === 'door' ? 'D' : 'W') + (++count[type]);
    if (levelId && level.id !== levelId) continue;
    let c = ctx.get(level.id);
    if (!c) {
      const walls = (prop.walls || []).filter(w => lv(w) === level);
      c = { rooms: (prop.rooms || []).filter(r => lv(r) === level), faces: wallFaces(walls) };
      ctx.set(level.id, c);
    }
    const off = (f.w.thickness || 0.114) / 2 + PROBE, nx = -f.uy, ny = f.ux;
    const sides = [sideName(c.rooms, c.faces, f.cx + nx * off, f.cy + ny * off), sideName(c.rooms, c.faces, f.cx - nx * off, f.cy - ny * off)];
    // Inside first, so a door reads "Kitchen / Exterior" rather than the other way round.
    if (sides[0].name === 'Exterior' && sides[1].name !== 'Exterior') sides.reverse();
    rows.push({ id: o.id, number, type, levelId: level.id, levelName: level.name || '', wallId: f.w.id,
      width: o.width, height: o.height, dimensionType: 'wall-opening', slabWidth: type === 'door' ? doorDimensions(o).slabWidth : null, problems: openingProblems(prop, o), sill: type === 'window' ? (o.sill ?? null) : null,
      cx: f.cx, cy: f.cy, ux: f.ux, uy: f.uy, sides });
  }
  return rows;
}

export function connectsLabel(row) {
  const [a, b] = row.sides.map(s => s.name);
  return a === b ? a : a + ' / ' + b;
}

// Resize an opening so it still fits its wall: the width leaves END_GAP of wall at each end and
// the centre moves along the wall only as far as it must; a door or window stays under the wall
// top (above its sill). `wallHeight` is the wall's height in m. Returns the applied size, or
// null when a value is not a usable length. Callers open the undo step before calling.
export function resizeOpening(prop, o, { width, height } = {}, wallHeight = Infinity) {
  const f = openingFrame(prop, o);
  if (!f) return null;
  for (const v of [width, height]) if (v != null && !(Number.isFinite(v) && v >= MIN_SIZE)) return null;
  const target = o;
  const candidate = { ...o };
  o = candidate;
  if (width != null) {
    o.width = Math.min(width, Math.max(MIN_SIZE, f.L - END_GAP * 2));
    const minT = Math.min(0.5, (o.width / 2 + END_GAP) / f.L);
    o.t = Math.max(minT, Math.min(1 - minT, Number(o.t) || 0.5));
  }
  if (height != null) {
    const sill = o.type === 'window' ? (Number(o.sill) || 0) : 0;
    o.height = Math.max(MIN_SIZE, Math.min(height, wallHeight - sill));
  }
  if (openingProblems(prop, o).length) return null;
  Object.assign(target, candidate);
  return { width: o.width, height: o.height };
}
