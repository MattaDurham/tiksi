// MODEL's side of markup mode: what markup-layer.js needs from the 3D view (the camera, what
// is under a point of the view, where a pinned note is on the screen, a picture of the view to
// put a markup's ink on). Fetched with the layer the first time MARK UP is wanted, so none of
// this is in the app's first load; viewer3d.js hands over `v` (its markupParts()).
import { attachMarkup, ready } from './markup-layer.js';
import { onSurfaces, strokeOpacity } from './markups.js';
import { drawStroke } from './markup-ink.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

export { ready };

// Edges of a part's shape (where its faces meet at more than this angle), in its own
// coordinates, worked out once per shape. The seams inside a flat face are not edges. A shape
// too big to go through quickly (a scan's mesh) has none.
const EDGE_ANGLE = 20, EDGE_MAX_TRIANGLES = 60000;
const edgeCache = new WeakMap();

// A translucent Line2 is a series of overlapping capsules. Every join (and every crossing)
// blends again, leaving dark beads in a highlighter. On a known flat face, paint the whole
// path once into an antialiased mask and put that mask on the actual face instead. The saved
// points stay vector data; the mask is only a bounded, disposable rendering cache.
const MASK_EDGE = 2048, MASK_PIXELS = 1024 * 1024, MASK_BUDGET = 16 * MASK_PIXELS;
export function planarStrokeInk(THREE, s, pixelBudget = MASK_PIXELS) {
  if (pixelBudget < 256 || s.tool === 'line' || !Array.isArray(s.normal) || s.normal.length !== 3 || !s.normal.every(Number.isFinite)) return null;
  const n = new THREE.Vector3(...s.normal);
  if (n.lengthSq() < 1e-12 || !(s.width > 0)) return null;
  n.normalize();
  const origin = new THREE.Vector3(...s.w.slice(0, 3));
  const u = new THREE.Vector3(), v = new THREE.Vector3(), p = new THREE.Vector3();
  // Build a stable basis even for a dot or a perfectly straight stroke.
  u.set(Math.abs(n.x) < 0.8 ? 1 : 0, Math.abs(n.x) < 0.8 ? 0 : 1, 0);
  u.addScaledVector(n, -u.dot(n)).normalize();
  v.crossVectors(n, u);
  const pts = [];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i + 2 < s.w.length; i += 3) {
    p.set(s.w[i], s.w[i + 1], s.w[i + 2]).sub(origin);
    // Never flatten a curved scan or a stroke that wraps around a corner.
    if (Math.abs(p.dot(n)) > Math.max(0.0002, s.width * 0.01)) return null;
    const x = p.dot(u), y = p.dot(v);
    pts.push(x, y, 0.5);
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  if (!pts.length) return null;
  const pad = s.width * 0.65;
  x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
  const width = x1 - x0, height = y1 - y0;
  // Up to 64 texels across the nib, with both a per-stroke and a whole-view pixel budget.
  const budget = Math.max(256, Math.min(MASK_PIXELS, pixelBudget)), edge = Math.min(MASK_EDGE, Math.floor(budget / 2));
  const scale = Math.min(64 / s.width, edge / width, edge / height, Math.sqrt(budget / (width * height)));
  const mask = document.createElement('canvas');
  mask.width = Math.max(2, Math.floor(width * scale));
  mask.height = Math.max(2, Math.floor(height * scale));
  const ctx = mask.getContext('2d');
  drawStroke(ctx, { tool: 'marker', color: '#ffffff', opacity: 1, width: s.width, pts },
    (x, y) => [(x - x0) * mask.width / width, (y1 - y) * mask.height / height], scale);
  const texture = new THREE.CanvasTexture(mask);
  texture.anisotropy = 4;
  const material = new THREE.MeshBasicMaterial({
    color: s.color, map: texture, transparent: true, opacity: strokeOpacity(s),
    depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true, alphaTest: 1 / 255,
  });
  const obj = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material);
  obj.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(u, v, n));
  obj.position.copy(origin).addScaledVector(u, (x0 + x1) / 2).addScaledVector(v, (y0 + y1) / 2);
  return obj;
}

function disposeInk(obj) {
  obj.geometry.dispose();
  if (obj.material.map) obj.material.map.dispose();
  obj.material.dispose();
}

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
  const sigOf = (s, pixels) => [s.tool, s.color, strokeOpacity(s), s.width, s.px, s.normal, s.w, pixels].join('|');
  function lineOf(s, pixels) {
    const planar = planarStrokeInk(THREE, s, pixels);
    if (planar) {
      planar.userData.markupInk = true;
      planar.renderOrder = s.tool === 'marker' ? 3 : 2;
      planar.raycast = () => {};
      return planar;
    }
    const pts = s.w.length >= 6 ? s.w : [...s.w, s.w[0] + 1e-4, s.w[1], s.w[2]];   // a dot is a line too short to see as one
    const geo = new LineGeometry();
    geo.setPositions(pts);
    const marker = s.tool === 'marker', line = s.tool === 'line', opacity = strokeOpacity(s);
    const mat = new LineMaterial({
      color: new THREE.Color(s.color), worldUnits: !line, linewidth: line ? s.px : s.width,
      transparent: opacity < 1, opacity, depthWrite: opacity === 1,
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
    const count = markups.reduce((total, m) => total + m.strokes.filter(s => onSurfaces(s) && s.normal && s.tool !== 'line').length, 0);
    // Quantize the budget so ordinary additions reuse existing masks. Only crossing a power
    // of two after the first sixteen strokes asks the cache to resize its textures.
    const capacity = 2 ** Math.ceil(Math.log2(Math.max(1, count)));
    const pixels = Math.min(MASK_PIXELS, Math.floor(MASK_BUDGET / capacity));
    for (const m of markups) for (const s of m.strokes) {
      if (!onSurfaces(s)) continue;
      keep.add(s.id);
      const sig = sigOf(s, pixels), had = drawn.get(s.id);
      if (had && had.sig === sig) { had.markupId = m.id; continue; }
      if (had) { root.remove(had.obj); disposeInk(had.obj); }
      const obj = lineOf(s, pixels);
      root.add(obj);
      drawn.set(s.id, { obj, sig, markupId: m.id });
      changed = true;
    }
    for (const [id, d] of drawn) if (!keep.has(id)) { root.remove(d.obj); disposeInk(d.obj); drawn.delete(id); changed = true; }
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
    for (const d of drawn.values()) { root.remove(d.obj); disposeInk(d.obj); }
    drawn.clear();
  };
  return layer;
}
