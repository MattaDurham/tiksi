// Contextual sourcing. Research stays on the local server; saved selections travel
// with the workspace, including the evidence used to choose them.
import { ws, uid, touch, escapeHtml, allScopeItems } from './store.js';

const API = '/api/material-research';
const SESSION = 'tiksi.research.session.v1';
const TERMINAL = new Set(['completed', 'partial', 'failed', 'cancelled']);
const text = (value, length = 2000) => typeof value === 'string' ? value.slice(0, length) : '';
const esc = value => escapeHtml(String(value ?? ''));
const array = value => Array.isArray(value) ? value : [];
let root = null, timer = null, pollBusy = false, generation = 0;
let capabilities = null, error = '', notice = '', job = null, jobContext = {}, jobItemIds = [];
let context = {}, selected = new Set(), saved = new Set();
let draft = { query: '', budget: '', region: '', finish: '', dimensions: '', specifications: '', mode: 'team', itemIds: [] };

export function safeResearchUrl(value) {
  try { const u = new URL(value); return ['https:', 'http:'].includes(u.protocol) ? u.href : ''; }
  catch { return ''; }
}

function cleanContext(value = {}) {
  const out = {};
  for (const key of ['kind', 'id', 'name', 'materialId', 'propertyId', 'elementId', 'elementKind', 'category', 'material', 'finish', 'dimensions', 'specifications']) out[key] = text(value[key]);
  out.itemIds = array(value.itemIds).filter(x => typeof x === 'string');
  return out;
}

export function openResearch(value = {}) {
  context = cleanContext(value);
  const same = context.id && context.id === jobContext.id && context.kind === jobContext.kind;
  draft = { ...draft, query: context.name || '', finish: context.finish || '', dimensions: context.dimensions || '', specifications: context.specifications || '', itemIds: context.itemIds };
  if (context.elementId) {
    for (const { project, item } of allScopeItems()) {
      if ((!context.propertyId || project.propertyId === context.propertyId) && array(item.elementIds).includes(context.elementId)) draft.itemIds.push(item.id);
    }
    draft.itemIds = [...new Set(draft.itemIds)];
  }
  notice = same ? 'Showing the existing research for this selection. Edit the brief to run another search.' : '';
  persist();
  if (location.hash === '#/research') render(); else location.hash = '#/research';
}

function persist() {
  try { sessionStorage.setItem(SESSION, JSON.stringify({ draft, context, jobId: job?.id, jobContext, jobItemIds })); } catch { /* Navigation still works if storage is full. */ }
}

function restore() {
  if (job || draft.query || Object.keys(context).length) return;
  try {
    const rec = JSON.parse(sessionStorage.getItem(SESSION) || 'null');
    if (!rec) return;
    context = cleanContext(rec.context);
    jobContext = cleanContext(rec.jobContext);
    jobItemIds = array(rec.jobItemIds).filter(x => typeof x === 'string');
    for (const key of Object.keys(draft)) if (key !== 'itemIds') draft[key] = text(rec.draft?.[key]);
    draft.itemIds = array(rec.draft?.itemIds).filter(x => typeof x === 'string');
    if (text(rec.jobId)) job = { id: rec.jobId, status: 'running', agents: [], products: [] };
  } catch { /* A corrupt UI draft never affects the workspace. */ }
}

export function mount(el) {
  root = el; generation++; restore(); render();
  checkCapabilities();
}

export function unmount() {
  persist(); root = null; generation++; clearTimeout(timer); timer = null;
  // The job runs independently of this view. Returning resumes status polling.
}

async function request(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(API + path, { ...options, signal: controller.signal, headers: { 'Content-Type': 'application/json', ...(path !== '/capabilities' && capabilities?.token ? { 'X-Tiksi-Token': capabilities.token } : {}), ...options.headers } });
    if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('Live research needs the Tiksi local server. Open your local or Tailscale Tiksi address.');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || data.error || data.detail || `Research request failed (${response.status}).`);
    return data;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('The research server did not respond. Your job may still be running; refresh its status before starting again.');
    throw e;
  } finally { clearTimeout(timeout); }
}

