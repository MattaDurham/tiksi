// Trim estimate: every piece of a property's drawn wall trim, the store boards it is cut from, the
// labor hours, the supplies and the price, worked out from the drawing.
//
// Ported from the wall trim package template (package.py and extract.mjs, 2026-11-17) and checked
// against it to the cent. Pure functions: no DOM and no workspace state. The views pass in the
// property, its projects and a trimDesign (trim-design.js) built the way MODEL builds it.
//
//   trimPieces()    each physical piece of the chosen trim sections, placed on its wall face, and the
//                   wall faces themselves (openings with their casings), as seen from inside the room
//   estimateTrim()  ends (cope, into corner, miter, scarf), piece marks and plain names, long-point
//                   lengths, store boards bought at the cheapest length that holds their cuts, each
//                   room cut from its own boards, the buy list with spares, labor hours from production
//                   rates, supplies counted from job measures, contingency, and the option scenarios
//
// Lengths: pieces and faces in metres (Tiksi's own units); cut lengths, boards and store lengths in
// inches, as the trade and the stores sell them. ftin() quotes either to the nearest 1/16".

import { trimProduct, openingBlocks, frameGaps } from './trims.js';
import { catalogItem } from './trim-catalog.js';
import { ESTIMATE_DATA } from './estimate-data.js';

const IN = 0.0254;
export const KERF = 0.125, TRIM_END = 0.5;      // inches: saw kerf; trimmed off each factory end
export const MIN_GAP = 0.5, MAX_GAP = 1.0;      // inches between cuts on a board
const RAILS_PER_KIT = 2;
const DAY_HOURS = 6.0;                          // productive hours in a room-day, for setup and cleanup
export const SETTINGS_DEFAULT = { laborRate: 85, contingency: 0.10, sparePerMoulding: 1, stockCapIn: 144, stockStretchIn: 156, priceOverrides: {}, stock: {}, itemPrefix: '' };

// ---------- Python-compatible helpers (the template's numbers are matched exactly) ----------
// round() as Python does it: the exact binary value rounded, an exact tie to the even neighbour.
export function pyRound(x, nd = 0) {
  if (!Number.isFinite(x)) return x;
  if (nd === 0) {
    const f = Math.floor(x), d = x - f;
    if (d === 0.5) return f % 2 === 0 ? f : f + 1;
    return Math.round(x);
  }
  const exact = Math.abs(x).toFixed(Math.min(100, nd + 60));
  const dot = exact.indexOf('.'), tail = exact.slice(dot + 1 + nd);
  if (/^50*$/.test(tail)) {
    const head = Number(exact.slice(0, dot + 1 + nd));
    const unit = 10 ** -nd, last = Math.round(head / unit) % 2;
    const v = last === 0 ? head : head + unit;
    return Number((x < 0 ? -v : v).toFixed(nd));
  }
  return Number(x.toFixed(nd));
}
const sum = (arr, f = v => v) => { let s = 0; for (const v of arr) s += f(v); return s; };
// compare two tuples the way Python orders them
function cmpT(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (i >= a.length) return -1;
    if (i >= b.length) return 1;
    const x = a[i], y = b[i];
    if (x === y) continue;
    if (typeof x === 'boolean' || typeof y === 'boolean') return (x ? 1 : 0) - (y ? 1 : 0);
    if (typeof x === 'number' && typeof y === 'number') return x < y ? -1 : 1;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}
const sortBy = (arr, key) => arr.map((v, i) => ({ v, i, k: key(v) })).sort((a, b) => cmpT(a.k, b.k) || a.i - b.i).map(x => x.v);
const minBy = (arr, key) => { let best = null, bk = null; for (const v of arr) { const k = key(v); if (best === null || cmpT(k, bk) < 0) { best = v; bk = k; } } return best; };
const maxBy = (arr, key) => { let best = null, bk = null; for (const v of arr) { const k = key(v); if (best === null || cmpT(k, bk) > 0) { best = v; bk = k; } } return best; };
const fmtG = x => String(Number(Number(x).toPrecision(6)));
const gcd = (a, b) => b ? gcd(b, a % b) : a;

// Feet and inches to the nearest 1/16": 3'-1 3/4", 6'-3/4", 8'-0", 11 1/2", 5/8".
// ftin(metres) or ftin({ inches }).
export function ftin(m, o) {
  const x = m && typeof m === 'object' ? m.inches : o && o.inches != null ? o.inches : m / IN;
  const n16 = pyRound(x * 16), ft = Math.floor(n16 / 192), rem = n16 - ft * 192, whole = Math.floor(rem / 16), f16 = rem - whole * 16;
  const g = f16 ? gcd(f16, 16) : 1, frac = f16 ? `${f16 / g}/${16 / g}` : '';
  if (ft === 0) return (whole && frac ? `${whole} ${frac}` : whole ? String(whole) : frac || '0') + '"';
  return `${ft}'-` + (whole && frac ? `${whole} ${frac}` : frac ? frac : String(whole)) + '"';
}
export const money = v => '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const CUT = { 'square': 'square', 'inside corner': 'cope', 'into corner': 'square into corner', 'outside corner': 'miter 45°', 'joint': 'square butt',
  'check on site': 'check on site', 'miter 45°': 'miter 45°', 'scarf': 'scarf 45°' };
export const cutWord = e => CUT[e] || e;
export const ROLE_WORD = { base: 'baseboard', chair: 'chair rail', cap: 'wainscot cap', panel: 'panel moulding', batten: 'batten' };
export const PART_WORD = { topRail: 'top rail', bottomRail: 'bottom rail', stile: 'stile' };
const ROLE = { 'baseboard': 'base', 'chair-rail': 'chair', 'wainscot-cap': 'cap' };
export const ROLE_ORDER = ['base', 'chair', 'cap', 'panel', 'shaker', 'raised', '1x6', '1x4', 'batten'];
const SHORTN = { base: 'Base', chair: 'Chair rail', cap: 'Cap', panel: 'Panel', batten: 'Batten', shaker: 'Shaker kit', raised: 'Panel kit', '1x4': '1x4', '1x6': '1x6' };
const SIDE_WORD = { top: 'top', bottom: 'bottom', left: 'left side', right: 'right side', 'upright left': 'left upright', 'upright right': 'right upright', upright: 'upright side', level: 'level side', raked: 'sloped side' };
const ordinal = n => ({ 1: '1st', 2: '2nd', 3: '3rd' })[n] || `${n}th`;

export function roleOf(c) {
  if (ROLE[c.style]) return ROLE[c.style];
  if (c.style === 'board') return String(c.short || '').split(/\s+/)[0];
  if (String(c.short || '').toLowerCase().includes('batten') || c.style === 'board-batten') return 'batten';
  if (String(c.short || '').toLowerCase().includes('panel') || c.style === 'picture-frame' || c.style === 'panel-moulding') return 'panel';
  return c.style;
}
// The store length of a catalog entry, inches ("96 in (8 ft) piece", "12 ft board"); null when it gives none.
export function stockInches(c) {
  const m = /([\d.]+)\s*(in|ft)/.exec(String(c && c.length || ''));
  return m ? parseFloat(m[1]) * (m[2] === 'ft' ? 12 : 1) : null;
}
export const isKit = c => String(c && c.length || '').toLowerCase().includes('kit for');

