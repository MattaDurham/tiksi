// Two origins/contexts, one private disk workspace. All data is synthetic and temporary.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, rm, readdir, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { chromium } from 'playwright';

const state = await mkdtemp(tmpdir() + '/tiksi-disk-test-');
const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r));
const port = socket.address().port; await new Promise(r => socket.close(r));
const child = spawn('python3', ['tools/serve.py', '--host', '0.0.0.0', '--port', String(port), '--state-dir', state, '--projects-dir', state + '/projects'], { stdio: ['ignore', 'pipe', 'pipe'] });
let browser, releaseDownload;
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch('http://127.0.0.1:' + port)).ok) break; } catch {} await new Promise(r => setTimeout(r, 50)); }
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const desktopContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const desktop = await desktopContext.newPage(), phone = await phoneContext.newPage();
  const errors = []; for (const page of [desktop, phone]) page.on('pageerror', e => errors.push(e.message));
  await desktop.goto('http://127.0.0.1:' + port);
  await desktop.waitForFunction(() => document.querySelector('#save-status').textContent === 'SAVED TO DISK');
  await desktop.evaluate(async () => {
    const s = await import('/js/store.js'); window.diskTestStore = s;
    const a = s.propertyTemplate('Synthetic apartment'), b = s.propertyTemplate('Synthetic garden'); a.id = 'prop-apartment'; b.id = 'prop-garden';
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZQAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
    await s.putFile('photo-shared', png.buffer, { kind: 'photo', mime: 'image/png', name: 'Synthetic.png' });
    a.photos.push({ id: 'photo-shared', name: 'Shared evidence', thumb: 'data:image/png;base64,' + btoa(String.fromCharCode(...png)), notes: '', kind: 'photo' });
    s.ws.data.properties.push(a, b); s.ws.data.settings.activePropertyId = a.id; s.touch();
    await (await import('/js/disk-workspace.js')).diskWorkspace.sync();
  });
  await phone.goto('http://localhost:' + port + '/#/photos');
  await phone.getByRole('button', { name: /Shared evidence/ }).waitFor();
  const evidence = await phone.evaluate(async () => {
    const s = await import('/js/store.js'), original = await s.getFile('photo-shared');
    return { names: s.ws.data.properties.map(p => p.name), bytes: [...new Uint8Array(original.buffer)], local: localStorage.getItem('tiksi.workspace.v1'), databases: await indexedDB.databases() };
  });
  assert.deepEqual(evidence.names.sort(), ['Synthetic apartment', 'Synthetic garden']); assert.equal(evidence.bytes[0], 137);
  assert.equal(evidence.local, null); assert.equal(evidence.databases.filter(d => d.name === 'tiksi-files').length, 0);
  // Disable persistent browser writes: new edits and original uploads still save to disk.
  await phone.evaluate(async () => {
    Storage.prototype.setItem = () => { throw new Error('Browser persistence prohibited'); };
    indexedDB.open = () => { throw new Error('IndexedDB prohibited'); };
    const s = await import('/js/store.js'); s.ws.data.properties.find(p => p.id === 'prop-garden').notes = 'Edited on the phone'; s.touch();
    await (await import('/js/disk-workspace.js')).diskWorkspace.sync();
  });
  await desktop.waitForFunction(() => window.diskTestStore.ws.data.properties.find(p => p.id === 'prop-garden')?.notes === 'Edited on the phone');
  // Same-field offline edits must be reviewed, while an unrelated addition is retained.
  await phoneContext.setOffline(true);
  await phone.evaluate(async () => { const s = await import('/js/store.js'); s.ws.data.properties[0].notes = 'Offline phone edit'; const p = s.propertyTemplate('Offline addition'); p.id = 'prop-offline'; s.ws.data.properties.push(p); s.touch(); });
  await desktop.evaluate(async () => { const s = await import('/js/store.js'); s.ws.data.properties[0].notes = 'Newer Mac edit'; s.touch(); await (await import('/js/disk-workspace.js')).diskWorkspace.sync(); });
  await phoneContext.setOffline(false);
  await phone.getByRole('button', { name: 'USE MAC VALUES', exact: true }).click();
  await phone.waitForFunction(() => document.querySelector('#save-status').textContent === 'SAVED TO DISK');
  await desktop.waitForFunction(() => window.diskTestStore.ws.data.properties.some(p => p.id === 'prop-offline'));
  assert.equal(await phone.evaluate(async () => (await import('/js/store.js')).ws.data.properties[0].notes), 'Newer Mac edit');
  // An older in-flight asset must neither block the new version nor replace its cache.
  const auth = { 'X-Tiksi-Workspace': '1' };
  const capabilities = await (await fetch('http://127.0.0.1:' + port + '/api/workspace/capabilities', { headers: auth })).json();
  auth['X-Tiksi-Token'] = capabilities.token;
  const snapshot = await (await fetch('http://127.0.0.1:' + port + '/api/workspace', { headers: auth })).json();
  const oldHash = snapshot.assets['photo-shared'].hash;
  const slow = await (await browser.newContext()).newPage();
  const delayed = new Promise(resolve => { releaseDownload = resolve; });
  let requested; const requestStarted = new Promise(resolve => { requested = resolve; });
  await slow.route('**/api/workspace/blobs/' + oldHash, async route => { requested(); await delayed; await route.continue(); });
  await slow.goto('http://127.0.0.1:' + port + '/#/photos'); await slow.getByRole('button', { name: /Shared evidence/ }).waitFor();
  await slow.evaluate(async () => { window.diskTestStore = await import('/js/store.js'); window.oldPhotoDownload = window.diskTestStore.getFile('photo-shared'); });
  await requestStarted;
  await desktop.evaluate(async () => {
    const s = await import('/js/store.js'), original = await s.getFile('photo-shared');
    const bytes = new Uint8Array(original.buffer.byteLength + 1); bytes.set(new Uint8Array(original.buffer)); bytes[bytes.length - 1] = 99;
    await s.putFile('photo-shared', bytes.buffer, { kind: 'photo', mime: 'image/png', name: 'Synthetic.png' });
    s.ws.data.properties.find(p => p.id === 'prop-apartment').photos[0].notes = 'Updated original bytes'; s.touch();
    await (await import('/js/disk-workspace.js')).diskWorkspace.sync();
  });
  await slow.waitForFunction(() => window.diskTestStore.ws.data.properties.find(p => p.id === 'prop-apartment')?.photos[0]?.notes === 'Updated original bytes');
  assert.equal(await slow.evaluate(async () => new Uint8Array((await window.diskTestStore.getFile('photo-shared')).buffer).at(-1)), 99);
  releaseDownload(); await slow.evaluate(() => window.oldPhotoDownload);
  assert.equal(await slow.evaluate(async () => new Uint8Array((await window.diskTestStore.getCachedFile('photo-shared')).buffer).at(-1)), 99, 'late old response does not poison the current original');
  // A brand-new browser has no cache or migration state and still sees everything.
  const cleanContext = await browser.newContext();
  await cleanContext.addInitScript(() => {
    for (const method of ['getItem', 'setItem', 'removeItem']) Storage.prototype[method] = () => { throw new Error('Browser storage unavailable'); };
    indexedDB.open = () => { throw new Error('IndexedDB unavailable'); };
  });
  const clean = await cleanContext.newPage(); await clean.goto('http://127.0.0.1:' + port);
  await clean.waitForFunction(() => document.querySelector('#property-select')?.options.length === 3);
  const folders = await readdir(state + '/projects'); assert.equal(folders.length, 3);
  for (const folder of folders) assert((await readdir(state + '/projects/' + folder)).some(n => n.endsWith('.tiksi')));
  const catalog = JSON.parse(await readFile(state + '/workspace/current.json', 'utf8'));
  assert.equal(catalog.data.properties.length, 3);
  // Migrate an older device, including an orphan original, before clearing its
  // browser database. The Mac's newer records and unrelated local project survive.
  const legacyContext = await browser.newContext();
  const legacy = await legacyContext.newPage();
  await legacy.goto('http://127.0.0.1:' + port + '/app-icon.svg');
  await legacy.evaluate(async () => {
    const s = await import('/js/store.js');
    s.replaceWorkspace(s.emptyWorkspace());
    const p = s.propertyTemplate('Legacy device project'); p.id = 'prop-legacy'; s.ws.data.properties.push(p); s.ws.data.settings.activePropertyId = p.id;
    await s.putFile('orphan-original', new Uint8Array([3, 1, 4, 1, 5]).buffer, { name: 'Unreferenced.bin', format: 'bin' });
    await s.whenHydrated(); s.save();
  });
  // A retained document (including a back/forward-cache entry) can keep an IDB
  // connection open. It must release that connection when migration deletes it.
  const legacyReader = await legacyContext.newPage();
  await legacyReader.goto('http://127.0.0.1:' + port + '/app-icon.svg');
  await legacyReader.evaluate(async () => { await (await import('/js/store.js')).storedFileIds(); });
  // A genuinely old build has no versionchange handler. Saving still completes,
  // and cleanup must recover after that older document is closed.
  const oldReader = await legacyContext.newPage();
  await oldReader.goto('http://127.0.0.1:' + port + '/app-icon.svg');
  await oldReader.evaluate(async () => { window.heldLegacyDatabase = await new Promise(resolve => { const request = indexedDB.open('tiksi-files'); request.onsuccess = () => resolve(request.result); }); });
  await legacy.goto('http://127.0.0.1:' + port);
  await legacy.getByRole('button', { name: 'USE MAC VALUES', exact: true }).click();
  await legacy.waitForFunction(() => document.querySelector('#save-status').textContent === 'SAVED TO DISK — CLOSE OLDER TIKSI TABS');
  await oldReader.close();
  await legacy.waitForFunction(() => document.querySelector('#save-status').textContent === 'SAVED TO DISK');
  assert.equal(await legacy.evaluate(() => localStorage.getItem('tiksi.workspace.v1')), null);
  assert.equal(await legacy.evaluate(async () => (await indexedDB.databases()).some(d => d.name === 'tiksi-files')), false);
  const recovery = (await readdir(state + '/workspace/history')).find(n => n.startsWith('browser-migration-'));
  assert(recovery, 'migration recovery bundle exists before browser cleanup');
  const recovered = execFileSync('python3', ['-c', 'import sys,zipfile,json;z=zipfile.ZipFile(sys.argv[1]);m=json.loads(z.read("manifest.json"));e=next(e for e in m["files"] if e["id"]=="orphan-original");print(list(z.read(e["path"])))', state + '/workspace/history/' + recovery]).toString().trim();
  assert.equal(recovered, '[3, 1, 4, 1, 5]');
  assert.equal(await legacy.evaluate(async () => (await import('/js/store.js')).ws.data.properties.length), 4);
  const damaged = await (await browser.newContext()).newPage();
  await damaged.goto('http://127.0.0.1:' + port + '/app-icon.svg');
  await damaged.evaluate(async () => {
    const s = await import('/js/store.js');
    await s.putFile('damaged-orphan', new Uint8Array([2, 7, 1, 8]).buffer, { name: 'Preserved.bin', format: 'bin' });
    localStorage.setItem('tiksi.workspace.v1', '{unreadable old workspace');
  });
  await damaged.goto('http://127.0.0.1:' + port);
  await damaged.waitForFunction(() => document.querySelector('#save-status').textContent === 'SAVED TO DISK');
  assert.equal(await damaged.evaluate(() => localStorage.getItem('tiksi.workspace.v1')), null);
  const backups = (await readdir(state + '/workspace/history')).filter(n => n.startsWith('browser-migration-'));
  const raw = execFileSync('python3', ['-c', 'import sys,zipfile,json,pathlib;ds=[json.loads(zipfile.ZipFile(p).read("workspace.json")) for p in pathlib.Path(sys.argv[1]).glob("browser-migration-*.tiksi")];print(next(d["unreadableLegacyWorkspace"] for d in ds if "unreadableLegacyWorkspace" in d))', state + '/workspace/history']).toString().trim();
  assert(backups.length >= 2); assert.equal(raw, '{unreadable old workspace');
  await phone.locator('#btn-file').click(); await phone.getByRole('button', { name: 'Settings', exact: true }).click();
  await phone.locator('[data-own-folder-label]').waitFor();
  assert(await phone.locator('.file-dialog').evaluate(el => el.scrollWidth <= el.clientWidth), 'long canonical paths fit the phone settings dialog');
  await phone.getByRole('button', { name: 'Close files and settings' }).click();
  await mkdir('test-results', { recursive: true });
  await desktop.screenshot({ path: 'test-results/disk-workspace-desktop.png' }); await phone.screenshot({ path: 'test-results/disk-workspace-phone.png' });
  assert.deepEqual(errors, []);
  console.log('ok   two origins share project files and originals; no browser persistence; stale edits reviewed; clean browser recovers all projects');
} catch (error) {
  if (browser) console.error('Disk client state:', await Promise.all(browser.contexts().flatMap(context => context.pages()).map(page => page.evaluate(() => ({ url: location.href, status: document.querySelector('#save-status')?.textContent, review: !!document.querySelector('dialog[open]') })).catch(() => null))));
  throw error;
} finally { releaseDownload?.(); if (browser) await browser.close(); child.kill(); await new Promise(r => child.once('exit', r)); await rm(state, { recursive: true, force: true }); }
