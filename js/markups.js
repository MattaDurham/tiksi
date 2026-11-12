// Markups: freehand ink and numbered notes drawn over MODEL and PLAN. Kept on the property so
// they travel in its project file. Pure data only (no DOM, no three.js), so Node tests run it;
// markup-layer.js draws them and takes the pen, finger and mouse.
//
// prop.markups = [{ id, number, name, on: 'model' | 'plan', status: 'open' | 'done',
//   view: a saved view's camera, mode, section, x-ray and hidden levels   (on === 'model')
//   levelId: the level the ink sits on                                     (on === 'plan')
//   strokes: [{ id, tool: 'pen' | 'marker', color: '#rrggbb', width, pts: [x, y, pressure, ...],
//               on: [{ k: kind, id, p: [x, y, z] }] }],
//   notes: [{ id, n, text, at: [x, y], anchor: { x, y, z, nx, ny, nz, wall? }, kind, ref }],
//   createdAt }]
// Nothing here counts or stamps changes: two devices adding to one markup must merge record by
// record, and a shared counter or a last-changed time would be the one field they both wrote.
//
// Ink over MODEL belongs to the camera it was drawn from: x and y are measured from the middle
// of the view in view heights (the lens angle is vertical, so a wider or narrower window keeps
// the ink on the same things), and `width` is a fraction of the view height. Ink on PLAN is in
// metres on its level and `width` is metres. A stroke's `on` is where sampled points of it meet
// the model: what a line across a wall is drawn on, for whoever reads the markup later. A note
// with an `anchor` is pinned to that point of the model and shows from any camera; without one
// it sits at `at` in its markup's own view.

import { normalizeSavedView } from './saved-views.js';
import { normalizeWallAnchor } from './pin-records.js';

export const MARKUP_COLORS = ['#e5372b', '#1f6feb', '#1a9c4b', '#f2b705', '#111111', '#ffffff'];
export const MARKER_ALPHA = 0.38;
const ID_RE = /^[\w.:-]{1,80}$/;
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const MAX_MARKUPS = 300, MAX_STROKES = 3000, MAX_POINTS = 4000, MAX_NOTES = 200, MAX_TEXT = 2000, MAX_ON = 12;
const num = v => (typeof v === 'number' || (typeof v === 'string' && v.trim())) ? Number(v) : NaN;
const fin = v => Number.isFinite(num(v));
const cleanName = v => String(typeof v === 'string' ? v : '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
const cleanText = v => String(typeof v === 'string' ? v : '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').slice(0, MAX_TEXT);
let counter = 0;
const newId = prefix => prefix + '-' + Date.now().toString(36) + (counter++).toString(36) + Math.random().toString(36).slice(2, 6);
const takeId = (v, taken, prefix) => {
  let id = typeof v === 'string' && ID_RE.test(v) && !taken.has(v) ? v : newId(prefix);
  while (taken.has(id)) id = newId(prefix);
  taken.add(id);
  return id;
};
const isoDate = v => typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : new Date(0).toISOString();

// ---------- points ----------
// Round a flat [x, y, pressure, ...] list for saving: `digits` places for the position, two
// for the pressure. Triples with a number that is not finite are dropped.
export function roundPoints(pts, digits = 5) {
  const k = 10 ** digits, out = [];
  for (let i = 0; i + 2 < pts.length; i += 3) {
    const x = num(pts[i]), y = num(pts[i + 1]), p = num(pts[i + 2]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    out.push(Math.round(x * k) / k, Math.round(y * k) / k, Math.round(Math.min(1, Math.max(0, Number.isFinite(p) ? p : 0.5)) * 100) / 100);
  }
  return out;
}

// Fewer points for the same line (Ramer-Douglas-Peucker on the positions): a point stays when it
// is further than `tol` from the straight line between its kept neighbours. The ends stay.
export function simplifyPoints(pts, tol) {
  const n = Math.floor(pts.length / 3);
  if (n <= 2 || !(tol > 0)) return pts.slice(0, n * 3);
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const ax = pts[a * 3], ay = pts[a * 3 + 1], dx = pts[b * 3] - ax, dy = pts[b * 3 + 1] - ay;
    const len2 = dx * dx + dy * dy;
    let worst = -1, far = 0;
    for (let i = a + 1; i < b; i++) {
      const px = pts[i * 3] - ax, py = pts[i * 3 + 1] - ay;
      const t = len2 > 0 ? Math.min(1, Math.max(0, (px * dx + py * dy) / len2)) : 0;
      const d = Math.hypot(px - t * dx, py - t * dy);
      if (d > far) { far = d; worst = i; }
    }
    if (worst > 0 && far > tol) { keep[worst] = 1; stack.push([a, worst], [worst, b]); }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]);
  return out;
}

