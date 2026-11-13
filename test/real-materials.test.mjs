// Real-world materials and SketchUp-style model materials and components (material-identity.js,
// materials.js, model-materials.js, model-components.js, model-takeoff.js). Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as THREE from '../vendor/three.module.min.js';

const vendor = new URL('../vendor/', import.meta.url).href;
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'three') return { url: vendor + 'three.module.min.js', shortCircuit: true };
    if (spec.startsWith('three/addons/')) return { url: vendor + 'addons/' + spec.slice(13), shortCircuit: true };
    return next(spec, ctx);
  },
});
globalThis.indexedDB = { open() { throw new Error('no IndexedDB under Node'); } };
const store = await import('../js/store.js');
store.ws.data = store.emptyWorkspace();
const ID = await import('../js/material-identity.js');
const MAT = await import('../js/materials.js');
const MM = await import('../js/model-materials.js');
const MC = await import('../js/model-components.js');
const TK = await import('../js/model-takeoff.js');
const MP = await import('../js/model-panel.js');

const fresh = () => { store.ws.data = store.emptyWorkspace(); return store.ws.data; };
const ORIGINAL_13 = ['mat-drywall', 'mat-plaster', 'mat-brick', 'mat-cmu', 'mat-cedar', 'mat-fiber', 'mat-tile-w', 'mat-oak', 'mat-walnut', 'mat-tile-f', 'mat-concrete', 'mat-carpet', 'mat-lvp'];

// ---------- real-world material records ----------

test('library records migrate to real-world categories without losing ids, names or looks', () => {
  const d = fresh();
  // A v2 workspace from before: two built-ins (one edited) and the owner's kind of custom records.
  d.materials = [
    { id: 'mat-oak', name: 'White oak flooring', kind: 'floor', color: '#c9a06a', pattern: 'wood', tile: [1.8, 0.9], roughness: 0.55, metalness: 0, normalScale: 1, accent: null, photoId: null, custom: false },
    { id: 'mat-drywall', name: 'Drywall, my grey', kind: 'wall', color: '#888888', pattern: 'drywall', tile: [1, 1], roughness: 0.9, metalness: 0, normalScale: 0.6, accent: null, photoId: null, custom: false },
    { id: 'mat-x1', name: 'Painted plaster · warm white', kind: 'wall', color: '#f1ece2', pattern: 'plaster', custom: true },
    { id: 'mat-x2', name: 'Existing golden wood floor', kind: 'floor', color: '#b8894f', pattern: 'photo', photoId: 'ph-1', custom: true },
    { id: 'mat-x3', name: 'Luxury vinyl plank, ash grey', kind: 'floor', color: '#9a958c', custom: true },
    { id: 'mat-x4', name: 'Slate tile hearth', kind: 'floor', color: '#444a50', custom: true },
    { id: 'mat-x5', name: 'Shower screen', kind: 'any', color: '#d0e0e8', pattern: 'glass', custom: true },
  ];
  MAT.ensureBuiltinMaterials();
  const by = id => d.materials.find(m => m.id === id);
  for (const id of ORIGINAL_13) assert.ok(by(id), id + ' is still in the library');
  assert.equal(by('mat-oak').category, 'wood'); assert.equal(by('mat-oak').type, 'White oak');
  assert.equal(by('mat-drywall').name, 'Drywall, my grey', 'an edited built-in keeps its name');
  assert.equal(by('mat-drywall').color, '#888888', 'and its colour');
  assert.equal(by('mat-drywall').category, 'paint');
  assert.equal(by('mat-x1').category, 'plaster', 'painted plaster is plaster with a paint colour');
  assert.equal(by('mat-x1').pattern, 'plaster');
  assert.equal(by('mat-x2').category, 'wood'); assert.equal(by('mat-x2').pattern, 'photo', 'the render texture is kept');
  assert.equal(by('mat-x3').category, 'vinyl', 'vinyl plank is vinyl, not wood');
  assert.equal(by('mat-x3').pattern, 'wood', 'and it renders as planks');
  assert.equal(by('mat-x4').category, 'stone');
  assert.equal(by('mat-x5').category, 'glass');
  for (const m of d.materials) {
    assert.ok(ID.CATEGORIES.includes(m.category), m.id + ' has a category');
    assert.equal(typeof m.type, 'string'); assert.equal(typeof m.colorName, 'string');
  }
  assert.equal(new Set(d.materials.map(m => m.id)).size, d.materials.length, 'no duplicate ids');
});

