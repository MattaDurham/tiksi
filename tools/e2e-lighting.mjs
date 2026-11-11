// MODEL's lighting: a SketchUp-style model (no normals in its geometry, every face two-sided)
// must not go dark each time the camera stops, and the LIGHT panel's presets and sliders must
// change the picture and be saved with the property. Synthetic room; isolated browser storage
// and an ephemeral HTTP port.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { chromium } from 'playwright';
const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'tools/fixtures/lighting');
await mkdir(output, { recursive: true });
const server = createServer(async (req, res) => {
  const path = resolve(root, '.' + (new URL(req.url, 'http://localhost').pathname === '/' ? '/index.html' : decodeURIComponent(req.url.split('?')[0])));
  if (!path.startsWith(root + '/')) { res.writeHead(403).end(); return; }
  try { res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css' })[extname(path)] || 'application/octet-stream'); res.end(await readFile(path)); }
  catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, 'localhost', r));
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  await page.addInitScript(() => localStorage.setItem('tiksi.onScreen.v1', '{"all":true}'));   // MODEL's tools on the screen (tiksi-menu.js)
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://localhost:${server.address().port}/`);
  await page.locator('[data-prop-name]').waitFor();
  await page.evaluate(async () => {
    const store = await import('/js/store.js');
    const THREE = await import('three');
    const { GLTFExporter } = await import('/vendor/addons/exporters/GLTFExporter.js');
    const { importScanBytes } = await import('/js/scans.js');
    const add = THREE.Object3D.prototype.add;
    THREE.Object3D.prototype.add = function(...objects) {
      if (this.isScene && objects.some(o => o.name === 'property')) window.testScene = this;
      return add.apply(this, objects);
    };
    store.ws.data = store.emptyWorkspace();
    const p = store.propertyTemplate('Synthetic SketchUp room');
    // Saved before room lights had a mode: NIGHT LIGHTS was switched off.
    p.env.quality = 'high'; p.env.time = 14.5;
    delete p.env.lamps; p.env.nightLights = false;
    store.ws.data.properties.push(p); store.ws.data.settings.activePropertyId = p.id;
    // A 6 x 5 m room with a window, a sofa, a table and a cabinet run, as a SketchUp export
    // arrives: no normals in the geometry and every material two-sided.
    const g = new THREE.Group();
    const box = (w, h, d, x, y, z, color, name) => {
      const geo = new THREE.BoxGeometry(w, h, d).toNonIndexed();
      geo.deleteAttribute('normal'); geo.deleteAttribute('uv');
      const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, roughness: 0.9, side: THREE.DoubleSide }));
      m.position.set(x, y, z); m.name = name; g.add(m);
    };
    box(6.2, 0.1, 5.2, 3, -0.05, 2.5, '#9a7b55', 'Floor');
    box(6.2, 0.1, 5.2, 3, 2.65, 2.5, '#f2f0ea', 'Ceiling');
    box(0.1, 2.6, 5, 0, 1.3, 2.5, '#ece8df', 'Wall W'); box(0.1, 2.6, 5, 6, 1.3, 2.5, '#ece8df', 'Wall E');
    box(6, 2.6, 0.1, 3, 1.3, 5, '#ece8df', 'Wall N');
    box(2.4, 2.6, 0.1, 1.2, 1.3, 0, '#ece8df', 'Wall S1'); box(2.4, 2.6, 0.1, 4.8, 1.3, 0, '#ece8df', 'Wall S2');
    box(1.2, 0.9, 0.1, 3, 0.45, 0, '#ece8df', 'Sill'); box(1.2, 0.5, 0.1, 3, 2.35, 0, '#ece8df', 'Head');
    box(2.2, 0.8, 0.9, 1.5, 0.4, 4.4, '#6d6a64', 'Sofa'); box(1.2, 0.45, 0.7, 1.5, 0.22, 3.2, '#5a4632', 'Table');
    box(0.6, 2.2, 3, 5.65, 1.1, 3, '#d9d4c8', 'Cabinets');
    await importScanBytes(await new GLTFExporter().parseAsync(g, { binary: true }), 'synthetic-sketchup-room.glb', p);
  });
  await page.locator('#rail a[data-view=model]').click();
  await page.waitForFunction(() => window.testScene?.getObjectByName('Sofa'));
  // Settled: a full frame drawn, shaders warmed, nothing left to draw (polled from here: an
  // async check inside waitForFunction would not wait).
  const settle = async () => {
    for (let i = 0; i < 240; i++) {
      if (await page.evaluate(async () => (await import('/js/viewer3d.js')).viewerIdle())) return;
      await new Promise(r => setTimeout(r, 500));
    }
    throw new Error('MODEL did not settle: ' + JSON.stringify(await page.evaluate(async () => (await import('/js/viewer3d.js')).viewerIdleState())));
  };
  await settle();
  const view = { position: [0.6, 1.5, 0.6], target: [5, 1.1, 4.5] };
  const brightness = (fast = false) => page.evaluate(async ([fast, view]) => (await import('/js/viewer3d.js')).frameBrightness({ fast, view }), [fast, view]);
  const env = () => page.evaluate(async () => (await import('/js/store.js')).activeProperty().env);

  // The old switch carried over: NIGHT LIGHTS off is room lights off.
  const opened = await env();
  assert.equal(opened.lamps, 'off'); assert.equal('nightLights' in opened, false);
  assert.equal(opened.fill, 1); assert.equal(opened.sunShadows, true);

  // Inside the room the still frame keeps the brightness of the frames drawn while moving.
  // Before the fix the corner shading read this model as facing nowhere and halved it.
  const still = await brightness(false), moving = await brightness(true);
  assert.ok(still > 0.2, `the room is drawn (${still})`);
  assert.ok(still / moving > 0.95, `the view stays as bright when the camera stops: ${still.toFixed(3)} at rest, ${moving.toFixed(3)} moving`);
  await page.screenshot({ path: resolve(output, 'natural.png') });

  // The LIGHT panel: presets and sliders change the picture and are saved with the property.
  await page.locator('[data-environment]').click();
  const panel = page.locator('.v-wrap > .v-env');
  // Room lights carried over as off: that is not NATURAL (after dark), so no preset is lit.
  assert.equal(await panel.locator('.v-light-presets [aria-pressed=true]').count(), 0);
  assert.match(await panel.innerText(), /this property has none/);   // no traced rooms to hang room lights in
  await panel.locator('[data-light-preset=bright]').click();
  const bright = await brightness(false);
  assert.ok(bright > still * 1.15, `BRIGHT WORK LIGHT lights the room: ${still.toFixed(3)} -> ${bright.toFixed(3)}`);
  const saved = await env();
  assert.equal(saved.sunShadows, false); assert.equal(saved.lamps, 'on'); assert.ok(saved.fill > 2 && saved.cameraLight > 0);
  assert.equal(await page.evaluate(() => window.testScene.children.find(o => o.isDirectionalLight).castShadow), false);
  assert.equal(await panel.locator('[data-light-preset=bright]').getAttribute('aria-pressed'), 'true');
  await page.screenshot({ path: resolve(output, 'bright.png') });

  const slide = async (key, value) => {
    await panel.locator(`[data-env=${key}]`).evaluate((input, value) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); }, String(value));
  };
  await slide('fill', 3);
  assert.equal((await env()).fill, 3);
  assert.equal(await panel.locator('[data-light-preset=bright]').getAttribute('aria-pressed'), 'false', 'a value changed by hand is no longer the preset');
  assert.equal(await panel.locator('[data-env=fill] + em').innerText(), '300%');
  const fuller = await brightness(false);
  assert.ok(fuller > bright, `more FILL LIGHT is brighter: ${bright.toFixed(3)} -> ${fuller.toFixed(3)}`);
  await slide('exposure', 0.5);
  const dimmer = await brightness(false);
  assert.ok(dimmer < fuller - 0.05, `lower BRIGHTNESS is darker: ${fuller.toFixed(3)} -> ${dimmer.toFixed(3)}`);

  // Natural puts every lighting value back, and the picture with it.
  await panel.locator('[data-light-preset=natural]').click();
  assert.equal(await panel.locator('[data-light-preset=natural]').getAttribute('aria-pressed'), 'true');
  assert.equal((await env()).lamps, 'auto');
  const back = await brightness(false);
  assert.ok(Math.abs(back - still) < 0.01, `NATURAL restores the picture: ${still.toFixed(3)} vs ${back.toFixed(3)}`);
  assert.equal(await page.evaluate(() => window.testScene.children.find(o => o.isDirectionalLight).castShadow), true);
  // Corner shading at 0 switches the pass off: the still frame matches the moving one.
  await slide('shading', 0);
  const flat = await brightness(false);
  assert.ok(Math.abs(flat - await brightness(true)) < 0.002, 'no corner shading: still and moving frames match');
  assert.deepEqual(errors, []);
  console.log('ok   SketchUp-style model keeps its brightness at rest, old night-lights switch carried over, presets, sliders, saved values, natural restore, corner shading off');
} finally { await browser.close(); server.close(); }
