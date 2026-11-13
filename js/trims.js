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
//   widths         the boxes' widths as shares of the stretch (null: all the same);
//   heights        the rows' heights as shares (null: all the same);
//   gap, inset     space between boxes and from the box to the field's edge, metres;
//   spacing        board, batten or slat spacing for planked and battened fields (null: the product's);
//   material       the finish (a material id; null: the trim paint, mat-trim).
//
// trimLayout() turns a record into parts in the wall face's own frame: x along the wall from
// end a, y up from the level's floor, d out from the face. Doors and windows (with their
// casings) cut runs and fields; a run that reaches the end of the wall is mitred there to meet
// the next wall's trim (geometry.js does the mitre, as it does for the wall itself).

import { sectionOf, isCrownProfile } from './trim-profiles.js';
import { catalogItem, catalogFor, TRIM_CATALOG } from './trim-catalog.js';

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
  'board-batten': { label: 'Board and batten', group: 'Wainscoting', kind: 'field', y: .14, h: 1.0, bays: true },
  grid: { label: 'Square grid', group: 'Wainscoting', kind: 'field', y: .14, h: 1.22, bays: true, rows: 2 },
  shaker: { label: 'Shaker (recessed) panels', group: 'Wainscoting', kind: 'field', y: .14, h: .78, boxes: true },
  'raised-panel': { label: 'Raised panels', group: 'Wainscoting', kind: 'field', y: .14, h: .78, boxes: true },
  beadboard: { label: 'Beadboard', group: 'Planks and panels', kind: 'field', y: .14, h: .8, planks: 'v' },
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
  if (style.kind === 'field') t.h = clamp(fin(t.h, style.h), MIN_FIELD, 6);
  else delete t.h;
  t.cols = Number.isInteger(t.cols) && t.cols >= 1 && t.cols <= 60 ? t.cols : null;
  t.rows = Number.isInteger(t.rows) && t.rows >= 1 && t.rows <= 12 ? t.rows : (style.rows || 1);
  const shares = (a, n) => Array.isArray(a) && a.length && a.length <= n && a.every(v => Number.isFinite(v) && v > 0) ? a.map(v => +v) : null;
  t.widths = shares(t.widths, 60);
  t.heights = shares(t.heights, 12);
  for (const k of ['gap', 'inset', 'spacing']) t[k] = t[k] != null && Number.isFinite(Number(t[k])) ? clamp(Number(t[k]), 0, 2) : null;
  t.material = typeof t.material === 'string' && t.material ? t.material : null;
  if (typeof t.name !== 'string') t.name = '';
  return t;
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
  if (s.kind === 'field') t.h = at.h != null ? at.h : Math.min(s.h, Math.max(MIN_FIELD, H - y - .05));
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
  }
  t.style = p.style; t.product = p.id;
  if (to.kind === 'field' && t.h == null) t.h = to.h;
  if (to.kind !== 'field') delete t.h;
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
    const plain = o.type !== 'window' && o.plain === true;
    const cw = plain ? 0 : clamp(fin(o.profile && o.profile.casingWidth, .07), 0, .3);
    if (o.type === 'window') {
      const sill = Math.max(0, o.sill || 0);
      out.push({ x0: c - w / 2 - cw, x1: c + w / 2 + cw, y0: Math.max(0, sill - .11), y1: Math.min(H, sill + (o.height || 0) + cw), id: o.id });
    } else {
      out.push({ x0: c - w / 2 - cw, x1: c + w / 2 + cw, y0: 0, y1: Math.min(H, (o.height || 0) + cw), id: o.id });
    }
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
// 30 in wide, bays near the product's spacing.
export function autoCount(style, w, rowH, spacing) {
  if (style === 'grid') return Math.max(1, Math.round(w / Math.max(.15, rowH)));
  if (TRIM_STYLES[style] && TRIM_STYLES[style].bays) return Math.max(1, Math.round(w / Math.max(.1, spacing || .45)));
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
  const x0 = Math.max(e0, t.f0 * L), x1 = Math.min(e1, t.f1 * L);
  if (x1 - x0 < MIN_PIECE) return out;
  const atA = t.f0 <= 1e-3, atB = t.f1 >= 1 - 1e-3;
  const blocks = openingBlocks(wall, openings, L, H);
  const W = p.W, T = p.T;
  const push = part => { if (out.parts.length < MAX_PARTS) out.parts.push(part); };

  if (style.kind === 'run' || style.kind === 'crown') {
    const crown = style.kind === 'crown' || isCrownProfile(p.profile);
    const yb = crown ? H - W : clamp(t.y, 0, Math.max(0, H - W)), yt = yb + W;
    const cuts = blocks.filter(b => b.y1 > yb + 1e-6 && b.y0 < yt - 1e-6);
    for (const piece of subtract(x0, x1, cuts, MIN_PIECE)) {
      push({ kind: 'run', x0: piece.x0, x1: piece.x1, y: yb, W, T, profile: p.profile, crown, mitreA: piece.a && atA, mitreB: piece.b && atB });
    }
    return out;
  }

  // Fields.
  const y0 = clamp(t.y, 0, H - MIN_FIELD), y1 = clamp(t.y + (t.h || style.h), y0 + MIN_FIELD, H);
  const rects = fieldRects(x0, x1, y0, y1, blocks);
  out.rects = rects;
  const rows = Math.max(1, t.rows || 1);
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
    return out;
  }

  const userCols = colsPerRect(rects, t.cols);
  const rowSplit = (a, b, gap) => splitSpan(a, b, rows, t.heights, gap);
  if (style.boxes) {
    const frame = t.style === 'picture-frame';
    const gap = t.gap != null ? t.gap : frame ? .1 : 0;
    const inset = t.inset != null ? t.inset : frame ? .09 : 0;
    const stile = frame ? 0 : W, topRail = frame ? 0 : Math.max(W, p.rail || W), botRail = frame ? 0 : W;
    for (const r of rects) {
      // Shaker and raised panels: a top rail, a bottom rail and stiles of flat stock frame the panels.
      if (!frame) {
        push({ kind: 'board', dir: 'h', x0: r.x0, x1: r.x1, y0: r.y1 - topRail, y1: r.y1, T, profile: 'eased' });
        push({ kind: 'board', dir: 'h', x0: r.x0, x1: r.x1, y0: r.y0, y1: r.y0 + botRail, T, profile: 'eased' });
      }
      const ix0 = r.x0 + (frame ? inset : 0), ix1 = r.x1 - (frame ? inset : 0);
      const iy0 = r.y0 + (frame ? inset : botRail), iy1 = r.y1 - (frame ? inset : topRail);
      if (ix1 - ix0 < MIN_FIELD || iy1 - iy0 < MIN_FIELD) continue;
      const rowGap = frame ? gap : stile;
      const rowsHere = r.full ? rows : 1;
      const spans = rowsHere > 1 ? rowSplit(iy0, iy1, rowGap) : [[iy0, iy1]];
      const n = userCols.get(r) || autoCount(t.style, ix1 - ix0, spans[0][1] - spans[0][0], null);
      if (r.full) out.cols = Math.max(out.cols, n);
      // Boxes: inside the inset, a gap between. Framed panels: stiles at both ends and between bays.
      const across = frame ? splitSpan(ix0, ix1, n, r.full ? t.widths : null, gap) : splitSpan(r.x0 + stile, r.x1 - stile, n, r.full ? t.widths : null, stile);
      if (!frame) {
        const xs = [r.x0, ...across.slice(0, -1).map(([, b]) => b), r.x1 - stile];
        for (const x of xs) push({ kind: 'board', dir: 'v', x0: x, x1: x + stile, y0: iy0, y1: iy1, T, profile: 'eased' });
      }
      across.forEach(([bx0, bx1], i) => {
        spans.forEach(([c, d], j) => {
          if (!frame && j > 0) push({ kind: 'board', dir: 'h', x0: bx0, x1: bx1, y0: c - stile, y1: c, T, profile: 'eased' });
          if (bx1 - bx0 < .03 || d - c < .03) return;
          out.boxes.push({ x0: bx0, x1: bx1, y0: c, y1: d, col: i, row: j, rect: rects.indexOf(r) });
          if (frame) push({ kind: 'frame', x0: bx0, x1: bx1, y0: c, y1: d, W, T, profile: p.profile });
          else if (t.style === 'raised-panel') {
            const bevel = Math.min(.05, (bx1 - bx0) / 4, (d - c) / 4);
            push({ kind: 'frame', x0: bx0 + .003, x1: bx1 - .003, y0: c + .003, y1: d - .003, W: bevel, T: T * .9, profile: 'raised-bevel' });
            push({ kind: 'board', dir: 'h', x0: bx0 + .003 + bevel, x1: bx1 - .003 - bevel, y0: c + .003 + bevel, y1: d - .003 - bevel, T: T * .54, profile: 'flat' });
          }
        });
      });
    }
    return out;
  }

  if (style.bays) {
    // Board and batten, square grid: a top rail, vertical battens, and (grid) rails between rows.
    const spacing = t.spacing || p.spacing || .45;
    const rail = Math.max(W, p.rail || W);
    for (const r of rects) {
      push({ kind: 'board', dir: 'h', x0: r.x0, x1: r.x1, y0: r.y1 - rail, y1: r.y1, T, profile: 'eased' });
      const by1 = r.y1 - rail;
      if (by1 - r.y0 < .03) continue;
      const rowsHere = t.style === 'grid' && r.full ? rows : 1;
      const spans = rowsHere > 1 ? splitSpan(r.y0, by1, rowsHere, t.heights, W) : [[r.y0, by1]];
      const n = userCols.get(r) || autoCount(t.style, r.x1 - r.x0, spans[0][1] - spans[0][0], spacing);
      if (r.full) out.cols = Math.max(out.cols, n);
      const bays = splitSpan(r.x0 + W, r.x1 - W, n, r.full ? t.widths : null, W);
      const xs = [r.x0, ...bays.slice(0, -1).map(([, b]) => b), r.x1 - W];
      for (const x of xs) push({ kind: 'board', dir: 'v', x0: x, x1: x + W, y0: r.y0, y1: by1, T, profile: 'eased' });
      for (let j = 1; j < spans.length; j++) push({ kind: 'board', dir: 'h', x0: r.x0, x1: r.x1, y0: spans[j][0] - W, y1: spans[j][0], T, profile: 'eased' });
      bays.forEach(([a, b], i) => spans.forEach(([c, d], j) => out.boxes.push({ x0: a, x1: b, y0: c, y1: d, col: i, row: j, rect: rects.indexOf(r) })));
    }
  }
  return out;
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
