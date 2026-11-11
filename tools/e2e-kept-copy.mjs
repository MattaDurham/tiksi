// The copy a phone keeps of what the Mac has not confirmed, at its edges: an original that
// could not be kept, two pages open on one device, a kept copy that takes minutes to send,
// browser storage that cannot be read, and a bar narrow enough to cut its words off.
// Runs in Chromium with a phone profile, and also in WebKit (Safari's engine) with the
// iPhone profile where that browser is installed. One private server on a free port; every
// project is synthetic and lives in a temporary folder.
// E2E_ONLY=webkit|chromium runs one engine; E2E_STEP=originals|pages|start|unreadable|bar runs one part.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { chromium, webkit, devices } from 'playwright';

const state = await mkdtemp(tmpdir() + '/tiksi-kept-copy-');
const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r));
const port = socket.address().port; await new Promise(r => socket.close(r));
const child = spawn('python3', ['tools/serve.py', '--port', String(port), '--state-dir', state, '--projects-dir', state + '/projects'], { stdio: ['ignore', 'pipe', 'pipe'] });
// Read the server's output: an unread pipe fills and then every server thread stops at its next log line.
let serverLog = ''; child.stdout.resume(); child.stderr.on('data', d => { serverLog = (serverLog + d).slice(-8000); });
const url = 'http://127.0.0.1:' + port;
const SAVED = () => document.querySelector('#save-status').textContent === 'SAVED TO DISK';
const KEPT = () => /kept on this device/.test(document.querySelector('#save-status').title);
const errors = [];
let browser, lastStep = 'start';
const step = text => { lastStep = text; if (process.env.E2E_TRACE) console.log('  .. ' + text); };

// The Mac's own copy, read the way another device would read it.
async function onTheMac() {
  const auth = { 'X-Tiksi-Workspace': '1' };
  auth['X-Tiksi-Token'] = (await (await fetch(url + '/api/workspace/capabilities', { headers: auth })).json()).token;
  return (await fetch(url + '/api/workspace', { headers: auth })).json();
}
async function untilOnTheMac(check, what, ms = 20000) {
  for (const end = Date.now() + ms; ;) {
    const mac = await onTheMac();
    if (check(mac)) return mac;
    if (Date.now() > end) assert.fail(what + ' did not reach the Mac within ' + ms / 1000 + ' s');
    await new Promise(r => setTimeout(r, 150));
  }
}
async function openPage(context, { hash = '#/photos', ready = SAVED, before } = {}) {
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  if (before) await before(page);
  await page.goto(url + '/' + hash);
  if (ready) await page.waitForFunction(ready, null, { timeout: 60000 });
  return page;
}
// A property made straight on the Mac's copy by a desktop page, for one part of the suite.
async function makeProperty(id) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await openPage(context, { hash: '' });
  await page.evaluate(async id => {
    const store = await import('/js/store.js');
    const p = store.propertyTemplate('Site visit ' + id); p.id = id; p.notes = 'As the Mac has it';
    // Its one-pager is written by hand, so no page rewrites the draft when it opens: two
    // pages drafting the same text at different moments would differ in the draft's time.
    (await import('/js/one-pager.js')).draftOnePager(p, store.ws.data); p.onePager.customized = true;
    store.ws.data.properties.push(p); store.ws.data.settings.activePropertyId = id; store.touch();
    await (await import('/js/disk-workspace.js')).diskWorkspace.sync();
  }, id);
  await context.close();
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
const prop = (mac, id) => mac.data.properties.find(p => p.id === id);
const bar = page => page.evaluate(() => ({ state: document.querySelector('.fd-save').dataset.state, label: document.querySelector('.fd-save span').textContent }));
// A photo of about `size` bytes: a real small PNG followed by noise, which still opens as a picture.
const addPhoto = (page, id, name, size) => page.evaluate(async ([id, name, size]) => {
  const store = await import('/js/store.js'), { addPhotoFromFile } = await import('/js/photos-store.js');
  const canvas = document.createElement('canvas'); canvas.width = 80; canvas.height = 60; canvas.getContext('2d').fillRect(0, 0, 80, 60);
  const png = new Uint8Array(await (await new Promise(r => canvas.toBlob(r, 'image/png'))).arrayBuffer());
  const noise = new Uint8Array(Math.max(0, size - png.length)); for (let i = 0; i < noise.length; i++) noise[i] = (i * 7919 + (i >> 5) + name.length) & 255;
  const file = new File([png, noise], name, { type: 'image/png' });
  const rec = await addPhotoFromFile(store.ws.data.properties.find(p => p.id === id), file);
  return { id: rec.id, size: file.size };
}, [id, name, size]);
const setLimit = (page, bytes) => page.evaluate(async bytes => { (await import('/js/unsent.js')).keptLimits.maxFileBytes = bytes; }, bytes);
const edit = (page, id, change) => page.evaluate(async ([id, change]) => {
  const store = await import('/js/store.js');
  Object.assign(store.ws.data.properties.find(p => p.id === id), change); store.touch();
}, [id, change]);
const addRoom = (page, id, roomId, name) => page.evaluate(async ([id, roomId, name]) => {
  const store = await import('/js/store.js'), p = store.ws.data.properties.find(p => p.id === id);
  p.rooms.push({ id: roomId, level: p.levels[0].id, name, pts: [[0, 0], [4, 0], [4, 3], [0, 3]], material: 'mat-oak', ceilingMaterial: null }); store.touch();
}, [id, roomId, name]);
const room = (mac, id, roomId) => prop(mac, id).rooms.find(r => r.id === roomId);

