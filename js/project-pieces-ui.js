// The PROJECT block of the MODEL inspector (project-pieces.js): which project the selected
// pieces belong to, and GROUP, which makes the selection one subproject so a click on any of
// its pieces selects them all. HTML builder and binder; the viewer passes a context.

import { escapeHtml, uid, isoToday } from './store.js';
import { projectChoices, groupOf, pieceProjectId, topProjectId } from './project-pieces.js';

const NEW = '__new__';

// ctx: { projects, propId, records (the selected pieces' records), kindLabel ('trim section'),
//        assign(projectId), group({ name, parentId, newParentName }), selectOne() | null }
export function projectBlockHtml(ctx) {
  const { projects, propId, records } = ctx;
  if (!records.length) return '';
  const choices = projectChoices(projects, propId);
  const ids = new Set(records.map(pieceProjectId));
  const current = ids.size === 1 ? [...ids][0] : undefined;
  const groups = new Set(records.map(r => (groupOf(projects, r) || {}).id || ''));
  const group = groups.size === 1 && current ? groupOf(projects, records[0]) : null;
  const tops = projects.filter(p => p.propertyId === propId && !p.parentId);
  const n = records.length, what = n === 1 ? ctx.kindLabel : n + ' ' + ctx.kindLabel + 's';
  const parentDefault = current ? topProjectId(projects, current) : (tops[0] || {}).id || NEW;
  const opts = choices.map(c => `<option value="${escapeHtml(c.id)}" ${c.id === current ? 'selected' : ''}>${c.depth ? '&nbsp;&nbsp;' : ''}${escapeHtml(c.label)}</option>`).join('');
  return `<div class="tp-sub">PROJECT</div>
    ${group ? `<div class="stat-line"><span>Group: ${escapeHtml(group.name || 'Untitled')}</span><b>${n} ${escapeHtml(ctx.kindLabel)}${n === 1 ? '' : 's'}</b></div>
      <div class="empty" style="margin:2px 0 6px">A click on any piece of this group selects the whole group. Alt-click picks one piece on its own.</div>` : ''}
    <div class="field"><label>Belongs to</label><select data-pp-project>${current === undefined ? '<option value="" selected disabled>(several)</option>' : ''}${opts}</select></div>
    <details class="pp-group"${ctx.openGroup ? ' open' : ''}><summary>GROUP ${escapeHtml(what.toUpperCase())} AS A SUBPROJECT</summary>
      <div class="field"><label>Group name</label><input type="text" data-pp-name placeholder="Entry and hall"></div>
      <div class="field"><label>In project</label><select data-pp-parent>${tops.map(p => `<option value="${escapeHtml(p.id)}" ${p.id === parentDefault ? 'selected' : ''}>${escapeHtml(p.name || 'Untitled project')}</option>`).join('')}<option value="${NEW}" ${parentDefault === NEW ? 'selected' : ''}>New project…</option></select></div>
      <div class="field" data-pp-newwrap ${parentDefault === NEW ? '' : 'hidden'}><label>New project name</label><input type="text" data-pp-newname placeholder="Wall trim"></div>
      <button class="btn" data-pp-group>GROUP ${escapeHtml(what.toUpperCase())}</button>
    </details>
    ${ctx.selectOne && n > 1 && group ? '<button class="btn" data-pp-one>SELECT ONLY THE PIECE I CLICKED</button>' : ''}`;
}

export function bindProjectBlock(root, ctx) {
  const q = s => root.querySelector(s);
  const sel = q('[data-pp-project]');
  if (!sel) return;
  sel.onchange = () => ctx.assign(sel.value);
  const parent = q('[data-pp-parent]'), wrap = q('[data-pp-newwrap]');
  if (parent && wrap) parent.onchange = () => { wrap.hidden = parent.value !== NEW; };
  const go = q('[data-pp-group]');
  if (go) go.onclick = () => {
    const name = q('[data-pp-name]').value.trim();
    if (!name) { q('[data-pp-name]').focus(); return; }
    const isNew = parent.value === NEW;
    const newParentName = isNew ? (q('[data-pp-newname]').value.trim() || 'Model groups') : '';
    ctx.group({ name, parentId: isNew ? '' : parent.value, newParentName });
  };
  const one = q('[data-pp-one]');
  if (one) one.onclick = () => ctx.selectOne();
}

// A project record shaped like the ones PROJECTS makes (projects.js newProject).
export function newProjectRecord(propId, name, fields = {}) {
  return Object.assign({
    id: uid('proj'), name, propertyId: propId,
    category: 'interior', status: 'idea', selected: false, startDate: isoToday(), notes: '', items: [],
    parentId: '', priority: '', roomId: '', source: 'MODEL group',
  }, fields);
}
