// The pick index (js/pick-index.js) must report exactly what three's own ray tests report, on
// meshes and on point clouds, whatever the ray and the object's placement. Synthetic geometry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import * as THREE from '../vendor/three.module.min.js';

const vendor = new URL('../vendor/', import.meta.url).href;
registerHooks({ resolve(spec, ctx, next) { return spec === 'three' ? { url: vendor + 'three.module.min.js', shortCircuit: true } : next(spec, ctx); } });
const { indexForPicking, buildPickIndexes, buildTree, walkRay, INDEX_MIN } = await import('../js/pick-index.js');

// A repeatable random number source.
function random(seed) { let a = seed; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const brief = hits => hits.map(h => ({ d: +h.distance.toFixed(5), f: h.faceIndex ?? null, i: h.index ?? null, p: h.point.toArray().map(v => +v.toFixed(4)) })).sort((x, y) => x.d - y.d || (x.f ?? x.i) - (y.f ?? y.i));
function rays(count, seed) {
  const r = random(seed), out = [];
  for (let i = 0; i < count; i++) {
    const from = new THREE.Vector3(r() * 14 - 7, r() * 10 - 2, r() * 14 - 7), to = new THREE.Vector3(r() * 3 - 1.5, r() * 3 - 1.5, r() * 3 - 1.5);
    out.push(new THREE.Ray(from, to.sub(from).normalize()));
  }
  // Rays along the axes too: a zero in the direction is the awkward case for a box test.
  out.push(new THREE.Ray(new THREE.Vector3(0.2, 9, 0.1), new THREE.Vector3(0, -1, 0)), new THREE.Ray(new THREE.Vector3(-9, 0.3, 0.2), new THREE.Vector3(1, 0, 0)), new THREE.Ray(new THREE.Vector3(0.1, 0.2, 9), new THREE.Vector3(0, 0, -1)));
  return out;
}

test('a large mesh reports the hits three reports, for every side rule and placement', () => {
  for (const [side, indexed] of [[THREE.FrontSide, true], [THREE.BackSide, true], [THREE.DoubleSide, true], [THREE.FrontSide, false]]) {
    let geometry = new THREE.TorusKnotGeometry(1.2, 0.45, 220, 48);   // 21,120 triangles
    if (!indexed) geometry = geometry.toNonIndexed();
    assert.ok((geometry.index ? geometry.index.count : geometry.getAttribute('position').count) / 3 >= INDEX_MIN);
    const material = new THREE.MeshBasicMaterial({ side });
    const plain = new THREE.Mesh(geometry, material), fast = new THREE.Mesh(geometry, material);
    for (const m of [plain, fast]) { m.position.set(0.4, 0.3, -0.2); m.rotation.set(0.3, 1.1, -0.4); m.scale.set(1.3, 0.8, 1.1); m.updateMatrixWorld(true); }
    assert.equal(indexForPicking(fast), 1);
    let total = 0;
    for (const ray of rays(120, 7)) {
      const rc = new THREE.Raycaster(ray.origin, ray.direction);
      const want = brief(rc.intersectObject(plain)), got = brief(rc.intersectObject(fast));
      assert.deepEqual(got, want);
      total += want.length;
    }
    assert.ok(total > 150, 'the rays hit the mesh often enough to mean something (' + total + ' hits)');
  }
});

test('near and far limits and the drawn range are respected', () => {
  const geometry = new THREE.TorusKnotGeometry(1.2, 0.45, 220, 48);
  geometry.setDrawRange(3000, 30000);
  const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  const plain = new THREE.Mesh(geometry, material), fast = new THREE.Mesh(geometry, material);
  indexForPicking(fast);
  for (const ray of rays(60, 21)) {
    const rc = new THREE.Raycaster(ray.origin, ray.direction, 2, 9);
    assert.deepEqual(brief(rc.intersectObject(fast)), brief(rc.intersectObject(plain)));
  }
});

test('a large point cloud reports the points three reports', () => {
  const r = random(3), n = 60000, positions = new Float32Array(n * 3);
  for (let i = 0; i < n * 3; i++) positions[i] = r() * 4 - 2;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const plain = new THREE.Points(geometry), fast = new THREE.Points(geometry);
  for (const m of [plain, fast]) { m.position.set(0.2, 0.1, 0.3); m.rotation.y = 0.7; m.scale.setScalar(1.5); m.updateMatrixWorld(true); }
  assert.equal(indexForPicking(fast), 1);
  let total = 0;
  for (const ray of rays(80, 11)) {
    const rc = new THREE.Raycaster(ray.origin, ray.direction);
    rc.params.Points = { threshold: 0.05 };
    const want = brief(rc.intersectObject(plain)), got = brief(rc.intersectObject(fast));
    assert.deepEqual(got, want);
    total += want.length;
  }
  assert.ok(total > 100, 'the rays pass near enough points (' + total + ')');
});

test('small geometry, meshes with several materials and drawing stand-ins keep three\'s own test', () => {
  const small = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
  const several = new THREE.Mesh(new THREE.TorusKnotGeometry(1, 0.4, 220, 48), [new THREE.MeshBasicMaterial()]);
  const standIn = new THREE.Mesh(new THREE.TorusKnotGeometry(1, 0.4, 220, 48), new THREE.MeshBasicMaterial());
  standIn.userData.drawingProxy = true;
  const root = new THREE.Group(); root.add(small, several, standIn);
  assert.equal(indexForPicking(root), 0);
  for (const m of [small, several, standIn]) assert.equal(m.raycast, THREE.Mesh.prototype.raycast);
});

test('the tree is built once, and again only when the vertices are replaced', () => {
  const geometry = new THREE.TorusKnotGeometry(1.2, 0.45, 220, 48);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  indexForPicking(mesh);
  buildPickIndexes(mesh);
  const first = geometry.userData.pickTree.tree;
  new THREE.Raycaster(new THREE.Vector3(0, 0, 9), new THREE.Vector3(0, 0, -1)).intersectObject(mesh);
  assert.equal(geometry.userData.pickTree.tree, first);
  geometry.getAttribute('position').needsUpdate = true;
  new THREE.Raycaster(new THREE.Vector3(0, 0, 9), new THREE.Vector3(0, 0, -1)).intersectObject(mesh);
  assert.notEqual(geometry.userData.pickTree.tree, first);
});

test('the tree holds every item once and a ray visits few of them', () => {
  const n = 50000, r = random(5), P = new Float32Array(n * 3);
  for (let i = 0; i < n * 3; i++) P[i] = r() * 10;
  const tree = buildTree(n, (i, o) => { o[0] = o[3] = P[i * 3]; o[1] = o[4] = P[i * 3 + 1]; o[2] = o[5] = P[i * 3 + 2]; }, (i, axis) => P[i * 3 + axis]);
  assert.deepEqual([...tree.order].sort((x, y) => x - y).slice(0, 5), [0, 1, 2, 3, 4]);
  assert.equal(new Set(tree.order).size, n);
  let visited = 0;
  walkRay(tree, [5, 5, -1], [0, 0, 1], 0.05, (start, count) => { visited += count; });
  assert.ok(visited > 0 && visited < n / 50, 'a ray through the middle looks at ' + visited + ' of ' + n + ' points');
  // Items all in one place still make a tree that ends.
  const same = buildTree(1000, (i, o) => { o.fill(1); }, () => 1);
  assert.equal(new Set(same.order).size, 1000);
  assert.equal(buildTree(0, () => {}, () => 0).nodes, 0);
});
