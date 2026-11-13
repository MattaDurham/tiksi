// Network fault injection uses Playwright routing, which service workers bypass.
// The real service-worker/offline journey is covered in e2e-audit-repairs.mjs.
// MODEL's tools and speed: marking up by tap in the phone layout, navigation with fingers, what a
// tap tests, room lights, repeated work, texture making, pinned photos and scan limits.
// Synthetic houses and scans, a touch profile and a computer profile, isolated browser storage
// and a temporary port.
//
//   phone tools   Measure and Note by tap with a visible instruction and DONE; a tap opens a
//                 note; saved views and before / after from the panel's calls; a plain tap tests
//                 markers only; one finger pans in Top view; a pinch travels to what is under it
//   listeners     leaving MODEL removes the navigation's listeners
//   picking       a click on a large scan goes through the pick index and selects the same thing
//   small work    walking into a room bakes no sky lighting
//   textures      sets are made in the background helper with the pixels the page would make; a
//                 model waits only for the sets it uses; without a helper the picture is the same
//   pins          pinned photos load two at a time, and at card size on a touch device
//   lights        a touch device lights the nearest rooms; a computer lights every room
//   reduced       with the real server: a touch device's pinned-photo cards come from the Mac's
//                 reduced pictures, the original is asked for only when a photo is opened whole,
//                 and a card is still drawn when no reduced picture can be had
//   limits        a scan over a touch device's size limit is not loaded and says so; a touch
//                 device draws fewer points; a computer has no such limits
//   idle          nothing is drawn while nothing changes
//
// Chromium always runs. WebKit runs as well when Playwright has it installed (E2E_TOOLS_WEBKIT=
// require | skip). A phone profile in a desktop browser engine checks behaviour: it says nothing
// about a real phone's speed or memory.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { dirname, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit, devices } from 'playwright';
import { writeGlb, boxGeometry } from './synthetic-model.mjs';

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
const textures = (page, body, arg) => page.evaluate(new Function('arg', 'return import("/js/textures.js").then(async t => { ' + body + ' })'), arg);
const property = (page, body) => page.evaluate(new Function('return import("/js/store.js").then(s => { const p = s.activeProperty(); ' + body + ' })'));
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

// What the page does that a check wants to count.
const PROBE = () => {
  localStorage.setItem('tiksi.onScreen.v1', '{"all":true,"model.objects":false}');   // MODEL's tools on the screen (tiksi-menu.js); the component list off it: this suite clicks and taps the model at fixed places
  const P = WebGL2RenderingContext.prototype;
  const probe = window.__probe = { draws: 0, failDraws: false, decodes: [], shapes: [], loading: 0, mostLoading: 0 };
  for (const name of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced', 'drawRangeElements']) {
    const real = P[name]; if (!real) continue;
    P[name] = function () { probe.draws++; return real.apply(this, arguments); };
  }
  // Every photograph the page decodes: its longest side, and how many were decoding at once.
  // (Thumbnails are data: URLs and are not counted.)
  const began = () => { probe.loading++; probe.mostLoading = Math.max(probe.mostLoading, probe.loading); };
  const src = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
  Object.defineProperty(HTMLImageElement.prototype, 'src', { get() { return src.get.call(this); }, set(v) {
    if (String(v).startsWith('blob:')) {
      began();
      const done = () => { probe.loading--; if (this.naturalWidth) probe.decodes.push(Math.max(this.naturalWidth, this.naturalHeight)); };
      this.addEventListener('load', done, { once: true }); this.addEventListener('error', done, { once: true });
    }
    src.set.call(this, v);
  } });
  const bitmap = window.createImageBitmap;
  window.createImageBitmap = async function (source) {
    const photo = source instanceof Blob && source.size > 20000;
    if (photo) began();
    try { const b = await bitmap.apply(this, arguments); if (photo) { probe.decodes.push(Math.max(b.width, b.height)); probe.shapes.push([b.width, b.height]); } return b; }
    finally { if (photo) probe.loading--; }
  };
};

