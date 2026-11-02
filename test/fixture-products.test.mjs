// Real products on fixtures: identity and how sure it is, the 3D model fitted to the measured
// box, PRODUCTS records with documents and drawing dimensions, the detailed stand-ins, the
// SketchUp mirror's view of them and the onboarding apply script. Synthetic data only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

globalThis.indexedDB = { open() { throw new Error('no IndexedDB under Node'); } };
const store = await import('../js/store.js');
const fx = await import('../js/fixtures.js');
const pr = await import('../js/product-records.js');
const detail = await import('../js/fixture-detail.js');
const { mirrorSpec, attachProductMeshes } = await import('../js/sketchup-mirror.js');
const { applyFindings, glbBounds } = await import('../scripts/onboard-apply.mjs');
const { zipSync, unzipSync, strToU8, strFromU8 } = await import('../vendor/addons/libs/fflate.module.js');

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, msg + ': ' + a + ' vs ' + b);
let n = 0;
const ids = prefix => prefix + '-t' + (++n);

function kitchen() {
  const p = store.propertyTemplate('Synthetic kitchen');
  p.id = 'prop-k';
  const L = p.levels[0].id;
  p.rooms.push({ id: 'r-k', level: L, name: 'Kitchen', pts: [[0, 0], [5, 0], [5, 4], [0, 4]], material: null, ceilingMaterial: null });
  // A dishwasher against the north wall (y = 4), front to the room: at rot 0 its back (+v) is +y.
  p.fixtures.push(Object.assign(fx.fixtureTemplate('appliance', 'dishwasher', { level: L, x: 2, y: 3.68, rot: 0 }), { id: 'fx-dw', w: 0.6, d: 0.64, h: 0.86 }));
  p.fixtures.push(Object.assign(fx.fixtureTemplate('appliance', 'mini-split', { level: L, x: 0.12, y: 2, rot: 90 }), { id: 'fx-ms1' }));
  p.fixtures.push(Object.assign(fx.fixtureTemplate('appliance', 'mini-split', { level: L, x: 4.88, y: 2, rot: 270 }), { id: 'fx-ms2' }));
  p.fixtures = fx.normaliseFixtures(p.fixtures, p);
  return p;
}

test('a confirmed brand or model needs evidence that reads it, or it is stored as likely', () => {
  const read = { media: 'IMG_0001.MOV', at: 213.4, reads: ['brand'], note: 'logo on the control strip' };
  const p = fx.normaliseProduct({ brand: 'Acme', brandConfidence: 'confirmed', model: 'DW-24', modelConfidence: 'confirmed', evidence: [read] }, 'box');
  assert.equal(p.brandConfidence, 'confirmed');
  assert.equal(p.modelConfidence, 'likely', 'the model number was not read');
  const guess = fx.normaliseProduct({ brand: 'Acme', brandConfidence: 'confirmed' }, 'box');
  assert.equal(guess.brandConfidence, 'likely', 'no evidence: never presented as confirmed');
  const none = fx.normaliseProduct({ brand: '', model: 'X1', evidence: [read] }, 'box');
  assert.equal(none.model, '', 'no model without a brand');
  assert.equal(none.brandConfidence, 'unidentified');
  assert.equal(fx.normaliseProduct({}, 'box'), null, 'an empty product is dropped');
});

test('sources keep public web pages only; a 3D model attaches to box fixtures only', () => {
  const p = fx.normaliseProduct({ brand: 'Acme', sources: ['https://maker.example.com/dw24.pdf', 'http://localhost:8642/x', 'http://192.168.1.4/a', 'file:///etc/passwd', { url: 'https://shop.example.org/p', title: 'Shop' }],
    asset: { fileId: 'product-1', bounds: { min: [0, 0, 0], max: [0.6, 0.86, 0.6] } } }, 'run');
  assert.deepEqual(p.sources.map(s => s.url), ['https://maker.example.com/dw24.pdf', 'https://shop.example.org/p']);
  assert.equal(p.asset, null, 'runs keep their parametric cabinets');
  const bad = fx.normaliseProduct({ brand: 'Acme', asset: { fileId: 'product-1', bounds: { min: [0, 0, 0], max: [0, 1, 1] } } }, 'box');
  assert.equal(bad.asset, null, 'a model with no extent cannot be fitted');
});

