// Scope items measured from the model. Right-click a room, a wall, an opening, a fixture or an
// imported model's object in the model beside ESTIMATE and ADD ... TO <room> makes a scope
// item that already knows what it is and how big it is: a room brings its wall area (net of
// doors and windows), floor and ceiling area, baseboard and perimeter length and its door and
// window counts. The item then picks the work (paint, refinish, replace ...) and the finish
// level from the price book (price-book.js); quantity, unit and the low / likely / high unit
// prices follow. A price typed by hand stands until the work or finish level changes again.
//
// Pure data: no three.js and no DOM. The viewer measures (it has the faces and the meshes) and
// hands the measurements here; ESTIMATE shows and edits the result in the room.

import { PRICE_BOOK } from './price-book.js';

export const SQFT = 0.09290304;   // m² in a square foot
export const FT = 0.3048;         // m in a foot
export const LEVELS = [['budget', 'Budget'], ['mid', 'Mid'], ['high', 'High end']];

// What each measurement is and which work it can price. `fits` names the kinds of thing a work
// applies to (price-book.js works[].applies).
export const MEASURES = {
  walls: { label: 'Walls, net of openings', unit: 'sf', fits: ['wall'] },
  floor: { label: 'Floor', unit: 'sf', fits: ['floor'] },
  ceiling: { label: 'Ceiling', unit: 'sf', fits: ['ceiling'] },
  baseboard: { label: 'Baseboard', unit: 'lf', fits: ['baseboard'] },
  perimeter: { label: 'Perimeter', unit: 'lf', fits: ['perimeter'] },
  doors: { label: 'Doors', unit: 'ea', fits: ['door'] },
  windows: { label: 'Windows', unit: 'ea', fits: ['window'] },
  lights: { label: 'Recessed lights, one per 25 sf (estimate)', unit: 'ea', fits: ['light'] },
  toilets: { label: 'Toilets', unit: 'ea', fits: ['toilet'] },
  vanities: { label: 'Vanities with sinks', unit: 'ea', fits: ['vanity', 'faucet'] },
  tubs: { label: 'Tubs', unit: 'ea', fits: ['tub', 'shower'] },
  dishwashers: { label: 'Dishwashers', unit: 'ea', fits: ['dishwasher'] },
  plumbing: { label: 'Plumbing', unit: 'ea', fits: ['plumbing'] },
  fixtures: { label: 'Count', unit: 'ea', fits: ['object'] },
  count: { label: 'Count', unit: 'ea', fits: ['object', 'cabinet', 'fixture', 'light', 'plumbing', 'door', 'window'] },
  front: { label: 'Face area', unit: 'sf', fits: ['counter', 'wall'] },
  top: { label: 'Counter top', unit: 'sf', fits: ['counter'] },
  length: { label: 'Length', unit: 'lf', fits: ['cabinet-run', 'perimeter', 'baseboard'] },
};

const round1 = v => Math.round(v * 10) / 10;
const money = v => Math.round(v * 100) / 100;

// ---------- measuring ----------
// Each returns { measures: { id: qty in sf / lf / ea }, label, elementIds }.

function polyPerimeter(pts) {
  let n = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
    n += Math.hypot(x2 - x1, y2 - y1);
  }
  return n;
}
function polyArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}
function openingCounts(faces) {
  const seen = new Map();
  for (const f of faces) for (const o of f.openings || []) seen.set(o.id, o.type);
  const types = [...seen.values()];
  return { doors: types.filter(t => t === 'door').length, windows: types.filter(t => t === 'window').length, ids: [...seen.keys()] };
}

function inPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
// Where a model fixture stands in plan: a box's centre, a run's middle.
function fixtureAt(f) {
  if (Number.isFinite(f.x) && Number.isFinite(f.y)) return [f.x, f.y];
  const pts = f.pts || [];
  if (!pts.length) return null;
  const a = pts[0], b = pts[pts.length - 1];
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}
// Plumbing a model fixture is: toilets, vanities, tubs and dishwashers, with the work that
// replaces each.
const PLUMBING = { toilet: 'replace-toilet', vanity: 'replace-bath-vanity-sink-faucet', tub: 'replace-bathtub', dishwasher: 'replace-dishwasher' };
const isPlumbing = f => !!PLUMBING[f.subtype] && (f.kind === 'bath' || f.kind === 'appliance');
// Recessed lights a ceiling would take on a 5'-0" grid: one per 25 sf, at least one.
const LIGHT_SF = 25;

// A room: its own faces (room-faces.js, kind 'room' with this roomId) give the walls; the
// model's fixtures standing in it give its plumbing count.
export function measureRoom(room, faces, fixtures = []) {
  const own = faces.filter(f => f.roomId === room.id);
  const pts = room.pts || [];
  const floor = polyArea(pts);
  const o = openingCounts(own);
  const inRoom = pts.length > 2 ? fixtures.filter(f => (!room.level || !f.level || f.level === room.level) && (p => p && inPoly(p[0], p[1], pts))(fixtureAt(f))) : [];
  const ceilingSf = floor / SQFT;
  return {
    label: room.name || 'Room',
    elementIds: [room.id],
    measures: {
      walls: own.reduce((n, f) => n + f.net, 0) / SQFT,
      floor: floor / SQFT,
      ceiling: floor / SQFT,
      baseboard: own.reduce((n, f) => n + f.baseboard, 0) / FT,
      perimeter: polyPerimeter(pts) / FT,
      doors: o.doors,
      windows: o.windows,
      lights: ceilingSf > 0 ? Math.max(1, Math.round(ceilingSf / LIGHT_SF)) : 0,
      toilets: inRoom.filter(f => isPlumbing(f) && f.subtype === 'toilet').length,
      vanities: inRoom.filter(f => isPlumbing(f) && f.subtype === 'vanity').length,
      tubs: inRoom.filter(f => isPlumbing(f) && f.subtype === 'tub').length,
      dishwashers: inRoom.filter(f => isPlumbing(f) && f.subtype === 'dishwasher').length,
    },
  };
}

// One wall face (a room's wall from inside corner to inside corner).
export function measureFace(face) {
  const o = openingCounts([face]);
  return {
    label: face.label,
    elementIds: [...new Set(face.parts.map(p => p.wallId))],
    faceIds: [face.id],
    measures: { walls: face.net / SQFT, baseboard: face.baseboard / FT, length: face.length / FT, doors: o.doors, windows: o.windows },
  };
}

// A door or window.
export function measureOpening(o, label) {
  return { label, elementIds: [o.id], measures: { [o.type === 'window' ? 'windows' : 'doors']: 1 } };
}

// A model fixture (fixtures.js): plumbing is counted as plumbing and offers its own
// replacement first; a cabinet run brings its length and, on base cabinets, its counter top.
export function measureFixture(f, label) {
  const out = { label, elementIds: [f.id], measures: { fixtures: 1 } };
  if (isPlumbing(f)) {
    out.measures = { plumbing: 1 };
    out.prefer = PLUMBING[f.subtype];
  } else if (f.kind === 'base-run' || f.kind === 'wall-run') {
    const pts = f.pts || [];
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    out.measures = { length: len / FT, ...(f.kind === 'base-run' && f.depth > 0 && { top: len * f.depth / SQFT }) };
    out.fits = { length: ['cabinet-run'] };
  }
  return out;
}

