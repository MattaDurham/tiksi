// Product registry: researched products with vendor and manufacturer links, specs, prices
// and their sources, linked to scope items so the model becomes a true digital twin.

import { ws, uid, touch, fmtMoney, parseMoney, escapeHtml, allScopeItems, activeProperty, projectSlice } from './store.js';
import { icon } from './icons.js';
import { openResearch, safeResearchUrl, researchApi } from './research.js';
import { diskWorkspace } from './disk-workspace.js';

const CATEGORIES = ['appliance', 'plumbing', 'lighting', 'flooring', 'tile', 'cabinetry', 'hardware', 'hvac', 'electrical', 'lumber', 'windows-doors', 'paint', 'other'];
const STALE_DAYS = 90;
const TERMINAL = new Set(['completed', 'partial', 'failed', 'cancelled']);
const STATUS_FILTERS = [
  ['', 'any status'], ['no-image', 'missing image'], ['no-price', 'missing price'],
  ['stale', `price not checked in ${STALE_DAYS} days`], ['docs', 'has spec documents'], ['unlinked', 'not linked to work'],
];

function availableCategories() {
  // Research and imports can bring a more specific source category. Keep it
  // selectable instead of letting the browser display the first unrelated one.
  return [...new Set([...CATEGORIES, ...ws.data.products.map(p => p.category).filter(c => typeof c === 'string' && c.trim())])];
}

let el = null;
let editingId = null;
let draft = null;                 // a new product, kept out of the registry until it has an image
let query = '', catFilter = '', statusFilter = '', scope = 'property';
let message = '';                 // result of the last open-file or price action, shown in the editor
let pollTimer = null;

export function mount(root) {
  el = root;
  // Deep link from PROJECTS: #/products?select=<productId> opens that product's form.
  const m = /[?&]select=([^&]+)/.exec(location.hash);
  if (m) {
    const id = decodeURIComponent(m[1]);
    if (byId(id)) { editingId = id; draft = null; query = ''; catFilter = ''; statusFilter = ''; }
    history.replaceState(null, '', '#/products');
  }
  render(); pollPriceChecks();
}
// The open editor (and an unsaved new product) survive a redraw: a disk sync swaps in fresh
// workspace data and remounts this view while someone may be typing.
export function unmount() { el = null; }
const byId = id => ws.data.products.find(p => p.id === id);

// ---------- what a product is ----------

// Products that travel with this property's project file (store.projectSlice).
function propertyProductIds(prop) {
  return prop ? new Set(projectSlice(prop.id).products.map(p => p.id)) : null;
}

// The property whose project folder holds a product's documents: the open one if the
// product belongs to it, else the first property it belongs to.
function homeProperty(p) {
  const active = activeProperty();
  if (active && propertyProductIds(active).has(p.id)) return active;
  return ws.data.properties.find(prop => propertyProductIds(prop).has(p.id)) || active;
}

const squash = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const host = url => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };

// Older records keep one `url`. Until someone edits the links, a page on the brand's own
// site reads as the manufacturer's and anything else as the vendor's.
function productLinks(p) {
  if ('manufacturerUrl' in p) return { vendor: p.url || '', maker: p.manufacturerUrl || '' };
  const brand = squash((p.brand || '').split(/\s+/)[0]);
  const onBrandSite = brand.length >= 3 && squash(host(p.url)).includes(brand);
  return onBrandSite ? { vendor: '', maker: p.url || '' } : { vendor: p.url || '', maker: '' };
}

// Where the price came from and when it was last checked.
function priceSource(p) {
  const candidate = p.research?.candidate || {};
  const url = p.priceSourceUrl || candidate.priceSourceUrl || '';
  const offer = (candidate.offers || []).find(o => o.url === url);
  const checkedAt = p.priceCheckedAt || offer?.checkedAt || (url ? p.research?.researchedAt || p.research?.savedAt : '') || '';
  return { url: safeResearchUrl(url), checkedAt };
}

function daysSince(iso) {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? Math.floor((Date.now() - t) / 86400000) : Infinity;
}

function fmtChecked(iso) {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
}

function workLinks(p) {
  const out = [];
  for (const { project, item } of allScopeItems()) {
    if ((p.itemIds || []).includes(item.id)) out.push({ project, item });
  }
  return out;
}

function matchesStatus(p) {
  switch (statusFilter) {
    case 'no-image': return !p.imageUrl;
    case 'no-price': return !p.price;
    case 'stale': return !!p.price && daysSince(priceSource(p).checkedAt) > STALE_DAYS;
    case 'docs': return (p.documents || []).length > 0;
    case 'unlinked': return !(p.itemIds || []).length;
    default: return true;
  }
}