// One house (6 x 4 m, one oak room) and what `options` adds:
//   shell      a 30,000-triangle box scan beside the house ('scan-shell')
//   note       a note pinned on the inside of the back wall
//   photos     that many 2400 x 1800 photos pinned along the back wall
//   rooms      that many 3 x 3 m rooms instead of the one, at night
//   compare    a before / after pair: 'scan-shell' hidden as before, 'scan-after' shown
//   big        a scan record that says it is 200 MB ('scan-big'; its real file is small)
//   cloud      a 4,000-point cloud ('scan-cloud')
//   bound      a small model whose one material is linked to the library's walnut ('scan-bound')
const seed = (page, quality, options = {}) => page.evaluate(async ([quality, options]) => {
  const s = await import('/js/store.js');
  const { writeGlb, boxGeometry } = await import('/tools/synthetic-model.mjs');
  s.ws.data = s.emptyWorkspace();
  (await import('/js/materials.js')).ensureBuiltinMaterials();
  const p = s.propertyTemplate('Tools check house'); p.id = 'prop-tools';
  const L = p.levels[0].id;
  p.env.quality = quality; p.env.date = '2024-06-21'; p.env.time = options.rooms ? 22.5 : 15.5;
  const box = (x0, y0, x1, y1, id) => {
    p.walls.push(...[[x0, y0, x1, y0], [x1, y0, x1, y1], [x1, y1, x0, y1], [x0, y1, x0, y0]].map(([ax, ay, bx, by], i) => ({ id: id + '-w' + i, level: L, ax, ay, bx, by, thickness: 0.15, material: 'mat-drywall' })));
    p.rooms.push({ id, level: L, name: id, pts: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], material: 'mat-oak' });
  };
  if (options.rooms) for (let i = 0; i < options.rooms; i++) box((i % 5) * 3, Math.floor(i / 5) * 3, (i % 5) * 3 + 3, Math.floor(i / 5) * 3 + 3, 'room-' + i);
  else box(0, 0, 6, 4, 'room');
  p.openings.push({ id: 'win-1', wallId: (options.rooms ? 'room-0' : 'room') + '-w0', type: 'window', t: 0.5, width: 1.2, height: 1.2, sill: 0.9 });
  const scan = (id, name, format, kind, visible, more) => p.scans.push({ id, name, format, kind, pos: [0, 0, 0], rot: [0, 0, 0], rotY: 0, scale: 1, visible, ...more });
  const glb = async (id, name, geometry, at, color, visible, more) => {
    const made = writeGlb({ looks: [{ name: 'Look of ' + name, color, roughness: 0.8 }], meshes: [{ geometry, look: 0 }], nodes: [{ name, mesh: 0, translation: at }] });
    await s.putFile(id, made.glb.buffer, { format: 'glb' });
    scan(id, name + '.glb', 'glb', 'mesh', visible, more);
  };
  if (options.shell || options.compare) await glb('scan-shell', 'Shell', boxGeometry(2, 2, 2, 50), [9, 1, 2], [0.7, 0.72, 0.75, 1], !options.compare);
  if (options.compare) { await glb('scan-after', 'After', boxGeometry(1, 1, 1), [-2, 0.5, 2], [0.2, 0.6, 0.3, 1], true); p.designComparison = { beforeId: 'scan-shell', afterId: 'scan-after', view: 'after' }; p.modelSourceId = undefined; delete p.modelSourceId; }
  if (options.big) await glb('scan-big', 'Big', boxGeometry(1, 3, 1), [-3, 1.5, 2], [0.8, 0.2, 0.2, 1], true, { bytes: 200 * 1024 * 1024 });
  if (options.bound) await glb('scan-bound', 'Bound', boxGeometry(1, 1, 1), [-2, 0.5, -2], [0.5, 0.5, 0.5, 1], true, { materialBindings: { 'm:Look of Bound': 'mat-walnut' } });
  if (options.cloud) {
    let rows = '';
    for (let i = 0; i < 4000; i++) rows += ((i % 40) * 0.05 + 2).toFixed(3) + ' ' + (Math.floor(i / 40) * 0.03).toFixed(3) + ' ' + (5 + (i % 7) * 0.01).toFixed(3) + '\n';
    await s.putFile('scan-cloud', new TextEncoder().encode(rows).buffer, { format: 'xyz' });
    scan('scan-cloud', 'Cloud.xyz', 'xyz', 'points', true, { pointSize: 0.03, pointColor: 'solid', budget: 2000000 });
  }
  if (options.note) p.notePins.push({ id: 'note-1', text: 'Check this corner', roomId: '', elementIds: [], createdAt: '2024-06-21T12:00:00.000Z', x: 5, y: 1.9, z: 0.09, nx: 0, ny: 0, nz: 1 });
  if (options.photos) {
    const canvas = document.createElement('canvas'); canvas.width = 2400; canvas.height = 1800;
    const ctx = canvas.getContext('2d');
    const photos = await import('/js/photos-store.js');
    for (let i = 0; i < options.photos; i++) {
      const g = ctx.createLinearGradient(0, 0, 2400, 1800); g.addColorStop(0, 'hsl(' + i * 50 + ' 60% 55%)'); g.addColorStop(1, '#223');
      ctx.fillStyle = g; ctx.fillRect(0, 0, 2400, 1800);
      for (let k = 0; k < 60; k++) { ctx.fillStyle = 'hsl(' + (k * 37 + i * 11) % 360 + ' 70% 50%)'; ctx.fillRect((k * 397) % 2300, (k * 211) % 1700, 90, 70); }
      let blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.9));
      // The second photo is stored on its side with a note to turn it a quarter turn (Exif
      // orientation 6), as a phone held upright stores one: shown, it is 1800 x 2400.
      if (i === 1) {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const exif = [0xFF, 0xE1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
        blob = new Blob([bytes.slice(0, 2), new Uint8Array(exif), bytes.slice(2)], { type: 'image/jpeg' });
      }
      const rec = await photos.addPhotoFromFile(p, new File([blob], 'Site ' + (i + 1) + '.jpg', { type: 'image/jpeg' }));
      // Along the inside of the back wall; the last one flat on the floor just behind the front
      // wall, face up toward the overview camera but hidden from it by that wall.
      rec.pin = i === options.photos - 1 ? { x: 3, y: 0.06, z: 2.9, nx: 0, ny: 1, nz: 0 } : { x: 0.6 + i * 0.9, y: 1.5, z: 0.09, nx: 0, ny: 0, nz: 1 };
    }
  }
  s.ws.data.properties.push(p); s.ws.data.settings.activePropertyId = p.id;
  s.touch();
}, [quality, options]);

async function openModel(page, quality, options, before) {
  await page.goto(url + '/#/plan');
  await page.locator('#btn-file').waitFor({ state: 'attached' });
  await seed(page, quality, options);
  if (before) await before(page);
  await page.evaluate(() => { window.__probe.decodes.length = 0; window.__probe.shapes.length = 0; window.__probe.mostLoading = 0; location.hash = '#/model'; });
  await page.locator('canvas.v-canvas').waitFor({ state: 'attached' });
  await settled(page, 'first open');
}
async function reopenModel(page, what) {
  await page.evaluate(() => { location.hash = '#/plan'; });
  await page.locator('canvas.v-canvas').waitFor({ state: 'detached' });
  await page.evaluate(() => { location.hash = '#/model'; });
  await page.locator('canvas.v-canvas').waitFor({ state: 'attached' });
  await settled(page, what);
}
// Wait until no frame has been drawn for a full second (settled, and no glide still fading out).
async function still(page, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    await settled(page, 'coming to rest');
    const a = await viewer(page, 'const f = v.frameState(); return f.fastFrames + f.fullFrames');
    await delay(1000);
    const b = await viewer(page, 'const f = v.frameState(); return f.fastFrames + f.fullFrames');
    if (a === b) return;
    assert.ok(Date.now() < end, 'MODEL kept drawing frames with nothing changing');
  }
}
async function frame(page) { await viewer(page, 'v.fieldAction("camera", "frame")'); await delay(1100); await settled(page, 'framing'); }
// Where a model point is on the page, and where the camera is.
const onScreen = (page, point) => page.evaluate(async point => {
  const THREE = await import('three'), v = await import('/js/viewer3d.js');
  const cam = v.drawStats().camera, r = document.querySelector('canvas.v-canvas').getBoundingClientRect();
  const q = new THREE.Vector4(...point, 1).applyMatrix4(new THREE.Matrix4().fromArray(cam.inverse)).applyMatrix4(new THREE.Matrix4().fromArray(cam.projection));
  return [r.left + (q.x / q.w + 1) / 2 * r.width, r.top + (1 - q.y / q.w) / 2 * r.height];
}, point);
const cameraAt = page => page.evaluate(async () => {
  const THREE = await import('three'), v = await import('/js/viewer3d.js');
  const m = new THREE.Matrix4().fromArray(v.drawStats().camera.inverse).invert();
  return [m.elements[12], m.elements[13], m.elements[14]];
});
const idleDraws = (page, ms = 2500) => page.evaluate(async ms => {
  const start = window.__probe.draws; let frames = 0, stop = false;
  const count = () => { frames++; if (!stop) requestAnimationFrame(count); };
  requestAnimationFrame(count);
  const began = performance.now();
  while (performance.now() - began < ms || (frames < 30 && performance.now() - began < 20000)) await new Promise(r => setTimeout(r, 100));
  stop = true;
  return { frames, draws: window.__probe.draws - start };
}, ms);
// Fingers on the view, as pointer events (two real fingers cannot be driven in every engine).
// The canvas's pointer capture is a no-op for these made-up pointer ids.
const fingers = (page, steps) => page.evaluate(async steps => {
  const c = document.querySelector('canvas.v-canvas');
  c.setPointerCapture = () => {}; c.releasePointerCapture = () => {};
  for (const [type, id, x, y] of steps) {
    c.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, cancelable: true, isPrimary: id === 1, button: 0, buttons: type === 'pointerup' ? 0 : 1 }));
    await new Promise(r => requestAnimationFrame(r));
  }
}, steps);

