// DOCUMENTS > BID PACKAGE: the documents written from a project's estimate (bid-documents.js),
// shown as pages, printed as text PDFs (the browser's Save as PDF), and the estimate's deep dive
// saved as one file to share. On the left the project and its documents; in the middle the
// document as it prints; on the right what it says that is not in the estimate: the business
// that sends it, the client, payment terms and the bid form's options.

import { ws, touch, onChange, activeProperty, propertyProjects, projectById, escapeHtml, fmtMoney, fmtLen, isoToday, readMoney } from './store.js';
import { projectEstimate, rootOf } from './estimate.js';
import { DOCS, documentHtml, termsOf, TERMS_DEFAULTS } from './bid-documents.js';
import { printSheet } from './print-sheet.js';
import { icon } from './icons.js';

let el = null, off = null, timer = null;
let projectId = '', docId = 'proposal';

function chosen() {
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  const fromHash = q.get('bid');
  const tops = propertyProjects().filter(p => !p.parentId);
  if (fromHash && projectById(fromHash)) projectId = rootOf(projectById(fromHash)).id;
  if (!tops.some(p => p.id === projectId)) projectId = (tops.find(p => p.selected) || tops[0] || {}).id || '';
  const d = q.get('doc');
  if (d && DOCS.some(x => x.id === d)) docId = d;
  return projectById(projectId);
}

export function mount(root) {
  el = root;
  // A change elsewhere redraws the page; while a field on the right has the cursor, only the
  // document is redrawn so the typing is not interrupted.
  off = onChange(() => { clearTimeout(timer); timer = setTimeout(() => { if (!el) return; if (el.querySelector('.bp-side :focus')) paper(); else render(); }, 200); });
  render();
}
export function unmount() { clearTimeout(timer); if (off) off(); off = null; el = null; }

function ctxFor(root) {
  const prop = activeProperty();
  const est = projectEstimate(root);
  const bf = root.bidForm || {};
  return { est, prop, len: m => fmtLen(m), money: v => fmtMoney(v), date: isoToday(), propertyName: prop ? prop.name : '', address: prop ? prop.address || '' : '',
    live: false, business: ws.data.settings.business || {}, terms: termsOf(root), clientName: (root.client || {}).name || '',
    startDate: root.startDate || ws.data.settings.programStart || '', showOurHours: !!bf.showOurHours, bidDue: bf.due || '', materialsBy: bf.materialsBy || '' };
}

// The document alone, written again.
function paper() {
  const root = chosen(), box = el && el.querySelector('#bp-paper');
  if (!root || !box) return;
  try { box.innerHTML = documentHtml(docId, ctxFor(root)); } catch (e) { console.error(e); }
}