test('a record with a category and no pattern renders as its category; bad fields are cleaned', () => {
  fresh();
  const m = MAT.normalizeMaterial({ id: 'mat-n', name: 'Hallway', kind: 'wall', color: '#ffffff', category: 'plaster', type: '  Lime   plaster ',
    product: { brand: 'Example Lime Co', model: 'LP-200', url: 'javascript:alert(1)', productId: '<bad>' }, colorName: 'Chalk', colorCode: 'C-1', colorBrand: 'Example Paints' });
  assert.equal(m.pattern, 'plaster');
  assert.equal(m.type, 'Lime plaster');
  assert.deepEqual(m.product, { brand: 'Example Lime Co', name: '', model: 'LP-200', url: '', productId: null });
  assert.equal(ID.identityLine(m), 'Plaster · Lime plaster');
  assert.equal(ID.colourLine(m), 'Example Paints Chalk C-1');
  assert.equal(MAT.normalizeMaterial({ id: 'mat-e', name: 'x', product: { brand: ' ' } }).product, null, 'an empty product is none');
});

test('a material links to the products list both ways, and unlinks', () => {
  const d = fresh();
  MAT.ensureBuiltinMaterials();
  const m = MAT.normalizeMaterial({ id: 'mat-p', name: 'Kitchen walls', kind: 'wall', color: '#eeeeee', category: 'paint', product: { brand: 'Example Paints', model: 'EP-17', name: 'Regal eggshell' }, custom: true });
  d.materials.push(m);
  const ids = []; const newId = p => { const id = p + '-' + (ids.length + 1); ids.push(id); return id; };
  const made = ID.linkMaterialProduct(d, m, { propertyId: 'prop-1' }, newId);
  assert.equal(made.created, true);
  assert.equal(m.product.productId, made.record.id);
  assert.deepEqual(made.record.materialIds, ['mat-p']);
  assert.deepEqual(made.record.propertyIds, ['prop-1']);
  // The same maker and number finds the record instead of making another.
  const again = ID.linkMaterialProduct(d, m, {}, newId);
  assert.equal(again.created, false); assert.equal(d.products.length, 1);
  // Linking by choosing another record moves the material.
  d.products.push({ id: 'prod-other', name: 'Other paint', brand: 'B', model: 'M', materialIds: [] });
  ID.linkMaterialProduct(d, m, { productId: 'prod-other' }, newId);
  assert.deepEqual(made.record.materialIds, []); assert.deepEqual(d.products[1].materialIds, ['mat-p']);
  assert.equal(ID.productLine(m, d.products), 'B Other paint M', 'maker, name, product number');
  ID.unlinkMaterialProduct(d, m);
  assert.equal(m.product.productId, null); assert.deepEqual(d.products[1].materialIds, []);
});

test('paint amounts are estimated from area and the stored coverage', () => {
  fresh();
  MAT.ensureBuiltinMaterials();
  const paint = store.ws.data.materials.find(m => m.id === 'mat-paint-white');
  assert.deepEqual(paint.coverage, { areaM2: 37.16, unit: 'gal', coats: 2 });
  const est = TK.finishAmount(paint, 100);            // 100 m2, 2 coats, 37.16 m2 per gallon
  assert.ok(Math.abs(est.amount - 200 / 37.16) < 1e-9);
  assert.match(TK.amountText(est), /^about 5\.4 gal \(2 coats at 400 sf per gal; estimate from area\)$/);
  // A material without coverage takes its linked product's; with neither there is no amount.
  const plain = MAT.normalizeMaterial({ id: 'mat-q', name: 'Q', category: 'plaster', product: { productId: 'prod-cov' } });
  assert.equal(TK.finishAmount(plain, 50), null);
  store.ws.data.products.push({ id: 'prod-cov', name: 'Lime', coverage: { areaM2: 10, unit: 'bag', coats: 1 } });
  assert.equal(TK.finishAmount(plain, 50).amount, 5);
});

// ---------- model materials ----------

