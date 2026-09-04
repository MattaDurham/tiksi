// Floorplan editor: trace walls over an uploaded plan image, place doors/windows,
// outline rooms, calibrate real-world scale. Canvas-based; all model coords in meters.
// Rendering follows drafting conventions: hatched cut walls with a crisp outline, door
// swings, glazing lines, dimension strings with ticks, rulers, a north arrow and a scale bar.

import {
  ws, activeProperty, uid, touch, fmtLen, parseLen, fmtArea, polyArea,
  escapeHtml, itemById,
} from './store.js';
import { materialSelectHtml } from './materials.js';
import { icon } from './icons.js';

const PRESETS = {
  interior: { thickness: 0.114, material: 'mat-drywall' },   // 4.5 in stud wall
  exterior: { thickness: 0.165, material: 'mat-fiber' },     // 6.5 in
};
const DOOR_DEFAULT = { width: 0.813, height: 2.032 };         // 32 x 80 in
const WINDOW_DEFAULT = { width: 0.914, height: 1.219, sill: 0.762 }; // 36 x 48, sill 30

const RULER = 22;                 // px; rulers sit along the top and left canvas edges
const FONT = 'ui-monospace, "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace';
const MOD = /Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘' : '^';
// Palette for the drawing surface (kept in sync with css/console.css tokens by hand:
// canvas cannot read CSS variables cheaply every frame).
const C = {
  bg: '#0a0e12',
  gridMinor: 'rgba(255,255,255,0.032)',
  gridMajor: 'rgba(255,255,255,0.075)',
  axis: 'rgba(125,155,180,0.28)',
  wallLine: 'rgba(236,241,246,0.78)',
  ink: '#e9eef3',
  dim: '#8f9ca8',
  faint: '#5d6a76',
  accent: '#e8973a',
  cyan: '#5fb3c9',
  door: '#d9b47c',
  dimLine: 'rgba(160,176,190,0.85)',
  hover: 'rgba(255,255,255,0.6)',
  rulerBg: 'rgba(12,17,22,0.96)',
  rulerLine: 'rgba(255,255,255,0.12)',
  rulerText: '#7c8995',
};

// Module-persistent editor state (survives view switches).
const viewByProp = {};
let tool = 'select';
let wallPreset = 'interior';
let snapOn = true;
let dimsOn = false;

let el = null, canvas = null, ctx = null, wrapEl = null, inspEl = null, hintEl = null, badgeEl = null;
let raf = 0;
let prop = null;
let vs = null; // {zoom, panX, panY}
let selection = null;        // {kind, id}
let hover = null;            // hit under the cursor (select tool only)
let drawing = null;          // {last:[x,y]}
let roomDraft = null;        // {pts:[[x,y],...]}
let calib = null;            // {a:[x,y], b:[x,y]|null}
let hoverPt = null;          // last cursor world pos
let drag = null;             // active drag descriptor
let spaceDown = false;
let undoStack = [], redoStack = [];
const hatchCache = new Map(); // material colour -> CanvasPattern (per device pixel ratio)

function dpr() { return window.devicePixelRatio || 1; }
function w2s(p) { return [(p[0] - vs.panX) * vs.zoom, (p[1] - vs.panY) * vs.zoom]; }
function s2w(x, y) { return [x / vs.zoom + vs.panX, y / vs.zoom + vs.panY]; }
function rnd(v) { return Math.round(v * 200) / 200; } // 5 mm
function crisp(v) { const d = dpr(); return (Math.round(v * d) + 0.5) / d; }
function hexRgb(hex) {
  if (!hex || hex[0] !== '#') return [216, 212, 204];
  const h = hex.length === 4 ? '#' + hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3] : hex;
  const n = parseInt(h.slice(1, 7), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function hexA(hex, a) {
  const [r, g, b] = hexRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}
function matColor(id, fallback) {
  const m = ws.data.materials.find(m => m.id === id);
  return (m && m.color) || fallback || '#d8d4cc';
}

function bounds() {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const eat = (x, y) => { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); };
  for (const w of prop.walls) { eat(w.ax, w.ay); eat(w.bx, w.by); }
  for (const r of prop.rooms) for (const [x, y] of r.pts) eat(x, y);
  const pl = prop.plan;
  if (pl && pl.img) { eat(pl.offsetX, pl.offsetY); eat(pl.offsetX + pl.imgW * pl.mPerPx, pl.offsetY + pl.imgH * pl.mPerPx); }
  if (minX === Infinity) return { minX: -6, minY: -4, maxX: 6, maxY: 4 };
  return { minX, minY, maxX, maxY };
}

function fitView() {
  const b = bounds();
  // Fit inside the area right of / below the rulers, with a margin for dimension strings.
  const w = wrapEl.clientWidth - RULER, h = wrapEl.clientHeight - RULER;
  const bw = Math.max(b.maxX - b.minX, 1), bh = Math.max(b.maxY - b.minY, 1);
  vs.zoom = Math.min(w / (bw * 1.22), h / (bh * 1.22), 250);
  vs.panX = b.minX - (w / vs.zoom - bw) / 2 - RULER / vs.zoom;
  vs.panY = b.minY - (h / vs.zoom - bh) / 2 - RULER / vs.zoom;
}

// ---------- undo ----------
function snapshot() { return JSON.stringify({ walls: prop.walls, openings: prop.openings, rooms: prop.rooms }); }
function pushUndo() { undoStack.push(snapshot()); if (undoStack.length > 80) undoStack.shift(); redoStack = []; }
function applySnap(s) {
  const d = JSON.parse(s);
  prop.walls = d.walls; prop.openings = d.openings; prop.rooms = d.rooms;
  selection = null; hover = null; touch(); renderInspector();
}
function undo() { if (!undoStack.length) return; redoStack.push(snapshot()); applySnap(undoStack.pop()); }
function redo() { if (!redoStack.length) return; undoStack.push(snapshot()); applySnap(redoStack.pop()); }

// ---------- snapping ----------
// Returns the snapped point; snapInfo (module state) records what it snapped to so the
// renderer can draw guides. Rules are unchanged: endpoint, then axis, then 15 degree angle.
let snapInfo = null;
function snapPoint(wx, wy, opts) {
  opts = opts || {};
  const tolW = 11 / vs.zoom;
  snapInfo = null;
  // Endpoint snap.
  let best = null, bestD = tolW;
  for (const w of prop.walls) {
    for (const p of [[w.ax, w.ay], [w.bx, w.by]]) {
      if (opts.excludeWall && opts.excludeWall === w.id) continue;
      const d = Math.hypot(p[0] - wx, p[1] - wy);
      if (d < bestD) { bestD = d; best = p; }
    }
  }
  if (best) { snapInfo = { kind: 'endpoint' }; return [best[0], best[1]]; }
  let x = wx, y = wy;
  if (snapOn && opts.from) {
    const [fx, fy] = opts.from;
    // Axis alignment.
    if (Math.abs(x - fx) < tolW) { x = fx; snapInfo = { kind: 'axis', axis: 'v', from: opts.from }; }
    else if (Math.abs(y - fy) < tolW) { y = fy; snapInfo = { kind: 'axis', axis: 'h', from: opts.from }; }
    else {
      // 15 degree angle snap.
      const ang = Math.atan2(y - fy, x - fx);
      const dist = Math.hypot(x - fx, y - fy);
      const snapAng = Math.round(ang / (Math.PI / 12)) * (Math.PI / 12);
      if (Math.abs(ang - snapAng) < 0.06) {
        x = fx + Math.cos(snapAng) * dist; y = fy + Math.sin(snapAng) * dist;
        snapInfo = { kind: 'angle', from: opts.from, ang: snapAng };
      }
    }
  }
  return [rnd(x), rnd(y)];
}

