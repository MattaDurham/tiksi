// A phone on the Mac's project files: what it has not sent yet must survive a lock, a
// switched app and a dropped tab, and the phone bar must say where a save stands.
// Runs in Chromium with a phone profile, and also in WebKit (Safari's engine) with the
// iPhone profile where that browser is installed. One private server on a free port; every
// project is synthetic and lives in a temporary folder.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { chromium, webkit, devices } from 'playwright';

const state = await mkdtemp(tmpdir() + '/tiksi-phone-unsent-');
const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r));
const port = socket.address().port; await new Promise(r => socket.close(r));
const child = spawn('python3', ['tools/serve.py', '--port', String(port), '--state-dir', state, '--projects-dir', state + '/projects'], { stdio: ['ignore', 'pipe', 'pipe'] });
// Read the server's output: an unread pipe fills and then every server thread stops at its next log line.
let serverLog = ''; child.stdout.resume(); child.stderr.on('data', d => { serverLog = (serverLog + d).slice(-8000); });
const url = 'http://127.0.0.1:' + port;
const SAVED = () => document.querySelector('#save-status').textContent === 'SAVED TO DISK';
const errors = [];
let browser, lastStep = 'start';
// Named when a run is stopped for taking too long.
const step = text => { lastStep = text; if (process.env.E2E_TRACE) console.log('  .. ' + text); };

// The Mac's own copy, read the way another device would read it.
async function onTheMac() {
  const auth = { 'X-Tiksi-Workspace': '1' };
  auth['X-Tiksi-Token'] = (await (await fetch(url + '/api/workspace/capabilities', { headers: auth })).json()).token;
  return (await fetch(url + '/api/workspace', { headers: auth })).json();
}
async function untilOnTheMac(check, what, ms = 15000) {
  for (const end = Date.now() + ms; ;) {
    const mac = await onTheMac();
    if (check(mac)) return mac;
    if (Date.now() > end) assert.fail(what + ' did not reach the Mac within ' + ms / 1000 + ' s');
    await new Promise(r => setTimeout(r, 150));
  }
}
async function openPage(context, hash = '', ready = SAVED) {
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(url + '/' + hash);
  if (ready) await page.waitForFunction(ready, null, { timeout: 60000 });
  return page;
}
// A device that has not opened this workspace before starts on the property the Mac's copy
// names; which property is open is then each device's own choice. Choose it the way the
// phone panel does, through the property list.
async function look(page, id) {
  for (const end = Date.now() + 30000; ;) {
    // The list is filled, and listens, a moment after the page first reads SAVED TO DISK.
    const open = await page.evaluate(async id => {
      const list = document.querySelector('#property-select');
      if (list.onchange && list.value !== id && [...list.options].some(o => o.value === id)) { list.value = id; list.dispatchEvent(new Event('change')); }
      return (await import('/js/store.js')).activeProperty()?.id === id && list.value === id;
    }, id);
    if (open) return;
    if (Date.now() > end) assert.fail('the property did not open');
    await new Promise(r => setTimeout(r, 100));
  }
}
const edit = (page, id, change) => page.evaluate(async ([id, change]) => {
  const store = await import('/js/store.js');
  Object.assign(store.ws.data.properties.find(p => p.id === id), change); store.touch();
}, [id, change]);
const saveNow = page => page.evaluate(async () => (await import('/js/disk-workspace.js')).diskWorkspace.sync());
const barState = page => page.evaluate(() => ({ state: document.querySelector('.fd-save').dataset.state, label: document.querySelector('.fd-save span').textContent }));

