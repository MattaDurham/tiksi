// Real-world materials and SketchUp-style components in a real browser, on synthetic data.
// With the SketchUp SDK installed the model goes through the real converter: a wine rack of 300
// bottle instances and cabinets with nested hinges and screws. MODEL lists each material and
// component once, selects a component's instances, links one to a product, binds a material for
// all its parts, converts an old flattened import again (keeping its tags and material choice),
// and an SKP export brings the components back. MATERIALS edits what a material really is.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const root = resolve(new URL('..', import.meta.url).pathname), state = await mkdtemp(tmpdir() + '/tiksi-real-materials-');
const socket = net.createServer(); await new Promise(r => socket.listen(Number(process.env.E2E_APP_PORT) || 0, '127.0.0.1', r)); const port = socket.address().port; await new Promise(r => socket.close(r));
const child = spawn('python3', ['tools/serve.py', '--port', String(port), '--state-dir', state], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
// Read the server's output: an unread pipe fills after about 64 KB of request log lines on Linux,
// and then every server thread stops at its next log line and the page hangs.
child.stdout.resume(); child.stderr.resume();
const url = 'http://127.0.0.1:' + port;
let browser;
async function waitUntil(predicate, message, timeoutMs = 60_000) {
  const deadline = performance.now() + timeoutMs;
  while (!(await predicate())) { assert.ok(performance.now() < deadline, 'Timed out: ' + message); await delay(150); }
}
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(url)).ok) break; } catch {} await delay(50); }
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => localStorage.setItem('tiksi.onScreen.v1', '{"all":true}'));
  await page.goto(url); await page.waitForFunction(() => document.querySelector('#save-status').textContent === 'SAVED TO DISK');
  const setup = await page.evaluate(async () => {
    const THREE = await import('three');
    const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
    const store = await import('/js/store.js'), { ensureBuiltinMaterials } = await import('/js/materials.js');
    const { importScanBytes, loadMesh } = await import('/js/scans.js'), { converterCapabilities, nativeConvert } = await import('/js/native-conversion.js');
    (await import('/js/textures.js')).setTextureQuality('low');
    store.ws.data = store.emptyWorkspace(); ensureBuiltinMaterials();
    const p = store.propertyTemplate('Synthetic cellar'); store.ws.data.properties.push(p); store.ws.data.settings.activePropertyId = p.id;
    store.ws.data.materials.push({ id: 'mat-owner-plaster', name: 'Painted plaster · warm white', kind: 'wall', color: '#f1ece2', pattern: 'plaster', custom: true });
    ensureBuiltinMaterials();
    const cap = await converterCapabilities().catch(() => ({}));
    const at = (x, y = 0, z = 0) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
    const tri = s => [0, 0, 0, s, 0, 0, 0, s, 0, s, 0, 0, s, s, 0, 0, s, 0];
    const glass = { name: 'Bottle glass', color: [.1, .35, .2, 1] }, oak = { name: 'Rack oak', color: [.7, .5, .3, 1] }, steel = { name: 'Steel', color: [.6, .6, .6, 1] };
    const json = { meshes: [{ name: 'Rack shelf', positions: tri(3).map((v, i) => i % 3 === 2 ? v : v), material: oak }],
      components: [{ id: 'bottle', name: 'Wine bottle', meshes: [{ name: 'Wine bottle', positions: tri(.08), material: glass }, { name: 'Cork', positions: tri(.02).map((v, i) => i % 3 === 1 ? v + .3 : v), material: oak }] },
        { id: 'screw', name: 'Screw #8', meshes: [{ name: 'Screw', positions: tri(.005), material: steel }] },
        { id: 'hinge', name: 'Hinge', meshes: [{ name: 'Hinge', positions: tri(.05), material: steel }], instances: [0, 1, 2].map(i => ({ component: 'screw', matrix: at(.01 * i) })) },
        { id: 'cabinet', name: 'Base cabinet', meshes: [{ name: 'Cabinet', positions: tri(.6), material: oak }], instances: [0, 1].map(i => ({ component: 'hinge', matrix: at(0, .2 * i) })) }],
      instances: [...Array.from({ length: 300 }, (_, i) => ({ component: 'bottle', matrix: at((i % 30) * .1, 0, (i / 30 | 0) * .1) })), ...[0, 1].map(i => ({ component: 'cabinet', matrix: at(4 + i, 0, 0) }))] };
    let buffer, name;
    if (cap.sketchup) {
      const skp = await nativeConvert(new TextEncoder().encode(JSON.stringify(json)), '.json', 'skp');
      buffer = skp.buffer; name = 'cellar.skp';
    } else {
      // No SDK: the same structure as the converter writes, from three.js nodes with extras.
      const scene = new THREE.Scene();
      const geo = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(tri(.08), 3));
      const mat = new THREE.MeshStandardMaterial({ name: 'Bottle glass' });
      for (const p of json.instances.filter(i => i.component === 'bottle')) {
        const n = new THREE.Group(); n.userData = { sketchupComponent: 'Wine bottle', sketchupDefinitionId: 'guid-bottle' }; n.applyMatrix4(new THREE.Matrix4().fromArray(p.matrix));
        n.add(new THREE.Mesh(geo, mat)); scene.add(n);
      }
      buffer = await new GLTFExporter().parseAsync(scene, { binary: true }); name = 'cellar.glb';
    }
    const scan = await importScanBytes(buffer.slice(0), name, p);
    // An import from before components were kept: every mesh flattened into world space with its
    // own material copy, a positional binding, and the original SKP stored beside it.
    let old = null;
    if (cap.sketchup) {
      const loaded = await loadMesh((await store.getFile(scan.id)).buffer, 'glb'); loaded.updateMatrixWorld(true);
      const flat = new THREE.Scene();
      loaded.traverse(o => { if (o.isMesh) { const g = o.geometry.clone().applyMatrix4(o.matrixWorld); const m = new THREE.Mesh(g, o.material.clone()); m.name = o.userData.name || o.name; flat.add(m); } });
      const flatGlb = await new GLTFExporter().parseAsync(flat, { binary: true });
      await store.putFile('scan-old', flatGlb, { name: 'old cellar.glb', format: 'glb', kind: 'mesh' });
      await store.putFile('source-old', buffer.slice(0), { name: 'old cellar.skp', format: 'skp', kind: 'source' });
      old = { id: 'scan-old', name: 'old cellar.glb', originalName: 'old cellar.skp', originalFileId: 'source-old', format: 'glb', kind: 'mesh', pos: [0, 0, 6], rot: [0, 0, 0], rotY: 0, scale: 1, visible: true,
        materialBindings: { 'slot-0': 'mat-owner-plaster' } };
      p.scans.push(old);
    }
    store.touch();
    return { sketchup: !!cap.sketchup, scanId: scan.id, old: !!old };
  });
  await page.locator('#rail a[data-view=model]').click(); await page.locator('canvas.v-canvas').waitFor();
  const open = async id => {
    await page.locator(`.v-scan-row[data-scan="${id}"]`).click();
    await page.locator('.model-panel').waitFor({ timeout: 90_000 });
  };
  await waitUntil(async () => (await page.locator(`.v-scan-row[data-scan="${setup.scanId}"]`).getAttribute('title'))?.includes('(') === false, 'the model loads', 120_000);
  await open(setup.scanId);
  const panel = page.locator('.model-panel');
  const esc = t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const comp = name => panel.locator('.mp-comp').filter({ has: page.locator('.mp-comp-head b', { hasText: new RegExp('^' + esc(name) + '$') }) });
  const bottle = comp('Wine bottle');
  assert.match(await bottle.locator('.mp-count').innerText(), /× 300/, 'one component definition, drawn 300 times');
  if (setup.sketchup) {
    assert.match(await comp('Screw #8').locator('.mp-count').innerText(), /× 12/, '2 cabinets x 2 hinges x 3 screws');
    assert.match(await comp('Hinge').innerText(), /each holds 3 × Screw #8/);
    assert.match(await panel.locator('h3', { hasText: 'MATERIALS' }).innerText(), /MATERIALS · 3/, 'glass, oak and steel, each once');
    assert.match(await panel.locator('[data-mp-slot="m:Bottle glass"] label').innerText(), /300 parts/i);
  }
  // SELECT picks every instance as one object each (300 bottles, whatever they are drawn
  // with), and the panel's tag line then changes them all.
  await bottle.locator('[data-mp-select]').click();
  await page.locator('.inspector h3', { hasText: '300 OBJECTS' }).waitFor();
  assert.equal(await page.evaluate(async id => { const v = await import('/js/viewer3d.js'); return v.objectKeys(id, 'Wine bottle').length; }, setup.scanId), setup.sketchup ? 600 : 300, 'the bottles are drawn with ' + (setup.sketchup ? 'two meshes each' : 'one mesh each'));
  // A clicked part names its component.
  const partKey = await page.evaluate(async id => { const s = await import('/js/store.js'); return Object.keys(s.activeProperty().tagOf).find(k => k.startsWith('node:' + id + '#')); }, setup.scanId);
  assert.ok(partKey, 'the model\'s parts are tagged');
  // Link the bottle to a real product by maker and model number.
  await page.locator('.v-scan-row[data-scan="' + setup.scanId + '"]').click();
  await comp('Wine bottle').locator('summary').click();
  const row = comp('Wine bottle');
  await row.locator('[data-mp-brand]').fill('Example Glassworks'); await row.locator('[data-mp-model]').fill('BDX-750-G');
  await row.locator('[data-mp-name]').fill('Bordeaux bottle 750 ml');
  await row.locator('[data-mp-link]').click();
  await comp('Wine bottle').locator('.mp-facts', { hasText: 'Bordeaux bottle 750 ml' }).waitFor();
  const linked = await page.evaluate(async id => {
    const s = await import('/js/store.js'), p = s.activeProperty(), scan = p.scans.find(x => x.id === id);
    const rec = s.ws.data.products.find(r => r.model === 'BDX-750-G'); rec.price = 1.25; s.touch();
    return { link: Object.values(scan.componentProducts || {})[0], rec: { id: rec.id, propertyIds: rec.propertyIds } };
  }, setup.scanId);
  assert.equal(linked.link.productId, linked.rec.id); assert.ok(linked.rec.propertyIds.length === 1);
  // A price on the product prices the count: the component estimate goes to the budget.
  await page.locator('.v-scan-row[data-scan="' + setup.scanId + '"]').click();
  await comp('Wine bottle').locator('.mp-facts', { hasText: '$375' }).waitFor();
  await panel.locator('[data-component-estimate]').click();
  const estimate = await page.evaluate(async id => { const s = await import('/js/store.js'); const pr = s.ws.data.projects.find(x => x.modelComponentsId === id); return { likely: s.projectTotals(pr).likely, items: pr.items.length }; }, setup.scanId);
  assert.equal(estimate.likely, 375, '300 bottles at $1.25');
  // Binding a model material changes every part using it, through one shared material.
  await panel.locator('[data-model-material="m:Bottle glass"]').selectOption('mat-glass');
  await waitUntil(async () => (await page.evaluate(async id => { const s = await import('/js/store.js'); return s.activeProperty().scans.find(x => x.id === id).materialBindings?.['m:Bottle glass']; }, setup.scanId)) === 'mat-glass', 'binding saved');
  const shared = await page.evaluate(async id => {
    const s = await import('/js/store.js'), { loadMesh } = await import('/js/scans.js'), { applyModelMaterials } = await import('/js/model-materials.js');
    const scan = s.activeProperty().scans.find(x => x.id === id), obj = await loadMesh((await s.getFile(id)).buffer, scan.format);
    await applyModelMaterials(scan, obj);
    const used = new Set(); let n = 0;
    obj.traverse(o => { if (o.isMesh && o.userData.sourceMaterials[0].name === 'Bottle glass') { used.add(o.material); n++; } });
    return { materials: [...used].map(m => m.userData.materialId), n };
  }, setup.scanId);
  assert.deepEqual(shared.materials, ['mat-glass'], 'one replacement for all ' + shared.n + ' bottle bodies');
  if (setup.old) {
    // The old flattened import: its positional binding moved to the material key on load.
    await open('scan-old');
    const before = await page.evaluate(async () => { const s = await import('/js/store.js'); const p = s.activeProperty(), sc = p.scans.find(x => x.id === 'scan-old');
      const keys = Object.keys(p.tagOf).filter(k => k.startsWith('node:scan-old#')); for (const k of keys) p.tagOf[k] = 'tag-furniture'; s.touch();
      return { bindings: sc.materialBindings, keys: keys.length }; });
    assert.equal(Object.keys(before.bindings).length, 1); assert.match(Object.keys(before.bindings)[0], /^m:/, 'slot-0 became a material key');
    assert.equal(Object.values(before.bindings)[0], 'mat-owner-plaster');
    assert.equal(await panel.locator('.mp-comp').count(), 0, 'a flattened import has no components');
    await panel.locator('[data-mp-reconvert]').click();
    await comp('Wine bottle').waitFor({ timeout: 120_000 });
    const after = await page.evaluate(async () => { const s = await import('/js/store.js'); const p = s.activeProperty(), sc = p.scans.find(x => x.id === 'scan-old');
      const keys = Object.keys(p.tagOf).filter(k => k.startsWith('node:scan-old#')); return { bindings: sc.materialBindings, tags: [...new Set(keys.map(k => p.tagOf[k]))], keys: keys.length }; });
    assert.deepEqual(after.bindings, before.bindings, 'the material choice carries over');
    assert.deepEqual(after.tags, ['tag-furniture'], 'the parts keep the tag they had');
    assert.ok(after.keys >= before.keys, 'every new part is tagged');
    assert.equal(await panel.locator('[data-mp-reconvert]').count(), 0, 'not offered again');
    // SketchUp gets the components back as components.
    const back = await page.evaluate(async id => {
      const s = await import('/js/store.js'), { exportModel } = await import('/js/model-exchange.js'), { importScanBytes, loadMesh } = await import('/js/scans.js');
      const { modelComponents } = await import('/js/model-components.js');
      const p = s.activeProperty(), out = await exportModel(p, { format: 'skp', source: 'model', scanId: id });
      const scan = await importScanBytes(await out.blob.arrayBuffer(), out.name, p), obj = await loadMesh((await s.getFile(scan.id)).buffer, 'glb');
      scan.visible = false; s.touch();
      return modelComponents(obj).map(c => [c.name, c.count]);
    }, setup.scanId);
    assert.deepEqual(back, [['Base cabinet', 2], ['Hinge', 4], ['Screw #8', 12], ['Wine bottle', 300]], 'an SKP export keeps the components and their nesting');
  }
  // MATERIALS: say what a material is, its colour and its product; the card shows it.
  await page.locator('#rail a[data-view=materials]').click();
  // Building the page synthesises textures and draws every swatch; on a slow software-GL
  // runner that blocks input for many seconds. Wait until it has settled, then click.
  await page.waitForFunction(async () => (await import('/js/textures.js')).pendingTextureJobs() === 0
    && [...document.querySelectorAll('.mv-card img')].every(img => !img.hidden && img.complete), null, { timeout: 180_000, polling: 500 });
  await page.locator('.mv-card[data-id="mat-owner-plaster"]').click({ timeout: 120_000 });
  assert.equal(await page.locator('.mv-editor [data-f=category]').inputValue(), 'plaster', 'the owner\'s painted plaster was migrated as plaster');
  await page.locator('.mv-editor [data-ident=type]').fill('Lime plaster'); await page.locator('.mv-editor [data-ident=type]').press('Tab');
  await page.locator('.mv-editor [data-ident=colorName]').fill('White Dove'); await page.locator('.mv-editor [data-ident=colorName]').press('Tab');
  await page.locator('.mv-editor [data-ident=colorCode]').fill('OC-17'); await page.locator('.mv-editor [data-ident=colorCode]').press('Tab');
  await page.locator('.mv-editor [data-ident=colorBrand]').fill('Benjamin Moore'); await page.locator('.mv-editor [data-ident=colorBrand]').press('Tab');
  await page.locator('.mv-editor [data-p=brand]').fill('Example Lime Co'); await page.locator('.mv-editor [data-p=brand]').press('Tab');
  await page.locator('.mv-editor [data-p=model]').fill('LP-200'); await page.locator('.mv-editor [data-p=model]').press('Tab');
  await page.locator('.mv-editor [data-product-add]').click();
  await page.locator('.mv-editor [data-cov=area]').fill('60'); await page.locator('.mv-editor [data-cov=area]').press('Tab');
  const card = page.locator('.mv-card[data-id="mat-owner-plaster"] .mv-real');
  await waitUntil(async () => /Lime plaster/.test(await card.innerText()) && /Benjamin Moore White Dove OC-17/.test(await card.innerText()), 'the card shows what it is');
  const rec = await page.evaluate(async () => { const s = await import('/js/store.js'); const m = s.ws.data.materials.find(x => x.id === 'mat-owner-plaster');
    const pr = s.ws.data.products.find(x => x.model === 'LP-200'); return { m: { category: m.category, type: m.type, colorCode: m.colorCode, product: m.product, coverage: m.coverage, name: m.name }, pr: pr && pr.materialIds }; });
  assert.equal(rec.m.name, 'Painted plaster · warm white', 'the name is untouched');
  assert.equal(rec.m.type, 'Lime plaster'); assert.equal(rec.m.colorCode, 'OC-17');
  assert.equal(rec.m.product.brand, 'Example Lime Co'); assert.ok(rec.m.product.productId, 'linked to the products list');
  assert.deepEqual(rec.pr, ['mat-owner-plaster']);
  assert.ok(Math.abs(rec.m.coverage.areaM2 - 60 * 0.09290304) < 1e-4, "60 sf per unit");
  await page.locator('.mv-search').fill('white dove');
  assert.equal(await page.locator('.mv-card').count(), 1, 'search finds a material by its colour');
  assert.deepEqual(errors, []);
  console.log('real materials: ' + (setup.sketchup ? 'real SketchUp conversion; ' : 'no SketchUp SDK, synthetic components; ') + 'materials and components listed once, instances selected, product linked and priced, material bound for all parts' + (setup.old ? ', old import converted again with tags and binding kept, SKP export keeps components' : '') + ', material identity edited');
} finally {
  await browser?.close();
  child.kill();
  await rm(state, { recursive: true, force: true });
}
