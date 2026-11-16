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
// a picture of every view per project, and the page it sent shows the views as small pictures
// that open their projects and renderings, a rendering in a window floating over the model.
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
    { id: 'v-b', name: 'Room B', camera: { position: [7, 1.6, 2], target: [4.5, 1.2, 2], fov: 50 }, mode: 'orbit', tags: {}, section: { on: false, height: 1.2 }, xray: false, hiddenLevels: [] },
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
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(req.url.split('?')[0]);
  const send = (body, type) => { res.setHeader('Content-Type', type); res.end(body); };
  const json = v => send(JSON.stringify(v), 'application/json');
  if (path === '/api/lab/capabilities') return json({ token: 'check', upload: false, site: 'https://lab.invalid/', preview: '/lab-preview/', reason: 'This check has no upload key: sends go to the preview copy only.' });
  if (path.startsWith('/api/lab/app/')) return json({ app: CODE, sent: 0 });
  if (path.startsWith('/api/lab/prune/')) return json({ removed: 0 });
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
  // A copy sent without pictures of its views (this one was not sent through the lab sender)
  // shows them by name in the strip, and offers every project under each.
  check(await desk.$eval('.v-views', e => getComputedStyle(e).display) === 'none', 'the name tabs give way to the strip of views');
  check(await desk.$$eval('.cl-strip .cl-thumb', b => b.map(x => x.querySelector('.cl-name').textContent).join()) === 'Room A,Room B,West wall,Spare' && await desk.$$eval('.cl-strip img', i => i.length) === 0, 'a copy without pictures lists its views by name in the strip');
  check(await desk.$eval('.cl-strip .cl-view.on .cl-name', e => e.textContent) === 'Room A', 'the view the page opened at is marked');
  await desk.click('.cl-strip [data-go="v-b"]');
  check(await desk.$$eval('.cl-strip .cl-view.open .cl-iter .cl-name', e => e.map(x => x.textContent).join()) === 'Existing,Wall trim', 'and a click opens Existing and the project under it');
  await desk.click('.cl-strip [data-go="v-b"]');
  check(await desk.$$eval('.cl-strip .cl-more', e => e.length) === 0, 'a second click closes them');
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

  console.log('\n[client page] the views as small pictures; a click opens projects and renderings');
  const openSent = async context => {
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(url + '/lab-preview/synthetic-house/');
    await page.waitForFunction(() => !document.getElementById('client-wait'), null, { timeout: 60000 });
    return page;
  };
  const view = await openSent(await browser.newContext({ viewport: { width: 1400, height: 900 } }));
  const sentViewer = fn => view.evaluate(async src => {
    const v = await import(new URL(`./data/app/${'e2e0c0de'}/js/viewer3d.js`, location.href).href);
    const s = await import(new URL(`./data/app/${'e2e0c0de'}/js/store.js`, location.href).href);
    return (0, eval)(src)(v, s);
  }, fn.toString());
  await view.waitForFunction(() => [...document.querySelectorAll('.cl-strip .cl-thumb img')].length === 3 && [...document.querySelectorAll('.cl-strip .cl-thumb img')].every(i => i.complete && i.naturalWidth === 480), null, { timeout: 30000, polling: 200 });
  check(true, 'each of the three views is a small picture, 480 pixels wide as sent');
  check(await view.$$eval('.cl-strip .cl-count', e => e.map(x => x.closest('[data-view]').dataset.view + ':' + x.textContent).join()) === 'v-a:4,v-w:3', 'a view says how much it opens: Room A two iterations and two renderings, West wall two iterations and a rendering; Room B nothing');
  const stripBox = await view.locator('.cl-strip').boundingBox(), wrapBox = await view.locator('.v-wrap').boundingBox();
  check(stripBox.y + stripBox.height <= wrapBox.y + wrapBox.height && stripBox.y > wrapBox.y + wrapBox.height / 2 && stripBox.x >= wrapBox.x, 'the strip sits at the bottom of the model');
  await view.click('.cl-strip [data-go="v-b"]');
  await view.waitForTimeout(900);
  check(await view.$$eval('.cl-strip .cl-more', e => e.length) === 0 && (await sentViewer(v => v.cameraState().position))[0] > 6.5, 'a click on Room B goes there and opens nothing, as it has nothing more');
  await view.click('.cl-strip [data-go="v-w"]');
  await view.waitForTimeout(900);
  const camW = await sentViewer(v => v.cameraState().position);
  check(Math.hypot(camW[0] - 3, camW[2] - 2) < 0.05, 'a click on West wall goes to that view');
  check(await view.$$eval('.cl-strip .cl-view.open .cl-card', e => e.map(x => x.querySelector('.cl-kind').textContent + ' ' + x.querySelector('.cl-name').textContent).join(' | ')).then(t => /^MODEL Existing \| MODEL Wall trim \| RENDERING Rendering · \S.*\d{4}$/.test(t)), 'and opens its two iterations and its rendering beside it: ' + await view.$$eval('.cl-strip .cl-view.open .cl-card', e => e.map(x => x.querySelector('.cl-name').textContent).join(' | ')));
  const railsShown = () => sentViewer((v, s) => !(s.ws.data.properties[0].hidden || {})['trim:t-rail-w']);
  check(await railsShown() === false, 'the model shows Existing');
  const thumbBefore = await view.$eval('.cl-strip [data-go="v-w"] img', i => i.src);
  await view.click('.cl-strip .cl-view.open [data-state="pj-trim"]');
  check(await railsShown() === true && (await sentViewer(v => v.cameraState().position)).every((x, i) => Math.abs(x - camW[i]) < 1e-6), 'a click on the Wall trim iteration changes the model, the camera staying put');
  check(await view.$eval('#side [data-client-show="pj-trim"]', b => b.classList.contains('active')) && await view.$eval('.cl-strip [data-state="pj-trim"]', b => b.classList.contains('on')), 'the left pane and the card both mark it');
  check(await view.$eval('.cl-strip [data-go="v-w"] img', i => i.src) !== thumbBefore, 'the view\'s own picture follows the iteration shown');
  await view.click('#side [data-client-show="existing"]');
  check(await view.$eval('.cl-strip [data-state="existing"]', b => b.classList.contains('on')), 'changing it in the left pane marks the card too');

  await view.click('.cl-strip [data-go="v-a"]');
  await view.waitForTimeout(900);
  check(await view.$$eval('.cl-strip .cl-view.open .cl-card .cl-name', e => e.map(x => x.textContent).join(' | ')).then(t => /^Existing \| Wall trim \| Rendering · .+ \| Walnut option · /.test(t)), 'Room A opens its two iterations and its two renderings, the second rendering under the name typed for the client');
  const camA = await sentViewer(v => v.cameraState().position);
  await view.click('.cl-strip .cl-view.open [data-rendering="1"]');
  await view.waitForFunction(() => { const i = document.querySelector('.cl-pop img'); return i && i.complete && i.naturalWidth === 900; }, null, { timeout: 20000, polling: 200 });
  check((await view.locator('.cl-pop .cl-pop-title').innerText()).startsWith('Room A · Walnut option') && await view.locator('.cl-pop .cl-pop-count').innerText() === '2 of 2', 'a click on a rendering opens the picture in a window named for the view and the rendering');
  const pop0 = await view.locator('.cl-pop').boundingBox();
  check(pop0.x >= wrapBox.x && pop0.x + pop0.width <= wrapBox.x + wrapBox.width, 'the window opens over the model, clear of the left pane');
  check(pop0.width < 1400 * 0.7 && pop0.height < 900 * 0.8 && await view.evaluate(() => document.querySelector('.cl-pop').tagName === 'DIV' && !document.querySelector('dialog[open]')), 'the window floats: it does not cover the page or stop it');
  // The model stays in use behind it: a drag on the model beside the window orbits.
  const beside = pop0.x + pop0.width + 40;
  await view.mouse.move(beside, pop0.y + 200); await view.mouse.down(); await view.mouse.move(beside + 100, pop0.y + 230, { steps: 6 }); await view.mouse.up();
  await view.waitForTimeout(300);
  check((await sentViewer(v => v.cameraState().position)).some((x, i) => Math.abs(x - camA[i]) > 0.01), 'the model still orbits beside the open window');
  // Dragged by its bar.
  await view.mouse.move(pop0.x + 120, pop0.y + 20); await view.mouse.down(); await view.mouse.move(pop0.x + 40, pop0.y + 90, { steps: 5 }); await view.mouse.up();
  const pop1 = await view.locator('.cl-pop').boundingBox();
  check(Math.abs(pop1.x - (pop0.x - 80)) < 2 && Math.abs(pop1.y - (pop0.y + 70)) < 2, 'the window moves with its bar');
  await view.click('.cl-pop [data-pop="prev"]');
  await view.waitForFunction(() => { const i = document.querySelector('.cl-pop img'); return i.complete && i.naturalWidth === 2400; }, null, { timeout: 20000, polling: 200 });
  check(await view.locator('.cl-pop .cl-pop-count').innerText() === '1 of 2', 'the arrows step through the view\'s renderings');
  if (process.env.E2E_SHOTS) await view.screenshot({ path: process.env.E2E_SHOTS + '/client-desktop.png' });
  await view.locator('.cl-pop').focus();
  await view.keyboard.press('Escape');
  check(await view.$$eval('.cl-pop', e => e.length) === 0, 'Esc closes it');
  if (process.env.E2E_SHOTS) await view.screenshot({ path: process.env.E2E_SHOTS + '/client-desktop-strip.png' });
  // The eye beside SAVED VIEWS in the left pane puts the strip away.
  await view.click('#side [data-screen="model.views"]').catch(() => {});

  console.log('\n[client page on a phone] the strip under the model, the rendering fitted to the screen');
  const small = await openSent(await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }));
  await small.waitForSelector('.cl-strip .cl-thumb img');
  const sb = await small.locator('.cl-strip').boundingBox();
  check(sb.x >= 0 && sb.x + sb.width <= 390 && sb.y + sb.height <= 844 && sb.y > 600, 'the strip fits the bottom of the phone screen');
  await small.tap('.cl-strip [data-go="v-a"]');
  await small.waitForTimeout(700);
  await small.tap('.cl-strip .cl-view.open [data-rendering="0"]');
  await small.waitForSelector('.cl-pop img');
  if (process.env.E2E_SHOTS) await small.screenshot({ path: process.env.E2E_SHOTS + '/client-phone.png' });
  const pb = await small.locator('.cl-pop').boundingBox();
  check(pb.x >= 0 && pb.x + pb.width <= 390 && pb.y >= 0 && pb.y + pb.height <= 844, 'the rendering\'s window fits the phone screen');
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
