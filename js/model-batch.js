// Grouped drawing for imported models in MODEL (viewer3d.js). A SketchUp export arrives as
// thousands of meshes, each with its own copy of one of a few dozen materials; drawn one by one
// that is thousands of draw calls per pass. Here the parts that look the same are drawn together:
// one BatchedMesh per look, and one InstancedMesh for a geometry repeated many times (component
// instances that share one glTF mesh).
//
// The model's own tree is never changed. Its meshes stay the parts every feature works with
// (tags, picking, part names, materials, takeoff, exports); the drawing proxies live in a
// separate group and are shown only while the viewer draws a frame (beginFrame / endFrame),
// with each model's original meshes hidden for exactly that time. Every frame the proxies
// follow the parts: a part hidden by a tag hides its slot, a part whose material was swapped
// (x-ray, a re-bound material) carries the new material over to its group, and a change that
// splits a group (two parts of one look no longer alike) rebuilds that model's groups.

import * as THREE from 'three';

// A geometry shared by at least this many parts of one look is drawn as one instanced draw when
// it is heavy enough to be worth a draw of its own (or is the only geometry of its look); other
// copies share one stored geometry inside the look's BatchedMesh, which is one draw per look.
// (A rack definition's 120 small boards over 22 racks are 30-odd look draws, not 120.)
export const INSTANCE_MIN = 8, INSTANCE_TRIANGLES = 256;
const triangleCount = g => (g.index ? g.index.count : g.attributes.position.count) / 3;

const MIRROR = new THREE.Matrix4().makeScale(-1, 1, 1);
const ZERO = new THREE.Matrix4().set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
const noop = () => {};
const BASE_BEFORE = THREE.Object3D.prototype.onBeforeRender, BASE_AFTER = THREE.Object3D.prototype.onAfterRender;

// ---------- look keys ----------
// Two materials share a look when they would draw the same pixels: same class and the same
// values for everything a shader or render state reads. Names, ids and descriptive user data
// do not count; the explicit mirror declaration does, because capture visibility differs.
// Textures count by their image source and sampling settings, so per-part copies of one
// texture still group. Objects that cannot be compared by value (planes, which move; functions)
// count by identity.
const identities = new WeakMap();
let nextIdentity = 1;
function identity(o) {
  let id = identities.get(o);
  if (!id) { id = nextIdentity++; identities.set(o, id); }
  return id;
}
const MATERIAL_SKIP = new Set(['uuid', 'id', 'name', 'userData', 'version', '_listeners']);
const TEXTURE_SKIP = new Set(['uuid', 'id', 'name', 'userData', 'version', 'source', 'mipmaps', 'onUpdate', '_listeners', 'pmremVersion', 'updateRanges']);
function valueKey(v, depth) {
  if (v === null || v === undefined) return '_';
  const t = typeof v;
  if (t === 'number' || t === 'boolean') return String(v);
  if (t === 'string') return JSON.stringify(v);
  if (t === 'function') return 'f' + identity(v);
  if (v.isTexture) return textureKey(v);
  if (v.isColor) return 'c' + v.r + ',' + v.g + ',' + v.b;
  if (v.isVector2 || v.isVector3 || v.isVector4 || v.isEuler || v.isQuaternion || v.isMatrix3 || v.isMatrix4) return 'v' + v.toArray().join(',');
  if (v.isPlane) return 'p' + identity(v);
  if (Array.isArray(v)) return '[' + v.map(x => valueKey(x, depth + 1)).join(';') + ']';
  if (ArrayBuffer.isView(v) || depth > 3) return 'o' + identity(v);
  if (Object.getPrototypeOf(v) === Object.prototype) return '{' + Object.keys(v).sort().map(k => k + ':' + valueKey(v[k], depth + 1)).join(',') + '}';
  return 'o' + identity(v);
}
function textureKey(tex) {
  const parts = ['t' + identity(tex.source || tex)];
  for (const k of Object.keys(tex).sort()) if (!TEXTURE_SKIP.has(k)) parts.push(k + '=' + valueKey(tex[k], 2));
  return '(' + parts.join(' ') + ')';
}
export function lookKey(material) {
  if (!material) return 'none';
  // Reflection capture/composition changes a declared source material's render flags.
  // Keep its identity separate from both ordinary neighbours and distinct declared
  // materials: an unsupported surface using a different material must retain its fallback.
  const parts = [material.type, material.userData?.tiksiMirror?.type === 'planar' ? 'planar-mirror:' + identity(material) : 'ordinary'];
  for (const k of Object.keys(material).sort()) if (!MATERIAL_SKIP.has(k)) parts.push(k + '=' + valueKey(material[k], 0));
  return parts.join('|');
}