// ---------- type-ahead picker ----------

// A text box with a list under it that narrows as you type: names that start with the
// typed letters first, then names with a word that starts with them, then any match.
function combobox({ id, value, placeholder, label }) {
  return `<div class="combo" data-combo="${id}">
    <input type="text" id="${id}" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${id}-list"
      autocomplete="off" spellcheck="false" placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(value)}" aria-label="${escapeHtml(label)}">
    <ul class="combo-list" id="${id}-list" role="listbox" hidden></ul>
  </div>`;
}

export function rankOptions(options, typed) {
  const q = typed.trim().toLowerCase();
  if (!q) return options;
  const starts = [], word = [], within = [];
  for (const o of options) {
    const name = o.toLowerCase();
    if (name.startsWith(q)) starts.push(o);
    else if (name.split(/[\s\-/_]+/).some(w => w.startsWith(q))) word.push(o);
    else if (name.includes(q)) within.push(o);
  }
  return [...starts, ...word, ...within];
}

// onPick(value) gets an option, or the typed text when allowNew. A blank box picks ''.
function bindCombobox(root, id, { options, counts, allowNew, onPick }) {
  const wrap = root.querySelector(`[data-combo="${id}"]`);
  const input = wrap.querySelector('input'), list = wrap.querySelector('ul');
  const committed = input.value;
  let shown = [], active = -1;
  const draw = () => {
    const typed = input.value === committed ? '' : input.value;
    shown = rankOptions(options, typed);
    const extra = allowNew && typed.trim() && !options.some(o => o.toLowerCase() === typed.trim().toLowerCase()) ? typed.trim() : '';
    if (extra) shown = [...shown, extra];
    active = Math.min(active, shown.length - 1);
    list.innerHTML = shown.length ? shown.map((o, i) => `<li role="option" id="${id}-opt-${i}" data-i="${i}" aria-selected="${i === active}" class="${i === active ? 'active' : ''}">
      ${o === extra ? `<span>Use "${escapeHtml(o)}"</span>` : `<span>${escapeHtml(o)}</span>`}${counts && counts[o] != null ? `<b>${counts[o]}</b>` : ''}</li>`).join('')
      : '<li class="combo-empty">No match</li>';
    list.hidden = false; input.setAttribute('aria-expanded', 'true');
    if (active >= 0) input.setAttribute('aria-activedescendant', `${id}-opt-${active}`); else input.removeAttribute('aria-activedescendant');
    list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  };
  const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); };
  const pick = value => { close(); if (value !== committed) onPick(value); else input.value = committed; };
  // Leaving the box: an exact name, a new name (allowNew) or a blank box counts; anything else reverts.
  const settle = () => {
    const typed = input.value.trim();
    if (!typed) return pick('');
    const exact = options.find(o => o.toLowerCase() === typed.toLowerCase());
    if (exact) return pick(exact);
    if (allowNew) return pick(typed);
    input.value = committed; close();
  };
  input.onfocus = () => { input.select(); active = -1; draw(); };
  input.oninput = () => { active = input.value.trim() ? 0 : -1; draw(); };
  input.onkeydown = e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); if (list.hidden) draw();
      active = Math.max(0, Math.min(shown.length - 1, active + (e.key === 'ArrowDown' ? 1 : -1))); draw();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (active >= 0 && shown[active] != null) pick(shown[active]); else settle();
    } else if (e.key === 'Escape') { input.value = committed; close(); input.blur(); }
  };
  input.onblur = () => setTimeout(() => { if (document.activeElement !== input) settle(); }, 0);
  list.onmousedown = e => {
    const li = e.target.closest('[data-i]');
    e.preventDefault();
    if (li) pick(shown[Number(li.dataset.i)]);
  };
}

// ---------- list ----------

