// How fast MODEL draws a large imported model: draw calls, triangles and frame times for still
// frames and during a scripted orbit, on any checkout of the app. Synthetic model only.
//
//   node tools/perf-model-drawing.mjs --glb model.glb (--root <checkout> | --url <preview>)
//        [--headed] [--gpu metal|swiftshader] [--grouping off] [--label name]
//
// The same instrumentation runs on every checkout: the served js/viewer3d.js gets one appended
// export that hands back its renderer, composer and camera, and an init script times every
// animation-frame callback that drew a frame, then waits for the GPU (a 1-pixel readPixels)
// so a frame's time covers its GPU work too. Counts are renderer.info summed over every
// renderer.render call in the frame (scene, ambient-occlusion, shadow and outline passes and the
// full-screen post passes), plus the WebGL draw calls actually issued.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const { values: args } = parseArgs({ options: {
  glb: { type: 'string' }, root: { type: 'string' }, url: { type: 'string' }, headed: { type: 'boolean', default: false },
  gpu: { type: 'string', default: 'metal' }, grouping: { type: 'string', default: 'on' }, label: { type: 'string', default: '' },
  quality: { type: 'string', default: 'high' }, frames: { type: 'string', default: '40' },
} });
if (!args.glb || (!args.root === !args.url)) throw new Error('Give --glb and exactly one of --root or --url');
if (!['metal', 'swiftshader', 'default'].includes(args.gpu)) throw new Error('--gpu is metal, swiftshader or default');
if (!['on', 'off'].includes(args.grouping)) throw new Error('--grouping is on or off');
const glb = await readFile(args.glb);

