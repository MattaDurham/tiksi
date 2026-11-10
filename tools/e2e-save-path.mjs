// The save path of the Mac's project files, as a person meets it: a SketchUp save arriving
// under an open page, a transfer that stalls or takes long, and a save the Mac refuses.
// One private server on a free port; every project is synthetic and lives in a temporary folder.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { chromium } from 'playwright';

const state = await mkdtemp(tmpdir() + '/tiksi-save-path-');
const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r));
const port = socket.address().port; await new Promise(r => socket.close(r));
const child = spawn('python3', ['tools/serve.py', '--port', String(port), '--state-dir', state, '--projects-dir', state + '/projects'], { stdio: ['ignore', 'pipe', 'pipe'] });
// Read the server's output: an unread pipe fills and then every server thread stops at its next log line.
let serverLog = ''; child.stdout.resume(); child.stderr.on('data', d => { serverLog = (serverLog + d).slice(-8000); });
const url = 'http://127.0.0.1:' + port;
const SAVED = () => document.querySelector('#save-status').textContent === 'SAVED TO DISK';
let browser;

// The Mac's own copy, read the way a second device would read it.
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
async function openPage(context, hash = '') {
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(url + '/' + hash);
  await page.waitForFunction(SAVED);
  return page;
}
const errors = [];

// A SketchUp save is read back and merged while PLAN is open. An edit then made in that same
// open page must reach the Mac, not vanish into the record the page was built with.
async function sketchupSaveUnderAnOpenPage() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  // Stand in for SketchUp: the conversion service says it is installed, writes a small file
  // for the model, and reads it back as whatever `skpHolds` says the model now contains.
  let skpHolds = { walls: [] }, writes = 0;
  await context.route('**/api/model-conversion/capabilities', route => route.fulfill({ json: { token: 'synthetic', mirror: true, openSketchUp: true } }));
  await context.route('**/api/model-conversion/mirror', route => {
    const op = route.request().headers()['x-mirror-op'];
    if (op === 'read') return route.fulfill({ json: skpHolds });
    return route.fulfill({ contentType: 'application/octet-stream', body: Buffer.from('synthetic model, write ' + (++writes)) });
  });
  const page = await openPage(context);
  const made = await page.evaluate(async () => {
    const store = await import('/js/store.js'); window.saveTestStore = store;
    const p = store.propertyTemplate('Mirror under an open page'); p.id = 'prop-open-page'; const L = p.levels[0].id;
    const wall = (id, ax, ay, bx, by) => ({ id, level: L, ax, ay, bx, by, thickness: 0.114, height: null, material: 'mat-drywall' });
    p.walls.push(wall('w-s', 0, 0, 5, 0), wall('w-e', 5, 0, 5, 3.5), wall('w-n', 5, 3.5, 0, 3.5), wall('w-w', 0, 3.5, 0, 0));
    store.ws.data.properties.push(p); store.ws.data.settings.activePropertyId = p.id; store.touch();
    const disk = (await import('/js/disk-workspace.js')).diskWorkspace;
    await disk.sync(); await disk.syncSketchUp(p);
    const east = (await import('/js/sketchup-mirror.js')).elementState(p).get('w-e').params;
    return { path: disk.paths[p.id], level: L, east };
  });
  assert(writes > 0, 'the model file was written beside the project');
  await page.goto(url + '/#/plan');
  await page.locator('[data-prop-name]').waitFor();
  // "Save in SketchUp": the east wall is now half a metre further east, and the file changed.
  skpHolds = { model: { propertyId: 'prop-open-page', elements: {} }, walls: [{ id: 'w-e', level: made.level, base: made.east, now: { ...made.east, ax: 5.5, bx: 5.5 }, openings: [] }] };
  await writeFile(made.path.replace(/\.tiksi$/i, '.skp'), 'synthetic model, saved in SketchUp with a moved wall');
  await page.waitForFunction(() => window.saveTestStore.ws.data.properties.find(p => p.id === 'prop-open-page')?.walls.find(w => w.id === 'w-e')?.ax === 5.5, null, { timeout: 40000 });
  // The person keeps working in the page that was already open.
  await page.locator('[data-prop-name]').fill('Renamed after the SketchUp save');
  await page.locator('[data-prop-name]').blur();
  await page.waitForFunction(SAVED);
  await page.evaluate(async () => (await import('/js/disk-workspace.js')).diskWorkspace.sync());
  const saved = (await onTheMac()).data.properties.find(p => p.id === 'prop-open-page');
  assert.equal(saved.walls.find(w => w.id === 'w-e').ax, 5.5, 'the SketchUp move is on the Mac');
  assert.equal(saved.name, 'Renamed after the SketchUp save', 'an edit made in the already-open page after the SketchUp save reaches the Mac');
  await context.close();
  console.log('ok   an open PLAN page keeps saving after a SketchUp save is merged');
}

