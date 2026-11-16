// The MODEL inspector for wall trim (trims.js): one section or several selected together.
// CHANGES REACH says how far a change here goes (trim-design.js): the sections selected, their
// group, the whole room or the whole project. Under it: the moulding of each kind of trim in
// the selection as a dropdown, the heights, the panel layout (the box width aimed for, the gap,
// the margins, rows), and the trim catalog (trim-catalog.js) as a list to scroll through: a
// click on an entry, or the arrow keys while the list has focus, swaps the trim to that entry.
// HTML builders and a binder; the viewer passes a context of callbacks (viewer3d.js).

import { escapeHtml, fmtLen, parseLen, fmtMoney } from './store.js';
import { materialSelectHtml } from './materials.js';
import { TRIM_STYLES, STYLE_GROUPS, trimStyle, trimProduct, trimLabel, isField, catalogInOrder } from './trims.js';
import { CROWN_PRESETS, WAINSCOT_PRESETS, FRAME_PRESETS } from './trim-presets.js';
import { trimCutaway, trimElevation } from './trim-previews.js';
import { catalogFor, catalogItem } from './trim-catalog.js';

const IN = 0.0254;
let groupFilter = '';            // the catalog's group filter, kept between selections
let listScroll = 0;              // and where the list was scrolled to

function inches(m) { return Math.round(m / IN * 16) / 16; }
function frac(v) {
  const whole = Math.floor(v + 1e-9), rest = Math.round((v - whole) * 16);
  if (!rest) return String(whole);
  let n = rest, d = 16;
  while (n % 2 === 0) { n /= 2; d /= 2; }
  return (whole ? whole + '-' : '') + n + '/' + d;
}
// A product's size as the store sells it: thickness x width in inches.
export function sizeLabel(p) {
  if (!p) return '';
  if (p.size) return p.size;
  return frac(inches(p.T)) + ' x ' + frac(inches(p.W)) + ' in';
}

function productCardHtml(p, opts = {}) {
  if (!p) return '<div class="empty">No catalog entry.</div>';
  const price = p.price ? `${fmtMoney(p.price)}${p.priceUnit ? ' / ' + escapeHtml(p.priceUnit) : ''}` : '';
  return `<div class="tp-product">
    ${trimCutaway(p)}
    <div class="tp-product-text">
      <b>${escapeHtml(p.brand)} ${escapeHtml(p.model || '')}</b>
      <span>${escapeHtml(p.title)}</span>
      <span class="tp-meta">${escapeHtml(sizeLabel(p))} &middot; ${escapeHtml(p.material || '')}${price ? ' &middot; ' + price : ''}</span>
      <span class="tp-meta">${escapeHtml(p.store || '')}${p.sku ? ' item ' + escapeHtml(p.sku) : ''}${p.url ? ` &middot; <a href="${escapeHtml(p.url)}" target="_blank" rel="noopener">product page</a>` : ''}</span>
      ${p.specUrl ? `<span class="tp-meta"><a href="${escapeHtml(p.specUrl)}" target="_blank" rel="noopener">Manufacturer specification</a></span>` : ''}
      ${p.panelUrl ? `<span class="tp-meta"><a href="${escapeHtml(p.panelUrl)}" target="_blank" rel="noopener">Panel sheet</a> &middot; ${escapeHtml(fmtLen(p.panelThickness))} thick</span>` : ''}
      ${opts.evidence && p.evidence ? `<span class="tp-meta tp-evidence">${escapeHtml(p.evidence)}</span>` : ''}
    </div>
  </div>`;
}

