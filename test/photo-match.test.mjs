// MATCH PHOTO: the camera view a photo carries, its framing maths, and the view surviving
// files, project slices and two-device merges. No browser; IndexedDB is stubbed out.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeView, viewFrame, defaultHfov, hfovOf, viewForPin, LONG_SIDE_FOV } from '../js/photo-match.js';
import { mergeShared } from '../js/workspace-merge.js';

globalThis.indexedDB = { open() { throw new Error('no IndexedDB under Node'); } };
const store = await import('../js/store.js');
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, a + ' != ' + b);
const VIEW = { position: [1, 1.5, 4], target: [1, 1.2, 0], fov: 68, from: 'saved' };

function photo(id, extra) {
  return Object.assign({ id, name: id, kind: 'photo', w: 4032, h: 3024, mime: 'image/jpeg', thumb: '', createdAt: '2026-01-01T00:00:00.000Z',
    notes: '', roomId: '', elementIds: [], itemIds: [], pin: { x: 1, y: 1.2, z: 0, nx: 0, ny: 0, nz: 1, size: 0.6 } }, extra);
}
function openFile(props) {
  store.ws.data = store.emptyWorkspace();
  const ids = store.mergeWorkspace(JSON.parse(JSON.stringify({ properties: props, materials: [], products: [], projects: [] })), { fromFile: true });
  return store.ws.data.properties.find(p => p.id === ids[0]);
}

test('a stored view is cleaned: numbers kept, lens clamped, unusable views refused', () => {
  assert.deepEqual(normalizeView(VIEW), VIEW);
  assert.deepEqual(normalizeView({ position: ['1', 2, 3], target: [0, 0, 0] }), { position: [1, 2, 3], target: [0, 0, 0], fov: LONG_SIDE_FOV });
  assert.equal(normalizeView({ ...VIEW, fov: 400 }).fov, 120);
  assert.equal(normalizeView({ ...VIEW, from: 'elsewhere' }).from, undefined);
  for (const bad of [null, 'view', [1, 2, 3], { position: [1, 2], target: [0, 0, 0] }, { position: [1, NaN, 2], target: [0, 0, 0] },
    { position: [1, 1, 1], target: [1, 1, 1] }, { target: [0, 0, 0] }]) assert.equal(normalizeView(bad), null, JSON.stringify(bad));
});

test('the photo fills the height of a wider view and the width of a narrower one, at its own lens', () => {
  const wide = viewFrame(1600, 800, 4 / 3, 72);
  close(wide.h, 800); close(wide.w, 800 * 4 / 3); close(wide.x, (1600 - wide.w) / 2); close(wide.y, 0);
  close(hfovOf(wide.vfov, 4 / 3), 72, 1e-9);   // across the photo frame the render spans the lens
  const tall = viewFrame(600, 900, 4 / 3, 72);
  close(tall.w, 600); close(tall.h, 450); close(tall.y, 225);
  close(hfovOf(tall.vfov, 600 / 900), 72, 1e-9);   // the whole viewport width is the photo width
  close(defaultHfov(4 / 3), 72); assert.ok(defaultHfov(3 / 4) < 60, 'a portrait phone photo is narrower across');
});

test('a pinned photo without a view starts out in front of its pin, looking at it', () => {
  const v = viewForPin({ x: 2, y: 1.4, z: 0, nx: 0, ny: 0, nz: 1 });
  assert.deepEqual(v.target, [2, 1.4, 0]); close(v.position[2], 2.5); close(v.position[1], 1.4);
  const floor = viewForPin({ x: 2, y: 0, z: 1, nx: 0, ny: 1, nz: 0 });
  assert.ok(floor.position[1] > 1, 'above a floor pin');
  assert.equal(viewForPin({ x: 'here', y: 0, z: 0 }), null);
});

test('views survive opening a file and the project file; older photos keep having none', () => {
  const p = store.propertyTemplate('Synthetic match');
  p.photos.push(photo('ph-view', { view: { ...VIEW, position: ['1', '1.5', '4'] } }), photo('ph-old'), photo('ph-broken', { view: { position: [0, 0], target: [0, 0, 0] } }));
  const got = openFile([p]);
  const byId = id => got.photos.find(ph => ph.id === id);
  assert.deepEqual(byId('ph-view').view, VIEW, 'numeric strings become numbers');
  assert.ok(!('view' in byId('ph-old')), 'an older photo gains no field');
  assert.ok(!('view' in byId('ph-broken')), 'a broken view is dropped, the photo kept');
  assert.equal(byId('ph-broken').pin.x, 1);
  const slice = JSON.parse(JSON.stringify(store.projectSlice(got.id)));
  assert.deepEqual(slice.properties[0].photos.find(ph => ph.id === 'ph-view').view, VIEW);
  const again = openFile(slice.properties);
  assert.deepEqual(again.photos.find(ph => ph.id === 'ph-view').view, VIEW, 'and reopen unchanged');
});

test('a view saved on one device merges with other edits to the same photo; two views conflict', () => {
  const base = { properties: [{ id: 'p', photos: [photo('a'), photo('b')] }] };
  const local = JSON.parse(JSON.stringify(base)), remote = JSON.parse(JSON.stringify(base));
  local.properties[0].photos[0].view = VIEW;
  remote.properties[0].photos[0].notes = 'Radiator under the window';
  remote.properties[0].photos[1].view = { ...VIEW, fov: 60 };
  const merged = mergeShared(base, local, remote);
  assert.deepEqual(merged.conflicts, []);
  const [a, b] = merged.value.properties[0].photos;
  assert.deepEqual(a.view, VIEW); assert.equal(a.notes, 'Radiator under the window'); assert.equal(b.view.fov, 60);
  const both = JSON.parse(JSON.stringify(remote));
  both.properties[0].photos[0].view = { ...VIEW, position: [2, 1.5, 4], fov: 50 };
  local.properties[0].photos[0].view = { ...VIEW, target: [1, 1, 0] };
  const clash = mergeShared(base, local, both);
  assert.deepEqual(clash.conflicts, ['properties.p.photos.a.view'], 'whole views conflict; parts never mix');
  assert.deepEqual(clash.value.properties[0].photos[0].view, local.properties[0].photos[0].view);
  // Lining up the same photo again on one device is an ordinary newer edit, not a conflict.
  local.properties[0].photos[0].view = VIEW;
  const relined = JSON.parse(JSON.stringify(local));
  relined.properties[0].photos[0].view = { ...VIEW, fov: 70 };
  assert.deepEqual(mergeShared(local, relined, local).value.properties[0].photos[0].view.fov, 70);
});
