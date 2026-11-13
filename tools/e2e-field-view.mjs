// Phone layout: on a phone the console opens on the model with no toolbars, and one side panel
// moves the camera, flips what shows and reaches the other pages. Desktop is unchanged.
// Synthetic demo project in a temporary state directory; live 8642 is never used.
// E2E_BROWSER=webkit runs it on Safari's engine (node scripts/e2e.mjs --webkit), the engine the
// phone uses; otherwise Chromium.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { chromium, devices, webkit } from 'playwright';

const state = await mkdtemp(tmpdir() + '/tiksi-field-view-test-');
const socket = net.createServer();
await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
const port = socket.address().port;
await new Promise(resolve => socket.close(resolve));
const child = spawn('python3', ['tools/serve.py', '--port', String(port), '--state-dir', state], { stdio: ['ignore', 'pipe', 'pipe'] });
// Read the server's output: an unread pipe fills after about 64 KB of request log lines on Linux,
// and then every server thread stops at its next log line and the pages hang.
child.stdout.resume();
// Keep the last server error lines: a hung reload prints them with the server's thread stacks.
const serverErr = []; child.stderr.on('data', d => { serverErr.push(...String(d).split('\n')); serverErr.splice(0, Math.max(0, serverErr.length - 400)); });
const url = 'http://127.0.0.1:' + port;
let browser;
const shown = (page, sel) => page.locator(sel).first().evaluate(e => getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden' && !!e.getClientRects().length);
// Wait for MODEL to settle (first frame, models, textures and shader warm-up) before tapping it:
// on a software GL the warm-up blocks the page for a long time and a tap lands only after it.
const ENGINE = process.env.E2E_BROWSER === 'webkit' ? 'webkit' : 'chromium';
// One finger on the screen: down at the first point, through the rest, up at the last, holding
// for holdMs before lifting. Chromium gets real touches through its protocol. Playwright can only
// tap on WebKit, so there the same touch reaches the page as the pointer events Safari sends for
// a finger, and setPointerCapture is told to accept that pointer as Safari would for a real one.
async function finger(page, points, { holdMs = 0, stepMs = 16 } = {}) {
  if (ENGINE === 'chromium') {
    const cdp = await page.context().newCDPSession(page);
    const at = ([x, y]) => [{ x, y, id: 1, radiusX: 4, radiusY: 4, force: 1 }];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(points[0]) });
    for (const point of points.slice(1)) { await page.waitForTimeout(stepMs); await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(point) }); }
    if (holdMs) await page.waitForTimeout(holdMs);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
    return;
  }
  const send = (type, [x, y]) => page.evaluate(({ type, x, y }) => {
    if (!window.__fingerCapture) {
      window.__fingerCapture = true;
      for (const name of ['setPointerCapture', 'releasePointerCapture']) {
        const real = Element.prototype[name];
        Element.prototype[name] = function (id) { if (id === 77) return; return real.call(this, id); };
      }
    }
    const target = type === 'pointerdown' ? document.elementFromPoint(x, y) : (window.__fingerTarget || document.elementFromPoint(x, y));
    window.__fingerTarget = type === 'pointerup' ? null : target;
    const init = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, pointerId: 77, pointerType: 'touch', isPrimary: true, button: type === 'pointermove' ? -1 : 0, buttons: type === 'pointerup' ? 0 : 1, width: 8, height: 8, pressure: type === 'pointerup' ? 0 : 0.5 };
    target.dispatchEvent(new PointerEvent(type, init));
  }, { type, x, y });
  await send('pointerdown', points[0]);
  for (const point of points.slice(1)) { await page.waitForTimeout(stepMs); await send('pointermove', point); }
  if (holdMs) await page.waitForTimeout(holdMs);
  await send('pointerup', points.at(-1));
}
// Where the camera stands, read the way the app itself saves it: as a saved view.
const cameraNow = page => page.evaluate(async () => {
  (await import('/js/viewer3d.js')).fieldAction('save-view');
  return (await import('/js/store.js')).activeProperty().savedViews.at(-1).camera;
});
const moved = (a, b) => Math.hypot(...a.position.map((v, i) => v - b.position[i]));
const settled = async (pg, ms = 240000) => { const end = Date.now() + ms; while (!(await pg.evaluate(async () => (await import('/js/viewer3d.js')).viewerIdle()))) { assert.ok(Date.now() < end, 'MODEL did not settle: ' + JSON.stringify(await pg.evaluate(async () => ({ ...(await import('/js/viewer3d.js')).viewerIdleState(), textures: (await import('/js/textures.js')).textureStats().filter(t => t.status !== 'ready') })))); await pg.waitForTimeout(250); } };
try {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url)).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  // E2E_SOFTWARE_GL=0 draws with the machine's graphics instead of Chromium's software GL.
  const gl = process.env.E2E_SOFTWARE_GL === '0' ? [] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
  browser = ENGINE === 'webkit' ? await webkit.launch() : await chromium.launch({ args: gl });
  const errors = [];

  // ---------- phone, no property yet ----------
  const { defaultBrowserType, ...iphone } = devices['iPhone 13'];
  const phone = await browser.newContext(iphone);
  const page = await phone.newPage();
  // Every request the page has open, so a hung reload can say what was holding the server.
  const pending = new Map();
  page.on('request', r => pending.set(r, performance.now()));
  for (const done of ['requestfinished', 'requestfailed']) page.on(done, r => pending.delete(r));
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector('#save-status').textContent === 'SAVED TO DISK');
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('phone')), true, 'a phone gets the phone layout');
  assert.equal(await shown(page, '#topbar'), false, 'no topbar on a phone');
  assert.equal(await shown(page, '#rail'), false, 'no page tabs on a phone');
  assert.equal(await shown(page, '#side'), false, 'no left pane on a phone');
  assert.equal(await page.locator('#rail a.active').getAttribute('data-view'), 'model', 'a phone opens on the model');
  // FILE must still open from the panel with nothing to show yet, so a property can be added.
  await settled(page);
  await page.locator('.fd-menu').click();
  await page.locator('.fd-panel [data-file]').click();
  await page.locator('dialog.file-dialog[open]').waitFor();
  await page.locator('dialog.file-dialog[open] [data-file-env]').evaluate(e => e.closest('details').open = true);
  assert.match(await page.locator('[data-file-env]').textContent(), /Add a property/);
  await page.evaluate(() => document.querySelector('dialog.file-dialog[open]').close());

  // ---------- phone, the demo house ----------
  await page.evaluate(async () => {
    const store = await import('/js/store.js');
    const { demoWorkspace } = await import('/js/demo.js');
    store.mergeWorkspace(demoWorkspace());
    store.ws.data.settings.activePropertyId = store.ws.data.properties[0].id;
    store.touch();
    await (await import('/js/disk-workspace.js')).diskWorkspace.sync();
  });
  await page.goto(url + '/');
  await page.locator('.v-wrap canvas').waitFor();
  for (const sel of ['.v-layout > .tool-col', '.v-layout > .inspector', '.v-modes', '.v-compass', '.v-env', '.v-hint']) {
    assert.equal(await shown(page, sel), false, sel + ' is hidden on a phone');
  }
  const box = await page.locator('.v-wrap').boundingBox();
  const vp = page.viewportSize();
  assert.ok(box.width >= vp.width - 1 && box.height >= vp.height - 1, 'the model fills the screen');
  const canvasPx = await page.locator('.v-wrap canvas').evaluate(c => c.width / c.clientWidth);
  assert.ok(canvasPx <= 1.5 + 1e-6, 'the phone draws at most 1.5x (this phone is 3x): ' + canvasPx);
  assert.equal(await shown(page, '.fd-frame'), true, 'the overview button is on screen');
  assert.equal(await shown(page, '.fd-panel'), false, 'the panel starts closed');

  // The panel: switches flip the view and stay open; camera moves close it.
  await page.locator('.fd-menu').click();
  await page.locator('.fd-panel').waitFor({ state: 'visible' });
  const section = page.locator('.fd-switch[data-id=section]');
  assert.equal(await section.getAttribute('aria-checked'), 'false');
  await section.click();
  assert.equal(await page.locator('.fd-switch[data-id=section]').getAttribute('aria-checked'), 'true', 'section cut turns on');
  assert.equal(await page.locator('.fd-range input[type=range]').count(), 1, 'its cut height appears under it');
  const state3d = () => page.evaluate(async () => (await import('/js/viewer3d.js')).fieldState());
  assert.equal((await state3d()).show.find(s => s.id === 'section').on, true);
  await page.locator('.fd-switch[data-id=xray]').click();
  assert.equal((await state3d()).show.find(s => s.id === 'xray').on, true, 'x-ray turns on');
  assert.equal(await page.locator('.fd-switch[data-id=pins]').count(), 0, 'no Photos switch without pinned photos');
  // Tags: one switch per tag that holds something; switching one hides it in the model.
  const walls = page.locator('.fd-switch[data-act=tag][data-id="tag-walls"]');
  assert.equal(await walls.getAttribute('aria-checked'), 'true', 'the Walls tag has a switch, on');
  await walls.click();
  assert.equal((await state3d()).tags.find(t => t.id === 'tag-walls').on, false, 'switching Walls off hides the tag');
  await page.locator('.fd-switch[data-act=tag][data-id="tag-walls"]').click();
  assert.equal((await state3d()).tags.find(t => t.id === 'tag-walls').on, true);
  // Saved views: save the current camera, and its chip appears.
  await page.locator('.fd-chip[data-act=save-view]').click();
  assert.equal(await page.locator('.fd-chip[data-act=view]').count(), 1, 'a saved view chip appears');
  assert.equal(await shown(page, '.v-views'), false, 'the saved view tabs stay off the phone screen');
  // A background sync rebuilds the view; the open panel must stay open under the finger.
  await page.evaluate(() => document.getElementById('property-select').dispatchEvent(new Event('change')));
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('fd-open')), true, 'a rebuild of the same page keeps the panel open');
  assert.equal(await shown(page, '.fd-panel .fd-seg[data-id=walk]'), true);

  await page.locator('.fd-seg[data-id=walk]').click();
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('fd-open')), false, 'choosing Walk closes the panel');
  assert.equal((await state3d()).mode, 'walk');
  assert.equal(await shown(page, '.fd-walk'), true, 'the walk pad shows while walking');
  // Hold a walk button with a finger: the camera walks while it is held and stops on lifting.
  await settled(page);
  const standing = await cameraNow(page);
  const pad = await page.locator('.fd-walk [data-walk=forward]').boundingBox();
  const padAt = [pad.x + pad.width / 2, pad.y + pad.height / 2];
  await finger(page, [padAt, padAt], { holdMs: 1200 });
  assert.equal(await page.locator('.fd-walk [data-walk=forward]').evaluate(b => b.classList.contains('down')), false, 'the button lets go when the finger lifts');
  const walked = await cameraNow(page);
  assert.ok(moved(standing, walked) > 0.1, 'holding Walk forward walks: ' + JSON.stringify([standing.position, walked.position]));
  await page.waitForTimeout(400);
  assert.ok(moved(walked, await cameraNow(page)) < 1e-6, 'and the walk stops when the finger lifts');
  await page.locator('.fd-frame').click();
  assert.equal((await state3d()).mode, 'orbit', 'the overview button leaves walk');
  assert.equal(await shown(page, '.fd-walk'), false, 'and the pad goes away');
  // One finger dragged across the model turns the camera around it.
  await settled(page);
  const before = await cameraNow(page);
  const mid = [vp.width / 2, vp.height / 2];
  await finger(page, Array.from({ length: 13 }, (_, i) => [mid[0] - 90 + i * 15, mid[1] + i * 3]));
  await settled(page);
  const after = await cameraNow(page);
  assert.ok(moved(before, after) > 0.25, 'a one-finger drag orbits the model: ' + JSON.stringify([before.position, after.position]));
  assert.ok(Math.abs(Math.hypot(...before.position.map((v, i) => v - before.target[i])) - Math.hypot(...after.position.map((v, i) => v - after.target[i]))) < 0.05 * Math.hypot(...before.position.map((v, i) => v - before.target[i])),
    'and keeps its distance from the point it turns around');

  // Other pages keep a slim bar with the menu; the panel links there.
  await page.locator('.fd-menu').click();
  await page.locator('.fd-panel a[href="#/plan"]').click();
  await page.waitForFunction(() => document.querySelector('#rail a.active')?.dataset.view === 'plan');
  assert.equal(await page.locator('.fd-title').textContent(), 'Plan');
  assert.equal(await shown(page, '.fd-bar'), true);
  assert.equal(await shown(page, '.fd-frame'), false, 'no overview button off the model');

  // DESKTOP LAYOUT is remembered in this browser; FIELD VIEW goes back.
  await page.locator('.fd-menu').click();
  await page.locator('.fd-desktop').click();
  assert.equal(await shown(page, '#topbar'), true, 'desktop layout brings the topbar back');
  // While a save is running the page asks "Leave site?" and Playwright answers "stay", so the
  // reload never happens. Waiting for SAVED TO DISK is not enough: a save can start after the
  // wait passes. The layout choice lives in this browser, not the project, so leaving is safe.
  await page.waitForFunction(() => document.querySelector('#save-status').textContent === 'SAVED TO DISK');
  const leave = dialog => { if (dialog.type() === 'beforeunload') dialog.accept(); };
  page.on('dialog', leave);
  // The reload is done once the new document arrives ('commit'). Waiting for DOMContentLoaded
  // also waits for every module to load and run, which is the whole app starting with the
  // desktop layout on a 3x phone screen: 22-30 seconds on the Linux CI runner's software
  // graphics, against Playwright's 30-second limit (measured 2026-11-06, five fresh-page loads
  // at 22-26 s and reloads at 29.8 s and over 30 s). That made this check pass or fail by a
  // fraction of a second. The topbar and field-bar waits below prove the reload, with room for
  // the slow start. On a timeout, print what the page and the server were doing.
  const BOOT_MS = 120000;
  try { await page.reload({ waitUntil: 'commit', timeout: BOOT_MS }); }
  catch (error) {
    console.error('Requests still open:', [...pending].map(([r, t]) => r.method() + ' ' + r.url() + ' (' + Math.round(performance.now() - t) + ' ms)'));
    console.error('Page:', await page.evaluate(() => ({ url: location.href, ready: document.readyState, status: document.querySelector('#save-status')?.textContent })).catch(e => String(e)));
    console.error('Server answers directly:', await fetch(url + '/api/instance', { signal: AbortSignal.timeout(5000) }).then(r => r.status).catch(e => String(e)));
    serverErr.length = 0; child.kill('SIGUSR1'); await new Promise(r => setTimeout(r, 1500));
    console.error('Server threads:\n' + serverErr.join('\n'));
    throw error;
  }
  page.off('dialog', leave);
  await page.locator('#topbar').waitFor({ timeout: BOOT_MS });
  // The topbar is in the page before the app has booted. FIELD VIEW only works once the field
  // module has built its bar (after the project files are connected), so wait for that bar: a
  // click before it is just a link to the model, and the phone layout never comes. The layout
  // is only decided by then too, so check it after the bar, not after the topbar.
  await page.locator('.fd-bar').waitFor({ state: 'attached', timeout: BOOT_MS });
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('phone')), false, 'desktop layout survives a reload');
  // The way back is on screen in the desktop layout too (the rail's FIELD VIEW is hidden on a
  // narrow screen): PHONE LAYOUT in the top bar, tapped with a finger.
  assert.equal(await shown(page, '#topbar .fd-return'), true, 'the desktop layout on a phone keeps PHONE LAYOUT on screen');
  const backBox = await page.locator('#topbar .fd-return').boundingBox();
  assert.ok(backBox.width >= 44 && backBox.height >= 44 && backBox.x >= 0 && backBox.x + backBox.width <= page.viewportSize().width, 'and it is a whole finger-sized target on screen: ' + JSON.stringify(backBox));
  await page.locator('#topbar .fd-return').tap();
  await page.waitForFunction(() => document.documentElement.classList.contains('phone') && location.hash === '#/model', null, { timeout: BOOT_MS });
  assert.equal(await page.evaluate(() => localStorage.getItem('tiksi.layout')), null, 'back to following the screen');
  await phone.close();

  // ---------- desktop: unchanged ----------
  const desk = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  desk.on('pageerror', error => errors.push(error.message));
  await desk.goto(url + '/#/model');
  await desk.locator('.v-wrap canvas').waitFor();
  assert.equal(await desk.evaluate(() => document.documentElement.classList.contains('phone')), false);
  for (const sel of ['#topbar', '#rail', '#side', '.v-views', '.v-compass']) assert.equal(await shown(desk, sel), true, sel + ' shows on desktop');
  for (const sel of ['.fd-bar', '.fd-frame', '.fd-panel']) assert.equal(await shown(desk, sel), false, sel + ' stays out of the desktop');
  await desk.locator('#tiksi-menu').click();
  assert.equal(await shown(desk, '.tk-menu [data-field-layout=phone]'), true, 'the phone layout is offered in the Tiksi menu');
  await desk.keyboard.press('Escape');
  assert.equal(await shown(desk, '#topbar .fd-return'), false, 'a computer at full width needs no PHONE LAYOUT button');

  assert.deepEqual(errors, []);
  console.log(`Phone layout passed on ${ENGINE}: opens on a full-screen model with no toolbars; the side panel switches section and x-ray; holding the walk pad walks and lifting stops; a one-finger drag orbits; the overview button frames the model; the panel reaches other pages; desktop layout is remembered and FIELD VIEW returns; desktop is unchanged.`);
} finally {
  if (browser) await browser.close();
  child.kill();
  await rm(state, { recursive: true, force: true });
}
