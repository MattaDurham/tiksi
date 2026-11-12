// Wall pieces around openings, in wall-local coordinates. No three.js here: the 3D view
// and the SketchUp mirror both cut walls from these spans and paint the same sides, so
// they always agree.

// The openings on one wall as spans along it: clamped to the wall, never overlapping an
// earlier opening (the later one gives way), too-narrow leftovers dropped. Solids and trim
// are both cut from these so they always agree.
export function openingSpans(wall, openings, L) {
  const spans = openings
    .filter(o => o.wallId === wall.id)
    .map(o => {
      const w = Math.min(o.width || 0, L);
      const c = Math.min(Math.max((o.t || 0) * L, w / 2), L - w / 2);
      return { s0: Math.max(0, c - w / 2), s1: Math.min(L, c + w / 2), o };
    })
    .sort((a, b) => a.s0 - b.s0);
  const out = [];
  let cursor = 0;
  for (const sp of spans) {
    sp.s0 = Math.max(sp.s0, cursor);
    if (sp.s1 - sp.s0 < 0.05) continue;
    out.push(sp);
    cursor = sp.s1;
  }
  return out;
}

// Solid pieces of one wall in local coords: s along wall [0..L], v vertical [0..H].
export function wallSolids(wall, openings, defaultHeight) {
  const L = Math.hypot(wall.bx - wall.ax, wall.by - wall.ay);
  const H = wall.height || defaultHeight;
  if (L < 0.01) return { solids: [], glass: [], L, H };

  const solids = [];
  const glass = [];
  let cursor = 0;
  for (const { s0, s1, o } of openingSpans(wall, openings, L)) {
    if (s0 > cursor + 0.005) solids.push({ s0: cursor, s1: s0, v0: 0, v1: H });
    const top = Math.min((o.type === 'window' ? (o.sill || 0) + o.height : o.height), H);
    if (top < H - 0.01) solids.push({ s0, s1, v0: top, v1: H });          // header
    if (o.type === 'window' && (o.sill || 0) > 0.01) solids.push({ s0, s1, v0: 0, v1: o.sill }); // sill wall below
    if (o.type === 'window') glass.push({ s0, s1, v0: (o.sill || 0), v1: top, id: o.id });
    cursor = s1;
  }
  if (cursor < L - 0.005) solids.push({ s0: cursor, s1: L, v0: 0, v1: H });
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
// - every other face (ends, top, reveals, a free-standing wall's sides) the wall's own finish.
export function wallFaceMaterialIds(wall, rooms) {
  const sides = wallSides(wall, rooms), inId = wallInteriorMaterialId(wall, rooms);
  const exterior = !!sides.pos !== !!sides.neg;
  const outside = exterior && !(wall.material && wall.material !== inId) ? EXTERIOR_UNKNOWN : wall.material;
  const face = (own, room) => own || (room ? inId : outside);
  return { pos: face(wall.materialPos, sides.pos), neg: face(wall.materialNeg, sides.neg), other: wall.material };
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
  return o.leaves === 2 ? [{ s: -half, r: half, dir: 1 }, { s: half, r: half, dir: -1 }] : [{ s: -half, r: o.width, dir: 1 }];
}
