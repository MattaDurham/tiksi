// MODEL on a phone: what keeps the 3D page alive on a device with little memory, and what it
// says when it cannot draw. A synthetic house with synthetic scans, an iPhone-sized touch
// profile and a computer profile, isolated browser storage and a temporary port.
//
//   quality        a touch device draws at its own quality (Medium until it chooses), kept in its
//                  own browser storage, in either layout; a computer draws and saves the
//                  property's quality at any window width or layout
//   idle           nothing is drawn while nothing changes
//   scans          a hidden scan is not loaded until it is shown; loading a point cloud makes no
//                  extra copy of the file; a visit that ended does not hold up the next one;
//                  work computed from every scan loads the hidden ones first
//   textures       a touch device keeps fewer generated textures and shrinks big ones inside a
//                  model, but never frees a texture set that is on screen
//   graphics loss  a lost context is announced and, when it returns, the picture comes back
//                  whole (shadows, sky lighting and a Gaussian splat too) without a touch; no
//                  still is made from a lost context
//   failures       a MODEL that cannot start 3D, or cannot draw a frame, says so, and the
//                  second can be cleared by moving the view
//
// Chromium always runs. WebKit (Safari's engine) runs as well when Playwright has it installed;
// set E2E_PHONE_WEBKIT=require to fail without it or =skip to leave it out. A phone profile in
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


// Counts what reaches the graphics card: draw calls, and the pictures sent to it (textures with
// mip levels: material and model textures, never render targets or the splat renderer's working
// buffers): how many, and the longest side of the largest.
const GL_PROBE = () => {
  const P = WebGL2RenderingContext.prototype;
  const probe = window.__gl = { draws: 0, largest: 0, mipStores: 0, failDraws: false };
  for (const name of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced', 'drawRangeElements', 'multiDrawElementsWEBGL']) {
    const real = P[name];
    if (!real) continue;
    P[name] = function () { if (probe.failDraws) throw new Error('synthetic draw failure'); probe.draws++; return real.apply(this, arguments); };
  }
  const storage = P.texStorage2D;
  P.texStorage2D = function (target, levels, format, width, height) {
    if (target === 0x0DE1 && levels > 1) { probe.largest = Math.max(probe.largest, width, height); probe.mipStores++; }
    return storage.apply(this, arguments);
  };
  const image = P.texImage2D;
  P.texImage2D = function (target, level, format, a, b) {
    // A picture handed over whole: (target, level, internalformat, format, type, source).
    if (target === 0x0DE1 && level === 0 && arguments.length < 9) {
      const src = arguments[arguments.length - 1];
      if (src && src.width) probe.largest = Math.max(probe.largest, src.width, src.height);
    }
    return image.apply(this, arguments);
  };
};
// Lets a check hold back the point-cloud parser's messages (never another worker's), and counts them.
const PARSER_PROBE = () => {
  const real = Worker.prototype.postMessage;
  window.__parser = { hold: false, held: 0, sent: 0 };
  Worker.prototype.postMessage = function (message) {
    if (message && message.format && message.buffer) {
      if (window.__parser.hold) { window.__parser.held++; return; }
      window.__parser.sent++;
    }
    return real.apply(this, arguments);
  };
};

