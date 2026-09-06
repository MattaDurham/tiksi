// Projects view: capture ideas, scope them into line items with budget ranges,
// durations and dependencies. The budget and schedule views read from this data.

import {
  ws, uid, touch, fmtMoney, parseMoney, escapeHtml, projectTotals, itemTotals,
  activeProperty, elementInfo, fmtLen, fmtArea, isoToday,
} from './store.js';
import { icon } from './icons.js';

const STATUSES = ['idea', 'scoped', 'committed', 'in-progress', 'done'];
const CATEGORIES = ['kitchen', 'bath', 'interior', 'exterior', 'systems', 'structure', 'landscape', 'other'];

let el = null;
let activeProjectId = null;

export function mount(root) {
  el = root;
  render();
}
export function unmount() { el = null; }

function render() {
  if (!el) return;
  const d = ws.data;
  if (activeProjectId && !d.projects.find(p => p.id === activeProjectId)) activeProjectId = null;
  if (!activeProjectId && d.projects.length) activeProjectId = d.projects[0].id;
  const active = d.projects.find(p => p.id === activeProjectId);

  el.innerHTML = `
    <div class="view-scroll">
      <div class="view-head">
        <span class="view-title">PROJECTS</span>
        <span class="view-sub">${d.projects.length} projects, ${d.projects.filter(p => p.selected).length} selected into the program</span>
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
    const p = {
      id: uid('proj'), name, propertyId: activeProperty() ? activeProperty().id : null,
      category: 'other', status: 'idea', selected: false, startDate: '', notes: '', items: [],
    };
    ws.data.projects.push(p);
    activeProjectId = p.id;
    touch(); render();
  };

  const list = el.querySelector('#proj-list');
  list.innerHTML = d.projects.map(p => {
    const t = projectTotals(p);
    const days = p.items.reduce((n, i) => n + (i.durationDays || 0), 0);
    return `<div class="card clickable proj-card ${p.id === activeProjectId ? 'active' : ''}" data-id="${escapeHtml(p.id)}">
      <span class="sbar status-${escapeHtml(p.status)}"></span>
      <div class="p-title">
        <b>${escapeHtml(p.name)}</b>
        <input type="checkbox" ${p.selected ? 'checked' : ''} data-sel="${escapeHtml(p.id)}" title="Include in program budget/schedule">
      </div>
      <div class="p-chips">
        <span class="chip status-${escapeHtml(p.status)}">${escapeHtml(p.status)}</span>
        <span class="chip">${escapeHtml(p.category)}</span>
      </div>
      <div class="p-sub">${fmtMoney(t.likely)} likely, ${p.items.length} items${days ? ', ' + days + 'd work' : ''}</div>
    </div>`;
  }).join('') || `<div class="empty-state"><span class="empty-ic">${icon('projects')}</span><b>No projects yet</b>Every renovation idea starts as a project.</div>`;

  list.querySelectorAll('.card').forEach(c => c.onclick = e => {
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

function renderDetail(p) {
  const det = el.querySelector('#proj-detail');
  if (!p) { det.innerHTML = `<div class="empty-state"><span class="empty-ic">${icon('edit')}</span><b>Nothing selected</b>Select or create a project.</div>`; return; }
  const t = projectTotals(p);

  det.innerHTML = `
    <div class="card">
      <div class="field-row">
        <div class="field" style="flex:2"><label>Name</label><input type="text" data-f="name" value="${escapeHtml(p.name)}"></div>
        <div class="field"><label>Category</label>
          <select data-f="category">${CATEGORIES.map(c => `<option ${c === p.category ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
        <div class="field"><label>Status</label>
          <select data-f="status">${STATUSES.map(s => `<option ${s === p.status ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
        <div class="field"><label>Earliest start</label><input type="date" data-f="startDate" value="${escapeHtml(p.startDate || '')}"></div>
      </div>
      <div class="field"><label>Scope notes</label><textarea data-f="notes">${escapeHtml(p.notes || '')}</textarea></div>

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
        <button class="btn danger" id="del-project">${icon('trash')}DELETE PROJECT</button>
      </div>
    </div>`;

  det.querySelectorAll('[data-f]').forEach(inp => inp.onchange = () => {
    p[inp.dataset.f] = inp.value;
    touch();
    if (inp.dataset.f === 'status' || inp.dataset.f === 'name') render();
  });

  det.querySelector('#add-item').onclick = () => {
    p.items.push({
      id: uid('it'), name: 'New item', qty: 1, unit: 'ls', low: 0, likely: 0, high: 0,
      durationDays: 0, deps: [], elementIds: [], notes: '',
    });
    touch(); renderDetail(p);
  };
  det.querySelector('#del-project').onclick = () => {
    if (!confirm('Delete project "' + p.name + '" and all its scope items?')) return;
    ws.data.projects = ws.data.projects.filter(x => x.id !== p.id);
    activeProjectId = null;
    touch(); render();
  };

  bindItemRows(p);
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
    <td class="num" style="width:64px"><input type="number" class="num" data-if="qty" value="${escapeHtml(it.qty || 1)}" min="0" step="0.5"></td>
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
