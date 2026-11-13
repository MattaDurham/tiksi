// Doors shown open or closed in MODEL. Right-clicking a door offers CLOSE DOOR or OPEN DOOR;
// CLOSE ALL DOORS (the right-click menu's lower part and the Tiksi menu's Display group) shuts
// every interior door and OPEN ALL DOORS stands them ajar again; each is one UNDO step. MODEL's
// door panel shows the state, sets it with Shown, and has no position slider. Real clicks on
// the rendered view. Synthetic project and temporary runtime only; never uses the owner's stores.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { chromium } from 'playwright';

const root = process.env.E2E_ROOT || process.cwd();
const state = await mkdtemp(tmpdir() + '/tiksi-doorstates-');
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
  await page.goto('http://127.0.0.1:' + port + '/#/budget');
  await page.waitForFunction(() => document.querySelector('#save-status').textContent === 'SAVED TO DISK');
  // One wall along plan y = 0 with rooms on both sides of its left part (an interior door at
  // x = -1) and a room on one side only of its right part (an exterior door at x = 2). No other
  // walls, so the front view looks straight at both doors.
  await page.evaluate(async () => {
    const s = window.testStore = await import('/js/store.js');
    const p = s.propertyTemplate('Door states test');
    p.id = 'door-states-house'; p.env.quality = 'low';
    const level = p.levels[0].id, wall = (id, ax, ay, bx, by) => ({ id, level, ax, ay, bx, by, thickness: .12, height: null, material: 'mat-drywall' });
    p.walls.push(wall('inner-wall', -3, 0, 1, 0), wall('outer-wall', 1, 0, 3, 0));
    p.rooms.push({ id: 'north', level, name: 'North', pts: [[-3, 0], [1, 0], [1, 3], [-3, 3]], material: 'mat-oak', ceilingMaterial: null });
    p.rooms.push({ id: 'south', level, name: 'South', pts: [[-3, -3], [1, -3], [1, 0], [-3, 0]], material: 'mat-oak', ceilingMaterial: null });
    p.rooms.push({ id: 'porch', level, name: 'Porch', pts: [[1, 0], [3, 0], [3, 3], [1, 3]], material: 'mat-oak', ceilingMaterial: null });
    p.openings.push({ id: 'inner', wallId: 'inner-wall', t: 0.5, type: 'door', width: 0.813, height: 2.03 });
    p.openings.push({ id: 'entry', wallId: 'outer-wall', t: 0.5, type: 'door', width: 0.9, height: 2.03 });
    s.ws.data.settings.sketchupMirror = false;
    s.ws.data.properties.push(p); s.ws.data.settings.activePropertyId = p.id; s.touch();
    await (await import('/js/disk-workspace.js')).diskWorkspace.sync();
  });
  const doorState = id => page.evaluate(id => { const o = window.testStore.activeProperty().openings.find(o => o.id === id); return 'doorState' in o ? o.doorState : null; }, id);
  const waitUntil = async (check, what) => {
    for (let i = 0; i < 150; i++) { if (await check()) return; await page.waitForTimeout(200); }
    assert.fail('timed out waiting until ' + what);
  };
  const idle = () => waitUntil(() => page.evaluate(async () => (await import('/js/viewer3d.js')).viewerIdle()), 'MODEL has settled');
  // How far each leaf of a door is turned from shut, in degrees, as MODEL builds its wall.
  const turn = id => page.evaluate(async id => {
    const g = await import('/js/geometry.js'), p = window.testStore.activeProperty();
    const o = p.openings.find(o => o.id === id), w = p.walls.find(w => w.id === o.wallId);
    const group = g.buildWallGroup(w, p.openings, { walls: p.walls, rooms: p.rooms, wallHeight: 2.44 }, {});
    const door = group.children.find(c => c.isGroup && c.userData.kind === 'opening' && c.userData.id === id);
    return door.children.filter(c => c.isGroup).map(pivot => Math.round(Math.abs(pivot.rotation.y) * 180 / Math.PI));
  }, id);
  // Where a model point is on the page (world x, height, plan y).
  const onScreen = point => page.evaluate(async point => {
    const THREE = await import('three'), v = await import('/js/viewer3d.js');
    const cam = v.drawStats().camera, r = document.querySelector('canvas.v-canvas').getBoundingClientRect();
    const q = new THREE.Vector4(...point, 1).applyMatrix4(new THREE.Matrix4().fromArray(cam.inverse)).applyMatrix4(new THREE.Matrix4().fromArray(cam.projection));
    return [r.left + (q.x / q.w + 1) / 2 * r.width, r.top + (1 - q.y / q.w) / 2 * r.height];
  }, point);
  const menu = page.locator('.v-ctx');
  const closeMenu = async () => { if (await menu.count()) await page.keyboard.press('Escape'); if (await menu.count()) await page.mouse.click(5, 5); };
  // Right-click around a door's middle until the menu offers to open or close it.
  async function rightClickDoor(x) {
    for (const [dx, y] of [[0.1, 1.2], [0.2, 1.5], [-0.1, 1.0], [0.25, 0.8], [0, 1.7]]) {
      const [sx, sy] = await onScreen([x + dx, y, 0]);
      await page.mouse.click(sx, sy, { button: 'right' });
      await page.waitForTimeout(150);
      const item = menu.locator('[data-ctx=door-state]');
      if (await item.count()) return item;
      await closeMenu();
    }
    assert.fail('no right-click on the door at x = ' + x + ' offered to open or close it');
  }
  async function rightClickWall() {
    const [sx, sy] = await onScreen([-2.4, 2.2, 0]);
    await page.mouse.click(sx, sy, { button: 'right' });
    await menu.waitFor();
    return menu.locator('[data-ctx=toggle-doors]');
  }

  await page.locator('#rail [data-view=model]').click();
  await page.locator('canvas.v-canvas').waitFor();
  await page.locator('[data-act=front]').click();
  await page.waitForTimeout(900);
  await idle();
  assert.deepEqual(await turn('inner'), [25], 'an interior door stands ajar to start with');
  assert.deepEqual(await turn('entry'), [0], 'an exterior door is shut');

  // ---------- one door by right-click ----------
  let item = await rightClickDoor(-1);
  assert.equal(await item.innerText(), 'CLOSE DOOR');
  await item.click();
  await waitUntil(async () => (await doorState('inner')) === 'closed', 'CLOSE DOOR is saved on the door');
  assert.deepEqual(await turn('inner'), [0], 'and the leaf is shut');
  await waitUntil(async () => !(await page.locator('#btn-undo').isDisabled()), 'UNDO is offered');
  await page.keyboard.press('ControlOrMeta+z');
  await waitUntil(async () => (await doorState('inner')) === null, 'one UNDO stands it ajar again');
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await waitUntil(async () => (await doorState('inner')) === 'closed', 'REDO shuts it');
  await idle();
  item = await rightClickDoor(-1);
  assert.equal(await item.innerText(), 'OPEN DOOR', 'a shut door offers to open');
  await item.click();
  await waitUntil(async () => (await doorState('inner')) === null, 'OPEN DOOR puts an interior door back to the default');
  assert.deepEqual(await turn('inner'), [25]);
  await idle();
  item = await rightClickDoor(2);
  assert.equal(await item.innerText(), 'OPEN DOOR', 'an exterior door offers to open');
  await item.click();
  await waitUntil(async () => (await doorState('entry')) === 'open', 'OPEN DOOR is saved on the exterior door');
  assert.deepEqual(await turn('entry'), [25], 'and it stands ajar');

  // ---------- every interior door ----------
  await idle();
  let all = await rightClickWall();
  assert.equal(await all.innerText(), 'CLOSE ALL DOORS');
  assert.equal(await menu.locator('[data-ctx=door-state]').count(), 0, 'a wall offers no door item');
  await all.click();
  await waitUntil(async () => (await doorState('inner')) === 'closed', 'CLOSE ALL DOORS shuts the interior door');
  assert.equal(await doorState('entry'), 'open', 'and leaves the exterior door as it was');
  await idle();
  all = await rightClickWall();
  assert.equal(await all.innerText(), 'OPEN ALL DOORS', 'with every interior door shut it offers to open them');
  await all.click();
  await waitUntil(async () => (await doorState('inner')) === null, 'OPEN ALL DOORS stands them ajar again');
  await page.keyboard.press('ControlOrMeta+z');
  await waitUntil(async () => (await doorState('inner')) === 'closed', 'one UNDO takes OPEN ALL DOORS back');
  // The left pane's Display group has the same switch.
  await idle();
  const display = page.locator('#side .sd-group[data-group="Display"] .sd-item', { hasText: /all doors/ });
  assert.equal(await display.innerText(), 'Open all doors');
  await display.click();
  await waitUntil(async () => (await doorState('inner')) === null, 'Open all doors in the left pane opens them');
  await waitUntil(async () => (await display.innerText()) === 'Close all doors', 'the pane then offers to close them');

  // ---------- the inspectors ----------
  await idle();
  const [ix, iy] = await onScreen([-0.9, 1.2, 0]);
  const shown = page.locator('.inspector [data-door-state]');
  for (const [dx, dy] of [[0, 0], [20, 0], [-20, 30], [30, -40]]) {
    await page.mouse.click(ix + dx, iy + dy);
    await page.waitForTimeout(150);
    if (await shown.count()) break;
  }
  assert.equal(await shown.inputValue(), 'open', 'MODEL\'s door panel shows the door open');
  assert.equal(await page.locator('.inspector input[type=range]').count(), 0, 'and has no position slider');
  await shown.selectOption('closed');
  await waitUntil(async () => (await doorState('inner')) === 'closed', 'Shown: Closed shuts the door');

  // The panel follows: Open again, and the door stands ajar.
  await idle();
  assert.equal(await shown.inputValue(), 'closed', 'the panel shows the door it shut');
  await shown.selectOption('open');
  await waitUntil(async () => (await doorState('inner')) === null, 'Shown: Open stands it ajar again');
  assert.deepEqual(await turn('inner'), [25]);
  assert.deepEqual(errors, [], 'no page errors');
  console.log('ok   a door opens and closes by right-click, every interior door at once, and from MODEL\'s door panel, each one UNDO step');
} finally {
  if (browser) await browser.close();
  child.kill('SIGTERM');
  await rm(state, { recursive: true, force: true });
}
