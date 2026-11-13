// CPU-only geometry contract. No browser globals, module hooks, store or database fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import { trimMeshParts } from '../js/trim-mesh.js';
import { TRIM_STYLES, trimTemplate, openingBlocks } from '../js/trims.js';
import { catalogItem, catalogFor } from '../js/trim-catalog.js';

const WALL = { id: 'wall', ax: 0, ay: 0, bx: 4.123456789, by: 0, thickness: 0.114, height: 2.44 };
const VIEW = { walls: [WALL], rooms: [], wallHeight: 2.44 };
const near = (a, b, label, tolerance = 1e-10) => assert.ok(Math.abs(a - b) < tolerance, `${label}: ${a} != ${b}`);
const points = part => Array.from({ length: part.positions.length / 3 }, (_, i) => part.positions.slice(i * 3, i * 3 + 3));
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const sub = (a, b) => a.map((v, i) => v - b[i]);
const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
const bounds = result => {
  const pts = result.parts.flatMap(points);
  return { min: [0, 1, 2].map(i => Math.min(...pts.map(p => p[i]))), max: [0, 1, 2].map(i => Math.max(...pts.map(p => p[i]))) };
};
function section(style, side = 1, wall = WALL, options = {}) {
  return { ...trimTemplate(style, options.product || null, wall, side, { wallHeight: wall.height, ...options }), id: `trim-${style}-${side}` };
}

test('the shared helper imports and runs without browser globals or workspace state', () => {
  assert.equal(typeof globalThis.window, 'undefined');
  assert.equal(typeof globalThis.document, 'undefined');
  assert.equal(typeof globalThis.indexedDB, 'undefined');
  const t = section('baseboard'), before = JSON.stringify({ t, WALL, VIEW });
  const result = trimMeshParts(t, WALL, VIEW, []);
  assert.ok(result.parts.length > 0);
  assert.equal(JSON.stringify({ t, WALL, VIEW }), before, 'inputs stay untouched');
});

test('every style produces finite outward-wound triangles on either wall face', () => {
  for (const style of Object.keys(TRIM_STYLES)) for (const side of [-1, 1]) {
    const result = trimMeshParts(section(style, side), WALL, VIEW, []);
    assert.ok(result.parts.some(p => p.role === 'main'), `${style} main geometry`);
    assert.equal(result.layout.side, side); assert.equal(result.layout.h, WALL.thickness / 2);
    assert.equal(result.layout.H, WALL.height);
    for (const part of result.parts) {
      assert.ok(['main', 'backer'].includes(part.role));
      assert.ok(Array.isArray(part.positions) && Array.isArray(part.normals) && Array.isArray(part.uv));
      assert.equal(part.positions.length % 9, 0); assert.equal(part.normals.length, part.positions.length);
      assert.equal(part.uv.length, part.positions.length / 3 * 2);
      assert.ok([...part.positions, ...part.normals, ...part.uv].every(Number.isFinite), style);
      const pts = points(part);
      assert.ok(pts.every(p => p[2] * side >= WALL.thickness / 2 - 1e-12), `${style} outside the wall face`);
      for (let i = 0; i < pts.length; i += 3) {
        const actual = cross(sub(pts[i + 1], pts[i]), sub(pts[i + 2], pts[i]));
        const len = Math.hypot(...actual); assert.ok(len > 1e-12, `${style} non-degenerate triangle`);
        for (let j = 0; j < 3; j++) {
          const normal = part.normals.slice((i + j) * 3, (i + j) * 3 + 3);
          near(Math.hypot(...normal), 1, `${style} unit normal`);
          near(dot(actual, normal) / len, 1, `${style} normal agrees with winding`);
        }
      }
    }
  }
});

test('a square section has the specified physical volume on both faces', () => {
  const p = catalogItem('hd-10005558');
  for (const side of [-1, 1]) {
    const t = section('baseboard', side, WALL, { product: p.id });
    const result = trimMeshParts(t, WALL, VIEW, []);
    let volume = 0;
    for (const part of result.parts) {
      const pts = points(part);
      for (let i = 0; i < pts.length; i += 3) volume += dot(pts[i], cross(pts[i + 1], pts[i + 2])) / 6;
    }
    near(volume, WALL.bx * p.W * p.T, 'closed prism volume');
    const b = bounds(result);
    near(b.min[1], 0, 'floor datum'); near(b.max[1], p.W, 'profile height');
    near(Math.max(Math.abs(b.min[2]), Math.abs(b.max[2])), WALL.thickness / 2 + p.T, 'projection');
  }
});

