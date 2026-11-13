// A door's leaf as MODEL builds and shows it: Solid panel, Glass or Half glass, and a door with
// no leaves (a cased opening) or a plain opening with no frame. Leaves change in SketchUp, so the
// door's data is written here the way a SketchUp save comes back (the store, then MODEL told of
// the changed openings); MODEL's door panel then shows the leaf as a read-only line and offers
// no leaf or leaves choice. Glass draws panes the sun passes. Real clicks on the rendered view.
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
  await page.goto('http://127.0.0.1:' + port + '/#/budget');
  await page.waitForFunction(() => document.querySelector('#save-status').textContent === 'SAVED TO DISK');
  // A room north of a 4 m wall at y = 0 with a 1.5 m pair of outside doors at its centre: seen
  // from the front, the doors are in the middle of the view.
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
  // Click up and down the middle of the view (a little to one side: the two leaves meet in the
  // very middle) until the door's panel shows.
  const canvas = page.locator('canvas.v-canvas'), heading = page.locator('.inspector h3').first();
  async function pickDoor() {
    await idle();
    const box = await canvas.boundingBox();
    for (let dy = 0; dy <= 150; dy = dy > 0 ? -dy : -dy + 6) {
      await page.mouse.click(box.x + box.width / 2 + 25, box.y + box.height / 2 + dy);
      await page.waitForTimeout(150);
      if (await page.locator('.inspector [data-wall]').count()) return;
    }
    assert.fail('the door could not be selected');
  }
  // The panel's read-only line for one value.
  const stat = label => page.locator('.inspector .stat-line', { has: page.locator('span', { hasText: new RegExp('^' + label + '$') }) }).locator('b');
  // A change to the door as a SketchUp save brings it: written to the store, MODEL told.
  const fromSketchUp = change => page.evaluate(async change => {
    const o = window.testStore.activeProperty().openings.find(o => o.id === 'french');
    for (const [k, v] of Object.entries(change)) { if (v === undefined) delete o[k]; else o[k] = v; }
    window.testStore.touch();
    (await import('/js/viewer3d.js')).sharedChange(['openings']);
  }, change);

  // What MODEL builds for the wall, in the page (the real browser build, textures and all).
  const built = () => page.evaluate(async () => {
    const g = await import('/js/geometry.js'), p = window.testStore.activeProperty();
    const w = p.walls.find(w => w.id === 'front');
    const group = g.buildWallGroup(w, p.openings, { walls: p.walls, rooms: p.rooms, wallHeight: 2.44 }, {});
    const out = { panes: 0, paneShadows: 0, solid: 0, lowest: null, meshes: 0 };
    group.traverse(o => {
      if (!o.isMesh || !o.userData || o.userData.id !== 'french') return;
      out.meshes++;
      if (o.userData.glass) {
        out.panes++; if (o.castShadow) out.paneShadows++;
        o.geometry.computeBoundingBox(); out.lowest = Math.round(o.geometry.boundingBox.min.y * 100) / 100;
      } else if (o.geometry.type === 'BoxGeometry') out.solid++;
    });
    return out;
  });
  const leaves = async () => { const b = await built(); return { panes: b.panes, paneShadows: b.paneShadows, solid: b.solid, lowest: b.lowest }; };

  await page.locator('#rail [data-view=model]').click();
  await canvas.waitFor();
  await page.locator('[data-act=front]').click();
  await page.waitForTimeout(900);

  // ---------- a solid pair ----------
  await pickDoor();
  assert.equal(await heading.innerText(), 'DOOR', 'a wide pair of doors is a door, not a cased opening');
  assert.equal(await stat('Leaf').innerText(), 'Solid panel', 'a door starts as a solid panel, shown as a line');
  assert.equal(await page.locator('.inspector [data-glass]').count(), 0, 'and the leaf is not offered as a choice');
  assert.equal(await page.locator('.inspector [data-leaves]').count(), 0, 'nor are the leaves');
  assert.equal(await page.locator('.inspector [data-door-state]').count(), 1, 'Shown open or closed is still offered');
  assert.deepEqual(await leaves(), { panes: 0, paneShadows: 0, solid: 2, lowest: null }, 'two solid leaves to start with');

  // ---------- Glass ----------
  await fromSketchUp({ glass: 'full' });
  assert.deepEqual(await leaves(), { panes: 2, paneShadows: 0, solid: 0, lowest: 0.2 }, 'Glass: a pane in each leaf, none casting a shadow');
  await pickDoor();
  assert.equal(await stat('Leaf').innerText(), 'Glass', 'the panel shows Glass after the model is rebuilt');

  // ---------- Half glass ----------
  await fromSketchUp({ glass: 'half' });
  assert.deepEqual(await leaves(), { panes: 2, paneShadows: 0, solid: 0, lowest: 0.95 }, 'Half glass: the panes start at waist height');
  await pickDoor();
  assert.equal(await stat('Leaf').innerText(), 'Half glass', 'the panel shows Half glass');
  assert.equal((await door()).leaves, 2, 'the door is still a pair');

  // ---------- back to solid ----------
  await fromSketchUp({ glass: undefined });
  assert.equal((await built()).solid, 2, 'with no glass the leaves are solid again');

  // ---------- no leaves: a cased opening ----------
  await fromSketchUp({ leaves: 0 });
  const cased = await built();
  assert.deepEqual([cased.solid, cased.panes], [0, 0], 'a cased opening hangs no leaf');
  assert.ok(cased.meshes > 0, 'a cased opening keeps its jambs, head and casing');
  await pickDoor();
  assert.equal(await heading.innerText(), 'CASED OPENING', 'the panel names it a cased opening');
  assert.equal(await stat('Leaf').count(), 0, 'and shows no leaf');
  assert.equal(await page.locator('.inspector [data-door-state]').count(), 0, 'and nothing to open or close');

  // ---------- a plain opening ----------
  await fromSketchUp({ plain: true });
  assert.equal((await built()).meshes, 0, 'a plain opening builds no frame and no leaf (so there is nothing in the view to click)');

  // ---------- a single door again ----------
  await fromSketchUp({ plain: undefined, leaves: 1 });
  assert.equal((await built()).solid, 1, 'one solid leaf');
  await pickDoor();
  assert.equal(await heading.innerText(), 'DOOR');
  assert.equal(await stat('Leaf').innerText(), 'Solid panel');
  assert.deepEqual(errors, [], 'no page errors');
  console.log('ok   a door built as solid, glass or half glass, a cased opening or a plain one, and MODEL shows its leaf read-only');
} finally {
  if (browser) await browser.close();
  child.kill('SIGTERM');
  await rm(state, { recursive: true, force: true });
}
