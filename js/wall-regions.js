// Wall regions: the pieces of a room face that paint one at a time, as in paint by numbers.
// A room face (room-faces.js) is one flat run of wall, floor to ceiling. Trim and door and
// window casings stand on it, and wherever they run all the way across they divide it: the wall
// above a chair rail is one region, the wall below it another, and a door that reaches the
// floor parts the wall beside it into a left and a right piece. MODEL's PAINT tool paints one
// region per click; geometry.js draws each region as its own mesh in its own finish.
//
// What divides a face:
//   - doors and windows, with their casings (trims.js openingBlocks);
//   - every moulding that runs along the wall: baseboard, chair rail, picture rail, crown;
//   - fields that cover the wall (planks, panels): the wall behind them is not seen at all;
//   - framed fields the wall shows through (board and batten, square grid, shaker panels): the
//     wall inside the field is a region of its own, `field` naming the trim section.
// Picture-frame boxes are mouldings laid on the wall and divide nothing.
//
// A finish is kept as a paint mark on the wall, as a bucket's click would leave it:
//   wall.paint = [{ side: 1 | -1, f, y, material }]
// f is the place along the wall as a fraction from end a (it follows the wall when it is moved
// or stretched), y the height above the level's floor in metres. A region wears the finish of
// the mark that lies in it (the last one, when there are several); a region with no mark wears
// the face's own finish (wall-solids.js wallFaceMaterialIds). So a rail that moves takes its
// regions with it, two regions that merge when a rail is deleted keep the newer paint, and a
// rail that is added leaves the unmarked side in the face's own finish.
//
// Pure plan maths, no three.js and no workspace state.

import { wallFrame, wallEnds } from './wall-joins.js';
import { wallSolids } from './wall-solids.js';
import { trimLayout, trimStyle, openingBlocks } from './trims.js';

const EPS = 1e-6;
const SNAP = 1e-5;        // m: edges this close are one grid line
const CLOSE = 0.15;       // m: a moulding that stops this short of a corner or a casing still divides
const SLIVER = 0.05;      // m: a strip narrower or lower than this is no region of its own

// How a trim section meets the wall behind it: 'run' (a moulding along the wall), 'cover' (the
// wall behind is hidden), 'inside' (the wall shows through, as a region of its own), or null
// (laid on the wall, dividing nothing).
export function trimDivides(t) {
  const s = trimStyle(t);
  if (!s) return null;
  if (s.kind === 'run' || s.kind === 'crown') return 'run';
  if (s.planks || t.style === 'raised-panel') return 'cover';
  if (t.style === 'picture-frame') return null;
  return 'inside';
}

function gridLines(values, lo, hi) {
  const sorted = values.filter(v => Number.isFinite(v)).map(v => Math.min(hi, Math.max(lo, v))).sort((a, b) => a - b);
  const out = [];
  for (const v of sorted) if (!out.length || v - out[out.length - 1] > SNAP) out.push(v);
  return out;
}
const inside = (r, x, y) => x > r.x0 && x < r.x1 && y > r.y0 && y < r.y1;

