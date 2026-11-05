// Measure what one edit costs on a disk-backed Tiksi: main-thread long tasks
// (PerformanceObserver 'longtask') and the bytes each save sends and receives.
// The workspace is synthetic and shaped like a large real one: 14 floor-plan
// underlays of up to ~1.5 MB, 289 photo thumbnails of ~35 KB and five projects
// with ordinary plan, room and scope records. Run it against a preview that has
// a fresh, temporary state directory, never against the live app:
//
//   scripts/branch.sh serve <slug> --fresh --local
//   node tools/measure-save.mjs --url http://localhost:8643 [--edits 5] [--idle 25] [--out result.json]
//
// --idle N also records N seconds of an idle page with the SketchUp mirror on.
import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : fallback; };
for (let i = 0; i < args.length; i += 2) if (!['--url', '--edits', '--idle', '--out'].includes(args[i])) throw new Error('Unknown option ' + args[i]);
const url = option('url');
if (!url) throw new Error('--url is required');
const port = Number(new URL(url).port);
if (port === 8642) throw new Error('Port 8642 is the live app; measure a preview instead');
const edits = Number(option('edits', 5)), idle = Number(option('idle', 0)), out = option('out');

// Runs in the page: builds the synthetic workspace with real, decodable images.
async function buildSynthetic() {
  const s = await import('/js/store.js');
  let seed = 7;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  function noise(w, h, type, quality) {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d'), img = g.createImageData(w, h);
    for (let i = 0; i < img.data.length; i += 4) { img.data[i] = rand() * 255; img.data[i + 1] = rand() * 255; img.data[i + 2] = rand() * 255; img.data[i + 3] = 255; }
    g.putImageData(img, 0, 0);
    return c.toDataURL(type, quality);
  }
  // Plans 0.6-1.5 MB of data URL each (about 13 MB in all); thumbnails about 35 KB.
  const planSides = [610, 600, 560, 520, 500, 480, 470, 460, 440, 420, 400, 390, 380, 360];
  const plans = planSides.map(w => noise(w, w, 'image/png'));
  const thumbs = [];
  for (let i = 0; i < 289; i++) thumbs.push(noise(200 + (i % 5), 150, 'image/jpeg', 0.8));
  const data = s.emptyWorkspace();
  data.settings.sketchupMirror = false;
  const names = ['Synthetic townhouse', 'Synthetic cottage', 'Synthetic condo', 'Synthetic loft', 'Synthetic garden flat'];
  const photoSplit = [120, 70, 50, 30, 19], levelSplit = [5, 3, 3, 2, 1];
  let photo = 0, plan = 0;
  names.forEach((name, n) => {
    const p = s.propertyTemplate(name); p.id = 'prop-synth-' + n;
    p.levels = [];
    for (let l = 0; l < levelSplit[n]; l++) {
      p.levels.push({ id: 'lvl-' + l, name: 'Level ' + l, elevation: l * 3, height: 2.7,
        plan: { img: plans[plan++], imgW: 600, imgH: 600, mPerPx: 0.02, offsetX: 0, offsetY: 0, opacity: 0.6, calibrated: true, source: 'image' } });
    }
    p.activeLevelId = 'lvl-0';
    for (let w = 0; w < 600; w++) {
      const level = 'lvl-' + (w % levelSplit[n]);
      p.walls.push({ id: 'w-' + n + '-' + w, level, ax: rand() * 20, ay: rand() * 20, bx: rand() * 20, by: rand() * 20, thickness: 0.114, height: null, material: 'mat-drywall' });
    }
    for (let r = 0; r < 60; r++) p.rooms.push({ id: 'r-' + n + '-' + r, level: 'lvl-0', name: 'Room ' + r, pts: [[0, 0], [rand() * 5, 0], [rand() * 5, rand() * 5], [0, rand() * 5]], material: 'mat-oak', ceilingMaterial: null });
    for (let i = 0; i < photoSplit[n]; i++, photo++) {
      p.photos.push({ id: 'ph-synth-' + photo, name: 'Synthetic photo ' + photo + '.jpg', thumb: thumbs[photo], w: 4032, h: 3024, mime: 'image/jpeg', notes: 'Synthetic note ' + photo, kind: 'photo', createdAt: new Date(2026, 0, 1 + photo).toISOString() });
    }
    data.properties.push(p);
    const project = { id: 'proj-synth-' + n, propertyId: p.id, name: 'Renovation ' + n, items: [] };
    for (let i = 0; i < 250; i++) project.items.push({ id: 'it-' + n + '-' + i, name: 'Scope item ' + i, low: 100 * i, likely: 120 * i, high: 150 * i, deps: [], elementIds: ['w-' + n + '-' + i], notes: 'Synthetic scope line with a short description ' + i });
    data.projects.push(project);
  });
  data.settings.activePropertyId = 'prop-synth-0';
  s.replaceWorkspace(data);
  // Originals for every photo, so the save also carries a realistic asset manifest.
  for (const p of s.ws.data.properties) for (const ph of p.photos) {
    const bytes = await (await fetch(ph.thumb)).arrayBuffer();
    await s.putFile(ph.id, bytes, { kind: 'photo', mime: 'image/jpeg', name: ph.name });
  }
  await (await import('/js/disk-workspace.js')).diskWorkspace.sync();
  const json = JSON.stringify(s.ws.data);
  return { workspaceChars: json.length, plans: plans.reduce((n, x) => n + x.length, 0), thumbs: thumbs.reduce((n, x) => n + x.length, 0) };
}

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const result = { url, measuredAt: new Date().toISOString(), edits: [] };
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(() => {
    window.__longtasks = [];
    new PerformanceObserver(list => { for (const e of list.getEntries()) window.__longtasks.push({ start: e.startTime, duration: e.duration }); }).observe({ type: 'longtask', buffered: true });
  });
  const page = await context.newPage();
  // Each request is recorded when it starts; sizes are filled in when it finishes.
  const traffic = [];
  page.on('request', request => {
    if (!request.url().includes('/api/workspace')) return;
    const record = { at: Date.now(), method: request.method(), path: new URL(request.url()).pathname, sent: request.postDataBuffer()?.length || 0, received: 0, done: false };
    traffic.push(record);
    request.response().then(async r => { if (!r) return; const length = Number(await r.headerValue('content-length')); record.received = Number.isFinite(length) && length > 0 ? length : (await r.body()).length; }).catch(() => {}).finally(() => { record.done = true; });
  });
  page.on('requestfailed', request => { for (const r of traffic) if (r.path === new URL(request.url()).pathname) r.done = true; });
  const since = async start => { while (traffic.some(r => r.at >= start && !r.done)) await new Promise(r => setTimeout(r, 50)); return traffic.filter(r => r.at >= start); };
  // Saved means: the disk client exists, has nothing pending, shows SAVED TO DISK and
  // has finished every workspace request it started.
  const saved = async () => {
    // The predicate must be synchronous: a returned promise would count as an immediate yes.
    await page.waitForFunction(() => document.querySelector('#save-status')?.textContent === 'SAVED TO DISK', null, { timeout: 600000, polling: 100 });
    await page.evaluate(async () => { window.__disk = await import('/js/disk-workspace.js'); });
    await page.waitForFunction(() => window.__disk.diskWorkspace && !window.__disk.diskWorkspace.pending && document.querySelector('#save-status')?.textContent === 'SAVED TO DISK', null, { timeout: 600000, polling: 100 });
    await since(0);
  };
  const putAfter = start => page.waitForFunction(() => true).then(async () => { while (!traffic.some(r => r.at >= start && r.method === 'PUT' && r.path === '/api/workspace' && r.done)) await new Promise(r => setTimeout(r, 50)); });
  await page.goto(url); await saved();
  const has = await page.evaluate(async () => (await import('/js/store.js')).ws.data.properties.some(p => p.id === 'prop-synth-0'));
  if (!has) { result.seed = await page.evaluate(buildSynthetic); await saved(); }
  // A normal load of the saved workspace, then a settle period before editing.
  const loadStart = Date.now();
  await page.reload(); await page.waitForTimeout(500); await saved(); await page.waitForTimeout(3000); await saved();
  result.load = { ms: Date.now() - loadStart, note: 'includes the save the app makes on every start, and a 3.5 s settle', ...sum(await since(loadStart)) };
  // Edits are measured with the SketchUp mirror off, so its poll does not mix in.
  if (await page.evaluate(async () => { const s = await import('/js/store.js'); if (s.ws.data.settings.sketchupMirror === false) return false; s.ws.data.settings.sketchupMirror = false; s.touch(); return true; })) await saved();
  await page.waitForTimeout(3000);
  result.workspace = await page.evaluate(async () => {
    const s = await import('/js/store.js');
    return { properties: s.ws.data.properties.length, photos: s.ws.data.properties.reduce((n, p) => n + p.photos.length, 0), inMemoryChars: JSON.stringify(s.ws.data).length };
  });
  for (let i = 0; i < edits; i++) {
    const mark = await page.evaluate(() => performance.now());
    const started = Date.now();
    await page.evaluate(async n => { const s = await import('/js/store.js'); s.ws.data.properties[1].notes = 'Measured edit ' + n + ' ' + Date.now(); s.touch(); }, i);
    await putAfter(started);
    await saved();
    const savedMs = Date.now() - started;
    await page.waitForTimeout(1500);   // any trailing work after the save is acknowledged
    await saved();
    const tasks = await page.evaluate(m => window.__longtasks.filter(t => t.start >= m), mark);
    result.edits.push({ editToSavedMs: savedMs, longTasks: tasks.length, longTaskMs: Math.round(tasks.reduce((n, t) => n + t.duration, 0)), longestMs: Math.round(Math.max(0, ...tasks.map(t => t.duration))), ...sum(await since(started)) });
  }
  if (idle > 0) {
    await page.evaluate(async () => { const s = await import('/js/store.js'); s.ws.data.settings.sketchupMirror = true; s.touch(); });
    await saved(); await page.waitForTimeout(12000); await saved();
    const mark = await page.evaluate(() => performance.now()), idleStart = Date.now();
    await page.waitForTimeout(idle * 1000);
    const tasks = await page.evaluate(m => window.__longtasks.filter(t => t.start >= m), mark);
    result.idle = { seconds: idle, mirror: await page.evaluate(async () => (await (await import('/js/sketchup-mirror.js')).mirrorCapabilities()).openSketchUp === true), longTasks: tasks.length, longTaskMs: Math.round(tasks.reduce((n, t) => n + t.duration, 0)), ...sum(await since(idleStart)) };
  }
} finally { await browser.close(); }

function sum(list) {
  return { requests: list.length, sentBytes: list.reduce((n, r) => n + r.sent, 0), receivedBytes: list.reduce((n, r) => n + r.received, 0),
    calls: Object.entries(list.reduce((m, r) => { const k = r.method + ' ' + r.path.replace(/[a-f0-9]{64}/, '<hash>'); m[k] = (m[k] || 0) + 1; return m; }, {})).map(([k, n]) => n + 'x ' + k).join(', ') };
}
console.log(JSON.stringify(result, null, 1));
if (out) await writeFile(out, JSON.stringify(result, null, 1));
