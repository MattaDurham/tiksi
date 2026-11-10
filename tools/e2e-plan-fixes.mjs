// PLAN's guards, on the real canvas with a mouse: a calibration of zero length, removing the
// underlay, a corner dragged onto the other end of its wall, a window sill at the floor, the
// property's source link, printing the opening schedule, and the work done per drawn frame.
// A synthetic 6 x 4 m house split by a partition at x = 3, a window on the east wall and a
// tracing underlay. Ephemeral origin and browser profile; no live state.
// Run: node tools/e2e-plan-fixes.mjs (Playwright + Chromium installed). E2E_ROOT serves another
// checkout's files instead of this one (to see each check fail without its fix).
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
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
const only = (process.env.E2E_ONLY || '').split(',').filter(Boolean);
const part = name => !only.length || only.includes(name);

let browser;
try {
  await new Promise(r => server.listen(Number(process.env.E2E_APP_PORT) || 0, 'localhost', r));
  const url = `http://localhost:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  // Dialogs: `answer` decides confirm(); every message is kept.
  let answer = true; const dialogs = [];
  page.on('dialog', d => { dialogs.push(d.message()); return answer ? d.accept() : d.dismiss(); });
  await page.goto(url + '/#/budget');
  await page.locator('#cap-input').waitFor();

  const house = () => page.evaluate(async () => {
    const s = await import('/js/store.js');
    const p = s.activeProperty();
    s.ensureLevels(p);
    const level = p.levels[0].id;
    p.activeLevelId = level;
    p.levels = [p.levels[0]];
    p.levels[0].height = 2.44;
    const wall = (id, ax, ay, bx, by, thickness = 0.114) => ({ id, level, ax, ay, bx, by, thickness, height: null, material: null });
    p.walls = [
      wall('south', 0, 0, 6, 0, 0.165), wall('east', 6, 0, 6, 4, 0.165),
      wall('north', 6, 4, 0, 4, 0.165), wall('west', 0, 4, 0, 0, 0.165), wall('mid', 3, 0, 3, 4),
    ];
    p.openings = [{ id: 'win', wallId: 'east', t: 0.5, type: 'window', width: 0.914, height: 1.219, sill: 0.762 }];
    p.rooms = [];
    p.fixtures = [];
    p.photoPositions = [];
    p.source = null;
    const c = document.createElement('canvas'); c.width = c.height = 4;
    const g = c.getContext('2d'); g.fillStyle = '#ffffff'; g.fillRect(0, 0, 4, 4);
    p.levels[0].plan = { img: c.toDataURL('image/png'), imgW: 10, imgH: 8, mPerPx: 1, opacity: 0.5, offsetX: -2, offsetY: -2, calibrated: true };
    s.touch();
  });
  const frames = (n = 2) => page.evaluate(n => new Promise(r => { const step = k => k ? requestAnimationFrame(() => step(k - 1)) : r(); step(n); }), n);
  async function openPlan() {
    await page.evaluate(() => { location.hash = '#/budget'; });
    await page.locator('#cap-input').waitFor();
    await page.locator('#rail a[data-view="plan"]').click({ noWaitAfter: true });
    await page.locator('.plan-canvas canvas').waitFor();
    await page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.animationName === 'view-in').map(a => a.finished)));
    await frames();
    await page.keyboard.press('Escape');   // PLAN keeps its selection across visits
    await page.keyboard.press('f');
    await frames();
  }
  await house();
  await openPlan();
  const canvasLoc = page.locator('.plan-canvas canvas');

  // Screen position of a plan point from FIT VIEW's rule: the bounds are the underlay, (-2,-2) to (8,6).
  const box = await canvasLoc.boundingBox();
  const wrap = await page.locator('.plan-canvas').evaluate(e => ({ w: e.clientWidth, h: e.clientHeight }));
  const b = { minX: -2, minY: -2, maxX: 8, maxY: 6 };
  const w = wrap.w - RULER, h = wrap.h - RULER, bw = b.maxX - b.minX, bh = b.maxY - b.minY;
  const zoom = Math.min(w / (bw * 1.22), h / (bh * 1.22), 250);
  const panX = b.minX - (w / zoom - bw) / 2 - RULER / zoom, panY = b.minY - (h / zoom - bh) / 2 - RULER / zoom;
  const at = (x, y) => [box.x + (x - panX) * zoom, box.y + (y - panY) * zoom];
  const prop = () => page.evaluate(async () => {
    const s = await import('/js/store.js');
    return JSON.parse(JSON.stringify(s.activeProperty(), (k, v) => k === 'img' ? (v ? 'image' : v) : v));
  });
  const inspector = () => page.locator('.inspector').innerText();
  const hint = () => page.locator('.canvas-hint').innerText();
  // Is the canvas still drawing? A pan must change what is on it.
  const canvasPixels = () => canvasLoc.evaluate(c => c.toDataURL().length + ':' + c.toDataURL().slice(-200));

  if (part('calibrate')) {
    // 1. CALIBRATE: two clicks on the same spot measure nothing and must not set a scale.
    await page.keyboard.press('c');
    await page.mouse.dblclick(...at(1, 1));
    await frames();
    if (await page.locator('[data-cal-input]').count()) {
      // Without the guard the distance form opens; applying it is what froze the plan.
      await page.locator('[data-cal-input]').fill('10ft');
      await page.locator('[data-cal-apply]').click();
      await frames();
    }
    let p = await prop();
    assert.equal(p.levels[0].plan.mPerPx, 1, 'a zero-length calibration leaves the scale as it was');
    assert.match(await hint(), /too close together/, 'the hint says why nothing happened');
    // The plan still draws: a drag with the middle button pans and changes the picture.
    const before = await canvasPixels();
    await page.mouse.move(...at(4, 3)); await page.mouse.down({ button: 'middle' });
    await page.mouse.move(at(4, 3)[0] + 60, at(4, 3)[1] + 40, { steps: 4 }); await page.mouse.up({ button: 'middle' });
    await frames();
    assert.notEqual(await canvasPixels(), before, 'the canvas keeps drawing');
    await page.mouse.move(...at(4, 3)); await page.mouse.down({ button: 'middle' });
    await page.mouse.move(...at(4, 3).map((v, i) => v - [60, 40][i]), { steps: 4 }); await page.mouse.up({ button: 'middle' });
    await frames();
    // A real calibration still works: 4 m apart on the image, typed as 2 m, halves the scale.
    // (The refused click kept the first point; Esc starts over.)
    await page.keyboard.press('Escape');
    await page.mouse.click(...at(0, 1));
    await page.mouse.click(...at(4, 1));
    await page.locator('[data-cal-input]').waitFor();
    await page.locator('[data-cal-input]').fill('2m');
    await page.locator('[data-cal-apply]').click();
    p = await prop();
    near(p.levels[0].plan.mPerPx, 0.5, 0.02, 'a two-point calibration sets the scale');
    await page.evaluate(async () => { const s = await import('/js/store.js'); Object.assign(s.activeProperty().levels[0].plan, { mPerPx: 1, offsetX: -2, offsetY: -2 }); s.touch(); });
    await page.keyboard.press('v');
    await page.keyboard.press('f');
    await frames();
    console.log('calibrate: a zero-length calibration is refused and the plan keeps drawing.');
  }

  if (part('underlay')) {
    // 2. Backspace on a selected underlay asks first; No keeps it, and a dialog over PLAN owns the keys.
    await page.mouse.click(...at(-1, -1));
    assert.match(await inspector(), /PLAN UNDERLAY/);
    answer = false; dialogs.length = 0;
    await page.keyboard.press('Backspace');
    assert.ok((await prop()).levels[0].plan, 'answering No keeps the underlay');
    assert.equal(dialogs.length, 1, 'Backspace asked before removing the underlay');
    assert.match(dialogs[0], /UNDO cannot bring/);
    await page.evaluate(() => { const d = document.createElement('dialog'); d.id = 'test-dialog'; d.textContent = 'over PLAN'; document.body.append(d); d.showModal(); });
    answer = true; dialogs.length = 0;
    await page.keyboard.press('Backspace');
    assert.ok((await prop()).levels[0].plan, 'a key pressed in a dialog over PLAN leaves the underlay alone');
    assert.equal(dialogs.length, 0, 'nothing was asked while the dialog was open');
    await page.evaluate(() => { const d = document.getElementById('test-dialog'); d.close(); d.remove(); });
    await page.keyboard.press('Backspace');
    assert.equal((await prop()).levels[0].plan, null, 'answering Yes removes it');
    await house();
    await openPlan();
    console.log('underlay: Backspace asks first and is ignored under a dialog.');
  }

  if (part('zero-wall')) {
    // 3. Dragging the partition's north end onto its south end stops 5 cm short.
    await page.mouse.click(...at(3, 2));
    assert.match(await inspector(), /WALL/);
    await page.mouse.move(...at(3, 4)); await page.mouse.down();
    await page.mouse.move(...at(3, 0.3), { steps: 10 });
    await page.mouse.move(...at(3, 0), { steps: 6 });
    await page.mouse.move(...at(3.002, 0.001), { steps: 2 });
    await page.mouse.up();
    let p = await prop();
    const mid = p.walls.find(w => w.id === 'mid');
    const L = Math.hypot(mid.bx - mid.ax, mid.by - mid.ay);
    assert.ok(L >= 0.05, `the wall keeps at least 5 cm of length (got ${L})`);
    for (const v of [mid.ax, mid.ay, mid.bx, mid.by]) assert.ok(Number.isFinite(v), 'wall ends stay numbers');
    // Its Length field still works: 2 m along the same direction.
    await page.locator('.inspector [data-len=len]').fill('2m');
    await page.locator('.inspector [data-len=len]').press('Enter');
    p = await prop();
    const m2 = p.walls.find(w => w.id === 'mid');
    near(Math.hypot(m2.bx - m2.ax, m2.by - m2.ay), 2, 0.01, 'a typed length applies');
    for (const v of [m2.ax, m2.ay, m2.bx, m2.by]) assert.ok(Number.isFinite(v), 'typed length gives numbers');
    await house();
    await openPlan();
    console.log('zero-wall: a corner cannot be dragged onto the other end of its wall.');
  }

  if (part('sill')) {
    // 4. A window sill can be typed as 0, and a sill never pushes the window above the wall top.
    await page.mouse.click(...at(6, 2));
    assert.match(await inspector(), /WINDOW/);
    await page.locator('.inspector [data-len=s]').fill('0');
    await page.locator('.inspector [data-len=s]').press('Enter');
    let win = (await prop()).openings.find(o => o.id === 'win');
    assert.equal(win.sill, 0, 'a sill at the floor is accepted');
    await page.locator('.inspector [data-len=s]').fill('2m');
    await page.locator('.inspector [data-len=s]').press('Enter');
    win = (await prop()).openings.find(o => o.id === 'win');
    near(win.sill, 2, 1e-9, 'sill typed');
    assert.ok(win.sill + win.height <= 2.44 + 1e-6, `the window stays inside its 2.44 m wall (sill ${win.sill} + height ${win.height})`);
    await house();
    await openPlan();
    console.log('sill: 0 is accepted and the window stays inside its wall.');
  }

  if (part('link')) {
    // 5. The property's source link is a link only when it is a web address.
    const card = page.locator('.inspector .src-card');
    const setSource = url => page.evaluate(async url => { const s = await import('/js/store.js'); s.activeProperty().source = { kind: 'polycam', url, title: 'Synthetic capture' }; s.touch(); }, url);
    await setSource('javascript:alert(document.domain)');
    await openPlan();
    await card.waitFor();
    assert.equal(await card.locator('a').count(), 0, 'a javascript: address is not a link');
    assert.match(await card.innerText(), /Synthetic capture/, 'its title still shows');
    await setSource('https://example.com/capture/1');
    await openPlan();
    assert.equal(await card.locator('a').getAttribute('href'), 'https://example.com/capture/1', 'a web address is a link');
    await house();
    await openPlan();
    console.log('link: only web addresses become links.');
  }

  if (part('print')) {
    // 6. Every PRINT button prints its own sheet (PLAN's opening schedule on white, once its
    //    image is ready); Cmd+P afterwards prints the page, not the sheet left behind. The
    //    browser's print is stood in for: like a real one it fires beforeprint first (twice,
    //    as Safari does when the paper size changes) and then afterprint.
    await page.evaluate(() => {
      window.__prints = [];
      window.print = () => {
        window.dispatchEvent(new Event('beforeprint'));
        window.dispatchEvent(new Event('beforeprint'));
        const root = document.getElementById('print-root'), img = root.querySelector('.s-plan');
        window.__prints.push({ sheet: root.firstElementChild ? root.firstElementChild.className : '', text: root.innerText.slice(0, 200),
          ready: !!img && img.complete && img.naturalWidth > 0, src: img ? img.src : '' });
        window.dispatchEvent(new Event('afterprint'));
      };
      // Cmd+P: the key, then the browser's own print of the page (no PRINT button).
      window.__cmdP = () => {
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', metaKey: true, bubbles: true }));
        window.dispatchEvent(new Event('beforeprint'));
        return document.getElementById('print-root').children.length;
      };
    });
    const appOnPaper = async () => { await page.emulateMedia({ media: 'print' }); const d = await page.locator('#app').evaluate(e => getComputedStyle(e).display); await page.emulateMedia({ media: 'screen' }); return d; };
    await page.locator('[data-chk=numbers]').check();
    await page.locator('[data-ps=print]').click();
    await page.waitForFunction(() => window.__prints.length === 1);
    const printed = await page.evaluate(async () => {
      const shot = window.__prints[0];
      const img = new Image(); img.src = shot.src; await img.decode();
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const g = c.getContext('2d'); g.drawImage(img, 0, 0);
      const px = (x, y) => Array.from(g.getImageData(x, y, 1, 1).data.slice(0, 3));
      return { ...shot, corner: px(4, 4), middle: px(Math.round(img.width * 0.5), Math.round(img.height * 0.08)) };
    });
    assert.match(printed.sheet, /opening-sheet/, 'PLAN PRINT printed the opening schedule');
    assert.ok(printed.ready, 'the plan image was decoded before printing');
    for (const v of [...printed.corner, ...printed.middle]) assert.ok(v > 235, `the printed plan is on white: ${printed.corner} ${printed.middle}`);
    assert.equal(await appOnPaper(), 'none', 'while the sheet is there, paper shows only the sheet');
    assert.equal(await page.evaluate(() => window.__cmdP()), 0, 'Cmd+P after a PLAN print empties the old sheet');
    assert.notEqual(await appOnPaper(), 'none', 'and prints the page instead');
    await page.locator('[data-chk=numbers]').uncheck();

    // The budget report: its PRINT prints it, a later Cmd+P does not.
    await page.evaluate(() => { location.hash = '#/budget'; });
    await page.locator('#print-report').click();
    await page.waitForFunction(() => window.__prints.length === 2);
    assert.ok((await page.evaluate(() => window.__prints[1].text)).length > 0, 'the budget PRINT printed its report');
    assert.equal(await page.evaluate(() => window.__cmdP()), 0, 'Cmd+P after a budget print empties the old report');
    assert.notEqual(await appOnPaper(), 'none', 'and prints the page instead');

    // A product cut sheet.
    await page.evaluate(async () => { const s = await import('/js/store.js'); s.ws.data.products.push({ id: 'prod-print-check', name: 'Synthetic faucet', category: 'plumbing', price: 100 }); s.touch(); location.hash = '#/sheets'; });
    await page.locator('#print-sheet').click();
    await page.waitForFunction(() => window.__prints.length === 3);
    assert.ok((await page.evaluate(() => window.__prints[2].text)).length > 0, 'the cut sheet PRINT printed its sheet');
    assert.equal(await page.evaluate(() => window.__cmdP()), 0, 'Cmd+P after a cut sheet print empties it');
    await page.evaluate(async () => { const s = await import('/js/store.js'); s.ws.data.products = s.ws.data.products.filter(p => p.id !== 'prod-print-check'); s.touch(); });
    await house();
    await openPlan();
    console.log('print: each PRINT prints its sheet (PLAN on white, when ready); Cmd+P afterwards prints the page.');
  }

  if (part('renumber')) {
    // 8. Sliding a window past another renumbers them; the schedule panel and the inspector
    //    show the new numbers as soon as the drag ends.
    await page.evaluate(async () => {
      const s = await import('/js/store.js');
      const p = s.activeProperty();
      p.openings = [
        { id: 'wa', wallId: 'south', t: 0.2, type: 'window', width: 0.6, height: 1, sill: 0.8 },
        { id: 'wb', wallId: 'south', t: 0.6, type: 'window', width: 0.6, height: 1, sill: 0.8 },
      ];
      s.touch();
    });
    await openPlan();
    await page.locator('[data-chk=numbers]').check();
    const panel = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.plan-schedule .ps-row')].map(r => [r.dataset.id, r.querySelector('.ps-num').textContent])));
    const fresh = () => page.evaluate(async () => {
      const s = await import('/js/store.js'), { openingSchedule } = await import('/js/opening-schedule.js');
      const p = s.activeProperty();
      return Object.fromEntries(openingSchedule(p, p.activeLevelId).map(r => [r.id, r.number]));
    });
    const before = await panel();
    assert.deepEqual(before, await fresh());
    await page.mouse.move(...at(1.2, 0)); await page.mouse.down();
    await page.mouse.move(...at(5.2, 0), { steps: 14 }); await page.mouse.up();
    const after = await fresh();
    assert.notDeepEqual(after, before, 'the slide changed the numbering');
    assert.deepEqual(await panel(), after, 'the schedule panel shows the numbers as they are after the drag');
    assert.match(await inspector(), new RegExp('^WINDOW ' + after.wa), 'the inspector names the dragged window by its new number');
    await page.locator('[data-chk=numbers]').uncheck();
    await house();
    await openPlan();
    console.log('renumber: the panel and inspector follow a drag that renumbers openings.');
  }

  if (part('slide')) {
    // 9. Sliding the north wall onto the south wall stops before the east, west and middle
    //    walls (which it squeezes) get shorter than 5 cm.
    await page.mouse.move(...at(1.5, 4)); await page.mouse.down();
    await page.mouse.move(...at(1.5, 0.5), { steps: 12 });
    await page.mouse.move(...at(1.5, 0), { steps: 6 });
    await page.mouse.move(...at(1.5, -0.6), { steps: 6 });
    await page.mouse.up();
    const p = await prop();
    for (const w of p.walls) {
      const L = Math.hypot(w.bx - w.ax, w.by - w.ay);
      assert.ok(L >= 0.05 - 1e-9, `${w.id} keeps at least 5 cm (got ${L.toFixed(3)} m)`);
    }
    const north = p.walls.find(w => w.id === 'north');
    assert.ok(north.ay < 4 - 1 && north.ay >= 0.05 - 1e-9, `the north wall did slide, and stopped short (${north.ay})`);
    await house();
    await openPlan();
    console.log('slide: a wall slide cannot squeeze a joined wall to nothing.');
  }

  if (part('cancel')) {
    // 10. A drag the browser cancels puts the wall back, tells the store (so an autosave that
    //     ran meanwhile is corrected), and still does so when another change arrived mid-drag.
    await page.evaluate(async () => {
      const s = await import('/js/store.js');
      window.__changes = 0;
      s.onChange(() => { window.__changes++; });
    });
    await page.mouse.move(...at(3, 2)); await page.mouse.down();
    await page.mouse.move(...at(4.2, 2), { steps: 10 });
    let mid = (await prop()).walls.find(w => w.id === 'mid');
    assert.ok(mid.ax > 3.5, 'the partition is moving');
    // Another change while the drag runs (a save from another device does the same).
    await page.evaluate(async () => { const s = await import('/js/store.js'); s.touch(); });
    await page.mouse.move(...at(4.5, 2), { steps: 3 });
    const changes = await page.evaluate(() => window.__changes);
    await page.locator('.plan-canvas canvas').evaluate(c => c.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, pointerType: 'mouse', bubbles: true })));
    await page.mouse.up();
    mid = (await prop()).walls.find(w => w.id === 'mid');
    assert.deepEqual([mid.ax, mid.ay, mid.bx, mid.by], [3, 0, 3, 4], 'the cancelled drag put the partition back');
    assert.ok(await page.evaluate(() => window.__changes) > changes, 'the store heard of the put-back walls');
    await house();
    await openPlan();
    console.log('cancel: a cancelled drag is put back and saved, even after a change mid-drag.');
  }

  if (part('scale')) {
    // 11. A file saved with a scale that is not a number opens with a usable, uncalibrated scale.
    await page.evaluate(async () => { const s = await import('/js/store.js'); Object.assign(s.activeProperty().levels[0].plan, { mPerPx: Infinity, offsetX: NaN, calibrated: true }); s.touch(); });
    await openPlan();
    const pl = (await prop()).levels[0].plan;
    assert.ok(Number.isFinite(pl.mPerPx) && pl.mPerPx > 0, `the scale is a positive number again (${pl.mPerPx})`);
    assert.equal(pl.calibrated, false, 'and marked not calibrated');
    assert.ok(Number.isFinite(pl.offsetX), 'the offset is a number again');
    await house();
    await openPlan();
    console.log('scale: a saved non-number scale is repaired when PLAN opens.');
  }

  if (part('frames')) {
    // 7. Work per drawn frame grows with the plan, not with its square: a drag on a plan of
    //    1,624 walls (numbered openings and dimensions on) costs a few times one of 220 walls,
    //    not dozens.
    // A k x k grid of rooms, each closed by its four walls (2k(k+1) walls), a numbered
    // opening on every other wall.
    const big = k => page.evaluate(async k => {
      const s = await import('/js/store.js');
      const p = s.activeProperty();
      const level = p.levels[0].id;
      p.walls = []; p.openings = []; p.rooms = [];
      const add = (id, ax, ay, bx, by) => {
        p.walls.push({ id, level, ax, ay, bx, by, thickness: 0.114, height: null, material: null });
        if (p.walls.length % 2) p.openings.push({ id: 'o' + id, wallId: id, t: 0.5, type: p.walls.length % 4 === 1 ? 'door' : 'window', width: 0.8, height: 1, sill: 0.8 });
      };
      const S = 3;
      for (let r = 0; r <= k; r++) for (let c = 0; c < k; c++) add(`h${r}_${c}`, c * S, r * S, (c + 1) * S, r * S);
      for (let c = 0; c <= k; c++) for (let r = 0; r < k; r++) add(`v${r}_${c}`, c * S, r * S, c * S, (r + 1) * S);
      for (let r = 0; r < k; r++) for (let c = 0; c < k; c++) p.rooms.push({ id: `r${r}_${c}`, level, name: `R${r}.${c}`, material: 'mat-oak', pts: [[c * S, r * S], [(c + 1) * S, r * S], [(c + 1) * S, (r + 1) * S], [c * S, (r + 1) * S]] });
      p.levels[0].plan = null;
      s.touch();
      return p.walls.length;
    }, k);
    const frameCost = async k => {
      const n = await big(k);
      // A partition near the middle with no opening on it, opened by PLAN's own link, which
      // selects it and centres it on the canvas.
      const id = await page.evaluate(async k => {
        const s = await import('/js/store.js');
        const p = s.activeProperty(), c = Math.floor(k / 2);
        const held = new Set(p.openings.map(o => o.wallId));
        return [`v${c}_${c}`, `v${c - 1}_${c}`, `v${c}_${c + 1}`, `v${c - 1}_${c + 1}`].find(id => !held.has(id));
      }, k);
      await page.evaluate(() => { location.hash = '#/budget'; });
      await page.locator('#cap-input').waitFor();
      await page.evaluate(id => { location.hash = '#/plan?select=' + id; }, id);
      await page.locator('.plan-canvas canvas').waitFor();
      await page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.animationName === 'view-in').map(a => a.finished)));
      await frames(3);
      await page.locator('[data-chk=numbers]').check();
      await page.locator('[data-chk=dims]').check();
      const [cx, cy] = [box.x + (wrap.w + RULER) / 2, box.y + (wrap.h + RULER) / 2];
      const start = (await prop()).walls.find(x => x.id === id);
      assert.equal((await prop()).walls.length, n);
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      await page.mouse.move(cx + 8, cy, { steps: 2 });
      await frames(2);
      const times = [];
      for (let i = 0; i < 12; i++) {
        // From the move to the second frame after it, timed outside the page, so a frame that
        // blocks the page before the timing script runs is counted too.
        const t0 = performance.now();
        await page.mouse.move(cx + 10 + i * 2, cy);
        await frames(2);
        times.push(performance.now() - t0);
      }
      const moved = (await prop()).walls.find(x => x.id === id);
      await page.mouse.up();
      assert.ok(Math.abs(moved.ax - start.ax) > 0.1, `the drag at ${n} walls moved the partition (${start.ax} to ${moved.ax})`);
      if (process.env.E2E_DEBUG) console.log(n, times.map(t => t.toFixed(0)).join(' '));
      await page.locator("#btn-undo").click();
      await page.locator('[data-chk=numbers]').uncheck();
      await page.locator('[data-chk=dims]').uncheck();
      times.sort((a, b) => a - b);
      return times[Math.floor(times.length / 2)];
    };
    const small = await frameCost(10), large = await frameCost(28);   // 220 and 1,624 walls
    console.log(`frames: median two-frame wait during a drag ${small.toFixed(1)} ms at 220 walls, ${large.toFixed(1)} ms at 1,624 walls`);
    assert.ok(large < small * 5, `a drag on 8x the walls costs ${(large / small).toFixed(1)}x per frame; it should grow about linearly, not with the square`);
    await house();
    await openPlan();
  }

  assert.deepEqual(errors, [], 'no page errors');
  console.log('PLAN guards passed.');
} finally {
  if (browser) await browser.close();
  await new Promise(r => server.close(r));
}
