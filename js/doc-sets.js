// Drawing sets: the DOCUMENTS workspace's records, kept on the property so they travel in its
// project file. Pure data and arithmetic only (no DOM, no store import), so Node tests run it.
//
// prop.docSets = [{ id, name, paper, orientation, titleBlock: { client, drawnBy, notes },
//   revisions: [{ n, date, note, documentId }], sheets: [{ id, number, title, viewports: [...] }] }]
//
// A viewport sits on the sheet in paper inches from the top-left corner (x, y, w, h). Its kind:
//   plan       level cut seen from above: { levelId, cut (m above the level), center [x, y] plan m,
//              scale, style, layers: { model, dims, rooms } }
//   section    vertical cut along a plan line, looking to one side: { line: [ax, ay, bx, by],
//              flip, center [u, h] (m along the line from its middle, m above 0), scale, style, clip: true }
//   elevation  the same camera with nothing cut away, placed outside the model (clip: false)
//   view3d     perspective camera: { camera: { position, target, fov }, style }
//   image      a photo or a document page: { photoId, page }
//   schedule   a table: { source: 'openings'|'rooms'|'products'|'items', projectId, levelId }
//   text       notes: { text }
// Every viewport also has { id, title, showTitle, number } for its drawing label.

export const PAPERS = [
  { id: 'letter', label: 'Letter, 8 1/2 x 11 in', w: 11, h: 8.5 },
  { id: 'tabloid', label: 'Tabloid, 11 x 17 in', w: 17, h: 11 },
  { id: 'arch-c', label: 'ARCH C, 18 x 24 in', w: 24, h: 18 },
  { id: 'arch-d', label: 'ARCH D, 24 x 36 in', w: 36, h: 24 },
];
export const DEFAULT_PAPER = 'tabloid';

// Architectural scales as model length per paper length (1/4" = 1'-0" is 48).
export const SCALES = [
  { ratio: 12, label: '1" = 1\'-0"' },
  { ratio: 16, label: '3/4" = 1\'-0"' },
  { ratio: 24, label: '1/2" = 1\'-0"' },
  { ratio: 32, label: '3/8" = 1\'-0"' },
  { ratio: 48, label: '1/4" = 1\'-0"' },
  { ratio: 64, label: '3/16" = 1\'-0"' },
  { ratio: 96, label: '1/8" = 1\'-0"' },
  { ratio: 192, label: '1/16" = 1\'-0"' },
  { ratio: 384, label: '1/32" = 1\'-0"' },
];
export const STYLES = [
  { id: 'lines', label: 'Lines (white faces, black edges)' },
  { id: 'shaded-lines', label: 'Shaded with edges' },
  { id: 'shaded', label: 'Shaded' },
];
export const KINDS = {
  plan: 'Plan', section: 'Section', elevation: 'Elevation', view3d: '3D view',
  image: 'Photo or document', schedule: 'Schedule', text: 'Text',
};
export const SCHEDULE_SOURCES = { openings: 'Door and window schedule', rooms: 'Room schedule', products: 'Product schedule', items: 'Scope items of a project' };
export const TITLE_BLOCK_W = 2.5;   // in: the title block strip down the right edge
export const MARGIN = 0.5;          // in: border inset

const ID_RE = /^[\w.:-]{1,80}$/;
const num = v => (typeof v === 'number' || (typeof v === 'string' && v.trim())) ? Number(v) : NaN;
const fin = v => Number.isFinite(num(v));
const str = (v, d = '') => typeof v === 'string' ? v : d;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const vec = (v, n) => Array.isArray(v) && v.length === n && v.every(fin) ? v.map(num) : null;

export function paperOf(set) {
  const p = PAPERS.find(x => x.id === (set && set.paper)) || PAPERS.find(x => x.id === DEFAULT_PAPER);
  const portrait = set && set.orientation === 'portrait';
  return { id: p.id, label: p.label, w: portrait ? p.h : p.w, h: portrait ? p.w : p.h };
}

// The drawing area: the sheet inside its border, left of the title block.
export function drawingArea(set) {
  const p = paperOf(set);
  return { x: MARGIN, y: MARGIN, w: p.w - 2 * MARGIN - TITLE_BLOCK_W, h: p.h - 2 * MARGIN };
}

export function scaleLabel(ratio) {
  const s = SCALES.find(x => x.ratio === ratio);
  return s ? s.label : '1:' + Math.round(ratio);
}

// The scale from the list that shows `worldW` x `worldH` metres inside `paperW` x `paperH` inches.
export function fitScale(worldW, worldH, paperW, paperH) {
  const need = Math.max(worldW / (paperW * 0.0254), worldH / (paperH * 0.0254));
  return (SCALES.find(s => s.ratio >= need) || SCALES[SCALES.length - 1]).ratio;
}