// Objects of an imported model, by their bounding boxes (metres): `sizes` is one [x, y, z]
// size per object. The face area is the two largest sides (a cabinet door's front, a counter's
// top) and the length the largest side: an estimate from the box, not the drawn surface.
export function measureObjects(scanId, objectKeys, sizes, label) {
  let front = 0, length = 0;
  for (const s of sizes) {
    const [a, b] = [...s].sort((x, y) => y - x);
    front += a * b; length += a;
  }
  const kinds = objectKinds(label);
  const prefer = objectWork(label);
  return { label, elementIds: [scanId], objectKeys: [...objectKeys], measures: { count: sizes.length, front: front / SQFT, length: length / FT },
    ...(kinds && { fits: { count: kinds } }), ...(prefer && { prefer }) };
}
// What an object's name says it is, for the works its count can price: a cabinet's door is
// not a room's door. null when the name says nothing (any each-priced work then fits).
const NAMED = [
  [/vanity/i, ['cabinet', 'plumbing', 'object']],
  [/toilet|\bwc\b|sink|faucet|\btap\b|bath\s*tub|\btub\b|shower|bidet|dishwasher/i, ['plumbing', 'object']],
  [/recessed|downlight|can\s*light|pot\s*light/i, ['light', 'fixture', 'object']],
  [/cabinet|drawer|upper|lower|base\b|front|pantry|shaker|panel/i, ['cabinet', 'object']],
  [/door/i, ['door', 'object']],
  [/window|sash/i, ['window', 'object']],
  [/light|lamp|pendant|sconce|chandelier|fixture|switch|outlet|receptacle|dimmer/i, ['fixture', 'light', 'object']],
  [/pull|knob|handle|hinge/i, ['cabinet', 'object']],
];
// The work a named plumbing or light object most likely needs.
const NAMED_WORK = [
  [/toilet|\bwc\b/i, 'replace-toilet'], [/vanity/i, 'replace-bath-vanity-sink-faucet'], [/kitchen\s*sink/i, 'replace-kitchen-sink'],
  [/kitchen\s*faucet/i, 'replace-kitchen-faucet'], [/faucet|\btap\b/i, 'replace-bath-faucet'], [/sink/i, 'replace-kitchen-sink'],
  [/shower/i, 'replace-shower-valve-trim'], [/tub/i, 'replace-bathtub'], [/dishwasher/i, 'replace-dishwasher'],
  [/recessed|downlight|can\s*light|pot\s*light/i, 'recessed-light-replace'], [/dimmer/i, 'dimmer-switch'],
];
export function objectWork(name) {
  for (const [re, id] of NAMED_WORK) if (re.test(name || '')) return id;
  return null;
}
export function objectKinds(name) {
  for (const [re, kinds] of NAMED) if (re.test(name || '')) return kinds;
  return null;
}

// Several measured things as one: the measures add up, the links join.
export function combineMeasured(list, label) {
  const out = { label: label || list.map(m => m.label).join(', '), elementIds: [], faceIds: [], objectKeys: [], measures: {} };
  for (const m of list) {
    for (const [k, v] of Object.entries(m.measures)) out.measures[k] = (out.measures[k] || 0) + v;
    out.elementIds.push(...(m.elementIds || []));
    out.faceIds.push(...(m.faceIds || []));
    out.objectKeys.push(...(m.objectKeys || []));
    for (const [k, v] of Object.entries(m.fits || {})) out.fits = { ...out.fits, [k]: [...new Set([...((out.fits || {})[k] || []), ...v])] };
  }
  for (const k of ['elementIds', 'faceIds', 'objectKeys']) out[k] = [...new Set(out[k])];
  const prefers = [...new Set(list.map(m => m.prefer).filter(Boolean))];
  if (prefers.length === 1) out.prefer = prefers[0];
  return out;
}

// ---------- the price book ----------
export function workById(id) { return PRICE_BOOK.works.find(w => w.id === id) || null; }
export function costAreas() { return PRICE_BOOK.areas; }
export function areaFactor(id) { const a = PRICE_BOOK.areas.find(x => x.id === id); return a ? a.factor : 1; }

