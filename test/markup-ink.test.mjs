import { test } from 'node:test';
import assert from 'node:assert/strict';
import { smoothInkPoints } from '../js/markup-ink.js';

test('smoothed ink preserves endpoints, pressure variation and the sampled bounds', () => {
  const pts = [0, 0, 0.1, 20, 30, 1, 40, 0, 0.3, 60, 10, 0.7];
  const smooth = smoothInkPoints(pts);
  assert.deepEqual(smooth.slice(0, 3), pts.slice(0, 3));
  assert.deepEqual(smooth.slice(-3), pts.slice(-3));
  assert.ok(smooth.length > pts.length);
  const values = [0, 1, 2].map(axis => smooth.filter((_, i) => i % 3 === axis));
  assert.ok(values[0].every(x => x >= 0 && x <= 60));
  assert.ok(values[1].every(y => y >= 0 && y <= 30));
  assert.ok(values[2].every(p => p >= 0.1 && p <= 1));
  assert.ok(Math.max(...values[2]) > 0.7, 'a pressure crest survives smoothing');
  assert.deepEqual(pts, [0, 0, 0.1, 20, 30, 1, 40, 0, 0.3, 60, 10, 0.7], 'the source is unchanged');
});

test('dots and straight segments keep their samples without invented points', () => {
  for (const pts of [[], [2, 3, 0.4], [2, 3, 0.4, 9, 8, 0.8]]) assert.deepEqual(smoothInkPoints(pts), pts);
});

test('extreme distances and invalid spacing cannot cause unbounded subdivision', () => {
  const pts = [0, 0, 0.1, 1e6, 1e6, 0.8, 2e6, 0, 0.5];
  for (const spacing of [0, -1, NaN, 0.000001]) {
    const smooth = smoothInkPoints(pts, spacing);
    assert.ok(smooth.length <= 66 * 3);
    assert.ok(smooth.every(Number.isFinite));
    assert.deepEqual(smooth.slice(-3), pts.slice(-3));
  }
});
