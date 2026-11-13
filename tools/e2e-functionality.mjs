// Isolated end-to-end audit. Uses an ephemeral HTTP origin and browser profile; no live state.
// Covers: the eight desktop and phone routes (MODEL, MATERIALS, PHOTOS, PROJECTS, PRODUCTS,
// BUDGET, SCHEDULE, SHEETS) mount without errors and do not widen the phone screen; projects,
// item and product prices, budget report, schedule, cut sheets; stored plan images kept per
// property and replaced across reloads; the portable project file round trip with scans,
// photos and sourced materials; JSON open; a failed or edited-during save; folder backup and
// conflict; a full IndexedDB keeping a browser copy of a plan image.
// Run: node tools/e2e-functionality.mjs (Playwright + Chromium installed).
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { readFile } from 'node:fs/promises';
import { dirname, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = createServer(async (req, res) => {
  const path = resolve(root, '.' + decodeURIComponent(req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0]));
  if (!path.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  try { const bytes = await readFile(path); res.setHeader('Content-Type', ({ '.js':'text/javascript', '.mjs':'text/javascript', '.html':'text/html', '.css':'text/css', '.wasm':'application/wasm' })[extname(path)] || 'application/octet-stream'); res.end(bytes); }
  catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, 'localhost', r));
const url = `http://localhost:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const viewMarkers = {
  model: 'canvas.v-canvas', materials: '.mv-grid',
  photos: '.ph-grid', projects: '#new-project', products: '#new-prod',
  budget: '#cap-input', schedule: '#prog-start', sheets: '#sheet-view',
};
async function waitUntil(predicate, message, timeoutMs = 30_000) {
  const deadline = performance.now() + timeoutMs;
  while (true) {
    // Await the resolved boolean: an unresolved Promise is always truthy.
    if (await predicate()) return;
    const remaining = deadline - performance.now();
    assert.ok(remaining > 0, `Timed out: ${message}`);
    await delay(Math.min(100, remaining));
  }
}
// MODEL compiles every shader variant once its first frame is up; on a software GL that blocks the
// page for a long time, and a click that lands in it is answered only when it ends (the Linux runner
// timed out there). So wait for the viewer to settle before clicking anything on the model page.
async function viewerSettled(page, ms = 240000) {
  const end = Date.now() + ms;
  while (!(await page.evaluate(async () => (await import('/js/viewer3d.js')).viewerIdle()))) {
    if (Date.now() >= end) assert.fail('MODEL did not settle in ' + ms / 1000 + ' s: ' + JSON.stringify(await unsettledReport(page)));
    await page.waitForTimeout(250);
  }
}
// What kept MODEL from settling: 40 samples over 10 seconds, how many times each part was not
// settled, and how many frames were drawn meanwhile (a part that flips back and forth looks
// settled in any one sample).
async function unsettledReport(page) {
  return page.evaluate(async () => {
    const viewer = await import('/js/viewer3d.js'), textures = await import('/js/textures.js');
    const before = viewer.frameState(), busy = {};
    for (let i = 0; i < 40; i++) {
      for (const [part, ok] of Object.entries(viewer.viewerIdleState())) if (!ok) busy[part] = (busy[part] || 0) + 1;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    const after = viewer.frameState();
    const drawn = before && after ? Object.fromEntries(Object.keys(after).filter(k => typeof after[k] === 'number').map(k => [k, after[k] - before[k]])) : null;
    return { notSettledOutOf40: busy, drawnIn10s: drawn, now: viewer.viewerIdleState(),
      texturesNotReady: textures.textureStats().filter(t => t.status !== 'ready') };
  });
}
async function navigateToView(page, view) {
  // These links change the hash and mount a view in the current document. Waiting
  // for a full navigation after the click stalled the Linux CI browser check.
  // The phone layout hides the rail; its pages are in the side panel.
  if (await page.evaluate(() => document.documentElement.classList.contains('fd-model'))) await viewerSettled(page);
  if (await page.evaluate(() => document.documentElement.classList.contains('phone'))) {
    await page.locator('.fd-menu').click();
    await page.locator(`.fd-panel a[href="#/${view}"]`).click({ noWaitAfter: true });
  } else await page.locator(`#rail a[data-view="${view}"]`).click({ noWaitAfter: true });
  await page.waitForFunction(({ view, marker }) => {
    const root = document.querySelector('#view');
    const link = document.querySelector(`#rail a[data-view="${view}"]`);
    return location.hash === '#/' + view && link?.classList.contains('active') &&
      !!root?.firstElementChild && !!root.querySelector(marker);
  }, { view, marker: viewMarkers[view] });
  // Allow layout to settle for the actual viewport measurements below.
  await page.evaluate(() => new Promise(resolve =>
    requestAnimationFrame(() => requestAnimationFrame(resolve))));
  // On a phone the model is the canvas alone, with no text on screen.
  assert.ok(await page.locator('#view').innerText() || view === 'model' && await page.locator('canvas.v-canvas').isVisible(), `${view} mounts`);
}
try {
  const page = await browser.newPage({ viewport: { width:1280, height:900 } });
  await page.addInitScript(() => localStorage.setItem('tiksi.onScreen.v1', '{"all":true}'));   // MODEL's tools on the screen (tiksi-menu.js)
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept(d.type() === 'prompt' ? 'Synthetic audit project' : undefined));
  await page.goto(url); await page.locator('#btn-file').waitFor({ state: 'attached' });
  // The app opens on MODEL; there is no PLAN link.
  assert.equal(await page.evaluate(() => document.querySelector('#rail a.active')?.dataset.view), 'model', 'the desktop opens on MODEL');
  assert.equal(await page.locator('#rail a[data-view="plan"]').count(), 0, 'the rail has no PLAN link');
  for (const view of ['model','materials','photos','projects','products','budget','schedule','sheets']) {
    await navigateToView(page, view);
    console.log('route checked:', view);
  }
  assert.deepEqual(errors, [], 'all eight desktop routes mount without exceptions');
  await navigateToView(page, 'projects'); await page.locator('#new-project').waitFor();
  await page.locator('#new-project').click();
  await page.locator('#proj-detail [data-f=name]').fill('Synthetic audit project'); await page.locator('#proj-detail [data-f=name]').press('Enter');
  await page.locator('#add-item').click();
  await page.locator('[data-if=qty]').fill('0'); await page.locator('[data-if=qty]').press('Tab');
  await page.locator('[data-money=likely]').fill('100'); await page.locator('[data-money=likely]').press('Tab');
  // A price that cannot be read keeps the price it had and says why; it does not become $0.
  await page.locator('[data-money=likely]').fill('10x12'); await page.locator('[data-money=likely]').press('Tab');
  assert.equal(await page.evaluate(async () => { const s = await import('/js/store.js'); return s.ws.data.projects.at(-1).items[0].likely; }), 100, 'an unreadable item price keeps the old price');
  assert.equal(await page.locator('[data-money-problem]').innerText(), '"10x12" is not an amount. Type it like 250000, $250,000, 250k or 1.2m. The likely price of New item is still $100.');
  await page.locator('[data-money=likely]').fill('1200$'); await page.locator('[data-money=likely]').press('Tab');
  assert.equal(await page.evaluate(async () => { const s = await import('/js/store.js'); return s.ws.data.projects.at(-1).items[0].likely; }), 1200, 'a trailing dollar sign still reads');
  assert.equal(await page.locator('[data-money-problem]').count(), 0, 'and the message goes');
  assert.equal(await page.locator('[data-if=qty]').inputValue(), '0');
  assert.equal(await page.evaluate(async () => { const s = await import('/js/store.js'); return s.projectTotals(s.ws.data.projects.at(-1)).likely; }), 0, 'zero quantity contributes zero to budget');
  await navigateToView(page, 'products'); await page.locator('#new-prod').waitFor(); await page.locator('#new-prod').click();
  await page.locator('#prod-form [data-f=name]').fill('Synthetic audit product'); await page.locator('#prod-form [data-f=name]').press('Tab');
  await page.setInputFiles('#prod-form [data-image-file]', { name: 'audit.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGMwnpkGRAwQCgAgugTJyID6aQAAAABJRU5ErkJggg==', 'base64') });
  await page.waitForFunction(() => !document.querySelector('#prod-add').disabled); await page.locator('#prod-add').click();
  await page.locator('[data-items] fieldset', { hasText: 'Synthetic audit project' }).getByLabel('New item').check();
  await page.locator('#prod-form [data-money=price]').fill('$412.50'); await page.locator('#prod-form [data-money=price]').press('Tab');
  const pricesBefore = await page.evaluate(async () => { const s = await import('/js/store.js'); const p = s.projectSlice(s.activeProperty().id).products.find(p => p.name === 'Synthetic audit product'); return { price: p.price, history: (p.priceHistory || []).length }; });
  assert.equal(pricesBefore.price, 412.5);
  await page.locator('#prod-form [data-money=price]').fill('about 300'); await page.locator('#prod-form [data-money=price]').press('Tab');
  const pricesAfter = await page.evaluate(async () => { const s = await import('/js/store.js'); const p = s.projectSlice(s.activeProperty().id).products.find(p => p.name === 'Synthetic audit product'); return { price: p.price, history: (p.priceHistory || []).length }; });
  assert.deepEqual(pricesAfter, pricesBefore, 'an unreadable product price keeps the old price and records no hand-entered $0');
  assert.equal(await page.locator('#prod-form [data-form-message]').innerText(), '"about 300" is not an amount. Type it like 250000, $250,000, 250k or 1.2m. The price is still $412.50.');
  await page.locator('#prod-done').click();
  assert.ok(await page.evaluate(async () => { const s = await import('/js/store.js'); return s.projectSlice(s.activeProperty().id).products.some(p => p.name === 'Synthetic audit product' && p.itemIds.length === 1); }), 'the new product is linked to the work item and saved with this property');
  assert.ok((await page.locator('#view').innerText()).includes('Synthetic audit product'));
  await navigateToView(page, 'budget'); await page.locator('#cap-input').waitFor(); await page.locator('#cap-input').fill('50000'); await page.locator('#cap-input').press('Tab');
  await page.locator('#print-report').click(); assert.ok((await page.locator('#print-root').innerText()).includes('$50,000'));
  await navigateToView(page, 'schedule'); await page.locator('#prog-start').waitFor(); await page.locator('#prog-start').fill('2026-10-15'); await page.locator('#prog-start').press('Tab');
  assert.ok(await page.locator('.gantt-svg').count());
  await navigateToView(page, 'sheets'); await page.locator('.sl-item').first().waitFor(); await page.getByRole('button', {name:'Synthetic audit product',exact:true}).click();
  assert.equal(await page.locator('#sheet-view h1').innerText(), 'Synthetic audit product'); await page.locator('#print-sheet').click();
  assert.ok((await page.locator('#print-root').innerText()).includes('Synthetic audit product'));

  // Deliberately collide legacy level IDs: scoped IndexedDB keys must keep images separate,
  // including replacement images on the same level after an autosave has already completed.
  await page.evaluate(async () => {
    const s = await import('/js/store.js'); const d = s.emptyWorkspace();
    for (const [id, color] of [['prop-a','#aabbcc'],['prop-b','#ccbbaa']]) {
      const p = s.propertyTemplate(id); p.id=id;
      const c=document.createElement('canvas'); c.width=4;c.height=4;c.getContext('2d').fillStyle=color;c.getContext('2d').fillRect(0,0,4,4);
      p.levels[0].plan={img:c.toDataURL(),imgW:4,imgH:4,mPerPx:1}; d.properties.push(p);
    }
    s.replaceWorkspace(d); await s.whenHydrated(); s.save();
  });
  const images = await page.evaluate(async () => { const s = await import('/js/store.js'); return s.ws.data.properties.map(p=>p.levels[0].plan.img); });
  assert.notEqual(images[0], images[1]);
  await waitUntil(() => page.evaluate(async () => {
    const s = await import('/js/store.js');
    const matches = await Promise.all(s.ws.data.properties.map(async p =>
      (await s.getFile(s.planKey(p.levels[0].id, p.id)))?.img === p.levels[0].plan.img));
    return matches.every(Boolean);
  }), 'both property-scoped underlays persist before reload');
  await page.goto(url + '/#/model'); await page.reload(); await page.locator('#btn-file').waitFor({ state: 'attached' });
  assert.deepEqual(await page.evaluate(async () => { const s=await import('/js/store.js');await s.whenHydrated();return s.ws.data.properties.map(p=>p.levels[0].plan.img); }),images,'two properties retain their own underlays after storage reload');
  await page.evaluate(async image=>{const s=await import('/js/store.js');s.ws.data.properties[0].levels[0].plan.img=image;s.save();},images[1]);
  await waitUntil(() => page.evaluate(async () => {
    const s = await import('/js/store.js'); const p = s.ws.data.properties[0];
    return (await s.getFile(s.planKey(p.levels[0].id, p.id)))?.img === p.levels[0].plan.img;
  }), 'replacement underlay persists before reload');
  await page.goto(url + '/#/model'); await page.reload(); await page.locator('#btn-file').waitFor({ state: 'attached' });
  assert.equal(await page.evaluate(async()=>{const s=await import('/js/store.js');await s.whenHydrated();return s.ws.data.properties[0].levels[0].plan.img;}),images[1],'replacement underlay survives reload');

  const portable = await page.evaluate(async () => {
    const s=await import('/js/store.js');const p=s.ws.data.properties[0];p.name='Portable fixture';
    const sourceProperty=s.ws.data.properties[1];sourceProperty.name='Other property stays private';
    sourceProperty.photos=[{id:'photo-texture',name:'Texture source.png',thumb:p.levels[0].plan.img,mime:'image/png'},{id:'photo-unrelated',name:'Unrelated source.png',thumb:p.levels[0].plan.img,mime:'image/png'}];
    const textureBytes=await(await fetch(p.levels[0].plan.img)).arrayBuffer();await s.putFile('photo-texture',textureBytes,{kind:'photo',mime:'image/png'});
    s.ws.data.materials.push({id:'mat-source',name:'Sourced finish',custom:true,kind:'wall',color:'#abc',photoId:'photo-texture'});
    p.walls.push({id:'w-source',level:p.levels[0].id,ax:0,ay:0,bx:4,by:0,thickness:0.1,material:'mat-source'});
    s.ws.data.products.push({id:'prod-source',name:'Sourced fixture',itemIds:[],materialIds:['mat-source'],research:{source:'synthetic',url:'https://example.com/fixture'}});
    p.scans=[{id:'scan-a',name:'fixture.xyz',format:'xyz',kind:'points'}];p.photos=[{id:'photo-a',name:'fixture.png',thumb:p.levels[0].plan.img,mime:'image/png'}];
    await s.putFile('scan-a',new TextEncoder().encode('0 0 0\n1 1 1').buffer,{format:'xyz'});
    const bytes=await (await fetch(p.photos[0].thumb)).arrayBuffer(); await s.putFile('photo-a',bytes,{kind:'photo',mime:'image/png'});
    const pending=s.exportProjectBlob(p.id);p.name='Edit during packing';const packed=await pending;
    const archive=await s.readBundle(new File([packed.blob],packed.name));
    s.replaceWorkspace(s.emptyWorkspace());await s.importProject(new File([packed.blob],packed.name));await s.whenHydrated();
    return {propertyCount:archive.data.properties.length,texturePhotoNames:archive.data.properties[0].photos.map(p=>p.name),textureBytes:Array.from(new Uint8Array((await s.getFile('photo-texture')).buffer)),expectedTextureBytes:Array.from(new Uint8Array(textureBytes)),name:archive.data.properties[0].name,fileCount:packed.fileCount,missing:archive.missing,scan:new TextDecoder().decode((await s.getFile('scan-a')).buffer),sourcedProducts:s.ws.data.products.filter(p=>p.materialIds?.includes('mat-source')).map(p=>({name:p.name,research:p.research})),photos:s.ws.data.properties[0].photos.length,underlay:s.ws.data.properties[0].levels[0].plan.img};
  });
  assert.deepEqual(portable.sourcedProducts,[{name:'Sourced fixture',research:{source:'synthetic',url:'https://example.com/fixture'}}],'material-linked sourced products and provenance survive portable export/import');
  assert.equal(portable.name,'Portable fixture','project export takes an immutable snapshot');assert.equal(portable.fileCount,3);assert.equal(portable.propertyCount,1);assert.deepEqual(portable.texturePhotoNames,['fixture.png','Texture source.png']);assert.deepEqual(portable.textureBytes,portable.expectedTextureBytes,'cross-property material source photo bytes travel with the project');assert.deepEqual(portable.missing,[]);assert.equal(portable.photos,2);assert.equal(portable.underlay,images[1]);assert.equal(portable.scan,'0 0 0\n1 1 1');
  const json = await page.evaluate(async () => { const s=await import('/js/store.js');const f=await import('/js/files.js');const data=s.projectSlice(s.ws.data.properties[0].id);data.properties[0].name='JSON opened';await f.openFromFile(new File([JSON.stringify(data)],'fixture.json'));return s.ws.data.properties[0].name; });
  assert.equal(json,'JSON opened','JSON project open follows its advertised picker support');
  const kept = await page.evaluate(async () => {
    const s=await import('/js/store.js');const f=await import('/js/files.js');const m=await import('/js/materials.js');
    const p=s.activeProperty();const made=m.newMaterial('wall');made.name='Made here, unassigned';
    s.ws.data.materials.push({id:'mat-file-unused',name:'Opened unassigned',custom:true,kind:'any',color:'#333',propertyIds:[p.id]});
    s.ws.data.settings.programStart='2026-11-01';
    const packed=await s.exportProjectBlob(p.id);
    s.replaceWorkspace(s.emptyWorkspace());s.ws.data.settings.programStart='2026-10-30';
    await f.openFromFile(new File([packed.blob],packed.name));
    const again=(await s.readBundle(new File([(await s.exportProjectBlob(p.id)).blob],'again.tiksi'))).data;
    return {made:made.id,ids:again.materials.map(x=>x.id),start:s.ws.data.settings.programStart,savedStart:again.settings.programStart};
  });
  assert.ok(kept.ids.includes(kept.made)&&kept.ids.includes('mat-file-unused'),'a project file keeps unassigned custom materials across open and save');
  assert.equal(kept.start,'2026-11-01','opening a project file brings its schedule start');
  assert.equal(kept.savedStart,'2026-11-01','saving an opened project file writes its schedule start back');

  const fileSafety=await page.evaluate(async()=>{
    const s=await import('/js/store.js'),f=await import('/js/files.js');const p=s.ws.data.properties[0];let aborted=0,closed=0;
    const handle={name:'fixture.tiksi',createWritable:async()=>({write:async()=>{throw new Error('disk full');},close:async()=>closed++,abort:async()=>aborted++})};
    window.showSaveFilePicker=async()=>handle;let failed='';try{await f.saveProject(p,{as:true});}catch(e){failed=e.message;}
    handle.createWritable=async()=>({write:async()=>{p.notes='Edit while write is pending';},close:async()=>{},abort:async()=>{}});
    await f.saveProject(p,{as:true});return{aborted,closed,failed,dirty:f.isDirty(p.id)};
  });
  assert.equal(fileSafety.aborted,1);assert.equal(fileSafety.closed,0);assert.match(fileSafety.failed,/disk full/);assert.equal(fileSafety.dirty,true,'edit during file writing keeps SAVE dirty');

  const folderSafety=await page.evaluate(async()=>{
    const s=await import('/js/store.js'),f=await import('/js/files.js');const p=s.ws.data.properties[0];p.name='Folder fixture';
    let mtime=100,writes=0;const files=new Map([['Folder fixture.tiksi',{name:'Folder fixture.tiksi',getFile:async()=>new File(['unrelated backup'],'Folder fixture.tiksi',{lastModified:10})}]]);
    const dir={name:'synthetic-folder',getFileHandle:async(name,opts)=>{if(files.has(name))return files.get(name);if(!opts?.create)throw new DOMException('missing','NotFoundError');const h={name,getFile:async()=>new File(['saved'],name,{lastModified:mtime}),createWritable:async()=>({write:async()=>writes++,close:async()=>{},abort:async()=>{}})};files.set(name,h);return h;}};
    const state=f.filesState();state.folder=dir;state.folderMap={};await f.syncFolder();const saved=state.folderMap[p.id].file;
    mtime=101;p.notes='edit after external write';await f.syncFolder();const result={saved,writes,conflict:state.conflicts.has(p.id),backup:await(await files.get('Folder fixture.tiksi').getFile()).text()};state.folder=null;clearTimeout(state.syncTimer);return result;
  });
  assert.equal(folderSafety.saved,'Folder fixture (2).tiksi');assert.equal(folderSafety.writes,1);assert.equal(folderSafety.conflict,true);assert.equal(folderSafety.backup,'unrelated backup');
  assert.deepEqual(errors,[],'desktop mutations and file roundtrip remain free of page exceptions');
  const workspaceJson=await page.evaluate(async()=>{
    const s=await import('/js/store.js'),f=await import('/js/files.js');const data=JSON.parse(JSON.stringify(s.ws.data));data.properties.push(s.propertyTemplate('Second fixture'));s.ws.data.properties.push(s.propertyTemplate('Unrelated existing property'));
    let message='';const original=window.confirm;window.confirm=msg=>{message=msg;return true;};await f.openFromFile(new File([JSON.stringify(data)],'workspace-fixture.json'));window.confirm=original;return{message,properties:s.ws.data.properties.length};
  });
  assert.equal(workspaceJson.message,'');assert.equal(workspaceJson.properties,3,'workspace JSON adds/updates without warning or deleting an unrelated property');
  console.log('project and file regression checks passed');
  const quota=await page.evaluate(async()=>{
    const s=await import('/js/store.js');await s.whenHydrated();const original=IDBObjectStore.prototype.put;let writes=0;
    IDBObjectStore.prototype.put=function(rec,...rest){if(String(rec.id).startsWith('plan-')){writes++;throw new DOMException('synthetic quota','QuotaExceededError');}return original.call(this,rec,...rest);};
    const plan=(s.activeProperty().levels[0].plan ||= {imgW:3,imgH:3,mPerPx:1});const c=document.createElement('canvas');c.width=3;c.height=3;plan.img=c.toDataURL();s.save();await new Promise(r=>setTimeout(r,150));
    const stored=JSON.parse(localStorage.getItem('tiksi.workspace.v1'));const inline=stored.properties[0].levels[0].plan.img===plan.img;IDBObjectStore.prototype.put=original;return{writes,inline};
  });
  assert.equal(quota.writes,1,'failed IndexedDB underlay write does not recursively retry forever');assert.equal(quota.inline,true,'failed IndexedDB underlay write keeps a browser JSON backup');
  await page.close();

  // Real mobile layout at load; this is not a desktop page resized after startup.
  const mobile = await browser.newPage({viewport:{width:402,height:874},isMobile:true,hasTouch:true,deviceScaleFactor:2});
  await mobile.addInitScript(() => localStorage.setItem('tiksi.onScreen.v1', '{"all":true}'));   // MODEL's tools on the screen (tiksi-menu.js)
  mobile.on('pageerror', e => errors.push(e.message));
  // A phone opens on the model.
  await mobile.goto(url); await mobile.locator('canvas.v-canvas').waitFor();
  // The phone already shows MODEL, so it is visited last, coming back from another page.
  for(const view of ['materials','photos','projects','products','budget','schedule','sheets','model']) {
    await navigateToView(mobile, view);
    console.log('mobile route checked:', view);
    assert.equal(await mobile.evaluate(()=>document.body.scrollWidth),402,`${view} does not widen mobile viewport`);
    if(view==='model') assert.ok(await mobile.locator('canvas.v-canvas').isVisible(),`${view} has a visible mobile canvas`);
  }
  assert.deepEqual(errors, [], 'all eight mobile routes mount without exceptions');
  await mobile.close();
  console.log('Browser audit passed: eight desktop/mobile routes; projects, products, budget/report, schedule, cut sheets; underlay isolation/replacement; portable scan/photo project roundtrip; JSON open; atomic file failure and edit-during-save; folder backup/conflict safety.');
} finally { await browser.close(); await new Promise(r=>server.close(r)); }
