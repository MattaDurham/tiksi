// Local model packages: resolve every dependency inside the selected ZIP, never from a
// network address. Exports become one GLB so reopening a project keeps its textures.
import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { unzipSync } from 'three/addons/libs/fflate.module.js';
import { nativeConvert } from './native-conversion.js';
import { convertLegacy } from './model-convert.js';
import { bundleGltf, imageMime } from './polycam.js';

const MAX_EXPANDED = 600 * 1024 * 1024; // Match the scan download limit, before allocation.
function pathKey(name) {
  const path = String(name).replace(/\\/g, '/');
  if (/^(?:\/|[a-z]+:)/i.test(path)) throw new Error('Model package has an absolute resource path');
  const parts = [];
  for (const p of path.split('/')) {
    if (!p || p === '.') continue;
    if (p === '..') { if (!parts.length) throw new Error('Model resource leaves its package'); parts.pop(); }
    else parts.push(p);
  }
  return parts.join('/');
}

export function unpackModelZip(buffer) {
  const seen = new Set(); let bytes = 0, count = 0;
  const entries = unzipSync(new Uint8Array(buffer), { filter: file => {
    if (++count > 10000) throw new Error('Model ZIP has more than 10000 files');
    const key = pathKey(file.name);
    if (seen.has(key)) throw new Error('Model ZIP contains duplicate resource paths');
    seen.add(key);
    if (!Number.isSafeInteger(file.originalSize) || file.originalSize < 0 || (bytes += file.originalSize) > MAX_EXPANDED) throw new Error('Model ZIP expands beyond 600 MB');
    return !file.name.endsWith('/') && !file.name.startsWith('__MACOSX/');
  } });
  const files = new Map();
  for (const [name, data] of Object.entries(entries)) files.set(pathKey(name), data);
  return files;
}