function catalogHtml(current) {
  const items = catalogInOrder().filter(p => !groupFilter || (TRIM_STYLES[p.style] || {}).group === groupFilter);
  let lastStyle = '';
  const rows = items.map(p => {
    const head = p.style !== lastStyle ? `<div class="tp-cat-head">${escapeHtml((TRIM_STYLES[p.style] || {}).label || p.style)}</div>` : '';
    lastStyle = p.style;
    const on = current.has(p.id);
    return `${head}<button type="button" class="tp-cat-item${on ? ' active' : ''}" data-cat="${escapeHtml(p.id)}" title="${escapeHtml(p.title)}">
      ${trimCutaway(p)}
      <span class="tp-cat-text"><b>${escapeHtml(p.short || p.title)}</b><span>${escapeHtml(p.brand)} ${escapeHtml(p.model || '')} &middot; ${escapeHtml(sizeLabel(p))}</span>
      <span>${escapeHtml(p.store || '')}${p.price ? ' &middot; ' + fmtMoney(p.price) + (p.priceUnit ? '/' + escapeHtml(p.priceUnit) : '') : ''}</span></span>
    </button>`;
  }).join('');
  return `<div class="tp-cat">
    <div class="tp-cat-filter">${['', ...STYLE_GROUPS].map(g => `<button type="button" class="tp-chip${g === groupFilter ? ' active' : ''}" data-group="${escapeHtml(g)}">${escapeHtml(g || 'All')}</button>`).join('')}</div>
    <div class="tp-cat-list" tabindex="0" data-cat-list aria-label="Trim catalog: arrow keys swap the selected trim">${rows || '<div class="empty">Nothing in this group.</div>'}</div>
    <div class="empty" style="margin:4px 0 0">Click an entry to swap the selected trim to it. With the list focused, the up and down arrows step through it live.</div>
  </div>`;
}

const same = (list, f) => { const v = list.map(f); return v.every(x => x === v[0]) ? v[0] : undefined; };
const lenField = (label, key, value, ph, attr = 'data-len') => `<div class="field"><label>${escapeHtml(label)}</label><input type="text" ${attr}="${key}" value="${value === undefined || value === null ? '' : escapeHtml(fmtLen(value))}" placeholder="${escapeHtml(ph || (value === undefined ? 'several' : ''))}"></div>`;

function presetPicker(label, key, choices, selected, preview, hint = '') {
  const detail = choices.find(([, id]) => id === selected)?.[0] || hint;
  return `<details class="tp-picker" data-picker="${key}">
    <summary>${escapeHtml(label)} ${detail ? `<span>${escapeHtml(detail)}</span>` : ''}</summary>
    <div class="tp-picker-options">${choices.map(([name, id]) => `<button type="button" data-choice="${id}" aria-pressed="${id === selected}">${preview(id)}<span>${escapeHtml(name)}</span></button>`).join('')}</div>
  </details>`;
}
const crownPicker = id => presetPicker('Crown style', 'crown', CROWN_PRESETS, id, key => trimCutaway(catalogItem(key)));
const wainscotPicker = id => presetPicker('Wainscoting style', 'wainscot', WAINSCOT_PRESETS, id, key => trimElevation(catalogItem(key)));
const frameChoices = [['Custom', ''], ...Object.entries(FRAME_PRESETS).sort().map(([id, preset]) => [id + ' · ' + preset.label, id])];
const framePicker = (id, product) => presetPicker('Picture-frame layout', 'frame', frameChoices, id, key => trimElevation(product, key), 'Several layouts');

function stylePickersHtml(ctx) {
  const crown = ctx.reach.filter(t => t.style === 'crown');
  const wainscot = ctx.reach.filter(isField);
  const frames = wainscot.filter(t => t.style === 'picture-frame');
  return [
    crown.length ? crownPicker(same(crown, t => t.product)) : '',
    wainscot.length ? wainscotPicker(WAINSCOT_PRESETS.find(([, id]) => catalogItem(id).style === same(wainscot, t => t.style))?.[1]) : '',
    frames.length ? framePicker(same(frames, t => t.frameLayout || ''), trimProduct(frames[0])) : '',
  ].join('');
}

