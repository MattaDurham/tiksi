// Doors hung as one leaf or a pair: the opening's optional `leaves`, in the 3D wall build and
// in the plan's swing arcs. Synthetic walls and rooms only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import * as THREE from '../vendor/three.module.min.js';
import { doorLeaves, doorSwings } from '../js/wall-solids.js';

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

// A 4 m wall along +x at y = 0; `rooms` picks which sides face a room.
const WALL = { id: 'w1', ax: 0, ay: 0, bx: 4, by: 0, thickness: 0.114, height: 2.44 };
const NORTH = { id: 'r-n', pts: [[0, 0], [4, 0], [4, 3], [0, 3]] }, SOUTH = { id: 'r-s', pts: [[0, -3], [4, -3], [4, 0], [0, 0]] };

// Each leaf in wall-local metres: its hinge x and the plan offset z of its free edge.
function leaves(door, rooms) {
  const o = Object.assign({ id: 'd1', wallId: 'w1', t: 0.5, type: 'door', height: 2.03 }, door);
  const group = buildWallGroup(WALL, [o], { walls: [WALL], rooms, wallHeight: 2.44 }, { matOpts: { transparent: true, opacity: 0.5 } });
  const doorGroup = group.children.find(c => c.isGroup && c.userData.kind === 'opening');
  doorGroup.updateMatrixWorld(true);
  return doorGroup.children.filter(c => c.isGroup).map(pivot => {
    const w = pivot.children[0].geometry.parameters.width;
    const tip = doorGroup.worldToLocal(pivot.localToWorld(new THREE.Vector3(w, 0, 0)));
    return { hinge: pivot.position.x, width: w, tipX: tip.x, tipZ: tip.z };
  });
}

test('an interior 0.813 m door with leaves: 2 hangs a pair from both jambs, ajar to one side', () => {
  const pair = leaves({ width: 0.813, leaves: 2 }, [NORTH, SOUTH]);
  assert.equal(pair.length, 2);
  const [a, b] = pair.sort((p, q) => p.hinge - q.hinge);
  assert.ok(a.hinge < 2 - 0.35 && b.hinge > 2 + 0.35, 'hinges sit at the two jambs');
  assert.ok(Math.abs(a.width - b.width) < 1e-9 && a.width < 0.813 / 2, 'two equal half-width leaves');
  assert.ok(a.tipX > a.hinge && b.tipX < b.hinge, 'each leaf reaches toward the middle');
  assert.ok(Math.abs(a.tipZ) > 0.1 && Math.sign(a.tipZ) === Math.sign(b.tipZ), 'both leaves swing open to the same side');
  assert.ok(Math.abs(a.tipZ - b.tipZ) < 1e-9, 'mirror images of each other');
  // The single leaf the same door would hang swings to that side too.
  const one = leaves({ width: 0.813 }, [NORTH, SOUTH]), [single] = one;
  assert.equal(one.length, 1);
  assert.equal(Math.sign(single.tipZ), Math.sign(a.tipZ));
});

test('without leaves a door keeps today\'s rule; an explicit count overrides it', () => {
  assert.equal(leaves({ width: 1.5 }, [NORTH]).length, 2, 'wide exterior door: closed pair');
  assert.ok(leaves({ width: 1.5 }, [NORTH]).every(l => Math.abs(l.tipZ) < 1e-6), 'exterior pair stays closed');
  assert.equal(leaves({ width: 1.5 }, [NORTH, SOUTH]).length, 0, 'wide interior opening: archway');
  assert.equal(leaves({ width: 1.5, leaves: 2 }, [NORTH, SOUTH]).length, 2, 'explicit pair hangs in a wide interior opening');
  assert.equal(leaves({ width: 1.5, leaves: 1 }, [NORTH]).length, 1, 'explicit single in a wide exterior opening');
  assert.equal(leaves({ width: 0.9, leaves: 2 }, [NORTH]).length, 2);
  assert.equal(doorLeaves({ leaves: 3 }, 0.9, true), 1, 'an invalid count falls back to the width rule');
  assert.equal(leaves({ width: 0.67, leaves: 0 }, [NORTH, SOUTH]).length, 0, 'a narrow doorway set to no leaf hangs none');
  assert.equal(leaves({ width: 0.9, leaves: 0 }, [NORTH]).length, 0, 'nor does an outside one');
  assert.equal(leaves({ width: 1.5, leaves: 0 }, [NORTH]).length, 0, 'a wide outside opening set to no leaf is not a pair');
});

test('the plan draws a pair as two half-width swings meeting in the middle', () => {
  const [a, b] = doorSwings({ width: 0.813, leaves: 2 });
  assert.deepEqual([a.s, b.s], [-0.4065, 0.4065], 'hinged at the two jambs');
  assert.deepEqual([a.r, b.r], [0.4065, 0.4065]);
  assert.equal(a.s + a.dir * a.r, 0); assert.equal(b.s + b.dir * b.r, 0);
  assert.deepEqual(doorSwings({ width: 0.813 }), [{ s: -0.4065, r: 0.813, dir: 1 }], 'one full-width swing otherwise');
  assert.equal(doorSwings({ width: 1.5 }).length, 1, 'a wide door without leaves keeps its single plan swing');
  assert.deepEqual(doorSwings({ width: 0.67, leaves: 0 }), [], 'an opening set to no leaf draws no swing in plan');
});
