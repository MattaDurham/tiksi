// Wall trim designed a room at a time (js/trim-design.js), with real clicks and drags on the
// rendered model.
//
//   reach        a click on a section shows CHANGES REACH with what each scope covers; ROOM is
//                the default
//   typed        a box width typed in the panel goes to every box field in the room, and each
//                wall refits its own count; the next room is left alone
//   gap          a drag in the space between two boxes changes the gap on every wall of the room
//   margins      a drag in the space above the boxes changes the top margin on every wall
//   box width    a drag on a box's side makes every box narrower, and walls gain boxes
//   height       a drag on the chair rail raises every rail in the room; the fields under them
//                stretch and the baseboards stay on the floor; one UNDO takes it back
//   right-click  ADD A PANEL HERE adds one box to that wall alone
//   moulding     the dropdown swaps the room's rails to another moulding; with PROJECT chosen
//                it swaps the next room's too
//
// Synthetic project and temporary runtime only; never uses the owner's stores.
// Run: node tools/e2e-trim-design.mjs (Playwright + Chromium installed).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { chromium } from 'playwright';

const root = process.env.E2E_ROOT || process.cwd();
const state = await mkdtemp(tmpdir() + '/tiksi-trim-design-');
const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r));
const port = Number(process.env.E2E_APP_PORT) || socket.address().port; await new Promise(r => socket.close(r));
const child = spawn('python3', ['tools/serve.py', '--port', String(port), '--state-dir', state, '--projects-dir', state + '/projects'], { cwd: root, stdio: 'ignore' });
const shots = process.env.E2E_SHOTS || '';
let browser;
const ok = label => console.log('  ok   ' + label);
const IN = 0.0254;
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch('http://127.0.0.1:' + port)).ok) break; } catch {} await new Promise(r => setTimeout(r, 50)); }
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  page.setDefaultTimeout(60000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const saved = () => page.waitForFunction(() => document.querySelector('#save-status')?.textContent === 'SAVED TO DISK', null, { timeout: 120000 });
  await page.goto('http://127.0.0.1:' + port + '/#/budget');
  await saved();
  // A 5 x 4 m living room and a 3 x 4 m study side by side (x east, y south; world z = plan y),
  // walls 2.5 m high. Each room has a baseboard, a field of boxes and a chair rail on every wall.
  await page.evaluate(async () => {
    const s = window.testStore = await import('/js/store.js');
    const T = await import('/js/trims.js'), D = await import('/js/trim-design.js');
    const p = s.propertyTemplate('Trim design test');
    p.id = 'trim-house'; p.env.quality = 'low'; p.env.showCeilings = false;
    const L = p.levels[0].id;
    p.levels[0].height = 2.5;
    const wall = (id, ax, ay, bx, by) => ({ id, level: L, ax, ay, bx, by, thickness: 0.1, height: null, material: 'mat-drywall' });
    p.walls.push(wall('n1', 0, 0, 5, 0), wall('n2', 5, 0, 8, 0), wall('e', 8, 0, 8, 4), wall('s2', 8, 4, 5, 4), wall('s1', 5, 4, 0, 4), wall('w', 0, 4, 0, 0), wall('mid', 5, 0, 5, 4));
    p.rooms.push({ id: 'living', level: L, name: 'Living', pts: [[0, 0], [5, 0], [5, 4], [0, 4]], material: 'mat-oak', ceilingMaterial: null },
      { id: 'study', level: L, name: 'Study', pts: [[5, 0], [8, 0], [8, 4], [5, 4]], material: 'mat-oak', ceilingMaterial: null });
    p.openings.push({ id: 'door', wallId: 'mid', type: 'door', t: 0.5, width: 0.8, height: 2.03 });
    p.trims = [];
    const env = { prop: p, projects: [], levelOf: () => L, wallsOn: () => p.walls, roomsOn: () => p.rooms, openingsOn: () => p.openings, heightOf: () => 2.5 };
    const d = D.trimDesign(env);
    const sideOf = (wallId, roomId) => [1, -1].find(side => (d.info({ id: 'probe', wallId, side, f0: 0, f1: 1 }) || {}).roomId === roomId);
    for (const [roomId, walls] of [['living', ['n1', 's1', 'w', 'mid']], ['study', ['n2', 'e', 's2', 'mid']]]) for (const id of walls) {
      const w = p.walls.find(x => x.id === id), side = sideOf(id, roomId);
      const add = (key, style, at) => { const t = T.trimTemplate(style, null, w, side, { wallHeight: 2.5, ...at }); t.id = `${key}-${roomId}-${id}`; p.trims.push(t); return t; };
      const base = add('base', 'baseboard');
      const top = base.y + T.trimProduct(base).W;
      const box = add('box', 'picture-frame', { y: top, h: 0.9 - top });
      box.gap = 3 * 0.0254; box.inset = 3 * 0.0254;
      add('rail', 'chair-rail', { y: 0.9 });
    }
    const { normalizeSavedView } = await import('/js/saved-views.js');
    p.savedViews = [{ id: 'v-south', name: 'South', camera: { position: [2.5, 1.25, 0.5], target: [2.5, 0.55, 3.95], fov: 55 } }].map(v => normalizeSavedView(v, new Set()));
    s.ws.data.settings.sketchupMirror = false; s.ws.data.settings.units = 'imperial';
    s.ws.data.properties.push(p); s.ws.data.settings.activePropertyId = p.id; s.touch();
    await (await import('/js/disk-workspace.js')).diskWorkspace.sync();
  });

  const waitUntil = async (check, what, tries = 150) => {
    for (let i = 0; i < tries; i++) { if (await check()) return; await page.waitForTimeout(200); }
    assert.fail('timed out waiting until ' + what);
  };
  const idle = () => waitUntil(() => page.evaluate(async () => (await import('/js/viewer3d.js')).viewerIdle()), 'MODEL has settled');
  const canvas = page.locator('canvas.v-canvas'), heading = page.locator('.inspector h3').first();
  const screenOf = p => page.evaluate(async p => {
    const THREE = await import('three'), c = (await import('/js/viewer3d.js')).markupState().camera;
    const r = document.querySelector('canvas.v-canvas').getBoundingClientRect();
    const cam = new THREE.PerspectiveCamera(c.fov, r.width / r.height, 0.05, 3000);
    cam.position.set(...c.position); cam.lookAt(new THREE.Vector3(...c.target)); cam.updateMatrixWorld();
    const q = new THREE.Vector3(...p).project(cam);
    return { x: r.left + (q.x + 1) / 2 * r.width, y: r.top + (1 - q.y) / 2 * r.height };
  }, p);
  // A point on a section's wall face (x along the wall from its end a, y above the floor) in the world.
  const faceWorld = (id, x, y) => page.evaluate(([id, x, y]) => {
    const p = window.testStore.activeProperty(), t = p.trims.find(k => k.id === id), w = p.walls.find(k => k.id === t.wallId);
    const L = Math.hypot(w.bx - w.ax, w.by - w.ay), ux = (w.bx - w.ax) / L, uy = (w.by - w.ay) / L, off = t.side * (w.thickness / 2 + 0.004);
    return [w.ax + ux * x - uy * off, y, w.ay + uy * x + ux * off];
  }, [id, x, y]);
  // The section's boxes as MODEL draws them (trim-design.js layout).
  const boxesOf = id => page.evaluate(async id => {
    const s = window.testStore, p = s.activeProperty(), D = await import('/js/trim-design.js');
    const L = p.levels[0].id;
    const d = D.trimDesign({ prop: p, projects: [], levelOf: () => L, wallsOn: () => p.walls, roomsOn: () => p.rooms, openingsOn: () => p.openings, heightOf: w => s.wallHeightOf(p, w) });
    return d.layout(p.trims.find(t => t.id === id)).boxes.filter(b => b.row === 0);
  }, id);
  const trim = id => page.evaluate(id => JSON.parse(JSON.stringify(window.testStore.activeProperty().trims.find(t => t.id === id))), id);
  const each = async (prefix, fn) => { for (const id of await page.evaluate(prefix => window.testStore.activeProperty().trims.filter(t => t.id.startsWith(prefix)).map(t => t.id), prefix)) await fn(await trim(id), id); };
  const at = async (id, x, y) => screenOf(await faceWorld(id, x, y));
  const drag = async (from, to, keys = []) => {
    for (const k of keys) await page.keyboard.down(k);
    await page.mouse.move(from.x, from.y); await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(from.x + (to.x - from.x) * i / 8, from.y + (to.y - from.y) * i / 8);
    await page.mouse.up();
    for (const k of keys) await page.keyboard.up(k);
    await page.waitForTimeout(150);
  };
  const shot = async name => { if (shots) await page.screenshot({ path: shots + '/' + name + '.png' }); };
  const near = (a, b, what, tol = 0.002) => assert.ok(Math.abs(a - b) < tol, `${what}: ${a} is not ${b}`);
  const SOUTH = 'box-living-s1', RAIL = 'rail-living-s1';

  await page.locator('#rail [data-view=model]').click();
  await canvas.waitFor();
  await idle();
  await page.evaluate(() => document.querySelector('[data-view-go="v-south"]').click());
  await page.waitForTimeout(900); await idle();

  // ---------- reach ----------
  let boxes = await boxesOf(SOUTH);
  assert.ok(boxes.length >= 2, 'the south wall starts with several boxes');
  const inBox = async () => at(SOUTH, (boxes[1].x0 + boxes[1].x1) / 2, boxes[1].y0 + 0.006);
  { const q = await inBox(); await page.mouse.click(q.x, q.y); }
  await waitUntil(async () => (await heading.textContent()) === 'WALL TRIM', 'a click on a box moulding shows WALL TRIM');
  const scope = id => page.locator(`.inspector [data-scope="${id}"]`);
  assert.equal(await scope('room').getAttribute('aria-checked'), 'true', 'ROOM is the reach to begin with');
  assert.deepEqual(await page.locator('.inspector [data-scope] span').allTextContents(), ['1', '4', '4', '8'], 'selected, group, room, project');
  assert.match(await page.locator('.inspector .tp-scope-note').textContent(), /Living/);
  ok('a section shows CHANGES REACH: selected 1, group 4, room 4, project 8');
  await shot('01-selected');

  // ---------- typed ----------
  const aim = page.locator('.inspector [data-design="aim"]');
  await aim.fill('18"'); await aim.dispatchEvent('change');
  await each('box-living', async t => near(t.target, 18 * IN, t.id + ' aims for 18 in'));
  await each('box-study', async t => assert.equal(t.target ?? null, null, 'the study is outside the room'));
  const typed = await boxesOf(SOUTH);
  assert.ok(typed.length > boxes.length, 'the south wall refits: ' + boxes.length + ' -> ' + typed.length + ' boxes');
  assert.ok(Math.abs(typed[0].x1 - typed[0].x0 - 18 * IN) < 3 * IN, 'its boxes are near 18 in');
  const westBoxes = await boxesOf('box-living-w');
  assert.notEqual(westBoxes.length, typed.length, 'a shorter wall takes its own count');
  ok('a typed box width goes to the room\'s four fields; the south wall has ' + typed.length + ' boxes, the west wall ' + westBoxes.length);
  boxes = typed;

  // ---------- gap ----------
  await page.keyboard.press('e');
  await waitUntil(async () => (await page.locator('.inspector [data-tp-edit]').textContent()).startsWith('DONE'), 'E starts editing by dragging');
  {
    const y = (boxes[1].y0 + boxes[1].y1) / 2, mid = (boxes[1].x1 + boxes[2].x0) / 2;
    // The side of the gap nearer box 2 is pulled 1 1/2 in into the gap's neighbour: the gap opens 3 in.
    await drag(await at(SOUTH, mid + 0.012, y), await at(SOUTH, mid + 0.012 + 1.5 * IN, y));
  }
  const gap = (await trim(SOUTH)).gap;
  assert.ok(gap > 4.5 * IN && gap < 7.5 * IN, 'the gap opened from 3 in to about 6 in: ' + (gap / IN).toFixed(2) + ' in');
  await each('box-living', async t => near(t.gap, gap, t.id + ' has the same gap', 1e-6));
  await each('box-study', async t => near(t.gap, 3 * IN, 'the study keeps its gap', 1e-6));
  boxes = await boxesOf(SOUTH);
  near(boxes[1].x0 - boxes[0].x1, gap, 'the boxes are drawn that far apart', 1e-4);
  ok('a drag between two boxes opens the gap to ' + (gap / IN).toFixed(2) + ' in on all four walls of the room');
  await shot('02-gap');

  // ---------- margins ----------
  {
    // A box in the middle of the wall: the ones at its ends are under the panels floating over the view.
    const t = await trim(SOUTH), b = boxes[Math.floor(boxes.length / 2)], x = (b.x0 + b.x1) / 2, y = (b.y1 + t.y + t.h) / 2;
    await drag(await at(SOUTH, x, y), await at(SOUTH, x, y - 2 * IN));
  }
  const topMargin = (await trim(SOUTH)).insetTop;
  near(topMargin, 5 * IN, 'the margin above the boxes grew from 3 in to 5 in', 0.3 * IN);
  await each('box-living', async t => { near(t.insetTop, topMargin, t.id + ' has the same top margin', 1e-6); near(t.inset, 3 * IN, 'the end margins stay', 1e-6); });
  boxes = await boxesOf(SOUTH);
  { const t = await trim(SOUTH); near(t.y + t.h - boxes[1].y1, topMargin, 'the boxes are drawn that far below the field\'s top', 1e-4); }
  ok('a drag in the space above the boxes sets the top margin to ' + (topMargin / IN).toFixed(2) + ' in on all four walls');

  // ---------- box width ----------
  const before = boxes.length, w0 = boxes[1].x1 - boxes[1].x0;
  {
    const y = (boxes[1].y0 + boxes[1].y1) / 2;
    await drag(await at(SOUTH, boxes[1].x1 - 0.008, y), await at(SOUTH, boxes[1].x1 - 0.008 - 6 * IN, y));
  }
  const target = (await trim(SOUTH)).target;
  near(target, w0 - 6 * IN, 'the aim follows the drag, 6 in narrower', 0.4 * IN);
  await each('box-living', async t => near(t.target, target, t.id + ' has the same aim', 1e-6));
  boxes = await boxesOf(SOUTH);
  assert.ok(boxes.length > before, 'narrower boxes: the wall gains boxes, ' + before + ' -> ' + boxes.length);
  ok('a drag on a box\'s side narrows every box by 6 in; the south wall goes from ' + before + ' to ' + boxes.length + ' boxes');
  await shot('03-box-width');

  // ---------- height ----------
  await page.keyboard.press('Escape');
  { const r = await trim(RAIL); const q = await at(RAIL, 2.5, r.y + 0.03); await page.mouse.click(q.x, q.y); }
  await waitUntil(async () => /Chair rail/.test(await page.locator('.inspector .stat-line').first().textContent()), 'a click on the chair rail selects it');
  await page.keyboard.press('e');
  await waitUntil(async () => (await page.locator('.inspector [data-tp-edit]').textContent()).startsWith('DONE'), 'editing the rail');
  const fieldH = (await trim(SOUTH)).h;
  await drag(await at(RAIL, 2.5, 0.93), await at(RAIL, 2.5, 0.93 + 4 * IN));
  await each('rail-living', async t => near(t.y, 0.9 + 4 * IN, t.id + ' rose 4 in', 0.2 * IN));
  const rose = (await trim(RAIL)).y - 0.9;
  await each('box-living', async t => near(t.h, fieldH + rose, t.id + ' stretched to the rail', 1e-4));
  await each('base-living', async t => near(t.y, 0, 'the baseboard stays on the floor', 1e-9));
  await each('rail-study', async t => near(t.y, 0.9, 'the study\'s rail stays', 1e-9));
  ok('a drag on the chair rail raises the room\'s four rails ' + (rose / IN).toFixed(2) + ' in; the fields stretch, the baseboards stay');
  await shot('04-rail');
  await page.keyboard.press('Escape');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await waitUntil(async () => Math.abs((await trim(RAIL)).y - 0.9) < 1e-9, 'one UNDO puts the rail back');
  await each('box-living', async t => near(t.h, fieldH, t.id + ' is back', 1e-9));
  ok('one UNDO takes the whole move back');

  // ---------- right-click ----------
  boxes = await boxesOf(SOUTH);
  const count = boxes.length, westCount = (await boxesOf('box-living-w')).length;
  { const b = boxes[Math.floor(boxes.length / 2)]; const q = await at(SOUTH, (b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2); await page.mouse.click(q.x, q.y, { button: 'right' }); }
  await page.locator('.v-ctx [data-ctx="trim-add"]').waitFor();
  assert.match(await page.locator('.v-ctx [data-ctx="trim-add"]').textContent(), /ADD A PANEL HERE/);
  assert.ok(await page.locator('.v-ctx [data-ctx="trim-reach-project"]').count(), 'the menu offers the reach');
  await shot('05-menu');
  await page.locator('.v-ctx [data-ctx="trim-add"]').click();
  await waitUntil(async () => (await boxesOf(SOUTH)).length === count + 1, 'ADD A PANEL HERE adds one box');
  assert.equal((await boxesOf('box-living-w')).length, westCount, 'the other walls keep their counts');
  ok('right-click, ADD A PANEL HERE: the south wall has ' + (count + 1) + ' boxes, the others are unchanged');

  // ---------- moulding ----------
  { const r = await trim(RAIL); const q = await at(RAIL, 2.5, r.y + 0.03); await page.mouse.click(q.x, q.y); }
  await waitUntil(async () => /Chair rail/.test(await page.locator('.inspector .stat-line').first().textContent()), 'the rail again');
  const select = page.locator('.inspector [data-role-product="chair-rail"]');
  const options = await select.locator('option').evaluateAll(list => list.map(o => o.value).filter(Boolean));
  assert.ok(options.length >= 2, 'the dropdown lists the catalog\'s chair rails');
  const was = (await trim(RAIL)).product, next = options.find(v => v !== was);
  await select.selectOption(next);
  await each('rail-living', async t => assert.equal(t.product, next, t.id + ' swapped'));
  await each('rail-study', async t => assert.equal(t.product, was, 'the study\'s rail is not in the room'));
  await scope('project').click();
  await waitUntil(async () => (await scope('project').getAttribute('aria-checked')) === 'true', 'PROJECT chosen');
  const third = options.find(v => v !== was && v !== next) || was;
  await page.locator('.inspector [data-role-product="chair-rail"]').selectOption(third);
  await each('rail-', async t => assert.equal(t.product, third, t.id + ' swapped with the project'));
  ok('the moulding dropdown swaps the room\'s rails; with PROJECT chosen it swaps both rooms\'');
  await shot('06-moulding');

  assert.deepEqual(errors, [], 'no page errors');
  console.log('trim design: all checks passed');
} finally {
  if (browser) await browser.close();
  child.kill();
  await rm(state, { recursive: true, force: true });
}
