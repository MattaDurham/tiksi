// What is under the pointer, without testing every triangle or point.
//
// three tests a ray against every triangle of a mesh and every point of a cloud. On a scan of
// several hundred thousand triangles that is the whole cost of a click, a tap, the start of a
// zoom and every measure point. indexForPicking(object) gives a large mesh or point cloud a
// tree of boxes over its triangles (or points), built once, and a raycast that walks only the
// boxes the ray passes through. The hits it reports are the ones three would report: the same
// points, distances, faces and side rules, so nothing that reads a hit changes.
//
// Small geometry keeps three's own test: below INDEX_MIN items the tree costs more than it saves.
import * as THREE from 'three';

import { walkRay, triangleTreeFrom, pointTreeFrom } from './pick-tree.js';
export { buildTree, walkRay } from './pick-tree.js';

export const INDEX_MIN = 20000;     // triangles or points; below this three's own test is used

const _inverse = new THREE.Matrix4(), _ray = new THREE.Ray(), _sphere = new THREE.Sphere();
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _hit = new THREE.Vector3(), _world = new THREE.Vector3();

// ---------- the trees ----------
// A tree is kept on its geometry (geometry.userData.pickTree), stamped with the versions of the
// vertices it was built from, and made again if they are replaced. Building one for a large
// scan takes the better part of a second, so the background helper (pick-worker.js) does it
// and the page never waits: until a tree has arrived, a ray is tested three's own way, exactly
// as before there was an index. Where no helper can start, the page builds the tree itself the
// first time a ray needs it.
let helper = null, helperBroken = false, buildId = 0;
const building = new Map();   // build id -> { geometry, stamp }
function helperReady() {
  if (helper) return true;
  if (helperBroken || typeof Worker !== 'function') return false;
  try { helper = new Worker(new URL('./pick-worker.js', import.meta.url), { type: 'module' }); }
  catch (e) { helperBroken = true; return false; }
  helper.onmessage = e => {
    const d = e.data, job = building.get(d.id);
    building.delete(d.id);
    if (!job) return;
    const kept = job.geometry.userData.pickTree;
    if (!kept || kept.stamp !== job.stamp || kept.tree) return;     // replaced, or disposed, meanwhile
    if (d.ok) kept.tree = { box: d.box, a: d.a, b: d.b, order: d.order, nodes: d.nodes };
    else { console.error('pick index: the helper could not build a tree', d.error); delete job.geometry.userData.pickTree; }
  };
  helper.onerror = err => {
    if (err && err.preventDefault) err.preventDefault();
    helperBroken = true;
    try { helper.terminate(); } catch (e) { /* already gone */ }
    helper = null;
    // The trees it was building are built by the page when a ray next needs them.
    for (const job of building.values()) delete job.geometry.userData.pickTree;
    building.clear();
  };
  return true;
}
// How many trees the helper is still building (MODEL waits for none of them; the checks do).
export function pendingPickBuilds() { return building.size; }

function stampOf(geometry) {
  const pos = geometry.getAttribute('position'), index = geometry.index;
  return pos.version + ':' + pos.count + ':' + (index ? index.version + ':' + index.count : '');
}
function buildNow(geometry, points) {
  const pos = geometry.getAttribute('position'), index = geometry.index;
  if (points) return pointTreeFrom(pos.array, pos.count);
  const interleaved = pos.isInterleavedBufferAttribute;
  return triangleTreeFrom(pos.array, interleaved ? pos.data.stride : 3, interleaved ? pos.offset : 0, index ? index.array : null, pos.count);
}
// The geometry's tree if there is one now, else null (and the helper is asked for it, once).
// With no helper the page builds it here, so there is always one to return.
function treeOf(geometry, points) {
  const stamp = stampOf(geometry);
  const kept = geometry.userData.pickTree;
  if (kept && kept.stamp === stamp) return kept.tree || null;
  if (!helperReady()) {
    const tree = buildNow(geometry, points);
    geometry.userData.pickTree = { stamp, tree };
    return tree;
  }
  // The helper gets its own copy of the vertices: the page keeps drawing from its own.
  const pos = geometry.getAttribute('position'), index = geometry.index, interleaved = pos.isInterleavedBufferAttribute;
  const positions = pos.array.slice(), indices = !points && index ? index.array.slice() : null;
  const id = ++buildId;
  geometry.userData.pickTree = { stamp, tree: null };
  building.set(id, { geometry, stamp });
  helper.postMessage({ id, kind: points ? 'points' : 'triangles', positions, stride: interleaved ? pos.data.stride : 3, offset: interleaved ? pos.offset : 0, index: indices, count: pos.count },
    indices ? [positions.buffer, indices.buffer] : [positions.buffer]);
  return null;
}

