// Fixtures: what stands in the rooms. Counter runs, wall cabinets, appliances, furniture and
// bath fixtures are parametric records on the property (prop.fixtures), drawn as simple
// prisms: placement and size matter more than ornament. Pure functions, shared by MODEL
// (geometry.js), PLAN outlines, the SketchUp mirror and the scan detector's proposals.
//
// Two shapes:
//   run   base-run, wall-run: `pts` is the back line against the wall (plan metres), the
//         body extends `depth` to its `side` (+1 = the left normal (-uy, ux) of each segment).
//         `corners[i]` (interior vertex i) is the reach of a 45° front along the corner's
//         bisector, measured from the back corner; null keeps the square inner corner.
//   box   appliance, furniture, bath: centre x, y, `rot` degrees (local u along
//         (cos, sin)), width w along u, depth d along v; local +v is the back.
// Heights are above the level's floor: y0 is the bottom, h the height (a base run's h is
// its counter top). provenance: { source: 'scan' | 'user' | 'tape', confidence }.
//
// product (optional): which real product stands there, read during onboarding (ONBOARDING.md).
//   brand, model          as read or matched; brandConfidence / modelConfidence are
//                         'confirmed' (a logo or rating label was read), 'likely' (a visual
//                         match against listings) or 'unidentified'. 'confirmed' needs an
//                         evidence entry that reads it, or it is stored as 'likely'.
//   evidence              [{ media, at (video seconds), keyframe, crop [x, y, w, h] 0-1, reads, note }]
//   sources               [{ url, title }], public web pages only
//   asset                 the product's own 3D model (a file in the project): { fileId, format,
//                         name, sourceFileId / sourceName (the original it was converted
//                         from, kept byte for byte), origin, originName, license, turn (degrees about up, so the
//                         model's front faces the fixture's front), bounds (the GLB's own
//                         bounds, metres) }. A box fixture with an asset draws the model,
//                         stretched to the measured box (productFit), instead of its prisms.
//   assetNote             why there is no model (searched where, found nothing)

import { detailParts, normaliseDetail } from './fixture-detail.js';

export const FIXTURE_KINDS = {
  'base-run': { label: 'Base cabinets', shape: 'run', subtypes: [] },
  'wall-run': { label: 'Wall cabinets', shape: 'run', subtypes: [] },
  appliance: { label: 'Appliance', shape: 'box', subtypes: ['range', 'fridge', 'dishwasher', 'washer-dryer', 'microwave', 'range-hood', 'mini-split', 'water-heater'] },
  furniture: { label: 'Furniture', shape: 'box', subtypes: ['bed', 'table-round', 'table-rect', 'sofa', 'desk', 'storage'] },
  bath: { label: 'Bath', shape: 'box', subtypes: ['tub', 'vanity', 'toilet'] },
  fitting: { label: 'Fitting', shape: 'box', subtypes: ['faucet', 'shower-trim', 'panel', 'thermostat', 'light', 'outdoor-unit', 'shutoff', 'line-set', 'vent', 'drain'] },
};

const SUBTYPE_LABEL = { range: 'Range', fridge: 'Fridge', dishwasher: 'Dishwasher', 'washer-dryer': 'Washer / dryer', bed: 'Bed',
  'table-round': 'Round table', 'table-rect': 'Table', sofa: 'Sofa', desk: 'Desk', storage: 'Storage', tub: 'Tub', vanity: 'Vanity', toilet: 'Toilet',
  microwave: 'Microwave', 'range-hood': 'Range hood', 'mini-split': 'Mini-split head', 'water-heater': 'Water heater', faucet: 'Faucet',
  'shower-trim': 'Shower trim', panel: 'Breaker panel', thermostat: 'Thermostat', light: 'Light fixture', 'outdoor-unit': 'Outdoor unit',
  shutoff: 'Shutoff valve', 'line-set': 'Line set', vent: 'Vent', drain: 'Drain and trap' };

