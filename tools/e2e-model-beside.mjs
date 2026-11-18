// MODEL BESIDE: the model in a pane next to another page, the bar between them, PROJECTS
// outlining its linked elements there, and the keys staying with the page until the model is
// clicked. Demo workspace (synthetic) in a temporary state directory; live 8642 is never used.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { chromium } from 'playwright';

const state = await mkdtemp(tmpdir() + '/tiksi-model-beside-test-');
const socket = net.createServer();
await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
const port = socket.address().port;
await new Promise(resolve => socket.close(resolve));
const child = spawn('python3', ['tools/serve.py', '--port', String(port), '--state-dir', state], { stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.resume(); child.stderr.resume();
const url = 'http://127.0.0.1:' + port;
let browser;
try {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url)).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url); await page.waitForFunction(() => document.querySelector('#save-status').textContent === 'SAVED TO DISK');
  // The demo house, with one project linked to a room and two walls, and one scope item to the walls.
  const ids = await page.evaluate(async () => {
    const store = await import('/js/store.js');
    store.mergeWorkspace((await import('/js/demo.js')).demoWorkspace()); store.touch();
    const prop = store.activeProperty();
    const bath = store.ws.data.projects.find(p => p.name === 'Primary bath refresh');
    const room = prop.rooms[1], walls = prop.walls.slice(0, 2).map(w => w.id);
    bath.roomId = room.id;
    bath.items[0].elementIds = walls;
    store.touch();
    await (await import('/js/disk-workspace.js')).diskWorkspace.sync();
    return { bath: bath.id, room: room.id, walls, item: bath.items[0].id };
  });
  const sel = async () => {
    await page.waitForFunction(async () => !!(await import('/js/viewer3d.js')).selectionState());
    return page.evaluate(async () => (await import('/js/viewer3d.js')).selectionState());
  };
  // The disk sync rebuilds the page (and the model beside it) once shortly after a load: wait for it.
  const cam = async () => {
    await page.waitForFunction(async () => !!(await import('/js/viewer3d.js')).cameraState());
    return page.evaluate(async () => (await import('/js/viewer3d.js')).cameraState().position);
  };
  const width = q => page.evaluate(s => document.querySelector(s).getBoundingClientRect().width, q);
  const settle = () => page.evaluate(() => new Promise(resolve => {
    let timer = setTimeout(done, 1200);
    const mo = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(done, 1200); });
    function done() { mo.disconnect(); resolve(); }
    mo.observe(document.querySelector('#view'), { childList: true, subtree: true });
  }));

  await page.goto(url + '/#/estimate?project=' + ids.bath); await page.reload();
  await page.locator('.es-rooms').waitFor();
  await settle();
  assert.equal(await page.locator('#beside').isHidden(), true, 'the model is not beside the page until asked for');

  // ---------- the switch opens the model beside the page, half and half ----------
  await page.click('#btn-beside');
  await page.locator('#beside canvas').waitFor();
  await settle();
  assert.equal(await page.getAttribute('#btn-beside', 'aria-pressed'), 'true');
  assert.equal((await sel()).beside, true, 'the model knows it is beside another page');
  const stageW = await width('#stage'), pageW = await width('#view'), modelW = await width('#beside');
  assert.ok(Math.abs(pageW - stageW / 2) < 12, `the page takes half the width at first (${pageW} of ${stageW})`);
  assert.ok(modelW > 500, 'the model pane has room to show the model');
  assert.equal(await page.locator('#beside .inspector').isVisible(), false, 'the inspector stays with MODEL');
  assert.equal(await page.locator('#beside .v-objects').isVisible(), false, 'the component list stays with MODEL');
  assert.equal(await page.locator('#side').isVisible(), false, 'the model does not take over the left pane');

  // ---------- the project shown is outlined when the model opens beside it, and brought into view ----------
  const before = await cam();
  await page.waitForFunction(async want => {
    const s = (await import('/js/viewer3d.js')).selectionState();
    return s && want.every(id => s.things.includes(id)) && s.things.length === want.length;
  }, [ids.room, ...ids.walls]);
  let s = await sel();
  assert.ok(s.outlined > 0, 'the linked room and walls are outlined');
  assert.ok(s.edge.strength > 4.5 && s.edge.thickness >= 2 && s.edge.fill, 'the selection is drawn with a strong, thick edge and a tint');
  await page.waitForFunction(async was => {
    const p = (await import('/js/viewer3d.js')).cameraState().position;
    return Math.hypot(p[0] - was[0], p[1] - was[1], p[2] - was[2]) > 0.5;
  }, before);
  await page.waitForTimeout(900);   // the camera's flight
  assert.ok(new URL(page.url()).hash.startsWith('#/estimate'), 'the page stays ESTIMATE');

  // ---------- clicking into a scope item outlines only its own elements ----------
  if (!await page.locator(`tr[data-si="${ids.item}"]`).count()) await page.locator('tr[data-room="other"] td:first-child').click();
  await page.locator(`tr[data-si="${ids.item}"] .si-more`).click();
  await page.waitForFunction(async want => {
    const s = (await import('/js/viewer3d.js')).selectionState();
    return s && s.things.length === want.length && want.every(id => s.things.includes(id));
  }, ids.walls);

  // ---------- a link to an element selects it beside the page instead of leaving ----------
  const chip = page.locator(`#es-dbody a[href="#/model?select=${encodeURIComponent(ids.walls[1])}"]`);
  await chip.click();
  await page.waitForFunction(async id => { const s = (await import('/js/viewer3d.js')).selectionState(); return s && s.id === id && s.things.length === 1; }, ids.walls[1]);
  assert.ok(new URL(page.url()).hash.startsWith('#/estimate'), 'the link did not open MODEL');

  // ---------- the keys stay with the page until the model is clicked ----------
  await page.evaluate(async id => (await import('/js/model-focus.js')).showInModel([id], { frame: false }), ids.walls[0]);
  await page.locator('.es-head .es-kicker').click();
  await page.keyboard.press('Backspace');
  await page.keyboard.press('t');
  assert.ok(await page.evaluate(async id => (await import('/js/store.js')).activeProperty().walls.some(w => w.id === id), ids.walls[0]),
    'Backspace on the page did not delete the wall selected in the model');
  assert.equal((await page.evaluate(async () => (await import('/js/viewer3d.js')).cameraState().mode)), 'orbit', 'T on the page did not switch the model to TOP');
  const box = await page.locator('#beside canvas').boundingBox();
  await page.mouse.click(box.x + 20, box.y + box.height - 40);
  await page.keyboard.press('t');
  await page.waitForFunction(async () => (await import('/js/viewer3d.js')).cameraState().mode === 'top');
  await page.keyboard.press('o');

  // ---------- the bar shares the width, and the share is remembered ----------
  const bar = await page.locator('#beside-bar').boundingBox();
  const startW = await width('#view');
  await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2);
  await page.mouse.down();
  await page.mouse.move(bar.x + bar.width / 2 - 120, bar.y + bar.height / 2, { steps: 6 });
  await page.mouse.move(bar.x + bar.width / 2 - 200, bar.y + bar.height / 2, { steps: 6 });
  await page.mouse.up();
  const draggedW = await width('#view');
  assert.ok(Math.abs(draggedW - (startW - 200)) < 6, `dragging the bar 200 px narrows the page by as much (${startW} -> ${draggedW})`);
  await page.locator('#beside-bar').focus();
  await page.keyboard.press('ArrowRight');
  assert.ok(Math.abs(await width('#view') - (draggedW + 24)) < 4, 'an arrow key moves the bar');
  await page.mouse.move(bar.x + bar.width / 2, bar.y + 300);
  await page.mouse.down(); await page.mouse.move(40, bar.y + 300, { steps: 4 }); await page.mouse.up();
  assert.ok(await width('#view') >= 279, 'the page never gets narrower than 280 px');
  await page.locator('#beside-bar').dblclick();
  assert.ok(Math.abs(await width('#view') - stageW / 2) < 12, 'a double-click puts the bar back to half');
  await page.mouse.move(bar.x + bar.width / 2, bar.y + 300);
  await page.mouse.down(); await page.mouse.move(bar.x + bar.width / 2 + 150, bar.y + 300, { steps: 6 }); await page.mouse.up();
  const keptW = await width('#view');
  await page.reload();
  await page.locator('#beside canvas').waitFor();
  assert.ok(Math.abs(await width('#view') - keptW) < 6, 'the share and the switch are remembered after a reload');

  // ---------- other pages get the model too; MODEL itself takes it back ----------
  await page.click('#rail a[data-view="estimate"]');
  await page.waitForFunction(() => location.hash.startsWith('#/estimate'));
  await page.locator('#beside canvas').waitFor();
  await page.click('#rail a[data-view="model"]');
  await page.waitForFunction(() => location.hash === '#/model' && !!document.querySelector('#view canvas'));
  assert.equal(await page.locator('#beside').isHidden(), true, 'MODEL shows the model once, as the page');
  assert.equal((await sel()).beside, false);
  await page.click('#rail a[data-view="estimate"]');
  await page.locator('#beside canvas').waitFor();
  await page.waitForFunction(async () => ((await import('/js/viewer3d.js')).selectionState() || {}).things?.length > 0);

  // ---------- OPEN MODEL keeps the camera; the close button puts the page back to full width ----------
  const there = await cam();
  await page.click('#beside [data-bs-open]');
  await page.waitForFunction(() => location.hash === '#/model' && !!document.querySelector('#view canvas'));
  const kept = await cam();
  assert.ok(Math.hypot(kept[0] - there[0], kept[1] - there[1], kept[2] - there[2]) < 0.05, 'MODEL opens on the view the pane showed');
  await page.click('#rail a[data-view="estimate"]');
  await page.locator('#beside canvas').waitFor();
  await page.click('#beside [data-bs-close]');
  assert.equal(await page.locator('#beside').isHidden(), true);
  assert.equal(await page.getAttribute('#btn-beside', 'aria-pressed'), 'false');
  assert.ok(Math.abs(await width('#view') - stageW) < 2, 'the page has the whole width again');
  assert.equal(await page.evaluate(() => localStorage.getItem('tiksi.modelBeside')), null);

  // ---------- the phone layout has no room for two panes ----------
  await page.click('#btn-beside');
  await page.locator('#beside canvas').waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.documentElement.classList.contains('phone'));
  await page.waitForFunction(() => document.querySelector('#beside').hidden);
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.locator('#beside canvas').waitFor();

  assert.deepEqual(errors, [], 'no page errors');
  console.log('model beside: switch, bar, project outlines, links, keys, MODEL hand-over and phone layout ok');
} finally {
  if (browser) await browser.close();
  child.kill();
  await rm(state, { recursive: true, force: true });
}
