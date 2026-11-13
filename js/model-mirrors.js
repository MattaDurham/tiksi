// Planar reflections for explicitly declared imported mirror surfaces. The drawing lives
// outside the imported tree: picking, product identities, tags and exports keep the original
// geometry/materials. Ordinary glass and polished metals are never inferred to be mirrors.
import * as THREE from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';

const noop = () => {};
const cache = new WeakMap();
const point = (attribute, i) => new THREE.Vector3().fromBufferAttribute(attribute, i);

// A mirror declaration is not enough: reject curved, degenerate or mixed-facing surfaces.
// The tolerance is numerical, relative to the exported geometry's extent, not a survey claim.
export function planarSurface(geometry) {
  const p = geometry?.attributes?.position, index = geometry?.index;
  if (!p || p.itemSize !== 3 || p.count < 3 || geometry.drawRange.start !== 0 || geometry.drawRange.count !== Infinity || Object.keys(geometry.morphAttributes || {}).length) return null;
  const stamp = [p, p.version, index, index?.version];
  const old = cache.get(geometry);
  if (old && stamp.every((v, i) => v === old.stamp[i])) return old.surface;
  const result = surface => { cache.set(geometry, { stamp, surface }); return surface; };
  const vertices = Array.from({ length: p.count }, (_, i) => point(p, i));
  if (vertices.some(v => !v.toArray().every(Number.isFinite))) return result(null);
  const box = new THREE.Box3().setFromPoints(vertices), size = box.getSize(new THREE.Vector3()).length();
  if (!(size > 1e-8)) return result(null);
  const count = index ? index.count : p.count;
  if (count % 3) return result(null);
  let normal = null, tangent = null, origin = null;
  const triangles = [];
  for (let i = 0; i < count; i += 3) {
    const ids = [0, 1, 2].map(k => index ? index.getX(i + k) : i + k);
    if (ids.some(id => !Number.isInteger(id) || id < 0 || id >= vertices.length)) return result(null);
    const [a, b, c] = ids.map(id => vertices[id]);
    const edge = b.clone().sub(a), n = edge.clone().cross(c.clone().sub(a));
    if (n.lengthSq() < size ** 4 * 1e-16) continue;
    n.normalize();
    if (!normal) { normal = n; tangent = edge.normalize(); origin = a.clone(); }
    else if (normal.dot(n) < 0.99999) return result(null);
    triangles.push(...ids);
  }
  if (!normal || vertices.some(v => Math.abs(v.clone().sub(origin).dot(normal)) > Math.max(1e-7, size * 1e-6))) return result(null);
  const center = box.getCenter(new THREE.Vector3());
  center.addScaledVector(normal, -center.clone().sub(origin).dot(normal));
  return result({ vertices, indices: triangles, normal, tangent, center });
}

const declared = material => material && !Array.isArray(material) && material.userData?.tiksiMirror?.type === 'planar';
const visible = object => { for (let p = object; p; p = p.parent) if (!p.visible) return false; return true; };

