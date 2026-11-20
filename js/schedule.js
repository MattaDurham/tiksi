// SCHEDULE: when the work happens, in working days (Monday to Friday).
//
// A job (a top-level project with its subprojects) is laid out by job.js: one carpenter does the
// drawn trim room after room, in the order the subprojects are listed (move a room up or down
// here); every scope item with days runs on its own unless it is set to start AFTER another line.
// ALL PROJECTS lays the jobs in the program side by side from the program start, each from its own
// start date, or after the job it is set to follow (program.js).
//
// One table: the work, who does it, its days and dates, what it waits for, and a chart of working
// days beside it (weekends are left out, so a bar's length is its days). Tap or click a line or any
// of its numbers for its dates and slack in the column on the right, where the number can be changed
// for that one line or everywhere it appears in the project: a room's days (its tasks scale to fit),
// a task's hours each, quantity or hours, a scope item's days. Drag a bar to change its days; drag
// across the calendar to stretch it (each day, then each hour, gets its own mark), FIT to undo that.

import { ws, touch, onChange, activeProperty, propertyProjects, projectById, escapeHtml, fmtDate, isoToday } from './store.js';
import { programSchedule, workday, workdaysBetween } from './program.js';
import { jobOf, rootOf, setRoomDays, setRoomLabor } from './job.js';
import { restoreProjectEdit } from './project-history.js';
import { icon } from './icons.js';

