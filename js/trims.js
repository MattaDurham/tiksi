// Wall trim: baseboards, rails, crown and wainscoting as records on the property (prop.trims).
// Pure functions, shared by MODEL (geometry.js draws them, viewer3d.js edits them) and tests.
//
// One record is one section of trim on one face of one wall:
//   wallId, side   the wall and its face: +1 the face toward the wall's left normal (-uy, ux),
//                  -1 the other one (wall-solids.js names them for the panel);
//   f0, f1         where along the wall it runs, as fractions of the wall's length from end a
//                  (0..1), so a section follows the wall when it is moved or stretched;
//   style          what it is (TRIM_STYLES below); product, the catalog entry it is made of
//                  (trim-catalog.js), which sets its size and profile;
//   y              the height of its bottom edge above the level's floor, metres (crown ignores
//                  it: crown always sits at the top of the wall);
//   h              a field's height (wainscoting, boxes, planks), metres;
//   cols, rows     how many boxes, bays or panels across and up (cols null: chosen to fit);
//   frameLayout    optional picture-frame preset, instead of the custom row and column settings;
//   colsAt         a count for one stretch between doors, windows and the wall's ends, by the
//                  stretch's place among the full-height ones (null or missing: chosen to fit;
//                  0: that stretch is left empty);
//   target         the box width to aim for when the count is chosen to fit, metres: each
//                  stretch takes the whole number of boxes that brings them closest to it
//                  (null: 30 in). Battened fields aim with `spacing` instead;
//   widths         the boxes' widths as shares of the stretch (null: all the same);
//   heights        the rows' heights as shares (null: all the same);
//   gap, inset     space between boxes and from the box to the field's edge, metres;
//   insetTop, insetBottom   the margin above and below the boxes when it differs from the
//                  margin at the sides (null: inset);
//   minBox         a stretch whose boxes would be narrower than this is left empty (null: no limit);
//   spacing        board, batten or slat spacing for planked and battened fields (null: the product's);
//   material       the finish (a material id; null: the trim paint, mat-trim).
//
// trimLayout() turns a record into parts in the wall face's own frame: x along the wall from
// end a, y up from the level's floor, d out from the face. Doors, windows and recorded
// wall-fixture clearances cut runs and fields; a run that reaches the wall's end is mitred to meet
// the next wall's trim (geometry.js does the mitre, as it does for the wall itself).
//
// A wall's trimClearances are the things on its faces that trim must keep off: small devices
// (an outlet, a switch or a thermostat: kind 'device') and radiators, heater covers and anything
// wide. Neither moves the layout: a field is laid out over the whole wall as if they were not
// there (only doors and windows break it into stretches), so its boxes and battens stay
// symmetrical. Then each board or box moulding that crosses a device is notched round it, with
// DEVICE_CLEAR to spare, and stays one board. At a radiator the trim stops: battens, stiles,
// planks and boxes end HEATER_CLEAR above its top, and a rail or baseboard behind it stops
// HEATER_CLEAR short of each side. A run (baseboard, rail, crown) that crosses a device stops
// either side of it. MODEL fills these in by itself from the wall-mounted pieces of the
// property's models (trim-obstacles.js); those carry auto: true.

import { sectionOf, isCrownProfile } from './trim-profiles.js';
import { catalogItem, catalogFor, TRIM_CATALOG } from './trim-catalog.js';
import { framePreset } from './trim-presets.js';
import { doorDetail, windowDetail, plainOpening } from './wall-solids.js';

// kind: 'run' (one moulding along the wall), 'crown' (a run at the ceiling), 'field' (an area).
export const TRIM_STYLES = {
  baseboard: { label: 'Baseboard', group: 'Base', kind: 'run', y: 0 },
  'base-shoe': { label: 'Base shoe and quarter round', group: 'Base', kind: 'run', y: 0 },
  'base-cap': { label: 'Base cap', group: 'Base', kind: 'run', y: .14 },
  'chair-rail': { label: 'Chair rail', group: 'Rails and caps', kind: 'run', y: .84 },
  'wainscot-cap': { label: 'Wainscot cap', group: 'Rails and caps', kind: 'run', y: .9 },
  'picture-rail': { label: 'Picture rail', group: 'Rails and caps', kind: 'run', y: null, fromTop: .3 },
  crown: { label: 'Crown', group: 'Crown', kind: 'crown' },
  'picture-frame': { label: 'Picture-frame boxes', group: 'Wainscoting', kind: 'field', y: .25, h: .5, boxes: true },
  'raised-panel': { label: 'Raised panels', group: 'Wainscoting', kind: 'field', y: .14, h: .78, boxes: true },
  'flat-panel': { label: 'Flat panels', group: 'Wainscoting', kind: 'field', y: .14, h: .78, boxes: true },
  'board-batten': { label: 'Board and batten', group: 'Wainscoting', kind: 'field', y: .14, h: 1.0, bays: true },
  beadboard: { label: 'Beadboard', group: 'Wainscoting', kind: 'field', y: .14, h: .8, planks: 'v' },
  shaker: { label: 'Shaker (recessed) panels', group: 'Wainscoting', kind: 'field', y: .14, h: .78, boxes: true },
  'full-height-paneling': { label: 'Full-height paneling', group: 'Wainscoting', kind: 'field', y: 0, fullHeight: true, boxes: true },
  grid: { label: 'Square grid', group: 'Wainscoting', kind: 'field', y: .14, h: 1.22, bays: true, rows: 2 },
  'v-groove': { label: 'Tongue and groove (V-groove)', group: 'Planks and panels', kind: 'field', y: .14, h: .8, planks: 'v' },
  shiplap: { label: 'Shiplap', group: 'Planks and panels', kind: 'field', y: .14, h: 1.0, planks: 'h' },
  slat: { label: 'Slat wall', group: 'Planks and panels', kind: 'field', y: 0, h: 2.4, planks: 'v' },
  fluted: { label: 'Fluted panel', group: 'Planks and panels', kind: 'field', y: .14, h: 1.0, planks: 'v' },
};
export const STYLE_GROUPS = ['Base', 'Rails and caps', 'Crown', 'Wainscoting', 'Planks and panels'];

const fin = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const MAX_PARTS = 4000;           // a field of slats on a long wall stays drawable
const MIN_PIECE = 0.02;           // a run shorter than this beside an opening is not drawn
const MIN_FIELD = 0.08;           // nor a field narrower or lower than this

export function trimStyle(t) { return TRIM_STYLES[t && t.style] || null; }
export function trimProduct(t) { return catalogItem(t && t.product) || catalogFor(t && t.style)[0] || null; }
export function trimLabel(t) {
  if (!t) return 'Trim';
  if (t.name) return String(t.name);
  const s = trimStyle(t), p = trimProduct(t);
  return (s ? s.label : 'Trim') + (p && p.short ? ', ' + p.short : '');
}
export function isField(t) { const s = trimStyle(t); return !!s && s.kind === 'field'; }

