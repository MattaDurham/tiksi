// Existing and proposed, in a real browser: a synthetic room with an imported model whose red
// chair sits on "Furniture and fixtures_e" and blue chair on "Furniture and fixtures_p" (as a
// SketchUp file written by Tiksi tags them). Both land on Furniture and fixtures, one existing
// and one proposed; the E switch on that tag hides only the red chair, ALL PROPOSED hides the
// blue one, a saved view gives the switches back, the selected chair's half can be changed by
// hand, and the halves survive a reload.
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
// Red and blue pixels in MODEL's canvas, read inside an animation frame after a fresh render.
const colours = page => page.evaluate(() => new Promise(resolve => {
  document.querySelector('[data-env=exposure]').dispatchEvent(new Event('input', { bubbles: true }));
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const src = document.querySelector('.v-canvas'), c = document.createElement('canvas');
    c.width = src.width; c.height = src.height;
    const x = c.getContext('2d'); x.drawImage(src, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data;
    let red = 0, blue = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] > 90 && d[i] > 2 * d[i + 1] && d[i] > 2 * d[i + 2]) red++;
      if (d[i + 2] > 90 && d[i + 2] > 2 * d[i] && d[i + 2] > 2 * d[i + 1]) blue++;
    }
    resolve({ red, blue });
  }));
}));
const FURN = 'tag-furniture';
const chip = (page, tag, ph) => page.locator(`#side [data-tag="${tag}"] [data-chip]`).nth(ph === 'e' ? 0 : 1);

