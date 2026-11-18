// What EDIT BY DRAGGING measures on a wall face while trim is edited, and the round numbers a
// drag holds on. Pure: wall-face coordinates (x along the wall from end a, y above the floor),
// metres, as trimLayout gives them (trims.js).
//
// A dimension: { a: [x, y], b: [x, y], v: its length, kind: 'gap' | 'height', note }.
//   one board      the clear space to the next board (or the end of the section) on each side
//                  of a batten, stile or box; above and below a rail or moulding; and its
//                  height above the floor (a rail or moulding: to its bottom and its top edge)
//   a section      the clear space between each pair of battens, stiles or boxes in each
//                  stretch, and the ends; the field's bottom and top above the floor (a
//                  moulding: its bottom and top edge)
import { boardPart, boardBox } from './trims.js';

const EPS = 1e-4;
const MIN = .001;                 // a space this small is two boards touching: not measured
const MAX_DIMS = 80;

const solids = (lay, skip) => lay.parts.filter(p => p !== skip && p.role !== 'backer').map(p => ({ p, b: boardBox(p) }));
const overlapY = (a, b) => a.y1 > b.y0 + EPS && a.y0 < b.y1 - EPS;
const overlapX = (a, b) => a.x1 > b.x0 + EPS && a.x0 < b.x1 - EPS;
const upright = p => p.kind === 'frame' || (p.kind === 'board' && p.dir === 'v');

export function boardDims(lay, key) {
  const part = boardPart(lay, key);
  if (!part) return [];
  const b = boardBox(part), others = solids(lay, part), out = [];
  const midX = (b.x0 + b.x1) / 2, midY = (b.y0 + b.y1) / 2;
  if (upright(part)) {
    // Sideways: what stands beside it at its height and does not cross over it.
    const beside = others.filter(o => overlapY(o.b, b) && !overlapX(o.b, b));
    const left = beside.filter(o => o.b.x1 <= b.x0 + EPS).reduce((m, o) => Math.max(m, o.b.x1), lay.start ?? b.x0);
    const right = beside.filter(o => o.b.x0 >= b.x1 - EPS).reduce((m, o) => Math.min(m, o.b.x0), lay.end ?? b.x1);
    if (b.x0 - left > MIN) out.push({ a: [left, midY], b: [b.x0, midY], v: b.x0 - left, kind: 'gap' });
    if (right - b.x1 > MIN) out.push({ a: [b.x1, midY], b: [right, midY], v: right - b.x1, kind: 'gap' });
    out.push({ a: [midX, 0], b: [midX, b.y0], v: b.y0, kind: 'height' });
    return out.filter(d => d.v > MIN);
  }
  // A rail or moulding: the space above and below it, and its two edges above the floor.
  const over = others.filter(o => overlapX(o.b, b) && !overlapY(o.b, b));
  const above = over.filter(o => o.b.y0 >= b.y1 - EPS).reduce((m, o) => Math.min(m, o.b.y0), Infinity);
  const below = over.filter(o => o.b.y1 <= b.y0 + EPS).reduce((m, o) => Math.max(m, o.b.y1), -Infinity);
  const x = b.x0 + Math.min(.3, (b.x1 - b.x0) / 3);
  if (Number.isFinite(above) && above - b.y1 > MIN) out.push({ a: [midX, b.y1], b: [midX, above], v: above - b.y1, kind: 'gap' });
  if (Number.isFinite(below) && b.y0 - below > MIN) out.push({ a: [midX, below], b: [midX, b.y0], v: b.y0 - below, kind: 'gap' });
  out.push({ a: [x, 0], b: [x, b.y0], v: b.y0, kind: 'height', note: 'bottom' });
  out.push({ a: [x + .08, 0], b: [x + .08, b.y1], v: b.y1, kind: 'height', note: 'top' });
  return out.filter(d => d.v > MIN);
}

