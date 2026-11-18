// The estimate as a deep dive: the reading column's sections and what opens in the detail column
// when anything in them is clicked. Pure: HTML strings from the estimate (estimate.js) and the
// formatting it is given, so ESTIMATE (estimate-view.js) shows it live and the deep dive file
// (estimate-export.js) carries the same pages and details.
//
// Every clickable thing carries data-d="<kind>:<id>": piece (a mark), stick (a store piece, as the cut diagrams call it),
// wall, room, task (a labor task), supply, product (a buy-list moulding), item (a scope item),
// part (a project or subproject), option (a priced option), cost (a line of the price build-up),
// bid (a bid received). detailFor(key) gives what the detail column shows for it.

import { elevationSvg, cutsHtml } from './trim-drawings.js';
import { catalogItem } from './trim-catalog.js';
import { LABOR, SUPPLIES, OPTIONS } from './estimate-data.js';

const IN = 0.0254;
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const money2 = v => (v < 0 ? '-' : '') + '$' + Math.abs(Number(v) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const hrs = v => (Math.round((Number(v) || 0) * 10) / 10).toFixed(1);
const pct = v => (Math.round((Number(v) || 0) * 1000) / 10).toString().replace(/\.0$/, '') + '%';
const L = (f, k) => '<a class="dl" data-d="' + esc(k) + '">' + f + '</a>';
const kv = rows => '<dl class="kv">' + rows.filter(r => r && r[1] != null && r[1] !== '').map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('') + '</dl>';
const sec = (title, html) => html ? `<div class="d-sec"><h4>${esc(title)}</h4>${html}</div>` : '';
const list = items => { items = items.filter(Boolean); return items.length ? '<ul>' + items.map(x => '<li>' + x + '</li>').join('') + '</ul>' : ''; };
const link = (url, text) => /^https?:\/\//i.test(String(url || '')) ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(text || url)}</a>` : esc(text || '');
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : (many || one + 's'));
const ROLE_NAME = { base: 'Baseboard', chair: 'Chair rail', cap: 'Wainscot cap', panel: 'Panel moulding', batten: 'Batten', shaker: 'Shaker kit', raked: 'Raked panel' };

// What the report needs besides the estimate: { est (projectEstimate), prop, len(m) -> text,
// money(v) -> text, date, propertyName, live (true in the app) }.
export function reportModel(ctx) {
  const { est } = ctx;
  const t = est && est.trim && !est.trim.error ? est.trim : null;
  const roomsArr = t ? (t.rooms || []) : [];
  const product = id => (t && t.catalog && t.catalog[id]) || catalogItem(id) || { id, short: id };
  const task = id => (t && t.labor && t.labor.taskById && t.labor.taskById[id]) || (LABOR.tasks || []).find(x => x.id === id) || { id, label: id, unit: '', hours: 0 };
  const lenIn = inches => ctx.len(inches * IN);
  return { ...ctx, t, rooms: roomsArr, product, task, lenIn };
}

// ---------- the reading column ----------

// The sections in order: [{ id, nav, group, html, subs: [{id, nav}] }]
export function reportSections(M) {
  const out = [];
  out.push({ id: 'est-summary', nav: 'Summary', group: 'Overview', html: summaryHtml(M) });
  out.push({ id: 'est-buildup', nav: 'Price build-up', group: 'Overview', html: buildupHtml(M) });
  out.push({ id: 'est-parts', nav: 'By room and subproject', group: 'Overview', html: partsHtml(M) });
  if (M.t) {
    out.push({ id: 'est-rooms', nav: 'Rooms, walls and cuts', group: 'Trim from the drawing', html: roomsHtml(M),
      subs: M.rooms.map(r => ({ id: 'est-room-' + slug(r.name), nav: r.name })) });
    out.push({ id: 'est-buy', nav: 'Buy list', group: 'Trim from the drawing', html: buyHtml(M) });
    out.push({ id: 'est-labor', nav: 'Labor hours', group: 'Trim from the drawing', html: laborHtml(M) });
    out.push({ id: 'est-supplies', nav: 'Supplies and tools', group: 'Trim from the drawing', html: suppliesHtml(M) });
    if ((M.t.scenarios || []).length) out.push({ id: 'est-options', nav: 'Options', group: 'Trim from the drawing', html: optionsHtml(M) });
  }
  out.push({ id: 'est-items', nav: 'Scope items', group: 'Scope', html: itemsHtml(M) });
  out.push({ id: 'est-bids', nav: 'Bids and sign-off', group: 'Scope', html: bidsHtml(M) });
  out.push({ id: 'est-sources', nav: 'Sources and assumptions', group: 'Sources', html: sourcesHtml(M) });
  return out;
}
export const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'x';

function figs(rows) {
  return '<div class="figs">' + rows.filter(Boolean).map(([v, l, d]) => `<div ${d ? `data-d="${esc(d)}"` : ''}><b>${v}</b><span>${esc(l)}</span></div>`).join('') + '</div>';
}

