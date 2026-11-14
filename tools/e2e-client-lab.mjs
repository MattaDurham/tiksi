// The client page in the lab and grouping pieces by project. A synthetic house (two rooms, a
// door between them, trim, a project with a subproject) is turned into a client copy with
// lab-publish.js and served the way the lab serves it (data/current.json, data/app/<code>/,
// data/v/<version>/). Then: on a computer, Tiksi's frame with only the client's groups in the
// left pane, Existing and the project, furniture, quality starting at Ultra, nothing selectable,
// and a click on the floor walking there; on a phone, the three-line button and the client's
// panel, and arrows at the doorway. Last, in MODEL: a wall's trim grouped as a subproject and
// RAISE BY moving every section of it.
// Synthetic data only. Run: node tools/e2e-client-lab.mjs (Playwright + Chromium installed).
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { dirname, resolve, extname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vendor = pathToFileURL(root + '/vendor/').href;
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'three') return { url: vendor + 'three.module.min.js', shortCircuit: true };
    if (spec.startsWith('three/addons/')) return { url: vendor + 'addons/' + spec.slice(13), shortCircuit: true };
    return next(spec, ctx);
  },
});
globalThis.indexedDB = { open() { throw new Error('no IndexedDB under Node'); } };
const store = await import('../js/store.js');
const { clientCopy } = await import('../js/lab-publish.js');

// The house: rooms A (x 0..4) and B (x 4..8), 4 m deep, a door in the wall between them.
function workspace() {
  const d = store.emptyWorkspace();
  const p = store.propertyTemplate('Synthetic House');
  const L = p.levels[0].id;
  const wall = (id, ax, ay, bx, by) => ({ id, level: L, ax, ay, bx, by, thickness: 0.12 });
  p.walls.push(wall('w-s', 0, 0, 8, 0), wall('w-e', 8, 0, 8, 4), wall('w-n', 8, 4, 0, 4), wall('w-w', 0, 4, 0, 0), wall('w-mid', 4, 0, 4, 4));
  p.openings.push({ id: 'o-door', wallId: 'w-mid', type: 'door', t: 0.5, width: 0.86, height: 2.03 });
  p.rooms.push({ id: 'r-a', level: L, name: 'Room A', pts: [[0, 0], [4, 0], [4, 4], [0, 4]], material: null, ceilingMaterial: null },
    { id: 'r-b', level: L, name: 'Room B', pts: [[4, 0], [8, 0], [8, 4], [4, 4]], material: null, ceilingMaterial: null });
  p.trims.push(
    { id: 't-base-s', wallId: 'w-s', style: 'baseboard', side: 1, f0: 0, f1: 0.5, y: 0 },
    { id: 't-rail-w', wallId: 'w-w', style: 'chair-rail', side: 1, f0: 0, f1: 1, y: 0.84, projectId: 'pj-trim' },
    { id: 't-rail-s', wallId: 'w-s', style: 'chair-rail', side: 1, f0: 0, f1: 0.5, y: 0.84, projectId: 'pj-trim' },
  );
  p.savedViews.push({ id: 'v-a', name: 'Room A', camera: { position: [1, 1.6, 2], target: [3.5, 1.2, 2], fov: 50 }, mode: 'orbit', tags: {}, section: { on: false, height: 1.2 }, xray: false, hiddenLevels: [] },
    { id: 'v-b', name: 'Room B', camera: { position: [7, 1.6, 2], target: [4.5, 1.2, 2], fov: 50 }, mode: 'orbit', tags: {}, section: { on: false, height: 1.2 }, xray: false, hiddenLevels: [] });
  d.properties.push(p); d.settings.activePropertyId = p.id;
  d.projects.push({ id: 'pj-trim', propertyId: p.id, name: 'Wall trim: rails (design v1)', parentId: '', category: 'interior', status: 'idea', selected: false, startDate: '', notes: 'private', items: [] });
  return d;
}

