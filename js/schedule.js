// SCHEDULE: when the work happens, in working days (Monday to Friday).
//
// A job (a top-level project with its subprojects) is laid out by job.js: one carpenter does the
// drawn trim room after room, in the order the subprojects are listed (move a room up or down
// here); every scope item with days runs on its own unless it is set to start AFTER another line.
// ALL PROJECTS lays the jobs in the program side by side from the program start, each from its own
// start date, or after the job it is set to follow (program.js).
//
// One table: the work, who does it, its days and dates, what it waits for, and a chart of working
// days beside it (weekends are left out, so a bar's length is its days). Tap or click a line for
// its dates and slack.

import { ws, touch, onChange, activeProperty, propertyProjects, projectById, escapeHtml, fmtDate, isoToday } from './store.js';
import { programSchedule, workday, workdaysBetween } from './program.js';
import { jobOf, rootOf } from './job.js';
import { restoreProjectEdit } from './project-history.js';
import { icon } from './icons.js';

const esc = escapeHtml;
const hrs = v => (Math.round((Number(v) || 0) * 10) / 10).toFixed(1);
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many || one + 's');
let el = null, off = null, timer = null, picked = '';
let fitW = 0;   // the day width that fills the page, measured after the first draw
const LAST = 'tiksi.schedule.last.';

export { cpm } from './program.js';

function target() {
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  const id = q.get('project');
  if (id && projectById(id)) return { id: rootOf(projectById(id)).id };
  if (q.has('program')) return { program: true };
  let last = '';
  try { last = localStorage.getItem(LAST + (activeProperty() || {}).id) || ''; } catch { /* not kept */ }
  const tops = propertyProjects().filter(p => !p.parentId);
  if (last && tops.some(p => p.id === last)) return { id: last };
  return { program: true };
}
function go(t) {
  try { localStorage.setItem(LAST + (activeProperty() || {}).id, t.program ? 'program' : t.id); } catch { /* fine */ }
  history.replaceState(null, '', t.program ? '#/schedule?program' : '#/schedule?project=' + encodeURIComponent(t.id));
  picked = ''; fitW = 0; render();
}

export function mount(root) {
  el = root;
  off = onChange(() => { clearTimeout(timer); timer = setTimeout(() => { if (el && !el.querySelector('.sc :is(input,select):focus')) render(); }, 150); });
  addEventListener('resize', onResize);
  render();
}
export function unmount() { clearTimeout(timer); if (off) off(); off = null; removeEventListener('resize', onResize); el = null; }
export function undo() { if (restoreProjectEdit('undo')) render(); }
export function redo() { if (restoreProjectEdit('redo')) render(); }
let rz = null;
function onResize() { clearTimeout(rz); rz = setTimeout(() => { fitW = 0; render(); }, 120); }

function render() {
  if (!el) return;
  const t = target(), prop = activeProperty();
  const tops = propertyProjects().filter(p => !p.parentId);
  const scroll = el.querySelector('.sc-main')?.scrollTop || 0;
  const nav = `<nav class="es-nav" aria-label="Jobs">
    <a class="es-job ${t.program ? 'here' : ''}" href="#/schedule?program" data-program><span>All projects</span></a>
    <div class="gl">Projects</div>
    ${tops.map(p => { const j = jobOf(p); return `<a class="es-job ${t.id === p.id ? 'here' : ''}" href="#/schedule?project=${encodeURIComponent(p.id)}" data-job="${esc(p.id)}"><span>${esc(p.name || 'Project')}</span><span class="m">${j.schedule.days ? plural(j.schedule.days, 'day') : ''}</span></a>`; }).join('') || '<p class="note">No projects yet.</p>'}
  </nav>`;
  el.innerHTML = `<div class="sc">${nav}<main class="sc-main"><div class="sc-in" id="sc-in"></div></main></div>`;
  el.querySelector('[data-program]').onclick = e => { e.preventDefault(); go({ program: true }); };
  el.querySelectorAll('[data-job]').forEach(a => a.onclick = e => { e.preventDefault(); go({ id: a.dataset.job }); });
  const inner = el.querySelector('#sc-in');
  const view = t.program ? programView(prop) : jobView(projectById(t.id));
  inner.innerHTML = view.html;
  view.bind(inner);
  el.querySelector('.sc-main').scrollTop = scroll;
  // Days as wide as the page allows (9 to 56 pixels): measure where the chart starts and draw again.
  const g = inner.querySelector('#gantt'), axis = g && g.querySelector('th.axis');
  if (g && axis && !fitting) {
    const n = Number(g.dataset.cols) || 1;
    const want = Math.max(9, Math.min(56, Math.floor((g.clientWidth - axis.offsetLeft - 2) / n)));
    if (want !== Number(g.dataset.dayw)) { fitting = true; fitW = want; try { render(); } finally { fitting = false; } }
  }
}
let fitting = false;

