// Measured mesh surface areas, explicitly scoped to mapped finish slots. No waste,
// labour, assembly inference or product equivalence is silently added.
import * as THREE from 'three';
import { ws, uid, touch, isoToday, materialById } from './store.js';
import { modelMaterialSlots } from './model-materials.js';

export function modelTakeoff(root) {
  const slots=modelMaterialSlots(root),lookup=new Map(slots.map(s=>[s.material,s])),areas=new Map(slots.map(s=>[s.key,0]));
  root.updateMatrixWorld(true);
  root.traverse(o=>{
    if(!o.isMesh||o.userData.pickBox)return;
    const g=o.geometry,p=g.getAttribute('position'),index=g.index;
    if(!p)return;
    const materials=o.userData.sourceMaterials;
    const groups=g.groups.length?g.groups:[{start:0,count:index?.count||p.count,materialIndex:0}];
    for(const group of groups){
      const slot=lookup.get(materials[group.materialIndex||0]);if(!slot)continue;
      let area=0;
      const end=Math.min(group.start+group.count,g.drawRange.start+g.drawRange.count,index?.count||p.count);
      for(let i=Math.max(group.start,g.drawRange.start);i+2<end;i+=3){
        const vertices=[0,1,2].map(k=>new THREE.Vector3().fromBufferAttribute(p,index?index.getX(i+k):i+k).applyMatrix4(o.matrixWorld));
        area+=vertices[1].sub(vertices[0]).cross(vertices[2].sub(vertices[0])).length()/2;
      }
      areas.set(slot.key,areas.get(slot.key)+area);
    }
  });
  return slots.map(s=>({...s,areaM2:areas.get(s.key)}));
}
export function createModelEstimate(prop,scan,root) {
  const takeoff=modelTakeoff(root).filter(s=>(scan.materialBindings?.[s.key] || scan.materialIdentities?.[s.key]) && s.areaM2>0);
  if(!takeoff.length)throw new Error('Map at least one finish surface to a Tiksi material first.');
  const existing=ws.data.projects.find(p=>p.modelTakeoffId===scan.id);
  if(existing)throw new Error('A takeoff already exists for this model. Edit it in Scope, or delete it before regenerating.');
  const pr={id:uid('proj'),propertyId:prop.id,name:'Model finishes — '+scan.name,category:'interior',status:'idea',selected:true,startDate:isoToday(),notes:'Measured triangle surface area. Review finish coverage, openings, overlap, waste, labour and current product prices before ordering.',modelTakeoffId:scan.id,items:[]};
  for(const slot of takeoff){
    const mat=materialById(scan.materialBindings?.[slot.key] || scan.materialIdentities?.[slot.key]),qty=slot.areaM2/.09290304;
    const products=ws.data.products.filter(p=>p.materialIds?.includes(mat.id));
    const priced=products.filter(p=>['sf','sq ft','ft2'].includes(String(p.unit).toLowerCase())&&Number.isFinite(p.price)&&p.price>=0);
    const price=priced.length===1?priced[0].price:0;
    const item={id:uid('it'),name:mat.name+' — '+slot.name,qty,unit:'sf',low:price,likely:price,high:price,durationDays:0,deps:[],elementIds:[scan.id],materialId:mat.id,
      modelSurface:{scanId:scan.id,slot:slot.key,areaM2:slot.areaM2},notes:price?'Uses saved '+priced[0].name+' price per sf. Verify quote; labour/waste excluded.':'Price required. No unique saved product price per sf; use product sourcing to select a quote.'};
    pr.items.push(item);
    if(priced.length===1){priced[0].itemIds=priced[0].itemIds||[];if(!priced[0].itemIds.includes(item.id))priced[0].itemIds.push(item.id);}
  }
  ws.data.projects.push(pr);touch();return pr;
}
