// Budget view: the "here is the current budget" report.
// Select/deselect projects against a cap, roll up by project and category, print a report.

import {
  ws, touch, fmtMoney, parseMoney, escapeHtml, projectTotals, selectedTotals,
  fmtDate, isoToday,
} from './store.js';

let el = null;
export function mount(root) { el = root; render(); }
export function unmount() { el = null; }

function render() {
  if (!el) return;
  const d = ws.data;
  const cap = d.settings.budgetCap || 0;
  const sel = selectedTotals();
  const remaining = cap - sel.likely;
  const pct = cap > 0 ? Math.min(sel.likely / cap, 1.4) : 0;

  const byCat = {};
  for (const p of d.projects) {
    if (!p.selected) continue;
    const t = projectTotals(p);
    byCat[p.category] = byCat[p.category] || { low: 0, likely: 0, high: 0, n: 0 };
    byCat[p.category].low += t.low; byCat[p.category].likely += t.likely; byCat[p.category].high += t.high;
    byCat[p.category].n++;
  }

  const selectedProjects = d.projects.filter(p => p.selected);
  const parked = d.projects.filter(p => !p.selected);
  const maxLikely = Math.max(...d.projects.map(p => projectTotals(p).likely), 1);

  el.innerHTML = `
    <div class="view-scroll">
      <div class="view-head">
        <span class="view-title">BUDGET</span>
        <span class="view-sub">select and deselect projects to fit the cap; totals update live</span>
        <span style="flex:1"></span>
        <button class="btn primary" id="print-report">PRINT REPORT</button>
      </div>

      <div class="kpi-band">
        <div class="kpi">
          <div class="k-label">Budget cap</div>
          <div class="k-value"><input type="text" id="cap-input" value="${fmtMoney(cap)}"
            style="background:transparent;border:none;color:var(--ink);font:inherit;width:130px;outline:none;border-bottom:1px dashed var(--line-2)"></div>
          <div class="k-sub">click to edit</div>
        </div>
        <div class="kpi accent">
          <div class="k-label">Selected (likely)</div>
          <div class="k-value">${fmtMoney(sel.likely)}</div>
          <div class="k-sub">${fmtMoney(sel.low)} low - ${fmtMoney(sel.high)} high</div>
        </div>
        <div class="kpi ${remaining < 0 ? 'over' : 'ok'}">
          <div class="k-label">${remaining < 0 ? 'Over cap' : 'Remaining'}</div>
          <div class="k-value">${fmtMoney(Math.abs(remaining))}</div>
          <div class="k-sub">${selectedProjects.length} of ${d.projects.length} projects selected</div>
        </div>
      </div>
      <div class="capbar" style="max-width:640px">
        <div class="fill ${sel.likely > cap ? 'over' : ''}" style="width:${Math.min(pct / 1.4 * 100, 100)}%"></div>
        ${cap > 0 ? `<div class="mark" style="left:${(1 / 1.4) * 100}%"></div>` : ''}
      </div>
      <div class="mono faint" style="font-size:10px; margin-bottom:18px; max-width:640px; display:flex; justify-content:space-between">
        <span>0</span><span>cap ${fmtMoney(cap)}</span>
      </div>

      <div class="kicker">PROGRAM (SELECTED)</div>
      <table class="grid" style="max-width:980px">
        <thead><tr><th></th><th>Project</th><th>Status</th><th>Category</th>
          <th class="num">Low</th><th class="num">Likely</th><th class="num">High</th><th style="width:26%"></th></tr></thead>
        <tbody>
          ${selectedProjects.map(p => projRow(p, maxLikely)).join('') || '<tr><td colspan="8" class="muted">Nothing selected. Check projects below to build the program.</td></tr>'}
          <tr class="total-row"><td></td><td>PROGRAM TOTAL</td><td></td><td></td>
            <td class="num">${fmtMoney(sel.low)}</td><td class="num">${fmtMoney(sel.likely)}</td><td class="num">${fmtMoney(sel.high)}</td><td></td></tr>
        </tbody>
      </table>

      <div class="kicker" style="margin-top:26px">BY CATEGORY</div>
      <table class="grid" style="max-width:640px">
        <thead><tr><th>Category</th><th class="num">Projects</th><th class="num">Low</th><th class="num">Likely</th><th class="num">High</th></tr></thead>
        <tbody>${Object.entries(byCat).sort((a, b) => b[1].likely - a[1].likely).map(([c, t]) =>
          `<tr><td>${c}</td><td class="num">${t.n}</td><td class="num">${fmtMoney(t.low)}</td>
           <td class="num">${fmtMoney(t.likely)}</td><td class="num">${fmtMoney(t.high)}</td></tr>`).join('') ||
          '<tr><td colspan="5" class="muted">No selected projects.</td></tr>'}
        </tbody>
      </table>

      <div class="kicker" style="margin-top:26px">PARKED (NOT IN PROGRAM)</div>
      <table class="grid" style="max-width:980px">
        <tbody>${parked.map(p => projRow(p, maxLikely)).join('') || '<tr><td class="muted">Everything is selected.</td></tr>'}</tbody>
      </table>
    </div>`;

  const capInput = el.querySelector('#cap-input');
  capInput.onchange = () => { d.settings.budgetCap = parseMoney(capInput.value); touch(); render(); };
  el.querySelectorAll('[data-sel]').forEach(cb => cb.onchange = () => {
    const p = d.projects.find(p => p.id === cb.dataset.sel);
    p.selected = cb.checked;
    touch(); render();
  });
  el.querySelector('#print-report').onclick = printReport;
}

