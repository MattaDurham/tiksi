// Plan editing on the real canvas: what a click and a drag do in the SELECT tool.
// A synthetic 6 x 4 m house split by a partition at x = 3, two floors drawn on the wall
// centre lines and a tracing underlay. Ephemeral origin and browser profile; no live state.
// Run: node tools/e2e-plan-editing.mjs (Playwright + Chromium installed).
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname, sep } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
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

let browser;
try {
  await new Promise(r => server.listen(Number(process.env.E2E_APP_PORT) || 0, 'localhost', r));
  const url = `http://localhost:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  await page.goto(url + '/#/budget');
  await page.locator('#cap-input').waitFor();

  // The synthetic house replaces the active property's geometry before PLAN mounts.
  await page.evaluate(async () => {
    const s = await import('/js/store.js');
    const p = s.activeProperty();
    s.ensureLevels(p);
    const level = p.levels[0].id;
    p.activeLevelId = level;
    p.levels = [p.levels[0]];
    const wall = (id, ax, ay, bx, by, thickness = 0.114) => ({ id, level, ax, ay, bx, by, thickness, height: null, material: null });
    p.walls = [
      wall('south', 0, 0, 6, 0, 0.165), wall('east', 6, 0, 6, 4, 0.165),
      wall('north', 6, 4, 0, 4, 0.165), wall('west', 0, 4, 0, 0, 0.165), wall('mid', 3, 0, 3, 4),
    ];
    p.openings = [];
    p.rooms = [
      { id: 'left', level, name: 'Left', material: 'mat-oak', pts: [[0, 0], [3, 0], [3, 4], [0, 4]] },
      { id: 'right', level, name: 'Right', material: 'mat-oak', pts: [[3, 0], [6, 0], [6, 4], [3, 4]] },
    ];
    // A 10 x 8 m underlay with a 2 m margin around the house.
    const c = document.createElement('canvas'); c.width = c.height = 4;
    const g = c.getContext('2d'); g.fillStyle = '#ffffff'; g.fillRect(0, 0, 4, 4);
    p.levels[0].plan = { img: c.toDataURL('image/png'), imgW: 10, imgH: 8, mPerPx: 1, opacity: 0.5, offsetX: -2, offsetY: -2, calibrated: true };
    s.touch();
  });
  await page.locator('#rail a[data-view="plan"]').click({ noWaitAfter: true });
  const canvasLoc = page.locator('.plan-canvas canvas');
  await canvasLoc.waitFor();
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.keyboard.press('f');
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));

  // Screen position of a plan point, from FIT VIEW's own rule (plan2d.js fitView): the
  // bounds are the underlay, (-2,-2) to (8,6).
  const box = await canvasLoc.boundingBox();
  const wrap = await page.locator('.plan-canvas').evaluate(e => ({ w: e.clientWidth, h: e.clientHeight }));
  const b = { minX: -2, minY: -2, maxX: 8, maxY: 6 };
  const w = wrap.w - RULER, h = wrap.h - RULER, bw = b.maxX - b.minX, bh = b.maxY - b.minY;
  const zoom = Math.min(w / (bw * 1.22), h / (bh * 1.22), 250);
  let panX = b.minX - (w / zoom - bw) / 2 - RULER / zoom, panY = b.minY - (h / zoom - bh) / 2 - RULER / zoom;
  const at = (x, y) => [box.x + (x - panX) * zoom, box.y + (y - panY) * zoom];
  const state = () => page.evaluate(async () => {
    const s = await import('/js/store.js');
    const p = s.activeProperty();
    return { walls: Object.fromEntries(p.walls.map(w => [w.id, [w.ax, w.ay, w.bx, w.by]])), rooms: Object.fromEntries(p.rooms.map(r => [r.id, r.pts])), plan: { x: p.levels[0].plan.offsetX, y: p.levels[0].plan.offsetY } };
  });
  const inspector = () => page.locator('.inspector').innerText();
  async function dragPath(from, to, steps = 12) {
    await page.mouse.move(...at(...from));
    await page.mouse.down();
    await page.mouse.move(...at(...to), { steps });
    await page.mouse.up();
  }
  const start = await state();

  // 1. A click on a floor selects it and moves nothing.
  await page.mouse.click(...at(1.5, 2));
  assert.match(await inspector(), /ROOM/);
  assert.match(await inspector(), /Corners on walls\s*4 of 4/);
  assert.deepEqual(await state(), start, 'clicking a floor changes nothing');

  // 2. Dragging a floor pans the view: the floor stays on its walls and stays selected.
  await dragPath([1.5, 2], [2.5, 2.6]);
  assert.deepEqual(await state(), start, 'dragging a floor does not move it');
  assert.match(await inspector(), /ROOM/, 'panning keeps the selection');
  panX -= 1; panY -= 0.6;   // the view followed the pointer

  // 3. A press on a wall that wobbles 2 px is a click: selected, not moved.
  await page.mouse.move(...at(3, 2));
  await page.mouse.down();
  const [jx, jy] = at(3, 2);
  await page.mouse.move(jx + 2, jy + 1);
  await page.mouse.up();
  assert.match(await inspector(), /WALL/);
  assert.deepEqual(await state(), start, 'a click with a small wobble does not nudge the wall');

  // 4. Dragging the partition slides it; both floors' shared corners follow it.
  await dragPath([3, 2], [4, 2.3]);
  let now = await state();
  near(now.walls.mid[0], 4, 0.01, 'partition moved along its normal only');
  assert.equal(now.walls.mid[1], 0); assert.equal(now.walls.mid[3], 4);
  for (const id of ['left', 'right']) for (const p of now.rooms[id].filter(p => p[0] > 3.5 && p[0] < 4.5)) near(p[0], now.walls.mid[0], 1e-9, `${id} corner on the partition`);
  assert.equal(now.rooms.left.filter(p => Math.abs(p[0] - now.walls.mid[0]) < 1e-9).length, 2, 'left floor has two corners on the partition');
  await page.locator('[data-act=undo]').click();
  now = await state();
  assert.deepEqual(now.walls.mid, [3, 0, 3, 4], 'undo puts the partition back');
  assert.deepEqual(now.rooms, start.rooms);

  // 5. A corner drag that turns a wall keeps the partition and the floors on it.
  await page.mouse.click(...at(1.5, 0));               // select the south wall
  assert.match(await inspector(), /WALL/);
  await dragPath([0, 0], [0, -1], 16);                 // its west handle, down 1 m
  now = await state();
  near(now.walls.south[1], -1, 0.02, 'south wall end moved');
  near(now.walls.mid[0], 3, 1e-9, 'partition keeps its line');
  near(now.walls.mid[1], (now.walls.south[1]) / 2, 0.01, 'partition reaches the turned south wall');
  const tCorner = now.rooms.left.find(p => p[0] === 3 && p[1] < 0);
  assert.ok(tCorner, 'left floor corner at the T followed the wall');
  near(tCorner[1], now.walls.mid[1], 1e-9, 'floor corner sits where the partition meets the wall');
  await page.locator('[data-act=undo]').click();
  assert.deepEqual((await state()).rooms, start.rooms, 'undo restores the floors');

  // 6. A selected floor shows its corners: drag one off the walls, then snap it back.
  await page.mouse.click(...at(4.5, 2));
  assert.equal(await page.locator('.inspector [data-name]').inputValue(), 'Right', 'a click selects the floor under it');
  await dragPath([6, 4], [5.7, 3.75], 10);
  now = await state();
  const moved = now.rooms.right[2];
  near(moved[0], 5.7, 0.02, 'corner x'); near(moved[1], 3.75, 0.02, 'corner y');
  assert.match(await inspector(), /Corners on walls\s*3 of 4/);
  await page.locator('[data-snap-floor]').click();
  now = await state();
  near(now.rooms.right[2][1], 4, 1e-9, 'loose corner snapped onto the north wall');
  assert.match(await inspector(), /Corners on walls\s*4 of 4/);
  assert.equal(await page.locator('[data-snap-floor]').count(), 0, 'nothing left to snap');
  await page.locator('[data-act=undo]').click();
  await page.locator('[data-act=undo]').click();
  assert.deepEqual((await state()).rooms, start.rooms);

  // 7. The underlay only moves once it is selected; until then a drag on it pans.
  const before = (await state()).plan;
  await page.keyboard.press('Escape');
  await dragPath([7.3, 5.3], [7.0, 5.6]);
  assert.deepEqual((await state()).plan, before, 'an unselected underlay is not dragged');
  panX += 0.3; panY -= 0.3;
  await page.mouse.click(...at(7.3, 5.3));
  assert.match(await inspector(), /PLAN UNDERLAY/);
  await dragPath([7.3, 5.3], [7.8, 5.3]);
  near((await state()).plan.x, before.x + 0.5, 0.02, 'a selected underlay drags');

  assert.deepEqual(errors, [], 'no page errors');
  console.log('Plan editing click/drag model passed.');
} finally {
  if (browser) await browser.close();
  await new Promise(r => server.close(r));
}