async function run(name, type, profile) {
  browser = await type.launch(type === chromium ? { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } : {});
  const id = 'prop-site-' + name;
  // The Mac's desktop browser makes the property the phone will work on.
  const desktopContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const desktop = await openPage(desktopContext);
  await desktop.evaluate(async id => {
    const store = await import('/js/store.js');
    const p = store.propertyTemplate('Site visit'); p.id = id; p.notes = 'As the Mac has it';
    store.ws.data.properties.push(p); store.ws.data.settings.activePropertyId = id; store.touch();
    await (await import('/js/disk-workspace.js')).diskWorkspace.sync();
  }, id);
  const phoneContext = await browser.newContext({ ...profile });
  const noteOnMac = async () => (await onTheMac()).data.properties.find(p => p.id === id).notes;

  step('1');
  // 1. The phone layout hides the topbar and its status line. The bar carries the save state.
  await phoneContext.clock.install();
  let phone = await openPage(phoneContext, '#/photos');
  await look(phone, id);
  assert.equal(await phone.locator('#topbar').isVisible(), false, 'the phone layout has no topbar');
  assert.equal(await phone.locator('.fd-save').isVisible(), true, 'the phone bar shows the save state');
  // Opening a page ends with one more look at the Mac, so the bar settles a moment after it appears.
  const barSettles = page => page.waitForFunction(() => document.querySelector('.fd-save')?.dataset.state === 'saved' && document.querySelector('#save-status').textContent === 'SAVED TO DISK');
  await barSettles(phone);
  assert.deepEqual(await barState(phone), { state: 'saved', label: 'Saved' });

  step('2');
  // 2. An edit, and the page is hidden at once (the phone locks). Time is stopped here, so
  // the usual short wait before a save can never run out: only "hidden" can send it.
  await phone.clock.pauseAt(Date.now() + 3000);
  await phone.evaluate(async id => {
    const store = await import('/js/store.js');
    store.ws.data.properties.find(p => p.id === id).notes = 'Typed just before the phone locked'; store.touch();
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  }, id);
  await untilOnTheMac(mac => mac.data.properties.find(p => p.id === id).notes === 'Typed just before the phone locked', 'An edit made just before the page was hidden');
  await phone.evaluate(() => { delete document.visibilityState; document.dispatchEvent(new Event('visibilitychange')); });
  await phone.clock.resume();
  await phone.waitForFunction(SAVED);

  step('3');
  // 3. The Mac cannot be reached. A photo is taken and a note is typed; the bar says the
  // phone is waiting for the Mac, and a tap says the changes are kept on this device.
  await phoneContext.setOffline(true);
  const photo = await phone.evaluate(async id => {
    const store = await import('/js/store.js'), { addPhotoFromFile } = await import('/js/photos-store.js');
    const canvas = document.createElement('canvas'); canvas.width = 96; canvas.height = 64;
    const g = canvas.getContext('2d'); g.fillStyle = '#7a5236'; g.fillRect(0, 0, 96, 64); g.fillStyle = '#e8e2d4'; g.fillRect(12, 10, 60, 40);
    const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
    const prop = store.ws.data.properties.find(p => p.id === id);
    const rec = await addPhotoFromFile(prop, new File([blob], 'Taken while away.png', { type: 'image/png' }));
    prop.notes = 'Typed while the Mac was out of reach'; store.touch();
    return { id: rec.id, size: blob.size };
  }, id);
  await phone.waitForFunction(() => document.querySelector('.fd-save').dataset.state === 'waiting', null, { timeout: 20000 });
  assert.equal((await barState(phone)).label, 'Waiting');
  await phone.waitForFunction(() => /kept on this device/.test(document.querySelector('#save-status').title), null, { timeout: 20000 });
  await phone.locator('.fd-save').click();
  assert.match(await phone.locator('.fd-save-note').textContent(), /cannot reach the Mac.*kept on this device/i, 'a tap on the save state says what is happening');
  assert.equal(await noteOnMac(), 'Typed just before the phone locked', 'nothing reached the Mac while it was out of reach');
  // The tab is dropped before the Mac ever comes back.
  await phone.close();
  await phoneContext.setOffline(false);
  // The next time Tiksi is opened on the phone, what it kept is sent.
  phone = await openPage(phoneContext, '#/photos');
  let mac = await untilOnTheMac(m => m.data.properties.find(p => p.id === id).notes === 'Typed while the Mac was out of reach', 'A note typed while the Mac was out of reach, then the tab dropped');
  assert(mac.data.properties.find(p => p.id === id).photos.some(p => p.id === photo.id), 'the photo taken while away is in the project');
  assert.equal(mac.assets[photo.id]?.size, photo.size, 'the photo\'s original bytes are on the Mac');
  await phone.getByRole('button', { name: /Taken while away/ }).waitFor();
  await barSettles(phone);
  assert.deepEqual(await barState(phone), { state: 'saved', label: 'Saved' });

  step('4');
  // 4. Once the Mac has confirmed it, the phone keeps nothing: a later change on the Mac is
  // not undone by an old copy the next time the phone opens.
  await desktop.evaluate(async ([id, photoId]) => {
    const store = await import('/js/store.js'), disk = (await import('/js/disk-workspace.js')).diskWorkspace;
    await disk.sync();
    const prop = store.ws.data.properties.find(p => p.id === id);
    prop.photos = prop.photos.filter(p => p.id !== photoId); prop.notes = 'Tidied on the Mac'; store.touch();
    await disk.sync();
  }, [id, photo.id]);
  await phone.close();
  phone = await openPage(phoneContext, '#/photos');
  await saveNow(phone);
  mac = await onTheMac();
  assert.equal(mac.data.properties.find(p => p.id === id).notes, 'Tidied on the Mac', 'a confirmed change is not sent a second time');
  assert.equal(mac.data.properties.find(p => p.id === id).photos.some(p => p.id === photo.id), false, 'a photo removed on the Mac stays removed');

  step('5');
  // 5. The phone changes a note out of reach and the tab is dropped; meanwhile the Mac
  // changes the same note. On the next open the two are put to the person, as for any
  // offline edit: nothing is overwritten unseen, and both copies are preserved.
  await phoneContext.setOffline(true);
  await phone.evaluate(async id => {
    const store = await import('/js/store.js');
    store.ws.data.properties.find(p => p.id === id).notes = 'Phone, out of reach';
    const added = store.propertyTemplate('Added on the phone'); added.id = id + '-added'; store.ws.data.properties.push(added); store.touch();
  }, id);
  await phone.waitForFunction(() => /kept on this device/.test(document.querySelector('#save-status').title), null, { timeout: 20000 });
  await phone.close();
  await edit(desktop, id, { notes: 'Mac, meanwhile' }); await saveNow(desktop);
  await phoneContext.setOffline(false);
  phone = await openPage(phoneContext, '#/photos', null);
  await phone.getByRole('button', { name: /^USE THE SAVED COPY/ }).click({ timeout: 60000 });
  await phone.waitForFunction(SAVED, null, { timeout: 60000 });
  mac = await onTheMac();
  assert.equal(mac.data.properties.find(p => p.id === id).notes, 'Mac, meanwhile', 'the Mac\'s value was kept, as chosen');
  assert(mac.data.properties.some(p => p.id === id + '-added'), 'the property added on the phone is kept: it conflicts with nothing');
  const preserved = JSON.parse(execFileSync('python3', ['-c', 'import sys,pathlib,zipfile,json;print(json.dumps([p.get("notes") for f in pathlib.Path(sys.argv[1]).glob("conflict-*.tiksi") for p in json.loads(zipfile.ZipFile(f).read("workspace.json"))["properties"]]))', state + '/workspace/history']).toString());
  assert(preserved.includes('Phone, out of reach') && preserved.includes('Mac, meanwhile'), 'both copies of the note were preserved before the choice');

  step('6');
  // 6. A photo's bytes reach the Mac but the save that names it does not, and the tab is
  // dropped. The next open finishes the save without uploading the photo again.
  let failSaves = true;
  const uploads = [];
  // The project folder is out of reach for this step, so the photo is kept as an original Tiksi
  // holds (a photo the Mac can take is written into the folder instead: e2e-project-photos.mjs).
  const noFolder = route => route.abort();
  await phoneContext.route('**/api/workspace/photos/**', noFolder);
  await phoneContext.route('**/api/workspace', route => failSaves && route.request().method() === 'PUT' ? route.abort() : route.continue());
  phoneContext.on('requestfinished', async request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/workspace/blobs') uploads.push((await request.sizes().catch(() => null))?.requestBodySize ?? request.postDataBuffer()?.length);
  });
  const second = await phone.evaluate(async id => {
    const store = await import('/js/store.js'), { addPhotoFromFile } = await import('/js/photos-store.js');
    // Noise, so the original is far larger than its thumbnail and cannot be mistaken for it.
    const bytes = new Uint8Array(180000); for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7919 + (i >> 5)) & 255;
    const canvas = document.createElement('canvas'); canvas.width = 80; canvas.height = 60; canvas.getContext('2d').fillRect(0, 0, 80, 60);
    const png = new Uint8Array(await (await new Promise(r => canvas.toBlob(r, 'image/png'))).arrayBuffer());
    // A real PNG followed by the noise still opens as a picture.
    const file = new File([png, bytes], 'Uploaded then dropped.png', { type: 'image/png' });
    const rec = await addPhotoFromFile(store.ws.data.properties.find(p => p.id === id), file);
    return { id: rec.id, size: file.size };
  }, id);
  await phone.waitForFunction(() => /kept on this device/.test(document.querySelector('#save-status').title), null, { timeout: 20000 });
  await phone.waitForTimeout(600);   // the note of which originals the Mac holds is written a moment after the upload
  assert(uploads.includes(second.size), 'the photo was uploaded before the save failed (uploads: ' + uploads.join(', ') + ')');
  assert.equal((await onTheMac()).assets[second.id], undefined, 'the save naming the photo never reached the Mac');
  await phone.close();
  failSaves = false; uploads.length = 0;
  phone = await openPage(phoneContext, '#/photos');
  mac = await untilOnTheMac(m => m.assets[second.id], 'The photo whose save had failed');
  assert.equal(mac.assets[second.id].size, second.size);
  await phone.waitForFunction(SAVED, null, { timeout: 30000 });
  assert.equal(uploads.filter(size => size === second.size).length, 0, 'a photo the Mac already holds is not uploaded again after the tab was dropped (uploads: ' + uploads.join(', ') + ')');
  await phoneContext.unroute('**/api/workspace/photos/**', noFolder);

  step('8');
  // 8. An original is added a moment before the record that names it (a long video is
  // checked in between), and a save round passes in that moment. The original must still be
  // kept: the record is then made out of reach and the tab is dropped.
  const lateId = 'original-before-record-' + name;
  const late = await phone.evaluate(async lateId => {
    const store = await import('/js/store.js');
    const bytes = new Uint8Array(50000); for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 131) & 255;
    await store.putFile(lateId, bytes.buffer, { kind: 'photo', mime: 'image/jpeg', name: 'Before its record.jpg' });
    await (await import('/js/disk-workspace.js')).diskWorkspace.sync();
    return bytes.length;
  }, lateId);
  await phoneContext.setOffline(true);
  await phone.evaluate(async ([id, lateId]) => {
    const store = await import('/js/store.js');
    store.ws.data.properties.find(p => p.id === id).photos.push({ id: lateId, name: 'Before its record', thumb: '', notes: '', kind: 'photo' }); store.touch();
  }, [id, lateId]);
  await phone.waitForFunction(() => /kept on this device/.test(document.querySelector('#save-status').title), null, { timeout: 20000 });
  await phone.close();
  await phoneContext.setOffline(false);
  phone = await openPage(phoneContext, '#/photos');
  mac = await untilOnTheMac(m => m.data.properties.find(p => p.id === id).photos.some(p => p.id === lateId), 'A photo record made after its original');
  assert.equal(mac.assets[lateId]?.size, late, 'an original added before its record is still kept and reaches the Mac');
  await phone.waitForFunction(SAVED, null, { timeout: 30000 });

  step('9');
  // 9. A page that is still open sends its own changes. A second page opened beside it
  // leaves the first page's kept copy alone.
  await phone.route('**/api/workspace**', route => route.abort());
  await edit(phone, id, { notes: 'Still open in the first page' });
  await phone.waitForFunction(() => /kept on this device/.test(document.querySelector('#save-status').title), null, { timeout: 20000 });
  const beside = await openPage(phoneContext, '#/photos');
  await saveNow(beside);
  assert.notEqual(await noteOnMac(), 'Still open in the first page', 'a second page does not send what an open page kept');
  assert.equal(await beside.evaluate(async id => (await import('/js/store.js')).ws.data.properties.find(p => p.id === id).notes, id), 'Mac, meanwhile', 'the second page shows the Mac\'s copy');
  await beside.close();
  await phone.unroute('**/api/workspace**');
  await untilOnTheMac(m => m.data.properties.find(p => p.id === id).notes === 'Still open in the first page', 'The open page\'s own edit, once it could reach the Mac', 30000);

  step('7');
  // 7. The Mac's own desktop browser sits beside its server and keeps nothing in the browser.
  assert.equal(await desktop.evaluate(async () => (await indexedDB.databases()).some(d => d.name === 'tiksi-unsent')), false, 'the desktop browser on the Mac keeps no unsent copy');
  assert.equal(await phone.evaluate(async () => (await indexedDB.databases()).some(d => d.name === 'tiksi-files')), false, 'the phone still keeps no project store of its own');

  await browser.close(); browser = null;
  console.log('ok   ' + name + ': the phone bar shows the save state; a hidden page sends at once; unsent edits and photos survive a dropped tab and go through review when the Mac moved on; an open page keeps its own');
}

