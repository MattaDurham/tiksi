// Verify rendered scan underlays keep their scale, detail and material color.
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname, sep } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const server = http.createServer(async (req, res) => {
  const path = resolve(root, '.' + new URL(req.url, 'http://localhost').pathname);
  if (!path.startsWith(root + sep) && path !== root) { res.writeHead(404).end(); return; }
  try {
    const file = path === root ? resolve(root, 'index.html') : path;
    const bytes = await readFile(file);
    res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' })[extname(file)] || 'application/octet-stream');
    res.end(bytes);
  } catch { res.writeHead(404).end(); }
});
let browser;
try {
  await new Promise(r => server.listen(0, 'localhost', r));
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`http://localhost:${server.address().port}/`);
  await page.waitForSelector('#view canvas');
  const result = await page.evaluate(async () => {
    const THREE = await import('three');
    const { underlaysFor } = await import('/js/scan2plan.js');
    const geometry = new THREE.PlaneGeometry(10, 6);
    geometry.rotateX(-Math.PI / 2);
    const material = new THREE.MeshStandardMaterial({ color: 0xe03020 });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(5, 0, 3);
    const parent = new THREE.Group(); parent.add(mesh);
    const raw = new THREE.Group(); raw.add(parent);
    const plan = underlaysFor(raw, { grid: { W: 500, H: 300, ox: 0, oz: 0, cell: 0.02 },
      transform: { pos: [0, 0, 0], rot: [0, 0, 0] }, levels: [{ elevation: 0, height: 2.5, name: 'Main' }] })[0];
    if (!plan) throw new Error('Underlay render failed');
    const img = new Image(); img.src = plan.img; await img.decode();
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d'); ctx.drawImage(img, -img.width / 2, -img.height / 2);
    const pixel = Array.from(ctx.getImageData(0, 0, 1, 1).data);
    const restored = mesh.material === material && mesh.parent === parent && parent.parent === raw;
    const out = { width: img.width, height: img.height, extentX: plan.imgW * plan.mPerPx,
      extentY: plan.imgH * plan.mPerPx, pixel, restored };
    geometry.dispose(); material.dispose();
    return out;
  });
  assert.equal(result.width, 2560);
  assert.equal(result.height, 1536);
  assert.equal(result.extentX, 10);
  assert.equal(result.extentY, 6);
  assert.ok(result.pixel[0] > result.pixel[1] * 1.5, `Material tint lost: ${result.pixel}`);
  assert.ok(result.restored, 'Rendering an underlay changed the scan');
  console.log('Rendered underlay passed:', JSON.stringify(result));
} finally {
  if (browser) await browser.close();
  await new Promise(r => server.close(r));
}
