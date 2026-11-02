import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scanToPlan } from '../js/scan2plan-core.js';
import { mergeProposal } from '../js/scanmerge.js';
import { polyArea, roomsFloorArea } from '../js/store.js';
import { rowhouseScan } from './fixtures/rowhouse-scan.mjs';

const plan = opts => { const { pos, idx } = rowhouseScan(opts); return scanToPlan(pos, idx).levels[0]; };
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} is not within ${tol} of ${b}`);
const vertical = w => Math.abs(w.ax - w.bx) < 1e-6, horizontal = w => Math.abs(w.ay - w.by) < 1e-6;
const along = (w, lo, hi) => Math.min(w.ay, w.by) <= lo && Math.max(w.ay, w.by) >= hi;
const inside = (P, [x, y]) => {
  let r = false;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    if ((P[i][1] > y) !== (P[j][1] > y) && x < (P[j][0] - P[i][0]) * (y - P[i][1]) / (P[j][1] - P[i][1]) + P[i][0]) r = !r;
  }
  return r;
};
const stairWall = L => L.walls.find(w => vertical(w) && Math.abs(w.ax - 1.6) < 0.08 && along(w, 5.5, 10.2));
const doorsOn = (L, w) => L.openings.filter(o => o.wallId === w.id && o.type === 'door');
const doorCentre = (w, o) => w.ay + (w.by - w.ay) * o.t;

test('a wall scanned from one side keeps its scanned face and grows outward', () => {
  const L = plan();
  const east = L.walls.find(w => vertical(w) && w.ax > 4.5);
  assert.ok(east && east.exterior);
  near(east.ax - east.thickness / 2, 5.0, 0.03, 'East party wall inside face');
  assert.ok(east.ax > 5.05, 'The east wall stands outside the room, not half in it');
  const west = L.walls.find(w => vertical(w) && w.ax < 0.5);
  near(west.ax + west.thickness / 2, 0, 0.03, 'West party wall inside face');
  // Both faces of the partition were scanned: it stays centred and joins the party walls'
  // centre lines, not their old scanned faces.
  const part = L.walls.find(w => horizontal(w) && Math.abs(w.ay - 12) < 0.2);
  near(part.ay, 12, 0.03, 'Partition centre');
  assert.ok(part.thickness < 0.18 && !part.exterior);
  near(Math.min(part.ax, part.bx), west.ax, 0.02, 'Partition reaches the west wall line');
  near(Math.max(part.ax, part.bx), east.ax, 0.02, 'Partition reaches the east wall line');
  // Rooms stop at the scanned faces, so floor area stays the measured inside area.
  const back = L.rooms.find(r => r.pts.every(([, y]) => y >= 11.9));
  near(back.area, 10, 0.25, 'Back room area');
  near(Math.max(...back.pts.map(p => p[0])), 5.0, 0.03, 'Back room east edge');
});

test('an unscanned stair along a party wall continues the wall and becomes an unscanned area', () => {
  const L = plan();
  const west = L.walls.filter(w => vertical(w) && Math.abs(w.ax + 0.1) < 0.1);
  assert.equal(west.length, 1, 'One straight party wall, no bite out of the plan');
  assert.ok(along(west[0], 0, 14) && west[0].exterior);
  const unscanned = L.rooms.filter(r => r.kind === 'unscanned');
  assert.equal(unscanned.length, 1);
  const u = unscanned[0];
  assert.match(u.name, /unscanned/i);
  assert.equal(u.material, null);
  assert.ok(u.area > 6 && u.area < 9.7, `Unscanned area ${u.area}`);
  assert.ok(u.pts.every(([x, y]) => x > -0.05 && x < 1.75 && y > 4.95 && y < 10.75), 'Stays within the stair');
  const rooms = L.rooms.filter(r => r.kind !== 'unscanned');
  assert.ok(!rooms.some(r => inside(r.pts, [0.8, 7.8])), 'No measured room covers the stair');
  // The walls around the stair are inside the envelope now; no window is looked for in them.
  assert.equal(stairWall(L).exterior, false);
  assert.ok(Math.abs(L.floorArea - 60.3) < 1.5, `Scanned footprint ${L.floorArea}`);
  const counted = roomsFloorArea(L.rooms);
  near(counted, rooms.reduce((n, r) => n + polyArea(r.pts), 0), 1e-9, 'Counted floor area');
  assert.ok(counted < 61, 'The unscanned area is not floor area');
});

test('a door onto unscanned space is kept with lower confidence', () => {
  for (const [door, evidence] of [['leaf', 'leaf'], ['beyond', 'beyond']]) {
    const L = plan({ door });
    const w = stairWall(L), doors = doorsOn(L, w);
    assert.equal(doors.length, 1, `${door}: one door in the stair wall`);
    assert.equal(doors[0].confidence, 'low');
    assert.equal(doors[0].evidence, evidence);
    near(doors[0].width, 0.72, 0.12, `${door}: door width`);
    near(doorCentre(w, doors[0]), 6.36, 0.1, `${door}: door position`);
    near(doors[0].height, 2.0, 0.1, `${door}: door height from the header`);
  }
  // With floor scanned through the threshold it is an ordinary door.
  const L = plan({ threshold: true }), d = doorsOn(L, stairWall(L));
  assert.equal(d.length, 1);
  assert.equal(d[0].evidence, 'threshold');
  assert.equal(d[0].confidence, undefined);
});

test('a gap with nothing beyond it, or without a header, is still not a door', () => {
  for (const door of ['none', 'noheader']) {
    const L = plan({ door });
    assert.equal(L.openings.filter(o => o.wallId === stairWall(L).id).length, 0, `${door}: no opening`);
  }
  // A window over a sideboard (no floor below, door-height head, nothing beyond) stays a window.
  const L = plan({ stair: false, sideboard: true });
  const front = L.walls.find(w => horizontal(w) && w.ay < 0.5);
  const ops = L.openings.filter(o => o.wallId === front.id);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].type, 'window');
  near(ops[0].width, 1.5, 0.15, 'Window width');
});

test('an unscanned notch the envelope cannot close stays a notch', () => {
  // Floor stops short of the party wall but no wall closes the strip off: just unscanned floor.
  const open = plan({ stair: 'open' });
  assert.equal(open.rooms.filter(r => r.kind === 'unscanned').length, 0);
  assert.ok(!open.walls.some(w => vertical(w) && w.ax < 0.5 && along(w, 5.5, 10.2)), 'Party wall not invented across open floor');
  // The strip reaches the back wall (an L-shaped plan): no wall on the far side to continue to.
  const corner = plan({ stair: 'corner' });
  assert.equal(corner.rooms.filter(r => r.kind === 'unscanned').length, 0);
  assert.ok(!corner.walls.some(w => vertical(w) && w.ax < 0.5 && Math.max(w.ay, w.by) > 6), 'Party wall not extended past the scan');
});

test('the property keeps the unscanned area and the door evidence, outside floor area', () => {
  const { pos, idx } = rowhouseScan();
  const r = scanToPlan(pos, idx);
  Object.assign(r, { transform: { pos: [0, -r.baseY, 0], rot: [0, r.rotationDeg, 0] }, mainLevelIndex: 0, wallHeight: 2.4 });
  const prop = { levels: [], walls: [], openings: [], rooms: [], scans: [] };
  let n = 0;
  mergeProposal(prop, { id: 's' }, r, null, 'replace', p => p + ++n);
  const u = prop.rooms.filter(x => x.kind === 'unscanned');
  assert.equal(u.length, 1);
  assert.match(u[0].name, /verify/);
  assert.deepEqual(prop.rooms.filter(x => !x.kind).map(x => x.name), ['Room 1', 'Room 2']);
  const all = prop.rooms.reduce((s, x) => s + polyArea(x.pts), 0);
  near(roomsFloorArea(prop.rooms), all - polyArea(u[0].pts), 1e-9, 'Floor area leaves out the unscanned area');
  const low = prop.openings.filter(o => o.confidence === 'low');
  assert.equal(low.length, 1);
  assert.equal(low[0].evidence, 'leaf');
  assert.ok(!prop.openings.some(o => o.confidence !== 'low' && 'evidence' in o), 'Ordinary doors carry no extra fields');
});
