// Cut sheets: printable spec packages. One per scope item (elements + materials +
// products + budget) and one per product (classic product cut sheet).

import {
  ws, escapeHtml, fmtMoney, fmtLen, fmtArea, fmtDate, isoToday,
  allScopeItems, elementInfo, materialById, itemTotals,
} from './store.js';

let el = null;
let current = null; // {kind:'item'|'product', id}

export function mount(root) { el = root; render(); }
export function unmount() { el = null; }

function render() {
  if (!el) return;
  const items = allScopeItems();
  const products = ws.data.products;
  if (!current) {
    if (items.length) current = { kind: 'item', id: items[0].item.id };
    else if (products.length) current = { kind: 'product', id: products[0].id };
  }

  const groups = {};
  for (const { project, item } of items) (groups[project.name] = groups[project.name] || []).push(item);

  el.innerHTML = `
    <div class="sheet-layout">
      <div class="sheet-list">
        <div style="display:flex; justify-content:space-between; align-items:center">
          <span class="kicker" style="margin:0">CUT SHEETS</span>
          <button class="btn small primary" id="print-sheet">PRINT</button>
        </div>
        ${Object.entries(groups).map(([proj, its]) => `
          <div class="sl-group">${escapeHtml(proj)}</div>
          ${its.map(it => `<button class="sl-item ${current && current.kind === 'item' && current.id === it.id ? 'active' : ''}"
            data-kind="item" data-id="${it.id}">${escapeHtml(it.name)}</button>`).join('')}
        `).join('') || '<p class="muted" style="font-size:11px; margin-top:10px">No scope items yet.</p>'}
        <div class="sl-group">PRODUCT SHEETS</div>
        ${products.map(p => `<button class="sl-item ${current && current.kind === 'product' && current.id === p.id ? 'active' : ''}"
          data-kind="product" data-id="${p.id}">${escapeHtml(p.name)}</button>`).join('') || '<p class="muted" style="font-size:11px">No products yet.</p>'}
      </div>
      <div class="sheet-view" id="sheet-view"></div>
    </div>`;

  el.querySelectorAll('.sl-item').forEach(b => b.onclick = () => {
    current = { kind: b.dataset.kind, id: b.dataset.id };
    render();
  });
  el.querySelector('#print-sheet').onclick = () => {
    const html = currentSheetHtml();
    if (!html) return;
    document.getElementById('print-root').innerHTML = html;
    window.print();
  };

  const view = el.querySelector('#sheet-view');
  view.innerHTML = currentSheetHtml() || '<p class="muted">Nothing to show yet. Add scope items in PROJECTS or products in PRODUCTS.</p>';
}

function currentSheetHtml() {
  if (!current) return '';
  if (current.kind === 'item') {
    for (const { project, item } of allScopeItems()) {
      if (item.id === current.id) return itemSheetHtml(project, item);
    }
  } else {
    const p = ws.data.products.find(p => p.id === current.id);
    if (p) return productSheetHtml(p);
  }
  return '';
}

function specLines(specs) {
  return String(specs || '').split('\n').map(s => s.trim()).filter(Boolean);
}

function productBlock(p) {
  return `<div class="p-block">
    ${p.imageUrl ? `<img src="${escapeHtml(p.imageUrl)}" onerror="this.style.display='none'">` : ''}
    <div style="flex:1">
      <div class="pb-name">${escapeHtml(p.name)}</div>
      <div class="pb-meta">${escapeHtml([p.brand, p.model].filter(Boolean).join(' - '))}${p.category ? ' - ' + p.category : ''}</div>
      <div class="pb-specs">${specLines(p.specs).map(s => escapeHtml(s)).join('<br>')}</div>
      ${p.notes ? `<div class="pb-specs" style="margin-top:6px; color:#555">${escapeHtml(p.notes)}</div>` : ''}
      <div class="pb-price">${p.price ? fmtMoney(p.price) + (p.unit && p.unit !== 'ea' ? ' per ' + escapeHtml(p.unit) : '') : 'price TBD'}</div>
      ${p.url ? `<div style="font-size:11px; margin-top:3px"><a href="${escapeHtml(p.url)}">${escapeHtml(p.url)}</a></div>` : ''}
    </div>
  </div>`;
}

