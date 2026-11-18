// ESTIMATE: what each project costs and why, laid out as a deep dive. The contents column on the
// left lists the program (every project against the budget cap: the old BUDGET page) and each
// project; the reading column in the middle is the chosen project's estimate (estimate-report.js);
// the detail column on the right shows whatever was clicked with everything known about it, and
// can show it in the model beside the page.
//
// Addresses: #/estimate (the last project looked at, else the program), #/estimate?program,
// #/estimate?project=<id>; the old #/budget opens the program.

import {
  touch, onChange, activeProperty, propertyProjects, projectById, escapeHtml, fmtMoney, fmtLen, readMoney, uid, isoToday,
} from './store.js';
import { projectEstimate, rootOf, setEstimateSetting, estimateSettings } from './estimate.js';
import { reportModel, reportSections, detailFor, searchIndex, roomBody } from './estimate-report.js';
import { keepRemoved } from './recovery.js';
import { restoreProjectEdit } from './project-history.js';
import { showInModel, modelBeside, whenModelBeside } from './model-focus.js';
import { icon } from './icons.js';

let el = null, off = null, offBeside = null, program = null, timer = null;
let hist = [], hpos = -1;          // the detail column's back and forward
let lastModel = null, index = [];
const openRooms = new Set();
const LAST_KEY = 'tiksi.estimate.last.';

function wanted() {
  const q = new URLSearchParams((location.hash.split('?')[1] || ''));
  if (/^#\/budget/.test(location.hash) || q.has('program')) return { program: true };
  const id = q.get('project');
  if (id && projectById(id)) return { project: rootOf(projectById(id)).id };
  let last = '';
  try { last = localStorage.getItem(LAST_KEY + (activeProperty() || {}).id) || ''; } catch { /* not remembered */ }
  const tops = propertyProjects().filter(p => !p.parentId);
  if (last === 'program') return { program: true };
  if (last && tops.some(p => p.id === last)) return { project: last };
  return { program: true };
}
function go(target) {
  const hash = target.program ? '#/estimate?program' : '#/estimate?project=' + encodeURIComponent(target.project);
  try { localStorage.setItem(LAST_KEY + (activeProperty() || {}).id, target.program ? 'program' : target.project); } catch { /* fine */ }
  if (location.hash !== hash) history.replaceState(null, '', hash);
  hist = []; hpos = -1; openRooms.clear();
  render();
  el && el.querySelector('.est-main')?.scrollTo(0, 0);
}

export function mount(root) {
  el = root;
  off = onChange(() => { clearTimeout(timer); timer = setTimeout(() => { if (el && !el.contains(document.activeElement?.closest?.('input,select,textarea') || null)) render(true); }, 160); });
  offBeside = whenModelBeside(() => { const k = hist[hpos]; const d = k && lastModel && detailFor(k, lastModel); if (d && d.model) showInModel(d.model, { frame: true }); });
  document.addEventListener('keydown', onKey);
  render();
}
// UNDO and REDO in the top bar: the projects' history, which holds the estimate settings, bids
// and sign-off too (project-history.js).
export function undo() { if (restoreProjectEdit('undo')) render(true); }
export function redo() { if (restoreProjectEdit('redo')) render(true); }
export function unmount() {
  clearTimeout(timer);
  if (off) off(); off = null;
  if (offBeside) offBeside(); offBeside = null;
  document.removeEventListener('keydown', onKey);
  if (program) { try { program.unmount(); } catch (e) { console.error(e); } program = null; }
  el = null; lastModel = null;
}
function onKey(e) {
  if (!el) return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); el.querySelector('#est-find')?.focus(); }
  else if (e.key === 'Escape' && document.body.classList.contains('est-det-open')) closeDetail();
}