// An original that could not be kept exists only in the open page. The bar must say so, an
// original is tried again with every kept copy, and one that did not survive is named.
async function originalsThatWereNotKept(name, profile) {
  step('originals');
  const id = 'prop-originals-' + name; await makeProperty(id);
  const context = await browser.newContext({ ...profile });
  let phone = await openPage(context);
  await look(phone, id);
  // Stand in for a video too large to copy into the phone's storage: nothing over 30 kB is kept.
  await setLimit(phone, 30000);
  await context.setOffline(true);
  const large = await addPhoto(phone, id, 'Large original.png', 60000);
  await addPhoto(phone, id, 'Small original.png', 3000);
  await phone.waitForFunction(() => document.querySelector('.fd-save span').textContent === 'Keep open', null, { timeout: 20000 });
  await phone.waitForFunction(KEPT, null, { timeout: 20000 });
  let words = await phone.evaluate(() => document.querySelector('#save-status').title);
  assert.match(words, /Large original\.png is only in this open page.*keep this page open/, 'the status says which original exists only in the open page');
  assert.doesNotMatch(words, /Small original/, 'an original that was kept is not listed');
  assert.doesNotMatch(words, /What changed here is kept on this device/, 'it does not claim that everything is kept');
  await phone.locator('.fd-save').click();
  assert.match(await phone.locator('.fd-save-note').textContent(), /Large original\.png is only in this open page/, 'a tap on the bar gives the same words');
  // The storage has room after all (or the write that failed now succeeds): the next kept
  // copy takes the original with it, and the bar stops asking to keep the page open.
  await setLimit(phone, 100 * 1024 * 1024);
  await edit(phone, id, { notes: 'Typed after the original could be kept' });
  await phone.waitForFunction(() => document.querySelector('.fd-save span').textContent === 'Waiting', null, { timeout: 20000 });
  assert.doesNotMatch(await phone.evaluate(() => document.querySelector('#save-status').title), /only in this open page/);
  await phone.close();
  await context.setOffline(false);
  phone = await openPage(context);
  let mac = await untilOnTheMac(m => m.assets[large.id], 'An original kept on the second try');
  assert.equal(mac.assets[large.id].size, large.size, 'an original kept on the second try reaches the Mac after the tab was dropped');
  await phone.waitForFunction(SAVED, null, { timeout: 30000 });
  // An original that never could be kept, and the tab is dropped: its record arrives without
  // a file. The next open says so, by name.
  await setLimit(phone, 30000);
  await context.setOffline(true);
  const lost = await addPhoto(phone, id, 'Lost original.png', 60000);
  await phone.waitForFunction(() => document.querySelector('.fd-save span').textContent === 'Keep open', null, { timeout: 20000 });
  await phone.waitForFunction(KEPT, null, { timeout: 20000 });
  await phone.close();
  await context.setOffline(false);
  phone = await openPage(context, { ready: null });
  const notice = phone.locator('dialog[data-lost-originals]');
  await notice.waitFor({ timeout: 30000 });
  assert.match(await notice.textContent(), /Lost original\.png/, 'the next open names the original that did not survive');
  await notice.getByRole('button', { name: 'OK' }).click();
  mac = await untilOnTheMac(m => prop(m, id).photos.some(p => p.id === lost.id), 'The record of the original that was lost');
  assert.equal(mac.assets[lost.id], undefined);
  await context.close();
}

