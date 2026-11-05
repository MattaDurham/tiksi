// Pictures saved as files: the saved records hold references, the open workspace holds the
// identical data: URLs. Synthetic pictures only; the "server" is an in-memory map.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';

globalThis.indexedDB = { open() { throw new Error('no IndexedDB under Node'); } };
const { pictureFiles, parseDataUrl, isPictureRef, MIN_PICTURE_CHARS } = await import('../js/picture-assets.js');
const { mergeShared, sameJson } = await import('../js/workspace-merge.js');
const store = await import('../js/store.js');

const dataUrl = (mime, bytes) => 'data:' + mime + ';base64,' + Buffer.from(bytes).toString('base64');
function server() {
  const blobs = new Map(), log = { uploads: 0, downloads: 0 };
  return {
    blobs, log,
    upload: async bytes => { log.uploads++; const hash = createHash('sha256').update(bytes).digest('hex'); blobs.set(hash, Buffer.from(bytes)); return { hash, size: bytes.byteLength }; },
    download: async hash => { log.downloads++; if (!blobs.has(hash)) throw new Error('missing'); return new Uint8Array(blobs.get(hash)); },
  };
}
function workspace() {
  const d = store.emptyWorkspace(), p = store.propertyTemplate('Synthetic house');
  p.id = 'prop-synthetic';
  p.photos.push({ id: 'ph-1', name: 'One', thumb: dataUrl('image/jpeg', randomBytes(30000)) },
    { id: 'ph-2', name: 'Two', thumb: dataUrl('image/jpeg', randomBytes(26001)) },
    { id: 'ph-3', name: 'Copy of one', thumb: '' });
  p.photos[2].thumb = p.photos[0].thumb;   // the same picture twice is stored once
  p.videos.push({ id: 'vid-1', name: 'Walk', thumb: dataUrl('image/jpeg', randomBytes(9000)) });
  p.levels[0].plan = { img: dataUrl('image/png', randomBytes(400000)), imgW: 600, imgH: 600, mPerPx: 0.02, offsetX: 0, offsetY: 0 };
  d.properties.push(p);
  d.products.push({ id: 'prod-1', name: 'Sink', imageUrl: dataUrl('image/webp', randomBytes(5000)) },
    { id: 'prod-2', name: 'Tap', imageUrl: 'https://example.com/tap.jpg' },
    { id: 'prod-3', name: 'Tiny', imageUrl: dataUrl('image/png', randomBytes(30)) });
  return d;
}
const inlinePictures = value => JSON.stringify(value).match(/"data:[^"]{1024,}"/g) || [];

test('saving keeps only references, and opening restores every picture as the identical text', async () => {
  const original = workspace(), disk = server();
  const files = pictureFiles(disk);
  const saved = await files.slimStored(() => original);
  assert.deepEqual(inlinePictures(saved.data), [], 'no large inline picture is left in the saved records');
  assert.ok(isPictureRef(saved.data.properties[0].levels[0].plan.img));
  assert.ok(isPictureRef(saved.data.products[0].imageUrl));
  assert.equal(saved.data.products[1].imageUrl, 'https://example.com/tap.jpg', 'links are not pictures');
  assert.equal(saved.data.products[2].imageUrl, original.products[2].imageUrl, 'a tiny inline image stays inline');
  assert.equal(disk.log.uploads, 5, 'five distinct pictures, the duplicate stored once');
  assert.ok(JSON.stringify(saved.data).length < JSON.stringify(original).length / 20);
  // The stored bytes are the picture's own bytes.
  const plan = original.properties[0].levels[0].plan.img;
  const planHash = saved.data.properties[0].levels[0].plan.img.slice(-64);
  assert.deepEqual(disk.blobs.get(planHash), Buffer.from(plan.split(',')[1], 'base64'));
  // Another device opens the saved records: every picture comes back as exactly the same text.
  const phone = pictureFiles(disk);
  assert.deepEqual(await phone.fetchMissing(saved.data, {}), []);
  const opened = phone.inflate(saved.data);
  assert.equal(JSON.stringify(opened), JSON.stringify(original), 'open form is identical to the original records');
  assert.equal(disk.log.downloads, 5);
  // A later save of the unchanged workspace uploads nothing.
  const again = await files.slimStored(() => original);
  assert.equal(disk.log.uploads, 5);
  assert.ok(sameJson(again.data, saved.data));
  assert.deepEqual(Object.keys(files.assetsFor(again.ids)).sort(), [...again.ids].sort());
});

test('a picture that would not come back as the same text stays inline', async () => {
  const canonical = dataUrl('image/png', randomBytes(2000));
  assert.ok(parseDataUrl(canonical));
  const odd = canonical.slice(0, -2) + (canonical.endsWith('==') ? 'B=' : 'B');   // non-zero padding bits
  const upper = canonical.replace('image/png', 'image/PNG');
  const d = { properties: [{ id: 'p', photos: [{ id: 'a', thumb: odd }, { id: 'b', thumb: upper }] }] };
  const disk = server(), files = pictureFiles(disk);
  const saved = await files.slimStored(() => d);
  assert.equal(disk.log.uploads, 0);
  assert.equal(saved.data.properties[0].photos[0].thumb, odd);
  assert.equal(saved.data.properties[0].photos[1].thumb, upper);
  assert.ok(MIN_PICTURE_CHARS <= canonical.length);
});

test('a reference whose file is missing is kept, never erased', async () => {
  const d = workspace(), disk = server();
  const saved = (await pictureFiles(disk).slimStored(() => d)).data;
  const lost = saved.properties[0].photos[1].thumb.slice(-64);
  disk.blobs.delete(lost);
  const phone = pictureFiles(disk);
  const failed = await phone.fetchMissing(saved, {});
  assert.equal(failed.length, 1);
  const opened = phone.inflate(saved);
  assert.ok(isPictureRef(opened.properties[0].photos[1].thumb));
  // The workspace normalisation keeps it, and the next save sends it back unchanged.
  store.replaceWorkspace(opened);
  assert.equal(store.ws.data.properties[0].photos[1].thumb, saved.properties[0].photos[1].thumb);
  const resaved = phone.slim(store.ws.data);
  assert.equal(resaved.data.properties[0].photos[1].thumb, saved.properties[0].photos[1].thumb);
  assert.equal(resaved.unknown.size, 0);
});

test('merging compares as JSON without serializing', () => {
  assert.ok(sameJson({ a: 1, b: [1, { c: null }] }, { b: [1, { c: null }], a: 1 }), 'key order does not matter');
  assert.ok(sameJson({ a: undefined, b: 2 }, { b: 2 }), 'undefined fields are absent');
  assert.ok(sameJson([undefined, NaN], [null, null]));
  assert.ok(!sameJson({ a: 1 }, { a: 1, b: 2 }));
  assert.ok(!sameJson([1, 2], { 0: 1, 1: 2 }));
  assert.ok(!sameJson({ a: '1' }, { a: 1 }));
  const base = { p: [{ id: 'x', notes: 'a', thumb: 'tiksi-picture:image/png:pic-' + 'a'.repeat(64) }] };
  const local = { p: [{ id: 'x', notes: 'b', thumb: base.p[0].thumb }] };
  const remote = { p: [{ id: 'x', notes: 'a', thumb: 'tiksi-picture:image/png:pic-' + 'b'.repeat(64) }] };
  const merged = mergeShared(base, local, remote);
  assert.deepEqual(merged.conflicts, []);
  assert.deepEqual(merged.value, { p: [{ id: 'x', notes: 'b', thumb: remote.p[0].thumb }] }, 'a replaced picture merges like any other field');
});
