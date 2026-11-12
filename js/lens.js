// The MODEL camera's field of view, the way SketchUp's Field of View works (its Zoom tool with
// Shift held): press and drag up to narrow the view, down to widen it, from where the camera
// stands. Plus lens presets that frame the view the way the owner's phone frames a picture, so
// the model lines up with Polycam keyframes and the phone's own photos.
//
// A lens is the angle across the long side of its 4:3 frame. On the screen the frame is turned
// to match the window (landscape in a wide window, portrait in a tall one) and fitted inside it,
// the same fit PHOTO MODE uses (photo-match.js viewFrame): the whole picture shows, and a window
// of another shape shows more on its longer side. three.js keeps the vertical angle (camera.fov),
// so a preset is turned into that for the window's shape and fitted again when the window changes.
// Pure maths: no DOM, no three.js.

import { viewFrame } from './photo-match.js';

const DEG = Math.PI / 180;
export const FRAME_ASPECT = 4 / 3;
// 35 mm equivalents measure against the 36 x 24 mm frame's diagonal; a 4:3 frame with that
// diagonal is 34.62 mm across its long side.
const LONG_35 = Math.hypot(36, 24) * 0.8;
// Vertical angles the view may take (degrees). 150 lets the 0.5x lens fit a tall phone screen.
export const VFOV_MIN = 5, VFOV_MAX = 150;
export const DEFAULT_VFOV = 50;

const tanHalf = deg => Math.tan(deg / 2 * DEG);
const angleOf = t => 2 * Math.atan(t) / DEG;

// iPhone 17 Pro back cameras. Evidence (2026-11-12):
//   1x  Polycam keyframes from this phone (4,743 of them, 1024 x 768, LensModel "iPhone 17 Pro
//       back camera 6.765mm f/1.78"): median fx 723.14 px, so 70.6 degrees across 1024 px and
//       55.9 across 768 px, a 24.4 mm equivalent. Polycam records only this lens.
//   2x  the same sensor cropped to the middle half, so half the 1x tangent: 39.0 degrees,
//       48.9 mm equivalent (the phone's 2x photos record 48 mm).
//   0.5x the ultra wide (2.22 mm lens): its photos from this phone record a 14 mm equivalent in
//       their files (Apple's published figure is 13 mm; the files are what the phone frames).
const MAIN_LONG_TAN = 512 / 723.1403;
export const LENSES = [
  { id: '0.5', label: '0.5×', name: 'Ultra Wide', longTan: LONG_35 / 2 / 14 },
  { id: '1', label: '1×', name: 'Main', longTan: MAIN_LONG_TAN },
  { id: '2', label: '2×', name: 'Main, 2× crop', longTan: MAIN_LONG_TAN / 2 },
].map(l => ({ ...l, long: angleOf(l.longTan), short: angleOf(l.longTan / FRAME_ASPECT), f35: LONG_35 / 2 / l.longTan }));
export const lensById = id => LENSES.find(l => l.id === String(id)) || null;

const clampV = v => Math.min(VFOV_MAX, Math.max(VFOV_MIN, v));

// The vertical field of view (camera.fov) that shows the lens's frame fitted in a window of
// this shape (width / height).
export function vfovForLens(lens, aspect) {
  if (!lens || !(aspect > 0)) return DEFAULT_VFOV;
  const H = 1000, W = H * aspect;
  const v = aspect >= 1 ? viewFrame(W, H, FRAME_ASPECT, lens.long).vfov : viewFrame(W, H, 1 / FRAME_ASPECT, lens.short).vfov;
  return clampV(v);
}

// The other way round: the lens whose fitted frame this view shows, as the tangent of half its
// long-side angle. A wide window's view fits the frame by height, a narrower one by width.
export function lensTanOfView(vfov, aspect) {
  if (!(aspect > 0)) return NaN;
  const tv = tanHalf(vfov), th = tv * aspect;
  if (aspect >= 1) return aspect >= FRAME_ASPECT ? tv * FRAME_ASPECT : th;
  return aspect <= 1 / FRAME_ASPECT ? th * FRAME_ASPECT : tv;
}

// What the view's lens is, for the readout: angle across the frame's long side, its 35 mm
// equivalent, and the preset it matches (within half a percent), if any.
export function describeView(vfov, aspect) {
  const t = lensTanOfView(vfov, aspect);
  if (!Number.isFinite(t) || !(t > 0)) return null;
  const preset = LENSES.find(l => Math.abs(t / l.longTan - 1) < 0.005) || null;
  return { long: angleOf(t), short: angleOf(t / FRAME_ASPECT), f35: LONG_35 / 2 / t, preset };
}

// A drag of `dy` pixels (down positive) on a view `height` pixels tall, starting from `vfov`:
// up narrows the view and down widens it, by the same factor for the same distance at any
// angle (a full-height drag changes the tangent by e^2, about 7x), within the limits.
export function dragFov(vfov, dy, height) {
  if (!(height > 0) || !Number.isFinite(dy)) return vfov;
  return clampV(angleOf(tanHalf(vfov) * Math.exp(2 * dy / height)));
}

// Where the lens's frame sits in a W x H window, for the outline drawn while the tool is on: the
// 4:3 rectangle fitted inside it, whatever the angle (the angle only decides what it holds).
export function lensFrameRect(W, H) {
  if (!(W > 0) || !(H > 0)) return null;
  const f = viewFrame(W, H, W >= H ? FRAME_ASPECT : 1 / FRAME_ASPECT, 60);
  return { x: f.x, y: f.y, w: f.w, h: f.h };
}
