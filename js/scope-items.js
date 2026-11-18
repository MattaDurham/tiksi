// Scope items, edited where they are priced (ESTIMATE): a row per item in its room, and the item's
// full record in the detail column: what is done and how well (the price book's work and finish
// level), the measured quantity it counts, its status and notes, what it starts after, and what it
// is linked to (rooms and walls in the model, products, site photos).
//
// An item: { id, name, qty, unit, low, likely, high (each, before qty), durationDays, deps,
// elementIds, notes, status, doneAt, work?, takeoff? }.

import {
  ws, uid, escapeHtml as esc, fmtMoney, readMoney, activeProperty, elementInfo, fmtLen, fmtArea, isoToday, roomsOn, wallsOn, ITEM_STATUSES,
} from './store.js';
import { fixtureLabel } from './fixtures.js';
import { keepRemoved } from './recovery.js';
import {
  takeoffItem, setWork, useMeasure, priceEdited, priceNote, costAreaFor, worksForItem, workById, measureIds, MEASURES, LEVELS,
} from './scope-takeoff.js';

export const ITEM_LABEL = { todo: 'To do', ordered: 'Ordered', 'in-progress': 'In progress', done: 'Done' };

export function newItem(fields = {}) {
  return { id: uid('it'), name: 'New item', qty: 1, unit: 'ls', low: 0, likely: 0, high: 0, durationDays: 0, deps: [], elementIds: [], notes: '', status: 'todo', doneAt: '', ...fields };
}

const propOf = p => ws.data.properties.find(x => x.id === p.propertyId) || activeProperty();
export const productsFor = it => ws.data.products.filter(pr => (pr.itemIds || []).includes(it.id));

// Site photos for an item: tagged with it, or with a room or wall it rebuilds.
export function sitePhotosFor(item) {
  const elIds = new Set(item.elementIds || []), out = [];
  for (const p of ws.data.properties) for (const ph of p.photos || [])
    if ((ph.itemIds || []).includes(item.id) || (ph.roomId && elIds.has(ph.roomId)) || (ph.elementIds || []).some(id => elIds.has(id))) out.push(ph);
  return out;
}

// A linked model element as a label and the address that opens it in MODEL.
export function elementLink(p, id) {
  const prop = propOf(p);
  if (!prop) return { label: 'Missing element', href: '' };
  const multi = prop.levels.length > 1, info = elementInfo(prop.id, id), at = '#/model?select=' + encodeURIComponent(id);
  if (info) return info.kind === 'room' ? { label: info.label + ' · ' + fmtArea(info.area) + (multi ? ' · ' + info.level : ''), href: at }
    : { label: 'Wall · ' + fmtLen(info.length) + (multi ? ' · ' + info.level : ''), href: at };
  const o = (prop.openings || []).find(x => x.id === id);
  if (o) return { label: (o.type === 'window' ? 'Window' : 'Door') + ' · ' + fmtLen(o.width), href: at };
  const sc = (prop.scans || []).find(x => x.id === id);
  if (sc) return { label: 'Scan · ' + sc.name, href: at };
  const fx = (prop.fixtures || []).find(x => x.id === id);
  if (fx) return { label: 'Fixture · ' + fixtureLabel(fx), href: at };
  return { label: 'Missing element', href: '' };
}

// What is being done (the price book's work), how well, and which measured quantity it counts.
const WORK_GROUPS = [['wall', 'Walls'], ['ceiling', 'Ceilings'], ['floor', 'Floors'], ['baseboard', 'Trim'], ['perimeter', 'Trim'],
  ['door', 'Doors'], ['window', 'Windows'], ['cabinet', 'Cabinets'], ['cabinet-run', 'Cabinets'], ['counter', 'Counters'], ['fixture', 'Electrical'], ['object', 'Other']];
