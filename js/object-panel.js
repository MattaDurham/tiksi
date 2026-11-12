// MODEL's right-hand panel for one object of an imported model, and for several objects
// selected together: what the object is, its tag (change it, or make a new tag), hiding it,
// moving it, its product, and what is inside it. Nothing about the rest of the model: the
// whole model's own panel (position, materials, component schedule) is one click away.
//
// viewer3d.js owns the model; this file draws the panel and reports what was asked.
// ctx for one object:
//   { prop, scan, tree, object (model-objects.js), tagOptions (html of the tag choices),
//     hidden ('shown' | 'hidden' | 'part'), tagOff (name of its hidden tag, or ''), offset
//     [x, y, z] metres, moving (the MOVE tool is on), productHtml,
//     setTag(value), hide(on), frame(), selectObjects(objects), selectModel(), moveTo(offset),
//     startMove() }
// ctx for several: { prop, count, names, tagOptions, hidden, movable, setTag, hide, frame }

import { escapeHtml, fmtLen, parseLen } from './store.js';
import { KIND_LABELS, sameComponent } from './model-objects.js';

const plural = (n, one, many) => n + ' ' + (n === 1 ? one : (many || one + 's'));

function tagFieldHtml(ctx, label) {
  return `<div class="field"><label>${label}</label><select data-tag-pick title="Choose another tag, or New tag... to make one">${ctx.tagOptions}</select></div>`;
}
function hideHtml(ctx, what) {
  const off = ctx.hidden === 'hidden';
  return `${ctx.tagOff && !off ? `<p class="empty">Not drawn now: its tag ${escapeHtml(ctx.tagOff)} is hidden.</p>` : ''}
    <button class="btn" data-obj-hide="${off ? 'show' : 'hide'}" title="${off ? 'Show' : 'Hide'} only ${what}; its tag and everything else on that tag stay as they are (H)">${off ? 'SHOW' : 'HIDE'}${ctx.hidden === 'part' ? ' ALL OF IT' : ''}</button>`;
}

export function objectPanelHtml(ctx) {
  const { scan, tree, object: o } = ctx;
  const same = sameComponent(tree, o);
  const chain = [];
  for (let p = o.parent; p; p = p.parent) chain.unshift(p);
  const crumbs = [`<button class="link-btn" data-obj-model title="The whole model: position, materials, component schedule">${escapeHtml(scan.name)}</button>`,
    ...chain.map(p => `<button class="link-btn" data-obj-go="${escapeHtml(p.key)}">${escapeHtml(p.name)}</button>`)].join(' &rsaquo; ');
  const facts = [];
  if (o.kind === 'component') {
    if (o.component !== o.name) facts.push(['Definition', o.component]);
    facts.push(['In this model', same.length > 1 ? (same.indexOf(o) + 1) + ' of ' + same.length : 'the only one']);
  }
  if (o.children.length) facts.push(['Inside it', plural(o.children.length, 'object')]);
  const [x, y, z] = ctx.offset;
  const movedNow = Math.abs(x) + Math.abs(y) + Math.abs(z) > 1e-6;
  return `<h3>${KIND_LABELS[o.kind].toUpperCase()}</h3>
    <div class="op-name">${escapeHtml(o.name)}</div>
    <div class="op-crumbs">in ${crumbs}</div>
    ${facts.map(([k, v]) => `<div class="stat-line"><span>${escapeHtml(k)}</span><b>${escapeHtml(v)}</b></div>`).join('')}
    ${tagFieldHtml(ctx, 'Tag')}
    ${hideHtml(ctx, 'this object')}
    <button class="btn" data-obj-frame>ZOOM TO IT</button>
    ${same.length > 1 ? `<button class="btn" data-obj-same title="Select every ${escapeHtml(o.component)} in this model, to tag or hide them together">SELECT ALL ${same.length}</button>` : ''}
    <h3>MOVE</h3>
    <p class="empty">How far it stands from where the model file has it. ${ctx.moving ? 'Drag an arrow in the view to move it.' : ''}</p>
    <div class="field"><label>Across (X)</label><input type="text" data-obj-off="0" value="${escapeHtml(fmtLen(x))}"></div>
    <div class="field"><label>Up</label><input type="text" data-obj-off="1" value="${escapeHtml(fmtLen(y))}"></div>
    <div class="field"><label>Along (Z)</label><input type="text" data-obj-off="2" value="${escapeHtml(fmtLen(z))}"></div>
    ${ctx.moving ? '' : '<button class="btn" data-obj-move title="Show arrows on the object and drag them (M)">MOVE IT IN THE VIEW</button>'}
    ${movedNow ? '<button class="btn" data-obj-reset>PUT IT BACK</button>' : ''}
    ${ctx.productHtml || ''}
    ${o.children.length ? `<h3>INSIDE IT</h3>${o.children.slice(0, 60).map(c => `<button class="btn op-child" data-obj-go="${escapeHtml(c.key)}">${escapeHtml(c.name)}</button>`).join('')}${o.children.length > 60 ? `<p class="empty">${o.children.length - 60} more in the component list.</p>` : ''}` : ''}`;
}

