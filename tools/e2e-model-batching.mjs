// Grouped drawing of an imported model in MODEL, in a real browser, on a synthetic SketchUp-like
// model: 100 boxes over five looks (every box its own mesh and material copy, some mirrored),
// four SketchUp tags that cut across the looks, and 24 bottles that share one mesh. Checks:
// grouping cuts the frame's draw calls without changing a pixel; hiding a tag hides exactly its
// parts; a click picks the part under the cursor and outlines it; x-ray and the section cut
// look the same grouped or not; a moving camera gets fast frames, then one full frame, and
// never refreshes the shadow map.
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

async function waitUntil(predicate, message, timeoutMs = 60_000) {
  const deadline = performance.now() + timeoutMs;
  while (!(await predicate())) {
    assert.ok(performance.now() < deadline, 'Timed out: ' + message);
    await delay(150);
  }
}
const prop = (page, body) => page.evaluate(new Function('return import("/js/store.js").then(s => { const p = s.activeProperty(); ' + body + ' })'));
// Draw one full frame grouped or not and return its counts and pixels (read before the frame is
// presented, as the PNG export does).
const shot = (page, grouped) => page.evaluate(async grouped => {
  const v = await import('/js/viewer3d.js');
  const stats = v.drawStats({ grouped });
  const src = document.querySelector('.v-canvas'), c = document.createElement('canvas');
  c.width = src.width; c.height = src.height;
  c.getContext('2d').drawImage(src, 0, 0);
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  return { ...stats, pixels: Array.from(d), width: c.width, height: c.height };
}, grouped);
function difference(a, b) {
  assert.equal(a.pixels.length, b.pixels.length);
  let sum = 0, off = 0;
  for (let i = 0; i < a.pixels.length; i += 4) {
    const d = Math.abs(a.pixels[i] - b.pixels[i]) + Math.abs(a.pixels[i + 1] - b.pixels[i + 1]) + Math.abs(a.pixels[i + 2] - b.pixels[i + 2]);
    sum += d; if (d > 48) off++;
  }
  const n = a.pixels.length / 4;
  return { mean: sum / n / 3, share: off / n };
}
const same = (a, b, what) => {
  const d = difference(a, b);
  assert.ok(d.mean < 1.5 && d.share < 0.004, what + ': grouped and ungrouped frames match (mean difference ' + d.mean.toFixed(2) + ', ' + (d.share * 100).toFixed(2) + '% of pixels differ)');
};

