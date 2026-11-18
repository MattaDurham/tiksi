// Trim boards one at a time (trims.js): every part of a layout has a key naming its place, and
// a section's t.boards moves, resizes, deletes or adds single boards over its automatic layout.
// The keys reach the 3D mesh (trim-mesh.js) so a click can find the board it hit. Synthetic walls only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const vendor = new URL('../vendor/', import.meta.url).href;
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'three') return { url: vendor + 'three.module.min.js', shortCircuit: true };
    return next(spec, ctx);
  },
});
const T = await import('../js/trims.js');
const { trimMeshParts } = await import('../js/trim-mesh.js');

const IN = 0.0254;
const wall = (extra = {}) => ({ id: 'w1', ax: 0, ay: 0, bx: 4, by: 0, thickness: 0.1, height: 2.44, level: 'l1', ...extra });
const section = (style, extra = {}) => T.normaliseTrim({ id: 't', style, wallId: 'w1', side: 1, f0: 0, f1: 1, ...extra }, null);
const near = (a, b, what, tol = 2e-5) => assert.ok(Math.abs(a - b) < tol, `${what}: ${a} is not ${b}`);
const battens = lay => lay.parts.filter(p => p.kind === 'board' && p.dir === 'v').sort((a, b) => a.x0 - b.x0);

test('every part of every style has a key, unique within its section, and the same when drawn again', () => {
  const door = { id: 'd', wallId: 'w1', type: 'door', t: 0.5, width: 0.8, height: 2.03 };
  for (const style of Object.keys(T.TRIM_STYLES)) {
    const t = section(style);
    const a = T.trimLayout(t, wall(), [door]), b = T.trimLayout(t, wall(), [door]);
    assert.ok(a.parts.length, style + ' has parts');
    const keys = a.parts.map(p => p.key);
    assert.ok(keys.every(k => typeof k === 'string' && k), style + ': every part has a key');
    assert.equal(new Set(keys).size, keys.length, style + ': keys are unique');
    assert.deepEqual(b.parts.map(p => p.key), keys, style + ': the same keys when drawn again');
  }
});

test('battens are counted left to right in each stretch, and a door starts a new stretch', () => {
  const t = section('board-batten', { y: 0.14, h: 1 });
  const door = { id: 'd', wallId: 'w1', type: 'door', t: 0.5, width: 0.8, height: 2.03 };
  const lay = T.trimLayout(t, wall(), [door]);
  const left = battens(lay).filter(p => p.x1 <= 1.6), right = battens(lay).filter(p => p.x0 >= 2.4);
  assert.deepEqual(left.map(p => p.key), left.map((_, i) => '0:v:' + i), 'left of the door');
  assert.deepEqual(right.map(p => p.key), right.map((_, i) => '1:v:' + i), 'right of the door');
  const place = T.boardPlace(lay, right[1]);
  assert.deepEqual(place, { n: 2, of: right.length }, 'its place among its kind');
  assert.equal(T.boardName(t, right[1]), 'Batten');
  assert.equal(T.boardName(t, lay.parts.find(p => p.dir === 'h')), 'Rail');
});

test('a batten cut round an outlet keeps its number, and the battens after it keep theirs', () => {
  const t = section('board-batten', { y: 0.14, h: 0.8, spacing: 0.4 });
  const plain = T.trimLayout(t, wall(), []);
  const b = battens(plain)[3];
  // An outlet's plate across that batten, too narrow to move the layout round it.
  const mid = (b.x0 + b.x1) / 2;
  const outlet = { side: 1, f0: (mid - 0.004) / 4, f1: (mid + 0.004) / 4, y0: 0.3, y1: 0.4, kind: 'device' };
  const cut = T.trimLayout(t, wall({ trimClearances: [outlet] }), []);
  const pieces = cut.parts.filter(p => p.key && p.key.startsWith(b.key + '/'));
  if (pieces.length) assert.ok(pieces.length >= 2, 'the cut batten is in pieces, each named after it');
  const after = battens(plain).slice(5).map(p => p.key);
  for (const k of after) assert.ok(cut.parts.some(p => p.key === k), k + ' is still there');
});

test('a board moved by hand stays put; the rest keep the automatic layout and follow the section', () => {
  const t = section('board-batten', { y: 0.14, h: 1, f0: 0.25, f1: 1 });
  const lay = T.trimLayout(t, wall(), []);
  const b = battens(lay)[2], box = T.boardBox(b);
  assert.ok(T.placeBoard(t, lay, b.key, { ...box, x0: box.x0 + 2 * IN, x1: box.x1 + 2 * IN }));
  const moved = T.trimLayout(t, wall(), []);
  const m = moved.parts.find(p => p.key === b.key);
  near(m.x0, box.x0 + 2 * IN, 'moved 2"'); assert.ok(m.edited, 'marked as changed by hand');
  near(battens(moved)[1].x0, battens(lay)[1].x0, 'its neighbour stays');
  assert.deepEqual(T.boardChanges(t), { moved: 1, hidden: 0, added: 0, total: 1 });
  // The section starts 1 ft later along the wall: the moved board goes with it.
  t.f0 += 0.3048 / 4;
  const later = T.trimLayout(t, wall(), []);
  near(later.parts.find(p => p.key === b.key).x0, box.x0 + 2 * IN + 0.3048, 'kept its place in the section');
  T.restoreBoard(t, b.key);
  assert.equal(t.boards, undefined, 'nothing left changed by hand');
});

