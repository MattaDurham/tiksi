// Long presses use synthetic hosts, so this checks the input/preview/save contract without
// a GPU, project files or the owner's stores. A press can span records but remains one undo.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = createServer(async (req, res) => {
  if (req.url === '/') {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><title>Long ink check</title><style>body{margin:0;background:white}#wrap{position:relative;width:640px;height:400px}#surface{display:block;width:640px;height:400px}</style><div id="wrap"><canvas id="surface" width="640" height="400"></canvas></div>');
    return;
  }
  const path = resolve(root, '.' + decodeURIComponent(req.url.split('?')[0]));
  if (!path.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  try {
    const bytes = await readFile(path);
    res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.css': 'text/css' })[extname(path)] || 'application/octet-stream'); res.end(bytes);
  } catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(Number(process.env.E2E_APP_PORT) || 0, '127.0.0.1', r));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const setup = async kind => {
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(async kind => {
      const { attachMarkup, ready } = await import('/js/markup-layer.js');
      const store = await import('/js/store.js');
      store.ws.data = store.emptyWorkspace();
      const prop = store.propertyTemplate('Long ink check');
      store.ws.data.properties.push(prop); store.ws.data.settings.activePropertyId = prop.id;
      const wrap = document.querySelector('#wrap'), surface = document.querySelector('#surface');
      const camera = { position: [0, 0, 5], target: [0, 0, 0], fov: 50 };
      const view = { camera, mode: 'orbit', section: { on: false, height: 1.2 }, xray: false, hiddenLevels: [], tags: {} };
      const notices = [], hits = [];
      const layer = attachMarkup({
        kind, wrap, surface, prop: () => prop, changed() {}, hint() {}, toast: text => notices.push(text), goTo() {},
        levelId: () => prop.levels[0].id, toDoc: (x, y) => [x / 100, y / 100], toPx: (x, y) => [x * 100, y * 100], unit: () => 100, viewKey: () => 'fixed',
        camera: () => camera, viewNow: () => view,
        rayAt: (x, y) => ({ o: [x / 100, y / 100, 1], d: [0, 0, -1] }),
        surfaceAt(x, y) { const hit = { p: [x / 100, y / 100, 0], n: [0, 0, 1], kind: 'wall', ref: 'synthetic-face' }; hits.push(hit.p); return hit; },
        project: p => [p.x * 100, p.y * 100], mPerPx: () => 0.01, showSurfaces() {},
      });
      await ready;
      layer.setOn(true); layer.frame();
      const emit = (type, x, y, pressure = 0.5) => surface.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerType: 'pen', pointerId: 7, isPrimary: true,
        button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y, pressure,
      }));
      window.inkCheck = { prop, layer, notices, hits, emit };
    }, kind);
  };

  await setup('plan');
  const plan = await page.evaluate(() => {
    const h = window.inkCheck;
    h.emit('pointerdown', 20, 100, 0.1);
    // Repeated pressure changes on tight zigzags cannot legitimately collapse into a few
    // points. The final tail is deliberately distinct from every preceding point.
    for (let i = 1; i <= 5000; i++) h.emit('pointermove', 20 + i * 0.08, 100 + (i % 2) * 8, i % 2 ? 0.9 : 0.1);
    h.emit('pointermove', 560, 180, 0.4); h.emit('pointerup', 560, 180, 0.4);
    const before = JSON.parse(JSON.stringify(h.prop.markups));
    const state = h.layer.state();
    h.layer.undo(); const undone = h.prop.markups.length;
    h.layer.redo(); const redone = JSON.parse(JSON.stringify(h.prop.markups));
    return { before, state, undone, redone, notices: h.notices };
  });
  assert.equal(plan.before.length, 1);
  const planStrokes = plan.before[0].strokes;
  assert.ok(planStrokes.length > 1, 'a long press is saved across records');
  assert.ok(planStrokes.every(s => s.pts.length <= 3000 * 3 && s.pts.length >= 3));
  assert.ok(planStrokes.reduce((n, s) => n + s.pts.length / 3, 0) > 4000, 'meaningful pressure detail survives');
  assert.deepEqual(planStrokes.at(-1).pts.slice(-3), [5.6, 1.8, 0.4], 'the final tail is not silently truncated');
  assert.equal(plan.state.undo, 1); assert.equal(plan.undone, 0, 'one undo removes every chunk from the press');
  assert.deepEqual(plan.redone, plan.before, 'one redo restores the complete mark in order');
  assert.deepEqual(plan.notices, [], 'an ordinary long press below the cap does not warn');

  await setup('model');
  const limited = await page.evaluate(() => {
    const h = window.inkCheck;
    h.emit('pointerdown', 20, 100);
    for (let i = 1; i <= 8000; i++) h.emit('pointermove', 20 + i * 0.05, 100 + (i % 2) * 2);
    return { state: h.layer.state(), notices: h.notices, readings: h.hits.length, acceptedTail: h.hits.at(-1) };
  });
  assert.equal(limited.state.surfaceLock, true, 'new surface presses stay on their starting face');
  assert.equal(limited.readings, 12001, 'one initial face lookup plus the bounded surface samples');
  assert.equal(limited.notices.length, 1);
  assert.match(limited.notices[0], /limit.*lift.*kept/i, 'the user is told to lift, with ink retained');
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  const beforeLimitMove = await page.screenshot({ clip: { x: 0, y: 0, width: 640, height: 220 } });
  await page.evaluate(() => { const h = window.inkCheck; for (let i = 0; i < 20; i++) h.emit('pointermove', 500 + i, 180); });
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  const afterLimitMove = await page.screenshot({ clip: { x: 0, y: 0, width: 640, height: 220 } });
  assert.deepEqual(afterLimitMove, beforeLimitMove, 'the live preview stops accepting ink at the announced limit');
  const surface = await page.evaluate(() => {
    const h = window.inkCheck;
    h.emit('pointerup', 519, 180);
    const saved = JSON.parse(JSON.stringify(h.prop.markups));
    const readings = h.hits.length, state = h.layer.state();
    h.layer.undo(); const undone = h.prop.markups.length;
    h.emit('pointerdown', 500, 180); h.emit('pointermove', 540, 180); h.emit('pointerup', 540, 180);
    return { saved, readings, state, undone, next: h.prop.markups, notices: h.notices };
  });
  assert.equal(surface.readings, limited.readings, 'ignored movements and release add no hidden ink');
  const surfaceStrokes = surface.saved[0].strokes;
  assert.ok(surfaceStrokes.length > 1 && surfaceStrokes.every(s => s.w.length <= 3000 * 3));
  const savedTail = surfaceStrokes.at(-1).w.slice(-3);
  assert.ok(Math.abs(savedTail[0] - limited.acceptedTail[0]) <= 0.0001 && Math.abs(savedTail[1] - limited.acceptedTail[1]) <= 0.0001,
    'the saved tail is the last accepted point of the frozen preview');
  assert.ok(surfaceStrokes.every(s => s.normal[2] === 1 && s.on.every(h => h.id === 'synthetic-face')));
  assert.equal(surface.state.undo, 1); assert.equal(surface.undone, 0, 'one undo removes the capped press');
  assert.deepEqual(surface.next[0].strokes.at(-1).w.slice(-3), [5.4, 1.8, 0.004], 'lifting starts a fresh stroke normally');
  assert.equal(surface.notices.length, 1, 'the cap is announced only once for a press');
  assert.deepEqual(errors, []);
  console.log('Markup limits: complete long-stroke tails, bounded records, one-step undo/redo, visible surface cap and lift-to-continue passed.');
} finally {
  await browser.close();
  await new Promise(r => server.close(r));
}
