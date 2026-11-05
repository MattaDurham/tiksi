// Pictures saved as files, end to end on a temporary disk workspace with synthetic images:
// a workspace saved the old way (pictures inline) migrates on first load without losing a
// byte; saves then send references only and name the project files they did not change;
// other devices, the photos grid, the SketchUp mirror bytes and project-file import all see
// the same pictures; an older tab cannot save over the references.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import net from 'node:net';
import zlib from 'node:zlib';
import { chromium } from 'playwright';

// A real, decodable PNG of random pixels (so the photos grid can draw it).
function png(w, h) {
  const chunk = (type, body) => {
    const out = Buffer.alloc(12 + body.length); out.writeUInt32BE(body.length, 0); out.write(type, 4, 'ascii'); body.copy(out, 8);
    out.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type, 'ascii'), body])), 8 + body.length); return out;
  };
  const head = Buffer.alloc(13); head.writeUInt32BE(w, 0); head.writeUInt32BE(h, 4); head[8] = 8; head[9] = 2;
  const rows = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) randomBytes(w * 3).copy(rows, y * (w * 3 + 1) + 1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
const url = bytes => 'data:image/png;base64,' + bytes.toString('base64');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

const state = await mkdtemp(tmpdir() + '/tiksi-picture-files-');
const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r));
const port = socket.address().port; await new Promise(r => socket.close(r));
const child = spawn('python3', ['tools/serve.py', '--port', String(port), '--state-dir', state, '--projects-dir', state + '/projects'], { stdio: ['ignore', 'pipe', 'pipe'] });
const serverLog = []; for (const s of [child.stdout, child.stderr]) s.on('data', d => serverLog.push(...String(d).split('\n')));
const origin = 'http://127.0.0.1:' + port;
let browser;
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(origin)).ok) break; } catch {} await new Promise(r => setTimeout(r, 50)); }
  const auth = { 'X-Tiksi-Workspace': '1' };
  auth['X-Tiksi-Token'] = (await (await fetch(origin + '/api/workspace/capabilities', { headers: auth })).json()).token;

  // An existing workspace as the previous version saved it: every picture inline.
  const pictures = { thumbA: png(48, 36), thumbB: png(40, 30), thumbC: png(44, 33), video: png(32, 24), plan: png(300, 260), product: png(24, 24) };
  const original = Object.fromEntries(Object.entries(pictures).map(([k, v]) => [k, url(v)]));
  const settings = { units: 'imperial', budgetCap: 150000, programStart: '2026-01-05', activePropertyId: 'prop-a' };
  const propA = { id: 'prop-a', name: 'Synthetic row house', notes: '', wallHeight: 2.44, activeLevelId: 'lvl-0', walls: [], openings: [], rooms: [], fixtures: [], scans: [], notePins: [], measurements: [],
    levels: [{ id: 'lvl-0', name: 'Main level', elevation: 0, height: 2.44, plan: { img: original.plan, imgW: 300, imgH: 260, mPerPx: 0.03, offsetX: 0, offsetY: 0, opacity: 0.6, calibrated: true, source: 'image' } }],
    photos: [{ id: 'ph-a', name: 'Kitchen.png', thumb: original.thumbA, mime: 'image/png', kind: 'photo', notes: '' }, { id: 'ph-b', name: 'Hall.png', thumb: original.thumbB, mime: 'image/png', kind: 'photo', notes: '' }],
    videos: [{ id: 'vid-a', name: 'Walk.mp4', thumb: original.video, notes: '' }] };
  const propB = { id: 'prop-b', name: 'Synthetic cabin', notes: '', wallHeight: 2.44, activeLevelId: 'lvl-0', walls: [], openings: [], rooms: [], fixtures: [], scans: [], notePins: [], videos: [], measurements: [],
    levels: [{ id: 'lvl-0', name: 'Main level', elevation: 0, height: 2.44, plan: null }],
    photos: [{ id: 'ph-c', name: 'Porch.png', thumb: original.thumbC, mime: 'image/png', kind: 'photo', notes: '' }] };
  const product = { id: 'prod-a', name: 'Synthetic sink', price: 1, unit: 'ea', imageUrl: original.product, itemIds: [], propertyIds: ['prop-a'] };
  const old = { version: 2, settings, properties: [propA, propB], projects: [], materials: [], products: [product] };
  const slice = p => ({ version: 2, settings: { ...settings, activePropertyId: p.id }, properties: [p], materials: [], projects: [], products: p.id === 'prop-a' ? [product] : [] });
  const seeded = await fetch(origin + '/api/workspace', { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: 0, data: old, assets: {}, projectData: { 'prop-a': slice(propA), 'prop-b': slice(propB) } }) });
  assert.equal(seeded.status, 200, 'an older client saved this workspace');
  const catalog = async () => JSON.parse(await readFile(state + '/workspace/current.json', 'utf8'));
  const inline = value => JSON.stringify(value).match(/"data:[^"]{1024,}"/g) || [];
  assert.equal(inline((await catalog()).data).length, 6);

  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const errors = [];
  const desktopContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const desktop = await desktopContext.newPage(); desktop.on('pageerror', e => errors.push(e.message));
  // Saved: the disk client exists, has nothing pending and says so. (The predicate must be
  // synchronous: a promise would count as an immediate yes.)
  const savedNow = async page => {
    await page.waitForFunction(() => document.querySelector('#save-status')?.textContent === 'SAVED TO DISK', null, { timeout: 60000 });
    await page.evaluate(async () => { window.__disk = await import('/js/disk-workspace.js'); });
    await page.waitForFunction(() => window.__disk.diskWorkspace && !window.__disk.diskWorkspace.pending && document.querySelector('#save-status')?.textContent === 'SAVED TO DISK', null, { timeout: 60000 });
  };
  await desktop.goto(origin + '/#/photos'); await savedNow(desktop);
  for (let i = 0; i < 100 && inline((await catalog()).data).length; i++) await new Promise(r => setTimeout(r, 100));

  // Migration: the saved records hold references only, each file holds the exact bytes.
  const migrated = await catalog();
  assert.deepEqual(inline(migrated.data), [], 'no picture is left inline in the saved workspace');
  const refs = JSON.stringify(migrated.data).match(/tiksi-picture:image\/png:pic-[a-f0-9]{64}/g);
  assert.equal(new Set(refs).size, 6, 'six pictures, six references');
  for (const [name, bytes] of Object.entries(pictures)) {
    assert(refs.includes('tiksi-picture:image/png:pic-' + sha(bytes)), name + ' is referenced by its content');
    assert.deepEqual(await readFile(state + '/workspace/blobs/' + sha(bytes)), bytes, name + ' is stored byte for byte');
  }
  const pictureChars = Object.values(original).reduce((n, v) => n + v.length, 0);
  assert(JSON.stringify(migrated).length < pictureChars / 10, 'the saved workspace is a fraction of its pictures (' + JSON.stringify(migrated).length + ' of ' + pictureChars + ' characters)');
  const history = (await readdir(state + '/workspace/history')).filter(n => /^\d+\.json$/.test(n));
  assert(history.length >= 1, 'the inline version before migration is kept for recovery');
  // The project file carries the pictures; opening it anywhere restores them inline.
  const bundle = await readFile(migrated.paths['prop-a']);
  const opened = await desktop.evaluate(async b64 => {
    const s = await import('/js/store.js');
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const { data, missing } = await s.readBundle(new File([bytes], 'Synthetic row house.tiksi'));
    return { missing, photos: data.properties[0].photos.map(p => p.thumb), plan: data.properties[0].levels[0].plan.img, video: data.properties[0].videos[0].thumb, product: data.products[0].imageUrl };
  }, bundle.toString('base64'));
  assert.deepEqual(opened, { missing: [], photos: [original.thumbA, original.thumbB], plan: original.plan, video: original.video, product: original.product });

  // The open workspace shows the identical pictures, in the photos grid too.
  const open = await desktop.evaluate(async () => {
    const s = await import('/js/store.js'), a = s.ws.data.properties.find(p => p.id === 'prop-a');
    return { photos: a.photos.map(p => p.thumb), plan: a.levels[0].plan.img, video: a.videos[0].thumb, product: s.ws.data.products[0].imageUrl };
  });
  assert.deepEqual(open, { photos: [original.thumbA, original.thumbB], plan: original.plan, video: original.video, product: original.product });
  await desktop.waitForFunction(() => { const imgs = [...document.querySelectorAll('.ph-thumb img')]; return imgs.length === 2 && imgs.every(i => i.complete && i.naturalWidth > 0); }, null, { timeout: 20000 });
  assert.deepEqual(await desktop.locator('.ph-thumb img').evaluateAll(imgs => imgs.map(i => i.complete && i.naturalWidth)), [48, 40], 'the grid draws both thumbnails');
  const mirrorBytes = await desktop.evaluate(async () => {
    const { sketchupImageBytes } = await import('/js/sketchup-mirror.js'), s = await import('/js/store.js');
    const got = await sketchupImageBytes(s.ws.data.properties[0].levels[0].plan.img);
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', got.bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
  });
  assert.equal(mirrorBytes, sha(pictures.plan), 'the SketchUp mirror gets the original underlay bytes');

  // An edit sends references only, names the untouched project file and reads nothing back.
  const requests = [];
  desktop.on('request', r => { if (r.url().includes('/api/workspace')) requests.push({ method: r.method(), path: new URL(r.url()).pathname, body: r.postData() || '' }); });
  await desktop.evaluate(async () => { const s = await import('/js/store.js'); s.ws.data.properties.find(p => p.id === 'prop-b').notes = 'Edited after migration'; s.touch(); });
  await savedNow(desktop);
  const puts = requests.filter(r => r.method === "PUT" && r.path === "/api/workspace");
  assert.equal(puts.length, 1);
  const body = JSON.parse(puts[0].body);
  assert(!puts[0].body.includes('data:image'), 'no picture bytes in the save');
  assert.deepEqual(Object.keys(body.projectData), ['prop-b']);
  assert.deepEqual(body.unchangedProjects, ['prop-a']);
  assert(puts[0].body.length < pictureChars / 10, 'the save is a fraction of the pictures (' + puts[0].body.length + ' characters)');
  assert.equal(requests.filter(r => r.method === 'GET' && r.path === '/api/workspace').length, 0, 'no full read before or after the save');
  assert.equal(requests.filter(r => r.path.startsWith('/api/workspace/blobs')).length, 0, 'no picture is uploaded again');
  assert.equal((await catalog()).data.properties[1].notes, 'Edited after migration');

  // A new picture is stored as a file before the save that first references it.
  const added = png(50, 40);
  requests.length = 0;
  await desktop.evaluate(async src => { const s = await import('/js/store.js'); s.ws.data.properties[1].photos.push({ id: 'ph-d', name: 'New.png', thumb: src, mime: 'image/png', kind: 'photo', notes: '' }); s.touch(); }, url(added));
  await savedNow(desktop);
  const uploads = requests.filter(r => r.method === 'POST' && r.path === '/api/workspace/blobs');
  assert.equal(uploads.length, 1);
  assert(JSON.stringify((await catalog()).data).includes('pic-' + sha(added)));
  assert.deepEqual(await readFile(state + '/workspace/blobs/' + sha(added)), added);

  // Another device loads the same workspace with identical pictures; a reload is served
  // from the browser's cache instead of downloading every picture again.
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const phone = await phoneContext.newPage(); phone.on('pageerror', e => errors.push(e.message));
  await phone.goto(origin + '/'); await savedNow(phone);
  const phoneOpen = await phone.evaluate(async () => { const s = await import('/js/store.js'); return s.ws.data.properties.flatMap(p => p.photos.map(ph => ph.thumb)).concat(s.ws.data.properties[0].levels[0].plan.img); });
  assert.deepEqual(phoneOpen, [original.thumbA, original.thumbB, original.thumbC, url(added), original.plan]);
  const blobReads = () => serverLog.filter(l => l.includes('GET /api/workspace/blobs/')).length;
  const before = blobReads();
  await phone.reload(); await savedNow(phone);
  assert.equal(blobReads(), before, 'pictures come from the browser cache on reload');

  // A tab still running the previous version cannot save blank pictures over the files.
  const stale = await fetch(origin + '/api/workspace', { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: (await catalog()).revision, data: old, assets: {}, projectData: { 'prop-a': slice(propA), 'prop-b': slice(propB) } }) });
  assert.equal(stale.status, 426);
  assert.deepEqual(errors, []);
  console.log('ok   pictures migrate to files byte for byte; saves send references only; other devices, the grid, the mirror and project files see the same pictures; older tabs are refused');
} finally { if (browser) await browser.close(); child.kill(); await new Promise(r => child.once('exit', r)); await rm(state, { recursive: true, force: true }); }