test('a product model is fitted to the measured box, front to the room, never mirrored', () => {
  const p = kitchen(), f = p.fixtures.find(x => x.id === 'fx-dw');
  // A GLB-style model: +Y up, front facing +Z, slightly smaller than measured and off-centre.
  f.product = fx.normaliseProduct({ brand: 'Acme', asset: { fileId: 'product-dw', bounds: { min: [1, 0, 2], max: [1.6, 0.85, 2.62] } } }, 'box');
  const fit = fx.productFit(f);
  near(fit.scale[0], 1, 1e-9, 'width scale'); near(fit.scale[1], 0.64 / 0.62, 1e-9, 'depth scale'); near(fit.scale[2], 0.86 / 0.85, 1e-9, 'height scale');
  const m = fx.productLevelMatrix(f);
  const corners = [];
  for (const X of [1, 1.6]) for (const Y of [0, 0.85]) for (const Z of [2, 2.62]) corners.push(X, Y, Z);
  const w = fx.transformPositions(m, corners);
  const xs = [], ys = [], zs = [];
  for (let i = 0; i < w.length; i += 3) { xs.push(w[i]); ys.push(w[i + 1]); zs.push(w[i + 2]); }
  near(Math.min(...xs), 1.7, 1e-9, 'left'); near(Math.max(...xs), 2.3, 1e-9, 'right');
  near(Math.min(...zs), 3.36, 1e-9, 'front plane'); near(Math.max(...zs), 4.0, 1e-9, 'back on the wall');
  near(Math.min(...ys), 0, 1e-9, 'on the floor'); near(Math.max(...ys), 0.86, 1e-9, 'top');
  // The model's front (+Z) lands on the room side (smaller plan y here), and the map is a rotation.
  const front = fx.transformPositions(m, [1.3, 0.4, 2.62]), back = fx.transformPositions(m, [1.3, 0.4, 2]);
  assert.ok(front[2] < back[2], 'front faces the room');
  const det = m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
  assert.ok(det > 0, 'proper rotation, not a mirror image');
  f.product.asset.turn = 180;
  const turned = fx.transformPositions(fx.productLevelMatrix(f), [1.3, 0.4, 2.62]);
  assert.ok(turned[2] > back[2] - 1e-9, 'a half turn puts the model front at the wall');
});

test('one identity files one PRODUCTS record, shared by two heads, and the drawing sizes them about the wall', () => {
  const data = { properties: [kitchen()], products: [] }, p = data.properties[0];
  const [a, b] = ['fx-ms1', 'fx-ms2'].map(id => p.fixtures.find(f => f.id === id));
  for (const f of [a, b]) { f.product = fx.normaliseProduct({ brand: 'Coolco', model: 'WS-12', evidence: [{ keyframe: '2445', reads: ['brand'] }] }, 'box'); }
  const first = pr.linkFixtureProduct(data, p, a, ids), second = pr.linkFixtureProduct(data, p, b, ids);
  assert.equal(first.created, true); assert.equal(second.created, false);
  assert.equal(data.products.length, 1); assert.equal(a.product.productId, b.product.productId);
  assert.equal(data.products[0].category, 'hvac');
  const back = f => f.x - Math.sin(f.rot * Math.PI / 180) * f.d / 2;   // the back face lies along (-sin rot, cos rot)
  const backBefore = back(a);
  data.products[0].dims = { w: 0.9, d: 0.24, h: 0.3, source: { title: 'Installation manual p. 6' } };
  pr.normaliseProductRecord(data.products[0]);
  const changed = pr.applyRecordToFixtures(data, data.products[0]);
  assert.equal(changed.length, 2);
  near(a.w, 0.9, 1e-9, 'width from the drawing'); near(a.d, 0.24, 1e-9, 'depth from the drawing');
  near(back(a), backBefore, 1e-9, 'the wall side stays where it was measured');
  assert.equal(a.product.dimsFrom, 'Installation manual p. 6');
  b.product.model = 'WS-18';
  const relinked = pr.linkFixtureProduct(data, p, b, ids);
  assert.equal(relinked.created, true, 'a changed identity files a new record');
  assert.notEqual(b.product.productId, a.product.productId);
});