// Typical sizes, used for a hand-added fixture and to fill fields a record lacks.
const BOX_DEFAULTS = {
  range: { w: 0.76, d: 0.64, h: 0.91 }, fridge: { w: 0.76, d: 0.72, h: 1.75 }, dishwasher: { w: 0.6, d: 0.6, h: 0.86 },
  'washer-dryer': { w: 0.6, d: 0.65, h: 1.79 }, bed: { w: 2.0, d: 1.57, h: 0.59 }, 'table-round': { w: 0.8, d: 0.8, h: 0.71 },
  'table-rect': { w: 1.6, d: 0.9, h: 0.74 }, sofa: { w: 2.1, d: 0.92, h: 0.8, seat: 0.48 }, desk: { w: 1.4, d: 0.7, h: 0.76 },
  storage: { w: 1.6, d: 0.45, h: 0.61 }, tub: { w: 1.6, d: 0.76, h: 0.56 }, vanity: { w: 0.9, d: 0.55, h: 0.83 }, toilet: { w: 0.5, d: 0.72, h: 0.78 },
  // Wall- and ceiling-mounted pieces start at their usual mounting height (y0).
  microwave: { w: 0.76, d: 0.4, h: 0.42, y0: 1.5 }, 'range-hood': { w: 0.76, d: 0.5, h: 0.15, y0: 1.6 }, 'mini-split': { w: 0.84, d: 0.2, h: 0.29, y0: 2.0 },
  'water-heater': { w: 0.56, d: 0.56, h: 1.5 }, faucet: { w: 0.14, d: 0.2, h: 0.32, y0: 0.91 }, 'shower-trim': { w: 0.18, d: 0.3, h: 1.45, y0: 0.6 },
  panel: { w: 0.36, d: 0.1, h: 0.6, y0: 1.2 }, thermostat: { w: 0.12, d: 0.03, h: 0.09, y0: 1.45 }, light: { w: 0.4, d: 0.4, h: 0.15, y0: 2.2 },
  'outdoor-unit': { w: 0.8, d: 0.3, h: 0.55 }, shutoff: { w: 0.07, d: 0.09, h: 0.4, y0: 0.15 }, 'line-set': { w: 0.05, d: 0.03, h: 2.0 },
  vent: { w: 0.11, d: 0.11, h: 0.3 }, drain: { w: 0.05, d: 0.35, h: 0.4, y0: 0.35 },
};
const MATERIAL_DEFAULTS = {
  'base-run': { material: 'mat-quartz', bodyMaterial: 'mat-trim' }, 'wall-run': { material: null, bodyMaterial: 'mat-trim' },
  appliance: { material: 'mat-stainless' }, furniture: { material: null }, bath: { material: null }, fitting: { material: null },
};
// Usually enamelled white rather than stainless: no finish, so their parts draw white.
export const WHITE_GOODS = new Set(['washer-dryer', 'mini-split', 'water-heater']);
// Colours when a part has no material (also the SketchUp mirror's fallback finish).
export const FIXTURE_FALLBACK = { top: '#e9e5dc', body: '#efece6', kick: '#3a3c3f', appliance: '#c9cbcd', fabric: '#b9ae9d', wood: '#a98a63', bath: '#f4f3ef', fitting: '#b9bdc1',
  white: '#e8e7e2', black: '#18191b', glass: '#20282b', chrome: '#c3c6c8', panel: '#2b2d30', copper: '#b06f45' };
// Roles that wear the fixture's chosen finish; the rest are fixed (controls, glass, trim, pipes).
const FINISHED = new Set(['appliance', 'white', 'bath', 'fitting', 'top', 'wood', 'fabric']);

const fin = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const SOURCES = new Set(['scan', 'user', 'tape']);

export function fixtureLabel(f) {
  if (!f) return 'Fixture';
  if (f.name) return String(f.name);
  return SUBTYPE_LABEL[f.subtype] || (FIXTURE_KINDS[f.kind] || {}).label || 'Fixture';
}
export function fixtureShape(f) { return (FIXTURE_KINDS[f && f.kind] || {}).shape || null; }

