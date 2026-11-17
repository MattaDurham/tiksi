import {catalogItem} from './trim-catalog.js';
export const INPUTS = [
  ['rate','Hourly rate','$ / h',0,10000],['crew','Crew size','people',1,100,true],['hoursDay','Working day','h / person',.25,24],
  ['spare','Spare stock','per product',0,100,true],['allowance','Job allowance','$',0,1e8],
  ['contingency','Contingency','%',0,100],['overhead','Overhead','%',0,100],['profit','Profit markup','%',0,100],['tax','Tax on purchases','%',0,100],
];
export function checkNumber(v,min,max,integer=false) {
  if (typeof v!=='number' || !Number.isFinite(v) || v<min || v>max || (integer && !Number.isInteger(v))) throw new Error('Enter a number from '+min+' to '+max+'.');
  return v;
}
export function readProfile(p,id) {
  const obj=x=>x && typeof x==='object' && !Array.isArray(x);
  const list=(v,limit)=>{if (!Array.isArray(v)||v.length>limit) throw new Error('Invalid rate book list.');return v;};
  const text=v=>{if (typeof v!=='string' || !v.trim() || v.length>1000) throw new Error('Missing or invalid name in rate book.');};
  const validKey=v=>{text(v);if (['__proto__','prototype','constructor'].includes(v)) throw new Error('Invalid record key.');};
  if (p?.format!=='tiksi-bid-profile/1' || (p.propertyId && p.propertyId!==id)) throw new Error('Choose a Bid Studio profile for this property.');
  text(p.name);
  if (!obj(p.settings)||!obj(p.prices)||!obj(p.stock)||!obj(p.nailing)) throw new Error('Incomplete rate book.');
  for (const [key,v] of Object.entries(p.settings)) {
    const spec=INPUTS.find(d=>d[0]===key);
    if (!spec) throw new Error('Unrecognized estimate setting.');
    checkNumber(v,spec[3],spec[4],spec[5]);
  }
  for (const [k,v] of Object.entries(p.prices)) { validKey(k);checkNumber(v,0,1e8); }
  for (const [k,s] of Object.entries(p.stock)) {
    validKey(k);
    if (!['both','lengths','foot'].includes(s.sold)) throw new Error('Invalid stock selling unit.');
    if (s.sold!=='foot') for (const l of list(s.lengths,200)) { checkNumber(l.in,2,1200);checkNumber(l.price,0,1e8); }
    if (s.sold!=='lengths') { checkNumber(s.max_in,2,1200);checkNumber(s.per_ft,0,1e8); }
  }
  for (const t of list(p.tasks,500)) {validKey(t.id);validKey(t.per);text(t.label);checkNumber(t.hours,0,10000);}
  for (const s of list(p.supplies,500)) {validKey(s.id);validKey(s.per);text(s.product);checkNumber(s.per_package,0,1e8);checkNumber(s.price,0,1e8);checkNumber(s.factor??1,0,1e8);checkNumber(s.min??1,0,1e6,true);}
  for (const r of Object.values(p.nailing)) {validKey(r.gun);validKey(r.per);checkNumber(r.nails_per_lf,0,1000);checkNumber(r.per_corner??0,0,1000);}
  for (const r of list(p.rooms,5000)) {text(r.name);text(r.subproject);}
  for (const s of list(p.supplement,20000)) {
    if (s.style!=='stair' || !catalogItem(s.product)) throw new Error('Unknown supplemental piece.');
    for (const k of ['endA','endB','room','section','face']) text(s[k]);
    checkNumber(s.len,.0001,1000);
    if (s.pA || s.pB) throw new Error('Supplemental pieces require explicit ends.');
  }
  return p;
}
