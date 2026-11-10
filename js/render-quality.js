// Shared, testable limits for interactive rendering and PNG exports.
export const QUALITY_PROFILES = Object.freeze({
  low: { maxDpr: 1, scale: 1, samples: 0, shadow: 1024, ao: false, aoSamples: 8, bloom: false },
  medium: { maxDpr: 1.5, scale: 1, samples: 0, shadow: 2048, ao: false, aoSamples: 8, bloom: true },
  high: { maxDpr: 2, scale: 1, samples: 4, shadow: 4096, ao: true, aoSamples: 16, bloom: true },
  ultra: { maxDpr: 2.5, scale: 1.25, samples: 4, shadow: 4096, ao: true, aoSamples: 32, bloom: true },
});

export function qualityProfile(name) { return QUALITY_PROFILES[name] || QUALITY_PROFILES.high; }

// The composer keeps HDR buffers, normals, AO, outlines and bloom pyramids resident.
// 24 MP is an explicit working-memory ceiling (not an arbitrary GPU texture-size promise).
export const MAX_EXPORT_PIXELS = 24_000_000;
export function stillDimensions(viewWidth, viewHeight, longEdge, maxTextureSize = 8192) {
  if (![viewWidth, viewHeight, longEdge, maxTextureSize].every(n => Number.isFinite(n) && n > 0)) {
    throw new Error('Choose a positive image size.');
  }
  const scale = longEdge / Math.max(viewWidth, viewHeight);
  const width = Math.max(1, Math.round(viewWidth * scale));
  const height = Math.max(1, Math.round(viewHeight * scale));
  if (Math.max(width, height) > maxTextureSize) throw new Error('This GPU supports images up to ' + maxTextureSize + ' pixels per side. Choose a smaller size.');
  if (width * height > MAX_EXPORT_PIXELS) throw new Error('This view exceeds the 24 megapixel export memory limit. Choose a smaller size.');
  return { width, height };
}

// ---------- this device's own quality ----------
// The quality saved with a property is shared by every device that opens it and stays the
// desktop's setting. A phone keeps its own choice in its own browser storage, so a Mac set to
// Ultra never makes the phone draw Ultra, and the phone's choice never changes the Mac.
export const QUALITY_NAMES = Object.freeze(['low', 'medium', 'high', 'ultra']);
export const PHONE_DEFAULT_QUALITY = 'medium';
export const PHONE_QUALITY_KEY = 'tiksi.phone.quality';
const known = name => QUALITY_NAMES.includes(name);

// `storage` is the browser's localStorage (or anything shaped like it). A browser that refuses
// storage (private mode) simply has no saved choice.
export function phoneQualityChoice(storage) {
  try { const v = storage && storage.getItem(PHONE_QUALITY_KEY); return known(v) ? v : null; } catch (e) { return null; }
}
export function choosePhoneQuality(storage, name) {
  if (!known(name)) throw new Error('Unknown quality ' + name);
  try { storage.setItem(PHONE_QUALITY_KEY, name); return true; } catch (e) { return false; }
}
// The quality this device draws at: on a phone its own choice (Medium until it makes one), on
// the desktop the property's shared setting, exactly as before.
export function effectiveQuality({ phone, shared, choice } = {}) {
  if (phone) return known(choice) ? choice : PHONE_DEFAULT_QUALITY;
  return known(shared) ? shared : 'high';
}

// ---------- memory limits by device ----------
// A phone browser page has a fraction of a desktop's memory and loses its graphics context when
// it runs short. The desktop row is what every device used before; its 8192 pixel limit on a
// model's own textures is above what scan and SketchUp exports carry, so nothing it shows changes.
//   textureBytes / textureSets   the generated material textures kept at once (textures.js)
//   textureQuality               which size row those textures are made at (textures.js resFor)
//   importedTextureSize          longest side, in pixels, of a texture inside an imported model
const MB = 1024 * 1024;
export function deviceLimits({ phone, quality } = {}) {
  const q = known(quality) ? quality : 'high';
  if (!phone) return { textureBytes: 256 * MB, textureSets: 56, textureQuality: q, importedTextureSize: 8192 };
  const light = q === 'low' || q === 'medium';
  return { textureBytes: 96 * MB, textureSets: 24, textureQuality: light ? 'low' : q, importedTextureSize: q === 'low' ? 1024 : 2048 };
}

// The size a picture is shrunk to so its longest side fits `limit`, keeping its shape.
// Returns null when it already fits.
export function shrunkSize(width, height, limit) {
  if (![width, height, limit].every(n => Number.isFinite(n) && n > 0)) return null;
  const longest = Math.max(width, height);
  if (longest <= limit) return null;
  const k = limit / longest;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}