const esc = escapeHtml;
// Whole dollars everywhere on the page, so a column reads alike; a single board's price keeps its cents.
const fm = v => (v < 0 ? '-' : '') + '$' + Math.abs(Math.round(Number(v) || 0)).toLocaleString('en-US');
const hrs = v => (Math.round((Number(v) || 0) * 10) / 10).toFixed(1);
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many || one + 's');
let el = null, off = null, timer = null, picked = '', focusField = '';
let lineByKey = new Map(), viewJob = null;   // the lines drawn last, for the detail column
let userW = 0;   // a day's width stretched by hand (0: fit the page)
try { userW = Number(localStorage.getItem('tiksi.schedule.dayw')) || 0; } catch { /* not kept */ }
let afterDrag = false;   // a drag ends with a click that must not pick
const opened = new Set();   // rooms shown with their tasks (double-click a room's line)
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
  picked = ''; focusField = ''; fitW = 0; render();
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
  const scroll = el.querySelector('.sc-main')?.scrollTop || 0, across = el.querySelector('#gantt')?.scrollLeft || 0;
  const nav = `<nav class="es-nav" aria-label="Jobs">
    <a class="es-job ${t.program ? 'here' : ''}" href="#/schedule?program" data-program><span>All projects</span></a>
    <div class="gl">Projects</div>
    ${tops.map(p => { const j = jobOf(p); return `<a class="es-job ${t.id === p.id ? 'here' : ''}" href="#/schedule?project=${encodeURIComponent(p.id)}" data-job="${esc(p.id)}"><span>${esc(p.name || 'Project')}</span><span class="m">${j.schedule.days ? plural(j.schedule.days, 'day') : ''}</span></a>`; }).join('') || '<p class="note">No projects yet.</p>'}
  </nav>`;
  el.innerHTML = `<div class="sc">${nav}<main class="sc-main"><div class="sc-in" id="sc-in"></div></main>
    <aside class="es-det sc-det" aria-label="Details"><div class="es-dbar"><span class="crumb" id="sc-crumb">Details</span><button type="button" data-close aria-label="Close">×</button></div><div class="es-dbody" id="sc-dbody"></div></aside></div>`;
  el.querySelector('[data-close]').onclick = () => { picked = ''; focusField = ''; render(); };
  el.querySelector('[data-program]').onclick = e => { e.preventDefault(); go({ program: true }); };
  el.querySelectorAll('[data-job]').forEach(a => a.onclick = e => { e.preventDefault(); go({ id: a.dataset.job }); });
  const inner = el.querySelector('#sc-in');
  const view = t.program ? programView(prop) : jobView(projectById(t.id));
  inner.innerHTML = view.html;
  view.bind(inner);
  el.querySelector('.sc-main').scrollTop = scroll;
  const g = inner.querySelector('#gantt'), axis = g && g.querySelector('th.axis');
  if (g) g.scrollLeft = across;
  paintDetail();
  // Days as wide as the page allows (9 to 56 pixels): measure where the chart starts and draw again.
  if (g && axis && !fitting && !userW) {
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
  const dayW = userW || fitW || Math.max(9, Math.min(56, Math.floor(avail / (Math.max(span, 5) + 1))));
  const cols = Math.max(span, 5) + 1, W = cols * dayW;
  // Stretched, every day gets its date; wider still, each of its 6 productive hours a mark.
  const days = dayW >= 44, hours = dayW >= 120;
  let axis = '', grid = '';
  for (let n = 0; n < cols; n++) {
    const iso = workday(origin, n), dt = new Date(iso + 'T00:00'), mon = dt.getDay() === 1 || n === 0;
    if (days) axis += `<span class="sc-wk ${mon ? '' : 'day'}" style="left:${n * dayW}px">${esc(dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase())}<small>${dt.toLocaleDateString('en-US', { weekday: 'short' })}${hours ? ' · 6 hrs' : ''}</small></span>`;
    else if (mon) axis += `<span class="sc-wk" style="left:${n * dayW}px">${esc(dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase())}<small>${dt.toLocaleDateString('en-US', { weekday: 'short' })}</small></span>`;
    grid += `<span class="sc-col ${mon ? 'wk' : ''}" style="left:${n * dayW}px"></span>`;
  }
  const todayLine = today >= 0 && today < cols ? `<span class="sc-today" style="left:${today * dayW}px" title="Today"></span>` : '';
  const y0 = workday(origin, 0).slice(0, 4);
  const date = n => { const iso = workday(origin, n), dt = new Date(iso + 'T00:00'); return dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', ...(iso.slice(0, 4) !== y0 ? { year: 'numeric' } : {}) }); };
  const row = l => {
    const x0 = l.es * dayW, w = Math.max((l.ef - l.es) * dayW - 2, 3);
    const tw0 = Math.max(l.w * dayW - 2, 3);
    const drag = l.edit && (l.kind === 'trim' || l.kind === 'item') ? ` data-bar="${esc(l.key)}" data-days="${l.days}" title="Drag to change its days"` : '';
    const text = l.kind === 'trim' ? (w >= 110 ? `${l.days}d · ${hrs(l.hours)} h` : w >= 26 ? l.days + 'd' : '') : w >= 26 ? l.days + 'd' : '';
    const bar = l.kind === 'job' ? `<span class="sc-bar job" style="left:${x0}px;width:${w}px"></span>`
      : l.kind === 'task' ? `<span class="sc-bar task" data-num="hours" style="left:${x0 + 1}px;width:${tw0}px">${tw0 >= 70 ? esc(`${l.label}, ${hrs(l.hours)} h`) : ''}</span>`
      : `<span class="sc-bar ${l.kind === 'trim' ? 'trim' : l.critical ? 'crit' : ''}" data-num="days"${drag} style="left:${x0 + 1}px;width:${w}px">${esc(text)}</span>${l.slack > 0.001 ? `<span class="sc-slack" style="left:${x0 + w + 2}px;width:${l.slack * dayW - 2}px"></span>` : ''}`;
    const tw = l.kind === 'trim' ? `<button type="button" class="sc-tw" data-open-room="${esc(l.key)}" aria-expanded="${opened.has(l.key)}" aria-label="${opened.has(l.key) ? 'Hide' : 'Show'} the tasks">${opened.has(l.key) ? '▾' : '▸'}</button>` : l.kind === 'job' ? '' : '<span class="sc-tw"></span>';
    return `<tr class="${l.kind === 'job' ? 'job' : l.kind === 'task' ? 'g-item g-task' : 'g-item'} ${picked === l.key ? 'on' : ''}" data-key="${esc(l.key)}" data-detail="${esc(l.detail)}" tabindex="0" ${l.kind === 'trim' ? 'title="Double-click for its tasks"' : ''}>
      <td class="sticky work" title="${esc(l.label)}">${tw}${esc(l.label)}</td><td class="num lk" data-num="${l.kind === 'task' ? 'hours' : 'days'}">${l.kind === 'task' ? hrs(l.hours) + ' h' : l.days}${l.set ? '<i class="sc-set" title="Set by hand">•</i>' : ''}</td>
      <td class="dim lk" data-num="dates">${date(Math.floor(l.es + 1e-9))}</td><td class="dim lk" data-num="dates">${date(Math.max(Math.floor(l.es + 1e-9), Math.ceil(l.ef - 1e-9) - 1))}</td><td>${l.after || ''}</td><td>${l.move || ''}</td>
      <td class="bars">${grid}${todayLine}${bar}</td></tr>`;
  };
  return `<div class="sc-grid ${hours ? 'hours' : ''}" id="gantt" data-cols="${cols}" data-dayw="${dayW}" style="--chart-w:${W}px;--hour-w:${dayW / 6}px"><table class="sc-tab"><thead><tr><th class="sticky">Work</th><th class="num">Days</th><th>Starts</th><th>Ends</th><th>After</th><th></th><th class="axis">${axis}</th></tr></thead>
    <tbody>${lines.map(row).join('')}</tbody></table></div>`;
}

// A room's tasks in the order the carpenter does them, laid across the room's days by their hours.
function taskLines(r, es, ef, origin, edit) {
  const labor = (r.room.trim || []).flatMap(x => x.labor || []);
  const total = labor.reduce((n, l) => n + l.hours, 0) || 1, span = ef - es;
  let at = 0;
  return labor.map(l => {
    const a = es + span * at / total; at += l.hours;
    const b = es + span * at / total;
    return { key: r.id + '|' + l.task, kind: 'task', label: l.label, days: '', hours: l.hours, es: a, ef: b, w: b - a, slack: 0, after: '', move: '', edit, room: r.room, labor: l, set: l.qtySet || l.eachSet === 'room',
      detail: `${r.name}, ${l.label}: ${hrs(l.hours)} hours (${fmtQ(l.qty)} ${Math.abs(l.qty - 1) < 1e-9 ? l.unitOne || l.unit : l.unit} at ${+l.rate.toFixed(4)} hrs each), about ${fmtDate(workday(origin, Math.floor(a + 1e-9)))}${Math.ceil(b - 1e-9) - 1 > Math.floor(a + 1e-9) ? ' to ' + fmtDate(workday(origin, Math.ceil(b - 1e-9) - 1)) : ''}. Setup and cleanup happen each day; they are shown once.` };
  });
}
const fmtQ = q => Math.abs(q - Math.round(q)) < 1e-9 ? String(Math.round(q)) : (Math.round(q * 10) / 10).toString();

const detailOf = (label, days, origin, es, ef, extra, s) =>
  `${label}: ${plural(days, 'working day')}, ${fmtDate(workday(origin, es))} to ${fmtDate(workday(origin, Math.max(es, Math.ceil(ef - 1e-9) - 1)))}, ${s && s.critical ? 'on the critical path' : 'slack ' + plural(Math.round((s ? s.slack : 0) * 10) / 10, 'day')}${extra ? '; ' + extra : ''}`;

// The lines of one job, from `shift` working days after `origin`.
function jobLines(job, sched, origin, shift, editable) {
  const rows = sched.rows, S = sched.sched;
  const options = (self, current) => `<option value="">Start</option>` + rows.filter(r => r.id !== self).map(r => `<option value="${esc(r.id)}" ${current === r.id ? 'selected' : ''}>${esc(r.kind === 'trim' ? r.name + ' trim' : r.name)}</option>`).join('');
  const trims = rows.filter(r => r.kind === 'trim');
  return rows.flatMap(r => {
    const s = S[r.id], first = trims[0] === r;
    let after = '';
    if (editable && r.kind === 'item') after = `<select data-after="${esc(r.id)}" aria-label="${esc(r.name)} starts after">${options(r.id, (r.deps || [])[0] || '')}</select>`;
    else if (editable && first) after = `<select data-trim-after aria-label="The trim starts after">${options(r.id, r.deps[0] || '').replace(/<option value="trim:[^"]*"[^>]*>[^<]*<\/option>/g, '')}</select>`;
    else if (r.kind === 'trim') after = `<span class="dim">the room before</span>`;
    const i = trims.indexOf(r), sub = r.kind === 'trim' && r.room.project !== job.root;
    const move = editable && sub ? `<button class="sc-move" data-move="${esc(r.room.project.id)}" data-dir="-1" ${i <= 0 ? 'disabled' : ''} aria-label="Do ${esc(r.name)} sooner">↑</button><button class="sc-move" data-move="${esc(r.room.project.id)}" data-dir="1" ${i === trims.length - 1 ? 'disabled' : ''} aria-label="Do ${esc(r.name)} later">↓</button>` : '';
    const label = r.kind === 'trim' ? r.name + ': trim' : (r.room ? r.room.name + ': ' : '') + r.name;
    const daysSet = r.kind === 'trim' && (r.room.trim || []).some(x => x.daysSet);
    const line = { key: r.id, kind: r.kind, label, crew: r.crew || (r.kind === 'trim' ? 'Carpenter' : ''), days: r.durationDays, hours: r.hours, es: shift + s.es, ef: shift + s.ef, w: s.ef - s.es, slack: s.slack, critical: s.critical, after, move,
      edit: editable, room: r.room, item: r.item, project: r.project, set: daysSet,
      detail: detailOf(label, r.durationDays, origin, shift + s.es, shift + s.ef, r.kind === 'trim' ? hrs(r.hours) + ' carpenter hours; double-click for its tasks' : '', s) };
    return r.kind === 'trim' && opened.has(r.id) ? [line, ...taskLines(r, shift + s.es, shift + s.ef, origin, editable)] : [line];
  });
}

function jobView(root) {
  const job = jobOf(root), sched = job.schedule;
  const origin = root.startDate || ws.data.settings.programStart || isoToday();
  const lines = jobLines(job, sched, origin, 0, true);
  keep(lines, job);
  const html = `<header class="es-head"><div class="es-kicker">Schedule</div><h1>${esc(root.name || 'Project')}</h1>
    <div class="es-acts"><label class="sc-start sc-inline"><span>Starts</span><input type="date" id="job-start" value="${esc(origin)}"></label><a class="btn small" href="#/estimate?project=${encodeURIComponent(root.id)}">${icon('budget')}ESTIMATE</a>${fitButton()}</div></header>
    ${sched.rows.length ? table(lines, origin, sched.days) : '<p class="note">Nothing to schedule yet.</p>'}
    ${sched.cyclic ? '<p class="note">Some lines wait for each other in a loop; those links are left out.</p>' : ''}
    <p class="note">Working days, Monday to Friday. The carpenter does the rooms one after another, in the order shown: move a room with the arrows, and double-click a room (or its ▸) for its tasks in order. A scope item starts with the job unless you choose what it starts AFTER. A room's days come from its hours at 6 productive hours a day. Click any number to change it here or everywhere it appears; drag a bar to change its days; drag across the calendar to stretch it.</p>`;
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
  const { plans, days } = programSchedule(propertyProjects(), start);
  const lines = [];
  for (const x of plans) {
    const job = jobOf(x.p);
    const others = plans.filter(y => y !== x).map(y => `<option value="${esc(y.p.id)}" ${x.p.after === y.p.id ? 'selected' : ''}>${esc(y.p.name)}</option>`).join('');
    lines.push({ key: 'job:' + x.p.id, kind: 'job', label: x.p.name || 'Project', crew: '', days: Math.ceil(x.end - 1e-9), es: x.offset, ef: x.finish, slack: 0,
      after: `<select data-job-after="${esc(x.p.id)}" aria-label="${esc(x.p.name)} starts after"><option value="">Its start date</option>${others}</select>`, move: '',
      detail: detailOf(x.p.name || 'Project', Math.ceil(x.end - 1e-9), start, x.offset, x.finish, '', { critical: true }) });
    lines.push(...jobLines(job, { rows: x.items, sched: x.sched }, start, x.offset, false));
  }
  keep(lines, null);
  const html = `<header class="es-head"><div class="es-kicker">Schedule</div><h1>All projects</h1>
    <div class="es-acts"><label class="sc-start sc-inline"><span>Program start</span><input type="date" id="prog-start" value="${esc(start)}"></label>${fitButton()}</div></header>
    ${plans.length ? table(lines, start, days) : `<p class="note">Nothing to schedule: tick projects into the program in ESTIMATE, and give scope items days in ESTIMATE or draw trim.</p>`}
    <p class="note">Working days, Monday to Friday. Projects run side by side, each from its own start date, unless one is set to start AFTER another. Open a project on the left to change the order of its rooms, what its lines wait for, or any of their numbers. Drag across the calendar to stretch it.</p>`;
  return { html, bind: inner => {
    inner.querySelector('#prog-start').onchange = e => { ws.data.settings.programStart = e.target.value; touch(); render(); };
    inner.querySelectorAll('[data-job-after]').forEach(s => s.onchange = () => { const p = projectById(s.dataset.jobAfter); if (!p) return; if (s.value) p.after = s.value; else delete p.after; touch(); render(); });
    bindPick(inner);
  } };
}

const fitButton = () => userW ? '<button type="button" class="btn small" data-fit title="Back to the width that fits the page">FIT</button>' : '';
function keep(lines, job) { lineByKey = new Map(lines.map(l => [l.key, l])); viewJob = job; }
function setZoom(w) { userW = w; try { if (w) localStorage.setItem('tiksi.schedule.dayw', String(w)); else localStorage.removeItem('tiksi.schedule.dayw'); } catch { /* fine */ } }

function bindPick(inner) {
  const g = inner.querySelector('#gantt');
  inner.querySelector('[data-fit]')?.addEventListener('click', () => { setZoom(0); fitW = 0; render(); });
  if (!g) return;
  const pick = (tr, field) => {
    if (!tr) return;
    picked = tr.dataset.key; focusField = field || '';
    render();   // the detail column opens, and the chart fits what is left
  };
  const toggle = key => { if (opened.has(key)) opened.delete(key); else opened.add(key); picked = key; render(); };
  g.onclick = e => {
    if (afterDrag) { afterDrag = false; return; }
    const b = e.target.closest('[data-open-room]'); if (b) { toggle(b.dataset.openRoom); return; }
    if (e.target.closest('select,button')) return;
    pick(e.target.closest('tr[data-detail]'), e.target.closest('[data-num]')?.dataset.num);
  };
  g.ondblclick = e => { if (e.target.closest('select,button,[data-bar]')) return; const tr = e.target.closest('tr[data-key^="trim:"]'); if (tr && !tr.classList.contains('g-task')) toggle(tr.dataset.key); };
  g.onkeydown = e => { if ((e.key === 'Enter' || e.key === ' ') && !e.target.closest('select,button')) { const tr = e.target.closest('tr[data-detail]'); if (tr) { e.preventDefault(); pick(tr); } } };
  g.onpointerdown = e => {
    if (e.button !== 0 || e.target.closest('select,button,input')) return;
    const bar = e.target.closest('[data-bar]');
    if (bar) return dragBar(e, bar, Number(g.dataset.dayw));
    if (e.target.closest('td.bars, th.axis')) return dragZoom(e, g);
  };
}

// Drag a room's or an item's bar: its end follows the pointer, a whole day at a time.
function dragBar(e, bar, dayW) {
  const x0 = e.clientX, w0 = bar.getBoundingClientRect().width, d0 = Number(bar.dataset.days) || 1;
  let days = d0, moved = false;
  const move = ev => {
    const dx = ev.clientX - x0;
    if (!moved && Math.abs(dx) < 4) return;
    moved = true;
    days = Math.max(1, Math.round(d0 + dx / dayW));
    bar.style.width = Math.max(3, w0 + (days - d0) * dayW) + 'px';
    bar.textContent = days + 'd';
    bar.classList.add('dragging');
  };
  const up = () => {
    removeEventListener('pointermove', move); removeEventListener('pointerup', up);
    if (!moved) return;
    afterDrag = true; setTimeout(() => { afterDrag = false; }, 0);
    const l = lineByKey.get(bar.dataset.bar);
    picked = bar.dataset.bar; focusField = 'days';
    if (l && days !== d0) apply(l, 'days', days, 'one'); else render();
  };
  addEventListener('pointermove', move); addEventListener('pointerup', up);
}

// Drag across the calendar to stretch it (right) or squeeze it (left): 150 pixels doubles a day's
// width; the day under the pointer stays under it.
function dragZoom(e, g) {
  const axis = g.querySelector('th.axis'); if (!axis) return;
  const w0 = Number(g.dataset.dayw), x0 = e.clientX;
  const gx = g.getBoundingClientRect().left, chart0 = axis.getBoundingClientRect().left;
  const day = (x0 - chart0) / w0, at = x0 - gx;
  let moved = false, frame = 0;
  const move = ev => {
    const dx = ev.clientX - x0;
    if (!moved && Math.abs(dx) < 4) return;
    moved = true;
    const w = Math.round(Math.max(6, Math.min(480, w0 * 2 ** (dx / 150))));
    if (w === userW) return;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      setZoom(w); render();
      const ng = el && el.querySelector('#gantt'), na = ng && ng.querySelector('th.axis');
      if (ng && na) ng.scrollLeft = na.offsetLeft + day * w - at;
    });
  };
  const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); if (moved) { afterDrag = true; setTimeout(() => { afterDrag = false; }, 0); } };
  addEventListener('pointermove', move); addEventListener('pointerup', up);
}