try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(url + '/#/plan');
  await page.locator('#btn-file').waitFor({ state: 'attached' });
  await page.evaluate(async () => {
    const s = await import('/js/store.js');
    const { writeGlb, boxGeometry, bottleGeometry } = await import('/tools/synthetic-model.mjs');
    localStorage.removeItem('tiksi.onScreen.v1');
    s.ws.data = s.emptyWorkspace();
    const p = s.propertyTemplate('Grouping house'); p.id = 'prop-groups';
    const looks = [[0.75, 0.2, 0.15], [0.2, 0.45, 0.75], [0.85, 0.8, 0.3], [0.25, 0.65, 0.3], [0.6, 0.3, 0.7]].map((c, i) => ({ name: 'Look ' + i, color: [...c, 1], roughness: 0.8 }));
    looks.push({ name: 'Bottle glass', color: [0.1, 0.25, 0.12, 1], roughness: 0.3 });
    const meshes = [], nodes = [];
    for (let r = 0; r < 10; r++) for (let c = 0; c < 10; c++) {
      const i = r * 10 + c, h = 0.2 + (i % 3) * 0.1;
      meshes.push({ geometry: boxGeometry(0.4, h, 0.4), look: i % 5 });
      nodes.push({ name: 'Box ' + r + ' ' + c, mesh: i, translation: [-2.25 + c * 0.5, h / 2, -2.25 + r * 0.5], ...(c === 9 ? { scale: [-1, 1, 1] } : {}), tag: 'Tag ' + ((r + c) % 4) });
    }
    meshes.push({ geometry: bottleGeometry(16), look: 5, sharedMaterial: true, name: 'Bottle' });
    for (let i = 0; i < 24; i++) nodes.push({ name: 'Bottle ' + i, mesh: 100, translation: [-2.3 + i * 0.2, 0.04, 2.9], tag: 'Bottles' });
    const { glb } = writeGlb({ looks, meshes, nodes });
    await s.putFile('scan-grid', glb.buffer, { format: 'glb' });
    p.scans.push({ id: 'scan-grid', name: 'Grid model.glb', format: 'glb', kind: 'mesh', pos: [0, 0, 0], rot: [0, 0, 0], rotY: 0, scale: 1, visible: true });
    s.ws.data.properties.push(p); s.ws.data.settings.activePropertyId = p.id;
    s.touch();
  });
  await page.locator('#rail a[data-view="model"]').click({ noWaitAfter: true });
  await page.locator('canvas.v-canvas').waitFor();
  await waitUntil(async () => (await prop(page, 'return Object.keys(p.tagOf || {}).filter(k => k.startsWith("node:scan-grid")).length')) === 124, 'the model is loaded and tagged');
  await page.evaluate(async () => (await import('/js/viewer3d.js')).fieldAction('mode', 'top'));
  await delay(1500);   // the camera flies to the top view

  // Grouping: far fewer draw calls for the same triangles and the same picture.
  const plain = await shot(page, false), grouped = await shot(page, true);
  assert.deepEqual({ ...grouped.groups }, { models: 1, parts: 124, proxies: 7, batched: 100, instanced: 24, solo: 0 }, 'five looks, the mirrored column of the fifth look apart, and one instanced bottle');
  assert.equal(plain.groups.models, 0, 'grouping switched off draws every mesh');
  assert.ok(grouped.calls * 4 < plain.calls, 'draw calls per frame drop from ' + plain.calls + ' to ' + grouped.calls);
  assert.ok(Math.abs(grouped.triangles - plain.triangles) <= plain.triangles * 0.01, 'the same triangles are drawn (' + plain.triangles + ' vs ' + grouped.triangles + ')');
  same(plain, grouped, 'top view');

  // Tags: hiding one hides exactly its parts, and the picture still matches.
  const tag1 = await prop(page, 'return p.tags.find(t => t.name === "Tag 1").id');
  await page.locator('.v-objects [data-ol-tab="tags"]').click();   // the tag list is the second tab of the component list
  await page.locator(`.v-tags [data-tag-eye="${tag1}"]`).click();
  await delay(300);
  const drawn = await page.evaluate(async tag => {
    const v = await import('/js/viewer3d.js'), s = await import('/js/store.js');
    v.drawStats();
    const p = s.activeProperty();
    return Object.keys(p.tagOf).filter(k => k.startsWith('node:scan-grid')).map(k => ({ k, onTag: p.tagOf[k] === tag, drawn: v.partDrawn(k) }));
  }, tag1);
  const onTag1 = Array.from({ length: 100 }, (_, i) => (Math.floor(i / 10) + i % 10) % 4 === 1).filter(Boolean).length;
  assert.equal(drawn.filter(d => d.onTag).length, onTag1, 'the boxes the file put on Tag 1 are on it');
  for (const d of drawn) assert.equal(d.drawn, !d.onTag, d.k + (d.onTag ? ' is hidden with its tag' : ' stays drawn'));
  same(await shot(page, false), await shot(page, true), 'Tag 1 hidden');
  await page.locator(`.v-tags [data-tag-eye="${tag1}"]`).click();
  await delay(300);

  // Picking: a click on a box selects that box (its name and tag in the inspector) and outlines it.
  await page.locator('.v-objects [data-ol-close]').click();   // the list floats over the left of the model: off the screen for these clicks
  const boxes = [[0, 0], [2, 7], [5, 5], [9, 9], [7, 1], [4, 9]];
  const tagIds = await prop(page, 'return Object.fromEntries(p.tags.map(t => [t.name, t.id]))');
  const rect = await page.locator('canvas.v-canvas').boundingBox();
  for (const [r, c] of boxes) {
    const at = await page.evaluate(async ([r, c]) => {
      const THREE = await import('three');
      const v = await import('/js/viewer3d.js');
      const cam = v.drawStats({ grouped: true }).camera;
      const i = r * 10 + c, h = 0.2 + (i % 3) * 0.1;
      const q = new THREE.Vector4(-2.25 + c * 0.5, h, -2.25 + r * 0.5, 1).applyMatrix4(new THREE.Matrix4().fromArray(cam.inverse)).applyMatrix4(new THREE.Matrix4().fromArray(cam.projection));
      return [q.x / q.w, q.y / q.w];
    }, [r, c]);
    await page.mouse.click(rect.x + (at[0] + 1) / 2 * rect.width, rect.y + (1 - at[1]) / 2 * rect.height);
    await waitUntil(async () => (await page.locator('.inspector .op-name').count()) && (await page.locator('.inspector .op-name').innerText()) === 'Box ' + r + ' ' + c, 'the click picks box ' + r + ' ' + c);
    assert.equal(await page.locator('[data-tag-pick]').inputValue(), tagIds['Tag ' + ((r + c) % 4)], 'and shows its tag');
  }
  // The outline is what changes when the part is selected.
  const outlinedPlain = await shot(page, false), outlinedGrouped = await shot(page, true);
  await page.keyboard.press('Escape');
  await page.evaluate(async () => { const v = await import('/js/viewer3d.js'); return !!v; });
  await page.mouse.click(rect.x + 4, rect.y + rect.height - 4);   // a click on empty ground clears the selection
  await delay(200);
  const clearPlain = await shot(page, false), clearGrouped = await shot(page, true);
  const outline = (a, b) => difference(a, b).share * a.width * a.height;
  const plainOutline = outline(outlinedPlain, clearPlain), groupedOutline = outline(outlinedGrouped, clearGrouped);
  assert.ok(groupedOutline > 40, 'the selected part is outlined (' + Math.round(groupedOutline) + ' outline pixels)');
  assert.ok(groupedOutline > plainOutline * 0.6 && groupedOutline < plainOutline * 1.6, 'as strongly as without grouping (' + Math.round(plainOutline) + ' pixels)');
  same(outlinedPlain, outlinedGrouped, 'with a part selected');

  // X-ray and the section cut look the same grouped or not.
  await page.evaluate(async () => (await import('/js/viewer3d.js')).fieldAction('show', 'xray'));
  same(await shot(page, false), await shot(page, true), 'x-ray');
  await page.evaluate(async () => (await import('/js/viewer3d.js')).fieldAction('show', 'xray'));
  await page.evaluate(async () => { const v = await import('/js/viewer3d.js'); v.fieldAction('show', 'section'); v.fieldAction('section-height', null, 0.25); });
  same(await shot(page, false), await shot(page, true), 'section cut at 0.25 m');
  await page.evaluate(async () => (await import('/js/viewer3d.js')).fieldAction('show', 'section'));

  // A moving camera: fast frames while dragging, no shadow refresh, then one full frame.
  await page.evaluate(async () => (await import('/js/viewer3d.js')).fieldAction('mode', 'orbit'));
  await delay(1200);
  await page.evaluate(async () => (await import('/js/viewer3d.js')).drawStats());
  const state = () => page.evaluate(async () => (await import('/js/viewer3d.js')).frameState());
  const rest = await state();
  assert.equal(rest.fast, false, 'at rest: a full-quality frame');
  assert.equal(rest.shadowRefreshPending, false, 'and the shadow map is up to date');
  await page.mouse.move(rect.x + rect.width * 0.3, rect.y + rect.height * 0.5);
  await page.mouse.down();
  for (let i = 0; i < 30; i++) { await page.mouse.move(rect.x + rect.width * 0.3 + i * 8, rect.y + rect.height * 0.5); await delay(20); }
  await page.mouse.up();
  await waitUntil(async () => { const s = await state(); return !s.fast && s.fullFrames > rest.fullFrames; }, 'a full-quality frame follows once the camera stops', 20_000);
  const moved = await state();
  assert.ok(moved.fastFrames > rest.fastFrames, 'frames drawn while orbiting are fast frames (' + (moved.fastFrames - rest.fastFrames) + ')');
  assert.equal(moved.shadowRefreshes, rest.shadowRefreshes, 'orbiting never redraws the shadow map');
  await page.evaluate(async () => (await import('/js/viewer3d.js')).fieldAction('show', 'xray'));
  await waitUntil(async () => (await state()).shadowRefreshes > moved.shadowRefreshes, 'x-ray (what casts shadows) redraws the shadow map', 20_000);

  // The components converter's shape: one material per look, rack instances over shared board
  // meshes, bottle instances nested in each rack over one bottle mesh (tools/synthetic-model.mjs).
  await page.evaluate(async () => {
    const s = await import('/js/store.js');
    const { componentCellar } = await import('/tools/synthetic-model.mjs');
    const p = s.propertyTemplate('Component cellar'); p.id = 'prop-components';
    const { glb } = componentCellar({ boards: 30, racks: 10, bottlesPerRack: 10 });
    await s.putFile('scan-components', glb.buffer, { format: 'glb' });
    p.scans.push({ id: 'scan-components', name: 'Component cellar.glb', format: 'glb', kind: 'mesh', pos: [0, 0, 0], rot: [0, 0, 0], rotY: 0, scale: 1, visible: true });
    s.ws.data.properties.push(p); s.ws.data.settings.activePropertyId = p.id;
    s.touch();
  });
  await page.locator('#rail a[data-view="plan"]').click({ noWaitAfter: true });
  await page.locator('#rail a[data-view="model"]').click({ noWaitAfter: true });
  await page.locator('canvas.v-canvas').waitFor();
  const partsOf = 'return Object.keys(p.tagOf || {}).filter(k => k.startsWith("node:scan-components"))';
  await waitUntil(async () => (await prop(page, partsOf + '.length')) === 4 + 10 * (30 + 10), 'the component model is loaded and tagged');
  await delay(1500);
  const cPlain = await shot(page, false), cGrouped = await shot(page, true);
  assert.equal(cGrouped.groups.parts, 404, 'every mesh node of every instance is a part');
  assert.ok(cGrouped.groups.instanced >= 100, 'the 100 nested bottles are instanced');
  assert.ok(cGrouped.groups.proxies < 45, cGrouped.groups.proxies + ' draws for 404 parts');
  assert.ok(cGrouped.calls * 4 < cPlain.calls, 'draw calls per frame drop from ' + cPlain.calls + ' to ' + cGrouped.calls);
  same(cPlain, cGrouped, 'component model');
  const bottles = await prop(page, 'return p.tags.find(t => t.name === "Bottles").id');
  await page.locator('#side [data-act=tag-list]').click();
  await page.locator(`.v-tags [data-tag-eye="${bottles}"]`).click();
  await delay(300);
  const cDrawn = await page.evaluate(async tag => {
    const v = await import('/js/viewer3d.js'), s = await import('/js/store.js');
    v.drawStats();
    const p = s.activeProperty();
    return Object.keys(p.tagOf).filter(k => k.startsWith('node:scan-components')).map(k => ({ k, onTag: p.tagOf[k] === tag, drawn: v.partDrawn(k) }));
  }, bottles);
  assert.equal(cDrawn.filter(d => d.onTag).length, 100, 'the nested bottles carry their instance tag');
  for (const d of cDrawn) assert.equal(d.drawn, !d.onTag, d.k + (d.onTag ? ' is hidden with Bottles' : ' stays drawn'));
  same(await shot(page, false), await shot(page, true), 'component model with Bottles hidden');

  assert.deepEqual(errors, []);
  console.log('model grouping: ' + plain.calls + ' draw calls down to ' + grouped.calls + ' with identical pixels; tags, picking, outline, x-ray, section and fast frames hold; the component-shaped model ' + cPlain.calls + ' down to ' + cGrouped.calls);
} finally {
  await browser.close();
  server.close();
}
