// DOCUMENTS: drawing sets laid out on sheets, like SketchUp's LayOut beside the model. A set has
// sheets; a sheet has viewports (plans cut at a height, sections, elevations, 3D views, photos or
// document pages, schedules and text) placed on paper at a drawing scale. Model views render from
// the current model whenever it changes, so the sheets stay live. Saved PDFs of a set become
// documents of the property, listed with the rest of its saved documents.

import {
  ws, touch, onChange, activeProperty, escapeHtml as esc, fmtLen, parseLen, isoToday, levelHeight, activeLevel,
  projectSlice,
} from './store.js';
import { icon } from './icons.js';
import { diskWorkspace } from './disk-workspace.js';
import {
  PAPERS, SCALES, STYLES, KINDS, SCHEDULE_SOURCES, ELEVATION_SIDES, paperOf, drawingArea, fitScale, nextScale, scaleLabel,
  newSet, newSheet, newViewport, nextSheetNumber, numberViewports, normalizeViewport, lineFrame, lineThrough, elevationLine,
  pdfFromJpegs, worldSpan,
} from './doc-sets.js';
import { renderViewport, geometrySignature, tagSignature, modelBounds3d, releaseRenderer } from './sheet-render.js';
import { tagShown, UNTAGGED_LABEL, OVERRIDE_UNTAGGED } from './tags.js';
import { sheetSvg } from './sheet-compose.js';
import { modelBounds } from './geometry.js';
import { photoBytes } from './photos-store.js';
import { renderPdfPage, addDocumentFromFile } from './documents.js';
import { lastCameraView } from './viewer3d.js';

const PT = 72;
const EXPORT_DPI = 150;

let el = null, prop = null;
let setId = '', sheetId = '', selectedId = '', adjustId = '';
let viewing = null;               // { kind: 'doc', id, page } | null: a saved document open in the middle
let zoom = 0;                     // px per point; 0 = fit
let offChange = null;
let images = new Map();           // vpId -> { href, key, error }
const cache = new Map();          // render key -> { href } (screen renders)
let queue = Promise.resolve(), queued = new Set();
let redrawTimer = null, status = '';

const curSet = () => (prop?.docSets || []).find(s => s.id === setId) || null;
const curSheet = () => curSet()?.sheets.find(s => s.id === sheetId) || null;
const curVp = () => curSheet()?.viewports.find(v => v.id === selectedId) || null;
const allVps = () => (curSet()?.sheets || []).flatMap(s => s.viewports);

export function mount(root) {
  el = root;
  prop = activeProperty();
  if (!prop) { el.innerHTML = '<div class="empty-state"><b>No property</b>Create or open a property first.</div>'; return; }
  prop.docSets = prop.docSets || [];
  if (!curSet()) { setId = prop.docSets[0]?.id || ''; sheetId = ''; selectedId = ''; }
  if (!curSheet()) sheetId = curSet()?.sheets[0]?.id || '';
  render();
  offChange = onChange(() => {
    if (!el) return;
    clearTimeout(redrawTimer);
    redrawTimer = setTimeout(() => { if (el) { drawSheet(); renderLists(); } }, 120);
  });
  window.addEventListener('keydown', onKey);
}

export function unmount() {
  if (offChange) offChange();
  offChange = null;
  window.removeEventListener('keydown', onKey);
  clearTimeout(redrawTimer);
  el = null; adjustId = '';
  releaseRenderer();
  cache.clear(); images = new Map();
}

// ---------- layout ----------

function render() {
  el.innerHTML = `<div class="dc-layout">
    <aside class="dc-side">
      <div class="dc-side-scroll">
        <section><div class="dc-h"><span class="kicker">DRAWING SETS</span><button class="btn small" data-new-set>${icon('plus', { size: 11 })}NEW SET</button></div><div data-sets></div></section>
        <section data-sheets-box><div class="dc-h"><span class="kicker">SHEETS</span><button class="btn small" data-new-sheet>${icon('plus', { size: 11 })}ADD SHEET</button></div><div data-sheets></div></section>
        <section><div class="dc-h"><span class="kicker">SAVED DOCUMENTS</span><label class="btn small" title="Add a PDF or an image to this property's documents">${icon('upload', { size: 11 })}ADD<input type="file" accept="application/pdf,image/*" data-add-doc hidden></label></div><div data-saved></div></section>
      </div>
    </aside>
    <main class="dc-main">
      <div class="dc-toolbar" data-toolbar></div>
      <div class="dc-stage" data-stage></div>
      <div class="dc-status" data-status role="status"></div>
    </main>
    <aside class="dc-inspector" data-inspector></aside>
  </div>`;
  el.querySelector('[data-new-set]').onclick = () => {
    const s = newSet(prop.name ? prop.name + ' drawings' : 'Drawing set');
    prop.docSets.push(s); setId = s.id; sheetId = s.sheets[0].id; selectedId = ''; viewing = null;
    touch(); render();
  };
  el.querySelector('[data-new-sheet]').onclick = () => addSheet();
  el.querySelector('[data-add-doc]').onchange = async e => {
    const f = e.target.files[0];
    if (!f) return;
    try { const d = await addDocumentFromFile(prop, f); viewing = { kind: 'doc', id: d.id, page: 1 }; render(); }
    catch (err) { setStatus('Could not add ' + f.name + ': ' + err.message); }
  };
  renderLists();
  renderToolbar();
  if (viewing) renderViewer(); else drawSheet(true);
  renderInspector();
}

