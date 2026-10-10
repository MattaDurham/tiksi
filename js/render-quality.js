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
