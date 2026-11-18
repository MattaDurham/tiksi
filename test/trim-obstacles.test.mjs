// Wall trim keeps off what is on the wall (trims.js, trim-obstacles.js): outlets, plates and
// thermostats are laid out round, radiators and heater covers stop trim as a window does, and
// MODEL finds both in a model's wall-mounted pieces by name and place. Synthetic walls only.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const T = await import('../js/trims.js');
const O = await import('../js/trim-obstacles.js');

const IN = 0.0254;
// A 4 m wall along x, 0.1 m thick, 2.44 m high: side 1 is its +y face (left of a to b).
const wall = (extra = {}) => ({ id: 'w1', ax: 0, ay: 0, bx: 4, by: 0, thickness: 0.1, height: 2.44, level: 'l1', ...extra });
// An outlet plate 2 3/4 x 4 1/2 in centred at x on side 1, its middle 14 in up.
const outlet = (x, side = 1) => ({ side, f0: (x - 1.375 * IN) / 4, f1: (x + 1.375 * IN) / 4, y0: 14 * IN - 2.25 * IN, y1: 14 * IN + 2.25 * IN, kind: 'device' });
const section = (style, extra = {}) => T.normaliseTrim({ id: 't', style, wallId: 'w1', side: 1, f0: 0, f1: 1, ...extra }, null);
const overlaps = (p, d) => p.x0 < d.x1 - 1e-9 && p.x1 > d.x0 + 1e-9 && p.y0 < d.y1 - 1e-9 && p.y1 > d.y0 + 1e-9;
const plate = c => ({ x0: c.f0 * 4, x1: c.f1 * 4, y0: c.y0, y1: c.y1 });

test('picture-frame boxes leave an outlet in the space between them', () => {
  const t = section('picture-frame', { y: 0.14, h: 0.7 });
  const before = T.trimLayout(t, wall(), []);
  const c = outlet(1.0), w = wall({ trimClearances: [c] });
  // The plain wall puts a box over this spot.
  assert.ok(before.parts.some(p => p.kind === 'frame' && overlaps(p, plate(c))), 'without the outlet a box covers it');
  const lay = T.trimLayout(t, w, []);
  const frames = lay.parts.filter(p => p.kind === 'frame');
  assert.ok(frames.length >= 4, 'the wall still has boxes');
  for (const f of frames) assert.ok(f.x1 <= plate(c).x0 - T.DEVICE_CLEAR + 1e-9 || f.x0 >= plate(c).x1 + T.DEVICE_CLEAR - 1e-9, 'no box comes within the clearance of the plate');
  // Either side of the outlet the boxes are at least the usual gap apart.
  const left = frames.filter(f => f.x1 <= plate(c).x0).sort((a, b) => b.x1 - a.x1)[0];
  const right = frames.filter(f => f.x0 >= plate(c).x1).sort((a, b) => a.x0 - b.x0)[0];
  assert.ok(right.x0 - left.x1 >= 0.1 - 1e-9, 'the space round the outlet is never less than the gap');
  // A count set for the stretch is shared either side of the outlet.
  const set = T.trimLayout({ ...t, colsAt: [5] }, w, []);
  assert.equal(set.boxes.filter(b => b.row === 0).length, 5, 'five boxes set, five drawn');
});

test('board and batten: no batten on an outlet, the top rail runs on; a high outlet cuts the rail', () => {
  const t = section('board-batten', { y: 0.14, h: 0.8 });
  const c = outlet(1.03);
  const lay = T.trimLayout(t, wall({ trimClearances: [c] }), []);
  const battens = lay.parts.filter(p => p.kind === 'board' && p.dir === 'v');
  for (const b of battens) assert.ok(!overlaps(b, { ...plate(c), x0: plate(c).x0 - T.DEVICE_CLEAR, x1: plate(c).x1 + T.DEVICE_CLEAR }), 'batten at ' + b.x0.toFixed(3) + ' clears the outlet');
  const rail = lay.parts.filter(p => p.kind === 'board' && p.dir === 'h');
  assert.equal(rail.length, 1, 'one top rail');
  assert.ok(rail[0].x1 - rail[0].x0 > 3.9, 'the length of the wall');
  // An outlet up at the rail: the rail is cut round it.
  const high = { ...c, y0: 0.86, y1: 0.97 };
  const cut = T.trimLayout(t, wall({ trimClearances: [high] }), []).parts.filter(p => p.kind === 'board' && p.dir === 'h');
  assert.ok(cut.length >= 2, 'the rail is in pieces');
  for (const r of cut) assert.ok(!overlaps(r, plate(high)), 'no piece of rail crosses it');
});

