// A property from a folder: sorting a folder's files by kind, finding a Polycam link in a note,
// and pairing a model with the files it names. Synthetic file lists only; no browser.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const fi = await import('../js/folder-intake.js');
const MB = 1024 * 1024;
const paths = (items, kind) => items.filter(i => i.kind === kind).map(i => i.path);

test('a site-visit folder sorts into scans, photos, PDFs, videos, audio and files that stay', () => {
  const items = fi.classifyFolder([
    { path: 'kitchen.glb', size: 40 * MB }, { path: 'IMG_1.JPEG', size: 5 * MB }, { path: 'Side project/IMG_2.heic', size: 3 * MB },
    { path: 'walk.MOV', size: 180 * MB }, { path: 'notes.m4a', size: 2 * MB }, { path: 'survey.pdf', size: MB },
    { path: 'quote.xlsx', size: 9000 }, { path: 'Polycam link.rtf', size: 426 }, { path: 'Earlier.tiksi', size: MB }, { path: 'empty.jpg', size: 0 },
  ]);
  assert.deepEqual(paths(items, 'model'), ['kitchen.glb']);
  assert.deepEqual(paths(items, 'photo'), ['IMG_1.JPEG', 'Side project/IMG_2.heic']);
  assert.deepEqual(paths(items, 'video'), ['walk.MOV']);
  assert.deepEqual(paths(items, 'audio'), ['notes.m4a']);
  assert.deepEqual(paths(items, 'document'), ['survey.pdf']);
  assert.deepEqual(paths(items, 'project'), ['Earlier.tiksi']);
  // A note is an "other" file until it has been looked into; an empty file says why it stays.
  assert.deepEqual(paths(items, 'other'), ['empty.jpg', 'Polycam link.rtf', 'quote.xlsx']);
  assert.equal(items.find(i => i.path === 'empty.jpg').note, 'The file is empty.');
  assert.equal(items.find(i => i.path === 'Side project/IMG_2.heic').group, 'Side project');
  assert.equal(items.find(i => i.path === 'IMG_1.JPEG').group, '');
  assert.equal(items.length, 10, 'every file is accounted for');
});

test('a file over the project limit is flagged, not dropped', () => {
  const items = fi.classifyFolder([{ path: 'long walk.mov', size: 700 * MB }, { path: 'big.e57', size: fi.MAX_FILE_BYTES + 1 }, { path: 'ok.mp4', size: fi.MAX_FILE_BYTES }]);
  assert.deepEqual(items.map(i => [i.path, !!i.tooLarge]), [['big.e57', true], ['long walk.mov', true], ['ok.mp4', false]]);
});

test('a Polycam raw export is one item and its keyframes never become site photos', () => {
  const files = [{ path: 'IMG_9.jpg', size: MB }, { path: 'raw/mesh_info.json', size: 100 }];
  for (let i = 0; i < 40; i++) for (const [dir, ext] of [['cameras', 'json'], ['images', 'jpg'], ['depth', 'png'], ['corrected_cameras', 'json']])
    files.push({ path: `raw/keyframes/${dir}/${1000 + i}.${ext}`, size: 2000 });
  // A folder merely named images, with no cameras beside it, is ordinary photos.
  files.push({ path: 'images/detail.jpg', size: MB });
  const items = fi.classifyFolder(files);
  const cameras = items.filter(i => i.kind === 'cameras');
  assert.equal(cameras.length, 1);
  assert.deepEqual([cameras[0].path, cameras[0].count, cameras[0].size, cameras[0].group], ['raw/keyframes', 40, 160 * 2000, 'raw']);
  assert.deepEqual(paths(items, 'photo'), ['images/detail.jpg', 'IMG_9.jpg']);
  assert.deepEqual(paths(items, 'other'), ['raw/mesh_info.json']);
});

