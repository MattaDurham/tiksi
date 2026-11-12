// A door's LEAF choice in MODEL and PLAN (Solid panel, Glass or Half glass) and PLAN's LEAVES
// choice of None (a cased opening). Choosing Glass on
// a pair of outside doors saves it on the door, draws panes the sun passes, goes back with
// UNDO, and is offered in PLAN's door inspector too. Real clicks on the rendered views.
// Synthetic project and temporary runtime only; never uses the owner's stores.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { chromium } from 'playwright';

const root = process.env.E2E_ROOT || process.cwd();
const state = await mkdtemp(tmpdir() + '/tiksi-glassdoors-');
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
  // A room north of a 4 m wall at y = 0 with a 1.5 m pair of outside doors at its centre: seen
  // from the front and drawn in plan, the doors are in the middle of the view.
  await page.evaluate(async () => {
    const s = window.testStore = await import('/js/store.js');
    const p = s.propertyTemplate('Glass doors test');
    p.id = 'glass-doors-house'; p.env.quality = 'low';
    const level = p.levels[0].id, wall = (id, ax, ay, bx, by, thickness = .1) => ({ id, level, ax, ay, bx, by, thickness, height: null, material: 'mat-drywall' });
    p.walls.push(wall('front', -2, 0, 2, 0, .2), wall('left', -2, 0, -2, -2), wall('right', 2, 0, 2, -2), wall('back', -2, -2, 2, -2));
    p.rooms.push({ id: 'room', level, name: 'Room', pts: [[-2, -2], [2, -2], [2, 0], [-2, 0]], material: 'mat-oak', ceilingMaterial: null });
    p.openings.push({ id: 'french', wallId: 'front', t: 0.5, type: 'door', width: 1.5, height: 2.03, leaves: 2 });
    s.ws.data.settings.sketchupMirror = false;
    s.ws.data.properties.push(p); s.ws.data.settings.activePropertyId = p.id; s.touch();
    await (await import('/js/disk-workspace.js')).diskWorkspace.sync();
  });
  const door = () => page.evaluate(() => { const o = window.testStore.activeProperty().openings.find(o => o.id === 'french'); return { glass: o.glass, has: 'glass' in o, leaves: o.leaves }; });
  const waitUntil = async (check, what) => {
    for (let i = 0; i < 150; i++) { if (await check()) return; await page.waitForTimeout(200); }
    assert.fail('timed out waiting until ' + what);
  };
  const idle = () => waitUntil(() => page.evaluate(async () => (await import('/js/viewer3d.js')).viewerIdle()), 'MODEL has settled');
  // Click up and down the middle of a view (a little to one side: the two leaves meet in the
  // very middle) until the door's LEAF choice shows.
  async function pickDoor(canvas, inspector) {
    const box = await canvas.boundingBox(), leaf = page.locator(inspector + ' [data-glass]');
    for (let dy = 0; dy <= 150; dy = dy > 0 ? -dy : -dy + 6) {
      await page.mouse.click(box.x + box.width / 2 + 25, box.y + box.height / 2 + dy);
      await page.waitForTimeout(150);
      if (await leaf.count()) return leaf;
    }
    assert.fail('the door could not be selected in ' + inspector);
  }

  // ---------- MODEL ----------
  await page.locator('#rail [data-view=model]').click();
  await page.locator('canvas.v-canvas').waitFor();
  await page.locator('[data-act=front]').click();
  await page.waitForTimeout(900);
  await idle();
  const leaf = await pickDoor(page.locator('canvas.v-canvas'), '.inspector');
  assert.equal(await page.locator('.inspector h3').first().innerText(), 'DOOR', 'a wide pair of doors is a door, not a cased opening');
  assert.equal(await leaf.inputValue(), '', 'a door starts as a solid panel');
  assert.deepEqual(await leaf.locator('option').allInnerTexts(), ['Solid panel', 'Glass', 'Half glass']);

  // What MODEL builds for the wall, in the page (the real browser build, textures and all).
  const built = () => page.evaluate(async () => {
    const g = await import('/js/geometry.js'), p = window.testStore.activeProperty();
    const w = p.walls.find(w => w.id === 'front');
    const group = g.buildWallGroup(w, p.openings, { walls: p.walls, rooms: p.rooms, wallHeight: 2.44 }, {});
    const out = { panes: 0, paneShadows: 0, solid: 0, lowest: null };
    group.traverse(o => {
      if (!o.isMesh || !o.userData || o.userData.id !== 'french') return;
      if (o.userData.glass) {
        out.panes++; if (o.castShadow) out.paneShadows++;
        o.geometry.computeBoundingBox(); out.lowest = Math.round(o.geometry.boundingBox.min.y * 100) / 100;
      } else if (o.geometry.type === 'BoxGeometry') out.solid++;
    });
    return out;
  });
  assert.deepEqual(await built(), { panes: 0, paneShadows: 0, solid: 2, lowest: null }, 'two solid leaves to start with');

  await leaf.selectOption('full');
  await waitUntil(async () => (await door()).glass === 'full', 'the door is saved as glass');
  assert.deepEqual(await built(), { panes: 2, paneShadows: 0, solid: 0, lowest: 0.2 }, 'Glass: a pane in each leaf, none casting a shadow');
  await idle();
  assert.equal(await page.locator('.inspector [data-glass]').inputValue(), 'full', 'the inspector shows the choice after the model is rebuilt');
  await waitUntil(async () => !(await page.locator('#btn-undo').isDisabled()), 'UNDO is offered');
  await page.locator('#btn-undo').click();
  await waitUntil(async () => !(await door()).has, 'UNDO takes the glass away');
  assert.equal((await built()).panes, 0, 'and the leaves are solid again');
  await page.locator('#btn-redo').click();
  await waitUntil(async () => (await door()).glass === 'full', 'REDO brings it back');

  await idle();
  const again = await pickDoor(page.locator('canvas.v-canvas'), '.inspector');
  await again.selectOption('half');
  await waitUntil(async () => (await door()).glass === 'half', 'Half glass is saved');
  assert.deepEqual(await built(), { panes: 2, paneShadows: 0, solid: 0, lowest: 0.95 }, 'Half glass: the panes start at waist height');
  assert.equal((await door()).leaves, 2, 'the door is still a pair');

  // ---------- PLAN ----------
  await page.locator('#rail [data-view=plan]').click();
  await page.locator('.plan-canvas canvas').first().waitFor();
  await page.waitForTimeout(500);
  const planLeaf = await pickDoor(page.locator('.plan-canvas canvas').first(), '.inspector');
  assert.equal(await planLeaf.inputValue(), 'half', 'PLAN shows the same choice');
  await planLeaf.selectOption('');
  await waitUntil(async () => !(await door()).has, 'Solid panel in PLAN removes the choice from the door');
  assert.equal((await built()).solid, 2, 'and the leaves are solid');
  // LEAVES: None makes it a cased opening, with no leaf to hang or to choose.
  await page.locator('.inspector [data-leaves]').selectOption('0');
  await waitUntil(async () => (await door()).leaves === 0, 'None is saved on the door as no leaf');
  const cased = await built();
  assert.deepEqual([cased.solid, cased.panes], [0, 0], 'a cased opening hangs no leaf');
  assert.equal(await page.locator('.inspector [data-leaves]').inputValue(), '0', 'PLAN shows None');
  assert.equal(await page.locator('.inspector [data-glass]').count(), 0, 'and offers no leaf material');
  assert.deepEqual(errors, [], 'no page errors');
  console.log('ok   a door can be glass or half glass, from MODEL and from PLAN, or a cased opening with no leaf');
} finally {
  if (browser) await browser.close();
  child.kill('SIGTERM');
  await rm(state, { recursive: true, force: true });
}