function summaryHtml(M) {
  const { est, t } = M, s = est.settings;
  const n = (t && (t.pieces || []).length) || 0;
  const order = t ? (t.buy || []).reduce((a, b) => a + (b.order || 0), 0) : 0;
  const what = [];
  if (t) what.push(`${plural(M.rooms.length, 'room')} of drawn trim: ${plural(n, 'piece')} cut from ${plural(order, 'store piece')}, ${hrs(est.hours.likely)} carpenter hours at ${M.money(s.laborRate)}/hr`);
  const items = est.tree.reduce((a, p) => a + (p.items || []).length, 0) - est.covered.length;
  if (items) what.push(plural(items, 'scope item') + ' priced in PROJECTS');
  const range = est.total.low !== est.total.high ? `${M.money(est.total.low)} to ${M.money(est.total.high)}` : '';
  return `<div class="sec-head"><div class="eyebrow">Estimate · ${esc(M.propertyName || '')}${M.date ? ' · ' + esc(M.date) : ''}</div>
    <h1>${esc(est.root.name || 'Project')}</h1>
    <p class="lede">${what.length ? esc(what.join('; ')) + '.' : 'Nothing is priced yet: draw trim for this project in MODEL, or add scope items in PROJECTS.'}
    ${t ? ' The trim is worked out from the drawing: change a section in MODEL and every number here follows.' : ''}</p></div>
    ${figs([
      [M.money(est.total.likely), 'total, likely' + (range ? ' (' + range + ')' : ''), 'cost:total'],
      t && [hrs(est.hours.likely), `carpenter hours (${hrs(est.hours.low)} to ${hrs(est.hours.high)})`, 'cost:labor'],
      t && [String(order), 'store pieces to order', 'cost:moulding'],
      t && [String(n), 'pieces to cut', 'cost:moulding'],
      t && [String(est.days), 'working days, one carpenter', 'cost:days'],
    ])}
    ${est.trim && est.trim.error ? `<div class="callout bad"><b>The drawn trim could not be worked out</b> ${esc(est.trim.error)}</div>` : ''}
    ${est.covered.length ? `<div class="callout warn"><b>${plural(est.covered.length, 'scope item')} counted twice before</b> ${esc(est.covered.length === 1 ? 'An item lists only drawn trim sections of this project: the drawn trim prices them now, so it is left out of the total.' : 'These items list only drawn trim sections of this project: the drawn trim prices them now, so they are left out of the total.')} ${L('See them', 'cost:covered')}</div>` : ''}`;
}

const BUILD = [
  ['items', 'Scope items', 'Priced in PROJECTS: installed prices, each with its low, likely and high.'],
  ['moulding', 'Trim boards', 'Every board bought at the cheapest store length that holds its cuts, each room cut from its own boards, plus the spares.'],
  ['supplies', 'Supplies', 'Nails, glue, adhesive, caulk, filler, sandpaper, primer, paint and protection, counted from the job measures.'],
  ['labor', 'Labor', 'Hours from published production rates, task by task, room by room, at the hourly rate.'],
];
function buildupHtml(M) {
  const { est, t } = M, s = est.settings;
  const trimT = t ? t.totals || {} : {};
  const lab = { low: est.hours.low * s.laborRate, likely: est.hours.likely * s.laborRate, high: est.hours.high * s.laborRate };
  const rows = [];
  const row = (key, label, a, note) => rows.push(`<tr data-d="cost:${key}"><td><b>${esc(label)}</b>${note ? `<div class="small muted">${esc(note)}</div>` : ''}</td><td class="num">${M.money(a.low)}</td><td class="num"><b>${M.money(a.likely)}</b></td><td class="num">${M.money(a.high)}</td></tr>`);
  const one = v => ({ low: v, likely: v, high: v });
  if (est.items.likely || est.items.high || !t) row('items', 'Scope items', est.items);
  if (t) {
    row('moulding', 'Trim boards', one(trimT.moulding || 0), `${(t.buy || []).reduce((a, b) => a + (b.order || 0), 0)} store pieces`);
    row('supplies', 'Supplies', one(trimT.supplies || 0));
    row('labor', 'Labor', lab, `${hrs(est.hours.likely)} hrs × ${M.money(s.laborRate)}/hr`);
  }
  rows.push(`<tr class="total-row"><td>Cost</td><td class="num">${M.money(est.subtotal.low)}</td><td class="num">${M.money(est.subtotal.likely)}</td><td class="num">${M.money(est.subtotal.high)}</td></tr>`);
  if (s.contingency) row('contingency', `Contingency, ${pct(s.contingency)}`, est.contingency);
  if (s.overhead) row('overhead', `Overhead, ${pct(s.overhead)}`, est.overhead);
  if (s.profit) row('profit', `Profit, ${pct(s.profit)}`, est.profit);
  if (s.taxRate) row('tax', `Sales tax on materials, ${pct(s.taxRate)}`, one(est.tax), `on ${M.money(est.materials)} of trim boards and supplies`);
  rows.push(`<tr class="total-row" data-d="cost:total"><td>Total</td><td class="num">${M.money(est.total.low)}</td><td class="num">${M.money(est.total.likely)}</td><td class="num">${M.money(est.total.high)}</td></tr>`);
  const inputs = M.live ? settingsForm(M) : `<p class="note">Rate ${M.money(s.laborRate)}/hr · contingency ${pct(s.contingency)} · overhead ${pct(s.overhead)} · profit ${pct(s.profit)} · tax on materials ${pct(s.taxRate)} · ${plural(s.sparePerMoulding, 'spare board')} of each moulding.</p>`;
  return `<div class="sec-head"><div class="eyebrow">How the total is built</div><h2>Price build-up</h2>
    <p class="lede">Low and high carry each scope item's range and the labor rates' low and high hours; boards and supplies are priced once.</p></div>
    ${inputs}
    <div class="tbl"><table class="grid"><thead><tr><th>Line</th><th class="num">Low</th><th class="num">Likely</th><th class="num">High</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}
function settingsForm(M) {
  const s = M.est.settings;
  const f = (key, label, value, unit, step) => `<label class="est-in"><span>${esc(label)}</span><span class="est-in-v"><input type="number" inputmode="decimal" data-set="${key}" value="${value}" step="${step}" min="0">${unit ? `<i>${unit}</i>` : ''}</span></label>`;
  return `<div class="est-settings" role="group" aria-label="Estimate settings">
    ${f('laborRate', 'Hourly rate', s.laborRate, '$/hr', 1)}
    ${f('contingency', 'Contingency', +(s.contingency * 100).toFixed(2), '%', 1)}
    ${f('overhead', 'Overhead', +(s.overhead * 100).toFixed(2), '%', 1)}
    ${f('profit', 'Profit', +(s.profit * 100).toFixed(2), '%', 1)}
    ${f('taxRate', 'Tax on materials', +(s.taxRate * 100).toFixed(3), '%', 0.125)}
    ${f('sparePerMoulding', 'Spare boards each', s.sparePerMoulding, '', 1)}
  </div>`;
}

function partsHtml(M) {
  const { est } = M;
  const rows = [];
  for (const part of est.parts.values()) {
    const p = part.project;
    const isRoot = p.id === est.root.id;
    rows.push(`<tr data-d="part:${esc(p.id)}"><td><b>${esc(isRoot ? p.name + ' (itself)' : p.name)}</b>${part.rooms.length ? `<div class="small muted">trim: ${esc(part.rooms.join(', '))}</div>` : ''}</td>
      <td class="num">${M.money(part.items.likely)}</td><td class="num">${M.money(part.trim.likely)}</td><td class="num">${part.hours.likely ? hrs(part.hours.likely) : '–'}</td><td class="num">${part.days || '–'}</td><td class="num"><b>${M.money(part.total.likely)}</b></td></tr>`);
  }
  return `<div class="sec-head"><div class="eyebrow">Where the money goes</div><h2>By room and subproject</h2>
    <p class="lede">Each subproject's share, with its own markups: these are the figures PROJECTS, SCHEDULE and the program show.</p></div>
    <div class="tbl"><table class="grid"><thead><tr><th>Project</th><th class="num">Scope items</th><th class="num">Drawn trim</th><th class="num">Hours</th><th class="num">Days</th><th class="num">Total, likely</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}

