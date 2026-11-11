// Light from the light fixtures placed in a model (viewer3d.js). An imported model names its
// parts ("Recessed downlight - 6 in LED trim (Halo RL6 class)", "Bath | two-globe sconce arm");
// the parts of one light fixture are found by name, joined into one fixture by where they sit,
// and given the light a fixture of that kind puts out, in lumens. A name that states its own
// output ("800 lm") or colour ("3000K", "warm") keeps it. A traced room with no fixture in it
// gets one estimated ceiling light sized to its floor area.
//
// The lumen figures are estimates of typical products, not measurements of the ones drawn:
//   6 in recessed LED downlight   850 lm   (4 in: 650 lm)
//   track head                    500 lm
//   pendant                       800 lm   (one 60 W-equivalent lamp)
//   chandelier                   2400 lm
//   flush or semi-flush ceiling  1100 lm   (13 in or larger: 1600 lm, two lamps)
//   ceiling fan light kit        1000 lm   (a fan named without a light gives none)
//   vanity or bath bar           1200 lm
//   wall sconce                   450 lm   per globe or arm ("two-globe": 900 lm)
//   table, floor or desk lamp     800 lm
//   LED strip or tape            300 lm   per metre of strip
//   a traced room with none       150 lm   per square metre of floor (about 14 lm per sq ft,
//                                          a common target for living spaces)

export const ROOM_LUMENS_PER_M2 = 150;
export const STRIP_LUMENS_PER_M = 300;
// The half-angle of a downlight's beam, in degrees (a 100-degree flood trim).
export const DOWNLIGHT_HALF_ANGLE = 50;

