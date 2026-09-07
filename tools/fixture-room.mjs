#!/usr/bin/env node
// Writes tools/fixtures/room.glb: a synthetic two-room interior the way a phone lidar scan
// sees it. Only interior surfaces exist (floor tops, ceiling undersides, the room-facing
// side of every wall), doors and windows are holes (glass does not scan), the shared
// partition has two faces 12 cm apart, there is furniture, the mesh is dense and noisy, and
// the whole thing is rotated 17 degrees and pushed off the origin with the floor at
// y = 0.12, so nothing about the frame is free. Plain glTF binary, metres, y up.
//
//   node tools/fixture-room.mjs [out.glb]

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(process.argv[2] || resolve(here, 'fixtures/room.glb'));

const STEP = 0.1;          // triangle grid pitch, m
const JITTER = 0.003;      // per-vertex noise, m
const H = 2.55;            // ceiling height
let seed = 1234567;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const jit = () => (rnd() * 2 - 1) * JITTER;

const P = [], C = [], I = [];
function vertex(x, y, z, c) { P.push(x + jit(), y + jit(), z + jit()); C.push(c[0] + (rnd() - 0.5) * 0.06, c[1] + (rnd() - 0.5) * 0.06, c[2] + (rnd() - 0.5) * 0.06); return P.length / 3 - 1; }

// Rectangle from origin o along vectors u and v (their lengths are the sizes), subdivided.
function rect(o, u, v, color) {
  const lu = Math.hypot(...u), lv = Math.hypot(...v);
  const nu = Math.max(1, Math.round(lu / STEP)), nv = Math.max(1, Math.round(lv / STEP));
  const grid = [];
  for (let i = 0; i <= nu; i++) {
    grid.push([]);
    for (let j = 0; j <= nv; j++) {
      const a = i / nu, b = j / nv;
      grid[i].push(vertex(o[0] + u[0] * a + v[0] * b, o[1] + u[1] * a + v[1] * b, o[2] + u[2] * a + v[2] * b, color));
    }
  }
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
    const a = grid[i][j], b = grid[i + 1][j], c = grid[i + 1][j + 1], d = grid[i][j + 1];
    if ((i + j) % 2) I.push(a, b, c, a, c, d); else I.push(a, b, d, b, c, d);
  }
}

// A wall face: origin o, unit `along` direction, length L, height H, holes [{s0, s1, y0, y1}].
function wall(o, along, L, holes, color) {
  const cuts = [0, L];
  for (const h of holes) cuts.push(h.s0, h.s1);
  cuts.sort((a, b) => a - b);
  for (let k = 0; k + 1 < cuts.length; k++) {
    const s0 = cuts[k], s1 = cuts[k + 1];
    if (s1 - s0 < 1e-6) continue;
    const mid = (s0 + s1) / 2;
    const hole = holes.find(h => mid > h.s0 && mid < h.s1);
    const base = [o[0] + along[0] * s0, o[1], o[2] + along[2] * s0];
    const u = [along[0] * (s1 - s0), 0, along[2] * (s1 - s0)];
    if (!hole) rect(base, u, [0, H, 0], color);
    else {
      if (hole.y0 > 0.01) rect(base, u, [0, hole.y0, 0], color);
      if (hole.y1 < H - 0.01) rect([base[0], hole.y1, base[2]], u, [0, H - hole.y1, 0], color);
    }
  }
}

function box(x0, x1, y0, y1, z0, z1, color, faces) {
  faces = faces || 'nsewtb';
  if (faces.includes('t')) rect([x0, y1, z0], [x1 - x0, 0, 0], [0, 0, z1 - z0], color);
  if (faces.includes('b')) rect([x0, y0, z0], [x1 - x0, 0, 0], [0, 0, z1 - z0], color);
  if (faces.includes('n')) rect([x0, y0, z0], [x1 - x0, 0, 0], [0, y1 - y0, 0], color);
  if (faces.includes('s')) rect([x0, y0, z1], [x1 - x0, 0, 0], [0, y1 - y0, 0], color);
  if (faces.includes('w')) rect([x0, y0, z0], [0, 0, z1 - z0], [0, y1 - y0, 0], color);
  if (faces.includes('e')) rect([x1, y0, z0], [0, 0, z1 - z0], [0, y1 - y0, 0], color);
}

const WALL = [0.86, 0.85, 0.82], WOOD = [0.62, 0.45, 0.28], CARPET = [0.42, 0.46, 0.52], CEIL = [0.93, 0.93, 0.91];
const SOFA = [0.28, 0.32, 0.4], TABLE = [0.5, 0.36, 0.22], WARD = [0.72, 0.6, 0.45], BED = [0.75, 0.74, 0.7];

// Room A (living): x 0..5.2, z 0..4.  Room B (bedroom): x 5.32..8.72, z 0..4.  Partition 12 cm.
rect([0, 0, 0], [5.2, 0, 0], [0, 0, 4], WOOD);                      // floor A
rect([5.32, 0, 0], [3.4, 0, 0], [0, 0, 4], CARPET);                 // floor B
rect([5.2, 0, 2.4], [0.12, 0, 0], [0, 0, 0.86], WOOD);              // threshold between rooms
rect([-0.3, 0, 1.6], [0.3, 0, 0], [0, 0, 0.86], WOOD);              // a bit of floor seen through the front door
rect([0, H, 0], [5.2, 0, 0], [0, 0, 4], CEIL);                      // ceilings
rect([5.32, H, 0], [3.4, 0, 0], [0, 0, 4], CEIL);
rect([5.2, H, 2.4], [0.12, 0, 0], [0, 0, 0.86], CEIL);

