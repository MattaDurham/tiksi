// Markup mode: draw over MODEL or PLAN with an Apple Pencil, a finger or a mouse, and pin
// numbered notes. One layer serves both pages; the page hands it a `host` that knows its own
// geometry. The records are markups.js.
//
// Who draws and who moves the view:
// - A pen (Apple Pencil, a tablet pen) always draws. While it is down, and for a moment after,
//   touches are ignored: that is the side of the hand resting on the glass.
// - A mouse draws with the left button. The wheel, the other buttons, the MOVE tool and a held
//   Space still move the view.
// - Fingers draw until a pen has been seen on this device, and move the view after that (the
//   finger button in the bar says which, and switches it). When a finger draws, two fingers
//   still move the view.
// Presses the layer takes are stopped on their way down to the page's canvas (capture phase on
// the wrap), so the page's own tools, hover and navigation never see them. A finger that draws
// is not stopped: the page ignores a single finger while `fingerDraws()` and so still sees
// both fingers of a pinch.
//
// host = { kind: 'model' | 'plan', wrap, surface (the page's canvas), prop(), changed(), hint(text),
//   toast(text, kind), goTo(markup), picture(markup, marks) -> Promise<canvas>,
//   model: camera() -> { position, target, fov }, viewNow() -> a saved view's state,
//          hitAt(clientX, clientY) -> { anchor, kind, ref, p } | null, project(anchor) -> [x, y] | null
//   plan:  levelId(), toDoc(x, y) -> metres, toPx(x, y) -> px, unit() -> px per metre, viewKey() }

import { icon as appIcon } from './icons.js';
import { touch, escapeHtml } from './store.js';
import {
  MARKUP_COLORS, MARKER_ALPHA, addMarkup, addStroke, removeStroke, addNote, removeNote, setNoteText, markupById, markupTitle,
  deleteMarkup, restoreMarkup, renameMarkup, setMarkupStatus, pruneEmptyMarkups, simplifyPoints, roundPoints, strokeHit, penWidth,
  evenPressure, sameCamera, markupEmpty, normalizeMarkups,
} from './markups.js';

// This layer's stylesheet and its own icons come with it, not with the app's first load.
const ICONS = {
  pen: '<path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19z"/><path d="m14.5 6.5 3 3"/>',
  marker: '<path d="m9 14 8.5-8.5a1.8 1.8 0 0 1 2.5 0l.5.5a1.8 1.8 0 0 1 0 2.5L12 17z"/><path d="m9 14-2 2 3 3 2-2"/><path d="m7 16-3 4h4l1-1"/>',
  eraser: '<path d="M8.5 19 3.6 14.1a1.5 1.5 0 0 1 0-2.1l8-8a1.5 1.5 0 0 1 2.1 0l6.7 6.7a1.5 1.5 0 0 1 0 2.1L14 19z"/><path d="m8 8.5 7.5 7.5M8.5 19H21"/>',
  hand: '<path d="M8 12.5V6a1.5 1.5 0 0 1 3 0v5m0-6.5a1.5 1.5 0 0 1 3 0V11m0-5a1.5 1.5 0 0 1 3 0v6m0-2.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-1.6a6 6 0 0 1-4.6-2.2L4.6 14a1.6 1.6 0 0 1 2.4-2.1l1 1.1"/>',
  finger: '<path d="M10 13.5v-9a1.5 1.5 0 0 1 3 0V10l4.3.9a2 2 0 0 1 1.6 2.3l-.7 4.3a3 3 0 0 1-3 2.5h-3.1a3 3 0 0 1-2.4-1.2L6.3 14a1.5 1.5 0 0 1 2.3-1.9z"/>',
  list: '<path d="M8.5 6H20M8.5 12H20M8.5 18H20"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>',
};
const icon = name => ICONS[name]
  ? `<svg class="ic ic-${name}" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" focusable="false" aria-hidden="true">${ICONS[name]}</svg>`
  : appIcon(name);
// Resolves once the stylesheet is in (or could not be fetched: the layer still works, plainly).
export const ready = new Promise(resolve => {
  if (document.querySelector('link[data-markup-css]')) { resolve(); return; }
  const link = document.createElement('link');
  link.rel = 'stylesheet'; link.href = './css/markup.css'; link.dataset.markupCss = '';
  link.onload = link.onerror = () => resolve();
  document.head.append(link);
});
// Lists already tidied (markups.js), so a rebuilt page does not redo it; a list another device
// changed is tidied again when the page says so (`refresh(true)`).
const tidied = new WeakSet();
function tidy(prop, again = false) {
  if (!prop || (!again && tidied.has(prop.markups))) return;
  normalizeMarkups(prop);
  tidied.add(prop.markups);
}

// Line widths in px on the screen at the moment of drawing: fine, medium, bold.
const PEN_PX = [2.5, 5, 9], MARKER_PX = [14, 22, 34], ERASER_PX = 12;
const PALM_MS = 450;          // touches this soon after the pen are the hand, not a gesture
const PALM_PX = 90;           // once a pen is in use, a contact this wide is the hand, not a fingertip
const TAP_PX = 8;
const UNDO_LIMIT = 100;
const TOOLS = [['pen', 'pen', 'Pen', 'P'], ['marker', 'marker', 'Highlighter', 'H'], ['eraser', 'eraser', 'Eraser', 'E'], ['note', 'note', 'Numbered note', 'N'], ['move', 'hand', 'Move the view', 'V']];

// What survives the page being rebuilt (a save merged from another device rebuilds PLAN): whether
// markup mode is on, the tool, colour and size, and which markup is open. The mode itself only
// comes back when the page is rebuilt straight away; leaving for another page ends it.
const fresh = () => ({ on: false, tool: 'pen', color: MARKUP_COLORS[0], size: 1, activeId: null, finger: null, shown: true, list: false, leftAt: -Infinity });
const REBUILD_MS = 1500;
const kept = { model: fresh(), plan: fresh() };
let penSeen = false;
const now = () => performance.now();
const clone = v => JSON.parse(JSON.stringify(v));

