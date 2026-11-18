// PRODUCTS > TRIM CATALOG: every wall trim entry (trim-catalog.js) as a card with its section
// drawn to size, filtered by group and searched by name, maker, model or store. A click opens
// the entry's record beside the grid (store page, size, price, what was read and what was
// inferred). Every card can be dragged: onto a moulding or the trim panel in MODEL, or onto trim
// or a wall in the model (product-drag.js). Float PRODUCTS (products-float.js) to keep the
// catalog over the model while doing that.
// Address: #/trim-catalog (?select=<id>).

import { escapeHtml, fmtMoney, activeProperty } from './store.js';
import { TRIM_STYLES, STYLE_GROUPS, catalogInOrder } from './trims.js';
import { catalogItem } from './trim-catalog.js';
import { trimCutaway, trimElevation } from './trim-previews.js';
import { sizeLabel, productCardHtml } from './trim-panel.js';
import { startTrimDrag, endTrimDrag } from './product-drag.js';

let el = null, floating = false;
let query = '', group = '', selectedId = '';

export function mount(root, opts = {}) {
  el = root; floating = !!opts.floating;
  const m = /[?&]select=([^&]+)/.exec(location.hash);
  if (m && /^#\/trim-catalog/.test(location.hash)) {
    const id = decodeURIComponent(m[1]);
    if (catalogItem(id)) { selectedId = id; query = ''; group = ''; }
    history.replaceState(null, '', '#/trim-catalog');
  }
  root.innerHTML = `<div class="mv tc">
    <div class="mv-head">
      <div class="mv-title-row"><span class="view-title">TRIM CATALOG</span><span class="view-sub" data-count></span></div>
      <div class="mv-tools">
        <input type="text" class="search-input mv-search" placeholder="search trim..." aria-label="Search the trim catalog" value="${escapeHtml(query)}">
        <div class="mv-chips" role="group" aria-label="Kind of trim">${['', ...STYLE_GROUPS].map(g => `<button type="button" class="mv-chip-btn${g === group ? ' active' : ''}" data-group="${escapeHtml(g)}">${escapeHtml((g || 'All').toUpperCase())}</button>`).join('')}</div>
      </div>
      <p class="empty tc-hint">${floating
        ? 'Drag a card onto a moulding in the trim panel, onto trim in the model to swap it, or onto a wall to add it to that face.'
        : 'FLOAT (top right) keeps this catalog over the model: then drag a card onto a moulding in the trim panel, onto trim in the model, or onto a wall.'}</p>
    </div>
    <div class="mv-body">
      <div class="mv-grid-scroll"><div class="mv-grid tc-grid" data-grid></div></div>
      <aside class="mv-editor tc-detail" data-detail hidden></aside>
    </div>
  </div>`;
  const search = root.querySelector('.mv-search');
  search.oninput = () => { query = search.value; renderGrid(); };
  root.querySelectorAll('[data-group]').forEach(b => b.onclick = () => {
    group = b.dataset.group;
    root.querySelectorAll('[data-group]').forEach(x => x.classList.toggle('active', x === b));
    renderGrid();
  });
  renderGrid(); renderDetail();
}
export function unmount() { el = null; }

// How many sections of the open property use each entry.
function usage() {
  const n = new Map();
  for (const t of activeProperty()?.trims || []) n.set(t.product, (n.get(t.product) || 0) + 1);
  return n;
}

function matches(p) {
  if (group && (TRIM_STYLES[p.style] || {}).group !== group) return false;
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = [p.short, p.title, p.brand, p.model, p.store, p.sku, p.material, (TRIM_STYLES[p.style] || {}).label].join(' ').toLowerCase();
  return words.every(w => text.includes(w));
}

