// Trim drawings as SVG strings: each wall as seen from inside the room with every piece and its
// mark, and the store boards cut for it, every board drawn to one scale with each cut's long-point
// length dimensioned under it. Ported from the wall trim package template (package.py).
//
// Pure: they read an estimate from trim-estimate.js and return markup. Clickable parts carry
// data-d="piece:<mark>" and data-d="stick:<board key>" so a view can open their details.
// Size: { fluid: true } draws at the container's width (screen); otherwise width/height are given
// in `unit` (default 'pt', for print).

import { ftin, soldText } from './trim-estimate.js';

const IN = 0.0254;
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' })[c]);
// text content that holds only a length or a fixed word: quotes are safe there and stay as typed
const txt = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const f4 = v => v.toFixed(4), f3 = v => v.toFixed(3);
const sizeAttr = (W, H, opts) => opts.fluid ? 'width="100%" preserveAspectRatio="xMinYMin meet"'
  : `width="${opts.width ? opts.width.toFixed(1) : W.toFixed(1)}${opts.unit || 'pt'}" height="${opts.width ? (opts.width * H / W).toFixed(1) : H.toFixed(1)}${opts.unit || 'pt'}"`;

// Each side of a mitred frame as its own four-sided shape.
function frameSides(poly, W, sidePcs) {
  const n = poly.length;
  let area = 0;
  for (let i = 0; i < n; i++) area += poly[i][0] * poly[(i + 1) % n][1] - poly[(i + 1) % n][0] * poly[i][1];
  const sg = area > 0 ? 1 : -1, lines = [];
  for (let i = 0; i < n; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % n], dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy);
    lines.push([[x1 - dy / L * W * sg, y1 + dx / L * W * sg], [dx, dy]]);
  }
  const isect = ([[px, py], [dx, dy]], [[qx, qy], [ex, ey]]) => {
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-12) return [qx, qy];
    const t = ((qx - px) * ey - (qy - py) * ex) / den;
    return [px + dx * t, py + dy * t];
  };
  const inner = poly.map((_, i) => isect(lines[(i + n - 1) % n], lines[i]));
  const quads = poly.map((_, i) => [poly[i], poly[(i + 1) % n], inner[(i + 1) % n], inner[i]]);
  const names = n === 4 ? ['bottom', 'right', 'top', 'left'] : [];
  const out = [];
  for (const q of sidePcs) {
    let i;
    if (q.seg) {
      const [[ax, ay], [bx, by]] = q.seg, d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
      let best = Infinity;
      for (let k = 0; k < n; k++) {
        const v = Math.min(d([ax, ay], poly[k]) + d([bx, by], poly[(k + 1) % n]), d([bx, by], poly[k]) + d([ax, ay], poly[(k + 1) % n]));
        if (v < best) { best = v; i = k; }
      }
    } else if (names.includes(q.side)) i = names.indexOf(q.side);
    else continue;
    out.push([quads[i], q]);
  }
  return out;
}