// A page sends an earlier page's kept copy and goes on to keep its own changes. Another page
// opened meanwhile sends what it found, and must not clear what the first page kept since.
async function twoPagesKeepTheirOwn(name, profile) {
  step('pages');
  const id = 'prop-pages-' + name; await makeProperty(id);
  const context = await browser.newContext({ ...profile });
  const first = await openPage(context);
  await look(first, id);
  await context.setOffline(true);
  await edit(first, id, { notes: 'From the page that was dropped' });
  await first.waitForFunction(KEPT, null, { timeout: 20000 });
  await first.close();
  await context.setOffline(false);
  // The second page cannot get a save through, and does not answer other pages: it is as a
  // page frozen in the background is.
  const second = await openPage(context, { ready: null, before: async page => {
    await page.addInitScript(() => { BroadcastChannel.prototype.postMessage = () => {}; });
    await page.route('**/api/workspace', route => route.request().method() === 'PUT' ? route.abort() : route.continue());
  } });
  await second.waitForFunction(KEPT, null, { timeout: 30000 });
  await addRoom(second, id, 'room-two', 'Added in the second page');
  await second.waitForTimeout(700);
  // The third page opens, takes up what it finds, and its save is held for a moment.
  let release, held;
  const sending = new Promise(r => { held = r; }), go = new Promise(r => { release = r; });
  const third = await openPage(context, { ready: null, before: page => page.route('**/api/workspace', async route => {
    if (route.request().method() !== 'PUT') return route.continue();
    held(); await go; return route.continue();
  }) });
  await sending;
  // Meanwhile the second page keeps one more change.
  await addRoom(second, id, 'room-three', 'Added in the second page, later');
  await second.waitForTimeout(700);
  release();
  await untilOnTheMac(m => room(m, id, 'room-two'), 'What the third page found kept');
  await third.waitForFunction(SAVED, null, { timeout: 30000 });
  await third.waitForTimeout(500);
  // The second page is dropped without ever getting through. The next page sends its last change.
  await second.close(); await third.close();
  const fourth = await openPage(context, { ready: null });
  const mac = await untilOnTheMac(m => room(m, id, 'room-three'), 'A change one page kept while another page was sending its earlier copy');
  assert.equal(prop(mac, id).notes, 'From the page that was dropped');
  await fourth.waitForFunction(SAVED, null, { timeout: 30000 });
  await context.close();
}

// A kept copy with originals takes as long to send as the link allows. The app opens on the
// kept records at once and says it is sending them; it does not sit empty until they are sent.
async function theAppOpensWhileTheKeptCopyIsSent(name, profile) {
  step('start');
  const id = 'prop-start-' + name; await makeProperty(id);
  const context = await browser.newContext({ ...profile });
  let phone = await openPage(context);
  await look(phone, id);
  await context.setOffline(true);
  const photo = await addPhoto(phone, id, 'Slow to send.png', 90000);
  await phone.waitForFunction(KEPT, null, { timeout: 20000 });
  await phone.close();
  await context.setOffline(false);
  // The original's upload does not finish until the check lets it.
  let release; const go = new Promise(r => { release = r; });
  let uploading = false;
  await context.route('**/api/workspace/blobs', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const body = route.request().postDataBuffer();
    if (body && body.length !== photo.size) return route.continue();
    uploading = true; await go; return route.continue();
  });
  phone = await openPage(context, { ready: null });
  await phone.locator('.fd-bar').waitFor({ state: 'attached', timeout: 20000 });
  await phone.getByRole('button', { name: /Slow to send/ }).waitFor({ timeout: 20000 });
  await phone.waitForFunction(() => document.querySelector('#save-status').textContent === 'SENDING WHAT THIS DEVICE KEPT', null, { timeout: 20000 });
  assert.equal((await bar(phone)).label, 'Sending');
  // The page first asks the Mac which originals it holds, so the upload starts a moment after the status shows.
  for (let i = 0; i < 200 && !uploading; i++) await new Promise(r => setTimeout(r, 100));
  assert.equal(uploading, true, 'the original was still on its way while the app was open');
  assert.equal((await onTheMac()).assets[photo.id], undefined, 'and had not reached the Mac yet');
  release();
  const mac = await untilOnTheMac(m => m.assets[photo.id], 'The kept photo, once its upload could finish');
  assert.equal(mac.assets[photo.id].size, photo.size);
  await phone.waitForFunction(SAVED, null, { timeout: 30000 });
  await context.close();
}

