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
test('undoing a new wall cannot orphan trim another editor attached to it', () => {
  const p = house(), h = new GeometryHistory();
  h.begin(p, 'add wall'); p.walls.push({ ...p.walls[0], id: 'new' }); h.commit(p);
  p.trims = [{ id: 'remote-trim', wallId: 'new', level: 'ground', style: 'baseboard', product: 'selected-catalog-entry' }];
  const before = JSON.stringify(p);
  assert.deepEqual(h.state(p, 'undo'), { available: false, label: 'add wall', blocked: true });
  assert.equal(h.restore(p, 'undo'), false);
  assert.equal(JSON.stringify(p), before, 'both the host and remote trim remain untouched');
});
test('undo cannot remove a level referenced by a remotely added trim record', () => {
  const p = house(), h = new GeometryHistory();
  h.begin(p, 'add level'); p.levels.push({ id: 'upper', elevation: 3, height: 2.7 }); h.commit(p);
  p.trims = [{ id: 'remote-trim', wallId: 'north', level: 'upper', style: 'baseboard' }];
  const before = JSON.stringify(p);
  assert.equal(h.state(p, 'undo').blocked, true);
  assert.equal(h.restore(p, 'undo'), false);
  assert.equal(JSON.stringify(p), before);
});
test('a wall and its own trim undo and redo together with source evidence intact', () => {
  const p = house(), h = new GeometryHistory(); p.trims = [];
  h.begin(p, 'add wall and trim');
  p.walls.push({ ...p.walls[0], id: 'new' });
  p.trims.push({ id: 'new-trim', wallId: 'new', level: 'ground', style: 'baseboard', product: 'selected-catalog-entry', evidence: { geometry: { status: 'unknown', note: 'Synthetic source' } } });
  h.commit(p); const after = geometrySnapshot(p).data;
  assert.equal(h.restore(p, 'undo'), true);
  assert.equal(p.trims.length, 0); assert.ok(!p.walls.some(w => w.id === 'new'));
  assert.equal(h.restore(p, 'redo'), true);
  assert.deepEqual(geometrySnapshot(p).data, after);
});
test('undo cannot restore deleted trim after its host or level was removed remotely', () => {
  for (const remove of [p => { p.walls = p.walls.filter(w => w.id !== 'north'); }, p => { p.levels = []; }]) {
    const p = house(), h = new GeometryHistory();
    p.trims = [{ id: 'trim', wallId: 'north', level: 'ground', style: 'baseboard' }];
    h.begin(p, 'delete trim'); p.trims = []; h.commit(p);
    remove(p);
    const before = JSON.stringify(p);
    assert.equal(h.state(p, 'undo').blocked, true);
    assert.equal(h.restore(p, 'undo'), false);
    assert.equal(JSON.stringify(p), before, 'neither the deleted host nor orphan trim is restored');
  }
});
test('history stays bounded and does not undo into another project', () => {
  const p = house(), h = new GeometryHistory(2);
  for (const v of [.2, .3, .4]) { h.begin(p); p.walls[0].thickness = v; h.commit(p); }
  assert.equal(h.restore(p, 'undo'), true); assert.equal(h.restore(p, 'undo'), true);
  assert.equal(h.restore(p, 'undo'), false); assert.equal(p.walls[0].thickness, .2);
});
test('both buttons from one copy give the same answers as asking each direction', () => {
  const p = house(), h = new GeometryHistory();
  assert.deepEqual(h.states(p), { undo: h.state(p, 'undo'), redo: h.state(p, 'redo') });
  move(p, h);
  assert.deepEqual(h.states(p), { undo: h.state(p, 'undo'), redo: h.state(p, 'redo') });
  assert.equal(h.states(p).undo.available, true); assert.equal(h.states(p).redo.available, false);
  h.restore(p, 'undo');
  assert.deepEqual(h.states(p), { undo: h.state(p, 'undo'), redo: h.state(p, 'redo') });
  assert.equal(h.states(p).redo.available, true);
  p.walls[1].ax = 9;   // a newer edit to the same wall blocks redo
  assert.equal(h.states(p).redo.blocked, true);
});
test('reverting a cancelled drag puts every moved piece back and leaves no undo entry', () => {
  const p = house(), h = new GeometryHistory(), before = geometrySnapshot(p).data, plan = p.levels[0].plan;
  h.begin(p, 'move wall');
  const mv = planWallMove(p.walls[1], p.walls, p.rooms, p.openings);
  applyWallMove(mv, normalOffset(mv, 1.5, 0));
  assert.equal(p.walls[1].ax, 7.5);
  assert.equal(h.revert(p), true);
  assert.deepEqual(geometrySnapshot(p).data, before);
  assert.equal(p.levels[0].plan, plan, 'the underlay object is kept, not copied');
  h.commit(p);
  assert.equal(h.states(p).undo.available, false, 'nothing to undo after a reverted drag');
  assert.equal(h.revert(p), false, 'a second revert has nothing to put back');
});
test('a held edit survives change events until its owner lets go, so a cancel can still put it back', () => {
  const p = house(), h = new GeometryHistory(), before = geometrySnapshot(p).data;
  h.begin(p, 'move wall', { hold: true });
  p.walls[1].ax = 7;
  h.commit(p);                                   // a change event mid-drag
  assert.equal(h.states(p).undo.available, false, 'not closed by the change event');
  assert.equal(h.revert(p), true); assert.deepEqual(geometrySnapshot(p).data, before);
  h.begin(p, 'move wall', { hold: true }); p.walls[1].ax = 7.5;
  h.release(); h.commit(p);
  assert.equal(h.states(p).undo.available, true, 'closed once released');
  assert.equal(h.restore(p, 'undo'), true); assert.equal(p.walls[1].ax, 6);
});