// ---------- render ----------
function render(keep) {
  if (!el) return;
  const target = wanted();
  const prop = activeProperty();
  const tops = propertyProjects().filter(p => !p.parentId);
  const main = el.querySelector('.est-main'), scroll = keep && main ? main.scrollTop : 0;
  const detScroll = keep ? el.querySelector('#est-dbody')?.scrollTop || 0 : 0;
  if (program) { try { program.unmount(); } catch (e) { console.error(e); } program = null; }

  const projRow = p => {
    const e = projectEstimate(p);
    return `<a class="est-proj ${target.project === p.id ? 'here' : ''}" href="#/estimate?project=${encodeURIComponent(p.id)}" data-proj="${escapeHtml(p.id)}">
      <span>${escapeHtml(p.name || 'Project')}</span><span class="m">${e ? fmtMoney(e.total.likely) : ''}</span></a>`;
  };
  el.innerHTML = `<div class="est ${target.program ? 'est-program' : ''}">
    <nav class="est-nav" aria-label="Estimate contents">
      <div class="est-brand"><b>ESTIMATE</b><span>${escapeHtml(prop ? prop.name || '' : '')}</span></div>
      <div class="est-find"><input id="est-find" type="search" placeholder="Find a piece, board, task (⌘K)" autocomplete="off" aria-label="Find in this estimate" ${target.program ? 'disabled' : ''}><div class="est-find-res" id="est-find-res" hidden></div></div>
      <div class="est-grp"><div class="gl">All projects</div>
        <a class="est-proj ${target.program ? 'here' : ''}" href="#/estimate?program" data-program><span>Program and budget cap</span></a></div>
      <div class="est-grp"><div class="gl">Projects</div>${tops.map(projRow).join('') || '<p class="note">No projects yet. Make one in PROJECTS.</p>'}</div>
      <div class="est-toc" id="est-toc"></div>
    </nav>
    <main class="est-main" id="est-main"><div class="est-in" id="est-in"></div></main>
    <aside class="est-det" aria-label="Detail column" aria-live="polite">
      <div class="dbar"><button type="button" id="est-back" aria-label="Back" disabled>${icon('chevron-left') || '‹'}</button><button type="button" id="est-fwd" aria-label="Forward" disabled>${icon('chevron-right') || '›'}</button>
        <span class="crumb" id="est-crumb">Details</span><button type="button" id="est-close" aria-label="Close the detail">${icon('close') || '×'}</button></div>
      <div id="est-dbody"></div>
    </aside>
    <div class="est-scrim" id="est-scrim"></div>
  </div>`;

  el.querySelectorAll('[data-proj]').forEach(a => a.onclick = e => { e.preventDefault(); go({ project: a.dataset.proj }); });
  el.querySelector('[data-program]').onclick = e => { e.preventDefault(); go({ program: true }); };
  el.querySelector('#est-back').onclick = () => { if (hpos > 0) { hpos--; paint(); } };
  el.querySelector('#est-fwd').onclick = () => { if (hpos < hist.length - 1) { hpos++; paint(); } };
  el.querySelector('#est-close').onclick = closeDetail;
  el.querySelector('#est-scrim').onclick = closeDetail;

  const inner = el.querySelector('#est-in');
  if (target.program) {
    lastModel = null; index = [];
    import('./budget.js').then(mod => {
      if (!el || !wanted().program) return;
      program = mod; mod.mount(inner);
    }).catch(err => { inner.innerHTML = `<p class="note">The program could not open (${escapeHtml(err.message)}).</p>`; });
    emptyDetail('program');
    return;
  }
  const root = projectById(target.project);
  const est = projectEstimate(root);
  const M = reportModel({ est, prop, len: m => fmtLen(m), money: v => fmtMoney(v), date: isoToday(), propertyName: prop ? prop.name : '', live: true });
  lastModel = M;
  index = searchIndex(M);
  const sections = reportSections(M);
  inner.innerHTML = `<div class="est-actions">
      <a class="btn small" href="#/projects">${icon('projects') || ''}PROJECTS</a>
      <a class="btn small" href="#/documents?bid=${encodeURIComponent(root.id)}">${icon('file') || ''}BID PACKAGE</a>
      <button class="btn small" data-export>${icon('export')}SAVE DEEP DIVE</button>
    </div>` + sections.map((s, i) => `<section class="est-sec ${i ? '' : 'first'}" id="${s.id}">${s.html}</section>`).join('');
  // contents
  let toc = '', grp = '';
  for (const s of sections) {
    if (s.group !== grp) { if (grp) toc += '</div>'; grp = s.group; toc += `<div class="est-grp"><div class="gl">${escapeHtml(grp)}</div>`; }
    toc += `<a href="#${s.id}" data-go="${s.id}">${escapeHtml(s.nav)}</a>`;
    if (s.subs && s.subs.length) toc += `<div class="subs">${s.subs.map(x => `<a href="#${x.id}" data-go="${x.id}">${escapeHtml(x.nav)}</a>`).join('')}</div>`;
  }
  el.querySelector('#est-toc').innerHTML = toc + (grp ? '</div>' : '');
  el.querySelectorAll('[data-go]').forEach(a => a.onclick = e => { e.preventDefault(); goTo(a.dataset.go); });

  // rooms: drawn when opened
  inner.querySelectorAll('details.est-room').forEach(d => {
    const name = d.dataset.room;
    const fill = () => { const b = d.querySelector('.est-room-body'); if (!b.dataset.filled) { b.innerHTML = roomBody(M, name); b.dataset.filled = '1'; markOn(); } };
    if (openRooms.has(name)) { d.open = true; fill(); }
    d.ontoggle = () => { if (d.open) { openRooms.add(name); fill(); } else openRooms.delete(name); };
  });
  bindInputs(inner, root);
  inner.querySelector('[data-export]').onclick = () => saveDeepDive(root);
  inner.onclick = e => {
    if (e.target.closest('input, select, textarea, button, summary, label')) return;
    const a = e.target.closest('[data-d]');
    if (a && inner.contains(a)) { e.preventDefault(); openDetail(a.dataset.d, a); }
  };
  bindFind();
  spy();
  if (keep) { main && (el.querySelector('.est-main').scrollTop = scroll); if (hpos >= 0) { paint(); el.querySelector('#est-dbody').scrollTop = detScroll; } else emptyDetail(); }
  else emptyDetail();
}

