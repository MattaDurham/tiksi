// Glass doors: the opening's optional `glass` ('full' or 'half'), in the 3D wall build and in
// the spec the SketchUp mirror is written from. Synthetic walls and rooms only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import * as THREE from '../vendor/three.module.min.js';
import { doorGlass, leafGlazing, doorGlassBand } from '../js/wall-solids.js';

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
const { mirrorSpec, specSignature } = await import('../js/sketchup-mirror.js');

// A 4 m wall along +x at y = 0 with a room to its north: the door is an outside door.
const WALL = { id: 'w1', ax: 0, ay: 0, bx: 4, by: 0, thickness: 0.114, height: 2.44 };
const NORTH = { id: 'r-n', pts: [[0, 0], [4, 0], [4, 3], [0, 3]] };
const GLASS = new THREE.MeshBasicMaterial();

// The leaves of one door as built: per leaf, its meshes' boxes in the leaf's own coordinates.
function leaves(door, ctx = { glass: GLASS }) {
  const o = Object.assign({ id: 'd1', wallId: 'w1', t: 0.5, type: 'door', height: 2.03 }, door);
  const group = buildWallGroup(WALL, [o], { walls: [WALL], rooms: [NORTH], wallHeight: 2.44 }, ctx);
  const doorGroup = group.children.find(c => c.isGroup && c.userData.kind === 'opening');
  return doorGroup.children.filter(c => c.isGroup).map(pivot => {
    const box = m => { m.geometry.computeBoundingBox(); const b = m.geometry.boundingBox.clone(); b.translate(m.position); return b; };
    const panes = pivot.children.filter(m => m.userData.glass), frame = pivot.children.find(m => m.userData.leafWidth);
    return { panes, pane: panes[0] && box(panes[0]), frame, frameBox: frame && box(frame), all: pivot.children };
  });
}

test('only a door asks for glass, and only in the two ways Tiksi draws', () => {
  assert.equal(doorGlass({ type: 'door', glass: 'full' }), 'full');
  assert.equal(doorGlass({ type: 'door', glass: 'half' }), 'half');
  assert.equal(doorGlass({ type: 'door' }), null, 'a door is solid until its owner says otherwise');
  assert.equal(doorGlass({ type: 'door', glass: true }), null, 'an unknown value is a solid door');
  assert.equal(doorGlass({ type: 'window', glass: 'full' }), null, 'a window keeps its own sash and glass');
});

test('a full-glass leaf is a pane inside stiles and rails; a half-glass one keeps a solid lower panel', () => {
  const full = leafGlazing('full', 0.7, 1.97), half = leafGlazing('half', 0.7, 1.97);
  const [x0, x1, y0, y1] = full.glass;
  assert.ok(x0 > 0.05 && x1 < 0.65 && y0 >= 0.15 && y1 < 1.97, 'the pane sits inside the leaf: ' + full.glass);
  assert.ok((x1 - x0) * (y1 - y0) > 0.55 * 0.7 * 1.97, 'most of a full-glass leaf is glass');
  assert.equal(full.panel, null);
  assert.ok(half.glass[2] > 0.9 && half.glass[2] < 1.0, 'half glass starts about waist height: ' + half.glass[2]);
  assert.ok(half.panel && half.panel[3] < half.glass[2] && half.panel[2] > 0, 'with a solid panel below a lock rail');
  assert.equal(leafGlazing('full', 0.12, 1.97), null, 'a leaf too narrow for a pane stays solid');
  assert.equal(leafGlazing(null, 0.7, 1.97), null);
});