// Metres of model shown across a viewport w inches wide at `scale`.
export const worldSpan = (inches, scale) => inches * 0.0254 * scale;

export function nextScale(ratio, dir) {
  const i = SCALES.findIndex(s => s.ratio === ratio);
  if (i < 0) return fitScale(ratio * 0.0254, ratio * 0.0254, 0.0254, 0.0254);
  return SCALES[clamp(i + (dir > 0 ? 1 : -1), 0, SCALES.length - 1)].ratio;
}

let counter = 0;
export function makeId(prefix) {
  return prefix + '-' + Math.random().toString(36).slice(2, 8) + (Date.now() + counter++).toString(36).slice(-4);
}

export function newSet(name, extra) {
  return normalizeSet(Object.assign({ id: makeId('dset'), name: name || 'Drawing set', paper: DEFAULT_PAPER, orientation: 'landscape',
    titleBlock: { client: '', drawnBy: '', notes: '' }, revisions: [], sheets: [newSheet('A1', 'Plan')] }, extra));
}

export function newSheet(number, title) {
  return { id: makeId('dsheet'), number: number || 'A1', title: title || 'Sheet', viewports: [] };
}

// The next sheet number after the last one: A3 after A2, 7 after 6, A1 when there are none.
export function nextSheetNumber(sheets) {
  const last = sheets && sheets.length ? String(sheets[sheets.length - 1].number || '') : '';
  const m = /^(.*?)(\d+)$/.exec(last);
  return m ? m[1] + (Number(m[2]) + 1) : last ? last + '-2' : 'A1';
}

export function newViewport(kind, box, extra) {
  const base = { id: makeId('vp'), kind, title: KINDS[kind] || 'View', showTitle: kind !== 'text', number: 0,
    x: box.x, y: box.y, w: box.w, h: box.h, style: kind === 'view3d' ? 'shaded-lines' : 'lines', scale: 48 };
  return normalizeViewport(Object.assign(base, extra));
}

// ---------- normalising (hand-edited and older project files) ----------

export function normalizeViewport(v) {
  if (!v || typeof v !== 'object' || !KINDS[v.kind]) return null;
  const out = {
    id: typeof v.id === 'string' && ID_RE.test(v.id) ? v.id : makeId('vp'), kind: v.kind,
    title: str(v.title, KINDS[v.kind]), showTitle: v.showTitle !== false, number: fin(v.number) ? Math.max(0, Math.round(num(v.number))) : 0,
    x: fin(v.x) ? num(v.x) : 1, y: fin(v.y) ? num(v.y) : 1,
    w: fin(v.w) ? clamp(num(v.w), 0.5, 48) : 4, h: fin(v.h) ? clamp(num(v.h), 0.5, 48) : 3,
    style: STYLES.some(s => s.id === v.style) ? v.style : 'lines',
    scale: fin(v.scale) && num(v.scale) > 0 ? clamp(num(v.scale), 1, 5000) : 48,
  };
  if (v.kind === 'plan') {
    out.levelId = str(v.levelId);
    out.cut = fin(v.cut) ? clamp(num(v.cut), 0.05, 20) : 1.2;
    out.center = vec(v.center, 2) || [0, 0];
    const l = v.layers && typeof v.layers === 'object' ? v.layers : {};
    out.layers = { model: l.model !== false, dims: l.dims !== false, rooms: l.rooms !== false };
  } else if (v.kind === 'section' || v.kind === 'elevation') {
    out.line = vec(v.line, 4) || [0, 0, 4, 0];
    out.flip = !!v.flip;
    out.center = vec(v.center, 2) || [0, 1.2];
    out.clip = v.kind === 'section';
    out.depth = fin(v.depth) && num(v.depth) > 0 ? num(v.depth) : 0;   // 0 = everything beyond the cut
    out.wallId = str(v.wallId);
    if (v.kind === 'elevation') out.side = ELEVATION_SIDES[v.side] ? v.side : '';
  } else if (v.kind === 'view3d') {
    const c = v.camera && typeof v.camera === 'object' ? v.camera : {};
    const position = vec(c.position, 3) || [8, 6, 8], target = vec(c.target, 3) || [0, 1, 0];
    out.camera = { position, target, fov: fin(c.fov) ? clamp(num(c.fov), 10, 110) : 50 };
  } else if (v.kind === 'image') {
    out.photoId = str(v.photoId);
    out.page = fin(v.page) ? Math.max(1, Math.round(num(v.page))) : 1;
  } else if (v.kind === 'schedule') {
    out.source = SCHEDULE_SOURCES[v.source] ? v.source : 'openings';
    out.projectId = str(v.projectId);
    out.levelId = str(v.levelId);
  } else if (v.kind === 'text') {
    out.text = str(v.text).slice(0, 20000);
    out.fontSize = fin(v.fontSize) ? clamp(num(v.fontSize), 5, 72) : 9;
  }
  // A model view's own tag visibility, as in a LayOut scene: { tagId | '_untagged': shown }.
  // A tag not listed follows the model's current visibility.
  if (MODEL_KINDS.includes(v.kind)) {
    out.tags = {};
    if (v.tags && typeof v.tags === 'object' && !Array.isArray(v.tags)) {
      for (const [k, on] of Object.entries(v.tags).slice(0, 500)) if (ID_RE.test(k) && typeof on === 'boolean') out.tags[k] = on;
    }
  }
  return out;
}
const MODEL_KINDS = ['plan', 'section', 'elevation', 'view3d'];

