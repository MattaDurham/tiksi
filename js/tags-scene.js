// Tags on scene objects (see js/tags.js for the records): which key a mesh answers to, the
// automatic tag of an imported model's meshes, and showing or hiding meshes by tag. Used by
// MODEL (viewer3d.js), DOCUMENTS (sheet-render.js), the plan model (geometry.js) and exports.

import { planKey, nodeKey, keyShown, tagIdOf, tagById, detectTag, tagForDetection, levelFor, PLAN_KINDS } from './tags.js';
import { scanLayer } from './view-layers.js';

const PLAN = new Set(Object.keys(PLAN_KINDS).filter(k => k !== 'furniture'));

// The key of a plan mesh: its nearest ancestor (or itself) that names a plan element.
export function planKeyOf(o) {
  for (let p = o; p; p = p.parent) {
    const u = p.userData;
    if (u && PLAN.has(u.kind) && u.id) return planKey(u.kind, u.id);
    if (u && u.kind === 'scan') return null;
  }
  return null;
}

// The drawable parts of a loaded model (the wrapper from scans.js loadScanObject): one entry per
// mesh with its path of child indices below the wrapper's inner group. A point cloud or splat
// is one part, '*'.
export function modelParts(wrapper) {
  const inner = wrapper && wrapper.userData && wrapper.userData.inner;
  if (!inner) return [];
  const kind = wrapper.userData.scanKind;
  if (kind === 'points' || kind === 'splat') return [{ path: '*', object: inner, names: [wrapper.name.replace(/^scan:/, '')] }];
  const out = [];
  const walk = (o, path) => {
    o.children.forEach((c, i) => {
      const p = path ? path + '/' + i : String(i);
      if (c.isMesh) out.push({ path: p, object: c });
      walk(c, p);
    });
  };
  walk(inner, '');
  return out;
}
export function partKey(scanId, part) { return nodeKey(scanId, part.path); }

// The key under a raycast hit on a model, or null.
export function partKeyForObject(wrapper, object) {
  if (!wrapper || !object) return null;
  for (const part of modelParts(wrapper)) {
    if (part.object === object) return partKey(wrapper.userData.id, part);
    if (part.path === '*') return partKey(wrapper.userData.id, part);
  }
  return null;
}
export function partByKey(wrapper, key) {
  return modelParts(wrapper).find(p => partKey(wrapper.userData.id, p) === key) || null;
}

// A node's name as the file wrote it (GLTFLoader keeps it in userData.name; `name` has its
// spaces turned into underscores).
export const nodeName = o => (o.userData && typeof o.userData.name === 'string' && o.userData.name) || o.name || '';
// A part's display name: the nearest named node, as the file named it.
export function partName(part) {
  for (let o = part.object; o; o = o.parent) {
    if (o.userData && o.userData.inner === o) break;
    const n = nodeName(o);
    if (n && n !== 'inner') return n;
  }
  return (part.names && part.names[0]) || 'Part';
}

// The tag a file gave a mesh: SketchUp's tag (server/sketchup_convert.py writes it into the
// GLB node's extras) or the Tiksi tag of an exported model.
function fileTagOf(o) {
  for (let p = o; p; p = p.parent) {
    const u = p.userData || {};
    if (typeof u.sketchupTag === 'string' && u.sketchupTag.trim()) return u.sketchupTag;
    if (typeof u.tiksiTag === 'string' && u.tiksiTag.trim()) return u.tiksiTag;
    if (u.inner === p) break;
  }
  return '';
}

// Face areas of a mesh by facing, in world space; large meshes are sampled.
const MAX_TRIANGLES = 20000;
export function meshStats(mesh) {
  const g = mesh.geometry, pos = g && g.getAttribute('position');
  if (!pos) return null;
  mesh.updateWorldMatrix(true, false);
  const e = mesh.matrixWorld.elements, idx = g.index;
  const tris = idx ? idx.count / 3 : pos.count / 3;
  const step = Math.max(1, Math.ceil(tris / MAX_TRIANGLES));
  const W = i => { const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i); return [e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]]; };
  const s = { area: 0, up: 0, down: 0, vertical: 0, sloped: 0, y0: Infinity, y1: -Infinity };
  for (let i = 0; i < pos.count; i += Math.max(1, step)) {
    const y = e[1] * pos.getX(i) + e[5] * pos.getY(i) + e[9] * pos.getZ(i) + e[13];
    if (y < s.y0) s.y0 = y;
    if (y > s.y1) s.y1 = y;
  }
  for (let t = 0; t < tris; t += step) {
    const a = W(idx ? idx.getX(3 * t) : 3 * t), b = W(idx ? idx.getX(3 * t + 1) : 3 * t + 1), c = W(idx ? idx.getX(3 * t + 2) : 3 * t + 2);
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (!(len > 0)) continue;
    const area = len / 2, k = ny / len;
    s.area += area;
    // Double-sided SketchUp faces may wind either way: up and down both count as horizontal.
    if (k > 0.85) s.up += area; else if (k < -0.85) s.down += area;
    else if (Math.abs(k) < 0.3) s.vertical += area; else s.sloped += area;
  }
  return s.area > 0 ? s : null;
}

// Assign every part of a loaded model that has no tag yet (see tags.js detectTag). The model's
// transform must be applied (scans.js applyScanTransform). Returns how many parts it assigned.
export function detectModelTags(prop, scan, wrapper, { again = false } = {}) {
  if (again) for (const k of Object.keys(prop.tagOf || {})) if (k.startsWith('node:' + scan.id + '#')) delete prop.tagOf[k];
  const parts = modelParts(wrapper);
  if (!parts.length) return 0;
  const record = scanLayer(scan);
  prop.tagOf = prop.tagOf || {};
  let n = 0;
  for (const part of parts) {
    const key = partKey(scan.id, part);
    if (prop.tagOf[key] !== undefined) continue;
    const names = [];
    for (let o = part.object; o && !(o.userData && o.userData.inner === o); o = o.parent) if (nodeName(o)) names.push(nodeName(o));
    let stats = null, level = null;
    if (record === 'model' && part.object.isMesh) {
      stats = meshStats(part.object);
      level = levelFor(prop.levels, stats ? stats.y0 : 0);
    }
    const d = detectTag({ fileTag: fileTagOf(part.object), names, stats, level, record });
    prop.tagOf[key] = tagForDetection(prop, d);
    n++;
  }
  return n;
}

// Show or hide a loaded model's parts by tag. `overrides` is a viewport's own visibility.
export function applyModelTagVisibility(prop, scan, wrapper, overrides) {
  for (const part of modelParts(wrapper)) part.object.visible = keyShown(prop, partKey(scan.id, part), overrides);
}

// Show or hide the plan model's meshes (geometry.js buildPropertyGroup) by tag.
export function applyPlanTagVisibility(prop, root, overrides) {
  root.traverse(o => {
    if (!o.isMesh && !o.isLine && !o.isLineSegments) return;
    const key = planKeyOf(o);
    if (key) o.visible = keyShown(prop, key, overrides);
  });
}

// Stamp each mesh with its tag's name, so exports carry tags (GLB extras, SketchUp tags).
export function stampTags(prop, root, scanOf) {
  root.traverse(o => {
    if (!o.isMesh) return;
    let key = planKeyOf(o);
    if (!key && scanOf) key = scanOf(o);
    if (!key) return;
    const t = tagById(prop, tagIdOf(prop, key));
    if (t) { o.userData.tiksiTag = t.name; o.userData.tiksiTagVisible = t.visible !== false; }
  });
}
