// Markup mode on MODEL, in a real browser on a synthetic property: a mouse, a pen (with
// pressure) and fingers each draw; while one draws, the view holds still and the page selects
// nothing; a second finger and the wheel still move the view; a hand resting beside the pen is
// ignored; notes are pinned and numbered; undo, redo and the eraser work; ink over the model goes
// with its camera and comes back with it; and a markup's picture can be saved.
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
async function open(context, view) {
  const page = await context.newPage();
  await page.addInitScript(() => localStorage.setItem('tiksi.onScreen.v1', '{"all":true}'));   // the tool columns on the screen
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(url + '/#/budget'); await page.locator('#cap-input').waitFor();   // seeded before MODEL mounts
  await page.evaluate(async () => {
    const store = await import('/js/store.js');
    store.ws.data = store.emptyWorkspace();
    const p = store.propertyTemplate('Markup check'); p.id = 'prop-markup'; const L = p.levels[0].id;
    const wall = (id, ax, ay, bx, by) => ({ id, level: L, ax, ay, bx, by, thickness: 0.114, height: null, material: 'mat-drywall' });
    p.walls.push(wall('w-s', 0, 0, 6, 0), wall('w-e', 6, 0, 6, 4), wall('w-n', 6, 4, 0, 4), wall('w-w', 0, 4, 0, 0));
    p.rooms.push({ id: 'r-k', level: L, name: 'Kitchen', pts: [[0, 0], [6, 0], [6, 4], [0, 4]], material: 'mat-oak', ceilingMaterial: null });
    store.addLevel(p, { name: 'Upstairs', elevation: 3, height: 2.44 });
    store.ws.data.properties.push(p); store.ws.data.settings.activePropertyId = p.id;
  });
  await page.locator(`#rail a[data-view="${view}"]`).click({ noWaitAfter: true });
  await page.locator('canvas.v-canvas').first().waitFor();
  return { page, errors };
}
const markups = page => page.evaluate(async () => JSON.parse(JSON.stringify((await import('/js/store.js')).activeProperty().markups)));
const modelState = page => page.evaluate(async () => (await import('/js/viewer3d.js')).markupState());
const sameCam = (a, b) => a.position.concat(a.target).every((v, i) => Math.abs(v - b.position.concat(b.target)[i]) < 1e-3);
// The opacity of the ink canvas at a point of the page (0 where nothing is drawn).
const inkAt = (page, x, y) => page.evaluate(([x, y]) => {
  const c = document.querySelector('.mk-layer').ink, r = c.getBoundingClientRect(), k = c.width / r.width;
  return c.getContext('2d').getImageData(Math.round((x - r.left) * k), Math.round((y - r.top) * k), 1, 1).data[3];
}, [x, y]);
// A real pen: Chrome's own mouse events carry a pointer type and a pressure.
function penOf(cdp) {
  const send = (type, x, y, force, buttons) => cdp.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' && !buttons ? 'none' : 'left', buttons, clickCount: type === 'mouseMoved' ? 0 : 1, pointerType: 'pen', force });
  return {
    hover: (x, y) => send('mouseMoved', x, y, 0, 0),
    down: (x, y, f = 0.3) => send('mousePressed', x, y, f, 1),
    move: (x, y, f = 0.5) => send('mouseMoved', x, y, f, 1),
    up: (x, y) => send('mouseReleased', x, y, 0, 0),
    async line(points, forces) {
      await this.down(points[0][0], points[0][1], forces[0]);
      for (let i = 1; i < points.length; i++) await this.move(points[i][0], points[i][1], forces[i] ?? 0.5);
      await this.up(...points.at(-1));
    },
  };
}
const touchOf = cdp => (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], id) => ({ x, y, id, radiusX: 4, radiusY: 4, force: 1 })) });