test('deleting a board takes it out of the layout, the cut list with it; adding a copy puts one in', () => {
  const t = section('board-batten', { y: 0.14, h: 1 });
  const lay = T.trimLayout(t, wall(), []);
  const n = battens(lay).length, b = battens(lay)[1];
  T.removeBoard(t, b.key);
  const fewer = T.trimLayout(t, wall(), []);
  assert.equal(battens(fewer).length, n - 1, 'one batten fewer');
  assert.ok(!fewer.parts.some(p => p.key === b.key), 'the deleted one is gone');
  const box = T.boardBox(battens(lay)[0]);
  const key = T.copyBoard(t, lay, battens(lay)[0].key, { ...box, x0: box.x0 + 0.1, x1: box.x1 + 0.1 }, 'abc');
  assert.equal(key, 'add:abc');
  const more = T.trimLayout(t, wall(), []);
  assert.equal(battens(more).length, n, 'one deleted, one added');
  const added = more.parts.find(p => p.key === key);
  assert.ok(added.added && added.dir === 'v');
  near(added.x0, box.x0 + 0.1, 'where it was put');
  // An added board deleted goes for good; PUT EVERY BOARD BACK restores the layout.
  T.removeBoard(t, key);
  assert.ok(!t.boards[key], 'an added board deleted is not kept');
  T.restoreAllBoards(t);
  assert.equal(battens(T.trimLayout(t, wall(), [])).length, n, 'every batten back');
});

test('an added board takes the thickness of the product the section is made of', () => {
  const t = section('board-batten', { y: 0.14, h: 1 });
  const lay = T.trimLayout(t, wall(), []);
  const b = battens(lay)[0], box = T.boardBox(b);
  const key = T.copyBoard(t, lay, b.key, { ...box, x0: box.x0 + 0.05, x1: box.x1 + 0.05 }, 'x');
  t.boards[key].T = 0.5;                     // a stale thickness kept with the record
  const now = T.trimLayout(t, wall(), []);
  near(now.parts.find(p => p.key === key).T, b.T, 'the layout\'s batten thickness wins');
});

test('a run piece moved by hand loses the mitre at the end that moved', () => {
  const t = section('baseboard');
  const lay = T.trimLayout(t, wall(), []);
  const run = lay.parts[0];
  assert.ok(run.mitreA && run.mitreB);
  T.placeBoard(t, lay, run.key, { x0: run.x0 + 0.1, x1: run.x1, y0: run.y + 0.05, y1: run.y + 0.05 + run.W });
  const moved = T.trimLayout(t, wall(), []).parts[0];
  assert.ok(!moved.mitreA && moved.mitreB, 'a square end where it was shortened');
  near(moved.y, run.y + 0.05, 'raised');
});

test('a section from a file keeps well-formed board changes and drops the rest', () => {
  const t = section('board-batten', { boards: {
    '0:v:1': { hide: true }, '0:v:2': { x0: 0.5, x1: 0.56, y0: 0.14, y1: 1.1 },
    'add:a': { add: true, role: 'v', kind: 'board', dir: 'v', profile: 'eased', T: 0.019, x0: 1, x1: 1.06, y0: 0.14, y1: 1.1 },
    'bad:1': { x0: 1, x1: 0.5, y0: 0, y1: 1 }, 'bad:2': { x0: 'a' }, 'add:b': { add: true, kind: 'sofa', role: 'v', x0: 0, x1: 1, y0: 0, y1: 1 },
    'not-added': { add: true, kind: 'board', role: 'v', x0: 0, x1: 1, y0: 0, y1: 1 }, 'big:1': { x0: 0, x1: 1e9, y0: 0, y1: 1 },
  } });
  assert.deepEqual(Object.keys(t.boards).sort(), ['0:v:1', '0:v:2', 'add:a']);
  assert.equal(section('board-batten', { boards: { x: 5 } }).boards, undefined, 'nothing well formed: no boards field');
});

