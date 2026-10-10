import assert from 'node:assert/strict';
import { qualityProfile, stillDimensions } from '../js/render-quality.js';

assert.deepEqual(stillDimensions(1600, 900, 3840), { width: 3840, height: 2160 });
assert.deepEqual(stillDimensions(900, 1600, 3840), { width: 2160, height: 3840 });
assert.deepEqual(stillDimensions(1000, 1000, 1920), { width: 1920, height: 1920 });
assert.throws(() => stillDimensions(1600, 900, 7680), /24 megapixel/);
assert.throws(() => stillDimensions(1600, 900, 5760, 4096), /GPU/);
assert.throws(() => stillDimensions(0, 900, 3840), /positive/);
assert.throws(() => stillDimensions(1600, 900, NaN), /positive/);
assert.equal(qualityProfile('invalid'), qualityProfile('high'));
assert.ok(qualityProfile('ultra').aoSamples > qualityProfile('high').aoSamples);
assert.ok(qualityProfile('ultra').scale > qualityProfile('high').scale);
assert.equal(qualityProfile('low').samples, 0);
console.log('Render quality and export sizing checks passed.');
