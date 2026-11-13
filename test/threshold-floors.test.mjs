import test from 'node:test';
import assert from 'node:assert/strict';
import { thresholdFloors } from '../js/threshold-floors.js';
import { pointInPoly } from '../js/wall-solids.js';

const rect = (id, x0, y0, x1, y1, material = id) => ({ id, material, pts: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] });
const wall = { id: 'wall', ax: 0, ay: 0, bx: 5, by: 0, thickness: 0.2 };
const door = { id: 'door', type: 'door', wallId: 'wall', width: 1, t: 0.5, height: 2 };
const area = pts => Math.abs(pts.reduce((v, p, i) => { const q = pts[(i + 1) % pts.length]; return v + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;
const total = patches => patches.reduce((v, p) => v + area(p.pts), 0);
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
const model = rooms => ({ walls: [wall], openings: [door], rooms });

test('fills just an internal doorway gap and splits finishes at its midpoint', () => {
  const rooms = [rect('north', 0, -3, 5, -0.1), rect('south', 0, 0.1, 5, 3)];
  const patches = thresholdFloors(model(rooms));
  assert.equal(patches.length, 2); close(total(patches), 0.2);
  assert.deepEqual(patches.map(p => p.material), ['north', 'south']);
  for (const p of patches) for (const r of rooms) {
    const c = p.pts.reduce((v, q) => [v[0] + q[0] / 4, v[1] + q[1] / 4], [0, 0]);
    assert.equal(pointInPoly(...c, r.pts), false);
  }
  assert.ok(patches.every(p => p.openingId === 'door' && p.wallId === 'wall'));
});

test('works with plain passages and offset room edges, without shrinking or duplicating floors', () => {
  const p = model([rect('a', 0, -3, 5, -0.04), rect('b', 0, 0.075, 5, 3)]);
  p.openings[0] = { ...door, plain: true };
  const result = thresholdFloors(p); close(total(result), 0.115);
  close(Math.max(...result[0].pts.map(q => q[1])), 0.0175);
  close(Math.min(...result[1].pts.map(q => q[1])), 0.0175);
});

test('does not fill windows, external doors, missing-side stairs, or already continuous floors', () => {
  const rooms = [rect('a', 0, -3, 5, -0.1), rect('b', 0, 0.1, 5, 3)];
  assert.deepEqual(thresholdFloors({ ...model(rooms), openings: [{ ...door, type: 'window' }] }), []);
  assert.deepEqual(thresholdFloors(model([rooms[0]])), []);
  assert.deepEqual(thresholdFloors(model([rect('whole', 0, -3, 5, 3)])), []);
  assert.deepEqual(thresholdFloors(model([rect('a', 0, -3, 5, 0), rect('b', 0, 0, 5, 3)])), []);
  assert.deepEqual(thresholdFloors({ ...model(rooms), openings: [{ ...door, floorContinuity: false }] }), []);
});

test('rotated walls retain physical area and plan coordinates', () => {
  const angle = Math.PI / 5, c = Math.cos(angle), s = Math.sin(angle);
  const rotate = ([x, y]) => [x * c - y * s + 4, x * s + y * c - 2];
  const a = rotate([wall.ax, wall.ay]), b = rotate([wall.bx, wall.by]);
  const p = model([rect('a', 0, -3, 5, -0.1), rect('b', 0, 0.1, 5, 3)]);
  p.walls = [{ ...wall, ax: a[0], ay: a[1], bx: b[0], by: b[1] }];
  p.rooms.forEach(r => { r.pts = r.pts.map(rotate); });
  const result = thresholdFloors(p); close(total(result), 0.2);
  const inverse = ([x, y]) => [(x - 4) * c + (y + 2) * s, -(x - 4) * s + (y + 2) * c];
  for (const q of result.flatMap(r => r.pts).map(inverse)) {
    assert.ok(q[0] >= 2 - 1e-8 && q[0] <= 3 + 1e-8);
    assert.ok(q[1] >= -0.1 - 1e-8 && q[1] <= 0.1 + 1e-8);
  }
});

test('angled and stepped floor boundaries produce exact uncovered trapezoids', () => {
  const north = { id: 'north', material: 'oak', pts: [[0, -3], [5, -3], [5, -0.05], [0, -0.15]] };
  const south = { id: 'south', material: 'tile', pts: [[0, 0.1], [2.5, 0.1], [2.5, 0.15], [5, 0.15], [5, 3], [0, 3]] };
  const result = thresholdFloors(model([north, south]));
  close(total(result), 0.225);
  assert.equal(result.length, 4);
});

test('existing overlap in the opening is subtracted and other levels cannot supply a floor', () => {
  const rooms = [rect('north', 0, -3, 5, -0.1), rect('south', 0, 0.1, 5, 3), rect('existing', 2.2, -0.1, 2.4, 0.1)];
  close(total(thresholdFloors(model(rooms))), 0.16);
  const p = model(rooms.slice(0, 2)); p.walls = [{ ...wall, level: 'ground' }];
  p.rooms[0].level = 'ground'; p.rooms[1].level = 'upper';
  assert.deepEqual(thresholdFloors(p), []);
});

test('fills only the part of a doorway that has floor on both sides', () => {
  const p = model([rect('north', 0, -3, 5, -0.1), rect('south', 0, 0.1, 2.5, 3)]);
  const result = thresholdFloors(p); close(total(result), 0.1);
  assert.ok(result.flatMap(r => r.pts).every(q => q[0] <= 2.5));
});

test('one concave room on both sides may have a threshold gap without adding a second room', () => {
  const room = { id: 'wrapped', material: 'oak', pts: [[0, -3], [5, -3], [5, -0.1], [1, -0.1], [1, 0.1], [5, 0.1], [5, 3], [0, 3]] };
  const result = thresholdFloors(model([room])); close(total(result), 0.2);
  assert.equal(result.length, 1); assert.equal(result[0].roomId, room.id);
});

test('a room edge receding beyond the wall neighborhood does not create speculative flooring', () => {
  const north = rect('north', 0, -3, 5, -0.1);
  const south = { id: 'south', material: 'tile', pts: [[2, 0.05], [3, 0.3], [3, 3], [2, 3]] };
  const result = thresholdFloors(model([north, south]));
  close(total(result), 0.1118);
  assert.ok(result.flatMap(r => r.pts).every(q => q[0] <= 2.52 + 1e-8));
});

test('overlapping door cuts do not duplicate threshold floor area', () => {
  const wall = { id: 'overlap-wall', ax: 0, ay: 0, bx: 4, by: 0, thickness: 0.2 };
  const rooms = [{ id: 'a', pts: [[0, 0.1], [4, 0.1], [4, 2], [0, 2]] }, { id: 'b', pts: [[0, -2], [4, -2], [4, -0.1], [0, -0.1]] }];
  const doors = [{ id: 'one', wallId: wall.id, type: 'door', t: 0.5, width: 1, height: 2 }, { id: 'two', wallId: wall.id, type: 'door', t: 0.55, width: 1, height: 2 }];
  const patches = thresholdFloors({ walls: [wall], openings: doors, rooms });
  const area = pts => Math.abs(pts.reduce((sum, p, i) => { const q = pts[(i + 1) % pts.length]; return sum + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;
  assert.ok(Math.abs(patches.reduce((sum, p) => sum + area(p.pts), 0) - 0.24) < 1e-8);
});