export function normalizeSet(s) {
  if (!s || typeof s !== 'object') return null;
  const tb = s.titleBlock && typeof s.titleBlock === 'object' ? s.titleBlock : {};
  const sheets = (Array.isArray(s.sheets) ? s.sheets : []).filter(x => x && typeof x === 'object').map(sh => ({
    id: typeof sh.id === 'string' && ID_RE.test(sh.id) ? sh.id : makeId('dsheet'),
    number: str(sh.number, 'A1').slice(0, 20), title: str(sh.title, 'Sheet').slice(0, 120),
    viewports: (Array.isArray(sh.viewports) ? sh.viewports : []).map(normalizeViewport).filter(Boolean),
  }));
  return {
    id: typeof s.id === 'string' && ID_RE.test(s.id) ? s.id : makeId('dset'),
    name: str(s.name, 'Drawing set').slice(0, 120),
    paper: PAPERS.some(p => p.id === s.paper) ? s.paper : DEFAULT_PAPER,
    orientation: s.orientation === 'portrait' ? 'portrait' : 'landscape',
    titleBlock: { client: str(tb.client).slice(0, 200), drawnBy: str(tb.drawnBy).slice(0, 120), notes: str(tb.notes).slice(0, 2000) },
    revisions: (Array.isArray(s.revisions) ? s.revisions : []).filter(r => r && fin(r.n)).map(r => ({
      n: Math.round(num(r.n)), date: str(r.date).slice(0, 10), note: str(r.note).slice(0, 300), documentId: str(r.documentId) })),
    sheets,
  };
}

export function normalizeDocSets(p) {
  p.docSets = (Array.isArray(p.docSets) ? p.docSets : []).map(normalizeSet).filter(Boolean);
  const seen = new Set();
  for (const s of p.docSets) {
    if (seen.has(s.id)) s.id = makeId('dset');
    seen.add(s.id);
    // Drawing numbers run across the set, as on a printed set: 1, 2, 3 ... in sheet order.
    numberViewports(s);
  }
  return p.docSets;
}

export function numberViewports(set) {
  let n = 0;
  for (const sh of set.sheets) for (const v of sh.viewports) v.number = v.showTitle && v.kind !== 'text' ? ++n : 0;
}

// References to things that may have been deleted: a viewport keeps working, falling back to
// the first level or showing that its photo is gone, so nothing here deletes a viewport.
export function viewportProblems(prop, v) {
  if (v.kind === 'plan' && v.levelId && !(prop.levels || []).some(l => l.id === v.levelId)) return 'Its level was deleted; showing the first level.';
  if (v.kind === 'image' && !(prop.photos || []).some(p => p.id === v.photoId)) return 'Its photo or document is no longer in this property.';
  return '';
}

// ---------- geometry of the orthographic views ----------

// A section or elevation line's frame: unit direction u along it, the look direction n (to its
// right, or left when flipped), its midpoint and length, all in plan metres.
export function lineFrame(v) {
  const [ax, ay, bx, by] = v.line;
  const L = Math.hypot(bx - ax, by - ay) || 1;
  const ux = (bx - ax) / L, uy = (by - ay) / L;
  const s = v.flip ? -1 : 1;
  return { ux, uy, nx: -uy * s, ny: ux * s, mx: (ax + bx) / 2, my: (ay + by) / 2, L };
}

// Where a viewport looks, in world metres (x right, y up, z = plan y): the camera's centre,
// view direction, up vector and the width and height of model it shows.
export function orthoFrame(v) {
  const span = { w: worldSpan(v.w, v.scale), h: worldSpan(v.h, v.scale) };
  if (v.kind === 'plan') {
    return { ...span, center: [v.center[0], 0, v.center[1]], dir: [0, -1, 0], up: [0, 0, -1] };
  }
  const f = lineFrame(v);
  const cx = f.mx + f.ux * v.center[0], cz = f.my + f.uy * v.center[0];
  return { ...span, center: [cx, v.center[1], cz], dir: [f.nx, 0, f.ny], up: [0, 1, 0] };
}

