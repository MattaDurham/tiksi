import { keepRemoved, openRecovery } from './recovery.js';
import { takeoffState } from './source-revision.js';
// Projects view: capture ideas, scope them into line items with budget ranges,
// durations and dependencies. The budget and schedule views read from this data.
// A project can hold subprojects (one level deep): small pieces of work such as a punch list,
// each with its own status, priority, room and source, and its own scope if it needs one.
// The list can be searched (names, notes, source, room and scope items), narrowed by status
// and other fields, sorted, grouped, or shown as a board with one column per status. Each
// scope item has its own status and opens a panel with its notes and everything linked to it;
// the links open PLAN, PRODUCTS or PHOTOS on that record.

import {
  ws, uid, touch, fmtMoney, readMoney, escapeHtml, projectTotals, projectProgress,
  activeProperty, elementInfo, fmtLen, fmtArea, isoToday,
  PRIORITIES, ITEM_STATUSES, subprojectsOf, projectById, roomsOn, wallsOn, propertyProjects,
} from './store.js';
import { fixtureLabel } from './fixtures.js';
import { icon } from './icons.js';

const STATUSES = ['idea', 'scoped', 'committed', 'in-progress', 'done'];
const STATUS_LABEL = { idea: 'Idea', scoped: 'Scoped', committed: 'Committed', 'in-progress': 'In progress', done: 'Done' };
const ITEM_LABEL = { todo: 'To do', ordered: 'Ordered', 'in-progress': 'In progress', done: 'Done' };
const CATEGORIES = ['kitchen', 'bath', 'interior', 'exterior', 'systems', 'structure', 'landscape', 'other'];
const PRIORITY_CHIP = { high: 'red', medium: 'accent', low: 'cyan' };
const SORTS = [['order', 'List order'], ['priority', 'Priority'], ['likely', 'Likely cost'], ['status', 'Status'], ['name', 'Name']];
const GROUPS = [['none', 'No grouping'], ['status', 'Status'], ['room', 'Room'], ['category', 'Category']];

let el = null;
let activeProjectId = null;
let freshId = null;              // a project just made with NEW PROJECT / ADD SUBPROJECT, still unnamed
const openItems = new Set();     // scope items whose panel is open
let moneyProblem = null;         // { itemId, text }: a price as typed that could not be read, and why

// ---------- the list's view: search, filters, sort, grouping, list or board ----------
// Remembered in this browser for each property (like a saved default view); never written to
// a project file.
const VIEW_DEFAULT = { q: '', status: '', category: '', roomId: '', priority: '', program: false, sort: 'order', group: 'none', layout: 'list' };
let view = null, viewProp = null;
const viewKey = id => 'tiksi.projects.view.' + (id || 'none');
function currentView() {
  const prop = activeProperty(), id = prop ? prop.id : '';
  if (view && viewProp === id) return view;
  viewProp = id;
  view = { ...VIEW_DEFAULT };
  try {
    const saved = JSON.parse(localStorage.getItem(viewKey(id)) || 'null');
    if (saved && typeof saved === 'object') for (const k of Object.keys(VIEW_DEFAULT)) if (typeof saved[k] === typeof VIEW_DEFAULT[k]) view[k] = saved[k];
  } catch { /* no storage: the defaults stand */ }
  if (!SORTS.some(([k]) => k === view.sort)) view.sort = 'order';
  if (!GROUPS.some(([k]) => k === view.group)) view.group = 'none';
  if (view.layout !== 'board') view.layout = 'list';
  return view;
}
function saveView() { try { localStorage.setItem(viewKey(viewProp), JSON.stringify(view)); } catch { /* not remembered */ } }
const isNarrowed = v => !!(v.q.trim() || v.status || v.category || v.roomId || v.priority || v.program);
const filterCount = v => [v.category, v.roomId, v.priority, v.program].filter(Boolean).length;

export function mount(root) {
  el = root;
  window.addEventListener('keydown', onKey);
  document.addEventListener('pointerdown', onOutside);
  render();
}
export function unmount() {
  window.removeEventListener('keydown', onKey);
  document.removeEventListener('pointerdown', onOutside);
  moneyProblem = null;
  el = null;
}

// "/" jumps to the search box from anywhere in PROJECTS that is not a text field.
function onKey(e) {
  if (!el || e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (t && (t.closest('input, textarea, select, [contenteditable="true"]'))) return;
  const box = el.querySelector('#proj-search');
  if (box) { e.preventDefault(); box.focus(); box.select(); }
}
function onOutside(e) {
  const menu = el && el.querySelector('#proj-viewmenu');
  if (menu && menu.open && !menu.contains(e.target)) menu.open = false;
}

function newProject(name, fields) {
  return Object.assign({
    id: uid('proj'), name, propertyId: activeProperty() ? activeProperty().id : null,
    category: 'other', status: 'idea', selected: false, startDate: '', notes: '', items: [],
    parentId: '', priority: '', roomId: '', source: '',
  }, fields);
}

// Open subprojects first, highest priority first, then the done ones; otherwise list order.
function sortedSubs(p) {
  const rank = s => (s.status === 'done' ? 10 : 0) + (s.priority ? PRIORITIES.indexOf(s.priority) : PRIORITIES.length);
  return subprojectsOf(p).map((s, i) => ({ s, i })).sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i).map(x => x.s);
}

function priorityChip(p) {
  return p.priority ? `<span class="chip ${PRIORITY_CHIP[p.priority]}">${escapeHtml(p.priority)}</span>` : '';
}

function propOf(p) { return ws.data.properties.find(x => x.id === p.propertyId) || activeProperty(); }
function roomOf(p) {
  const prop = ws.data.properties.find(x => x.id === p.propertyId);
  return prop && p.roomId ? prop.rooms.find(r => r.id === p.roomId) || null : null;
}
const roomName = p => { const r = roomOf(p); return r ? r.name || 'Room' : ''; };

