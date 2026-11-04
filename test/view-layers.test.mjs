import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../vendor/three.module.min.js';
import { scanLayer, meshFootprints, footprintsOnLevel } from '../js/view-layers.js';
import { attachSketchupNavigation, pivotOnViewAxis } from '../js/sketchup-nav.js';

test('scans fall into scan, furnishings and model layers; an explicit layer wins', () => {
  assert.equal(scanLayer({ name: 'Polycam capture · survey', kind: 'mesh' }), 'scan');
  assert.equal(scanLayer({ name: 'Existing fixtures (photo-matched)', kind: 'mesh' }), 'furnishings');
  assert.equal(scanLayer({ name: 'Kitchen cabinets.glb', kind: 'mesh' }), 'furnishings');
  assert.equal(scanLayer({ name: 'Deck framing', kind: 'mesh' }), 'model');
  assert.equal(scanLayer({ name: 'garden.las', kind: 'points' }), 'scan');
  assert.equal(scanLayer({ name: 'room.spz', kind: 'splat' }), 'scan');
  assert.equal(scanLayer({ name: 'Porch overhead', kind: 'mesh', layer: 'furnishings' }), 'furnishings');
  assert.equal(scanLayer({ name: 'Existing fixtures', kind: 'mesh', layer: 'model' }), 'model');
  assert.equal(scanLayer({ name: 'Existing fixtures', kind: 'mesh', layer: 'bogus' }), 'furnishings');
});

test('mesh footprints are world-space outlines with heights, specks dropped, filtered by storey', () => {
  const root = new THREE.Group();
  root.position.set(10, 0, 0); root.rotation.y = Math.PI / 2;
  const vanity = new THREE.Mesh(new THREE.BoxGeometry(1, 0.8, 0.5)); vanity.name = 'Bath | vanity'; vanity.position.set(0, 0.4, 0); root.add(vanity);
  const knob = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.02, 0.02)); knob.name = 'Bath | knob'; knob.position.set(0, 0.6, 0.3); root.add(knob);
  const upstairs = new THREE.Mesh(new THREE.BoxGeometry(2, 0.5, 1)); upstairs.name = 'Bed'; upstairs.position.set(0, 3.25, 0); root.add(upstairs);
  const pick = new THREE.Mesh(new THREE.BoxGeometry(5, 5, 5)); pick.userData.pickBox = true; root.add(pick);
  const fps = meshFootprints(root);
  assert.deepEqual(fps.map(f => f.name), ['Bath | vanity', 'Bed']);
  const v = fps[0];
  assert.equal(v.pts.length, 4);
  // Rotated a quarter turn: the 1 m width now runs along world Z (plan y), centred on x = 10.
  const xs = v.pts.map(p => p[0]), ys = v.pts.map(p => p[1]);
  assert.ok(Math.abs(Math.min(...xs) - 9.75) < 1e-6 && Math.abs(Math.max(...xs) - 10.25) < 1e-6);
  assert.ok(Math.abs(Math.min(...ys) + 0.5) < 1e-6 && Math.abs(Math.max(...ys) - 0.5) < 1e-6);
  assert.ok(Math.abs(v.y0) < 1e-6 && Math.abs(v.y1 - 0.8) < 1e-6);
  assert.deepEqual(footprintsOnLevel(fps, 0, 2.7).map(f => f.name), ['Bath | vanity']);
  assert.deepEqual(footprintsOnLevel(fps, 3, 2.7).map(f => f.name), ['Bed']);
});

// Synthetic stand-ins for OrbitControls and the DOM: just what the navigation reads.
function fakeNav({ canOrbit = true } = {}) {
  globalThis.window = new EventTarget();
  const calls = [];
  const controls = {
    domElement: new EventTarget(), enabled: true, enablePan: true, enableRotate: true, state: -1,
    mouseButtons: {}, object: { position: new THREE.Vector3(0, 0, 10) }, target: new THREE.Vector3(), minDistance: 0.3,
    _handleMouseDownPan: at => calls.push(['pan', at.clientX, at.clientY]),
    _handleMouseDownRotate: at => calls.push(['rotate', at.clientX, at.clientY]),
    update() {},
  };
  let orbit = canOrbit;
  const nav = attachSketchupNavigation(controls, { pickPoint: () => null, canOrbit: () => orbit });
  return { controls, calls, nav, setOrbit: v => { orbit = v; } };
}
const ev = (type, props) => Object.assign(new Event(type, { cancelable: true }), props);

test('model mouse: left drag orbits, right drag pans; with orbit off every drag pans', () => {
  const { controls, nav, setOrbit } = fakeNav();
  assert.deepEqual(controls.mouseButtons, { LEFT: 0, MIDDLE: 0, RIGHT: 2 });
  setOrbit(false); nav.refresh();
  assert.deepEqual(controls.mouseButtons, { LEFT: 2, MIDDLE: 2, RIGHT: 2 });
  nav.dispose();
});

test('model mouse: the wheel is never taken over, so every wheel event zooms', () => {
  const { controls, nav } = fakeNav();
  let reached = 0;
  controls.domElement.addEventListener('wheel', () => { reached++; });
  // A Mac mouse wheel and a trackpad swipe can report the same numbers; neither is diverted.
  for (const props of [{ deltaX: 0, deltaY: 4, deltaMode: 0, wheelDeltaY: -12 }, { deltaX: 0, deltaY: 100, deltaMode: 0, wheelDeltaY: -120 }, { deltaX: 3, deltaY: 7, deltaMode: 0 }]) {
    const e = ev('wheel', props);
    controls.domElement.dispatchEvent(e);
    assert.equal(e.defaultPrevented, false);
  }
  assert.equal(reached, 3);
  nav.dispose();
});

test('model mouse: Shift pressed mid-drag switches orbit to pan at the pointer, releasing it orbits again', () => {
  const { controls, calls, nav } = fakeNav();
  controls.domElement.dispatchEvent(ev('pointerdown', { button: 0, pointerType: 'mouse', clientX: 100, clientY: 50 }));
  controls.state = 0;                       // OrbitControls starts its orbit
  controls.domElement.dispatchEvent(ev('pointermove', { clientX: 120, clientY: 60 }));
  window.dispatchEvent(ev('keydown', { key: 'Shift', shiftKey: true }));
  assert.equal(controls.state, 2);
  window.dispatchEvent(ev('keyup', { key: 'Shift', shiftKey: false }));
  assert.equal(controls.state, 0);
  assert.deepEqual(calls, [['pan', 120, 60], ['rotate', 120, 60]]);
  // After release, Shift does nothing.
  window.dispatchEvent(ev('pointerup', {}));
  window.dispatchEvent(ev('keydown', { key: 'Shift', shiftKey: true }));
  assert.equal(controls.state, 0);
  nav.dispose();
});

test('the orbit pivot moves along the view axis to the depth of the point under the cursor', () => {
  const cam = new THREE.Vector3(0, 0, 10), target = new THREE.Vector3(0, 0, 0);
  const pivot = pivotOnViewAxis(cam, target, new THREE.Vector3(3, 2, 4), 0.3);
  assert.deepEqual(pivot.toArray(), [0, 0, 4]);
  assert.equal(pivotOnViewAxis(cam, target, new THREE.Vector3(0, 0, 12), 0.3), null);   // behind the camera
  assert.equal(pivotOnViewAxis(cam, target, new THREE.Vector3(0, 0, 9.9), 0.3), null);  // closer than the minimum
  assert.equal(pivotOnViewAxis(cam, cam.clone(), new THREE.Vector3(1, 1, 1)), null);
});