// [minX, minY, maxX, maxY] of a stroke's points, or null when it has none.
export function strokeBounds(stroke) {
  const p = stroke.pts;
  if (!p || p.length < 3) return null;
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (let i = 0; i + 2 < p.length; i += 3) {
    if (p[i] < a) a = p[i]; if (p[i] > c) c = p[i];
    if (p[i + 1] < b) b = p[i + 1]; if (p[i + 1] > d) d = p[i + 1];
  }
  return [a, b, c, d];
}
// Everything a markup holds, as one box in its own coordinates (notes by where they sit).
export function markupBounds(markup) {
  let box = null;
  const grow = (x0, y0, x1, y1) => { box = box ? [Math.min(box[0], x0), Math.min(box[1], y0), Math.max(box[2], x1), Math.max(box[3], y1)] : [x0, y0, x1, y1]; };
  for (const s of markup.strokes) { const b = strokeBounds(s); if (b) grow(b[0] - s.width / 2, b[1] - s.width / 2, b[2] + s.width / 2, b[3] + s.width / 2); }
  for (const n of markup.notes) grow(n.at[0], n.at[1], n.at[0], n.at[1]);
  return box;
}

// Is (x, y) within `r` of the stroke's line (its own half width counts too)? For the eraser.
export function strokeHit(stroke, x, y, r) {
  const p = stroke.pts, reach = r + stroke.width / 2;
  const b = strokeBounds(stroke);
  if (!b || x < b[0] - reach || x > b[2] + reach || y < b[1] - reach || y > b[3] + reach) return false;
  if (p.length < 6) return Math.hypot(x - p[0], y - p[1]) <= reach;
  for (let i = 0; i + 5 < p.length; i += 3) {
    const ax = p[i], ay = p[i + 1], dx = p[i + 3] - ax, dy = p[i + 4] - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
    if (Math.hypot(x - ax - t * dx, y - ay - t * dy) <= reach) return true;
  }
  return false;
}

// How wide the pen draws at a pressure: the chosen width at half pressure, about a third of it
// at the lightest touch and a little over one and a half times at the hardest.
export function penWidth(base, pressure) {
  const p = Number.isFinite(pressure) ? Math.min(1, Math.max(0, pressure)) : 0.5;
  return base * (0.35 + 1.3 * p);
}
// Was the whole stroke drawn at one pressure (a mouse, a finger)? Then it is one even line.
export function evenPressure(pts) {
  for (let i = 5; i < pts.length; i += 3) if (Math.abs(pts[i] - pts[2]) > 0.02) return false;
  return true;
}

// ---------- cameras ----------
// Two cameras show the same picture when they stand in the same place, look the same way and
// have the same lens. Where the orbit target sits along the line of sight does not matter (the
// navigation moves it as fingers land). `eps` is the slack, as a fraction of the viewing
// distance for the position and in radians for the direction: about two thousandths of the
// view's height on the screen either way.
export function sameCamera(a, b, eps = 2e-3) {
  if (!a || !b) return false;
  const dir = c => { const v = [0, 1, 2].map(i => c.target[i] - c.position[i]), l = Math.hypot(...v); return { v: l > 0 ? v.map(x => x / l) : [0, 0, -1], l }; };
  const da = dir(a), db = dir(b), reach = Math.max(0.02, Math.min(da.l, db.l));
  for (let i = 0; i < 3; i++) {
    if (Math.abs(a.position[i] - b.position[i]) > eps * reach) return false;
    if (Math.abs(da.v[i] - db.v[i]) > eps) return false;
  }
  return Math.abs(a.fov - b.fov) < 0.05;
}

