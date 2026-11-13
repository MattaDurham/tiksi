// How long MODEL's tools take on made-up projects of realistic size, on any checkout of the app,
// as a computer and as a phone (an iPhone-sized touch profile). Prints one JSON object.
//
//   node tools/perf-model-tools.mjs [--root <checkout>] [--gpu swiftshader|metal] [--only name,name]
//
//   pick      a click, a wheel step and a tap on a 607,500-triangle mesh scan with a
//             500,000-point cloud inside it: the time the page's handlers take (the test of
//             what is under the pointer)
//   lights    the time to draw one full frame at night in a house of 24 rooms, and how many
//             room lights are lit
//   room      walking into a room and back out five times: how often the sky lighting is baked
//             again, and the page time that takes
//   textures  opening a house that uses 13 library materials: the time the page itself spends
//             making their textures, and the longest gap between frames meanwhile
//   hover     selecting 40 parts of a 3,000-part model one by one by Shift-click, then
//             hovering on and off a wall: the page's own work for the clicks and per hover
//             (each redoes the outline of everything selected)
//   pins      opening a house with 12 pinned 4000 x 3000 photos: how many full-size pictures
//             are decoded, and the largest card texture
//   idle      draw calls over 2.5 seconds with nothing changing (must be 0)
//
// Times from a software renderer (the default, as in CI) are for comparing one checkout with
// another on the same machine. They are not a real phone's or a real graphics card's times.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, devices } from 'playwright';

const { values: args } = parseArgs({ options: { root: { type: 'string' }, gpu: { type: 'string', default: 'swiftshader' }, only: { type: 'string', default: '' } } });
if (!['swiftshader', 'metal'].includes(args.gpu)) throw new Error('--gpu is swiftshader or metal');
const root = resolve(args.root || resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const tools = resolve(dirname(fileURLToPath(import.meta.url)));
const server = createServer(async (req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0]);
  // The synthetic model writer always comes from this checkout, so an older one can be measured too.
  const path = rel === '/tools/synthetic-model.mjs' ? resolve(tools, 'synthetic-model.mjs') : resolve(root, '.' + rel);
  if (!path.startsWith(root + sep) && !path.startsWith(tools + sep)) { res.writeHead(403).end(); return; }
  try { const bytes = await readFile(path); res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.wasm': 'application/wasm' })[extname(path)] || 'application/octet-stream'); res.end(bytes); }
  catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, 'localhost', r));
