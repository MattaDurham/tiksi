// DOCUMENTS: a drawing set on a synthetic two-room house. Plan, section, elevation and 3D views
// render the model; the plan draws the cut walls, door swings, room names and the section mark;
// views move, resize and adjust on the sheet; a changed wall redraws the plan; a schedule lists the
// doors; a second sheet numbers on; SAVE PDF TO PROJECT stores revision 1 as a document of the
// property, and the set survives a reload. Synthetic workspace only.
// Run: node tools/e2e-documents.mjs (Playwright + Chromium installed).
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { dirname, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  const path = resolve(root, '.' + decodeURIComponent(req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0]));
  if (!path.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  try { const bytes = await readFile(path); res.setHeader('Content-Type', types[extname(path)] || 'application/octet-stream'); res.end(bytes); }
  catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(+(process.env.E2E_APP_PORT || 0), 'localhost', r));
const url = `http://localhost:${server.address().port}`;
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
page.setDefaultTimeout(60000);
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('dialog', d => d.accept());
const check = (ok, label) => { assert.ok(ok, label); console.log('  ok   ' + label); };
const prop = fn => page.evaluate(async src => { const s = await import('/js/store.js'); return new Function('s', 'p', src)(s, s.activeProperty()); }, fn);
const vps = () => prop('return p.docSets[0].sheets.flatMap(s => s.viewports).map(v => ({ id: v.id, kind: v.kind, x: v.x, y: v.y, w: v.w, h: v.h, scale: v.scale, number: v.number }))');
// Non-white pixels of a viewport's picture on the sheet: proof the model really drew.
const inked = id => page.evaluate(async id => {
  const href = document.querySelector(`.dc-paper svg g[data-vp-group="${id}"] image`)?.getAttribute('href');
  if (!href) return { href: '', ink: 0 };
  const im = new Image(); im.src = href; await im.decode();
  const c = document.createElement('canvas'); c.width = im.width; c.height = im.height;
  const x = c.getContext('2d'); x.drawImage(im, 0, 0);
  const d = x.getImageData(0, 0, c.width, c.height).data;
  let ink = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] < 200 || d[i + 1] < 200 || d[i + 2] < 200) ink++;
  return { href: href.slice(-40), ink };
}, id);
const waitImages = n => page.waitForFunction(n => document.querySelectorAll('.dc-paper svg image').length >= n, n, { timeout: 90000 });
// The sheet is redrawn after every change (a drag ends in one, and each rendered view brings
// another), which replaces the elements being measured: measure again until one holds still.
const boxOf = async locator => { for (let i = 0; i < 40; i++) { const b = await locator.boundingBox(); if (b) return b; await page.waitForTimeout(100); } throw new Error('No box for ' + locator); };