const ORDER = ['Walls', 'Drywall', 'Ceilings', 'Floors', 'Trim', 'Doors', 'Windows', 'Cabinets', 'Counters', 'Lighting', 'Electrical', 'Plumbing', 'Permits', 'Other'];
const qtyText = (v, unit) => (unit === 'ea' ? String(Math.round(v)) : Number(v).toLocaleString(undefined, { maximumFractionDigits: 1 })) + ' ' + unit;
export function workHtml(it) {
  const works = worksForItem(it), cur = it.work && workById(it.work.id), groups = new Map();
  for (const w of works) {
    const g = w.group || (WORK_GROUPS.find(([k]) => k === w.applies[0]) || [0, 'Other'])[1];
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(w);
  }
  const rank = g => (ORDER.indexOf(g) + 1) || ORDER.length;
  const ms = it.takeoff ? measureIds(it.takeoff) : [];
  // The price book is offered while it can help: an item measured from the model, priced from the
  // book already, or not priced yet. An item priced by hand needs nothing more under its name.
  if (!works.length && !ms.length) return '';
  if (!cur && !it.takeoff && Number(it.likely) > 0) return '';
  return `<div class="si-work">
    <select data-si-work aria-label="Work: what is being done, priced from the price book">${cur ? '' : `<option value="">${it.takeoff ? 'Pick the work…' : 'Price from the book…'}</option>`}${[...groups].sort((a, b) => rank(a[0]) - rank(b[0])).map(([g, list]) => `<optgroup label="${esc(g)}">${list.map(w => `<option value="${esc(w.id)}" ${cur === w ? 'selected' : ''}>${esc(w.label + ' (per ' + w.unit + ')')}</option>`).join('')}</optgroup>`).join('')}</select>
    ${cur ? `<select data-si-level aria-label="Finish level">${LEVELS.map(([k, l]) => `<option value="${k}" ${it.work.level === k ? 'selected' : ''}>${l}</option>`).join('')}</select>` : ''}
    ${ms.length ? `<select data-si-measure aria-label="Quantity measured">${ms.map(m => `<option value="${m}" ${it.takeoff.measure === m ? 'selected' : ''}>${esc(MEASURES[m].label + ' · ' + qtyText(it.takeoff.measures[m], MEASURES[m].unit))}</option>`).join('')}</select>` : ''}
    ${cur && !it.work.book ? '<span class="note">price typed by hand</span>' : ''}</div>`;
}

// The item's row: name (and its work), quantity, unit, prices each, the line's likely total, days.
export function itemRowHtml(it, problem) {
  const q = it.qty ?? 1, id = esc(it.id), done = it.status === 'done';
  const money = (k, ph) => `<input class="es-cell wide" type="text" inputmode="decimal" data-si-money="${k}" value="${it[k] ? fmtMoney(it[k]) : ''}" placeholder="${ph}" aria-label="${esc(it.name || 'Item')}: ${k} price each">`;
  return `<tr data-si="${id}" class="${done ? 'si-done' : ''}">
    <td class="si-name"><input class="es-cell text" type="text" data-si-f="name" value="${esc(it.name || '')}" aria-label="Item"><a class="si-more" role="button" tabindex="0" data-d="item:${id}" title="Status, notes, what it starts after, and its links">${esc(itemLinksText(it))} ›</a>${workHtml(it)}</td>
    <td class="num"><input class="es-cell narrow" type="number" min="0" step="any" inputmode="decimal" data-si-f="qty" value="${q}" aria-label="${esc(it.name || 'Item')}: quantity"></td>
    <td><input class="es-cell unit" type="text" data-si-f="unit" value="${esc(it.unit || 'ls')}" aria-label="${esc(it.name || 'Item')}: unit"></td>
    <td class="num">${money('low', '–')}</td><td class="num">${money('likely', 'no price')}</td><td class="num">${money('high', '–')}</td>
    <td class="num"><b>${it.likely ? '$' + Math.round((it.likely || 0) * q).toLocaleString('en-US') : ''}</b></td>
    <td class="num"><input class="es-cell narrow" type="number" min="0" step="1" data-si-f="durationDays" value="${it.durationDays || 0}" aria-label="${esc(it.name || 'Item')}: working days"></td>
    <td><button type="button" class="row-del" data-si-del="${id}" title="Remove ${esc(it.name || 'item')}" aria-label="Remove ${esc(it.name || 'item')}">×</button></td></tr>
    ${problem && problem.id === it.id ? `<tr><td colspan="9" role="alert" class="bad" data-money-problem>${esc(problem.text)}</td></tr>` : ''}`;
}
export const ITEM_HEAD = '<thead><tr><th>Item</th><th class="num">Qty</th><th>Unit</th><th class="num">Low each</th><th class="num">Likely each</th><th class="num">High each</th><th class="num">Likely</th><th class="num">Days</th><th></th></tr></thead>';

function itemLinksText(it) {
  const bits = [];
  if (it.status && it.status !== 'todo') bits.push(ITEM_LABEL[it.status] || it.status);
  const els = (it.elementIds || []).length, prods = productsFor(it).length, photos = sitePhotosFor(it).length;
  if (els) bits.push(els + (els === 1 ? ' element' : ' elements'));
  if (prods) bits.push(prods + (prods === 1 ? ' product' : ' products'));
  if (photos) bits.push(photos + (photos === 1 ? ' photo' : ' photos'));
  if (it.notes) bits.push('notes');
  return bits.join(' · ') || 'details';
}