// One house and its scans. `shared` is the quality saved with the property (the Mac's).
//   scan-shown   a textured box model, visible; its texture is 2304 x 1152 pixels
//   scan-hidden  a red tower, hidden
//   scan-points  a point cloud of 4,000 points, hidden (visible with `cloudShown`)
//   scan-dense   a slab of 5,766 vertices, hidden: enough surface to line photo sessions up against
//   scan-splat   a magenta panel of 1,600 Gaussian splats standing in the room, visible
// `looks`: that many small rooms, each floored in its own material (default: one oak room).
// The property also has two numbered photo positions.
const seed = (page, shared, options = {}) => page.evaluate(async ([shared, options]) => {
  const s = await import('/js/store.js');
  const { writeGlb, boxGeometry } = await import('/tools/synthetic-model.mjs');
  localStorage.setItem('tiksi.onScreen.v1', '{"all":true}');   // MODEL's tools on the screen (tiksi-menu.js)
  s.ws.data = s.emptyWorkspace();
  const looks = options.looks || 0;
  for (let i = 0; i < looks; i++) s.ws.data.materials.push({ id: 'mat-floor-' + i, name: 'Floor ' + i, category: 'floor', pattern: 'drywall', color: '#' + (0x705040 + i * 0x040506).toString(16), tile: [1, 1], roughness: 0.9, metalness: 0, normalScale: 0.6 });
  (await import('/js/materials.js')).ensureBuiltinMaterials();
  const p = s.propertyTemplate('Phone check house'); p.id = 'prop-phone';
  const L = p.levels[0].id;
  p.env.quality = shared; p.env.date = '2024-06-21'; p.env.time = 15.5;
  p.walls = [[0, 0, 6, 0], [6, 0, 6, 4], [6, 4, 0, 4], [0, 4, 0, 0]].map(([ax, ay, bx, by], i) => ({ id: 'wall-' + i, level: L, ax, ay, bx, by, thickness: 0.15, material: 'mat-drywall' }));
  if (!looks) p.rooms.push({ id: 'room', level: L, name: 'Room', pts: [[0, 0], [6, 0], [6, 4], [0, 4]], material: 'mat-oak' });
  for (let i = 0; i < looks; i++) {
    const x = i % 6, y = Math.floor(i / 6) * 0.8;
    p.rooms.push({ id: 'room-' + i, level: L, name: 'Room ' + i, pts: [[x, y], [x + 1, y], [x + 1, y + 0.8], [x, y + 0.8]], material: 'mat-floor-' + i });
  }
  const view = (position, target) => ({ position, target, fov: 60 });
  p.photoPositions = [
    { id: 'pos-1', number: 1, name: 'Corner', roomId: '', view: view([10, 5, 9], [3, 1, 2]), createdAt: '2024-06-21T12:00:00.000Z', notes: '' },
    { id: 'pos-2', number: 2, name: 'Front', roomId: '', view: view([3, 3, 12], [3, 1, 2]), createdAt: '2024-06-21T12:00:00.000Z', notes: '' },
  ];
  p.positionCounter = 2;
  const scan = (id, name, format, kind, visible, more) => p.scans.push({ id, name, format, kind, pos: [0, 0, 0], rot: [0, 0, 0], rotY: 0, scale: 1, visible, ...more });

  // A picture bigger than a phone should hold: 2304 x 1152, as a PNG.
  const canvas = document.createElement('canvas'); canvas.width = 2304; canvas.height = 1152;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 2304, 1152); grad.addColorStop(0, '#c98f4a'); grad.addColorStop(1, '#3f6d8a');
  ctx.fillStyle = grad; ctx.fillRect(0, 0, 2304, 1152);
  const texture = new Uint8Array(await (await new Promise(r => canvas.toBlob(r, 'image/png'))).arrayBuffer());
  const shown = writeGlb({ looks: [{ name: 'Painted', color: [1, 1, 1, 1], roughness: 0.8, textured: true }],
    meshes: [{ geometry: boxGeometry(1.2, 1.2, 1.2), look: 0 }], nodes: [{ name: 'Crate', mesh: 0, translation: [8, 0.6, 2] }], texture });
  await s.putFile('scan-shown', shown.glb.buffer, { format: 'glb' });
  scan('scan-shown', 'Crate.glb', 'glb', 'mesh', true);

  const hidden = writeGlb({ looks: [{ name: 'Red', color: [0.85, 0.1, 0.1, 1], roughness: 0.7 }],
    meshes: [{ geometry: boxGeometry(1.5, 4, 1.5), look: 0 }], nodes: [{ name: 'Tower', mesh: 0, translation: [-2.5, 2, 2] }] });
  await s.putFile('scan-hidden', hidden.glb.buffer, { format: 'glb' });
  scan('scan-hidden', 'Tower.glb', 'glb', 'mesh', false);

  let rows = '';
  for (let i = 0; i < 4000; i++) rows += ((i % 40) * 0.05 + 2).toFixed(3) + ' ' + (Math.floor(i / 40) * 0.03).toFixed(3) + ' ' + (5 + (i % 7) * 0.01).toFixed(3) + '\n';
  const points = new TextEncoder().encode(rows).buffer;
  const pointBytes = points.byteLength;
  await s.putFile('scan-points', points, { format: 'xyz' });
  scan('scan-points', 'Cloud.xyz', 'xyz', 'points', !!options.cloudShown, { pointSize: 0.03, pointColor: 'solid', budget: 2000000 });

  const dense = writeGlb({ looks: [{ name: 'Slab', color: [0.5, 0.5, 0.55, 1], roughness: 0.9 }],
    meshes: [{ geometry: boxGeometry(3, 0.1, 3, 30), look: 0 }], nodes: [{ name: 'Slab', mesh: 0, translation: [3, -0.4, -4] }] });
  await s.putFile('scan-dense', dense.glb.buffer, { format: 'glb' });
  scan('scan-dense', 'Slab.glb', 'glb', 'mesh', false);

  // 40 x 40 splats, 32 bytes each: position, scale, colour, rotation.
  const n = 1600, splat = new ArrayBuffer(n * 32), dv = new DataView(splat), u8 = new Uint8Array(splat);
  for (let i = 0; i < n; i++) {
    const o = i * 32;
    dv.setFloat32(o, 1.8 + (i % 40) * 0.06, true); dv.setFloat32(o + 4, 0.6 + Math.floor(i / 40) * 0.06, true); dv.setFloat32(o + 8, 2, true);
    for (let k = 0; k < 3; k++) dv.setFloat32(o + 12 + k * 4, 0.04, true);
    u8.set([255, 0, 255, 255], o + 24); u8.set([255, 128, 128, 128], o + 28);
  }
  await s.putFile('scan-splat', splat, { format: 'splat' });
  scan('scan-splat', 'Panel.splat', 'splat', 'splat', true, { flip: false });

  s.ws.data.properties.push(p); s.ws.data.settings.activePropertyId = p.id;
  s.touch();
  return { pointBytes };
}, [shared, options]);