const words = n => String(n || '').replace(/[_|]+/g, ' ').replace(/\s+/g, ' ').trim();
const inches = n => { const m = /\b(\d{1,2}(?:\.\d)?)\s*(?:in\b|inch|")/i.exec(n); return m ? Number(m[1]) : null; };
const COUNT_WORDS = { one: 1, single: 1, two: 2, double: 2, twin: 2, three: 3, triple: 3, four: 4, five: 5, six: 6 };
function lampCount(n) {
  const m = /\b(one|single|two|double|twin|three|triple|four|five|six|\d)[- ](?:globe|light|lamp|bulb|arm|head|shade)s?\b/i.exec(n);
  if (!m) return 1;
  const k = m[1].toLowerCase();
  return COUNT_WORDS[k] || Math.max(1, Math.min(12, Number(k) || 1));
}

// Parts that carry the word "light" without being a light source.
const NOT_A_LIGHT = /\b(switch|dimmer|outlet|receptacle|sensor|skylight|lightweight|light[- ](?:grey|gray|oak|wood|tile|blue|green|beige|brown|stone|well)|lighting plan|tile)\b/i;

// Kinds of fixture, first match wins. `cone`: the light points down in a beam; otherwise it
// shines all round.
const KINDS = [
  { kind: 'downlight', label: 'Recessed downlight', re: /\b(recessed|downlights?|down[- ]lights?|can lights?|pot lights?|wafer lights?)\b/i, lumens: n => (inches(n) && inches(n) <= 4.5 ? 650 : 850), cone: true },
  { kind: 'track', label: 'Track light', re: /\btrack[- ](lights?|heads?|lighting)\b/i, lumens: () => 500, cone: true },
  { kind: 'chandelier', label: 'Chandelier', re: /\bchandeliers?\b/i, lumens: () => 2400 },
  { kind: 'fan', label: 'Ceiling fan light', re: /\bceiling[- ]fans?\b/i, lumens: n => (/\blight/i.test(n.replace(/ceiling[- ]fans?/ig, '')) ? 1000 : 0) },
  { kind: 'pendant', label: 'Pendant', re: /\bpendants?\b/i, lumens: n => 800 * lampCount(n) },
  { kind: 'vanity', label: 'Vanity light', re: /\b(vanity[- ](lights?|bars?|fixtures?)|bath[- ](bars?|lights?))\b/i, lumens: () => 1200 },
  { kind: 'flush', label: 'Ceiling light', re: /\b(flush[- ]?mounts?|semi[- ]flush|ceiling[- ](lights?|lamps?|fixtures?)|drum[- ](lights?|flush)|close[- ]to[- ]ceiling)\b/i, lumens: n => (inches(n) && inches(n) >= 13 ? 1600 : 1100) },
  { kind: 'sconce', label: 'Wall sconce', re: /\b(sconces?|wall[- ](lights?|lamps?))\b/i, lumens: n => 450 * lampCount(n) },
  { kind: 'strip', label: 'LED strip', re: /\b(led[- ]strips?|strip[- ]lights?|tape[- ]lights?|light[- ]strips?|under[- ]?cabinet[- ]lights?|cove[- ]lights?)\b/i, lumens: () => 0, strip: true },
  { kind: 'lamp', label: 'Lamp', re: /\b(table[- ]lamps?|floor[- ]lamps?|desk[- ]lamps?|lamps?)\b/i, lumens: () => 800 },
];
export const FIXTURE_LABELS = Object.freeze(Object.fromEntries([...KINDS.map(k => [k.kind, k.label]), ['room', 'Estimated ceiling light']]));

// What a part name says about the light it belongs to, or null when it names no light source.
//   { kind, label, lumens (null for a strip: it depends on its length), kelvin (null: the
//     panel's LAMP COLOR), cone, stated: whether the name gave the lumens itself }
export function classifyFixture(name) {
  const n = words(name);
  if (!n || NOT_A_LIGHT.test(n)) return null;
  const k = KINDS.find(x => x.re.test(n));
  if (!k) return null;
  const lm = /\b(\d{3,5})\s*(?:lm|lumens?)\b/i.exec(n);
  const kv = /\b(\d{4})\s*k\b/i.exec(n);
  let kelvin = kv ? Number(kv[1]) : null;
  if (kelvin !== null && (kelvin < 1800 || kelvin > 6500)) kelvin = null;
  if (kelvin === null && /\bwarm\b/i.test(n)) kelvin = 2700;
  if (kelvin === null && /\b(daylight|cool white)\b/i.test(n)) kelvin = 5000;
  const lumens = lm ? Number(lm[1]) : (k.strip ? null : k.lumens(n));
  if (lumens === 0) return null;
  return { kind: k.kind, label: k.label, lumens, kelvin, cone: !!k.cone, stated: !!lm };
}

// Join the light parts of a model into fixtures. `parts` are { name, min: [x,y,z], max: [x,y,z] }
// boxes in one space (metres, y up). Parts of one kind whose boxes come within `gap` metres of
// each other are one fixture (a sconce's arm, backplate and globes); the same name drawn in
// another place is another fixture. Returns one entry per fixture:
//   { kind, label, name, lumens, kelvin, cone, stated, min, max, at: [x,y,z] where the light sits }
export function groupFixtures(parts, gap = 0.12) {
  const items = [];
  for (const p of parts || []) {
    const c = classifyFixture(p.name);
    if (c && Array.isArray(p.min) && Array.isArray(p.max) && [...p.min, ...p.max].every(Number.isFinite)) items.push({ ...c, name: words(p.name), min: [...p.min], max: [...p.max] });
  }
  // Union-find over parts of the same kind whose boxes touch (within the gap).
  const parent = items.map((_, i) => i);
  const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const near = (a, b) => [0, 1, 2].every(d => a.min[d] - gap <= b.max[d] && b.min[d] - gap <= a.max[d]);
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    if (items[i].kind === items[j].kind && near(items[i], items[j])) parent[find(i)] = find(j);
  }
  const groups = new Map();
  items.forEach((it, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(it); });
  const out = [];
  for (const list of groups.values()) {
    const min = [0, 1, 2].map(d => Math.min(...list.map(p => p.min[d])));
    const max = [0, 1, 2].map(d => Math.max(...list.map(p => p.max[d])));
    // The part that says the most: one that states its lumens, else the brightest reading.
    const best = list.find(p => p.stated) || list.reduce((a, b) => ((b.lumens || 0) > (a.lumens || 0) ? b : a));
    const kelvin = (list.find(p => p.kelvin !== null) || {}).kelvin ?? null;
    let lumens = best.lumens;
    if (best.kind === 'strip' && !best.stated) lumens = Math.round(STRIP_LUMENS_PER_M * Math.max(0.1, ...[0, 2].map(d => max[d] - min[d])));
    const cx = (min[0] + max[0]) / 2, cz = (min[2] + max[2]) / 2;
    // A ceiling fixture lights from just under its body; a wall or table light from its middle.
    const below = ['downlight', 'track', 'flush', 'pendant', 'chandelier', 'fan', 'strip'].includes(best.kind);
    const at = [cx, below ? min[1] - 0.03 : (min[1] + max[1]) / 2, cz];
    out.push({ kind: best.kind, label: best.label, name: best.name, lumens, kelvin, cone: best.cone, stated: best.stated, min, max, at });
  }
  return out.sort((a, b) => a.at[0] - b.at[0] || a.at[2] - b.at[2] || a.at[1] - b.at[1]);
}

// A traced room's floor area in square metres, from its outline ([[x, y], ...], metres).
export function polygonArea(pts) {
  let s = 0;
  for (let i = 0, j = (pts || []).length - 1; i < (pts || []).length; j = i++) s += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
  return Math.abs(s) / 2;
}
// The estimated ceiling light of a traced room with no fixture drawn in it.
export function roomLumens(area) { return Math.round(Math.max(0, Number(area) || 0) * ROOM_LUMENS_PER_M2); }

// Luminous intensity, in candela, of a source of `lumens`: spread evenly all round, or over a
// downward cone of `halfAngleDeg`. The viewer multiplies this by its one scale for every
// fixture, so fixtures keep their true proportions to each other.
export function candela(lumens, halfAngleDeg = null) {
  const lm = Math.max(0, Number(lumens) || 0);
  if (halfAngleDeg === null) return lm / (4 * Math.PI);
  const a = Math.min(90, Math.max(1, halfAngleDeg)) * Math.PI / 180;
  return lm / (2 * Math.PI * (1 - Math.cos(a)));
}

// A short account of the light sources, for the panel: "24 Recessed downlight · 850 lm each".
export function fixtureSummary(sources) {
  const by = new Map();
  for (const s of sources || []) {
    const key = s.kind + '|' + s.lumens;
    const e = by.get(key) || { kind: s.kind, label: FIXTURE_LABELS[s.kind] || s.label || s.kind, lumens: s.lumens, count: 0 };
    e.count++; by.set(key, e);
  }
  return [...by.values()].sort((a, b) => b.count * b.lumens - a.count * a.lumens);
}
