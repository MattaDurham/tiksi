// Detailed stand-ins for box fixtures (fixtures.js): the parts a real range, dishwasher,
// fridge, laundry centre, mini-split head, toilet, vanity, breaker panel or supply valve is
// built from, sized from the fixture's box and its `detail` (numbers read off the product's
// spec sheet or installation drawing: kick height, freezer split, burner count, circuits).
// A product's own 3D model (fixture-products.js) replaces these when one is attached.
//
// Parts are in the fixture's local frame: u across the width (-W..W), v front to back
// (-D is the front, the tips of handles and knobs; +D is against the wall), heights from the
// fixture's bottom. Two part forms:
//   { pts: [[u, v]...] convex ring, a, b }     a vertical prism from height a to b
//   { solid: [[u, v, y]...], faces: [[i...]] } a convex solid (a knob or a porthole facing
//                                              the room); renderers orient its faces outward
// Every part stays inside the box, so the SketchUp mirror reads the box back unchanged.
//
// Roles pick the finish: 'appliance', 'white', 'bath', 'body', 'top', 'fitting' take the
// fixture's chosen finish; 'black', 'glass', 'chrome', 'panel', 'copper', 'kick' are the
// fixed colours of controls, glass, trim and pipes.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? clamp(n, lo, hi) : d; };
const pick = (v, list) => list.includes(v) ? v : list[0];
const rect = (u0, u1, v0, v1) => [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
const disc = (cu, cv, r, n = 16) => Array.from({ length: n }, (_, k) => [cu + r * Math.cos(2 * Math.PI * k / n), cv + r * Math.sin(2 * Math.PI * k / n)]);
const ellipse = (cu, cv, ru, rv, n = 20) => Array.from({ length: n }, (_, k) => [cu + ru * Math.cos(2 * Math.PI * k / n), cv + rv * Math.sin(2 * Math.PI * k / n)]);

// A disc facing the room (axis along v): centre (cu, cy), radius r, from v0 to v1.
function frontDisc(cu, cy, r, v0, v1, n = 16) {
  const ring = Array.from({ length: n }, (_, k) => [cu + r * Math.cos(2 * Math.PI * k / n), cy + r * Math.sin(2 * Math.PI * k / n)]);
  const solid = [...ring.map(([u, y]) => [u, v0, y]), ...ring.map(([u, y]) => [u, v1, y])];
  const faces = [ring.map((_, k) => k), ring.map((_, k) => 2 * n - 1 - k)];
  for (let k = 0; k < n; k++) faces.push([k, (k + 1) % n, n + (k + 1) % n, n + k]);
  return { solid, faces };
}

// What each subtype's detail may hold, with defaults. Lengths in metres.
export const DETAIL_DEFAULTS = {
  range: { fuel: 'gas', burners: 4, knobs: 6, backguard: 0.08, drawer: true, window: true },
  dishwasher: { kick: 0.1, controls: 'front', handle: 'bar' },
  fridge: { layout: 'top-freezer', split: 0.68, hinge: 'right', handle: 'bar' },
  'washer-dryer': { layout: 'stacked', split: 0.52 },
  microwave: { controls: 'right' },
  'range-hood': { style: 'under-cabinet' },
  'mini-split': { display: true },
  'water-heater': { fuel: 'gas' },
  toilet: { bowl: 'elongated', tank: 0.38 },
  vanity: { doors: 2, sink: 'undermount', kick: 0.1, counter: 0.03 },
  tub: { apron: true },
  faucet: { style: 'single-lever' },
  'shower-trim': { head: true, spout: true },
  panel: { door: 'open', circuits: [] },
  thermostat: {},
  light: { style: 'flush' },
  'outdoor-unit': {},
  shutoff: { supply: 'braided' },
  'line-set': { pipes: 2 },
  vent: { shape: 'round' },
  drain: { trap: true },
};
const RANGES = { burners: [2, 6], knobs: [0, 8], doors: [1, 4], pipes: [1, 4], split: [0.05, 0.95], backguard: [0, 0.4], kick: [0, 0.3], tank: [0.2, 0.6], counter: [0.005, 0.1] };
const CHOICES = {
  fuel: ['gas', 'electric'], controls: ['front', 'top', 'right'], handle: ['bar', 'pocket'], hinge: ['right', 'left'],
  layout: { fridge: ['top-freezer', 'bottom-freezer', 'french', 'side-by-side', 'single'], 'washer-dryer': ['stacked', 'front-washer', 'front-dryer', 'top-washer'] },
  style: { 'range-hood': ['under-cabinet', 'chimney'], faucet: ['single-lever', 'pull-down', 'two-handle'], light: ['flush', 'pendant'] },
  bowl: ['elongated', 'round'], sink: ['undermount', 'vessel', 'none'], door: ['open', 'closed'], supply: ['braided', 'rigid'], shape: ['round', 'square'],
};

// The detail in shape for its subtype; unknown keys are dropped.
export function normaliseDetail(subtype, detail) {
  const def = DETAIL_DEFAULTS[subtype];
  if (!def) return undefined;
  const d = detail && typeof detail === 'object' ? detail : {}, out = {};
  for (const [k, v0] of Object.entries(def)) {
    const v = d[k];
    if (typeof v0 === 'boolean') out[k] = typeof v === 'boolean' ? v : v0;
    else if (typeof v0 === 'number') out[k] = num(v, v0, ...RANGES[k]);
    else if (Array.isArray(v0)) out[k] = (Array.isArray(v) ? v : []).filter(c => c && typeof c === 'object').slice(0, 84).map(c => ({
      n: Number.isInteger(c.n) && c.n > 0 && c.n < 100 ? c.n : null, label: typeof c.label === 'string' ? c.label.slice(0, 60) : '',
      amps: Number.isFinite(c.amps) && c.amps > 0 && c.amps <= 400 ? c.amps : null, poles: c.poles === 2 ? 2 : 1 }));
    else {
      const list = Array.isArray(CHOICES[k]) ? CHOICES[k] : (CHOICES[k] || {})[subtype] || [v0];
      out[k] = pick(v, list.includes(v0) ? [v0, ...list.filter(x => x !== v0)] : list);
    }
  }
  for (const k of ['burners', 'knobs', 'doors', 'pipes']) if (k in out) out[k] = Math.round(out[k]);
  return out;
}

// Parts of a box fixture with a detailed builder, or null (the caller draws its simple shape).
// `body` is the fixture's own finish role for the main surfaces.
export function detailParts(f) {
  const build = BUILDERS[f.subtype];
  if (!build) return null;
  const W = f.w / 2, D = f.d / 2, h = f.h, det = normaliseDetail(f.subtype, f.detail);
  const out = [];
  const P = (pts, a, b, role) => { if (b - a > 1e-4) out.push({ pts, a, b, role }); };
  const S = (part, role) => out.push(Object.assign(part, { role }));
  build({ W, D, h, det, P, S, kind: f.kind });
  return fill(out.map(p => clampPart(p, W, D, h)).filter(solidEnough), W, D, h);
}

// Stretch the parts, axis by axis, so together they span exactly the box: the measured box
// is the truth, and the SketchUp mirror reads a fixture's size back from its bounds.
function fill(parts, W, D, h) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  const each = (p, fn) => p.solid ? p.solid.forEach(q => fn(q[0], q[1], q[2])) : p.pts.forEach(([u, v]) => { fn(u, v, p.a); fn(u, v, p.b); });
  for (const p of parts) each(p, (u, v, y) => { const q = [u, v, y]; for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], q[i]); hi[i] = Math.max(hi[i], q[i]); } });
  if (!parts.length) return parts;
  const want = [[-W, W], [-D, D], [0, h]];
  const map = want.map(([a, b], i) => { const span = hi[i] - lo[i]; return span > 1e-9 ? x => a + (x - lo[i]) * (b - a) / span : x => x; });
  return parts.map(p => p.solid ? Object.assign({}, p, { solid: p.solid.map(([u, v, y]) => [map[0](u), map[1](v), map[2](y)]) })
    : Object.assign({}, p, { pts: p.pts.map(([u, v]) => [map[0](u), map[1](v)]), a: map[2](p.a), b: map[2](p.b) }));
}