// ---------- the chart ----------
// lines: [{ key, kind: 'job'|'trim'|'item', label, crew, days, es, ef, slack, critical, after (html), move (html), detail }]
// with es/ef in working days from `origin`.
function table(lines, origin, span) {
  const today = workdaysBetween(origin, isoToday());
  const avail = Math.max(320, (el.clientWidth || 1200) - 220 - 64 - 640);
  const dayW = fitW || Math.max(9, Math.min(56, Math.floor(avail / (Math.max(span, 5) + 1))));
  const cols = Math.max(span, 5) + 1, W = cols * dayW;
  let axis = '', grid = '';
  for (let n = 0; n < cols; n++) {
    const iso = workday(origin, n), dt = new Date(iso + 'T00:00'), mon = dt.getDay() === 1 || n === 0;
    if (mon) axis += `<span class="sc-wk" style="left:${n * dayW}px">${esc(dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase())}<small>${dt.toLocaleDateString('en-US', { weekday: 'short' })}</small></span>`;
    grid += `<span class="sc-col ${mon ? 'wk' : ''}" style="left:${n * dayW}px"></span>`;
  }
  const todayLine = today >= 0 && today < cols ? `<span class="sc-today" style="left:${today * dayW}px" title="Today"></span>` : '';
  const y0 = workday(origin, 0).slice(0, 4);
  const date = n => { const iso = workday(origin, n), dt = new Date(iso + 'T00:00'); return dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', ...(iso.slice(0, 4) !== y0 ? { year: 'numeric' } : {}) }); };
  const row = l => {
    const x0 = l.es * dayW, w = Math.max((l.ef - l.es) * dayW - 2, 3);
    const bar = l.kind === 'job' ? `<span class="sc-bar job" style="left:${x0}px;width:${w}px"></span>`
      : `<span class="sc-bar ${l.kind === 'trim' ? 'trim' : l.critical ? 'crit' : ''}" style="left:${x0 + 1}px;width:${w}px">${w >= 26 ? esc(l.days + 'd') : ''}</span>${l.slack > 0.001 ? `<span class="sc-slack" style="left:${x0 + w + 2}px;width:${l.slack * dayW - 2}px"></span>` : ''}`;
    return `<tr class="${l.kind === 'job' ? 'job' : 'g-item'} ${picked === l.key ? 'on' : ''}" data-key="${esc(l.key)}" data-detail="${esc(l.detail)}" tabindex="0">
      <td class="sticky work" title="${esc(l.label)}">${l.kind === 'job' ? '' : '<span class="dim">&nbsp;&nbsp;</span>'}${esc(l.label)}</td><td class="num">${l.days}</td>
      <td class="dim">${date(l.es)}</td><td class="dim">${date(Math.max(l.es, Math.ceil(l.ef - 1e-9) - 1))}</td><td>${l.after || ''}</td><td>${l.move || ''}</td>
      <td class="bars">${grid}${todayLine}${bar}</td></tr>`;
  };
  return `<div class="sc-grid" id="gantt" data-cols="${cols}" data-dayw="${dayW}" style="--chart-w:${W}px"><table class="sc-tab"><thead><tr><th class="sticky">Work</th><th class="num">Days</th><th>Starts</th><th>Ends</th><th>After</th><th></th><th class="axis">${axis}</th></tr></thead>
    <tbody>${lines.map(row).join('')}</tbody></table></div>`;
}

const detailOf = (label, days, origin, es, ef, extra, s) =>
  `${label}: ${plural(days, 'working day')}, ${fmtDate(workday(origin, es))} to ${fmtDate(workday(origin, Math.max(es, Math.ceil(ef - 1e-9) - 1)))}, ${s && s.critical ? 'on the critical path' : 'slack ' + plural(Math.round((s ? s.slack : 0) * 10) / 10, 'day')}${extra ? '; ' + extra : ''}`;

// The lines of one job, from `shift` working days after `origin`.
function jobLines(job, sched, origin, shift, editable) {
  const rows = sched.rows, S = sched.sched;
  const options = (self, current) => `<option value="">Start</option>` + rows.filter(r => r.id !== self).map(r => `<option value="${esc(r.id)}" ${current === r.id ? 'selected' : ''}>${esc(r.kind === 'trim' ? r.name + ' trim' : r.name)}</option>`).join('');
  const trims = rows.filter(r => r.kind === 'trim');
  return rows.map(r => {
    const s = S[r.id], first = trims[0] === r;
    let after = '';
    if (editable && r.kind === 'item') after = `<select data-after="${esc(r.id)}" aria-label="${esc(r.name)} starts after">${options(r.id, (r.deps || [])[0] || '')}</select>`;
    else if (editable && first) after = `<select data-trim-after aria-label="The trim starts after">${options(r.id, r.deps[0] || '').replace(/<option value="trim:[^"]*"[^>]*>[^<]*<\/option>/g, '')}</select>`;
    else if (r.kind === 'trim') after = `<span class="dim">the room before</span>`;
    const i = trims.indexOf(r), sub = r.kind === 'trim' && r.room.project !== job.root;
    const move = editable && sub ? `<button class="sc-move" data-move="${esc(r.room.project.id)}" data-dir="-1" ${i <= 0 ? 'disabled' : ''} aria-label="Do ${esc(r.name)} sooner">↑</button><button class="sc-move" data-move="${esc(r.room.project.id)}" data-dir="1" ${i === trims.length - 1 ? 'disabled' : ''} aria-label="Do ${esc(r.name)} later">↓</button>` : '';
    const label = r.kind === 'trim' ? r.name + ': trim' : (r.room ? r.room.name + ': ' : '') + r.name;
    return { key: r.id, kind: r.kind, label, crew: r.crew || (r.kind === 'trim' ? 'Carpenter' : ''), days: r.durationDays, es: shift + s.es, ef: shift + s.ef, slack: s.slack, critical: s.critical, after, move,
      detail: detailOf(label, r.durationDays, origin, shift + s.es, shift + s.ef, r.kind === 'trim' ? hrs(r.hours) + ' carpenter hours' : '', s) };
  });
}

function jobView(root) {
  const job = jobOf(root), sched = job.schedule;
  const origin = root.startDate || ws.data.settings.programStart || isoToday();
  const carpenter = sched.rows.filter(r => r.kind === 'trim').reduce((n, r) => n + r.durationDays, 0);
  const lines = jobLines(job, sched, origin, 0, true);
  const html = `<header class="es-head"><div class="es-kicker">Schedule</div><h1>${esc(root.name || 'Project')}</h1>
    <div class="es-figs"><div class="big"><b>${sched.days ? plural(sched.days, 'working day') : 'Nothing scheduled'}</b><span>${sched.days ? `${fmtDate(workday(origin, 0))} to ${fmtDate(workday(origin, sched.days - 1))}` : 'give scope items days in PROJECTS, or draw trim'}</span></div>
      <div><label class="sc-start"><span>Starts</span><input type="date" id="job-start" value="${esc(origin)}"></label></div>
      <div><b>${carpenter || '–'}</b><span>carpenter days on the trim</span></div>
      <div><b>${hrs(job.hours.likely)}</b><span>carpenter hours</span></div></div>
    <div class="es-acts"><a class="btn small" href="#/estimate?project=${encodeURIComponent(root.id)}">${icon('budget')}ESTIMATE</a></div></header>
    ${sched.rows.length ? table(lines, origin, sched.days) + `<div class="sc-detail" id="gantt-detail" role="status">Click a line for its dates and slack.</div>` : '<p class="note">Nothing to schedule yet.</p>'}
    ${sched.cyclic ? '<p class="note">Some lines wait for each other in a loop; those links are left out.</p>' : ''}
    <p class="note">Working days, Monday to Friday. The carpenter does the rooms one after another, in the order shown: move a room with the arrows. A scope item starts with the job unless you choose what it starts AFTER. Days for scope items are set in PROJECTS; a room's days come from its hours at 6 productive hours a day.</p>`;
  return { html, bind: inner => {
    inner.querySelector('#job-start').onchange = e => { root.startDate = e.target.value; touch(); render(); };
    inner.querySelectorAll('[data-after]').forEach(s => s.onchange = () => {
      const hit = job.tree.flatMap(x => x.items || []).find(it => it.id === s.dataset.after);
      if (hit) { hit.deps = s.value ? [s.value] : []; touch(); render(); }
    });
    inner.querySelector('[data-trim-after]')?.addEventListener('change', e => { root.job = { ...(root.job || {}), trimAfter: e.target.value }; if (!e.target.value) delete root.job.trimAfter; if (!Object.keys(root.job).length) delete root.job; touch(); render(); });
    inner.querySelectorAll('[data-move]').forEach(b => b.onclick = () => moveRoom(job, b.dataset.move, Number(b.dataset.dir)));
    bindPick(inner);
  } };
}

// Swap a room's subproject with the next or previous subproject that has trim, in the project list.
function moveRoom(job, id, dir) {
  const order = job.schedule.rows.filter(r => r.kind === 'trim' && r.room.project !== job.root).map(r => r.room.project);
  const i = order.findIndex(p => p.id === id), other = order[i + dir];
  if (i < 0 || !other) return;
  const list = ws.data.projects, a = list.indexOf(order[i]), b = list.indexOf(other);
  [list[a], list[b]] = [list[b], list[a]];
  touch(); render();
}

function programView(prop) {
  const start = ws.data.settings.programStart || isoToday();
  const { plans, days, lastDay } = programSchedule(propertyProjects(), start);
  const lines = [];
  for (const x of plans) {
    const job = jobOf(x.p);
    const others = plans.filter(y => y !== x).map(y => `<option value="${esc(y.p.id)}" ${x.p.after === y.p.id ? 'selected' : ''}>${esc(y.p.name)}</option>`).join('');
    lines.push({ key: 'job:' + x.p.id, kind: 'job', label: x.p.name || 'Project', crew: '', days: Math.ceil(x.end - 1e-9), es: x.offset, ef: x.finish, slack: 0,
      after: `<select data-job-after="${esc(x.p.id)}" aria-label="${esc(x.p.name)} starts after"><option value="">Its start date</option>${others}</select>`, move: '',
      detail: detailOf(x.p.name || 'Project', Math.ceil(x.end - 1e-9), start, x.offset, x.finish, '', { critical: true }) });
    lines.push(...jobLines(job, { rows: x.items, sched: x.sched }, start, x.offset, false));
  }
  const html = `<header class="es-head"><div class="es-kicker">Schedule</div><h1>All projects</h1>
    <div class="es-figs"><div class="big"><b>${days ? plural(days, 'working day') : 'Nothing scheduled'}</b><span>${days ? `${fmtDate(workday(start, 0))} to ${fmtDate(lastDay)}` : 'tick projects into the program in ESTIMATE'}</span></div>
      <div><label class="sc-start"><span>Program start</span><input type="date" id="prog-start" value="${esc(start)}"></label></div>
      <div data-last><b>${days ? fmtDate(lastDay) : '–'}</b><span>last day of work</span></div>
      <div><b>${plans.length}</b><span>projects in the program</span></div></div></header>
    ${plans.length ? table(lines, start, days) + `<div class="sc-detail" id="gantt-detail" role="status">Click a line for its dates and slack.</div>` : `<p class="note">Nothing to schedule: tick projects into the program in ESTIMATE, and give scope items days in PROJECTS or draw trim.</p>`}
    <p class="note">Working days, Monday to Friday. Projects run side by side, each from its own start date, unless one is set to start AFTER another. Open a project on the left to change the order of its rooms or what its lines wait for.</p>`;
  return { html, bind: inner => {
    inner.querySelector('#prog-start').onchange = e => { ws.data.settings.programStart = e.target.value; touch(); render(); };
    inner.querySelectorAll('[data-job-after]').forEach(s => s.onchange = () => { const p = projectById(s.dataset.jobAfter); if (!p) return; if (s.value) p.after = s.value; else delete p.after; touch(); render(); });
    bindPick(inner);
  } };
}

function bindPick(inner) {
  const pick = tr => {
    if (!tr) return;
    picked = tr.dataset.key;
    inner.querySelectorAll('#gantt tr.on').forEach(x => x.classList.remove('on'));
    tr.classList.add('on');
    const d = inner.querySelector('#gantt-detail'); if (d) d.textContent = tr.dataset.detail;
  };
  const g = inner.querySelector('#gantt');
  if (!g) return;
  g.onclick = e => { if (e.target.closest('select,button')) return; pick(e.target.closest('tr[data-detail]')); };
  g.onkeydown = e => { if ((e.key === 'Enter' || e.key === ' ') && !e.target.closest('select,button')) { const tr = e.target.closest('tr[data-detail]'); if (tr) { e.preventDefault(); pick(tr); } } };
}
