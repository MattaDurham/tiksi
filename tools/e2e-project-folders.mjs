// A property kept in a folder of its own: only it is written there, the shared folder keeps the
// rest, a moved project file is opened rather than overwritten, and the link survives a reload.
// Folders are the browser's own private file system (real directory handles); no live state.
// Run: node tools/e2e-project-folders.mjs (Playwright + Chromium installed).
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  const path = resolve(root, '.' + decodeURIComponent(req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0]));
  if (!path.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  try { const bytes = await readFile(path); res.setHeader('Content-Type', types[extname(path)] || 'application/octet-stream'); res.end(bytes); }
  catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(+(process.env.E2E_APP_PORT || 0), 'localhost', r));
const url = `http://localhost:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext()).newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
const check = (ok, label) => { assert.ok(ok, label); console.log('  ok   ' + label); };

try {
  await page.goto(url + '/#/plan');
  await page.waitForSelector('#btn-file');

  // Shared helpers inside the page: OPFS folders, a listing, and a sync that never races the timer.
  await page.evaluate(async () => {
    const s = await import('/js/store.js'), f = await import('/js/files.js');
    const opfs = await navigator.storage.getDirectory();
    window.t = {
      s, f,
      async dir(name) { try { await opfs.removeEntry(name, { recursive: true }); } catch (e) { /* fresh */ } return opfs.getDirectoryHandle(name, { create: true }); },
      async list(dir) { const out = []; for await (const [n] of dir.entries()) out.push(n); return out.sort(); },
      async modified(dir, name) { return (await (await dir.getFileHandle(name)).getFile()).lastModified; },
      async sync() { const st = f.filesState(); clearTimeout(st.syncTimer); while (st.syncing) await new Promise(r => setTimeout(r, 50)); await f.syncFolder(); clearTimeout(st.syncTimer); },
      prop(name) { return s.ws.data.properties.find(p => p.name === name); },
    };
  });

  console.log('\n[own folder] only the linked property is written there');
  const first = await page.evaluate(async () => {
    const { s, f } = t;
    s.ws.data.properties.push(s.propertyTemplate('House A'), s.propertyTemplate('House B')); s.touch();
    const shared = await t.dir('shared'), own = await t.dir('house-a');
    window.showDirectoryPicker = async () => shared;
    await f.linkFolder(); await t.sync();
    const sharedA = await t.modified(shared, 'House A.tiksi');
    window.showDirectoryPicker = async () => own;
    await f.linkProjectFolder(t.prop('House A'));
    t.prop('House A').notes = 'edited after linking its own folder'; t.prop('House B').notes = 'edited in the shared folder'; s.touch();
    await new Promise(r => setTimeout(r, 20)); await t.sync();
    return { shared: await t.list(shared), own: await t.list(own), sharedAUnchanged: (await t.modified(shared, 'House A.tiksi')) === sharedA,
      folder: f.projectFolder(t.prop('House A').id), target: f.saveTarget(t.prop('House A').id), targetB: f.saveTarget(t.prop('House B').id) };
  });
  check(first.own.length === 1 && first.own[0] === 'House A.tiksi', 'the own folder holds only House A.tiksi (' + first.own.join(', ') + ')');
  check(first.shared.includes('House B.tiksi') && first.shared.includes('House A.tiksi'), 'the shared folder keeps House B and the earlier House A copy');
  check(first.sharedAUnchanged, 'House A is no longer rewritten in the shared folder');
  check(first.folder && first.folder.name === 'house-a' && first.folder.permitted, 'House A reports its own folder');
  check(first.target.folder === 'house-a' && first.targetB.folder === 'shared', 'save targets name each property\'s folder');

  console.log('\n[permission] a folder waiting for permission is never replaced by the shared one');
  const waiting = await page.evaluate(async () => {
    const { s, f } = t;
    const shared = f.filesState().folder, before = await t.modified(shared, 'House B.tiksi'), filesBefore = (await t.list(shared)).join();
    const offline = { kind: 'directory', name: 'offline-folder', queryPermission: async () => 'prompt', requestPermission: async () => 'denied',
      getFileHandle: async () => { throw new Error('must not be written'); }, async *entries() {} };
    window.showDirectoryPicker = async () => offline;
    await f.linkProjectFolder(t.prop('House B'));
    t.prop('House B').notes = 'edited while its folder needs permission'; s.touch();
    await new Promise(r => setTimeout(r, 20)); await t.sync();
    const result = { sharedUnchanged: (await t.modified(shared, 'House B.tiksi')) === before && (await t.list(shared)).join() === filesBefore, folder: f.projectFolder(t.prop('House B').id), mirror: f.mirrorStatus(t.prop('House B').id) };
    await f.unlinkProjectFolder(t.prop('House B').id); await t.sync();
    result.backInShared = (await t.modified(shared, 'House B.tiksi')) !== before;
    return result;
  });
  check(waiting.sharedUnchanged, 'House B is not written to the shared folder, under any name, while its own folder waits');
  check(waiting.folder && !waiting.folder.permitted, 'its folder is reported as needing permission');
  check(/reconnected/.test(waiting.mirror), 'the SketchUp mirror status says it waits for that folder');
  check(waiting.backInShared, 'USE THE SHARED FOLDER writes it to the shared folder again');

  console.log('\n[moved project] a folder that already holds the project file');
  const moved = await page.evaluate(async () => {
    const { s, f } = t;
    const a = t.prop('House A'), id = a.id;
    // A copy of House A that was moved into another folder, with a note this browser does not have.
    const keepNotes = a.notes; a.notes = 'from the moved file';
    const blob = (await s.exportProjectBlob(id)).blob; a.notes = keepNotes;
    const movedDir = await t.dir('moved'), keepDir = await t.dir('keep');
    for (const d of [movedDir, keepDir]) { const w = await (await d.getFileHandle('House A.tiksi', { create: true })).createWritable(); await w.write(blob); await w.close(); }
    const keepBefore = await t.modified(keepDir, 'House A.tiksi');
    window.showDirectoryPicker = async () => keepDir;
    await f.linkProjectFolder(a, { choose: () => 'keep' }); await t.sync();
    const kept = { files: await t.list(keepDir), untouched: (await t.modified(keepDir, 'House A.tiksi')) === keepBefore, notes: t.prop('House A').notes };
    window.showDirectoryPicker = async () => movedDir;
    let offered = '';
    await f.linkProjectFolder(t.prop('House A'), { choose: en => { offered = en.name; return 'open'; } });
    const opened = { offered, notes: t.prop('House A').notes, file: f.filesState().folderMap[id].file };
    t.prop('House A').notes = 'edited after opening the moved file'; s.touch();
    await new Promise(r => setTimeout(r, 20)); await t.sync();
    opened.files = await t.list(movedDir);
    return { kept, opened };
  });
  check(moved.kept.files.join() === 'House A (2).tiksi,House A.tiksi' && moved.kept.untouched, 'keeping the browser copy writes House A (2).tiksi and leaves the file there alone');
  check(moved.kept.notes !== 'from the moved file', 'keeping does not open the file');
  check(moved.opened.offered === 'House A.tiksi' && moved.opened.notes === 'from the moved file', 'opening loads the moved file into the browser');
  check(moved.opened.file === 'House A.tiksi' && moved.opened.files.join() === 'House A.tiksi', 'later saves go to that same file, not a new copy');

  console.log('\n[shared folder changes] the own folder is independent of the shared one');
  const independent = await page.evaluate(async () => {
    const { s, f } = t;
    await f.unlinkFolder();
    const kept = f.projectFolder(t.prop('House A').id);
    t.prop('House A').notes = 'edited with no shared folder'; s.touch();
    await new Promise(r => setTimeout(r, 20)); await t.sync();
    const movedDir = f.filesState().projectFolders.get(t.prop('House A').id).handle;
    const text = await (await (await movedDir.getFileHandle('House A.tiksi')).getFile()).size;
    return { kept, size: text, map: !!f.filesState().folderMap[t.prop('House A').id].own };
  });
  check(independent.kept && independent.kept.name === 'moved' && independent.map, 'unlinking the shared folder keeps House A\'s own folder');
  check(independent.size > 0, 'House A still saves into its own folder');

  console.log('\n[reload] the own folder link is remembered');
  await page.waitForTimeout(600);
  await page.reload();
  await page.waitForSelector('#btn-file');
  const after = await page.evaluate(async () => {
    const f = await import('/js/files.js'), s = await import('/js/store.js');
    const deadline = Date.now() + 10000;
    let a = s.ws.data.properties.find(p => p.name === 'House A');
    while (!f.projectFolder(a.id)?.permitted && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
    return { folder: f.projectFolder(a.id) };
  });
  check(after.folder && after.folder.name === 'moved' && after.folder.permitted, 'after a reload House A is still kept in its own folder');

  console.log('\n[settings] FILE > Settings shows and changes the project folder');
  await page.evaluate(async () => { const s = await import('/js/store.js'); const a = s.ws.data.properties.find(p => p.name === 'House A'); s.ws.data.settings.activePropertyId = a.id; s.touch(); });
  await page.waitForTimeout(600);
  await page.reload();
  await page.waitForSelector('#btn-file');
  await page.click('#btn-file'); await page.click('[data-file-tab=settings]');
  await page.waitForFunction(() => /moved/.test(document.querySelector('[data-own-folder-label]')?.textContent || ''));
  const label = await page.locator('[data-own-folder-label]').textContent();
  check(/Kept in moved\. Only this project is written there\./.test(label), 'the settings label names the folder (' + label + ')');
  await page.click('[data-own-folder-unlink]');
  await page.waitForFunction(() => /shared folder/.test(document.querySelector('[data-own-folder-label]')?.textContent || ''));
  check(await page.evaluate(async () => { const f = await import('/js/files.js'), s = await import('/js/store.js'); return f.projectFolder(s.activeProperty().id) === null; }), 'USE THE SHARED FOLDER removes the link');
  await page.evaluate(async () => { const opfs = await navigator.storage.getDirectory(); window.showDirectoryPicker = async () => opfs.getDirectoryHandle('house-a', { create: true }); });
  await page.click('[data-own-folder-link]');
  await page.waitForFunction(() => /Kept in house-a/.test(document.querySelector('[data-own-folder-label]')?.textContent || ''));
  check(true, 'LINK THIS PROJECT\'S FOLDER links the folder picked in the dialog');

  assert.deepEqual(errors, [], 'no page errors');
  console.log('\nALL CHECKS PASSED');
} finally {
  await browser.close();
  server.close();
}
