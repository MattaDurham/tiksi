// Markups (markups.js): ink and numbered notes survive the project file and hostile input,
// two devices adding to one markup both keep their work, and the eraser and the point
// thinning do what the drawing layer relies on. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.indexedDB = { open() { throw new Error('no IndexedDB under Node'); } };
const store = await import('../js/store.js');
const M = await import('../js/markups.js');
const { mergeShared } = await import('../js/workspace-merge.js');

const view = (x = 5) => ({ camera: { position: [x, 4, 6], target: [0, 1, 0], fov: 50 }, mode: 'orbit', section: { on: false, height: 1.2 }, xray: false, hiddenLevels: [] });
const line = (y = 0) => ({ tool: 'pen', color: '#E5372B', width: 0.006, pts: [-0.2, y, 0.5, 0, y, 0.5, 0.2, y, 0.5] });
const copy = v => JSON.parse(JSON.stringify(v));

test('a new property has no markups, and a markup numbers itself', () => {
  const p = store.propertyTemplate('Marks');
  assert.deepEqual(p.markups, []);
  const a = M.addMarkup(p, { on: 'model', view: view() });
  const b = M.addMarkup(p, { on: 'plan', levelId: p.levels[0].id });
  assert.equal(a.number, 1);
  assert.equal(b.number, 2);
  assert.equal(M.markupTitle(a), 'Markup 1');
  assert.deepEqual(a.view.camera, { position: [5, 4, 6], target: [0, 1, 0], fov: 50 });
  assert.equal(b.levelId, p.levels[0].id);
  assert.equal(b.view, undefined);
  // An earlier markup's number is not handed out again while a later one exists.
  M.deleteMarkup(p, a.id);
  assert.equal(M.addMarkup(p, { on: 'plan', levelId: p.levels[0].id }).number, 3);
});

test('a markup over the model needs a camera and one on the plan needs a level', () => {
  const p = store.propertyTemplate('Marks');
  assert.throws(() => M.addMarkup(p, { on: 'model' }), /camera/);
  assert.throws(() => M.addMarkup(p, { on: 'plan' }), /level/);
  assert.deepEqual(p.markups, []);
});

test('strokes and notes are kept as drawn, with the next note number', () => {
  const p = store.propertyTemplate('Marks');
  const m = M.addMarkup(p, { on: 'model', view: view() });
  const s = M.addStroke(m, line(0.1));
  assert.equal(s.color, '#e5372b');
  assert.deepEqual(s.pts, [-0.2, 0.1, 0.5, 0, 0.1, 0.5, 0.2, 0.1, 0.5]);
  const n1 = M.addNote(m, { at: [0.1, 0.1], anchor: { x: 1, y: 0.9, z: 2, nx: 0, ny: 0, nz: 1 }, kind: 'wall', ref: 'w-1', text: 'Chair rail here' });
  const n2 = M.addNote(m, { at: [0.3, 0.2], text: '' });
  assert.equal(n1.n, 1);
  assert.equal(n2.n, 2);
  assert.equal(n1.anchor.y, 0.9);
  assert.equal(n2.anchor, undefined);
  M.removeNote(m, n1.id);
  assert.equal(M.addNote(m, { at: [0, 0] }).n, 3, 'a removed note leaves its number unused');
  assert.equal(M.addStroke(m, { tool: 'pen', color: '#000000', width: 0.01, pts: [] }), null, 'a stroke with no point is refused');
  assert.equal(m.strokes.length, 1);
});

test('markups survive the project file', () => {
  const d = store.emptyWorkspace ? store.emptyWorkspace() : { properties: [], projects: [], products: [], materials: [], settings: {} };
  const p = store.propertyTemplate('Marks');
  d.properties.push(p);
  const m = M.addMarkup(p, { on: 'model', view: view() });
  const s = M.addStroke(m, { ...line(), on: [{ k: 'wall', id: 'w-1', p: [1, 0.9, 2] }] });
  M.addNote(m, { at: [0, 0], anchor: { x: 1, y: 0.9, z: 2 }, text: 'Chair rail here' });
  const back = store.tidiedCopy(d).properties[0];
  assert.equal(back.markups.length, 1);
  assert.deepEqual(back.markups[0].strokes[0], s);
  assert.deepEqual(back.markups[0].strokes[0].on, [{ k: 'wall', id: 'w-1', p: [1, 0.9, 2] }]);
  assert.equal(back.markups[0].notes[0].text, 'Chair rail here');
  assert.deepEqual(back.markups[0].notes[0].anchor, { x: 1, y: 0.9, z: 2, nx: 0, ny: 1, nz: 0 });
});

