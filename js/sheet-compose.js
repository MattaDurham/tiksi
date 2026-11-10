// One sheet as SVG: border, title block, viewports with their drawing labels, schedules and text.
// The same markup is shown in DOCUMENTS and rasterised for the PDF, so what you see is what prints.

import { ws, escapeHtml as esc, fmtLen, fmtArea, fmtMoney, polyArea, itemTotals } from './store.js';
import { openingSchedule } from './opening-schedule.js';
import { paperOf, drawingArea, scaleLabel, TITLE_BLOCK_W, MARGIN, SCHEDULE_SOURCES, viewportProblems } from './doc-sets.js';
import { planVectorSvg, planMarksSvg } from './sheet-render.js';

const PT = 72;
const FONT = 'Helvetica, Arial, sans-serif';
const n2 = x => Math.round(x * 100) / 100;

// Rough text width in points for Helvetica: good enough to wrap and truncate table cells.
const textWidth = (s, size) => String(s).length * size * 0.52;
export function wrapText(s, size, width) {
  const lines = [];
  for (const para of String(s || '').split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      if (!word) continue;
      const next = line ? line + ' ' + word : word;
      if (textWidth(next, size) <= width || !line) line = next;
      else { lines.push(line); line = word; }
    }
    lines.push(line);
  }
  return lines;
}
const fit = (s, size, width) => {
  s = String(s ?? '');
  if (textWidth(s, size) <= width) return s;
  const n = Math.max(1, Math.floor(width / (size * 0.52)) - 1);
  return s.slice(0, n) + '…';
};

function text(x, y, s, { size = 7, weight = 400, anchor = 'start', fill = '#111', extra = '' } = {}) {
  return `<text x="${n2(x)}" y="${n2(y)}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}" fill="${fill}" ${extra}>${esc(s)}</text>`;
}

// ---------- schedules ----------

function scheduleRows(prop, v) {
  const d = ws.data;
  if (v.source === 'rooms') {
    const lv = new Map((prop.levels || []).map(l => [l.id, l.name]));
    // Room corners sit on wall centre lines, so the area is to the centre lines and says so.
    return { head: ['Room', 'Level', 'Area to wall CL', 'Floor'], widths: [0.3, 0.2, 0.22, 0.28],
      rows: (prop.rooms || []).filter(r => !v.levelId || r.level === v.levelId).map(r => {
        const mat = d.materials.find(m => m.id === r.material);
        return [r.name || 'Room', lv.get(r.level) || '', fmtArea(Math.abs(polyArea(r.pts || []))), mat ? mat.name : ''];
      }) };
  }
  if (v.source === 'products') {
    const items = new Set(d.projects.filter(p => p.propertyId === prop.id).flatMap(p => p.items.map(i => i.id)));
    return { head: ['Product', 'Brand and model', 'Category', 'Price', 'Unit'], widths: [0.34, 0.32, 0.12, 0.13, 0.09],
      rows: d.products.filter(p => (p.itemIds || []).some(i => items.has(i)) || (p.propertyIds || []).includes(prop.id))
        .map(p => [p.name, [p.brand, p.model].filter(Boolean).join(' '), p.category || '', p.price ? fmtMoney(p.price) : 'TBD', p.unit || 'ea']) };
  }
  if (v.source === 'items') {
    const pr = d.projects.find(p => p.id === v.projectId && p.propertyId === prop.id);
    return { head: ['Item', 'Qty', 'Unit', 'Likely', 'Notes'], widths: [0.34, 0.08, 0.07, 0.11, 0.40], title: pr ? pr.name : 'No project chosen',
      rows: pr ? pr.items.map(it => [it.name, String(it.qty ?? 1), it.unit || '', it.likely ? fmtMoney(itemTotals(it).likely) : '', it.notes || '']) : [] };
  }
  const rows = openingSchedule(prop, v.levelId || null);
  return { head: ['Mark', 'Type', 'Width', 'Height', 'Sill', 'Level', 'Between'], widths: [0.08, 0.1, 0.12, 0.12, 0.1, 0.16, 0.32],
    rows: rows.map(r => [r.number, r.type, fmtLen(r.width), fmtLen(r.height), r.sill == null ? '' : fmtLen(r.sill), r.levelName, r.sides.map(s => s.name).join(' / ')]) };
}

