// MODEL's wall move handle keeps PLAN's 5 cm rule: sliding a wall past the wall opposite it
// would squeeze the two walls joining them to nothing (and turn them over), so that slide is
// refused; a short slide toward it still works. Real pointer events on the rendered handle.
// Synthetic project and temporary runtime only; never uses the owner's stores.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { chromium } from 'playwright';

const root = process.env.E2E_ROOT || process.cwd();
const state = await mkdtemp(tmpdir() + '/tiksi-shortwall-');
const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r));
const port = Number(process.env.E2E_APP_PORT) || socket.address().port; await new Promise(r => socket.close(r));
const child = spawn('python3', ['tools/serve.py', '--port', String(port), '--state-dir', state, '--projects-dir', state + '/projects'], { cwd: root, stdio: 'ignore' });
let browser;
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch('http://127.0.0.1:' + port)).ok) break; } catch {} await new Promise(r => setTimeout(r, 50)); }
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.addInitScript(() => localStorage.setItem('tiksi.onScreen.v1', '{"all":true}'));
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://127.0.0.1:' + port + '/#/plan');
  await page.waitForFunction(() => document.querySelector('#save-status').textContent === 'SAVED TO DISK');
  // A 4 m wall at y = 0 (the middle of the view), joined by two 0.3 m walls to a wall at
  // y = -0.3; a loose wall at y = 0.3 balances the view so the middle wall is under its centre.
  await page.evaluate(async () => {
    const s = window.testStore = await import('/js/store.js');
    const p = s.propertyTemplate('Short wall test');
    p.id = 'short-wall-house'; p.env.quality = 'low';
    const level = p.levels[0].id, wall = (id, ax, ay, bx, by, thickness = .1) => ({ id, level, ax, ay, bx, by, thickness, height: null, material: 'mat-drywall' });
    p.walls.push(wall('mover', -2, 0, 2, 0, .2), wall('left', -2, 0, -2, -0.3), wall('right', 2, 0, 2, -0.3), wall('base', -2, -0.3, 2, -0.3), wall('far', -2, 0.3, 2, 0.3));
    s.ws.data.settings.sketchupMirror = false;
    s.ws.data.properties.push(p); s.ws.data.settings.activePropertyId = p.id; s.touch();
    await (await import('/js/disk-workspace.js')).diskWorkspace.sync();
  });
  await page.locator('#rail [data-view=model]').click();
  await page.locator('canvas.v-canvas').waitFor();
  await page.locator('.v-modes [data-mode=top]').click();
  await page.waitForTimeout(900);
  const canvas = page.locator('canvas.v-canvas'), box = await canvas.boundingBox();
  // Click up and down the middle of the view until the 20 cm thick wall ('mover') is selected.
  const want = await page.evaluate(() => window.testStore.fmtLen(.2));
  let picked = false;
  for (let dy = 0; dy <= 120 && !picked; dy = dy > 0 ? -dy : -dy + 4) {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2 + dy);
    const th = page.locator('.inspector [data-th]');
    picked = (await th.count()) > 0 && (await th.inputValue()) === want;
  }
  assert.ok(picked, 'the joined wall is selected');
  await page.locator('[data-act=move]').click();
  await page.waitForTimeout(300);
  const walls = () => page.evaluate(() => Object.fromEntries(window.testStore.activeProperty().walls.map(w => [w.id, [w.ax, w.ay, w.bx, w.by]])));
  const start = await walls();
  // The visible blue handle, found in the rendered picture (as the undo/redo check does).
  async function handle() {
    const png = await canvas.screenshot();
    const h = await page.evaluate(async base64 => {
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
    assert(h, 'MODEL shows the wall move handle');
    return [box.x + h[0], box.y + h[1]];
  }
  async function dragBy(dy) {
    const [x, y] = await handle();
    await page.mouse.move(x, y); await page.mouse.down();
    await page.mouse.move(x, y + dy, { steps: 10 }); await page.mouse.up();
    await page.waitForTimeout(400);
  }
  // A short drag tells which way on screen is toward the base wall; it is allowed either way.
  await dragBy(24);
  let now = await walls();
  const moved = now.mover[1] - start.mover[1];
  assert.ok(Math.abs(moved) > 0.01 && Math.abs(moved) < 0.25, `a short slide moves the wall (${moved} m)`);
  const toward = moved < 0 ? 1 : -1;   // screen direction that lowers y, toward the base wall
  // A long drag toward the base wall, well past it.
  const before = now;
  await dragBy(toward * 220);
  now = await walls();
  assert.deepEqual(now, before, 'a slide past the opposite wall is refused: no wall moved');
  for (const id of ['left', 'right']) {
    const [ax, ay, bx, by] = now[id];
    assert.ok(Math.hypot(bx - ax, by - ay) >= 0.05, `${id} keeps its length`);
  }
  assert.match(await page.locator('.v-toast').innerText(), /cannot be shorter/, 'MODEL says why');
  assert.deepEqual(errors, [], 'no page errors');
  console.log('ok   MODEL wall slide keeps joined walls at least 5 cm long');
} finally {
  if (browser) await browser.close();
  child.kill('SIGTERM');
  await rm(state, { recursive: true, force: true });
}
