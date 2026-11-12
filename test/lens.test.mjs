// MODEL field of view (lens.js): the iPhone 17 Pro presets frame the view as the phone frames a
// picture, whatever the window's shape, and the SketchUp-style drag narrows and widens it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LENSES, lensById, vfovForLens, lensTanOfView, describeView, dragFov, lensFrameRect, VFOV_MIN, VFOV_MAX, DEFAULT_VFOV } from '../js/lens.js';

const close = (a, b, eps, what) => assert.ok(Math.abs(a - b) < eps, `${what || ''} ${a} != ${b}`);
const DEG = Math.PI / 180;

test('the presets are the phone\'s 0.5x, 1x and 2x pictures', () => {
  assert.deepEqual(LENSES.map(l => l.label), ['0.5×', '1×', '2×']);
  const [uw, main, two] = LENSES;
  // 1x: a Polycam keyframe 1024 px wide with fx 723.14 px.
  close(main.long, 2 * Math.atan(512 / 723.1403) / DEG, 1e-9, '1x long side');
  close(main.long, 70.6, 0.05); close(main.short, 55.9, 0.05); close(main.f35, 24.4, 0.05);
  // 2x is the middle half of the same picture; 0.5x the 14 mm the phone writes in its photos.
  close(Math.tan(two.long / 2 * DEG), Math.tan(main.long / 2 * DEG) / 2, 1e-12, '2x tangent');
  close(two.f35, 2 * main.f35, 1e-9); close(uw.f35, 14, 1e-9);
  assert.ok(uw.long > 100 && uw.long < 104, 'ultra wide ' + uw.long);
  assert.equal(lensById('2'), two);
  assert.equal(lensById('3'), null);
});

test('a preset fits the 4:3 picture inside any window, landscape or portrait', () => {
  const main = lensById('1');
  // A 4:3 window shows exactly the picture: its height holds the short side.
  close(vfovForLens(main, 4 / 3), main.short, 1e-9, '4:3 window');
  // A wider window fits the picture by height, so the angle up and down is the same and it
  // sees more to the sides.
  close(vfovForLens(main, 16 / 9), main.short, 1e-9, 'wide window');
  // A narrower landscape window fits it by width: the long side spans the window's width.
  const a = 1.1, v = vfovForLens(main, a);
  close(2 * Math.atan(Math.tan(v / 2 * DEG) * a) / DEG, main.long, 1e-9, 'narrow window width');
  // A portrait phone screen turns the picture upright and fits its short side across.
  const p = 9 / 19.5, vp = vfovForLens(main, p);
  close(2 * Math.atan(Math.tan(vp / 2 * DEG) * p) / DEG, main.short, 1e-9, 'phone width');
  // The ultra wide on that phone screen is still inside the limits.
  assert.ok(vfovForLens(lensById('0.5'), p) < VFOV_MAX);
  assert.equal(vfovForLens(null, 1.5), DEFAULT_VFOV);
});

test('a view names the lens it shows, and a window change keeps a preset recognisable', () => {
  for (const lens of LENSES) for (const aspect of [0.46, 0.75, 1, 1.2, 4 / 3, 1.6, 2.4]) {
    const v = vfovForLens(lens, aspect);
    close(lensTanOfView(v, aspect), lens.longTan, 1e-9, `${lens.id} at ${aspect}`);
    const d = describeView(v, aspect);
    assert.equal(d.preset, lens, `${lens.id} at ${aspect}`);
    close(d.f35, lens.f35, 1e-9);
  }
  // Tiksi's 50-degree default in a 16:10 window is none of them.
  const d = describeView(DEFAULT_VFOV, 1.6);
  assert.equal(d.preset, null);
  assert.ok(d.f35 > 24 && d.f35 < 48, 'default is between 1x and 2x: ' + d.f35);
  assert.equal(describeView(50, 0), null);
});

test('dragging up narrows the view, down widens it, by the same factor anywhere, within limits', () => {
  const up = dragFov(50, -100, 800), down = dragFov(50, 100, 800);
  assert.ok(up < 50 && down > 50, `${up} / ${down}`);
  // Up then down by the same distance comes back.
  close(dragFov(up, 100, 800), 50, 1e-9);
  // The same drag changes the tangent by the same factor at 20 and at 80 degrees.
  const ratio = v => Math.tan(dragFov(v, -200, 800) / 2 * DEG) / Math.tan(v / 2 * DEG);
  close(ratio(20), ratio(80), 1e-12);
  close(ratio(40), Math.exp(-0.5), 1e-12);
  assert.equal(dragFov(50, -1e6, 800), VFOV_MIN);
  assert.equal(dragFov(50, 1e6, 800), VFOV_MAX);
  assert.equal(dragFov(50, 30, 0), 50, 'no window, no change');
});

test('the outline is the 4:3 picture fitted and centred in the window', () => {
  assert.deepEqual(lensFrameRect(1600, 900), { x: 200, y: 0, w: 1200, h: 900 });
  assert.deepEqual(lensFrameRect(800, 600), { x: 0, y: 0, w: 800, h: 600 });
  const r = lensFrameRect(390, 844);   // a portrait phone: the picture stands upright
  close(r.w, 390, 1e-9); close(r.h, 520, 1e-9); close(r.y, 162, 1e-9);
  assert.equal(lensFrameRect(0, 600), null);
});