test('documents and dimensions survive the project file; the slice carries the fixture\'s product', () => {
  const p = kitchen(), f = p.fixtures.find(x => x.id === 'fx-dw');
  f.product = fx.normaliseProduct({ brand: 'Acme', model: 'DW-24', productId: 'prod-dw', asset: { fileId: 'product-dw', format: 'glb', sourceFileId: 'source-dw', bounds: { min: [0, 0, 0], max: [0.6, 0.86, 0.6] } } }, 'box');
  const record = { id: 'prod-dw', name: 'Acme DW-24', brand: 'Acme', model: 'DW-24', category: 'appliance', url: '', price: 0, unit: 'ea', imageUrl: '', specs: '', notes: '', itemIds: [],
    documents: [
      { kind: 'installation', title: 'Installation instructions', path: 'Product documents/Acme DW-24/install.pdf', url: 'https://maker.example.com/install.pdf', sha256: 'a'.repeat(64), bytes: 12, mime: 'application/pdf', fetchedAt: '2026-11-02T12:00:00Z' },
      { kind: 'manual', title: 'Manual', fileId: 'doc-manual', url: 'https://maker.example.com/manual.pdf', sha256: 'b'.repeat(64), mime: 'application/pdf' },
      { kind: 'other', path: '../outside.pdf' },
      { kind: 'other', url: 'http://10.0.0.2/x.pdf' }],
    dims: { w: 0.597, d: 0.62, h: 0.86, detail: { kick: 0.11 }, source: { title: 'Spec sheet', url: 'https://maker.example.com/spec.pdf', page: 2 } }, fixtureSubtype: 'dishwasher' };
  store.replaceWorkspace({ version: 1, settings: { units: 'metric' }, properties: [p], materials: [], products: [record, { id: 'prod-other', name: 'Unrelated', itemIds: [] }], projects: [] });
  const saved = store.ws.data.products.find(r => r.id === 'prod-dw');
  assert.equal(saved.documents.length, 2, 'paths outside the folder and local addresses are dropped');
  assert.equal(saved.dims.detail.kick, 0.11);
  const slice = store.projectSlice('prop-k');
  assert.deepEqual(slice.products.map(r => r.id), ['prod-dw']);
  const fileIds = store.listAllFileIds();
  for (const id of ['product-dw', 'source-dw', 'doc-manual']) assert.ok(fileIds.includes(id), id + ' travels in the project file');
  const again = JSON.parse(JSON.stringify(slice));
  store.replaceWorkspace(Object.assign(again, { version: 1 }));
  const back = store.ws.data.properties[0].fixtures.find(x => x.id === 'fx-dw');
  assert.equal(back.product.productId, 'prod-dw');
  assert.equal(store.ws.data.products[0].documents[0].path, 'Product documents/Acme DW-24/install.pdf');
});

test('detailed stand-ins: every layout stays inside its box and takes the drawing\'s numbers', () => {
  const variants = { fridge: ['top-freezer', 'bottom-freezer', 'french', 'side-by-side', 'single'], 'washer-dryer': ['stacked', 'front-washer', 'front-dryer', 'top-washer'] };
  for (const [sub, layouts] of Object.entries(variants)) for (const layout of layouts) {
    const f = fx.normaliseFixture({ id: 'x', kind: 'appliance', subtype: sub, x: 0, y: 0, rot: 0, w: 0.7, d: 0.7, h: 1.8, detail: { layout } });
    const parts = fx.fixtureParts(f);
    assert.ok(parts.length > 4, sub + ' ' + layout + ' has its doors, handles and trim');
    for (const p of parts) for (const q of p.solid || p.pts) {
      assert.ok(Math.abs(q[0]) <= 0.35 + 1e-9 && Math.abs(q[1]) <= 0.35 + 1e-9, sub + ' ' + layout + ' stays in plan');
    }
  }
  const range = fx.normaliseFixture({ id: 'r', kind: 'appliance', subtype: 'range', x: 0, y: 0, w: 0.61, d: 0.66, h: 0.94, detail: { burners: 5, knobs: 7, fuel: 'gas' } });
  assert.equal(fx.fixtureParts(range).filter(p => p.solid && p.role === 'black').length, 7, 'seven knobs face the room');
  assert.deepEqual(detail.normaliseDetail('range', { burners: 99, fuel: 'plasma', drawer: 'yes' }), { fuel: 'gas', burners: 6, knobs: 6, backguard: 0.08, drawer: true, window: true });
  const panel = fx.normaliseFixture({ id: 'p', kind: 'fitting', subtype: 'panel', x: 0, y: 0, w: 0.36, d: 0.1, h: 0.6, detail: { circuits: [{ n: 1, label: 'Kitchen counter', amps: 20 }, { n: 3, label: 'Range', amps: 40, poles: 2 }, 'junk'] } });
  assert.deepEqual(panel.detail.circuits, [{ n: 1, label: 'Kitchen counter', amps: 20, poles: 1 }, { n: 3, label: 'Range', amps: 40, poles: 2 }]);
});

