// Tape readings taken from walk-through video frames (MEASURE). Pure data, no DOM, so the
// rules are tested under Node. A reading is
//   { id, videoId, seconds, frameAssetId, crop: [x, y, w, h] | null (normalised to the frame),
//     value (m) | null, input (as typed), text (what was measured), direction, confidence,
//     element: { kind: 'opening'|'wall', id, dim: 'width'|'height'|'slabWidth'|'length' } | null,
//     status: 'unassigned'|'assigned'|'applied', applied: { previous, at } | null, note, createdAt }
// Applying a reading edits the model through the same geometry history as a typed edit in
// PLAN, so UNDO reverts it; the reading then reports that the model no longer matches.
import { uid, touch, units, readLength, wallsOn, roomsOn, openingsOn, levelOfWall, fmtLen, wallHeightOf } from './store.js';
import { openingDimensions, wallWidthFromSlab } from './opening-dimensions.js';
import { resizeOpening } from './opening-schedule.js';
import { beginGeometryEdit } from './edit-history.js';
import { planCornerMove, applyCornerMove } from './wallmove.js';
import { pointInPolygon } from './roomfill.js';

export const DIRECTIONS = ['width', 'height', 'depth'];
export const CONFIDENCE = ['clear', 'probable', 'unreadable'];
const IN = 0.0254, TOLERANCE = 0.001;

// A reading as typed, read by the same rule as every length field (store.js readLength): a
// bare number is inches in imperial (what a tape blade shows) and metres in metric; the form
// echoes the parsed value so an ambiguous entry is visible. Stray text is refused, not guessed.
export function parseReading(text) {
  const value = readLength(text, 'inches').value;
  return Number.isFinite(value) && value > 0 && value < 100 ? value : NaN;
}

// Tape style: inches to the nearest 1/16 below 10 ft (33 1/2"), feet-inches above; metric in cm.
export function fmtReading(m) {
  if (m == null || !Number.isFinite(m)) return '-';
  if (units() === 'metric') return (Math.round(m * 1000) / 10) + ' cm';
  let sixteenths = Math.round(m / IN * 16);
  const feet = sixteenths >= 120 * 16 ? Math.floor(sixteenths / 192) : 0;
  sixteenths -= feet * 192;
  const whole = Math.floor(sixteenths / 16); let num = sixteenths % 16, den = 16;
  while (num && num % 2 === 0) { num /= 2; den /= 2; }
  const inches = (whole || !num ? String(whole) : '') + (num ? (whole ? ' ' : '') + num + '/' + den : '') + '"';
  return feet ? feet + "'-" + inches : inches;
}

export function measurements(prop) { return prop.measurements || (prop.measurements = []); }
export function measurementById(prop, id) { return measurements(prop).find(m => m.id === id) || null; }

function statusFor(m, noteOnly) {
  if (m.status === 'applied' && m.element) return 'applied';
  return m.element || noteOnly ? 'assigned' : 'unassigned';
}

// fields: { videoId, seconds, frameAssetId, crop, input, text, direction, confidence, element, noteOnly, note }
export function addMeasurement(prop, fields) {
  const m = {
    id: uid('ms'), videoId: fields.videoId || '', seconds: Number(fields.seconds) || 0, frameAssetId: fields.frameAssetId || null,
    crop: validCrop(fields.crop), input: String(fields.input || ''), value: null, text: String(fields.text || '').trim(),
    direction: DIRECTIONS.includes(fields.direction) ? fields.direction : '', confidence: CONFIDENCE.includes(fields.confidence) ? fields.confidence : 'probable',
    element: validElement(fields.element), status: 'unassigned', applied: null, note: String(fields.note || ''), createdAt: new Date().toISOString(),
  };
  const v = parseReading(m.input); m.value = Number.isFinite(v) ? v : null;
  m.status = statusFor(m, fields.noteOnly);
  measurements(prop).push(m); touch();
  return m;
}

export function updateMeasurement(prop, id, fields) {
  const m = measurementById(prop, id);
  if (!m) return null;
  const before = JSON.stringify([m.element, m.value]);
  for (const k of ['text', 'note', 'input']) if (k in fields) m[k] = String(fields[k] || '').trim();
  if ('direction' in fields) m.direction = DIRECTIONS.includes(fields.direction) ? fields.direction : '';
  if ('confidence' in fields && CONFIDENCE.includes(fields.confidence)) m.confidence = fields.confidence;
  if ('crop' in fields) m.crop = validCrop(fields.crop);
  if ('frameAssetId' in fields) m.frameAssetId = fields.frameAssetId || null;
  if ('seconds' in fields && Number.isFinite(Number(fields.seconds))) m.seconds = Number(fields.seconds);
  if ('input' in fields) { const v = parseReading(m.input); m.value = Number.isFinite(v) ? v : null; }
  if ('element' in fields) m.element = validElement(fields.element);
  // A changed value or target is a new proposal: it has not been applied to the model.
  if (JSON.stringify([m.element, m.value]) !== before && m.status === 'applied') { m.status = 'assigned'; m.applied = null; }
  m.status = statusFor(m, 'noteOnly' in fields ? fields.noteOnly : m.status === 'assigned' && !m.element);
  touch();
  return m;
}

