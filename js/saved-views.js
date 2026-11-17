// Saved views, the way SketchUp has scene tabs: a named camera with everything that decided what
// showed when it was saved: tags, section cuts, x-ray, hidden levels, objects hidden one by one,
// which imported models showed, photo pins and notes. Kept on the property so they travel in its project
// file. Pure data only (no DOM, no three.js), so Node tests run it; MODEL (viewer3d.js) shows
// them as tabs over the view, and a DOCUMENTS 3D view can start from one.
//
// prop.savedViews = [{ id, name, camera: { position: [x,y,z], target: [x,y,z], fov, parallel? },
//   mode: 'orbit' | 'top', tags: { tagId | '_untagged' | 'tagId:e|p' | '_phase:e|p': shown },
//   section: { on, height, planes: [{ id, kind, q, pos }], active, done }, xray, hiddenLevels: [levelId],
//   hidden: [object key], models: { scanId: shown }, compare: 'before' | 'after',
//   markers: { pins, notes }, xrayOpacity, uncertainty, source? }]
// `source` = { app: 'sketchup', scan, scene } on a view made from an imported model's SketchUp
// scene, { app: 'sketchup-sync', scene } on one made from a scene added in the SketchUp sync file.
// `standard` = { key, name } on a view of the standard set (standard-views.js).
// `planes` (section-planes.js) is every cut the view was saved with and `active` the one whose
// handles show; `done` is a clean section, its planes and handles put away. A view saved before
// cuts could be rotated has only `height`, one flat cut. A view saved before Tiksi kept
// `models`, `compare`, `markers`, `xrayOpacity` or `uncertainty` has none of them, and going to it
// leaves those as they are; one saved before Tiksi kept `hidden` hides nothing one by one.
//
// What shows is each view's own: while a view is the current tab in MODEL, every change to what
// shows (tags, objects hidden one by one, cuts, x-ray, levels, models, markers) is kept in that
// view as it is made (keepShowing). Its camera changes only with UPDATE TO WHAT SHOWS NOW.

import { OVERRIDE_UNTAGGED, parseKey, PHASES, phaseOverrideKey, phaseShown, setPhaseShown, tagById } from './tags.js';
import { normalizeSections } from './section-planes.js';
import { VFOV_MIN, VFOV_MAX, DEFAULT_VFOV } from './lens.js';

const ID_RE = /^[\w.:-]{1,80}$/;
const MAX_VIEWS = 100, MAX_HIDDEN = 20000;
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
  // The vertical angle, within the limits the FIELD OF VIEW tool keeps to (lens.js).
  const fov = Number.isFinite(num(c.fov)) ? Math.min(VFOV_MAX, Math.max(VFOV_MIN, num(c.fov))) : DEFAULT_VFOV;
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
  if (typeof s.done === 'boolean') section.done = s.done;
  const out = {
    id, name: clean(v.name) || 'View', camera: { position, target, fov, ...(c.parallel === true ? { parallel: true } : {}) },
    mode: v.mode === 'top' ? 'top' : 'orbit', tags,
    section,
    xray: v.xray === true,
    hiddenLevels: Array.isArray(v.hiddenLevels) ? [...new Set(v.hiddenLevels.filter(x => typeof x === 'string' && ID_RE.test(x)))].slice(0, 100) : [],
  };
  // What later versions keep: only when the view has it.
  if (Array.isArray(v.hidden)) out.hidden = [...new Set(v.hidden.filter(k => typeof k === 'string' && k.length <= 500 && parseKey(k)))].slice(0, MAX_HIDDEN);
  if (v.models && typeof v.models === 'object' && !Array.isArray(v.models)) {
    out.models = {};
    for (const [k, on] of Object.entries(v.models).slice(0, 500)) if (ID_RE.test(k) && typeof on === 'boolean') out.models[k] = on;
  }
  if (v.compare === 'before' || v.compare === 'after') out.compare = v.compare;
  if (v.markers && typeof v.markers === 'object' && !Array.isArray(v.markers)) {
    const m = {};
    for (const k of ['pins', 'notes']) if (typeof v.markers[k] === 'boolean') m[k] = v.markers[k];
    if (Object.keys(m).length) out.markers = m;
  }
  const xo = num(v.xrayOpacity);
  if (v.xrayOpacity != null && Number.isFinite(xo)) out.xrayOpacity = Math.min(1, Math.max(0, xo));
  if (typeof v.uncertainty === 'boolean') out.uncertainty = v.uncertainty;
  // A view made from a SketchUp scene (sketchup-scenes.js) names the model and the scene.
  const src = v.source;
  if (src && src.app === 'sketchup' && typeof src.scan === 'string' && ID_RE.test(src.scan) && typeof src.scene === 'string' && src.scene.trim())
    out.source = { app: 'sketchup', scan: src.scan, scene: src.scene.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200) };
  // A view made from a scene added in the SketchUp sync file (sketchup-mirror.js) names that scene.
  else if (src && src.app === 'sketchup-sync' && typeof src.scene === 'string' && src.scene.trim())
    out.source = { app: 'sketchup-sync', scene: src.scene.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200) };
  // A view of the standard set (standard-views.js): what it shows, and the name it was made with.
  const st = v.standard;
  if (st && typeof st.key === 'string' && /^[\w.:-]{1,200}$/.test(st.key) && typeof st.name === 'string')
    out.standard = { key: st.key, name: clean(st.name) };
  return out;
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

