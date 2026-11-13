// An observed wall return can have a different finish without repainting other faces.
// Every record and model used here is synthetic; geometry is inspected after generation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import * as THREE from '../vendor/three.module.min.js';
import { wallFaceMaterialIds } from '../js/wall-solids.js';
import { evidenceState, setEvidence } from '../js/evidence.js';
const vendor = new URL('../vendor/', import.meta.url).href;
registerHooks({ resolve(spec, ctx, next) {
  if (spec === 'three') return { url: vendor + 'three.module.min.js', shortCircuit: true };
  if (spec.startsWith('three/addons/')) return { url: vendor + 'addons/' + spec.slice(13), shortCircuit: true };
  return next(spec, ctx);
} });
globalThis.indexedDB = { open() { throw new Error('no IndexedDB under Node'); } };
const store = await import('../js/store.js');
const { buildWallGroup } = await import('../js/geometry.js');
const { mirrorSpec, syncedState, mergeMirror, wallSig, elementState } = await import('../js/sketchup-mirror.js');
const { materialUsage, deleteMaterial } = await import('../js/materials.js');
const colors = { outer: '#553311', inner: '#335577', endA: '#ff4422', endB: '#22ee44' };
const records = Object.entries(colors).map(([id, color]) => ({ id, name: 'Synthetic '+id, color, pattern: 'flat', kind: 'wall', custom: true }));
function fixture() {
  store.ws.data = store.emptyWorkspace(); store.ws.data.materials.push(...structuredClone(records));
  const prop = store.propertyTemplate('Synthetic end finishes'); prop.id = 'end-property';
  const level = prop.levels[0].id;
  const wall = { id: 'wall', level, ax: 0, ay: 0, bx: 4, by: 0, thickness: .2, height: 2.5,
    material: 'outer', materialIn: 'inner', profile: { baseboardHeight: 0 } };
  prop.walls = [wall];
  prop.rooms = [{ id: 'room', level, pts: [[0, .1], [4, .1], [4, 3], [0, 3]] }];
  prop.openings = [{ id: 'window', type: 'window', wallId: wall.id, t: .5, width: 1, height: 1, sill: .8 }];
  store.ws.data.properties.push(prop); return { prop, wall };
}
function triangles(wall, prop, world = false) {
  const g = buildWallGroup(wall, prop.openings, prop, { glass: new THREE.MeshBasicMaterial() });
  g.updateMatrixWorld(true);
  const rows = [];
  for (const mesh of g.children.filter(x => x.isMesh)) {
    const p = mesh.geometry.attributes.position, n = mesh.geometry.attributes.normal, uv = mesh.geometry.attributes.uv, idx = mesh.geometry.index;
    for (let i = 0; i < idx.count; i += 3) {
      const vertices = [0,1,2].map(k => {
        const at = idx.getX(i+k), v = new THREE.Vector3().fromBufferAttribute(p, at);
        if (world) v.applyMatrix4(mesh.matrixWorld);
        return [...v.toArray(), n.getX(at), n.getY(at), n.getZ(at), uv.getX(at), uv.getY(at)];
      });
      rows.push({ vertices, key: JSON.stringify(vertices), color: mesh.material.color.getHexString() });
    }
    mesh.geometry.dispose();
  }
  return rows.sort((a,b) => a.key.localeCompare(b.key));
}

test('wall end IDs are optional and do not change automatic long faces or other returns', () => {
  const { prop, wall } = fixture();
  const base = { pos: 'inner', neg: 'outer', other: 'inner' };
  assert.deepEqual(wallFaceMaterialIds(wall, prop.rooms), base);
  wall.materialEndB = 'endB';
  assert.deepEqual(wallFaceMaterialIds(wall, prop.rooms), { ...base, endB: 'endB' });
  wall.materialEndA = 'endA';
  assert.deepEqual(wallFaceMaterialIds(wall, prop.rooms), { ...base, endA: 'endA', endB: 'endB' });
  wall.materialEndA = null; wall.materialEndB = '';
  assert.deepEqual(wallFaceMaterialIds(wall, prop.rooms), base);
});

