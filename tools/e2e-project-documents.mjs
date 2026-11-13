// Product files and recovery bundles traverse the disk client's transfer wrapper.
// Exercise real temporary project folders, never an owner's workspace.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { chromium } from 'playwright';

const state = await mkdtemp(tmpdir() + '/tiksi-project-documents-');
const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
const server = spawn('python3', ['tools/serve.py', '--host', '127.0.0.1', '--port', String(port), '--state-dir', state, '--projects-dir', state + '/projects'], { stdio: ['ignore', 'pipe', 'pipe'] });
let log = '', browser;
server.stdout.resume(); server.stderr.on('data', data => { log = (log + data).slice(-8000); });
const origin = 'http://127.0.0.1:' + port;
// Valid single-page PDF; non-ASCII binary comment must survive the transfer unchanged.
const pdf = Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'latin1');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZQAAAABJRU5ErkJggg==', 'base64');
// Trailing bytes keep the valid image header and exercise the streamed (>256 KiB) response.
const largeImage = Buffer.concat([png, Buffer.alloc(300000, 239)]);
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(origin)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 50)); }
  browser = await chromium.launch({ channel: 'chromium', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1100, height: 800 } });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/#/documents');
  await page.waitForFunction(() => document.querySelector('#save-status')?.textContent === 'SAVED TO DISK');
  const projectFile = await page.evaluate(async () => {
    const s = await import('/js/store.js'), { diskWorkspace: disk } = await import('/js/disk-workspace.js');
    const p = s.propertyTemplate('Synthetic document review'); p.id = 'prop-documents'; p.notes = 'Before recovery';
    s.ws.data.properties.push(p); s.ws.data.settings.activePropertyId = p.id;
    s.ws.data.products.push({ id: 'prod-documents', name: 'Synthetic fixture', propertyIds: [p.id], documents: [
      { path: 'Product documents/spec.pdf', title: 'Fixture specification', kind: 'spec-sheet' },
      { path: 'Product documents/finish.png', title: 'Fixture finish', kind: 'image' },
      { path: 'Product documents/missing.pdf', title: 'Missing fixture specification', kind: 'spec-sheet' },
    ] });
    s.touch(); await disk.sync(); return disk.paths[p.id];
  });
  const folder = projectFile.slice(0, projectFile.lastIndexOf('/'));
  await mkdir(folder + '/Product documents', { recursive: true });
  await writeFile(folder + '/Product documents/spec.pdf', pdf);
  await writeFile(folder + '/Product documents/finish.png', largeImage);
  // A recovery file holds real project ZIP bytes, including an exact binary original.
  const bundle = await page.evaluate(async bytes => {
    const s = await import('/js/store.js'), disk = (await import('/js/disk-workspace.js')).diskWorkspace;
    await s.putFile('photo-recovery', Uint8Array.from(bytes).buffer, { kind: 'photo', mime: 'image/png', name: 'Original.png' });
    s.activeProperty().photos.push({ id: 'photo-recovery', name: 'Original.png', kind: 'photo', original: true, mime: 'image/png', thumb: '' });
    s.touch(); await disk.sync(); return [...new Uint8Array(await (await s.exportProjectBlob('prop-documents')).blob.arrayBuffer())];
  }, [...png]);
  await mkdir(state + '/workspace/history', { recursive: true });
  await writeFile(state + '/workspace/history/synthetic-recovery.tiksi', Buffer.from(bundle));
  await page.reload();
  await page.locator('[data-pdoc="prod-documents:0"]').waitFor();
  // Observe object URLs at their creation without replacing browser popup behavior.
  await page.evaluate(() => {
    const make = URL.createObjectURL;
    window.documentBlobs = [];
    URL.createObjectURL = blob => { window.documentBlobs.push(blob); return make(blob); };
  });
  const popupPromise = page.waitForEvent('popup');
  await page.locator('[data-pdoc="prod-documents:0"]').click();
  const popup = await popupPromise;
  await popup.waitForURL('blob:**');
  await page.waitForFunction(() => /in your browser/.test(document.querySelector('[data-status]')?.textContent || ''));
  const pdfResult = await page.evaluate(async () => ({ mime: window.documentBlobs.at(-1).type, bytes: [...new Uint8Array(await window.documentBlobs.at(-1).arrayBuffer())] }));
  assert.equal(pdfResult.mime, 'application/pdf'); assert.deepEqual(Buffer.from(pdfResult.bytes), pdf);
  assert.equal(await popup.evaluate(() => window.opener), null, 'document popup cannot access its opener');
  await popup.close();

  await page.evaluate(() => { window.open = () => null; });
  const downloadPromise = page.waitForEvent('download');
  await page.locator('[data-pdoc="prod-documents:1"]').click();
  const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), 'finish.png');
  assert.deepEqual(await readFile(await download.path()), largeImage, 'streamed document download retains every binary byte');
  assert.equal(await page.evaluate(() => window.documentBlobs.at(-1).type), 'image/png');
  await page.waitForFunction(() => /to this device/.test(document.querySelector('[data-status]')?.textContent || ''));
  await page.locator('[data-pdoc="prod-documents:2"]').click();
  await page.waitForFunction(() => /missing\.pdf is not in the project folder/.test(document.querySelector('[data-status]')?.textContent || ''));
  assert.equal(await page.evaluate(() => window.documentBlobs.length), 2, 'missing document reports an error without handing off stale bytes');

  await page.evaluate(async () => {
    const s = await import('/js/store.js'), disk = (await import('/js/disk-workspace.js')).diskWorkspace;
    s.activeProperty().notes = 'Changed before restore'; s.touch(); await disk.sync();
    await disk.restoreRecovery('synthetic-recovery.tiksi');
  });
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#save-status')?.textContent === 'SAVED TO DISK');
  const restored = await page.evaluate(async () => {
    const s = await import('/js/store.js');
    await s.whenHydrated();
    const file = await s.getFile('photo-recovery');
    return { notes: s.activeProperty().notes, bytes: [...new Uint8Array(file.buffer)] };
  });
  assert.equal(restored.notes, 'Before recovery'); assert.deepEqual(Buffer.from(restored.bytes), png);
  const copies = (await readdir(state + '/workspace/history')).filter(name => name.endsWith('.tiksi') && name !== 'synthetic-recovery.tiksi');
  const recoveryNotes = JSON.parse(execFileSync('python3', ['-c', 'import json,pathlib,sys,zipfile;print(json.dumps([p.get("notes") for n in sys.argv[2:] for p in json.loads(zipfile.ZipFile(pathlib.Path(sys.argv[1])/n).read("workspace.json"))["properties"]]))', state + '/workspace/history', ...copies], { encoding: 'utf8' }));
  assert(recoveryNotes.includes('Changed before restore'), 'restoring preserves the prior workspace in recovery history');
  assert.deepEqual(errors, []);
  console.log('Project document popup, streamed download, missing-file error, and binary recovery restore passed.');
} catch (error) { console.error(log); throw error; }
finally { await browser?.close(); server.kill('SIGTERM'); await rm(state, { recursive: true, force: true }); }
