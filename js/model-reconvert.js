// Converting a SketchUp import again from its stored original (scan.originalFileId), for models
// converted before components were kept. The new file replaces the converted bytes under the
// same scan id; material bindings use material names as keys, so they carry over as they are;
// part tags (keyed by part path) are carried by name, file tag and position (carryPartTags).
// Nothing changes unless the conversion and the new file's checks succeed.
import * as THREE from 'three';
import { getFile, putFile, touch } from './store.js';
import { nativeConvert, converterCapabilities } from './native-conversion.js';
import { loadMesh, applyScanTransform, disposeScanObject } from './scans.js';
import { modelParts, partKey, partName } from './tags-scene.js';
import { carryPartTags, modelComponents } from './model-components.js';
import { modelMaterialSlots } from './model-materials.js';

const fileTag = o => { for (let p = o; p; p = p.parent) { const u = p.userData || {}; if (typeof u.sketchupTag === 'string' && u.sketchupTag.trim()) return u.sketchupTag; if (u.inner === p) break; } return ''; };
function partsOf(scan, wrapper) {
  wrapper.updateMatrixWorld(true);
  return modelParts(wrapper).map(part => ({ key: partKey(scan.id, part), name: partName(part), fileTag: fileTag(part.object), box: new THREE.Box3().setFromObject(part.object) }));
}

export async function convertAgain(prop, scan, oldWrapper) {
  const cap = await converterCapabilities();
  if (!cap.sketchup) throw new Error('The local SketchUp converter is not available here.');
  const original = await getFile(scan.originalFileId);
  if (!original || !original.buffer) throw new Error('The original SKP is not in this browser.');
  const converted = await nativeConvert(original.buffer, '.skp');
  const obj = await loadMesh(converted.buffer, 'glb');
  const wrapper = new THREE.Group(), inner = new THREE.Group();
  inner.add(obj); wrapper.add(inner); Object.assign(wrapper.userData, { kind: 'scan', inner, id: scan.id, scanKind: 'mesh' });
  try {
    applyScanTransform(scan, wrapper); wrapper.visible = true;
    const components = modelComponents(inner).length, materials = modelMaterialSlots(obj).length;
    const tagOf = prop.tagOf || {};
    const prefix = 'node:' + scan.id + '#';
    const { assigned, matched, unmatched } = carryPartTags(tagOf, oldWrapper ? partsOf(scan, oldWrapper) : [], partsOf(scan, wrapper));
    await putFile(scan.id, converted.buffer, { name: scan.name, format: 'glb', kind: 'mesh' });
    for (const k of Object.keys(tagOf)) if (k.startsWith(prefix)) delete tagOf[k];
    prop.tagOf = Object.assign(tagOf, assigned);
    // Hidden objects and moved objects are kept by part path, and the new file's paths are
    // new: both start again (everything shown, everything where the file has it).
    for (const k of Object.keys(prop.hidden || {})) if (k.startsWith(prefix)) delete prop.hidden[k];
    if (scan.partOffsets || scan.objectEvidence) {
      scan.previousConversionEdits ||= [];
      scan.previousConversionEdits.push({ at:new Date().toISOString(), partOffsets:structuredClone(scan.partOffsets || {}), objectEvidence:structuredClone(scan.objectEvidence || {}), note:'Paths changed on reconversion. Retained for review; not assigned to potentially different objects.' });
    }
    delete scan.partOffsets; delete scan.objectEvidence;
    scan.format = 'glb';
    // The stored file is the new one: its size is what a device's size limit goes by.
    scan.bytes = converted.buffer.byteLength;
    scan.conversionJobId = converted.conversionJobId || scan.conversionJobId || null;
    scan.importWarnings = [...(converted.warnings || []), ...(scan.previousConversionEdits?.length ? ['Previous object offsets and evidence are retained in previousConversionEdits; review their mapping to the reconverted model.'] : [])];
    scan.convertedAgainAt = new Date().toISOString();
    touch();
    return { components, materials, matched, unmatched };
  } finally { disposeScanObject(wrapper); }
}