test('generated end finishes select only actual A/B faces, preserving caps, reveals, positions and UVs', () => {
  for (const overrides of [{ materialEndA: 'endA' }, { materialEndB: 'endB' }, { materialEndA: 'endA', materialEndB: 'endB' }]) {
    const { prop, wall } = fixture(), before = triangles(wall, prop);
    Object.assign(wall, overrides); const after = triangles(wall, prop);
    assert.deepEqual(after.map(r => r.key), before.map(r => r.key), 'material split does not change geometry, normals or UVs');
    let changed = 0;
    after.forEach((r, i) => {
      const isA = r.vertices.every(v => Math.abs(v[0]) < 1e-6 && v[3] < -.99);
      const isB = r.vertices.every(v => Math.abs(v[0]-4) < 1e-6 && v[3] > .99);
      const expected = isA && overrides.materialEndA ? colors.endA.slice(1) : isB && overrides.materialEndB ? colors.endB.slice(1) : before[i].color;
      assert.equal(r.color, expected, 'only the selected physical end changes');
      if (r.color !== before[i].color) changed++;
    });
    assert.ok(changed > 0);
    assert.ok(after.some(r => r.vertices.every(v => Math.abs(v[0]-1.5) < 1e-6 && Math.abs(v[3]) > .99) && r.color === colors.inner.slice(1)), 'window reveal keeps its interior finish');
    assert.ok(after.some(r => r.vertices.every(v => v[4] > .99) && r.color === colors.inner.slice(1)), 'top keeps its interior finish');
  }
});

test('mitred joint ends take their own finish without changing geometry or long faces', () => {
  const { prop, wall } = fixture();
  prop.walls.push({ ...wall, id: 'join', ax: 4, ay: 0, bx: 4, by: 3 });
  const before = triangles(wall, prop); wall.materialEndB = 'endB'; const after = triangles(wall, prop);
  assert.deepEqual(after.map(r => r.key), before.map(r => r.key));
  const changed = after.filter((r,i) => r.color !== before[i].color);
  assert.ok(changed.length > 0);
  assert.ok(changed.every(r => r.color === colors.endB.slice(1) && r.vertices.every(v => v[0] > 3.8 && Math.abs(v[4]) < 1e-8)), 'only vertical B joint-cut faces change');
});

test('endpoint finishes follow authored A/B positions even when wall direction is reversed', () => {
  const { prop, wall } = fixture();
  Object.assign(wall, { ax: 4, bx: 0, materialEndA: 'endA', materialEndB: 'endB' });
  const faces = triangles(wall, prop, true);
  const a = faces.filter(r => r.color === colors.endA.slice(1));
  const b = faces.filter(r => r.color === colors.endB.slice(1));
  assert.ok(a.length && b.length);
  assert.ok(a.every(r => r.vertices.every(v => Math.abs(v[0]-4) < 1e-6)));
  assert.ok(b.every(r => r.vertices.every(v => Math.abs(v[0]) < 1e-6)));
});

test('mirror specification and geometry readback preserve end identities through a transformed wall', () => {
  const { prop, wall } = fixture(); Object.assign(wall, { materialEndA: 'endA', materialEndB: 'endB' });
  prop.openings = [];
  const spec = mirrorSpec(prop, records), native = spec.walls[0];
  assert.equal(native.materials.endA.id, 'endA'); assert.equal(native.materials.endB.id, 'endB');
  assert.equal(native.materials.other.id, 'inner');
  const base = { ...elementState(prop).get(wall.id).params, elevation: native.elevation };
  // The writer records A at local x=0. Reflection moves that endpoint to world x=4;
  // the reader still reports it as A, so its finish travels with that physical end.
  const now = { ...base, ax: 4, bx: 0, materialEndA: 'endA', materialEndB: 'endB' };
  const report = mergeMirror(prop, { model: { elements: spec.elements }, walls: [{ id: wall.id, level: wall.level, base, now, openings: [] }] }, syncedState(prop));
  assert.deepEqual(report.applied, [wall.id]);
  assert.equal(wall.materialEndA, 'endA'); assert.equal(wall.materialEndB, 'endB');
  assert.equal(wall.ax, 4); assert.equal(wall.bx, 0);
  assert.notEqual(wallSig(base), wallSig({ ...base, materialEndB: 'endA' }), 'a concurrent end-finish edit participates in conflict detection');
});

test('project export retains an end-only material and its product; deletion refuses a live reference', () => {
  const { prop, wall } = fixture(); wall.materialEndB = 'endB';
  const mat = store.ws.data.materials.find(m => m.id === 'endB'); mat.product = { productId: 'end-product' };
  store.ws.data.products = [{ id: 'end-product', name: 'Synthetic finish' }];
  const exported = store.projectSlice(prop.id);
  assert.ok(exported.materials.some(m => m.id === 'endB'));
  assert.ok(exported.products.some(p => p.id === 'end-product'));
  assert.equal(materialUsage('endB').length, 1);
  assert.match(deleteMaterial('endB'), /Still in use/);
});

test('changing an observed end finish makes its evidence review stale', () => {
  const { wall } = fixture(); wall.materialEndB = 'endB';
  setEvidence(wall, 'appearance', 'observed', 'Synthetic photo');
  assert.equal(evidenceState(wall, 'appearance'), 'observed');
  wall.materialEndB = 'endA';
  assert.equal(evidenceState(wall, 'appearance'), 'stale');
});