// A flattened import: every mesh has its own material copy, 3,000 meshes over 35 looks.
function flattenedModel(meshes = 3000, looks = 35) {
  const root = new THREE.Group();
  const geo = new THREE.BoxGeometry(1, 1, 1);
  for (let i = 0; i < meshes; i++) {
    const look = i % looks;
    const mat = new THREE.MeshStandardMaterial({ name: look === 0 ? 'Wall - warm white plaster' : 'Look ' + look, color: new THREE.Color().setHSL(look / looks, 0.5, 0.5) });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(i % 50, 0, Math.floor(i / 50));
    root.add(mesh);
  }
  root.updateMatrixWorld(true);
  return root;
}

test('a model with 3,000 parts over 35 looks lists 35 materials, each with its parts', () => {
  const root = flattenedModel();
  const slots = MM.modelMaterialSlots(root);
  assert.equal(slots.length, 35);
  assert.equal(slots.reduce((n, s) => n + s.parts, 0), 3000);
  const plaster = slots.find(s => s.key === 'm:Wall - warm white plaster');
  assert.equal(plaster.parts, Math.ceil(3000 / 35));
  // Every part using it points at the same material object.
  const used = new Set();
  root.traverse(o => { if (o.isMesh && o.userData.sourceMaterials[0].name === 'Wall - warm white plaster') used.add(o.material); });
  assert.equal(used.size, 1);
  assert.equal(MM.modelMaterialSlots(root), slots, 'listing again does not recount');
  // Same name, different look: a second material, not merged.
  const two = new THREE.Group();
  two.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ name: 'Paint', color: 0xff0000 })));
  two.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ name: 'Paint', color: 0x0000ff })));
  assert.deepEqual(MM.modelMaterialSlots(two).map(s => s.key), ['m:Paint', 'm:Paint #2']);
});

test('binding one model material changes all its parts through one shared replacement', async () => {
  const d = fresh();
  MAT.ensureBuiltinMaterials();
  d.materials.push(MAT.normalizeMaterial({ id: 'mat-lime', name: 'Lime plaster, chalk', kind: 'wall', color: '#eeeae0', pattern: 'flat', category: 'plaster', custom: true }));
  const root = flattenedModel();
  const scan = { id: 'scan-cellar', name: 'cellar.glb', materialBindings: { 'm:Wall - warm white plaster': 'mat-lime' } };
  await MM.applyModelMaterials(scan, root);
  const replaced = new Set(), others = new Set();
  root.traverse(o => {
    if (!o.isMesh) return;
    if (o.userData.sourceMaterials[0].name === 'Wall - warm white plaster') replaced.add(o.material); else others.add(o.material);
  });
  assert.equal(replaced.size, 1, 'one shared replacement, not a clone per mesh');
  const rep = [...replaced][0];
  assert.equal(rep.userData.materialId, 'mat-lime');
  assert.equal(rep.userData.modelReplacement, true);
  assert.equal(others.size, 34, 'the other 34 materials keep their own shared originals');
  assert.ok(![...others].includes(rep));
});

test('old positional slot bindings survive the move to material keys', () => {
  const d = fresh();
  const root = flattenedModel(70, 35);     // two copies of each look: slot-N is the N-th mesh's copy
  d.projects.push({ id: 'proj-t', modelTakeoffId: 'scan-old', items: [{ id: 'it-1', modelSurface: { scanId: 'scan-old', slot: 'slot-36', areaM2: 4 } }] });
  const scan = { id: 'scan-old', materialBindings: { 'slot-0': 'mat-plaster', 'slot-35': 'mat-drywall', 'slot-70': 'mat-gone', 'slot-3': 'mat-oak', 'slot-38': 'mat-oak' },
    materialIdentities: { 'slot-1': 'mat-brick' } };
  assert.equal(MM.migrateMaterialKeys(scan, root), true);
  // slot-0 and slot-35 are both copies of the plaster look: the lowest slot wins a tie.
  assert.deepEqual(scan.materialBindings, { 'm:Wall - warm white plaster': 'mat-plaster', 'm:Look 3': 'mat-oak' });
  assert.deepEqual(scan.materialIdentities, { 'm:Look 1': 'mat-brick' });
  // Nothing the old keys said is thrown away: they are kept beside the new ones.
  assert.equal(scan.materialKeyMigration.materialBindings['slot-70'], 'mat-gone');
  assert.equal(scan.materialKeyMigration.materialBindings['slot-35'], 'mat-drywall');
  assert.equal(d.projects[0].items[0].modelSurface.slot, 'm:Look 1');
  assert.equal(d.projects[0].items[0].modelSurface.legacySlot, 'slot-36');
  assert.equal(MM.migrateMaterialKeys(scan, root), false, 'a second load changes nothing');
  // Most votes win over the lowest slot.
  const s2 = { id: 's2', materialBindings: { 'slot-0': 'mat-a', 'slot-35': 'mat-b' } };
  const r2 = flattenedModel(105, 35);      // three copies: slots 0, 35, 70
  s2.materialBindings['slot-70'] = 'mat-b';
  MM.migrateMaterialKeys(s2, r2);
  assert.equal(s2.materialBindings['m:Wall - warm white plaster'], 'mat-b');
});