async function openModel(page, shared, options) {
  await page.goto(url + '/#/plan');
  await page.locator('#btn-file').waitFor({ state: 'attached' });
  const made = await seed(page, shared, options);
  await page.evaluate(() => { location.hash = '#/model'; });
  await page.locator('canvas.v-canvas').waitFor({ state: 'attached' });
  await settled(page, 'first open');
  return made;
}
async function reopenModel(page, what) {
  await page.evaluate(() => { location.hash = '#/plan'; });
  await page.locator('canvas.v-canvas').waitFor({ state: 'detached' });
  await page.evaluate(() => { location.hash = '#/model'; });
  await page.locator('canvas.v-canvas').waitFor({ state: 'attached' });
  await settled(page, what);
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
// How much of a picture is the splat panel's magenta.
const magenta = (page, png) => page.evaluate(async b64 => {
  const bmp = await createImageBitmap(new Blob([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], { type: 'image/png' }));
  const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
  const x = c.getContext('2d'); x.drawImage(bmp, 0, 0);
  const d = x.getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] > 150 && d[i + 2] > 150 && d[i + 1] < d[i] - 50) n++;
  return n / (d.length / 4);
}, png.toString('base64'));
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
const lose = page => page.evaluate(() => {
  const gl = document.querySelector('canvas.v-canvas').getContext('webgl2');
  window.__lose = window.__lose || gl.getExtension('WEBGL_lose_context');
  if (!window.__lose) return false;
  window.__lose.loseContext();
  return true;
});
const restore = page => page.evaluate(() => window.__lose.restoreContext());
const textures = (page, body) => page.evaluate(new Function('return import("/js/textures.js").then(async t => { ' + body + ' })'));
const settings = page => page.evaluate(async () => {
  const v = await import('/js/viewer3d.js');
  const host = document.createElement('div'); document.body.append(host);
  v.mountEnvironmentSettings(host);
  const out = { value: host.querySelector('[data-env=quality]').value, text: host.textContent };
  host.remove();
  return out;
});
// Drag across the middle of the view, as a person orbiting would.
async function orbit(page, dx = 80) {
  const box = await page.locator('canvas.v-canvas').boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + dx, y + 20, { steps: 6 }); await page.mouse.up();
}

const { defaultBrowserType, ...iphone } = devices['iPhone 13'];
const MB = 1024 * 1024;

