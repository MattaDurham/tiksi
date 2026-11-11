// Procedural material textures, the part that only computes: noise, the pattern samplers and
// the driver that fills a texture set's pixels. No three.js and no page (DOM) here, so the same
// file runs in the page and as the background helper: textures.js starts this file as a worker
// (see the end) and turns the pixels it sends back into textures and materials.

// ---------- deterministic noise ----------
// Tiny mulberry32 PRNG (used for setup tables) and an integer hash for lattice noise.
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
let SEED = 1013904223;
function ihash(x, y) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + SEED) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function hash3(x, y, z) { return ihash(x + Math.imul(z | 0, 7919), y - Math.imul(z | 0, 104729)); }

// Periodic value noise: lattice coordinates wrap at (px, py) so the texture tiles seamlessly.
function vnoise(x, y, px, py) {
  let xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
  const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
  xi = ((xi % px) + px) % px; yi = ((yi % py) + py) % py;
  const x1 = (xi + 1) % px, y1 = (yi + 1) % py;
  const a = ihash(xi, yi), b = ihash(x1, yi), c = ihash(xi, y1), d = ihash(x1, y1);
  const ab = a + (b - a) * u, cd = c + (d - c) * u;
  return ab + (cd - ab) * v;
}
function fbm(x, y, px, py, oct, gain) {
  gain = gain || 0.5;
  let s = 0, a = 0.5, norm = 0;
  for (let i = 0; i < oct; i++) {
    s += a * vnoise(x, y, px, py);
    norm += a; a *= gain; x *= 2; y *= 2; px *= 2; py *= 2;
  }
  return s / norm;
}
// Periodic Worley noise on a jittered grid. Returns F1, F2 and the winning cell id.
const W = { f1: 0, f2: 0, id: 0, dx: 0, dy: 0 };
function worley(x, y, px, py, jitter) {
  const xi = Math.floor(x), yi = Math.floor(y);
  let f1 = 9, f2 = 9, id = 0, bdx = 0, bdy = 0;
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
    const cx = xi + i, cy = yi + j;
    const wx = ((cx % px) + px) % px, wy = ((cy % py) + py) % py;
    const ox = 0.5 + (ihash(wx, wy) - 0.5) * jitter, oy = 0.5 + (ihash(wx + 131, wy + 71) - 0.5) * jitter;
    const dx = cx + ox - x, dy = cy + oy - y;
    const d = dx * dx + dy * dy;
    if (d < f1) { f2 = f1; f1 = d; id = wx * 7331 + wy * 131 + 1; bdx = dx; bdy = dy; }
    else if (d < f2) f2 = d;
  }
  W.f1 = Math.sqrt(f1); W.f2 = Math.sqrt(f2); W.id = id; W.dx = bdx; W.dy = bdy;
  return W;
}

// Tile-aware noise: kx/ky are features per meter; the lattice period is rounded to the tile so the
// result wraps exactly at the tile edge whatever size the record uses.
function nz(ctx, u, v, kx, ky, ox, oy) {
  const Px = Math.max(1, Math.round(ctx.tile[0] * kx)), Py = Math.max(1, Math.round(ctx.tile[1] * ky));
  return vnoise(u * Px + (ox || 0), v * Py + (oy || 0), Px, Py);
}
function fb(ctx, u, v, kx, ky, oct, ox, oy) {
  const Px = Math.max(1, Math.round(ctx.tile[0] * kx)), Py = Math.max(1, Math.round(ctx.tile[1] * ky));
  return fbm(u * Px + (ox || 0), v * Py + (oy || 0), Px, Py, oct);
}
function wl(ctx, u, v, kx, ky, jitter, ox, oy) {
  const Px = Math.max(1, Math.round(ctx.tile[0] * kx)), Py = Math.max(1, Math.round(ctx.tile[1] * ky));
  return worley(u * Px + (ox || 0), v * Py + (oy || 0), Px, Py, jitter);
}