const data = workspace();
const furnitureTag = (data.properties[0].tags || []).find(t => t.id === 'tag-furniture') ? ['tag-furniture'] : [];
const { copy } = clientCopy(data, data.properties[0].id, { projects: [{ id: 'pj-trim', label: 'Wall trim' }], furnitureTags: furnitureTag });
const CODE = 'e2e0c0de';
const types = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(req.url.split('?')[0]);
  const send = (body, type) => { res.setHeader('Content-Type', type); res.end(body); };
  if (path === '/lab/house/') return send(await readFile(root + '/client.html'), 'text/html');
  if (path === '/lab/house/data/current.json') return send(JSON.stringify({ format: 'tiksi-client', version: 'v1', app: CODE }), 'application/json');
  if (path === '/lab/house/data/v/v1/property.json') return send(JSON.stringify(copy), 'application/json');
  let file = null;
  if (path.startsWith(`/lab/house/data/app/${CODE}/`)) file = resolve(root, '.' + path.slice(`/lab/house/data/app/${CODE}`.length));
  else file = resolve(root, '.' + (path === '/' ? '/index.html' : path));
  if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  try { send(await readFile(file), types[extname(file)] || 'application/octet-stream'); } catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(+(process.env.E2E_APP_PORT || 0), 'localhost', r));