// ---------- search and filters ----------
// Every word must appear in the project's own text (name, notes, source, room, category) or in
// one of its scope items (name, notes). Returns null when it does not match, otherwise the names
// of the scope items that supplied a word, for the card's "matches:" line.
function searchHits(p, words) {
  if (!words.length) return [];
  const own = [p.name, p.notes, p.source, roomName(p), p.category].join('\n').toLowerCase();
  const items = (p.items || []).map(it => ({ it, text: ((it.name || '') + '\n' + (it.notes || '')).toLowerCase() }));
  const hits = [];
  for (const w of words) {
    if (own.includes(w)) continue;
    const found = items.filter(x => x.text.includes(w));
    if (!found.length) return null;
    for (const f of found) if (!hits.includes(f.it.name)) hits.push(f.it.name);
  }
  return hits;
}
function passes(p, v, words, ignoreStatus) {
  if (!ignoreStatus && v.status && (v.status === 'open' ? p.status === 'done' : p.status !== v.status)) return false;
  if (v.category && p.category !== v.category) return false;
  if (v.roomId && p.roomId !== v.roomId) return false;
  if (v.priority && (v.priority === '-' ? !!p.priority : p.priority !== v.priority)) return false;
  if (v.program && !p.selected) return false;
  return searchHits(p, words) !== null;
}
const wordsOf = v => v.q.toLowerCase().split(/\s+/).filter(Boolean);

// The top-level projects to show, each with its visible subprojects. While anything narrows the
// list, a project shows when it or one of its subprojects matches; a project shown only for its
// subprojects is drawn dimmed, and only matching subprojects are listed.
function visibleEntries(mine, v) {
  const words = wordsOf(v), narrow = isNarrowed(v);
  const out = [];
  mine.filter(p => !p.parentId).forEach((p, order) => {
    const own = passes(p, v, words);
    const subs = sortedSubs(p).filter(s => !narrow || passes(s, v, words));
    if (narrow && !own && !subs.length) return;
    out.push({ p, order, own: own || !narrow, hits: own ? searchHits(p, words) || [] : [], subs });
  });
  const rank = {
    priority: p => p.priority ? PRIORITIES.indexOf(p.priority) : PRIORITIES.length,
    status: p => STATUSES.indexOf(p.status),
    likely: p => -projectTotals(p).likely,
  }[v.sort];
  if (v.sort === 'name') out.sort((a, b) => a.p.name.localeCompare(b.p.name) || a.order - b.order);
  else if (rank) out.sort((a, b) => rank(a.p) - rank(b.p) || a.order - b.order);
  return out;
}

function groupKey(p, g) {
  if (g === 'status') return [STATUSES.indexOf(p.status), STATUS_LABEL[p.status] || p.status];
  if (g === 'category') return [CATEGORIES.indexOf(p.category), p.category];
  if (g === 'room') { const n = roomName(p); return n ? [0, n] : [1, 'No room']; }
  return [0, ''];
}
function grouped(entries, g) {
  if (g === 'none') return [{ label: '', entries }];
  const map = new Map();
  for (const e of entries) {
    const [rank, label] = groupKey(e.p, g);
    if (!map.has(label)) map.set(label, { rank, label, entries: [] });
    map.get(label).entries.push(e);
  }
  return [...map.values()].sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));
}

// ---------- render ----------
function render() {
  if (!el) return;
  const v = currentView();
  const mine = propertyProjects();
  if (activeProjectId && !mine.find(p => p.id === activeProjectId)) activeProjectId = null;
  const tops = mine.filter(p => !p.parentId);
  if (!activeProjectId && tops.length) activeProjectId = tops[0].id;
  const prop = activeProperty();
  const rooms = prop ? prop.levels.flatMap(l => roomsOn(prop, l.id)) : [];
  if (v.roomId && !rooms.some(r => r.id === v.roomId)) v.roomId = '';
  const opt = (val, label, cur) => `<option value="${escapeHtml(val)}" ${val === cur ? 'selected' : ''}>${escapeHtml(label)}</option>`;

  el.innerHTML = `
    <div class="view-scroll">
      <div class="view-head">
        <span class="view-title">PROJECTS</span><button class="btn" data-recovery>REMOVED RECORDS</button>
        <span class="view-sub" id="proj-count"></span>
        <span class="sp" style="flex:1"></span>
        <button class="btn primary" id="new-project">${icon('plus')}NEW PROJECT</button>
      </div>
      <div class="proj-tools">
        <input type="search" class="search-input" id="proj-search" placeholder="Search projects and scope items" aria-label="Search projects and scope items" value="${escapeHtml(v.q)}">
        <div class="proj-status" id="proj-status" role="group" aria-label="Show projects by status"></div>
        <span class="sp"></span>
        <button class="btn small ghost" id="proj-clear" hidden>CLEAR</button>
        <details class="pv-menu" id="proj-viewmenu">
          <summary class="btn small" id="proj-view-btn">VIEW</summary>
          <div class="pv-pop">
            <div class="field"><label for="pv-category">Category</label><select id="pv-category" data-v="category">${opt('', 'All categories', v.category)}${CATEGORIES.map(c => opt(c, c, v.category)).join('')}</select></div>
            <div class="field"><label for="pv-room">Room</label><select id="pv-room" data-v="roomId">${opt('', 'All rooms', v.roomId)}${rooms.map(r => opt(r.id, r.name || 'Room', v.roomId)).join('')}</select></div>
            <div class="field"><label for="pv-priority">Priority</label><select id="pv-priority" data-v="priority">${opt('', 'Any priority', v.priority)}${PRIORITIES.map(x => opt(x, x, v.priority)).join('')}${opt('-', 'No priority', v.priority)}</select></div>
            <label class="pv-check"><input type="checkbox" id="pv-program" data-v="program" ${v.program ? 'checked' : ''}> In the program only</label>
            <div class="field"><label for="pv-sort">Sort</label><select id="pv-sort" data-v="sort">${SORTS.map(([k, l]) => opt(k, l, v.sort)).join('')}</select></div>
            <div class="field"><label for="pv-group">Group</label><select id="pv-group" data-v="group">${GROUPS.map(([k, l]) => opt(k, l, v.group)).join('')}</select></div>
          </div>
        </details>
        <div class="seg" role="group" aria-label="Layout">
          <button type="button" class="seg-btn ${v.layout === 'list' ? 'active' : ''}" data-layout="list" aria-pressed="${v.layout === 'list'}">LIST</button>
          <button type="button" class="seg-btn ${v.layout === 'board' ? 'active' : ''}" data-layout="board" aria-pressed="${v.layout === 'board'}">BOARD</button>
        </div>
      </div>
      <div class="${v.layout === 'board' ? 'proj-board-layout' : 'two-col'}" ${v.layout === 'board' ? '' : 'style="height:auto; align-items:start"'}>
        <div class="${v.layout === 'board' ? '' : 'list-stack'}" id="proj-list"></div>
        <div id="proj-detail"></div>
      </div>
    </div>`;

  el.querySelector('[data-recovery]').onclick = () => openRecovery(render);
  el.querySelector('#new-project').onclick = () => {
    const p = newProject('New project');
    ws.data.projects.push(p);
    activeProjectId = p.id;
    freshId = p.id;
    touch(); render(); focusName();
  };
  const search = el.querySelector('#proj-search');
  search.oninput = () => { v.q = search.value; saveView(); renderList(); };
  search.onkeydown = e => { if (e.key === 'Escape' && search.value) { e.preventDefault(); search.value = ''; v.q = ''; saveView(); renderList(); } };
  el.querySelector('#proj-clear').onclick = () => {
    Object.assign(v, { q: '', status: '', category: '', roomId: '', priority: '', program: false });
    saveView(); render();
  };
  el.querySelectorAll('[data-v]').forEach(inp => inp.onchange = () => {
    v[inp.dataset.v] = inp.type === 'checkbox' ? inp.checked : inp.value;
    saveView(); renderList();
  });
  el.querySelectorAll('[data-layout]').forEach(b => b.onclick = () => {
    if (v.layout === b.dataset.layout) return;
    v.layout = b.dataset.layout; saveView(); render();
  });

  renderList();
  renderDetail(mine.find(p => p.id === activeProjectId));
}