test('baseboard and chair rail stop at a device they would cross and at a radiator', () => {
  const low = { ...outlet(2), y0: 0.03, y1: 0.14 };
  const runs = T.trimLayout(section('baseboard'), wall({ trimClearances: [low] }), []).parts;
  assert.equal(runs.length, 2, 'the baseboard is in two pieces');
  for (const r of runs) assert.ok(!overlaps({ x0: r.x0, x1: r.x1, y0: r.y, y1: r.y + r.W }, plate(low)), 'neither crosses the outlet');
  const untouched = T.trimLayout(section('chair-rail', { y: 0.84 }), wall({ trimClearances: [outlet(2)] }), []).parts;
  assert.equal(untouched.length, 1, 'a rail above the outlet runs straight past');
  const heater = { side: 1, f0: 0.4, f1: 0.6, y0: 0.05, y1: 0.4 };
  const base = T.trimLayout(section('baseboard'), wall({ trimClearances: [heater] }), []).parts;
  assert.equal(base.length, 2, 'the baseboard stops either side of the heater cover');
  // A field over the heater cover stops at it as at a window: above it, a stretch of its own.
  const field = T.trimLayout(section('board-batten', { y: 0.14, h: 0.8 }), wall({ trimClearances: [heater] }), []);
  const over = field.rects.filter(r => r.x0 >= 1.6 - 1e-6 && r.x1 <= 2.4 + 1e-6);
  assert.equal(over.length, 1, 'one stretch over the heater');
  near(over[0].y0, 0.4, 'it starts at the heater cover\'s top');
  assert.ok(!over[0].full, 'it is not a full-height stretch');
  // The other face of the wall is not touched by either.
  assert.equal(T.trimLayout(section('baseboard', { side: -1 }), wall({ trimClearances: [heater, low] }), []).parts.length, 1, 'the far face runs on');
});

test('panels put stiles either side of an outlet; planks are cut round it', () => {
  const c = outlet(1.5);
  const shaker = T.trimLayout(section('shaker', { y: 0.14, h: 0.78 }), wall({ trimClearances: [c] }), []);
  for (const p of shaker.parts) assert.ok(!overlaps(p, plate(c)), p.kind + ' ' + (p.dir || '') + ' clears the outlet');
  const bead = T.trimLayout(section('beadboard', { y: 0.14, h: 0.8 }), wall({ trimClearances: [c] }), []);
  assert.ok(bead.parts.length > 30, 'the boards are there');
  for (const p of bead.parts) assert.ok(!overlaps(p, plate(c)), 'no board covers the outlet');
  // Above and below it the boards carry on.
  assert.ok(bead.parts.some(p => p.x0 < plate(c).x1 && p.x1 > plate(c).x0 && p.y0 >= plate(c).y1), 'a board above the outlet');
});

test('a hand-made clearance with no kind still stops trim as before', () => {
  const lay = T.trimLayout(section('baseboard'), wall({ trimClearances: [{ side: 1, f0: 0.45, f1: 0.7, y0: 0, y1: 0.56 }] }), []);
  assert.equal(lay.parts.length, 2);
  near(lay.parts[0].x1, 1.8, 'stops at the clearance');
  near(lay.parts[1].x0, 2.8, 'starts after it');
});

test('pieces are told apart by name', () => {
  for (const n of ['Foyer pink-canvas duplex receptacle', 'Hall cow-canvas north rocker plate', 'Pantry-front two-device switch plate', 'Round black-faced thermostat/control on white backplate', 'east french north duplex observed plate', 'GFCI outlet'])
    assert.equal(O.obstacleKind(n), 'device', n);
  for (const n of ['Recessed convector - living, 2630', 'Entry south recessed heater cover', 'Cast iron radiator', 'Return air grille', 'Floor register'])
    assert.equal(O.obstacleKind(n), 'heater', n);
  for (const n of ['Pendant light', 'Dinner plates', 'Kitchen base cabinet', 'Range hood vent', 'Kitchen-opening return', 'Amerock hook', 'Sofa', ''])
    assert.equal(O.obstacleKind(n), null, n);
});

