#!/usr/bin/env node
// Offline browser regression: original camera bytes/resolution and Photo to 3D UI.
// Uses synthetic canvases and an isolated mock API. No real machine/project data.
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let chromium;
try { ({ chromium } = await import('playwright')); }
catch (_) { ({ chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright/index.mjs')); }
const harness = `<!DOCTYPE html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/css/style.css"><link rel="stylesheet" href="/css/photos.css"><link rel="stylesheet" href="/css/reconstruction.css"><script type="importmap">{"imports":{"three":"/vendor/three.module.min.js","three/addons/":"/vendor/addons/"}}</script></head><body><div id="view"></div><script type="module">
import * as store from '/js/store.js'; import * as photoStore from '/js/photos-store.js'; import * as photos from '/js/photos.js'; import * as reconstruction from '/js/reconstruction.js';
store.load(); const property=store.propertyTemplate('Synthetic test property'); store.ws.data.properties.push(property);store.ws.data.settings.activePropertyId=property.id;
window.test={store,photoStore,photos,reconstruction,property};window.ready=true;
</script></body></html>`;
let job = null;
const uploads = [];
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const send = data => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(data)); };
  if (url.pathname === '/harness') { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(harness); return; }
  if (url.pathname === '/api/reconstruction/capabilities') { send({ available: true, token: 'test-token', maxImages: 300, minImages: 20, maxImageBytes: 60*1048576 }); return; }
  if (url.pathname === '/api/reconstruction/jobs' && request.method === 'GET') { send({ jobs: job ? [job] : [] }); return; }
  if (url.pathname === '/api/reconstruction/jobs' && request.method === 'POST') {
    let text = ''; for await (const chunk of request) text += chunk;
    job = { ...JSON.parse(text), id: '0123456789abcdef0123456789abcdef', images: 0, bytes: 0, state: 'draft', createdAt: 1, warnings: [], error: '' }; send(job); return;
  }
  if (url.pathname.endsWith('/images') && request.method === 'PUT') {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const bytes = Buffer.concat(chunks); uploads.push(bytes); job.images++; job.bytes += bytes.length; send(job); return;
  }
  if (url.pathname.endsWith('/start') && request.method === 'POST') { job.state = 'running'; job.progress = .2; send(job); return; }
  if (url.pathname.endsWith('/cancel') && request.method === 'POST') { job.state = 'cancelled'; send(job); return; }
  if (url.pathname.startsWith('/api/')) { response.writeHead(404); response.end(); return; }
  const file = resolve(project, '.' + decodeURIComponent(url.pathname));
  if (!file.startsWith(project + '/') || !['.js','.css'].includes(extname(file))) { response.writeHead(404); response.end(); return; }
  try { const bytes = await readFile(file); response.writeHead(200, { 'Content-Type': extname(file) === '.js' ? 'text/javascript' : 'text/css' }); response.end(bytes); }
  catch (_) { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, 'localhost', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://localhost:' + server.address().port + '/harness');
  await page.waitForFunction(() => window.ready);
  const result = await page.evaluate(async () => {
    const { photoStore, property, photos } = window.test;
    const canvas = document.createElement('canvas'); canvas.width=4096;canvas.height=3072;
    const ctx=canvas.getContext('2d');ctx.fillStyle='#d89040';ctx.fillRect(0,0,2048,3072);
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
    const file=new File([blob],'original-camera.png',{type:'image/png'});
    window.original=file;
    const record=await photoStore.addPhotoFromFile(property,file);
    const saved=new Uint8Array(await photoStore.photoBytes(record.id)); const original=new Uint8Array(await file.arrayBuffer());
    const url=await photoStore.photoUrl(record.id), img=new Image();img.src=url;await img.decode();
    const alpha=document.createElement('canvas');alpha.width=1;alpha.height=1;alpha.getContext('2d').drawImage(img,-4000,-1500);
    photos.mount(document.querySelector('#view'));
    return { width:record.w,height:record.h,original:record.original,bytes:saved.length,exact:saved.length===original.length&&saved.every((v,i)=>v===original[i]),alpha:alpha.getContext('2d').getImageData(0,0,1,1).data[3],cards:document.querySelectorAll('.ph-card').length };
  });
  assert.equal(result.width,4096);assert.equal(result.height,3072);assert.equal(result.original,true);assert.equal(result.exact,true);assert.equal(result.alpha,0);assert.equal(result.cards,1);
  await page.getByRole('button',{name:'PHOTO TO 3D',exact:true}).click();assert.match(page.url(),/#\/reconstruct$/);
  await page.evaluate(()=>{window.test.photos.unmount();window.test.reconstruction.mount(document.querySelector('#view'));});
  await page.waitForFunction(()=>document.querySelector('.rc-engine').textContent.includes('ready'));
  await page.evaluate(()=>{
    const input=document.querySelector('.rc-upload'), dt=new DataTransfer();
    for(let i=0;i<20;i++)dt.items.add(new File([window.original],'frame-'+i+'.png',{type:'image/png',lastModified:i}));
    input.files=dt.files;input.dispatchEvent(new Event('change'));
  });
  await page.getByRole('button',{name:'RECONSTRUCT 3D MODEL'}).click();
  await page.waitForFunction(()=>document.querySelector('.rc-job').textContent.includes('RUNNING'));
  assert.equal(uploads.length,20);assert.ok(uploads.every(b=>b.equals(uploads[0])));
  await page.getByRole('button',{name:'Cancel reconstruction'}).click();
  await page.waitForFunction(()=>document.querySelector('.rc-job').textContent.includes('CANCELLED'));
  await page.setViewportSize({width:402,height:874});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ ...result, uploads:uploads.length,mobileWidth:402,errors },null,2));
} finally { if(browser)await browser.close();await new Promise(resolve=>server.close(resolve)); }
