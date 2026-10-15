// Reproducible public-safe documentation media. No owner project or live store.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import { seedGuide } from './guide-fixture.mjs';

const options = process.argv.slice(2);
let url = 'http://localhost:8643/', output = 'js/guide-assets', stillsOnly = false, demosOnly = false;
for (let i = 0; i < options.length; i++) {
  if (options[i] === '--url' && options[i + 1]) url = options[++i];
  else if (options[i] === '--output' && options[i + 1]) output = options[++i];
  else if (options[i] === '--stills-only') stillsOnly = true;
  else if (options[i] === '--demos-only') demosOnly = true;
  else throw new Error('Unknown or incomplete capture option: ' + options[i]);
}
const origin = new URL(url);
assert(!(stillsOnly && demosOnly), 'Choose stills or demos, or omit both flags to capture everything.');
assert(['localhost', '127.0.0.1'].includes(origin.hostname) && origin.port && origin.port !== '8642', 'Use an isolated local preview, never the live app.');
const target = resolve(output), temporary = await mkdtemp(join(tmpdir(), 'tiksi-guide-media-'));
await mkdir(target, { recursive: true });
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
const page = await context.newPage(), errors = [];
page.on('pageerror', error => errors.push(error.message));
page.setDefaultTimeout(30000);

async function settle(ms = 550) {
  await page.waitForTimeout(ms);
  await page.addStyleTag({ content: '[aria-label="Branch preview"]{display:none!important}' });
}
async function go(route) {
  await page.goto(new URL('#/' + route, origin).href);
  await settle(route === 'model' ? 1500 : 500);
}
async function shot(name) {
  await page.screenshot({ path: join(target, name + '.png'), animations: 'disabled' });
  console.log('Screenshot:', name);
}
async function fileTab(tab) {
  if (!await page.locator('[data-file-dialog]').count()) await page.locator('#btn-file').click();
  await page.locator(`[data-file-tab="${tab}"]`).click();
  if (tab === 'exchange') await page.locator('[data-engines]').filter({ hasText: 'Local engines' }).waitFor();
  await settle(250);
}
async function closeFile() { await page.locator('[data-close-file]').click(); }
async function selectWall() {
  await page.locator('[data-act="fit"]').click();
  await settle(100);
  const box = await page.locator('.plan-canvas canvas').boundingBox();
  const w = box.width - 22, h = box.height - 22, z = Math.min(w / (8.4 * 1.22), h / (5.4 * 1.22), 250);
  const px = -(w / z - 8.4) / 2 - 22 / z, py = -(h / z - 5.4) / 2 - 22 / z;
  const point = { x: box.x + (4.8 - px) * z, y: box.y + (1.8 - py) * z };
  await page.mouse.click(point.x, point.y);
  await page.locator('.inspector [data-len="h"]').waitFor();
  return point;
}

async function overlay(caption, point) {
  await page.evaluate(({ caption, point }) => {
    // Native dialogs paint in the top layer; put annotations there too so their
    // backdrop cannot dim the instructions or actual click marker.
    const layer = document.querySelector('dialog[open]') || document.body;
    let host = document.querySelector('[data-recording-caption]');
    if (!host) { host = document.createElement('div'); host.dataset.recordingCaption = ''; }
    layer.append(host);
    host.style.cssText = 'position:fixed;left:50%;bottom:20px;transform:translateX(-50%);z-index:2147483647;pointer-events:none;background:#111b24;color:#fff;border:1px solid #82919d;border-radius:6px;padding:12px 20px;font:600 18px system-ui;max-width:calc(100% - 48px);text-align:center;box-shadow:0 2px 12px #0008';
    host.textContent = caption;
    let cursor = document.querySelector('[data-recording-cursor]');
    if (!cursor) { cursor = document.createElement('div'); cursor.dataset.recordingCursor = ''; }
    layer.append(cursor);
    cursor.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;width:26px;height:26px;border:3px solid #fff;background:#e8973a88;border-radius:50%;box-shadow:0 0 0 4px #1118;transform:translate(-50%,-50%)';
    cursor.hidden = !point;
    if (point) { cursor.style.left = point.x + 'px'; cursor.style.top = point.y + 'px'; }
  }, { caption, point });
}
async function pointFor(selector) { const box = await page.locator(selector).first().boundingBox(); return box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null; }
async function cleanOverlay() { await page.evaluate(() => document.querySelectorAll('[data-recording-caption],[data-recording-cursor]').forEach(node => node.remove())); }
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
}
async function clip(name, actions) {
  const directory = join(temporary, name); await mkdir(directory);
  const frames = [];
  async function frame(caption, selector, action) {
    const point = typeof selector === 'string' ? await pointFor(selector) : selector;
    if (action) await action();
    await settle(600);
    await overlay(caption, point);
    const filename = 'frame-' + frames.length + '.png';
    await page.screenshot({ path: join(directory, filename), animations: 'disabled' });
    frames.push(filename);
  }
  await actions(frame);
  const concat = frames.map(filename => `file '${filename}'\nduration 1.6`).join('\n') + `\nfile '${frames.at(-1)}'\n`;
  const list = join(directory, 'frames.txt'); await writeFile(list, concat);
  const mp4 = join(target, name + '.mp4');
  run('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-vf', 'fps=12,scale=1280:-2', '-c:v', 'libx264', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4]);
  run('ffmpeg', ['-y', '-loglevel', 'error', '-i', mp4, '-filter_complex', '[0:v]fps=5,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3', '-loop', '0', join(target, name + '.gif')]);
  await cleanOverlay();
  console.log('Demo:', name, frames.length, 'actual UI states');
}

