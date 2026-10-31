// View-only clones: imported materials and shared texture caches stay intact.
const states = new WeakMap();
export function setModelXray(root, opacity = null) {
  if (!root) return;
  let state = states.get(root);
  if (opacity == null) {
    if (!state) return;
    for (const [mesh, original] of state.meshes) { mesh.material = original.material; mesh.castShadow = original.castShadow; }
    for (const copy of state.materials.values()) copy.dispose();
    states.delete(root);
    return;
  }
  opacity = Math.max(0, Math.min(1, opacity));
  if (!state) {
    state = { meshes: new Map(), materials: new Map() };
    root.traverse(mesh => {
      if (!mesh.isMesh || mesh.userData.pickBox || mesh.userData.splat) return;
      const original = mesh.material;
      if (!original) return;
      state.meshes.set(mesh, { material: original, castShadow: mesh.castShadow });
      const clone = material => {
        if (!material) return material;
        if (!state.materials.has(material)) state.materials.set(material, material.clone());
        return state.materials.get(material);
      };
      mesh.material = Array.isArray(original) ? original.map(clone) : clone(original);
      mesh.castShadow = false;
    });
    states.set(root, state);
  }
  for (const [original, copy] of state.materials) {
    copy.transparent = true;
    copy.opacity = original.opacity * opacity;
    copy.depthWrite = false;
    copy.alphaTest = 0;
    if ('transmission' in copy) copy.transmission = 0;
    copy.needsUpdate = true;
  }
}
