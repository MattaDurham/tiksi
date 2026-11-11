// MODEL's navigation with fingers (js/sketchup-nav.js): one finger always moves the view, a
// pinch aims at what is between the fingers, and closing MODEL removes every listener.
// Synthetic stand-ins for OrbitControls and the DOM: just what the navigation reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../vendor/three.module.min.js';
import { attachSketchupNavigation } from '../js/sketchup-nav.js';

// An event target that counts the listeners it holds.
class Counted extends EventTarget {
  held = 0;
  addEventListener(...a) { this.held++; super.addEventListener(...a); }
  removeEventListener(...a) { this.held--; super.removeEventListener(...a); }
}
function fakeNav({ canOrbit = true, pickPoint = () => null } = {}) {
  globalThis.window = new Counted();
  const camera = { position: new THREE.Vector3(0, 0, 10), lookedAt: null, lookAt(p) { this.lookedAt = p.clone(); } };
  const controls = {
    domElement: new Counted(), enabled: true, enablePan: true, enableRotate: true, enableZoom: true, state: -1,
    mouseButtons: {}, touches: { ONE: 0, TWO: 2 }, object: camera, target: new THREE.Vector3(0, 0, 8), minDistance: 0.3,
    update() {},
  };
  let orbit = canOrbit, picks = [];
  const nav = attachSketchupNavigation(controls, { pickPoint: e => { picks.push([e.clientX, e.clientY]); return pickPoint(e); }, canOrbit: () => orbit });
  return { controls, nav, picks, setOrbit: v => { orbit = v; } };
}
const ev = (type, props) => Object.assign(new Event(type, { cancelable: true }), props);
const finger = (type, id, x, y) => ev(type, { pointerType: 'touch', pointerId: id, clientX: x, clientY: y, button: 0 });

test('one finger orbits, and pans where orbiting is off (Top view)', () => {
  const { controls, nav, setOrbit } = fakeNav();
  assert.equal(controls.touches.ONE, THREE.TOUCH.ROTATE);
  setOrbit(false); nav.refresh();
  assert.equal(controls.touches.ONE, THREE.TOUCH.PAN, 'in Top view one finger pans');
  assert.equal(controls.touches.TWO, THREE.TOUCH.DOLLY_PAN, 'two fingers still pinch and pan');
  setOrbit(true); nav.refresh();
  assert.equal(controls.touches.ONE, THREE.TOUCH.ROTATE);
  nav.dispose();
});

test('a pinch aims once at the surface between the two fingers', () => {
  // The surface under the fingers is 30 m away; the old target sits 2 m in front of the camera.
  const { controls, nav, picks } = fakeNav({ pickPoint: () => new THREE.Vector3(1, 0.5, -20) });
  controls.domElement.dispatchEvent(finger('pointerdown', 1, 100, 300));
  assert.equal(picks.length, 0, 'one finger tests nothing');
  assert.equal(controls.target.z, 8);
  controls.domElement.dispatchEvent(finger('pointermove', 1, 120, 320));
  controls.domElement.dispatchEvent(finger('pointerdown', 2, 220, 420));
  assert.deepEqual(picks, [[170, 370]], 'the point between the fingers, where the first finger is now');
  assert.ok(Math.abs(controls.target.z - -20) < 1e-9 && controls.target.x === 0 && controls.target.y === 0, 'the target moves to the surface\'s depth on the view axis (no sideways jump)');
  controls.domElement.dispatchEvent(finger('pointermove', 2, 260, 460));
  assert.equal(picks.length, 1, 'moving the fingers tests nothing more');
  // Lifting and pinching again aims again.
  window.dispatchEvent(finger('pointerup', 2, 260, 460));
  controls.domElement.dispatchEvent(finger('pointerdown', 3, 300, 300));
  assert.equal(picks.length, 2);
  nav.dispose();
});

test('a pinch over nothing, with the target reached, pushes the target ahead so the pinch keeps moving', () => {
  const { controls, nav } = fakeNav();
  controls.target.set(0, 0, 9.9);     // 10 cm in front of the camera
  controls.domElement.dispatchEvent(finger('pointerdown', 1, 100, 300));
  controls.domElement.dispatchEvent(finger('pointerdown', 2, 200, 400));
  assert.ok(controls.target.z < 9, 'the target is pushed ahead of the camera (' + controls.target.z + ')');
  nav.dispose();
});

test('a pinch with zoom switched off, or a cancelled finger, aims at nothing', () => {
  const { controls, nav, picks } = fakeNav({ pickPoint: () => new THREE.Vector3(0, 0, -20) });
  controls.enableZoom = false;
  controls.domElement.dispatchEvent(finger('pointerdown', 1, 100, 300));
  controls.domElement.dispatchEvent(finger('pointerdown', 2, 200, 400));
  assert.equal(picks.length, 0);
  controls.enableZoom = true;
  window.dispatchEvent(finger('pointercancel', 1, 0, 0));
  window.dispatchEvent(finger('pointercancel', 2, 0, 0));
  controls.domElement.dispatchEvent(finger('pointerdown', 4, 100, 300));
  assert.equal(picks.length, 0, 'the cancelled fingers are forgotten: this is one finger again');
  nav.dispose();
});

test('closing the navigation removes every listener it added', () => {
  const { controls, nav, picks } = fakeNav({ pickPoint: () => new THREE.Vector3(0, 0, -20) });
  assert.ok(controls.domElement.held > 0 && window.held > 0);
  nav.dispose();
  assert.equal(controls.domElement.held, 0, 'none left on the canvas');
  assert.equal(window.held, 0, 'none left on the window');
  controls.domElement.dispatchEvent(ev('wheel', { deltaY: -100, clientX: 10, clientY: 10 }));
  controls.domElement.dispatchEvent(finger('pointerdown', 1, 100, 300));
  controls.domElement.dispatchEvent(finger('pointerdown', 2, 200, 400));
  assert.equal(picks.length, 0, 'and nothing is tested after it');
});