// ---------- records ----------
function normalizeAnchor(a) {
  if (!a || typeof a !== 'object' || !['x', 'y', 'z'].every(k => fin(a[k]))) return null;
  const out = { x: num(a.x), y: num(a.y), z: num(a.z) };
  for (const k of ['nx', 'ny', 'nz']) out[k] = fin(a[k]) ? num(a[k]) : (k === 'ny' ? 1 : 0);
  if (a.wall !== undefined) { const w = normalizeWallAnchor(a.wall); if (w) out.wall = w; }
  return out;
}
function normalizeStroke(s, taken) {
  if (!s || typeof s !== 'object' || !Array.isArray(s.pts)) return null;
  const pts = [];
  for (let i = 0; i + 2 < s.pts.length && pts.length < MAX_POINTS * 3; i += 3) {
    const x = num(s.pts[i]), y = num(s.pts[i + 1]), p = num(s.pts[i + 2]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 1e6 || Math.abs(y) > 1e6) continue;
    pts.push(x, y, Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : 0.5);
  }
  if (pts.length < 3) return null;
  const width = num(s.width);
  const out = {
    id: takeId(s.id, taken, 'ink'), tool: s.tool === 'marker' ? 'marker' : 'pen',
    color: typeof s.color === 'string' && COLOR_RE.test(s.color) ? s.color.toLowerCase() : MARKUP_COLORS[0],
    width: Number.isFinite(width) && width > 0 && width < 1e3 ? width : 0.005, pts,
  };
  if (Array.isArray(s.on)) {
    const on = [];
    for (const h of s.on.slice(0, MAX_ON)) {
      if (!h || typeof h !== 'object' || !Array.isArray(h.p) || h.p.length !== 3 || !h.p.every(fin)) continue;
      on.push({ k: cleanName(h.k).slice(0, 20), id: typeof h.id === 'string' && ID_RE.test(h.id) ? h.id : '', p: h.p.map(num) });
    }
    if (on.length) out.on = on;
  }
  return out;
}
function normalizeNote(n, taken, index) {
  if (!n || typeof n !== 'object') return null;
  const anchor = normalizeAnchor(n.anchor);
  const at = Array.isArray(n.at) && n.at.length === 2 && n.at.every(fin) ? n.at.map(num) : null;
  if (!anchor && !at) return null;
  const out = { id: takeId(n.id, taken, 'mnote'), n: Number.isInteger(num(n.n)) && num(n.n) > 0 ? num(n.n) : index + 1, text: cleanText(n.text), at: at || [0, 0] };
  if (anchor) out.anchor = anchor;
  if (typeof n.kind === 'string' && n.kind) out.kind = cleanName(n.kind).slice(0, 20);
  if (typeof n.ref === 'string' && ID_RE.test(n.ref)) out.ref = n.ref;
  return out;
}
export function normalizeMarkup(m, taken = new Set()) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  const on = m.on === 'plan' ? 'plan' : 'model';
  let view = null;
  if (on === 'model') {
    const v = normalizeSavedView(m.view);
    if (!v) return null;   // ink over the model with no camera cannot be shown
    view = { camera: v.camera, mode: v.mode, tags: v.tags, section: v.section, xray: v.xray, hiddenLevels: v.hiddenLevels };
  } else if (typeof m.levelId !== 'string' || !ID_RE.test(m.levelId)) return null;
  const inner = new Set();
  const strokes = [], notes = [];
  for (const s of Array.isArray(m.strokes) ? m.strokes.slice(0, MAX_STROKES) : []) { const x = normalizeStroke(s, inner); if (x) strokes.push(x); }
  for (const n of Array.isArray(m.notes) ? m.notes.slice(0, MAX_NOTES) : []) { const x = normalizeNote(n, inner, notes.length); if (x) notes.push(x); }
  const out = {
    id: takeId(m.id, taken, 'markup'), number: Number.isInteger(num(m.number)) && num(m.number) > 0 ? num(m.number) : 0, name: cleanName(m.name), on,
    status: m.status === 'done' ? 'done' : 'open', strokes, notes, createdAt: isoDate(m.createdAt),
  };
  if (view) out.view = view; else out.levelId = m.levelId;
  return out;
}
export function normalizeMarkups(p) {
  const taken = new Set(), out = [];
  for (const m of Array.isArray(p.markups) ? p.markups.slice(0, MAX_MARKUPS) : []) {
    const n = normalizeMarkup(m, taken);
    if (n) out.push(n);
  }
  // Numbers are unique: two devices that each made "Markup 4" keep both, the later one renumbered
  // (the same way on every device, since the merged list has one order).
  let top = out.reduce((n, m) => Math.max(n, m.number), 0);
  const used = new Set();
  for (const m of out) { if (!m.number || used.has(m.number)) m.number = ++top; used.add(m.number); }
  p.markups = out;
  return p;
}