// ---------- a touch device: the phone ----------
async function touchChecks(browser, say) {
  const context = await browser.newContext(iphone);
  await context.addInitScript(GL_PROBE);
  const errors = [];
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));

  // Its own quality.
  await openModel(page, 'ultra');
  assert.ok(await page.evaluate(() => document.documentElement.classList.contains('phone')), 'an iPhone-sized screen gets the phone layout');
  let q = await viewer(page, 'return v.qualityState()');
  assert.equal(q.touch, true, 'the phone profile is a touch device');
  assert.equal(q.shared, 'ultra', 'the property is saved at Ultra');
  assert.equal(q.quality, 'medium', 'the phone draws Medium until it chooses, not the Mac\'s Ultra');
  assert.deepEqual({ shadowMap: q.shadowMap, shading: q.shading, smoothingSamples: q.smoothingSamples }, { shadowMap: 2048, shading: false, smoothingSamples: 0 }, 'shadows, shading and smoothing are Medium\'s');
  assert.ok(q.pixelRatio <= 1.5, 'sharpness stays capped in the phone layout');
  const sizes = await textures(page, 'return t.textureStats().map(e => e.res)');
  assert.ok(sizes.length > 0 && Math.max(...sizes) <= 512, 'material textures are made small on the phone (largest ' + Math.max(...sizes) + ' px)');
  // What was loaded on open, and the longest side of the largest picture sent to the graphics card.
  const scans = await viewer(page, 'return v.scanStates()');
  const largest = await page.evaluate(() => window.__gl.largest);

  // Choosing on the phone (the phone panel's call) changes the phone and nothing saved with the property.
  await viewer(page, 'v.fieldAction("quality", "low")');
  await settled(page, 'after choosing Low');
  q = await viewer(page, 'return v.qualityState()');
  assert.deepEqual({ quality: q.quality, shared: q.shared, shadowMap: q.shadowMap }, { quality: 'low', shared: 'ultra', shadowMap: 1024 }, 'the phone draws its own choice; the property still says Ultra');
  assert.equal(await page.evaluate(() => localStorage.getItem('tiksi.device.quality')), 'low', 'the choice is kept in this browser');
  await reopenModel(page, 'back on MODEL');
  assert.equal((await viewer(page, 'return v.qualityState()')).quality, 'low', 'the choice is still there on the next visit to MODEL');
  assert.match((await viewer(page, 'return v.scanStates()'))['scan-shown'].label, /1 texture reduced to 1024 px/, 'at Low a model\'s textures are loaded smaller still');
  // The settings panel shows the device's quality and says whose it is.
  const panel = await settings(page);
  assert.equal(panel.value, 'low');
  assert.match(panel.text, /QUALITY ON THIS DEVICE/);
  await page.evaluate(async () => {
    const v = await import('/js/viewer3d.js');
    const host = document.createElement('div'); document.body.append(host);
    v.mountEnvironmentSettings(host);
    host.querySelector('[data-env=quality]').value = 'medium';
    host.querySelector('[data-env=quality]').dispatchEvent(new Event('change'));
    host.remove();
  });
  await settled(page, 'after choosing Medium in settings');
  q = await viewer(page, 'return v.qualityState()');
  assert.deepEqual({ quality: q.quality, shared: q.shared }, { quality: 'medium', shared: 'ultra' }, 'the settings panel changes the device\'s quality only');
  say('quality is the phone\'s own');

  // Nothing drawn while idle (a splat is on screen too).
  const idle = await idleDraws(page);
  assert.ok(idle.frames >= 10, 'the browser offered frames to draw in (' + idle.frames + ')');
  assert.equal(idle.draws, 0, 'MODEL draws nothing while nothing changes (' + idle.draws + ' draw calls over ' + idle.frames + ' frames)');
  say('idle: 0 draw calls over ' + idle.frames + ' offered frames');

  // Memory: scans and textures.
  assert.equal(scans['scan-shown'].state, 'ready', 'the visible scan is loaded');
  assert.equal(scans['scan-splat'].state, 'ready', 'the visible splat is loaded');
  for (const id of ['scan-hidden', 'scan-points', 'scan-dense']) assert.equal(scans[id].state, 'hidden', id + ': a hidden scan is not loaded on open');
  assert.match(scans['scan-shown'].label, /1 texture reduced to 2048 px/, 'the inspector says the texture was reduced');
  assert.ok(largest > 0 && largest <= 2048, 'no picture larger than 2048 pixels reaches the phone\'s graphics card (largest ' + largest + ')');
  assert.deepEqual(await textures(page, 'return t.textureLimits()'), { bytes: 96 * MB, sets: 24 }, 'the phone keeps fewer generated textures');
  // Thirty materials that are on no surface: once the model is next built, the phone keeps
  // no more sets than its limit.
  const made = await textures(page, `
    for (let i = 0; i < 30; i++) t.materialFor({ id: 'mat-check-' + i, name: 'Check ' + i, pattern: 'plaster', color: '#' + (0x808080 + i * 0x010203).toString(16), tile: [1, 1], roughness: 0.9, metalness: 0 });
    const end = Date.now() + 120000;
    while (t.pendingTextureJobs() > 0 && Date.now() < end) await new Promise(r => setTimeout(r, 100));
    return { pending: t.pendingTextureJobs(), sets: t.textureStats().length };`);
  assert.equal(made.pending, 0, 'the textures were made');
  await viewer(page, 'v.fieldAction("quality", "low")');
  await settled(page, 'after the texture check');
  const kept = await textures(page, 'return t.textureStats().length');
  assert.ok(made.sets > 24 && kept <= 24, 'thirty unused materials (' + made.sets + ' sets) are trimmed to the phone\'s limit of 24 (' + kept + ' kept)');
  await viewer(page, 'v.fieldAction("quality", "medium")');
  await settled(page, 'back at Medium');
  say('hidden scans stay unloaded; textures are capped (largest upload ' + largest + ' px, ' + kept + ' sets kept)');

  // Losing the graphics context.
  const before = await picture(page);
  const panelBefore = await magenta(page, before);
  assert.ok(panelBefore > 0.01, 'the splat panel is in the picture (' + (panelBefore * 100).toFixed(1) + '% of it)');
  const shadowsBefore = (await viewer(page, 'return v.frameState()')).shadowRefreshes;
  assert.ok(await lose(page), 'the browser can force a context loss');
  const notice = page.locator('[data-notice="graphics"]');
  await notice.waitFor({ timeout: 5000 });
  assert.match(await notice.innerText(), /lost its graphics memory/i, 'the view says the graphics memory is gone');
  assert.equal(await notice.locator('[data-reload]').count(), 0, 'no reload is offered straight away');
  assert.equal((await viewer(page, 'return v.viewerIdleState()')).graphics, false);
  await restore(page);
  await notice.waitFor({ state: 'detached', timeout: 15000 });
  await settled(page, 'after the context returned');
  // No touch, no click: the picture is back as it was, shadows, sky lighting and splat included.
  const after = await picture(page);
  const d = await difference(page, before, after);
  assert.ok(d.mean < 2 && d.share < 0.01, 'the picture returns as it was (mean difference ' + d.mean.toFixed(2) + ', ' + (d.share * 100).toFixed(2) + '% of pixels differ)');
  const panelAfter = await magenta(page, after);
  assert.ok(Math.abs(panelAfter - panelBefore) < 0.002, 'the splat is drawn again (' + (panelAfter * 100).toFixed(1) + '% of the picture, ' + (panelBefore * 100).toFixed(1) + '% before)');
  assert.ok((await viewer(page, 'return v.frameState()')).shadowRefreshes > shadowsBefore, 'the shadows were drawn again');
  // A context that stays away: the message offers a reload, and a late return still repairs it.
  await lose(page);
  await notice.locator('[data-reload]').waitFor({ timeout: 10000 });
  assert.match(await notice.innerText(), /has not got it back/i);
  await restore(page);
  await notice.waitFor({ state: 'detached', timeout: 15000 });
  await settled(page, 'after the late return');
  const late = await difference(page, before, await picture(page));
  assert.ok(late.mean < 2 && late.share < 0.01, 'a late return repairs the picture too (mean difference ' + late.mean.toFixed(2) + ')');
  const idleAgain = await idleDraws(page, 1500);
  assert.equal(idleAgain.draws, 0, 'and MODEL is idle again afterwards');
  say('graphics loss is announced and repaired, splat included (difference ' + d.mean.toFixed(2) + ' of 255)');

  // The same device in the desktop layout (a tablet, or a phone switched to it) is still a
  // touch device: its own quality, the lower limits, nothing saved to the property.
  const wide = await context.newPage();
  wide.on('pageerror', e => errors.push(e.message));
  await wide.setViewportSize({ width: 1280, height: 800 });
  await openModel(wide, 'ultra');
  assert.ok(!(await wide.evaluate(() => document.documentElement.classList.contains('phone'))), 'a wide screen gets the desktop layout');
  q = await viewer(wide, 'return v.qualityState()');
  assert.deepEqual({ touch: q.touch, quality: q.quality, shared: q.shared, sets: q.limits.textureSets, size: q.limits.importedTextureSize }, { touch: true, quality: 'medium', shared: 'ultra', sets: 24, size: 2048 },
    'a touch device in the desktop layout keeps its own quality and the lower limits');
  assert.match((await settings(wide)).text, /QUALITY ON THIS DEVICE/);
  await viewer(wide, 'v.fieldAction("quality", "high")');
  await settled(wide, 'touch device at High');
  assert.equal(await wide.evaluate(async () => (await import('/js/store.js')).activeProperty().env.quality), 'ultra', 'and its choice is not saved with the property');
  assert.equal(await wide.evaluate(() => localStorage.getItem('tiksi.device.quality')), 'high');
  await wide.close();
  say('a touch device keeps its own quality in the desktop layout too');

  assert.deepEqual(errors, [], 'no uncaught page errors on the touch device');
  await context.close();
}

