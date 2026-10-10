// Archive transport regression: camera originals are opaque here, not decoded or reconstructed.
// MIME metadata and byte preservation must survive both manifested and legacy archives.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const server=createServer(async(req,res)=>{
  if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<script type="importmap">{"imports":{"three/addons/":"/vendor/addons/"}}</script>');return;}
  const path=resolve(root,'.'+req.url.split('?')[0]);if(!path.startsWith(root+sep)){res.writeHead(403).end();return;}
  try{res.setHeader('Content-Type',extname(path)==='.js'?'text/javascript':'application/octet-stream');res.end(await readFile(path));}catch{res.writeHead(404).end();}
});
await new Promise(r=>server.listen(0,'localhost',r));const browser=await chromium.launch();
try{
 const page=await browser.newPage();await page.goto(`http://localhost:${server.address().port}/`);
 const results=await page.evaluate(async()=>{
  const s=await import('/js/store.js'),zip=await import('three/addons/libs/fflate.module.js');const d=s.emptyWorkspace(),p=s.propertyTemplate('Archive photo fixture');d.properties.push(p);s.replaceWorkspace(d);await s.whenHydrated();
  const expected=[];
  for(const ext of ['heic','heif','tiff','avif','bmp']){
   const id='ph-'+ext,mime='image/'+ext;
   // Deliberately opaque payload tests archival transport independently of platform decoders.
   const bytes=new Uint8Array([0,255,17,32,9,...new TextEncoder().encode(ext)]);expected.push({id,mime,ext,bytes:Array.from(bytes)});
   p.photos.push({id,name:'camera-original.'+ext,mime,thumb:'',kind:'photo'});await s.putFile(id,bytes.buffer,{kind:'photo',mime});
  }
  const packed=await s.exportProjectBlob(p.id),file=new File([packed.blob],packed.name),read=await s.readBundle(file);
  const entries=zip.unzipSync(new Uint8Array(await packed.blob.arrayBuffer()));delete entries['manifest.json'];
  const legacy=await s.readBundle(new File([zip.zipSync(entries)],'legacy.tiksi'));
  s.replaceWorkspace(s.emptyWorkspace());await s.importProject(file);
  const f=await import('/js/files.js');let jsonWrites=0,zipWrites=0,savedBlob;
  const jsonHandle={name:'camera-project.json',getFile:async()=>new File([JSON.stringify(s.ws.data)],'camera-project.json',{type:'application/json'}),queryPermission:async()=> 'granted',createWritable:async()=>({write:async()=>jsonWrites++,close:async()=>{}})};
  window.showOpenFilePicker=async()=>[jsonHandle];
  window.showSaveFilePicker=async()=>({name:'camera-project.tiksi',createWritable:async()=>({write:async blob=>{zipWrites++;savedBlob=blob;},close:async()=>{}})});
  await f.openProjectPicker();await f.saveProject(s.activeProperty());const savedProject=await s.readBundle(new File([savedBlob],'camera-project.tiksi'));
  return{jsonWrites,zipWrites,savedFormat:savedProject.manifest.format,expected,paths:read.manifest.files.map(f=>f.path),files:read.files.map(f=>({id:f.id,mime:f.meta.mime,kind:f.meta.kind,bytes:Array.from(new Uint8Array(f.buffer))})),legacy:legacy.files.map(f=>({id:f.id,mime:f.meta.mime,kind:f.meta.kind})),restored:await Promise.all(expected.map(async f=>{const rec=await s.getFile(f.id);return{id:f.id,mime:rec.mime,bytes:Array.from(new Uint8Array(rec.buffer))};}))};
 });
 for(const fixture of results.expected){assert.ok(results.paths.includes(`files/${fixture.id}.${fixture.ext}`));assert.deepEqual(results.files.find(f=>f.id===fixture.id),{id:fixture.id,mime:fixture.mime,kind:'photo',bytes:fixture.bytes});assert.deepEqual(results.legacy.find(f=>f.id===fixture.id),{id:fixture.id,mime:fixture.mime,kind:'photo'});assert.deepEqual(results.restored.find(f=>f.id===fixture.id),{id:fixture.id,mime:fixture.mime,bytes:fixture.bytes});}
 assert.equal(results.jsonWrites,0,'opening JSON metadata never adopts it as a ZIP save target');assert.equal(results.zipWrites,1);assert.equal(results.savedFormat,'tiksi-project');
 console.log('Photo archive transport passed: HEIC/HEIF/TIFF/AVIF/BMP extensions, MIME metadata, legacy classification and exact original bytes; JSON open then SAVE keeps metadata intact and writes a separate project archive. Decoders were not exercised.');
}finally{await browser.close();await new Promise(r=>server.close(r));}
