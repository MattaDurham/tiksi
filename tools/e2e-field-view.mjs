// Phone layout: on a phone the console opens on the model with no toolbars, and one side panel
// moves the camera, flips what shows and reaches the other pages. Desktop is unchanged.
// Synthetic demo project in a temporary state directory; live 8642 is never used.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { chromium, devices } from 'playwright';

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
try {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url)).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
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
  assert.equal(await shown(page, '#rail'), false, 'no rail on a phone');
  assert.equal(await page.locator('#rail a.active').getAttribute('data-view'), 'model', 'a phone opens on the model');
  // FILE must still open from the panel with nothing to show yet, so a property can be added.
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
  await page.locator('.fd-frame').click();
  assert.equal((await state3d()).mode, 'orbit', 'the overview button leaves walk');
  assert.equal(await shown(page, '.fd-walk'), false, 'and the pad goes away');

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
  // Wait for the document, not for every image and module: the topbar check below is what
  // proves the reload. On a timeout, print what the page and the server were doing.
  try { await page.reload({ waitUntil: 'domcontentloaded' }); }
  catch (error) {
    console.error('Requests still open:', [...pending].map(([r, t]) => r.method() + ' ' + r.url() + ' (' + Math.round(performance.now() - t) + ' ms)'));
    console.error('Page:', await page.evaluate(() => ({ url: location.href, ready: document.readyState, status: document.querySelector('#save-status')?.textContent })).catch(e => String(e)));
    console.error('Server answers directly:', await fetch(url + '/api/instance', { signal: AbortSignal.timeout(5000) }).then(r => r.status).catch(e => String(e)));
    serverErr.length = 0; child.kill('SIGUSR1'); await new Promise(r => setTimeout(r, 1500));
    console.error('Server threads:\n' + serverErr.join('\n'));
    throw error;
  }
  page.off('dialog', leave);
  await page.locator('#topbar').waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('phone')), false, 'desktop layout survives a reload');
  await page.locator('[data-field-layout=phone]').evaluate(a => a.click());
  await page.waitForFunction(() => document.documentElement.classList.contains('phone') && location.hash === '#/model');
  assert.equal(await page.evaluate(() => localStorage.getItem('tiksi.layout')), null, 'back to following the screen');
  await phone.close();

  // ---------- desktop: unchanged ----------
  const desk = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  desk.on('pageerror', error => errors.push(error.message));
  await desk.goto(url + '/#/model');
  await desk.locator('.v-wrap canvas').waitFor();
  assert.equal(await desk.evaluate(() => document.documentElement.classList.contains('phone')), false);
  for (const sel of ['#topbar', '#rail', '.v-views', '.v-compass']) assert.equal(await shown(desk, sel), true, sel + ' shows on desktop');
  for (const sel of ['.fd-bar', '.fd-frame', '.fd-panel']) assert.equal(await shown(desk, sel), false, sel + ' stays out of the desktop');
  assert.equal(await shown(desk, '[data-field-layout=phone]'), true, 'FIELD VIEW is offered in the rail');

  assert.deepEqual(errors, []);
  console.log('Phone layout passed: opens on a full-screen model with no toolbars; the side panel switches section and x-ray, walks with a pad, frames the model and reaches other pages; desktop layout is remembered and FIELD VIEW returns; desktop is unchanged.');
} finally {
  if (browser) await browser.close();
  child.kill();
  await rm(state, { recursive: true, force: true });
}
