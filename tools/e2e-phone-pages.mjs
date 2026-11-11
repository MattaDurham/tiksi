// The pages other than MODEL on a phone, with real touch input: Chromium with a touch screen
// (real touches through its protocol) and, when Playwright has it, WebKit (Safari's engine) with
// the iPhone profile, both at 402 x 874 points. Synthetic demo projects in a temporary state
// directory; live 8642 is never used.
//
//   every page   no sideways scroll, every control at least 44 points, fields at 16 points
//   panel        capture first (TAKE A PHOTO pins it in MODEL, ADD A NOTE), GUIDE, quality on
//                this device, 44-point buttons, the panel keeps its scroll after a switch
//   layouts      DESKTOP LAYOUT on a phone keeps PHONE LAYOUT on screen
//   PHOTOS       one column, the camera first, details as a sheet; one new card per import;
//                the search waits for a pause
//   PROJECTS     the remove button shows and asks first
//   SCHEDULE     a tapped bar shows its dates and slack
//   DOCUMENTS    a viewer on a touch device; sheets under 16 million pixels there; "shown in
//                Finder" said as such
//   PRODUCTS     a running price check does not redraw the form being typed in
//   PHOTO TO 3D  the camera takes several photos per visit and counts them
//   FILE         every tab's controls are on screen and finger-sized, the same set as the desktop,
//                and Settings fills its model environment on MODEL
//   messages     no empty-page message points at the hidden top bar
//
// A phone profile in a desktop browser engine checks layout and behaviour, not a real phone.
// E2E_PHONE_WEBKIT=require fails without WebKit, =skip leaves it out.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { chromium, webkit, devices } from 'playwright';

const W = 402, H = 874;
const PAGES = ['photos', 'materials', 'measure', 'reconstruct', 'research', 'projects', 'products', 'budget', 'schedule', 'sheets', 'documents', 'guide'];
const failures = [];
let passed = 0;
const check = (ok, what) => { if (ok) { passed++; console.log('  ok   ' + what); } else { failures.push(what); console.log('  FAIL ' + what); } };
// Each part runs on its own: one that cannot finish is a failure, and the rest still run.
async function part(label, name, fn) {
  try { await fn(); } catch (e) { check(false, label + ': ' + name + ' could not finish: ' + String(e.message || e).split('\n')[0]); }
}

async function startServer() {
  const state = await mkdtemp(tmpdir() + '/tiksi-phone-pages-test-');
  const socket = net.createServer();
  // Several servers start in turn here, so each takes a free port of its own (not E2E_APP_PORT).
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const child = spawn('python3', ['tools/serve.py', '--port', String(port), '--state-dir', state], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.resume(); child.stderr.resume();
  const url = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 200; i++) { try { if ((await fetch(url)).ok) break; } catch {} await new Promise(r => setTimeout(r, 50)); }
  return { url, stop: async () => { child.kill(); await rm(state, { recursive: true, force: true }); } };
}

// A small JPEG made in the page, as a camera would hand one over.
const jpeg = page => page.evaluate(async () => {
  const c = document.createElement('canvas'); c.width = 64; c.height = 48;
  const g = c.getContext('2d'); g.fillStyle = '#b07040'; g.fillRect(0, 0, 64, 48); g.fillStyle = '#fff'; g.fillRect(8, 8, 20, 12);
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9));
  return Array.from(new Uint8Array(await blob.arrayBuffer()));
}).then(bytes => Buffer.from(bytes));

// What is wrong with the page at phone size: sideways scroll, controls under 44 points, fields
// under 16 points. A checkbox or radio inside a label counts by the label.
const MEASURE = () => {
  const Wd = innerWidth;
  const vis = e => { const cs = getComputedStyle(e); if (cs.visibility === 'hidden' || cs.display === 'none' || e.closest('[inert],[hidden],.fd-panel,dialog:not([open])')) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const name = e => (e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\s+/)[0] : '') + ' "' + (e.getAttribute('aria-label') || e.textContent || e.value || '').trim().slice(0, 20) + '"');
  const els = [...document.querySelectorAll('#view a[href], #view button, #view input:not([type=hidden]):not([type=file]), #view select, #view textarea, #view summary, #view [role=button], .fd-bar button')].filter(vis);
  const small = [], tiny = [];
  for (const e of els) {
    const box = (e.matches('input[type=checkbox],input[type=radio]') && e.closest('label')) ? e.closest('label') : e;
    const r = box.getBoundingClientRect();
    if (r.width < 43.5 || r.height < 43.5) small.push(name(e) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
    if (e.matches('input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]), select, textarea') && parseFloat(getComputedStyle(e).fontSize) < 16) tiny.push(name(e));
  }
  const se = document.scrollingElement;
  const scrollers = [document.getElementById('view'), ...document.querySelectorAll('#view > *, .view-scroll')];
  const sideways = se.scrollWidth > Wd + 1 || scrollers.some(x => x && !['visible', 'hidden', 'clip'].includes(getComputedStyle(x).overflowX) && x.scrollWidth > x.clientWidth + 1);
  return { small, tiny, sideways };
};

