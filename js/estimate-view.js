// ESTIMATE: what a job costs, room by room, and how the price is built (job.js).
//
// Left: the jobs (top-level projects) and ALL PROJECTS, the program against the budget cap.
// Middle: the job's price, then one table of its rooms (drawn trim and scope items), the price
// build-up with its settings, and bids received. Opening a room shows its walls as drawn with the
// boards each is cut from, its cut list and its labor. Right: whatever was clicked (a piece, a
// board, a labor task, a scope item), with where its numbers come from.
//
// Addresses: #/estimate?project=<id>, #/estimate?program, and the old #/budget (the program).

import {
  ws, touch, onChange, activeProperty, propertyProjects, projectById, escapeHtml, fmtLen, readMoney, uid, isoToday, fmtDate,
} from './store.js';
import { jobOf, rootOf, setJobSetting, JOB_DEFAULTS } from './job.js';
import { programTotals, lastWorkDay, workday } from './program.js';
import { elevationSvg, cutsHtml } from './trim-drawings.js';
import { catalogItem } from './trim-catalog.js';
import { keepRemoved } from './recovery.js';
import { restoreProjectEdit } from './project-history.js';
import { showInModel, modelBeside } from './model-focus.js';
import { printSheet } from './print-sheet.js';
import { icon } from './icons.js';

const IN = 0.0254;
const esc = escapeHtml;
// Whole dollars everywhere on the page, so a column reads alike; a single board's price keeps its cents.
const fm = v => (v < 0 ? '-' : '') + '$' + Math.abs(Math.round(Number(v) || 0)).toLocaleString('en-US');
const m2 = v => '$' + (Number(v) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const hrs = v => (Math.round((Number(v) || 0) * 10) / 10).toFixed(1);
const pct = v => +(v * 100).toFixed(3) + '%';
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many || one + 's');
const range = t => t.low === t.high ? '' : `${fm(t.low)} to ${fm(t.high)}`;
const lenIn = inches => fmtLen(inches * IN);

let el = null, off = null, timer = null;
let hist = [], hpos = -1;
const open = new Set();          // rooms opened in the table
const LAST = 'tiksi.estimate.last.';

