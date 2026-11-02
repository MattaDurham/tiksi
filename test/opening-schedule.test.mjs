// Opening schedule numbering, the rooms each opening joins, and size edits that must fit the wall.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openingSchedule, connectsLabel, resizeOpening } from '../js/opening-schedule.js';
import { GeometryHistory } from '../js/geometry-history.js';

// Two storeys of a synthetic 6 x 4 m box. Ground: a partition at x = 3 makes two outlined rooms.
function house() {
  const wall = (id, level, ax, ay, bx, by) => ({ id, level, ax, ay, bx, by, thickness: 0.15 });
  const room = (id, level, name, x0, x1) => ({ id, level, name, pts: [[x0, 0], [x1, 0], [x1, 4], [x0, 4]] });
  return {
    id: 'synthetic', activeLevelId: 'upper',
    levels: [{ id: 'upper', name: 'Upper', elevation: 3, height: 2.7, plan: null }, { id: 'ground', name: 'Ground', elevation: 0, height: 2.7, plan: null }],
    walls: [
      wall('s', 'ground', 0, 0, 6, 0), wall('e', 'ground', 6, 0, 6, 4), wall('n', 'ground', 6, 4, 0, 4), wall('w', 'ground', 0, 4, 0, 0),
      wall('mid', 'ground', 3, 0, 3, 4),
      wall('us', 'upper', 0, 0, 6, 0), wall('ue', 'upper', 6, 0, 6, 4), wall('un', 'upper', 6, 4, 0, 4), wall('uw', 'upper', 0, 4, 0, 0),
    ],
    rooms: [room('k', 'ground', 'Kitchen', 0, 3), room('l', 'ground', 'Living', 3, 6)],
    openings: [
      { id: 'o-up', wallId: 'us', t: 0.5, type: 'door', width: 0.8, height: 2.03 },
      { id: 'o-front', wallId: 's', t: 0.25, type: 'door', width: 0.9, height: 2.03 },
      { id: 'o-mid', wallId: 'mid', t: 0.5, type: 'door', width: 0.76, height: 2.03 },
      { id: 'o-win2', wallId: 'n', t: 0.25, type: 'window', width: 1.2, height: 1.2, sill: 0.8 },
      { id: 'o-win1', wallId: 'n', t: 0.75, type: 'window', width: 1.2, height: 1.2, sill: 0.8 },
    ],
  };
}
const numbers = p => Object.fromEntries(openingSchedule(p).map(r => [r.id, r.number]));

test('doors and windows number separately, lower level first, then top to bottom and left to right', () => {
  assert.deepEqual(numbers(house()), { 'o-front': 'D1', 'o-mid': 'D2', 'o-win1': 'W1', 'o-win2': 'W2', 'o-up': 'D3' });
  const ground = openingSchedule(house(), 'ground');
  assert.deepEqual(ground.map(r => r.number), ['D1', 'D2', 'W1', 'W2'], 'one level keeps the property-wide numbers');
  assert.deepEqual(openingSchedule(house(), 'upper').map(r => r.number), ['D3']);
});

test('numbers do not move for size edits, list order or unrelated walls and rooms', () => {
  const before = numbers(house());
  const p = house();
  p.openings.reverse();
  p.openings.find(o => o.id === 'o-mid').width = 0.7;
  p.openings.find(o => o.id === 'o-win1').height = 1.5;
  p.walls.find(w => w.id === 'e').material = 'remote finish';
  p.walls.push({ id: 'shed', level: 'ground', ax: 10, ay: 10, bx: 12, by: 10, thickness: 0.1 });
  p.rooms.push({ id: 'shed-room', level: 'ground', name: 'Shed', pts: [[10, 10], [12, 10], [12, 12], [10, 12]] });
  assert.deepEqual(numbers(p), before);
  // Adding an opening shifts only the ones after it in the sweep.
  p.openings.push({ id: 'o-new', wallId: 'e', t: 0.5, type: 'door', width: 0.8, height: 2 });
  const after = numbers(p);
  assert.equal(after['o-front'], 'D1'); assert.equal(after['o-mid'], 'D2'); assert.equal(after['o-new'], 'D3'); assert.equal(after['o-up'], 'D4');
});

