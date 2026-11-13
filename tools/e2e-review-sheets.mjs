// Review artefacts an owner corrects quickly: PLAN's numbered opening schedule (edit, undo,
// print, PNG) and MODEL's MATCH PHOTO (fly to the photo's view, overlay, save the view).
// Synthetic project and temporary runtime only; never uses the owner's stores.
// E2E_SHOTS=<dir> also writes screenshots of both features there.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { chromium } from 'playwright';

const shots = process.env.E2E_SHOTS || '';
if (shots) await mkdir(shots, { recursive: true });
const state = await mkdtemp(tmpdir() + '/tiksi-review-');
const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r));
const port = socket.address().port; await new Promise(r => socket.close(r));
const child = spawn('python3', ['tools/serve.py', '--host', '127.0.0.1', '--port', String(port), '--state-dir', state, '--projects-dir', state + '/projects'], { stdio: 'ignore' });
let browser, page;
const IN = 0.0254, errors = [];
// A disk save remounts the view; under software GL on a CI runner that can take a while.
async function savedToDisk() {
  try { await page.waitForFunction(() => document.querySelector('#save-status').textContent === 'SAVED TO DISK', null, { timeout: 120000 }); }
  catch (e) { throw new Error('save status stayed "' + await page.locator('#save-status').textContent() + '"'); }
}
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch('http://127.0.0.1:' + port)).ok) break; } catch {} await new Promise(r => setTimeout(r, 50)); }
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  page = await browser.newPage({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
  await page.addInitScript(() => localStorage.setItem('tiksi.onScreen.v1', '{"all":true}'));   // MODEL's tools on the screen (tiksi-menu.js)
  page.on('pageerror', e => errors.push(e.message));
  page.setDefaultTimeout(120000);   // MODEL under software GL on a CI runner is slow
  await page.goto('http://127.0.0.1:' + port + '/#/plan');
  await savedToDisk();
  await page.evaluate(async () => {
    const s = window.reviewStore = await import('/js/store.js');
    const p = s.propertyTemplate('Synthetic cottage'), L = p.levels[0].id;
    p.id = 'review-house'; p.env.quality = 'low';
    const wall = (id, ax, ay, bx, by, t = 0.15) => ({ id, level: L, ax, ay, bx, by, thickness: t, height: null, material: 'mat-drywall' });
    p.walls.push(wall('s', 0, 0, 7, 0), wall('e', 7, 0, 7, 5), wall('n', 7, 5, 0, 5), wall('w', 0, 5, 0, 0), wall('mid', 3.5, 0, 3.5, 5, 0.114));
    p.rooms.push({ id: 'r-kit', level: L, name: 'Kitchen', pts: [[0, 0], [3.5, 0], [3.5, 5], [0, 5]], material: null, ceilingMaterial: null },
      { id: 'r-liv', level: L, name: 'Living', pts: [[3.5, 0], [7, 0], [7, 5], [3.5, 5]], material: null, ceilingMaterial: null });
    p.openings.push({ id: 'o-front', wallId: 's', t: 0.25, type: 'door', width: 0.9, height: 2.03 },
      { id: 'o-mid', wallId: 'mid', t: 0.5, type: 'door', width: 0.76, height: 2.03 },
      { id: 'o-back', wallId: 'n', t: 0.3, type: 'door', width: 0.8, height: 2.03 },
      { id: 'o-w1', wallId: 'n', t: 0.75, type: 'window', width: 1.2, height: 1.2, sill: 0.8 },
      { id: 'o-w2', wallId: 'e', t: 0.5, type: 'window', width: 1.0, height: 1.2, sill: 0.8 });
    // A drawn "site photo": the synthetic photo that MATCH PHOTO lays over the model.
    const c = document.createElement('canvas'); c.width = 320; c.height = 240;
    const g = c.getContext('2d'); g.fillStyle = '#c9b48f'; g.fillRect(0, 0, 320, 240); g.fillStyle = '#6d4b2a'; g.fillRect(120, 70, 70, 170);
    g.fillStyle = '#9fc4d8'; g.fillRect(230, 80, 60, 60); g.fillStyle = '#222'; g.font = '20px sans-serif'; g.fillText('SYNTHETIC', 10, 30);
    const base = { kind: 'photo', w: 4032, h: 3024, mime: 'image/jpeg', thumb: c.toDataURL('image/jpeg', 0.8), createdAt: '2026-01-01T00:00:00.000Z', notes: '', roomId: 'r-kit', elementIds: [], itemIds: [] };
    p.photos.push({ ...base, id: 'ph-view', name: 'Kitchen east', pin: { x: 3.44, y: 1.2, z: 2.5, nx: -1, ny: 0, nz: 0, size: 0.6 },
      view: { position: [0.6, 1.5, 2.2], target: [3.4, 1.2, 2.6], fov: 70, from: 'saved' } },
      { ...base, id: 'ph-old', name: 'Older photo', pin: { x: 7, y: 1.2, z: 2.5, nx: -1, ny: 0, nz: 0, size: 0.6 } });
    s.ws.data.settings.sketchupMirror = false; s.ws.data.settings.units = 'imperial';
    s.ws.data.properties.push(p); s.ws.data.settings.activePropertyId = p.id; s.touch();
    await (await import('/js/disk-workspace.js')).diskWorkspace.sync();
  });
  await page.reload();
  await savedToDisk();
  await page.evaluate(async () => { window.reviewStore = await import('/js/store.js'); });
  const prop = () => page.evaluate(() => window.reviewStore.activeProperty());
  const before = JSON.stringify((await prop()).openings);

  // ---------- PLAN: opening schedule ----------
  const panel = page.locator('.plan-schedule');
  assert.equal(await panel.isHidden(), true, 'the schedule is hidden by default');
  await page.locator('[data-chk=numbers]').check();
  await panel.waitFor();
  assert.deepEqual(await panel.locator('.ps-num').allTextContents(), ['D1', 'D2', 'W1', 'W2', 'D3'], 'reading order: top band first, left to right');
  assert.match(await panel.locator('.ps-row[data-id=o-mid] .ps-what').textContent(), /Kitchen \/ Living/);
  assert.match(await panel.locator('.ps-row[data-id=o-front] .ps-what').textContent(), /Kitchen \/ Exterior/);
  assert.equal(JSON.stringify((await prop()).openings), before, 'numbering changes nothing saved');
  assert.equal(await page.locator('#btn-undo').isDisabled(), true);
  if (shots) await page.screenshot({ path: shots + '/opening-schedule.png' });
  // Corrections typed by number, Enter moving down the width column.
  const width = id => panel.locator(`.ps-row[data-id=${id}] [data-ps-len=width]`);
  const focusedRow = id => page.waitForFunction(id => document.activeElement?.closest('.ps-row')?.dataset.id === id, id, { timeout: 3000 });
  await width('o-mid').fill('32"'); await width('o-mid').press('Enter');
  await focusedRow('o-w2');   // Enter moves down the column
  await page.keyboard.type('30"'); await page.keyboard.press('Enter');
  let p = await prop();
  assert.ok(Math.abs(p.openings.find(o => o.id === 'o-mid').width - 32 * IN) < 1e-6);
  assert.ok(Math.abs(p.openings.find(o => o.id === 'o-w2').width - 30 * IN) < 1e-6);
  await focusedRow('o-w1');
  assert.match(await page.locator('.inspector h3').textContent(), /WINDOW W2/, 'focusing a row selects its opening');
  await width('o-front').fill('wide'); await width('o-front').press('Tab');
  assert.equal((await prop()).openings.find(o => o.id === 'o-front').width, 0.9, 'an unreadable size changes nothing');
  assert.match(await page.locator('.canvas-hint').textContent(), /^[DW]\d+ width: "wide" is not a length\./, 'the hint names the opening and says why');
  await width('o-front').fill('40\''); await width('o-front').press('Tab');
  p = await prop(); const front = p.openings.find(o => o.id === 'o-front');
  assert.ok(Math.abs(front.width - 6.96) < 1e-6 && Math.abs(front.t - 0.5) < 1e-6, 'a too-wide door is held to its wall');
  await page.keyboard.press('ControlOrMeta+z');
  assert.equal((await prop()).openings.find(o => o.id === 'o-front').width, 0.9, 'undo reverts the clamped edit');
  assert.equal(await width('o-front').inputValue(), '2\'-11 7/16"', 'the panel follows undo');
  await page.keyboard.press('ControlOrMeta+z'); await page.keyboard.press('ControlOrMeta+z');
  assert.equal(JSON.stringify((await prop()).openings), before, 'each schedule edit is one undo step');
  await page.keyboard.press('ControlOrMeta+Shift+z');
  assert.ok(Math.abs((await prop()).openings.find(o => o.id === 'o-mid').width - 32 * IN) < 1e-6, 'redo replays it');
  await panel.locator('.ps-row[data-id=o-back] .ps-what').click();
  assert.match(await page.locator('.inspector h3').textContent(), /DOOR D3/);
  assert.match(await page.locator('.inspector').textContent(), /Living \/ Exterior/);
  // Print: the numbered plan and the table, through the app's print root.
  await page.evaluate(() => { window.printed = 0; window.print = () => { window.printed++; }; });
  await panel.locator('[data-ps=print]').click();
  assert.equal(await page.evaluate(() => window.printed), 1);
  assert.equal(await page.locator('#print-root .opening-sheet tbody tr').count(), 5);
  assert.match(await page.locator('#print-root .opening-sheet img.s-plan').getAttribute('src'), /^data:image\/png;base64,/);
  assert.match(await page.locator('#print-root .opening-sheet tbody tr').nth(1).textContent(), /D2.*Door.*Kitchen \/ Living.*2'-8"/);
  const [download] = await Promise.all([page.waitForEvent('download'), panel.locator('[data-ps=png]').click()]);
  assert.match(download.suggestedFilename(), /^opening-schedule-synthetic-cottage-.*\.png$/);
  const png = await (await import('node:fs/promises')).readFile(await download.path());
  assert.equal(png.subarray(1, 4).toString(), 'PNG'); assert.ok(png.length > 20000, 'the PNG holds a drawn plan');
  if (shots) await (await import('node:fs/promises')).writeFile(shots + '/opening-schedule-export.png', png);
  await page.locator('[data-chk=numbers]').uncheck();
  assert.equal(await panel.isHidden(), true);

  // ---------- MODEL: match photo ----------
  await page.locator('#rail [data-view=model]').click();
  await page.locator('canvas.v-canvas').waitFor();
  await page.locator('.v-pin-row [data-match=ph-view]').click();
  const frame = page.locator('.v-match-frame');
  await frame.waitFor();
  const box = await frame.boundingBox(), wrap = await page.locator('.canvas-wrap').boundingBox();
  assert.ok(Math.abs(box.width / box.height - 4 / 3) < 0.01, 'the frame has the photo\'s aspect');
  assert.ok(Math.abs(box.height - wrap.height) < 1.5 || Math.abs(box.width - wrap.width) < 1.5, 'and fills the view one way');
  assert.equal(await page.locator('.v-match-frame img').evaluate(img => getComputedStyle(img).opacity), '0.5');
  await page.locator('[data-match-op]').fill('0.8');
  assert.equal(await page.locator('.v-match-frame img').evaluate(img => getComputedStyle(img).opacity), '0.8', 'opacity slider');
  await page.waitForTimeout(900);   // the camera flight
  if (shots) await page.screenshot({ path: shots + '/match-photo-over.png' });
  await page.locator('[data-match-layout=beside]').click();
  assert.equal(await page.locator('.v-match-pip').isVisible(), true);
  if (shots) await page.screenshot({ path: shots + '/match-photo-side-by-side.png' });
  await page.locator('[data-match-layout=over]').click();
  await page.locator('[data-match-save]').click();
  p = await prop();
  const saved = p.photos.find(ph => ph.id === 'ph-view').view;
  assert.equal(saved.from, 'saved'); assert.equal(saved.fov, 70);
  saved.position.forEach((v, i) => assert.ok(Math.abs(v - [0.6, 1.5, 2.2][i]) < 0.02, 'the camera flew to the stored view: ' + saved.position));
  // Saving reaches the disk, which remounts MODEL; the match and its camera carry on.
  await savedToDisk();
  await page.waitForTimeout(600);
  assert.equal(await page.locator('.v-match').count(), 1, 'the match survives the save');
  await page.locator('[data-match-save]').click();
  const resaved = (await prop()).photos.find(ph => ph.id === 'ph-view').view;
  resaved.position.forEach((v, i) => assert.ok(Math.abs(v - saved.position[i]) < 1e-6, 'with the camera where it was'));
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.v-match').count(), 0, 'Esc ends the match');
  // An older photo with only a pin starts in front of the pin; SAVE VIEW gives it a view.
  await page.locator('.v-pin-row [data-match=ph-old]').click();
  await frame.waitFor(); await page.waitForTimeout(900);
  await page.locator('[data-match-fov]').fill('60');
  await page.locator('[data-match-save]').click();
  const oldView = (await prop()).photos.find(ph => ph.id === 'ph-old').view;
  assert.equal(oldView.fov, 60); assert.ok(Math.abs(oldView.position[0] - 4.5) < 0.05, 'started 2.5 m in front of the pin: ' + oldView.position);
  await page.locator('[data-match-done]').click();
  // From PHOTOS: PHOTO MODE opens MODEL with the overlay.
  await page.locator('#rail [data-view=photos]').click();
  await page.locator('.ph-card[data-id=ph-view]').click();
  assert.match(await page.locator('.ph-detail').textContent(), /Camera\s*lined up by eye/);
  await page.locator('.ph-detail [data-act=match]').click();
  await page.locator('.v-match-frame').waitFor();
  assert.equal(await page.evaluate(() => location.hash), '#/model', 'the deep link is consumed');
  await savedToDisk();
  // The saved views reach the project on disk and come back after a reload.
  await page.reload();
  await savedToDisk();
  const reloaded = await page.evaluate(async () => (await import('/js/store.js')).activeProperty().photos.map(ph => ph.view && ph.view.fov));
  assert.deepEqual(reloaded, [70, 60]);
  assert.deepEqual(errors, []);
  console.log('ok   opening schedule numbers, edits, undo, print and PNG; MATCH PHOTO overlay, saved views from MODEL and PHOTOS');
} catch (e) {
  if (shots && page) await page.screenshot({ path: shots + '/failure.png' }).catch(() => {});
  if (errors.length) console.error('page errors:', errors);
  throw e;
} finally {
  if (browser) await browser.close(); child.kill();
  await new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve));
  await rm(state, { recursive: true, force: true });
}
