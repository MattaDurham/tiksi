// PAINT (js/paint-tool.js, js/wall-regions.js), with real clicks on the rendered model.
//
//   one piece    with a finish chosen, a click on the wall above a chair rail paints that piece
//                and nothing else: one paint mark on the wall, the piece drawn in the finish,
//                the wall below the rail as it was; one UNDO takes it back
//   the panel    pointing at a piece names it, with its square feet and the finish it wears
//   the room     Shift-click paints the same band of every wall of the room, and no other room
//   trim         a click paints one trim section; Shift-click all of the room's trim
//   pick up      Alt-click takes the finish under the pointer as the one to paint with
//   whole wall   Cmd-click paints the face floor to ceiling and clears the marks on it
//   floor        a click on a floor paints that room's floor
//   a door       a click on a door paints it with its frame and casing
//   paint off    NO PAINT OF ITS OWN takes a piece's paint off again
//   select       back in SELECT, a divided wall face lists its pieces with their finishes
//
// Synthetic project and temporary runtime only; never uses the owner's stores.
// Run: node tools/e2e-paint.mjs (Playwright + Chromium installed).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { chromium } from 'playwright';

const root = process.env.E2E_ROOT || process.cwd();
const state = await mkdtemp(tmpdir() + '/tiksi-paint-');
const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r));
const port = Number(process.env.E2E_APP_PORT) || socket.address().port; await new Promise(r => socket.close(r));
const child = spawn('python3', ['tools/serve.py', '--port', String(port), '--state-dir', state, '--projects-dir', state + '/projects'], { cwd: root, stdio: 'ignore' });
let browser;
const ok = label => console.log('  ok   ' + label);
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch('http://127.0.0.1:' + port)).ok) break; } catch {} await new Promise(r => setTimeout(r, 50)); }
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(60000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const saved = () => page.waitForFunction(() => document.querySelector('#save-status')?.textContent === 'SAVED TO DISK', null, { timeout: 120000 });
  await page.goto('http://127.0.0.1:' + port + '/#/budget');
  await saved();
  // The 8 x 4 m house of e2e-wall-faces.mjs (x east, y south; world z = plan y): a kitchen and
  // a living room either side of a partition at x = 3. Every kitchen wall has a chair rail and
  // the west wall a baseboard too; the living room has one rail, on its east wall.
  await page.evaluate(async () => {
    const s = window.testStore = await import('/js/store.js');
    const { trimTemplate } = await import('/js/trims.js');
    const p = s.propertyTemplate('Paint test');
    p.id = 'paint-house'; p.env.quality = 'low'; p.env.showCeilings = false;
    const L = p.levels[0].id;
    p.levels[0].height = 2.5;
    const wall = (id, ax, ay, bx, by) => ({ id, level: L, ax, ay, bx, by, thickness: 0.15, height: null, material: 'mat-drywall' });
    p.walls.push(wall('n1', 0, 0, 5, 0), wall('n2', 5, 0, 8, 0), wall('e', 8, 0, 8, 4), wall('s', 8, 4, 0, 4), wall('w', 0, 4, 0, 0), wall('mid', 3, 0, 3, 4));
    p.rooms.push({ id: 'k', level: L, name: 'Kitchen', pts: [[0, 0], [3, 0], [3, 4], [0, 4]], material: 'mat-oak', ceilingMaterial: null },
      { id: 'l', level: L, name: 'Living', pts: [[3, 0], [8, 0], [8, 4], [3, 4]], material: 'mat-oak', ceilingMaterial: null });
    p.openings.push({ id: 'door', wallId: 'mid', type: 'door', t: 0.5, width: 0.9, height: 2.03 });
    const trim = (id, style, wallId, side, at) => ({ ...trimTemplate(style, null, p.walls.find(w => w.id === wallId), side, { wallHeight: 2.5, ...at }), id });
    p.trims = [trim('rail-w', 'chair-rail', 'w', 1), trim('rail-n', 'chair-rail', 'n1', 1, { f0: 0, f1: 0.6 }), trim('rail-s', 'chair-rail', 's', 1, { f0: 0.625, f1: 1 }),
      trim('rail-mid', 'chair-rail', 'mid', 1), trim('base-w', 'baseboard', 'w', 1), trim('rail-e', 'chair-rail', 'e', 1)];
    const { normalizeSavedView } = await import('/js/saved-views.js');
    p.savedViews = [
      { id: 'v-west', name: 'West', camera: { position: [2.6, 3.2, 2], target: [0.075, 1.1, 2], fov: 50 } },
      { id: 'v-east', name: 'East', camera: { position: [0.4, 3.2, 2], target: [2.925, 1.1, 2], fov: 50 } },
    ].map(v => normalizeSavedView(v, new Set()));
    s.ws.data.settings.sketchupMirror = false; s.ws.data.settings.units = 'imperial';
    s.ws.data.properties.push(p); s.ws.data.settings.activePropertyId = p.id; s.touch();
    await (await import('/js/disk-workspace.js')).diskWorkspace.sync();
  });

  const waitUntil = async (check, what, tries = 150) => {
    for (let i = 0; i < tries; i++) { if (await check()) return; await page.waitForTimeout(200); }
    assert.fail('timed out waiting until ' + what + (errors.length ? ' (page errors: ' + errors.join(' | ') + ')' : ''));
  };
  const idle = () => waitUntil(() => page.evaluate(async () => (await import('/js/viewer3d.js')).viewerIdle()), 'MODEL has settled');
  const canvas = page.locator('canvas.v-canvas'), heading = page.locator('.inspector h3').first();
  const screenOf = p => page.evaluate(async p => {
    const THREE = await import('three'), c = (await import('/js/viewer3d.js')).markupState().camera;
    const r = document.querySelector('canvas.v-canvas').getBoundingClientRect();
    const cam = new THREE.PerspectiveCamera(c.fov, r.width / r.height, 0.05, 3000);
    cam.position.set(...c.position); cam.lookAt(new THREE.Vector3(...c.target)); cam.updateMatrixWorld();
    const q = new THREE.Vector3(...p).project(cam);
    return { x: r.left + (q.x + 1) / 2 * r.width, y: r.top + (1 - q.y) / 2 * r.height };
  }, p);
  // A click waits for MODEL to settle first: on a software GL a new finish's first frame blocks
  // the page, and a click sent into that is not answered until it ends.
  const clickAt = async (p, key) => {
    await idle();
    const q = await screenOf(p);
    if (key) await page.keyboard.down(key);
    await page.mouse.click(q.x, q.y);
    if (key) await page.keyboard.up(key);
  };
  const hoverAt = async p => { const q = await screenOf(p); await page.mouse.move(q.x - 3, q.y - 3); await page.mouse.move(q.x, q.y); await page.waitForTimeout(150); };
  // What the store holds, and what the view draws.
  const marks = () => page.evaluate(() => Object.fromEntries(window.testStore.activeProperty().walls.map(w => [w.id, (w.paint || []).map(m => m.side + ':' + m.material)])));
  const drawn = () => page.evaluate(async () => {
    const out = {};
    for (const f of (await import('/js/viewer3d.js')).regionFinishes()) (out[f.faceId.split(':').slice(1, 4).join(':')] ||= {})[f.region] = f.material;
    return out;
  });
  const trims = () => page.evaluate(() => Object.fromEntries(window.testStore.activeProperty().trims.map(t => [t.id, t.material || null])));
  const choose = async id => {
    const swatch = page.locator(`.inspector [data-pt-mat="${id}"]`);
    if (!(await swatch.count())) await page.locator('.inspector [data-pt-filter="all"]').click();
    await swatch.click();
    await waitUntil(async () => (await page.evaluate(async () => (await import('/js/viewer3d.js')).paintState().material)) === id, 'the finish is in hand');
  };
  const undo = () => page.keyboard.press('ControlOrMeta+z');

  await page.locator('#rail [data-view=model]').click();
  await canvas.waitFor();
  await idle();
  await page.evaluate(() => document.querySelector('[data-view-go="v-west"]').click());
  await page.waitForTimeout(900); await idle();
  // Points on the kitchen's west wall face (x = 0.075): above and below the rail (0.84 m up).
  // They lie right of the component list, which covers the left of the view.
  const ABOVE = [0.076, 1.6, 1.3], BELOW = [0.076, 0.5, 1.3], RAIL = [0.085, 0.87, 1.3], FLOOR = [0.6, 0.001, 1.6];
  for (const p of [ABOVE, BELOW, RAIL, FLOOR]) {
    const q = await screenOf(p);
    assert.equal(await page.evaluate(q => document.elementFromPoint(q.x, q.y)?.tagName, q), 'CANVAS', 'the test point ' + p + ' is on the open view');
  }
  const WEST = 'k:w:p';

  // ---------- one piece ----------
  await page.keyboard.press('b');
  await waitUntil(async () => (await heading.textContent()) === 'PAINT', 'B opens PAINT');
  assert.match(await page.locator('.inspector .pt-current').textContent(), /No finish chosen/);
  await choose('mat-paint-navy');
  await hoverAt(ABOVE);
  await waitUntil(async () => (await page.locator('[data-pt-under] b').count()) > 0, 'the panel names the piece under the pointer');
  const under = await page.locator('[data-pt-under]').textContent();
  assert.match(under, /Kitchen, west wall, above the chair rail/);
  const area = await page.evaluate(async () => {
    const s = window.testStore, p = s.activeProperty(), L = p.levels[0].id;
    const { roomFaces } = await import('/js/room-faces.js'), { faceRegions } = await import('/js/wall-regions.js');
    const ctx = { walls: s.wallsOn(p, L), rooms: s.roomsOn(p, L), openings: s.openingsOn(p, L), trims: p.trims, heightOf: w => w.height || s.levelHeight(p, L) };
    const face = roomFaces(ctx).find(f => f.label === 'Kitchen, west wall');
    return faceRegions(face, ctx).regions.map(r => s.fmtArea(r.area));
  });
  assert.equal(area.length, 2, 'the west wall is two pieces: below and above the rail');
  assert.ok(under.includes(area[1]), 'its square feet: ' + area[1] + ' in "' + under + '"');
  assert.match(under, /Now: Drywall, painted/);
  assert.ok((await page.evaluate(async () => (await import('/js/viewer3d.js')).paintState().hover)) > 0, 'and outlines it');
  await clickAt(ABOVE);
  await waitUntil(async () => (await marks()).w.length === 1, 'the click leaves one paint mark on the west wall');
  assert.deepEqual((await marks()).w, ['1:mat-paint-navy']);
  let d = (await drawn())[WEST];
  assert.deepEqual(Object.values(d).sort(), ['mat-drywall', 'mat-paint-navy'], 'above the rail in navy, below it as it was');
  assert.equal(Object.values(await marks()).flat().length, 1, 'no other wall is touched');
  ok('a click paints the wall above the chair rail and nothing else (' + area[1] + ')');
  await undo();
  await waitUntil(async () => (await marks()).w.length === 0, 'one UNDO takes the paint back');
  assert.deepEqual(Object.values((await drawn())[WEST]).sort(), ['mat-drywall', 'mat-drywall']);
  ok('one UNDO takes it back');

  // ---------- the room ----------
  await clickAt(ABOVE, 'Shift');
  await waitUntil(async () => (await marks()).w.length === 1, 'Shift-click paints');
  let m = await marks();
  assert.deepEqual([m.w, m.n1, m.s, m.mid], [['1:mat-paint-navy'], ['1:mat-paint-navy'], ['1:mat-paint-navy'], ['1:mat-paint-navy']], 'the band above the rail on all four kitchen walls');
  assert.deepEqual([m.n2, m.e], [[], []], 'and nothing in the living room');
  d = await drawn();
  for (const face of Object.keys(d).filter(k => k.startsWith('k:'))) assert.ok(Object.values(d[face]).includes('mat-paint-navy') && Object.values(d[face]).includes('mat-drywall'), face + ' is navy above and drywall below');
  for (const face of Object.keys(d).filter(k => k.startsWith('l:'))) assert.ok(!Object.values(d[face]).includes('mat-paint-navy'), face + ' is untouched');
  ok('Shift-click paints the same band all round the kitchen, in one step');

  // ---------- trim ----------
  await choose('mat-paint-sage');
  await hoverAt(RAIL);
  await waitUntil(async () => /Chair rail/.test(await page.locator('[data-pt-under]').textContent()), 'the rail is under the pointer');
  await clickAt(RAIL);
  await waitUntil(async () => (await trims())['rail-w'] === 'mat-paint-sage', 'a click paints the one rail');
  let t = await trims();
  assert.deepEqual([t['rail-n'], t['base-w'], t['rail-e']], [null, null, null], 'the other trim keeps the trim paint');
  await clickAt(RAIL, 'Shift');
  await waitUntil(async () => (await trims())['rail-w'] === 'mat-paint-sage', 'still sage');
  t = await trims();
  assert.equal(t['rail-n'], null, 'Shift-click on a sage rail matches sage trim only: the rest wears the trim paint');
  await undo();
  await waitUntil(async () => (await trims())['rail-w'] === null, 'UNDO puts the rail back in the trim paint');
  await clickAt(RAIL, 'Shift');
  await waitUntil(async () => (await trims())['rail-w'] === 'mat-paint-sage', 'Shift-click paints the room\'s trim');
  t = await trims();
  assert.deepEqual([t['rail-n'], t['rail-s'], t['rail-mid'], t['base-w']], Array(4).fill('mat-paint-sage'), 'every trim section of the kitchen');
  assert.equal(t['rail-e'], null, 'not the living room\'s');
  ok('a click paints one trim section; Shift-click all of the room\'s trim that wore the same finish');

  // ---------- pick up ----------
  await clickAt(ABOVE, 'Alt');
  await waitUntil(async () => (await page.evaluate(async () => (await import('/js/viewer3d.js')).paintState().material)) === 'mat-paint-navy', 'Alt-click picks up the navy');
  assert.match(await page.locator('.inspector .pt-current').textContent(), /deep navy/);
  assert.deepEqual((await marks()).w, ['1:mat-paint-navy'], 'and paints nothing');
  ok('Alt-click picks up the finish under the pointer');

  // ---------- whole wall ----------
  await choose('mat-paint-terra');
  await clickAt(BELOW, 'Meta');
  await waitUntil(() => page.evaluate(() => window.testStore.activeProperty().walls.find(w => w.id === 'w').materialPos === 'mat-paint-terra'), 'Cmd-click paints the whole face');
  assert.deepEqual((await marks()).w, [], 'the marks on the face are cleared');
  assert.deepEqual(Object.values((await drawn())[WEST]).sort(), ['mat-paint-terra', 'mat-paint-terra'], 'both pieces in terracotta');
  assert.deepEqual((await marks()).n1, ['1:mat-paint-navy'], 'the other walls keep their paint');
  ok('Cmd-click paints the wall face floor to ceiling');

  // ---------- floor ----------
  await clickAt(FLOOR);
  await waitUntil(() => page.evaluate(() => window.testStore.activeProperty().rooms.find(r => r.id === 'k').material === 'mat-paint-terra'), 'a click paints the kitchen floor');
  assert.equal(await page.evaluate(() => window.testStore.activeProperty().rooms.find(r => r.id === 'l').material), 'mat-oak');
  await undo();
  await waitUntil(() => page.evaluate(() => window.testStore.activeProperty().rooms.find(r => r.id === 'k').material === 'mat-oak'), 'UNDO puts the oak back');
  ok('a click on a floor paints that room\'s floor');

  // ---------- a door ----------
  await page.evaluate(() => document.querySelector('[data-view-go="v-east"]').click());
  await page.waitForTimeout(900); await idle();
  // The partition's door, from the kitchen: find its casing beside the opening (0.9 m wide at z = 2).
  let doorAt = null;
  for (const z of [1.5, 1.49, 1.48, 2.5, 2.51, 2.52]) {
    const q = await screenOf([2.92, 1.2, z]);
    const hit = await page.evaluate(async q => (await import('/js/viewer3d.js')).paintUnder(q.x, q.y), q);
    if (hit && /^Door/.test(hit.name || '')) { doorAt = [2.92, 1.2, z]; break; }
  }
  assert.ok(doorAt, 'the door\'s casing is found beside the opening');
  await clickAt(doorAt);
  await waitUntil(() => page.evaluate(() => window.testStore.activeProperty().openings.find(o => o.id === 'door').trimMaterial === 'mat-paint-terra'), 'a click paints the door, its frame and casing');
  await undo();
  await waitUntil(() => page.evaluate(() => window.testStore.activeProperty().openings.find(o => o.id === 'door').trimMaterial === undefined), 'UNDO puts the trim paint back');
  ok('a click on a door paints it with its frame and casing');
  await page.evaluate(() => document.querySelector('[data-view-go="v-west"]').click());
  await page.waitForTimeout(900); await idle();

  // ---------- paint off ----------
  await choose('mat-paint-navy');
  await clickAt(ABOVE);
  await waitUntil(async () => (await marks()).w.length === 1, 'navy above the rail again');
  await choose('');
  await clickAt(ABOVE);
  await waitUntil(async () => (await marks()).w.length === 0, 'NO PAINT OF ITS OWN takes the mark off');
  assert.deepEqual(Object.values((await drawn())[WEST]).sort(), ['mat-paint-terra', 'mat-paint-terra'], 'the piece is back in the face\'s own finish');
  ok('NO PAINT OF ITS OWN takes a piece\'s paint off');

  // ---------- new colour ----------
  await page.locator('.inspector [data-pt-new-name]').fill('White Dove');
  await page.locator('.inspector [data-pt-new-brand]').fill('Benjamin Moore');
  await page.locator('.inspector [data-pt-new-code]').fill('OC-17');
  await page.locator('.inspector [data-pt-new-color]').fill('#f0efe6');
  await page.locator('.inspector [data-pt-new-add]').click();
  const dove = await page.evaluate(() => { const m = window.testStore.ws.data.materials.find(x => x.name === 'White Dove'); return m && { id: m.id, brand: m.colorBrand, code: m.colorCode, category: m.category, color: m.color }; });
  assert.deepEqual({ ...dove, id: undefined }, { id: undefined, brand: 'Benjamin Moore', code: 'OC-17', category: 'paint', color: '#f0efe6' });
  await clickAt(ABOVE);
  await waitUntil(async () => (await marks()).w.length === 1, 'the new colour paints');
  assert.deepEqual((await marks()).w, ['1:' + dove.id]);
  ok('a new paint colour is added with its maker and code, and paints at once');

  // ---------- select ----------
  await page.keyboard.press('Escape');
  await waitUntil(async () => (await heading.textContent()) !== 'PAINT', 'Esc ends PAINT');
  await clickAt(ABOVE);
  await waitUntil(async () => (await heading.textContent()) === 'WALL FACE', 'a click selects the face again');
  const pieces = await page.locator('.inspector [data-face-piece]').allTextContents();
  assert.equal(pieces.length, 2);
  assert.match(pieces[0], /^Below the chair rail · .*Paint, terracotta$/);
  assert.match(pieces[1], /^Above the chair rail · .*White Dove$/);
  ok('SELECT lists a divided face\'s pieces with their square feet and finishes');
  await saved();

  assert.deepEqual(errors, [], 'no page errors');
  console.log('paint: all checks passed');
} finally {
  if (browser) await browser.close();
  child.kill();
  await rm(state, { recursive: true, force: true });
}
