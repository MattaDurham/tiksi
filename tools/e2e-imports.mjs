// Synthetic, isolated browser integration. No owner workspace, servers or credentials.
// Run node tools/fixture-room.mjs && node tools/e2e-imports.mjs.
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const file = resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
  if (!file.startsWith(root + '/') || !existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.setHeader('content-type', ({ '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json' })[extname(file)] || 'application/octet-stream');
  res.end(readFileSync(file));
});
await new Promise(r => server.listen(0, 'localhost', r));
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage();
  await page.goto('http://localhost:' + server.address().port + '/');
  const results = await page.evaluate(async () => {
    const { importScanBytes, loadMesh, inspectGltf } = await import('./js/scans.js');
    const { getFile } = await import('./js/store.js');
    const { zipSync, strToU8 } = await import('./vendor/addons/libs/fflate.module.js');
    const { packGlb, readBody, fetchVia, fetchCaptureDirect, parseCaptureUrl } = await import('./js/polycam.js');
    const { unpackModelZip } = await import('./js/scanbundle.js');
    const results = [];
    const check = (ok, name) => { if (!ok) throw new Error(name); results.push(name); };
    const prop = { scans: [] };
    const enc = text => new TextEncoder().encode(text).buffer;
    const reject = async (buffer, name, pattern) => {
      const before = prop.scans.length;
      let error = '';
      try { await importScanBytes(buffer, name, prop); } catch (e) { error = e.message; }
      check(pattern.test(error), name + ' reports a specific error (' + error + ')');
      check(prop.scans.length === before, name + ' creates no broken record');
    };
    await reject(enc('<html>not a model</html>'), 'bad.glb', /GLB/);
    await reject(enc('v NaN 0 0\nf 1 2 3'), 'bad.obj', /invalid|geometry/i);
    await reject(enc('nonsense'), 'bad.pcd', /point|PCD|header|undefined/i);
    await reject(enc(''), 'empty.ply', /empty/i);
    await reject(enc('1 2 3'), 'bad.laz', /Native conversion|Unsupported/i);
    await reject(enc('1 2 3'), 'bad.e57', /Native conversion|Unsupported/i);
    await reject(enc('abc'), 'bad.splat', /Truncated/i);
    const badSplat = new ArrayBuffer(32); new DataView(badSplat).setFloat32(0, NaN, true);
    await reject(badSplat, 'bad-coordinates.splat', /coordinates/i);
    const validSplat=new ArrayBuffer(32), sdv=new DataView(validSplat);
    for(const o of [12,16,20]) sdv.setFloat32(o,0.05,true);
    new Uint8Array(validSplat).set([255,80,20,255,255,128,128,128],24);
    const splatScan=await importScanBytes(validSplat,'single.splat',prop);
    check(splatScan.kind==='splat','valid Gaussian SPLAT decodes before storage');
    const forgedStl = new ArrayBuffer(84); new DataView(forgedStl).setUint32(80, 0xffffffff, true);
    await reject(forgedStl, 'forged.stl', /triangle count/i);
    await reject(enc('ply\nformat not_supported 1.0\nelement vertex 2\nproperty float x\nproperty float y\nproperty float z\nend_header\n0 0 0\n1 1 1'), 'bad.ply', /encoding/i);
    const truncatedLas = new ArrayBuffer(227), ldv = new DataView(truncatedLas);
    new Uint8Array(truncatedLas).set([76,65,83,70]); ldv.setUint8(24,1); ldv.setUint8(25,4); ldv.setUint16(94,375,true);
    await reject(truncatedLas, 'truncated.las', /header/i);
    const las = new ArrayBuffer(375 + 36 * 3), dv = new DataView(las);
    new Uint8Array(las).set([76,65,83,70]); dv.setUint8(24,1); dv.setUint8(25,4); dv.setUint16(94,375,true); dv.setUint32(96,375,true); dv.setUint8(104,7); dv.setUint16(105,36,true); dv.setBigUint64(247,3n,true);
    for (const o of [131,139,147]) dv.setFloat64(o,0.001,true);
    for (let i=0;i<3;i++) {const o=375+i*36;dv.setInt32(o,500000000+i*10,true);dv.setInt32(o+4,200000000+i*20,true);dv.setInt32(o+8,1000+i*30,true);dv.setUint16(o+30,65535,true);dv.setUint16(o+32,i*10000,true);}
    const lasScan=await importScanBytes(las,'georeferenced.las',prop);
    const { parseAndRecentre }=await import('./js/las.js');
    const lasPoints=parseAndRecentre('las',las);
    check(lasScan.kind==='points' && lasPoints.count===3 && Math.abs(lasPoints.positions[3]-lasPoints.positions[0]-0.01)<0.00001,'LAS 1.4 RGB maintains centimetres at UTM coordinates');
    const zeroStride=las.slice(0);new DataView(zeroStride).setUint16(105,0,true);
    await reject(zeroStride,'zero-stride.las',/record length/i);
    const pointPly=enc('ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n0 0 0 255 0 0\n1 1 1 0 255 0\n2 2 2 0 0 255\n');
    const plyScan=await importScanBytes(pointPly,'colored.ply',prop);
    check(plyScan.kind==='points' && parseAndRecentre('ply',pointPly).hasColor,'colored PLY is a point cloud, not mistaken for Gaussian splats');
    const gltf = {
      asset: { version: '2.0' }, scenes: [{ nodes: [0] }], scene: 0, nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, material: 0 }] }],
      buffers: [{ byteLength: 36, uri: 'geometry.bin' }, { byteLength: 24, uri: 'uv.bin' }],
      bufferViews: [{ buffer: 0, byteLength: 36 }, { buffer: 1, byteLength: 24 }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0,0,0], max: [1,1,0] }, { bufferView: 1, componentType: 5126, count: 3, type: 'VEC2' }],
      images: [{ uri: 'textures/a.png' }], textures: [{ source: 0, sampler: 0 }], samplers: [{ wrapS: 33071, wrapT: 33071 }],
      materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicRoughnessTexture: { index: 0 } }, normalTexture: { index: 0 }, occlusionTexture: { index: 0 }, emissiveTexture: { index: 0 }, emissiveFactor: [0.2,0.2,0.2] }],
    };
    const geo = new Float32Array([0,0,0,1,0,0,0,1,0]).buffer, uv = new Float32Array([0,0,1,0,0,1]).buffer;
    const canvas = document.createElement('canvas'); canvas.width = 4; canvas.height = 4;
    canvas.getContext('2d').fillStyle = '#e87930'; canvas.getContext('2d').fillRect(0,0,4,4);
    const image = await (await fetch(canvas.toDataURL())).arrayBuffer();
    await reject(enc(JSON.stringify(gltf)), 'missing.gltf', /geometry.bin.*ZIP/i);
    const bytes = zipSync({ 'capture/model.gltf': strToU8(JSON.stringify(gltf)), 'capture/geometry.bin': new Uint8Array(geo), 'capture/uv.bin': new Uint8Array(uv), 'capture/textures/a.png': new Uint8Array(image) });
    const scan = await importScanBytes(bytes.buffer, 'polycam.zip', prop);
    check(scan.format === 'glb' && scan.originalName === 'polycam.zip', 'GLTF ZIP becomes portable GLB');
    const rec = await getFile(scan.id), packed = inspectGltf(rec.buffer, 'glb');
    check(packed.materials[0].normalTexture && packed.materials[0].occlusionTexture && packed.materials[0].emissiveTexture && packed.materials[0].pbrMetallicRoughness.metallicRoughnessTexture, 'all PBR maps survive packing');
    check(packed.samplers[0].wrapS === 33071 && packed.bufferViews[1].byteOffset === 36, 'samplers and multiple geometry buffers survive packing');
    const obj = await loadMesh(rec.buffer, 'glb'); let mat; obj.traverse(o=>{if(o.isMesh) mat=o.material;});
    check(mat.map && mat.normalMap && mat.aoMap && mat.emissiveMap && mat.roughnessMap && mat.metalnessMap, 'stored GLB actually decodes with every material map');
    const embedded = structuredClone(gltf); embedded.images = [{ bufferView: 2, mimeType: 'image/png' }];
    embedded.buffers[0].byteLength = 36 + image.byteLength;
    embedded.bufferViews.push({ buffer: 0, byteOffset: 36, byteLength: image.byteLength });
    const combined = new Uint8Array(36 + image.byteLength); combined.set(new Uint8Array(geo)); combined.set(new Uint8Array(image),36);
    const repacked = packGlb(embedded,[combined.buffer,uv],{});
    check(inspectGltf(repacked,'glb').images[0].bufferView === 2, 'already embedded image is preserved');
    const objZip = zipSync({
      'mesh/model.obj': strToU8('mtllib model.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nvt 0 0\nvt 1 0\nvt 0 1\nusemtl paint\nf 1/1 2/2 3/3\n'),
      'mesh/model.mtl': strToU8('newmtl paint\nKd 1 1 1\nmap_Kd textures/a.png\n'), 'mesh/textures/a.png': new Uint8Array(image),
    });
    const objScan = await importScanBytes(objZip.buffer,'textured-obj.zip',prop);
    const objRec = await getFile(objScan.id), objLoaded = await loadMesh(objRec.buffer,'glb');
    let objMat; objLoaded.traverse(o=>{if(o.isMesh) objMat=o.material;});
    check(objMat.map.image.width === 4, 'textured OBJ ZIP preserves image pixels through reopen');
    const badObjZip = zipSync({ 'model.obj': strToU8('mtllib missing.mtl\nv 0 0 0\nf 1 1 1\n') });
    await reject(badObjZip.buffer,'missing-obj.zip',/Missing model resource/);
    const malicious = zipSync({ '../escape.gltf': strToU8('{}') });
    let zipErr = ''; try { unpackModelZip(malicious.buffer); } catch(e) { zipErr = e.message; }
    check(/leaves its package/.test(zipErr), 'ZIP path traversal rejected');
    const bomb = zipSync({'small.xyz':strToU8('0 0 0')});
    const bdv=new DataView(bomb.buffer); for(let o=0;o<bomb.length-28;o++) if(bdv.getUint32(o,true)===0x02014b50) {bdv.setUint32(o+24,600*1024*1024+1,true);break;}
    let bombError='';try{unpackModelZip(bomb.buffer);}catch(e){bombError=e.message;}
    check(/expands beyond/.test(bombError),'ZIP oversized output rejected before inflation');
    const xyz = await importScanBytes(enc('3\n0 0 0 50 255 0 0\n1 2 3 55 0 255 0\n2 4 6 40 0 0 255'),'cloud.pts',prop);
    check(xyz.kind === 'points', 'PTS count header and intensity/color columns import');
    const stl = await importScanBytes(enc('solid triangle\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid triangle'),'triangle.stl',prop);
    check(stl.kind === 'mesh', 'Polycam STL mesh imports');
    const room = await (await fetch('./tools/fixtures/room.glb')).arrayBuffer();
    const roomScan = await importScanBytes(room,'room.glb',prop);
    check(roomScan.kind === 'mesh', 'full room GLB validates and stores');
    const ctl = new AbortController(); ctl.abort(new Error('user cancelled'));
    let cancelError = ''; try { await importScanBytes(room,'cancel.glb',prop,{signal:ctl.signal}); } catch(e) { cancelError = e.message; }
    check(/user cancelled/.test(cancelError), 'cancelled import does not store');
    let limitError = ''; try { await readBody(new Response(new Uint8Array(20), {headers:{'content-length':'20'}}),null,10); } catch(e) { limitError=e.message; }
    check(/larger/.test(limitError),'download size rejected before body allocation');
    const origFetch = window.fetch;
    const requested = [];
    window.fetch = async (url) => {
      requested.push(String(url));
      if (String(url).endsWith('/edited.gltf')) return new Response('',{status:404});
      if (String(url).endsWith('/original.gltf')) return new Response(JSON.stringify(gltf));
      if (String(url).endsWith('/geometry.bin')) return new Response(geo);
      if (String(url).endsWith('/uv.bin')) return new Response(uv);
      if (String(url).endsWith('/textures/a.png')) return new Response(image);
      return new Response('',{status:404});
    };
    try {
      const direct = await fetchCaptureDirect(parseCaptureUrl('https://poly.cam/capture/synthetic-capture'));
      check(direct.textures === 1 && direct.size > 100,'current Polycam original artifact bundles with textures');
      check(requested.some(u=>u.endsWith('/artifacts/geometry.bin')),'Polycam resources resolve relative to index');
      const abort = new AbortController();
      window.fetch = async () => { abort.abort(new Error('stop')); throw new TypeError('Failed to fetch'); };
      let attempts=0, error='';
      try { await fetchVia('https://example.com/model',{signal:abort.signal,relays:['https://example.com/relay?u={url}'],onRoute:()=>attempts++}); } catch(e) {error=e.message;}
      check(attempts===1 && error==='stop','cancellation stops relay retries');
    } finally { window.fetch=origFetch; }
    return results;
  });
  for (const result of results) console.log('PASS ' + result);
  assert.ok(results.length >= 30);
  console.log('ALL IMPORT INTEGRATION CHECKS PASSED (' + results.length + ')');
} finally { await browser.close(); await new Promise(r=>server.close(r)); }
