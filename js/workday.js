import { esc, money } from './bid-issue.js';
import { fmtDate, isoToday } from './store.js';

// A shift refers to rooms by drawing ID so two rooms with the same display name stay distinct.
export function workday(facts, selectedDate, references = {}) {
  const days = facts.shifts;
  if (!days.length) return '';
  const day =
    days.find((d) => d.date === selectedDate) || days.find((d) => d.date >= isoToday()) || days.at(-1);
  const rooms = new Map();
  for (const task of day.tasks) {
    const key = task.roomKey;
    if (!rooms.has(key)) rooms.set(key, { name: task.room, hours: 0, tasks: [] });
    const room = rooms.get(key);
    room.hours += task.hours;
    room.tasks.push({ label: task.phase.endsWith('coat') ? task.phase : task.task, hours: task.hours });
  }
  const assignments = [...rooms]
    .map(([key, room]) => {
      const view = references[key]?.[0],
        url = '#/sheets?section=shop&amp;room=' + encodeURIComponent(key);
      return `<article class="bs-assignment">
      ${view ? `<a class="bs-workview" href="${url}"><img src="${esc(view.image)}" alt="${esc(view.label)}"></a>` : ''}
      <div><header><strong>${esc(room.name)}</strong><span>${room.hours.toFixed(1)} h</span></header>
      <ul>${room.tasks.map((task) => `<li><span>${esc(task.label)}</span><b>${Math.round(task.hours * 60)} min</b></li>`).join('')}</ul>
      <a href="${url}">Room drawing and cut marks ↗</a></div></article>`;
    })
    .join('');
  return `<section class="bs-card bs-workday"><div class="bs-section"><h2>Workday plan</h2>
    <label>Workday <select data-workday>${days.map((d, i) => `<option value="${esc(d.date)}" ${d === day ? 'selected' : ''}>Day ${i + 1} · ${esc(fmtDate(d.date))}</option>`).join('')}</select></label></div>
    <p>${day.hours.toFixed(1)} person-hours · ${esc([...new Set(day.tasks.map((t) => t.phase))].join(' / '))}</p>
    ${assignments}
    <div class="bs-links"><a href="#/schedule?day=${esc(day.date)}">See this day in the Gantt ↗</a><a href="#/documents?package=buy">Materials to order ↗</a></div></section>`;
}

export function laborReview(e, draft) {
  const groups = new Map();
  for (const room of e.rooms)
    for (const t of room.labor) {
      const row = groups.get(t.id) || { ...t, qty: 0, extended: 0 };
      row.qty += t.qty;
      row.extended += t.extended;
      groups.set(t.id, row);
    }
  const rows = [...groups.values()].sort((a, b) => b.extended - a.extended);
  if (!rows.length) return '';
  const choices = rows.filter((t) => e.tasks.some((task) => task.id === t.id));
  return `<section class="bs-card"><h2>Where the hours go</h2><div class="bs-table-scroll"><table><thead><tr>
  <th>Operation</th><th>Quantity</th><th>Labor</th><th>Labor cost</th></tr></thead><tbody>
  ${rows
    .map(
      (
        t,
      ) => `<tr><td><details><summary>${esc(t.label)}</summary><p>${esc(t.basis || 'Project allowance')}${draft.observations?.[t.id] ? ' · ' + esc(draft.observations[t.id]) : ''}</p></details></td>
  <td>${t.qty.toLocaleString('en-US', { maximumFractionDigits: 1 })} ${esc(t.unit || t.per)}</td><td>${t.extended.toFixed(1)} h</td><td>${money(t.extended * e.rules.rate)}</td></tr>`,
    )
    .join('')}</tbody></table></div>
  ${
    choices.length
      ? `<details class="bs-sample"><summary>Test a measured pace</summary><p>Enter a timed sample to see how that pace would change the whole job.</p>
    <form data-sample><div class="bs-fields"><label>Operation<select name="task">${choices.map((t) => `<option value="${esc(t.id)}">${esc(t.label)} (${esc(t.unit || t.per)})</option>`).join('')}</select></label>
    <label>Units completed<input type="number" name="units" required min="0.0001" step="any"></label><label>Person-minutes worked<input type="number" name="minutes" required min="0.0001" step="any"></label></div>
    <button class="btn" type="submit">Preview impact</button><output aria-live="polite"></output></form></details>`
      : ''
  }</section>`;
}