// The item's row edits. `done(problem)` redraws; a price that cannot be read keeps its old price
// and says why.
export function bindItemRow(tr, project, it, done) {
  const area = costAreaFor(project, propOf(project));
  tr.querySelectorAll('[data-si-f]').forEach(i => i.onchange = () => {
    const f = i.dataset.siF;
    if (f === 'qty' || f === 'durationDays') { const v = Number(i.value); if (!(v >= 0)) return done(); it[f] = v; }
    else it[f] = i.value.trim() || (f === 'name' ? 'Item' : 'ls');
    done();
  });
  tr.querySelectorAll('[data-si-money]').forEach(i => i.onchange = () => {
    const k = i.dataset.siMoney, r = readMoney(i.value);
    if (Number.isNaN(r.value)) return done({ id: it.id, text: `${r.error} The ${k} price of ${it.name || 'this item'} is still ${it[k] ? fmtMoney(it[k]) : 'blank'}.` });
    it[k] = r.value; priceEdited(it); done();
  });
  const work = tr.querySelector('[data-si-work]');
  if (work) work.onchange = () => { if (work.value && setWork(it, { work: work.value }, area)) done(); };
  const level = tr.querySelector('[data-si-level]');
  if (level) level.onchange = () => { if (setWork(it, { level: level.value }, area)) done(); };
  const measure = tr.querySelector('[data-si-measure]');
  if (measure) measure.onchange = () => { if (useMeasure(it, measure.value)) done(); };
}

// Remove an item (kept in REMOVED RECORDS); anything set to start after it no longer waits.
export function removeItem(project, it, tree) {
  keepRemoved(propOf(project), 'item', [it], project.id);
  project.items = project.items.filter(x => x !== it);
  for (const x of tree || [project]) for (const i of x.items || []) i.deps = (i.deps || []).filter(d => d !== it.id);
}

// A thing measured in the model (right-click in MODEL BESIDE) as a new item of `project`.
export function addMeasured(project, measured) {
  const item = takeoffItem(measured, project, { uid, today: isoToday(), area: costAreaFor(project, propOf(project)) });
  project.items.push(item);
  return item;
}