async function loadDemo(page, url) {
  await page.evaluate(async () => {
    const s = await import('/js/store.js'); const d = await import('/js/demo.js');
    s.mergeWorkspace(d.demoWorkspace()); s.ws.data.settings.activePropertyId = s.ws.data.properties[0].id; s.touch();
    await (await import('/js/disk-workspace.js')).diskWorkspace.sync();
  });
  await page.waitForFunction(() => document.querySelector('#save-status')?.textContent === 'SAVED TO DISK', null, { timeout: 60000 });
  await page.evaluate(() => { location.hash = '#/projects'; });
  await page.reload();
  await page.waitForFunction(() => /SAVED/.test(document.querySelector('#save-status')?.textContent || ''), null, { timeout: 60000 });
}

// Pages are addresses after # in one page: change that, as a tap on a link does. (WebKit never
// reports a page load for a change after # alone.)
async function go(page, url, view) {
  if (!page.url().startsWith(url)) await page.goto(url + '/#/' + view);
  else await page.evaluate(h => { if (location.hash !== h) location.hash = h; }, '#/' + view);
  await page.waitForFunction(v => document.documentElement.dataset.view === v || document.querySelector(`#rail a.active`)?.dataset.view === v, view, { timeout: 60000 });
  await page.waitForTimeout(600);
}
const openPanel = async page => { await page.locator('.fd-menu').tap(); await page.locator('.fd-panel').waitFor({ state: 'visible' }); await page.waitForTimeout(300); };