// The clipping plane of a section in world terms: keep a * x + c * z + d >= 0.
export function sectionPlane(v) {
  const f = lineFrame(v);
  const [ax, ay] = v.line;
  return { normal: [f.nx, 0, f.ny], constant: -(f.nx * ax + f.ny * ay) };
}

// A section line drawn across the middle of a plan box: through its centre, along x or y.
export function lineThrough(bounds, along) {
  const cx = (bounds.minX + bounds.maxX) / 2, cy = (bounds.minY + bounds.maxY) / 2;
  const pad = 0.5;
  return along === 'y' ? [cx, bounds.minY - pad, cx, bounds.maxY + pad] : [bounds.minX - pad, cy, bounds.maxX + pad, cy];
}

// An elevation of one side of the model: a line outside the plan bounds, looking in.
// side: 'top' (the plan's -y edge, as drawn on screen), 'bottom' (+y), 'left' (-x), 'right' (+x).
// lineFrame looks to the right of a->b: n = (-uy, ux), so a line running +x looks toward +y.
export const ELEVATION_SIDES = { top: 'Top of the plan', bottom: 'Bottom of the plan', left: 'Left of the plan', right: 'Right of the plan' };
export function elevationLine(bounds, side) {
  const pad = 1.5;
  const { minX, minY, maxX, maxY } = bounds;
  switch (side) {
    case 'bottom': return [maxX + pad, maxY + pad, minX - pad, maxY + pad];
    case 'left': return [minX - pad, maxY + pad, minX - pad, minY - pad];
    case 'right': return [maxX + pad, minY - pad, maxX + pad, maxY + pad];
    default: return [minX - pad, minY - pad, maxX + pad, minY - pad];
  }
}

// ---------- PDF ----------

// A PDF with one full-page JPEG per page. pages: [{ jpeg: Uint8Array, px: [w, h], inches: [w, h] }].
// Returns Uint8Array. Kept minimal on purpose: images, no fonts, so any reader opens it.
export function pdfFromJpegs(pages, info = {}) {
  const enc = new TextEncoder();
  const chunks = [];
  let length = 0;
  const offsets = [];
  const push = data => { const b = typeof data === 'string' ? enc.encode(data) : data; chunks.push(b); length += b.length; };
  const esc = s => String(s || '').replace(/[\\()]/g, m => '\\' + m).replace(/[^\x20-\x7e]/g, '?');
  const n = pages.length;
  // Objects: 1 catalog, 2 pages, 3 info, then per page: page, content, image.
  const obj = (id, body) => { offsets[id] = length; push(id + ' 0 obj\n'); push(body); push('\nendobj\n'); };
  push('%PDF-1.4\n');
  push(new Uint8Array([37, 226, 227, 207, 211, 10]));   // binary marker line
  const pageIds = pages.map((_, i) => 4 + i * 3);
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Count ' + n + ' /Kids [' + pageIds.map(id => id + ' 0 R').join(' ') + '] >>');
  obj(3, '<< /Title (' + esc(info.title) + ') /Producer (Tiksi) /CreationDate (D:' + (info.date || '').replace(/\D/g, '').slice(0, 14) + ') >>');
  pages.forEach((pg, i) => {
    const id = pageIds[i];
    const W = (pg.inches[0] * 72).toFixed(2), H = (pg.inches[1] * 72).toFixed(2);
    const content = 'q ' + W + ' 0 0 ' + H + ' 0 0 cm /Im0 Do Q';
    obj(id, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + W + ' ' + H + '] /Resources << /XObject << /Im0 ' + (id + 2) + ' 0 R >> >> /Contents ' + (id + 1) + ' 0 R >>');
    obj(id + 1, '<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream');
    offsets[id + 2] = length;
    push((id + 2) + ' 0 obj\n<< /Type /XObject /Subtype /Image /Width ' + pg.px[0] + ' /Height ' + pg.px[1] +
      ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + pg.jpeg.length + ' >>\nstream\n');
    push(pg.jpeg);
    push('\nendstream\nendobj\n');
  });
  const count = 4 + n * 3;
  const xref = length;
  let table = 'xref\n0 ' + count + '\n0000000000 65535 f \n';
  for (let i = 1; i < count; i++) table += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  push(table + 'trailer\n<< /Size ' + count + ' /Root 1 0 R /Info 3 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');
  const out = new Uint8Array(length);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}