// A new record of `kind` (and `subtype`) with typical dimensions; `at` places it.
export function fixtureTemplate(kind, subtype, at) {
  const k = FIXTURE_KINDS[kind];
  if (!k) throw new Error('unknown fixture kind ' + kind);
  at = at || {};
  const base = Object.assign({ kind, level: at.level || null, name: '', provenance: { source: 'user', confidence: null } }, MATERIAL_DEFAULTS[kind]);
  const x = fin(at.x, 0), y = fin(at.y, 0);
  if (k.shape === 'run') {
    const len = fin(at.length, 2.4);
    return Object.assign(base, { pts: [[x - len / 2, y], [x + len / 2, y]], side: 1, corners: [] },
      kind === 'base-run' ? { depth: 0.62, y0: 0, h: 0.91, counterT: 0.03, toeKick: 0.1, toeDepth: 0.06, overhang: 0.025 } : { depth: 0.32, y0: 1.4, h: 0.9 });
  }
  const sub = k.subtypes.includes(subtype) ? subtype : k.subtypes[0];
  const dims = BOX_DEFAULTS[sub];
  return Object.assign(base, { subtype: sub, x, y, rot: fin(at.rot, 0), y0: 0 }, dims, sub === 'vanity' ? { material: 'mat-quartz', bodyMaterial: 'mat-trim' } : {},
    WHITE_GOODS.has(sub) ? { material: null } : {});
}

// Bring a record from a file or another device into shape; null when it cannot be one.
export function normaliseFixture(f, levelIds) {
  if (!f || typeof f !== 'object' || !FIXTURE_KINDS[f.kind]) return null;
  const k = FIXTURE_KINDS[f.kind];
  if (levelIds && !levelIds.has(f.level)) f.level = levelIds.values().next().value || null;
  if (typeof f.name !== 'string') f.name = '';
  const p = f.provenance && typeof f.provenance === 'object' ? f.provenance : {};
  f.provenance = { ...p, source: SOURCES.has(p.source) ? p.source : 'user', confidence: Number.isFinite(p.confidence) ? clamp(p.confidence, 0, 1) : null };
  for (const key of ['material', 'bodyMaterial']) if (f[key] !== undefined && typeof f[key] !== 'string') f[key] = null;
  f.y0 = clamp(fin(f.y0, 0), -1, 20);
  if (k.shape === 'run') {
    const pts = Array.isArray(f.pts) ? f.pts.filter(q => Array.isArray(q) && Number.isFinite(+q[0]) && Number.isFinite(+q[1])).map(q => [+q[0], +q[1]]) : [];
    if (pts.length < 2) return null;
    f.pts = pts;
    f.side = f.side === -1 ? -1 : 1;
    f.depth = clamp(fin(f.depth, f.kind === 'base-run' ? 0.62 : 0.32), 0.05, 3);
    f.h = clamp(fin(f.h, f.kind === 'base-run' ? 0.91 : 0.9), 0.05, 6);
    f.corners = Array.isArray(f.corners) ? f.corners.slice(0, pts.length).map(r => Number.isFinite(r) && r > 0 ? r : null) : [];
    if (f.kind === 'base-run') {
      f.counterT = clamp(fin(f.counterT, 0.03), 0, 0.2);
      f.toeKick = clamp(fin(f.toeKick, 0.1), 0, 0.3);
      f.toeDepth = clamp(fin(f.toeDepth, 0.06), 0, 0.3);
      f.overhang = clamp(fin(f.overhang, 0.025), 0, 0.5);
    }
  } else {
    if (!k.subtypes.includes(f.subtype)) f.subtype = k.subtypes[0];
    const d = BOX_DEFAULTS[f.subtype];
    for (const key of ['x', 'y']) f[key] = fin(f[key], 0);
    f.rot = fin(f.rot, 0);
    for (const key of ['w', 'd', 'h']) f[key] = clamp(fin(f[key], d[key]), 0.01, 20);
    if (f.subtype === 'sofa') f.seat = clamp(fin(f.seat, d.seat), 0.1, f.h);
    const detail = normaliseDetail(f.subtype, f.detail);
    if (detail) f.detail = detail; else delete f.detail;
  }
  if (f.product !== undefined) f.product = normaliseProduct(f.product, k.shape);
  if (f.product === null) delete f.product;
  return f;
}

