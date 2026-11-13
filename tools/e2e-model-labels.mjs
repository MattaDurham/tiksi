// MODEL's labels and PARALLEL projection, with real clicks on the rendered view.
//
//   labels    DIMENSIONS shows each wall's centre-line length as the app writes lengths, ROOMS
//             each room's name and floor area, NUMBERS each door and window by its schedule
//             mark (D1, W1...); a second click takes them off again; the Tiksi menu's Display
//             items do the same; the switches are kept with the property through a reload; a
//             hidden level hides its labels and shows them again with the level
//   parallel  TOP turns PARALLEL on and ORBIT turns it off again; Shift+P and the pill switch
//             it; a click in PARALLEL still selects the face under it, and THE WALL BEHIND
//             opens the wall (read-only Thickness and Height lines); scroll steps change the scale a little at
//             a time and never drop the camera onto its target; a saved view made in PARALLEL
//             comes back in PARALLEL
//
// Synthetic project and temporary runtime only; never uses the owner's stores.
// Run: node tools/e2e-model-labels.mjs (Playwright + Chromium installed).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { chromium } from 'playwright';

const root = process.env.E2E_ROOT || process.cwd();
const state = await mkdtemp(tmpdir() + '/tiksi-labels-');
const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r));
const port = Number(process.env.E2E_APP_PORT) || socket.address().port; await new Promise(r => socket.close(r));
const child = spawn('python3', ['tools/serve.py', '--port', String(port), '--state-dir', state, '--projects-dir', state + '/projects'], { cwd: root, stdio: 'ignore' });
const FT = 0.3048;
let browser;
const ok = label => console.log('  ok   ' + label);
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch('http://127.0.0.1:' + port)).ok) break; } catch {} await new Promise(r => setTimeout(r, 50)); }
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(60000);
  await page.addInitScript(() => localStorage.setItem('tiksi.onScreen.v1', '{"all":true}'));   // MODEL's mode bar and tools on the screen (tiksi-menu.js)
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const saved = () => page.waitForFunction(() => document.querySelector('#save-status')?.textContent === 'SAVED TO DISK', null, { timeout: 120000 });
  await page.goto('http://127.0.0.1:' + port + '/#/budget');
  await saved();
  // A 16'-0" x 12'-0" kitchen on the main level (its front wall at y = 0, the room north of it,
  // toward -y), a door off to one side of the front wall and a window in the back wall; an 8'-0"
  // square loft one level up with a window of its own.
  await page.evaluate(async FT => {
    const s = window.testStore = await import('/js/store.js');
    const p = s.propertyTemplate('Labels test');
    p.id = 'labels-house'; p.env.quality = 'low';
    const L = p.levels[0].id;
    p.levels.push({ id: 'lvl-up', name: 'Loft level', elevation: 9 * FT, height: 2.44, plan: null });
    const wall = (id, level, ax, ay, bx, by) => ({ id, level, ax, ay, bx, by, thickness: 0.15, height: null, material: 'mat-drywall' });
    const x0 = -8 * FT, x1 = 8 * FT, y1 = -12 * FT;
    p.walls.push(wall('front', L, x0, 0, x1, 0), wall('right', L, x1, 0, x1, y1), wall('back', L, x1, y1, x0, y1), wall('left', L, x0, y1, x0, 0));
    p.walls.push(wall('up-front', 'lvl-up', x0, 0, x0 + 8 * FT, 0), wall('up-right', 'lvl-up', x0 + 8 * FT, 0, x0 + 8 * FT, -8 * FT),
      wall('up-back', 'lvl-up', x0 + 8 * FT, -8 * FT, x0, -8 * FT), wall('up-left', 'lvl-up', x0, -8 * FT, x0, 0));
    p.rooms.push({ id: 'r-kitchen', level: L, name: 'Kitchen', pts: [[x0, y1], [x1, y1], [x1, 0], [x0, 0]], material: 'mat-oak', ceilingMaterial: null },
      { id: 'r-loft', level: 'lvl-up', name: 'Loft', pts: [[x0, -8 * FT], [x0 + 8 * FT, -8 * FT], [x0 + 8 * FT, 0], [x0, 0]], material: 'mat-oak', ceilingMaterial: null });
    p.openings.push({ id: 'o-door', wallId: 'front', t: 0.2, type: 'door', width: 3 * FT, height: 2.03 },
      { id: 'o-win', wallId: 'back', t: 0.5, type: 'window', width: 4 * FT, height: 4 * FT, sill: 3 * FT },
      { id: 'o-loft-win', wallId: 'up-back', t: 0.5, type: 'window', width: 2 * FT, height: 3 * FT, sill: 3 * FT });
    s.ws.data.settings.sketchupMirror = false; s.ws.data.settings.units = 'imperial';
    s.ws.data.properties.push(p); s.ws.data.settings.activePropertyId = p.id; s.touch();
    await (await import('/js/disk-workspace.js')).diskWorkspace.sync();
  }, FT);

  const waitUntil = async (check, what, tries = 150) => {
    for (let i = 0; i < tries; i++) { if (await check()) return; await page.waitForTimeout(200); }
    assert.fail('timed out waiting until ' + what);
  };
  const idle = () => waitUntil(() => page.evaluate(async () => (await import('/js/viewer3d.js')).viewerIdle()), 'MODEL has settled');
  const env = () => page.evaluate(() => { const e = window.testStore.activeProperty().env; return { dims: e.showDims, rooms: e.showRoomLabels, numbers: e.showOpeningNumbers }; });
  const pill = kind => page.locator(`.v-pill[data-annot="${kind}"]`);
  const pressed = async loc => (await loc.getAttribute('aria-pressed')) === 'true';
  const texts = sel => page.locator(sel).evaluateAll(els => els.map(e => e.textContent).sort());
  const rooms = () => page.locator('.v-annot-room').evaluateAll(els => els.map(e => [e.querySelector('b')?.textContent, e.querySelector('span')?.textContent]).sort());
  const parallelPill = page.locator('.v-pill[data-parallel]');
  const parallelOn = () => pressed(parallelPill);
  const camera = () => page.evaluate(async () => (await import('/js/viewer3d.js')).markupState().camera);
  const distance = c => Math.hypot(...c.position.map((v, i) => v - c.target[i]));
  const canvas = page.locator('canvas.v-canvas'), heading = page.locator('.inspector h3').first();

  await page.locator('#rail [data-view=model]').click();
  await canvas.waitFor();
  await idle();

  // ---------- DIMENSIONS, ROOMS, NUMBERS ----------
  for (const kind of ['dims', 'rooms', 'numbers']) assert.equal(await pressed(pill(kind)), false, kind + ' starts off');
  assert.equal(await page.locator('.v-annot').count(), 0, 'no labels while the switches are off');
  const expected = await page.evaluate(async () => {
    const s = window.testStore, p = s.activeProperty();
    const { openingSchedule } = await import('/js/opening-schedule.js');
    return { lens: p.walls.map(w => s.fmtLen(Math.hypot(w.bx - w.ax, w.by - w.ay))).sort(), marks: openingSchedule(p).map(r => ({ id: r.id, number: r.number, type: r.type })) };
  });

  await pill('dims').click();
  await page.locator('.v-annot-dim').first().waitFor({ state: 'attached' });
  const dims = await texts('.v-annot-dim');
  assert.deepEqual(dims, expected.lens, 'DIMENSIONS labels every wall with its length as the app writes lengths');
  assert.equal(['16\'-0"', '12\'-0"', '8\'-0"'].map(len => dims.filter(t => t === len).length).join(), '2,2,4', 'two 16\'-0" and two 12\'-0" kitchen walls, four 8\'-0" loft walls');
  assert.equal(await pressed(pill('dims')), true);
  assert.equal((await env()).dims, true, 'the switch is kept with the property');
  ok('DIMENSIONS shows each wall\'s length (' + [...new Set(dims)].join(', ') + ')');

  await pill('rooms').click();
  await page.locator('.v-annot-room').first().waitFor({ state: 'attached' });
  assert.deepEqual(await rooms(), [['Kitchen', '192 sf'], ['Loft', '64 sf']], 'ROOMS shows each room\'s name and floor area');
  ok('ROOMS shows Kitchen 192 sf and Loft 64 sf');

  await pill('numbers').click();
  await page.locator('.v-annot-num').first().waitFor({ state: 'attached' });
  const marksOf = type => expected.marks.filter(m => m.type === type).map(m => m.number).sort();
  assert.deepEqual(await texts('.v-annot-num.door'), marksOf('door'), 'NUMBERS marks each door as the schedule does');
  assert.deepEqual(await texts('.v-annot-num.window'), marksOf('window'), 'and each window');
  assert.deepEqual(marksOf('door'), ['D1']); assert.deepEqual(marksOf('window'), ['W1', 'W2']);
  ok('NUMBERS shows D1, W1 and W2, the schedule\'s marks');

  // The labels sit over their points: the door's mark is left of the kitchen's window mark from the front.
  await page.locator('#side [data-act=front]').click();
  await page.waitForTimeout(900); await idle();
  const at = mark => page.locator('.v-annot-num', { hasText: mark }).evaluate(e => { const r = e.getBoundingClientRect(); return e.style.display === 'none' ? null : r.left + r.width / 2; });
  const [d1, w1] = [await at('D1'), await at('W1')];
  assert.ok(d1 != null && w1 != null && d1 < w1 - 40, 'from the front the door\'s D1 (left part of the front wall) is left of the back window\'s W1 (' + d1 + ' px, ' + w1 + ' px)');

  // Off again, one at a time.
  await pill('dims').click();
  assert.equal(await page.locator('.v-annot-dim').count(), 0, 'DIMENSIONS again takes the lengths off');
  assert.ok(await page.locator('.v-annot-room').count() === 2 && await page.locator('.v-annot-num').count() === 3, 'and leaves the rooms and numbers');
  await pill('rooms').click(); await pill('numbers').click();
  assert.equal(await page.locator('.v-annot').count(), 0, 'with all three off there are no labels');
  assert.deepEqual(await env(), { dims: false, rooms: false, numbers: false });
  ok('a second click takes each kind of label off');

  // The left pane's Display items switch the same labels.
  await page.locator('#side .sd-item[data-act=dims]', { hasText: 'Wall dimensions' }).click();
  assert.equal(await pressed(pill('dims')), true, 'Display > Wall dimensions turns DIMENSIONS on');
  assert.equal(await page.locator('.v-annot-dim').count(), 8);
  assert.equal(await page.locator('#side .sd-item[data-act=dims]').getAttribute('aria-pressed'), 'true', 'and the pane item shows it on');
  ok('the left pane\'s Wall dimensions turns DIMENSIONS on');

  // Kept with the property: on after a reload.
  await pill('rooms').click(); await pill('numbers').click();
  await saved();
  await page.reload();
  await canvas.waitFor();
  await saved(); await idle();
  await page.evaluate(async () => { window.testStore = await import('/js/store.js'); });
  for (const kind of ['dims', 'rooms', 'numbers']) assert.equal(await pressed(pill(kind)), true, kind + ' is still on after a reload');
  assert.ok(await page.locator('.v-annot-dim').count() === 8 && await page.locator('.v-annot-room').count() === 2 && await page.locator('.v-annot-num').count() === 3, 'and its labels are back');
  ok('the switches and their labels survive a reload');

  // A hidden level hides its labels.
  await page.locator('#side [data-level="lvl-up"]').click();
  assert.deepEqual(await rooms(), [['Kitchen', '192 sf']], 'hiding the loft level takes its room label away');
  assert.equal(await page.locator('.v-annot-dim').count(), 4, 'and its walls\' lengths');
  assert.deepEqual(await texts('.v-annot-num'), ['D1', 'W1'], 'and its window\'s number');
  await page.locator('#side [data-level="lvl-up"]').click();
  assert.ok(await page.locator('.v-annot-dim').count() === 8 && await page.locator('.v-annot-room').count() === 2 && await page.locator('.v-annot-num').count() === 3, 'showing the level brings them back');
  ok('a hidden level hides its labels');
  for (const kind of ['dims', 'rooms', 'numbers']) await pill(kind).click();   // a clear view for the clicks below

  // ---------- PARALLEL ----------
  assert.equal(await parallelOn(), false, 'MODEL opens in perspective');
  await page.locator('.v-pill[data-mode="top"]').click();
  await waitUntil(parallelOn, 'TOP turns PARALLEL on');
  assert.ok(await page.locator('.v-pill[data-parallel].active').count() === 1, 'the pill is lit');
  await page.locator('.v-pill[data-mode="orbit"]').click();
  await waitUntil(async () => !(await parallelOn()), 'ORBIT turns PARALLEL off again');
  ok('TOP turns PARALLEL on and ORBIT turns it off');
  await canvas.click({ position: { x: 5, y: 5 } });   // keys go to the view, not a button
  await page.keyboard.press('Escape');
  await page.keyboard.press('Shift+P');
  await waitUntil(parallelOn, 'Shift+P turns PARALLEL on');
  await page.keyboard.press('Shift+P');
  await waitUntil(async () => !(await parallelOn()), 'Shift+P turns PARALLEL off');
  await parallelPill.click();
  await waitUntil(parallelOn, 'the pill turns PARALLEL on');
  ok('Shift+P and the pill switch PARALLEL');

  // A click in PARALLEL selects the wall under it: the front wall, seen from the front.
  await page.locator('#side [data-act=front]').click();
  await page.waitForTimeout(900); await idle();
  assert.equal(await parallelOn(), true, 'FRONT keeps PARALLEL');
  const box = await canvas.boundingBox();
  let picked = false;
  for (let dy = 0; dy <= 160 && !picked; dy = dy > 0 ? -dy : -dy + 8) {
    await page.mouse.click(box.x + box.width / 2 + 40, box.y + box.height / 2 + dy);
    await page.waitForTimeout(150);
    picked = (await heading.innerText()) === 'WALL FACE';
  }
  assert.ok(picked, 'a click in PARALLEL selects a wall face');
  assert.equal((await page.locator('.inspector .op-name').innerText()).trim(), 'Outside, south face', 'the front wall\'s outside, seen from the front');
  await page.locator('.inspector [data-face-wall]').first().click();
  await waitUntil(async () => (await heading.innerText()) === 'WALL', 'THE WALL BEHIND opens the wall');
  const stat = label => page.locator('.inspector .stat-line', { has: page.locator('span', { hasText: new RegExp('^' + label + '$') }) }).locator('b');
  assert.equal(await stat('Length').innerText(), '16\'-0"', 'the front wall, 16\'-0" long');
  assert.equal(await stat('Thickness').innerText(), await page.evaluate(() => window.testStore.fmtLen(0.15)), 'its thickness is a read-only line');
  assert.equal(await stat('Height').count(), 1, 'so is its height');
  assert.equal(await page.locator('.inspector input[data-th], .inspector .field:has(> label:text-is("Thickness")) input').count(), 0, 'no thickness to type');
  ok('a click in PARALLEL selects the front wall\'s face; the wall behind it has read-only Thickness (' + await stat('Thickness').innerText() + ') and Height');
  await page.keyboard.press('Escape');

  // Scroll steps in PARALLEL: the camera keeps its distance when the navigation re-aims, so each
  // step changes the scale by a little and the camera never reaches its target.
  await idle();
  const steps = [];
  let before = distance(await camera());
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 8; i++) {
    await page.mouse.wheel(0, -100);
    await page.waitForTimeout(250); await idle();
    const d = distance(await camera());
    steps.push(d / before); before = d;
  }
  assert.ok(steps.every(r => r > 0.75 && r < 0.995), 'each scroll step brings the view in by a modest factor (' + steps.map(r => r.toFixed(3)).join(', ') + ')');
  assert.ok(before > 0.5, 'the camera stays well off its target (' + before.toFixed(2) + ' m after 8 steps)');
  assert.equal(await parallelOn(), true, 'and the view is still PARALLEL');
  ok('scroll in PARALLEL: steps of ' + steps.map(r => r.toFixed(3)).join(', ') + ', ' + before.toFixed(2) + ' m from the target after 8');

  // A saved view made in PARALLEL comes back in PARALLEL.
  await page.locator('[data-view-add]').click();
  await page.locator('.v-view-tab').waitFor();
  const view = await page.evaluate(() => window.testStore.activeProperty().savedViews[0].camera);
  assert.equal(view.parallel, true, 'the saved view keeps camera.parallel');
  await parallelPill.click();
  await waitUntil(async () => !(await parallelOn()), 'the pill turns PARALLEL off');
  await page.locator('.v-pill[data-mode="orbit"]').click();
  await page.locator('#side [data-act=front]').click();
  await page.waitForTimeout(900);
  await page.locator('.v-view-tab').first().click();
  await waitUntil(parallelOn, 'the saved view brings PARALLEL back');
  await page.waitForTimeout(900); await idle();
  const back = await camera();
  assert.ok(Math.abs(distance(back) - distance(view)) < 0.05, 'at the saved scale (' + distance(back).toFixed(2) + ' m, saved ' + distance(view).toFixed(2) + ' m)');
  ok('a saved view made in PARALLEL comes back in PARALLEL');

  assert.deepEqual(errors, [], 'no page errors');
  console.log('MODEL labels and PARALLEL e2e passed');
} finally {
  if (browser) await browser.close();
  child.kill('SIGTERM');
  await rm(state, { recursive: true, force: true });
}