const { defaultBrowserType, ...iphone } = devices['iPhone 13'];
const MB = 1024 * 1024;

// ---------- the phone layout: marking up by tap, and fingers ----------
async function phoneChecks(browser, say) {
  const context = await browser.newContext({ ...iphone, serviceWorkers: 'block' });
  await context.addInitScript(PROBE);
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await openModel(page, 'low', { shell: true, note: true, photos: 5 });
  assert.ok(await page.evaluate(() => document.documentElement.classList.contains('phone')), 'the phone profile gets the phone layout');

  // Pinned photos: two at a time, decoded at the card's size, never the 2400-pixel original.
  const pins = await page.evaluate(() => ({ decodes: window.__probe.decodes.slice(), shapes: window.__probe.shapes.slice(), most: window.__probe.mostLoading }));
  assert.equal(pins.decodes.length, 5, 'each pinned photo gets its sharper picture (' + pins.decodes.join(', ') + ')');
  assert.ok(Math.max(...pins.decodes) <= 1024, 'no photo is decoded larger than its card on a touch device (largest ' + Math.max(...pins.decodes) + ' px)');
  assert.ok(pins.most <= 2, 'photos load two at a time (' + pins.most + ' at once)');
  // The photo stored on its side is decoded upright, as its card is shaped.
  const upright = pins.shapes.filter(([w, h]) => h > w);
  assert.deepEqual(upright, [[768, 1024]], 'the photo stored on its side is decoded turned upright (' + JSON.stringify(pins.shapes) + ')');
  say('pinned photos load two at a time at card size (largest ' + Math.max(...pins.decodes) + ' px), turned as stored');

  const panel = page.locator('#fd-panel'), banner = page.locator('.fd-task:not([hidden])'), bannerText = () => page.locator('.fd-task span').textContent();
  const openPanel = async () => { await page.locator('.fd-menu').tap(); await panel.locator('.fd-body').waitFor(); };
  const fromPanel = async selector => { await openPanel(); await panel.locator(selector).first().tap(); };

  // A tap acts on the nearest thing under the finger: a photo hidden behind a wall is not
  // opened through the wall, and a photo in plain sight is.
  await frame(page);
  assert.equal(await banner.count(), 0, 'no banner while no tool is on');
  const lightbox = page.locator('.v-lightbox');
  const [hx, hy] = await onScreen(page, [3, 0.06, 2.9]);    // the photo on the floor behind the front wall
  await page.touchscreen.tap(hx, hy);
  await delay(600);
  assert.equal(await lightbox.count(), 0, 'a tap on a wall does not open the photo hung behind it');
  const [vx, vy] = await onScreen(page, [0.6, 1.5, 0.09]);  // a photo on the back wall, in plain sight
  await page.touchscreen.tap(vx, vy);
  await lightbox.waitFor({ timeout: 10000 });
  await lightbox.locator('.v-lb-close').tap();
  await lightbox.waitFor({ state: 'detached' });

  // A tap on a note opens it.
  const [nx, ny] = await onScreen(page, [5, 1.9, 0.09]);   // the note on the back wall, in plain sight
  await page.touchscreen.tap(nx, ny);
  const editor = page.locator('.v-note-edit');
  await editor.waitFor({ timeout: 5000 });
  assert.equal(await editor.locator('textarea').inputValue(), 'Check this corner', 'a tap on a note opens it');
  await editor.locator('textarea').fill('Check this corner again');
  await editor.locator('[data-save]').click();
  assert.equal(await property(page, 'return p.notePins[0].text'), 'Check this corner again', 'and it can be edited there');

  // Measure, from the panel's own button.
  await fromPanel('[data-act="tool"][data-id="measure"]');
  await banner.waitFor({ timeout: 5000 });
  assert.match(await bannerText(), /Tap two points to measure/, 'the banner says what a tap does');
  assert.ok(await page.locator('#fd-panel').evaluate(el => el.inert), 'and the panel has closed so the model can be tapped');
  const [ax, ay] = await onScreen(page, [1.5, 0, 3]), [bx, by] = await onScreen(page, [4.5, 0, 3]);
  await page.touchscreen.tap(ax, ay);
  await waitUntil(async () => /second point/.test(await bannerText()), 'the banner asks for the second point');
  await page.touchscreen.tap(bx, by);
  await waitUntil(async () => (await viewer(page, 'return v.fieldState().measures')) === 1, 'two taps make a measurement');
  assert.equal(await page.locator('.v-mlabel').count(), 1, 'its length is shown');
  const clear = page.locator('.fd-task-clear');
  await waitUntil(async () => !(await clear.evaluate(el => el.hidden)), 'CLEAR appears once there is a measurement');
  await clear.tap();
  assert.equal(await viewer(page, 'return v.fieldState().measures'), 0, 'CLEAR removes it');
  await page.locator('.fd-task-done').tap();
  await waitUntil(async () => (await banner.count()) === 0, 'DONE takes the banner away');
  assert.equal(await viewer(page, 'return v.fieldState().tool'), 'select', 'and leaves the tool');

  // A note, from the panel's own button.
  await fromPanel('[data-capture="note"]');
  await banner.waitFor();
  assert.equal(await bannerText(), 'Tap where the note belongs.');
  const [px, py] = await onScreen(page, [4.5, 0, 1]);
  await page.touchscreen.tap(px, py);
  await editor.waitFor({ timeout: 5000 });
  await editor.locator('textarea').fill('Outlet goes here');
  await editor.locator('[data-save]').click();
  await waitUntil(async () => (await property(page, 'return p.notePins.length')) === 2, 'the tap pins a note');
  await waitUntil(async () => (await banner.count()) === 0, 'the banner goes when the note is pinned');
  // A tap on it offers DELETE, which asks first: saying no keeps the note, saying yes deletes it.
  const added = await property(page, 'return p.notePins[1]');
  const [dx, dy] = await onScreen(page, [added.x, added.y, added.z]);
  await settled(page, 'after the note');
  for (const [answer, left] of [['dismiss', 2], ['accept', 1]]) {
    await page.touchscreen.tap(dx, dy);
    await editor.waitFor({ timeout: 5000 });
    let asked = '';
    page.once('dialog', d => { asked = d.message(); d[answer](); });
    await editor.locator('[data-delete]').tap();
    await delay(400);
    assert.match(asked, /Delete this note/, 'deleting a note asks first');
    assert.equal(await property(page, 'return p.notePins.length'), left, answer === 'dismiss' ? 'answering no keeps the note' : 'answering yes deletes it');
    if (answer === 'dismiss') { await editor.locator('[data-cancel]').tap(); await editor.waitFor({ state: 'detached' }); }
  }

  // Pinning a photo from PHOTOS: the instruction and a way out are on the view.
  const photoId = await property(page, 'return p.photos[0].id');
  await page.evaluate(id => { location.hash = '#/model?pin=' + id; }, photoId);
  await banner.waitFor({ timeout: 10000 });
  assert.equal(await bannerText(), 'Tap where this photo was taken.', 'pin mode says what a tap does');
  await page.locator('.fd-task-done').tap();
  await waitUntil(async () => (await banner.count()) === 0, 'DONE leaves pin mode');

  // Saved views, with the panel's own buttons: save, open, rename, update, delete.
  await fromPanel('[data-act="save-view"]');
  await waitUntil(async () => (await viewer(page, 'return v.fieldState().views')).length === 1, 'the view is saved');
  const viewId = (await viewer(page, 'return v.fieldState().views'))[0].id;
  page.once('dialog', d => d.accept('Kitchen corner'));
  await panel.locator('[data-act="view-rename"]').tap();
  await waitUntil(async () => (await viewer(page, 'return v.fieldState().views'))[0].label === 'Kitchen corner', 'a saved view can be renamed from the panel');
  await panel.locator('.fd-close').tap();
  await viewer(page, 'v.fieldAction("camera", "front")'); await delay(900); await settled(page, 'front view');
  const savedBefore = await property(page, 'return JSON.stringify(p.savedViews[0].camera)');
  await fromPanel('[data-act="view-update"]');
  await waitUntil(async () => (await property(page, 'return JSON.stringify(p.savedViews[0].camera)')) !== savedBefore, 'updated to the camera it is looking through now');
  page.once('dialog', d => d.dismiss());
  await panel.locator('[data-act="view-delete"]').tap();
  await delay(300);
  assert.equal((await viewer(page, 'return v.fieldState().views')).length, 1, 'deleting a view asks first');
  page.once('dialog', d => d.accept());
  await panel.locator('[data-act="view-delete"]').tap();
  await waitUntil(async () => (await viewer(page, 'return v.fieldState().views')).length === 0, 'and deletes on yes');
  assert.equal(viewId.length > 0, true);
  await panel.locator('.fd-close').tap();
  say('measure, note, pin mode and saved views work from the panel\'s buttons; a hidden photo is not opened through a wall');

  // Top view: one finger pans.
  await viewer(page, 'v.fieldAction("mode", "top")'); await delay(1400); await settled(page, 'top view');
  const top0 = await cameraAt(page);
  const mid = page.viewportSize();
  const cx = mid.width / 2, cy = mid.height / 2;
  await fingers(page, [['pointerdown', 1, cx, cy], ['pointermove', 1, cx + 30, cy + 20], ['pointermove', 1, cx + 70, cy + 50], ['pointermove', 1, cx + 110, cy + 80], ['pointerup', 1, cx + 110, cy + 80]]);
  await delay(300); await settled(page, 'after the one-finger drag');
  const top1 = await cameraAt(page);
  assert.ok(Math.hypot(top1[0] - top0[0], top1[2] - top0[2]) > 0.3, 'one finger pans the Top view (moved ' + Math.hypot(top1[0] - top0[0], top1[2] - top0[2]).toFixed(2) + ' m)');
  assert.ok(Math.abs(top1[1] - top0[1]) < 0.05, 'without changing its height');

  // Orbit: a pinch over far ground travels toward it, past the old pivot at the house.
  await viewer(page, 'v.fieldAction("mode", "orbit")'); await frame(page);
  const p0 = await cameraAt(page);
  const fx = cx, fy = mid.height * 0.2;     // ground well behind the house, near the top of the view
  for (let g = 0; g < 4; g++) {
    await fingers(page, [['pointerdown', 1, fx - 12, fy], ['pointerdown', 2, fx + 12, fy], ['pointermove', 1, fx - 22, fy], ['pointermove', 2, fx + 22, fy], ['pointermove', 1, fx - 34, fy], ['pointermove', 2, fx + 34, fy], ['pointerup', 1, fx - 34, fy], ['pointerup', 2, fx + 34, fy]]);
    await delay(250);
  }
  await settled(page, 'after the pinches');
  const p1 = await cameraAt(page);
  const travelled = Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]), toHouse = Math.hypot(p0[0] - 3, p0[1] - 1, p0[2] - 2);
  assert.ok(travelled > toHouse + 3, 'a pinch travels to what is under the fingers, past the old pivot (' + travelled.toFixed(1) + ' m moved; the pivot was ' + toHouse.toFixed(1) + ' m away)');
  say('one finger pans in Top view; a pinch travels ' + travelled.toFixed(1) + ' m toward far ground (old pivot ' + toHouse.toFixed(1) + ' m away)');

  // The glide after a finger gesture (OrbitControls' damping) fades out over a second or two.
  await still(page);
  const idle = await idleDraws(page);
  assert.equal(idle.draws, 0, 'MODEL draws nothing while nothing changes (' + idle.draws + ' draw calls over ' + idle.frames + ' frames)');
  assert.deepEqual(errors, [], 'no uncaught page errors in the phone layout');
  await context.close();
}

