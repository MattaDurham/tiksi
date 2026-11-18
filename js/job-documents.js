// DOCUMENTS > PROJECT DOCUMENTS: what a project prints, written from the job (job.js) so every figure is
// ESTIMATE's and every date SCHEDULE's.
//   TRIM PACKAGE  the book for the carpenter and the yard: summary, options, buy list, each room's
//                 walls with their boards, cut lists, installer bid form, price build-up, appendices
//                 (trim-package-doc.js)
//   PROPOSAL      one page for the client: the work room by room, the price, the dates, payments,
//                 what is and is not included, and a place to sign
// Printed from the browser (PRINT, then Save as PDF for a PDF with real text).

import { ws, touch, onChange, activeProperty, propertyProjects, projectById, escapeHtml, fmtMoney, fmtDate, isoToday } from './store.js';
import { jobOf, rootOf, trimForBook } from './job.js';
import { workday } from './program.js';
import { trimPackageHtml } from './trim-package-doc.js';
import { trimStyle } from './trims.js';
import { printSheet } from './print-sheet.js';
import { icon } from './icons.js';

const esc = escapeHtml;
const DOCS = [
  ['package', 'Trim package', 'Buy list, every wall with its boards, cut lists, the installer bid form and the price build-up'],
  ['proposal', 'Proposal', 'One page for the client: the work, the price, the dates and a place to sign'],
];
export const PROPOSAL_DEFAULTS = Object.freeze({
  deposit: 0.3, validDays: 30,
  included: 'Protection of floors and furniture in the rooms worked in, daily cleanup and removal of debris, caulking, filling and painting the new trim.',
  excluded: 'Wall repair or painting beyond the trim, moving furniture, and conditions hidden behind finished surfaces.',
});
let el = null, off = null, timer = null, jobId = '', docId = 'package';

export function mount(root) {
  el = root;
  off = onChange(() => { clearTimeout(timer); timer = setTimeout(() => { if (el && !el.querySelector('.jd-side :focus')) render(); else paper(); }, 200); });
  render();
}
export function unmount() { clearTimeout(timer); if (off) off(); off = null; el = null; }

function chosen() {
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  const id = q.get('job');
  if (id && projectById(id)) jobId = rootOf(projectById(id)).id;
  const tops = propertyProjects().filter(p => !p.parentId);
  if (!tops.some(p => p.id === jobId)) jobId = (tops.find(p => jobOf(p).trim) || tops[0] || {}).id || '';
  return projectById(jobId);
}
const termsOf = root => ({ ...PROPOSAL_DEFAULTS, ...(root.proposal || {}) });

function docHtml(root) {
  const job = jobOf(root), prop = activeProperty();
  if (docId === 'proposal') return proposalHtml(job, prop);
  const t = trimForBook(root);
  if (!t) return { html: '<p class="note">This project has no drawn trim, so there is no trim package. Draw its trim in MODEL, each section in a room\'s subproject.</p>', css: '' };
  return trimPackageHtml(t, { title: prop ? prop.name : root.name, propertyName: prop ? prop.name : '', date: isoToday(), design: root.name, status: 'For review: check lengths on site before ordering',
    business: ws.data.settings.business || null, pricesSeen: '' });
}

function render() {
  if (!el) return;
  const root = chosen(), tops = propertyProjects().filter(p => !p.parentId);
  if (!root) { el.innerHTML = '<div class="empty-state"><b>No projects</b>Start a project in ESTIMATE; its estimate writes these documents.</div>'; return; }
  const B = ws.data.settings.business || {}, T = termsOf(root);
  const f = (scope, key, label, value, type = 'text') => `<label class="jd-f"><span>${esc(label)}</span>${type === 'textarea' ? `<textarea rows="3" data-${scope}="${key}">${esc(value || '')}</textarea>` : `<input type="${type}" data-${scope}="${key}" value="${esc(value ?? '')}">`}</label>`;
  el.innerHTML = `<div class="jd">
    <nav class="jd-list" aria-label="Project documents">
      <label class="jd-f"><span>Project</span><select id="jd-job">${tops.map(p => `<option value="${esc(p.id)}" ${p.id === root.id ? 'selected' : ''}>${esc(p.name || 'Project')}</option>`).join('')}</select></label>
      ${DOCS.map(([id, title, what]) => `<button type="button" class="jd-doc ${id === docId ? 'here' : ''}" data-doc="${id}"><b>${esc(title)}</b><span>${esc(what)}</span></button>`).join('')}
      <a class="jd-doc" href="#/estimate?project=${encodeURIComponent(root.id)}"><b>Open the estimate</b><span>Rates, markups and bids</span></a>
    </nav>
    <main class="jd-stage"><div class="jd-bar"><b>${esc(DOCS.find(d => d[0] === docId)[1])}</b><span class="sp"></span><button class="btn primary small" data-print>${icon('print')}PRINT OR SAVE PDF</button></div><div class="jd-paper" id="jd-paper"></div></main>
    <aside class="jd-side" aria-label="What the documents say">
      <div class="gl">Your business</div>${f('biz', 'name', 'Name', B.name)}${f('biz', 'address', 'Address', B.address)}${f('biz', 'phone', 'Phone', B.phone)}${f('biz', 'email', 'Email', B.email, 'email')}${f('biz', 'license', 'License number', B.license)}
      <div class="gl">The proposal</div>${f('prop', 'client', 'Client', T.client)}${f('prop', 'deposit', 'Deposit %', Math.round(T.deposit * 100), 'number')}${f('prop', 'validDays', 'Good for, days', T.validDays, 'number')}
      ${f('prop', 'included', 'Included', T.included, 'textarea')}${f('prop', 'excluded', 'Not included', T.excluded, 'textarea')}
    </aside></div>`;
  paper();
  el.querySelector('#jd-job').onchange = e => { jobId = e.target.value; history.replaceState(null, '', '#/documents?job=' + encodeURIComponent(jobId)); render(); };
  el.querySelectorAll('[data-doc]').forEach(b => b.onclick = () => { docId = b.dataset.doc; render(); });
  el.querySelector('[data-print]').onclick = () => { const d = docHtml(root); printSheet(`<style>${d.css || ''}</style>${d.html}`); };
  el.querySelectorAll('[data-biz]').forEach(i => i.onchange = () => { ws.data.settings.business = { ...(ws.data.settings.business || {}), [i.dataset.biz]: i.value.trim() }; touch(); paper(); });
  el.querySelectorAll('[data-prop]').forEach(i => i.onchange = () => {
    const k = i.dataset.prop; let v = i.value;
    if (k === 'deposit') v = Math.min(100, Math.max(0, Number(v) || 0)) / 100;
    if (k === 'validDays') v = Math.max(1, Math.round(Number(v) || 30));
    const next = { ...(root.proposal || {}) };
    if (v === '' || v === PROPOSAL_DEFAULTS[k]) delete next[k]; else next[k] = v;
    if (Object.keys(next).length) root.proposal = next; else delete root.proposal;
    touch(); paper();
  });
}
function paper() {
  const box = el && el.querySelector('#jd-paper'), root = projectById(jobId);
  if (!box || !root) return;
  try { const d = docHtml(root); box.innerHTML = `<style>${(d.css || '').replace(/@page[^{]*\{[^}]*(\{[^}]*\}[^}]*)*\}/g, '')}</style>${d.html}`; }
  catch (e) { console.error(e); box.innerHTML = `<p class="note" role="alert">This document could not be written (${esc(e.message)}).</p>`; }
}

