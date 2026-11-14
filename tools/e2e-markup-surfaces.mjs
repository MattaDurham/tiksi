// Markup ink on the model's surfaces, in a real browser on a synthetic room: a pen stroke across
// a wall is kept as points on that wall, shows from another camera at the same place on the
// wall, joins the open markup from there, and is rubbed out where it is seen; the LINE tool
// starts on a face, snaps to the blue and green axes, takes a typed length, closes on its first
// point and snaps to the lines already drawn, parallel and perpendicular; a markup's picture
// still comes out.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { readFile } from 'node:fs/promises';
import { dirname, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = createServer(async (req, res) => {
  const path = resolve(root, '.' + decodeURIComponent(req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0]));
  if (!path.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  try { const bytes = await readFile(path); res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.wasm': 'application/wasm' })[extname(path)] || 'application/octet-stream'); res.end(bytes); }
  catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(Number(process.env.E2E_APP_PORT) || 0, 'localhost', r));
const url = `http://localhost:${server.address().port}`;
const browser = await chromium.launch({ headless: true });

async function waitUntil(predicate, message, timeoutMs = 15_000) {
  const deadline = performance.now() + timeoutMs;
  while (!(await predicate())) {
    assert.ok(performance.now() < deadline, 'Timed out: ' + message);
    await delay(60);
  }
}
const markups = page => page.evaluate(async () => JSON.parse(JSON.stringify((await import('/js/store.js')).activeProperty().markups)));
const state = page => page.evaluate(async () => (await import('/js/viewer3d.js')).markupState());
const idle = page => waitUntil(() => page.evaluate(async () => (await import('/js/viewer3d.js')).viewerIdle()), 'the view settles', 30_000);
const sameCam = (a, b) => a.position.concat(a.target).every((v, i) => Math.abs(v - b.position.concat(b.target)[i]) < 1e-3);
// Where a point of the model is on the page, for a camera { position, target, fov } (vertical
// degrees) over the canvas `box`.
function onScreen(cam, box, p) {
  const sub = (a, b) => a.map((v, i) => v - b[i]), dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
  const unit = a => { const l = Math.hypot(...a); return a.map(v => v / l); };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const f = unit(sub(cam.target, cam.position)), r = unit(cross(f, [0, 1, 0])), u = cross(r, f);
  const v = sub(p, cam.position), k = box.height / 2 / Math.tan(cam.fov * Math.PI / 360);
  return [box.x + box.width / 2 + dot(v, r) / dot(v, f) * k, box.y + box.height / 2 - dot(v, u) / dot(v, f) * k];
}
// How red the page is around a point (the pen's colour is #e5372b): the reddest pixel of a
// small square, as red minus the larger of green and blue.
async function redness(page, x, y, r = 4) {
  const png = await page.screenshot({ clip: { x: x - r, y: y - r, width: 2 * r + 1, height: 2 * r + 1 } });
  return page.evaluate(async b64 => {
    const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let best = -255;
    for (let i = 0; i < d.length; i += 4) best = Math.max(best, d[i] - Math.max(d[i + 1], d[i + 2]));
    return best;
  }, png.toString('base64'));
}

try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  await page.addInitScript(() => localStorage.setItem('tiksi.onScreen.v1', '{"all":true}'));
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(url + '/#/budget'); await page.locator('#cap-input').waitFor();   // seed before MODEL mounts
  // A 6 m by 4 m kitchen. The west wall's room side is the plane x = 0.057 (half its thickness).
  // Two saved views: straight at the west wall, and across the room at it from a corner.
  const WALL_X = 0.057;
  await page.evaluate(async () => {
    const store = await import('/js/store.js');
    store.ws.data = store.emptyWorkspace();
    store.ws.data.settings.units = 'metric';
    const p = store.propertyTemplate('Surface check'); p.id = 'prop-surface'; const L = p.levels[0].id;
    const wall = (id, ax, ay, bx, by) => ({ id, level: L, ax, ay, bx, by, thickness: 0.114, height: null, material: 'mat-drywall' });
    p.walls.push(wall('w-s', 0, 0, 6, 0), wall('w-e', 6, 0, 6, 4), wall('w-n', 6, 4, 0, 4), wall('w-w', 0, 4, 0, 0));
    p.rooms.push({ id: 'r-k', level: L, name: 'Kitchen', pts: [[0, 0], [6, 0], [6, 4], [0, 4]], material: 'mat-oak', ceilingMaterial: null });
    const view = (id, position, target) => ({ id, name: id, camera: { position, target, fov: 50 }, mode: 'orbit', section: { on: false, height: 1.2 }, xray: false, hiddenLevels: [], tags: {} });
    p.savedViews = [view('v-west', [4.5, 1.3, 2], [0, 1.3, 2]), view('v-corner', [4.5, 1.6, 3.6], [0, 1.1, 1.4])];
    store.ws.data.properties.push(p); store.ws.data.settings.activePropertyId = p.id;
  });
  await page.locator('#rail a[data-view="model"]').click({ noWaitAfter: true });
  await page.locator('canvas.v-canvas').first().waitFor();
  const go = async id => {
    await page.evaluate(async id => (await import('/js/viewer3d.js')).fieldAction('view', id), id);
    await delay(900);   // the camera flight
    await idle(page);
  };
  await go('v-west');
  const box = await page.locator('canvas.v-canvas').boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.locator('#side [data-act=markup]').click();
  await page.locator('.mk-bar').waitFor();
  assert.equal((await state(page)).place, 'surface');
  const camWest = (await state(page)).camera;

  // ---------- a pen stroke across the wall ----------
  await page.mouse.move(cx - 200, cy);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) await page.mouse.move(cx - 200 + i * 20, cy + Math.sin(i / 2) * 8);
  const t0 = performance.now();
  await page.mouse.up();
  const commitMs = performance.now() - t0;
  let list = await markups(page);
  assert.equal(list.length, 1);
  const ink = list[0].strokes[0];
  assert.equal(ink.tool, 'pen');
  assert.deepEqual(ink.pts, [], 'nothing flat on the screen');
  assert.ok(ink.w.length >= 6 && ink.w.length % 3 === 0, 'points in the model');
  const xs = ink.w.filter((_, i) => i % 3 === 0), ys = ink.w.filter((_, i) => i % 3 === 1), zs = ink.w.filter((_, i) => i % 3 === 2);
  assert.ok(xs.every(x => Math.abs(x - (WALL_X + 0.004)) < 0.0015), 'every point is 4 mm off the wall\'s face: ' + xs);
  assert.ok(ys.every(y => Math.abs(y - 1.3) < 0.15), 'at the height it was drawn: ' + ys);
  assert.ok(Math.max(...zs) - Math.min(...zs) > 1.5, 'across the wall: ' + Math.min(...zs) + ' to ' + Math.max(...zs));
  assert.ok(ink.width > 0.01 && ink.width < 0.04, 'its width is in metres: ' + ink.width);
  assert.ok(ink.on.length >= 4 && ink.on.every(h => h.k === 'wall' && h.id === 'w-w'), 'drawn on the west wall: ' + JSON.stringify(ink.on));
  assert.ok(sameCam(camWest, (await state(page)).camera), 'drawing does not move the camera');
  console.log(`  a 400 px stroke was read from the model in ${commitMs.toFixed(0)} ms`);
  await delay(200);
  const mid = [ink.w[Math.floor(xs.length / 2) * 3], ink.w[Math.floor(xs.length / 2) * 3 + 1], ink.w[Math.floor(xs.length / 2) * 3 + 2]];
  assert.ok(await redness(page, ...onScreen(camWest, box, mid)) > 80, 'the ink shows on the wall');

  // ---------- from another camera ----------
  await go('v-corner');
  const camCorner = (await state(page)).camera;
  assert.ok(!sameCam(camWest, camCorner));
  assert.equal(await page.locator('.mk-chip').isVisible(), false, 'no way back is needed: the ink is on the wall');
  const there = onScreen(camCorner, box, mid);
  assert.ok(await redness(page, ...there) > 80, 'the ink shows at the same place on the wall from here: ' + there);
  // A stroke from here joins the same markup.
  const lo = onScreen(camCorner, box, [WALL_X, 0.6, 1.2]), lo2 = onScreen(camCorner, box, [WALL_X, 0.6, 2.8]);
  await page.mouse.move(...lo); await page.mouse.down(); await page.mouse.move((lo[0] + lo2[0]) / 2, (lo[1] + lo2[1]) / 2, { steps: 6 }); await page.mouse.move(...lo2, { steps: 6 }); await page.mouse.up();
  list = await markups(page);
  assert.deepEqual(list.map(m => m.strokes.length), [2], 'one markup, two strokes');
  const low = list[0].strokes[1];
  assert.ok(low.w.filter((_, i) => i % 3 === 0).every(x => Math.abs(x - (WALL_X + 0.004)) < 0.002), 'also on the wall');
  assert.ok(low.w.filter((_, i) => i % 3 === 1).every(y => Math.abs(y - 0.6) < 0.08), 'at 0.6 m: ' + low.w.filter((_, i) => i % 3 === 1));

  // The eraser rubs out the first stroke where it is seen from here; undo brings it back.
  await page.keyboard.press('e');
  await page.mouse.move(there[0], there[1] - 30); await page.mouse.down(); await page.mouse.move(there[0], there[1] + 30, { steps: 10 }); await page.mouse.up();
  assert.deepEqual((await markups(page))[0].strokes.map(s => s.id), [low.id]);
  await delay(200);
  assert.ok(await redness(page, ...there) < 40, 'and it is gone from the wall');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  assert.deepEqual((await markups(page))[0].strokes.map(s => s.id), [ink.id, low.id]);

  // ---------- one pen-down stays on the starting face ----------
  assert.equal((await state(page)).surfaceLock, true, 'surface locking is on by default');
  await page.keyboard.press('p');
  const faceStart = onScreen(camCorner, box, [WALL_X, 1.1, 0.75]);
  const otherFace = onScreen(camCorner, box, [1.1, 1.1, WALL_X]);
  const faceReturn = onScreen(camCorner, box, [WALL_X, 0.9, 0.8]);
  const beforeLock = (await markups(page))[0].strokes.length;
  await page.mouse.move(...faceStart); await page.mouse.down();
  await page.mouse.move(...otherFace, { steps: 18 });
  await page.mouse.move(...faceReturn, { steps: 18 }); await page.mouse.up();
  const locked = (await markups(page))[0].strokes.slice(beforeLock);
  assert.ok(locked.length >= 2, 'leaving and returning starts a separate run instead of a bridge');
  assert.ok(locked.every(s => s.on.every(h => h.id === 'w-w')), 'only the starting wall receives ink');
  assert.ok(locked.every(s => s.w.filter((_, i) => i % 3 === 0).every(x => Math.abs(x - WALL_X - 0.004) < 0.002)), 'no points bend onto the adjacent face');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  assert.equal((await markups(page))[0].strokes.length, beforeLock, 'all parts of one press undo together');

  await page.locator('.mk-bar [data-act=lock]').click();
  assert.equal((await state(page)).surfaceLock, false);
  await page.mouse.move(...faceStart); await page.mouse.down();
  await page.mouse.move(...otherFace, { steps: 20 }); await page.mouse.up();
  const free = (await markups(page))[0].strokes.slice(beforeLock);
  const touched = new Set(free.flatMap(s => s.on.map(h => h.id)));
  assert.ok(touched.has('w-w') && touched.has('w-s'), 'unlocking permits a stroke across both faces: ' + [...touched]);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await page.locator('.mk-bar [data-act=lock]').click();

  // Surface visibility affects rendered ink and erasing, independently of other markups.
  await page.locator('.mk-bar [data-act=list]').click();
  await page.locator('.mk-row').first().locator('[data-visibility]').click();
  assert.equal((await markups(page))[0].hidden, true);
  await delay(150);
  assert.ok(await redness(page, ...there) < 40, 'hidden surface ink leaves the model');
  await page.locator('.mk-list [data-close]').click();
  await page.keyboard.press('e');
  await page.mouse.move(there[0], there[1] - 20); await page.mouse.down(); await page.mouse.move(there[0], there[1] + 20, { steps: 5 }); await page.mouse.up();
  assert.equal((await markups(page))[0].strokes.length, beforeLock, 'the eraser ignores hidden surface ink');
  await page.locator('.mk-bar [data-act=list]').click();
  await page.locator('.mk-list [data-show-all]').click();
  assert.equal((await markups(page))[0].hidden, false);
  await page.locator('.mk-list [data-close]').click();

  // ---------- the line tool, straight at the wall ----------
  await go('v-west');
  await page.keyboard.press('l');
  assert.equal((await state(page)).tool, 'line');
  assert.match(await page.locator('.v-hint').innerText(), /^LINE: click where the line starts/);
  const A = [cx - 120, cy + 90];
  await page.mouse.click(...A);
  let st = await state(page);
  assert.equal(st.line.length, 1, 'the line has its first point');
  assert.ok(Math.abs(st.line[0][0] - WALL_X) < 0.002, 'on the wall\'s face: ' + st.line[0]);
  // Nearly straight up: the blue axis. The click puts the point exactly above the first.
  await page.mouse.move(A[0] + 3, A[1] - 160, { steps: 4 });
  st = await state(page);
  assert.equal(st.snap.kind, 'blue');
  assert.equal(st.snap.label, 'On blue axis');
  await page.mouse.click(A[0] + 3, A[1] - 160);
  list = await markups(page);
  const up = list[0].strokes.at(-1);
  assert.equal(up.tool, 'line');
  assert.equal(up.w.length, 6);
  assert.ok(Math.abs(up.w[0] - up.w[3]) < 1e-4 && Math.abs(up.w[2] - up.w[5]) < 1e-4 && up.w[4] - up.w[1] > 0.3, 'straight up: ' + up.w);
  assert.ok(Math.abs(up.w[0] - (WALL_X + 0.003)) < 0.002, 'lifted 3 mm off the face');
  // Across: the green axis (along this wall); the length is typed.
  const B = onScreen(camWest, box, [WALL_X, up.w[4], up.w[5]]);
  await page.mouse.move(B[0] + 140, B[1] + 3, { steps: 4 });
  st = await state(page);
  assert.equal(st.snap.kind, 'green');
  await page.keyboard.type('0.5m');
  assert.equal((await state(page)).typed, '0.5m');
  await page.keyboard.press('Enter');
  list = await markups(page);
  const across = list[0].strokes.at(-1);
  assert.ok(Math.abs(Math.abs(across.w[5] - across.w[2]) - 0.5) < 1e-3 && Math.abs(across.w[4] - across.w[1]) < 1e-4, 'half a metre along the wall: ' + across.w);
  // Back onto the first point: it snaps to it, and the click closes the shape and ends the line.
  await page.mouse.move(A[0] + 4, A[1] - 3, { steps: 4 });
  st = await state(page);
  assert.equal(st.snap.kind, 'endpoint');
  await page.mouse.click(A[0] + 4, A[1] - 3);
  st = await state(page);
  assert.equal(st.line, null, 'the closed shape ends the line');
  list = await markups(page);
  const closing = list[0].strokes.at(-1);
  assert.equal(list[0].strokes.filter(s => s.tool === 'line').length, 3);
  assert.ok(Math.abs(closing.w[3] - up.w[0]) < 1e-4 && Math.abs(closing.w[4] - up.w[1]) < 1e-4 && Math.abs(closing.w[5] - up.w[2]) < 1e-4, 'it ends exactly on the first point');

  // Parallel and perpendicular: touch the sloping line, start a new line, and point along it and
  // across it.
  const c0 = onScreen(camWest, box, closing.w.slice(0, 3)), c1 = onScreen(camWest, box, closing.w.slice(3, 6));
  await page.mouse.move(c0[0] + (c1[0] - c0[0]) * 0.3 + 1, c0[1] + (c1[1] - c0[1]) * 0.3 + 1, { steps: 4 });
  assert.equal((await state(page)).snap.kind, 'edge', 'on the sloping line');
  const D = [cx + 180, cy + 40], s = [(c0[0] - c1[0]), (c0[1] - c1[1])], sl = Math.hypot(...s), dir = s.map(v => v / sl);
  await page.mouse.move(...D, { steps: 6 });
  await page.mouse.click(...D);
  await page.mouse.move(D[0] + dir[0] * 120 + 2, D[1] + dir[1] * 120, { steps: 6 });
  st = await state(page);
  assert.equal(st.snap.kind, 'parallel');
  assert.equal(st.snap.label, 'Parallel to edge');
  await page.mouse.move(D[0] - dir[1] * 110 + 2, D[1] + dir[0] * 110, { steps: 6 });
  st = await state(page);
  assert.equal(st.snap.kind, 'perpendicular');
  // Shift holds it: far off the direction, the point is still on it.
  await page.keyboard.down('Shift');
  await page.mouse.move(D[0] - dir[1] * 110 + 40, D[1] + dir[0] * 110 + 40, { steps: 4 });
  st = await state(page);
  assert.equal(st.snap.kind, 'perpendicular');
  assert.equal(st.snap.locked, true);
  await page.mouse.click(D[0] - dir[1] * 110 + 40, D[1] + dir[0] * 110 + 40);
  await page.keyboard.up('Shift');
  list = await markups(page);
  const perp = list[0].strokes.at(-1), cl = closing.w;
  const dot = (perp.w[4] - perp.w[1]) * (cl[4] - cl[1]) + (perp.w[5] - perp.w[2]) * (cl[5] - cl[2]);
  assert.ok(Math.abs(dot) < 1e-4, 'at right angles to the sloping line: ' + dot);
  await page.keyboard.press('Escape');
  assert.equal((await state(page)).line, null, 'Esc ends the line');
  assert.equal((await state(page)).on, true, 'and leaves markup mode on');
  const lines = (await markups(page))[0].strokes.length;
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  assert.equal((await markups(page))[0].strokes.length, lines - 1, 'undo takes the last line back');

  // ---------- the picture ----------
  await page.locator('.mk-bar [data-act=list]').click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('.mk-row').first().locator('[data-picture]').click()]);
  const png = await readFile(await download.path());
  assert.ok(png.length > 5000 && png.subarray(1, 4).toString() === 'PNG', 'a real PNG comes out');
  assert.deepEqual(errors, []);
  await context.close();
  console.log('markup on surfaces: pen ink sits on the wall from any view; the line tool snaps to axes, ends, edges, parallel and perpendicular.');
} finally {
  await browser.close();
  server.close();
}