// ---------- a touch device's limits: lights, scan size, points, before / after ----------
async function touchLimitChecks(browser, say) {
  const context = await browser.newContext({ ...iphone, serviceWorkers: 'block' });
  await context.addInitScript(PROBE);
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));

  // Lights: ten rooms at night, four of them lit, the camera's own first.
  await openModel(page, 'low', { rooms: 10 });
  let q = await viewer(page, 'return v.qualityState()');
  assert.equal(q.limits.roomLights, 4);
  assert.equal(q.roomLights, 4, 'a touch device lights four of the ten rooms');
  await viewer(page, 'v.fieldAction("mode", "walk")'); await delay(600); await settled(page, 'walking');
  const cam = await cameraAt(page);
  const standing = 'room-' + (Math.floor(cam[2] / 3) * 5 + Math.floor(cam[0] / 3));
  q = await viewer(page, 'return v.qualityState()');
  assert.ok(q.litRooms.includes(standing), 'the room the camera stands in is lit (' + standing + ' in ' + q.litRooms.join(', ') + ')');
  assert.equal(q.roomLights, 4, 'and the number of lights has not changed');
  // Walking in changed the fill light, not the sky: nothing was baked for it.
  const bakes = (await viewer(page, 'return v.frameState()')).skyBakes;
  await viewer(page, 'v.fieldAction("mode", "orbit")'); await delay(600); await settled(page, 'orbiting');
  await viewer(page, 'v.fieldAction("mode", "walk")'); await delay(600); await settled(page, 'walking again');
  assert.equal((await viewer(page, 'return v.frameState()')).skyBakes, bakes, 'walking in and out of a room bakes no sky lighting');
  say('four of ten rooms are lit, the camera\'s own among them; walking in and out bakes no sky lighting');

  // Scan limits.
  await openModel(page, 'low', { big: true, cloud: true, compare: true });
  let scans = await viewer(page, 'return v.scanStates()');
  assert.equal(scans['scan-big'].state, 'too-large', 'a scan over the device\'s size limit is not loaded');
  assert.equal(scans['scan-cloud'].state, 'ready');
  const st = await viewer(page, 'return v.fieldState()');
  assert.equal(st.tooLarge.length, 1);
  assert.match(st.tooLarge[0].detail, /too large for this device \(200 MB; it loads scans up to 150 MB\)/, 'and says so plainly');
  assert.match(await page.locator('.v-toast').innerText(), /Big\.glb is too large for this device/, 'on the view too');
  // Its line-up would be computed from less than a computer sees: it is refused.
  assert.equal(await viewer(page, 'return v.lineUpSource()'), null, 'a line-up is left to a device that loads every scan');
  // The panel lists it, with why, and a button that loads it anyway.
  const panel = page.locator('#fd-panel');
  await page.locator('.fd-menu').tap(); await panel.locator('.fd-body').waitFor();
  assert.match(await panel.locator('.fd-too-large').innerText(), /Big\.glb[\s\S]*too large for this device \(200 MB/, 'the panel says which scan was not loaded and why');
  await panel.locator('[data-act="load-scan"][data-id="scan-big"]').tap();
  await waitUntil(async () => (await viewer(page, 'return v.scanStates()'))['scan-big'].state === 'ready', 'LOAD ANYWAY loads it');
  // The same decisions, straight at the loader: over the limit once the bytes are known, and fewer points.
  const loader = await page.evaluate(async () => {
    const sc = await import('/js/scans.js'), s = await import('/js/store.js');
    const p = s.activeProperty(), cloud = p.scans.find(x => x.id === 'scan-cloud');
    let tooLarge = null;
    try { await sc.loadScanObject(cloud, { scanBytes: 1000 }); } catch (e) { tooLarge = { flag: !!e.tooLarge, text: e.message }; }
    const forced = await sc.loadScanObject(cloud, { scanBytes: 1000 }, null, true);
    const few = await sc.loadScanObject(cloud, { pointBudget: 1000 });
    const all = await sc.loadScanObject(cloud, { pointBudget: 0 });
    const out = { tooLarge, forced: sc.scanStats(forced).label, few: sc.scanStats(few), all: sc.scanStats(all).label };
    for (const o of [forced, few, all]) sc.disposeScanObject(o);
    return out;
  });
  assert.equal(loader.tooLarge && loader.tooLarge.flag, true, 'a scan found over the limit when its bytes arrive is not parsed');
  assert.match(loader.tooLarge.text, /too large for this device/);
  assert.match(loader.forced, /4,000 points/, 'unless it is loaded anyway');
  assert.match(loader.few.label, /1,000 of 4,000 points/, 'a device with a point limit draws that many');
  assert.equal(loader.few.reducedForDevice, true);
  assert.match(loader.all, /^4,000 points/, 'and one without draws them all');
  assert.equal((await viewer(page, 'return v.qualityState()')).limits.pointBudget, 500000);

  // Converting a model again stores a new file: its size is recorded, so a model that came out
  // under the limit is no longer turned away. (The converter is this Mac's; here it is stood in for.)
  const small = Buffer.from(writeGlb({ looks: [{ name: 'Small', color: [0.4, 0.4, 0.8, 1], roughness: 0.8 }], meshes: [{ geometry: boxGeometry(1, 1, 1), look: 0 }], nodes: [{ name: 'Small', mesh: 0, translation: [0, 0.5, 0] }] }).glb);
  await page.route('**/api/model-conversion/capabilities', route => route.fulfill({ json: { sketchup: true, token: 'check' } }));
  await page.route('**/api/model-conversion/convert', route => route.fulfill({ body: small, contentType: 'model/gltf-binary', headers: { 'X-Tiksi-Format': 'glb', 'X-Tiksi-Warnings': '[]', 'X-Tiksi-Job': 'job-check' } }));
  const reconverted = await page.evaluate(async () => {
    const s = await import('/js/store.js'), { convertAgain } = await import('/js/model-reconvert.js');
    const p = s.activeProperty(), scan = p.scans.find(x => x.id === 'scan-big');
    await s.putFile('source-big', new Uint8Array([1, 2, 3, 4]).buffer, { name: 'Big.skp', format: 'skp', kind: 'source' });
    scan.originalFileId = 'source-big';
    const before = scan.bytes;
    await convertAgain(p, scan, null);
    return { before, after: scan.bytes };
  });
  assert.equal(reconverted.before, 200 * MB);
  assert.equal(reconverted.after, small.byteLength, 'converting again records the new file\'s size (' + reconverted.after + ' bytes)');
  await reopenModel(page, 'after converting again');
  assert.equal((await viewer(page, 'return v.scanStates()'))['scan-big'].state, 'ready', 'so the smaller model loads on this device without being asked');
  assert.equal((await viewer(page, 'return v.fieldState().tooLarge')).length, 0);

  // Before / after from the panel's call.
  assert.deepEqual(st.compare, [{ id: 'before', label: 'Before', on: false }, { id: 'after', label: 'After', on: true }], 'the panel is told about the before / after pair');
  assert.equal(scans['scan-shell'].state, 'hidden');
  await page.locator('.fd-menu').tap(); await panel.locator('.fd-body').waitFor();
  await panel.locator('[data-act="compare"][data-id="before"]').tap();
  await waitUntil(async () => (await viewer(page, 'return v.scanStates()'))['scan-shell'].state === 'ready', 'Before, in the panel, shows (and loads) the before model');
  assert.deepEqual(await property(page, 'return [p.designComparison.view, p.scans.find(x => x.id === "scan-shell").visible, p.scans.find(x => x.id === "scan-after").visible]'), ['before', true, false]);
  say('a scan over the size limit is not loaded and says so; fewer points; before / after from the panel');

  assert.deepEqual(errors, [], 'no uncaught page errors on the touch device');
  await context.close();
}

