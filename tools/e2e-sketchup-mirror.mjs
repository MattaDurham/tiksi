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
  // Without SketchUp the mirror is unavailable: confirm the service says so over HTTP and
  // skip the browser, which keeps this check cheap on CI runners.
  const caps = await (await fetch(url + '/api/model-conversion/capabilities')).json();
  if (!caps.mirror) {
    const r = await fetch(url + '/api/model-conversion/mirror', { method: 'POST', body: new Uint8Array([1, 2, 3]),
      headers: { 'X-Tiksi-Token': caps.token, 'X-Mirror-Op': 'read', 'Content-Type': 'application/octet-stream' } });
    assert.equal(r.status, 422, 'the mirror endpoint refuses without SketchUp');
    assert.match((await r.json()).error, /needs SketchUp installed/);
    console.log('SKIP SketchUp mirror round trip: SketchUp is not installed here (service reports it unavailable)');
  } else {
    browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(url); await page.waitForFunction(() => document.querySelector('#save-status').textContent === 'SAVED TO DISK');

    const first = await page.evaluate(async () => {
      const store = await import('/js/store.js'); window.diskTestStore = store;
      store.ws.data = store.emptyWorkspace();
      const p = store.propertyTemplate('Mirror check'); p.id = 'prop-mirror-check'; const L = p.levels[0].id;
      const wall = (id, ax, ay, bx, by) => ({ id, level: L, ax, ay, bx, by, thickness: 0.114, height: null, material: 'mat-drywall' });
      p.walls.push(wall('w-s', 0, 0, 5, 0), wall('w-e', 5, 0, 5, 3.5), wall('w-n', 5, 3.5, 0, 3.5), wall('w-w', 0, 3.5, 0, 0));
      p.openings.push({ id: 'o-d', wallId: 'w-s', type: 'door', t: 0.2, width: 0.914, height: 2.032 });
      p.rooms.push({ id: 'r-1', level: L, name: 'Living', pts: [[0, 0], [5, 0], [5, 3.5], [0, 3.5]], material: 'mat-oak', ceilingMaterial: null });
      // A scan-rendered underlay is WebP, which the SketchUp SDK cannot read; the mirror must still write it.
      const c = document.createElement('canvas'); c.width = 64; c.height = 48;
      const g = c.getContext('2d'); g.fillStyle = '#7a5236'; g.fillRect(0, 0, 64, 48); g.fillStyle = '#e8e2d4'; g.fillRect(8, 8, 48, 32);
      p.levels[0].plan = { img: c.toDataURL('image/webp'), imgW: 64, imgH: 48, mPerPx: 0.1, offsetX: -0.5, offsetY: -0.5, opacity: 0.6, calibrated: true, source: 'scan' };
      store.ws.data.properties.push(p); store.ws.data.settings.activePropertyId = p.id;
      store.touch();
      const disk = (await import('/js/disk-workspace.js')).diskWorkspace;
      await disk.sync(); await disk.syncSketchUp(p);
      return { path: disk.paths[p.id] };

    });

    {
      const modelPath = first.path.replace(/\.tiksi$/i, '.skp');
      assert((await readFile(first.path)).length > 0, 'the canonical project file exists');
      const modelBytes = await readFile(modelPath);
      // Edit like SketchUp: move the east wall 0.5 m east with the SDK, then save.
      const work = await mkdtemp(tmpdir() + '/tiksi-mirror-edit-');
      await writeFile(join(work, 'in.skp'), modelBytes);
      const images = execFileSync('python3', ['-c', `
import sys, ctypes as C
sys.path.insert(0, ${JSON.stringify(root)})
from server.sketchup_convert import API, Ref, Transform
from server.sketchup_mirror import get_data, to_ref, matrix
api = API(); m = Ref()
api.call('SUModelCreateFromFile', C.byref(m), sys.argv[1].encode())
print(len(api.collection(api.ref('SUModelGetEntities', m), 'Images')))
for g in api.collection(api.ref('SUModelGetEntities', m), 'Groups'):
      d = get_data(api, to_ref(api, 'SUGroupToEntity', g))
      if d and d.get('id') == 'w-e':
          t = Transform(); api.call('SUGroupGetTransform', g, C.byref(t)); v = matrix(t); v[12] += 0.5 / 0.0254; t.values[:] = v
          api.call('SUGroupSetTransform', g, C.byref(t))
api.call('SUModelSaveToFile', m, sys.argv[2].encode()); api.call('SUModelRelease', C.byref(m)); api.lib.SUTerminate()
`, join(work, 'in.skp'), join(work, 'out.skp')]).toString().trim();
      assert.equal(images, '1', 'the WebP underlay reached the .skp as an image');
      await writeFile(modelPath, await readFile(join(work, 'out.skp')));
      await rm(work, { recursive: true, force: true });
      await page.waitForFunction(() => window.diskTestStore.ws.data.properties.find(p => p.id === 'prop-mirror-check')?.walls.find(w => w.id === 'w-e')?.ax === 5.5, null, { timeout: 40000 });
      const second = await page.evaluate(async () => {
        const store = await import('/js/store.js');
        await (await import('/js/disk-workspace.js')).diskWorkspace.sync();
        const east = store.ws.data.properties.find(p => p.id === 'prop-mirror-check').walls.find(w => w.id === 'w-e');
        return [east.ax, east.bx];
      });
      assert.deepEqual(second, [5.5, 5.5], 'SketchUp move reached the shared Tiksi plan');
      const saved = execFileSync('python3', ['-c', 'import json,zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);d=json.loads(z.read("workspace.json"));print(next(w["ax"] for w in d["properties"][0]["walls"] if w["id"]=="w-e"))', first.path]).toString().trim();
      assert.equal(saved, '5.5', 'canonical project contains the SketchUp move');
      console.log('ok   SketchUp mirror written beside the project, SketchUp edit merged into Tiksi and saved');
    }
    assert.deepEqual(errors, []);
  }
} finally {
  if (browser) await browser.close();
  child.kill();
  await rm(state, { recursive: true, force: true });
}
