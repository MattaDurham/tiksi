// DOCUMENTS › SEND: what goes to the client, in one place, each with where it stands.
//   ONE-PAGER    the teaser: picture, pitch, scope, budget range and schedule (one-pager-dialog.js),
//                with the reminder Tiksi gives on closing when it is behind the project
//   PROPOSAL     each project's price, dates, deposit and signature (PROJECT DOCUMENTS)
//   CLIENT PAGE  the model to walk through and the saved views, on thedurham.nyc (lab-publish-dialog.js)

import { ws, touch, onChange, activeProperty, projectSlice, propertyProjects, escapeHtml as esc, fmtDate } from './store.js';
import { openOnePagerEditor, promptMode } from './one-pager-dialog.js';
import { onePagerStatus, PROMPT_MODES } from './one-pager.js';
import { openLabDialog } from './lab-publish-dialog.js';
import { jobOf } from './job.js';
import { icon } from './icons.js';

let el = null, off = null;
const fm = v => '$' + Math.round(Number(v) || 0).toLocaleString('en-US');

export function mount(root) { el = root; off = onChange(() => { if (el && !el.querySelector('select:focus')) render(); }); render(); }
export function unmount() { if (off) off(); off = null; el = null; }

function render() {
  if (!el) return;
  const prop = activeProperty();
  if (!prop) { el.innerHTML = '<p class="note">Open a property first.</p>'; return; }
  const op = onePagerStatus(prop, projectSlice(prop.id));
  const jobs = propertyProjects().filter(p => !p.parentId);
  const sent = prop.lab && prop.lab.sentAt;
  el.innerHTML = `<div class="send">
    <section class="send-card"><header><h2>One-pager</h2><span class="send-state ${op.state === 'behind' || op.state === 'none' ? 'bad' : ''}">${esc(op.text)}</span></header>
      <p>A one-page teaser of this property for its client: the picture, the pitch, the scope, the budget range and the schedule. Each saved version is a PDF among the property's documents; the newest is the one to send.</p>
      <div class="send-acts"><button type="button" class="btn primary" data-op-open>${icon('edit', { size: 12 })}OPEN ONE-PAGER</button>
        <label>Remind me when closing Tiksi <select data-op-prompt>${PROMPT_MODES.map(([id, label]) => `<option value="${id}" ${promptMode() === id ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select></label></div></section>
    <section class="send-card"><header><h2>Proposal</h2></header>
      <p>One page per project with its price, dates, a deposit, what is included and a place to sign. It is drawn from the project's estimate as it stands.</p>
      ${jobs.length ? `<ul class="send-jobs">${jobs.map(p => { const j = jobOf(p); return `<li><a href="#/documents?job=${encodeURIComponent(p.id)}">${esc(p.name || 'Project')}</a> <span class="note">${fm(j.price.likely)}${j.schedule.days ? `, ${j.schedule.days} working days` : ''}</span></li>`; }).join('')}</ul>` : '<p class="note">No projects yet: start one in ESTIMATE.</p>'}</section>
    <section class="send-card"><header><h2>Client page</h2><span class="send-state">${sent ? 'Last sent ' + esc(fmtDate(String(sent).slice(0, 10))) : 'Not sent yet'}</span></header>
      <p>A view-only copy of this property on thedurham.nyc: the model to orbit or walk through, Existing and the projects you choose, and the saved views with their renderings. No prices.</p>
      <div class="send-acts"><button type="button" class="btn" data-lab>${icon('export', { size: 12 })}SEND TO THE LAB…</button></div></section></div>`;
  el.querySelector('[data-op-open]').onclick = () => openOnePagerEditor(prop, { onSaved: render });
  el.querySelector('[data-op-prompt]').onchange = e => { ws.data.settings.onePagerPrompt = e.target.value; touch(); };
  el.querySelector('[data-lab]').onclick = () => openLabDialog(prop);
}