function render() {
  if (!el) return;
  const d = ws.data;
  const prop = activeProperty();
  const mine = propertyProductIds(prop);
  const inScope = p => scope === 'all' || !mine || mine.has(p.id);
  const scoped = d.products.filter(inScope);
  const counts = {};
  for (const p of scoped) counts[p.category] = (counts[p.category] || 0) + 1;
  const products = scoped.filter(p => {
    if (catFilter && p.category !== catFilter) return false;
    if (!matchesStatus(p)) return false;
    if (query) {
      const q = query.toLowerCase();
      return [p.name, p.brand, p.model, p.category, p.notes].join(' ').toLowerCase().includes(q);
    }
    return true;
  });
  const formOpen = editingId != null || draft;

  el.innerHTML = `
    <div class="view-scroll">
      <div class="view-head">
        <span class="view-title">PRODUCTS</span>
        <span class="view-sub">${mine ? `${mine.size} in ${escapeHtml(prop.name)}, ` : ''}${d.products.length} in registry - link products to scope items to build the digital twin</span>
      </div>
      <div class="toolbar prod-toolbar">
        <button class="btn primary" id="new-prod">${icon('plus')}NEW PRODUCT</button>
        <button class="btn" id="research-prod">RESEARCH PRODUCTS</button>
        ${mine ? `<div class="seg" role="group" aria-label="Which products">
          <button class="seg-btn ${scope === 'property' ? 'active' : ''}" data-scope="property" aria-pressed="${scope === 'property'}" title="Products linked to ${escapeHtml(prop.name)}'s work, materials, or added while it was open">THIS PROPERTY <b>${mine.size}</b></button>
          <button class="seg-btn ${scope === 'all' ? 'active' : ''}" data-scope="all" aria-pressed="${scope === 'all'}">ALL <b>${d.products.length}</b></button>
        </div>` : ''}
        <input type="text" class="search-input" id="prod-q" placeholder="search products..." value="${escapeHtml(query)}">
        ${combobox({ id: 'prod-cat', value: catFilter, placeholder: 'all categories', label: 'Filter by category' })}
        ${catFilter ? `<button class="btn small" id="prod-cat-clear" title="Show all categories">${icon('close', { size: 11 })}</button>` : ''}
        <select id="prod-status" class="tb-select" aria-label="Filter by status">
          ${STATUS_FILTERS.map(([v, label]) => `<option value="${v}" ${v === statusFilter ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')}
        </select>
        <span class="sp"></span>
        <span class="mono faint prod-count">${products.length} shown</span>
      </div>
      <div class="products-layout prod-layout ${formOpen ? 'has-editor' : ''}">
        ${products.length ? `<div class="prod-grid">${products.map(prodCard).join('')}</div>` :
          `<div class="empty-state"><span class="empty-ic">${icon('products')}</span>
            <b>${d.products.length ? 'No products match' : 'No products yet'}</b>
            ${d.products.length ? (scope === 'property' && mine && scoped.length < d.products.length ? 'Try ALL to see other properties\' products, or a different search, category or status.' : 'Try a different search, category or status.') : 'Research a product on the web, then capture it here with its image, vendor link, price and specs.'}</div>`}
        ${formOpen ? `<div class="card" id="prod-form" data-side-pane="products"></div>` : ''}
      </div>
    </div>`;

  el.querySelector('#new-prod').onclick = () => {
    draft = { id: uid('prod'), name: '', brand: '', model: '', category: catFilter || 'other', url: '', manufacturerUrl: '', price: 0, unit: 'ea', imageUrl: '', specs: '', notes: '', itemIds: [] };
    editingId = null; message = '';
    render();
    el.querySelector('#prod-form [data-image-url]')?.focus();
  };
  el.querySelector('#research-prod').onclick = () => openResearch({});
  el.querySelectorAll('[data-scope]').forEach(b => b.onclick = () => { scope = b.dataset.scope; render(); });
  const q = el.querySelector('#prod-q');
  q.oninput = () => { query = q.value; render(); const i = el.querySelector('#prod-q'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); };
  bindCombobox(el, 'prod-cat', { options: Object.keys(counts).sort(), counts, onPick: v => { catFilter = v; render(); } });
  el.querySelector('#prod-cat-clear')?.addEventListener('click', () => { catFilter = ''; render(); });
  el.querySelector('#prod-status').onchange = e => { statusFilter = e.target.value; render(); };

  el.querySelectorAll('[data-edit]').forEach(c => c.onclick = e => {
    if (e.target.closest('a, button')) return;
    editingId = c.dataset.edit; draft = null; message = '';
    render();
  });
  el.querySelectorAll('[data-research-product]').forEach(b => b.onclick = () => {
    const p = d.products.find(p => p.id === b.dataset.researchProduct);
    if (p) researchProduct(p);
  });

  if (formOpen) renderForm();
}

function prodCard(p) {
  const links = workLinks(p);
  const { vendor, maker } = productLinks(p);
  const vendorUrl = safeResearchUrl(vendor), makerUrl = safeResearchUrl(maker);
  const checked = priceSource(p).checkedAt;
  const stale = p.price && daysSince(checked) > STALE_DAYS;
  return `<div class="card prod-card clickable ${p.id === editingId ? 'active' : ''}" data-edit="${escapeHtml(p.id)}">
    <div class="p-img">${p.imageUrl ? `<img src="${escapeHtml(p.imageUrl)}" loading="lazy" alt="" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'ph',textContent:'IMAGE DID NOT LOAD'}))">` : `<span class="ph">${icon('image')}NO IMAGE</span>`}</div>
    <div class="p-name">${escapeHtml(p.name)}</div>
    <div class="p-meta">${escapeHtml([p.brand, p.model].filter(Boolean).join(' '))}</div>
    <div class="p-chips">
      <span class="chip">${escapeHtml(p.category)}</span>
      ${(p.materialIds || []).map(id => ws.data.materials.find(m => m.id === id)).filter(Boolean).map(m => `<span class="chip cyan">${escapeHtml(m.name)}</span>`).join('')}
      ${(p.documents || []).length ? `<span class="chip" title="Spec documents saved in the project folder">${icon('file')}${p.documents.length} DOCS</span>` : ''}
      ${p.priceCheck?.status === 'running' ? '<span class="chip">CHECKING PRICE</span>' : ''}
      ${links.map(l => `<span class="chip cyan" title="${escapeHtml(l.project.name)}">${icon('link')}${escapeHtml(l.item.name)}</span>`).join('')}
    </div>
    <div class="p-foot">
      <span class="p-price">${p.price ? fmtMoney(p.price) + (p.unit && p.unit !== 'ea' ? ' / ' + escapeHtml(p.unit) : '') : ''}</span>
      <span class="p-links">
        ${vendorUrl ? `<a href="${escapeHtml(vendorUrl)}" target="_blank" rel="noopener noreferrer" class="p-link" title="Where to buy: ${escapeHtml(host(vendorUrl))}">VENDOR ${icon('arrow-right', { size: 11 })}</a>` : ''}
        ${makerUrl ? `<a href="${escapeHtml(makerUrl)}" target="_blank" rel="noopener noreferrer" class="p-link" title="Manufacturer's page: ${escapeHtml(host(makerUrl))}">MAKER ${icon('arrow-right', { size: 11 })}</a>` : ''}
      </span>
    </div>
    ${p.price ? `<div class="p-checked ${stale ? 'stale' : ''}">${checked ? `price checked ${escapeHtml(fmtChecked(checked))}` : 'price source not recorded'}</div>` : ''}
    <button class="btn" data-research-product="${escapeHtml(p.id)}">RESEARCH ALTERNATIVES</button>
  </div>`;
}

function researchProduct(p) {
  openResearch({ kind: 'product', id: p.id, name: [p.name, p.brand, p.model].filter(Boolean).join(' '), category: p.category, specifications: p.specs, itemIds: [...(p.itemIds || [])] });
}

// ---------- image ----------

// An uploaded or pasted picture is scaled to fit 800 px and kept with the product record.
async function imageFileToUrl(file) {
  if (!file || !/^image\//.test(file.type)) throw new Error('Choose an image file (JPEG, PNG, WebP or GIF).');
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 800 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const g = canvas.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, canvas.width, canvas.height);
  g.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return canvas.toDataURL('image/jpeg', 0.85);
}

function loads(url) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve(img.naturalWidth > 0);
    img.onerror = () => resolve(false);
    img.src = url;
  });
}

function imageField(p, isNew) {
  return `<div class="prod-image-field ${isNew && !p.imageUrl ? 'required' : ''}">
    <div class="prod-image-preview" data-image-preview>${p.imageUrl ? `<img src="${escapeHtml(p.imageUrl)}" alt="">` : `<span class="ph">${icon('image')}${isNew ? 'IMAGE REQUIRED' : 'NO IMAGE'}</span>`}</div>
    <div class="field"><label for="prod-image-url">Image ${isNew ? '(required)' : ''}</label>
      <input id="prod-image-url" data-image-url type="text" value="${escapeHtml(p.imageUrl && !p.imageUrl.startsWith('data:') ? p.imageUrl : '')}" placeholder="${p.imageUrl?.startsWith('data:') ? 'uploaded image - paste a link to replace' : 'paste an image link, or upload'}"></div>
    <div class="prod-image-actions">
      <label class="btn small">${icon('upload', { size: 11 })}UPLOAD IMAGE<input type="file" accept="image/*" data-image-file hidden></label>
      <span class="faint prod-hint">or paste a picture anywhere in this form</span>
    </div>
    <p class="prod-hint" data-image-status role="status"></p>
  </div>`;
}

function bindImage(form, p, after) {
  const status = form.querySelector('[data-image-status]');
  const set = async (url, label) => {
    status.textContent = 'Loading image...';
    if (!(await loads(url))) { status.textContent = `That ${label} did not load as an image. Try another link or upload the picture.`; return; }
    // Loading can outlast a disk sync that swaps the workspace; write to the current record.
    (draft?.id === p.id ? draft : byId(p.id) || p).imageUrl = url; status.textContent = '';
    after();
  };
  form.querySelector('[data-image-url]').onchange = e => {
    const url = e.target.value.trim();
    if (!url) return;
    const safe = safeResearchUrl(url);
    if (!safe) { status.textContent = 'Image links must start with http:// or https://.'; return; }
    set(safe, 'link');
  };
  const fromFile = async file => {
    try { await set(await imageFileToUrl(file), 'file'); }
    catch (e) { status.textContent = e.message || 'That file could not be read as an image.'; }
  };
  form.querySelector('[data-image-file]').onchange = e => { if (e.target.files[0]) fromFile(e.target.files[0]); };
  form.onpaste = e => {
    const file = [...(e.clipboardData?.files || [])].find(f => /^image\//.test(f.type));
    if (file) { e.preventDefault(); fromFile(file); }
  };
}

// ---------- editor ----------

function renderForm() {
  const isNew = !!draft;
  const p = draft || ws.data.products.find(x => x.id === editingId);
  if (!p) { editingId = null; return; }
  const form = el.querySelector('#prod-form');
  const items = allScopeItems();
  const { vendor, maker } = productLinks(p);
  const src = priceSource(p);
  const check = p.priceCheck || {};
  const docs = p.documents || [];
  const home = homeProperty(p);
  const folderReady = !!(diskWorkspace && home && diskWorkspace.paths[home.id]);
  const specFolder = docs.map(doc => String(doc.path || '').split('/').slice(0, 2).join('/')).find(Boolean) || '';
  const byProject = new Map();
  for (const { project, item } of items) {
    if (!byProject.has(project.id)) byProject.set(project.id, { project, items: [] });
    byProject.get(project.id).items.push(item);
  }
  form.innerHTML = `
    <div class="prod-form-head"><h3 class="kicker">${isNew ? 'NEW PRODUCT' : 'EDIT PRODUCT'}</h3>
      <button class="btn small" id="prod-close" title="Close">${icon('close', { size: 11 })}</button></div>
    ${imageField(p, isNew)}
    <div class="field"><label>Name</label><input data-f="name" type="text" value="${escapeHtml(p.name)}" placeholder="e.g. 36 in gas range"></div>
    <div class="field-row">
      <div class="field"><label>Brand</label><input data-f="brand" type="text" value="${escapeHtml(p.brand || '')}"></div>
      <div class="field"><label>Model no</label><input data-f="model" type="text" value="${escapeHtml(p.model || '')}"></div>
    </div>
    <div class="field"><label for="prod-category">Category</label>${combobox({ id: 'prod-category', value: p.category || '', placeholder: 'type to find or add a category', label: 'Category' })}</div>

    <div class="prod-section">
      <div class="field-row">
        <div class="field"><label>Price</label><input data-money="price" type="text" value="${p.price ? fmtMoney(p.price) : ''}"></div>
        <div class="field"><label>Unit</label><input data-f="unit" type="text" value="${escapeHtml(p.unit || 'ea')}" placeholder="ea / sf / lf"></div>
      </div>
      <div class="prod-price-source">
        ${src.url ? `<a href="${escapeHtml(src.url)}" target="_blank" rel="noopener noreferrer" data-price-link>${escapeHtml(host(src.url) || 'price source')} ${icon('arrow-right', { size: 11 })}</a>` : '<span class="faint">No price source recorded</span>'}
        <span class="faint" data-price-checked>${src.checkedAt ? 'checked ' + escapeHtml(fmtChecked(src.checkedAt)) : 'never checked'}</span>
        ${isNew ? '' : `<button class="btn small" id="prod-refresh-price" ${check.status === 'running' ? 'disabled' : ''} title="Look up the current price for this exact model">${icon('refresh', { size: 11 })}${check.status === 'running' ? 'CHECKING...' : 'REFRESH'}</button>`}
      </div>
      ${check.status && check.status !== 'running' && check.message ? `<p class="prod-hint ${check.status === 'updated' ? '' : 'warn'}" role="status">${escapeHtml(check.message)}</p>` : ''}
      ${check.status === 'running' ? '<p class="prod-hint" role="status">A research agent is checking the price. This takes a few minutes; you can keep working.</p>' : ''}
      <div class="field"><label>Price source link</label><input data-price-source type="text" value="${escapeHtml(p.priceSourceUrl || '')}" placeholder="https://... (page showing this price)"></div>
    </div>

    <div class="field"><label>Vendor link <span class="faint">(where to buy)</span></label><input data-link="vendor" type="text" value="${escapeHtml(vendor)}" placeholder="https://..."></div>
    <div class="field"><label>Manufacturer link <span class="faint">(maker's product page)</span></label><input data-link="maker" type="text" value="${escapeHtml(maker)}" placeholder="https://..."></div>
    <div class="field"><label>Specs (one per line, "key: value")</label>
      <textarea data-f="specs" style="min-height:80px; font-family:var(--mono); font-size:11px">${escapeHtml(p.specs || '')}</textarea></div>

    ${isNew ? '' : `<div class="prod-section">
      <label class="prod-label">Spec folder <span class="faint">${home ? escapeHtml(home.name) + ' project folder' : ''}</span></label>
      ${docs.length ? `<ul class="prod-docs">${docs.map((doc, i) => {
        const url = safeResearchUrl(doc.url);
        return `<li><span class="chip">${escapeHtml(doc.kind || 'file')}</span>
          <button class="link-btn" data-open-doc="${i}" ${folderReady ? '' : 'disabled'} title="${escapeHtml(doc.path || '')}">${escapeHtml(doc.title || doc.path || 'document')}</button>
          ${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="faint" title="Where this file was downloaded from">source</a>` : ''}</li>`;
      }).join('')}</ul>` : '<p class="prod-hint">No manuals or spec sheets saved for this product yet.</p>'}
      <div class="prod-folder-actions">
        ${specFolder ? `<button class="btn small" data-open-path="${escapeHtml(specFolder)}" ${folderReady ? '' : 'disabled'}>${icon('file', { size: 11 })}OPEN SPEC FOLDER</button>` : ''}
        <button class="btn small" data-open-path="" ${folderReady ? '' : 'disabled'}>${icon('file', { size: 11 })}OPEN PROJECT FOLDER</button>
      </div>
      ${folderReady ? '' : `<p class="prod-hint">${diskWorkspace ? 'This property has not been saved to a project folder yet.' : 'Project folders open from Tiksi on the Mac that keeps them.'}</p>`}
    </div>`}

    <div class="field"><label class="prod-label">Used in work items</label>
      <p class="prod-hint">Tick the PROJECTS line items this product is for. A ticked item lists the product on its cut sheet, and the product is saved in that property's project file.</p>
      ${byProject.size ? `<div class="prod-work" data-items>${[...byProject.values()].map(({ project, items }) => `<fieldset><legend>${escapeHtml(project.name)}</legend>
        ${items.map(item => `<label><input type="checkbox" value="${escapeHtml(item.id)}" ${(p.itemIds || []).includes(item.id) ? 'checked' : ''}> ${escapeHtml(item.name)}</label>`).join('')}</fieldset>`).join('')}</div>`
        : '<p class="prod-hint">This property has no work items yet. Add them in PROJECTS.</p>'}</div>
    <div class="field"><label>Notes</label><textarea data-f="notes">${escapeHtml(p.notes || '')}</textarea></div>
    ${p.research ? provenance(p.research) : ''}
    ${message ? `<p class="prod-hint" role="status" data-form-message>${escapeHtml(message)}</p>` : ''}
    ${isNew ? `<div class="prod-actions">
      <button class="btn primary" id="prod-add" ${p.imageUrl && p.name.trim() ? '' : 'disabled'} style="flex:1">${icon('check')}ADD PRODUCT</button>
      <button class="btn" id="prod-cancel">CANCEL</button>
    </div>
    <p class="prod-hint" data-add-hint>${!p.imageUrl ? 'Add an image to save this product.' : !p.name.trim() ? 'Give the product a name.' : ''}</p>` : `
    <button class="btn" id="prod-research">RESEARCH ALTERNATIVES</button>
    <div class="prod-actions">
      <button class="btn primary" id="prod-done" style="flex:1">${icon('check')}DONE</button>
      <button class="btn danger" id="prod-del">${icon('trash')}DELETE</button>
    </div>`}`;

  // A new product redraws only its form: it is not in the list yet.
  const changed = () => { if (isNew) renderForm(); else { touch(); render(); } };
  form.querySelectorAll('[data-f]').forEach(inp => inp.onchange = () => { p[inp.dataset.f] = inp.value; changed(); });
  if (isNew) form.querySelector('[data-f=name]').oninput = e => {
    p.name = e.target.value;
    form.querySelector('#prod-add').disabled = !(p.imageUrl && p.name.trim());
    form.querySelector('[data-add-hint]').textContent = !p.imageUrl ? 'Add an image to save this product.' : !p.name.trim() ? 'Give the product a name.' : '';
  };
  bindImage(form, p, changed);
  bindCombobox(form, 'prod-category', { options: availableCategories(), allowNew: true, onPick: v => { p.category = v || 'other'; changed(); } });
  form.querySelector('[data-money=price]').onchange = e => {
    const price = parseMoney(e.target.value);
    if (price !== p.price) { recordPrice(p, { price, source: p.priceSourceUrl || '', how: 'entered by hand' }); }
    changed();
  };
  form.querySelector('[data-price-source]').onchange = e => {
    const url = e.target.value.trim();
    if (url && !safeResearchUrl(url)) { e.target.value = p.priceSourceUrl || ''; message = 'Price source links must start with http:// or https://.'; renderForm(); return; }
    p.priceSourceUrl = safeResearchUrl(url); p.priceCheckedAt = new Date().toISOString(); message = '';
    changed();
  };
  form.querySelectorAll('[data-link]').forEach(inp => inp.onchange = () => {
    const values = {};
    for (const i of form.querySelectorAll('[data-link]')) values[i.dataset.link] = i.value.trim();
    // Once edited, both links are kept as typed (productLinks stops guessing).
    p.url = values.vendor; p.manufacturerUrl = values.maker;
    changed();
  });
  form.querySelectorAll('[data-items] input').forEach(box => box.onchange = () => {
    p.itemIds = [...form.querySelectorAll('[data-items] input:checked')].map(b => b.value);
    if (!isNew) touch();
  });
  form.querySelector('#prod-close').onclick = () => { editingId = null; draft = null; message = ''; render(); };
  if (isNew) {
    form.querySelector('#prod-add').onclick = () => {
      if (!p.imageUrl || !p.name.trim()) return;
      const prop = activeProperty();
      if (prop) p.propertyIds = [prop.id];
      if (p.price) recordPrice(p, { price: p.price, source: p.priceSourceUrl || '', how: 'entered by hand' });
      ws.data.products.unshift(p);
      editingId = p.id; draft = null; message = '';
      touch(); render();
    };
    form.querySelector('#prod-cancel').onclick = () => { draft = null; render(); };
    return;
  }
  form.querySelector('#prod-research').onclick = () => researchProduct(p);
  form.querySelector('#prod-refresh-price')?.addEventListener('click', () => refreshPrice(p));
  form.querySelectorAll('[data-open-doc]').forEach(b => b.onclick = () => openInFolder(home, docs[Number(b.dataset.openDoc)].path));
  form.querySelectorAll('[data-open-path]').forEach(b => b.onclick = () => openInFolder(home, b.dataset.openPath));
  form.querySelector('#prod-done').onclick = () => { editingId = null; message = ''; render(); };
  form.querySelector('#prod-del').onclick = () => {
    if (!confirm('Delete product "' + p.name + '"?')) return;
    ws.data.products = ws.data.products.filter(x => x.id !== p.id);
    editingId = null;
    touch(); render();
  };
}

async function openInFolder(prop, path) {
  try {
    const opened = await diskWorkspace.openProjectPath(prop, path || '');
    message = 'Opened ' + (opened.path && opened.path !== '.' ? opened.path : opened.folder) + ' on this Mac.';
  } catch (e) { message = e.message || 'Could not open the project folder.'; }
  if (el) renderForm();
}

// ---------- price checks ----------

// Every price change keeps where it came from and when, so the editor can say both.
function recordPrice(p, { price, unit, source, checkedAt, how }) {
  const at = checkedAt || new Date().toISOString();
  p.price = price;
  if (unit) p.unit = unit;
  p.priceSourceUrl = source;
  p.priceCheckedAt = at;
  p.priceHistory = [...(p.priceHistory || []), { price, unit: p.unit, sourceUrl: source, checkedAt: at, how }].slice(-20);
}

async function refreshPrice(p) {
  const { vendor, maker } = productLinks(p);
  const known = p.priceSourceUrl || vendor || maker;
  const body = {
    query: `Current price of the ${[p.brand, p.model].filter(Boolean).join(' ') || p.name} (${p.name}).${known ? ' Check this page first: ' + known : ''} Report only this exact model.`.slice(0, 2000),
    mode: 'focused',
    context: { name: [p.name, p.brand, p.model].filter(Boolean).join(' ').slice(0, 1000), category: String(p.category || '').slice(0, 1000) },
    constraints: { specifications: (p.model ? 'Exact model ' + p.model + '. ' : '') + 'Price in USD with its unit (' + (p.unit || 'ea') + ').' },
  };
  const id = p.id, startedAt = new Date().toISOString();
  p.priceCheck = { status: 'running', startedAt };
  render();
  let check;
  try {
    const result = await researchApi('', { method: 'POST', body: JSON.stringify(body) });
    const job = result.job || result;
    if (!job.id) throw new Error('The research server did not start a price check.');
    check = { status: 'running', startedAt, jobId: job.id };
  } catch (e) {
    check = { status: 'failed', at: new Date().toISOString(), message: 'Price not checked: ' + (e.message || 'research is unavailable') + ' The price was not changed.' };
  }
  // The workspace may have been swapped while waiting; write to the current record.
  const current = byId(id);
  if (current) { current.priceCheck = check; touch(); }
  pollPriceChecks();
  render();
}

// The research job outlives this view; any running check is picked up again on mount.
function pollPriceChecks() {
  clearTimeout(pollTimer);
  const running = ws.data.products.filter(p => p.priceCheck?.status === 'running' && p.priceCheck.jobId).map(p => [p.id, p.priceCheck.jobId]);
  if (!running.length) return;
  pollTimer = setTimeout(async () => {
    for (const [id, jobId] of running) {
      let job = null, lost = false;
      try { const result = await researchApi('/' + encodeURIComponent(jobId)); job = result.job || result; }
      catch (e) { lost = /not found/i.test(e.message || ''); }
      const p = byId(id);
      if (!p || p.priceCheck?.jobId !== jobId) continue;
      if (job && TERMINAL.has(job.status)) { applyPriceCheck(p, job); touch(); }
      else if (lost) { p.priceCheck = { status: 'failed', at: new Date().toISOString(), message: 'The price check was lost when the server restarted. The price was not changed.' }; touch(); }
    }
    if (el) render();
    pollPriceChecks();
  }, 4000);
}

// Use only a verified USD price for this exact model; anything else leaves the price alone.
export function applyPriceCheck(p, job) {
  const at = new Date().toISOString();
  const candidates = Array.isArray(job.products) ? job.products : [];
  const model = squash(p.model);
  const same = candidates.filter(c => model ? squash(c.model) === model || squash(c.name).includes(model) : true);
  const priced = same.find(c => c.priceStatus === 'verified' && c.currency === 'USD' && Number.isFinite(c.price) && c.price > 0 && c.unit);
  if (job.status === 'failed' || job.status === 'cancelled') {
    p.priceCheck = { status: 'failed', at, jobId: job.id, message: 'The price check ' + job.status + (job.error ? ': ' + (typeof job.error === 'string' ? job.error : job.error.message || '') : '') + '. The price was not changed.' };
    return false;
  }
  if (!priced) {
    p.priceCheck = { status: 'unchanged', at, jobId: job.id, message: same.length ? 'No verified USD price was found for this exact model. The price was not changed.' : 'The search did not find this exact model. The price was not changed.' };
    return false;
  }
  const source = safeResearchUrl(priced.priceSourceUrl || priced.url);
  const offer = (priced.offers || []).find(o => o.url === priced.priceSourceUrl);
  const before = p.price;
  recordPrice(p, { price: priced.price, unit: priced.unit, source, checkedAt: offer?.checkedAt || at, how: 'refreshed by research' });
  p.priceCheck = { status: 'updated', at, jobId: job.id, message: before === priced.price ? `Price confirmed at ${fmtMoney(priced.price)} on ${host(source) || 'the source page'}.` : `Price changed from ${before ? fmtMoney(before) : 'none'} to ${fmtMoney(priced.price)} (${host(source) || 'source page'}).` };
  return true;
}

function provenance(research) {
  const evidence = research.candidate?.sourceEvidence || [];
  return `<details class="prod-provenance"><summary>Research evidence and original pricing</summary>
    <p>Saved ${escapeHtml(research.savedAt || '')}</p>
    <p>${escapeHtml(research.request?.query || '')}</p>
    <p>Original source price: ${escapeHtml(String(research.candidate?.price ?? 'unverified'))} ${escapeHtml(research.candidate?.currency || '')} / ${escapeHtml(research.candidate?.unit || 'unit unverified')}. ${escapeHtml(research.candidate?.priceStatus || 'unverified')}</p>
    ${safeResearchUrl(research.candidate?.priceSourceUrl) ? `<p><a href="${escapeHtml(safeResearchUrl(research.candidate.priceSourceUrl))}" target="_blank" rel="noopener noreferrer">PRICE SOURCE</a></p>` : ''}
    ${evidence.map(source => { const url = safeResearchUrl(source.url); return `<p>${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.title || url)}</a>` : escapeHtml(source.title || 'Source URL unavailable')} <span class="chip">${source.sourceStatus === 'opened' ? 'Opened source' : source.sourceStatus === 'search-result' ? 'Search result only' : 'Source opening unverified'}</span><br>${escapeHtml(source.relevance || '')}<br>${escapeHtml(source.checkedAt || '')}</p>`; }).join('')}
  </details>`;
}