// The measures an item has, with at least something to count, in MEASURES order.
export function measureIds(takeoff) {
  const m = (takeoff && takeoff.measures) || {};
  return Object.keys(MEASURES).filter(k => Number(m[k]) > 0);
}
// Works that one measure can price (its kinds and its unit both match). A takeoff can narrow a
// measure's kinds (objects named as cabinets count as cabinets).
export function worksForMeasure(measureId, takeoff) {
  const m = MEASURES[measureId];
  if (!m) return [];
  const fits = (takeoff && takeoff.fits && takeoff.fits[measureId]) || m.fits;
  return PRICE_BOOK.works.filter(w => w.unit === m.unit && w.applies.some(a => fits.includes(a)));
}
// Works an item can take: any its measures can price, or every work when it has no takeoff.
export function worksForItem(item) {
  if (!item.takeoff) return PRICE_BOOK.works;
  const ids = new Set(measureIds(item.takeoff).flatMap(m => worksForMeasure(m, item.takeoff).map(w => w.id)));
  return PRICE_BOOK.works.filter(w => ids.has(w.id));
}
// The measure a work should count: the item's current one when it fits, else the first that does.
export function measureForWork(item, work) {
  const ids = measureIds(item.takeoff);
  const fits = id => worksForMeasure(id, item.takeoff).includes(work);
  if (item.takeoff && fits(item.takeoff.measure)) return item.takeoff.measure;
  return ids.find(fits) || null;
}

// A first guess at the work, from the words of the project (its name, category and notes) and
// what was added: "Paint the bedroom" on a room picks Paint walls.
const HINTS = [
  [/wallpaper/i, ['wallpaper-install', 'remove-wallpaper']],
  [/skim|plaster/i, ['paint-walls-skim']],
  [/refinish|sand/i, ['refinish-hardwood', 'paint-cabinet-front']],
  [/cabinet\s*(front|door)|fronts/i, ['replace-cabinet-front']],
  [/paint/i, ['paint-walls', 'paint-ceiling', 'paint-trim', 'paint-door', 'paint-window', 'paint-cabinet-front']],
  [/cabinet/i, ['new-cabinets', 'replace-cabinet-front', 'paint-cabinet-front', 'cabinet-pull']],
  [/hardware|pulls?\b|knobs?/i, ['cabinet-pull', 'replace-door-hardware']],
  [/counter|quartz|marble|stone/i, ['counter-quartz', 'counter-stone']],
  [/backsplash/i, ['backsplash-tile']],
  [/tile/i, ['porcelain-floor-tile', 'wall-tile', 'backsplash-tile']],
  [/carpet/i, ['install-carpet']],
  [/hardwood|floor/i, ['refinish-hardwood', 'install-engineered-hardwood', 'install-solid-hardwood', 'install-lvp', 'porcelain-floor-tile', 'install-carpet']],
  [/crown/i, ['install-crown']],
  [/base\s*board|trim|molding|moulding/i, ['paint-trim', 'install-baseboard']],
  [/door/i, ['paint-door', 'replace-interior-door', 'replace-door-hardware']],
  [/window/i, ['paint-window', 'replace-window']],
  [/drywall|sheetrock|gypsum|wallboard/i, ['hang-drywall-walls', 'hang-drywall-ceiling', 'drywall-repair']],
  [/recessed|downlight|can\s*light|pot\s*light|lighting/i, ['recessed-light-new', 'recessed-light-replace', 'dimmer-switch']],
  [/toilet/i, ['replace-toilet']],
  [/vanity|bath(room)?\s*sink/i, ['replace-bath-vanity-sink-faucet', 'replace-bath-faucet']],
  [/kitchen\s*sink/i, ['replace-kitchen-sink', 'replace-kitchen-faucet']],
  [/faucet/i, ['replace-bath-faucet', 'replace-kitchen-faucet']],
  [/shower/i, ['replace-shower-valve-trim']],
  [/\btub\b|bathtub/i, ['replace-bathtub']],
  [/dishwasher/i, ['replace-dishwasher']],
  [/plumb/i, ['replace-toilet', 'replace-bath-vanity-sink-faucet', 'replace-bath-faucet', 'replace-kitchen-sink', 'replace-kitchen-faucet', 'replace-shower-valve-trim', 'replace-bathtub', 'replace-dishwasher']],
  [/light|fixture|electric|outlet|switch/i, ['replace-light-fixture', 'replace-device', 'recessed-light-new', 'dimmer-switch']],
  [/demo|remove|tear/i, ['remove-flooring', 'remove-wallpaper', 'demo-drywall', 'remove-object']],
];
export function guessWork(project, item) {
  const words = [project && project.name, project && project.category, project && project.notes].filter(Boolean).join(' ');
  const can = worksForItem(item);
  const first = item.takeoff ? measureIds(item.takeoff)[0] : null;
  for (const [re, ids] of HINTS) {
    if (!re.test(words)) continue;
    const hit = ids.map(workById).filter(w => w && can.includes(w));
    // Prefer one the item's first measure counts (a room's walls before its floor).
    const best = first && hit.find(w => worksForMeasure(first, item.takeoff).includes(w));
    if (best || hit[0]) return best || hit[0];
  }
  const prefer = item.takeoff && item.takeoff.prefer && workById(item.takeoff.prefer);
  if (prefer && can.includes(prefer)) return prefer;
  return (first && worksForMeasure(first, item.takeoff)[0]) || can[0] || null;
}