test('the SketchUp mirror names product groups and sends fitted triangles, or keeps the stand-in and says why', async () => {
  const p = kitchen(), f = p.fixtures.find(x => x.id === 'fx-dw');
  f.product = fx.normaliseProduct({ brand: 'Acme', brandConfidence: 'confirmed', model: 'DW-24', evidence: [{ media: 'IMG_1.JPG', reads: ['brand'] }],
    sources: ['https://maker.example.com/dw'], asset: { fileId: 'product-dw', bounds: { min: [-0.3, 0, -0.3], max: [0.3, 0.86, 0.32] } } }, 'box');
  const spec = mirrorSpec(p, []);
  const sf = spec.fixtures.find(x => x.id === 'fx-dw');
  assert.equal(sf.name, 'Dishwasher: Acme DW-24');
  assert.equal(sf.product.brandConfidence, 'confirmed'); assert.equal(sf.product.fileId, 'product-dw');
  const files = {};
  await attachProductMeshes(p, spec, files, async fix => ({ format: 'tiksi-product-mesh', version: 1, meshes: [{ name: 'Door', color: '#cccccc', positions: [0, 0, 0, 0.1, 0, 0, 0, 0, 0.1] }], id: fix.id }));
  assert.equal(sf.mesh, 'product/fx-dw.json');
  assert.ok(files['product/fx-dw.json']);
  const spec2 = mirrorSpec(p, []);
  await attachProductMeshes(p, spec2, {}, async () => { throw new Error('model file is not in this browser'); });
  assert.equal(spec2.fixtures.find(x => x.id === 'fx-dw').mesh, undefined);
  assert.match(spec2.warnings.join(' '), /3D model of Dishwasher: Acme DW-24 was not sent \(model file is not in this browser\)/);
});

test('lengths and dimension facts read from spec sheets', () => {
  assert.equal(pr.parseLength('23 7/8 in'), 0.6064); assert.equal(pr.parseLength('606 mm'), 0.606); assert.equal(pr.parseLength('60.6 cm'), 0.606);
  assert.equal(pr.parseLength('5\' 9"'), 1.7526); assert.equal(pr.parseLength('n/a'), null);
  assert.deepEqual(pr.dimsFromFacts([{ name: 'Product Width', value: '23 7/8"' }, { name: 'Depth with door open', value: '48 in' }, { name: 'Depth', value: '24 5/8 in' }, { name: 'Height', value: '33 7/8 in' }]),
    { w: 0.6064, d: 0.6255, h: 0.8604 });
  assert.equal(pr.documentKind('FFBD2412SS Installation Instructions'), 'installation');
  assert.equal(pr.documentKind('', 'https://maker.example.com/use-and-care-guide.pdf'), 'manual');
  assert.equal(pr.documentKind('Product Specifications'), 'spec-sheet');
});

// A minimal GLB: one triangle node translated by (1, 0, 2) and scaled 2x.
function tinyGlb() {
  const json = JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, translation: [1, 0, 2], scale: [2, 2, 2] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [0.3, 0.4, 0.3] }],
    bufferViews: [{ buffer: 0, byteLength: 36 }], buffers: [{ byteLength: 36 }] });
  const jb = new TextEncoder().encode(json.padEnd(Math.ceil(json.length / 4) * 4, ' ')), bin = new Uint8Array(36);
  new Float32Array(bin.buffer).set([0, 0, 0, 0.3, 0, 0, 0, 0.4, 0.3]);
  const out = new Uint8Array(12 + 8 + jb.length + 8 + bin.length), dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, out.length, true);
  dv.setUint32(12, jb.length, true); dv.setUint32(16, 0x4e4f534a, true); out.set(jb, 20);
  dv.setUint32(20 + jb.length, bin.length, true); dv.setUint32(24 + jb.length, 0x004e4942, true); out.set(bin, 28 + jb.length);
  return out;
}

test('GLB bounds follow the node tree', () => {
  const b = glbBounds(tinyGlb());
  assert.deepEqual(b.min.map(v => Math.round(v * 1e6) / 1e6), [1, 0, 2]);
  assert.deepEqual(b.max.map(v => Math.round(v * 1e6) / 1e6), [1.6, 0.8, 2.6]);
  assert.throws(() => glbBounds(new Uint8Array(40)), /not a GLB/);
});