function renderLists() {
  if (!el) return;
  const sets = prop.docSets;
  el.querySelector('[data-sets]').innerHTML = sets.length ? sets.map(s => `<button class="dc-row ${s.id === setId && !viewing ? 'active' : ''}" data-set="${esc(s.id)}">
      <b>${esc(s.name)}</b><span>${s.sheets.length} sheet${s.sheets.length === 1 ? '' : 's'} · ${esc(paperOf(s).label.split(',')[0])}${s.revisions.length ? ' · rev ' + s.revisions[s.revisions.length - 1].n : ''}</span></button>`).join('')
    : '<p class="dc-empty">No drawing sets yet. NEW SET starts one with a plan sheet.</p>';
  el.querySelectorAll('[data-set]').forEach(b => b.onclick = () => {
    setId = b.dataset.set; sheetId = curSet().sheets[0]?.id || ''; selectedId = ''; adjustId = ''; viewing = null; render();
  });
  const set = curSet();
  el.querySelector('[data-sheets-box]').hidden = !set;
  if (set) {
    el.querySelector('[data-sheets]').innerHTML = set.sheets.map((sh, i) => `<div class="dc-sheet-row ${sh.id === sheetId && !viewing ? 'active' : ''}">
        <button class="dc-row" data-sheet="${esc(sh.id)}"><b>${esc(sh.number)}</b><span>${esc(sh.title)} · ${sh.viewports.length} view${sh.viewports.length === 1 ? '' : 's'}</span></button>
        <span class="dc-row-tools">
          <button class="icon-btn" data-sheet-up="${i}" title="Move up" ${i ? '' : 'disabled'}>▲</button>
          <button class="icon-btn" data-sheet-down="${i}" title="Move down" ${i < set.sheets.length - 1 ? '' : 'disabled'}>▼</button>
        </span></div>`).join('') || '<p class="dc-empty">No sheets.</p>';
    el.querySelectorAll('[data-sheet]').forEach(b => b.onclick = () => { sheetId = b.dataset.sheet; selectedId = ''; adjustId = ''; viewing = null; render(); });
    const move = (i, d) => { const a = set.sheets; [a[i], a[i + d]] = [a[i + d], a[i]]; numberViewports(set); touch(); renderLists(); drawSheet(); };
    el.querySelectorAll('[data-sheet-up]').forEach(b => b.onclick = () => move(+b.dataset.sheetUp, -1));
    el.querySelectorAll('[data-sheet-down]').forEach(b => b.onclick = () => move(+b.dataset.sheetDown, 1));
  }
  // Saved documents: this property's documents (newest first), then product spec documents
  // kept in its project folder.
  const docs = (prop.photos || []).filter(p => p.kind === 'document').slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const productDocs = projectSlice(prop.id).products.flatMap(p => (p.documents || []).map((d, i) => ({ p, d, i })));
  const ready = !!(diskWorkspace && diskWorkspace.paths && diskWorkspace.paths[prop.id]);
  el.querySelector('[data-saved]').innerHTML = (docs.length ? docs.map(d => `<button class="dc-row dc-doc ${viewing && viewing.id === d.id ? 'active' : ''}" data-doc="${esc(d.id)}">
        ${d.thumb ? `<img src="${esc(d.thumb)}" alt="">` : `<span class="dc-doc-ic">${icon('file')}</span>`}
        <span><b>${esc(d.name)}</b><span>${d.pageCount > 1 ? d.pageCount + ' pages · ' : ''}${esc(String(d.createdAt || '').slice(0, 10))}</span></span></button>`).join('') : '<p class="dc-empty">No saved documents. Saved drawing sets, uploaded PDFs and drawings appear here.</p>')
    + (productDocs.length ? `<div class="dc-subh">PRODUCT DOCUMENTS (PROJECT FOLDER)</div>` + productDocs.map(({ p, d, i }) => `<button class="dc-row dc-pdoc" data-pdoc="${esc(p.id)}:${i}" ${ready ? '' : 'disabled title="Link this property\'s project folder to open its files"'}>
        <b>${esc(d.title || d.path)}</b><span>${esc(p.name)} · ${esc(d.kind || 'file')}</span></button>`).join('') : '');
  el.querySelectorAll('[data-doc]').forEach(b => b.onclick = () => { viewing = { kind: 'doc', id: b.dataset.doc, page: 1 }; selectedId = ''; adjustId = ''; render(); });
  el.querySelectorAll('[data-pdoc]').forEach(b => b.onclick = async () => {
    const [pid, i] = b.dataset.pdoc.split(':');
    const p = ws.data.products.find(x => x.id === pid);
    try { const r = await diskWorkspace.openProjectPath(prop, p.documents[+i].path); setStatus('Opened ' + (r.path || p.documents[+i].path) + ' on this Mac.'); }
    catch (e) { setStatus(e.message || 'Could not open the file.'); }
  });
}

function renderToolbar() {
  const bar = el.querySelector('[data-toolbar]');
  const set = curSet();
  if (viewing) {
    bar.innerHTML = `<button class="btn small" data-back>◀ BACK TO SHEETS</button><span class="dc-sp"></span>
      <button class="btn small" data-place ${curSheet() ? '' : 'disabled title="Open a drawing set first"'}>PLACE ON SHEET</button>
      <button class="btn small" data-download-doc>DOWNLOAD</button>`;
    bar.querySelector('[data-back]').onclick = () => { viewing = null; render(); };
    bar.querySelector('[data-place]').onclick = () => { const id = viewing.id, page = viewing.page; viewing = null; addViewport('image', { photoId: id, page }); render(); };
    bar.querySelector('[data-download-doc]').onclick = downloadDoc;
    return;
  }
  if (!set) { bar.innerHTML = '<span class="dc-hint">Start a drawing set with NEW SET, or open a saved document.</span>'; return; }
  const add = Object.entries({ plan: 'PLAN', section: 'SECTION', elevation: 'ELEVATION', view3d: '3D VIEW', image: 'PHOTO OR PAGE', schedule: 'SCHEDULE', text: 'TEXT' })
    .map(([k, l]) => `<button class="btn small" data-add="${k}" title="Add a ${esc(KINDS[k].toLowerCase())} to this sheet">${l}</button>`).join('');
  bar.innerHTML = `<span class="dc-add-label">ADD</span>${add}<span class="dc-sp"></span>
    <button class="btn small" data-zoom="-1" title="Zoom out">−</button><button class="btn small" data-zoom="0" title="Fit the sheet">FIT</button><button class="btn small" data-zoom="1" title="Zoom in">+</button>
    <button class="btn small" data-refresh title="Render every view on this sheet again">REFRESH</button>
    <button class="btn small" data-pdf title="Download this set as a PDF">DOWNLOAD PDF</button>
    <button class="btn small primary" data-save title="Save this set as a PDF in the property's documents, as the next revision">SAVE PDF TO PROJECT</button>`;
  bar.querySelectorAll('[data-add]').forEach(b => b.onclick = () => addViewport(b.dataset.add));
  bar.querySelectorAll('[data-zoom]').forEach(b => b.onclick = () => {
    const d = +b.dataset.zoom;
    zoom = d === 0 ? 0 : (zoom || fitZoom()) * (d > 0 ? 1.25 : 0.8);
    drawSheet(true);
  });
  bar.querySelector('[data-refresh]').onclick = () => { cache.clear(); images = new Map(); drawSheet(true); };
  bar.querySelector('[data-pdf]').onclick = () => exportPdf(false);
  bar.querySelector('[data-save]').onclick = () => exportPdf(true);
}

function setStatus(t) { status = t; const s = el?.querySelector('[data-status]'); if (s) s.textContent = t; }

// ---------- sets, sheets and viewports ----------

function addSheet() {
  const set = curSet();
  if (!set) return;
  const sh = newSheet(nextSheetNumber(set.sheets), 'Sheet ' + (set.sheets.length + 1));
  set.sheets.push(sh); sheetId = sh.id; selectedId = ''; viewing = null;
  touch(); render();
}