// How far a change reaches, as four buttons with what each covers.
function scopeHtml(ctx) {
  const now = ctx.scopes.find(x => x.id === ctx.scope) || ctx.scopes[0];
  return `<div class="tp-sub">CHANGES REACH</div>
    <div class="tp-scope" role="radiogroup" aria-label="How far a change to this trim reaches">${ctx.scopes.map(x => `<button type="button" role="radio" aria-checked="${x.id === ctx.scope}" class="tp-scope-btn${x.id === ctx.scope ? ' active' : ''}" data-scope="${x.id}" title="${escapeHtml(x.title)}">${escapeHtml(x.label)}<span>${x.count}</span></button>`).join('')}</div>
    <div class="empty tp-scope-note">${escapeHtml(now.title)}</div>`;
}
// One dropdown for each kind of trim in the selection: the moulding it is made of.
function mouldingsHtml(ctx) {
  const styles = Object.keys(TRIM_STYLES).filter(k => ctx.trims.some(t => t.style === k));
  return `<div class="tp-sub">MOULDINGS</div>` + styles.map(k => {
    const mine = ctx.reach.filter(t => t.style === k);
    const ids = new Set(mine.map(t => t.product));
    const cur = ids.size === 1 ? [...ids][0] : '';
    const items = catalogFor(k);
    const options = (cur ? '' : '<option value="" selected>(several)</option>') + items.map(p => `<option value="${escapeHtml(p.id)}" ${p.id === cur ? 'selected' : ''}>${escapeHtml(p.short || p.title)} (${escapeHtml(p.brand)} ${escapeHtml(p.model || '')}, ${escapeHtml(sizeLabel(p))})</option>`).join('')
      + (cur && !items.some(p => p.id === cur) ? `<option value="${escapeHtml(cur)}" selected>${escapeHtml(cur)}</option>` : '');
    return `<div class="field"><label>${escapeHtml(TRIM_STYLES[k].label)} (${mine.length} ${mine.length === 1 ? 'section' : 'sections'})</label><select data-role-product="${k}">${options}</select></div>`;
  }).join('');
}
// The layout numbers of boxes, panels and bays: one set for every section the change reaches.
function layoutHtml(ctx, one) {
  const list = ctx.trims, vals = list.map(ctx.values);
  if (!vals.every(v => v && (v.boxes || v.bays)) || new Set(list.map(t => t.style)).size !== 1) return '';
  const v = vals[0], sameV = k => same(vals, x => x[k]);
  const preset = v.frame && ctx.reach.some(t => t.style === 'picture-frame' && t.frameLayout);
  const fitted = fmtLen(v.aim || 0);
  let html = `<div class="tp-sub">PANEL LAYOUT (${ctx.reach.length} ${ctx.reach.length === 1 ? 'SECTION' : 'SECTIONS'})</div>
    <div class="field-row">
      ${preset ? '' : `<div class="field"><label>${v.bays ? 'Batten spacing to aim for' : 'Box width to aim for'}</label><input type="text" data-design="aim" value="${vals.every(x => x.aimSet) && sameV('aim') !== undefined ? escapeHtml(fmtLen(v.aim)) : ''}" placeholder="${vals.every(x => x.aimSet) ? 'several' : escapeHtml(v.aim ? fitted : 'square')}" title="Each stretch of wall takes the whole number of equal ${v.bays ? 'bays' : 'boxes'} that comes closest to this. Blank goes back to the usual width."></div>`}
      ${v.frame ? lenField('Gap between boxes', 'gap', sameV('gap'), '', 'data-design') : ''}
    </div>`;
  if (v.frame) {
    html += `<div class="field-row">${lenField('Margin at ends', 'sides', sameV('sides'), '', 'data-design')}${lenField('Above', 'top', sameV('top'), '', 'data-design')}${lenField('Below', 'bottom', sameV('bottom'), '', 'data-design')}</div>
      <button class="btn" data-reveal title="Sets the margins at the ends, above and below equal to the gap between boxes: one reveal all round, the usual practice.">ONE REVEAL ALL ROUND</button>`;
  }
  html += `<div class="field-row">
      ${!preset && (v.boxes || list[0].style === 'grid') ? `<div class="field"><label>Rows</label><input type="number" min="1" max="12" step="1" data-design-int="rows" value="${sameV('rows') || ''}" placeholder="several"></div>` : ''}
      ${v.frame ? `<div class="field"><label>Leave out boxes narrower than</label><input type="text" data-design="minBox" value="${sameV('minBox') ? escapeHtml(fmtLen(v.minBox)) : ''}" placeholder="no limit" title="A stretch of wall whose boxes would be narrower than this is left plain."></div>` : ''}
    </div>`;
  const sum = ctx.summary;
  if (sum.boxes) {
    const range = (a, b) => Math.abs(a - b) < .0008 ? fmtLen(a) : fmtLen(a) + ' to ' + fmtLen(b);
    html += `<div class="stat-line"><span>${v.bays ? 'Bays' : 'Boxes'}</span><b>${sum.boxes} on ${sum.sections} ${sum.sections === 1 ? 'section' : 'sections'}</b></div>
      <div class="stat-line"><span>Widths</span><b>${escapeHtml(range(sum.min, sum.max))}</b></div>
      <div class="stat-line"><span>Heights</span><b>${escapeHtml(range(sum.hMin, sum.hMax))}</b></div>
      ${sum.empty ? `<div class="stat-line"><span>Stretches left plain</span><b>${sum.empty}</b></div>` : ''}`;
  }
  html += ctx.notes.map(n => `<div class="empty tp-note">${escapeHtml(n)}</div>`).join('');
  if (!preset && vals.some(x => x.pinned)) html += `<button class="btn" data-fit title="Counts and widths set by hand go back to fitting the width aimed for.">FIT THE PANELS AGAIN</button>`;
  if (!preset && one) {
    const lay = ctx.layoutOf(one), st = ctx.stretches(one);
    if (st.length) {
      html += `<div class="tp-sub">${st.length > 1 ? 'PANELS IN EACH STRETCH OF THIS WALL' : 'PANELS ON THIS WALL'} (BLANK = FIT)</div>
        <div class="tp-widths">${st.map((x, i) => `<input type="number" min="${v.frame ? 0 : 1}" max="60" step="1" data-stretch="${i}" value="${one.colsAt && one.colsAt[i] != null ? one.colsAt[i] : st.length === 1 && one.cols ? one.cols : ''}" placeholder="${x.n}" title="Stretch ${i + 1}, ${escapeHtml(fmtLen(x.w))} wide">`).join('')}</div>`;
    }
    // The boxes of the first full stretch, left to right: type a width; the others share the rest.
    const first = lay.boxes.filter(b => b.row === 0 && lay.rects[b.rect] && lay.rects[b.rect].full);
    const rect0 = first.length ? first[0].rect : -1;
    const row0 = first.filter(b => b.rect === rect0);
    if (row0.length > 1) {
      html += `<div class="tp-sub">BOX WIDTHS${lay.rects.filter(r => r.full).length > 1 ? ' (FIRST STRETCH)' : ''}</div>
        <div class="tp-widths">${row0.map((b, i) => `<input type="text" data-width="${i}" value="${escapeHtml(fmtLen(b.x1 - b.x0))}" title="Box ${i + 1}">`).join('')}</div>
        <button class="btn" data-even ${one.widths ? '' : 'disabled'}>EVEN WIDTHS</button>`;
    }
    const rows = lay.boxes.filter(b => b.col === 0 && b.rect === rect0);
    if (rows.length > 1) {
      html += `<div class="tp-sub">ROW HEIGHTS, BOTTOM TO TOP</div>
        <div class="tp-widths">${rows.map((b, i) => `<input type="text" data-rowh="${i}" value="${escapeHtml(fmtLen(b.y1 - b.y0))}" title="Row ${i + 1}">`).join('')}</div>
        <button class="btn" data-even-rows ${one.heights ? '' : 'disabled'}>EVEN ROWS</button>`;
    }
  }
  return html;
}