// ---------- trim: rooms, walls, boards ----------

function roomsHtml(M) {
  const t = M.t;
  const rows = M.rooms.map(r => `<tr data-d="room:${esc(r.name)}"><td><b>${esc(r.name)}</b></td><td class="num">${r.walls}</td><td class="num">${Math.round(r.trimLf || 0)}</td><td class="num">${r.pieces}</td>
    <td class="num">${Object.values(r.sticks || {}).reduce((a, b) => a + b, 0)}</td><td class="num">${M.money(r.mat)}</td><td class="num">${M.money(r.supplies)}</td><td class="num">${hrs(r.hours)}</td><td class="num">${M.money(r.laborCost)}</td><td class="num"><b>${M.money(r.total)}</b></td></tr>`).join('');
  const rooms = M.rooms.map(r => roomHtml(M, r)).join('');
  return `<div class="sec-head"><div class="eyebrow">Trim from the drawing</div><h2>Rooms, walls and cuts</h2>
    <p class="lede">Each room is cut from its own boards, so its cut list stands alone. Every wall is drawn as seen from inside the room with each piece's mark; under it, the boards cut for that wall, to one scale. Click a piece or a board for everything about it.</p></div>
    <div class="tbl"><table class="grid"><thead><tr><th>Room</th><th class="num">Walls</th><th class="num">Trim LF</th><th class="num">Pieces</th><th class="num">Store pieces</th><th class="num">Boards</th><th class="num">Supplies</th><th class="num">Hours</th><th class="num">Labor</th><th class="num">Before markups</th></tr></thead><tbody>${rows}</tbody></table></div>
    ${rooms}`;
}
function roomHtml(M, r) {
  const walls = (M.t.walls || []).filter(w => w.room === r.name);
  const body = M.live ? '' : walls.map(w => wallBlock(M, w)).join('');
  return `<details class="est-room" id="est-room-${slug(r.name)}" data-room="${esc(r.name)}" ${M.live ? '' : 'open'}>
    <summary><b>${esc(r.name)}</b><span class="muted">${plural(walls.length, 'wall')} · ${plural(r.pieces, 'piece')} · ${plural(Object.values(r.sticks || {}).reduce((a, b) => a + b, 0), 'store piece')} · ${hrs(r.hours)} hrs · ${M.money(r.total)}</span></summary>
    <div class="est-room-body">${body}</div></details>`;
}
// One wall: its drawing and the boards cut for it. Filled when its room is opened (in the app).
export function wallBlock(M, w) {
  const boards = (M.t.boards || []).filter(b => b.wall === w.id);
  const n = (M.t.pieces || []).filter(p => p.wall === w.id).length;
  let el = '', cuts = '';
  try { el = elevationSvg(w, M.t, { maxW: 640, maxH: 300, fluid: true }); } catch (e) { el = `<p class="note">The drawing could not be made (${esc(e.message)}).</p>`; }
  try { cuts = cutsHtml(boards, w.id, M.t, { fluid: true }); } catch (e) { cuts = `<p class="note">The cut diagrams could not be made (${esc(e.message)}).</p>`; }
  return `<div class="est-wall" data-d="wall:${esc(w.id)}"><h3>${esc(w.name)} <span class="muted small">${M.len(w.h1 - w.h0)} wide · ${plural(n, 'piece')} · ${plural(boards.length, 'store piece')}</span></h3>
    <div class="est-elev">${el}</div><div class="est-cuts">${cuts || '<p class="note">Cut from boards drawn under another wall of the room.</p>'}</div></div>`;
}
export function roomBody(M, name) {
  return (M.t.walls || []).filter(w => w.room === name).map(w => wallBlock(M, w)).join('');
}

function buyHtml(M) {
  const rows = [];
  for (const b of M.t.buy || []) {
    const c = M.product(b.product);
    rows.push(`<tr class="grp" data-d="product:${esc(b.product)}"><td colspan="6"><b>${esc(c.short || c.title || b.product)}</b> <span class="muted">${esc(c.brand || '')} ${esc(c.model || '')} · ${esc(c.store || '')} · ${esc(b.soldText || '')}</span></td></tr>`);
    for (const l of b.lines || []) rows.push(`<tr data-d="product:${esc(b.product)}"><td>${b.kit ? 'kit' : M.lenIn(l.lenIn)}${l.how === 'foot' ? ' cut at the store' : ''}</td><td class="num">${l.rooms}</td><td class="num">${l.spare || ''}</td><td class="num"><b>${l.order}</b></td><td class="num">${money2(l.price)}</td><td class="num">${money2(l.ext)}</td></tr>`);
  }
  const total = (M.t.totals || {}).moulding || 0;
  return `<div class="sec-head"><div class="eyebrow">What to order</div><h2>Buy list</h2>
    <p class="lede">By moulding and store length: the boards the rooms are cut from, plus ${plural(M.est.settings.sparePerMoulding, 'spare')} of each moulding for miscuts and damage. Confirm prices before ordering.</p></div>
    <div class="tbl"><table class="grid"><thead><tr><th>Length</th><th class="num">For the rooms</th><th class="num">Spare</th><th class="num">Order</th><th class="num">Each</th><th class="num">Extended</th></tr></thead>
    <tbody>${rows.join('')}<tr class="total-row"><td colspan="5">Trim boards</td><td class="num">${money2(total)}</td></tr></tbody></table></div>`;
}