test('a note holding a Polycam link becomes the scan to fetch; the same capture twice is one scan', async () => {
  const rtf = '{\\rtf1\\ansi\\ansicpg1252\\cocoartf2870\n{\\fonttbl\\f0\\fswiss\\fcharset0 Helvetica;}\n\\f0\\fs24 \\cf0 https://poly.cam/capture/AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE\\\n}';
  const text = {
    'Polycam link.rtf': rtf,
    'again.txt': 'see https://poly.cam/capture/AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE for the scan',
    'link.webloc': '<?xml version="1.0"?><plist><dict><key>URL</key><string>https://poly.cam/capture/11111111-2222-3333-4444-555555555555</string></dict></plist>',
    'page.html': '<a href="https://poly.cam/capture/99999999-2222-3333-4444-555555555555">scan</a>',
    'shopping.txt': 'two sheets of plywood, https://example.com/capture/123',
  };
  const read = [];
  const items = await fi.inspectFolder(fi.classifyFolder([...Object.keys(text).map(path => ({ path, size: text[path].length })), { path: 'huge.txt', size: 5 * MB }]),
    async path => { read.push(path); return text[path]; });
  const links = items.filter(i => i.kind === 'link');
  assert.deepEqual(links.map(i => [i.path, i.link.captureId]), [
    ['again.txt', 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE'], ['link.webloc', '11111111-2222-3333-4444-555555555555'], ['page.html', '99999999-2222-3333-4444-555555555555']]);
  assert.equal(links[0].link.url, 'https://poly.cam/capture/AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE');
  const twice = items.find(i => i.path === 'Polycam link.rtf');
  assert.deepEqual([twice.kind, twice.note], ['other', 'The same Polycam link as another file in the folder.']);
  assert.equal(items.find(i => i.path === 'shopping.txt').kind, 'other');
  assert.ok(!read.includes('huge.txt'), 'a large text file is never read to look for a link');
});

test('the owner\'s own note format is read: one link in a TextEdit RTF', async () => {
  const rtf = '{\\rtf1\\ansi\\ansicpg1252\\cocoartf2870\n\\cocoatextscaling0\\cocoaplatform0{\\fonttbl\\f0\\fswiss\\fcharset0 Helvetica;}\n{\\colortbl;\\red255\\green255\\blue255;}\n{\\*\\expandedcolortbl;;}\n\\margl1440\\margr1440\\vieww11520\\viewh8400\\viewkind0\n\\pard\\tx720\\pardirnatural\\partightenfactor0\n\n\\f0\\fs24 \\cf0 https://poly.cam/capture/AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE\\\n}';
  const [item] = await fi.inspectFolder(fi.classifyFolder([{ path: 'Polycam link.rtf', size: rtf.length }]), async () => rtf);
  assert.equal(item.kind, 'link');
  assert.equal(item.link.url, 'https://poly.cam/capture/AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE');
});

test('a glTF or OBJ takes the files it names; photos beside it stay photos', async () => {
  const text = {
    'scan/room.gltf': JSON.stringify({ buffers: [{ uri: 'room.bin' }, { uri: 'data:application/octet-stream;base64,AAAA' }], images: [{ uri: 'tex/wall%20a.jpg' }, { uri: 'gone.png' }] }),
    'obj/chair.mtl': 'newmtl seat\nKd 1 1 1\nmap_Kd -s 1 1 1 seat.jpg\nmap_Bump -bm 0.4 Bump.PNG\n',
  };
  const items = await fi.inspectFolder(fi.classifyFolder([
    { path: 'scan/room.gltf', size: 4000 }, { path: 'scan/room.bin', size: MB }, { path: 'scan/tex/wall a.jpg', size: MB }, { path: 'scan/IMG_site.jpg', size: MB },
    { path: 'obj/chair.obj', size: MB }, { path: 'obj/chair.mtl', size: 200 }, { path: 'obj/seat.jpg', size: MB }, { path: 'obj/bump.png', size: MB }, { path: 'obj/IMG_site2.jpg', size: MB },
    { path: 'solo.glb', size: MB },
  ]), async path => text[path]);
  const gltf = items.find(i => i.path === 'scan/room.gltf'), obj = items.find(i => i.path === 'obj/chair.obj');
  assert.deepEqual(gltf.companions, ['scan/room.bin', 'scan/tex/wall a.jpg']);
  assert.deepEqual(gltf.missing, ['gone.png']);
  assert.deepEqual(obj.companions, ['obj/chair.mtl', 'obj/seat.jpg', 'obj/bump.png'], 'file names match whatever their letter case');
  assert.equal(obj.missing, undefined);
  assert.equal(items.find(i => i.path === 'solo.glb').companions, undefined);
  assert.deepEqual(paths(items, 'photo'), ['obj/IMG_site2.jpg', 'scan/IMG_site.jpg']);
  assert.deepEqual(paths(items, 'other'), []);
  assert.deepEqual(paths(items, 'model'), ['obj/chair.obj', 'scan/room.gltf', 'solo.glb']);
});

test('the review totals count files and bytes per kind, imported kinds apart from the rest', () => {
  const groups = fi.summarize(fi.classifyFolder([{ path: 'a.jpg', size: 10 }, { path: 'b.jpg', size: 5 }, { path: 'c.mov', size: 100 }, { path: 'd.m4a', size: 7 }, { path: 'e.docx', size: 1 }]));
  assert.deepEqual(groups.map(g => [g.kind, g.label, g.count, g.bytes, g.imported]), [
    ['photo', 'Photos', 2, 15, true], ['video', 'Video', 1, 100, true], ['audio', 'Audio recording', 1, 7, false], ['other', 'Other file', 1, 1, false]]);
});

test('the browser picker\'s files lose the folder\'s own name, hidden files and the Tiksi folder', async () => {
  const file = (rel, body = 'x') => Object.assign(new File([body], rel.split('/').pop()), { webkitRelativePath: rel });
  const folder = fi.folderFromFiles([file('Smith kitchen (2)/IMG_1.jpg', 'photo'), file('Smith kitchen (2)/sub/walk.mov'), file('Smith kitchen (2)/.DS_Store'),
    file('Smith kitchen (2)/sub/.cache/x.bin'), file('Smith kitchen (2)/Tiksi/Old.tiksi')]);
  assert.equal(folder.name, 'Smith kitchen (2)');
  assert.equal(fi.suggestName(folder.name), 'Smith kitchen');
  assert.deepEqual(folder.files.map(f => f.path), ['IMG_1.jpg', 'sub/walk.mov']);
  assert.deepEqual(folder.skipped, { hidden: 2, tiksi: 1 });
  const read = await folder.read('IMG_1.jpg');
  assert.equal(await read.text(), 'photo');
  assert.equal(read.type, 'image/jpeg', 'a file the picker gave no type gets one from its name');
  await assert.rejects(folder.read('Tiksi/Old.tiksi'));
  assert.equal(fi.suggestName(''), 'New property');
});
