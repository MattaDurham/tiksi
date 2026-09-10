#!/usr/bin/env node
// End-to-end check of the share-link flow in a headless browser, against a mock of a
// Polycam share page so the run is deterministic and offline:
//
//   open     the mock allows cross-origin reads: link -> page -> model -> plan, all direct
//   relay    the mock refuses them: the browser falls back to a (local) relay
//   blocked  no relay: the property is made, the dialog offers the drop zone, a file is
//            dropped, the plan follows
//   deeplink #/import?url=... starts the import by itself
//
// Needs Playwright with Chromium (npx playwright install chromium). Serves the repo root on
// one port and the mock on another. Writes screenshots next to the fixtures.
//
//   node tools/fixture-room.mjs && node tools/e2e-polycam.mjs [--headed] [--keep]

import http from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outDir = process.env.E2E_OUT || resolve(here, 'fixtures');
const APP_PORT = +(process.env.E2E_APP_PORT || 8642), MOCK_PORT = +(process.env.E2E_MOCK_PORT || 8765);
const CAPTURE_ID = '4da2d2eb-5187-4aa3-8822-137e3db8acc4';
const headed = process.argv.includes('--headed');

let chromium;
try { ({ chromium } = await import('playwright')); }
catch (e) { ({ chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright/index.mjs')); }

const glbPath = resolve(here, 'fixtures/room.glb');
if (!existsSync(glbPath)) { console.error('fixture missing: run node tools/fixture-room.mjs first'); process.exit(2); }
const glb = readFileSync(glbPath);

// ---------- tiny PNG for the cover image ----------
function png(w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = 232 * x / w; raw[o + 1] = 151 * y / h; raw[o + 2] = 58; } }
  const crcTable = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable.push(c >>> 0); }
  const crc = b => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const cover = png(96, 72);

// ---------- servers ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.glb': 'model/gltf-binary', '.wasm': 'application/wasm' };
const appServer = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let file = resolve(root, '.' + decodeURIComponent(url.pathname));
  if (url.pathname === '/') file = resolve(root, 'index.html');
  if (!file.startsWith(root) || !existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
});