// The header counts, the status chips, the CLEAR button and the list or board: everything the
// search and filters change. The search box itself is left alone so typing keeps its focus.
function renderList() {
  if (!el) return;
  const v = currentView();
  const mine = propertyProjects();
  const tops = mine.filter(p => !p.parentId);
  const subCount = mine.length - tops.length;
  const entries = visibleEntries(mine, v);
  const narrow = isNarrowed(v);

  el.querySelector('#proj-count').textContent = `${tops.length} projects${subCount ? ', ' + subCount + ' subprojects' : ''}, ${mine.filter(p => p.selected).length} selected into the program` +
    (narrow ? `, showing ${entries.length}` : '');

  const words = wordsOf(v);
  const base = mine.filter(p => passes(p, v, words, true));
  const count = s => s === '' ? base.length : s === 'open' ? base.filter(p => p.status !== 'done').length : base.filter(p => p.status === s).length;
  el.querySelector('#proj-status').innerHTML = [['', 'All'], ['open', 'Open'], ...STATUSES.map(s => [s, STATUS_LABEL[s]])].map(([s, label]) =>
    `<button type="button" class="ps-chip ${s ? 'status-' + s : ''} ${v.status === s ? 'on' : ''}" data-status="${s}" aria-pressed="${v.status === s}" title="Projects and subprojects">${label} <b>${count(s)}</b></button>`).join('');
  el.querySelectorAll('#proj-status [data-status]').forEach(b => b.onclick = () => {
    v.status = v.status === b.dataset.status ? '' : b.dataset.status;
    saveView(); renderList();
  });
  el.querySelector('#proj-clear').hidden = !narrow;
  const n = filterCount(v);
  el.querySelector('#proj-view-btn').textContent = n ? `VIEW · ${n}` : 'VIEW';

  const list = el.querySelector('#proj-list');
  if (!tops.length) {
    list.innerHTML = `<div class="empty-state"><span class="empty-ic">${icon('projects')}</span><b>No projects yet</b>Every renovation idea starts as a project.</div>`;
    return;
  }
  if (!entries.length) {
    list.innerHTML = `<div class="empty-state"><span class="empty-ic">${icon('search')}</span><b>Nothing matches</b>No project or scope item matches this search and these filters.<button class="btn small" data-clear>CLEAR</button></div>`;
    list.querySelector('[data-clear]').onclick = () => el.querySelector('#proj-clear').click();
    return;
  }
  list.innerHTML = v.layout === 'board' ? boardHtml(entries) : grouped(entries, v.group).map(g =>
    (g.label ? `<div class="proj-group-head"><span>${escapeHtml(g.label)}</span><span class="faint">${g.entries.length} · ${fmtMoney(g.entries.reduce((n, e) => n + projectTotals(e.p).likely, 0))}</span></div>` : '') +
    g.entries.map(e => cardHtml(e) + subRowsHtml(e)).join('')).join('');
  bindList(list, v);
}

function cardSummary(p) {
  const t = projectTotals(p), g = projectProgress(p);
  const days = p.items.reduce((n, i) => n + (i.durationDays || 0), 0);
  const subs = subprojectsOf(p), open = subs.filter(s => s.status !== 'done').length;
  const money = g.items && !g.priced ? 'no prices yet' : fmtMoney(t.likely) + ' likely';
  return `${money}, ${g.items} items` + (g.priced && g.priced < g.items ? `, ${g.priced} priced` : '') + (g.done ? `, ${g.done} done` : '') +
    (days ? ', ' + days + 'd work' : '') + (subs.length ? `, ${subs.length} subprojects (${open} open)` : '');
}

function cardHtml(e, board) {
  const p = e.p;
  const hits = e.hits.length ? `<div class="p-hit">matches: ${escapeHtml(e.hits.slice(0, 3).join(', '))}${e.hits.length > 3 ? ' and ' + (e.hits.length - 3) + ' more' : ''}</div>` : '';
  return `<div class="card clickable proj-card ${p.id === activeProjectId ? 'active' : ''} ${e.own ? '' : 'context'}" data-id="${escapeHtml(p.id)}" ${board ? 'draggable="true" tabindex="0"' : ''}>
      <span class="sbar status-${escapeHtml(p.status)}"></span>
      <div class="p-title">
        <b>${escapeHtml(p.name)}</b>
        <label class="bd-sel-tap"><input type="checkbox" ${p.selected ? 'checked' : ''} data-sel="${escapeHtml(p.id)}" title="Include in program budget/schedule" aria-label="In the program: ${escapeHtml(p.name)}"></label>
      </div>
      <div class="p-chips">
        ${board ? '' : `<span class="chip status-${escapeHtml(p.status)}">${escapeHtml(p.status)}</span>`}
        <span class="chip">${escapeHtml(p.category)}</span>
        ${priorityChip(p)}
      </div>
      <div class="p-sub">${cardSummary(p)}</div>
      ${hits}
    </div>`;
}

