#!/usr/bin/env node
// Runs the scan-to-plan core on a mesh file in plain Node (no browser, no three.js) and
// prints the proposal per level: walls, rooms, openings. GLB (binary glTF) or .gltf with
// its .bin next to it.
//
//   node tools/debug-scan2plan.mjs [path/to/scan.glb] [--json out.json]

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanToPlan, gltfToMesh } from '../js/scan2plan-core.js';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const file = resolve(args.find(a => !a.startsWith('--')) || resolve(here, 'fixtures/room.glb'));
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
if (!existsSync(file)) { console.error('no such file: ' + file + (file.endsWith('room.glb') ? ' (run node tools/fixture-room.mjs first)' : '')); process.exit(2); }

function loadGlb(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, true) !== 0x46546C67) throw new Error('not a GLB');
  let p = 12, json = null, bin = null;
  while (p < buf.byteLength) {
    const len = dv.getUint32(p, true), type = dv.getUint32(p + 4, true);
    const chunk = buf.subarray(p + 8, p + 8 + len);
    if (type === 0x4E4F534A) json = JSON.parse(new TextDecoder().decode(chunk));
    else if (type === 0x004E4942) bin = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
    p += 8 + len;
  }
  return { gltf: json, buffers: [bin] };
}
function loadGltf(path) {
  const gltf = JSON.parse(readFileSync(path, 'utf8'));
  const buffers = gltf.buffers.map(b => { const bb = readFileSync(resolve(dirname(path), b.uri)); return bb.buffer.slice(bb.byteOffset, bb.byteOffset + bb.byteLength); });
  return { gltf, buffers };
}

const t0 = Date.now();
const src = /\.gltf$/i.test(file) ? loadGltf(file) : loadGlb(readFileSync(file));
const { pos, idx } = gltfToMesh(src.gltf, src.buffers);
const t1 = Date.now();
const r = scanToPlan(pos, idx, {});
const t2 = Date.now();

const area = pts => { let s = 0; for (let i = 0; i < pts.length; i++) { const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length]; s += x1 * y2 - x2 * y1; } return Math.abs(s) / 2; };
console.log(file.split('/').pop() + ': ' + (idx.length / 3).toLocaleString() + ' triangles, read in ' + (t1 - t0) + ' ms, analysed in ' + (t2 - t1) + ' ms');
console.log('rotation ' + r.rotationDeg.toFixed(2) + ' deg (' + Math.round(r.manhattanShare * 100) + '% of wall area on the two axes), floor of the lowest level at y ' + r.baseY.toFixed(3));
for (const L of r.levels) {
  const doors = L.openings.filter(o => o.type === 'door'), wins = L.openings.filter(o => o.type === 'window');
  console.log('\n' + L.name + ': elevation ' + L.elevation + ' m, height ' + L.height + ' m' + (L.flatCeiling ? '' : ' (no flat ceiling)') + ', footprint ' + L.floorArea.toFixed(1) + ' m2');
  console.log('  walls (' + L.walls.length + '):');
  for (const w of L.walls) console.log('    ' + w.id + ' (' + w.ax + ',' + w.ay + ')-(' + w.bx + ',' + w.by + ') ' + Math.hypot(w.bx - w.ax, w.by - w.ay).toFixed(2) + ' m, t=' + w.thickness + (w.exterior ? ' exterior' : ''));
  console.log('  rooms (' + L.rooms.length + '):');
  for (const rm of L.rooms) console.log('    ' + rm.id + ' ' + area(rm.pts).toFixed(2) + ' m2, ' + rm.pts.length + ' corners');
  console.log('  openings (' + doors.length + ' doors, ' + wins.length + ' windows):');
  for (const o of L.openings) console.log('    ' + o.type + ' on ' + o.wallId + ' t=' + o.t + ' w=' + o.width + ' h=' + o.height + (o.sill != null ? ' sill=' + o.sill : ''));
}
if (jsonOut) { writeFileSync(jsonOut, JSON.stringify(r, null, 1)); console.log('\nwrote ' + jsonOut); }
