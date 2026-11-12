// Markup ink on the model's surfaces and the line tool's snapping (markup-surface.js), and how
// such strokes are kept (markups.js). Synthetic geometry only: a room whose west wall is the
// plane x = 0, seen by a simple camera that looks along -z.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.indexedDB = { open() { throw new Error('no IndexedDB under Node'); } };
const S = await import('../js/markup-surface.js');
const M = await import('../js/markups.js');
const store = await import('../js/store.js');

const near = (a, b, eps = 1e-6) => a.every((v, i) => Math.abs(v - b[i]) < eps);
// A camera at (0, 0, 10) looking down -z: a point (x, y, z) is on the screen at
// (400 + 100 x / (10 - z), 300 - 100 y / (10 - z)), and the ray through a pixel is its inverse.
const project = p => (10 - p[2] > 0 ? [400 + 100 * p[0] / (10 - p[2]), 300 - 100 * p[1] / (10 - p[2])] : null);
const rayAt = (x, y) => { const d = [(x - 400) / 100, -(y - 300) / 100, -1], l = Math.hypot(...d); return { o: [0, 0, 10], d: d.map(v => v / l) }; };

test('a ray meets a plane in front of it, and not one behind or alongside', () => {
  assert.ok(near(S.rayPlane([0, 0, 10], [0, 0, -1], [0, 0, 2], [0, 0, 1]), [0, 0, 2]));
  assert.equal(S.rayPlane([0, 0, 10], [0, 0, 1], [0, 0, 2], [0, 0, 1]), null, 'behind');
  assert.equal(S.rayPlane([0, 0, 10], [1, 0, 0], [0, 0, 2], [0, 0, 1]), null, 'alongside');
});

test('freehand ink lands on the surfaces, lifted towards the viewer', () => {
  // Three samples straight onto a wall facing the camera (the plane z = 0, normal +z).
  const samples = [380, 400, 420].map(x => { const r = rayAt(x, 300); return { ...r, px: [x, 300], hit: { p: S.rayPlane(r.o, r.d, [0, 0, 0], [0, 0, 1]), n: [0, 0, 1] } }; });
  const pieces = S.dropOntoSurfaces(samples, { lift: 0.004, mPerPx: () => 0.1 });
  assert.equal(pieces.length, 1);
  assert.deepEqual([pieces[0].first, pieces[0].last], [0, 2]);
  const w = pieces[0].w;
  assert.equal(w.length, 9);
  for (let i = 2; i < 9; i += 3) assert.ok(Math.abs(w[i] - 0.004) < 1e-9, 'each point is 4 mm off the wall, on the seen side');
  assert.ok(Math.abs(w[0] + 2) < 1e-6 && Math.abs(w[6] - 2) < 1e-6, 'and where the pen was: ' + w);
  // The same wall seen from behind (its normal points away): the lift is still towards the viewer.
  const back = samples.map(s => ({ ...s, hit: { ...s.hit, n: [0, 0, -1] } }));
  assert.ok(S.dropOntoSurfaces(back, { lift: 0.004 })[0].w.filter((_, i) => i % 3 === 2).every(z => Math.abs(z - 0.004) < 1e-9));
});

test('ink over empty space stays on the plane of the surface it was just on', () => {
  // The middle sample passes over a window opening: no hit there.
  const at = x => { const r = rayAt(x, 300); return { ...r, px: [x, 300], hit: { p: S.rayPlane(r.o, r.d, [0, 0, 0], [0, 0, 1]), n: [0, 0, 1] } }; };
  const samples = [at(380), { ...rayAt(400, 300), px: [400, 300], hit: null }, at(420)];
  const [piece] = S.dropOntoSurfaces(samples, { lift: 0, mPerPx: () => 0.1 });
  assert.ok(near(piece.w.slice(3, 6), [0, 0, 0]), 'the gap is bridged on the wall\'s plane: ' + piece.w.slice(3, 6));
  // A stroke that starts in the air lands on the first surface after it.
  const late = [{ ...rayAt(380, 300), px: [380, 300], hit: null }, at(400)];
  assert.ok(near(S.dropOntoSurfaces(late, { lift: 0 })[0].w.slice(0, 3), [-2, 0, 0]));
  // A stroke that touches nothing is not ink on the surfaces at all.
  assert.deepEqual(S.dropOntoSurfaces([{ ...rayAt(400, 300), px: [400, 300], hit: null }]), []);
});

