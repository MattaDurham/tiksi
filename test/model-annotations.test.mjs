// MODEL's DIMENSIONS, ROOMS and NUMBERS labels: what each shows and where it sits.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerHooks } from 'node:module';

// geometry.js (the room label's point) imports three by its browser import-map names.
const vendor = new URL('../vendor/', import.meta.url).href;
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'three') return { url: vendor + 'three.module.min.js', shortCircuit: true };
    if (spec.startsWith('three/addons/')) return { url: vendor + 'addons/' + spec.slice(13), shortCircuit: true };
    return next(spec, ctx);
  },
});
globalThis.indexedDB = { open() { throw new Error('no IndexedDB under Node'); } };
const { modelAnnotations } = await import('../js/model-annotations.js');
const { openingSchedule } = await import('../js/opening-schedule.js');
const { normalizeSavedView } = await import('../js/saved-views.js');

// A synthetic 6 x 4 m box on two storeys, a partition at x = 3 on the ground floor.
function house() {
  const wall = (id, level, ax, ay, bx, by) => ({ id, level, ax, ay, bx, by, thickness: 0.15 });
  return {
    levels: [{ id: 'ground', name: 'Ground', elevation: 0, height: 2.7 }, { id: 'upper', name: 'Upper', elevation: 3, height: 2.7 }],
    walls: [
      wall('s', 'ground', 0, 0, 6, 0), wall('e', 'ground', 6, 0, 6, 4), wall('n', 'ground', 6, 4, 0, 4), wall('w', 'ground', 0, 4, 0, 0),
      wall('mid', 'ground', 3, 0, 3, 4), wall('us', 'upper', 0, 0, 6, 0),
    ],
    rooms: [
      { id: 'k', level: 'ground', name: 'Kitchen', pts: [[0, 0], [3, 0], [3, 4], [0, 4]] },
      { id: 'u', level: 'upper', name: '', pts: [[0, 0], [6, 0], [6, 4], [0, 4]] },
    ],
    openings: [
      { id: 'door', wallId: 's', type: 'door', t: 0.25, width: 0.9, height: 2.03 },
      { id: 'win', wallId: 'e', type: 'window', t: 0.5, width: 1.2, height: 1.2, sill: 0.9 },
    ],
  };
}
const fmt = { fmtLen: m => m.toFixed(2) + ' m', fmtArea: a => a.toFixed(1) + ' m2' };

test('each wall gets its centre-line length on its negative side, just above its floor', () => {
  const a = modelAnnotations(house(), fmt);
  const s = a.dims.find(d => d.id === 's');
  assert.equal(s.text, '6.00 m');
  // Wall s runs east along y = 0; its negative side is -y, a little past the face.
  assert.ok(s.a[2] < -0.075 && s.b[2] === s.a[2], 'the line runs beside the wall, outside its face');
  assert.deepEqual([s.a[0], s.b[0]], [0, 6]);
  assert.equal(s.a[1], 0.02);
  assert.deepEqual(s.at, [3, 0.02, s.a[2]]);
  const up = a.dims.find(d => d.id === 'us');
  assert.equal(up.at[1], 3.02, 'an upper wall sits on its own floor');
});

test('rooms show their name and area; a room with no name reads Room', () => {
  const a = modelAnnotations(house(), fmt);
  const k = a.rooms.find(r => r.id === 'k');
  assert.equal(k.name, 'Kitchen');
  assert.equal(k.text, '12.0 m2');
  assert.ok(k.at[0] > 0 && k.at[0] < 3 && k.at[2] > 0 && k.at[2] < 4, 'the label is inside the room');
  assert.equal(a.rooms.find(r => r.id === 'u').name, 'Room');
});

test('doors and windows carry the schedule mark, at the middle of the opening', () => {
  const p = house();
  const a = modelAnnotations(p, fmt);
  const marks = new Map(openingSchedule(p).map(r => [r.id, r.number]));
  const door = a.openings.find(o => o.id === 'door'), win = a.openings.find(o => o.id === 'win');
  assert.equal(door.text, marks.get('door'));
  assert.equal(win.text, marks.get('win'));
  assert.deepEqual(door.at, [1.5, 2.03 / 2, 0]);
  assert.equal(win.at[1], 0.9 + 0.6, 'a window mark sits halfway up the glass');
  assert.equal(win.type, 'window');
});

test('a hidden level shows none of its labels', () => {
  const a = modelAnnotations(house(), { ...fmt, hidden: new Set(['ground']) });
  assert.deepEqual(a.dims.map(d => d.id), ['us']);
  assert.deepEqual(a.rooms.map(r => r.id), ['u']);
  assert.deepEqual(a.openings, []);
});

test('a saved view keeps PARALLEL, and a view saved without it stays in perspective', () => {
  const camera = { position: [1, 2, 3], target: [0, 0, 0], fov: 50 };
  assert.equal(normalizeSavedView({ name: 'Top', camera: { ...camera, parallel: true } }, new Set()).camera.parallel, true);
  assert.equal(normalizeSavedView({ name: 'Old', camera }, new Set()).camera.parallel, undefined);
  assert.equal(normalizeSavedView({ name: 'Odd', camera: { ...camera, parallel: 'yes' } }, new Set()).camera.parallel, undefined);
});