function laborTasks(M) {
  const by = new Map();
  for (const r of M.rooms) for (const l of r.labor || []) {
    const id = l.task;
    if (!by.has(id)) by.set(id, { task: M.task(id), qty: 0, hours: 0, rooms: [] });
    const x = by.get(id); x.qty += l.qty; x.hours += l.hours; x.rooms.push({ room: r.name, qty: l.qty, hours: l.hours });
  }
  return [...by.values()];
}
function laborHtml(M) {
  const s = M.est.settings;
  const rows = laborTasks(M).map(x => `<tr data-d="task:${esc(x.task.id)}"><td><b>${esc(x.task.label)}</b>${/estimate/i.test(x.task.source || '') ? ' <span class="pill warn">estimate</span>' : ''}</td><td class="num">${fmtQty(x.qty)} ${esc(x.qty === 1 ? x.task.unit_one || x.task.unit : x.task.unit)}</td><td class="num">${x.task.hours}</td><td class="num"><b>${hrs(x.hours)}</b></td><td class="num">${M.money(x.hours * s.laborRate)}</td></tr>`).join('');
  return `<div class="sec-head"><div class="eyebrow">Time</div><h2>Labor hours</h2>
    <p class="lede">${hrs(M.est.hours.likely)} hours (${hrs(M.est.hours.low)} to ${hrs(M.est.hours.high)} at the rates' low and high figures), from published production rates counted from the drawing's own measures. These are the weakest numbers here: a carpenter's own bid is the check.</p></div>
    <div class="tbl"><table class="grid"><thead><tr><th>Task</th><th class="num">Quantity</th><th class="num">Hrs each</th><th class="num">Hours</th><th class="num">At ${M.money(s.laborRate)}/hr</th></tr></thead>
    <tbody>${rows}<tr class="total-row"><td colspan="3">Labor</td><td class="num">${hrs(M.est.hours.likely)}</td><td class="num">${M.money(M.est.hours.likely * s.laborRate)}</td></tr></tbody></table></div>`;
}
const fmtQty = q => Math.abs(q - Math.round(q)) < 1e-9 ? String(Math.round(q)) : (Math.round(q * 10) / 10).toString();

function suppliesHtml(M) {
  const rows = (M.t.supplies || []).map(x => `<tr data-d="supply:${esc(x.id)}"><td><b>${esc(x.product)}</b><div class="small muted">${esc(x.store || '')} · ${esc(x.package || '')}</div></td><td class="muted">${esc(x.category)}</td><td class="num">${x.packages}</td><td class="num">${money2(x.price)}</td><td class="num">${money2(x.ext)}</td></tr>`).join('');
  const tools = ((SUPPLIES && SUPPLIES.tools) || []).map(x => `<li><b>${esc(x.tool)}</b>: ${esc(x.product)}</li>`).join('');
  return `<div class="sec-head"><div class="eyebrow">Materials besides the boards</div><h2>Supplies and tools</h2>
    <p class="lede">Counted from the job: nails from each moulding's nailing rule, caulk from the lengths caulked, primer and paint from the painted face. Shared out to rooms by trim length.</p></div>
    <div class="tbl"><table class="grid"><thead><tr><th>Supply</th><th>Kind</th><th class="num">Buy</th><th class="num">Each</th><th class="num">Extended</th></tr></thead>
    <tbody>${rows}<tr class="total-row"><td colspan="4">Supplies</td><td class="num">${money2((M.t.totals || {}).supplies || 0)}</td></tr></tbody></table></div>
    ${tools ? `<h3 class="sub">The tool kit assumed</h3><ul class="est-tools">${tools}</ul>` : ''}`;
}

