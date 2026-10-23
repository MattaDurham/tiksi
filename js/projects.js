// Projects view: capture ideas, scope them into line items with budget ranges,
// durations and dependencies. The budget and schedule views read from this data.
// A project can hold subprojects (one level deep): small pieces of work such as a punch list,
// each with its own status, priority, room and source, and its own scope if it needs one.

import {
  ws, uid, touch, fmtMoney, parseMoney, escapeHtml, projectTotals, itemTotals,
  activeProperty, elementInfo, fmtLen, fmtArea, isoToday,
  PRIORITIES, subprojectsOf, projectById, roomsOn,
} from './store.js';
import { icon } from './icons.js';

const STATUSES = ['idea', 'scoped', 'committed', 'in-progress', 'done'];
const CATEGORIES = ['kitchen', 'bath', 'interior', 'exterior', 'systems', 'structure', 'landscape', 'other'];
const PRIORITY_CHIP = { high: 'red', medium: 'accent', low: 'cyan' };

let el = null;
let activeProjectId = null;

export function mount(root) {
  el = root;
  render();
}
export function unmount() { el = null; }

function newProject(name, fields) {
  return Object.assign({
    id: uid('proj'), name, propertyId: activeProperty() ? activeProperty().id : null,
    category: 'other', status: 'idea', selected: false, startDate: '', notes: '', items: [],
    parentId: '', priority: '', roomId: '', source: '',
  }, fields);
}

// Open subprojects first, highest priority first, then the done ones; otherwise list order.
function sortedSubs(p) {
  const rank = s => (s.status === 'done' ? 10 : 0) + (s.priority ? PRIORITIES.indexOf(s.priority) : PRIORITIES.length);
  return subprojectsOf(p).map((s, i) => ({ s, i })).sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i).map(x => x.s);
}

function priorityChip(p) {
  return p.priority ? `<span class="chip ${PRIORITY_CHIP[p.priority]}">${escapeHtml(p.priority)}</span>` : '';
}

function roomOf(p) {
  const prop = ws.data.properties.find(x => x.id === p.propertyId);
  return prop && p.roomId ? prop.rooms.find(r => r.id === p.roomId) || null : null;
}

function render() {
  if (!el) return;
  const d = ws.data;
  if (activeProjectId && !d.projects.find(p => p.id === activeProjectId)) activeProjectId = null;
  const tops = d.projects.filter(p => !p.parentId);
  if (!activeProjectId && tops.length) activeProjectId = tops[0].id;
  const active = d.projects.find(p => p.id === activeProjectId);
  const subCount = d.projects.length - tops.length;

  el.innerHTML = `
    <div class="view-scroll">
      <div class="view-head">
        <span class="view-title">PROJECTS</span>
        <span class="view-sub">${tops.length} projects${subCount ? ', ' + subCount + ' subprojects' : ''}, ${d.projects.filter(p => p.selected).length} selected into the program</span>
        <span class="sp" style="flex:1"></span>
        <button class="btn primary" id="new-project">${icon('plus')}NEW PROJECT</button>
      </div>
      <div class="two-col" style="height:auto; align-items:start">
        <div class="list-stack" id="proj-list"></div>
        <div id="proj-detail"></div>
      </div>
    </div>`;

  el.querySelector('#new-project').onclick = () => {
    const name = prompt('Project name (e.g. Kitchen remodel):');
    if (!name) return;
    const p = newProject(name);
    ws.data.projects.push(p);
    activeProjectId = p.id;
    touch(); render();
  };

  const list = el.querySelector('#proj-list');
  list.innerHTML = tops.map(p => {
    const t = projectTotals(p);
    const days = p.items.reduce((n, i) => n + (i.durationDays || 0), 0);
    const subs = sortedSubs(p);
    const open = subs.filter(s => s.status !== 'done').length;
    const card = `<div class="card clickable proj-card ${p.id === activeProjectId ? 'active' : ''}" data-id="${escapeHtml(p.id)}">
      <span class="sbar status-${escapeHtml(p.status)}"></span>
      <div class="p-title">
        <b>${escapeHtml(p.name)}</b>
        <input type="checkbox" ${p.selected ? 'checked' : ''} data-sel="${escapeHtml(p.id)}" title="Include in program budget/schedule">
      </div>
      <div class="p-chips">
        <span class="chip status-${escapeHtml(p.status)}">${escapeHtml(p.status)}</span>
        <span class="chip">${escapeHtml(p.category)}</span>
        ${priorityChip(p)}
      </div>
      <div class="p-sub">${fmtMoney(t.likely)} likely, ${p.items.length} items${days ? ', ' + days + 'd work' : ''}${subs.length ? `, ${subs.length} subprojects (${open} open)` : ''}</div>
    </div>`;
    const rows = subs.map(s => `<div class="sub-row ${s.status === 'done' ? 'done' : ''} ${s.id === activeProjectId ? 'active' : ''}" data-id="${escapeHtml(s.id)}" title="${escapeHtml(s.name)}">
        <span class="sbar status-${escapeHtml(s.status)}"></span>
        <span class="sub-name">${escapeHtml(s.name)}</span>
        ${priorityChip(s)}
      </div>`).join('');
    return card + (rows ? `<div class="sub-list" data-parent="${escapeHtml(p.id)}">${rows}</div>` : '');
  }).join('') || `<div class="empty-state"><span class="empty-ic">${icon('projects')}</span><b>No projects yet</b>Every renovation idea starts as a project.</div>`;

  list.querySelectorAll('.card, .sub-row').forEach(c => c.onclick = e => {
    if (e.target.matches('input')) return;
    activeProjectId = c.dataset.id;
    render();
  });
  list.querySelectorAll('[data-sel]').forEach(cb => cb.onchange = () => {
    const p = d.projects.find(p => p.id === cb.dataset.sel);
    p.selected = cb.checked;
    touch(); render();
  });

  renderDetail(active);
}

