import assert from 'node:assert/strict';
import { test } from 'node:test';
import { wallFaces, faceAt, roomFromWalls, sameFloor } from '../js/roomfill.js';
import { planWallMove, applyWallMove, planCornerMove, applyCornerMove, floorCornerAttached } from '../js/wallmove.js';
import { demoWorkspace } from '../js/demo.js';

const wall = (id, ax, ay, bx, by, thickness = 0.114) => ({ id, ax, ay, bx, by, thickness });
// A 6 x 4 m box of 165 mm exterior walls.
const box = () => [
  wall('south', 0, 0, 6, 0, 0.165), wall('east', 6, 0, 6, 4, 0.165),
  wall('north', 6, 4, 0, 4, 0.165), wall('west', 0, 4, 0, 0, 0.165),
];
const area = pts => Math.abs(pts.reduce((s, p, i) => { const q = pts[(i + 1) % pts.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;
const samePts = (got, want, msg) => {
  assert.ok(got, `${msg}: no room`);
  assert.equal(got.length, want.length, `${msg}: ${JSON.stringify(got)}`);
  got.forEach((p, i) => assert.ok(Math.hypot(p[0] - want[i][0], p[1] - want[i][1]) < 1e-9, `${msg}: corner ${i} ${p} != ${want[i]}`));
};
// A corner on a wall's centre line, not merely within its thickness.
const onCentreLine = (walls, [x, y]) => walls.some(w => {
  const L = Math.hypot(w.bx - w.ax, w.by - w.ay);
  const s = ((x - w.ax) * (w.bx - w.ax) + (y - w.ay) * (w.by - w.ay)) / L;
  const d = ((x - w.ax) * (w.by - w.ay) - (y - w.ay) * (w.bx - w.ax)) / L;
  return Math.abs(d) < 1e-9 && s > -1e-9 && s < L + 1e-9;
});

test('a click inside each demo room fills exactly the floor the demo draws there', () => {
  const p = demoWorkspace().properties[0];
  assert.equal(wallFaces(p.walls).length, 4, 'four enclosed areas');
  for (const r of p.rooms) {
    const [cx, cy] = r.pts.reduce((s, q) => [s[0] + q[0] / r.pts.length, s[1] + q[1] / r.pts.length], [0, 0]);
    const pts = roomFromWalls(p.walls, cx + 0.4, cy - 0.3);
    samePts(pts, r.pts, r.name);
    for (const c of pts) assert.ok(onCentreLine(p.walls, c), `${r.name} corner ${c} on a wall centre line`);
    assert.equal(sameFloor(p.rooms, pts), r, `${r.name} already has this floor`);
  }
});

test('T-junction corners on the far side of a wall are not floor corners', () => {
  // The kitchen's south edge runs along the partition the living-room wall meets at x = 7.3.
  const p = demoWorkspace().properties[0];
  const kitchen = roomFromWalls(p.walls, 9, 2);
  assert.ok(!kitchen.some(c => c[0] === 7.3), JSON.stringify(kitchen));
  // The living room's north edge runs past the dining wall's end at x = 5.
  const living = roomFromWalls(p.walls, 2, 6);
  assert.ok(!living.some(c => c[0] === 5), JSON.stringify(living));
});

test('a floor filled from walls follows a wall drag and a corner drag', () => {
  const p = demoWorkspace().properties[0];
  const walls = p.walls;
  const rooms = [{ id: 'dining', pts: roomFromWalls(walls, 2, 2) }, { id: 'kitchen', pts: roomFromWalls(walls, 9, 2) }];
  for (const r of rooms) for (const c of r.pts) assert.ok(floorCornerAttached(walls, c[0], c[1]));
  const part = walls.find(w => w.id === 'w-int-2');   // x = 5, between dining and kitchen
  applyWallMove(planWallMove(part, walls, rooms, []), 0.5);
  const x = part.ax;
  assert.notEqual(x, 5);
  assert.equal(rooms[0].pts.filter(c => c[0] === x).length, 2, 'dining keeps both corners on the partition');
  assert.equal(rooms[1].pts.filter(c => c[0] === x).length, 2, 'kitchen keeps both corners on the partition');
  // Drag the house's north-east corner out 1 m: the kitchen's corner goes with it.
  const ne = walls.find(w => w.id === 'w-ext-n');
  applyCornerMove(planCornerMove(ne, 'b', walls, rooms, []), 13.2, -1);
  assert.ok(rooms[1].pts.some(c => c[0] === 13.2 && c[1] === -1), JSON.stringify(rooms[1].pts));
});

test('a click on a wall, outside the walls or inside an open loop fills nothing', () => {
  const walls = box();
  assert.equal(roomFromWalls(walls, 3, 0.05), null, 'inside the south wall');
  assert.equal(roomFromWalls(walls, 3, -0.5), null, 'outside the house');
  const open = walls.filter(w => w.id !== 'east');
  assert.equal(roomFromWalls(open, 3, 2), null, 'one wall missing');
  assert.deepEqual(wallFaces(open), []);
  assert.equal(roomFromWalls([], 0, 0), null);
});

test('crossing walls split into four rooms', () => {
  const walls = [...box(), wall('ns', 3, 0, 3, 4), wall('ew', 0, 2, 6, 2)];
  samePts(roomFromWalls(walls, 1, 1), [[0, 0], [3, 0], [3, 2], [0, 2]], 'north-west');
  samePts(roomFromWalls(walls, 5, 3), [[3, 2], [6, 2], [6, 4], [3, 4]], 'south-east');
  assert.equal(wallFaces(walls).length, 4);
});

test('a partition stopping at the face of a wall still closes the room on its centre line', () => {
  const h = 0.165 / 2;
  // Ends at the inside face of the south wall and 1 cm short of the north wall's face.
  const walls = [...box(), wall('mid', 3, h, 3, 4 - h - 0.01)];
  samePts(roomFromWalls(walls, 1.5, 2), [[0, 0], [3, 0], [3, 4], [0, 4]], 'left');
  samePts(roomFromWalls(walls, 4.5, 2), [[3, 0], [6, 0], [6, 4], [3, 4]], 'right');
  // A partition that runs through a wall and out the other side is cut at its centre line.
  const through = [...box(), wall('mid', 3, -0.3, 3, 4.3)];
  samePts(roomFromWalls(through, 1.5, 2), [[0, 0], [3, 0], [3, 4], [0, 4]], 'through');
});

test('walls drawn to an outside corner instead of meeting meet anyway', () => {
  const h = 0.165 / 2;
  // The east wall stops at the outer face of the south wall, and the south wall stops
  // short of the east wall's centre line by half its thickness.
  const walls = [
    wall('south', 0, 0, 6 - h, 0, 0.165), wall('east', 6, -h, 6, 4, 0.165),
    wall('north', 6, 4, 0, 4, 0.165), wall('west', 0, 4, 0, 0, 0.165),
  ];
  samePts(roomFromWalls(walls, 3, 2), [[0, 0], [6, 0], [6, 4], [0, 4]], 'closed');
});

test('stubs, collinear wall pieces and short joints leave a clean outline', () => {
  const walls = [
    wall('s1', 0, 0, 2.5, 0, 0.165), wall('s2', 2.5, 0, 6, 0, 0.165),            // two pieces, one line
    wall('east', 6.005, 0.004, 6, 4, 0.165),                                       // a 6 mm joint gap
    wall('north', 6, 4, 0, 4, 0.165), wall('west', 0, 4, 0, 0, 0.165),
    wall('stub', 6, 2, 4.8, 2),                                                    // a peninsula
  ];
  const pts = roomFromWalls(walls, 2, 2);
  assert.equal(pts.length, 4, JSON.stringify(pts));
  for (const c of pts) assert.ok(floorCornerAttached(walls, c[0], c[1]), `${c} attached`);
  assert.ok(Math.abs(area(pts) - 24) < 0.05);
});

test('the smallest enclosing area wins: a closet inside a room', () => {
  const walls = [...box(),
    wall('c1', 4, 1, 5, 1), wall('c2', 5, 1, 5, 2), wall('c3', 5, 2, 4, 2), wall('c4', 4, 2, 4, 1)];
  samePts(roomFromWalls(walls, 4.5, 1.5), [[4, 1], [5, 1], [5, 2], [4, 2]], 'closet');
  samePts(roomFromWalls(walls, 1, 1), [[0, 0], [6, 0], [6, 4], [0, 4]], 'room around it');
  const faces = wallFaces(walls);
  assert.equal(faceAt(faces, 4.5, 1.5).area, 1);
  assert.equal(faceAt(faces, 7, 7), null);
});

test('angled walls: a bay with a diagonal corner', () => {
  const walls = [
    wall('a', 0, 0, 4, 0), wall('b', 4, 0, 5, 1), wall('c', 5, 1, 5, 4),
    wall('d', 5, 4, 0, 4), wall('e', 0, 4, 0, 0),
  ];
  const pts = roomFromWalls(walls, 2, 2);
  samePts(pts, [[0, 0], [4, 0], [5, 1], [5, 4], [0, 4]], 'bay');
  for (const c of pts) assert.ok(onCentreLine(walls, c));
});

test('sameFloor matches an outline drawn with extra straight-through corners, not a different one', () => {
  const pts = [[0, 0], [6, 0], [6, 4], [0, 4]];
  const drawn = { id: 'drawn', pts: [[6, 4], [0, 4], [0, 0], [3, 0.005], [6, 0]] };
  assert.equal(sameFloor([drawn], pts), drawn);
  assert.equal(sameFloor([{ id: 'half', pts: [[0, 0], [3, 0], [3, 4], [0, 4]] }], pts), null);
  assert.equal(sameFloor([{ id: 'bad', pts: [[0, 0]] }], pts), null);
});