try {
  // ---------- 1. MODEL with a mouse ----------
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
    const { page, errors } = await open(context, 'model');
    await page.locator('.v-modes [data-mode=top]').click();
    await delay(900);   // the camera flight to the top view
    const box = await page.locator('canvas.v-canvas').boundingBox();
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;

    // Until it is asked for, markup mode is not even downloaded.
    assert.deepEqual([(await modelState(page)).on, (await modelState(page)).loaded], [false, false]);
    assert.equal(await page.locator('.mk-bar').count(), 0);
    assert.deepEqual(await page.evaluate(() => performance.getEntriesByType('resource').map(r => r.name).filter(n => /markup/.test(n))), [], 'none of its files is fetched');
    await page.locator('#side [data-act=markup]').click();
    await page.locator('.mk-bar').waitFor();
    assert.equal(await page.locator('#side [data-act=markup]').evaluate(b => b.classList.contains('active')), true);
    assert.match(await page.locator('.v-hint').innerText(), /^Drag: the pen draws on the model\. The wheel/);
    assert.equal((await modelState(page)).place, 'surface', 'ink goes onto the surfaces unless asked otherwise');
    // This part is about ink flat on the screen (e2e-markup-surfaces.mjs has ink on the surfaces).
    await page.keyboard.press('s');
    assert.equal((await modelState(page)).place, 'screen');
    assert.match(await page.locator('.v-hint').innerText(), /^Drag: the pen draws\. The wheel/);
    const cam0 = (await modelState(page)).camera;
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

    // A drag draws; it does not turn the view, and the release selects nothing.
    await page.mouse.move(cx - 150, cy - 40);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(cx - 150 + i * 30, cy - 40 + (i % 2) * 6);
    await page.mouse.up();
    let list = await markups(page);
    assert.equal(list.length, 1);
    assert.equal(list[0].on, 'model');
    assert.equal(list[0].number, 1);
    assert.equal(list[0].strokes.length, 1);
    const s0 = list[0].strokes[0];
    assert.equal(s0.tool, 'pen');
    assert.equal(s0.color, '#e5372b');
    assert.ok(Math.abs(s0.pts[0] - (-150 / box.height)) < 0.004 && Math.abs(s0.pts[1] - (-40 / box.height)) < 0.004, 'the stroke starts where the press was, in view heights from the middle: ' + s0.pts.slice(0, 3));
    assert.ok(Math.abs(s0.pts.at(-3) - (150 / box.height)) < 0.004, 'and ends where the release was');
    assert.ok(s0.pts.every((v, i) => i % 3 !== 2 || v === 0.5), 'a mouse draws at one pressure');
    assert.ok(sameCam(cam0, (await modelState(page)).camera), 'drawing does not move the camera');
    assert.deepEqual(list[0].view.camera.position.map(v => Math.round(v * 100)), cam0.position.map(v => Math.round(v * 100)), 'the markup keeps the camera it was drawn from');
    assert.ok(await inkAt(page, cx, cy - 40 + 3) > 200 || await inkAt(page, cx, cy - 40) > 200 || await inkAt(page, cx, cy - 37) > 200, 'the ink is on the screen');
    // What the line is drawn on is read from the model once it is down: the kitchen floor.
    await waitUntil(async () => !!(await markups(page))[0].strokes[0].on, 'the stroke\'s surfaces are read');
    const on = (await markups(page))[0].strokes[0].on;
    const mid = on[Math.floor(on.length / 2)];
    assert.ok(on.length >= 4 && on.every(h => (h.k === 'room' && h.id === 'r-k') || h.k === 'wall'), 'each sampled point is on the kitchen floor or one of its walls: ' + JSON.stringify(on));
    assert.ok(mid.k === 'room' && mid.id === 'r-k' && Math.abs(mid.p[1]) < 0.2 && mid.p[0] > 1 && mid.p[0] < 5, 'the middle of the line is on the kitchen floor: ' + JSON.stringify(mid));

    // Undo takes the only stroke (and so the markup) out; redo brings both back as they were,
    // on the screen, and the next mark still joins that markup.
    await page.keyboard.press(mod + '+z');
    assert.deepEqual(await markups(page), []);
    assert.equal(await inkAt(page, cx, cy - 40) + await inkAt(page, cx, cy - 37), 0, 'the undone ink is off the screen');
    await page.keyboard.press(mod + '+Shift+z');
    list = await markups(page);
    assert.deepEqual(list.map(m => [m.id, m.number, m.strokes[0].id]), [[list[0].id, 1, s0.id]]);
    assert.ok(list[0].strokes[0].on.length >= 4, 'with what it was drawn on');
    assert.equal((await modelState(page)).activeId, list[0].id, 'the markup that came back is the open one');
    assert.ok(await inkAt(page, cx, cy - 40) > 0 || await inkAt(page, cx, cy - 37) > 0 || await inkAt(page, cx, cy - 43) > 0, 'and its ink is on the screen again');

    // A numbered note: a click pins it to what is under it and opens its words.
    await page.keyboard.press('n');
    assert.equal((await modelState(page)).tool, 'note');
    await page.mouse.click(cx + 60, cy + 80);
    await page.locator('.mk-edit textarea').waitFor();
    assert.equal(await page.evaluate(() => document.activeElement.tagName), 'TEXTAREA');
    await page.keyboard.type('Chair rail along this wall');
    await page.keyboard.press('Enter');
    list = await markups(page);
    assert.equal(list.length, 1, 'the note joins the open markup');
    assert.equal(list[0].notes.length, 1);
    assert.equal(list[0].notes[0].n, 1);
    assert.equal(list[0].notes[0].text, 'Chair rail along this wall');
    assert.equal(list[0].notes[0].kind, 'room');
    assert.equal(list[0].notes[0].ref, 'r-k');
    assert.ok(Math.abs(list[0].notes[0].anchor.y) < 0.2, 'pinned on the floor');
    assert.equal(await page.locator('.mk-note.own b').innerText(), '1');
    assert.equal(await page.locator('.mk-note.own span').innerText(), 'Chair rail along this wall');
    const badge = await page.locator('.mk-note.own b').boundingBox();
    assert.ok(Math.abs(badge.x + badge.width / 2 - (cx + 60)) < 6 && Math.abs(badge.y + badge.height / 2 - (cy + 80)) < 6, 'the number sits where the click was');

    // The wheel still moves the view. The ink is this markup's own view, so it goes; the pinned
    // note stays on its point; and the chip brings the view back.
    await page.mouse.move(cx, cy);
    await page.mouse.wheel(0, -400);
    await waitUntil(async () => !sameCam(cam0, (await modelState(page)).camera), 'the wheel zooms');
    await waitUntil(() => page.locator('.mk-chip').isVisible(), 'the way back is offered');
    assert.equal(await inkAt(page, cx, cy - 40), 0, 'the ink is put away while the camera is elsewhere');
    assert.equal(await page.locator('.mk-note').count(), 1, 'the pinned note still shows');
    await page.locator('.mk-chip').click();
    await waitUntil(async () => sameCam(cam0, (await modelState(page)).camera), 'the camera flies back');
    await waitUntil(async () => await inkAt(page, cx, cy - 40) > 0 || await inkAt(page, cx, cy - 37) > 0, 'the ink is back with its view');
    assert.equal(await page.locator('.mk-chip').isVisible(), false);

    // A mark from another view starts a second markup.
    await page.mouse.wheel(0, -300);
    await waitUntil(async () => !sameCam(cam0, (await modelState(page)).camera), 'zoomed again');
    await delay(400);   // the zoom eases out
    await page.keyboard.press('p');
    await page.mouse.move(cx - 60, cy + 150); await page.mouse.down(); await page.mouse.move(cx, cy + 160); await page.mouse.move(cx + 60, cy + 150); await page.mouse.up();
    list = await markups(page);
    assert.deepEqual(list.map(m => [m.number, m.strokes.length, m.notes.length]), [[1, 1, 1], [2, 1, 0]]);
    assert.equal((await modelState(page)).activeId, list[1].id);

    // Undo and redo, step by step; an emptied markup goes and comes back as itself.
    await page.keyboard.press(mod + '+z');
    assert.deepEqual((await markups(page)).map(m => m.number), [1], 'undoing its only stroke takes the second markup out');
    await page.keyboard.press(mod + '+z');
    assert.equal((await markups(page))[0].notes.length, 0, 'then the note');
    await page.keyboard.press(mod + '+Shift+z');
    await page.keyboard.press(mod + '+Shift+z');
    const again = await markups(page);
    assert.deepEqual(again.map(m => [m.id, m.number, m.strokes.length, m.notes.length]), list.map(m => [m.id, m.number, m.strokes.length, m.notes.length]));
    assert.equal(again[0].notes[0].text, 'Chair rail along this wall', 'redo brings the note back with its words');

    // The list opens a markup from its own view; the eraser rubs out a whole stroke.
    await page.locator('.mk-bar [data-act=list]').click();
    assert.equal(await page.locator('.mk-row').count(), 2);
    await page.locator('.mk-row').first().locator('[data-open]').click();
    await waitUntil(async () => sameCam(cam0, (await modelState(page)).camera), 'the list flies to the first markup\'s view');
    await page.keyboard.press('e');
    await page.mouse.move(cx - 30, cy - 90); await page.mouse.down(); await page.mouse.move(cx - 30, cy - 40, { steps: 6 }); await page.mouse.move(cx - 30, cy + 10, { steps: 6 }); await page.mouse.up();
    list = await markups(page);
    assert.deepEqual(list.map(m => [m.number, m.strokes.length, m.notes.length]), [[1, 0, 1], [2, 1, 0]], 'the stroke under the eraser is gone, the note stays');
    await page.keyboard.press(mod + '+z');
    assert.equal((await markups(page))[0].strokes[0].id, s0.id, 'undo puts the erased stroke back');

    // A dead-straight line is saved as its two ends, and is still read all along its length.
    await page.keyboard.press('p');
    await page.mouse.move(cx - 140, cy + 60); await page.mouse.down(); await page.mouse.move(cx + 140, cy + 60); await page.mouse.up();
    await waitUntil(async () => !!(await markups(page))[0].strokes.at(-1).on, 'the straight stroke is read');
    const straight = (await markups(page))[0].strokes.at(-1);
    assert.equal(straight.pts.length, 6, 'two points');
    assert.equal(straight.on.length, 8, 'eight readings along it');
    assert.ok(straight.on.every(h => h.k === 'room' && h.id === 'r-k') && straight.on[7].p[0] - straight.on[0].p[0] > 1, 'spread across the kitchen floor: ' + JSON.stringify(straight.on.map(h => h.p[0])));
    await page.keyboard.press(mod + '+z');

    // One eraser drag across two strokes takes both; undo puts them back in their old order.
    await page.keyboard.press('p');
    await page.mouse.move(cx - 150, cy - 70); await page.mouse.down(); await page.mouse.move(cx, cy - 72, { steps: 4 }); await page.mouse.move(cx + 150, cy - 70, { steps: 4 }); await page.mouse.up();
    const order = (await markups(page))[0].strokes.map(k => k.id);
    assert.equal(order.length, 2);
    await page.keyboard.press('e');
    await page.mouse.move(cx - 30, cy - 110); await page.mouse.down(); await page.mouse.move(cx - 30, cy - 70, { steps: 6 }); await page.mouse.move(cx - 30, cy, { steps: 8 }); await page.mouse.up();
    assert.equal((await markups(page))[0].strokes.length, 0);
    await page.keyboard.press(mod + '+z');
    assert.deepEqual((await markups(page))[0].strokes.map(k => k.id), order);

    // A picture of a markup: the view with its ink on it.
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('.mk-row').first().locator('[data-picture]').click()]);
    assert.match(download.suggestedFilename(), /^markup-check-markup-1\.png$/);
    const png = await readFile(await download.path());
    assert.ok(png.length > 5000 && png.subarray(1, 4).toString() === 'PNG', 'a real PNG comes out');

    // Delete asks first, and can be undone.
    await page.locator('.mk-row').nth(1).locator('[data-delete]').click();
    await page.locator('.mk-row [data-really]').click();
    assert.deepEqual((await markups(page)).map(m => m.number), [1]);
    await page.locator('.mk-bar [data-act=undo]').click();
    assert.deepEqual((await markups(page)).map(m => m.number), [1, 2]);

    // DONE ends it: the bar goes and a click selects again.
    const drawn = (await markups(page)).reduce((n, m) => n + m.strokes.length, 0);
    await page.locator('.mk-bar [data-act=done]').click();
    assert.equal(await page.locator('.mk-bar').isVisible(), false);
    assert.equal((await modelState(page)).on, false);
    await page.mouse.click(cx - 200, cy + 200);
    await waitUntil(async () => /FLOOR|ROOM|KITCHEN/i.test(await page.locator('.inspector').innerText()), 'a click selects the floor again');
    assert.equal((await markups(page)).reduce((n, m) => n + m.strokes.length, 0), drawn, 'and draws nothing');
    assert.deepEqual(errors, []);
    await context.close();
  }

  // ---------- 2. MODEL with fingers and a pen (an iPad) ----------
  {
    const context = await browser.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true, deviceScaleFactor: 2 });
    const { page, errors } = await open(context, 'model');
    const cdp = await context.newCDPSession(page);
    const touch = touchOf(cdp), pen = penOf(cdp);
    await page.locator('.v-modes [data-mode=orbit]').waitFor();
    await delay(900);
    const box = await page.locator('canvas.v-canvas').boundingBox();
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    await page.evaluate(async () => (await import('/js/viewer3d.js')).fieldAction('tool', 'markup'));
    await page.locator('.mk-bar').waitFor();
    let st = await modelState(page);
    assert.equal(st.on, true);
    assert.equal(st.fingerDraws, true, 'until a pen is seen, a finger draws');
    assert.equal(await page.locator('.mk-bar [data-act=finger]').getAttribute('aria-pressed'), 'true');
    await page.locator('.mk-bar [data-act=place]').tap();   // ink flat on the screen, for this part
    assert.equal((await modelState(page)).place, 'screen');
    const cam0 = st.camera;

    // One finger draws and the view holds still.
    await touch('touchStart', [[cx - 120, cy]]);
    for (let i = 1; i <= 8; i++) await touch('touchMove', [[cx - 120 + i * 30, cy + (i % 2) * 5]]);
    await touch('touchEnd', []);
    let list = await markups(page);
    assert.equal(list.length, 1);
    assert.equal(list[0].strokes.length, 1);
    assert.ok(Math.abs(list[0].strokes[0].pts.at(-3) - 120 / box.height) < 0.01);
    assert.ok(sameCam(cam0, (await modelState(page)).camera), 'a drawing finger does not turn the view');

    // Two fingers still move the view, and leave no mark.
    await touch('touchStart', [[cx - 60, cy + 100]]);
    await touch('touchStart', [[cx - 60, cy + 100], [cx + 60, cy + 100]]);
    for (let i = 1; i <= 6; i++) await touch('touchMove', [[cx - 60 - i * 15, cy + 100], [cx + 60 + i * 15, cy + 100]]);
    await touch('touchEnd', []);
    await waitUntil(async () => !sameCam(cam0, (await modelState(page)).camera), 'a pinch zooms');
    list = await markups(page);
    assert.equal(list.reduce((n, m) => n + m.strokes.length, 0), 1, 'the pinch draws nothing');
    await delay(400);   // the zoom eases out
    const cam1 = (await modelState(page)).camera;

    // The pencil draws with its pressure, from this new view: a second markup.
    // The hand lands a moment before the tip, while fingers still draw: its line is dropped, the
    // pencil's is kept, and the pencil does not turn the view.
    await touch('touchStart', [[cx + 230, cy + 190]]);
    await touch('touchMove', [[cx + 236, cy + 196]]);
    // (Drawn clear of the component list, which floats over the top left of the view.)
    await pen.line([[cx - 20, cy - 120], [cx + 30, cy - 118], [cx + 80, cy - 122], [cx + 130, cy - 118], [cx + 180, cy - 120]], [0.15, 0.35, 0.6, 0.85, 0.4]);
    await touch('touchMove', [[cx + 240, cy + 200]]);
    await touch('touchEnd', []);
    list = await markups(page);
    assert.deepEqual(list.map(m => m.strokes.length), [1, 1]);
    const pressures = list[1].strokes[0].pts.filter((v, i) => i % 3 === 2);
    assert.ok(Math.max(...pressures) > 0.7 && Math.min(...pressures) < 0.3, 'the stroke keeps the pencil\'s pressure: ' + pressures);
    st = await modelState(page);
    assert.equal(st.penSeen, true);
    assert.equal(st.fingerDraws, false, 'once a pencil is in use, fingers move the view');
    assert.equal(await page.locator('.mk-bar [data-act=finger]').getAttribute('aria-pressed'), 'false');
    assert.ok(sameCam(cam1, st.camera));

    // The side of the hand lands while the pencil is down: no mark from it, no view change.
    await pen.down(cx - 100, cy + 40, 0.5);
    await touch('touchStart', [[cx + 220, cy + 200]]);
    await pen.move(cx, cy + 44, 0.5);
    await touch('touchMove', [[cx + 240, cy + 215]]);
    await pen.move(cx + 100, cy + 40, 0.5);
    await pen.up(cx + 100, cy + 40);
    await touch('touchEnd', []);
    list = await markups(page);
    assert.deepEqual(list.map(m => m.strokes.length), [1, 2], 'the pencil\'s line is kept and the hand adds none');
    assert.ok(sameCam(cam1, (await modelState(page)).camera), 'the resting hand does not move the view');

    // Later, a finger alone turns the view (and still draws nothing).
    await delay(600);   // past the moment a touch counts as the hand
    await touch('touchStart', [[cx, cy + 150]]);
    for (let i = 1; i <= 6; i++) await touch('touchMove', [[cx + i * 25, cy + 150]]);
    await touch('touchEnd', []);
    await waitUntil(async () => !sameCam(cam1, (await modelState(page)).camera), 'a finger orbits');
    assert.deepEqual((await markups(page)).map(m => m.strokes.length), [1, 2]);

    // The finger button hands drawing back to the finger.
    await page.locator('.mk-bar [data-act=finger]').tap();
    assert.equal((await modelState(page)).fingerDraws, true);
    assert.deepEqual(errors, []);
    await context.close();
  }

  console.log('markup mode: mouse, pen and fingers draw on MODEL; notes, undo, eraser, pictures and the view rules hold.');
} finally {
  await browser.close();
  server.close();
}
