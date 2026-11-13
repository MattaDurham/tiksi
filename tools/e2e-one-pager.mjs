// ONE-PAGER: every property has a one-page teaser for its client. On a synthetic house the
// editor drafts the text from the project, lays the page out with the site photo, the budget,
// the schedule and the plan, and SAVE VERSION stores a one-page PDF among the property's
// documents; a hand edit sticks; the model can be the picture; the closing question appears only
// when the one-pager is behind the project (or never, or always, as the setting says) and saves
// the next version itself; NEW PROPERTY makes version 1 by itself; DOCUMENTS shows the newest
// version; everything survives a reload. Synthetic workspace only.
// Run: node tools/e2e-one-pager.mjs (Playwright + Chromium installed).
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
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
// The browser's own Leave site? question (a real close) is answered Cancel, as a person who stays would.
const dialogs = [];
page.on('dialog', d => { if (d.type() === 'beforeunload') { dialogs.push('beforeunload'); d.dismiss(); } else d.accept(); });
const check = (ok, label) => { assert.ok(ok, label); console.log('  ok   ' + label); };
const prop = fn => page.evaluate(async src => { const s = await import('/js/store.js'); const AsyncFunction = (async () => {}).constructor; return new AsyncFunction('s', 'p', src)(s, s.activeProperty()); }, fn);
const state = () => prop("const op = await import('/js/one-pager.js'); return op.onePagerState(p, s.projectSlice(p.id));");
const fireClose = () => page.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; });
// A prompt is open, or one is on its way: Tiksi opens it shortly after a close it held back, and
// only when closing would ask (so there is no fixed wait for one that may come late).
const promptShown = () => page.evaluate(async () => { const d = await import('/js/one-pager-dialog.js'); return d.promptOpen() || d.closeWouldAsk() || !!document.querySelector('.op-prompt'); });
const versions = () => prop('return p.onePager.versions.map(v => v.n)');
const until = async (fn, label, ms = 90000) => { const end = Date.now() + ms; while (!(await fn())) { if (Date.now() > end) throw new Error('Timed out waiting for ' + label); await page.waitForTimeout(250); } };
const docs = () => prop("return p.photos.filter(x => x.kind === 'document').map(d => ({ name: d.name, mime: d.mime, pages: d.pageCount, bytes: d.byteLength }))");