test('the mesh says which triangles are which board', () => {
  const t = section('board-batten', { y: 0.14, h: 1 });
  const lay = T.trimLayout(t, wall(), []);
  const { parts } = trimMeshParts(t, wall(), { walls: [wall()], wallHeight: 2.44 }, []);
  const main = parts.find(p => p.role === 'main');
  const tris = main.positions.length / 9;
  const covered = main.ranges.reduce((s, r) => s + r.count, 0);
  assert.equal(covered, tris, 'every triangle belongs to a board');
  assert.deepEqual(main.ranges.map(r => r.key).sort(), lay.parts.map(p => p.key).sort(), 'one range per board');
  for (let i = 1; i < main.ranges.length; i++) assert.equal(main.ranges[i].start, main.ranges[i - 1].start + main.ranges[i - 1].count, 'ranges follow each other');
  // A triangle of the third batten lies within that batten's place on the wall.
  const b = battens(lay)[2], r = main.ranges.find(x => x.key === b.key), x = main.positions[r.start * 9];
  assert.ok(x >= b.x0 - 1e-6 && x <= b.x1 + 1e-6, 'the range is that batten');
});

const D = await import('../js/trim-dims.js');

test('one batten measures the clear space to its neighbours and its height above the floor', () => {
  const t = section('board-batten', { y: 0.14, h: 1 });
  const lay = T.trimLayout(t, wall(), []);
  const bs = battens(lay), b = bs[2];
  const dims = D.boardDims(lay, b.key);
  const gaps = dims.filter(d => d.kind === 'gap'), height = dims.find(d => d.kind === 'height');
  assert.equal(gaps.length, 2, 'a space each side');
  near(gaps[0].v, b.x0 - bs[1].x1, 'to the batten on the left');
  near(gaps[1].v, bs[3].x0 - b.x1, 'to the batten on the right');
  near(height.v, b.y0, 'its bottom above the floor');
  // A rail: its bottom and top edges above the floor.
  const rail = lay.parts.find(p => p.dir === 'h');
  const rd = D.boardDims(lay, rail.key).filter(d => d.kind === 'height');
  assert.deepEqual(rd.map(d => d.note), ['bottom', 'top']);
  near(rd[1].v, rail.y1, 'top edge');
});

test('a section measures every space between its battens, end to end, and its field heights', () => {
  const t = section('board-batten', { y: 0.14, h: 1 });
  const lay = T.trimLayout(t, wall(), []);
  const dims = D.sectionDims(lay);
  const gaps = dims.filter(d => d.kind === 'gap');
  const bs = battens(lay);
  // The battens stand at both ends of the stretch: one space between each pair.
  assert.equal(gaps.length, bs.length - 1, 'one space between each pair of battens');
  const sum = gaps.reduce((s, d) => s + d.v, 0) + bs.reduce((s, b) => s + b.x1 - b.x0, 0);
  near(sum, lay.rects[0].x1 - lay.rects[0].x0, 'spaces and battens add up to the stretch', 1e-6);
  const h = dims.filter(d => d.kind === 'height');
  near(h[0].v, 0.14, 'field bottom'); near(h[1].v, 1.14, 'field top');
  const rail = D.sectionDims(T.trimLayout(section('chair-rail', { y: 0.84 }), wall(), []));
  assert.deepEqual(rail.map(d => d.note), ['bottom', 'top'], 'a moulding: its two edges');
  near(rail[0].v, 0.84, 'chair rail bottom');
  const base = D.sectionDims(T.trimLayout(section('baseboard'), wall(), []));
  assert.deepEqual(base.map(d => d.note), ['top'], 'a baseboard on the floor: its top only');
});

test('drags hold on round numbers: a whole foot, a 6" mark, a whole inch', () => {
  near(D.roundStick(41.9 * IN), 42 * IN, '41.9" holds on 42"');
  near(D.roundStick(41.6 * IN), 41.6 * IN, '41.6" is left alone');
  near(D.roundStick(36.3 * IN), 36 * IN, '36.3" holds on 3\'-0"');
  near(D.roundStick(17.1 * IN), 17 * IN, '17.1" holds on 17"');
  near(D.roundStick(17.3 * IN), 17.3 * IN, '17.3" is left alone');
  near(D.roundStick(0.447, true), 0.45, '447 mm holds on 450 mm');
  // The smallest adjustment that holds wins; a value that holds nothing gives 0.
  near(D.nearestHold([{ v: 41.9 * IN, sign: 1 }, { v: 17.05 * IN, sign: 1 }]), -0.05 * IN, 'the nearer hold');
  assert.equal(D.nearestHold([{ v: 41.6 * IN, sign: 1 }]), 0);
});

test('besideOf finds what stands either side of a board where it would be put', () => {
  const t = section('board-batten', { y: 0.14, h: 1 });
  const lay = T.trimLayout(t, wall(), []);
  const bs = battens(lay), b = bs[2], box = T.boardBox(b);
  const n = D.besideOf(lay, b.key, { ...box, x0: box.x0 + 0.01, x1: box.x1 + 0.01 });
  near(n.left, bs[1].x1, 'left neighbour'); near(n.right, bs[3].x0, 'right neighbour');
});