// The vertex layout a BatchedMesh can hold together: the same attributes, item sizes and
// array types, and all indexed or none. Null when the geometry cannot be batched at all.
export function geometryKey(g) {
  if (!g || !g.isBufferGeometry || !g.attributes.position) return null;
  if (Object.keys(g.morphAttributes || {}).length) return null;
  const names = Object.keys(g.attributes).sort();
  return names.map(n => {
    const a = g.attributes[n];
    return n + ':' + a.itemSize + ':' + a.array.constructor.name + ':' + !!a.normalized;
  }).join(',') + (g.index ? '|i' : '|n');
}

// Built-in surface materials compile batching and instancing into their shaders; a custom
// shader might not.
const BATCH_MATERIALS = ['isMeshStandardMaterial', 'isMeshBasicMaterial', 'isMeshLambertMaterial', 'isMeshPhongMaterial', 'isMeshToonMaterial', 'isMeshMatcapMaterial', 'isMeshNormalMaterial'];
function batchableMaterial(m) {
  return !!m && !m.isShaderMaterial && BATCH_MATERIALS.some(k => m[k]) && !Object.prototype.hasOwnProperty.call(m, 'onBeforeCompile');
}
// Can this drawable share a group, or must it be drawn on its own (still as a light proxy)?
function groupable(o) {
  if (!o.isMesh || o.isInstancedMesh || o.isBatchedMesh || o.isSkinnedMesh) return false;
  if (Array.isArray(o.material) || !batchableMaterial(o.material)) return false;
  // A single material draws the whole range, groups or not (as three's renderer does).
  const g = o.geometry;
  if (!geometryKey(g)) return false;
  if (g.drawRange.start !== 0 || g.drawRange.count !== Infinity) return false;
  if (o.morphTargetInfluences && o.morphTargetInfluences.length) return false;
  return o.onBeforeRender === BASE_BEFORE && o.onAfterRender === BASE_AFTER;
}

// ---------- one model ----------
// A member is one original drawable: its slot in a proxy and the state last copied over.
function memberShown(m) {
  for (const o of m.chain) if (!o.visible) return false;
  return true;
}
function setSlot(proxy, m, shown) {
  if (proxy.isBatchedMesh) proxy.setVisibleAt(m.slot, shown);
  else if (proxy.isInstancedMesh) {
    proxy.setMatrixAt(m.slot, shown ? m.matrix : ZERO);
    proxy.instanceMatrix.needsUpdate = true;
    proxy.userData.boundsStale = true;
  } else proxy.visible = shown;
}

// The meshes below `inner` and, for each, the ancestors between it and `inner` (its own
// visibility counts, and so does every group above it). Null when the model holds something a
// proxy cannot stand in for (lights, skinned or morphing meshes): such a model draws as before.
function collectDrawables(inner) {
  const out = [];
  let ok = true;
  const walk = (o, chain) => {
    for (const c of o.children) {
      const next = chain.concat(c);
      if (c.isLight || c.isCamera || c.isSkinnedMesh || c.isBatchedMesh || c.isInstancedMesh || (c.morphTargetInfluences && c.morphTargetInfluences.length)) { ok = false; return; }
      if (c.isMesh || c.isLine || c.isPoints || c.isSprite) out.push({ object: c, chain: next.slice().reverse() });
      walk(c, next);
      if (!ok) return;
    }
  };
  walk(inner, []);
  return ok ? out : null;
}

// The part's transform relative to `inner`, from the local matrices along its chain.
function relativeMatrix(chain) {
  const m = new THREE.Matrix4();
  for (let i = chain.length - 1; i >= 0; i--) { chain[i].updateMatrix(); m.multiply(chain[i].matrix); }
  return m;
}

function soloProxy(o) {
  let p;
  if (o.isSprite) p = new THREE.Sprite(o.material);
  else p = new o.constructor(o.geometry, o.material);
  if (o.isSprite) p.center.copy(o.center);
  return p;
}