// Browser storage that cannot be read is not storage with nothing in it. A wide window, which
// keeps nothing itself, must leave what a narrow window kept exactly where it is.
async function unreadableStorageIsLeftAlone(name) {
  step('unreadable');
  const id = 'prop-unreadable-' + name; await makeProperty(id);
  // A computer, not a phone: a narrow window keeps what is unsent, a wide one does not.
  const context = await browser.newContext({ viewport: { width: 390, height: 800 } });
  const narrow = await openPage(context);
  await look(narrow, id);
  await context.setOffline(true);
  await edit(narrow, id, { notes: 'Kept by the narrow window' });
  await narrow.waitForFunction(KEPT, null, { timeout: 20000 });
  await narrow.close();
  await context.setOffline(false);
  // The same browser, wide now, at a moment when the kept copies cannot be read.
  const wide = await openPage(context, { hash: '', before: async page => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.addInitScript(() => { IDBObjectStore.prototype.getAll = () => { throw new DOMException('Synthetic: the storage cannot be read', 'UnknownError'); }; });
  } });
  await wide.waitForTimeout(1500);
  assert.equal(prop(await onTheMac(), id).notes, 'As the Mac has it', 'nothing was sent from storage that could not be read');
  await wide.close();
  // Readable again: what was kept is still there, and is sent.
  const again = await openPage(context, { ready: null });
  await untilOnTheMac(m => prop(m, id).notes === 'Kept by the narrow window', 'What the narrow window kept, after a wide window could not read the storage');
  await again.waitForFunction(SAVED, null, { timeout: 30000 });
  await context.close();
}

// On an iPhone's width the bar shows the page name and the save state in full, also on a
// page with UNDO and REDO in the bar.
async function theBarFits(name, profile) {
  step('bar');
  const id = 'prop-bar-' + name; await makeProperty(id);
  for (const width of [375, 390]) {
    const context = await browser.newContext({ ...profile, viewport: { width, height: 667 } });
    const phone = await openPage(context, { hash: '#/plan' });
    await look(phone, id);
    await phone.locator('#btn-undo').waitFor();
    await context.setOffline(true);
    await edit(phone, id, { notes: 'Waiting at ' + width });
    await phone.waitForFunction(() => document.querySelector('.fd-save').dataset.state === 'waiting', null, { timeout: 20000 });
    const fits = () => phone.evaluate(() => {
      const whole = el => el.scrollWidth <= el.clientWidth, barEl = document.querySelector('.fd-bar');
      const last = [...barEl.children].filter(el => el.offsetParent).map(el => el.getBoundingClientRect().right);
      return { label: document.querySelector('.fd-save span').textContent, state: whole(document.querySelector('.fd-save span')), title: whole(document.querySelector('.fd-title')), inside: Math.max(...last) <= window.innerWidth };
    });
    assert.deepEqual(await fits(), { label: 'Waiting', state: true, title: true, inside: true }, 'the waiting state is shown in full at ' + width + ' px');
    // The longest words the bar can show.
    for (const label of ['Not saved', 'Keep open']) {
      await phone.evaluate(label => { document.querySelector('.fd-save span').textContent = label; }, label);
      assert.deepEqual(await fits(), { label, state: true, title: true, inside: true }, '"' + label + '" is shown in full at ' + width + ' px');
    }
    assert.equal(await phone.getByRole('button', { name: /undo/i }).count(), 1, 'UNDO keeps its name for a screen reader');
    await context.close();
  }
}

async function run(name, type, profile) {
  browser = await type.launch(type === chromium ? { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } : {});
  const parts = { originals: originalsThatWereNotKept, pages: twoPagesKeepTheirOwn, start: theAppOpensWhileTheKeptCopyIsSent, unreadable: unreadableStorageIsLeftAlone, bar: theBarFits };
  for (const [key, part] of Object.entries(parts)) if (!process.env.E2E_STEP || process.env.E2E_STEP === key) await part(name, profile);
  await browser.close(); browser = null;
  console.log('ok   ' + name + ': an original that was not kept is named and tried again; two pages keep their own copies; the app opens while a kept copy is sent; unreadable storage is left alone; the bar fits');
}

try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(url)).ok) break; } catch {} await new Promise(r => setTimeout(r, 50)); }
  // One browser's run is stopped after six minutes, naming the part it was in.
  const limited = work => { let timer; return Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('The run did not finish; it was in part ' + lastStep)), 360000); })]).finally(() => clearTimeout(timer)); };
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
  if (browser) console.error('Pages:', await Promise.all(browser.contexts().flatMap(context => context.pages()).map(page => page.evaluate(() => ({ url: location.href, status: document.querySelector('#save-status')?.textContent, title: document.querySelector('#save-status')?.title, bar: document.querySelector('.fd-save span')?.textContent, dialog: document.querySelector('dialog[open]')?.textContent?.slice(0, 120) })).catch(() => null))));
  process.exitCode = 1;
} finally {
  // Bounded clean-up: a stuck page or server fails this suite in seconds, not at the CI job limit.
  const bounded = (promise, ms) => Promise.race([promise, new Promise(r => setTimeout(r, ms))]);
  if (browser) await bounded(browser.close(), 20000);
  const exited = child.exitCode !== null ? Promise.resolve() : new Promise(r => child.once('exit', r));
  child.kill(); await bounded(exited, 10000); if (child.exitCode === null) child.kill('SIGKILL');
  await rm(state, { recursive: true, force: true });
}