// Bring a record from a file or another device into shape; null when it cannot be one.
export function normaliseTrim(t, prop) {
  if (!t || typeof t !== 'object' || !TRIM_STYLES[t.style] || typeof t.wallId !== 'string') return null;
  const wall = prop && (prop.walls || []).find(w => w.id === t.wallId);
  if (prop && !wall) return null;
  if (wall && wall.level) t.level = wall.level;
  t.side = t.side === -1 ? -1 : 1;
  let f0 = clamp(fin(t.f0, 0), 0, 1), f1 = clamp(fin(t.f1, 1), 0, 1);
  if (f1 < f0) [f0, f1] = [f1, f0];
  if (f1 - f0 < 1e-4) { f0 = 0; f1 = 1; }
  t.f0 = f0; t.f1 = f1;
  // A product id this catalog does not know is kept (a later catalog may know it); a missing one, or
  // one of another style, becomes the style's first catalog entry.
  const known = typeof t.product === 'string' ? catalogItem(t.product) : null;
  if (typeof t.product !== 'string' || (known && known.style !== t.style)) t.product = (catalogFor(t.style)[0] || {}).id || null;
  const style = TRIM_STYLES[t.style];
  t.y = clamp(fin(t.y, style.y == null ? 2.1 : style.y), 0, 6);
  if (style.kind === 'field') t.h = clamp(fin(t.h, style.h ?? 2.44), MIN_FIELD, style.fullHeight ? Infinity : 6);
  else delete t.h;
  t.cols = Number.isInteger(t.cols) && t.cols >= 1 && t.cols <= 60 ? t.cols : null;
  t.rows = Number.isInteger(t.rows) && t.rows >= 1 && t.rows <= 12 ? t.rows : (style.rows || 1);
  const shares = (a, n) => Array.isArray(a) && a.length && a.length <= n && a.every(v => Number.isFinite(v) && v > 0) ? a.map(v => +v) : null;
  t.widths = shares(t.widths, 60);
  t.heights = shares(t.heights, 12);
  for (const k of ['gap', 'inset', 'spacing', 'insetTop', 'insetBottom', 'minBox']) t[k] = t[k] != null && Number.isFinite(Number(t[k])) ? clamp(Number(t[k]), 0, 2) : null;
  t.target = t.target != null && Number.isFinite(Number(t.target)) ? clamp(Number(t.target), .05, 6) : null;
  t.colsAt = Array.isArray(t.colsAt) && t.colsAt.length <= 40 && t.colsAt.some(v => v != null)
    ? t.colsAt.map(v => Number.isInteger(v) && v >= 0 && v <= 60 ? v : null) : null;
  t.material = typeof t.material === 'string' && t.material ? t.material : null;
  if (typeof t.name !== 'string') t.name = '';
  // Marked final: nothing changes it until it is unmarked (trim-design.js leaves it out of every reach).
  if (t.final === true) t.final = true; else delete t.final;
  const boards = normaliseBoards(t.boards);
  if (boards) t.boards = boards; else delete t.boards;
  setFrameLayout(t, t.frameLayout);
  return t;
}

// t.boards from a file or another device: only well-formed entries, finite and within reach.
function normaliseBoards(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return null;
  const out = {}, ok = v => Number.isFinite(v) && Math.abs(v) <= 100;
  for (const [key, e] of Object.entries(b).slice(0, 4000)) {
    if (typeof key !== 'string' || !key || key.length > 80 || !e || typeof e !== 'object') continue;
    if (e.hide === true) { out[key] = { hide: true }; continue; }
    if (!['x0', 'x1', 'y0', 'y1'].every(k => ok(e[k])) || e.x1 <= e.x0 || e.y1 <= e.y0) continue;
    const box = { x0: e.x0, x1: e.x1, y0: e.y0, y1: e.y1 };
    if (!e.add) { out[key] = box; continue; }
    if (!key.startsWith('add:') || !BOARD_KINDS.has(e.kind) || typeof e.role !== 'string') continue;
    out[key] = { add: true, role: e.role, kind: e.kind, dir: e.dir === 'h' ? 'h' : e.dir === 'v' ? 'v' : null, profile: typeof e.profile === 'string' ? e.profile : 'eased',
      T: ok(e.T) && e.T > 0 ? e.T : .019, W: ok(e.W) && e.W > 0 ? e.W : null, ...(e.crown ? { crown: true } : {}), ...box };
  }
  return Object.keys(out).length ? out : null;
}

export function setFrameLayout(t, id) {
  if (t.style === 'picture-frame' && framePreset(id)) t.frameLayout = id;
  else delete t.frameLayout;
}
export function normaliseTrims(list, prop) {
  return Array.isArray(list) ? list.map(t => normaliseTrim(t, prop)).filter(Boolean) : [];
}
export function trimsOn(prop, levelId) {
  const walls = new Set((prop.walls || []).filter(w => (w.level || null) === levelId || (!w.level && levelId == null)).map(w => w.id));
  return (prop.trims || []).filter(t => walls.has(t.wallId));
}

// A new section of `style` (and `productId`) on a wall face, its height from the style's
// defaults or `at`: { y, h, f0, f1 }.
export function trimTemplate(style, productId, wall, side, at = {}) {
  const s = TRIM_STYLES[style];
  if (!s) throw new Error('unknown trim style ' + style);
  const p = catalogItem(productId) || catalogFor(style)[0] || null;
  const H = fin(at.wallHeight, 2.44);
  const y = at.y != null ? at.y : s.y != null ? s.y : Math.max(0, H - (s.fromTop || .3) - (p ? p.W : .04));
  const t = { style, product: p ? p.id : null, wallId: wall.id, level: wall.level || null, side: side === -1 ? -1 : 1, f0: fin(at.f0, 0), f1: fin(at.f1, 1), y, name: '' };
  if (s.kind === 'field') t.h = at.h ?? (s.fullHeight ? Math.max(MIN_FIELD, H - y) : Math.min(s.h, Math.max(MIN_FIELD, H - y - .05)));
  if (s.rows) t.rows = s.rows;
  return normaliseTrim(t, null);
}

// Swap a section to another catalog entry. Within one kind the height stays; a run that
// becomes a field (or the other way round) takes the new style's usual height.
export function swapTrimProduct(t, productId, wallHeight) {
  const p = catalogItem(productId);
  if (!p) return false;
  const from = TRIM_STYLES[t.style], to = TRIM_STYLES[p.style];
  if (!to) return false;
  if (!from || from.kind !== to.kind || (from.kind === 'field' && !!from.planks !== !!to.planks)) {
    const fresh = trimTemplate(p.style, p.id, { id: t.wallId, level: t.level }, t.side, { wallHeight, f0: t.f0, f1: t.f1 });
    for (const k of ['y', 'h', 'rows']) if (fresh[k] !== undefined) t[k] = fresh[k]; else delete t[k];
    t.cols = null; t.widths = null; t.heights = null; t.gap = null; t.inset = null; t.spacing = null;
    t.colsAt = null; t.target = null; t.insetTop = null; t.insetBottom = null; t.minBox = null;
  }
  t.style = p.style; t.product = p.id;
  if (from !== to) delete t.frameLayout;
  if (to.kind === 'field' && t.h == null) t.h = to.h;
  if (to.fullHeight && !from?.fullHeight) t.h = Math.max(MIN_FIELD, wallHeight - t.y);
  if (from?.fullHeight && to.kind === 'field' && !to.fullHeight) {
    t.y = to.y;
    t.h = Math.min(to.h, Math.max(MIN_FIELD, wallHeight - t.y));
  }
  if (to.kind !== 'field') delete t.h;
  return true;
}