// ---------- product: the real thing standing there ----------

export const PRODUCT_CONFIDENCE = ['confirmed', 'likely', 'unidentified'];
const CONF = new Set(PRODUCT_CONFIDENCE);
const text = (v, n) => typeof v === 'string' ? v.trim().slice(0, n) : '';
const TURNS = [0, 90, 180, 270];
const MODEL_FORMATS = new Set(['glb', 'obj', 'stl', 'ply']);   // what the 3D view loads directly

// A public web page, or null (no local addresses, no credentials in the URL).
export function publicUrl(v) {
  let u;
  try { u = new URL(String(v)); } catch (e) { return null; }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password || !u.hostname.includes('.')) return null;
  if (/^(localhost|.*\.local|.*\.localhost|.*\.internal)$/i.test(u.hostname) || /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(u.hostname) || u.hostname.startsWith('[')) return null;
  return u.href;
}

function normaliseEvidence(e) {
  if (!e || typeof e !== 'object') return null;
  const media = text(e.media, 240), keyframe = text(e.keyframe, 120);
  if (!media && !keyframe) return null;
  const at = Number.isFinite(e.at) && e.at >= 0 ? Math.round(e.at * 1000) / 1000 : null;
  const crop = Array.isArray(e.crop) && e.crop.length === 4 && e.crop.every(Number.isFinite) && e.crop[2] > 0 && e.crop[3] > 0
    ? e.crop.map(v => clamp(Math.round(v * 1e4) / 1e4, 0, 1)) : null;
  const reads = (Array.isArray(e.reads) ? e.reads : []).filter(r => r === 'brand' || r === 'model');
  return { media, at, keyframe: keyframe || null, crop, reads: [...new Set(reads)], note: text(e.note, 400) };
}

// The product record in shape; null when it says nothing. Never stores a guess as confirmed:
// a confirmed brand or model without evidence that reads it becomes 'likely'.
export function normaliseProduct(p, shape) {
  if (!p || typeof p !== 'object') return null;
  const evidence = (Array.isArray(p.evidence) ? p.evidence : []).map(normaliseEvidence).filter(Boolean).slice(0, 24);
  const sources = [];
  for (const s of Array.isArray(p.sources) ? p.sources : []) {
    const url = publicUrl(s && typeof s === 'object' ? s.url : s);
    if (url && !sources.some(x => x.url === url)) sources.push({ url, title: text(s && s.title, 200) });
  }
  const read = what => evidence.some(e => e.reads.includes(what));
  const level = (name, conf, what) => {
    if (!name) return 'unidentified';
    const c = CONF.has(conf) && conf !== 'unidentified' ? conf : 'likely';
    return c === 'confirmed' && !read(what) ? 'likely' : c;
  };
  const brand = text(p.brand, 80), model = brand ? text(p.model, 80) : '';
  const out = { brand, brandConfidence: level(brand, p.brandConfidence, 'brand'), model, modelConfidence: level(model, p.modelConfidence, 'model'),
    evidence, sources: sources.slice(0, 16), asset: null, assetNote: text(p.assetNote, 400), checkedAt: text(p.checkedAt, 40) };
  if (typeof p.productId === 'string' && /^[\w.:-]{1,80}$/.test(p.productId) && brand) out.productId = p.productId;   // its PRODUCTS record
  if (p.dimsFrom) out.dimsFrom = text(p.dimsFrom, 200);
  const a = p.asset;
  if (shape === 'box' && a && typeof a === 'object' && typeof a.fileId === 'string' && a.fileId && validBounds(a.bounds)) {
    out.asset = { fileId: a.fileId.slice(0, 80), format: MODEL_FORMATS.has(a.format) ? a.format : 'glb', name: text(a.name, 200),
      sourceFileId: typeof a.sourceFileId === 'string' && a.sourceFileId ? a.sourceFileId.slice(0, 80) : null, sourceName: text(a.sourceName, 200),
      origin: publicUrl(a.origin) || '', originName: text(a.originName, 120), license: text(a.license, 200),
      turn: TURNS.includes(a.turn) ? a.turn : 0, bounds: { min: a.bounds.min.map(Number), max: a.bounds.max.map(Number) } };
  }
  return out.brand || out.evidence.length || out.sources.length || out.asset || out.assetNote ? out : null;
}

