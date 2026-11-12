// Tags, the way SketchUp has them: every part of the model sits on one tag (or on none,
// "Untagged"), and each tag can be shown or hidden. Pure data and rules only (no DOM, no
// three.js), so Node tests run it; js/tags-scene.js applies it to scene objects.
//
// On the property, so it travels in the project file:
//   prop.tags              [{ id, name, visible, color }]
//   prop.tagOf             { key: tagId | '' }   explicit assignments ('' = Untagged)
//   prop.tagDefaults       { wall, room, ceiling, opening, fixture, furniture }: tag id or ''
//   prop.tagUntaggedVisible  whether Untagged objects show
//   prop.hidden            { key: true }   objects hidden one at a time, whatever their tag
//
// A key names one taggable object:
//   wall:<id>  room:<id> (its floor)  ceiling:<roomId>  opening:<id>  fixture:<id>
//   node:<scanId>#<path>   one mesh of an imported model; path is its child indices below
//                          the model's root ('0/3/1'), or '*' for a whole point cloud or splat.
// Plan elements without an explicit assignment follow tagDefaults by kind; a model's meshes
// are assigned when the model first loads (detectTag below) and the result is stored.

export const UNTAGGED = '';
export const UNTAGGED_LABEL = 'Untagged';
export const OVERRIDE_UNTAGGED = '_untagged';   // a viewport's override key for Untagged

// The tags Tiksi creates itself. Ids are fixed so detection on any model finds the same one.
export const CANON = {
  walls: { id: 'tag-walls', name: 'Walls', color: '#b9b2a6' },
  floor: { id: 'tag-floor', name: 'Floor', color: '#a37a52' },
  ceiling: { id: 'tag-ceiling', name: 'Ceiling', color: '#d9d3c7' },
  roof: { id: 'tag-roof', name: 'Roof', color: '#6d7a73' },
  openings: { id: 'tag-openings', name: 'Doors and windows', color: '#5b8fb9' },
  builtins: { id: 'tag-builtins', name: 'Cabinets and built-ins', color: '#8f6d9e' },
  furniture: { id: 'tag-furniture', name: 'Furniture and fixtures', color: '#c98a45' },
  site: { id: 'tag-site', name: 'Site', color: '#7c9a58' },
  scan: { id: 'tag-scan', name: 'Scan capture', color: '#8a80b8' },
};
// Plan element kinds and the tag each starts on.
export const PLAN_KINDS = { wall: 'walls', room: 'floor', ceiling: 'ceiling', opening: 'openings', fixture: 'builtins', furniture: 'furniture' };
const PLAN_SEED = ['walls', 'floor', 'ceiling', 'openings', 'builtins', 'furniture'];
const PALETTE = ['#d0743c', '#3f8f8a', '#b04f6f', '#6a7fc4', '#9a9a3a', '#4f9a62', '#a0663c', '#7a5fa8', '#c2a23e', '#5a8fa8'];

const ID_RE = /^[\w.:-]{1,80}$/;
const PLAN_KEY_RE = /^(wall|room|ceiling|opening|fixture):([\w.:-]{1,80})$/;
const NODE_KEY_RE = /^node:([\w.:-]{1,80})#(\*|\d{1,6}(?:\/\d{1,6}){0,63})$/;
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const MAX_TAGS = 500, MAX_ASSIGN = 400000, MAX_NAME = 80;

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
export const planKey = (kind, id) => kind + ':' + id;
export const nodeKey = (scanId, path) => 'node:' + scanId + '#' + (path || '*');
export function parseKey(key) {
  let m = PLAN_KEY_RE.exec(key);
  if (m) return { kind: m[1], id: m[2] };
  m = NODE_KEY_RE.exec(key);
  if (m) return { kind: 'node', scanId: m[1], path: m[2] };
  return null;
}

