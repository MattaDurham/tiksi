// Scope items measured from the model (js/scope-takeoff.js): a room added to a project brings its
// wall, floor, ceiling and trim quantities; picking the work and finish level fills the unit
// and the price book's prices. Synthetic plans only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { roomFaces } from '../js/room-faces.js';
import {
  measureRoom, measureFace, measureObjects, combineMeasured, takeoffItem, setWork, useMeasure, priceEdited,
  repriceProject, worksForItem, workById, costAreaFor, areaFactor, SQFT, FT,
} from '../js/scope-takeoff.js';
import { PRICE_BOOK } from '../js/price-book.js';

const T = 0.15, H = 2.5;
const wall = (id, ax, ay, bx, by) => ({ id, ax, ay, bx, by, thickness: T });
const near = (a, b, msg, tol = 0.05) => assert.ok(Math.abs(a - b) < tol, `${msg}: ${a} is not ${b}`);
// A 4 x 3 m room (x east, y south) with a 0.9 x 2.03 m door in the south wall and a
// 1.2 x 1.2 m window in the north wall.
function plan() {
  const walls = [wall('n', 0, 0, 4, 0), wall('e', 4, 0, 4, 3), wall('s', 4, 3, 0, 3), wall('w', 0, 3, 0, 0)];
  const rooms = [{ id: 'bed', name: 'Bedroom', pts: [[0, 0], [4, 0], [4, 3], [0, 3]] }];
  const openings = [{ id: 'd', wallId: 's', type: 'door', t: 0.5, width: 0.9, height: 2.03 },
    { id: 'w1', wallId: 'n', type: 'window', t: 0.5, width: 1.2, height: 1.2, sill: 0.9 }];
  return { walls, rooms, openings, faces: roomFaces({ walls, rooms, openings, heightOf: () => H }) };
}
const ids = { uid: p => p + Math.random().toString(36).slice(2, 8), today: '2026-11-17', area: 'national' };

test('a room brings its walls net of openings, floor, ceiling, baseboard and counts', () => {
  const { rooms, faces } = plan();
  const m = measureRoom(rooms[0], faces);
  const inside = 2 * ((4 - T) + (3 - T));                     // wall faces run between the walls' inner faces
  const net = inside * H - 0.9 * 2.03 - 1.2 * 1.2;
  near(m.measures.walls, net / SQFT, 'wall area in sf, door and window taken out', 0.5);
  near(m.measures.floor, 12 / SQFT, 'floor from the room outline');
  assert.equal(m.measures.ceiling, m.measures.floor);
  near(m.measures.baseboard, (inside - 0.9) / FT, 'baseboard stops at the door', 0.2);
  near(m.measures.perimeter, 14 / FT, 'perimeter of the outline');
  assert.equal(m.measures.doors, 1);
  assert.equal(m.measures.windows, 1);
  assert.deepEqual(m.elementIds, ['bed']);
});

test('adding a room to "Paint the bedroom" picks paint walls, counts the walls, prices at mid', () => {
  const { rooms, faces } = plan();
  const project = { name: 'Paint the bedroom', category: 'interior', items: [] };
  const it = takeoffItem(measureRoom(rooms[0], faces), project, ids);
  assert.equal(it.work.id, 'paint-walls');
  assert.equal(it.work.level, 'mid');
  assert.equal(it.unit, 'sf');
  assert.equal(it.qty, it.takeoff.measures.walls);
  const L = workById('paint-walls').levels.mid;
  assert.deepEqual([it.low, it.likely, it.high], [L.low, L.likely, L.high]);
  assert.match(it.name, /Paint walls/);
  assert.match(it.name, /Bedroom/);
});

test('switching to a floor work counts the floor; switching back to walls counts the walls', () => {
  const { rooms, faces } = plan();
  const it = takeoffItem(measureRoom(rooms[0], faces), { name: 'Bedroom' }, ids);
  const floorWork = worksForItem(it).find(w => w.applies.includes('floor'));
  assert.ok(floorWork, 'a room can take floor work');
  setWork(it, { work: floorWork.id }, 'national');
  assert.equal(it.qty, it.takeoff.measures.floor);
  assert.equal(it.takeoff.measure, 'floor');
  assert.match(it.name, new RegExp(floorWork.label));
  useMeasure(it, 'walls');
  assert.equal(it.qty, it.takeoff.measures.walls);
  assert.ok(workById(it.work.id).applies.includes('wall'), 'the work follows the measure to one that prices walls');
});