// The cost area a project prices in: its own choice, else a guess from the property's address.
export function costAreaFor(project, property) {
  if (project && project.costArea && PRICE_BOOK.areas.some(a => a.id === project.costArea)) return project.costArea;
  const where = property ? [property.address, property.location, property.city, property.name, property.notes].filter(v => typeof v === 'string').join(' ') : '';
  for (const a of PRICE_BOOK.areas) if (a.match && new RegExp(a.match, 'i').test(where)) return a.id;
  return 'national';
}

// ---------- applying ----------
// A new scope item for what was measured. `project` is used for the first guess at the work;
// `ids` brings uid, today and the project's cost area.
export function takeoffItem(measured, project, ids) {
  const measures = {};
  for (const [k, v] of Object.entries(measured.measures || {})) if (MEASURES[k] && v > 0) measures[k] = MEASURES[k].unit === 'ea' ? Math.round(v) : round1(v);
  const item = {
    id: ids.uid('it'), name: measured.label, qty: 1, unit: 'ls', low: 0, likely: 0, high: 0,
    durationDays: 0, deps: [], elementIds: [...new Set(measured.elementIds || [])], notes: '', status: 'todo', doneAt: '',
    takeoff: { label: measured.label, measures, measure: Object.keys(MEASURES).find(k => measures[k] > 0) || null, measuredAt: ids.today },
  };
  if (measured.faceIds && measured.faceIds.length) item.takeoff.faceIds = measured.faceIds;
  if (measured.objectKeys && measured.objectKeys.length) item.takeoff.objectKeys = measured.objectKeys;
  if (measured.fits) item.takeoff.fits = measured.fits;
  if (measured.prefer) item.takeoff.prefer = measured.prefer;
  const work = guessWork(project, item);
  if (work) setWork(item, { work: work.id, level: 'mid' }, ids.area || 'national');
  else useMeasure(item, item.takeoff.measure);
  return item;
}

// Count the item by another of its measures: quantity and unit follow. A work that cannot be
// priced per that unit is cleared (the prices stay as they were, to be checked).
export function useMeasure(item, measureId) {
  const t = item.takeoff;
  if (!t || !MEASURES[measureId] || !(t.measures[measureId] > 0)) return false;
  t.measure = measureId;
  item.qty = t.measures[measureId];
  item.unit = MEASURES[measureId].unit;
  const w = item.work && workById(item.work.id);
  if (w && !worksForMeasure(measureId, t).includes(w)) {
    const next = worksForMeasure(measureId, t)[0];
    if (next) return setWork(item, { work: next.id }, item.work.area);
    delete item.work;
  }
  return true;
}

