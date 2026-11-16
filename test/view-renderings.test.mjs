// Renderings of saved views (view-renderings.js): which pictures show with which view.
// Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRendering, viewOfPicture, picturesByView, looseRenderings, tagPicture, viewRenderingName, pictureDay, picturesDiffer, nameSlug } from '../js/view-renderings.js';

const prop = () => ({
  savedViews: [{ id: 'v-k', name: 'Kitchen' }, { id: 'v-kn', name: 'Kitchen, north wall' }, { id: 'v-1', name: 'View 1' }],
  photos: [],
});
const inFolder = (path, more = {}) => ({ id: 'k:' + path, name: path.split('/').pop(), kind: 'photo', file: { path, group: 'rendering' }, ...more });

test('a rendering Tiksi made, or one in a renders folder, is a rendering; a site photo is not', () => {
  assert.equal(isRendering({ kind: 'photo', source: 'rendering' }), true);
  assert.equal(isRendering(inFolder('Renders/a.png')), true);
  assert.equal(isRendering({ kind: 'photo', file: { path: 'Photos/IMG_1.jpeg', group: 'photo' } }), false);
  assert.equal(isRendering({ kind: 'document', source: 'rendering' }), false);
});

test('a picture tagged with a view shows with it, whatever its name', () => {
  const p = prop();
  const hit = viewOfPicture(p, { kind: 'photo', name: 'IMG_9.jpeg', savedViewId: 'v-k' });
  assert.deepEqual([hit.view.id, hit.by], ['v-k', 'tag']);
});

test('a rendering from elsewhere goes with the view its file is named for', () => {
  const p = prop();
  assert.equal(viewOfPicture(p, inFolder('Renders/Kitchen.png')).view.id, 'v-k');
  assert.equal(viewOfPicture(p, inFolder('Renders/Kitchen - walnut option.jpg')).by, 'name');
  assert.equal(viewOfPicture(p, inFolder('Renders/kitchen_north_wall_v2.png')).view.id, 'v-kn', 'the longest view name that fits wins');
  assert.equal(viewOfPicture(p, inFolder('Renders/Kitchenette.png')), null, 'a name that only starts with the same letters is another word');
  assert.equal(viewOfPicture(p, inFolder('Renders/view-10.png')), null);
  assert.equal(viewOfPicture(p, inFolder('Renders/View 1 dusk.png')).view.id, 'v-1');
  assert.equal(viewOfPicture(p, { kind: 'photo', name: 'Kitchen.jpeg', file: { path: 'Photos/Kitchen.jpeg', group: 'photo' } }), null, 'a site photo is not matched by name');
  assert.equal(viewOfPicture(p, inFolder('Renders/Kitchen.png', { positionId: 'pos-1' })), null, 'a rendering of a numbered position stays with its position');
});

test('taken off every view by hand, a rendering is not matched by its name; a view that is gone falls back to the name', () => {
  const p = prop();
  const r = inFolder('Renders/Kitchen.png');
  tagPicture(r, '');
  assert.equal(viewOfPicture(p, r), null);
  tagPicture(r, 'v-gone');
  assert.equal(viewOfPicture(p, r).by, 'name');
  tagPicture(r, 'v-1');
  assert.equal(viewOfPicture(p, r).view.id, 'v-1');
});

test('every view lists its pictures oldest first, and the rest of the renderings are loose', () => {
  const p = prop();
  const pics = [
    inFolder('Renders/Kitchen 2.png', { createdAt: '2026-11-05T10:00:00Z' }),
    { id: 'ph-1', kind: 'photo', source: 'rendering', savedViewId: 'v-k', renderedAt: '2026-11-03T10:00:00Z' },
    inFolder('Renders/Hall.png', { createdAt: '2026-11-04T10:00:00Z' }),
    { id: 'ph-site', kind: 'photo', name: 'IMG_1.jpeg' },
  ];
  const map = picturesByView(p, pics);
  assert.deepEqual(map.get('v-k').map(x => [x.picture.id, x.by]), [['ph-1', 'tag'], ['k:Renders/Kitchen 2.png', 'name']]);
  assert.deepEqual(map.get('v-kn'), []);
  assert.deepEqual(looseRenderings(p, pics).map(x => x.id), ['k:Renders/Hall.png']);
  assert.equal(pictureDay(pics[1]), '2026-11-03');
});

test('a rendering of a view is named for the view and the minute', () => {
  assert.equal(viewRenderingName({ name: 'Kitchen: north/east' }, new Date('2026-11-16T14:32:10Z')), 'Kitchen north east · rendering 2026-11-16 1432');
  assert.equal(nameSlug('Café, 2nd fl.'), 'cafe-2nd-fl');
});

test('two pictures differ when enough of their pixels do, not for a little noise', () => {
  const blank = n => new Uint8ClampedArray(n * 4).fill(120);
  const a = blank(1000), noisy = blank(1000), changed = blank(1000);
  for (let i = 0; i < noisy.length; i += 4) noisy[i] += (i % 7);          // under the level everywhere
  for (let i = 0; i < 40; i += 4) changed[i] = 255;                         // 10 of 1000 pixels: 1%
  assert.equal(picturesDiffer(a, noisy), false);
  assert.equal(picturesDiffer(a, changed), true);
  assert.equal(picturesDiffer(a, blank(999)), true, 'another size is another picture');
  assert.equal(picturesDiffer(a, null), true);
});
