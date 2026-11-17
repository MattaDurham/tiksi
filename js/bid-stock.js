export const INCH = .0254, FOOT = .3048;
const EPS = 1e-8;
export const cents = n => Math.round((n + Number.EPSILON) * 100) / 100;

export function stockFor(product, settings) {
  const desc = product.length || '', match = desc.match(/([\d.]+)\s*(in|ft)\b/i);
  const nominal = match ? Number(match[1]) * (match[2] === 'ft' ? FOOT : INCH) : 0;
  const kit = /^kit for a/.test(desc);
  const bundle = Number((product.priceUnit || '').match(/of (\d+)/)?.[1]) || (kit ? 2 : 1);
  const supplied = settings.stock?.[product.id], price = settings.prices?.[product.id] ?? product.price;
  const valid = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  if (!supplied && (!valid(price) || !nominal || (!kit && /kit|sheet|pre-assembled|tall panel/i.test(desc)))) return null;
  const footSale = supplied ? ['foot','both'].includes(supplied.sold) : product.priceUnit === 'per linear foot';
  const offers = supplied?.lengths?.map(x => ({length:x.in*INCH, price:settings.offerPrices?.[product.id+'@'+x.in] ?? (Math.abs(x.in*INCH-nominal)<EPS && valid(settings.prices?.[product.id]) ? price : x.price), sku:x.item})) ||
    (footSale ? [] : [{length:nominal, price, sku:product.sku}]);
  let lengths = offers.filter(x => x.length > 0 && valid(x.price)).sort((a,b) => a.length-b.length);
  if (lengths.length) lengths = lengths.filter(x => x.length <= settings.stretch+EPS).length ?
    lengths.filter(x => x.length <= settings.stretch+EPS) : lengths.slice(0,1);
  const footPrice = settings.offerPrices?.[product.id+'@foot'] ?? supplied?.per_ft ?? price;
  const maxFoot = footSale && valid(footPrice) ? FOOT*Math.floor(Math.min(settings.stretch, supplied?.max_in ? supplied.max_in*INCH : nominal)/FOOT+EPS) : 0;
  const bases = [...new Set([...lengths.map(x=>x.length), ...(maxFoot ? [Math.min(settings.cap,maxFoot),maxFoot] : [])])].sort((a,b)=>a-b);
  return bases.length ? {lengths, maxFoot, footPrice, bases, bundle, kit, product} : null;
}

function wedge(piece, end, p) {
  if (end === 'scarf' || end === 'outside corner') return p.T;
  if (!/^(miter|plumb)/.test(end)) return 0;
  const degrees = Number(end.match(/[\d.]+/)?.[0] || 45);
  return (piece.kind === 'frame' || end.startsWith('plumb') ? p.W : p.T) / Math.tan(degrees*Math.PI/180);
}

export function makeCuts(piece, stock, settings) {
  const p = stock.product, usable = stock.bases.at(-1)-2*settings.endTrim;
  if (!(usable > 2*INCH && piece.len > 0 && Number.isFinite(piece.len))) return [];
  let count = piece.len <= usable+EPS ? 1 : Math.ceil(piece.len/(usable-INCH));
  if (count > 1 && !['run','rail'].includes(piece.kind)) return [];
  for (; count <= 1000; count++) {
    const cuts = [];
    for (let i=0;i<count;i++) {
      const a = i ? 'scarf' : piece.endA, b = i<count-1 ? 'scarf' : piece.endB;
      const ends = [a,b], length = piece.len/count + ends.reduce((s,e)=>s+(e==='outside corner' ? p.T : e==='scarf' ? p.T/2 : 0),0);
      const use = length + wedge(piece,a,p) + wedge(piece,b,p);
      cuts.push({...piece, endA:a, endB:b, length, use, segment:i+1, segments:count});
    }
    if (cuts.every(c=>c.use <= usable+EPS)) return cuts;
    if (piece.kind !== 'run' && piece.kind !== 'rail') return [];
  }
  return [];
}

function boardChoice(stock, needed) {
  const options = stock.lengths.filter(o=>o.length+EPS >= needed).map(o=>({...o, how:'stock'}));
  const feet = Math.ceil(needed/FOOT-1e-9);
  if (feet*FOOT <= stock.maxFoot+EPS) options.push({length:feet*FOOT, price:cents(feet*stock.footPrice), how:'cut to length'});
  return options.sort((a,b)=>a.price-b.price || a.length-b.length)[0];
}

function fill(cuts, base, stock, rules) {
  const boards = [];
  for (const c of cuts) {
    let bin = boards.find(b=>b.used+rules.gap+c.use <= base-2*rules.endTrim+EPS);
    if (!bin) { bin={cuts:[],used:0}; boards.push(bin); }
    bin.used += (bin.cuts.length ? rules.gap : 0) + c.use;
    bin.cuts.push(c);
  }
  return boards.map(b=>({...b,...boardChoice(stock,b.used+2*rules.endTrim)}));
}

function plans(cuts, stock, rules) {
  const tries = stock.bases.filter(base=>cuts[0].use <= base-2*rules.endTrim+EPS).map(base=>{
    const boards = fill(cuts,base,stock,rules);
    return {boards, cost:cents(boards.reduce((n,b)=>n+b.price,0)), length:boards.reduce((n,b)=>n+b.length,0)};
  });
  return tries.sort((a,b)=>a.cost-b.cost || Math.round((a.length-b.length)*1e6));
}

export function packStock(cuts, stock, rules) {
  const alloc = cuts.filter(c=>!stock.kit || c.kind==='rail').sort((a,b)=>b.use-a.use);
  if (!alloc.length) return [];
  const best = plans(alloc,stock,rules)[0];
  return best.boards.flatMap(b=>{
    if (stock.bundle>1) return [b];
    const cheaper = plans(b.cuts,stock,rules).find(p=>p.boards.length>1 && p.cost<cents(b.price)-.005);
    return cheaper?.boards || [b];
  });
}
