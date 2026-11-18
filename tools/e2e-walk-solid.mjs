// WALK in MODEL with solid surfaces, in a real browser on a synthetic property: a room whose
// walls, island and door come from an imported model (written the way the SketchUp converter
// writes one), with one partition drawn in the plan. A person stops a body short of the
// model's walls, the island and the plan's partition, and slides along them; the part named
// as a door lets them through; looking around turns the eye where it stands, also after MODEL
// rebuilds itself round a walking person; a double-click goes to the spot and a single click
// does not.
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

async function waitUntil(predicate, message, timeoutMs = 30_000) {
  const deadline = performance.now() + timeoutMs;
  while (!(await predicate())) {
    assert.ok(performance.now() < deadline, 'Timed out: ' + message);
    await delay(150);
  }
}
const prop = (page, body) => page.evaluate(new Function('return import("/js/store.js").then(s => { const p = s.activeProperty(); ' + body + ' })'));
const viewer = (page, body, arg) => page.evaluate(new Function('arg', 'return import("/js/viewer3d.js").then(v => { ' + body + ' })'), arg);
const idle = page => waitUntil(() => viewer(page, 'return v.viewerIdle()'), 'MODEL has settled', 120_000);
const BODY = 0.3;
const near = (a, b, tol = 0.04) => Math.abs(a - b) <= tol;