function renderGrid() {
  if (!el) return;
  const all = catalogInOrder(), used = usage();
  const items = all.filter(matches);
  el.querySelector('[data-count]').textContent = `${all.length} entries · ${all.filter(p => used.has(p.id)).length} in use here`;
  let last = '';
  el.querySelector('[data-grid]').innerHTML = items.map(p => {
    const head = p.style !== last ? `<div class="tc-group-head">${escapeHtml((TRIM_STYLES[p.style] || {}).label || p.style)}</div>` : '';
    last = p.style;
    const n = used.get(p.id) || 0;
    return `${head}<button type="button" class="mv-card tc-card${p.id === selectedId ? ' active' : ''}" draggable="true" data-id="${escapeHtml(p.id)}" title="${escapeHtml(p.title)}">
      <div class="tc-thumb">${trimCutaway(p)}${n ? `<span class="tc-used" title="Sections of this property made of it">${n}</span>` : ''}</div>
      <div class="mv-card-body">
        <div class="tc-name">${escapeHtml(p.short || p.title)}</div>
        <div class="tc-line">${escapeHtml(p.brand)} ${escapeHtml(p.model || '')} · ${escapeHtml(sizeLabel(p))}</div>
        <div class="tc-line">${escapeHtml(p.store || '')}${p.price ? ' · ' + fmtMoney(p.price) + (p.priceUnit ? '/' + escapeHtml(p.priceUnit) : '') : ''}</div>
      </div>
    </button>`;
  }).join('') || '<p class="empty">Nothing in the catalog matches.</p>';
  el.querySelectorAll('[data-id]').forEach(card => {
    card.onclick = () => { selectedId = selectedId === card.dataset.id ? '' : card.dataset.id; el.querySelectorAll('[data-id]').forEach(c => c.classList.toggle('active', c.dataset.id === selectedId)); renderDetail(); };
    card.ondragstart = e => { const p = catalogItem(card.dataset.id); startTrimDrag(e, card.dataset.id, p && (p.short || p.title)); };
    card.ondragend = endTrimDrag;
  });
}

function renderDetail() {
  if (!el) return;
  const pane = el.querySelector('[data-detail]'), p = selectedId && catalogItem(selectedId);
  pane.hidden = !p;
  if (!p) { pane.innerHTML = ''; return; }
  const style = TRIM_STYLES[p.style] || {};
  const field = style.kind === 'field';
  const n = usage().get(p.id) || 0;
  const row = (k, v) => v ? `<div class="stat-line"><span>${escapeHtml(k)}</span><b>${escapeHtml(v)}</b></div>` : '';
  pane.innerHTML = `<div class="tc-detail-head"><span class="kicker">${escapeHtml(style.label || p.style)}</span><button type="button" class="btn small" data-close>CLOSE</button></div>
    <h3 class="tc-detail-title">${escapeHtml(p.short || p.title)}</h3>
    <div class="tc-drag" draggable="true" title="Drag this onto a moulding, onto trim or onto a wall in MODEL">${productCardHtml(p, { evidence: true })}</div>
    ${field ? `<div class="tc-elev">${trimElevation(p)}</div>` : ''}
    ${row('Piece', p.length)}${row('Material', p.material)}${row('Finish', p.finish)}${row('Used in this property', n ? n + (n === 1 ? ' section' : ' sections') : '')}
    ${p.profileText ? `<p class="note">${escapeHtml(p.profileText)}</p>` : ''}
    ${p.notes ? `<p class="note">${escapeHtml(p.notes)}</p>` : ''}
    <p class="empty">Prices were read from the store page on the date in the evidence line; check the store page before ordering.</p>
    ${floating ? '<button type="button" class="btn primary" data-use title="Swap the trim selected in MODEL to this entry, as far as CHANGES REACH goes.">USE ON THE SELECTED TRIM</button>' : ''}`;
  pane.querySelector('[data-close]').onclick = () => { selectedId = ''; renderGrid(); renderDetail(); };
  const drag = pane.querySelector('.tc-drag');
  drag.ondragstart = e => startTrimDrag(e, p.id, p.short || p.title);
  drag.ondragend = endTrimDrag;
  const use = pane.querySelector('[data-use]');
  if (use) use.onclick = () => window.dispatchEvent(new CustomEvent('tiksi:use-trim', { detail: { id: p.id } }));
}