// ctx: { trims, reach (the sections a change goes to), scope, scopes, setScope(id), values(t), summary, notes,
//        wallHeight(t), wallLength(t), layoutOf(t) -> {cols, boxes, rects}, stretches(t), editing,
//        design(key, value, label), line(t, edge, dy, label), swap(productId), swapStyle(style, productId),
//        set(fn, label, reach), setStretch(t, i, n), selectReach(scope), remove(), toggleEdit(), selectWall(), faceName(t) }
export function trimPanelHtml(ctx) {
  const list = ctx.trims;
  const one = list.length === 1 ? list[0] : null;
  const current = new Set(list.map(t => t.product));
  const styles = new Set(list.map(t => t.style));
  const kinds = new Set(list.map(t => (trimStyle(t) || {}).kind));
  const p = one ? trimProduct(one) : (current.size === 1 ? trimProduct(list[0]) : null);
  const style = styles.size === 1 ? trimStyle(list[0]) : null;
  const fields = list.every(isField);
  const crownOnly = kinds.size === 1 && kinds.has('crown');
  let html = `<h3>${one ? 'WALL TRIM' : list.length + ' TRIM SECTIONS'}</h3>
    ${one ? `<div class="stat-line"><span>${escapeHtml(trimLabel(one))}</span><b></b></div><div class="stat-line"><span>Face</span><b>${escapeHtml(ctx.faceName(one))}</b></div>` : `<div class="stat-line"><span>${escapeHtml(style ? style.label : 'Several styles')}</span><b>${list.length} selected</b></div>`}
    ${scopeHtml(ctx)}
    ${ctx.scope !== 'selected' && ctx.poolCount > list.length ? `<button class="btn" data-select-reach title="Select every section in this reach, of any kind of trim.">SELECT THE ${escapeHtml(ctx.scopes.find(x => x.id === ctx.scope).label)}'S TRIM (${ctx.poolCount})</button>` : ''}
    ${stylePickersHtml(ctx)}
    <button class="btn${ctx.editing ? ' primary' : ''}" data-tp-edit title="E. Drag in the view: a rail or the inside of a box moves that height; a box's side resizes every box; the space between boxes is the gap; the space round them the margins.">${ctx.editing ? 'DONE EDITING (E)' : 'EDIT BY DRAGGING (E)'}</button>
    ${ctx.editing ? '<div class="empty" style="margin:6px 0">Drag a rail, or the inside of a box, up or down to move that height line. Drag a box\'s side to make every box narrower or wider: each wall takes as many as fit. Drag the space between two boxes to change the gap, and the space round the boxes to change the margins (Shift keeps gap and margins equal; Alt on a gap moves that one divider). The outline shows every section the drag will change. Right-click a section for more.</div>' : ''}
    ${mouldingsHtml(ctx)}
    ${p ? productCardHtml(p, { evidence: true }) : ''}`;
  if (!crownOnly) {
    const yVal = same(list, t => t.y);
    html += `<div class="field-row">${lenField(fields ? 'Bottom edge' : 'Height to bottom', 'y', yVal)}${fields ? lenField('Field height', 'h', same(list, t => t.h)) : ''}</div>`;
    // Several sections at different heights move together by the same amount.
    if (!one) html += `<div class="field-row"><div class="field"><label>Raise by (minus lowers)</label><input type="text" data-raise value="" placeholder="${escapeHtml(fmtLen(IN))}" title="Every selected section moves up by this much; start with a minus sign to lower them."></div></div>`;
  }
  html += layoutHtml(ctx, one);
  if (one && style && style.kind === 'field' && style.planks) html += `<div class="field-row">${lenField('Board spacing', 'spacing', one.spacing, fmtLen(p ? (p.pitch || p.W) : .09))}</div>`;
  if (one) {
    const L = ctx.wallLength(one);
    html += `<div class="field-row">${lenField('Starts at (from wall end)', 'from', one.f0 * L)}${lenField('Ends at', 'to', one.f1 * L)}</div>`;
  }
  const mat = same(list, t => t.material || '');
  html += `<div class="field"><label>Finish</label>${materialSelectHtml('trim', mat === undefined ? '' : mat, 'data-tp-mat').replace('(none)', mat === undefined ? '(several)' : 'Trim paint (automatic)')}</div>`;
  html += `<div class="tp-sub">TRIM CATALOG</div>${catalogHtml(current)}`;
  html += `${one ? '<button class="btn" data-tp-wall>SELECT WALL</button>' : ''}
    <button class="btn danger" data-tp-del>DELETE ${one ? 'THIS TRIM' : list.length + ' SECTIONS'}</button>`;
  return html;
}

export function bindTrimPanel(root, ctx) {
  const list = ctx.trims, one = list.length === 1 ? list[0] : null;
  const q = s => root.querySelector(s);
  q('[data-tp-edit]').onclick = () => ctx.toggleEdit();
  root.querySelectorAll('[data-picker] [data-choice]').forEach(btn => btn.onclick = () => {
    const key = btn.closest('[data-picker]').dataset.picker;
    ctx.preset(key, btn.dataset.choice);
    q(`[data-picker="${key}"] summary`)?.focus();
  });
  root.querySelectorAll('[data-scope]').forEach(b => b.onclick = () => ctx.setScope(b.dataset.scope));
  const reachBtn = q('[data-select-reach]'); if (reachBtn) reachBtn.onclick = () => ctx.selectReach(ctx.scope);
  root.querySelectorAll('[data-role-product]').forEach(sel => sel.onchange = () => { if (sel.value) ctx.swapStyle(sel.dataset.roleProduct, sel.value); });
  // Layout numbers go to every section the change reaches.
  root.querySelectorAll('[data-design]').forEach(inp => inp.onchange = () => {
    const key = inp.dataset.design, raw = inp.value.trim();
    if (!raw) { if (key === 'aim') return ctx.design('aim', null, 'trim box width'); if (key === 'minBox') return ctx.design('minBox', 0, 'trim least box'); return ctx.rerender(); }
    const v = parseLen(raw, 'inches');
    if (!Number.isFinite(v) || v < 0) return ctx.rerender();
    ctx.design(key, v, 'trim ' + ({ aim: 'box width', gap: 'gap', sides: 'margins', top: 'margins', bottom: 'margins', minBox: 'least box' })[key]);
  });
  root.querySelectorAll('[data-design-int]').forEach(inp => inp.onchange = () => {
    const n = parseInt(inp.value, 10);
    if (!Number.isInteger(n) || n < 1) return ctx.rerender();
    ctx.design(inp.dataset.designInt, n, 'trim rows');
  });
  const reveal = q('[data-reveal]'); if (reveal) reveal.onclick = () => ctx.design('reveal', ctx.values(list[0]).gap, 'even trim reveal');
  const fit = q('[data-fit]'); if (fit) fit.onclick = () => ctx.design('fit', null, 'fit trim panels');
  root.querySelectorAll('[data-stretch]').forEach(inp => inp.onchange = () => {
    const n = parseInt(inp.value, 10);
    ctx.setStretch(one, +inp.dataset.stretch, Number.isInteger(n) && n >= 0 ? Math.min(60, n) : null);
  });
  root.querySelectorAll('[data-len]').forEach(inp => inp.onchange = () => {
    const key = inp.dataset.len, raw = inp.value.trim();
    if (!raw && key === 'spacing') return ctx.set(t => { t.spacing = null; }, 'trim spacing', true);
    const v = parseLen(raw, 'inches');
    if (!Number.isFinite(v) || v < 0) return ctx.rerender();
    // A typed height moves the line the section is on, with everything the change reaches.
    const yNow = same(list, t => t.y), hNow = same(list, t => t.h);
    if (key === 'y') return yNow !== undefined ? ctx.line(list[0], 'move', v - yNow, 'trim height') : ctx.set(t => ctx.setY(t, v), 'trim height');
    if (key === 'h') return hNow !== undefined && isField(list[0]) ? ctx.line(list[0], 'top', v - hNow, 'trim field height') : ctx.set(t => { if (isField(t)) t.h = Math.max(.08, Math.min(v, ctx.wallHeight(t) - t.y)); }, 'trim field height');
    if (key === 'from' || key === 'to') return ctx.set(t => {
      const L = ctx.wallLength(t), f = Math.max(0, Math.min(1, v / L));
      if (key === 'from') t.f0 = Math.min(f, t.f1 - .01); else t.f1 = Math.max(f, t.f0 + .01);
    }, 'trim extent');
    ctx.set(t => { t[key] = v; }, 'trim ' + key, key === 'spacing');
  });
  const raise = q('[data-raise]');
  if (raise) raise.onchange = () => {
    const raw = raise.value.trim(), sign = raw.startsWith('-') ? -1 : 1;
    const v = parseLen(raw.replace(/^[+-]\s*/, ''), 'inches');
    if (!raw || !Number.isFinite(v) || v <= 0) return ctx.rerender();
    ctx.raise(sign * v);
  };
  // Box widths: the typed box takes that width, the others keep their shares of what is left.
  const shares = (inputs, attr, prop) => inputs.forEach(inp => inp.onchange = () => {
    const i = +inp.dataset[attr], v = parseLen(inp.value.trim(), 'inches');
    if (!one || !Number.isFinite(v) || v <= .02) return ctx.rerender();
    const now = [...inputs].map(x => parseLen(x.defaultValue, 'inches'));     // as drawn before this edit
    const total = now.reduce((s, x) => s + x, 0), others = total - now[i], rest = total - v;
    if (rest <= .02 * (now.length - 1) || others <= 0) return ctx.rerender();
    const out = now.map((x, k) => k === i ? v : x * rest / others);
    ctx.set(t => { t[prop] = out.map(x => Math.round(x * 10000) / 10000); if (prop === 'widths') { t.cols = out.length; t.colsAt = null; } }, prop === 'widths' ? 'trim box width' : 'trim row height');
  });
  shares(root.querySelectorAll('[data-width]'), 'width', 'widths');
  shares(root.querySelectorAll('[data-rowh]'), 'rowh', 'heights');
  const even = q('[data-even]'); if (even) even.onclick = () => ctx.set(t => { t.widths = null; }, 'even box widths');
  const evenRows = q('[data-even-rows]'); if (evenRows) evenRows.onclick = () => ctx.set(t => { t.heights = null; }, 'even row heights');
  const mat = q('[data-tp-mat]'); if (mat) mat.onchange = () => ctx.set(t => { t.material = mat.value || null; }, 'trim finish', true);
  root.querySelectorAll('[data-group]').forEach(b => b.onclick = () => { groupFilter = b.dataset.group; listScroll = 0; ctx.rerender(); });
  const listEl = q('[data-cat-list]');
  if (listEl) {
    listEl.scrollTop = listScroll;
    listEl.onscroll = () => { listScroll = listEl.scrollTop; };
    listEl.querySelectorAll('[data-cat]').forEach(b => b.onclick = () => { listScroll = listEl.scrollTop; ctx.swap(b.dataset.cat, true); });
    listEl.onkeydown = e => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const items = [...listEl.querySelectorAll('[data-cat]')];
      const at = items.findIndex(b => b.classList.contains('active'));
      const next = items[Math.max(0, Math.min(items.length - 1, at < 0 ? 0 : at + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (!next) return;
      listScroll = Math.max(0, next.offsetTop - listEl.clientHeight / 2);
      ctx.swap(next.dataset.cat, true);
    };
    if (ctx.focusList) { listEl.focus({ preventScroll: true }); const a = listEl.querySelector('.active'); if (a && (a.offsetTop < listEl.scrollTop || a.offsetTop > listEl.scrollTop + listEl.clientHeight - 30)) listEl.scrollTop = listScroll = Math.max(0, a.offsetTop - listEl.clientHeight / 2); }
  }
  const wallBtn = q('[data-tp-wall]'); if (wallBtn) wallBtn.onclick = () => ctx.selectWall();
  q('[data-tp-del]').onclick = () => ctx.remove();
}

// The ADD TRIM block of the wall and room panels: a style and catalog entry, and where.
export function addTrimHtml(faces, opts = {}) {
  const items = catalogInOrder();
  let last = '';
  const options = items.map(p => {
    const head = p.style !== last ? (last ? '</optgroup>' : '') + `<optgroup label="${escapeHtml((TRIM_STYLES[p.style] || {}).label || p.style)}">` : '';
    last = p.style;
    return `${head}<option value="${escapeHtml(p.id)}">${escapeHtml(p.short || p.title)} (${escapeHtml(p.brand)} ${escapeHtml(p.model || '')})</option>`;
  }).join('') + (last ? '</optgroup>' : '');
  return `<div class="tp-sub">ADD WALL TRIM</div>
    ${faces.length > 1 ? `<div class="field"><label>Face</label><select data-trim-face>${faces.map((f, i) => `<option value="${i}" ${i === (opts.face || 0) ? 'selected' : ''}>${escapeHtml(f.label)}</option>`).join('')}</select></div>` : ''}
    <div class="field"><label>Trim</label><select aria-label="Trim product" data-trim-product>${options}</select></div>
    ${crownPicker()}
    ${wainscotPicker()}
    <div data-add-frame></div>
    <button class="btn" data-trim-add>${escapeHtml(opts.button || 'ADD TRIM')}</button>`;
}
export function bindAddTrim(root, faces, add) {
  const btn = root.querySelector('[data-trim-add]');
  if (!btn) return;
  const product = root.querySelector('[data-trim-product]');
  const frame = root.querySelector('[data-add-frame]');
  let layout = '';
  const renderFrame = () => {
    const p = catalogItem(product.value);
    frame.innerHTML = p?.style === 'picture-frame' ? framePicker(layout, p) : '';
  };
  renderFrame();
  product.onchange = () => { if (catalogItem(product.value)?.style !== 'picture-frame') layout = ''; renderFrame(); };
  for (const picker of root.querySelectorAll('[data-picker]:not([data-picker="frame"])')) {
    picker.onclick = e => {
      const choice = e.target.closest('[data-choice]');
      if (!choice) return;
      product.value = choice.dataset.choice;
      product.onchange();
      picker.open = false;
      picker.querySelector('summary').focus();
    };
  }
  frame.onclick = e => {
    const choice = e.target.closest('[data-choice]');
    if (!choice) return;
    layout = choice.dataset.choice;
    renderFrame();
    frame.querySelector('summary').focus();
  };
  btn.onclick = () => {
    const faceSel = root.querySelector('[data-trim-face]');
    const face = faces[faceSel ? +faceSel.value : 0];
    add(product.value, face, layout);
  };
}