test('scoped trim cancellation preserves remote records and metadata while reverting only local fields', () => {
  const p = house(), h = new GeometryHistory();
  p.trims = [{ id: 'trim', wallId: 'north', level: 'ground', y: .2, product: 'old-selection', name: 'Original' }];
  h.begin(p, 'move trim', { hold: true });
  p.trims[0].y = .5;
  const localAfter = { trims: [{ id: 'trim', y: .5 }] };
  p.trims[0].product = 'remote-selection'; p.trims[0].name = 'Remote name';
  p.trims[0].evidence = { geometry: { status: 'unknown', note: 'Remote review' } };
  p.trims.push({ id: 'remote-trim', wallId: 'south', level: 'ground', y: 0 });
  p.fixtures = [{ id: 'remote-fixture', level: 'ground', name: 'Remote fixture' }];
  p.walls.push({ ...p.walls[0], id: 'remote-wall' });
  p.openings.push({ id: 'remote-opening', wallId: 'remote-wall', width: 1 });
  p.rooms.push({ id: 'remote-room', level: 'ground', pts: [[0, 0], [1, 0], [1, 1]] });
  p.levels[0].plan.offsetX = 8;
  h.commit(p); // A remote shared change must not close the held local edit.
  const expected = structuredClone(p); expected.trims[0].y = .2;
  assert.equal(h.revert(p, localAfter), true);
  assert.deepEqual(p, expected);
  assert.equal(h.pending, null); assert.equal(h.states(p).undo.available, false);
});

test('scoped trim cancellation refuses a same-field remote conflict atomically', () => {
  const p = house(), h = new GeometryHistory();
  p.trims = [{ id: 'a', wallId: 'north', level: 'ground', y: .2 }, { id: 'b', wallId: 'south', level: 'ground', y: .3 }];
  h.begin(p, 'move trims', { hold: true });
  p.trims[0].y = .5; p.trims[1].y = .6;
  const localAfter = { trims: [{ id: 'a', y: .5 }, { id: 'b', y: .6 }] };
  p.trims[0].y = .8; // Another device changed one of the fields after the last local move.
  p.trims.push({ id: 'remote', wallId: 'east', level: 'ground', y: 0 });
  const before = structuredClone(p);
  assert.equal(h.revert(p, localAfter), false);
  assert.deepEqual(p, before, 'a conflict on one section cannot partially revert another');
  assert.equal(h.pending, null); assert.equal(h.states(p).undo.available, false);
});

test('scoped divider cancellation restores null and absent fields exactly', () => {
  for (const initial of [{}, { widths: null, cols: null }]) {
    const p = house(), h = new GeometryHistory();
    p.trims = [{ id: 'trim', wallId: 'north', level: 'ground', ...initial }];
    h.begin(p, 'resize trim', { hold: true });
    p.trims[0].widths = [1, 2]; p.trims[0].cols = 2;
    const localAfter = { trims: [{ id: 'trim', widths: [1, 2], cols: 2 }] };
    p.trims[0].name = 'Remote name';
    assert.equal(h.revert(p, localAfter), true);
    assert.deepEqual(p.trims[0], { id: 'trim', wallId: 'north', level: 'ground', ...initial, name: 'Remote name' });
  }
});

test('scoped cancellation keeps host guards and supports locally removed fields', () => {
  const p = house(), h = new GeometryHistory();
  p.trims = [{ id: 'trim', wallId: 'north', level: 'ground', widths: [1, 2] }];
  h.begin(p, 'clear widths', { hold: true }); delete p.trims[0].widths;
  assert.equal(h.revert(p, { trims: [{ id: 'trim', widths: undefined }] }), true);
  assert.deepEqual(p.trims[0].widths, [1, 2]);
  h.begin(p, 'move trim', { hold: true }); p.trims[0].y = .5;
  p.walls = p.walls.filter(w => w.id !== 'north');
  const before = structuredClone(p);
  assert.equal(h.revert(p, { trims: [{ id: 'trim', y: .5 }] }), false);
  assert.deepEqual(p, before, 'rollback cannot restore a trim whose host was remotely removed');
});
