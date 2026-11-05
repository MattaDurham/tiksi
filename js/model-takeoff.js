// Measured mesh surface areas per model material (model-materials.js: each material once, shared
// by its parts), and counts per component definition (model-components.js). No waste, labour,
// assembly inference or product equivalence is silently added.
import * as THREE from 'three';
import { ws, uid, touch, isoToday, materialById } from './store.js';
import { modelMaterialSlots, slotForMaterial, migrateMaterialKeys } from './model-materials.js';
import { componentSchedule } from './model-components.js';
import { coverageFor, coverageEstimate } from './material-identity.js';

const SQFT = .09290304;

export function modelTakeoff(root) {
  const slots=modelMaterialSlots(root),areas=new Map(slots.map(s=>[s.key,0]));
  root.updateMatrixWorld(true);
  const a=new THREE.Vector3(),b=new THREE.Vector3(),c=new THREE.Vector3(),m=new THREE.Matrix4(),im=new THREE.Matrix4();
  root.traverse(o=>{
    if(!o.isMesh||o.userData.pickBox)return;
    const g=o.geometry,p=g.getAttribute('position'),index=g.index;
    if(!p)return;
    const materials=o.userData.sourceMaterials||(Array.isArray(o.material)?o.material:[o.material]);
    // An instanced mesh draws its geometry once per instance, each with its own placement.
    const placements=[];
    if(o.isInstancedMesh)for(let i=0;i<o.count;i++){o.getMatrixAt(i,im);placements.push(new THREE.Matrix4().multiplyMatrices(o.matrixWorld,im));}
    else placements.push(o.matrixWorld);
    const groups=g.groups.length?g.groups:[{start:0,count:index?.count||p.count,materialIndex:0}];
    for(const group of groups){
      const slot=slotForMaterial(root,materials[group.materialIndex||0]);if(!slot)continue;
      let area=0;
      const end=Math.min(group.start+group.count,g.drawRange.start+g.drawRange.count,index?.count||p.count);
      for(const placement of placements){
        m.copy(placement);
        for(let i=Math.max(group.start,g.drawRange.start);i+2<end;i+=3){
          a.fromBufferAttribute(p,index?index.getX(i):i).applyMatrix4(m);
          b.fromBufferAttribute(p,index?index.getX(i+1):i+1).applyMatrix4(m);
          c.fromBufferAttribute(p,index?index.getX(i+2):i+2).applyMatrix4(m);
          area+=b.sub(a).cross(c.sub(a)).length()/2;
        }
      }
      areas.set(slot.key,areas.get(slot.key)+area);
    }
  });
  return slots.map(s=>({...s,areaM2:areas.get(s.key)}));
}

// The estimated amount of a finish to buy for a measured area, from the coverage stored on the
// material (or its product), or null when none is stored. Area only: an estimate.
export function finishAmount(record,areaM2) {
  return record ? coverageEstimate(areaM2,coverageFor(record,ws.data.products)) : null;
}
export function amountText(est) {
  if(!est)return '';
  const amount=est.amount<10?Math.ceil(est.amount*10)/10:Math.ceil(est.amount);
  return 'about '+amount+' '+est.unit+' ('+est.coats+' coat'+(est.coats===1?'':'s')+' at '+Math.round(est.areaM2PerUnit/SQFT)+' sf per '+est.unit+'; estimate from area)';
}

export function createModelEstimate(prop,scan,root) {
  if(migrateMaterialKeys(scan,root))touch();
  const takeoff=modelTakeoff(root).filter(s=>(scan.materialBindings?.[s.key] || scan.materialIdentities?.[s.key]) && s.areaM2>0);
  if(!takeoff.length)throw new Error('Map at least one finish surface to a Tiksi material first.');
  const existing=ws.data.projects.find(p=>p.modelTakeoffId===scan.id);
  if(existing)throw new Error('A takeoff already exists for this model. Edit it in Scope, or delete it before regenerating.');
  const pr={id:uid('proj'),propertyId:prop.id,name:'Model finishes — '+scan.name,category:'interior',status:'idea',selected:true,startDate:isoToday(),notes:'Measured triangle surface area. Review finish coverage, openings, overlap, waste, labour and current product prices before ordering.',modelTakeoffId:scan.id,items:[]};
  for(const slot of takeoff){
    const mat=materialById(scan.materialBindings?.[slot.key] || scan.materialIdentities?.[slot.key]),qty=slot.areaM2/SQFT;
    const products=ws.data.products.filter(p=>p.materialIds?.includes(mat.id));
    const priced=products.filter(p=>['sf','sq ft','ft2'].includes(String(p.unit).toLowerCase())&&Number.isFinite(p.price)&&p.price>=0);
    const price=priced.length===1?priced[0].price:0;
    const amount=finishAmount(mat,slot.areaM2);
    const item={id:uid('it'),name:mat.name+' — '+slot.name,qty,unit:'sf',low:price,likely:price,high:price,durationDays:0,deps:[],elementIds:[scan.id],materialId:mat.id,
      modelSurface:{scanId:scan.id,slot:slot.key,areaM2:slot.areaM2,parts:slot.parts},notes:(price?'Uses saved '+priced[0].name+' price per sf. Verify quote; labour/waste excluded.':'Price required. No unique saved product price per sf; use product sourcing to select a quote.')+(amount?' Amount: '+amountText(amount)+'.':'')};
    if(amount)item.modelSurface.amount={value:amount.amount,unit:amount.unit,coats:amount.coats,estimate:true};
    pr.items.push(item);
    if(priced.length===1){priced[0].itemIds=priced[0].itemIds||[];if(!priced[0].itemIds.includes(item.id))priced[0].itemIds.push(item.id);}
  }
  ws.data.projects.push(pr);touch();return pr;
}

// Scope for the model's components: one item per component definition with its total count
// (nested instances multiplied through), priced from the linked product when it is priced each.
// The budget and schedule read it like any other project.
export function createComponentEstimate(prop,scan,root) {
  const rows=componentSchedule(ws.data,scan,root);
  if(!rows.length)throw new Error('This model has no components. Groups are unique; only component definitions are counted.');
  if(ws.data.projects.some(p=>p.modelComponentsId===scan.id))throw new Error('A component estimate already exists for this model. Edit it in Scope, or delete it before regenerating.');
  const pr={id:uid('proj'),propertyId:prop.id,name:'Model components — '+scan.name,category:'interior',status:'idea',selected:true,startDate:isoToday(),
    notes:'Counted component instances from the model, nested ones multiplied through. Review spares, waste, labour and current prices before ordering.',modelComponentsId:scan.id,items:[]};
  for(const r of rows){
    const product=r.productId?ws.data.products.find(p=>p.id===r.productId):null;
    const item={id:uid('it'),name:r.name+(r.product?' — '+r.product:''),qty:r.count,unit:'ea',low:r.unitPrice,likely:r.unitPrice,high:r.unitPrice,durationDays:0,deps:[],elementIds:[scan.id],
      modelComponent:{scanId:scan.id,key:r.key,count:r.count},notes:r.unitPrice?'Uses saved '+r.product+' price each. Verify quote; labour excluded.':(r.priceNote||(product?'The linked product has no price yet.':'No product linked. Link the component to a product to price it.'))};
    pr.items.push(item);
    if(product){product.itemIds=product.itemIds||[];if(!product.itemIds.includes(item.id))product.itemIds.push(item.id);}
  }
  ws.data.projects.push(pr);touch();return pr;
}