async function checkCapabilities() {
  const seq = generation;
  try { const data = await request('/capabilities'); if (seq !== generation) return; capabilities = data; }
  catch (e) { if (seq !== generation) return; capabilities = { available: false, reason: e.message }; }
  if (!root) return;
  // Do not replace the form while the user is typing.
  renderAvailability();
  // Restored private jobs require the token from this server before status reads.
  if (capabilities?.token && job && !TERMINAL.has(job.status)) schedulePoll(0);
}

function renderAvailability() {
  if (!root) return;
  const host = root.querySelector('[data-availability]');
  if (host) host.textContent = capabilities?.available
    ? 'Live web research is ready. Only the brief and visible constraints are sent to research agents.'
    : capabilities ? capabilities.reason || 'Live research is unavailable on this server.' : 'Checking live research availability...';
  const start = root.querySelector('[data-start]');
  if (start) start.disabled = !capabilities?.available || (job && !TERMINAL.has(job.status));
}

function captureDraft() {
  if (!root) return;
  root.querySelectorAll('[data-brief]').forEach(input => { draft[input.dataset.brief] = input.value; });
  draft.itemIds = [...root.querySelector('[data-scope]').selectedOptions].map(o => o.value);
  persist();
}

async function start() {
  captureDraft();
  if (!draft.query.trim()) { error = 'Describe the material, fixture or product you want to find.'; render(); return; }
  error = ''; notice = ''; selected.clear(); saved.clear();
  const submittedContext = cleanContext(context), submittedItems = [...draft.itemIds];
  const body = { query: draft.query.trim(), mode: draft.mode, context: {}, constraints: {} };
  for (const key of ['name', 'category', 'material', 'finish', 'dimensions']) body.context[key] = text(context[key]);
  for (const key of ['budget', 'region', 'finish', 'dimensions', 'specifications']) body.constraints[key] = text(draft[key]);
  root.querySelector('[data-start]').disabled = true;
  try {
    const result = await request('', { method: 'POST', body: JSON.stringify(body) });
    const next = result.job || result;
    if (!next.id || !next.status) throw new Error('The server did not return a research job.');
    job = next; jobContext = submittedContext; jobItemIds = submittedItems; persist();
    render(); if (!TERMINAL.has(job.status)) schedulePoll(0);
  } catch (e) { error = e.message; render(); }
}

function schedulePoll(delay = 1800) {
  clearTimeout(timer);
  if (root) timer = setTimeout(poll, delay);
}

async function poll() {
  if (!job || pollBusy) { if (root && job) schedulePoll(); return; }
  pollBusy = true;
  const id = job.id;
  try {
    const result = await request('/' + encodeURIComponent(id));
    if (job?.id !== id) return;
    job = result.job || result; error = ''; persist();
    renderResults(); renderAvailability();
  } catch (e) { error = e.message; renderResults(); }
  finally {
    pollBusy = false;
    if (root && job && !TERMINAL.has(job.status)) schedulePoll(error ? 5000 : 1800);
  }
}

async function cancel() {
  if (!job) return;
  const id = job.id;
  try {
    const result = await request('/' + encodeURIComponent(id) + '/cancel', { method: 'POST', body: '{}' });
    if (job?.id === id) job = result.job || result;
    error = ''; persist(); renderResults(); renderAvailability();
  } catch (e) { error = e.message; renderResults(); }
}

const field = (label, key, placeholder = '') => `<div class="field"><label for="research-${key}">${label}</label><input type="text" id="research-${key}" data-brief="${key}" value="${esc(draft[key])}" placeholder="${esc(placeholder)}" maxlength="2000"></div>`;

