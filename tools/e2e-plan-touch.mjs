// PLAN with a finger, on a phone-sized screen: real touch input through Chromium's touch
// emulation (the browser turns these into the same pointer events, scrolling and page zoom
// a phone would). One finger pans the plan, two fingers pinch it, a tap selects a wall or a
// window whose size is then typed, a finger drag never moves a wall, taps place a wall, and
// none of it scrolls or zooms the page.
// A synthetic 6 x 4 m house split by a partition at x = 3, with a window on the east wall.
// Ephemeral origin and browser profile; no live state.
// Run: node tools/e2e-plan-touch.mjs (Playwright + Chromium installed). E2E_ROOT serves another
// checkout's files instead of this one. E2E_WEBKIT=1 also taps through Playwright's WebKit
// (Safari's engine) with an iPhone profile, when that browser is installed.
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname, sep } from 'node:path';
import { chromium, webkit, devices } from 'playwright';

const root = resolve(process.env.E2E_ROOT || fileURLToPath(new URL('../', import.meta.url)));
const server = http.createServer(async (req, res) => {
  const path = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
  if (!path.startsWith(root + sep) && path !== root) { res.writeHead(404).end(); return; }
  try {
    const file = path === root ? resolve(root, 'index.html') : path;
    const bytes = await readFile(file);
    res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.wasm': 'application/wasm' })[extname(file)] || 'application/octet-stream');
    res.end(bytes);
  } catch { res.writeHead(404).end(); }
});

const RULER = 22;   // plan2d.js: rulers along the top and left canvas edges
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
const { defaultBrowserType, ...iphone } = devices['iPhone 13'];
void defaultBrowserType;

async function openHouse(page, url) {
  await page.goto(url + '/#/budget');
  await page.locator('#view').waitFor();
  await page.evaluate(async () => {
    const s = await import('/js/store.js');
    const p = s.activeProperty();
    s.ensureLevels(p);
    const level = p.levels[0].id;
    p.activeLevelId = level;
    p.levels = [p.levels[0]];
    p.levels[0].plan = null;
    const wall = (id, ax, ay, bx, by, thickness = 0.114) => ({ id, level, ax, ay, bx, by, thickness, height: null, material: null });
    p.walls = [
      wall('south', 0, 0, 6, 0, 0.165), wall('east', 6, 0, 6, 4, 0.165),
      wall('north', 6, 4, 0, 4, 0.165), wall('west', 0, 4, 0, 0, 0.165), wall('mid', 3, 0, 3, 4),
    ];
    p.openings = [{ id: 'win', wallId: 'east', t: 0.5, type: 'window', width: 0.914, height: 1.219, sill: 0.762 }];
    p.rooms = []; p.fixtures = []; p.photoPositions = [];
    s.touch();
  });
  await page.evaluate(() => { location.hash = '#/plan'; });
  await page.locator('.plan-canvas canvas').waitFor();
  await page.evaluate(() => Promise.all(document.getAnimations().map(a => a.finished.catch(() => {}))));
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  // FIT VIEW (the F key and the tool button do the same).
  await page.locator('.tool-col [data-act=fit]').dispatchEvent('click');
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
}

// The plan's view, worked out from FIT VIEW's rule (plan2d.js fitFor) for the house's bounds,
// then followed through each gesture: the test predicts where things are and taps there.
async function viewModel(page) {
  const wrap = await page.locator('.plan-canvas').evaluate(e => ({ w: e.clientWidth, h: e.clientHeight }));
  const b = { minX: 0, minY: 0, maxX: 6, maxY: 4 };
  const w = wrap.w - RULER, h = wrap.h - RULER, bw = b.maxX - b.minX, bh = b.maxY - b.minY;
  const zoom = Math.min(w / (bw * 1.22), h / (bh * 1.22), 250);
  return { zoom, panX: b.minX - (w / zoom - bw) / 2 - RULER / zoom, panY: b.minY - (h / zoom - bh) / 2 - RULER / zoom };
}
const scrollState = page => page.evaluate(() => ({
  window: [window.scrollX, window.scrollY],
  page: document.scrollingElement ? document.scrollingElement.scrollTop : 0,
  layout: document.querySelector('.editor-layout')?.scrollTop || 0,
  view: document.querySelector('#view')?.scrollTop || 0,
  scale: window.visualViewport ? window.visualViewport.scale : 1,
}));
const geometry = page => page.evaluate(async () => {
  const s = await import('/js/store.js');
  const p = s.activeProperty();
  return { walls: Object.fromEntries(p.walls.map(w => [w.id, [w.ax, w.ay, w.bx, w.by]])), openings: Object.fromEntries(p.openings.map(o => [o.id, { t: o.t, width: o.width }])) };
});

