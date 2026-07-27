// Floorplan editor: trace walls over an uploaded plan image, place doors/windows,
// outline rooms, calibrate real-world scale. Canvas-based; all model coords in meters.

import {
  ws, activeProperty, uid, touch, fmtLen, parseLen, fmtArea, polyArea,
  escapeHtml, itemById,
} from './store.js';
import { materialSelectHtml } from './materials.js';

const PRESETS = {
  interior: { thickness: 0.114, material: 'mat-drywall' },   // 4.5 in stud wall
  exterior: { thickness: 0.165, material: 'mat-fiber' },     // 6.5 in
};
const DOOR_DEFAULT = { width: 0.813, height: 2.032 };         // 32 x 80 in
const WINDOW_DEFAULT = { width: 0.914, height: 1.219, sill: 0.762 }; // 36 x 48, sill 30

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
let drawing = null;          // {last:[x,y]}
let roomDraft = null;        // {pts:[[x,y],...]}
let calib = null;            // {a:[x,y], b:[x,y]|null}
let hoverPt = null;          // last cursor world pos
let drag = null;             // active drag descriptor
let spaceDown = false;
let undoStack = [], redoStack = [];

function dpr() { return window.devicePixelRatio || 1; }
function w2s(p) { return [(p[0] - vs.panX) * vs.zoom, (p[1] - vs.panY) * vs.zoom]; }
function s2w(x, y) { return [x / vs.zoom + vs.panX, y / vs.zoom + vs.panY]; }
function rnd(v) { return Math.round(v * 200) / 200; } // 5 mm
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
function matColor(id, fallback) {
  const m = ws.data.materials.find(m => m.id === id);
  return m ? m.color : (fallback || '#d8d4cc');
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
  const w = wrapEl.clientWidth, h = wrapEl.clientHeight;
  const bw = Math.max(b.maxX - b.minX, 1), bh = Math.max(b.maxY - b.minY, 1);
  vs.zoom = Math.min(w / (bw * 1.15), h / (bh * 1.15), 250);
  vs.panX = b.minX - (w / vs.zoom - bw) / 2;
  vs.panY = b.minY - (h / vs.zoom - bh) / 2;
}

// ---------- undo ----------
function snapshot() { return JSON.stringify({ walls: prop.walls, openings: prop.openings, rooms: prop.rooms }); }
function pushUndo() { undoStack.push(snapshot()); if (undoStack.length > 80) undoStack.shift(); redoStack = []; }
function applySnap(s) {
  const d = JSON.parse(s);
  prop.walls = d.walls; prop.openings = d.openings; prop.rooms = d.rooms;
  selection = null; touch(); renderInspector();
}
function undo() { if (!undoStack.length) return; redoStack.push(snapshot()); applySnap(undoStack.pop()); }
function redo() { if (!redoStack.length) return; undoStack.push(snapshot()); applySnap(redoStack.pop()); }