test('a glass pair is built as two framed panes the sun passes, with handles', () => {
  const pair = leaves({ width: 1.52, leaves: 2, glass: 'full' });
  assert.equal(pair.length, 2, 'two leaves');
  for (const leaf of pair) {
    assert.equal(leaf.panes.length, 1, 'one pane per leaf');
    assert.equal(leaf.panes[0].material, GLASS, 'in the same glass as the windows');
    assert.equal(leaf.panes[0].castShadow, false, 'glass casts no shadow, so the sun comes through');
    assert.equal(leaf.frame.castShadow, true, 'the stiles and rails still do');
    assert.deepEqual([leaf.frame.userData.kind, leaf.frame.userData.id, leaf.panes[0].userData.id], ['opening', 'd1', 'd1'], 'a click on either selects the door');
    const size = leaf.pane.getSize(new THREE.Vector3()), whole = leaf.frameBox.getSize(new THREE.Vector3());
    assert.ok(size.x * size.y > 0.5 * whole.x * whole.y, 'more than half of the leaf is glass');
    assert.ok(leaf.pane.min.x > leaf.frameBox.min.x + 0.05 && leaf.pane.max.x < leaf.frameBox.max.x - 0.05, 'stiles both sides of the pane');
    assert.equal(leaf.all.length, 2 + 6, 'frame, pane and a lever set on each face');
  }
});

test('a half-glass door is glass above the waist only; x-ray keeps its plain ghost slab', () => {
  const [leaf] = leaves({ width: 0.84, leaves: 1, glass: 'half' });
  assert.ok(leaf.pane.min.y > 0.9 && leaf.pane.min.y < 1.0, 'glass starts at ' + leaf.pane.min.y);
  assert.ok(leaf.pane.max.y > 1.8, 'and runs to the top rail');
  const [ghost] = leaves({ width: 0.84, leaves: 1, glass: 'full' }, { glass: GLASS, matOpts: { transparent: true, opacity: 0.5 } });
  assert.equal(ghost.panes.length, 0);
  assert.equal(ghost.all.length, 1, 'x-ray draws one ghost slab, no pane or hardware');
});

function room(door) {
  const p = store.propertyTemplate('Synthetic room');
  p.id = 'prop-syn';
  const lvl = p.levels[0].id;
  const wall = (id, ax, ay, bx, by) => ({ id, level: lvl, ax, ay, bx, by, thickness: 0.1, height: null, material: 'mat-drywall' });
  p.walls.push(wall('w-s', 0, 0, 4, 0), wall('w-e', 4, 0, 4, 3), wall('w-n', 4, 3, 0, 3), wall('w-w', 0, 3, 0, 0));
  p.openings.push(Object.assign({ id: 'o-door', wallId: 'w-s', type: 'door', t: 0.5, width: 1.5, height: 2.0 }, door));
  p.rooms.push({ id: 'r-1', level: lvl, name: 'Studio', pts: [[0, 0], [4, 0], [4, 3], [0, 3]], material: 'mat-oak', ceilingMaterial: null });
  return p;
}
const hole = door => mirrorSpec(room(door), store.ws.data.materials).walls[0].holes[0];

test('the SketchUp mirror is told which part of a glass door is glass, and nothing new about a solid one', () => {
  assert.deepEqual(doorGlassBand({ type: 'door', glass: 'full' }, 0, 2), [0, 2]);
  assert.deepEqual(doorGlassBand({ type: 'door', glass: 'half' }, 0, 2), [0.95, 2]);
  assert.equal(doorGlassBand({ type: 'door' }, 0, 2), null);
  assert.equal(doorGlassBand({ type: 'door', glass: 'half' }, 0, 1), null, 'a door too low for a lite is all door');
  const solid = hole({}), full = hole({ glass: 'full' }), half = hole({ glass: 'half' });
  assert.equal('glass' in solid, false, 'a solid door\'s spec is as it was');
  assert.equal(specSignature(mirrorSpec(room({}), store.ws.data.materials)), specSignature(mirrorSpec(room({ glass: 'none' }), store.ws.data.materials)), 'so its file is not rewritten');
  assert.deepEqual([full.glass.v0, full.glass.v1], [0, 2]);
  assert.deepEqual([half.glass.v0, half.glass.v1], [0.95, 2]);
  assert.equal(full.glass.material.id, 'mat-glass', 'the glass finish the windows wear');
  assert.equal(full.material.id, 'mat-trim', 'the rest of the door keeps the door finish');
  assert.notEqual(specSignature(mirrorSpec(room({ glass: 'full' }), store.ws.data.materials)), specSignature(mirrorSpec(room({}), store.ws.data.materials)), 'turning a door to glass rewrites the SketchUp file');
});