// A box of corners in plan metres: x, y on the plan, z the height.
const box = (x0, x1, y0, y1, z0, z1) => { const pts = []; for (const x of [x0, x1]) for (const y of [y0, y1]) for (const z of [z0, z1]) pts.push([x, y, z]); return pts; };

test('a wall-mounted piece goes to the face it sits on, and only that one', () => {
  // An L corner: w1 along x (faces +y on side 1), w2 along y at x = 0.
  const walls = [wall(), { id: 'w2', ax: 0, ay: 0, bx: 0, by: 3, thickness: 0.1, height: 2.44, level: 'l1' }];
  const pieces = [
    // A plate on w1's +y face, 8 cm from the corner: also within reach of w2, but flat against w1.
    { key: 'p1', name: 'duplex receptacle', kind: 'device', pts: box(0.08, 0.15, 0.05, 0.06, 0.3, 0.41) },
    // A recessed heater cover, its body in the wall.
    { key: 'h1', name: 'heater cover', kind: 'heater', pts: box(2, 2.6, 0.01, 0.07, 0.05, 0.35) },
    // A plate on a kitchen island 1 m out: on no wall.
    { key: 'p2', name: 'island receptacle', kind: 'device', pts: box(2, 2.07, 1.0, 1.01, 0.8, 0.9) },
    // A plate on the far face of w1.
    { key: 'p3', name: 'toggle plate', kind: 'device', pts: box(3, 3.07, -0.06, -0.05, 1.1, 1.21) },
  ];
  const got = O.wallClearances(walls, pieces);
  assert.deepEqual([...got.keys()].sort(), ['w1'], 'everything on w1');
  const byKey = Object.fromEntries(got.get('w1').map(c => [c.source, c]));
  assert.ok(!byKey.p2, 'the island plate is on no wall');
  assert.equal(byKey.p1.side, 1); assert.equal(byKey.p1.kind, 'device');
  near(byKey.p1.f0 * 4, 0.08, 'plate start', 1e-4); near(byKey.p1.y0, 0.3, 'plate bottom', 1e-4);
  assert.equal(byKey.h1.kind, 'heater');
  assert.equal(byKey.p3.side, -1, 'the far face');
  assert.ok(byKey.p1.auto, 'found, not drawn by hand');
});

test('automatic entries are replaced model by model; entries by hand stay', () => {
  const hand = { side: 1, f0: 0.1, f1: 0.2, y0: 0, y1: 0.5 };
  const walls = [wall({ trimClearances: [hand] })];
  const found = new Map([['w1', [{ side: 1, f0: 0.5, f1: 0.52, y0: 0.3, y1: 0.41, kind: 'device', auto: true, source: 'k#0', name: 'plate' }]]]);
  assert.equal(O.applyAutoClearances(walls, 'scan-a', found), true, 'added');
  assert.equal(O.applyAutoClearances(walls, 'scan-a', found), false, 'the same again changes nothing');
  assert.equal(walls[0].trimClearances.length, 2);
  assert.deepEqual(walls[0].trimClearances[0], hand, 'the hand-made entry is first and unchanged');
  assert.equal(walls[0].trimClearances[1].scanId, 'scan-a');
  assert.equal(O.applyAutoClearances(walls, 'scan-a', new Map()), true, 'the model has none now');
  assert.deepEqual(walls[0].trimClearances, [hand]);
  O.applyAutoClearances(walls, 'scan-a', found);
  assert.equal(O.dropAutoClearances(walls, new Set(['scan-b'])), true, 'a deleted model loses its entries');
  assert.deepEqual(walls[0].trimClearances, [hand]);
});

const near = (a, b, what, tol = 1e-6) => assert.ok(Math.abs(a - b) < tol, `${what}: ${a} is not ${b}`);