// ---------- hit testing ----------
function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const L2 = dx * dx + dy * dy;
  let t = L2 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  return { d: Math.hypot(px - (ax + dx * t), py - (ay + dy * t)), t };
}
function pointInPoly(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function openingPos(o) {
  const w = prop.walls.find(w => w.id === o.wallId);
  if (!w) return null;
  const L = Math.hypot(w.bx - w.ax, w.by - w.ay);
  const ux = (w.bx - w.ax) / (L || 1), uy = (w.by - w.ay) / (L || 1);
  const c = o.t * L;
  return { w, L, ux, uy, cx: w.ax + ux * c, cy: w.ay + uy * c };
}
function hitTest(wx, wy) {
  // Openings first.
  for (const o of prop.openings) {
    const p = openingPos(o);
    if (!p) continue;
    const along = Math.abs((wx - p.cx) * p.ux + (wy - p.cy) * p.uy);
    const across = Math.abs((wx - p.cx) * -p.uy + (wy - p.cy) * p.ux);
    if (along < o.width / 2 + 4 / vs.zoom && across < (p.w.thickness / 2 + 8 / vs.zoom)) return { kind: 'opening', id: o.id };
  }
  // Selected wall endpoints.
  if (selection && selection.kind === 'wall') {
    const w = prop.walls.find(w => w.id === selection.id);
    if (w) {
      for (const [end, p] of [['a', [w.ax, w.ay]], ['b', [w.bx, w.by]]]) {
        if (Math.hypot(...[p[0] - wx, p[1] - wy]) * vs.zoom < 9) return { kind: 'handle', id: w.id, end };
      }
    }
  }
  // Walls.
  for (let i = prop.walls.length - 1; i >= 0; i--) {
    const w = prop.walls[i];
    const { d } = distToSeg(wx, wy, w.ax, w.ay, w.bx, w.by);
    if (d < Math.max(w.thickness / 2 + 3 / vs.zoom, 6 / vs.zoom)) return { kind: 'wall', id: w.id };
  }
  // Rooms.
  for (const r of prop.rooms) if (pointInPoly(wx, wy, r.pts)) return { kind: 'room', id: r.id };
  // Underlay.
  const pl = prop.plan;
  if (pl && pl.img &&
      wx >= pl.offsetX && wx <= pl.offsetX + pl.imgW * pl.mPerPx &&
      wy >= pl.offsetY && wy <= pl.offsetY + pl.imgH * pl.mPerPx) return { kind: 'underlay' };
  return null;
}

// ---------- mutations ----------
function addWall(a, b) {
  pushUndo();
  const p = PRESETS[wallPreset];
  const w = { id: uid('w'), ax: a[0], ay: a[1], bx: b[0], by: b[1], thickness: p.thickness, height: null, material: p.material };
  prop.walls.push(w);
  touch();
  if (!selection) renderInspector();
  return w;
}
function addOpening(wallId, t, type) {
  pushUndo();
  const def = type === 'door' ? DOOR_DEFAULT : WINDOW_DEFAULT;
  const o = Object.assign({ id: uid('o'), wallId, t, type }, def);
  prop.openings.push(o);
  selection = { kind: 'opening', id: o.id };
  touch(); renderInspector();
}
function deleteSelection() {
  if (!selection) return;
  pushUndo();
  if (selection.kind === 'wall') {
    prop.walls = prop.walls.filter(w => w.id !== selection.id);
    prop.openings = prop.openings.filter(o => o.wallId !== selection.id);
  } else if (selection.kind === 'opening') {
    prop.openings = prop.openings.filter(o => o.id !== selection.id);
  } else if (selection.kind === 'room') {
    prop.rooms = prop.rooms.filter(r => r.id !== selection.id);
  } else if (selection.kind === 'underlay') {
    prop.plan = null;
  }
  selection = null; hover = null;
  touch(); renderInspector();
}

// ---------- underlay upload ----------
function uploadUnderlay(file) {
  if (!file) return;
  if (file.type === 'application/pdf') {
    alert('PDF import is on the roadmap. For now, export the plan page as a PNG or JPG image and upload that.');
    return;
  }
  const img = new Image();
  img.onload = () => {
    const MAX = 2000;
    const scale = Math.min(1, MAX / Math.max(img.width, img.height));
    const cw = Math.round(img.width * scale), ch = Math.round(img.height * scale);
    const c = document.createElement('canvas');
    c.width = cw; c.height = ch;
    c.getContext('2d').drawImage(img, 0, 0, cw, ch);
    const isPng = file.type === 'image/png';
    const dataUrl = isPng ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.85);
    prop.plan = {
      img: dataUrl, imgW: cw, imgH: ch,
      mPerPx: 18 / cw,           // assume ~18 m wide until calibrated
      opacity: 0.55, offsetX: 0, offsetY: 0, calibrated: false,
    };
    selection = { kind: 'underlay' };
    tool = 'calibrate'; calib = null;
    fitView();
    touch(); renderToolCol(); renderInspector();
  };
  img.onerror = () => alert('Could not read that image file.');
  img.src = URL.createObjectURL(file);
}

// ---------- rendering: grid, hatch, text helpers ----------
const IMPERIAL_STEPS = [0.0762, 0.1524, 0.3048, 0.6096, 1.524, 3.048, 6.096, 15.24];
const IMPERIAL_DIV = [3, 2, 4, 4, 5, 5, 4, 5];   // 1in, 3in, 3in, 6in, 1ft, 2ft, 5ft, 10ft minors
const METRIC_STEPS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10];
const METRIC_DIV = [5, 5, 5, 5, 5, 4, 5, 5];
function gridSteps() {
  const imperial = ws.data.settings.units === 'imperial';
  const steps = imperial ? IMPERIAL_STEPS : METRIC_STEPS;
  const divs = imperial ? IMPERIAL_DIV : METRIC_DIV;
  for (let i = 0; i < steps.length; i++) if (steps[i] * vs.zoom >= 34) return { major: steps[i], minor: steps[i] / divs[i] };
  const i = steps.length - 1;
  return { major: steps[i], minor: steps[i] / divs[i] };
}
function gridStep() { return gridSteps().major; }

// 45 degree hatch in the material colour, seamless, aligned to the model (not the screen)
// so walls keep their texture while panning. Cached per colour and device pixel ratio.
function hatchPattern(color) {
  const d = dpr();
  const key = color + '@' + d;
  let pat = hatchCache.get(key);
  if (!pat) {
    const S = 8, D = S * d;
    const c = document.createElement('canvas');
    c.width = D; c.height = D;
    const g = c.getContext('2d');
    g.strokeStyle = hexA(color, 0.42);
    g.lineWidth = 1 * d;
    g.beginPath();
    // x + y = D through the tile plus the two neighbours through the corners keeps the diagonal continuous.
    g.moveTo(0, D); g.lineTo(D, 0);
    g.moveTo(-D / 2, D / 2); g.lineTo(D / 2, -D / 2);
    g.moveTo(D / 2, 3 * D / 2); g.lineTo(3 * D / 2, D / 2);
    g.stroke();
    pat = ctx.createPattern(c, 'repeat');
    pat._size = S; pat._d = d;
    hatchCache.set(key, pat);
  }
  if (pat.setTransform) {
    const S = pat._size;
    const tx = ((-vs.panX * vs.zoom) % S + S) % S, ty = ((-vs.panY * vs.zoom) % S + S) % S;
    pat.setTransform(new DOMMatrix([1 / pat._d, 0, 0, 1 / pat._d, tx, ty]));
  }
  return pat;
}

function roundRect(x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Rounded label pill centred on (x, y).
function pill(text, x, y, color, opts) {
  opts = opts || {};
  const size = opts.size || 10.5;
  ctx.font = `${opts.weight || 600} ${size}px ${FONT}`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const w = ctx.measureText(text).width + 14, h = size + 9;
  roundRect(x - w / 2, y - h / 2, w, h, h / 2);
  ctx.fillStyle = opts.bg || 'rgba(10,14,18,0.92)';
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = opts.stroke || hexA(color, 0.55);
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.fillText(text, x, y + 0.5);
  ctx.textBaseline = 'alphabetic';
  return { w, h };
}

function tracePoly(pts) {
  ctx.beginPath();
  pts.forEach((c, i) => i ? ctx.lineTo(c[0], c[1]) : ctx.moveTo(c[0], c[1]));
  ctx.closePath();
}

// At an L-corner two centreline rectangles leave a notch on the outside; extending each wall
// by the neighbour's half thickness at a shared endpoint fills it (drawing only, no data change).
function endExtension(wl, px, py) {
  let ext = 0;
  for (const o of prop.walls) {
    if (o === wl) continue;
    if ((Math.abs(o.ax - px) < 0.003 && Math.abs(o.ay - py) < 0.003) ||
        (Math.abs(o.bx - px) < 0.003 && Math.abs(o.by - py) < 0.003)) ext = Math.max(ext, o.thickness / 2);
  }
  return ext;
}

function wallPoly(wl) {
  const L = Math.hypot(wl.bx - wl.ax, wl.by - wl.ay);
  if (L < 0.001) return null;
  const ux = (wl.bx - wl.ax) / L, uy = (wl.by - wl.ay) / L;
  const nx = -uy * wl.thickness / 2, ny = ux * wl.thickness / 2;
  const ea = endExtension(wl, wl.ax, wl.ay), eb = endExtension(wl, wl.bx, wl.by);
  const ax = wl.ax - ux * ea, ay = wl.ay - uy * ea, bx = wl.bx + ux * eb, by = wl.by + uy * eb;
  return {
    L, ux, uy, nx, ny,
    pts: [
      w2s([ax + nx, ay + ny]), w2s([bx + nx, by + ny]),
      w2s([bx - nx, by - ny]), w2s([ax - nx, ay - ny]),
    ],
  };
}

// ---------- rendering: main pass ----------
let underlayImg = null, underlayImgSrc = null;
function draw() {
  const w = wrapEl.clientWidth, h = wrapEl.clientHeight;
  if (!w || !h) return;
  const d = dpr();
  if (canvas.width !== Math.round(w * d) || canvas.height !== Math.round(h * d)) {
    canvas.width = Math.round(w * d); canvas.height = Math.round(h * d);
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
  }
  ctx.setTransform(d, 0, 0, d, 0, 0);
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, w, h);

  drawGrid(w, h);
  drawUnderlay();
  drawRooms();
  drawWalls();
  for (const o of prop.openings) drawOpening(o);
  drawRoomLabels();
  drawDims();
  drawDrafts(w, h);
  drawSelectionHandles();
  drawVignette(w, h);
  drawRulers(w, h);
  drawHud(w, h);
}