test('the finish takeoff measures each shared material, including instanced parts', () => {
  const root = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ name: 'Floor oak' });
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(2, 3), mat);
  const copy = new THREE.Mesh(plane.geometry, mat.clone());          // a material copy, same look
  copy.position.x = 5;
  const inst = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial({ name: 'Tile' }), 4);
  for (let i = 0; i < 4; i++) inst.setMatrixAt(i, new THREE.Matrix4().makeTranslation(i * 2, 0, 0));
  root.add(plane, copy, inst);
  const rows = TK.modelTakeoff(root);
  assert.equal(rows.length, 2);
  assert.ok(Math.abs(rows.find(r => r.name === 'Floor oak').areaM2 - 12) < 1e-9);
  const tile = rows.find(r => r.name === 'Tile');
  assert.equal(tile.parts, 4); assert.ok(Math.abs(tile.areaM2 - 4) < 1e-9);
});

// ---------- components ----------

const at = (x, y = 0, z = 0) => new THREE.Matrix4().makeTranslation(x, y, z);
function instance(name, id, matrix, extra) {
  const g = new THREE.Group();
  g.name = name; g.userData = { name, sketchupComponent: name, sketchupDefinitionId: id, ...extra };
  g.applyMatrix4(matrix);
  return g;
}
const screwGeo = new THREE.BoxGeometry(0.005, 0.02, 0.005), hingeGeo = new THREE.BoxGeometry(0.05, 0.1, 0.01), boxGeo = new THREE.BoxGeometry(0.6, 0.8, 0.6);
const steel = new THREE.MeshStandardMaterial({ name: 'Steel' }), maple = new THREE.MeshStandardMaterial({ name: 'Maple' }), chrome = new THREE.MeshStandardMaterial({ name: 'Chrome' });
// 8 cabinets, each with 4 hinges, each hinge with 6 screws, plus two faucets that look alike
// but are separate definitions: what the converter writes for nested components.
function kitchen() {
  const wrapper = new THREE.Group(), inner = new THREE.Group(), scene = new THREE.Group();
  wrapper.userData = { kind: 'scan', id: 'scan-kitchen', scanKind: 'mesh', inner };
  inner.userData = { inner: null }; wrapper.add(inner); inner.add(scene);
  inner.userData.inner = inner;
  scene.userData = { sketchupComponents: 1 };
  for (let c = 0; c < 8; c++) {
    const cab = instance('Base cabinet 24', 'guid-cab', at(c * 0.7));
    cab.add(new THREE.Mesh(boxGeo, maple));
    for (let h = 0; h < 4; h++) {
      const hinge = instance('Hinge', 'guid-hinge', at(0, h * 0.2));
      hinge.add(new THREE.Mesh(hingeGeo, steel));
      for (let s = 0; s < 6; s++) { const screw = instance('Screw #8', 'guid-screw', at(s * 0.01)); screw.add(new THREE.Mesh(screwGeo, steel)); hinge.add(screw); }
      cab.add(hinge);
    }
    scene.add(cab);
  }
  const faucetGeo = new THREE.BoxGeometry(0.1, 0.3, 0.1);
  for (const [i, id] of ['guid-faucet-a', 'guid-faucet-b'].entries()) { const f = instance('Faucet', id, at(i, 1)); f.add(new THREE.Mesh(faucetGeo, chrome)); scene.add(f); }
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(5, 0.1, 1), maple));   // a loose group: not a component
  wrapper.updateMatrixWorld(true);
  return { wrapper, inner, scene };
}