export function removeMeasurement(prop, id) {
  const m = measurementById(prop, id);
  prop.measurements = measurements(prop).filter(x => x.id !== id); touch();
  return m;
}

function validCrop(c) {
  if (!Array.isArray(c) || c.length !== 4 || !c.every(Number.isFinite)) return null;
  const [x, y, w, h] = c.map(v => Math.min(1, Math.max(0, v)));
  return w > 0.005 && h > 0.005 ? [x, y, Math.min(w, 1 - x), Math.min(h, 1 - y)].map(v => Math.round(v * 10000) / 10000) : null;
}
function validElement(e) {
  if (!e || typeof e !== 'object' || typeof e.id !== 'string') return null;
  if (e.kind === 'opening' && ['width', 'height', 'slabWidth'].includes(e.dim)) return { kind: 'opening', id: e.id, dim: e.dim };
  if (e.kind === 'wall' && e.dim === 'length') return { kind: 'wall', id: e.id, dim: 'length' };
  return null;
}

// ---------- elements a reading can be attached to ----------
function wallLength(w) { return Math.hypot(w.bx - w.ax, w.by - w.ay); }
function roomOfWall(prop, w) {
  const L = wallLength(w) || 1, nx = -(w.by - w.ay) / L, ny = (w.bx - w.ax) / L, mx = (w.ax + w.bx) / 2, my = (w.ay + w.by) / 2;
  const rooms = roomsOn(prop, levelOfWall(prop, w).id);
  for (const side of [0.2, -0.2]) for (const r of rooms) if (r.pts?.length > 2 && pointInPolygon(mx + nx * side, my + ny * side, r.pts)) return r.name || 'Room';
  return '';
}

// Every attachable dimension, labelled so an owner can tell them apart without the plan.
// A wall's length is on its centre line, as PLAN draws it: a tape along the room-side face
// reads shorter by half of each joining wall's thickness, so the label says which it is.
export function elementTargets(prop) {
  const out = [], multi = (prop.levels || []).length > 1;
  for (const level of prop.levels || []) {
    const walls = wallsOn(prop, level.id), suffix = multi ? ' · ' + level.name : '';
    const wallNo = new Map(walls.map((w, i) => [w.id, i + 1]));
    const counts = { door: 0, window: 0 };
    for (const o of openingsOn(prop, level.id)) {
      const kind = o.type === 'window' ? 'window' : 'door', w = walls.find(x => x.id === o.wallId);
      const n = ++counts[kind], room = w ? roomOfWall(prop, w) : '';
      const name = (kind === 'window' ? 'Window ' : 'Door ') + n + (room ? ' (' + room + ')' : '') + ' on wall ' + (wallNo.get(o.wallId) || '?') + suffix;
      for (const dim of ['width', 'height']) out.push({ kind: 'opening', id: o.id, dim, group: kind === 'window' ? 'Windows' : 'Doors and openings', label: name + ' · wall opening ' + dim, current: o[dim] });
      if (kind === 'door' && openingDimensions(prop,o).leaves) out.push({kind:'opening',id:o.id,dim:'slabWidth',group:'Doors and openings',label:name+' · door slab width per leaf',current:openingDimensions(prop,o).slabWidth});
    }
    for (const w of walls) {
      const room = roomOfWall(prop, w);
      out.push({ kind: 'wall', id: w.id, dim: 'length', group: 'Walls', label: 'Wall ' + wallNo.get(w.id) + (room ? ' (' + room + ')' : '') + suffix + ' · centre-line length', current: wallLength(w) });
    }
  }
  return out;
}
export function targetKey(e) { return e ? e.kind + ':' + e.id + ':' + e.dim : ''; }
export function targetFor(prop, e) { return e ? elementTargets(prop).find(t => targetKey(t) === targetKey(e)) || null : null; }

export function currentValue(prop, e) {
  if (!e) return null;
  if (e.kind === 'opening') { const o = (prop.openings || []).find(x => x.id === e.id); return o ? e.dim === 'slabWidth' ? o.type === 'window' ? null : openingDimensions(prop,o).slabWidth : o[e.dim] : null; }
  const w = (prop.walls || []).find(x => x.id === e.id);
  return w ? wallLength(w) : null;
}

// What a reading's status means now: 'applied' only while the model still holds its value.
export function readingState(prop, m) {
  if (m.element && currentValue(prop, m.element) == null) return 'missing';
  if (m.status !== 'applied') return m.status;
  return Math.abs(currentValue(prop, m.element) - m.value) <= TOLERANCE ? 'applied' : 'changed';
}

