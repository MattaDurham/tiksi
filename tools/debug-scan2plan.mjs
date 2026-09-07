#!/usr/bin/env node
// Runs the scan-to-plan analysis on a mesh file inside headless Chromium (the module needs
// three.js and WebGL) and prints the proposal as JSON: transform, walls, rooms, openings.
//
//   node tools/debug-scan2plan.mjs [path/to/scan.glb] [--underlay out.webp]

import http from 'node:http';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, resolve, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const args = process.argv.slice(2);
const file = resolve(args.find(a => !a.startsWith('--')) || resolve(here, 'fixtures/room.glb'));
const underlayOut = args.includes('--underlay') ? args[args.indexOf('--underlay') + 1] : null;
if (!existsSync(file)) { console.error('no such file: ' + file); process.exit(2); }

let chromium;
try { ({ chromium } = await import('playwright')); }
catch (e) { ({ chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright/index.mjs')); }

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.glb': 'model/gltf-binary' };
const bytes = readFileSync(file);
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/__scan') { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(bytes); return; }
  let f = resolve(root, '.' + decodeURIComponent(url.pathname));
  if (url.pathname === '/') f = resolve(root, 'index.html');
  if (!f.startsWith(root) || !existsSync(f)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
page.on('pageerror', e => console.error('pageerror', e.message));
await page.goto('http://127.0.0.1:' + port + '/#/plan', { waitUntil: 'load' });
const out = await page.evaluate(async ({ ext, wantUnderlay }) => {
  const s2p = await import('./js/scan2plan.js');
  const scans = await import('./js/scans.js');
  const buf = await (await fetch('/__scan')).arrayBuffer();
  const t0 = performance.now();
  const obj = await scans.loadMesh(buf, ext);
  const t1 = performance.now();
  const r = await s2p.analyseMesh(obj, null);
  const t2 = performance.now();
  let underlay = null;
  if (wantUnderlay && r) { const u = s2p.underlayFor(obj, r); underlay = u.img; r.underlay = { w: u.imgW, h: u.imgH, mPerPx: u.mPerPx, offsetX: u.offsetX, offsetY: u.offsetY }; }
  if (!r) return { error: 'no floor found' };
  return { parseMs: Math.round(t1 - t0), analyseMs: Math.round(t2 - t1), underlay, result: r };
}, { ext: extname(file).slice(1).toLowerCase(), wantUnderlay: !!underlayOut });
await browser.close();
server.close();
if (out.error) { console.error(out.error); process.exit(1); }
if (underlayOut && out.underlay) writeFileSync(underlayOut, Buffer.from(out.underlay.split(',')[1], 'base64'));
const r = out.result;
const area = pts => { let s = 0; for (let i = 0; i < pts.length; i++) { const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length]; s += x1 * y2 - x2 * y1; } return Math.abs(s) / 2; };
console.log(basename(file) + ': ' + r.triangles.toLocaleString() + ' triangles, parsed in ' + out.parseMs + ' ms, analysed in ' + out.analyseMs + ' ms');
console.log('floor y ' + r.floorY.toFixed(3) + ', ceiling ' + (r.ceilingY == null ? 'none' : r.ceilingY.toFixed(3)) + ', wall height ' + r.wallHeight + ', floor area ' + r.floorArea.toFixed(1) + ' m2, room-like: ' + r.roomLike);
console.log('angle ' + (r.angle * 180 / Math.PI).toFixed(2) + ' deg (rectilinear ' + (r.rectilinear * 100).toFixed(0) + '%), transform ' + JSON.stringify(r.transform) + ', bounds ' + JSON.stringify(r.bounds));
console.log('\nwalls (' + r.walls.length + '):');
for (const w of r.walls) console.log('  ' + w.axis + ' c=' + w.c.toFixed(3) + ' s=' + w.s0.toFixed(2) + '..' + w.s1.toFixed(2) + ' (' + (w.s1 - w.s0).toFixed(2) + ' m) t=' + w.thickness + (w.paired ? ' paired' : ' single, interior ' + w.interior) + ' faces=' + w.faces.map(f => f.toFixed(3)).join('/'));
console.log('\nrooms (' + r.rooms.length + '):');
for (const rm of r.rooms) console.log('  ' + area(rm.pts).toFixed(2) + ' m2 (' + rm.area.toFixed(2) + ' m2 of floor) ' + JSON.stringify(rm.pts));
console.log('\nopenings (' + r.openings.length + '):');
for (const o of r.openings) console.log('  ' + o.type + ' on wall ' + o.wall + ' t=' + o.t.toFixed(3) + ' w=' + o.width + ' h=' + o.height + (o.sill != null ? ' sill=' + o.sill : ''));