// A part squeezed flat by a small box would make faces SketchUp refuses.
function solidEnough(p) {
  const pts = p.solid || p.pts, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const q of pts) for (let i = 0; i < q.length; i++) { lo[i] = Math.min(lo[i], q[i]); hi[i] = Math.max(hi[i], q[i]); }
  const ext = hi.map((v, i) => v - lo[i]);
  return p.solid ? ext.every(e => e > 5e-4) : ext[0] > 5e-4 && ext[1] > 5e-4 && p.b - p.a > 1e-4;
}

function clampPart(p, W, D, h) {
  const cu = u => clamp(u, -W, W), cv = v => clamp(v, -D, D), cy = y => clamp(y, 0, h);
  if (p.solid) return Object.assign({}, p, { solid: p.solid.map(([u, v, y]) => [cu(u), cv(v), cy(y)]) });
  return Object.assign({}, p, { pts: p.pts.map(([u, v]) => [cu(u), cv(v)]), a: cy(p.a), b: cy(p.b) });
}

// A horizontal bar handle across u at height y, standing off the face at vFace.
function barU(P, u0, u1, y, vFace, depth = 0.035, t = 0.018) {
  P(rect(u0, u1, vFace - depth, vFace - depth + t), y - t / 2, y + t / 2, 'chrome');
  for (const u of [u0 + 0.01, u1 - 0.02]) P(rect(u, u + 0.012, vFace - depth + t, vFace), y - 0.007, y + 0.007, 'chrome');
}
function barY(P, u, y0, y1, vFace, depth = 0.04, t = 0.02) {
  P(rect(u - t / 2, u + t / 2, vFace - depth, vFace - depth + t), y0, y1, 'chrome');
  for (const y of [y0 + 0.01, y1 - 0.02]) P(rect(u - 0.006, u + 0.006, vFace - depth + t, vFace), y, y + 0.012, 'chrome');
}

