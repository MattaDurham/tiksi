// DOCUMENTS: every document a property's work needs, in three parts.
//   DRAWINGS AND FILES  drawing sets, sheets, the one-pager and saved files (documentcenter.js)
//   JOB DOCUMENTS       the trim package book and the client proposal, from the job (job-documents.js)
//   CUT SHEETS          printable specification sheets for scope items and products (cutsheets.js)
// Addresses: #/documents (drawings and files), #/documents?job[=<project id>], #/sheets and
// #/documents?sheets (cut sheets; #/sheets?item=<id> opens that item's sheet).

import { icon } from './icons.js';

const PARTS = [
  ['drawings', 'DRAWINGS AND FILES', 'file', () => import('./documentcenter.js')],
  ['job', 'JOB DOCUMENTS', 'print', () => import('./job-documents.js')],
  ['sheets', 'CUT SHEETS', 'sheets', () => import('./cutsheets.js')],
];
let el = null, child = null, token = 0;

function partOf(hash) {
  if (/^#\/sheets/.test(hash)) return 'sheets';
  const q = new URLSearchParams(hash.split('?')[1] || '');
  if (q.has('job')) return 'job';
  if (q.has('sheets') || q.has('item')) return 'sheets';
  return 'drawings';
}

export function mount(root) {
  el = root;
  el.innerHTML = `<div class="doc-hub"><nav class="doc-parts seg" role="tablist" aria-label="Documents">${PARTS.map(([id, label, ic]) =>
    `<button type="button" class="seg-btn" role="tab" data-part="${id}">${icon(ic)}<span>${label}</span></button>`).join('')}</nav><div class="doc-body" id="doc-body"></div></div>`;
  el.querySelectorAll('[data-part]').forEach(b => b.onclick = () => {
    const id = b.dataset.part;
    const hash = id === 'drawings' ? '#/documents' : id === 'sheets' ? '#/documents?sheets' : '#/documents?job';
    history.replaceState(null, '', hash);
    open(id);
  });
  open(partOf(location.hash));
}
export function unmount() {
  token++;
  if (child) { try { child.unmount(); } catch (e) { console.error(e); } }
  child = null; el = null;
}
function open(id) {
  if (!el) return;
  const own = ++token;
  if (child) { try { child.unmount(); } catch (e) { console.error(e); } child = null; }
  el.querySelectorAll('[data-part]').forEach(b => { const on = b.dataset.part === id; b.classList.toggle('active', on); b.setAttribute('aria-selected', on); });
  const body = el.querySelector('#doc-body');
  body.dataset.part = id;
  body.textContent = 'Opening…';
  PARTS.find(p => p[0] === id)[3]().then(mod => {
    if (own !== token || !el) return;
    body.textContent = '';
    child = mod; mod.mount(body);
  }).catch(err => { if (own === token && el) body.innerHTML = `<p class="note" role="alert">This part could not open (${String(err && err.message || err)}). The others still work.</p>`; });
}
