// An imported model's materials, the SketchUp way: model-level definitions, each listed once with
// how many parts use it, and every part using one points at the same material object.
//
// Files converted before this (and other exporters) wrote one material copy per mesh: the owner's
// wine cellar had 3,049 copies of 35 looks. shareModelMaterials merges copies with the same name
// and look on load, so binding one model material to a library record changes every part that
// uses it, through one shared replacement.
//
// Keys: 'm:' + the material's name ('m:Wall - warm white plaster'); a second, different look
// under the same name gets ' #2'. Bindings saved before used positional 'slot-N' keys (the N-th
// distinct material object in traversal order); migrateMaterialKeys rewrites them on load.
import { materialById, touch, ws } from './store.js';
import { materialFor, pendingTextureJobs } from './textures.js';

export const LEGACY_KEY = /^slot-(\d+)$/;
const TEXTURE_KEYS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'bumpMap', 'alphaMap'];
const round = (v, n) => Number.isFinite(+v) ? Math.round(+v * 10 ** n) / 10 ** n : '';
const texId = t => t ? (t.source && t.source.uuid) || t.uuid : '';
const hex = c => c && c.getHexString ? c.getHexString() : '';

// Two materials with the same look key draw the same: merging them changes nothing on screen.
export function materialLook(m) {
  return [m.type, m.name || '', hex(m.color), round(m.opacity, 4), m.transparent ? 1 : 0, round(m.roughness, 3), round(m.metalness, 3),
    hex(m.emissive), round(m.emissiveIntensity, 3), ...TEXTURE_KEYS.map(k => texId(m[k])), m.vertexColors ? 1 : 0, m.side, round(m.alphaTest, 3),
    m.flatShading ? 1 : 0, m.transmission != null ? round(m.transmission, 3) : '', (m.userData && m.userData.tiksiMaterialId) || ''].join('|');
}

const meshesOf = root => { const out = []; root.traverse(o => { if (o.isMesh && !(o.userData && o.userData.pickBox)) out.push(o); }); return out; };
const listOf = o => o.userData.sourceMaterials || (Array.isArray(o.material) ? o.material : [o.material]);
const drawn = o => (o.isInstancedMesh ? o.count : 1);

// Merge material copies in place (idempotent). Each mesh's userData.sourceMaterials becomes the
// shared originals; root.userData.legacySlotKeys[N] is the new key of what 'slot-N' named.
export function shareModelMaterials(root) {
  const u = root.userData;
  if (u.modelMaterials) return u.modelMaterials;
  const meshes = meshesOf(root);
  const legacy = [], legacySeen = new Set();
  const byLook = new Map(), slots = [], names = new Map();
  const slotFor = m => {
    const look = materialLook(m);
    let slot = byLook.get(look);
    if (!slot) {
      const base = (String(m.name || '').trim() || 'Material').slice(0, 120);
      const n = (names.get(base) || 0) + 1; names.set(base, n);
      slot = { key: 'm:' + base + (n > 1 ? ' #' + n : ''), material: m, name: base + (n > 1 ? ' #' + n : ''), parts: 0, copies: 0 };
      byLook.set(look, slot); slots.push(slot);
    }
    return slot;
  };
  const merged = new Map();     // original material object -> slot
  for (const o of meshes) {
    const list = listOf(o);
    for (const m of list) if (m && !legacySeen.has(m)) { legacySeen.add(m); legacy.push(m); }
    for (const m of list) if (m && !merged.has(m)) { const slot = slotFor(m); merged.set(m, slot); slot.copies++; }
  }
  for (const o of meshes) {
    const shared = listOf(o).map(m => m ? merged.get(m).material : m);
    o.userData.sourceMaterials = shared;
    if (!o.userData.modelMaterialBound) o.material = Array.isArray(o.material) ? shared : shared[0];
    const counted = new Set();
    for (const m of shared) if (m) { const slot = merged.get(m); if (!counted.has(slot)) { slot.parts += drawn(o); counted.add(slot); } }
  }
  // The copies nothing points at any more (their textures are shared with the kept one).
  for (const [m, slot] of merged) if (m !== slot.material) m.dispose();
  u.legacySlotKeys = legacy.map(m => merged.get(m).key);
  u.modelMaterials = { slots, byMaterial: new Map(slots.map(s => [s.material, s])) };
  return u.modelMaterials;
}