// A wainscoting style change keeps the field's extent and finish. Panel counts and
// spacing belong to their original assembly and the new assembly starts with its defaults.
export function swapWainscot(t, productId, wallHeight) {
  const from = trimStyle(t), p = catalogItem(productId);
  const to = p && TRIM_STYLES[p.style];
  if (from?.kind !== 'field' || to?.kind !== 'field') return false;
  const { y, h, style } = t;
  swapTrimProduct(t, productId, wallHeight);
  if (style === t.style) return true;
  if (!from.fullHeight && !to.fullHeight) { t.y = y; t.h = h; }
  if (to.fullHeight) t.h = Math.max(MIN_FIELD, wallHeight - t.y);
  t.rows = to.rows || 1;
  for (const k of ['cols', 'colsAt', 'target', 'widths', 'heights', 'gap', 'inset', 'spacing', 'insetTop', 'insetBottom', 'minBox']) t[k] = null;
  return true;
}

// ---------- layout ----------

// Where doors and windows (with casing) stand on this face, as rectangles in face coords.
export function openingBlocks(wall, openings, L, H) {
  const out = [];
  for (const o of openings || []) {
    if (o.wallId !== wall.id) continue;
    const w = Math.min(o.width || 0, L);
    const c = Math.min(Math.max((o.t || 0) * L, w / 2), L - w / 2);
    // Use the same construction details as the rendered opening: measured detail wins
    // over the older profile interface, and an explicit zero means no casing width.
    const detail = o.type === 'window' ? windowDetail(o, w, o.height || 0) : doorDetail(o, w, o.height || 0, false);
    const cw = plainOpening(o) || (o.type !== 'window' && !detail.casingDepth) ? 0 : detail.casingWidth;
    if (o.type === 'window') {
      const sill = Math.max(0, o.sill || 0);
      out.push({ x0: c - w / 2 - cw, x1: c + w / 2 + cw, y0: Math.max(0, sill - .11), y1: Math.min(H, sill + (o.height || 0) + cw), id: o.id });
    } else {
      out.push({ x0: c - w / 2 - cw, x1: c + w / 2 + cw, y0: 0, y1: Math.min(H, (o.height || 0) + cw), id: o.id });
    }
  }
  return out;
}

// A surface-mounted or recessed fixture can reserve space on one wall face.
// The horizontal limits follow the wall, and the heights are above its floor.
// Trim keeps this far off a device (the moulding never touches the plate)...
export const DEVICE_CLEAR = 0.0127;
// ...and this far off a radiator or heater cover (kind 'heater'). A clearance drawn with no
// kind is taken as it is.
export const HEATER_CLEAR = 0.0127;
function clearancesOn(wall, side, L, H, devices) {
  if (!Array.isArray(wall.trimClearances)) return [];
  return wall.trimClearances.flatMap(c => {
    if (!c || c.side !== side || ![c.f0, c.f1, c.y0, c.y1].every(Number.isFinite)) return [];
    if ((c.kind === 'device') !== devices) return [];
    const m = devices ? DEVICE_CLEAR : c.kind === 'heater' ? HEATER_CLEAR : 0;
    const x0 = clamp(c.f0, 0, 1) * L - m, x1 = clamp(c.f1, 0, 1) * L + m;
    const y0 = clamp(c.y0, 0, H) - m, y1 = clamp(c.y1, 0, H) + m;
    return x0 < x1 && y0 < y1 ? [{ x0, x1, y0, y1, ...(devices ? { device: true } : {}) }] : [];
  });
}
// What trim stops at: radiators, heater covers and anything else that is not a small device.
export function trimClearanceBlocks(wall, side, L, H) { return clearancesOn(wall, side, L, H, false); }
// Small devices, each grown by DEVICE_CLEAR: boards and box mouldings are notched round them.
export function trimDeviceBlocks(wall, side, L, H) { return clearancesOn(wall, side, L, H, true); }