function render() {
  if (!root) return;
  const items = allScopeItems();
  root.innerHTML = `<div class="view-scroll research-view">
    <div class="view-head"><span class="view-title">MATERIAL & FIXTURE RESEARCH</span><span class="view-sub">Find products, compare evidence and save selections to your digital twin.</span></div>
    <div class="research-layout"><form class="card research-brief">
      <h3 class="kicker">${context.name ? 'RESEARCH THIS SELECTION' : 'RESEARCH BRIEF'}</h3>
      ${context.name ? `<div class="research-context">${esc(context.name)}<span class="faint">${esc(context.elementKind || context.kind)}</span></div>` : ''}
      <div class="field"><label for="research-query">What are you looking for?</label><textarea id="research-query" data-brief="query" maxlength="2000" required placeholder="Describe a material, fixture or product, or ask for alternatives">${esc(draft.query)}</textarea></div>
      ${field('Budget and price unit', 'budget', 'e.g. up to $12 per sq ft')}
      ${field('Region / delivery area', 'region', 'Where should it be available?')}
      ${field('Finish / color / texture', 'finish')}
      ${field('Dimensions / fit', 'dimensions')}
      <div class="field"><label for="research-specifications">Required specifications</label><textarea id="research-specifications" data-brief="specifications" maxlength="2000" placeholder="Performance, installation, certifications or compatibility">${esc(draft.specifications)}</textarea></div>
      <div class="field"><label for="research-mode">Research depth</label><select id="research-mode" data-brief="mode"><option value="focused" ${draft.mode === 'focused' ? 'selected' : ''}>Focused agent</option><option value="team" ${draft.mode === 'team' ? 'selected' : ''}>Deep specialist team</option></select></div>
      <p class="research-hint">Focused research finds candidates and sources. A team investigates fit, suppliers and pricing, sustainability and reviews, then reconciles findings.</p>
      <div class="field"><label for="research-scope">Link saved selections to scope items</label><select id="research-scope" data-scope multiple size="${Math.min(6, Math.max(2, items.length))}">${items.map(({ project, item }) => `<option value="${esc(item.id)}" ${draft.itemIds.includes(item.id) ? 'selected' : ''}>${esc(project.name)} / ${esc(item.name)}</option>`).join('')}</select></div>
      ${context.materialId ? '<p class="research-hint">Saved products also link to the selected material.</p>' : ''}
      <p class="research-hint" data-availability role="status"></p>
      <button class="btn primary" data-start type="submit">START RESEARCH</button>
    </form><section class="research-results" aria-label="Research progress and results" data-results></section></div>
  </div>`;
  root.querySelector('form').onsubmit = e => { e.preventDefault(); start(); };
  root.querySelectorAll('[data-brief], [data-scope]').forEach(input => input.addEventListener('input', captureDraft));
  renderAvailability(); renderResults();
}

function externalLink(url, title) {
  const safe = safeResearchUrl(url);
  return safe ? `<a href="${esc(safe)}" target="_blank" rel="noopener noreferrer">${esc(title || new URL(safe).hostname)}</a>` : `<span>${esc(title || 'Source URL unavailable')}</span>`;
}