// Choose the work and / or finish level: the unit and the book's prices follow (and, for a
// measured item, the quantity it counts). `area` is the project's cost area.
export function setWork(item, { work, level } = {}, area) {
  const w = workById(work || (item.work && item.work.id));
  if (!w) return false;
  const lv = level || (item.work && item.work.level) || 'mid';
  const L = w.levels[lv] || w.levels.mid;
  const prevName = item.work ? namedFor(item, workById(item.work.id)) : null;
  item.work = { id: w.id, level: lv, book: true, area: area || 'national' };
  if (item.takeoff) {
    const m = measureForWork(item, w);
    if (m) { item.takeoff.measure = m; item.qty = item.takeoff.measures[m]; }
  }
  item.unit = w.unit;
  // Permit fees follow each place's own fee schedule, not the building cost factor.
  const local = levelPrices(w, lv, item.work.area);
  item.low = money(local.low); item.likely = money(local.likely); item.high = money(local.high);
  // The name follows the work while nobody has renamed the item.
  const base = item.takeoff ? item.takeoff.label : null;
  if (base && (item.name === base || item.name === prevName)) item.name = namedFor(item, w);
  // A blank item takes the work's name ("New item" becomes "Plumbing permit").
  if (!item.takeoff && (!item.name || item.name === 'New item' || item.name === prevName)) item.name = w.label;
  return true;
}
function namedFor(item, w) { return w && item.takeoff ? w.label + ' · ' + item.takeoff.label : w ? w.label : item.name; }

// A work's low / likely / high in a cost area: the place's own prices where the book has them
// (permits), else the national level times the area's factor.
export function levelPrices(w, level, area) {
  const L = w.levels[level] || w.levels.mid;
  const own = w.areaLevels && w.areaLevels[area] && w.areaLevels[area][level];
  if (own) return { low: own.low, likely: own.likely, high: own.high, own: true };
  const f = areaFactor(area);
  return { low: L.low * f, likely: L.likely * f, high: L.high * f, own: false };
}

// The project's cost area changed: items still on the book's prices are priced again.
export function repriceProject(project, area) {
  let n = 0;
  for (const it of project.items || []) if (it.work && it.work.book) { setWork(it, {}, area); n++; }
  return n;
}

// A price typed by hand: the item keeps its work but is no longer on the book's prices.
export function priceEdited(item) { if (item.work) item.work.book = false; }

// One line about where the prices came from, for the item's panel.
export function priceNote(item) {
  const w = item.work && workById(item.work.id);
  if (!w) return '';
  const L = w.levels[item.work.level] || w.levels.mid;
  const a = PRICE_BOOK.areas.find(x => x.id === item.work.area) || PRICE_BOOK.areas[0];
  const mat = L.material;
  return {
    level: (LEVELS.find(l => l[0] === item.work.level) || LEVELS[1])[1],
    what: L.note || '',
    material: mat ? [mat.brand, mat.line].filter(Boolean).join(' ') + (mat.price ? ' · $' + mat.price + (mat.per ? '/' + mat.per : '') : '') + (mat.coverage ? ' · ' + mat.coverage : '') : '',
    materialUrl: mat && mat.url || '',
    basis: (item.work.book ? 'Price book ' : 'Typed by hand; the price book says ') + PRICE_BOOK.asOf + ': ' + (w.applies.includes('permit') ? 'typical total per permit' : 'installed price per ' + w.unit) + ', ' + a.label +
      (levelPrices(w, item.work.level, a.id).own ? ' (its own fee schedule)' : a.factor !== 1 ? ' (national × ' + a.factor + ')' : '') + '.' + (w.areaNotes && w.areaNotes[a.id] ? ' ' + w.areaNotes[a.id] : ''),
    sources: w.sources || [],
  };
}
