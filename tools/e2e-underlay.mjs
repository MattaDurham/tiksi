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
    res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html' })[extname(file)] || 'application/octet-stream');
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
  const mixed = await page.evaluate(async () => {
    const THREE = await import('three');
    const { mixedScan } = await import('/test/fixtures/mixed-scan.mjs');
    const { analyseMesh, underlaysFor, planFromScanBytes, proposalSummary } = await import('/js/scan2plan.js');
    const store = await import('/js/store.js');
    const { pos, idx } = mixedScan();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geometry.setIndex(new THREE.BufferAttribute(idx, 1));
    const colors = new Float32Array(pos.length);
    for (let i = 0; i < pos.length; i += 3) {
      const y = pos[i + 1];
      colors.set(y < -1 ? [1, 0.8, 0.05] : y < 0.2 ? [1, 0.05, 0.02] : y < 1 ? [0.02, 1, 0.05] : [0.05, 0.05, 1], i);
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const material = new THREE.MeshBasicMaterial({ vertexColors: true });
    const mesh = new THREE.Mesh(geometry, material), root = new THREE.Group(); root.add(mesh);
    const before = pos.slice(), result = await analyseMesh(root);
    const plan = underlaysFor(root, result)[0];
    async function pixels(plan) {
      const img = new Image(); img.src = plan.img; await img.decode();
      const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height;
      const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0);
      const at = (x, z) => Array.from(ctx.getImageData(Math.floor((x - plan.offsetX) / plan.mPerPx), Math.floor((z - plan.offsetY) / plan.mPerPx), 1, 1).data);
      return { indoor: at(2, 2.5), landing: at(4.5, -0.75), yard: at(8, 6) };
    }
    const actual = await pixels(plan);
    const oldClip = await pixels(underlaysFor(root, { ...result, levels: result.levels.map(l => ({ ...l, elevation: 0.55, underlayMin: undefined })) })[0]);
    const noLanding = await pixels(underlaysFor(root, { ...result, levels: result.levels.map(l => ({ ...l, underlayMin: 0 })) })[0]);
    const unchanged = pos.every((v, i) => v === before[i]) && mesh.material === material && mesh.parent === root;
    store.ws.data = store.emptyWorkspace();
    const prop = store.propertyTemplate('Synthetic mixed surfaces'); prop.id = 'mixed-surfaces';
    const scan = { id: 'mixed-source', name: 'synthetic.obj', format: 'obj', kind: 'mesh' };
    prop.scans.push(scan); store.ws.data.properties.push(prop); store.ws.data.settings.activePropertyId = prop.id;
    // Original bytes travel independently from the proposal and its report.
    const lines = [];
    for (let i = 0; i < pos.length; i += 3) lines.push(`v ${pos[i]} ${pos[i + 1]} ${pos[i + 2]}`);
    for (let i = 0; i < idx.length; i += 3) lines.push(`f ${idx[i] + 1} ${idx[i + 1] + 1} ${idx[i + 2] + 1}`);
    const source = new TextEncoder().encode(lines.join('\n') + '\n');
    await store.putFile(scan.id, source.buffer, { kind: 'mesh', format: 'obj' });
    const { applied } = await planFromScanBytes(prop, scan, source.buffer, null, { underlay: false });
    if (applied?.rooms.length !== 1) throw new Error('Byte import lost the enclosed room');
    // Use the color-coded render for visual inspection; the report came through
    // the actual byte parser, worker, proposal and application pipeline.
    prop.levels[0].plan = { ...plan, opacity: 0.6, calibrated: true, source: 'scan' };
    const bundle = await store.exportProjectBlob(prop.id), back = await store.readBundle(new File([bundle.blob], 'synthetic.tiksi'));
    const roundtrip = back.data.properties[0].scans[0].floorDetection;
    const kept = new Uint8Array((await store.getFile(scan.id)).buffer);
    const sourceUnchanged = kept.every((v, i) => v === source[i]) && kept.length === source.length;
    store.save();
    geometry.dispose(); material.dispose();
    return { actual, oldClip, noLanding, unchanged, sourceUnchanged,
      report: scan.floorDetection, roundtrip, summary: proposalSummary(result, applied) };
  });
  assert.ok(mixed.actual.indoor[0] > mixed.actual.indoor[1] * 2, `Indoor floor erased: ${mixed.actual.indoor}`);
  assert.ok(mixed.actual.landing[0] > mixed.actual.landing[2] * 2, `Lower landing erased: ${mixed.actual.landing}`);
  assert.ok(mixed.actual.yard[1] > mixed.actual.yard[0] * 2, 'Yard evidence remains visible');
  assert.ok(mixed.oldClip.indoor[0] < 30, 'Negative control reproduces the wrong-datum floor loss');
  assert.ok(mixed.noLanding.landing[0] < 30, 'Negative control reproduces the landing loss');
  assert.ok(mixed.unchanged && mixed.sourceUnchanged, 'Proposal/rendering changed the source');
  assert.deepEqual(mixed.roundtrip, mixed.report, 'Review evidence survives a project bundle');
  assert.match(mixed.summary, /Review floor datums/);
  await page.goto(`http://localhost:${server.address().port}/#/model`);
  await page.locator('canvas.v-canvas').waitFor();
  await page.locator('#rail a[data-view=plan]').click({ noWaitAfter: true });
  const review = page.locator('[data-floor-review]');
  await review.waitFor();
  assert.match(await review.locator('summary').innerText(), /Review floor datums/);
  await review.locator('summary').click();
  assert.match(await review.innerText(), /-2.15/);
  assert.match(await review.innerText(), /floor datum/);
  assert.match(await review.innerText(), /ceiling/);
  await page.reload(); await review.waitFor();
  assert.match(await review.locator('summary').innerText(), /Review floor datums/, 'Review remains visible after reload');
  if (process.env.E2E_SHOTS) {
    await review.locator('summary').click();
    await page.screenshot({ path: process.env.E2E_SHOTS + '/mixed-floor-review.png' });
  }
  console.log('Mixed underlay passed: indoor floor, yard and lower landing pixels retained; review report persists.');

} finally {
  if (browser) await browser.close();
  await new Promise(r => server.close(r));
}