function drawGrid(w, h) {
  const { major, minor } = gridSteps();
  const minorPx = minor * vs.zoom;
  const fade = Math.max(0, Math.min(1, (minorPx - 5) / 22));
  ctx.lineWidth = 1;
  if (fade > 0) {
    ctx.strokeStyle = `rgba(255,255,255,${(0.034 * fade).toFixed(3)})`;
    ctx.beginPath();
    const x0 = Math.floor(vs.panX / minor) * minor, y0 = Math.floor(vs.panY / minor) * minor;
    for (let x = x0; (x - vs.panX) * vs.zoom < w; x += minor) { const sx = crisp((x - vs.panX) * vs.zoom); ctx.moveTo(sx, 0); ctx.lineTo(sx, h); }
    for (let y = y0; (y - vs.panY) * vs.zoom < h; y += minor) { const sy = crisp((y - vs.panY) * vs.zoom); ctx.moveTo(0, sy); ctx.lineTo(w, sy); }
    ctx.stroke();
  }
  ctx.strokeStyle = C.gridMajor;
  ctx.beginPath();
  const X0 = Math.floor(vs.panX / major) * major, Y0 = Math.floor(vs.panY / major) * major;
  for (let x = X0; (x - vs.panX) * vs.zoom < w; x += major) { const sx = crisp((x - vs.panX) * vs.zoom); ctx.moveTo(sx, 0); ctx.lineTo(sx, h); }
  for (let y = Y0; (y - vs.panY) * vs.zoom < h; y += major) { const sy = crisp((y - vs.panY) * vs.zoom); ctx.moveTo(0, sy); ctx.lineTo(w, sy); }
  ctx.stroke();
  // Origin axes.
  ctx.strokeStyle = C.axis;
  ctx.beginPath();
  const ox = crisp(-vs.panX * vs.zoom), oy = crisp(-vs.panY * vs.zoom);
  ctx.moveTo(ox, 0); ctx.lineTo(ox, h); ctx.moveTo(0, oy); ctx.lineTo(w, oy);
  ctx.stroke();
}

function drawUnderlay() {
  const pl = prop.plan;
  if (!pl || !pl.img) return;
  if (underlayImgSrc !== pl.img) {
    underlayImg = new Image(); underlayImg.src = pl.img; underlayImgSrc = pl.img;
  }
  if (!(underlayImg.complete && underlayImg.naturalWidth)) return;
  const [sx, sy] = w2s([pl.offsetX, pl.offsetY]);
  const sw = pl.imgW * pl.mPerPx * vs.zoom, sh = pl.imgH * pl.mPerPx * vs.zoom;
  const sel = selection && selection.kind === 'underlay';
  const hov = hover && hover.kind === 'underlay';
  ctx.save();
  if (sel || hov) { ctx.shadowColor = sel ? 'rgba(232,151,58,0.45)' : 'rgba(255,255,255,0.25)'; ctx.shadowBlur = 22; }
  ctx.fillStyle = 'rgba(255,255,255,0.03)';
  ctx.fillRect(sx, sy, sw, sh);
  ctx.restore();
  ctx.globalAlpha = pl.opacity;
  ctx.drawImage(underlayImg, sx, sy, sw, sh);
  ctx.globalAlpha = 1;
  ctx.lineWidth = sel ? 1.5 : 1;
  ctx.strokeStyle = sel ? C.accent : (hov ? C.hover : 'rgba(255,255,255,0.12)');
  ctx.setLineDash(sel ? [6, 4] : []);
  ctx.strokeRect(crisp(sx), crisp(sy), sw, sh);
  ctx.setLineDash([]);
  if (sel) {
    // corner brackets
    const k = 10;
    ctx.beginPath();
    for (const [cx, cy, dx, dy] of [[sx, sy, 1, 1], [sx + sw, sy, -1, 1], [sx, sy + sh, 1, -1], [sx + sw, sy + sh, -1, -1]]) {
      ctx.moveTo(cx + dx * k, cy); ctx.lineTo(cx, cy); ctx.lineTo(cx, cy + dy * k);
    }
    ctx.lineWidth = 2; ctx.stroke();
  }
}

function roomCentroid(r) {
  let cx = 0, cy = 0;
  for (const p of r.pts) { cx += p[0]; cy += p[1]; }
  return [cx / r.pts.length, cy / r.pts.length];
}

