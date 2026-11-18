// ESTIMATE: what a job costs, room by room, and how the price is built (job.js).
//
// Left: the projects (a top-level project with its rooms), ALL PROJECTS (the program against the
// budget cap) and who does the work.
// Middle: the job's price, then one table of its rooms (drawn trim and scope items), the price
// build-up with its settings, and bids received. Opening a room shows its walls as drawn with the
// boards each is cut from, its cut list and its labor. Right: whatever was clicked (a piece, a
// board, a labor task, a scope item), with where its numbers come from.
//
// Addresses: #/estimate?project=<id>, #/estimate?program, and the old #/budget (the program).

import {
  ws, touch, onChange, activeProperty, propertyProjects, projectById, escapeHtml, fmtLen, readMoney, uid, isoToday, fmtDate, subprojectsOf,
} from './store.js';
import { jobOf, rootOf, setJobSetting, JOB_DEFAULTS, installers, installerById, addInstaller, removeInstaller, setInstallerTime, setJobWho, setRoomLabor } from './job.js';
import { ensureBoardProducts, storeItems, productForKey, productForBoard, feetInches } from './job-products.js';
import { ESTIMATE_DATA } from './estimate-data.js';
import { newItem, itemRowHtml, ITEM_HEAD, bindItemRow, removeItem, addMeasured, itemDetailHtml, bindItemDetail } from './scope-items.js';
import { setScopeTarget, whenModelBeside } from './model-focus.js';
import { programTotals } from './program.js';
import { elevationSvg, cutsHtml } from './trim-drawings.js';
import { catalogItem } from './trim-catalog.js';
import { keepRemoved } from './recovery.js';
import { takeoffState } from './source-revision.js';
import { costAreas, costAreaFor, repriceProject } from './scope-takeoff.js';
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
const lenIn = inches => fmtLen(inches * IN);

let el = null, off = null, timer = null;
let capProblem = '';   // a cap typed that could not be read, and why; kept until a good one is typed
let hist = [], hpos = -1;
const open = new Set();          // rooms opened in the table
let lastRoom = '';               // the room opened last: where a thing measured in the model is added
let itemProblem = null;          // { id, text }: a price typed that could not be read, and why
let outlined = '';               // what the model beside the page last outlined (a project, room or item)

// What a project, a room or a scope item is linked to in the model: rooms, walls, openings, imported
// models, and drawn trim sections. With the model beside the page, opening one outlines these.
function linkedIds(projects, items) {
  const ids = [];
  for (const x of projects) {
    if (x.roomId) ids.push(x.roomId);
    for (const it of x.items || []) ids.push(...(it.elementIds || []));
  }
  for (const it of items || []) { const t = it.takeoff || {}; ids.push(...(t.faceIds || []), ...(t.objectKeys || []), ...(it.elementIds || [])); }
  return [...new Set(ids)];
}
// Outlined once per opening, not on every redraw.
function outline(key, ids) {
  if (!modelBeside() || outlined === key || !ids.length) return;
  outlined = key;
  showInModel(ids);
}
let shownJob = '', paintedKey = '', offBeside = null;
const LAST = 'tiksi.estimate.last.';

