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

export const FIXTURE_KINDS = {
  'base-run': { label: 'Base cabinets', shape: 'run', subtypes: [] },
  'wall-run': { label: 'Wall cabinets', shape: 'run', subtypes: [] },
  appliance: { label: 'Appliance', shape: 'box', subtypes: ['range', 'fridge', 'dishwasher', 'washer-dryer'] },
  furniture: { label: 'Furniture', shape: 'box', subtypes: ['bed', 'table-round', 'table-rect', 'sofa', 'desk', 'storage'] },
  bath: { label: 'Bath', shape: 'box', subtypes: ['tub', 'vanity', 'toilet'] },
};

const SUBTYPE_LABEL = { range: 'Range', fridge: 'Fridge', dishwasher: 'Dishwasher', 'washer-dryer': 'Washer / dryer', bed: 'Bed',
  'table-round': 'Round table', 'table-rect': 'Table', sofa: 'Sofa', desk: 'Desk', storage: 'Storage', tub: 'Tub', vanity: 'Vanity', toilet: 'Toilet' };

// Typical sizes, used for a hand-added fixture and to fill fields a record lacks.
const BOX_DEFAULTS = {
  range: { w: 0.76, d: 0.64, h: 0.91 }, fridge: { w: 0.76, d: 0.72, h: 1.75 }, dishwasher: { w: 0.6, d: 0.6, h: 0.86 },
  'washer-dryer': { w: 0.6, d: 0.65, h: 1.79 }, bed: { w: 2.0, d: 1.57, h: 0.59 }, 'table-round': { w: 0.8, d: 0.8, h: 0.71 },
  'table-rect': { w: 1.6, d: 0.9, h: 0.74 }, sofa: { w: 2.1, d: 0.92, h: 0.8, seat: 0.48 }, desk: { w: 1.4, d: 0.7, h: 0.76 },
  storage: { w: 1.6, d: 0.45, h: 0.61 }, tub: { w: 1.6, d: 0.76, h: 0.56 }, vanity: { w: 0.9, d: 0.55, h: 0.83 }, toilet: { w: 0.4, d: 0.7, h: 0.78 },
};
const MATERIAL_DEFAULTS = {
  'base-run': { material: 'mat-quartz', bodyMaterial: 'mat-trim' }, 'wall-run': { material: null, bodyMaterial: 'mat-trim' },
  appliance: { material: 'mat-stainless' }, furniture: { material: null }, bath: { material: null },
};
// Colours when a part has no material (also the SketchUp mirror's fallback finish).
export const FIXTURE_FALLBACK = { top: '#e9e5dc', body: '#efece6', kick: '#3a3c3f', appliance: '#c9cbcd', fabric: '#b9ae9d', wood: '#a98a63', bath: '#f4f3ef' };

const fin = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const SOURCES = new Set(['scan', 'user', 'tape', 'unknown']);

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
  return Object.assign(base, { subtype: sub, x, y, rot: fin(at.rot, 0), y0: 0 }, dims, sub === 'vanity' ? { material: 'mat-quartz', bodyMaterial: 'mat-trim' } : {});
}

// Bring a record from a file or another device into shape; null when it cannot be one.
export function normaliseFixture(f, levelIds) {
  if (!f || typeof f !== 'object' || !FIXTURE_KINDS[f.kind]) return null;
  const k = FIXTURE_KINDS[f.kind];
  const rawDimensions = Object.fromEntries(['w','d','h','depth','y0','rot','x','y','counterT','toeKick','toeDepth','overhang'].filter(key => f[key] !== undefined).map(key => [key, f[key]]));
  const rawLevel = f.level;
  if (levelIds && !levelIds.has(f.level)) f.level = levelIds.values().next().value || null;
  if (typeof f.name !== 'string') f.name = '';
  const p = f.provenance && typeof f.provenance === 'object' ? f.provenance : {};
  const validConfidence = Number.isFinite(p.confidence) && p.confidence >= 0 && p.confidence <= 1;
  f.provenance = { ...p, source: SOURCES.has(p.source) ? p.source : 'unknown', confidence: validConfidence ? p.confidence : null };
  if (p.source && !SOURCES.has(p.source)) f.provenance.rawSource = p.source;
  if (p.confidence != null && !validConfidence) f.provenance.rawConfidence = p.confidence;
  const defaults = [...(f.provenance.defaultedFields || [])];
  for (const key of k.shape === 'run' ? ['depth', 'h'] : ['w', 'd', 'h']) if (!Number.isFinite(f[key])) defaults.push(key);
  if (defaults.length) f.provenance.defaultedFields = [...new Set(defaults)];
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
    // An unrecognized object keeps its identity and uses an explicitly unverified box.
    const d = BOX_DEFAULTS[f.subtype] || { w: 0.6, d: 0.6, h: 0.9 };
    if (!k.subtypes.includes(f.subtype)) f.provenance.unresolvedSubtype = true;
    for (const key of ['x', 'y']) f[key] = fin(f[key], 0);
    f.rot = fin(f.rot, 0);
    for (const key of ['w', 'd', 'h']) f[key] = clamp(fin(f[key], d[key]), 0.05, 20);
    if (f.subtype === 'sofa') f.seat = clamp(fin(f.seat, d.seat), 0.1, f.h);
  }
  const adjusted = { ...(f.provenance.adjustedFields || {}) };
  for (const [key, raw] of Object.entries(rawDimensions)) if (typeof raw !== 'number' || raw !== f[key]) adjusted[key] = { raw, displayed: f[key] };
  if (rawLevel !== f.level) adjusted.level = { raw: rawLevel, displayed: f.level };
  if (Object.keys(adjusted).length) f.provenance.adjustedFields = adjusted;
  return f;
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

// Box fixtures in their local frame: [{ pts (u, v), y0, y1, role, material }].
function boxPartsLocal(f) {
  const w = f.w, d = f.d, h = f.h, y0 = f.y0 || 0, W = w / 2, D = d / 2;
  const whole = rect(-W, W, -D, D), m = f.material || null, body = f.bodyMaterial || null;
  const P = (pts, a, b, role, material) => ({ pts, y0: y0 + a, y1: y0 + b, role, material });
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
    default: return [P(whole, 0, h, f.kind === 'appliance' ? 'appliance' : f.kind === 'furniture' ? 'wood' : 'bath', m)];
  }
}

// Local (u, v) to plan for a box fixture.
export function boxFrame(f) {
  const a = (f.rot || 0) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  return { origin: [f.x, f.y], angle: a, toPlan: ([u, v]) => [f.x + u * c - v * s, f.y + u * s + v * c] };
}

// Every prism of a fixture in plan coordinates: [{ pts, y0, y1, role, material }].
export function fixtureParts(f) {
  if (fixtureShape(f) === 'box') {
    const { toPlan } = boxFrame(f);
    return boxPartsLocal(f).map(p => Object.assign({}, p, { pts: p.pts.map(toPlan) }));
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
