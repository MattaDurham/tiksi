// Doors shown open or closed in MODEL: the opening's optional `doorState`, in the 3D wall build,
// through a save and a project export, and in the SketchUp mirror. Synthetic walls and rooms only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import * as THREE from '../vendor/three.module.min.js';
import { doorShownOpen, setDoorShownOpen, doorSwings } from '../js/wall-solids.js';

// geometry.js imports three by its browser import-map names.
const vendor = new URL('../vendor/', import.meta.url).href;
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'three') return { url: vendor + 'three.module.min.js', shortCircuit: true };
    if (spec.startsWith('three/addons/')) return { url: vendor + 'addons/' + spec.slice(13), shortCircuit: true };
    return next(spec, ctx);
  },
});
globalThis.indexedDB = { open() { throw new Error('no IndexedDB under Node'); } };
const store = await import('../js/store.js');
store.ws.data = store.emptyWorkspace();
const { buildWallGroup } = await import('../js/geometry.js');
const { elementState, mirrorSpec } = await import('../js/sketchup-mirror.js');

// A 4 m wall along +x at y = 0; `rooms` picks which sides face a room.
const WALL = { id: 'w1', ax: 0, ay: 0, bx: 4, by: 0, thickness: 0.114, height: 2.44 };
const NORTH = { id: 'r-n', pts: [[0, 0], [4, 0], [4, 3], [0, 3]] }, SOUTH = { id: 'r-s', pts: [[0, -3], [4, -3], [4, 0], [0, 0]] };
const BOTH = [NORTH, SOUTH];
const DEG25 = THREE.MathUtils.degToRad(25);

// Each leaf: its turn about the hinge (0 is closed) and the plan offset z of its free edge.
function leaves(door, rooms) {
  const o = Object.assign({ id: 'd1', wallId: 'w1', t: 0.5, type: 'door', width: 0.813, height: 2.03 }, door);
  const group = buildWallGroup(WALL, [o], { walls: [WALL], rooms, wallHeight: 2.44 }, { matOpts: { transparent: true, opacity: 0.5 } });
  const doorGroup = group.children.find(c => c.isGroup && c.userData.kind === 'opening');
  doorGroup.updateMatrixWorld(true);
  return doorGroup.children.filter(c => c.isGroup).map(pivot => {
    const w = pivot.children[0].geometry.parameters.width;
    const tip = doorGroup.worldToLocal(pivot.localToWorld(new THREE.Vector3(w, 0, 0)));
    return { rot: pivot.rotation.y, tipZ: tip.z };
  });
}
const near = (a, b) => Math.abs(a - b) < 1e-9;

test('with no doorState an interior door stands ajar 25 degrees and an exterior one is shut, as before', () => {
  const [inside] = leaves({}, BOTH);
  assert.ok(near(Math.abs(inside.rot), DEG25), 'interior leaf ajar 25 degrees (' + inside.rot + ')');
  assert.ok(Math.abs(inside.tipZ) > 0.1, 'its free edge stands off the wall');
  const [outside] = leaves({}, [NORTH]);
  assert.ok(near(outside.rot, 0) && Math.abs(outside.tipZ) < 1e-6, 'exterior leaf shut');
});

test('doorState closed shuts an interior door, a pair included', () => {
  const [one] = leaves({ doorState: 'closed' }, BOTH);
  assert.ok(near(one.rot, 0) && Math.abs(one.tipZ) < 1e-6, 'single leaf shut in its frame');
  const pair = leaves({ doorState: 'closed', leaves: 2 }, BOTH);
  assert.equal(pair.length, 2);
  assert.ok(pair.every(l => Math.abs(l.tipZ) < 1e-6), 'both leaves of a pair shut');
  assert.deepEqual(pair.map(l => Math.round(Math.abs(l.rot) * 1e6) / 1e6).sort(), [0, Math.round(Math.PI * 1e6) / 1e6], 'one at 0, its mirror at 180 degrees');
});

