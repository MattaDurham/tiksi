// MODEL's component list: a panel floating over the left of the view that lists every object
// (the objects of each imported model, then the plan's walls, floors, ceilings, openings and
// fixtures), each with an eye to hide or show it on its own. A click on a row selects the
// object, and the panel on the right then shows that object and nothing else. Its second tab
// holds the tag list (rename, recolour, show or hide, add and delete tags).
//
// viewer3d.js owns the model; this file only draws the list and reports clicks.
// ctx: { prop, models: [{ scan, tree (model-objects.js; null while not loaded), state }],
//        selected: Set of selected object keys, wholeModel: id of a model selected as a whole,
//        tagsHtml, bindTags(root),
//        select(thing, add), selectModel(scanId), frame(thing), hide(things, on), showAll(),
//        setModelVisible(scanId, on), close() }
// A "thing" is { key, keys (the tag keys it covers), scanId (its model, or null for the plan) }.

import { escapeHtml, fmtLen } from './store.js';
import { icon } from './icons.js';
import { fixtureLabel } from './fixtures.js';
import { trimLabel } from './trims.js';
import { isHidden, tagIdOf, tagById, tagShown, planKey, hiddenKeys, UNTAGGED_LABEL } from './tags.js';

const MAX_ROWS = 400;
const TAB_KEY = 'tiksi.model.listTab';   // the tab last shown, this browser's own
let tab = 'list', filter = '';
try { if (localStorage.getItem(TAB_KEY) === 'tags') tab = 'tags'; } catch { /* this visit only */ }
function setTab(name) { tab = name === 'tags' ? 'tags' : 'list'; try { localStorage.setItem(TAB_KEY, tab); } catch { /* this visit only */ } }
const open = new Set();   // expanded rows and groups, kept while the page lives
export function showListTab(name) { setTab(name); }
export function listTab() { return tab; }
// Open the rows above an object so it can be seen in the list.
export function revealInList(object) { for (let o = object && object.parent; o; o = o.parent) open.add(o.key); }

const plural = (n, one, many) => n + ' ' + (n === 1 ? one : (many || one + 's'));

// ---------- the plan's objects ----------
const PLAN_GROUPS = [
  ['wall', 'Walls'], ['room', 'Floors'], ['ceiling', 'Ceilings'], ['opening', 'Doors and windows'], ['fixture', 'Fixtures and furniture'], ['trim', 'Wall trim'],
];
export function planThings(prop) {
  const many = (prop.levels || []).length > 1;
  const level = id => many ? ((prop.levels || []).find(l => l.id === id) || {}).name || '' : '';
  const out = { wall: [], room: [], ceiling: [], opening: [], fixture: [], trim: [] };
  const thing = (kind, id, name, note, sel) => ({ key: planKey(kind, id), keys: [planKey(kind, id)], scanId: null, name, note, sel });
  for (const w of prop.walls || []) out.wall.push(thing('wall', w.id, 'Wall ' + fmtLen(Math.hypot(w.bx - w.ax, w.by - w.ay)), level(w.level), { kind: 'wall', id: w.id }));
  for (const r of prop.rooms || []) {
    out.room.push(thing('room', r.id, (r.name || 'Room') + ' floor', level(r.level), { kind: 'room', id: r.id }));
    out.ceiling.push(thing('ceiling', r.id, (r.name || 'Room') + ' ceiling', level(r.level), { kind: 'room', id: r.id, tagKey: planKey('ceiling', r.id) }));
  }
  for (const o of prop.openings || []) out.opening.push(thing('opening', o.id, (o.type === 'window' ? 'Window ' : 'Door or opening ') + fmtLen(o.width), '', { kind: 'opening', id: o.id }));
  for (const f of prop.fixtures || []) out.fixture.push(thing('fixture', f.id, f.name || fixtureLabel(f) || 'Fixture', level(f.level), { kind: 'fixture', id: f.id }));
  for (const t of prop.trims || []) out.trim.push(thing('trim', t.id, trimLabel(t), level(t.level), { kind: 'trim', id: t.id }));
  return out;
}
// A model object as a thing.
export function objectThing(scanId, o) {
  return { key: o.key, keys: o.meshKeys, scanId, name: o.name, sel: { kind: 'scan', id: scanId, tagKey: o.meshKeys[0], objectKey: o.key } };
}

