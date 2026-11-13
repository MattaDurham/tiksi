import { EVIDENCE_COLORS, evidenceState } from './evidence.js';

// Temporary material copies: never change geometry, visibility or saved finishes.
// Restore around rendering so exports, picking and disposal still see original materials.
const cache = new WeakMap(), listening = new WeakSet();
export function withUncertainty(roots, recordFor, draw) {
  const changed = [], splats = [];
  try {
    for (const root of roots.filter(Boolean)) root.traverse(o => {
      if (o.userData?.splat && o.recolor?.isColor) {
        splats.push([o, o.recolor.clone()]); o.recolor.set(EVIDENCE_COLORS[evidenceState(recordFor(o))]); return;
      }
      if ((!o.isMesh && !o.isPoints) || o.userData?.helper || o.userData?.pickBox) return;
      const state = evidenceState(recordFor(o));
      const tint = material => {
        let entry = cache.get(material);
        if (!entry || entry.version !== material.version) {
          if (entry) for (const copy of entry.states.values()) copy.dispose();
          entry = { version: material.version, states: new Map() }; cache.set(material, entry);
          if (!listening.has(material)) {
            listening.add(material);
            material.addEventListener('dispose', () => { const e = cache.get(material); if (e) for (const c of e.states.values()) c.dispose(); cache.delete(material); });
          }
        }
        const byState = entry.states;
        if (!byState.has(state)) {
          const copy = material.clone();
          if (copy.color) copy.color.set(EVIDENCE_COLORS[state]);
          if (copy.emissive) { copy.emissive.set(EVIDENCE_COLORS[state]); copy.emissiveIntensity = 0.18; }
          copy.map = null; copy.vertexColors = false; copy.onBeforeCompile = material.onBeforeCompile; copy.customProgramCacheKey = material.customProgramCacheKey;
          byState.set(state, copy);
        }
        const copy = byState.get(state);
        copy.clippingPlanes = material.clippingPlanes; copy.clipIntersection = material.clipIntersection;
        return copy;
      };
      changed.push([o, o.material]);
      o.material = Array.isArray(o.material) ? o.material.map(tint) : tint(o.material);
    });
    return draw();
  } finally {
    for (const [o, original] of changed) o.material = original;
    for (const [o, original] of splats) o.recolor.copy(original);

  }
}
