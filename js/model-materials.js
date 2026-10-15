import { materialById } from './store.js';
import { materialFor, pendingTextureJobs } from './textures.js';

// Slots use deterministic traversal order, rather than transient Three.js UUIDs.
export function modelMaterialSlots(root) {
  const slots = [], seen = new Map();
  root.traverse(o => {
    if (!o.isMesh || o.userData.pickBox) return;
    const materials = o.userData.sourceMaterials || (Array.isArray(o.material) ? o.material : [o.material]);
    o.userData.sourceMaterials = materials;
    for (const m of materials) if (m && !seen.has(m)) {
      const slot = { key: 'slot-' + slots.length, material: m, name: m.name || 'Material ' + (slots.length + 1) };
      seen.set(m, slot); slots.push(slot);
    }
  });
  return slots;
}
export async function applyModelMaterials(scan, root) {
  const slots = modelMaterialSlots(root), lookup = new Map(slots.map(s => [s.material, s]));
  const replacements = new Map();
  for (const slot of slots) {
    const record = materialById(scan.materialBindings?.[slot.key]);
    if (record) replacements.set(slot.key, materialFor(record));
  }
  const deadline = performance.now() + 30000;
  while (pendingTextureJobs()) {
    if (performance.now() > deadline) throw new Error('Material textures are still loading');
    await new Promise(r => setTimeout(r, 50));
  }
  root.traverse(o => {
    if (!o.isMesh || !o.userData.sourceMaterials) return;
    const materials = o.userData.sourceMaterials.map(m => {
      const slot = lookup.get(m), replacement = replacements.get(slot.key);
      if (!replacement) return m;
      const copy = replacement.clone();
      for (const key of ['map','normalMap','roughnessMap','metalnessMap','aoMap','emissiveMap','bumpMap','alphaMap']) if(copy[key]) copy[key] = copy[key].clone();
      return copy;
    });
    o.material = materials.length === 1 ? materials[0] : materials;
  });
  return slots;
}