// ---------- rows ----------
// 'hidden' when every key of the thing is hidden, 'part' when some are, else 'shown'.
export function hiddenState(prop, keys) {
  let n = 0;
  for (const k of keys) if (isHidden(prop, k)) n++;
  return !n ? 'shown' : n === keys.length ? 'hidden' : 'part';
}
function tagDot(prop, keys) {
  const id = tagIdOf(prop, keys[0]) || '';
  for (const k of keys) if ((tagIdOf(prop, k) || '') !== id) return { color: '', name: 'several tags', off: false };
  const t = tagById(prop, id);
  return { color: t ? t.color : '', name: t ? t.name : UNTAGGED_LABEL, off: !tagShown(prop, id) };
}
function row(ctx, thing, depth, opts = {}) {
  const { prop } = ctx;
  const state = hiddenState(prop, thing.keys), tag = tagDot(prop, thing.keys);
  const off = state === 'hidden';
  const title = off ? 'Show ' + thing.name : 'Hide ' + thing.name;
  return `<div class="ol-row ${ctx.selected.has(thing.key) ? 'active' : ''} ${off ? 'off' : ''} ${tag.off && !off ? 'tag-off' : ''}" data-ol-row="${escapeHtml(thing.key)}" style="--d:${depth}">
    <button class="ol-eye ${off ? '' : 'on'}" data-ol-eye="${escapeHtml(thing.key)}" aria-pressed="${!off}" title="${escapeHtml(title)}${state === 'part' ? ' (part of it is hidden)' : ''}">${icon(off ? 'eye-off' : 'eye')}</button>
    ${opts.kids ? `<button class="ol-fold" data-ol-fold="${escapeHtml(thing.key)}" aria-expanded="${open.has(thing.key)}" title="${open.has(thing.key) ? 'Close' : 'Show what is inside'}">${icon(open.has(thing.key) ? 'chevron-down' : 'chevron-right')}</button>` : '<span class="ol-fold"></span>'}
    <button class="ol-name" data-ol-pick="${escapeHtml(thing.key)}" title="${escapeHtml(thing.name + (opts.note ? ' · ' + opts.note : '') + (tag.off && !off ? ' · its tag ' + tag.name + ' is hidden' : ''))}"><span>${escapeHtml(thing.name)}</span>${opts.note ? `<i>${escapeHtml(opts.note)}</i>` : ''}</button>
    <span class="ol-tag" title="${escapeHtml(tag.name)}" style="${tag.color ? 'background:' + escapeHtml(tag.color) : ''}"></span>
  </div>`;
}

// The list as html, and the things it shows by key (for the click handlers).
function listHtml(ctx) {
  const { prop } = ctx;
  const things = new Map();
  const q = filter.trim().toLowerCase();
  let rows = 0, cut = 0;
  const put = (thing, depth, opts) => {
    if (rows >= MAX_ROWS) { cut++; return ''; }
    rows++; things.set(thing.key, thing);
    return row(ctx, thing, depth, opts);
  };
  const noteOf = o => [o.component && o.component !== o.name ? o.component : '', o.children.length ? plural(o.children.length, 'object') + ' inside' : ''].filter(Boolean).join(' · ');
  const matches = (name, extra) => (name + ' ' + (extra || '')).toLowerCase().includes(q);
  let html = '';
  for (const m of ctx.models) {
    const { scan, tree } = m;
    const count = tree && !tree.whole ? tree.byKey.size : 0;
    const shown = scan.visible !== false;
    const head = `<div class="ol-head ${ctx.wholeModel === scan.id ? 'active' : ''} ${shown ? '' : 'off'}">
      <button class="ol-eye ${shown ? 'on' : ''}" data-ol-model-eye="${escapeHtml(scan.id)}" aria-pressed="${shown}" title="${shown ? 'Hide' : 'Show'} the whole model ${escapeHtml(scan.name)}">${icon(shown ? 'eye' : 'eye-off')}</button>
      <button class="ol-name" data-ol-model="${escapeHtml(scan.id)}" title="Select the whole model: its position, materials and components"><span>${escapeHtml(scan.name)}</span><i>${tree ? (count ? plural(count, 'object') : 'one object') : escapeHtml(m.state || 'loading')}</i></button>
    </div>`;
    let body = '';
    if (tree && !tree.whole) {
      if (q) {
        for (const o of tree.byKey.values()) if (matches(o.name, o.component)) body += put(objectThing(scan.id, o), 0, { note: [o.component !== o.name ? o.component : '', o.parent ? 'in ' + o.parent.name : ''].filter(Boolean).join(' · ') });
      } else {
        const walk = (list, depth) => { for (const o of list) { body += put(objectThing(scan.id, o), depth, { kids: o.children.length > 0, note: noteOf(o) }); if (o.children.length && open.has(o.key)) walk(o.children, depth + 1); } };
        walk(tree.roots, 0);
      }
    }
    if (!q || body || matches(scan.name)) html += head + body;
  }
  const plan = planThings(prop);
  for (const [kind, label] of PLAN_GROUPS) {
    const list = q ? plan[kind].filter(t => matches(t.name, label)) : plan[kind];
    if (!list.length) continue;
    const key = 'plan:' + kind, isOpen = !!q || open.has(key);
    const off = list.filter(t => isHidden(prop, t.key)).length;
    html += `<div class="ol-head"><button class="ol-fold" data-ol-fold="${key}" aria-expanded="${isOpen}">${icon(isOpen ? 'chevron-down' : 'chevron-right')}</button>
      <button class="ol-name" data-ol-fold="${key}"><span>${label}</span><i>${list.length}${off ? ' · ' + off + ' hidden' : ''}</i></button></div>`;
    if (isOpen) for (const t of list) html += put(t, 0, { note: t.note });
  }
  if (!html) html = `<p class="ol-empty">${q ? 'Nothing matches.' : 'Nothing in this model yet.'}</p>`;
  if (cut) html += `<p class="ol-empty">${plural(cut, 'more row')} not listed. Type in the box above to find one.</p>`;
  return { html, things };
}

