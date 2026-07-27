// Product registry: researched products with vendor links, specs and prices,
// linked to scope items so the model becomes a true digital twin.

import { ws, uid, touch, fmtMoney, parseMoney, escapeHtml, allScopeItems } from './store.js';

const CATEGORIES = ['appliance', 'plumbing', 'lighting', 'flooring', 'tile', 'cabinetry', 'hardware', 'hvac', 'electrical', 'lumber', 'windows-doors', 'paint', 'other'];

let el = null;
let editingId = null;
let query = '', catFilter = '';

export function mount(root) { el = root; render(); }
export function unmount() { el = null; editingId = null; }

function render() {
  if (!el) return;
  const d = ws.data;
  const items = allScopeItems();
  let products = d.products.filter(p => {
    if (catFilter && p.category !== catFilter) return false;
    if (query) {
      const q = query.toLowerCase();
      return [p.name, p.brand, p.model, p.category, p.notes].join(' ').toLowerCase().includes(q);
    }
    return true;
  });

  el.innerHTML = `
    <div class="view-scroll">
      <div class="view-head">
        <span class="view-title">PRODUCTS</span>
        <span class="view-sub">${d.products.length} in registry - link products to scope items to build the digital twin</span>
      </div>
      <div class="toolbar">
        <button class="btn primary" id="new-prod">NEW PRODUCT</button>
        <input type="text" class="search-input" id="prod-q" placeholder="search products..." value="${escapeHtml(query)}">
        <select id="prod-cat" class="tb-select">
          <option value="">all categories</option>
          ${CATEGORIES.map(c => `<option ${c === catFilter ? 'selected' : ''}>${c}</option>`).join('')}
        </select>
        <span class="sp"></span>
        <span class="mono faint" style="font-size:10px">Research a product on the web, then capture it here with its link.</span>
      </div>
      <div style="display:grid; grid-template-columns: 1fr ${editingId != null ? '340px' : ''}; gap:16px; align-items:start">
        <div class="prod-grid">${products.map(prodCard).join('') || '<p class="muted">No products yet. NEW PRODUCT to add your first researched item.</p>'}</div>
        ${editingId != null ? `<div class="card" id="prod-form"></div>` : ''}
      </div>
    </div>`;

  el.querySelector('#new-prod').onclick = () => {
    const p = { id: uid('prod'), name: 'New product', brand: '', model: '', category: 'other', url: '', price: 0, unit: 'ea', imageUrl: '', specs: '', notes: '', itemIds: [] };
    d.products.unshift(p);
    editingId = p.id;
    touch(); render();
  };
  const q = el.querySelector('#prod-q');
  q.oninput = () => { query = q.value; render(); el.querySelector('#prod-q').focus(); const i = el.querySelector('#prod-q'); i.setSelectionRange(i.value.length, i.value.length); };
  el.querySelector('#prod-cat').onchange = e => { catFilter = e.target.value; render(); };

  el.querySelectorAll('[data-edit]').forEach(c => c.onclick = e => {
    if (e.target.closest('a')) return;
    editingId = c.dataset.edit;
    render();
  });

  if (editingId != null) renderForm(items);
}

function usedIn(p) {
  const out = [];
  for (const { project, item } of allScopeItems()) {
    if ((p.itemIds || []).includes(item.id)) out.push({ project, item });
  }
  return out;
}

