// Synthetic imported roof and traced room; isolated browser storage and ephemeral HTTP port.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { chromium } from 'playwright';
const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'tools/fixtures/sun-xray');
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
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
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
    const p = store.propertyTemplate('Synthetic sun study'), L = p.levels[0].id;
    p.env.quality = 'medium'; p.env.date = '2024-06-21'; p.env.timeZone = 'America/New_York';
    p.walls = [[0,0,8,0],[8,0,8,6],[8,6,0,6],[0,6,0,0]].map(([ax,ay,bx,by], i) => ({id:'wall-'+i,level:L,ax,ay,bx,by,thickness:0.15,material:'mat-drywall'}));
    p.rooms.push({id:'room',level:L,name:'Room',pts:[[0,0],[8,0],[8,6],[0,6]],material:'mat-oak'});
    store.ws.data.properties.push(p); store.ws.data.settings.activePropertyId = p.id;
    const source = new THREE.Group();
    const roof = new THREE.Mesh(new THREE.BoxGeometry(8.4, 0.25, 6.4), new THREE.MeshStandardMaterial({ color: '#46545d', roughness: 1 }));
    roof.name = 'Synthetic roof'; roof.position.set(4, 2.8, 3); source.add(roof);
    const bytes = await new GLTFExporter().parseAsync(source, { binary: true });
    await importScanBytes(bytes, 'synthetic-roof.glb', p);
  });
  await page.locator('#rail a[data-view=model]').click();
  await page.waitForFunction(() => window.testScene?.getObjectByName('Synthetic_roof'));
  const inspect = () => page.evaluate(() => {
    const scene = window.testScene, roof = scene.getObjectByName('Synthetic_roof');
    const sun = scene.children.find(o => o.isDirectionalLight);
    return { opacity: roof.material.opacity, transparent: roof.material.transparent, depthWrite: roof.material.depthWrite, castShadow: roof.castShadow,
      fogMax: Math.max(scene.fog.color.r, scene.fog.color.g, scene.fog.color.b), fogNear: scene.fog.near, sun: sun.position.clone().sub(sun.target.position).normalize().toArray(), radius: sun.userData.radius };
  });
  const initial = await inspect();
  assert.equal(initial.opacity, 1); assert.equal(initial.castShadow, true);
  assert.ok(initial.fogMax < 0.6 && initial.fogNear >= 150, 'neutral distant haze does not wash out the model');
  await page.locator('[data-environment]').click();
  const panel = page.locator('.v-wrap > .v-env');
  await panel.locator('[data-env=sunMode]').selectOption('location');
  assert.match(await panel.locator('[data-sun-status]').innerText(), /latitude and longitude/);
  for (const [key, value] of [['latitude', '40'], ['longitude', '-75']]) {
    await panel.locator(`[data-env=${key}]`).fill(value);
    await panel.locator(`[data-env=${key}]`).press('Tab');
  }
  const slide = async (selector, value) => {
    await page.locator(selector).evaluate((input, value) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); }, String(value));
  };
  await slide('.v-wrap [data-env=time]', 8);
  assert.equal(await panel.locator('[data-time-readout]').innerText(), '08:00');
  const morning = await inspect();
  assert.ok(morning.sun[0] > 0.2, 'morning sun lies east of the model');
  await slide('.v-wrap [data-env=time]', 16);
  const afternoon = await inspect();
  assert.ok(afternoon.sun[0] < -0.2, 'afternoon sun lies west of the model');
  await slide('.v-wrap [data-env=time]', 12);
  const summer = await inspect();
  await slide('.v-wrap [data-env=dayOfYear]', 356);
  assert.equal(await panel.locator('[data-env=date]').inputValue(), '2024-12-21');
  const winter = await inspect(); assert.ok(summer.sun[1] > winter.sun[1] + 0.3, 'season changes shadow length');
  await slide('.v-wrap [data-env=north]', 90);
  const rotated = await inspect(); assert.ok(Math.abs(rotated.sun[2] - winter.sun[0]) < 0.001, 'north rotates the sun consistently');
  await slide('.v-wrap [data-env=north]', 0);
  await slide('.v-wrap [data-env=dayOfYear]', 173);
  await page.screenshot({ path: resolve(output, 'sun-controls.png') });
  await page.locator('[data-environment]').click();
  await page.locator('[data-xray]').click();
  assert.ok(Math.abs((await inspect()).opacity - 0.35) < 1e-8, 'imported roof joins X-ray');
  await slide('.v-xray-range', 90);
  let xr = await inspect(); assert.ok(Math.abs(xr.opacity - 0.1) < 1e-8); assert.equal(xr.depthWrite, false); assert.equal(xr.castShadow, false);
  await page.screenshot({ path: resolve(output, 'roof-xray.png') });
  await slide('.v-xray-range', 100); assert.equal((await inspect()).opacity, 0);
  await slide('.v-xray-range', 0); assert.equal((await inspect()).opacity, 1);
  await slide('.v-xray-range', 80);
  await page.locator('[data-section]').click();
  await page.locator('[data-xray]').click();
  assert.equal((await inspect()).transparent, false); assert.equal((await inspect()).castShadow, true);
  assert.ok(await page.evaluate(() => window.testScene.getObjectByName('Synthetic_roof').material.clippingPlanes?.length === 1), 'restored material retains the current section cut');
  await page.locator('[data-section]').click();
  await page.locator('#rail a[data-view=plan]').click();
  await page.locator('#rail a[data-view=model]').click();
  await page.waitForFunction(() => window.testScene?.getObjectByName('Synthetic_roof'));
  const saved = await page.evaluate(async () => (await import('/js/store.js')).activeProperty().env);
  assert.ok(Math.abs(saved.xrayOpacity - 0.2) < 1e-8); assert.equal(saved.sunMode, 'location'); assert.equal(saved.latitude, 40);
  await page.locator('.v-scan-row').click();
  await page.locator('[data-scale]').fill('10');
  await page.locator('[data-scale]').press('Tab');
  assert.ok((await inspect()).radius > 50, 'shadow coverage follows imported model scaling');
  await page.locator('[data-scale]').fill('1');
  await page.locator('[data-scale]').press('Tab');
  await page.setViewportSize({ width: 1024, height: 800 });
  await page.locator('[data-xray]').click();
  const wrap = await page.locator('.v-wrap').boundingBox(), control = await page.locator('.v-xray-control').boundingBox();
  assert.ok(control.x >= wrap.x && control.x + control.width <= wrap.x + wrap.width, 'slider fits a narrow canvas');
  assert.deepEqual(errors, []);
  console.log('ok   solar location/date/time/north controls, seasonal shadows, neutral haze, imported roof X-ray, slider endpoints, restore, persistence, narrow layout');
} finally { await browser.close(); server.close(); }
