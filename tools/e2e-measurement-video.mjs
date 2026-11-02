// MEASURE: walk-through videos, tape candidates, readings applied through UNDO, the ask-the-owner
// list and .tiksi bundling. Synthetic videos in temporary state; never the live port.
// With ffmpeg the local frame service is exercised; a second server without ffmpeg on its PATH
// (TIKSI_FFMPEG='') checks the honest fallback to the browser's own player.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { chromium } from 'playwright';

const has = cmd => { try { execFileSync(cmd, ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } };
const ffmpeg = has('ffmpeg') && has('ffprobe');
const python = execFileSync('python3', ['-c', 'import sys; print(sys.executable)']).toString().trim();
const state = await mkdtemp(tmpdir() + '/tiksi-measure-test-');
async function freePort(preferred) {
  if (preferred) return Number(preferred);
  const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r));
  const port = s.address().port; await new Promise(r => s.close(r)); return port;
}
function serve(port, dir, env) {
  return spawn(python, ['tools/serve.py', '--port', String(port), '--state-dir', dir], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
}
async function ready(url) { for (let i = 0; i < 200; i++) { try { if ((await fetch(url)).ok) return; } catch {} await new Promise(r => setTimeout(r, 50)); } throw new Error('server did not start'); }

async function kitchen(page) {
  await page.waitForFunction(() => document.querySelector('#save-status').textContent === 'SAVED TO DISK');
  await page.evaluate(async () => {
    const s = await import('/js/store.js');
    const p = s.propertyTemplate('Synthetic kitchen'), L = p.levels[0].id;
    const wall = (id, ax, ay, bx, by) => ({ id, level: L, ax, ay, bx, by, thickness: 0.114, height: null, material: null });
    p.walls.push(wall('w-s', 0, 0, 4, 0), wall('w-e', 4, 0, 4, 3), wall('w-n', 4, 3, 0, 3), wall('w-w', 0, 3, 0, 0));
    p.rooms.push({ id: 'r-k', level: L, name: 'Kitchen', pts: [[0, 0], [4, 0], [4, 3], [0, 3]], material: null, ceilingMaterial: null });
    p.openings.push({ id: 'o-door', wallId: 'w-n', type: 'door', t: 0.5, width: 0.8, height: 2.03 });
    s.ws.data.properties.push(p); s.ws.data.settings.activePropertyId = p.id; s.touch();
    await (await import('/js/disk-workspace.js')).diskWorkspace.sync();
  });
  await page.evaluate(() => { location.hash = '#/measure'; });
  await page.waitForSelector('.ms-layout');
}
// Disk saves remount the view; interactions that need a stable DOM wait for the save to land.
const settle = page => page.waitForFunction(() => document.querySelector('#save-status').textContent === 'SAVED TO DISK', null, { timeout: 20000 });
const prop = page => page.evaluate(async () => JSON.parse(JSON.stringify((await import('/js/store.js')).activeProperty())));
async function record(page, { value, text = '', attach = null, confidence = 'clear' }) {
  await page.fill('[data-f=input]', value); await page.fill('[data-f=text]', text);
  await page.check(`[data-f=confidence][value=${confidence}]`, { force: true });
  if (attach) await page.selectOption('[data-f=attach]', await page.locator('[data-f=attach] option', { hasText: attach }).first().getAttribute('value'));
  const before = (await prop(page)).measurements.length;
  await page.click('[data-act=save]');
  await page.waitForFunction(async n => (await import('/js/store.js')).activeProperty().measurements.length > n, before);
  await settle(page);
}

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const children = [];
try {
  if (ffmpeg) {
    // 12 s at 640x360: an elongated wood-coloured strip at 1-2 s (not tape), the yellow blade at 4-7 s.
    const video = state + '/walkthrough.mp4', ticks = Array.from({ length: 12 }, (_, i) => `drawbox=x=${110 + i * 36}:y=181:w=2:h=9:color=black:t=fill:enable='between(t,4,7)'`).join(',');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x6b5a48:s=640x360:r=15:d=12', '-vf',
      `drawbox=x=80:y=60:w=480:h=260:color=0xd9d4cc:t=fill,drawbox=x=100:y=120:w=400:h=12:color=0xD08030:t=fill:enable='between(t,1,2.5)',drawbox=x=100:y=180:w=440:h=24:color=0xF2C811:t=fill:enable='between(t,4,7)',${ticks}`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video]);
    const port = await freePort(process.env.E2E_APP_PORT), url = 'http://127.0.0.1:' + port;
    children.push(serve(port, state + '/with-ffmpeg')); await ready(url);
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [], dialogs = []; page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });
    await page.goto(url); await kitchen(page);
    await page.waitForFunction(() => /Frame service ready/.test(document.querySelector('[data-service]').textContent));

    // Honest refusals: not a video container, and an unsupported format.
    await page.setInputFiles('.ms-actions [data-file]', [{ name: 'broken.mp4', mimeType: 'video/mp4', buffer: Buffer.from('this is not a video at all') }, { name: 'clip.avi', mimeType: 'video/x-msvideo', buffer: Buffer.from('RIFF0000AVI LIST') }]);
    await page.waitForFunction(() => document.querySelector('[data-head-sub]').textContent.startsWith('0 videos'));
    assert.equal(dialogs.length, 1); assert.match(dialogs[0], /broken\.mp4: not an MP4\/MOV video/); assert.match(dialogs[0], /clip\.avi: only MP4 and MOV videos are supported/);

    const bytes = await readFile(video);
    await page.setInputFiles('.ms-actions [data-file]', video);
    await page.waitForFunction(() => document.querySelectorAll('.ms-tile').length === 12, null, { timeout: 60000 });
    const candidates = await page.locator('.ms-tile.cand').evaluateAll(tiles => tiles.map(t => +t.dataset.t));
    assert.deepEqual(candidates, [4, 5, 6, 7].filter(t => candidates.includes(t)), 'only blade seconds are candidates: ' + candidates);
    assert.ok(candidates.length >= 3 && !candidates.includes(1) && !candidates.includes(2), 'the wood strip is not tape');
    await page.locator('.ms-stage').focus();
    await page.keyboard.press('Shift+ArrowRight');
    await page.waitForFunction(() => /Sharpest of \d+ frames/.test(document.querySelector('[data-status]').textContent));
    assert.match(await page.textContent('.ms-frame-info'), /tape candidate: yellow strip/);
    assert.ok(Number((await page.textContent('[data-time]')).slice(2, 6)) >= 3.5, 'the burst stays near the candidate');

    // Shift+drag a crop, record a door width and apply it through geometry history.
    await settle(page);
    const box = await page.locator('.ms-canvas').boundingBox();
    await page.keyboard.down('Shift'); await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.45); await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.6, { steps: 4 }); await page.mouse.up(); await page.keyboard.up('Shift');
    await page.fill('[data-f=input]', '33 1/2');
    assert.equal(await page.textContent('[data-echo]'), '= 33 1/2" (bare numbers are inches)');
    await record(page, { value: '33 1/2', text: 'pantry door leaf width', attach: 'Door 1 (Kitchen)' });
    let p = await prop(page);
    const reading = p.measurements[0];
    assert.equal(reading.status, 'assigned'); assert.ok(Math.abs(reading.value - 0.8509) < 1e-4); assert.ok(reading.crop && reading.crop[2] > 0.15);
    const frame = await page.evaluate(async id => { const r = await (await import('/js/store.js')).getFile(id); const b = new Uint8Array(r.buffer); return { head: [b[0], b[1]], kind: r.kind, size: b.length }; }, reading.frameAssetId);
    assert.deepEqual(frame.head, [0xff, 0xd8]); assert.equal(frame.kind, 'frame');
    await page.click('[data-apply]');
    await page.waitForFunction(() => /^Applied/.test(document.querySelector('[data-status]').textContent));
    assert.ok(Math.abs((await prop(page)).openings[0].width - 0.8509) < 1e-4);
    await page.click('#btn-undo');
    await page.waitForFunction(async () => (await import('/js/store.js')).activeProperty().openings[0].width === 0.8);
    await page.locator('.ms-reading .chip', { hasText: 'NOT IN MODEL' }).waitFor();

    // An unexplained reading and an unreadable one go to ASK THE OWNER with their frames.
    await page.locator('.ms-stage').focus(); await page.keyboard.press('ArrowRight'); await page.waitForTimeout(400);
    await record(page, { value: '24' });
    await record(page, { value: '', text: 'range width', confidence: 'unreadable', attach: 'Note only' });
    await page.waitForFunction(() => document.querySelectorAll('.ms-ask-row').length === 2 && document.querySelectorAll('.ms-ask-frame img').length === 2);
    const ask = await page.locator('.ms-ask-row b').allTextContents();
    assert.deepEqual(ask.sort(), ['Numbers not readable', 'What was measured?']);

    // A file that starts like MP4 but is cut short: kept (bytes retained), reported unreadable.
    await page.setInputFiles('.ms-actions [data-file]', { name: 'cut-short.mp4', mimeType: 'video/mp4', buffer: bytes.subarray(0, Math.floor(bytes.length / 3)) });
    await page.locator('.ms-video', { hasText: 'cut-short.mp4' }).locator('.ms-error').waitFor({ timeout: 20000 });
    assert.match(await page.locator('.ms-video', { hasText: 'cut-short.mp4' }).textContent(), /NOT READABLE.*not a readable MP4\/MOV/s);

    // The project file carries the video and every saved frame, byte for byte.
    const bundle = await page.evaluate(async () => {
      const s = await import('/js/store.js'), p = s.activeProperty(), packed = await s.exportProjectBlob(p.id), read = await s.readBundle(new File([packed.blob], packed.name));
      const video = read.files.find(f => f.meta.kind === 'video' && f.meta.name === 'walkthrough.mp4');
      return { kinds: read.files.map(f => f.meta.kind).sort(), video: video && Array.from(new Uint8Array(video.buffer).slice(0, 64)), length: video?.buffer.byteLength, frames: p.measurements.map(m => m.frameAssetId).filter(Boolean).length };
    });
    assert.deepEqual(bundle.kinds, ['frame', 'frame', 'frame', 'video', 'video']); assert.equal(bundle.frames, 3);
    assert.equal(bundle.length, bytes.length); assert.deepEqual(bundle.video, Array.from(bytes.subarray(0, 64)));
    await page.screenshot({ path: 'test-results/measure-desktop.png' });
    assert.deepEqual(errors, []);
    console.log('MEASURE with ffmpeg passed: refusals reported, blade seconds ' + candidates.join(',') + ', sharpest-frame burst, crop, reading applied and undone, ask-the-owner frames, truncated file kept and reported, bundle carries video and frames.');
    await page.close();
  } else console.log('ffmpeg is not installed: the frame-service path is covered only by the no-ffmpeg check below.');

  // Without ffmpeg: the service says so and the browser's player supplies frames (VP9 fixture).
  const port = await freePort(process.env.E2E_MOCK_PORT), url = 'http://127.0.0.1:' + port;
  children.push(serve(port, state + '/without-ffmpeg', { TIKSI_FFMPEG: '', TIKSI_FFPROBE: '' })); await ready(url);
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => d.accept());
  await page.goto(url); await kitchen(page);
  await page.waitForFunction(() => /needs ffmpeg/.test(document.querySelector('[data-service]').textContent));
  await page.setInputFiles('.ms-actions [data-file]', 'test/fixtures/tape-synthetic-vp9.mp4');
  await page.waitForSelector('.ms-video.active');
  const v = (await prop(page)).videos[0];
  assert.equal(v.analysis, null); assert.equal(v.mime, 'video/mp4');
  if (v.playable) {
    await page.waitForSelector('.ms-canvas video');
    await page.locator('.ms-stage').focus(); await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => document.querySelector('[data-time]').textContent.startsWith('0:01.0'));
    await record(page, { value: '30', text: 'base cabinet width' });
    const saved = (await prop(page)).measurements[0];
    assert.equal(saved.seconds, 1); assert.ok(saved.frameAssetId, 'the player frame is captured as an asset');
    console.log('MEASURE without ffmpeg passed: the service reports the missing decoder and the browser player supplies frames.');
  } else {
    await page.locator('.ms-stage-msg', { hasText: 'cannot play this video' }).waitFor();
    console.log('MEASURE without ffmpeg passed: this browser cannot decode VP9, and the page says so; the original is retained.');
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  for (const child of children) child.kill();
  await rm(state, { recursive: true, force: true });
}