function itemSheetHtml(project, item) {
  const t = itemTotals(item);
  const prods = ws.data.products.filter(p => (p.itemIds || []).includes(item.id));
  const elements = (item.elementIds || []).map(id => elementInfo(project.propertyId, id)).filter(Boolean);
  const matIds = new Set(elements.map(e => e.material).filter(Boolean));
  const wallArea = elements.filter(e => e.kind === 'wall').reduce((n, e) => n + e.area, 0);
  const floorArea = elements.filter(e => e.kind === 'room').reduce((n, e) => n + e.area, 0);

  return `<div class="sheet sheet-page">
    <div class="s-head"><span class="s-brand">TIKSI</span><span class="s-doc">Scope cut sheet</span></div>
    <h1>${escapeHtml(item.name)}</h1>
    <div class="s-sub">${escapeHtml(project.name)} - ${project.category} - status: ${project.status}</div>

    <h2>Budget line</h2>
    <table><thead><tr><th class="num">Qty</th><th>Unit</th><th class="num">Low</th><th class="num">Likely</th><th class="num">High</th><th class="num">Duration</th></tr></thead>
      <tbody><tr>
        <td class="num">${item.qty || 1}</td><td>${escapeHtml(item.unit || 'ls')}</td>
        <td class="num">${fmtMoney(t.low)}</td><td class="num"><b>${fmtMoney(t.likely)}</b></td><td class="num">${fmtMoney(t.high)}</td>
        <td class="num">${item.durationDays || 0} days</td>
      </tr></tbody></table>

    ${elements.length ? `<h2>Model elements (digital twin)</h2>
    <table><thead><tr><th>Element</th><th class="num">Length</th><th class="num">Height</th><th class="num">Area</th><th>Material</th></tr></thead>
      <tbody>${elements.map(e => `<tr>
        <td>${escapeHtml(e.label)} <span style="color:#999; font-family:var(--mono); font-size:10px">${e.id}</span></td>
        <td class="num">${e.length ? fmtLen(e.length) : '-'}</td>
        <td class="num">${e.height ? fmtLen(e.height) : '-'}</td>
        <td class="num">${fmtArea(e.area)}</td>
        <td>${escapeHtml((materialById(e.material) || {}).name || '-')}</td></tr>`).join('')}
      ${wallArea || floorArea ? `<tr><td><b>Takeoff totals</b></td><td></td><td></td>
        <td class="num"><b>${wallArea ? fmtArea(wallArea) + ' wall' : ''}${wallArea && floorArea ? ', ' : ''}${floorArea ? fmtArea(floorArea) + ' floor' : ''}</b></td><td></td></tr>` : ''}
      </tbody></table>` : ''}

    ${matIds.size ? `<h2>Materials</h2>
      <table><tbody>${[...matIds].map(id => {
        const m = materialById(id);
        return m ? `<tr><td><span style="display:inline-block;width:12px;height:12px;background:${m.color};border:1px solid #999;vertical-align:middle;margin-right:8px"></span>${escapeHtml(m.name)}</td></tr>` : '';
      }).join('')}</tbody></table>` : ''}

    ${prods.length ? `<h2>Specified products</h2>${prods.map(productBlock).join('')}
      <table style="margin-top:8px"><tbody><tr><td><b>Product subtotal (unit prices)</b></td>
      <td class="num"><b>${fmtMoney(prods.reduce((n, p) => n + (p.price || 0), 0))}</b></td></tr></tbody></table>` : ''}

    ${item.notes ? `<h2>Notes</h2><p style="font-size:12.5px">${escapeHtml(item.notes)}</p>` : ''}

    <div class="s-foot"><span>tiksi design console - ${escapeHtml(project.name)}</span><span>${fmtDate(isoToday())}</span></div>
  </div>`;
}

function productSheetHtml(p) {
  const uses = [];
  for (const { project, item } of allScopeItems()) {
    if ((p.itemIds || []).includes(item.id)) uses.push(project.name + ' / ' + item.name);
  }
  return `<div class="sheet sheet-page">
    <div class="s-head"><span class="s-brand">TIKSI</span><span class="s-doc">Product cut sheet</span></div>
    <h1>${escapeHtml(p.name)}</h1>
    <div class="s-sub">${escapeHtml([p.brand, p.model].filter(Boolean).join(' - '))} - ${p.category}</div>
    ${productBlock(p)}
    ${uses.length ? `<h2>Specified in</h2><table><tbody>${uses.map(u => `<tr><td>${escapeHtml(u)}</td></tr>`).join('')}</tbody></table>` : ''}
    <div class="s-foot"><span>tiksi design console</span><span>${fmtDate(isoToday())}</span></div>
  </div>`;
}
