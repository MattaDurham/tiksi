// Measured opening details must change the generated object, not just its label.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import * as THREE from '../vendor/three.module.min.js';
import { doorDetail, doorSwings, windowDetail } from '../js/wall-solids.js';
const vendor = new URL('../vendor/', import.meta.url).href;
registerHooks({ resolve(spec, ctx, next) {
  if (spec === 'three') return { url: vendor + 'three.module.min.js', shortCircuit: true };
  if (spec.startsWith('three/addons/')) return { url: vendor + 'addons/' + spec.slice(13), shortCircuit: true };
  return next(spec, ctx);
} });
globalThis.indexedDB = { open() { throw new Error('no IndexedDB under Node'); } };
const store = await import('../js/store.js');
store.ws.data = store.emptyWorkspace();
const { buildWallGroup, buildRoomCeiling, buildPropertyGroup, roomCentres } = await import('../js/geometry.js');
const wall = { id: 'w', ax: 0, ay: 0, bx: 4, by: 0, thickness: 0.12, height: 2.5 };
const rooms = [{ id: 'a', pts: [[0, 0.06], [4, 0.06], [4, 3], [0, 3]] }, { id: 'b', pts: [[0, -3], [4, -3], [4, -0.06], [0, -0.06]] }];
const glass = new THREE.MeshBasicMaterial();
function opening(fields) {
  const o = { id: 'o', wallId: 'w', type: 'door', t: 0.5, width: 0.744, height: 2.05, ...fields };
  const group = buildWallGroup(wall, [o], { walls: [wall], rooms, wallHeight: 2.5 }, { glass });
  const g = group.children.find(c => c.isGroup && c.userData.kind === 'opening');
  g.updateMatrixWorld(true); return g;
}
const near = (actual, expected, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);

test('observed slab width, opposite hinge and independent swing side become real geometry', () => {
  const detail = { door: { hinge: 'end', swingSide: 'negative', style: 'slab', hardware: 'knob', leafWidth: 0.7, jambWidth: 0.019, leafThickness: 0.035 } };
  const g = opening({ detail, doorState: 'open' });
  const pivot = g.children.find(c => c.isGroup), leaf = pivot.children[0];
  near(leaf.geometry.parameters.width, 0.7); near(leaf.geometry.parameters.depth, 0.035);
  near(pivot.position.x, 2 + 0.744 / 2 - 0.019 - 0.003);
  const tip = pivot.localToWorld(new THREE.Vector3(0.7, 0, 0));
  assert.ok(tip.z < -0.2, 'opposite hinge still opens toward the specified negative side');
  assert.equal(Array.isArray(leaf.material), false, 'flat slab has no six-panel texture');
  const knobs = pivot.children.filter(c => c.userData.hardware === 'knob');
  assert.equal(knobs.length, 2); assert.ok(knobs.every(k => k.geometry.type === 'SphereGeometry'));
  const [swing] = doorSwings({ width: 0.744, height: 2.05, detail });
  near(swing.r, 0.7); assert.equal(swing.dir, -1); assert.equal(swing.side, -1);
});

test('glass faceted knobs and brass hardware are distinct from a generic silver lever', () => {
  const faceted = opening({ detail: { door: { style: 'slab', hardware: 'knob', hardwareFinish: 'glass', knobShape: 'faceted' } } });
  const knob = faceted.children.find(c => c.isGroup).children.find(c => c.userData.hardware);
  assert.equal(knob.geometry.type, 'IcosahedronGeometry'); assert.equal(knob.material, glass);
  const brass = opening({ detail: { door: { style: 'slab', hardware: 'knob', hardwareFinish: 'brass' } } });
  const brassKnob = brass.children.find(c => c.isGroup).children.find(c => c.userData.hardware);
  assert.equal(brassKnob.material.color.getHexString(), 'b29350');
});

test('an impossible explicit leaf size is flagged and never drawn through its jambs', () => {
  const d = doorDetail({ detail: { door: { leafWidth: 1.5 } } }, 0.8, 2, true);
  assert.equal(d.warnings.length, 1); assert.ok(d.leafWidth < 0.8 - d.jambWidth * 2);
});

