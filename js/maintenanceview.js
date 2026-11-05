// MAINTENANCE view: what is due at the open property this month, the booked appointments that
// fill in last-done dates, and the full service list built from its fixtures and house systems.
// The rules are in maintenance.js.

import { touch, escapeHtml, fmtDate, isoToday, activeProperty, uid } from './store.js';
import { icon } from './icons.js';
import {
  HOUSE_SYSTEMS, maintenanceTasks, taskStatus, dueThisMonth, matchTask, parseIcs,
  setTaskInterval, setLastDone, setOff, addSystem, removeSystem, addAppointment, removeAppointment, normaliseMaintenance,
} from './maintenance.js';

let el = null;
let draft = null;          // the appointment being typed: { date, start, end, title, task, picked }
let notice = '';           // one line about the last import
export function mount(root) { el = root; render(); }
export function unmount() { el = null; draft = null; notice = ''; }

const STATUS = {
  overdue: ['OVERDUE', 'red'], due: ['DUE THIS MONTH', 'accent'], booked: ['BOOKED', 'cyan'], soon: ['SOON', ''],
  ok: ['OK', 'green'], unknown: ['NO RECORD', ''], off: ['SKIPPED', ''],
};
const chip = s => `<span class="chip ${STATUS[s][1]}">${STATUS[s][0]}</span>`;
const every = n => n % 12 === 0 ? (n === 12 ? 'yearly' : `every ${n / 12} years`) : (n === 1 ? 'monthly' : `every ${n} months`);
function fmtTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 || 12}${m ? ':' + String(m).padStart(2, '0') : ''} ${h < 12 ? 'AM' : 'PM'}`;
}
export function fmtVisit(a) {
  const time = a.start ? (a.end ? `${fmtTime(a.start)} to ${fmtTime(a.end)}` : fmtTime(a.start)) : '';
  return fmtDate(a.date) + (time ? ', ' + time : '');
}
const monthName = today => { const [y, m] = today.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }); };

function render() {
  if (!el) return;
  const prop = activeProperty();
  if (!prop) { el.innerHTML = '<div class="view-scroll"><div class="empty-state">No property open.</div></div>'; return; }
  if (!prop.maintenance) prop.maintenance = normaliseMaintenance(null);   // loading normalises it (store.js)
  const today = isoToday();
  const tasks = maintenanceTasks(prop, today).map(t => Object.assign(t, { status: taskStatus(t, today) }));
  const due = dueThisMonth(prop, today);
  const m = prop.maintenance;
  const upcoming = m.appointments.filter(a => a.date > today);
  const past = m.appointments.filter(a => a.date <= today).reverse();
  const unknown = tasks.filter(t => t.status === 'unknown');
  const fixtureCount = new Set(tasks.filter(t => t.source === 'fixture').map(t => t.on)).size;
  const byId = new Map(tasks.map(t => [t.id, t]));
  const taskOptions = sel => `<option value="">Not matched</option>` + tasks.filter(t => !t.off).map(t =>
    `<option value="${escapeHtml(t.id)}" ${t.id === sel ? 'selected' : ''}>${escapeHtml(t.what + ': ' + t.task)}</option>`).join('');

  el.innerHTML = `
    <div class="view-scroll maint">
      <div class="view-head">
        <span class="view-title">MAINTENANCE</span>
        <span class="view-sub">${escapeHtml(prop.name)}: ${fixtureCount} fixture${fixtureCount === 1 ? '' : 's'} with service, ${m.systems.length} house system${m.systems.length === 1 ? '' : 's'}</span>
        <span style="flex:1"></span>
        <button class="btn" id="maint-ics">${icon('import')}IMPORT CALENDAR (.ICS)</button>
        <button class="btn primary" id="maint-book">${icon('plus')}ADD APPOINTMENT</button>
        <input type="file" id="maint-ics-file" accept=".ics,text/calendar" hidden>
      </div>
      ${notice ? `<p class="maint-notice">${escapeHtml(notice)}</p>` : ''}

      <div class="kpi-band">
        <div class="kpi ${due.some(t => t.status === 'overdue') ? 'over' : 'accent'}">
          <div class="k-label">Due in ${escapeHtml(monthName(today))}</div>
          <div class="k-value" data-kpi="due">${due.length}</div>
          <div class="k-sub">${due.filter(t => t.status === 'overdue').length} overdue from earlier</div>
        </div>
        <div class="kpi">
          <div class="k-label">Booked</div>
          <div class="k-value" data-kpi="booked">${upcoming.length}</div>
          <div class="k-sub">${upcoming[0] ? escapeHtml('next ' + fmtVisit(upcoming[0])) : 'no appointments ahead'}</div>
        </div>
        <div class="kpi">
          <div class="k-label">No last-done date</div>
          <div class="k-value" data-kpi="unknown">${unknown.length}</div>
          <div class="k-sub">type one below, or book a visit</div>
        </div>
      </div>

      ${draft ? draftForm(tasks, taskOptions) : ''}

      <div class="kicker">DUE THIS MONTH</div>
      <table class="grid maint-due" style="max-width:1080px">
        <thead><tr><th>What</th><th>Service</th><th>Interval</th><th>Last done</th><th>Due</th><th></th><th></th></tr></thead>
        <tbody>${due.map(t => `<tr data-task="${escapeHtml(t.id)}">
          <td><b>${escapeHtml(t.what)}</b>${t.room ? ` <span class="faint">${escapeHtml(t.room)}</span>` : ''}</td>
          <td>${escapeHtml(t.task)}</td><td class="muted">${every(t.intervalMonths)}</td>
          <td class="num">${fmtDate(t.lastDone)}</td><td class="num">${fmtDate(t.nextDue)}</td><td>${chip(t.status)}</td>
          <td class="maint-acts"><button class="btn small" data-done="${escapeHtml(t.id)}">${icon('check')}DONE TODAY</button>
            <button class="btn small" data-book="${escapeHtml(t.id)}">BOOK</button></td></tr>`).join('') ||
          `<tr><td colspan="7" class="muted">${tasks.some(t => t.lastDone) ? 'Nothing is due this month.' : 'Nothing can come due until a task has a last-done date. Type one in the service list or add an appointment.'}</td></tr>`}
        </tbody>
      </table>

      <div class="kicker" style="margin-top:26px">APPOINTMENTS</div>
      <table class="grid maint-appts" style="max-width:1080px">
        <thead><tr><th>When</th><th>Appointment</th><th>Services</th><th></th></tr></thead>
        <tbody>${[...upcoming, ...past].map(a => {
          const t = byId.get(a.on + '/' + a.key);
          return `<tr data-appt="${escapeHtml(a.id)}" class="${a.date <= today ? 'maint-past' : ''}">
            <td class="num">${escapeHtml(fmtVisit(a))}</td>
            <td>${escapeHtml(a.title)}${a.date <= today && t ? ' <span class="chip green">COUNTED AS DONE</span>' : ''}</td>
            <td><select data-appt-task="${escapeHtml(a.id)}" aria-label="Service for ${escapeHtml(a.title)}">${taskOptions(t ? t.id : '')}</select></td>
            <td><button class="btn small ghost danger" data-appt-del="${escapeHtml(a.id)}" aria-label="Delete appointment">${icon('trash')}</button></td></tr>`;
        }).join('') || '<tr><td colspan="4" class="muted">No appointments. A visit on or before today fills in its service\'s last-done date.</td></tr>'}
        </tbody>
      </table>

      <div class="kicker" style="margin-top:26px">SERVICE LIST</div>
      <table class="grid maint-all" style="max-width:1080px">
        <thead><tr><th>What</th><th>Service</th><th style="text-align:right">Every (months)</th><th>Last done</th><th>Next due</th><th></th><th>Skip</th></tr></thead>
        <tbody>${tasks.map(t => `<tr data-task="${escapeHtml(t.id)}" class="${t.off ? 'maint-off' : ''}">
          <td><b>${escapeHtml(t.what)}</b>${t.room ? ` <span class="faint">${escapeHtml(t.room)}</span>` : ''}</td>
          <td>${escapeHtml(t.task)}</td>
          <td class="num"><input type="number" class="num" min="1" max="240" step="1" value="${t.intervalMonths}" data-interval="${escapeHtml(t.id)}" aria-label="Months between services" style="width:64px" title="Typical: ${t.typicalMonths}"></td>
          <td><input type="date" value="${escapeHtml(t.lastDone)}" data-last="${escapeHtml(t.id)}" aria-label="Last done">${t.lastDoneFrom === 'appointment' ? `<div class="faint maint-from">from appointment</div>` : ''}</td>
          <td class="num">${t.booked ? escapeHtml(fmtVisit(t.booked)) : fmtDate(t.nextDue)}</td><td>${chip(t.status)}</td>
          <td><input type="checkbox" ${t.off ? 'checked' : ''} data-off="${escapeHtml(t.id)}" aria-label="Skip this service"></td></tr>`).join('') ||
          '<tr><td colspan="7" class="muted">No service yet. Fixtures found at onboarding (appliances, bath fixtures, fittings) list their service here; add the house systems below.</td></tr>'}
        </tbody>
      </table>

      <div class="kicker" style="margin-top:26px">HOUSE SYSTEMS</div>
      <div class="maint-systems">
        ${m.systems.map(s => `<span class="chip maint-sys" data-sys="${escapeHtml(s.id)}">${escapeHtml(s.name || HOUSE_SYSTEMS[s.kind].label)}
          <button class="maint-sys-del" data-sys-del="${escapeHtml(s.id)}" aria-label="Remove ${escapeHtml(s.name || HOUSE_SYSTEMS[s.kind].label)}">${icon('close')}</button></span>`).join('')}
      </div>
      <div class="maint-add-sys">
        ${Object.entries(HOUSE_SYSTEMS).filter(([k]) => k !== 'other').map(([k, s]) =>
          `<button class="btn small" data-sys-add="${k}" ${m.systems.some(x => x.kind === k) ? 'disabled' : ''}>${icon('plus')}${escapeHtml(s.label.toUpperCase())}</button>`).join('')}
        <input type="text" id="maint-sys-name" placeholder="another system (well pump, septic...)" aria-label="Another house system">
        <button class="btn small" id="maint-sys-other">${icon('plus')}ADD</button>
      </div>
    </div>`;
  bind(prop, tasks);
}

function draftForm(tasks, taskOptions) {
  return `<div class="card maint-draft" id="maint-draft">
    <div class="field-row">
      <div class="field"><label>Date</label><input type="date" data-d="date" value="${escapeHtml(draft.date)}"></div>
      <div class="field"><label>From</label><input type="time" data-d="start" value="${escapeHtml(draft.start)}"></div>
      <div class="field"><label>To</label><input type="time" data-d="end" value="${escapeHtml(draft.end)}"></div>
    </div>
    <div class="field-row">
      <div class="field" style="flex:2"><label>Appointment</label><input type="text" data-d="title" value="${escapeHtml(draft.title)}" placeholder="chimney sweep"></div>
      <div class="field" style="flex:2"><label>Services <span class="faint">(matched from the name; change it if wrong)</span></label><select data-d="task">${taskOptions(draft.task)}</select></div>
    </div>
    <div class="maint-draft-acts"><button class="btn primary" id="maint-save" ${draft.date ? '' : 'disabled'}>SAVE APPOINTMENT</button>
      <button class="btn ghost" id="maint-cancel">CANCEL</button></div>
  </div>`;
}

function split(id) { const i = id.indexOf('/'); return [id.slice(0, i), id.slice(i + 1)]; }

function bind(prop, tasks) {
  const $ = s => el.querySelector(s), $$ = s => el.querySelectorAll(s);
  const changed = () => { touch(); render(); };
  $('#maint-book').onclick = () => { draft = { date: '', start: '', end: '', title: '', task: '', picked: false }; render(); el.querySelector('[data-d="date"]')?.focus(); };
  $$('[data-book]').forEach(b => b.onclick = () => {
    const t = tasks.find(x => x.id === b.dataset.book);
    draft = { date: '', start: '', end: '', title: t ? t.task + ' (' + t.what + ')' : '', task: b.dataset.book, picked: true };
    render(); el.querySelector('[data-d="date"]')?.focus();
  });
  $$('[data-done]').forEach(b => b.onclick = () => { setLastDone(prop, ...split(b.dataset.done), isoToday()); changed(); });
  $$('[data-interval]').forEach(i => i.onchange = () => { setTaskInterval(prop, ...split(i.dataset.interval), i.value); changed(); });
  $$('[data-last]').forEach(i => i.onchange = () => { setLastDone(prop, ...split(i.dataset.last), i.value); changed(); });
  $$('[data-off]').forEach(i => i.onchange = () => { setOff(prop, ...split(i.dataset.off), i.checked); changed(); });
  $$('[data-appt-task]').forEach(s => s.onchange = () => {
    const a = prop.maintenance.appointments.find(x => x.id === s.dataset.apptTask);
    if (!a) return;
    [a.on, a.key] = s.value ? split(s.value) : ['', ''];
    changed();
  });
  $$('[data-appt-del]').forEach(b => b.onclick = () => { removeAppointment(prop, b.dataset.apptDel); changed(); });
  $$('[data-sys-add]').forEach(b => b.onclick = () => { addSystem(prop, b.dataset.sysAdd, '', uid('sys')); changed(); });
  $$('[data-sys-del]').forEach(b => b.onclick = () => {
    const s = prop.maintenance.systems.find(x => x.id === b.dataset.sysDel);
    if (s && confirm(`Remove ${s.name || HOUSE_SYSTEMS[s.kind].label} and its service dates? Its appointments stay, unmatched.`)) { removeSystem(prop, s.id); changed(); }
  });
  const other = () => { const name = $('#maint-sys-name').value.trim(); if (name) { addSystem(prop, 'other', name, uid('sys')); changed(); } };
  $('#maint-sys-other').onclick = other;
  $('#maint-sys-name').onkeydown = e => { if (e.key === 'Enter') other(); };

  const file = $('#maint-ics-file');
  $('#maint-ics').onclick = () => file.click();
  file.onchange = async () => {
    const f = file.files && file.files[0];
    if (!f) return;
    const events = parseIcs(await f.text());
    notice = importEvents(prop, tasks, events, f.name);
    changed();
  };

  const form = $('#maint-draft');
  if (!form) return;
  form.querySelectorAll('[data-d]').forEach(i => i.oninput = i.onchange = () => {
    const k = i.dataset.d;
    draft[k] = i.value;
    if (k === 'task') draft.picked = true;
    if (k === 'title' && !draft.picked) {
      const t = matchTask(draft.title, tasks);
      draft.task = t ? t.id : '';
      form.querySelector('[data-d="task"]').value = draft.task;
    }
    $('#maint-save').disabled = !draft.date;
  });
  $('#maint-cancel').onclick = () => { draft = null; render(); };
  $('#maint-save').onclick = () => {
    if (!draft.date) return;
    const [on, key] = draft.task ? split(draft.task) : ['', ''];
    addAppointment(prop, { id: uid('appt'), date: draft.date, start: draft.start, end: draft.end, title: draft.title.trim() || 'Appointment', on, key, notes: '' });
    draft = null;
    changed();
  };
}

// Calendar events become appointments when their name matches a service at this home; the
// rest are left out (a calendar holds much more than house visits). Re-importing the same
// file adds nothing twice.
export function importEvents(prop, tasks, events, fileName) {
  const m = prop.maintenance;
  let added = 0, skipped = 0, dup = 0;
  for (const e of events) {
    const t = matchTask(e.title, tasks);
    if (!t) { skipped++; continue; }
    if (m.appointments.some(a => a.date === e.date && a.start === e.start && a.title === e.title)) { dup++; continue; }
    addAppointment(prop, { id: uid('appt'), date: e.date, start: e.start, end: e.end, title: e.title, on: t.on, key: t.key, notes: '' });
    added++;
  }
  const bits = [`${added} appointment${added === 1 ? '' : 's'} added from ${fileName}`];
  if (dup) bits.push(`${dup} already here`);
  if (skipped) bits.push(`${skipped} event${skipped === 1 ? '' : 's'} left out: no service at this home matches ${skipped === 1 ? 'its' : 'their'} name`);
  if (!events.length) return `${fileName} holds no events.`;
  return bits.join('; ') + '.';
}

