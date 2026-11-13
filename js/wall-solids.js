// Wall pieces around openings, in wall-local coordinates. No three.js here: the 3D view
// and the SketchUp mirror both cut walls from these spans and paint the same sides, so
// they always agree.

// Wall-local spans, bounded by the host wall. Overlapping openings retain their full
// widths; opening-validation.js reports conflicts instead of hiding them by shortening.
export function openingSpans(wall, openings, L) {
  const spans = openings
    .filter(o => o.wallId === wall.id)
    .map(o => {
      const w = Math.min(o.width || 0, L);
      const c = Math.min(Math.max((o.t || 0) * L, w / 2), L - w / 2);
      return { s0: Math.max(0, c - w / 2), s1: Math.min(L, c + w / 2), o };
    })
    .sort((a, b) => a.s0 - b.s0);
  return spans; // never silently shorten a later opening to hide an overlap

}

// Solid pieces of one wall in local coords: s along wall [0..L], v vertical [0..H].
export function wallSolids(wall, openings, defaultHeight) {
  const L = Math.hypot(wall.bx - wall.ax, wall.by - wall.ay);
  const H = wall.height || defaultHeight;
  if (L < 0.01) return { solids: [], glass: [], L, H };

  const solids = [], glass = [], spans = openingSpans(wall, openings, L);
  const cuts = [...new Set([0, L, ...spans.flatMap(s => [s.s0, s.s1])])].sort((a,b) => a-b);
  for (let i = 1; i < cuts.length; i++) {
    const s0 = cuts[i-1], s1 = cuts[i], mid = (s0+s1)/2;
    const holes = spans.filter(s => s.s0 <= mid && s.s1 >= mid).map(({o}) => [o.type === 'window' ? Math.max(0, o.sill || 0) : 0, Math.min(H, (o.type === 'window' ? o.sill || 0 : 0) + o.height)]).sort((a,b) => a[0]-b[0]);
    let cursor = 0;
    for (const [lo,hi] of holes) { if (lo > cursor) solids.push({s0,s1,v0:cursor,v1:lo}); cursor=Math.max(cursor,hi); }
    if (cursor < H) solids.push({s0,s1,v0:cursor,v1:H});
  }
  for (const {s0,s1,o} of spans) if (o.type === 'window') glass.push({s0,s1,v0:o.sill || 0,v1:Math.min(H,(o.sill || 0)+o.height),id:o.id});
  return { solids, glass, L, H };
}