function target() {
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  if (/^#\/budget/.test(location.hash) || q.has('program')) return { program: true };
  const id = q.get('project');
  if (id && projectById(id)) return { id: rootOf(projectById(id)).id };
  const tops = propertyProjects().filter(p => !p.parentId);
  let last = '';
  try { last = localStorage.getItem(LAST + (activeProperty() || {}).id) || ''; } catch { /* not kept */ }
  if (last && tops.some(p => p.id === last)) return { id: last };
  return tops.length ? { id: tops[0].id } : { program: true };
}
function go(t) {
  try { localStorage.setItem(LAST + (activeProperty() || {}).id, t.program ? 'program' : t.id); } catch { /* fine */ }
  history.replaceState(null, '', t.program ? '#/estimate?program' : '#/estimate?project=' + encodeURIComponent(t.id));
  hist = []; hpos = -1; open.clear();
  render();
  el?.querySelector('.es-main')?.scrollTo(0, 0);
}

export function mount(root) {
  el = root;
  off = onChange(() => { clearTimeout(timer); timer = setTimeout(() => { if (el && !el.querySelector('.es :is(input,select,textarea):focus')) render(true); }, 150); });
  render();
}
export function unmount() { clearTimeout(timer); if (off) off(); off = null; el = null; }
export function undo() { if (restoreProjectEdit('undo')) render(true); }
export function redo() { if (restoreProjectEdit('redo')) render(true); }

function render(keep) {
  if (!el) return;
  const t = target(), prop = activeProperty();
  const tops = propertyProjects().filter(p => !p.parentId);
  const scroll = keep ? el.querySelector('.es-main')?.scrollTop || 0 : 0;
  const nav = `<nav class="es-nav" aria-label="Jobs">
      <a class="es-job ${t.program ? 'here' : ''}" href="#/estimate?program" data-program><span>All projects</span><span class="m">${fm(programTotals(propertyProjects()).likely)}</span></a>
      <div class="gl">Projects</div>
      ${tops.map(p => { const j = jobOf(p); return `<a class="es-job ${t.id === p.id ? 'here' : ''}" href="#/estimate?project=${encodeURIComponent(p.id)}" data-job="${esc(p.id)}"><span>${esc(p.name || 'Project')}</span><span class="m">${j ? fm(j.price.likely) : ''}</span></a>`; }).join('') || '<p class="note">No projects yet: make one in PROJECTS.</p>'}
    </nav>`;
  el.innerHTML = `<div class="es">${nav}<main class="es-main"><div class="es-in" id="es-in"></div></main>
    <aside class="es-det" aria-label="Details"><div class="es-dbar"><button type="button" data-back aria-label="Back" disabled>‹</button><span class="crumb" id="es-crumb">Details</span><button type="button" data-close aria-label="Close">×</button></div><div class="es-dbody" id="es-dbody"></div></aside></div>`;
  el.querySelector('[data-program]').onclick = e => { e.preventDefault(); go({ program: true }); };
  el.querySelectorAll('[data-job]').forEach(a => a.onclick = e => { e.preventDefault(); go({ id: a.dataset.job }); });
  el.querySelector('[data-back]').onclick = () => { if (hpos > 0) { hpos--; paint(); } };
  el.querySelector('[data-close]').onclick = () => { hist = []; hpos = -1; paint(); };
  const inner = el.querySelector('#es-in');
  if (t.program) renderProgram(inner, prop);
  else renderJob(inner, jobOf(projectById(t.id)), prop);
  el.querySelector('.es-main').scrollTop = scroll;
  paint();
}

// ---------- one job ----------
function renderJob(inner, job, prop) {
  const s = job.settings, root = job.root, trim = job.trim && !job.trim.error ? job.trim : null;
  const start = root.startDate || ws.data.settings.programStart || isoToday();
  const days = job.schedule.days;
  const order = trim ? trim.buy.reduce((n, b) => n + b.order, 0) : 0;
  const rows = job.rooms.filter(r => r.trim.length || r.items.length);
  const head = `<header class="es-head"><div class="es-kicker">${esc(prop ? prop.name || '' : '')}</div><h1>${esc(root.name || 'Project')}</h1>
    <div class="es-figs">
      <div class="big" data-d="cost:price"><b>${fm(job.price.likely)}</b><span>price${range(job.price) ? ', ' + range(job.price) : ''}</span></div>
      <div data-d="cost:hours"><b>${trim ? hrs(job.hours.likely) : '–'}</b><span>carpenter hours</span></div>
      <div data-d="cost:days"><b>${days || '–'}</b><span>${days ? `working days, ${fmtDate(workday(start, 0))} to ${fmtDate(lastWorkDay(start, days))}` : 'working days'}</span></div>
      <div data-d="cost:order"><b>${trim ? order : '–'}</b><span>${trim ? `boards to buy, ${fm(job.boards)}` : 'boards to buy'}</span></div>
    </div>
    <div class="es-acts"><a class="btn small" href="#/schedule?project=${encodeURIComponent(root.id)}">${icon('schedule')}SCHEDULE</a><a class="btn small" href="#/documents?job=${encodeURIComponent(root.id)}">${icon('print')}DOCUMENTS</a></div></header>`;
  const warn = [
    job.trim && job.trim.error ? `<div class="es-note bad">The drawn trim could not be worked out: ${esc(job.trim.error)}</div>` : '',
    job.covered.length ? `<div class="es-note">${plural(job.covered.length, 'scope item')} ${job.covered.length === 1 ? 'lists' : 'list'} only drawn trim of this project (boards written in by an earlier trim package). The drawing prices those boards now, so ${job.covered.length === 1 ? 'it is' : 'they are'} left out. <button class="btn small" data-remove-covered>REMOVE ${job.covered.length === 1 ? 'IT' : 'THEM'}</button></div>` : '',
  ].join('');
  const roomRow = r => {
    const has = r.trim.length > 0;
    return `<tr class="es-room ${open.has(r.key) ? 'open' : ''}" data-room="${esc(r.key)}" tabindex="0" aria-expanded="${open.has(r.key)}">
      <td><span class="tw">${open.has(r.key) ? '▾' : '▸'}</span><b>${esc(r.name)}</b>${r.project === root && !has ? '' : ''}</td>
      <td class="num">${has ? Math.round(r.trimLf) : ''}</td><td class="num">${has ? r.pieces : ''}</td><td class="num">${has ? fm(r.boards) : ''}</td><td class="num">${has ? fm(r.supplies) : ''}</td>
      <td class="num">${has ? hrs(r.hours.likely) : ''}</td><td class="num">${has ? fm(r.labor.likely) : ''}</td><td class="num">${r.itemCost.high ? fm(r.itemCost.likely) : ''}</td>
      <td class="num">${r.days || ''}</td><td class="num"><b>${fm(r.price.likely)}</b></td></tr>
      ${open.has(r.key) ? `<tr class="es-open"><td colspan="10">${roomBody(job, r)}</td></tr>` : ''}`;
  };
  const otherRow = job.other.items.length ? `<tr class="es-room ${open.has('other') ? 'open' : ''}" data-room="other" tabindex="0"><td><span class="tw">${open.has('other') ? '▾' : '▸'}</span><b>Project-wide items</b></td><td colspan="6" class="note">${job.other.itemCost.high ? '' : plural(job.other.items.length, 'item') + ' without prices'}</td><td class="num">${job.other.itemCost.high ? fm(job.other.itemCost.likely) : ''}</td><td></td><td class="num"><b>${fm(job.other.price.likely)}</b></td></tr>
      ${open.has('other') ? `<tr class="es-open"><td colspan="10">${itemsTable(job.other.items)}</td></tr>` : ''}` : '';
  const table = `<section class="es-sec"><h2>Rooms</h2>
    <div class="es-tbl"><table class="es-t"><thead><tr><th>Room</th><th class="num">Trim LF</th><th class="num">Pieces</th><th class="num">Boards</th><th class="num">Supplies</th><th class="num">Hours</th><th class="num">Labor</th><th class="num">Scope items</th><th class="num">Days</th><th class="num">Price</th></tr></thead>
    <tbody>${rows.map(roomRow).join('')}${otherRow}${rows.length || otherRow ? '' : '<tr><td colspan="10" class="note">Nothing to price: draw trim for this project in MODEL (each section in a room\'s subproject), or add scope items in PROJECTS.</td></tr>'}</tbody>
    <tfoot><tr><td>Total</td><td class="num">${trim ? Math.round(job.rooms.reduce((n, r) => n + r.trimLf, 0)) : ''}</td><td class="num">${trim ? job.rooms.reduce((n, r) => n + r.pieces, 0) : ''}</td><td class="num">${trim ? fm(job.boards) : ''}</td><td class="num">${trim ? fm(job.supplies) : ''}</td><td class="num">${trim ? hrs(job.hours.likely) : ''}</td><td class="num">${trim ? fm(job.labor.likely) : ''}</td><td class="num">${fm(job.itemCost.likely)}</td><td class="num">${days || ''}</td><td class="num">${fm(job.price.likely)}</td></tr></tfoot></table></div>
    <p class="note">Each room is cut from its own boards, so its cut list stands alone. Boards are bought at the cheapest store length that holds their cuts; the buy list adds ${plural(s.sparePerMoulding, 'spare board')} of each moulding. Hours come from published production rates counted from the drawing. Click a room to see its walls, boards and cut list.</p></section>`;
  const set = (key, label, value, unit, step) => `<label class="es-set"><span>${esc(label)}</span><span><input type="number" min="0" step="${step}" inputmode="decimal" data-set="${key}" value="${value}">${unit ? `<i>${unit}</i>` : ''}</span></label>`;
  const line = (label, v, k, sub) => `<tr data-d="cost:${k}"><td>${esc(label)}${sub ? `<span class="note"> ${esc(sub)}</span>` : ''}</td><td class="num">${fm(v.low)}</td><td class="num">${fm(v.likely)}</td><td class="num">${fm(v.high)}</td></tr>`;
  const one = v => ({ low: v, likely: v, high: v });
  const build = `<section class="es-sec"><h2>How the price is built</h2>
    <div class="es-sets">${set('laborRate', 'Carpenter rate', s.laborRate, '$/hr', 1)}${set('contingency', 'Contingency', +(s.contingency * 100).toFixed(2), '%', 1)}${set('markup', 'Overhead and profit', +(s.markup * 100).toFixed(2), '%', 1)}${set('taxRate', 'Tax on materials', +(s.taxRate * 100).toFixed(3), '%', 0.125)}${set('sparePerMoulding', 'Spare boards each', s.sparePerMoulding, '', 1)}</div>
    <div class="es-tbl"><table class="es-t es-build"><thead><tr><th></th><th class="num">Low</th><th class="num">Likely</th><th class="num">High</th></tr></thead><tbody>
      ${trim ? line('Boards and supplies', one(job.materials), 'materials', `${order} boards, supplies counted from the job`) + line('Carpenter', job.labor, 'labor', `${hrs(job.hours.likely)} hrs at ${fm(s.laborRate)}/hr; low and high from the rates' range`) : ''}
      ${job.itemCost.high ? line('Scope items', job.itemCost, 'items', 'priced in PROJECTS') : ''}
      <tr class="sub"><td>Cost</td><td class="num">${fm(job.cost.low)}</td><td class="num">${fm(job.cost.likely)}</td><td class="num">${fm(job.cost.high)}</td></tr>
      ${s.contingency ? line(`Contingency ${pct(s.contingency)}`, job.contingency, 'contingency') : ''}
      ${s.markup ? line(`Overhead and profit ${pct(s.markup)}`, job.markup, 'markup') : ''}
      ${s.taxRate ? line(`Tax ${pct(s.taxRate)} on ${fm(job.materials)} of materials`, one(job.tax), 'tax') : ''}
      <tr class="tot"><td>Price</td><td class="num">${fm(job.price.low)}</td><td class="num">${fm(job.price.likely)}</td><td class="num">${fm(job.price.high)}</td></tr></tbody></table></div></section>`;
  inner.innerHTML = head + warn + table + build + bidsHtml(job);
  bindJob(inner, job);
}

function roomBody(job, r) {
  const t = job.trim;
  const names = new Set(r.trim.map(x => x.name));
  const walls = t && !t.error ? t.walls.filter(w => names.has(w.room)) : [];
  const wallsHtml = walls.map(w => {
    const boards = t.boards.filter(b => b.wall === w.id);
    let elev = '', cuts = '';
    try { elev = elevationSvg(w, t, { maxW: 560, maxH: 230, fluid: true }); } catch (e) { elev = `<p class="note">${esc(e.message)}</p>`; }
    try { cuts = boards.length ? cutsHtml(boards, w.id, t, { fluid: true }) : '<p class="note">Cut from boards drawn under another wall.</p>'; } catch (e) { cuts = `<p class="note">${esc(e.message)}</p>`; }
    return `<div class="es-wall"><h4>${esc(w.name)} <span class="note">${fmtLen(w.h1 - w.h0)} wide · ${plural(t.pieces.filter(p => p.wall === w.id).length, 'piece')}</span></h4><div class="es-elev">${elev}</div><div class="es-cuts">${cuts}</div></div>`;
  }).join('');
  const groups = t && !t.error ? t.groups.filter(g => names.has(g.room)) : [];
  const cut = groups.length ? `<h3>Cut list</h3><div class="es-tbl"><table class="es-t es-cut"><thead><tr><th>Piece</th><th>Wood</th><th class="num">Qty</th><th class="num">Length</th><th>Ends, left / right</th><th>From board</th></tr></thead><tbody>
    ${groups.map(g => `<tr data-d="piece:${esc(g.mark)}"><td><b>${esc(g.name)}</b> <span class="note">${esc(g.mark)}</span></td><td class="nw">${esc(g.size)}</td><td class="num">${g.qty}</td><td class="num"><b>${lenIn(g.lin)}</b></td><td>${esc(g.endL)} / ${esc(g.endR)}</td><td class="note">${esc([...new Set(t.pieces.filter(p => p.mark === g.mark).map(p => p.stick))].join(', '))}</td></tr>`).join('')}</tbody></table></div>` : '';
  const labor = r.trim.flatMap(x => x.labor || []);
  const laborHtml = labor.length ? `<h3>Labor</h3><div class="es-tbl"><table class="es-t"><thead><tr><th>Task</th><th class="num">Quantity</th><th class="num">Hrs each</th><th class="num">Hours</th></tr></thead><tbody>
    ${labor.map(l => `<tr data-d="task:${esc(l.task)}"><td>${esc(l.label)}</td><td class="num">${fmtQ(l.qty)} ${esc(l.unit)}</td><td class="num">${l.rate}</td><td class="num">${hrs(l.hours)}</td></tr>`).join('')}</tbody></table></div>` : '';
  return `<div class="es-roombody">${walls.length ? `<h3>Walls and the boards they are cut from</h3>${wallsHtml}` : ''}${cut}${laborHtml}${r.items.length ? `<h3>Scope items</h3>${itemsTable(r.items)}` : ''}</div>`;
}
const fmtQ = q => Math.abs(q - Math.round(q)) < 1e-9 ? String(Math.round(q)) : (Math.round(q * 10) / 10).toString();
const itemsTable = items => `<div class="es-tbl"><table class="es-t"><thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Low</th><th class="num">Likely</th><th class="num">High</th><th class="num">Days</th></tr></thead><tbody>
  ${items.map(it => { const q = it.qty ?? 1; return `<tr data-d="item:${esc(it.id)}"><td>${esc(it.name || 'Item')}</td><td class="num">${fmtQ(q)} ${esc(it.unit || '')}</td><td class="num">${fm((it.low || 0) * q)}</td><td class="num">${fm((it.likely || 0) * q)}</td><td class="num">${fm((it.high || 0) * q)}</td><td class="num">${it.durationDays || ''}</td></tr>`; }).join('')}</tbody></table></div>`;

function bidsHtml(job) {
  const root = job.root, bids = root.bids || [], labor = job.labor.likely;
  return `<section class="es-sec"><h2>Bids received</h2>
    <p class="note">What carpenters quote for the labor on the installer bid form (DOCUMENTS), beside the estimate's ${fm(labor)} for ${hrs(job.hours.likely)} hours.</p>
    ${bids.length ? `<div class="es-tbl"><table class="es-t"><thead><tr><th>Bidder</th><th>Date</th><th class="num">Hours</th><th class="num">Amount</th><th class="num">Against the estimate</th><th></th></tr></thead><tbody>
      ${bids.map(b => { const d = (Number(b.amount) || 0) - labor; return `<tr><td><b>${esc(b.who)}</b>${b.scope ? `<span class="note"> ${esc(b.scope)}</span>` : ''}</td><td>${esc(b.date ? fmtDate(b.date) : '')}</td><td class="num">${b.hours ? hrs(b.hours) : ''}</td><td class="num">${fm(Number(b.amount) || 0)}</td><td class="num ${d > 0 ? 'over' : 'under'}">${labor ? (d >= 0 ? '+' : '−') + fm(Math.abs(d)) : ''}</td><td><button class="btn small ghost" data-del-bid="${esc(b.id)}">REMOVE</button></td></tr>`; }).join('')}</tbody></table></div>` : ''}
    <form class="es-bid" data-add-bid><input name="who" placeholder="Bidder" required aria-label="Bidder"><input name="hours" type="number" min="0" step="0.5" placeholder="Hours" aria-label="Hours"><input name="amount" placeholder="Amount" required aria-label="Amount"><input name="scope" placeholder="What it covers" aria-label="What it covers"><button class="btn small" type="submit">ADD BID</button></form></section>`;
}

const PCT = new Set(['contingency', 'markup', 'taxRate']);
function bindJob(inner, job) {
  const root = job.root;
  inner.querySelectorAll('[data-room]').forEach(tr => {
    const toggle = () => { const k = tr.dataset.room; if (open.has(k)) open.delete(k); else open.add(k); render(true); };
    tr.onclick = e => { if (!e.target.closest('[data-d]') || e.target.closest('td:first-child')) toggle(); };
    tr.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } };
  });
  inner.querySelectorAll('[data-set]').forEach(i => i.onchange = () => {
    const k = i.dataset.set, v = Number(i.value);
    if (!Number.isFinite(v) || v < 0) { i.value = PCT.has(k) ? +(JOB_DEFAULTS[k] * 100) : JOB_DEFAULTS[k]; return; }
    setJobSetting(root, k, PCT.has(k) ? v / 100 : v); touch(); render(true);
  });
  inner.querySelector('[data-remove-covered]')?.addEventListener('click', () => {
    if (!confirm(`Remove ${plural(job.covered.length, 'scope item')} the drawing now prices? REMOVED RECORDS in PROJECTS brings them back.`)) return;
    const prop = activeProperty();
    for (const x of job.tree) {
      const gone = (x.items || []).filter(it => job.covered.some(c => c.item === it));
      if (!gone.length) continue;
      keepRemoved(prop, 'item', gone, x.id);
      x.items = x.items.filter(it => !gone.includes(it));
    }
    touch(); render(true);
  });
  const form = inner.querySelector('[data-add-bid]');
  form.onsubmit = e => {
    e.preventDefault();
    const f = new FormData(form), amount = readMoney(String(f.get('amount') || ''));
    if (Number.isNaN(amount.value)) { const a = form.querySelector('[name=amount]'); a.setCustomValidity(amount.error); a.reportValidity(); return; }
    root.bids = [...(root.bids || []), { id: uid('bid'), who: String(f.get('who')).trim(), date: isoToday(), hours: Number(f.get('hours')) || 0, amount: amount.value, scope: String(f.get('scope') || '').trim() }];
    touch(); render(true);
  };
  inner.querySelectorAll('[data-del-bid]').forEach(b => b.onclick = () => { root.bids = (root.bids || []).filter(x => x.id !== b.dataset.delBid); if (!root.bids.length) delete root.bids; touch(); render(true); });
  inner.addEventListener('click', e => {
    const a = e.target.closest('[data-d]');
    if (!a || e.target.closest('input,button,select')) return;
    const key = a.dataset.d;
    if (hist[hpos] !== key) { hist = hist.slice(0, hpos + 1); hist.push(key); hpos = hist.length - 1; }
    paint();
  });
}

// ---------- the detail column ----------
function paint() {
  if (!el) return;
  const body = el.querySelector('#es-dbody'), key = hist[hpos], t = target();
  el.querySelector('[data-back]').disabled = hpos <= 0;
  el.querySelectorAll('.es-main .on').forEach(n => n.classList.remove('on', 'td-on'));
  const job = !t.program && projectById(t.id) ? jobOf(projectById(t.id)) : null;
  const d = key && job ? detail(key, job) : null;
  el.querySelector('#es-crumb').textContent = d ? d.kind : 'Details';
  if (!d) {
    body.innerHTML = t.program ? '<p class="note">Tick projects into the program to compare them with the budget cap. Each price is the project\'s estimate.</p>'
      : '<p class="note">Click a room to open its walls, boards and cut list. Click a piece, a board, a labor task, a scope item or a line of the price for where its numbers come from.</p>';
    return;
  }
  body.innerHTML = `<div class="d-title">${d.title}</div>${d.sub ? `<div class="d-sub">${d.sub}</div>` : ''}${d.html}${d.model ? `<p><button class="btn small" data-model>${icon('model')}SHOW IN THE MODEL</button></p>` : ''}`;
  body.querySelectorAll('[data-d]').forEach(a => a.onclick = () => { hist = hist.slice(0, hpos + 1); hist.push(a.dataset.d); hpos++; paint(); });
  body.querySelector('[data-model]')?.addEventListener('click', () => { if (modelBeside()) showInModel(d.model, { frame: 'always' }); else document.getElementById('btn-beside')?.click(); });
  el.querySelectorAll(`.es-main [data-d="${CSS.escape(key)}"]`).forEach(n => n.classList.add(n instanceof SVGElement ? 'td-on' : 'on'));
  el.querySelectorAll(`.es-main .td-on`).forEach(n => n.classList.add('on'));
}
const kv = rows => '<dl class="kv">' + rows.filter(r => r[1] !== '' && r[1] != null).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('') + '</dl>';
const link = (k, text) => `<a class="dl" data-d="${esc(k)}">${text}</a>`;
function detail(key, job) {
  const i = key.indexOf(':'), kind = key.slice(0, i), id = key.slice(i + 1), t = job.trim && !job.trim.error ? job.trim : null, s = job.settings;
  if (kind === 'piece' && t) {
    const g = t.groups.find(x => x.mark === id); if (!g) return null;
    const c = t.catalog[g.product] || catalogItem(g.product) || {};
    const boards = [...new Set(t.pieces.filter(p => p.mark === id).map(p => p.stick))].map(b => t.boards.find(x => x.id === b && x.room === g.room)).filter(Boolean);
    return { kind: 'Piece ' + id, title: esc(g.name), sub: `${esc(g.size)} ${esc(g.material || '')}`, html: kv([['Length', `<b>${lenIn(g.lin)}</b> long point`], ['How many', g.qty], ['Ends', `${esc(g.endL)} / ${esc(g.endR)}, left / right as you face the wall`], ['Moulding', `${esc(c.short || g.product)}<br><span class="note">${esc([c.brand, c.model, c.store].filter(Boolean).join(' · '))}</span>`], ['Room', esc(g.room)]])
      + (boards.length ? `<h4>Cut from</h4><ul>${boards.map(b => `<li>${link('stick:' + b.key, esc(b.id))}, ${b.kit ? 'kit' : lenIn(b.stockIn)} ${m2(b.price)}</li>`).join('')}</ul>` : ''), model: g.section ? [g.section] : null };
  }
  if (kind === 'stick' && t) {
    const b = t.boards.find(x => x.key === id); if (!b) return null;
    let svg = ''; try { svg = cutsHtml([b], b.wall, t, { fluid: true, lmax: b.stockIn }); } catch { /* none */ }
    return { kind: 'Board', title: esc(b.id) + ' · ' + esc(b.room), sub: `${esc(b.short)}, ${b.kit ? 'kit rail' : lenIn(b.stockIn)}${b.how === 'foot' ? ', cut to length at the store' : ''}, ${m2(b.price)}`,
      html: `<div class="es-cuts">${svg}</div>` + kv([['Left over', b.drop > 1 / 32 ? lenIn(b.drop) + (b.drop < 12 ? ' waste' : ' offcut') : 'nothing']]) + `<h4>Cuts, longest first</h4><ul>${b.cuts.map(c => `<li>${link('piece:' + c.mark, esc(c.mark))} ${esc(c.name)}: <b>${lenIn(c.lin)}</b></li>`).join('')}</ul>` };
  }
  if (kind === 'task' && t) {
    const task = t.labor.taskById[id]; if (!task) return null;
    const lines = t.rooms.flatMap(r => (r.labor || []).filter(l => l.task === id).map(l => ({ room: r.name, ...l })));
    const h = lines.reduce((n, l) => n + l.hours, 0);
    return { kind: 'Labor', title: esc(task.label), sub: `${task.hours} hrs per ${esc(task.unit_one || task.unit)} (low ${task.low ?? task.hours}, high ${task.high ?? task.hours})`,
      html: kv([['This job', `${hrs(h)} hrs, ${fm(h * s.laborRate)}`]]) + `<ul>${lines.map(l => `<li>${esc(l.room)}: ${fmtQ(l.qty)} ${esc(l.unit)} → ${hrs(l.hours)} hrs</li>`).join('')}</ul><h4>Where the rate comes from</h4><p>${esc(task.basis || '')}</p><p class="note">${esc(task.source || '')}</p>` };
  }
  if (kind === 'item') {
    const hit = job.tree.flatMap(x => (x.items || []).map(it => ({ x, it }))).find(y => y.it.id === id); if (!hit) return null;
    const { it, x } = hit, q = it.qty ?? 1;
    return { kind: 'Scope item', title: esc(it.name || 'Item'), sub: esc(x.name), html: kv([['Quantity', `${fmtQ(q)} ${esc(it.unit || '')}`], ['Each', `${fm(it.low || 0)} / ${fm(it.likely || 0)} / ${fm(it.high || 0)}`], ['Days', it.durationDays || ''], ['Notes', esc(it.notes || '')]]) + '<p><a class="btn small" href="#/projects">EDIT IN PROJECTS</a></p>', model: (it.elementIds || []).length ? it.elementIds : null };
  }
  if (kind === 'cost') {
    const text = {
      price: `The price to the client: the cost, then ${pct(s.contingency)} contingency, ${pct(s.markup)} overhead and profit and ${pct(s.taxRate)} tax on materials. Low and high carry each scope item's range and the labor rates' low and high hours.`,
      hours: 'Carpenter hours from published production rates (mostly Craftsman estimating books), counted from the drawing: feet of base, rail and cap, frames, battens, copes, outside corners, scarfs, caulk, fill and paint, and setup and cleanup each day in a room. A carpenter\'s own bid is the check.',
      days: 'Working days, Monday to Friday, one carpenter: each room takes its hours at 6 productive hours a day, at least a day, and the rooms follow one another in the order the subprojects are listed. SCHEDULE shows the dates.',
      order: 'Boards bought at the cheapest store length that holds their cuts (up to 12\'-0", or 13\'-0" when that buys less), each room from its own boards, plus the spares. The buy list with item numbers is in DOCUMENTS.',
      materials: 'Trim boards and supplies (nails, glue, adhesive, caulk, filler, primer, paint, protection, blades) at the store prices seen on the dates in the data.',
      labor: `Carpenter hours × ${fm(s.laborRate)}/hr.`, items: 'Installed prices typed in PROJECTS or taken from the price book, each with its own range.',
      contingency: 'For what the drawing cannot show: out-of-square walls, hidden conditions, a re-cut.', markup: 'Overhead and profit, on the cost and contingency.', tax: 'Sales tax on the boards and supplies bought. Scope items are installed prices; their tax is in them.',
    }[id];
    return text ? { kind: 'The price', title: esc({ price: 'Price', hours: 'Carpenter hours', days: 'Working days', order: 'Boards to buy', materials: 'Boards and supplies', labor: 'Carpenter', items: 'Scope items', contingency: 'Contingency', markup: 'Overhead and profit', tax: 'Tax' }[id]), html: `<p>${esc(text)}</p>` } : null;
  }
  return null;
}

// ---------- all projects: the program against the cap ----------
function renderProgram(inner) {
  const d = ws.data, cap = d.settings.budgetCap || 0;
  const tops = propertyProjects().filter(p => !p.parentId);
  const sel = programTotals(propertyProjects());
  const rows = tops.map(p => {
    const j = jobOf(p), on = p.selected || ws.data.projects.some(x => x.parentId === p.id && x.selected);
    return `<tr><td><label class="es-check"><input type="checkbox" data-sel="${esc(p.id)}" ${on ? 'checked' : ''} aria-label="In the program: ${esc(p.name)}"></label></td>
      <td><a href="#/estimate?project=${encodeURIComponent(p.id)}" data-job="${esc(p.id)}"><b>${esc(p.name || 'Project')}</b></a></td><td>${esc(p.status || '')}</td>
      <td class="num">${fm(j.price.low)}</td><td class="num"><b>${fm(j.price.likely)}</b></td><td class="num">${fm(j.price.high)}</td><td class="num">${j.schedule.days || ''}</td></tr>`;
  }).join('');
  const left = cap - sel.likely;
  inner.innerHTML = `<header class="es-head"><div class="es-kicker">All projects</div><h1>The program</h1>
    <div class="es-figs"><div class="big"><b>${fm(sel.likely)}</b><span>in the program${range(sel) ? ', ' + range(sel) : ''}</span></div>
      <div><b><input type="text" id="cap-input" value="${fm(cap)}" aria-label="Budget cap"></b><span id="cap-note">budget cap</span></div>
      <div class="${left < 0 ? 'over' : ''}"><b>${fm(Math.abs(left))}</b><span>${left < 0 ? 'over the cap' : 'left under the cap'}</span></div></div>
    <div class="es-acts"><button class="btn small" id="print-report">${icon('print')}PRINT REPORT</button></div></header>
    <section class="es-sec"><div class="es-tbl"><table class="es-t"><thead><tr><th></th><th>Project</th><th>Status</th><th class="num">Low</th><th class="num">Likely</th><th class="num">High</th><th class="num">Days</th></tr></thead><tbody>${rows || '<tr><td colspan="7" class="note">No projects.</td></tr>'}</tbody></table></div>
    <p class="note">A ticked project and its subprojects count in the program. Each price is the project's estimate: drawn trim and scope items with its markups.</p></section>`;
  const capIn = inner.querySelector('#cap-input');
  capIn.onchange = () => {
    const r = readMoney(capIn.value);
    if (Number.isNaN(r.value)) { inner.querySelector('#cap-note').textContent = r.error + ' The cap is still ' + fm(cap) + '.'; inner.querySelector('#cap-note').setAttribute('role', 'alert'); return; }
    d.settings.budgetCap = r.value; touch(); render(true);
  };
  inner.querySelectorAll('[data-sel]').forEach(c => c.onchange = () => {
    for (const x of ws.data.projects) if (x.id === c.dataset.sel || x.parentId === c.dataset.sel) x.selected = c.checked;
    touch(); render(true);
  });
  inner.querySelectorAll('[data-job]').forEach(a => a.onclick = e => { e.preventDefault(); go({ id: a.dataset.job }); });
  inner.querySelector('#print-report').onclick = () => printSheet(`<div class="sheet"><div class="sheet-page"><div class="s-head"><span class="s-brand">TIKSI</span><span class="s-doc">PROGRAM</span></div>
    <h1>${esc((activeProperty() || {}).name || '')}: the program</h1><p>Budget cap ${fm(cap)}; in the program ${fm(sel.likely)} (${fm(sel.low)} to ${fm(sel.high)}); ${left < 0 ? fm(-left) + ' over' : fm(left) + ' under'} the cap.</p>
    <table class="grid"><thead><tr><th>Project</th><th>In the program</th><th class="num">Low</th><th class="num">Likely</th><th class="num">High</th></tr></thead><tbody>
    ${tops.map(p => { const j = jobOf(p); return `<tr><td>${esc(p.name)}</td><td>${p.selected ? 'yes' : 'no'}</td><td class="num">${fm(j.price.low)}</td><td class="num">${fm(j.price.likely)}</td><td class="num">${fm(j.price.high)}</td></tr>`; }).join('')}</tbody></table></div></div>`);
}