function buildEntry(wrapper) {
  const inner = wrapper.userData.inner;
  const drawables = collectDrawables(inner);
  if (!drawables || drawables.length < 2) return null;
  const groups = new Map(), solos = [];
  for (const d of drawables) {
    const o = d.object;
    const matrix = relativeMatrix(d.chain);
    const mirrored = matrix.determinant() < 0;
    const member = { mesh: o, chain: d.chain, matrix, mirrored, material: o.material, castShadow: o.castShadow, receiveShadow: o.receiveShadow, shown: null, proxy: null, slot: -1 };
    if (!groupable(o)) { solos.push(member); continue; }
    const key = [lookKey(o.material), geometryKey(o.geometry), o.castShadow, o.receiveShadow, mirrored, o.renderOrder, o.layers.mask, o.frustumCulled].join('#');
    let g = groups.get(key);
    if (!g) groups.set(key, g = []);
    g.push(member);
  }
  const proxies = [], group = new THREE.Group();
  group.name = 'drawing:' + wrapper.name;
  group.matrixAutoUpdate = false;
  const add = (proxy, members, mirrored) => {
    proxy.matrixAutoUpdate = false;
    if (mirrored) proxy.matrix.copy(MIRROR);
    proxy.raycast = noop;   // picking always lands on the original parts
    proxy.userData.drawingProxy = true;
    const first = members[0].mesh;
    proxy.castShadow = first.castShadow; proxy.receiveShadow = first.receiveShadow;
    proxy.renderOrder = first.renderOrder; proxy.layers.mask = first.layers.mask; proxy.frustumCulled = first.frustumCulled;
    for (const m of members) m.proxy = proxy;
    proxies.push({ proxy, members });
    group.add(proxy);
  };
  const local = m => m.mirrored ? new THREE.Matrix4().multiplyMatrices(MIRROR, m.matrix) : m.matrix;
  for (const members of groups.values()) {
    const byGeometry = new Map();
    for (const m of members) {
      let list = byGeometry.get(m.mesh.geometry);
      if (!list) byGeometry.set(m.mesh.geometry, list = []);
      list.push(m);
    }
    const batched = [];
    for (const [geometry, list] of byGeometry) {
      if (list.length < INSTANCE_MIN || (byGeometry.size > 1 && triangleCount(geometry) < INSTANCE_TRIANGLES)) { batched.push(...list); continue; }
      const proxy = new THREE.InstancedMesh(geometry, list[0].material, list.length);
      list.forEach((m, i) => { m.slot = i; m.matrix = local(m); proxy.setMatrixAt(i, m.matrix); });
      proxy.instanceMatrix.needsUpdate = true;
      proxy.computeBoundingSphere();
      add(proxy, list, list[0].mirrored);
    }
    if (batched.length === 1) { solos.push(batched[0]); continue; }
    if (!batched.length) continue;
    const geometries = [...new Set(batched.map(m => m.mesh.geometry))];
    const vertices = geometries.reduce((n, g) => n + g.attributes.position.count, 0);
    const indices = geometries.reduce((n, g) => n + (g.index ? g.index.count : 0), 0);
    const proxy = new THREE.BatchedMesh(batched.length, vertices, Math.max(indices, 1), batched[0].material);
    const ids = new Map(geometries.map(g => [g, proxy.addGeometry(g)]));
    for (const m of batched) {
      m.slot = proxy.addInstance(ids.get(m.mesh.geometry));
      m.matrix = local(m);
      proxy.setMatrixAt(m.slot, m.matrix);
    }
    add(proxy, batched, batched[0].mirrored);
  }
  for (const m of solos) {
    const proxy = soloProxy(m.mesh);
    proxy.matrix.copy(m.matrix);
    m.slot = 0;
    add(proxy, [m], false);
  }
  // No fewer draws than parts: nothing to gain, draw the model as it is.
  if (proxies.length >= drawables.length) { disposeProxies(proxies); return null; }
  return { wrapper, inner, group, proxies, parts: drawables.length };
}

function disposeProxies(proxies) {
  // Solo and instanced proxies share the parts' geometry, which the model owns and disposes.
  for (const { proxy } of proxies) {
    if (proxy.isBatchedMesh) proxy.dispose();
    else if (proxy.isInstancedMesh) proxy.dispatchEvent({ type: 'dispose' });
  }
}

