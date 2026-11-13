// UNDO and REDO for the edits MODEL still makes (a wall's finishes, chosen in its panel), shared
// by MODEL and MEASURE: one change is one undo, saves to disk keep the history, each project
// keeps its own, the keyboard shortcuts work, an independent change from another device keeps
// the redo, and reopening the project clears it. A phone's Undo and Redo (on MEASURE) are
// touch-sized, fit the header and undo the phone's own change; the header fits at every width.
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
  await page.addInitScript(() => localStorage.setItem('tiksi.onScreen.v1', '{"all":true}'));   // MODEL's tools on the screen (tiksi-menu.js)
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://127.0.0.1:' + port + '/#/budget');
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
  await page.locator('.inspector [data-mat]').waitFor();
  assert.equal(await page.locator('.inspector h3').first().innerText(), 'WALL', 'a click selects the wall');
  const wallField = (pg, k) => pg.evaluate(k => window.undoStore.activeProperty().walls[0][k] ?? null, k);
  // Two wall materials other than the one the wall has: one for the computer, one for the phone.
  const [chosen, inner] = await page.locator('.inspector [data-mat] option').evaluateAll(os => os.map(o => o.value).filter(v => v && v !== 'mat-drywall').slice(0, 2));
  assert.ok(chosen && inner, 'the wall panel offers other materials');
  await page.locator('.inspector [data-mat]').selectOption(chosen);
  await page.waitForFunction(m => window.undoStore.activeProperty().walls[0].material === m, chosen);
  await page.waitForFunction(() => document.querySelector('#save-status').textContent === 'SAVED TO DISK');
  assert.equal(await page.locator('#btn-undo').isEnabled(), true, 'self-save keeps history');
  await page.locator('#btn-undo').click();
  assert.equal(await wallField(page, 'material'), 'mat-drywall');
  assert.equal(await page.locator('#btn-undo').isDisabled(), true, 'one change is one undo');
  await page.locator('#rail [data-view=measure]').click();
  await page.locator('.ms-layout').waitFor();   // MEASURE loads on first use; its REDO works once it is open
  await page.locator('#btn-redo').click();
  assert.equal(await wallField(page, 'material'), chosen, 'MEASURE redoes the MODEL change');
  await page.selectOption('#property-select', 'other-house'); assert.equal(await page.locator('#btn-undo').isDisabled(), true);
  await page.selectOption('#property-select', 'undo-house'); assert.equal(await page.locator('#btn-undo').isEnabled(), true);
  await page.locator('.ms-layout').waitFor();   // MEASURE opens again for the project
  await page.keyboard.press('ControlOrMeta+z');
  assert.equal(await wallField(page, 'material'), 'mat-drywall');
  await page.keyboard.press('ControlOrMeta+Shift+z');
  assert.equal(await wallField(page, 'material'), chosen);
  await page.locator('#btn-undo').click();
  await page.waitForFunction(() => document.querySelector('#save-status').textContent === 'SAVED TO DISK');

  // A phone: its own change to the same wall's interior face, undone and redone by touch. A phone
  // shows UNDO and REDO on MEASURE (its MODEL is for looking and capturing, with no panel to
  // change a finish in), so the change is recorded there as the wall panel records it.
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const phone = await context.newPage(); phone.on('pageerror', e => errors.push(e.message));
  await phone.addInitScript(() => localStorage.setItem('tiksi.onScreen.v1', '{"all":true}'));   // MODEL's tools on the screen (tiksi-menu.js)
  await phone.goto('http://localhost:' + port + '/#/measure');
  await phone.waitForFunction(() => document.querySelector('#save-status').textContent === 'SAVED TO DISK');
  await phone.locator('.ms-layout').waitFor();
  await phone.evaluate(async () => { window.undoStore = await import('/js/store.js'); });
  const mobileUndo = await phone.locator('#btn-undo').boundingBox(), mobileRedo = await phone.locator('#btn-redo').boundingBox();
  for (const rect of [mobileUndo, mobileRedo]) { assert(rect && rect.height >= 44 && rect.y >= 0 && rect.y + rect.height < 200); assert(rect.x >= 0 && rect.x + rect.width <= 390); }
  await phone.evaluate(async m => {
    const { beginGeometryEdit } = await import('/js/edit-history.js'), s = window.undoStore, p = s.activeProperty();
    beginGeometryEdit(p, 'change interior finish'); p.walls[0].materialIn = m; s.touch();
  }, inner);
  await phone.waitForFunction(() => document.querySelector('#save-status').textContent === 'SAVED TO DISK');
  await phone.locator('#btn-undo').tap();
  assert.equal(await wallField(phone, 'materialIn'), null);
  await phone.locator('#btn-redo').tap();
  assert.equal(await wallField(phone, 'materialIn'), inner);
  await phone.waitForFunction(() => document.querySelector('#save-status').textContent === 'SAVED TO DISK');
  await page.waitForFunction(m => window.undoStore.activeProperty().walls[0].materialIn === m, inner);
  assert.equal(await page.locator('#btn-redo').isEnabled(), true, 'an independent change from another device keeps the redo');
  await page.locator('#btn-redo').click();
  assert.equal(await wallField(page, 'materialIn'), inner, 'the redo keeps the other device\'s change');
  assert.equal(await wallField(page, 'material'), chosen);
  await page.evaluate(async () => { const s = window.undoStore; s.mergeWorkspace(JSON.parse(JSON.stringify(s.ws.data))); });
  assert.equal(await page.locator('#btn-undo').isDisabled(), true, 'opening/reimporting a project clears its previous session history');
  // On the desktop UNDO and REDO are in the Tiksi menu, beside FILE, not on the top bar.
  assert.equal(await page.locator('#btn-undo').isVisible(), false, 'no UNDO button on the top bar');
  await page.locator('#rail [data-view=plan]').click();
  await page.locator('[data-tool=wall]').first().waitFor();
  await page.click('#tiksi-menu');
  assert.equal(await page.locator('.tk-menu #btn-undo').isVisible(), true, 'UNDO is in the Tiksi menu');
  assert.equal(await page.locator('.tk-menu #btn-file').isVisible(), true, 'beside FILE');
  await page.keyboard.press('Escape');
  for (const width of [320, 800, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.locator('#topbar').evaluate(el => el.scrollWidth <= el.clientWidth), true, 'the top bar fits at ' + width);
  }
  assert.deepEqual(errors, []);
  console.log('ok   MODEL finish change, MODEL/MEASURE shared undo, disk saves, independent shared edits, project isolation, mobile Undo/Redo and shortcuts');
} finally {
  if (browser) await browser.close(); child.kill();
  await new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve));
  await rm(state, { recursive: true, force: true });
}
