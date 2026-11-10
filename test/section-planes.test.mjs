// Section planes: where each kind starts, snapping, sliding, cutting a wall solid, and what a saved view keeps.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SECTION_KINDS, MAX_SECTIONS, startQuat, planeNormal, planeOf, flipped, rangeAlong, nearestOnPlane, movedTo,
  moveSnapStep, snapTo, cutPrism, makeSection, normalizeSections, levelHeightOf, quatMul,
} from '../js/section-planes.js';
import { normalizeSavedView } from '../js/saved-views.js';

const near = (a, b, eps = 1e-9) => assert.ok(a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < eps), `${JSON.stringify(a)} is not ${JSON.stringify(b)}`);
const box = { min: [0, 0, 0], max: [8, 2.7, 6] };

test('each kind starts cutting away the top, one side, the front, or the side nearest the camera', () => {
  near(planeNormal(startQuat('level')), [0, 1, 0]);
  near(planeNormal(startQuat('side')), [1, 0, 0]);
  near(planeNormal(startQuat('front')), [0, 0, 1]);
  // Looking along -x from the east: the custom plane faces back at the camera.
  near(planeNormal(startQuat('custom', [-1, -0.4, 0], false)), [1, 0, 0]);
  // Looking straight down gives no compass direction: it starts like a front cut.
  near(planeNormal(startQuat('custom', [0, -1, 0], true)), [0, 0, 1]);
});

test('a custom plane placed with snapping on lands on a 15 degree compass angle', () => {
  const rad = d => d * Math.PI / 180;
  const loose = planeNormal(startQuat('custom', [-Math.sin(rad(37)), -0.3, -Math.cos(rad(37))], false));
  near(loose, [Math.sin(rad(37)), 0, Math.cos(rad(37))]);
  const snapped = planeNormal(startQuat('custom', [-Math.sin(rad(37)), -0.3, -Math.cos(rad(37))], true));
  near(snapped, [Math.sin(rad(30)), 0, Math.cos(rad(30))]);   // 37 is nearer 30 than 45
});

test('snapping steps: 5 cm in metric, one inch in feet and inches, and off leaves the value alone', () => {
  assert.equal(moveSnapStep('metric'), 0.05);
  assert.equal(moveSnapStep('imperial'), 0.0254);
  assert.ok(Math.abs(snapTo(1.234, 0.05) - 1.25) < 1e-12);
  assert.ok(Math.abs(snapTo(1.0, 0.0254) - 39 * 0.0254) < 1e-12);   // 1 m is 39.37 in
  assert.equal(snapTo(1.234, 0), 1.234);
});

test('a plane slides along its own normal, flips to cut the other side, and reports its reach across the model', () => {
  const s = makeSection('side', [4, 1.35, 3]);
  near(rangeAlong(planeNormal(s.q), box), [0, 8]);
  s.pos = movedTo(s, 2.5);
  near(s.pos, [2.5, 1.35, 3]);
  assert.ok(Math.abs(planeOf(s).d - 2.5) < 1e-12);
  near(nearestOnPlane(s, [7, 0, 1]), [2.5, 0, 1]);
  const f = { ...s, q: flipped(s.q) };
  near(planeNormal(f.q), [-1, 0, 0]);
  assert.ok(Math.abs(planeOf(f).d + 2.5) < 1e-12, 'the flipped plane is the same sheet seen from the other side');
  // A plane turned 45 degrees reaches corner to corner.
  const q45 = [0, Math.sin(Math.PI / 8), 0, Math.cos(Math.PI / 8)];
  const [lo, hi] = rangeAlong(planeNormal(q45), box);
  assert.ok(Math.abs(lo) < 1e-9 && Math.abs(hi - 14 * Math.SQRT1_2) < 1e-9);
});

