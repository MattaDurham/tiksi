// Deterministic UI contract test; the server returns synthetic source evidence.
// No provider credentials or real project data are used.
// Run: node tools/e2e-research.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
let chromium;
try { ({ chromium } = await import('playwright')); }
catch { ({ chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright/index.mjs')); }
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' };
const html = `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/console.css"><link rel="stylesheet" href="/css/research.css"></head><body><main id="test-root" style="height:100vh"></main><script type="module">
import {ws,emptyWorkspace} from '/js/store.js';
import * as research from '/js/research.js'; import * as products from '/js/products.js';
ws.data=emptyWorkspace(); ws.data.materials=[{id:'material-fixture',name:'Synthetic ceramic tile'}];
ws.data.projects=[{id:'project-fixture',name:'Synthetic kitchen',propertyId:'property-fixture',items:[{id:'item-fixture',name:'Tile flooring',unit:'sf',elementIds:['room-fixture']},{id:'item-other',name:'Other item',unit:'ea',elementIds:[]}]}];
window.research=research; window.workspace=ws;
const root=document.querySelector('#test-root');
window.addEventListener('hashchange',()=>{research.unmount();products.unmount();location.hash==='#/products'?products.mount(root):research.mount(root);});
research.mount(root);
</script></body></html>`;
const fixture = {
  id: 'job-fixture', status: 'running', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:01:00Z',
  agents: [{ id: 'source', role: 'Supplier research', status: 'running', webSearches: 2 }], products: [], unknowns: [], conflicts: [],
};
const result = {
  id: 'candidate-fixture', name: 'Synthetic tile <img src=x onerror=alert(1)>', brand: 'Example manufacturer', model: 'SYN-1',
  category: 'tile', url: 'https://example.com/tile', price: 8, unit: 'sf', currency: 'USD', priceStatus: 'verified', availability: 'Synthetic availability',
  specifications: [{ name: 'Thickness', value: '8 mm', sourceUrl: 'https://example.com/specification' }],
  sourceEvidence: [{ url: 'https://example.com/specification', title: 'Synthetic manufacturer sheet', relevance: 'Fixture evidence for thickness', checkedAt: '2026-01-01T00:00:00Z', sourceStatus: 'opened' }],
  fitNotes: ['Synthetic fit note'], unknowns: ['Delivery date needs confirmation'], offers: [], sustainability: [], reviews: [],
};
let posted, calls = 0, cancelCalls = 0, available = true, finish = false;
const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
  if (path === '/api/material-research/capabilities') return json(200, { available, reason: available ? '' : 'Local research unavailable', token: 'synthetic-test-token' });
  if (path === '/api/material-research' && req.method === 'POST') {
    assert.equal(req.headers['x-tiksi-token'], 'synthetic-test-token');
    let body = ''; for await (const data of req) body += data;
    posted = JSON.parse(body); fixture.request = posted; finish = false; calls = 0; fixture.status = 'running'; fixture.products = [];
    return json(202, { job: fixture });
  }
  if (path.endsWith('/cancel')) {
    assert.equal(req.headers['x-tiksi-token'], 'synthetic-test-token'); cancelCalls++; fixture.status = 'cancelled'; return json(200, { job: fixture });
  }
  if (path === '/api/material-research/job-fixture') {
    assert.equal(req.headers['x-tiksi-token'], 'synthetic-test-token');
    calls++;
    if (finish) { fixture.status = 'completed'; fixture.agents[0].status = 'completed'; fixture.products = [result, { ...result, id: 'candidate-2', name: 'Synthetic alternative', price: 7, currency: 'EUR', url: 'javascript:alert(1)', sourceEvidence: [{ url: 'javascript:alert(1)', title: '<script>Unsafe source</script>', sourceStatus: 'search-result' }] }]; }
    return json(200, { job: fixture });
  }
  if (path === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(html); }
  if (path === '/app') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(readFileSync(resolve(repo, 'index.html'))); }
  const file = resolve(repo, '.' + path);
  if (!file.startsWith(repo + sep) || !existsSync(file)) { res.writeHead(404); return res.end('missing'); }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' }); res.end(readFileSync(file));
});
await new Promise(r => server.listen(0, 'localhost', r));
const browser = await chromium.launch({ headless: true });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  page.on('pageerror', error => errors.push(error.message));
  const address = `http://localhost:${server.address().port}/`;
  await page.goto(address);
  await page.waitForFunction(() => window.research);
  await page.evaluate(() => research.openResearch({ kind: 'material', id: 'material-fixture', materialId: 'material-fixture', name: 'Synthetic ceramic tile', elementId: 'room-fixture', propertyId: 'property-fixture', finish: 'Ivory' }));
  await page.waitForSelector('#research-query');
  assert.equal(await page.inputValue('#research-query'), 'Synthetic ceramic tile');
  assert.deepEqual(await page.locator('#research-scope').evaluate(el => [...el.selectedOptions].map(o => o.value)), ['item-fixture']);
  await page.waitForFunction(() => !document.querySelector('[data-start]').disabled);
  await page.evaluate(() => research.openResearch({ kind: 'material', id: 'material-fixture', materialId: 'material-fixture', name: 'Synthetic ceramic tile', elementId: 'room-fixture', propertyId: 'property-fixture', specifications: 'S'.repeat(1100) }));
  assert.equal((await page.inputValue('#research-specifications')).length, 1100);
  await page.click('[data-start]');
  assert.match(await page.locator('[role=alert]').innerText(), /longer than 1,000 characters/);
  assert.equal(posted, undefined, 'oversized prefilled constraints never dispatch a truncated request');
  await page.fill('#research-specifications', 'Synthetic specifications');
  await page.fill('#research-budget', 'up to $10 per sq ft');
  await page.fill('#research-region', 'Synthetic test region');
  await page.fill('#research-dimensions', '12 x 24 inches');
  await page.click('[data-start]');
  await page.waitForSelector('[data-cancel]');
  assert.equal(posted.mode, 'team'); assert.equal(posted.constraints.budget, 'up to $10 per sq ft');
  assert.equal(posted.context.name, 'Synthetic ceramic tile'); assert.equal(posted.context.materialId, undefined);
  // Polling never wipes a new draft. Browsing away also leaves the job active.
  await page.fill('#research-region', 'Edited while researching');
  await page.evaluate(() => { location.hash = '#/products'; });
  await page.waitForSelector('#research-prod'); assert.equal(cancelCalls, 0);
  finish = true;
  await page.evaluate(() => { location.hash = '#/research'; });
  await page.waitForSelector('[data-save-candidate="0"]');
  assert.equal(await page.inputValue('#research-region'), 'Edited while researching');
  assert.equal(await page.locator('.research-candidate img').count(), 0);
  assert.equal(await page.locator('a[href^="javascript:"]').count(), 0);
  await page.locator('.research-candidate').nth(0).locator('details summary').click();
  await page.locator('.research-candidate').nth(1).locator('details summary').click();
  assert.match(await page.locator('.research-candidate').nth(0).innerText(), /Opened source/i);
  assert.match(await page.locator('.research-candidate').nth(1).innerText(), /Search result only/i);
  await page.check('[data-pick="0"]'); await page.check('[data-pick="1"]'); await page.click('[data-compare]');
  assert.match(await page.locator('[data-comparison]').innerText(), /Thickness/);
  await page.click('[data-save-candidate="0"]');
  const saved = await page.evaluate(() => workspace.data.products[0]);
  assert.equal(saved.price, 8); assert.equal(saved.unit, 'sf'); assert.deepEqual(saved.itemIds, ['item-fixture']);
  assert.deepEqual(saved.materialIds, ['material-fixture']); assert.equal(saved.research.candidate.sourceEvidence[0].title, 'Synthetic manufacturer sheet');
  assert.equal(saved.research.request.constraints.region, 'Synthetic test region');
  assert.ok(!saved.notes.includes('Confirm coverage'), 'compatible price and scope units have no mismatch warning');
  await page.selectOption('#research-scope', ['item-other']);
  await page.click('[data-save-candidate="1"]');
  const unverified = await page.evaluate(() => workspace.data.products[0]);
  assert.equal(unverified.price, 0); assert.equal(unverified.url, ''); assert.equal(unverified.research.candidate.currency, 'EUR');
  assert.match(unverified.notes, /Not entered into the USD estimate/);
  assert.match(unverified.notes, /Confirm coverage and conversion/);
  await page.evaluate(() => { location.hash = '#/products'; });
  await page.waitForSelector('[data-edit]'); await page.locator('[data-edit]').last().click();
  await page.locator('.prod-provenance summary').click();
  assert.match(await page.locator('.prod-provenance').innerText(), /Synthetic manufacturer sheet/);
  assert.match(await page.locator('.prod-provenance').innerText(), /Opened source/i);
  await page.click('#prod-research'); await page.waitForSelector('#research-query');
  assert.match(await page.inputValue('#research-query'), /Example manufacturer/);
  // A fresh job can be cancelled, including the token required by the server.
  await page.click('[data-start]'); await page.waitForSelector('[data-cancel]');
  await page.click('[data-cancel]'); await page.waitForFunction(() => document.querySelector('[data-results]').textContent.includes('CANCELLED'));
  assert.equal(cancelCalls, 1);
  await page.setViewportSize({ width: 402, height: 874 });
  await page.evaluate(() => research.openResearch({ name: 'Mobile fixture', kind: 'fixture' }));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 402), 'mobile does not overflow the viewport');
  assert.ok(await page.locator('#research-query').evaluate(el => parseFloat(getComputedStyle(el).fontSize)) >= 16);
  const out = resolve(repo, 'tools/fixtures'); mkdirSync(out, { recursive: true });
  await page.screenshot({ path: resolve(out, 'research-mobile.png') });
  // Static/unconfigured hosting reports the actual availability and disables start.
  available = false; await page.reload(); await page.waitForFunction(() => document.querySelector('[data-availability]').textContent.includes('unavailable'));
  assert.equal(await page.locator('[data-start]').isDisabled(), true);
  // Verify the real app shell routes contextual actions into the research view.
  const app = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  app.on('pageerror', error => errors.push(error.message));
  await app.goto(address + 'app#/products');
  await app.waitForSelector('#research-prod');
  await app.click('#research-prod');
  await app.waitForSelector('#research-query');
  assert.equal(new URL(app.url()).hash, '#/research');
  await app.click('#rail [data-view="materials"]');
  await app.locator('.mv-card').first().click();
  const materialName = await app.inputValue('[data-f="name"]');
  await app.click('[data-research]');
  await app.waitForSelector('#research-query');
  assert.equal(await app.inputValue('#research-query'), materialName);
  await app.click('#rail [data-view="products"]');
  await app.click('#new-prod');
  await app.locator('#prod-form [data-f="name"]').fill('Synthetic fixture for routing');
  await app.locator('#prod-form [data-f="name"]').blur();
  await app.click('#prod-research');
  await app.waitForSelector('#research-query');
  assert.equal(await app.inputValue('#research-query'), 'Synthetic fixture for routing');
  assert.deepEqual(errors, []);
  console.log('research UI contract passed: context, live jobs, browse/resume, evidence, comparison, scope/material links, pricing, cancellation, safety and 402px layout');
} finally { await browser.close(); await new Promise(r => server.close(r)); }
