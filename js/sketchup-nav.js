// SketchUp-style navigation on top of three's OrbitControls (vendored, so its underscore
// methods are pinned with it):
//   left or middle drag orbits, Shift + drag pans (switching mid-drag as Shift goes down
//   or up), right drag pans, and the wheel (or a pinch) always zooms toward the cursor.
// Orbits pivot about the surface under the cursor, as SketchUp's do.
const ROTATE = 0, PAN = 2;                // OrbitControls' internal drag states

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

  // Capture phase: runs before OrbitControls reads the press, so the buttons are current.
  function onDown(e) {
    if (!controls.enabled || e.pointerType !== 'mouse' && e.pointerType !== 'pen') return;
    setButtons();
    const base = e.button === 0 ? controls.mouseButtons.LEFT : e.button === 1 ? controls.mouseButtons.MIDDLE : e.button === 2 ? controls.mouseButtons.RIGHT : -1;
    // The pivot waits for a real drag: a plain click never pays for a raycast into a big scan.
    const orbit = base === ROTATE && !e.shiftKey && !e.ctrlKey && !e.metaKey;
    drag = { base, x: e.clientX, y: e.clientY, pivotFrom: orbit ? { clientX: e.clientX, clientY: e.clientY } : null };
    if (e.button === 1) e.preventDefault();          // no autoscroll on middle press
  }
  function onMove(e) {
    if (!drag) return;
    drag.x = e.clientX; drag.y = e.clientY;
    const from = drag.pivotFrom;
    if (!from || Math.hypot(e.clientX - from.clientX, e.clientY - from.clientY) < 4) return;
    drag.pivotFrom = null;
    if (controls.state !== ROTATE) return;
    const hit = pickPoint(from);
    const pivot = hit && pivotOnViewAxis(controls.object.position, controls.target, hit, controls.minDistance);
    if (pivot) { controls.target.copy(pivot); controls.update(); }
  }
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

  el.addEventListener('pointerdown', onDown, { capture: true });
  el.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('keydown', onShift);
  window.addEventListener('keyup', onShift);
  return {
    refresh: setButtons,
    dispose() {
      el.removeEventListener('pointerdown', onDown, { capture: true });
      el.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('keydown', onShift);
      window.removeEventListener('keyup', onShift);
    },
  };
}
