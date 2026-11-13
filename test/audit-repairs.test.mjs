import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createHash } from 'node:crypto';
const vendor = new URL('../vendor/', import.meta.url).href;
registerHooks({resolve(spec,ctx,next) { if(spec==='three') return {url:vendor+'three.module.min.js',shortCircuit:true}; if(spec.startsWith('three/addons/'))return {url:vendor+'addons/'+spec.slice(13),shortCircuit:true}; return next(spec,ctx); }});
const THREE = await import('../vendor/three.module.min.js');
const store = await import('../js/store.js');
store.replaceWorkspace({properties:[],projects:[],products:[],materials:[]});
const { setEvidence, evidenceState, elementEvidenceRecord } = await import('../js/evidence.js');
const { withUncertainty } = await import('../js/uncertainty-view.js');
const { openingSpans, wallSolids } = await import('../js/wall-solids.js');
const { resizeOpening, openingSchedule } = await import('../js/opening-schedule.js');
const { buildRoomCeiling, thresholdFloors } = await import('../js/geometry.js');
const { needsOwner } = await import('../js/measurements.js');
const { sha256Blob } = await import('../js/sha256.js');
const { linkComponentProduct, unlinkComponentProduct } = await import('../js/model-components.js');
const { mergeMirror } = await import('../js/sketchup-mirror.js');

test('a saved project retains directly referenced and proposed products after scope deletion', () => {
  const p = store.propertyTemplate('Synthetic'); p.scans=[{componentProducts:{key:{productId:'observed',proposedProduct:{productId:'proposal'}}}}];
  p.fixtures=[{product:{productId:'fixture'}}];p.rooms=[{material:'finish'}];
  const data={properties:[p],projects:[],products:['observed','proposal','fixture','paint','unrelated'].map(id=>({id})),materials:[{id:'finish',custom:true,product:{productId:'paint'}}],settings:{}};
  assert.deepEqual(store.projectSlice(p.id,data).products.map(p=>p.id),['observed','proposal','fixture','paint']);
});
test('observed claims require evidence and become stale when their geometry changes', () => {
  const record={w:1}; assert.equal(evidenceState(record),'unknown');
  assert.throws(()=>setEvidence(record,'geometry','observed',''));
  setEvidence(record,'geometry','observed','Photo 12 + reading 4'); assert.equal(evidenceState(record),'observed');
  record.w=1.2;assert.equal(evidenceState(record),'stale');assert.equal(record.evidence.geometry.source,'Photo 12 + reading 4');
});
test('uncertainty shading retains geometry, visibility and original materials, including when rendering fails', () => {
  const root=new THREE.Group(), material=new THREE.MeshStandardMaterial({color:'#fff'}), mesh=new THREE.Mesh(new THREE.BoxGeometry(),material);root.add(mesh);
  const geometry=mesh.geometry;
  assert.throws(()=>withUncertainty([root],()=>({}),()=>{assert.notEqual(mesh.material,material);assert.equal(mesh.geometry,geometry);assert.equal(mesh.visible,true);throw Error('draw');}));
  assert.equal(mesh.material,material);assert.equal(material.color.getHexString(),'ffffff');material.dispose();geometry.dispose();
});
test('a proposed substitute does not replace an observed identity or change geometry', () => {
  const data={products:[{id:'actual',brand:'A',model:'A1'},{id:'match',brand:'B',model:'B1'}]},scan={componentProducts:{key:{productId:'actual',identityStatus:'observed'}}};
  linkComponentProduct(data,{id:'p'},scan,{key:'key',name:'Object'},{productId:'match',identityStatus:'proposed'},()=>{});
  assert.equal(scan.componentProducts.key.productId,'actual');assert.equal(scan.componentProducts.key.proposedProduct.productId,'match');
  unlinkComponentProduct(scan,'key','proposed');assert.equal(scan.componentProducts.key.productId,'actual');assert.equal(scan.componentProducts.key.proposedProduct,undefined);
});
test('overlapping openings keep their widths in render spans and schedule; edits are rejected atomically', () => {
  const wall={id:'w',ax:0,ay:0,bx:4,by:0}, a={id:'a',wallId:'w',type:'door',t:.4,width:1.5,height:2},b={...a,id:'b',t:.6};
  const prop={walls:[wall],openings:[a,b],rooms:[],levels:[]};
  assert.deepEqual(openingSpans(wall,[a,b],4).map(s=>Math.round((s.s1-s.s0)*100)/100),[1.5,1.5]);
  assert.ok(openingSchedule(prop).every(r=>r.problems.length)); const before=structuredClone(b);assert.equal(resizeOpening(prop,b,{width:1.6}),null);assert.deepEqual(b,before);
  const solids=wallSolids(wall,[a,b],2.4).solids;
  assert.ok(!solids.some(s=>s.s0<2 && s.s1>2 && s.v0<2));
});
test('finished ceiling datum and interior threshold floor continuity', () => {
  const room={id:'r',pts:[[0,0],[2,0],[2,2],[0,2]]};
  const ceiling=buildRoomCeiling(room,2.4);const box=new THREE.Box3().setFromObject(ceiling);assert.ok(Math.abs(box.min.y-2.4)<1e-7);
  const wall={id:'w',ax:0,ay:0,bx:4,by:0,thickness:.2},opening={id:'d',wallId:'w',width:1,t:.5,height:2};
  const rooms=[{id:'a',material:'a',pts:[[0,.1],[4,.1],[4,3],[0,3]]},{id:'b',material:'b',pts:[[0,-.1],[0,-3],[4,-3],[4,-.1]]}];
  assert.deepEqual(thresholdFloors([wall],[opening],rooms).map(r=>r.material),['a','b']);
  assert.equal(thresholdFloors([wall],[opening],rooms.slice(0,1)).length,0);
  assert.equal(thresholdFloors([wall],[opening],[rooms[0],{...rooms[1],kind:'void'}]).length,0);
});
test('applied readings return for review after movement or deletion', () => {
  const wall={id:'w',ax:0,ay:0,bx:3,by:0}, prop={walls:[wall]}, reading={status:'applied',element:{kind:'wall',id:'w',dim:'length'},value:3,text:'3m'};
  assert.equal(needsOwner(prop,reading),false);wall.bx=4;assert.equal(needsOwner(prop,reading),true);prop.walls=[];assert.equal(needsOwner(prop,reading),true);assert.equal(reading.value,3);
});
test('vertical mirror edits are explicitly preserved as unsupported', () => {
  const p=store.propertyTemplate('Synthetic');p.walls=[{id:'w',level:p.levels[0].id,ax:0,ay:0,bx:3,by:0,thickness:.1,height:2.4}];
  const base={...p.walls[0],elevation:0}; const report=mergeMirror(p,{walls:[{id:'w',base,now:{...base,elevation:1}}]});
  assert.equal(report.blockWrite,true);assert.match(report.conflicts[0].reason,/Vertical move/);assert.deepEqual(report.applied,[]);
});
test('streaming SHA-256 matches originals at padding and chunk boundaries without whole-file reads', async () => {
  for(const size of [0,1,55,56,63,64,65,127,128,129,1025]) {
    const bytes=Uint8Array.from({length:size},(_,i)=>i%251),blob=new Blob([bytes]);blob.arrayBuffer=()=>{throw Error('whole-file read');};
    assert.equal(await sha256Blob(blob,128),createHash('sha256').update(bytes).digest('hex'));
  }
});

