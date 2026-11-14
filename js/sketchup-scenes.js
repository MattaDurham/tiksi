// A SketchUp model's scenes as Tiksi saved views. server/sketchup_convert.py reads each scene's
// camera (in the GLB's frame: metres, Y up) and the tags it hides; the conversion keeps them in the
// GLB, and an older import reads them from its stored original SKP. Each scene becomes a saved view
// (saved-views.js) showing that model as SketchUp drew it (Tiksi's own walls and rooms put away),
// placed through the imported model's own placement, so a model moved or turned in
// Tiksi still opens its scenes where SketchUp had them. A view made from a scene remembers it
// (view.source), so bringing the scenes in again updates those views instead of adding copies.
// Pure data only (no DOM, no three.js), so Node tests run it.
//
// scan.sketchupScenes = [{ name, description?, camera: { eye, target, up, perspective, fov?,
//   fovIsWidth?, aspect?, height? }, hiddenTags: [tag name], useCamera?, useTags? }]
// `fov` is SketchUp's angle in degrees (tall, unless fovIsWidth); `height` is a parallel
// camera's picture height in metres.

import { normalizeSavedView } from './saved-views.js';
import { VFOV_MIN, VFOV_MAX, DEFAULT_VFOV } from './lens.js';

const MAX_SCENES = 100;
const num = v => typeof v === 'number' && Number.isFinite(v) ? v : NaN;
const vec3 = v => Array.isArray(v) && v.length === 3 && v.every(x => Number.isFinite(num(x)) && Math.abs(x) < 1e6) ? v.map(Number) : null;
const text = (v, max) => String(typeof v === 'string' ? v : '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = a => Math.hypot(a[0], a[1], a[2]);
const unit = a => { const l = len(a); return l > 1e-12 ? a.map(x => x / l) : null; };
const along = (p, d, s) => [p[0] + d[0] * s, p[1] + d[1] * s, p[2] + d[2] * s];
const DEG = Math.PI / 180;

// Scenes as the converter wrote them, cleaned: a scene without a usable camera is left out.
export function normalizeScenes(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const s of list.slice(0, MAX_SCENES)) {
    if (!s || typeof s !== 'object') continue;
    const c = s.camera && typeof s.camera === 'object' ? s.camera : {};
    const eye = vec3(c.eye), target = vec3(c.target), up = vec3(c.up);
    if (!eye || !target) continue;
    const camera = { eye, target, up: up && len(up) > 1e-9 ? up : [0, 1, 0], perspective: c.perspective !== false };
    if (camera.perspective) {
      if (num(c.fov) > 0 && num(c.fov) < 180) camera.fov = c.fov;
      if (c.fovIsWidth === true) camera.fovIsWidth = true;
      if (num(c.aspect) > 0) camera.aspect = c.aspect;
    } else if (num(c.height) > 0) camera.height = c.height;
    const scene = { name: text(s.name, 200) || 'Scene ' + (out.length + 1), camera,
      hiddenTags: Array.isArray(s.hiddenTags) ? [...new Set(s.hiddenTags.map(t => text(t, 200)).filter(Boolean))].slice(0, 500) : [] };
    const d = text(s.description, 2000);
    if (d) scene.description = d;
    if (typeof s.useCamera === 'boolean') scene.useCamera = s.useCamera;
    if (typeof s.useTags === 'boolean') scene.useTags = s.useTags;
    out.push(scene);
  }
  return out;
}

// The imported model's placement (scans.js applyScanTransform): position, then rotation (degrees,
// three.js XYZ order), then uniform scale, then the up-axis flip (a half turn about X).
export function placement(scan) {
  const p = Array.isArray(scan.pos) ? scan.pos.map(v => Number(v) || 0) : [0, 0, 0];
  const r = (Array.isArray(scan.rot) ? scan.rot : [0, scan.rotY || 0, 0]).map(v => (Number(v) || 0) * DEG);
  const s = Number(scan.scale) || 1, flip = !!scan.flip;
  const [cx, cy, cz] = r.map(Math.cos), [sx, sy, sz] = r.map(Math.sin);
  // Rx * Ry * Rz, as THREE.Matrix4.makeRotationFromEuler for order XYZ.
  const R = [
    [cy * cz, -cy * sz, sy],
    [cx * sz + sx * sy * cz, cx * cz - sx * sy * sz, -sx * cy],
    [sx * sz - cx * sy * cz, sx * cz + cx * sy * sz, cx * cy],
  ];
  const turn = v => { const w = flip ? [v[0], -v[1], -v[2]] : v; return R.map(row => row[0] * w[0] + row[1] * w[1] + row[2] * w[2]); };
  return { point: v => { const w = turn(v); return [p[0] + s * w[0], p[1] + s * w[1], p[2] + s * w[2]]; }, direction: turn, scale: s };
}

