// Schedule view: critical-path method (CPM) over each selected project's scope items,
// rendered as an SVG Gantt. Forward/backward pass, slack, dependency arrows.

import {
  ws, touch, escapeHtml, fmtDate, addDays, dayDiff, isoToday,
} from './store.js';

let el = null;
export function mount(root) { el = root; render(); }
export function unmount() { el = null; }

// ---------- CPM ----------
export function cpm(items) {
  // items: [{id, durationDays, deps[]}] -> map id -> {es, ef, ls, lf, slack, critical}
  const sched = {}, byId = {};
  const list = items.filter(i => (i.durationDays || 0) > 0);
  for (const it of list) byId[it.id] = it;

  // Kahn topological order (ignore deps outside this project or on zero-duration items).
  const indeg = {}, succs = {};
  for (const it of list) {
    const deps = (it.deps || []).filter(d => byId[d]);
    indeg[it.id] = deps.length;
    for (const d of deps) (succs[d] = succs[d] || []).push(it.id);
  }
  const queue = list.filter(i => !indeg[i.id]).map(i => i.id);
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const s of succs[id] || []) if (--indeg[s] === 0) queue.push(s);
  }
  const cyclic = order.length < list.length;
  if (cyclic) for (const it of list) if (!order.includes(it.id)) order.push(it.id); // degrade gracefully

  // Forward pass.
  for (const id of order) {
    const it = byId[id];
    const deps = (it.deps || []).filter(d => sched[d]);
    const es = deps.length ? Math.max(...deps.map(d => sched[d].ef)) : 0;
    sched[id] = { es, ef: es + it.durationDays };
  }
  const end = Math.max(0, ...Object.values(sched).map(s => s.ef));

  // Backward pass.
  for (const id of [...order].reverse()) {
    const ss = (succs[id] || []).filter(s => sched[s]);
    const lf = ss.length ? Math.min(...ss.map(s => sched[s].ls)) : end;
    sched[id].lf = lf;
    sched[id].ls = lf - byId[id].durationDays;
    sched[id].slack = sched[id].ls - sched[id].es;
    sched[id].critical = sched[id].slack < 0.001;
  }
  return { sched, end, cyclic };
}

// ---------- render ----------
function render() {
  if (!el) return;
  const d = ws.data;
  const start = d.settings.programStart || isoToday();
  const projects = d.projects.filter(p => p.selected && p.items.some(i => (i.durationDays || 0) > 0));

  // Compute per-project schedules and program span.
  const plans = projects.map(p => {
    const offset = p.startDate && dayDiff(start, p.startDate) > 0 ? dayDiff(start, p.startDate) : 0;
    const { sched, end, cyclic } = cpm(p.items);
    return { p, offset, sched, end, cyclic, finish: offset + end };
  });
  const programEnd = Math.max(7, ...plans.map(x => x.finish));

  el.innerHTML = `
    <div class="view-scroll">
      <div class="view-head">
        <span class="view-title">SCHEDULE</span>
        <span class="view-sub">critical path per selected project; items with 0 days are budget-only and not scheduled</span>
      </div>
      <div class="kpi-band">
        <div class="kpi">
          <div class="k-label">Program start</div>
          <div class="k-value" style="font-size:15px"><input type="date" id="prog-start" value="${start}"
            style="background:transparent;border:none;color:var(--ink);font:inherit;outline:none;color-scheme:dark"></div>
        </div>
        <div class="kpi accent">
          <div class="k-label">Program finish</div>
          <div class="k-value" style="font-size:15px">${fmtDate(addDays(start, programEnd))}</div>
          <div class="k-sub">${programEnd} calendar days</div>
        </div>
        <div class="kpi">
          <div class="k-label">Projects scheduled</div>
          <div class="k-value">${plans.length}</div>
          <div class="k-sub">of ${d.projects.filter(p => p.selected).length} selected</div>
        </div>
      </div>
      <div class="legend" style="margin-bottom:10px">
        <span><span class="sw" style="background:var(--accent)"></span>critical path</span>
        <span><span class="sw" style="background:#3d5468"></span>float available</span>
        <span><span class="sw" style="background:transparent;border-top:2px dashed var(--faint); height:0"></span>slack window</span>
        <span><span class="sw" style="background:var(--red); width:2px"></span>today</span>
      </div>
      <div class="gantt-wrap" id="gantt"></div>
      ${plans.map(x => criticalPathLine(x)).join('')}
      ${plans.length === 0 ? '<p class="muted" style="margin-top:14px">No schedulable work. Select projects in BUDGET and give scope items durations and dependencies in PROJECTS.</p>' : ''}
    </div>`;

  el.querySelector('#prog-start').onchange = e => {
    d.settings.programStart = e.target.value;
    touch(); render();
  };

  if (plans.length) el.querySelector('#gantt').innerHTML = ganttSvg(plans, start, programEnd);
}

