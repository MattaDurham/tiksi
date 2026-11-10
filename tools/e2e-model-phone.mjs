// MODEL on a phone: what keeps the 3D page alive on a device with little memory, and what it
// says when it cannot draw. A synthetic house with three synthetic scans, an iPhone-sized
// browser profile, isolated browser storage and a temporary port.
//
//   quality        the phone draws at its own quality (Medium until it chooses), kept in its own
//                  browser storage; the desktop still draws the property's shared setting
//   idle           nothing is drawn while nothing changes
//   scans          a hidden scan is not loaded until it is shown, and loading a point cloud
//                  makes no extra copy of the file
//   textures       the phone keeps fewer generated textures and shrinks big ones inside a model
//   graphics loss  a lost context is announced and, when it returns, the picture comes back
//                  whole (shadows and sky lighting too) without a touch
//   failures       a MODEL that cannot start 3D, or cannot draw a frame, says so
//
// Chromium always runs. WebKit (Safari's engine) runs as well when Playwright has it installed;
// set E2E_PHONE_WEBKIT=require to fail without it or =skip to leave it out. An iPhone profile in
// a desktop browser engine checks behaviour: it says nothing about a real phone's speed or memory.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { readFile } from 'node:fs/promises';
import { dirname, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit, devices } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = createServer(async (req, res) => {
  const path = resolve(root, '.' + decodeURIComponent(req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0]));
  if (!path.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  try { const bytes = await readFile(path); res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.wasm': 'application/wasm' })[extname(path)] || 'application/octet-stream'); res.end(bytes); }
  catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(Number(process.env.E2E_APP_PORT) || 0, 'localhost', r));
const url = `http://localhost:${server.address().port}`;

const viewer = (page, body, arg) => page.evaluate(new Function('arg', 'return import("/js/viewer3d.js").then(async v => { ' + body + ' })'), arg);
async function settled(page, what, ms = 240_000) {
  const end = Date.now() + ms;
  while (!(await viewer(page, 'return v.viewerIdle()'))) {
    assert.ok(Date.now() < end, 'MODEL did not settle (' + what + '): ' + JSON.stringify(await viewer(page, 'return v.viewerIdleState()')));
    await delay(200);
  }
}
async function waitUntil(predicate, message, ms = 60_000) {
  const end = Date.now() + ms;
  while (!(await predicate())) { assert.ok(Date.now() < end, 'Timed out: ' + message); await delay(150); }
}

// Counts what reaches the graphics card: draw calls, and the largest texture storage asked for.
const GL_PROBE = () => {
  const P = WebGL2RenderingContext.prototype;
  const probe = window.__gl = { draws: 0, largest: 0, failDraws: false };
  for (const name of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced', 'drawRangeElements', 'multiDrawElementsWEBGL']) {
    const real = P[name];
    if (!real) continue;
    P[name] = function () { if (probe.failDraws) throw new Error('synthetic draw failure'); probe.draws++; return real.apply(this, arguments); };
  }
  const storage = P.texStorage2D;
  P.texStorage2D = function (target, levels, format, width, height) { if (target === 0x0DE1) probe.largest = Math.max(probe.largest, width, height); return storage.apply(this, arguments); };
  const image = P.texImage2D;
  P.texImage2D = function (target, level, format, a, b) {
    // (target, level, internalformat, width, height, border, ...) or (..., format, type, source)
    if (target === 0x0DE1 && level === 0) {
      if (arguments.length >= 9) probe.largest = Math.max(probe.largest, a, b);
      else { const src = arguments[arguments.length - 1]; if (src && src.width) probe.largest = Math.max(probe.largest, src.width, src.height); }
    }
    return image.apply(this, arguments);
  };
};

// One house, three scans. `shared` is the quality saved with the property (the Mac's).
//   scan-shown   a textured box model, visible; its texture is 2304 x 1152 pixels
//   scan-hidden  a red tower, hidden
//   scan-points  a point cloud, hidden
const seed = (page, shared) => page.evaluate(async shared => {
  const s = await import('/js/store.js');
  const { writeGlb, boxGeometry } = await import('/tools/synthetic-model.mjs');
  localStorage.setItem('tiksi.onScreen.v1', '{"all":true}');   // MODEL's tools on the screen (tiksi-menu.js)
  s.ws.data = s.emptyWorkspace();
  (await import('/js/materials.js')).ensureBuiltinMaterials();
  const p = s.propertyTemplate('Phone check house'); p.id = 'prop-phone';
  const L = p.levels[0].id;
  p.env.quality = shared; p.env.date = '2024-06-21'; p.env.time = 15.5;
  p.walls = [[0, 0, 6, 0], [6, 0, 6, 4], [6, 4, 0, 4], [0, 4, 0, 0]].map(([ax, ay, bx, by], i) => ({ id: 'wall-' + i, level: L, ax, ay, bx, by, thickness: 0.15, material: 'mat-drywall' }));
  p.rooms.push({ id: 'room', level: L, name: 'Room', pts: [[0, 0], [6, 0], [6, 4], [0, 4]], material: 'mat-oak' });

  // A picture bigger than a phone should hold: 2304 x 1152, as a PNG.
  const canvas = document.createElement('canvas'); canvas.width = 2304; canvas.height = 1152;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 2304, 1152); grad.addColorStop(0, '#c98f4a'); grad.addColorStop(1, '#3f6d8a');
  ctx.fillStyle = grad; ctx.fillRect(0, 0, 2304, 1152);
  const texture = new Uint8Array(await (await new Promise(r => canvas.toBlob(r, 'image/png'))).arrayBuffer());

  const shown = writeGlb({ looks: [{ name: 'Painted', color: [1, 1, 1, 1], roughness: 0.8, textured: true }],
    meshes: [{ geometry: boxGeometry(1.2, 1.2, 1.2), look: 0 }], nodes: [{ name: 'Crate', mesh: 0, translation: [8, 0.6, 2] }], texture });
  await s.putFile('scan-shown', shown.glb.buffer, { format: 'glb' });
  p.scans.push({ id: 'scan-shown', name: 'Crate.glb', format: 'glb', kind: 'mesh', pos: [0, 0, 0], rot: [0, 0, 0], rotY: 0, scale: 1, visible: true });

  const hidden = writeGlb({ looks: [{ name: 'Red', color: [0.85, 0.1, 0.1, 1], roughness: 0.7 }],
    meshes: [{ geometry: boxGeometry(1.5, 4, 1.5), look: 0 }], nodes: [{ name: 'Tower', mesh: 0, translation: [-2.5, 2, 2] }] });
  await s.putFile('scan-hidden', hidden.glb.buffer, { format: 'glb' });
  p.scans.push({ id: 'scan-hidden', name: 'Tower.glb', format: 'glb', kind: 'mesh', pos: [0, 0, 0], rot: [0, 0, 0], rotY: 0, scale: 1, visible: false });

  let rows = '';
  for (let i = 0; i < 4000; i++) rows += ((i % 40) * 0.05 + 2).toFixed(3) + ' ' + (Math.floor(i / 40) * 0.03).toFixed(3) + ' ' + (5 + (i % 7) * 0.01).toFixed(3) + '\n';
  const points = new TextEncoder().encode(rows).buffer;
  const pointBytes = points.byteLength;
  await s.putFile('scan-points', points, { format: 'xyz' });
  p.scans.push({ id: 'scan-points', name: 'Cloud.xyz', format: 'xyz', kind: 'points', pos: [0, 0, 0], rot: [0, 0, 0], rotY: 0, scale: 1, visible: false, pointSize: 0.03, pointColor: 'solid', budget: 2000000 });

  s.ws.data.properties.push(p); s.ws.data.settings.activePropertyId = p.id;
  s.touch();
  return { pointBytes };
}, shared);

async function openModel(page, shared) {
  await page.goto(url + '/#/plan');
  await page.locator('#btn-file').waitFor({ state: 'attached' });
  const made = await seed(page, shared);
  await page.evaluate(() => { location.hash = '#/model'; });
  await page.locator('canvas.v-canvas').waitFor({ state: 'attached' });
  await settled(page, 'first open');
  return made;
}

// Mean difference between two PNG screenshots, and the share of pixels that differ clearly.
const difference = (page, a, b) => page.evaluate(async ([a, b]) => {
  const pixels = async b64 => {
    const bmp = await createImageBitmap(new Blob([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], { type: 'image/png' }));
    const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
    const x = c.getContext('2d'); x.drawImage(bmp, 0, 0);
    return x.getImageData(0, 0, c.width, c.height).data;
  };
  const p = await pixels(a), q = await pixels(b);
  if (p.length !== q.length) return { mean: 255, share: 1 };
  let sum = 0, off = 0;
  for (let i = 0; i < p.length; i += 4) {
    const d = Math.abs(p[i] - q[i]) + Math.abs(p[i + 1] - q[i + 1]) + Math.abs(p[i + 2] - q[i + 2]);
    sum += d; if (d > 48) off++;
  }
  return { mean: sum / (p.length / 4) / 3, share: off / (p.length / 4) };
}, [a.toString('base64'), b.toString('base64')]);
const picture = page => page.locator('canvas.v-canvas').screenshot();
const idleDraws = (page, ms = 2500) => page.evaluate(async ms => {
  const start = window.__gl.draws; let frames = 0, stop = false;
  const count = () => { frames++; if (!stop) requestAnimationFrame(count); };
  requestAnimationFrame(count);
  // For `ms`, and on a busy machine for as long as it takes the browser to offer 30 frames
  // (20 seconds at most): a slow machine must not make the count meaningless.
  const began = performance.now();
  while (performance.now() - began < ms || (frames < 30 && performance.now() - began < 20000)) await new Promise(r => setTimeout(r, 100));
  stop = true;
  return { frames, draws: window.__gl.draws - start };
}, ms);

const { defaultBrowserType, ...iphone } = devices['iPhone 13'];

async function phoneChecks(browser, engine) {
  const say = text => console.log('  ' + engine + ': ' + text);
  const context = await browser.newContext(iphone);
  await context.addInitScript(GL_PROBE);
  const errors = [];
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));

  // ---------- the phone's own quality ----------
  await openModel(page, 'ultra');
  assert.ok(await page.evaluate(() => document.documentElement.classList.contains('phone')), 'an iPhone-sized screen gets the phone layout');
  let q = await viewer(page, 'return v.qualityState()');
  assert.equal(q.shared, 'ultra', 'the property is saved at Ultra');
  assert.equal(q.quality, 'medium', 'the phone draws Medium until it chooses, not the Mac\'s Ultra');
  assert.deepEqual({ shadowMap: q.shadowMap, shading: q.shading, smoothingSamples: q.smoothingSamples }, { shadowMap: 2048, shading: false, smoothingSamples: 0 }, 'shadows, shading and smoothing are Medium\'s');
  assert.ok(q.pixelRatio <= 1.5, 'sharpness stays capped on the phone');
  const sizes = await page.evaluate(async () => (await import('/js/textures.js')).textureStats().map(t => t.res));
  assert.ok(sizes.length > 0 && Math.max(...sizes) <= 512, 'material textures are made small on the phone (largest ' + Math.max(...sizes) + ' px)');
  // What was loaded on open, and how big the largest picture sent to the graphics card was.
  const scans = await viewer(page, 'return v.scanStates()');
  const largest = await page.evaluate(() => window.__gl.largest);

  // Choosing on the phone (the phone panel's call) changes the phone and nothing saved with the property.
  await viewer(page, 'v.fieldAction("quality", "low")');
  await settled(page, 'after choosing Low');
  q = await viewer(page, 'return v.qualityState()');
  assert.deepEqual({ quality: q.quality, shared: q.shared, shadowMap: q.shadowMap }, { quality: 'low', shared: 'ultra', shadowMap: 1024 }, 'the phone draws its own choice; the property still says Ultra');
  assert.equal(await page.evaluate(() => localStorage.getItem('tiksi.phone.quality')), 'low', 'the choice is kept in this browser');
  // Leaving MODEL and coming back keeps it.
  await page.evaluate(() => { location.hash = '#/plan'; });
  await page.locator('canvas.v-canvas').waitFor({ state: 'detached' });
  await page.evaluate(() => { location.hash = '#/model'; });
  await page.locator('canvas.v-canvas').waitFor({ state: 'attached' });
  await settled(page, 'back on MODEL');
  assert.equal((await viewer(page, 'return v.qualityState()')).quality, 'low', 'the choice is still there on the next visit to MODEL');
  assert.match((await viewer(page, 'return v.scanStates()'))['scan-shown'].label, /1 texture reduced to 1024 px/, 'at Low a model\'s textures are loaded smaller still');
  // The settings panel shows the phone's quality and says whose it is.
  const panel = await page.evaluate(async () => {
    const v = await import('/js/viewer3d.js');
    const host = document.createElement('div'); document.body.append(host);
    v.mountEnvironmentSettings(host);
    const out = { value: host.querySelector('[data-env=quality]').value, text: host.textContent };
    host.querySelector('[data-env=quality]').value = 'medium';
    host.querySelector('[data-env=quality]').dispatchEvent(new Event('change'));
    host.remove();
    return out;
  });
  assert.equal(panel.value, 'low');
  assert.match(panel.text, /QUALITY ON THIS PHONE/);
  await settled(page, 'after choosing Medium in settings');
  q = await viewer(page, 'return v.qualityState()');
  assert.deepEqual({ quality: q.quality, shared: q.shared }, { quality: 'medium', shared: 'ultra' }, 'the settings panel changes the phone\'s quality only');
  say('quality is the phone\'s own');

  // ---------- nothing drawn while idle ----------
  const idle = await idleDraws(page);
  assert.ok(idle.frames >= 10, 'the browser offered frames to draw in (' + idle.frames + ')');
  assert.equal(idle.draws, 0, 'MODEL draws nothing while nothing changes (' + idle.draws + ' draw calls over ' + idle.frames + ' frames)');
  say('idle: 0 draw calls over ' + idle.frames + ' offered frames');

  // ---------- memory: scans and textures ----------
  assert.equal(scans['scan-shown'].state, 'ready', 'the visible scan is loaded');
  assert.equal(scans['scan-hidden'].state, 'hidden', 'a hidden scan is not loaded on open');
  assert.equal(scans['scan-points'].state, 'hidden');
  assert.match(scans['scan-shown'].label, /1 texture reduced to 2048 px/, 'the inspector says the texture was reduced');
  assert.ok(largest > 0 && largest <= 2048, 'nothing larger than 2048 pixels reaches the phone\'s graphics card (largest ' + largest + ')');
  const limits = await page.evaluate(async () => (await import('/js/textures.js')).textureLimits());
  assert.deepEqual(limits, { bytes: 96 * 1024 * 1024, sets: 24 }, 'the phone keeps fewer generated textures');
  // Thirty different materials: the phone keeps no more sets than its limit.
  const kept = await page.evaluate(async () => {
    const t = await import('/js/textures.js');
    for (let i = 0; i < 30; i++) t.materialFor({ id: 'mat-check-' + i, name: 'Check ' + i, pattern: 'drywall', color: '#' + (0x808080 + i * 0x010203).toString(16), tile: [1, 1], roughness: 0.9, metalness: 0 });
    const end = Date.now() + 120000;
    while (t.pendingTextureJobs() > 0 && Date.now() < end) await new Promise(r => setTimeout(r, 100));
    return { pending: t.pendingTextureJobs(), sets: t.textureStats().length };
  });
  assert.equal(kept.pending, 0, 'the textures were made');
  assert.ok(kept.sets <= 24, 'thirty materials leave ' + kept.sets + ' texture sets on the phone, within its limit of 24');
  await settled(page, 'after the texture check');
  say('hidden scans stay unloaded; textures are capped (largest upload ' + largest + ' px, ' + kept.sets + ' sets kept)');

  // ---------- losing the graphics context ----------
  const before = await picture(page);
  const shadowsBefore = (await viewer(page, 'return v.frameState()')).shadowRefreshes;
  const lose = () => page.evaluate(() => {
    const gl = document.querySelector('canvas.v-canvas').getContext('webgl2');
    window.__lose = window.__lose || gl.getExtension('WEBGL_lose_context');
    if (!window.__lose) return false;
    window.__lose.loseContext();
    return true;
  });
  assert.ok(await lose(), 'the browser can force a context loss');
  const notice = page.locator('[data-notice="graphics"]');
  await notice.waitFor({ timeout: 5000 });
  assert.match(await notice.innerText(), /lost its graphics memory/i, 'the view says the graphics memory is gone');
  assert.equal(await notice.locator('[data-reload]').count(), 0, 'no reload is offered straight away');
  assert.equal((await viewer(page, 'return v.viewerIdleState()')).graphics, false);
  await page.evaluate(() => window.__lose.restoreContext());
  await notice.waitFor({ state: 'detached', timeout: 15000 });
  await settled(page, 'after the context returned');
  // No touch, no click: the picture is back as it was, shadows and sky lighting included.
  const after = await picture(page);
  const d = await difference(page, before, after);
  assert.ok(d.mean < 2 && d.share < 0.01, 'the picture returns as it was (mean difference ' + d.mean.toFixed(2) + ', ' + (d.share * 100).toFixed(2) + '% of pixels differ)');
  assert.ok((await viewer(page, 'return v.frameState()')).shadowRefreshes > shadowsBefore, 'the shadows were drawn again');
  // A context that stays away: the message offers a reload, and a late return still repairs it.
  await lose();
  await notice.locator('[data-reload]').waitFor({ timeout: 10000 });
  assert.match(await notice.innerText(), /has not got it back/i);
  await page.evaluate(() => window.__lose.restoreContext());
  await notice.waitFor({ state: 'detached', timeout: 15000 });
  await settled(page, 'after the late return');
  const late = await difference(page, before, await picture(page));
  assert.ok(late.mean < 2 && late.share < 0.01, 'a late return repairs the picture too (mean difference ' + late.mean.toFixed(2) + ')');
  const idleAgain = await idleDraws(page, 1500);
  assert.equal(idleAgain.draws, 0, 'and MODEL is idle again afterwards');
  say('graphics loss is announced and repaired (difference ' + d.mean.toFixed(2) + ' of 255)');

  // ---------- the desktop, in the same browser storage ----------
  // The phone's choice sits in this storage; a desktop-sized page must ignore it.
  const desk = await context.newPage();
  desk.on('pageerror', e => errors.push(e.message));
  await desk.setViewportSize({ width: 1280, height: 800 });
  const made = await openModel(desk, 'ultra');
  assert.ok(!(await desk.evaluate(() => document.documentElement.classList.contains('phone'))), 'a desktop-sized page gets the desktop layout');
  const dq = await viewer(desk, 'return v.qualityState()');
  assert.deepEqual({ quality: dq.quality, shadowMap: dq.shadowMap, shading: dq.shading }, { quality: 'ultra', shadowMap: 4096, shading: true }, 'the desktop draws the property\'s Ultra whatever the phone chose');
  assert.deepEqual(await desk.evaluate(async () => (await import('/js/textures.js')).textureLimits()), { bytes: 256 * 1024 * 1024, sets: 56 }, 'the desktop keeps its texture limits');
  const deskScans = await viewer(desk, 'return v.scanStates()');
  assert.doesNotMatch(deskScans['scan-shown'].label, /reduced/, 'the desktop keeps the 2304 pixel texture whole');
  // Choosing on the desktop still saves with the property, as before.
  await viewer(desk, 'v.fieldAction("quality", "high")');
  await settled(desk, 'desktop at High');
  assert.equal(await desk.evaluate(async () => (await import('/js/store.js')).activeProperty().env.quality), 'high', 'a desktop choice is saved with the property');
  assert.equal(await desk.evaluate(() => localStorage.getItem('tiksi.phone.quality')), 'medium', 'and does not touch the phone\'s choice');
  const deskIdle = await idleDraws(desk);
  assert.equal(deskIdle.draws, 0, 'the desktop draws nothing while idle (' + deskIdle.draws + ' draw calls over ' + deskIdle.frames + ' frames)');

  // Showing a hidden scan loads it, once, and it appears.
  const withoutTower = await picture(desk);
  await desk.locator('.tool-col [data-scan="scan-hidden"]').click();
  assert.match(await desk.locator('.inspector').innerText(), /not loaded while hidden/, 'the inspector says why a hidden scan has no numbers');
  await desk.locator('.inspector [data-vis]').check();
  await waitUntil(async () => (await viewer(desk, 'return v.scanStates()'))['scan-hidden'].state === 'ready', 'the scan loads when shown');
  await desk.evaluate(async () => (await import('/js/viewer3d.js')).fieldAction('camera', 'frame'));
  await delay(1200);
  await settled(desk, 'after showing the tower');
  const tower = await difference(desk, withoutTower, await picture(desk));
  assert.ok(tower.share > 0.01, 'the shown scan is in the picture (' + (tower.share * 100).toFixed(1) + '% of pixels changed)');

  // Loading the point cloud hands the file's bytes to the parser: no copy of its own.
  // Baseline: how many whole-file copies one plain read from storage makes.
  const copies = await desk.evaluate(async size => {
    const s = await import('/js/store.js'), v = await import('/js/viewer3d.js');
    const real = ArrayBuffer.prototype.slice;
    let n = 0;
    ArrayBuffer.prototype.slice = function () { const out = real.apply(this, arguments); if (this.byteLength === size && out.byteLength === size) n++; return out; };
    try {
      await s.getFile('scan-points');
      const read = n; n = 0;
      const scan = s.activeProperty().scans.find(x => x.id === 'scan-points');
      document.querySelector('.tool-col [data-scan="scan-points"]').click();
      document.querySelector('.inspector [data-vis]').click();
      const end = Date.now() + 60000;
      while (v.scanStates()['scan-points'].state !== 'ready' && Date.now() < end) await new Promise(r => setTimeout(r, 50));
      return { read, load: n, state: v.scanStates()['scan-points'], visible: scan.visible };
    } finally { ArrayBuffer.prototype.slice = real; }
  }, made.pointBytes);
  assert.equal(copies.state.state, 'ready', 'the point cloud loaded when shown');
  assert.match(copies.state.label, /4,000 points/, 'with every point');
  assert.ok(copies.load <= copies.read, 'loading copies the file no more than reading it does (' + copies.load + ' vs ' + copies.read + ')');
  say('desktop unchanged; a scan loads when first shown; no extra copy of a point cloud\'s file');

  // ---------- a frame that will not draw ----------
  await settled(desk, 'before the draw failure');
  await desk.evaluate(() => { window.__gl.failDraws = true; });
  await viewer(desk, 'v.fieldAction("camera", "iso")');
  const drawNotice = desk.locator('[data-notice="draw"]');
  await drawNotice.waitFor({ timeout: 15000 });
  assert.match(await drawNotice.innerText(), /could not draw/i, 'a frame that fails says so on screen');
  assert.equal(await drawNotice.locator('[data-reload]').count(), 1);
  await desk.evaluate(() => { window.__gl.failDraws = false; });
  await viewer(desk, 'v.fieldAction("camera", "front")');
  await drawNotice.waitFor({ state: 'detached', timeout: 15000 });
  say('a failed frame is announced, and cleared by the next good one');

  assert.deepEqual(errors.filter(e => !/synthetic draw failure/.test(e)), [], 'no uncaught page errors');
  await context.close();

  // ---------- a browser that cannot start 3D ----------
  const none = await browser.newContext(iphone);
  await none.addInitScript(() => {
    const real = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (kind) { return /webgl/i.test(kind) ? null : real.apply(this, arguments); };
  });
  const blank = await none.newPage();
  const blankErrors = []; blank.on('pageerror', e => blankErrors.push(e.message));
  await blank.goto(url + '/#/plan');
  await blank.locator('#btn-file').waitFor({ state: 'attached' });
  await seed(blank, 'high');
  await blank.evaluate(() => { location.hash = '#/model'; });
  const failed = blank.locator('.v-open-failed');
  await failed.waitFor({ timeout: 15000 });
  assert.match(await failed.innerText(), /could not start 3D graphics/i, 'MODEL says 3D could not start');
  assert.equal(await failed.locator('[data-reload]').count(), 1, 'and offers a reload');
  // The other pages still open, and MODEL can be tried again.
  await blank.evaluate(() => { location.hash = '#/plan'; });
  await failed.waitFor({ state: 'detached' });
  await waitUntil(async () => (await blank.locator('#view').innerText()).trim().length > 0, 'PLAN opens after MODEL failed');
  await blank.evaluate(() => { location.hash = '#/model'; });
  await failed.waitFor({ timeout: 15000 });
  assert.deepEqual(blankErrors, [], 'a MODEL that cannot open throws nothing uncaught');
  await none.close();
  say('a MODEL that cannot open says so');
}

const wantWebkit = process.env.E2E_PHONE_WEBKIT || 'auto';
let failed = false;
try {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  try { await phoneChecks(browser, 'Chromium, iPhone profile'); } finally { await browser.close(); }
  if (wantWebkit !== 'skip') {
    let safari = null;
    try { safari = await webkit.launch(); }
    catch (e) {
      if (wantWebkit === 'require') throw e;
      console.log('  WebKit is not installed here; the phone checks ran in Chromium only.');
    }
    if (safari) { try { await phoneChecks(safari, 'WebKit, iPhone profile'); } finally { await safari.close(); } }
  }
  console.log('MODEL on a phone: quality, idle drawing, scans, textures, graphics loss and failure messages passed.');
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  await new Promise(r => server.close(r));
}
process.exit(failed ? 1 : 0);