test('a hand-edited file cannot break the list', () => {
  const p = { markups: [
    null, 'ink', { on: 'model' }, { on: 'plan' },
    { id: 'a b', on: 'plan', levelId: 'lvl-0', number: -4, status: 'gone', name: 'x'.repeat(200),
      strokes: [{ pts: [0, 0, 0.5, NaN, 1, 0.5, 1, 1, 9], color: 'red', width: -1, tool: 'spray' }, { pts: 'no' }, { pts: [1, 2] }],
      notes: [{ at: [1, 'two'] }, { at: [1, 2], n: 0, text: 5 }, { anchor: { x: 1, y: 2, z: 3, wall: 'bad' } }] },
    { id: 'dup', on: 'plan', levelId: 'lvl-0', number: 7, strokes: [], notes: [] },
    { id: 'dup', on: 'plan', levelId: 'lvl-0', number: 7, strokes: [], notes: [] },
  ] };
  M.normalizeMarkups(p);
  assert.equal(p.markups.length, 3);
  const [m, d1, d2] = p.markups;
  assert.match(m.id, /^markup-/);
  assert.equal(m.name.length, 60);
  assert.equal(m.status, 'open');
  assert.equal(m.strokes.length, 1);
  assert.deepEqual(m.strokes[0].pts, [0, 0, 0.5, 1, 1, 1]);
  assert.equal(m.strokes[0].tool, 'pen');
  assert.equal(m.strokes[0].color, M.MARKUP_COLORS[0]);
  assert.ok(m.strokes[0].width > 0);
  assert.equal(m.notes.length, 2);
  assert.equal(m.notes[0].text, '');
  assert.equal(m.notes[1].anchor.wall, undefined);
  assert.notEqual(d1.id, d2.id);
  assert.equal(m.number, 8, 'a markup with no usable number gets the next one');
  assert.deepEqual([d1.number, d2.number], [7, 9], 'two markups with one number: the later one is renumbered');
});

test('two devices adding ink to one markup both keep their strokes', () => {
  const p = store.propertyTemplate('Marks');
  const m = M.addMarkup(p, { on: 'plan', levelId: p.levels[0].id });
  M.addStroke(m, line(0));
  const base = copy(p), mine = copy(p), theirs = copy(p);
  M.addStroke(mine.markups[0], line(1));
  M.addNote(mine.markups[0], { at: [1, 1], text: 'mine' });
  M.addStroke(theirs.markups[0], line(2));
  const their2 = M.addMarkup(theirs, { on: 'plan', levelId: p.levels[0].id });
  M.addStroke(their2, line(3));
  const merged = mergeShared(base, mine, theirs);
  assert.deepEqual(merged.conflicts, []);
  assert.equal(merged.value.markups.length, 2);
  assert.deepEqual(merged.value.markups[0].strokes.map(s => s.pts[1]).sort(), [0, 1, 2]);
  assert.equal(merged.value.markups[0].notes.length, 1);
  // Each device also made a new markup, both numbered 2: both are kept, numbered apart.
  const mine2 = M.addMarkup(mine, { on: 'plan', levelId: p.levels[0].id });
  M.addStroke(mine2, line(4));
  const both = mergeShared(base, mine, theirs);
  assert.deepEqual(both.conflicts, []);
  M.normalizeMarkups(both.value);
  assert.deepEqual(both.value.markups.map(x => x.number), [1, 2, 3]);
});