const url = `http://localhost:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const errors = [];
const check = (ok, label) => { assert.ok(ok, label); console.log('  ok   ' + label); };
const viewer = (page, fn) => page.evaluate(async src => {
  const v = await import(new URL(`./data/app/${'e2e0c0de'}/js/viewer3d.js`, location.href).href);
  const s = await import(new URL(`./data/app/${'e2e0c0de'}/js/store.js`, location.href).href);
  return (0, eval)(src)(v, s);
}, fn.toString());
async function open(context) {
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(url + '/lab/house/');
  await page.waitForFunction(() => !document.getElementById('client-wait'), null, { timeout: 60000 });
  return page;
}

try {
  console.log('\n[computer] Tiksi\'s frame, with only what a client has');
  const desk = await open(await browser.newContext({ viewport: { width: 1400, height: 900 } }));
  const groups = await desk.$$eval('#side .sd-group .sd-head span', els => els.map(e => e.textContent));
  check(JSON.stringify(groups) === JSON.stringify(['SAVED VIEWS', 'SHOW', 'CAMERA', ...(furnitureTag.length ? ['DISPLAY'] : []), 'QUALITY']), 'the left pane holds saved views, show, camera' + (furnitureTag.length ? ', display' : '') + ' and quality: ' + groups.join(', '));
  check(await desk.$$eval('#rail a', a => a.map(x => x.textContent.trim()).join()) === 'MODEL', 'one page tab: MODEL');
  check(await desk.$eval('.v-layout > .inspector', e => getComputedStyle(e).display) === 'none', 'no inspector');
  check(await desk.$$eval('.v-views [data-view-add], .v-views [data-view-edit]', e => e.length) === 0, 'saved-view tabs with no add or edit');
  check(await viewer(desk, (v) => v.qualityState().quality) === 'ultra', 'quality starts at Ultra');
  const hiddenRails = () => viewer(desk, (v, s) => ['t-rail-w', 't-rail-s', 't-base-s'].map(id => !!(s.ws.data.properties[0].hidden || {})['trim:' + id]));
  check(JSON.stringify(await hiddenRails()) === '[true,true,false]', 'Existing hides the project\'s trim and shows the rest');
  await desk.click('#side [data-client-show="pj-trim"]');
  check(JSON.stringify(await hiddenRails()) === '[false,false,false]', 'Wall trim shows it');
  check(await desk.$eval('#side [data-client-show="pj-trim"]', b => b.classList.contains('active')), 'and is marked in the pane');
  await desk.click('#side [data-quality="medium"]');
  check(await viewer(desk, (v) => v.qualityState().quality) === 'medium', 'the quality switch lowers it');
  // A click selects nothing.
  await desk.mouse.click(800, 450);
  check(await viewer(desk, (v, s) => document.querySelector('.inspector').offsetParent === null), 'a click on the model opens nothing');
  // Walk, then click the floor ahead.
  await desk.click('#side [data-act="walk"]');
  await desk.waitForTimeout(400);
  const before = await viewer(desk, (v) => v.cameraState().position);
  const box = await desk.locator('.canvas-wrap canvas').boundingBox();
  await desk.mouse.click(box.x + box.width / 2, box.y + box.height * 0.8);
  await desk.waitForFunction(async () => true);
  await desk.waitForTimeout(2800);
  const after = await viewer(desk, (v) => v.cameraState().position);
  check(Math.hypot(after[0] - before[0], after[2] - before[2]) > 0.3 && Math.abs(after[1] - before[1]) < 1e-6, 'a click on the floor walks there at eye height');

  console.log('\n[phone] the phone layout: the three-line button and the client\'s panel');
  const phone = await open(await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }));
  check(await phone.evaluate(() => document.documentElement.classList.contains('phone')), 'the phone layout');
  await phone.tap('.fd-menu');
  const sections = await phone.$$eval('.fd-panel .fd-section h2', els => els.map(e => e.textContent));
  check(sections.includes('View') && sections.includes('Show') && sections.includes('Saved views') && sections.includes('Quality on this device') && !sections.includes('Capture') && !sections.includes('Pages'), 'the panel offers view, show, saved views and quality, no capture or pages: ' + sections.join(', '));
  check(await phone.$$eval('.fd-panel [data-act="save-view"], .fd-save:not([hidden])', e => e.filter(x => x.offsetParent).length) === 0, 'nothing to save');
  await phone.tap('.fd-panel [data-act="view"][data-id="v-a"]');
  await phone.waitForTimeout(900);
  await phone.tap('.fd-menu');
  await phone.tap('.fd-panel [data-act="mode"][data-id="walk"]');
  await phone.waitForTimeout(600);
  const arrows = await viewer(phone, (v) => v.walkArrowState());
  check(arrows.on && arrows.count === 1 && arrows.inScene, 'one arrow on the floor at the doorway in this room');

  console.log('\n[MODEL] a wall\'s trim grouped as a subproject moves as one');
  const edit = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  edit.on('pageerror', e => errors.push(e.message));
  edit.on('dialog', d => d.accept());
  await edit.goto(url + '/#/model');
  await edit.waitForSelector('#btn-file', { state: 'attached' });
  await edit.evaluate(async d => { const s = await import('/js/store.js'); s.replaceWorkspace(d); }, data);
  await edit.goto(url + '/#/model?select=w-s');
  await edit.waitForSelector('[data-wall-trims]');
  await edit.click('[data-wall-trims]');
  await edit.waitForSelector('.v-project');
  await edit.click('.v-project summary');
  await edit.fill('[data-pp-name]', 'South wall');
  await edit.click('[data-pp-group]');
  const grouped = await edit.evaluate(async () => { const s = await import('/js/store.js'); const sub = s.ws.data.projects.find(p => p.name === 'South wall'); return { parent: sub && sub.parentId, ids: s.ws.data.properties[0].trims.filter(t => sub && t.projectId === sub.id).map(t => t.id).sort() }; });
  check(grouped.parent === 'pj-trim' && grouped.ids.join() === 't-base-s,t-rail-s', 'GROUP made a subproject of the trim project holding the wall\'s trim: ' + grouped.ids.join(', '));
  check((await edit.locator('.v-project .stat-line').first().innerText()).startsWith('Group: South wall'), 'the inspector names the group');
  const ys = () => edit.evaluate(async ids => { const s = await import('/js/store.js'); return s.ws.data.properties[0].trims.filter(t => ids.includes(t.id)).map(t => t.y); }, grouped.ids);
  const y0 = await ys();
  await edit.click('[data-raise]');
  await edit.keyboard.type('1"');
  await edit.keyboard.press('Enter');
  await edit.waitForTimeout(300);
  const y1 = await ys();
  check(y1.every((y, i) => Math.abs(y - y0[i] - 0.0254) < 1e-6), 'RAISE BY 1" moved every section of the group up by 1": ' + JSON.stringify([y0, y1]));

  check(!errors.length, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  console.log('\nAll client lab checks passed.');
} finally {
  await browser.close();
  server.close();
}
