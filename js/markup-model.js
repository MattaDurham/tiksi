// MODEL's side of markup mode: what markup-layer.js needs from the 3D view (the camera, what
// is under a point of the view, where a pinned note is on the screen, a picture of the view to
// put a markup's ink on). Fetched with the layer the first time MARK UP is wanted, so none of
// this is in the app's first load; viewer3d.js hands over `v` (its markupParts()).
import { attachMarkup, ready } from './markup-layer.js';

export { ready };

export function attachModelMarkup(v) {
  const { camera, controls, canvas } = v;
  const point = new v.THREE.Vector3();
  function project(a, w, h) {
    point.set(a.x, a.y, a.z).project(camera);
    if (point.z < -1 || point.z > 1) return null;   // behind the camera, or past its far plane
    return [(point.x + 1) / 2 * w, (1 - point.y) / 2 * h];
  }
  // The view a markup was drawn from as a canvas, twice the screen's size at most, with the
  // markup's ink and note numbers on top when `marks` is on. The same call with `marks` off is
  // the clean picture of the same view.
  async function picture(m, marks) {
    if (v.mode === 'walk') v.setMode('orbit');
    v.activeViewId = null;
    v.showView(m.view, 0);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!(w > 0 && h > 0)) throw new Error('The view has no size yet.');
    const scale = Math.min(2, 2400 / w);
    const W = Math.round(w * scale), H = Math.round(h * scale);
    const out = await v.renderStillBlob({ width: W, height: H, quality: v.quality(), annotations: false, asCanvas: true });
    if (!v.alive()) throw new Error('The page changed while the picture was being made.');
    if (marks) layer.paint(out.getContext('2d'), m, (x, y) => [W / 2 + x * H, H / 2 + y * H], H,
      n => n.anchor ? project(n.anchor, W, H) : [W / 2 + n.at[0] * H, H / 2 + n.at[1] * H], Math.round(13 * scale));
    return out;
  }
  const layer = attachMarkup({
    kind: 'model', wrap: v.wrapEl, surface: canvas,
    prop: v.prop,
    camera: () => ({ position: camera.position.toArray(), target: controls.target.toArray(), fov: camera.fov }),
    viewNow: v.viewState,
    // A stroke is about to start: the view stops where it is (a flight ends, a turn stops
    // easing), or the ink would be drawn from one camera and saved with another.
    hold() {
      const t = v.tween;
      if (t) { camera.position.copy(t.p1); controls.target.copy(t.t1); camera.lookAt(controls.target); v.tween = null; }
      controls._sphericalDelta.set(0, 0, 0); controls._panOffset.set(0, 0, 0);
      controls.update();
      v.requestRender(2);
    },
    goTo(m) { v.activeViewId = null; if (v.mode === 'walk') v.setMode('orbit'); v.showView(m.view); },
    hitAt(clientX, clientY) {
      if (!v.alive()) return null;
      const hit = v.pick({ clientX, clientY }, { surfaceOnly: true, ground: true });
      return hit ? { anchor: v.anchorOf(hit), kind: hit.kind, ref: typeof hit.id === 'string' ? hit.id : '', p: hit.point.toArray() } : null;
    },
    project: a => project(a, canvas.clientWidth, canvas.clientHeight),
    picture,
    hint: v.setHint,
    toast: v.toast,
    // Markup mode went on or off, or its tool changed: the page's own tools stand down.
    changed(on) {
      if (on) {
        if (v.mode === 'walk') v.setMode('orbit');
        if (v.tool !== 'select') v.setTool('select');
        if (v.match) v.endMatch();
        if (v.selection) v.setSelection(null);
      }
      if (v.nav) v.nav.refresh();
      v.syncSectionHandles();
      v.renderToolCol();
      if (!on) v.setHint('');
      v.requestRender(2);
    },
  });
  return layer;
}