test('ink that jumps from a near wall to a far one breaks instead of crossing the air', () => {
  const r1 = rayAt(400, 300), r2 = rayAt(404, 300);
  const samples = [
    { ...r1, px: [400, 300], hit: { p: S.rayPlane(r1.o, r1.d, [0, 0, 5], [0, 0, 1]), n: [0, 0, 1] } },
    { ...r2, px: [404, 300], hit: { p: S.rayPlane(r2.o, r2.d, [0, 0, -20], [0, 0, 1]), n: [0, 0, 1] } },
  ];
  const pieces = S.dropOntoSurfaces(samples, { lift: 0, mPerPx: p => (10 - p[2]) / 100 });
  assert.deepEqual(pieces.map(p => [p.first, p.last]), [[0, 0], [1, 1]]);
});

test('3D thinning keeps the corners of a line and drops the points along its straight runs', () => {
  const pts = [0, 0, 0, 0.5, 0, 0, 1, 0, 0, 1, 0.5, 0, 1, 1, 0];
  assert.deepEqual(S.simplify3(pts, 0.001), [0, 0, 0, 1, 0, 0, 1, 1, 0]);
});

test('the line tool snaps to an endpoint before an edge, and to an edge before the face', () => {
  const edge = [[-5, 0, 0], [5, 0, 0]];   // from (350, 300) to (450, 300) on the screen
  const q = (x, y, extra = {}) => ({ ray: rayAt(x, y), cursor: [x, y], project, hit: { p: S.rayPlane(rayAt(x, y).o, rayAt(x, y).d, [0, 0, 0], [0, 0, 1]) }, edges: [edge], ...extra });
  let r = S.inferPoint(q(354, 302));
  assert.equal(r.kind, 'endpoint');
  assert.equal(r.label, 'Endpoint');
  assert.ok(near(r.p, [-5, 0, 0]), 'it is the edge\'s end exactly');
  r = S.inferPoint(q(401, 302));
  assert.equal(r.kind, 'midpoint');
  assert.ok(near(r.p, [0, 0, 0]));
  r = S.inferPoint(q(420, 304));
  assert.equal(r.kind, 'edge');
  assert.ok(Math.abs(r.p[1]) < 1e-9 && Math.abs(r.p[0] - 2) < 0.01, 'on the edge, under the pointer: ' + r.p);
  r = S.inferPoint(q(430, 250));
  assert.equal(r.kind, 'face');
  assert.equal(S.inferPoint({ ray: rayAt(430, 250), cursor: [430, 250], project, hit: null }), null, 'over nothing, nothing');
});

