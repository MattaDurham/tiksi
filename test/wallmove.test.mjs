import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  planWallMove, applyWallMove, normalOffset, planCornerMove, applyCornerMove,
  floorCornerAttached, floorCornersOf, snapFloorToWalls,
} from '../js/wallmove.js';

// Two rooms side by side: a 6 x 4 m box split by an interior wall at x = 3 that ends on the
// top and bottom walls mid-span. Room corners sit on wall centre lines, as scan2plan and the
// plan editor's snapping put them.
function house() {
  const wall = (id, ax, ay, bx, by, thickness = 0.114) => ({ id, ax, ay, bx, by, thickness });
  const walls = [
    wall('south', 0, 0, 6, 0, 0.165), wall('east', 6, 0, 6, 4, 0.165),
    wall('north', 6, 4, 0, 4, 0.165), wall('west', 0, 4, 0, 0, 0.165),
    wall('mid', 3, 0, 3, 4),
  ];
  const rooms = [
    { id: 'left', pts: [[0, 0], [3, 0], [3, 4], [0, 4]] },
    { id: 'right', pts: [[3, 0], [6, 0], [6, 4], [3, 4]] },
  ];
  // A door 1.5 m from the north wall's start (at x = 6), a window centred on the south wall.
  const openings = [
    { id: 'door', wallId: 'north', t: 0.25, width: 0.8 },
    { id: 'win', wallId: 'south', t: 0.5, width: 0.9 },
  ];
  return { walls, rooms, openings, by: id => walls.find(w => w.id === id) };
}
const area = pts => Math.abs(pts.reduce((s, p, i) => { const q = pts[(i + 1) % pts.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} != ${b}`);

test('an interior wall slides along its normal and the rooms on both sides follow', () => {
  const h = house();
  const mid = h.by('mid');
  const plan = planWallMove(mid, h.walls, h.rooms, h.openings);
  assert.equal(plan.connected, true);
  // The pointer moves diagonally; only the component along the normal counts.
  applyWallMove(plan, normalOffset(plan, 1, 0.7));
  assert.deepEqual([mid.ax, mid.ay, mid.bx, mid.by], [4, 0, 4, 4]);
  // The walls it abuts run through; they do not move.
  assert.deepEqual([h.by('south').ax, h.by('south').bx, h.by('north').ax, h.by('north').bx], [0, 6, 6, 0]);
  close(area(h.rooms[0].pts), 16, 'left room grows');
  close(area(h.rooms[1].pts), 8, 'right room shrinks');
});

test('an exterior wall drags its corners, stretches the joined walls and keeps doors in place', () => {
  const h = house();
  const east = h.by('east');
  const plan = planWallMove(east, h.walls, h.rooms, h.openings);
  applyWallMove(plan, normalOffset(plan, 1, 0));
  assert.deepEqual([east.ax, east.bx], [7, 7]);
  assert.equal(h.by('south').bx, 7, 'south wall reaches the new corner');
  assert.equal(h.by('north').ax, 7, 'north wall reaches the new corner');
  assert.deepEqual([h.by('west').ax, h.by('west').bx], [0, 0], 'the far wall stays');
  // The door was 1.5 m from the north wall's moving end; it stays 1.5 m from the fixed end
  // measured the other way, i.e. at the same x in the room.
  const north = h.by('north');
  const doorX = north.ax + (north.bx - north.ax) * h.openings[0].t;
  close(doorX, 4.5, 'door x');
  close(area(h.rooms[1].pts), 16, 'right room grows by 4 m2');
  close(area(h.rooms[0].pts), 12, 'left room unchanged');
});

test('dragging one segment of a split straight wall moves the whole run', () => {
  const h = house();
  const south = h.by('south');
  h.walls.splice(h.walls.indexOf(south), 1,
    { id: 's1', ax: 0, ay: 0, bx: 3, by: 0, thickness: 0.165 },
    { id: 's2', ax: 3, ay: 0, bx: 6, by: 0, thickness: 0.165 });
  const plan = planWallMove(h.by('s1'), h.walls, h.rooms, []);
  assert.deepEqual(plan.runIds.sort(), ['s1', 's2']);
  applyWallMove(plan, normalOffset(plan, 0, -1));
  for (const id of ['s1', 's2']) assert.deepEqual([h.by(id).ay, h.by(id).by], [-1, -1], id);
  assert.equal(h.by('mid').ay, -1, 'the interior wall ending on the run stretches with it');
  assert.equal(h.by('west').by, -1);
  assert.equal(h.by('east').ay, -1);
});

test('a parallel wall on another line is left alone', () => {
  const h = house();
  h.walls.push({ id: 'far', ax: 0, ay: 10, bx: 6, by: 10, thickness: 0.114 });
  const plan = planWallMove(h.by('south'), h.walls, h.rooms, []);
  applyWallMove(plan, -0.5);
  assert.deepEqual([h.by('far').ay, h.by('far').by], [10, 10]);
});

test('an unconnected wall reports that nothing is attached', () => {
  const plan = planWallMove({ id: 'w', ax: 0, ay: 0, bx: 2, by: 0 }, [{ id: 'w', ax: 0, ay: 0, bx: 2, by: 0 }], [], []);
  assert.equal(plan.connected, false);
  assert.equal(planWallMove({ id: 'z', ax: 1, ay: 1, bx: 1, by: 1 }, [], [], []), null);
});

test('a corner drag moves every wall end and room corner at the joint', () => {
  const h = house();
  const east = h.by('east');
  const plan = planCornerMove(east, 'b', h.walls, h.rooms, h.openings);
  assert.deepEqual(plan.wallIds.sort(), ['east', 'north']);
  applyCornerMove(plan, 6.5, 5);
  assert.deepEqual([east.bx, east.by], [6.5, 5]);
  assert.deepEqual([h.by('north').ax, h.by('north').ay], [6.5, 5]);
  assert.deepEqual(h.rooms[1].pts[2], [6.5, 5]);
  // The north wall now pivots about (0, 4). The partition that ends on it and the floor
  // corners at that T slide up the partition's line to stay on it; the far corners stay.
  const yAt3 = 4 + 3 / 6.5;
  close(h.by('mid').bx, 3, 'partition keeps its line'); close(h.by('mid').by, yAt3, 'partition reaches the turned wall');
  for (const r of h.rooms) { const c = r.pts.find(p => p[0] === 3 && p[1] > 4); assert.ok(c, r.id + ' corner at the T'); close(c[1], yAt3, r.id + ' corner follows'); }
  assert.deepEqual(h.rooms[0].pts[0], [0, 0]);
  assert.deepEqual(h.rooms[0].pts[3], [0, 4], 'the pivot corner stays');
});

// Floors traced at the inside faces of the walls (the way a hand-drawn outline often is),
// one corner 15 mm short of the face: every corner inside a wall as drawn is attached.
function tracedFloor() {
  const h = house();
  h.rooms = [{ id: 'right', pts: [[3.057, 0.0825], [5.9175, 0.0825], [5.9175, 3.9175], [3.057, 3.9025]] }];
  return h;
}

test('wall and corner drags agree on which floor corners are attached', () => {
  let h = tracedFloor();
  for (const [x, y] of h.rooms[0].pts) assert.ok(floorCornerAttached(h.walls, x, y), `corner ${x},${y} is on a wall`);
  const east = h.by('east');
  applyWallMove(planWallMove(east, h.walls, h.rooms, []), normalOffset(planWallMove(east, h.walls, h.rooms, []), 1, 0));
  assert.deepEqual(h.rooms[0].pts.map(p => p[0]), [3.057, 6.9175, 6.9175, 3.057], 'a wall drag carries both face corners');
  // The same corners ride along when the east wall's top corner is dragged instead.
  h = tracedFloor();
  const plan = planCornerMove(h.by('east'), 'b', h.walls, h.rooms, []);
  assert.equal(floorCornersOf(plan).length, 3, 'every corner on the east or north wall is carried; the south-west one is on walls that stay');
  applyCornerMove(plan, 7, 4);
  assert.deepEqual(h.rooms[0].pts[2], [6.9175, 3.9175], 'the inside corner at the joint moves with it');
  // The lower face corner slides along the floor's south edge to stay on the turned wall's face.
  const [x, y] = h.rooms[0].pts[1];
  close(y, 0.0825, 'south edge keeps its line');
  const ux = 1 / Math.hypot(1, 4), uy = 4 / Math.hypot(1, 4);   // east wall now (6,0) -> (7,4)
  close(Math.abs((x - 6) * -uy + y * ux), 0.0825, 'corner stays on the inside face');
});

test('a floor edge running past the end of a wall moves as a whole', () => {
  // An open plan: a short wall from (0,0) to (2,0); the floor's south edge carries on to x = 5.
  const walls = [{ id: 'w', ax: 0, ay: 0, bx: 2, by: 0, thickness: 0.114 }];
  const room = { id: 'r', pts: [[0, 0], [5, 0], [5, 3], [0, 3]] };
  const plan = planWallMove(walls[0], walls, [room], []);
  applyWallMove(plan, normalOffset(plan, 0, -0.5));
  assert.deepEqual(room.pts, [[0, -0.5], [5, -0.5], [5, 3], [0, 3]], 'the edge stays straight');
});

test('a corner dragged along its own wall leaves what is attached mid-span in place', () => {
  const h = house();
  const door = { id: 'd', wallId: 'mid', t: 0.5, width: 0.8 };
  const plan = planCornerMove(h.by('south'), 'b', h.walls, h.rooms, [door]);   // SE corner (6,0)
  applyCornerMove(plan, 7, 0);
  assert.deepEqual([h.by('mid').ax, h.by('mid').ay], [3, 0], 'the partition end on the south wall stays');
  assert.deepEqual(h.rooms[0].pts, [[0, 0], [3, 0], [3, 4], [0, 4]]);
  assert.deepEqual(h.rooms[1].pts[1], [7, 0]);
  assert.equal(door.t, 0.5, 'nothing moved on the partition');
});

test('a partition that stretches to follow a turned wall keeps its door in place', () => {
  const h = house();
  // Door 1 m from the partition's top end (3,4); the bottom end (3,0) is on the south wall.
  const door = { id: 'd', wallId: 'mid', t: 0.75, width: 0.8 };
  const plan = planCornerMove(h.by('south'), 'a', h.walls, h.rooms, [door]);  // SW corner (0,0) -> (0,-1)
  applyCornerMove(plan, 0, -1);
  const mid = h.by('mid');
  assert.deepEqual([mid.ax, mid.ay, mid.bx, mid.by], [3, -0.5, 3, 4], 'the partition reaches the turned wall');
  close((1 - door.t) * (mid.by - mid.ay), 1, 'door stays 1 m from the fixed end');
  assert.deepEqual(h.rooms[0].pts[1], [3, -0.5], 'the floor corner at the T follows');
});

test('a floor corner clear of every wall is loose, and snapping attaches it', () => {
  const h = house();
  h.rooms[0].pts[2] = [3.2, 3.85];               // 20 cm off the partition, inside the room
  assert.equal(floorCornerAttached(h.walls, 3.2, 3.85), false);
  const plan = planWallMove(h.by('mid'), h.walls, h.rooms, []);
  applyWallMove(plan, normalOffset(plan, 0.5, 0));
  assert.deepEqual(h.rooms[0].pts[2], [3.2, 3.85], 'a loose corner does not move');
  const h2 = house();
  h2.rooms[0].pts[2] = [3.2, 3.85];
  h2.rooms[0].pts.push([1.5, 4.25]);           // a corner 25 cm outside the north wall's centre line
  assert.equal(snapFloorToWalls(h2.rooms[0], h2.walls), 2);
  assert.deepEqual(h2.rooms[0].pts[2], [3, 4], 'snaps to the nearby wall end');
  assert.deepEqual(h2.rooms[0].pts[4], [1.5, 4], 'snaps onto the centre line');
  assert.equal(snapFloorToWalls(h2.rooms[0], h2.walls), 0, 'attached corners are left alone');
  const far = { id: 'f', pts: [[1.5, 2], [2, 2], [2, 2.5]] };
  assert.equal(snapFloorToWalls(far, h2.walls), 0, 'a corner out of reach stays');
});