const BUILDERS = {
  range({ W, D, h, det, P, S }) {
    const F = -D, knob = 0.03, face = F + knob + 0.02, dr = det.drawer ? 0.15 : 0.03, top = h - det.backguard;
    P(rect(-W, W, face + 0.03, D), 0, top - 0.02, 'appliance');                       // carcass
    P(rect(-W, W, face, D), top - 0.02, top, det.fuel === 'gas' ? 'appliance' : 'glass');   // cooktop
    P(rect(-W, W, face, face + 0.03), top - 0.13, top - 0.02, 'appliance');          // control strip
    for (let k = 0; k < det.knobs; k++) {
      const u = -W + (k + 0.5) * (2 * W) / det.knobs;
      S(frontDisc(u, top - 0.075, 0.019, face - knob, face), 'black');
    }
    P(rect(-W + 0.008, W - 0.008, face, face + 0.03), dr + 0.01, top - 0.135, 'appliance');   // oven door
    if (det.window && top - 0.3 > dr + 0.15) P(rect(-W + 0.09, W - 0.09, face - 0.003, face), dr + 0.12, top - 0.3, 'glass');
    barU(P, -W + 0.06, W - 0.06, top - 0.18, face, 0.05);
    if (det.drawer) { P(rect(-W + 0.008, W - 0.008, face, face + 0.03), 0.03, dr, 'appliance'); barU(P, -W + 0.12, W - 0.12, dr - 0.035, face, 0.03, 0.012); }
    P(rect(-W + 0.03, W - 0.03, face + 0.06, face + 0.08), 0, 0.03, 'kick');
    // Burners on a grid, cast-iron grates over gas burners.
    const n = det.burners, cols = n <= 4 ? 2 : 3, rows = Math.ceil(n / cols), du = (2 * W) / cols, dv = (D - 0.05 - face) / rows;
    for (let k = 0; k < n; k++) {
      const cu = -W + du * (k % cols + 0.5), cvv = face + dv * (Math.floor(k / cols) + 0.5), r = Math.min(du, dv) * (det.fuel === 'gas' ? 0.18 : 0.33);
      P(disc(cu, cvv, r), top, top + (det.fuel === 'gas' ? 0.014 : 0.001), det.fuel === 'gas' ? 'black' : 'panel');
    }
    if (det.fuel === 'gas') {
      for (let c = 0; c <= cols; c++) { const u = clamp(-W + c * du, -W + 0.01, W - 0.02); P(rect(u, u + 0.012, face + 0.01, D - 0.06), top + 0.014, top + 0.03, 'black'); }
      for (let r = 0; r <= rows; r++) { const v = clamp(face + 0.01 + r * dv, face + 0.01, D - 0.07); P(rect(-W + 0.01, W - 0.01, v, v + 0.012), top + 0.014, top + 0.03, 'black'); }
    }
    P(rect(-W, W, D - 0.05, D), top, h, 'appliance');                                // backguard
  },
  dishwasher({ W, D, h, det, P }) {
    const F = -D, face = F + (det.handle === 'bar' ? 0.04 : 0), k = Math.min(det.kick, h / 4), strip = det.controls === 'front' ? 0.1 : 0.02;
    P(rect(-W, W, face + 0.025, D), k, h, 'appliance');                               // tub (sides sit in the cabinets)
    P(rect(-W + 0.002, W - 0.002, face, face + 0.025), k, h - strip, 'appliance');    // door
    P(rect(-W + 0.002, W - 0.002, face, face + 0.025), h - strip, h, det.controls === 'front' ? 'panel' : 'appliance');
    if (det.handle === 'bar') barU(P, -W + 0.07, W - 0.07, h - strip - 0.04, face, 0.04);
    else P(rect(-W + 0.15, W - 0.15, face - 0.001, face + 0.01), h - strip - 0.06, h - strip - 0.03, 'black');
    P(rect(-W + 0.01, W - 0.01, face + 0.06, face + 0.08), 0, k, 'kick');
  },
  fridge({ W, D, h, det, P }) {
    const face = -D + 0.05, t = 0.055, base = 0.09, gap = 0.006, hu = det.hinge === 'right' ? -1 : 1;   // handles on the side away from the hinge
    P(rect(-W, W, face + t, D), 0.02, h, 'appliance');
    P(rect(-W + 0.02, W - 0.02, face + t - 0.01, face + t), 0.01, base, 'black');      // grille
    const door = (u0, u1, y0, y1, handleU, vertical = true) => {
      P(rect(u0, u1, face, face + t), y0, y1, 'appliance');
      if (vertical) barY(P, handleU, Math.max(y0 + 0.05, y1 - Math.min(0.9, (y1 - y0) * 0.8)), y1 - 0.05, face, 0.045);
      else barU(P, u0 + 0.08, u1 - 0.08, y1 - 0.06, face, 0.045);
    };
    const s = base + (h - base) * det.split, hU = hu * (W - 0.05);
    if (det.layout === 'top-freezer') { door(-W, W, s + gap / 2, h, hU); door(-W, W, base, s - gap / 2, hU); }
    else if (det.layout === 'bottom-freezer') { door(-W, W, s + gap / 2, h, hU); door(-W, W, base, s - gap / 2, 0, false); }
    else if (det.layout === 'french') { door(-W, -gap / 2, s + gap / 2, h, -0.04); door(gap / 2, W, s + gap / 2, h, 0.04); door(-W, W, base, s - gap / 2, 0, false); }
    else if (det.layout === 'side-by-side') { const m = -W * 0.15; door(-W, m - gap / 2, base, h, m - 0.04); door(m + gap / 2, W, base, h, m + 0.04); }
    else door(-W, W, base, h, hU);
  },
  'washer-dryer'({ W, D, h, det, P, S }) {
    const face = -D + 0.03;
    if (det.layout !== 'top-washer') P(rect(-W, W, face, D), 0.05, h, 'white');            // a top-loader's cabinet stops at its deck
    P(rect(-W + 0.03, W - 0.03, face + 0.02, face + 0.03), 0, 0.05, 'kick');
    const porthole = (cy, r, glass) => { S(frontDisc(0, cy, r, face - 0.024, face), 'chrome'); S(frontDisc(0, cy, r * 0.78, face - 0.03, face - 0.024), glass ? 'glass' : 'white'); };
    const panel = (y0, y1, dials) => {
      P(rect(-W + 0.004, W - 0.004, face - 0.01, face), y0, y1, 'panel');
      for (const u of dials) S(frontDisc(u, (y0 + y1) / 2, Math.min(0.03, (y1 - y0) * 0.35), face - 0.03, face - 0.01), 'white');
    };
    if (det.layout === 'stacked') {
      const s = h * det.split;
      P(rect(-W + 0.02, W - 0.02, face - 0.005, face), 0.07, s - 0.02, 'white');             // washer front
      panel(s, s + 0.13, [-W * 0.62, W * 0.62]);
      P(rect(-W + 0.05, W - 0.05, face - 0.015, face), s + 0.18, h - 0.04, 'white');          // dryer door
      barU(P, -W + 0.15, W - 0.15, s + 0.22, face - 0.015, 0.015, 0.012);
    } else if (det.layout === 'top-washer') {
      const deck = h - 0.16;                                                                // the console stands behind the lid
      P(rect(-W, W, face, D), 0.05, deck, 'white');
      P(rect(-W + 0.02, W - 0.02, face + 0.02, D - 0.13), deck, deck + 0.012, 'white');      // lid
      P(rect(-W + 0.03, W - 0.03, face + 0.05, face + 0.07), deck + 0.012, deck + 0.025, 'white');   // lid lift
      P(rect(-W, W, D - 0.11, D), deck, h, 'panel');
      for (const u of [-W * 0.6, W * 0.6]) S(frontDisc(u, deck + 0.08, 0.03, D - 0.13, D - 0.11), 'white');
      P(rect(-W + 0.02, W - 0.02, face - 0.005, face), 0.07, deck - 0.03, 'white');         // front panel
    } else {
      panel(h - 0.13, h - 0.02, [W * 0.55]);
      porthole(h * 0.45, Math.min(W, h * 0.45) * 0.72, det.layout === 'front-washer');
    }
  },
  microwave({ W, D, h, det, P }) {
    const face = -D + 0.04, ctl = det.controls === 'right' ? 0.12 : 0;
    P(rect(-W, W, face, D), 0, h, 'appliance');
    P(rect(-W + 0.01, W - ctl - 0.01, face - 0.003, face), 0.03, h - 0.03, 'glass');
    if (ctl) P(rect(W - ctl, W - 0.01, face - 0.003, face), 0.03, h - 0.03, 'panel');
    barY(P, W - ctl - 0.04, 0.06, h - 0.06, face - 0.003, 0.035);
  },
  'range-hood'({ W, D, h, det, P }) {
    P(rect(-W, W, -D, D), Math.min(h, 0.08), h, 'appliance');
    P(rect(-W, W, -D, -D + 0.04), 0, Math.min(h, 0.08), 'appliance');
    P(rect(-W + 0.03, W - 0.03, -D + 0.05, D - 0.03), Math.min(h, 0.08) - 0.005, Math.min(h, 0.08), 'panel');   // filters
    if (det.style === 'chimney') P(rect(-0.13, 0.13, D - 0.25, D), h * 0.4, h, 'appliance');
  },
  'mini-split'({ W, D, h, det, P }) {
    P(rect(-W, W, -D + 0.035, D), 0.05, h, 'white');                                   // chassis on its wall plate
    P(rect(-W + 0.004, W - 0.004, -D, -D + 0.035), 0.075, h - 0.008, 'white');          // front panel
    P(rect(-W + 0.05, W - 0.05, -D + 0.01, D - 0.05), 0, 0.05, 'black');               // air outlet
    P(rect(-W + 0.05, W - 0.05, -D, -D + 0.012), 0.012, 0.06, 'white');                // louvre vane
    if (det.display) P(rect(W * 0.45, W * 0.75, -D - 0.0, -D + 0.002), 0.085, 0.11, 'black');
  },
  'water-heater'({ W, D, h, det, P }) {
    const r = Math.min(W, D);
    P(disc(0, 0, r, 24), 0, h - 0.12, 'white');
    P(disc(0, 0, r * 0.94, 24), h - 0.12, h - 0.09, 'white');
    P(disc(0, 0, det.fuel === 'gas' ? 0.04 : 0.012, 12), h - 0.09, h, det.fuel === 'gas' ? 'chrome' : 'copper');   // flue or wiring
    for (const u of [-r * 0.5, r * 0.5]) P(disc(u, 0, 0.012, 10), h - 0.09, h, 'copper');                         // cold in, hot out
    P(rect(r * 0.7, r, -0.02, 0.02), h * 0.85, h * 0.85 + 0.04, 'chrome');                                       // relief valve
    if (det.fuel === 'gas') P(rect(-0.08, 0.08, -r, -r + 0.06), 0.15, 0.3, 'panel');                              // gas control
  },
  toilet({ W, D, h, det, P }) {
    const tank = Math.min(0.22, 2 * D * 0.32), bowlLen = 2 * D - tank + (det.bowl === 'elongated' ? 0 : -0.05), rim = Math.min(det.tank, h - 0.2);
    P(rect(-W, W, D - tank, D), rim, h - 0.02, 'bath');
    P(rect(-W, W, D - tank - 0.005, D), h - 0.02, h, 'bath');                           // lid
    const cv = D - tank - bowlLen / 2 + 0.03;
    P(ellipse(0, cv, W * 0.48, bowlLen * 0.32), 0, 0.22, 'bath');                       // pedestal
    P(ellipse(0, cv, W * 0.85, bowlLen / 2 - 0.02), 0.22, Math.min(rim, 0.39), 'bath'); // bowl
    P(ellipse(0, cv, W * 0.88, bowlLen / 2 - 0.01), Math.min(rim, 0.39), Math.min(rim, 0.39) + 0.02, 'white');   // seat
    P(rect(-W + 0.02, -W + 0.08, D - tank - 0.02, D - tank), h - 0.07, h - 0.05, 'chrome');                       // flush lever
    P(disc(-W + 0.05, D - 0.04, 0.012, 10), 0.15, rim, 'chrome');                       // supply line
    P(rect(-W + 0.03, -W + 0.07, D - 0.05, D), 0.13, 0.17, 'chrome');                    // shutoff valve
  },
  vanity({ W, D, h, det, P }) {
    const t = det.counter, k = det.kick, face = -D + 0.025, top = h - t;
    P(rect(-W + 0.01, W - 0.01, face + 0.06, D), 0, k, 'kick');
    P(rect(-W, W, face + 0.02, D), k, top, 'body');
    const n = det.doors, dw = (2 * W) / n;
    for (let i = 0; i < n; i++) {
      const u0 = -W + i * dw + 0.003, u1 = -W + (i + 1) * dw - 0.003;
      P(rect(u0, u1, face, face + 0.02), k + 0.005, top - 0.005, 'body');
      const ku = n === 1 ? u1 - 0.05 : i % 2 ? u0 + 0.04 : u1 - 0.04;
      P(rect(ku - 0.006, ku + 0.006, -D + 0.004, face), top - 0.12, top - 0.04, 'chrome');
    }
    if (det.sink === 'undermount') {
      const bu = Math.min(W - 0.08, 0.24), bv0 = -D + 0.07, bv1 = Math.min(D - 0.1, bv0 + 0.36), depth = Math.min(0.15, top - k - 0.05);
      P(rect(-W, W, -D, bv0), top, h, 'top'); P(rect(-W, W, bv1, D), top, h, 'top');
      P(rect(-W, -bu, bv0, bv1), top, h, 'top'); P(rect(bu, W, bv0, bv1), top, h, 'top');
      P(rect(-bu, bu, bv0, bv1), top - depth, top - depth + 0.01, 'bath');             // basin floor
      for (const [u0, u1, v0, v1] of [[-bu, bu, bv0, bv0 + 0.01], [-bu, bu, bv1 - 0.01, bv1], [-bu, -bu + 0.01, bv0, bv1], [bu - 0.01, bu, bv0, bv1]]) P(rect(u0, u1, v0, v1), top - depth, h, 'bath');
      P(disc(0, (bv0 + bv1) / 2, 0.02, 10), top - depth + 0.01, top - depth + 0.012, 'chrome');
    } else P(rect(-W, W, -D, D), top, h, 'top');
  },
  tub({ W, D, h, det, P }) {
    const wall = 0.07;
    P(rect(-W, W, -D, D), 0, 0.06, 'bath');
    for (const [u0, u1, v0, v1] of [[-W, W, -D, -D + wall], [-W, W, D - wall, D], [-W, -W + wall, -D, D], [W - wall, W, -D, D]]) P(rect(u0, u1, v0, v1), 0.06, h, 'bath');
    P(rect(-W + wall, W - wall, -D + wall, D - wall), 0.06, 0.08, 'bath');
    P(disc(-W + 0.15, 0, 0.022, 10), 0.08, 0.082, 'chrome');                            // drain
  },
  faucet({ W, D, h, det, P }) {
    const back = D - Math.min(0.05, D), r = Math.min(0.026, W);
    P(disc(0, back, r, 14), 0, 0.03, 'chrome');
    if (det.style === 'two-handle') for (const u of [-W + 0.03, W - 0.03]) P(disc(u, back, 0.018, 10), 0, 0.07, 'chrome');
    P(disc(0, back, r * 0.6, 12), 0.03, h - 0.03, 'chrome');                             // body
    P(rect(-0.012, 0.012, -D + 0.02, back), h - 0.045, h - 0.02, 'chrome');               // spout
    P(disc(0, -D + 0.03, 0.014, 10), h - (det.style === 'pull-down' ? 0.12 : 0.08), h - 0.045, 'chrome');
    if (det.style !== 'two-handle') P(rect(0.012, W, back - 0.008, back + 0.008), h - 0.03, h - 0.01, 'chrome');   // lever
  },
  'shower-trim'({ W, D, h, det, P, S }) {
    const valve = Math.min(h * 0.35, 0.4);
    S(frontDisc(0, valve, Math.min(0.09, W), D - 0.012, D), 'chrome');                   // escutcheon on the wall
    P(rect(-0.012, Math.min(0.09, W), D - 0.07, D - 0.012), valve - 0.01, valve + 0.012, 'chrome');   // lever
    if (det.head) { P(rect(-0.01, 0.01, -D + 0.08, D), h - 0.05, h - 0.03, 'chrome'); P(disc(0, -D + 0.07, Math.min(0.065, W, D), 18), h - 0.08, h - 0.05, 'chrome'); }
    if (det.spout) P(rect(-0.025, 0.025, D - Math.min(0.18, 2 * D), D), 0, 0.045, 'chrome');
  },
  panel({ W, D, h, det, P }) {
    const face = -D + 0.012;
    P(rect(-W, W, face + 0.01, D), 0, h, 'fitting');                                    // enclosure
    if (det.door === 'closed') {
      P(rect(-W + 0.008, W - 0.008, face, face + 0.01), 0.008, h - 0.008, 'fitting');
      P(rect(W - 0.05, W - 0.02, -D, face), h / 2 - 0.03, h / 2 + 0.03, 'black');       // latch
      return;
    }
    P(rect(-W + 0.03, W - 0.03, face + 0.004, face + 0.01), 0.06, h - 0.06, 'white');    // dead front
    const rows = Math.max(4, Math.ceil(Math.max(det.circuits.length, 12) / 2)), rowH = (h - 0.2) / rows;
    for (let i = 0; i < rows * 2; i++) {
      const col = i % 2, row = Math.floor(i / 2), u0 = col ? 0.006 : -0.06, y = h - 0.1 - (row + 1) * rowH;
      P(rect(u0, u0 + 0.054, face - 0.008, face + 0.004), y + rowH * 0.15, y + rowH * 0.85, 'black');   // breaker
      P(rect(u0 + 0.02, u0 + 0.034, -D, face - 0.008), y + rowH * 0.4, y + rowH * 0.6, 'black');       // handle
    }
    P(rect(-W + 0.004, -W + 0.012, -D, face + 0.01), 0.03, h - 0.03, 'fitting');         // door, open beside it
  },
  thermostat({ W, D, h, P }) {
    P(rect(-W, W, -D + 0.008, D), 0, h, 'white');
    P(rect(-W * 0.6, W * 0.6, -D, -D + 0.008), h * 0.45, h * 0.85, 'black');
  },
  light({ W, D, h, det, P }) {
    const r = Math.min(W, D);
    P(disc(0, 0, Math.min(0.065, r), 16), h - 0.02, h, 'chrome');
    if (det.style === 'pendant') {
      P(disc(0, 0, 0.004, 8), h * 0.45, h - 0.02, 'black');
      for (let k = 0; k < 4; k++) P(disc(0, 0, r * (0.3 + 0.7 * (k + 1) / 4), 24), h * 0.45 * (1 - (k + 1) / 4), h * 0.45 * (1 - k / 4), 'white');
    } else P(disc(0, 0, r, 28), 0, h - 0.02, 'white');
  },
  'outdoor-unit'({ W, D, h, P, S }) {
    P(rect(-W, W, -D + 0.01, D), 0.04, h, 'white');
    for (const u of [-W + 0.05, W - 0.1]) P(rect(u, u + 0.05, -D + 0.02, D - 0.02), 0, 0.04, 'black');   // feet
    S(frontDisc(-W * 0.2, h * 0.52, Math.min(W * 0.6, h * 0.4), -D, -D + 0.01, 24), 'black');           // fan grille
    P(rect(W * 0.62, W, D - 0.08, D), h * 0.3, h * 0.45, 'copper');                                   // service valves
  },
  shutoff({ W, D, h, det, P, S }) {
    S(frontDisc(0, 0.05, Math.min(0.035, W), D - 0.008, D), 'chrome');                  // escutcheon
    P(rect(-0.012, 0.012, D - 0.06, D - 0.008), 0.035, 0.065, 'chrome');                 // stub out
    P(rect(-0.02, 0.02, D - 0.09, D - 0.06), 0.03, 0.07, 'chrome');                      // valve body
    P(rect(-0.03, 0.03, D - 0.085, D - 0.065), 0.07, 0.085, 'chrome');                   // handle
    P(disc(0, D - 0.075, 0.006, 8), 0.085, h, det.supply === 'braided' ? 'chrome' : 'copper');   // supply up to the fixture
  },
  'line-set'({ W, D, h, det, P }) {
    const r = [0.011, 0.007, 0.004, 0.004];
    for (let k = 0; k < det.pipes; k++) P(disc(-W + 0.03 + k * Math.min(0.035, (2 * W - 0.04) / det.pipes), D - 0.025, r[k], 10), 0, h, k ? 'copper' : 'black');   // insulated suction, liquid, drain, power
  },
  vent({ W, D, h, det, P }) {
    if (det.shape === 'round') P(disc(0, 0, Math.min(W, D), 20), 0, h, 'chrome');
    else P(rect(-W, W, -D, D), 0, h, 'chrome');
  },
  drain({ W, D, h, det, P }) {
    const r = Math.min(0.02, W);
    P(disc(0, -D + 0.03, r, 12), h * 0.45, h, 'chrome');                                 // tailpiece
    if (det.trap) { P(rect(-r, r, -D + 0.01, -D + 0.05), h * 0.3, h * 0.45, 'chrome'); P(rect(-r, r, -D + 0.01, D), h * 0.3, h * 0.3 + 2 * r, 'chrome'); }
    P(disc(0, D - 0.03, r * 1.2, 12), h * 0.2, h * 0.5, 'chrome');                       // into the wall
  },
};