// A file transfer has no limit on its whole duration, only on how long nothing moves; and a
// round that failed part-way sends again only what the Mac does not hold.
async function transfersTakeAsLongAsTheyNeed() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await openPage(context);
  // Nothing moving for 1.5 seconds is a stall here, so the check runs in seconds, not minutes.
  const limits = { stallMs: 1500, answerMs: 1500 };
  await page.evaluate(async limits => {
    const store = await import('/js/store.js'); window.saveTestStore = store;
    Object.assign((await import('/js/disk-workspace.js')).transferLimits, limits);
    const p = store.propertyTemplate('Slow link'); p.id = 'prop-slow-link';
    store.ws.data.properties.push(p); store.ws.data.settings.activePropertyId = p.id; store.touch();
    await (await import('/js/disk-workspace.js')).diskWorkspace.sync();
    window.addOriginal = async (id, size, fill) => {
      const bytes = new Uint8Array(size); for (let i = 0; i < size; i += 251) bytes[i] = (i * 31 + fill) & 255;
      await store.putFile(id, bytes.buffer, { kind: 'photo', mime: 'image/jpeg', name: id + '.jpg' });
      store.ws.data.properties.find(p => p.id === 'prop-slow-link').photos.push({ id, name: id, thumb: '', notes: '', kind: 'photo' });
    };
    window.addOriginalAgain = async (id, size, fill) => {
      const bytes = new Uint8Array(size); for (let i = 0; i < size; i += 251) bytes[i] = (i * 31 + fill) & 255;
      await store.putFile(id, bytes.buffer, { kind: 'photo', mime: 'image/jpeg', name: id + '.jpg' });
    };
  }, limits);

  // 1. A slow link: 1.2 MB at 200 kB/s takes about six seconds, four times the stall limit.
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: 200 * 1024 });
  const started = Date.now();
  await page.evaluate(async () => { await window.addOriginal('slow-upload', 1200000, 1); window.saveTestStore.touch(); await (await import('/js/disk-workspace.js')).diskWorkspace.sync(); });
  const uploadSeconds = (Date.now() - started) / 1000;
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  assert(uploadSeconds > 2 * limits.stallMs / 1000, 'the slow upload really ran well past the stall limit (' + uploadSeconds + ' s)');
  assert.equal((await onTheMac()).assets['slow-upload']?.size, 1200000, 'an upload that keeps moving finishes, however long it takes');

  // The same for a download, in a second browser that does not have the file yet.
  const other = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const reader = await openPage(other);
  await reader.evaluate(async limits => { Object.assign((await import('/js/disk-workspace.js')).transferLimits, limits); }, limits);
  const otherCdp = await other.newCDPSession(reader);
  await otherCdp.send('Network.enable');
  await otherCdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: 200 * 1024, uploadThroughput: -1 });
  const downloadStarted = Date.now();
  const got = await reader.evaluate(async () => { const file = await (await import('/js/store.js')).getFile('slow-upload'); const b = new Uint8Array(file.buffer); return { size: b.length, sample: b[251 * 4000] }; });
  const downloadSeconds = (Date.now() - downloadStarted) / 1000;
  assert(downloadSeconds > 2 * limits.stallMs / 1000, 'the slow download really ran well past the stall limit (' + downloadSeconds + ' s)');
  assert.deepEqual(got, { size: 1200000, sample: (251 * 4000 * 31 + 1) & 255 }, 'a download that keeps arriving finishes with every byte');
  await other.close();

  // 2. Two new originals; the Mac never answers the second upload. The page gives that
  // request up once nothing has moved for the stall limit, and says so.
  const uploads = [];   // the size of every original the page sends
  let hang = true, release;
  const hung = new Promise(r => { release = r; });
  await page.route('**/api/workspace/blobs', async route => {
    const size = route.request().postDataBuffer()?.length;
    uploads.push(size);
    if (hang && size === 70000) { await hung; return route.abort().catch(() => {}); }
    return route.continue();
  });
  await page.evaluate(async () => { await window.addOriginal('first-of-two', 60000, 2); await window.addOriginal('second-of-two', 70000, 3); window.saveTestStore.touch(); });
  await page.waitForFunction(() => /^NOT SAVED/.test(document.querySelector('#save-status').textContent), null, { timeout: 20000 });
  assert.deepEqual(uploads.slice(0, 2), [60000, 70000], 'both originals were sent in the first round');
  assert.equal((await onTheMac()).assets['first-of-two'], undefined, 'the round that stalled saved nothing yet');
  // 3. The link comes back. The first original reached the Mac in the failed round: it is not sent again.
  hang = false; release();
  await page.waitForFunction(SAVED, null, { timeout: 20000 });
  const mac = await onTheMac();
  assert.equal(mac.assets['first-of-two']?.size, 60000); assert.equal(mac.assets['second-of-two']?.size, 70000);
  assert.equal(uploads.filter(size => size === 60000).length, 1, 'an original the Mac already holds is not uploaded again (uploads: ' + uploads.join(', ') + ')');
  await page.unroute('**/api/workspace/blobs');
  // 4. The same original is put again with the very same bytes. There is nothing new for the
  // Mac to write, and the page must not go on saying it is saving.
  await page.evaluate(async () => { await window.addOriginalAgain('first-of-two', 60000, 2); });
  await page.waitForFunction(SAVED, null, { timeout: 20000 });
  assert.equal(await page.evaluate(async () => (await import('/js/disk-workspace.js')).diskWorkspace.pending), false, 'an original put again unchanged does not stay unsaved');
  await context.close();
  console.log('ok   slow transfers finish (upload ' + uploadSeconds.toFixed(1) + ' s, download ' + downloadSeconds.toFixed(1) + ' s against a ' + limits.stallMs / 1000 + ' s stall limit); a stalled round resends only what the Mac lacks');
}

