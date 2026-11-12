// The objects of an imported model, the way SketchUp's Outliner lists them: a click picks a
// whole object (a chair, a cabinet), never one of the meshes it happens to be drawn with, and
// a double-click goes one object further in (a cabinet's hinge, the hinge's screw).
//
// A model's meshes are its drawable parts (tags-scene.js modelParts); tags and hiding are kept
// per mesh. An object gathers the meshes that belong together:
//   component  a SketchUp component instance (model-components.js isInstanceNode) with every
//              mesh and nested object under it
//   group      a named node of any other file that holds meshes or objects
//   part       meshes that share a name under one parent: the converter writes a SketchUp
//              group as one mesh per material, all carrying the group's name
// Meshes named after the component they sit in are that component's own faces, not objects.
//
// Each object: { key (tag key of its node, or of its first mesh), path, kind, name, component
// (definition name), nodes (what moves when it moves), meshes, meshKeys (every mesh under it,
// nested ones included), parent, children }.
//
// Moving: scan.partOffsets = { '<path>': [x, y, z] } holds how far an object was moved from
// where the file has it, in metres in the model's own frame (before the model's position,
// rotation and scale). applyPartOffsets puts every moved object there; it runs wherever a model
// is placed (scans.js applyScanTransform), so MODEL, DOCUMENTS, PLAN and exports agree.
// No DOM here; Node tests run it.

import * as THREE from 'three';
import { nodeKey } from './tags.js';
import { nodeName } from './tags-scene.js';
import { isInstanceNode } from './model-components.js';

const PATH_RE = /^(\*|\d{1,6}(?:\/\d{1,6}){0,63})$/;
const MAX_OFFSETS = 20000, MAX_REACH = 100000;   // objects moved in one model; metres

const trees = new WeakMap();   // wrapper -> tree
// The tree of a loaded model (the wrapper from scans.js loadScanObject), built once per load:
//   { scanId, roots, byKey: Map(key -> object), ofMesh: Map(mesh -> innermost object),
//     ofNode: Map(a component's or group's node -> its object),
//     whole: the model is a single object (a scan mesh, a point cloud, one solid) }
export function modelObjectTree(wrapper) {
  let t = wrapper && trees.get(wrapper);
  if (!t && wrapper) { t = buildTree(wrapper); trees.set(wrapper, t); }
  return t || { scanId: '', roots: [], byKey: new Map(), ofMesh: new Map(), ofNode: new Map(), whole: true };
}
export function forgetObjectTree(wrapper) { if (wrapper) trees.delete(wrapper); }