function scheduleSvg(prop, v) {
  const W = v.w * PT, H = v.h * PT;
  const t = scheduleRows(prop, v);
  const size = 6.5, rowH = 10.5;
  const out = [];
  let y = 0;
  if (t.title) { out.push(text(0, y + 8, t.title, { size: 7.5, weight: 700 })); y += 13; }
  const xs = [];
  let x = 0;
  for (const w of t.widths) { xs.push(x); x += w * W; }
  out.push(`<rect x="0" y="${n2(y)}" width="${n2(W)}" height="${rowH + 1}" fill="#ece9e2"/>`);
  t.head.forEach((h, i) => out.push(text(xs[i] + 3, y + 7.5, fit(h.toUpperCase(), size, t.widths[i] * W - 6), { size: 6, weight: 700 })));
  y += rowH + 1;
  let shown = 0;
  for (const r of t.rows) {
    if (y + rowH > H - (t.rows.length - shown > 1 ? rowH : 0)) break;
    r.forEach((c, i) => out.push(text(xs[i] + 3, y + 7.5, fit(c, size, t.widths[i] * W - 6), { size })));
    out.push(`<line x1="0" y1="${n2(y + rowH)}" x2="${n2(W)}" y2="${n2(y + rowH)}" stroke="#d6d2c8" stroke-width="0.4"/>`);
    y += rowH; shown++;
  }
  if (shown < t.rows.length) out.push(text(3, y + 7.5, (t.rows.length - shown) + ' more rows: make this view taller', { size: 6, fill: '#a33' }));
  if (!t.rows.length) out.push(text(3, y + 8, 'Nothing to list yet.', { size, fill: '#777' }));
  return out.join('');
}

