// FILE > NEW PROPERTY FROM A FOLDER, end to end, on a synthetic site-visit folder in a temporary
// directory: a scan, photos (one in a subfolder, one that is not a picture), a PDF, a video,
// an audio recording and an office file.
//
// 1. On the Mac's server: the server "picks" the folder (TIKSI_CHOOSE_FOLDER stands in for the
//    Mac's folder window), the review lists every file, a subfolder is unticked, the property
//    is made, the plan is proposed from the scan, and the project file is written into the
//    folder's own Tiksi folder while every original stays byte for byte as it was.
// 2. On static hosting: the browser's folder picker hands over the same folder.
// Never the live port; never an owner's folder.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { mkdtemp, mkdir, rm, writeFile, copyFile, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const has = cmd => { try { execFileSync(cmd, ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } };
const ffmpeg = has('ffmpeg');
const python = execFileSync('python3', ['-c', 'import sys; print(sys.executable)']).toString().trim();
// The real path: on a Mac the temporary folder is reached through a link, and the server reports where a folder really is.
const temp = await realpath(await mkdtemp(tmpdir() + '/tiksi-folder-test-'));
const visit = join(temp, 'Synthetic visit (2)');

// A 2x2 PNG and the smallest PDF a reader accepts (one blank Letter page).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8Dwn4GBgYmBgYGBAQAOCQECb1hP1QAAAABJRU5ErkJggg==', 'base64');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\ntrailer<</Root 1 0 R/Size 4>>\n%%EOF\n');

async function makeVisit() {
  await mkdir(join(visit, 'Side project'), { recursive: true });
  if (!existsSync(join(root, 'tools/fixtures/room.glb'))) execFileSync(process.execPath, [join(root, 'tools/fixture-room.mjs')], { stdio: 'ignore' });
  await copyFile(join(root, 'tools/fixtures/room.glb'), join(visit, 'room.glb'));
  await writeFile(join(visit, 'IMG_1.png'), PNG);
  await writeFile(join(visit, 'Side project', 'IMG_2.png'), PNG);
  await writeFile(join(visit, 'not a picture.jpg'), 'this file only claims to be a JPEG');
  await writeFile(join(visit, 'survey.pdf'), PDF);
  await writeFile(join(visit, 'voice note.m4a'), 'synthetic audio bytes');
  await writeFile(join(visit, 'quote.docx'), 'synthetic office file');
  await writeFile(join(visit, '.DS_Store'), 'finder');
  if (ffmpeg) execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x6b5a48:s=320x180:r=10:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(visit, 'walk.mp4')]);
}
// Every file under the folder except Tiksi's own, as path -> SHA-256.
async function fingerprint(dir, base = dir, out = {}) {
  for (const name of (await readdir(dir)).sort()) {
    const path = join(dir, name);
    if ((await stat(path)).isDirectory()) { if (!(dir === base && name === 'Tiksi')) await fingerprint(path, base, out); }
    else out[path.slice(base.length + 1)] = createHash('sha256').update(await readFile(path)).digest('hex');
  }
  return out;
}
async function freePort(preferred) {
  if (preferred) return Number(preferred);
  const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r));
  const port = s.address().port; await new Promise(r => s.close(r)); return port;
}
async function ready(url) { for (let i = 0; i < 200; i++) { try { if ((await fetch(url)).ok) return; } catch {} await new Promise(r => setTimeout(r, 50)); } throw new Error('server did not start'); }
const passed = [];
const check = (ok, name) => { assert.ok(ok, name); passed.push(name); };
const propertyCount = page => page.evaluate(async () => (await import('/js/store.js')).ws.data.properties.length);
const activeProperty = page => page.evaluate(async () => JSON.parse(JSON.stringify((await import('/js/store.js')).activeProperty())));

