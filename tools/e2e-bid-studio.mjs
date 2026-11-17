import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,resolve,extname,sep,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {chromium} from 'playwright';
import {sampleWorkspace} from '../test/fixtures/bid-studio.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const types={'.js':'text/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml','.json':'application/json'};
const server=createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,'http://localhost'), file=resolve(root,'.'+(url.pathname==='/'?'/index.html':url.pathname));
    if (!file.startsWith(root+sep)) throw Error();
    const data=await readFile(file);
    res.writeHead(200,{'Content-Type':types[extname(file)] || 'application/octet-stream'}).end(data);
  } catch {res.writeHead(404).end();}
});
const temp=await mkdtemp(join(tmpdir(),'bid-studio-'));
await new Promise(r=>server.listen(Number(process.env.E2E_APP_PORT)||0,'127.0.0.1',r));
const browser=await chromium.launch();
try {
  const page=await browser.newPage();
  const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(w=>{
    if (!localStorage.getItem('tiksi.workspace.v1')) localStorage.setItem('tiksi.workspace.v1',JSON.stringify(w));
    window.print=()=>{window.printed=true;};
  },sampleWorkspace());
  await page.goto('http://127.0.0.1:'+server.address().port+'/#/budget');
  await page.locator('a[href="#/bids"]').first().click();
  const total=page.locator('.bs-summary strong'), initial=await total.innerText();
  await page.locator('[data-rates] summary').click();
  await page.locator('[data-field="rule:rate"]').fill('115');
  await page.locator('[data-field="rule:rate"]').press('Tab');
  await page.waitForFunction(v=>document.querySelector('.bs-summary strong').textContent!==v,initial);
  await page.locator('.bs-studio [data-act="undo"]').click();
  assert.equal(await total.innerText(),initial);
  await page.locator('.bs-studio [data-act="redo"]').click();
  assert.notEqual(await total.innerText(),initial);
  await page.locator('[data-room]').first().click();
  assert.ok(await page.locator('.bd-board span').count()>4);
  await page.locator('[data-tab="alternates"]').click();
  assert.ok(await page.locator('[data-alternate] option').count()>0);
  await page.locator('[data-tab="documents"]').click();
  await page.locator('[data-doc]').selectOption('schedule');
  await page.locator('.bs-studio [data-act="print"]').click();
  assert.match(await page.locator('#print-root').innerText(),/Reading room/);
  assert.ok(await page.evaluate(()=>window.printed));
  await page.locator('[data-tab="bids"]').click();
  await page.locator('.bs-studio [data-act="issue"]').click();
  const download=page.waitForEvent('download');
  await page.locator('.bs-studio [data-act="export"]').click();
  const html=join(temp,'issue.html');
  await (await download).saveAs(html);
  const guest=await browser.newPage();
  await guest.goto(pathToFileURL(html).href);
  await guest.locator('input[name="name"]').fill('Example shop');
  await guest.locator('input[name="labor"]').fill('2400');
  await guest.getByText('Enter hours by room and task').click();
  await guest.locator('[data-bid-hours]').first().fill('3.75');
  await guest.locator('input[name="excluded"]').fill('250');
  async function returnResponse(name) {
    const pending=guest.waitForEvent('download');
    await guest.locator('form button').click();
    const file=join(temp,name);
    await (await pending).saveAs(file);
    const chooser=page.waitForEvent('filechooser');
    await page.locator('.bs-studio [data-act="response"]').click();
    await (await chooser).setFiles(file);
    await page.waitForSelector('.bs-feedback:text("Response filed")');
  }
  await returnResponse('offer.json');
  assert.match(await page.locator('.bs-studio').innerText(),/\$2,650.00/);
  await page.getByText('Contractor hours by task').click();
  assert.match(await page.locator('.bs-studio').innerText(),/3.8 h/);
  await guest.selectOption('select[name="kind"]','approval');
  await guest.locator('input[name="name"]').fill('Sample owner');
  await returnResponse('approval.json');
  await page.waitForSelector('p:text("Sample owner")');
  await page.locator('[data-tab="estimate"]').click();
  await page.selectOption('[data-project]','reading');
  await page.locator('[data-tab="bids"]').click();
  assert.match(await page.locator('.bs-issue').innerText(),/Working estimate has changed/);
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('tiksi.workspace.v1')).properties[0].bidStudio.responses?.length===2);
  await page.reload();
  await page.locator('[data-tab="bids"]').click();
  assert.match(await page.locator('.bs-studio').innerText(),/Sample owner/);
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.locator('.bs-studio').evaluate(el=>el.scrollWidth<=el.clientWidth+1));
  assert.deepEqual(errors,[]);
  console.log('Passed live repricing, undo, alternate, cut diagram, crew print, guest bid and approval round trip, revision, persistence and phone layout.');
} finally {
  await browser.close(); await new Promise(r=>server.close(r)); await rm(temp,{recursive:true,force:true});
}
