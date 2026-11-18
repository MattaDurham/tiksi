// The boards a job buys, as PRODUCTS records: one record per store item (a moulding's 8 ft and 12 ft
// boards are different items with their own prices and pages; a moulding cut off long stock by the
// foot is one more). A record carries the store's item number, page, price and the date it was seen,
// so PRODUCTS can check the price again; the estimate then prices that board from the record.
//
// Records are matched by `trimStock` ("<catalog id>@<inches>" or "<catalog id>@foot"), kept with the
// property (propertyIds) and made only by ensureBoardProducts, from ESTIMATE.

import { ws } from './store.js';
import { catalogItem } from './trim-catalog.js';
import { ESTIMATE_DATA } from './estimate-data.js';
import { stockInches } from './trim-estimate.js';

const STOCK = (ESTIMATE_DATA.stock && ESTIMATE_DATA.stock.products) || {};
const SEEN_CATALOG = '2026-11-13', SEEN_STOCK = (ESTIMATE_DATA.stock && ESTIMATE_DATA.stock.seen) || SEEN_CATALOG;

// Feet and inches to 1/16": 94.5 -> 7'-10 1/2".
export function feetInches(inches) {
  let n = Math.round(inches * 16), f = Math.floor(n / 192); n -= f * 192;
  const whole = Math.floor(n / 16); let frac = n - whole * 16, den = 16;
  while (frac && frac % 2 === 0) { frac /= 2; den /= 2; }
  return `${f}'-${whole}${frac ? ` ${frac}/${den}` : ''}"`;
}

// Every store item of a catalog moulding: { key, pid, lenIn (null by the foot), how, price, unit, item, url, seen }.
export function storeItems(pid) {
  const c = catalogItem(pid); if (!c) return [];
  const d = STOCK[pid], out = [];
  const lengths = d && (d.sold === 'lengths' || d.sold === 'both') ? d.lengths : [{ in: null, price: c.price, item: c.sku || '', url: c.url || '' }];
  for (const l of lengths) {
    const lenIn = l.in != null ? l.in : null;
    out.push({ key: pid + '@' + (lenIn != null ? lenIn : 'each'), pid, lenIn, how: 'length', price: l.price, unit: 'ea', item: l.item || c.sku || '', url: l.url || c.url || '',
      seen: d ? SEEN_STOCK : SEEN_CATALOG });
  }
  if (d && (d.sold === 'foot' || d.sold === 'both')) out.push({ key: pid + '@foot', pid, lenIn: null, how: 'foot', price: d.per_ft, unit: 'lf', item: d.foot_item || '', url: d.foot_url || '', seen: SEEN_STOCK });
  return out;
}

export const productForKey = key => (ws.data.products || []).find(p => p.trimStock === key) || null;

// The record a board of this moulding and length was bought as (a cut by the foot: the foot item).
export function productForBoard(pid, lenIn, how) {
  const items = storeItems(pid);
  const hit = how === 'foot' ? items.find(i => i.how === 'foot') : items.find(i => i.lenIn != null && Math.abs(i.lenIn - lenIn) < 0.01) || items[0];
  return hit ? { item: hit, record: productForKey(hit.key) } : { item: null, record: null };
}

function recordFor(it, prop) {
  const c = catalogItem(it.pid);
  const len = it.how === 'foot' ? 'cut to length by the foot' : it.lenIn != null ? feetInches(it.lenIn) + ' board' : '';
  return {
    id: 'prod-' + it.key.replace(/[^a-z0-9]+/gi, '-').toLowerCase(),
    name: [c.short, len].filter(Boolean).join(', '), brand: c.brand || '', model: c.model || '', category: 'lumber',
    url: it.url, manufacturerUrl: '', price: it.price, unit: it.unit, imageUrl: '', itemIds: [], documents: [],
    specs: [c.size, c.material, c.finish, c.title].filter(Boolean).join('. '),
    notes: [it.item ? `${c.store}: ${it.item}.` : '', c.evidence || '', (STOCK[it.pid] || {}).evidence || ''].filter(Boolean).join(' '),
    confidence: 'identified', trimStock: it.key, propertyIds: prop ? [prop.id] : [],
    priceSourceUrl: it.url, priceCheckedAt: it.seen,
    priceHistory: [{ price: it.price, unit: it.unit, sourceUrl: it.url, checkedAt: it.seen, how: 'store page, trim research' }],
  };
}

// Make the PRODUCTS records a job's boards are missing, and keep each with the property. Returns
// how many were made.
export function ensureBoardProducts(trim, prop) {
  if (!trim || trim.error) return 0;
  let made = 0;
  for (const b of trim.buy || []) {
    for (const it of storeItems(b.pid)) {
      const used = it.how === 'foot' ? b.lines.some(l => l.how === 'foot') : b.lines.some(l => l.how !== 'foot' && it.lenIn != null && Math.abs(l.lenIn - it.lenIn) < 0.01) || (it.lenIn == null && b.lines.length);
      if (!used) continue;
      const r = productForKey(it.key);
      if (r) { if (prop) { r.propertyIds = Array.isArray(r.propertyIds) ? r.propertyIds : []; if (!r.propertyIds.includes(prop.id)) { r.propertyIds.push(prop.id); made++; } } continue; }
      ws.data.products.push(recordFor(it, prop));
      made++;
    }
  }
  return made;
}

// The store prices PRODUCTS holds for the boards, for the trim math: { stock, priceOverrides } in
// trim-estimate.js's settings shape. A record's price wins over the research data's.
export function boardPrices() {
  const stock = {}, priceOverrides = {};
  const recs = (ws.data.products || []).filter(p => typeof p.trimStock === 'string' && Number(p.price) > 0);
  for (const r of recs) {
    const [pid, at] = r.trimStock.split('@'), c = catalogItem(pid);
    if (!c) continue;
    const d = STOCK[pid];
    if (at === 'foot') { if (d) { stock[pid] = stock[pid] || JSON.parse(JSON.stringify(d)); stock[pid].per_ft = Number(r.price); } continue; }
    const lenIn = Number(at);
    if (d && Array.isArray(d.lengths)) {
      stock[pid] = stock[pid] || JSON.parse(JSON.stringify(d));
      for (const l of stock[pid].lengths) if (Math.abs(l.in - lenIn) < 0.01) l.price = Number(r.price);
    }
    // The catalog's own board (the length its price is for) is priced from the catalog entry.
    const own = stockInches(c);
    if (at === 'each' || (own != null && Math.abs(own - lenIn) < 0.01)) priceOverrides[pid] = { price: Number(r.price), seen: r.priceCheckedAt || '', note: 'PRODUCTS' };
  }
  return { stock, priceOverrides };
}
