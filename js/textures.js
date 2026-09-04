// Material -> three.js material factory. STUB: replaced by the procedural PBR texture system.
// Contract (keep these exports):
//   materialFor(mat, opts?) -> THREE.Material   (cached; textures tile in meters, so geometry UVs must be in meters)
//   swatchUrl(mat) -> string | null             (small dataURL preview of the material, cached)
//   disposeMaterials()                          (drop the cache, e.g. when the workspace is replaced)
import * as THREE from 'three';

const cache = new Map();

export function materialFor(mat, opts) {
  const color = (mat && mat.color) || '#d8d4cc';
  const key = color + '|' + ((mat && mat.roughness) ?? 0.9) + '|' + ((mat && mat.metalness) ?? 0.02);
  if (!cache.has(key)) {
    cache.set(key, new THREE.MeshStandardMaterial({
      color: new THREE.Color(color), roughness: (mat && mat.roughness) ?? 0.9, metalness: (mat && mat.metalness) ?? 0.02,
    }));
  }
  return cache.get(key);
}

export function swatchUrl(mat) { return null; }

export function disposeMaterials() {
  for (const m of cache.values()) m.dispose();
  cache.clear();
}
