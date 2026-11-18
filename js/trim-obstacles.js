// What wall trim must keep off, found in the property's models: outlets, switch and cover
// plates, thermostats and other controls (small devices), and radiators, convectors, heater
// covers, registers and grilles (which stop trim the way a window does).
//
// A piece counts when its name says what it is (the component's name, or the product it is
// linked to) and it sits on a wall face: it reaches the face, comes no more than STANDOFF in
// front of it, and is flatter against that face than against any other. Each one becomes an
// entry in that wall's trimClearances (trims.js reads them), marked auto: true with the model
// and piece it came from, so it is found again, and replaced, every time the model is read.
// Entries put there by hand (no auto) are never touched.
//
// Pure: plan coordinates in, records out. MODEL (viewer3d.js) reads the pieces' corners from
// the loaded models and calls these.

// Words that name a device whatever else the name says ("light switch plate" is a device).
const DEVICE = /\b(outlets?|receptacles?|gfci|switch(?:es)?|dimmers?|thermostats?|keypads?|intercoms?|doorbells?|(?:rocker|toggle|switch|cover|wall|control|utility|blank|device|data|cable|phone|jack|usb|outlet)[- ]plates?)\b/i;
// Words that usually do, unless the name says otherwise.
const MAYBE_DEVICE = /\b(plates?|controls?|sockets?|jacks?|usb)\b/i;
const NOT_DEVICE = /\b(dinner|hot|kick|push|base|top|sill|sole|name|licen[cs]e|tv)[- ]plates?\b|\bplates?[- ]racks?\b|\bremote[- ]controls?\b/i;
const HEATER = /\b(radiators?|convectors?|heaters?|heat(?:ing)?[- ]covers?|registers?|grilles?|vents?|diffusers?|baseboard[- ]heat(?:er|ing)?)\b/i;
const NOT_HEATER = /\b(range|cooker|hood|dryer|bath(?:room)?[- ]fan)\b/i;

const STANDOFF = 0.4;        // m: a wall-mounted piece stands no further out than this
const NEAR = 0.06;           // m: and comes at least this close to the face
const WIDE = 0.36;           // m: a "device" wider than this stops trim like a window
const r4 = v => Math.round(v * 10000) / 10000;
const r5 = v => Math.round(v * 100000) / 100000;

// 'device', 'heater' or null for a piece's name.
export function obstacleKind(name) {
  const s = String(name || '');
  if (!s) return null;
  if (HEATER.test(s) && !NOT_HEATER.test(s)) return 'heater';
  if (DEVICE.test(s)) return 'device';
  if (MAYBE_DEVICE.test(s) && !NOT_DEVICE.test(s)) return 'device';
  return null;
}

// pieces: [{ key, name, kind, pts: [[x, y, z]] }] in plan metres (x, y on the plan, z the
// height above the datum). opts: { elevationOf(wall), heightOf(wall), levelOf(wall) }.
// Returns Map(wallId -> [entry]) where entry is a trimClearances record.
export function wallClearances(walls, pieces, opts = {}) {
  const elevationOf = opts.elevationOf || (() => 0), heightOf = opts.heightOf || (w => w.height || 2.44);
  const frames = walls.map(w => {
    const L = Math.hypot(w.bx - w.ax, w.by - w.ay);
    return L < .01 ? null : { w, L, ux: (w.bx - w.ax) / L, uy: (w.by - w.ay) / L, h: (w.thickness || 0.114) / 2, elev: elevationOf(w), H: heightOf(w) };
  }).filter(Boolean);
  const out = new Map();
  for (const piece of pieces) {
    if (!piece || !piece.kind || !Array.isArray(piece.pts) || !piece.pts.length) continue;
    let best = null;
    for (const f of frames) {
      let s0 = Infinity, s1 = -Infinity, n0 = Infinity, n1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const [x, y, z] of piece.pts) {
        const s = (x - f.w.ax) * f.ux + (y - f.w.ay) * f.uy, n = (x - f.w.ax) * -f.uy + (y - f.w.ay) * f.ux;
        s0 = Math.min(s0, s); s1 = Math.max(s1, s); n0 = Math.min(n0, n); n1 = Math.max(n1, n);
        z0 = Math.min(z0, z - f.elev); z1 = Math.max(z1, z - f.elev);
      }
      // Along the wall: at least half of it in front of the wall. Up the wall: on this level.
      const along = Math.min(s1, f.L) - Math.max(s0, 0);
      if (along <= 0 || along < (s1 - s0) / 2 || z1 <= 0 || z0 >= f.H) continue;
      for (const side of [1, -1]) {
        // Distance in front of this face: negative is inside the wall.
        const d0 = side > 0 ? n0 - f.h : -n1 - f.h, d1 = side > 0 ? n1 - f.h : -n0 - f.h;
        if (d1 < -0.005 || d0 > NEAR || d1 > STANDOFF) continue;
        const depth = d1 - Math.max(d0, -f.h);
        const score = depth + Math.abs(Math.max(d0, -f.h)) * .5;
        if (!best || score < best.score) best = { f, side, score, s0: Math.max(0, s0), s1: Math.min(f.L, s1), z0: Math.max(0, z0), z1: Math.min(f.H, z1) };
      }
    }
    if (!best) continue;
    const kind = piece.kind === 'device' && best.s1 - best.s0 <= WIDE && best.z1 - best.z0 <= WIDE ? 'device' : 'heater';
    const entry = { side: best.side, f0: r5(best.s0 / best.f.L), f1: r5(best.s1 / best.f.L), y0: r4(best.z0), y1: r4(best.z1), kind, auto: true, source: String(piece.key || ''), name: String(piece.name || '').slice(0, 120) };
    if (opts.scanId) entry.scanId = opts.scanId;
    if (!out.has(best.f.w.id)) out.set(best.f.w.id, []);
    out.get(best.f.w.id).push(entry);
  }
  return out;
}

const order = (a, b) => String(a.source).localeCompare(String(b.source)) || a.side - b.side || a.f0 - b.f0;

// Replace one model's automatic entries on every wall with `byWall`; entries by hand and other
// models' entries stay. True when anything changed.
export function applyAutoClearances(walls, scanId, byWall) {
  let changed = false;
  for (const w of walls) {
    const now = Array.isArray(w.trimClearances) ? w.trimClearances : [];
    const kept = now.filter(c => !(c && c.auto && c.scanId === scanId));
    const mine = (byWall.get(w.id) || []).map(c => ({ ...c, scanId })).sort(order);
    const next = [...kept, ...mine];
    if (JSON.stringify(next) === JSON.stringify(now)) continue;
    changed = true;
    if (next.length) w.trimClearances = next; else delete w.trimClearances;
  }
  return changed;
}

// Take out the automatic entries of models the property no longer has.
export function dropAutoClearances(walls, scanIds) {
  let changed = false;
  for (const w of walls) {
    if (!Array.isArray(w.trimClearances)) continue;
    const next = w.trimClearances.filter(c => !(c && c.auto && !scanIds.has(c.scanId)));
    if (next.length === w.trimClearances.length) continue;
    changed = true;
    if (next.length) w.trimClearances = next; else delete w.trimClearances;
  }
  return changed;
}