export function bindObjectPanel(root, ctx) {
  const { tree, object: o } = ctx;
  const q = s => root.querySelector(s);
  bindCommon(root, ctx);
  q('[data-obj-model]').onclick = () => ctx.selectModel();
  root.querySelectorAll('[data-obj-go]').forEach(b => b.onclick = () => { const t = tree.byKey.get(b.dataset.objGo); if (t) ctx.selectObjects([t]); });
  const same = q('[data-obj-same]');
  if (same) same.onclick = () => ctx.selectObjects(sameComponent(tree, o));
  root.querySelectorAll('[data-obj-off]').forEach(i => i.onchange = () => {
    const next = ctx.offset.slice(), v = parseLen(i.value, 'feet');
    if (Number.isFinite(v)) { next[+i.dataset.objOff] = v; ctx.moveTo(next); } else ctx.moveTo(next);
  });
  const mv = q('[data-obj-move]');
  if (mv) mv.onclick = () => ctx.startMove();
  const reset = q('[data-obj-reset]');
  if (reset) reset.onclick = () => ctx.moveTo([0, 0, 0]);
}
function bindCommon(root, ctx) {
  const pick = root.querySelector('[data-tag-pick]');
  if (pick) pick.onchange = () => { if (pick.value !== '__mixed') ctx.setTag(pick.value); };
  const hide = root.querySelector('[data-obj-hide]');
  if (hide) hide.onclick = () => ctx.hide(hide.dataset.objHide === 'hide');
  const frame = root.querySelector('[data-obj-frame]');
  if (frame) frame.onclick = () => ctx.frame();
}

// Several objects selected together (Shift-click, or SELECT ALL of one component).
export function multiPanelHtml(ctx) {
  const shown = ctx.names.slice(0, 8);
  return `<h3>${ctx.count} OBJECTS</h3>
    <div class="op-crumbs">${shown.map(escapeHtml).join(', ')}${ctx.names.length > shown.length ? ' and ' + (ctx.names.length - shown.length) + ' more' : ''}</div>
    ${tagFieldHtml(ctx, 'Tag (changes all ' + ctx.count + ')')}
    ${hideHtml(ctx, 'these objects')}
    <button class="btn" data-obj-frame>ZOOM TO THEM</button>
    <p class="empty">Shift-click an object to add it or take it out. Click one object to see only that one.${ctx.movable ? ' The MOVE tool (M) moves them together.' : ''}</p>`;
}
export function bindMultiPanel(root, ctx) { bindCommon(root, ctx); }

// The tag line and the hide button for a plan object (a wall, a floor, a door, a fixture),
// put under the heading of its own panel.
export function planTagHtml(ctx) {
  return `${tagFieldHtml(ctx, 'Tag')}${hideHtml(ctx, 'this object')}`;
}
export function bindPlanTag(root, ctx) { bindCommon(root, ctx); }
