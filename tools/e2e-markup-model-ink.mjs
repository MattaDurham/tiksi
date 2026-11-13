// The planar 3D ink cache must composite a highlighter once at joins and crossings, keep its
// face coordinates, obey a texture budget, and reject nonplanar strokes. Synthetic data only.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = createServer(async (req, res) => {
  if (req.url === '/') {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><script type="importmap">{"imports":{"three":"/vendor/three.module.min.js","three/addons/":"/vendor/addons/"}}</script>');
    return;
  }
  const path = resolve(root, '.' + decodeURIComponent(req.url.split('?')[0]));
  if (!path.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  try {
    const bytes = await readFile(path);
    res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.css': 'text/css' })[extname(path)] || 'application/octet-stream');
    res.end(bytes);
  } catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(Number(process.env.E2E_APP_PORT) || 0, '127.0.0.1', r));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const result = await page.evaluate(async () => {
    const THREE = await import('three');
    const { planarStrokeInk } = await import('/js/markup-model.js');
    const stroke = {
      tool: 'marker', color: '#ff0000', opacity: 0.4, width: 0.18, normal: [0, 0, 1],
      w: [-1, -1, 0, 0, 0, 0, 1, 1, 0, 1, 1, 0, 1, -1, 0, 1, -1, 0, 0, 0, 0, -1, 1, 0],
    };
    const ink = planarStrokeInk(THREE, stroke);
    const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
    renderer.setSize(400, 400); renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    const scene = new THREE.Scene(); scene.background = new THREE.Color('#ffffff'); scene.add(ink);
    const camera = new THREE.OrthographicCamera(-1.3, 1.3, 1.3, -1.3, 0.1, 10); camera.position.z = 2;
    const samples = () => {
      renderer.render(scene, camera);
      const image = document.createElement('canvas'); image.width = image.height = 400;
      const ctx = image.getContext('2d'); ctx.drawImage(renderer.domElement, 0, 0);
      const pixels = ctx.getImageData(0, 0, 400, 400).data;
      let green = 255, colored = 0;
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > 250 && pixels[i + 1] < 240) {
        green = Math.min(green, pixels[i + 1]); colored++;
      }
      return { green, colored };
    };
    const faint = samples(); ink.material.opacity = 0.75; const strong = samples();
    const mask = ink.material.map.image;
    const warped = { ...stroke, w: [...stroke.w] }; warped.w[8] = 0.1;
    const rejected = planarStrokeInk(THREE, warped) === null;
    const missingNormal = planarStrokeInk(THREE, { ...stroke, normal: undefined }) === null;
    const lineFallback = planarStrokeInk(THREE, { ...stroke, tool: 'line' }) === null;
    const long = planarStrokeInk(THREE, { ...stroke, w: [0, 0, 0, 1e4, 0, 0] }, 4096);
    const longSize = [long.material.map.image.width, long.material.map.image.height];
    const wall = planarStrokeInk(THREE, { ...stroke, normal: [1, 0, 0], w: [2, 1, 3, 2, 2, 4] });
    wall.updateMatrixWorld();
    const vertices = wall.geometry.getAttribute('position');
    const wallXs = Array.from({ length: vertices.count }, (_, i) => new THREE.Vector3().fromBufferAttribute(vertices, i).applyMatrix4(wall.matrixWorld).x);
    for (const obj of [ink, long, wall]) { obj.geometry.dispose(); obj.material.map.dispose(); obj.material.dispose(); }
    renderer.dispose();
    return { faint, strong, size: [mask.width, mask.height], rejected, missingNormal, lineFallback, longSize, wallXs };
  });
  assert.ok(result.faint.colored > 1000, 'the planar highlighter renders');
  assert.ok(Math.abs(result.faint.green - 153) <= 2, 'a translucent stroke never doubles its opacity at joins or crossings: ' + JSON.stringify(result.faint));
  assert.ok(Math.abs(result.strong.green - 64) <= 2, 'changing opacity changes the rendered ink');
  assert.ok(result.size.every(n => n <= 2048) && result.size[0] * result.size[1] <= 1024 * 1024, 'normal texture allocation is bounded');
  assert.ok(result.longSize[0] * result.longSize[1] <= 4096, 'a long thin stroke obeys its lower pixel budget');
  assert.ok(result.wallXs.every(x => Math.abs(x - 2) < 1e-7), 'the mask lies exactly on a vertical face');
  assert.equal(result.rejected, true, 'a stroke wrapping around a corner stays 3D');
  assert.equal(result.missingNormal, true, 'legacy strokes use their existing geometry');
  assert.equal(result.lineFallback, true, 'technical lines retain screen-space width');
  assert.deepEqual(errors, []);
  console.log('PASS planar markup ink: uniform alpha, opacity, face alignment, bounded masks and 3D fallbacks');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
