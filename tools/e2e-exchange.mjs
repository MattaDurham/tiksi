// Synthetic exchange round trips, including real installed native engines when available.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import net from 'node:net';
import { chromium } from 'playwright';
const root=resolve(new URL('..',import.meta.url).pathname), state=await mkdtemp(tmpdir()+'/tiksi-exchange-');
const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
const child=spawn('python3',['tools/serve.py','--port',String(port),'--state-dir',state],{cwd:root,stdio:['ignore','pipe','pipe']});
const url='http://127.0.0.1:'+port;
let browser;
try {
  for(let i=0;i<100;i++){try{if((await fetch(url)).ok)break;}catch{}await new Promise(r=>setTimeout(r,50));}
  browser=await chromium.launch({args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const page=await browser.newPage({viewport:{width:1440,height:1000}}), errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(url);await page.locator('[data-prop-name]').waitFor();
  const checks=await page.evaluate(async()=>{
    const THREE=await import('three');
    const store=await import('/js/store.js'),{exportModel}=await import('/js/model-exchange.js');
    const {importScanBytes,loadMesh}=await import('/js/scans.js'),{converterCapabilities,nativeConvert,conversionPacket}=await import('/js/native-conversion.js');
    const {modelMaterialSlots}=await import('/js/model-materials.js');
    const {modelTakeoff,createModelEstimate}=await import('/js/model-takeoff.js');
    const results=[],check=(condition,label)=>{if(!condition)throw new Error(label);results.push(label);};
    store.ws.data=store.emptyWorkspace();const p=store.propertyTemplate('Synthetic exchange house');store.ws.data.properties.push(p);store.ws.data.settings.activePropertyId=p.id;
    p.walls=[{id:'wall-exchange',ax:1,ay:2,bx:5,by:2,thickness:.15,height:3,level:p.levels[0].id,material:'mat-drywall'}];
    p.rooms=[{id:'room-exchange',name:'Test room',pts:[[1,2],[5,2],[5,5],[1,5]],level:p.levels[0].id,material:'mat-oak'}];
    const sizeOf=obj=>{obj.updateMatrixWorld(true);const b=new THREE.Box3().setFromObject(obj);return [b.min.x,b.min.y,b.min.z,b.max.x,b.max.y,b.max.z];};
    let originalSize;
    for(const format of ['glb','dae','obj','stl']) {
      const out=await exportModel(p,{format}),buffer=await out.blob.arrayBuffer();
      const scan=await importScanBytes(buffer,out.name,p),rec=await store.getFile(scan.id),mesh=await loadMesh(rec.buffer,scan.format),size=sizeOf(mesh);
      check(scan.kind==='mesh',format+' export imports as a mesh');
      if(!originalSize)originalSize=size;else check(size.every((v,i)=>Math.abs(v-originalSize[i])<.002),format+' preserves metre bounds and origin');
      check((await store.getFile(scan.originalFileId)).buffer.byteLength===buffer.byteLength,format+' original upload retained');
      if(format!=='stl')check(modelMaterialSlots(mesh).length>0,format+' returns identifiable material slots');
    }
    const surface=new THREE.Mesh(new THREE.PlaneGeometry(2,3),new THREE.MeshStandardMaterial({name:'Measured paint'}));surface.scale.setScalar(2);
    const measured=modelTakeoff(surface);check(Math.abs(measured[0].areaM2-24)<1e-8,'takeoff measures triangle area including transform scale');
    const takeoffScan={id:'synthetic-takeoff',name:'Measured room',materialBindings:{'slot-0':'mat-takeoff'}};
    store.ws.data.materials.push({id:'mat-takeoff',name:'Mapped finish',color:'#e8973a',custom:true});
    store.ws.data.products.push({id:'prod-quote',name:'Saved finish quote',price:3,unit:'sf',materialIds:['mat-takeoff']});
    const estimate=createModelEstimate(p,takeoffScan,surface);check(Math.abs(estimate.items[0].qty-24/.09290304)<1e-7 && estimate.items[0].likely===3,'measured finish estimate uses square feet and saved per-sf price');
    check(store.ws.data.products.find(p=>p.id==='prod-quote').itemIds.includes(estimate.items[0].id),'takeoff links product sourcing/order records');
    let repeat=false;try{createModelEstimate(p,takeoffScan,surface);}catch{repeat=true;}check(repeat,'repeat takeoff refuses duplicate scope');
    const model=p.scans[0];model.pos=[7,2,-3];model.rot=[0,90,0];model.scale=2;
    model.materialBindings={'slot-0':'mat-agent-test'};
    store.ws.data.materials.push({id:'mat-agent-test',name:'Synthetic confirmed paint',color:'#1c64d4',pattern:'flat',kind:'any',custom:true});
    const out=await exportModel(p,{source:'model',scanId:model.id});
    const returned=await importScanBytes(await out.blob.arrayBuffer(),'edited.glb',p),loaded=await loadMesh((await store.getFile(returned.id)).buffer,'glb');
    check(modelMaterialSlots(loaded).some(s=>s.name.includes('Synthetic confirmed paint')),'mapped catalog material name exports');
    check(store.projectSlice(p.id).materials.some(m=>m.id==='mat-agent-test'),'project save carries custom mapped material');
    const packed=await store.exportProjectBlob(p.id),read=await store.readBundle(new File([packed.blob],'project.tiksi'));
    check(read.files.some(f=>f.id===p.scans.find(s=>s.originalName.endsWith('.dae.zip')).originalFileId),'project save includes complete original COLLADA ZIP');
    const canvas=document.createElement('canvas');canvas.width=8;canvas.height=8;const ctx=canvas.getContext('2d');ctx.fillStyle='#ffffff';ctx.fillRect(0,0,8,8);ctx.fillStyle='#cc2211';ctx.fillRect(0,0,4,4);
    const tex=new THREE.CanvasTexture(canvas),textured=new THREE.Mesh(new THREE.PlaneGeometry(2,3),new THREE.MeshStandardMaterial({name:'Original checker',map:tex}));
    const {GLTFExporter}=await import('three/addons/exporters/GLTFExporter.js');
    const textureScan=await importScanBytes(await new GLTFExporter().parseAsync(textured,{binary:true}),'textured.glb',p);
    const cap=await converterCapabilities();
    for(const format of ['dae','obj',...(cap.sketchup?['skp']:[])]){
      const textureOut=await exportModel(p,{source:'model',scanId:textureScan.id,format}),textureReturn=await importScanBytes(await textureOut.blob.arrayBuffer(),textureOut.name,p);
      const mesh=await loadMesh((await store.getFile(textureReturn.id)).buffer,'glb');
      check(modelMaterialSlots(mesh).some(s=>s.material.map?.image.width===8),format+' real textured roundtrip embeds source pixels');
    }
    if(cap.cad){const ifc=await exportModel(p,{format:'ifc',source:'model',scanId:model.id}),returned=await importScanBytes(await ifc.blob.arrayBuffer(),ifc.name,p);check(returned.kind==='mesh','real IFC4 export returns with geometry');const mesh=await loadMesh((await store.getFile(returned.id)).buffer,'glb');let metadata=false;mesh.traverse(o=>{if(o.userData.ifcGlobalId)metadata=true;});check(metadata,'IFC GlobalIds/property metadata remain available');}else results.push('SKIP IFC: optional CAD runtime not installed');
    if(cap.sketchup) {
      const skp=await exportModel(p,{format:'skp',source:'model',scanId:model.id});
      let native;
      try {native=await importScanBytes(await skp.blob.arrayBuffer(),skp.name,p);}catch(e){const {unzipSync}=await import('three/addons/libs/fflate.module.js');const packet=unzipSync(new Uint8Array(await(await conversionPacket(e.jobId)).arrayBuffer()));throw new Error(new TextDecoder().decode(packet['engine.log']));}
      const mesh=await loadMesh((await store.getFile(native.id)).buffer,'glb');
      check(sizeOf(mesh).every((v,i)=>Math.abs(v-sizeOf(loaded)[i])<.002),'real native SKP round trip preserves placed/rotated/scaled mesh');
      check(modelMaterialSlots(mesh).some(s=>s.name.includes('Synthetic confirmed paint')),'real SKP material name returns');
    } else results.push('SKIP native SKP: SDK not installed');
    if(cap.blender) {
      const blend=await exportModel(p,{format:'blend',source:'model',scanId:model.id});
      const native=await importScanBytes(await blend.blob.arrayBuffer(),blend.name,p),mesh=await loadMesh((await store.getFile(native.id)).buffer,'glb');
      check(sizeOf(mesh).every((v,i)=>Math.abs(v-sizeOf(loaded)[i])<.002),'real .blend round trip preserves geometry and placement');
      check(modelMaterialSlots(mesh).some(s=>s.name.includes('Synthetic confirmed paint')),'real Blender material name returns');
    } else results.push('SKIP native Blender: not installed');
    let other;try{await importScanBytes(new TextEncoder().encode('synthetic proprietary model').buffer,'other.c4d',p);}catch(e){other=e;}check(other?.jobId,'other native formats retain a generic interpretation handoff');
    let failed;
    try{await nativeConvert(new TextEncoder().encode('synthetic unsupported native input'),'.rvt');}catch(e){failed=e;}
    check(failed?.jobId,'unsupported native source retained with actionable handoff');
    const {unzipSync}=await import('three/addons/libs/fflate.module.js');const packet=unzipSync(new Uint8Array(await (await conversionPacket(failed.jobId)).arrayBuffer()));
    check(new TextDecoder().decode(packet['source.rvt'])==='synthetic unsupported native input','agent packet retains exact failed source bytes');
    check(JSON.parse(new TextDecoder().decode(packet['report.json'])).state==='failed','agent packet explains failed conversion');
    p.env.quality='low';for(const scan of p.scans)scan.visible=false;store.touch();return results;
  });
  checks.forEach(check=>console.log('PASS '+check));
  await page.locator('#rail a[data-view=model]').click();await page.locator('canvas.v-canvas').waitFor();
  await page.locator('#btn-file').click();await page.locator('[data-file-tab=exchange]').click();await page.locator('dialog').waitFor();
  await page.locator('[data-engines]').filter({hasText:'Local engines'}).waitFor();
  await page.locator('[data-format]').selectOption('glb');
  const downloadPromise=page.waitForEvent('download');await page.locator('[data-save-model]').click();const download=await downloadPromise;
  assert.match(download.suggestedFilename(),/\.glb$/);assert.ok((await readFile(await download.path())).length>100);
  await page.getByText('Conversion history / agent handoffs',{exact:true}).click();
  await page.locator('[data-history]').click();await page.locator('[data-jobs]').filter({hasText:'failed'}).waitFor();
  await page.locator('[data-revision]').selectOption('design');
  await page.locator('[data-return-file]').setInputFiles({name:'returned-edit.glb',mimeType:'model/gltf-binary',buffer:await readFile(await download.path())});
  try {await page.locator('[data-file-dialog]').waitFor({state:'detached',timeout:30000});}catch(e){throw new Error('Bring-back UI: '+await page.locator('[data-status]').innerText());}
  await page.locator('[data-act=before]').waitFor();await page.locator('[data-act=before]').click();
  assert.ok(await page.evaluate(async()=>{const s=await import('/js/store.js');const p=s.activeProperty(),before=p.scans.find(scan=>scan.id===p.designComparison.beforeId);return p.modelSourceId===before.id && before.designSnapshot && before.parametricSnapshot.walls.length>0;}),'before is an immutable saved mesh and parametric snapshot');
  await page.locator('[data-act=after]').click();assert.ok(await page.evaluate(async()=>{const s=await import('/js/store.js');return s.activeProperty().modelSourceId;}));
  assert.equal(await page.locator('#btn-save').count(),0,'only one File entry point');
  await page.setViewportSize({width:390,height:844});await page.locator('#btn-file').click();
  assert.ok(await page.evaluate(()=>document.querySelector('[data-file-dialog]').scrollWidth<=document.querySelector('[data-file-dialog]').clientWidth),'file UI fits mobile width');
  await page.locator('[data-close-file]').click();assert.deepEqual(errors,[]);
  console.log('PASS exchange dialog, native engine status, download and handoff history');
} finally {await browser?.close();child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));await rm(state,{recursive:true,force:true});}