// ---------- a computer ----------
async function computerChecks(browser, say) {
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 800 } });
  await context.addInitScript(PROBE);
  const desk = await context.newPage();
  const errors = [], requested = [];
  desk.on('pageerror', e => errors.push(e.message));
  desk.on('request', r => requested.push(new URL(r.url()).pathname));
  await desk.goto(url + '/#/plan');
  await desk.locator('#btn-file').waitFor({ state: 'attached' });
  await delay(500);
  assert.deepEqual(requested.filter(u => /pick-(index|tree)\.js/.test(u)), [], 'the picking files are not part of the first load');
  await openModel(desk, 'low', { shell: true, photos: 5, big: true, cloud: true });
  assert.ok(requested.some(u => /pick-index\.js/.test(u)) && requested.some(u => /pick-tree\.js/.test(u)), 'they are fetched when a scan of 20,000 triangles is shown');

  // Unchanged for a computer: the original photographs, every scan whatever its size, every point.
  const pins = await desk.evaluate(() => ({ decodes: window.__probe.decodes.slice(), most: window.__probe.mostLoading }));
  assert.deepEqual(pins.decodes, [2400, 2400, 2400, 2400, 2400], 'a computer draws its cards from the original photographs, as before');
  assert.ok(pins.most <= 2, 'two at a time (' + pins.most + ' at once)');
  let scans = await viewer(desk, 'return v.scanStates()');
  assert.equal(scans['scan-big'].state, 'ready', 'a computer has no scan size limit');
  assert.match(scans['scan-cloud'].label, /^4,000 points/);
  let q = await viewer(desk, 'return v.qualityState()');
  assert.deepEqual({ lights: q.limits.roomLights, points: q.limits.pointBudget, bytes: q.limits.scanBytes }, { lights: 0, points: 0, bytes: 0 }, 'and no light, point or size limits');

  // Leaving MODEL removes the navigation's listeners: after four visits one wheel step still
  // looks under the pointer once.
  for (let i = 0; i < 3; i++) await reopenModel(desk, 'visit ' + (i + 2));
  await frame(desk);
  const [hx, hy] = await onScreen(desk, [3, 0, 2]);
  await desk.mouse.move(hx, hy);
  await desk.evaluate(async () => {
    const THREE = await import('three');
    window.__rays = 0;
    const real = THREE.Raycaster.prototype.intersectObjects;
    THREE.Raycaster.prototype.intersectObjects = function () { window.__rays++; return real.apply(this, arguments); };
    window.__stopRays = () => { THREE.Raycaster.prototype.intersectObjects = real; };
  });
  await desk.mouse.wheel(0, -120);
  await delay(400);
  const rays = await desk.evaluate(() => { window.__stopRays(); return window.__rays; });
  assert.equal(rays, 1, 'one wheel step looks under the pointer once after four visits (' + rays + ')');
  say('four visits leave no listeners behind');
  await settled(desk, 'after the wheel step');

  // A click on a large scan goes through the pick index and selects the scan.
  await desk.locator('#side [data-scan="scan-shell"]').click();
  await desk.locator('.inspector [data-frame]').click();
  await delay(1100); await settled(desk, 'the scan framed');
  await desk.keyboard.press('Escape');
  await waitUntil(async () => !/Shell\.glb/.test(await desk.locator('.inspector').innerText()), 'nothing is selected');
  const [sx, sy] = await onScreen(desk, [9, 2, 2]);       // the top of the scan
  await desk.evaluate(async () => {
    const THREE = await import('three');
    window.__plainTests = 0;
    const real = THREE.Mesh.prototype.raycast;
    // three's own triangle-by-triangle test, counted for meshes of 20,000 triangles and more.
    const triangles = g => { const pos = g && g.getAttribute && g.getAttribute('position'); return pos ? (g.index ? g.index.count : pos.count) / 3 : 0; };
    THREE.Mesh.prototype.raycast = function () { if (triangles(this.geometry) >= 20000) window.__plainTests++; return real.apply(this, arguments); };
    window.__stopPlain = () => { THREE.Mesh.prototype.raycast = real; };
  });
  await desk.mouse.click(sx, sy);
  await waitUntil(async () => /Shell\.glb/.test(await desk.locator('.inspector').innerText()), 'a click on the scan selects it');
  assert.equal(await desk.evaluate(() => { window.__stopPlain(); return window.__plainTests; }), 0, 'the 30,000-triangle scan is tested through its index, not triangle by triangle');
  const trees = (await viewer(desk, 'return v.qualityState()')).pickTrees;
  assert.ok(trees && trees.helper >= 1 && trees.page === 0, 'its tree was built by the background helper, not by the page (' + JSON.stringify(trees) + ')');
  await desk.keyboard.press('Escape');
  say('a click on a large scan goes through the pick index');

  // The sky lighting is baked again when the sky changes, and only then.
  const bakes = (await viewer(desk, 'return v.frameState()')).skyBakes;
  await viewer(desk, 'v.fieldAction("mode", "walk")'); await delay(600); await settled(desk, 'walking');
  await viewer(desk, 'v.fieldAction("mode", "orbit")'); await delay(600); await settled(desk, 'orbiting');
  assert.equal((await viewer(desk, 'return v.frameState()')).skyBakes, bakes, 'walking into a room and out bakes no sky lighting');
  await desk.evaluate(async () => {
    const v = await import('/js/viewer3d.js');
    const host = document.createElement('div'); document.body.append(host);
    v.mountEnvironmentSettings(host);
    const time = host.querySelector('[data-env=time]');
    time.value = '9.5'; time.dispatchEvent(new Event('input', { bubbles: true })); time.dispatchEvent(new Event('change', { bubbles: true }));
    host.remove();
  });
  await delay(400); await settled(desk, 'after the time of day changed');
  assert.ok((await viewer(desk, 'return v.frameState()')).skyBakes > bakes, 'a new time of day does');
  say('the sky lighting is baked only when the sky changes');

  const idle = await idleDraws(desk);
  assert.equal(idle.draws, 0, 'a computer draws nothing while idle (' + idle.draws + ' draw calls over ' + idle.frames + ' frames)');
  assert.deepEqual(errors, [], 'no uncaught page errors on the computer');
  await context.close();
}