// A mesh's raycast through its tree. Reports what THREE.Mesh.prototype.raycast reports for a
// mesh with one material: every triangle the ray crosses, with three's side rules.
function meshRaycast(raycaster, intersects) {
  const geometry = this.geometry, material = this.material;
  if (!material || Array.isArray(material) || !geometry.getAttribute('position')) return THREE.Mesh.prototype.raycast.call(this, raycaster, intersects);
  if (geometry.boundingSphere === null) geometry.computeBoundingSphere();
  _sphere.copy(geometry.boundingSphere).applyMatrix4(this.matrixWorld);
  if (!raycaster.ray.intersectsSphere(_sphere)) return;
  _inverse.copy(this.matrixWorld).invert();
  _ray.copy(raycaster.ray).applyMatrix4(_inverse);
  const tree = treeOf(geometry, false);
  if (!tree) return THREE.Mesh.prototype.raycast.call(this, raycaster, intersects);     // still being built
  const pos = geometry.getAttribute('position'), index = geometry.index, I = index ? index.array : null;
  const side = material.side, draw = geometry.drawRange;
  const first = Math.max(0, draw.start), last = Math.min(index ? index.count : pos.count, draw.start + draw.count);
  const order = tree.order;
  walkRay(tree, _ray.origin.toArray(), _ray.direction.toArray(), 0, (start, count) => {
    for (let k = start; k < start + count; k++) {
      const t = order[k];
      if (t * 3 < first || t * 3 + 3 > last) continue;
      const ia = I ? I[t * 3] : t * 3, ib = I ? I[t * 3 + 1] : t * 3 + 1, ic = I ? I[t * 3 + 2] : t * 3 + 2;
      _a.fromBufferAttribute(pos, ia); _b.fromBufferAttribute(pos, ib); _c.fromBufferAttribute(pos, ic);
      const hit = side === THREE.BackSide ? _ray.intersectTriangle(_c, _b, _a, true, _hit) : _ray.intersectTriangle(_a, _b, _c, side === THREE.FrontSide, _hit);
      if (hit === null) continue;
      _world.copy(_hit).applyMatrix4(this.matrixWorld);
      const distance = raycaster.ray.origin.distanceTo(_world);
      if (distance < raycaster.near || distance > raycaster.far) continue;
      const face = { a: ia, b: ib, c: ic, normal: new THREE.Vector3(), materialIndex: 0 };
      THREE.Triangle.getNormal(_a, _b, _c, face.normal);
      intersects.push({ distance, point: _world.clone(), object: this, faceIndex: t, face });
    }
  });
}

// A point cloud's raycast through its tree: every point within the raycaster's point threshold
// of the ray, as THREE.Points.prototype.raycast reports them.
function pointsRaycast(raycaster, intersects) {
  const geometry = this.geometry;
  if (geometry.index || !geometry.getAttribute('position')) return THREE.Points.prototype.raycast.call(this, raycaster, intersects);
  const threshold = raycaster.params.Points.threshold;
  if (geometry.boundingSphere === null) geometry.computeBoundingSphere();
  _sphere.copy(geometry.boundingSphere).applyMatrix4(this.matrixWorld);
  _sphere.radius += threshold;
  if (!raycaster.ray.intersectsSphere(_sphere)) return;
  _inverse.copy(this.matrixWorld).invert();
  _ray.copy(raycaster.ray).applyMatrix4(_inverse);
  const local = threshold / ((this.scale.x + this.scale.y + this.scale.z) / 3), localSq = local * local;
  const tree = treeOf(geometry, true);
  if (!tree) return THREE.Points.prototype.raycast.call(this, raycaster, intersects);   // still being built
  const pos = geometry.getAttribute('position'), draw = geometry.drawRange;
  const first = Math.max(0, draw.start), last = Math.min(pos.count, draw.start + draw.count);
  const order = tree.order;
  walkRay(tree, _ray.origin.toArray(), _ray.direction.toArray(), local, (start, count) => {
    for (let k = start; k < start + count; k++) {
      const i = order[k];
      if (i < first || i >= last) continue;
      _a.fromBufferAttribute(pos, i);
      const distSq = _ray.distanceSqToPoint(_a);
      if (distSq >= localSq) continue;
      _ray.closestPointToPoint(_a, _hit);
      _world.copy(_hit).applyMatrix4(this.matrixWorld);
      const distance = raycaster.ray.origin.distanceTo(_world);
      if (distance < raycaster.near || distance > raycaster.far) continue;
      intersects.push({ distance, distanceToRay: Math.sqrt(distSq), point: _world.clone(), index: i, face: null, faceIndex: null, barycoord: null, object: this });
    }
  });
}

// Give every large mesh and point cloud under `root` the indexed raycast. Its tree is asked for
// on the first ray that reaches it, or ahead of time by buildPickIndexes. Returns how many
// objects were given one.
export function indexForPicking(root) {
  let n = 0;
  root.traverse(o => {
    const g = o.geometry, pos = g && g.getAttribute && g.getAttribute('position');
    if (!pos || o.userData.pickBox || o.userData.helper || o.userData.drawingProxy) return;
    if (o.isPoints && pos.count >= INDEX_MIN) { o.raycast = pointsRaycast; n++; }
    else if (o.isMesh && !o.isSkinnedMesh && !o.isInstancedMesh && !o.isBatchedMesh && !Array.isArray(o.material) && !(g.morphAttributes && g.morphAttributes.position)
      && (g.index ? g.index.count : pos.count) / 3 >= INDEX_MIN) { o.raycast = meshRaycast; n++; }
  });
  return n;
}

// Ask for the trees now (after a scan has loaded, ahead of the first click). With a helper this
// only hands it the vertices. Returns the milliseconds the page spent.
export function buildPickIndexes(root) {
  const t = performance.now();
  root.traverse(o => {
    if (o.raycast === meshRaycast) treeOf(o.geometry, false);
    else if (o.raycast === pointsRaycast) treeOf(o.geometry, true);
  });
  return performance.now() - t;
}
