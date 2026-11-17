// The client page in the lab and grouping pieces by project. A synthetic house (two rooms, a
// door between them, trim, a project with a subproject) is turned into a client copy with
// lab-publish.js and served the way the lab serves it (data/current.json, data/app/<code>/,
// data/v/<version>/). Then: on a computer, Tiksi's frame with only the client's groups in the
// left pane, Existing and the project, furniture, quality starting at Ultra, nothing selectable,
// and a double-click on the floor going there; on a phone, the three-line button and the
// client's panel, and a double tap going there. In MODEL: a wall's trim grouped as a subproject
// and RAISE BY moving every section of it. Last, the saved views as the client gets them: RENDER
// THIS VIEW files a rendering on its view, SEND TO THE LAB lists it under the view with a
// switch, the send (to a stand-in for the Mac's lab sender) has the client page's own code take
// a picture of every view per project, and the page it sent shows the views as pills along the
// top, the renderings as small pictures, a rendering in a window floating over the model that
// steps through all of them (the model following), lays itself over the model half clear, and
// keeps the client's star and comment in the website's note store (a stand-in here).
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
const stamp = await import('../js/rendering-stamp.js');

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
  // The south baseboard stands in for a piece of furniture. Room A was saved with furniture on;
  // Room B with it off and the baseboard hidden one by one, as views in MODEL are.
  p.tagOf = { ...(p.tagOf || {}), 'trim:t-base-s': 'tag-furniture' };
  p.savedViews.push({ id: 'v-a', name: 'Room A', camera: { position: [1, 1.6, 2], target: [3.5, 1.2, 2], fov: 50 }, mode: 'orbit', tags: { 'tag-furniture': true }, section: { on: false, height: 1.2 }, xray: false, hiddenLevels: [], hidden: [] },
    { id: 'v-b', name: 'Room B', camera: { position: [7, 1.6, 2], target: [4.5, 1.2, 2], fov: 50 }, mode: 'orbit', tags: { 'tag-furniture': false }, section: { on: false, height: 1.2 }, xray: false, hiddenLevels: [], hidden: ['trim:t-base-s'] },
    // Looking at the west wall of room A, where the project's chair rail runs.
    { id: 'v-w', name: 'West wall', camera: { position: [3, 1.6, 2], target: [0.5, 1.2, 2], fov: 50 }, mode: 'orbit', tags: {}, section: { on: false, height: 1.2 }, xray: false, hiddenLevels: [] },
    { id: 'v-x', name: 'Spare', camera: { position: [6, 1.6, 3], target: [4.5, 1.2, 1], fov: 50 }, mode: 'orbit', tags: {}, section: { on: false, height: 1.2 }, xray: false, hiddenLevels: [] });
  d.properties.push(p); d.settings.activePropertyId = p.id;
  d.projects.push({ id: 'pj-trim', propertyId: p.id, name: 'Wall trim: rails (design v1)', parentId: '', category: 'interior', status: 'idea', selected: false, startDate: '', notes: 'private', items: [] });
  return d;
}