function buildTree(wrapper) {
  const scanId = wrapper.userData.id, inner = wrapper.userData.inner;
  const tree = { scanId, roots: [], byKey: new Map(), ofMesh: new Map(), ofNode: new Map(), whole: true };
  if (!inner) return tree;
  const make = (fields, parent) => ({ key: nodeKey(scanId, fields.path), component: '', nodes: [], meshes: [], meshKeys: [], children: [], parent: parent || null, ...fields });
  const kind = wrapper.userData.scanKind;
  if (kind === 'points' || kind === 'splat') {
    const o = make({ path: '*', kind: 'part', name: wrapper.name.replace(/^scan:/, ''), nodes: [inner] }, null);
    o.meshes.push(inner); o.meshKeys.push(o.key);
    tree.roots.push(o);
    return finish(tree);
  }
  const addMesh = (owner, mesh, path) => {
    const key = nodeKey(scanId, path);
    tree.ofMesh.set(mesh, owner);
    for (let o = owner; o; o = o.parent) { o.meshes.push(mesh); o.meshKeys.push(key); }
  };
  // A group whose children are all bare meshes is one thing drawn in several materials (a glTF
  // mesh with several primitives loads that way): its meshes are its own, not objects inside it.
  const onlyMeshes = n => n.children.length > 0 && n.children.every(c => c.isMesh && !isInstanceNode(c) && !c.children.length);
  const walk = (node, path, parent, list, ownName) => {
    const loose = new Map();   // name -> the part object gathering this level's meshes of that name
    node.children.forEach((c, i) => {
      const p = path ? path + '/' + i : String(i);
      if (isInstanceNode(c)) {
        const u = c.userData;
        const o = make({ path: p, kind: 'component', name: (typeof u.sketchupInstanceName === 'string' && u.sketchupInstanceName.trim()) || u.sketchupComponent, component: u.sketchupComponent, nodes: [c] }, parent);
        list.push(o);
        if (c.isMesh) addMesh(o, c, p);
        walk(c, p, o, o.children, u.sketchupComponent);
        return;
      }
      if (c.isMesh) {
        const name = nodeName(c) || 'Part';
        let owner = parent && (ownName === null || name === ownName) ? parent : null;
        if (!owner) {
          owner = loose.get(name);
          if (!owner) { owner = make({ path: p, kind: 'part', name }, parent); loose.set(name, owner); list.push(owner); }
          owner.nodes.push(c);
        }
        addMesh(owner, c, p);
        if (c.children.length) walk(c, p, owner, owner.children, null);
        return;
      }
      if (!c.children.length) return;
      const name = nodeName(c);
      if (!name) { walk(c, p, parent, list, ownName); return; }   // a nameless holder: look through it
      const o = make({ path: p, kind: 'group', name, nodes: [c] }, parent);
      list.push(o);
      walk(c, p, o, o.children, onlyMeshes(c) ? null : undefined);
    });
  };
  walk(inner, '', null, tree.roots, undefined);
  // Objects that draw nothing (empty holders, cameras) are not objects.
  const prune = list => { for (let i = list.length - 1; i >= 0; i--) { if (!list[i].meshes.length) list.splice(i, 1); else prune(list[i].children); } };
  prune(tree.roots);
  // A file wrapped in one holder (glTF's scene node, a single top group): its contents are the
  // model's objects. A lone top component stays: it is a real object with a definition.
  while (tree.roots.length === 1 && tree.roots[0].kind === 'group' && tree.roots[0].children.length) {
    tree.roots = tree.roots[0].children;
    for (const o of tree.roots) o.parent = null;
  }
  return finish(tree);
}
function finish(tree) {
  const index = list => { for (const o of list) { tree.byKey.set(o.key, o); if (o.kind !== 'part') tree.ofNode.set(o.nodes[0], o); index(o.children); } };
  index(tree.roots);
  tree.whole = tree.roots.length <= 1 && (!tree.roots[0] || !tree.roots[0].children.length);
  return tree;
}

// From the outermost object around a mesh down to the innermost.
export function objectChain(tree, mesh) {
  const chain = [];
  for (let o = tree.ofMesh.get(mesh); o; o = o.parent) chain.unshift(o);
  return chain;
}
// The object a click on `mesh` picks. Normally the outermost one. While the current selection
// sits inside another object (after a double-click went in), a click on something else inside
// that same object picks at the same depth, as inside an opened group in SketchUp.
export function objectForClick(tree, mesh, currentKey) {
  const chain = objectChain(tree, mesh);
  if (!chain.length) return null;
  const cur = currentKey && tree.byKey.get(currentKey);
  if (cur && cur.parent) { const i = chain.indexOf(cur.parent); if (i >= 0 && chain[i + 1]) return chain[i + 1]; }
  return chain[0];
}
// The object a double-click on `mesh` picks: one further in than the current selection.
export function objectBelow(tree, mesh, currentKey) {
  const chain = objectChain(tree, mesh);
  if (!chain.length) return null;
  const cur = currentKey && tree.byKey.get(currentKey);
  const i = cur ? chain.indexOf(cur) : -1;
  return i >= 0 ? (chain[i + 1] || cur) : chain[0];
}
// How many objects share a component's definition, and which number this one is among them.
export function sameComponent(tree, object) {
  if (!object || object.kind !== 'component') return [];
  const def = n => (n.userData.sketchupDefinitionId || '') + '|' + n.userData.sketchupComponent;
  const want = def(object.nodes[0]);
  return [...tree.byKey.values()].filter(o => o.kind === 'component' && def(o.nodes[0]) === want);
}
// A label for what an object is.
export const KIND_LABELS = { component: 'Component', group: 'Group', part: 'Part' };

// ---------- moving an object ----------
const bases = new WeakMap();   // node -> its position as the file has it
const moved = new WeakMap();   // wrapper -> Set of nodes standing off their base