function resource(files, base, uri) {
  if (/^(?:[a-z]+:|\/)/i.test(uri)) throw new Error('Select a self-contained model package; external resource: ' + uri);
  let decoded; try { decoded = decodeURIComponent(uri.split(/[?#]/)[0]); } catch (e) { throw new Error('Invalid model resource path'); }
  const key = pathKey(base + decoded);
  const bytes = files.get(key);
  if (!bytes) throw new Error('Missing model resource: ' + key + '. Select the complete ZIP exported by your scanner.');
  return bytes;
}
const asBuffer = bytes => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

export async function bundleObj(files, name) {
  const base = name.slice(0, name.lastIndexOf('/') + 1), text = new TextDecoder().decode(files.get(name));
  const manager = new THREE.LoadingManager(), urls = [];
  let missing = null;
  manager.setURLModifier(uri => {
    try {
      const data = resource(files, base, uri);
      const url = URL.createObjectURL(new Blob([data], { type: imageMime(uri) })); urls.push(url); return url;
    } catch (e) { missing = e; throw e; }
  });
  const loader = new OBJLoader(manager);
  let obj;
  try {
    const libraries = Array.from(text.matchAll(/^\s*mtllib\s+(.+)$/gm), m => m[1].trim());
    if (libraries.length) {
      const creators = [];
      for (const lib of libraries) {
        const bytes = resource(files, base, lib);
        const libDir = lib.slice(0, lib.lastIndexOf('/') + 1);
        const materials = new MTLLoader(manager).parse(new TextDecoder().decode(bytes), libDir);
        creators.push(materials);
      }
      loader.setMaterials({ create(materialName) {
        const creator = creators.find(c => c.materialsInfo[materialName]);
        if (!creator) throw new Error('OBJ references a missing material: ' + materialName);
        return creator.create(materialName);
      } });
    }
    // The exporter waits for the material images before baking them into its GLB.
    const ready = new Promise((resolve, reject) => { manager.onLoad = resolve; manager.onError = url => reject(new Error('Unreadable OBJ texture: ' + url)); });
    obj = loader.parse(text);
    if (urls.length) await ready;
    if (missing) throw missing;
    obj.traverse(o => {
      if (!o.isMesh) return;
      const convert = m => new THREE.MeshStandardMaterial({ name: m.name, color: m.color, map: m.map, normalMap: m.normalMap, bumpMap: m.bumpMap, bumpScale: m.bumpScale, emissive: m.emissive, emissiveMap: m.emissiveMap, opacity: m.opacity, transparent: m.transparent, vertexColors: m.vertexColors, side: m.side, roughness: 0.85 });
      o.material = Array.isArray(o.material) ? o.material.map(convert) : convert(o.material);
    });
    return await new GLTFExporter().parseAsync(obj, { binary: true, maxTextureSize: Infinity });
  } finally {
    for (const url of urls) URL.revokeObjectURL(url);
    if (obj) obj.traverse(o => { if (o.geometry) o.geometry.dispose(); for (const m of Array.isArray(o.material) ? o.material : (o.material ? [o.material] : [])) { for (const k of ['map', 'normalMap', 'bumpMap', 'emissiveMap']) if (m[k]) m[k].dispose(); m.dispose(); } });
  }
}

export async function prepareModelPackage(buffer, name) {
  if (!/\.zip$/i.test(name)) {
    if (/\.(skp|blend|ifc|step|stp|iges|igs|dxf|laz|usd|usda|usdc|usdz|rvt|dwg|3dm|e57)$/i.test(name)) {
      const converted=await nativeConvert(buffer,'.'+name.split('.').pop().toLowerCase());
      return {...converted,name:name.replace(/\.[^.]+$/,converted.format),originalName:name};
    }
    if (/\.(dae|fbx|3ds)$/i.test(name)) {
      const converted = await convertLegacy(buffer, name.split('.').pop().toLowerCase());
      return { ...converted, name: name.replace(/\.(dae|fbx|3ds)$/i, '.glb'), originalName: name };
    }
    if (!/\.gltf$/i.test(name)) {
      if(/\.(ply|splat|spz|ksplat|sog|obj|glb|stl|pcd|xyz|pts|txt|las)$/i.test(name))return {buffer,name};
      const converted=await nativeConvert(buffer,'.'+name.split('.').pop().toLowerCase());
      return {...converted,name:name.replace(/\.[^.]+$/,converted.format),originalName:name};
    }
    let gltf; try { gltf = JSON.parse(new TextDecoder().decode(buffer)); } catch (e) { throw new Error('glTF is not valid JSON'); }
    const packed = await bundleGltf(gltf, uri => { throw new Error('Missing glTF resource: ' + uri + '. Select the complete exported ZIP or a GLB.'); });
    return { buffer: packed, name: name.replace(/\.gltf$/i, '.glb') };
  }
  const files = unpackModelZip(buffer);
  const native = Array.from(files.keys()).filter(n=>/\.(skp|blend|ifc|step|stp|iges|igs|dxf|laz|usd|usda|usdc|usdz|3dm|e57)$/i.test(n));
  if(native.length) {
    const converted=await nativeConvert(buffer,'.zip');
    return {...converted,name:name.replace(/\.zip$/i,converted.format),originalName:name};
  }
  const candidates = Array.from(files.keys()).filter(n => /\.(glb|gltf|obj|dae|fbx|3ds|ply|stl|las|xyz|pts|pcd|splat|spz|ksplat|sog)$/i.test(n));
  // A package can carry alternate exports of the same capture; prefer the most complete
  // portable mesh. Multiple top-level models are ambiguous and need an explicit choice.
  const rank = n => ({ glb: 10, gltf: 9, obj: 8, dae: 7, fbx: 6, '3ds': 5, ply: 4, stl: 3 })[n.split('.').pop().toLowerCase()] || 1;
  candidates.sort((a, b) => rank(b) - rank(a));
  if (!candidates.length) throw new Error('No supported 3D model in the ZIP. Export GLTF, OBJ, DAE, FBX, 3DS, PLY, STL or a supported point cloud.');
  if (candidates.length > 1 && rank(candidates[0]) === rank(candidates[1])) throw new Error('The ZIP contains multiple models; package one capture at a time.');
  const model = candidates[0], base = model.slice(0, model.lastIndexOf('/') + 1);
  let result = asBuffer(files.get(model));
  let resultName = model.split('/').pop(), warnings = [];
  if (/\.(dae|fbx|3ds)$/i.test(model)) {
    const converted = await convertLegacy(result, model.split('.').pop().toLowerCase(), uri => resource(files, base, uri));
    result = converted.buffer; warnings = converted.warnings; resultName = resultName.replace(/\.(dae|fbx|3ds)$/i, '.glb');
  }
  if (/\.gltf$/i.test(model)) {
    let gltf; try { gltf = JSON.parse(new TextDecoder().decode(result)); } catch (e) { throw new Error('Packaged glTF is not valid JSON'); }
    result = await bundleGltf(gltf, uri => Promise.resolve(asBuffer(resource(files, base, uri))));
    resultName = resultName.replace(/\.gltf$/i, '.glb');
  } else if (/\.obj$/i.test(model)) {
    result = await bundleObj(files, model); resultName = resultName.replace(/\.obj$/i, '.glb');
  }
  return { buffer: result, name: resultName, originalName: name, warnings };
}
