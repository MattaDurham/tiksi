import assert from 'node:assert/strict';
import { underlayResolution } from '../js/underlay-resolution.js';

const small = underlayResolution(10, 6);
assert.equal(small.width, 2560);
assert.equal(small.height, 1536);
assert.equal(small.metersPerPixel, 1 / 256);
assert.equal(small.limited, false);

for (const [w, h] of [[200, 180], [0.03, 50], [50, 0.03], [11.731, 7.933]]) {
  const r = underlayResolution(w, h, { gpuLimit: 2048 });
  assert.ok(r.width <= 2048 && r.height <= 2048);
  assert.ok(r.width * r.height <= 8 * 1024 * 1024);
  assert.ok(r.cameraWidth >= w && r.cameraHeight >= h);
  assert.ok(r.cameraWidth - w <= r.metersPerPixel + 1e-8);
  assert.ok(r.cameraHeight - h <= r.metersPerPixel + 1e-8);
  assert.ok(Math.abs(r.width * r.metersPerPixel - r.cameraWidth) < 1e-8);
  assert.ok(Math.abs(r.height * r.metersPerPixel - r.cameraHeight) < 1e-8);
}
const memoryBound = underlayResolution(100, 100);
assert.ok(memoryBound.width * memoryBound.height <= 8 * 1024 * 1024);
assert.ok(memoryBound.limited);
for (const extent of [0, -1, Infinity, NaN]) {
  assert.throws(() => underlayResolution(extent, 10), /extent/);
}
assert.throws(() => underlayResolution(10, 10, { maxEdge: 0 }), /limit/);
console.log('Floorplan resolution, calibration and memory bounds passed.');
