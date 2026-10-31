// Exercise the published guide without modifying any project or calling live jobs.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { chromium } from 'playwright';

const state = await mkdtemp(tmpdir() + '/tiksi-guide-test-');
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
    const property = store.propertyTemplate('Synthetic guide project');
    store.ws.data.properties.push(property); store.ws.data.settings.activePropertyId = property.id; store.touch();
    await (await import('/js/disk-workspace.js')).diskWorkspace.sync();
  });
  const before = await page.evaluate(async () => JSON.stringify((await import('/js/store.js')).ws.data));
  await page.locator('.guide-entry').click();
  await page.getByRole('heading', { name: 'Your first renovation workflow', exact: true }).waitFor();
  await page.locator('#guide-search').fill('photo pins');
  await page.locator('.guide-result[data-topic="photos"]').click();
  await page.getByRole('heading', { name: 'Keep photos attached to the room', exact: true }).waitFor();
  assert.match(page.url(), /topic=photos/);
  const image = page.locator('.guide-image img');
  await image.evaluate(node => node.decode());
  await page.locator('.guide-image').click();
  await page.getByRole('dialog', { name: 'Keep photos attached to the room screenshot' }).waitFor();
  await page.keyboard.press('Escape');
  await page.locator('dialog.guide-lightbox').waitFor({ state: 'detached' });
  assert.equal(await page.locator('dialog.guide-lightbox').count(), 0);
  assert.equal(await page.locator('.guide-image').evaluate(node => node === document.activeElement), true);

  const mediaTime = await page.locator('video').evaluate(async video => {
    await video.play();
    await new Promise(resolve => setTimeout(resolve, 550));
    video.pause();
    return video.currentTime;
  });
  assert(mediaTime > 0, 'The demonstration really plays');

  await page.locator('#guide-search').fill('no such feature qzxq');
  await page.locator('.guide-no-results').waitFor();
  assert.match(await page.locator('.guide-search-count').textContent(), /0 matching/);
  await page.locator('#guide-search').fill('');
  await page.locator('.guide-contents [data-topic="files"]').click();
  assert.equal(await page.locator('video').evaluate(video => video.paused), true, 'Demos never autoplay');
  const response = await page.request.get(url + '/js/guide-assets/tiksi-user-guide.pdf');
  assert.equal(response.status(), 200);
  assert.equal((await response.body()).subarray(0, 5).toString(), '%PDF-');
  const assets = await page.evaluate(async () => {
    const { chapters } = await import('/js/guide-content.js');
    return chapters.flatMap(chapter => [chapter.image, chapter.clip, chapter.gif].filter(Boolean));
  });
  for (const asset of assets) {
    const result = await page.request.get(url + '/js/guide-assets/' + asset);
    assert.equal(result.status(), 200, 'Published asset: ' + asset);
    assert((await result.body()).length > 1000, 'Nonempty asset: ' + asset);
  }
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/guide-desktop.png' });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('#guide-chapter-select').selectOption('exchange');
  await page.getByRole('heading', { name: 'Edit elsewhere and compare before/after', exact: true }).waitFor();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No mobile page overflow');
  assert(await page.locator('.guide-shell').evaluate(node => node.scrollWidth <= node.clientWidth), 'No mobile guide overflow');
  assert.equal(await page.locator('video').evaluate(video => video.paused), true, 'Reduced motion stays still');
  await page.locator('.guide-shell').evaluate(node => { node.scrollTop = 0; });
  await page.screenshot({ path: 'test-results/guide-mobile.png' });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(url + '/#/guide?topic=photos');
  await page.getByRole('heading', { name: 'Keep photos attached to the room', exact: true }).waitFor();
  await page.getByRole('link', { name: /OPEN PHOTOS/ }).click();
  await page.locator('.ph-head').waitFor();
  const after = await page.evaluate(async () => JSON.stringify((await import('/js/store.js')).ws.data));
  assert.equal(after, before, 'Reading, searching and leaving the guide preserve the workspace');
  assert.deepEqual(errors, []);
  console.log('Guide passed: discovery, search, deep links, screenshot zoom/focus, playable demo, PDF/media assets, mobile/reduced motion and unchanged project data.');
} finally {
  await browser?.close();
  child.kill('SIGTERM');
  await new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve));
  await rm(state, { recursive: true, force: true });
}