// One face's regions. `walls`, `openings` and `trims` are the face's level's; `heightOf(wall)`
// the wall's height (default wall.height or 2.44 m).
// Returns { regions, rest, at(wallId, side, s, y) }:
//   regions  [{ key, field, cells, hidden, x0, x1, y0, y1, area, above, below, seed, finish }]
//     cells    the wall the region shows, as rectangles on the walls it lies on:
//              { part, wallId, side, s0, s1, v0, v1 } (part: the index in face.parts)
//     hidden   wall behind trim or a casing that is drawn with this region
//     x0..y1   its bounds in the face's own frame: x from the face's left end as seen from in
//              front, y up from the floor
//     above, below   the moulding it sits on, and the one over it (trim ids), or null
//     seed     where a paint mark for it is put: { wallId, side, f, y }
//     finish   the material id its mark gives it, or null for the face's own finish
//   rest     hidden wall that belongs to no region (drawn in the face's own finish)
//   at       the region at a point of a wall side, or null
export function faceRegions(face, { walls = [], openings = [], trims = [], heightOf } = {}) {
  const byId = new Map(walls.map(w => [w.id, w]));
  const parts = [];
  let total = 0, top = 0;
  for (const [k, p] of (face.parts || []).entries()) {
    const wall = byId.get(p.wallId);
    if (!wall) continue;
    const f = wallFrame(wall), H = (heightOf ? heightOf(wall) : wall.height) || 2.44;
    const off = total, len = p.s1 - p.s0;
    // Along the face, left to right as seen from in front: against the wall's own direction on
    // its + side, with it on its - side (room-faces.js T = -u * side).
    const toX = s => p.side > 0 ? off + (p.s1 - s) : off + (s - p.s0);
    const toS = x => p.side > 0 ? p.s1 - (x - off) : p.s0 + (x - off);
    parts.push({ k, p, wall, L: f.L, H, off, len, toX, toS });
    total += len; top = Math.max(top, H);
  }
  const empty = { regions: [], rest: [], at: () => null };
  if (!parts.length || total < SLIVER) return empty;

  // Rectangles in the face's frame, each clipped to the part it came from.
  const solid = [], covers = [], insides = [], edges = [0, total];
  const clip = (part, r) => {
    const s0 = Math.max(part.p.s0, r.s0), s1 = Math.min(part.p.s1, r.s1);
    const v0 = Math.max(0, r.v0), v1 = Math.min(part.H, r.v1);
    if (s1 - s0 < SNAP || v1 - v0 < SNAP) return null;
    const a = part.toX(s0), b = part.toX(s1);
    return { x0: Math.min(a, b), x1: Math.max(a, b), y0: v0, y1: v1 };
  };
  for (const part of parts) {
    const { wall, p, L, H } = part;
    for (const s of wallSolids(wall, openings, H).solids) { const r = clip(part, s); if (r) solid.push(r); }
    for (const b of openingBlocks(wall, openings, L, H)) {
      const r = clip(part, { s0: b.x0, s1: b.x1, v0: b.y0, v1: b.y1 });
      if (r) { covers.push({ ...r, casing: true }); edges.push(r.x0, r.x1); }
    }
    const ends = wallEnds(wall, walls, 0);
    const faceEnds = { L, H, x0: p.side > 0 ? ends.a.pos : ends.a.neg, x1: p.side > 0 ? ends.b.pos : ends.b.neg };
    for (const t of trims) {
      if (t.wallId !== wall.id || (t.side === -1 ? -1 : 1) !== p.side) continue;
      const how = trimDivides(t);
      if (!how) continue;
      const lay = trimLayout(t, wall, openings, faceEnds);
      if (how === 'run') {
        for (const piece of lay.parts) {
          if (piece.kind !== 'run') continue;
          const r = clip(part, { s0: piece.x0, s1: piece.x1, v0: piece.y, v1: piece.y + piece.W });
          if (r) covers.push({ ...r, trim: t.id, run: true });
        }
      } else {
        for (const rect of lay.rects) {
          const r = clip(part, { s0: rect.x0, s1: rect.x1, v0: rect.y0, v1: rect.y1 });
          if (r) (how === 'cover' ? covers : insides).push({ ...r, trim: t.id });
        }
      }
    }
    edges.push(part.off, part.off + part.len);
  }
  // A moulding that stops a little short of the corner or of a casing (a mitre, a return, a
  // record trimmed by hand) still closes the region: paint does not leak round its end.
  for (const c of covers) {
    if (!c.run) continue;
    const left = Math.max(...edges.filter(e => e <= c.x0 + EPS)), right = Math.min(...edges.filter(e => e >= c.x1 - EPS));
    if (c.x0 - left < CLOSE) c.x0 = left;
    if (right - c.x1 < CLOSE) c.x1 = right;
  }

  const all = [...solid, ...covers, ...insides];
  const xs = gridLines([...edges, ...all.flatMap(r => [r.x0, r.x1])], 0, total);
  const ys = gridLines([0, top, ...all.flatMap(r => [r.y0, r.y1])], 0, top);
  const nx = xs.length - 1, ny = ys.length - 1;
  if (nx < 1 || ny < 1) return empty;

  // Each cell: 0 not wall, 1 wall that shows, 2 wall behind something.
  const state = new Uint8Array(nx * ny), label = new Array(nx * ny).fill('');
  const partOf = new Int32Array(nx);
  for (let i = 0; i < nx; i++) {
    const cx = (xs[i] + xs[i + 1]) / 2;
    partOf[i] = parts.findIndex(q => cx >= q.off && cx <= q.off + q.len);
  }
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const cx = (xs[i] + xs[i + 1]) / 2, cy = (ys[j] + ys[j + 1]) / 2, n = j * nx + i;
    if (partOf[i] < 0 || !solid.some(r => inside(r, cx, cy))) continue;
    if (covers.some(r => inside(r, cx, cy))) { state[n] = 2; continue; }
    state[n] = 1;
    const field = insides.find(r => inside(r, cx, cy));
    if (field) label[n] = field.trim;
  }

  // Cells that touch, show, and belong to the same field (or to none) are one region.
  const parent = new Int32Array(nx * ny).map((_, n) => n);
  const find = n => { while (parent[n] !== n) { parent[n] = parent[parent[n]]; n = parent[n]; } return n; };
  const join = (a, b) => { if (state[a] === 1 && state[b] === 1 && label[a] === label[b]) parent[find(a)] = find(b); };
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const n = j * nx + i;
    if (i + 1 < nx) join(n, n + 1);
    if (j + 1 < ny) join(n, n + nx);
  }
  const groups = new Map();
  for (let n = 0; n < nx * ny; n++) if (state[n] === 1) { const r = find(n); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(n); }
  // A strip too thin to be painted on its own (the wall between a baseboard and a field that
  // starts a hair above it) is drawn with its neighbour instead.
  const bounds = cells => {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const n of cells) { const i = n % nx, j = (n - i) / nx; x0 = Math.min(x0, xs[i]); x1 = Math.max(x1, xs[i + 1]); y0 = Math.min(y0, ys[j]); y1 = Math.max(y1, ys[j + 1]); }
    return { x0, x1, y0, y1 };
  };
  const owner = new Int32Array(nx * ny).fill(-1);
  const regions = [];
  for (const cells of groups.values()) {
    const b = bounds(cells);
    if (b.x1 - b.x0 < SLIVER || b.y1 - b.y0 < SLIVER) { for (const n of cells) state[n] = 2; continue; }
    const index = regions.length;
    for (const n of cells) owner[n] = index;
    regions.push({ index, field: label[cells[0]] || null, grid: cells, hiddenGrid: [], ...b });
  }
  regions.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const order = new Int32Array(regions.length);
  regions.forEach((r, i) => { order[r.index] = i; });
  for (let n = 0; n < owner.length; n++) if (owner[n] >= 0) owner[n] = order[owner[n]];
  regions.forEach((r, i) => { r.index = i; });

  // Wall behind trim or a casing is drawn with the region under it, else the one over it, else
  // the one beside it: it is never seen whole, only at a mitre or past the end of a moulding.
  const rest = [], behind = new Int32Array(nx * ny).fill(-1);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const n = j * nx + i;
    if (state[n] !== 2) continue;
    let to = -1;
    for (let q = j - 1; q >= 0 && to < 0 && state[q * nx + i]; q--) to = owner[q * nx + i];
    for (let q = j + 1; q < ny && to < 0 && state[q * nx + i]; q++) to = owner[q * nx + i];
    for (let q = i - 1; q >= 0 && to < 0 && state[j * nx + q] && partOf[q] === partOf[i]; q--) to = owner[j * nx + q];
    for (let q = i + 1; q < nx && to < 0 && state[j * nx + q] && partOf[q] === partOf[i]; q++) to = owner[j * nx + q];
    behind[n] = to;
    if (to >= 0) regions[to].hiddenGrid.push(n); else rest.push(n);
  }

  const cellOf = n => {
    const i = n % nx, j = (n - i) / nx, part = parts[partOf[i]];
    const a = part.toS(xs[i]), b = part.toS(xs[i + 1]);
    return { part: part.k, wallId: part.wall.id, side: part.p.side, s0: Math.min(a, b), s1: Math.max(a, b), v0: ys[j], v1: ys[j + 1] };
  };
  const runs = covers.filter(c => c.run), fields = [...covers.filter(c => c.trim && !c.run), ...insides];
  const touching = (r, y, edge) => {
    // The moulding along this edge of the region: the one that lies against most of it. A
    // region may also sit on top of a field (the wall over a wainscot).
    let best = null, most = 0;
    for (const c of edge === 'bottom' ? [...runs, ...fields] : runs) {
      if (c.trim === r.field) continue;
      if (Math.abs((edge === 'top' ? c.y0 : c.y1) - y) > 2 * SNAP) continue;
      const lap = Math.min(c.x1, r.x1) - Math.max(c.x0, r.x0);
      if (lap > most) { most = lap; best = c.trim; }
    }
    return best;
  };
  for (const r of regions) {
    r.key = (r.field ? 'in:' + r.field : 'wall') + '@' + Math.round(r.x0 * 1000) + ',' + Math.round(r.y0 * 1000);
    r.cells = r.grid.map(cellOf);
    r.hidden = r.hiddenGrid.map(cellOf);
    r.area = r.cells.reduce((sum, c) => sum + (c.s1 - c.s0) * (c.v1 - c.v0), 0);
    r.above = touching(r, r.y0, 'bottom');
    r.below = touching(r, r.y1, 'top');
    const big = r.cells.reduce((a, c) => (c.s1 - c.s0) * (c.v1 - c.v0) > (a.s1 - a.s0) * (a.v1 - a.v0) ? c : a, r.cells[0]);
    const part = parts.find(q => q.k === big.part);
    r.seed = { wallId: big.wallId, side: big.side, f: Math.round((big.s0 + big.s1) / 2 / (part.L || 1) * 1e5) / 1e5, y: Math.round((big.v0 + big.v1) / 2 * 1e4) / 1e4 };
    r.finish = null;
    delete r.grid; delete r.hiddenGrid;
  }

  const locate = (x, y) => {
    if (!(x >= 0 && x <= total && y >= 0 && y <= top)) return -1;
    let i = 0, j = 0;
    while (i < nx - 1 && xs[i + 1] < x) i++;
    while (j < ny - 1 && ys[j + 1] < y) j++;
    return j * nx + i;
  };
  const at = (wallId, side, s, y) => {
    for (const part of parts) {
      if (part.wall.id !== wallId || part.p.side !== side || s < part.p.s0 - EPS || s > part.p.s1 + EPS) continue;
      const n = locate(part.toX(Math.min(part.p.s1, Math.max(part.p.s0, s))), y);
      if (n < 0) continue;
      const index = owner[n] >= 0 ? owner[n] : behind[n];
      if (index >= 0) return regions[index];
    }
    return null;
  };
  // Paint marks, oldest first: the last one in a region is its finish.
  for (const part of parts) {
    for (const mark of wallPaint(part.wall)) {
      if (mark.side !== part.p.side) continue;
      const s = mark.f * part.L;
      if (s < part.p.s0 - EPS || s > part.p.s1 + EPS) continue;
      const r = at(part.wall.id, mark.side, s, mark.y);
      if (r) r.finish = mark.material;
    }
  }
  return { regions, rest: rest.map(cellOf), at };
}