// ---------- the detail column: a line's dates, and its numbers to change ----------
const fieldHtml = (f, label, value, unit, buttons, note) => `<div class="sc-field" data-field="${f}"><label><span>${esc(label)}</span><span class="sc-in"><input type="number" min="0" step="any" inputmode="decimal" data-f="${f}" value="${value}">${unit ? `<i>${esc(unit)}</i>` : ''}</span></label>
  <div class="sc-apply">${buttons.map(([scope, text]) => `<button type="button" class="btn small" data-apply="${f}|${scope}">${esc(text)}</button>`).join('')}</div>${note ? `<p class="note">${note}</p>` : ''}</div>`;
const roomsWithTrim = () => viewJob ? viewJob.rooms.filter(r => r.trim.length) : [];
const sameItems = it => viewJob ? viewJob.tree.flatMap(x => x.items || []).filter(y => (y.name || '').trim().toLowerCase() === (it.name || '').trim().toLowerCase() && (Number(y.durationDays) || 0) > 0) : [];

function paintDetail() {
  const body = el && el.querySelector('#sc-dbody'); if (!body) return;
  const l = lineByKey.get(picked);
  el.querySelector('.sc').classList.toggle('det-open', !!l);
  el.querySelector('#sc-crumb').textContent = l ? ({ trim: 'Room', task: 'Task', item: 'Scope item', job: 'Project' }[l.kind] || 'Line') : 'Details';
  if (!l) { body.innerHTML = '<div class="sc-detail" id="gantt-detail" role="status">Click a line or any number for its dates and slack, and to change it.</div>'; return; }
  let html = `<div class="d-title">${esc(l.label)}</div><div class="sc-detail" id="gantt-detail" role="status">${esc(l.detail)}</div>`;
  if (!l.edit) html += l.kind === 'job' || !viewJob ? `<p class="note">Open the project on the left to change its numbers.</p>` : '';
  else if (l.kind === 'trim') {
    const t = l.room.trim || [], counted = t.reduce((n, x) => n + (x.daysCounted || 0), 0), scale = t[0] && t[0].scale;
    const others = roomsWithTrim().length > 1;
    html += fieldHtml('days', 'Days', l.days, 'working days', [['one', 'THIS ROOM'], ...(others ? [['all', 'EVERY ROOM']] : [])],
      l.set ? `Set by hand; its hours count ${plural(counted, 'day')}. Every task's time is ×${(Math.round(scale * 100) / 100).toFixed(2)} so the work fills ${plural(l.days, 'day')}, and the labor follows. <button type="button" class="btn small ghost" data-reset="days">BACK TO ${counted}</button>`
        : `Counted from its ${hrs(l.hours)} hours at 6 productive hours a day. Set it and every task's time scales to fit, so the labor follows.`);
    const labor = t.flatMap(x => x.labor || []);
    html += `<h4>Its tasks</h4><ul class="sc-tasks">${labor.map(x => `<li><a class="dl" data-pick-task="${esc(l.key + '|' + x.task)}">${esc(x.label)}</a>: ${hrs(x.hours)} h</li>`).join('')}</ul>`;
  } else if (l.kind === 'task') {
    const x = l.labor, others = roomsWithTrim().filter(r => r.trim.some(y => (y.labor || []).some(z => z.task === x.task))).length > 1;
    const unit = Math.abs(x.qty - 1) < 1e-9 ? x.unitOne || x.unit : x.unit;
    const scaled = x.scaled ? ` The room's days are set, so it counts ×${(Math.round(x.rate / x.own * 100) / 100).toFixed(2)}: ${+x.rate.toFixed(4)} each.` : '';
    html += fieldHtml('each', 'Hours each', +(x.own ?? x.rate).toFixed(4), 'hrs per ' + (x.unitOne || x.unit), [['one', 'THIS ROOM'], ...(others ? [['all', 'EVERY ROOM']] : [])],
      `${x.eachSet === 'room' ? 'Typed for this room' : x.eachSet === 'who' ? 'The carpenter\'s own time' : 'The published time'} (published ${x.published}).${scaled}`);
    html += fieldHtml('qty', 'Quantity', +(+x.qty).toFixed(2), unit, [['one', 'THIS ROOM']], x.qtySet ? `Typed; the drawing counts ${+(+x.counted).toFixed(2)}.` : 'Counted from the drawing.');
    html += fieldHtml('hours', 'Hours', hrs(x.hours), 'hrs', [['one', 'THIS ROOM']], 'Sets the hours each to these hours over the quantity.');
    if (l.set) html += `<p><button type="button" class="btn small ghost" data-reset="task">BACK TO THE COUNT AND THE ${x.eachSet === 'who' ? 'CARPENTER\'S' : 'PUBLISHED'} TIME</button></p>`;
  } else if (l.kind === 'item' && l.item) {
    const same = sameItems(l.item);
    html += fieldHtml('idays', 'Days', l.days, 'working days', [['one', 'THIS ITEM'], ...(same.length > 1 ? [['all', `ALL ${same.length} NAMED "${(l.item.name || '').toUpperCase()}"`]] : [])], 'Typed on the item in ESTIMATE too.');
  }
  body.innerHTML = html;
  body.querySelectorAll('[data-apply]').forEach(b => b.onclick = () => {
    const [f, scope] = b.dataset.apply.split('|'), input = body.querySelector(`[data-f="${f}"]`);
    if (!apply(l, f, input.value, scope)) { input.setCustomValidity('Type a number of 0 or more' + (f === 'days' ? ' (whole days, at least 1)' : '')); input.reportValidity(); }
  });
  body.querySelectorAll('input[data-f]').forEach(i => { i.oninput = () => i.setCustomValidity(''); i.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); body.querySelector(`[data-apply^="${i.dataset.f}|"]`)?.click(); } }; });
  body.querySelector('[data-reset="days"]')?.addEventListener('click', () => { setRoomDays(viewJob.root, l.room.key, null); touch(); render(); });
  body.querySelector('[data-reset="task"]')?.addEventListener('click', () => { setRoomLabor(viewJob.root, l.room.key, 'qty', l.labor.task, null); setRoomLabor(viewJob.root, l.room.key, 'each', l.labor.task, null); touch(); render(); });
  body.querySelectorAll('[data-pick-task]').forEach(a => a.onclick = () => { opened.add(l.key); picked = a.dataset.pickTask; focusField = 'each'; render(); });
  const f = { days: 'days', hours: l.kind === 'task' ? 'each' : l.kind === 'item' ? 'idays' : 'days', dates: '' }[focusField] ?? '';
  const input = f && body.querySelector(`[data-f="${f}"]`);
  if (input) { input.focus({ preventScroll: true }); input.select(); }
}