try {
  await page.goto(origin.href); await page.locator('[data-prop-name]').waitFor();
  const ids = await seedGuide(page);
  await settle();
  if (!demosOnly) {
  await selectWall(); await shot('plan');
  await go('model'); await page.locator('[data-act="iso"]').click(); await settle(1500);
  await shot('start'); await shot('model');
  await fileTab('exchange'); await shot('exchange');
  await fileTab('project'); await shot('files');
  await fileTab('capture'); await shot('capture');
  await fileTab('settings'); await shot('settings'); await closeFile();
  await go('materials');
  await page.locator('.mv-search').fill('sage');
  await page.locator('.mv-card[data-id="mat-guide-sage"]').click(); await settle(1600); await shot('materials');
  await go('photos'); await page.locator(`.ph-card[data-id="${ids.photoIds[0]}"]`).click(); await settle(); await shot('photos');
  await go('reconstruct'); await page.locator('.rc-start').waitFor(); await settle(600); await shot('reconstruct');
  await go('research');
  await page.locator('#research-query').fill('Matte sage interior paint for the sample kitchen. Demonstration brief; no research run.');
  await page.locator('#research-budget').fill('Compare price per square foot of coverage');
  await page.locator('#research-finish').fill('Soft sage, washable matte finish');
  await page.locator('#research-dimensions').fill('920 sf of wall finish; confirm real coverage');
  await settle(); await shot('sourcing');
  await go('projects'); await page.locator('.proj-card[data-id="guide-project-kitchen"]').click(); await settle(); await shot('projects');
  await go('products'); await page.locator('[data-edit="guide-product-paint"]').click(); await settle(); await shot('products');
  await go('budget'); await shot('budget');
  await go('schedule'); await shot('schedule');
  await go('sheets'); await page.locator('.sl-item[data-kind="item"][data-id="guide-item-paint"]').click(); await settle(); await shot('sheets');
  }

  if (!stillsOnly) {
    await go('plan');
    await clip('files', async frame => {
      await frame('1. Open FILE for saving, importing and settings', '#btn-file');
      await frame('2. Project: save or open a .tiksi project', '#btn-file', () => fileTab('project'));
      await frame('3. Import: scans, photos and Polycam', '[data-file-tab="capture"]', () => fileTab('capture'));
      await frame('4. 3D exchange: edit in SketchUp or Blender', '[data-file-tab="exchange"]', () => fileTab('exchange'));
      await frame('5. Settings: display, folders and backups', '[data-file-tab="settings"]', () => fileTab('settings'));
    });
    await closeFile();
    await go('plan');
    await clip('plan', async frame => {
      await frame('1. Select a wall in PLAN', await selectWall());
      await frame('2. Set a precise wall height in the inspector', '.inspector [data-len="h"]');
      await frame('3. Change the height to 8 feet', '.inspector [data-len="h"]', async () => { await page.locator('.inspector [data-len="h"]').fill('8ft'); await page.locator('.inspector [data-len="h"]').press('Tab'); });
      await frame('4. Open MODEL to inspect the edit', '#rail [data-view="model"]', async () => { await go('model'); await settle(1200); });
    });
    // Restore the fixture's height through the actual inspector before comparison.
    await go('plan'); await selectWall(); await page.locator('.inspector [data-len="h"]').fill('2.7m'); await page.locator('.inspector [data-len="h"]').press('Tab');
    await go('model'); await page.locator('[data-act="iso"]').click(); await settle(1200);
    await clip('exchange', async frame => {
      await frame('1. BEFORE: the preserved existing conditions', '[data-act="before"]', () => page.locator('[data-act="before"]').click());
      await frame('2. AFTER: sage walls, new floors, wider opening', '[data-act="after"]', () => page.locator('[data-act="after"]').click());
      await frame('3. Compare again from the same camera', '[data-act="before"]', () => page.locator('[data-act="before"]').click());
      await frame('4. Return to the proposed design', '[data-act="after"]', () => page.locator('[data-act="after"]').click());
    });
    await go('photos');
    await clip('photos', async frame => {
      await frame('1. Select an unpinned reference image', `.ph-card[data-id="${ids.photoIds[3]}"]`, () => page.locator(`.ph-card[data-id="${ids.photoIds[3]}"]`).click());
      await frame('2. PIN IN 3D opens surface placement', '[data-act="pin"]', () => page.locator('[data-act="pin"]').click());
      await settle(1500);
      // Find a rendered surface through actual pointer placement; success is verified
      // from the stored pin, not inferred from a click on an arbitrary blank pixel.
      const canvas = page.locator('.v-wrap canvas').first();
      const box = await canvas.boundingBox();
      let pinned = false, point;
      for (const [fx, fy] of [[.5,.6],[.55,.58],[.42,.55],[.6,.68],[.5,.5]]) {
        point = { x: box.x + box.width * fx, y: box.y + box.height * fy };
        await page.mouse.click(point.x, point.y); await settle(180);
        pinned = await page.evaluate(async id => { const store = await import('/js/store.js'); return Boolean(store.activeProperty().photos.find(photo => photo.id === id)?.pin); }, ids.photoIds[3]);
        if (pinned) break;
      }
      assert(pinned, 'The photo demo must really place a pin');
      await frame('3. Click a model surface to keep the photo there', point);
      await page.keyboard.press('Escape');
      await frame('4. LOCATE returns to this saved photo pin', `[data-locate="${ids.photoIds[3]}"]`, async () => { await page.locator(`[data-locate="${ids.photoIds[3]}"]`).click(); await settle(1300); });
    });
  }
  assert.deepEqual(errors, [], 'No uncaught errors during guide captures');
  console.log('Guide media complete. Synthetic project only.');
} finally {
  await browser.close();
  await rm(temporary, { recursive: true, force: true });
}