// One stroke onto a 2D context. `map(x, y)` turns the stroke's own coordinates into px and
// `unit` is px per coordinate unit; the layer, the live stroke and a saved picture all use it.
export function drawStroke(ctx, s, map, unit) {
  const p = s.pts, n = Math.floor(p.length / 3);
  if (!n) return;
  const base = Math.max(0.75, s.width * unit), marker = s.tool === 'marker';
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = s.color; ctx.fillStyle = s.color;
  ctx.globalAlpha = marker ? MARKER_ALPHA : 1;
  const at = i => map(p[i * 3], p[i * 3 + 1]);
  if (n === 1) {
    const [x, y] = at(0);
    ctx.beginPath(); ctx.arc(x, y, (marker ? base : penWidth(base, p[2])) / 2, 0, Math.PI * 2); ctx.fill();
  } else if (marker || evenPressure(p)) {
    // One even line: a single path, so a highlighter does not darken where it crosses itself.
    ctx.lineWidth = marker ? base : penWidth(base, p[2]);
    ctx.beginPath();
    let a = at(0);
    ctx.moveTo(a[0], a[1]);
    for (let i = 1; i < n - 1; i++) {
      const b = at(i), c = at(i + 1);
      ctx.quadraticCurveTo(b[0], b[1], (b[0] + c[0]) / 2, (b[1] + c[1]) / 2);
    }
    a = at(n - 1);
    ctx.lineTo(a[0], a[1]);
    ctx.stroke();
  } else {
    // Pen pressure: each short piece at its own width, curved through the points between.
    let a = at(0), mid = a;
    for (let i = 1; i < n; i++) {
      const b = at(i), next = i === n - 1 ? b : [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      ctx.lineWidth = penWidth(base, (p[(i - 1) * 3 + 2] + p[i * 3 + 2]) / 2);
      ctx.beginPath(); ctx.moveTo(mid[0], mid[1]);
      if (i === n - 1) ctx.quadraticCurveTo(a[0], a[1], b[0], b[1]); else ctx.quadraticCurveTo(a[0], a[1], next[0], next[1]);
      ctx.stroke();
      mid = next; a = b;
    }
  }
  ctx.restore();
}

// A note's numbered disc onto a 2D context, for a saved picture.
export function drawNoteDisc(ctx, x, y, label, color, r = 13) {
  ctx.save();
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = color; ctx.fill();
  ctx.lineWidth = Math.max(1.5, r * 0.16); ctx.strokeStyle = '#ffffff'; ctx.stroke();
  ctx.fillStyle = textOn(color); ctx.font = `700 ${Math.round(r * 1.05)}px -apple-system, "Segoe UI", sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(String(label), x, y + r * 0.05);
  ctx.restore();
}
function textOn(hex) {
  const v = parseInt(hex.slice(1), 16), l = (0.299 * (v >> 16 & 255) + 0.587 * (v >> 8 & 255) + 0.114 * (v & 255)) / 255;
  return l > 0.62 ? '#111111' : '#ffffff';
}

export function attachMarkup(host) {
  const S = kept[host.kind], model = host.kind === 'model';
  const wrap = host.wrap, surface = host.surface;
  const make = (tag, cls) => { const e = document.createElement(tag); e.className = cls; return e; };
  // The two ink canvases live in a closed shadow root: to the page, and to everything that
  // looks for "the canvas" of MODEL or PLAN, the view still holds exactly one.
  const layerEl = make('div', 'mk-layer'), ink = make('canvas', 'mk-ink'), live = make('canvas', 'mk-live');
  ink.style.cssText = live.style.cssText = 'position:absolute;left:0;top:0;display:block;pointer-events:none';
  layerEl.attachShadow({ mode: 'closed' }).append(ink, live);
  layerEl.ink = ink;            // for a check that reads what is drawn
  const notesEl = make('div', 'mk-notes'), chip = make('button', 'mk-chip'), bar = make('div', 'mk-bar'), listEl = make('div', 'mk-list');
  bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', 'Markup');
  chip.type = 'button'; chip.hidden = true; listEl.hidden = true; bar.hidden = true;
  wrap.append(layerEl, notesEl, chip, listEl, bar);

  let size = { w: 0, h: 0, d: 1 };
  let inkDirty = true, liveDirty = true, notesKey = '', viewKey = '', raf = 0, gone = false;
  let stroke = null;            // the press in progress: { id, type, tool, eaten, px: [x, y, p, ...], predicted, t0, start, erased }
  let hoverAt = null;           // where a hovering pen is, px
  let penDown = false, lastPen = -Infinity, spaceDown = false;
  const fingers = new Set(), ignored = new Set();
  let editor = null;            // the open note editor: { el, markupId, noteId }
  let confirmDelete = null, renaming = null, busyPicture = false;
  const undo = [], redo = [];
  const prop = () => host.prop();
  tidy(prop());
  const active = () => { const m = markupById(prop(), S.activeId); return m && m.on === host.kind ? m : null; };

  // ---------- geometry ----------
  const toPx = model ? (u, v) => [size.w / 2 + u * size.h, size.h / 2 + v * size.h] : (u, v) => host.toPx(u, v);
  const toDoc = model ? (x, y) => [(x - size.w / 2) / size.h, (y - size.h / 2) / size.h] : (x, y) => host.toDoc(x, y);
  const unit = () => model ? size.h : host.unit();
  const local = e => { const r = surface.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  // Is the camera where this markup was drawn? Ink over the model only shows from there.
  const onView = m => !model || (!!m && sameCamera(m.view.camera, host.camera()));
  // The markups whose ink is on the screen now.
  function shownMarkups() {
    if (!S.shown) return [];
    if (model) { const m = active(); return m && onView(m) ? [m] : []; }
    const level = host.levelId();
    return (prop().markups || []).filter(m => m.on === 'plan' && m.levelId === level);
  }

  // ---------- drawing ----------
  function fit() {
    const w = surface.clientWidth, h = surface.clientHeight, d = Math.min(2, window.devicePixelRatio || 1);
    if (w === size.w && h === size.h && d === size.d) return;
    size = { w, h, d };
    for (const c of [ink, live]) {
      c.width = Math.max(1, Math.round(w * d)); c.height = Math.max(1, Math.round(h * d));
      c.style.width = w + 'px'; c.style.height = h + 'px';
      c.style.left = surface.offsetLeft + 'px'; c.style.top = surface.offsetTop + 'px';
    }
    inkDirty = liveDirty = true; notesKey = '';
    liftPanels();
  }
  function paintInk() {
    inkDirty = false;
    const ctx = ink.getContext('2d');
    ctx.setTransform(size.d, 0, 0, size.d, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);
    const u = unit();
    for (const m of shownMarkups()) for (const s of m.strokes) drawStroke(ctx, s, toPx, u);
  }
  function paintLive() {
    liveDirty = false;
    const ctx = live.getContext('2d');
    ctx.setTransform(size.d, 0, 0, size.d, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);
    if (stroke && (stroke.tool === 'pen' || stroke.tool === 'marker') && stroke.px.length) {
      const px = (stroke.tool === 'marker' ? MARKER_PX : PEN_PX)[S.size];
      // The browser's guess at the next few positions is drawn as a tail and redrawn every frame.
      drawStroke(ctx, { tool: stroke.tool, color: S.color, width: px, pts: stroke.predicted.length ? stroke.px.concat(stroke.predicted) : stroke.px }, (x, y) => [x, y], 1);
    }
    const ring = stroke && stroke.tool === 'eraser' ? stroke.at : (S.on && hoverAt && !stroke ? hoverAt : null);
    if (ring) {
      const r = stroke || S.tool === 'eraser' ? ERASER_PX : Math.max(3, (S.tool === 'marker' ? MARKER_PX : PEN_PX)[S.size] / 2);
      ctx.beginPath(); ctx.arc(ring[0], ring[1], r, 0, Math.PI * 2);
      ctx.lineWidth = 1.5; ctx.strokeStyle = S.tool === 'eraser' || stroke ? '#ffffff' : S.color; ctx.stroke();
      ctx.beginPath(); ctx.arc(ring[0], ring[1], r + 1.5, 0, Math.PI * 2);
      ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)'; ctx.stroke();
    }
  }

  // ---------- notes on the screen ----------
  // Over the model a pinned note shows from any camera, at its point; one with no pin shows
  // with its markup's ink. On the plan every note of the level shows.
  function shownNotes() {
    if (!S.shown) return [];
    const out = [], own = active();
    for (const m of prop().markups || []) {
      if (m.on !== host.kind) continue;
      if (!model && m.levelId !== host.levelId()) continue;
      for (const n of m.notes) {
        let at = null;
        if (!model) at = toPx(n.at[0], n.at[1]);
        else if (n.anchor) at = host.project(n.anchor);
        else if (m === own && onView(m)) at = toPx(n.at[0], n.at[1]);
        if (at) out.push({ m, n, at, own: m === own });
      }
    }
    return out;
  }
  function layoutNotes() {
    const list = shownNotes();
    const key = list.map(x => x.n.id + ':' + x.n.n + ':' + x.m.number + ':' + (x.own ? 1 : 0) + ':' + x.n.text).join('|');
    if (key !== notesKey) {
      notesKey = key;
      notesEl.innerHTML = list.map(x => {
        const color = (x.m.strokes[0] && x.m.strokes[0].color) || MARKUP_COLORS[0];
        return `<button type="button" class="mk-note ${x.own ? 'own' : ''}" data-markup="${escapeHtml(x.m.id)}" data-note="${escapeHtml(x.n.id)}" style="--c:${color};--t:${textOn(color)}"` +
          ` title="${escapeHtml(markupTitle(x.m) + ', note ' + x.n.n)}"><b>${x.own ? x.n.n : x.m.number + '.' + x.n.n}</b>${x.n.text ? `<span>${escapeHtml(x.n.text)}</span>` : ''}</button>`;
      }).join('');
      for (const b of notesEl.children) b.onclick = () => openEditor(b.dataset.markup, b.dataset.note);
    }
    list.forEach((x, i) => {
      const b = notesEl.children[i];
      b.style.transform = `translate(${Math.round(x.at[0] + surface.offsetLeft)}px, ${Math.round(x.at[1] + surface.offsetTop)}px)`;
    });
  }

  // Called by the page once per frame it draws (and by this layer while a stroke is live).
  function frame() {
    if (gone) return;
    fit();
    const key = model ? JSON.stringify(host.camera()) : host.viewKey();
    if (key !== viewKey) { viewKey = key; inkDirty = true; refreshChip(); }
    if (inkDirty) paintInk();
    layoutNotes();
    if (editor) placeEditor();
  }
  function loop() {
    raf = requestAnimationFrame(loop);
    if (liveDirty) paintLive();
  }
  // `outside`: the records were changed by something other than this layer (another device).
  function refresh(outside = false) { if (outside) tidy(prop(), true); inkDirty = true; notesKey = ''; refreshChip(); if (!listEl.hidden) renderList(); frame(); }

  // ---------- which markup a mark joins ----------
  // The open markup while the view is still its own (over the model) or the level is (on the
  // plan); otherwise a new one, made at the first mark.
  function target() {
    let m = active();
    if (m && (model ? onView(m) : m.levelId === host.levelId())) return { m, made: null };
    m = addMarkup(prop(), model ? { on: 'model', view: host.viewNow() } : { on: 'plan', levelId: host.levelId() });
    S.activeId = m.id;
    return { m, made: { markup: clone(m), index: prop().markups.indexOf(m) } };
  }
  const header = m => ({ markup: { ...clone(m), strokes: [], notes: [] }, index: prop().markups.indexOf(m) });
  function ensure(h) { return markupById(prop(), h.markup.id) || restoreMarkup(prop(), h.markup, h.index); }
  function did(op) { undo.push(op); if (undo.length > UNDO_LIMIT) undo.shift(); redo.length = 0; }
  function saved() { pruneEmptyMarkups(prop(), null); if (S.activeId && !active()) S.activeId = null; touch(); refresh(); renderBar(); }

  // One step back or forward. Every step names the markup it belongs to and carries what it
  // takes to put that markup back if the step itself emptied it.
  function apply(op, back) {
    const add = (op.t === 'ink+' || op.t === 'note+') !== back;
    // Strokes one eraser drag took go back last-taken first, so each lands at its old place.
    for (const it of add ? [...op.items].reverse() : op.items) {
      if (it.whole) {
        if (add) { restoreMarkup(prop(), it.whole, it.index); continue; }
        // What is taken out is remembered as it is now (renamed, ticked off, a note reworded
        // since the step was made), so putting it back loses none of that.
        const live = markupById(prop(), it.whole.id);
        if (live) { it.index = prop().markups.indexOf(live); it.whole = clone(live); deleteMarkup(prop(), live.id); }
        continue;
      }
      const m = add ? ensure(it.head) : markupById(prop(), it.head.markup.id);
      if (!m) continue;
      if (!add) it.head = header(m);
      if (it.stroke) { if (add) addStroke(m, it.stroke, it.index); else { const live = m.strokes.find(x => x.id === it.stroke.id); if (live) it.stroke = clone(live); removeStroke(m, it.stroke.id); } }
      if (it.note) { if (add) addNote(m, it.note); else { const live = m.notes.find(x => x.id === it.note.id); if (live) it.note = clone(live); removeNote(m, it.note.id); } }
    }
  }
  function step(back) {
    const op = (back ? undo : redo).pop();
    if (!op) return;
    closeEditor(false);
    apply(op, back);
    (back ? redo : undo).push(op);
    pruneEmptyMarkups(prop(), null);
    // A step that brought a markup back opens it again: over the model only the open markup's
    // ink shows, and the next mark belongs with it.
    if (!active()) {
      const back2 = op.items.map(it => markupById(prop(), it.whole ? it.whole.id : it.head.markup.id)).find(m => m && m.on === host.kind);
      S.activeId = back2 ? back2.id : null;
    }
    saved();
  }

  // ---------- strokes ----------
  const pressureOf = e => e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : 0.5;
  function push(e) {
    const [x, y] = local(e), p = stroke.px, n = p.length;
    if (n && Math.hypot(x - p[n - 3], y - p[n - 2]) < 0.3) { p[n - 1] = Math.max(p[n - 1], pressureOf(e)); return; }
    p.push(x, y, pressureOf(e));
    if (n) stroke.length += Math.hypot(x - p[n - 3], y - p[n - 2]);
    // A very long press is thinned as it goes, so it never outgrows what a stroke may hold.
    if (p.length > 3 * 3000) stroke.px = simplifyPoints(p, 0.6);
  }
  function extend(e) {
    const more = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    for (const c of more.length ? more : [e]) push(c);
    const guess = typeof e.getPredictedEvents === 'function' ? e.getPredictedEvents() : [];
    stroke.predicted = [];
    for (const g of guess.slice(0, 4)) { const [x, y] = local(g); stroke.predicted.push(x, y, pressureOf(g)); }
  }
  function commitStroke() {
    const px = stroke.px, u = unit();
    if (!px.length || !(u > 0)) return;
    const doc = [];
    for (let i = 0; i + 2 < px.length; i += 3) { const [x, y] = toDoc(px[i], px[i + 1]); doc.push(x, y, px[i + 2]); }
    const width = (stroke.tool === 'marker' ? MARKER_PX : PEN_PX)[S.size] / u;
    const pts = roundPoints(simplifyPoints(doc, 0.35 / u), model ? 5 : 4);
    let t;
    try { t = target(); } catch (err) { host.toast(String(err.message || err), 'error'); return; }
    const s = addStroke(t.m, { tool: stroke.tool, color: S.color, width, pts });
    if (!s) { host.toast('This markup is full. Start a new one to keep drawing.', 'warn'); saved(); return; }
    did({ t: 'ink+', items: [{ head: header(t.m), stroke: clone(s), index: t.m.strokes.length - 1 }] });
    saved();
    if (model) setTimeout(() => readSurfaces(t.m.id, s.id), 0);
  }
  // What a stroke over the model is drawn on: up to eight points along it, each dropped onto
  // whatever the model has under it. Read once the stroke is down, so drawing never waits.
  function readSurfaces(markupId, strokeId) {
    if (gone) return;
    const m = markupById(prop(), markupId), s = m && m.strokes.find(x => x.id === strokeId);
    if (!s || !onView(m)) return;
    // Evenly along its length, not at its saved points: a straight line across a wall is saved
    // as its two ends, and it is the wall between them that matters.
    const n = s.pts.length / 3, r = surface.getBoundingClientRect(), on = [];
    const at = [], run = [0];
    for (let i = 0; i < n; i++) { at.push(toPx(s.pts[i * 3], s.pts[i * 3 + 1])); if (i) run.push(run[i - 1] + Math.hypot(at[i][0] - at[i - 1][0], at[i][1] - at[i - 1][1])); }
    const total = run[n - 1], take = total > 4 ? 8 : 1;
    for (let k = 0, i = 1; k < take; k++) {
      const d = take === 1 ? 0 : total * k / (take - 1);
      while (i < n - 1 && run[i] < d) i++;
      const t = n > 1 && run[i] > run[i - 1] ? (d - run[i - 1]) / (run[i] - run[i - 1]) : 0;
      const x = n > 1 ? at[i - 1][0] + (at[i][0] - at[i - 1][0]) * t : at[0][0], y = n > 1 ? at[i - 1][1] + (at[i][1] - at[i - 1][1]) * t : at[0][1];
      const hit = host.hitAt(r.left + x, r.top + y);
      if (hit) on.push({ k: hit.kind, id: hit.ref || '', p: hit.p.map(v => Math.round(v * 1000) / 1000) });
    }
    if (!on.length) return;
    s.on = on;
    for (const op of undo) for (const it of op.items) if (it.stroke && it.stroke.id === s.id) it.stroke.on = clone(on);
    touch();
  }
  function eraseAt(at) {
    const [x, y] = toDoc(at[0], at[1]), r = ERASER_PX / unit();
    let any = false;
    for (const m of shownMarkups()) {
      for (const s of m.strokes.filter(k => strokeHit(k, x, y, r))) {
        const head = header(m), taken = removeStroke(m, s.id);
        stroke.erased.push({ head, stroke: clone(taken.stroke), index: taken.index });
        any = true;
      }
    }
    if (any) { inkDirty = true; frame(); }
  }

  // ---------- notes ----------
  function placeNote(at, e) {
    const hit = model ? host.hitAt(e.clientX, e.clientY) : null;
    let t;
    try { t = target(); } catch (err) { host.toast(String(err.message || err), 'error'); return; }
    const [x, y] = toDoc(at[0], at[1]);
    const n = addNote(t.m, { at: [x, y], anchor: hit ? hit.anchor : undefined, kind: hit ? hit.kind : undefined, ref: hit ? hit.ref : undefined, text: '' });
    if (!n) { host.toast('This markup has all the notes it can hold.', 'warn'); saved(); return; }
    did({ t: 'note+', items: [{ head: header(t.m), note: clone(n) }] });
    saved();
    openEditor(t.m.id, n.id, true);
  }
  function openEditor(markupId, noteId, isNew = false) {
    closeEditor(true);
    const m = markupById(prop(), markupId), n = m && m.notes.find(x => x.id === noteId);
    if (!n) return;
    const el = make('div', 'mk-edit');
    el.innerHTML = `<div class="mk-edit-head"><b>${escapeHtml(markupTitle(m))}, note ${n.n}</b></div>
      <textarea rows="3" placeholder="What should change here?" aria-label="Note ${n.n}"></textarea>
      <div class="mk-edit-row">
        ${model && !sameCamera(m.view.camera, host.camera()) ? '<button type="button" class="btn" data-go>GO TO ITS VIEW</button>' : ''}
        <span class="mk-grow"></span>
        <button type="button" class="btn" data-del>DELETE</button>
        <button type="button" class="btn primary" data-ok>DONE</button>
      </div>`;
    wrap.append(el);
    const ta = el.querySelector('textarea');
    ta.value = n.text;
    editor = { el, markupId, noteId, before: n.text };
    el.querySelector('[data-ok]').onclick = () => closeEditor(true);
    el.querySelector('[data-del]').onclick = () => {
      const mm = markupById(prop(), markupId), nn = mm && mm.notes.find(x => x.id === noteId);
      closeEditor(false);
      if (!nn) return;
      const head = header(mm);
      removeNote(mm, noteId);
      did({ t: 'note-', items: [{ head, note: clone(nn) }] });
      saved();
    };
    const go = el.querySelector('[data-go]');
    if (go) go.onclick = () => { closeEditor(true); open(markupId); };
    ta.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); closeEditor(true); }
      else if (e.key === 'Escape') { e.preventDefault(); closeEditor(false); }
    });
    placeEditor();
    // A new note on a touch screen waits for a tap in the box: opening the keyboard unasked
    // covers half the model. Anywhere else the cursor goes straight in.
    if (!isNew || !matchMedia('(hover: none) and (pointer: coarse)').matches) ta.focus({ preventScroll: true });
  }
  function placeEditor() {
    const hit = shownNotes().find(x => x.n.id === editor.noteId);
    const w = editor.el.offsetWidth || 260, h = editor.el.offsetHeight || 150;
    const at = hit ? hit.at : [size.w / 2, size.h / 2];
    const x = Math.min(Math.max(8, at[0] + surface.offsetLeft + 18), Math.max(8, wrap.clientWidth - w - 8));
    // Below the note where there is room above the bar, otherwise above the note.
    let y = at[1] + surface.offsetTop + 18;
    if (y + h > barTop - 8) y = Math.max(8, Math.min(at[1] + surface.offsetTop - h - 18, barTop - h - 8));
    editor.el.style.left = x + 'px'; editor.el.style.top = y + 'px';
  }
  function closeEditor(keep) {
    if (!editor) return;
    const { el, markupId, noteId, before } = editor;
    editor = null;
    const text = el.querySelector('textarea').value;
    el.remove();
    const m = markupById(prop(), markupId);
    if (keep && m && text !== before && setNoteText(m, noteId, text)) {
      // The step that made the note carries its words, so redo brings them back too.
      for (const op of undo) for (const it of op.items) if (it.note && it.note.id === noteId) it.note.text = m.notes.find(x => x.id === noteId).text;
      touch(); refresh();
    }
  }

  // ---------- presses ----------
  const eat = e => { e.stopPropagation(); if (e.cancelable) e.preventDefault(); };
  // The finger button: on by itself until a pen is seen, then as it was last set.
  const fingerOn = () => S.finger === true || (S.finger === null && !penSeen);
  const fingerDraws = () => S.on && S.tool !== 'move' && fingerOn();
  function begin(e, eaten) {
    const type = e.pointerType || 'mouse';
    // The eraser end of a pen (or its eraser button) erases whatever tool is chosen.
    const tool = type === 'pen' && (e.buttons & 32 || e.button === 5) ? 'eraser' : S.tool;
    stroke = { id: e.pointerId, type, tool, eaten, px: [], predicted: [], t0: now(), start: local(e), at: local(e), length: 0, erased: [], event: { clientX: e.clientX, clientY: e.clientY } };
    if (type === 'pen') penDown = true;
    hoverAt = null;
    if (host.hold) host.hold();
    if (tool === 'pen' || tool === 'marker') push(e);
    else if (tool === 'eraser') eraseAt(stroke.at);
    liveDirty = true;
  }
  function finish(cancelled) {
    const s = stroke;
    if (!s) return;
    if (s.tool === 'eraser') {
      if (s.erased.length) { did({ t: 'ink-', items: s.erased }); stroke = null; saved(); }
    } else if (s.tool === 'note') {
      if (!cancelled && Math.hypot(s.at[0] - s.start[0], s.at[1] - s.start[1]) <= TAP_PX) { stroke = null; placeNote(s.start, s.event); }
    } else if (!cancelled) commitStroke();
    stroke = null;
    liveDirty = true;
  }
  function onDown(e) {
    if (!S.on || gone) return;
    const type = e.pointerType || 'mouse';
    // A release that never arrived (the pointer let go outside the window, the app was left
    // mid-press) must not leave its press half open when the same pointer comes down again.
    ignored.delete(e.pointerId);
    if (stroke && stroke.id === e.pointerId) finish(false);
    if (editor && !editor.el.contains(e.target)) {
      // A press outside the open note keeps what was typed; it does not also draw or place.
      closeEditor(true);
      if (e.target === surface) { eat(e); ignored.add(e.pointerId); }
      return;
    }
    if (e.target !== surface) return;
    const firstPen = type === 'pen' && !penSeen;
    if (type === 'pen') { penSeen = true; lastPen = now(); }
    if (type === 'touch') {
      fingers.add(e.pointerId);
      if (penDown || now() - lastPen < PALM_MS || (penSeen && Math.max(e.width || 0, e.height || 0) > PALM_PX)) { eat(e); ignored.add(e.pointerId); return; }
      if (!fingerDraws()) return;
      if (fingers.size > 1) {
        // A second finger: the two of them move the view. What the first drew so far stays only
        // if it was already a real line.
        if (stroke && stroke.type === 'touch') finish(now() - stroke.t0 < 300 || stroke.length < 16);
        return;
      }
      if (!stroke) begin(e, false);
      return;
    }
    // The hand came down a moment before the pencil and started a line of its own: that line
    // is dropped and the pencil draws. (The hand's press reached the page, so its release must
    // too; it is not put on the ignored list.)
    if (type === 'pen' && stroke && stroke.type === 'touch') finish(true);
    if (S.tool === 'move' || spaceDown || stroke) return;
    if (e.button !== 0 && !(type === 'pen' && e.button === 5)) return;
    if (e.ctrlKey && type === 'mouse') return;     // Ctrl-click is the page's right-click on a Mac
    eat(e);
    try { surface.setPointerCapture(e.pointerId); } catch (err) { /* the press is already over */ }
    begin(e, true);
    if (firstPen) { renderBar(); host.changed(S.on); }   // the finger button now reads "fingers move the view"
  }
  function onMove(e) {
    if (!S.on || gone) return;
    const type = e.pointerType || 'mouse';
    if (ignored.has(e.pointerId)) { eat(e); return; }
    if (type === 'pen') {
      lastPen = now();
      // A pencil hovering over the glass is a pencil in use: from here on fingers move the view.
      if (!penSeen) { penSeen = true; renderBar(); host.changed(S.on); }
    }
    if (stroke && e.pointerId === stroke.id && stroke.type !== 'touch' && e.buttons === 0) {
      // Moving with nothing pressed: the release was lost. What was drawn is kept.
      eat(e); finish(false);
      return;
    }
    if (stroke && e.pointerId === stroke.id) {
      if (stroke.eaten) eat(e);
      stroke.at = local(e);
      if (stroke.tool === 'pen' || stroke.tool === 'marker') extend(e);
      else if (stroke.tool === 'eraser') eraseAt(stroke.at);
      liveDirty = true;
      return;
    }
    // A mouse or a pen passing over with nothing pressed: the page's own hover (outlines, the
    // pointer cursor) is not wanted while marking up, and a pen shows where it will land.
    if (type !== 'touch' && e.target === surface && e.buttons === 0 && S.tool !== 'move' && !spaceDown) {
      e.stopPropagation();
      if (type === 'pen') { hoverAt = local(e); liveDirty = true; }
    }
  }
  function onUp(e) {
    if (gone) return;
    const cancelled = e.type === 'pointercancel';
    fingers.delete(e.pointerId);
    if (e.pointerType === 'pen') { penDown = false; lastPen = now(); }
    if (ignored.delete(e.pointerId)) { eat(e); return; }
    if (!stroke || e.pointerId !== stroke.id) return;
    if (stroke.eaten) eat(e);
    stroke.at = local(e);
    // A finger the browser took back was never a stroke; a pen or mouse press cut short keeps
    // what it drew.
    finish(cancelled && stroke.type === 'touch');
  }
  // The view does not zoom under a line being drawn.
  function onWheel(e) { if (S.on && stroke && stroke.type !== 'touch') { e.stopPropagation(); if (e.cancelable) e.preventDefault(); } }
  // The window lost the keyboard and the pointer: a held Space is no longer held, and a press
  // in progress is over (what it drew is kept).
  function onBlur() { if (stroke) finish(false); spaceDown = false; wrap.classList.remove('mk-space'); }
  function onLeave(e) { if (e.pointerType === 'pen' && hoverAt) { hoverAt = null; liveDirty = true; } }
  // Safari would start a text selection, its magnifier or a double-tap zoom under a finger or
  // a pencil that stays down.
  function onTouchStart(e) { if (S.on && e.target === surface && e.cancelable) e.preventDefault(); }

  // ---------- keys ----------
  // True when the key was for markup mode; the page then leaves it alone.
  function key(e) {
    if (!S.on || gone) return false;
    if (editor) return true;
    const cmd = e.metaKey || e.ctrlKey, k = e.key.toLowerCase();
    if (cmd && k === 'z') { e.preventDefault(); step(!e.shiftKey); return true; }
    if (cmd && k === 'y') { e.preventDefault(); step(false); return true; }
    if (cmd || e.altKey) return false;
    if (e.key === 'Escape') {
      e.preventDefault();
      if (stroke) { if (stroke.tool === 'eraser' && stroke.erased.length) finish(false); else { stroke = null; liveDirty = true; } }
      else if (!listEl.hidden) toggleList(false);
      else setOn(false);
      return true;
    }
    if (e.key === ' ') { spaceDown = true; e.preventDefault(); wrap.classList.add('mk-space'); return true; }
    const tool = { p: 'pen', h: 'marker', e: 'eraser', n: 'note', v: 'move' }[k];
    if (tool) { setTool(tool); return true; }
    if (k === '1' || k === '2' || k === '3') { S.size = Number(k) - 1; renderBar(); return true; }
    return false;
  }
  function keyUp(e) { if (e.key === ' ' && spaceDown) { spaceDown = false; wrap.classList.remove('mk-space'); } }

  // ---------- the bar ----------
  function setTool(tool) {
    S.tool = tool; hoverAt = null; liveDirty = true;
    renderBar(); host.changed(S.on);
  }
  function hintText() {
    if (S.tool === 'move') return 'MOVE: drag to move the view. Pick a pen to draw again.';
    const what = { pen: 'draws', marker: 'highlights', eraser: 'rubs out whole strokes', note: 'pins a numbered note' }[S.tool];
    // A screen that takes fingers says who draws; a mouse-only one says how the view still moves.
    if (!matchMedia('(any-pointer: coarse)').matches && !penSeen) return `${S.tool === 'note' ? 'Click' : 'Drag'}: the ${S.tool === 'marker' ? 'highlighter' : S.tool} ${what}. The wheel, right-drag or Space-drag moves the view.`;
    return fingerDraws() ? `A finger or the pencil ${what}. Two fingers move the view.` : `The pencil ${what}. Fingers move the view.`;
  }
  function renderBar() {
    bar.hidden = !S.on;
    wrap.classList.toggle('mk-on', S.on);
    wrap.dataset.mkTool = S.on ? S.tool : '';
    if (!S.on) return;
    const count = (prop().markups || []).filter(m => m.on === host.kind).length;
    const touchy = matchMedia('(any-pointer: coarse)').matches;
    const b = (attrs, ic, label, on) => `<button type="button" class="mk-btn ${on ? 'active' : ''}" ${attrs} title="${label}" aria-label="${label}" ${on === undefined ? '' : `aria-pressed="${!!on}"`}>${icon(ic)}</button>`;
    bar.innerHTML =
      TOOLS.map(([id, ic, label, k]) => b(`data-tool="${id}"`, ic, `${label} (${k})`, S.tool === id)).join('') +
      '<span class="mk-sep"></span>' +
      MARKUP_COLORS.map(c => `<button type="button" class="mk-dot ${S.color === c ? 'active' : ''}" data-color="${c}" style="--c:${c}" title="Colour" aria-label="Colour ${c}" aria-pressed="${S.color === c}"></button>`).join('') +
      '<span class="mk-sep"></span>' +
      [0, 1, 2].map(i => `<button type="button" class="mk-size ${S.size === i ? 'active' : ''}" data-size="${i}" title="${['Fine', 'Medium', 'Bold'][i]} line (${i + 1})" aria-label="${['Fine', 'Medium', 'Bold'][i]} line" aria-pressed="${S.size === i}"><i style="--s:${[3, 6, 10][i]}px"></i></button>`).join('') +
      '<span class="mk-sep"></span>' +
      b('data-act="undo"' + (undo.length ? '' : ' disabled'), 'undo', 'Undo the last mark') +
      b('data-act="redo"' + (redo.length ? '' : ' disabled'), 'redo', 'Redo') +
      (touchy ? b('data-act="finger"', 'finger', fingerOn() ? 'A finger draws. Tap so that fingers only move the view.' : 'Fingers move the view. Tap to draw with a finger.', fingerOn()) : '') +
      b('data-act="new"', 'plus', 'Start a new markup') +
      `<button type="button" class="mk-btn mk-count ${S.list ? 'active' : ''}" data-act="list" title="All markups" aria-label="All markups" aria-pressed="${S.list}">${icon('list')}<b>${count}</b></button>` +
      '<button type="button" class="mk-done" data-act="done">DONE</button>';
    bar.querySelectorAll('[data-tool]').forEach(x => x.onclick = () => setTool(x.dataset.tool));
    bar.querySelectorAll('[data-color]').forEach(x => x.onclick = () => { S.color = x.dataset.color; if (S.tool !== 'pen' && S.tool !== 'marker') S.tool = 'pen'; renderBar(); host.changed(S.on); });
    bar.querySelectorAll('[data-size]').forEach(x => x.onclick = () => { S.size = Number(x.dataset.size); renderBar(); });
    const act = { undo: () => step(true), redo: () => step(false), list: () => toggleList(), done: () => setOn(false),
      finger: () => { S.finger = !fingerOn(); renderBar(); host.changed(S.on); },
      new: () => { S.activeId = null; refresh(); host.toast(model ? 'The next mark starts a new markup from this view.' : 'The next mark starts a new markup.', 'ok'); } };
    bar.querySelectorAll('[data-act]').forEach(x => x.onclick = act[x.dataset.act]);
    host.hint(hintText());
    liftPanels();
  }
  // The bar is one row on a wide view and two or three on a narrow one; the list and the
  // way-back chip sit just above it, however tall it is.
  let barTop = 0;
  function liftPanels() {
    const lift = bar.hidden ? 12 : wrap.clientHeight - bar.offsetTop + 8;
    barTop = bar.hidden ? wrap.clientHeight : bar.offsetTop;
    listEl.style.bottom = lift + 'px'; chip.style.bottom = lift + 'px';
  }
  // Over the model: the open markup's ink is out of sight because the camera has moved.
  function refreshChip() {
    const m = model && S.on ? active() : null;
    const away = !!m && !markupEmpty(m) && !onView(m);
    chip.hidden = !away;
    if (away) chip.textContent = markupTitle(m).toUpperCase() + ': BACK TO ITS VIEW';
  }
  chip.onclick = () => { const m = active(); if (m) open(m.id); };

  // ---------- the list ----------
  function toggleList(on = !S.list) { S.list = on; listEl.hidden = !on || !S.on; if (!listEl.hidden) renderList(); renderBar(); }
  function open(id) {
    const m = markupById(prop(), id);
    if (!m || m.on !== host.kind) return;
    S.activeId = id;
    if (!S.shown) S.shown = true;
    host.goTo(m);
    refresh();
  }
  function renderList() {
    const all = (prop().markups || []).filter(m => m.on === host.kind);
    const row = m => {
      const parts = [m.strokes.length + (m.strokes.length === 1 ? ' stroke' : ' strokes'), m.notes.length ? m.notes.length + (m.notes.length === 1 ? ' note' : ' notes') : ''].filter(Boolean).join(', ');
      const where = model ? '' : ((prop().levels.find(l => l.id === m.levelId) || {}).name || '');
      if (renaming === m.id) return `<div class="mk-row" data-id="${escapeHtml(m.id)}"><input class="mk-name" value="${escapeHtml(m.name)}" placeholder="${escapeHtml('Markup ' + m.number)}" maxlength="60" aria-label="Name"><button type="button" class="btn primary" data-save>SAVE</button></div>`;
      return `<div class="mk-row ${m.id === S.activeId ? 'active' : ''} ${m.status === 'done' ? 'done' : ''}" data-id="${escapeHtml(m.id)}">
        <button type="button" class="mk-open" data-open><b>${m.number}</b><span>${escapeHtml(markupTitle(m))}<small>${escapeHtml([where, parts].filter(Boolean).join(' · '))}</small></span></button>
        ${confirmDelete === m.id
          ? '<button type="button" class="btn danger" data-really>DELETE IT</button><button type="button" class="btn" data-keep>KEEP</button>'
          : `<button type="button" class="mk-btn" data-status title="${m.status === 'done' ? 'Mark as open again' : 'Mark as done'}" aria-label="${m.status === 'done' ? 'Mark as open again' : 'Mark as done'}" aria-pressed="${m.status === 'done'}">${icon('check')}</button>
        <button type="button" class="mk-btn" data-rename title="Rename" aria-label="Rename">${icon('edit')}</button>
        <button type="button" class="mk-btn" data-picture title="Save a picture of it" aria-label="Save a picture of it">${icon('image')}</button>
        <button type="button" class="mk-btn" data-delete title="Delete" aria-label="Delete">${icon('trash')}</button>`}
      </div>`;
    };
    listEl.innerHTML = `<div class="mk-list-head"><b>MARKUPS</b>
        <label class="mk-show"><input type="checkbox" ${S.shown ? 'checked' : ''} data-shown> SHOW ${model ? 'OVER THE MODEL' : 'ON THE PLAN'}</label>
        <button type="button" class="mk-btn" data-close title="Close" aria-label="Close">${icon('close')}</button></div>
      <div class="mk-rows">${all.length ? all.map(row).join('') : `<p class="mk-none">No markups yet. Draw ${model ? 'over the model' : 'on the plan'} and the first one appears here.</p>`}</div>`;
    listEl.querySelector('[data-close]').onclick = () => toggleList(false);
    listEl.querySelector('[data-shown]').onchange = e => { S.shown = e.target.checked; refresh(); };
    listEl.querySelectorAll('.mk-row').forEach(r => {
      const id = r.dataset.id, on = (sel, fn) => { const x = r.querySelector(sel); if (x) x.onclick = fn; };
      on('[data-open]', () => open(id));
      on('[data-status]', () => { const m = markupById(prop(), id); if (m && setMarkupStatus(prop(), id, m.status === 'done' ? 'open' : 'done')) { touch(); renderList(); } });
      on('[data-rename]', () => { renaming = id; confirmDelete = null; renderList(); const f = listEl.querySelector('.mk-name'); if (f) { f.focus(); f.select(); } });
      on('[data-delete]', () => { confirmDelete = id; renderList(); });
      on('[data-keep]', () => { confirmDelete = null; renderList(); });
      on('[data-really]', () => {
        confirmDelete = null;
        if (editor && editor.markupId === id) closeEditor(false);
        const taken = deleteMarkup(prop(), id);
        if (!taken) return;
        did({ t: 'ink-', items: [{ whole: clone(taken.markup), index: taken.index }] });
        saved();
      });
      on('[data-picture]', () => savePicture(id));
      const save = () => { const f = r.querySelector('.mk-name'); if (renaming !== id || !f) return; renaming = null; if (renameMarkup(prop(), id, f.value)) touch(); refresh(); };
      on('[data-save]', save);
      const f = r.querySelector('.mk-name');
      if (f) f.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') save(); else if (e.key === 'Escape') { renaming = null; renderList(); } };
    });
  }

  // ---------- a picture of a markup ----------
  // The page draws its own view (`marks` false) and this layer's ink and note numbers go on
  // top (`marks` true): the same picture twice, with and without the marks.
  async function picture(id, marks = true) {
    const m = markupById(prop(), id);
    if (!m || m.on !== host.kind) throw new Error('That markup is no longer here.');
    return host.picture(m, marks);
  }
  async function savePicture(id) {
    if (busyPicture) return;
    busyPicture = true;
    try {
      const m = markupById(prop(), id);
      const c = await picture(id, true);
      const blob = await new Promise(resolve => c.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('The picture could not be made at this size.');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = ((prop().name || 'property') + ' ' + markupTitle(m)).replace(/[^\w.-]+/g, '-').toLowerCase() + '.png';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    } catch (err) { host.toast('The picture was not saved: ' + String(err.message || err), 'error'); }
    finally { busyPicture = false; }
  }

  // ---------- on and off ----------
  function setOn(on) {
    on = !!on;
    if (S.on === on) { renderBar(); return; }
    if (stroke) finish(false);    // a press in progress is kept, not dropped
    S.on = on;
    stroke = null; hoverAt = null; spaceDown = false; fingers.clear(); ignored.clear(); penDown = false;
    wrap.classList.remove('mk-space');
    if (!on) { closeEditor(true); listEl.hidden = true; host.hint(''); }
    else listEl.hidden = !S.list;
    renderBar();
    if (on && !listEl.hidden) renderList();
    refresh();
    liveDirty = true;
    host.changed(S.on);
  }

  wrap.addEventListener('pointerdown', onDown, true);
  wrap.addEventListener('pointermove', onMove, true);
  wrap.addEventListener('pointerup', onUp, true);
  wrap.addEventListener('pointercancel', onUp, true);
  wrap.addEventListener('wheel', onWheel, { capture: true, passive: false });
  window.addEventListener('blur', onBlur);
  surface.addEventListener('pointerleave', onLeave);
  surface.addEventListener('touchstart', onTouchStart, { passive: false });
  raf = requestAnimationFrame(loop);
  // The mode a rebuilt page comes back in.
  if (S.on && now() - S.leftAt < REBUILD_MS) { S.on = false; setOn(true); } else { S.on = false; renderBar(); frame(); }

  return {
    isOn: () => S.on,
    setOn,
    toggle: () => setOn(!S.on),
    // Does one finger draw right now? The page then leaves a single finger alone.
    fingerDraws,
    // Does markup mode take a click on the view (so the page does not select or place)?
    takesClicks: () => S.on,
    key, keyUp, frame, refresh, picture,
    // One step back or forward through this visit's marks (the page's own UNDO and REDO come here
    // while markup mode is on).
    undo: () => step(true), redo: () => step(false),
    count: () => (prop().markups || []).filter(m => m.on === host.kind).length,
    open,
    // The marks of one markup onto a 2D context whose (x, y) px `map` gives: a saved picture.
    paint(ctx, markup, map, u, place, r = 13) {
      for (const s of markup.strokes) drawStroke(ctx, s, map, u);
      const color = (markup.strokes[0] && markup.strokes[0].color) || MARKUP_COLORS[0];
      for (const n of markup.notes) { const at = place(n); if (at) drawNoteDisc(ctx, at[0], at[1], n.n, color, r); }
    },
    state: () => ({ on: S.on, tool: S.tool, color: S.color, size: S.size, activeId: S.activeId, fingerDraws: fingerDraws(), penSeen, shown: S.shown, undo: undo.length, redo: redo.length }),
    dispose() {
      if (gone) return;
      if (stroke) finish(false);    // the page is being rebuilt mid-press: what was drawn is kept
      closeEditor(true);
      gone = true;
      S.leftAt = now();
      cancelAnimationFrame(raf);
      wrap.removeEventListener('pointerdown', onDown, true);
      wrap.removeEventListener('pointermove', onMove, true);
      wrap.removeEventListener('pointerup', onUp, true);
      wrap.removeEventListener('pointercancel', onUp, true);
      wrap.removeEventListener('wheel', onWheel, { capture: true });
      window.removeEventListener('blur', onBlur);
      surface.removeEventListener('pointerleave', onLeave);
      surface.removeEventListener('touchstart', onTouchStart);
      wrap.classList.remove('mk-on', 'mk-space');
      delete wrap.dataset.mkTool;
      for (const e of [layerEl, notesEl, chip, bar, listEl]) e.remove();
    },
  };
}

// For tests: forget the kept mode and whether a pen has been seen.
export function resetMarkupLayer() { Object.assign(kept.model, fresh()); Object.assign(kept.plan, fresh()); penSeen = false; }