// ---------- texture sets: the helper, the page, and a model that waits ----------
async function textureChecks(browser, say) {
  // A fingerprint of every pixel of the oak floor's and the drywall's three maps.
  const fingerprints = page => page.evaluate(async () => {
    const t = await import('/js/textures.js'), s = await import('/js/store.js');
    const hash = data => { let h = 2166136261; for (let i = 0; i < data.length; i++) h = Math.imul(h ^ data[i], 16777619); return (h >>> 0).toString(16) + ':' + data.length; };
    return ['mat-oak', 'mat-drywall'].map(id => { const m = t.materialFor(s.materialById(id)); return [id, hash(m.map.image.data), hash(m.normalMap.image.data), hash(m.roughnessMap.image.data)].join(' '); });
  });
  const shot = async (withHelper) => {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 900, height: 600 } });
    await context.addInitScript(PROBE);
    if (!withHelper) await context.addInitScript(() => { window.Worker = undefined; });
    const page = await context.newPage();
    const errors = [], requested = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', r => requested.push(new URL(r.url()).pathname));
    await openModel(page, 'high', {});
    const stats = await textures(page, 'return t.textureStats()');
    return { context, page, stats, prints: await fingerprints(page), errors, requested };
  };
  const helped = await shot(true);
  assert.ok(helped.stats.length >= 2 && helped.stats.every(s => s.status === 'ready'));
  const helperMs = helped.stats.reduce((n, s) => n + s.workerMs, 0), pageMs = helped.stats.reduce((n, s) => n + s.cpuMs, 0);
  assert.ok(helped.stats.every(s => s.workerMs > 0), 'every set was made by the background helper');
  assert.ok(pageMs < helperMs / 3, 'the page itself spent little on them (' + pageMs + ' ms against ' + helperMs + ' ms in the helper)');
  // The helper's pixels are the pixels the page would have made.
  const same = await helped.page.evaluate(async () => {
    const t = await import('/js/textures.js'), synth = await import('/js/texture-synth.js'), s = await import('/js/store.js');
    const record = s.materialById('mat-oak');
    const material = t.materialFor(record);
    const res = material.map.image.width;
    const run = synth.synthesize({ id: record.id, name: record.name, pattern: record.pattern, color: record.color, accent: record.accent, tile: synth.tileOf(record), roughness: record.roughness, metalness: record.metalness, normalScale: record.normalScale, photoId: record.photoId }, res);
    let step = run.next(); while (!step.done) step = run.next();
    const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
    return { res, colour: eq(material.map.image.data, step.value.col), normal: eq(material.normalMap.image.data, step.value.nrm), rough: eq(material.roughnessMap.image.data, step.value.orm) };
  });
  assert.deepEqual({ colour: same.colour, normal: same.normal, rough: same.rough }, { colour: true, normal: true, rough: true }, 'the helper\'s ' + same.res + '-pixel oak is byte for byte the page\'s');

  // A model linked to a library material waits for that set only, not for every set being made.
  const waited = await helped.page.evaluate(async () => {
    const t = await import('/js/textures.js'), mm = await import('/js/model-materials.js'), s = await import('/js/store.js'), THREE = await import('three');
    for (let i = 0; i < 14; i++) t.materialFor({ id: 'mat-slow-' + i, name: 'Slow ' + i, pattern: 'stone', color: '#' + (0x707070 + i * 0x030201).toString(16), tile: [1, 1], roughness: 0.9, metalness: 0 });
    const root = new THREE.Group();
    const own = new THREE.MeshStandardMaterial({ name: 'Trim' });
    root.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), own));
    const scan = { id: 'scan-waits', name: 'Waits.glb', materialBindings: { 'm:Trim': 'mat-walnut' } };
    const before = t.pendingTextureJobs();
    await mm.applyModelMaterials(scan, root);
    const others = t.pendingTextureJobs();
    const mesh = root.children[0];
    const end = Date.now() + 180000;
    while (t.pendingTextureJobs() > 0 && Date.now() < end) await new Promise(r => setTimeout(r, 100));
    return { before, others, textured: !!mesh.material.map, replaced: mesh.material !== own };
  });
  assert.ok(waited.replaced && waited.textured, 'the model is shown in its library material, textures and all');
  assert.ok(waited.others >= 8, 'while ' + waited.others + ' of ' + waited.before + ' other sets were still being made');
  // Dropping every material (a workspace replaced) tells whoever was waiting for a set at once.
  const cancelled = await helped.page.evaluate(async () => {
    const t = await import('/js/textures.js');
    const record = { id: 'mat-dropped', name: 'Dropped', pattern: 'marble', color: '#d0c8c0', tile: [1, 1], roughness: 0.4, metalness: 0 };
    const began = performance.now();
    const told = new Promise(done => t.whenMaterialReady(record, () => done(performance.now() - began)));
    t.disposeMaterials();
    return Promise.race([told, new Promise(done => setTimeout(() => done(null), 5000))]);
  });
  assert.ok(cancelled !== null && cancelled < 1000, 'a waiter is told when its texture set is cancelled (' + (cancelled === null ? 'never told' : Math.round(cancelled) + ' ms') + ')');
  assert.deepEqual(helped.errors, []);
  // With no large scan on the property, the picking files were never fetched.
  assert.deepEqual(helped.requested.filter(u => /pick-(index|tree)\.js/.test(u)), [], 'a property without a large scan fetches no picking files');

  // No helper: the page makes the sets itself, with the same pixels.
  const alone = await shot(false);
  assert.ok(alone.stats.every(s => s.status === 'ready' && s.workerMs === 0 && s.cpuMs > 0), 'without a helper the page makes the sets itself');
  assert.deepEqual(alone.prints, helped.prints, 'and every pixel of the floor\'s and the walls\' maps is the same either way');
  assert.deepEqual(alone.errors, []);
  await helped.context.close(); await alone.context.close();
  say('texture sets come from the helper (' + helperMs + ' ms there, ' + pageMs + ' ms in the page), byte for byte the page\'s; a model waits only for its own');
}

