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
let browser;
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
  // A brand-new browser has no cache or migration state and still sees everything.
  const clean = await (await browser.newContext()).newPage(); await clean.goto('http://127.0.0.1:' + port);
  await clean.waitForFunction(() => document.querySelector('#property-select')?.options.length === 3);
  const folders = await readdir(state + '/projects'); assert.equal(folders.length, 3);
  for (const folder of folders) assert((await readdir(state + '/projects/' + folder)).some(n => n.endsWith('.tiksi')));
  const catalog = JSON.parse(await readFile(state + '/workspace/current.json', 'utf8'));
  assert.equal(catalog.data.properties.length, 3);
  // Migrate an older device, including an orphan original, before clearing its
  // browser database. The Mac's newer records and unrelated local project survive.
  const legacy = await (await browser.newContext()).newPage();
  await legacy.goto('http://127.0.0.1:' + port + '/app-icon.svg');
  await legacy.evaluate(async () => {
    const s = await import('/js/store.js');
    s.replaceWorkspace(s.emptyWorkspace());
    const p = s.propertyTemplate('Legacy device project'); p.id = 'prop-legacy'; s.ws.data.properties.push(p); s.ws.data.settings.activePropertyId = p.id;
    await s.putFile('orphan-original', new Uint8Array([3, 1, 4, 1, 5]).buffer, { name: 'Unreferenced.bin', format: 'bin' });
    await s.whenHydrated(); s.save();
  });
  await legacy.goto('http://127.0.0.1:' + port);
  await legacy.getByRole('button', { name: 'USE MAC VALUES', exact: true }).click();
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
  await mkdir('test-results', { recursive: true });
  await desktop.screenshot({ path: 'test-results/disk-workspace-desktop.png' }); await phone.screenshot({ path: 'test-results/disk-workspace-phone.png' });
  assert.deepEqual(errors, []);
  console.log('ok   two origins share project files and originals; no browser persistence; stale edits reviewed; clean browser recovers all projects');
} finally { if (browser) await browser.close(); child.kill(); await new Promise(r => child.once('exit', r)); await rm(state, { recursive: true, force: true }); }
