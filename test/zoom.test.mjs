// MODEL wheel zoom: each step moves the camera a share of its distance to the orbit target, so
// the target must be the surface under the cursor, not an old orbit pivot near the camera.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../vendor/three.module.min.js';
import { zoomTarget } from '../js/sketchup-nav.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, a + ' != ' + b);

// What OrbitControls does with a wheel step toward the cursor: the camera moves along the view
// by (1 - 0.95) of its distance to the target, never closer than minDistance.
function wheelIn(cam, target, minDistance) {
  const d = cam.distanceTo(target), next = Math.max(minDistance, d * 0.95);
  return cam.clone().add(target.clone().sub(cam).normalize().multiplyScalar(d - next));
}

test('zoom aims at the surface under the cursor, so it keeps going until close to that surface', () => {
  const wall = V(0, 1.5, -6);                  // a wall 6 m ahead
  let cam = V(0, 1.5, 0), target = V(0, 1.5, -0.4);   // an old orbit pivot 40 cm ahead
  // Without re-aiming, steps shrink toward the old pivot and stop 30 cm short of it.
  let stuck = cam.clone();
  for (let i = 0; i < 100; i++) stuck = wheelIn(stuck, target, 0.3);
  assert.ok(stuck.z > -0.11, 'stalled near the old pivot: ' + stuck.z);
  // Re-aimed at the wall each gesture, the same 100 steps reach it.
  for (let i = 0; i < 100; i++) {
    target = zoomTarget(cam, target, wall, true, 0.05) || target;
    cam = wheelIn(cam, target, 0.05);
  }
  assert.ok(cam.z < -5.9, 'reached the wall: ' + cam.z);
  assert.ok(cam.distanceTo(wall) >= 0.05 - 1e-9, 'and stops 5 cm from it');
});

test('the new target stays on the view axis, so the view does not jump', () => {
  const t = zoomTarget(V(0, 0, 0), V(0, 0, -1), V(0.8, 0.3, -3), true, 0.05);
  close(t.x, 0); close(t.y, 0); close(t.z, -3);
});

test('with nothing under the cursor, zooming in past a reached target carries on', () => {
  const t = zoomTarget(V(0, 0, 0), V(0, 0, -0.06), null, true, 0.05);
  close(t.z, -1.06);
  assert.equal(zoomTarget(V(0, 0, 0), V(0, 0, -3), null, true, 0.05), null, 'a target still far ahead is kept');
  assert.equal(zoomTarget(V(0, 0, 0), V(0, 0, -0.06), null, false, 0.05), null, 'zooming out keeps it');
  assert.equal(zoomTarget(V(0, 0, 0), V(0, 0, -1), V(0, 0, 2), true, 0.05)?.z, undefined, 'a point behind the camera is not a target');
});