test('the eraser finds a stroke by its line, not its box', () => {
  const s = { width: 0.02, pts: [0, 0, 0.5, 1, 1, 0.5] };
  assert.equal(M.strokeHit(s, 0.5, 0.5, 0.01), true);
  assert.equal(M.strokeHit(s, 0.5, 0.52, 0.01), true, 'within the eraser plus half the line width');
  assert.equal(M.strokeHit(s, 0.9, 0.1, 0.05), false, 'inside the box but far from the line');
  assert.equal(M.strokeHit(s, 1.5, 1.5, 0.05), false);
  assert.equal(M.strokeHit({ width: 0.02, pts: [3, 3, 0.5] }, 3.01, 3, 0.01), true, 'a dot');
});

test('thinning keeps the corners and drops the points on a straight run', () => {
  const pts = [];
  for (let i = 0; i <= 50; i++) pts.push(i / 50, 0, 0.5);
  for (let i = 1; i <= 50; i++) pts.push(1, i / 50, 0.8);
  const out = M.simplifyPoints(pts, 0.001);
  assert.deepEqual(out, [0, 0, 0.5, 1, 0, 0.5, 1, 1, 0.8]);
  assert.deepEqual(M.simplifyPoints([0, 0, 0.5, 1, 1, 0.5], 0.5), [0, 0, 0.5, 1, 1, 0.5]);
  assert.deepEqual(M.roundPoints([0.123456789, 1 / 3, 0.777, NaN, 1, 1], 4), [0.1235, 0.3333, 0.78]);
});

test('the same camera is recognised after the rounding a flight leaves, and a moved one is not', () => {
  const a = view().camera;
  assert.equal(M.sameCamera(a, { position: [5.0001, 4, 6], target: [0, 1.0001, 0], fov: 50 }), true);
  assert.equal(M.sameCamera(a, { position: [5.2, 4, 6], target: [0, 1, 0], fov: 50 }), false);
  assert.equal(M.sameCamera(a, { position: [5, 4, 6], target: [0, 1, 0], fov: 35 }), false);
  assert.equal(M.sameCamera(a, null), false);
  // The orbit target sliding along the line of sight is the same picture; a close-up is held
  // to its own distance, not to a metre.
  assert.equal(M.sameCamera(a, { position: [5, 4, 6], target: [2.5, 2.5, 3], fov: 50 }), true);
  const near = { position: [0, 1, 0.1], target: [0, 1, 0], fov: 50 };
  assert.equal(M.sameCamera(near, { position: [0, 1.001, 0.1], target: [0, 1.001, 0], fov: 50 }), false, 'a millimetre matters ten centimetres from the wall');
  assert.equal(M.sameCamera(near, { position: [0, 1, 0.1], target: [0, 1, -3], fov: 50 }), true);
});

test('a markup emptied by the eraser or by undo is taken out, the open one stays', () => {
  const p = store.propertyTemplate('Marks');
  const a = M.addMarkup(p, { on: 'model', view: view() });
  const b = M.addMarkup(p, { on: 'model', view: view(9) });
  const s = M.addStroke(a, line());
  assert.equal(M.pruneEmptyMarkups(p, b.id), 0);
  const taken = M.removeStroke(a, s.id);
  assert.equal(taken.index, 0);
  assert.equal(M.pruneEmptyMarkups(p, b.id), 1);
  assert.deepEqual(p.markups.map(m => m.id), [b.id]);
  // Undo of that erase puts the markup and its stroke back under the same ids.
  const again = M.restoreMarkup(p, a, 0);
  assert.equal(again.id, a.id);
  assert.equal(M.addStroke(again, taken.stroke, taken.index).id, s.id);
  assert.deepEqual(p.markups.map(m => m.id), [a.id, b.id]);
});

test('pen pressure sets the line width around the chosen size', () => {
  assert.equal(M.penWidth(10, 0.5), 10);
  assert.ok(M.penWidth(10, 0) < 4 && M.penWidth(10, 0) > 3);
  assert.ok(M.penWidth(10, 1) > 16);
  assert.equal(M.evenPressure([0, 0, 0.5, 1, 1, 0.5]), true);
  assert.equal(M.evenPressure([0, 0, 0.2, 1, 1, 0.7]), false);
});