// A save the Mac refuses for good reads differently from one that is being retried, says
// why, and is not sent again and again. A lost connection with nothing to save is not
// reported as unsaved work.
async function refusedAndRetriedSavesReadDifferently() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await openPage(context);
  const statusLine = () => page.evaluate(() => { const el = document.querySelector('#save-status'); return { text: el.textContent, kind: el.dataset.saveState, detail: el.title }; });
  const puts = []; page.on('request', r => { if (r.method() === 'PUT' && new URL(r.url()).pathname === '/api/workspace') puts.push(Date.now()); });
  await page.evaluate(async () => {
    const store = await import('/js/store.js'); window.saveTestStore = store;
    const p = store.propertyTemplate('Refusals'); p.id = 'prop-refusals';
    store.ws.data.properties.push(p); store.ws.data.settings.activePropertyId = p.id; store.touch();
    await (await import('/js/disk-workspace.js')).diskWorkspace.sync();
  });

  // 1. The Mac really refuses this one: its records come to more than the 32 MB it accepts.
  puts.length = 0;
  await page.evaluate(() => { window.saveTestStore.ws.data.properties.find(p => p.id === 'prop-refusals').notes = 'n'.repeat(33 * 1024 * 1024); window.saveTestStore.touch(); });
  await page.waitForFunction(() => document.querySelector('#save-status').dataset.saveState === 'refused', null, { timeout: 60000 });
  const refused = await statusLine();
  assert.match(refused.text, /^NOT SAVED: .*32 MB/, 'the status line gives the Mac\'s own reason');
  assert.doesNotMatch(refused.text, /RETRYING/, 'a refused save does not claim to be retrying');
  const sentBefore = puts.length;
  await page.waitForTimeout(9000);   // more than three of the old 2.5 s retries
  assert.equal(puts.length, sentBefore, 'a save the Mac refused is not sent again by itself');
  assert.equal((await statusLine()).kind, 'refused');
  // Another part of the app writes its own message on the line (an export does). The refusal
  // must come back by itself: it is still the state of this page's work.
  await page.evaluate(() => window.saveTestStore.setSaveStatus('EXPORTED 3 FILES', false));
  await page.waitForFunction(() => document.querySelector('#save-status').dataset.saveState === 'refused' && /^NOT SAVED: /.test(document.querySelector('#save-status').textContent), null, { timeout: 10000 });
  assert.equal(puts.length, sentBefore, 'showing the refusal again sends nothing');
  // Putting it right is an edit, and an edit is tried at once.
  await page.evaluate(() => { window.saveTestStore.ws.data.properties.find(p => p.id === 'prop-refusals').notes = 'Short again'; window.saveTestStore.touch(); });
  await page.waitForFunction(SAVED, null, { timeout: 60000 });
  assert.equal((await onTheMac()).data.properties.find(p => p.id === 'prop-refusals').notes, 'Short again');
  assert.equal((await statusLine()).kind, 'saved');

  // 2. The Mac cannot be reached and there is nothing to save: not unsaved work, no
  // "leave page?" question, and no extra save when the connection returns.
  puts.length = 0;
  await context.setOffline(true);
  await page.waitForFunction(() => document.querySelector('#save-status').dataset.saveState === 'waiting', null, { timeout: 20000 });
  const idle = await statusLine();
  assert.match(idle.text, /CANNOT REACH THE MAC/); assert.doesNotMatch(idle.text, /NOT SAVED/, 'nothing was unsaved');
  // What the leave-page question and the dot on FILE both go by.
  const unsaved = () => page.evaluate(async () => (await import('/js/disk-workspace.js')).diskWorkspace.pending);
  assert.equal(await unsaved(), false, 'a lost connection alone is not unsaved work, so nothing asks to stay on the page');
  // 3. An edit while unreachable: now it is unsaved, it is being retried, and it says why.
  await page.evaluate(() => { window.saveTestStore.ws.data.properties.find(p => p.id === 'prop-refusals').notes = 'Written while the Mac was away'; window.saveTestStore.touch(); });
  await page.waitForFunction(() => /^NOT SAVED TO DISK — RETRYING/.test(document.querySelector('#save-status').textContent), null, { timeout: 20000 });
  const retrying = await statusLine();
  assert.match(retrying.text, /CANNOT REACH THE MAC/); assert.equal(retrying.kind, 'waiting');
  assert.notEqual(retrying.kind, refused.kind, 'retrying and refused are different states');
  assert.equal(await unsaved(), true, 'an edit the Mac has not got is unsaved work');
  await context.setOffline(false);
  await page.waitForFunction(SAVED, null, { timeout: 20000 });
  assert.equal((await onTheMac()).data.properties.find(p => p.id === 'prop-refusals').notes, 'Written while the Mac was away');
  // 4. Unreachable again with nothing to save, then back: the line returns to saved without a save.
  puts.length = 0;
  await context.setOffline(true);
  await page.waitForFunction(() => document.querySelector('#save-status').dataset.saveState === 'waiting', null, { timeout: 20000 });
  await context.setOffline(false);
  await page.waitForFunction(SAVED, null, { timeout: 20000 });
  assert.equal(puts.length, 0, 'a connection that dropped and returned with nothing to save sends no save');
  // 5. The Mac answers that a project file cannot be read just now (another program is still
  // writing it). That passes by itself, so the save is tried again without anyone touching it.
  let unreadable = 1;
  await page.route('**/api/workspace', route => route.request().method() === 'PUT' && unreadable-- > 0
    ? route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: 'A project file cannot be read; its original has been preserved' }) }) : route.continue());
  await page.evaluate(() => { window.saveTestStore.ws.data.properties.find(p => p.id === 'prop-refusals').notes = 'Saved once the file could be read'; window.saveTestStore.touch(); });
  await untilOnTheMac(mac => mac.data.properties.find(p => p.id === 'prop-refusals').notes === 'Saved once the file could be read', 'A save first answered with "cannot be read"');
  await page.waitForFunction(SAVED, null, { timeout: 20000 });
  await page.unroute('**/api/workspace');

  // 6. The Mac will not take a save that carries a new original. The first round fails on
  // the way; the second counts on the original it already uploaded and is refused, so the
  // original is uploaded once more; the third is refused again and that is the answer. It
  // must then read as refused, and stop uploading.
  let seen = 0;
  const originals = [];
  await page.route('**/api/workspace', route => {
    if (route.request().method() !== 'PUT') return route.continue();
    return ++seen === 1 ? route.abort() : route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic: the Mac will not take these records' }) });
  });
  page.on('request', r => { if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/workspace/blobs' && r.postDataBuffer()?.length === 64000) originals.push(Date.now()); });
  await page.evaluate(async () => {
    const store = window.saveTestStore, bytes = new Uint8Array(64000); for (let i = 0; i < bytes.length; i += 97) bytes[i] = i & 255;
    await store.putFile('refused-original', bytes.buffer, { kind: 'photo', mime: 'image/jpeg', name: 'Refused.jpg' });
    store.ws.data.properties.find(p => p.id === 'prop-refusals').photos.push({ id: 'refused-original', name: 'Refused', thumb: '', notes: '', kind: 'photo' }); store.touch();
  });
  await page.waitForFunction(() => document.querySelector('#save-status').dataset.saveState === 'refused', null, { timeout: 60000 });
  assert.match((await statusLine()).text, /^NOT SAVED: Synthetic/, 'a refusal that repeats after the originals were sent again reads as refused');
  assert.equal(originals.length, 2, 'the original was uploaded once, and once more after the first refusal');
  const putsThen = seen;
  await page.waitForTimeout(7000);
  assert.equal(originals.length, 2, 'a refused save does not go on uploading its originals'); assert.equal(seen, putsThen, 'and is not sent again');
  await page.unroute('**/api/workspace');
  await context.close();
  console.log('ok   a refused save says why, stops and stays visible; a retried one says it is retrying; "cannot be read" passes by itself; a dropped connection alone is not unsaved work');
}

try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(url)).ok) break; } catch {} await new Promise(r => setTimeout(r, 50)); }
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  await sketchupSaveUnderAnOpenPage();
  await transfersTakeAsLongAsTheyNeed();
  await refusedAndRetriedSavesReadDifferently();
  assert.deepEqual(errors, []);
} catch (error) {
  // The failure first: a browser that will not close must not hide it.
  console.error(error);
  console.error('Server log (last lines):\n' + serverLog.split('\n').slice(-15).join('\n'));
  if (browser) console.error('Pages:', await Promise.all(browser.contexts().flatMap(context => context.pages()).map(page => page.evaluate(() => ({ url: location.href, status: document.querySelector('#save-status')?.textContent, title: document.querySelector('#save-status')?.title, review: !!document.querySelector('dialog[open]') })).catch(() => null))));
  process.exitCode = 1;
} finally {
  // Bounded clean-up: a stuck page or server fails this suite in seconds, not at the CI job limit.
  const bounded = (promise, ms) => Promise.race([promise, new Promise(r => setTimeout(r, ms))]);
  if (browser) await bounded(browser.close(), 20000);
  const exited = child.exitCode !== null ? Promise.resolve() : new Promise(r => child.once('exit', r));
  child.kill(); await bounded(exited, 10000); if (child.exitCode === null) child.kill('SIGKILL');
  await rm(state, { recursive: true, force: true });
}
