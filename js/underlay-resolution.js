// Keep scan-derived plans sharp while bounding framebuffer memory. Plans live in
// IndexedDB, so their resolution no longer needs to fit a localStorage quota.
export function underlayResolution(widthM, heightM, options = {}) {
  if (!(Number.isFinite(widthM) && widthM > 0 && Number.isFinite(heightM) && heightM > 0)) {
    throw new Error('The scan has no finite floorplan extent.');
  }
  const requested = options.pixelsPerMeter ?? 256;
  const edge = Math.floor(Math.min(options.maxEdge ?? 4096, options.gpuLimit ?? 4096));
  const budget = options.maxPixels ?? 8 * 1024 * 1024;
  if (!(Number.isFinite(requested) && requested > 0 && Number.isFinite(edge) && edge >= 1 && Number.isFinite(budget) && budget >= 1)) {
    throw new Error('Invalid floorplan image resolution limit.');
  }
  let ppm = Math.min(requested, edge / widthM, edge / heightM, Math.sqrt(budget) / Math.sqrt(widthM) / Math.sqrt(heightM));
  const dimension = (meters, density) => Math.max(1, Math.ceil(meters * density - 1e-10));
  // Ceiling keeps a narrow floorplan's geometry inside the image. Account for
  // integer rounding as well as the continuous area when enforcing the budget.
  if (dimension(widthM, ppm) * dimension(heightM, ppm) > budget) {
    let lo = 0, hi = ppm;
    for (let i = 0; i < 48; i++) {
      const mid = (lo + hi) / 2;
      if (dimension(widthM, mid) * dimension(heightM, mid) <= budget) lo = mid;
      else hi = mid;
    }
    ppm = lo;
  }
  const width = dimension(widthM, ppm), height = dimension(heightM, ppm);
  return { width, height, pixelsPerMeter: ppm, metersPerPixel: 1 / ppm,
    cameraWidth: width / ppm, cameraHeight: height / ppm,
    limited: ppm < requested };
}