function prodCard(p) {
  const links = usedIn(p);
  return `<div class="card prod-card clickable ${p.id === editingId ? 'active' : ''}" data-edit="${p.id}">
    <div class="p-img">${p.imageUrl ? `<img src="${escapeHtml(p.imageUrl)}" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'ph',textContent:'NO IMAGE'}))">` : '<span class="ph">NO IMAGE</span>'}</div>
    <div class="p-name">${escapeHtml(p.name)}</div>
    <div class="p-meta">${escapeHtml([p.brand, p.model].filter(Boolean).join(' '))}</div>
    <div style="display:flex; gap:5px; margin-top:6px; flex-wrap:wrap">
      <span class="chip">${p.category}</span>
      ${links.map(l => `<span class="chip cyan" title="${escapeHtml(l.project.name)}">${escapeHtml(l.item.name)}</span>`).join('')}
    </div>
    <div style="display:flex; justify-content:space-between; align-items:baseline">
      <span class="p-price">${p.price ? fmtMoney(p.price) + (p.unit && p.unit !== 'ea' ? ' / ' + escapeHtml(p.unit) : '') : ''}</span>
      ${p.url ? `<a href="${escapeHtml(p.url)}" target="_blank" rel="noopener" class="mono" style="color:var(--cyan); font-size:10px">VENDOR</a>` : ''}
    </div>
  </div>`;
}

function renderForm(items) {
  const p = ws.data.products.find(x => x.id === editingId);
  if (!p) { editingId = null; return; }
  const form = el.querySelector('#prod-form');
  form.innerHTML = `
    <h3 class="kicker">EDIT PRODUCT</h3>
    <div class="field"><label>Name</label><input data-f="name" type="text" value="${escapeHtml(p.name)}"></div>
    <div class="field-row">
      <div class="field"><label>Brand</label><input data-f="brand" type="text" value="${escapeHtml(p.brand || '')}"></div>
      <div class="field"><label>Model no</label><input data-f="model" type="text" value="${escapeHtml(p.model || '')}"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Category</label>
        <select data-f="category">${CATEGORIES.map(c => `<option ${c === p.category ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
      <div class="field"><label>Price</label><input data-money="price" type="text" value="${p.price ? fmtMoney(p.price) : ''}"></div>
      <div class="field"><label>Unit</label><input data-f="unit" type="text" value="${escapeHtml(p.unit || 'ea')}" placeholder="ea / sf / lf"></div>
    </div>
    <div class="field"><label>Vendor URL</label><input data-f="url" type="text" value="${escapeHtml(p.url || '')}" placeholder="https://..."></div>
    <div class="field"><label>Image URL</label><input data-f="imageUrl" type="text" value="${escapeHtml(p.imageUrl || '')}" placeholder="https://... (product photo)"></div>
    <div class="field"><label>Specs (one per line, "key: value")</label>
      <textarea data-f="specs" style="min-height:80px; font-family:var(--mono); font-size:11px">${escapeHtml(p.specs || '')}</textarea></div>
    <div class="field"><label>Used in scope items</label>
      <select data-items multiple size="${Math.min(8, Math.max(3, items.length))}" style="font-size:11px">
        ${items.map(({ project, item }) =>
          `<option value="${item.id}" ${(p.itemIds || []).includes(item.id) ? 'selected' : ''}>${escapeHtml(project.name)} / ${escapeHtml(item.name)}</option>`).join('')}
      </select></div>
    <div class="field"><label>Notes</label><textarea data-f="notes">${escapeHtml(p.notes || '')}</textarea></div>
    <div style="display:flex; gap:8px">
      <button class="btn primary" id="prod-done" style="flex:1">DONE</button>
      <button class="btn danger" id="prod-del">DELETE</button>
    </div>`;

  form.querySelectorAll('[data-f]').forEach(inp => inp.onchange = () => { p[inp.dataset.f] = inp.value; touch(); render(); });
  form.querySelector('[data-money=price]').onchange = e => { p.price = parseMoney(e.target.value); touch(); render(); };
  form.querySelector('[data-items]').onchange = e => {
    p.itemIds = Array.from(e.target.selectedOptions).map(o => o.value);
    touch();
  };
  form.querySelector('#prod-done').onclick = () => { editingId = null; render(); };
  form.querySelector('#prod-del').onclick = () => {
    if (!confirm('Delete product "' + p.name + '"?')) return;
    ws.data.products = ws.data.products.filter(x => x.id !== p.id);
    editingId = null;
    touch(); render();
  };
}