// One wall as seen from inside the room: wall, openings with casings, every trim piece with its mark.
// wall: an entry of est.walls. opts: { maxW, maxH } (points, or pixels when fluid), fluid, unit.
export function elevationSvg(wall, est, opts = {}) {
  const maxW = opts.maxW || 640, maxH = opts.maxH || 300;
  const pad = 0.06, x0 = wall.h0 - pad, x1 = wall.h1 + pad, H = wall.H;
  const spanW = x1 - x0, spanH = H + 2 * pad + .2;
  const s = Math.min(maxW / spanW, maxH / spanH);
  const fs = 5.6 / s;
  const Y = v => H + pad - v;
  const lw = pt => (pt / s).toFixed(5);
  const o = [`<svg class="elev" viewBox="${f4(x0)} 0 ${f4(spanW)} ${f4(spanH)}" ${sizeAttr(spanW * s, spanH * s, { ...opts, width: null })} xmlns="http://www.w3.org/2000/svg" data-wall="${esc(wall.id)}">`];
  o.push(`<rect x="${f4(wall.h0)}" y="${f4(Y(H))}" width="${f4(wall.h1 - wall.h0)}" height="${f4(H)}" class="ev-wall" stroke-width="${lw(.5)}"/>`);
  for (const op of wall.openings || []) {
    o.push(`<rect x="${f4(op.c0)}" y="${f4(Y(op.cv1))}" width="${f4(op.c1 - op.c0)}" height="${f4(op.cv1 - op.cv0)}" class="ev-case" stroke-width="${lw(.4)}"/>`);
    o.push(`<rect x="${f4(op.h0)}" y="${f4(Y(op.v1))}" width="${f4(op.h1 - op.h0)}" height="${f4(op.v1 - op.v0)}" class="ev-open" stroke-width="${lw(.4)}"/>`);
    if (op.type === 'window') {
      const mid = (op.v0 + op.v1) / 2;
      o.push(`<line x1="${f4(op.h0)}" x2="${f4(op.h1)}" y1="${f4(Y(mid))}" y2="${f4(Y(mid))}" class="ev-sash" stroke-width="${lw(.4)}"/>`);
    }
  }
  const pcs = est.pieces.filter(p => p.wall === wall.id);
  const W = pid => est.catalog[pid].W;
  const labels = [], framesDone = new Set();
  const pc = (pts, q, w) => `<polygon points="${pts}" class="ev-pc" data-d="piece:${esc(q.mark)}" stroke-width="${lw(w)}"><title>${esc(q.name)}</title></polygon>`;
  for (const p of pcs) {
    if (p.poly && p.kind === 'frame') {
      const k = JSON.stringify([p.stairFace, p.frame]);
      if (framesDone.has(k)) continue;
      framesDone.add(k);
      const side = pcs.filter(q => q.stairFace === p.stairFace && q.frame === p.frame);
      for (const [quad, q] of frameSides(p.poly, W(p.product), side)) o.push(pc(quad.map(([u, v]) => `${f4(u)},${f4(Y(v))}`).join(' '), q, .4));
      const cx = p.poly.reduce((a, [u]) => a + u, 0) / p.poly.length, cy = p.poly.reduce((a, [, v]) => a + v, 0) / p.poly.length;
      const marks = [...new Set(side.map(q => q.mark))].sort();
      labels.push([cx, cy, marks.map(m => m.split('-')[1]).join(' ')]);
    } else if (p.poly) {
      o.push(pc(p.poly.map(([u, v]) => `${f4(u)},${f4(Y(v))}`).join(' '), p, .5));
      labels.push([p.poly.reduce((a, [u]) => a + u, 0) / 4, p.poly.reduce((a, [, v]) => a + v, 0) / 4, p.mark]);
    } else if (p.kind === 'frame') {
      const k = JSON.stringify([p.section, p.frame]);
      if (framesDone.has(k)) continue;
      framesDone.add(k);
      const [a, b, c, d] = [p.h0, p.h1, p.v0, p.v1];
      const side = pcs.filter(q => q.section === p.section && q.frame === p.frame);
      for (const [quad, q] of frameSides([[a, c], [b, c], [b, d], [a, d]], W(p.product), side)) o.push(pc(quad.map(([u, v]) => `${f4(u)},${f4(Y(v))}`).join(' '), q, .3));
      const tb = (side.find(q => q.side === 'top') || p).mark, lr = (side.find(q => q.side === 'left') || p).mark;
      labels.push([(a + b) / 2, (c + d) / 2, `${tb.split('-')[1]}/${lr.split('-')[1]}`]);
    } else {
      o.push(`<rect x="${f4(p.h0)}" y="${f4(Y(p.v1))}" width="${f4(p.h1 - p.h0)}" height="${f4(p.v1 - p.v0)}" class="ev-pc" data-d="piece:${esc(p.mark)}" stroke-width="${lw(.4)}"><title>${esc(p.name)}</title></rect>`);
      if (p.kind === 'batten') continue;
      labels.push([(p.h0 + p.h1) / 2, (p.v0 + p.v1) / 2, p.mark]);
    }
  }
  const bm = new Map();
  for (const p of pcs) if (p.kind === 'batten') { if (!bm.has(p.mark)) bm.set(p.mark, []); bm.get(p.mark).push(p); }
  for (const [m, lst] of bm) {
    lst.sort((a, b) => a.h0 - b.h0);
    const mid = lst[Math.floor(lst.length / 2)];
    labels.push([(mid.h0 + mid.h1) / 2, (mid.v0 + mid.v1) / 2, `${m} ×${lst.length}`]);
  }
  const placed = [];
  const sorted = labels.map((l, i) => ({ l, i })).sort((a, b) => a.l[1] - b.l[1] || a.i - b.i).map(x => x.l);
  for (let [x, y, t] of sorted) {
    const half = t.length * fs * .62 / 2;
    x = wall.h1 - wall.h0 > 2 * half ? Math.min(Math.max(x, wall.h0 + half), wall.h1 - half) : (wall.h0 + wall.h1) / 2;
    while (placed.some(([px, py, ph]) => Math.abs(x - px) < half + ph && Math.abs(y - py) < fs * 1.05)) y += fs * 1.1;
    placed.push([x, y, half]);
    o.push(`<text x="${f4(x)}" y="${f4(Y(y) + fs * .35)}" font-size="${f4(fs)}" text-anchor="middle" class="lb" stroke-width="${lw(1.6)}">${esc(t)}</text>`);
  }
  const yd = Y(0) + pad + .09;
  o.push(`<line x1="${f4(wall.h0)}" x2="${f4(wall.h1)}" y1="${f4(yd)}" y2="${f4(yd)}" class="ev-dim" stroke-width="${lw(.4)}"/>`);
  for (const xx of [wall.h0, wall.h1]) o.push(`<line x1="${f4(xx)}" x2="${f4(xx)}" y1="${f4(yd - .04)}" y2="${f4(yd + .04)}" class="ev-dim" stroke-width="${lw(.4)}"/>`);
  o.push(`<text x="${f4((wall.h0 + wall.h1) / 2)}" y="${f4(yd + fs * 1.05)}" font-size="${f4(fs)}" text-anchor="middle" class="dm">${txt(ftin(wall.h1 - wall.h0))}</text>`);
  o.push('</svg>');
  return o.join('');
}