function drawRooms() {
  for (const r of prop.rooms) {
    if (r.pts.length < 3) continue;
    const col = matColor(r.material, '#5fb3c9');
    const sel = selection && selection.kind === 'room' && selection.id === r.id;
    const hov = hover && hover.kind === 'room' && hover.id === r.id;
    const c = w2s(roomCentroid(r));
    let rad = 1;
    for (const p of r.pts) { const s = w2s(p); rad = Math.max(rad, Math.hypot(s[0] - c[0], s[1] - c[1])); }
    tracePoly(r.pts.map(w2s));
    const g = ctx.createRadialGradient(c[0], c[1], 0, c[0], c[1], rad * 1.1);
    g.addColorStop(0, hexA(col, sel ? 0.30 : hov ? 0.22 : 0.17));
    g.addColorStop(1, hexA(col, sel ? 0.12 : hov ? 0.08 : 0.05));
    ctx.fillStyle = g;
    ctx.fill();
    ctx.lineWidth = sel ? 1.6 : 1;
    ctx.strokeStyle = sel ? C.accent : hov ? C.hover : hexA(col, 0.45);
    ctx.setLineDash(sel ? [] : [5, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

function drawRoomLabels() {
  for (const r of prop.rooms) {
    if (r.pts.length < 3) continue;
    const col = matColor(r.material, '#5fb3c9');
    const sel = selection && selection.kind === 'room' && selection.id === r.id;
    const s = w2s(roomCentroid(r));
    const name = (r.name || 'ROOM').toUpperCase();
    ctx.font = `700 11px ${FONT}`;
    if ('letterSpacing' in ctx) ctx.letterSpacing = '1.5px';
    const tw = ctx.measureText(name).width;
    // swatch dot + name on one line, area beneath
    const x0 = s[0] - (tw + 12) / 2;
    ctx.beginPath(); ctx.arc(x0 + 3.5, s[1] - 4, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = col; ctx.fill();
    ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.stroke();
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillText(name, x0 + 12 + 0.5, s[1] - 4 + 1);
    ctx.fillStyle = sel ? C.accent : C.ink;
    ctx.fillText(name, x0 + 12, s[1] - 4);
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    ctx.font = `10px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillStyle = sel ? hexA(C.accent, 0.85) : C.dim;
    ctx.fillText(fmtArea(polyArea(r.pts)), s[0], s[1] + 10);
    ctx.textBaseline = 'alphabetic';
  }
}

function drawWalls() {
  const polys = [];
  for (const wl of prop.walls) { const p = wallPoly(wl); if (p) polys.push([wl, p]); }
  // Thin walls first, thick walls last: at a T-junction the partition's end overlaps the
  // exterior wall, and the later (thicker) fill hides that overlap instead of showing a seam.
  polys.sort((a, b) => a[0].thickness - b[0].thickness);
  // 1. Outline first, under everything: each rectangle stroked wide. The fills that follow
  //    cover the inner half of every stroke, so shared corners and T-junctions merge cleanly.
  ctx.lineJoin = 'miter';
  ctx.lineWidth = 2.4;
  ctx.strokeStyle = C.wallLine;
  for (const [, p] of polys) { tracePoly(p.pts); ctx.stroke(); }
  // 2. Material-tinted solid fill.
  for (const [wl, p] of polys) {
    tracePoly(p.pts);
    ctx.fillStyle = hexA(matColor(wl.material), 0.36);
    ctx.fill();
  }
  // 3. Cut-wall hatch on top of the fill.
  if (vs.zoom > 12) {
    for (const [wl, p] of polys) {
      tracePoly(p.pts);
      ctx.fillStyle = hatchPattern(matColor(wl.material));
      ctx.fill();
    }
  }
  // 4. Hover and selection emphasis.
  for (const [wl, p] of polys) {
    const sel = selection && selection.kind === 'wall' && selection.id === wl.id;
    const hov = !sel && hover && hover.kind === 'wall' && hover.id === wl.id;
    if (!sel && !hov) continue;
    tracePoly(p.pts);
    if (sel) {
      ctx.save();
      ctx.shadowColor = 'rgba(232,151,58,0.75)'; ctx.shadowBlur = 16;
      ctx.fillStyle = 'rgba(232,151,58,0.16)'; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = C.accent; ctx.stroke();
      ctx.restore();
    } else {
      ctx.lineWidth = 1.5; ctx.strokeStyle = C.hover; ctx.stroke();
    }
  }
}

function drawOpening(o) {
  const p = openingPos(o);
  if (!p) return;
  const { w, ux, uy } = p;
  const sel = selection && selection.kind === 'opening' && selection.id === o.id;
  const hov = !sel && hover && hover.kind === 'opening' && hover.id === o.id;
  const half = o.width / 2;
  const nx = -uy, ny = ux;
  const th = w.thickness / 2;
  // Blank the wall band (fill, hatch and the outline just outside it).
  const out = th + 1.8 / vs.zoom;
  tracePoly([
    w2s([p.cx - ux * half + nx * out, p.cy - uy * half + ny * out]),
    w2s([p.cx + ux * half + nx * out, p.cy + uy * half + ny * out]),
    w2s([p.cx + ux * half - nx * out, p.cy + uy * half - ny * out]),
    w2s([p.cx - ux * half - nx * out, p.cy - uy * half - ny * out]),
  ]);
  ctx.fillStyle = C.bg;
  ctx.fill();

  const col = sel ? C.accent : hov ? '#ffffff' : (o.type === 'door' ? C.door : C.cyan);
  ctx.lineCap = 'butt';
  // Jamb ticks across the wall thickness.
  ctx.strokeStyle = sel ? C.accent : C.wallLine;
  ctx.lineWidth = 1.4;
  for (const s of [-half, half]) {
    const a = w2s([p.cx + ux * s + nx * th, p.cy + uy * s + ny * th]);
    const b = w2s([p.cx + ux * s - nx * th, p.cy + uy * s - ny * th]);
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
  }
  if (o.type === 'door') {
    // Hinge at -half end; solid leaf + quarter-circle swing.
    const hx = p.cx - ux * half, hy = p.cy - uy * half;
    const hs = w2s([hx, hy]), ls = w2s([hx + nx * o.width, hy + ny * o.width]);
    const a0 = Math.atan2(ny, nx), a1 = Math.atan2(uy, ux);
    ctx.save();
    if (sel) { ctx.shadowColor = 'rgba(232,151,58,0.7)'; ctx.shadowBlur = 10; }
    ctx.strokeStyle = hexA(col, 0.8);
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(hs[0], hs[1], o.width * vs.zoom, a0, a1, a0 > a1); ctx.stroke();
    ctx.strokeStyle = col;
    ctx.lineWidth = Math.max(2.5, Math.min(5, 0.045 * vs.zoom));
    ctx.beginPath(); ctx.moveTo(hs[0], hs[1]); ctx.lineTo(ls[0], ls[1]); ctx.stroke();
    ctx.restore();
    // Threshold: a hairline across the opening at the wall centreline.
    const t0 = w2s([p.cx - ux * half, p.cy - uy * half]), t1 = w2s([p.cx + ux * half, p.cy + uy * half]);
    ctx.strokeStyle = hexA(col, 0.35); ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(t0[0], t0[1]); ctx.lineTo(t1[0], t1[1]); ctx.stroke();
    ctx.setLineDash([]);
  } else {
    // Window: frame across the wall plus two glazing lines.
    const fr = th * 0.92;
    tracePoly([
      w2s([p.cx - ux * half + nx * fr, p.cy - uy * half + ny * fr]),
      w2s([p.cx + ux * half + nx * fr, p.cy + uy * half + ny * fr]),
      w2s([p.cx + ux * half - nx * fr, p.cy + uy * half - ny * fr]),
      w2s([p.cx - ux * half - nx * fr, p.cy - uy * half - ny * fr]),
    ]);
    ctx.fillStyle = hexA(col, 0.10); ctx.fill();
    ctx.strokeStyle = sel ? C.accent : C.wallLine; ctx.lineWidth = 1; ctx.stroke();
    ctx.save();
    if (sel) { ctx.shadowColor = 'rgba(232,151,58,0.7)'; ctx.shadowBlur = 10; }
    ctx.strokeStyle = col;
    ctx.lineWidth = 1.3;
    for (const off of [-th * 0.3, th * 0.3]) {
      const a = w2s([p.cx - ux * half + nx * off, p.cy - uy * half + ny * off]);
      const b = w2s([p.cx + ux * half + nx * off, p.cy + uy * half + ny * off]);
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    }
    ctx.restore();
  }
}

// A dimension string between two world points with extension lines, ticks and a label pill.
function dimString(a, b, color, opts) {
  opts = opts || {};
  const A = w2s(a), B = w2s(b);
  const dx = B[0] - A[0], dy = B[1] - A[1];
  const L = Math.hypot(dx, dy);
  if (L < 2) return;
  const ux = dx / L, uy = dy / L;
  const side = opts.side || 1;
  const nx = -uy * side, ny = ux * side;
  const gap = opts.gap || 6, off = opts.offset || 26, ext = off + 6;
  ctx.lineWidth = 1;
  ctx.strokeStyle = color;
  ctx.setLineDash([]);
  ctx.beginPath();
  // extension lines
  ctx.moveTo(A[0] + nx * gap, A[1] + ny * gap); ctx.lineTo(A[0] + nx * ext, A[1] + ny * ext);
  ctx.moveTo(B[0] + nx * gap, B[1] + ny * gap); ctx.lineTo(B[0] + nx * ext, B[1] + ny * ext);
  // dimension line
  const D1 = [A[0] + nx * off, A[1] + ny * off], D2 = [B[0] + nx * off, B[1] + ny * off];
  ctx.moveTo(D1[0], D1[1]); ctx.lineTo(D2[0], D2[1]);
  ctx.stroke();
  // architectural ticks: short 45 degree slashes at the ends
  const tx = (ux + nx) * 0.7071 * 4.5, ty = (uy + ny) * 0.7071 * 4.5;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(D1[0] - tx, D1[1] - ty); ctx.lineTo(D1[0] + tx, D1[1] + ty);
  ctx.moveTo(D2[0] - tx, D2[1] - ty); ctx.lineTo(D2[0] + tx, D2[1] + ty);
  ctx.stroke();
  const text = opts.text || fmtLen(Math.hypot(b[0] - a[0], b[1] - a[1]));
  pill(text, (D1[0] + D2[0]) / 2, (D1[1] + D2[1]) / 2, color, { size: opts.size || 10 });
}

function dimSideFor(wl) {
  // Put the string on the side of the wall facing away from the plan's centre.
  const b = bounds();
  const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
  const mx = (wl.ax + wl.bx) / 2, my = (wl.ay + wl.by) / 2;
  const L = Math.hypot(wl.bx - wl.ax, wl.by - wl.ay) || 1;
  const nx = -(wl.by - wl.ay) / L, ny = (wl.bx - wl.ax) / L;
  return (nx * (mx - cx) + ny * (my - cy)) < 0 ? -1 : 1;
}

function drawDims() {
  for (const wl of prop.walls) {
    const sel = selection && selection.kind === 'wall' && selection.id === wl.id;
    if (!sel && !dimsOn) continue;
    const L = Math.hypot(wl.bx - wl.ax, wl.by - wl.ay);
    if (L < 0.01) continue;
    const gapPx = wl.thickness / 2 * vs.zoom + 5;
    dimString([wl.ax, wl.ay], [wl.bx, wl.by], sel ? C.accent : C.dimLine, {
      side: dimSideFor(wl), gap: gapPx, offset: gapPx + 18, size: sel ? 10.5 : 9.5,
    });
  }
}

function crossGuides(pt, w, h, color) {
  const s = w2s(pt);
  ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.setLineDash([3, 5]);
  ctx.beginPath();
  ctx.moveTo(crisp(s[0]), RULER); ctx.lineTo(crisp(s[0]), h);
  ctx.moveTo(RULER, crisp(s[1])); ctx.lineTo(w, crisp(s[1]));
  ctx.stroke();
  ctx.setLineDash([]);
}

function snapMarker(pt) {
  const s = w2s(pt);
  ctx.lineWidth = 1.5; ctx.strokeStyle = C.accent;
  if (snapInfo && snapInfo.kind === 'endpoint') {
    ctx.beginPath(); ctx.arc(s[0], s[1], 6, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = C.accent; ctx.beginPath(); ctx.arc(s[0], s[1], 2, 0, Math.PI * 2); ctx.fill();
  } else {
    ctx.beginPath();
    ctx.moveTo(s[0] - 5, s[1]); ctx.lineTo(s[0] + 5, s[1]);
    ctx.moveTo(s[0], s[1] - 5); ctx.lineTo(s[0], s[1] + 5);
    ctx.stroke();
  }
  if (snapInfo && (snapInfo.kind === 'axis' || snapInfo.kind === 'angle')) {
    // A long guide through the anchor and the snapped point shows what we aligned to.
    const f = w2s(snapInfo.from);
    const dx = s[0] - f[0], dy = s[1] - f[1], L = Math.hypot(dx, dy) || 1;
    const ex = dx / L * 4000, ey = dy / L * 4000;
    ctx.strokeStyle = 'rgba(232,151,58,0.28)'; ctx.lineWidth = 1; ctx.setLineDash([2, 6]);
    ctx.beginPath(); ctx.moveTo(f[0] - ex, f[1] - ey); ctx.lineTo(s[0] + ex, s[1] + ey); ctx.stroke();
    ctx.setLineDash([]);
  }
}

function drawDrafts(w, h) {
  if (drawing && hoverPt) {
    const pt = snapPoint(hoverPt[0], hoverPt[1], { from: drawing.last });
    const a = w2s(drawing.last), b = w2s(pt);
    crossGuides(pt, w, h, 'rgba(232,151,58,0.18)');
    // Ghost of the wall about to be placed.
    const th = PRESETS[wallPreset].thickness / 2;
    const L = Math.hypot(pt[0] - drawing.last[0], pt[1] - drawing.last[1]);
    if (L > 0.01) {
      const ux = (pt[0] - drawing.last[0]) / L, uy = (pt[1] - drawing.last[1]) / L;
      const nx = -uy * th, ny = ux * th;
      tracePoly([
        w2s([drawing.last[0] + nx, drawing.last[1] + ny]), w2s([pt[0] + nx, pt[1] + ny]),
        w2s([pt[0] - nx, pt[1] - ny]), w2s([drawing.last[0] - nx, drawing.last[1] - ny]),
      ]);
      ctx.fillStyle = 'rgba(232,151,58,0.14)'; ctx.fill();
    }
    ctx.strokeStyle = C.accent;
    ctx.lineWidth = 2;
    ctx.setLineDash([7, 5]);
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = C.accent;
    ctx.beginPath(); ctx.arc(a[0], a[1], 3.5, 0, Math.PI * 2); ctx.fill();
    snapMarker(pt);
    if (L > 0.01) {
      dimString(drawing.last, pt, C.accent, { side: dimSideFor({ ax: drawing.last[0], ay: drawing.last[1], bx: pt[0], by: pt[1] }), gap: th * vs.zoom + 5, offset: th * vs.zoom + 22 });
    }
  } else if (tool === 'wall' && hoverPt && !drag) {
    const pt = snapPoint(hoverPt[0], hoverPt[1], {});
    crossGuides(pt, w, h, 'rgba(232,151,58,0.12)');
    snapMarker(pt);
  }
  if (roomDraft && roomDraft.pts.length) {
    const pts = roomDraft.pts.map(w2s);
    let end = null;
    if (hoverPt) {
      const last = roomDraft.pts[roomDraft.pts.length - 1];
      const sp = snapPoint(hoverPt[0], hoverPt[1], { from: last });
      end = sp;
      crossGuides(sp, w, h, 'rgba(95,179,201,0.18)');
    }
    ctx.beginPath();
    pts.forEach((s, i) => i ? ctx.lineTo(s[0], s[1]) : ctx.moveTo(s[0], s[1]));
    if (end) { const s = w2s(end); ctx.lineTo(s[0], s[1]); }
    if (pts.length >= 2) {
      ctx.closePath();
      ctx.fillStyle = 'rgba(95,179,201,0.10)'; ctx.fill();
    }
    ctx.strokeStyle = C.cyan; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
    for (const s of pts) {
      ctx.fillStyle = C.cyan; ctx.beginPath(); ctx.arc(s[0], s[1], 3, 0, Math.PI * 2); ctx.fill();
    }
    // First point is the close target: ring it.
    ctx.strokeStyle = C.cyan; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(pts[0][0], pts[0][1], 7, 0, Math.PI * 2); ctx.stroke();
    if (end) {
      snapMarker(end);
      const last = roomDraft.pts[roomDraft.pts.length - 1];
      const L = Math.hypot(end[0] - last[0], end[1] - last[1]);
      if (L > 0.01) {
        const m = w2s([(last[0] + end[0]) / 2, (last[1] + end[1]) / 2]);
        pill(fmtLen(L), m[0], m[1] - 14, C.cyan);
      }
    }
  } else if (tool === 'room' && hoverPt && !drag) {
    const pt = snapPoint(hoverPt[0], hoverPt[1], {});
    crossGuides(pt, w, h, 'rgba(95,179,201,0.12)');
    snapMarker(pt);
  }
  if (calib && calib.a) {
    const a = w2s(calib.a);
    const bPt = calib.b || hoverPt;
    const ring = s => {
      ctx.fillStyle = C.accent; ctx.beginPath(); ctx.arc(s[0], s[1], 3, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = C.accent; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(s[0], s[1], 7, 0, Math.PI * 2); ctx.stroke();
    };
    ring(a);
    if (bPt) {
      const b = w2s(bPt);
      ctx.strokeStyle = C.accent;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      ctx.setLineDash([]);
      ring(b);
      dimString(calib.a, bPt, C.accent, { side: 1, gap: 9, offset: 24 });
    }
  } else if (tool === 'calibrate' && hoverPt && prop.plan && !drag) {
    crossGuides(hoverPt, w, h, 'rgba(232,151,58,0.14)');
  }
}

function drawSelectionHandles() {
  if (!(selection && selection.kind === 'wall')) return;
  const wl = prop.walls.find(w => w.id === selection.id);
  if (!wl) return;
  for (const [end, p] of [['a', [wl.ax, wl.ay]], ['b', [wl.bx, wl.by]]]) {
    const s = w2s(p);
    const hot = hover && hover.kind === 'handle' && hover.end === end;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 4;
    ctx.fillStyle = hot ? '#ffffff' : C.accent;
    roundRect(s[0] - 5, s[1] - 5, 10, 10, 2.5);
    ctx.fill();
    ctx.restore();
    ctx.lineWidth = 1.5; ctx.strokeStyle = C.bg;
    roundRect(s[0] - 5, s[1] - 5, 10, 10, 2.5);
    ctx.stroke();
  }
}

function drawVignette(w, h) {
  const r = Math.hypot(w, h) / 2;
  const g = ctx.createRadialGradient(w / 2, h / 2, r * 0.45, w / 2, h / 2, r * 1.05);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.34)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

function rulerLabel(v, major) {
  if (ws.data.settings.units === 'metric') {
    return (Math.round(v * 100) / 100).toString();
  }
  const ft = v / 0.3048;
  if (major >= 0.3048) return Math.round(ft) + "'";
  return Math.round(ft * 12) + '"';
}

function drawRulers(w, h) {
  const R = RULER;
  const { major, minor } = gridSteps();
  const minorPx = minor * vs.zoom;
  ctx.fillStyle = C.rulerBg;
  ctx.fillRect(0, 0, w, R);
  ctx.fillRect(0, 0, R, h);
  ctx.strokeStyle = C.rulerLine; ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(R, crisp(R)); ctx.lineTo(w, crisp(R));
  ctx.moveTo(crisp(R), R); ctx.lineTo(crisp(R), h);
  ctx.stroke();

  ctx.font = `9px ${FONT}`;
  ctx.fillStyle = C.rulerText;
  ctx.strokeStyle = 'rgba(255,255,255,0.28)';
  ctx.textBaseline = 'alphabetic';
  // Horizontal ruler.
  ctx.textAlign = 'left';
  ctx.beginPath();
  const X0 = Math.floor(vs.panX / major) * major;
  for (let x = X0; (x - vs.panX) * vs.zoom < w; x += major) {
    const sx = crisp((x - vs.panX) * vs.zoom);
    if (sx < R) continue;
    ctx.moveTo(sx, R - 8); ctx.lineTo(sx, R);
    ctx.fillText(rulerLabel(x, major), sx + 3, R - 9);
  }
  if (minorPx >= 5) {
    const x0 = Math.floor(vs.panX / minor) * minor;
    for (let x = x0; (x - vs.panX) * vs.zoom < w; x += minor) {
      const sx = crisp((x - vs.panX) * vs.zoom);
      if (sx < R) continue;
      ctx.moveTo(sx, R - 3.5); ctx.lineTo(sx, R);
    }
  }
  ctx.stroke();
  // Vertical ruler (labels rotated to read along the edge).
  ctx.beginPath();
  const Y0 = Math.floor(vs.panY / major) * major;
  for (let y = Y0; (y - vs.panY) * vs.zoom < h; y += major) {
    const sy = crisp((y - vs.panY) * vs.zoom);
    if (sy < R) continue;
    ctx.moveTo(R - 8, sy); ctx.lineTo(R, sy);
    ctx.save();
    ctx.translate(R - 9, sy + 3);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'right';
    ctx.fillText(rulerLabel(y, major), 0, 0);
    ctx.restore();
  }
  if (minorPx >= 5) {
    const y0 = Math.floor(vs.panY / minor) * minor;
    for (let y = y0; (y - vs.panY) * vs.zoom < h; y += minor) {
      const sy = crisp((y - vs.panY) * vs.zoom);
      if (sy < R) continue;
      ctx.moveTo(R - 3.5, sy); ctx.lineTo(R, sy);
    }
  }
  ctx.stroke();
  // Cursor position markers.
  if (hoverPt) {
    const s = w2s(hoverPt);
    ctx.fillStyle = C.accent;
    if (s[0] > R) ctx.fillRect(Math.round(s[0]) - 0.5, 0, 1.5, R);
    if (s[1] > R) ctx.fillRect(0, Math.round(s[1]) - 0.5, R, 1.5);
  }
  // Corner: unit badge.
  ctx.fillStyle = C.rulerBg;
  ctx.fillRect(0, 0, R, R);
  ctx.strokeStyle = C.rulerLine;
  ctx.strokeRect(crisp(0) - 0.5, crisp(0) - 0.5, R, R);
  ctx.fillStyle = C.faint;
  ctx.font = `700 8px ${FONT}`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(ws.data.settings.units === 'metric' ? 'M' : 'FT', R / 2, R / 2 + 0.5);
  ctx.textBaseline = 'alphabetic';
}

function scaleBarLength() {
  const imperial = ws.data.settings.units === 'imperial';
  const cands = imperial
    ? [0.3048, 0.6096, 1.524, 3.048, 6.096, 15.24, 30.48]
    : [0.5, 1, 2, 5, 10, 20, 50];
  let best = cands[0];
  for (const c of cands) if (c * vs.zoom <= 150) best = c;
  return best;
}

function drawHud(w, h) {
  // Scale bar, bottom right.
  const len = scaleBarLength();
  const px = len * vs.zoom;
  const x1 = w - 18, x0 = x1 - px, y = h - 22;
  const segs = 4, segW = px / segs;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 6;
  for (let i = 0; i < segs; i++) {
    ctx.fillStyle = i % 2 ? 'rgba(233,238,243,0.9)' : 'rgba(10,14,18,0.9)';
    ctx.fillRect(x0 + i * segW, y - 3, segW, 6);
  }
  ctx.restore();
  ctx.strokeStyle = 'rgba(233,238,243,0.9)'; ctx.lineWidth = 1;
  ctx.strokeRect(crisp(x0), crisp(y - 3), px, 6);
  ctx.fillStyle = C.dim;
  ctx.font = `9px ${FONT}`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  ctx.fillText('0', x0, y - 7);
  ctx.fillText(fmtLen(len, { short: true }), x1, y - 7);
  ctx.fillText(fmtLen(len / 2, { short: true }), (x0 + x1) / 2, y - 7);
  // North arrow above the scale bar. env.north rotates the rose relative to plan +x.
  const north = (prop.env && typeof prop.env.north === 'number') ? prop.env.north : 0;
  const cx = w - 34, cy = h - 64, r = 14;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(13,18,23,0.85)'; ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.14)'; ctx.lineWidth = 1; ctx.stroke();
  ctx.rotate(north * Math.PI / 180);
  ctx.beginPath();
  ctx.moveTo(0, -r + 3); ctx.lineTo(4, 3); ctx.lineTo(0, 1); ctx.lineTo(-4, 3); ctx.closePath();
  ctx.fillStyle = C.accent; ctx.fill();
  ctx.beginPath();
  ctx.moveTo(0, r - 3); ctx.lineTo(3, -1); ctx.lineTo(0, 1); ctx.lineTo(-3, -1); ctx.closePath();
  ctx.fillStyle = 'rgba(233,238,243,0.35)'; ctx.fill();
  ctx.restore();
  ctx.fillStyle = C.dim;
  ctx.font = `700 9px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.fillText('N', cx, cy - r - 4);
}

// ---------- pointer handling ----------
function canvasPos(e) {
  const r = canvas.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

function updateCursor() {
  if (!canvas) return;
  let c = 'crosshair';
  if (drag && drag.kind === 'pan') c = 'grabbing';
  else if (spaceDown) c = 'grab';
  else if (tool === 'select') {
    if (!hover) c = 'default';
    else if (hover.kind === 'handle') c = 'pointer';
    else c = 'move';
  }
  canvas.style.cursor = c;
}

function updateBadge(wx, wy) {
  if (!badgeEl) return;
  let html = `X <b>${escapeHtml(fmtLen(wx))}</b> &nbsp; Y <b>${escapeHtml(fmtLen(wy))}</b>`;
  if (drawing) {
    const pt = snapPoint(wx, wy, { from: drawing.last });
    const L = Math.hypot(pt[0] - drawing.last[0], pt[1] - drawing.last[1]);
    const ang = ((Math.atan2(-(pt[1] - drawing.last[1]), pt[0] - drawing.last[0]) * 180 / Math.PI) + 360) % 360;
    html += ` &nbsp; L <b class="ac">${escapeHtml(fmtLen(L))}</b> &nbsp; <b>${Math.round(ang)}&deg;</b>`;
  }
  badgeEl.innerHTML = html;
}

function onPointerDown(e) {
  if (e.button === 2) return;
  canvas.setPointerCapture(e.pointerId);
  const [sx, sy] = canvasPos(e);
  const [wx, wy] = s2w(sx, sy);

  if (e.button === 1 || spaceDown) {
    drag = { kind: 'pan', sx, sy, panX: vs.panX, panY: vs.panY };
    updateCursor();
    return;
  }

  if (tool === 'wall') {
    const pt = drawing ? snapPoint(wx, wy, { from: drawing.last }) : snapPoint(wx, wy, {});
    if (!drawing) { drawing = { last: pt }; }
    else {
      if (Math.hypot(pt[0] - drawing.last[0], pt[1] - drawing.last[1]) > 0.05) {
        addWall(drawing.last, pt);
        drawing = { last: pt };
      }
    }
    updateHint();
    return;
  }
  if (tool === 'door' || tool === 'window') {
    const hit = hitTest(wx, wy);
    if (hit && hit.kind === 'wall') {
      const w = prop.walls.find(w => w.id === hit.id);
      const { t } = distToSeg(wx, wy, w.ax, w.ay, w.bx, w.by);
      const L = Math.hypot(w.bx - w.ax, w.by - w.ay);
      const def = tool === 'door' ? DOOR_DEFAULT : WINDOW_DEFAULT;
      const minT = Math.min(0.5, def.width / 2 / L), clamped = Math.max(minT, Math.min(1 - minT, t));
      addOpening(w.id, clamped, tool);
    }
    return;
  }
  if (tool === 'room') {
    const pt = snapPoint(wx, wy, roomDraft && roomDraft.pts.length ? { from: roomDraft.pts[roomDraft.pts.length - 1] } : {});
    if (!roomDraft) roomDraft = { pts: [] };
    if (roomDraft.pts.length >= 3) {
      const first = w2s(roomDraft.pts[0]);
      const here = w2s(pt);
      if (Math.hypot(first[0] - here[0], first[1] - here[1]) < 12) { closeRoom(); return; }
    }
    roomDraft.pts.push(pt);
    updateHint();
    return;
  }
  if (tool === 'calibrate') {
    if (!prop.plan || !prop.plan.img) { setHint('Upload a plan image first, then calibrate.'); return; }
    if (!calib || calib.b) calib = { a: [wx, wy], b: null };
    else { calib.b = [wx, wy]; renderInspector(); }
    updateHint();
    return;
  }

  // Select tool.
  const hit = hitTest(wx, wy);
  if (!hit) {
    selection = null;
    drag = { kind: 'pan', sx, sy, panX: vs.panX, panY: vs.panY };
    renderInspector(); updateCursor();
    return;
  }
  if (hit.kind === 'handle') {
    pushUndo();
    drag = { kind: 'handle', id: hit.id, end: hit.end };
    return;
  }
  selection = { kind: hit.kind, id: hit.id };
  renderInspector();
  if (hit.kind === 'wall') {
    const w = prop.walls.find(w => w.id === hit.id);
    pushUndo();
    drag = { kind: 'wall', id: hit.id, wx, wy, orig: { ax: w.ax, ay: w.ay, bx: w.bx, by: w.by }, moved: false };
  } else if (hit.kind === 'opening') {
    pushUndo();
    drag = { kind: 'opening', id: hit.id, moved: false };
  } else if (hit.kind === 'room') {
    const r = prop.rooms.find(r => r.id === hit.id);
    pushUndo();
    drag = { kind: 'room', id: hit.id, wx, wy, orig: r.pts.map(p => [...p]), moved: false };
  } else if (hit.kind === 'underlay') {
    drag = { kind: 'underlay', wx, wy, ox: prop.plan.offsetX, oy: prop.plan.offsetY, moved: false };
  }
}

function onPointerMove(e) {
  const [sx, sy] = canvasPos(e);
  const [wx, wy] = s2w(sx, sy);
  hoverPt = [wx, wy];
  updateBadge(wx, wy);

  if (!drag) {
    hover = tool === 'select' ? hitTest(wx, wy) : null;
    updateCursor();
    return;
  }
  if (drag.kind === 'pan') {
    vs.panX = drag.panX - (sx - drag.sx) / vs.zoom;
    vs.panY = drag.panY - (sy - drag.sy) / vs.zoom;
    return;
  }
  drag.moved = true;
  if (drag.kind === 'handle') {
    const w = prop.walls.find(w => w.id === drag.id);
    if (!w) return;
    const pt = snapPoint(wx, wy, { excludeWall: w.id, from: drag.end === 'a' ? [w.bx, w.by] : [w.ax, w.ay] });
    if (drag.end === 'a') { w.ax = pt[0]; w.ay = pt[1]; } else { w.bx = pt[0]; w.by = pt[1]; }
  } else if (drag.kind === 'wall') {
    const w = prop.walls.find(w => w.id === drag.id);
    if (!w) return;
    const dx = rnd(wx - drag.wx), dy = rnd(wy - drag.wy);
    w.ax = drag.orig.ax + dx; w.ay = drag.orig.ay + dy;
    w.bx = drag.orig.bx + dx; w.by = drag.orig.by + dy;
  } else if (drag.kind === 'opening') {
    const o = prop.openings.find(o => o.id === drag.id);
    const p = o && openingPos(o);
    if (!p) return;
    const { t } = distToSeg(wx, wy, p.w.ax, p.w.ay, p.w.bx, p.w.by);
    const minT = Math.min(0.5, o.width / 2 / p.L);
    o.t = Math.max(minT, Math.min(1 - minT, t));
  } else if (drag.kind === 'room') {
    const r = prop.rooms.find(r => r.id === drag.id);
    if (!r) return;
    const dx = rnd(wx - drag.wx), dy = rnd(wy - drag.wy);
    r.pts = drag.orig.map(p => [p[0] + dx, p[1] + dy]);
  } else if (drag.kind === 'underlay') {
    prop.plan.offsetX = drag.ox + (wx - drag.wx);
    prop.plan.offsetY = drag.oy + (wy - drag.wy);
  }
}

function onPointerUp() {
  if (drag && drag.moved) { touch(); renderInspector(); }
  else if (drag && !drag.moved && (drag.kind === 'wall' || drag.kind === 'opening' || drag.kind === 'room')) {
    // Was a click-select; undo snapshot without changes is harmless but pop it to keep stack clean.
    undoStack.pop();
  }
  drag = null;
  if (hoverPt && tool === 'select') hover = hitTest(hoverPt[0], hoverPt[1]);
  updateCursor();
}

function onPointerLeave() {
  hoverPt = null; hover = null;
  if (!drag) updateCursor();
}

function onDblClick() {
  if (tool === 'wall') { drawing = null; updateHint(); }
  if (tool === 'room' && roomDraft && roomDraft.pts.length >= 3) closeRoom();
}

function closeRoom() {
  pushUndo();
  const r = { id: uid('r'), name: 'Room ' + (prop.rooms.length + 1), pts: roomDraft.pts, material: 'mat-oak' };
  prop.rooms.push(r);
  roomDraft = null;
  selection = { kind: 'room', id: r.id };
  touch(); renderInspector(); updateHint();
}

function onWheel(e) {
  e.preventDefault();
  const [sx, sy] = canvasPos(e);
  if (e.ctrlKey || e.metaKey) {
    const factor = Math.exp(-e.deltaY * 0.01);
    const [wx, wy] = s2w(sx, sy);
    vs.zoom = Math.max(4, Math.min(400, vs.zoom * factor));
    vs.panX = wx - sx / vs.zoom;
    vs.panY = wy - sy / vs.zoom;
  } else {
    vs.panX += e.deltaX / vs.zoom;
    vs.panY += e.deltaY / vs.zoom;
  }
}

function onKeyDown(e) {
  if (e.target.matches('input, textarea, select')) return;
  if (e.key === ' ') { spaceDown = true; e.preventDefault(); updateCursor(); return; }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    e.shiftKey ? redo() : undo();
    return;
  }
  const keys = { v: 'select', w: 'wall', d: 'door', n: 'window', r: 'room', c: 'calibrate' };
  if (keys[e.key.toLowerCase()] && !e.metaKey && !e.ctrlKey) { setTool(keys[e.key.toLowerCase()]); return; }
  if (e.key === 'f') { fitView(); return; }
  if (e.key === 'Escape') {
    if (drawing) drawing = null;
    else if (roomDraft) roomDraft = null;
    else if (calib) { calib = null; renderInspector(); }
    else { selection = null; renderInspector(); }
    updateHint();
    return;
  }
  if (e.key === 'Delete' || e.key === 'Backspace') { deleteSelection(); }
}
function onKeyUp(e) { if (e.key === ' ') { spaceDown = false; updateCursor(); } }

// ---------- tool column / hint ----------
function setTool(t) {
  tool = t;
  drawing = null; roomDraft = null; hover = null;
  if (t !== 'calibrate') calib = null;
  renderToolCol(); updateHint(); renderInspector(); updateCursor();
}

function setHint(text) { if (hintEl) hintEl.textContent = text; }
function updateHint() {
  const hints = {
    select: 'Click to select. Drag walls, endpoints, openings, rooms or the underlay. Scroll pans, pinch or cmd+scroll zooms. F fits view.',
    wall: drawing ? 'Click to place the next corner. Double-click or Esc to end the chain.' : 'Click to start a wall chain. Walls snap to endpoints, axes and 15 degree angles.',
    door: 'Click on a wall to place a door.',
    window: 'Click on a wall to place a window.',
    room: roomDraft ? 'Click corners; click the first point or double-click to close the room.' : 'Click to outline a room polygon (used for floor area, materials and 3D floors).',
    calibrate: (!prop || !prop.plan) ? 'Upload a plan image first (UNDERLAY, left panel).' : 'Click two points a known distance apart on the plan image, then enter the real distance.',
  };
  setHint(hints[tool] || '');
}

function toolBtn(attrs, ic, name, key, active) {
  return `<button class="tool-btn ${active ? 'active' : ''}" ${attrs} title="${name}${key ? ' (' + key + ')' : ''}">` +
    `${icon(ic)}<span class="tb-text">${name}</span>${key ? `<kbd class="key">${key}</kbd>` : ''}</button>`;
}

function renderToolCol() {
  const tools = [
    ['select', 'SELECT', 'V', 'select'], ['wall', 'WALL', 'W', 'wall'], ['door', 'DOOR', 'D', 'door'],
    ['window', 'WINDOW', 'N', 'window'], ['room', 'ROOM', 'R', 'room'], ['calibrate', 'CALIBRATE', 'C', 'calibrate'],
  ];
  const tc = el.querySelector('.tool-col');
  tc.innerHTML = `
    <div class="tool-head">Tools</div>
    ${tools.map(([id, name, key, ic]) => toolBtn(`data-tool="${id}"`, ic, name, key, tool === id)).join('')}
    <div class="tool-sep"></div>
    <div class="tool-head">Wall preset</div>
    <div class="seg fill" style="margin:0 4px">
      <button class="seg-btn ${wallPreset === 'interior' ? 'active' : ''}" data-preset="interior" title="Interior partition, ${escapeHtml(fmtLen(PRESETS.interior.thickness))}">INT</button>
      <button class="seg-btn ${wallPreset === 'exterior' ? 'active' : ''}" data-preset="exterior" title="Exterior wall, ${escapeHtml(fmtLen(PRESETS.exterior.thickness))}">EXT</button>
    </div>
    <div class="tool-sep"></div>
    <div class="tool-head">Underlay</div>
    ${toolBtn('data-act="upload"', 'upload', 'UPLOAD IMAGE', '', false)}
    <input type="file" class="hidden-file" accept="image/*,.pdf">
    <div class="tool-sep"></div>
    <label class="tool-check" title="Snap to endpoints, axes and 15 degree angles">${icon('snap')}<span>SNAP</span><input type="checkbox" ${snapOn ? 'checked' : ''} data-chk="snap"></label>
    <label class="tool-check" title="Show a dimension string on every wall">${icon('dims')}<span>DIMS</span><input type="checkbox" ${dimsOn ? 'checked' : ''} data-chk="dims"></label>
    <div class="tool-sep"></div>
    ${toolBtn('data-act="fit"', 'fit', 'FIT VIEW', 'F', false)}
    ${toolBtn('data-act="undo"', 'undo', 'UNDO', MOD + 'Z', false)}
    ${toolBtn('data-act="redo"', 'redo', 'REDO', '⇧' + MOD + 'Z', false)}
  `;
  tc.querySelectorAll('[data-tool]').forEach(b => b.onclick = () => setTool(b.dataset.tool));
  tc.querySelectorAll('[data-preset]').forEach(b => b.onclick = () => { wallPreset = b.dataset.preset; renderToolCol(); });
  const file = tc.querySelector('input[type=file]');
  tc.querySelector('[data-act=upload]').onclick = () => file.click();
  file.onchange = () => { uploadUnderlay(file.files[0]); file.value = ''; };
  tc.querySelector('[data-act=fit]').onclick = fitView;
  tc.querySelector('[data-act=undo]').onclick = undo;
  tc.querySelector('[data-act=redo]').onclick = redo;
  tc.querySelectorAll('[data-chk]').forEach(c => c.onchange = () => {
    if (c.dataset.chk === 'snap') snapOn = c.checked;
    if (c.dataset.chk === 'dims') dimsOn = c.checked;
  });
}

// ---------- inspector ----------
function scopeAssignHtml(elementId) {
  // Which scope item currently references this element?
  let current = '';
  for (const pr of ws.data.projects) for (const it of pr.items) if ((it.elementIds || []).includes(elementId)) current = it.id;
  const groups = ws.data.projects.map(pr => {
    const opts = pr.items.map(it => `<option value="${it.id}" ${it.id === current ? 'selected' : ''}>${escapeHtml(it.name)}</option>`).join('');
    return opts ? `<optgroup label="${escapeHtml(pr.name)}">${opts}</optgroup>` : '';
  }).join('');
  return `<div class="field"><label>Scope item (digital twin link)</label>
    <select data-assign="${elementId}"><option value="">(not assigned)</option>${groups}</select></div>`;
}
function bindAssign(root) {
  root.querySelectorAll('[data-assign]').forEach(sel => {
    sel.onchange = () => {
      const elId = sel.dataset.assign;
      for (const pr of ws.data.projects) for (const it of pr.items) {
        it.elementIds = (it.elementIds || []).filter(x => x !== elId);
      }
      if (sel.value) {
        const found = itemById(sel.value);
        if (found) (found.item.elementIds = found.item.elementIds || []).push(elId);
      }
      touch();
    };
  });
}

function lenField(label, value, key, placeholder) {
  return `<div class="field"><label>${label}</label>
    <input type="text" data-len="${key}" value="${value != null ? escapeHtml(fmtLen(value)) : ''}" placeholder="${placeholder || ''}"></div>`;
}

function head(ic, text) { return `<h3>${icon(ic)}${text}</h3>`; }

function renderInspector() {
  if (!inspEl) return;
  const insp = inspEl;

  if (calib && calib.a && calib.b) {
    const measured = Math.hypot(calib.b[0] - calib.a[0], calib.b[1] - calib.a[1]);
    insp.innerHTML = `${head('calibrate', 'CALIBRATE SCALE')}
      <div class="stat-line"><span>Measured on screen</span><b>${fmtLen(measured)}</b></div>
      <div class="field" style="margin-top:10px"><label>Real distance (e.g. 12'6" or 3.8m)</label><input type="text" data-cal-input placeholder="12'-6&quot;"></div>
      <button class="btn primary" data-cal-apply>${icon('check')}APPLY SCALE</button>
      <button class="btn" data-cal-cancel>CANCEL</button>`;
    const input = insp.querySelector('[data-cal-input]');
    input.focus();
    const apply = () => {
      const real = parseLen(input.value);
      if (isNaN(real) || real <= 0) { alert('Could not parse that distance. Try 12\'6", 150", or 3.8m.'); return; }
      const pl = prop.plan;
      const ratio = real / measured;
      // Rescale the underlay mapping about its own origin so image geometry matches reality.
      pl.mPerPx = pl.mPerPx * ratio;
      pl.calibrated = true;
      calib = null;
      tool = 'wall';
      fitView();
      touch(); renderToolCol(); renderInspector(); updateHint();
    };
    insp.querySelector('[data-cal-apply]').onclick = apply;
    input.onkeydown = e => { if (e.key === 'Enter') apply(); };
    insp.querySelector('[data-cal-cancel]').onclick = () => { calib = null; renderInspector(); };
    return;
  }

  if (!selection) {
    const totalWall = prop.walls.reduce((n, w) => n + Math.hypot(w.bx - w.ax, w.by - w.ay), 0);
    const floorArea = prop.rooms.reduce((n, r) => n + polyArea(r.pts), 0);
    insp.innerHTML = `${head('home', 'PROPERTY')}
      <div class="field"><label>Name</label><input type="text" data-prop-name value="${escapeHtml(prop.name)}"></div>
      ${lenField('Default wall height', prop.wallHeight, 'wallHeight')}
      <div class="tool-sep"></div>
      <div class="stat-line"><span>Walls</span><b>${prop.walls.length}</b></div>
      <div class="stat-line"><span>Openings</span><b>${prop.openings.length}</b></div>
      <div class="stat-line"><span>Rooms</span><b>${prop.rooms.length}</b></div>
      <div class="stat-line"><span>Total wall run</span><b>${fmtLen(totalWall)}</b></div>
      <div class="stat-line"><span>Floor area</span><b>${fmtArea(floorArea)}</b></div>
      <div class="empty" style="margin-top:14px">Select an element to edit it, or use the tools to draw.<br><br>
        <span class="kbd-hint"><kbd>W</kbd> wall</span> <span class="kbd-hint"><kbd>D</kbd> door</span> <span class="kbd-hint"><kbd>N</kbd> window</span> <span class="kbd-hint"><kbd>R</kbd> room</span></div>`;
    insp.querySelector('[data-prop-name]').onchange = e => { prop.name = e.target.value; touch(); };
    insp.querySelector('[data-len=wallHeight]').onchange = e => {
      const v = parseLen(e.target.value);
      if (!isNaN(v) && v > 0.5) { prop.wallHeight = v; touch(); }
      renderInspector();
    };
    return;
  }

  if (selection.kind === 'wall') {
    const w = prop.walls.find(w => w.id === selection.id);
    if (!w) { selection = null; return renderInspector(); }
    const L = Math.hypot(w.bx - w.ax, w.by - w.ay);
    insp.innerHTML = `${head('wall', 'WALL')}
      ${lenField('Length', L, 'len')}
      <div class="field-row">
        ${lenField('Thickness', w.thickness, 'th')}
        ${lenField('Height', w.height, 'h', fmtLen(prop.wallHeight) + ' (default)')}
      </div>
      <div class="field"><label>Material</label>${materialSelectHtml('wall', w.material, 'data-mat')}</div>
      ${scopeAssignHtml(w.id)}
      <div class="stat-line"><span>Face area</span><b>${fmtArea(L * (w.height || prop.wallHeight))}</b></div>
      <div class="stat-line"><span>Openings</span><b>${prop.openings.filter(o => o.wallId === w.id).length}</b></div>
      <button class="btn danger" data-del>${icon('trash')}DELETE WALL</button>`;
    insp.querySelector('[data-len=len]').onchange = e => {
      const v = parseLen(e.target.value);
      if (!isNaN(v) && v > 0.05) {
        pushUndo();
        const ux = (w.bx - w.ax) / L, uy = (w.by - w.ay) / L;
        w.bx = rnd(w.ax + ux * v); w.by = rnd(w.ay + uy * v);
        touch();
      }
      renderInspector();
    };
    insp.querySelector('[data-len=th]').onchange = e => {
      const v = parseLen(e.target.value);
      if (!isNaN(v) && v > 0.02 && v < 1) { pushUndo(); w.thickness = v; touch(); }
      renderInspector();
    };
    insp.querySelector('[data-len=h]').onchange = e => {
      if (!e.target.value.trim()) { w.height = null; touch(); renderInspector(); return; }
      const v = parseLen(e.target.value);
      if (!isNaN(v) && v > 0.3) { w.height = v; touch(); }
      renderInspector();
    };
    insp.querySelector('[data-mat]').onchange = e => { w.material = e.target.value || null; touch(); };
    insp.querySelector('[data-del]').onclick = deleteSelection;
    bindAssign(insp);
    return;
  }

  if (selection.kind === 'opening') {
    const o = prop.openings.find(o => o.id === selection.id);
    if (!o) { selection = null; return renderInspector(); }
    insp.innerHTML = `${head(o.type === 'door' ? 'door' : 'window', o.type === 'door' ? 'DOOR' : 'WINDOW')}
      <div class="field"><label>Type</label>
        <select data-type><option value="door" ${o.type === 'door' ? 'selected' : ''}>Door</option>
        <option value="window" ${o.type === 'window' ? 'selected' : ''}>Window</option></select></div>
      <div class="field-row">
        ${lenField('Width', o.width, 'w')}
        ${lenField('Height', o.height, 'h')}
      </div>
      ${o.type === 'window' ? lenField('Sill height', o.sill || 0, 's') : ''}
      <div class="field"><label>Position along wall</label>
        <input type="range" min="0.02" max="0.98" step="0.005" value="${o.t}" data-t></div>
      <button class="btn danger" data-del>${icon('trash')}DELETE</button>`;
    insp.querySelector('[data-type]').onchange = e => {
      pushUndo();
      o.type = e.target.value;
      if (o.type === 'window' && o.sill == null) o.sill = WINDOW_DEFAULT.sill;
      touch(); renderInspector();
    };
    const num = (key, fn) => {
      const elx = insp.querySelector(`[data-len=${key}]`);
      if (elx) elx.onchange = e => {
        const v = parseLen(e.target.value);
        if (!isNaN(v) && v > 0.05) { pushUndo(); fn(v); touch(); }
        renderInspector();
      };
    };
    num('w', v => o.width = v);
    num('h', v => o.height = v);
    num('s', v => o.sill = v);
    insp.querySelector('[data-t]').oninput = e => { o.t = parseFloat(e.target.value); touch(); };
    insp.querySelector('[data-del]').onclick = deleteSelection;
    return;
  }

  if (selection.kind === 'room') {
    const r = prop.rooms.find(r => r.id === selection.id);
    if (!r) { selection = null; return renderInspector(); }
    insp.innerHTML = `${head('room', 'ROOM')}
      <div class="field"><label>Name</label><input type="text" data-name value="${escapeHtml(r.name || '')}"></div>
      <div class="field"><label>Floor material</label>${materialSelectHtml('floor', r.material, 'data-mat')}</div>
      ${scopeAssignHtml(r.id)}
      <div class="stat-line"><span>Area</span><b>${fmtArea(polyArea(r.pts))}</b></div>
      <div class="stat-line"><span>Perimeter</span><b>${fmtLen(r.pts.reduce((n, p, i) => n + Math.hypot(p[0] - r.pts[(i + 1) % r.pts.length][0], p[1] - r.pts[(i + 1) % r.pts.length][1]), 0))}</b></div>
      <div class="stat-line"><span>Corners</span><b>${r.pts.length}</b></div>
      <button class="btn danger" data-del>${icon('trash')}DELETE ROOM</button>`;
    insp.querySelector('[data-name]').onchange = e => { r.name = e.target.value; touch(); };
    insp.querySelector('[data-mat]').onchange = e => { r.material = e.target.value || null; touch(); };
    insp.querySelector('[data-del]').onclick = deleteSelection;
    bindAssign(insp);
    return;
  }

  if (selection.kind === 'underlay') {
    const pl = prop.plan;
    if (!pl) { selection = null; return renderInspector(); }
    insp.innerHTML = `${head('image', 'PLAN UNDERLAY')}
      <div class="field"><label>Opacity</label>
        <input type="range" min="0.1" max="1" step="0.05" value="${pl.opacity}" data-op></div>
      <div class="stat-line"><span>Image</span><b>${pl.imgW} x ${pl.imgH} px</b></div>
      <div class="stat-line"><span>Scale</span><b>${(pl.mPerPx * 100).toFixed(2)} cm/px</b></div>
      <div class="stat-line"><span>Calibrated</span><b>${pl.calibrated ? 'yes' : 'NO - use CALIBRATE'}</b></div>
      <div class="empty" style="margin:12px 0">Drag the image with the select tool to align it with your walls. Use CALIBRATE (C) to set true scale from a known dimension.</div>
      <button class="btn danger" data-del>${icon('trash')}REMOVE UNDERLAY</button>`;
    insp.querySelector('[data-op]').oninput = e => { pl.opacity = parseFloat(e.target.value); touch(); };
    insp.querySelector('[data-del]').onclick = deleteSelection;
    return;
  }
}

// ---------- mount / unmount ----------
export function mount(root) {
  prop = activeProperty();
  el = root;
  if (!prop) {
    root.innerHTML = `<div class="view-scroll"><div class="kicker">PLAN</div>
      <div class="empty-state"><span class="empty-ic">${icon('plan')}</span><b>No property yet</b>
      Create one from the PROPERTY selector in the top bar.</div></div>`;
    return;
  }
  root.innerHTML = `
    <div class="editor-layout">
      <div class="tool-col"></div>
      <div class="canvas-wrap plan-canvas">
        <canvas></canvas>
        <div class="canvas-hint"></div>
        <div class="canvas-badge"></div>
      </div>
      <div class="inspector"></div>
    </div>`;
  canvas = root.querySelector('canvas');
  ctx = canvas.getContext('2d');
  wrapEl = root.querySelector('.canvas-wrap');
  inspEl = root.querySelector('.inspector');
  hintEl = root.querySelector('.canvas-hint');
  badgeEl = root.querySelector('.canvas-badge');
  hatchCache.clear();

  vs = viewByProp[prop.id];
  if (!vs) { vs = viewByProp[prop.id] = { zoom: 60, panX: 0, panY: 0 }; requestAnimationFrame(() => { fitView(); }); }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('dblclick', onDblClick);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  renderToolCol();
  renderInspector();
  updateHint();
  updateCursor();

  const loop = () => { draw(); raf = requestAnimationFrame(loop); };
  raf = requestAnimationFrame(loop);
}

export function unmount() {
  cancelAnimationFrame(raf);
  window.removeEventListener('keydown', onKeyDown);
  window.removeEventListener('keyup', onKeyUp);
  drawing = null; roomDraft = null; drag = null; hover = null; hoverPt = null;
  el = null; canvas = null; ctx = null; inspEl = null; hintEl = null; badgeEl = null;
}