export const markupById = (prop, id) => (prop.markups || []).find(m => m.id === id) || null;
export const markupTitle = m => m.name || 'Markup ' + m.number;
export const markupEmpty = m => !m.strokes.length && !m.notes.length;

// A new, empty markup: `where` is { on: 'model', view } or { on: 'plan', levelId }.
export function addMarkup(prop, where) {
  if ((prop.markups || []).length >= MAX_MARKUPS) throw new Error('This property already has ' + MAX_MARKUPS + ' markups. Delete some first.');
  const number = (prop.markups || []).reduce((n, x) => Math.max(n, x.number), 0) + 1;
  const m = normalizeMarkup({ ...where, number, strokes: [], notes: [], createdAt: new Date().toISOString() }, new Set((prop.markups || []).map(x => x.id)));
  if (!m) throw new Error(where && where.on === 'plan' ? 'This markup has no level' : 'This markup has no usable camera');
  (prop.markups = prop.markups || []).push(m);
  return m;
}
// Put back a markup taken out earlier (undo of a delete, redo of a first stroke), where it was.
export function restoreMarkup(prop, markup, index) {
  const list = prop.markups = prop.markups || [];
  if (list.some(m => m.id === markup.id)) return markupById(prop, markup.id);
  const m = normalizeMarkup(markup, new Set(list.map(x => x.id)));
  if (!m) return null;
  m.id = markup.id;
  list.splice(Math.min(Math.max(0, index ?? list.length), list.length), 0, m);
  return m;
}
export function deleteMarkup(prop, id) {
  const list = prop.markups || [], i = list.findIndex(m => m.id === id);
  if (i < 0) return null;
  return { markup: list.splice(i, 1)[0], index: i };
}
export function renameMarkup(prop, id, name) {
  const m = markupById(prop, id);
  if (!m) return false;
  m.name = cleanName(name);
  return true;
}
export function setMarkupStatus(prop, id, status) {
  const m = markupById(prop, id);
  if (!m) return false;
  m.status = status === 'done' ? 'done' : 'open';
  return true;
}

// `stroke` = { tool, color, width, pts }. Null when it has no usable point or the markup is full.
export function addStroke(markup, stroke, index) {
  if (markup.strokes.length >= MAX_STROKES) return null;
  const s = normalizeStroke(stroke, new Set([...markup.strokes, ...markup.notes].map(x => x.id)));
  if (!s) return null;
  if (typeof stroke.id === 'string' && ID_RE.test(stroke.id) && !markup.strokes.some(x => x.id === stroke.id)) s.id = stroke.id;
  markup.strokes.splice(Math.min(Math.max(0, index ?? markup.strokes.length), markup.strokes.length), 0, s);
  return s;
}
export function removeStroke(markup, id) {
  const i = markup.strokes.findIndex(s => s.id === id);
  if (i < 0) return null;
  return { stroke: markup.strokes.splice(i, 1)[0], index: i };
}
// `note` = { at, anchor?, kind?, ref?, text? }; its number is the next one free in this markup.
export function addNote(markup, note) {
  if (markup.notes.length >= MAX_NOTES) return null;
  const n = normalizeNote({ ...note, n: note.n || markup.notes.reduce((top, x) => Math.max(top, x.n), 0) + 1 }, new Set([...markup.strokes, ...markup.notes].map(x => x.id)), markup.notes.length);
  if (!n) return null;
  if (typeof note.id === 'string' && ID_RE.test(note.id) && !markup.notes.some(x => x.id === note.id)) n.id = note.id;
  markup.notes.push(n);
  markup.notes.sort((a, b) => a.n - b.n);
  return n;
}
export function removeNote(markup, id) {
  const i = markup.notes.findIndex(n => n.id === id);
  if (i < 0) return null;
  return markup.notes.splice(i, 1)[0];
}
export function setNoteText(markup, id, text) {
  const n = markup.notes.find(x => x.id === id);
  if (!n) return false;
  n.text = cleanText(text);
  return true;
}
// Markups left with nothing in them (the last stroke erased or undone) are taken out.
export function pruneEmptyMarkups(prop, keepId = null) {
  const before = (prop.markups || []).length;
  prop.markups = (prop.markups || []).filter(m => m.id === keepId || !markupEmpty(m));
  return before - prop.markups.length;
}