function goTo(id) {
  const t = el.querySelector('#' + CSS.escape(id));
  if (!t) return;
  const room = t.closest('details.est-room') || (t.matches('details.est-room') ? t : null);
  if (room && !room.open) room.open = true;
  t.scrollIntoView({ block: 'start', behavior: 'smooth' });
  t.classList.remove('flash'); void t.offsetWidth; t.classList.add('flash');
  if (innerWidth < 1100) document.body.classList.remove('est-nav-open');
}

// The contents column marks the section being read.
function spy() {
  const main = el.querySelector('.est-main');
  const links = [...el.querySelectorAll('#est-toc a[data-go]')];
  const tick = () => {
    let cur = null;
    for (const s of el.querySelectorAll('.est-sec, details.est-room')) if (s.getBoundingClientRect().top < main.getBoundingClientRect().top + 120) cur = s.id;
    links.forEach(a => a.classList.toggle('here', a.dataset.go === cur));
  };
  main.addEventListener('scroll', () => requestAnimationFrame(tick), { passive: true });
  tick();
}

// ---------- the detail column ----------
function openDetail(key, from) {
  if (hist[hpos] !== key) { hist = hist.slice(0, hpos + 1); hist.push(key); hpos = hist.length - 1; }
  paint();
  if (innerWidth < 1100) document.body.classList.add('est-det-open');
}
function closeDetail() { hist = []; hpos = -1; emptyDetail(); document.body.classList.remove('est-det-open'); }
function markOn() {
  if (!el) return;
  el.querySelectorAll('.d-on, .td-on').forEach(n => n.classList.remove('d-on', 'td-on'));
  const key = hist[hpos];
  // A piece or board in a drawing lights up in the drawing's own highlight; rows get an outline.
  if (key) el.querySelectorAll(`.est-main [data-d="${CSS.escape(key)}"]`).forEach(n => n.classList.add(n instanceof SVGElement ? 'td-on' : 'd-on'));
}
function paint() {
  const body = el.querySelector('#est-dbody'), key = hist[hpos];
  const d = key && lastModel ? detailFor(key, lastModel) : null;
  const kindWord = { piece: 'Piece', stick: 'Store piece', wall: 'Wall', room: 'Room', task: 'Labor', supply: 'Supply', product: 'Moulding', item: 'Scope item', part: 'Project', option: 'Option', cost: 'Price build-up', bid: 'Bid', source: 'Source' };
  el.querySelector('#est-crumb').textContent = (kindWord[String(key).split(':')[0]] || 'Details') + (hist.length > 1 ? '  ·  ' + (hpos + 1) + ' of ' + hist.length : '');
  body.innerHTML = d ? `${d.eyebrow ? `<div class="d-eyebrow">${d.eyebrow}</div>` : ''}<div class="d-title">${d.title || ''}</div>${d.sub ? `<div class="d-sub">${d.sub}</div>` : ''}${d.html || ''}
    <div class="d-acts">${d.go ? `<button class="btn small" data-show-on-page>SHOW ON THE PAGE</button>` : ''}${d.model && d.model.length ? `<button class="btn small" data-show-model>${icon('model') || ''}SHOW IN THE MODEL</button>` : ''}</div>`
    : `<p class="note">This is no longer in the estimate (the drawing or the scope changed).</p>`;
  body.scrollTop = 0;
  el.querySelector('#est-back').disabled = hpos <= 0;
  el.querySelector('#est-fwd').disabled = hpos >= hist.length - 1;
  body.querySelectorAll('[data-d]').forEach(a => a.onclick = e => { e.preventDefault(); openDetail(a.dataset.d); });
  body.querySelector('[data-show-on-page]')?.addEventListener('click', () => {
    const n = el.querySelector(`.est-main [data-d="${CSS.escape(key)}"]`);
    if (n) { const room = n.closest('details.est-room'); if (room) room.open = true; n.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    else goTo(d.go);
  });
  body.querySelector('[data-show-model]')?.addEventListener('click', () => {
    if (modelBeside()) showInModel(d.model, { frame: 'always' });
    else document.getElementById('btn-beside')?.click();   // the model opens beside the page, then shows them (whenModelBeside)
  });
  if (d && d.model && modelBeside()) showInModel(d.model, { frame: true });
  markOn();
}
function emptyDetail(mode) {
  const body = el && el.querySelector('#est-dbody');
  if (!body) return;
  el.querySelector('#est-crumb').textContent = 'Details';
  el.querySelector('#est-back').disabled = true; el.querySelector('#est-fwd').disabled = true;
  body.innerHTML = mode === 'program'
    ? `<div class="d-empty"><div class="d-eyebrow">The program</div><h3>Every project against the cap</h3><p>Tick projects into the program to fit the budget cap; the totals are each project's estimate, with the trim worked out from the drawing and its markups. Open a project on the left for its estimate.</p></div>`
    : `<div class="d-empty"><div class="d-eyebrow">Detail column</div><h3>Click anything to see it here</h3>
      <p>Pieces on the wall drawings, boards in the cut diagrams, rows of the buy list, labor tasks, supplies, scope items and each line of the price build-up open here with what they are, their numbers, where they come from and what they connect to.</p>
      <p>With MODEL BESIDE on, a piece, wall or room is also selected in the model.</p></div>`;
  markOn();
}

// ---------- find ----------
function bindFind() {
  const box = el.querySelector('#est-find'), res = el.querySelector('#est-find-res');
  if (!box) return;
  let hits = [], on = 0;
  const show = () => {
    const words = box.value.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) { res.hidden = true; return; }
    hits = index.filter(x => words.every(w => x.text.includes(w))).slice(0, 30); on = 0;
    res.innerHTML = hits.length ? hits.map((h, i) => `<button type="button" data-i="${i}" class="${i === on ? 'on' : ''}"><span class="k">${escapeHtml(h.kind)}</span><span class="t">${escapeHtml(h.title)}</span></button>`).join('') : '<div class="none">Nothing found.</div>';
    res.hidden = false;
    res.querySelectorAll('[data-i]').forEach(b => b.onmousedown = e => { e.preventDefault(); pick(+b.dataset.i); });
  };
  const pick = i => { const h = hits[i]; if (!h) return; res.hidden = true; box.blur(); openDetail(h.key); const n = el.querySelector(`.est-main [data-d="${CSS.escape(h.key)}"]`); if (n) { const r = n.closest('details.est-room'); if (r) r.open = true; n.scrollIntoView({ block: 'center' }); } };
  box.oninput = show;
  box.onkeydown = e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); on = (on + (e.key === 'ArrowDown' ? 1 : -1) + hits.length) % Math.max(1, hits.length); res.querySelectorAll('[data-i]').forEach((b, i) => b.classList.toggle('on', i === on)); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(on); }
    else if (e.key === 'Escape') { box.value = ''; res.hidden = true; }
  };
  box.onblur = () => setTimeout(() => { res.hidden = true; }, 150);
}