test('double-hung upper grille and clear lower sash have separate rails and glazing', () => {
  const g = opening({ type: 'window', width: 1, sill: 0.8, height: 1.4,
    detail: { window: { type: 'double-hung', upperColumns: 3, upperRows: 2, lowerColumns: 1, lowerRows: 1 } } });
  assert.equal(g.children.filter(c => c.userData.glass).length, 2);
  const opaque = g.children.filter(c => !c.userData.glass);
  function blocked(x, y) {
    const ray = new THREE.Raycaster(new THREE.Vector3(x, y, 1), new THREE.Vector3(0, 0, -1));
    return ray.intersectObjects(opaque, true).length > 0;
  }
  assert.equal(blocked(1.86, 1.75), true, 'upper vertical muntin exists');
  assert.equal(blocked(1.86, 1.2), false, 'same x on clear lower sash has no invented muntin');
  assert.equal(blocked(2, 1.5), true, 'meeting rail remains even without lower grille');
  const clear = windowDetail({ detail: { window: { type: 'casement', columns: 1, rows: 1 } } }, 1.4, 1.2);
  assert.equal(clear.columns, 1); assert.equal(clear.rows, 1);
  assert.equal(windowDetail({}, 1.4, 1.2).columns, 3, 'unspecified legacy windows unchanged');
});

test('ceiling datum is its finished underside, including a room-specific soffit', () => {
  const room = { id: 'r', pts: [[0, 0], [2, 0], [2, 2], [0, 2]] };
  let c = buildRoomCeiling(room, 2.42), box = new THREE.Box3().setFromObject(c);
  near(box.min.y, 2.42); near(box.max.y, 2.447);
  c = buildRoomCeiling({ ...room, ceilingHeight: 2.07 }, 2.42); box = new THREE.Box3().setFromObject(c);
  near(box.min.y, 2.07); near(box.max.y, 2.097);
});

test('property floor includes internal doorway infill at the floor datum', () => {
  const prop = store.propertyTemplate('Synthetic floor continuity'), level = prop.levels[0].id;
  prop.walls = [{ ...wall, level }]; prop.rooms = rooms.map(r => ({ ...r, level }));
  prop.openings = [{ id: 'o', wallId: 'w', type: 'door', t: 0.5, width: 0.8, height: 2, plain: true }];
  const model = buildPropertyGroup(prop); model.updateMatrixWorld(true);
  const floorMeshes = [];
  model.traverse(o => { if (o.isMesh && o.userData.kind === 'room') floorMeshes.push(o); });
  const ray = new THREE.Raycaster(new THREE.Vector3(2, 0.5, 0), new THREE.Vector3(0, -1, 0));
  const hits = ray.intersectObjects(floorMeshes, false);
  assert.ok(hits.length, 'floor exists at the internal threshold'); near(hits[0].point.y, 0);
  prop.rooms[0].ceilingHeight = 2.07;
  near(roomCentres(prop).find(r => r.id === 'a').top, 2.07);
});


test('an explicit rounded baseboard changes only its observed wall side and stops at doors', () => {
  const w = { ...wall, baseboardPos: { height: 0.09, depth: 0.012, profile: 'rounded', radius: 0.004 } };
  const g = buildWallGroup(w, [{ id: 'passage', wallId: 'w', type: 'door', t: 0.5, width: 0.8, height: 2, plain: true }],
    { walls: [w], rooms, wallHeight: 2.5 }, { glass });
  g.updateMatrixWorld(true);
  const firstZ = (x, y, side) => new THREE.Raycaster(new THREE.Vector3(x, y, side), new THREE.Vector3(0, 0, -side))
    .intersectObject(g, true)[0]?.point.z;
  near(firstZ(1, 0.05, 1), 0.072);
  near(firstZ(1, 0.1, 1), 0.06, 1e-6); // observed lower board ends below this ray
  near(firstZ(1, 0.1, -1), -0.072); // unobserved opposite side keeps prior default
  assert.ok(firstZ(1, 0.089, 1) < 0.072 && firstZ(1, 0.089, 1) > 0.068, 'rounded top recedes from the face');
  assert.equal(firstZ(2, 0.05, 1), undefined, 'no baseboard across a plain doorway');
});

test('an explicit panelled wood leaf keeps modeled relief and its finish', () => {
  store.ws.data.materials.push({ id: 'synthetic-wood', name: 'Synthetic brown finish', color: '#654321', pattern: 'flat' });
  const g = opening({ doorState: 'closed', detail: { door: { style: 'six-panel', hardware: 'none', leafMaterial: 'synthetic-wood' } } });
  const leaf = g.children.find(c => c.isGroup).children[0], positions = leaf.geometry.getAttribute('position');
  const depths = new Set(Array.from({ length: positions.count }, (_, i) => Math.round(Math.abs(positions.getZ(i)) * 10000)));
  assert.ok(depths.has(225) && depths.has(185), 'panels are recessed 4 mm below rails/stiles');
  assert.equal(leaf.material.color.getHexString(), '654321');
});