function render() {
  if (!el) return;
  const root = chosen();
  const tops = propertyProjects().filter(p => !p.parentId);
  if (!root) { el.innerHTML = '<div class="empty-state"><b>No projects</b>Make a project in PROJECTS; its estimate writes these documents.</div>'; return; }
  const ctx = ctxFor(root);
  let html = '';
  try { html = documentHtml(docId, ctx); } catch (e) { console.error(e); html = `<p class="note" role="alert">This document could not be written (${escapeHtml(e.message)}).</p>`; }
  const T = ctx.terms, B = ctx.business, bf = root.bidForm || {};
  const field = (scope, key, label, value, type = 'text', extra = '') => `<label class="bp-f"><span>${escapeHtml(label)}</span>${type === 'textarea'
    ? `<textarea data-${scope}="${key}" rows="3">${escapeHtml(value || '')}</textarea>`
    : `<input type="${type}" data-${scope}="${key}" value="${escapeHtml(value == null ? '' : value)}" ${extra}>`}</label>`;
  const pctIn = (key, label) => field('term', key, label, Math.round((T[key] || 0) * 1000) / 10, 'number', 'min="0" max="100" step="5" inputmode="decimal"');
  el.innerHTML = `<div class="bp">
    <nav class="bp-list" aria-label="Bid package">
      <label class="bp-f"><span>Project</span><select id="bp-project">${tops.map(p => `<option value="${escapeHtml(p.id)}" ${p.id === root.id ? 'selected' : ''}>${escapeHtml(p.name || 'Project')}</option>`).join('')}</select></label>
      <div class="bp-total">${fmtMoney(ctx.est.total.likely)} <span>${ctx.est.days ? ctx.est.days + ' working days' : ''}</span></div>
      <div class="gl">Documents</div>
      ${DOCS.map(d => `<button type="button" class="bp-doc ${d.id === docId ? 'here' : ''}" data-doc="${d.id}"><b>${escapeHtml(d.title)}</b><span>${escapeHtml(d.who)}</span></button>`).join('')}
      <div class="gl">To share</div>
      <button type="button" class="bp-doc" data-deep><b>Estimate deep dive</b><span>One file: contents, reading column and details, for anyone to open</span></button>
      <a class="bp-doc" href="#/estimate?project=${encodeURIComponent(root.id)}"><b>Open the estimate</b><span>ESTIMATE: change rates, markups and bids</span></a>
    </nav>
    <main class="bp-stage"><div class="bp-bar"><b>${escapeHtml(DOCS.find(d => d.id === docId).title)}</b><span class="note">${escapeHtml(DOCS.find(d => d.id === docId).what)}</span><span class="sp"></span>
      <button class="btn small" data-download>${icon('export')}DOWNLOAD</button><button class="btn primary small" data-print>${icon('print')}PRINT OR SAVE PDF</button></div>
      <div class="bp-paper" id="bp-paper">${html}</div></main>
    <aside class="bp-side" aria-label="What the documents say">
      <div class="gl">The business sending it</div>
      ${field('biz', 'name', 'Name', B.name)}${field('biz', 'address', 'Address', B.address)}${field('biz', 'phone', 'Phone', B.phone)}${field('biz', 'email', 'Email', B.email, 'email')}${field('biz', 'license', 'License number', B.license)}
      <div class="gl">The client</div>
      ${field('client', 'name', 'Client name', (root.client || {}).name)}
      <div class="gl">Terms</div>
      ${field('term', 'startDate', 'Start date', T.startDate || '', 'date')}
      <div class="bp-row">${pctIn('deposit', 'Deposit %')}${pctIn('progress', 'Midway %')}${pctIn('final', 'Final %')}</div>
      <div class="bp-row">${field('term', 'validDays', 'Valid, days', T.validDays, 'number', 'min="1" step="1"')}${field('term', 'warrantyMonths', 'Warranty, months', T.warrantyMonths, 'number', 'min="0" step="1"')}</div>
      ${field('term', 'includes', 'Included', T.includes, 'textarea')}${field('term', 'excludes', 'Not included', T.excludes, 'textarea')}
      ${field('term', 'assumptions', 'Assumptions', T.assumptions, 'textarea')}${field('term', 'changes', 'Changes', T.changes, 'textarea')}
      <div class="gl">Installer bid form</div>
      <label class="bp-check"><input type="checkbox" data-bf="showOurHours" ${bf.showOurHours ? 'checked' : ''}> Show our hours beside theirs</label>
      ${field('bf', 'due', 'Return by', bf.due || '', 'date')}${field('bf', 'materialsBy', 'Materials', bf.materialsBy || '', 'text', 'placeholder="supplied by us"')}
      <p class="note">Saved with the project; the business details are shared by every project.</p>
    </aside></div>`;

  el.querySelector('#bp-project').onchange = e => { projectId = e.target.value; history.replaceState(null, '', '#/documents?bid=' + encodeURIComponent(projectId)); render(); };
  el.querySelectorAll('[data-doc]').forEach(b => b.onclick = () => { docId = b.dataset.doc; history.replaceState(null, '', '#/documents?bid=' + encodeURIComponent(root.id) + '&doc=' + docId); render(); });
  el.querySelector('[data-print]').onclick = () => printSheet(`<div class="bd-print">${documentHtml(docId, ctxFor(root))}</div>`);
  el.querySelector('[data-download]').onclick = () => download(root, docId);
  el.querySelector('[data-deep]').onclick = async () => {
    try { const { saveEstimateDeepDive } = await import('./estimate-export.js'); await saveEstimateDeepDive(root); }
    catch (e) { console.error(e); alert('The deep dive could not be saved: ' + (e && e.message || e)); }
  };
  const save = () => { touch(); paper(); };
  el.querySelectorAll('[data-biz]').forEach(i => i.onchange = () => { ws.data.settings.business = { ...(ws.data.settings.business || {}), [i.dataset.biz]: i.value.trim() }; save(); });
  el.querySelectorAll('[data-client]').forEach(i => i.onchange = () => { root.client = { ...(root.client || {}), [i.dataset.client]: i.value.trim() }; save(); });
  el.querySelectorAll('[data-term]').forEach(i => i.onchange = () => {
    const k = i.dataset.term; let v = i.value;
    if (['deposit', 'progress', 'final'].includes(k)) { v = Number(v); if (!Number.isFinite(v) || v < 0 || v > 100) { i.setCustomValidity('0 to 100'); i.reportValidity(); return; } v = v / 100; }
    else if (['validDays', 'warrantyMonths'].includes(k)) { v = Math.max(0, Math.round(Number(v) || 0)); }
    const next = { ...(root.terms || {}) };
    if (v === '' || v === TERMS_DEFAULTS[k]) delete next[k]; else next[k] = v;
    if (Object.keys(next).length) root.terms = next; else delete root.terms;
    save();
  });
  el.querySelectorAll('[data-bf]').forEach(i => i.onchange = () => {
    const next = { ...(root.bidForm || {}), [i.dataset.bf]: i.type === 'checkbox' ? i.checked : i.value };
    root.bidForm = next; save();
  });
}

function download(root, id) {
  const html = documentHtml(id, ctxFor(root));
  const title = (DOCS.find(d => d.id === id) || {}).title || id;
  const css = [...document.styleSheets].filter(s => /bid-docs|trim-drawings/.test(s.href || '')).flatMap(s => { try { return [...s.cssRules].map(r => r.cssText); } catch { return []; } }).join('\n');
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(root.name)} - ${escapeHtml(title)}</title><style>${css}\nbody{margin:0;background:#e9e9e9}</style></head><body class="bd-file">${html}</body></html>`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([page], { type: 'text/html' }));
  a.download = `${root.name || 'Project'} - ${title}.html`.replace(/[\\/:*?"<>|]+/g, ' ');
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

export const _test = { chosen };
export { readMoney };