function cleanOffset(v) {
  if (!Array.isArray(v) || v.length !== 3) return null;
  const out = v.map(Number);
  if (!out.every(n => Number.isFinite(n) && Math.abs(n) <= MAX_REACH)) return null;
  return out.every(n => Math.abs(n) < 1e-6) ? null : out;
}
// scan.partOffsets as safe data: { path: [x, y, z] } with real paths and finite distances.
export function partOffsets(scan) {
  const out = {};
  const given = scan && scan.partOffsets;
  if (!given || typeof given !== 'object' || Array.isArray(given)) return out;
  let n = 0;
  for (const [path, v] of Object.entries(given)) {
    if (n >= MAX_OFFSETS) break;
    const off = PATH_RE.test(path) && path !== '*' ? cleanOffset(v) : null;
    if (off) { out[path] = off; n++; }
  }
  return out;
}
export function objectOffset(scan, object) {
  return (object && partOffsets(scan)[object.path]) || [0, 0, 0];
}
// Record how far an object stands from where the file has it ([0, 0, 0] puts it back).
export function setObjectOffset(scan, object, offset) {
  const all = partOffsets(scan);
  const off = cleanOffset(offset);
  if (off) all[object.path] = off; else delete all[object.path];
  if (Object.keys(all).length) scan.partOffsets = all; else delete scan.partOffsets;
}

const _rel = new THREE.Matrix4(), _inv = new THREE.Matrix4(), _v = new THREE.Vector3();
// A distance in the model's own frame, as a distance in the frame `node` is placed in.
function toParentFrame(node, inner, offset) {
  _rel.identity();
  const up = [];
  for (let p = node.parent; p && p !== inner; p = p.parent) up.push(p);
  for (let i = up.length - 1; i >= 0; i--) { up[i].updateMatrix(); _rel.multiply(up[i].matrix); }
  // The direction part only, at full length (transformDirection would normalise it).
  const e = _inv.copy(_rel).invert().elements, [x, y, z] = offset;
  return _v.set(e[0] * x + e[4] * y + e[8] * z, e[1] * x + e[5] * y + e[9] * z, e[2] * x + e[6] * y + e[10] * z);
}

// Put every object of a loaded model where scan.partOffsets says. Safe to call again and
// again: an object goes back to the file's position first. Returns the meshes whose place
// changed (so grouped drawing can follow), empty when nothing moved.
export function applyPartOffsets(scan, wrapper) {
  const inner = wrapper && wrapper.userData && wrapper.userData.inner;
  if (!inner || wrapper.userData.scanKind !== 'mesh') return [];
  const offsets = partOffsets(scan);
  const was = moved.get(wrapper);
  if (!Object.keys(offsets).length && !(was && was.size)) return [];
  const tree = modelObjectTree(wrapper);
  const changed = new Set();
  const now = new Set();
  // Back to the file's positions, then out again: an offset that was removed is undone.
  if (was) for (const node of was) { const b = bases.get(node); if (b && !node.position.equals(b)) { node.position.copy(b); changed.add(node); } }
  for (const [path, off] of Object.entries(offsets)) {
    const object = tree.byKey.get(nodeKey(scan.id, path));
    if (!object) continue;
    for (const node of object.nodes) {
      if (!bases.has(node)) bases.set(node, node.position.clone());
      node.position.add(toParentFrame(node, inner, off));
      now.add(node); changed.add(node);
    }
  }
  moved.set(wrapper, now);
  const meshes = [];
  for (const node of changed) { node.updateMatrix(); node.traverse(m => { if (m.isMesh) meshes.push(m); }); }
  if (changed.size) inner.updateMatrixWorld(true);
  return meshes;
}

// The box around an object in world space (for framing it and for the move handle).
export function objectBox(object, box = new THREE.Box3()) {
  box.makeEmpty();
  for (const m of object.meshes) {
    if (!m.geometry) { box.expandByObject(m); continue; }
    if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
    m.updateWorldMatrix(true, false);
    box.union(_box.copy(m.geometry.boundingBox).applyMatrix4(m.matrixWorld));
  }
  return box;
}
const _box = new THREE.Box3();