// Bring one model's proxies up to date with its parts. Returns 'rebuild' when a group no longer
// holds one look, otherwise whether anything that casts or receives shadows changed.
function syncEntry(e) {
  let changed = false;
  for (const p of e.proxies) {
    const { proxy, members } = p;
    let materialMoved = false, flagsMoved = false;
    for (const m of members) {
      const shown = memberShown(m);
      if (shown !== m.shown) { m.shown = shown; setSlot(proxy, m, shown); changed = true; }
      if (m.mesh.material !== m.material) materialMoved = true;
      if (m.mesh.castShadow !== m.castShadow || m.mesh.receiveShadow !== m.receiveShadow) flagsMoved = true;
    }
    if (materialMoved) {
      if (members.length > 1) {
        const keys = new Map();
        const key = mat => { let k = keys.get(mat); if (k === undefined) keys.set(mat, k = lookKey(mat)); return k; };
        const first = key(members[0].mesh.material);
        if (members.some(m => key(m.mesh.material) !== first)) return 'rebuild';
      }
      for (const m of members) m.material = m.mesh.material;
      proxy.material = members[0].mesh.material;
      changed = true;
    }
    if (flagsMoved) {
      const c = members[0].mesh.castShadow, r = members[0].mesh.receiveShadow;
      if (members.some(m => m.mesh.castShadow !== c || m.mesh.receiveShadow !== r)) return 'rebuild';
      for (const m of members) { m.castShadow = c; m.receiveShadow = r; }
      proxy.castShadow = c; proxy.receiveShadow = r;
      changed = true;
    }
    if (proxy.userData.boundsStale) { proxy.userData.boundsStale = false; proxy.computeBoundingSphere(); }
  }
  return changed;
}

function chainVisible(o) {
  for (let p = o; p; p = p.parent) if (!p.visible) return false;
  return true;
}

// ---------- every model in the view ----------
export class ModelBatches {
  constructor() {
    this.root = new THREE.Group();
    this.root.name = 'model drawing';
    this.root.visible = false;
    this.outlines = new THREE.Group();
    this.outlines.name = 'outline stand-ins';
    this.root.add(this.outlines);
    this.enabled = true;
    this.entries = new Map();      // scan id -> entry (without proxies for a model drawn as loaded)
    this.members = new WeakMap();  // original drawable -> its member record
    this.standIns = new WeakMap();
    this.drawing = false;
  }

  // Drop entries whose model went away or was reloaded, build the ones that arrived. `models`
  // is the viewer's scan id -> wrapper map. A model that gains nothing from grouping keeps an
  // entry without proxies, so it is not looked at again until it is reloaded.
  update(models) {
    let changed = false;
    for (const [id, e] of this.entries) {
      if (this.enabled && models[id] === e.wrapper) continue;
      this.drop(id);
      changed = true;
    }
    if (!this.enabled) return changed;
    for (const [id, w] of Object.entries(models)) {
      if (this.entries.has(id) || !w || w.userData.scanKind !== 'mesh' || !w.userData.inner) continue;
      if (this.build(id, w)) changed = true;
    }
    return changed;
  }
  // Group one model; true when it is drawn by proxies.
  build(id, w) {
    let e = null;
    try { e = buildEntry(w); }
    catch (err) { console.warn('Drawing ' + w.name + ' part by part: ' + (err && err.message || err)); }
    e = e || { wrapper: w, proxies: null };
    this.entries.set(id, e);
    if (!e.proxies) return false;
    this.root.add(e.group);
    for (const p of e.proxies) for (const m of p.members) this.members.set(m.mesh, { entry: e, proxy: p.proxy, member: m });
    return true;
  }
  drop(id) {
    const e = this.entries.get(id);
    this.entries.delete(id);
    if (!e || !e.proxies) return;
    this.root.remove(e.group);
    disposeProxies(e.proxies);
    for (const p of e.proxies) for (const m of p.members) this.members.delete(m.mesh);
  }
  rebuild(id) {
    const e = this.entries.get(id);
    if (!e) return;
    this.drop(id);
    this.build(id, e.wrapper);
  }

  // Before the viewer draws: sync, then swap the originals out and the proxies in. Returns true
  // when something that shadows depend on changed (the shadow map needs a refresh).
  beginFrame(models, originals = false) {
    let shadows = this.update(models);
    for (const [id, e] of [...this.entries]) {
      if (!e.proxies) continue;
      let r;
      try { r = syncEntry(e); }
      catch (err) {
        // Never leave a model undrawn: fall back to its own meshes until it is reloaded.
        console.warn('Drawing ' + e.wrapper.name + ' part by part: ' + (err && err.message || err));
        this.drop(id); this.entries.set(id, { wrapper: e.wrapper, proxies: null }); r = true;
      }
      if (r === 'rebuild') { this.rebuild(id); r = true; }
      if (r) shadows = true;
    }
    if (originals) { this.root.visible = false; this.drawing = false; return shadows; }
    for (const e of this.entries.values()) {
      if (!e.proxies) continue;
      e.group.visible = chainVisible(e.inner);
      e.inner.updateWorldMatrix(true, false);
      e.group.matrix.copy(e.inner.matrixWorld);
      e.group.matrixWorldNeedsUpdate = true;
      e.inner.visible = false;
    }
    this.root.visible = true;
    this.drawing = true;
    return shadows;
  }
  endFrame() {
    if (!this.drawing) return;
    this.drawing = false;
    this.root.visible = false;
    for (const e of this.entries.values()) if (e.proxies) e.inner.visible = true;
  }