test('from a point, the line snaps to the axes, parallel and perpendicular to an edge, and holds a direction', () => {
  const plane = { p: [0, 0, 0], n: [0, 0, 1] };
  const prev = [0, 0, 0];
  const base = (x, y, extra = {}) => ({ ray: rayAt(x, y), cursor: [x, y], project, hit: { p: [0, 0, 0] }, prev, plane, ...extra });
  // Nearly straight up from the first point: the blue axis, exactly.
  let r = S.inferPoint(base(403, 250));
  assert.equal(r.kind, 'blue');
  assert.equal(r.label, 'On blue axis');
  assert.ok(Math.abs(r.p[0]) < 1e-9 && r.p[1] > 0.4, 'the point is straight above: ' + r.p);
  // Nearly along x: the red axis. The green axis (z) does not run along this wall, so it never shows.
  r = S.inferPoint(base(450, 303));
  assert.equal(r.kind, 'red');
  // A sloping edge of reference: parallel to it, then perpendicular to it within the wall.
  const slope = S.vec.unit([1, 1, 0]);
  r = S.inferPoint(base(452, 249, { refs: [{ d: slope, edge: [[2, 0, 0], [3, 1, 0]] }] }));
  assert.equal(r.kind, 'parallel');
  assert.equal(r.label, 'Parallel to edge');
  assert.ok(Math.abs(r.p[0] - r.p[1]) < 1e-9);
  r = S.inferPoint(base(348, 251, { refs: [{ d: slope, edge: [[2, 0, 0], [3, 1, 0]] }] }));
  assert.equal(r.kind, 'perpendicular');
  assert.equal(r.label, 'Perpendicular to edge');
  assert.ok(Math.abs(r.p[0] + r.p[1]) < 1e-9 && Math.abs(r.p[2]) < 1e-9, 'at right angles to the edge, on the wall: ' + r.p);
  // Held: the pointer far from the axis still gives a point on it.
  r = S.inferPoint(base(470, 200, { lock: { dir: [1, 0, 0], kind: 'red', label: 'On red axis', color: '#e0312a' } }));
  assert.equal(r.kind, 'red');
  assert.equal(r.locked, true);
  assert.ok(Math.abs(r.p[1]) < 1e-9 && Math.abs(r.p[2]) < 1e-9 && r.p[0] > 0.5);
  // Nowhere near a direction: on the wall's plane under the pointer.
  r = S.inferPoint(base(470, 200));
  assert.equal(r.kind, 'face');
  assert.ok(Math.abs(r.p[2]) < 1e-9);
});

test('points off the line\'s face are not snapped to', () => {
  const plane = { p: [0, 0, 0], n: [0, 0, 1] };
  const r = S.inferPoint({ ray: rayAt(400, 300), cursor: [400, 300], project, hit: { p: [0, 0, 0] }, plane, points: [[0, 0, 1.5]] });
  assert.equal(r.kind, 'face', 'a point 1.5 m in front of the wall is not an endpoint for a line on it');
});

test('ink on the surfaces and lines are kept with their 3D points, and hostile ones are refused', () => {
  const p = store.propertyTemplate('Marks');
  const m = M.addMarkup(p, { on: 'model', view: { camera: { position: [5, 4, 6], target: [0, 1, 0], fov: 50 }, mode: 'orbit', section: { on: false, height: 1.2 }, xray: false, hiddenLevels: [] } });
  const ink = M.addStroke(m, { tool: 'pen', color: '#1F6FEB', width: 0.004, w: [0.1, 1.23456789, 0.004, 0.2, 1.3, 0.004] });
  assert.deepEqual(ink.w, [0.1, 1.2346, 0.004, 0.2, 1.3, 0.004], 'rounded to a tenth of a millimetre');
  assert.deepEqual(ink.pts, []);
  assert.equal(M.onSurfaces(ink), true);
  const line = M.addStroke(m, { tool: 'line', color: '#111111', px: 4, w: [0, 0, 0, 1, 0, 0] });
  assert.equal(line.tool, 'line');
  assert.equal(line.px, 4);
  assert.equal(M.addStroke(m, { tool: 'line', pts: [0, 0, 0.5] }), null, 'a line exists only on the surfaces');
  assert.equal(M.addStroke(m, { tool: 'pen', w: [NaN, 1, 2, 'x', 1, 2] }), null, 'no usable point, no stroke');
  assert.equal(M.addStroke(m, { tool: 'line', px: 900, w: [0, 0, 0, 1, 0, 0] }).px, 2.5, 'an unreasonable width falls back');
  // Only what is flat on the screen ties a markup to its own view.
  assert.equal(M.markupFlat(m), false);
  M.addStroke(m, { tool: 'pen', width: 0.005, pts: [0, 0, 0.5] });
  assert.equal(M.markupFlat(m), true);
  // The project file round trip keeps it all.
  const again = M.normalizeMarkup(JSON.parse(JSON.stringify(m)));
  assert.deepEqual(again.strokes.map(s => [s.tool, s.w || null, s.pts.length]), m.strokes.map(s => [s.tool, s.w || null, s.pts.length]));
});
