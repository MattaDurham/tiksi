import assert from 'node:assert/strict';
import { LIGHTING_DEFAULTS, LIGHTING_PRESETS, lightingSettings, normalizeLighting, matchingPreset, applyPreset, lampLevel, kelvinToRgb, DAYTIME_LAMP_LEVEL } from '../js/lighting.js';

// A property saved before these settings existed opens with the defaults, and its NIGHT LIGHTS
// switch carries over: off stays off, on becomes the old automatic behaviour.
assert.deepEqual(lightingSettings({ time: 14.5, exposure: 1 }), { ...LIGHTING_DEFAULTS });
assert.equal(lightingSettings({ nightLights: false }).lamps, 'off');
assert.equal(lightingSettings({ nightLights: true }).lamps, 'auto');
// A mode chosen since wins over the old switch.
assert.equal(lightingSettings({ nightLights: false, lamps: 'on' }).lamps, 'on');
// The old exposure is kept as it was.
assert.equal(lightingSettings({ exposure: 1.4 }).exposure, 1.4);

// Numbers out of range are pulled in; anything that is not a number falls back to the default.
const odd = lightingSettings({ exposure: 99, fill: -3, shading: '0.5', lampKelvin: 900, cameraLight: 'bright', sunStrength: null, lamps: 'disco', sunShadows: 'no' });
assert.equal(odd.exposure, 3);
assert.equal(odd.fill, 0);
assert.equal(odd.shading, 0.5);
assert.equal(odd.lampKelvin, 2200);
assert.equal(odd.cameraLight, 0);
assert.equal(odd.sunStrength, 1);
assert.equal(odd.lamps, 'auto');
assert.equal(odd.sunShadows, true);
assert.equal(lightingSettings(null).fill, 1);

// Writing them back fills the record in and retires the old switch.
const env = { time: 9, nightLights: false, fill: 7 };
normalizeLighting(env);
assert.equal(env.time, 9);
assert.equal(env.lamps, 'off');
assert.equal(env.fill, 3);
assert.equal('nightLights' in env, false);
// With the defaults already merged over the saved record, the saved switch still decides.
const saved = { nightLights: false };
const merged = normalizeLighting({ ...LIGHTING_DEFAULTS, ...saved }, saved);
assert.equal(merged.lamps, 'off');

// Presets: each sets every lighting value and nothing else; the record shows which one it
// matches until a value is changed by hand.
const room = { time: 20, azimuth: 120 };
assert.equal(matchingPreset(room), 'natural');
applyPreset(room, 'bright');
assert.equal(room.time, 20); assert.equal(room.azimuth, 120);
assert.equal(matchingPreset(room), 'bright');
assert.equal(room.sunShadows, false);
assert.ok(room.fill > LIGHTING_DEFAULTS.fill && room.cameraLight > 0 && room.lamps === 'on');
room.fill = 2.3;
assert.equal(matchingPreset(room), null);
applyPreset(room, 'overcast');
assert.equal(matchingPreset(room), 'overcast');
assert.ok(LIGHTING_PRESETS.overcast.sunStrength < LIGHTING_DEFAULTS.sunStrength);
assert.throws(() => applyPreset(room, 'disco'), /Unknown lighting preset/);
// Every preset is inside the ranges the panel offers.
for (const preset of Object.values(LIGHTING_PRESETS)) assert.deepEqual(lightingSettings(preset), { ...preset });

// Room lights: off is dark, on is full, and auto is the old behaviour (dusk, plus a daytime
// level while the camera stands in a traced room).
assert.equal(lampLevel('off', 1, true), 0);
assert.equal(lampLevel('on', 0, false), 1);
assert.equal(lampLevel('auto', 0, false), 0);
assert.equal(lampLevel('auto', 0, true), DAYTIME_LAMP_LEVEL);
assert.equal(lampLevel('auto', 1, true), 1);
assert.equal(lampLevel('auto', 0.6, false), 0.6);

// Colour temperature: warm light is red-heavy with little blue, daylight is near white, and
// every channel stays in 0..1 with red at full below 6600 K.
const warm = kelvinToRgb(2200), day = kelvinToRgb(5000), sky = kelvinToRgb(9000);
assert.equal(warm[0], 1); assert.ok(warm[2] < 0.35 && warm[1] < warm[0]);
assert.ok(day[2] > 0.75 && day[1] > 0.85);
assert.equal(sky[2], 1); assert.ok(sky[0] < 1);
for (const c of [...warm, ...day, ...sky, ...kelvinToRgb('x'), ...kelvinToRgb(1e9)]) assert.ok(c >= 0 && c <= 1);

console.log('Lighting settings checks passed.');
