// Match photo: a photo may record the camera it was taken from,
//   photo.view = { position: [x, y, z], target: [x, y, z], fov, from? }
// in model coordinates (metres, y up). `fov` is the horizontal field of view in degrees, a
// property of the lens rather than of the screen showing it; `from` is 'pin' when the view
// was only the camera at the moment of pinning, 'saved' once someone lined it up. MODEL flies
// to the view and lays the photo over the render. Pure maths, no three.js and no DOM.

export const LONG_SIDE_FOV = 72;   // degrees across the long side: a phone's main camera
export const FOV_MIN = 20, FOV_MAX = 120;
// Where a view came from: the camera at pinning, lined up by eye, the photo file's lens alone,
// a four-point fit, a Polycam keyframe, the automatic placement helper, or a numbered position.
export const VIEW_SOURCES = ['pin', 'saved', 'exif', 'points', 'keyframe', 'auto', 'position'];
// Views that were found from the photo itself rather than assumed.
export const FOUND_SOURCES = ['saved', 'points', 'keyframe', 'auto', 'position'];
const DEG = Math.PI / 180;

const vec = v => Array.isArray(v) && v.length === 3 && v.every(n => typeof n === 'number' && Number.isFinite(n));
const num = v => (typeof v === 'number' || (typeof v === 'string' && v.trim())) ? Number(v) : NaN;

// A clean copy of a stored view, or null when it cannot place a camera (missing or non-numeric
// points, the eye on the target). Out-of-range lenses are clamped rather than refused.
export function normalizeView(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const position = Array.isArray(v.position) ? v.position.map(num) : null;
  const target = Array.isArray(v.target) ? v.target.map(num) : null;
  if (!vec(position) || !vec(target)) return null;
  if (Math.hypot(position[0] - target[0], position[1] - target[1], position[2] - target[2]) < 1e-3) return null;
  let fov = num(v.fov);
  if (!Number.isFinite(fov)) fov = LONG_SIDE_FOV;
  const out = { position, target, fov: Math.min(FOV_MAX, Math.max(FOV_MIN, fov)) };
  if (VIEW_SOURCES.includes(v.from)) out.from = v.from;
  // Roll about the view direction in degrees (a photo held slightly crooked), from a fitted camera.
  const roll = num(v.roll);
  if (Number.isFinite(roll) && Math.abs(roll) > 1e-3) out.roll = Math.max(-180, Math.min(180, roll));
  // How well a fitted camera explains the photo: rms pixel error over n point pairs or matches.
  if (v.fit && typeof v.fit === 'object' && Number.isFinite(num(v.fit.rmsPx))) {
    out.fit = { rmsPx: num(v.fit.rmsPx), n: Number.isFinite(num(v.fit.n)) ? num(v.fit.n) : 0 };
  }
  // The clicked point pairs behind a four-point fit, kept so the camera can be fitted again.
  if (Array.isArray(v.pairs)) {
    const pairs = v.pairs.filter(p => p && Array.isArray(p.img) && Array.isArray(p.world) && p.img.length === 2 && p.world.length === 3 && [...p.img, ...p.world].every(x => Number.isFinite(num(x))))
      .map(p => ({ img: p.img.map(num), world: p.world.map(num) }));
    if (pairs.length) out.pairs = pairs;
  }
  return out;
}

// The horizontal field of view to assume for a photo of this aspect (width / height) when it
// carries none: LONG_SIDE_FOV across the long side, so a portrait photo is narrower.
export function defaultHfov(aspect) {
  if (!(aspect > 0) || aspect >= 1) return LONG_SIDE_FOV;
  return 2 * Math.atan(Math.tan(LONG_SIDE_FOV / 2 * DEG) * aspect) / DEG;
}
// Horizontal field of view of a camera with vertical field `vfov` (degrees) at `aspect`.
export function hfovOf(vfov, aspect) { return 2 * Math.atan(Math.tan(vfov / 2 * DEG) * aspect) / DEG; }

// Where the photo sits on a W x H viewport and the vertical field of view (three.js
// camera.fov) that makes the render inside that rectangle the photo's own frame: the photo
// fills the height of a wider viewport and the width of a narrower one.
export function viewFrame(W, H, aspect, hfov) {
  const t = Math.tan(hfov / 2 * DEG), A = W / H;
  if (A >= aspect) {
    const h = H, w = H * aspect;
    return { vfov: 2 * Math.atan(t / aspect) / DEG, x: (W - w) / 2, y: 0, w, h };
  }
  const w = W, h = W / aspect;
  return { vfov: 2 * Math.atan(t / A) / DEG, x: 0, y: (H - h) / 2, w, h };
}

// A starting view for a pinned photo that has none: standing 2.5 m out from the pinned
// surface, looking at the pin; above a floor pin, looking down at it.
export function viewForPin(pin, fov = LONG_SIDE_FOV) {
  const p = [num(pin.x), num(pin.y), num(pin.z)];
  if (!vec(p)) return null;
  let nx = num(pin.nx) || 0, ny = Number.isFinite(num(pin.ny)) ? num(pin.ny) : 1, nz = num(pin.nz) || 0;
  if (Math.abs(ny) > 0.7) return normalizeView({ position: [p[0], p[1] + 1.6, p[2] + 1.6], target: p, fov });
  const L = Math.hypot(nx, nz) || 1;
  nx /= L; nz /= L;
  return normalizeView({ position: [p[0] + nx * 2.5, p[1], p[2] + nz * 2.5], target: p, fov });
}