function validBounds(b) {
  return !!b && Array.isArray(b.min) && Array.isArray(b.max) && b.min.length === 3 && b.max.length === 3 &&
    b.min.every(Number.isFinite) && b.max.every(Number.isFinite) && b.max.every((v, i) => v - b.min[i] > 1e-4);
}

// "Frigidaire FFBD2412SS" with how sure each half is, for lists and the SketchUp group name.
export function productLabel(f) {
  const p = f && f.product;
  if (!p || !p.brand) return '';
  return p.brand + (p.model ? ' ' + p.model : '');
}
export function productConfidenceText(p) {
  if (!p || !p.brand) return 'Not identified';
  const b = p.brandConfidence === 'confirmed' ? 'brand read' : 'brand likely';
  return p.model ? b + ', model ' + (p.modelConfidence === 'confirmed' ? 'read' : 'likely') : b + ', model not read';
}

// The product model's own bounds in the fixture's local frame (u along the width, v toward
// the back, h up), after `turn`. A glTF model faces +Z with +Y up, so +Z goes to the
// fixture's front (-v) and +X to -u: a proper rotation, never a mirror image.
function turnedLocal(X, Y, Z, turn) {
  const t = (turn || 0) * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
  return [-(c * X + s * Z), -(-s * X + c * Z), Y];
}
export function productBoundsLocal(asset) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  const { min, max } = asset.bounds;
  for (const X of [min[0], max[0]]) for (const Y of [min[1], max[1]]) for (const Z of [min[2], max[2]]) {
    const q = turnedLocal(X, Y, Z, asset.turn);
    for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], q[i]); hi[i] = Math.max(hi[i], q[i]); }
  }
  return { min: lo, max: hi, size: hi.map((v, i) => v - lo[i]) };
}

// How the product model is stretched to stand in the measured box: per-axis scale (width,
// depth, height) and the largest departure from 1. A real model in metres should need
// almost none; a large one means the model, its units or the measurement is wrong.
export function productFit(f) {
  const a = f && f.product && f.product.asset;
  if (!a || fixtureShape(f) !== 'box') return null;
  const b = productBoundsLocal(a);
  const scale = [f.w / b.size[0], f.d / b.size[1], f.h / b.size[2]];
  return { scale, size: b.size, off: Math.max(...scale.map(s => Math.abs(s - 1))), local: b };
}

// Column-major 4x4 from the GLB's coordinates to the fixture's local frame (u, v, h metres
// above the level floor): what the SketchUp mirror receives.
export function productLocalMatrix(f) {
  const fit = productFit(f);
  if (!fit) return null;
  const t = (f.product.asset.turn || 0) * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
  const [su, sv, sh] = fit.scale, b = fit.local;
  const uc = (b.min[0] + b.max[0]) / 2, vc = (b.min[1] + b.max[1]) / 2;
  // u = -(cX + sZ), v = sX - cZ, h = Y, then centred, scaled and lifted to y0.
  return [-su * c, sv * s, 0, 0, 0, 0, sh, 0, -su * s, -sv * c, 0, 0, -su * uc, -sv * vc, (f.y0 || 0) - sh * b.min[2], 1];
}

// The same, on to the 3D view's level coordinates (plan x, height, plan y).
export function productLevelMatrix(f) {
  const L = productLocalMatrix(f);
  if (!L) return null;
  const a = (f.rot || 0) * Math.PI / 180, C = Math.cos(a), S = Math.sin(a), out = new Array(16).fill(0);
  for (let col = 0; col < 4; col++) {
    const u = L[col * 4], v = L[col * 4 + 1], h = L[col * 4 + 2];
    out[col * 4] = u * C - v * S; out[col * 4 + 1] = h; out[col * 4 + 2] = u * S + v * C; out[col * 4 + 3] = L[col * 4 + 3];
  }
  out[12] += f.x; out[14] += f.y;
  return out;
}