// Change one number on this line (scope 'one') or on every line it appears on in the project ('all').
function apply(l, f, value, scope) {
  const v = Number(value);
  if (value === '' || !Number.isFinite(v) || v < 0) return false;
  const root = viewJob && viewJob.root; if (!root) return false;
  if (f === 'days') {
    if (v < 1) return false;
    const keys = scope === 'all' ? roomsWithTrim().map(r => r.key) : [l.room.key];
    for (const k of keys) setRoomDays(root, k, v);
  } else if (f === 'each') {
    const keys = scope === 'all' ? roomsWithTrim().filter(r => r.trim.some(y => (y.labor || []).some(z => z.task === l.labor.task))).map(r => r.key) : [l.room.key];
    for (const k of keys) setRoomLabor(root, k, 'each', l.labor.task, v);
  } else if (f === 'qty') setRoomLabor(root, l.room.key, 'qty', l.labor.task, v);
  else if (f === 'hours') {
    if (!(l.labor.qty > 0)) return false;
    setRoomLabor(root, l.room.key, 'each', l.labor.task, v / l.labor.qty);
  } else if (f === 'idays') {
    for (const it of scope === 'all' ? sameItems(l.item) : [l.item]) it.durationDays = v;
  } else return false;
  touch(); render();
  return true;
}