const EPS = 1e-6;
const hits = (p, o) => o.x1 > p.x0 + EPS && o.x0 < p.x1 - EPS && o.y1 > p.y0 + EPS && o.y0 < p.y1 - EPS;
// Trim stops at a radiator (`stops`). A board it covers the whole width of ends above it (or below
// it, when it hangs higher than the board's foot); a board it covers the whole height of (a
// rail, a plank of shiplap) stops either side of it. A box it reaches is shortened to start
// above it, and the raised panel inside moves up with it. Anything left that it covers only
// part of is notched (notchParts). Boards split here are named '<key>/0', '<key>/1'.
function stopAtRadiators(out, stops) {
  if (!stops.length) return;
  const tooSmall = p => p.x1 - p.x0 < .003 || p.y1 - p.y0 < .003;
  const moved = [];          // [old box, new y0, new y1]: what sits inside a shortened box follows it
  const parts = [];
  // Boxes first, so the panels inside them can follow.
  const order = [...out.parts.filter(p => p.kind === 'frame'), ...out.parts.filter(p => p.kind !== 'frame')];
  const keep = new Set();
  for (const part of order) {
    if (part.kind === 'run' || part.role === 'backer') { keep.add(part); continue; }
    if (part.kind === 'frame') {
      let q = { ...part };
      for (const s of stops) {
        if (!hits(q, s)) continue;
        if (s.y0 <= q.y0 + EPS) q.y0 = s.y1; else if (s.y1 >= q.y1 - EPS) q.y1 = s.y0;
      }
      const W = q.W || 0;
      if (q.y1 - q.y0 <= 2 * W + .01) continue;          // too low above the radiator to be a box
      if (q.y0 !== part.y0 || q.y1 !== part.y1) moved.push([part, q.y0, q.y1]);
      keep.add(q); parts.push(q); continue;
    }
    // Inside a box that moved: keep the same margin to its new edge.
    let q = { ...part };
    const host = moved.find(([b]) => q.x0 >= b.x0 - EPS && q.x1 <= b.x1 + EPS && q.y0 >= b.y0 - EPS && q.y1 <= b.y1 + EPS);
    if (host) {
      const [b, ny0, ny1] = host;
      q.y0 = Math.max(q.y0, ny0 + (q.y0 - b.y0)); q.y1 = Math.min(q.y1, ny1 - (b.y1 - q.y1));
      if (tooSmall(q)) continue;
    }
    let pieces = [q];
    for (const s of stops) {
      const next = [];
      for (const p of pieces) {
        if (!hits(p, s)) { next.push(p); continue; }
        if (s.x0 <= p.x0 + EPS && s.x1 >= p.x1 - EPS) {
          // Across the whole width: the board ends above (or below) it, or is cut in two round it.
          if (s.y0 <= p.y0 + EPS) next.push({ ...p, y0: Math.min(p.y1, s.y1) });
          else if (s.y1 >= p.y1 - EPS) next.push({ ...p, y1: Math.max(p.y0, s.y0) });
          else next.push({ ...p, y1: s.y0 }, { ...p, y0: s.y1 });
        } else if (s.y0 <= p.y0 + EPS && s.y1 >= p.y1 - EPS) {
          // Up the whole height: the board stops either side of it.
          next.push({ ...p, x1: Math.max(p.x0, s.x0) }, { ...p, x0: Math.min(p.x1, s.x1) });
        } else next.push(p);
      }
      pieces = next.filter(p => !tooSmall(p));
    }
    if (pieces.length > 1) pieces = pieces.map((p, k) => ({ ...p, key: part.key + '/' + k }));
    for (const p of pieces) { keep.add(p); parts.push(p); }
  }
  // Back in the layout's own order.
  const at = new Map(out.parts.map((p, i) => [p.key, i]));
  out.parts = [...out.parts.filter(p => p.kind === 'run' || p.role === 'backer'), ...parts]
    .sort((a, b) => (at.get(String(a.key).replace(/\/\d+$/, '')) ?? 1e9) - (at.get(String(b.key).replace(/\/\d+$/, '')) ?? 1e9));
  // The box outlines the panel and the drag handles use follow the boxes.
  out.boxes = out.boxes.flatMap(b => {
    const q = { ...b };
    for (const s of stops) {
      if (!hits(q, s)) continue;
      if (s.y0 <= q.y0 + EPS && s.x0 <= q.x1 && s.x1 >= q.x0) q.y0 = s.y1; else if (s.y1 >= q.y1 - EPS) q.y1 = s.y0;
    }
    return q.y1 - q.y0 > .03 ? [q] : [];
  });
}
// The keep-outs a board or box moulding crosses, clipped to it: `notches` on the part. A box's
// moulding is notched only where a keep-out reaches its moulding, not where it sits inside the box.
function notchParts(out, keepOuts) {
  out.parts = out.parts.map(part => {
    if (part.kind !== 'board' && part.kind !== 'frame') return part;
    const { notches, ...q } = part;
    if (!keepOuts.length || part.role === 'backer') return q;
    const W = part.kind === 'frame' ? part.W || 0 : 0;
    const inner = part.kind === 'frame' ? { x0: q.x0 + W, x1: q.x1 - W, y0: q.y0 + W, y1: q.y1 - W } : null;
    const n = [];
    for (const o of keepOuts) {
      if (!hits(q, o)) continue;
      if (inner && o.x0 >= inner.x0 && o.x1 <= inner.x1 && o.y0 >= inner.y0 && o.y1 <= inner.y1) continue;
      n.push({ x0: Math.max(q.x0, o.x0), x1: Math.min(q.x1, o.x1), y0: Math.max(q.y0, o.y0), y1: Math.min(q.y1, o.y1) });
    }
    return n.length ? { ...q, notches: n } : q;
  });
}
// A notched board as the solid rectangles left of it, in pieces along its length: the full-width
// lengths (whole: true, with the board's own profile) and, where a notch is, what is left beside
// it. An unnotched board is its own one piece.
export function boardPieces(part) {
  const r = { x0: part.x0, x1: part.x1, y0: part.y0, y1: part.y1 };
  if (!part.notches || !part.notches.length) return [{ ...r, whole: true }];
  const v = part.dir !== 'h';
  // Along the board's length (y for an upright board, x for a level one), the lengths between notch ends.
  const [a, b] = v ? [r.y0, r.y1] : [r.x0, r.x1];
  const cuts = [...new Set([a, b, ...part.notches.flatMap(n => v ? [n.y0, n.y1] : [n.x0, n.x1]).filter(t => t > a && t < b)])].sort((p, q) => p - q);
  const out = [];
  for (let i = 1; i < cuts.length; i++) {
    const s0 = cuts[i - 1], s1 = cuts[i], mid = (s0 + s1) / 2;
    if (s1 - s0 < 1e-5) continue;
    // Across it, the board minus the notches that cover this length.
    const [c0, c1] = v ? [r.x0, r.x1] : [r.y0, r.y1];
    let spans = [[c0, c1]];
    for (const n of part.notches) {
      const [l0, l1] = v ? [n.y0, n.y1] : [n.x0, n.x1], [m0, m1] = v ? [n.x0, n.x1] : [n.y0, n.y1];
      if (!(l0 < mid && l1 > mid)) continue;
      spans = spans.flatMap(([p, q]) => m1 <= p || m0 >= q ? [[p, q]] : [[p, Math.max(p, m0)], [Math.min(q, m1), q]]);
    }
    for (const [p, q] of spans) {
      if (q - p < .002) continue;
      const whole = Math.abs(p - c0) < 1e-9 && Math.abs(q - c1) < 1e-9;
      out.push(v ? { x0: p, x1: q, y0: s0, y1: s1, whole } : { x0: s0, x1: s1, y0: p, y1: q, whole });
    }
  }
  return out;
}
// Where a box's moulding is notched, side by side: { bottom, top, left, right } each a list of
// [from, to] along that side (x for top and bottom, y for the sides) where the moulding is cut away.
export function frameGaps(part) {
  const out = { bottom: [], top: [], left: [], right: [] };
  const W = part.W || 0;
  for (const n of part.notches || []) {
    if (n.y0 < part.y0 + W) out.bottom.push([n.x0, n.x1]);
    if (n.y1 > part.y1 - W) out.top.push([n.x0, n.x1]);
    if (n.x0 < part.x0 + W) out.left.push([n.y0, n.y1]);
    if (n.x1 > part.x1 - W) out.right.push([n.y0, n.y1]);
  }
  return out;
}

// [x0, x1] minus the intervals in `cuts`, pieces shorter than `min` dropped. Each piece says
// whether it starts or ends at the interval's own ends (where a mitre may go).
function subtract(x0, x1, cuts, min) {
  let pieces = [{ x0, x1, a: true, b: true }];
  for (const c of cuts) {
    const next = [];
    for (const p of pieces) {
      if (c.x1 <= p.x0 || c.x0 >= p.x1) { next.push(p); continue; }
      if (c.x0 > p.x0) next.push({ x0: p.x0, x1: c.x0, a: p.a, b: false });
      if (c.x1 < p.x1) next.push({ x0: c.x1, x1: p.x1, a: false, b: p.b });
    }
    pieces = next;
  }
  return pieces.filter(p => p.x1 - p.x0 >= min);
}

// The rectangles of a field once doors and windows are taken out: {x0, x1, y0, y1, full}.
export function fieldRects(x0, x1, y0, y1, blocks) {
  const hits = blocks.filter(b => b.y1 > y0 + 1e-6 && b.y0 < y1 - 1e-6 && b.x1 > x0 && b.x0 < x1);
  const xs = [...new Set([x0, x1, ...hits.flatMap(b => [b.x0, b.x1]).filter(x => x > x0 && x < x1)])].sort((a, b) => a - b);
  const out = [];
  for (let i = 1; i < xs.length; i++) {
    const a = xs[i - 1], b = xs[i], mid = (a + b) / 2;
    if (b - a < MIN_FIELD) continue;
    let ys = [[y0, y1]];
    for (const h of hits) {
      if (!(h.x0 < mid && h.x1 > mid)) continue;
      ys = ys.flatMap(([lo, hi]) => h.y1 <= lo || h.y0 >= hi ? [[lo, hi]] : [[lo, Math.min(hi, h.y0)], [Math.max(lo, h.y1), hi]].filter(([p, q]) => q - p >= MIN_FIELD));
    }
    for (const [lo, hi] of ys) out.push({ x0: a, x1: b, y0: lo, y1: hi, full: Math.abs(lo - y0) < 1e-6 && Math.abs(hi - y1) < 1e-6 });
  }
  return out;
}