test('onboarding findings land in a copy of the project file, with the model, documents and drawing applied', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tiksi-onboard-'));
  try {
    const p = kitchen();
    const data = { version: 1, settings: { units: 'metric' }, properties: [p], materials: [], products: [], projects: [] };
    const project = join(dir, 'Synthetic.tiksi');
    writeFileSync(project, zipSync({ 'workspace.json': strToU8(JSON.stringify(data)), 'manifest.json': strToU8(JSON.stringify({ format: 'tiksi-project', version: 1, files: [] })) }));
    writeFileSync(join(dir, 'dw.glb'), tinyGlb());
    writeFileSync(join(dir, 'dw.skp'), 'original bytes');
    const findings = { checkedAt: '2026-11-02', fixtures: [
      { fixture: 'fx-dw', brand: 'Acme', brandConfidence: 'confirmed', model: 'DW-24', modelConfidence: 'confirmed',
        evidence: [{ media: 'IMG_0001.MOV', at: 213.4, reads: ['brand'], note: 'logo' }], sources: [{ url: 'https://maker.example.com/dw24', title: 'Maker' }],
        dims: { w: 0.6, d: 0.62, h: 0.86, source: { title: 'Spec sheet' } },
        documents: [{ kind: 'spec-sheet', title: 'Spec sheet', path: 'Product documents/Acme DW-24/spec.pdf', url: 'https://maker.example.com/spec.pdf', sha256: 'c'.repeat(64), bytes: 10, mime: 'application/pdf', fetchedAt: '2026-11-02T12:00:00Z' }],
        model3d: { glb: 'dw.glb', source: 'dw.skp', origin: 'https://3dwarehouse.example.com/m/1', originName: 'Model site', turn: 0 } },
      { match: { subtype: 'mini-split', room: 'Kitchen' }, brand: 'Coolco', brandConfidence: 'confirmed', evidence: [{ keyframe: '2445', reads: ['brand'] }], assetNote: 'No model found' },
      { create: { kind: 'fitting', subtype: 'panel', x: 4.95, y: 0.6, rot: 270 }, brand: 'Breakerco', brandConfidence: 'likely', detail: { circuits: [{ n: 1, label: 'Kitchen', amps: 20 }] } },
      { fixture: 'fx-missing', brand: 'Nobody' }] };
    writeFileSync(join(dir, 'findings.json'), JSON.stringify(findings));
    const out = join(dir, 'Synthetic-onboarded.tiksi');
    const report = JSON.parse(execFileSync('node', ['scripts/onboard-apply.mjs', '--project', project, '--findings', join(dir, 'findings.json'), '--out', out], { encoding: 'utf8' }));
    assert.equal(report.fixtures.length, 4);
    assert.match(report.fixtures[3].error, /no such fixture/);
    assert.equal(report.fixtures[0].confidence, 'brand read, model likely', 'the model number was not read, so it stays likely');
    assert.deepEqual(report.fixtures[0].modelFit.scale, [1, 1.033, 1.075]);
    const zipped = unzipSync(new Uint8Array(readFileSync(out)));
    const saved = JSON.parse(strFromU8(zipped['workspace.json'])), manifest = JSON.parse(strFromU8(zipped['manifest.json']));
    const dw = saved.properties[0].fixtures.find(f => f.id === 'fx-dw');
    assert.equal(dw.product.asset.fileId.startsWith('product-'), true);
    assert.deepEqual(manifest.files.map(f => f.kind).sort(), ['product', 'source']);
    assert.equal(strFromU8(zipped[manifest.files.find(f => f.kind === 'source').path]), 'original bytes', 'the original model is kept byte for byte');
    assert.equal(saved.products.length, 1, 'only the identified model gets a PRODUCTS record');
    assert.equal(saved.products[0].documents[0].path, 'Product documents/Acme DW-24/spec.pdf');
    near(dw.d, 0.62, 1e-9, 'sized from the drawing');
    const panel = saved.properties[0].fixtures.find(f => f.subtype === 'panel');
    assert.equal(panel.product.brandConfidence, 'likely'); assert.equal(panel.detail.circuits[0].label, 'Kitchen');
    assert.equal(saved.properties[0].fixtures.find(f => f.id === 'fx-ms1').product.assetNote, 'No model found');
    assert.throws(() => execFileSync('node', ['scripts/onboard-apply.mjs', '--project', project, '--findings', join(dir, 'findings.json'), '--out', project], { stdio: 'pipe' }), /write to a new file/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
