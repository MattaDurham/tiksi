// SketchUp-style navigation on top of three's OrbitControls (vendored, so its underscore
// methods are pinned with it):
//   left or middle drag orbits, Shift + drag pans (switching mid-drag as Shift goes down
//   or up), right drag pans, and the wheel (or a pinch) always zooms toward the cursor.
// An orbit turns about the exact point you press on, as SketchUp's does: that point stays where it
// is on screen while the model swings round it, so pressing on the back of the house and dragging
// brings you round to it. Zooming aims at the surface under the cursor too:
// OrbitControls moves the camera a share of its distance to the orbit target per wheel step, so
// with the target left at an old pivot the steps shrank to nothing near that point while the
// thing under the cursor was still far off. Each zoom gesture re-aims at the surface under the
// cursor, so the steps follow the distance to what you are zooming toward.
//
// Fingers: one finger orbits, or pans where orbiting is off (Top view), so a finger always moves
// the view. A pinch re-aims the same way a wheel gesture does, once, when the second finger
// lands, at the surface between the two fingers: without that a pinch closed in on an old pivot
// and stalled there however far the thing under the fingers still was.
const ROTATE = 0, PAN = 2;                // OrbitControls' internal drag states
const TOUCH_ROTATE = 0, TOUCH_PAN = 1;    // three's TOUCH.ROTATE and TOUCH.PAN

// The orbit pivot for a point under the cursor: the point at the same depth on the view
// axis, so the camera turns about that depth without the view jumping sideways.
export function pivotOnViewAxis(cameraPos, target, hitPoint, minDistance = 0) {
  const axis = target.clone().sub(cameraPos);
  const len = axis.length();
  if (!(len > 0)) return null;
  axis.divideScalar(len);
  const depth = hitPoint.clone().sub(cameraPos).dot(axis);
  if (!(depth > minDistance)) return null;
  return cameraPos.clone().addScaledVector(axis, depth);
}

// One step of an orbit about `pivot`: the camera position and the orbit target both turn about
// the pivot, `yaw` radians about the vertical and `pitch` radians about the camera's right axis
// (positive tilts the camera down and round, as OrbitControls' drag does). The pitch is dropped
// when it would take the view past the controls' polar limits. Returns { position, target }.
export function orbitAbout(position, target, pivot, yaw, pitch, minPolar = 0, maxPolar = Math.PI) {
  const Y = position.clone().set(0, 1, 0);
  const turn = (v, axis, angle) => v.clone().sub(pivot).applyAxisAngle(axis, angle).add(pivot);
  let pos = turn(position, Y, yaw), tgt = turn(target, Y, yaw);
  const view = tgt.clone().sub(pos);
  const right = view.clone().cross(Y);
  if (pitch && right.lengthSq() > 1e-12) {
    right.normalize();
    const p2 = turn(pos, right, pitch), t2 = turn(tgt, right, pitch);
    const off = p2.clone().sub(t2), len = off.length();
    const phi = len > 0 ? Math.acos(Math.max(-1, Math.min(1, off.y / len))) : 0;
    if (phi > minPolar + 1e-3 && phi < maxPolar - 1e-3) { pos = p2; tgt = t2; }
  }
  return { position: pos, target: tgt };
}

// The orbit target for a wheel step: the surface under the cursor (at its depth on the view
// axis). With nothing under the cursor, zooming in with the target nearly reached pushes the
// target `ahead` metres forward, so the camera keeps moving instead of stalling against it.
export function zoomTarget(cameraPos, target, hitPoint, zoomingIn, minDistance = 0, ahead = 1) {
  if (hitPoint) {
    const pivot = pivotOnViewAxis(cameraPos, target, hitPoint, minDistance);
    if (pivot) return pivot;
  }
  if (!zoomingIn) return null;
  const axis = target.clone().sub(cameraPos), len = axis.length();
  if (!(len > 0) || len > Math.max(minDistance * 2, 0.25)) return null;
  return cameraPos.clone().addScaledVector(axis.divideScalar(len), len + ahead);
}

