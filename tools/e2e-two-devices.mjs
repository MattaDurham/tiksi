// Two devices side by side on the Mac's project files: what one of them does must reach the
// other without moving what the other is looking at, without rebuilding the page under a
// cursor, and without losing what either of them saved.
// Each "device" is its own browser context (its own storage). One private server on a free
// port; every project is synthetic and lives in a temporary folder.
// E2E_STEP=<part name> runs one part.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { chromium } from 'playwright';

const state = await mkdtemp(tmpdir() + '/tiksi-two-devices-');
const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r));
const port = socket.address().port; await new Promise(r => socket.close(r));
const child = spawn('python3', ['tools/serve.py', '--port', String(port), '--state-dir', state, '--projects-dir', state + '/projects'], { stdio: ['ignore', 'pipe', 'pipe'] });
// Read the server's output: an unread pipe fills and then every server thread stops at its next log line.
let serverLog = ''; child.stdout.resume(); child.stderr.on('data', d => { serverLog = (serverLog + d).slice(-8000); });
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
  if (await page.evaluate(() => document.querySelector('#property-select').value) !== id) await page.selectOption('#property-select', id);
  await page.waitForFunction(async id => (await import('/js/store.js')).activeProperty()?.id === id, id);
}
const edit = (page, id, change) => page.evaluate(async ([id, change]) => {
  const store = await import('/js/store.js');
  Object.assign(store.ws.data.properties.find(p => p.id === id), change); store.touch();
}, [id, change]);
const saveNow = page => page.evaluate(async () => (await import('/js/disk-workspace.js')).diskWorkspace.sync());
const has = (page, id, check) => page.waitForFunction(async ([id, check]) => {
  const p = (await import('/js/store.js')).ws.data.properties.find(p => p.id === id);
  return !!p && new Function('p', 'return ' + check)(p);
}, [id, check], { timeout: 20000 });

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
  const idle = () => two.waitForFunction(async () => (await import('/js/viewer3d.js')).viewerIdle() && document.querySelector('#save-status').textContent === 'SAVED TO DISK', null, { timeout: 240000, polling: 500 });
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

const parts = { view: eachDeviceKeepsItsOwnView, typing: aSaveElsewhereLeavesThePageAlone, slow: aSlowActionWritesIntoTheLiveRecord, model: modelKeepsItsCamera };

try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(url)).ok) break; } catch {} await new Promise(r => setTimeout(r, 50)); }
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  // The run is stopped after ten minutes, naming the part it was in.
  let timer;
  await Promise.race([(async () => { for (const [key, part] of Object.entries(parts)) if (!process.env.E2E_STEP || process.env.E2E_STEP === key) await part(); })(),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('The run did not finish; it was in part ' + lastStep)), 600000); })]).finally(() => clearTimeout(timer));
  assert.deepEqual(errors, []);
  console.log('ok   two devices: each keeps its own view; a save elsewhere leaves the page alone unless it shows the change, and waits for a text field; a slow action writes into the live record; MODEL keeps its camera');
} catch (error) {
  // The failure first: a browser that will not close must not hide it.
  console.error(error);
  console.error('Server log (last lines):\n' + serverLog.split('\n').slice(-15).join('\n'));
  if (browser) console.error('Pages:', await Promise.all(browser.contexts().flatMap(context => context.pages()).map(page => page.evaluate(() => ({ url: location.href, status: document.querySelector('#save-status')?.textContent, title: document.querySelector('#save-status')?.title, dialog: document.querySelector('dialog[open]')?.textContent?.slice(0, 160) })).catch(() => null))));
  process.exitCode = 1;
} finally {
  // Bounded clean-up: a stuck page or server fails this suite in seconds, not at the CI job limit.
  const bounded = (promise, ms) => Promise.race([promise, new Promise(r => setTimeout(r, ms))]);
  if (browser) await bounded(browser.close(), 20000);
  const exited = child.exitCode !== null ? Promise.resolve() : new Promise(r => child.once('exit', r));
  child.kill(); await bounded(exited, 10000); if (child.exitCode === null) child.kill('SIGKILL');
  await rm(state, { recursive: true, force: true });
}
