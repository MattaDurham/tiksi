// Pinned photos and documents, photo mode and numbered photo positions, in a real browser on a
// synthetic property. A photo with a lens in its file and a one-page PDF are added through the
// PIN tool; the PDF hangs flat on a wall at true letter size (following a moved wall is covered
// by test/pinned-photos.test.mjs);
// photo mode starts with the photo's own lens, fits the camera to clicked point pairs and saves
// it; the camera becomes numbered position 1, and RENDER ALL POSITIONS files a rendering on it.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { readFile } from 'node:fs/promises';
import { dirname, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
  const path = resolve(root, '.' + decodeURIComponent(req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0]));
  if (!path.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  try { const bytes = await readFile(path); res.setHeader('Content-Type', TYPES[extname(path)] || 'application/octet-stream'); res.end(bytes); }
  catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(Number(process.env.E2E_APP_PORT) || 0, 'localhost', r));
const url = `http://localhost:${server.address().port}`;
const browser = await chromium.launch({ headless: true });

async function waitUntil(predicate, message, timeoutMs = 20_000) {
  const deadline = performance.now() + timeoutMs;
  while (!(await predicate())) {
    assert.ok(performance.now() < deadline, 'Timed out: ' + message);
    await delay(100);
  }
}
const prop = page => page.evaluate(async () => { const s = await import('/js/store.js'); return JSON.parse(JSON.stringify(s.activeProperty())); });

