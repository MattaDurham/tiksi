// A size typed in PLAN is stored as typed: a wall Length (on a wall at an angle, whose end moves
// in x and y, with a wall joined at that end), an opening width and a level elevation come back
// to within 0.05 mm, and the field shows the typed value in its normal form. Snapping to the
// 5 mm grid is for drags only. Imperial and metric.
// Synthetic project, ephemeral origin and browser profile; no live state.
// Run: node tools/e2e-typed-lengths.mjs (Playwright + Chromium installed). E2E_ROOT serves
// another checkout's files instead of this one.
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname, sep } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(process.env.E2E_ROOT || fileURLToPath(new URL('../', import.meta.url)));
const server = http.createServer(async (req, res) => {
  const path = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
  if (!path.startsWith(root + sep) && path !== root) { res.writeHead(404).end(); return; }
  try {
    const file = path === root ? resolve(root, 'index.html') : path;
    const bytes = await readFile(file);
    res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.wasm': 'application/wasm' })[extname(file)] || 'application/octet-stream');
    res.end(bytes);
  } catch { res.writeHead(404).end(); }
});

const RULER = 22;   // plan2d.js: rulers along the top and left canvas edges
const TOL = 0.00005; // 0.05 mm

let browser;
try {
  await new Promise(r => server.listen(Number(process.env.E2E_APP_PORT) || 0, 'localhost', r));
  const url = `http://localhost:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  await page.goto(url + '/#/budget');
  await page.locator('#cap-input').waitFor();

  // An angled wall from (1, 1) to (4, 3) with a second wall joined at its far end, and a south
  // wall carrying a window.
  async function setUp(units, spur = false) {
    await page.evaluate(async ([units, spur]) => {
      const s = await import('/js/store.js');
      const p = s.activeProperty();
      s.ensureLevels(p);
      const level = p.levels[0].id;
      p.activeLevelId = level; p.levels = [p.levels[0]]; p.levels[0].plan = null; p.levels[0].elevation = 0;
      const wall = (id, ax, ay, bx, by) => ({ id, level, ax, ay, bx, by, thickness: 0.114, height: null, material: null });
      p.walls = [wall('angled', 1, 1, 4, 3), wall('tail', 4, 3, 6, 3), wall('south', 0, 0, 6, 0)];
      p.openings = [{ id: 'win', wallId: 'south', t: 0.5, type: 'window', width: 0.914, height: 1.219, sill: 0.762 }];
      if (spur) {
        // A 1 m wall from the angled wall's far end back along it, and a door on the wall joined
        // there at a position that the old put-back nudged by one rounding unit.
        const L = Math.hypot(3, 2), ux = 3 / L, uy = 2 / L;
        p.walls.push(wall('spur', 4, 3, 4 - ux, 3 - uy));
        p.openings.push({ id: 'door', wallId: 'tail', t: 0.2334, type: 'door', width: 0.5, height: 2 });
      }
      p.rooms = []; p.fixtures = []; p.photoPositions = [];
      s.ws.data.settings.units = units;
      s.touch();
    }, [units, spur]);
    await page.evaluate(() => { location.hash = '#/budget'; });
    await page.locator('#cap-input').waitFor();
    await page.locator('#rail a[data-view="plan"]').click({ noWaitAfter: true });
    await page.locator('.plan-canvas canvas').waitFor();
    await page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.animationName === 'view-in').map(a => a.finished)));
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.keyboard.press('Escape');
    await page.keyboard.press('f');
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  }
  // Screen position of a plan point, from FIT VIEW's rule for the bounds (0,0) to (6,3).
  async function screen() {
    const box = await page.locator('.plan-canvas canvas').boundingBox();
    const wrap = await page.locator('.plan-canvas').evaluate(e => ({ w: e.clientWidth, h: e.clientHeight }));
    const w = wrap.w - RULER, h = wrap.h - RULER, bw = 6, bh = 3;
    const zoom = Math.min(w / (bw * 1.22), h / (bh * 1.22), 250);
    const panX = -(w / zoom - bw) / 2 - RULER / zoom, panY = -(h / zoom - bh) / 2 - RULER / zoom;
    return (x, y) => [box.x + (x - panX) * zoom, box.y + (y - panY) * zoom];
  }
  const read = () => page.evaluate(async () => {
    const s = await import('/js/store.js');
    const p = s.activeProperty();
    return { walls: Object.fromEntries(p.walls.map(w => [w.id, [w.ax, w.ay, w.bx, w.by]])), win: p.openings.find(o => o.id === 'win').width, elevation: p.levels[0].elevation };
  });
  const expect = typed => page.evaluate(async typed => { const s = await import('/js/store.js'); const v = s.parseLen(typed, 'feet'); return { v, text: s.fmtLen(v) }; }, typed);
  async function typeInto(field, typed) {
    const f = page.locator(`.inspector [data-len=${field}]`);
    await f.fill(typed);
    await f.press('Enter');
    return page.locator(`.inspector [data-len=${field}]`).inputValue();
  }

  // Wall Length on the angled wall, imperial.
  await setUp('imperial');
  let at = await screen();
  await page.mouse.click(...at(2.5, 2));
  assert.match(await page.locator('.inspector').innerText(), /^WALL/);
  const dir = [3 / Math.hypot(3, 2), 2 / Math.hypot(3, 2)];
  for (const typed of ['8"', "12'", `10' 6 1/2"`]) {
    const shown = await typeInto('len', typed);
    const { v, text } = await expect(typed);
    const { walls } = await read();
    const [ax, ay, bx, by] = walls.angled;
    assert.ok(Math.abs(Math.hypot(bx - ax, by - ay) - v) < TOL, `${typed}: stored length ${Math.hypot(bx - ax, by - ay)} m, typed ${v} m`);
    assert.ok(Math.abs(bx - (1 + dir[0] * v)) < TOL && Math.abs(by - (1 + dir[1] * v)) < TOL, `${typed}: the end moved along the wall in x and y`);
    assert.deepEqual(walls.tail.slice(0, 2), [bx, by], `${typed}: the joined wall meets the new end exactly`);
    assert.equal(shown, text, `${typed}: the field shows the typed length`);
    if (typed === '8"') assert.equal(shown, '8"', 'eight inches reads back as 8"');
  }

  // The Length field says it is measured on the wall's centre line.
  assert.match(await page.locator('.inspector').innerText(), /LENGTH \(ON THE CENTRE LINE\)/i);
  // Text that is not a length is refused with the reason in the hint; the stored length and
  // the field stay as they were. A number on its own is feet.
  {
    const before = (await read()).walls.angled, shownBefore = await page.locator('.inspector [data-len=len]').inputValue();
    const shown = await typeInto('len', '10x12');
    assert.deepEqual((await read()).walls.angled, before, 'unreadable text changes nothing');
    assert.equal(shown, shownBefore, 'the field shows the stored length again');
    assert.match(await page.locator('.canvas-hint').innerText(), /"10x12" is not a length\. Type it like .*a number on its own is feet/, 'the hint says why');
    const ok = await typeInto('len', '12');
    const [ax, ay, bx, by] = (await read()).walls.angled;
    assert.ok(Math.abs(Math.hypot(bx - ax, by - ay) - 12 * 0.3048) < TOL, 'a bare 12 is 12 feet');
    assert.equal(ok, (await expect("12'")).text);
    assert.doesNotMatch(await page.locator('.canvas-hint').innerText(), /is not a length/, 'a good entry clears the reason');
  }

  // Readable values outside a field's range are refused with the range, in the user's units.
  const hint = () => page.locator('.canvas-hint').innerText();
  async function refused(field, typed, pattern) {
    const before = await read(), shownBefore = await page.locator(`.inspector [data-len=${field}]`).inputValue();
    const shown = await typeInto(field, typed);
    assert.deepEqual(await read(), before, `${field} ${typed}: nothing changed`);
    assert.equal(shown, shownBefore, `${field} ${typed}: the field shows the stored value again`);
    assert.match(await hint(), pattern, `${field} ${typed}: the hint gives the allowed range`);
  }
  await refused('len', '1"', /A wall length must be more than 1 15\/16"; it was left as it was\./);
  await refused('th', '1/2"', /A wall thickness must be between 13\/16" and 3'-3 3\/8"/);
  await refused('th', "4'", /A wall thickness must be between/);
  await refused('h', '6"', /A wall height must be more than 11 13\/16"/);

  // An opening width.
  await page.keyboard.press('Escape');
  await page.mouse.click(...at(3, 0));
  assert.match(await page.locator('.inspector').innerText(), /^WINDOW/);
  await refused('w', '1"', /A width must be more than 1 15\/16"/);
  for (const typed of ['30 1/4"', `2' 11 3/16"`]) {
    const shown = await typeInto('w', typed);
    const { v, text } = await expect(typed);
    assert.ok(Math.abs((await read()).win - v) < TOL, `${typed}: stored width ${(await read()).win} m, typed ${v} m`);
    assert.equal(shown, text, `${typed}: the width field shows the typed width`);
  }

  // A sill at the floor: typed as 0 (a bare number, so 0 feet) it is stored as 0.
  {
    const shown = await typeInto('s', '0');
    const sill = await page.evaluate(async () => (await import('/js/store.js')).activeProperty().openings.find(o => o.id === 'win').sill);
    assert.equal(sill, 0, 'a sill of 0 is stored');
    assert.equal(shown, (await expect('0')).text, 'and shown');
  }

  // A level elevation.
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await refused('lvlHeight', "1'", /A level height must be more than 1'-7 11\/16"/);
  {
    const typed = `9' 1/16"`, shown = await typeInto('elev', typed), { v, text } = await expect(typed);
    assert.ok(Math.abs((await read()).elevation - v) < TOL, `${typed}: stored elevation ${(await read()).elevation} m, typed ${v} m`);
    assert.equal(shown, text, 'the elevation field shows the typed elevation');
  }

  // A length that would squeeze the wall joined at the far end is refused with the reason, and
  // everything (the door on the other joined wall included) is put back bit for bit, with no
  // undo entry.
  await setUp('imperial', true);
  at = await screen();
  await page.mouse.click(...at(2.5, 2));
  assert.match(await page.locator('.inspector').innerText(), /^WALL/);
  {
    const before = await read(), door = () => page.evaluate(async () => (await import('/js/store.js')).activeProperty().openings.find(o => o.id === 'door').t);
    const undo = () => page.evaluate(async () => { const h = await import('/js/edit-history.js'), s = await import('/js/store.js'); return h.editHistoryState(s.activeProperty()).undo; });
    const undoBefore = await undo(), t0 = await door();
    await typeInto('len', `8' 6 3/8"`);
    assert.deepEqual(await read(), before, 'the walls are exactly as they were');
    assert.equal(await door(), t0, 'the door on the joined wall did not move by even a rounding unit');
    assert.deepEqual(await undo(), undoBefore, 'no undo entry');
    assert.match(await hint(), /would leave a joined wall shorter than 1 15\/16"; it was left as it was/, 'the hint says why');
  }

  // Metric.
  await setUp('metric');
  at = await screen();
  await page.mouse.click(...at(2.5, 2));
  for (const typed of ['3.8m', '2.437m']) {
    const shown = await typeInto('len', typed);
    const { v, text } = await expect(typed);
    const [ax, ay, bx, by] = (await read()).walls.angled;
    assert.ok(Math.abs(Math.hypot(bx - ax, by - ay) - v) < TOL, `${typed}: stored length ${Math.hypot(bx - ax, by - ay)} m, typed ${v} m`);
    assert.equal(shown, text, `${typed}: the field shows the typed length`);
  }
  assert.equal(await page.locator('.inspector [data-len=len]').inputValue(), '2437 mm');
  await page.evaluate(async () => { const s = await import('/js/store.js'); s.ws.data.settings.units = 'imperial'; s.touch(); });

  assert.deepEqual(errors, [], 'no page errors');
  console.log('Typed lengths passed: wall length (angled, joined), opening width and elevation are stored as typed.');
} finally {
  if (browser) await browser.close();
  await new Promise(r => server.close(r));
}