test('doorState open stands an exterior door ajar into the room it opens from', () => {
  const [inside] = leaves({}, BOTH);
  const [north] = leaves({ doorState: 'open' }, [NORTH]);
  const [south] = leaves({ doorState: 'open' }, [SOUTH]);
  assert.ok(near(Math.abs(north.rot), DEG25) && near(Math.abs(south.rot), DEG25), 'ajar the same 25 degrees');
  assert.equal(Math.sign(north.tipZ), Math.sign(inside.tipZ), 'a room on the positive side: the same side an interior door opens to');
  assert.equal(Math.sign(south.tipZ), -Math.sign(north.tipZ), 'a room on the other side: into that room');
  assert.ok(leaves({ doorState: 'open', leaves: 2, width: 1.5 }, [NORTH]).every(l => Math.abs(l.tipZ) > 0.1), 'an exterior pair opens both leaves');
  // An explicit open interior door looks like the default.
  assert.ok(near(leaves({ doorState: 'open' }, BOTH)[0].rot, inside.rot));
});

test('the field is kept only where it differs from the default; unknown values are the default', () => {
  const o = { type: 'door' };
  setDoorShownOpen(o, true, false); assert.equal(o.doorState, 'closed');
  setDoorShownOpen(o, true, true); assert.ok(!('doorState' in o), 'opening an interior door again clears it');
  setDoorShownOpen(o, false, true); assert.equal(o.doorState, 'open');
  setDoorShownOpen(o, false, false); assert.ok(!('doorState' in o), 'shutting an exterior door again clears it');
  assert.equal(doorShownOpen({ doorState: 'shut' }, true), true, 'an unknown value: interior stays ajar');
  assert.equal(doorShownOpen({ doorState: 'shut' }, false), false, 'exterior stays shut');
  // The plan draws a swing whether the door is shown open or closed.
  assert.deepEqual(doorSwings({ width: 0.813, doorState: 'closed' }), doorSwings({ width: 0.813 }));
});

function property() {
  const p = store.propertyTemplate('Synthetic doors');
  p.id = 'prop-doors';
  const lvl = p.levels[0].id;
  const wall = (id, ax, ay, bx, by) => ({ id, level: lvl, ax, ay, bx, by, thickness: 0.1, height: null, material: 'mat-drywall' });
  p.walls.push(wall('w-s', 0, 0, 4, 0), wall('w-e', 4, 0, 4, 3), wall('w-n', 4, 3, 0, 3), wall('w-w', 0, 3, 0, 0));
  p.openings.push({ id: 'o-door', wallId: 'w-s', type: 'door', t: 0.5, width: 0.9, height: 2.0 });
  p.rooms.push({ id: 'r-1', level: lvl, name: 'Studio', pts: [[0, 0], [4, 0], [4, 3], [0, 3]], material: 'mat-oak', ceilingMaterial: null });
  return p;
}

test('a door\'s state survives a save and a project export, and the SketchUp mirror ignores it', () => {
  const p = property();
  const before = mirrorSpec(p, []);
  const stateBefore = elementState(p).get('o-door').sig;
  p.openings[0].doorState = 'open';
  const data = store.emptyWorkspace();
  data.properties.push(p);
  const saved = store.tidiedCopy(JSON.parse(JSON.stringify(data)));
  assert.equal(saved.properties[0].openings[0].doorState, 'open', 'kept by the workspace tidy-up a save and an import run');
  const exported = store.tidiedCopy(JSON.parse(JSON.stringify(store.projectSlice(p.id, data))));
  assert.equal(exported.properties[0].openings[0].doorState, 'open', 'kept in a project export');
  assert.equal(elementState(p).get('o-door').sig, stateBefore, 'the mirror signature does not change');
  assert.deepEqual(mirrorSpec(p, []).walls, before.walls, 'nor does what is sent to SketchUp');
});