// Plan bounds of what is drawn: the traced plan, or the models when nothing is traced.
async function planBox() {
  const traced = (prop.walls || []).length || (prop.rooms || []).length;
  if (traced) return modelBounds(prop);
  const b = await modelBounds3d(prop);
  if (!isFinite(b.min.x)) return { minX: -5, minY: -5, maxX: 5, maxY: 5 };
  return { minX: b.min.x, minY: b.min.z, maxX: b.max.x, maxY: b.max.z };
}

// A free spot for a new viewport: half the drawing area, stepping down and across.
function freeBox(kind) {
  const set = curSet(), area = drawingArea(set);
  const n = curSheet().viewports.length;
  const w = kind === 'text' ? 3 : kind === 'schedule' ? Math.min(6, area.w - 0.6) : Math.min(area.w / 2 - 0.4, 7);
  const h = kind === 'text' ? 2 : kind === 'schedule' ? 2.5 : Math.min(area.h / 2 - 0.6, 4.5);
  const col = n % 2, row = Math.floor(n / 2) % 2;
  return { x: area.x + 0.3 + col * (area.w / 2), y: area.y + 0.3 + row * (area.h / 2), w, h };
}

async function addViewport(kind, extra = {}) {
  const sheet = curSheet();
  if (!sheet) return;
  const box = freeBox(kind);
  const b = ['plan', 'section', 'elevation', 'view3d'].includes(kind) ? await planBox() : null;
  const lvl = activeLevel(prop) || prop.levels[0];
  let v;
  if (kind === 'plan') {
    const scale = fitScale(b.maxX - b.minX + 1.5, b.maxY - b.minY + 1.5, box.w, box.h);
    v = newViewport('plan', box, { title: (lvl?.name || 'Floor') + ' plan', levelId: lvl?.id || '', cut: 1.2, center: [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2], scale });
  } else if (kind === 'section' || kind === 'elevation') {
    const line = kind === 'section' ? lineThrough(b, 'x') : elevationLine(b, 'bottom');
    const top = Math.max(...prop.levels.map(l => l.elevation + levelHeight(prop, l.id)));
    const low = Math.min(...prop.levels.map(l => l.elevation));
    const L = Math.hypot(line[2] - line[0], line[3] - line[1]);
    const scale = fitScale(L, top - low + 1, box.w, box.h);
    const n = allVps().filter(x => x.kind === kind).length + 1;
    v = newViewport(kind, box, { title: kind === 'section' ? 'Section ' + n : 'Elevation, ' + ELEVATION_SIDES.bottom.toLowerCase(), line, center: [0, (top + low) / 2], scale, side: 'bottom' });
  } else if (kind === 'view3d') {
    const from = lastCameraView(prop.id);
    let camera;
    if (from) camera = { position: from.position, target: from.target, fov: from.fov };
    else {
      const cx = (b.minX + b.maxX) / 2, cz = (b.minY + b.maxY) / 2, r = Math.max(b.maxX - b.minX, b.maxY - b.minY, 3);
      camera = { position: [cx + r * 0.9, r * 0.8, cz + r * 1.1], target: [cx, 1, cz], fov: 45 };
    }
    v = newViewport('view3d', box, { title: '3D view', camera, style: 'shaded-lines' });
  } else if (kind === 'image') {
    const first = (prop.photos || []).find(p => p.kind === 'document') || (prop.photos || [])[0];
    const id = extra.photoId || first?.id || '';
    const ph = (prop.photos || []).find(p => p.id === id);
    v = newViewport('image', box, { title: ph ? ph.name.replace(/\.[a-z0-9]+$/i, '') : 'Photo', photoId: id, page: extra.page || 1, ...extra });
  } else if (kind === 'schedule') {
    v = newViewport('schedule', box, { title: SCHEDULE_SOURCES.openings, source: 'openings' });
  } else {
    v = newViewport('text', box, { title: 'Notes', text: 'GENERAL NOTES\n1. Field-verify every dimension before ordering or cutting.\n2. ' });
  }
  sheet.viewports.push(v);
  numberViewports(curSet());
  selectedId = v.id; adjustId = '';
  touch(); drawSheet(); renderInspector(); renderLists();
}

// ---------- the sheet on screen ----------

function fitZoom() {
  const stage = el.querySelector('[data-stage]');
  const p = paperOf(curSet());
  return Math.max(0.2, Math.min((stage.clientWidth - 48) / (p.w * PT), (stage.clientHeight - 48) / (p.h * PT)));
}

// Model renders this sheet needs, in screen pixels, keyed by what they depend on.
function renderKey(v, px, py) {
  const base = { kind: v.kind, w: v.w, h: v.h, style: v.style, px, py };
  if (v.kind === 'image') return JSON.stringify({ ...base, photoId: v.photoId, page: v.page });
  const geo = geometrySignature(prop);
  const params = v.kind === 'plan' ? { levelId: v.levelId, cut: v.cut, center: v.center, scale: v.scale, model: v.layers.model }
    : v.kind === 'view3d' ? { camera: v.camera } : { line: v.line, flip: v.flip, center: v.center, scale: v.scale, clip: v.clip, depth: v.depth };
  const tags = tagSignature(prop, v);
  return geo.length + ':' + hash(geo) + ':' + hash(tags) + JSON.stringify({ ...base, ...params });
}
function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }

function drawSheet(refit) {
  if (!el || viewing) return;
  const stage = el.querySelector('[data-stage]');
  const set = curSet(), sheet = curSheet();
  if (!set || !sheet) { stage.innerHTML = `<div class="dc-blank">${set ? 'Add a sheet to this set.' : 'No drawing set open.'}</div>`; return; }
  const z = zoom || fitZoom();
  const p = paperOf(set);
  const dpr = window.devicePixelRatio || 1;
  for (const v of sheet.viewports) {
    if (v.kind === 'schedule' || v.kind === 'text') continue;
    const px = Math.min(2400, Math.round(v.w * PT * z * dpr)), py = Math.min(2400, Math.round(v.h * PT * z * dpr));
    const key = renderKey(v, px, py);
    const hit = cache.get(key);
    if (hit) images.set(v.id, { ...hit, key });
    else enqueue(v, key, px, py);
  }
  const svg = sheetSvg(prop, set, sheet, images, { screen: true, selectedId, adjustId, index: set.sheets.indexOf(sheet), count: set.sheets.length,
    date: set.revisions.length ? set.revisions[set.revisions.length - 1].date : isoToday() });
  const keepScroll = stage.querySelector('.dc-paper') ? [stage.scrollLeft, stage.scrollTop] : null;
  stage.innerHTML = `<div class="dc-paper" style="width:${Math.round(p.w * PT * z)}px;height:${Math.round(p.h * PT * z)}px">${svg}</div>`;
  const svgEl = stage.querySelector('svg');
  svgEl.setAttribute('width', '100%'); svgEl.setAttribute('height', '100%');
  if (keepScroll && !refit) { stage.scrollLeft = keepScroll[0]; stage.scrollTop = keepScroll[1]; }
  bindSheet(svgEl);
  setStatus(status);
}