function subRowsHtml(e) {
  const rows = e.subs.map(s => `<div class="sub-row ${s.status === 'done' ? 'done' : ''} ${s.id === activeProjectId ? 'active' : ''}" data-id="${escapeHtml(s.id)}" title="${escapeHtml(s.name)}">
      <span class="sbar status-${escapeHtml(s.status)}"></span>
      <span class="sub-name">${escapeHtml(s.name)}</span>
      ${priorityChip(s)}
    </div>`).join('');
  return rows ? `<div class="sub-list" data-parent="${escapeHtml(e.p.id)}">${rows}</div>` : '';
}

// One column per status; dragging a card to another column, or Left/Right on a focused card,
// changes the project's status. The drag carries its own type, not text: a text drag is what
// the window's Polycam-link drop accepts, and it would turn the move into a link drop.
const DRAG_TYPE = 'application/x-tiksi-project';
function boardHtml(entries) {
  return `<div class="proj-board">${STATUSES.map(s => {
    const col = entries.filter(e => e.p.status === s);
    return `<div class="pb-col" data-col="${s}">
      <div class="pb-head"><span class="chip status-${s}">${STATUS_LABEL[s]}</span><span class="faint mono">${col.length}</span></div>
      <div class="pb-cards">${col.map(e => cardHtml(e, true) + subRowsHtml(e)).join('') || '<div class="pb-empty">Drop a project here</div>'}</div>
    </div>`;
  }).join('')}</div>`;
}

function setStatus(p, status) {
  if (!STATUSES.includes(status) || p.status === status) return false;
  p.status = status; touch(); return true;
}

function bindList(list, v) {
  const open = id => { activeProjectId = id; renderList(); renderDetail(projectById(id)); };
  list.querySelectorAll('.card, .sub-row').forEach(c => c.onclick = e => {
    // The in-program checkbox and the finger-sized label around it flip that, not open the card.
    if (e.target.closest('input, label')) return;
    open(c.dataset.id);
  });
  list.querySelectorAll('[data-sel]').forEach(cb => cb.onchange = () => {
    const p = projectById(cb.dataset.sel);
    p.selected = cb.checked;
    touch(); render();
  });
  if (v.layout !== 'board') return;
  list.querySelectorAll('.proj-card').forEach(c => {
    c.ondragstart = e => { e.dataTransfer.setData(DRAG_TYPE, c.dataset.id); e.dataTransfer.effectAllowed = 'move'; c.classList.add('dragging'); };
    c.ondragend = () => c.classList.remove('dragging');
    c.onkeydown = e => {
      if (e.key === 'Enter') { e.preventDefault(); open(c.dataset.id); return; }
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const p = projectById(c.dataset.id);
      const i = STATUSES.indexOf(p.status) + (e.key === 'ArrowRight' ? 1 : -1);
      if (i < 0 || i >= STATUSES.length) return;
      e.preventDefault();
      setStatus(p, STATUSES[i]);
      renderList(); if (p.id === activeProjectId) renderDetail(p);
      el.querySelector(`#proj-list .proj-card[data-id="${CSS.escape(p.id)}"]`)?.focus();
    };
  });
  list.querySelectorAll('.pb-col').forEach(col => {
    col.ondragover = e => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
      e.preventDefault(); e.dataTransfer.dropEffect = 'move'; col.classList.add('over');
    };
    col.ondragleave = e => { if (!col.contains(e.relatedTarget)) col.classList.remove('over'); };
    col.ondrop = e => {
      e.preventDefault(); col.classList.remove('over');
      const p = projectById(e.dataTransfer.getData(DRAG_TYPE));
      if (!p || !setStatus(p, col.dataset.col)) return;
      renderList(); if (p.id === activeProjectId) renderDetail(p);
    };
  });
}

function roomOptions(p) {
  const prop = ws.data.properties.find(x => x.id === p.propertyId);
  if (!prop) return '';
  const groups = prop.levels.map(l => {
    const opts = roomsOn(prop, l.id).map(r => `<option value="${escapeHtml(r.id)}" ${r.id === p.roomId ? 'selected' : ''}>${escapeHtml(r.name || 'Room')}</option>`).join('');
    return opts ? `<optgroup label="${escapeHtml(l.name)}">${opts}</optgroup>` : '';
  }).join('');
  return `<option value="">(none)</option>${groups}`;
}

function parentOptions(p) {
  const tops = ws.data.projects.filter(x => !x.parentId && x.id !== p.id && x.propertyId === p.propertyId);
  return `<option value="">(none: a project of its own)</option>` +
    tops.map(x => `<option value="${escapeHtml(x.id)}" ${x.id === p.parentId ? 'selected' : ''}>${escapeHtml(x.name)}</option>`).join('');
}

// Put the cursor in the name field of a project just made, with its placeholder name selected.
function focusName() {
  const inp = el && el.querySelector('#proj-detail [data-f="name"]');
  if (inp) { inp.focus(); inp.select(); }
}

// The project's money and progress in one line: likely total and range, how many items are
// priced and done, work days, linked photos and products, open subprojects.
function summaryHtml(p, subs) {
  const t = projectTotals(p), g = projectProgress(p);
  const days = p.items.reduce((n, i) => n + (i.durationDays || 0), 0);
  const photos = new Set(), prods = new Set();
  for (const it of p.items) {
    for (const ph of sitePhotosFor(it)) photos.add(ph.id);
    for (const pr of productsFor(it)) prods.add(pr.id);
  }
  const pct = g.items ? Math.round(g.done / g.items * 100) : 0;
  const stat = (big, small) => `<div class="ps-stat"><b>${big}</b><span>${small}</span></div>`;
  return `<div class="proj-summary">
    ${stat(g.priced ? fmtMoney(t.likely) : 'No prices', g.priced && (t.low || t.high) ? 'likely, ' + fmtMoney(t.low) + ' to ' + fmtMoney(t.high) : 'likely total')}
    ${stat(g.priced + ' of ' + g.items, 'items priced')}
    <div class="ps-stat"><b>${g.done} of ${g.items}</b><span>items done</span><i class="ps-bar"><i style="width:${pct}%"></i></i></div>
    ${stat(days, 'work days')}
    ${stat(photos.size + ' · ' + prods.size, 'photos · products linked')}
    ${subs.length ? stat(subs.filter(s => s.status !== 'done').length + ' of ' + subs.length, 'subprojects open') : ''}
  </div>`;
}

