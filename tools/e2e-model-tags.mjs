// Tags, saved views and the Tiksi menu, in a real browser on a synthetic property with an
// imported model that has a red roof slab over a room. The roof is detected as Roof; hiding
// Roof takes the red off MODEL and off a DOCUMENTS 3D view (and a view's own override brings
// it back there); a part moved to another tag stays there after a reload; a renamed tag and a
// saved view survive the project file. The screen starts clear: the tools are in the menu.
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
const ROOF = 'tag-roof';
const prop = (page, body) => page.evaluate(new Function('return import("/js/store.js").then(s => { const p = s.activeProperty(); ' + body + ' })'));
// Red pixels (the roof slab) in MODEL's canvas, read inside an animation frame after a fresh render.
const redInModel = page => page.evaluate(() => new Promise(resolve => {
  // The viewer draws on demand: re-applying the current exposure asks for fresh frames.
  document.querySelector('[data-env=exposure]').dispatchEvent(new Event('input', { bubbles: true }));
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const src = document.querySelector('.v-canvas'), c = document.createElement('canvas');
    c.width = src.width; c.height = src.height;
    const x = c.getContext('2d'); x.drawImage(src, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data;
    let red = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 90 && d[i] > 2 * d[i + 1] && d[i] > 2 * d[i + 2]) red++;
    resolve(red);
  }));
}));
const redInView = (page, id) => page.evaluate(async id => {
  const href = document.querySelector(`.dc-paper svg g[data-vp-group="${id}"] image`)?.getAttribute('href');
  if (!href) return -1;
  const im = new Image(); im.src = href; await im.decode();
  const c = document.createElement('canvas'); c.width = im.width; c.height = im.height;
  const x = c.getContext('2d'); x.drawImage(im, 0, 0);
  const d = x.getImageData(0, 0, c.width, c.height).data;
  let red = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] > 90 && d[i] > 2 * d[i + 1] && d[i] > 2 * d[i + 2]) red++;
  return red;
}, id);