// ---------- snapping ----------
function snapPoint(wx, wy, opts) {
  opts = opts || {};
  const tolW = 11 / vs.zoom;
  // Endpoint snap.
  let best = null, bestD = tolW;
  for (const w of prop.walls) {
    for (const p of [[w.ax, w.ay], [w.bx, w.by]]) {
      if (opts.excludeWall && opts.excludeWall === w.id) continue;
      const d = Math.hypot(p[0] - wx, p[1] - wy);
      if (d < bestD) { bestD = d; best = p; }
    }
  }
  if (best) return [best[0], best[1]];
  let x = wx, y = wy;
  if (snapOn && opts.from) {
    const [fx, fy] = opts.from;
    // Axis alignment.
    if (Math.abs(x - fx) < tolW) x = fx;
    else if (Math.abs(y - fy) < tolW) y = fy;
    else {
      // 15 degree angle snap.
      const ang = Math.atan2(y - fy, x - fx);
      const dist = Math.hypot(x - fx, y - fy);
      const snapAng = Math.round(ang / (Math.PI / 12)) * (Math.PI / 12);
      if (Math.abs(ang - snapAng) < 0.06) { x = fx + Math.cos(snapAng) * dist; y = fy + Math.sin(snapAng) * dist; }
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
  selection = null;
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

// ---------- rendering ----------
function gridStep() {
  const imperial = ws.data.settings.units === 'imperial';
  const steps = imperial
    ? [0.0762, 0.1524, 0.3048, 0.6096, 1.524, 3.048, 6.096, 15.24]
    : [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10];
  for (const s of steps) if (s * vs.zoom >= 26) return s;
  return steps[steps.length - 1];
}

let underlayImg = null, underlayImgSrc = null;
function draw() {
  const w = wrapEl.clientWidth, h = wrapEl.clientHeight;
  if (canvas.width !== w * dpr() || canvas.height !== h * dpr()) {
    canvas.width = w * dpr(); canvas.height = h * dpr();
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
  }
  ctx.setTransform(dpr(), 0, 0, dpr(), 0, 0);
  ctx.fillStyle = '#0c1013';
  ctx.fillRect(0, 0, w, h);

  // Grid.
  const step = gridStep();
  ctx.lineWidth = 1;
  const x0 = Math.floor(vs.panX / step) * step;
  const y0 = Math.floor(vs.panY / step) * step;
  ctx.strokeStyle = '#1a2229';
  ctx.beginPath();
  for (let x = x0; (x - vs.panX) * vs.zoom < w; x += step) { const sx = (x - vs.panX) * vs.zoom; ctx.moveTo(sx, 0); ctx.lineTo(sx, h); }
  for (let y = y0; (y - vs.panY) * vs.zoom < h; y += step) { const sy = (y - vs.panY) * vs.zoom; ctx.moveTo(0, sy); ctx.lineTo(w, sy); }
  ctx.stroke();
  // Origin axes.
  ctx.strokeStyle = '#26313b';
  ctx.beginPath();
  const ox = (0 - vs.panX) * vs.zoom, oy = (0 - vs.panY) * vs.zoom;
  ctx.moveTo(ox, 0); ctx.lineTo(ox, h); ctx.moveTo(0, oy); ctx.lineTo(w, oy);
  ctx.stroke();

  // Underlay.
  const pl = prop.plan;
  if (pl && pl.img) {
    if (underlayImgSrc !== pl.img) {
      underlayImg = new Image(); underlayImg.src = pl.img; underlayImgSrc = pl.img;
    }
    if (underlayImg.complete && underlayImg.naturalWidth) {
      ctx.globalAlpha = pl.opacity;
      const [sx, sy] = w2s([pl.offsetX, pl.offsetY]);
      ctx.drawImage(underlayImg, sx, sy, pl.imgW * pl.mPerPx * vs.zoom, pl.imgH * pl.mPerPx * vs.zoom);
      ctx.globalAlpha = 1;
      if (selection && selection.kind === 'underlay') {
        ctx.strokeStyle = '#e8973a';
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(sx, sy, pl.imgW * pl.mPerPx * vs.zoom, pl.imgH * pl.mPerPx * vs.zoom);
        ctx.setLineDash([]);
      }
    }
  }

  // Rooms.
  for (const r of prop.rooms) {
    if (r.pts.length < 3) continue;
    ctx.beginPath();
    r.pts.forEach((p, i) => { const s = w2s(p); i ? ctx.lineTo(s[0], s[1]) : ctx.moveTo(s[0], s[1]); });
    ctx.closePath();
    const col = matColor(r.material, '#5fb3c9');
    const sel = selection && selection.kind === 'room' && selection.id === r.id;
    ctx.fillStyle = hexA(col, sel ? 0.22 : 0.10);
    ctx.fill();
    ctx.strokeStyle = sel ? '#e8973a' : hexA(col, 0.5);
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = sel ? 1.6 : 1;
    ctx.stroke();
    ctx.setLineDash([]);
    // Label at centroid.
    let cx = 0, cy = 0;
    for (const p of r.pts) { cx += p[0]; cy += p[1]; }
    const s = w2s([cx / r.pts.length, cy / r.pts.length]);
    ctx.fillStyle = sel ? '#e8973a' : '#8b9aa7';
    ctx.font = '600 11px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.fillText((r.name || 'ROOM').toUpperCase(), s[0], s[1] - 3);
    ctx.font = '10px ui-monospace, Menlo, monospace';
    ctx.fillStyle = '#5a6875';
    ctx.fillText(fmtArea(polyArea(r.pts)), s[0], s[1] + 10);
  }

  // Walls.
  for (const wl of prop.walls) {
    drawWall(wl);
  }
  // Openings.
  for (const o of prop.openings) drawOpening(o);

  // Drafts.
  if (drawing && hoverPt) {
    const pt = snapPoint(hoverPt[0], hoverPt[1], { from: drawing.last });
    const a = w2s(drawing.last), b = w2s(pt);
    ctx.strokeStyle = '#e8973a';
    ctx.lineWidth = 2;
    ctx.setLineDash([7, 5]);
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    ctx.setLineDash([]);
    label(fmtLen(Math.hypot(pt[0] - drawing.last[0], pt[1] - drawing.last[1])), (a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - 12, '#e8973a');
  }
  if (roomDraft && roomDraft.pts.length) {
    ctx.strokeStyle = '#5fb3c9';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    roomDraft.pts.forEach((p, i) => { const s = w2s(p); i ? ctx.lineTo(s[0], s[1]) : ctx.moveTo(s[0], s[1]); });
    if (hoverPt) { const s = w2s(snapPoint(hoverPt[0], hoverPt[1], {})); ctx.lineTo(s[0], s[1]); }
    ctx.stroke();
    ctx.setLineDash([]);
    const first = w2s(roomDraft.pts[0]);
    ctx.fillStyle = '#5fb3c9';
    ctx.fillRect(first[0] - 4, first[1] - 4, 8, 8);
  }
  if (calib && calib.a) {
    const a = w2s(calib.a);
    const bPt = calib.b || hoverPt;
    ctx.fillStyle = '#e8973a';
    ctx.beginPath(); ctx.arc(a[0], a[1], 4, 0, 7); ctx.fill();
    if (bPt) {
      const b = w2s(bPt);
      ctx.strokeStyle = '#e8973a';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(b[0], b[1], 4, 0, 7); ctx.fill();
      label(fmtLen(Math.hypot(bPt[0] - calib.a[0], bPt[1] - calib.a[1])), (a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - 12, '#e8973a');
    }
  }

  // Selected wall handles + dimension.
  if (selection && selection.kind === 'wall') {
    const wl = prop.walls.find(w => w.id === selection.id);
    if (wl) {
      for (const p of [[wl.ax, wl.ay], [wl.bx, wl.by]]) {
        const s = w2s(p);
        ctx.fillStyle = '#e8973a';
        ctx.fillRect(s[0] - 4.5, s[1] - 4.5, 9, 9);
        ctx.strokeStyle = '#0c1013';
        ctx.strokeRect(s[0] - 4.5, s[1] - 4.5, 9, 9);
      }
    }
  }
}

function drawWall(wl) {
  const L = Math.hypot(wl.bx - wl.ax, wl.by - wl.ay);
  if (L < 0.001) return;
  const ux = (wl.bx - wl.ax) / L, uy = (wl.by - wl.ay) / L;
  const nx = -uy * wl.thickness / 2, ny = ux * wl.thickness / 2;
  const sel = selection && selection.kind === 'wall' && selection.id === wl.id;
  const corners = [
    w2s([wl.ax + nx, wl.ay + ny]), w2s([wl.bx + nx, wl.by + ny]),
    w2s([wl.bx - nx, wl.by - ny]), w2s([wl.ax - nx, wl.ay - ny]),
  ];
  ctx.beginPath();
  corners.forEach((c, i) => i ? ctx.lineTo(c[0], c[1]) : ctx.moveTo(c[0], c[1]));
  ctx.closePath();
  ctx.fillStyle = hexA(matColor(wl.material), sel ? 0.5 : 0.32);
  ctx.fill();
  ctx.strokeStyle = sel ? '#e8973a' : '#dfe7ee66';
  ctx.lineWidth = sel ? 2 : 1;
  ctx.stroke();
  if (sel || dimsOn) {
    const mid = w2s([(wl.ax + wl.bx) / 2, (wl.ay + wl.by) / 2]);
    label(fmtLen(L), mid[0] - ny * 1 * 0 + (-uy) * 14, mid[1] - 14, sel ? '#e8973a' : '#8b9aa7');
  }
}

function drawOpening(o) {
  const p = openingPos(o);
  if (!p) return;
  const { w, ux, uy } = p;
  const sel = selection && selection.kind === 'opening' && selection.id === o.id;
  const half = o.width / 2;
  const nx = -uy, ny = ux;
  const th = w.thickness / 2;
  // Blank the wall band.
  const c = [
    w2s([p.cx - ux * half + nx * (th + 0.004), p.cy - uy * half + ny * (th + 0.004)]),
    w2s([p.cx + ux * half + nx * (th + 0.004), p.cy + uy * half + ny * (th + 0.004)]),
    w2s([p.cx + ux * half - nx * (th + 0.004), p.cy + uy * half - ny * (th + 0.004)]),
    w2s([p.cx - ux * half - nx * (th + 0.004), p.cy - uy * half - ny * (th + 0.004)]),
  ];
  ctx.beginPath();
  c.forEach((q, i) => i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]));
  ctx.closePath();
  ctx.fillStyle = '#0c1013';
  ctx.fill();

  const col = sel ? '#e8973a' : (o.type === 'door' ? '#c9a06a' : '#5fb3c9');
  ctx.strokeStyle = col;
  ctx.lineWidth = sel ? 2 : 1.4;
  if (o.type === 'door') {
    // Hinge at -half end; leaf + quarter arc.
    const hx = p.cx - ux * half, hy = p.cy - uy * half;
    const leafEnd = [hx + nx * o.width, hy + ny * o.width];
    const hs = w2s([hx, hy]), ls = w2s(leafEnd);
    ctx.beginPath(); ctx.moveTo(hs[0], hs[1]); ctx.lineTo(ls[0], ls[1]); ctx.stroke();
    const a0 = Math.atan2(ny, nx), a1 = Math.atan2(uy, ux);
    ctx.beginPath();
    ctx.setLineDash([3, 3]);
    ctx.arc(hs[0], hs[1], o.width * vs.zoom, a0, a1, a0 > a1);
    ctx.stroke();
    ctx.setLineDash([]);
    // Jamb ticks.
    for (const s of [-half, half]) {
      const j = w2s([p.cx + ux * s, p.cy + uy * s]);
      ctx.beginPath(); ctx.moveTo(j[0] + nx * -6, j[1] + ny * -6); ctx.lineTo(j[0] + nx * 6, j[1] + ny * 6); ctx.stroke();
    }
  } else {
    // Window: triple line across the span.
    for (const off of [-th * 0.7, 0, th * 0.7]) {
      const a = w2s([p.cx - ux * half + nx * off, p.cy - uy * half + ny * off]);
      const b = w2s([p.cx + ux * half + nx * off, p.cy + uy * half + ny * off]);
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    }
  }
}

function label(text, x, y, color) {
  ctx.font = '600 11px ui-monospace, Menlo, monospace';
  const w = ctx.measureText(text).width;
  ctx.fillStyle = '#0c1013dd';
  ctx.fillRect(x - w / 2 - 4, y - 9, w + 8, 15);
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.fillText(text, x, y + 3);
}

// ---------- pointer handling ----------
function canvasPos(e) {
  const r = canvas.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

function onPointerDown(e) {
  if (e.button === 2) return;
  canvas.setPointerCapture(e.pointerId);
  const [sx, sy] = canvasPos(e);
  const [wx, wy] = s2w(sx, sy);

  if (e.button === 1 || spaceDown) {
    drag = { kind: 'pan', sx, sy, panX: vs.panX, panY: vs.panY };
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
    renderInspector();
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
  if (badgeEl) badgeEl.textContent = fmtLen(wx) + ' , ' + fmtLen(wy);

  if (!drag) return;
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
  if (e.key === ' ') { spaceDown = true; e.preventDefault(); return; }
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
function onKeyUp(e) { if (e.key === ' ') spaceDown = false; }

// ---------- tool column / hint ----------
function setTool(t) {
  tool = t;
  drawing = null; roomDraft = null;
  if (t !== 'calibrate') calib = null;
  renderToolCol(); updateHint(); renderInspector();
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

function renderToolCol() {
  const tools = [
    ['select', 'SELECT', 'V'], ['wall', 'WALL', 'W'], ['door', 'DOOR', 'D'],
    ['window', 'WINDOW', 'N'], ['room', 'ROOM', 'R'], ['calibrate', 'CALIBRATE', 'C'],
  ];
  const tc = el.querySelector('.tool-col');
  tc.innerHTML = `
    <div class="tool-head">TOOLS</div>
    ${tools.map(([id, name, key]) =>
      `<button class="tool-btn ${tool === id ? 'active' : ''}" data-tool="${id}">${name}<span class="key">${key}</span></button>`).join('')}
    <div class="tool-sep"></div>
    <div class="tool-head">WALL PRESET</div>
    <div class="seg" style="margin:2px 4px">
      <button class="seg-btn ${wallPreset === 'interior' ? 'active' : ''}" data-preset="interior" style="flex:1">INT</button>
      <button class="seg-btn ${wallPreset === 'exterior' ? 'active' : ''}" data-preset="exterior" style="flex:1">EXT</button>
    </div>
    <div class="tool-sep"></div>
    <div class="tool-head">UNDERLAY</div>
    <button class="tool-btn" data-act="upload">UPLOAD IMAGE</button>
    <input type="file" class="hidden-file" accept="image/*,.pdf">
    <div class="tool-sep"></div>
    <label class="tool-check"><input type="checkbox" ${snapOn ? 'checked' : ''} data-chk="snap"> SNAP</label>
    <label class="tool-check"><input type="checkbox" ${dimsOn ? 'checked' : ''} data-chk="dims"> DIMS</label>
    <div class="tool-sep"></div>
    <button class="tool-btn" data-act="fit">FIT VIEW<span class="key">F</span></button>
    <button class="tool-btn" data-act="undo">UNDO<span class="key">Z</span></button>
    <button class="tool-btn" data-act="redo">REDO</button>
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

function renderInspector() {
  if (!inspEl) return;
  const insp = inspEl;

  if (calib && calib.a && calib.b) {
    const measured = Math.hypot(calib.b[0] - calib.a[0], calib.b[1] - calib.a[1]);
    insp.innerHTML = `<h3>CALIBRATE SCALE</h3>
      <div class="stat-line"><span>Measured on screen</span><b>${fmtLen(measured)}</b></div>
      <div class="field"><label>Real distance (e.g. 12'6" or 3.8m)</label><input type="text" data-cal-input placeholder="12'-6&quot;"></div>
      <button class="btn primary" data-cal-apply>APPLY SCALE</button>
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
      if (prop.walls.length === 0 && prop.rooms.length === 0) { /* nothing else to preserve */ }
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
    insp.innerHTML = `<h3>PROPERTY</h3>
      <div class="field"><label>Name</label><input type="text" data-prop-name value="${escapeHtml(prop.name)}"></div>
      ${lenField('Default wall height', prop.wallHeight, 'wallHeight')}
      <div class="tool-sep" style="border-top:1px solid var(--line); margin:10px 0"></div>
      <div class="stat-line"><span>Walls</span><b>${prop.walls.length}</b></div>
      <div class="stat-line"><span>Openings</span><b>${prop.openings.length}</b></div>
      <div class="stat-line"><span>Rooms</span><b>${prop.rooms.length}</b></div>
      <div class="stat-line"><span>Total wall run</span><b>${fmtLen(totalWall)}</b></div>
      <div class="stat-line"><span>Floor area</span><b>${fmtArea(floorArea)}</b></div>
      <div class="empty" style="margin-top:12px">Select an element to edit it, or use the tools to draw.<br><br>W wall, D door, N window, R room.</div>`;
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
    insp.innerHTML = `<h3>WALL</h3>
      ${lenField('Length', L, 'len')}
      ${lenField('Thickness', w.thickness, 'th')}
      ${lenField('Height (blank = default)', w.height, 'h', fmtLen(prop.wallHeight))}
      <div class="field"><label>Material</label>${materialSelectHtml('wall', w.material, 'data-mat')}</div>
      ${scopeAssignHtml(w.id)}
      <div class="stat-line"><span>Face area</span><b>${fmtArea(L * (w.height || prop.wallHeight))}</b></div>
      <button class="btn danger" data-del>DELETE WALL</button>`;
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
    insp.innerHTML = `<h3>${o.type === 'door' ? 'DOOR' : 'WINDOW'}</h3>
      <div class="field"><label>Type</label>
        <select data-type><option value="door" ${o.type === 'door' ? 'selected' : ''}>Door</option>
        <option value="window" ${o.type === 'window' ? 'selected' : ''}>Window</option></select></div>
      ${lenField('Width', o.width, 'w')}
      ${lenField('Height', o.height, 'h')}
      ${o.type === 'window' ? lenField('Sill height', o.sill || 0, 's') : ''}
      <div class="field"><label>Position along wall</label>
        <input type="range" min="0.02" max="0.98" step="0.005" value="${o.t}" data-t></div>
      <button class="btn danger" data-del>DELETE</button>`;
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
    insp.innerHTML = `<h3>ROOM</h3>
      <div class="field"><label>Name</label><input type="text" data-name value="${escapeHtml(r.name || '')}"></div>
      <div class="field"><label>Floor material</label>${materialSelectHtml('floor', r.material, 'data-mat')}</div>
      ${scopeAssignHtml(r.id)}
      <div class="stat-line"><span>Area</span><b>${fmtArea(polyArea(r.pts))}</b></div>
      <div class="stat-line"><span>Perimeter</span><b>${fmtLen(r.pts.reduce((n, p, i) => n + Math.hypot(p[0] - r.pts[(i + 1) % r.pts.length][0], p[1] - r.pts[(i + 1) % r.pts.length][1]), 0))}</b></div>
      <button class="btn danger" data-del>DELETE ROOM</button>`;
    insp.querySelector('[data-name]').onchange = e => { r.name = e.target.value; touch(); };
    insp.querySelector('[data-mat]').onchange = e => { r.material = e.target.value || null; touch(); };
    insp.querySelector('[data-del]').onclick = deleteSelection;
    bindAssign(insp);
    return;
  }

  if (selection.kind === 'underlay') {
    const pl = prop.plan;
    if (!pl) { selection = null; return renderInspector(); }
    insp.innerHTML = `<h3>PLAN UNDERLAY</h3>
      <div class="field"><label>Opacity</label>
        <input type="range" min="0.1" max="1" step="0.05" value="${pl.opacity}" data-op></div>
      <div class="stat-line"><span>Image</span><b>${pl.imgW} x ${pl.imgH} px</b></div>
      <div class="stat-line"><span>Scale</span><b>${(pl.mPerPx * 100).toFixed(2)} cm/px</b></div>
      <div class="stat-line"><span>Calibrated</span><b>${pl.calibrated ? 'yes' : 'NO - use CALIBRATE'}</b></div>
      <div class="empty" style="margin:10px 0">Drag the image with the select tool to align it with your walls. Use CALIBRATE (C) to set true scale from a known dimension.</div>
      <button class="btn danger" data-del>REMOVE UNDERLAY</button>`;
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
      <p class="muted">No property yet. Create one from the PROPERTY selector in the top bar.</p></div>`;
    return;
  }
  root.innerHTML = `
    <div class="editor-layout">
      <div class="tool-col"></div>
      <div class="canvas-wrap">
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

  vs = viewByProp[prop.id];
  if (!vs) { vs = viewByProp[prop.id] = { zoom: 60, panX: 0, panY: 0 }; requestAnimationFrame(() => { fitView(); }); }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('dblclick', onDblClick);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  renderToolCol();
  renderInspector();
  updateHint();

  const loop = () => { draw(); raf = requestAnimationFrame(loop); };
  raf = requestAnimationFrame(loop);
}

export function unmount() {
  cancelAnimationFrame(raf);
  window.removeEventListener('keydown', onKeyDown);
  window.removeEventListener('keyup', onKeyUp);
  drawing = null; roomDraft = null; drag = null;
  el = null; canvas = null; ctx = null; inspEl = null;
}
