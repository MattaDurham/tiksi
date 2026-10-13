import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fitScan, placeResult, mergeProposal, existingPlan, rotatePlan } from '../js/scanmerge.js';

// A 10 x 8 m floor with an asymmetric interior (a wall at x = 3 and a cross wall at y = 5 east
// of it), so only one rotation puts a rescan back on it.
const OUTLINE = [[0, 0, 10, 0], [10, 0, 10, 8], [10, 8, 0, 8], [0, 8, 0, 0]];
const INSIDE = [[3, 0, 3, 8], [3, 5, 10, 5]];
const wallsOf = (segs, exterior) => segs.map(([ax, ay, bx, by], i) => ({ id: (exterior ? 'e' : 'i') + i, ax, ay, bx, by, thickness: exterior ? 0.165 : 0.114, exterior }));

let n = 0;
const uid = p => p + '-' + (++n);

function property() {
  const lvl = { id: 'lvl-main', name: 'Main level', elevation: 0, height: 2.5, plan: { img: 'old' } };
  const walls = wallsOf(OUTLINE, true).concat(wallsOf(INSIDE, false)).map(w => Object.assign(w, { id: 'old-' + w.id, level: lvl.id }));
  return {
    id: 'p', levels: [lvl], activeLevelId: lvl.id, wallHeight: 2.5,
    walls, openings: [{ id: 'old-door', wallId: 'old-i0', type: 'door', t: 0.5, width: 0.8 }],
    rooms: [{ id: 'old-room', level: lvl.id, name: 'Kitchen', pts: [[0, 0], [3, 0], [3, 8], [0, 8]] }],
    scans: [{ id: 'scan-old', kind: 'mesh', name: 'first.glb' }],
  };
}
const existing = prop => existingPlan(prop, x => x.level);

// A proposal as scan2plan returns it: the same building seen from another capture's frame,
// i.e. moved by the inverse of (rot, dx, dy).
function proposal(segsOut, segsIn, { rot = 0, dx = 0, dy = 0 } = {}) {
  const inv = ([ax, ay, bx, by]) => {
    const a = rotatePlan(ax - dx, ay - dy, -rot), b = rotatePlan(bx - dx, by - dy, -rot);
    return [a[0], a[1], b[0], b[1]];
  };
  const walls = wallsOf(segsOut.map(inv), true).concat(wallsOf(segsIn.map(inv), false));
  return {
    levels: [{ name: 'Main level', elevation: 0, height: 2.6, walls, rooms: [{ pts: [[0, 0], [1, 0], [1, 1]] }], openings: [{ wallId: walls[walls.length - 1].id, type: 'door', t: 0.4, width: 0.8, height: 2 }] }],
    mainLevelIndex: 0, wallHeight: 2.6,
    transform: { pos: [0, -1.2, 0], rot: [0, 17, 0] },
    grid: { W: 100, H: 80, ox: -1, oz: -1, cell: 0.1 },
  };
}

test('a rescan of the same floor from another frame is found and put back on it', () => {
  const prop = property();
  const result = proposal(OUTLINE, INSIDE, { rot: 90, dx: 40, dy: -7 });
  const fit = fitScan(existing(prop), result);
  assert.equal(fit.suggestion, 'replace', fit.reason);
  assert.ok(fit.scores.outline > 0.95 && fit.scores.inner > 0.95, 'walls coincide after placement');
  const placed = placeResult(result, fit.placements.replace);
  for (const w of placed.levels[0].walls) {
    const twin = prop.walls.find(o => Math.hypot(o.ax - w.ax, o.ay - w.ay) + Math.hypot(o.bx - w.bx, o.by - w.by) < 0.01
      || Math.hypot(o.ax - w.bx, o.ay - w.by) + Math.hypot(o.bx - w.ax, o.by - w.ay) < 0.01);
    assert.ok(twin, `placed wall ${JSON.stringify([w.ax, w.ay, w.bx, w.by])} lands on an existing wall`);
  }
  // The scan transform composes the same turn and shift, so the mesh follows its walls.
  assert.equal(placed.transform.rot[1], 17 + fit.placements.replace.rot);
  assert.deepEqual(placed.transform.pos, [fit.placements.replace.dx, -1.2, fit.placements.replace.dz]);
});

