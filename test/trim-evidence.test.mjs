import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
const vendor = new URL('../vendor/', import.meta.url).href;
registerHooks({ resolve(spec, ctx, next) {
  if (spec === 'three') return { url: vendor + 'three.module.min.js', shortCircuit: true };
  if (spec.startsWith('three/addons/')) return { url: vendor + 'addons/' + spec.slice(13), shortCircuit: true };
  return next(spec, ctx);
} });
globalThis.indexedDB = { open() { throw new Error('no IndexedDB under Node'); } };
const { evidenceSignature, elementEvidenceRecord, setEvidence, evidenceState } = await import('../js/evidence.js');
const { catalogFor } = await import('../js/trim-catalog.js');
const { trimProduct } = await import('../js/trims.js');
const store = await import('../js/store.js');

function fixture() {
  const p = store.propertyTemplate('Synthetic trim evidence'); p.id = 'trim-evidence-property';
  const level = p.levels[0].id;
  p.walls = [{ id: 'wall', level, ax: 0, ay: 0, bx: 4, by: 0, thickness: .2 },
    { id: 'joined', level, ax: 4, ay: 0, bx: 4, by: 3, thickness: .2 }];
  p.openings = [{ id: 'door', type: 'door', wallId: 'wall', t: .5, width: .9, height: 2.1, detail: { door: { casingWidth: .08 } } }];
  p.trims = [{ id: 'trim', wallId: 'wall', level, style: 'baseboard', product: catalogFor('baseboard')[0].id,
    side: 1, f0: 0, f1: 1, y: 0, h: .8, cols: 3, rows: 2, widths: [1, 1, 1], heights: [1, 1], gap: .1, inset: .05, spacing: .2, material: null }];
  store.ws.data = store.emptyWorkspace(); store.ws.data.properties.push(p);
  return p;
}
function review(p) {
  const record = elementEvidenceRecord(p, 'trim', p.trims[0]);
  setEvidence(record, 'geometry', 'observed', 'Synthetic site photograph');
  p.trims[0].evidence = record.evidence;
}
const state = p => evidenceState(elementEvidenceRecord(p, 'trim', p.trims[0]));

test('trim configuration changes invalidate review while a descriptive note does not', () => {
  const changes = { style: 'picture-frame', product: catalogFor('baseboard')[1].id, f0: .1, f1: .9,
    y: .1, h: .9, side: -1, cols: 4, rows: 3, widths: [2, 1, 1], heights: [2, 1], gap: .2, inset: .1, spacing: .3, material: 'different-finish' };
  for (const [key, value] of Object.entries(changes)) {
    const p = fixture(); review(p); assert.equal(state(p), 'observed');
    p.trims[0][key] = value;
    assert.equal(state(p), 'stale', key + ' changes the reviewed trim');
  }
  const p = fixture(); review(p);
  p.trims[0].name = 'A clearer name'; p.trims[0].notes = 'A descriptive note';
  assert.equal(state(p), 'observed');
  const legacy = { width: .9, product: { name: 'unrelated product prose' } };
  const signature = evidenceSignature(legacy); legacy.product.name = 'edited prose';
  assert.equal(evidenceSignature(legacy), signature, 'non-trim legacy signatures stay unchanged');
});

test('host dimensions, level, joined wall and opening casing changes stale trim evidence', () => {
  for (const change of [p => { p.walls[0].bx = 5; }, p => { p.levels[0].height += .2; },
    p => { p.walls[1].thickness = .3; }, p => { p.openings[0].detail.door.casingWidth = .12; }]) {
    const p = fixture(); review(p); change(p);
    assert.equal(state(p), 'stale');
  }
});

test('a catalog specification change invalidates the review without mutating its saved context', () => {
  const p = fixture(); review(p);
  const product = trimProduct(p.trims[0]), width = product.W;
  const saved = p.trims[0].evidence.geometry.contextSignature;
  try { product.W += .001; assert.equal(state(p), 'stale'); }
  finally { product.W = width; }
  assert.equal(p.trims[0].evidence.geometry.contextSignature, saved);
  assert.equal(state(p), 'observed');
});

test('static export preserves trim source records and catalog specifications without claiming installed identity', async () => {
  const { exchangeEvidence } = await import('../js/model-exchange.js');
  const p = fixture();
  p.trims[0].evidence = { identity: { status: 'unknown', source: '', note: 'Synthetic identity unresolved' } };
  p.trims.push({ ...structuredClone(p.trims[0]), id: 'future-trim', product: 'future-catalog-id' });
  const before = structuredClone(p.trims), manifest = exchangeEvidence(p);
  assert.deepEqual(manifest.elements.filter(e => e.kind === 'trims'), before.map(t => ({ kind: 'trims', ...t })));
  assert.equal(manifest.trimCatalog.role, 'geometry-specification');
  const known = manifest.trimCatalog.selections.find(s => s.elementId === 'trim');
  assert.deepEqual(known, { elementId: 'trim', selectedId: before[0].product, resolvedId: before[0].product, usedFallback: false });
  const future = manifest.trimCatalog.selections.find(s => s.elementId === 'future-trim');
  assert.equal(future.selectedId, 'future-catalog-id'); assert.equal(future.usedFallback, true);
  assert.equal(future.resolvedId, trimProduct(p.trims[1]).id);
  assert.deepEqual(manifest.trimCatalog.products, [structuredClone(trimProduct(p.trims[0]))], 'shared catalog specifications are retained once, including sources and inferred profile notes');
  assert.equal(manifest.elements.find(e => e.id === 'trim').evidence.identity.status, 'unknown');
  manifest.trimCatalog.products[0].notes = 'Export-only note'; manifest.elements.find(e => e.id === 'trim').name = 'Export-only name';
  assert.deepEqual(p.trims, before); assert.notEqual(trimProduct(p.trims[0]).notes, 'Export-only note');
  const modelOnly = exchangeEvidence(p, { source: 'model', scanId: 'absent' });
  assert.deepEqual(modelOnly.elements, []); assert.equal(modelOnly.trimCatalog, undefined);
});