function enqueue(v, key, px, py) {
  if (queued.has(key)) return;
  queued.add(key);
  const id = v.id;
  queue = queue.then(async () => {
    if (!el) return;
    const cur = allVps().find(x => x.id === id);
    if (!cur || renderKey(cur, px, py) !== key) return;   // changed or gone since it was queued
    try {
      const href = await imageHref(cur, px, py);
      cache.set(key, { href });
      while (cache.size > 80) cache.delete(cache.keys().next().value);
      if (el) { images.set(id, { href, key }); scheduleRedraw(); }
    } catch (e) {
      console.error('drawing view failed', e);
      images.set(id, { href: '', key, error: 'This view could not be rendered: ' + (e.message || e) });
      scheduleRedraw();
    }
  }).finally(() => queued.delete(key));
}

let redrawRaf = 0;
function scheduleRedraw() { if (!redrawRaf) redrawRaf = requestAnimationFrame(() => { redrawRaf = 0; drawSheet(); }); }

// A data URL for one viewport's picture at px x py: a model render, a photo, or a document page.
async function imageHref(v, px, py, type = 'image/png') {
  if (v.kind === 'image') {
    const ph = (prop.photos || []).find(p => p.id === v.photoId);
    if (!ph) return '';
    if (ph.mime === 'application/pdf') {
      const r = await renderPdfPage(ph.id, v.page, Math.max(px, py));
      return r.canvas.toDataURL('image/jpeg', 0.9);
    }
    const buf = await photoBytes(ph.id);
    if (!buf) return ph.thumb || '';
    const bmp = await createImageBitmap(new Blob([buf], { type: ph.mime || 'image/jpeg' }), { imageOrientation: 'from-image' });
    const s = Math.min(1, Math.max(px / bmp.width, py / bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * s)); c.height = Math.max(1, Math.round(bmp.height * s));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close && bmp.close();
    return c.toDataURL('image/jpeg', 0.9);
  }
  const canvas = await renderViewport(prop, v, px, py);
  return canvas ? canvas.toDataURL(type, 0.92) : '';
}

// ---------- pointer: select, move, resize, adjust ----------