// Reflector's reflected camera and oblique near plane are reused, but its automatic callback
// is not: the composer draws normal/depth/outline passes too. Capture once before those passes.
// Include clipping in the surface shader as well as the captured room's ordinary materials.
const shader = {
  uniforms: Reflector.ReflectorShader.uniforms,
  vertexShader: `
    uniform mat4 textureMatrix;
    varying vec4 vUv;
    #include <common>
    #include <logdepthbuf_pars_vertex>
    #include <clipping_planes_pars_vertex>
    void main() {
      vUv = textureMatrix * vec4(position, 1.0);
      vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * mvPosition;
      #include <logdepthbuf_vertex>
      #include <clipping_planes_vertex>
    }`,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    varying vec4 vUv;
    #include <logdepthbuf_pars_fragment>
    #include <clipping_planes_pars_fragment>
    void main() {
      #include <clipping_planes_fragment>
      #include <logdepthbuf_fragment>
      gl_FragColor = vec4(texture2DProj(tDiffuse, vUv).rgb, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
};

export class ModelMirrors {
  constructor() {
    this.root = new THREE.Group(); this.root.name = 'planar mirror reflections';
    this.entries = new Map(); this.rejected = 0; this.captures = 0;
  }

  drop(mesh) {
    const e = this.entries.get(mesh);
    if (!e) return;
    this.root.remove(e.reflector); e.reflector.dispose(); e.reflector.geometry.dispose();
    this.entries.delete(mesh);
  }

  clear() { for (const mesh of [...this.entries.keys()]) this.drop(mesh); }
  dispose() { this.clear(); this.root.removeFromParent(); }

  update(models, camera, { enabled = true, textureSize = 512 } = {}) {
    this.root.visible = enabled;
    this.rejected = 0;
    const seen = new Set(), size = Math.max(128, Math.min(2048, Math.round(textureSize)));
    camera.updateWorldMatrix(true, false);
    const eye = camera.getWorldPosition(new THREE.Vector3());
    const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const candidates = [], unsupportedMaterials = new Set();
    for (const wrapper of Object.values(models)) wrapper?.traverse(mesh => {
      if (!mesh.isMesh || !declared(mesh.material)) return;
      const surface = !mesh.isInstancedMesh && !mesh.isBatchedMesh && !mesh.isSkinnedMesh ? planarSurface(mesh.geometry) : null;
      if (!surface) { this.rejected++; unsupportedMaterials.add(mesh.material); return; }
      candidates.push({ mesh, surface });
    });
    for (const { mesh, surface } of candidates) {
      // Suppression acts on the material also held by batching proxies. If a declaration is
      // shared with unsupported geometry, keep that whole class in its ordinary fallback;
      // hiding its material must never erase an unsupported neighbouring surface.
      if (unsupportedMaterials.has(mesh.material)) { this.rejected++; continue; }
      seen.add(mesh);
      let e = this.entries.get(mesh);
      if (e && (e.surface !== surface || e.material !== mesh.material)) { this.drop(mesh); e = null; }
      if (!e) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(surface.vertices.length * 3), 3));
        geometry.setIndex(surface.indices);
        const reflector = new Reflector(geometry, { textureWidth: size, textureHeight: size, multisample: 0, shader });
        const capture = reflector.onBeforeRender.bind(reflector);
        reflector.onBeforeRender = noop; reflector.raycast = noop;
        reflector.matrixAutoUpdate = false;
        reflector.renderOrder = mesh.renderOrder + 1;
        Object.assign(reflector.material, { side: THREE.DoubleSide, clipping: true, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
        e = { mesh, surface, material: mesh.material, reflector, capture, normal: new THREE.Vector3(), center: new THREE.Vector3(), captured: false };
        this.entries.set(mesh, e); this.root.add(reflector);
      }
      const { reflector } = e;
      const target = reflector.getRenderTarget();
      if (target.width !== size || target.height !== size) target.setSize(size, size);
      mesh.updateWorldMatrix(true, false);
      const world = mesh.matrixWorld, determinant = world.determinant();
      const normal = e.normal.copy(surface.normal).applyMatrix3(new THREE.Matrix3().getNormalMatrix(world)).normalize();
      const center = e.center.copy(surface.center).applyMatrix4(world);
      const side = mesh.material.side, front = eye.clone().sub(center).dot(normal) >= 0;
      reflector.visible = enabled && visible(mesh) && mesh.material.visible !== false && camera.layers.test(mesh.layers) && Math.abs(determinant) > 1e-15 &&
        (side === THREE.DoubleSide || (side === THREE.BackSide ? !front : front));
      if (!reflector.visible) continue;
      // The reflector must have an orthonormal world frame, even if imported ancestors are
      // nonuniformly scaled, sheared or reflected. Baking just this runtime surface into that
      // frame preserves the source world vertices exactly without altering the model.
      if (!front) normal.negate();
      const tangent = surface.tangent.clone().transformDirection(world);
      tangent.addScaledVector(normal, -tangent.dot(normal)).normalize();
      const bitangent = normal.clone().cross(tangent).normalize();
      reflector.matrix.makeBasis(tangent, bitangent, normal).setPosition(center);
      reflector.matrixWorldNeedsUpdate = true;
      const inv = reflector.matrix.clone().invert();
      const positions = reflector.geometry.attributes.position;
      const points = surface.vertices.map(v => v.clone().applyMatrix4(world));
      points.forEach((v, i) => { const q = v.clone().applyMatrix4(inv); positions.setXYZ(i, q.x, q.y, q.z); });
      positions.needsUpdate = true;
      // The reflection shader samples its image, but AO/normal override passes still need
      // a proper surface normal on this separate runtime geometry.
      reflector.geometry.computeVertexNormals();
      reflector.geometry.computeBoundingBox(); reflector.geometry.computeBoundingSphere();
      reflector.visible = frustum.intersectsBox(new THREE.Box3().setFromPoints(points));
      reflector.material.clippingPlanes = mesh.material.clippingPlanes;
      reflector.material.clipIntersection = mesh.material.clipIntersection;
      reflector.material.clipShadows = mesh.material.clipShadows;
      reflector.material.depthTest = mesh.material.depthTest;
      // Imported models may already have a bias toward the eye. Stay just in front of that
      // existing surface rather than assuming its original offset is zero.
      reflector.material.polygonOffsetFactor = mesh.material.polygonOffset ? mesh.material.polygonOffsetFactor : 0;
      reflector.material.polygonOffsetUnits = (mesh.material.polygonOffset ? mesh.material.polygonOffsetUnits : 0) - 1;
      reflector.layers.mask = mesh.layers.mask;
    }
    for (const mesh of [...this.entries.keys()]) if (!seen.has(mesh)) this.drop(mesh);
    this.root.updateMatrixWorld(true);
  }

  render(renderer, scene, camera, { exclude = [] } = {}) {
    if (!this.root.visible) return;
    const active = [...this.entries.values()].filter(e => e.reflector.visible);
    if (!active.length) return;
    // One reflection bounce: exclude both the overlays and their original surfaces from
    // captures. The original lies on the reflected camera's clipping plane and can otherwise
    // occlude its own view through numerical rounding. Material visibility also reaches
    // batching proxies; restoring it here leaves source identity and exports unchanged.
    const hidden = [this.root, ...exclude.filter(Boolean)].map(object => [object, object.visible]);
    const hiddenMaterials = [...new Set([...this.entries.values()].map(e => e.material))].map(material => [material, material.visible]);
    hidden.forEach(([object]) => { object.visible = false; });
    hiddenMaterials.forEach(([material]) => { material.visible = false; });
    const target = renderer.getRenderTarget(), xr = renderer.xr.enabled, shadows = renderer.shadowMap.autoUpdate;
    try {
      for (const e of active) {
        e.capture(renderer, scene, camera); e.captured = true; this.captures++;
        e.camera = e.reflector.getReflectionCamera(camera).position.toArray();
      }
    } finally {
      hidden.forEach(([object, shown]) => { object.visible = shown; });
      hiddenMaterials.forEach(([material, shown]) => { material.visible = shown; });
      active.forEach(e => { e.reflector.visible = true; });
      renderer.xr.enabled = xr; renderer.shadowMap.autoUpdate = shadows;
      renderer.setRenderTarget(target);
    }
  }

  // Draw the captured image once, not over a second coplanar source surface. Bias alone is
  // insufficient when the source and reconstructed drawing plane round to different depth
  // values. Keep source visibility intact: picking and override-material normal/outline
  // passes still operate on the original object, and its flags are restored even on failure.
  // Call only around synchronous beauty composition, after capture and shadow-map updates.
  draw(compose) {
    const materials = this.root.visible ? [...new Set([...this.entries.values()]
      .filter(e => e.reflector.visible && e.captured).map(e => e.material))] : [];
    const saved = materials.map(material => [material, material.colorWrite, material.depthWrite]);
    try {
      for (const [material] of saved) { material.colorWrite = false; material.depthWrite = false; }
      return compose();
    } finally {
      for (const [material, colorWrite, depthWrite] of saved) { material.colorWrite = colorWrite; material.depthWrite = depthWrite; }
    }
  }

  stats() {
    return { captures: this.captures, rejected: this.rejected, surfaces: [...this.entries.values()].map(e => ({
      center: e.center.toArray(), normal: e.normal.toArray(), visible: this.root.visible && e.reflector.visible,
      captured: e.captured, textureSize: e.reflector.getRenderTarget().width,
      camera: e.camera || null,
    })) };
  }
}