test('nested components count through the nesting: 8 cabinets, 32 hinges, 192 screws', () => {
  const { inner } = kitchen();
  const comps = MC.modelComponents(inner);
  const by = name => comps.filter(c => c.name === name);
  assert.equal(by('Base cabinet 24')[0].count, 8);
  assert.equal(by('Hinge')[0].count, 32);
  assert.equal(by('Screw #8')[0].count, 192);
  assert.deepEqual(by('Base cabinet 24')[0].contains, { 'def:guid-hinge': 4 });
  assert.deepEqual(by('Hinge')[0].contains, { 'def:guid-screw': 6 });
  assert.deepEqual(by('Screw #8')[0].parents, ['def:guid-hinge']);
  assert.equal(by('Base cabinet 24')[0].parts.length, 8 * (1 + 4 * (1 + 6)), 'a cabinet instance owns its nested parts');
  // Two faucets that look the same but were defined separately stay two components.
  assert.equal(by('Faucet').length, 2);
  assert.deepEqual(by('Faucet').map(c => c.count), [1, 1]);
  assert.equal(comps.length, 5, 'the loose group is not a component');
  // A clicked screw belongs to its screw instance, inside a hinge, inside a cabinet.
  let screwMesh; inner.traverse(o => { if (!screwMesh && o.isMesh && o.geometry === screwGeo) screwMesh = o; });
  assert.deepEqual(MC.instanceChain(screwMesh, inner).map(o => o.userData.sketchupComponent), ['Screw #8', 'Hinge', 'Base cabinet 24']);
  assert.equal(MC.convertedWithComponents(inner), true);
});

test('a component links to a product; the schedule prices it by count, across models too', () => {
  const d = fresh();
  const prop = store.propertyTemplate('Kitchen house');
  d.properties.push(prop);
  const { inner } = kitchen();
  const scan = { id: 'scan-kitchen', name: 'kitchen.skp' };
  prop.scans = [scan];
  const comps = MC.modelComponents(inner);
  const screw = comps.find(c => c.name === 'Screw #8');
  const ids = []; const newId = p => { const id = p + '-' + (ids.length + 1); ids.push(id); return id; };
  assert.throws(() => MC.linkComponentProduct(d, prop, scan, screw, { brand: 'Example Fasteners' }, newId), /model number/);
  const { record, created } = MC.linkComponentProduct(d, prop, scan, screw, { brand: 'Example Fasteners', model: 'WS-8-58', name: 'Wood screw #8 x 5/8' }, newId);
  assert.equal(created, true);
  assert.deepEqual(record.propertyIds, [prop.id], 'the product travels with the property');
  assert.deepEqual(scan.componentProducts[screw.key], { productId: record.id, brand: 'Example Fasteners', model: 'WS-8-58', name: 'Screw #8' });
  record.price = 0.12; record.unit = 'ea';
  d.products.push({ id: 'prod-faucet', name: 'Example Faucet Co bridge faucet', brand: 'Example Faucet Co', model: 'F-100', price: 300, unit: 'ea' });
  const faucets = comps.filter(c => c.name === 'Faucet');
  for (const f of faucets) MC.linkComponentProduct(d, prop, scan, f, { productId: 'prod-faucet' }, newId);
  const rows = MC.componentSchedule(d, scan, inner);
  const screwRow = rows.find(r => r.key === screw.key);
  assert.equal(screwRow.count, 192); assert.equal(screwRow.unitPrice, 0.12);
  assert.ok(Math.abs(screwRow.extended - 23.04) < 1e-9);
  assert.equal(rows.filter(r => r.name === 'Faucet').length, 2, 'per model, each definition is its own row');
  // Across models, one product is one row: the two faucet definitions and a second model's.
  const other = kitchen(), scan2 = { id: 'scan-2', name: 'bath.skp' };
  MC.linkComponentProduct(d, prop, scan2, MC.modelComponents(other.inner).find(c => c.name === 'Faucet'), { productId: 'prod-faucet' }, newId);
  const all = MC.propertyComponentSchedule(d, [{ scan, root: inner }, { scan: scan2, root: other.inner }]);
  const faucetRow = all.find(r => r.productId === 'prod-faucet');
  assert.equal(faucetRow.count, 3); assert.equal(faucetRow.extended, 900);
  assert.deepEqual(faucetRow.models, ['kitchen.skp', 'bath.skp']);
  // A price per box is not a price per each: it is not multiplied by the count.
  record.unit = 'box';
  assert.equal(MC.componentSchedule(d, scan, inner).find(r => r.key === screw.key).extended, 0);
  record.unit = 'ea';
  // The component estimate is a project the budget reads like any other.
  const pr = TK.createComponentEstimate(prop, scan, inner);
  const totals = store.projectTotals(pr);
  assert.ok(Math.abs(totals.likely - (192 * 0.12 + 300 + 300)) < 1e-6);
  assert.equal(pr.items.find(it => it.modelComponent.key === screw.key).qty, 192);
  assert.ok(record.itemIds.includes(pr.items.find(it => it.modelComponent.key === screw.key).id), 'the product lists the scope item');
  assert.throws(() => TK.createComponentEstimate(prop, scan, inner), /already exists/);
  MC.unlinkComponentProduct(scan, screw.key);
  assert.equal(MC.componentProductRecord(d, scan, screw.key), null);
});