test('profiled moulding mitres continuously from its back to its front at an inside corner', () => {
  const wall = { ...WALL, bx: 4 }, p = catalogItem('hd-10000558');
  for (const side of [-1, 1]) {
    const next = { id: 'return', ax: 4, ay: 0, bx: 4, by: 3 * side, thickness: wall.thickness };
    const result = trimMeshParts(section('baseboard', side, wall, { product: p.id }), wall, { ...VIEW, walls: [wall, next] }, []);
    const pts = result.parts.flatMap(points);
    const back = pts.filter(q => Math.abs(q[2] * side - wall.thickness / 2) < 1e-12);
    const front = pts.filter(q => Math.abs(q[2] * side - wall.thickness / 2 - p.T) < 1e-12);
    near(Math.max(...back.map(q => q[0])), 4 - wall.thickness / 2, 'back meets return face');
    near(Math.max(...front.map(q => q[0])), 4 - wall.thickness / 2 - p.T, 'front meets adjoining moulding');
    for (const q of pts.filter(q => q[0] > 3)) {
      near(q[0] + q[2] * side, 4, 'end cap stays on the 45 degree mitre plane');
    }
  }
});

test('door and window cuts remain open in runs and fields, including casing clearance', () => {
  const openings = [
    { id: 'door', type: 'door', wallId: WALL.id, width: 0.8, t: 0.26, height: 2.03 },
    { id: 'window', type: 'window', wallId: WALL.id, width: 0.73, t: 0.74, height: 0.85, sill: 0.65 },
  ];
  const blocks = openingBlocks(WALL, openings, WALL.bx, WALL.height);
  for (const style of ['baseboard', 'chair-rail', 'picture-frame', 'board-batten', 'grid', 'shaker', 'raised-panel', 'beadboard', 'v-groove', 'shiplap', 'slat', 'fluted']) {
    const t = section(style, 1, WALL, { y: style === 'chair-rail' ? 0.85 : 0, h: 2.4 });
    const result = trimMeshParts(t, WALL, VIEW, openings);
    assert.ok(result.parts.length, style);
    for (const part of result.parts) {
      const pts = points(part);
      for (let i = 0; i < pts.length; i += 3) {
        const tri = pts.slice(i, i + 3);
        const x0 = Math.min(...tri.map(p => p[0])), x1 = Math.max(...tri.map(p => p[0]));
        const y0 = Math.min(...tri.map(p => p[1])), y1 = Math.max(...tri.map(p => p[1]));
        for (const b of blocks) assert.ok(x1 <= b.x0 + 1e-10 || x0 >= b.x1 - 1e-10 || y1 <= b.y0 + 1e-10 || y0 >= b.y1 - 1e-10,
          `${style} triangle crosses ${b.id}'s reserved opening`);
      }
    }
  }
});

test('crown meets the ceiling and slat backer remains a separate, correctly layered part', () => {
  for (const side of [-1, 1]) {
    const crown = trimMeshParts(section('crown', side), WALL, VIEW, []);
    const cp = catalogFor('crown')[0], cb = bounds(crown);
    near(cb.max[1], WALL.height, 'crown ceiling contact'); near(cb.min[1], WALL.height - cp.W, 'crown drop');
    const slat = trimMeshParts(section('slat', side), WALL, VIEW, []), sp = catalogFor('slat')[0];
    const backer = slat.parts.find(p => p.role === 'backer'), main = slat.parts.find(p => p.role === 'main');
    assert.ok(backer && main, 'separate finish/material roles');
    near(Math.max(...points(backer).map(p => p[2] * side)), WALL.thickness / 2 + sp.backer, 'backer outer face');
    near(Math.min(...points(main).map(p => p[2] * side)), WALL.thickness / 2 + sp.backer, 'slats sit on backer');
    near(Math.max(...points(main).map(p => p[2] * side)), WALL.thickness / 2 + sp.backer + sp.T, 'slat front');
  }
});

test('source mesh positions keep double precision and the wall-local frame', () => {
  const t = section('baseboard'); t.f0 = 0.123456789; t.f1 = 0.987654321;
  const expected = t.f0 * WALL.bx;
  const result = trimMeshParts(t, WALL, VIEW, []), xs = result.parts.flatMap(points).map(p => p[0]);
  assert.equal(Math.min(...xs), expected);
  assert.notEqual(Math.fround(expected), expected, 'fixture detects float32 truncation');
  assert.ok(xs.some(x => x !== Math.fround(x)), 'CPU source retains precision beyond rendering buffers');
  const angle = 0.731, start = [17.3, -9.2];
  const rotated = { ...WALL, ax: start[0], ay: start[1], bx: start[0] + Math.cos(angle) * WALL.bx, by: start[1] + Math.sin(angle) * WALL.bx };
  const moved = trimMeshParts({ ...t }, rotated, { ...VIEW, walls: [rotated] }, []);
  const b = bounds(moved);
  near(b.min[0], expected, 'local start after world rotation');
  near(b.max[0], t.f1 * WALL.bx, 'local end after world rotation');
  near(b.min[2], WALL.thickness / 2, 'local wall face after world rotation');
});

test('a wall too short to carry trim returns no source mesh or layout', () => {
  const wall = { ...WALL, bx: 0.005 };
  assert.deepEqual(trimMeshParts(section('baseboard', 1, wall), wall, { ...VIEW, walls: [wall] }, []), { parts: [], layout: null });
});