// The model's materials, each once: { key, material, name, parts (meshes drawing it), copies
// (material copies the file carried for it) }.
export function modelMaterialSlots(root) {
  return shareModelMaterials(root).slots;
}
export function slotForMaterial(root, material) {
  return shareModelMaterials(root).byMaterial.get(material) || null;
}

// Rewrite a scan's positional 'slot-N' keys (bindings, identities and its takeoff items) to the
// material keys, so no binding is lost. Several old slots can land on one material (the 3,049
// copies of 35 looks): an existing new-key value wins, else the value most of them had, else
// the lowest slot's. Everything the old keys said is kept in scan.materialKeyMigration.
// Returns true when anything changed (the caller's touch() saves it).
export function migrateMaterialKeys(scan, root) {
  shareModelMaterials(root);
  const legacy = root.userData.legacySlotKeys || [];
  let changed = false;
  for (const field of ['materialBindings', 'materialIdentities']) {
    const map = scan[field];
    if (!map || typeof map !== 'object') continue;
    const old = Object.keys(map).filter(k => LEGACY_KEY.test(k)).sort((a, b) => +LEGACY_KEY.exec(a)[1] - +LEGACY_KEY.exec(b)[1]);
    if (!old.length) continue;
    const votes = new Map();
    for (const k of old) {
      const key = legacy[+LEGACY_KEY.exec(k)[1]];
      if (!key || typeof map[k] !== 'string') continue;
      const v = votes.get(key) || new Map();
      v.set(map[k], (v.get(map[k]) || 0) + 1);
      votes.set(key, v);
    }
    const archive = scan.materialKeyMigration = scan.materialKeyMigration || { from: 'slot', at: new Date().toISOString() };
    archive[field] = Object.assign(archive[field] || {}, Object.fromEntries(old.map(k => [k, map[k]])));
    for (const k of old) delete map[k];
    for (const [key, v] of votes) {
      if (map[key]) continue;
      let best = null, n = 0;
      for (const [value, count] of v) if (count > n) { best = value; n = count; }
      map[key] = best;
    }
    changed = true;
  }
  // Takeoff items made from this model named their surface by slot too.
  for (const pr of (ws.data && ws.data.projects) || []) for (const it of pr.items || []) {
    const s = it.modelSurface;
    if (s && s.scanId === scan.id && LEGACY_KEY.test(s.slot || '')) {
      const key = legacy[+LEGACY_KEY.exec(s.slot)[1]];
      if (key) { s.legacySlot = s.slot; s.slot = key; changed = true; }
    }
  }
  return changed;
}

// The library record a model material is shown as: an explicit binding, else none (identities
// recognise a material without replacing how it looks).
export function boundRecord(scan, key) {
  return materialById(scan.materialBindings && scan.materialBindings[key]) || null;
}

export async function applyModelMaterials(scan, root) {
  const slots = modelMaterialSlots(root);
  if (migrateMaterialKeys(scan, root)) touch();
  // One replacement per library record for the whole model, shared by every part of every model
  // material bound to it. It is a copy of the library's cached material (with copied textures),
  // so disposing the model or x-ray never touches the library's own.
  const byRecord = new Map(), bySlot = new Map();
  for (const slot of slots) {
    const record = boundRecord(scan, slot.key);
    if (!record) continue;
    if (!byRecord.has(record.id)) byRecord.set(record.id, materialFor(record));
    bySlot.set(slot.material, record.id);
  }
  const deadline = performance.now() + 30000;
  while (byRecord.size && pendingTextureJobs()) {
    if (performance.now() > deadline) throw new Error('Material textures are still loading');
    await new Promise(r => setTimeout(r, 50));
  }
  const copies = new Map();
  for (const [id, replacement] of byRecord) {
    const copy = replacement.clone();
    for (const key of TEXTURE_KEYS) if (copy[key]) copy[key] = copy[key].clone();
    copy.userData = Object.assign({}, copy.userData, { materialId: id, modelReplacement: true });
    copies.set(id, copy);
  }
  root.traverse(o => {
    if (!o.isMesh || !o.userData.sourceMaterials) return;
    let bound = false;
    const materials = o.userData.sourceMaterials.map(m => {
      const id = bySlot.get(m);
      if (!id) return m;
      bound = true;
      return copies.get(id);
    });
    o.userData.modelMaterialBound = bound;
    o.material = materials.length === 1 ? materials[0] : materials;
  });
  return slots;
}
