// The MODEL inspector for wall trim (trims.js): one section or several selected together.
// CHANGES REACH says how far a change here goes (trim-design.js): the sections selected, their
// group, the whole room or the whole project. Under it: the moulding of each kind of trim in
// the selection as a dropdown, the heights, the panel layout (the box width aimed for, the gap,
// the margins, rows). Each moulding dropdown opens into the catalog entries of its kind drawn to
// size: a click, or the arrow keys while the open list has focus, swaps the trim to that entry.
// The whole catalog is PRODUCTS > TRIM CATALOG; its cards drop onto a dropdown or this panel.
// HTML builders and a binder; the viewer passes a context of callbacks (viewer3d.js).

import { escapeHtml, fmtLen, parseLen, fmtMoney } from './store.js';
import { materialSelectHtml } from './materials.js';
import { TRIM_STYLES, trimStyle, trimProduct, trimLabel, isField, catalogInOrder } from './trims.js';
import { CROWN_PRESETS, WAINSCOT_PRESETS, FRAME_PRESETS } from './trim-presets.js';
import { trimCutaway, trimElevation } from './trim-previews.js';
import { catalogFor, catalogItem } from './trim-catalog.js';
import { takesTrim } from './product-drag.js';
import { openProductsFloat } from './products-float.js';

const IN = 0.0254;
let openMoulding = '';           // the kind of trim whose moulding dropdown is open, kept between redraws
let focusMoulding = '';          // and whether its list had the keys (stepping with the arrows)

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