try {
  await page.goto(url + '/#/plan');
  await page.waitForSelector('#btn-file');
  await page.evaluate(async () => {
    const s = await import('/js/store.js');
    localStorage.clear();
    s.ws.data = s.emptyWorkspace();
    const p = s.propertyTemplate('Test House');
    p.address = '1 Synthetic Way';
    const lv = p.levels[0].id;
    const wall = (id, ax, ay, bx, by) => ({ id, level: lv, ax, ay, bx, by, thickness: 0.15, height: null, material: null });
    p.walls.push(wall('w-n', 0, 0, 7, 0), wall('w-e', 7, 0, 7, 4), wall('w-s', 7, 4, 0, 4), wall('w-w', 0, 4, 0, 0), wall('w-mid', 4, 0, 4, 4));
    p.openings.push({ id: 'o-front', wallId: 'w-s', type: 'door', t: 0.3, width: 0.9, height: 2.03 },
      { id: 'o-mid', wallId: 'w-mid', type: 'door', t: 0.5, width: 0.8, height: 2.03 },
      { id: 'o-win', wallId: 'w-n', type: 'window', t: 0.5, width: 1.2, height: 1.2, sill: 0.9 });
    p.rooms.push({ id: 'r-living', level: lv, name: 'Living room', pts: [[0, 0], [4, 0], [4, 4], [0, 4]], material: null, ceilingMaterial: null },
      { id: 'r-kitchen', level: lv, name: 'Kitchen', pts: [[4, 0], [7, 0], [7, 4], [4, 4]], material: null, ceilingMaterial: null });
    s.ws.data.properties.push(p); s.ws.data.settings.activePropertyId = p.id;
    s.touch();
  });
  await page.goto(url + '/#/documents');
  await page.locator('[data-new-set]').waitFor();
  check(await page.locator('.dc-empty').first().isVisible(), 'DOCUMENTS starts with no drawing sets');
  await page.locator('[data-new-set]').click();
  check((await page.locator('[data-sheet]').count()) === 1, 'NEW SET makes a set with one sheet');
  for (const kind of ['plan', 'section', 'elevation', 'view3d']) { await page.locator(`[data-add="${kind}"]`).click(); await page.waitForTimeout(250); }
  await waitImages(4);
  let list = await vps();
  check(list.map(v => v.kind).join() === 'plan,section,elevation,view3d' && list.map(v => v.number).join() === '1,2,3,4', 'four model views are placed and numbered 1 to 4');
  const [plan, section, elevation, view3d] = list;
  for (const v of [plan, section, elevation, view3d]) {
    await page.waitForFunction(id => !!document.querySelector(`.dc-paper svg g[data-vp-group="${id}"] image`), v.id);
    const r = await inked(v.id);
    check(r.ink > 300, `the ${v.kind} view draws the model (${r.ink} inked pixels)`);
  }
  check(plan.scale === 48 || plan.scale === 64 || plan.scale === 96, 'the plan is fitted at an architectural scale (' + plan.scale + ')');
  const svg = await page.locator('.dc-paper svg').innerHTML();
  check(/LIVING ROOM/.test(svg) && /KITCHEN/.test(svg), 'the plan labels both rooms');
  check((svg.match(/stroke-dasharray="2 1.5"/g) || []).length === 2, 'the plan draws a swing for each of the two doors');
  check(/stroke="#b3261e"/.test(svg), 'the plan marks where the section cuts');
  check(/SCALE: [0-9/]+" = 1'-0"/.test(svg) && /Test House/.test(svg) && /1 Synthetic Way/.test(svg), 'drawing labels carry the scale and the title block names the property and address');

  // Move and resize the plan by dragging; the sheet snaps to 1/8 inch.
  const hit = page.locator(`.dc-vp-hit[data-vp="${plan.id}"]`);
  const box = await boxOf(hit);
  const inch = box.width / plan.w;
  await page.mouse.move(box.x + 20, box.y + 20); await page.mouse.down();
  await page.mouse.move(box.x + 20 + inch * 0.5, box.y + 20 + inch * 0.25, { steps: 5 }); await page.mouse.up();
  list = await vps();
  check(Math.abs(list[0].x - (plan.x + 0.5)) < 0.13 && Math.abs(list[0].y - (plan.y + 0.25)) < 0.13 && (list[0].x * 8) % 1 === 0, `dragging moves the plan half an inch right and a quarter down (${plan.x} -> ${list[0].x})`);
  const handle = page.locator(`.dc-vp-handle[data-handle="${plan.id}"]`);
  const hb = await boxOf(handle);
  await page.mouse.move(hb.x + 4, hb.y + 4); await page.mouse.down();
  await page.mouse.move(hb.x + 4 + inch, hb.y + 4, { steps: 5 }); await page.mouse.up();
  list = await vps();
  check(Math.abs(list[0].w - (plan.w + 1)) < 0.13, `the corner handle makes the plan an inch wider (${plan.w} -> ${list[0].w})`);

  // Double-click to adjust: scrolling steps the scale, Esc finishes.
  const hb2 = await boxOf(hit);
  await page.mouse.dblclick(hb2.x + hb2.width / 2, hb2.y + hb2.height / 2);
  await page.locator('.dc-adjusting').waitFor();
  await page.mouse.move(hb2.x + hb2.width / 2, hb2.y + hb2.height / 2);
  await page.mouse.wheel(0, 200); await page.waitForTimeout(200);
  list = await vps();
  check(list[0].scale > plan.scale, `scrolling while adjusting zooms the plan out (${plan.scale} -> ${list[0].scale})`);
  await page.keyboard.press('Escape');
  check(!(await page.locator('.dc-adjusting').count()), 'Esc finishes adjusting');

  // Live: moving a wall in the model redraws the plan with a new picture and new vectors.
  const before = await inked(plan.id);
  const beforeSvg = await page.locator('.dc-paper svg').innerHTML();
  await prop("const w = p.walls.find(x => x.id === 'w-mid'); w.ax = 3; w.bx = 3; s.touch();");
  await page.waitForFunction(([id, old]) => { const h = document.querySelector(`.dc-paper svg g[data-vp-group="${id}"] image`)?.getAttribute('href'); return h && h.slice(-40) !== old; }, [plan.id, before.href]);
  const afterSvg = await page.locator('.dc-paper svg').innerHTML();
  check(afterSvg !== beforeSvg, 'moving a wall in the model redraws the plan on the sheet');

  // Schedules, text and a second sheet; numbering continues across sheets.
  await page.locator('[data-new-sheet]').click();
  await page.locator('[data-add="schedule"]').click();
  await page.locator('[data-add="text"]').click();
  const sheet2 = await page.locator('.dc-paper svg').innerHTML();
  check(/DOOR AND WINDOW SCHEDULE/.test(sheet2) && />D1</.test(sheet2) && />D2</.test(sheet2) && />W1</.test(sheet2), 'the schedule lists both doors and the window');
  check(/GENERAL NOTES/.test(sheet2), 'the text view shows its notes');
  list = await vps();
  check(list.find(v => v.kind === 'schedule').number === 5, 'the schedule on sheet A2 is drawing 5');
  check((await page.locator('[data-sheet]').allTextContents()).join('|').includes('A2'), 'the second sheet is A2');

  // Remove a view from the inspector.
  await page.locator(`.dc-vp-hit[data-vp="${list.find(v => v.kind === 'text').id}"]`).click({ position: { x: 5, y: 5 } });
  await page.locator('[data-del]').click();
  check((await vps()).length === 5, 'REMOVE takes the text view off the sheet');

  // A save whose file cannot be stored leaves no revision behind.
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    window.__restorePut = () => { IDBObjectStore.prototype.put = put; };
    IDBObjectStore.prototype.put = function (...args) { if (this.name === 'files') throw new DOMException('Synthetic full disk', 'QuotaExceededError'); return put.apply(this, args); };
  });
  await page.evaluate(async () => {
    window.__store = await import('/js/store.js');
    // Every change notice during the failed save, with the revisions the set held at the time.
    window.__seen = [];
    window.__offSeen = window.__store.onChange(() => window.__seen.push(window.__store.activeProperty().docSets[0].revisions.length));
  });
  await page.locator('[data-save]').click();
  // Any change elsewhere redraws the sheet while the PDF renders, with the new revision on it.
  await page.evaluate(() => window.__store.touch());
  await page.waitForFunction(() => /could not be made/.test(document.querySelector('[data-status]')?.textContent || ''), null, { timeout: 120000 });
  await page.evaluate(() => window.__restorePut());
  const afterFail = await prop('return { revs: p.docSets[0].revisions.length, docs: p.photos.filter(x => x.kind === "document").length }');
  check(afterFail.revs === 0 && afterFail.docs === 0 && /Synthetic full disk/.test(await page.locator('[data-status]').textContent()), 'a PDF that cannot be stored leaves no revision without a file, and says why');
  check(/None saved yet/.test(await page.locator('.dc-paper svg').innerHTML()), 'the title block still lists no revision');
  const seen = await page.evaluate(() => { window.__offSeen(); return window.__seen; });
  check(seen.includes(1) && seen.at(-1) === 0, 'the failed save marks the project changed after dropping the revision, so a save made meanwhile is put right (' + seen.join(', ') + ')');

  // A browser that cannot make an image that large hands back nothing: the save fails and says
  // so, and leaves no revision, instead of storing blank pages.
  await page.evaluate(() => {
    const toBlob = HTMLCanvasElement.prototype.toBlob;
    window.__restoreBlob = () => { HTMLCanvasElement.prototype.toBlob = toBlob; };
    HTMLCanvasElement.prototype.toBlob = function (cb, ...rest) { if (this.width > 4000) return cb(null); return toBlob.call(this, cb, ...rest); };
  });
  await page.locator('[data-save]').click();
  await page.waitForFunction(() => /could not draw sheet/.test(document.querySelector('[data-status]')?.textContent || ''), null, { timeout: 120000 });
  await page.evaluate(() => window.__restoreBlob());
  const afterBlank = await prop('return { revs: p.docSets[0].revisions.length, docs: p.photos.filter(x => x.kind === "document").length }');
  check(afterBlank.revs === 0 && afterBlank.docs === 0, 'a sheet image the browser cannot make leaves no revision');
  check(await page.locator('[data-status]').textContent() === 'The PDF could not be made: this browser could not draw sheet 1 as a 4964 x 3212 pixel image (292 dpi)', 'and says which sheet and size failed');

  const sizes = await page.evaluate(async () => {
    const { sheetDpi } = await import('/js/documentcenter.js'); const { PAPERS } = await import('/js/doc-sets.js');
    return PAPERS.map(p => { const d = sheetDpi(p); return { id: p.id, dpi: d, px: Math.round(p.w * d) * Math.round(p.h * d) }; });
  });
  check(sizes.every(s => s.px <= 16e6) && sizes.find(s => s.id === 'tabloid').dpi === 292, 'every paper size stays under 16 million pixels, which iPhone and iPad Safari can draw (' + sizes.map(s => s.id + ' ' + s.dpi + ' dpi').join(', ') + ')');

  // Save a PDF of the set into the property as revision 1.
  await page.locator('[data-save]').click();
  await page.waitForFunction(() => /Saved/.test(document.querySelector('[data-status]')?.textContent || ''), null, { timeout: 120000 });
  check(/\(sheets at 292 dpi\)\.$/.test(await page.locator('[data-status]').textContent()), 'the save says the resolution it used');
  const info = await page.evaluate(async () => {
    const s = await import('/js/store.js'); const { photoBytes } = await import('/js/photos-store.js');
    const p = s.activeProperty(); const r = p.docSets[0].revisions[0]; const d = p.photos.find(x => x.id === r.documentId);
    const b = new Uint8Array(await photoBytes(d.id)); const t = new TextDecoder('latin1').decode(b);
    return { n: r.n, name: d.name, mime: d.mime, pages: d.pageCount, head: t.slice(0, 8), count: (t.match(/\/Type \/Page /g) || []).length, widths: [...t.matchAll(/\/Width (\d+)/g)].map(m => +m[1]) };
  });
  check(info.n === 1 && info.mime === 'application/pdf' && /rev 1/.test(info.name), 'SAVE PDF TO PROJECT stores revision 1 as a PDF document (' + info.name + ')');
  check(info.head === '%PDF-1.4' && info.count === 2 && info.pages === 2, 'the PDF has one page per sheet (' + info.count + ')');
  check(info.widths.length === 2 && info.widths.every(w => w === 17 * 292), 'each tabloid sheet is drawn at 292 dpi, so small dimensions stay sharp (' + info.widths.join(', ') + ' px wide)');
  check(/>1 {3}\d{4}-\d{2}-\d{2} {3}Issued</.test(await page.locator('.dc-paper svg').innerHTML()), 'the title block lists revision 1');
  await page.locator('[data-doc]').first().click();
  await page.locator('.dc-viewer-page img').waitFor();
  check((await page.locator('.dc-pager').textContent()).includes('Page 1 of 2'), 'the saved PDF opens in SAVED DOCUMENTS with its two pages');

  // The set is part of the property: it is still there after a reload.
  await page.waitForTimeout(800);
  await page.reload();
  await page.locator('[data-set]').first().waitFor();
  const kept = await prop('return { sheets: p.docSets[0].sheets.length, views: p.docSets[0].sheets.flatMap(s => s.viewports).length, revs: p.docSets[0].revisions.length }');
  check(kept.sheets === 2 && kept.views === 5 && kept.revs === 1, 'after a reload the set still has 2 sheets, 5 views and revision 1');
  await mkdir('test-results', { recursive: true });
  await page.locator('[data-set]').first().click();
  await waitImages(4);
  await page.screenshot({ path: 'test-results/documents.png' });
  check(!errors.length, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  console.log('DOCUMENTS e2e passed');
} finally {
  await browser.close();
  server.close();
}