test('finish level and cost area change the prices; a hand price stands until the work is picked again', () => {
  const { rooms, faces } = plan();
  const project = { name: 'Paint', items: [] };
  const it = takeoffItem(measureRoom(rooms[0], faces), project, ids);
  project.items.push(it);
  setWork(it, { level: 'high' }, 'national');
  assert.equal(it.likely, workById('paint-walls').levels.high.likely);
  const area = PRICE_BOOK.areas.find(a => a.factor !== 1);
  if (area) {
    repriceProject(project, area.id);
    near(it.likely, workById('paint-walls').levels.high.likely * area.factor, 'the area factor applies', 0.01);
  }
  it.likely = 9.99; priceEdited(it);
  repriceProject(project, 'national');
  assert.equal(it.likely, 9.99, 'a typed price is not overwritten by a cost area change');
  setWork(it, { level: 'mid' }, 'national');
  assert.equal(it.likely, workById('paint-walls').levels.mid.likely, 'picking the level again puts the book price back');
  assert.equal(it.work.book, true);
});

test('a renamed item keeps its name when the work changes', () => {
  const { rooms, faces } = plan();
  const it = takeoffItem(measureRoom(rooms[0], faces), { name: 'Paint' }, ids);
  it.name = 'Primary bedroom walls';
  const other = worksForItem(it).find(w => w.id !== it.work.id && w.applies.includes('wall'));
  if (other) setWork(it, { work: other.id }, 'national');
  assert.equal(it.name, 'Primary bedroom walls');
});

test('one wall face, and objects measured by their boxes, combine into one item', () => {
  const { faces } = plan();
  const north = faces.find(f => f.label === 'Bedroom, north wall');
  const fm = measureFace(north);
  near(fm.measures.walls, ((4 - T) * H - 1.44) / SQFT, 'the north face net of its window', 0.5);
  assert.deepEqual(fm.faceIds, [north.id]);
  // Two 18" x 30" cabinet doors, 3/4" thick.
  const om = measureObjects('scan1', ['node:scan1#0', 'node:scan1#1'], [[0.4572, 0.762, 0.019], [0.019, 0.762, 0.4572]], '2 × Upper Door');
  assert.equal(om.measures.count, 2);
  near(om.measures.front, 2 * 0.4572 * 0.762 / SQFT, 'front area from the two largest sides, whichever way the door faces');
  const both = combineMeasured([fm, om]);
  assert.equal(both.measures.count, 2);
  assert.deepEqual(both.objectKeys, ['node:scan1#0', 'node:scan1#1']);
  assert.deepEqual(both.faceIds, [north.id]);
});

test('objects of a "cabinet fronts" project take the cabinet front work, counted each', () => {
  const om = measureObjects('scan1', ['a', 'b', 'c'], [[0.45, 0.76, 0.02], [0.45, 0.76, 0.02], [0.45, 0.76, 0.02]], '3 × Upper Door');
  const it = takeoffItem(om, { name: 'Replace Cabinet Fronts', category: 'kitchen' }, ids);
  assert.equal(it.work && it.work.id, 'replace-cabinet-front');
  assert.equal(it.unit, 'ea');
  assert.equal(it.qty, 3);
});

test('the cost area comes from the project, else the property address', () => {
  const nyc = PRICE_BOOK.areas.find(a => a.id === 'nyc');
  assert.equal(costAreaFor({}, { address: 'Somewhere, Kansas' }), 'national');
  if (nyc) assert.equal(costAreaFor({}, { address: '200 W 10th St, New York, NY' }), 'nyc');
  assert.equal(costAreaFor({ costArea: 'national' }, { address: 'New York, NY' }), 'national');
  assert.equal(areaFactor('nope'), 1);
});

test('every work in the price book has three ordered finish levels and a source', () => {
  assert.ok(PRICE_BOOK.works.length >= 25, 'the book covers the common scope items');
  for (const w of PRICE_BOOK.works) {
    assert.ok(['sf', 'lf', 'ea'].includes(w.unit), w.id + ' unit');
    assert.ok(w.applies.length, w.id + ' applies to something');
    for (const lv of ['budget', 'mid', 'high']) {
      const L = w.levels[lv];
      assert.ok(L && L.low > 0 && L.low <= L.likely && L.likely <= L.high, w.id + ' ' + lv + ' low <= likely <= high');
    }
    assert.ok(w.levels.budget.likely <= w.levels.mid.likely && w.levels.mid.likely <= w.levels.high.likely, w.id + ' levels rise');
    assert.ok((w.sources || []).length, w.id + ' has sources');
  }
});

test('a Westchester or Napa property prices in its own cost area', () => {
  assert.equal(costAreaFor({}, { name: '12 Elm Ave, Somewhere, NY 10601' }), 'westchester');
  assert.equal(costAreaFor({}, { name: 'Vineyard cottage, Napa' }), 'napa');
  assert.equal(costAreaFor({}, { name: '200 W 10th St, Apt 4B' }), 'nyc');
});

test('a cabinet door is priced as a cabinet front, never as a room door', () => {
  const om = measureObjects('scan1', ['a'], [[0.45, 0.76, 0.02]], 'Upper Door.003');
  const it = takeoffItem(om, { name: 'Paint the kitchen' }, ids);
  assert.equal(it.work.id, 'paint-cabinet-front');
  assert.ok(!worksForItem(it).some(w => w.applies.includes('door')), 'no room-door work is offered');
});
