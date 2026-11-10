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

// ---------- this device's own quality ----------
import { effectiveQuality, deviceQualityChoice, chooseDeviceQuality, deviceLimits, shrunkSize, touchDevice, TOUCH_DEVICE_QUERY, TOUCH_DEFAULT_QUALITY, DEVICE_QUALITY_KEY } from '../js/render-quality.js';

// A stand-in for the browser's storage; `refuse` behaves like private mode.
function storage(refuse = false) {
  const data = new Map();
  return {
    getItem: k => { if (refuse) throw new Error('storage refused'); return data.has(k) ? data.get(k) : null; },
    setItem: (k, v) => { if (refuse) throw new Error('storage refused'); data.set(k, String(v)); },
    data,
  };
}

// The device decides, never the window: a touch device is one whose main pointer is a finger
// and that cannot hover. A stand-in window answers one media query.
const windowWith = answers => ({ matchMedia: query => ({ matches: !!answers[query] }) });
assert.equal(TOUCH_DEVICE_QUERY, '(hover: none) and (pointer: coarse)');
assert.equal(touchDevice(windowWith({ [TOUCH_DEVICE_QUERY]: true })), true, 'a phone or tablet');
assert.equal(touchDevice(windowWith({ [TOUCH_DEVICE_QUERY]: false })), false, 'a computer');
// A computer in a narrow window matches the small-screen query the layout uses, and is still a computer.
assert.equal(touchDevice(windowWith({ '(max-width: 760px), (max-height: 500px) and (pointer: coarse)': true })), false);
assert.equal(touchDevice({}), false, 'no matchMedia: not a touch device');
assert.equal(touchDevice(null), false);
assert.equal(touchDevice({ matchMedia() { throw new Error('refused'); } }), false);

// A computer draws the property's shared setting whatever a device choice in storage says.
for (const shared of ['low', 'medium', 'high', 'ultra']) {
  assert.equal(effectiveQuality({ touch: false, shared, choice: 'low' }), shared);
  assert.equal(effectiveQuality({ touch: false, shared, choice: null }), shared);
}
assert.equal(effectiveQuality({ touch: false, shared: undefined }), 'high', 'a property with no setting draws High, as before');
// A touch device never follows the shared setting: Medium until it chooses, then its own choice.
assert.equal(TOUCH_DEFAULT_QUALITY, 'medium');
assert.equal(effectiveQuality({ touch: true, shared: 'ultra', choice: null }), 'medium', 'a Mac on Ultra does not make the phone draw Ultra');
assert.equal(effectiveQuality({ touch: true, shared: 'ultra', choice: 'low' }), 'low');
assert.equal(effectiveQuality({ touch: true, shared: 'low', choice: 'high' }), 'high', 'the phone may choose more than the Mac');
assert.equal(effectiveQuality({ touch: true, shared: 'ultra', choice: 'bogus' }), 'medium');

// The choice lives in the device's own storage and survives a new visit.
const kept = storage();
assert.equal(deviceQualityChoice(kept), null);
assert.equal(chooseDeviceQuality(kept, 'low'), true);
assert.equal(kept.data.get(DEVICE_QUALITY_KEY), 'low');
assert.equal(deviceQualityChoice(kept), 'low');
kept.data.set(DEVICE_QUALITY_KEY, 'extreme');
assert.equal(deviceQualityChoice(kept), null, 'a value this build does not know is ignored');
assert.throws(() => chooseDeviceQuality(kept, 'extreme'), /Unknown quality/);
// A browser that refuses storage has no saved choice and says the choice was not kept.
assert.equal(deviceQualityChoice(storage(true)), null);
assert.equal(chooseDeviceQuality(storage(true), 'low'), false);
assert.equal(deviceQualityChoice(null), null);

// Memory limits: a computer keeps what every device had; a touch device gets lower ones.
const MB = 1024 * 1024;
for (const quality of ['low', 'medium', 'high', 'ultra']) {
  const desk = deviceLimits({ touch: false, quality }), phone = deviceLimits({ touch: true, quality });
  // 16384 is the most a graphics card takes: off a touch device no model texture is shrunk here.
  assert.deepEqual(desk, { textureBytes: 256 * MB, textureSets: 56, textureQuality: quality, importedTextureSize: 16384 });
  assert.ok(phone.textureBytes < desk.textureBytes && phone.textureSets < desk.textureSets && phone.importedTextureSize < desk.importedTextureSize, quality + ': every touch-device limit is lower');
}
assert.equal(deviceLimits({ touch: true, quality: 'medium' }).textureQuality, 'low', 'at its default a touch device makes the small material textures');
assert.equal(deviceLimits({ touch: true, quality: 'high' }).textureQuality, 'high', 'one that chose High gets High textures');
assert.equal(deviceLimits({ touch: true, quality: 'low' }).importedTextureSize, 1024);
assert.equal(deviceLimits({ touch: true, quality: 'medium' }).importedTextureSize, 2048);

// Shrinking keeps the shape and leaves a picture that fits alone.
assert.equal(shrunkSize(2048, 1024, 2048), null);
assert.equal(shrunkSize(512, 512, 4096), null);
assert.equal(shrunkSize(16384, 8192, 16384), null, 'the largest picture a graphics card takes is untouched on a computer');
assert.deepEqual(shrunkSize(4096, 4096, 2048), { width: 2048, height: 2048 });
assert.deepEqual(shrunkSize(8192, 4096, 2048), { width: 2048, height: 1024 });
assert.deepEqual(shrunkSize(1000, 3000, 1024), { width: 341, height: 1024 });
assert.deepEqual(shrunkSize(5000, 1, 1024), { width: 1024, height: 1 });
assert.equal(shrunkSize(0, 100, 1024), null);
assert.equal(shrunkSize(NaN, 100, 1024), null);
console.log('Device quality and memory limit checks passed.');