// ---------- room sides and finishes ----------
export function pointInPoly(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function roomAt(rooms, x, y) {
  for (const r of rooms) if (r.pts && r.pts.length > 2 && pointInPoly(x, y, r.pts)) return r;
  return null;
}

// Which rooms border each side of a wall (+1 = local +z side, -1 = local -z side). In plan
// the +z side is the one the normal (-uy, ux) of a -> b points to.
export function wallSides(wall, rooms) {
  const L = Math.hypot(wall.bx - wall.ax, wall.by - wall.ay) || 1;
  const ux = (wall.bx - wall.ax) / L, uy = (wall.by - wall.ay) / L;
  const nx = -uy, ny = ux;                       // local +z direction in plan
  const th = wall.thickness || 0.114;
  const off = th / 2 + 0.08;
  const mx = (wall.ax + wall.bx) / 2, my = (wall.ay + wall.by) / 2;
  const probe = (sgn, f) => roomAt(rooms, mx + ux * (f - 0.5) * L * 0.6 + nx * off * sgn, my + uy * (f - 0.5) * L * 0.6 + ny * off * sgn);
  // Probe three points along the wall so a room that only covers part of a long wall still counts.
  const pos = probe(1, 0.5) || probe(1, 0.2) || probe(1, 0.8);
  const neg = probe(-1, 0.5) || probe(-1, 0.2) || probe(-1, 0.8);
  return { pos, neg };
}

// Share the renderer's automatic finish choice with inspection and sourcing actions.
export function wallInteriorMaterialId(wall, rooms) {
  const sides = wallSides(wall, rooms);
  const exterior = !!sides.pos !== !!sides.neg;
  return wall.materialIn || (exterior ? 'mat-drywall' : wall.material);
}

// The grey an exterior wall's outside face shows while nothing says what is really there.
export const EXTERIOR_UNKNOWN = 'mat-exterior-unknown';

// Material id per wall face, as the 3D view and the SketchUp mirror paint it:
// - a long face may carry its own finish (wall.materialPos / wall.materialNeg), which always wins;
// - a long face that looks into a room takes the interior finish;
// - the outside face of an exterior wall (a room on one side only) takes the wall's own finish
//   only when that says something the interior does not: a wall whose own finish is unset or the
//   same as its interior shows EXTERIOR_UNKNOWN there, never a copy of the room's paint;
// - every other face (ends, top, reveals) takes the interior finish when the wall borders a room:
//   they are the drywall returns and the cut top seen from inside, never the outside cladding;
//   a free-standing wall (no room either side) wears its own finish everywhere.
export function wallFaceMaterialIds(wall, rooms) {
  const sides = wallSides(wall, rooms), inId = wallInteriorMaterialId(wall, rooms);
  const exterior = !!sides.pos !== !!sides.neg;
  const outside = exterior && !(wall.material && wall.material !== inId) ? EXTERIOR_UNKNOWN : wall.material;
  const face = (own, room) => own || (room ? inId : outside);
  const other = sides.pos || sides.neg ? inId : wall.material;
  return { pos: face(wall.materialPos, sides.pos), neg: face(wall.materialNeg, sides.neg), other };
}

// Names for the two long faces, for inspectors: the compass side each looks toward and what
// lies there, e.g. { pos: 'North face (Kitchen)', neg: 'South face (outside)' }. Plan x is east,
// y south; pos looks along the normal (-uy, ux) of a -> b.
export function wallFaceLabels(wall, rooms) {
  const sides = wallSides(wall, rooms);
  const L = Math.hypot(wall.bx - wall.ax, wall.by - wall.ay) || 1;
  const nx = -(wall.by - wall.ay) / L, ny = (wall.bx - wall.ax) / L;
  const dir = s => Math.abs(nx) >= Math.abs(ny) ? (nx * s > 0 ? 'East' : 'West') : (ny * s > 0 ? 'South' : 'North');
  const what = r => r ? (r.name || 'room') : 'outside';
  return { pos: dir(1) + ' face (' + what(sides.pos) + ')', neg: dir(-1) + ' face (' + what(sides.neg) + ')' };
}

// ---------- plain openings ----------
// An opening cut through a wall and finished like the wall: no jambs, casing or door, only the
// wall's own returns under the header left above it (a drop header over a passage, the bays
// under a soffit). o.plain is the owner's call; a window is never one.
export function plainOpening(o) { return !!o && o.type !== 'window' && o.plain === true; }

// ---------- door leaves ----------
// How a door hangs: 0 (a cased opening: jambs, head and casing, no door), 1 or 2 leaves.
// o.leaves is the owner's call, 0 included (a doorway of any width that never had a door);
// without it a door wider than 1.25 m is a pair to the outside (French doors) and a cased
// opening inside.
export function doorLeaves(o, width, interior) {
  if (plainOpening(o)) return 0;
  if (o.leaves === 0 || o.leaves === 1 || o.leaves === 2) return o.leaves;
  return width > 1.25 ? (interior ? 0 : 2) : 1;
}

// Optional measured construction details. Opening width/height continue to describe the
// wall cut; leaf sizes describe the slab itself, not that cut or the clear passage. Missing
// detail takes precedence over the older profile interface. Unrecorded panel/grille
// patterns stay neutral instead of inventing identifying decoration.
const size = (d, key, fallback, max = Infinity, min = 0) => Number.isFinite(d[key]) && d[key] >= min && d[key] <= max ? d[key] : fallback;
export function doorDetail(o, width, top, interior, sides = {}) {
  const profile = o?.profile || {};
  const d = { ...profile, ...(profile.panels === 'six' ? { style: 'six-panel' } : {}), ...o?.detail?.door };
  const leaves = doorLeaves(o, width, interior);
  const maxJamb = Math.max(0, Math.min(0.3, width / 2 - 0.003, top - 0.012));
  const jambWidth = size(d, 'jambWidth', Math.min(0.05, maxJamb), maxJamb);
  const gap = leaves === 2 ? 0.009 : 0.006;
  const availableWidth = Math.max(0.01, (width - jambWidth * 2 - gap) / (leaves === 2 ? 2 : 1));
  const availableHeight = Math.max(0.01, top - jambWidth - 0.012);
  const warnings = [];
  if (Number.isFinite(d.leafWidth) && d.leafWidth > availableWidth + 1e-6) warnings.push('Leaf width exceeds the framed opening');
  if (Number.isFinite(d.leafHeight) && d.leafHeight > availableHeight + 1e-6) warnings.push('Leaf height exceeds the framed opening');
  return {
    leaves, jambWidth, leafWidth: size(d, 'leafWidth', availableWidth, availableWidth + 1e-6, 0.01),
    leafHeight: size(d, 'leafHeight', availableHeight, availableHeight + 1e-6, 0.01),
    leafThickness: size(d, 'leafThickness', 0.045, 0.2, 0.005),
    casingWidth: size(d, 'casingWidth', 0.07, 0.4), casingDepth: size(d, 'casingDepth', 0.016, 0.1),
    hinge: d.hinge === 'end' ? 'end' : 'start',
    swingSide: d.swingSide === 'negative' ? -1 : d.swingSide === 'positive' ? 1 : sides.pos ? 1 : -1,
    style: d.style === 'six-panel' ? 'six-panel' : 'slab',
    hardware: ['knob', 'none'].includes(d.hardware) ? d.hardware : 'lever',
    hardwareFinish: ['brass', 'dark', 'glass'].includes(d.hardwareFinish) ? d.hardwareFinish : 'chrome',
    knobShape: d.knobShape === 'faceted' ? 'faceted' : 'round',
    leafMaterial: typeof d.leafMaterial === 'string' ? d.leafMaterial : null,
    handleBackset: size(d, 'handleBackset', 0.075, 0.3, 0.001),
    handleHeight: size(d, 'handleHeight', 1, 2, 0.001),
    knobRadius: size(d, 'knobRadius', o?.detail?.door ? 0.027 : 0.025, 0.3, 0.001),
    warnings,
  };
}

const gridCount = (v, fallback) => Number.isInteger(v) && v >= 1 && v <= 12 ? v : fallback;
export function baseboardDetail(wall, side) {
  const d = { height: wall.profile?.baseboardHeight, depth: wall.profile?.baseboardDepth, ...(wall[side > 0 ? 'baseboardPos' : 'baseboardNeg'] || {}) };
  const height = size(d, 'height', 0.14, 0.6), depth = size(d, 'depth', 0.012, 0.1);
  return { height, depth, profile: d.profile === 'rounded' ? 'rounded' : 'rectangular',
    radius: size(d, 'radius', Math.min(depth / 2, height / 10), Math.min(depth, height), 0.0001) };
}
export function windowDetail(o, width, height) {
  const d = { ...o?.profile, ...o?.detail?.window };
  const type = ['double-hung', 'casement', 'fixed'].includes(d.type) ? d.type : 'legacy';
  const columns = gridCount(d.columns, 1);
  const rows = gridCount(d.rows, 1);
  return {
    type, columns, rows,
    upper: { columns: gridCount(d.upperColumns, columns), rows: gridCount(d.upperRows, rows) },
    lower: { columns: gridCount(d.lowerColumns, columns), rows: gridCount(d.lowerRows, rows) },
    frameWidth: size(d, 'frameWidth', 0.045, Math.min(width, height) / 5, 0.005),
    sashWidth: size(d, 'sashWidth', 0.035, Math.min(width, height) / 5, 0.005),
    muntinWidth: size(d, 'muntinWidth', 0.022, Math.min(width, height) / 8, 0.002),
    casingWidth: size(d, 'casingWidth', 0.07, 0.4), casingDepth: size(d, 'casingDepth', 0.016, 0.1),
  };
}

// ---------- open and closed doors ----------
// How MODEL shows a hung door's leaf. o.doorState is the owner's call: 'closed' shuts it,
// 'open' stands it ajar. Without it an interior door stands ajar so you can see through rooms
// and an exterior one is shut. The plan's swing arcs and the drawings do not change with it.
export const DOOR_STATES = ['open', 'closed'];
export function doorShownOpen(o, interior) {
  if (o && o.doorState === 'closed') return false;
  if (o && o.doorState === 'open') return true;
  return !!interior;
}
// Show a door open or closed: the field is kept only where it differs from the default.
export function setDoorShownOpen(o, interior, open) {
  if (!!open === !!interior) delete o.doorState; else o.doorState = open ? 'open' : 'closed';
}

// ---------- glass doors ----------
// What a door's leaf is made of. o.glass is the owner's call: 'full' is a pane of glass in
// stiles and rails (a French door, a patio door), 'half' is glass over a solid lower panel (an
// entry door with a lite); anything else is the solid panelled leaf.
export const DOOR_GLASS = ['full', 'half'];
export function doorGlass(o) { return o && o.type !== 'window' && DOOR_GLASS.includes(o.glass) ? o.glass : null; }

const LEAF_STILE = 0.11, LEAF_TOP_RAIL = 0.11, LEAF_BOTTOM_RAIL = 0.2, LEAF_LOCK_RAIL = 0.1;
const HALF_GLASS_FROM = 0.95;     // m above the floor where a half-glass door's glass starts

// A glazed leaf leafW x leafH in its own coordinates (x from the hinge edge, y from its foot):
// { glass: [x0, x1, y0, y1], panel: the solid lower panel of a half-glass leaf or null }.
// Null when the leaf is too small to hold a pane, which then stays solid.
export function leafGlazing(kind, leafW, leafH) {
  if (!DOOR_GLASS.includes(kind)) return null;
  const stile = Math.min(LEAF_STILE, leafW * 0.22), x0 = stile, x1 = leafW - stile, y1 = leafH - LEAF_TOP_RAIL;
  const y0 = kind === 'half' ? HALF_GLASS_FROM : LEAF_BOTTOM_RAIL;
  if (x1 - x0 < 0.08 || y1 - y0 < 0.2) return null;
  const panelTop = y0 - LEAF_LOCK_RAIL;
  return { glass: [x0, x1, y0, y1], panel: kind === 'half' && panelTop - LEAF_BOTTOM_RAIL > 0.1 ? [x0, x1, LEAF_BOTTOM_RAIL, panelTop] : null };
}

// The heights between which a door opening v0..v1 reads as glass in elevation, for drawings and
// the SketchUp mirror, which show a door as one flat pane: all of a full-glass door, the part
// above the lower panel of a half-glass one. Null for a solid door.
export function doorGlassBand(o, v0, v1) {
  const kind = doorGlass(o);
  if (!kind) return null;
  const from = kind === 'half' ? v0 + HALF_GLASS_FROM : v0;
  return v1 - from > 0.2 ? [from, v1] : null;
}

// Plan swings along the wall, s from the opening centre: each hinges at s, its leaf r long,
// closing toward s + dir * r. Only an explicit pair draws two; they meet in the middle. An
// opening set to no leaf (leaves: 0) draws none.
export function doorSwings(o) {
  const half = o.width / 2;
  if (o.leaves === 0 || plainOpening(o)) return [];
  const d = o.detail?.door || o.profile;
  // Keep legacy plan symbols exactly as before when no construction record exists.
  if (!d) return o.leaves === 2 ? [{ s: -half, r: half, dir: 1 }, { s: half, r: half, dir: -1 }] : [{ s: -half, r: o.width, dir: 1 }];
  const q = doorDetail(o, o.width, o.height || 2.03, false, { pos: true });
  const a = -half + q.jambWidth + 0.003, b = half - q.jambWidth - 0.003;
  const swing = (s, dir) => ({ s, r: q.leafWidth, dir, side: q.swingSide });
  return q.leaves === 2 ? [swing(a, 1), swing(b, -1)] : [q.hinge === 'end' ? swing(b, -1) : swing(a, 1)];
}