function optionsHtml(M) {
  const rows = (M.t.scenarios || []).map((x, i) => `<tr data-d="option:${i}"><td><b>${esc(x.name)}</b><div class="small muted">${esc(x.axis || '')}</div></td><td class="num">${M.money(x.mould)}</td><td class="num">${M.money(x.sup)}</td><td class="num">${hrs(x.hours)}</td><td class="num"><b>${M.money(x.total)}</b></td></tr>`).join('');
  return `<div class="sec-head"><div class="eyebrow">The same rooms, priced other ways</div><h2>Options</h2>
    <p class="lede">Each row changes one thing from the drawing: profile, material, finish or store. Totals include supplies, labor and the trim package's 10% contingency, before tax.</p></div>
    <div class="tbl"><table class="grid"><thead><tr><th>Option</th><th class="num">Trim</th><th class="num">Supplies</th><th class="num">Hours</th><th class="num">Total</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function itemsHtml(M) {
  const { est } = M;
  const covered = new Set(est.covered.map(c => c.item.id));
  const rows = [];
  for (const p of est.tree) {
    if (!(p.items || []).length) continue;
    rows.push(`<tr class="grp"><td colspan="5">${esc(p.id === est.root.id ? p.name : p.name)}</td></tr>`);
    for (const it of p.items) {
      const q = it.qty ?? 1, c = covered.has(it.id);
      rows.push(`<tr data-d="item:${esc(it.id)}" class="${c ? 'covered' : ''}"><td>${c ? '<s>' : '<b>'}${esc(it.name || 'Item')}${c ? '</s> <span class="pill mute">counted in the drawn trim</span>' : '</b>'}</td><td class="num">${fmtQty(q)} ${esc(it.unit || '')}</td><td class="num">${M.money((it.low || 0) * q)}</td><td class="num">${M.money((it.likely || 0) * q)}</td><td class="num">${M.money((it.high || 0) * q)}</td></tr>`);
    }
  }
  const remove = M.live && est.covered.length ? `<p><button class="btn small" data-remove-covered>REMOVE THE ${est.covered.length} COVERED ${est.covered.length === 1 ? 'ITEM' : 'ITEMS'}</button> <span class="note">They can be brought back from REMOVED RECORDS in PROJECTS.</span></p>` : '';
  return `<div class="sec-head"><div class="eyebrow">Everything else</div><h2>Scope items</h2>
    <p class="lede">The project's own scope items from PROJECTS, by subproject: installed prices with their ranges.${est.covered.length ? ' Items struck through list only drawn trim sections: the drawn trim prices that work now.' : ''}</p></div>
    ${rows.length ? `<div class="tbl"><table class="grid"><thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Low</th><th class="num">Likely</th><th class="num">High</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>` : '<p class="note">No scope items.</p>'}${remove}`;
}

function bidsHtml(M) {
  const { est } = M, root = est.root;
  const bids = root.bids || [];
  const labor = est.hours.likely * est.settings.laborRate;
  const rows = bids.map(b => {
    const diff = (Number(b.amount) || 0) - labor;
    return `<tr data-d="bid:${esc(b.id)}"><td><b>${esc(b.who || 'Bidder')}</b><div class="small muted">${esc(b.date || '')}${b.scope ? ' · ' + esc(b.scope) : ''}</div></td><td class="num">${b.hours ? hrs(b.hours) : '–'}</td><td class="num">${M.money(Number(b.amount) || 0)}</td><td class="num ${diff > 0 ? 'over' : 'under'}">${labor ? (diff >= 0 ? '+' : '−') + M.money(Math.abs(diff)) : '–'}</td>${M.live ? `<td><button class="btn small ghost" data-del-bid="${esc(b.id)}" aria-label="Remove this bid">REMOVE</button></td>` : ''}</tr>`;
  }).join('');
  const so = root.signoff || null;
  const form = M.live ? `<form class="est-bid-form" data-add-bid>
      <label><span>Bidder</span><input name="who" required placeholder="Carpenter or company"></label>
      <label><span>Date</span><input name="date" type="date"></label>
      <label><span>Hours</span><input name="hours" type="number" step="0.5" min="0"></label>
      <label><span>Amount</span><input name="amount" required placeholder="$"></label>
      <label class="wide"><span>Covers</span><input name="scope" placeholder="Labor only, or labor and materials"></label>
      <button class="btn small" type="submit">ADD BID</button></form>` : '';
  const soForm = M.live ? `<form class="est-bid-form" data-signoff>
      <label><span>Status</span><select name="status">${['', 'sent', 'accepted', 'declined'].map(x => `<option value="${x}" ${so && so.status === x ? 'selected' : ''}>${x ? x[0].toUpperCase() + x.slice(1) : 'Not sent'}</option>`).join('')}</select></label>
      <label><span>Client</span><input name="by" value="${esc(so && so.by || '')}" placeholder="Who signs"></label>
      <label><span>Date</span><input name="date" type="date" value="${esc(so && so.date || '')}"></label>
      <label><span>Amount</span><input name="amount" value="${so && so.amount != null ? esc(M.money(so.amount)) : ''}" placeholder="${esc(M.money(est.total.likely))}"></label>
      <label class="wide"><span>Note</span><input name="note" value="${esc(so && so.note || '')}" placeholder="Changes agreed, deposit received"></label>
      <button class="btn small" type="submit">SAVE SIGN-OFF</button></form>` : '';
  const soText = so && so.status ? `<p class="est-signoff">${esc(so.status === 'accepted' ? 'Accepted' : so.status === 'declined' ? 'Declined' : 'Sent')}${so.by ? ' by ' + esc(so.by) : ''}${so.date ? ' on ' + esc(so.date) : ''}${so.amount != null && so.amount !== '' ? ' at ' + esc(M.money(Number(so.amount))) : ''}.${so.note ? ' ' + esc(so.note) : ''}</p>` : '<p class="note">The proposal has not been sent.</p>';
  return `<div class="sec-head"><div class="eyebrow">From carpenters, to the client</div><h2>Bids and sign-off</h2>
    <p class="lede">Bids received against the bid form, compared with the estimate's labor (${M.money(labor)} for ${hrs(est.hours.likely)} hours); then the client's answer to the proposal. The bid form and the proposal are in DOCUMENTS.</p></div>
    ${rows ? `<div class="tbl"><table class="grid"><thead><tr><th>Bid</th><th class="num">Hours</th><th class="num">Amount</th><th class="num">Against the estimate's labor</th>${M.live ? '<th></th>' : ''}</tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="note">No bids recorded.</p>'}
    ${form}<h3 class="sub">Client sign-off</h3>${soText}${soForm}`;
}

function sourcesHtml(M) {
  const t = M.t;
  return `<div class="sec-head"><div class="eyebrow">What this rests on</div><h2>Sources and assumptions</h2></div>
    <div class="rows">
      <div data-d="source:drawing"><span class="t">The drawing</span><span class="m">${esc(M.date || '')}</span><span class="d">The trim sections drawn in MODEL for this project and its subprojects${t ? ` (${(M.est.trim.sectionIds || []).length} sections)` : ''}, laid out exactly as MODEL draws them.</span></div>
      ${t ? `<div data-d="source:labor"><span class="t">Labor rates</span><span class="m">seen ${esc(LABOR.seen)}</span><span class="d">${esc(LABOR.note)}</span></div>
      <div data-d="source:supplies"><span class="t">Supplies and prices</span><span class="m">seen ${esc(SUPPLIES.seen)}</span><span class="d">${esc(SUPPLIES.note)}</span></div>
      <div data-d="source:stock"><span class="t">Store lengths</span><span class="m">trim catalog</span><span class="d">How each moulding is sold (set lengths, by the foot, or both), with item numbers; a moulding with no store record is sold in its catalog length only.</span></div>
      <div data-d="source:options"><span class="t">Options</span><span class="m">seen ${esc(OPTIONS.seen)}</span><span class="d">${esc(OPTIONS.note)}</span></div>` : ''}
      <div data-d="source:items"><span class="t">Scope items</span><span class="m">PROJECTS</span><span class="d">Installed prices from the price book or typed in, each with its low, likely and high.</span></div>
    </div>`;
}

// ---------- the detail column ----------

const ENDS = { cope: 'Coped: the shape of the piece it meets is cut into its end; that piece runs square into the corner.', 'square into corner': 'Runs square into the corner; the piece it meets is coped over it.', 'miter 45°': 'A 45° miter (an outside corner or a frame corner).', 'square butt': 'A square butt joint with the next run on the same wall line.', 'scarf 45°': 'A 45° scarf splice: the run is longer than one board.', 'check on site': 'The drawing does not say whether the trim turns or stops here: check on site.', square: 'Square: it stops against a casing or an opening.' };
const endText = e => ENDS[e] || (String(e).startsWith('plumb') ? 'A plumb cut where a raked rail meets level trim.' : String(e).startsWith('miter') ? 'An angled miter at a raked panel corner.' : '');

export function detailFor(key, M) {
  const i = String(key).indexOf(':'), kind = i < 0 ? key : key.slice(0, i), id = i < 0 ? '' : key.slice(i + 1);
  const t = M.t, est = M.est;
  try {
    switch (kind) {
      case 'piece': {
        const g = t && (t.groups || []).find(x => x.mark === id);
        if (!g) return null;
        const ps = (t.pieces || []).filter(p => p.mark === id);
        const c = M.product(g.product);
        const wall = (t.walls || []).find(w => w.id === g.wall);
        const boards = [...new Set(ps.map(p => p.stick).filter(Boolean))];
        return { eyebrow: `Piece ${esc(id)} · ${esc(g.room)}`, title: esc(g.name), sub: `${esc(g.size || '')} ${esc(g.material || c.material || '')}`,
          html: kv([['Length', `<b>${M.lenIn(g.lin)}</b> long point${g.qty > 1 ? ` · ${g.qty} alike` : ''}`],
            ['Ends', `${esc(g.endL)} / ${esc(g.endR)} (left / right as you face the wall)`],
            ['Moulding', L(esc(c.short || g.product), 'product:' + g.product)],
            ['Wall', wall ? L(esc(wall.name), 'wall:' + wall.id) : ''], ['Room', L(esc(g.room), 'room:' + g.room)],
            ['Section', esc(g.sectionName || '')], ['Split', g.split ? esc(g.split) + ' (scarf joints)' : '']]) +
            sec('The ends', list([...new Set([g.endL, g.endR])].map(e => `<b>${esc(e)}</b>: ${esc(endText(e))}`))) +
            sec('Cut from', list(boards.map(b => { const bd = (t.boards || []).find(x => x.id === b && x.room === g.room); return bd ? L(esc(bd.id) + ' · ' + M.lenIn(bd.stockIn), 'stick:' + bd.key) : esc(b); }))),
          model: g.section ? [g.section] : null, go: 'est-room-' + slug(g.room) };
      }
      case 'stick': {
        const b = t && (t.boards || []).find(x => x.key === id);
        if (!b) return null;
        const c = M.product(b.product);
        let svg = '';
        try { svg = cutsHtml([b], b.wall, t, { fluid: true, lmax: b.stockIn }); } catch { svg = ''; }
        return { eyebrow: `Store piece · ${esc(b.room)}`, title: esc(b.id), sub: `${esc(c.short || b.product)}, ${b.kit ? 'kit rail' : M.lenIn(b.stockIn)}${b.how === 'foot' ? ' cut at the store' : ''}`,
          html: kv([['Price', money2(b.price)], ['Sold', esc(b.sold || '')], ['Between cuts', b.gap ? M.lenIn(b.gap) : ''], ['Left over', b.drop > 1 / 32 ? M.lenIn(b.drop) + (b.drop < 12 ? ' waste' : ' offcut') : 'nothing']]) +
            (svg ? `<div class="est-cuts">${svg}</div>` : '') +
            sec('Cuts, longest first', list((b.cuts || []).map(x => `${L(esc(x.mark), 'piece:' + x.mark)} ${esc(x.name)}: <b>${M.lenIn(x.lin)}</b>, ${esc(x.endL)} / ${esc(x.endR)}`))),
          go: 'est-room-' + slug(b.room) };
      }
      case 'wall': {
        const w = t && (t.walls || []).find(x => x.id === id);
        if (!w) return null;
        const ps = (t.groups || []).filter(g => g.wall === id);
        let el = '';
        try { el = elevationSvg(w, t, { maxW: 400, maxH: 220, fluid: true }); } catch { el = ''; }
        return { eyebrow: `Wall · ${esc(w.room)}`, title: esc(w.name), sub: `${M.len(w.h1 - w.h0)} wide, ${M.len(w.H)} high`,
          html: `<div class="est-elev">${el}</div>` + sec('Pieces', list(ps.map(g => `${L(esc(g.mark), 'piece:' + g.mark)} ${esc(g.name.split(' · ').slice(1).join(' · ') || g.name)}: ${g.qty > 1 ? g.qty + ' × ' : ''}${M.lenIn(g.lin)}`))) +
            sec('Openings', list((w.openings || []).map(o => `${esc(o.type)} ${M.len(o.h1 - o.h0)} wide`))),
          model: [...new Set((t.pieces || []).filter(p => p.wall === id).map(p => p.section))], go: 'est-room-' + slug(w.room) };
      }
      case 'room': {
        const r = M.rooms.find(x => x.name === id);
        if (!r) return null;
        const m = r.measures || {};
        return { eyebrow: 'Room', title: esc(r.name), sub: `${M.money(r.total)} before markups · ${hrs(r.hours)} hrs · ${r.days} working ${r.days === 1 ? 'day' : 'days'}`,
          html: kv([['Walls', r.walls], ['Pieces', r.pieces], ['Trim', Math.round(r.trimLf || 0) + ' LF'], ['Boards', M.money(r.mat)], ['Supplies (share)', M.money(r.supplies)], ['Labor', M.money(r.laborCost)],
            ['Copes', m.copes], ['Outside corners', m.outside], ['Scarf joints', m.scarfs], ['Ends to check on site', r.check || m.check || 0]]) +
            sec('Walls', list((t.walls || []).filter(w => w.room === r.name).map(w => L(esc(w.name), 'wall:' + w.id)))) +
            sec('Labor', list((r.labor || []).map(l => `${L(esc(l.label), 'task:' + l.task)}: ${fmtQty(l.qty)} ${esc(l.unit)} → ${hrs(l.hours)} hrs`))),
          model: [...new Set((t.pieces || []).filter(p => p.room === r.name).map(p => p.section))], go: 'est-room-' + slug(r.name) };
      }
      case 'task': {
        const lines = laborTasks(M).find(x => x.task.id === id);
        const task = lines ? lines.task : (LABOR.tasks || []).find(x => x.id === id);
        if (!task) return null;
        return { eyebrow: 'Labor task', title: esc(task.label), sub: `${task.hours} hrs per ${esc(task.unit_one || task.unit)} (low ${task.low ?? task.hours}, high ${task.high ?? task.hours})`,
          html: kv([['Counted from', esc(task.unit)], ['This job', lines ? `${fmtQty(lines.qty)} ${esc(task.unit)} → <b>${hrs(lines.hours)} hrs</b>, ${M.money(lines.hours * est.settings.laborRate)}` : 'not used']]) +
            sec('Basis', `<p>${esc(task.basis || '')}</p>`) + sec('By room', lines ? list(lines.rooms.map(r => `${L(esc(r.room), 'room:' + r.room)}: ${fmtQty(r.qty)} → ${hrs(r.hours)} hrs`)) : '') +
            `<div class="d-src">${esc(task.source || '')}</div>`, go: 'est-labor' };
      }
      case 'supply': {
        const x = t && (t.supplies || []).find(s => s.id === id);
        if (!x) return null;
        return { eyebrow: 'Supply · ' + esc(x.category), title: esc(x.product), sub: `${x.packages} × ${esc(x.package)} at ${money2(x.price)} = ${money2(x.ext)}`,
          html: kv([['Store', esc(x.store)], ['Item', esc(x.item_no || '')], ['Needed', `${fmtQty(x.need)} ${esc(x.unit || '')}`], ['Price seen', esc(x.seen || '')], ['Link', link(x.url, 'store page')]]) +
            sec('Basis', `<p>${esc(x.basis || '')}</p>`), go: 'est-supplies' };
      }
      case 'product': {
        const b = t && (t.buy || []).find(x => x.product === id);
        const c = M.product(id);
        if (!b && !c) return null;
        return { eyebrow: 'Moulding', title: esc(c.short || id), sub: esc([c.brand, c.model, c.store].filter(Boolean).join(' · ')),
          html: kv([['Size', esc(c.size || '')], ['Material', esc([c.material, c.finish].filter(Boolean).join(', '))], ['Sold', esc(b ? b.soldText : c.length)], ['Catalog price', c.price != null ? money2(c.price) + ' ' + esc(c.priceUnit || '') : ''],
            ['Order', b ? `${b.order} (${b.rooms} for the rooms, ${b.spare} spare)` : ''], ['Extended', b ? money2(b.ext) : ''],
            ['Yield', b && b.yield ? pct(b.yield) + ' of the wood bought is used' : ''], ['Link', link(c.url, 'store page')]]) +
            (c.evidence ? sec('Evidence', `<p>${esc(c.evidence)}</p>`) : '') +
            sec('Boards', list((t.boards || []).filter(x => x.product === id).slice(0, 60).map(x => `${L(esc(x.room + ' · ' + x.id), 'stick:' + x.key)} ${x.kit ? '' : M.lenIn(x.stockIn)}`))), go: 'est-buy' };
      }
      case 'item': {
        const hit = est.tree.flatMap(p => (p.items || []).map(it => ({ p, it }))).find(x => x.it.id === id);
        if (!hit) return null;
        const { p, it } = hit, q = it.qty ?? 1, cov = est.covered.some(c => c.item.id === id);
        return { eyebrow: 'Scope item · ' + esc(p.name), title: esc(it.name || 'Item'), sub: cov ? 'Counted in the drawn trim: left out of the total' : `${M.money((it.likely || 0) * q)} likely`,
          html: kv([['Quantity', `${fmtQty(q)} ${esc(it.unit || '')}`], ['Each', `${M.money(it.low || 0)} / ${M.money(it.likely || 0)} / ${M.money(it.high || 0)}`], ['Days', it.durationDays || ''], ['Status', esc(it.status || '')]]) +
            (it.notes ? sec('Notes', `<p>${esc(it.notes)}</p>`) : '') + (M.live ? `<p><a class="btn small" href="#/projects">OPEN IN PROJECTS</a></p>` : ''),
          model: (it.elementIds || []).length ? it.elementIds : null, go: 'est-items' };
      }
      case 'part': {
        const part = est.parts.get(id);
        if (!part) return null;
        return { eyebrow: part.project.id === est.root.id ? 'Project' : 'Subproject', title: esc(part.project.name), sub: `${M.money(part.total.likely)} likely (${M.money(part.total.low)} to ${M.money(part.total.high)})`,
          html: kv([['Scope items', M.money(part.items.likely)], ['Drawn trim', M.money(part.trim.likely)], ['Hours', part.hours.likely ? hrs(part.hours.likely) : ''], ['Working days', part.days || ''],
            ['Contingency', part.contingency.likely ? M.money(part.contingency.likely) : ''], ['Overhead', part.overhead.likely ? M.money(part.overhead.likely) : ''], ['Profit', part.profit.likely ? M.money(part.profit.likely) : ''], ['Tax', part.tax ? M.money(part.tax) : '']]) +
            sec('Rooms of drawn trim', list(part.rooms.map(r => L(esc(r), 'room:' + r)))), go: 'est-parts' };
      }
      case 'option': {
        const x = t && (t.scenarios || [])[Number(id)];
        if (!x) return null;
        return { eyebrow: 'Option · ' + esc(x.axis || ''), title: esc(x.name), sub: `${M.money(x.total)} all in`,
          html: `<p>${esc(x.what || '')}</p>` + kv([['Trim', M.money(x.mould)], ['Supplies', M.money(x.sup)], ['Hours', hrs(x.hours)], ['Labor', M.money(x.labor)]]), go: 'est-options' };
      }
      case 'cost': return costDetail(id, M);
      case 'bid': {
        const b = (est.root.bids || []).find(x => x.id === id);
        if (!b) return null;
        const labor = est.hours.likely * est.settings.laborRate;
        return { eyebrow: 'Bid received', title: esc(b.who || 'Bidder'), sub: `${M.money(Number(b.amount) || 0)}${b.hours ? ' for ' + hrs(b.hours) + ' hours' : ''}`,
          html: kv([['Date', esc(b.date || '')], ['Covers', esc(b.scope || '')], ['Estimate\'s labor', `${M.money(labor)} (${hrs(est.hours.likely)} hrs)`],
            ['Their rate', b.hours && b.amount ? M.money(b.amount / b.hours) + '/hr' : '']]) + (b.notes ? sec('Notes', `<p>${esc(b.notes)}</p>`) : ''), go: 'est-bids' };
      }
      case 'source': {
        const SRC = { labor: [LABOR.seen, LABOR.note + ' ' + (LABOR.rate_note || '')], supplies: [SUPPLIES.seen, SUPPLIES.note], options: [OPTIONS.seen, OPTIONS.note + ' ' + (OPTIONS.labor_note || '')] };
        const s = SRC[id];
        return { eyebrow: 'Source', title: esc({ labor: 'Labor rates', supplies: 'Supplies and prices', options: 'Options', drawing: 'The drawing', stock: 'Store lengths', items: 'Scope items' }[id] || id), sub: s ? 'seen ' + esc(s[0]) : '',
          html: s ? `<p>${esc(s[1])}</p>` : '<p>See the section on the page.</p>', go: 'est-sources' };
      }
    }
  } catch (e) {
    return { eyebrow: 'Detail', title: 'Could not show this', html: `<p class="note">${esc(e.message)}</p>` };
  }
  return null;
}

function costDetail(id, M) {
  const { est } = M, s = est.settings, t = M.t;
  const B = Object.fromEntries(BUILD.map(([k, l, d]) => [k, [l, d]]));
  if (id === 'covered') return { eyebrow: 'Price build-up', title: 'Items counted in the drawn trim', sub: `${est.covered.length} left out of the total`,
    html: `<p>These scope items list only drawn trim sections of this project (an earlier trim package wrote each room's boards as items). The drawn trim now prices the boards, supplies and labor from the drawing, so counting the items too would count the boards twice.</p>` +
      list(est.covered.map(c => `${L(esc(c.item.name), 'item:' + c.item.id)} <span class="muted">(${esc(c.project.name)})</span>`)), go: 'est-items' };
  if (id === 'days') return { eyebrow: 'Schedule', title: `${est.days} working days`, sub: 'One carpenter, by room',
    html: `<p>Each room takes its hours over 6 productive hours a day, at least a day. SCHEDULE shows them as one install item per subproject.</p>` +
      list(M.rooms.map(r => `${L(esc(r.name), 'room:' + r.name)}: ${r.days} ${r.days === 1 ? 'day' : 'days'} (${hrs(r.hours)} hrs)`)), go: 'est-labor' };
  if (B[id]) return { eyebrow: 'Price build-up', title: esc(B[id][0]), html: `<p>${esc(B[id][1])}</p>` + (id === 'labor' && t ? list(laborTasks(M).map(x => `${L(esc(x.task.label), 'task:' + x.task.id)}: ${hrs(x.hours)} hrs`)) : id === 'moulding' && t ? list((t.buy || []).map(b => `${L(esc(M.product(b.product).short || b.product), 'product:' + b.product)}: ${b.order} · ${money2(b.ext)}`)) : id === 'supplies' && t ? list(Object.entries(t.suppliesByCategory || {}).map(([k, v]) => `${esc(k)}: ${money2(v)}`)) : ''), go: 'est-buildup' };
  const M2 = { contingency: ['Contingency', `${pct(s.contingency)} of the cost, for what the drawing does not show: hidden conditions, out-of-square walls, a re-cut.`],
    overhead: ['Overhead', `${pct(s.overhead)} on the cost and contingency: the business's running costs.`],
    profit: ['Profit', `${pct(s.profit)} on the cost, contingency and overhead.`],
    tax: ['Sales tax', `${pct(s.taxRate)} on the trim boards and supplies bought (${M.money(est.materials)}). Scope items are installed prices; any tax is in them.`],
    total: ['Total', `${M.money(est.total.likely)} likely, ${M.money(est.total.low)} to ${M.money(est.total.high)}.`] };
  if (M2[id]) return { eyebrow: 'Price build-up', title: M2[id][0], html: `<p>${esc(M2[id][1])}</p>` + (M.live ? '<p class="note">Change it in the price build-up: the totals here, in PROJECTS, the program and the one-pager follow.</p>' : ''), go: 'est-buildup' };
  return null;
}

// Everything findable: [{ key, kind, title, text }]
export function searchIndex(M) {
  const out = [];
  const add = (key, kind, title, text) => out.push({ key, kind, title: String(title || ''), text: (String(title || '') + ' ' + String(text || '')).toLowerCase() });
  const t = M.t;
  if (t) {
    for (const g of t.groups || []) add('piece:' + g.mark, 'Piece', g.mark + ' ' + g.name, g.room + ' ' + (g.sectionName || ''));
    for (const b of t.boards || []) add('stick:' + b.key, 'Store piece', b.room + ' · ' + b.id, b.product);
    for (const w of t.walls || []) add('wall:' + w.id, 'Wall', w.room + ' · ' + w.name, '');
    for (const r of M.rooms) add('room:' + r.name, 'Room', r.name, '');
    for (const x of laborTasks(M)) add('task:' + x.task.id, 'Labor', x.task.label, x.task.basis);
    for (const x of t.supplies || []) add('supply:' + x.id, 'Supply', x.product, x.category);
    for (const b of t.buy || []) { const c = M.product(b.product); add('product:' + b.product, 'Moulding', c.short || b.product, [c.brand, c.model, c.store].join(' ')); }
  }
  for (const p of M.est.tree) for (const it of p.items || []) add('item:' + it.id, 'Scope item', it.name, p.name + ' ' + (it.notes || ''));
  return out;
}

export { ROLE_NAME, hrs, pct, esc as escapeText };
