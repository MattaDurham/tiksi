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

try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(url)).ok) break; } catch {} await new Promise(r => setTimeout(r, 50)); }
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  await sketchupSaveUnderAnOpenPage();
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