// ---------- room lights on a computer ----------
async function computerLightChecks(browser, say) {
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1000, height: 700 } });
  await context.addInitScript(PROBE);
  const page = await context.newPage();
  await openModel(page, 'low', { rooms: 10 });
  const q = await viewer(page, 'return v.qualityState()');
  assert.equal(q.roomLights, 10, 'a computer lights every room, as before');
  assert.equal(q.litRooms.length, 10);
  await context.close();
  say('a computer lights all ten rooms');
}

// ---------- the picking files: a fetch that fails is tried again on the next click ----------
async function pickRetryChecks(browser, say) {
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 800 } });
  await context.addInitScript(PROBE);
  const page = await context.newPage();
  const asked = [];
  page.on('request', r => { if (/pick-index\.js/.test(r.url())) asked.push(new URL(r.url()).search || 'first'); });
  await page.route('**/js/pick-index.js', route => route.abort());      // the first fetch is cut off
  await openModel(page, 'low', { shell: true });
  await waitUntil(() => asked.length === 1, 'the picking files are asked for when the large scan loads');
  await delay(300);
  assert.equal((await viewer(page, 'return v.qualityState()')).pickTrees, null, 'the cut-off fetch left the scan with the plain test');
  // Any click tries again.
  const size = page.viewportSize();
  await page.mouse.click(size.width * 0.4, size.height * 0.5);
  await waitUntil(() => asked.length === 2, 'the next click asks for the picking files again');
  await waitUntil(async () => { const t = (await viewer(page, 'return v.qualityState()')).pickTrees; return !!t && t.helper >= 1; }, 'and the scan gets its tree from the helper');
  assert.deepEqual(asked, ['first', '?again']);
  await context.close();
  say('a failed fetch of the picking files is tried again on the next click');
}