test('cutting a wall solid: flat, upright and leaning planes each give one polygon; a miss gives none', () => {
  // A wall piece 4 m long, 0.2 m thick, 2.7 m tall.
  const fp = [[0, -0.1], [4, -0.1], [4, 0.1], [0, 0.1]];
  const area = poly => {
    let a = [0, 0, 0];
    for (let i = 1; i + 1 < poly.length; i++) {
      const u = poly[i].map((c, k) => c - poly[0][k]), v = poly[i + 1].map((c, k) => c - poly[0][k]);
      a = [a[0] + u[1] * v[2] - u[2] * v[1], a[1] + u[2] * v[0] - u[0] * v[2], a[2] + u[0] * v[1] - u[1] * v[0]];
    }
    return Math.hypot(...a) / 2;
  };
  const flat = cutPrism(fp, 0, 2.7, [0, 1, 0], 1.2);
  assert.equal(flat.length, 4);
  assert.ok(flat.every(p => Math.abs(p[1] - 1.2) < 1e-12));
  assert.ok(Math.abs(area(flat) - 0.8) < 1e-9, 'a flat cut is the footprint: 4 m by 0.2 m');
  const across = cutPrism(fp, 0, 2.7, [1, 0, 0], 1.5);
  assert.ok(Math.abs(area(across) - 0.2 * 2.7) < 1e-9, 'a cut across the wall is its thickness by its height');
  const along = cutPrism(fp, 0, 2.7, [0, 0, 1], 0);
  assert.ok(Math.abs(area(along) - 4 * 2.7) < 1e-9, 'a cut along the middle of the wall is its length by its height');
  // Leaning 45 degrees: the cut through the 0.2 m thickness is 0.2 * sqrt(2) long on the slope.
  const lean = cutPrism(fp, 0, 2.7, [0, Math.SQRT1_2, Math.SQRT1_2], 1.2 * Math.SQRT1_2);
  assert.ok(Math.abs(area(lean) - 4 * 0.2 * Math.SQRT2) < 1e-9);
  assert.equal(cutPrism(fp, 0, 2.7, [0, 1, 0], 3), null, 'above the wall');
  assert.equal(cutPrism(fp, 0, 2.7, [1, 0, 0], -1), null, 'beside the wall');
  // The top face itself counts, as a flat cut exactly at the top of a level always has.
  assert.equal(cutPrism(fp, 0, 2.7, [0, 1, 0], 2.7).length, 4);
});

test('a saved view keeps its planes; bad ones are dropped and old views still read', () => {
  const good = makeSection('custom', [1, 2, 3], [0, 0, -1], true);
  const list = normalizeSections([good, { id: good.id, kind: 'nope', q: [0, 0, 0, 2], pos: [0, 0, 0] }, { q: [0, 0, 0, 0], pos: [0, 0, 0] }, { q: [0, 0, 0, 1], pos: [0, 'x', 0] }, null, 'x']);
  assert.equal(list.length, 2);
  assert.deepEqual(list[0], good);
  assert.notEqual(list[1].id, good.id, 'a repeated id gets a new one');
  assert.equal(list[1].kind, 'custom');
  near(list[1].q, [0, 0, 0, 1]);   // brought back to unit length
  assert.equal(normalizeSections(Array.from({ length: 20 }, () => makeSection('level', [0, 1, 0]))).length, MAX_SECTIONS);
  assert.deepEqual(normalizeSections('nothing'), []);

  const camera = { position: [5, 4, 6], target: [0, 1, 0], fov: 45 };
  const level = makeSection('level', [4, 1.1, 3]), side = makeSection('side', [2, 1, 3]);
  const v = normalizeSavedView({ name: 'Cut', camera, section: { on: true, height: 1.1, planes: [side, level], active: level.id } });
  assert.deepEqual(v.section, { on: true, height: 1.1, planes: [side, level], active: level.id });
  assert.equal(normalizeSavedView({ name: 'Cut', camera, section: { on: true, planes: [side], active: 'gone' } }).section.active, side.id);
  // A view saved before planes existed has one flat cut height and nothing else.
  assert.deepEqual(normalizeSavedView({ name: 'Old', camera, section: { on: true, height: 0.9 } }).section, { on: true, height: 0.9 });
  assert.equal(levelHeightOf([side, level]), 1.1);
  assert.equal(levelHeightOf([side]), null);
  assert.equal(levelHeightOf([{ ...level, q: flipped(level.q) }]), null, 'a flat cut seen from below is not the old top-off cut');
  assert.deepEqual(SECTION_KINDS, ['level', 'side', 'front', 'custom']);
  near(quatMul([0, 0, 0, 1], side.q), side.q);
});
