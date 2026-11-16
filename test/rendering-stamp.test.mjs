// The view label a rendering carries (rendering-stamp.js), the view it puts a picture on
// (view-renderings.js), and the list of every photo and rendering (picture-picker.js).
// Synthetic pictures in test/fixtures/rendering-stamp only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

globalThis.indexedDB = { open() { throw new Error('no IndexedDB under Node'); } };
const S = await import('../js/rendering-stamp.js');
const R = await import('../js/view-renderings.js');
const P = await import('../js/picture-picker.js');
const fix = name => readFile(new URL('./fixtures/rendering-stamp/' + name, import.meta.url));

test('both copies read each other\'s labels, and plain pictures have none', async () => {
  for (const ext of ['png', 'jpg']) {
    assert.deepEqual(await S.readLabel(await fix('py-stamped.' + ext)), { property: 'prop-test', propertyName: 'Test house', view: 'sv-living', viewName: 'Living & "Dining"', room: 'Living', by: 'python' });
    assert.equal((await S.readLabel(await fix('js-stamped.' + ext))).viewName, 'Kitchen, north wall');
    assert.equal(await S.readLabel(await fix('plain.' + ext)), null);
  }
});

test('stamping again replaces the label and leaves the picture data alone', async () => {
  for (const ext of ['png', 'jpg']) {
    const plain = new Uint8Array(await fix('plain.' + ext));
    const twice = await S.stampBytes(await S.stampBytes(plain, { viewName: 'Living' }), { room: 'Hall' });
    assert.deepEqual(await S.readLabel(twice), { room: 'Hall' });
    assert.deepEqual([...twice.slice(-40)], [...plain.slice(-40)], ext);
  }
  await assert.rejects(S.stampBytes(new TextEncoder().encode('GIF89a'), { room: 'Hall' }), /PNG and JPEG/);
  await assert.rejects(S.stampBytes(new Uint8Array(await fix('plain.png')), {}), /empty/);
  assert.equal(await S.readLabel(new Uint8Array(await fix('plain.png')).slice(0, 20)), null, 'a file cut short has no label, and no error');
});

const prop = () => ({
  id: 'prop-a', name: 'House',
  rooms: [{ id: 'r-k', name: 'Kitchen' }, { id: 'r-l', name: 'Living' }],
  savedViews: [{ id: 'v-l', name: 'Living' }, { id: 'v-kn', name: 'Kitchen, north wall' }, { id: 'v-ks', name: 'Kitchen, south wall long' }, { id: 'v-h', name: 'Hallway' }],
});
const listed = (path, stamp) => ({ id: 'pf-' + path, name: path.split('/').pop(), kind: 'photo', file: { path, group: 'photo', ...(stamp ? { stamp } : {}) } });

test('a label puts a picture on its view: by id, then name, then room', () => {
  const p = prop();
  const on = stamp => (R.viewOfPicture(p, listed('Photos/out.png', stamp)) || {}).view?.id || null;
  assert.equal(on({ property: 'prop-a', view: 'v-h', viewName: 'Living' }), 'v-h', 'the id wins');
  assert.equal(on({ property: 'prop-other', view: 'v-h', viewName: 'Living' }), 'v-l', 'another property\'s id is not used; the name is');
  assert.equal(on({ viewName: 'kitchen north wall' }), 'v-kn', 'a name matches in any case and punctuation');
  assert.equal(on({ room: 'Kitchen' }), 'v-kn', 'a room goes on its shortest view');
  assert.equal(on({ room: 'Living' }), 'v-l');
  assert.equal(on({ room: 'Garage' }), null);
  assert.equal(R.viewOfPicture(p, listed('Photos/out.png', { room: 'Living' })).by, 'label');
  assert.equal(R.isRendering(listed('Photos/out.png', { room: 'Living' })), true, 'a labelled picture is a rendering');
});

test('a choice made by hand beats the label, and the label beats the file name', () => {
  const p = prop();
  assert.equal(R.viewOfPicture(p, { ...listed('Renders/Hallway.png', { room: 'Living' }), savedViewId: 'v-kn' }).view.id, 'v-kn');
  assert.equal(R.viewOfPicture(p, { ...listed('Renders/Hallway.png', { room: 'Living' }), savedViewId: '' }), null, 'taken off every view by hand');
  const named = { ...listed('Renders/Hallway.png', { room: 'Living' }) }; named.file.group = 'rendering';
  assert.equal(R.viewOfPicture(p, named).view.id, 'v-l');
});

test('the label for a view names its room', () => {
  const p = prop();
  assert.deepEqual(S.labelFor(p, p.savedViews[1], { by: 'x' }), { property: 'prop-a', propertyName: 'House', view: 'v-kn', viewName: 'Kitchen, north wall', room: 'Kitchen', by: 'x' });
  assert.equal(S.labelFor(p, p.savedViews[3]).room, '');
});

test('the picker lists renderings, photos or all, newest first, by name and by view', () => {
  const p = prop();
  const pics = [
    { ...listed('Renders/Living.png'), createdAt: '2026-11-01' },
    { ...listed('Photos/IMG_1.jpg'), createdAt: '2026-11-03' },
    { ...listed('Photos/out.png', { room: 'Kitchen' }), createdAt: '2026-11-02' },
    { ...listed('Scan/images/1.jpg'), file: { path: 'Scan/images/1.jpg', group: 'scan' } },
    { id: 'doc', name: 'plan.pdf', kind: 'document' },
  ];
  pics[0].file.group = 'rendering';
  const ids = o => P.pickerList(p, pics, o).map(x => x.file.path);
  assert.deepEqual(ids({ tab: 'renderings' }), ['Photos/out.png', 'Renders/Living.png']);
  assert.deepEqual(ids({ tab: 'photos' }), ['Photos/IMG_1.jpg']);
  assert.deepEqual(ids({ tab: 'all' }), ['Photos/IMG_1.jpg', 'Photos/out.png', 'Renders/Living.png'], 'no scan frames or documents');
  assert.deepEqual(ids({ tab: 'all', find: 'renders liv' }), ['Renders/Living.png']);
  assert.deepEqual(ids({ tab: 'all', where: 'off' }), ['Photos/IMG_1.jpg']);
  assert.deepEqual(ids({ tab: 'all', where: 'on' }), ['Photos/out.png', 'Renders/Living.png']);
});
