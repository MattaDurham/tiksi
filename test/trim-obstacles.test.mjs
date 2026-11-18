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

// The layout of the plain wall: same parts, same keys, same places along it.
const places = lay => lay.parts.map(p => [p.key, p.kind, p.dir || '', +p.x0.toFixed(5), +p.x1.toFixed(5)]);
// The solid wood of a part: a notched board's pieces, or the part itself.
const solid = p => p.kind === 'board' ? T.boardPieces(p) : [p];
const grown = (d, m) => ({ x0: d.x0 - m, x1: d.x1 + m, y0: d.y0 - m, y1: d.y1 + m });

test('picture-frame boxes stay where the plain wall puts them; a box an outlet crosses is notched round it', () => {
  const t = section('picture-frame', { y: 0.25, h: 0.5 });
  const before = T.trimLayout(t, wall(), []);
  const box = before.parts.find(p => p.kind === 'frame');
  // An outlet on the bottom moulding of the first box.
  const c = outlet(box.x0 + 0.2), w = wall({ trimClearances: [c] });
  const lay = T.trimLayout(t, w, []);
  assert.deepEqual(places(lay), places(before), 'the boxes are where the plain wall has them');
  const hit = lay.parts.find(p => p.key === box.key);
  assert.equal(hit.notches.length, 1, 'the box crossing the outlet is notched');
  const n = hit.notches[0], keep = grown(plate(c), T.DEVICE_CLEAR);
  near(n.x0, keep.x0, 'the notch starts the clearance before the plate'); near(n.x1, keep.x1, 'and ends the clearance after it');
  assert.ok(T.frameGaps(hit).bottom.length === 1 && !T.frameGaps(hit).top.length, 'only the bottom moulding is cut');
  assert.ok(lay.parts.filter(p => p !== hit).every(p => !p.notches), 'no other box is notched');
  // An outlet inside a box, clear of its moulding, changes nothing.
  const inside = outlet((box.x0 + box.x1) / 2);
  inside.y0 = 0.45; inside.y1 = 0.56;
  assert.ok(T.trimLayout(t, wall({ trimClearances: [inside] }), []).parts.every(p => !p.notches), 'an outlet inside a box is left alone');
});

test('board and batten: battens keep their places; one an outlet reaches is notched and stays one board', () => {
  const t = section('board-batten', { y: 0.14, h: 0.8 });
  const before = T.trimLayout(t, wall(), []);
  const bat = before.parts.find(p => p.key === '0:v:3');
  const c = outlet(bat.x1 + 0.02);                      // the plate overlaps the batten's right edge
  const lay = T.trimLayout(t, wall({ trimClearances: [c] }), []);
  assert.deepEqual(places(lay), places(before), 'every batten where the plain wall has it, none added');
  const cut = lay.parts.find(p => p.key === '0:v:3');
  assert.equal(cut.notches.length, 1, 'the batten is notched');
  for (const q of T.boardPieces(cut)) assert.ok(!overlaps(q, grown(plate(c), T.DEVICE_CLEAR - 1e-6)), 'no wood within the clearance of the plate');
  near(Math.min(...T.boardPieces(cut).map(q => q.y0)), bat.y0, 'it still reaches the bottom');
  near(Math.max(...T.boardPieces(cut).map(q => q.y1)), bat.y1, 'and the top rail');
  // An outlet up at the rail: the rail is notched round it and is still one board.
  const high = { ...outlet(2), y0: 0.86, y1: 0.97 };
  const rails = T.trimLayout(t, wall({ trimClearances: [high] }), []).parts.filter(p => p.kind === 'board' && p.dir === 'h');
  assert.equal(rails.length, 1, 'one top rail');
  assert.equal(rails[0].notches.length, 1, 'notched round the outlet');
  for (const q of T.boardPieces(rails[0])) assert.ok(!overlaps(q, plate(high)), 'no wood over the plate');
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
  // A radiator found in a model keeps HEATER_CLEAR: the baseboard stops that far short of it.
  const rad = { ...heater, kind: 'heater' };
  const radBase = T.trimLayout(section('baseboard'), wall({ trimClearances: [rad] }), []).parts;
  near(radBase[0].x1, 1.6 - T.HEATER_CLEAR, 'stops short of the radiator'); near(radBase[1].x0, 2.4 + T.HEATER_CLEAR, 'starts again past it');
  // The other face of the wall is not touched by either.
  assert.equal(T.trimLayout(section('baseboard', { side: -1 }), wall({ trimClearances: [heater, low] }), []).parts.length, 1, 'the far face runs on');
});