// Split [a, b] into n pieces by `shares` (null or the wrong length: equal), with `gap` between.
export function splitSpan(a, b, n, shares, gap) {
  n = Math.max(1, n | 0);
  const w = (b - a) - gap * (n - 1);
  if (w <= 0) return [];
  const s = Array.isArray(shares) && shares.length === n ? shares : Array(n).fill(1);
  const sum = s.reduce((x, y) => x + y, 0);
  const out = [];
  let x = a;
  for (let i = 0; i < n; i++) { const len = w * s[i] / sum; out.push([x, x + len]); x += len + gap; }
  return out;
}

// How many boxes or bays across a stretch `w` wide when the owner has not said: boxes near
// 30 in wide, bays near the product's spacing. With a `target` box width and the `gap` between
// boxes, the count is the one whose equal boxes come closest to the target: the finish
// carpenter's n = round((w + gap) / (target + gap)).
export function autoCount(style, w, rowH, spacing, target, gap) {
  if (style === 'grid' && !spacing) return Math.max(1, Math.round(w / Math.max(.15, rowH)));
  if (TRIM_STYLES[style] && TRIM_STYLES[style].bays) return Math.max(1, Math.round(w / Math.max(.1, spacing || .45)));
  if (target) return Math.max(1, Math.round((w + (gap || 0)) / (target + (gap || 0))));
  return Math.max(1, Math.round(w / .76));
}

// Boxes per full rectangle when the owner set a total: shared by width, at least one each.
function colsPerRect(rects, total) {
  const full = rects.filter(r => r.full);
  const sum = full.reduce((s, r) => s + (r.x1 - r.x0), 0);
  const out = new Map();
  if (!total || !full.length) return out;
  let left = total;
  full.forEach((r, i) => {
    const n = i === full.length - 1 ? Math.max(1, left) : Math.max(1, Math.round(total * (r.x1 - r.x0) / sum));
    out.set(r, n); left -= n;
  });
  return out;
}

function layPicturePreset(t, p, recipe, r, rect, out, push) {
  const gap = t.gap ?? .1, inset = t.inset ?? .09;
  const a = r.x0 + inset, b = r.x1 - inset;
  const c = r.y0 + (t.insetBottom ?? inset), d = r.y1 - (t.insetTop ?? inset);
  const addBox = (x0, x1, y0, y1, col, row) => {
    if (x1 - x0 <= Math.max(p.W * 2, t.minBox || 0) || y1 - y0 <= p.W * 2) return;
    const box = { x0, x1, y0, y1 };
    const frame = { kind: 'frame', W: p.W, T: p.T, profile: p.profile };
    out.boxes.push({ ...box, col, row, rect });
    push({ ...frame, ...box });
    if (recipe.nested) {
      const offset = p.W + Math.min(gap / 2, p.W);
      if (x1 - x0 > 2 * (offset + p.W) && y1 - y0 > 2 * (offset + p.W))
        push({ ...frame, x0: x0 + offset, x1: x1 - offset, y0: y0 + offset, y1: y1 - offset });
    }
  };
  if (b - a <= p.W * 2 || d - c <= p.W * 2) return;
  const across = shares => splitSpan(a, b, shares.length, shares, gap);
  // Fit one ordinary band above/below an opening, or where the preset will not fit.
  const top = across(recipe.columns);
  if (!r.full || !top.length || top.some(([x, y]) => y - x <= Math.max(p.W * 2, t.minBox || 0))) {
    const fit = w => w <= p.W * 2 ? 0 : Math.max(1, Math.min(autoCount(t.style, w, d - c, null, t.target, gap), Math.floor((w + gap) / (p.W * 2 + gap))));
    const n = fit(b - a), boxes = n ? splitSpan(a, b, n, null, gap) : [];
    boxes.forEach(([x, y], i) => addBox(x, y, c, d, i, 0));
    if (r.full) out.cols = Math.max(out.cols, boxes.length);
    return;
  }
  out.cols = Math.max(out.cols, top.length);
  const rowGap = Math.min(gap, Math.max(p.W, (d - c) * .2));
  const clear = d - c - rowGap;
  const lowerTop = c + clamp(.24 * clear, p.W * 2.25, clear - p.W * 2.25);
  const upperBottom = lowerTop + rowGap;
  const divider = lowerTop + rowGap / 2;
  const fitsRows = clear >= p.W * 4.5;
  if (recipe.lower && fitsRows) {
    const lower = across(recipe.lower);
    if (lower.length && lower.every(([x, y]) => y - x > Math.max(p.W * 2, t.minBox || 0))) {
      lower.forEach(([x, y], i) => addBox(x, y, c, lowerTop, i, 0));
      top.forEach(([x, y], i) => addBox(x, y, upperBottom, d, i, 1));
      if (p.W <= rowGap) push({ kind: 'board', dir: 'h', x0: r.x0, x1: r.x1, y0: divider - p.W / 2, y1: divider + p.W / 2, T: p.T, profile: p.profile });
      return;
    }
  }
  top.forEach(([x, y], i) => {
    if (fitsRows && recipe.split?.includes(i)) {
      addBox(x, y, c, lowerTop, i, 0);
      addBox(x, y, upperBottom, d, i, 1);
    } else addBox(x, y, recipe.low === i ? r.y0 : c, d, i, 0);
  });
}