export function sectionDims(lay) {
  const out = [];
  const parts = lay.parts.filter(p => p.role !== 'backer');
  if (!lay.rects || !lay.rects.length) {
    // A moulding along the wall: its height, on its first piece.
    const p = parts[0];
    if (!p) return out;
    const b = boardBox(p), x = b.x0 + Math.min(.3, (b.x1 - b.x0) / 3);
    out.push({ a: [x, 0], b: [x, b.y0], v: b.y0, kind: 'height', note: 'bottom' });
    out.push({ a: [x + .08, 0], b: [x + .08, b.y1], v: b.y1, kind: 'height', note: 'top' });
    return out.filter(d => d.v > MIN);
  }
  lay.rects.forEach((r, k) => {
    // The boards and boxes standing across the stretch's middle line, left to right.
    const y = (r.y0 + r.y1) / 2;
    const row = parts.filter(upright).map(p => boardBox(p))
      .filter(b => b.y0 <= y && b.y1 >= y && b.x0 >= r.x0 - EPS && b.x1 <= r.x1 + EPS).sort((a, b) => a.x0 - b.x0);
    let x = r.x0;
    for (const b of row) {
      if (b.x0 - x > MIN) out.push({ a: [x, y], b: [b.x0, y], v: b.x0 - x, kind: 'gap' });
      x = Math.max(x, b.x1);
    }
    if (row.length && r.x1 - x > MIN) out.push({ a: [x, y], b: [r.x1, y], v: r.x1 - x, kind: 'gap' });
    // The field's lines above the floor, at the first stretch's left end.
    if (k === 0) {
      const hx = r.x0 + Math.min(.15, (r.x1 - r.x0) / 4);
      out.push({ a: [hx, 0], b: [hx, r.y0], v: r.y0, kind: 'height', note: 'bottom' });
      out.push({ a: [hx + .08, 0], b: [hx + .08, r.y1], v: r.y1, kind: 'height', note: 'top' });
    }
  });
  return out.filter(d => d.v > MIN).slice(0, MAX_DIMS);
}

// What a board at `box` would have either side of it (the layout without it): left and right
// edges for an upright board, below and above for a rail; the section's ends when nothing is there.
export function besideOf(lay, key, box) {
  const part = boardPart(lay, key), others = solids(lay, part);
  const side = others.filter(o => overlapY(o.b, box) && !overlapX(o.b, box));
  const over = others.filter(o => overlapX(o.b, box) && !overlapY(o.b, box));
  return {
    left: side.filter(o => o.b.x1 <= box.x0 + EPS).reduce((m, o) => Math.max(m, o.b.x1), lay.start ?? -Infinity),
    right: side.filter(o => o.b.x0 >= box.x1 - EPS).reduce((m, o) => Math.min(m, o.b.x0), lay.end ?? Infinity),
    below: over.filter(o => o.b.y1 <= box.y0 + EPS).reduce((m, o) => Math.max(m, o.b.y1), 0),
    above: over.filter(o => o.b.y0 >= box.y1 - EPS).reduce((m, o) => Math.min(m, o.b.y0), Infinity),
  };
}
// The adjustment, smallest first, that holds a value on a round number: one of `values`
// (each { v, sign }: moving the board by d changes v by sign * d). 0 when none holds.
export function nearestHold(values, metric = false) {
  let best = 0;
  for (const { v, sign } of values) {
    if (!Number.isFinite(v)) continue;
    const pull = roundPull(v, metric) * sign;
    if (pull && (!best || Math.abs(pull) < Math.abs(best))) best = pull;
  }
  return best;
}

// Round numbers a drag holds on: within `pull` of one, the value is that number. Inches: a
// whole foot pulls from 3/8", a 6" mark (42") from 1/4", a whole inch from 1/8". Metric: 100,
// 50 and 10 mm pull from 8, 6 and 3 mm. Returns the value, held or not.
const IN = .0254;
const ROUND_IMPERIAL = [[12 * IN, 3 / 8 * IN], [6 * IN, 1 / 4 * IN], [IN, 1 / 8 * IN]];
const ROUND_METRIC = [[.1, .008], [.05, .006], [.01, .003]];
export function roundStick(v, metric = false) {
  for (const [unit, pull] of metric ? ROUND_METRIC : ROUND_IMPERIAL) {
    const r = Math.round(v / unit) * unit;
    if (Math.abs(v - r) <= pull) return r;
  }
  return v;
}
// How far a value is from being held: the adjustment roundStick makes (0 when it holds nothing).
export function roundPull(v, metric = false) { return roundStick(v, metric) - v; }