function target() {
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  if (/^#\/budget/.test(location.hash) || q.has('program')) return { program: true };
  if (q.has('who')) return { who: q.get('who') };
  const id = q.get('project');
  if (id && projectById(id)) return { id: rootOf(projectById(id)).id };
  const tops = propertyProjects().filter(p => !p.parentId);
  let last = '';
  try { last = localStorage.getItem(LAST + (activeProperty() || {}).id) || ''; } catch { /* not kept */ }
  if (last && tops.some(p => p.id === last)) return { id: last };
  return tops.length ? { id: tops[0].id } : { none: true };
}
function go(t) {
  if (!t.who) try { localStorage.setItem(LAST + (activeProperty() || {}).id, t.program ? 'program' : t.id); } catch { /* fine */ }
  history.replaceState(null, '', t.who ? '#/estimate?who=' + encodeURIComponent(t.who) : t.program ? '#/estimate?program' : '#/estimate?project=' + encodeURIComponent(t.id));
  hist = []; hpos = -1; open.clear();
  render();
  el?.querySelector('.es-main')?.scrollTo(0, 0);
}

export function mount(root) {
  el = root;
  // The model opened beside the page outlines the project shown.
  offBeside = whenModelBeside(() => { outlined = ''; shownJob = ''; render(true); });
  off = onChange(() => { clearTimeout(timer); timer = setTimeout(() => { if (el && !el.querySelector('.es :is(input,select,textarea):focus')) render(true); }, 150); });
  render();
}
export function unmount() { clearTimeout(timer); if (off) off(); off = null; if (offBeside) offBeside(); offBeside = null; el = null; capProblem = ''; itemProblem = null; outlined = ''; shownJob = ''; paintedKey = ''; setScopeTarget(null); }
export function undo() { if (restoreProjectEdit('undo')) render(true); }
export function redo() { if (restoreProjectEdit('redo')) render(true); }

// After a typed change: drawn once the cursor has moved on, so Tab lands in the next box.
const soon = () => setTimeout(() => render(true), 0);

function render(keep) {
  if (!el) return;
  // Typing on from one box to the next survives the redraw a change makes.
  const f = document.activeElement;
  let again = null;
  if (f && el.contains(f) && f.dataset) {
    const k = ['lq', 'le', 'wt', 'wf', 'siF', 'siMoney', 'jf'].find(x => f.dataset[x]);
    const attr = k && k.replace(/[A-Z]/g, c => '-' + c.toLowerCase()), row = f.closest('tr[data-si]');
    if (k) again = (row ? `tr[data-si="${CSS.escape(row.dataset.si)}"] ` : '') + `[data-${attr}="${CSS.escape(f.dataset[k])}"]`;
  }
  if (again) queueMicrotask(() => { const n = el && el.querySelector(again); if (n) { n.focus(); if (n.select) n.select(); } });
  const t = target(), prop = activeProperty();
  const tops = propertyProjects().filter(p => !p.parentId);
  const scroll = keep ? el.querySelector('.es-main')?.scrollTop || 0 : 0;
  const nav = `<nav class="es-nav" aria-label="Projects">
      <a class="es-job ${t.program ? 'here' : ''}" href="#/estimate?program" data-program><span>All projects</span><span class="m">${fm(programTotals(propertyProjects()).likely)}</span></a>
      <div class="gl">Projects</div>
      ${tops.map(p => { const j = jobOf(p); return `<a class="es-job ${t.id === p.id ? 'here' : ''}" href="#/estimate?project=${encodeURIComponent(p.id)}" data-job="${esc(p.id)}"><span>${esc(p.name || 'Project')}</span><span class="m">${j ? fm(j.price.likely) : ''}</span></a>`; }).join('')}
      ${prop ? '<button type="button" class="es-job es-add" data-new-job>+ New project</button>' : ''}
      <div class="gl">Who does the work</div>
      ${installers().map(x => `<a class="es-job ${t.who === x.id ? 'here' : ''}" href="#/estimate?who=${encodeURIComponent(x.id)}" data-who="${esc(x.id)}"><span>${esc(x.name)}</span><span class="m">${fm(x.rate)}/hr</span></a>`).join('')}
      <button type="button" class="es-job es-add" data-add-who>+ Add a carpenter or crew</button>
    </nav>`;
  el.innerHTML = `<div class="es">${nav}<main class="es-main"><div class="es-in" id="es-in"></div></main>
    <aside class="es-det" aria-label="Details"><div class="es-dbar"><button type="button" data-back aria-label="Back" disabled>‹</button><span class="crumb" id="es-crumb">Details</span><button type="button" data-close aria-label="Close">×</button></div><div class="es-dbody" id="es-dbody"></div></aside></div>`;
  el.querySelector('[data-program]').onclick = e => { e.preventDefault(); go({ program: true }); };
  el.querySelectorAll('[data-job]').forEach(a => a.onclick = e => { e.preventDefault(); go({ id: a.dataset.job }); });
  el.querySelectorAll('[data-who]').forEach(a => a.onclick = e => { e.preventDefault(); go({ who: a.dataset.who }); });
  el.querySelector('[data-new-job]')?.addEventListener('click', () => {
    const p = newJob(prop); touch(); go({ id: p.id });
    setTimeout(() => { const n = el?.querySelector('[data-jf="name"]'); if (n) { n.focus(); n.select(); } }, 0);
  });
  el.querySelector('[data-add-who]').onclick = () => { const x = addInstaller({ name: 'New carpenter' }); touch(); go({ who: x.id }); setTimeout(() => el?.querySelector('[data-wf="name"]')?.select(), 0); };
  el.querySelector('[data-back]').onclick = () => { if (hpos > 0) { hpos--; paint(); } };
  el.querySelector('[data-close]').onclick = () => { hist = []; hpos = -1; paint(); };
  const inner = el.querySelector('#es-in');
  if (!prop) inner.innerHTML = '<p class="note">Open or make a property first (FILE).</p>';
  else if (t.program) renderProgram(inner, prop);
  else if (t.who) renderWho(inner, installerById(t.who));
  else if (t.id) renderJob(inner, jobOf(projectById(t.id)), prop);
  else inner.innerHTML = '<header class="es-head"><h1>No projects yet</h1></header><p class="note">A project is one piece of work on this property: its rooms, what is done in each and what it costs. Start one with + NEW PROJECT on the left.</p>';
  el.querySelector('.es-main').scrollTop = scroll;
  paint();
}

// ---------- one job ----------
function renderJob(inner, job, prop) {
  const s = job.settings, root = job.root, trim = job.trim && !job.trim.error ? job.trim : null;
  const days = job.schedule.days;
  const order = trim ? trim.buy.reduce((n, b) => n + b.order, 0) : 0;
  const rows = job.rooms;   // every subproject is a row, priced or not yet
  const tk = takeoffState(root, prop);
  const head = `<header class="es-head"><div class="es-kicker">${esc(prop ? prop.name || '' : '')}</div><h1><textarea class="es-title" data-jf="name" rows="1" placeholder="Project name" aria-label="Project name">${esc(root.name || '')}</textarea></h1>
    <div class="es-acts"><select data-jf="status" aria-label="Status">${STATUSES.map(([k, l]) => `<option value="${k}" ${(root.status || 'idea') === k ? 'selected' : ''}>${l}</option>`).join('')}</select><a class="btn small" href="#/schedule?project=${encodeURIComponent(root.id)}">${icon('schedule')}SCHEDULE</a><a class="btn small" href="#/documents?job=${encodeURIComponent(root.id)}">${icon('print')}DOCUMENTS</a><button type="button" class="btn small ghost danger" data-del-job>DELETE</button></div>
    <textarea class="es-notes" data-jf="notes" rows="${root.notes ? 3 : 1}" placeholder="Notes: what the client asked for, what to check" aria-label="Project notes">${esc(root.notes || '')}</textarea>
    ${tk && !/^current/.test(tk) ? `<div class="es-note ${/stale|missing/.test(tk) ? 'bad' : ''}">Quantities measured from the model: ${esc(tk)}.</div>` : ''}</header>`;
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
  const unpriced = job.other.items.filter(it => !it.likely).length;
  const otherRow = `<tr class="es-room ${open.has('other') ? 'open' : ''}" data-room="other" tabindex="0"><td><span class="tw">${open.has('other') ? '▾' : '▸'}</span><b>Project-wide items</b></td><td colspan="6" class="note">${job.other.items.length ? (unpriced ? plural(unpriced, 'item') + ' without a price' : '') : 'none yet'}</td><td class="num">${job.other.itemCost.high ? fm(job.other.itemCost.likely) : ''}</td><td></td><td class="num"><b>${job.other.items.length ? fm(job.other.price.likely) : ''}</b></td></tr>
      ${open.has('other') ? `<tr class="es-open"><td colspan="10"><div class="es-roombody"><p class="note">Work for the whole project rather than one room: permits, protection, a dumpster, measuring and ordering.</p>${itemsTable(root, job.other.items)}</div></td></tr>` : ''}`;
  const table = `<section class="es-sec"><h2>Rooms</h2>
    <div class="es-tbl"><table class="es-t es-rooms"><thead><tr><th>Room</th><th class="num">Trim LF</th><th class="num">Pieces</th><th class="num">Boards</th><th class="num">Supplies</th><th class="num">Hours</th><th class="num">Labor</th><th class="num">Scope items</th><th class="num">Days</th><th class="num">Price</th></tr></thead>
    <tbody>${rows.map(roomRow).join('')}${otherRow}${rows.length || otherRow ? '' : '<tr><td colspan="10" class="note">No rooms yet: add one below, then draw its trim in MODEL or add its scope items here.</td></tr>'}</tbody>
    <tfoot><tr><td>Total</td><td class="num">${trim ? Math.round(job.rooms.reduce((n, r) => n + r.trimLf, 0)) : ''}</td><td class="num">${trim ? job.rooms.reduce((n, r) => n + r.pieces, 0) : ''}</td><td class="num">${trim ? fm(job.boards) : ''}</td><td class="num">${trim ? fm(job.supplies) : ''}</td><td class="num">${trim ? hrs(job.hours.likely) : ''}</td><td class="num">${trim ? fm(job.labor.likely) : ''}</td><td class="num">${fm(job.itemCost.likely)}</td><td class="num">${days || ''}</td><td class="num">${fm(job.price.likely)}</td></tr></tfoot></table></div>
    ${addRoomHtml(job, prop)}
    <p class="note">Each room is cut from its own boards, so its cut list stands alone. Boards are bought at the cheapest store length that holds their cuts, at the prices in PRODUCTS; the buy list adds ${plural(s.sparePerMoulding, 'spare board')} of each moulding. Hours are each task's quantity, counted from the drawing, times ${s.who ? esc(s.who.name) + "'s" : 'the published'} time; open a room to type over either. Click a room to see its walls, boards, cut list and labor.</p></section>`;
  const set = (key, label, value, unit, step) => `<label class="es-set"><span>${esc(label)}</span><span><input type="number" min="0" step="${step}" inputmode="decimal" data-set="${key}" value="${value}">${unit ? `<i>${unit}</i>` : ''}</span></label>`;
  const line = (label, v, k, sub) => `<tr data-d="cost:${k}"><td>${esc(label)}${sub ? `<span class="note"> ${esc(sub)}</span>` : ''}</td><td class="num">${fm(v.low)}</td><td class="num">${fm(v.likely)}</td><td class="num">${fm(v.high)}</td></tr>`;
  const one = v => ({ low: v, likely: v, high: v });
  const build = `<section class="es-sec"><h2>How the price is built</h2>
    <div class="es-sets"><label class="es-set"><span>Who does it</span><span><select data-job-who aria-label="Who does the trim"><option value="">Published times</option>${installers().map(x => `<option value="${esc(x.id)}" ${s.who && s.who.id === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></span></label>${s.who ? `<label class="es-set"><span>${esc(s.who.name)}'s rate</span><span><input type="number" min="0" step="1" inputmode="decimal" data-who-rate value="${s.who.rate}"><i>$/hr</i></span></label>` : set('laborRate', 'Carpenter rate', s.laborRate, '$/hr', 1)}${set('contingency', 'Contingency', +(s.contingency * 100).toFixed(2), '%', 1)}${set('markup', 'Overhead and profit', +(s.markup * 100).toFixed(2), '%', 1)}${set('taxRate', 'Tax on materials', +(s.taxRate * 100).toFixed(3), '%', 0.125)}${set('sparePerMoulding', 'Spare boards each', s.sparePerMoulding, '', 1)}<label class="es-set"><span>Price book area</span><span><select data-cost-area aria-label="Prices for this area">${costAreas().map(a => `<option value="${esc(a.id)}" ${a.id === costAreaFor(root, prop) ? 'selected' : ''}>${esc(a.label + (a.factor !== 1 ? ' ×' + a.factor : ''))}</option>`).join('')}</select></span></label></div>
    <div class="es-tbl"><table class="es-t es-build"><thead><tr><th></th><th class="num">Low</th><th class="num">Likely</th><th class="num">High</th></tr></thead><tbody>
      ${trim ? line('Boards and supplies', one(job.materials), 'materials', `${order} boards, supplies counted from the job`) + line(s.who ? s.who.name : 'Carpenter', job.labor, 'labor', `${hrs(job.hours.likely)} hrs at ${fm(s.laborRate)}/hr; low and high from the published times' range`) : ''}
      ${job.itemCost.high ? line('Scope items', job.itemCost, 'items', 'each room\'s and the project\'s own') : ''}
      <tr class="sub"><td>Cost</td><td class="num">${fm(job.cost.low)}</td><td class="num">${fm(job.cost.likely)}</td><td class="num">${fm(job.cost.high)}</td></tr>
      ${s.contingency ? line(`Contingency ${pct(s.contingency)}`, job.contingency, 'contingency') : ''}
      ${s.markup ? line(`Overhead and profit ${pct(s.markup)}`, job.markup, 'markup') : ''}
      ${s.taxRate ? line(`Tax ${pct(s.taxRate)} on ${fm(job.materials)} of materials`, one(job.tax), 'tax') : ''}
      <tr class="tot"><td>Price</td><td class="num">${fm(job.price.low)}</td><td class="num">${fm(job.price.likely)}</td><td class="num">${fm(job.price.high)}</td></tr></tbody></table></div></section>`;
  inner.innerHTML = head + warn + table + build + bidsHtml(job);
  bindJob(inner, job);
  // Opening a project with the model beside the page outlines everything it is linked to.
  if (shownJob !== root.id) { shownJob = root.id; outline('job:' + root.id, linkedIds(job.tree)); }
  // A thing right-clicked in MODEL BESIDE is added to the room opened last, else to the project.
  const into = (lastRoom && open.has(lastRoom) && job.rooms.find(r => r.key === lastRoom && r.project !== root)) || null;
  const target = into ? into.project : root;
  setScopeTarget({ name: into ? into.name : (root.name || 'the project'), add: measured => {
    const it = addMeasured(target, measured); open.add(into ? into.key : 'other'); touch(); render(true);
    el?.querySelector(`tr[data-si="${CSS.escape(it.id)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  } });
  // The boards bought are PRODUCTS records (their store pages and prices); make any missing.
  if (trim && ensureBoardProducts(trim, prop)) touch();
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
  const who = job.settings.who;
  const k = esc(r.key);
  const shown = new Set(labor.map(l => l.task));
  const more = r.trim.length ? (ESTIMATE_DATA.labor.tasks || []).filter(x => !shown.has(x.id)) : [];
  const laborHtml = labor.length ? `<h3>Labor <span class="note">${who ? `${esc(who.name)}'s times` : 'published times'}; type over a quantity or a time to change it for this room</span></h3><div class="es-tbl"><table class="es-t es-labor"><thead><tr><th>Task</th><th class="num">Quantity</th><th></th><th class="num">Hrs each</th><th class="num">Hours</th><th></th></tr></thead><tbody>
    ${labor.map(l => { const set = l.qtySet || l.eachSet === 'room'; return `<tr data-lt="${esc(r.key)}|${esc(l.task)}" class="${set ? 'typed' : ''}"><td data-d="task:${esc(l.task)}" class="lk">${esc(l.label)}</td>
      <td class="num"><input class="es-cell ${l.qtySet ? 'set' : ''}" type="number" min="0" step="any" inputmode="decimal" data-lq="${k}|${esc(l.task)}" value="${fmtQ(l.qty)}" aria-label="${esc(l.label)}: quantity" title="${l.qtySet ? 'Typed; the drawing counts ' + fmtQ(l.counted) : 'Counted from the drawing'}"></td><td class="unit">${esc(Math.abs(l.qty - 1) < 1e-9 ? l.unitOne || l.unit : l.unit)}</td>
      <td class="num"><input class="es-cell ${l.eachSet === 'room' ? 'set' : ''}" type="number" min="0" step="any" inputmode="decimal" data-le="${k}|${esc(l.task)}" value="${+l.rate.toFixed(4)}" aria-label="${esc(l.label)}: hours each" title="${l.eachSet === 'room' ? 'Typed for this room; ' + (who && who.each && who.each[l.task] != null ? esc(who.name) + "'s time is " + who.each[l.task] : 'the published time is ' + l.published) : l.eachSet === 'who' ? esc(who.name) + "'s time (published " + l.published + ')' : 'Published time'}"></td>
      <td class="num">${hrs(l.hours)}</td><td>${set ? `<button type="button" class="btn small ghost" data-lr="${k}|${esc(l.task)}" title="Back to the drawing's count and ${who ? esc(who.name) + "'s" : 'the published'} time">RESET</button>` : ''}</td></tr>`; }).join('')}</tbody></table></div>
    ${more.length ? `<select class="es-addtask" data-addtask="${k}" aria-label="Add a task to this room"><option value="">+ Add a task the drawing does not count</option>${more.map(x => `<option value="${esc(x.id)}">${esc(x.label)} (${esc(x.unit)})</option>`).join('')}</select>` : ''}` : '';
  // Items belong to the room's subproject; a room whose trim the project holds directly has none
  // of its own (its items are the project-wide ones).
  const own = r.project !== job.root;
  const head = own ? `<div class="es-roomhead"><label>Name <input class="es-cell text" data-rf="name" data-room-of="${esc(r.project.id)}" value="${esc(r.project.name || '')}"></label>
    <label>Room in the model <select data-rf="roomId" data-room-of="${esc(r.project.id)}"><option value="">None</option>${(activeProperty()?.rooms || []).map(x => `<option value="${esc(x.id)}" ${r.project.roomId === x.id ? 'selected' : ''}>${esc(x.name || 'Room')}</option>`).join('')}</select></label>
    <button type="button" class="btn small ghost danger" data-del-room="${esc(r.project.id)}">REMOVE THIS ROOM</button></div>` : '';
  const items = own ? `<h3>Scope items <span class="note">everything else done in this room, each priced per unit</span></h3>${itemsTable(r.project, r.items)}` : '';
  return `<div class="es-roombody">${head}${walls.length ? `<h3>Walls and the boards they are cut from</h3>${wallsHtml}` : ''}${cut}${laborHtml}${items}</div>`;
}
const fmtQ = q => Math.abs(q - Math.round(q)) < 1e-9 ? String(Math.round(q)) : (Math.round(q * 10) / 10).toString();
const itemsTable = (project, items) => `${items.length ? `<div class="es-tbl"><table class="es-t es-items" data-items-of="${esc(project.id)}">${ITEM_HEAD}<tbody>
  ${items.map(it => itemRowHtml(it, itemProblem)).join('')}</tbody></table></div>` : ''}
  <p class="es-itemacts"><button type="button" class="btn small" data-add-item="${esc(project.id)}">+ ADD ITEM</button>${items.length ? '' : ' <span class="note">or right-click a room, wall, door or object in MODEL BESIDE to add it measured</span>'}</p>`;

function bidsHtml(job) {
  const root = job.root, bids = root.bids || [], labor = job.labor.likely;
  return `<section class="es-sec"><h2>Bids received</h2>
    <p class="note">What carpenters quote for the labor on the installer bid form (DOCUMENTS), beside the estimate's ${fm(labor)} for ${hrs(job.hours.likely)} hours.</p>
    ${bids.length ? `<div class="es-tbl"><table class="es-t"><thead><tr><th>Bidder</th><th>Date</th><th class="num">Hours</th><th class="num">Amount</th><th class="num">Against the estimate</th><th></th></tr></thead><tbody>
      ${bids.map(b => { const d = (Number(b.amount) || 0) - labor; return `<tr><td><b>${esc(b.who)}</b>${b.scope ? `<span class="note"> ${esc(b.scope)}</span>` : ''}</td><td>${esc(b.date ? fmtDate(b.date) : '')}</td><td class="num">${b.hours ? hrs(b.hours) : ''}</td><td class="num">${fm(Number(b.amount) || 0)}</td><td class="num ${d > 0 ? 'over' : 'under'}">${labor ? (d >= 0 ? '+' : '−') + fm(Math.abs(d)) : ''}</td><td><button class="btn small ghost" data-del-bid="${esc(b.id)}">REMOVE</button></td></tr>`; }).join('')}</tbody></table></div>` : ''}
    <form class="es-bid" data-add-bid><input name="who" placeholder="Bidder" required aria-label="Bidder"><input name="hours" type="number" min="0" step="0.5" placeholder="Hours" aria-label="Hours"><input name="amount" placeholder="Amount" required aria-label="Amount"><input name="scope" placeholder="What it covers" aria-label="What it covers"><button class="btn small" type="submit">ADD BID</button></form></section>`;
}

const PCT = new Set(['contingency', 'markup', 'taxRate']);
// Where a project stands.
const STATUSES = [['idea', 'Idea'], ['scoped', 'Scoped'], ['committed', 'Committed'], ['in-progress', 'In progress'], ['done', 'Done']];

function newJob(prop) {
  const p = { id: uid('proj'), name: 'New project', propertyId: prop.id, category: 'interior', status: 'idea', selected: true, startDate: '', notes: '', items: [], parentId: '', roomId: '', source: '' };
  ws.data.projects.push(p);
  return p;
}
// A room of a job is a subproject; it usually stands for a room in the model.
function addRoomHtml(job, prop) {
  const used = new Set(subprojectsOf(job.root).map(x => x.roomId).filter(Boolean));
  const free = (prop?.rooms || []).filter(r => !used.has(r.id));
  return `<p class="es-itemacts"><select data-add-room aria-label="Add a room to this project"><option value="">+ Add a room</option>${free.map(r => `<option value="${esc(r.id)}">${esc(r.name || 'Room')}</option>`).join('')}<option value="-">A room or area not in the model</option></select></p>`;
}
function bindJob(inner, job) {
  const root = job.root;
  inner.querySelectorAll('[data-room]').forEach(tr => {
    const toggle = () => {
      const k = tr.dataset.room;
      if (open.has(k)) open.delete(k);
      else {
        open.add(k); lastRoom = k;
        const r = job.rooms.find(x => x.key === k);
        if (r) outline('room:' + k, [...linkedIds(r.project !== root ? [r.project] : [], r.items), ...r.trim.flatMap(x => (job.trim.pieces || []).filter(q => q.room === x.name).map(q => q.section)).filter(Boolean)]);
        else if (k === 'other') outline('other:' + root.id, linkedIds([], job.other.items));
      }
      render(true);
    };
    tr.onclick = e => { if (e.target.closest('input,select,button')) return; if (!e.target.closest('[data-d]') || e.target.closest('td:first-child')) toggle(); };
    tr.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } };
  });
  // The project itself: name, status, notes, price area, deleting it; its rooms.
  // The name wraps like a heading; Enter keeps it rather than starting a new line.
  inner.querySelector('textarea[data-jf="name"]').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } };
  inner.querySelectorAll('[data-jf]').forEach(i => i.onchange = () => { const f = i.dataset.jf; root[f] = f === 'name' ? (i.value.trim() || 'Project') : i.value; touch(); soon(); });
  inner.querySelector('[data-cost-area]')?.addEventListener('change', e => { root.costArea = e.target.value; for (const x of job.tree) repriceProject(x, root.costArea); touch(); soon(); });
  inner.querySelector('[data-del-job]').onclick = () => {
    const subs = subprojectsOf(root);
    if (!confirm(`Delete "${root.name}"${subs.length ? ` and its ${plural(subs.length, 'room')}` : ''}, with everything priced in it? REMOVED RECORDS (FILE) brings it back.`)) return;
    const gone = new Set([root.id, ...subs.map(x => x.id)]);
    keepRemoved(activeProperty(), 'projects', ws.data.projects.filter(x => gone.has(x.id)));
    ws.data.projects = ws.data.projects.filter(x => !gone.has(x.id));
    touch(); go(target());
  };
  inner.querySelector('[data-add-room]')?.addEventListener('change', e => {
    const v = e.target.value; if (!v) return;
    const r = v !== '-' && (activeProperty()?.rooms || []).find(x => x.id === v);
    const sub = { id: uid('proj'), name: r ? r.name || 'Room' : 'New room', propertyId: root.propertyId, parentId: root.id, roomId: r ? r.id : '', category: root.category || 'interior', status: root.status || 'idea', selected: root.selected !== false, startDate: '', notes: '', items: [], source: '' };
    ws.data.projects.push(sub); open.add(sub.id); lastRoom = sub.id; touch(); render(true);
    if (!r) setTimeout(() => { const n = el?.querySelector(`[data-rf="name"][data-room-of="${CSS.escape(sub.id)}"]`); if (n) { n.focus(); n.select(); } }, 0);
  });
  inner.querySelectorAll('[data-rf]').forEach(i => i.onchange = () => { const x = projectById(i.dataset.roomOf); if (!x) return; x[i.dataset.rf] = i.dataset.rf === 'name' ? (i.value.trim() || 'Room') : i.value; touch(); soon(); });
  inner.querySelectorAll('[data-del-room]').forEach(b => b.onclick = () => {
    const x = projectById(b.dataset.delRoom); if (!x) return;
    const trim = (activeProperty()?.trims || []).filter(t => t.projectId === x.id).length;
    if (!confirm(`Remove ${x.name} from this project${x.items.length ? `, with its ${plural(x.items.length, 'scope item')}` : ''}?${trim ? ` Its ${plural(trim, 'trim section')} stay in the model, no longer priced.` : ''} REMOVED RECORDS (FILE) brings it back.`)) return;
    keepRemoved(activeProperty(), 'projects', [x]);
    ws.data.projects = ws.data.projects.filter(y => y !== x);
    open.delete(x.id); touch(); render(true);
  });

  // Scope items: their rows, adding and removing.
  const redraw = problem => { itemProblem = problem || null; touch(); soon(); };
  inner.querySelectorAll('table[data-items-of]').forEach(tb => {
    const project = projectById(tb.dataset.itemsOf);
    tb.querySelectorAll('tr[data-si]').forEach(tr => { const it = (project.items || []).find(x => x.id === tr.dataset.si); if (it) bindItemRow(tr, project, it, redraw); });
  });
  inner.querySelectorAll('[data-add-item]').forEach(b => b.onclick = () => {
    const project = projectById(b.dataset.addItem), it = newItem();
    project.items = [...(project.items || []), it]; touch(); render(true);
    const n = el && el.querySelector(`tr[data-si="${CSS.escape(it.id)}"] [data-si-f="name"]`); if (n) { n.focus(); n.select(); }
  });
  inner.querySelectorAll('[data-si-del]').forEach(b => b.onclick = () => {
    const hit = job.tree.flatMap(x => (x.items || []).map(it => ({ x, it }))).find(y => y.it.id === b.dataset.siDel);
    if (!hit || !confirm(`Remove "${hit.it.name || 'this item'}"? REMOVED RECORDS brings it back.`)) return;
    removeItem(hit.x, hit.it, job.tree); touch(); render(true);
  });
  const lab = (sel, f) => inner.querySelectorAll(sel).forEach(i => i.onchange = () => {
    const [key, task] = i.dataset[f === 'qty' ? 'lq' : 'le'].split('|');
    if (i.value !== '' && !(Number(i.value) >= 0)) { render(true); return; }
    setRoomLabor(root, key, f, task, i.value === '' ? null : i.value); touch(); soon();
  });
  lab('[data-lq]', 'qty'); lab('[data-le]', 'each');
  inner.querySelectorAll('[data-lr]').forEach(b => b.onclick = () => { const [key, task] = b.dataset.lr.split('|'); setRoomLabor(root, key, 'qty', task, null); setRoomLabor(root, key, 'each', task, null); touch(); render(true); });
  inner.querySelectorAll('[data-addtask]').forEach(sel => sel.onchange = () => { if (!sel.value) return; setRoomLabor(root, sel.dataset.addtask, 'qty', sel.value, 1); touch(); render(true); });
  inner.querySelector('[data-job-who]')?.addEventListener('change', e => { setJobWho(root, e.target.value); touch(); render(true); });
  inner.querySelector('[data-who-rate]')?.addEventListener('change', e => { const v = Number(e.target.value); if (!(v >= 0)) { render(true); return; } job.settings.who.rate = v; touch(); render(true); });
  inner.querySelectorAll('[data-set]').forEach(i => i.onchange = () => {
    const k = i.dataset.set, v = Number(i.value);
    if (!Number.isFinite(v) || v < 0) { i.value = PCT.has(k) ? +(JOB_DEFAULTS[k] * 100) : JOB_DEFAULTS[k]; return; }
    setJobSetting(root, k, PCT.has(k) ? v / 100 : v); touch(); soon();
  });
  inner.querySelector('[data-remove-covered]')?.addEventListener('click', () => {
    if (!confirm(`Remove ${plural(job.covered.length, 'scope item')} the drawing now prices? REMOVED RECORDS (FILE) brings them back.`)) return;
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
  const job = !t.program && !t.who && projectById(t.id) ? jobOf(projectById(t.id)) : null;
  const d = key ? detail(key, job) : null;
  el.querySelector('#es-crumb').textContent = d ? d.kind : 'Details';
  if (!d) {
    paintedKey = '';
    body.innerHTML = t.who ? '<p class="note">Click a task for where its published time comes from.</p>' : t.program ? '<p class="note">Tick projects into the program to compare them with the budget cap. Each price is the project\'s estimate.</p>'
      : '<p class="note">Click a room to open its walls, boards and cut list. Click a piece, a board, a labor task, a scope item or a line of the price for where its numbers come from.</p>';
    return;
  }
  body.innerHTML = `<div class="d-title">${d.title}</div>${d.sub ? `<div class="d-sub">${d.sub}</div>` : ''}${d.html}${d.model ? `<p><button class="btn small" data-model>${icon('model')}SHOW IN THE MODEL</button></p>` : ''}`;
  body.querySelectorAll('[data-d]').forEach(a => a.onclick = () => { hist = hist.slice(0, hpos + 1); hist.push(a.dataset.d); hpos++; paint(); });
  body.querySelectorAll('[data-go-room]').forEach(a => a.onclick = e => { e.preventDefault(); goRoom(a.dataset.goRoom, a.dataset.goTask); });
  body.querySelectorAll('[data-go-who]').forEach(a => a.onclick = e => { e.preventDefault(); go({ who: a.dataset.goWho }); });
  if (d.bind) d.bind(body);
  if (d.model && paintedKey !== key) outline('d:' + key, d.model);
  paintedKey = key;
  body.querySelector('[data-model]')?.addEventListener('click', () => { if (modelBeside()) showInModel(d.model, { frame: 'always' }); else document.getElementById('btn-beside')?.click(); });
  el.querySelectorAll(`.es-main [data-d="${CSS.escape(key)}"]`).forEach(n => n.classList.add(n instanceof SVGElement ? 'td-on' : 'on'));
  el.querySelectorAll(`.es-main .td-on`).forEach(n => n.classList.add('on'));
}
// ---------- who does the work ----------
function renderWho(inner, x) {
  if (!x) { inner.innerHTML = '<header class="es-head"><h1>Not on the list</h1></header><p class="note">That carpenter or crew was removed.</p>'; return; }
  const LAB = ESTIMATE_DATA.labor, tasks = LAB.tasks || [];
  const jobs = ws.data.projects.filter(p => !p.parentId && p.job && p.job.who === x.id);
  inner.innerHTML = `<header class="es-head"><div class="es-kicker">Who does the work</div><h1>${esc(x.name)}</h1></header>
    <section class="es-sec"><div class="es-sets">
      <label class="es-set"><span>Name</span><span><input type="text" data-wf="name" value="${esc(x.name)}"></span></label>
      <label class="es-set"><span>Trade</span><span><input type="text" data-wf="trade" value="${esc(x.trade || '')}"></span></label>
      <label class="es-set"><span>Rate</span><span><input type="number" min="0" step="1" inputmode="decimal" data-wf="rate" value="${x.rate}"><i>$/hr</i></span></label></div>
      <p class="note">${jobs.length ? 'Does ' + jobs.map(p => `<a href="#/estimate?project=${encodeURIComponent(p.id)}" data-job="${esc(p.id)}">${esc(p.name)}</a>`).join(', ') + '.' : 'Not on a job yet: choose them under "Who does it" in a project\'s price.'}</p></section>
    <section class="es-sec"><h2>Times per task</h2><p class="note">Hours for one unit of each task. Blank is the published time; type a time to use this person's own.</p>
    <div class="es-tbl"><table class="es-t es-labor"><thead><tr><th>Task</th><th>Per</th><th class="num">Published</th><th class="num">Range</th><th class="num">Their time</th><th></th></tr></thead><tbody>
      ${tasks.map(t => { const own = x.each && x.each[t.id] != null; return `<tr class="${own ? 'typed' : ''}"><td data-d="task:${esc(t.id)}" class="lk">${esc(t.label)}</td><td class="unit">${esc(t.unit_one || t.unit)}</td><td class="num">${t.hours}</td><td class="num note">${t.low ?? ''}–${t.high ?? ''}</td>
        <td class="num"><input class="es-cell ${own ? 'set' : ''}" type="number" min="0" step="any" inputmode="decimal" data-wt="${esc(t.id)}" value="${own ? x.each[t.id] : ''}" placeholder="${t.hours}" aria-label="${esc(t.label)}: ${esc(x.name)}'s hours each"></td>
        <td>${own ? `<button type="button" class="btn small ghost" data-wr="${esc(t.id)}">RESET</button>` : ''}</td></tr>`; }).join('')}</tbody></table></div></section>
    <section class="es-sec"><button type="button" class="btn small danger" data-wdel>REMOVE ${esc(x.name.toUpperCase())}</button></section>`;
  inner.querySelectorAll('[data-wf]').forEach(i => i.onchange = () => {
    const f = i.dataset.wf;
    if (f === 'rate') { const v = Number(i.value); if (!(v >= 0)) { render(true); return; } x.rate = v; } else x[f] = i.value.trim().slice(0, 120) || (f === 'name' ? 'Carpenter' : '');
    touch(); soon();
  });
  inner.querySelectorAll('[data-wt]').forEach(i => i.onchange = () => { if (setInstallerTime(x, i.dataset.wt, i.value)) touch(); soon(); });
  inner.querySelectorAll('[data-wr]').forEach(b => b.onclick = () => { setInstallerTime(x, b.dataset.wr, null); touch(); render(true); });
  inner.querySelectorAll('[data-job]').forEach(a => a.onclick = e => { e.preventDefault(); go({ id: a.dataset.job }); });
  inner.querySelector('[data-wdel]').onclick = () => {
    if (!confirm(`Remove ${x.name}? ${jobs.length ? plural(jobs.length, 'job') + ' go back to the published times.' : ''}`)) return;
    removeInstaller(x.id); touch(); go(target().who ? { program: true } : target());
  };
  inner.addEventListener('click', e => {
    const a = e.target.closest('[data-d]'); if (!a) return;
    if (hist[hpos] !== a.dataset.d) { hist = hist.slice(0, hpos + 1); hist.push(a.dataset.d); hpos = hist.length - 1; }
    paint();
  });
}

const kv = rows => '<dl class="kv">' + rows.filter(r => r[1] !== '' && r[1] != null).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('') + '</dl>';
const link = (k, text) => `<a class="dl" data-d="${esc(k)}">${text}</a>`;
// Open a room in the table, bring it into view and mark one of its labor lines.
function goRoom(key, task) {
  open.add(key); render(true);
  const row = el && el.querySelector(`tr[data-room="${CSS.escape(key)}"]`);
  const line = task && el && el.querySelector(`tr[data-lt="${CSS.escape(key + '|' + task)}"]`);
  (line || row)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  if (line) { line.classList.add('flash'); setTimeout(() => line.classList.remove('flash'), 1600); }
}
const ext = (href, text) => href ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${text} ↗</a>` : '';
// A moulding as bought: its store items (each a PRODUCTS record), what was read on the store pages.
function productDetail(pid, t) {
  const c = (t && t.catalog[pid]) || catalogItem(pid) || {};
  const b = t && t.buy.find(x => x.pid === pid), sale = (t && t.sale[pid]) || {};
  const items = storeItems(pid).filter(it => !b || (it.how === 'foot' ? b.lines.some(l => l.how === 'foot') : b.lines.some(l => l.how !== 'foot' && it.lenIn != null && Math.abs(l.lenIn - it.lenIn) < 0.01)) || it.lenIn == null);
  const row = it => {
    const rec = productForKey(it.key), n = b ? b.lines.filter(l => it.how === 'foot' ? l.how === 'foot' : l.how !== 'foot' && Math.abs(l.lenIn - (it.lenIn || 0)) < 0.01).reduce((a, l) => a + l.order, 0) : 0;
    const price = rec && Number(rec.price) > 0 ? Number(rec.price) : it.price;
    return `<li><b>${it.how === 'foot' ? 'Cut by the foot' : it.lenIn != null ? feetInches(it.lenIn) + ' board' : 'Each'}</b>, ${m2(price)}${it.how === 'foot' ? ' a foot' : ''}${n ? ` · ${n} bought` : ''}<br><span class="note">${esc(it.item)}${rec && rec.priceCheckedAt ? ` · price seen ${esc(fmtDate(String(rec.priceCheckedAt).slice(0, 10)))}` : ''}</span><br>${ext(it.url, esc(c.store || 'Store') + ' page')}${rec ? ` · <a href="#/products?select=${encodeURIComponent(rec.id)}">In PRODUCTS</a>` : ''}</li>`;
  };
  return { kind: 'Product', title: esc(c.short || pid), sub: esc([c.brand, c.model, c.store].filter(Boolean).join(' · ')),
    html: kv([['Product', esc(c.title || '')], ['Size', esc(c.size || '')], ['Material', esc([c.material, c.finish].filter(Boolean).join(', '))], ['How it is sold', esc((b && b.soldText) || '')]])
      + `<h4>Bought as</h4><ul>${items.map(row).join('')}</ul>`
      + (b ? `<p class="note">${b.order} pieces, ${m2(b.ext)}${b.lines.some(l => l.spare) ? `, ${plural(b.lines.reduce((a, l) => a + l.spare, 0), 'spare')} included` : ''}.</p>` : '')
      + `<h4>Evidence</h4><p class="note">${esc([c.evidence, sale.evidence, sale.foot_checked, c.notes].filter(Boolean).join(' '))}</p>` };
}
function detail(key, job) {
  const i = key.indexOf(':'), kind = key.slice(0, i), id = key.slice(i + 1), t = job && job.trim && !job.trim.error ? job.trim : null, s = job ? job.settings : null;
  if (kind === 'product') return productDetail(id, t);
  if (kind === 'task' && !job) {
    const task = [...(ESTIMATE_DATA.labor.tasks || []), ...(ESTIMATE_DATA.labor.tasks_extra || [])].find(x => x.id === id); if (!task) return null;
    return { kind: 'Labor', title: esc(task.label), sub: `${task.hours} hrs per ${esc(task.unit_one || task.unit)} (low ${task.low ?? task.hours}, high ${task.high ?? task.hours})`, html: `<h4>Where the time comes from</h4><p>${esc(task.basis || '')}</p><p class="note">${esc(task.source || '')}</p>` };
  }
  if (!job) return null;
  if (kind === 'piece' && t) {
    const g = t.groups.find(x => x.mark === id); if (!g) return null;
    const c = t.catalog[g.product] || catalogItem(g.product) || {};
    const boards = [...new Set(t.pieces.filter(p => p.mark === id).map(p => p.stick))].map(b => t.boards.find(x => x.id === b && x.room === g.room)).filter(Boolean);
    return { kind: 'Piece ' + id, title: esc(g.name), sub: `${esc(g.size)} ${esc(g.material || '')}`, html: kv([['Length', `<b>${lenIn(g.lin)}</b> long point`], ['How many', g.qty], ['Ends', `${esc(g.endL)} / ${esc(g.endR)}, left / right as you face the wall`], ['Moulding', `${link('product:' + g.product, esc(c.short || g.product))}<br><span class="note">${esc([c.brand, c.model, c.store].filter(Boolean).join(' · '))}</span>`], ['Room', esc(g.room)]])
      + (boards.length ? `<h4>Cut from</h4><ul>${boards.map(b => `<li>${link('stick:' + b.key, esc(b.id))}, ${b.kit ? 'kit' : lenIn(b.stockIn)} ${m2(b.price)}</li>`).join('')}</ul>` : ''), model: g.section ? [g.section] : null };
  }
  if (kind === 'stick' && t) {
    const b = t.boards.find(x => x.key === id); if (!b) return null;
    let svg = ''; try { svg = cutsHtml([b], b.wall, t, { fluid: true, lmax: b.stockIn }); } catch { /* none */ }
    return { kind: 'Board', title: esc(b.id) + ' · ' + esc(b.room), sub: `${esc(b.short)}, ${b.kit ? 'kit rail' : lenIn(b.stockIn)}${b.how === 'foot' ? ', cut to length at the store' : ''}, ${m2(b.price)}`,
      html: `<div class="es-cuts">${svg}</div>` + kv([['Moulding', link('product:' + b.product, esc(b.short))], ['Bought as', (() => { const { item, record } = productForBoard(b.product, b.stockIn, b.how); return item ? `${esc(item.item)}<br>${ext(item.url, 'Store page')}${record ? ` · <a href="#/products?select=${encodeURIComponent(record.id)}">In PRODUCTS</a>` : ''}` : ''; })()], ['Left over', b.drop > 1 / 32 ? lenIn(b.drop) + (b.drop < 12 ? ' waste' : ' offcut') : 'nothing']]) + `<h4>Cuts, longest first</h4><ul>${b.cuts.map(c => `<li>${link('piece:' + c.mark, esc(c.mark))} ${esc(c.name)}: <b>${lenIn(c.lin)}</b></li>`).join('')}</ul>` };
  }
  if (kind === 'task' && t) {
    const task = t.labor.taskById[id]; if (!task) return null;
    const keyOf = name => (job.rooms.find(r => r.trim.some(x => x.name === name)) || {}).key || '';
    const lines = t.rooms.flatMap(r => (r.labor || []).filter(l => l.task === id).map(l => ({ room: r.name, key: keyOf(r.name), ...l })));
    const h = lines.reduce((n, l) => n + l.hours, 0), who = s.who, mine = who && who.each && who.each[id] != null;
    return { kind: 'Labor', title: esc(task.label), sub: `${mine ? `${who.each[id]} hrs per ${esc(task.unit_one || task.unit)}, ${esc(who.name)}'s time; published ` : ''}${task.hours} hrs per ${esc(task.unit_one || task.unit)} (low ${task.low ?? task.hours}, high ${task.high ?? task.hours})`,
      html: kv([['This project', `${hrs(h)} hrs, ${fm(h * s.laborRate)}`], ['Who', who ? `<a href="#/estimate?who=${encodeURIComponent(who.id)}" data-go-who="${esc(who.id)}">${esc(who.name)}</a>, ${fm(who.rate)}/hr` : `Published times, ${fm(s.laborRate)}/hr`]])
        + `<ul>${lines.map(l => `<li><a href="#" class="dl" data-go-room="${esc(l.key)}" data-go-task="${esc(id)}">${esc(l.room)}</a>: ${fmtQ(l.qty)} ${esc(Math.abs(l.qty - 1) < 1e-9 ? l.unitOne || l.unit : l.unit)} × ${+l.rate.toFixed(4)} → ${hrs(l.hours)} hrs${l.qtySet || l.eachSet === 'room' ? ' <span class="note">(typed)</span>' : ''}</li>`).join('')}</ul><h4>Where the published time comes from</h4><p>${esc(task.basis || '')}</p><p class="note">${esc(task.source || '')}</p>` };
  }
  if (kind === 'item') {
    const hit = job.tree.flatMap(x => (x.items || []).map(it => ({ x, it }))).find(y => y.it.id === id); if (!hit) return null;
    const { it, x } = hit, q = it.qty ?? 1;
    return { kind: 'Scope item', title: esc(it.name || 'Item'), sub: `${esc(x === job.root ? 'Project-wide' : x.name)} · ${fmtQ(q)} ${esc(it.unit || '')}${it.likely ? ' · ' + fm(it.likely * q) : ''}`,
      html: itemDetailHtml(x, it, job.schedule.rows), bind: body => bindItemDetail(body, x, it, () => { touch(); render(true); }), model: linkedIds([], [it]).length ? linkedIds([], [it]) : null };
  }
  if (kind === 'cost') {
    const text = {
      price: `The price to the client: the cost, then ${pct(s.contingency)} contingency, ${pct(s.markup)} overhead and profit and ${pct(s.taxRate)} tax on materials. Low and high carry each scope item's range and the labor rates' low and high hours.`,
      hours: 'Carpenter hours from published production rates (mostly Craftsman estimating books), counted from the drawing: feet of base, rail and cap, frames, battens, copes, outside corners, scarfs, caulk, fill and paint, and setup and cleanup each day in a room. A carpenter\'s own bid is the check.',
      days: 'Working days, Monday to Friday, one carpenter: each room takes its hours at 6 productive hours a day, at least a day, and the rooms follow one another in the order the subprojects are listed. SCHEDULE shows the dates.',
      order: 'Boards bought at the cheapest store length that holds their cuts (up to 12\'-0", or 13\'-0" when that buys less), each room from its own boards, plus the spares. The buy list with item numbers is in DOCUMENTS.',
      materials: 'Trim boards and supplies (nails, glue, adhesive, caulk, filler, primer, paint, protection, blades) at the store prices seen on the dates in the data.',
      labor: `Carpenter hours × ${fm(s.laborRate)}/hr.`, items: 'Installed prices typed in each room or taken from the price book, each with its own range.',
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
      <td><a href="#/estimate?project=${encodeURIComponent(p.id)}" data-job="${esc(p.id)}"><b>${esc(p.name || 'Project')}</b></a></td><td>${esc((STATUSES.find(([k]) => k === p.status) || [0, p.status || ''])[1])}</td>
      <td class="num">${fm(j.price.low)}</td><td class="num"><b>${fm(j.price.likely)}</b></td><td class="num">${fm(j.price.high)}</td><td class="num">${j.schedule.days || ''}</td></tr>`;
  }).join('');
  const left = cap - sel.likely;
  inner.innerHTML = `<header class="es-head"><div class="es-kicker">All projects</div><h1>The program</h1>
    <div class="es-acts"><button class="btn small" id="print-report">${icon('print')}PRINT REPORT</button></div></header>
    <section class="es-sec"><div class="es-sets"><label class="es-set"><span>Budget cap</span><span><input type="text" id="cap-input" value="${fm(cap)}" aria-label="Budget cap"></span><span id="cap-note" class="note ${capProblem ? 'bad' : ''}" ${capProblem ? 'role="alert"' : ''}>${capProblem ? esc(capProblem) : ''}</span></label></div></section>
    <section class="es-sec"><div class="es-tbl"><table class="es-t"><thead><tr><th></th><th>Project</th><th>Status</th><th class="num">Low</th><th class="num">Likely</th><th class="num">High</th><th class="num">Days</th></tr></thead><tbody>${rows || '<tr><td colspan="7" class="note">No projects.</td></tr>'}</tbody>
      <tfoot><tr><td></td><td>In the program</td><td></td><td class="num">${fm(sel.low)}</td><td class="num" data-sel-total>${fm(sel.likely)}</td><td class="num">${fm(sel.high)}</td><td></td></tr>
      <tr class="${left < 0 ? 'over' : ''}"><td></td><td>${left < 0 ? 'Over the cap' : 'Left under the cap'}</td><td></td><td></td><td class="num ${left < 0 ? 'over' : 'under'}">${fm(Math.abs(left))}</td><td></td><td></td></tr></tfoot></table></div>
    <p class="note">A ticked project and its subprojects count in the program. Each price is the project's estimate: drawn trim and scope items with its markups.</p></section>`;
  const capIn = inner.querySelector('#cap-input');
  capIn.onchange = () => {
    const r = readMoney(capIn.value);
    if (Number.isNaN(r.value)) { capProblem = r.error + ' The cap is still ' + fm(cap) + '.'; render(true); return; }
    capProblem = ''; d.settings.budgetCap = r.value; touch(); render(true);
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