// Which tags show right now: every tag and Untagged, and the existing and proposed halves of
// every tag and of the whole model ('tagId:e', '_phase:p'), as a view stores them.
export function tagState(prop) {
  const out = {};
  for (const t of prop.tags || []) {
    out[t.id] = t.visible !== false;
    for (const ph of PHASES) out[phaseOverrideKey(t.id, ph)] = !(t.phases && t.phases[ph] === false);
  }
  out[OVERRIDE_UNTAGGED] = prop.tagUntaggedVisible !== false;
  for (const ph of PHASES) out[phaseOverrideKey('', ph)] = phaseShown(prop, '', ph);
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
  // The halves: a view saved before existing/proposed leaves them as they are.
  for (const id of ['', ...(prop.tags || []).map(t => t.id)]) for (const ph of PHASES) {
    const want = view.tags[phaseOverrideKey(id, ph)];
    if (typeof want !== 'boolean') continue;
    const now = id ? !(tagById(prop, id).phases && tagById(prop, id).phases[ph] === false) : phaseShown(prop, '', ph);
    if (now !== want) { setPhaseShown(prop, id, ph, want); changed++; }
  }
  return changed;
}

// The next "View N" name not in use.
export function nextViewName(prop) {
  const names = new Set((prop.savedViews || []).map(v => v.name.toLowerCase()));
  for (let i = (prop.savedViews || []).length + 1; ; i++) if (!names.has('view ' + i)) return 'View ' + i;
}

// Objects hidden one by one, as a view stores them.
export function hiddenObjects(prop) { return Object.keys(prop.hidden || {}).filter(k => prop.hidden[k] === true); }

// Restore a view's objects hidden one by one: exactly those are hidden, and none for a view saved
// before Tiksi kept the list (each view's own, never the last view's). Returns how many changed.
export function applySavedHidden(prop, view) {
  const want = new Set(Array.isArray(view.hidden) ? view.hidden : []), now = new Set(hiddenObjects(prop));
  let changed = 0;
  for (const k of now) if (!want.has(k)) changed++;
  for (const k of want) if (!now.has(k)) changed++;
  if (!changed) return 0;
  prop.hidden = {};
  for (const k of want) prop.hidden[k] = true;
  return changed;
}

// Which imported models show, as a view stores them.
export function modelState(prop) {
  const out = {};
  for (const s of prop.scans || []) if (s && typeof s.id === 'string' && ID_RE.test(s.id)) out[s.id] = s.visible !== false;
  return out;
}

// A new saved view from the current state; `state` = { camera, mode, section, xray, hiddenLevels,
// models, compare, markers, xrayOpacity, uncertainty }. Tags and hidden objects come from `prop`.
export function addSavedView(prop, name, state) {
  const v = normalizeSavedView({ ...state, name: clean(name) || nextViewName(prop), tags: tagState(prop), hidden: hiddenObjects(prop) }, new Set((prop.savedViews || []).map(x => x.id)));
  if (!v) throw new Error('This view has no usable camera');
  (prop.savedViews = prop.savedViews || []).push(v);
  return v;
}
export function updateSavedView(prop, id, state) {
  const i = (prop.savedViews || []).findIndex(v => v.id === id);
  if (i < 0) return null;
  const v = normalizeSavedView({ ...prop.savedViews[i], ...state, tags: tagState(prop), hidden: hiddenObjects(prop), id: undefined });
  if (!v) return null;
  v.id = id;
  // Updated by hand, a view of the standard set becomes the owner's own: a refresh of the set
  // leaves it as it is (and makes a fresh one of that view beside it).
  delete v.standard;
  prop.savedViews[i] = v;
  return v;
}
// Keep what shows now in view `id`, leaving its camera, mode and name: `state` is what MODEL's
// viewState gives; tags and objects hidden one by one come from `prop`. Returns true when the view
// changed.
const CAMERA_FIELDS = ['camera', 'mode'];
export function keepShowing(prop, id, state) {
  const i = (prop.savedViews || []).findIndex(v => v.id === id);
  if (i < 0) return false;
  const old = prop.savedViews[i], given = { ...state };
  for (const k of CAMERA_FIELDS) delete given[k];
  const v = normalizeSavedView({ ...old, ...given, tags: tagState(prop), hidden: hiddenObjects(prop), id: undefined });
  if (!v) return false;
  v.id = id;
  for (const k of CAMERA_FIELDS) v[k] = old[k];
  if (old.standard) v.standard = old.standard;
  if (JSON.stringify(v) === JSON.stringify(old)) return false;
  prop.savedViews[i] = v;
  return true;
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