const url = `http://localhost:${server.address().port}`;
const browser = await chromium.launch({ args: args.gpu === 'metal' ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const { defaultBrowserType, ...iphone } = devices['iPhone 13'];
const PROFILES = { computer: { viewport: { width: 1280, height: 800 } }, phone: iphone };
const step = text => { if (process.env.PERF_STEPS) console.error('  .. ' + text); };
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const round = v => v == null ? null : Math.round(v * 10) / 10;

const INIT = () => {
  localStorage.setItem('tiksi.onScreen.v1', '{"all":true}');
  const P = WebGL2RenderingContext.prototype;
  window.__perf = { draws: 0, decodes: [], largestCard: 0, lights: 0 };
  for (const name of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced', 'drawRangeElements']) {
    const real = P[name]; if (!real) continue;
    P[name] = function () { window.__perf.draws++; return real.apply(this, arguments); };
  }
  // The handlers between the window's capture and bubble listeners are the page's own work:
  // every pointerup and wheel event is timed, and a measurement takes the times since the last.
  window.__handled = { pointerup: [], wheel: [] };
  for (const type of ['pointerup', 'wheel']) {
    let t0 = 0;
    window.addEventListener(type, () => { t0 = performance.now(); }, true);
    window.addEventListener(type, () => { window.__handled[type].push(performance.now() - t0); }, false);
  }
  // The work a hover does: the frame callback a pointer move asks for (what is under the
  // pointer, then the outlines of everything selected).
  let inMove = false;
  window.__hoverMs = [];
  window.addEventListener('pointermove', () => { inMove = true; }, true);
  window.addEventListener('pointermove', () => { inMove = false; }, false);
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = cb => inMove ? raf(t => { const s = performance.now(); cb(t); window.__hoverMs.push(performance.now() - s); }) : raf(cb);
  // Every picture the page decodes at full size, by its longest side.
  const src = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
  Object.defineProperty(HTMLImageElement.prototype, 'src', { get() { return src.get.call(this); }, set(v) {
    this.addEventListener('load', () => window.__perf.decodes.push(Math.max(this.naturalWidth, this.naturalHeight)), { once: true });
    src.set.call(this, v);
  } });
  const bitmap = window.createImageBitmap;
  window.createImageBitmap = async function () { const b = await bitmap.apply(this, arguments); window.__perf.decodes.push(Math.max(b.width, b.height)); return b; };
};

const viewer = (page, body, arg) => page.evaluate(new Function('arg', 'return import("/js/viewer3d.js").then(async v => { ' + body + ' })'), arg);
async function settled(page, ms = 600_000) {
  const end = Date.now() + ms;
  while (!(await viewer(page, 'return v.viewerIdle()'))) { if (Date.now() > end) throw new Error('MODEL did not settle: ' + JSON.stringify(await viewer(page, 'return v.viewerIdleState()'))); await delay(250); }
}
// Open MODEL on a property the page builds itself: `build` runs in the page with (store, synthetic-model, property).
async function open(profile, build, arg, before) {
  const context = await browser.newContext(PROFILES[profile]);
  await context.addInitScript(INIT);
  const page = await context.newPage();
  await page.goto(url + '/#/budget');
  await page.locator('#btn-file').waitFor({ state: 'attached' });
  await page.evaluate(new Function('arg', `return (async () => {
    const s = await import('/js/store.js'), syn = await import('/tools/synthetic-model.mjs');
    s.ws.data = s.emptyWorkspace();
    (await import('/js/materials.js')).ensureBuiltinMaterials();
    const p = s.propertyTemplate('Measuring house'); p.id = 'prop-measure';
    p.env.quality = 'high'; p.env.date = '2024-06-21'; p.env.time = 15.5;
    const L = p.levels[0].id;
    const box = (x0, y0, x1, y1, id, material) => {
      p.walls.push(...[[x0, y0, x1, y0], [x1, y0, x1, y1], [x1, y1, x0, y1], [x0, y1, x0, y0]].map(([ax, ay, bx, by], i) => ({ id: id + '-w' + i, level: L, ax, ay, bx, by, thickness: 0.12, material: 'mat-drywall' })));
      p.rooms.push({ id, level: L, name: id, pts: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], material: material || 'mat-oak' });
    };
    await (${build.toString()})(s, syn, p, L, box, arg);
    s.ws.data.properties.push(p); s.ws.data.settings.activePropertyId = p.id;
    s.touch();
  })()`), arg);
  if (before) await before(page);
  step('built the property');
  const t0 = Date.now();
  await page.evaluate(() => { location.hash = '#/model'; });
  await page.locator('canvas.v-canvas').waitFor({ state: 'attached' });
  await settled(page);
  step('MODEL open and settled');
  return { page, context, openMs: Date.now() - t0 };
}
// Where a model point lands on the page.
const onScreen = (page, point) => page.evaluate(async point => {
  const THREE = await import('three'), v = await import('/js/viewer3d.js');
  const cam = v.drawStats().camera, r = document.querySelector('canvas.v-canvas').getBoundingClientRect();
  const q = new THREE.Vector4(...point, 1).applyMatrix4(new THREE.Matrix4().fromArray(cam.inverse)).applyMatrix4(new THREE.Matrix4().fromArray(cam.projection));
  return [r.left + (q.x / q.w + 1) / 2 * r.width, r.top + (1 - q.y / q.w) / 2 * r.height];
}, point);

const scenarios = {
  async pick(profile) {
    const { page, context } = await open(profile, async (s, syn, p, L, box) => {
      box(0, 0, 6, 4, 'room');
      const mesh = syn.writeGlb({ looks: [{ name: 'Scan', color: [0.7, 0.7, 0.72, 1], roughness: 0.9 }], meshes: [{ geometry: syn.boxGeometry(4, 2.5, 3, 225), look: 0 }], nodes: [{ name: 'Room scan', mesh: 0, translation: [3, 1.25, 2] }] });
      await s.putFile('scan-mesh', mesh.glb.buffer, { format: 'glb' });
      p.scans.push({ id: 'scan-mesh', name: 'Room scan.glb', format: 'glb', kind: 'mesh', pos: [0, 0, 0], rot: [0, 0, 0], rotY: 0, scale: 1, visible: true });
      const rows = [];
      for (let i = 0; i < 500000; i++) rows.push((1 + (i % 1000) * 0.004).toFixed(3) + ' ' + ((i / 1000 | 0) * 0.005).toFixed(3) + ' ' + (0.5 + ((i * 7919) % 1000) * 0.003).toFixed(3));
      await s.putFile('scan-cloud', new TextEncoder().encode(rows.join('\n')).buffer, { format: 'xyz' });
      p.scans.push({ id: 'scan-cloud', name: 'Cloud.xyz', format: 'xyz', kind: 'points', pos: [0, 0, 0], rot: [0, 0, 0], rotY: 0, scale: 1, visible: true, pointSize: 0.02, pointColor: 'solid', budget: 2000000 });
    });
    await viewer(page, 'v.fieldAction("camera", "frame")'); await delay(1200); await settled(page);
    const [x, y] = await onScreen(page, [3, 2.5, 2]);      // the top of the scan, over the room and through the cloud
    step('pick: the scan is at ' + Math.round(x) + ', ' + Math.round(y));
    const out = { triangles: 607500, points: 500000 };
    const times = { click: [], wheel: [] };
    const taken = type => page.evaluate(type => window.__handled[type].splice(0), type);
    await taken('pointerup');
    for (let i = 0; i < 5; i++) {
      await settled(page);
      if (profile === 'phone') await page.touchscreen.tap(x + i, y); else await page.mouse.click(x + i, y);
      await delay(300);
    }
    times.click = await taken('pointerup');
    await taken('wheel');
    if (profile === 'computer') for (let i = 0; i < 5; i++) {
      await settled(page);
      await page.mouse.move(x + i * 9, y + 5);
      await page.mouse.wheel(0, -120);
      await delay(400);
    }
    times.wheel = await taken('wheel');
    out.clickMs = round(median(times.click)); out.clickWorstMs = round(Math.max(...times.click));
    if (times.wheel.length) { out.wheelMs = round(median(times.wheel)); out.wheelWorstMs = round(Math.max(...times.wheel)); }
    await context.close();
    return out;
  },

  async lights(profile) {
    const { page, context } = await open(profile, async (s, syn, p, L, box) => {
      p.env.time = 22.5;
      for (let i = 0; i < 24; i++) box((i % 6) * 3, Math.floor(i / 6) * 3, (i % 6) * 3 + 3, Math.floor(i / 6) * 3 + 3, 'room-' + i);
    });
    const out = await page.evaluate(async () => {
      const v = await import('/js/viewer3d.js');
      const gl = document.querySelector('canvas.v-canvas').getContext('webgl2'), px = new Uint8Array(4);
      const frame = () => { const t = performance.now(); v.drawStats(); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); return performance.now() - t; };
      for (let i = 0; i < 3; i++) frame();
      const times = []; for (let i = 0; i < 15; i++) times.push(frame());
      times.sort((a, b) => a - b);
      return { frameMs: times[7], worstMs: times[14], state: v.qualityState ? v.qualityState() : null };
    });
    const result = { rooms: 24, frameMs: round(out.frameMs), worstFrameMs: round(out.worstMs), roomLights: out.state && out.state.roomLights !== undefined ? out.state.roomLights : 'not reported by this checkout (one per room: 24)' };
    await context.close();
    return result;
  },

  async room(profile) {
    const { page, context } = await open(profile, async (s, syn, p, L, box) => { box(0, 0, 6, 4, 'room'); });
    await page.evaluate(async () => {
      const THREE = await import('three');
      window.__bakes = { count: 0, ms: 0 };
      for (const name of ['fromScene', 'fromEquirectangular']) {
        const real = THREE.PMREMGenerator.prototype[name];
        THREE.PMREMGenerator.prototype[name] = function () { const t = performance.now(); try { return real.apply(this, arguments); } finally { window.__bakes.count++; window.__bakes.ms += performance.now() - t; } };
      }
    });
    // Walk into the room and orbit back out, five times.
    for (let i = 0; i < 5; i++) {
      await viewer(page, 'v.fieldAction("mode", "walk")'); await delay(500); await settled(page);
      await viewer(page, 'v.fieldAction("mode", "orbit")'); await delay(500); await settled(page);
    }
    const out = await page.evaluate(() => window.__bakes);
    await context.close();
    return { roomEntriesAndExits: 10, skyBakes: out.count, pageMsBaking: round(out.ms) };
  },

  async textures(profile) {
    const gaps = async page => page.evaluate(() => { window.__gap = { worst: 0, last: performance.now(), stop: false }; const tick = () => { const n = performance.now(); window.__gap.worst = Math.max(window.__gap.worst, n - window.__gap.last); window.__gap.last = n; if (!window.__gap.stop) requestAnimationFrame(tick); }; requestAnimationFrame(tick); });
    const { page, context, openMs } = await open(profile, async (s, syn, p, L, box) => {
      const mats = ['mat-oak', 'mat-walnut', 'mat-tile-f', 'mat-concrete', 'mat-carpet', 'mat-brick', 'mat-cmu', 'mat-cedar', 'mat-fiber', 'mat-tile-w', 'mat-plaster', 'mat-drywall'];
      mats.forEach((m, i) => box((i % 4) * 4, Math.floor(i / 4) * 4, (i % 4) * 4 + 4, Math.floor(i / 4) * 4 + 4, 'room-' + i, m));
      p.walls.forEach((w, i) => { w.material = ['mat-drywall', 'mat-plaster', 'mat-brick', 'mat-cmu', 'mat-cedar', 'mat-fiber', 'mat-tile-w'][i % 7]; });
    }, null, gaps);
    const out = await page.evaluate(async () => {
      window.__gap.stop = true;
      const t = await import('/js/textures.js');
      const stats = t.textureStats();
      return { sets: stats.length, pageMs: stats.reduce((n, e) => n + (e.cpuMs || 0), 0), helperMs: stats.reduce((n, e) => n + (e.workerMs || 0), 0), largest: Math.max(...stats.map(e => e.res)), worstGapMs: window.__gap.worst };
    });
    await context.close();
    return { textureSets: out.sets, largestTexture: out.largest, pageMsMakingTextures: round(out.pageMs), helperMsMakingTextures: round(out.helperMs), worstFrameGapMs: round(out.worstGapMs), openToSettledMs: openMs };
  },

  async hover(profile) {
    if (profile !== 'computer') return { skipped: 'hover and Shift-click are computer input' };
    const { page, context } = await open(profile, async (s, syn, p, L, box) => {
      box(0, 0, 6, 4, 'room');
      const { glb } = syn.wineCellar({ parts: 3000, looks: 35, bottles: 300, seg: 1 });
      await s.putFile('scan-cellar', glb.buffer, { format: 'glb' });
      p.scans.push({ id: 'scan-cellar', name: 'Cellar.glb', format: 'glb', kind: 'mesh', pos: [12, 0, 0], rot: [0, 0, 0], rotY: 0, scale: 1, visible: true });
    });
    // Frame the model, then pick forty of its parts by Shift-click across the middle of the view.
    // Every pick redoes the selection's outline: the page looks up each selected part again.
    await page.locator('#side [data-scan="scan-cellar"]').click();
    await page.locator('.inspector [data-frame]').click();
    await delay(1200); await settled(page);
    await page.keyboard.press('Escape');
    const view = page.viewportSize();
    await page.evaluate(() => window.__handled.pointerup.splice(0));
    for (let i = 0; i < 40; i++) await page.mouse.click(view.width * 0.3 + (i % 8) * 34, view.height * 0.35 + Math.floor(i / 8) * 40, { modifiers: i ? ['Shift'] : [] });
    const times = await page.evaluate(() => window.__handled.pointerup.splice(0));
    step('click times: ' + JSON.stringify(times.map(t => Math.round(t))));
    const summary = (await page.locator('.inspector').innerText()).replace(/\s+/g, ' ').slice(0, 60);
    // With those parts selected, hover on and off a wall of the plan: each change redoes the outlines.
    await viewer(page, 'v.fieldAction("camera", "frame")'); await delay(1200); await settled(page);
    const [wx, wy] = await onScreen(page, [3, 1.2, 4.08]);
    await page.evaluate(() => window.__hoverMs.splice(0));
    for (let i = 0; i < 24; i++) { await page.mouse.move(i % 2 ? 40 + i : wx, i % 2 ? 30 : wy); await delay(60); }
    const hovers = (await page.evaluate(() => window.__hoverMs.splice(0))).sort((a, b) => a - b);
    // The lookup an outline update does for each selected part, for 300 selected parts of this
    // model: listing the model's parts again for every key (as it was done), and one list per
    // model kept as a lookup (as it is done now). The same two ways on any checkout.
    const lookup = await page.evaluate(async () => {
      const sc = await import('/js/scans.js'), ts = await import('/js/tags-scene.js'), s = await import('/js/store.js');
      const scan = s.activeProperty().scans[0];
      const wrapper = await sc.loadScanObject(scan, null);
      const keys = ts.modelParts(wrapper).filter((p, i) => i % 10 === 0).slice(0, 300).map(p => ts.partKey(scan.id, p));
      let t = performance.now(), found = 0;
      for (const key of keys) if (ts.partByKey(wrapper, key)) found++;
      const everyTime = performance.now() - t;
      t = performance.now();
      const byKey = new Map();
      for (const part of ts.modelParts(wrapper)) byKey.set(ts.partKey(scan.id, part), part);
      const first = performance.now() - t;
      t = performance.now();
      for (const key of keys) if (byKey.get(key)) found++;
      const later = performance.now() - t;
      sc.disposeScanObject(wrapper);
      return { selected: keys.length, found, everyTime, first, later };
    });
    await context.close();
    return { parts: 3000, shiftClicks: 40, clicksMsTotal: round(times.reduce((n, t) => n + t, 0)), hovers: hovers.length, hoverMs: round(median(hovers)), hoverWorstMs: round(hovers[hovers.length - 1]), inspectorSays: summary,
      outlineLookup: { selectedParts: lookup.selected, listingEveryPartPerKeyMs: round(lookup.everyTime), oneLookupFirstUpdateMs: round(lookup.first), oneLookupLaterUpdatesMs: round(lookup.later) } };
  },

  async pins(profile) {
    const { page, context, openMs } = await open(profile, async (s, syn, p, L, box) => {
      box(0, 0, 8, 5, 'room');
      const canvas = document.createElement('canvas'); canvas.width = 4000; canvas.height = 3000;
      const ctx = canvas.getContext('2d');
      const photos = await import('/js/photos-store.js');
      for (let i = 0; i < 12; i++) {
        const g = ctx.createLinearGradient(0, 0, 4000, 3000); g.addColorStop(0, 'hsl(' + i * 30 + ' 60% 55%)'); g.addColorStop(1, '#223');
        ctx.fillStyle = g; ctx.fillRect(0, 0, 4000, 3000);
        const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.85));
        const rec = await photos.addPhotoFromFile(p, new File([blob], 'Site ' + (i + 1) + '.jpg', { type: 'image/jpeg' }));
        rec.pin = { x: 0.5 + i * 0.6, y: 1.5, z: 0.07, nx: 0, ny: 0, nz: 1 };
      }
      window.__perf.decodes.length = 0;
    });
    await delay(1500); await settled(page);
    const out = await page.evaluate(async () => {
      const d = window.__perf.decodes;
      const s = await import('/js/store.js');
      return { full: d.filter(n => n >= 3000).length, all: d.length, pinned: s.activeProperty().photos.filter(p => p.pin).length };
    });
    await context.close();
    return { pinnedPhotos: out.pinned, fullSizeDecodes: out.full, picturesDecoded: out.all, openToSettledMs: openMs };
  },

  async idle(profile) {
    const { page, context } = await open(profile, async (s, syn, p, L, box) => { box(0, 0, 6, 4, 'room'); });
    const out = await page.evaluate(async () => {
      const start = window.__perf.draws; let frames = 0, stop = false;
      const count = () => { frames++; if (!stop) requestAnimationFrame(count); };
      requestAnimationFrame(count);
      await new Promise(r => setTimeout(r, 2500)); stop = true;
      return { offeredFrames: frames, drawCalls: window.__perf.draws - start };
    });
    await context.close();
    return out;
  },
};

const only = args.only ? args.only.split(',') : Object.keys(scenarios);
const results = { root, gpu: args.gpu };
try {
  for (const name of only) {
    if (!scenarios[name]) throw new Error('Unknown scenario ' + name);
    results[name] = {};
    for (const profile of ['computer', 'phone']) {
      try { results[name][profile] = await scenarios[name](profile); }
      catch (e) { results[name][profile] = { failed: String(e && e.message || e).slice(0, 300) }; }
      console.error(name + ' / ' + profile + ': ' + JSON.stringify(results[name][profile]));   // progress, as it goes
    }
  }
} finally {
  await browser.close();
  await new Promise(r => server.close(r));
}
console.log(JSON.stringify(results, null, 1));