function criticalPathLine(x) {
  const names = x.p.items
    .filter(i => x.sched[i.id] && x.sched[i.id].critical)
    .sort((a, b) => x.sched[a.id].es - x.sched[b.id].es)
    .map(i => escapeHtml(i.name));
  if (!names.length) return '';
  return `<div class="mono" style="font-size:11px; margin-top:10px; color:var(--dim)">
    <span style="color:var(--accent)">CRITICAL / ${escapeHtml(x.p.name).toUpperCase()}:</span>
    ${names.join(' <span style="color:var(--faint)">&gt;</span> ')}
    ${x.cyclic ? ' <span style="color:var(--red)">(dependency cycle detected; some links ignored)</span>' : ''}
  </div>`;
}

function ganttSvg(plans, startIso, programEnd) {
  const LABELW = 236, AXISH = 30, ROWH = 24, PROJH = 28, GAP = 10, PAD = 8;
  const span = programEnd + 7;
  const dayW = span <= 45 ? 18 : span <= 90 ? 11 : span <= 180 ? 6.5 : span <= 365 ? 3.4 : 1.8;
  const width = LABELW + span * dayW + 20;

  let rows = [];
  for (const x of plans) {
    rows.push({ kind: 'proj', x });
    for (const it of x.p.items) {
      if (x.sched[it.id]) rows.push({ kind: 'item', x, it });
    }
  }
  const height = AXISH + rows.reduce((h, r) => h + (r.kind === 'proj' ? PROJH + GAP : ROWH), 0) + PAD * 2;

  const X = day => LABELW + day * dayW;
  let svg = `<svg class="gantt-svg" width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">`;
  svg += `<rect width="${width}" height="${height}" fill="#12181d"/>`;

  // Week/month grid + axis labels.
  for (let day = 0; day <= span; day++) {
    const iso = addDays(startIso, day);
    const dt = new Date(iso + 'T00:00');
    const isWeek = dt.getDay() === 1, isMonth = dt.getDate() === 1;
    if (dayW >= 6 ? isWeek : isMonth) {
      svg += `<line x1="${X(day)}" y1="${AXISH}" x2="${X(day)}" y2="${height - PAD}" stroke="#1d262e" stroke-width="1"/>`;
    }
    if (isMonth || (day === 0)) {
      svg += `<text x="${X(day) + 3}" y="19" fill="#8b9aa7" font-size="10">${dt.toLocaleDateString('en-US', { month: 'short' })}${dt.getMonth() === 0 || day === 0 ? ' ' + dt.getFullYear() : ''}</text>`;
    }
  }
  // Today.
  const today = dayDiff(startIso, isoToday());
  if (today >= 0 && today <= span) {
    svg += `<line x1="${X(today)}" y1="${AXISH}" x2="${X(today)}" y2="${height - PAD}" stroke="#e05252" stroke-width="1.5" stroke-dasharray="2,3"/>`;
  }
  svg += `<line x1="0" y1="${AXISH}" x2="${width}" y2="${AXISH}" stroke="#232e37"/>`;
  svg += `<line x1="${LABELW - 10}" y1="0" x2="${LABELW - 10}" y2="${height}" stroke="#232e37"/>`;

  // Rows.
  let y = AXISH + PAD;
  const barPos = {}; // itemId -> {x0,x1,yc} for arrows
  for (const r of rows) {
    if (r.kind === 'proj') {
      y += GAP;
      const { p } = r.x;
      svg += `<text x="10" y="${y + 17}" fill="#e6edf3" font-size="11.5" font-weight="700" letter-spacing="0.06em">${escapeHtml(p.name).toUpperCase()}</text>`;
      const x0 = X(r.x.offset), x1 = X(r.x.finish);
      svg += `<rect x="${x0}" y="${y + 8}" width="${Math.max(x1 - x0, 2)}" height="8" rx="4" fill="#e8973a22" stroke="#e8973a55"/>`;
      svg += `<text x="${x1 + 8}" y="${y + 17}" fill="#5a6875" font-size="9.5">${fmtDate(addDays(startIso, r.x.finish))}</text>`;
      y += PROJH;
    } else {
      const s = r.x.sched[r.it.id];
      const off = r.x.offset;
      const x0 = X(off + s.es), x1 = X(off + s.ef);
      const yc = y + ROWH / 2;
      const name = r.it.name.length > 30 ? r.it.name.slice(0, 29) + '…' : r.it.name;
      svg += `<text x="22" y="${yc + 3.5}" fill="#8b9aa7" font-size="10.5">${escapeHtml(name)}</text>`;
      // Slack whisker.
      if (s.slack > 0.001) {
        const lx1 = X(off + s.lf);
        svg += `<line x1="${x1}" y1="${yc}" x2="${lx1}" y2="${yc}" stroke="#5a6875" stroke-width="1" stroke-dasharray="3,3"/>`;
        svg += `<line x1="${lx1}" y1="${yc - 4}" x2="${lx1}" y2="${yc + 4}" stroke="#5a6875" stroke-width="1"/>`;
      }
      const fill = s.critical ? '#e8973a' : '#3d5468';
      const stroke = s.critical ? '#e8973a' : '#5fb3c9';
      svg += `<g><title>${escapeHtml(r.it.name)}: ${r.it.durationDays}d, ${fmtDate(addDays(startIso, off + s.es))} to ${fmtDate(addDays(startIso, off + s.ef))}${s.critical ? ' (CRITICAL)' : ', slack ' + s.slack + 'd'}</title>` +
        `<rect x="${x0}" y="${y + 5}" width="${Math.max(x1 - x0, 3)}" height="${ROWH - 10}" rx="3" fill="${fill}" stroke="${stroke}" stroke-width="1" opacity="${s.critical ? 1 : 0.9}"/></g>`;
      if (dayW >= 6) {
        svg += `<text x="${x1 + 6}" y="${yc + 3.5}" fill="#5a6875" font-size="9">${r.it.durationDays}d</text>`;
      }
      barPos[r.it.id] = { x0, x1, yc, off, proj: r.x.p.id };
      y += ROWH;
    }
  }

  // Dependency arrows (within projects).
  for (const r of rows) {
    if (r.kind !== 'item') continue;
    for (const dep of (r.it.deps || [])) {
      const a = barPos[dep], b = barPos[r.it.id];
      if (!a || !b || a.proj !== b.proj) continue;
      const midX = Math.max(a.x1 + 6, b.x0 - 6);
      svg += `<path d="M ${a.x1} ${a.yc} L ${a.x1 + 5} ${a.yc} L ${a.x1 + 5} ${b.yc} L ${b.x0 - 4} ${b.yc}" fill="none" stroke="#5a687588" stroke-width="1.2"/>`;
      svg += `<path d="M ${b.x0 - 4} ${b.yc - 3} L ${b.x0 + 1} ${b.yc} L ${b.x0 - 4} ${b.yc + 3} Z" fill="#5a6875"/>`;
    }
  }

  svg += '</svg>';
  return svg;
}