try {
  await page.goto(url + '/#/model');
  await page.waitForSelector('#btn-file');
  await page.evaluate(async () => {
    const s = await import('/js/store.js'), ps = await import('/js/photos-store.js');
    localStorage.clear();
    s.ws.data = s.emptyWorkspace();
    const p = s.propertyTemplate('Test House');
    p.address = '1 Synthetic Way';
    const lv = p.levels[0].id;
    const wall = (id, ax, ay, bx, by) => ({ id, level: lv, ax, ay, bx, by, thickness: 0.15, height: null, material: null });
    p.walls.push(wall('w-n', 0, 0, 7, 0), wall('w-e', 7, 0, 7, 4), wall('w-s', 7, 4, 0, 4), wall('w-w', 0, 4, 0, 0), wall('w-mid', 4, 0, 4, 4));
    p.openings.push({ id: 'o-front', wallId: 'w-s', type: 'door', t: 0.3, width: 0.9, height: 2.03 }, { id: 'o-win', wallId: 'w-n', type: 'window', t: 0.5, width: 1.2, height: 1.2, sill: 0.9 });
    p.rooms.push({ id: 'r-living', level: lv, name: 'Living room', pts: [[0, 0], [4, 0], [4, 4], [0, 4]], material: null, ceilingMaterial: null },
      { id: 'r-kitchen', level: lv, name: 'Kitchen', pts: [[4, 0], [7, 0], [7, 4], [4, 4]], material: null, ceilingMaterial: null });
    s.ws.data.properties.push(p); s.ws.data.settings.activePropertyId = p.id; s.ws.data.settings.programStart = '2026-11-10';
    const it = (id, name, extra) => Object.assign({ id, name, qty: 1, unit: 'ea', low: 0, likely: 0, high: 0, durationDays: 0, deps: [], elementIds: [], notes: '', status: 'todo', doneAt: '' }, extra);
    s.ws.data.projects.push({ id: 'pr-k', name: 'Kitchen refresh', propertyId: p.id, category: 'kitchen', status: 'scoped', selected: true, parentId: '', priority: '', roomId: '', source: '', startDate: '', notes: '',
      items: [it('i1', 'Cabinets', { low: 20000, likely: 25000, high: 32000, durationDays: 10 }), it('i2', 'Counters', { low: 5000, likely: 7000, high: 9000, durationDays: 3, deps: ['i1'] })] });
    s.ws.data.products.push({ id: 'prod-1', name: 'Shaker cabinets', brand: 'Acme', model: 'S-12', category: 'cabinet', price: 300, unit: 'ea', itemIds: ['i1'] });
    // A synthetic site photo: a drawn house front, so the picture at the top has something in it.
    const c = document.createElement('canvas'); c.width = 900; c.height = 600; const x = c.getContext('2d');
    x.fillStyle = '#9ec5e8'; x.fillRect(0, 0, 900, 600); x.fillStyle = '#7a5a3a'; x.fillRect(150, 230, 600, 300); x.fillStyle = '#c9a36a'; x.beginPath(); x.moveTo(110, 240); x.lineTo(450, 60); x.lineTo(790, 240); x.closePath(); x.fill();
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9));
    await ps.addPhotoFromFile(p, new File([blob], 'front.jpg', { type: 'image/jpeg' }));
    s.touch();
  });

  // ---- BUDGET and SCHEDULE show the figures the one-pager prints ----
  await page.goto(url + '/#/budget');
  await page.locator('#cap-input').waitFor();
  check(/\$32,000/.test(await page.locator('.kpi.accent .k-value').textContent()), 'BUDGET totals the selected program at $32,000 likely');
  await page.fill('#cap-input', '250k'); await page.press('#cap-input', 'Tab');
  await page.waitForFunction(() => document.querySelector('#cap-input')?.value === '$250,000');
  check(await prop('return s.ws.data.settings.budgetCap === 250000'), 'a cap typed as 250k is $250,000');
  await page.fill('#cap-input', '10x12'); await page.press('#cap-input', 'Tab');
  await page.waitForFunction(() => /is not an amount/.test(document.querySelector('#cap-note')?.textContent || ''));
  check(await prop('return s.ws.data.settings.budgetCap === 250000') && /The cap is still \$250,000/.test(await page.locator('#cap-note').textContent()), 'an amount BUDGET cannot read is refused with a reason and the cap stays');
  await page.goto(url + '/#/schedule');
  await page.locator('#prog-start').waitFor();
  check((await page.locator('.kpi.accent .k-label').textContent()) === 'Last day of work' && (await page.locator('.kpi.accent .k-value').textContent()) === 'Nov 22, 2026' && /13 calendar days/.test(await page.locator('.kpi.accent .k-sub').textContent()), 'SCHEDULE\'s last day of work is Nov 22, 2026, the 13th calendar day');
  await page.goto(url + '/#/model');
  await page.waitForSelector('#btn-file');

  // ---- the editor ----
  await page.click('#btn-file');
  check(/No one-pager saved yet/.test(await page.locator('[data-op-file-status]').textContent()), 'FILE > Project says there is no one-pager yet');
  await page.click('[data-one-pager]');
  await page.locator('.op-dialog .op-preview-page .op-page').waitFor();
  check(/No one-pager saved yet/.test(await page.locator('.op-dlg-status').textContent()), 'the editor opens and says no version is saved');
  check((await page.inputValue('[data-f="headline"]')) === 'Test House' && /2 modeled floor regions/.test(await page.inputValue('[data-f="tagline"]')), 'the headline and tagline describe the modeled floor regions');
  const summary = await page.inputValue('[data-f="summary"]');
  check(/Kitchen refresh/.test(summary) && /\$32,000/.test(summary) && /13 calendar days, from Nov 10, 2026 to Nov 22, 2026\./.test(summary) && /Acme Shaker cabinets/.test(summary), 'the summary names the scope, the likely cost, the schedule and a product');
  await page.waitForFunction(() => !!document.querySelector('.op-preview-page .op-hero img'));
  const pageText = await page.locator('.op-preview-page .op-page').innerText();
  check(/Test House/.test(pageText) && /\$32,000/.test(pageText) && /\$25,000 to \$41,000/.test(pageText) && /13 calendar days/.test(pageText) && /2 modeled floor regions/.test(pageText) && /Shaker cabinets/.test(pageText) && /not independently verified site measurements/.test(pageText), 'the page shows the headline, budget range, schedule, modeled regions and products without implying verified site measurements');
  check((await page.locator('.op-preview-page .op-plan svg polygon').count()) >= 2 && /LIVING ROOM/.test(await page.locator('.op-preview-page .op-plan').innerHTML()), 'the floor plan is drawn beside the text with its rooms named');
  check(/front\.jpg/.test(await page.locator('[data-op-hero] option').first().textContent()), 'the automatic picture is the site photo');

  // Text the page has no room for is named above the preview before anything is saved.
  check(await page.locator('[data-op-cuts]').isHidden(), 'a page that fits says nothing is cut off');
  const longSummary = Array.from({ length: 30 }, (_, i) => 'Sentence ' + (i + 1) + ' of a summary that keeps going about the work.').join(' ').slice(0, 1100);
  const longHighlights = Array.from({ length: 6 }, (_, i) => 'Highlight ' + (i + 1) + ': a description of the work that keeps going well past the width of a single line here').join('\n');
  await page.fill('[data-f="summary"]', longSummary);
  await page.fill('[data-f="highlights"]', longHighlights);
  await page.waitForFunction(() => /highlight/.test(document.querySelector('[data-op-cuts]').textContent));
  const cutText = await page.locator('[data-op-cuts]').textContent();
  check(/summary is longer than its space/.test(cutText) && /6 highlights are longer than one line/.test(cutText) && /before you save/.test(cutText), 'a long summary and long highlights are named as cut off (' + cutText + ')');
  await page.fill('[data-f="summary"]', summary);
  await page.dispatchEvent('[data-f="summary"]', 'change');
  await page.fill('[data-f="highlights"]', '');
  await page.dispatchEvent('[data-f="highlights"]', 'change');
  await page.waitForFunction(() => document.querySelector('[data-op-cuts]').hidden);
  check(true, 'shortening the text clears the warning');

  // A hand edit sticks, and the page follows it.
  await page.fill('[data-f="headline"]', 'A brighter kitchen');
  await page.dispatchEvent('[data-f="headline"]', 'change');
  await page.waitForFunction(() => /A brighter kitchen/.test(document.querySelector('.op-preview-page h1')?.textContent || ''));
  check(await prop("return p.onePager.headline === 'A brighter kitchen' && p.onePager.customized === true"), 'editing the headline lands on the property and marks the text as hand-written');

  // The model as the picture: rendered offscreen, no ceilings, so the picture changes.
  const photoSrc = await page.evaluate(() => document.querySelector('.op-preview-page .op-hero img').src);
  await page.selectOption('[data-op-hero]', 'model');
  await page.waitForFunction(old => { const i = document.querySelector('.op-preview-page .op-hero img'); return i && i.src.startsWith('data:image/jpeg') && i.src.length > 5000 && i.src !== old; }, photoSrc, { timeout: 90000 });
  const modelInk = await page.evaluate(async () => {
    const im = document.querySelector('.op-preview-page .op-hero img');
    const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight;
    const x = c.getContext('2d'); x.drawImage(im, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data;
    let ink = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] < 200 || d[i + 1] < 200 || d[i + 2] < 200) ink++;
    return { ink, px: c.width * c.height };
  });
  check(modelInk.ink > modelInk.px * 0.01, `the 3D view of the model becomes the picture at the top and draws the model (${modelInk.ink} inked pixels)`);
  await page.selectOption('[data-op-hero]', '');
  await page.waitForFunction(old => document.querySelector('.op-preview-page .op-hero img')?.src === old, photoSrc);

  // SAVE VERSION 1: a one-page PDF among the property's documents.
  check(/SAVE VERSION 1/.test(await page.locator('[data-op-save]').textContent()), 'the save button offers version 1');
  await page.click('[data-op-save]');
  await page.waitForFunction(() => /Version 1 saved/.test(document.querySelector('[data-op-note]')?.textContent || ''), null, { timeout: 90000 });
  let v = await versions(), d = await docs();
  check(v.join() === '1' && d.length === 1 && /one-pager v1/.test(d[0].name) && d[0].mime === 'application/pdf' && d[0].pages === 1 && d[0].bytes > 20000, `version 1 is a one-page PDF document (${d[0]?.name}, ${d[0]?.bytes} bytes)`);
  const magic = await prop("const v = p.onePager.versions[0]; const f = await s.getFile(v.documentId); return f && new TextDecoder().decode(new Uint8Array(f.buffer.slice(0, 5)))");
  check(magic === '%PDF-', 'the stored file really is a PDF');
  check((await state()) === 'current' && /Version 1 saved .*; current/.test(await page.locator('.op-dlg-status').textContent()), 'right after saving, the one-pager is current');
  check(/SAVE VERSION 2/.test(await page.locator('[data-op-save]').textContent()) && (await page.locator('[data-op-version="1"]').count()) === 1, 'the next save is version 2 and version 1 is listed');
  await page.click('[data-op-close]');
  await page.locator('.op-dialog').waitFor({ state: 'detached' });

  // ---- the question when Tiksi closes ----
  check((await fireClose()) === false && !(await promptShown()), 'closing while current asks nothing');
  await prop("const w = p.walls.find(x => x.id === 'w-mid'); w.ax = 3; w.bx = 3; s.touch();");
  check((await state()) === 'behind', 'moving a wall puts the one-pager behind the project');
  check((await fireClose()) === true, 'closing while behind holds the page');
  await page.locator('.op-prompt').waitFor();
  check(/Version 1 saved .*; the project changed since\. Save version 2 before you close\?/.test(await page.locator('[data-op-prompt-text]').textContent()), 'Tiksi asks whether to save version 2');
  await page.click('[data-op-later]');
  await page.locator('.op-prompt').waitFor({ state: 'detached' });
  check((await fireClose()) === false && !(await promptShown()), 'NOT NOW keeps quiet until the project changes again');
  await prop("p.rooms[0].name = 'Great room'; s.touch();");
  check((await fireClose()) === true, 'another change asks again');
  await page.locator('.op-prompt').waitFor();
  await page.click('[data-op-update]');
  await page.waitForFunction(() => /Version 2 saved/.test(document.querySelector('[data-op-prompt-text]')?.textContent || ''), null, { timeout: 90000 });
  check(true, 'UPDATE NOW saves version 2 from the prompt');
  await page.click('[data-op-done]');
  await page.locator('.op-prompt').waitFor({ state: 'detached' });
  v = await versions(); d = await docs();
  check(v.join() === '1,2' && d.length === 2 && (await state()) === 'current', 'version 2 is a second PDF and the one-pager is current again');
  check(await prop("return p.onePager.headline === 'A brighter kitchen'"), 'the hand-written headline survived the update');
  await prop("s.ws.data.settings.onePagerPrompt = 'never'; p.rooms[1].name = 'Kitchen and pantry'; s.touch();");
  check((await fireClose()) === false && !(await promptShown()), 'with the setting Never, closing asks nothing even when behind');
  await prop("s.ws.data.settings.onePagerPrompt = 'always'; s.touch();");
  check((await fireClose()) === true, 'with the setting Every time, closing asks');
  await page.locator('.op-prompt').waitFor();
  await page.click('[data-op-later]');
  await page.locator('.op-prompt').waitFor({ state: 'detached' });
  await prop("s.ws.data.settings.onePagerPrompt = 'changed'; s.touch();");
  await page.click('#btn-file');
  await page.click('[data-file-tab="settings"]');
  check((await page.inputValue('[data-op-prompt]')) === 'changed', 'FILE > Settings shows the closing choice');
  await page.selectOption('[data-op-prompt]', 'never');
  check(await prop("return s.ws.data.settings.onePagerPrompt === 'never'"), 'changing it in Settings lands on the workspace');
  await page.selectOption('[data-op-prompt]', 'changed');
  await page.click('[data-close-file]');

  // ---- NEW PROPERTY makes version 1 by itself ----
  await page.click('#btn-file');
  await page.click('[data-new-property]');
  await page.fill('#np-dialog [data-np-input]', 'Second House');
  await page.click('#np-dialog [data-np-create]');
  await until(() => prop("return p.name === 'Second House' && p.onePager.versions.length === 1"), 'the new property\'s first one-pager');
  d = await docs();
  check(d.length === 1 && /Second House - one-pager v1/.test(d[0].name) && d[0].pages === 1, 'a property made by name starts with one-pager version 1 (' + (d[0] && d[0].name) + ')');
  check(await prop("return /The modeled portion of Second House/.test(p.onePager.summary) && /not independently verified site measurements/.test(p.onePager.summary) && p.onePager.headline === 'Second House'"), 'its text identifies the modeled portion and unverified dimensions');
  check((await state()) === 'current', 'and it is current');

  // ---- DOCUMENTS shows the newest version ----
  await page.evaluate(async () => { const s = await import('/js/store.js'); s.ws.data.settings.activePropertyId = s.ws.data.properties[0].id; s.touch(); });
  await page.goto(url + '/#/documents');
  await page.locator('[data-onepager]').waitFor();
  check(/Version 2 saved/.test(await page.locator('[data-onepager] .op-file-status').textContent()), 'DOCUMENTS says version 2 is the newest');
  await page.click('[data-onepager-doc]');
  await page.waitForFunction(() => { const i = document.querySelector('.dc-viewer-page img'); return i && i.src.startsWith('data:image/jpeg'); }, null, { timeout: 90000 });
  check(/one-pager v2/.test(await page.locator('.dc-inspector').textContent()), 'the newest version opens like any saved document');

  // ---- saves made without the editor check for cut-off text too ----
  // UPDATE NOW on the closing question: a tagline too long for its line is named before saving.
  const tagWas = await prop('return p.onePager.tagline');
  check(await prop('return p.onePager.customized'), 'the text is hand-written by now, so a save prints it as typed');
  await prop("p.onePager.tagline = 'A tagline that keeps on going far past the single line the page gives it, and then some more words, and more again until it plainly cannot fit on one line'; s.touch();");
  const v3before = (await versions()).join();
  await page.evaluate(async () => { (await import('/js/one-pager-dialog.js')).openClosePrompt(); });
  await page.locator('.op-prompt').waitFor();
  await page.click('[data-op-update]');
  await page.waitForFunction(() => /Cut off on the page/.test(document.querySelector('[data-op-prompt-note]')?.textContent || ''), null, { timeout: 60000 });
  check(await page.locator('[data-op-prompt-note]').textContent() === 'Cut off on the page: the tagline is longer than one line. REVIEW FIRST to shorten it, or UPDATE NOW again to save it as it is.'
    && await page.locator('[data-op-prompt-note]').getAttribute('role') === 'alert' && (await versions()).join() === v3before, 'UPDATE NOW names the cut-off tagline and saves nothing yet');
  await page.click('[data-op-later]');
  await page.locator('.op-prompt').waitFor({ state: 'detached' });
  await prop('p.onePager.tagline = ' + JSON.stringify(tagWas) + '; s.touch();');
  // A new property's first version: its long name does not fit the headline, and a toast says so.
  const firstCut = await page.evaluate(async () => {
    const s = await import('/js/store.js'), d = await import('/js/one-pager-dialog.js');
    const q = s.propertyTemplate('Synthetic Residence With A Name Long Enough To Run Past The Two Lines The Headline Has Room For');
    s.ws.data.properties.push(q);
    const v = await d.makeFirstOnePager(q);
    const toast = document.querySelector('.toast')?.textContent || '';
    s.ws.data.properties.splice(s.ws.data.properties.indexOf(q), 1); s.touch();
    return { n: v && v.n, toast };
  });
  check(firstCut.n === 1 && /^One-pager version 1 for Synthetic Residence .* is cut off: the headline is longer than two lines\. OPEN ONE-PAGER to shorten it and save version 2\.$/.test(firstCut.toast), 'a first version that is cut off is saved and says so (' + firstCut.toast + ')');

  // ---- a reload keeps everything ----
  // The room renamed while the setting was Never left the one-pager behind: bring it up to date first.
  await page.goto(url + '/#/model');
  await page.waitForSelector('#btn-file');
  check((await state()) === 'behind' && (await fireClose()) === false, 'the room renamed earlier left the one-pager behind, but NOT NOW still holds');
  await prop("p.address = '2 Synthetic Way'; s.touch();");
  check((await fireClose()) === true, 'one more change and closing asks again');
  await page.locator('.op-prompt').waitFor();
  await page.click('[data-op-update]');
  await page.waitForFunction(() => /Version 3 saved/.test(document.querySelector('[data-op-prompt-text]')?.textContent || ''), null, { timeout: 90000 });
  await page.click('[data-op-done]');
  await page.locator('.op-prompt').waitFor({ state: 'detached' });
  check((await versions()).join() === '1,2,3' && (await state()) === 'current', 'version 3 brings it up to date');
  await page.reload();
  await page.waitForSelector('#btn-file');
  await until(async () => { try { return (await versions()).length > 0; } catch { return false; } }, 'the project after a reload');
  v = await versions();
  const kept = await prop("return { headline: p.onePager.headline, customized: p.onePager.customized, docs: p.photos.filter(x => x.kind === 'document').length }");
  check(v.join() === '1,2,3' && (await state()) === 'current' && kept.headline === 'A brighter kitchen' && kept.customized === true && kept.docs === 3, 'after a reload the versions, the current state, the PDFs and the hand-written text are still there');
  check((await fireClose()) === false && !(await promptShown()), 'and closing still asks nothing');

  // ---- a real close: the browser's own question first, then Tiksi's ----
  await prop("p.address = '3 Synthetic Way'; s.touch();");
  await page.click('#rail a[data-view="model"]');   // Chrome asks only after the person used the page
  await page.close({ runBeforeUnload: true });
  await page.locator('.op-prompt').waitFor({ timeout: 5000 });
  check(dialogs.length === 1 && /Save version 4 before you close\?/.test(await page.locator('[data-op-prompt-text]').textContent()), 'a real close shows the browser\'s Leave site? question; staying brings up Tiksi\'s');
  await page.click('[data-op-later]');
  await page.locator('.op-prompt').waitFor({ state: 'detached' });
  const closed = page.waitForEvent('close', { timeout: 5000 });
  await page.close({ runBeforeUnload: true });
  await closed;
  check(page.isClosed() && dialogs.length === 1, 'after NOT NOW the next close goes through with no question at all');

  check(errors.length === 0, 'no page errors (' + errors.join(' | ') + ')');
  console.log('\nONE-PAGER: all checks passed');
} catch (e) {
  console.error('\nONE-PAGER FAILED:', e && e.message || e);
  if (errors.length) console.error('page errors:', errors);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