// A scene's camera as a saved view's camera, through a placement (`at`, placement() above; the
// sync file's own frame needs none). `fov` is the angle a parallel camera keeps (a view already
// made from the scene keeps its own). Returns { camera, mode }.
const IDENTITY = { point: v => v.slice(), direction: v => v.slice(), scale: 1 };
export function sceneCamera(c, at = IDENTITY, keepFov) {
  let eye = at.point(c.eye), target = at.point(c.target);
  const dir = unit(sub(target, eye)) || [0, 0, -1];
  if (len(sub(target, eye)) < 0.01) target = along(eye, dir, 1);
  const up = unit(at.direction(c.up || [0, 1, 0])) || [0, 1, 0];
  let fov, parallel = false;
  if (c.perspective !== false) {
    fov = num(c.fov) > 0 ? c.fov : DEFAULT_VFOV;
    // A width angle becomes the height angle for the scene's own picture shape (16:10 if it has none).
    if (c.fovIsWidth) fov = 2 * Math.atan(Math.tan(fov * DEG / 2) / (c.aspect || 1.6)) / DEG;
    fov = Math.min(VFOV_MAX, Math.max(VFOV_MIN, fov));
  } else {
    // Tiksi's parallel camera shows the height its perspective camera sees at the target
    // (viewer3d.js viewCamera): stand back by the distance that makes that the scene's height.
    parallel = true;
    fov = num(keepFov) >= VFOV_MIN && num(keepFov) <= VFOV_MAX ? keepFov : DEFAULT_VFOV;
    const height = (num(c.height) > 0 ? c.height : 5) * at.scale;
    eye = along(target, dir, -(height / 2) / Math.tan(fov * DEG / 2));
  }
  // Straight down is Tiksi's TOP; the camera stands a hair off plumb, toward the bottom of the
  // picture, so the scene's up stays up on the screen.
  const top = dir[1] < -0.9995;
  if (top) {
    const flat = unit([up[0], 0, up[2]]) || [0, 0, -1], d = len(sub(target, eye));
    eye = [target[0] - flat[0] * d * 0.002, target[1] + d, target[2] - flat[2] * d * 0.002];
  }
  return { camera: { position: eye, target, fov, ...(parallel ? { parallel: true } : {}) }, mode: top && parallel ? 'top' : 'orbit' };
}

// The saved view of one scene, through the model's placement. `tagNames` maps a tag name (lower
// case) to the Tiksi tag id; `modelTags` is the set of tag ids this model's parts are on (a tag of
// the model the scene does not hide is shown; any other Tiksi tag is left as it is).
// `levels` are the property's level ids: Tiksi's own walls, floors and rooms are put away in the
// view, as the SKP never had them (a traced wall would stand in front of an elevation the scene
// cut open).
export function sceneView(scene, scan, { tagNames = new Map(), modelTags = new Set(), levels = [] } = {}) {
  const { camera, mode } = sceneCamera(scene.camera, placement(scan));
  const tags = {};
  if (scene.useTags !== false) {
    const hidden = new Set(scene.hiddenTags.map(n => tagNames.get(n.toLowerCase())).filter(Boolean));
    for (const id of new Set([...modelTags, ...hidden])) tags[id] = !hidden.has(id);
  }
  return {
    name: scene.name, camera, mode, tags, models: { [scan.id]: true }, hiddenLevels: levels,
    source: { app: 'sketchup', scan: scan.id, scene: scene.name },
  };
}

// Make or update the saved views of every scene of `scan` (scan.sketchupScenes). A view made from
// a scene before is updated where it stands in the list and keeps its id; new scenes are added at
// the end, in SketchUp's order. `tagOf` (prop.tagOf) says which tags the model's parts are on.
// Returns { added, updated, skipped } (skipped: no room left, a property keeps at most 100 views).
export function bringInScenes(prop, scan) {
  const scenes = normalizeScenes(scan.sketchupScenes);
  const tagNames = new Map();
  for (const t of prop.tags || []) if (t && t.id && typeof t.name === 'string' && !tagNames.has(t.name.trim().toLowerCase())) tagNames.set(t.name.trim().toLowerCase(), t.id);
  const prefix = 'node:' + scan.id + '#', modelTags = new Set();
  for (const [k, id] of Object.entries(prop.tagOf || {})) if (k.startsWith(prefix) && typeof id === 'string') modelTags.add(id);
  const list = prop.savedViews = Array.isArray(prop.savedViews) ? prop.savedViews : [];
  const taken = new Set(list.map(v => v.id));
  let added = 0, updated = 0, skipped = 0;
  for (const scene of scenes) {
    const raw = sceneView(scene, scan, { tagNames, modelTags, levels: (prop.levels || []).map(l => l && l.id).filter(id => typeof id === 'string') });
    const i = list.findIndex(v => v.source && v.source.app === 'sketchup' && v.source.scan === scan.id && v.source.scene === scene.name);
    if (i >= 0) {
      const v = normalizeSavedView({ ...raw, id: list[i].id }, new Set());
      if (v) { list[i] = v; updated++; }
      continue;
    }
    if (list.length >= 100) { skipped++; continue; }
    const v = normalizeSavedView(raw, taken);
    if (v) { taken.add(v.id); list.push(v); added++; }
  }
  return { added, updated, skipped };
}

// How many of `scan`'s scenes have a saved view now.
export function scenesShown(prop, scan) {
  const names = new Set((prop.savedViews || []).filter(v => v.source && v.source.app === 'sketchup' && v.source.scan === scan.id).map(v => v.source.scene));
  return normalizeScenes(scan.sketchupScenes).filter(s => names.has(s.name)).length;
}