test('over a radiator the field keeps its layout and stops at the radiator\'s top', () => {
  const rad = { side: 1, f0: 0.4, f1: 0.6, y0: 0.05, y1: 0.5, kind: 'heater' };
  const top = 0.5 + T.HEATER_CLEAR, keep = { x0: 1.6 - T.HEATER_CLEAR, x1: 2.4 + T.HEATER_CLEAR, y0: 0, y1: top };
  // Board and batten: one stretch, battens where the plain wall has them; over the radiator they start above it.
  const bb = section('board-batten', { y: 0.14, h: 0.8 });
  const plain = T.trimLayout(bb, wall(), []), lay = T.trimLayout(bb, wall({ trimClearances: [rad] }), []);
  assert.equal(lay.rects.length, 1, 'the radiator does not break the field');
  const xs = l => l.parts.filter(p => p.dir === 'v').map(p => +p.x0.toFixed(5));
  assert.deepEqual(xs(lay), xs(plain), 'the battens keep their places');
  const over = lay.parts.filter(p => p.dir === 'v' && p.x0 >= keep.x0 && p.x1 <= keep.x1);
  assert.ok(over.length >= 1, 'battens over the radiator');
  for (const b of over) near(b.y0, top, 'a batten over the radiator starts above it');
  for (const p of lay.parts) for (const q of solid(p)) assert.ok(!overlaps(q, keep), p.key + ' keeps off the radiator');
  // Picture-frame boxes: the box over it is shortened to start above it and keeps its width.
  const pf = section('picture-frame', { y: 0.25, h: 0.6 });
  const pPlain = T.trimLayout(pf, wall(), []), pLay = T.trimLayout(pf, wall({ trimClearances: [rad] }), []);
  const was = pPlain.parts.find(p => p.kind === 'frame' && p.x1 > keep.x0 && p.x0 < keep.x1);
  const now = pLay.parts.find(p => p.key === was.key);
  near(now.y0, top, 'the box starts above the radiator'); near(now.y1, was.y1, 'its top stays');
  assert.equal(now.x0, was.x0); assert.equal(now.x1, was.x1);
  const box = pLay.boxes.find(b => b.x0 === now.x0);
  near(box.y0, top, 'the box outline follows');
  // Raised panels: the panel inside a shortened box moves up with it.
  const rp = T.trimLayout(section('raised-panel', { y: 0.14, h: 0.78 }), wall({ trimClearances: [rad] }), []);
  for (const p of rp.parts) for (const q of solid(p)) assert.ok(!overlaps(q, keep), p.key + ' keeps off the radiator');
  // A radiator taller than the field: nothing is left in front of it.
  const tall = { ...rad, y1: 1.2 };
  const gone = T.trimLayout(bb, wall({ trimClearances: [tall] }), []);
  for (const p of gone.parts) for (const q of solid(p)) assert.ok(!overlaps(q, { ...keep, y1: 1.2 + T.HEATER_CLEAR }), p.key + ' is not in front of the tall radiator');
  assert.equal(gone.parts.filter(p => p.dir === 'h').length, 2, 'the top rail stops either side of it');
});

test('panels keep their stiles in place and are notched round an outlet; so are planks', () => {
  const c = outlet(1.5);
  const sh = section('shaker', { y: 0.14, h: 0.78 });
  const shaker = T.trimLayout(sh, wall({ trimClearances: [c] }), []);
  assert.deepEqual(places(shaker), places(T.trimLayout(sh, wall(), [])), 'the stiles are where the plain wall has them');
  for (const p of shaker.parts) for (const q of solid(p)) assert.ok(!overlaps(q, plate(c)), p.kind + ' ' + (p.dir || '') + ' clears the outlet');
  const bead = T.trimLayout(section('beadboard', { y: 0.14, h: 0.8 }), wall({ trimClearances: [c] }), []);
  assert.ok(bead.parts.length > 30, 'the boards are there');
  for (const p of bead.parts) for (const q of solid(p)) assert.ok(!overlaps(q, plate(c)), 'no board covers the outlet');
  // Above and below it the boards carry on, each still one board.
  assert.ok(bead.parts.some(p => p.notches && T.boardPieces(p).some(q => q.y0 >= plate(c).y1)), 'a notched board carries on above the outlet');
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
