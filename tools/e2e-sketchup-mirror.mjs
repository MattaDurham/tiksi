// SketchUp mirror through the real project-folder sync: Tiksi writes <name>.tiksi and
// <name>.skp, a SketchUp-side edit (made with the installed SDK) is picked up by the poll and
// merged, and the .tiksi follows. The folder is an in-memory stand-in for the directory
// picker. Without SketchUp the check confirms the mirror reports itself unavailable.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import net from 'node:net';
import { chromium } from 'playwright';

const root = resolve(new URL('..', import.meta.url).pathname), state = await mkdtemp(tmpdir() + '/tiksi-mirror-');
const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r)); const port = socket.address().port; await new Promise(r => socket.close(r));
const child = spawn('python3', ['tools/serve.py', '--port', String(port), '--state-dir', state], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
const url = 'http://127.0.0.1:' + port;
let browser;
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(url)).ok) break; } catch {} await new Promise(r => setTimeout(r, 50)); }
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(url); await page.locator('[data-prop-name]').waitFor();

  const first = await page.evaluate(async () => {
    const store = await import('/js/store.js'), files = await import('/js/files.js');
    store.ws.data = store.emptyWorkspace();
    const p = store.propertyTemplate('Mirror check'); p.id = 'prop-mirror-check'; const L = p.levels[0].id;
    const wall = (id, ax, ay, bx, by) => ({ id, level: L, ax, ay, bx, by, thickness: 0.114, height: null, material: 'mat-drywall' });
    p.walls.push(wall('w-s', 0, 0, 5, 0), wall('w-e', 5, 0, 5, 3.5), wall('w-n', 5, 3.5, 0, 3.5), wall('w-w', 0, 3.5, 0, 0));
    p.openings.push({ id: 'o-d', wallId: 'w-s', type: 'door', t: 0.2, width: 0.914, height: 2.032 });
    p.rooms.push({ id: 'r-1', level: L, name: 'Living', pts: [[0, 0], [5, 0], [5, 3.5], [0, 3.5]], material: 'mat-oak', ceilingMaterial: null });
    store.ws.data.properties.push(p); store.ws.data.settings.activePropertyId = p.id;
    // In-memory folder with the FileSystemDirectoryHandle calls files.js uses.
    const entries = new Map(); let clock = Date.now();
    window.__mirrorFolder = entries;
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
    await files.syncFolder();
    const skp = entries.get('Mirror check.skp');
    return { names: [...entries.keys()].sort(), mirror: st.mirror.available, status: files.mirrorStatus(p.id),
      skp: skp ? btoa(String.fromCharCode(...skp.bytes)) : null };
  });

  if (!first.mirror) {
    assert.deepEqual(first.names, ['Mirror check.tiksi']);
    assert.match(first.status, /needs the local Tiksi server on a Mac with SketchUp/);
    console.log('SKIP SketchUp mirror round trip: SketchUp is not installed here (status reported correctly)');
  } else {
    assert.deepEqual(first.names, ['Mirror check.skp', 'Mirror check.tiksi'], 'project folder holds the project and its mirror');
    assert.match(first.status, /SketchUp mirror: Mirror check\.skp, written/);
    // Edit like SketchUp: move the east wall 0.5 m east with the SDK, then save.
    const work = await mkdtemp(tmpdir() + '/tiksi-mirror-edit-');
    await writeFile(join(work, 'in.skp'), Buffer.from(first.skp, 'base64'));
    execFileSync('python3', ['-c', `
import sys, ctypes as C
sys.path.insert(0, ${JSON.stringify(root)})
from server.sketchup_convert import API, Ref, Transform
from server.sketchup_mirror import get_data, to_ref, matrix
api = API(); m = Ref()
api.call('SUModelCreateFromFile', C.byref(m), sys.argv[1].encode())
for g in api.collection(api.ref('SUModelGetEntities', m), 'Groups'):
    d = get_data(api, to_ref(api, 'SUGroupToEntity', g))
    if d and d.get('id') == 'w-e':
        t = Transform(); api.call('SUGroupGetTransform', g, C.byref(t)); v = matrix(t); v[12] += 0.5 / 0.0254; t.values[:] = v
        api.call('SUGroupSetTransform', g, C.byref(t))
api.call('SUModelSaveToFile', m, sys.argv[2].encode()); api.call('SUModelRelease', C.byref(m)); api.lib.SUTerminate()
`, join(work, 'in.skp'), join(work, 'out.skp')]);
    const edited = (await readFile(join(work, 'out.skp'))).toString('base64');
    await rm(work, { recursive: true, force: true });
    const second = await page.evaluate(async b64 => {
      const store = await import('/js/store.js'), files = await import('/js/files.js');
      const bin = atob(b64), bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const before = window.__mirrorFolder.get('Mirror check.tiksi').mtime;
      window.__mirrorFolder.set('Mirror check.skp', { bytes, mtime: Date.now() + 60000 });   // saved in SketchUp
      // The poll notices within a few seconds, the merge touches the property, the folder sync rewrites the .tiksi.
      const p = () => store.ws.data.properties.find(x => x.id === 'prop-mirror-check');
      for (let i = 0; i < 200 && !(p().walls.find(w => w.id === 'w-e').ax === 5.5 && window.__mirrorFolder.get('Mirror check.tiksi').mtime !== before); i++) await new Promise(r => setTimeout(r, 100));
      const east = p().walls.find(w => w.id === 'w-e');
      const saved = await store.readBundle(new File([window.__mirrorFolder.get('Mirror check.tiksi').bytes], 'x.tiksi'));
      return { east: [east.ax, east.bx], tiksiEast: saved.data.properties[0].walls.find(w => w.id === 'w-e').ax, status: files.mirrorStatus('prop-mirror-check') };
    }, edited);
    assert.deepEqual(second.east, [5.5, 5.5], 'SketchUp move reached the Tiksi plan');
    assert.equal(second.tiksiEast, 5.5, 'the .tiksi in the folder was rewritten with the SketchUp change');
    assert.match(second.status, /Last SketchUp save \(\d\d:\d\d\): 1 changed, 0 added, 0 deleted\./);
    console.log('ok   SketchUp mirror written beside the project, SketchUp edit merged into Tiksi and saved');
  }
  assert.deepEqual(errors, []);
} finally {
  if (browser) await browser.close();
  child.kill();
  await rm(state, { recursive: true, force: true });
}