// From the open review to the finished run; returns what the dialog said.
async function reviewAndCreate(page, { name, where, held }) {
  await page.waitForSelector('#np-dialog[data-state="review"]', { timeout: 30000 });
  check(await page.inputValue('[data-nf-name]') === 'Synthetic visit', 'the name is the folder\'s, without the "(2)" a download adds');
  check((await page.locator('.nf-review .np-hint').first().textContent()).includes(where), 'the review says where the project is kept (' + where + ')');
  const kinds = await page.$$eval('.nf-review > details.nf-kind summary b', els => els.map(e => e.textContent));
  check(JSON.stringify(kinds) === JSON.stringify(['3D scan or model', 'Photos', 'PDF', ...(ffmpeg ? ['Video'] : [])]), 'what comes in is listed by kind (' + kinds.join(', ') + ')');
  const stays = await page.$$eval('.nf-stay li', els => els.map(e => e.textContent));
  check(stays.length === 2 && stays.some(t => t.includes('voice note.m4a') && /audio/i.test(t)) && stays.some(t => t.includes('quote.docx')), 'the audio recording and the office file are listed as staying in the folder, with the reason');
  check(!(await page.locator('.nf-review').textContent()).includes('.DS_Store'), 'hidden files are not listed');
  check((await page.locator('.nf-review .np-small').last().textContent()).startsWith('1 hidden file was left out'), 'but the review says one was left out');
  check((await page.textContent('[data-np-create]')).includes('CREATE FROM ' + (ffmpeg ? 6 : 5) + ' FILES'), 'CREATE counts the files that will come in');
  check(await propertyCount(page) === held, 'nothing is made while the review is open');
  // The side project's photo stays out: untick its subfolder.
  await page.uncheck('[data-nf-group="Side project"]');
  check((await page.textContent('[data-nf-count="photo"]')).startsWith('2 of 3'), 'unticking a subfolder unticks its files');
  check((await page.textContent('[data-np-create]')).includes('CREATE FROM ' + (ffmpeg ? 5 : 4) + ' FILES'), 'and CREATE counts one fewer');
  await page.fill('[data-nf-name]', name);
  await page.click('[data-np-create]');
  await page.waitForSelector('#np-dialog[data-state="done"]', { timeout: 240000 });
  return page.$$eval('#np-dialog .np-step', els => els.map(e => ({ state: e.className.replace('np-step ', ''), text: e.textContent })));
}
// kept: the project file is kept in the picked folder, so its photos stay there and PHOTOS reads
// them where they are; otherwise (static hosting) they are copied into the browser.
async function checkProperty(page, steps, name, kept = false) {
  const prop = await activeProperty(page);
  check(prop.name === name, 'the property carries the name typed in the review');
  check(prop.scans.length === 1 && prop.scans[0].kind === 'mesh', 'the scan is kept as a mesh');
  check(prop.walls.length >= 4 && prop.rooms.length >= 1, 'the plan is proposed from the scan (' + prop.walls.length + ' walls, ' + prop.rooms.length + ' rooms)');
  const photos = prop.photos.filter(p => p.kind !== 'document' && p.source !== 'rendering'), docs = prop.photos.filter(p => p.kind === 'document');
  if (kept) {
    check(!photos.length, 'no photo is copied into Tiksi: they stay in the folder');
    check(steps.some(s => s.state === 'ok' && /^2 photos stay in the folder and show in PHOTOS/.test(s.text)), 'the run says the photos stay in the folder and show in PHOTOS');
  } else check(photos.some(p => p.name === 'IMG_1.png') && !photos.some(p => p.name === 'IMG_2.png'), 'the photo at the top is in; the unticked subfolder\'s photo is not');
  check(docs.some(d => d.name === 'survey.pdf' && d.mime === 'application/pdf' && d.pageCount === 1), 'the PDF is a document of the property');
  if (ffmpeg) check(prop.videos.length === 1 && prop.videos[0].name === 'walk.mp4', 'the video is kept for MEASURE');
  if (!kept) {
    const bad = steps.find(s => s.text.includes('not a picture.jpg'));
    check(bad && bad.state === 'fail' && /cannot read the picture/.test(bad.text), 'the file that is not a picture is reported by name with the reason, not dropped silently');
    check(steps.some(s => s.state === 'warn' && /Photos/.test(s.text) && /1 of 2 in; 1 could not be read/.test(s.text)), 'the photo count says one of two came in');
  }
  const left = steps.find(s => /left in the folder, unchanged/.test(s.text));
  check(left && left.text.startsWith('3 files were left') && /1 photo/.test(left.text) && /1 audio recording/.test(left.text) && /1 other file/.test(left.text), 'the run ends with what stayed in the folder (' + (left && left.text) + ')');
  check(steps.every(s => s.state !== 'run'), 'no step is left running');
  return prop;
}