test('component evidence survives normalization without implying a verified product or price', () => {
  const input = {
    name: 'Existing faucet', brand: 'Example Fixtures', model: 'F-100', status: 'proposed-match',
    evidence: 'Photograph shows a curved spout.\n No label is visible.', uncertainty: 'Finish and installed model are unknown.',
    dims_mm: { width: 120, height: 'about 400', depth: Infinity, nested: { value: 100 } },
    documents: ['Product documents/F-100/spec.pdf', 'Product documents/F-100/spec.pdf', null], url: 'javascript:alert(1)',
  };
  const evidence = MC.normalizeComponentProduct(input);
  assert.equal(evidence.status, 'proposed-match');
  assert.equal(evidence.evidence, 'Photograph shows a curved spout. No label is visible.');
  assert.deepEqual(evidence.dims_mm, { width: 120, height: 'about 400' });
  assert.deepEqual(evidence.documents, ['Product documents/F-100/spec.pdf']);
  assert.equal(evidence.url, undefined);
  assert.equal(MC.componentIdentityStatus(evidence), 'Proposed match');
  assert.equal(MC.componentIdentityStatus({}), 'Identification not verified');
  assert.equal(MC.componentIdentityStatus({ status: '__proto__' }), '__proto__');
  assert.equal(MC.normalizeComponentProduct({ name: 'Unidentified grille', uncertainty: 'Maker unknown.' }).uncertainty, 'Maker unknown.');
  assert.deepEqual(MC.normalizeComponentProduct({ dims_mm: { width: 120 } }).dims_mm, { width: 120 });
  assert.deepEqual(MC.normalizeComponentProduct({ documents: ['drawing.pdf'] }).documents, ['drawing.pdf']);
  assert.equal(MC.normalizeComponentProduct({ url: 'https://example.com/spec' }).url, 'https://example.com/spec');
  assert.equal(MC.normalizeComponentProduct({ evidence: 'x'.repeat(5000) }).evidence.length, 4000);
  const d = fresh(), { inner } = kitchen();
  const scan = { id: 'scan-evidence', componentProducts: { 'def:guid-faucet-a': evidence } };
  assert.equal(MC.componentProductRecord(d, scan, 'def:guid-faucet-a'), null);
  const row = MC.componentSchedule(d, scan, inner).find(r => r.key === 'def:guid-faucet-a');
  assert.equal(row.productId, null);
  assert.equal(row.unitPrice, 0);
  assert.equal(row.extended, 0);
  assert.equal(d.products.length, 0, 'inline evidence does not recreate deleted product records');
  assert.deepEqual(MC.componentProductEvidence(JSON.parse(JSON.stringify(scan)), 'def:guid-faucet-a'), evidence);
  const component = MC.modelComponents(inner).find(c => c.key === 'def:guid-faucet-a');
  const { record } = MC.linkComponentProduct(d, null, scan, component, { brand: input.brand, model: input.model }, () => 'prod-new');
  assert.equal(scan.componentProducts[component.key].status, 'proposed-match', 'linking the recorded candidate does not verify it');
  assert.equal(scan.componentProducts[component.key].uncertainty, evidence.uncertainty);
  MC.linkComponentProduct(d, null, scan, component, { productId: record.id }, () => 'unused');
  assert.equal(scan.componentProducts[component.key].evidence, evidence.evidence, 'relinking the same record retains its evidence');
  d.products.push({ id: 'prod-other', brand: 'Different Fixtures', model: 'F-200' });
  MC.linkComponentProduct(d, null, scan, component, { productId: 'prod-other' }, () => 'unused');
  assert.equal(scan.componentProducts[component.key].evidence, undefined, 'a different selection must not inherit evidence for the old candidate');
  assert.equal(MC.componentIdentityStatus(scan.componentProducts[component.key]), 'Identification not verified');
});