// ---------- step 1: the pieces, from the drawing ----------
// design: trimDesign({ prop, projects, levelOf, wallsOn, roomsOn, openingsOn, heightOf }) built as MODEL does.
// include(t): which trim sections to take (default all). Returns { pieces, faces } in metres.
export function trimPieces({ prop, projects = [], design, include = null }) {
  const projById = Object.fromEntries((projects || []).map(p => [p.id, p]));
  const roomById = Object.fromEntries((prop.rooms || []).map(r => [r.id, r]));
  const pieces = [], faces = new Map(), skipped = [];
  const end = (atFaceEnd, faceEnd, wallEnd, mitre) => {
    if (!atFaceEnd) return 'square';
    const over = wallEnd === 0 ? -faceEnd : faceEnd - wallEnd;
    if (over > 1e-3) return 'outside corner';
    if (over < -1e-3) return 'inside corner';
    return mitre ? 'corner' : 'square';
  };
  const faceName = n => String(n || '').split(':')[0].trim();
  for (const t of prop.trims || []) {
    if (include && !include(t)) continue;
    const i = design.info(t), lay = i && design.layout(t), p = trimProduct(t);
    if (!i || !p || !lay) { skipped.push(t.id); continue; }
    const pr = projById[t.projectId], pRoom = pr && pr.roomId && roomById[pr.roomId];
    const room = pRoom ? pRoom.name || 'Room' : i.roomName || 'No room';
    const roomId = pRoom ? pRoom.id : i.roomId || '';
    const flip = t.side === -1;
    const H = i.H, L = i.L;
    const hx = x => flip ? L - x : x;
    const key = t.wallId + '|' + (flip ? -1 : 1);
    if (!faces.has(key)) {
      const ux = (i.wall.bx - i.wall.ax) / L, uy = (i.wall.by - i.wall.ay) / L;
      const ops = [];
      for (const o of prop.openings || []) {
        if (o.wallId !== t.wallId) continue;
        const b = openingBlocks(i.wall, [o], L, H)[0];
        if (!b) continue;
        const ow = Math.min(o.width || 0, L), c = Math.min(Math.max((o.t || 0) * L, ow / 2), L - ow / 2);
        const sill = o.type === 'window' ? Math.max(0, o.sill || 0) : 0;
        const [a0, a1] = [hx(c - ow / 2), hx(c + ow / 2)].sort((m, n) => m - n);
        const [b0, b1] = [hx(b.x0), hx(b.x1)].sort((m, n) => m - n);
        ops.push({ id: o.id, type: o.type, h0: a0, h1: a1, v0: sill, v1: Math.min(H, sill + (o.height || 0)), c0: b0, c1: b1, cv0: b.y0, cv1: b.y1 });
      }
      const [f0, f1] = [hx(i.x0), hx(i.x1)].sort((m, n) => m - n);
      faces.set(key, { key, wallId: t.wallId, side: flip ? -1 : 1, room, roomId, names: [], L, H, h0: f0, h1: f1, openings: ops,
        a: [i.wall.ax, i.wall.ay], u: [ux, uy], n: [-uy * (flip ? -1 : 1), ux * (flip ? -1 : 1)],
        O: flip ? [i.wall.bx, i.wall.by] : [i.wall.ax, i.wall.ay], r: flip ? [-ux, -uy] : [ux, uy] });
    }
    const F = faces.get(key);
    if (!F.names.includes(faceName(t.name))) F.names.push(faceName(t.name));
    const base = { section: t.id, sectionName: t.name || p.short, wallId: t.wallId, face: key, room, roomId,
      project: t.projectId || '', projectName: pr ? pr.name || '' : '', product: p.id, style: t.style, W: p.W, T: p.T };
    let fi = 0;
    for (const q of lay.parts) {
      if (q.role === 'backer') continue;
      if (q.kind === 'run') {
        const ux = (i.wall.bx - i.wall.ax) / L, uy = (i.wall.by - i.wall.ay) / L;
        const [h0, h1] = [hx(q.x0), hx(q.x1)].sort((m, n) => m - n);
        const eA = end(Math.abs(q.x0 - i.x0) < 1e-4, i.x0, 0, q.mitreA), eB = end(Math.abs(q.x1 - i.x1) < 1e-4, i.x1, L, q.mitreB);
        pieces.push({ ...base, kind: 'run', len: q.x1 - q.x0, y: q.y, x0: q.x0, x1: q.x1, side: t.side,
          pA: [i.wall.ax + ux * q.x0, i.wall.ay + uy * q.x0], pB: [i.wall.ax + ux * q.x1, i.wall.ay + uy * q.x1], u: [ux, uy],
          endA: eA, endB: eB, leftIsA: !flip, h0, h1, v0: q.y, v1: q.y + (q.W || p.W) });
      } else if (q.kind === 'frame') {
        fi++;
        const wd = q.x1 - q.x0, ht = q.y1 - q.y0;
        const [h0, h1] = [hx(q.x0), hx(q.x1)].sort((m, n) => m - n);
        // A side an outlet crosses is still one length, notched round it on site.
        const gaps = frameGaps(q);
        for (const [side, len] of [['top', wd], ['bottom', wd], ['left', ht], ['right', ht]])
          pieces.push({ ...base, kind: 'frame', frame: fi, side, len, endA: 'miter 45°', endB: 'miter 45°', box: [wd, ht], h0, h1, v0: q.y0, v1: q.y1,
            ...(gaps[side].length ? { notch: gaps[side].length } : {}) });
      } else if (q.kind === 'board') {
        const [h0, h1] = [hx(q.x0), hx(q.x1)].sort((m, n) => m - n);
        let own = {};
        if (p.parts) {
          const role = q.dir === 'v' ? 'stile' : (q.y1 - q.y0) > p.W + 1e-4 ? 'topRail' : 'bottomRail';
          const b = catalogItem(p.parts[role]);
          if (!b) { skipped.push(t.id); continue; }
          own = { product: b.id, W: b.W, T: b.T, part: role };
        }
        pieces.push({ ...base, ...own, kind: q.dir === 'v' ? 'batten' : 'rail', len: q.dir === 'v' ? q.y1 - q.y0 : q.x1 - q.x0, endA: 'square', endB: 'square',
          h0, h1, v0: q.y0, v1: q.y1, ...(q.notches && q.notches.length ? { notch: q.notches.length } : {}) });
      }
    }
  }
  return { pieces, faces: [...faces.values()], skipped };
}

// The catalog entries a set of pieces uses (TRIM_CATALOG / TRIM_STOCK shape).
export function catalogFor(pieces) {
  const ids = [...new Set(pieces.map(p => p.product))];
  return ids.map(id => catalogItem(id)).filter(Boolean);
}

// Two-letter room codes, unique: initials of the first two words, else the first two letters.
export function roomCodes(names, taken = []) {
  const used = new Set(taken), out = [];
  for (const name of names) {
    const words = String(name || 'Room').replace(/[^A-Za-z0-9 ]+/g, ' ').trim().split(/\s+/).filter(w => !/^(and|the|of|room)$/i.test(w));
    const letters = (words.join('') || 'RM').toUpperCase();
    const tries = [];
    if (words.length > 1) tries.push((words[0][0] + words[1][0]).toUpperCase());
    tries.push(letters.slice(0, 2));
    for (let i = 2; i < letters.length; i++) tries.push(letters[0] + letters[i]);
    let code = tries.find(c => c.length === 2 && !used.has(c));
    for (let n = 2; !code; n++) if (!used.has(letters[0] + n)) code = letters[0] + n;
    used.add(code); out.push({ name, code });
  }
  return out;
}