function renderDetail(p) {
  const det = el.querySelector('#proj-detail');
  if (!p) { det.innerHTML = `<div class="empty-state"><span class="empty-ic">${icon('edit')}</span><b>Nothing selected</b>Select or create a project.</div>`; return; }
  const t = projectTotals(p);
  const parent = p.parentId ? projectById(p.parentId) : null;
  const subs = parent ? [] : sortedSubs(p);
  // Open items first in list order, then the done ones; the stored order stays as it is.
  const rows = [...p.items.filter(it => it.status !== 'done'), ...p.items.filter(it => it.status === 'done')];

  det.innerHTML = `
    <div class="card">
      ${takeoffState(p, activeProperty()) ? `<p role="status">Takeoff: ${escapeHtml(takeoffState(p, activeProperty()))}. Saved quantities and manual edits are retained.</p>` : ''}
      ${parent ? `<div class="sub-crumb">SUBPROJECT OF <button class="btn small ghost" data-open="${escapeHtml(parent.id)}">${escapeHtml(parent.name)}</button></div>` : ''}
      ${summaryHtml(p, subs)}
      <div class="field-row">
        <div class="field" style="flex:2"><label>Name</label><input type="text" data-f="name" value="${escapeHtml(p.name)}"></div>
        <div class="field"><label>Category</label>
          <select data-f="category">${CATEGORIES.map(c => `<option ${c === p.category ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
        <div class="field"><label>Status</label>
          <select data-f="status">${STATUSES.map(s => `<option ${s === p.status ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
        <div class="field"><label>Priority</label>
          <select data-f="priority"><option value="">-</option>${PRIORITIES.map(s => `<option ${s === p.priority ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
        <div class="field"><label>Earliest start</label><input type="date" data-f="startDate" value="${escapeHtml(p.startDate || '')}"></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Room</label><select data-f="roomId">${roomOptions(p)}</select></div>
        <div class="field"><label>Part of</label>
          <select data-f="parentId" ${subs.length ? 'disabled title="It has subprojects of its own"' : ''}>${parentOptions(p)}</select></div>
        <div class="field" style="flex:2"><label>Source</label><input type="text" data-f="source" value="${escapeHtml(p.source || '')}" placeholder="Where this came from: a note, an email, a report page"></div>
      </div>
      <div class="field"><label>Scope notes</label><textarea data-f="notes">${escapeHtml(p.notes || '')}</textarea></div>

      ${parent ? '' : `<div class="kicker" style="margin-top:14px">SUBPROJECTS</div>
      ${subs.length ? `<table class="grid" id="subs-table">
        <thead><tr><th>Subproject</th><th>Priority</th><th>Status</th><th>Room</th><th class="num">Likely</th></tr></thead>
        <tbody>${subs.map(s => subRow(s)).join('')}</tbody>
      </table>` : ''}
      <div style="display:flex; gap:8px; margin-top:10px">
        <button class="btn" id="add-sub">${icon('plus')}ADD SUBPROJECT</button>
      </div>`}

      <div class="kicker" style="margin-top:14px">SCOPE ITEMS</div>
      <table class="grid" id="items-table">
        <thead><tr>
          <th class="it-check" title="Done"></th>
          <th style="width:26%">Item</th><th class="num">Qty</th><th>Unit</th>
          <th class="num">Low</th><th class="num">Likely</th><th class="num">High</th>
          <th class="num">Days</th><th>Depends on</th><th></th>
        </tr></thead>
        <tbody>
        ${rows.map(it => itemRow(p, it)).join('')}
        <tr class="total-row"><td></td><td>TOTAL (qty applied)</td><td></td><td></td>
          <td class="num">${fmtMoney(t.low)}</td><td class="num">${fmtMoney(t.likely)}</td><td class="num">${fmtMoney(t.high)}</td>
          <td class="num">${p.items.reduce((n, i) => n + (i.durationDays || 0), 0)}</td><td colspan="2"></td></tr>
        </tbody>
      </table>
      <div style="display:flex; gap:8px; margin-top:10px">
        <button class="btn" id="add-item">${icon('plus')}ADD ITEM</button>
        <span style="flex:1"></span>
        <button class="btn danger" id="del-project">${icon('trash')}DELETE ${parent ? 'SUBPROJECT' : 'PROJECT'}</button>
      </div>
    </div>`;

  det.querySelectorAll('[data-f]').forEach(inp => inp.onchange = () => {
    p[inp.dataset.f] = inp.value;
    if (inp.dataset.f === 'name') freshId = null;
    touch();
    if (['status', 'name', 'priority', 'parentId', 'roomId', 'category'].includes(inp.dataset.f)) render();
  });
  // Enter keeps a name; Esc on a project just made and never named or filled removes it again.
  const name = det.querySelector('[data-f="name"]');
  name.onkeydown = e => {
    if (e.key === 'Enter') { e.preventDefault(); name.blur(); }
    if (e.key === 'Escape' && freshId === p.id && !p.items.length && !subprojectsOf(p).length) {
      e.preventDefault();
      freshId = null;
      ws.data.projects = ws.data.projects.filter(x => x.id !== p.id);
      activeProjectId = parent ? parent.id : null;
      touch(); render();
    }
  };
  det.querySelectorAll('[data-open]').forEach(b => b.onclick = () => { activeProjectId = b.dataset.open; render(); });

  const addSub = det.querySelector('#add-sub');
  if (addSub) addSub.onclick = () => {
    const s = newProject('New subproject', { propertyId: p.propertyId, parentId: p.id, category: p.category });
    ws.data.projects.push(s);
    activeProjectId = s.id;
    freshId = s.id;
    touch(); render(); focusName();
  };
  det.querySelectorAll('tr[data-sub]').forEach(tr => {
    const s = projectById(tr.dataset.sub);
    tr.querySelectorAll('[data-sf]').forEach(inp => inp.onchange = () => { s[inp.dataset.sf] = inp.value; touch(); render(); });
  });

  det.querySelector('#add-item').onclick = () => {
    p.items.push({
      id: uid('it'), name: 'New item', qty: 1, unit: 'ls', low: 0, likely: 0, high: 0,
      durationDays: 0, deps: [], elementIds: [], notes: '', status: 'todo', doneAt: '',
    });
    touch(); refresh(p);
  };
  det.querySelector('#del-project').onclick = () => {
    const what = (parent ? 'subproject "' : 'project "') + p.name + '" and all its scope items' + (subs.length ? ', with its ' + subs.length + ' subprojects' : '');
    if (!confirm('Delete ' + what + '?')) return;
    const gone = new Set([p.id, ...subs.map(s => s.id)]);
    keepRemoved(activeProperty(), 'projects', ws.data.projects.filter(x => gone.has(x.id)));
    ws.data.projects = ws.data.projects.filter(x => !gone.has(x.id));
    activeProjectId = parent ? parent.id : null;
    touch(); render();
  };

  bindItemRows(p);
}

// After a scope edit: the card's counts and the detail both change.
function refresh(p) { renderList(); renderDetail(p); }

function subRow(s) {
  const room = roomOf(s);
  return `<tr data-sub="${escapeHtml(s.id)}" class="${s.status === 'done' ? 'faint' : ''}">
    <td><button class="btn small ghost sub-open" data-open="${escapeHtml(s.id)}" title="${escapeHtml(s.source ? 'Source: ' + s.source : 'Open')}">${escapeHtml(s.name)}</button></td>
    <td style="width:92px"><select data-sf="priority"><option value="">-</option>${PRIORITIES.map(x => `<option ${x === s.priority ? 'selected' : ''}>${x}</option>`).join('')}</select></td>
    <td style="width:112px"><select data-sf="status">${STATUSES.map(x => `<option ${x === s.status ? 'selected' : ''}>${x}</option>`).join('')}</select></td>
    <td class="muted">${room ? escapeHtml(room.name || 'Room') : '-'}</td>
    <td class="num">${fmtMoney(projectTotals(s).likely)}</td>
  </tr>`;
}

// Names of the item's predecessors (dropped items are skipped), or '-' when it has none.
function depSummary(p, it) {
  const names = (it.deps || []).map(id => { const d = p.items.find(x => x.id === id); return d ? d.name : null; }).filter(Boolean);
  return names.join(', ') || '-';
}

// ---------- what a scope item links to ----------
// Site photos for a scope item, by the cut sheets' rule: tagged with the item, or with a room
// or wall the item rebuilds.
function sitePhotosFor(item) {
  const elIds = new Set(item.elementIds || []);
  const out = [];
  for (const p of ws.data.properties) {
    for (const ph of p.photos || []) {
      if ((ph.itemIds || []).includes(item.id) || (ph.roomId && elIds.has(ph.roomId)) || (ph.elementIds || []).some(id => elIds.has(id))) out.push(ph);
    }
  }
  return out;
}
const productsFor = it => ws.data.products.filter(pr => (pr.itemIds || []).includes(it.id));

// A linked element as a label and the address that opens it: rooms, walls and openings open
// in MODEL with the element selected, as do scans and fixtures.
function elementLink(p, id) {
  const prop = propOf(p);
  if (!prop) return { label: 'Missing element', href: '' };
  const multi = prop.levels.length > 1;
  const info = elementInfo(prop.id, id);
  const plan = '#/model?select=' + encodeURIComponent(id);
  if (info) {
    const where = multi ? ' · ' + info.level : '';
    return info.kind === 'room'
      ? { label: info.label + ' · ' + fmtArea(info.area) + where, href: plan, kind: 'Room' }
      : { label: 'Wall · ' + fmtLen(info.length) + where, href: plan, kind: 'Wall' };
  }
  const o = (prop.openings || []).find(x => x.id === id);
  if (o) return { label: (o.type === 'window' ? 'Window' : 'Door') + ' · ' + fmtLen(o.width), href: plan, kind: 'Opening' };
  const sc = (prop.scans || []).find(x => x.id === id);
  if (sc) return { label: 'Scan · ' + sc.name, href: '#/model', kind: 'Scan' };
  const fx = (prop.fixtures || []).find(x => x.id === id);
  if (fx) return { label: 'Fixture · ' + fixtureLabel(fx), href: '#/model', kind: 'Fixture' };
  return { label: 'Missing element', href: '' };
}

function linkSummary(p, it) {
  const els = it.elementIds || [], prods = productsFor(it).length, photos = sitePhotosFor(it).length;
  const bits = [];
  if (els.length === 1) bits.push(elementLink(p, els[0]).label.split(' · ')[0]);
  else if (els.length) bits.push(els.length + ' elements');
  if (prods) bits.push(prods + (prods === 1 ? ' product' : ' products'));
  if (photos) bits.push(photos + (photos === 1 ? ' photo' : ' photos'));
  return bits.join(' · ');
}

function itemRow(p, it) {
  const others = p.items.filter(x => x.id !== it.id);
  const depOpts = others
    .map(x => `<option value="${escapeHtml(x.id)}" ${(it.deps || []).includes(x.id) ? 'selected' : ''} title="${escapeHtml(x.name)}">${escapeHtml(x.name)}</option>`).join('');
  const summary = depSummary(p, it);
  const links = linkSummary(p, it);
  const open = openItems.has(it.id), done = it.status === 'done';
  return `<tr data-item="${escapeHtml(it.id)}" class="${done ? 'it-done' : ''} ${open ? 'it-open' : ''}">
    <td class="it-check"><label class="it-done-tap"><input type="checkbox" data-done ${done ? 'checked' : ''} aria-label="Done: ${escapeHtml(it.name)}" title="${done && it.doneAt ? 'Done ' + escapeHtml(it.doneAt) : 'Mark done'}"></label></td>
    <td class="it-namecell"><div class="it-name"><button type="button" class="it-toggle" data-toggle aria-expanded="${open}" title="${open ? 'Hide' : 'Show'} notes and links">${icon(open ? 'chevron-down' : 'chevron-right', { size: 13 })}</button>
      <input type="text" data-if="name" value="${escapeHtml(it.name)}"></div>
      <button type="button" class="it-links ${links ? '' : 'none'}" data-toggle title="Status, notes, linked model elements, products and photos">${it.status === 'ordered' || it.status === 'in-progress' ? `<span class="it-state">${ITEM_LABEL[it.status]}</span>` : ''}${escapeHtml(links || 'add notes and links')}</button></td>
    <td class="num it-qty" data-label="Qty" style="width:64px"><input type="number" class="num" data-if="qty" value="${escapeHtml(it.qty ?? 1)}" min="0" step="0.5"></td>
    <td class="it-unit" data-label="Unit" style="width:56px"><input type="text" data-if="unit" value="${escapeHtml(it.unit || 'ls')}"></td>
    <td class="num it-low" data-label="Low" style="width:80px"><input type="text" class="num" data-money="low" value="${it.low ? fmtMoney(it.low) : ''}" placeholder="-"></td>
    <td class="num it-likely" data-label="Likely" style="width:80px"><input type="text" class="num" data-money="likely" value="${it.likely ? fmtMoney(it.likely) : ''}" placeholder="no price"></td>
    <td class="num it-high" data-label="High" style="width:80px"><input type="text" class="num" data-money="high" value="${it.high ? fmtMoney(it.high) : ''}" placeholder="-"></td>
    <td class="num it-days" data-label="Days" style="width:56px"><input type="number" class="num" data-if="durationDays" value="${escapeHtml(it.durationDays || 0)}" min="0"></td>
    <td class="it-deps" data-label="After" style="width:112px"><div class="dep-wrap" title="${escapeHtml(summary === '-' ? 'No predecessors; click to pick (cmd-click for several)' : 'After: ' + summary)}">
      <button type="button" class="dep-summary ${summary === '-' ? 'none' : ''}" data-dep-open ${others.length ? '' : 'disabled'}>${escapeHtml(summary)}</button>
      <select multiple size="${Math.min(6, Math.max(2, others.length))}" data-deps>${depOpts}</select></div></td>
    <td class="it-del"><button type="button" class="row-del" data-del-item="${escapeHtml(it.id)}" title="Remove item" aria-label="Remove ${escapeHtml(it.name || 'item')}">${icon('close', { size: 13 })}</button></td>
  </tr>${moneyProblem && moneyProblem.itemId === it.id ? `<tr class="item-money-problem"><td colspan="10" role="alert" data-money-problem style="color:var(--red)">${escapeHtml(moneyProblem.text)}</td></tr>` : ''}${open ? `<tr class="item-more" data-more="${escapeHtml(it.id)}"><td colspan="10">${itemPanel(p, it)}</td></tr>` : ''}`;
}

// The panel under an open scope item: its notes, the rooms and walls it rebuilds, the products
// specified for it and the site photos that show it, each opening its own view.
function itemPanel(p, it) {
  const prop = propOf(p);
  const linked = new Set(it.elementIds || []);
  const chip = (link, attr, id) => `<span class="link-chip ${link.href ? '' : 'missing'}">${link.href
      ? `<a href="${escapeHtml(link.href)}" title="Open ${escapeHtml(link.href.startsWith('#/model') ? 'in MODEL' : link.href.startsWith('#/products') ? 'in PRODUCTS' : '')}">${escapeHtml(link.label)}</a>`
      : `<span>${escapeHtml(link.label)}</span>`}<button type="button" ${attr}="${escapeHtml(id)}" title="Unlink" aria-label="Unlink ${escapeHtml(link.label)}">${icon('close', { size: 11 })}</button></span>`;
  const els = (it.elementIds || []).map(id => chip(elementLink(p, id), 'data-unlink-el', id)).join('');
  let elOpts = '';
  if (prop) for (const l of prop.levels) {
    const where = prop.levels.length > 1 ? ' · ' + l.name : '';
    const rooms = roomsOn(prop, l.id).filter(r => !linked.has(r.id)).map(r => `<option value="${escapeHtml(r.id)}">${escapeHtml((r.name || 'Room') + ' · ' + fmtArea(elementInfo(prop.id, r.id).area))}</option>`).join('');
    const walls = wallsOn(prop, l.id).filter(w => !linked.has(w.id)).map(w => `<option value="${escapeHtml(w.id)}">${escapeHtml('Wall · ' + fmtLen(Math.hypot(w.bx - w.ax, w.by - w.ay)))}</option>`).join('');
    if (rooms) elOpts += `<optgroup label="${escapeHtml('Rooms' + where)}">${rooms}</optgroup>`;
    if (walls) elOpts += `<optgroup label="${escapeHtml('Walls' + where)}">${walls}</optgroup>`;
  }
  const prods = productsFor(it);
  const prodChips = prods.map(pr => chip({ label: pr.name + (pr.price ? ' · ' + fmtMoney(pr.price) + '/' + (pr.unit || 'ea') : ''), href: '#/products?select=' + encodeURIComponent(pr.id) }, 'data-unlink-prod', pr.id)).join('');
  const prodOpts = ws.data.products.filter(pr => !prods.includes(pr)).map(pr => `<option value="${escapeHtml(pr.id)}">${escapeHtml(pr.name + (pr.brand ? ' · ' + pr.brand : ''))}</option>`).join('');
  const photos = sitePhotosFor(it);
  return `<div class="item-panel">
    <div class="ip-col">
      <label for="ip-notes-${escapeHtml(it.id)}">Notes</label>
      <textarea id="ip-notes-${escapeHtml(it.id)}" data-inote placeholder="How it was measured, what to check, who quoted it">${escapeHtml(it.notes || '')}</textarea>
    </div>
    <div class="ip-col">
      <label>Model elements</label>
      <div class="ip-chips">${els || '<span class="faint">None linked</span>'}</div>
      ${elOpts ? `<select data-add-el aria-label="Link a room or wall"><option value="">+ Link a room or wall</option>${elOpts}</select>` : ''}
      <label>Products</label>
      <div class="ip-chips">${prodChips || '<span class="faint">None linked</span>'}</div>
      ${prodOpts ? `<select data-add-prod aria-label="Link a product"><option value="">+ Link a product</option>${prodOpts}</select>` : ''}
    </div>
    <div class="ip-col">
      <label for="ip-status-${escapeHtml(it.id)}">Status</label>
      <select id="ip-status-${escapeHtml(it.id)}" data-istatus>${ITEM_STATUSES.map(s => `<option value="${s}" ${s === it.status ? 'selected' : ''}>${ITEM_LABEL[s]}</option>`).join('')}</select>
      <label>Photos</label>
      <div class="ip-photos">${photos.map(ph => `<a href="#/photos?select=${encodeURIComponent(ph.id)}" title="${escapeHtml(ph.name || 'Photo')}">${ph.thumb ? `<img src="${escapeHtml(ph.thumb)}" alt="${escapeHtml(ph.name || 'Photo')}">` : `<span>${escapeHtml(ph.name || 'Photo')}</span>`}</a>`).join('') ||
        '<span class="faint">No photos show this item. Link one in PHOTOS, or link a room or wall it shows.</span>'}</div>
      <div class="ip-actions">
        <a class="btn small" href="#/sheets?item=${encodeURIComponent(it.id)}">${icon('sheets', { size: 13 })}CUT SHEET</a>
        <button type="button" class="btn small" data-research>${icon('search', { size: 13 })}FIND A PRODUCT</button>
      </div>
    </div>
  </div>`;
}

function bindItemRows(p) {
  const det = el.querySelector('#proj-detail');
  det.querySelectorAll('tr[data-item]').forEach(tr => {
    const it = p.items.find(i => i.id === tr.dataset.item);
    if (!it) return;
    const more = det.querySelector(`tr[data-more="${CSS.escape(it.id)}"]`);
    tr.querySelectorAll('[data-if]').forEach(inp => inp.onchange = () => {
      const f = inp.dataset.if;
      it[f] = (f === 'qty' || f === 'durationDays') ? parseFloat(inp.value) || 0 : inp.value;
      touch(); refresh(p);
    });
    // A price that cannot be read keeps the price it had and says why, instead of becoming $0.
    tr.querySelectorAll('[data-money]').forEach(inp => inp.onchange = () => {
      const key = inp.dataset.money, r = readMoney(inp.value);
      if (Number.isNaN(r.value)) {
        moneyProblem = { itemId: it.id, text: r.error + ' The ' + key + ' price of ' + (it.name || 'this item') + ' is still ' + (it[key] ? fmtMoney(it[key]) : 'blank') + '.' };
        refresh(p); return;
      }
      moneyProblem = null;
      it[key] = r.value;
      touch(); refresh(p);
    });
    const setItemStatus = s => {
      it.status = s;
      it.doneAt = s === 'done' ? (it.doneAt || isoToday()) : '';
      touch(); refresh(p);
    };
    tr.querySelector('[data-done]').onchange = e => setItemStatus(e.target.checked ? 'done' : 'todo');
    tr.querySelectorAll('[data-toggle]').forEach(b => b.onclick = () => {
      if (openItems.has(it.id)) openItems.delete(it.id); else openItems.add(it.id);
      renderDetail(p);
    });
    // The summary button opens the listbox in place; leaving it (blur, Escape, Enter) closes
    // it and refreshes the summary from the data.
    const wrap = tr.querySelector('.dep-wrap');
    const deps = wrap.querySelector('[data-deps]');
    const summary = wrap.querySelector('[data-dep-open]');
    const refreshDeps = () => { const s = depSummary(p, it); summary.textContent = s; summary.classList.toggle('none', s === '-'); };
    summary.onclick = () => { wrap.classList.add('open'); deps.focus(); };
    deps.onblur = () => { wrap.classList.remove('open'); refreshDeps(); };
    deps.onkeydown = e => { if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); summary.focus(); } };
    deps.onchange = () => {
      it.deps = Array.from(deps.selectedOptions).map(o => o.value);
      touch(); refreshDeps();
    };
    if (!more) return;
    more.querySelector('[data-inote]').onchange = e => { it.notes = e.target.value; touch(); };
    more.querySelector('[data-istatus]').onchange = e => setItemStatus(e.target.value);
    const addEl = more.querySelector('[data-add-el]');
    if (addEl) addEl.onchange = () => {
      if (!addEl.value) return;
      it.elementIds = [...(it.elementIds || []), addEl.value];
      touch(); refresh(p);
    };
    more.querySelectorAll('[data-unlink-el]').forEach(b => b.onclick = () => {
      it.elementIds = (it.elementIds || []).filter(id => id !== b.dataset.unlinkEl);
      touch(); refresh(p);
    });
    const addProd = more.querySelector('[data-add-prod]');
    if (addProd) addProd.onchange = () => {
      const pr = ws.data.products.find(x => x.id === addProd.value);
      if (!pr) return;
      pr.itemIds = [...new Set([...(pr.itemIds || []), it.id])];
      touch(); refresh(p);
    };
    more.querySelectorAll('[data-unlink-prod]').forEach(b => b.onclick = () => {
      const pr = ws.data.products.find(x => x.id === b.dataset.unlinkProd);
      if (pr) pr.itemIds = (pr.itemIds || []).filter(id => id !== it.id);
      touch(); refresh(p);
    });
    more.querySelector('[data-research]').onclick = async () => {
      const { openResearch } = await import('./research.js');
      openResearch({ kind: 'scope-item', id: it.id, name: it.name, propertyId: p.propertyId, itemIds: [it.id] });
    };
  });
  // PROJECTS has no undo, and on a phone the button sits where a thumb lands: ask first.
  det.querySelectorAll('[data-del-item]').forEach(x => x.onclick = () => {
    const id = x.dataset.delItem, it = p.items.find(i => i.id === id);
    if (!it) return;
    const linked = (it.elementIds || []).length + productsFor(it).length + sitePhotosFor(it).length;
    if (!confirm('Remove "' + (it.name || 'this item') + '" from ' + (p.name || 'this project') + '?' + (linked ? ' Its links to ' + linkSummary(p, it) + ' go with it.' : '') + ' It can be restored from Removed records.')) return;
    keepRemoved(activeProperty(), 'item', [it], p.id);
    p.items = p.items.filter(i => i.id !== id);
    for (const i of p.items) i.deps = (i.deps || []).filter(d => d !== id);
    openItems.delete(id);
    touch(); refresh(p);
  });
}