function list(values, cls = '') {
  return array(values).length ? `<ul class="${cls}">${values.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '';
}

function money(product) {
  if (typeof product.price !== 'number' || !Number.isFinite(product.price)) return 'Price not verified';
  let display;
  try { display = product.currency ? new Intl.NumberFormat(undefined, { style: 'currency', currency: product.currency }).format(product.price) : `${product.price} (currency unverified)`; }
  catch { display = `${product.price} ${product.currency || ''}`; }
  return display + (product.unit ? ' / ' + product.unit : ' / unit unverified') + (product.priceStatus === 'verified' ? ' (source verified)' : ' (unverified)');
}

function renderResults() {
  if (!root) return;
  const host = root.querySelector('[data-results]');
  const products = array(job?.products);
  host.innerHTML = `${error ? `<div class="research-message error" role="alert">${esc(error)}<button class="btn" data-refresh>REFRESH STATUS</button></div>` : ''}
    ${notice ? `<div class="research-message" role="status">${esc(notice)}</div>` : ''}
    ${job ? `<div class="card research-progress"><div class="research-row"><h3 class="kicker">${esc(job.status).toUpperCase()}</h3>${!TERMINAL.has(job.status) ? '<button class="btn" data-cancel>CANCEL RESEARCH</button>' : ''}</div>
      <p>${esc(job.request?.query || '')}</p><p class="research-hint">${!TERMINAL.has(job.status) ? 'You can keep browsing Tiksi while research runs. Return here for results.' : products.length + ' candidates with source evidence.'}</p>
      <div class="research-agents">${array(job.agents).map(a => `<div><strong>${esc(a.role)}</strong><span>${esc(a.status)}${a.webSearches ? ' / ' + esc(a.webSearches) + ' searches' : ''}</span>${a.error ? `<small>${esc(a.error)}</small>` : ''}</div>`).join('')}</div>
      ${job.error ? `<p class="research-error">${esc(typeof job.error === 'string' ? job.error : job.error.message)}</p>` : ''}
      ${array(job.unknowns).length ? '<h4>Open questions</h4>' + list(job.unknowns) : ''}${array(job.conflicts).length ? '<h4>Conflicting evidence</h4>' + list(job.conflicts) : ''}
    </div>` : '<div class="empty-state"><b>Research real products for your space</b>Choose a material or fixture, set your constraints and send an agent or specialist team to search the web. Results include links, specifications and unresolved questions.</div>'}
    ${products.length ? `<div class="research-row"><h3 class="kicker">CANDIDATES</h3><button class="btn" data-compare ${selected.size < 2 ? 'disabled' : ''}>COMPARE SELECTED (${selected.size})</button></div><div data-comparison></div><div class="research-candidates">${products.map((p, i) => productCard(p, i)).join('')}</div>` : ''}`;
  host.querySelector('[data-refresh]')?.addEventListener('click', () => { if (job) poll(); else checkCapabilities(); });
  host.querySelector('[data-cancel]')?.addEventListener('click', cancel);
  host.querySelectorAll('[data-pick]').forEach(input => input.onchange = () => {
    const i = Number(input.dataset.pick); if (input.checked) selected.add(i); else selected.delete(i);
    const b = host.querySelector('[data-compare]'); b.disabled = selected.size < 2; b.textContent = `COMPARE SELECTED (${selected.size})`;
  });
  host.querySelector('[data-compare]')?.addEventListener('click', compare);
  host.querySelectorAll('[data-save-candidate]').forEach(b => b.onclick = () => saveCandidate(Number(b.dataset.saveCandidate)));
}

function productCard(p, i) {
  const evidence = array(p.sourceEvidence);
  if (ws.data.products.some(product => product.research?.jobId === job?.id && product.research?.candidateId === (p.id || String(i)))) saved.add(i);
  const unitWarnings = scopeUnitWarnings(p, jobItemIds);
  return `<article class="card research-candidate"><div class="research-row"><h3>${esc(p.name || 'Unnamed candidate')}</h3><label class="research-pick"><input type="checkbox" data-pick="${i}" ${selected.has(i) ? 'checked' : ''}> Compare</label></div>
    <p class="faint">${esc([p.brand, p.model, p.category].filter(Boolean).join(' / '))}</p>
    <div class="research-row"><strong>${esc(money(p))}</strong>${externalLink(p.url, 'PRODUCT PAGE')}</div>
    ${p.availability ? `<p>${esc(p.availability)}</p>` : ''}${list(p.fitNotes)}
    ${array(p.specifications).length ? `<dl class="research-specs">${p.specifications.map(s => `<dt>${esc(s.name)}</dt><dd>${esc(s.value)} ${s.sourceUrl ? externalLink(s.sourceUrl, 'source') : ''}</dd>`).join('')}</dl>` : ''}
    ${array(p.offers).length ? `<details><summary>Suppliers and offers (${p.offers.length})</summary>${p.offers.map(o => `<p>${externalLink(o.url, o.vendor)} / ${esc(money(o))} / ${esc(o.availability)}</p>`).join('')}</details>` : ''}
    ${array(p.sustainability).length ? `<details><summary>Sustainability evidence</summary>${p.sustainability.map(s => `<p>${esc(s.name)}: ${esc(s.value)} ${externalLink(s.sourceUrl, 'source')}</p>`).join('')}</details>` : ''}
    ${array(p.reviews).length ? `<details><summary>Reviews and limitations</summary>${p.reviews.map(r => `<p>${esc(r.summary)} ${externalLink(r.sourceUrl, 'source')}</p>`).join('')}</details>` : ''}
    ${array(p.unknowns).length || unitWarnings.length ? '<h4>Unverified / needs checking</h4>' + list([...array(p.unknowns), ...unitWarnings], 'research-unknowns') : ''}
    <details><summary>Source evidence (${evidence.length})</summary>${evidence.map(s => `<p>${externalLink(s.url, s.title)} <span class="chip">${s.sourceStatus === 'opened' ? 'Opened source' : s.sourceStatus === 'search-result' ? 'Search result only' : 'Source opening unverified'}</span><br>${esc(s.relevance)}${s.checkedAt ? `<br><small>Checked ${esc(s.checkedAt)}</small>` : ''}</p>`).join('')}</details>
    <button class="btn primary" data-save-candidate="${i}" ${saved.has(i) ? 'disabled' : ''}>${saved.has(i) ? 'SAVED TO PRODUCTS' : 'SAVE TO PRODUCTS'}</button>
  </article>`;
}

function compare() {
  const candidates = [...selected].map(i => array(job?.products)[i]).filter(Boolean);
  const keys = [...new Set(candidates.flatMap(p => array(p.specifications).map(s => s.name)))];
  const rows = [['Price', p => money(p)], ['Availability', p => p.availability || 'Not verified'], ...keys.map(key => [key, p => array(p.specifications).find(s => s.name === key)?.value || 'Not verified']), ['Needs checking', p => array(p.unknowns).join('; ') || 'None reported']];
  root.querySelector('[data-comparison]').innerHTML = `<div class="research-comparison" tabindex="0" aria-label="Candidate comparison, scroll horizontally"><table><thead><tr><th>Compare</th>${candidates.map(p => `<th>${esc(p.name)}</th>`).join('')}</tr></thead><tbody>${rows.map(([name, fn]) => `<tr><th>${esc(name)}</th>${candidates.map(p => `<td>${esc(fn(p))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function saveCandidate(i) {
  const candidate = array(job?.products)[i];
  if (!candidate || saved.has(i)) return;
  captureDraft();
  // Apply the current scope selection only when the brief still belongs to this job.
  const sameContext = context.id === jobContext.id && context.kind === jobContext.kind;
  const itemIds = (sameContext ? draft.itemIds : jobItemIds).filter(id => allScopeItems().some(x => x.item.id === id));
  const materialIds = ws.data.materials.some(m => m.id === jobContext.materialId) ? [jobContext.materialId] : [];
  const existing = ws.data.products.find(p => p.research?.jobId === job.id && p.research?.candidateId === (candidate.id || String(i)));
  if (existing) { saved.add(i); notice = 'This candidate is already saved in Products.'; renderResults(); return; }
  const price = candidate.priceStatus === 'verified' && candidate.currency === 'USD' && candidate.unit && Number.isFinite(candidate.price) ? candidate.price : 0;
  const product = {
    id: uid('prod'), name: text(candidate.name) || 'Researched product', brand: text(candidate.brand), model: text(candidate.model), category: text(candidate.category) || 'other',
    url: safeResearchUrl(candidate.url), price, unit: text(candidate.unit) || 'ea', imageUrl: '', itemIds, materialIds,
    specs: array(candidate.specifications).map(s => `${text(s.name)}: ${text(s.value)}`).join('\n'),
    notes: [...array(candidate.fitNotes), ...array(candidate.unknowns).map(u => 'Needs checking: ' + u), ...scopeUnitWarnings(candidate, itemIds), ...(candidate.price !== null && !price ? ['Source price: ' + money(candidate) + '. Not entered into the USD estimate.'] : [])].join('\n'),
    research: { jobId: job.id, candidateId: candidate.id || String(i), savedAt: new Date().toISOString(), researchedAt: job.updatedAt || job.createdAt, context: { ...jobContext }, request: job.request, candidate: JSON.parse(JSON.stringify(candidate)) },
  };
  ws.data.products.unshift(product); touch(); saved.add(i);
  notice = `Saved ${product.name} to Products${itemIds.length ? ' and linked it to ' + itemIds.length + ' scope item(s)' : ''}${materialIds.length ? ' and the selected material' : ''}. Source evidence and original pricing are preserved.`;
  renderResults();
}

function scopeUnitWarnings(candidate, itemIds) {
  const canonical = unit => ({ 'sq ft': 'sf', sqft: 'sf', 'ft2': 'sf', 'ft²': 'sf', each: 'ea', 'linear ft': 'lf' })[text(unit).trim().toLowerCase()] || text(unit).trim().toLowerCase();
  const unit = canonical(candidate.unit);
  return allScopeItems().filter(({ item }) => itemIds.includes(item.id) && (!unit || canonical(item.unit) !== unit)).map(({ item }) =>
    `Price unit ${candidate.unit || 'unverified'} differs from ${item.name}'s scope unit ${item.unit || 'unverified'}. Confirm coverage and conversion before estimating.`);
}
