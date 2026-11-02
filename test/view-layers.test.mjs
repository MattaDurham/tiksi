import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../vendor/three.module.min.js';
import { scanLayer, layerShown, setLayerShown, meshFootprints, footprintsOnLevel } from '../js/view-layers.js';
import { looksLikeTrackpad, classifyWheel, pivotOnViewAxis } from '../js/sketchup-nav.js';

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

test('a layer toggle shows or hides every member and leaves other layers alone', () => {
  const prop = { scans: [
    { id: 'a', name: 'Polycam survey', kind: 'mesh', visible: false },
    { id: 'b', name: 'Fixtures', kind: 'mesh', visible: true },
    { id: 'c', name: 'Furniture', kind: 'mesh', visible: false },
    { id: 'd', name: 'Porch', kind: 'mesh', visible: true },
  ] };
  assert.equal(layerShown(prop, 'scan'), false);
  assert.equal(layerShown(prop, 'furnishings'), true);
  assert.deepEqual(setLayerShown(prop, 'furnishings', false).map(s => s.id), ['b']);
  assert.equal(layerShown(prop, 'furnishings'), false);
  assert.deepEqual(setLayerShown(prop, 'furnishings', true).map(s => s.id), ['b', 'c']);
  assert.deepEqual(setLayerShown(prop, 'scan', true).map(s => s.id), ['a']);
  assert.equal(prop.scans[3].visible, true);
  assert.equal(layerShown({ scans: [] }, 'scan'), false);
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

test('wheel events: mouse notches zoom, trackpad swipes orbit or pan with Shift, pinches zoom', () => {
  const mouse = { deltaX: 0, deltaY: 100, deltaMode: 0, wheelDeltaY: -120, wheelDeltaX: 0 };
  const pad = { deltaX: 0, deltaY: 7, deltaMode: 0, wheelDeltaY: -21, wheelDeltaX: 0 };
  const firefoxWheel = { deltaX: 0, deltaY: 3, deltaMode: 1 };
  assert.equal(looksLikeTrackpad(mouse), false);
  assert.equal(looksLikeTrackpad(pad), true);
  assert.equal(looksLikeTrackpad({ deltaX: 2, deltaY: 3, deltaMode: 0 }), true);
  assert.equal(looksLikeTrackpad(firefoxWheel), false);
  assert.equal(looksLikeTrackpad({ deltaX: 0, deltaY: 4, deltaMode: 0 }), true);

  assert.equal(classifyWheel(mouse, { at: 0 }, 1000), 'zoom');
  assert.equal(classifyWheel(pad, { at: 0 }, 1000), 'orbit');
  assert.equal(classifyWheel({ ...pad, shiftKey: true }, { at: 0 }, 1000), 'pan');
  assert.equal(classifyWheel(pad, { at: 0 }, 1000, { canOrbit: false }), 'pan');
  assert.equal(classifyWheel({ ...pad, ctrlKey: true }, { at: 0 }, 1000), 'zoom');

  // A gesture keeps its device: momentum that looks like a wheel stays a swipe until a pause.
  const latch = { at: 0 };
  assert.equal(classifyWheel(pad, latch, 1000), 'orbit');
  assert.equal(classifyWheel(mouse, latch, 1050), 'orbit');
  assert.equal(classifyWheel(mouse, latch, 1500), 'zoom');
});

test('the orbit pivot moves along the view axis to the depth of the point under the cursor', () => {
  const cam = new THREE.Vector3(0, 0, 10), target = new THREE.Vector3(0, 0, 0);
  const pivot = pivotOnViewAxis(cam, target, new THREE.Vector3(3, 2, 4), 0.3);
  assert.deepEqual(pivot.toArray(), [0, 0, 4]);
  assert.equal(pivotOnViewAxis(cam, target, new THREE.Vector3(0, 0, 12), 0.3), null);   // behind the camera
  assert.equal(pivotOnViewAxis(cam, target, new THREE.Vector3(0, 0, 9.9), 0.3), null);  // closer than the minimum
  assert.equal(pivotOnViewAxis(cam, cam.clone(), new THREE.Vector3(1, 1, 1)), null);
});
