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
  await context.close();
  console.log('ok   slow transfers finish (upload ' + uploadSeconds.toFixed(1) + ' s, download ' + downloadSeconds.toFixed(1) + ' s against a ' + limits.stallMs / 1000 + ' s stall limit); a stalled round resends only what the Mac lacks');
}

try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(url)).ok) break; } catch {} await new Promise(r => setTimeout(r, 50)); }
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  await sketchupSaveUnderAnOpenPage();
  await transfersTakeAsLongAsTheyNeed();
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
