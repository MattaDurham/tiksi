// A floor's top is the level's own height: the height walls, doors, fixtures and imported models
// stand at, so furniture stands on the floor and a rug or a hearth shows. Synthetic room only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import * as THREE from '../vendor/three.module.min.js';

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
const { buildRoomFloor, buildWallGroup, buildFixtureGroup, FLOOR_T } = await import('../js/geometry.js');
const { fixtureTemplate } = await import('../js/fixtures.js');

const X = { matOpts: { transparent: true, opacity: 0.5 } };       // plain materials: no canvas under Node
const ROOM = { id: 'r1', pts: [[0, 0], [4, 0], [4, 3], [0, 3]], material: 'mat-oak' };
const WALL = { id: 'w1', ax: 0, ay: 0, bx: 4, by: 0, thickness: 0.114, height: 2.44 };

// Lowest and highest point of every mesh under `root`, in the level's own coordinates.
function span(root, pick = () => true) {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3();
  root.traverse(o => { if (o.isMesh && pick(o)) { o.geometry.computeBoundingBox(); box.union(o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld)); } });
  return [box.min.y, box.max.y];
}
const near = (a, b, what) => assert.ok(Math.abs(a - b) < 1e-6, `${what}: ${a} is not ${b}`);

test('the floor is a slab under the level\'s height, its top at that height', () => {
  const [low, top] = span(buildRoomFloor(ROOM, X));
  near(top, 0, 'floor top');
  near(low, -FLOOR_T, 'floor underside');
  assert.ok(FLOOR_T > 0.02, 'the slab has a visible edge at a floor opening');
});

test('walls, their baseboards and a door all start at the floor\'s top, not below or above it', () => {
  const door = { id: 'd1', wallId: 'w1', t: 0.5, type: 'door', width: 0.8, height: 2.03 };
  const group = buildWallGroup(WALL, [door], { walls: [WALL], rooms: [ROOM], wallHeight: 2.44 }, X);
  const [wallLow, wallTop] = span(group, o => o.userData.kind === 'wall');
  near(wallLow, 0, 'the wall and its baseboard stand on the floor'); near(wallTop, 2.44, 'wall top');
  const [doorLow] = span(group, o => o.userData.kind === 'opening');
  assert.ok(doorLow >= 0 && doorLow < 0.02, 'the door frame and leaf start at the floor (' + doorLow + ')');
});

test('a cabinet run and a 5 mm rug both sit on the floor: nothing is buried in it', () => {
  const [, floorTop] = span(buildRoomFloor(ROOM, X));
  const run = Object.assign(fixtureTemplate('base-run', null, { level: 'lvl-0' }), { id: 'f1', pts: [[0.4, 0.05], [2.4, 0.05]], side: 1 });
  const [runLow] = span(buildFixtureGroup(run, X));
  near(runLow, floorTop, 'the cabinet\'s foot is at the floor\'s top');
  const rugTop = 0.005;      // an imported model's rug: 5 mm above the height the model stands at
  assert.ok(rugTop > floorTop, 'a rug lies above the floor, where it can be seen');
});