// Apply a column-major 4x4 to flat xyz positions.
export function transformPositions(m, positions) {
  const out = new Float64Array(positions.length);
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    out[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
    out[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    out[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
  return out;
}

export function normaliseFixtures(list, prop) {
  const levelIds = new Set((prop && prop.levels || []).map(l => l.id));
  return (Array.isArray(list) ? list : []).map(f => normaliseFixture(f, levelIds.size ? levelIds : null)).filter(Boolean);
}

export function fixturesOn(prop, levelId) {
  const low = (prop.levels || []).reduce((a, l) => (!a || l.elevation < a.elevation ? l : a), null);
  const ids = new Set((prop.levels || []).map(l => l.id));
  return (prop.fixtures || []).filter(f => (ids.has(f.level) ? f.level : low && low.id) === levelId);
}

// ---------- geometry ----------

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const unit = v => { const l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l]; };
const leftN = u => [-u[1], u[0]];

// The back line offset by `dist` toward the side, mitred at every vertex.
function offsetLine(pts, side, dist) {
  const n = pts.length, dirs = [];
  for (let i = 0; i + 1 < n; i++) dirs.push(unit(sub(pts[i + 1], pts[i])));
  return pts.map((p, i) => {
    const a = dirs[Math.max(0, i - 1)], b = dirs[Math.min(dirs.length - 1, i)];
    const na = leftN(a), nb = leftN(b);
    const den = 1 + dot(na, nb);
    // Nearly folded back: a plain normal instead of an unbounded mitre.
    const m = den < 0.15 ? nb : [(na[0] + nb[0]) / den, (na[1] + nb[1]) / den];
    return add(p, m, side * dist);
  });
}

// The diagonal front at interior vertex i, for a layer offset by `dist`: the two points where
// it meets the layer's front lines, or null when the reach does not cut past the mitre.
function cornerCut(pts, side, dist, i, reach) {
  if (!(reach > 0) || i <= 0 || i >= pts.length - 1) return null;
  const C = pts[i], uA = unit(sub(pts[i], pts[i - 1])), uB = unit(sub(pts[i + 1], pts[i]));
  const M = offsetLine([pts[i - 1], C, pts[i + 1]], side, dist)[1];
  const b = unit(sub(M, C));
  const proj = dot(sub(M, C), b);
  if (reach <= proj + 1e-3) return null;
  const dA = [-uA[0], -uA[1]];
  const kA = dot(dA, b), kB = dot(uB, b);
  if (kA < 0.05 || kB < 0.05) return null;          // only an inner (reflex) front corner takes a diagonal
  return { M, A: add(M, dA, (reach - proj) / kA), B: add(M, uB, (reach - proj) / kB) };
}

// Plan polygons (convex) of one layer of a run: a mitred quad per segment and a triangle
// per diagonal corner.
function runLayer(f, dist, inset) {
  const pts = f.pts, back = inset ? offsetLine(pts, f.side, inset) : pts, front = offsetLine(pts, f.side, dist);
  const out = [];
  for (let i = 0; i + 1 < pts.length; i++) out.push([back[i], back[i + 1], front[i + 1], front[i]]);
  for (let i = 1; i + 1 < pts.length; i++) {
    const r = (f.corners || [])[i];
    const cut = r && cornerCut(pts, f.side, dist, i, r - (f.depth - dist));
    if (cut) out.push([cut.M, cut.A, cut.B]);
  }
  return out;
}

const circle = (r, n = 24) => Array.from({ length: n }, (_, k) => [r * Math.cos(2 * Math.PI * k / n), r * Math.sin(2 * Math.PI * k / n)]);
const rect = (u0, u1, v0, v1) => [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];

// Box fixtures in their local frame: [{ pts (u, v), y0, y1, role, material }], or for a
// solid { solid: [[u, v, height]...], faces, role, material } (fixture-detail.js).
function boxPartsLocal(f) {
  const w = f.w, d = f.d, h = f.h, y0 = f.y0 || 0, W = w / 2, D = d / 2;
  const whole = rect(-W, W, -D, D), m = f.material || null, body = f.bodyMaterial || null;
  const P = (pts, a, b, role, material) => ({ pts, y0: y0 + a, y1: y0 + b, role, material });
  const detailed = detailParts(f);
  if (detailed) return detailed.map(p => {
    const material = p.role === 'body' ? body : p.role === 'top' ? m : FINISHED.has(p.role) ? m : null;
    return p.solid ? { solid: p.solid.map(([u, v, y]) => [u, v, y0 + y]), faces: p.faces, role: p.role, material } : P(p.pts, p.a, p.b, p.role, material);
  });
  switch (f.subtype) {
    case 'bed': { const base = Math.max(0.12, h - 0.24); return [P(whole, 0, base, 'wood', body), P(rect(-W + 0.02, W - 0.02, -D + 0.02, D - 0.02), base, h, 'fabric', m)]; }
    case 'table-round': { const t = Math.min(0.05, h / 3); return [P(circle(W), h - t, h, 'wood', m), P(circle(Math.min(0.07, W / 4), 12), 0, h - t, 'wood', m)]; }
    case 'table-rect': case 'desk': {
      const t = Math.min(0.04, h / 3), l = Math.min(0.05, W / 4, D / 4), legs = [];
      const span = (sgn, half) => sgn < 0 ? [-half, -half + l] : [half - l, half];
      for (const su of [-1, 1]) for (const sv of [-1, 1]) legs.push(P(rect(...span(su, W), ...span(sv, D)), 0, h - t, 'wood', m));
      return [P(whole, h - t, h, 'wood', m), ...legs];
    }
    case 'sofa': { const seat = clamp(f.seat || 0.48, 0.1, h), back = Math.min(0.24, d * 0.35); return [P(rect(-W, W, -D, D - back), 0, seat, 'fabric', m), P(rect(-W, W, D - back, D), 0, h, 'fabric', m)]; }
    case 'vanity': { const t = Math.min(0.03, h / 4); return [P(rect(-W, W, -D + 0.02, D), 0, h - t, 'body', body), P(whole, h - t, h, 'top', m)]; }
    case 'toilet': { const tank = Math.min(0.22, d * 0.35); return [P(rect(-W, W, D - tank, D), 0, h, 'bath', m), P(rect(-W * 0.9, W * 0.9, -D, D - tank), 0, Math.min(h, 0.41), 'bath', m)]; }
    case 'tub': return [P(whole, 0, h, 'bath', m)];
    default: return [P(whole, 0, h, f.kind === 'appliance' ? 'appliance' : f.kind === 'furniture' ? 'wood' : f.kind === 'fitting' ? 'fitting' : 'bath', m)];
  }
}

// Local (u, v) to plan for a box fixture.
export function boxFrame(f) {
  const a = (f.rot || 0) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  return { origin: [f.x, f.y], angle: a, toPlan: ([u, v]) => [f.x + u * c - v * s, f.y + u * s + v * c] };
}

// Every prism of a fixture in plan coordinates: [{ pts, y0, y1, role, material }], and its
// convex solids as { solid: [[x, y, height]...], faces, role, material }.
export function fixtureParts(f) {
  if (fixtureShape(f) === 'box') {
    const { toPlan } = boxFrame(f);
    return boxPartsLocal(f).map(p => p.solid
      ? Object.assign({}, p, { solid: p.solid.map(([u, v, y]) => [...toPlan([u, v]), y]) })
      : Object.assign({}, p, { pts: p.pts.map(toPlan) }));
  }
  if (fixtureShape(f) !== 'run' || (f.pts || []).length < 2) return [];
  const y0 = f.y0 || 0, out = [];
  const layer = (dist, a, b, role, material, inset) => { for (const pts of runLayer(f, dist, inset)) out.push({ pts, y0: y0 + a, y1: y0 + b, role, material }); };
  if (f.kind === 'base-run') {
    const top = f.h, t = Math.min(f.counterT ?? 0.03, top / 2), kick = Math.min(f.toeKick ?? 0.1, top - t);
    const bodyD = Math.max(0.05, f.depth - (f.overhang ?? 0.025)), kickD = Math.max(0.03, bodyD - (f.toeDepth ?? 0.06));
    if (kick > 0.005) layer(kickD, 0, kick, 'kick', null);
    layer(bodyD, kick, top - t, 'body', f.bodyMaterial || null);
    if (t > 0.002) layer(f.depth, top - t, top, 'top', f.material || null);
  } else layer(f.depth, 0, f.h, 'body', f.bodyMaterial || f.material || null);
  return out;
}

// The plan outline (one closed polygon) PLAN draws: back line, mitred front, diagonal corners.
export function fixtureOutline(f) {
  if (fixtureShape(f) === 'box') {
    const { toPlan } = boxFrame(f);
    return (f.subtype === 'table-round' ? circle(f.w / 2) : rect(-f.w / 2, f.w / 2, -f.d / 2, f.d / 2)).map(toPlan);
  }
  const pts = f.pts || [];
  if (pts.length < 2) return [];
  const front = offsetLine(pts, f.side, f.depth), ring = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const cut = (f.corners || [])[i] && cornerCut(pts, f.side, f.depth, i, f.corners[i]);
    if (cut) ring.push(cut.B, cut.A); else ring.push(front[i]);
  }
  return pts.map(p => p.slice()).concat(ring);
}

export function runLength(f) {
  let L = 0;
  for (let i = 0; i + 1 < (f.pts || []).length; i++) L += Math.hypot(f.pts[i + 1][0] - f.pts[i][0], f.pts[i + 1][1] - f.pts[i][1]);
  return L;
}

export function fixtureCentre(f) {
  if (fixtureShape(f) === 'box') return [f.x, f.y];
  const ring = fixtureOutline(f);
  const c = ring.reduce((s, p) => [s[0] + p[0], s[1] + p[1]], [0, 0]);
  return ring.length ? [c[0] / ring.length, c[1] / ring.length] : [0, 0];
}

// Move a whole fixture by (dx, dy) in plan.
export function moveFixture(f, dx, dy) {
  if (fixtureShape(f) === 'box') { f.x += dx; f.y += dy; }
  else f.pts = f.pts.map(p => [p[0] + dx, p[1] + dy]);
}

// The room whose outline holds the fixture's centre, or ''.
export function roomOfFixture(rooms, f) {
  const [x, y] = fixtureCentre(f);
  const r = (rooms || []).find(r => r.level === f.level && (r.pts || []).length >= 3 && inside(x, y, r.pts));
  return r ? r.id : '';
}
function inside(px, py, pts) {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}

// The values the SketchUp mirror writes and reads back for a fixture (see sketchup-mirror.js).
export function fixtureMirrorParams(f) {
  const r = v => Math.round(v * 1e6) / 1e6;
  if (fixtureShape(f) === 'box') return { kind: f.kind, subtype: f.subtype, shape: 'box', x: r(f.x), y: r(f.y), rot: r(f.rot || 0), w: r(f.w), d: r(f.d), y0: r(f.y0 || 0), h: r(f.h) };
  return { kind: f.kind, subtype: null, shape: 'run', pts: f.pts.map(p => [r(p[0]), r(p[1])]), depth: r(f.depth), y0: r(f.y0 || 0), h: r(f.h) };
}

// A frame for the mirror's group: origin and plan angle of local u, and part rings in (u, v).
export function fixtureLocalFrame(f) {
  const origin = fixtureShape(f) === 'box' ? [f.x, f.y] : f.pts[0];
  const angle = fixtureShape(f) === 'box' ? (f.rot || 0) * Math.PI / 180 : Math.atan2(f.pts[1][1] - f.pts[0][1], f.pts[1][0] - f.pts[0][0]);
  const c = Math.cos(angle), s = Math.sin(angle);
  const toLocal = p => { const dx = p[0] - origin[0], dy = p[1] - origin[1]; return [dx * c + dy * s, -dx * s + dy * c]; };
  return { origin, angle, toLocal };
}
