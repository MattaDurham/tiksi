// Real Canvas pixels: transparent pressure ink must not darken at joins or self-crossings,
// pressure must still change its width, and the same geometry scales for high-DPI exports.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = createServer(async (req, res) => {
  if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Ink check</title>'); return; }
  const path = resolve(root, '.' + decodeURIComponent(req.url.split('?')[0]));
  if (!path.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  try {
    const bytes = await readFile(path);
    res.setHeader('Content-Type', extname(path) === '.js' ? 'text/javascript' : 'application/octet-stream'); res.end(bytes);
  } catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(Number(process.env.E2E_APP_PORT) || 0, '127.0.0.1', r));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const result = await page.evaluate(async () => {
    const { drawStroke } = await import('/js/markup-ink.js');
    const canvas = document.createElement('canvas'); canvas.width = 400; canvas.height = 300;
    const ctx = canvas.getContext('2d');
    const alpha = (x, y) => ctx.getImageData(x, y, 1, 1).data[3];
    const maxAlpha = () => {
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let max = 0;
      for (let i = 3; i < pixels.length; i += 4) max = Math.max(max, pixels[i]);
      return max;
    };
    const pts = [40, 150, 0.05, 100, 150, 0.95, 160, 150, 0.1, 100, 150, 0.95, 40, 150, 0.05];
    drawStroke(ctx, { tool: 'pen', color: '#336699', width: 24, opacity: 0.3, pts }, (x, y) => [x, y], 1);
    const pressure = { max: maxAlpha(), centre: alpha(100, 150), broad: alpha(100, 159), fine: alpha(40, 159), start: alpha(40, 150) };
    ctx.clearRect(0, 0, 400, 300);
    drawStroke(ctx, { tool: 'marker', color: '#f2b705', width: 24, pts }, (x, y) => [x, y], 1);
    const marker = { max: maxAlpha(), centre: alpha(100, 150), end: alpha(40, 150) };
    ctx.clearRect(0, 0, 400, 300);
    ctx.setTransform(2, 0, 0, 2, 0, 0);
    ctx.globalAlpha = 0.7; ctx.lineWidth = 7;
    drawStroke(ctx, { tool: 'pen', color: '#336699', width: 20, pts: [50, 50, 0.5] }, (x, y) => [x, y], 1);
    const dpi = { centre: [...ctx.getImageData(100, 100, 1, 1).data], inside: alpha(116, 100), outside: alpha(123, 100), alpha: ctx.globalAlpha, width: ctx.lineWidth };
    return { pressure, marker, dpi };
  });
  assert.ok(result.pressure.max >= 75 && result.pressure.max <= 77, 'one opacity across joins and overlapping pressure silhouettes: ' + JSON.stringify(result.pressure));
  assert.ok(result.pressure.centre >= 75 && result.pressure.start >= 75, 'centre and original endpoint remain filled');
  assert.ok(result.pressure.broad >= 75 && result.pressure.fine === 0, 'pressure visibly changes the width');
  assert.ok(result.marker.max >= 96 && result.marker.max <= 98, 'legacy marker opacity is uniform on retraced ink: ' + JSON.stringify(result.marker));
  assert.ok(result.marker.centre >= 96 && result.marker.end >= 96);
  assert.deepEqual(result.dpi.centre, [51, 102, 153, 255], 'opaque default preserves the chosen color');
  assert.equal(result.dpi.inside, 255); assert.equal(result.dpi.outside, 0, 'high-DPI transform doubles the physical radius');
  assert.ok(Math.abs(result.dpi.alpha - 0.7) < 1e-6); assert.equal(result.dpi.width, 7, 'drawing does not leak canvas state');
  assert.deepEqual(errors, []);
  console.log('Markup ink: smooth pressure, uniform translucent crossings, legacy opacity and high-DPI pixels passed.');
} finally {
  await browser.close();
  await new Promise(r => server.close(r));
}