// The parts of one record. `face` is { L, H, x0, x1 } (the face's own ends along the wall,
// which corners shorten or lengthen; default 0..L) and `openings` the level's openings.
// Parts:
//   { kind: 'run', x0, x1, y, W, T, profile, crown, mitreA, mitreB }  a moulding along the wall
//   { kind: 'frame', x0, x1, y0, y1, W, T, profile }                  a mitred box of moulding
//   { kind: 'board', x0, x1, y0, y1, T, profile, dir: 'v' | 'h', d }   one straight piece
// plus layout facts the panel shows: rects (the field's stretches) and boxes (box outlines).
export function trimLayout(t, wall, openings, face = {}) {
  const L = Math.hypot(wall.bx - wall.ax, wall.by - wall.ay);
  const H = fin(face.H, wall.height || 2.44);
  const out = { parts: [], rects: [], boxes: [], cols: 0, L, H };
  const style = trimStyle(t), p = trimProduct(t);
  if (!style || !p || L < .01) return out;
  const e0 = fin(face.x0, 0), e1 = fin(face.x1, L);
  const atA = t.f0 <= 1e-3, atB = t.f1 >= 1 - 1e-3;
  const x0 = atA ? e0 : Math.max(e0, t.f0 * L), x1 = atB ? e1 : Math.min(e1, t.f1 * L);
  if (x1 - x0 < MIN_PIECE) return out;
  const side = t.side === -1 ? -1 : 1;
  // Doors and windows break a field into stretches; radiators and devices do not (see the top).
  const blocks = openingBlocks(wall, openings, L, H);
  const stops = trimClearanceBlocks(wall, side, L, H).filter(d => d.x1 > x0 && d.x0 < x1);
  const devices = trimDeviceBlocks(wall, side, L, H).filter(d => d.x1 > x0 && d.x0 < x1);
  const W = p.W, T = p.T;
  const push = part => { if (out.parts.length < MAX_PARTS) out.parts.push(part); };

  out.start = x0; out.end = x1;

  if (style.kind === 'run' || style.kind === 'crown') {
    const crown = style.kind === 'crown' || isCrownProfile(p.profile);
    const yb = crown ? H - W : clamp(t.y, 0, Math.max(0, H - W)), yt = yb + W;
    const cuts = [...blocks, ...stops, ...devices].filter(b => b.y1 > yb + 1e-6 && b.y0 < yt - 1e-6);
    for (const piece of subtract(x0, x1, cuts, MIN_PIECE)) {
      push({ kind: 'run', x0: piece.x0, x1: piece.x1, y: yb, W, T, profile: p.profile, crown, mitreA: piece.a && atA, mitreB: piece.b && atB });
    }
    nameParts(out);
    applyBoardEdits(t, out);
    return out;
  }

  // Fields: laid out over the whole stretch, then stopped at radiators and notched round devices.
  // Every part is named first, so a batten stopped or notched keeps its place in the count; boards
  // moved by hand are notched where they now stand.
  layField(t, style, p, x0, x1, H, blocks, out, push);
  nameParts(out);
  stopAtRadiators(out, stops);
  applyBoardEdits(t, out);
  notchParts(out, [...devices, ...stops]);
  return out;
}

// ---------- boards one at a time ----------
// Every part of a layout has a key that names its place in it: the stretch of the field it
// stands in (rects, counted from wall end a; 'run' for a moulding along the wall), what it is,
// and its place among the parts of that kind there, left to right and then bottom to top.
// '0:v:2' is the third vertical board of the first stretch. A batten notched round an outlet
// keeps its key; a rail stopped either side of a radiator is '0:h:0/0' and '0:h:0/1'. The key holds when the layout is drawn again with the same count.
//
// t.boards keeps the boards changed by hand, by key:
//   { hide: true }                 a board of the layout taken out
//   { x0, x1, y0, y1 }             a board of the layout moved or resized: x from the
//                                  section's start (so it follows the section along the wall),
//                                  y above the floor, metres; a run keeps y0 as its height
//   { add: true, role, kind, dir, profile, T, W, x0, x1, y0, y1 }   a board added by hand
//                                  (key 'add:<id>'); its thickness and profile follow the
//                                  layout's boards of the same role when there are any.
// Everything else in the section still follows the automatic layout.
export function partRole(part) {
  if (part.role === 'backer') return 'backer';
  if (part.kind === 'frame') return part.profile === 'raised-bevel' ? 'bevel' : 'frame';
  if (part.kind === 'board') return part.dir + (part.profile === 'flat' ? '-panel' : '');
  return part.kind;
}
function nameParts(out) {
  const groups = new Map();
  for (const part of out.parts) {
    let rect = 'run';
    if (part.kind !== 'run') {
      const cx = (part.x0 + part.x1) / 2, cy = (part.y0 + part.y1) / 2;
      const i = out.rects.findIndex(r => cx >= r.x0 - 1e-6 && cx <= r.x1 + 1e-6 && cy >= r.y0 - 1e-6 && cy <= r.y1 + 1e-6);
      rect = i < 0 ? 'x' : String(i);
    }
    const g = rect + ':' + partRole(part);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(part);
  }
  for (const [g, list] of groups) {
    list.sort((a, b) => a.x0 - b.x0 || (a.y0 ?? a.y) - (b.y0 ?? b.y));
    list.forEach((part, n) => { part.key = g + ':' + n; });
  }
}
const BOARD_KINDS = new Set(['board', 'run', 'frame']);
function applyBoardEdits(t, out) {
  const edits = t.boards;
  if (!edits || typeof edits !== 'object') return;
  const s = out.start || 0;
  const byRole = new Map();
  for (const part of out.parts) if (!byRole.has(partRole(part))) byRole.set(partRole(part), part);
  const parts = [];
  for (const part of out.parts) {
    const e = edits[part.key];
    if (!e) { parts.push(part); continue; }
    if (e.hide) continue;
    const q = { ...part, edited: true };
    if (Number.isFinite(e.x0) && Number.isFinite(e.x1)) {
      q.x0 = s + e.x0; q.x1 = s + e.x1;
      if (part.kind === 'run') { q.mitreA = part.mitreA && Math.abs(q.x0 - part.x0) < 1e-6; q.mitreB = part.mitreB && Math.abs(q.x1 - part.x1) < 1e-6; }
    }
    if (Number.isFinite(e.y0)) { if (part.kind === 'run') q.y = e.y0; else if (Number.isFinite(e.y1)) { q.y0 = e.y0; q.y1 = e.y1; } }
    parts.push(q);
  }
  for (const [key, e] of Object.entries(edits)) {
    if (!e || !e.add || !BOARD_KINDS.has(e.kind)) continue;
    const like = byRole.get(e.role) || {};
    const q = { kind: e.kind, key, added: true, edited: true, x0: s + e.x0, x1: s + e.x1, T: like.T ?? e.T, profile: like.profile ?? e.profile };
    if (e.kind === 'run') Object.assign(q, { y: e.y0, W: like.W ?? e.W, crown: !!(like.crown ?? e.crown), mitreA: false, mitreB: false });
    else Object.assign(q, { y0: e.y0, y1: e.y1 });
    if (e.kind === 'board') { q.dir = e.dir === 'h' ? 'h' : 'v'; if (like.d) q.d = like.d; }
    if (e.kind === 'frame') q.W = like.W ?? e.W;
    if (e.role === 'backer') q.role = 'backer';
    parts.push(q);
  }
  out.parts = parts;
}
// How many boards of a section were changed by hand.
export function boardChanges(t) {
  const out = { moved: 0, hidden: 0, added: 0, total: 0 };
  for (const e of Object.values((t && t.boards) || {})) {
    if (!e) continue;
    if (e.add) out.added++; else if (e.hide) out.hidden++; else out.moved++;
    out.total++;
  }
  return out;
}
// The part of a layout with this key.
export function boardPart(lay, key) { return (lay && lay.parts.find(p => p.key === key)) || null; }
// The board's place: x0, x1 (along the wall, from end a) and y0, y1 (above the floor), metres.
export function boardBox(part) {
  if (!part) return null;
  if (part.kind === 'run') return { x0: part.x0, x1: part.x1, y0: part.y, y1: part.y + (part.W || 0) };
  return { x0: part.x0, x1: part.x1, y0: part.y0, y1: part.y1 };
}
// Put a board at `box` (wall coordinates, as boardBox gives them), keeping its record in t.boards.
export function placeBoard(t, lay, key, box) {
  const part = boardPart(lay, key);
  if (!part) return false;
  const s = lay.start || 0, r = v => Math.round(v * 1e5) / 1e5;
  const rel = { x0: r(box.x0 - s), x1: r(box.x1 - s), y0: r(box.y0), y1: r(box.y1) };
  if (rel.x1 - rel.x0 < .003 || rel.y1 - rel.y0 < .003) return false;
  t.boards = t.boards || {};
  const was = t.boards[key];
  if (was && was.add) t.boards[key] = { ...was, ...rel };
  else t.boards[key] = rel;
  return true;
}
// Take a board out: one added by hand goes, one of the layout is hidden.
export function removeBoard(t, key) {
  t.boards = t.boards || {};
  if (t.boards[key] && t.boards[key].add) delete t.boards[key];
  else t.boards[key] = { hide: true };
  tidyBoards(t);
}
// A copy of a board at `box` (wall coordinates); returns the new board's key.
export function copyBoard(t, lay, key, box, id) {
  const part = boardPart(lay, key);
  if (!part) return null;
  const s = lay.start || 0, r = v => Math.round(v * 1e5) / 1e5, nk = 'add:' + id;
  t.boards = t.boards || {};
  t.boards[nk] = { add: true, role: partRole(part), kind: part.kind, dir: part.dir || null, profile: part.profile, T: part.T, W: part.W ?? null,
    crown: part.crown || undefined, x0: r(box.x0 - s), x1: r(box.x1 - s), y0: r(box.y0), y1: r(box.y1) };
  return nk;
}
// Put one board back as the layout has it (an added board goes), or every board.
export function restoreBoard(t, key) { if (t.boards) delete t.boards[key]; tidyBoards(t); }
export function restoreAllBoards(t) { delete t.boards; }
function tidyBoards(t) { if (t.boards && !Object.keys(t.boards).length) delete t.boards; }
// What a board is, in the words a carpenter uses for it.
export function boardName(t, part) {
  if (!part) return '';
  const style = trimStyle(t) || {};
  const role = partRole(part);
  if (role === 'backer') return 'Backer panel';
  if (role === 'run') return (style.label || 'Moulding') + ' piece';
  if (role === 'frame') return 'Picture-frame box';
  if (role === 'bevel') return 'Raised panel';
  if (role.endsWith('-panel')) return 'Panel';
  if (style.planks) return part.dir === 'h' ? 'Plank' : 'Board';
  if (part.dir === 'h') return 'Rail';
  return style.bays ? 'Batten' : 'Stile';
}
// Its number among the boards of its kind in its stretch: { n, of } (1-based), or null for one added by hand.
export function boardPlace(lay, part) {
  if (!part || part.added || !part.key) return null;
  const m = /^(.*):(\d+)(?:\/\d+)?$/.exec(part.key);
  if (!m) return null;
  const same = new Set(lay.parts.filter(p => p.key && !p.added && p.key.startsWith(m[1] + ':')).map(p => p.key.replace(/\/\d+$/, '')));
  return { n: +m[2] + 1, of: same.size };
}