test('component cards show proposed identity and unresolved evidence after a product record is removed', () => {
  const d = fresh(), { wrapper } = kitchen();
  const key = 'def:guid-faucet-a';
  const scan = { id: 'scan-evidence', componentProducts: { [key]: {
    productId: 'prod-removed', brand: 'Example Fixtures', model: 'F-100', name: 'Existing faucet',
    status: 'proposed-match', uncertainty: 'Finish <unknown> & label unreadable.',
    evidence: 'Photograph comparison', dims_mm: { height: 400 },
    documents: ['Product documents/F-100/spec.pdf'], url: 'https://example.com/spec',
  } } };
  const html = MP.componentCardHtml({ scan, obj: wrapper }, key);
  assert.match(html, /Example Fixtures · F-100/);
  assert.match(html, /Identity: Proposed match/);
  assert.match(html, /Unresolved: Finish &lt;unknown&gt; &amp; label unreadable\./);
  assert.match(html, /Photograph comparison/);
  assert.match(html, /Recorded dimensions \(mm\): height: 400/);
  assert.match(html, /Product documents\/F-100\/spec.pdf/);
  assert.match(html, /href="https:\/\/example.com\/spec"/);
  assert.match(html, /no product linked/);
  assert.doesNotMatch(html, /<unknown>|Identified<\/span>/);
  assert.equal(d.products.length, 0);
  // A matching priced record does not erase the component's identity qualification.
  d.products.push({ id: 'prod-current', brand: 'Example Fixtures', model: 'F-100', price: 200, unit: 'ea' });
  assert.match(MP.componentCardHtml({ scan, obj: wrapper }, key), /Identity: Proposed match/);
});

test('unlinking retains component observations but stops product matching and pricing until explicitly relinked', () => {
  const d = fresh(), { wrapper, inner } = kitchen(), key = 'def:guid-faucet-a';
  const product = { id: 'prod-faucet', brand: 'Example Fixtures', model: 'F-100', price: 200, unit: 'ea' };
  d.products.push(product);
  const evidence = { productId: product.id, brand: product.brand, model: product.model, name: 'Existing faucet',
    status: 'proposed-match', evidence: 'Curved spout in photograph.', uncertainty: 'Installed model is unknown.',
    dims_mm: { height: 400 }, documents: ['drawing.pdf'], url: 'https://example.com/spec' };
  let scan = { id: 'scan-evidence', componentProducts: { [key]: evidence } };
  const row = () => MC.componentSchedule(d, scan, inner).find(r => r.key === key);
  assert.equal(row().unitPrice, 200);
  MC.unlinkComponentProduct(scan, key);
  assert.deepEqual(scan.componentProducts[key], { ...evidence, productId: null, unlinked: true });
  assert.equal(MC.componentProductRecord(d, scan, key), null, 'the retained maker/model must not silently reattach the product');
  assert.equal(row().unitPrice, 0);
  assert.equal(row().extended, 0);
  scan = JSON.parse(JSON.stringify(scan));
  scan.componentProducts[key] = MC.normalizeComponentProduct(scan.componentProducts[key]);
  assert.equal(MC.componentProductRecord(d, scan, key), null, 'unlink survives saving and normalization');
  const html = MP.componentCardHtml({ scan, obj: wrapper }, key);
  assert.match(html, /Identity: Proposed match/);
  assert.match(html, /Installed model is unknown\./);
  assert.match(html, /Curved spout in photograph\./);
  assert.match(html, /no product linked/);
  const component = MC.modelComponents(inner).find(c => c.key === key);
  MC.linkComponentProduct(d, null, scan, component, { productId: product.id }, () => 'unused');
  assert.equal(MC.componentProductRecord(d, scan, key), product);
  assert.equal(row().unitPrice, 200);
  assert.equal(scan.componentProducts[key].unlinked, undefined);
  assert.equal(scan.componentProducts[key].uncertainty, evidence.uncertainty);
  assert.deepEqual(scan.componentProducts[key].dims_mm, evidence.dims_mm);
  const legacyKey = 'def:guid-faucet-b';
  scan.componentProducts[legacyKey] = { productId: product.id, brand: product.brand, model: product.model, name: 'Faucet' };
  MC.unlinkComponentProduct(scan, legacyKey);
  assert.equal(scan.componentProducts[legacyKey], undefined, 'legacy links without observations retain their deletion behavior');
});

