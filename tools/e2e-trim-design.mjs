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
//   battens      a drag on a batten closes the spacing, and the wall gains bays
//   moulding     the dropdown, drawn like the catalog, swaps the room's rails to another
//                moulding; with PROJECT chosen it swaps the next room's too; the arrows step it
//   catalog      PRODUCTS > TRIM CATALOG floats over MODEL; a card dragged onto the dropdown
//                swaps the rails; onto a wall it adds crown to that face or swaps its baseboard
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
    // Board and batten over the rail on the study's east wall.
    const east = p.walls.find(x => x.id === 'e');
    const bb = T.trimTemplate('board-batten', null, east, sideOf('e', 'study'), { wallHeight: 2.5, y: 1.1, h: 1.0 });
    bb.id = 'batten-study-e'; p.trims.push(bb);
    const { normalizeSavedView } = await import('/js/saved-views.js');
    p.savedViews = [{ id: 'v-south', name: 'South', camera: { position: [2.5, 1.25, 0.5], target: [2.5, 0.55, 3.95], fov: 55 } },
      { id: 'v-east', name: 'East', camera: { position: [5.4, 1.5, 2], target: [7.95, 1.5, 2], fov: 55 } }].map(v => normalizeSavedView(v, new Set()));
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
  // The dropdown shows the rail's moulding drawn to size and opens into every chair rail so drawn.
  const mould = page.locator('.inspector [data-mould="chair-rail"]');
  assert.equal(await mould.locator('summary svg.tp-prof').count(), 1, 'the closed dropdown shows the moulding\'s section');
  await mould.locator('summary').click();
  const options = await page.locator('.inspector [data-mould="chair-rail"] [data-cat]').evaluateAll(list => list.map(b => b.dataset.cat));
  assert.ok(options.length >= 2, 'the dropdown lists the catalog\'s chair rails');
  assert.equal(await page.locator('.inspector [data-mould="chair-rail"] [data-cat] svg.tp-prof').count(), options.length, 'every entry is drawn');
  const was = (await trim(RAIL)).product, next = options.find(v => v !== was);
  const choose = async id => {
    const d = page.locator('.inspector [data-mould="chair-rail"]');
    if (!await d.evaluate(x => x.open)) await d.locator('summary').click();
    await page.locator(`.inspector [data-mould="chair-rail"] [data-cat="${id}"]`).click();
  };
  await choose(next);
  await each('rail-living', async t => assert.equal(t.product, next, t.id + ' swapped'));
  await each('rail-study', async t => assert.equal(t.product, was, 'the study\'s rail is not in the room'));
  assert.equal(await page.locator('.inspector [data-mould="chair-rail"]').evaluate(x => x.open), false, 'a click on an entry closes the dropdown');
  await scope('project').click();
  await waitUntil(async () => (await scope('project').getAttribute('aria-checked')) === 'true', 'PROJECT chosen');
  const third = options.find(v => v !== was && v !== next) || was;
  await choose(third);
  await each('rail-', async t => assert.equal(t.product, third, t.id + ' swapped with the project'));
  ok('the moulding dropdown, drawn entries, swaps the room\'s rails; with PROJECT chosen it swaps both rooms\'');
  // With the open list focused the arrows swap live and the list keeps the keys.
  await page.locator('.inspector [data-mould="chair-rail"] summary').click();
  await page.locator('.inspector [data-mould="chair-rail"] [data-mould-list]').focus();
  const at3 = options.indexOf(third), step = at3 < options.length - 1 ? 'ArrowDown' : 'ArrowUp', fourth = options[at3 + (step === 'ArrowDown' ? 1 : -1)];
  await page.keyboard.press(step);
  await each('rail-', async t => assert.equal(t.product, fourth, t.id + ' stepped with the arrow key'));
  assert.ok(await page.evaluate(() => document.activeElement?.matches('[data-mould="chair-rail"] [data-mould-list]') && document.activeElement.closest('details').open), 'the list stays open with the keys');
  await shot('06a-moulding-open');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.inspector [data-mould="chair-rail"]').evaluate(x => x.open), false, 'Esc closes the dropdown');
  ok('the arrow keys step the rails through the list live; Esc closes it');
  assert.equal(await page.locator('.inspector .tp-cat-list:not(details .tp-cat-list)').count(), 0, 'the panel no longer carries the whole catalog');
  await shot('06-moulding');

  // ---------- trim catalog, floating ----------
  await scope('room').click();
  await page.evaluate(() => { location.hash = '#/trim-catalog'; });
  await page.locator('.tc-card').first().waitFor();
  assert.equal(await page.locator('.doc-parts [data-part="trim"].active').count(), 1, '#/trim-catalog opens TRIM CATALOG in PRODUCTS');
  const cards = await page.locator('.tc-card').count();
  assert.ok(cards >= 10 && await page.locator('.tc-card svg.tp-prof').count() === cards, 'every catalog entry is a card drawn to size');
  await page.locator('.mv-chip-btn[data-group="Crown"]').click();
  assert.ok(await page.locator('.tc-card').count() < cards, 'the group chips filter the cards');
  await page.locator('.mv-chip-btn[data-group=""]').click();
  // A small window at the bottom left, clear of the south wall in the view.
  await page.evaluate(() => localStorage.setItem('tiksi.productsFloat', JSON.stringify({ x: 8, y: innerHeight - 420, w: 420, h: 410 })));
  await page.locator('[data-hub-action="float"]').click();
  await page.locator('.pf-win .tc-card').first().waitFor();
  assert.match(await page.evaluate(() => location.hash), /^#\/model/, 'FLOAT goes to MODEL');
  await canvas.waitFor(); await idle();
  await page.evaluate(() => document.querySelector('[data-view-go="v-south"]').click());
  await page.waitForTimeout(900); await idle();
  ok('PRODUCTS > TRIM CATALOG shows ' + cards + ' drawn cards; FLOAT keeps it over MODEL');
  // A rail card dropped on the chair rail dropdown swaps the room's rails.
  { const r = await trim(RAIL); const q = await at(RAIL, 2.5, r.y + 0.03); await page.mouse.click(q.x, q.y); }
  await waitUntil(async () => /Chair rail/.test(await page.locator('.inspector .stat-line').first().textContent()), 'the rail with the catalog floating');
  const railNow = (await trim(RAIL)).product, railNext = options.find(v => v !== railNow);
  await page.locator(`.pf-win .tc-card[data-id="${railNext}"]`).dragTo(page.locator('.inspector [data-drop-style="chair-rail"]'));
  await each('rail-living', async t => assert.equal(t.product, railNext, t.id + ' swapped by the dropped card'));
  ok('a rail card dragged onto the chair rail dropdown swaps the room\'s rails');
  // A crown card dropped on a bare part of the south wall adds crown to that face; a baseboard
  // card dropped there swaps that face's baseboard alone.
  const crownId = await page.evaluate(async () => (await import('/js/trims.js')).catalogInOrder().find(p => p.style === 'crown').id);
  const box = await canvas.boundingBox();
  const wallAt = async y => { const q = await at(SOUTH, 2.5, y); return { x: q.x - box.x, y: q.y - box.y }; };
  // A card's drag carried to a point on the model: the browser's own drag start on the card,
  // then the drag over and the drop where the pointer lets go (Playwright's dragTo does not
  // deliver a drop onto a WebGL canvas).
  const dropOn = (card, to) => page.evaluate(([card, x, y]) => {
    const dt = new DataTransfer(), src = document.querySelector(card);
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
    const target = document.elementFromPoint(x, y), at = { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt };
    const over = new DragEvent('dragover', at); target.dispatchEvent(over);
    if (!over.defaultPrevented) throw new Error('the model did not take the drag at ' + x + ',' + y + ' (' + target.className + ')');
    target.dispatchEvent(new DragEvent('drop', at));
    src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
  }, [card, box.x + to.x, box.y + to.y]);
  const crownsBefore = await page.evaluate(() => window.testStore.activeProperty().trims.filter(t => t.style === 'crown').length);
  await dropOn(`.pf-win .tc-card[data-id="${crownId}"]`, await wallAt(1.7));
  await waitUntil(() => page.evaluate(n => window.testStore.activeProperty().trims.filter(t => t.style === 'crown').length === n + 1, crownsBefore), 'a crown card dropped on the wall adds crown');
  const added = await page.evaluate(() => { const t = window.testStore.activeProperty().trims.filter(t => t.style === 'crown').at(-1); return { wallId: t.wallId, side: t.side }; });
  const south = await trim(SOUTH);
  assert.deepEqual(added, { wallId: south.wallId, side: south.side }, 'on the face it was dropped on');
  const baseId = 'base-living-s1', baseWas = (await trim(baseId)).product;
  const baseNext = await page.evaluate(was => (async () => (await import('/js/trims.js')).catalogInOrder().find(p => p.style === 'baseboard' && p.id !== was).id)(), baseWas);
  await dropOn(`.pf-win .tc-card[data-id="${baseNext}"]`, await wallAt(1.7));
  await waitUntil(async () => (await trim(baseId)).product === baseNext, 'a baseboard card dropped on the wall swaps its baseboard');
  assert.equal((await trim('base-living-w')).product, baseWas, 'the next wall\'s baseboard is left alone');
  ok('cards dropped on a wall: crown is added to that face, the face\'s baseboard swaps');
  await shot('06b-floating-catalog');
  await page.locator('.pf-win [data-pf-dock]').click();
  await page.locator('.doc-parts [data-part="trim"].active').waitFor();
  assert.equal(await page.locator('.pf-win').count(), 0, 'DOCK puts PRODUCTS back in its tab');
  await page.locator('#rail [data-view=model]').click();
  await canvas.waitFor(); await idle();
  await page.evaluate(() => document.querySelector('[data-view-go="v-south"]').click());
  await page.waitForTimeout(900); await idle();
  ok('DOCK puts PRODUCTS back in its tab at TRIM CATALOG');

  // ---------- battens ----------
  await page.keyboard.press('Escape');
  await page.evaluate(() => document.querySelector('[data-view-go="v-east"]').click());
  await page.waitForTimeout(900); await idle();
  const BB = 'batten-study-e';
  let bays = await boxesOf(BB);
  const bay = bays[Math.floor(bays.length / 2)];
  { const q = await at(BB, bay.x1 + 0.015, 1.6); await page.mouse.click(q.x, q.y); }
  await waitUntil(async () => /Board and batten/.test(await page.locator('.inspector .stat-line').first().textContent()), 'a click on a batten selects the field');
  await page.keyboard.press('e');
  await waitUntil(async () => (await page.locator('.inspector [data-tp-edit]').textContent()).startsWith('DONE'), 'editing the battens');
  await drag(await at(BB, bay.x1 + 0.015, 1.6), await at(BB, bay.x1 + 0.015 - 5 * IN, 1.6));
  const spacing = (await trim(BB)).spacing;
  assert.ok(spacing > 0.1 && spacing < 0.4, 'the battens aim for a closer spacing: ' + (spacing / IN).toFixed(2) + ' in');
  const closer = await boxesOf(BB);
  assert.ok(closer.length > bays.length, 'closer battens, more bays: ' + bays.length + ' -> ' + closer.length);
  ok('a drag on a batten closes the spacing to ' + (spacing / IN).toFixed(2) + ' in; the wall goes from ' + bays.length + ' to ' + closer.length + ' bays');
  await shot('07-battens');

  // ---------- one board at a time ----------
  // The battens and the study's east chair rail are grouped as a room of a project. A click
  // picks the group, a double-click the section, another double-click one batten. A click on
  // another batten of the open section picks that batten; Delete takes it out; a drag in EDIT BY
  // DRAGGING moves one batten and leaves the rest; ADD A COPY BESIDE IT adds one.
  await page.keyboard.press('Escape');                    // done editing the battens
  await page.keyboard.press('Escape');                    // nothing selected
  await page.evaluate(() => {
    const s = window.testStore, p = s.activeProperty();
    s.ws.data.projects.push({ id: 'job', name: 'Trim', propertyId: p.id, parentId: '', items: [] }, { id: 'east', name: 'East wall', propertyId: p.id, parentId: 'job', items: [] });
    for (const t of p.trims) if (t.id === 'batten-study-e' || t.id === 'rail-study-e') t.projectId = 'east';
    s.touch();
  });
  await page.waitForTimeout(600); await idle();
  await page.evaluate(() => document.querySelector('[data-view-go="v-east"]').click());
  await page.waitForTimeout(900); await idle();
  const partsOf = id => page.evaluate(async id => {
    const s = window.testStore, p = s.activeProperty(), D = await import('/js/trim-design.js');
    const L = p.levels[0].id;
    const d = D.trimDesign({ prop: p, projects: [], levelOf: () => L, wallsOn: () => p.walls, roomsOn: () => p.rooms, openingsOn: () => p.openings, heightOf: w => s.wallHeightOf(p, w) });
    return d.layout(p.trims.find(t => t.id === id)).parts.map(q => ({ key: q.key, kind: q.kind, dir: q.dir, x0: q.x0, x1: q.x1, y0: q.y0, y1: q.y1, added: !!q.added }));
  }, id);
  const vertical = async () => (await partsOf(BB)).filter(q => q.kind === 'board' && q.dir === 'v').sort((a, b) => a.x0 - b.x0);
  const onBoard = q => at(BB, (q.x0 + q.x1) / 2, (q.y0 + q.y1) / 2);
  const pause = () => page.waitForTimeout(600);           // so the next click is not taken as a double-click
  const stat = () => page.locator('.inspector .stat-line').first().textContent();
  let vs = await vertical();
  assert.ok(vs.length >= 5, 'the closer battens give at least five');
  const m = Math.floor(vs.length / 2) - 1;                 // battens in the middle of the wall, in view
  let q = await onBoard(vs[m]);
  await page.mouse.click(q.x, q.y);
  await waitUntil(async () => (await heading.textContent()) === '2 TRIM SECTIONS', 'a click picks the group: the battens and the rail');
  await pause();
  await page.mouse.dblclick(q.x, q.y);
  await waitUntil(async () => (await heading.textContent()) === 'WALL TRIM' && /Board and batten/.test(await page.locator('.inspector').textContent()), 'a double-click goes in to the section');
  await pause();
  await page.mouse.dblclick(q.x, q.y);
  await waitUntil(async () => (await heading.textContent()) === 'TRIM BOARD', 'another double-click goes in to one batten');
  assert.match(await stat(), new RegExp('^Batten ' + (m + 1) + ' of ' + vs.length));
  await shot('07b-one-batten');
  await pause();
  q = await onBoard(vs[m + 2]);
  await page.mouse.click(q.x, q.y);
  await waitUntil(async () => new RegExp('^Batten ' + (m + 3) + ' of').test(await stat()), 'a click on another batten of the open section picks that batten');
  ok('click: the group; double-click: the section; double-click: one batten; a click on the next batten picks it');

  await page.keyboard.press('Delete');
  await waitUntil(async () => (await heading.textContent()) === 'WALL TRIM', 'Delete takes the batten out and shows its section');
  assert.equal((await vertical()).length, vs.length - 1, 'one batten fewer');
  assert.deepEqual((await trim(BB)).boards, { [vs[m + 2].key]: { hide: true } });
  assert.match(await page.locator('.inspector').textContent(), /Boards changed by hand\s*1 deleted/);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await waitUntil(async () => (await vertical()).length === vs.length, 'one undo puts the batten back');
  ok('Delete takes one batten out of the layout; UNDO puts it back');

  await pause();
  q = await onBoard(vs[m]);
  // UNDO cleared the selection: a triple-click goes group, section, batten in one go.
  await page.mouse.click(q.x, q.y, { clickCount: 3 });
  await waitUntil(async () => (await heading.textContent()) === 'TRIM BOARD', 'a triple-click goes straight in to one batten');
  await page.keyboard.press('e');
  await waitUntil(async () => (await page.locator('.inspector [data-tb-edit]').textContent()).startsWith('DONE'), 'editing the batten');
  const dimLabels = () => page.locator('.v-dimlabel').allTextContents();
  await waitUntil(async () => (await dimLabels()).length === 3, 'the batten shows its space each side and its height');
  const gapsBefore = (await dimLabels()).slice(0, 2);
  await drag(q, await at(BB, (vs[m].x0 + vs[m].x1) / 2 + 3 * IN, (vs[m].y0 + vs[m].y1) / 2 + 0.2));
  const movedBoards = (await trim(BB)).boards;
  assert.deepEqual(Object.keys(movedBoards), [vs[m].key], 'only that batten is changed by hand');
  const now = await vertical(), moved = now.find(x => x.key === vs[m].key);
  assert.ok(Math.abs(moved.x0 - vs[m].x0 - 3 * IN) < 0.8 * IN, 'moved about 3" sideways: ' + ((moved.x0 - vs[m].x0) / IN).toFixed(2) + ' in');
  const gapsAfter = (await dimLabels()).slice(0, 2);
  assert.notDeepEqual(gapsAfter, gapsBefore, 'the spaces either side follow the drag: ' + gapsBefore.join(', ') + ' -> ' + gapsAfter.join(', '));
  await shot('07c-batten-dimensions');
  near(moved.y0, vs[m].y0, 'a batten moves sideways only, without Shift');
  for (const k of [m - 1, m + 1]) near(now.find(x => x.key === vs[k].key).x0, vs[k].x0, 'batten ' + (k + 1) + ' stays');
  assert.equal(await page.locator('.inspector [data-tb-status]').textContent(), 'Moved by hand');
  ok('a drag moves one batten ' + ((moved.x0 - vs[m].x0) / IN).toFixed(2) + ' in; the others keep the layout; its dimensions read ' + gapsAfter.join(', '));

  await page.locator('.inspector [data-tb-copy]').click();
  await waitUntil(async () => (await page.locator('.inspector [data-tb-status]').textContent()) === 'Added by hand', 'the copy is selected');
  assert.equal((await vertical()).length, vs.length + 1, 'one batten more');
  await page.keyboard.press('Escape');                    // done editing
  await waitUntil(async () => (await dimLabels()).length === 0, 'the dimensions go when editing ends');
  await page.keyboard.press('Escape');                    // out to the section
  await waitUntil(async () => (await heading.textContent()) === 'WALL TRIM', 'Esc goes back out to the section');
  assert.match(await page.locator('.inspector').textContent(), /Boards changed by hand\s*1 moved, 1 added/);
  await page.locator('.inspector [data-tp-boards-back]').click();
  await waitUntil(async () => (await trim(BB)).boards === undefined, 'PUT EVERY BOARD BACK');
  assert.equal((await vertical()).length, vs.length, 'the layout as it was');
  ok('ADD A COPY BESIDE IT adds a batten; Esc goes out to the section; PUT EVERY BOARD BACK restores the layout');
  await page.evaluate(() => { for (const t of window.testStore.activeProperty().trims) delete t.projectId; window.testStore.touch(); });

  // ---------- visual style pickers ----------
  const picker = kind => page.locator(`.inspector [data-picker="${kind}"]`);
  const pickStyle = async (kind, id) => {
    await picker(kind).locator('summary').click();
    await picker(kind).locator(`[data-choice="${id}"]`).click();
    await idle();
  };
  await scope('selected').click();
  const battenField = await trim(BB);
  await pickStyle('wainscot', 'hd-pml00x00cl');
  assert.equal((await trim(BB)).style, 'picture-frame');
  near((await trim(BB)).y, battenField.y, 'swapped field starts on the same line');
  near((await trim(BB)).h, battenField.h, 'swapped field fits the same height');
  await picker('frame').locator('summary').click();
  assert.equal(await picker('frame').locator('[data-choice]').count(), 11, 'ten reference schemes and custom');
  await shot('08-picture-frame-layouts');
  await picker('frame').locator('[data-choice="08"]').click();
  await idle();
  assert.equal((await trim(BB)).frameLayout, '08');
  assert.equal((await boxesOf(BB)).length, 5, 'the scheme draws five boxes below the divider');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await waitUntil(async () => !(await trim(BB)).frameLayout, 'one undo restores the custom layout');
  ok('the wainscoting style and picture-frame layout each update the selected field');

  { const q = await at(BB, 2, 2.25); await page.mouse.click(q.x, q.y); }
  await page.locator('.inspector [data-face-wall="e"]').click();
  await page.locator('.inspector [data-trim-add]').waitFor();
  await pickStyle('crown', 'hd-mld04x04x06er');
  await page.locator('.inspector [data-trim-add]').click();
  await idle();
  await pickStyle('crown', 'ekena-mld05x04x07ns');
  assert.equal(await page.evaluate(() => window.testStore.activeProperty().trims.find(t => t.style === 'crown' && t.wallId === 'e').product), 'ekena-mld05x04x07ns');
  const cut = page.locator('.inspector .tp-product .tp-prof');
  assert.match(await cut.getAttribute('aria-label'), /5 7\/8" drop × 4 3\/4" projection/);
  assert.ok(await cut.locator('.tp-prof-sides polygon').count() > 1);
  assert.ok(await cut.locator('text').evaluateAll(labels => labels.every(label => label.getBBox().x >= 0)), 'dimension labels fit the cutaway');
  if (shots) await cut.screenshot({ path: shots + '/10-dimensioned-cutaway.png' });
  await shot('09-crown-cutaway');
  ok('crown can be added and swapped by style, with the installed dimensions on the cutaway');

  assert.deepEqual(errors, [], 'no page errors');
  console.log('trim design: all checks passed');
} finally {
  if (browser) await browser.close();
  child.kill();
  await rm(state, { recursive: true, force: true });
}
