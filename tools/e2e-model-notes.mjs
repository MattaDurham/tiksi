// MODEL notes, marker toggles and EDIT IN SKETCHUP, in a real browser on a synthetic property.
// A right-click pins a note where it lands (room-linked), the menu edits and deletes it, a
// right-drag still pans, and PHOTOS / NOTES hide the pins and notes and keep that per property.
// EDIT IN SKETCHUP runs its browser half against an in-memory project folder; the local
// server's capability, mirror and open endpoints are answered here, so neither SketchUp nor
// the owner's files are involved (server/sketchup_open.py has its own tests).
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { readFile } from 'node:fs/promises';
import { dirname, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = createServer(async (req, res) => {
  const path = resolve(root, '.' + decodeURIComponent(req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0]));
  if (!path.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  try { const bytes = await readFile(path); res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.wasm': 'application/wasm' })[extname(path)] || 'application/octet-stream'); res.end(bytes); }
  catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(Number(process.env.E2E_APP_PORT) || 0, 'localhost', r));
const url = `http://localhost:${server.address().port}`;
const browser = await chromium.launch({ headless: true });

async function waitUntil(predicate, message, timeoutMs = 20_000) {
  const deadline = performance.now() + timeoutMs;
  while (!(await predicate())) {
    assert.ok(performance.now() < deadline, 'Timed out: ' + message);
    await delay(100);
  }
}
const state = page => page.evaluate(async () => {
  const s = await import('/js/store.js'), p = s.activeProperty();
  return { notes: p.notePins.map(n => ({ text: n.text, roomId: n.roomId })), showPins: p.env.showPins, showNotes: p.env.showNotes };
});
const menuItems = page => page.locator('.v-ctx button').allInnerTexts();

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(url); await page.locator('[data-prop-name]').waitFor();
  await page.evaluate(async () => {
    const store = await import('/js/store.js');
    store.ws.data = store.emptyWorkspace();
    const p = store.propertyTemplate('Notes check'); p.id = 'prop-notes'; const L = p.levels[0].id;
    const wall = (id, ax, ay, bx, by) => ({ id, level: L, ax, ay, bx, by, thickness: 0.114, height: null, material: 'mat-drywall' });
    p.walls.push(wall('w-s', 0, 0, 6, 0), wall('w-e', 6, 0, 6, 4), wall('w-n', 6, 4, 0, 4), wall('w-w', 0, 4, 0, 0));
    p.rooms.push({ id: 'r-k', level: L, name: 'Kitchen', pts: [[0, 0], [6, 0], [6, 4], [0, 4]], material: 'mat-oak', ceilingMaterial: null });
    const c = document.createElement('canvas'); c.width = 8; c.height = 6; c.getContext('2d').fillRect(0, 0, 8, 6);
    p.photos.push({ id: 'ph-tile', name: 'Tile sample', kind: 'photo', thumb: c.toDataURL('image/jpeg'), w: 8, h: 6, notes: '', roomId: 'r-k', elementIds: ['w-s'], itemIds: [],
      pin: { x: 3, y: 1.2, z: 0.06, nx: 0, ny: 0, nz: 1, size: 0.6 }, createdAt: new Date().toISOString() });
    store.ws.data.properties.push(p); store.ws.data.settings.activePropertyId = p.id;
  });
  await page.locator('#rail a[data-view="model"]').click({ noWaitAfter: true });
  await page.locator('canvas.v-canvas').waitFor();
  await page.locator('.v-modes [data-mode=top]').click();
  await delay(900);   // the camera tween to the top view
  const box = await page.locator('canvas.v-canvas').boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;

  // Right-click the floor: the menu offers a note there and both toggles with their counts.
  await page.mouse.click(cx, cy, { button: 'right' });
  await page.locator('.v-ctx').waitFor();
  assert.deepEqual(await menuItems(page), ['ADD NOTE HERE', 'HIDE NOTES (0)', 'HIDE PHOTO PINS (1)']);
  await page.locator('.v-ctx [data-ctx=add-note]').click();
  await page.locator('.v-note-edit textarea').waitFor();
  assert.equal(await page.evaluate(() => document.activeElement.tagName), 'TEXTAREA', 'the note editor takes the typing');
  await page.keyboard.type('Order 40 sq ft of tile');
  await page.keyboard.press('Enter');
  assert.deepEqual((await state(page)).notes, [{ text: 'Order 40 sq ft of tile', roomId: 'r-k' }], 'the note is saved and linked to the room under it');
  assert.equal(await page.locator('.v-note-edit').count(), 0);
  assert.equal(await page.locator('.inspector h3').first().innerText(), 'NOTE');
  assert.match(await page.locator('.v-toast').innerText(), /Note pinned in Kitchen/);
  if (process.env.E2E_SHOTS) await page.screenshot({ path: process.env.E2E_SHOTS + '/model-note.png' });

  // Right-clicking the note itself edits, moves or deletes it.
  await page.mouse.click(cx, cy, { button: 'right' });
  await page.locator('.v-ctx').waitFor();
  assert.deepEqual((await menuItems(page)).slice(0, 3), ['EDIT NOTE', 'MOVE NOTE', 'DELETE NOTE']);
  await page.locator('.v-ctx [data-ctx=edit]').click();
  assert.equal(await page.locator('.v-note-edit textarea').inputValue(), 'Order 40 sq ft of tile');
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('Order 45 sq ft of tile (10% waste)');
  await page.keyboard.press('Enter');
  assert.equal((await state(page)).notes[0].text, 'Order 45 sq ft of tile (10% waste)');

  // NOTES hides the notes: the note no longer picks, the list says so, and the toggle is kept.
  await page.locator('.v-modes [data-show=notes]').click();
  assert.equal(await page.locator('.v-modes [data-show=notes]').getAttribute('aria-pressed'), 'false');
  assert.equal((await state(page)).showNotes, false);
  await page.mouse.click(cx, cy, { button: 'right' });
  await page.locator('.v-ctx').waitFor();
  assert.deepEqual(await menuItems(page), ['ADD NOTE HERE', 'SHOW NOTES (1)', 'HIDE PHOTO PINS (1)'], 'a hidden note is not under the cursor');
  await page.locator('.v-ctx [data-ctx=toggle-notes]').click();
  assert.equal((await state(page)).showNotes, true, 'the menu shows notes again');

  // PHOTOS hides photo pins the same way.
  await page.locator('.v-modes [data-show=pins]').click();
  assert.equal(await page.locator('.v-modes [data-show=pins]').getAttribute('aria-pressed'), 'false');
  assert.equal((await state(page)).showPins, false);

  // The NOTE tool (N) places a note with a click; then the tool hands back to SELECT.
  await page.mouse.click(box.x + box.width * 0.62, box.y + box.height * 0.6);   // clear the selection
  await page.keyboard.press('n');
  assert.match(await page.locator('.v-hint').innerText(), /^NOTE: click a surface/);
  await page.mouse.click(box.x + box.width * 0.42, box.y + box.height * 0.42);
  await page.locator('.v-note-edit textarea').waitFor();
  await page.keyboard.type('Outlet moves 30 cm left');
  await page.keyboard.press('Enter');
  assert.deepEqual((await state(page)).notes.map(n => n.text), ['Order 45 sq ft of tile (10% waste)', 'Outlet moves 30 cm left']);
  assert.equal(await page.locator('.tool-col [data-act=select]').getAttribute('class').then(c => c.includes('active')), true);

  // Notes and the toggles travel in the project file.
  const saved = await page.evaluate(async () => {
    const s = await import('/js/store.js');
    const out = await s.exportProjectBlob('prop-notes'), back = await s.readBundle(new File([out.blob], 'x.tiksi'));
    const p = back.data.properties[0];
    return { notes: p.notePins.map(n => n.text), roomIds: p.notePins.map(n => n.roomId), showPins: p.env.showPins, showNotes: p.env.showNotes };
  });
  assert.deepEqual(saved, { notes: ['Order 45 sq ft of tile (10% waste)', 'Outlet moves 30 cm left'], roomIds: ['r-k', 'r-k'], showPins: false, showNotes: true });

  // DELETE NOTE from the menu (the first note sits at the centre).
  await page.mouse.click(cx, cy, { button: 'right' });
  await page.locator('.v-ctx [data-ctx=delete]').click();
  assert.deepEqual((await state(page)).notes.map(n => n.text), ['Outlet moves 30 cm left']);

  // A right-drag pans; it never opens the menu. Esc closes an open menu.
  await page.mouse.move(cx - 150, cy - 100);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(cx - 60, cy - 40, { steps: 6 });
  await page.mouse.up({ button: 'right' });
  assert.equal(await page.locator('.v-ctx').count(), 0, 'a right-drag does not open the menu');
  await page.mouse.click(cx, cy + 120, { button: 'right' });
  await page.locator('.v-ctx').waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.v-ctx').count(), 0, 'Esc closes the menu');
  console.log('ok   right-click notes: add, edit, delete, NOTE tool, right-drag pans, saved in the project');
  console.log('ok   PHOTOS / NOTES toggles hide pins and notes and are kept with the property');

  // EDIT IN SKETCHUP where the server cannot open SketchUp for this browser says why.
  let caps = { token: 'synthetic', sketchup: true, mirror: true, openSketchUp: false };
  await page.route('**/api/model-conversion/capabilities', r => r.fulfill({ json: caps }));
  await page.locator('.tool-col [data-act=sketchup]').click();
  await waitUntil(async () => /use Tiksi at localhost on that Mac/.test(await page.locator('.toast.error').innerText().catch(() => '')), 'the not-this-Mac toast');

  // Without a folder: Settings opens where the folder is chosen.
  caps = { ...caps, openSketchUp: true };
  await page.locator('.tool-col [data-act=sketchup]').click();
  await page.locator('[data-file-dialog] [data-file-panel=settings]:not([hidden])').waitFor();
  assert.match(await page.locator('[data-file-dialog] [data-file-status]').innerText(), /Choose a folder for Notes check first/);
  await page.locator('[data-close-file]').click();

  // With a folder: the mirror is brought up to date, then the server is asked to open that file.
  const asked = [];
  let openReply = { status: 200, json: { path: '/Synthetic projects/Notes check.skp', app: 'SketchUp' } };
  await page.route('**/api/model-conversion/mirror', r => {
    assert.equal(r.request().headers()['x-mirror-op'], 'write', 'a fresh mirror is written, not read');
    return r.fulfill({ body: Buffer.from('synthetic skp'), contentType: 'application/octet-stream' });
  });
  await page.route('**/api/model-conversion/open-in-sketchup', r => {
    asked.push({ body: r.request().postDataJSON(), token: r.request().headers()['x-tiksi-token'] });
    return r.fulfill(openReply);
  });
  await page.evaluate(async () => {
    const files = await import('/js/files.js');
    const entries = new Map(); let clock = 1_790_000_000_000;
    window.__folder = entries;
    const fileHandle = name => ({
      kind: 'file', name,
      async getFile() { const f = entries.get(name); return new File([f.bytes], name, { lastModified: f.mtime }); },
      async createWritable() {
        const parts = [];
        return { async write(b) { parts.push(new Uint8Array(await new Response(b).arrayBuffer())); },
          async close() { const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0)); let o = 0; for (const x of parts) { out.set(x, o); o += x.length; } entries.set(name, { bytes: out, mtime: ++clock }); } };
      },
    });
    const folder = {
      kind: 'directory', name: 'Synthetic projects',
      async getFileHandle(name, opts) {
        if (!entries.has(name)) { if (!(opts && opts.create)) { const e = new Error('missing'); e.name = 'NotFoundError'; throw e; } entries.set(name, { bytes: new Uint8Array(0), mtime: ++clock }); }
        return fileHandle(name);
      },
      async removeEntry(name) { entries.delete(name); },
      async *entries() { for (const name of entries.keys()) yield [name, fileHandle(name)]; },
    };
    const st = files.filesState(); st.folder = folder; st.folderName = folder.name; st.folderMap = {};
  });
  await page.locator('.tool-col [data-act=sketchup]').click();
  await waitUntil(async () => /Opened Notes check\.skp in SketchUp/.test(await page.locator('.toast').innerText().catch(() => '')), 'the open confirmation');
  const folder = await page.evaluate(() => Object.fromEntries([...window.__folder].map(([k, v]) => [k, { size: v.bytes.length, mtime: v.mtime }])));
  assert.deepEqual(Object.keys(folder).sort(), ['Notes check.skp', 'Notes check.tiksi'], 'the project and its SketchUp model are in the folder');
  assert.equal(asked.length, 1);
  assert.equal(asked[0].token, 'synthetic');
  assert.deepEqual(asked[0].body, { name: 'Notes check.skp', size: folder['Notes check.skp'].size, mtime: folder['Notes check.skp'].mtime, folder: 'Synthetic projects', parent: '', hint: '' },
    'the server is told which file to find');

  // The path found is the next lookup's hint; a failure is reported as the server words it.
  openReply = { status: 404, json: { error: 'Could not find Notes check.skp on this Mac.' } };
  await page.locator('.v-modes [data-mode=orbit]').click();   // the PLAN button does the same
  await page.locator('#rail a[data-view="plan"]').click({ noWaitAfter: true });
  await page.locator('.tool-col [data-act=sketchup]').click();
  await waitUntil(async () => /Could not find Notes check\.skp on this Mac/.test(await page.locator('.toast.error').innerText().catch(() => '')), 'the failure toast');
  assert.equal(asked.length, 2);
  assert.equal(asked[1].body.hint, '/Synthetic projects/Notes check.skp');
  console.log('ok   EDIT IN SKETCHUP: says when it cannot, asks for a folder, writes the .skp, opens it through the server, reports failures');
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  server.close();
}
