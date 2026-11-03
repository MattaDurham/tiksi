// Right-hand panes resize from their border in every view, and the photo deck lifts the card
// under the pointer. Synthetic project in a temporary state directory; live 8642 is never used.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { chromium } from 'playwright';

const state = await mkdtemp(tmpdir() + '/tiksi-side-panes-test-');
const socket = net.createServer();
await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
const port = socket.address().port;
await new Promise(resolve => socket.close(resolve));
const child = spawn('python3', ['tools/serve.py', '--port', String(port), '--state-dir', state], { stdio: ['ignore', 'pipe', 'pipe'] });
const url = 'http://127.0.0.1:' + port;
let browser;
try {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url)).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url); await page.waitForFunction(() => document.querySelector('#save-status').textContent === 'SAVED TO DISK');
  await page.evaluate(async () => {
    const store = await import('/js/store.js');
    const property = store.propertyTemplate('Synthetic deck project');
    const c = document.createElement('canvas'); c.width = 160; c.height = 120; const g = c.getContext('2d');
    for (let i = 0; i < 30; i++) {
      g.fillStyle = `hsl(${i * 37 % 360} 55% 45%)`; g.fillRect(0, 0, 160, 120);
      property.photos.push({ id: 'ph-syn-' + i, name: 'Synthetic photo ' + (i + 1), kind: 'photo', thumb: c.toDataURL('image/jpeg', 0.7), mime: 'image/jpeg' });
    }
    store.ws.data.properties.push(property); store.ws.data.settings.activePropertyId = property.id; store.touch();
    await (await import('/js/disk-workspace.js')).diskWorkspace.sync();
  });

  // ---------- photo deck ----------
  await page.goto(url + '/#/photos'); await page.reload();
  await page.locator('.ph-card').nth(29).waitFor();
  // The disk sync rebuilds the view once, under a second after a load; start from a still page.
  const settle = () => page.evaluate(() => new Promise(resolve => {
    let timer = setTimeout(done, 1500);
    const mo = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(done, 1500); });
    function done() { mo.disconnect(); resolve(); }
    mo.observe(document.querySelector('#view'), { childList: true, subtree: true });
  }));
  await settle();
  const deck = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.ph-card')];
    const cols = cards.filter(c => c.offsetTop === cards[0].offsetTop).length;
    return { cols, pitch: cards[cols].offsetTop - cards[0].offsetTop, height: cards[0].offsetHeight };
  });
  assert.ok(deck.cols >= 2, 'the deck lays photos out in several columns');
  assert.equal(deck.pitch, 64 + 12, 'each row shows a fixed strip of the card above it');
  assert.ok(deck.height > deck.pitch * 2, 'a card is taller than its strip, so later rows overlap it');

  const strip = n => page.evaluate(id => {
    const r = document.querySelector(`.ph-card[data-id="${id}"]`).getBoundingClientRect();
    return { x: r.left + 30, y: r.top + 20 };
  }, 'ph-syn-' + n);
  const lifted = () => page.evaluate(() => [...document.querySelectorAll('.ph-card.lift')].map(c => c.dataset.id));
  const third = deck.cols * 2, fourth = deck.cols * 3;
  let p = await strip(third);
  await page.mouse.move(p.x, p.y);
  await page.waitForFunction(id => document.querySelector('.ph-card.lift')?.dataset.id === id, 'ph-syn-' + third);
  await page.waitForTimeout(400);
  assert.deepEqual(await lifted(), ['ph-syn-' + third], 'only the card whose strip is pointed at lifts');
  assert.equal(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y).closest('.ph-card').dataset.id, p),
    'ph-syn-' + third, 'the lifted card is on top of the cards that covered it');
  assert.equal(await page.locator('.ph-card.lift').evaluate(c => getComputedStyle(c).zIndex), '10');
  // Its lower half now covers the next row's strip; pointing there lifts that card instead.
  p = await strip(fourth);
  await page.mouse.move(p.x, p.y + 1);
  await page.waitForFunction(id => document.querySelector('.ph-card.lift')?.dataset.id === id, 'ph-syn-' + fourth);
  assert.deepEqual(await lifted(), ['ph-syn-' + fourth]);
  await page.locator('.ph-card.lift').click();
  assert.equal(await page.locator('.ph-card.active').getAttribute('data-id'), 'ph-syn-' + fourth, 'a click selects the lifted card');
  await page.mouse.move(5, 5);
  await page.waitForFunction(() => !document.querySelector('.ph-card.lift'));

  // ---------- photos pane resize ----------
  const pane = page.locator('.ph-detail');
  const handle = page.locator('.ph-layout > .side-handle');
  const width = async () => Math.round((await pane.boundingBox()).width);
  // Layout settles a frame after a drag; poll briefly before comparing.
  const widthIs = async (want, message) => {
    for (let i = 0; i < 40 && await width() !== want; i++) await page.waitForTimeout(50);
    assert.equal(await width(), want, message);
  };
  await widthIs(320, 'the pane opens at its default width');
  const drag = async dx => {
    const b = await handle.boundingBox();
    dx = Math.max(5, Math.min(1435, b.x + b.width / 2 + dx)) - (b.x + b.width / 2);
    await page.mouse.move(b.x + b.width / 2, b.y + 200);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2 + dx / 2, b.y + 200);
    await page.mouse.move(b.x + b.width / 2 + dx, b.y + 200);
    await page.mouse.up();
  };
  await drag(-120);
  await widthIs(440, 'dragging the border left widens the pane');
  const hb = await handle.boundingBox(), pb = await pane.boundingBox();
  assert.ok(Math.abs(hb.x + hb.width / 2 - pb.x) <= 1, 'the handle follows the border');
  assert.equal(await page.evaluate(() => localStorage.getItem('tiksi.sidePane.photos')), '440');
  await page.reload(); await page.locator('.ph-card').first().waitFor(); await settle();
  await widthIs(440, 'the width is remembered');
  await drag(-3000);
  const main = await page.locator('.ph-main').boundingBox();
  assert.equal(Math.round(main.width), 320, 'the photo grid keeps its minimum width');
  await drag(3000);
  await widthIs(220, 'the pane keeps its minimum width');
  await handle.dblclick();
  await widthIs(320, 'double-click resets the default');
  assert.equal(await page.evaluate(() => localStorage.getItem('tiksi.sidePane.photos')), null);
  await handle.focus(); await page.keyboard.press('ArrowLeft');
  await widthIs(336, 'the arrow keys resize too');

  // ---------- the other views ----------
  for (const [view, selector, open] of [
    ['plan', '.editor-layout > [data-side-pane="plan"]'],
    ['model', '.editor-layout > [data-side-pane="model"]'],
    ['measure', '.ms-layout > [data-side-pane="measure"]'],
    ['materials', '.mv-body > [data-side-pane="materials"]', '.mv-card'],
    ['products', '.prod-layout > [data-side-pane="products"]', '[data-edit]'],
  ]) {
    await page.goto(url + '/#/' + view);
    await settle();
    // A new product is saved and the disk sync then rebuilds the view (closing its editor), so
    // create one first and open it from its card.
    if (view === 'products') { await page.locator('#new-prod').click(); await settle(); }
    if (open) await page.locator(open).first().click();
    const sidePane = page.locator(selector);
    await sidePane.waitFor();
    const h = page.locator(selector + ' ~ .side-handle');
    await h.waitFor();
    const before = (await sidePane.boundingBox()).width;
    const b = await h.boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + 150);
    await page.mouse.down(); await page.mouse.move(b.x + b.width / 2 - 60, b.y + 150); await page.mouse.up();
    for (let i = 0; i < 40 && Math.round((await sidePane.boundingBox()).width - before) !== 60; i++) await page.waitForTimeout(50);
    assert.equal(Math.round((await sidePane.boundingBox()).width - before), 60, view + ' pane resizes from its border');
    if (view === 'model') {
      await page.waitForFunction(() => {
        const wrap = document.querySelector('.canvas-wrap');
        return Math.abs(wrap.querySelector('canvas').getBoundingClientRect().width - wrap.clientWidth) < 1;
      });
    }
  }
  // Stacked under the content on a narrow window, the pane has nothing to drag against.
  await page.setViewportSize({ width: 700, height: 900 });
  await page.goto(url + '/#/measure'); await page.locator('[data-side-pane="measure"]').waitFor();
  assert.equal(await page.locator('.ms-layout > .side-handle').isHidden(), true, 'no handle on a stacked pane');

  assert.deepEqual(errors, []);
  console.log('Side panes passed: photo deck strips, lift on pointer, click selects the lifted card; resize, remember, clamp, reset and keys on photos; plan, model (canvas follows), measure, materials and products panes resize; stacked pane has no handle.');
} finally {
  if (browser) await browser.close();
  child.kill();
  await rm(state, { recursive: true, force: true });
}