// Identical boards (same product, length and cuts) drawn once with a count.
export function stickGroups(boards) {
  const out = new Map();
  for (const s of boards) {
    const k = JSON.stringify([s.product, s.stockIn, s.how, s.cuts.map(c => [c.mark, c.wall]).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)]);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(s);
  }
  return [...out.values()];
}
export function stickLabel(lst) {
  const nums = lst.map(s => parseInt(s.id.split(' ').pop(), 10)), name = lst[0].id.split(' ').slice(0, -1).join(' ');
  if (nums.length === 1) return `${name} ${nums[0]}`;
  const run = nums.every((n, i) => n === nums[0] + i);
  return run ? `${name} ${nums[0]}–${nums[nums.length - 1]}` : `${name} ` + nums.join(', ');
}
const textW = (t, size) => t.length * size * .56;
function fit(t, room, size) {
  if (textW(t, size) <= room) return t;
  const n = Math.floor(room / (size * .56)) - 1;
  return n >= 4 ? t.slice(0, n).replace(/[ ·,]+$/, '') + '…' : '';
}
let patN = 0;

// Boards of one product and length, stacked under one overall dimension, drawn to one scale
// (the longest board in the estimate, est.lmax, unless opts.lmax). groups: from stickGroups().
// opts: { fs (dimension text, inches at the drawing's scale; 1.9 print, 2.3 screen), shortNames, lmax, fluid, width, unit }.
export function cutSvg(groups, wallId, est, opts = {}) {
  const fs = opts.fs || 2.3, shortNames = opts.shortNames !== false, TRIM = est.constants.trim;
  const pid = `cdh${++patN}`;
  const L = groups[0][0].stockIn, pad = 1.2;
  const h = 1.8 * fs, fl = .9 * fs, fn = .8 * fs, tk = .32 * fs;
  const W = (opts.lmax || est.lmax) + 2 * pad;
  const X = x => pad + x;
  const o = [];
  const yd = fs * 1.15;
  o.push(`<text x="${f3(X(L / 2))}" y="${f3(yd - .3 * fs)}" font-size="${f3(fs)}" text-anchor="middle" class="cd-dt cd-all">${txt(ftin({ inches: L }))}</text>`);
  o.push(`<line x1="${f3(X(0) - tk)}" x2="${f3(X(L) + tk)}" y1="${f3(yd)}" y2="${f3(yd)}" class="cd-dim"/>`);
  const tops = [], rows = [];
  let y = yd + .55 * fs;
  for (const lst of groups) {
    const s = lst[0];
    const lab = stickLabel(lst) + (s.how === 'foot' ? ' · cut at the store' : '') + (lst.length > 1 ? ` · ${lst.length} boards cut alike` : '');
    const yl = y + fl, ys = yl + .45 * fs, yb = ys + h;
    tops.push(ys);
    const g = [`<g class="cd-b" data-stick="${esc(s.key)}">`];
    g.push(`<text x="${f3(X(0))}" y="${f3(yl)}" font-size="${f3(fl)}" class="cd-lb" data-d="stick:${esc(s.key)}">${esc(lab)}</text>`);
    g.push(`<rect x="${f3(X(0))}" y="${f3(ys)}" width="${f3(L)}" height="${f3(h)}" class="cd-board" data-d="stick:${esc(s.key)}"><title>${esc(stickLabel(lst))}: ${txt(ftin({ inches: L }))} board</title></rect>`);
    for (const x0 of [0, L - TRIM]) g.push(`<rect x="${f3(X(x0))}" y="${f3(ys)}" width="${f3(TRIM)}" height="${f3(h)}" class="cd-trim" fill="url(#${pid})"/>`);
    const dims = [];
    for (const c of s.cuts) {
      const x0 = c.longAt, x1 = x0 + c.lin;
      const kl = c.kindL, wl = c.wedgeL, kr = c.kindR, wr = c.wedgeR;
      const tl = x0 + (kl !== 'square' ? wl : 0);
      const tr = kr === 'bevel' ? x1 - wr : kr === 'plumb' ? x1 + wr : x1;
      const oth = c.wall !== wallId;
      g.push(`<polygon points="${f3(X(x0))},${f3(yb)} ${f3(X(x1))},${f3(yb)} ${f3(X(tr))},${f3(ys)} ${f3(X(tl))},${f3(ys)}" class="cd-cut${oth ? ' oth' : ''}" data-d="piece:${esc(c.mark)}"><title>${esc(c.name)}: ${txt(ftin({ inches: c.lin }))}, ends ${esc(c.endL)} / ${esc(c.endR)}</title></polygon>`);
      if (kl !== 'square') g.push(`<polygon points="${f3(X(x0))},${f3(ys)} ${f3(X(tl))},${f3(ys)} ${f3(X(x0))},${f3(yb)}" class="cd-wedge" fill="url(#${pid})"/>`);
      if (kr === 'bevel') g.push(`<polygon points="${f3(X(x1))},${f3(ys)} ${f3(X(tr))},${f3(ys)} ${f3(X(x1))},${f3(yb)}" class="cd-wedge" fill="url(#${pid})"/>`);
      if (kr === 'plumb') g.push(`<polygon points="${f3(X(x1))},${f3(yb)} ${f3(X(tr))},${f3(yb)} ${f3(X(tr))},${f3(ys)}" class="cd-wedge" fill="url(#${pid})"/>`);
      const nm = shortNames && !oth && c.name.includes(' · ') ? c.name.split(' · ').slice(1).join(' · ') : c.name;
      const t = fit(nm, (x1 - x0) - .6 * fs, fn);
      if (t) g.push(`<text x="${f3(X((x0 + x1) / 2))}" y="${f3(ys + h / 2 + fn * .36)}" font-size="${f3(fn)}" text-anchor="middle" class="cd-nm${oth ? ' oth' : ''}">${esc(t)}</text>`);
      dims.push([x0, x1, ftin({ inches: c.lin }), '']);
    }
    const end = s.end;
    if (s.drop > 1 / 32) {
      const word = s.drop < 12 ? 'waste' : 'offcut';
      g.push(`<rect x="${f3(X(end))}" y="${f3(ys)}" width="${f3(L - TRIM - end)}" height="${f3(h)}" class="cd-off"><title>${word} ${txt(ftin({ inches: s.drop }))}</title></rect>`);
      dims.push([end, L - TRIM, `${word} ${ftin({ inches: s.drop })}`, ' cd-wt']);
    }
    const yl0 = yb + 1.45 * fs, placed = {};
    let nrow = 0;
    for (const [a, b, t, cls] of dims) {
      g.push(`<line x1="${f3(X(a))}" x2="${f3(X(b))}" y1="${f3(yl0)}" y2="${f3(yl0)}" class="cd-dim${cls}"/>`);
      for (const xx of [a, b]) {
        g.push(`<line x1="${f3(X(xx))}" x2="${f3(X(xx))}" y1="${f3(yb + .15 * fs)}" y2="${f3(yl0 + .35 * fs)}" class="cd-ext"/>`);
        g.push(`<line x1="${f3(X(xx) - tk)}" x2="${f3(X(xx) + tk)}" y1="${f3(yl0 + tk)}" y2="${f3(yl0 - tk)}" class="cd-tick"/>`);
      }
      const tw = textW(t, fs);
      let cx = (a + b) / 2;
      if (tw + .3 * fs <= b - a) { g.push(`<text x="${f3(X(cx))}" y="${f3(yl0 - .28 * fs)}" font-size="${f3(fs)}" text-anchor="middle" class="cd-dt${cls}">${esc(t)}</text>`); continue; }
      cx = Math.min(Math.max(cx, tw / 2), L - tw / 2);
      let r = 1;
      while ((placed[r] || []).some(([px, pw]) => Math.abs(cx - px) < (tw + pw) / 2 + .4 * fs)) r++;
      (placed[r] = placed[r] || []).push([cx, tw]); nrow = Math.max(nrow, r);
      const yt = yl0 + r * 1.2 * fs + .25 * fs;
      g.push(`<line x1="${f3(X((a + b) / 2))}" x2="${f3(X(cx))}" y1="${f3(yl0)}" y2="${f3(yt - .85 * fs)}" class="cd-lead"/>`);
      g.push(`<text x="${f3(X(cx))}" y="${f3(yt)}" font-size="${f3(fs)}" text-anchor="middle" class="cd-dt${cls}">${esc(t)}</text>`);
    }
    g.push('</g>');
    rows.push(g.join(''));
    y = yl0 + nrow * 1.2 * fs + .9 * fs;
  }
  for (const xx of [0, L]) {
    o.push(`<line x1="${f3(X(xx))}" x2="${f3(X(xx))}" y1="${f3(yd - .4 * fs)}" y2="${f3(tops[0] - .1 * fs)}" class="cd-ext"/>`);
    o.push(`<line x1="${f3(X(xx) - tk)}" x2="${f3(X(xx) + tk)}" y1="${f3(yd + tk)}" y2="${f3(yd - tk)}" class="cd-tick"/>`);
  }
  const Hh = y + .2 * fs;
  const defs = `<defs><pattern id="${pid}" patternUnits="userSpaceOnUse" width="${f3(.45 * fs)}" height="${f3(.45 * fs)}" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="${f3(.45 * fs)}" class="cd-hatch"/></pattern></defs>`;
  const size = opts.fluid ? sizeAttr(W, Hh, opts) : sizeAttr(W, Hh, { ...opts, width: opts.width || 7.35 * 72 });
  return `<svg class="cutsvg" viewBox="0 0 ${f3(W)} ${f3(Hh)}" ${size} xmlns="http://www.w3.org/2000/svg">` + defs + o.join('') + rows.join('') + '</svg>';
}