let server = null, base = args.url && args.url.replace(/\/$/, '');
if (args.root) {
  const root = resolve(args.root);
  server = createServer(async (req, res) => {
    const p = req.url.split('?')[0];
    const path = resolve(root, '.' + decodeURIComponent(p === '/' ? '/index.html' : p));
    if (!path.startsWith(root + sep)) { res.writeHead(403).end(); return; }
    try { const bytes = await readFile(path); res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json' })[extname(path)] || 'application/octet-stream'); res.end(bytes); }
    catch { res.writeHead(404).end(); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
}

const gpuArgs = args.gpu === 'metal' ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] : args.gpu === 'swiftshader' ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : [];
const browser = await chromium.launch({ headless: !args.headed, channel: args.headed ? 'chrome' : undefined, args: gpuArgs });
const HOOK = `
export function __perfHandles() { return { renderer, composer, camera, controls, scanObjs, passes, scene, batches: typeof batches === 'undefined' ? null : batches }; }`;

// Times each rAF callback; when one drew (a composer pass ran), waits for the GPU and records it.
const INIT = () => {
  const frames = [];
  window.__perf = { frames, recording: false, drew: false };
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = cb => raf(ts => {
    const p = window.__perf;
    p.drew = false;
    const info = p.renderer && p.renderer.info;
    if (info) info.reset();
    const t0 = performance.now();
    cb(ts);
    const t1 = performance.now();
    if (p.drew && p.recording) {
      p.gl.readPixels(0, 0, 1, 1, p.gl.RGBA, p.gl.UNSIGNED_BYTE, p.pixel);
      const t2 = performance.now();
      frames.push({ ts, cpu: t1 - t0, total: t2 - t0, calls: info.render.calls, triangles: info.render.triangles, glDraws: p.glDraws, glSubDraws: p.glSubDraws, fast: p.passes ? !p.passes.gtao.enabled : null });
    }
    p.glDraws = 0; p.glSubDraws = 0;
  });
};

try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 });
  await context.addInitScript(INIT);
  await context.route('**/js/viewer3d.js*', async route => {
    const res = await route.fetch();
    route.fulfill({ response: res, body: (await res.text()) + HOOK, headers: { ...res.headers(), 'content-type': 'text/javascript' } });
  });
  await context.route('**/__perf/model.glb', route => route.fulfill({ body: glb, headers: { 'content-type': 'model/gltf-binary' } }));
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + '/#/budget');
  await page.locator('#btn-file').waitFor({ state: 'attached' });
  await page.evaluate(async quality => {
    const s = await import('/js/store.js');
    localStorage.removeItem('tiksi.onScreen.v1');
    s.ws.data = s.emptyWorkspace();
    const p = s.propertyTemplate('Perf cellar'); p.id = 'prop-perf';
    p.env = Object.assign({}, s.defaultEnv(), { quality });
    const bytes = await (await fetch('/__perf/model.glb')).arrayBuffer();
    await s.putFile('scan-cellar', bytes, { format: 'glb' });
    p.scans.push({ id: 'scan-cellar', name: 'Wine cellar.glb', format: 'glb', kind: 'mesh', pos: [0, 0, 0], rot: [0, 0, 0], rotY: 0, scale: 1, visible: true });
    s.ws.data.properties.push(p); s.ws.data.settings.activePropertyId = p.id;
    s.touch();
  }, args.quality);
  await page.locator('#rail a[data-view="model"]').click({ noWaitAfter: true });
  await page.locator('canvas.v-canvas').waitFor();
  const t0 = performance.now();
  await page.waitForFunction(() => import('/js/viewer3d.js').then(v => !!v.__perfHandles().scanObjs['scan-cellar']), null, { timeout: 180000, polling: 250 });
  const loadMs = performance.now() - t0;
  await delay(3000);   // textures, environment bake, shader warm-up

  const setup = await page.evaluate(async grouping => {
    const v = await import('/js/viewer3d.js');
    const h = v.__perfHandles(), p = window.__perf;
    if (h.batches && grouping === 'off') h.batches.setEnabled(false);
    p.renderer = h.renderer; p.passes = h.passes;
    const gl = p.gl = h.renderer.getContext();
    p.pixel = new Uint8Array(4); p.glDraws = 0; p.glSubDraws = 0;
    h.renderer.info.autoReset = false;
    for (const name of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced']) {
      const f = gl[name].bind(gl);
      gl[name] = (...a) => { p.glDraws++; p.glSubDraws++; return f(...a); };
    }
    const md = gl.getExtension('WEBGL_multi_draw');
    if (md) for (const name of ['multiDrawElementsWEBGL', 'multiDrawArraysWEBGL']) {
      const f = md[name].bind(md);
      md[name] = (...a) => { p.glDraws++; p.glSubDraws += a[a.length - 1]; return f(...a); };
    }
    const render = h.composer.render.bind(h.composer);
    h.composer.render = (...a) => { p.drew = true; return render(...a); };
    // A fixed view over the cellar from a corner, looking down into the racks.
    h.camera.position.set(5.2, 4.2, 5.6); h.controls.target.set(0, 0.9, 0); h.controls.update();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    return { gpu: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), multiDraw: !!md, dpr: h.renderer.getPixelRatio(), size: [gl.drawingBufferWidth, gl.drawingBufferHeight], samples: h.composer.renderTarget1.samples, grouped: h.batches ? h.batches.stats() : null };
  }, args.grouping);
  await delay(1500);

  // Still frames: the camera at rest, one full-quality frame drawn per animation frame.
  const N = Number(args.frames);
  const still = await page.evaluate(async n => {
    const v = await import('/js/viewer3d.js');
    const h = v.__perfHandles(), p = window.__perf;
    p.frames.length = 0; p.recording = true;
    for (let i = 0; i < n; i++) {
      document.querySelector('[data-env=exposure]')?.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    }
    p.recording = false;
    return p.frames.splice(0);
  }, N);

  // A scripted orbit: left-drag across the view for about three seconds, then let it settle.
  const box = await page.locator('canvas.v-canvas').boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx - 300, cy);
  await page.evaluate(() => { const p = window.__perf; p.frames.length = 0; p.recording = true; p.dragStart = performance.now(); });
  await page.mouse.down();
  for (let i = 0; i < 150; i++) { await page.mouse.move(cx - 300 + i * 4, cy + Math.sin(i / 20) * 40); await delay(16); }
  await page.mouse.up();
  const dragEnd = await page.evaluate(() => performance.now());
  await delay(1200);
  const { orbit, dragStart } = await page.evaluate(() => { const p = window.__perf; p.recording = false; return { orbit: p.frames.splice(0), dragStart: p.dragStart }; });
  const dragMs = dragEnd - dragStart;

  // CPU work per frame that grows with the model: the scene's matrix update (run by every
  // renderer.render call that draws the scene), the grouping's per-frame sync, and the outline
  // pass's scene walks when something is selected.
  const cpu = await page.evaluate(async () => {
    const v = await import('/js/viewer3d.js');
    const h = v.__perfHandles(), N = 50, time = f => { const t = performance.now(); for (let i = 0; i < N; i++) f(); return +((performance.now() - t) / N).toFixed(3); };
    let objects = 0; h.scene.traverse(() => objects++);
    const out = { sceneObjects: objects, matrixUpdateMs: time(() => h.scene.updateMatrixWorld()) };
    if (h.batches) out.groupingSyncMs = time(() => { h.batches.beginFrame(h.scanObjs); h.batches.endFrame(); });
    const pass = h.passes.outline;
    // One outline pass walks the scene twice to hide and restore what is not selected.
    out.outlineWalkMs = time(() => { pass._updateSelectionCache(); pass._changeVisibilityOfNonSelectedObjects(false); pass._changeVisibilityOfNonSelectedObjects(true); pass._visibilityCache.clear(); pass._selectionCache.clear(); });
    return out;
  });
  const stat = (list, key) => {
    const v = list.map(f => f[key]).sort((a, b) => a - b);
    if (!v.length) return null;
    const q = x => v[Math.min(v.length - 1, Math.floor(x * v.length))];
    return { median: +q(0.5).toFixed(2), p95: +q(0.95).toFixed(2), max: +v[v.length - 1].toFixed(2) };
  };
  const moving = orbit.filter(f => f.ts <= dragEnd), after = orbit.filter(f => f.ts > dragEnd);
  const intervals = moving.slice(1).map((f, i) => ({ dt: f.ts - moving[i].ts }));
  const summary = {
    label: args.label, base, gpu: setup.gpu, headed: args.headed, angle: args.gpu, multiDraw: setup.multiDraw, dpr: setup.dpr, drawingBuffer: setup.size, msaaSamples: setup.samples,
    quality: args.quality, grouping: setup.grouped ? args.grouping : 'n/a (main)', groups: setup.grouped, modelLoadMs: Math.round(loadMs),
    still: { frames: still.length, calls: stat(still, 'calls'), triangles: stat(still, 'triangles'), glDraws: stat(still, 'glDraws'), glSubDraws: stat(still, 'glSubDraws'), cpuMs: stat(still, 'cpu'), frameMs: stat(still, 'total') },
    orbit: { frames: moving.length, dragMs: Math.round(dragMs), fastFrames: moving.filter(f => f.fast).length, calls: stat(moving, 'calls'), triangles: stat(moving, 'triangles'), glDraws: stat(moving, 'glDraws'), cpuMs: stat(moving, 'cpu'), frameMs: stat(moving, 'total'), rafIntervalMs: stat(intervals, 'dt'),
      ...Object.fromEntries([['fast', true], ['full', false]].map(([k, v]) => { const l = moving.filter(f => !!f.fast === v); return [k + 'Stats', l.length ? { n: l.length, calls: stat(l, 'calls'), glSubDraws: stat(l, 'glSubDraws'), frameMs: stat(l, 'total') } : null]; })) },
    cpuPerFrame: cpu,
    afterRelease: after.map(f => ({ calls: f.calls, frameMs: +f.total.toFixed(2), fast: f.fast })),
    errors,
  };
  console.log(JSON.stringify(summary, null, 1));
} finally {
  await browser.close();
  if (server) server.close();
}