// A wall's paint marks, the malformed ones left out.
export function wallPaint(wall) {
  return (wall && Array.isArray(wall.paint) ? wall.paint : []).filter(m => m && typeof m === 'object' && (m.side === 1 || m.side === -1) &&
    Number.isFinite(m.f) && Number.isFinite(m.y) && typeof m.material === 'string' && m.material);
}

function dropMarks(wall, gone) {
  if (!Array.isArray(wall.paint)) return;
  wall.paint = wallPaint(wall).filter(m => !gone(m));
  if (!wall.paint.length) delete wall.paint;
}

// Paint one region: its old marks go, and one new mark is left for `materialId` (none when
// materialId is empty: the region goes back to the face's own finish). `result` is what
// faceRegions returned for the face, `walls` the level's walls.
export function paintRegion(result, region, walls, materialId) {
  const byId = new Map(walls.map(w => [w.id, w]));
  for (const id of new Set([...region.cells, ...region.hidden].map(c => c.wallId))) {
    const wall = byId.get(id);
    if (!wall) continue;
    const L = wallFrame(wall).L;
    dropMarks(wall, m => result.at(wall.id, m.side, m.f * L, m.y) === region);
  }
  const wall = byId.get(region.seed.wallId);
  if (materialId && wall) (wall.paint = wallPaint(wall)).push({ side: region.seed.side, f: region.seed.f, y: region.seed.y, material: materialId });
  region.finish = materialId || null;
}