export function objectListHtml(ctx) {
  const hidden = hiddenKeys(ctx.prop).length;
  const head = `<div class="ol-tabs" role="tablist">
      <button role="tab" class="${tab === 'list' ? 'active' : ''}" aria-selected="${tab === 'list'}" data-ol-tab="list">COMPONENTS</button>
      <button role="tab" class="${tab === 'tags' ? 'active' : ''}" aria-selected="${tab === 'tags'}" data-ol-tab="tags">TAGS</button>
      <button class="ol-close" data-ol-close title="Take this list off the screen. The Tiksi menu (top left) brings it back.">${icon('close')}</button>
    </div>`;
  if (tab === 'tags') return { html: head + `<div class="ol-body v-tags">${ctx.tagsHtml}</div>`, things: new Map() };
  const list = listHtml(ctx);
  return { things: list.things, html: head + `
    <div class="ol-tools"><input type="search" class="search-input" data-ol-filter placeholder="find an object..." value="${escapeHtml(filter)}" aria-label="Find an object"></div>
    ${hidden ? `<div class="ol-hidden"><span>Some objects are hidden</span><button class="link-btn" data-ol-show-all title="Show every object that was hidden on its own (Shift+H)">SHOW ALL HIDDEN</button></div>` : ''}
    <div class="ol-body" data-ol-list>${list.html}</div>
    <p class="ol-foot">Click selects one object; the eye hides only that object. Double-click an object in the model to go inside it.</p>` };
}

export function renderObjectList(root, ctx) {
  if (!root) return;
  const keep = root.querySelector('[data-ol-list]');
  const top = keep ? keep.scrollTop : 0;
  const focused = document.activeElement && document.activeElement.matches && document.activeElement.matches('[data-ol-filter]');
  const { html, things } = objectListHtml(ctx);
  root.innerHTML = html;
  const again = () => renderObjectList(root, ctx.refresh ? ctx.refresh() : ctx);
  root.querySelectorAll('[data-ol-tab]').forEach(b => b.onclick = () => { setTab(b.dataset.olTab); again(); });
  root.querySelector('[data-ol-close]').onclick = () => ctx.close();
  if (tab === 'tags') { ctx.bindTags(root); return; }
  const list = root.querySelector('[data-ol-list]');
  list.scrollTop = top;
  const f = root.querySelector('[data-ol-filter]');
  f.oninput = () => { filter = f.value; again(); };
  if (focused) { const nf = root.querySelector('[data-ol-filter]'); nf.focus(); nf.setSelectionRange(nf.value.length, nf.value.length); }
  const all = root.querySelector('[data-ol-show-all]');
  if (all) all.onclick = () => ctx.showAll();
  root.querySelectorAll('[data-ol-fold]').forEach(b => b.onclick = () => { const k = b.dataset.olFold; if (open.has(k)) open.delete(k); else open.add(k); again(); });
  root.querySelectorAll('[data-ol-eye]').forEach(b => b.onclick = () => { const t = things.get(b.dataset.olEye); if (t) ctx.hide([t], hiddenState(ctx.prop, t.keys) !== 'hidden'); });
  root.querySelectorAll('[data-ol-pick]').forEach(b => {
    b.onclick = e => { const t = things.get(b.dataset.olPick); if (t) ctx.select(t, e.shiftKey); };
    b.ondblclick = () => { const t = things.get(b.dataset.olPick); if (t) ctx.frame(t); };
  });
  root.querySelectorAll('[data-ol-model]').forEach(b => b.onclick = () => ctx.selectModel(b.dataset.olModel));
  root.querySelectorAll('[data-ol-model-eye]').forEach(b => b.onclick = () => ctx.setModelVisible(b.dataset.olModelEye, b.getAttribute('aria-pressed') !== 'true'));
  const active = list.querySelector('.ol-row.active');
  if (active && ctx.reveal) active.scrollIntoView({ block: 'nearest' });
}