function projRow(p, maxLikely) {
  const t = projectTotals(p);
  const w = Math.round(t.likely / maxLikely * 100);
  return `<tr>
    <td style="width:30px"><input type="checkbox" ${p.selected ? 'checked' : ''} data-sel="${p.id}"></td>
    <td><b>${escapeHtml(p.name)}</b></td>
    <td><span class="chip status-${p.status}">${p.status}</span></td>
    <td class="muted">${p.category}</td>
    <td class="num">${fmtMoney(t.low)}</td>
    <td class="num">${fmtMoney(t.likely)}</td>
    <td class="num">${fmtMoney(t.high)}</td>
    <td><div style="height:8px;border-radius:4px;background:${p.selected ? 'var(--accent)' : 'var(--line-2)'};width:${Math.max(w, 2)}%"></div></td>
  </tr>`;
}

export function budgetReportHtml() {
  const d = ws.data;
  const cap = d.settings.budgetCap || 0;
  const sel = selectedTotals();
  const selectedProjects = d.projects.filter(p => p.selected);
  const parked = d.projects.filter(p => !p.selected);
  const byCat = {};
  for (const p of selectedProjects) {
    const t = projectTotals(p);
    byCat[p.category] = byCat[p.category] || { likely: 0, n: 0 };
    byCat[p.category].likely += t.likely; byCat[p.category].n++;
  }
  const itemRows = p => p.items.map(it => {
    const q = it.qty || 1;
    return `<tr><td style="padding-left:22px">${escapeHtml(it.name)}</td>
      <td class="num">${q} ${escapeHtml(it.unit || '')}</td>
      <td class="num">${fmtMoney((it.low || 0) * q)}</td>
      <td class="num">${fmtMoney((it.likely || 0) * q)}</td>
      <td class="num">${fmtMoney((it.high || 0) * q)}</td></tr>`;
  }).join('');

  return `<div class="sheet sheet-page">
    <div class="s-head"><span class="s-brand">TIKSI</span><span class="s-doc">Current budget report</span></div>
    <h1>Renovation program budget</h1>
    <div class="s-sub">Generated ${fmtDate(isoToday())} - cap ${fmtMoney(cap)} - ${selectedProjects.length} projects in program</div>

    <h2>Summary</h2>
    <table><thead><tr><th></th><th class="num">Low</th><th class="num">Likely</th><th class="num">High</th></tr></thead>
      <tbody>
        <tr><td>Program total</td><td class="num">${fmtMoney(sel.low)}</td><td class="num"><b>${fmtMoney(sel.likely)}</b></td><td class="num">${fmtMoney(sel.high)}</td></tr>
        <tr><td>Budget cap</td><td class="num"></td><td class="num">${fmtMoney(cap)}</td><td class="num"></td></tr>
        <tr><td>${cap - sel.likely >= 0 ? 'Headroom at likely' : 'OVER CAP at likely'}</td><td class="num"></td>
          <td class="num"><b>${fmtMoney(Math.abs(cap - sel.likely))}</b></td><td class="num"></td></tr>
      </tbody></table>

    <h2>Selected projects</h2>
    <table><thead><tr><th>Project / item</th><th class="num">Qty</th><th class="num">Low</th><th class="num">Likely</th><th class="num">High</th></tr></thead>
      <tbody>${selectedProjects.map(p => {
        const t = projectTotals(p);
        return `<tr><td><b>${escapeHtml(p.name)}</b> <span style="color:#888">(${p.status})</span></td><td></td>
          <td class="num"><b>${fmtMoney(t.low)}</b></td><td class="num"><b>${fmtMoney(t.likely)}</b></td><td class="num"><b>${fmtMoney(t.high)}</b></td></tr>` + itemRows(p);
      }).join('')}</tbody></table>

    <h2>By category</h2>
    <table><thead><tr><th>Category</th><th class="num">Projects</th><th class="num">Likely</th></tr></thead>
      <tbody>${Object.entries(byCat).sort((a, b) => b[1].likely - a[1].likely).map(([c, t]) =>
        `<tr><td>${c}</td><td class="num">${t.n}</td><td class="num">${fmtMoney(t.likely)}</td></tr>`).join('')}</tbody></table>

    ${parked.length ? `<h2>Parked (not in program)</h2>
    <table><tbody>${parked.map(p => `<tr><td>${escapeHtml(p.name)}</td>
      <td class="num">${fmtMoney(projectTotals(p).likely)} likely</td></tr>`).join('')}</tbody></table>` : ''}

    <div class="s-foot"><span>tiksi design console</span><span>${fmtDate(isoToday())}</span></div>
  </div>`;
}

function printReport() {
  document.getElementById('print-root').innerHTML = budgetReportHtml();
  window.print();
}
