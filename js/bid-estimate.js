import { catalogItem } from './trim-catalog.js';
import { itemTotals } from './store.js';
import { designPieces, joinedPieces } from './bid-takeoff.js';
import { stockFor, makeCuts, packStock, INCH, FOOT, cents } from './bid-stock.js';

// Editable planning allowances. A project can replace these with its own production and supplier book.
export const DEFAULTS = { rate:85, crew:1, hoursDay:8, contingency:10, overhead:0, profit:0, tax:0,
  spare:1, cap:12*FOOT, stretch:13*FOOT, endTrim:.5*INCH, gap:.5*INCH, allowance:0 };
const fallbackTasks = [
  ['layout','Set out the room','rooms',.5], ['install','Cut and install trim','trim_lf',.065],
  ['joints','Cope inside corners','copes',.12], ['frames','Assemble frames','frames_all',.18],
  ['finish','Fill and finish','trim_lf',.025], ['cleanup','Protect and clean','room_days',.4],
].map(([id,label,per,hours])=>({id,label,per,hours,basis:'Planning allowance'}));
const fallbackSupplies = [{id:'fasteners',product:'Fasteners allowance',per:'trim_lf',per_package:150,price:15},
  {id:'caulk',product:'Caulk allowance',per:'caulk_lf',per_package:48,price:6}];
export function projectTree(projects, id) {
  if (!id) return null;
  const ids = new Set([id]);
  for (let n=0; n<projects.length; n++) {
    const before=ids.size;
    for (const p of projects) if (ids.has(p.parentId)) ids.add(p.id);
    if (ids.size===before) break;
  }
  return ids;
}
const sum = (rows, pick) => rows.reduce((n,r)=>n+pick(r),0);
function add(totals,key,value) { totals[key]=(totals[key] || 0)+value; }
function role(p) {
  return ({baseboard:'base','chair-rail':'chair','wainscot-cap':'cap','picture-frame':'panel','panel-moulding':'panel','board-batten':'batten'})[p.style] || p.style;
}
function measures(pieces,cuts,products) {
  const m={rooms:1, walls:new Set(pieces.map(p=>p.face)).size, pieces:cuts.length};
  const frames=new Set(), raked=new Set();
  for (const p of pieces) {
    const c=products.get(p.product), type=role(c), ft=p.len/FOOT;
    add(m,'trim_lf',ft); add(m,'face_sf',(c.W+c.T)*p.len/.0929); add(m,'caulk_lf',ft*(type==='base'?1:2));
    if (['base','chair','cap','panel'].includes(type)) add(m,(p.style==='stair' && ['base','chair'].includes(type)?'stair_':'')+type+'_lf',ft);
    if (p.kind==='frame') (p.style==='stair'?raked:frames).add(JSON.stringify([p.style==='stair'?p.face:p.section,p.frame]));
    if (p.kind==='batten') add(m,'batten_lf',ft);
    if (p.kind==='rail') add(m,'rail_lf',ft);
  }
  m.frames=frames.size; m.raked=raked.size; m.frames_all=m.frames+m.raked; m.frame_corners=4*m.frames_all;
  m.battens=cuts.filter(c=>c.kind==='batten').length;
  const ends=cuts.flatMap(c=>[c.endA,c.endB]);
  m.copes=ends.filter(e=>e==='inside corner').length;
  m.outside=Math.floor(ends.filter(e=>e==='outside corner').length/2);
  m.scarfs=cuts.filter(c=>c.endA==='scarf').length;
  m.glued_joints=m.outside+m.scarfs;
  m.adhesive_lf=(m.batten_lf || 0)+(m.rail_lf || 0)+(m.cap_lf || 0);
  return m;
}