function layField(t, style, p, x0, x1, H, blocks, out, push) {
  const W = p.W, T = p.T;
  const y0 = clamp(t.y, 0, H - MIN_FIELD), y1 = clamp(t.y + (t.h || style.h), y0 + MIN_FIELD, H);
  const rects = fieldRects(x0, x1, y0, y1, blocks);
  out.rects = rects;
  const rows = Math.max(1, t.rows || 1);
  const recipe = t.style === 'picture-frame' && framePreset(t.frameLayout);
  if (recipe) {
    rects.forEach((r, i) => layPicturePreset(t, p, recipe, r, i, out, push));
    return;
  }
  if (style.planks) {
    const pitch = Math.max(.01, t.spacing || p.pitch || W);
    for (const r of rects) {
      if (style.planks === 'h') {
        // Shiplap: boards run along the wall, laid up from the bottom; a 1/8 in nickel gap shows between.
        const gap = p.gap != null ? p.gap : .003;
        for (let y = r.y0; y < r.y1 - .005; y += pitch) push({ kind: 'board', dir: 'h', x0: r.x0, x1: r.x1, y0: y, y1: Math.min(r.y1, y + pitch - gap), T, profile: p.profile });
      } else {
        const gap = p.gap != null ? p.gap : 0;
        const piece = style === TRIM_STYLES.slat ? W : pitch - gap;
        const step = style === TRIM_STYLES.slat ? Math.max(W + .002, pitch) : pitch;
        if (p.backer) push({ kind: 'board', dir: 'h', x0: r.x0, x1: r.x1, y0: r.y0, y1: r.y1, T: p.backer, profile: 'flat', role: 'backer' });
        for (let x = r.x0; x < r.x1 - .005; x += step) push({ kind: 'board', dir: 'v', x0: x, x1: Math.min(r.x1, x + piece), y0: r.y0, y1: r.y1, T, profile: p.profile, d: p.backer || 0 });
      }
    }
    return;
  }

  const userCols = colsPerRect(rects, t.cols);
  // A count set for one stretch (colsAt) wins over the section's total and over fitting.
  const fullRects = rects.filter(r => r.full);
  const setCols = r => { const v = t.colsAt && r.full ? t.colsAt[fullRects.indexOf(r)] : null; return v == null ? userCols.get(r) : v; };
  const rowSplit = (a, b, gap) => splitSpan(a, b, rows, t.heights, gap);
  if (style.boxes) {
    const frame = t.style === 'picture-frame';
    const gap = t.gap != null ? t.gap : frame ? .1 : 0;
    const inset = t.inset != null ? t.inset : frame ? .09 : 0;
    const insetT = frame && t.insetTop != null ? t.insetTop : inset, insetB = frame && t.insetBottom != null ? t.insetBottom : inset;
    const stile = frame ? 0 : W, topRail = frame ? 0 : Math.max(W, p.rail || W), botRail = frame ? 0 : W;
    for (const r of rects) {
      // Shaker and raised panels: a top rail, a bottom rail and stiles of flat stock frame the panels.
      if (!frame) {
        if (topRail + botRail >= r.y1 - r.y0) {
          push({ kind: 'board', dir: 'h', x0: r.x0, x1: r.x1, y0: r.y0, y1: r.y1, T, profile: p.profile });
          continue;
        }
        push({ kind: 'board', dir: 'h', x0: r.x0, x1: r.x1, y0: r.y1 - topRail, y1: r.y1, T, profile: 'eased' });
        push({ kind: 'board', dir: 'h', x0: r.x0, x1: r.x1, y0: r.y0, y1: r.y0 + botRail, T, profile: 'eased' });
      }
      const ix0 = r.x0 + (frame ? inset : 0), ix1 = r.x1 - (frame ? inset : 0);
      const iy0 = r.y0 + (frame ? insetB : botRail), iy1 = r.y1 - (frame ? insetT : topRail);
      if (ix1 - ix0 < MIN_FIELD || iy1 - iy0 < MIN_FIELD) continue;
      const rowGap = frame ? gap : stile;
      const rowsHere = r.full ? rows : 1;
      const spans = rowsHere > 1 ? rowSplit(iy0, iy1, rowGap) : [[iy0, iy1]];
      if (!spans.length) continue;
      const set = setCols(r);
      const rowH = spans[0][1] - spans[0][0];
      // Framed panels count their clear widths between stiles once a target is set; without one they fit as before.
      const fit = w => frame || !t.target ? autoCount(t.style, w, rowH, null, t.target, gap) : autoCount(t.style, w - 2 * stile, rowH, null, t.target, stile);
      // The stretch's ends (stiles stand there) and its boxes. Boxes: inside the inset, a gap
      // between. Framed panels: stiles at both ends and between bays. A stretch set to no boxes,
      // or whose boxes would be too narrow to read as boxes, stays plain wall.
      // A stretch set to no boxes stays plain only for picture-frame boxes; panels always get one.
      const given = set != null && (frame || set) ? set : null;
      const counts = [given != null ? given : fit(ix1 - ix0)];
      if (r.full) out.cols = Math.max(out.cols, counts[0]);
      let col = 0;
      [[ix0, ix1]].forEach(([a, b], k) => {
        let across = !counts[k] ? [] : frame ? splitSpan(a, b, counts[k], r.full ? t.widths : null, gap) : splitSpan(a + stile, b - stile, counts[k], r.full ? t.widths : null, stile);
        if (frame && t.minBox && across.some(([p0, p1]) => p1 - p0 < t.minBox - 1e-9)) across = [];
        if (frame && !across.length) return;
        if (!frame) {
          const xs = [a, ...across.slice(0, -1).map(([, q]) => q), b - stile];
          for (const x of xs) push({ kind: 'board', dir: 'v', x0: x, x1: x + stile, y0: iy0, y1: iy1, T, profile: 'eased' });
        }
        across.forEach(([bx0, bx1]) => {
          const i = col++;
          spans.forEach(([c, d], j) => {
            if (!frame && j > 0) push({ kind: 'board', dir: 'h', x0: bx0, x1: bx1, y0: c - stile, y1: c, T, profile: 'eased' });
            if (bx1 - bx0 < .03 || d - c < .03) return;
            out.boxes.push({ x0: bx0, x1: bx1, y0: c, y1: d, col: i, row: j, rect: rects.indexOf(r) });
            if (frame) push({ kind: 'frame', x0: bx0, x1: bx1, y0: c, y1: d, W, T, profile: p.profile });
            else if (p.panelThickness) push({ kind: 'board', dir: 'h', x0: bx0, x1: bx1, y0: c, y1: d, T: p.panelThickness, profile: 'flat' });
            else if (t.style === 'raised-panel') {
              const bevel = Math.min(.05, (bx1 - bx0) / 4, (d - c) / 4);
              push({ kind: 'frame', x0: bx0 + .003, x1: bx1 - .003, y0: c + .003, y1: d - .003, W: bevel, T: T * .9, profile: 'raised-bevel' });
              push({ kind: 'board', dir: 'h', x0: bx0 + .003 + bevel, x1: bx1 - .003 - bevel, y0: c + .003 + bevel, y1: d - .003 - bevel, T: T * .54, profile: 'flat' });
            }
          });
        });
      });
    }
    return;
  }

  if (style.bays) {
    // Board and batten, square grid: a top rail, vertical battens, and (grid) rails between rows.
    const spacing = t.spacing || p.spacing || .45;
    const rail = Math.max(W, p.rail || W);
    for (const r of rects) {
      const by1 = Math.max(r.y0, r.y1 - rail);
      push({ kind: 'board', dir: 'h', x0: r.x0, x1: r.x1, y0: by1, y1: r.y1, T, profile: 'eased' });
      if (by1 - r.y0 < .03) continue;
      const rowsHere = t.style === 'grid' && r.full ? rows : 1;
      const spans = rowsHere > 1 ? splitSpan(r.y0, by1, rowsHere, t.heights, W) : [[r.y0, by1]];
      if (!spans.length) continue;
      const set = setCols(r);
      const fit = w => autoCount(t.style, w, spans[0][1] - spans[0][0], t.style === 'grid' ? t.spacing : spacing);
      const counts = [set || fit(r.x1 - r.x0)];
      if (r.full) out.cols = Math.max(out.cols, counts[0]);
      let col = 0;
      [[r.x0, r.x1]].forEach(([a, b], k) => {
        const batten = Math.min(W, b - a);
        const bays = splitSpan(a + batten, b - batten, counts[k], r.full ? t.widths : null, batten);
        const xs = b - a < W * 2 ? [(a + b - batten) / 2] : [a, ...bays.slice(0, -1).map(([, q]) => q), b - batten];
        for (const x of xs) push({ kind: 'board', dir: 'v', x0: x, x1: x + batten, y0: r.y0, y1: by1, T, profile: 'eased' });
        bays.forEach(([p0, p1]) => { const i = col++; spans.forEach(([c, d], j) => out.boxes.push({ x0: p0, x1: p1, y0: c, y1: d, col: i, row: j, rect: rects.indexOf(r) })); });
      });
      for (let j = 1; j < spans.length; j++) push({ kind: 'board', dir: 'h', x0: r.x0, x1: r.x1, y0: spans[j][0] - W, y1: spans[j][0], T, profile: 'eased' });
    }
  }
}