// Wire it up. `pickPoint(event)` returns the world point under the cursor or null; `canOrbit()`
// says whether the current mode allows orbiting. Returns a function that removes it all.
export function attachSketchupNavigation(controls, { pickPoint, canOrbit = () => true, oneFinger = () => true, onChange }) {
  const el = controls.domElement;
  let drag = null;                        // { base, x, y } while a mouse button is down
  controls.zoomToCursor = true;
  controls.screenSpacePanning = true;

  function setButtons() {
    const a = canOrbit() ? ROTATE : PAN;
    controls.mouseButtons.LEFT = a;
    controls.mouseButtons.MIDDLE = a;
    controls.mouseButtons.RIGHT = PAN;
    // `oneFinger()` false: a single finger is doing something else (drawing a markup), so it
    // neither turns nor pans; two fingers still zoom and pan.
    if (controls.touches) controls.touches.ONE = !oneFinger() ? -1 : canOrbit() ? TOUCH_ROTATE : TOUCH_PAN;
  }
  setButtons();

  // Where each finger on the view is, so a pinch can aim at the point between two of them.
  const fingers = new Map();
  function onFingerDown(e) {
    setButtons();
    fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (fingers.size !== 2 || !controls.enabled || !controls.enableZoom) return;
    const [p, q] = [...fingers.values()];
    const cam = controls.object.position;
    const hit = pickPoint({ clientX: (p.x + q.x) / 2, clientY: (p.y + q.y) / 2 });
    const next = zoomTarget(cam, controls.target, hit, true, controls.minDistance);
    if (next) { controls.target.copy(next); controls.object.lookAt(next); }
  }
  function onFingerMove(e) { const f = fingers.get(e.pointerId); if (f) { f.x = e.clientX; f.y = e.clientY; } }
  function onFingerUp(e) { fingers.delete(e.pointerId); }

  // Capture phase: runs before OrbitControls reads the press, so the buttons are current.
  function onDown(e) {
    if (e.pointerType === 'touch') { onFingerDown(e); return; }
    if (!controls.enabled || e.pointerType !== 'mouse' && e.pointerType !== 'pen') return;
    setButtons();
    const base = e.button === 0 ? controls.mouseButtons.LEFT : e.button === 1 ? controls.mouseButtons.MIDDLE : e.button === 2 ? controls.mouseButtons.RIGHT : -1;
    // The pivot waits for a real drag: a plain click never pays for a raycast into a big scan.
    const orbit = base === ROTATE && !e.shiftKey && !e.ctrlKey && !e.metaKey;
    drag = { base, x: e.clientX, y: e.clientY, pivotFrom: orbit ? { clientX: e.clientX, clientY: e.clientY } : null };
    if (e.button === 1) e.preventDefault();          // no autoscroll on middle press
  }
  function onMove(e) {
    if (e.pointerType === 'touch') { onFingerMove(e); return; }
    if (!drag) return;
    drag.x = e.clientX; drag.y = e.clientY;
    const from = drag.pivotFrom;
    if (!from || Math.hypot(e.clientX - from.clientX, e.clientY - from.clientY) < 4) return;
    drag.pivotFrom = null;
    if (controls.state !== ROTATE) return;
    const hit = pickPoint(from);
    // The orbit target moves to the pressed point's depth on the view axis (no jump), and the
    // drag then turns about the pressed point itself; OrbitControls only pans and zooms meanwhile.
    const onAxis = hit && pivotOnViewAxis(controls.object.position, controls.target, hit, controls.minDistance);
    if (!onAxis) return;
    controls.target.copy(onAxis);
    controls._sphericalDelta.set(0, 0, 0);
    controls.enableRotate = false;
    drag.pivot = hit.clone(); drag.last = { x: e.clientX, y: e.clientY };
    controls.update();
  }
  function onPivotMove(e) {
    if (!drag || !drag.pivot || controls.enableRotate) return;
    const h = el.clientHeight || 1, k = 2 * Math.PI * controls.rotateSpeed / h;
    const dx = e.clientX - drag.last.x, dy = e.clientY - drag.last.y;
    drag.last = { x: e.clientX, y: e.clientY };
    if (!dx && !dy) return;
    const cam = controls.object;
    const next = orbitAbout(cam.position, controls.target, drag.pivot, -k * dx, -k * dy, controls.minPolarAngle, controls.maxPolarAngle);
    cam.position.copy(next.position); controls.target.copy(next.target);
    controls.update();
    if (onChange) onChange();
  }
  function endPivot() {
    if (drag && drag.pivot) { drag.pivot = null; controls.enableRotate = true; }
  }
  function onUp() { endPivot(); drag = null; }

  // Before OrbitControls handles a wheel step (capture phase), aim the zoom at the surface under
  // the cursor. One raycast per gesture: steps that follow within 150 ms at the same spot reuse
  // the target OrbitControls keeps in front of the camera, so a long scroll over a big scan stays
  // smooth.
  let lastWheel = null;
  function onWheel(e) {
    if (!controls.enabled || !controls.enableZoom || !e.deltaY) return;
    const now = performance.now();
    const same = lastWheel && now - lastWheel.t < 150 && Math.hypot(e.clientX - lastWheel.x, e.clientY - lastWheel.y) < 6;
    lastWheel = { t: now, x: e.clientX, y: e.clientY };
    const cam = controls.object.position;
    const near = controls.target.distanceTo(cam) < Math.max(controls.minDistance * 2, 0.25);
    if (same && !near) return;
    const hit = same ? null : pickPoint(e);
    const next = zoomTarget(cam, controls.target, hit, e.deltaY < 0, controls.minDistance);
    if (next) { controls.target.copy(next); controls.object.lookAt(next); }
  }

  // Shift down or up mid-drag swaps orbit and pan from where the pointer is now.
  function onShift(e) {
    if (e.key !== 'Shift' || !drag || drag.base !== ROTATE) return;
    const at = { clientX: drag.x, clientY: drag.y };
    if (e.shiftKey && drag.pivot) endPivot();
    if (e.shiftKey && controls.state === ROTATE && controls.enablePan) {
      controls._handleMouseDownPan(at); controls.state = PAN;
    } else if (!e.shiftKey && controls.state === PAN && controls.enableRotate) {
      controls._handleMouseDownRotate(at); controls.state = ROTATE;
    }
  }

  el.addEventListener('pointerdown', onDown, { capture: true });
  el.addEventListener('pointermove', onMove);
  window.addEventListener('pointermove', onPivotMove);
  el.addEventListener('wheel', onWheel, { capture: true, passive: true });
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointerup', onFingerUp);
  window.addEventListener('pointercancel', onFingerUp);
  window.addEventListener('keydown', onShift);
  window.addEventListener('keyup', onShift);
  return {
    refresh: setButtons,
    dispose() {
      el.removeEventListener('pointerdown', onDown, { capture: true });
      el.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointermove', onPivotMove);
      el.removeEventListener('wheel', onWheel, { capture: true });
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointerup', onFingerUp);
      window.removeEventListener('pointercancel', onFingerUp);
      window.removeEventListener('keydown', onShift);
      fingers.clear();
      window.removeEventListener('keyup', onShift);
    },
  };
}
