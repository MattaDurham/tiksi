// Schedule view: critical-path method (CPM) over each selected project's scope items,
// rendered as an SVG Gantt. Forward/backward pass, slack, dependency arrows.

import {
  ws, touch, escapeHtml, fmtDate, addDays, dayDiff, isoToday,
} from './store.js';
import { icon } from './icons.js';

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
            style="background:transparent;border:none;color:var(--ink);font:inherit;outline:none;color-scheme:dark;border-bottom:1px dashed var(--line-2)"></div>
          <div class="k-sub">click to change</div>
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
        <div class="kpi">
          <div class="k-label">Critical items</div>
          <div class="k-value">${plans.reduce((n, x) => n + Object.values(x.sched).filter(s => s.critical).length, 0)}</div>
          <div class="k-sub">of ${plans.reduce((n, x) => n + Object.keys(x.sched).length, 0)} scheduled items</div>
        </div>
      </div>
      <div class="legend" style="margin-bottom:10px">
        <span><span class="sw" style="background:linear-gradient(180deg,#f4ad57,#d98a2c); box-shadow:0 0 6px rgba(232,151,58,.5)"></span>critical path</span>
        <span><span class="sw" style="background:linear-gradient(180deg,#4a6478,#354b5c)"></span>float available</span>
        <span><span class="sw" style="background:transparent;border-top:2px dashed var(--faint); height:0"></span>slack window</span>
        <span><span class="sw" style="background:rgba(255,255,255,.06); border:1px solid var(--line-2)"></span>weekend</span>
        <span><span class="sw" style="background:var(--red); width:2px"></span>today</span>
      </div>
      <div class="gantt-wrap" id="gantt"></div>
      ${plans.map(x => criticalPathLine(x)).join('')}
      ${plans.length === 0 ? `<div class="empty-state" style="margin-top:14px"><span class="empty-ic">${icon('schedule')}</span><b>No schedulable work</b>
        Select projects in BUDGET and give scope items durations and dependencies in PROJECTS.</div>` : ''}
    </div>`;

  el.querySelector('#prog-start').onchange = e => {
    d.settings.programStart = e.target.value;
    touch(); render();
  };

  if (plans.length) el.querySelector('#gantt').innerHTML = ganttSvg(plans, start, programEnd);
  else el.querySelector('#gantt').remove();
}

function criticalPathLine(x) {
  const names = x.p.items
    .filter(i => x.sched[i.id] && x.sched[i.id].critical)
    .sort((a, b) => x.sched[a.id].es - x.sched[b.id].es)
    .map(i => escapeHtml(i.name));
  if (!names.length) return '';
  return `<div class="mono" style="font-size:11px; margin-top:10px; color:var(--dim); line-height:1.7">
    <span style="color:var(--accent); letter-spacing:0.08em">CRITICAL / ${escapeHtml(x.p.name).toUpperCase()}:</span>
    ${names.join(' <span style="color:var(--faint)">&rsaquo;</span> ')}
    ${x.cyclic ? ' <span style="color:var(--red)">(dependency cycle detected; some links ignored)</span>' : ''}
  </div>`;
}

function ganttSvg(plans, startIso, programEnd) {
  const LABELW = 236, AXISH = 46, ROWH = 26, PROJH = 30, GAP = 10, PAD = 8;
  const span = programEnd + 7;
  const dayW = span <= 45 ? 18 : span <= 90 ? 11 : span <= 180 ? 6.5 : span <= 365 ? 3.4 : 1.8;
  const width = LABELW + span * dayW + 24;

  let rows = [];
  for (const x of plans) {
    rows.push({ kind: 'proj', x });
    for (const it of x.p.items) {
      if (x.sched[it.id]) rows.push({ kind: 'item', x, it });
    }
  }
  const height = AXISH + rows.reduce((h, r) => h + (r.kind === 'proj' ? PROJH + GAP : ROWH), 0) + PAD * 2;
  const chartBottom = height - PAD;

  const X = day => LABELW + day * dayW;
  let svg = `<svg class="gantt-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">`;
  svg += `<defs>
    <linearGradient id="g-crit" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f6b45e"/><stop offset="1" stop-color="#d4842a"/></linearGradient>
    <linearGradient id="g-float" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4d6a80"/><stop offset="1" stop-color="#34495a"/></linearGradient>
    <linearGradient id="g-proj" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="rgba(232,151,58,0.45)"/><stop offset="1" stop-color="rgba(232,151,58,0.12)"/></linearGradient>
    <filter id="g-glow" x="-10%" y="-60%" width="120%" height="220%"><feGaussianBlur stdDeviation="2.5" result="b"/><feComponentTransfer in="b" result="c"><feFuncA type="linear" slope="0.7"/></feComponentTransfer><feMerge><feMergeNode in="c"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  </defs>`;
  svg += `<rect width="${width}" height="${height}" fill="#0f1418"/>`;

  // Month band: alternating shading with the month name, then a day/week row beneath it.
  const MONTHH = 22;
  svg += `<rect x="${LABELW}" y="0" width="${width - LABELW}" height="${AXISH}" fill="rgba(255,255,255,0.02)"/>`;
  let monthStart = 0;
  for (let day = 0; day <= span; day++) {
    const dt = new Date(addDays(startIso, day) + 'T00:00');
    const last = day === span;
    if ((dt.getDate() === 1 && day > 0) || last) {
      const x0 = X(monthStart), x1 = X(last ? span : day);
      const mdt = new Date(addDays(startIso, monthStart) + 'T00:00');
      const mi = mdt.getMonth();
      if (mi % 2 === 0) svg += `<rect x="${x0}" y="0" width="${x1 - x0}" height="${MONTHH}" fill="rgba(255,255,255,0.03)"/>`;
      const label = mdt.toLocaleDateString('en-US', { month: 'short' }) + (mi === 0 || monthStart === 0 ? ' ' + mdt.getFullYear() : '');
      if (x1 - x0 > 30) svg += `<text x="${x0 + 6}" y="15" fill="#8f9ca8" font-size="10" font-weight="700" letter-spacing="0.1em">${label.toUpperCase()}</text>`;
      svg += `<line x1="${x0}" y1="0" x2="${x0}" y2="${chartBottom}" stroke="rgba(255,255,255,0.09)" stroke-width="1"/>`;
      monthStart = day;
    }
  }
  svg += `<line x1="${LABELW}" y1="${MONTHH}" x2="${width}" y2="${MONTHH}" stroke="rgba(255,255,255,0.07)"/>`;

  // Weekend shading + week grid + day-of-month labels.
  for (let day = 0; day <= span; day++) {
    const iso = addDays(startIso, day);
    const dt = new Date(iso + 'T00:00');
    const dow = dt.getDay();
    if (dayW >= 6 && (dow === 0 || dow === 6) && day < span) {
      svg += `<rect x="${X(day)}" y="${AXISH}" width="${dayW}" height="${chartBottom - AXISH}" fill="rgba(255,255,255,0.028)"/>`;
    }
    const isWeek = dow === 1;
    if (dayW >= 6 ? isWeek : dt.getDate() === 1) {
      svg += `<line x1="${X(day)}" y1="${AXISH}" x2="${X(day)}" y2="${chartBottom}" stroke="rgba(255,255,255,0.05)" stroke-width="1"/>`;
      if (dayW >= 6) svg += `<text x="${X(day) + 3}" y="${AXISH - 8}" fill="#5d6a76" font-size="9">${dt.getDate()}</text>`;
    }
  }
  svg += `<line x1="0" y1="${AXISH}" x2="${width}" y2="${AXISH}" stroke="rgba(255,255,255,0.12)"/>`;
  svg += `<line x1="${LABELW - 10}" y1="0" x2="${LABELW - 10}" y2="${height}" stroke="rgba(255,255,255,0.1)"/>`;

  // Rows.
  let y = AXISH + PAD;
  const barPos = {}; // itemId -> {x0,x1,yc} for arrows
  let deps = '';
  for (const r of rows) {
    if (r.kind === 'proj') {
      y += GAP;
      const { p } = r.x;
      const x0 = X(r.x.offset), x1 = X(r.x.finish);
      svg += `<g class="g-rowg"><rect class="g-row" x="0" y="${y}" width="${width}" height="${PROJH}"/>`;
      svg += `<text x="12" y="${y + 19}" fill="#e9eef3" font-size="11.5" font-weight="700" letter-spacing="0.08em">${escapeHtml(p.name).toUpperCase()}</text>`;
      svg += `<rect x="${x0}" y="${y + 10}" width="${Math.max(x1 - x0, 2)}" height="8" rx="4" fill="url(#g-proj)" stroke="rgba(232,151,58,0.45)"/>`;
      svg += `<text x="${x1 + 8}" y="${y + 19}" fill="#5d6a76" font-size="9.5">${fmtDate(addDays(startIso, r.x.finish))}</text></g>`;
      y += PROJH;
    } else {
      const s = r.x.sched[r.it.id];
      const off = r.x.offset;
      const x0 = X(off + s.es), x1 = X(off + s.ef);
      const yc = y + ROWH / 2;
      const name = r.it.name.length > 30 ? r.it.name.slice(0, 29) + '…' : r.it.name;
      svg += `<g class="g-rowg"><rect class="g-row" x="0" y="${y}" width="${width}" height="${ROWH}"/>`;
      svg += `<text class="g-label" x="24" y="${yc + 3.5}" fill="#8f9ca8" font-size="10.5">${escapeHtml(name)}</text>`;
      // Slack whisker.
      if (s.slack > 0.001) {
        const lx1 = X(off + s.lf);
        svg += `<line x1="${x1}" y1="${yc}" x2="${lx1}" y2="${yc}" stroke="#5d6a76" stroke-width="1" stroke-dasharray="3,3"/>`;
        svg += `<line x1="${lx1}" y1="${yc - 4}" x2="${lx1}" y2="${yc + 4}" stroke="#5d6a76" stroke-width="1.2"/>`;
      }
      const bw = Math.max(x1 - x0, 3);
      const bh = ROWH - 10;
      const title = `${escapeHtml(r.it.name)}: ${r.it.durationDays}d, ${fmtDate(addDays(startIso, off + s.es))} to ${fmtDate(addDays(startIso, off + s.ef))}${s.critical ? ' (CRITICAL)' : ', slack ' + s.slack + 'd'}`;
      if (s.critical) {
        svg += `<g class="g-bar"><title>${title}</title>` +
          `<rect x="${x0}" y="${y + 5}" width="${bw}" height="${bh}" rx="4" fill="url(#g-crit)" stroke="rgba(255,205,140,0.7)" stroke-width="1" filter="url(#g-glow)"/>` +
          `<rect x="${x0 + 1}" y="${y + 6}" width="${Math.max(bw - 2, 1)}" height="${Math.max(bh / 2 - 1, 1)}" rx="3" fill="rgba(255,255,255,0.12)"/></g>`;
      } else {
        svg += `<g class="g-bar"><title>${title}</title>` +
          `<rect x="${x0}" y="${y + 5}" width="${bw}" height="${bh}" rx="4" fill="url(#g-float)" stroke="rgba(95,179,201,0.55)" stroke-width="1"/>` +
          `<rect x="${x0 + 1}" y="${y + 6}" width="${Math.max(bw - 2, 1)}" height="${Math.max(bh / 2 - 1, 1)}" rx="3" fill="rgba(255,255,255,0.06)"/></g>`;
      }
      if (dayW >= 6) {
        const inside = bw > 34;
        svg += `<text x="${inside ? x0 + bw / 2 : x1 + 6}" y="${yc + 3.5}" fill="${inside ? (s.critical ? '#2a1a08' : '#dfe8ef') : '#5d6a76'}" font-size="9" font-weight="${inside ? 700 : 400}" text-anchor="${inside ? 'middle' : 'start'}">${r.it.durationDays}d</text>`;
      }
      svg += '</g>';
      barPos[r.it.id] = { x0, x1, yc, off, proj: r.x.p.id };
      y += ROWH;
    }
  }

  // Dependency arrows (within projects), drawn above rows so hover bands do not cover them.
  for (const r of rows) {
    if (r.kind !== 'item') continue;
    for (const dep of (r.it.deps || [])) {
      const a = barPos[dep], b = barPos[r.it.id];
      if (!a || !b || a.proj !== b.proj) continue;
      const kx = a.x1 + 5;
      deps += `<path d="M ${a.x1} ${a.yc} L ${kx} ${a.yc} L ${kx} ${b.yc} L ${b.x0 - 4} ${b.yc}" fill="none" stroke="rgba(143,156,168,0.5)" stroke-width="1.2"/>`;
      deps += `<path d="M ${b.x0 - 4} ${b.yc - 3} L ${b.x0 + 1} ${b.yc} L ${b.x0 - 4} ${b.yc + 3} Z" fill="#8f9ca8"/>`;
    }
  }
  svg += deps;

  // Today: marker line with a label pill in the axis band.
  const today = dayDiff(startIso, isoToday());
  if (today >= 0 && today <= span) {
    const tx = X(today);
    svg += `<line x1="${tx}" y1="${MONTHH}" x2="${tx}" y2="${chartBottom}" stroke="#e05252" stroke-width="1.5" stroke-dasharray="3,3"/>`;
    svg += `<rect x="${tx - 20}" y="${MONTHH + 4}" width="40" height="15" rx="7.5" fill="#e05252"/>`;
    svg += `<text x="${tx}" y="${MONTHH + 15}" fill="#fff" font-size="8.5" font-weight="700" text-anchor="middle" letter-spacing="0.1em">TODAY</text>`;
  }

  svg += '</svg>';
  return svg;
}