const mock = { cors: true, hits: [] };
const mockServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  mock.hits.push(url.pathname);
  const cors = h => Object.assign(h, { 'cache-control': 'no-store' }, mock.cors ? { 'access-control-allow-origin': '*' } : {});
  if (url.pathname === '/relay') {
    // A relay is a fetch on the user's behalf plus the missing permission header.
    const target = url.searchParams.get('url') || '';
    try {
      const r = await fetch(target);
      const buf = Buffer.from(await r.arrayBuffer());
      res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/octet-stream', 'access-control-allow-origin': '*' });
      res.end(buf);
    } catch (e) { res.writeHead(502, { 'access-control-allow-origin': '*' }); res.end(String(e)); }
    return;
  }
  if (url.pathname === '/capture/' + CAPTURE_ID) {
    const base = 'http://127.0.0.1:' + MOCK_PORT;
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Living room and bedroom | Polycam</title>
<meta property="og:title" content="Living room and bedroom"><meta property="og:description" content="LiDAR capture, 2 rooms">
<meta property="og:image" content="${base}/cover.png"><link rel="preload" as="fetch" href="${base}/files/thumb.png">
</head><body><div id="__next"></div>
<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"capture":{"id":"${CAPTURE_ID}","name":"Living room and bedroom","captureMode":"lidar","assets":{"thumbnailUrl":"${base}\\u002fcover.png","glbUrl":"${base}\\u002ffiles\\u002f${CAPTURE_ID}-textured.glb?sig=abc"}}}}}</script>
</body></html>`;
    res.writeHead(200, cors({ 'content-type': 'text/html; charset=utf-8' }));
    res.end(html);
    return;
  }
  if (url.pathname === '/capture/' + CAPTURE_ID + '/embed') { res.writeHead(200, cors({ 'content-type': 'text/html' })); res.end('<!doctype html><body style="background:#111;color:#888;font:12px sans-serif;display:grid;place-items:center;height:100vh;margin:0">embedded viewer (mock)</body>'); return; }
  if (url.pathname.startsWith('/files/') && url.pathname.endsWith('.glb')) { res.writeHead(200, cors({ 'content-type': 'model/gltf-binary', 'content-length': glb.length })); res.end(glb); return; }
  if (url.pathname === '/cover.png') { res.writeHead(200, cors({ 'content-type': 'image/png' })); res.end(cover); return; }
  res.writeHead(404, cors({})); res.end('nope');
});
await new Promise(r => appServer.listen(APP_PORT, '127.0.0.1', r));
await new Promise(r => mockServer.listen(MOCK_PORT, '127.0.0.1', r));

const APP = 'http://127.0.0.1:' + APP_PORT + '/';
const LINK = 'http://127.0.0.1:' + MOCK_PORT + '/capture/' + CAPTURE_ID;
const RELAY = 'http://127.0.0.1:' + MOCK_PORT + '/relay?url={url}';

// ---------- browser ----------
const browser = await chromium.launch({ headless: !headed, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];
let context = null, page = null;

const failures = [];
const check = (ok, msg) => { if (ok) console.log('  ok   ' + msg); else { failures.push(msg); console.log('  FAIL ' + msg); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// A new browser context per scenario: its own localStorage, IndexedDB and HTTP cache, so
// nothing from the previous scenario (a saved property, a cached CORS header) leaks in.
async function freshApp() {
  if (context) await context.close();
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  page = await context.newPage();
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(APP + '#/plan', { waitUntil: 'load' });
  await page.waitForSelector('#property-select option', { state: 'attached' });
}
async function workspace() {
  await sleep(900);   // autosave debounce
  return page.evaluate(() => JSON.parse(localStorage.getItem('tiksi.workspace.v1')));
}
function findProp(ws) { return ws.properties.find(p => p.source && p.source.captureId === CAPTURE_ID); }
function assertPlan(prop, tag) {
  check(!!prop, tag + ': property with the Polycam source exists');
  if (!prop) return;
  check(prop.name === 'Living room and bedroom' || prop.name.startsWith('Polycam'), tag + ': named from the page (' + prop.name + ')');
  check(prop.scans.length === 1 && prop.scans[0].kind === 'mesh', tag + ': one mesh scan');
  if (!prop.scans.length) return;
  const lvl = prop.levels && prop.levels[0];
  check(!!prop.levels && prop.levels.length === 1, tag + ': one level (' + (prop.levels ? prop.levels.length : 'none') + ')');
  check(!!lvl && Math.abs(lvl.height - 2.55) < 0.08, tag + ': ceiling height ' + (lvl ? lvl.height.toFixed(2) : '-') + ' m (expected 2.55)');
  check(prop.walls.length >= 5 && prop.walls.length <= 7, tag + ': ' + prop.walls.length + ' walls (expected 5)');
  check(prop.rooms.length === 2, tag + ': ' + prop.rooms.length + ' rooms (expected 2)');
  const doors = prop.openings.filter(o => o.type === 'door').length, wins = prop.openings.filter(o => o.type === 'window').length;
  check(doors >= 2, tag + ': ' + doors + ' doors (expected 2)');
  check(wins >= 3, tag + ': ' + wins + ' windows (expected 3)');
  const thick = prop.walls.filter(w => w.thickness > 0.1 && w.thickness < 0.15);
  check(prop.walls.some(w => Math.abs(w.thickness - 0.12) < 0.04), tag + ': the partition measured ~12 cm (' + prop.walls.map(w => w.thickness.toFixed(3)).join(', ') + ')');
  const areas = prop.rooms.map(r => { let s = 0; for (let i = 0; i < r.pts.length; i++) { const [x1, y1] = r.pts[i], [x2, y2] = r.pts[(i + 1) % r.pts.length]; s += x1 * y2 - x2 * y1; } return Math.abs(s) / 2; }).sort((a, b) => b - a);
  check(areas[0] > 19 && areas[0] < 24 && areas[1] > 12 && areas[1] < 16, tag + ': room areas ' + areas.map(a => a.toFixed(1)).join(', ') + ' m2 (expected ~21.9, ~14.4)');
  check(!!lvl && lvl.plan && lvl.plan.calibrated && lvl.plan.img && lvl.plan.img.length > 2000, tag + ': calibrated underlay rendered (' + (lvl && lvl.plan ? Math.round(lvl.plan.img.length / 1024) + ' KB' : 'none') + ')');
  check(prop.walls.every(w => w.level === (lvl && lvl.id)) && prop.rooms.every(r => r.level === (lvl && lvl.id)), tag + ': walls and rooms carry the level id');
  check(Math.abs(((prop.scans[0].rot[1] % 90) + 90) % 90 - 17) < 1.5 || Math.abs(((prop.scans[0].rot[1] % 90) + 90) % 90 - 73) < 1.5, tag + ': scan squared up (rotY ' + prop.scans[0].rot[1] + ')');
  check(Math.abs(prop.scans[0].pos[1] + 0.12) < 0.03, tag + ': floor lifted to y = 0 (pos.y ' + prop.scans[0].pos[1] + ')');
  void thick;
}
async function runDialog(link, opts) {
  await page.click('#property-new');
  await page.waitForSelector('#np-dialog [data-np-input]');
  if (opts && opts.relay === false) await page.uncheck('#np-dialog [data-np-relay]');
  else if (opts && opts.relay) {
    await page.check('#np-dialog [data-np-relay]');
    if (!(await page.$('#np-dialog .np-adv[open]'))) await page.click('#np-dialog .np-adv summary');
    await page.fill('#np-dialog [data-np-relay-url]', opts.relay);
    await page.dispatchEvent('#np-dialog [data-np-relay-url]', 'change');
  }
  await page.fill('#np-dialog [data-np-input]', link);
  await page.click('#np-dialog [data-np-create]');
}
async function waitState(states, ms) {
  await page.waitForFunction(s => { const d = document.getElementById('np-dialog'); return d && s.includes(d.dataset.state); }, states, { timeout: ms || 120000 });
  return page.evaluate(() => document.getElementById('np-dialog').dataset.state);
}
async function logText() { return page.evaluate(() => Array.from(document.querySelectorAll('#np-dialog .np-step')).map(li => li.textContent.trim().replace(/\s+/g, ' ')).join('\n')); }

try {
  // ---- open ----
  console.log('\n[open] direct cross-origin reads allowed');
  mock.cors = true;
  await freshApp();
  await runDialog(LINK);
  let state = await waitState(['done', 'blocked', 'failed']);
  console.log((await logText()).split('\n').map(l => '       ' + l).join('\n'));
  check(state === 'done', 'open: finished (' + state + ')');
  let ws = await workspace();
  let prop = findProp(ws);
  assertPlan(prop, 'open');
  check(prop && prop.photos.length === 1, 'open: cover photo kept');
  check(ws.projects.some(p => prop && p.propertyId === prop.id && p.items.length >= 3), 'open: starter project seeded with takeoffs');
  check(!mock.hits.includes('/relay'), 'open: no relay used');

  // Screenshots of the result.
  await page.click('#np-dialog [data-np-go="plan"]');
  await sleep(1500);
  mkdirSync(outDir, { recursive: true });
  await page.screenshot({ path: resolve(outDir, 'e2e-plan.png') });
  await page.goto(APP + '#/model');
  await sleep(9000);
  await page.screenshot({ path: resolve(outDir, 'e2e-model.png') });
  await page.goto(APP + '#/projects');
  await sleep(800);
  await page.screenshot({ path: resolve(outDir, 'e2e-projects.png') });
  await page.goto(APP + '#/sheets');
  await sleep(800);
  await page.screenshot({ path: resolve(outDir, 'e2e-sheets.png') });
  const underlay = prop && prop.levels && prop.levels[0].plan && prop.levels[0].plan.img;
  if (underlay) writeFileSync(resolve(outDir, 'e2e-underlay.' + (underlay.startsWith('data:image/webp') ? 'webp' : 'jpg')), Buffer.from(underlay.split(',')[1], 'base64'));

  // ---- relay ----
  console.log('\n[relay] cross-origin reads refused, local relay allowed');
  mock.cors = false; mock.hits.length = 0;
  await freshApp();
  await runDialog(LINK, { relay: RELAY });
  state = await waitState(['done', 'blocked', 'failed']);
  console.log((await logText()).split('\n').map(l => '       ' + l).join('\n'));
  check(state === 'done', 'relay: finished (' + state + ')');
  check(mock.hits.includes('/relay'), 'relay: relay was used');
  ws = await workspace(); prop = findProp(ws);
  assertPlan(prop, 'relay');
  await page.click('#np-dialog [data-np-cancel]');

  // ---- blocked ----
  console.log('\n[blocked] cross-origin reads refused, relay off: drop the file');
  mock.cors = false; mock.hits.length = 0;
  await freshApp();
  await runDialog(LINK, { relay: false });
  state = await waitState(['done', 'blocked', 'failed']);
  check(state === 'blocked', 'blocked: dialog offers the drop zone (' + state + ')');
  ws = await workspace(); prop = findProp(ws);
  check(!!prop && prop.source.status === 'blocked' && prop.scans.length === 0, 'blocked: property exists without a scan');
  await page.screenshot({ path: resolve(outDir, 'e2e-blocked.png') });
  await page.setInputFiles('#np-dialog [data-np-file]', glbPath);
  state = await waitState(['done', 'failed']);
  console.log((await logText()).split('\n').map(l => '       ' + l).join('\n'));
  check(state === 'done', 'blocked: finished after the drop (' + state + ')');
  ws = await workspace(); prop = findProp(ws);
  assertPlan(prop, 'blocked');
  check(prop && prop.source.status === 'resolved', 'blocked: source marked resolved');
  await page.click('#np-dialog [data-np-cancel]');

  // ---- deep link ----
  console.log('\n[deeplink] #/import?url=');
  mock.cors = true;
  await freshApp();
  await page.goto(APP + '#/import?url=' + encodeURIComponent(LINK));
  state = await waitState(['done', 'blocked', 'failed']);
  check(state === 'done', 'deeplink: finished (' + state + ')');
  check((await page.evaluate(() => location.hash)) === '#/plan', 'deeplink: hash consumed');
  ws = await workspace(); prop = findProp(ws);
  check(!!prop && prop.walls.length >= 5, 'deeplink: plan proposed');
  // A second visit of the same link reuses the property instead of duplicating it.
  await page.click('#np-dialog [data-np-cancel]');
  await page.goto(APP + '#/import?url=' + encodeURIComponent(LINK));
  state = await waitState(['done', 'blocked', 'failed']);
  ws = await workspace();
  check(ws.properties.filter(p => p.source && p.source.captureId === CAPTURE_ID).length === 1, 'deeplink: same link twice keeps one property');

  // ---- re-propose from the model view ----
  console.log('\n[viewer] PROPOSE PLAN FROM SCAN on the existing scan');
  await page.click('#np-dialog [data-np-cancel]');
  page.once('dialog', d => d.accept());
  await page.goto(APP + '#/model');
  await page.waitForSelector('.v-scan-row', { timeout: 60000 });
  await page.waitForFunction(() => { const k = document.querySelector('.v-scan-row .key'); return k && k.textContent.trim() === 'MESH'; }, null, { timeout: 60000 });
  await page.click('.v-scan-row');
  await page.click('.inspector [data-plan]');
  await page.waitForFunction(() => /Proposed:/.test((document.querySelector('.v-toast') || {}).textContent || ''), null, { timeout: 120000 });
  const toast = await page.evaluate(() => document.querySelector('.v-toast').textContent);
  console.log('       ' + toast);
  check(/5 walls|6 walls|7 walls/.test(toast) && /2 rooms/.test(toast), 'viewer: re-proposal matches');

  // ---- every view still mounts on the new property ----
  console.log('\n[views] every view mounts on the property');
  const before = errors.filter(e => e.startsWith('pageerror')).length;
  for (const v of ['plan', 'materials', 'photos', 'projects', 'products', 'budget', 'schedule', 'sheets', 'model']) {
    await page.goto(APP + '#/' + v);
    await sleep(v === 'model' ? 3000 : 500);
  }
  const after = errors.filter(e => e.startsWith('pageerror')).length;
  check(after === before, 'views: no uncaught errors while mounting every view (' + (after - before) + ')');
} catch (e) {
  failures.push('exception: ' + (e && e.stack || e));
  console.error(e);
  try { if (page) await page.screenshot({ path: resolve(outDir, 'e2e-failure.png') }); } catch (e2) { /* nothing */ }
}

const realErrors = errors.filter(e => !/favicon|net::ERR_FAILED|Failed to load resource|CORS|Access to fetch|blocked by CORS|WebGL|GPU|GroupMarkerNotSet|swiftshader/i.test(e));
if (realErrors.length) { console.log('\nbrowser errors:'); for (const e of realErrors) console.log('  ' + e); }
for (const e of realErrors) if (e.startsWith('pageerror')) failures.push(e);
console.log('\n' + (failures.length ? failures.length + ' FAILURE(S):\n  ' + failures.join('\n  ') : 'ALL CHECKS PASSED'));
if (!process.argv.includes('--keep')) { await browser.close(); appServer.close(); mockServer.close(); }
process.exit(failures.length ? 1 : 0);