const data = workspace();
const furnitureTag = (data.properties[0].tags || []).find(t => t.id === 'tag-furniture') ? ['tag-furniture'] : [];
const { copy } = clientCopy(data, data.properties[0].id, { projects: [{ id: 'pj-trim', label: 'Wall trim' }], furnitureTags: furnitureTag });
const CODE = 'e2e0c0de';
const types = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
// A stand-in for the Mac's lab sender (server/lab_publish.py): it keeps what SEND TO THE LAB
// puts, and /lab-preview/<slug>/ shows it, as the Mac's preview copy does.
const sent = new Map();   // '<slug>/<path>' -> { body, type }
// A stand-in for the website's note store (/lab/api/annotations, functions/lab/api/annotations.js
// on the website): one row per (page, id), whoever wrote it; a PUT replaces the caller's own rows.
// The caller is the owner, who reads everyone's.
const OWNER = 'owner@example.invalid';
const noteRows = new Map();   // page -> Map(id -> { by, payload })
const notePuts = [];
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(req.url.split('?')[0]);
  const send = (body, type) => { res.setHeader('Content-Type', type); res.end(body); };
  const json = v => send(JSON.stringify(v), 'application/json');
  if (path === '/api/lab/capabilities') return json({ token: 'check', upload: false, site: 'https://lab.invalid/', preview: '/lab-preview/', reason: 'This check has no upload key: sends go to the preview copy only.' });
  if (path.startsWith('/api/lab/app/')) {
    // As the Mac does when asked to stream: a line per file finished, then the result.
    const chunks = [];
    for await (const c of req) chunks.push(c);
    if (!JSON.parse(Buffer.concat(chunks).toString() || '{}').stream) return json({ app: CODE, sent: 0, copied: 0 });
    res.setHeader('Content-Type', 'application/x-ndjson');
    for (let done = 0; done <= 4; done++) {
      res.write(JSON.stringify({ done, total: 4, bytes: done * 1e6, totalBytes: 4e6, copied: done > 1 ? done - 1 : 0 }) + '\n');
      await new Promise(r => setTimeout(r, 150));
    }
    return res.end(JSON.stringify({ app: CODE, sent: 1, copied: 3 }) + '\n');
  }
  if (path.startsWith('/api/lab/prune/')) return json({ removed: 0 });
  if (path === '/lab/api/annotations') {
    const page = new URL(req.url, 'http://x').searchParams.get('page') || '';
    const rows = noteRows.get(page) || noteRows.set(page, new Map()).get(page);
    if (req.method === 'GET') return json({ page, viewer: { email: OWNER, admin: true }, annotations: [...rows.values()].map(r => ({ ...r.payload, created_by: r.by, status: 'open' })) });
    if (req.method === 'PUT') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      for (const [id, r] of rows) if (r.by === OWNER) rows.delete(id);
      for (const a of body.annotations || []) rows.set(String(a.id), { by: OWNER, payload: a });
      notePuts.push(page);
      return json({ ok: true });
    }
    res.writeHead(405).end(); return;
  }
  // The copy sent to the stand-in, as the website serves it (/lab/<page>/), with its note store.
  if (path.startsWith('/lab/sent/')) {
    const rel = path.slice('/lab/sent/'.length);
    if (rel === '') return send(await readFile(root + '/client.html'), 'text/html');
    const code = `data/app/${CODE}/`;
    if (rel.startsWith(code)) {
      const file = resolve(root, rel.slice(code.length));
      if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
      try { return send(await readFile(file), types[extname(file)] || 'application/octet-stream'); } catch { res.writeHead(404).end(); return; }
    }
    const got = rel.startsWith('data/') && sent.get('synthetic-house/' + rel.slice(5));
    if (!got) { res.writeHead(404).end(); return; }
    return send(got.body, got.type);
  }
  if (path.startsWith('/api/lab/files/') && req.method === 'PUT') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    sent.set(path.slice('/api/lab/files/'.length), { body, type: req.headers['content-type'] || 'application/octet-stream' });
    return json({ bytes: body.length, uploaded: false });
  }
  if (path.startsWith('/lab-preview/')) {
    const [slug, ...rest] = path.slice('/lab-preview/'.length).split('/');
    const rel = rest.join('/');
    if (rel === '') return send(await readFile(root + '/client.html'), 'text/html');
    const code = `data/app/${CODE}/`;
    if (rel.startsWith(code)) {
      const file = resolve(root, rel.slice(code.length));
      if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
      try { return send(await readFile(file), types[extname(file)] || 'application/octet-stream'); } catch { res.writeHead(404).end(); return; }
    }
    const got = rel.startsWith('data/') && sent.get(slug + '/' + rel.slice(5));
    if (!got) { res.writeHead(404).end(); return; }
    return send(got.body, got.type);
  }
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
// The left pane slides away on the client page; it comes back with the pointer at the left edge.
// The online runners draw the model in software, seconds a frame, so the waits are long, and the
// pointer is moved to the edge again if the first move was not seen.
const PANE_WAIT = 30000;
const side = async (page, sel) => {
  const opened = () => page.evaluate(() => document.documentElement.classList.contains('cl-side-open'));
  for (let i = 0; i < 3 && !(await opened()); i++) {
    await page.mouse.move(40, 460);
    await page.mouse.move(2, 450, { steps: 2 });
    await page.waitForFunction(() => document.documentElement.classList.contains('cl-side-open'), null, { timeout: PANE_WAIT / 3, polling: 100 }).catch(() => {});
  }
  if (!(await opened())) throw new Error('the left pane did not open at the left edge');
  await page.waitForTimeout(280);
  await page.click('#side ' + sel);
};
// The pointer leaves the pane, and it slides away.
const away = async page => {
  await page.mouse.move(900, 300);
  await page.waitForFunction(() => !document.documentElement.classList.contains('cl-side-open'), null, { timeout: PANE_WAIT, polling: 100 });
  await page.waitForTimeout(300);
};
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
  // The saved views are pills along the top of the model; the strip under it has the iterations
  // (this copy has no renderings).
  check(await desk.$eval('.v-views', e => getComputedStyle(e).display) === 'flex' && await desk.$eval('.v-views .v-view-tab', e => getComputedStyle(e).borderRadius) === '999px', 'the saved views are pills along the top');
  check(await desk.$$eval('.v-views .v-view-tab', b => b.map(x => x.textContent).join()) === 'Room A,Room B,West wall,Spare', 'one pill per view');
  check(await desk.$eval('.v-views .v-view-tab.active', e => e.textContent) === 'Room A', 'the view the page opened at is marked');
  check(await desk.$$eval('.cl-strip .cl-iter', e => e.map(x => x.textContent + (x.classList.contains('on') ? '*' : '')).join()) === 'Existing,Wall trim*' && await desk.$$eval('.cl-strip .cl-card', e => e.length) === 0, 'the strip has Existing and the project, the project on');
  // The left pane shows when the page opens, then slides away; it comes back at the left edge.
  await desk.mouse.move(800, 450);
  await desk.waitForFunction(() => !document.documentElement.classList.contains('cl-side-open'), null, { timeout: PANE_WAIT, polling: 100 });
  await desk.waitForTimeout(300);
  const paneBox = await desk.locator('#side').boundingBox();
  check(paneBox.x + paneBox.width <= 1 && (await desk.locator('.v-wrap').boundingBox()).x < 5, 'the left pane slides away, and the model takes the width');
  await desk.mouse.move(2, 450);
  await desk.waitForFunction(() => document.documentElement.classList.contains('cl-side-open'), null, { timeout: PANE_WAIT, polling: 100 });
  await desk.waitForTimeout(300);
  check((await desk.locator('#side').boundingBox()).x >= -1, 'the pointer at the left edge brings it back');
  await desk.mouse.move(900, 450);
  await desk.waitForFunction(() => !document.documentElement.classList.contains('cl-side-open'), null, { timeout: PANE_WAIT, polling: 100 });
  check(true, 'and it slides away again when the pointer leaves it');
  await desk.waitForTimeout(350);
  const tabBox = await desk.locator('.cl-side-tab').boundingBox();
  await desk.mouse.move(tabBox.x + tabBox.width - 3, tabBox.y + tabBox.height / 2);
  await desk.waitForFunction(() => document.documentElement.classList.contains('cl-side-open'), null, { timeout: PANE_WAIT, polling: 100 });
  check(true, 'the pointer on the tab at the edge opens it too');
  await desk.mouse.click(900, 300);
  check(await desk.evaluate(() => !document.documentElement.classList.contains('cl-side-open')), 'and a click on the model puts it away');
  check(await viewer(desk, (v) => v.qualityState().quality) === 'ultra', 'quality starts at Ultra');
  const hiddenRails = () => viewer(desk, (v, s) => ['t-rail-w', 't-rail-s'].map(id => !!(s.ws.data.properties[0].hidden || {})['trim:' + id]));
  check(JSON.stringify(await hiddenRails()) === '[false,false]', 'the page opens on the renovation: Wall trim shows the project\'s trim');
  check(await desk.$eval('#side [data-client-show="pj-trim"]', b => b.classList.contains('active')), 'and the pane marks it');
  await side(desk, '[data-client-show="existing"]');
  check(JSON.stringify(await hiddenRails()) === '[true,true]', 'Existing hides the project\'s trim');
  await side(desk, '[data-client-show="pj-trim"]');
  check(JSON.stringify(await hiddenRails()) === '[false,false]', 'Wall trim shows it again');
  console.log('\n[computer] each view as it was saved, the furniture switch over it');
  const furn = () => viewer(desk, (v, s) => { const p = s.ws.data.properties[0], t = p.tags.find(x => x.id === 'tag-furniture');
    return JSON.stringify([t.visible !== false, !!(p.hidden || {})['trim:t-base-s'], !!document.querySelector('#side [data-act="furniture"].active')]); });
  const goView = async id => {
    await desk.evaluate(async id => { const v = await import(new URL(`./data/app/${'e2e0c0de'}/js/viewer3d.js`, location.href).href); v.fieldAction('view', id); }, id);
    await desk.waitForTimeout(300);
  };
  await goView('v-b');
  check(await furn() === '[false,true,false]', 'Room B as saved: furniture off, its own piece hidden, the switch off: ' + await furn());
  await side(desk, '[data-act="furniture"]');
  check(await furn() === '[true,false,true]', 'turned on, the switch shows all the furniture, the piece the view hides too: ' + await furn());
  await goView('v-a');
  check(await furn() === '[true,false,true]', 'Room A as saved: furniture on, nothing hidden: ' + await furn());
  await side(desk, '[data-act="furniture"]');
  check(await furn() === '[false,false,false]', 'turned off, the switch hides the furniture: ' + await furn());
  await goView('v-b');
  check(await furn() === '[false,true,false]', 'back to Room B: as it was saved again, not as the last view left it');
  await goView('v-a');
  await side(desk, '[data-quality="medium"]');
  check(await viewer(desk, (v) => v.qualityState().quality) === 'medium', 'the quality switch lowers it');
  // A click selects nothing.
  await desk.mouse.click(800, 450);
  check(await viewer(desk, (v, s) => document.querySelector('.inspector').offsetParent === null), 'a click on the model opens nothing');
  // Walk, then click the floor ahead.
  await side(desk, '[data-act="walk"]');
  await desk.waitForTimeout(400);
  const before = await viewer(desk, (v) => v.cameraState().position);
  const box = await desk.locator('.canvas-wrap canvas').boundingBox();
  await desk.mouse.click(box.x + box.width / 2, box.y + box.height * 0.8);
  await desk.waitForTimeout(1200);
  const stayed = await viewer(desk, (v) => v.cameraState().position);
  check(Math.hypot(stayed[0] - before[0], stayed[2] - before[2]) < 1e-6, 'a single click on the floor goes nowhere');
  await desk.mouse.dblclick(box.x + box.width / 2, box.y + box.height * 0.8);
  await desk.waitForTimeout(2800);
  const after = await viewer(desk, (v) => v.cameraState().position);
  check(Math.hypot(after[0] - before[0], after[2] - before[2]) > 0.3 && Math.abs(after[1] - before[1]) < 1e-6, 'a double-click on the floor goes there at eye height');
  check((await viewer(desk, (v) => v.walkSolidState(v.cameraState().position[0], v.cameraState().position[2]))).clear, 'and ends where a body stands clear of the walls');

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
  const pbox = await phone.locator('.canvas-wrap canvas').boundingBox();
  const p0 = await viewer(phone, (v) => v.cameraState().position);
  const tx = pbox.x + pbox.width / 2, ty = pbox.y + pbox.height * 0.8;
  await phone.touchscreen.tap(tx, ty);
  await phone.waitForTimeout(900);
  const p1 = await viewer(phone, (v) => v.cameraState().position);
  check(Math.hypot(p1[0] - p0[0], p1[2] - p0[2]) < 1e-6, 'a single tap on the floor goes nowhere');
  await phone.touchscreen.tap(tx, ty);
  await phone.touchscreen.tap(tx, ty);
  await phone.waitForTimeout(2800);
  const p2 = await viewer(phone, (v) => v.cameraState().position);
  check(Math.hypot(p2[0] - p0[0], p2[2] - p0[2]) > 0.3, 'a double tap on the floor goes there');

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

  console.log('\n[MODEL] RENDER THIS VIEW files a rendering on its saved view');
  await edit.goto(url + '/#/model');
  await edit.waitForSelector('.v-views [data-view-tab="v-a"]');
  await edit.click('.v-views [data-view-tab="v-a"]', { button: 'right' });
  await edit.click('.v-ctx [data-ctx="view-render"]');
  const rendered = async () => edit.evaluate(async () => { const s = await import('/js/store.js'); return s.ws.data.properties[0].photos.filter(p => p.savedViewId).map(p => ({ id: p.id, view: p.savedViewId, source: p.source, name: p.name, w: p.w, h: p.h })); });
  await edit.waitForFunction(async () => { const s = await import('/js/store.js'); return s.ws.data.properties[0].photos.some(p => p.savedViewId); }, null, { timeout: 90000, polling: 250 }).catch(() => {});
  for (let i = 0; i < 360 && !(await rendered()).length; i++) await edit.waitForTimeout(250);
  const made = await rendered();
  check(made.length === 1 && made[0].view === 'v-a' && made[0].source === 'rendering' && /^Room A · rendering \d{4}-\d{2}-\d{2} \d{4}\.png$/.test(made[0].name) && Math.max(made[0].w, made[0].h) === 2400, 'the rendering is a photo on the view Room A, 2400 pixels on its long side: ' + JSON.stringify(made));
  // A rendering made somewhere else and named for a view goes with that view.
  await edit.evaluate(async () => {
    const s = await import('/js/store.js'), ph = await import('/js/photos-store.js');
    const c = document.createElement('canvas'); c.width = 900; c.height = 600;
    const g = c.getContext('2d'); g.fillStyle = '#7a5a3a'; g.fillRect(0, 0, 900, 600); g.fillStyle = '#fff'; g.font = '60px sans-serif'; g.fillText('outside render', 240, 320);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    await ph.addPhotoFromFile(s.ws.data.properties[0], new File([blob], 'West wall - outside render.png', { type: 'image/png' }), { source: 'rendering' });
    await ph.addPhotoFromFile(s.ws.data.properties[0], new File([blob], 'Loose idea.png', { type: 'image/png' }), { source: 'rendering' });
  });

  console.log('\n[SEND TO THE LAB] the look-over: views and their renderings, each with a switch');
  await edit.evaluate(async () => { const s = await import('/js/store.js'), d = await import('/js/lab-publish-dialog.js'); d.openLabDialog(s.ws.data.properties[0]); });
  await edit.waitForSelector('.lab-dialog .lab-view');
  const rows = () => edit.$$eval('.lab-dialog .lab-view', els => els.map(e => [e.querySelector('.lab-view-head span').textContent.trim(), e.querySelectorAll('.lab-rendering').length, e.querySelector('[data-lab-view]').checked]));
  check(JSON.stringify(await rows()) === JSON.stringify([['Room A', 1, true], ['Room B', 0, true], ['West wall', 1, true], ['Spare', 0, true]]), 'every saved view is listed and ticked, with its renderings under it: ' + JSON.stringify(await rows()));
  check((await edit.locator('.lab-dialog .lab-view').nth(2).locator('.lab-rendering-note').innerText()).includes('by its file name'), 'the rendering named for West wall is on it by its file name');
  check((await edit.locator('.lab-dialog .lab-loose summary').innerText()).startsWith('1 rendering on no saved view'), 'the rendering on no view is listed apart, as not sent');
  check((await edit.locator('[data-lab-summary]').innerText()) === 'Going to the client: 4 of 4 saved views, Existing and 1 project, 2 of 2 renderings on a view.', 'the summary counts what goes: ' + await edit.locator('[data-lab-summary]').innerText());
  await edit.uncheck('.lab-dialog [data-lab-view="v-x"]');
  await edit.locator('.lab-dialog .lab-view').nth(2).locator('[data-lab-rendering]').uncheck();
  check((await edit.locator('[data-lab-summary]').innerText()) === 'Going to the client: 3 of 4 saved views, Existing and 1 project, 1 of 2 renderings on a view.', 'unticking a view and a rendering takes them out: ' + await edit.locator('[data-lab-summary]').innerText());
  const kept = await edit.evaluate(async () => { const s = await import('/js/store.js'); return s.ws.data.properties[0].lab; });
  check(kept.viewsOff.join() === 'v-x' && kept.renderingsOff.length === 1, 'the switches are kept with the property as they are flipped');
  await edit.locator('.lab-dialog .lab-view').nth(2).locator('[data-lab-rendering]').check();
  // The loose rendering is put on a view here, and its name for the client typed.
  await edit.locator('.lab-dialog .lab-loose summary').click();
  await edit.locator('.lab-dialog .lab-loose [data-lab-rendering-view]').selectOption('v-a');
  check(JSON.stringify((await rows())[0]) === JSON.stringify(['Room A', 2, true]) && await edit.$$eval('.lab-dialog .lab-loose', e => e.length) === 0, 'choosing a view for the loose rendering moves it under that view');
  await edit.locator('.lab-dialog .lab-view').nth(0).locator('[data-lab-rendering-label]').nth(1).fill('Walnut option');
  await edit.locator('.lab-dialog .lab-view').nth(0).locator('[data-lab-rendering-label]').nth(1).blur();

  if (process.env.E2E_SHOTS) await edit.locator('.lab-dialog').screenshot({ path: process.env.E2E_SHOTS + '/send-window.png' });
  console.log('\n[SEND TO THE LAB] the send takes the views\' pictures with the client page\'s own code');
  await edit.click('[data-lab-send]');
  await edit.waitForSelector('.lab-pictures iframe', { timeout: 60000 });
  if (process.env.E2E_SHOTS) { await edit.waitForTimeout(2500); await edit.screenshot({ path: process.env.E2E_SHOTS + '/send-pictures.png' }); }
  check(true, 'the client page opens in a small frame in the send window to take the pictures');
  await edit.waitForFunction(() => /^Sent/.test(document.querySelector('[data-lab-status]').textContent), null, { timeout: 240000, polling: 500 });
  const said = await edit.locator('[data-lab-status]').innerText();
  check(said.includes('3 saved views and 3 renderings') && !said.includes('could not'), 'the send says what went: ' + said);
  check(await edit.$$eval('.lab-pictures', e => e.length) === 0, 'the frame is gone when the pictures are taken');
  const parts = await edit.$$eval('.lab-dialog [data-lab-step]', els => els.map(e => [e.dataset.labStep, e.className.replace('lab-step ', ''), e.querySelector('.lab-step-text').textContent]));
  check(JSON.stringify(parts) === JSON.stringify([['code', 'done', '1 of 4 files changed and sent; 3 copied online'], ['files', 'none', 'None to send'], ['renderings', 'done', '3 sent'],
    ['pictures', 'done', '5 pictures of 3 views'], ['property', 'done', 'The page shows this copy now'], ['tidy', 'done', 'Done']]), 'the send window lists each part of the send as done, with what it did: ' + JSON.stringify(parts));
  const cur = JSON.parse(sent.get('synthetic-house/current.json').body.toString());
  const got = JSON.parse(sent.get(`synthetic-house/v/${cur.version}/property.json`).body.toString());
  check(got.property.savedViews.map(v => v.id).join() === 'v-a,v-b,v-w', 'the copy has the three views ticked');
  const vp = got.viewPictures || {};
  check(Object.keys(vp).length === 3 && Object.values(vp).every(x => x.existing), 'every view has its picture under Existing');
  check(!!vp['v-w']['pj-trim'] && !!vp['v-a']['pj-trim'] && !vp['v-b']['pj-trim'], 'the project has a picture of its own where it changes the view (West wall, and the rail at the edge of Room A) and none where it changes next to nothing (Room B): ' + JSON.stringify(vp));
  const jpeg = key => { const f = sent.get(`synthetic-house/v/${cur.version}/${key}`); return !!f && f.type === 'image/jpeg' && f.body.length > 800 && f.body[0] === 0xff && f.body[1] === 0xd8; };
  check(Object.values(vp).every(x => Object.values(x).every(jpeg)), 'each picture was sent as a JPEG');
  check(got.renderings.length === 3 && got.renderings.every(r => jpeg(r.path) && jpeg(r.thumb) && r.w > 0 && r.h > 0) && got.renderings.map(r => r.view).join() === 'v-a,v-a,v-w' && got.renderings[1].label === 'Walnut option' && got.renderings[0].w === 2400, 'the three renderings went as web-size JPEGs with small copies, under their views: ' + JSON.stringify(got.renderings.map(r => [r.id, r.view, r.label, r.w, r.h])));
  const text = JSON.stringify(got);
  check(!['outside render', 'Loose idea', 'Room A · rendering', 'Spare', 'v-x', ...made.map(m => m.id)].some(x => text.includes(x)), 'no photo name, photo id or unticked view is in the copy');

  console.log('\n[SEND TO THE LAB] renderings in: from Finder by their label, chosen from every picture, ticked all at once');
  const plain = await readFile(root + '/test/fixtures/rendering-stamp/plain.png');
  const labelled = Buffer.from(await stamp.stampBytes(plain, { viewName: 'Room B', by: 'image model' }));
  const roomRow = name => edit.locator('.lab-dialog .lab-view').filter({ has: edit.locator('.lab-view-head span', { hasText: new RegExp('^\\s*' + name + '$') }) });
  await edit.setInputFiles('.lab-dialog [data-lab-file]', [{ name: 'idea-17.png', mimeType: 'image/png', buffer: labelled }, { name: 'random.png', mimeType: 'image/png', buffer: plain }]);
  await edit.waitForFunction(() => /^Added 2 renderings/.test(document.querySelector('[data-lab-added]').textContent), null, { timeout: 30000, polling: 200 });
  const added = await edit.locator('[data-lab-added]').innerText();
  check(added.includes('1 on the view its label names') && added.includes('1 on no view yet'), 'two pictures added from Finder: one by its label, one on no view yet: ' + added);
  check(await roomRow('Room B').locator('.lab-rendering').count() === 1 && (await roomRow('Room B').locator('.lab-rendering-note').innerText()).includes('by its label'), 'the labelled one is under Room B, by its label');
  await roomRow('Spare').locator('[data-lab-browse]').click();
  await edit.waitForSelector('.picture-picker[open]');
  await edit.click('.picture-picker [data-pp-tab="all"]');
  await edit.fill('.picture-picker [data-pp-find]', 'random');
  await edit.waitForFunction(() => document.querySelectorAll('.picture-picker .pp-card').length === 1, null, { timeout: 5000, polling: 100 });
  check(await edit.locator('.picture-picker [data-pp-view]').inputValue() === 'v-x', 'the picker opened from Spare puts pictures on Spare');
  await edit.click('.picture-picker .pp-card');
  if (process.env.E2E_SHOTS) { await edit.fill('.picture-picker [data-pp-find]', ''); await edit.waitForTimeout(400); await edit.screenshot({ path: process.env.E2E_SHOTS + '/picture-picker.png' }); }
  await edit.click('.picture-picker [data-pp-put]');
  await edit.waitForFunction(() => !document.querySelector('.picture-picker'), null, { timeout: 5000, polling: 100 });
  check(await roomRow('Spare').locator('.lab-rendering').count() === 1, 'the picture chosen in the picker is now under Spare');
  if (process.env.E2E_SHOTS) await roomRow('Room B').screenshot({ path: process.env.E2E_SHOTS + '/send-view-tools.png' });
  const allBtn = () => edit.locator('.lab-dialog [data-lab-all="renderings"]');
  check((await allBtn().innerText()) === 'UNTICK EVERY RENDERING', 'with every rendering ticked, the button unticks them');
  await allBtn().click();
  check(await edit.$$eval('.lab-dialog .lab-views [data-lab-rendering]', els => els.every(e => !e.checked)) && (await allBtn().innerText()) === 'TICK EVERY RENDERING', 'UNTICK EVERY RENDERING unticks them all, and the button turns back');
  await roomRow('Room B').locator('[data-lab-rendering]').check();
  check(await edit.$$eval('.lab-dialog .lab-views [data-lab-rendering]', els => els.filter(e => e.checked).length) === 1, 'one rendering can still be ticked on its own');
  await allBtn().click();
  check(await edit.$$eval('.lab-dialog .lab-views [data-lab-rendering]', els => els.every(e => e.checked)), 'TICK EVERY RENDERING ticks them all');
  check((await edit.locator('.lab-dialog [data-lab-all="views"]').innerText()) === 'TICK EVERY VIEW', 'with a view unticked, the views button ticks them');

  console.log('\n[client page] the views as pills, the renderings as small pictures, a window that steps through them all');
  const openSent = async (context, at = '/lab/sent/') => {
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(url + at);
    await page.waitForFunction(() => !document.getElementById('client-wait'), null, { timeout: 60000 });
    return page;
  };
  const viewCtx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  // Someone else's note on the first rendering, already in the website's store.
  const firstKey = got.renderings[0].key;
  noteRows.set('/lab/sent/renderings', new Map([['rendering:' + firstKey + ':client@example.invalid', { by: 'client@example.invalid', payload: { id: 'rendering:' + firstKey + ':client@example.invalid', kind: 'tiksi-rendering', rendering: firstKey, view: 'v-a', star: true, comment: 'Our favourite', at: 1 } }]]));
  const view = await openSent(viewCtx);
  const sentViewer = fn => view.evaluate(async src => {
    const v = await import(new URL(`./data/app/${'e2e0c0de'}/js/viewer3d.js`, location.href).href);
    const s = await import(new URL(`./data/app/${'e2e0c0de'}/js/store.js`, location.href).href);
    return (0, eval)(src)(v, s);
  }, fn.toString());
  const pill = () => view.$eval('.v-views .v-view-tab.active', e => e.textContent);
  await view.waitForFunction(() => { const i = [...document.querySelectorAll('.cl-strip .cl-card img')]; return i.length === 3 && i.every(x => x.complete && x.naturalWidth > 0); }, null, { timeout: 30000, polling: 200 });
  check(await view.$$eval('.cl-strip .cl-card .cl-name', e => e.map(x => x.textContent).join()) === 'Room A,Room A,West wall', 'every rendering is a small picture in the strip, in the order of the views');
  check(await view.$$eval('.cl-strip .cl-card.here', e => e.map(x => x.dataset.rendering).join()) === '0,1', 'the ones of the view on screen (Room A) are marked');
  check(await view.$$eval('.cl-strip .cl-iter', e => e.map(x => x.textContent + (x.classList.contains('on') ? '*' : '')).join()) === 'Existing,Wall trim*', 'the strip starts with the iterations, the renovation on');
  const railsShown = () => sentViewer((v, s) => !(s.ws.data.properties[0].hidden || {})['trim:t-rail-w']);
  check(await railsShown() === true, 'and the model shows it');
  const stripBox = await view.locator('.cl-strip').boundingBox(), wrapBox = await view.locator('.v-wrap').boundingBox();
  check(stripBox.y + stripBox.height <= wrapBox.y + wrapBox.height && stripBox.y > wrapBox.y + wrapBox.height / 2 && stripBox.x >= wrapBox.x, 'the strip sits at the bottom of the model');
  check(await view.$$eval('.cl-strip .cl-card .cl-marks', e => e.length) === 0, 'the owner\'s own marks: none yet');
  // The left pane's renderings are small pictures too.
  await view.mouse.move(2, 450);
  await view.waitForFunction(() => document.documentElement.classList.contains('cl-side-open'), null, { timeout: PANE_WAIT, polling: 100 });
  const listed = await view.$$eval('#side .sd-grid [data-client-rendering]', els => els.map(e => [e.textContent.trim(), !!e.querySelector('img')]));
  check(JSON.stringify(listed) === JSON.stringify([['Room A · Rendering 1', true], ['Room A · Walnut option', true], ['West wall · Rendering', true]]), 'the left pane shows the renderings as small pictures under their views: ' + JSON.stringify(listed));
  await side(view, '[data-client-rendering="r2"]');
  await view.waitForSelector('.cl-pop');
  check((await view.locator('.cl-pop-title').innerText()).startsWith('Room A · Walnut option') && await view.locator('.cl-pop-count').innerText() === '2 of 3', 'a click on one opens it over the model, counted among all three');
  await view.keyboard.press('Escape');
  await view.waitForFunction(() => !document.querySelector('.cl-pop'), null, { timeout: 5000, polling: 100 });
  await away(view);

  // The pills go to their views; the strip marks the renderings of the view on screen.
  await view.click('.v-views [data-view-tab="v-b"]');
  await view.waitForTimeout(900);
  check((await sentViewer(v => v.cameraState().position))[0] > 6.5 && await view.$$eval('.cl-strip .cl-card.here', e => e.length) === 0, 'a click on the Room B pill goes there; it has no renderings to mark');
  await view.click('.v-views [data-view-tab="v-w"]');
  await view.waitForTimeout(900);
  const camW = await sentViewer(v => v.cameraState().position);
  check(Math.hypot(camW[0] - 3, camW[2] - 2) < 0.05 && await view.$$eval('.cl-strip .cl-card.here', e => e.map(x => x.dataset.rendering).join()) === '2', 'West wall goes there and marks its rendering');
  await view.click('.cl-strip [data-state="existing"]');
  check(await railsShown() === false && (await sentViewer(v => v.cameraState().position)).every((x, i) => Math.abs(x - camW[i]) < 1e-6), 'Existing in the strip changes the model, the camera staying put');
  check(await view.$eval('#side [data-client-show="existing"]', b => b.classList.contains('active')), 'the left pane marks it too');
  await view.click('.cl-strip [data-state="pj-trim"]');
  check(await railsShown() === true, 'and Wall trim brings the trim back');

  // A rendering opens over the model, and the model goes to its view.
  await view.click('.cl-strip [data-rendering="1"]');
  await view.waitForFunction(() => { const i = document.querySelector('.cl-pop-body img'); return i && i.complete && i.naturalWidth === 900; }, null, { timeout: 20000, polling: 200 });
  await view.waitForTimeout(900);
  check((await view.locator('.cl-pop .cl-pop-title').innerText()).startsWith('Room A · Walnut option') && await view.locator('.cl-pop .cl-pop-count').innerText() === '2 of 3', 'a click on a rendering opens the picture, named for the view and the rendering');
  check(await pill() === 'Room A', 'the model goes to the rendering\'s view (Room A)');
  const camA = await sentViewer(v => v.cameraState().position);
  const pop0 = await view.locator('.cl-pop').boundingBox();
  check(pop0.x >= wrapBox.x && pop0.x + pop0.width <= wrapBox.x + wrapBox.width, 'the window opens over the model');
  check(pop0.width < 1400 * 0.7 && pop0.height < 900 * 0.8 && await view.evaluate(() => document.querySelector('.cl-pop').tagName === 'DIV' && !document.querySelector('dialog[open]')), 'the window floats: it does not cover the page or stop it');
  const beside = pop0.x + pop0.width + 40;
  await view.mouse.move(beside, pop0.y + 200); await view.mouse.down(); await view.mouse.move(beside + 100, pop0.y + 230, { steps: 6 }); await view.mouse.up();
  await view.waitForTimeout(300);
  check((await sentViewer(v => v.cameraState().position)).some((x, i) => Math.abs(x - camA[i]) > 0.01), 'the model still orbits beside the open window');
  await view.mouse.move(pop0.x + 120, pop0.y + 20); await view.mouse.down(); await view.mouse.move(pop0.x + 40, pop0.y + 90, { steps: 5 }); await view.mouse.up();
  const pop1 = await view.locator('.cl-pop').boundingBox();
  check(Math.abs(pop1.x - (pop0.x - 80)) < 2 && Math.abs(pop1.y - (pop0.y + 70)) < 2, 'the window moves with its bar');
  // The arrows step through every rendering, of every view, and the model follows.
  await view.click('.cl-pop [data-pop="next"]');
  await view.waitForTimeout(700);
  check(await view.locator('.cl-pop .cl-pop-count').innerText() === '3 of 3' && (await view.locator('.cl-pop .cl-pop-title').innerText()).startsWith('West wall') && await pill() === 'West wall', 'the next one is West wall\'s, and the model goes there');
  await view.locator('.cl-pop').focus();
  await view.keyboard.press('ArrowRight');
  await view.waitForTimeout(700);
  check(await view.locator('.cl-pop .cl-pop-count').innerText() === '1 of 3' && await pill() === 'Room A', 'the right arrow key goes round to the first, and the model back to Room A');
  await view.click('.v-views [data-view-tab="v-w"]');
  await view.waitForTimeout(500);
  check(await view.locator('.cl-pop .cl-pop-count').innerText() === '3 of 3', 'going to West wall with the window open shows West wall\'s rendering');
  await view.click('.cl-pop [data-pop="prev"]');
  await view.click('.cl-pop [data-pop="prev"]');
  await view.waitForFunction(() => { const i = document.querySelector('.cl-pop-body img'); return i.complete && i.naturalWidth === 2400; }, null, { timeout: 20000, polling: 200 });
  check(await view.locator('.cl-pop .cl-pop-count').innerText() === '1 of 3', 'and the arrows step back across views');

  // The star and the comment, kept in the website's note store; someone else's shows to the owner.
  check((await view.locator('.cl-pop-others').innerText()).includes('client@example.invalid') && (await view.locator('.cl-pop-others').innerText()).includes('Our favourite'), 'the owner sees what someone else said about this rendering');
  await view.click('.cl-pop [data-pop="star"]');
  await view.waitForFunction(() => document.querySelector('.cl-pop [data-pop="star"]').getAttribute('aria-pressed') === 'true', null, { timeout: 3000, polling: 50 });
  await view.locator('.cl-pop textarea').fill('Warmer light here');
  await view.waitForFunction(() => document.querySelector('.cl-pop-saved').textContent.includes('on the website'), null, { timeout: 5000, polling: 100 });
  await view.waitForTimeout(1200);
  const stored = [...noteRows.get('/lab/sent/renderings').values()];
  const mine = stored.filter(r => r.by === OWNER);
  check(mine.length === 1 && mine[0].payload.rendering === firstKey && mine[0].payload.star === true && mine[0].payload.comment === 'Warmer light here' && mine[0].payload.view === 'v-a', 'the star and the comment went to the website\'s store: ' + JSON.stringify(mine.map(r => r.payload)));
  check(stored.some(r => r.by === 'client@example.invalid' && r.payload.comment === 'Our favourite'), 'and the other person\'s note on the same rendering is still there');
  check(await view.$$eval('.cl-strip [data-rendering="0"] .cl-mark', e => e.map(x => x.classList[1]).join()) === 'star,note', 'the strip marks the rendering starred and commented');
  // SEE THROUGH: the picture lies over the whole model, half clear, under the pills and the strip.
  await view.click('.cl-pop [data-pop="see"]');
  await view.waitForTimeout(900);
  const see = await view.evaluate(() => {
    const pop = document.querySelector('.cl-pop'), img = pop.querySelector('.cl-pop-body img'), wrap = document.querySelector('.v-wrap');
    const p = pop.getBoundingClientRect(), w = wrap.getBoundingClientRect(), i = img.getBoundingClientRect();
    const tab = document.querySelector('.v-views .v-view-tab').getBoundingClientRect(), card = document.querySelector('.cl-strip .cl-card').getBoundingClientRect();
    const at = r => document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { inWrap: pop.parentElement === wrap, cover: Math.abs(p.left - w.left) < 1 && Math.abs(p.width - w.width) < 1 && Math.abs(p.height - w.height) < 1,
      tall: Math.abs(i.height - w.height) < 1, centred: Math.abs((i.left + i.width / 2) - (w.left + w.width / 2)) < 1, clear: getComputedStyle(img).opacity,
      tabOnTop: at(tab).classList.contains('v-view-tab'), cardOnTop: !!at(card).closest('.cl-card') };
  });
  check(see.inWrap && see.cover && see.tall && see.centred && see.clear === '0.5', 'SEE THROUGH lays the picture over the model, half clear, as tall as the model and centred, so it lines up with the view: ' + JSON.stringify(see));
  check(see.tabOnTop && see.cardOnTop, 'the pills and the strip stay above it and in reach');
  check(Math.hypot(...(await sentViewer(v => v.cameraState().position)).map((x, i) => x - camA[i])) < 0.05, 'and the camera went back to the view the rendering was made from');
  await view.click('.cl-pop [data-pop="see"]');
  const pop2 = await view.locator('.cl-pop').boundingBox();
  check(await view.evaluate(() => document.querySelector('.cl-pop').parentElement === document.body) && Math.abs(pop2.width - pop1.width) < 2, 'turned off, the window is back as it was');
  if (process.env.E2E_SHOTS) await view.screenshot({ path: process.env.E2E_SHOTS + '/client-desktop.png' });
  await view.locator('.cl-pop').focus();
  await view.keyboard.press('Escape');
  check(await view.$$eval('.cl-pop', e => e.length) === 0, 'Esc closes it');
  // Another browser (no notes of its own) reads them back from the website.
  const again = await openSent(await browser.newContext({ viewport: { width: 1400, height: 900 } }));
  await again.waitForFunction(() => document.querySelectorAll('.cl-strip [data-rendering="0"] .cl-mark').length === 2, null, { timeout: 10000, polling: 100 });
  await again.click('.cl-strip [data-rendering="0"]');
  await again.waitForSelector('.cl-pop textarea');
  check(await again.$eval('.cl-pop [data-pop="star"]', b => b.getAttribute('aria-pressed')) === 'true' && await again.$eval('.cl-pop textarea', t => t.value) === 'Warmer light here', 'another browser gets the star and the comment back from the website');

  console.log('\n[client page on a phone] the pills, the strip, the rendering fitted to the screen');
  const small = await openSent(await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }), '/lab-preview/synthetic-house/');
  await small.waitForSelector('.cl-strip .cl-card img');
  const sb = await small.locator('.cl-strip').boundingBox();
  check(sb.x >= 0 && sb.x + sb.width <= 390 && sb.y + sb.height <= 844 && sb.y > 600, 'the strip fits the bottom of the phone screen');
  const tb = await small.locator('.v-views').boundingBox();
  check(tb.y < 80 && tb.x > 40 && tb.x + tb.width <= 390, 'the pills run along the top, beside the menu button');
  await small.tap('.cl-strip [data-rendering="0"]');
  await small.waitForSelector('.cl-pop img');
  if (process.env.E2E_SHOTS) await small.screenshot({ path: process.env.E2E_SHOTS + '/client-phone.png' });
  const pb = await small.locator('.cl-pop').boundingBox();
  check(pb.x >= 0 && pb.x + pb.width <= 390 && pb.y >= 0 && pb.y + pb.height <= 844, 'the rendering\'s window fits the phone screen');
  await small.tap('.cl-pop [data-pop="star"]');
  check((await small.locator('.cl-pop-saved').innerText()) === 'Kept in this browser only.', 'away from the website, the star is kept in this browser and says so');
  await small.tap('.cl-pop [data-pop="close"]');
  check(await small.$$eval('.cl-pop', e => e.length) === 0, 'and closes with its button');

  // E2E_KEEP_SENT=<folder> keeps the synthetic copy as sent, laid out as the Mac's preview copy
  // (<folder>/<page name>/data/...), so a branch preview can show it at /lab-preview/synthetic-house/.
  if (process.env.E2E_KEEP_SENT) {
    const { mkdir, writeFile } = await import('node:fs/promises');
    for (const [key, f] of sent) {
      const [slug, ...rest] = key.split('/');
      const file = resolve(process.env.E2E_KEEP_SENT, slug, 'data', ...rest);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, f.body);
    }
  }

  check(!errors.length, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  console.log('\nAll client lab checks passed.');
} finally {
  await browser.close();
  server.close();
}