export function canApply(prop, m) {
  if (!m.element) return 'Attach the reading to an opening or wall first.';
  if (!Number.isFinite(m.value)) return 'Enter a readable value first.';
  if (m.confidence === 'unreadable') return 'An unreadable reading cannot change the model.';
  const current = currentValue(prop, m.element);
  if (current == null) return 'That element is no longer in the model.';
  if (m.element.kind === 'opening') {
    const o = prop.openings.find(x => x.id === m.element.id), w = prop.walls.find(x => x.id === o.wallId);
    if (!w) return 'The opening has no host wall.';
    if (m.value < 0.05) return 'Too small for an opening.';
    const changes=m.element.dim === 'slabWidth' ? {width:wallWidthFromSlab(o,m.value,openingDimensions(prop,o).leaves)} : {[m.element.dim]:m.value};
    // PLAN's rule for a typed size (the opening schedule's resize): try it on a copy, and refuse
    // a reading the rule would have to cut down rather than store a different number.
    const trial = Object.assign({}, o);
    if (m.element.dim === 'slabWidth') trial.leaves=openingDimensions(prop,o).leaves;
    if (w && !resizeOpening(prop, trial, changes, wallHeightOf(prop, w))) return 'The opening would overlap another opening or has invalid geometry.';
    if (w && Math.abs((m.element.dim === 'slabWidth' ? openingDimensions(prop,trial).slabWidth : trial[m.element.dim]) - m.value) > TOLERANCE) {
      if (['width','slabWidth'].includes(m.element.dim)) return 'The opening would be wider than its wall allows (' + fmtLen(trial.width) + ' at most on a ' + fmtLen(wallLength(w)) + ' wall).';
      const sill = o.type === 'window' ? Number(o.sill) || 0 : 0;
      return 'The opening would be taller than its wall (' + fmtLen(trial.height) + ' at most under a ' + fmtLen(wallHeightOf(prop, w)) + ' wall' + (sill ? ' above a ' + fmtLen(sill) + ' sill' : '') + ').';
    }
  } else if (m.value < 0.05) return 'Too short for a wall.';
  return '';
}

// Change the model to the reading. Returns { previous, value } or throws with the reason.
export function applyMeasurement(prop, id) {
  const m = measurementById(prop, id), problem = m ? canApply(prop, m) : 'Reading not found.';
  if (problem) throw new Error(problem);
  const previous = currentValue(prop, m.element), e = m.element;
  beginGeometryEdit(prop, 'apply tape reading');
  if (e.kind === 'opening') {
    // Through the same resize rule as a size typed in PLAN, so a wider opening stays on its wall.
    const o = prop.openings.find(x => x.id === e.id), w = prop.walls.find(x => x.id === o.wallId);
    const changes=e.dim === 'slabWidth' ? {width:wallWidthFromSlab(o,m.value,openingDimensions(prop,o).leaves)} : {[e.dim]:m.value};
    const leaves=openingDimensions(prop,o).leaves;
    if (!w || !resizeOpening(prop, o, changes, wallHeightOf(prop, w))) throw new Error('Opening change refused; review its host and overlap.');
    if(e.dim === 'slabWidth') o.leaves=leaves;
  }
  else {
    // As PLAN's length field: the b end moves along the wall, joined walls and floors follow.
    const w = prop.walls.find(x => x.id === e.id), L = wallLength(w), level = levelOfWall(prop, w).id;
    const ux = (w.bx - w.ax) / L, uy = (w.by - w.ay) / L, rnd = v => Math.round(v * 1e4) / 1e4;
    applyCornerMove(planCornerMove(w, 'b', wallsOn(prop, level), roomsOn(prop, level), openingsOn(prop, level)), rnd(w.ax + ux * m.value), rnd(w.ay + uy * m.value));
  }
  m.status = 'applied'; m.applied = { previous, at: new Date().toISOString() };
  touch();
  return { previous, value: m.value };
}

// Readings a person has to explain: nobody said what they are, where they belong, or the
// numbers could not be read. Applied readings have been decided.
export function needsOwner(prop, m) {
  const state = readingState(prop, m);
  if (state === 'changed' || state === 'missing') return true;
  if (state === 'applied') return false;
  return m.status === 'unassigned' || m.confidence === 'unreadable' || !m.text.trim() || readingState(prop, m) === 'missing';
}
export function askOwnerList(prop) {
  return measurements(prop).filter(m => needsOwner(prop, m)).sort((a, b) => a.videoId.localeCompare(b.videoId) || a.seconds - b.seconds);
}

export function fmtTime(t) {
  t = Math.max(0, Number(t) || 0);
  const m = Math.floor(t / 60), s = t - m * 60;
  return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
}

// Plain text to send with the frames: one line per open question.
export function askOwnerText(prop) {
  const videos = new Map((prop.videos || []).map(v => [v.id, v.name]));
  return askOwnerList(prop).map((m, i) => {
    const why = readingState(prop,m) === 'changed' ? 'model changed since this reading was applied' : m.confidence === 'unreadable' ? 'numbers not readable' : !m.text.trim() ? 'what was measured?' : m.status === 'unassigned' ? 'which element is this?' : 'element no longer in the model';
    return (i + 1) + '. ' + (videos.get(m.videoId) || 'video') + ' at ' + fmtTime(m.seconds) + ': ' + (Number.isFinite(m.value) ? fmtReading(m.value) : m.input || 'no value') +
      (m.text ? ' - ' + m.text : '') + (m.direction ? ' (' + m.direction + ')' : '') + ' - ' + why + (m.note ? ' - ' + m.note : '');
  }).join('\n');
}