// ---------- small math ----------
export const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const mix = (a, b, t) => a + (b - a) * t;
function smoothstep(a, b, x) { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
const fract = v => v - Math.floor(v);
function hexToRgb(hex) {
  const n = parseInt(String(hex || '#888888').replace('#', ''), 16);
  if (isNaN(n)) return [0.5, 0.5, 0.5];
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
// Cheap "value + warmth" shift: dv scales brightness, dh > 0 pushes warm, < 0 pushes cool.
function shade(out, rgb, dv, dh) {
  const k = 1 + dv;
  out.r = rgb[0] * k * (1 + dh * 0.16);
  out.g = rgb[1] * k;
  out.b = rgb[2] * k * (1 - dh * 0.16);
}
function towards(out, rgb, t) { out.r = mix(out.r, rgb[0], t); out.g = mix(out.g, rgb[1], t); out.b = mix(out.b, rgb[2], t); }
function scaleRgb(out, k) { out.r *= k; out.g *= k; out.b *= k; }
function lighten(rgb, k) { return [clamp(rgb[0] * k, 0, 1), clamp(rgb[1] * k, 0, 1), clamp(rgb[2] * k, 0, 1)]; }
function desat(rgb, t) { const l = 0.3 * rgb[0] + 0.59 * rgb[1] + 0.11 * rgb[2]; return [mix(rgb[0], l, t), mix(rgb[1], l, t), mix(rgb[2], l, t)]; }

// Style hints derived from the material name / id. The schema keeps one `pattern` value per family;
// the name decides the sub-style (a subway tile and a hex mosaic are both `tile`).
export function hints(mat) {
  const s = ((mat.name || '') + ' ' + (mat.id || '')).toLowerCase();
  const has = (...ws) => ws.some(w => s.includes(w));
  return {
    subway: has('subway'), hex: has('hex', 'mosaic', 'penny'), penny: has('penny'),
    terrazzo: has('terrazzo'), slate: has('slate', 'bluestone'), quartz: has('quartz', 'solid surface'),
    ashlar: has('ashlar', 'limestone', 'sandstone', 'cut stone'), whitewash: has('whitewash', 'lime wash', 'limewash', 'painted brick'),
    reclaimed: has('reclaim', 'barn', 'weathered', 'rustic'), lvp: has('vinyl', 'lvp', 'laminate'),
    wide: has('wide'), polished: has('polish', 'burnish'), broom: has('broom', 'slab'),
    loop: has('loop', 'berber', 'commercial'), wool: has('wool', 'plush', 'shag'),
    fiber: has('fiber', 'fibre', 'hardie', 'cement'), cedar: has('cedar', 'wood', 'shingle'), shiplap: has('shiplap', 'tongue', 'v-groove', 'nickel'),
    clapboard: has('clapboard', 'painted'),
    panel: has('panel', 'wainscot', 'slat'),
    seam: has('seam', 'roof', 'corrugat'), blackened: has('black', 'oxid', 'patina', 'bronze', 'iron'), brushed: has('stainless', 'brushed', 'aluminum', 'aluminium'),
    gloss: has('gloss'), zellige: has('zellige', 'handmade', 'hand-made'),
  };
}

// ---------- pattern samplers ----------
// Each sampler fills out = { h (0..1 relief), r,g,b (sRGB 0..1), rough (0..1), ao (0..1) } for the
// point (u, v) of the tile. ctx carries the record, precomputed layout and the tile size in meters.
const OUT = { h: 0.5, r: 0, g: 0, b: 0, rough: 0.5, ao: 1 };

function masonrySetup(ctx, unitW, unitH, joint, bond) {
  const [tw, th] = ctx.tile;
  ctx.cols = Math.max(1, Math.round(tw / unitW));
  ctx.rows = Math.max(1, Math.round(th / unitH));
  ctx.cellW = tw / ctx.cols; ctx.cellH = th / ctx.rows;
  ctx.joint = joint; ctx.bond = bond;
}
// Shared brick / block / ashlar / tile layout: returns edge distance (m, negative inside a joint),
// the cell id and in-cell coordinates on ctx.
function masonryCell(ctx, u, v) {
  const rv = v * ctx.rows;
  const row = Math.floor(rv);
  const vv = rv - row;
  const off = (ctx.bond && (row & 1)) ? 0.5 : 0;
  const ru = u * ctx.cols + off;
  const col = Math.floor(ru);
  const uu = ru - col;
  const du = Math.min(uu, 1 - uu) * ctx.cellW, dv = Math.min(vv, 1 - vv) * ctx.cellH;
  ctx.edge = Math.min(du, dv) - ctx.joint / 2;
  ctx.cellId = hash3(((col % ctx.cols) + ctx.cols) % ctx.cols, ((row % ctx.rows) + ctx.rows) % ctx.rows, 3);
  ctx.uu = uu; ctx.vv = vv;
  ctx.mx = (uu - 0.5) * ctx.cellW; ctx.my = (vv - 0.5) * ctx.cellH;   // meters from the cell center
}

export const PATTERNS = {
  flat: { maps: false },

  drywall: {
    relief: 0.0006,
    sample(ctx, u, v, out) {
      const n1 = nz(ctx, u, v, 220, 220);
      const n2 = nz(ctx, u, v, 110, 110, 3.1);
      const n3 = fb(ctx, u, v, 3, 3, 3);
      const spat = smoothstep(0.55, 0.9, n1 * 0.6 + n2 * 0.4);    // orange-peel: sparse raised droplets
      out.h = 0.45 + 0.45 * spat + 0.1 * (n3 - 0.5);
      shade(out, ctx.base, 0.012 * (n3 - 0.5) + 0.01 * (spat - 0.3), 0);
      out.rough = ctx.R + 0.06 * (n2 - 0.5) - 0.04 * spat;
      out.ao = 1;
    },
  },

  plaster: {
    relief: 0.004,
    sample(ctx, u, v, out) {
      const warp = fb(ctx, u, v, 2.5, 2.5, 2, 9.2);
      // Trowel sweeps: anisotropic noise along a slowly rotating direction.
      const sweep = nz(ctx, u, v, 15, 5, warp * 2.5, warp);
      const body = fb(ctx, u, v, 5, 5, 4);
      const fine = nz(ctx, u, v, 200, 200);
      out.h = 0.5 + 0.4 * (body - 0.5) + 0.25 * (sweep - 0.5) + 0.06 * (fine - 0.5);
      shade(out, ctx.base, 0.08 * (body - 0.5) + 0.04 * (sweep - 0.5), 0.3 * (warp - 0.5));
      out.rough = ctx.R + 0.12 * (sweep - 0.5) + 0.05 * (fine - 0.5);
      out.ao = 0.94 + 0.06 * body;
    },
  },

  brick: {
    relief: 0.012,
    setup(ctx) {
      masonrySetup(ctx, 0.21, 0.075, 0.011, true);
      ctx.wash = ctx.hints.whitewash;
    },
    sample(ctx, u, v, out) {
      masonryCell(ctx, u, v);
      const e = ctx.edge, id = ctx.cellId;
      const face = smoothstep(0, 0.0035, e);
      const cushion = smoothstep(0, 0.014, e);
      const speck = nz(ctx, u, v, 120, 120);
      const pits = wl(ctx, u, v, 84, 84, 0.9).f1;
      const pit = smoothstep(0.22, 0.05, pits) * smoothstep(0.55, 0.9, hash3(ctx.cellId * 9973 | 0, 1, 5));
      // Per-brick colour: kiln variation, a few flashed (darker, cooler) bricks, fine speckle.
      const dv = (id - 0.5) * 0.28, flashed = hash3(id * 65535 | 0, 7, 2) > 0.82 ? 1 : 0;
      shade(out, ctx.base, dv - flashed * 0.22 + 0.10 * (speck - 0.5) - pit * 0.25, (hash3(id * 4099 | 0, 3, 9) - 0.5) * 0.6 - flashed * 0.5);
      const mortar = ctx.accent;
      const sand = nz(ctx, u, v, 240, 240);
      if (face < 1) {
        const mr = mortar[0] * (0.9 + 0.2 * sand), mg = mortar[1] * (0.9 + 0.2 * sand), mb = mortar[2] * (0.9 + 0.2 * sand);
        out.r = mix(mr, out.r, face); out.g = mix(mg, out.g, face); out.b = mix(mb, out.b, face);
      }
      if (ctx.wash) {      // lime wash: thin white coat that sits in the texture, thinner on brick edges
        const coat = 0.55 + 0.35 * smoothstep(0.3, 0.7, speck) + 0.15 * face;
        towards(out, ctx.base, clamp(coat, 0, 1));
      }
      out.h = mix(0.28 + 0.08 * sand, (0.9 + 0.1 * cushion) - 0.12 * pit - 0.03 * speck, face);
      out.rough = mix(0.96, ctx.R + 0.08 * (speck - 0.5) + 0.1 * pit, face);
      out.ao = 0.62 + 0.38 * face;
    },
  },

  cmu: {
    relief: 0.01,
    setup(ctx) { masonrySetup(ctx, 0.4, 0.2, 0.01, true); },
    sample(ctx, u, v, out) {
      masonryCell(ctx, u, v);
      const e = ctx.edge, id = ctx.cellId;
      const face = smoothstep(0, 0.003, e);
      const agg = wl(ctx, u, v, 160, 160, 1).f1;
      const grain = smoothstep(0.35, 0.12, agg);                 // exposed aggregate pores
      const body = fb(ctx, u, v, 6, 6, 3);
      shade(out, ctx.base, (id - 0.5) * 0.08 + 0.08 * (body - 0.5) - grain * 0.18, 0);
      const sand = nz(ctx, u, v, 80, 80);
      if (face < 1) { const k = 0.9 + 0.2 * sand; out.r = mix(ctx.accent[0] * k, out.r, face); out.g = mix(ctx.accent[1] * k, out.g, face); out.b = mix(ctx.accent[2] * k, out.b, face); }
      out.h = mix(0.35 + 0.06 * sand, 0.92 - 0.25 * grain + 0.04 * (body - 0.5), face);
      out.rough = mix(0.96, ctx.R + 0.1 * grain, face);
      out.ao = 0.7 + 0.3 * face - 0.1 * grain;
    },
  },

  stone: {
    relief: 0.022,
    setup(ctx) {
      ctx.ashlar = ctx.hints.ashlar;
      if (ctx.ashlar) { masonrySetup(ctx, 0.6, 0.3, 0.008, true); ctx.relief = 0.008; }
      else { ctx.N = Math.max(2, Math.round(ctx.tile[0] / 0.3)); ctx.M = Math.max(2, Math.round(ctx.tile[1] / 0.24)); }
    },
    sample(ctx, u, v, out) {
      const cleft = fb(ctx, u, v, 60, 60, 3);
      const fine = nz(ctx, u, v, 240, 240);
      const sand = nz(ctx, u, v, 120, 120, 5);
      if (ctx.ashlar) {
        masonryCell(ctx, u, v);
        const face = smoothstep(0, 0.004, ctx.edge), id = ctx.cellId;
        // Tooled limestone: shallow chisel bands along the block.
        const tool = 0.5 + 0.5 * Math.sin((ctx.my * 400) + cleft * 6);
        shade(out, ctx.base, (id - 0.5) * 0.12 + 0.06 * (cleft - 0.5) + 0.03 * (fine - 0.5) - 0.02 * tool, (hash3(id * 1000 | 0, 2, 4) - 0.5) * 0.4);
        if (face < 1) { const k = 0.9 + 0.2 * sand; out.r = mix(ctx.accent[0] * k, out.r, face); out.g = mix(ctx.accent[1] * k, out.g, face); out.b = mix(ctx.accent[2] * k, out.b, face); }
        out.h = mix(0.3, 0.9 + 0.05 * (cleft - 0.5) + 0.03 * tool, face);
        out.rough = mix(0.95, ctx.R + 0.05 * (fine - 0.5), face);
        out.ao = 0.7 + 0.3 * face;
        return;
      }
      // Fieldstone: warped Voronoi cells, rounded by the F2-F1 bisector distance.
      const wx = (fb(ctx, u, v, 2.5, 2.5, 2, 1.7) - 0.5) * 0.5, wy = (fb(ctx, u, v, 2.5, 2.5, 2, 0, 4.2) - 0.5) * 0.5;
      const w = worley(u * ctx.N + wx, v * ctx.M + wy, ctx.N, ctx.M, 0.85);
      const cellM = ctx.tile[0] / ctx.N;
      const edge = (w.f2 - w.f1) * cellM * 0.5;                // approx meters to the joint centre line
      const joint = 0.014;
      const face = smoothstep(joint, joint + 0.008, edge);
      const dome = smoothstep(joint, joint + 0.09, edge);
      const id = hash3(w.id, 11, 1);
      // Rock surface: layered fbm with soft crevices, per-stone tone and a restrained warm/cool drift.
      const rock = fb(ctx, u, v, 30, 30, 4, id * 5);
      const crevice = smoothstep(0.42, 0.26, rock) * 0.45;
      shade(out, ctx.base, (id - 0.5) * 0.3 + 0.2 * (cleft - 0.5) + 0.14 * (rock - 0.5) + 0.04 * (fine - 0.5) - 0.22 * crevice, (hash3(w.id, 5, 6) - 0.5) * 0.45);
      const moss = hash3(w.id, 8, 8) > 0.82 ? 0.25 : 0;         // a few darker, greener stones
      if (moss) towards(out, [out.r * 0.7, out.g * 0.8, out.b * 0.6], moss);
      if (face < 1) { const k = 0.85 + 0.3 * sand; out.r = mix(ctx.accent[0] * k, out.r, face); out.g = mix(ctx.accent[1] * k, out.g, face); out.b = mix(ctx.accent[2] * k, out.b, face); }
      out.h = mix(0.15 + 0.06 * sand, 0.45 + 0.4 * dome + 0.12 * (cleft - 0.5) + 0.08 * (rock - 0.5) - 0.1 * crevice, face);
      out.rough = mix(0.97, ctx.R + 0.1 * (cleft - 0.5) + 0.05 * crevice, face);
      out.ao = 0.5 + 0.5 * face * (0.7 + 0.3 * dome) - 0.15 * crevice * face;
    },
  },

  wood: {
    relief: 0.003,
    setup(ctx) {
      const [tw, th] = ctx.tile;
      const target = ctx.hints.lvp ? 0.18 : ctx.hints.wide ? 0.2 : 0.13;
      ctx.rows = Math.max(1, Math.round(th / target));
      ctx.plankW = th / ctx.rows;
      ctx.segs = Math.max(1, Math.round(tw / (ctx.hints.lvp ? 1.2 : 0.95)));
      ctx.segL = tw / ctx.segs;
      const rnd = mulberry32(77);
      ctx.off = new Float32Array(ctx.rows);
      for (let r = 0; r < ctx.rows; r++) ctx.off[r] = rnd();
      ctx.rec = ctx.hints.reclaimed; ctx.lvp = ctx.hints.lvp;
      ctx.grey = desat(lighten(ctx.base, 0.75), 0.7);
      if (ctx.lvp) ctx.relief = 0.0012;
    },
    sample(ctx, u, v, out) {
      const rv = v * ctx.rows, row = Math.floor(rv), vv = rv - row;
      const wr = ((row % ctx.rows) + ctx.rows) % ctx.rows;
      const su = u * ctx.segs - ctx.off[wr], seg = Math.floor(su), uu = su - seg;
      const id = hash3(wr, ((seg % ctx.segs) + ctx.segs) % ctx.segs, 17);
      const x = u * ctx.tile[0], y = v * ctx.tile[1];
      const du = Math.min(uu, 1 - uu) * ctx.segL, dv = Math.min(vv, 1 - vv) * ctx.plankW;
      const ed = Math.min(du, dv);
      const bevel = smoothstep(0, Math.max(ctx.lvp ? 0.0012 : 0.0025, 1.6 * ctx.pxm), ed);
      const gap = smoothstep(0, Math.max(0.0007, 0.9 * ctx.pxm), ed);
      // Grain at two scales. Broad earlywood/latewood bands (what you see from 2 m) bend along the
      // plank into cathedral arcs; fine rings (2-4 mm) ride on top and only show up close.
      const ph = id * 37.1;
      const yl = (vv - 0.5) * ctx.plankW;                                   // local y, centred in the plank
      const warp = fb(ctx, u, v, 0.8, 2.2, 3, ph, ph * 0.3);
      const wob = fb(ctx, u, v, 4, 9, 2, ph * 2);
      // Drift of the arcs along the board: an integer number of cycles per tile keeps it seamless.
      const drift = Math.round(ctx.tile[0] * (0.6 + 0.8 * (id - 0.5))) / ctx.tile[0];
      const amp = ctx.lvp ? 5 : 3 + 9 * hash3(id * 5000 | 0, 8, 3);         // rift-sawn (straight) to flat-sawn (arched)
      const arc = yl * (ctx.lvp ? 22 : 26) + amp * (warp - 0.5) + 1.2 * (wob - 0.5) + x * drift + ph;
      let band = 0.5 + 0.5 * Math.sin(arc * 6.2832);
      band = Math.pow(band, 1.6);
      const ringT = arc * 7.5 + 0.8 * (wob - 0.5);
      let ring = 0.5 + 0.5 * Math.sin(ringT * 6.2832);
      ring = ring * ring * ring;
      const pores = nz(ctx, u, v, 420, 26, ph);
      const figure = fb(ctx, u, v, 0.5, 1.5, 2, ph * 2);                    // slow tone drift along the board
      const dvv = (id - 0.5) * (ctx.rec ? 0.5 : ctx.lvp ? 0.12 : 0.26);
      shade(out, ctx.base,
        dvv + 0.12 * (figure - 0.5) - (ctx.lvp ? 0.12 : 0.17) * band - 0.08 * ring - 0.05 * (pores - 0.5),
        (hash3(id * 7000 | 0, 4, 1) - 0.5) * (ctx.rec ? 0.8 : 0.5) + 0.25 * band);
      if (ctx.accent) towards(out, ctx.accent, smoothstep(0.55, 0.95, hash3(id * 3000 | 0, 9, 2)) * 0.55);
      if (ctx.rec) {
        // Weathering: silvered surface with checks (cracks) along the grain.
        const weather = smoothstep(0.35, 0.8, fb(ctx, u, v, 0.9, 3, 3, ph));
        towards(out, ctx.grey, weather * 0.75);
        const crack = smoothstep(0.86, 0.94, nz(ctx, u, v, 3, 160, ph));
        scaleRgb(out, 1 - crack * 0.45);
        out.h = 0.55 + 0.35 * bevel - 0.25 * crack + 0.05 * band + 0.03 * ring - 0.04 * weather;
        out.rough = ctx.R + 0.1 * weather + 0.1 * crack;
      } else {
        out.h = 0.62 + 0.3 * bevel + 0.04 * band + 0.03 * ring - 0.03 * (pores - 0.5);
        out.rough = ctx.R - 0.08 * band - 0.04 * ring + 0.06 * (pores - 0.5) + 0.03 * (figure - 0.5);
      }
      scaleRgb(out, 0.45 + 0.55 * gap);
      out.ao = 0.82 + 0.18 * bevel;
    },
  },

  tile: {
    relief: 0.0018,
    setup(ctx) {
      const [tw, th] = ctx.tile;
      ctx.terrazzo = ctx.hints.terrazzo; ctx.hex = ctx.hints.hex; ctx.slate = ctx.hints.slate;
      if (ctx.terrazzo) { ctx.relief = 0.0003; return; }
      if (ctx.hex) {
        ctx.nx = Math.max(2, Math.round(tw / 0.05));
        ctx.hexW = tw / ctx.nx;
        ctx.ny = Math.max(1, Math.round(th / (0.866 * ctx.hexW * 2)));
        ctx.pitch = th / (2 * ctx.ny);
        ctx.grout = Math.max(0.0022, 1.5 * ctx.pxm); ctx.relief = 0.0012;
        return;
      }
      // Grid: 2 x 2 units per repeat; rectangular units run in a staggered bond, square ones stack.
      const cellW = tw / 2, cellH = th / 2;
      const bond = Math.abs(cellW / cellH - 1) > 0.15;
      masonrySetup(ctx, cellW, cellH, Math.max(ctx.slate ? 0.006 : 0.003, 1.5 * ctx.pxm), bond);
      ctx.cushion = ctx.hints.subway || cellW < 0.12;
      ctx.zellige = ctx.hints.zellige;
      if (ctx.slate) ctx.relief = 0.005;
      if (ctx.zellige) ctx.relief = 0.004;
    },
    sample(ctx, u, v, out) {
      const cloud = fb(ctx, u, v, 15, 15, 3);
      const fine = nz(ctx, u, v, 180, 180);
      if (ctx.terrazzo) {
        shade(out, ctx.base, 0.03 * (cloud - 0.5), 0);
        // Chips: two Worley layers, coloured from the accent family.
        let chip = 0, cid = 0, layer = 0;
        for (let L = 0; L < 2; L++) {
          const s = L ? 44 : 18;
          const w = wl(ctx, u, v, s, s, 1, L * 3.3);
          const r = (0.2 + 0.22 * hash3(w.id, L, 3)) * smoothstep(0.25, 0.4, hash3(w.id, L, 5));   // some cells carry no chip
          const m = smoothstep(r + 0.03, r - 0.02, w.f1 + 0.06 * (fine - 0.5));
          if (m > chip) { chip = m; cid = w.id; layer = L; }
        }
        if (chip > 0) {
          const k = hash3(cid, layer, 9);
          const c = k < 0.22 ? ctx.accent : k < 0.5 ? lighten(ctx.accent, 0.55) : k < 0.8 ? [0.96, 0.95, 0.92] : lighten(ctx.base, 0.72);
          towards(out, c, chip * 0.95);
        }
        out.h = 0.5 + 0.02 * (fine - 0.5) - chip * 0.03;
        out.rough = ctx.R + 0.04 * (fine - 0.5) - chip * 0.03;
        out.ao = 1;
        return;
      }
      if (ctx.hex) {
        // Pointy-top hexes on two interleaved lattices; nearest centre wins.
        const x = u * ctx.tile[0], y = v * ctx.tile[1];
        const r0 = Math.floor(y / ctx.pitch);
        let best = 9, bid = 0;
        for (let r = r0 - 1; r <= r0 + 1; r++) {
          const off = (r & 1) ? 0.5 : 0;
          const c0 = Math.floor(x / ctx.hexW - off);
          for (let c = c0; c <= c0 + 1; c++) {
            const cx = (c + off) * ctx.hexW, cy = r * ctx.pitch;
            const dx = x - cx, dy = (y - cy) * (0.866 * ctx.hexW / ctx.pitch);
            const d = ctx.hints.penny ? Math.hypot(dx, dy) : Math.max(Math.abs(dx), Math.abs(dx * 0.5 + dy * 0.866), Math.abs(dx * 0.5 - dy * 0.866));
            if (d < best) { best = d; bid = hash3(((c % ctx.nx) + ctx.nx) % ctx.nx, ((r % (2 * ctx.ny)) + 2 * ctx.ny) % (2 * ctx.ny), 21); }
          }
        }
        const a = ctx.hexW / 2;
        const edge = a - best - ctx.grout / 2;
        const face = smoothstep(0, 0.0012, edge);
        const dome = ctx.hints.penny ? smoothstep(0, 0.012, edge) : smoothstep(0, 0.004, edge);
        shade(out, ctx.base, (bid - 0.5) * 0.08 + 0.02 * (fine - 0.5), (bid - 0.5) * 0.1);
        if (face < 1) { const k = 0.9 + 0.2 * fine; out.r = mix(ctx.accent[0] * k, out.r, face); out.g = mix(ctx.accent[1] * k, out.g, face); out.b = mix(ctx.accent[2] * k, out.b, face); }
        out.h = mix(0.35, 0.75 + 0.25 * dome, face);
        out.rough = mix(0.92, ctx.R + 0.03 * (fine - 0.5), face);
        out.ao = 0.7 + 0.3 * face;
        return;
      }
      masonryCell(ctx, u, v);
      const e = ctx.edge, id = ctx.cellId;
      const face = smoothstep(0, 0.0012, e);
      const cushion = ctx.cushion ? smoothstep(0, 0.008, e) : smoothstep(0, 0.0025, e);
      if (ctx.slate) {
        const cleft = fb(ctx, u, v, 36, 36, 4, id * 9);
        const layers = 0.5 + 0.5 * Math.sin(cleft * 22 + fine * 3);
        shade(out, ctx.base, (id - 0.5) * 0.3 + 0.18 * (cleft - 0.5) - 0.06 * layers, (hash3(id * 5000 | 0, 2, 2) - 0.5) * 0.7);
        if (face < 1) { const k = 0.9 + 0.2 * fine; out.r = mix(ctx.accent[0] * k, out.r, face); out.g = mix(ctx.accent[1] * k, out.g, face); out.b = mix(ctx.accent[2] * k, out.b, face); }
        out.h = mix(0.3, 0.6 + 0.3 * (cleft - 0.5) + 0.1 * layers + 0.1 * cushion, face);
        out.rough = mix(0.95, ctx.R + 0.1 * (cleft - 0.5), face);
        out.ao = 0.65 + 0.35 * face;
        return;
      }
      if (ctx.zellige) {
        // Hand-cut glazed clay: strong per-tile colour shifts, pooled glaze, wobbly faces.
        const pool = fb(ctx, u, v, 30, 30, 3, id * 13);
        shade(out, ctx.base, (id - 0.5) * 0.34 + 0.12 * (pool - 0.5), (hash3(id * 8000 | 0, 6, 6) - 0.5) * 0.9);
        if (face < 1) { const k = 0.9 + 0.2 * fine; out.r = mix(ctx.accent[0] * k, out.r, face); out.g = mix(ctx.accent[1] * k, out.g, face); out.b = mix(ctx.accent[2] * k, out.b, face); }
        out.h = mix(0.35, 0.65 + 0.25 * cushion + 0.15 * (pool - 0.5) + 0.03 * (cloud - 0.5), face);
        out.rough = mix(0.9, ctx.R + 0.06 * (pool - 0.5), face);
        out.ao = 0.7 + 0.3 * face;
        return;
      }
      // Porcelain / ceramic: near-uniform body with faint clouding, glossy face, sandy grout.
      shade(out, ctx.base, (id - 0.5) * 0.05 + 0.04 * (cloud - 0.5) + 0.012 * (fine - 0.5), (id - 0.5) * 0.08);
      if (face < 1) { const k = 0.88 + 0.24 * fine; out.r = mix(ctx.accent[0] * k, out.r, face); out.g = mix(ctx.accent[1] * k, out.g, face); out.b = mix(ctx.accent[2] * k, out.b, face); }
      out.h = mix(0.4 + 0.05 * fine, 0.82 + 0.18 * cushion, face);
      out.rough = mix(0.9, ctx.R + 0.03 * (fine - 0.5), face);
      out.ao = 0.72 + 0.28 * face;
    },
  },

  concrete: {
    relief: 0.0025,
    setup(ctx) {
      ctx.pol = ctx.hints.polished; ctx.broom = ctx.hints.broom && !ctx.pol;
      ctx.ties = Math.max(1, Math.round(ctx.tile[0] / 1.2)); ctx.tiesY = Math.max(1, Math.round(ctx.tile[1] / 1.2));
      ctx.tieOk = ctx.tile[0] >= 0.9 && ctx.tile[1] >= 0.9;
      if (ctx.pol) ctx.relief = 0.0006;
    },
    sample(ctx, u, v, out) {
      const body = fb(ctx, u, v, 3, 3, 5);
      const mottle = fb(ctx, u, v, 1.5, 1.5, 3, 2.2);
      const agg = wl(ctx, u, v, 120, 120, 1);
      const pit = ctx.pol ? 0 : smoothstep(0.16, 0.05, agg.f1) * smoothstep(0.6, 0.9, hash3(agg.id, 1, 1));
      const stone = ctx.pol ? smoothstep(0.3, 0.1, agg.f1) * smoothstep(0.5, 0.8, hash3(agg.id, 2, 2)) : 0;
      const fine = nz(ctx, u, v, 240, 240);
      let dv = 0.12 * (body - 0.5) + 0.08 * (mottle - 0.5) + 0.05 * (fine - 0.5) - pit * 0.3 + stone * 0.14;
      let h = 0.5 + 0.3 * (body - 0.5) + 0.1 * (fine - 0.5) - pit * 0.5;
      if (ctx.broom) {
        const streak = nz(ctx, u, v, 4, 700);
        dv += 0.05 * (streak - 0.5); h += 0.2 * (streak - 0.5);
      }
      // Faint form-tie marks on a ~1.2 m grid (only on fields big enough to carry them).
      const tx = Math.min(fract(u * ctx.ties), 1 - fract(u * ctx.ties)) * ctx.tile[0] / ctx.ties;
      const ty = Math.min(fract(v * ctx.tiesY), 1 - fract(v * ctx.tiesY)) * ctx.tile[1] / ctx.tiesY;
      const td = Math.hypot(tx, ty);
      const tie = (ctx.pol || !ctx.tieOk) ? 0 : smoothstep(0.016, 0.006, td);
      h -= tie * 0.3; dv -= tie * 0.1;
      shade(out, ctx.base, dv, 0.15 * (mottle - 0.5));
      out.h = h;
      out.rough = ctx.R + (ctx.pol ? 0.1 : 0.08) * (mottle - 0.5) + pit * 0.1 - stone * 0.1;
      out.ao = 1 - pit * 0.4 - tie * 0.5;
    },
  },

  carpet: {
    relief: 0.0022,
    setup(ctx) {
      ctx.loop = ctx.hints.loop || !ctx.hints.wool;
      ctx.pitchX = Math.max(1, Math.round(ctx.tile[0] / 0.0042)); ctx.pitchY = Math.max(1, Math.round(ctx.tile[1] / 0.0042));
    },
    sample(ctx, u, v, out) {
      const fibre = nz(ctx, u, v, 300, 300);
      const fibre2 = nz(ctx, u, v, 600, 600, 4);
      const tuft = fb(ctx, u, v, 24, 24, 3);
      let dot = 0;
      if (ctx.loop) {
        const gx = 0.5 + 0.5 * Math.sin(u * ctx.pitchX * 6.2832), gy = 0.5 + 0.5 * Math.sin(v * ctx.pitchY * 6.2832);
        dot = gx * gy;
      }
      shade(out, ctx.base, 0.16 * (fibre - 0.5) + 0.1 * (fibre2 - 0.5) + 0.1 * (tuft - 0.5) + 0.08 * (dot - 0.35), 0.05 * (tuft - 0.5));
      if (ctx.accent) towards(out, ctx.accent, smoothstep(0.6, 0.9, fibre2) * 0.3);   // flecked yarn
      out.h = 0.5 + 0.3 * (fibre - 0.5) + 0.15 * (tuft - 0.5) + 0.25 * (dot - 0.5);
      out.rough = ctx.R;
      out.ao = 0.9 + 0.1 * tuft;
    },
  },

  siding: {
    relief: 0.012,
    setup(ctx) {
      const [tw, th] = ctx.tile;
      ctx.ship = ctx.hints.shiplap;
      ctx.nb = Math.max(1, Math.round(th / (ctx.ship ? 0.14 : 0.15)));
      ctx.exp = th / ctx.nb;
      ctx.segs = Math.max(1, Math.round(tw / 2.4));
      const rnd = mulberry32(31);
      ctx.off = new Float32Array(ctx.nb);
      for (let r = 0; r < ctx.nb; r++) ctx.off[r] = rnd();
      ctx.grainy = ctx.hints.cedar && !ctx.hints.fiber && !ctx.hints.clapboard;
      if (ctx.ship) ctx.relief = 0.006;
    },
    sample(ctx, u, v, out) {
      const rv = v * ctx.nb, row = Math.floor(rv), vv = rv - row;
      const wr = ((row % ctx.nb) + ctx.nb) % ctx.nb;
      const su = u * ctx.segs - ctx.off[wr], seg = Math.floor(su), uu = su - seg;
      const id = hash3(wr, ((seg % ctx.segs) + ctx.segs) % ctx.segs, 29);
      const butt = smoothstep(0, 0.0012, Math.min(uu, 1 - uu) * ctx.tile[0] / ctx.segs);
      const grain = ctx.grainy
        ? 0.5 + 0.5 * Math.sin(((vv - 0.5) * ctx.exp * 90 + id * 40) * 6.28 + 3 * fb(ctx, u, v, 1.5, 6, 3, id * 8))
        : nz(ctx, u, v, 60, 300, id * 5);
      const g = ctx.grainy ? grain * grain * (0.5 + 0.5 * nz(ctx, u, v, 3, 40, id)) : grain;
      const fine = nz(ctx, u, v, 500, 80);
      shade(out, ctx.base, (id - 0.5) * (ctx.grainy ? 0.18 : 0.04) - g * (ctx.grainy ? 0.09 : 0.03) - 0.02 * (fine - 0.5), (hash3(id * 2000 | 0, 3, 3) - 0.5) * (ctx.grainy ? 0.5 : 0.1));
      if (ctx.accent && ctx.grainy) towards(out, ctx.accent, smoothstep(0.6, 0.95, hash3(id * 900 | 0, 4, 4)) * 0.5);
      if (ctx.ship) {
        // Flat boards with a square reveal between them.
        const dvm = Math.min(vv, 1 - vv) * ctx.exp;
        const reveal = smoothstep(0.002, 0.004, dvm);
        out.h = mix(0.3, 0.95 + 0.03 * (g - 0.5), reveal);
        scaleRgb(out, 0.55 + 0.45 * reveal);
        out.rough = mix(0.9, ctx.R + 0.06 * (g - 0.5), reveal);
        out.ao = 0.7 + 0.3 * reveal;
      } else {
        // Lap: thick butt at the bottom of each board tapering upward; the board above casts a
        // soft shadow line onto the top of this one.
        const lip = smoothstep(0, 0.004 / ctx.exp, vv);
        const shadow = smoothstep(0.86, 1.0, vv);
        out.h = (0.5 + 0.5 * (1 - vv)) * lip + 0.1 * (g - 0.5) * 0.3;
        scaleRgb(out, (1 - 0.42 * shadow) * (0.7 + 0.3 * lip));
        out.rough = ctx.R + (ctx.grainy ? 0.08 : 0.03) * (g - 0.5) + 0.06 * shadow;
        out.ao = 1 - 0.45 * shadow;
      }
      scaleRgb(out, 0.6 + 0.4 * butt);
      out.h -= (1 - butt) * 0.2;
    },
  },

  board: {
    relief: 0.02,
    setup(ctx) {
      const [tw, th] = ctx.tile;
      ctx.panel = ctx.hints.panel;
      ctx.nb = Math.max(1, Math.round(tw / (ctx.panel ? 0.1 : 0.3)));
      ctx.bw = tw / ctx.nb;
      ctx.batten = ctx.panel ? 0 : 0.06;
      if (ctx.panel) ctx.relief = 0.006;
    },
    sample(ctx, u, v, out) {
      const ru = u * ctx.nb, col = Math.floor(ru), uu = ru - col;
      const id = hash3(((col % ctx.nb) + ctx.nb) % ctx.nb, 0, 41);
      const dum = Math.min(uu, 1 - uu) * ctx.bw;                        // meters to the nearest joint
      const grain = nz(ctx, u, v, 320, 30, id * 7);
      const figure = fb(ctx, u, v, 2, 0.8, 3, id * 5);
      shade(out, ctx.base, (id - 0.5) * 0.07 - 0.05 * (grain - 0.5) + 0.05 * (figure - 0.5), (id - 0.5) * 0.15);
      if (ctx.panel) {
        const joint = smoothstep(0.0015, 0.004, dum);
        out.h = mix(0.3, 0.9 + 0.05 * (grain - 0.5), joint);
        scaleRgb(out, 0.5 + 0.5 * joint);
        out.rough = ctx.R + 0.04 * (grain - 0.5);
        out.ao = 0.75 + 0.25 * joint;
        return;
      }
      const onBatten = smoothstep(ctx.batten / 2 + 0.001, ctx.batten / 2 - 0.001, dum);
      const nearBatten = smoothstep(ctx.batten / 2 + 0.03, ctx.batten / 2, dum);
      const bid = hash3(((col % ctx.nb) + ctx.nb) % ctx.nb, 1, 43);
      if (onBatten > 0) { const k = 1 + (bid - 0.5) * 0.06; out.r = mix(out.r, ctx.base[0] * k, onBatten); out.g = mix(out.g, ctx.base[1] * k, onBatten); out.b = mix(out.b, ctx.base[2] * k, onBatten); }
      out.h = mix(0.55 + 0.04 * (grain - 0.5), 1, onBatten);
      scaleRgb(out, 1 - 0.3 * nearBatten * (1 - onBatten));
      out.rough = ctx.R + 0.05 * (grain - 0.5);
      out.ao = 1 - 0.4 * nearBatten * (1 - onBatten);
    },
  },

  marble: {
    relief: 0.0003,
    setup(ctx) {
      ctx.quartz = ctx.hints.quartz;
    },
    sample(ctx, u, v, out) {
      const cloud = fb(ctx, u, v, 2, 2, 4);
      const fine = nz(ctx, u, v, 400, 400);
      if (ctx.quartz) {
        const w = wl(ctx, u, v, 140, 140, 1);
        const fleck = smoothstep(0.2, 0.08, w.f1) * smoothstep(0.45, 0.7, hash3(w.id, 3, 1));
        const dark = hash3(w.id, 5, 2) < 0.4;
        shade(out, ctx.base, 0.03 * (cloud - 0.5) + 0.01 * (fine - 0.5), 0);
        if (fleck > 0) towards(out, dark ? ctx.accent : [0.98, 0.98, 0.97], fleck * 0.8);
        out.h = 0.5 + 0.01 * (fine - 0.5);
        out.rough = ctx.R + 0.02 * (fine - 0.5);
        out.ao = 1;
        return;
      }
      // Veins: a diagonal ridge field bent by domain-warped fbm. Wide soft veins carry the tone, a
      // narrow dark core sits inside them, and grey clouds fill the field between.
      const wx = fb(ctx, u, v, 2, 2, 3, 3.1), wy = fb(ctx, u, v, 2, 2, 3, 0, 7.7);
      const q = fb(ctx, u, v, 2.2, 1.4, 4, 2.5 * (wx - 0.5), 2.5 * (wy - 0.5));
      // Integer cycle counts on u and v keep the diagonal ridge field seamless across the tile.
      const field = q * 1.1 + (2 * u + 1 * v) + 1.2 * (wx - 0.5);
      const s = Math.abs(Math.sin(field * 6.2832));
      const feather = smoothstep(0.25, 0.75, wy);                       // veins fade in and out along their length
      const vein = Math.pow(1 - s, 5) * (0.35 + 0.65 * feather);
      const core = Math.pow(1 - s, 26) * feather;
      const s2 = Math.abs(Math.sin((wy * 4 + 3 * u - 1 * v + 2 * (q - 0.5)) * 6.2832));
      const vein2 = Math.pow(1 - s2, 12) * 0.7;
      const cloudy = smoothstep(0.35, 0.7, fb(ctx, u, v, 1.2, 1.2, 3, 5.5 + 1.5 * (wx - 0.5)));
      shade(out, ctx.base, 0.04 * (cloud - 0.5) + 0.012 * (fine - 0.5), 0);
      towards(out, ctx.accent, clamp(cloudy * 0.35 + vein * 0.55 + vein2, 0, 1));
      towards(out, lighten(ctx.accent, 0.7), core * 0.7);
      out.h = 0.5 + 0.03 * (cloud - 0.5) - vein * 0.03;
      out.rough = ctx.R + 0.02 * (fine - 0.5) + vein * 0.04;
      out.ao = 1;
    },
  },

  metal: {
    relief: 0.0002,
    setup(ctx) {
      const [tw, th] = ctx.tile;
      ctx.seam = ctx.hints.seam; ctx.black = ctx.hints.blackened;
      if (ctx.seam) { ctx.nr = Math.max(1, Math.round(tw / 0.4)); ctx.rw = tw / ctx.nr; ctx.relief = 0.02; }
    },
    sample(ctx, u, v, out) {
      const streak = nz(ctx, u, v, 6, 900);
      const streak2 = nz(ctx, u, v, 18, 1800, 1);
      const patina = fb(ctx, u, v, 4, 4, 4);
      if (ctx.seam) {
        const ru = u * ctx.nr, uu = ru - Math.floor(ru);
        const dum = Math.min(uu, 1 - uu) * ctx.rw;
        const rib = smoothstep(0.014, 0.011, dum);
        const foot = smoothstep(0.03, 0.014, dum);
        const pan = fb(ctx, u, v, 2, 2, 2);   // oil canning
        shade(out, ctx.base, 0.05 * (pan - 0.5) + 0.02 * (streak2 - 0.5) - 0.12 * foot * (1 - rib), 0);
        out.h = mix(0.35 + 0.1 * (pan - 0.5), 1, rib);
        out.rough = ctx.R + 0.06 * (streak - 0.5) + 0.05 * foot;
        out.ao = 1 - 0.3 * foot * (1 - rib);
        return;
      }
      if (ctx.black) {
        const blotch = smoothstep(0.4, 0.8, patina);
        shade(out, ctx.base, 0.16 * (patina - 0.5) + 0.05 * (streak - 0.5), 0);
        if (ctx.accent) towards(out, ctx.accent, blotch * 0.22);
        out.h = 0.5 + 0.1 * (patina - 0.5);
        out.rough = ctx.R + 0.25 * (patina - 0.5) + 0.05 * (streak2 - 0.5);
        out.ao = 1;
        return;
      }
      shade(out, ctx.base, 0.05 * (streak - 0.5) + 0.02 * (streak2 - 0.5) + 0.01 * (patina - 0.5), 0);
      out.h = 0.5 + 0.5 * (streak - 0.5);
      out.rough = ctx.R + 0.18 * (streak - 0.5) + 0.06 * (streak2 - 0.5);
      out.ao = 1;
    },
  },

  glass: { maps: false },
  photo: { maps: false },  // maps come from the photo pipeline instead of a sampler
};

// ---------- synthesis driver ----------
function makeCtx(mat, res) {
  const tile = tileOf(mat);
  const base = hexToRgb(mat.color);
  const accent = mat.accent ? hexToRgb(mat.accent) : defaultAccent(mat.pattern, base);
  const p = PATTERNS[mat.pattern] || PATTERNS.flat;
  return {
    mat, res, tile, base, accent, hints: hints(mat),
    R: clamp(num(mat.roughness, 0.8), 0.02, 1), M: clamp(num(mat.metalness, 0), 0, 1),
    relief: p.relief || 0.001,
    pxm: tile[0] / res,   // meters per texel: thin features are widened to stay visible at any resolution
  };
}
export function num(v, d) { return (v == null || isNaN(v)) ? d : +v; }
export function tileOf(mat) {
  const t = Array.isArray(mat.tile) ? mat.tile : [1, 1];
  return [clamp(num(t[0], 1), 0.02, 50), clamp(num(t[1], 1), 0.02, 50)];
}
// Accent fallback when a record has none: mortar/grout as a greyed, lighter version of the base.
function defaultAccent(pattern, base) {
  switch (pattern) {
    case 'brick': case 'cmu': case 'stone': return desat(lighten(base, 1.25), 0.6);
    case 'tile': return desat(lighten(base, 0.86), 0.5);
    case 'marble': return desat(lighten(base, 0.62), 0.2);
    case 'carpet': case 'wood': case 'siding': case 'metal': return null;
    default: return desat(lighten(base, 0.8), 0.5);
  }
}

// Synthesise one texture set: the colour map, the normal map and the occlusion / roughness map
// of `mat` (a plain snapshot of a material record) at `res` pixels square. A generator, so the
// page can run it in slices between frames; the background helper (the end of this file) runs it
// straight through. `cancelled()` is asked every row and ends the work early (returns null).
// The pixels depend on the record and the size alone, wherever this runs.
export function* synthesize(mat, res, cancelled) {
  const P = PATTERNS[mat.pattern] || PATTERNS.flat;
  // One seed per pattern family; restored after every yield because other jobs share the hash.
  const seed = 1013904223 ^ (Math.imul(strHash(mat.pattern || 'flat'), 2654435761) | 0);
  SEED = seed;
  const ctx = makeCtx(mat, res);
  if (P.setup) P.setup(ctx);
  const N = res, n = N * N;
  const col = new Uint8Array(n * 4), orm = new Uint8Array(n * 4), hgt = new Float32Array(n);
  const out = OUT;
  for (let y = 0; y < N; y++) {
    if (cancelled && cancelled()) return null;
    const v = (y + 0.5) / N;
    const rowBase = y * N;
    for (let x = 0; x < N; x++) {
      out.ao = 1; out.h = 0.5;
      P.sample(ctx, (x + 0.5) / N, v, out);
      const i = (rowBase + x) * 4;
      col[i] = clamp(out.r * 255 + 0.5, 0, 255); col[i + 1] = clamp(out.g * 255 + 0.5, 0, 255); col[i + 2] = clamp(out.b * 255 + 0.5, 0, 255); col[i + 3] = 255;
      orm[i] = clamp(out.ao * 255 + 0.5, 0, 255); orm[i + 1] = clamp(out.rough * 255 + 0.5, 8, 255); orm[i + 2] = 255; orm[i + 3] = 255;
      hgt[rowBase + x] = out.h;
    }
    if ((y & 15) === 15) { yield; SEED = seed; }
  }
  const nrm = new Uint8Array(n * 4);
  yield* normalsJob(hgt, N, ctx.relief / (ctx.tile[0] / N), ctx.relief / (ctx.tile[1] / N), nrm);
  if (cancelled && cancelled()) return null;
  return { N, col, nrm, orm };
}

// Sobel over the (wrapping) height field -> tangent-space normal map. sx/sy convert the 0..1 relief
// into a slope per pixel so the result is physically scaled by the record's tile size.
export function* normalsJob(hgt, N, sx, sy, nrm) {
  for (let y = 0; y < N; y++) {
    const ym = ((y - 1) + N) % N * N, y0 = y * N, yp = (y + 1) % N * N;
    for (let x = 0; x < N; x++) {
      const xm = (x - 1 + N) % N, xp = (x + 1) % N;
      const gx = (hgt[ym + xp] + 2 * hgt[y0 + xp] + hgt[yp + xp] - hgt[ym + xm] - 2 * hgt[y0 + xm] - hgt[yp + xm]) / 8;
      const gy = (hgt[yp + xm] + 2 * hgt[yp + x] + hgt[yp + xp] - hgt[ym + xm] - 2 * hgt[y0 + x] - hgt[ym + xp]) / 8;
      let nx = -gx * sx, ny = -gy * sy, nz = 1;
      const l = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      nx *= l; ny *= l; nz *= l;
      const i = (y0 + x) * 4;
      nrm[i] = nx * 127.5 + 127.5; nrm[i + 1] = ny * 127.5 + 127.5; nrm[i + 2] = nz * 127.5 + 127.5; nrm[i + 3] = 255;
    }
    if ((y & 31) === 31) yield;
  }
}

function strHash(s) { let h = 7; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; }

// ---------- as the background helper ----------
// One set per message, run straight through, its three pixel maps handed back without a copy.
if (typeof globalThis.WorkerGlobalScope === 'function' && globalThis instanceof globalThis.WorkerGlobalScope) {
  globalThis.onmessage = e => {
    const { mat, res } = e.data;
    const began = performance.now();
    try {
      const run = synthesize(mat, res);
      let step = run.next();
      while (!step.done) step = run.next();
      const { N, col, nrm, orm } = step.value;
      globalThis.postMessage({ ok: true, ms: performance.now() - began, N, col, nrm, orm }, [col.buffer, nrm.buffer, orm.buffer]);
    } catch (err) {
      globalThis.postMessage({ ok: false, ms: performance.now() - began, error: String(err && err.message || err) });
    }
  };
}