async function run(label, engine, profile) {
  console.log('-- ' + label);
  const server = await startServer();
  const { url } = server;
  const browser = engine === webkit ? await webkit.launch() : await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const errors = [];
  try {
    const context = await browser.newContext(profile);
    context.setDefaultTimeout(20000);
    context.setDefaultNavigationTimeout(120000);
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    // "Leave site?" (asked while a save runs) is answered Leave: the data is on the server.
    const answer = d => (d.type() === 'beforeunload' ? d.accept() : d.dismiss()).catch(() => {});
    page.on('dialog', answer);
    await page.goto(url + '/#/photos');
    await page.waitForFunction(() => /SAVED/.test(document.querySelector('#save-status')?.textContent || ''), null, { timeout: 60000 });
    // The phone module starts once the project files are connected: wait for its bar.
    await page.locator('.fd-bar').waitFor({ state: 'attached', timeout: 60000 });
    check(await page.evaluate(() => document.documentElement.classList.contains('touch') && document.documentElement.classList.contains('phone')), label + ': a touch phone is marked touch and gets the phone layout');

    // ---------- messages with no property yet ----------
    for (const v of ['photos', 'measure']) await part(label, v + ' with no property', async () => {
      await go(page, url, v);
      const text = await page.locator('#view').innerText();
      check(!/top bar/i.test(text) && /NEW PROPERTY under FILE/.test(text), label + ': ' + v.toUpperCase() + ' with no property points at FILE, not the hidden top bar (' + text.replace(/\s+/g, ' ').slice(0, 80) + ')');
    });

    await loadDemo(page, url);

    // ---------- every page: no sideways scroll, finger-sized controls ----------
    for (const v of PAGES) await part(label, v, async () => {
      await go(page, url, v);
      const m = await page.evaluate(MEASURE);
      check(!m.sideways, label + ': ' + v + ' does not scroll sideways at ' + W + ' points');
      check(!m.small.length, label + ': ' + v + ' has no control under 44 points' + (m.small.length ? ' (' + m.small.length + ': ' + m.small.slice(0, 4).join(', ') + ')' : ''));
      check(!m.tiny.length, label + ': ' + v + ' has no field under 16 points' + (m.tiny.length ? ' (' + m.tiny.slice(0, 3).join(', ') + ')' : ''));
    });

    await part(label, 'panel', async () => {
      // ---------- the side panel ----------
      await go(page, url, 'photos');
      await openPanel(page);
      const sections = await page.locator('.fd-panel .fd-section h2').allTextContents();
      check(sections[0] === 'Capture', label + ': the panel offers capture first (' + sections.join(', ') + ')');
      const panelSmall = await page.locator('.fd-panel').evaluate(p => [...p.querySelectorAll('button, a, select')].filter(e => e.getClientRects().length).map(e => e.getBoundingClientRect()).filter(r => r.height < 43.5).length);
      check(panelSmall === 0, label + ': every control in the panel is at least 44 points tall (' + panelSmall + ' under)');
      check(await page.locator('.fd-panel a.fd-link[href="#/guide"]').count() === 1, label + ': the panel links to the GUIDE');
      await page.locator('.fd-panel a.fd-link[href="#/guide"]').tap();
      await page.waitForFunction(() => location.hash.startsWith('#/guide') && /user guide/i.test(document.querySelector('#view')?.innerText || ''), null, { timeout: 30000 }).catch(() => {});
      check(/user guide/i.test(await page.locator('#view').innerText()), label + ': the GUIDE opens from the panel');
    });

    await part(label, 'capture', async () => {
      // Capture a photo: the camera, then MODEL asks where it was taken; DONE stops.
      await go(page, url, 'photos');
      await openPanel(page);
      // An older photo waits unpinned: placing the new one must never move it.
      const older = await page.evaluate(async bytes => {
        const s = await import('/js/store.js'), ps = await import('/js/photos-store.js');
        const rec = await ps.addPhotoFromFile(s.activeProperty(), new File([new Uint8Array(bytes)], 'older.jpg', { type: 'image/jpeg' }));
        rec.roomId = s.activeProperty().rooms[0]?.id || ''; rec.elementIds = s.activeProperty().walls[0] ? [s.activeProperty().walls[0].id] : []; s.touch();
        return { id: rec.id, roomId: rec.roomId, elementIds: rec.elementIds };
      }, [...await jpeg(page)]);
      const photosBefore = await page.evaluate(async () => (await import('/js/store.js')).activeProperty().photos.length);
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('.fd-panel [data-capture=photo]').tap()]);
      check(chooser.element ? (await chooser.element().getAttribute('capture')) === 'environment' : true, label + ': TAKE A PHOTO opens the camera');
      await chooser.setFiles({ name: 'site.jpg', mimeType: 'image/jpeg', buffer: await jpeg(page) });
      await page.waitForFunction(n => import('/js/store.js').then(s => s.activeProperty().photos.length === n + 1), photosBefore, { timeout: 30000 });
      await page.waitForFunction(() => location.hash.startsWith('#/model'), null, { timeout: 30000 });
      await page.locator('.v-wrap canvas').waitFor({ timeout: 120000 });
      await page.locator('.fd-task:not([hidden])').waitFor({ timeout: 120000 });
      check((await page.locator('.fd-task span').textContent()) === 'Tap where this photo was taken.', label + ': the photo joins PHOTOS and MODEL asks where it was taken');
      const done = await page.locator('.fd-task-done').boundingBox();
      check(done && done.width >= 44 && done.height >= 44, label + ': DONE is a 44-point target');
      // Two taps on the model: the first places the new photo; the second must not move another.
      const end = Date.now() + 240000;
      while (!(await page.evaluate(async () => (await import('/js/viewer3d.js')).viewerIdle())) && Date.now() < end) await page.waitForTimeout(250);
      const newId = await page.evaluate(() => decodeURIComponent((location.hash.match(/pin=([^&]+)/) || [])[1] || '')) || await page.evaluate(async () => (await import('/js/store.js')).activeProperty().photos.at(-1).id);
      await page.touchscreen.tap(W / 2, H * 0.55);
      await page.waitForTimeout(800);
      await page.touchscreen.tap(W / 2 + 40, H * 0.6);
      await page.waitForTimeout(800);
      const after = await page.evaluate(async ([o, n]) => { const p = (await import('/js/store.js')).activeProperty(); const a = p.photos.find(x => x.id === o), b = p.photos.find(x => x.id === n); return { olderPin: a && a.pin, olderRoom: a && a.roomId, olderEls: a && a.elementIds, newPinned: !!(b && b.pin), tool: (await import('/js/viewer3d.js')).fieldState().tool, banner: !document.querySelector('.fd-task').hidden }; }, [older.id, newId]);
      check(after.newPinned && !after.olderPin && after.olderRoom === older.roomId && JSON.stringify(after.olderEls) === JSON.stringify(older.elementIds), label + ': a tap places the new photo, and a second tap moves no other photo (' + JSON.stringify(after) + ')');
      check(after.tool === 'select' && !after.banner, label + ': after the photo is placed MODEL leaves pin mode and the banner goes');
      // DONE stops placing before any tap.
      await page.evaluate(async id => { location.hash = '#/model?pin=' + encodeURIComponent(id) + '&one=1'; }, newId);
      await page.locator('.fd-task:not([hidden])').waitFor({ timeout: 60000 });
      await page.locator('.fd-task-done').tap();
      await page.waitForFunction(() => document.querySelector('.fd-task').hidden, null, { timeout: 10000 });
      check(await page.evaluate(async () => (await import('/js/viewer3d.js')).fieldState().tool) === 'select', label + ': DONE stops placing the photo');
      // A note: the note tool and its banner.
      await openPanel(page);
      await page.locator('.fd-panel [data-capture=note]').tap();
      await page.locator('.fd-task:not([hidden])').waitFor({ timeout: 10000 });
      check((await page.locator('.fd-task span').textContent()) === 'Tap where the note belongs.' && await page.evaluate(async () => (await import('/js/viewer3d.js')).fieldState().tool) === 'note', label + ': ADD A NOTE starts the note tool and says what to tap');
      await page.locator('.fd-task-done').tap();
      await page.waitForFunction(() => document.querySelector('.fd-task').hidden, null, { timeout: 10000 });
    });

    await part(label, 'quality', async () => {
      // Quality on this device, in the panel on MODEL.
      await openPanel(page);
      // On MODEL the panel holds its own buttons too (views, chips, switches): all finger-sized.
      const modelSmall = await page.locator('.fd-panel').evaluate(p => [...p.querySelectorAll('button, a, select')].filter(e => e.getClientRects().length).map(e => [e.className, e.getBoundingClientRect().height]).filter(([, h]) => h < 43.5));
      check(modelSmall.length === 0, label + ': every control in the panel on MODEL is at least 44 points tall' + (modelSmall.length ? ' (' + modelSmall.slice(0, 3).map(([c, h]) => c + ' ' + Math.round(h)).join(', ') + ')' : ''));
      const quality = page.locator('.fd-panel .fd-quality .fd-seg');
      const qualityTitle = await page.locator('.fd-panel .fd-section:has(.fd-quality) h2').textContent();
      check((await quality.count()) === 4 && qualityTitle === 'Quality on this device', label + ': the panel has Quality on this device (' + (await quality.allTextContents()).join(', ') + ')');
      const before = await page.evaluate(async () => (await import('/js/viewer3d.js')).fieldState().quality.find(q => q.on).id);
      const pickQ = before === 'low' ? 'medium' : 'low';
      await page.locator(`.fd-panel .fd-quality .fd-seg[data-id=${pickQ}]`).tap();
      check(await page.evaluate(async () => (await import('/js/viewer3d.js')).fieldState().quality.find(q => q.on).id) === pickQ && await page.evaluate(() => localStorage.getItem('tiksi.device.quality')) === pickQ, label + ': tapping a quality sets this device\'s own quality');
      // The panel keeps its scroll after a switch.
      const body = page.locator('.fd-panel .fd-body');
      await body.evaluate(b => { b.scrollTop = Math.min(260, b.scrollHeight - b.clientHeight); });
      const scrolled = await body.evaluate(b => b.scrollTop);
      const sw = page.locator('.fd-panel .fd-switch[data-id=xray]');
      await sw.scrollIntoViewIfNeeded();
      const at = await body.evaluate(b => b.scrollTop);
      await sw.tap();
      check(scrolled > 0 && Math.abs(await page.locator('.fd-panel .fd-body').evaluate(b => b.scrollTop) - at) < 2, label + ': flipping a switch leaves the panel where it was scrolled');
      await page.locator('.fd-panel .fd-switch[data-id=xray]').tap();
    });

    await part(label, 'FILE', async () => {
      // FILE on MODEL: Settings shows the model environment, and every tab works at phone width.
      await page.locator('.fd-panel [data-file]').scrollIntoViewIfNeeded();
      await page.locator('.fd-panel [data-file]').tap();
      await page.locator('dialog.file-dialog[open]').waitFor();
      await page.locator('[data-file-tab=settings]').tap();
      await page.locator('dialog.file-dialog[open] [data-file-env]').evaluate(e => e.closest('details').open = true);
      const env = await page.locator('[data-file-env]').evaluate(e => ({ shown: getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().height > 20, controls: e.querySelectorAll('select, input, button').length }));
      check(env.shown && env.controls > 2, label + ': FILE, Settings, Model environment has its settings on MODEL (' + JSON.stringify(env) + ')');
      const fileTabs = {};
      for (const tab of ['project', 'capture', 'exchange', 'settings']) {
        await page.locator(`[data-file-tab=${tab}]`).tap();
        await page.waitForTimeout(300);
        fileTabs[tab] = await page.evaluate(() => {
          const d = document.querySelector('dialog.file-dialog[open]');
          d.querySelectorAll('section:not([hidden]) details').forEach(x => x.open = true);
          const out = [];
          for (const e of d.querySelectorAll('section:not([hidden]) :is(button, select, summary)')) {
            const cs = getComputedStyle(e), r = e.getBoundingClientRect();
            if (e.closest('[hidden]') || cs.display === 'none' || !r.width) continue;
            out.push({ name: (e.textContent.trim() || e.getAttribute('aria-label') || e.tagName).slice(0, 30), small: r.height < 43.5, off: r.left < -1 || r.right > innerWidth + 1 });
          }
          return out;
        });
      }
      const fileBad = Object.entries(fileTabs).flatMap(([t, list]) => list.filter(x => x.small || x.off).map(x => t + ': ' + x.name + (x.off ? ' off screen' : ' small')));
      check(!fileBad.length, label + ': every FILE tab\'s controls are on screen and 44 points' + (fileBad.length ? ' (' + fileBad.slice(0, 4).join('; ') + ')' : ''));
      check(fileTabs.settings.some(x => x.name === 'ADD DEMO PROJECTS') && fileTabs.settings.some(x => /Workspace backup/.test(x.name)), label + ': FILE, Settings reaches ADD DEMO PROJECTS and the workspace maintenance');
      await page.evaluate(() => document.querySelector('dialog.file-dialog[open]').close());
    });

    await part(label, 'layouts', async () => {
      // ---------- the way back from the desktop layout ----------
      await openPanel(page);
      await page.locator('.fd-desktop').scrollIntoViewIfNeeded();
      await page.locator('.fd-desktop').tap();
      await page.waitForFunction(() => !document.documentElement.classList.contains('phone'));
      const back = await page.locator('#topbar .fd-return').boundingBox();
      check(!!back && back.width >= 44 && back.height >= 44 && back.x >= 0 && back.x + back.width <= W && back.y >= 0 && back.y + back.height <= H, label + ': DESKTOP LAYOUT keeps PHONE LAYOUT on screen (' + JSON.stringify(back) + ')');
      if (back) {
        await page.locator('#topbar .fd-return').tap();
        await page.waitForFunction(() => document.documentElement.classList.contains('phone'), null, { timeout: 10000 });
        check(await page.evaluate(() => localStorage.getItem('tiksi.layout')) === null, label + ': PHONE LAYOUT goes back to following the screen');
      }
    });

    await part(label, 'PHOTOS', async () => {
      // ---------- PHOTOS ----------
      await go(page, url, 'photos');
      const grid = await page.locator('.ph-grid').boundingBox();
      check(grid && grid.width >= W - 2, label + ': PHOTOS gallery takes the whole width (' + Math.round(grid?.width || 0) + ' of ' + W + ')');
      const heads = await page.locator('.ph-head .ph-head-actions .btn').evaluateAll(bs => bs.filter(b => b.getClientRects().length).map(b => { const r = b.getBoundingClientRect(); return { act: b.dataset.act, x: r.x, y: r.y, w: r.width }; }));
      const firstBtn = heads.slice().sort((a, b) => a.y - b.y || a.x - b.x)[0];
      const cam = heads.find(h => h.act === 'camera');
      check(firstBtn && firstBtn.act === 'camera' && cam.x >= 0 && cam.x + cam.w <= W, label + ': the camera comes first and fully on screen (first: ' + (firstBtn && firstBtn.act) + ')');
      const firstCard = page.locator('.ph-card').first();
      await firstCard.tap();
      await page.waitForFunction(() => { const d = document.querySelector('.ph-detail'); return d && getComputedStyle(d).transform === 'none' || /matrix\(1, 0, 0, 1, 0, 0\)/.test(getComputedStyle(d).transform); }, null, { timeout: 5000 }).catch(() => {});
      const sheet = await page.locator('.ph-detail').boundingBox();
      check(await page.locator('.ph-layout.sheet-open').count() === 1 && sheet && sheet.y > 40 && sheet.y + sheet.height <= H + 1 && sheet.width >= W - 2, label + ': a tapped photo\'s details slide up as a sheet over the gallery (' + JSON.stringify(sheet) + ' ' + JSON.stringify(await page.evaluate(() => ({ cls: document.querySelector('.ph-layout').className, tr: getComputedStyle(document.querySelector('.ph-detail')).transform, sel: document.querySelectorAll('.ph-card.active').length, cards: document.querySelectorAll('.ph-card').length }))) + ')');
      await page.locator('.ph-sheet-close').tap();
      await page.waitForTimeout(400);
      check(await page.locator('.ph-layout.sheet-open').count() === 0, label + ': CLOSE puts the details away');
      await page.locator('.ph-card').first().tap();
      await page.locator('.ph-detail [data-act=zoom]').tap();
      const close = await page.locator('.ph-lb-close').boundingBox();
      check(close && close.width >= 44 && close.height >= 44 && close.y >= 0, label + ': the viewer\'s close button is a 44-point target on screen (' + JSON.stringify(close) + ')');
      await page.locator('.ph-lb-close').tap();
      // One new card per import: the cards already there stay the same elements.
      await page.evaluate(() => { window.__firstCard = document.querySelector('.ph-card'); });
      const pic = await jpeg(page);
      await page.locator('.ph-head input[data-file=upload]').setInputFiles([{ name: 'a.jpg', mimeType: 'image/jpeg', buffer: pic }, { name: 'b.jpg', mimeType: 'image/jpeg', buffer: pic }]);
      await page.waitForFunction(() => document.querySelectorAll('.ph-card').length >= 2 && !/IMPORTING/.test(document.querySelector('.ph-head .view-sub')?.textContent || ''), null, { timeout: 30000 });
      await page.waitForFunction(() => [...document.querySelectorAll('.ph-card .ph-name')].some(n => n.textContent === 'b.jpg'), null, { timeout: 30000 });
      check(await page.evaluate(() => !!window.__firstCard && window.__firstCard.isConnected), label + ': importing photos adds their cards without drawing the gallery again');
      // The search waits for a pause in typing.
      await page.evaluate(() => { window.__gridBefore = document.querySelector('.ph-card'); });
      await page.locator('.ph-filters [data-filter=q]').fill('zzz-no-such-photo');
      const straightAway = await page.evaluate(() => window.__gridBefore.isConnected);
      await page.waitForTimeout(450);
      check(straightAway && await page.locator('.ph-card').count() === 0, label + ': the search filters after a pause, not on every letter');
      await page.locator('.ph-filters [data-filter=q]').fill('');
      await page.waitForTimeout(450);
    });

    await part(label, 'PROJECTS', async () => {
      // ---------- PROJECTS ----------
      await go(page, url, 'projects');
      await page.locator('#proj-list .proj-card').first().tap();
      await page.locator('#items-table tr[data-item]').first().waitFor();
      const items = () => page.evaluate(async () => { const s = await import('/js/store.js'); return s.ws.data.projects.reduce((n, p) => n + p.items.length, 0); });
      const del = page.locator('#items-table tr[data-item] .row-del').first();
      const delBox = await del.boundingBox();
      check(await del.evaluate(b => getComputedStyle(b).opacity === '1') && delBox.width >= 44 && delBox.height >= 44, label + ': a scope item\'s remove button shows on a touch screen and is 44 points');
      const n0 = await items();
      let asked = '';
      page.removeAllListeners('dialog');
      page.once('dialog', d => { asked = d.message(); d.dismiss(); });
      await del.tap();
      await page.waitForTimeout(300);
      check(/^Remove ".*" from .*\? .*This cannot be undone\.$/.test(asked) && await items() === n0, label + ': removing a scope item asks first, and No keeps it (' + asked.slice(0, 60) + ')');
      page.once('dialog', d => d.accept());
      await page.locator('#items-table tr[data-item] .row-del').first().tap();
      await page.waitForTimeout(300);
      check(await items() === n0 - 1, label + ': and Yes removes it');
      page.on('dialog', answer);
      const card = await page.locator('#items-table tr[data-item]').first().boundingBox();
      check(card && card.width <= W, label + ': scope items are cards that fit the screen (' + Math.round(card?.width || 0) + ' wide)');
    });

    await part(label, 'SCHEDULE', async () => {
      // ---------- SCHEDULE ----------
      await go(page, url, 'schedule');
      await page.evaluate(async () => { const s = await import('/js/store.js'); for (const p of s.ws.data.projects) p.selected = true; s.touch(); });
      await go(page, url, 'budget'); await go(page, url, 'schedule');
      const bar = page.locator('#gantt .g-item').first();
      if (await bar.count()) {
        await bar.tap();
        const detail = await page.locator('#gantt-detail').textContent();
        check(/day.*, [A-Z][a-z]{2} \d+, \d{4} to [A-Z][a-z]{2} \d+, \d{4}, (on the critical path|slack )/.test(detail), label + ': a tapped bar shows its dates and slack (' + detail.slice(0, 80) + ')');
        const label0 = await page.locator('#gantt .gantt-svg').evaluate(svg => [...svg.querySelectorAll('line')].find(l => l.getAttribute('y1') === '0' && l.getAttribute('x1') === l.getAttribute('x2'))?.getAttribute('x1'));
        check(Number(label0) <= 130, label + ': the name column gives the chart room on a phone (separator at ' + label0 + ')');
      } else check(false, label + ': SCHEDULE has bars to tap');
    });

    await part(label, 'DOCUMENTS', async () => {
      // ---------- DOCUMENTS ----------
      await go(page, url, 'documents');
      await page.locator('[data-new-set]').tap();
      await page.waitForTimeout(500);
      check(await page.locator('[data-toolbar] [data-add]').count() === 0 && await page.locator('[data-toolbar] [data-touch-viewer]').count() === 1, label + ': DOCUMENTS is a viewer on a touch device (layout and PDFs on the Mac)');
      const docs = await page.evaluate(async () => {
        const dc = await import('/js/documentcenter.js'); const { PAPERS } = await import('/js/doc-sets.js');
        return { dpi: PAPERS.map(p => [p.id, dc.sheetDpi(p), Math.round(p.w * dc.sheetDpi(p)) * Math.round(p.h * dc.sheetDpi(p))]),
          shown: dc.openedWords({ action: 'shown', path: 'Specs/Order.webloc', folder: '/x' }), opened: dc.openedWords({ action: 'opened', path: 'Specs/Range.pdf', folder: '/x' }) };
      });
      check(docs.dpi.every(([, , px]) => px <= 16e6) && docs.dpi.find(([id]) => id === 'tabloid')[1] === 292, label + ': sheets saved on a touch device stay under 16 million pixels (' + docs.dpi.map(d => d[0] + ' ' + d[1]).join(', ') + ')');
      check(docs.shown === 'Showed Specs/Order.webloc in Finder (not a document, so it was not opened).' && docs.opened === 'Opened Specs/Range.pdf on this Mac.', label + ': a file only shown in Finder is said to be shown, not opened');
    });

    await part(label, 'PRODUCTS', async () => {
      // ---------- PRODUCTS: a running price check leaves the form alone ----------
      await page.route('**/api/material-research/**', route => {
        const path = new URL(route.request().url()).pathname;
        const body = path.endsWith('/capabilities') ? { available: true, token: 't' } : { job: { id: path.split('/').pop(), status: 'running' } };
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      });
      const pid = await page.evaluate(async () => { const s = await import('/js/store.js'); const p = s.ws.data.products[0]; p.priceCheck = { status: 'running', startedAt: new Date().toISOString(), jobId: 'job-test' }; s.touch(); return p.id; });
      await page.evaluate(h => { location.hash = h; }, '#/products?select=' + encodeURIComponent(pid));
      const nameField = page.locator('#prod-form [data-f=name]');
      await nameField.waitFor();
      await nameField.tap();
      await nameField.fill('Typed but not saved yet');
      await page.waitForTimeout(9000);   // two polls
      check(await nameField.inputValue() === 'Typed but not saved yet' && await nameField.evaluate(e => e === document.activeElement), label + ': PRODUCTS keeps what is being typed while a price check runs');
      await page.unroute('**/api/material-research/**');
      await page.evaluate(async () => { const s = await import('/js/store.js'); delete s.ws.data.products[0].priceCheck; s.touch(); });
    });

    await part(label, 'hidden stays hidden', async () => {
      await go(page, url, 'reconstruct');
      const open = await page.locator('.rc-open-model').evaluate(e => ({ hidden: e.hidden, shown: getComputedStyle(e).display !== 'none' }));
      check(open.hidden && !open.shown, label + ': PHOTO TO 3D keeps OPEN MODEL hidden until there is a model (' + JSON.stringify(open) + ')');
      await go(page, url, 'projects');
      const clear = await page.locator('#proj-clear').evaluate(e => ({ hidden: e.hidden, shown: getComputedStyle(e).display !== 'none' }));
      check(clear.hidden && !clear.shown, label + ': PROJECTS keeps its filter CLEAR hidden with no filter (' + JSON.stringify(clear) + ')');
      // A tap on the in-program label flips the checkbox and does not open the card.
      const cardEl = page.locator('#proj-list .proj-card:not(.active)').first();
      const id = await cardEl.getAttribute('data-id');
      const tap = await cardEl.locator('.bd-sel-tap').boundingBox();
      const was = await page.evaluate(async id => (await import('/js/store.js')).ws.data.projects.find(p => p.id === id).selected, id);
      await page.touchscreen.tap(tap.x + 3, tap.y + 3);
      await page.waitForTimeout(400);
      const now = await page.evaluate(async id => { const p = (await import('/js/store.js')).ws.data.projects.find(p => p.id === id); return { sel: p.selected, open: !!document.querySelector('#proj-list .proj-card.active[data-id="' + id + '"]') || document.querySelector('#proj-detail [data-f=name]')?.value === p.name }; }, id);
      check(now.sel === !was && !now.open, label + ': a tap at the edge of a card\'s checkbox flips it and does not open the card (' + JSON.stringify(now) + ')');
    });

    await part(label, 'PHOTO TO 3D', async () => {
      // ---------- PHOTO TO 3D ----------
      await go(page, url, 'reconstruct');
      const camInput = page.locator('.rc-camera');
      check(await camInput.evaluate(i => i.multiple && i.getAttribute('capture') === 'environment'), label + ': the PHOTO TO 3D camera can hand over several photos');
      await camInput.setInputFiles({ name: 'room-1.jpg', mimeType: 'image/jpeg', buffer: await jpeg(page) });
      check(await page.locator('[data-action=camera]').textContent() === 'Take another photo (1 taken)', label + ': after a photo the camera button counts it and offers the next');
      await camInput.setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not a photo') });
      check(await page.locator('[data-action=camera]').textContent() === 'Take another photo (1 taken)', label + ': a refused file is not counted');
      await page.locator('[data-action=clear]').tap();
      check(await page.locator('[data-action=camera]').textContent() === 'Take a photo', label + ': CLEAR SELECTION starts the count again');
    });

    check(!errors.length, label + ': no page errors' + (errors.length ? ' (' + errors.slice(0, 2).join(' | ') + ')' : ''));
    await context.close();
  } finally {
    await browser.close();
    await server.stop();
  }
}

