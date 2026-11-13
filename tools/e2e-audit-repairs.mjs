// Synthetic browser checks: evidence editing, view-only shading, incremental fixture edits,
// and a read-only offline reload. No owner's project store is opened.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
const root=resolve(new URL('..',import.meta.url).pathname), state=await mkdtemp(tmpdir()+'/tiksi-audit-repairs-');
const socket=net.createServer();await new Promise(r=>socket.listen(Number(process.env.E2E_APP_PORT)||0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
const server=spawn('python3',['tools/serve.py','--port',String(port),'--state-dir',state],{cwd:root,stdio:['ignore','pipe','pipe']});server.stdout.resume();server.stderr.resume();
const url='http://127.0.0.1:'+port;let browser;
try {
  for(let i=0;i<200;i++){try{if((await fetch(url)).ok)break;}catch{}await delay(50);}
  browser=await chromium.launch({args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>localStorage.setItem('tiksi.onScreen.v1','{"all":true}'));
  await page.goto(url);await page.waitForFunction(()=>document.querySelector('#save-status')?.textContent==='SAVED TO DISK');
  await page.evaluate(async()=>{
    const s=await import('/js/store.js'),{ensureBuiltinMaterials}=await import('/js/materials.js'),{fixtureTemplate}=await import('/js/fixtures.js'),{setEvidence}=await import('/js/evidence.js');
    s.ws.data=s.emptyWorkspace();ensureBuiltinMaterials();const p=s.propertyTemplate('Synthetic evidence review');s.ws.data.properties.push(p);s.ws.data.settings.activePropertyId=p.id;
    const level=p.levels[0].id;p.rooms=[{id:'room-a',level,pts:[[0,0],[4,0],[4,4],[0,4]],name:'Modeled region',material:'mat-oak'}];
    p.walls=[{id:'wall-a',level,ax:0,ay:0,bx:4,by:0,thickness:.12}];setEvidence(p.walls[0],'geometry','observed','Synthetic measurement A');
    p.fixtures=[{...fixtureTemplate('furniture','desk',{level,x:2,y:2}),id:'fx-a',name:'Synthetic desk'}];setEvidence(p.fixtures[0],'geometry','inferred','','Provisional dimensions');s.touch();location.hash='#/model';
  });
  await page.locator('[data-uncertainty]').waitFor();
  await page.waitForFunction(async()=> (await import('/js/viewer3d.js')).viewerIdle(),null,{timeout:120000});
  const records=()=>page.evaluate(async()=>{const p=(await import('/js/store.js')).activeProperty();return JSON.stringify([p.walls,p.rooms,p.fixtures,p.scans]);});
  const before=await records();await page.locator('[data-uncertainty]').click();
  assert.equal(await page.locator('[data-uncertainty]').getAttribute('aria-pressed'),'true');
  assert.equal(await records(),before,'shading changes no saved geometry or finishes');
  await page.locator('[data-ol-filter]').fill('Synthetic desk');
  await page.locator('[data-ol-pick="fixture:fx-a"]').click();
  await page.locator('[data-evidence-status]').selectOption('observed');
  await page.locator('[data-evidence-source]').fill('Synthetic tape reading 1');await page.locator('[data-evidence-save]').click();
  assert.equal(await page.evaluate(async()=>{const s=await import('/js/store.js');return (await import('/js/evidence.js')).evidenceState(s.activeProperty().fixtures[0]);}),'observed');
  const builds=await page.evaluate(async()=> (await import('/js/viewer3d.js')).frameState().modelBuilds);
  await page.locator('[data-fx-len="w"]').fill('1.8 m');await page.locator('[data-fx-len="w"]').press('Tab');
  assert.equal(await page.evaluate(async()=> (await import('/js/viewer3d.js')).frameState().modelBuilds),builds,'fixture edit preserves the rest of the model');
  assert.equal(await page.evaluate(async()=>{const s=await import('/js/store.js');return (await import('/js/evidence.js')).evidenceState(s.activeProperty().fixtures[0]);}),'stale');
  await mkdir(resolve(root,'test-results'),{recursive:true});await page.screenshot({path:resolve(root,'test-results/audit-uncertainty.png')});
  await page.locator('[data-uncertainty]').click();
  await page.waitForFunction(async()=>{const p=(await import('/js/offline-store.js')).readOfflineSnapshot();return (await p)?.properties.some(p=>p.name==='Synthetic evidence review'&&p.fixtures[0]?.w===1.8);});
  await page.evaluate(async()=>{await navigator.serviceWorker.ready;return true;});
  // A controlled online navigation fills shell dependencies before the offline journey.
  await page.reload();await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
  await page.waitForFunction(()=>document.querySelector('#save-status')?.textContent==='SAVED TO DISK');
  await context.setOffline(true);await page.reload();
  await page.getByRole('heading',{name:'Offline · saved project view'}).waitFor({timeout:60000});
  assert.equal(await page.locator('[data-fx-len]').count(),0,'offline snapshot has no editing controls');
  assert.ok((await page.locator('body').innerText()).includes('Synthetic evidence review'));
  assert.deepEqual(errors,[]);console.log('PASS uncertainty, evidence drift, incremental fixture edit and offline snapshot');
} finally {await browser?.close();server.kill();await rm(state,{recursive:true,force:true});}