try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(url + '/#/plan');
  await page.locator('#btn-file').waitFor();
  // A 4 x 3 m room, and a model of the same room: a red roof slab above the storey, a blue
  // chair in the middle and a grey floor. The model's parts have no telling names.
  await page.evaluate(async () => {
    const s = await import('/js/store.js');
    const THREE = await import('three');
    const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
    localStorage.removeItem('tiksi.onScreen.v1');
    s.ws.data = s.emptyWorkspace();
    const p = s.propertyTemplate('Tag house'); p.id = 'prop-tags';
    const L = p.levels[0].id;
    const wall = (id, ax, ay, bx, by) => ({ id, level: L, ax, ay, bx, by, thickness: 0.1, height: null, material: null });
    p.walls.push(wall('w-s', 0, 0, 4, 0), wall('w-e', 4, 0, 4, 3), wall('w-n', 4, 3, 0, 3), wall('w-w', 0, 3, 0, 0));
    p.rooms.push({ id: 'r-1', level: L, name: 'Shed', pts: [[0, 0], [4, 0], [4, 3], [0, 3]], material: null, ceilingMaterial: null });
    const scene = new THREE.Scene();
    const box = (name, w, h, d, y, color) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshBasicMaterial({ color })); m.name = name; m.position.set(2, y, 1.5); scene.add(m); };
    box('Mesh 0', 4.6, 0.15, 3.6, 2.7, 0xdd1111);
    box('Mesh 1', 0.8, 0.9, 0.8, 0.45, 0x1133dd);
    box('Mesh 2', 3.9, 0.03, 2.9, 0.015, 0x888888);
    const glb = await new GLTFExporter().parseAsync(scene, { binary: true });
    await s.putFile('scan-shed', glb, { format: 'glb' });
    p.scans.push({ id: 'scan-shed', name: 'Shed model.glb', format: 'glb', kind: 'mesh', pos: [0, 0, 0], rot: [0, 0, 0], rotY: 0, scale: 1, visible: true });
    s.ws.data.properties.push(p); s.ws.data.settings.activePropertyId = p.id;
    s.touch();
  });
  await page.locator('#rail a[data-view="model"]').click({ noWaitAfter: true });
  await page.locator('canvas.v-canvas').waitFor();
  await waitUntil(async () => (await prop(page, 'return Object.keys(p.tagOf).filter(k => k.startsWith("node:")).length')) === 3, 'the model is tagged');
  const tagOf = await prop(page, 'return p.tagOf');
  const nodes = Object.keys(tagOf).filter(k => k.startsWith('node:')).sort();
  assert.deepEqual(nodes.map(k => tagOf[k]), ['tag-roof', 'tag-furniture', 'tag-floor'], 'the slab above the storey is Roof, the box Furniture, the slab at the floor Floor');
  const chairKey = nodes[1];

  // The screen starts clear: no tool column, no view bar; the tabs and the tag list are there.
  assert.equal(await page.locator('.tool-col').isVisible(), false, 'the tools are off the screen');
  assert.equal(await page.locator('.v-modes').isVisible(), false);
  assert.ok(await page.locator('.v-views [data-view-add]').isVisible());
  // The tag list is the second tab of the component list over the left of the model.
  await page.locator('.v-objects [data-ol-tab="tags"]').click();
  assert.ok(await page.locator('.v-objects .v-tags [data-tag-eye="tag-roof"]').isVisible(), 'the tag list is in the TAGS tab of the component list');
  // The Tiksi menu runs the tools, and can put a group back on the screen.
  await page.locator('#tiksi-menu').click();
  const heads = await page.locator('.tk-group header > span').allInnerTexts();
  for (const h of ['SAVED VIEWS', 'VIEW', 'DISPLAY', 'TOOLS', 'TAGS', 'LEVELS', 'GO TO']) assert.ok(heads.includes(h), 'the menu has ' + h);
  await page.locator('.tk-group', { hasText: 'TOOLS' }).locator('[data-screen]').check();
  await page.keyboard.press('Escape');
  assert.ok(await page.locator('.tool-col [data-act=measure]').isVisible(), 'TOOLS ON SCREEN brings the tool buttons back');
  await page.locator('#tiksi-menu').click();
  await page.locator('.tk-group', { hasText: 'TOOLS' }).locator('[data-screen]').uncheck();
  await page.locator('.tk-item', { hasText: 'Top, north up' }).click();
  assert.equal(await page.locator('.tool-col').isVisible(), false, 'and off again');
  await delay(1200);   // the camera flies to the top view

  // Hiding Roof takes the red slab off the model.
  const before = await redInModel(page);
  assert.ok(before > 2000, 'the roof covers the room from above (' + before + ' red pixels)');
  await page.locator('.v-tags [data-tag-eye="tag-roof"]').click();
  await delay(400);
  const hidden = await redInModel(page);
  assert.ok(hidden < before / 50, 'with Roof hidden the red is gone (' + hidden + ' red pixels)');
  assert.equal(await prop(page, 'return p.tags.find(t => t.id === "tag-roof").visible'), false);

  // Under the roof: click the chair and move it to Cabinets and built-ins.
  const c = await page.locator('canvas.v-canvas').boundingBox();
  await page.mouse.click(c.x + c.width / 2, c.y + c.height / 2);
  await page.locator('[data-tag-pick]').waitFor();
  assert.equal(await page.locator('.inspector .op-name').innerText(), 'Mesh 1', 'the click picks the chair alone, and the panel is about it');
  assert.equal(await page.locator('[data-tag-pick]').inputValue(), 'tag-furniture', 'the clicked part shows its tag');
  await page.locator('[data-tag-pick]').selectOption('tag-builtins');
  const moved = await prop(page, `return p.tagOf[${JSON.stringify(chairKey)}]`);
  assert.equal(moved, 'tag-builtins', 'the chair moved to the chosen tag');

  // A saved view keeps Roof hidden; showing Roof and going back to the tab hides it again.
  await page.keyboard.press('Escape');
  await page.locator('[data-view-add]').click();
  await page.locator('.v-view-tab').waitFor();
  await page.locator('.v-tags [data-tag-eye="tag-roof"]').click();
  assert.equal(await prop(page, 'return p.tags.find(t => t.id === "tag-roof").visible'), true);
  await page.locator('.v-view-tab').first().click();
  assert.equal(await prop(page, 'return p.tags.find(t => t.id === "tag-roof").visible'), false, 'the saved view brings back its tags');

  // A saved view is renamed in its tab: a double-click opens the name, Enter keeps it; the
  // pencil beside the current tab opens RENAME too, and Esc leaves the name as it was.
  await page.locator('.v-view-tab').first().dblclick();
  await page.locator('.v-views [data-view-name]').waitFor();
  await page.locator('.v-views [data-view-name]').fill('Kitchen corner');
  await page.locator('.v-views [data-view-name]').press('Enter');
  await page.locator('.v-view-tab', { hasText: 'Kitchen corner' }).waitFor();
  assert.equal(await prop(page, 'return p.savedViews[0].name'), 'Kitchen corner', 'a double-click renames the view');
  assert.ok(await page.locator('.v-views [data-view-edit]').isVisible(), 'the current view shows its pencil');
  await page.locator('.v-views [data-view-edit]').click();
  await page.locator('.v-ctx [data-ctx="view-rename"]').click();
  await page.locator('.v-views [data-view-name]').fill('Not kept');
  await page.locator('.v-views [data-view-name]').press('Escape');
  await page.locator('.v-view-tab', { hasText: 'Kitchen corner' }).waitFor();
  assert.equal(await prop(page, 'return p.savedViews[0].name'), 'Kitchen corner', 'Esc leaves the name as it was');
  await page.locator('.v-views [data-view-edit]').click();
  await page.locator('.v-ctx [data-ctx="view-rename"]').click();
  await page.locator('.v-views [data-view-name]').fill('Kitchen from the door');
  await page.locator('.v-views [data-view-name]').press('Enter');
  assert.equal(await prop(page, 'return p.savedViews[0].name'), 'Kitchen from the door', 'the pencil renames the view');

  // DOCUMENTS: a 3D view from above follows the model (no red), and its own override shows the roof.
  const vpId = await page.evaluate(async () => {
    const s = await import('/js/store.js'), ds = await import('/js/doc-sets.js');
    const p = s.activeProperty();
    const set = ds.newSet('Tag check');
    const v = ds.newViewport('view3d', { x: 1, y: 1, w: 6, h: 5 }, { camera: { position: [2, 14, 1.51], target: [2, 0, 1.5], fov: 40 }, style: 'shaded' });
    set.sheets[0].viewports.push(v);
    p.docSets.push(set); s.touch();
    return v.id;
  });
  await page.locator('#rail a[data-view="documents"]').click({ noWaitAfter: true });
  await page.waitForFunction(id => !!document.querySelector(`.dc-paper svg g[data-vp-group="${id}"] image`), vpId, { timeout: 90000 });
  const docHidden = await redInView(page, vpId);
  assert.ok(docHidden >= 0 && docHidden < 50, 'the DOCUMENTS view leaves out the hidden roof (' + docHidden + ' red pixels)');
  await page.evaluate(async id => { const s = await import('/js/store.js'); const v = s.activeProperty().docSets[0].sheets[0].viewports.find(x => x.id === id); v.tags = { 'tag-roof': true }; s.touch(); }, vpId);
  await page.locator('[data-refresh]').click();
  await waitUntil(async () => (await redInView(page, vpId)) > 2000, 'the view that shows Roof draws the red slab', 90_000);

  // A reload keeps the part where it was moved, and the hidden tag.
  await page.locator('#rail a[data-view="model"]').click({ noWaitAfter: true });
  await page.locator('canvas.v-canvas').waitFor();
  await waitUntil(async () => (await page.locator('#save-status').innerText()).includes('SAVED'), 'saved');
  await delay(700);
  await page.reload();
  await page.locator('canvas.v-canvas').waitFor();
  assert.equal(await prop(page, `return p.tagOf[${JSON.stringify(chairKey)}]`), moved, 'the chair is still on its new tag after a reload');
  assert.equal(await prop(page, 'return p.tags.find(t => t.id === "tag-roof").visible'), false);
  assert.equal(await prop(page, 'return p.savedViews.length'), 1);
  assert.equal(await prop(page, 'return p.savedViews[0].name'), 'Kitchen from the door', 'the new name comes back from the project file');

  // Rename Roof in the tag list; the name, the hidden state, the chair's tag and the saved view
  // all come back from the project file.
  await page.locator('[data-tag-name="tag-roof"]').fill('Roof and gutters');
  await page.locator('[data-tag-name="tag-roof"]').press('Enter');
  await page.locator('[data-tag-name="tag-roof"]').blur();
  await waitUntil(async () => (await prop(page, 'return p.tags.find(t => t.id === "tag-roof").name')) === 'Roof and gutters', 'renamed');
  const back = await page.evaluate(async () => {
    const s = await import('/js/store.js');
    const p = s.activeProperty();
    const packed = await s.exportProjectBlob(p.id);
    s.replaceWorkspace(s.emptyWorkspace());
    await s.importProject(new File([packed.blob], packed.name)); await s.whenHydrated();
    const q = s.ws.data.properties[0];
    return { name: q.tags.find(t => t.id === 'tag-roof').name, visible: q.tags.find(t => t.id === 'tag-roof').visible, tagOf: q.tagOf, views: q.savedViews.map(v => v.tags['tag-roof']) };
  });
  assert.equal(back.name, 'Roof and gutters', 'the renamed tag survives the project file');
  assert.equal(back.visible, false);
  assert.equal(back.tagOf[chairKey], moved);
  assert.deepEqual(back.views, [false], 'the saved view and its tags survive the project file');
  assert.deepEqual(errors, []);
  console.log('model tags: roof detected and hidden in MODEL and DOCUMENTS, part moved and kept, saved view (renamed in its tab) and renamed tag survive the project file');
} finally {
  await browser.close();
  server.close();
}