export function estimate(prop, projects, state = {}) {
  const profile=state.profile || {}, rules={...DEFAULTS,...profile.settings,...state.rules,
    prices:{...profile.prices,...state.prices},offerPrices:state.offerPrices || {},stock:profile.stock || {}};
  const allowed=projectTree(projects,state.project);
  const drawn=designPieces(prop,projects,profile), warnings=new Set(drawn.warnings);
  const roomGroups=new Map(), products=new Map(), sales=new Map();
  for (const p of joinedPieces(drawn.pieces.filter(p=>!allowed || allowed.has(p.project)))) {
    const c=catalogItem(p.product);
    if (!c) { warnings.add('Unknown product on '+p.room); continue; }
    products.set(c.id,c);
    if (!sales.has(c.id)) sales.set(c.id,stockFor(c,rules));
    const key=p.roomKey || p.room;
    if (!roomGroups.has(key)) roomGroups.set(key,{key,name:p.room,parts:[]});
    roomGroups.get(key).parts.push(p);
  }
  const boardOrder=new Map(), house=Object.create(null), rooms=[], allTasks=profile.tasks || fallbackTasks;
  for (const room of roomGroups.values()) {
    const cuts=[], boards=[], lines=new Map();
    for (const piece of room.parts) {
      const stock=sales.get(piece.product);
      const parts=stock ? makeCuts(piece,stock,rules) : [];
      if (!parts.length) warnings.add(room.name+' · Confirm stock and field cut for '+products.get(piece.product).short);
      for (const c of parts) {
        c.mark='R'+(rooms.length+1)+'-'+String(cuts.length+1).padStart(3,'0'); cuts.push(c);
        if (!lines.has(c.product)) lines.set(c.product,[]);
        lines.get(c.product).push(c);
      }
    }
    let material=0;
    for (const [pid,list] of lines) {
      const stock=sales.get(pid), packed=packStock(list,stock,rules);
      const sizes=new Map();
      for (const b of packed) {
        b.product=pid; b.mark='R'+(rooms.length+1)+'-B'+(boards.length+1); boards.push(b);
        const key=[pid,b.length,b.how].join('|');
        const row=sizes.get(key) || {key,product:pid,length:b.length,price:b.price,how:b.how,bundle:stock.bundle,count:0,sku:b.sku};
        row.count++; sizes.set(key,row);
      }
      for (const row of sizes.values()) {
        const qty=Math.ceil(row.count/row.bundle); material+=qty*row.price;
        const order=boardOrder.get(row.key) || {...row,qty:0,spare:0};
        order.qty+=qty; boardOrder.set(row.key,order);
      }
    }
    const m=measures(room.parts,cuts,products);
    const tasks=allTasks.map(t=>({...t,hours:state.production?.[t.id] ?? t.hours}));
    m.room_days=Math.max(1,Math.ceil(sum(tasks,t=>(m[t.per]||0)*t.hours)/6-1e-9));
    const labor=tasks.filter(t=>m[t.per]>0).map(t=>({...t,qty:m[t.per],extended:t.hours*m[t.per]}));
    for (const [key,v] of Object.entries(m)) add(house,key,v);
    for (const r of Object.values(profile.nailing || {})) {
      const n=(m[r.per] || 0)*r.nails_per_lf+(r.per_corner || 0)*m.frame_corners;
      add(house,'nails_'+r.gun,n); add(house,'holes',n);
    }
    rooms.push({...room, cuts, boards, measures:m, labor, hours:sum(labor,t=>t.extended),material});
  }
  const orders=[...boardOrder.values()];
  for (const pid of products.keys()) {
    const lines=orders.filter(o=>o.product===pid);
    const set=lines.filter(o=>o.how==='stock');
    const best=set.length ? set.sort((a,b)=>b.qty-a.qty || b.length-a.length)[0] : lines.sort((a,b)=>b.length-a.length)[0];
    if (best) best.spare=rules.spare;
  }
  const supplies=(profile.supplies || fallbackSupplies).map(s=>{
    const need=(house[s.per] || 0)*(s.factor ?? 1);
    const packs=(need || (s.always && rooms.length)) ? Math.max(s.min ?? 1,s.per_package ? Math.ceil(need/s.per_package-1e-9) : 0) : 0;
    const price=state.supplyPrices?.[s.id] ?? s.price;
    return {...s,need,packs,price,total:packs*price};
  }).filter(s=>s.packs);
  const included=new Set(state.included || []);
  const scope=projects.filter(p=>!allowed || allowed.has(p.id)).flatMap(p=>(p.items || []).map(it=>({
    id:it.id,name:it.name,project:p.name,qty:it.qty??1,unit:it.unit,selected:included.has(it.id),...itemTotals(it)})));
  const hours=sum(rooms,r=>r.hours), material=sum(orders,o=>(o.qty+o.spare)*o.price), consumables=sum(supplies,s=>s.total);
  const scopeCost=sum(scope.filter(s=>s.selected),s=>s.likely);
  const direct=material+consumables+hours*rules.rate+scopeCost+rules.allowance;
  const adjustments={contingency:direct*rules.contingency/100,overhead:direct*rules.overhead/100,profit:direct*rules.profit/100,
    tax:(material+consumables)*rules.tax/100};
  const total=direct+sum(Object.values(adjustments),v=>v);
  const fieldEnds=rooms.flatMap(r=>r.cuts).filter(c=>[c.endA,c.endB].includes('check on site')).length;
  if (fieldEnds) warnings.add(fieldEnds+' pieces have a return to verify on site.');
  return {rooms,orders,supplies,scope,hours,material,consumables,scopeCost,direct,adjustments,total:cents(total),rules,
    labor:hours*rules.rate, days:Math.ceil(hours/(rules.crew*rules.hoursDay)-1e-9), warnings:[...warnings],
    tasks:allTasks, products:Object.fromEntries(products), bookName:profile.name || 'Catalog stock · planning allowances'};
}
