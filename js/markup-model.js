// MODEL's side of markup mode: what markup-layer.js needs from the 3D view (the camera, what
// is under a point of the view, where a pinned note is on the screen, a picture of the view to
// put a markup's ink on). Fetched with the layer the first time MARK UP is wanted, so none of
// this is in the app's first load; viewer3d.js hands over `v` (its markupParts()).
import { attachMarkup, ready } from './markup-layer.js';
import { MARKER_ALPHA, onSurfaces } from './markups.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

export { ready };

// Edges of a part's shape (where its faces meet at more than this angle), in its own
// coordinates, worked out once per shape. The seams inside a flat face are not edges. A shape
// too big to go through quickly (a scan's mesh) has none.
const EDGE_ANGLE = 20, EDGE_MAX_TRIANGLES = 60000;
const edgeCache = new WeakMap();

export function attachModelMarkup(v) {
  const { camera, controls, canvas, THREE } = v;
  const point = new v.THREE.Vector3();
  const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _f = new THREE.Vector3();

  // ---------- ink on the surfaces, drawn as lines in the model ----------
  // One fat line per stroke, kept while its stroke is unchanged. `only` is a markup id while
  // its picture is being made (that markup's ink alone), or null for every shown markup.
  const root = v.markupRoot;
  const drawn = new Map();   // stroke id -> { obj, sig, markupId }
  let only = null;
  const sigOf = s => [s.tool, s.color, s.width, s.px, s.w.length, s.w[0], s.w[1], s.w[2], s.w.at(-1)].join('|');
  function lineOf(s) {
    const pts = s.w.length >= 6 ? s.w : [...s.w, s.w[0] + 1e-4, s.w[1], s.w[2]];   // a dot is a line too short to see as one
    const geo = new LineGeometry();
    geo.setPositions(pts);
    const marker = s.tool === 'marker', line = s.tool === 'line';
    const mat = new LineMaterial({
      color: new THREE.Color(s.color), worldUnits: !line, linewidth: line ? s.px : s.width,
      transparent: marker, opacity: marker ? MARKER_ALPHA : 1, depthWrite: !marker,
    });
    mat.resolution.set(canvas.width, canvas.height);
    const obj = new Line2(geo, mat);
    obj.computeLineDistances();
    obj.userData.markupInk = true;
    obj.renderOrder = marker ? 3 : 2;
    obj.raycast = () => {};   // never what a click, a measure or a note lands on
    return obj;
  }
  function showSurfaces(markups) {
    const keep = new Set();
    let changed = false;
    for (const m of markups) for (const s of m.strokes) {
      if (!onSurfaces(s)) continue;
      keep.add(s.id);
      const sig = sigOf(s), had = drawn.get(s.id);
      if (had && had.sig === sig) { had.markupId = m.id; continue; }
      if (had) { root.remove(had.obj); had.obj.geometry.dispose(); had.obj.material.dispose(); }
      const obj = lineOf(s);
      root.add(obj);
      drawn.set(s.id, { obj, sig, markupId: m.id });
      changed = true;
    }
    for (const [id, d] of drawn) if (!keep.has(id)) { root.remove(d.obj); d.obj.geometry.dispose(); d.obj.material.dispose(); drawn.delete(id); changed = true; }
    applyOnly();
    if (changed) v.requestRender(2);
  }
  function applyOnly() { for (const d of drawn.values()) d.obj.visible = !only || d.markupId === only; }

  // ---------- what is under the pointer ----------
  // The surface under a point of the screen: where it is and which way it faces (null for a
  // scan's points, which have no facing).
  function surfaceAt(clientX, clientY) {
    if (!v.alive()) return null;
    const hit = v.pick({ clientX, clientY }, { surfaceOnly: true, ground: true });
    if (!hit) return null;
    const flat = hit.mesh && hit.mesh.isMesh;
    return { p: hit.point.toArray(), n: flat ? hit.normal.toArray() : null, kind: hit.kind, ref: typeof hit.id === 'string' ? hit.id : '', mesh: hit.mesh };
  }
  // How many metres one pixel of the view spans at the depth of p.
  function mPerPx(p) {
    // PARALLEL: one pixel spans the same everywhere, the view's height over the canvas height.
    const view = v.viewCamera ? v.viewCamera() : camera;
    if (view.isOrthographicCamera) return (view.top - view.bottom) / view.zoom / Math.max(1, canvas.clientHeight);
    camera.getWorldDirection(_f);
    const depth = Math.max(camera.near, _a.set(p[0], p[1], p[2]).sub(camera.position).dot(_f));
    return 2 * depth * Math.tan(camera.fov * Math.PI / 360) / Math.max(1, canvas.clientHeight);
  }
  function localEdges(geometry) {
    if (edgeCache.has(geometry)) return edgeCache.get(geometry);
    let out = null;
    const pos = geometry.getAttribute && geometry.getAttribute('position');
    const tris = pos ? (geometry.index ? geometry.index.count : pos.count) / 3 : 0;
    if (pos && tris <= EDGE_MAX_TRIANGLES) {
      const eg = new THREE.EdgesGeometry(geometry, EDGE_ANGLE);
      out = eg.getAttribute('position').array.slice();
      eg.dispose();
    }
    edgeCache.set(geometry, out);
    return out;
  }
  // The edges near the pointer, in the model, nearest first: those of the part under it and of
  // the parts just beside it (where a wall meets the floor, the wall's own bottom edge is wanted,
  // not only the floor's). Each passes within `reach` px of the pointer.
  const PROBE_PX = 12;
  function edgesNear(clientX, clientY, hit, reach = 40) {
    const meshes = new Set();
    if (hit && hit.mesh) meshes.add(hit.mesh);
    for (const [dx, dy] of [[PROBE_PX, 0], [-PROBE_PX, 0], [0, PROBE_PX], [0, -PROBE_PX]]) {
      const h = v.pick({ clientX: clientX + dx, clientY: clientY + dy }, { surfaceOnly: true, ground: true });
      if (h && h.mesh) meshes.add(h.mesh);
    }
    const r = canvas.getBoundingClientRect();
    const out = [];
    for (const mesh of meshes) out.push(...meshEdgesNear(mesh, clientX - r.left, clientY - r.top, reach));
    return out.sort((a, b) => a.d - b.d).slice(0, 40).map(x => x.e);
  }
  function meshEdgesNear(mesh, cx, cy, reach) {
    if (!mesh || !mesh.isMesh || mesh.isInstancedMesh || !mesh.geometry) return [];
    const arr = localEdges(mesh.geometry);
    if (!arr) return [];
    const w = canvas.clientWidth, h = canvas.clientHeight;
    mesh.updateWorldMatrix(true, false);
    const out = [];
    for (let i = 0; i + 5 < arr.length; i += 6) {
      _a.set(arr[i], arr[i + 1], arr[i + 2]).applyMatrix4(mesh.matrixWorld);
      _b.set(arr[i + 3], arr[i + 4], arr[i + 5]).applyMatrix4(mesh.matrixWorld);
      const A = _a.toArray(), B = _b.toArray();
      const sa = projectArr(A, w, h), sb = projectArr(B, w, h);
      if (!sa || !sb) continue;
      const dx = sb[0] - sa[0], dy = sb[1] - sa[1], l2 = dx * dx + dy * dy;
      const t = l2 > 0 ? Math.min(1, Math.max(0, ((cx - sa[0]) * dx + (cy - sa[1]) * dy) / l2)) : 0;
      const d = Math.hypot(cx - sa[0] - t * dx, cy - sa[1] - t * dy);
      if (d <= reach) out.push({ d, e: [A, B] });
    }
    return out;
  }
  function projectArr(p, w, h) { return project({ x: p[0], y: p[1], z: p[2] }, w, h); }
  function project(a, w, h) {
    point.set(a.x, a.y, a.z).project(v.viewCamera ? v.viewCamera() : camera);
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
    // The markup's own ink on the surfaces is drawn in the model with it, and nobody else's
    // (even while markups are hidden from the view).
    if (marks) showSurfaces([m]);
    only = m.id; applyOnly();
    let out;
    try { out = await v.renderStillBlob({ width: W, height: H, quality: v.quality(), annotations: false, asCanvas: true, markupInk: !!marks }); }
    finally { only = null; applyOnly(); layer.refresh(); }
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
    rayAt: (clientX, clientY) => v.rayAt({ clientX, clientY }),
    surfaceAt, edgesNear, mPerPx, showSurfaces,
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
  const dispose = layer.dispose;
  layer.dispose = () => {
    dispose();
    for (const d of drawn.values()) { root.remove(d.obj); d.obj.geometry.dispose(); d.obj.material.dispose(); }
    drawn.clear();
  };
  return layer;
}