try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(url + '/#/budget');
  await page.locator('#btn-file').waitFor({ state: 'attached' });
  await page.evaluate(async () => {
    const s = await import('/js/store.js');
    const THREE = await import('three');
    const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
    localStorage.removeItem('tiksi.onScreen.v1');
    s.ws.data = s.emptyWorkspace();
    const p = s.propertyTemplate('Phase house'); p.id = 'prop-phases';
    const L = p.levels[0].id;
    const wall = (id, ax, ay, bx, by) => ({ id, level: L, ax, ay, bx, by, thickness: 0.1, height: 1.0, material: null });
    p.walls.push(wall('w-s', 0, 0, 4, 0), wall('w-e', 4, 0, 4, 3), wall('w-n', 4, 3, 0, 3), wall('w-w', 0, 3, 0, 0));
    p.rooms.push({ id: 'r-1', level: L, name: 'Shed', pts: [[0, 0], [4, 0], [4, 3], [0, 3]], material: null, ceilingMaterial: null });
    const scene = new THREE.Scene();
    const box = (name, x, color, tag) => { const m = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.9, 0.8), new THREE.MeshBasicMaterial({ color })); m.name = name; m.position.set(x, 0.45, 1.5); m.userData = { tiksiTag: tag }; scene.add(m); };
    box('Old chair', 1.2, 0xdd1111, 'Furniture and fixtures_e');
    box('New chair', 2.8, 0x1133dd, 'Furniture and fixtures_p');
    const glb = await new GLTFExporter().parseAsync(scene, { binary: true });
    await s.putFile('scan-chairs', glb, { format: 'glb' });
    p.scans.push({ id: 'scan-chairs', name: 'Chairs.glb', format: 'glb', kind: 'mesh', pos: [0, 0, 0], rot: [0, 0, 0], rotY: 0, scale: 1, visible: true });
    s.ws.data.properties.push(p); s.ws.data.settings.activePropertyId = p.id;
    s.touch();
  });
  await page.locator('#rail a[data-view="model"]').click({ noWaitAfter: true });
  await page.locator('canvas.v-canvas').waitFor();
  await waitUntil(async () => (await prop(page, 'return Object.keys(p.tagOf).filter(k => k.startsWith("node:")).length')) === 2, 'the model is tagged');
  const tagOf = await prop(page, 'return p.tagOf'), phaseOf = await prop(page, 'return p.phaseOf');
  const nodes = Object.keys(tagOf).filter(k => k.startsWith('node:')).sort();
  assert.deepEqual(nodes.map(k => tagOf[k]), [FURN, FURN], 'both chairs land on Furniture and fixtures, no "_e" or "_p" tag is made');
  assert.deepEqual(nodes.map(k => phaseOf[k]), ['e', 'p'], 'the old chair is existing, the new one proposed');
  assert.equal(await prop(page, 'return p.tags.filter(t => /_(e|p)$/.test(t.name)).length'), 0);
  await page.locator('#side [data-act=top]').click();
  await delay(900);
  let c = await colours(page);
  assert.ok(c.red > 200 && c.blue > 200, 'both chairs show: ' + JSON.stringify(c));

  // The E switch on Furniture and fixtures hides the existing chair only.
  assert.equal(await chip(page, FURN, 'e').getAttribute('aria-checked'), 'true');
  await chip(page, FURN, 'e').click();
  await waitUntil(async () => (await chip(page, FURN, 'e').getAttribute('aria-checked')) === 'false', 'the E switch turns off');
  c = await colours(page);
  assert.ok(c.red < 20 && c.blue > 200, 'existing furniture hidden, proposed shows: ' + JSON.stringify(c));
  assert.deepEqual(await prop(page, 'return p.tags.find(t => t.id === "tag-furniture").phases'), { e: false, p: true });
  // Saved with that; a second view then shows everything with every proposed half hidden
  // (an open view keeps what it shows, so the changes are made on the second one).
  await page.locator('[data-view-add]').click();
  await page.locator('.v-view-tab').waitFor();
  await page.locator('[data-view-add]').click();
  await page.locator('.v-view-tab').nth(1).waitFor();
  await chip(page, FURN, 'e').click();
  await page.locator('#side [data-phase="p"]').click();
  await delay(300);
  c = await colours(page);
  assert.ok(c.red > 200 && c.blue < 20, 'ALL PROPOSED hides the new chair: ' + JSON.stringify(c));
  assert.deepEqual(await prop(page, 'return p.phaseShown'), { e: true, p: false });
  // The saved view gives the switches back.
  await page.locator('.v-view-tab').first().click();
  await delay(900);
  c = await colours(page);
  assert.ok(c.red < 20 && c.blue > 200, 'the view brings back existing hidden, proposed shown: ' + JSON.stringify(c));
  assert.equal(await prop(page, 'return p.phaseShown === undefined'), true, 'every proposed half shows again');

  // The tag manager has the same switches, and changing a chair's half moves it between them.
  await chip(page, FURN, 'e').click();
  await prop(page, 'return import("/js/tags.js").then(T => { T.setPhase(p, [' + JSON.stringify(nodes[1]) + '], "e"); })');
  await page.locator('#side [data-tag="' + FURN + '"] [data-chip]').first().click();   // existing off again
  await delay(400);
  c = await colours(page);
  assert.ok(c.red < 20 && c.blue < 20, 'the blue chair, made existing by hand, hides with the existing half: ' + JSON.stringify(c));
  // The tag manager (TAGS tab of the component list) carries the same switches.
  await page.locator('.v-objects [data-ol-tab="tags"]').click();
  assert.equal(await page.locator(`.v-tags [data-tag-phase="${FURN}"][data-ph="e"]`).getAttribute('aria-pressed'), 'false');
  assert.equal(await page.locator(`.v-tags [data-tag-phase="${FURN}"][data-ph="p"]`).getAttribute('aria-pressed'), 'true');

  // A reload keeps every half.
  await waitUntil(async () => (await page.locator('#save-status').innerText()).includes('SAVED'), 'saved');
  await delay(700);
  await page.reload();
  await page.locator('canvas.v-canvas').waitFor();
  await waitUntil(async () => (await prop(page, 'return p.phaseOf && Object.keys(p.phaseOf).length')) === 2, 'the halves come back after a reload');
  assert.deepEqual(await prop(page, 'return Object.values(p.phaseOf).sort()'), ['e', 'e']);
  assert.deepEqual(await prop(page, 'return p.tags.find(t => t.id === "tag-furniture").phases'), { e: false, p: true });
  assert.deepEqual(errors, [], 'no page errors');
  console.log('ok: existing and proposed halves hide and show apart, through a saved view and a reload');
} finally {
  await browser.close();
  server.close();
}