// ---------- a touch device whose model alone is over the texture limit ----------
async function manyLooksChecks(browser, say) {
  const context = await browser.newContext(iphone);
  await context.addInitScript(GL_PROBE);
  const page = await context.newPage();
  const errors = [], warnings = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (/over this device's limit/.test(m.text())) warnings.push(m.text()); });
  await openModel(page, 'high', { looks: 30 });
  const onScreen = await textures(page, 'return t.textureStats().length');
  assert.ok(onScreen >= 31, 'thirty floors and the walls are all kept although the limit is 24 (' + onScreen + ' sets)');
  // Building the model again makes and uploads nothing: every set is still there.
  const stores = await page.evaluate(() => window.__gl.mipStores);
  await viewer(page, 'v.fieldAction("quality", "low")');
  const pending = await textures(page, 'return t.pendingTextureJobs()');
  await settled(page, 'after building the model again');
  await orbit(page); await delay(400);
  await settled(page, 'after moving the view');
  assert.equal(pending, 0, 'no texture is synthesised again when the model is built again');
  assert.equal(await page.evaluate(() => window.__gl.mipStores) - stores, 0, 'and none is sent to the graphics card again');
  assert.equal(await textures(page, 'return t.textureStats().length'), onScreen);
  // Sets on no surface still go.
  await textures(page, `
    for (let i = 0; i < 30; i++) t.materialFor({ id: 'mat-check-' + i, name: 'Check ' + i, pattern: 'plaster', color: '#' + (0x808080 + i * 0x010203).toString(16), tile: [1, 1], roughness: 0.9, metalness: 0 });
    const end = Date.now() + 120000;
    while (t.pendingTextureJobs() > 0 && Date.now() < end) await new Promise(r => setTimeout(r, 100));`);
  await viewer(page, 'v.fieldAction("quality", "medium")');
  await settled(page, 'after the unused sets');
  assert.equal(await textures(page, 'return t.textureStats().length'), onScreen, 'unused sets are freed; the ones on screen stay');
  assert.equal(warnings.length, 1, 'being over the limit is logged once (' + warnings.length + ')');
  assert.deepEqual(errors, []);
  await context.close();
  say('texture sets on screen are never freed (' + onScreen + ' kept, limit 24, logged once)');
}

// ---------- a computer ----------
async function computerChecks(browser, say) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(GL_PROBE);
  await context.addInitScript(() => localStorage.setItem('tiksi.onScreen.v1', '{"all":true}'));   // MODEL's tools on the screen from the first load (tiksi-menu.js)
  const errors = [];
  const desk = await context.newPage();
  desk.on('pageerror', e => errors.push(e.message));
  // A device choice left in this browser's storage must be ignored by a computer.
  await desk.goto(url + '/#/plan');
  await desk.evaluate(() => localStorage.setItem('tiksi.device.quality', 'low'));
  const made = await openModel(desk, 'ultra');
  assert.ok(!(await desk.evaluate(() => document.documentElement.classList.contains('phone'))), 'a desktop-sized page gets the desktop layout');
  let q = await viewer(desk, 'return v.qualityState()');
  assert.deepEqual({ touch: q.touch, quality: q.quality, shadowMap: q.shadowMap, shading: q.shading }, { touch: false, quality: 'ultra', shadowMap: 4096, shading: true }, 'the computer draws the property\'s Ultra');
  assert.deepEqual(q.limits, { textureBytes: 256 * MB, textureSets: 56, textureQuality: 'ultra', importedTextureSize: 16384, roomLights: 0, pointBudget: 0, scanBytes: 0 }, 'with the limits every device had before (0: none)');
  assert.deepEqual(await textures(desk, 'return t.textureLimits()'), { bytes: 256 * MB, sets: 56 });
  assert.doesNotMatch((await viewer(desk, 'return v.scanStates()'))['scan-shown'].label, /reduced/, 'the computer keeps the 2304 pixel texture whole');
  assert.doesNotMatch((await settings(desk)).text, /ON THIS DEVICE/, 'its setting is the property\'s');

  // A narrow window (half the screen) puts the computer in the phone layout. It is still the
  // computer: same quality, same limits, and a choice is saved with the property.
  await desk.setViewportSize({ width: 700, height: 800 });
  await waitUntil(() => desk.evaluate(() => document.documentElement.classList.contains('phone')), 'the narrow window switches to the phone layout');
  await delay(400);
  await settled(desk, 'in the narrow window');
  q = await viewer(desk, 'return v.qualityState()');
  assert.deepEqual({ phoneLayout: q.phoneLayout, quality: q.quality, shadowMap: q.shadowMap, sets: q.limits.textureSets, size: q.limits.importedTextureSize }, { phoneLayout: true, quality: 'ultra', shadowMap: 4096, sets: 56, size: 16384 },
    'a computer in the phone layout still draws the property\'s quality with the computer\'s limits');
  assert.doesNotMatch((await settings(desk)).text, /ON THIS DEVICE/);
  await viewer(desk, 'v.fieldAction("quality", "high")');
  await settled(desk, 'computer at High');
  assert.equal(await desk.evaluate(async () => (await import('/js/store.js')).activeProperty().env.quality), 'high', 'a computer\'s choice is saved with the property, in the phone layout too');
  assert.equal(await desk.evaluate(() => localStorage.getItem('tiksi.device.quality')), 'low', 'and does not touch the device choice in storage');
  await desk.setViewportSize({ width: 1280, height: 800 });
  await waitUntil(() => desk.evaluate(() => !document.documentElement.classList.contains('phone')), 'the wide window is back in the desktop layout');
  await delay(400);
  await settled(desk, 'back in the wide window');
  const deskIdle = await idleDraws(desk);
  assert.equal(deskIdle.draws, 0, 'the computer draws nothing while idle (' + deskIdle.draws + ' draw calls over ' + deskIdle.frames + ' frames)');
  say('a computer uses and saves the property\'s quality at any width or layout; idle: 0 draw calls over ' + deskIdle.frames + ' frames');

  // Showing a hidden scan loads it, once, and it appears.
  const withoutTower = await picture(desk);
  await desk.locator('#side [data-scan="scan-hidden"]').click();
  assert.match(await desk.locator('.inspector').innerText(), /not loaded while hidden/, 'the inspector says why a hidden scan has no numbers');
  await desk.locator('.inspector [data-vis]').check();
  await waitUntil(async () => (await viewer(desk, 'return v.scanStates()'))['scan-hidden'].state === 'ready', 'the scan loads when shown');
  await viewer(desk, 'v.fieldAction("camera", "frame")');
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
      document.querySelector('#side [data-scan="scan-points"]').click();
      document.querySelector('.inspector [data-vis]').click();
      const end = Date.now() + 60000;
      while (v.scanStates()['scan-points'].state !== 'ready' && Date.now() < end) await new Promise(r => setTimeout(r, 50));
      return { read, load: n, state: v.scanStates()['scan-points'] };
    } finally { ArrayBuffer.prototype.slice = real; }
  }, made.pointBytes);
  assert.equal(copies.state.state, 'ready', 'the point cloud loaded when shown');
  assert.match(copies.state.label, /4,000 points/, 'with every point');
  assert.ok(copies.load <= copies.read, 'loading copies the file no more than reading it does (' + copies.load + ' vs ' + copies.read + ')');

  // Lining photo sessions up is computed from every scan, hidden ones too, and its result is
  // saved: the scans not loaded yet are loaded first, and stay hidden.
  await settled(desk, 'before the line-up');
  assert.equal((await viewer(desk, 'return v.scanStates()'))['scan-dense'].state, 'hidden');
  const source = await viewer(desk, 'return v.lineUpSource()');
  assert.equal(source.from, 'scan', 'the line-up is against the scans, as when every scan was loaded on open (' + source.points + ' points from the ' + source.from + ')');
  assert.equal((await viewer(desk, 'return v.scanStates()'))['scan-dense'].state, 'ready', 'the hidden scan it needs was loaded for it');
  assert.equal(await desk.evaluate(async () => (await import('/js/store.js')).activeProperty().scans.find(x => x.id === 'scan-dense').visible), false, 'and stays hidden');
  await settled(desk, 'after the line-up');
  say('a scan loads when first shown; no extra copy of a point cloud\'s file; a line-up loads the scans it needs');

  // A still cannot be made from a lost context: nothing blank is filed, and it says what is left.
  await desk.locator('#side [data-scan="scan-points"]').click();   // any selection, then none: the positions list
  await desk.keyboard.press('Escape');
  const renderings = () => desk.evaluate(async () => (await import('/js/store.js')).activeProperty().photos.filter(p => p.role === 'rendering').map(p => p.thumb || ''));
  await viewer(desk, 'v.fieldAction("camera", "frame")');
  await delay(900); await settled(desk, 'before the stills');
  assert.ok(await lose(desk));
  await desk.locator('[data-notice="graphics"]').waitFor({ timeout: 5000 });
  await desk.evaluate(() => document.querySelector('.inspector [data-pos-render-all]').click());
  await waitUntil(async () => /Rendering stopped/.test(await desk.locator('.v-toast').innerText()), 'the rendering stops with a message');
  const stopped = await desk.locator('.v-toast').innerText();
  assert.match(stopped, /lost its graphics memory/i, 'it says why');
  assert.match(stopped, /Not rendered: positions 1, 2/, 'and which positions were not rendered');
  assert.deepEqual(await renderings(), [], 'no rendering was filed from the lost context');
  await restore(desk);
  await desk.locator('[data-notice="graphics"]').waitFor({ state: 'detached', timeout: 15000 });
  await settled(desk, 'after the context returned');
  await desk.evaluate(() => document.querySelector('.inspector [data-pos-render-all]').click());
  await waitUntil(async () => (await renderings()).length === 2, 'both positions render once the context is back', 240_000);
  const spread = await desk.evaluate(async thumbs => Promise.all(thumbs.map(async src => {
    const img = new Image(); img.src = src; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const x = c.getContext('2d'); x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data;
    let lo = 255, hi = 0;
    for (let i = 0; i < d.length; i += 4) { const g = (d[i] + d[i + 1] + d[i + 2]) / 3; lo = Math.min(lo, g); hi = Math.max(hi, g); }
    return hi - lo;
  })), await renderings());
  assert.ok(spread.every(v => v > 60), 'and the renderings are pictures, not blanks (brightness spread ' + spread.map(v => Math.round(v)).join(', ') + ')');
  await settled(desk, 'after the stills');
  say('no still is made from a lost context; the positions left are named');

  // A frame that will not draw: a strip says so, the view still takes input, and moving the
  // view (the next good frame) clears it.
  await desk.evaluate(() => { window.__gl.failDraws = true; });
  await orbit(desk);
  const drawNotice = desk.locator('[data-notice="draw"]');
  await drawNotice.waitFor({ timeout: 15000 });
  assert.match(await drawNotice.innerText(), /could not draw/i, 'a frame that fails says so on screen');
  assert.equal(await drawNotice.locator('[data-reload]').count(), 1);
  await desk.evaluate(() => { window.__gl.failDraws = false; });
  const under = await desk.evaluate(() => {
    const r = document.querySelector('canvas.v-canvas').getBoundingClientRect(), b = document.querySelector('[data-notice="draw"]').getBoundingClientRect();
    const at = (x, y) => document.elementFromPoint(x, y);
    return { middle: at(r.left + r.width / 2, r.top + r.height / 2)?.tagName, onMessage: at(b.left + 20, b.top + b.height / 2)?.tagName, onButton: at(...(q => [q.left + q.width / 2, q.top + q.height / 2])(document.querySelector('[data-notice="draw"] [data-reload]').getBoundingClientRect()))?.tagName };
  });
  assert.deepEqual(under, { middle: 'CANVAS', onMessage: 'CANVAS', onButton: 'BUTTON' }, 'the message lets touches through to the view everywhere but its button');
  await orbit(desk, -80);
  await drawNotice.waitFor({ state: 'detached', timeout: 15000 });
  say('a failed frame is announced, and cleared by moving the view');

  assert.deepEqual(errors.filter(e => !/synthetic draw failure/.test(e)), [], 'no uncaught page errors on the computer');
  await context.close();
}