// Paint a whole face, floor to ceiling: every part's side takes `materialId` as its own finish
// (none when empty: the automatic one) and the marks on it go.
export function paintFace(face, walls, materialId) {
  const byId = new Map(walls.map(w => [w.id, w]));
  for (const p of face.parts || []) {
    const wall = byId.get(p.wallId);
    if (!wall) continue;
    const L = wallFrame(wall).L, key = p.side > 0 ? 'materialPos' : 'materialNeg';
    if (materialId) wall[key] = materialId; else delete wall[key];
    dropMarks(wall, m => m.side === p.side && m.f * L >= p.s0 - EPS && m.f * L <= p.s1 + EPS);
  }
}

// What a region is called beside its face's name: 'above the chair rail', 'below the chair
// rail', 'between the chair rail and the picture rail', 'inside the board and batten', or ''
// for a face that is one region. `trims` are the level's.
export function regionLabel(region, trims, count) {
  const byId = new Map((trims || []).map(t => [t.id, t]));
  const name = id => { const t = byId.get(id), s = trimStyle(t); return s ? s.label.toLowerCase() : 'trim'; };
  if (region.field) return 'inside the ' + name(region.field);
  // Baseboard and crown edge nearly every region and tell nothing apart.
  const tells = id => { const s = trimStyle(byId.get(id)); return !!s && (s.kind === 'run' || s.kind === 'field') && s.group !== 'Base'; };
  const lo = region.above && tells(region.above) ? region.above : null, hi = region.below && tells(region.below) ? region.below : null;
  if (lo && hi) return 'between the ' + name(lo) + ' and the ' + name(hi);
  if (lo) return 'above the ' + name(lo);
  if (hi) return 'below the ' + name(hi);
  return count > 1 ? 'one piece of the wall' : '';
}