test('the same outline with different rooms inside reads as the next floor up', () => {
  const prop = property();
  const result = proposal(OUTLINE, [[6, 0, 6, 8]], { rot: 180, dx: -3, dy: 2 });
  const fit = fitScan(existing(prop), result);
  assert.equal(fit.suggestion, 'level', fit.reason);
  assert.equal(fit.placements.level.dElev, 2.75, 'stacked on the 2.5 m storey plus the floor structure');
  const placed = placeResult(result, fit.placements.level);
  const applied = mergeProposal(prop, { id: 'scan-new', kind: 'mesh', name: 'upstairs.glb' }, placed, [{ img: 'up' }], 'level', uid);
  assert.equal(prop.levels.length, 2);
  const upper = prop.levels[1];
  assert.equal(upper.name, 'Floor 2', 'a second "Main level" gets a distinct name');
  assert.equal(upper.elevation, 2.75);
  assert.equal(upper.plan.img, 'up');
  assert.equal(prop.levels[0].plan.img, 'old', 'the floor below keeps its underlay');
  assert.equal(prop.walls.filter(w => w.level === upper.id).length, 5);
  assert.equal(prop.walls.filter(w => w.level === 'lvl-main').length, 6, 'nothing below is touched');
  assert.equal(prop.activeLevelId, upper.id);
  assert.equal(prop.scans.length, 1, 'the first scan stays');
  assert.equal(applied.rooms[0].name, 'Room 2', 'room numbers carry on');
  assert.equal(prop.openings.length, 2);
});

test('a small separate outline is placed beside the building on the same floor', () => {
  const prop = property();
  const garage = [[0, 0, 4, 0], [4, 0, 4, 6], [4, 6, 0, 6], [0, 6, 0, 0]];
  const result = proposal(garage, [], { dx: 100, dy: 100 });
  const fit = fitScan(existing(prop), result);
  assert.equal(fit.suggestion, 'beside', fit.reason);
  const placed = placeResult(result, fit.placements.beside);
  const xs = placed.levels[0].walls.flatMap(w => [w.ax, w.bx]);
  assert.equal(Math.min(...xs), 13, 'three metres clear of the east wall');
  mergeProposal(prop, { id: 'scan-garage', kind: 'mesh', name: 'garage.glb' }, placed, [{ img: 'garage' }], 'beside', uid);
  assert.equal(prop.levels.length, 1, 'both buildings share the ground floor');
  assert.equal(prop.walls.length, 10);
  assert.equal(prop.levels[0].plan.img, 'old', 'an existing underlay is not overwritten');
});

test('replace rebuilds only the floor it lands on and drops the scan it supersedes', () => {
  const prop = property();
  prop.levels.push({ id: 'lvl-up', name: 'Upper', elevation: 2.75, height: 2.4, plan: null });
  prop.walls.push({ id: 'up-w', level: 'lvl-up', ax: 0, ay: 0, bx: 10, by: 0, thickness: 0.165 });
  const result = proposal(OUTLINE, INSIDE, { rot: 270 });
  const fit = fitScan(existing(prop), result);
  const placed = placeResult(result, fit.placements.replace);
  const applied = mergeProposal(prop, { id: 'scan-new', kind: 'mesh', name: 'again.glb' }, placed, [{ img: 'new' }], 'replace', uid);
  assert.equal(prop.levels.length, 2);
  assert.ok(prop.walls.some(w => w.id === 'up-w'), 'the upper floor stays');
  assert.ok(!prop.walls.some(w => w.id.startsWith('old-')), 'the old ground floor walls are gone');
  assert.ok(!prop.openings.some(o => o.id === 'old-door'));
  assert.equal(prop.levels[0].plan.img, 'new', 'the rebuilt floor gets the new underlay');
  assert.deepEqual(applied.superseded, [], 'the old scan still covers the upper floor');

  const single = property();
  const fit1 = fitScan(existing(single), result);
  const applied1 = mergeProposal(single, { id: 'scan-new', kind: 'mesh' }, placeResult(result, fit1.placements.replace), null, 'replace', uid);
  assert.deepEqual(applied1.superseded, ['scan-old']);
  assert.equal(single.scans.length, 0);
  assert.equal(single.wallHeight, 2.6);
});

test('a rescan targets the floor it matches, not the floor with the most walls', () => {
  const prop = property();
  const upperSegs = OUTLINE.concat([[6, 0, 6, 8], [0, 4, 6, 4], [6, 4, 10, 4]]);
  prop.levels.push({ id: 'lvl-up', name: 'Upper', elevation: 2.75, height: 2.4, plan: null });
  for (const w of wallsOf(upperSegs, true)) prop.walls.push(Object.assign(w, { id: 'up-' + w.id, level: 'lvl-up' }));
  const fit = fitScan(existing(prop), proposal(OUTLINE, INSIDE, { rot: 90, dx: 5 }));
  assert.equal(fit.ref.id, 'lvl-main');
  assert.equal(fit.suggestion, 'replace', fit.reason);
  assert.equal(fit.placements.replace.dElev, 0);
});

test('nothing to fit against yields no suggestion', () => {
  assert.equal(fitScan({ levels: [] }, proposal(OUTLINE, INSIDE)), null);
});