// A wall's boards: one stack per product and length, longest first, each under a heading.
export function cutsHtml(boards, wallId, est, opts = {}) {
  const by = new Map();
  for (const g of stickGroups(boards)) {
    const k = JSON.stringify([est.prodOrder.indexOf(g[0].product), g[0].how === 'foot' ? 1 : 0, -g[0].stockIn]);
    if (!by.has(k)) by.set(k, { k: JSON.parse(k), gs: [] });
    by.get(k).gs.push(g);
  }
  const keys = [...by.values()].sort((a, b) => a.k[0] - b.k[0] || a.k[1] - b.k[1] || a.k[2] - b.k[2]);
  return keys.map(({ k, gs }) => {
    const pid = gs[0][0].product, n = gs.reduce((a, g) => a + g.length, 0), c = est.catalog[pid];
    const kit = est.kits.includes(pid), foot = k[1] === 1;
    const what = kit ? 'kit rails' : foot ? 'lengths cut at the store' : 'boards';
    return `<div class="cdg"><div class="cdh"><b>${esc(c.short)}</b> · ${txt(ftin({ inches: -k[2] }))} ${what} · ${n} · <span>${esc(soldText(est.sale[pid], kit))}</span></div>${cutSvg(gs, wallId, est, opts)}</div>`;
  }).join('');
}