test('reconverting carries part tags by name, file tag and position', () => {
  const box = (x0, x1) => new THREE.Box3(new THREE.Vector3(x0, 0, 0), new THREE.Vector3(x1, 1, 1));
  const tagOf = { 'node:s#0/1': 'tag-wine', 'node:s#0/2': '', 'node:s#0/3': 'tag-walls' };
  const old = [{ key: 'node:s#0/1', name: 'Wine bottle', fileTag: '', box: box(0, 10) }, { key: 'node:s#0/2', name: 'Shelf', fileTag: 'Furniture', box: box(0, 10) },
    { key: 'node:s#0/3', name: 'Wall', fileTag: '', box: box(20, 30) }];
  const next = [{ key: 'node:s#0/0/0', name: 'Wine bottle', fileTag: '', box: box(1, 2) }, { key: 'node:s#0/1/0', name: 'Wine bottle', fileTag: '', box: box(40, 41) },
    { key: 'node:s#0/2', name: 'Shelf', fileTag: 'Furniture', box: box(3, 4) }, { key: 'node:s#0/3', name: 'Wall', fileTag: '', box: box(21, 22) }];
  const r = MC.carryPartTags(tagOf, old, next);
  assert.deepEqual(r.assigned, { 'node:s#0/0/0': 'tag-wine', 'node:s#0/2': '', 'node:s#0/3': 'tag-walls' });
  assert.equal(r.matched, 3); assert.equal(r.unmatched, 1);
});

// The converter's GLB, loaded the way Tiksi loads it: 300 instances of one component share one
// geometry and one material, and Tiksi lists one component drawn 300 times.
test('a converted file with 300 instances loads as one shared mesh drawn by 300 nodes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tiksi-components-'));
  try {
    const script = `
import sys, json
sys.path.insert(0, sys.argv[1])
from server.mesh_exchange import write_glb
tri = {'name': 'Wine bottle', 'positions': [0,0,0,.08,0,0,0,.3,0], 'indices': [0,1,2], 'material': {'name': 'Bottle glass', 'color': [.1,.35,.2,1]}}
cork = {'name': 'Wine bottle', 'positions': [0,.3,0,.02,.3,0,0,.33,0], 'indices': [0,1,2], 'material': {'name': 'Cork', 'color': [.7,.5,.3,1]}}
nodes = [{'name': 'Wine bottle', 'matrix': [1,0,0,0,0,1,0,0,0,0,1,0,(i%30)*.1,0,(i//30)*.1,1],
          'extras': {'sketchupComponent': 'Wine bottle', 'sketchupDefinitionId': 'guid-bottle', 'sketchupInstance': 'inst-%d' % i},
          'children': [{'name': 'Wine bottle', 'mesh': 0, 'extras': {'sketchupTag': 'Wine'}}, {'name': 'Wine bottle', 'mesh': 1}]} for i in range(300)]
write_glb([tri, cork], sys.argv[2], nodes, {'sketchupComponents': 1})
`;
    writeFileSync(join(dir, 'make.py'), script);
    execFileSync('python3', [join(dir, 'make.py'), new URL('..', import.meta.url).pathname, join(dir, 'rack.glb')]);
    const bytes = readFileSync(join(dir, 'rack.glb'));
    const { GLTFLoader } = await import('../vendor/addons/loaders/GLTFLoader.js');
    const gltf = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
    const scene = gltf.scene;
    const geometries = new Set(), materials = new Set();
    let meshes = 0;
    scene.traverse(o => { if (o.isMesh) { meshes++; geometries.add(o.geometry); materials.add(o.material); } });
    assert.equal(meshes, 600);
    assert.equal(geometries.size, 2, 'the bottle body and cork geometry are each stored once');
    const comps = MC.modelComponents(scene);
    assert.equal(comps.length, 1); assert.equal(comps[0].count, 300); assert.equal(comps[0].key, 'def:guid-bottle');
    assert.equal(MC.convertedWithComponents(scene), true);
    const slots = MM.modelMaterialSlots(scene);
    assert.deepEqual(slots.map(s => [s.name, s.parts]), [['Bottle glass', 300], ['Cork', 300]]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
