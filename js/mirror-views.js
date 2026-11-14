// Saved views in the SketchUp sync file (sketchup-mirror.js), as SketchUp scenes. Each saved view
// is written as a scene: its camera (perspective or parallel), the tags it hides (a hidden level
// is its level's "Tiksi: <level>" tag) and its section cut (the active cut, as a SketchUp section
// plane). The scene keeps the view's id in its "tiksi" dictionary with the values it was written
// from, so reading the file back after a save in SketchUp tells what SketchUp changed:
// a scene moved, renamed or given other tags or another cut updates its view; a scene added in
// SketchUp becomes a new view; a scene deleted there deletes its view. The ownership rule is the
// walls' (sketchup-mirror.js mergeMirror): what both sides agreed on last decides, and when both
// changed one view Tiksi keeps its version.
//
// A view made from an imported model's own scenes (sketchup-scenes.js, source.app 'sketchup')
// belongs to that model, not to the sync file, and is not written. Pure data only.

import { tagById } from './tags.js';
import { planeNormal } from './section-planes.js';
import { sceneCamera } from './sketchup-scenes.js';
import { normalizeSavedView } from './saved-views.js';
import { DEFAULT_VFOV } from './lens.js';

const DEG = Math.PI / 180;
export const PARALLEL_BACK = 100;   // m (328'-1"): how far back a parallel scene's camera stands
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = a => { const l = Math.hypot(...a); return l > 1e-12 ? a.map(x => x / l) : null; };
const r6 = v => Math.round(v * 1e6) / 1e6 + 0;
const mm = v => Math.round(v * 1000);
const e4 = v => Math.round(v * 1e4) + 0;
const text = (v, max) => String(typeof v === 'string' ? v : '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

export const levelTagName = level => 'Tiksi: ' + (level.name || level.id);

export function mirrorsView(v) { return !!(v && v.camera && !(v.source && v.source.app === 'sketchup')); }

// The names SketchUp knows for the things a view can hide: Tiksi's tags and the level tags.
function knownNames(prop) {
  const tags = new Map(), levels = new Map();
  for (const t of prop.tags || []) { const n = text(t && t.name, 120); if (n && !tags.has(n)) tags.set(n, t.id); }
  for (const l of prop.levels || []) if (l && l.id) levels.set(levelTagName(l), l.id);
  return { tags, levels };
}

// A view as the sync file carries it: { name, perspective, eye, target, fov | height, hidden,
// cut: { point, normal } | null }, world metres. `normal` points at what the cut takes away.
export function viewForm(prop, v) {
  const c = v.camera, eye = c.position.slice(), target = c.target.slice();
  const parallel = c.parallel === true, fov = Number(c.fov) || DEFAULT_VFOV;
  const form = { name: text(v.name, 200) || 'View', perspective: !parallel, eye, target };
  if (parallel) form.height = r6(2 * Math.hypot(...sub(eye, target)) * Math.tan(fov * DEG / 2));
  else form.fov = r6(fov);
  const hidden = [];
  for (const [id, on] of Object.entries(v.tags || {})) { const t = on === false && tagById(prop, id); if (t && text(t.name, 120)) hidden.push(text(t.name, 120)); }
  for (const id of v.hiddenLevels || []) { const l = (prop.levels || []).find(x => x.id === id); if (l) hidden.push(levelTagName(l)); }
  form.hidden = [...new Set(hidden)].sort();
  const s = v.section || {}, plane = s.on && (s.planes || []).find(p => p.id === s.active) || (s.on && (s.planes || [])[0]);
  form.cut = plane ? { point: plane.pos.slice(), normal: planeNormal(plane.q).map(r6) } : null;
  return form;
}

// Compared to 1 mm, the direction to 1/10,000 and the angle to 1/100 degree: finer than any change
// made on purpose, coarser than what SketchUp's own rounding changes. A parallel view's place
// along its line of sight changes nothing in the picture, so it is not compared.
export function viewSig(f) {
  if (!f || !Array.isArray(f.eye) || !Array.isArray(f.target)) return 'view|0.1mm';
  // Tiksi's TOP leans a hair off plumb to keep north up (viewer3d.js presetView); SketchUp's
  // looks straight down. Both are straight down here.
  let d = unit(sub(f.target, f.eye)) || [0, 0, -1];
  if (Math.abs(d[1]) > 0.9995) d = [0, Math.sign(d[1]), 0];
  const dir = d.map(e4);
  const cut = f.cut && Array.isArray(f.cut.normal) && Array.isArray(f.cut.point)
    ? [...f.cut.normal.map(e4), mm(dot(f.cut.normal, f.cut.point))] : null;
  const where = f.perspective === false ? [...f.target.map(mm), mm(f.height || 0)] : [...f.eye.map(mm), Math.round((f.fov || 0) * 100)];
  return 'view,' + JSON.stringify([f.name || '', f.perspective === false, ...where, ...dir, [...(f.hidden || [])].sort(), cut]) + '|0.1mm';
}

// The scene Tiksi writes for a view: the camera with an up SketchUp can use (straight down:
// the top of the picture is the way the camera leans, else north), the tags it hides, its cut,
// and the scene it was made from (a new view of a scene added in SketchUp, so the write tags
// that scene instead of adding another).
export function viewScene(prop, v) {
  const f = viewForm(prop, v);
  const dir = unit(sub(f.target, f.eye)) || [0, 0, -1];
  let up = [0, 1, 0];
  if (Math.abs(dir[1]) > 0.9995) {
    const n = (Number(prop.env && prop.env.north) || 0) * DEG;
    up = unit([dir[0], 0, dir[2]]) || [Math.sin(n), 0, -Math.cos(n)];
    if (dir[1] > 0) up = up.map(x => -x);
  }
  // A parallel scene's camera stands well back, outside the model and past any cut, as SketchUp
  // saves its own elevations; how far back changes nothing in a parallel picture.
  const back = f.perspective ? f.eye : f.target.map((t, i) => t - dir[i] * Math.max(PARALLEL_BACK, Math.hypot(...sub(f.target, f.eye))));
  const camera = { eye: back.map(r6), target: f.target.map(r6), up: up.map(r6), perspective: f.perspective };
  if (f.perspective) camera.fov = f.fov; else camera.height = f.height;
  return { id: v.id, name: f.name, camera, hidden: f.hidden, cut: f.cut, ...(v.source && v.source.app === 'sketchup-sync' ? { scene: v.source.scene } : {}), base: f };
}

// A scene as server/sketchup_mirror.py reads it, in the same form as viewForm (names it does not
// know as Tiksi's are left out of `hidden`). `useCut`: the scene's cut is Tiksi's to read (a scene
// Tiksi made); in one made in SketchUp the cut stays SketchUp's and is not compared.
export function sceneForm(prop, scene) {
  const c = scene.camera || {}, { tags, levels } = knownNames(prop);
  const form = { name: text(scene.name, 200) || 'Scene', perspective: c.perspective !== false, eye: c.eye, target: c.target };
  if (form.perspective) {
    let fov = Number(c.fov) > 0 ? c.fov : DEFAULT_VFOV;
    if (c.fovIsWidth) fov = 2 * Math.atan(Math.tan(fov * DEG / 2) / (c.aspect || 1.6)) / DEG;
    form.fov = r6(fov);
  } else form.height = r6(Number(c.height) || 0);
  form.hidden = [...new Set((scene.hiddenTags || []).map(n => text(n, 120)).filter(n => tags.has(n) || levels.has(n)))].sort();
  form.cut = scene.origin === 'tiksi' && scene.cut && Array.isArray(scene.cut.normal) ? { point: scene.cut.point, normal: scene.cut.normal.map(r6) } : null;
  return form;
}

// Turn a cut's direction into the quaternion section-planes.js keeps (its +Z onto `n`).
function quatTo(n) {
  if (n[2] < -0.999999) return [1, 0, 0, 0];
  const q = [-n[1], n[0], 0, 1 + n[2]], l = Math.hypot(...q);
  return q.map(x => r6(x / l));
}

// `view` changed to what the scene shows now (`now`, a sceneForm) where it differs from what was
// written (`base`). Its id and everything SketchUp does not hold (x-ray, models, pins) stay.
export function applySceneToView(prop, view, scene, now, base) {
  const out = JSON.parse(JSON.stringify(view));
  base = base || {};
  if (now.name !== base.name) out.name = text(now.name, 60) || out.name;
  if (viewSig({ ...now, name: '', hidden: [], cut: null }) !== viewSig({ ...base, name: '', hidden: [], cut: null })) {
    const { camera, mode } = sceneCamera(scene.camera, undefined, view.camera && view.camera.fov);
    out.camera = { ...camera, position: camera.position.map(r6), target: camera.target.map(r6) };
    out.mode = mode;
  }
  const same = (a, b) => JSON.stringify([...(a || [])].sort()) === JSON.stringify([...(b || [])].sort());
  if (!same(now.hidden, base.hidden)) {
    const { tags, levels } = knownNames(prop), hidden = new Set(now.hidden);
    out.tags = { ...(out.tags || {}) };
    for (const n of new Set([...(base.hidden || []), ...now.hidden])) if (tags.has(n)) out.tags[tags.get(n)] = !hidden.has(n);
    out.hiddenLevels = [...levels].filter(([n]) => hidden.has(n)).map(([, id]) => id);
  }
  if (scene.origin === 'tiksi' && JSON.stringify(now.cut) !== JSON.stringify(base.cut) && viewSig({ eye: [0, 0, 0], target: [0, 0, 1], cut: now.cut }) !== viewSig({ eye: [0, 0, 0], target: [0, 0, 1], cut: base.cut })) {
    const s = out.section = { ...(out.section || { on: false, height: 1.2 }) };
    if (!now.cut) s.on = false;
    else {
      const n = unit(now.cut.normal) || [0, 1, 0], planes = (s.planes || []).map(p => ({ ...p }));
      let p = planes.find(x => x.id === s.active) || planes[0];
      if (!p) { p = { id: 'cut-sync-' + view.id.slice(-12).replace(/[^\w-]/g, ''), kind: 'custom', q: [0, 0, 0, 1], pos: now.cut.point.slice() }; planes.unshift(p); }
      // On the new plane, as near the old place as it goes, so the handles stay where they were.
      const off = dot(n, now.cut.point) - dot(n, p.pos);
      p.pos = p.pos.map((x, i) => r6(x + n[i] * off));
      p.q = quatTo(n);
      p.kind = n[1] > 0.9999 ? 'level' : p.kind === 'level' ? 'custom' : p.kind;
      s.planes = planes; s.active = p.id; s.on = true;
      if (typeof s.done !== 'boolean') s.done = true;
    }
  }
  return normalizeSavedView({ ...out, id: view.id }, new Set()) || view;
}

// A new saved view from a scene added in SketchUp.
export function viewFromScene(prop, scene, id, taken) {
  const now = sceneForm(prop, scene);
  const { camera, mode } = sceneCamera(scene.camera);
  const { tags, levels } = knownNames(prop), hidden = new Set(now.hidden);
  const v = { name: text(now.name, 60), camera, mode, tags: {}, section: { on: false, height: 1.2 }, xray: false,
    hiddenLevels: [...levels].filter(([n]) => hidden.has(n)).map(([, l]) => l), source: { app: 'sketchup-sync', scene: now.name } };
  for (const [n, t] of tags) v.tags[t] = !hidden.has(n);
  if (id) v.id = id;
  // A standard scene a build script added (server/standard_scenes.py) is a view of the set.
  const st = scene.base && scene.base.standard;
  if (st && typeof st.key === 'string') { v.standard = { key: st.key, name: v.name }; delete v.source; }
  return normalizeSavedView(v, taken);
}