// ---------- inputs: settings, bids, sign-off, covered items ----------
const PCT = new Set(['contingency', 'overhead', 'profit', 'taxRate']);
function bindInputs(inner, root) {
  inner.querySelectorAll('[data-set]').forEach(inp => inp.onchange = () => {
    const key = inp.dataset.set, raw = Number(inp.value);
    if (!Number.isFinite(raw) || raw < 0) { inp.value = ''; inp.setCustomValidity('A number of 0 or more'); inp.reportValidity(); return; }
    setEstimateSetting(root, key, PCT.has(key) ? raw / 100 : raw);
    touch(); render(true);
  });
  const bid = inner.querySelector('[data-add-bid]');
  if (bid) bid.onsubmit = e => {
    e.preventDefault();
    const f = new FormData(bid), amount = readMoney(String(f.get('amount') || ''));
    if (Number.isNaN(amount.value)) { const a = bid.querySelector('[name=amount]'); a.setCustomValidity(amount.error); a.reportValidity(); return; }
    root.bids = [...(root.bids || []), { id: uid('bid'), who: String(f.get('who') || '').trim(), date: String(f.get('date') || '') || isoToday(), hours: Number(f.get('hours')) || 0, amount: amount.value, scope: String(f.get('scope') || '').trim() }];
    touch(); render(true);
  };
  inner.querySelectorAll('[data-del-bid]').forEach(b => b.onclick = () => {
    const x = (root.bids || []).find(y => y.id === b.dataset.delBid);
    if (!x || !confirm(`Remove the bid from ${x.who || 'this bidder'}?`)) return;
    root.bids = root.bids.filter(y => y !== x); if (!root.bids.length) delete root.bids;
    touch(); render(true);
  });
  const so = inner.querySelector('[data-signoff]');
  if (so) so.onsubmit = e => {
    e.preventDefault();
    const f = new FormData(so), raw = String(f.get('amount') || '').trim();
    const amount = raw ? readMoney(raw) : { value: null };
    if (raw && Number.isNaN(amount.value)) { const a = so.querySelector('[name=amount]'); a.setCustomValidity(amount.error); a.reportValidity(); return; }
    const next = { status: String(f.get('status') || ''), by: String(f.get('by') || '').trim(), date: String(f.get('date') || ''), amount: amount.value, note: String(f.get('note') || '').trim() };
    if (!next.status && !next.by && !next.date && next.amount == null && !next.note) delete root.signoff; else root.signoff = next;
    touch(); render(true);
  };
  const rm = inner.querySelector('[data-remove-covered]');
  if (rm) rm.onclick = () => {
    const est = projectEstimate(root);
    if (!est.covered.length || !confirm(`Remove ${est.covered.length} scope ${est.covered.length === 1 ? 'item' : 'items'} that the drawn trim already prices? They can be restored from REMOVED RECORDS in PROJECTS.`)) return;
    const prop = activeProperty();
    for (const p of est.tree) {
      const gone = (p.items || []).filter(it => est.covered.some(c => c.item === it));
      if (!gone.length) continue;
      keepRemoved(prop, 'item', gone, p.id);
      p.items = p.items.filter(it => !gone.includes(it));
    }
    touch(); render(true);
  };
}

async function saveDeepDive(root) {
  try {
    const { saveEstimateDeepDive } = await import('./estimate-export.js');
    await saveEstimateDeepDive(root);
  } catch (e) { console.error(e); alert('The deep dive could not be saved: ' + (e && e.message || e)); }
}

export const _test = { wanted };
export { estimateSettings };
