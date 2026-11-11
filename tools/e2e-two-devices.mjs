// Two devices side by side on the Mac's project files: what one of them does must reach the
// other without moving what the other is looking at, without rebuilding the page under a
// cursor, and without losing what either of them saved.
// Each "device" is its own browser context (its own storage). One private server on a free
// port; every project is synthetic and lives in a temporary folder.
// E2E_STEP=<part name>[,<part name>] runs only those parts.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import net from 'node:net';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { chromium } from 'playwright';

const state = await mkdtemp(tmpdir() + '/tiksi-two-devices-');
const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r));
const port = socket.address().port; await new Promise(r => socket.close(r));
const child = spawn('python3', ['tools/serve.py', '--port', String(port), '--state-dir', state, '--projects-dir', state + '/projects'], { stdio: ['ignore', 'pipe', 'pipe'] });
// Read the server's output: an unread pipe fills and then every server thread stops at its next log line.
// How many times the Mac was asked for each stored original, counted from its request log.
const asked = new Map();
let serverLog = ''; child.stdout.resume(); child.stderr.on('data', d => {
  serverLog = (serverLog + d).slice(-8000);
  for (const m of String(d).matchAll(/"GET \/api\/workspace\/blobs\/([0-9a-f]{64})/g)) asked.set(m[1], (asked.get(m[1]) || 0) + 1);
});
const url = 'http://127.0.0.1:' + port;
const SAVED = () => document.querySelector('#save-status').textContent === 'SAVED TO DISK';
const errors = [];
let browser, lastStep = 'start';
const step = text => { lastStep = text; if (process.env.E2E_TRACE) console.log('  .. ' + text); };

// The Mac's own copy, read the way another device would read it.
async function mac() {
  const auth = { 'X-Tiksi-Workspace': '1' };
  auth['X-Tiksi-Token'] = (await (await fetch(url + '/api/workspace/capabilities', { headers: auth })).json()).token;
  return (await fetch(url + '/api/workspace', { headers: auth })).json();
}
async function untilOnTheMac(check, what, ms = 20000) {
  for (const end = Date.now() + ms; ;) {
    const copy = await mac();
    if (check(copy)) return copy;
    if (Date.now() > end) assert.fail(what + ' did not reach the Mac within ' + ms / 1000 + ' s');
    await new Promise(r => setTimeout(r, 150));
  }
}
const prop = (copy, id) => copy.data.properties.find(p => p.id === id);
// Wait until a check that needs `await` inside the page comes true. (waitForFunction takes
// the promise an async check returns as "true" at once, so it cannot be used for these.)
async function until(page, check, arg, what = 'what the check waits for', ms = 20000) {
  for (const end = Date.now() + ms; ;) {
    if (await page.evaluate(check, arg)) return;
    if (Date.now() > end) assert.fail(what + ' did not happen within ' + ms / 1000 + ' s');
    await new Promise(r => setTimeout(r, 150));
  }
}
async function device({ hash = '#/plan', ready = SAVED, before, viewport = { width: 1280, height: 900 }, context } = {}) {
  context = context || await browser.newContext({ viewport });
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  if (before) await before(page);
  await page.goto(url + '/' + hash);
  if (ready) await page.waitForFunction(ready, null, { timeout: 60000 });
  return page;
}
// Two synthetic properties, each with two levels, a room and a tag; the first is the one open.
async function makeProperties(tag) {
  const page = await device({ hash: '' });
  const ids = await page.evaluate(async tag => {
    const store = await import('/js/store.js');
    const make = name => {
      const p = store.propertyTemplate(name); p.id = 'prop-' + tag + '-' + name.toLowerCase().replace(/\W+/g, '-');
      p.levels.push({ ...p.levels[0], id: 'lvl-upper', name: 'Upper level', elevation: 3 });
      const wall = (id, ax, ay, bx, by) => ({ id, level: p.levels[0].id, ax, ay, bx, by, thickness: 0.114, height: null, material: 'mat-drywall' });
      p.walls.push(wall('w-s', 0, 0, 5, 0), wall('w-e', 5, 0, 5, 3.5), wall('w-n', 5, 3.5, 0, 3.5), wall('w-w', 0, 3.5, 0, 0));
      p.rooms.push({ id: 'room-1', level: p.levels[0].id, name: 'Room', pts: [[0, 0], [5, 0], [5, 3.5], [0, 3.5]], material: 'mat-oak', ceilingMaterial: null });
      p.tags = [{ id: 'tag-existing', name: 'Existing', color: '#8b9aa7' }];
      // Its one-pager is written by hand, so opening a page does not rewrite the draft.
      p.onePager.customized = true;
      return p;
    };
    const a = make('Harbour house'), b = make('Garden flat');
    store.ws.data.properties.push(a, b); store.ws.data.settings.activePropertyId = a.id; store.touch();
    await (await import('/js/disk-workspace.js')).diskWorkspace.sync();
    return [a.id, b.id];
  }, tag);
  await page.context().close();
  return ids;
}
const open = page => page.evaluate(async () => {
  const s = await import('/js/store.js'), p = s.activeProperty();
  return { property: p.id, level: p.activeLevelId, tagOn: p.tags[0]?.visible !== false, selected: document.querySelector('#property-select').value };
});
// A device that has not opened this workspace before starts on the property the Mac's copy
// names. Each device then chooses for itself, as a person would in the property list.
async function look(page, id) {
  // (Through the property list itself; the phone layout drives the same list from its panel.
  // The list is filled, and listens, a moment after the page first reads SAVED TO DISK.)
  await until(page, async id => {
    const list = document.querySelector('#property-select');
    if (list.onchange && list.value !== id && [...list.options].some(o => o.value === id)) { list.value = id; list.dispatchEvent(new Event('change')); }
    return (await import('/js/store.js')).activeProperty()?.id === id && list.value === id;
  }, id, 'opening the property', 30000);
}
const edit = (page, id, change) => page.evaluate(async ([id, change]) => {
  const store = await import('/js/store.js');
  Object.assign(store.ws.data.properties.find(p => p.id === id), change); store.touch();
}, [id, change]);
const saveNow = page => page.evaluate(async () => (await import('/js/disk-workspace.js')).diskWorkspace.sync());
const has = (page, id, check) => until(page, async ([id, check]) => {
  const p = (await import('/js/store.js')).ws.data.properties.find(p => p.id === id);
  return !!p && new Function('p', 'return ' + check)(p);
}, [id, check], 'the other device\'s change (' + check + ')');

// Which property is open, which level and which tags are on belong to each device.
async function eachDeviceKeepsItsOwnView() {
  step('view');
  const [first, second] = await makeProperties('view');
  const one = await device(), two = await device();
  await look(one, first); await look(two, first);
  const saves = []; for (const page of [one, two]) page.on('request', r => { if (r.method() === 'PUT' && new URL(r.url()).pathname === '/api/workspace') saves.push(page === one ? 'one' : 'two'); });
  assert.equal((await open(two)).property, first);
  // Device one looks at the other property, its upper level, and switches a tag off.
  await one.selectOption('#property-select', second);
  await one.evaluate(async () => { const s = await import('/js/store.js'), p = s.activeProperty(); p.activeLevelId = 'lvl-upper'; p.tags[0].visible = false; s.touch(); });
  await one.waitForFunction(SAVED);
  await one.waitForTimeout(6000);   // two of the other device's looks at the Mac
  assert.deepEqual(await open(one), { property: second, level: 'lvl-upper', tagOn: false, selected: second });
  assert.equal((await open(two)).property, first, 'the second device still has its own property open');
  assert.deepEqual(saves, [], 'a change of view is not a save');
  assert.equal((await mac()).data.settings.activePropertyId, first, 'what a device looks at is not written to the Mac');
  // A real edit on device two reaches device one and leaves its view where it was.
  await edit(two, second, { notes: 'Edited on device two' }); await saveNow(two);
  await has(one, second, 'p.notes === "Edited on device two"');
  assert.deepEqual(await open(one), { property: second, level: 'lvl-upper', tagOn: false, selected: second }, 'another device\'s save does not move this device\'s view');
  const saved = prop(await mac(), second);
  assert.equal(saved.activeLevelId, 'lvl-0'); assert.notEqual(saved.tags[0].visible, false, 'the level and tags one device looks at are not saved over the Mac\'s');
  // Both devices change what they look at before either hears from the Mac, then both edit:
  // looking at different things is not a conflict.
  await two.selectOption('#property-select', second);
  await two.evaluate(async () => { const s = await import('/js/store.js'); s.activeProperty().activeLevelId = 'lvl-upper'; s.touch(); });
  await one.evaluate(async () => { const s = await import('/js/store.js'); s.activeProperty().activeLevelId = 'lvl-0'; s.touch(); });
  await edit(one, first, { notes: 'From device one' }); await edit(two, second, { notes: 'From device two' });
  await untilOnTheMac(copy => prop(copy, first).notes === 'From device one' && prop(copy, second).notes === 'From device two', 'Both devices\' edits');
  for (const page of [one, two]) assert.equal(await page.locator('dialog[open]').count(), 0, 'no "copies differ" question over a choice of view');
  // The device's view is still its own after the page is opened again.
  await one.reload(); await one.waitForFunction(SAVED);
  assert.deepEqual(await open(one), { property: second, level: 'lvl-0', tagOn: false, selected: second }, 'a device opens on what it was looking at');
  await one.context().close(); await two.context().close();
}

// A save elsewhere must not rebuild the page under someone who is typing, and must not
// rebuild it at all when what it shows did not change.
async function aSaveElsewhereLeavesThePageAlone() {
  step('typing');
  const [first, second] = await makeProperties('typing');
  const one = await device(), two = await device();
  await look(one, first); await look(two, first);
  // Mark the page device two has open: a rebuilt page is a new one without the mark.
  const mark = () => two.evaluate(() => { document.querySelector('#view').firstElementChild.dataset.kept = 'yes'; });
  const marked = () => two.evaluate(() => document.querySelector('#view').firstElementChild?.dataset.kept === 'yes');
  await two.locator('[data-prop-name]').waitFor();
  await mark();
  // 1. A change to another property: nothing on this page shows it.
  await edit(one, second, { notes: 'A change to the property that is not open on device two' }); await saveNow(one);
  await has(two, second, 'p.notes.startsWith("A change to the property that is not open")');
  await two.waitForTimeout(300);
  assert.equal(await marked(), true, 'a change to another property does not rebuild the open page');
  // 2. A change to the open property while its name is being typed: the page waits.
  await two.locator('[data-prop-name]').click();
  await two.locator('[data-prop-name]').fill('Harbour house, being renam');
  await edit(one, first, { notes: 'Saved on device one while device two was typing' }); await saveNow(one);
  await has(two, first, 'p.notes.startsWith("Saved on device one while")');
  await two.waitForTimeout(500);
  assert.equal(await marked(), true, 'the page is not rebuilt under a text field that has the cursor');
  assert.equal(await two.locator('[data-prop-name]').inputValue(), 'Harbour house, being renam', 'what was being typed is still there');
  await two.keyboard.type('ed');
  await two.locator('[data-prop-name]').blur();
  // Leaving the field saves the name, and now the page shows the other device's change too.
  const copy = await untilOnTheMac(c => prop(c, first).name === 'Harbour house, being renamed', 'The name typed during another device\'s save');
  assert.equal(prop(copy, first).notes, 'Saved on device one while device two was typing', 'and the other device\'s change is kept beside it');
  await two.waitForFunction(() => document.querySelector('#view').firstElementChild?.dataset.kept !== 'yes', null, { timeout: 10000 });
  assert.equal(await two.locator('[data-prop-name]').inputValue(), 'Harbour house, being renamed');
  await one.context().close(); await two.context().close();
}

// A slow action takes the property, waits, and writes its result into what it took. Another
// device saves in between. The result must land in the live record and be saved.
async function aSlowActionWritesIntoTheLiveRecord() {
  step('slow');
  const [first] = await makeProperties('slow');
  const one = await device(), two = await device();
  await look(one, first); await look(two, first);
  await two.evaluate(async () => { window.takenBefore = (await import('/js/store.js')).activeProperty(); });
  await edit(one, first, { notes: 'Saved elsewhere while the slow action ran' }); await saveNow(one);
  await has(two, first, 'p.notes.startsWith("Saved elsewhere while")');
  await two.evaluate(async () => { const s = await import('/js/store.js'); window.takenBefore.address = 'Written by the slow action'; s.touch(); });
  const copy = await untilOnTheMac(c => prop(c, first).address === 'Written by the slow action', 'What a slow action wrote into the record it took before another device saved');
  assert.equal(prop(copy, first).notes, 'Saved elsewhere while the slow action ran');
  await one.context().close(); await two.context().close();
}

// MODEL on one device while the other edits the same building: the walls are redrawn, the
// camera stays where it was put.
async function modelKeepsItsCamera() {
  step('model');
  const [first] = await makeProperties('model');
  const one = await device(), two = await device();
  await look(one, first); await look(two, first);
  await two.evaluate(() => { location.hash = '#/model'; });
  const idle = () => until(two, async () => !!document.querySelector('#view canvas') && (await import('/js/viewer3d.js')).viewerIdle() && document.querySelector('#save-status').textContent === 'SAVED TO DISK', null, 'MODEL settling', 240000);
  await idle();
  const camera = () => two.evaluate(async () => (await import('/js/viewer3d.js')).drawStats().camera.inverse.map(v => Math.round(v * 100) / 100 || 0));
  const overview = await camera();
  // Put the camera somewhere else: whichever of the two preset views it is not on already.
  let placed = overview;
  for (const preset of ['iso', 'front']) {
    if (JSON.stringify(placed) !== JSON.stringify(overview)) break;
    await two.evaluate(async preset => { (await import('/js/viewer3d.js')).fieldAction('camera', preset); }, preset);
    await two.waitForTimeout(1500); await idle();
    placed = await camera();
  }
  assert.notDeepEqual(placed, overview, 'the camera was moved off the overview');
  // Mark the page: a rebuilt page is a new one without the mark (MODEL reuses its canvas, so the mark goes on the page around it).
  await two.evaluate(() => { document.querySelector('#view').firstElementChild.dataset.kept = 'yes'; });
  // The other device moves a wall of the same building.
  await one.evaluate(async id => { const s = await import('/js/store.js'); const p = s.ws.data.properties.find(p => p.id === id); p.walls.find(w => w.id === 'w-e').ax = 6; p.walls.find(w => w.id === 'w-e').bx = 6; s.touch(); }, first);
  await saveNow(one);
  await has(two, first, 'p.walls.find(w => w.id === "w-e").ax === 6');
  await two.waitForTimeout(1500); await idle();
  assert.deepEqual(await camera(), placed, 'another device\'s edit leaves the camera where it was');
  assert.equal(await two.evaluate(() => document.querySelector('#view').firstElementChild?.dataset.kept), 'yes', 'and the page is the same one, not rebuilt from nothing');
  // A change MODEL cannot redraw in place (a photo arrives) rebuilds the page, still without moving the camera.
  await one.evaluate(async id => { const s = await import('/js/store.js'); s.ws.data.properties.find(p => p.id === id).photos.push({ id: 'photo-added', name: 'Added elsewhere', thumb: '', notes: '', kind: 'photo' }); s.touch(); }, first);
  await saveNow(one);
  await has(two, first, 'p.photos.some(ph => ph.id === "photo-added")');
  await two.waitForFunction(() => document.querySelector('#view canvas') && document.querySelector('#view').firstElementChild.dataset.kept !== 'yes', null, { timeout: 20000 });
  await two.waitForTimeout(1500); await idle();
  assert.deepEqual(await camera(), placed, 'a rebuilt MODEL opens on the camera it had');
  await one.context().close(); await two.context().close();
}

// Both devices change the same note. The second is asked, and the question says what
// differs and whose copy is whose; choosing this window's value keeps it, and both copies
// are preserved first.
async function theCopiesDifferQuestionSaysWhatDiffers() {
  step('conflict');
  const [first] = await makeProperties('conflict');
  const one = await device(), two = await device();
  await look(one, first); await look(two, first);
  const kept = async () => (await readdir(state + '/workspace/history').catch(() => [])).filter(n => n.startsWith('conflict-')).length;
  const before = await kept();
  await two.context().setOffline(true);
  await edit(two, first, { notes: 'Typed in this window' });
  await edit(one, first, { notes: 'Saved from the other device' }); await saveNow(one);
  await two.context().setOffline(false);
  const question = two.locator('dialog[data-copies-differ]');
  await question.waitFor({ timeout: 30000 });
  const words = await question.textContent();
  assert.match(words, /Harbour house: notes/, 'the question names the record and the value that differ');
  assert.match(words, /this window: “Typed in this window”; the saved copy: “Saved from the other device”/, 'and shows both values, each under its own name');
  assert.doesNotMatch(words, /MAC VALUES|THIS DEVICE/, 'the sides are not called "Mac" and "this device"');
  assert.match(words, /conflict-.*\.tiksi/, 'it says where both copies were preserved');
  assert.equal(await question.getByRole('button').count(), 2);
  await question.getByRole('button', { name: /^USE THIS WINDOW/ }).click();
  const copy = await untilOnTheMac(c => prop(c, first).notes === 'Typed in this window', 'The value chosen with "use this window\'s values"');
  await has(one, first, 'p.notes === "Typed in this window"');
  assert.equal(await kept() - before, 2, 'both copies were preserved in the history folder before the choice');
  const preserved = JSON.parse(execFileSync('python3', ['-c', 'import sys,pathlib,zipfile,json;print(json.dumps([p.get("notes") for f in pathlib.Path(sys.argv[1]).glob("conflict-*.tiksi") for p in json.loads(zipfile.ZipFile(f).read("workspace.json"))["properties"]]))', state + '/workspace/history']).toString());
  assert(preserved.includes('Typed in this window') && preserved.includes('Saved from the other device'), 'the copy that was not chosen is among them');
  assert.equal(prop(copy, first).name, 'Harbour house');
  await one.context().close(); await two.context().close();
}

// A copy saved by newer code holds values an older tab would tidy away. The older tab loads
// the newer code once when it has nothing unsaved, and never saves over the newer copy.
async function anOlderTabDoesNotSaveOverANewerCopy() {
  step('older');
  const [first] = await makeProperties('older');
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  // To this browser, the copy on the Mac looks saved by a later Tiksi.
  await context.route(url + '/api/workspace', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    const answer = await route.fetch(), body = await answer.json();
    if (body.data) body.data.version = 99;
    return route.fulfill({ response: answer, json: body });
  });
  let loads = 0; const saves = [];
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  page.on('load', () => { loads++; });
  page.on('request', r => { if (r.method() === 'PUT' && new URL(r.url()).pathname === '/api/workspace') saves.push(1); });
  await page.goto(url + '/#/plan');
  // The Mac serves the same code again, so after its one reload the tab is still the older one.
  // It shows the copy, and says at once that it cannot save.
  await page.waitForFunction(() => document.querySelector('#save-status').dataset.saveState === 'refused', null, { timeout: 60000 });
  await page.waitForTimeout(4000);
  assert.equal(loads, 2, 'the older tab loaded the newer code once, and only once');
  await look(page, first);
  await edit(page, first, { notes: 'Typed in a tab running older code' });
  await page.waitForTimeout(1500);
  assert.equal(await page.evaluate(() => document.querySelector('#save-status').dataset.saveState), 'refused');
  assert.match(await page.evaluate(() => document.querySelector('#save-status').textContent), /older Tiksi/i, 'the status says the tab is older than the saved copy');
  await page.waitForTimeout(4000);
  assert.deepEqual(saves, [], 'an older tab sends no save over a newer copy');
  assert.notEqual(prop(await mac(), first).notes, 'Typed in a tab running older code');
  await context.close();
}

// Two devices open the same never-drafted property and both write its one-pager draft before
// either has seen the other's. That is not two people's work and must not raise a question.
async function twoDraftsAreNotAConflict() {
  step('drafts');
  const maker = await device({ hash: '' });
  await maker.evaluate(async () => {
    const store = await import('/js/store.js');
    const p = store.propertyTemplate('Never drafted'); p.id = 'prop-drafts';
    store.ws.data.properties.push(p); store.touch();
    await (await import('/js/disk-workspace.js')).diskWorkspace.sync();
  });
  await maker.context().close();
  // Device one writes its draft, and its save is held on the way to the Mac.
  let held, release; const sending = new Promise(r => { held = r; }), go = new Promise(r => { release = r; });
  const one = await device({ ready: null, before: page => page.route(url + '/api/workspace', async route => {
    if (route.request().method() !== 'PUT') return route.continue();
    held(); await go; return route.continue();
  }) });
  await sending;
  await one.waitForTimeout(50);   // the two drafts are written at different moments
  // Device two opens meanwhile, drafts the same property, and its save arrives first.
  const two = await device({ ready: null });
  await untilOnTheMac(c => prop(c, 'prop-drafts').onePager?.draftedAt, 'The second device\'s draft');
  release();
  await one.waitForFunction(() => document.querySelector('#save-status').textContent === 'SAVED TO DISK' || !!document.querySelector('dialog[open]'), null, { timeout: 30000 });
  await one.waitForTimeout(3000);
  for (const page of [one, two]) assert.equal(await page.locator('dialog[open]').count(), 0, 'two drafts written a moment apart raise no "copies differ" question');
  await one.waitForFunction(SAVED, null, { timeout: 30000 });
  await one.context().close(); await two.context().close();
}

// A project whose file is missing does not just vanish: it stays in the property list,
// greyed, with the Mac's reason, and can be taken off the list.
async function aProjectWithAMissingFileIsShown() {
  step('unavailable');
  const [first, second] = await makeProperties('unavailable');
  const page = await device();
  await look(page, first);
  // Everything this device has to say about the project is on the Mac before its file goes:
  // a project this device had changed and not yet saved would rightly be asked about instead.
  await saveNow(page); await page.waitForFunction(SAVED);
  const path = await page.evaluate(async id => (await import('/js/disk-workspace.js')).diskWorkspace.paths[id], second);
  await rm(path);
  const row = page.locator('#property-select option[data-unavailable]');
  await row.waitFor({ state: 'attached', timeout: 20000 });
  assert.match(await row.textContent(), /Garden flat \(file missing\)/);
  assert.equal(await row.isDisabled(), true, 'it cannot be opened while its file is missing');
  assert.match(await row.getAttribute('title'), /Garden flat/);
  await until(page, async id => !(await import('/js/store.js')).ws.data.properties.some(p => p.id === id), second, 'the project leaving the open records');
  // FILE, Settings gives the Mac's message and the control to take it off the list.
  await page.locator('#btn-file').click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const line = page.locator('[data-file-dialog] p[data-unavailable]');
  assert.match(await line.textContent(), /Garden flat.*project file is not at/s);
  page.on('dialog', d => d.accept());
  // The Tiksi on this Mac may not offer "take off the list" yet: it says so and changes nothing.
  await line.getByRole('button', { name: 'REMOVE FROM LIST' }).click();
  const said = page.locator('[data-file-dialog] [data-file-status]');
  await page.waitForFunction(() => /cannot take a project off its list yet|is off the list/.test(document.querySelector('[data-file-dialog] [data-file-status]').textContent), null, { timeout: 15000 });
  if (/cannot take/.test(await said.textContent())) {
    assert.equal(await line.count(), 1, 'nothing changed');
    // A stand-in for a Mac that does offer it.
    await page.route('**/api/workspace/unavailable/*/forget', route => route.fulfill({ json: { revision: 1, unavailable: [] } }));
    await line.getByRole('button', { name: 'REMOVE FROM LIST' }).click();
    await page.waitForFunction(() => /is off the list/.test(document.querySelector('[data-file-dialog] [data-file-status]').textContent), null, { timeout: 15000 });
  }
  assert.equal(await page.locator('[data-file-dialog] p[data-unavailable]').count(), 0, 'the project is off the list');
  await page.context().close();
}

// Opening a project file whose property is already open here asks first, and adding the demo
// a second time does not replace what was built on the first.
async function aProjectFileAsksBeforeItReplaces() {
  step('import');
  const [first] = await makeProperties('import');
  const page = await device();
  await look(page, first);
  const older = await page.evaluate(async id => JSON.stringify((await import('/js/store.js')).projectSlice(id)), first);
  const file = state + '/Harbour house, as exported.json';
  await writeFile(file, older);
  await edit(page, first, { notes: 'Edited since the file was exported' }); await saveNow(page);
  const asked = []; let answer = 'dismiss';
  page.on('dialog', d => { asked.push(d.message()); return answer === 'accept' ? d.accept() : d.dismiss(); });
  const openFile = async () => {
    await page.locator('#btn-file').click();
    await page.locator('[data-file-dialog] [data-any-file]').setInputFiles(file);
    await page.locator('[data-file-dialog]').waitFor({ state: 'detached', timeout: 20000 });
  };
  await openFile();
  assert.equal(asked.length, 1, 'opening a file of a property that is open here asks first');
  assert.match(asked[0], /“Harbour house” is already open here[\s\S]*Open here: 4 walls[\s\S]*In Harbour house, as exported\.json \(saved /, 'the question says what is open and what the file holds, with the file\'s date');
  assert.equal(await page.evaluate(async id => (await import('/js/store.js')).ws.data.properties.find(p => p.id === id).notes, first), 'Edited since the file was exported', 'answering no keeps what is open');
  answer = 'accept';
  await openFile();
  assert.equal(await page.evaluate(async id => (await import('/js/store.js')).ws.data.properties.find(p => p.id === id).notes, first), '', 'answering yes opens the file\'s copy');
  // An export of the project, then an edit to one of its projects only (a budget line), then
  // the export opened again: the property is the same, the project is not, and that is asked too.
  await page.evaluate(async id => {
    const s = await import('/js/store.js');
    s.ws.data.projects.push({ id: 'proj-import', name: 'Kitchen', propertyId: id, category: 'kitchen', items: [{ id: 'item-1', name: 'Cabinets', cost: 4000 }] }); s.touch();
    await (await import('/js/disk-workspace.js')).diskWorkspace.sync();
  }, first);
  await writeFile(file, await page.evaluate(async id => JSON.stringify((await import('/js/store.js')).projectSlice(id)), first));
  const cost = () => page.evaluate(async () => (await import('/js/store.js')).ws.data.projects.find(p => p.id === 'proj-import').items[0].cost);
  await page.evaluate(async () => { const s = await import('/js/store.js'); s.ws.data.projects.find(p => p.id === 'proj-import').items[0].cost = 5500; s.touch(); await (await import('/js/disk-workspace.js')).diskWorkspace.sync(); });
  asked.length = 0; answer = 'dismiss';
  await openFile();
  assert.equal(asked.length, 1, 'a file whose project differs from the open one asks first, though the property is the same');
  assert.match(asked[0], /1 project open here differs from Harbour house, as exported\.json[\s\S]*“Kitchen”/);
  assert.equal(await cost(), 5500, 'answering no keeps today\'s project edit');
  await saveNow(page);
  assert.equal((await mac()).data.projects.find(p => p.id === 'proj-import').items[0].cost, 5500);
  // The demo, twice.
  const addDemo = async () => {
    await page.locator('#btn-file').click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.locator('[data-file-dialog] summary', { hasText: 'Workspace backup' }).click();
    await page.locator('[data-file-dialog] [data-demo]').click();
    await page.locator('[data-file-dialog]').waitFor({ state: 'detached', timeout: 20000 });
  };
  await addDemo();
  await page.evaluate(async () => { const s = await import('/js/store.js'); s.ws.data.properties.find(p => p.id === 'prop-demo').notes = 'Built on the first demo'; s.touch(); });
  await addDemo();
  const demos = await page.evaluate(async () => (await import('/js/store.js')).ws.data.properties.filter(p => p.id.startsWith('prop-demo')).map(p => [p.id === 'prop-demo', p.notes]));
  assert.equal(demos.length, 2, 'the second demo is added beside the first');
  assert.deepEqual(demos.find(d => d[0]), [true, 'Built on the first demo'], 'what was built on the first demo is still there');
  await page.context().close();
}

// A page that fails to open says so on that page, with a way to reload; the other pages and
// saving go on working, and it is not reported as the Mac's project files being unavailable.
async function aPageThatFailsToOpenSaysSo() {
  step('error');
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route('**/js/budget.js*', async route => {
    const answer = await route.fetch(), text = await answer.text();
    return route.fulfill({ response: answer, body: text.replace('export function mount(', 'export function mount() { throw new Error("Synthetic: this page cannot open"); }\nfunction mountAsWritten(') });
  });
  const page = await context.newPage();
  const thrown = []; page.on('pageerror', e => thrown.push(e.message));
  await page.goto(url + '/#/budget');
  const notice = page.locator('#view .page-open-failed');
  await notice.waitFor({ timeout: 60000 });
  assert.match(await notice.textContent(), /could not open \(Synthetic: this page cannot open\)\. The other pages still work/);
  assert.equal(await notice.getByRole('button', { name: 'RELOAD' }).count(), 1);
  await page.waitForFunction(SAVED, null, { timeout: 30000 });
  await page.locator('#rail a[data-view="plan"]').click();
  await page.waitForFunction(() => location.hash === '#/plan' && !document.querySelector('#view .page-open-failed') && document.querySelector('#view').childElementCount > 0, null, { timeout: 20000 });
  assert.deepEqual(thrown, [], 'the failure was caught, not left as an error with a blank page');
  await context.close();
}

// A save reached the Mac but its reply never reached the page, and the page was dropped.
// The Mac then changed the same value. A Mac that keeps save ids says the save arrived, so
// the kept copy is dropped instead of being merged again over the later change.
async function aKeptCopyTheMacAlreadyHasIsNotSentAgain() {
  step('saveid');
  const [first] = await makeProperties('saveid');
  // A narrow window keeps what it has not sent, as a phone does.
  const context = await browser.newContext({ viewport: { width: 390, height: 800 } });
  let page = await device({ context });
  await look(page, first);
  let lostId = null;
  await context.route(url + '/api/workspace', async route => {
    if (route.request().method() !== 'PUT') return route.continue();
    const text = route.request().postData();
    if (!lostId && !/reply was lost/.test(text)) return route.continue();
    // The Mac commits the save that carries the note, and the page never hears: not of that
    // save, and not of any it tries afterwards.
    if (!lostId) { await route.fetch(); lostId = JSON.parse(text).saveId; }
    return route.abort();
  });
  await edit(page, first, { notes: 'Sent, and the reply was lost' });
  await untilOnTheMac(c => prop(c, first).notes === 'Sent, and the reply was lost', 'The save whose reply was lost');
  await page.waitForFunction(() => /kept on this device/.test(document.querySelector('#save-status').title), null, { timeout: 20000 });
  assert.equal(typeof lostId, 'string', 'every save carries an id of its own'); assert.ok(lostId.length > 8);
  await page.waitForTimeout(600);
  await page.close();
  await context.unroute(url + '/api/workspace');
  const desk = await device();
  await look(desk, first);
  await edit(desk, first, { notes: 'Changed on the Mac afterwards' }); await saveNow(desk);
  // A stand-in for a Mac that keeps save ids (the contract in the server session's note).
  const asked = [];
  await context.route('**/api/workspace/head?saveId=*', async route => {
    const id = new URL(route.request().url()).searchParams.get('saveId'); asked.push(id);
    const answer = await route.fetch({ url: url + '/api/workspace/head' }), body = await answer.json();
    return route.fulfill({ response: answer, json: { ...body, save: { saveId: id, committed: id === lostId, revision: id === lostId ? body.revision - 1 : null } } });
  });
  page = await device({ context });
  await page.waitForTimeout(3000);
  assert.ok(asked.includes(lostId), 'the next open asks the Mac about the save the kept copy went out with');
  assert.equal(await page.locator('dialog[open]').count(), 0, 'no question: the kept copy is already on the Mac');
  assert.equal(prop(await mac(), first).notes, 'Changed on the Mac afterwards', 'the later change on the Mac is not undone');
  assert.equal(await page.evaluate(async id => (await import('/js/store.js')).ws.data.properties.find(p => p.id === id).notes, first), 'Changed on the Mac afterwards');
  // And it is gone from this browser: the next open asks nothing.
  asked.length = 0;
  await page.reload(); await page.waitForFunction(SAVED, null, { timeout: 30000 }); await page.waitForTimeout(1500);
  assert.deepEqual(asked, []);
  await context.close(); await desk.context().close();
}

// A stored original never changes on the Mac, so the browser may keep it: opening the page
// again does not download it again. Page memory holds originals only up to a limit; a larger
// one is handed over and not kept, and the ones read longest ago make room.
async function originalsAreNotDownloadedAndHeldForEver() {
  step('originals');
  const [first] = await makeProperties('originals');
  const maker = await device({ hash: '' });
  const sizes = { 'original-a': 60000, 'original-b': 40000, 'original-c': 30000 };
  await maker.evaluate(async ([id, sizes]) => {
    const store = await import('/js/store.js'), p = store.ws.data.properties.find(p => p.id === id);
    for (const [name, size] of Object.entries(sizes)) {
      const bytes = new Uint8Array(size); for (let i = 0; i < size; i++) bytes[i] = (i * 31 + size) & 255;
      await store.putFile(name, bytes.buffer, { kind: 'photo', mime: 'image/jpeg', name: name + '.jpg' });
      p.photos.push({ id: name, name, thumb: '', notes: '', kind: 'photo' });
    }
    store.touch();
    await (await import('/js/disk-workspace.js')).diskWorkspace.sync();
  }, [first, sizes]);
  await maker.context().close();
  const hash = (await mac()).assets['original-a'].hash;
  const page = await device();
  const readOriginal = name => page.evaluate(async name => { const f = await (await import('/js/store.js')).getFile(name); const b = new Uint8Array(f.buffer); return [b.length, b[1], b[b.length - 1]]; }, name);
  const expected = name => [sizes[name], (31 + sizes[name]) & 255, ((sizes[name] - 1) * 31 + sizes[name]) & 255];
  const held = name => page.evaluate(async name => !!(await (await import('/js/store.js')).getCachedFile(name))?.buffer, name);
  assert.deepEqual(await readOriginal('original-a'), expected('original-a'));
  assert.equal(asked.get(hash), 1);
  await page.reload(); await page.waitForFunction(SAVED);
  assert.deepEqual(await readOriginal('original-a'), expected('original-a'), 'the original reads the same after the page is opened again');
  await new Promise(r => setTimeout(r, 300));
  assert.equal(asked.get(hash), 1, 'and the Mac was not asked for it a second time: the browser kept it');
  // Page memory: an original over the per-file limit is handed over, not held.
  await page.evaluate(async () => { Object.assign((await import('/js/disk-workspace.js')).originalLimits, { fileBytes: 50000, totalBytes: 60000 }); });
  await page.reload(); await page.waitForFunction(SAVED);
  await page.evaluate(async () => { Object.assign((await import('/js/disk-workspace.js')).originalLimits, { fileBytes: 50000, totalBytes: 60000 }); });
  assert.deepEqual(await readOriginal('original-a'), expected('original-a'));
  assert.equal(await held('original-a'), false, 'an original larger than the limit is not kept in page memory');
  const twice = await page.evaluate(async () => {
    const s = await import('/js/store.js'), one = await s.getFile('original-a');
    new Uint8Array(one.buffer)[1] = 0; structuredClone(one.buffer, { transfer: [one.buffer] });
    const two = await s.getFile('original-a');
    return [one.buffer.byteLength, new Uint8Array(two.buffer)[1], two.buffer.byteLength];
  });
  assert.deepEqual(twice, [0, expected('original-a')[1], 60000], 'whoever reads it next still gets every byte, whatever the first reader did with its copy');
  // Two that fit one at a time: reading the second lets go of the first.
  assert.deepEqual(await readOriginal('original-b'), expected('original-b'));
  assert.equal(await held('original-b'), true);
  assert.deepEqual(await readOriginal('original-c'), expected('original-c'));
  assert.equal(await held('original-c'), true);
  assert.equal(await held('original-b'), false, 'the original read longest ago makes room');
  assert.deepEqual(await readOriginal('original-b'), expected('original-b'), 'and is read again when wanted');
  await page.context().close();
}

// The first screen waits for the pictures of the property it opens on, not for every
// property's. The others arrive behind the open app and go into the records in place.
async function theFirstScreenDoesNotWaitForEveryPicture() {
  step('pictures');
  const [first, second] = await makeProperties('pictures');
  const maker = await device({ hash: '' });
  await maker.evaluate(async ids => {
    const store = await import('/js/store.js');
    ids.forEach((id, n) => {
      // A picture large enough to be stored as a file of its own, different for each property.
      const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 64;
      const g = canvas.getContext('2d'); for (let i = 0; i < 400; i++) { g.fillStyle = 'hsl(' + ((i * 37 + n * 120) % 360) + ' 70% 50%)'; g.fillRect((i * 13) % 64, (i * 29 + n * 7) % 64, 5, 5); }
      store.ws.data.properties.find(p => p.id === id).photos.push({ id: 'photo-' + n, name: 'Picture ' + n, thumb: canvas.toDataURL('image/png'), notes: '', kind: 'photo' });
    });
    store.touch();
    await (await import('/js/disk-workspace.js')).diskWorkspace.sync();
  }, [first, second]);
  await maker.context().close();
  const reference = prop(await mac(), second).photos.find(p => p.id === 'photo-1').thumb;
  assert.match(reference, /^tiksi-picture:image\/png:pic-[0-9a-f]{64}$/, 'the picture is a file on the Mac');
  const otherHash = reference.slice(-64);
  // This device last had the first property open. The other property's picture is held back.
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(id => { try { if (!localStorage.getItem('tiksi.device.view.v1')) localStorage.setItem('tiksi.device.view.v1', JSON.stringify({ property: id, levels: {}, tags: {} })); } catch {} }, first);
  let release, wanted = false; const go = new Promise(r => { release = r; });
  await context.route('**/api/workspace/blobs/' + otherHash, async route => { wanted = true; await go; return route.continue(); });
  const page = await device({ context, hash: '#/photos', ready: null });
  await page.getByRole('button', { name: /Picture 0/ }).waitFor({ timeout: 30000 });
  const thumbs = () => page.evaluate(async ids => { const s = await import('/js/store.js'); return ids.map(id => s.ws.data.properties.find(p => p.id === id).photos.find(ph => /^photo-/.test(ph.id)).thumb.slice(0, 14)); }, [first, second]);
  assert.deepEqual(await thumbs(), ['data:image/png', 'tiksi-picture:'], 'the app is open with the open property\'s picture, while the other property\'s is still on its way');
  for (const end = Date.now() + 15000; !wanted && Date.now() < end;) await new Promise(r => setTimeout(r, 100));
  assert.equal(wanted, true, 'the other picture was asked for behind the open app');
  release();
  await until(page, async id => (await import('/js/store.js')).ws.data.properties.find(p => p.id === id).photos.find(ph => ph.id === 'photo-1').thumb.startsWith('data:image/png'), second, 'the other property\'s picture arriving');
  // Arriving pictures are not an edit: nothing is saved because of them.
  await page.waitForFunction(SAVED);
  assert.equal(await page.evaluate(async () => (await import('/js/disk-workspace.js')).diskWorkspace.pending), false);
  assert.equal(prop(await mac(), second).photos.find(p => p.id === 'photo-1').thumb, reference);
  await context.close();
}

// The copy that keeps everything in the browser (the hosted one, or the app opened without
// the Mac's server): a stored workspace that cannot be read is left exactly as it is.
async function anUnreadableStoredWorkspaceIsLeftAsItIs() {
  step('stored');
  const root = resolve('.');
  const plain = http.createServer(async (req, res) => {
    const path = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
    if (path !== root && !path.startsWith(root + sep)) { res.writeHead(404).end(); return; }
    try {
      const bytes = await readFile(path === root ? resolve(root, 'index.html') : path);
      res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.json': 'application/json', '.wasm': 'application/wasm' })[extname(path)] || (path === root ? 'text/html' : 'application/octet-stream'));
      res.end(bytes);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(r => plain.listen(0, '127.0.0.1', r));
  const site = 'http://127.0.0.1:' + plain.address().port;
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(site + '/app-icon.svg');
    await page.evaluate(() => localStorage.setItem('tiksi.workspace.v1', '{"properties": [ this is not a workspace any more'));
    await page.goto(site + '/');
    const notice = page.locator('#view .page-open-failed');
    await notice.waitFor({ timeout: 60000 });
    assert.match(await notice.textContent(), /stored in this browser could not be read[\s\S]*Nothing has been changed or saved over it/);
    await page.waitForTimeout(2500);   // well past the moment the older code saved the demo over it
    assert.equal(await page.evaluate(() => localStorage.getItem('tiksi.workspace.v1')), '{"properties": [ this is not a workspace any more', 'the stored text is exactly as it was found');
    await notice.getByRole('button', { name: 'START WITH AN EMPTY WORKSPACE' }).click();
    await page.locator('#property-select option').first().waitFor({ state: 'attached', timeout: 60000 });
    const kept = await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('tiksi.workspace.v1.unreadable.')).map(k => localStorage.getItem(k)));
    assert.deepEqual(kept, ['{"properties": [ this is not a workspace any more'], 'starting again keeps the unreadable text in the browser under another name');
    assert.equal(await page.locator('#view .page-open-failed').count(), 0);
    await context.close();
  } finally { await new Promise(r => plain.close(r)); plain.closeAllConnections?.(); }
}

// A value being typed into a record inside the property (here a photo's notes) while another
// device saves the same property: the record the field writes into must still be the live
// one, whether the other device changed a different record or the very same one.
async function aNestedRecordStaysTheLiveOne() {
  step('nested');
  const [first] = await makeProperties('nested');
  const maker = await device({ hash: '' });
  await maker.evaluate(async id => {
    const store = await import('/js/store.js'), p = store.ws.data.properties.find(p => p.id === id);
    for (const n of ['one', 'two']) p.photos.push({ id: 'photo-' + n, name: 'Photo ' + n, thumb: '', notes: '', kind: 'photo' });
    store.touch();
    await (await import('/js/disk-workspace.js')).diskWorkspace.sync();
  }, first);
  await maker.context().close();
  const one = await device({ hash: '#/photos' }), two = await device({ hash: '#/photos' });
  await look(one, first); await look(two, first);
  const photo = (copy, id) => prop(copy, first).photos.find(p => p.id === id);
  const editPhoto = (page, id, change) => page.evaluate(async ([prop, id, change]) => {
    const store = await import('/js/store.js');
    Object.assign(store.ws.data.properties.find(p => p.id === prop).photos.find(p => p.id === id), change); store.touch();
  }, [first, id, change]);
  // Device two opens a photo's details and starts typing its notes.
  await two.getByRole('button', { name: /Photo one/ }).click();
  const notes = two.locator('[data-f=notes]');
  await notes.click(); await notes.fill('Typed while another device saved a different photo');
  // 1. The other device saves a different record of the same property.
  await editPhoto(one, 'photo-two', { notes: 'Saved from the other device' }); await saveNow(one);
  await has(two, first, 'p.photos.find(ph => ph.id === "photo-two").notes === "Saved from the other device"');
  await notes.blur();
  let copy = await untilOnTheMac(c => photo(c, 'photo-one').notes === 'Typed while another device saved a different photo', 'Notes typed into a photo while another device saved another photo');
  assert.equal(photo(copy, 'photo-two').notes, 'Saved from the other device');
  await two.waitForFunction(SAVED);
  // 2. The other device saves another field of the very same record.
  await two.getByRole('button', { name: /Photo one/ }).click();
  await notes.click(); await notes.fill('Typed while another device renamed this photo');
  await editPhoto(one, 'photo-one', { name: 'Photo one, renamed' }); await saveNow(one);
  await has(two, first, 'p.photos.find(ph => ph.id === "photo-one").name === "Photo one, renamed"');
  await notes.blur();
  copy = await untilOnTheMac(c => photo(c, 'photo-one').notes === 'Typed while another device renamed this photo', 'Notes typed into a photo while another device renamed that photo');
  assert.equal(photo(copy, 'photo-one').name, 'Photo one, renamed', 'and the other device\'s change to the same record is kept beside it');
  // The page then shows what the Mac has: the typed value has not gone back to the old one.
  await two.waitForFunction(SAVED);
  assert.equal(await two.evaluate(async id => (await import('/js/store.js')).ws.data.properties.find(p => p.id === id).photos.find(p => p.id === 'photo-one').notes, first), 'Typed while another device renamed this photo');
  await one.context().close(); await two.context().close();
}

// The one-pager editor: a headline being typed while another device saves the same property
// is still there afterwards, and is saved.
async function theOnePagerEditorKeepsWhatIsTyped() {
  step('onepager');
  const [first] = await makeProperties('onepager');
  const one = await device(), two = await device();
  await look(one, first); await look(two, first);
  await two.evaluate(() => document.dispatchEvent(new CustomEvent('tiksi:one-pager')));
  const headline = two.locator('dialog[open] [data-f=headline]');
  await headline.click(); await headline.fill('A headline typed while the other device saved');
  await edit(one, first, { notes: 'Saved from the other device during the typing' }); await saveNow(one);
  await has(two, first, 'p.notes === "Saved from the other device during the typing"');
  await two.waitForTimeout(500);
  assert.equal(await headline.inputValue(), 'A headline typed while the other device saved', 'the field still holds what was typed');
  const copy = await untilOnTheMac(c => prop(c, first).onePager.headline === 'A headline typed while the other device saved', 'A one-pager headline typed during another device\'s save');
  assert.equal(prop(copy, first).notes, 'Saved from the other device during the typing');
  await one.context().close(); await two.context().close();
}

const parts = { view: eachDeviceKeepsItsOwnView, typing: aSaveElsewhereLeavesThePageAlone, slow: aSlowActionWritesIntoTheLiveRecord, nested: aNestedRecordStaysTheLiveOne, onepager: theOnePagerEditorKeepsWhatIsTyped, conflict: theCopiesDifferQuestionSaysWhatDiffers, older: anOlderTabDoesNotSaveOverANewerCopy,
  drafts: twoDraftsAreNotAConflict, unavailable: aProjectWithAMissingFileIsShown, import: aProjectFileAsksBeforeItReplaces, error: aPageThatFailsToOpenSaysSo, saveid: aKeptCopyTheMacAlreadyHasIsNotSentAgain,
  originals: originalsAreNotDownloadedAndHeldForEver, pictures: theFirstScreenDoesNotWaitForEveryPicture, stored: anUnreadableStoredWorkspaceIsLeftAsItIs, model: modelKeepsItsCamera };

try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(url)).ok) break; } catch {} await new Promise(r => setTimeout(r, 50)); }
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  // The run is stopped after ten minutes, naming the part it was in.
  let timer;
  for (const key of (process.env.E2E_STEP || '').split(',').filter(Boolean)) assert.ok(parts[key], 'E2E_STEP names a part that does not exist: ' + key);
  await Promise.race([(async () => { for (const [key, part] of Object.entries(parts)) if (!process.env.E2E_STEP || process.env.E2E_STEP.split(',').includes(key)) await part(); })(),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('The run did not finish; it was in part ' + lastStep)), 600000); })]).finally(() => clearTimeout(timer));
  assert.deepEqual(errors, []);
  console.log('ok   two devices: own view each; a save elsewhere updates in place; the copies-differ question names what differs; an older tab cannot save over a newer copy; drafts do not conflict; a missing project file is shown; a project file asks before replacing; a failed page says so; a kept copy the Mac has is not sent again; originals are cached and not held for ever; the first screen does not wait for every picture; an unreadable stored workspace is left as it is; MODEL keeps its camera');
} catch (error) {
  // The failure first: a browser that will not close must not hide it.
  console.error(error);
  console.error('Server log (last lines):\n' + serverLog.split('\n').slice(-15).join('\n'));
  if (browser) console.error('Pages:', await Promise.all(browser.contexts().flatMap(context => context.pages()).map(page => page.evaluate(() => ({ url: location.href, status: document.querySelector('#save-status')?.textContent, title: document.querySelector('#save-status')?.title, dialog: document.querySelector('dialog[open]')?.textContent?.slice(0, 700) })).catch(() => null))));
  process.exitCode = 1;
} finally {
  // Bounded clean-up: a stuck page or server fails this suite in seconds, not at the CI job limit.
  const bounded = (promise, ms) => Promise.race([promise, new Promise(r => setTimeout(r, ms))]);
  if (browser) await bounded(browser.close(), 20000);
  const exited = child.exitCode !== null ? Promise.resolve() : new Promise(r => child.once('exit', r));
  child.kill(); await bounded(exited, 10000); if (child.exitCode === null) child.kill('SIGKILL');
  await rm(state, { recursive: true, force: true });
}