// ---------- with the real server: reduced pictures for a touch device's cards ----------
async function reducedChecks(browser, say) {
  if (process.platform !== 'darwin') { say('reduced pictures: skipped (the Mac\'s image tool makes them)'); return; }
  const state = await mkdtemp(tmpdir() + '/tiksi-model-tools-test-');
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  // TIKSI_LOG_READS=1: the server logs what it was asked to read, which is what this checks.
  const child = spawn('python3', ['tools/serve.py', '--port', String(port), '--state-dir', state], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TIKSI_LOG_READS: '1' } });
  const log = [];
  for (const stream of [child.stdout, child.stderr]) stream.on('data', d => log.push(...String(d).split('\n')));
  const mac = 'http://127.0.0.1:' + port;
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(mac)).ok) break; } catch {} await delay(50); }
    const context = await browser.newContext({ ...iphone, serviceWorkers: 'block' });
    await context.addInitScript(PROBE);
    const saved = async page => { await page.locator('#save-status').waitFor({ state: 'attached' }); await page.waitForFunction(() => document.querySelector('#save-status')?.textContent === 'SAVED TO DISK', null, { timeout: 120000 }); };
    // A house with three photos pinned on its back wall, the second stored on its side, saved to the Mac.
    const first = await context.newPage();
    await first.goto(mac + '/#/plan');
    await saved(first);
    await first.evaluate(async () => {
      const s = await import('/js/store.js'), photos = await import('/js/photos-store.js');
      (await import('/js/materials.js')).ensureBuiltinMaterials();
      const p = s.propertyTemplate('Reduced pictures house'); p.id = 'prop-reduced';
      const L = p.levels[0].id;
      p.env.date = '2024-06-21'; p.env.time = 15.5;
      p.walls.push(...[[0, 0, 6, 0], [6, 0, 6, 4], [6, 4, 0, 4], [0, 4, 0, 0]].map(([ax, ay, bx, by], i) => ({ id: 'wall-' + i, level: L, ax, ay, bx, by, thickness: 0.15, material: 'mat-drywall' })));
      p.rooms.push({ id: 'room', level: L, name: 'Room', pts: [[0, 0], [6, 0], [6, 4], [0, 4]], material: 'mat-oak' });
      const canvas = document.createElement('canvas'); canvas.width = 2400; canvas.height = 1800;
      const ctx = canvas.getContext('2d');
      for (let i = 0; i < 3; i++) {
        const g = ctx.createLinearGradient(0, 0, 2400, 1800); g.addColorStop(0, 'hsl(' + i * 90 + ' 60% 55%)'); g.addColorStop(1, '#223');
        ctx.fillStyle = g; ctx.fillRect(0, 0, 2400, 1800);
        for (let k = 0; k < 60; k++) { ctx.fillStyle = 'hsl(' + (k * 37 + i * 11) % 360 + ' 70% 50%)'; ctx.fillRect((k * 397) % 2300, (k * 211) % 1700, 90, 70); }
        let blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.9));
        if (i === 1) {
          const bytes = new Uint8Array(await blob.arrayBuffer());
          const exif = [0xFF, 0xE1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
          blob = new Blob([bytes.slice(0, 2), new Uint8Array(exif), bytes.slice(2)], { type: 'image/jpeg' });
        }
        const rec = await photos.addPhotoFromFile(p, new File([blob], 'Site ' + (i + 1) + '.jpg', { type: 'image/jpeg' }));
        rec.pin = { x: 1 + i * 1.6, y: 1.5, z: 0.09, nx: 0, ny: 0, nz: 1 };
      }
      s.ws.data.properties.push(p); s.ws.data.settings.activePropertyId = p.id; s.touch();
      await (await import('/js/disk-workspace.js')).diskWorkspace.sync();
    });
    await saved(first);
    await first.close();

    // A fresh page on the same phone: nothing of the photos is in its memory. Before MODEL
    // opens, the project files get the reduced-picture reader if they do not have it yet (the
    // function this needs in js/disk-workspace.js, stood in for here with the same requests).
    const open = async (reader, from = context) => {
      const page = await from.newPage();
      await page.goto(mac + '/#/plan');
      await saved(page);
      const hashes = await page.evaluate(async reader => {
        const dw = await import('/js/disk-workspace.js'), s = await import('/js/store.js');
        const cap = await (await fetch('/api/workspace/capabilities', { headers: { 'X-Tiksi-Workspace': '1' } })).json();
        const headers = { 'X-Tiksi-Workspace': '1', 'X-Tiksi-Token': cap.token };
        const assets = (await (await fetch('/api/workspace', { headers })).json()).assets;
        if (reader === 'refuses') dw.diskWorkspace.smallerPicture = async () => { throw new Error('No smaller copy of this file'); };
        else if (typeof dw.diskWorkspace.smallerPicture !== 'function') dw.diskWorkspace.smallerPicture = async (id, longest) => {
          const asset = assets[id];
          if (!asset) return null;
          const r = await fetch('/api/workspace/blobs/' + asset.hash + '?size=' + longest, { headers });
          return r.ok ? { buffer: await r.arrayBuffer(), mime: r.headers.get('Content-Type'), smaller: r.headers.get('X-Tiksi-Preview') === 'smaller' } : null;
        };
        return s.activeProperty().photos.map(ph => assets[ph.id].hash);
      }, reader);
      log.length = 0;
      await page.evaluate(() => { window.__probe.decodes.length = 0; window.__probe.shapes.length = 0; location.hash = '#/model'; });
      await page.locator('canvas.v-canvas').waitFor({ state: 'attached' });
      await settled(page, 'MODEL on the Mac\'s files');
      await waitUntil(() => page.evaluate(() => window.__probe.decodes.length >= 3), 'each pinned photo gets its picture');
      return { page, hashes };
    };
    const reads = (hashes, sized) => hashes.map(h => log.filter(line => line.includes('"GET /api/workspace/blobs/' + h + (sized ? '?size=1024 ' : ' '))).length);

    const { page, hashes } = await open('mac');
    assert.deepEqual(reads(hashes, true), [1, 1, 1], 'the Mac was asked for each pinned photo\'s reduced picture');
    assert.deepEqual(reads(hashes, false), [0, 0, 0], 'and for no original');
    const shapes = await page.evaluate(() => window.__probe.shapes.slice());
    assert.deepEqual(shapes.map(([w, h]) => Math.max(w, h)), [1024, 1024, 1024], 'each card\'s picture is 1024 pixels on its long side');
    assert.deepEqual(shapes.filter(([w, h]) => h > w), [[768, 1024]], 'the photo stored on its side comes back upright (' + JSON.stringify(shapes) + ')');
    // Opening a photo whole is when its original is fetched.
    await frame(page);
    const [px, py] = await onScreen(page, [1, 1.5, 0.09]);
    await page.touchscreen.tap(px, py);
    await page.locator('.v-lightbox img').waitFor({ timeout: 15000 });
    await waitUntil(() => reads(hashes, false)[0] === 1, 'the original is fetched when the photo is opened whole');
    assert.deepEqual(reads(hashes, false), [1, 0, 0], 'and only that one');
    await page.close();

    // No reduced picture to be had: the cards are still drawn, from the originals, as before.
    // (Another phone: this one's browser now keeps the original it opened.)
    const other = await browser.newContext({ ...iphone, serviceWorkers: 'block' });
    await other.addInitScript(PROBE);
    const fallback = await open('refuses', other);
    assert.deepEqual(reads(fallback.hashes, false), [1, 1, 1], 'with no reduced picture each card falls back to its original');
    const drawn = await fallback.page.evaluate(() => window.__probe.shapes.slice());
    assert.equal(drawn.length, 3, 'and all three cards get their picture');
    assert.ok(drawn.every(([w, h]) => Math.max(w, h) === 1024), 'decoded at card size (' + JSON.stringify(drawn) + ')');
    await other.close();
    await context.close();
    say('cards come from the Mac\'s reduced pictures; the original only when a photo is opened; a fallback when there is none');
  } finally {
    child.kill('SIGTERM');
    await rm(state, { recursive: true, force: true });
  }
}

async function allChecks(browser, engine) {
  const say = text => console.log('  ' + engine + ': ' + text);
  const only = process.env.E2E_TOOLS_ONLY;   // one part, for working on this file
  const parts = { phone: phoneChecks, limits: touchLimitChecks, computer: computerChecks, textures: textureChecks, lights: computerLightChecks, retry: pickRetryChecks, reduced: reducedChecks };
  for (const [name, part] of Object.entries(parts)) if (!only || only === name) await part(browser, say);
}

const wantWebkit = process.env.E2E_TOOLS_WEBKIT || 'auto';
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
  console.log('MODEL tools: phone mark-up, fingers, picking, lights, repeated work, textures, pins and scan limits passed.');
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  await new Promise(r => server.close(r));
}
process.exit(failed ? 1 : 0);