try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  // The test browser has no mouse to capture: a click while walking asks for it, is refused, and
  // the refusal (and the pointer capture it upsets) is reported as a page error. Not a fault.
  const NO_MOUSE_CAPTURE = /not valid for pointer lock|Failed to execute 'setPointerCapture'/;
  page.on('pageerror', e => { if (!NO_MOUSE_CAPTURE.test(e.message)) errors.push(e.message); });
  await page.goto(url + '/#/materials');
  await page.locator('#btn-file').waitFor({ state: 'attached' });
  await page.evaluate(async () => {
    const s = await import('/js/store.js');
    const THREE = await import('three');
    const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
    localStorage.removeItem('tiksi.onScreen.v1');
    s.ws.data = s.emptyWorkspace();
    const p = s.propertyTemplate('Solid house'); p.id = 'prop-solid';
    const L = p.levels[0].id;
    // The plan: the room's floor, and one partition 1.2 m long standing out from the south wall.
    p.rooms.push({ id: 'r-1', level: L, name: 'Room', pts: [[0, 0], [6, 0], [6, 4], [0, 4]], material: null, ceilingMaterial: null });
    p.walls.push({ id: 'w-part', level: L, ax: 3, ay: 0, bx: 3, by: 1.2, thickness: 0.1, height: null, material: null });
    // The model: four walls 0.1 m thick round x 0..6, z 0..4 (the east one with a gap 0.8 m
    // wide at z 1.6..2.4, filled by a door), and an island.
    const scene = new THREE.Scene();
    const box = (name, x0, x1, z0, z1, h, color, y0 = 0) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, h, z1 - z0), new THREE.MeshStandardMaterial({ color }));
      m.name = name; m.position.set((x0 + x1) / 2, y0 + h / 2, (z0 + z1) / 2); return m;
    };
    const walls = new THREE.Group(); walls.name = 'Walls';
    walls.add(box('Wall south', -0.05, 6.05, -0.05, 0.05, 2.4, 0xdddddd), box('Wall north', -0.05, 6.05, 3.95, 4.05, 2.4, 0xdddddd),
      box('Wall west', -0.05, 0.05, 0.05, 3.95, 2.4, 0xdddddd), box('Wall east a', 5.95, 6.05, 0.05, 1.6, 2.4, 0xdddddd), box('Wall east b', 5.95, 6.05, 2.4, 3.95, 2.4, 0xdddddd));
    const door = new THREE.Group(); door.name = 'Door 2-8'; door.userData = { sketchupComponent: 'Door 2-8', sketchupDefinitionId: 'guid-door' };
    door.add(box('Door 2-8', 5.98, 6.02, 1.6, 2.4, 2.03, 0x8a6a4a));
    scene.add(walls, door, box('Island', 1, 2, 2.9, 3.5, 0.9, 0x777766));
    const glb = await new GLTFExporter().parseAsync(scene, { binary: true });
    await s.putFile('scan-house', glb, { format: 'glb' });
    p.scans.push({ id: 'scan-house', name: 'House.glb', format: 'glb', kind: 'mesh', pos: [0, 0, 0], rot: [0, 0, 0], rotY: 0, scale: 1, visible: true });
    s.ws.data.properties.push(p); s.ws.data.settings.activePropertyId = p.id;
    s.touch();
  });
  await page.locator('#rail a[data-view="model"]').click({ noWaitAfter: true });
  await page.locator('canvas.v-canvas').waitFor();
  await waitUntil(async () => (await prop(page, 'return Object.keys(p.tagOf).filter(k => k.startsWith("node:")).length')) === 7, 'the model is tagged');
  await idle(page);

  // Walk: the person starts a third of the way along the room, looking down its length (+x).
  await page.keyboard.press('KeyW');
  await waitUntil(async () => (await viewer(page, 'return v.cameraState().mode')) === 'walk', 'WALK is on');
  const pos = async () => { const c = await viewer(page, 'return v.cameraState().position'); return { x: c[0], y: c[1], z: c[2] }; };
  const start = await pos();
  assert.ok(near(start.x, 1.8) && near(start.z, 2) && near(start.y, 1.6), 'the walk starts in the room at eye height: ' + JSON.stringify(start));
  const probe = (x, z, mx, mz, steps) => viewer(page, 'return v.walkProbe(...arg)', [x, z, mx, mz, steps]);

  // The imported model's walls are solid.
  let end = await probe(4.5, 2, 0, -0.08, 60);
  assert.ok(near(end.z, 0.05 + BODY) && near(end.x, 4.5) && end.blocked && end.clear, 'walking at the model\'s south wall stops a body short of it: ' + JSON.stringify(end));
  end = await probe(4.5, 3.2, 0.08, 0, 60);
  assert.ok(near(end.x, 5.95 - BODY) && end.clear, 'and at its east wall beside the door: ' + JSON.stringify(end));
  // A wall met at a slant is slid along, never crossed.
  end = await probe(4, 1, 0.05, -0.05, 40);
  assert.ok(end.x > 5 && end.x < 5.95 - BODY + 0.04 && near(end.z, 0.05 + BODY), 'a slanted walk slides along the south wall into the corner: ' + JSON.stringify(end));
  // The island (waist high) is solid too.
  end = await probe(1.5, 2, 0, 0.08, 40);
  assert.ok(near(end.z, 2.9 - BODY), 'the island stops a body: ' + JSON.stringify(end));
  // The plan's partition is solid from both sides.
  end = await probe(2, 0.6, 0.08, 0, 40);
  assert.ok(near(end.x, 2.95 - BODY), 'the plan\'s partition stops a body from the west: ' + JSON.stringify(end));
  end = await probe(4, 0.6, -0.08, 0, 40);
  assert.ok(near(end.x, 3.05 + BODY), 'and from the east: ' + JSON.stringify(end));
  // The part named as a door lets a person through; the wall beside it does not.
  end = await probe(4.5, 2, 0.08, 0, 60);
  assert.ok(end.x > 8 && near(end.z, 2, 0.1), 'the door lets a body through: ' + JSON.stringify(end));
  // A long step cannot jump a wall.
  end = await probe(3.5, 3, 0, 5, 1);
  assert.ok(end.z < 3.95, 'a 5 m step north ends inside the room: ' + JSON.stringify(end));

  // With the keys: forward through the door, back in, then sideways into the north wall and
  // forward into the corner. A key is held until the person gets there, or stops moving.
  const holdUntil = async (key, there, what) => {
    await page.keyboard.down(key);
    try { await waitUntil(async () => there(await pos()), what, 60_000); }
    finally { await page.keyboard.up(key); }
    await page.waitForTimeout(150);
  };
  const holdUntilStill = async (key, what) => {
    let last = await pos(), still = 0;
    await page.keyboard.down(key);
    try {
      await waitUntil(async () => {
        await page.waitForTimeout(400);
        const now = await pos();
        still = Math.hypot(now.x - last.x, now.z - last.z) < 1e-6 ? still + 1 : 0;
        last = now;
        return still >= 3;
      }, what, 90_000);
    } finally { await page.keyboard.up(key); }
    await page.waitForTimeout(150);
    return last;
  };
  await holdUntil('KeyW', p => p.x > 6.6, 'W walks out through the door');
  let at = await pos();
  assert.ok(near(at.z, 2, 0.1), 'straight through it: ' + JSON.stringify(at));
  await holdUntil('KeyS', p => p.x < 5, 'S walks back in');
  at = await holdUntilStill('KeyD', 'D walks until the north wall stops it');
  assert.ok(near(at.z, 3.95 - BODY, 0.05) && at.x < 5.95 - BODY + 0.04 && near(at.y, 1.6, 1e-6), 'D stops a body short of the north wall: ' + JSON.stringify(at));
  at = await holdUntilStill('KeyW', 'W walks until the east wall stops it');
  assert.ok(near(at.x, 5.95 - BODY, 0.05) && near(at.z, 3.95 - BODY, 0.05), 'and W ends in the corner, inside the room: ' + JSON.stringify(at));
  assert.ok((await viewer(page, 'return v.walkSolidState(...arg)', [at.x, at.z])).clear, 'where a body stands clear');

  // Looking around turns the eye where it stands.
  const box = await page.locator('canvas.v-canvas').boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx + 420, cy + 60, { steps: 12 }); await page.mouse.up();
  await page.waitForTimeout(200);
  const turned = await pos();
  assert.ok(Math.hypot(turned.x - at.x, turned.z - at.z) < 1e-9 && turned.y === at.y, 'a drag to look moves the eye nowhere: ' + JSON.stringify(turned));

  // A rebuild of MODEL that keeps the picture (another device's change) keeps the walk: the
  // person is still walking where they stood, and a drag still only turns them. (It used to
  // leave them in orbit, and the drag swung them out through the wall beside them.)
  await viewer(page, 'v.keepViewOnNextMount()');
  await page.locator('#rail a[data-view="photos"]').click({ noWaitAfter: true });
  await page.locator('canvas.v-canvas').waitFor({ state: 'detached' });
  await page.locator('#rail a[data-view="model"]').click({ noWaitAfter: true });
  await page.locator('canvas.v-canvas').waitFor();
  await idle(page);
  assert.equal(await viewer(page, 'return v.cameraState().mode'), 'walk', 'the rebuilt view is still walking');
  const back = await pos();
  assert.ok(Math.hypot(back.x - turned.x, back.z - turned.z) < 1e-6 && near(back.y, 1.6, 1e-6), 'where the person stood: ' + JSON.stringify(back));
  await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx - 380, cy + 40, { steps: 12 }); await page.mouse.up();
  await page.waitForTimeout(200);
  const after = await pos();
  assert.ok(Math.hypot(after.x - back.x, after.z - back.z) < 1e-9 && after.x < 5.95 && after.z < 3.95, 'and a drag to look leaves them inside the room: ' + JSON.stringify(after));

  // A single click goes nowhere; a double-click goes to the spot.
  await page.keyboard.press('Escape');
  await page.keyboard.press('KeyW');
  await page.waitForTimeout(500);
  const from = await pos();
  await page.mouse.click(cx, box.y + box.height * 0.85);
  await page.waitForTimeout(1200);
  const single = await pos();
  assert.ok(Math.hypot(single.x - from.x, single.z - from.z) < 1e-9, 'a single click goes nowhere');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  if ((await viewer(page, 'return v.cameraState().mode')) !== 'walk') { await page.keyboard.press('KeyW'); await page.waitForTimeout(500); }
  const again = await pos();
  // The spot is on the north wall, off to the right: the person goes toward it and stops short.
  await page.mouse.dblclick(cx + box.width * 0.3, cy);
  await page.waitForTimeout(3000);
  const went = await pos();
  assert.ok(Math.hypot(went.x - again.x, went.z - again.z) > 0.3 && near(went.y, 1.6, 1e-6), 'a double-click goes toward the spot at eye height: ' + JSON.stringify([again, went]));
  assert.ok(went.x > 0.05 + BODY - 0.04 && went.x < 5.95 && went.z > 0.05 + BODY - 0.04 && went.z < 3.95 - BODY + 0.04, 'and ends inside the room, clear of its walls: ' + JSON.stringify(went));
  assert.ok((await viewer(page, 'return v.walkSolidState(...arg)', [went.x, went.z])).clear, 'where a body stands clear');

  assert.deepEqual(errors, [], 'no page errors: ' + errors.join(' | '));
  console.log('walk solid: model walls, island, plan partition, door, sliding, looking, a rebuild, single and double click OK');
} finally {
  await browser.close();
  server.close();
}
