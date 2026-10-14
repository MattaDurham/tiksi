// Legacy exchange formats are decoded locally and normalized to metres/Y-up GLB.
// The original upload is retained separately by scans.js, including unsupported features.
import * as THREE from 'three';
import { ColladaLoader } from 'three/addons/loaders/ColladaLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { TDSLoader } from 'three/addons/loaders/TDSLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

export async function convertLegacy(buffer, format, resolveResource) {
  const manager = new THREE.LoadingManager(), urls = [];
  let failure = null, requested = 0, obj;
  const ready = new Promise(resolve => { manager.onLoad = resolve; });
  manager.onError = () => { failure = failure || new Error('An image in the model could not be decoded'); };
  manager.setURLModifier(uri => {
    requested++;
    if (/^data:/i.test(uri) || /^blob:/i.test(uri)) return uri;
    try {
      if (!resolveResource) throw new Error('Missing model resource: ' + uri + '. Import the model and all textures in one ZIP.');
      const bytes = resolveResource(uri);
      const url = URL.createObjectURL(new Blob([bytes])); urls.push(url); return url;
    } catch (e) { failure = e; throw e; }
  });
  try {
    if (format === 'dae') {
      const text = new TextDecoder().decode(buffer);
      const xml = new DOMParser().parseFromString(text, 'application/xml');
      if (xml.querySelector('parsererror') || xml.documentElement.localName !== 'COLLADA') throw new Error('Invalid COLLADA XML');
      if (xml.querySelector('asset > up_axis')?.textContent.trim() === 'X_UP') throw new Error('COLLADA X_UP is unsupported; export Y_UP or Z_UP');
      obj = new ColladaLoader(manager).parse(text, '').scene;
    } else if (format === 'fbx') {
      obj = new FBXLoader(manager).parse(buffer, '');
      const unit = obj.userData.unitScaleFactor;
      // FBX UnitScaleFactor is centimetres per unit. Default FBX units are centimetres.
      if (unit != null && (!Number.isFinite(unit) || unit <= 0)) throw new Error('Invalid FBX unit scale');
      obj.scale.multiplyScalar((unit ?? 1) / 100);
    } else obj = new TDSLoader(manager).parse(buffer, ''); // 3DS has no reliable metre convention.
    if (requested) await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error('Model textures timed out')), 30000))]);
    if (failure) throw failure;
    const warnings = ['Converted ' + format.toUpperCase() + ' to static GLB; source bytes are retained. Cameras, lights, animations and CAD/BIM semantics are not part of the editable design.'];
    if (format === '3ds') warnings.push('3DS units are ambiguous. Check a known dimension and set Scale after import.');
    obj.traverse(o => {
      // Loader implementation details can contain circular references.
      o.userData = {};
      if (!o.isMesh) return;
      const convert = m => {
        if (m.isMeshStandardMaterial) return m;
        return new THREE.MeshStandardMaterial({ name: m.name, color: m.color, map: m.map, normalMap: m.normalMap, emissive: m.emissive, emissiveMap: m.emissiveMap, opacity: m.opacity, transparent: m.transparent, side: m.side, vertexColors: m.vertexColors, roughness: 0.85 });
      };
      o.material = Array.isArray(o.material) ? o.material.map(convert) : convert(o.material);
    });
    return { buffer: await new GLTFExporter().parseAsync(obj, { binary: true, maxTextureSize: Infinity }), warnings };
  } finally {
    urls.forEach(url => URL.revokeObjectURL(url));
    obj?.traverse(o => { o.geometry?.dispose(); for (const m of Array.isArray(o.material) ? o.material : o.material ? [o.material] : []) { for (const k of ['map', 'normalMap', 'bumpMap', 'emissiveMap']) m[k]?.dispose(); m.dispose(); } });
  }
}