try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(url)).ok) break; } catch {} await new Promise(r => setTimeout(r, 50)); }
  // One browser's run is stopped after five minutes, naming the step it was in.
  const limited = work => { let timer; return Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('The run did not finish; it was in step ' + lastStep)), 300000); })]).finally(() => clearTimeout(timer)); };
  // E2E_ONLY=webkit (or chromium) runs one of the two, for a closer look at one engine.
  const only = process.env.E2E_ONLY;
  if (only !== 'webkit') await limited(run('chromium', chromium, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }));
  // Safari's engine with the iPhone profile, where it is installed (CI installs Chromium only).
  let safari = only !== 'chromium';
  if (safari) try { await (await webkit.launch()).close(); } catch (error) { safari = false; console.log('SKIP WebKit with the iPhone profile: that browser is not installed here'); }
  if (safari) await limited(run('webkit', webkit, devices['iPhone 14']));
  assert.deepEqual(errors, []);
} catch (error) {
  // The failure first: a browser that will not close must not hide it.
  console.error(error);
  console.error('Server log (last lines):\n' + serverLog.split('\n').slice(-15).join('\n'));
  if (browser) console.error('Pages:', await Promise.all(browser.contexts().flatMap(context => context.pages()).map(page => page.evaluate(() => ({ url: location.href, status: document.querySelector('#save-status')?.textContent, title: document.querySelector('#save-status')?.title, bar: document.querySelector('.fd-save span')?.textContent, review: !!document.querySelector('dialog[open]') })).catch(() => null))));
  process.exitCode = 1;
} finally {
  // Bounded clean-up: a stuck page or server fails this suite in seconds, not at the CI job limit.
  const bounded = (promise, ms) => Promise.race([promise, new Promise(r => setTimeout(r, ms))]);
  if (browser) await bounded(browser.close(), 20000);
  const exited = child.exitCode !== null ? Promise.resolve() : new Promise(r => child.once('exit', r));
  child.kill(); await bounded(exited, 10000); if (child.exitCode === null) child.kill('SIGKILL');
  await rm(state, { recursive: true, force: true });
}