test('each opening names the rooms it joins, inside first, or the outside', () => {
  const rows = Object.fromEntries(openingSchedule(house()).map(r => [r.id, r]));
  assert.equal(connectsLabel(rows['o-mid']), 'Kitchen / Living');
  assert.equal(connectsLabel(rows['o-front']), 'Kitchen / Exterior');
  assert.equal(connectsLabel(rows['o-win1']), 'Kitchen / Exterior');
  assert.equal(connectsLabel(rows['o-win2']), 'Living / Exterior');
  assert.equal(rows['o-mid'].sides.map(s => s.roomId).sort().join(), 'k,l');
  assert.equal(connectsLabel(rows['o-up']), 'Unoutlined space / Exterior', 'walls close the upper floor but nobody outlined it');
  assert.equal(rows['o-win1'].sill, 0.8); assert.equal(rows['o-front'].sill, null);
});

test('openings on missing walls are left out instead of breaking the schedule', () => {
  const p = house();
  p.openings.push({ id: 'orphan', wallId: 'gone', t: 0.5, type: 'door', width: 0.8, height: 2 });
  p.levels = [];
  const rows = openingSchedule(p);
  assert.equal(rows.length, 5); assert(!rows.some(r => r.id === 'orphan'));
});

test('a typed size fits the wall: width within its length, centre kept on it, height under the top', () => {
  const p = house(), front = p.openings.find(o => o.id === 'o-front');
  assert.deepEqual(resizeOpening(p, front, { width: 0.813, height: 2.032 }, 2.7), { width: 0.813, height: 2.032 });
  assert.equal(front.t, 0.25, 'a size that fits does not move the opening');
  resizeOpening(p, front, { width: 9 }, 2.7);
  assert.ok(Math.abs(front.width - 5.96) < 1e-9, 'a 6 m wall takes at most 5.96 m');
  assert.equal(front.t, 0.5);
  const near = p.openings.find(o => o.id === 'o-win2');
  near.t = 0.1; resizeOpening(p, near, { width: 2 }, 2.7);
  assert.ok(Math.abs((near.t * 6 - 1) - 0.02) < 1e-9, 'a wider window slides off the corner just enough');
  resizeOpening(p, near, { height: 3 }, 2.7);
  assert.ok(Math.abs(near.height - 1.9) < 1e-9, 'sill 0.8 m + height stays under a 2.7 m wall');
});

test('unreadable or tiny sizes are refused without touching the opening', () => {
  const p = house(), o = p.openings.find(o => o.id === 'o-mid'), was = JSON.stringify(o);
  for (const bad of [NaN, 0, 0.01, -1, Infinity]) assert.equal(resizeOpening(p, o, { width: bad }, 2.7), null);
  assert.equal(resizeOpening(p, o, { width: 0.8, height: NaN }, 2.7), null, 'one bad value refuses the whole edit');
  assert.equal(JSON.stringify(o), was);
  assert.equal(resizeOpening(p, { id: 'x', wallId: 'gone', t: 0.5, width: 1, height: 1 }, { width: 0.8 }), null);
});

test('a schedule size edit is one undo step and redo replays it', () => {
  const p = house(), h = new GeometryHistory(), o = p.openings.find(o => o.id === 'o-mid');
  h.begin(p, 'resize D2'); resizeOpening(p, o, { width: 0.711 }, 2.7); h.commit(p);
  assert.equal(h.state(p, 'undo').label, 'resize D2');
  assert.equal(h.restore(p, 'undo'), true); assert.equal(p.openings.find(o => o.id === 'o-mid').width, 0.76);
  assert.equal(h.restore(p, 'redo'), true); assert.equal(p.openings.find(o => o.id === 'o-mid').width, 0.711);
});