// ---------- the proposal ----------
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many || one + 's');
function workWords(job, room) {
  const lines = [], t = job.trim && !job.trim.error ? job.trim : null;
  if (t && room.trim.length) {
    const kinds = new Map();
    for (const s of t.sections.filter(x => x.projectId === room.project.id || (room.project === job.root && room.trim.some(r => r.name === (x.roomName || ''))))) {
      const st = trimStyle(s), c = t.catalog[s.product] || {};
      const k = (st ? st.label : 'Trim') + (c.short ? ', ' + c.short : '');
      kinds.set(k, (kinds.get(k) || 0) + 1);
    }
    if (!kinds.size) lines.push('Trim as drawn');
    for (const [k] of kinds) lines.push(k);
  }
  for (const it of room.items) if ((it.likely || it.high || 0) > 0) lines.push(it.name || 'Item');
  return lines;
}
export function proposalHtml(job, prop) {
  const root = job.root, T = termsOf(root), B = ws.data.settings.business || {};
  const start = root.startDate || ws.data.settings.programStart || '';
  const days = job.schedule.days, price = Math.round(job.price.likely);
  const rooms = job.rooms.filter(r => Math.round(r.price.likely) > 0);
  const work = rooms.map(r => `<tr><td><b>${esc(r.name)}</b><div class="pp-sm">${esc(workWords(job, r).join('; '))}</div></td><td class="r">${fmtMoney(Math.round(r.price.likely))}</td></tr>`).join('')
    + (Math.round(job.other.price.likely) > 0 ? `<tr><td><b>General</b><div class="pp-sm">${esc(job.other.items.filter(i => (i.likely || i.high || 0) > 0).map(i => i.name).join('; '))}</div></td><td class="r">${fmtMoney(Math.round(job.other.price.likely))}</td></tr>` : '');
  const deposit = Math.round(price * T.deposit);
  const html = `<div class="pp"><section class="pp-page">
    <header class="pp-head"><div><b>${esc(B.name || 'Your business name')}</b>${[B.address, B.phone, B.email, B.license ? 'License ' + B.license : ''].filter(Boolean).map(x => `<span>${esc(x)}</span>`).join('')}</div>
      <div class="pp-r"><span class="pp-kind">Proposal</span><b>${esc(root.name || 'Project')}</b><span>${esc(prop ? prop.name || '' : '')}</span><span>${esc(fmtDate(isoToday()))}</span></div></header>
    <p class="pp-lede">${T.client ? 'For ' + esc(T.client) + '. ' : ''}We propose to do the work below for <b>${fmtMoney(price)}</b>${days ? `, in ${plural(days, 'working day')}${start ? `, ${esc(fmtDate(workday(start, 0)))} to ${esc(fmtDate(workday(start, days - 1)))}` : ''}` : ''}.</p>
    <h2>The work</h2><table class="pp-t"><tbody>${work || '<tr><td>Nothing in the scope yet.</td><td></td></tr>'}<tr class="tot"><td>Total</td><td class="r">${fmtMoney(price)}</td></tr></tbody></table>
    <h2>Payments</h2><table class="pp-t"><tbody><tr><td>On signing (${Math.round(T.deposit * 100)}%)</td><td class="r">${fmtMoney(deposit)}</td></tr><tr><td>On completion</td><td class="r">${fmtMoney(price - deposit)}</td></tr></tbody></table>
    <h2>Included</h2><p>${esc(T.included)}</p><h2>Not included</h2><p>${esc(T.excluded)}</p>
    <p class="pp-sm">Lengths are checked on site before ordering. Any change to the work is agreed in writing, with its price, before it starts. This proposal is good for ${plural(T.validDays, 'day')}.</p>
    <div class="pp-sign"><div><span></span>Client signature</div><div><span></span>Date</div><div><span></span>${esc(B.name || 'Contractor')}</div><div><span></span>Date</div></div>
  </section></div>`;
  return { html, css: '' };
}