export function tagById(prop, id) { return (prop.tags || []).find(t => t.id === id) || null; }
export function tagByName(prop, name) {
  const n = String(name || '').trim().toLowerCase();
  return (prop.tags || []).find(t => t.name.toLowerCase() === n) || null;
}
function cleanName(v) { return String(typeof v === 'string' ? v : '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME); }
function uniqueName(prop, name, except) {
  const taken = new Set((prop.tags || []).filter(t => t !== except).map(t => t.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let i = 2; ; i++) { const n = name.slice(0, MAX_NAME - 5) + ' (' + i + ')'; if (!taken.has(n.toLowerCase())) return n; }
}
function nextColor(prop) { return PALETTE[(prop.tags || []).length % PALETTE.length]; }
let idCounter = 0;
function newTagId(prop) {
  for (;;) {
    const id = 'tag-' + Date.now().toString(36) + (idCounter++).toString(36) + Math.random().toString(36).slice(2, 6);
    if (!tagById(prop, id)) return id;
  }
}

// ---------- normalising (store.js migrate) ----------

// Make prop's tag records safe and consistent. A property that never had tags gets the plan
// tags; the older FURNITURE switch (env.hideFurniture) becomes the furniture tag's visibility.
export function normalizeTags(p) {
  const fresh = !Array.isArray(p.tags);
  const list = [];
  const seen = new Set();
  for (const t of fresh ? [] : p.tags.slice(0, MAX_TAGS)) {
    if (!isObj(t) || typeof t.id !== 'string' || !ID_RE.test(t.id) || seen.has(t.id)) continue;
    seen.add(t.id);
    const canon = Object.values(CANON).find(c => c.id === t.id);
    const tag = { id: t.id, name: cleanName(t.name) || (canon ? canon.name : 'Tag'), visible: t.visible !== false, color: COLOR_RE.test(t.color) ? t.color.toLowerCase() : (canon ? canon.color : PALETTE[list.length % PALETTE.length]) };
    tag.name = uniqueName({ tags: list }, tag.name);
    list.push(tag);
  }
  p.tags = list;
  if (fresh) {
    for (const k of PLAN_SEED) ensureCanonTag(p, k);
    const furn = tagById(p, CANON.furniture.id);
    if (furn && p.env && p.env.hideFurniture) furn.visible = false;
  }
  if (p.env) delete p.env.hideFurniture;   // folded into the furniture tag

  const ids = new Set(p.tags.map(t => t.id));
  const defaults = {};
  const given = isObj(p.tagDefaults) ? p.tagDefaults : null;
  for (const [kind, canon] of Object.entries(PLAN_KINDS)) {
    const v = given ? given[kind] : undefined;
    if (typeof v === 'string' && (v === UNTAGGED || ids.has(v))) defaults[kind] = v;
    else if (!given || v === undefined) defaults[kind] = ids.has(CANON[canon].id) ? CANON[canon].id : UNTAGGED;
    else defaults[kind] = UNTAGGED;
  }
  p.tagDefaults = defaults;

  // Assignments to objects that are gone, to tags that are gone, or under malformed keys are dropped.
  const live = {
    wall: new Set((p.walls || []).map(w => w && w.id)), room: new Set((p.rooms || []).map(r => r && r.id)),
    opening: new Set((p.openings || []).map(o => o && o.id)), fixture: new Set((p.fixtures || []).map(f => f && f.id)),
    scan: new Set((p.scans || []).map(s => s && s.id)),
  };
  live.ceiling = live.room;
  const out = {};
  let n = 0;
  if (isObj(p.tagOf)) for (const [key, v] of Object.entries(p.tagOf)) {
    if (n >= MAX_ASSIGN) break;
    if (typeof v !== 'string' || (v !== UNTAGGED && !ids.has(v))) continue;
    const k = parseKey(key);
    if (!k || !(k.kind === 'node' ? live.scan.has(k.scanId) : live[k.kind].has(k.id))) continue;
    out[key] = v; n++;
  }
  p.tagOf = out;
  p.tagUntaggedVisible = p.tagUntaggedVisible !== false;
  // Hidden objects, under the same rules: a key that names nothing any more is dropped.
  const hidden = {};
  n = 0;
  if (isObj(p.hidden)) for (const [key, v] of Object.entries(p.hidden)) {
    if (n >= MAX_ASSIGN) break;
    if (v !== true) continue;
    const k = parseKey(key);
    if (!k || !(k.kind === 'node' ? live.scan.has(k.scanId) : live[k.kind].has(k.id))) continue;
    hidden[key] = true; n++;
  }
  p.hidden = hidden;
  return p;
}

export function ensureCanonTag(prop, canonKey) {
  const c = CANON[canonKey];
  let t = tagById(prop, c.id) || tagByName(prop, c.name);   // a tag the owner made with that name counts
  if (!t) {
    t = { id: c.id, name: uniqueName(prop, c.name), visible: true, color: c.color };
    (prop.tags = prop.tags || []).push(t);
  }
  return t;
}

// ---------- assignment and visibility ----------

// The tag id an object sits on: '' for Untagged, undefined for a model mesh not yet detected.
export function tagIdOf(prop, key) {
  const own = prop.tagOf && Object.prototype.hasOwnProperty.call(prop.tagOf, key) ? prop.tagOf[key] : undefined;
  if (own !== undefined) return own;
  const k = parseKey(key);
  if (!k || k.kind === 'node') return undefined;
  const d = prop.tagDefaults || {};
  if (k.kind === 'fixture') {
    const f = (prop.fixtures || []).find(x => x.id === k.id);
    return (f && f.kind === 'furniture' ? d.furniture : d.fixture) || UNTAGGED;
  }
  return d[k.kind] || UNTAGGED;
}

// Whether an object shows. `overrides` is a viewport's own visibility: { tagId | '_untagged': bool }.
export function tagShown(prop, tagId, overrides) {
  const id = tagId || UNTAGGED;
  const ok = id || OVERRIDE_UNTAGGED;
  if (overrides && typeof overrides[ok] === 'boolean') return overrides[ok];
  if (!id) return prop.tagUntaggedVisible !== false;
  const t = tagById(prop, id);
  return t ? t.visible !== false : prop.tagUntaggedVisible !== false;
}
// An object shows when it is not hidden itself and its tag shows.
export function keyShown(prop, key, overrides) { return !isHidden(prop, key) && tagShown(prop, tagIdOf(prop, key), overrides); }

// ---------- hiding one object ----------
// Hiding is the object's own switch, as SketchUp's Hide is: it does not touch the tag, and the
// other objects on that tag stay as they are.
export function isHidden(prop, key) { return !!(prop.hidden && prop.hidden[key] === true); }
// Hide (`on` true) or show these objects. Returns how many changed.
export function setHidden(prop, keys, on) {
  prop.hidden = prop.hidden || {};
  let changed = 0;
  for (const key of keys) {
    if (!parseKey(key) || isHidden(prop, key) === !!on) continue;
    if (on) prop.hidden[key] = true; else delete prop.hidden[key];
    changed++;
  }
  return changed;
}
export function hiddenKeys(prop) { return Object.keys(prop.hidden || {}); }
// Show every hidden object. Returns the keys that were hidden.
export function showAllHidden(prop) {
  const keys = hiddenKeys(prop);
  prop.hidden = {};
  return keys;
}

export function assignTag(prop, keys, tagId) {
  if (tagId && !tagById(prop, tagId)) throw new Error('No such tag');
  prop.tagOf = prop.tagOf || {};
  let changed = 0;
  for (const key of keys) {
    if (!parseKey(key)) continue;
    if (prop.tagOf[key] === (tagId || UNTAGGED)) continue;
    prop.tagOf[key] = tagId || UNTAGGED;
    changed++;
  }
  return changed;
}

export function addTag(prop, name, opts = {}) {
  const t = { id: newTagId(prop), name: uniqueName(prop, cleanName(name) || 'New tag'), visible: opts.visible !== false, color: COLOR_RE.test(opts.color) ? opts.color.toLowerCase() : nextColor(prop) };
  (prop.tags = prop.tags || []).push(t);
  return t;
}
export function renameTag(prop, id, name) {
  const t = tagById(prop, id), n = cleanName(name);
  if (!t || !n) return false;
  t.name = uniqueName(prop, n, t);
  return true;
}
export function setTagColor(prop, id, color) {
  const t = tagById(prop, id);
  if (!t || !COLOR_RE.test(color)) return false;
  t.color = color.toLowerCase();
  return true;
}
export function setTagShown(prop, id, on) {
  if (!id) { prop.tagUntaggedVisible = !!on; return true; }
  const t = tagById(prop, id);
  if (!t) return false;
  t.visible = !!on;
  return true;
}
// Delete a tag; what was on it moves to `moveTo` (another tag id, or Untagged), as in SketchUp.
export function deleteTag(prop, id, moveTo = UNTAGGED) {
  if (!tagById(prop, id) || moveTo === id) return false;
  if (moveTo && !tagById(prop, moveTo)) moveTo = UNTAGGED;
  prop.tags = prop.tags.filter(t => t.id !== id);
  for (const k of Object.keys(prop.tagOf || {})) if (prop.tagOf[k] === id) prop.tagOf[k] = moveTo;
  for (const k of Object.keys(prop.tagDefaults || {})) if (prop.tagDefaults[k] === id) prop.tagDefaults[k] = moveTo;
  return true;
}

// Every plan element's key, in plan order.
export function planKeys(prop) {
  const out = [];
  for (const w of prop.walls || []) out.push(planKey('wall', w.id));
  for (const o of prop.openings || []) out.push(planKey('opening', o.id));
  for (const r of prop.rooms || []) { out.push(planKey('room', r.id)); out.push(planKey('ceiling', r.id)); }
  for (const f of prop.fixtures || []) out.push(planKey('fixture', f.id));
  return out;
}
// Object counts: Map tagId|'' -> n, for plan elements and every model mesh assigned so far.
export function tagCounts(prop) {
  const counts = new Map([[UNTAGGED, 0], ...(prop.tags || []).map(t => [t.id, 0])]);
  const bump = id => { const k = id && counts.has(id) ? id : UNTAGGED; counts.set(k, counts.get(k) + 1); };
  for (const key of planKeys(prop)) bump(tagIdOf(prop, key));
  for (const [key, id] of Object.entries(prop.tagOf || {})) if (key.startsWith('node:')) bump(id);
  return counts;
}
// The keys a tag holds (plan elements and assigned model meshes).
export function keysOnTag(prop, tagId) {
  const out = planKeys(prop).filter(k => (tagIdOf(prop, k) || UNTAGGED) === (tagId || UNTAGGED));
  for (const [key, id] of Object.entries(prop.tagOf || {})) if (key.startsWith('node:') && (id || UNTAGGED) === (tagId || UNTAGGED)) out.push(key);
  return out;
}
export function scanHasTags(prop, scanId) {
  const pre = 'node:' + scanId + '#';
  for (const k of Object.keys(prop.tagOf || {})) if (k.startsWith(pre)) return true;
  return false;
}
// Drop a model's assignments (it was deleted or re-imported).
export function forgetScanTags(prop, scanId) {
  const pre = 'node:' + scanId + '#';
  for (const k of Object.keys(prop.tagOf || {})) if (k.startsWith(pre)) delete prop.tagOf[k];
  for (const k of Object.keys(prop.hidden || {})) if (k.startsWith(pre)) delete prop.hidden[k];
}

// ---------- detection ----------

// A name's tag, by building words. "Roof" anywhere wins (a roof hides everything under it,
// so it is the tag people reach for); otherwise the earliest word decides, so
// "Wall - door side" is a wall and "Racking - backyard wall" is furniture.
const NAME_RULES = [
  ['openings', /\b(doors?|windows?|glazing|skylights?|openings?)\b/i],
  ['furniture', /\b(furniture|furnishings?|racks?|racking|shel(?:f|ves|ving)|cabinets?|casework|millwork|counters?|countertops?|appliances?|fixtures?|lights?|lamps?|sofas?|couch|chairs?|tables?|desks?|beds?|bottles?|magnums?|cases?|vanity|toilets?|sinks?|showers?|bath(?:tub)?s?|units?|devices?|electrical|outlets?|switch(?:es)?|probes?|fans?)\b/i],
  ['ceiling', /\b(ceilings?)\b/i],
  ['floor', /\b(floors?|flooring|subfloor|slabs?)\b/i],
  ['walls', /\b(walls?|siding|cladding|partitions?|studs?|drywall|skirting|trim|parapets?)\b/i],
  ['site', /\b(context|site|terrain|ground|lawn|garden|landscap\w*|trees?|fences?|pool|pergola|barn|driveway|patio|decks?|paving|shade structure|hot tub)\b/i],
];
const ROOF_RE = /\b(roofs?|roofing|shingles?|soffits?|fascia|gutters?|eaves?)\b/i;

export function nameTag(name) {
  // Exporters and loaders write spaces as underscores ("Roof_shingles"); read them as spaces.
  const s = String(name || '').replace(/_+/g, ' ');
  if (!s.trim()) return null;
  if (ROOF_RE.test(s)) return 'roof';
  let best = null, at = Infinity;
  for (const [tag, re] of NAME_RULES) {
    const m = re.exec(s);
    if (m && m.index < at) { best = tag; at = m.index; }
  }
  return best;
}

// A mesh's tag from its shape, measured in world space (metres, Y up):
//   stats = { area, up, down, vertical, sloped (face areas by facing), y0, y1 }
//   level = { elevation, height } of the storey it stands on.
// Up-facing or sloped faces above the level's height read as Roof; a thin horizontal piece at
// the floor reads as Floor, one at the top of the storey as Ceiling; mostly vertical faces at
// least 60% of the storey tall read as Walls; everything else as Furniture and fixtures.
export function geometryTag(stats, level) {
  if (!stats || !(stats.area > 0) || !Number.isFinite(stats.y0) || !Number.isFinite(stats.y1)) return null;
  const H = level && level.height > 0 ? level.height : 2.44;
  const e = level && Number.isFinite(level.elevation) ? level.elevation : 0;
  const rel0 = stats.y0 - e, rel1 = stats.y1 - e, tall = stats.y1 - stats.y0;
  const flat = ((stats.up || 0) + (stats.down || 0)) / stats.area;
  const vert = (stats.vertical || 0) / stats.area;
  const slope = (stats.sloped || 0) / stats.area;
  const thin = tall < 0.35;
  if (rel0 >= H - 0.05 && flat + slope >= 0.5) return 'roof';
  if (slope >= 0.5 && rel0 >= H * 0.5) return 'roof';
  if (flat >= 0.6 && thin && rel1 <= 0.3) return 'floor';
  if (flat >= 0.6 && thin && rel0 >= H - 0.6) return 'ceiling';
  if (vert >= 0.6 && tall >= 0.6 * H) return 'walls';
  return 'furniture';
}

// The storey a mesh stands on: the highest level whose floor is at or below its base.
export function levelFor(levels, y0) {
  const sorted = (levels || []).slice().sort((a, b) => a.elevation - b.elevation);
  if (!sorted.length) return { elevation: 0, height: 2.44 };
  let pick = sorted[0];
  for (const l of sorted) if (l.elevation <= y0 + 0.15) pick = l;
  return pick;
}

// One mesh's tag, in order: the file's own tag (SketchUp tag, or a Tiksi tag written into an
// exported model), then the names of the mesh and its parents (nearest first), then its shape.
// `record` is the whole model's kind from view-layers.js scanLayer: a scan capture or a
// furniture model puts every mesh on that tag.
//   -> { tag: canon key, or name: file tag name, from: 'file'|'record'|'name'|'geometry' }
export function detectTag({ fileTag, names, stats, level, record } = {}) {
  const file = cleanName(fileTag);
  if (file) return { name: file, from: 'file' };
  if (record === 'scan') return { tag: 'scan', from: 'record' };
  if (record === 'furnishings') return { tag: 'furniture', from: 'record' };
  for (const n of names || []) { const t = nameTag(n); if (t) return { tag: t, from: 'name' }; }
  const g = geometryTag(stats, level);
  return g ? { tag: g, from: 'geometry' } : { tag: 'furniture', from: 'geometry' };
}

// The tag id for a detection result, creating the tag when it does not exist yet. A file tag
// reuses a tag of the same name (any case), so a SketchUp "Roof" lands on Tiksi's Roof.
export function tagForDetection(prop, d) {
  if (d.name) {
    const same = tagByName(prop, d.name);
    if (same) return same.id;
    const canon = Object.entries(CANON).find(([, c]) => c.name.toLowerCase() === d.name.toLowerCase());
    if (canon) return ensureCanonTag(prop, canon[0]).id;
    return addTag(prop, d.name).id;
  }
  return ensureCanonTag(prop, d.tag).id;
}