test('host geometry changes invalidate reviewed opening and ceiling evidence', () => {
  const prop={levels:[{id:'l',height:2.4,elevation:0}],walls:[{id:'w',level:'l',ax:0,ay:0,bx:4,by:0,thickness:.1}]};
  const opening={wallId:'w',width:1,height:2};
  const reviewed=elementEvidenceRecord(prop,'opening',opening);setEvidence(reviewed,'geometry','observed','Synthetic site check');opening.evidence=reviewed.evidence;
  assert.equal(evidenceState(elementEvidenceRecord(prop,'opening',opening)),'observed');
  prop.walls[0].bx=5;assert.equal(evidenceState(elementEvidenceRecord(prop,'opening',opening)),'stale');
  const room={level:'l',pts:[[0,0],[3,0],[3,3]]},ceiling=elementEvidenceRecord(prop,'ceiling',room);setEvidence(ceiling,'geometry','observed','Synthetic ceiling check');room.evidence=ceiling.evidence;
  prop.levels[0].height=3;assert.equal(evidenceState(elementEvidenceRecord(prop,'ceiling',room)),'stale');
});
test('splat uncertainty tint restores source color without changing its geometry or opacity', () => {
  const splat=new THREE.Object3D();splat.userData.splat=true;splat.recolor=new THREE.Color('white');splat.opacity=.5;
  withUncertainty([splat],()=>({}),()=>{assert.notEqual(splat.recolor.getHexString(),'ffffff');assert.equal(splat.opacity,.5);});
  assert.equal(splat.recolor.getHexString(),'ffffff');assert.equal(splat.visible,true);
});

test('recoverable item deletion restores its IDs, evidence and dependent links without overwriting current records', async () => {
  const { keepRemoved, restoreRemoved } = await import('../js/recovery.js');
  const p=store.propertyTemplate('Synthetic recovery'),item={id:'a',name:'Measured work',deps:[],evidence:{source:'Synthetic record'}},dependent={id:'b',deps:['a']};
  const scope={id:'scope',propertyId:p.id,items:[item,dependent]};
  store.ws.data={...store.emptyWorkspace(),properties:[p],projects:[scope]};
  keepRemoved(p,'item',[item],scope.id);const recovery=p.removedRecords[0].id;
  scope.items=[dependent];dependent.deps=[];restoreRemoved(p,recovery);
  assert.deepEqual(scope.items.find(i=>i.id==='a'),item);assert.deepEqual(dependent.deps,['a']);
  keepRemoved(p,'item',[item],scope.id);
  assert.throws(()=>restoreRemoved(p,p.removedRecords[0].id),/already exists/);
  assert.equal(scope.items.filter(i=>i.id==='a').length,1);
});
test('project serialization follows scope links and cyclic product references without unrelated records', () => {
  const p=store.propertyTemplate('Synthetic closure'),data={properties:[p],projects:[{propertyId:p.id,items:[{productId:'a'}]}],products:[{id:'a',proposedProduct:{productId:'b'}},{id:'b',productId:'a'},{id:'unrelated'}],materials:[],settings:{}};
  assert.deepEqual(store.projectSlice(p.id,data).products.map(p=>p.id),['a','b']);
});
test('takeoff source changes are flagged without rewriting manually edited quantities', async () => {
  const { sourceRevision,takeoffState }=await import('../js/source-revision.js');
  const scan={id:'scan',assetRevision:'v1',partOffsets:{}},scope={modelTakeoffId:'scan',sourceRevision:sourceRevision(scan),items:[{quantity:123}]},prop={scans:[scan]};
  assert.equal(takeoffState(scope,prop),'current source version');scan.partOffsets.part={position:[1,0,0]};
  assert.match(takeoffState(scope,prop),/^stale/);assert.equal(scope.items[0].quantity,123);
  prop.scans=[];assert.equal(takeoffState(scope,prop),'missing source');
});
