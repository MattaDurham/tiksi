// What MODEL's DIMENSIONS, ROOMS and NUMBERS switches show, in world metres (plan x -> world x,
// plan y -> world z, height -> world y). Pure data, no DOM or three.js: viewer3d.js draws the
// dimension lines in the scene and keeps each label on screen over its point, so the labels read
// the same from any camera angle.
//
// - Dimensions: each wall's centre-line length, on the wall's negative side as DOCUMENTS plans
//   draw it, a little above that level's floor.
// - Rooms: the room's name and floor area (to the wall centre lines, where its corners sit).
// - Numbers: every door and window by its mark in the door and window schedule (D1, W1...), at
//   the middle of the opening, so the marks match the DOCUMENTS schedule sheet.

import { polyArea } from './store.js';
import { roomInteriorPoint } from './geometry.js';
import { openingSchedule, openingFrame } from './opening-schedule.js';

const DIM_OFFSET = 0.3;     // m beyond the wall face where the dimension line runs
const DIM_LIFT = 0.02;      // m above the floor
const ROOM_LIFT = 0.05;     // m above the floor
const MIN_WALL = 0.05;      // m: shorter walls get no dimension

function levelMap(prop) { return new Map((prop.levels || []).map(l => [l.id, l])); }
function levelOfRecord(levels, prop, rec) {
  return levels.get(rec.level) || (prop.levels || []).reduce((a, l) => (!a || l.elevation < a.elevation ? l : a), null);
}

// `hidden`: a Set of level ids not shown. `fmtLen`, `fmtArea`: the app's formatters.
export function modelAnnotations(prop, { hidden = new Set(), fmtLen, fmtArea } = {}) {
  const levels = levelMap(prop);
  const shown = rec => { const l = levelOfRecord(levels, prop, rec); return l && !hidden.has(l.id) ? l : null; };
  const dims = [], rooms = [], openings = [];
  for (const w of prop.walls || []) {
    const lvl = shown(w);
    if (!lvl) continue;
    const L = Math.hypot(w.bx - w.ax, w.by - w.ay);
    if (L < MIN_WALL) continue;
    const ux = (w.bx - w.ax) / L, uy = (w.by - w.ay) / L, nx = uy, ny = -ux;
    const off = (w.thickness || 0.114) / 2 + DIM_OFFSET, y = (lvl.elevation || 0) + DIM_LIFT;
    const a = [w.ax + nx * off, y, w.ay + ny * off], b = [w.bx + nx * off, y, w.by + ny * off];
    // Short ticks across each end, back to the wall face.
    const tick = p => [[p[0] - nx * 0.08, y, p[2] - ny * 0.08], [p[0] + nx * 0.08, y, p[2] + ny * 0.08]];
    dims.push({ id: w.id, levelId: lvl.id, a, b, ticks: [tick(a), tick(b)], at: [(a[0] + b[0]) / 2, y, (a[2] + b[2]) / 2], text: fmtLen(L), length: L });
  }
  for (const r of prop.rooms || []) {
    if (!r.pts || r.pts.length < 3) continue;
    const lvl = shown(r);
    if (!lvl) continue;
    const { x, y } = roomInteriorPoint(r.pts);
    const area = Math.abs(polyArea(r.pts));
    rooms.push({ id: r.id, levelId: lvl.id, at: [x, (lvl.elevation || 0) + ROOM_LIFT, y], name: r.name || 'Room', text: fmtArea(area), area });
  }
  const marks = new Map(openingSchedule(prop).map(row => [row.id, row]));
  for (const o of prop.openings || []) {
    const row = marks.get(o.id), f = openingFrame(prop, o);
    if (!row || !f) continue;
    const lvl = shown(f.w);
    if (!lvl) continue;
    const bottom = o.type === 'window' ? (o.sill || 0) : 0;
    openings.push({ id: o.id, levelId: lvl.id, at: [f.cx, (lvl.elevation || 0) + bottom + (o.height || 0) / 2, f.cy], text: row.number, type: row.type });
  }
  return { dims, rooms, openings };
}