// ---------- a visit that ended must not hold up the next ----------
async function queueChecks(browser, say) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(PARSER_PROBE);
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(url + '/#/plan');
  await page.locator('#btn-file').waitFor({ state: 'attached' });
  await seed(page, 'low', { cloudShown: true });
  // The first visit's point cloud never finishes parsing.
  await page.evaluate(() => { window.__parser.hold = true; location.hash = '#/model'; });
  await page.locator('canvas.v-canvas').waitFor({ state: 'attached' });
  await waitUntil(() => page.evaluate(() => window.__parser.held > 0), 'the first visit is stuck parsing its point cloud');
  assert.equal((await viewer(page, 'return v.scanStates()'))['scan-points'].state, 'loading');
  // Leave and come back (as a save from another device, or another property, does).
  await page.evaluate(() => { window.__parser.hold = false; location.hash = '#/plan'; });
  await page.locator('canvas.v-canvas').waitFor({ state: 'detached' });
  await page.evaluate(() => { location.hash = '#/model'; });
  await page.locator('canvas.v-canvas').waitFor({ state: 'attached' });
  await waitUntil(async () => { const s = await viewer(page, 'return v.scanStates()'); return ['scan-shown', 'scan-points', 'scan-splat'].every(id => s && s[id].state === 'ready'); },
    'the next visit loads its scans without waiting for the one left behind', 45_000);
  // A load whose visit is over stops once its bytes arrive, before anything is parsed.
  const abandoned = await page.evaluate(async () => {
    const sc = await import('/js/scans.js'), s = await import('/js/store.js');
    const scan = s.activeProperty().scans.find(x => x.id === 'scan-points');
    const sent = window.__parser.sent;
    const result = await sc.loadScanObject(scan, null, () => false);
    return { result: result === null, parsed: window.__parser.sent - sent };
  });
  assert.deepEqual(abandoned, { result: true, parsed: 0 }, 'an abandoned load parses nothing');
  assert.deepEqual(errors, []);
  await context.close();
  say('a visit left mid-load does not hold up the next one');
}

// ---------- a browser that cannot start 3D ----------
async function no3dChecks(browser, say) {
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

async function allChecks(browser, engine) {
  const say = text => console.log('  ' + engine + ': ' + text);
  const only = process.env.E2E_PHONE_ONLY;   // one part, for working on this file
  const parts = { touch: touchChecks, looks: manyLooksChecks, computer: computerChecks, queue: queueChecks, no3d: no3dChecks };
  for (const [name, part] of Object.entries(parts)) if (!only || only === name) await part(browser, say);
}

const wantWebkit = process.env.E2E_PHONE_WEBKIT || 'auto';
let failed = false;
try {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  try { await allChecks(browser, 'Chromium'); } finally { await browser.close(); }
  if (wantWebkit !== 'skip') {
    let safari = null;
    try { safari = await webkit.launch(); }
    catch (e) {
      if (wantWebkit === 'require') throw e;
      console.log('  WebKit is not installed here; the checks ran in Chromium only.');
    }
    if (safari) { try { await allChecks(safari, 'WebKit'); } finally { await safari.close(); } }
  }
  console.log('MODEL on a phone: quality, idle drawing, scans, textures, graphics loss and failure messages passed.');
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  await new Promise(r => server.close(r));
}
process.exit(failed ? 1 : 0);