let browser;
try {
  await new Promise(r => server.listen(Number(process.env.E2E_APP_PORT) || 0, 'localhost', r));
  const url = `http://localhost:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  await openHouse(page, url);
  assert.ok(await page.evaluate(() => document.documentElement.classList.contains('phone')), 'the phone layout is on');
  assert.equal(await page.locator('.plan-canvas canvas').evaluate(c => getComputedStyle(c).touchAction), 'none', 'the plan tells the browser it handles its own touches');
  assert.match(await page.locator('.canvas-hint').innerText(), /^Tap /, 'on a phone the hint speaks of taps before the first touch');

  const cdp = await context.newCDPSession(page);
  const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], id) => ({ x, y, id, radiusX: 4, radiusY: 4, force: 1 })) });
  const pause = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  async function fingerTap(x, y) { await touch('touchStart', [[x, y]]); await touch('touchEnd', []); await pause(); await page.waitForTimeout(400); }   // apart from a double tap
  async function fingerDrag(from, to, steps = 10) {
    await touch('touchStart', [from]);
    for (let i = 1; i <= steps; i++) await touch('touchMove', [[from[0] + (to[0] - from[0]) * i / steps, from[1] + (to[1] - from[1]) * i / steps]]);
    await touch('touchEnd', []);
    await pause();
  }
  async function pinch(mid, d0, d1, steps = 10) {
    const pts = d => [[mid[0] - d / 2, mid[1]], [mid[0] + d / 2, mid[1]]];
    await touch('touchStart', [pts(d0)[0]]);
    await touch('touchStart', pts(d0));
    for (let i = 1; i <= steps; i++) await touch('touchMove', pts(d0 + (d1 - d0) * i / steps));
    await touch('touchEnd', [pts(d1)[1]]);
    await touch('touchEnd', []);
    await pause();
  }

  const box = await page.locator('.plan-canvas canvas').boundingBox();
  const v = await viewModel(page);
  const at = (x, y) => [box.x + (x - v.panX) * v.zoom, box.y + (y - v.panY) * v.zoom];
  const inspector = () => page.locator('.inspector').innerText();
  const startScroll = await scrollState(page);
  const startGeo = await geometry(page);

  // 1. A tap on the partition selects it; its length is typed in the side field.
  await fingerTap(...at(3, 2.5));
  assert.match(await inspector(), /^WALL/, 'a tap selects the wall under the finger');
  assert.deepEqual(await scrollState(page), startScroll, 'a tap does not scroll the page');
  const len = page.locator('.inspector [data-len=len]');
  await len.fill('3m');
  await len.press('Enter');
  let geo = await geometry(page);
  near(Math.hypot(geo.walls.mid[2] - geo.walls.mid[0], geo.walls.mid[3] - geo.walls.mid[1]), 3, 0.01, 'the typed length is applied');
  await page.evaluate(async () => { const s = await import('/js/store.js'); Object.assign(s.activeProperty().walls.find(w => w.id === 'mid'), { ax: 3, ay: 0, bx: 3, by: 4 }); s.touch(); });
  // Typing scrolled the page to the field; put it back where the plan was before going on.
  await page.evaluate(s => { const l = document.querySelector('.editor-layout'); if (l) l.scrollTop = s.layout; window.scrollTo(...s.window); }, startScroll);
  await pause();
  assert.deepEqual(await scrollState(page), startScroll);

  // 2. A finger drag that starts on the partition pans the plan; the wall stays where it is.
  const panFrom = at(3, 2.5), panBy = [-20, -50];
  await fingerDrag(panFrom, [panFrom[0] + panBy[0], panFrom[1] + panBy[1]]);
  geo = await geometry(page);
  assert.deepEqual(geo.walls, startGeo.walls, 'a finger never drags a wall');
  assert.deepEqual(await scrollState(page), startScroll, 'a one-finger drag on the plan does not scroll the page');
  v.panX -= panBy[0] / v.zoom; v.panY -= panBy[1] / v.zoom;
  // The plan moved with the finger: a tap where the window now is selects it.
  await fingerTap(...at(6, 2));
  assert.match(await inspector(), /^WINDOW/, 'after the pan, the window is under its new screen position');
  const width = page.locator('.inspector [data-len=w]');
  await width.fill('30"');
  await width.press('Enter');
  near((await geometry(page)).openings.win.width, 0.762, 0.001, 'the typed window width is applied');
  await page.evaluate(s => { const l = document.querySelector('.editor-layout'); if (l) l.scrollTop = s.layout; window.scrollTo(...s.window); }, startScroll);
  await pause();

  // 3. Two fingers spreading from 60 to 180 px zoom the plan 3x about their middle; the page
  //    itself does not zoom or scroll.
  await fingerTap(...at(1.5, 2));   // clear the selection (an empty floor)
  const mid = at(2.5, 2), oldMid = at(3, 2);
  await pinch(mid, 60, 180);
  assert.deepEqual(await scrollState(page), startScroll, 'a pinch on the plan does not zoom or scroll the page');
  const world = [(mid[0] - box.x) / v.zoom + v.panX, (mid[1] - box.y) / v.zoom + v.panY];
  v.zoom *= 3;
  v.panX = world[0] - (mid[0] - box.x) / v.zoom; v.panY = world[1] - (mid[1] - box.y) / v.zoom;
  // Where the partition was before the pinch there is now empty floor; it is where the zoom put it.
  await fingerTap(...oldMid);
  assert.doesNotMatch(await inspector(), /^WALL|^WINDOW/, 'the partition is no longer at its old screen position');
  await fingerTap(...at(3, 2));
  assert.match(await inspector(), /^WALL/, 'after the pinch, the partition is where a 3x zoom about the fingers put it');

  // 4. WALL by taps: tap, tap, double tap ends the chain; one new wall of the right length.
  //    (On screen at the new zoom: 0.5 m and 0.1 m left of the pinch's middle.)
  await page.locator('.tool-col [data-tool=wall]').dispatchEvent('click');
  const count = Object.keys((await geometry(page)).walls).length;
  await fingerTap(...at(1.9, 1.2));
  await fingerTap(...at(2.6, 1.2));
  const end = at(2.6, 1.2);
  await touch('touchStart', [end]); await touch('touchEnd', []);
  await page.waitForTimeout(80);
  await touch('touchStart', [end]); await touch('touchEnd', []);
  await pause();
  geo = await geometry(page);
  const added = Object.entries(geo.walls).filter(([id]) => !(id in startGeo.walls));
  assert.equal(Object.keys(geo.walls).length, count + 1, 'taps placed exactly one wall');
  near(Math.hypot(added[0][1][2] - added[0][1][0], added[0][1][3] - added[0][1][1]), 0.7, 0.03, 'the tapped wall is 0.7 m long');
  assert.match(await page.locator('.canvas-hint').innerText(), /Tap to start a wall chain/, 'the double tap ended the chain');
  assert.deepEqual(await scrollState(page), startScroll, 'drawing by taps does not scroll the page');
  await page.locator('.tool-col [data-tool=select]').dispatchEvent('click');

  assert.deepEqual(errors, [], 'no page errors');
  console.log('PLAN by finger (Chromium touch): tap selects and sizes are typed, one-finger pan, pinch zoom, taps draw a wall, no page scroll.');
  await context.close();

  // 5. A touchscreen laptop (or a tablet with a pen): a finger that lands while the mouse drags
  //    the partition is ignored, and the mouse drag carries on to its end.
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, hasTouch: true });
    const pg = await ctx.newPage();
    const errs = []; pg.on('pageerror', e => errs.push(e.message));
    await openHouse(pg, url);
    assert.ok(!(await pg.evaluate(() => document.documentElement.classList.contains('phone'))), 'the desktop layout is on');
    const cd = await ctx.newCDPSession(pg);
    const t = (type, points) => cd.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
    const bx = await pg.locator('.plan-canvas canvas').boundingBox();
    const vw = await viewModel(pg);
    const wat = (x, y) => [bx.x + (x - vw.panX) * vw.zoom, bx.y + (y - vw.panY) * vw.zoom];
    await pg.mouse.move(...wat(3, 2.5)); await pg.mouse.down();
    await pg.mouse.move(...wat(3.5, 2.5), { steps: 6 });
    // A finger taps empty floor (it would clear the selection) while the button is still down.
    await t('touchStart', [wat(1.2, 1.2)]); await t('touchEnd', []);
    await pg.mouse.move(...wat(4.2, 2.5), { steps: 8 });
    await pg.mouse.up();
    const mid = (await geometry(pg)).walls.mid;
    near(mid[0], 4.2, 0.02, 'the mouse drag carried the partition all the way');
    assert.match(await pg.locator('.inspector').innerText(), /^WALL/, 'the finger did not clear the selection');
    const undo = await pg.evaluate(async () => { const h = await import('/js/edit-history.js'), s = await import('/js/store.js'); return h.editHistoryState(s.activeProperty()).undo.available; });
    assert.ok(undo, 'the drag was recorded, so it is saved and can be undone');
    assert.deepEqual(errs, [], 'no page errors');
    await ctx.close();
    console.log('PLAN with mouse and finger together: a finger under a mouse drag is ignored.');
  }

  if (process.env.E2E_WEBKIT) {
    // Safari's engine with an iPhone profile: Playwright drives real taps there; pans and
    // pinches go in as the touch pointer events Safari sends.
    let wk;
    try { wk = await webkit.launch({ headless: true }); } catch (e) { throw new Error('E2E_WEBKIT is set but WebKit is not installed: ' + e.message); }
    try {
      const ctx = await wk.newContext(iphone);
      const p = await ctx.newPage();
      const errs = []; p.on('pageerror', e => errs.push(e.message));
      await openHouse(p, url);
      assert.ok(await p.evaluate(() => document.documentElement.classList.contains('phone')), 'WebKit: the phone layout is on');
      assert.equal(await p.locator('.plan-canvas canvas').evaluate(c => getComputedStyle(c).touchAction), 'none', 'WebKit: the plan handles its own touches');
      const bx = await p.locator('.plan-canvas canvas').boundingBox();
      const vw = await viewModel(p);
      const wat = (x, y) => [bx.x + (x - vw.panX) * vw.zoom, bx.y + (y - vw.panY) * vw.zoom];
      const scroll0 = await scrollState(p);
      await p.touchscreen.tap(...wat(3, 2.5));
      await p.waitForTimeout(400);
      assert.match(await p.locator('.inspector').innerText(), /^WALL/, 'WebKit: a tap selects the wall');
      // A one-finger pan as Safari's pointer events, then a tap at the window's new place.
      await p.evaluate(([from, by]) => {
        const c = document.querySelector('.plan-canvas canvas');
        const ev = (type, x, y) => c.dispatchEvent(new PointerEvent(type, { pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, bubbles: true, cancelable: true, buttons: type === 'pointerup' ? 0 : 1 }));
        ev('pointerdown', ...from);
        for (let i = 1; i <= 8; i++) ev('pointermove', from[0] + by[0] * i / 8, from[1] + by[1] * i / 8);
        ev('pointerup', from[0] + by[0], from[1] + by[1]);
      }, [wat(3, 2.5), [-30, -40]]);
      vw.panX += 30 / vw.zoom; vw.panY += 40 / vw.zoom;
      await p.waitForTimeout(400);
      await p.touchscreen.tap(...wat(6, 2));
      await p.waitForTimeout(400);
      assert.match(await p.locator('.inspector').innerText(), /^WINDOW/, 'WebKit: the pan moved the plan under the finger');
      assert.deepEqual((await geometry(p)).walls, startGeo.walls, 'WebKit: no wall moved');
      assert.deepEqual(await scrollState(p), scroll0, 'WebKit: the page did not scroll');
      assert.deepEqual(errs, [], 'WebKit: no page errors');
      console.log('PLAN by finger (WebKit, iPhone 13 profile): tap selects, pan moves the plan, no page scroll.');
    } finally { await wk.close(); }
  }
} finally {
  if (browser) await browser.close();
  await new Promise(r => server.close(r));
}
