// Saved views, the way SketchUp has scene tabs: a named camera with the tags, section cut,
// x-ray and hidden levels it was saved with. Kept on the property so they travel in its project
// file. Pure data only (no DOM, no three.js), so Node tests run it; MODEL (viewer3d.js) shows
// them as tabs over the view, and a DOCUMENTS 3D view can start from one.
//
// prop.savedViews = [{ id, name, camera: { position: [x,y,z], target: [x,y,z], fov },
//   mode: 'orbit' | 'top', tags: { tagId | '_untagged': shown },
//   section: { on, height, planes: [{ id, kind, q, pos }], active }, xray, hiddenLevels: [levelId] }]
// `planes` (section-planes.js) is every cut the view was saved with and `active` the one whose
// handles show; a view saved before cuts could be rotated has only `height`, one flat cut.

import { OVERRIDE_UNTAGGED } from './tags.js';
import { normalizeSections } from './section-planes.js';

const ID_RE = /^[\w.:-]{1,80}$/;
const MAX_VIEWS = 100;
const num = v => (typeof v === 'number' || (typeof v === 'string' && v.trim())) ? Number(v) : NaN;
const vec3 = v => Array.isArray(v) && v.length === 3 && v.every(x => Number.isFinite(num(x)) && Math.abs(num(x)) < 1e6) ? v.map(num) : null;
const clean = v => String(typeof v === 'string' ? v : '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
let counter = 0;
const newId = () => 'view-' + Date.now().toString(36) + (counter++).toString(36) + Math.random().toString(36).slice(2, 6);

export function normalizeSavedView(v, taken = new Set()) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const c = v.camera && typeof v.camera === 'object' ? v.camera : {};
  const position = vec3(c.position), target = vec3(c.target);
  if (!position || !target) return null;   // a view without a camera shows nothing
  let id = typeof v.id === 'string' && ID_RE.test(v.id) && !taken.has(v.id) ? v.id : newId();
  while (taken.has(id)) id = newId();
  const fov = Number.isFinite(num(c.fov)) ? Math.min(110, Math.max(10, num(c.fov))) : 50;
  const tags = {};
  if (v.tags && typeof v.tags === 'object' && !Array.isArray(v.tags)) {
    for (const [k, on] of Object.entries(v.tags).slice(0, 500)) if (ID_RE.test(k) && typeof on === 'boolean') tags[k] = on;
  }
  const s = v.section && typeof v.section === 'object' ? v.section : {};
  const section = { on: s.on === true, height: Number.isFinite(num(s.height)) ? num(s.height) : 1.2 };
  const planes = normalizeSections(s.planes);
  if (planes.length) {
    section.planes = planes;
    section.active = planes.some(x => x.id === s.active) ? s.active : planes[0].id;
  }
  return {
    id, name: clean(v.name) || 'View', camera: { position, target, fov },
    mode: v.mode === 'top' ? 'top' : 'orbit', tags,
    section,
    xray: v.xray === true,
    hiddenLevels: Array.isArray(v.hiddenLevels) ? [...new Set(v.hiddenLevels.filter(x => typeof x === 'string' && ID_RE.test(x)))].slice(0, 100) : [],
  };
}

export function normalizeSavedViews(p) {
  const taken = new Set(), out = [];
  for (const v of Array.isArray(p.savedViews) ? p.savedViews.slice(0, MAX_VIEWS) : []) {
    const n = normalizeSavedView(v, taken);
    if (n) { taken.add(n.id); out.push(n); }
  }
  p.savedViews = out;
  return p;
}

// Which tags show right now: every tag and Untagged, as a view stores them.
export function tagState(prop) {
  const out = {};
  for (const t of prop.tags || []) out[t.id] = t.visible !== false;
  out[OVERRIDE_UNTAGGED] = prop.tagUntaggedVisible !== false;
  return out;
}

// Restore a view's tags. A tag made after the view was saved keeps its visibility.
export function applySavedTags(prop, view) {
  let changed = 0;
  for (const t of prop.tags || []) {
    if (typeof view.tags[t.id] !== 'boolean' || (t.visible !== false) === view.tags[t.id]) continue;
    t.visible = view.tags[t.id]; changed++;
  }
  const u = view.tags[OVERRIDE_UNTAGGED];
  if (typeof u === 'boolean' && (prop.tagUntaggedVisible !== false) !== u) { prop.tagUntaggedVisible = u; changed++; }
  return changed;
}

// The next "View N" name not in use.
export function nextViewName(prop) {
  const names = new Set((prop.savedViews || []).map(v => v.name.toLowerCase()));
  for (let i = (prop.savedViews || []).length + 1; ; i++) if (!names.has('view ' + i)) return 'View ' + i;
}

// A new saved view from the current state; `state` = { camera, mode, section, xray, hiddenLevels }.
export function addSavedView(prop, name, state) {
  const v = normalizeSavedView({ ...state, name: clean(name) || nextViewName(prop), tags: tagState(prop) }, new Set((prop.savedViews || []).map(x => x.id)));
  if (!v) throw new Error('This view has no usable camera');
  (prop.savedViews = prop.savedViews || []).push(v);
  return v;
}
export function updateSavedView(prop, id, state) {
  const i = (prop.savedViews || []).findIndex(v => v.id === id);
  if (i < 0) return null;
  const v = normalizeSavedView({ ...prop.savedViews[i], ...state, tags: tagState(prop), id: undefined });
  if (!v) return null;
  v.id = id;
  prop.savedViews[i] = v;
  return v;
}
export function renameSavedView(prop, id, name) {
  const v = (prop.savedViews || []).find(x => x.id === id), n = clean(name);
  if (!v || !n) return false;
  v.name = n;
  return true;
}
export function deleteSavedView(prop, id) {
  const before = (prop.savedViews || []).length;
  prop.savedViews = (prop.savedViews || []).filter(v => v.id !== id);
  return prop.savedViews.length < before;
}
export function moveSavedView(prop, id, by) {
  const list = prop.savedViews || [], i = list.findIndex(v => v.id === id), j = i + by;
  if (i < 0 || j < 0 || j >= list.length) return false;
  [list[i], list[j]] = [list[j], list[i]];
  return true;
}
