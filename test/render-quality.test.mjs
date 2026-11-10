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
import { effectiveQuality, phoneQualityChoice, choosePhoneQuality, deviceLimits, shrunkSize, PHONE_DEFAULT_QUALITY, PHONE_QUALITY_KEY } from '../js/render-quality.js';

// A stand-in for the browser's storage; `refuse` behaves like private mode.
function storage(refuse = false) {
  const data = new Map();
  return {
    getItem: k => { if (refuse) throw new Error('storage refused'); return data.has(k) ? data.get(k) : null; },
    setItem: (k, v) => { if (refuse) throw new Error('storage refused'); data.set(k, String(v)); },
    data,
  };
}

// The desktop draws the property's shared setting whatever a phone chose.
for (const shared of ['low', 'medium', 'high', 'ultra']) {
  assert.equal(effectiveQuality({ phone: false, shared, choice: 'low' }), shared);
  assert.equal(effectiveQuality({ phone: false, shared, choice: null }), shared);
}
assert.equal(effectiveQuality({ phone: false, shared: undefined }), 'high', 'a property with no setting draws High, as before');
// The phone never follows the shared setting: Medium until it chooses, then its own choice.
assert.equal(PHONE_DEFAULT_QUALITY, 'medium');
assert.equal(effectiveQuality({ phone: true, shared: 'ultra', choice: null }), 'medium', 'a Mac on Ultra does not make the phone draw Ultra');
assert.equal(effectiveQuality({ phone: true, shared: 'ultra', choice: 'low' }), 'low');
assert.equal(effectiveQuality({ phone: true, shared: 'low', choice: 'high' }), 'high', 'the phone may choose more than the Mac');
assert.equal(effectiveQuality({ phone: true, shared: 'ultra', choice: 'bogus' }), 'medium');

// The choice lives in the device's own storage and survives a new visit.
const kept = storage();
assert.equal(phoneQualityChoice(kept), null);
assert.equal(choosePhoneQuality(kept, 'low'), true);
assert.equal(kept.data.get(PHONE_QUALITY_KEY), 'low');
assert.equal(phoneQualityChoice(kept), 'low');
kept.data.set(PHONE_QUALITY_KEY, 'extreme');
assert.equal(phoneQualityChoice(kept), null, 'a value this build does not know is ignored');
assert.throws(() => choosePhoneQuality(kept, 'extreme'), /Unknown quality/);
// A browser that refuses storage has no saved choice and says the choice was not kept.
assert.equal(phoneQualityChoice(storage(true)), null);
assert.equal(choosePhoneQuality(storage(true), 'low'), false);
assert.equal(phoneQualityChoice(null), null);

// Memory limits: the desktop keeps the limits every device had; the phone gets lower ones.
const MB = 1024 * 1024;
for (const quality of ['low', 'medium', 'high', 'ultra']) {
  const desk = deviceLimits({ phone: false, quality }), phone = deviceLimits({ phone: true, quality });
  assert.deepEqual(desk, { textureBytes: 256 * MB, textureSets: 56, textureQuality: quality, importedTextureSize: 8192 });
  assert.ok(phone.textureBytes < desk.textureBytes && phone.textureSets < desk.textureSets && phone.importedTextureSize < desk.importedTextureSize, quality + ': every phone limit is lower');
}
assert.equal(deviceLimits({ phone: true, quality: 'medium' }).textureQuality, 'low', 'at its default the phone makes the small material textures');
assert.equal(deviceLimits({ phone: true, quality: 'high' }).textureQuality, 'high', 'a phone that chose High gets High textures');
assert.equal(deviceLimits({ phone: true, quality: 'low' }).importedTextureSize, 1024);
assert.equal(deviceLimits({ phone: true, quality: 'medium' }).importedTextureSize, 2048);

// Shrinking keeps the shape and leaves a picture that fits alone.
assert.equal(shrunkSize(2048, 1024, 2048), null);
assert.equal(shrunkSize(512, 512, 4096), null);
assert.deepEqual(shrunkSize(4096, 4096, 2048), { width: 2048, height: 2048 });
assert.deepEqual(shrunkSize(8192, 4096, 2048), { width: 2048, height: 1024 });
assert.deepEqual(shrunkSize(1000, 3000, 1024), { width: 341, height: 1024 });
assert.deepEqual(shrunkSize(5000, 1, 1024), { width: 1024, height: 1 });
assert.equal(shrunkSize(0, 100, 1024), null);
assert.equal(shrunkSize(NaN, 100, 1024), null);
console.log('Device quality and memory limit checks passed.');