await makeVisit();
const before = await fingerprint(visit);
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const children = [];
let staticServer = null;
try {
  // ---------- 1. the Mac's server reads the folder where it is ----------
  const port = await freePort(process.env.E2E_APP_PORT), url = 'http://127.0.0.1:' + port;
  const child = spawn(python, ['tools/serve.py', '--port', String(port), '--state-dir', join(temp, 'state')], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TIKSI_CHOOSE_FOLDER: visit } });
  child.stdout.resume(); child.stderr.resume(); children.push(child);
  await ready(url);
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(url);
    await page.waitForFunction(() => document.querySelector('#save-status').textContent === 'SAVED TO DISK');
    const held = await propertyCount(page);
    await page.click('#tiksi-menu').then(() => page.click('#btn-file'));
    await page.click('[data-new-folder]');
    const steps = await reviewAndCreate(page, { name: 'Elm Street kitchen', where: 'kept in this folder', held });
    check(steps.some(s => s.state === 'ok' && s.text.includes(join(visit, 'Tiksi', 'Elm Street kitchen.tiksi'))), 'the run names the project file it will write in the folder');
    const prop = await checkProperty(page, steps, 'Elm Street kitchen', true);
    // CLOSE remounts MODEL in this document. A cold software-rendered mount can
    // outlast Playwright's default click budget; wait for the actual app state,
    // not its implicit full-navigation synchronization.
    await page.click('[data-np-cancel]', { noWaitAfter: true, timeout: 90000 });
    await page.waitForSelector('#np-dialog', { state: 'detached', timeout: 90000 });
    await page.waitForSelector('#view canvas.v-canvas', { state: 'visible', timeout: 90000 });
    check(await page.locator('#np-dialog').count() === 0 && await page.locator('#view canvas.v-canvas').isVisible(), 'CLOSE removes the finished folder dialog and mounts MODEL');
    await page.waitForFunction(() => document.querySelector('#save-status').textContent === 'SAVED TO DISK', null, { timeout: 60000 });
    const saved = join(visit, 'Tiksi', 'Elm Street kitchen.tiksi');
    check(existsSync(saved), 'the project file is in the picked folder\'s Tiksi folder');
    check(await page.evaluate(async id => (await import('/js/disk-workspace.js')).diskWorkspace.paths[id], prop.id) === saved, 'and Tiksi knows the property is kept there');
    check((await readdir(join(temp, 'state', 'workspace', 'projects'))).length === 0, 'nothing was written to the default projects folder');
    check(JSON.stringify(await fingerprint(visit)) === JSON.stringify(before), 'every original in the folder is byte for byte as it was, and nothing was added beside them');
    // A reload reads the property back from the file in the folder.
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#save-status').textContent === 'SAVED TO DISK');
    const again = await activeProperty(page);
    check(again.id === prop.id && again.scans.length === 1 && again.walls.length === prop.walls.length, 'after a reload the property comes back from that file');
    assert.deepEqual(errors, [], 'no page errors on the server run');
    await page.close();
  }
  await new Promise(r => { child.once('exit', r); child.kill('SIGTERM'); });
  await rm(join(visit, 'Tiksi'), { recursive: true, force: true });

  // ---------- 2. static hosting: the browser's own folder picker ----------
  staticServer = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    const file = resolve(root, '.' + decodeURIComponent(path === '/' ? '/index.html' : path));
    if (!file.startsWith(root + '/') || !/^\/(index\.html|js\/|css\/|vendor\/)?/.test(path) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.setHeader('content-type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.svg': 'image/svg+xml' })[extname(file)] || 'application/octet-stream');
    res.end(readFileSync(file));
  });
  await new Promise(r => staticServer.listen(0, 'localhost', r));
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto('http://localhost:' + staticServer.address().port + '/');
    await page.waitForSelector('#btn-file', { state: 'attached' });
    const held = await propertyCount(page);
    await page.click('#tiksi-menu').then(() => page.click('#btn-file'));
    await page.click('[data-new-property]');
    const waiting = page.waitForEvent('filechooser');
    await page.click('[data-np-folder]');
    const chooser = await waiting;
    check(chooser.isMultiple(), 'on static hosting CHOOSE A FOLDER opens the browser\'s folder picker');
    await chooser.setFiles(visit);
    const steps = await reviewAndCreate(page, { name: 'Elm Street kitchen', where: 'copied into this browser', held });
    await checkProperty(page, steps, 'Elm Street kitchen');
    check(JSON.stringify(await fingerprint(visit)) === JSON.stringify(before) && !existsSync(join(visit, 'Tiksi')), 'the picked folder is untouched');
    assert.deepEqual(errors, [], 'no page errors on the static run');
    await page.close();
  }
  console.log(passed.map(name => '  ok  ' + name).join('\n'));
  console.log(`folder import: ${passed.length} checks passed` + (ffmpeg ? '' : ' (no ffmpeg here: the video was left out)'));
} finally {
  await browser.close();
  for (const child of children) { try { child.kill('SIGKILL'); } catch {} }
  if (staticServer) staticServer.close();
  await rm(temp, { recursive: true, force: true });
}