  // An outline pass draws its selection by itself. Hidden originals cannot be drawn, so a
  // selected part is swapped for a stand-in that is visible for this pass only, and its slot in
  // the proxy is emptied so the part does not hide its own outline. Returns the undo.
  beginOutline(pass) {
    const selected = pass.selectedObjects;
    if (!this.drawing || !selected || !selected.length) return noop;
    let mapped = null;
    const emptied = [], shownStandIns = [];
    const swap = (o, out) => {
      const ref = this.members.get(o);
      let s = this.standIns.get(o);
      if (!s) {
        s = soloProxy(o);
        s.matrixAutoUpdate = false; s.raycast = noop; s.userData.drawingProxy = true;
        this.standIns.set(o, s);
      }
      // The scene's matrices were brought up to date by this frame's first render.
      s.material = o.material;
      s.matrix.copy(o.matrixWorld);
      s.matrixWorldNeedsUpdate = true;
      s.visible = ref.entry.group.visible && !!ref.member.shown;
      if (s.parent !== this.outlines) this.outlines.add(s);
      shownStandIns.push(s);
      out.push(s);
      if (ref.member.shown) { setSlot(ref.proxy, ref.member, false); emptied.push(ref); }
    };
    selected.forEach((o, i) => {
      if (this.members.has(o)) {
        if (!mapped) mapped = selected.slice(0, i);
        swap(o, mapped);
        return;
      }
      // A group (a component instance, a whole model) outlines every part below it.
      const below = [];
      if (o.children && o.children.length) o.traverse(c => { if (this.members.has(c)) below.push(c); });
      if (below.length) {
        if (!mapped) mapped = selected.slice(0, i);
        for (const c of below) swap(c, mapped);
      }
      if (mapped) mapped.push(o);
    });
    if (!mapped) return noop;
    pass.selectedObjects = mapped;
    return () => {
      pass.selectedObjects = selected;
      for (const s of shownStandIns) s.visible = false;
      for (const ref of emptied) setSlot(ref.proxy, ref.member, true);
    };
  }

  // Switch grouped drawing off (every model draws its own meshes) or back on.
  setEnabled(on) { this.enabled = !!on; }
  // Parts of a model were moved (one object dragged somewhere else): their slots follow. A move
  // that mirrors a part cannot stay in its group, so that model's groups are made again.
  partsMoved(meshes) {
    const again = new Set();
    for (const mesh of meshes) {
      const ref = this.members.get(mesh);
      if (!ref || again.has(ref.entry)) continue;
      const m = ref.member, proxy = ref.proxy;
      const matrix = relativeMatrix(m.chain);
      if ((matrix.determinant() < 0) !== m.mirrored) { again.add(ref.entry); continue; }
      if (proxy.isBatchedMesh || proxy.isInstancedMesh) {
        m.matrix = m.mirrored ? new THREE.Matrix4().multiplyMatrices(MIRROR, matrix) : matrix;
        if (proxy.isBatchedMesh) { proxy.setMatrixAt(m.slot, m.matrix); proxy.boundingBox = null; proxy.boundingSphere = null; }
        else { if (m.shown !== false) proxy.setMatrixAt(m.slot, m.matrix); proxy.instanceMatrix.needsUpdate = true; proxy.userData.boundsStale = true; }
      } else { m.matrix = matrix; proxy.matrix.copy(matrix); proxy.matrixWorldNeedsUpdate = true; }
    }
    for (const [id, e] of [...this.entries]) if (again.has(e)) this.rebuild(id);
  }

  // What is drawn how, for diagnostics and tests.
  stats() {
    const s = { models: 0, parts: 0, proxies: 0, batched: 0, instanced: 0, solo: 0 };
    for (const e of this.entries.values()) {
      if (!e.proxies) continue;
      s.models++; s.parts += e.parts; s.proxies += e.proxies.length;
      for (const { proxy, members } of e.proxies) {
        if (proxy.isBatchedMesh) s.batched += members.length;
        else if (proxy.isInstancedMesh) s.instanced += members.length;
        else s.solo += members.length;
      }
    }
    return s;
  }
  // Whether the proxies currently draw this original part (null: the part is not grouped).
  drawsPart(object) {
    const ref = this.members.get(object);
    return ref ? !!ref.member.shown && ref.entry.group.visible !== false : null;
  }

  dispose() {
    for (const id of [...this.entries.keys()]) this.drop(id);
    if (this.root.parent) this.root.parent.remove(this.root);
  }
}
