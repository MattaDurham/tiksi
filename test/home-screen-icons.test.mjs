// A phone's home screen takes PNG icons: the manifest lists them, the page names the Apple
// one, and each file really is a PNG of the size it says.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
async function pngSize(path) {
  const bytes = await readFile(new URL(path, root));
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], path + ' is a PNG');
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

test('the manifest lists PNG icons of 192 and 512 pixels that exist at those sizes', async () => {
  const manifest = JSON.parse(await readFile(new URL('manifest.webmanifest', root), 'utf8'));
  const pngs = manifest.icons.filter(icon => icon.type === 'image/png');
  assert.deepEqual(pngs.map(icon => icon.sizes).sort(), ['192x192', '512x512']);
  for (const icon of pngs) assert.deepEqual(await pngSize(icon.src), icon.sizes.split('x').map(Number), icon.src);
});

test('the page names an Apple touch icon: a 180 pixel PNG with no transparent corners', async () => {
  const page = await readFile(new URL('index.html', root), 'utf8');
  const link = /<link rel="apple-touch-icon" href="([^"]+)">/.exec(page);
  assert.ok(link, 'index.html has an apple-touch-icon link');
  assert.deepEqual(await pngSize(link[1]), [180, 180]);
  // Colour type 2 is RGB without an alpha channel: iOS paints transparent corners black.
  assert.equal((await readFile(new URL(link[1], root)))[25], 2, 'the icon has no transparency');
});
