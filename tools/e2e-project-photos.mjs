// PHOTOS reads the project folder: every picture in it and its subfolders shows, where it is,
// in groups that can be hidden (photos, scan frames of a Polycam export, renderings); a photo
// Tiksi held is moved into the folder's Photos folder and Tiksi lets go of its copy; a photo
// added in Tiksi is written into Photos; SELECTED marks pictures and survives a reload; a
// picture added to or renamed in the folder is picked up. A made-up project in a temporary
// state folder; live 8642 is never used.
// Run: node tools/e2e-project-photos.mjs (Playwright + Chromium installed).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import net from 'node:net';
import { crc32, deflateSync } from 'node:zlib';
import { chromium } from 'playwright';

const check = (ok, label) => { assert.ok(ok, label); console.log('  ok   ' + label); };
// A small PNG of one colour: every picture here has its own bytes.
function png(r, g, b, w = 8, h = 6) {
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0); out.write(type, 4, 'ascii'); data.copy(out, 8);
    out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(w, 0); header.writeUInt32BE(h, 4); header[8] = 8; header[9] = 2;
  const rows = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rows.set([r, g, b], y * (1 + w * 3) + 1 + x * 3);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

const state = await mkdtemp(tmpdir() + '/tiksi-project-photos-test-');
const socket = net.createServer();
await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
const port = socket.address().port;
await new Promise(resolve => socket.close(resolve));
const child = spawn('python3', ['tools/serve.py', '--port', String(port), '--state-dir', state, '--projects-dir', state + '/projects'], { stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = ''; child.stdout.resume(); child.stderr.on('data', d => { serverLog = (serverLog + d).slice(-8000); });
const url = 'http://127.0.0.1:' + port;
let browser;
try {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url)).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector('#save-status')?.textContent === 'SAVED TO DISK', null, { timeout: 120000 });

  // A property saved to its project file, holding one photo the old way (its original in Tiksi).
  const held = png(200, 40, 40);
  await page.evaluate(async bytes => {
    const s = await import('/js/store.js');
    const p = s.propertyTemplate('Synthetic cottage'); p.id = 'prop-cottage';
    const buffer = new Uint8Array(bytes).buffer;
    await s.putFile('ph-held', buffer, { kind: 'photo', mime: 'image/png', name: 'Porch.png', original: true });
    p.photos.push({ id: 'ph-held', name: 'Porch.png', kind: 'photo', w: 8, h: 6, mime: 'image/png', thumb: '', original: true, byteLength: buffer.byteLength,
      createdAt: new Date().toISOString(), notes: 'Held note', roomId: '', elementIds: [], itemIds: [], pin: null });
    s.ws.data.properties.push(p); s.ws.data.settings.activePropertyId = p.id; s.touch();
    await (await import('/js/disk-workspace.js')).diskWorkspace.sync();
  }, [...held]);
  const auth = { 'X-Tiksi-Workspace': '1' };
  auth['X-Tiksi-Token'] = (await (await fetch(url + '/api/workspace/capabilities', { headers: auth })).json()).token;
  const snapshot = async () => (await fetch(url + '/api/workspace', { headers: auth })).json();
  const before = await snapshot();
  check(before.assets['ph-held'], 'the photo starts out held in Tiksi');
  const projectFile = before.paths['prop-cottage'];
  const folder = dirname(projectFile).endsWith('/Tiksi') ? dirname(dirname(projectFile)) : dirname(projectFile);

  // The project folder's own pictures, in subfolders.
  const put = async (relative, bytes) => { await mkdir(dirname(folder + '/' + relative), { recursive: true }); await writeFile(folder + '/' + relative, bytes); };
  await put('Site visit/Kitchen/wall.png', png(10, 160, 10));
  await put('Source media/keyframes/cameras/1.json', '{}');
  await put('Source media/keyframes/images/frame-1.png', png(10, 10, 180));
  await put('Source media/keyframes/images/frame-2.png', png(10, 120, 180));
  await put('Source media/keyframes/depth/frame-1.png', png(1, 1, 1));
  await put('build/finishes-v1/kitchen.png', png(220, 220, 30));
  await put('.hidden/secret.png', png(9, 9, 9));

  await page.evaluate(() => { location.hash = '#/photos'; });
  const cards = page.locator('.ph-card');
  await page.waitForFunction(() => document.querySelectorAll('.ph-card').length === 5 && !/MOVING/.test(document.querySelector('.ph-head .view-sub')?.textContent || ''), null, { timeout: 60000 });
  check(await cards.count() === 5, 'every picture in the folder and its subfolders shows: the moved photo, a site photo, two scan frames and a rendering');
  const moved = await readFile(folder + '/Photos/Porch.png');
  check(moved.equals(held), 'the held photo was written into the Photos folder with its own bytes');
  const record = await page.evaluate(async () => {
    const s = await import('/js/store.js');
    const rec = s.ws.data.properties.find(p => p.id === 'prop-cottage').photos.find(p => p.id === 'ph-held');
    return { file: rec.file, notes: rec.notes, original: rec.original, stored: !!(await s.getFile('ph-held')) };
  });
  check(record.file.path === 'Photos/Porch.png' && record.notes === 'Held note', 'its record names the file in the folder and keeps its notes');
  await page.waitForFunction(() => document.querySelector('#save-status')?.textContent === 'SAVED TO DISK');
  await page.evaluate(async () => (await import('/js/disk-workspace.js')).diskWorkspace.sync());
  check(!(await snapshot()).assets['ph-held'], 'the project file no longer holds the photo');
  // A read that finished during the move can leave the old shared bytes in memory.
  // Reproduce that cache state after acknowledgment: it must not resurrect the old asset.
  await page.evaluate(async ({hash, bytes}) => {
    const store = await import('/js/store.js');
    await store.cacheFile('ph-held', new Uint8Array(bytes).buffer, {sharedHash:hash, kind:'photo'});
  }, {hash:before.assets['ph-held'].hash, bytes:[...held]});
  const stored = await page.evaluate(async () => !!(await (await import('/js/store.js')).getFile('ph-held')));
  check(!record.original && !stored, 'Tiksi let go of its own copy (original flag ' + record.original + ', cached file ' + stored + ')');

  const groups = await page.locator('[data-group]').evaluateAll(buttons => Object.fromEntries(buttons.map(b => [b.dataset.group, b.querySelector('.mono').textContent])));
  check(groups.photo === '2' && groups.scan === '2' && groups.rendering === '1', 'the group buttons count photos, scan frames and renderings');
  await page.waitForFunction(() => [...document.querySelectorAll('.ph-thumb img')].every(img => img.src.startsWith('blob:') || img.src.startsWith('data:')), null, { timeout: 30000 });
  check(true, 'every card shows a preview made on the Mac');

  // Scan frames can be hidden, and stay hidden after a reload on this device.
  await page.locator('[data-group=scan]').click();
  check(await cards.count() === 3, 'hiding scan frames hides both frames');
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('.ph-card').length === 3, null, { timeout: 60000 });
  check(await page.locator('[data-group=scan]').getAttribute('aria-pressed') === 'false', 'scan frames stay hidden after a reload');
  await page.locator('[data-group=scan]').click();
  await page.waitForFunction(() => document.querySelectorAll('.ph-card').length === 5);

  // Select a scan frame from its card and another with S in the viewer.
  const frame = page.locator('.ph-card', { hasText: 'frame-1.png' });
  await page.waitForFunction(() => {
    const img = [...document.querySelectorAll('.ph-card')].find(c => c.textContent.includes('frame-1.png'))?.querySelector('.ph-thumb img');
    return img?.complete && img.naturalWidth > 0;
  });
  const frameImage = await frame.locator('.ph-thumb img').elementHandle();
  await frame.locator('.ph-pick').click();
  await page.waitForFunction(() => [...document.querySelectorAll('.ph-card')].find(c => c.textContent.includes('frame-1.png'))?.textContent.includes('SELECTED'));
  check(await frame.locator('.ph-thumb img').evaluate((img, original) => img === original && img.complete && img.naturalWidth > 0, frameImage), 'a selected card keeps the same loaded picture');
  // Cards overlap in the desktop deck: point at the exposed strip before opening it.
  const secondFrame = page.locator('.ph-card', { hasText: 'frame-2.png' });
  await secondFrame.scrollIntoViewIfNeeded();
  const strip = await secondFrame.boundingBox(), secondId = await secondFrame.getAttribute('data-id');
  await page.mouse.move(strip.x + 30, strip.y + 20);
  await page.waitForFunction(id => document.querySelector('.ph-card.lift')?.dataset.id === id, secondId);
  await page.mouse.dblclick(strip.x + 30, strip.y + 20);
  await page.locator('.ph-lightbox').waitFor();
  await page.keyboard.press('s');
  await page.waitForFunction(() => /SELECTED/.test(document.querySelector('.ph-lb-cap')?.textContent || ''));
  await page.keyboard.press('Escape');
  const picked = await page.evaluate(async () => (await import('/js/store.js')).ws.data.properties.find(p => p.id === 'prop-cottage').photos
    .filter(p => p.selected).map(p => ({ path: p.file.path, group: p.file.group })).sort((a, b) => a.path.localeCompare(b.path)));
  check(picked.length === 2 && picked.every(p => p.group === 'scan') && picked[0].path === 'Source media/keyframes/images/frame-1.png', 'both frames are recorded as selected scan frames');
  await page.selectOption('[data-filter=pin]', 'selected');
  check(await cards.count() === 2, 'the SELECTED filter shows just the two');
  await page.evaluate(async () => (await import('/js/disk-workspace.js')).diskWorkspace.sync());
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('.ph-card').length === 5, null, { timeout: 60000 });
  await page.selectOption('[data-filter=pin]', 'selected');
  check(await cards.count() === 2, 'they are still selected after a reload');
  await page.locator('.ph-card', { hasText: 'frame-2.png' }).locator('.ph-pick').click();
  const left = await page.evaluate(async () => (await import('/js/store.js')).ws.data.properties.find(p => p.id === 'prop-cottage').photos.map(p => p.file.path).sort());
  check(left.length === 2 && !left.includes('Source media/keyframes/images/frame-2.png'), 'unselecting a frame that was only selected lets go of its record');
  await page.selectOption('[data-filter=pin]', '');

  // A photo added in Tiksi is written into the Photos folder; Tiksi keeps no copy.
  const added = png(250, 120, 0);
  await page.locator('[data-file=upload]').setInputFiles({ name: 'Added.png', mimeType: 'image/png', buffer: added });
  await page.waitForFunction(() => [...document.querySelectorAll('.ph-card')].some(c => c.textContent.includes('Added.png')), null, { timeout: 30000 });
  check((await readFile(folder + '/Photos/Added.png')).equals(added), 'an uploaded photo is saved into the Photos folder');
  const addedRecord = await page.evaluate(async () => {
    const s = await import('/js/store.js');
    const rec = s.ws.data.properties.find(p => p.id === 'prop-cottage').photos.find(p => p.name === 'Added.png');
    return { path: rec.file && rec.file.path, stored: !!(await s.getFile(rec.id)), thumb: rec.thumb.startsWith('data:image/') };
  });
  check(addedRecord.path === 'Photos/Added.png' && !addedRecord.stored && addedRecord.thumb, 'its record names the file and keeps only a thumbnail');
  // The same photo dropped again is not written twice.
  await page.locator('[data-file=upload]').setInputFiles({ name: 'Added again.png', mimeType: 'image/png', buffer: added });
  await page.waitForTimeout(1500);
  check(!(await readdir(folder + '/Photos')).includes('Added again.png'), 'the same bytes again are not written a second time');

  // A picture put in the folder, and a selected one renamed there, are picked up.
  await put('Site visit/new.png', png(90, 90, 200));
  await rename(folder + '/Source media/keyframes/images/frame-1.png', folder + '/Source media/keyframes/images/frame-1 renamed.png');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForFunction(() => [...document.querySelectorAll('.ph-card')].some(c => c.textContent.includes('new.png')), null, { timeout: 30000 });
  check(true, 'a picture put in the folder shows when Tiksi comes back to the front');
  const renamed = await page.evaluate(async () => (await import('/js/store.js')).ws.data.properties.find(p => p.id === 'prop-cottage').photos.find(p => p.selected).file.path);
  check(renamed === 'Source media/keyframes/images/frame-1 renamed.png', 'a selected picture renamed in the folder keeps its selection');
  check(!(await page.locator('.ph-card', { hasText: 'secret.png' }).count()), 'hidden folders are not listed');

  check(errors.length === 0, 'no page errors: ' + errors.join('; '));
  console.log('Project folder photos passed.');
} catch (error) {
  console.error(serverLog);
  throw error;
} finally {
  if (browser) await browser.close();
  child.kill();
  await rm(state, { recursive: true, force: true });
}