// The vertical extent a record occupies on its wall (for dragging and the panel), metres.
export function trimExtent(t, wallHeight) {
  const s = trimStyle(t), p = trimProduct(t);
  const H = fin(wallHeight, 2.44), W = p ? p.W : .05;
  if (!s) return { y0: 0, y1: 0 };
  if (s.kind === 'crown') return { y0: H - W, y1: H };
  if (s.kind === 'field') return { y0: t.y, y1: Math.min(H, t.y + t.h) };
  return { y0: t.y, y1: t.y + W };
}

// Move a record's bottom edge to `y` (a field keeps its height), inside the wall.
export function setTrimY(t, y, wallHeight) {
  const s = trimStyle(t);
  if (!s || s.kind === 'crown') return;
  const H = fin(wallHeight, 2.44), p = trimProduct(t);
  const tall = s.kind === 'field' ? t.h : (p ? p.W : .05);
  t.y = Math.round(clamp(y, 0, Math.max(0, H - tall)) * 10000) / 10000;
}
// Move one edge of a field: 'top' or 'bottom'.
export function setFieldEdge(t, edge, v, wallHeight) {
  if (!isField(t)) return;
  const H = fin(wallHeight, 2.44);
  const top = t.y + t.h;
  if (edge === 'top') t.h = Math.round(clamp(v - t.y, MIN_FIELD, H - t.y) * 10000) / 10000;
  else { const y = clamp(v, 0, top - MIN_FIELD); t.y = Math.round(y * 10000) / 10000; t.h = Math.round((top - y) * 10000) / 10000; }
}

// Every catalog entry, in panel order: by style group, then style, then the catalog's order.
export function catalogInOrder() {
  const order = Object.keys(TRIM_STYLES);
  return TRIM_CATALOG.slice().sort((a, b) => order.indexOf(a.style) - order.indexOf(b.style));
}

// The wall faces that look into `room`: [{ wall, side }].
export function roomFaces(walls, room, sidesOf) {
  const out = [];
  for (const w of walls) {
    const s = sidesOf(w);
    if (s.pos && s.pos.id === room.id) out.push({ wall: w, side: 1 });
    if (s.neg && s.neg.id === room.id) out.push({ wall: w, side: -1 });
  }
  return out;
}

export { sectionOf };