// ---------- step 2: everything else ----------
export function estimateTrim({ pieces: piecesIn, faces: facesIn, catalog: catalogIn, rooms: roomsIn, settings: settingsIn = {}, data = ESTIMATE_DATA }) {
  const S = { ...SETTINGS_DEFAULT, ...settingsIn };
  const warnings = [];
  const P = JSON.parse(JSON.stringify(piecesIn || []));
  const FACES = JSON.parse(JSON.stringify(facesIn || []));
  const CAT = {};
  for (const c of catalogIn || catalogFor(P)) CAT[c.id] = { ...c };
  for (const [pid, o] of Object.entries(S.priceOverrides || {})) if (CAT[pid]) Object.assign(CAT[pid], { price: o.price, seen: o.seen, price_note: o.note || '' });
  for (const p of P) if (!CAT[p.product]) { const c = catalogItem(p.product); if (c) CAT[c.id] = { ...c }; else warnings.push(`Product ${p.product} is not in the trim catalog.`); }
  const pieces0 = P.filter(p => CAT[p.product]);
  for (const pid of Object.keys(CAT)) if (!pieces0.some(p => p.product === pid)) delete CAT[pid];   // only what the pieces use is bought
  P.length = 0; P.push(...pieces0);
  const RATE = Number(S.laborRate), CONT = Number(S.contingency), SPARE = Math.trunc(Number(S.sparePerMoulding));
  const CAP_IN = Number(S.stockCapIn), STRETCH_IN = Number(S.stockStretchIn);
  // rooms, in order, with codes
  const roomNames = [];
  for (const r of roomsIn || []) if (!roomNames.includes(r.name)) roomNames.push(r.name);
  for (const p of P) if (!roomNames.includes(p.room)) roomNames.push(p.room);
  const given = Object.fromEntries((roomsIn || []).filter(r => r.code).map(r => [r.name, r.code]));
  const auto = Object.fromEntries(roomCodes(roomNames.filter(n => !given[n]), Object.values(given)).map(x => [x.name, x.code]));
  const ROOMS = roomNames.map(n => [n, given[n] || auto[n]]);
  const CODE = Object.fromEntries(ROOMS);
  const roomCodeList = ROOMS.map(([, c]) => c);

  const STOCK_IN = {};
  for (const [pid, c] of Object.entries(CAT)) {
    let v = stockInches(c);
    if (v == null) { v = 96; warnings.push(`${c.short || pid}: the catalog gives no store length; 8'-0" assumed.`); }
    STOCK_IN[pid] = v;
  }
  const KIT = new Set(Object.keys(CAT).filter(pid => isKit(CAT[pid])));
  const STOCKDATA = { ...((data.stock && data.stock.products) || {}), ...(S.stock || {}) };
  const saleOf = pid => {
    const c = CAT[pid], d = STOCKDATA[pid];
    const one = { sold: 'lengths', lengths: [{ in: STOCK_IN[pid], price: c.price, item: c.sku || '', url: c.url || '' }], evidence: '', note: '' };
    if (KIT.has(pid) || !d) return one;
    const o = { ...d, evidence: d.evidence || '', note: d.note || '' };
    if (o.sold === 'lengths' || o.sold === 'both')
      o.lengths = sortBy(d.lengths.map(l => { l = { ...l }; if (Math.abs(l.in - STOCK_IN[pid]) < .01) l.price = c.price; return l; }), l => [l.in]);
    return o;
  };
  const SALE = Object.fromEntries(Object.keys(CAT).map(pid => [pid, saleOf(pid)]));
  const allowed = pid => { const ls = SALE[pid].lengths || []; const a = ls.filter(l => l.in <= STRETCH_IN + 1e-6); return a.length ? a : ls.slice(0, 1); };
  const byFoot = pid => SALE[pid].sold === 'foot' || SALE[pid].sold === 'both';
  const MAXLEN = Object.fromEntries(Object.keys(CAT).map(pid => [pid, Math.max(...allowed(pid).map(l => l.in), ...(byFoot(pid) ? [Math.min(SALE[pid].max_in, STRETCH_IN)] : []))]));
  const ROLE_OF = Object.fromEntries(Object.keys(CAT).map(pid => [pid, roleOf(CAT[pid])]));
  const PROD_ORDER = sortBy(Object.keys(CAT), pid => [ROLE_ORDER.includes(ROLE_OF[pid]) ? ROLE_ORDER.indexOf(ROLE_OF[pid]) : 9, pid]);
  const soldTxt = pid => soldText(SALE[pid], KIT.has(pid));

  // ---------- walls: faces in one line with the same name are one drawing ----------
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
  const walls = [];
  for (const f of FACES) {
    const name = f.names && f.names.length ? f.names[0] : 'Wall';
    let hit = null;
    if (!f.stair) {
      for (const w of walls) {
        if (w.room !== f.room || w.name !== name || w.stair) continue;
        if (dot(w.r, f.r) < .999) continue;
        const off = [f.O[0] - w.O[0], f.O[1] - w.O[1]];
        if (Math.abs(off[0] * w.r[1] - off[1] * w.r[0]) < .05) { hit = w; break; }
      }
    }
    if (!hit) {
      hit = { id: `W${walls.length + 1}`, room: f.room, name, faces: [], O: f.O || [0, 0], r: f.r || [1, 0], n: f.n || [0, 0],
        h0: 1e9, h1: -1e9, H: f.H, openings: [], stair: !!f.stair };
      walls.push(hit);
    }
    const shift = !f.stair ? dot([f.O[0] - hit.O[0], f.O[1] - hit.O[1]], hit.r) : 0;
    f._wall = hit.id; f._shift = shift;
    hit.faces.push(f.key);
    hit.h0 = Math.min(hit.h0, f.h0 + shift); hit.h1 = Math.max(hit.h1, f.h1 + shift); hit.H = Math.max(hit.H, f.H);
    for (const o of f.openings || []) {
      if (hit.openings.some(x => x.id === o.id)) continue;
      hit.openings.push({ ...o, h0: o.h0 + shift, h1: o.h1 + shift, c0: o.c0 + shift, c1: o.c1 + shift });
    }
  }
  const FACE = Object.fromEntries(FACES.map(f => [f.key, f]));
  const WALL = Object.fromEntries(walls.map(w => [w.id, w]));
  for (const p of P) {
    const f = FACE[p.face];
    if (!f) { warnings.push(`A piece of ${p.sectionName} has no wall face.`); continue; }
    p.wall = f._wall;
    if (p.h0 !== undefined) { p.h0 += f._shift; p.h1 += f._shift; }
  }
  const wallOrder = w => w.stair ? 9 + w.name.length / 100 : (Math.atan2(w.n[1], w.n[0]) + 2 * Math.PI) % (2 * Math.PI);
  const roomWalls = {};
  for (const [room] of ROOMS) {
    roomWalls[room] = sortBy(walls.filter(w => w.room === room), w => [wallOrder(w)]);
    roomWalls[room].forEach((w, k) => { w.k = k; });
  }

  // ---------- resolve run ends left as plain "corner" ----------
  const runs = P.filter(x => x.kind === 'run' && x.pA);
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  for (const r of runs) {
    for (const [e, pt] of [['endA', r.pA], ['endB', r.pB]]) {
      if (r[e] !== 'corner') continue;
      let best = null;
      for (const o of runs) {
        if (o === r || o.room !== r.room || o.product !== r.product || Math.abs(o.y - r.y) > .01) continue;
        for (const [oe, opt] of [['endA', o.pA], ['endB', o.pB]]) {
          const dd = dist(pt, opt);
          if (dd < .3 && (best === null || dd < best[0])) best = [dd, o, oe];
        }
      }
      if (!best) { r[e] = 'check on site'; continue; }
      const [, o, oe] = best;
      if (Math.abs(r.u[0] * o.u[0] + r.u[1] * o.u[1]) > .99) r[e] = 'joint';
      else if (o[oe] === 'inside corner' || o[oe] === 'outside corner') r[e] = o[oe];
      else r[e] = 'check on site';
    }
  }
  for (const r of runs) for (const e of ['endA', 'endB']) if (r[e] === 'corner') r[e] = 'check on site';

  const bevelAngle = e => { const m = /([\d.]+)\s*°/.exec(e); return m ? parseFloat(m[1]) : 45.0; };
  const wedge = (p, e) => {
    const c = CAT[p.product]; let d;
    if (e.startsWith('miter') || e.startsWith('plumb')) d = (p.kind === 'frame' || e.startsWith('plumb')) ? c.W : c.T;
    else if (e === 'outside corner' || e === 'scarf') d = c.T;
    else return 0.0;
    return d / IN / Math.tan(bevelAngle(e) * Math.PI / 180);
  };

  // ---------- inside corners: the longer piece runs square into the corner, the shorter one is coped ----------
  const ins = [];
  for (const r of runs) for (const e of ['endA', 'endB']) if (r[e] === 'inside corner') ins.push([r, e, e === 'endA' ? r.pA : r.pB]);
  const used = new Set();
  ins.forEach(([r, e, pt], i) => {
    if (used.has(i)) return;
    let best = null;
    ins.forEach(([o, oe, opt], j) => {
      if (j === i || used.has(j) || o === r || o.room !== r.room || o.product !== r.product || Math.abs(o.y - r.y) > .01) return;
      const dd = dist(pt, opt);
      if (dd < .4 && (best === null || dd < best[0])) best = [dd, j];
    });
    if (best === null) return;
    const j = best[1]; used.add(i); used.add(j);
    const [o, oe] = ins[j];
    const [long, short] = r.len >= o.len ? [[r, e], [o, oe]] : [[o, oe], [r, e]];
    long[0][long[1]] = 'into corner'; short[0][short[1]] = 'inside corner';
  });

  // ---------- split runs longer than a store piece (scarf joints) ----------
  const cutp = [];
  for (const p of P) {
    if (!p.wall) continue;
    const usable = MAXLEN[p.product] - 2 * TRIM_END, L = p.len / IN;
    if (L <= usable + 1e-6) { cutp.push({ ...p, lin: L }); continue; }
    const n = Math.ceil(L / (usable - 1)), each = L / n;
    for (let k = 0; k < n; k++) {
      const q = { ...p, lin: each, endA: k === 0 ? p.endA : 'scarf', endB: k === n - 1 ? p.endB : 'scarf', split: `${k + 1} of ${n}` };
      if (p.h0 !== undefined) { const a = p.h0, b = p.h1; q.h0 = a + (b - a) * k / n; q.h1 = a + (b - a) * (k + 1) / n; }
      cutp.push(q);
    }
  }
  for (const p of cutp) {
    const c = CAT[p.product];
    for (const e of [p.endA, p.endB]) {
      if (e === 'outside corner') p.lin += c.T / IN;
      else if (e === 'scarf') p.lin += c.T / IN / 2;
    }
    if (p.kind === 'rail' && p.v1 != null) p.Wd = p.v1 - p.v0;
    else if (p.kind === 'batten' && p.h1 != null) p.Wd = p.h1 - p.h0;
    else p.Wd = c.W;
    p.use = p.lin + wedge(p, p.endA) + wedge(p, p.endB);
    const leftIsA = p.leftIsA !== undefined ? p.leftIsA : true;
    [p.endL, p.endR] = leftIsA ? [p.endA, p.endB] : [p.endB, p.endA];
  }

  // ---------- marks: room code + number, going round the room wall by wall ----------
  const groups = new Map();
  for (const p of cutp) {
    const sideKey = p.kind === 'frame' && p.style === 'stair' ? (p.side === undefined ? null : p.side)
      : (p.side === 'top' || p.side === 'bottom') ? 'tb' : p.kind === 'frame' ? 'lr' : '';
    const key = [p.room, WALL[p.wall].k, p.section, p.product, p.kind, pyRound(p.Wd / IN * 16), sideKey, pyRound(p.lin * 16), cutWord(p.endL), cutWord(p.endR), p.notch || 0];
    const ks = JSON.stringify(key);
    if (!groups.has(ks)) groups.set(ks, { key, list: [] });
    groups.get(ks).list.push(p);
  }
  const counter = {}, G = [];
  for (const { key, list } of sortBy([...groups.values()], g => [roomCodeList.indexOf(CODE[g.key[0]]), g.key[1], PROD_ORDER.indexOf(g.key[3]), g.key[2], -g.key[7]])) {
    const room = key[0]; counter[room] = (counter[room] || 0) + 1;
    const mark = `${CODE[room]}-${String(counter[room]).padStart(2, '0')}`;
    for (const p of list) p.mark = mark;
    const g = list[0];
    G.push({ mark, room, roomId: g.roomId, wall: g.wall, section: g.section, sectionName: g.sectionName, product: g.product, kind: g.kind,
      qty: list.length, lin: g.lin, endL: cutWord(g.endL), endR: cutWord(g.endR), split: g.split || null, stair: g.style === 'stair',
      side: g.side === undefined ? '' : g.side, part: g.part || null, ...(g.notch ? { notch: g.notch } : {}) });
  }

  // ---------- plain names: where each piece goes, in words ----------
  const pieceRole = p => {
    if (p.part) return PART_WORD[p.part];
    const kit = KIT.has(p.product);
    if (p.kind === 'frame') return p.style === 'stair' ? 'raked panel' : 'panel frame';
    if (p.kind === 'batten') return kit ? 'kit stile' : 'batten';
    if (p.kind === 'rail') return kit ? 'kit rail' : 'top rail';
    return ROLE_WORD[ROLE_OF[p.product]] || CAT[p.product].short;
  };
  const rows = new Map();
  for (const p of cutp) {
    const key = p.kind === 'frame' ? [p.wall, p.product, 'frame'] : p.kind === 'rail' ? [p.wall, p.product, 'rail'] : [p.wall, p.product, p.kind, pyRound(p.v0 || 0, 2)];
    const ks = JSON.stringify(key);
    if (!rows.has(ks)) rows.set(ks, { key, list: [] });
    rows.get(ks).list.push(p);
  }
  for (const p of cutp) {
    if (p.side === 'upright' && p.poly && p.seg) {
      const cx = sum(p.poly, ([u]) => u) / p.poly.length;
      p.side = p.seg[0][0] < cx ? 'upright left' : 'upright right';
    }
  }
  for (const { key, list } of rows.values()) {
    if (key[2] === 'frame') {
      const idOf = q => JSON.stringify([q.stairFace || q.section, q.frame]);
      const ids = [...new Set(list.map(idOf))];
      const firstAt = k => Math.min(...list.filter(q => idOf(q) === k).map(q => q.h0 !== undefined ? (q.h0 || 0) : Math.min(...q.poly.map(([u]) => u))));
      const order = sortBy(ids, k => [firstAt(k)]);
      for (const q of list) { q._pos = order.indexOf(idOf(q)) + 1; q._of = order.length; }
    } else {
      let uniq = 0;
      const ident = q => q.kind === 'run' && q.x0 !== undefined ? JSON.stringify([q.section, pyRound(q.x0, 3)])
        : q.kind === 'rail' ? JSON.stringify([pyRound(q.h0, 2), pyRound(q.h1, 2)]) : 'u' + (uniq++);
      const runsM = new Map();
      for (const q of list) { const k = ident(q); if (!runsM.has(k)) runsM.set(k, []); runsM.get(k).push(q); }
      const order = sortBy([...runsM.keys()], k => [Math.min(...runsM.get(k).map(q => ((q.h0 || 0) + (q.h1 || 0)) / 2))]);
      order.forEach((k, i) => {
        for (const q of runsM.get(k)) { q._pos = i + 1; q._of = order.length; }
        if (key[2] === 'rail') {
          const vs = sortBy(runsM.get(k), q => [q.v0 || 0]);
          vs.forEach((q, j) => { q._tb = j === 0 && vs.length > 1 ? 'bottom' : j === vs.length - 1 && vs.length > 1 ? 'top' : ''; });
        }
      });
    }
  }
  const where = q => q._of === 1 ? '' : `${ordinal(q._pos)} of ${q._of} from left`;
  const sizeOf = (c, Wd) => `${ftin(c.T)} × ${ftin(Wd)}`;
  for (const g of G) {
    const ps = cutp.filter(p => p.mark === g.mark);
    const wall = WALL[g.wall].name, role = pieceRole(ps[0]);
    if (g.kind === 'frame') {
      const nums = [...new Set(ps.map(p => p._pos))].sort((a, b) => a - b), of = ps[0]._of;
      const consecutive = nums.every((n, i) => n === nums[0] + i);
      const which = (nums.length === 1 ? `panel ${nums[0]}` : consecutive ? `panels ${nums[0]}–${nums[nums.length - 1]}` : 'panels ' + nums.join(', ')) + ` of ${of} from left`;
      const sideList = Object.keys(SIDE_WORD);
      const sides = sortBy([...new Set(ps.map(p => p.side))], s => [sideList.includes(s) ? sideList.indexOf(s) : 9]);
      const part = sides.map(x => SIDE_WORD[x] || x).join(' and ');
      g.name = `${wall} · ${role}, ${which} · ${part}`;
    } else if (ps.length > 1) {
      const rowsV = [...new Set(ps.map(p => pyRound(p.v0 || 0, 2)))].sort((a, b) => a - b);
      const pos = [...new Set(ps.map(p => p._pos))].sort((a, b) => a - b), of = ps[0]._of;
      const ords = pos.length <= 4 ? pos.map(ordinal).join(', ') : `${ordinal(pos[0])} to ${ordinal(pos[pos.length - 1])}`;
      const rw = rowsV.length === 2 ? 'top and bottom' : '';
      if (g.kind === 'rail') {
        const spans = new Map();
        for (const p of ps) { if (!spans.has(p._pos)) spans.set(p._pos, []); spans.get(p._pos).push(p.v0 || 0); }
        const tbSet = new Set();
        for (const vs of spans.values()) for (const v of vs) tbSet.add(v === Math.max(...vs) && vs.length > 1 ? 'top' : vs.length > 1 ? 'bottom' : 'top/bottom');
        let tb = [...tbSet].sort().reverse().join(' and ');
        const sp = [...spans.keys()].sort((a, b) => a - b);
        const st = sp.length <= 4 ? sp.map(ordinal).join(', ') : `${ordinal(sp[0])} to ${ordinal(sp[sp.length - 1])}`;
        if (ps[0].part) tb = 'one each';
        g.name = `${wall} · ${role}s (${ps.length}), ${tb}, ` + (of > 1 ? `stretch ${st.replaceAll('st', '').replaceAll('nd', '').replaceAll('rd', '').replaceAll('th', '')} of ${of} from left` : 'one stretch');
      } else {
        g.name = `${wall} · ${role}s (${ps.length})` + (rw ? `, ${rw}` : '') + (of > 1 ? `, ${ords} of ${of} from left` : '');
      }
    } else {
      if (g.kind === 'rail' && ps[0]._tb) {
        const q = ps[0];
        g.name = `${wall} · ${q._tb} ${role}` + (q._of > 1 ? `, stretch ${q._pos} of ${q._of} from left` : '');
        const c = CAT[g.product]; g.size = sizeOf(c, q.Wd); g.material = c.material || '';
        for (const p of ps) { p.name = g.name; p.size = g.size; }
        continue;
      }
      const w_ = where(ps[0]);
      const sp = g.split ? `, part ${g.split.split(' of ')[0]} of ${g.split.split(' of ')[1]} from left` : '';
      g.name = `${wall} · ${role}` + (w_ ? `, ${w_}` : '') + sp;
    }
    // An outlet, switch or radiator edge crosses it: the carpenter cuts the notch on site.
    if (g.notch) g.name += ' · cut ' + (g.notch === 1 ? 'a notch' : g.notch + ' notches') + ' on site';
    const c = CAT[g.product];
    g.size = sizeOf(c, ps[0].Wd);
    g.material = c.material || '';
    for (const p of ps) { p.name = g.name; p.size = g.size; }
  }
  const countNames = () => { const m = {}; for (const g of G) m[g.name] = (m[g.name] || 0) + 1; return m; };
  let seen = countNames();
  for (const g of G) if (seen[g.name] > 1) g.name += ` · ${g.size.split(' × ')[1]} wide`;
  seen = countNames();
  for (const g of G) if (seen[g.name] > 1) g.name += ` (${g.mark})`;
  const GM = Object.fromEntries(G.map(g => [g.mark, g]));
  for (const p of cutp) { p.name = GM[p.mark].name; p.material = GM[p.mark].material; }

  // ---------- pack: each room from its own store pieces (first fit decreasing) ----------
  const fill = (items, L) => {
    const usable = L - 2 * TRIM_END, bins = [];
    for (const it of sortBy(items, q => [-q.use])) {
      const s = bins.find(s => s.used + MIN_GAP + it.use <= usable + 1e-9);
      if (s) { s.used += MIN_GAP + it.use; s.cuts.push(it); }
      else bins.push({ used: it.use, cuts: [it] });
    }
    return bins;
  };
  const buyLen = (pid, usedIn) => {
    const s = SALE[pid], need = usedIn + 2 * TRIM_END;
    const opts = allowed(pid).filter(l => l.in >= need - 1e-6).map(l => [l.price, l.in, 'length']);
    if (byFoot(pid)) {
      const ft = Math.max(1, Math.ceil(need / 12 - 1e-9));
      if (ft * 12 <= Math.min(s.max_in, STRETCH_IN) + 1e-6) opts.push([pyRound(ft * s.per_ft, 2), ft * 12.0, 'foot']);
    }
    if (!opts.length) {
      const l = allowed(pid)[allowed(pid).length - 1];
      warnings.push(`${CAT[pid].short}: a board's cuts need ${ftin({ inches: need })}, longer than the store sells.`);
      return [l.in, l.price, 'length'];
    }
    const [p, L, how] = minBy(opts, o => o);
    return [L, p, how];
  };
  const pack = (items, pid) => {
    if (!items.length) return [];
    const bases = KIT.has(pid) ? [STOCK_IN[pid]]
      : [...new Set([...allowed(pid).map(l => l.in), ...(byFoot(pid) ? [Math.min(CAP_IN, MAXLEN[pid]), MAXLEN[pid]] : [])])].sort((a, b) => a - b);
    const maxUse = Math.max(...items.map(i => i.use));
    const tries = [];
    for (const Lb of bases) {
      if (maxUse > Lb - 2 * TRIM_END + 1e-9) continue;
      const bins = fill(items, Lb);
      for (const b of bins) [b.stockIn, b.price, b.how] = KIT.has(pid) ? [STOCK_IN[pid], CAT[pid].price / RAILS_PER_KIT, 'kit'] : buyLen(pid, b.used);
      tries.push([Lb > CAP_IN + 1e-6, pyRound(sum(bins, b => b.price), 2), sum(bins, b => b.stockIn), bins]);
    }
    if (!tries.length) {
      const Lb = bases[bases.length - 1], bins = fill(items, Lb);
      warnings.push(`${CAT[pid].short}: a piece is longer than the longest store length; check it on site.`);
      for (const b of bins) [b.stockIn, b.price, b.how] = KIT.has(pid) ? [STOCK_IN[pid], CAT[pid].price / RAILS_PER_KIT, 'kit'] : buyLen(pid, Math.min(b.used, Lb - 2 * TRIM_END));
      tries.push([false, 0, 0, bins]);
    }
    const inside = tries.filter(t => !t[0]), over = tries.filter(t => t[0]);
    let best = inside.length ? minBy(inside, t => t.slice(1, 3)) : null;
    if (over.length) {
      const o = minBy(over, t => t.slice(1, 3));
      if (best === null || cmpT(o.slice(1, 3), best.slice(1, 3)) < 0) best = o;
    }
    let bins = best[3];
    if (!KIT.has(pid)) {
      const out = [];
      for (const b of bins) {
        let alt = null;
        for (const Lb of bases) {
          if (Math.max(...b.cuts.map(i => i.use)) > Lb - 2 * TRIM_END + 1e-9) continue;
          const sub = fill(b.cuts, Lb);
          if (sub.length < 2) continue;
          for (const x of sub) [x.stockIn, x.price, x.how] = buyLen(pid, x.used);
          const c_ = pyRound(sum(sub, x => x.price), 2);
          if (c_ < pyRound(b.price, 2) - .005 && (alt === null || c_ < alt[0])) alt = [c_, sub];
        }
        out.push(...(alt ? alt[1] : [b]));
      }
      bins = out;
    }
    return sortBy(bins, b => [-b.stockIn, b.how !== 'length']);
  };
  const roomSticks = {};
  for (const [room] of ROOMS) {
    const out = [];
    for (const pid of PROD_ORDER) {
      let items = cutp.filter(p => p.room === room && p.product === pid);
      if (KIT.has(pid)) {
        for (const p of items) if (p.kind !== 'rail') p.stick = 'kit stiles';
        items = items.filter(p => p.kind === 'rail');
      }
      const sticks = pack(items, pid);
      sticks.forEach((s, i) => {
        s.id = KIT.has(pid) ? `Kit rail ${i + 1}` : `${SHORTN[ROLE_OF[pid]] || ROLE_OF[pid]} ${i + 1}`;
        s.pid = pid; s.room = room;
        const by = new Map();
        for (const c of s.cuts) { c.stick = s.id; by.set(c.wall, (by.get(c.wall) || 0) + c.use); }
        let bw = null, bv = -Infinity;
        for (const [w, v] of by) if (v > bv) { bw = w; bv = v; }
        s.wall = bw;
      });
      out.push(...sticks);
    }
    roomSticks[room] = out;
  }

  // ---------- quantities by room ----------
  const units = (n, pid) => KIT.has(pid) ? Math.ceil(n / RAILS_PER_KIT) : n;
  const lfOf = pred => sum(P.filter(pred), p => p.len) / .3048;
  const work = {};
  for (const [room] of ROOMS) {
    const R = p => p.room === room;
    const cp = cutp.filter(R);
    const setOf = (pred, k) => new Set(P.filter(pred).map(k)).size;
    const w = work[room] = {
      base: lfOf(p => R(p) && ROLE_OF[p.product] === 'base' && p.style !== 'stair'),
      chair: lfOf(p => R(p) && ROLE_OF[p.product] === 'chair' && p.style !== 'stair'),
      cap: lfOf(p => R(p) && ROLE_OF[p.product] === 'cap'),
      stairBase: lfOf(p => R(p) && ROLE_OF[p.product] === 'base' && p.style === 'stair'),
      stairChair: lfOf(p => R(p) && ROLE_OF[p.product] === 'chair' && p.style === 'stair'),
      frames: setOf(p => R(p) && p.kind === 'frame' && p.style !== 'stair', p => JSON.stringify([p.section, p.frame])),
      raked: setOf(p => R(p) && p.kind === 'frame' && p.style === 'stair', p => JSON.stringify([p.stairFace, p.frame])),
      panelLf: lfOf(p => R(p) && ROLE_OF[p.product] === 'panel'),
      battens: cp.filter(p => p.kind === 'batten').length,
      rails: lfOf(p => R(p) && p.kind === 'rail'),
      copes: sum(cp, p => (p.endA === 'inside corner') + (p.endB === 'inside corner')),
      outside: Math.floor(sum(cp, p => (p.endA === 'outside corner') + (p.endB === 'outside corner')) / 2),
      scarfs: cp.filter(p => p.endA === 'scarf').length,
      check: sum(cp, p => (p.endA === 'check on site') + (p.endB === 'check on site')),
      pieces: cp.length, walls: (roomWalls[room] || []).length,
      trimLf: lfOf(R),
      sticks: Object.fromEntries(PROD_ORDER.map(pid => [pid, units(roomSticks[room].filter(s => s.pid === pid).length, pid)])),
      byLen: Object.fromEntries(PROD_ORDER.filter(pid => !KIT.has(pid)).map(pid => {
        const m = {}; for (const s of roomSticks[room]) if (s.pid === pid) { const k = `${fmtG(s.stockIn)}|${s.how}`; m[k] = (m[k] || 0) + 1; }
        return [pid, m];
      })),
    };
    w.mat = sum(Object.entries(w.sticks).filter(([pid]) => KIT.has(pid)), ([pid, n]) => n * CAT[pid].price) + sum(roomSticks[room].filter(s => !KIT.has(s.pid)), s => s.price);
  }

  const buy = [];
  for (const pid of PROD_ORDER) {
    const c = CAT[pid];
    const n = sum(ROOMS, ([r]) => work[r].sticks[pid]);
    const net = sum(cutp.filter(p => p.product === pid), p => p.lin);
    const packed = cutp.filter(p => p.product === pid && (!KIT.has(pid) || p.kind === 'rail'));
    const whole = units(pack(packed, pid).length, pid);
    const mine = ROOMS.flatMap(([r]) => roomSticks[r].filter(s => s.pid === pid));
    let lines, boughtIn;
    if (KIT.has(pid)) {
      lines = [{ lenIn: STOCK_IN[pid], how: 'kit', rooms: n, spare: SPARE, order: n + SPARE, price: c.price, ext: (n + SPARE) * c.price }];
      boughtIn = n * STOCK_IN[pid] * RAILS_PER_KIT;
    } else {
      const cnt = new Map(), priceOf = new Map();
      for (const s of mine) { const k = JSON.stringify([s.stockIn, s.how]); cnt.set(k, (cnt.get(k) || 0) + 1); priceOf.set(k, s.price); }
      const keys = [...cnt.keys()].map(k => JSON.parse(k));
      const sets = keys.filter(k => k[1] === 'length');
      const spKey = sets.length ? maxBy(sets, k => [cnt.get(JSON.stringify(k)), k[0]]) : maxBy(keys, k => k);
      lines = sortBy(keys, k => [k[1] !== 'length', -k[0]]).map(k => {
        const ks = JSON.stringify(k), sp = spKey && ks === JSON.stringify(spKey) ? SPARE : 0;
        return { lenIn: k[0], how: k[1], key: `${fmtG(k[0])}|${k[1]}`, rooms: cnt.get(ks), spare: sp, order: cnt.get(ks) + sp, price: priceOf.get(ks), ext: (cnt.get(ks) + sp) * priceOf.get(ks) };
      });
      boughtIn = sum(mine, s => s.stockIn);
    }
    if (!n && !lines.length) continue;
    buy.push({ pid, product: pid, short: c.short, title: c.title || '', store: c.store || '', sku: c.sku || '', url: c.url || '', rooms: n, whole, spare: SPARE, order: n + SPARE,
      netLf: net / 12, boughtLf: boughtIn / 12, kit: KIT.has(pid), yield: boughtIn ? sum(packed, p => p.lin) / boughtIn : 0,
      ext: sum(lines, l => l.ext), lines, sold: SALE[pid].sold, soldText: soldTxt(pid) });
  }
  const mouldingTotal = sum(buy, b => b.ext);

  // What each room's order share is (each moulding's spare on the room buying most of it).
  const ITEM = Object.fromEntries((roomsIn || []).map(r => [r.name, r.item || (r.code || CODE[r.name] || '').toLowerCase()]));
  for (const [room, code] of ROOMS) if (!ITEM[room]) ITEM[room] = code.toLowerCase();
  const alloc = {};
  const itemId = (room, pid, raked, L = null, how = 'length') => {
    const base = `${S.itemPrefix || ''}${ITEM[room]}-${raked ? 'raked-' : ''}${pid}`;
    if (KIT.has(pid) || (how === 'length' && Math.abs(L - STOCK_IN[pid]) < .01)) return base;
    return base + `-${fmtG(L)}in` + (how === 'foot' ? '-cut' : '');
  };
  for (const b of buy) {
    const pid = b.pid;
    if (b.kit) {
      const top = maxBy(ROOMS.map(([r]) => r), r => [work[r].sticks[pid]]);
      for (const [room] of ROOMS) {
        const n = work[room].sticks[pid] + (room === top ? SPARE : 0);
        if (!n) continue;
        const lf = sum(P.filter(p => p.room === room && p.product === pid), p => p.len) / .3048;
        alloc[itemId(room, pid, false)] = { room, pid, qty: n, raked: false, spare: room === top ? SPARE : 0, lf, lenIn: STOCK_IN[pid], how: 'kit', price: CAT[pid].price };
      }
      continue;
    }
    for (const [room] of ROOMS) {
      for (const s of roomSticks[room]) {
        if (s.pid !== pid) continue;
        const stair = sum(s.cuts.filter(c => c.style === 'stair'), c => c.use);
        const raked = stair > sum(s.cuts, c => c.use) / 2;
        const iid = itemId(room, pid, raked, s.stockIn, s.how);
        const a = alloc[iid] || (alloc[iid] = { room, pid, qty: 0, raked, spare: 0, lf: 0.0, lenIn: s.stockIn, how: s.how, price: s.price });
        a.qty += 1; a.lf += sum(s.cuts, c => c.lin) / 12;
      }
    }
    for (const l of b.lines) {
      if (!l.spare) continue;
      const cands = Object.values(alloc).filter(a => a.pid === pid && !a.raked && a.lenIn === l.lenIn && a.how === l.how);
      let tgt;
      if (cands.length) tgt = maxBy(cands, a => [a.qty]);
      else {
        const room = maxBy(ROOMS.map(([r]) => r), r => [work[r].sticks[pid]]);
        const iid = itemId(room, pid, false, l.lenIn, l.how);
        tgt = alloc[iid] || (alloc[iid] = { room, pid, qty: 0, raked: false, spare: 0, lf: 0.0, lenIn: l.lenIn, how: l.how, price: l.price });
      }
      tgt.qty += l.spare; tgt.spare += l.spare;
    }
  }
  if (Math.abs(sum(Object.values(alloc), a => a.qty * a.price) - mouldingTotal) >= .01) warnings.push('The rooms\' shares of the order do not add up to the buy list.');
  const spareTotal = sum(buy, b => sum(b.lines, l => l.spare * l.price));

  // ---------- job measures: what labor and supplies are counted from ----------
  for (const [room] of ROOMS) {
    const w = work[room], pr = P.filter(p => p.room === room);
    w.frameCorners = 4 * (w.frames + w.raked);
    w.battenLf = lfOf(p => p.room === room && p.kind === 'batten');
    w.faceAreaSf = sum(pr, p => (CAT[p.product].W + CAT[p.product].T) * p.len) / .0929;
    const two = { chair: 2, cap: 2, panel: 2, batten: 2, base: 1 };
    w.caulkLf = sum(pr, p => (two[ROLE_OF[p.product]] !== undefined ? two[ROLE_OF[p.product]] : 2) * p.len) / .3048;
    w.gluedJoints = w.outside + w.scarfs;
    w.measures = { rooms: 1, walls: w.walls, base_lf: w.base, chair_lf: w.chair, cap_lf: w.cap, frames: w.frames, raked: w.raked,
      stair_base_lf: w.stairBase, stair_chair_lf: w.stairChair, battens: w.battens, rail_lf: w.rails,
      panel_lf: w.panelLf, batten_lf: w.battenLf, copes: w.copes, outside: w.outside, scarfs: w.scarfs,
      trim_lf: w.trimLf, caulk_lf: w.caulkLf, face_sf: w.faceAreaSf, glued_joints: w.gluedJoints,
      frame_corners: w.frameCorners, pieces: w.pieces, adhesive_lf: w.battenLf + w.rails + w.cap, nails: null };
  }
  const LAB = data.labor || { tasks: [] };
  const taskById = Object.fromEntries([...(LAB.tasks || []), ...(LAB.tasks_extra || [])].map(t => [t.id, t]));
  // Typed over the counts and the rates: S.labor = { each: { task: hrs each } (who does the work),
  // rooms: { room: { qty: { task: n }, each: { task: hrs each } } } }. A typed number wins over the
  // count and the published rate; a task the drawing does not count can be given a quantity.
  const LO = S.labor || {}, num = v => v != null && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0;
  for (const [room] of ROOMS) {
    const w = work[room], ov = (LO.rooms && LO.rooms[room]) || {};
    const m = { ...w.measures, frames_all: w.frames + w.raked };
    const eachOf = t => num(ov.each && ov.each[t.id]) ? [Number(ov.each[t.id]), 'room'] : num(LO.each && LO.each[t.id]) ? [Number(LO.each[t.id]), 'who'] : [t.hours, ''];
    const qtyOf = t => num(ov.qty && ov.qty[t.id]) ? Number(ov.qty[t.id]) : (m[t.per] || 0);
    const workH = sum(LAB.tasks.filter(t => t.per !== 'room_days'), t => qtyOf(t) * eachOf(t)[0]);
    m.room_days = Math.max(1, Math.ceil(workH / DAY_HOURS - 1e-9));
    w.labor = [];
    for (const t of LAB.tasks) {
      const counted = m[t.per] || 0, q = qtyOf(t), [each, eachSet] = eachOf(t);
      const qtySet = num(ov.qty && ov.qty[t.id]);
      if (q <= 0 && !qtySet) continue;
      w.labor.push({ task: t.id, label: t.label, unit: t.unit, unitOne: t.unit_one || t.unit, per: t.per, rate: each, qty: q, hours: q * each, counted, qtySet, eachSet, published: t.hours });
    }
    w.hours = sum(w.labor, l => l.hours);
    // A room's days: its working hours (all but setup and cleanup) at a productive day's hours, at
    // least one; setup and cleanup are counted per day.
    w.days = m.room_days;
  }
  const totalHours = sum(ROOMS, ([r]) => work[r].hours);
  const laborTotal = totalHours * RATE;

  const SUP = data.supplies || { items: [], tools: [] };
  const nailsFor = room => {
    const rules = SUP.nailing || {}, m = work[room].measures, out = new Map();
    for (const r of Object.values(rules)) {
      const lf = m[r.per] || 0;
      out.set(r.gun, (out.get(r.gun) || 0) + lf * r.nails_per_lf + (r.per_corner ? (m.frame_corners || 0) * r.per_corner : 0));
    }
    return out;
  };
  const house = {};
  for (const [room] of ROOMS) {
    for (const [k, v] of Object.entries(work[room].measures)) if (typeof v === 'number') house[k] = (house[k] || 0) + v;
    for (const [gun, n] of nailsFor(room)) house['nails_' + gun] = (house['nails_' + gun] || 0) + n;
  }
  house.rooms = ROOMS.length;
  house.holes = sum(Object.entries(house).filter(([k]) => k.startsWith('nails_')), ([, v]) => v);
  const supplies = [];
  for (const it of SUP.items || []) {
    const need = (house[it.per] || 0) * (it.factor !== undefined ? it.factor : 1);
    if (need <= 0 && !it.always) continue;
    const mn = it.min !== undefined ? it.min : 1;
    const pk = it.per_package ? Math.max(mn, Math.ceil(need / it.per_package - 1e-9)) : mn;
    supplies.push({ ...it, need, packages: pk, ext: pk * it.price });
  }
  const suppliesByCategory = {};
  for (const s of supplies) suppliesByCategory[s.category] = (suppliesByCategory[s.category] || 0) + s.ext;
  const suppliesTotal = sum(Object.values(suppliesByCategory));
  const subtotal = mouldingTotal + suppliesTotal + laborTotal;
  const contingency = CONT * subtotal;
  const grand = subtotal + contingency;
  for (const [room] of ROOMS) {
    const w = work[room];
    w.supplies = suppliesTotal * w.trimLf / Math.max(1e-9, house.trim_lf || 0);
    w.laborCost = w.hours * RATE;
    w.total = w.mat + w.supplies + w.laborCost;
  }

  // ---------- options: the same rooms priced other ways ----------
  const OPT = data.options || { scenarios: [] };
  const roleBought = {}, roleCost = {};
  for (const b of buy) {
    const r = ROLE_OF[b.pid];
    roleBought[r] = (roleBought[r] || 0) + sum(b.lines, l => l.order * l.lenIn * (b.kit ? RAILS_PER_KIT : 1)) / 12;
    roleCost[r] = (roleCost[r] || 0) + b.ext;
  }
  const hoursByTask = {};
  for (const [room] of ROOMS) for (const l of work[room].labor) hoursByTask[l.task] = (hoursByTask[l.task] || 0) + l.hours;
  const scenarios = [];
  for (const sc of OPT.scenarios || []) {
    let mould = 0.0;
    for (const role of Object.keys(roleCost)) {
      const perLf = (sc.per_lf || {})[role];
      mould += perLf !== undefined && perLf !== null ? roleBought[role] * perLf * ((sc.waste || {})[role] !== undefined ? sc.waste[role] : 1) : roleCost[role];
    }
    const sup = suppliesTotal + sum(Object.entries(sc.supplies_per || {}), ([k, v]) => (house[k] || 0) * v);
    let hours = sum(Object.entries(hoursByTask), ([tid, hh]) => hh * ((sc.labor_factor || {})[tid] !== undefined ? sc.labor_factor[tid] : 1))
      + sum(Object.entries(sc.hours_per || {}), ([k, v]) => (house[k] || 0) * v);
    if (sc.prime) {
      const pt = (LAB.tasks_extra || []).find(t => t.id === 'prime_loose');
      if (pt) hours += (house[pt.per] || 0) * pt.hours;
    }
    const total = (mould + sup + hours * RATE) * (1 + CONT);
    scenarios.push({ ...sc, mould, sup, hours, labor: hours * RATE, total });
  }

  // ---------- boards, laid out: where each cut sits ----------
  const endKind = (p, e) => { const w = wedge(p, e); return [e.startsWith('plumb') ? 'plumb' : w > 0 ? 'bevel' : 'square', w]; };
  const boards = [];
  for (const [room, code] of ROOMS) {
    for (const s of roomSticks[room]) {
      const cuts = sortBy(s.cuts, c => [-c.use]), n = cuts.length;
      const usable = s.stockIn - 2 * TRIM_END, usedIn = sum(cuts, c => c.use);
      const gap = n > 1 ? Math.max(MIN_GAP, Math.min(MAX_GAP, (usable - usedIn) / (n - 1))) : 0.0;
      let x = TRIM_END;
      const out = [];
      for (const c of cuts) {
        const [kl, wl] = endKind(c, c.endL), [kr, wr] = endKind(c, c.endR);
        const longAt = x + (c.use - (c.lin + (kr === 'plumb' ? wr : 0))) / 2;
        out.push({ mark: c.mark, name: c.name, wall: c.wall, at: x, use: c.use, lin: c.lin, longAt, endL: cutWord(c.endL), endR: cutWord(c.endR),
          kindL: kl, kindR: kr, wedgeL: wl, wedgeR: wr });
        x += c.use + gap;
      }
      const drop = Math.max(0.0, usable - usedIn - gap * (n - 1));
      boards.push({ id: s.id, key: code + '-' + s.id.replaceAll(' ', '-'), room, code, product: s.pid, short: CAT[s.pid].short, stockIn: s.stockIn, price: s.price, how: s.how,
        sold: SALE[s.pid].sold, kit: KIT.has(s.pid), wall: s.wall, cuts: out, gap, drop, end: out.length ? out[out.length - 1].at + out[out.length - 1].use : TRIM_END });
    }
  }

  // ---------- the result: plain data ----------
  const pieceOut = cutp.map(p => {
    const c = CAT[p.product], o = {};
    for (const k of ['mark', 'name', 'size', 'material', 'room', 'roomId', 'wall', 'face', 'section', 'sectionName', 'project', 'projectName', 'product', 'kind', 'style', 'side', 'frame',
      'stairFace', 'split', 'part', 'lin', 'use', 'Wd', 'endA', 'endB', 'leftIsA', 'stick', 'h0', 'h1', 'v0', 'v1', 'y', 'poly', 'seg', 'rake', 'len'])
      if (p[k] !== undefined) o[k] = p[k];
    o.endLWord = cutWord(p.endL); o.endRWord = cutWord(p.endR); o.endL = p.endL; o.endR = p.endR;
    o.T = c.T; o.W = c.W; o.profile = c.profile; o.productShort = c.short; o.wallName = WALL[p.wall].name;
    return o;
  });
  const roomsOut = ROOMS.map(([name, code]) => {
    const w = work[name];
    return { name, code, roomId: (P.find(p => p.room === name) || {}).roomId || '', ...w,
      sticksTotal: sum(Object.values(w.sticks)), boards: boards.filter(b => b.room === name).length };
  });
  return {
    settings: S, rooms: roomsOut, codes: Object.fromEntries(ROOMS),
    walls: walls.map(w => ({ id: w.id, room: w.room, name: w.name, faces: w.faces, O: w.O, r: w.r, n: w.n, h0: w.h0, h1: w.h1, H: w.H, openings: w.openings, stair: w.stair, k: w.k })),
    pieces: pieceOut, groups: G, boards, buy,
    catalog: CAT, prodOrder: PROD_ORDER, kits: [...KIT], roleOf: ROLE_OF, sale: SALE, stockIn: STOCK_IN,
    labor: { rate: RATE, tasks: LAB.tasks || [], tasksExtra: LAB.tasks_extra || [], byTask: hoursByTask, hours: totalHours, cost: laborTotal, note: LAB.note || '', rateNote: LAB.rate_note || '', seen: LAB.seen || '', taskById },
    supplies, suppliesByCategory, tools: SUP.tools || [], suppliesNote: SUP.note || '', suppliesSeen: SUP.seen || '', house,
    totals: { moulding: mouldingTotal, supplies: suppliesTotal, hours: totalHours, labor: laborTotal, subtotal, contingency, total: grand, spare: spareTotal,
      pieces: cutp.length, order: sum(buy, b => b.order), wholeHouse: sum(buy, b => b.whole), trimLf: house.trim_lf || 0 },
    scenarios, optionsNote: OPT.note || '', optionProducts: OPT.products || [],
    alloc, lmax: boards.length ? Math.max(...boards.map(b => b.stockIn)) : 96,
    constants: { kerf: KERF, trim: TRIM_END, minGap: MIN_GAP, maxGap: MAX_GAP, capIn: CAP_IN, stretchIn: STRETCH_IN, dayHours: DAY_HOURS, railsPerKit: RAILS_PER_KIT },
    warnings,
  };
}

// How a product is sold, in words.
export function soldText(s, kit) {
  if (kit) return 'sold as a kit';
  if (!s) return '';
  const foot = (s.sold === 'foot' || s.sold === 'both') ? `cut to length at the store off ${ftin({ inches: s.max_in })} stock, ${money(s.per_ft)} a foot` : '';
  if (s.sold === 'foot') return foot;
  if (s.sold === 'both') return 'sold in ' + s.lengths.map(l => ftin({ inches: l.in })).join(', ') + ' lengths, or ' + foot;
  return s.lengths.length > 1 ? 'sold in ' + s.lengths.map(l => ftin({ inches: l.in })).join(', ') + ' lengths' : `sold in ${ftin({ inches: s.lengths[0].in })} lengths only`;
}
