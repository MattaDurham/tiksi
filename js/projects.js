// Projects view: capture ideas, scope them into line items with budget ranges,
// durations and dependencies. The budget and schedule views read from this data.

import {
  ws, uid, touch, fmtMoney, parseMoney, escapeHtml, projectTotals, itemTotals,
  activeProperty, elementInfo, fmtLen, fmtArea, isoToday,
} from './store.js';

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
        <button class="btn primary" id="new-project">NEW PROJECT</button>
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
    return `<div class="card clickable ${p.id === activeProjectId ? 'active' : ''}" data-id="${p.id}">
      <div style="display:flex; justify-content:space-between; align-items:center; gap:8px">
        <b>${escapeHtml(p.name)}</b>
        <input type="checkbox" ${p.selected ? 'checked' : ''} data-sel="${p.id}" title="Include in program budget/schedule">
      </div>
      <div style="display:flex; gap:6px; margin:6px 0 4px; flex-wrap:wrap">
        <span class="chip status-${p.status}">${p.status}</span>
        <span class="chip">${p.category}</span>
      </div>
      <div class="mono muted" style="font-size:11px">${fmtMoney(t.likely)} likely, ${p.items.length} items${days ? ', ' + days + 'd work' : ''}</div>
    </div>`;
  }).join('') || '<p class="muted">No projects yet. Every renovation idea starts as a project.</p>';

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
  if (!p) { det.innerHTML = '<p class="muted">Select or create a project.</p>'; return; }
  const t = projectTotals(p);

  det.innerHTML = `
    <div class="card">
      <div class="field-row">
        <div class="field" style="flex:2"><label>Name</label><input type="text" data-f="name" value="${escapeHtml(p.name)}"></div>
        <div class="field"><label>Category</label>
          <select data-f="category">${CATEGORIES.map(c => `<option ${c === p.category ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
        <div class="field"><label>Status</label>
          <select data-f="status">${STATUSES.map(s => `<option ${s === p.status ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
        <div class="field"><label>Earliest start</label><input type="date" data-f="startDate" value="${p.startDate || ''}"></div>
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
        <button class="btn" id="add-item">+ ADD ITEM</button>
        <span style="flex:1"></span>
        <button class="btn danger" id="del-project">DELETE PROJECT</button>
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

function itemRow(p, it) {
  const links = (it.elementIds || []).length;
  const prods = ws.data.products.filter(pr => (pr.itemIds || []).includes(it.id)).length;
  const depOpts = p.items.filter(x => x.id !== it.id)
    .map(x => `<option value="${x.id}" ${(it.deps || []).includes(x.id) ? 'selected' : ''}>${escapeHtml(x.name)}</option>`).join('');
  const linkBits = [];
  if (links) linkBits.push(links + ' elem');
  if (prods) linkBits.push(prods + ' prod');
  return `<tr data-item="${it.id}">
    <td><input type="text" data-if="name" value="${escapeHtml(it.name)}"></td>
    <td class="num" style="width:52px"><input type="number" class="num" data-if="qty" value="${it.qty || 1}" min="0" step="0.5"></td>
    <td style="width:56px"><input type="text" data-if="unit" value="${escapeHtml(it.unit || 'ls')}"></td>
    <td class="num" style="width:92px"><input type="text" class="num" data-money="low" value="${it.low ? fmtMoney(it.low) : ''}"></td>
    <td class="num" style="width:92px"><input type="text" class="num" data-money="likely" value="${it.likely ? fmtMoney(it.likely) : ''}"></td>
    <td class="num" style="width:92px"><input type="text" class="num" data-money="high" value="${it.high ? fmtMoney(it.high) : ''}"></td>
    <td class="num" style="width:56px"><input type="number" class="num" data-if="durationDays" value="${it.durationDays || 0}" min="0"></td>
    <td style="width:130px"><select multiple size="1" data-deps title="Cmd-click to pick multiple predecessors">${depOpts}</select></td>
    <td class="mono faint" style="font-size:10px; white-space:nowrap" title="Linked model elements and products">${linkBits.join(', ') || '-'}</td>
    <td><span class="row-del" data-del-item="${it.id}">X</span></td>
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
    const deps = tr.querySelector('[data-deps]');
    deps.onfocus = () => { deps.size = Math.min(6, Math.max(2, p.items.length - 1)); };
    deps.onblur = () => { deps.size = 1; };
    deps.onchange = () => {
      it.deps = Array.from(deps.selectedOptions).map(o => o.value);
      touch();
    };
  });
  det.querySelectorAll('[data-del-item]').forEach(x => x.onclick = () => {
    const id = x.dataset.delItem;
    p.items = p.items.filter(i => i.id !== id);
    for (const i of p.items) i.deps = (i.deps || []).filter(d => d !== id);
    touch(); renderDetail(p);
  });
}