export function productCardHtml(p, opts = {}) {
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

// One catalog entry as a row: its section drawn to size, its name, maker, size, store and price.
function entryInner(p) {
  return `${trimCutaway(p)}
      <span class="tp-cat-text"><b>${escapeHtml(p.short || p.title)}</b><span>${escapeHtml(p.brand)} ${escapeHtml(p.model || '')} &middot; ${escapeHtml(sizeLabel(p))}</span>
      <span>${escapeHtml(p.store || '')}${p.price ? ' &middot; ' + fmtMoney(p.price) + (p.priceUnit ? '/' + escapeHtml(p.priceUnit) : '') : ''}</span></span>`;
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

// The style pickers speak for every section of their kind the change reaches, of any style.
function stylePickersHtml(ctx) {
  const all = ctx.pool || ctx.reach;
  const crown = all.filter(t => t.style === 'crown');
  const wainscot = all.filter(isField);
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
// One dropdown for each kind of trim in the selection: the moulding it is made of, shown drawn
// to size, opening into every catalog entry of that kind drawn the same way.
function mouldingsHtml(ctx) {
  const styles = Object.keys(TRIM_STYLES).filter(k => ctx.trims.some(t => t.style === k));
  return `<div class="tp-sub">MOULDINGS</div>` + styles.map(k => {
    const mine = ctx.mouldingReach ? ctx.mouldingReach(k) : ctx.reach.filter(t => t.style === k);
    const ids = new Set(mine.map(t => t.product));
    const cur = ids.size === 1 ? [...ids][0] : '';
    const curP = cur ? catalogItem(cur) : null;
    const items = catalogFor(k);
    if (curP && !items.some(p => p.id === cur)) items.push(curP);
    const label = `${TRIM_STYLES[k].label} (${mine.length} ${mine.length === 1 ? 'section' : 'sections'})`;
    return `<div class="field tp-mould" data-drop-style="${k}"><label>${escapeHtml(label)}</label>
      <details class="tp-mould-pick" data-mould="${k}"${openMoulding === k ? ' open' : ''}>
        <summary aria-label="${escapeHtml(label)}: ${escapeHtml(curP ? curP.short || curP.title : cur || 'several mouldings')}">${curP ? entryInner(curP)
          : `<span class="tp-cat-text"><b>${cur ? escapeHtml(cur) : 'Several mouldings'}</b><span>${cur ? 'Not in the catalog' : 'Pick one to make them all the same'}</span></span>`}</summary>
        <div class="tp-cat-list" tabindex="0" data-mould-list aria-label="${escapeHtml(TRIM_STYLES[k].label)} mouldings: arrow keys swap the trim">${items.map(p =>
          `<button type="button" class="tp-cat-item${p.id === cur ? ' active' : ''}" data-cat="${escapeHtml(p.id)}" title="${escapeHtml(p.title)}">${entryInner(p)}</button>`).join('')}</div>
      </details></div>`;
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
    ${one && ctx.boardChanges ? boardChangesHtml(ctx.boardChanges(one)) : ''}
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
  html += `<div class="tp-sub">TRIM CATALOG</div>
    <div class="empty" style="margin:0 0 6px">Every moulding, board and panel is in PRODUCTS &gt; TRIM CATALOG. Open it floating over the model and drag an entry onto a moulding above, onto this panel, onto trim in the model or onto a wall.</div>
    <button class="btn" data-tp-catalog>OPEN THE TRIM CATALOG</button>`;
  html += `${one ? '<button class="btn" data-tp-wall>SELECT WALL</button>' : ''}
    <button class="btn danger" data-tp-del>DELETE ${one ? 'THIS TRIM' : list.length + ' SECTIONS'}</button>`;
  return `<div class="tp-drop" data-tp-drop>${html}</div>`;
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
    // Sections of the first one's kind all come onto the typed height (trim-design.js lineRule).
    if (key === 'y') return ctx.line(list[0], 'move', v - (yNow !== undefined ? yNow : list[0].y), 'trim height');
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
  bindMouldings(root, ctx);
  const cat = q('[data-tp-catalog]'); if (cat) cat.onclick = () => openProductsFloat('trim');
  // A catalog card dropped anywhere on the panel swaps the selection, as far as the change reaches.
  takesTrim(q('[data-tp-drop]'), id => ctx.swap(id));
  const wallBtn = q('[data-tp-wall]'); if (wallBtn) wallBtn.onclick = () => ctx.selectWall();
  q('[data-tp-del]').onclick = () => ctx.remove();
  const boardsBack = q('[data-tp-boards-back]'); if (boardsBack && one) boardsBack.onclick = () => ctx.restoreBoards(one);
}

// One board of a section, picked by double-clicking into it: what it is, where it is, and the
// changes by hand that override the automatic layout for this board alone (trims.js t.boards).
// ctx: { t, part, name, place, box, wallLength, editing, changes, faceName,
//        set(box), copy(), remove(), restore(), restoreAll(), up(), toggleEdit() }
export function boardPanelHtml(ctx) {
  const { t, part, box } = ctx;
  const style = trimStyle(t), p = trimProduct(t);
  const v = part.kind === 'board' ? part.dir === 'v' : false;
  const across = part.kind === 'frame' ? box.x1 - box.x0 : v ? box.x1 - box.x0 : box.y1 - box.y0;
  const length = part.kind === 'frame' ? box.y1 - box.y0 : v ? box.y1 - box.y0 : box.x1 - box.x0;
  const size = part.kind === 'frame' ? `${fmtLen(across)} x ${fmtLen(length)} box` : `${fmtLen(part.T)} x ${fmtLen(across)} x ${fmtLen(length)}`;
  const status = part.added ? 'Added by hand' : part.edited ? 'Moved by hand' : 'Where the layout puts it';
  const c = ctx.changes;
  const what = [c.moved && c.moved + ' moved', c.hidden && c.hidden + ' deleted', c.added && c.added + ' added'].filter(Boolean).join(', ');
  const run = part.kind === 'run';
  return `<h3>TRIM BOARD</h3>
    <div class="stat-line"><span>${escapeHtml(ctx.name)}${ctx.place ? ` ${ctx.place.n} of ${ctx.place.of}` : ''}</span><b>${escapeHtml(style ? style.label : '')}</b></div>
    <div class="stat-line"><span>Face</span><b>${escapeHtml(ctx.faceName)}</b></div>
    <div class="stat-line"><span>Size</span><b>${escapeHtml(size)}</b></div>
    <div class="stat-line"><span>Layout</span><b data-tb-status>${status}</b></div>
    <div class="empty" style="margin:2px 0 6px">Changes here are to this board alone; the rest of the section keeps its automatic layout. Double-click another board of this section to pick it; Esc goes back out to the whole section.</div>
    <div class="field-row">${boardField('Starts at (from wall end)', 'x0', box.x0)}${boardField('Ends at', 'x1', box.x1)}</div>
    <div class="field-row">${boardField('Bottom edge', 'y0', box.y0)}${boardField('Top edge', 'y1', box.y1, run)}</div>
    <button class="btn${ctx.editing ? ' primary' : ''}" data-tb-edit title="E. Drag the board in the view.">${ctx.editing ? 'DONE EDITING (E)' : 'EDIT BY DRAGGING (E)'}</button>
    ${ctx.editing ? `<div class="empty" style="margin:6px 0">Drag the board: ${run ? 'a moulding moves up and down' : part.kind === 'frame' ? 'a box moves any way' : v ? 'it moves sideways' : 'it moves up and down'}; Shift moves it any way. Drag ${run || !v ? 'either end' : 'its top or bottom end'} to make it longer or shorter. The lines on the wall show the space each side and the height. Moves go in 1/16" steps and hold a moment on round numbers (whole inches, 6" marks, whole feet), on round spaces to the next board, and on the same space both sides.</div>` : ''}
    <button class="btn" data-tb-copy title="A copy of this board beside it, selected so it can be dragged into place.">ADD A COPY BESIDE IT</button>
    ${part.edited && !part.added ? '<button class="btn" data-tb-restore>PUT IT BACK AS LAID OUT</button>' : ''}
    <button class="btn" data-tb-up>SELECT THE WHOLE SECTION (Esc)</button>
    ${c.total ? `<div class="stat-line"><span>This section, changed by hand</span><b>${escapeHtml(what)}</b></div><button class="btn" data-tb-restore-all>PUT EVERY BOARD BACK (${c.total})</button>` : ''}
    ${p ? `<div class="stat-line"><span>Made of</span><b>${escapeHtml(p.short || p.name || '')}</b></div>` : ''}
    <button class="btn danger" data-tb-del>DELETE THIS BOARD</button>`;
}
function boardField(label, key, v, off = false) {
  return `<div class="field"><label>${escapeHtml(label)}</label><input type="text" data-tb="${key}" value="${escapeHtml(fmtLen(v))}"${off ? ' disabled title="A moulding is as tall as its profile."' : ''}></div>`;
}
export function bindBoardPanel(root, ctx) {
  const q = s => root.querySelector(s);
  root.querySelectorAll('[data-tb]').forEach(inp => inp.onchange = () => {
    const v = parseLen(inp.value.trim(), 'inches');
    if (!Number.isFinite(v)) return ctx.rerender();
    const box = { ...ctx.box }, key = inp.dataset.tb;
    // Starts at and bottom edge move the board; ends at and top edge stretch it.
    if (key === 'x0') { box.x1 += v - box.x0; box.x0 = v; }
    else if (key === 'y0') { box.y1 += v - box.y0; box.y0 = v; }
    else box[key] = v;
    if (box.x1 - box.x0 < .003 || box.y1 - box.y0 < .003) return ctx.rerender();
    ctx.set(box);
  });
  q('[data-tb-edit]').onclick = () => ctx.toggleEdit();
  q('[data-tb-copy]').onclick = () => ctx.copy();
  q('[data-tb-up]').onclick = () => ctx.up();
  q('[data-tb-del]').onclick = () => ctx.remove();
  const back = q('[data-tb-restore]'); if (back) back.onclick = () => ctx.restore();
  const all = q('[data-tb-restore-all]'); if (all) all.onclick = () => ctx.restoreAll();
}
// The line in a section's panel saying how many of its boards were changed by hand.
export function boardChangesHtml(c) {
  if (!c || !c.total) return '<div class="empty" style="margin:4px 0">Double-click a board to pick it on its own: move, resize or delete it, or add a copy.</div>';
  const what = [c.moved && c.moved + ' moved', c.hidden && c.hidden + ' deleted', c.added && c.added + ' added'].filter(Boolean).join(', ');
  return `<div class="stat-line"><span>Boards changed by hand</span><b>${escapeHtml(what)}</b></div>
    <button class="btn" data-tp-boards-back>PUT EVERY BOARD BACK (${c.total})</button>`;
}

// The moulding dropdowns: one open at a time; a click on an entry swaps and closes it; with
// its list focused the up and down arrows swap live and keep it open; Esc closes it.
function bindMouldings(root, ctx) {
  const all = [...root.querySelectorAll('[data-mould]')];
  for (const d of all) {
    const k = d.dataset.mould, listEl = d.querySelector('[data-mould-list]');
    const centre = () => { const a = listEl.querySelector('.active'); if (a) listEl.scrollTop = Math.max(0, a.offsetTop - listEl.clientHeight / 2 + a.offsetHeight / 2); };
    d.addEventListener('toggle', () => {
      if (d.open) { openMoulding = k; all.forEach(o => { if (o !== d) o.open = false; }); centre(); }
      else if (openMoulding === k) openMoulding = '';
    });
    listEl.querySelectorAll('[data-cat]').forEach(b => b.onclick = () => { openMoulding = ''; ctx.swapStyle(k, b.dataset.cat); });
    listEl.onkeydown = e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); d.open = false; d.querySelector('summary').focus(); return; }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const items = [...listEl.querySelectorAll('[data-cat]')];
      const at = items.findIndex(b => b.classList.contains('active'));
      const next = items[Math.max(0, Math.min(items.length - 1, at < 0 ? 0 : at + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (!next || next.classList.contains('active')) return;
      openMoulding = k; focusMoulding = k;
      ctx.swapStyle(k, next.dataset.cat);
    };
    if (d.open) centre();
    // A catalog card dropped on this dropdown swaps this kind of trim only.
    takesTrim(d.closest('[data-drop-style]'), id => { openMoulding = ''; ctx.swapStyle(k, id); });
  }
  if (focusMoulding) {
    const listEl = root.querySelector(`[data-mould="${focusMoulding}"] [data-mould-list]`);
    focusMoulding = '';
    if (listEl) listEl.focus({ preventScroll: true });
  }
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