wall([0, 0, 0], [1, 0, 0], 5.2, [{ s0: 1.5, s1: 2.7, y0: 0.9, y1: 2.05 }], WALL);          // A north, window
wall([0, 0, 4], [1, 0, 0], 5.2, [{ s0: 3.0, s1: 4.2, y0: 0.9, y1: 2.05 }], WALL);          // A south, window
wall([0, 0, 0], [0, 0, 1], 4.0, [{ s0: 1.6, s1: 2.46, y0: 0, y1: 2.03 }], WALL);           // A west, front door
wall([5.2, 0, 0], [0, 0, 1], 4.0, [{ s0: 2.4, s1: 3.26, y0: 0, y1: 2.03 }], WALL);         // A east = partition face
wall([5.32, 0, 0], [0, 0, 1], 4.0, [{ s0: 2.4, s1: 3.26, y0: 0, y1: 2.03 }], WALL);        // B west = partition face
wall([5.32, 0, 0], [1, 0, 0], 3.4, [], WALL);                                              // B north
wall([5.32, 0, 4], [1, 0, 0], 3.4, [], WALL);                                              // B south
wall([8.72, 0, 0], [0, 0, 1], 4.0, [{ s0: 1.2, s1: 2.4, y0: 0.9, y1: 2.05 }], WALL);       // B east, window
// Door reveals: the 12 cm jambs of the partition doorway and the header underside.
rect([5.2, 0, 2.4], [0.12, 0, 0], [0, 2.03, 0], WALL);
rect([5.2, 0, 3.26], [0.12, 0, 0], [0, 2.03, 0], WALL);
rect([5.2, 2.03, 2.4], [0.12, 0, 0], [0, 0, 0.86], WALL);

// Furniture.
box(0.8, 2.8, 0, 0.85, 2.9, 3.8, SOFA);                                     // sofa
rect([3.2, 0.75, 1.2], [1.2, 0, 0], [0, 0, 0.8], TABLE);                    // table top
rect([3.2, 0.72, 1.2], [1.2, 0, 0], [0, 0, 0.8], TABLE);
for (const [x, z] of [[3.25, 1.25], [4.3, 1.25], [3.25, 1.9], [4.3, 1.9]]) box(x, x + 0.05, 0, 0.72, z, z + 0.05, TABLE, 'nsew');
box(6.4, 7.9, 0, 2.0, 3.4, 4.0, WARD, 'newt');                              // wardrobe against B south
box(5.6, 7.4, 0, 0.5, 0.3, 2.3, BED, 'nsewt');                              // bed

// Pose: rotate 17 degrees about y, then translate; floor ends up at y = 0.12.
const ang = 17 * Math.PI / 180, cos = Math.cos(ang), sin = Math.sin(ang);
const T = [3.1, 0.12, -2.4];
for (let i = 0; i < P.length; i += 3) {
  const x = P[i], y = P[i + 1], z = P[i + 2];
  P[i] = x * cos - z * sin + T[0];
  P[i + 1] = y + T[1];
  P[i + 2] = x * sin + z * cos + T[2];
}

// ---------- GLB ----------
const pos = new Float32Array(P), col = new Float32Array(C), idx = new Uint32Array(I);
const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], pos[i + k]); max[k] = Math.max(max[k], pos[i + k]); }
const pad4 = n => (n + 3) & ~3;
const bufs = [pos, col, idx];
let off = 0;
const views = bufs.map(b => { const v = { buffer: 0, byteOffset: off, byteLength: b.byteLength }; off += pad4(b.byteLength); return v; });
const bin = new Uint8Array(off);
bufs.forEach((b, i) => bin.set(new Uint8Array(b.buffer), views[i].byteOffset));
const json = {
  asset: { version: '2.0', generator: 'tiksi fixture-room' },
  scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name: 'room-scan' }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0, COLOR_0: 1 }, indices: 2, mode: 4 }] }],
  buffers: [{ byteLength: bin.byteLength }],
  bufferViews: views,
  accessors: [
    { bufferView: 0, componentType: 5126, count: pos.length / 3, type: 'VEC3', min, max },
    { bufferView: 1, componentType: 5126, count: col.length / 3, type: 'VEC3' },
    { bufferView: 2, componentType: 5125, count: idx.length, type: 'SCALAR' },
  ],
};
let jsonBytes = Buffer.from(JSON.stringify(json));
const jsonPad = pad4(jsonBytes.length) - jsonBytes.length;
jsonBytes = Buffer.concat([jsonBytes, Buffer.alloc(jsonPad, 0x20)]);
const total = 12 + 8 + jsonBytes.length + 8 + bin.byteLength;
const glb = Buffer.alloc(total);
let p = 0;
const u32 = v => { glb.writeUInt32LE(v >>> 0, p); p += 4; };
u32(0x46546c67); u32(2); u32(total);
u32(jsonBytes.length); u32(0x4e4f534a); jsonBytes.copy(glb, p); p += jsonBytes.length;
u32(bin.byteLength); u32(0x004e4942); Buffer.from(bin.buffer).copy(glb, p);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, glb);
console.log('wrote ' + out + ': ' + (idx.length / 3).toLocaleString() + ' triangles, ' + (pos.length / 3).toLocaleString() + ' vertices, ' + (total / 1048576).toFixed(1) + ' MB');
