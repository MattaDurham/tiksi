// Lighting settings for MODEL (viewer3d.js), saved with each property in its environment
// (prop.env) beside the sun's time and place. Every value is a plain number, word or switch, so
// an old property, a hand-edited file or another device's copy is read the same way:
// lightingSettings() fills what is missing and keeps every number inside its range.
//
//   exposure        BRIGHTNESS: the camera's exposure, as before (1 is the old default).
//   sunStrength     SUN: how strong the sun (or the moon at night) is, times its natural level.
//   fill            FILL LIGHT: the soft light from the sky and the ground that reaches surfaces
//                   the sun does not, times its natural level. Raising it lifts every shadow
//                   and the inside of a closed model.
//   shading         CORNER SHADING: how much the corners and contact lines are darkened, 0 (off)
//                   to 1.
//   sunShadows      Whether the sun casts shadows. Off, it lights every surface turned to it,
//                   inside a closed model too.
//   lamps           ROOM LIGHTS: 'auto' (after dark, and dimly while the camera is in a traced
//                   room by day), 'on' (always) or 'off'.
//   lampBrightness  How bright the room lights are, times their natural level.
//   lampKelvin      Their colour temperature, in kelvin (2200 candle-warm to 5000 daylight).
//   cameraLight     CAMERA LIGHT: a light that moves with the camera, 0 (off) to 2, for models
//                   with no traced rooms to hang room lights in.

export const LIGHTING_DEFAULTS = Object.freeze({
  exposure: 1, sunStrength: 1, fill: 1, shading: 0.85, sunShadows: true,
  lamps: 'auto', lampBrightness: 1, lampKelvin: 3000, cameraLight: 0,
});

export const LIGHTING_RANGES = Object.freeze({
  exposure: [0.3, 3], sunStrength: [0, 2], fill: [0, 3], shading: [0, 1],
  lampBrightness: [0, 4], lampKelvin: [2200, 5000], cameraLight: [0, 2],
});
export const LAMP_MODES = Object.freeze(['auto', 'on', 'off']);

// Ready-made settings. Each sets every lighting value at once and leaves the sun's time and
// place alone; the panel shows a preset as chosen while every value still matches it.
//   natural  the defaults: sun, sky and corner shading as a camera would see them.
//   overcast a soft day: weak sun, strong even fill, lighter corners.
//   bright   a work light for arranging things: even and bright everywhere, inside a closed
//            model too (no sun shadows, high fill, the camera light on, room lights on).
export const LIGHTING_PRESETS = Object.freeze({
  natural: Object.freeze({ ...LIGHTING_DEFAULTS }),
  overcast: Object.freeze({ ...LIGHTING_DEFAULTS, exposure: 1.1, sunStrength: 0.3, fill: 1.8, shading: 0.6 }),
  bright: Object.freeze({ ...LIGHTING_DEFAULTS, exposure: 1.2, sunStrength: 0.8, fill: 2.2, shading: 0.35, sunShadows: false, lamps: 'on', cameraLight: 0.8 }),
});
export const PRESET_LABELS = Object.freeze({ natural: 'Natural', overcast: 'Overcast', bright: 'Bright work light' });

const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));

// The lighting values of an environment record, each one filled in and within its range.
// A record saved before room lights had a mode keeps its old switch: NIGHT LIGHTS off is 'off'.
export function lightingSettings(env = {}) {
  const e = env && typeof env === 'object' ? env : {};
  const out = {};
  for (const [key, range] of Object.entries(LIGHTING_RANGES)) {
    const n = Number(e[key]);
    out[key] = Number.isFinite(n) && e[key] !== null && e[key] !== '' ? clamp(n, range) : LIGHTING_DEFAULTS[key];
  }
  out.sunShadows = typeof e.sunShadows === 'boolean' ? e.sunShadows : LIGHTING_DEFAULTS.sunShadows;
  out.lamps = LAMP_MODES.includes(e.lamps) ? e.lamps : (e.nightLights === false ? 'off' : LIGHTING_DEFAULTS.lamps);
  return out;
}

// Write the lighting values back into the record, filled in and within range (old properties
// opening for the first time; values typed into a file by hand). `saved` is the record as it was
// stored, when `env` has already had the defaults merged over it: the old NIGHT LIGHTS switch
// is read from there, before a default room-light mode can hide it.
export function normalizeLighting(env, saved = env) {
  Object.assign(env, lightingSettings(saved));
  delete env.nightLights;
  return env;
}

// Which preset the record's values match exactly, or null when they match none.
export function matchingPreset(env) {
  const s = lightingSettings(env);
  for (const [name, preset] of Object.entries(LIGHTING_PRESETS)) {
    if (Object.keys(preset).every(k => typeof preset[k] === 'number' ? Math.abs(preset[k] - s[k]) < 1e-6 : preset[k] === s[k])) return name;
  }
  return null;
}

// Set every lighting value of the record to a preset's.
export function applyPreset(env, name) {
  const preset = LIGHTING_PRESETS[name];
  if (!preset) throw new Error('Unknown lighting preset ' + name);
  Object.assign(env, preset);
  delete env.nightLights;
  return env;
}

// How strongly room lights shine, 0 to 1, for a mode: `night` is 0 by day and 1 after dusk;
// `inside` is whether the camera stands in a traced room. 'auto' keeps the old behaviour: the
// lights come up through dusk, and a room the camera is in gets a gentle daytime level.
export const DAYTIME_LAMP_LEVEL = 5 / 14;
export function lampLevel(mode, night, inside) {
  if (mode === 'off') return 0;
  if (mode === 'on') return 1;
  return inside ? Math.max(DAYTIME_LAMP_LEVEL, night) : night;
}

// The colour of a light of this temperature, as 0..1 red, green and blue with the brightest
// channel at 1: Tanner Helland's fit to the blackbody colours, good from 1000 K to 40000 K.
export function kelvinToRgb(kelvin) {
  const t = clamp(Number(kelvin) || 6500, [1000, 40000]) / 100;
  const r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const c = v => clamp(v, [0, 255]) / 255;
  return [c(r), c(g), c(b)];
}