// Text that does not fit its box ends with a red note, as a schedule's extra rows do.
export function textSvg(v) {
  const W = v.w * PT, H = v.h * PT;
  const size = v.fontSize, lh = size * 1.3;
  const all = wrapText(v.text, size, W);
  const fits = Math.max(0, Math.floor((H - size) / lh) + 1);
  const shown = all.length > fits ? all.slice(0, Math.max(0, fits - 1)) : all;
  const out = shown.map((l, i) => text(0, size + i * lh, l, { size, weight: i === 0 && /^[A-Z0-9 ,.'-]{3,}$/.test(l) ? 700 : 400 }));
  if (shown.length < all.length) {
    const more = all.length - shown.length;
    out.push(text(0, Math.min(H - 1, size + shown.length * lh), more + ' more line' + (more === 1 ? '' : 's') + ': make this view taller', { size: Math.min(size, 6), fill: '#a33' }));
  }
  return out.join('');
}

// ---------- the sheet ----------

function titleBlock(prop, set, sheet, paper, opts) {
  const x = paper.w - MARGIN - TITLE_BLOCK_W, y = MARGIN, w = TITLE_BLOCK_W, h = paper.h - 2 * MARGIN;
  const X = x * PT, Y = y * PT, Wd = w * PT, Hd = h * PT, pad = 8;
  const rev = set.revisions[set.revisions.length - 1];
  const out = [`<rect x="${n2(X)}" y="${n2(Y)}" width="${n2(Wd)}" height="${n2(Hd)}" fill="#fff" stroke="#111" stroke-width="1"/>`];
  let cy = Y + pad;
  const block = (label, value, size = 8, weight = 400) => {
    out.push(text(X + pad, cy + 6, label.toUpperCase(), { size: 5.5, weight: 700, fill: '#666' }));
    cy += 9;
    // Four lines at most; longer text says how much is left out instead of stopping silently.
    const all = wrapText(value || '-', size, Wd - 2 * pad), shown = all.length > 4 ? all.slice(0, 3) : all;
    for (const l of shown) { cy += size + 1.5; out.push(text(X + pad, cy, l, { size, weight })); }
    if (shown.length < all.length) { cy += 7.5; out.push(text(X + pad, cy, (all.length - shown.length) + ' more lines not shown: shorten this', { size: 6, fill: '#a33' })); }
    cy += 6;
    out.push(`<line x1="${n2(X)}" y1="${n2(cy)}" x2="${n2(X + Wd)}" y2="${n2(cy)}" stroke="#111" stroke-width="0.5"/>`);
    cy += 4;
  };
  block('Project', prop.name, 11, 700);
  block('Address', prop.address || '');
  if (set.titleBlock.client) block('Client', set.titleBlock.client);
  block('Drawing set', set.name);
  if (set.titleBlock.drawnBy) block('Drawn by', set.titleBlock.drawnBy);
  if (set.titleBlock.notes) block('Notes', set.titleBlock.notes, 6.5);
  // Revisions and the sheet number sit at the bottom, as on a printed title block.
  const bottom = Y + Hd;
  const revs = set.revisions.slice(-5);
  let ry = bottom - 92 - revs.length * 9 - 14;
  out.push(`<line x1="${n2(X)}" y1="${n2(ry)}" x2="${n2(X + Wd)}" y2="${n2(ry)}" stroke="#111" stroke-width="0.5"/>`);
  out.push(text(X + pad, ry + 10, 'REVISIONS', { size: 5.5, weight: 700, fill: '#666' }));
  ry += 12;
  if (!revs.length) out.push(text(X + pad, ry + 7, 'None saved yet', { size: 6.5, fill: '#777' }));
  for (const r of revs) { out.push(text(X + pad, ry + 7, r.n + '   ' + r.date + '   ' + fit(r.note || 'Issued', 6.5, Wd - 2 * pad - 60), { size: 6.5 })); ry += 9; }
  const by = bottom - 92;
  out.push(`<line x1="${n2(X)}" y1="${n2(by)}" x2="${n2(X + Wd)}" y2="${n2(by)}" stroke="#111" stroke-width="1"/>`);
  out.push(text(X + pad, by + 12, 'SHEET TITLE', { size: 5.5, weight: 700, fill: '#666' }));
  wrapText(sheet.title, 9, Wd - 2 * pad).slice(0, 2).forEach((l, i) => out.push(text(X + pad, by + 24 + i * 11, l, { size: 9, weight: 700 })));
  out.push(text(X + pad, by + 56, 'DATE  ' + (opts.date || ''), { size: 6 }), text(X + pad, by + 66, 'REVISION  ' + (rev ? rev.n : '-'), { size: 6 }));
  out.push(text(X + Wd - pad, by + 82, sheet.number, { size: 24, weight: 700, anchor: 'end' }));
  out.push(text(X + pad, by + 82, 'SHEET ' + (opts.index + 1) + ' OF ' + opts.count, { size: 6, fill: '#444' }));
  return out.join('');
}

function label(v) {
  if (!v.showTitle || v.kind === 'text') return '';
  const y = v.h * PT + 12;
  // A plan's wall dimensions and room areas are measured on wall centre lines: say so.
  const cl = v.kind === 'plan' && v.layers && (v.layers.dims || v.layers.rooms) ? (v.layers.dims && v.layers.rooms ? 'DIMENSIONS AND AREAS' : v.layers.dims ? 'DIMENSIONS' : 'AREAS') + ' TO WALL CENTRE LINES' : '';
  const sc = ['plan', 'section', 'elevation'].includes(v.kind) ? 'SCALE: ' + scaleLabel(v.scale) : '';
  const t = v.title.toUpperCase();
  const tw = Math.min(textWidth(t, 8) + 4, v.w * PT - 22);
  return `<g>
    <circle cx="8" cy="${n2(y)}" r="8" fill="#fff" stroke="#111" stroke-width="0.8"/>${text(8, y + 3, String(v.number || ''), { size: 8, weight: 700, anchor: 'middle' })}
    ${text(22, y + 1, fit(t, 8, v.w * PT - 22), { size: 8, weight: 700 })}
    <line x1="22" y1="${n2(y + 4)}" x2="${n2(22 + tw)}" y2="${n2(y + 4)}" stroke="#111" stroke-width="0.8"/>
    ${sc ? text(22, y + 12, sc, { size: 6, fill: '#333' }) : ''}
    ${cl ? text(22, y + 19, cl, { size: 5, fill: '#333' }) : ''}
  </g>`;
}

// A picture placed in a view: a rendered or stored image (data:image/…, blob:), a web address,
// or a path on this app. Anything else (javascript:, a data: page) is left out.
export function safeImageHref(href) {
  const s = String(href || '').trim();
  if (!s) return '';
  if (/^data:image\/(?:png|jpeg|jpg|gif|webp|svg\+xml|avif|bmp)[;,]/i.test(s) || /^blob:/i.test(s)) return s;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return /^https?:/i.test(s) ? s : '';
  return s.startsWith('//') ? '' : s;
}

// images: Map vpId -> { href, aspect } for model renders and photo/document pages.
// opts: { screen (selection frames, ids), selectedId, adjustId, index, count, date }
export function sheetSvg(prop, set, sheet, images, opts = {}) {
  const paper = paperOf(set);
  const W = paper.w * PT, H = paper.h * PT;
  const area = drawingArea(set);
  const parts = [];
  parts.push(`<rect x="0" y="0" width="${n2(W)}" height="${n2(H)}" fill="#fff"/>`);
  parts.push(`<rect x="${n2(area.x * PT)}" y="${n2(area.y * PT)}" width="${n2((paper.w - 2 * MARGIN) * PT)}" height="${n2(area.h * PT)}" fill="none" stroke="#111" stroke-width="1.2"/>`);
  parts.push(titleBlock(prop, set, sheet, paper, opts));
  const all = set.sheets.flatMap(s => s.viewports);
  let overlay = '';
  for (const v of sheet.viewports) {
    const vw = v.w * PT, vh = v.h * PT;
    const img = images.get(v.id);
    const clip = 'vpclip-' + v.id;
    let body = '';
    if (v.kind === 'schedule') body = scheduleSvg(prop, v);
    else if (v.kind === 'text') body = textSvg(v);
    else {
      const href = img && safeImageHref(img.href);
      if (href) body += `<image href="${esc(href)}" x="0" y="0" width="${n2(vw)}" height="${n2(vh)}" preserveAspectRatio="${v.kind === 'image' ? 'xMidYMid meet' : 'none'}"/>`;
      if (v.kind === 'plan') body += planVectorSvg(prop, v) + planMarksSvg(v, all.filter(o => o.kind === 'section'));
      const problem = viewportProblems(prop, v) || (img && img.error) || '';
      if (!img && opts.screen && v.kind !== 'plan') body += text(vw / 2, vh / 2, 'Rendering…', { size: 8, anchor: 'middle', fill: '#999' });
      if (problem) body += text(4, vh - 5, problem, { size: 6, fill: '#a33' });
    }
    const sel = opts.screen && opts.selectedId === v.id;
    const hitRect = (stroke, width, dash) => `<rect class="dc-vp-hit" data-vp="${esc(v.id)}" x="0" y="0" width="${n2(vw)}" height="${n2(vh)}" fill="transparent" stroke="${stroke}" stroke-width="${width}" ${dash ? 'stroke-dasharray="3 3"' : ''}/>`;
    parts.push(`<g data-vp-group="${esc(v.id)}" transform="translate(${n2(v.x * PT)} ${n2(v.y * PT)})">
      <clipPath id="${clip}"><rect x="0" y="0" width="${n2(vw)}" height="${n2(vh)}"/></clipPath>
      <g clip-path="url(#${clip})">${body}</g>${label(v)}${opts.screen && !sel ? hitRect('rgba(0,0,0,0.12)', 0.6, true) : ''}</g>`);
    // The selected view's frame and corner handle go on top of every other view, so a view
    // overlapping it never hides the handle.
    if (sel) overlay = `<g transform="translate(${n2(v.x * PT)} ${n2(v.y * PT)})">${hitRect(opts.adjustId === v.id ? '#1f6feb' : '#e8973a', 1.6, false)}` +
      (opts.adjustId !== v.id ? `<rect class="dc-vp-handle" data-handle="${esc(v.id)}" x="${n2(vw - 5)}" y="${n2(vh - 5)}" width="10" height="10" fill="#e8973a"/>` : '') + '</g>';
  }
  parts.push(overlay);
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${n2(W)} ${n2(H)}" width="${n2(W)}" height="${n2(H)}">${parts.join('')}</svg>`;
}

export { SCHEDULE_SOURCES };