function roomOptions(p) {
  const prop = ws.data.properties.find(x => x.id === p.propertyId);
  if (!prop) return '';
  const groups = prop.levels.map(l => {
    const opts = roomsOn(prop, l.id).map(r => `<option value="${escapeHtml(r.id)}" ${r.id === p.roomId ? 'selected' : ''}>${escapeHtml(r.name || 'Room')}</option>`).join('');
    return opts ? `<optgroup label="${escapeHtml(l.name)}">${opts}</optgroup>` : '';
  }).join('');
  return `<option value="">(none)</option>${groups}`;
}

function parentOptions(p) {
  const tops = ws.data.projects.filter(x => !x.parentId && x.id !== p.id && x.propertyId === p.propertyId);
  return `<option value="">(none: a project of its own)</option>` +
    tops.map(x => `<option value="${escapeHtml(x.id)}" ${x.id === p.parentId ? 'selected' : ''}>${escapeHtml(x.name)}</option>`).join('');
}

function renderDetail(p) {
  const det = el.querySelector('#proj-detail');
  if (!p) { det.innerHTML = `<div class="empty-state"><span class="empty-ic">${icon('edit')}</span><b>Nothing selected</b>Select or create a project.</div>`; return; }
  const t = projectTotals(p);
  const parent = p.parentId ? projectById(p.parentId) : null;
  const subs = parent ? [] : sortedSubs(p);

  det.innerHTML = `
    <div class="card">
      ${parent ? `<div class="sub-crumb">SUBPROJECT OF <button class="btn small ghost" data-open="${escapeHtml(parent.id)}">${escapeHtml(parent.name)}</button></div>` : ''}
      <div class="field-row">
        <div class="field" style="flex:2"><label>Name</label><input type="text" data-f="name" value="${escapeHtml(p.name)}"></div>
        <div class="field"><label>Category</label>
          <select data-f="category">${CATEGORIES.map(c => `<option ${c === p.category ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
        <div class="field"><label>Status</label>
          <select data-f="status">${STATUSES.map(s => `<option ${s === p.status ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
        <div class="field"><label>Priority</label>
          <select data-f="priority"><option value="">-</option>${PRIORITIES.map(s => `<option ${s === p.priority ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
        <div class="field"><label>Earliest start</label><input type="date" data-f="startDate" value="${escapeHtml(p.startDate || '')}"></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Room</label><select data-f="roomId">${roomOptions(p)}</select></div>
        <div class="field"><label>Part of</label>
          <select data-f="parentId" ${subs.length ? 'disabled title="It has subprojects of its own"' : ''}>${parentOptions(p)}</select></div>
        <div class="field" style="flex:2"><label>Source</label><input type="text" data-f="source" value="${escapeHtml(p.source || '')}" placeholder="Where this came from: a note, an email, a report page"></div>
      </div>
      <div class="field"><label>Scope notes</label><textarea data-f="notes">${escapeHtml(p.notes || '')}</textarea></div>

      ${parent ? '' : `<div class="kicker" style="margin-top:14px">SUBPROJECTS</div>
      ${subs.length ? `<table class="grid" id="subs-table">
        <thead><tr><th>Subproject</th><th>Priority</th><th>Status</th><th>Room</th><th class="num">Likely</th></tr></thead>
        <tbody>${subs.map(s => subRow(s)).join('')}</tbody>
      </table>` : ''}
      <div style="display:flex; gap:8px; margin-top:10px">
        <button class="btn" id="add-sub">${icon('plus')}ADD SUBPROJECT</button>
      </div>`}

      <div class="kicker" style="margin-top:14px">SCOPE ITEMS</div>
      <table class="grid" id="items-table">
        <thead><tr>
          <th style="width:26%">Item</th><th class="num">Qty</th><th>Unit</th>
          <th class="num">Low</th><th class="num">Likely</th><th class="num">High</th>
          <th class="num">Days</th><th>Depends on</th><th>Links</th><th></th>
        </tr></thead>
        <tbody>
        ${p.items.map(it => itemRow(p, it)).join('')}
        <tr class="total-row"><td>TOTAL (qty applied)</td><td></td><td></td>
          <td class="num">${fmtMoney(t.low)}</td><td class="num">${fmtMoney(t.likely)}</td><td class="num">${fmtMoney(t.high)}</td>
          <td class="num">${p.items.reduce((n, i) => n + (i.durationDays || 0), 0)}</td><td colspan="3"></td></tr>
        </tbody>
      </table>
      <div style="display:flex; gap:8px; margin-top:10px">
        <button class="btn" id="add-item">${icon('plus')}ADD ITEM</button>
        <span style="flex:1"></span>
        <button class="btn danger" id="del-project">${icon('trash')}DELETE ${parent ? 'SUBPROJECT' : 'PROJECT'}</button>
      </div>
    </div>`;

  det.querySelectorAll('[data-f]').forEach(inp => inp.onchange = () => {
    p[inp.dataset.f] = inp.value;
    touch();
    if (['status', 'name', 'priority', 'parentId', 'roomId'].includes(inp.dataset.f)) render();
  });
  det.querySelectorAll('[data-open]').forEach(b => b.onclick = () => { activeProjectId = b.dataset.open; render(); });

  const addSub = det.querySelector('#add-sub');
  if (addSub) addSub.onclick = () => {
    const name = prompt('Subproject name (e.g. Fix the bathroom door):');
    if (!name) return;
    const s = newProject(name, { propertyId: p.propertyId, parentId: p.id, category: p.category });
    ws.data.projects.push(s);
    activeProjectId = s.id;
    touch(); render();
  };
  det.querySelectorAll('tr[data-sub]').forEach(tr => {
    const s = projectById(tr.dataset.sub);
    tr.querySelectorAll('[data-sf]').forEach(inp => inp.onchange = () => { s[inp.dataset.sf] = inp.value; touch(); render(); });
  });

  det.querySelector('#add-item').onclick = () => {
    p.items.push({
      id: uid('it'), name: 'New item', qty: 1, unit: 'ls', low: 0, likely: 0, high: 0,
      durationDays: 0, deps: [], elementIds: [], notes: '',
    });
    touch(); renderDetail(p);
  };
  det.querySelector('#del-project').onclick = () => {
    const what = (parent ? 'subproject "' : 'project "') + p.name + '" and all its scope items' + (subs.length ? ', with its ' + subs.length + ' subprojects' : '');
    if (!confirm('Delete ' + what + '?')) return;
    const gone = new Set([p.id, ...subs.map(s => s.id)]);
    ws.data.projects = ws.data.projects.filter(x => !gone.has(x.id));
    activeProjectId = parent ? parent.id : null;
    touch(); render();
  };

  bindItemRows(p);
}

function subRow(s) {
  const room = roomOf(s);
  return `<tr data-sub="${escapeHtml(s.id)}" class="${s.status === 'done' ? 'faint' : ''}">
    <td><button class="btn small ghost sub-open" data-open="${escapeHtml(s.id)}" title="${escapeHtml(s.source ? 'Source: ' + s.source : 'Open')}">${escapeHtml(s.name)}</button></td>
    <td style="width:92px"><select data-sf="priority"><option value="">-</option>${PRIORITIES.map(x => `<option ${x === s.priority ? 'selected' : ''}>${x}</option>`).join('')}</select></td>
    <td style="width:112px"><select data-sf="status">${STATUSES.map(x => `<option ${x === s.status ? 'selected' : ''}>${x}</option>`).join('')}</select></td>
    <td class="muted">${room ? escapeHtml(room.name || 'Room') : '-'}</td>
    <td class="num">${fmtMoney(projectTotals(s).likely)}</td>
  </tr>`;
}

// Names of the item's predecessors (dropped items are skipped), or '-' when it has none.
function depSummary(p, it) {
  const names = (it.deps || []).map(id => { const d = p.items.find(x => x.id === id); return d ? d.name : null; }).filter(Boolean);
  return names.join(', ') || '-';
}

function itemRow(p, it) {
  const links = (it.elementIds || []).length;
  const prods = ws.data.products.filter(pr => (pr.itemIds || []).includes(it.id)).length;
  const others = p.items.filter(x => x.id !== it.id);
  const depOpts = others
    .map(x => `<option value="${escapeHtml(x.id)}" ${(it.deps || []).includes(x.id) ? 'selected' : ''} title="${escapeHtml(x.name)}">${escapeHtml(x.name)}</option>`).join('');
  const summary = depSummary(p, it);
  const linkBits = [];
  if (links) linkBits.push(links + ' elem');
  if (prods) linkBits.push(prods + ' prod');
  return `<tr data-item="${escapeHtml(it.id)}">
    <td><input type="text" data-if="name" value="${escapeHtml(it.name)}"></td>
    <td class="num" style="width:64px"><input type="number" class="num" data-if="qty" value="${escapeHtml(it.qty ?? 1)}" min="0" step="0.5"></td>
    <td style="width:56px"><input type="text" data-if="unit" value="${escapeHtml(it.unit || 'ls')}"></td>
    <td class="num" style="width:92px"><input type="text" class="num" data-money="low" value="${it.low ? fmtMoney(it.low) : ''}"></td>
    <td class="num" style="width:92px"><input type="text" class="num" data-money="likely" value="${it.likely ? fmtMoney(it.likely) : ''}"></td>
    <td class="num" style="width:92px"><input type="text" class="num" data-money="high" value="${it.high ? fmtMoney(it.high) : ''}"></td>
    <td class="num" style="width:56px"><input type="number" class="num" data-if="durationDays" value="${escapeHtml(it.durationDays || 0)}" min="0"></td>
    <td style="width:130px"><div class="dep-wrap" title="${escapeHtml(summary === '-' ? 'No predecessors; click to pick (cmd-click for several)' : 'After: ' + summary)}">
      <button type="button" class="dep-summary ${summary === '-' ? 'none' : ''}" data-dep-open ${others.length ? '' : 'disabled'}>${escapeHtml(summary)}</button>
      <select multiple size="${Math.min(6, Math.max(2, others.length))}" data-deps>${depOpts}</select></div></td>
    <td class="mono faint" style="font-size:10px; white-space:nowrap" title="Linked model elements and products">${linkBits.join(', ') || '-'}</td>
    <td><span class="row-del" data-del-item="${escapeHtml(it.id)}" title="Remove item">${icon('close', { size: 13 })}</span></td>
  </tr>`;
}

function bindItemRows(p) {
  const det = el.querySelector('#proj-detail');
  det.querySelectorAll('tr[data-item]').forEach(tr => {
    const it = p.items.find(i => i.id === tr.dataset.item);
    if (!it) return;
    tr.querySelectorAll('[data-if]').forEach(inp => inp.onchange = () => {
      const f = inp.dataset.if;
      it[f] = (f === 'qty' || f === 'durationDays') ? parseFloat(inp.value) || 0 : inp.value;
      touch(); renderDetail(p);
    });
    tr.querySelectorAll('[data-money]').forEach(inp => inp.onchange = () => {
      it[inp.dataset.money] = parseMoney(inp.value);
      touch(); renderDetail(p);
    });
    // The summary button opens the listbox in place; leaving it (blur, Escape, Enter) closes
    // it and refreshes the summary from the data.
    const wrap = tr.querySelector('.dep-wrap');
    const deps = wrap.querySelector('[data-deps]');
    const summary = wrap.querySelector('[data-dep-open]');
    const refresh = () => { const s = depSummary(p, it); summary.textContent = s; summary.classList.toggle('none', s === '-'); };
    summary.onclick = () => { wrap.classList.add('open'); deps.focus(); };
    deps.onblur = () => { wrap.classList.remove('open'); refresh(); };
    deps.onkeydown = e => { if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); summary.focus(); } };
    deps.onchange = () => {
      it.deps = Array.from(deps.selectedOptions).map(o => o.value);
      touch(); refresh();
    };
  });
  det.querySelectorAll('[data-del-item]').forEach(x => x.onclick = () => {
    const id = x.dataset.delItem;
    p.items = p.items.filter(i => i.id !== id);
    for (const i of p.items) i.deps = (i.deps || []).filter(d => d !== id);
    touch(); renderDetail(p);
  });
}