// The item's record in the detail column. `rows` are the job's schedule lines it can start after.
export function itemDetailHtml(project, it, rows) {
  const prop = propOf(project), linked = new Set(it.elementIds || []);
  const chip = (link, attr, id) => `<span class="link-chip">${link.href ? `<a href="${esc(link.href)}">${esc(link.label)}</a>` : esc(link.label)}<button type="button" ${attr}="${esc(id)}" aria-label="Unlink ${esc(link.label)}">×</button></span>`;
  let elOpts = '';
  if (prop) for (const l of prop.levels) {
    const where = prop.levels.length > 1 ? ' · ' + l.name : '';
    const rooms = roomsOn(prop, l.id).filter(r => !linked.has(r.id)).map(r => `<option value="${esc(r.id)}">${esc((r.name || 'Room') + ' · ' + fmtArea(elementInfo(prop.id, r.id).area))}</option>`).join('');
    const walls = wallsOn(prop, l.id).filter(w => !linked.has(w.id)).map(w => `<option value="${esc(w.id)}">${esc('Wall · ' + fmtLen(Math.hypot(w.bx - w.ax, w.by - w.ay)))}</option>`).join('');
    if (rooms) elOpts += `<optgroup label="${esc('Rooms' + where)}">${rooms}</optgroup>`;
    if (walls) elOpts += `<optgroup label="${esc('Walls' + where)}">${walls}</optgroup>`;
  }
  const prods = productsFor(it), photos = sitePhotosFor(it), n = priceNote(it), t = it.takeoff;
  const after = (it.deps || [])[0] || '';
  return `<div class="si-det">
    <label>Status <select data-sid-status>${ITEM_STATUSES.map(s => `<option value="${s}" ${s === (it.status || 'todo') ? 'selected' : ''}>${ITEM_LABEL[s]}</option>`).join('')}</select></label>
    <label>Starts after <select data-sid-after><option value="">The start of the project</option>${rows.filter(r => r.id !== it.id).map(r => `<option value="${esc(r.id)}" ${after === r.id ? 'selected' : ''}>${esc(r.kind === 'trim' ? r.name + ' trim' : r.name)}</option>`).join('')}</select></label>
    <label>Notes <textarea data-sid-notes rows="3" placeholder="How it was measured, what to check, who quoted it">${esc(it.notes || '')}</textarea></label>
    <h4>In the model</h4><div class="chips">${(it.elementIds || []).map(id => chip(elementLink(project, id), 'data-sid-unel', id)).join('') || '<span class="note">Not linked</span>'}</div>
    ${elOpts ? `<select data-sid-el aria-label="Link a room or wall"><option value="">+ Link a room or wall</option>${elOpts}</select>` : ''}
    <h4>Products</h4><div class="chips">${prods.map(pr => chip({ label: pr.name + (pr.price ? ' · ' + fmtMoney(pr.price) + '/' + (pr.unit || 'ea') : ''), href: '#/products?select=' + encodeURIComponent(pr.id) }, 'data-sid-unprod', pr.id)).join('') || '<span class="note">None</span>'}</div>
    <select data-sid-prod aria-label="Link a product"><option value="">+ Link a product</option>${ws.data.products.filter(pr => !prods.includes(pr)).map(pr => `<option value="${esc(pr.id)}">${esc(pr.name + (pr.brand ? ' · ' + pr.brand : ''))}</option>`).join('')}</select>
    <h4>Photos</h4><div class="si-photos">${photos.map(ph => `<a href="#/photos?select=${encodeURIComponent(ph.id)}" title="${esc(ph.name || 'Photo')}">${ph.thumb ? `<img src="${esc(ph.thumb)}" alt="${esc(ph.name || 'Photo')}">` : esc(ph.name || 'Photo')}</a>`).join('') || '<span class="note">No photo shows it. Link one in PHOTOS, or link a room or wall it shows.</span>'}</div>
    ${t ? `<h4>Measured${t.measuredAt ? ' ' + esc(t.measuredAt) : ''}</h4><p class="note">${measureIds(t).map(m => `${esc(MEASURES[m].label)} ${esc(qtyText(t.measures[m], MEASURES[m].unit))}`).join(' · ')}</p>` : ''}
    ${n ? `<h4>Price · ${esc(n.level)}</h4>${n.what ? `<p>${esc(n.what)}</p>` : ''}${n.material ? `<p class="note">Placeholder material: ${n.materialUrl ? `<a href="${esc(n.materialUrl)}" target="_blank" rel="noopener">${esc(n.material)}</a>` : esc(n.material)}. FIND A PRODUCT replaces it with the one you choose.</p>` : ''}<p class="note">${esc(n.basis)}${n.sources.length ? ' Sources: ' + n.sources.slice(0, 3).map((u, i) => `<a href="${esc(u)}" target="_blank" rel="noopener">${i + 1}</a>`).join(', ') + '.' : ''}</p>` : ''}
    <p class="si-acts"><a class="btn small" href="#/sheets?item=${encodeURIComponent(it.id)}">CUT SHEET</a><button type="button" class="btn small" data-sid-research>FIND A PRODUCT</button></p></div>`;
}

export function bindItemDetail(body, project, it, done) {
  const q = s => body.querySelector(s);
  q('[data-sid-status]').onchange = e => { it.status = e.target.value; it.doneAt = it.status === 'done' ? (it.doneAt || isoToday()) : ''; done(); };
  q('[data-sid-after]').onchange = e => { it.deps = e.target.value ? [e.target.value] : []; done(); };
  q('[data-sid-notes]').onchange = e => { it.notes = e.target.value; done(); };
  const el = q('[data-sid-el]');
  if (el) el.onchange = () => { if (el.value) { it.elementIds = [...(it.elementIds || []), el.value]; done(); } };
  body.querySelectorAll('[data-sid-unel]').forEach(b => b.onclick = () => { it.elementIds = (it.elementIds || []).filter(x => x !== b.dataset.sidUnel); done(); });
  const prod = q('[data-sid-prod]');
  if (prod) prod.onchange = () => { const pr = ws.data.products.find(x => x.id === prod.value); if (pr) { pr.itemIds = [...new Set([...(pr.itemIds || []), it.id])]; done(); } };
  body.querySelectorAll('[data-sid-unprod]').forEach(b => b.onclick = () => { const pr = ws.data.products.find(x => x.id === b.dataset.sidUnprod); if (pr) pr.itemIds = (pr.itemIds || []).filter(x => x !== it.id); done(); });
  q('[data-sid-research]').onclick = async () => {
    const { openResearch } = await import('./research.js');
    openResearch({ kind: 'scope-item', id: it.id, name: it.name, propertyId: project.propertyId, itemIds: [it.id] });
  };
}
