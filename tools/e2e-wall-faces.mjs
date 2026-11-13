// Walls picked by room face (js/room-faces.js), with real clicks on the rendered model.
//
//   one face     a click on a room's wall selects that room's face only: WALL FACE, its room and
//                side, length inside corner to inside corner, gross and net square feet and
//                baseboard length, as room-faces.js computes them
//   several      Shift-click adds a face from another wall; the panel lists both and totals
//                them; Shift-click on a selected face takes it out
//   finish       a finish chosen for the selection is written to each wall side under the
//                faces, and one UNDO takes it back
//   tops         a click on a wall's top selects nothing
//   a room       a floor's SELECT THIS ROOM'S WALLS selects all four of its faces
//   outside      a click on the outside of the house selects the outside face, corner to
//                outside corner
//
// Synthetic project and temporary runtime only; never uses the owner's stores.
// Run: node tools/e2e-wall-faces.mjs (Playwright + Chromium installed).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { chromium } from 'playwright';

const root = process.env.E2E_ROOT || process.cwd();
const state = await mkdtemp(tmpdir() + '/tiksi-faces-');
const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r));
const port = Number(process.env.E2E_APP_PORT) || socket.address().port; await new Promise(r => socket.close(r));
const child = spawn('python3', ['tools/serve.py', '--port', String(port), '--state-dir', state, '--projects-dir', state + '/projects'], { cwd: root, stdio: 'ignore' });
let browser;
const ok = label => console.log('  ok   ' + label);
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch('http://127.0.0.1:' + port)).ok) break; } catch {} await new Promise(r => setTimeout(r, 50)); }
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(60000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const saved = () => page.waitForFunction(() => document.querySelector('#save-status')?.textContent === 'SAVED TO DISK', null, { timeout: 120000 });
  await page.goto('http://127.0.0.1:' + port + '/#/budget');
  await saved();
  // An 8 x 4 m box (x east, y south; world z = plan y) split by a partition at x = 3 into a
  // kitchen and a living room. The north wall is drawn as two walls in a straight line; the
  // partition has a door and the living room's north wall a window. Walls 2.5 m high.
  await page.evaluate(async () => {
    const s = window.testStore = await import('/js/store.js');
    const p = s.propertyTemplate('Faces test');
    p.id = 'faces-house'; p.env.quality = 'low'; p.env.showCeilings = false;
    const L = p.levels[0].id;
    p.levels[0].height = 2.5;
    const wall = (id, ax, ay, bx, by) => ({ id, level: L, ax, ay, bx, by, thickness: 0.15, height: null, material: 'mat-drywall' });
    p.walls.push(wall('n1', 0, 0, 5, 0), wall('n2', 5, 0, 8, 0), wall('e', 8, 0, 8, 4), wall('s', 8, 4, 0, 4), wall('w', 0, 4, 0, 0), wall('mid', 3, 0, 3, 4));
    p.rooms.push({ id: 'k', level: L, name: 'Kitchen', pts: [[0, 0], [3, 0], [3, 4], [0, 4]], material: 'mat-oak', ceilingMaterial: null },
      { id: 'l', level: L, name: 'Living', pts: [[3, 0], [8, 0], [8, 4], [3, 4]], material: 'mat-oak', ceilingMaterial: null });
    p.openings.push({ id: 'door', wallId: 'mid', type: 'door', t: 0.5, width: 0.9, height: 2.03 },
      { id: 'win', wallId: 'n2', type: 'window', t: 0.5, width: 1.2, height: 1.2, sill: 0.9 });
    // Cameras to click from: inside the kitchen toward each of its long walls, and outside the south side.
    const { normalizeSavedView } = await import('/js/saved-views.js');
    p.savedViews = [
      { id: 'v-west', name: 'West', camera: { position: [2.6, 3.2, 2], target: [0.075, 1.1, 2], fov: 50 } },
      { id: 'v-east', name: 'East', camera: { position: [0.4, 3.2, 2], target: [2.925, 1.1, 2], fov: 50 } },
      { id: 'v-top', name: 'Top', camera: { position: [0.0, 9, 2.001], target: [0.0, 0, 2], fov: 50 } },
      { id: 'v-out', name: 'Out', camera: { position: [4, 1.6, 12], target: [4, 1.2, 4], fov: 50 } },
    ].map(v => normalizeSavedView(v, new Set()));
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
  // Where a world point is on the screen, from the camera MODEL reports.
  const screenOf = p => page.evaluate(async p => {
    const THREE = await import('three'), c = (await import('/js/viewer3d.js')).markupState().camera;
    const r = document.querySelector('canvas.v-canvas').getBoundingClientRect();
    const cam = new THREE.PerspectiveCamera(c.fov, r.width / r.height, 0.05, 3000);
    cam.position.set(...c.position); cam.lookAt(new THREE.Vector3(...c.target)); cam.updateMatrixWorld();
    const q = new THREE.Vector3(...p).project(cam);
    return { x: r.left + (q.x + 1) / 2 * r.width, y: r.top + (1 - q.y) / 2 * r.height };
  }, p);
  const goTo = async id => {
    await page.evaluate(id => document.querySelector(`[data-view-go="${id}"]`).click(), id);
    await page.waitForTimeout(900); await idle();
  };
  const clickAt = async p => { const q = await screenOf(p); await page.mouse.click(q.x, q.y); };
  const shiftClickAt = async p => { const q = await screenOf(p); await page.keyboard.down('Shift'); await page.mouse.click(q.x, q.y); await page.keyboard.up('Shift'); };
  // What room-faces.js says, formatted as the app writes it.
  const expected = await page.evaluate(async () => {
    const s = window.testStore, p = s.activeProperty(), L = p.levels[0].id;
    const { roomFaces } = await import('/js/room-faces.js');
    const faces = roomFaces({ walls: s.wallsOn(p, L), rooms: s.roomsOn(p, L), openings: s.openingsOn(p, L), heightOf: w => w.height || s.levelHeight(p, L) });
    const fmt = f => ({ id: f.id, label: f.label, length: s.fmtLen(f.length), gross: s.fmtArea(f.gross), net: s.fmtArea(f.net), baseboard: s.fmtLen(f.baseboard), raw: f });
    return Object.fromEntries(faces.map(f => [f.label, fmt(f)]));
  });
  const stat = async name => (await page.locator('.inspector .stat-line', { hasText: name }).first().locator('b').textContent()).trim();

  await page.locator('#rail [data-view=model]').click();
  await canvas.waitFor();
  await idle();

  // ---------- one face ----------
  await goTo('v-west');
  await clickAt([0.08, 1.2, 2.6]);
  await waitUntil(async () => (await heading.textContent()) === 'WALL FACE', 'a click on the kitchen\'s west wall shows WALL FACE');
  const west = expected['Kitchen, west wall'];
  assert.equal((await page.locator('.inspector .op-name').textContent()).trim(), 'Kitchen, west wall');
  assert.equal(await stat('Face length'), west.length, 'inside corner to inside corner');
  assert.equal(west.length, '12\'-7 9/16"', '4 m less the two walls\' half thicknesses');
  assert.equal(await stat('Area, gross'), west.gross);
  assert.equal(await stat('Area, net'), west.net);
  assert.equal(await stat('Baseboard length'), west.baseboard);
  ok('a click selects the kitchen\'s west wall face: ' + west.length + ', ' + west.gross);

  // ---------- several ----------
  await goTo('v-east');
  await shiftClickAt([2.92, 1.0, 3.2]);
  await waitUntil(async () => (await heading.textContent()) === '2 WALL FACES', 'Shift-click adds the partition\'s kitchen face');
  const east = expected['Kitchen, east wall'];
  const rows = await page.locator('.inspector .v-face-rows .stat-line span').allTextContents();
  assert.deepEqual(rows.map(r => r.split(' · ')[0]).sort(), ['Kitchen, east wall', 'Kitchen, west wall']);
  const sumArea = await page.evaluate(([a, b]) => window.testStore.fmtArea(a + b), [west.raw.net, east.raw.net]);
  assert.equal(await stat('Area, net'), sumArea, 'the net area is the two faces\' sum');
  assert.equal(await stat('Openings subtracted'), '1 (' + await page.evaluate(a => window.testStore.fmtArea(a), east.raw.openingArea) + ')', 'the partition\'s door is subtracted once');
  const bb = await page.evaluate(([a, b]) => window.testStore.fmtLen(a + b), [west.raw.baseboard, east.raw.baseboard]);
  assert.equal(await stat('Baseboard length'), bb, 'baseboard skips the door');
  ok('Shift-click adds the partition face; totals ' + sumArea + ' net, baseboard ' + bb);
  await shiftClickAt([2.92, 1.0, 3.2]);
  await waitUntil(async () => (await heading.textContent()) === 'WALL FACE', 'Shift-click on a selected face takes it out');
  ok('Shift-click on a selected face takes it out');

  // ---------- finish ----------
  await shiftClickAt([2.92, 1.0, 3.2]);
  await waitUntil(async () => (await heading.textContent()) === '2 WALL FACES', 'both faces again');
  const sage = await page.evaluate(() => window.testStore.ws.data.materials.find(m => m.kind === 'wall' && m.id !== 'mat-drywall').id);
  await page.locator('.inspector [data-face-mat]').selectOption(sage);
  const sides = () => page.evaluate(() => { const p = window.testStore.activeProperty(); const w = id => p.walls.find(x => x.id === id); return { w: w('w').materialPos, mid: w('mid').materialPos, midOther: w('mid').materialNeg }; });
  await waitUntil(async () => (await sides()).w === sage, 'the finish is written to the west wall\'s room side');
  const after = await sides();
  assert.equal(after.mid, sage, 'and to the partition\'s kitchen side');
  assert.equal(after.midOther, undefined, 'the partition\'s living-room side keeps its own');
  await page.keyboard.press('ControlOrMeta+z');
  await waitUntil(async () => (await sides()).w === undefined, 'one UNDO takes the finish back');
  assert.equal((await sides()).mid, undefined);
  ok('a finish goes to each wall side under the selected faces, and UNDO takes it back');

  // ---------- tops ----------
  await goTo('v-top');
  await clickAt([0.0, 2.5, 2.0]);
  await waitUntil(async () => (await heading.textContent()) === 'NOTHING SELECTED', 'a click on a wall top selects nothing');
  ok('a click on a wall\'s top selects nothing');

  // ---------- a room ----------
  await goTo('v-east');
  await clickAt([2.2, 0.01, 1.6]);
  await waitUntil(async () => (await heading.textContent()) === 'ROOM / FLOOR', 'the kitchen floor');
  await page.locator('.inspector [data-room-faces]').click();
  await waitUntil(async () => (await heading.textContent()) === '4 WALL FACES', 'the kitchen\'s four walls');
  const kitchen = Object.values(expected).filter(f => f.raw.roomId === 'k');
  const kNet = await page.evaluate(n => window.testStore.fmtArea(n), kitchen.reduce((n, f) => n + f.raw.net, 0));
  assert.equal(await stat('Area, net'), kNet);
  ok('SELECT THIS ROOM\'S WALLS selects the kitchen\'s 4 faces, ' + kNet + ' net');

  // ---------- outside ----------
  await goTo('v-out');
  await clickAt([6, 1.2, 4.08]);
  await waitUntil(async () => (await heading.textContent()) === 'WALL FACE', 'the outside south face');
  assert.equal((await page.locator('.inspector .op-name').textContent()).trim(), 'Outside, south face');
  assert.equal(await stat('Face length'), expected['Outside, south face'].length, 'corner to outside corner');
  assert.equal(expected['Outside, south face'].length, '26\'-8 7/8"', '8 m and both walls\' half thicknesses');
  ok('the outside of the house is one face per side: ' + expected['Outside, south face'].length);

  assert.deepEqual(errors, [], 'no page errors');
  console.log('wall faces: all checks passed');
} finally {
  if (browser) await browser.close();
  child.kill();
  await rm(state, { recursive: true, force: true });
}