function bindSheet(svg) {
  // The sheet is redrawn while dragging (selecting a view redraws it too), so always measure
  // against the drawing that is on screen now.
  const toPaper = e => {
    const live = el?.querySelector('.dc-paper svg') || svg;
    const m = live.getScreenCTM().inverse();
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m);
    return [p.x / PT, p.y / PT];
  };
  const snap = x => Math.round(x * 8) / 8;
  svg.addEventListener('pointerdown', e => {
    const handle = e.target.closest('[data-handle]');
    const hit = e.target.closest('[data-vp]');
    if (!hit && !handle) {
      if (selectedId || adjustId) { selectedId = ''; adjustId = ''; drawSheet(); renderInspector(); }
      return;
    }
    const id = (handle || hit).dataset.handle || (handle || hit).dataset.vp;
    const v = curSheet().viewports.find(x => x.id === id);
    if (!v) return;
    if (selectedId !== id) { selectedId = id; adjustId = ''; drawSheet(); renderInspector(); }
    const start = toPaper(e), orig = { x: v.x, y: v.y, w: v.w, h: v.h, center: v.center && [...v.center], camera: v.camera && JSON.parse(JSON.stringify(v.camera)) };
    const mode = handle ? 'resize' : adjustId === id ? 'adjust' : 'move';
    let moved = false;
    e.preventDefault();
    const move = ev => {
      const [x, y] = toPaper(ev);
      const dx = x - start[0], dy = y - start[1];
      if (!moved && Math.hypot(dx, dy) < 0.03) return;
      moved = true;
      if (mode === 'move') { v.x = snap(orig.x + dx); v.y = snap(orig.y + dy); }
      else if (mode === 'resize') { v.w = Math.max(0.5, snap(orig.w + dx)); v.h = Math.max(0.5, snap(orig.h + dy)); }
      else adjustDrag(v, orig, dx, dy, ev.shiftKey);
      drawSheet();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (moved) { touch(); renderInspector(); }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  svg.addEventListener('dblclick', e => {
    const hit = e.target.closest('[data-vp]');
    if (!hit) return;
    const v = curSheet().viewports.find(x => x.id === hit.dataset.vp);
    if (!v || !['plan', 'section', 'elevation', 'view3d'].includes(v.kind)) return;
    selectedId = v.id; adjustId = adjustId === v.id ? '' : v.id;
    setStatus(adjustId ? (v.kind === 'view3d' ? 'Adjusting the camera: drag to orbit, Shift-drag to pan, scroll to move in. Esc or double-click to finish.' : 'Adjusting the view: drag to pan, scroll to change the scale. Esc or double-click to finish.') : '');
    drawSheet(); renderInspector();
  });
  svg.addEventListener('wheel', e => {
    const v = curVp();
    if (!v || adjustId !== v.id) return;
    e.preventDefault();
    if (v.kind === 'view3d') {
      const c = v.camera, f = e.deltaY > 0 ? 1.12 : 1 / 1.12;
      c.position = c.target.map((t, i) => t + (c.position[i] - t) * f);
    } else v.scale = nextScale(v.scale, e.deltaY > 0 ? 1 : -1);
    drawSheet(); touchSoon(); renderInspector();
  }, { passive: false });
}

let touchTimer = null;
function touchSoon() { clearTimeout(touchTimer); touchTimer = setTimeout(touch, 300); }

// Dragging inside a viewport being adjusted: pan an orthographic view, orbit (or pan) a camera.
function adjustDrag(v, orig, dx, dy, shift) {
  if (v.kind === 'view3d') {
    const c = v.camera, o = orig.camera;
    const off = o.position.map((p, i) => p - o.target[i]);
    const r = Math.hypot(...off);
    if (shift) {
      // Pan in the view plane, a paper inch moving the camera about a tenth of its distance.
      const yaw = Math.atan2(off[0], off[2]);
      const rx = Math.cos(yaw), rz = -Math.sin(yaw);
      const k = r * 0.25;
      const move = [-dx * k * rx, dy * k, -dx * k * rz];
      c.target = o.target.map((t, i) => t + move[i]);
      c.position = o.position.map((p, i) => p + move[i]);
      return;
    }
    let yaw = Math.atan2(off[0], off[2]) - dx * 0.9;
    let pitch = Math.asin(Math.max(-1, Math.min(1, off[1] / r))) + dy * 0.6;
    pitch = Math.max(-1.45, Math.min(1.45, pitch));
    c.position = [o.target[0] + r * Math.cos(pitch) * Math.sin(yaw), o.target[1] + r * Math.sin(pitch), o.target[2] + r * Math.cos(pitch) * Math.cos(yaw)];
    c.target = [...o.target];
    return;
  }
  const mPerIn = worldSpan(1, v.scale);
  if (v.kind === 'plan') { v.center = [orig.center[0] - dx * mPerIn, orig.center[1] - dy * mPerIn]; return; }
  // Section or elevation: screen right is the look direction crossed with up, (-n.y, n.x) in plan.
  const f = lineFrame(v);
  const rightAlongU = -f.ny * f.ux + f.nx * f.uy;
  v.center = [orig.center[0] - dx * mPerIn * rightAlongU, orig.center[1] + dy * mPerIn];
}

function onKey(e) {
  if (!el || /input|textarea|select/i.test(document.activeElement?.tagName || '')) return;
  if (e.key === 'Escape' && adjustId) { adjustId = ''; setStatus(''); drawSheet(); renderInspector(); }
  else if ((e.key === 'Delete' || e.key === 'Backspace') && curVp() && !adjustId) { e.preventDefault(); deleteViewport(); }
}

function deleteViewport() {
  const sheet = curSheet(), v = curVp();
  if (!v || !confirm('Remove "' + v.title + '" from this sheet?')) return;
  sheet.viewports = sheet.viewports.filter(x => x !== v);
  numberViewports(curSet());
  selectedId = ''; adjustId = '';
  touch(); drawSheet(); renderInspector(); renderLists();
}

// ---------- inspector ----------

const opt = (val, label, cur) => `<option value="${esc(String(val))}" ${String(val) === String(cur) ? 'selected' : ''}>${esc(label)}</option>`;
const field = (label, html, hint = '') => `<div class="field"><label>${esc(label)}${hint ? ` <span class="faint">${esc(hint)}</span>` : ''}</label>${html}</div>`;

function renderInspector() {
  const host = el?.querySelector('[data-inspector]');
  if (!host) return;
  const set = curSet(), sheet = curSheet(), v = curVp();
  if (viewing) { host.innerHTML = docInspector(); bindDocInspector(host); return; }
  if (!set) { host.innerHTML = `<div class="dc-insp-empty"><b>Documents</b><p>A drawing set is a stack of sheets. Each sheet holds views of the model at a drawing scale (plans, sections, elevations and 3D views), plus photos, document pages, schedules and notes.</p><p>The views stay live: change the model and they redraw. SAVE PDF TO PROJECT keeps a dated copy as the next revision.</p></div>`; return; }
  if (v) { host.innerHTML = vpInspector(v); bindVpInspector(host, v); return; }
  host.innerHTML = `<h3 class="kicker">SHEET</h3>
    ${field('Number', `<input type="text" data-sheet-f="number" value="${esc(sheet ? sheet.number : '')}">`)}
    ${field('Title', `<input type="text" data-sheet-f="title" value="${esc(sheet ? sheet.title : '')}">`)}
    ${sheet ? `<button class="btn small" data-del-sheet ${set.sheets.length > 1 ? '' : 'disabled title="A set keeps at least one sheet"'}>DELETE SHEET</button>` : ''}
    <h3 class="kicker" style="margin-top:18px">DRAWING SET</h3>
    ${field('Name', `<input type="text" data-set-f="name" value="${esc(set.name)}">`)}
    <div class="field-row">${field('Paper', `<select data-set-f="paper">${PAPERS.map(p => opt(p.id, p.label, set.paper)).join('')}</select>`)}
    ${field('Orientation', `<select data-set-f="orientation">${opt('landscape', 'Landscape', set.orientation)}${opt('portrait', 'Portrait', set.orientation)}</select>`)}</div>
    ${field('Client', `<input type="text" data-tb="client" value="${esc(set.titleBlock.client)}">`)}
    ${field('Drawn by', `<input type="text" data-tb="drawnBy" value="${esc(set.titleBlock.drawnBy)}">`)}
    ${field('Title block notes', `<textarea data-tb="notes" rows="3">${esc(set.titleBlock.notes)}</textarea>`)}
    <h3 class="kicker" style="margin-top:18px">REVISIONS</h3>
    ${set.revisions.length ? `<ul class="dc-revs">${set.revisions.slice().reverse().map(r => `<li><b>${r.n}</b> ${esc(r.date)} ${esc(r.note)} ${(prop.photos || []).some(p => p.id === r.documentId) ? `<button class="link-btn" data-open-rev="${esc(r.documentId)}">open</button>` : '<span class="faint">(PDF removed)</span>'}</li>`).join('')}</ul>` : '<p class="faint">None yet. SAVE PDF TO PROJECT saves revision 1.</p>'}
    <button class="btn small" data-del-set style="margin-top:14px">DELETE SET</button>`;
  host.querySelectorAll('[data-sheet-f]').forEach(i => i.onchange = () => { sheet[i.dataset.sheetF] = i.value.trim() || sheet[i.dataset.sheetF]; touch(); renderLists(); drawSheet(); });
  host.querySelectorAll('[data-set-f]').forEach(i => i.onchange = () => { set[i.dataset.setF] = i.value; touch(); renderLists(); zoom = 0; drawSheet(true); });
  host.querySelectorAll('[data-tb]').forEach(i => i.onchange = () => { set.titleBlock[i.dataset.tb] = i.value; touch(); drawSheet(); });
  host.querySelectorAll('[data-open-rev]').forEach(b => b.onclick = () => { viewing = { kind: 'doc', id: b.dataset.openRev, page: 1 }; render(); });
  host.querySelector('[data-del-sheet]')?.addEventListener('click', () => {
    if (!confirm('Delete sheet ' + sheet.number + ' and its views?')) return;
    set.sheets = set.sheets.filter(s => s !== sheet); numberViewports(set);
    sheetId = set.sheets[0]?.id || ''; touch(); render();
  });
  host.querySelector('[data-del-set]').onclick = () => {
    if (!confirm('Delete the drawing set "' + set.name + '"? Saved PDFs of it stay in SAVED DOCUMENTS.')) return;
    prop.docSets = prop.docSets.filter(s => s !== set); setId = prop.docSets[0]?.id || ''; sheetId = curSet()?.sheets[0]?.id || '';
    touch(); render();
  };
}

function vpInspector(v) {
  const levels = prop.levels || [];
  const scaleSel = `<select data-f="scale">${SCALES.map(s => opt(s.ratio, s.label, v.scale)).join('')}${SCALES.some(s => s.ratio === v.scale) ? '' : opt(v.scale, scaleLabel(v.scale), v.scale)}</select>`;
  const styleSel = `<select data-f="style">${STYLES.map(s => opt(s.id, s.label, v.style)).join('')}</select>`;
  let kind = '';
  if (v.kind === 'plan') {
    kind = `${field('Level', `<select data-f="levelId">${levels.map(l => opt(l.id, l.name, v.levelId || levels[0]?.id)).join('')}</select>`)}
      <div class="field-row">${field('Cut height', `<input type="text" data-len="cut" value="${esc(fmtLen(v.cut))}">`, 'above the floor')}${field('Scale', scaleSel)}</div>
      ${field('Model style', styleSel)}
      <div class="dc-checks"><label><input type="checkbox" data-layer="model" ${v.layers.model ? 'checked' : ''}> Model</label>
      <label><input type="checkbox" data-layer="dims" ${v.layers.dims ? 'checked' : ''}> Wall dimensions</label>
      <label><input type="checkbox" data-layer="rooms" ${v.layers.rooms ? 'checked' : ''}> Room names and areas</label></div>
      <button class="btn small" data-fit>FIT TO PLAN</button>`;
  } else if (v.kind === 'section' || v.kind === 'elevation') {
    const walls = (prop.walls || []);
    kind = `<div class="field-row">${field('Scale', scaleSel)}${field('Style', styleSel)}</div>
      ${v.kind === 'elevation' ? field('Side', `<select data-side>${Object.entries(ELEVATION_SIDES).map(([k, l]) => opt(k, l, v.side || '')).join('')}</select>`)
        : field('Cut line', `<select data-preset><option value="">Choose a line…</option>${opt('x', 'Across the plan, left to right', '')}${opt('y', 'Across the plan, top to bottom', '')}${walls.length ? `<optgroup label="Interior elevation of a wall">${walls.map((w, i) => opt('wall:' + w.id, 'Wall ' + (i + 1) + ' (' + fmtLen(Math.hypot(w.bx - w.ax, w.by - w.ay)) + ')', '')).join('')}</optgroup>` : ''}</select>`)}
      <button class="btn small" data-flip>LOOK THE OTHER WAY</button>
      ${v.kind === 'section' ? field('Show beyond the cut', `<input type="text" data-len="depth" value="${v.depth ? esc(fmtLen(v.depth)) : ''}" placeholder="everything">`, 'blank shows everything') : ''}
      <p class="faint dc-line">Line from (${fmtLen(v.line[0])}, ${fmtLen(v.line[1])}) to (${fmtLen(v.line[2])}, ${fmtLen(v.line[3])}) in plan. Its marks show on plans in this set.</p>
      <button class="btn small" data-fit>FIT</button>`;
  } else if (v.kind === 'view3d') {
    const positions = prop.photoPositions || [];
    kind = `${field('Style', styleSel)}
      ${field('Lens', `<input type="range" min="15" max="90" step="1" data-fov value="${v.camera.fov}"> <span class="faint">${Math.round(v.camera.fov)}°</span>`)}
      <div class="dc-btn-grid">
        <button class="btn small" data-cam="last" ${lastCameraView(prop.id) ? '' : 'disabled title="Open MODEL, frame a view, then come back"'}>USE THE 3D VIEW'S CAMERA</button>
        ${['ne', 'nw', 'se', 'sw'].map(k => `<button class="btn small" data-cam="${k}">FROM ${k.toUpperCase()} CORNER</button>`).join('')}
      </div>
      ${positions.length ? field('Photo position', `<select data-pos><option value="">Choose…</option>${positions.filter(p => p.view).map(p => opt(p.id, '#' + p.number + ' ' + (p.name || ''), '')).join('')}</select>`) : ''}
      <p class="faint">Double-click the view on the sheet to orbit it with the mouse.</p>`;
  } else if (v.kind === 'image') {
    const items = (prop.photos || []);
    const ph = items.find(p => p.id === v.photoId);
    kind = `${field('Photo or document', `<select data-f="photoId">${items.map(p => opt(p.id, (p.kind === 'document' ? 'Document: ' : 'Photo: ') + p.name, v.photoId)).join('')}</select>`)}
      ${ph && ph.pageCount > 1 ? field('Page', `<input type="number" min="1" max="${ph.pageCount}" data-num="page" value="${v.page}">`, 'of ' + ph.pageCount) : ''}`;
  } else if (v.kind === 'schedule') {
    const projects = ws.data.projects.filter(p => p.propertyId === prop.id);
    kind = `${field('List', `<select data-f="source">${Object.entries(SCHEDULE_SOURCES).map(([k, l]) => opt(k, l, v.source)).join('')}</select>`)}
      ${v.source === 'items' ? field('Project', `<select data-f="projectId"><option value="">Choose…</option>${projects.map(p => opt(p.id, (p.parentId ? '· ' : '') + p.name, v.projectId)).join('')}</select>`) : ''}
      ${v.source === 'openings' || v.source === 'rooms' ? field('Level', `<select data-f="levelId">${opt('', 'All levels', v.levelId)}${levels.map(l => opt(l.id, l.name, v.levelId)).join('')}</select>`) : ''}`;
  } else if (v.kind === 'text') {
    kind = `${field('Text', `<textarea data-f="text" rows="9">${esc(v.text)}</textarea>`)}
      ${field('Size', `<input type="number" min="5" max="72" step="0.5" data-num="fontSize" value="${v.fontSize}">`, 'points')}`;
  }
  return `<h3 class="kicker">${esc(KINDS[v.kind].toUpperCase())}${v.number ? ' ' + v.number : ''}</h3>
    ${adjustId === v.id ? '<p class="dc-adjusting">Adjusting on the sheet. Esc to finish.</p>' : ''}
    ${field('Title', `<input type="text" data-f="title" value="${esc(v.title)}">`)}
    <label class="dc-check"><input type="checkbox" data-bool="showTitle" ${v.showTitle ? 'checked' : ''}> Drawing label under the view</label>
    ${kind}
    ${v.tags ? vpTagsHtml(v) : ''}
    <h3 class="kicker" style="margin-top:16px">ON THE SHEET <span class="faint">inches</span></h3>
    <div class="field-row4">${['x', 'y', 'w', 'h'].map(k => field(k.toUpperCase(), `<input type="number" step="0.125" data-num="${k}" value="${v[k]}">`)).join('')}</div>
    <div class="dc-btn-row"><button class="btn small" data-dup>DUPLICATE</button><button class="btn small" data-del>REMOVE</button></div>`;
}

// This view's tags, as in a LayOut scene: each follows the model (MODEL's TAGS) unless set here.
function vpTagsHtml(v) {
  const rows = [...(prop.tags || []).map(t => [t.id, t.name, tagShown(prop, t.id)]), [OVERRIDE_UNTAGGED, UNTAGGED_LABEL, prop.tagUntaggedVisible !== false]];
  const cur = id => typeof v.tags[id] === 'boolean' ? (v.tags[id] ? 'show' : 'hide') : '';
  return `<h3 class="kicker" style="margin-top:16px">TAGS <span class="faint">this view</span></h3>
    <div class="dc-tags">${rows.map(([id, name, shown]) => `<label class="dc-tag-row"><span title="${esc(name)}">${esc(name)}</span><select data-vtag="${esc(id)}">${opt('', 'As the model (' + (shown ? 'shown' : 'hidden') + ')', cur(id))}${opt('show', 'Shown', cur(id))}${opt('hide', 'Hidden', cur(id))}</select></label>`).join('')}</div>
    ${Object.keys(v.tags).length ? '<button class="btn small" data-vtag-reset>FOLLOW THE MODEL FOR EVERY TAG</button>' : ''}`;
}

function bindVpInspector(host, v) {
  const changed = (rerenderInspector = false) => { touch(); drawSheet(); if (rerenderInspector) renderInspector(); };
  host.querySelectorAll('[data-vtag]').forEach(i => i.onchange = () => {
    const id = i.dataset.vtag;
    if (i.value) v.tags[id] = i.value === 'show'; else delete v.tags[id];
    changed(true);
  });
  host.querySelector('[data-vtag-reset]')?.addEventListener('click', () => { v.tags = {}; changed(true); });
  host.querySelectorAll('[data-f]').forEach(i => i.onchange = () => {
    const k = i.dataset.f;
    v[k] = k === 'scale' ? Number(i.value) : i.value;
    if (k === 'source') v.title = SCHEDULE_SOURCES[v.source];
    if (k === 'photoId') { v.page = 1; const ph = prop.photos.find(p => p.id === v.photoId); if (ph) v.title = ph.name.replace(/\.[a-z0-9]+$/i, ''); }
    if (k === 'title') renderLists();
    changed(['source', 'photoId', 'scale'].includes(k));
  });
  host.querySelectorAll('[data-num]').forEach(i => i.onchange = () => { const n = Number(i.value); if (Number.isFinite(n)) { v[i.dataset.num] = n; Object.assign(v, normalizeViewport(v)); changed(); } });
  host.querySelectorAll('[data-bool]').forEach(i => i.onchange = () => { v[i.dataset.bool] = i.checked; numberViewports(curSet()); changed(); });
  host.querySelectorAll('[data-len]').forEach(i => i.onchange = () => {
    const k = i.dataset.len;
    if (k === 'depth' && !i.value.trim()) { v.depth = 0; changed(true); return; }
    const m = parseLen(i.value);
    if (Number.isFinite(m) && m > 0) { v[k] = m; changed(true); } else i.value = v[k] ? fmtLen(v[k]) : '';
  });
  host.querySelectorAll('[data-layer]').forEach(i => i.onchange = () => { v.layers[i.dataset.layer] = i.checked; changed(); });
  host.querySelector('[data-fit]')?.addEventListener('click', async () => {
    const b = await planBox();
    if (v.kind === 'plan') { v.center = [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2]; v.scale = fitScale(b.maxX - b.minX + 1.5, b.maxY - b.minY + 1.5, v.w, v.h); }
    else {
      const f = lineFrame(v);
      const top = Math.max(...prop.levels.map(l => l.elevation + levelHeight(prop, l.id))), low = Math.min(...prop.levels.map(l => l.elevation));
      const along = [[b.minX, b.minY], [b.maxX, b.minY], [b.minX, b.maxY], [b.maxX, b.maxY]].map(([x, y]) => (x - f.mx) * f.ux + (y - f.my) * f.uy);
      const lo = Math.min(...along), hi = Math.max(...along);
      v.center = [(lo + hi) / 2, (top + low) / 2];
      v.scale = fitScale(hi - lo + 1, top - low + 1, v.w, v.h);
    }
    changed(true);
  });
  host.querySelector('[data-flip]')?.addEventListener('click', () => { v.flip = !v.flip; changed(true); });
  host.querySelector('[data-side]')?.addEventListener('change', async e => {
    const b = await planBox(); v.side = e.target.value; v.line = elevationLine(b, v.side); v.flip = false; v.center = [0, v.center[1]];
    v.title = 'Elevation, ' + ELEVATION_SIDES[v.side].toLowerCase(); changed(true);
  });
  host.querySelector('[data-preset]')?.addEventListener('change', async e => {
    const val = e.target.value;
    if (!val) return;
    if (val.startsWith('wall:')) {
      // Interior elevation: a cut a little in front of the wall's positive face, looking at it.
      const w = prop.walls.find(x => x.id === val.slice(5));
      const L = Math.hypot(w.bx - w.ax, w.by - w.ay), ux = (w.bx - w.ax) / L, uy = (w.by - w.ay) / L;
      const nx = -uy, ny = ux, off = (w.thickness || 0.12) / 2 + 0.9;
      // Which side is inside: the side with a room point; otherwise the positive side.
      const probe = (s) => (prop.rooms || []).some(r => inside(r.pts, (w.ax + w.bx) / 2 + nx * s * 0.3, (w.ay + w.by) / 2 + ny * s * 0.3));
      const s = probe(1) ? 1 : probe(-1) ? -1 : 1;
      // Line runs so that its right-hand look direction points back at the wall.
      const ax = w.ax + nx * off * s, ay = w.ay + ny * off * s, bx = w.bx + nx * off * s, by = w.by + ny * off * s;
      v.line = s > 0 ? [bx, by, ax, ay] : [ax, ay, bx, by];
      v.flip = false; v.depth = off + 0.4;
      v.wallId = w.id;
      v.title = 'Interior elevation, wall ' + (prop.walls.indexOf(w) + 1);
    } else {
      const b = await planBox(); v.line = lineThrough(b, val); v.flip = false; v.depth = 0; v.wallId = '';
    }
    v.center = [0, v.center[1]];
    changed(true);
  });
  host.querySelector('[data-fov]')?.addEventListener('input', e => { v.camera.fov = Number(e.target.value); drawSheet(); touchSoon(); });
  host.querySelectorAll('[data-cam]').forEach(b => b.onclick = async () => {
    if (b.dataset.cam === 'last') { const c = lastCameraView(prop.id); if (c) v.camera = { position: [...c.position], target: [...c.target], fov: c.fov }; changed(true); return; }
    const bb = await planBox();
    const cx = (bb.minX + bb.maxX) / 2, cz = (bb.minY + bb.maxY) / 2, r = Math.max(bb.maxX - bb.minX, bb.maxY - bb.minY, 3) * 1.15;
    const sx = b.dataset.cam.includes('e') ? 1 : -1, sz = b.dataset.cam.startsWith('s') ? 1 : -1;
    v.camera = { position: [cx + sx * r, r * 0.85, cz + sz * r], target: [cx, 1, cz], fov: v.camera.fov || 45 };
    changed(true);
  });
  host.querySelector('[data-pos]')?.addEventListener('change', e => {
    const p = (prop.photoPositions || []).find(x => x.id === e.target.value);
    if (p && p.view) { v.camera = { position: [...p.view.position], target: [...p.view.target], fov: p.view.fov }; v.title = 'Position ' + p.number + (p.name ? ', ' + p.name : ''); changed(true); }
  });
  host.querySelector('[data-dup]').onclick = () => {
    const copy = normalizeViewport({ ...JSON.parse(JSON.stringify(v)), id: undefined, x: v.x + 0.25, y: v.y + 0.25 });
    curSheet().viewports.push(copy); numberViewports(curSet()); selectedId = copy.id; changed(true);
  };
  host.querySelector('[data-del]').onclick = deleteViewport;
}

function inside(pts, x, y) {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}

// ---------- saved documents ----------

function renderViewer() {
  const stage = el.querySelector('[data-stage]');
  const d = (prop.photos || []).find(p => p.id === viewing.id);
  if (!d) { viewing = null; render(); return; }
  stage.innerHTML = `<div class="dc-viewer"><div class="dc-viewer-page" data-page>Loading…</div></div>`;
  const host = stage.querySelector('[data-page]');
  const w = Math.min(2400, Math.round((stage.clientWidth - 60) * (window.devicePixelRatio || 1)));
  (async () => {
    let href = '';
    if (d.mime === 'application/pdf') href = (await renderPdfPage(d.id, viewing.page, w)).canvas.toDataURL('image/jpeg', 0.9);
    else { const buf = await photoBytes(d.id); href = buf ? URL.createObjectURL(new Blob([buf], { type: d.mime })) : d.thumb; }
    if (el && viewing && viewing.id === d.id) host.innerHTML = `<img src="${esc(href)}" alt="${esc(d.name)}">`;
  })().catch(e => { host.textContent = 'This document could not be shown: ' + e.message; });
}

function docInspector() {
  const d = (prop.photos || []).find(p => p.id === viewing.id);
  if (!d) return '';
  const rev = prop.docSets.flatMap(s => s.revisions.map(r => ({ s, r }))).find(x => x.r.documentId === d.id);
  return `<h3 class="kicker">SAVED DOCUMENT</h3>
    <p><b>${esc(d.name)}</b></p>
    <p class="faint">${d.mime === 'application/pdf' ? 'PDF' : 'Image'}${d.pageCount > 1 ? ', ' + d.pageCount + ' pages' : ''} · added ${esc(String(d.createdAt || '').slice(0, 10))}</p>
    ${rev ? `<p class="faint">Revision ${rev.r.n} of the drawing set "${esc(rev.s.name)}".</p>` : ''}
    ${d.pageCount > 1 ? `<div class="dc-pager"><button class="btn small" data-page="-1" ${viewing.page > 1 ? '' : 'disabled'}>◀</button><span>Page ${viewing.page} of ${d.pageCount}</span><button class="btn small" data-page="1" ${viewing.page < d.pageCount ? '' : 'disabled'}>▶</button></div>` : ''}
    ${d.notes ? `<p class="dc-notes">${esc(d.notes)}</p>` : ''}
    <p class="faint">PLACE ON SHEET puts this page on the open sheet. It also shows in PHOTOS, where it can be pinned in the 3D model.</p>`;
}

function bindDocInspector(host) {
  host.querySelectorAll('[data-page]').forEach(b => b.onclick = () => { viewing.page += +b.dataset.page; renderViewer(); renderInspector(); });
}

async function downloadDoc() {
  const d = (prop.photos || []).find(p => p.id === viewing.id);
  const buf = d && await photoBytes(d.id);
  if (!buf) { setStatus('The file of this document is not on this computer.'); return; }
  download(new Blob([buf], { type: d.mime }), d.name);
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// ---------- PDF ----------

async function exportPdf(saveToProject) {
  const set = curSet();
  if (!set) return;
  const bar = el.querySelector('[data-toolbar]');
  bar.querySelectorAll('button').forEach(b => b.disabled = true);
  try {
    const date = isoToday();
    if (saveToProject) {
      const n = (set.revisions[set.revisions.length - 1]?.n || 0) + 1;
      const name = set.name + ' - rev ' + n + ' - ' + date + '.pdf';
      // The title block of the saved copy shows the revision it becomes.
      set.revisions.push({ n, date, note: 'Issued', documentId: '' });
      let file;
      try { file = new File([await setPdf(set, k => setStatus('Rendering sheet ' + k + ' of ' + set.sheets.length + ' for revision ' + n + '…'))], name, { type: 'application/pdf' }); }
      catch (e) { set.revisions.pop(); throw e; }
      const doc = await addDocumentFromFile(prop, file);
      doc.notes = 'Drawing set "' + set.name + '", revision ' + n + ', saved ' + date + ' from DOCUMENTS (' + set.sheets.length + ' sheet' + (set.sheets.length === 1 ? '' : 's') + ').';
      set.revisions[set.revisions.length - 1].documentId = doc.id;
      touch();
      setStatus('Saved ' + name + ' to this property\'s documents.');
      renderLists(); renderInspector(); drawSheet();
    } else {
      const bytes = await setPdf(set, n => setStatus('Rendering sheet ' + n + ' of ' + set.sheets.length + '…'));
      download(new Blob([bytes], { type: 'application/pdf' }), set.name + ' - ' + date + '.pdf');
      setStatus('PDF downloaded.');
    }
  } catch (e) {
    console.error(e);
    setStatus('The PDF could not be made: ' + (e.message || e));
  } finally {
    if (el) renderToolbar();
  }
}

// Every sheet of a set rendered at EXPORT_DPI into one PDF.
export async function setPdf(set, progress) {
  const paper = paperOf(set);
  const pages = [];
  const date = set.revisions.length ? set.revisions[set.revisions.length - 1].date : isoToday();
  for (const [i, sheet] of set.sheets.entries()) {
    progress && progress(i + 1);
    const imgs = new Map();
    for (const v of sheet.viewports) {
      if (v.kind === 'schedule' || v.kind === 'text') continue;
      const px = Math.round(v.w * EXPORT_DPI), py = Math.round(v.h * EXPORT_DPI);
      try { imgs.set(v.id, { href: await imageHref(v, px, py, 'image/jpeg') }); }
      catch (e) { imgs.set(v.id, { href: '', error: 'Not rendered: ' + (e.message || e) }); }
    }
    const svg = sheetSvg(prop, set, sheet, imgs, { screen: false, index: i, count: set.sheets.length, date });
    const W = Math.round(paper.w * EXPORT_DPI), H = Math.round(paper.h * EXPORT_DPI);
    const img = new Image();
    img.decoding = 'async';
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    try {
      img.src = url;
      await img.decode();
    } finally { URL.revokeObjectURL(url); }
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
    ctx.drawImage(img, 0, 0, W, H);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9));
    pages.push({ jpeg: new Uint8Array(await blob.arrayBuffer()), px: [W, H], inches: [paper.w, paper.h] });
  }
  return pdfFromJpegs(pages, { title: prop.name + ' - ' + set.name, date: new Date().toISOString() });
}
