// MODEL's component list and the panel for one object, in a real browser on a synthetic
// property: a kitchen model written the way the SketchUp converter writes one (three cabinets
// of one component, each with a handle inside; two chairs; an island that is one group drawn
// in two materials). One click picks one whole object; the panel on the right shows that
// object only; its tag changes alone; hiding it hides it alone and SHOW ALL HIDDEN brings it
// back; an object an earlier Tiksi moved shows a MOVED note with PUT IT BACK and no way to move
// it here; all of it survives a reload.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { readFile } from 'node:fs/promises';
import { dirname, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = createServer(async (req, res) => {
  const path = resolve(root, '.' + decodeURIComponent(req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0]));
  if (!path.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  try { const bytes = await readFile(path); res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.wasm': 'application/wasm' })[extname(path)] || 'application/octet-stream'); res.end(bytes); }
  catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(Number(process.env.E2E_APP_PORT) || 0, 'localhost', r));
const url = `http://localhost:${server.address().port}`;
const browser = await chromium.launch({ headless: true });

async function waitUntil(predicate, message, timeoutMs = 30_000) {
  const deadline = performance.now() + timeoutMs;
  while (!(await predicate())) {
    assert.ok(performance.now() < deadline, 'Timed out: ' + message);
    await delay(150);
  }
}
const prop = (page, body) => page.evaluate(new Function('return import("/js/store.js").then(s => { const p = s.activeProperty(); ' + body + ' })'));
const viewer = (page, body, arg) => page.evaluate(new Function('arg', 'return import("/js/viewer3d.js").then(v => { ' + body + ' })'), arg);
const idle = page => waitUntil(() => viewer(page, 'return v.viewerIdle()'), 'MODEL has settled', 120_000);
const shot = process.env.E2E_SHOTS;

try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(url + '/#/materials');
  await page.locator('#btn-file').waitFor();
  await page.evaluate(async () => {
    const s = await import('/js/store.js');
    const THREE = await import('three');
    const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
    localStorage.removeItem('tiksi.onScreen.v1');
    s.ws.data = s.emptyWorkspace();
    const p = s.propertyTemplate('Component house'); p.id = 'prop-comp';
    const L = p.levels[0].id;
    const wall = (id, ax, ay, bx, by) => ({ id, level: L, ax, ay, bx, by, thickness: 0.1, height: null, material: null });
    p.walls.push(wall('w-s', 0, 0, 6, 0), wall('w-e', 6, 0, 6, 4), wall('w-n', 6, 4, 0, 4), wall('w-w', 0, 4, 0, 0));
    p.rooms.push({ id: 'r-1', level: L, name: 'Kitchen', pts: [[0, 0], [6, 0], [6, 4], [0, 4]], material: null, ceilingMaterial: null });
    const scene = new THREE.Scene();
    const box = (name, w, h, d, at, color) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color })); m.name = name; m.position.set(...at); return m; };
    const inst = (comp, at, label) => { const g = new THREE.Group(); g.name = label || comp; g.userData = { sketchupComponent: comp, sketchupDefinitionId: 'guid-' + comp, sketchupTag: 'Furniture and fixtures' }; if (label) g.userData.sketchupInstanceName = label; g.position.set(...at); return g; };
    const cabinet = (at, label) => {
      const c = inst('Base cabinet', at, label);
      c.add(box('Base cabinet', 0.9, 0.85, 0.6, [0, 0.425, 0], 0x8a6a4a), box('Base cabinet', 0.94, 0.04, 0.64, [0, 0.87, 0], 0x333333));
      const h = inst('Pull handle', [0, 0.6, 0.31]); h.add(box('Pull handle', 0.2, 0.03, 0.03, [0, 0, 0], 0xcccccc)); c.add(h);
      return c;
    };
    scene.add(cabinet([1, 0, 0.5], 'Sink base'), cabinet([2, 0, 0.5]), cabinet([3, 0, 0.5]));
    const chair = n => { const c = inst('Dining chair', [2 + n * 0.8, 0, 2.6]); c.add(box('Dining chair', 0.45, 0.05, 0.45, [0, 0.45, 0], 0x2255aa), box('Dining chair', 0.45, 0.5, 0.05, [0, 0.72, -0.2], 0x2255aa)); return c; };
    scene.add(chair(0), chair(1));
    scene.add(box('Island', 1.6, 0.9, 0.8, [4.2, 0.45, 2.4], 0x777766), box('Island', 1.7, 0.04, 0.9, [4.2, 0.92, 2.4], 0xdddddd));
    const glb = await new GLTFExporter().parseAsync(scene, { binary: true });
    await s.putFile('scan-kit', glb, { format: 'glb' });
    p.scans.push({ id: 'scan-kit', name: 'Kitchen furnishings.glb', format: 'glb', kind: 'mesh', pos: [0, 0, 0], rot: [0, 0, 0], rotY: 0, scale: 1, visible: true });
    s.ws.data.properties.push(p); s.ws.data.settings.activePropertyId = p.id;
    s.touch();
  });
  await page.locator('#rail a[data-view="model"]').click({ noWaitAfter: true });
  await page.locator('canvas.v-canvas').waitFor();
  // 3 cabinets x (2 faces + 1 handle) + 2 chairs x 2 + the island's 2 = 15 meshes.
  await waitUntil(async () => (await prop(page, 'return Object.keys(p.tagOf).filter(k => k.startsWith("node:")).length')) === 15, 'the model is tagged');
  await idle(page);
  const FURN = 'tag-furniture';
  const keysOf = name => page.evaluate(async name => {
    const s = await import('/js/store.js'), v = await import('/js/viewer3d.js'), O = await import('/js/model-objects.js');
    return v.objectKeys('scan-kit', name);
  }, name);

  // The list: the model's six objects, whole, and the plan's groups. No single meshes.
  const list = page.locator('.v-objects');
  await list.waitFor();
  const names = await list.locator('.ol-row .ol-name span').allInnerTexts();
  assert.deepEqual(names, ['Sink base', 'Base cabinet', 'Base cabinet', 'Dining chair', 'Dining chair', 'Island'], 'the list shows whole objects');
  assert.deepEqual((await list.locator('.ol-head .ol-name span').allInnerTexts()).map(t => t.toLowerCase()), ['kitchen furnishings.glb', 'walls', 'floors', 'ceilings']);
  assert.equal(await page.locator('.inspector h3').first().innerText(), 'NOTHING SELECTED');
  assert.equal(await page.locator('.inspector [data-tag-eye]').count(), 0, 'the tag list is no longer in the right-hand panel');

  // Click the sink base in the list: the right-hand panel is about it and nothing else.
  await list.locator('.ol-row', { hasText: 'Sink base' }).locator('[data-ol-pick]').click();
  await page.locator('.inspector .op-name').waitFor();
  assert.equal(await page.locator('.inspector .op-name').innerText(), 'Sink base');
  assert.equal(await page.locator('.inspector h3').first().innerText(), 'COMPONENT');
  const panel = await page.locator('.inspector').innerText();
  assert.ok(/Definition\s*Base cabinet/.test(panel) && /1 of 3/.test(panel), 'it says what it is: ' + panel.slice(0, 200));
  assert.ok(!/MATERIALS|COMPONENTS ·|DELETE SCAN|Rot X/.test(panel), 'and nothing about the rest of the model');
  assert.equal(await page.locator('[data-tag-pick]').inputValue(), FURN, 'its tag');
  const sink = await keysOf('Sink base');
  assert.equal(sink.length, 3, 'the cabinet is its two faces and its handle');

  // Change its tag to a new tag: only its three meshes move; the other cabinets stay.
  page.once('dialog', d => d.accept('Sink run'));
  await page.locator('[data-tag-pick]').selectOption('__new');
  await waitUntil(async () => (await prop(page, 'return p.tags.some(t => t.name === "Sink run")')), 'the new tag exists');
  const sinkTag = await prop(page, 'return p.tags.find(t => t.name === "Sink run").id');
  const tagOf = await prop(page, 'return p.tagOf');
  assert.deepEqual(sink.map(k => tagOf[k]), [sinkTag, sinkTag, sinkTag], 'the whole object is on the new tag');
  assert.equal(Object.entries(tagOf).filter(([k, v]) => k.startsWith('node:') && v === FURN).length, 12, 'everything else stayed on its tag');
  assert.equal(await page.locator('[data-tag-pick]').inputValue(), sinkTag);

  // Hide it: it alone is not drawn; its tag is still shown; the list marks it and offers to show it.
  const drawn = keys => viewer(page, 'return arg.map(k => v.partDrawn(k))', keys);
  const cab2 = (await keysOf('Base cabinet')).slice(0, 3);
  await page.locator('.inspector [data-obj-hide="hide"]').click();
  await idle(page);
  assert.deepEqual(await drawn(sink), [false, false, false], 'the hidden cabinet is not drawn');
  assert.deepEqual(await drawn(cab2), [true, true, true], 'the cabinet beside it still is');
  assert.equal(await prop(page, `return p.tags.find(t => t.id === ${JSON.stringify(sinkTag)}).visible`), true, 'its tag was not switched off');
  assert.ok(await list.locator('.ol-row.off', { hasText: 'Sink base' }).isVisible(), 'the list shows it as hidden');
  assert.ok(await page.locator('.inspector [data-obj-hide="show"]').isVisible(), 'the panel offers SHOW');
  if (shot) await page.screenshot({ path: shot + '/objects-hidden.png' });
  await list.locator('[data-ol-show-all]').click();
  await idle(page);
  assert.deepEqual(await drawn(sink), [true, true, true], 'SHOW ALL HIDDEN brings it back');
  assert.equal(await list.locator('[data-ol-show-all]').count(), 0);

  // The eye in the list hides one object too; H hides the selection and Shift+H shows all.
  const island = await keysOf('Island');
  assert.equal(island.length, 2, 'a group drawn in two materials is one object');
  await list.locator('.ol-row', { hasText: 'Island' }).locator('[data-ol-eye]').click();
  await idle(page);
  assert.deepEqual(await drawn(island), [false, false]);
  await page.locator('canvas.v-canvas').focus().catch(() => {});
  await page.keyboard.press('h');
  await idle(page);
  assert.deepEqual(await drawn(sink), [false, false, false], 'H hides the selected object');

  // Hidden objects stay hidden after a reload.
  await waitUntil(async () => (await page.locator('#save-status').innerText()).includes('SAVED'), 'saved');
  await delay(700);
  await page.reload();
  await page.locator('canvas.v-canvas').waitFor();
  await waitUntil(async () => (await viewer(page, 'return v.scanStates()'))?.['scan-kit']?.state === 'ready', 'the model is back');
  await idle(page);
  assert.deepEqual(await drawn(island.concat(sink)), [false, false, false, false, false], 'still hidden after a reload');
  assert.deepEqual(await drawn(cab2), [true, true, true]);
  await page.keyboard.press('Shift+H');
  await idle(page);
  assert.deepEqual(await drawn(island.concat(sink)), [true, true, true, true, true], 'Shift+H shows everything hidden on its own');

  // A click in the model picks the whole chair, not one of its two meshes.
  await page.locator('.v-objects [data-ol-close]').click();
  assert.equal(await page.locator('.v-objects').isVisible(), false, 'the list can be taken off the screen');
  const chairs = await keysOf('Dining chair');
  const rect = await page.locator('canvas.v-canvas').boundingBox();
  const screenOf = async key => {
    const at = await page.evaluate(async key => {
      const THREE = await import('three'), v = await import('/js/viewer3d.js');
      const cam = v.drawStats({}).camera, c = v.partCentre(key);
      const q = new THREE.Vector4(c[0], c[1], c[2], 1).applyMatrix4(new THREE.Matrix4().fromArray(cam.inverse)).applyMatrix4(new THREE.Matrix4().fromArray(cam.projection));
      return [q.x / q.w, q.y / q.w];
    }, key);
    return [rect.x + (at[0] + 1) / 2 * rect.width, rect.y + (1 - at[1]) / 2 * rect.height];
  };
  await page.locator('#tiksi-menu').click();
  await page.locator('.tk-item', { hasText: 'Top, north up' }).click();
  await delay(1300);
  await idle(page);
  await page.mouse.click(...await screenOf(chairs[0]));
  await page.locator('.inspector .op-name').waitFor();
  assert.equal(await page.locator('.inspector .op-name').innerText(), 'Dining chair');
  assert.ok(/1 of 2/.test(await page.locator('.inspector').innerText()));
  // The Tiksi menu brings the list back, with the chair marked in it.
  await page.locator('#tiksi-menu').click();
  await page.locator('.tk-item', { hasText: 'Component list' }).click();
  await list.waitFor();
  assert.equal(await list.locator('.ol-row.active').count(), 1);

  // An object moved by an earlier version of Tiksi: the panel says how far and offers PUT IT
  // BACK, with no way to move it here (things move in SketchUp). It alone stands moved, and
  // stays moved across a reload until PUT IT BACK.
  const centre = key => viewer(page, 'return v.partCentre(arg)', key);
  const panelNow = await page.locator('.inspector').innerText();
  assert.ok(!/MOVED|PUT IT BACK/.test(panelNow), 'an object that was never moved has no MOVED note: ' + panelNow.slice(0, 200));
  assert.equal(await page.locator('.inspector [data-obj-off]').count(), 0, 'no offset fields');
  assert.equal(await page.locator('.inspector [data-obj-move]').count(), 0, 'no MOVE IT IN THE VIEW');
  const before = await centre(chairs[0]), other = await centre(chairs[2]);
  const chairPath = chairs[0].split('#')[1].split('/').slice(0, -1).join('/');
  await page.evaluate(async path => {
    const s = await import('/js/store.js');
    s.activeProperty().scans[0].partOffsets = { [path]: [0.5, 0, 0] };
    s.touch();
  }, chairPath);
  await waitUntil(async () => (await page.locator('#save-status').innerText()).includes('SAVED'), 'saved');
  await delay(700);
  await page.reload();
  await page.locator('canvas.v-canvas').waitFor();
  await waitUntil(async () => (await viewer(page, 'return v.scanStates()'))?.['scan-kit']?.state === 'ready', 'the model is back');
  await idle(page);
  assert.ok(Math.abs((await centre(chairs[0]))[0] - before[0] - 0.5) < 1e-3, 'the moved chair stands half a metre along X');
  assert.ok(Math.abs((await centre(chairs[1]))[0] - (await centre(chairs[0]))[0]) < 0.3, 'both of its meshes moved together');
  assert.deepEqual(await centre(chairs[2]), other, 'the other chair stayed');
  await list.locator('.ol-row', { hasText: 'Dining chair' }).first().locator('[data-ol-pick]').click();
  await page.locator('.inspector [data-obj-reset]').waitFor();
  const movedPanel = await page.locator('.inspector').innerText();
  assert.ok(/MOVED/.test(movedPanel) && /Move things in SketchUp/.test(movedPanel), 'the panel says it was moved: ' + movedPanel.slice(0, 300));
  assert.equal(await page.locator('.inspector [data-obj-off]').count(), 0, 'and still offers no offset fields');
  if (shot) await page.screenshot({ path: shot + '/objects-moved.png' });
  await page.locator('.inspector [data-obj-reset]').click();
  await waitUntil(async () => Math.abs((await centre(chairs[0]))[0] - before[0]) < 1e-3, 'PUT IT BACK returns it');
  assert.equal(await prop(page, 'return p.scans[0].partOffsets'), undefined);
  assert.equal(await page.locator('.inspector [data-obj-reset]').count(), 0, 'and the MOVED note goes');

  // Going inside: the cabinet's handle from the panel; the way back up from its breadcrumb.
  await list.locator('.ol-row').nth(1).locator('[data-ol-pick]').click();   // the second cabinet
  await page.locator('.inspector .op-child', { hasText: 'Pull handle' }).click();
  await waitUntil(async () => (await page.locator('.inspector .op-name').innerText()) === 'Pull handle', 'the handle is selected');
  assert.ok(await list.locator('.ol-row.active', { hasText: 'Pull handle' }).isVisible(), 'the list opened the cabinet to show it');
  await page.locator('.inspector .op-crumbs [data-obj-go]').click();
  await waitUntil(async () => (await page.locator('.inspector .op-name').innerText()) === 'Base cabinet', 'back to the cabinet');

  // Every cabinet at once: SELECT ALL 3, then one tag for all three.
  await page.locator('.inspector [data-obj-same]').click();
  await waitUntil(async () => (await page.locator('.inspector h3').first().innerText()) === '3 OBJECTS', 'three objects are selected');
  assert.equal(await page.locator('[data-tag-pick]').inputValue(), '__mixed', 'they are on two tags');
  await page.locator('[data-tag-pick]').selectOption('tag-builtins');
  const after = await prop(page, 'return p.tagOf');
  assert.equal(Object.values(after).filter(v => v === 'tag-builtins').length, 9, 'all three cabinets, handles included');
  assert.equal(Object.entries(after).filter(([k, v]) => k.startsWith('node:') && v === FURN).length, 6, 'the chairs and the island stayed');

  // The whole model is one click away, with the panel it always had.
  await list.locator('[data-ol-model="scan-kit"]').click();
  await page.locator('.inspector [data-frame]').waitFor();
  assert.ok(/MATERIALS/.test(await page.locator('.inspector').innerText()), 'the whole model shows its materials and components');

  // The TAGS tab holds the tag list; hiding a tag there still hides everything on it.
  await list.locator('[data-ol-tab="tags"]').click();
  await list.locator('[data-tag-eye="tag-builtins"]').click();
  await idle(page);
  assert.deepEqual(await drawn(sink.concat(cab2)), [false, false, false, false, false, false], 'a hidden tag hides all its objects');
  assert.deepEqual(await drawn(island), [true, true]);
  await list.locator('[data-tag-eye="tag-builtins"]').click();
  await list.locator('[data-ol-tab="list"]').click();

  // A plan object hides the same way: the first wall, from the list.
  await list.locator('[data-ol-fold="plan:wall"]').first().click();
  await list.locator('.ol-row [data-ol-eye="wall:w-s"]').click();
  assert.equal(await prop(page, 'return p.hidden["wall:w-s"]'), true);
  await list.locator('.ol-row [data-ol-pick="wall:w-s"]').click();
  await page.locator('.inspector [data-obj-hide="show"]').click();
  assert.equal(await prop(page, 'return p.hidden["wall:w-s"]'), undefined, 'SHOW in the wall\'s own panel brings it back');
  assert.equal(await page.locator('.inspector h3').first().innerText(), 'WALL');

  assert.deepEqual(errors, [], 'no page errors: ' + errors.join(' | '));
  console.log('model objects: component list, one-object panel, tag, hide, show, moved note and PUT IT BACK OK');
} finally {
  await browser.close();
  server.close();
}
