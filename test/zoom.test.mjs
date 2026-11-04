// MODEL navigation. Wheel zoom: each step moves the camera a share of its distance to the orbit
// target, so the target must be the surface under the cursor, not an old orbit pivot near the
// camera. Orbit: the drag turns about the exact pressed point, which stays put on screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../vendor/three.module.min.js';
import { zoomTarget, orbitAbout } from '../js/sketchup-nav.js';

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

// Where a world point lands on screen (normalised device coordinates) for a camera at `pos`
// looking at `target`, upright.
function onScreen(pos, target, point) {
  const cam = new THREE.PerspectiveCamera(50, 1.5, 0.01, 100);
  cam.position.copy(pos); cam.lookAt(target); cam.updateMatrixWorld();
  return point.clone().project(cam);
}

test('an orbit turns about the pressed point, which stays where it is on screen', () => {
  // Standing at the front, pressing on a spot at the back of the house, off to one side.
  let pos = V(0, 1.6, 8), target = V(0, 1.2, 2);
  const pressed = V(2.5, 0.9, -4);
  const before = onScreen(pos, target, pressed);
  for (let i = 0; i < 30; i++) ({ position: pos, target } = orbitAbout(pos, target, pressed, 0.1, 0.01, 0, Math.PI * 0.495));
  const after = onScreen(pos, target, pressed);
  close(after.x, before.x, 1e-6); close(after.y, before.y, 1e-6);
  close(pos.distanceTo(pressed), V(0, 1.6, 8).distanceTo(pressed), 1e-9, 'the camera keeps its distance from the pressed point');
  assert.ok(pos.z < 0, 'three radians of turn bring the camera round to the back: ' + pos.toArray());
});

test('an orbit never tips the view past its limits', () => {
  const pos = V(0, 1, 5), target = V(0, 1, 0), pivot = V(0, 1, 0);
  // Pitching the camera down below the target's level is refused at the 0.495 pi limit; yaw still turns.
  const r = orbitAbout(pos, target, pivot, 0.2, 0.3, 0, Math.PI * 0.495);
  close(r.position.y, 1, 1e-9);
  assert.ok(Math.abs(r.position.x) > 0.5, 'the yaw is kept');
  const up = orbitAbout(pos, target, pivot, 0, -0.3, 0, Math.PI * 0.495);
  assert.ok(up.position.y > 1, 'tilting up and over is allowed');
});
