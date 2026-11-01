import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GeometryHistory, geometrySnapshot } from '../js/geometry-history.js';
import { planWallMove, applyWallMove, normalOffset } from '../js/wallmove.js';

function house(id = 'house') {
  const wall = (id, ax, ay, bx, by) => ({ id, level: 'ground', ax, ay, bx, by, thickness: .15 });
  return { id, activeLevelId: 'ground', levels: [{ id: 'ground', elevation: 0, height: 2.7, plan: { img: 'large image', offsetX: 0 } }],
    walls: [wall('south', 0, 0, 6, 0), wall('east', 6, 0, 6, 4), wall('north', 6, 4, 0, 4), wall('west', 0, 4, 0, 0)],
    rooms: [{ id: 'room', level: 'ground', pts: [[0, 0], [6, 0], [6, 4], [0, 4]] }],
    openings: [{ id: 'door', wallId: 'north', t: .25, width: .8 }] };
}
function move(p, h, dx = 1) {
  h.begin(p, 'move wall');
  const plan = planWallMove(p.walls[1], p.walls, p.rooms, p.openings);
  applyWallMove(plan, normalOffset(plan, dx, 0)); h.commit(p);
}
test('one undo restores the wall gesture, attached walls, floor and door; redo replays it', () => {
  const p = house(), h = new GeometryHistory(), before = geometrySnapshot(p).data;
  move(p, h); const after = geometrySnapshot(p).data;
  assert.equal(p.walls[1].ax, 7); assert.equal(p.rooms[0].pts[1][0], 7);
  assert.equal(h.restore(p, 'undo'), true); assert.deepEqual(geometrySnapshot(p).data, before);
  assert.equal(h.restore(p, 'redo'), true); assert.deepEqual(geometrySnapshot(p).data, after);
  assert.equal(h.restore(house('different project'), 'undo'), false);
});
test('undo and redo preserve unrelated remote changes and current underlay placement', () => {
  const p = house(), h = new GeometryHistory(); move(p, h);
  p.walls[3].material = 'remote finish'; p.levels[0].plan.offsetX = 4;
  h.restore(p, 'undo'); assert.equal(p.walls[1].ax, 6); assert.equal(p.walls[3].material, 'remote finish');
  assert.equal(p.levels[0].plan.offsetX, 4);
  h.restore(p, 'redo'); assert.equal(p.walls[1].ax, 7); assert.equal(p.walls[3].material, 'remote finish');
});
test('undo refuses to overwrite a newer edit to the same geometry', () => {
  const p = house(), h = new GeometryHistory(); move(p, h); p.walls[1].ax = 8;
  assert.equal(h.state(p, 'undo').blocked, true); const before = JSON.stringify(p);
  assert.equal(h.restore(p, 'undo'), false); assert.equal(JSON.stringify(p), before);
});
test('a new real edit clears redo, while a click/no-op does not', () => {
  const p = house(), h = new GeometryHistory(); move(p, h); h.restore(p, 'undo');
  h.begin(p); h.commit(p); assert.equal(h.state(p, 'redo').available, true);
  h.begin(p); p.walls[0].thickness = .2; h.commit(p); assert.equal(h.state(p, 'redo').available, false);
});
test('deleted levels return with their underlays without copying image data', () => {
  const p = house(), h = new GeometryHistory(), plan = p.levels[0].plan;
  h.begin(p); p.levels.push({ id: 'upper', elevation: 3, height: 2.7, plan: null }); h.commit(p);
  h.restore(p, 'undo'); assert.equal(p.levels.length, 1); assert.equal(p.levels[0].plan, plan);
  h.restore(p, 'redo'); assert.equal(p.levels.length, 2); assert.equal(p.levels[0].plan, plan);
});
test('undoing a new wall cannot orphan an opening another editor attached to it', () => {
  const p = house(), h = new GeometryHistory(); h.begin(p); p.walls.push({ ...p.walls[0], id: 'new' }); h.commit(p);
  p.openings.push({ id: 'remote', wallId: 'new', t: .5, width: .8 });
  assert.equal(h.restore(p, 'undo'), false); assert(p.walls.some(w => w.id === 'new'));
});
test('history stays bounded and does not undo into another project', () => {
  const p = house(), h = new GeometryHistory(2);
  for (const v of [.2, .3, .4]) { h.begin(p); p.walls[0].thickness = v; h.commit(p); }
  assert.equal(h.restore(p, 'undo'), true); assert.equal(h.restore(p, 'undo'), true);
  assert.equal(h.restore(p, 'undo'), false); assert.equal(p.walls[0].thickness, .2);
});
