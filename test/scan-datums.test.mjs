import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scanToPlan } from '../js/scan2plan-core.js';
import { mixedScan } from './fixtures/mixed-scan.mjs';

test('smaller enclosed floor wins over raised yard and unrelated porch ceiling', () => {
  const { pos, idx } = mixedScan();
  const result = scanToPlan(pos, idx);
  assert.ok(Math.abs(result.baseY) < 0.08, `Indoor datum lost: ${result.baseY}`);
  assert.equal(result.levels.length, 1, 'Site surfaces must not become storeys');
  assert.ok(Math.abs(result.levels[0].height - 2.6) < 0.1);
  assert.ok(result.levels[0].walls.length >= 4);
  assert.equal(result.levels[0].rooms.length, 1);
  assert.ok(Math.abs(result.levels[0].rooms[0].area - 20) < 3);
});

for (const options of [{ slope: true, noise: true }, { reverse: true }, { unsigned: true }, { porchHeight: 2.6 }, { indoorCeiling: false }]) {
  test(`mixed surfaces retain spatial evidence: ${JSON.stringify(options)}`, () => {
    const { pos, idx } = mixedScan(options), before = pos.slice();
    const r = scanToPlan(pos, idx);
    assert.ok(Math.abs(r.baseY) < 0.05, `Enclosed datum lost: ${r.baseY}`);
    assert.equal(r.levels.length, 1);
    const landing = r.surfaces.find(s => s.elevation < -2);
    assert.ok(landing && landing.area > 0.9 && landing.area < 1.1, 'Small landing retained as evidence');
    assert.ok(r.levels[0].underlayMin <= landing.minElevation, 'Lower evidence is inside the clipping envelope');
    const yard = r.surfaces.find(s => s.area > 70);
    assert.ok(yard && yard.elevation > 0.5, 'Yard retains its own elevation');
    if (options.slope) assert.ok(yard.maxElevation - yard.minElevation > 0.1, 'Sloped connected surface retains its range');
    assert.ok(r.review.required, 'Competing elevations must be reviewed');
    if (options.unsigned || options.indoorCeiling === false) assert.equal(r.levels[0].datum.confidence, 'review');
    assert.ok(r.levels[0].floorArea < 23, 'Unrelated overhead cannot add outdoor area to the indoor footprint');
    assert.deepEqual(pos, before, 'Source geometry is unchanged');
    assert.doesNotThrow(() => structuredClone(r));
  });
}

test('ordinary single-level imports retain datum, room and clipping behavior', () => {
  const { pos, idx } = mixedScan({ yard: false, landing: false, porch: false });
  const r = scanToPlan(pos, idx);
  assert.equal(r.baseY, 0);
  assert.equal(r.levels.length, 1);
  assert.equal(r.levels[0].height, 2.6);
  assert.equal(r.levels[0].underlayMin, 0);
  assert.equal(r.levels[0].rooms.length, 1);
  assert.ok(Math.abs(r.levels[0].rooms[0].area - 20) < 1);
  assert.equal(r.levels[0].datum.confidence, 'supported');
  assert.equal(r.review.required, false);
});

test('missing supported horizontal area fails honestly', () => {
  assert.throws(() => scanToPlan(new Float32Array([0, 0, 0, 0, 2, 0, 0, 2, 1]), new Uint32Array([0, 1, 2])), /No floor/);
});

test('placing a proposal moves retained evidence and clipping along with the mesh', async () => {
  const { placeResult, mergeProposal } = await import('../js/scanmerge.js');
  const { floorDetectionReport, floorReviewText } = await import('../js/scan-surfaces.js');
  const { pos, idx } = mixedScan();
  const r = scanToPlan(pos, idx);
  Object.assign(r, { transform: { pos: [0, -r.baseY, 0], rot: [0, r.rotationDeg, 0] }, mainLevelIndex: 0, wallHeight: 2.6 });
  const placed = placeResult(r, { rot: 90, dx: 12, dz: -4, dElev: 3 });
  const landing = placed.surfaces.find(s => s.area < 1.1);
  assert.ok(Math.abs(landing.elevation - 0.85) < 0.01);
  assert.ok(Math.abs(placed.levels[0].underlayMin - 0.85) < 0.01);
  assert.equal(placed.levels[0].elevation, 3);
  assert.ok(landing.bounds.x0 > 10 && landing.bounds.z1 < -7, 'Bounds follow the rotation and translation');
  assert.ok(r.surfaces[0].elevation < -2, 'Placement leaves source evidence unchanged');
  const prop = { levels: [], walls: [], openings: [], rooms: [], scans: [] }, scan = { id: 's' };
  let id = 0;
  mergeProposal(prop, scan, placed, null, 'level', () => String(++id));
  assert.deepEqual(scan.floorDetection, floorDetectionReport(placed));
  assert.match(floorReviewText(scan.floorDetection), /3.00 m/);
});
