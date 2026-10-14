// Isolated synthetic/demo browser checks. All images stay under ignored tools/fixtures.
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'tools/fixtures/fidelity');
const realResearch = await readFile(resolve(root, 'js/research.js')).then(() => true, () => false);
await mkdir(output, { recursive: true });
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm' };
const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const file = resolve(root, '.' + (pathname === '/' ? '/index.html' : decodeURIComponent(pathname)));
  if (!file.startsWith(root + '/')) { res.writeHead(403).end(); return; }
  try { res.setHeader('content-type', mime[extname(file)] || 'application/octet-stream'); res.end(await readFile(file)); }
  catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, 'localhost', resolve));
const base = 'http://localhost:' + server.address().port;
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = [];
const captures = {};
async function bounded(promise, label, timeout = 90000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' timed out after ' + timeout + 'ms')), timeout); })]); }
  finally { clearTimeout(timer); }
}
async function captureFrame(page, name) {
  // Read the actual viewer canvas during an animation frame, after the viewer has
  // drawn and before Chromium clears its non-preserved WebGL drawing buffer. This
  // uses the same synchronous canvas snapshot as PNG export, without waiting for
  // the browser screenshot compositor (which stalls with Linux SwiftShader).
  const capture = await bounded(page.evaluate(() => new Promise((resolve, reject) => {
    // The viewer renders on demand. Applying the current exposure through its
    // ordinary control requests fresh frames without changing the scene settings.
    document.querySelector('[data-env=exposure]').dispatchEvent(new Event('input', { bubbles: true }));
    requestAnimationFrame(() => requestAnimationFrame(() => {
      try {
        const source = document.querySelector('.v-canvas');
        const canvas = document.createElement('canvas');
        canvas.width = source.width; canvas.height = source.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(source, 0, 0);
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let samples = 0, opaque = 0, min = 255, max = 0;
        const colors = new Set();
        for (let i = 0; i < pixels.length; i += 4 * 37) {
          samples++;
          if (pixels[i + 3] === 255) opaque++;
          min = Math.min(min, pixels[i], pixels[i + 1], pixels[i + 2]);
          max = Math.max(max, pixels[i], pixels[i + 1], pixels[i + 2]);
          colors.add((pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2]);
        }
        resolve({ data: canvas.toDataURL('image/png').split(',')[1], width: canvas.width,
          height: canvas.height, samples, opaque, min, max, colors: colors.size });
      } catch (error) { reject(error); }
    }));
  })), 'Capturing ' + name);
  assert.ok(capture.opaque > capture.samples * 0.95, name + ' has a completed opaque frame');
  assert.ok(capture.max - capture.min > 50 && capture.colors > 32, name + ' contains rendered surface detail');
  const { data, ...metrics } = capture;
  const png = Buffer.from(data, 'base64');
  assert.equal(png.readUInt32BE(16), capture.width);
  assert.equal(png.readUInt32BE(20), capture.height);
  await writeFile(resolve(output, name), png);
  captures[name] = { ...metrics, bytes: png.length };
  console.log('Captured rendered canvas:', name, capture.width + 'x' + capture.height);
}
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  // Integrated builds import research eagerly. Use the real route when present and register
  // the standalone branch's seam before navigation so module caching cannot defeat it.
  if (!realResearch) await page.route('**/js/research.js', route => route.fulfill({ contentType: 'text/javascript', body: `
    export function mount() {}
    export function unmount() {}
    export function openResearch(context) {
      sessionStorage.setItem('tiksi.research.session.v1', JSON.stringify({context}));
      location.hash = '#/research';
    }` }));
  await page.route('**/api/material-research/capabilities', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ available: false, reason: 'Synthetic browser check.' }) }));
  await page.route('**/api/model-conversion/capabilities',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({token:'synthetic',blender:false,sketchup:false,cad:false})}));
  await page.goto(base + '/#/model');
  await page.waitForSelector('.v-canvas');
  await page.evaluate(async () => { window.testTextures = await import('/js/textures.js'); });
  await page.waitForFunction(() => window.testTextures.pendingTextureJobs() === 0, null, { timeout: 90000 });
  await captureFrame(page, 'high.png');
  const initial = await page.locator('.v-canvas').evaluate(c => ({ width: c.width, height: c.height }));
  await page.click('#btn-file');await page.click('[data-file-tab=settings]');await page.getByText('Model environment',{exact:true}).click();
  await page.selectOption('[data-file-env] [data-env=quality]', 'ultra');
  await page.click('[data-close-file]');
  await page.waitForFunction(() => window.testTextures.pendingTextureJobs() === 0, null, { timeout: 120000 });
  const ultra = await page.locator('.v-canvas').evaluate(c => ({ width: c.width, height: c.height }));
  assert.ok(ultra.width > initial.width, 'Ultra increases drawing-buffer resolution at DPR 1');
  const stats = await page.evaluate(async () => (await import('/js/textures.js')).textureStats());
  assert.ok(stats.some(s => s.res === 2048 && s.status === 'ready'), 'Ultra produces 2K surface maps');
  await captureFrame(page, 'ultra.png');
  await page.click('#btn-file');await page.click('[data-file-tab=exchange]');await page.click('[data-save-view]');
  await page.selectOption('[data-export-size]', '3840');
  const displayed = await page.locator('[data-export-dimensions]').innerText();
  // A 4K still can occupy SwiftShader's main thread longer than Playwright's
  // default 30s action timeout. Keep both parts within the export's 120s budget
  // and attach rejection handlers immediately, so cleanup cannot mask a click
  // failure with an unhandled download-wait rejection.
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 120000 }),
    page.click('[data-export-save]', { timeout: 120000, noWaitAfter: true }),
  ]);
  const pngPath = resolve(output, 'export-4k.png');
  await download.saveAs(pngPath);
  const png = await readFile(pngPath);
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  assert.ok(displayed.includes(String(width)) && displayed.includes(String(height)));
  assert.equal(Math.max(width, height), 3840);
  assert.ok(png.length > 50000, 'Export contains rendered detail');
  await page.waitForFunction(() => document.querySelector('[data-export-status]')?.textContent === 'PNG saved.');
  await page.click('.v-export-actions button[value=cancel]');
  const restored = await page.locator('.v-canvas').evaluate(c => ({ width: c.width, height: c.height }));
  assert.deepEqual(restored, ultra, 'Export restores interactive render size');
  await page.click('[data-section]');
  await page.click('[data-xray]');
  await page.click('#btn-file');await page.click('[data-file-tab=settings]');await page.getByText('Model environment',{exact:true}).click();
  await page.selectOption('[data-file-env] [data-env=quality]', 'low');await page.click('[data-close-file]');
  await page.click('[data-mode=top]');
  await captureFrame(page, 'section-xray-low.png');
  // Pick a real floor through the viewer's raycaster; the join must carry the clicked element.
  for (const [x, y] of [[250, 350], [350, 400], [400, 450], [300, 500]]) {
    await page.locator('.v-canvas').click({ position: { x, y } });
    if (await page.locator('[data-research-role=ceiling]').count()) break;
  }
  await page.waitForSelector('[data-research-role=ceiling]');
  await page.click('[data-research-role=material]');
  await page.waitForFunction(() => !!JSON.parse(sessionStorage.getItem('tiksi.research.session.v1') || 'null')?.context?.materialId);
  const research = await page.evaluate(() => JSON.parse(sessionStorage.getItem('tiksi.research.session.v1')).context);
  assert.equal(await page.evaluate(() => location.hash), '#/research');
  if (realResearch) await page.waitForSelector('.research-context');
  assert.equal(research.kind, 'material');
  assert.equal(research.elementKind, 'room');
  assert.ok(research.materialId && research.elementId && research.propertyId);
  assert.ok(!('walls' in research) && !('rooms' in research) && !('photos' in research));
  // Exercise exact color encoding and actual ShaderMaterial compilation in a separate context.
  const colors = await page.evaluate(async () => {
    const THREE = await import('three');
    const { fromGeometry, makePointCloud, decimate } = await import('/js/pointcloud.js');
    const test = (attribute) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
      geo.setAttribute('color', attribute);
      return [...fromGeometry(geo).colors];
    };
    const source = { count: 6, positions: new Float32Array(Array.from({length: 18}, (_, i) => Math.floor(i / 3))), colors: new Uint8Array(Array.from({length: 18}, (_, i) => Math.floor(i / 3))) };
    const reduced = decimate(source, 5);
    const decimated = { count: reduced.count, positions: [...reduced.positions], colors: [...reduced.colors] };
    const float = test(new THREE.Float32BufferAttribute([0.2158605, 0.2158605, 0.2158605], 3));
    const byte = test(new THREE.BufferAttribute(new Uint8Array([55, 55, 55]), 3, true));
    const r = new THREE.WebGLRenderer({ preserveDrawingBuffer: true });
    r.setSize(64, 64); r.outputColorSpace = THREE.SRGBColorSpace;
    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10); camera.position.z = 2;
    const cloud = makePointCloud({ count: 1, positions: new Float32Array([0, 0, 0]), colors: new Uint8Array([128, 128, 128]) }, { pointSize: 1 });
    scene.add(cloud); r.render(scene, camera);
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
    const ctx = canvas.getContext('2d'); ctx.drawImage(r.domElement, 0, 0);
    const pixel = [...ctx.getImageData(32, 32, 1, 1).data];
    cloud.geometry.dispose(); cloud.material.dispose(); r.dispose();
    return { float, byte, pixel, decimated };
  });
  assert.equal(colors.decimated.count, 5);
  assert.deepEqual(colors.decimated.positions, colors.decimated.colors);
  assert.equal(colors.decimated.positions.at(-1), 5);
  assert.deepEqual(colors.float, [128, 128, 128]);
  assert.deepEqual(colors.byte, [128, 128, 128]);
  assert.ok(Math.abs(colors.pixel[0] - 128) <= 2, 'Point shader preserves sRGB gray in orthographic view');
  assert.deepEqual(errors, [], 'No browser or shader errors');
  await writeFile(resolve(output, 'evidence.json'), JSON.stringify({ initial, ultra, captures, export: { width, height, bytes: png.length }, colors, research, stats, errors }, null, 2));
  console.log('Render browser checks passed: quality, 4K PNG, restore, section, x-ray, orthographic point colors.');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
