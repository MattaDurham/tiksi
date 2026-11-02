// SketchUp-style navigation on top of three's OrbitControls (vendored, so its underscore
// methods are pinned with it):
//   mouse     left or middle drag orbits, Shift + drag pans (switching mid-drag as Shift
//             goes down or up), right drag pans, the wheel zooms toward the cursor
//   trackpad  two-finger swipe orbits, Shift + swipe pans, pinch zooms toward the cursor
// Orbits pivot about the surface under the cursor, as SketchUp's do.
const ROTATE = 0, PAN = 2;                // OrbitControls' internal drag states
const GESTURE_GAP_MS = 180;               // a pause this long ends one wheel gesture

// Is this wheel event from a trackpad swipe rather than a mouse wheel? Chrome and Safari
// report a trackpad's pixel deltas with wheelDelta exactly -3x delta; a wheel's notches
// arrive as multiples of 120 that do not match. Firefox has no wheelDelta: pixel-mode
// deltas there are trackpads, line-mode ones are wheels. Both axes moving is a trackpad.
export function looksLikeTrackpad(e) {
  if (e.deltaX && e.deltaY) return true;
  const wy = e.wheelDeltaY, wx = e.wheelDeltaX;
  if (wy || wx) {
    if (wy && wy === -3 * e.deltaY && Math.abs(wy) % 120 !== 0) return true;
    if (wx && wx === -3 * e.deltaX && Math.abs(wx) % 120 !== 0) return true;
    return false;
  }
  return e.deltaMode === 0;
}

// What a wheel event does: 'zoom' (left to OrbitControls), 'orbit' or 'pan'. One gesture
// keeps the kind of device it started with, so trackpad momentum never flips to zooming.
export function classifyWheel(e, latch, now, { canOrbit = true } = {}) {
  if (e.ctrlKey || e.metaKey) return 'zoom';          // pinch arrives as Ctrl + wheel
  if (!latch.at || now - latch.at > GESTURE_GAP_MS) latch.trackpad = looksLikeTrackpad(e);
  latch.at = now;
  if (!latch.trackpad) return 'zoom';
  return e.shiftKey || !canOrbit ? 'pan' : 'orbit';
}

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

// Wire it up. `pickPoint(event)` returns the world point under the cursor or null; `canOrbit()`
// says whether the current mode allows orbiting. Returns a function that removes it all.
export function attachSketchupNavigation(controls, { pickPoint, canOrbit = () => true, onChange }) {
  const el = controls.domElement;
  const latch = { at: 0, trackpad: false };
  let drag = null;                        // { base, x, y } while a mouse button is down
  controls.zoomToCursor = true;
  controls.screenSpacePanning = true;

  function setButtons() {
    const a = canOrbit() ? ROTATE : PAN;
    controls.mouseButtons.LEFT = a;
    controls.mouseButtons.MIDDLE = a;
    controls.mouseButtons.RIGHT = PAN;
  }
  setButtons();

  // Capture phase: runs before OrbitControls reads the press, so the pivot is set first.
  function onDown(e) {
    if (!controls.enabled || e.pointerType !== 'mouse' && e.pointerType !== 'pen') return;
    setButtons();
    const base = e.button === 0 ? controls.mouseButtons.LEFT : e.button === 1 ? controls.mouseButtons.MIDDLE : e.button === 2 ? controls.mouseButtons.RIGHT : -1;
    drag = { base, x: e.clientX, y: e.clientY };
    if (e.button === 1) e.preventDefault();          // no autoscroll on middle press
    if (base !== ROTATE || e.shiftKey || e.ctrlKey || e.metaKey) return;
    const hit = pickPoint(e);
    const pivot = hit && pivotOnViewAxis(controls.object.position, controls.target, hit, controls.minDistance);
    if (pivot) { controls.target.copy(pivot); controls.update(); }
  }
  function onMove(e) { if (drag) { drag.x = e.clientX; drag.y = e.clientY; } }
  function onUp() { drag = null; }

  // Shift down or up mid-drag swaps orbit and pan from where the pointer is now.
  function onShift(e) {
    if (e.key !== 'Shift' || !drag || drag.base !== ROTATE) return;
    const at = { clientX: drag.x, clientY: drag.y };
    if (e.shiftKey && controls.state === ROTATE && controls.enablePan) {
      controls._handleMouseDownPan(at); controls.state = PAN;
    } else if (!e.shiftKey && controls.state === PAN && controls.enableRotate) {
      controls._handleMouseDownRotate(at); controls.state = ROTATE;
    }
  }

  function onWheel(e) {
    if (!controls.enabled) return;
    const kind = classifyWheel(e, latch, performance.now(), { canOrbit: canOrbit() && controls.enableRotate });
    if (kind === 'zoom') return;                     // OrbitControls zooms toward the cursor
    e.preventDefault(); e.stopImmediatePropagation();
    // Mac turns Shift + vertical scroll into horizontal; either axis moves the view.
    let dx = e.deltaX, dy = e.deltaY;
    if (e.deltaMode === 1) { dx *= 16; dy *= 16; }
    if (kind === 'pan') {
      controls._pan(-dx, -dy);
    } else {
      // Half the drag rate: a swipe and its momentum travel further than a mouse drag.
      const k = Math.PI * controls.rotateSpeed / (el.clientHeight || 1);
      controls._rotateLeft(k * -dx);
      controls._rotateUp(k * -dy);
    }
    // Swipes arrive at display rate already: apply each step in full rather than easing it.
    const damping = controls.enableDamping;
    controls.enableDamping = false;
    controls.update();
    controls.enableDamping = damping;
    onChange && onChange();
  }

  el.addEventListener('pointerdown', onDown, { capture: true });
  el.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('keydown', onShift);
  window.addEventListener('keyup', onShift);
  el.addEventListener('wheel', onWheel, { capture: true, passive: false });
  return {
    refresh: setButtons,
    dispose() {
      el.removeEventListener('pointerdown', onDown, { capture: true });
      el.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('keydown', onShift);
      window.removeEventListener('keyup', onShift);
      el.removeEventListener('wheel', onWheel, { capture: true });
    },
  };
}
