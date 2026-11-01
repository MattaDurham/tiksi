// Real MODEL gizmo gesture, shared-file acknowledgments and touch-sized controls.
// Synthetic projects and temporary runtime only; never uses the owner's stores.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { chromium } from 'playwright';

const state = await mkdtemp(tmpdir() + '/tiksi-undo-');
const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r));
const port = socket.address().port; await new Promise(r => socket.close(r));
const child = spawn('python3', ['tools/serve.py', '--host', '0.0.0.0', '--port', String(port), '--state-dir', state, '--projects-dir', state + '/projects'], { stdio: 'ignore' });
let browser;
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch('http://127.0.0.1:' + port)).ok) break; } catch {} await new Promise(r => setTimeout(r, 50)); }
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://127.0.0.1:' + port + '/#/plan');
  await page.waitForFunction(() => document.querySelector('#save-status').textContent === 'SAVED TO DISK');
  await page.evaluate(async () => {
    const s = window.undoStore = await import('/js/store.js');
    const p = s.propertyTemplate('Undo test with a long project name'), q = s.propertyTemplate('Other project');
    p.id = 'undo-house'; q.id = 'other-house'; p.env.quality = 'low';
    p.walls.push({ id: 'wall', level: p.levels[0].id, ax: 0, ay: 0, bx: 4, by: 0, thickness: .15, height: null, material: 'mat-drywall' });
    s.ws.data.settings.sketchupMirror = false;
    s.ws.data.properties.push(p, q); s.ws.data.settings.activePropertyId = p.id; s.touch();
    await (await import('/js/disk-workspace.js')).diskWorkspace.sync();
  });
  await page.locator('#rail [data-view=model]').click();
  await page.locator('canvas.v-canvas').waitFor();
  await page.locator('.v-modes [data-mode=top]').click();
  await page.waitForTimeout(900); // finish the camera tween, as in the MODEL interaction checks
  const canvas = page.locator('canvas.v-canvas'), box = await canvas.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.locator('.inspector [data-th]').waitFor();
  await page.locator('[data-act=move]').click();
  // Locate the visible blue Z handle in the rendered canvas, then drag it through
  // real pointer events. No exported test hook bypasses the gizmo's commit path.
  const png = await canvas.screenshot();
  const handle = await page.evaluate(async base64 => {
    const image = new Image(); image.src = 'data:image/png;base64,' + base64; await image.decode();
    const c = document.createElement('canvas'); c.width = image.width; c.height = image.height;
    const g = c.getContext('2d'); g.drawImage(image, 0, 0);
    const pixels = g.getImageData(0, 0, c.width, c.height).data, points = [];
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      const i = (y * c.width + x) * 4, [r, green, b] = pixels.slice(i, i + 3);
      if (b > 100 && b > r * 1.8 && b > green * 1.8) points.push([x, y]);
    }
    if (!points.length) return null;
    const y = points[Math.floor(points.length / 4)][1], row = points.filter(p => Math.abs(p[1] - y) < 2);
    return [row.reduce((sum, p) => sum + p[0], 0) / row.length, y];
  }, png.toString('base64'));
  assert(handle, 'MODEL exposes a visible wall translation handle');
  await page.mouse.move(box.x + handle[0], box.y + handle[1]); await page.mouse.down();
  await page.mouse.move(box.x + handle[0], box.y + handle[1] + 55, { steps: 8 }); await page.mouse.up();
  await page.waitForFunction(() => Math.abs(window.undoStore.activeProperty().walls[0].ay) > .01);
  const moved = await page.evaluate(() => window.undoStore.activeProperty().walls[0].ay);
  await page.waitForFunction(() => document.querySelector('#save-status').textContent === 'SAVED TO DISK');
  assert.equal(await page.locator('#btn-undo').isEnabled(), true, 'self-save keeps history');
  await page.locator('#btn-undo').click();
  assert.equal(await page.evaluate(() => window.undoStore.activeProperty().walls[0].ay), 0);
  assert.equal(await page.locator('#btn-undo').isDisabled(), true, 'one gesture is one undo');
  await page.locator('#rail [data-view=plan]').click();
  await page.locator('#btn-redo').click();
  assert.equal(await page.evaluate(() => window.undoStore.activeProperty().walls[0].ay), moved, 'PLAN redoes the MODEL move');
  await page.selectOption('#property-select', 'other-house'); assert.equal(await page.locator('#btn-undo').isDisabled(), true);
  await page.selectOption('#property-select', 'undo-house'); assert.equal(await page.locator('#btn-undo').isEnabled(), true);
  await page.keyboard.press('ControlOrMeta+z');
  assert.equal(await page.evaluate(() => window.undoStore.activeProperty().walls[0].ay), 0);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  assert.equal(await page.evaluate(() => window.undoStore.activeProperty().walls[0].ay), moved);
  await page.locator('#btn-undo').click();
  await page.waitForFunction(() => document.querySelector('#save-status').textContent === 'SAVED TO DISK');

  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const phone = await context.newPage(); phone.on('pageerror', e => errors.push(e.message));
  await phone.goto('http://localhost:' + port + '/#/plan');
  await phone.waitForFunction(() => document.querySelector('#save-status').textContent === 'SAVED TO DISK');
  await phone.evaluate(async () => { window.undoStore = await import('/js/store.js'); });
  const mobileUndo = await phone.locator('#btn-undo').boundingBox(), mobileRedo = await phone.locator('#btn-redo').boundingBox();
  for (const rect of [mobileUndo, mobileRedo]) { assert(rect && rect.height >= 44 && rect.y >= 0 && rect.y + rect.height < 200); assert(rect.x >= 0 && rect.x + rect.width <= 390); }
  const plan = phone.locator('.plan-canvas'), pbox = await plan.boundingBox();
  const zoom = Math.min((pbox.width - 22) / (4 * 1.22), (pbox.height - 22) / 1.22, 250);
  await phone.touchscreen.tap(pbox.x + pbox.width / 2, pbox.y + pbox.height / 2 - zoom / 2 + 11);
  const thickness = phone.locator('.inspector [data-len=th]'); await thickness.fill('8"'); await thickness.press('Tab');
  await phone.waitForFunction(() => document.querySelector('#save-status').textContent === 'SAVED TO DISK');
  await phone.locator('#btn-undo').tap();
  assert.equal(await phone.evaluate(() => window.undoStore.activeProperty().walls[0].thickness), .15);
  await phone.locator('#btn-redo').tap();
  assert.equal(await phone.evaluate(() => window.undoStore.activeProperty().walls[0].thickness), .2032);
  await phone.waitForFunction(() => document.querySelector('#save-status').textContent === 'SAVED TO DISK');
  await page.waitForFunction(() => window.undoStore.activeProperty().walls[0].thickness === .2032);
  assert.equal(await page.locator('#btn-redo').isEnabled(), true, 'independent remote material/width edits preserve redo');
  await page.locator('#btn-redo').click();
  assert.equal(await page.evaluate(() => window.undoStore.activeProperty().walls[0].thickness), .2032);
  assert.equal(await page.evaluate(() => window.undoStore.activeProperty().walls[0].ay), moved);
  await page.evaluate(async () => { const s = window.undoStore; s.mergeWorkspace(JSON.parse(JSON.stringify(s.ws.data))); });
  assert.equal(await page.locator('#btn-undo').isDisabled(), true, 'opening/reimporting a project clears its previous session history');
  for (const width of [320, 800, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.locator('#topbar').evaluate(el => el.scrollWidth <= el.clientWidth), true, 'history controls fit header at ' + width);
  }
  assert.deepEqual(errors, []);
  console.log('ok   MODEL wall gesture, PLAN/MODEL shared undo, disk saves, independent shared edits, project isolation, mobile Undo/Redo and shortcuts');
} finally {
  if (browser) await browser.close(); child.kill();
  await new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve));
  await rm(state, { recursive: true, force: true });
}