// The Mac's pages, with a mouse: none of the phone's changes show there.
async function desktop() {
  console.log('-- desktop');
  const server = await startServer();
  const { url } = server;
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    context.setDefaultTimeout(20000); context.setDefaultNavigationTimeout(120000);
    const page = await context.newPage();
    page.on('dialog', d => (d.type() === 'beforeunload' ? d.accept() : d.dismiss()).catch(() => {}));
    await page.goto(url + '/#/projects');
    await page.waitForFunction(() => /SAVED/.test(document.querySelector('#save-status')?.textContent || ''), null, { timeout: 60000 });
    await loadDemo(page, url);
    await part('desktop', 'pages', async () => {
      check(!(await page.evaluate(() => document.documentElement.classList.contains('touch') || document.documentElement.classList.contains('phone'))), 'desktop: a computer is neither touch nor phone');
      await go(page, url, 'projects');
      await page.locator('#proj-list .proj-card').first().click();
      await page.locator('#items-table tr[data-item]').first().waitFor();
      const del = await page.locator('#items-table .row-del').first().evaluate(b => { const cs = getComputedStyle(b); return { bg: cs.backgroundColor, border: cs.borderTopWidth, opacity: cs.opacity, w: b.getBoundingClientRect().width }; });
      check((del.bg === 'rgba(0, 0, 0, 0)' || del.bg === 'transparent') && del.border === '0px' && del.opacity === '0' && Math.round(del.w) === 22, 'desktop: a scope item\'s remove control is the faint 22-point mark it was, no grey box (' + JSON.stringify(del) + ')');
      await page.evaluate(async () => { const s = await import('/js/store.js'); for (const p of s.ws.data.projects) p.selected = true; s.touch(); });
      await go(page, url, 'schedule');
      await page.locator('#gantt .gantt-svg').waitFor();
      const sched = await page.evaluate(() => ({ strip: !!document.querySelector('#gantt-detail'), stops: document.querySelectorAll('#gantt [tabindex]').length, rows: document.querySelectorAll('#gantt .g-rowg').length, sep: [...document.querySelectorAll('#gantt line')].find(l => l.getAttribute('y1') === '0' && l.getAttribute('x1') === l.getAttribute('x2'))?.getAttribute('x1') }));
      check(!sched.strip && sched.stops === 0 && sched.rows > 0 && sched.sep === '236', 'desktop: SCHEDULE has no new strip, no new tab stops and its full name column (' + JSON.stringify(sched) + ')');
      await go(page, url, 'documents');
      check(await page.locator('[data-toolbar] [data-touch-viewer]').count() === 0, 'desktop: DOCUMENTS keeps its layout tools');
      check(!(await page.locator('#topbar .fd-return').isVisible()), 'desktop: no PHONE LAYOUT button at full width');
    });
    await context.close();
  } finally { await browser.close(); await server.stop(); }
}

const { defaultBrowserType, ...iphone } = devices['iPhone 14 Pro'];
await desktop();
await run('chromium', chromium, { viewport: { width: W, height: H }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
const want = process.env.E2E_PHONE_WEBKIT || '';
if (want !== 'skip') {
  let ok = true;
  try { await (await webkit.launch()).close(); } catch (e) { ok = false; }
  if (ok) await run('webkit', webkit, { ...iphone, viewport: { width: W, height: H } });
  else if (want === 'require') { failures.push('WebKit is not installed'); }
  else console.log('SKIP WebKit with the iPhone profile: that browser is not installed here');
}
console.log(failures.length ? `PHONE PAGES: ${failures.length} failed, ${passed} passed` : `PHONE PAGES: all ${passed} checks passed`);
process.exit(failures.length ? 1 : 0);