// A JPEG carrying the EXIF a phone writes (24 mm equivalent, the time it was taken).
function exifApp1() {
  const buf = new Uint8Array(512), dv = new DataView(buf.buffer), w16 = (o, v) => dv.setUint16(o, v, true), w32 = (o, v) => dv.setUint32(o, v, true);
  buf.set([0x49, 0x49]); w16(2, 42); w32(4, 8);
  let extra = 300;
  const write = (at, entries) => {
    w16(at, entries.length);
    entries.forEach(([tag, type, val], i) => {
      const e = at + 2 + i * 12; w16(e, tag); w16(e + 2, type);
      if (type === 2) { const b = [...Buffer.from(val), 0]; w32(e + 4, b.length); w32(e + 8, extra); buf.set(b, extra); extra += b.length + 1; }
      else if (type === 3) { w32(e + 4, 1); w16(e + 8, val); }
      else { w32(e + 4, 1); w32(e + 8, val); }
    });
    w32(at + 2 + entries.length * 12, 0);
  };
  const e0 = [[0x010f, 2, 'Apple'], [0x8769, 4, 0]], exAt = 8 + 2 + e0.length * 12 + 4;
  e0[1][2] = exAt; write(8, e0); write(exAt, [[0xa405, 3, 24], [0x9003, 2, '2026:10:30 11:39:27'], [0x9011, 2, '-04:00']]);
  const tiff = buf.slice(0, extra), app1 = Buffer.alloc(10 + tiff.length);
  app1.set([0xff, 0xe1, (app1.length - 2) >> 8, (app1.length - 2) & 255, 0x45, 0x78, 0x69, 0x66, 0, 0]); app1.set(tiff, 10);
  return app1;
}
function letterPdf() {
  const content = 'BT /F1 36 Tf 72 700 Td (SPEC SHEET) Tj ET 0 0 1 RG 4 w 72 100 468 560 re S';
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    '<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let pdf = '%PDF-1.4\n'; const offs = [];
  objs.forEach((o, i) => { offs.push(pdf.length); pdf += (i + 1) + ' 0 obj\n' + o + '\nendobj\n'; });
  const xref = pdf.length;
  pdf += 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n' + offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('') + 'trailer\n<< /Size ' + (objs.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF';
  return Buffer.from(pdf, 'latin1');
}

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.addInitScript(() => localStorage.setItem('tiksi.onScreen.v1', '{"all":true}'));   // MODEL's tools on the screen (tiksi-menu.js)
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(url); await page.locator('[data-prop-name]').waitFor();
  await page.evaluate(async () => {
    const store = await import('/js/store.js');
    store.ws.data = store.emptyWorkspace();
    const p = store.propertyTemplate('Pins check'); p.id = 'prop-pins'; const L = p.levels[0].id;
    const wall = (id, ax, ay, bx, by) => ({ id, level: L, ax, ay, bx, by, thickness: 0.114, height: null, material: 'mat-drywall' });
    p.walls.push(wall('w-s', 0, 0, 6, 0), wall('w-e', 6, 0, 6, 4), wall('w-n', 6, 4, 0, 4), wall('w-w', 0, 4, 0, 0));
    p.rooms.push({ id: 'r-k', level: L, name: 'Kitchen', pts: [[0, 0], [6, 0], [6, 4], [0, 4]], material: 'mat-oak', ceilingMaterial: null });
    store.ws.data.properties.push(p); store.ws.data.settings.activePropertyId = p.id;
  });
  await page.locator('#rail a[data-view="model"]').click({ noWaitAfter: true });
  await page.locator('canvas.v-canvas').waitFor();

  // The PIN tool adds a photo (its lens and time come from the file) and a PDF document.
  const c = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 1600; c.height = 1200; const x = c.getContext('2d'); x.fillStyle = '#c96'; x.fillRect(0, 0, 1600, 1200); return c.toDataURL('image/jpeg', 0.8); });
  const jpg = Buffer.from(c.split(',')[1], 'base64');
  const withExif = Buffer.concat([jpg.subarray(0, 2), exifApp1(), jpg.subarray(2)]);
  await page.locator('[data-act=pin]').click();
  await page.locator('[data-photo-file]').setInputFiles({ name: 'kitchen.jpg', mimeType: 'image/jpeg', buffer: withExif });
  await waitUntil(async () => (await prop(page)).photos.length === 1, 'the photo is added');
  if (!(await page.locator('[data-doc-file]').count())) await page.locator('[data-act=pin]').click();
  await page.locator('[data-doc-file]').setInputFiles({ name: 'Spec sheet.pdf', mimeType: 'application/pdf', buffer: letterPdf() });
  await waitUntil(async () => (await prop(page)).photos.length === 2, 'the PDF is added', 30_000);
  let p = await prop(page);
  const photo = p.photos.find(x => x.kind === 'photo'), doc = p.photos.find(x => x.kind === 'document');
  assert.equal(photo.lens.f35, 24); assert.equal(Math.round(photo.lens.hfov), 72); assert.equal(photo.takenAt, '2026-10-30T11:39:27-04:00');
  assert.equal(doc.mime, 'application/pdf'); assert.equal(doc.pageCount, 1);
  assert.ok(Math.abs(doc.sheetW - 0.2159) < 1e-4 && Math.abs(doc.sheetH - 0.2794) < 1e-4, 'a letter page is 8.5 x 11 in');

  // Pin both on the south wall's room face (as a click there would), then move the wall: the
  // sheets lie flat on it and go with it.
  await page.evaluate(async () => {
    const store = await import('/js/store.js'), p = store.activeProperty();
    const [ph, d] = [p.photos.find(x => x.kind === 'photo'), p.photos.find(x => x.kind === 'document')];
    ph.pin = { x: 2, y: 1.5, z: 0.057, nx: 0, ny: 0, nz: 1, size: 0.3556, wall: { id: 'w-s', side: 1, along: 2, up: 1.5 } }; ph.roomId = 'r-k';
    d.pin = { x: 4, y: 1.4, z: 0.057, nx: 0, ny: 0, nz: 1, size: 1, wall: { id: 'w-s', side: 1, along: 4, up: 1.4 } };
    store.touch();
  });
  if (await page.locator('[data-cancel]').count()) await page.locator('[data-cancel]').click();   // close the PIN tool
  await page.locator('#rail a[data-view="plan"]').click({ noWaitAfter: true }); await delay(300);
  await page.locator('#rail a[data-view="model"]').click({ noWaitAfter: true }); await page.locator('canvas.v-canvas').waitFor();
  await page.locator('.v-pin-row', { hasText: 'Spec sheet.pdf' }).locator('[data-locate]').click();
  await delay(900);
  await page.keyboard.press('Escape');
  // Clicking the sheet itself selects it and offers to read it.
  const box = await page.locator('canvas.v-canvas').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await waitUntil(async () => (await page.locator('.inspector h3').first().innerText()) === 'PINNED DOCUMENT', 'a click on the sheet selects it');
  assert.match(await page.locator('.inspector').innerText(), /9" x 11"|8½" x 11"|0\.22 m x 0\.28 m|8 1\/2" x 11"/);
  if (process.env.E2E_SHOTS) await page.screenshot({ path: process.env.E2E_SHOTS + '/pinned-document.png' });

  // Photo mode: the photo's lens, four or more point pairs, a fitted camera saved on the photo.
  await page.evaluate(id => { location.hash = '#/model?match=' + id; }, photo.id);
  await page.locator('[data-match-points]').waitFor();
  assert.match(await page.locator('.inspector').innerText(), /24 mm equiv/);
  await page.locator('[data-match-points]').click();
  const cb = await page.locator('canvas.v-canvas').boundingBox();
  for (const [fx, fy] of [[0.3, 0.3], [0.7, 0.32], [0.68, 0.7], [0.32, 0.72], [0.5, 0.55]]) {
    const x = cb.x + cb.width * fx, y = cb.y + cb.height * fy;
    await page.mouse.click(x, y); await delay(80);   // the spot in the photo
    await page.mouse.click(x, y); await delay(80);   // the same spot in the model
  }
  await waitUntil(async () => /Average error/.test(await page.locator('.inspector').innerText()), 'the camera is fitted');
  const rms = Number((/Average error\s*([\d.]+) px/.exec(await page.locator('.inspector').innerText()) || [])[1]);
  assert.ok(rms < 1, 'pairs clicked at the same screen spots fit the current camera: ' + rms);
  await page.locator('[data-match-save]').click();
  await waitUntil(async () => ((await prop(page)).photos.find(x => x.kind === 'photo').view || {}).from === 'points', 'the fitted camera is saved');
  p = await prop(page);
  assert.equal(p.photos.find(x => x.kind === 'photo').view.pairs.length, 5);

  // The camera becomes numbered position 1; RENDER ALL POSITIONS files a rendering on it.
  await page.evaluate(id => { location.hash = '#/model?x=1&match=' + id; }, photo.id);
  await page.locator('[data-match-pos]').waitFor();
  await page.locator('[data-match-pos]').click();
  await waitUntil(async () => (await prop(page)).photoPositions.length === 1, 'the position is made');
  p = await prop(page);
  assert.equal(p.photoPositions[0].number, 1); assert.equal(p.photoPositions[0].name, 'Kitchen');
  assert.equal(p.photos.find(x => x.kind === 'photo').role, 'before');
  if (await page.locator('[data-render]').count()) await page.locator('[data-render]').click();
  else { await page.keyboard.press('Escape'); await page.locator('[data-pos-render-all]').click(); }
  await waitUntil(async () => (await prop(page)).photos.some(x => x.source === 'rendering'), 'a rendering is made', 60_000);
  p = await prop(page);
  const r = p.photos.find(x => x.source === 'rendering');
  assert.equal(r.positionId, p.photoPositions[0].id); assert.equal(r.role, 'rendering'); assert.match(r.name, /^Position 1 · Kitchen · rendering \d{4}-\d{2}-\d{2}/);
  assert.equal(r.w / r.h, 4 / 3, 'rendered at the before photo\'s shape');

  // PHOTOS shows the document and the rendering for what they are.
  await page.locator('#rail a[data-view="photos"]').click({ noWaitAfter: true });
  await page.locator('.ph-card').first().waitFor();
  const chips = await page.locator('.ph-card .ph-chips').allInnerTexts();
  assert.ok(chips.some(t => /DOCUMENT/.test(t)), 'the PDF is a document');
  assert.ok(chips.some(t => /RENDERING/.test(t) && /POSITION 1/.test(t)), 'the rendering belongs to position 1');
  assert.deepEqual(errors, []);
  console.log('Pinned photos, documents, photo mode and numbered positions: ok');
} finally {
  await browser.close();
  server.close();
}
