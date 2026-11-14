// The MODEL inspector for wall trim (trims.js): one section or several selected together.
// Shows the product each is made of, its heights, its boxes or bays, and the trim catalog
// (trim-catalog.js) as a list to scroll through: a click on an entry, or the arrow keys
// while the list has focus, swaps every selected section to that entry at once.
// HTML builders and a binder; the viewer passes a context of callbacks (viewer3d.js).

import { escapeHtml, fmtLen, parseLen, fmtMoney } from './store.js';
import { materialSelectHtml } from './materials.js';
import { TRIM_STYLES, STYLE_GROUPS, trimStyle, trimProduct, trimLabel, isField, catalogInOrder } from './trims.js';
import { profilePath } from './trim-profiles.js';

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

function profileSvg(p, size = 34) {
  return `<svg class="tp-prof" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true"><path d="${profilePath(p ? p.profile : 'flat', size, size)}"/></svg>`;
}

function productCardHtml(p, opts = {}) {
  if (!p) return '<div class="empty">No catalog entry.</div>';
  const price = p.price ? `${fmtMoney(p.price)}${p.priceUnit ? ' / ' + escapeHtml(p.priceUnit) : ''}` : '';
  return `<div class="tp-product">
    ${profileSvg(p, 46)}
    <div class="tp-product-text">
      <b>${escapeHtml(p.brand)} ${escapeHtml(p.model || '')}</b>
      <span>${escapeHtml(p.title)}</span>
      <span class="tp-meta">${escapeHtml(sizeLabel(p))} &middot; ${escapeHtml(p.material || '')}${price ? ' &middot; ' + price : ''}</span>
      <span class="tp-meta">${escapeHtml(p.store || '')}${p.sku ? ' item ' + escapeHtml(p.sku) : ''}${p.url ? ` &middot; <a href="${escapeHtml(p.url)}" target="_blank" rel="noopener">product page</a>` : ''}</span>
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
      ${profileSvg(p)}
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
const lenField = (label, key, value, ph) => `<div class="field"><label>${escapeHtml(label)}</label><input type="text" data-len="${key}" value="${value === undefined || value === null ? '' : escapeHtml(fmtLen(value))}" placeholder="${escapeHtml(ph || (value === undefined ? 'several' : ''))}"></div>`;

// ctx: { trims, wallOf(t) -> wall, wallHeight(t), wallLength(t), layoutOf(t) -> {cols, boxes, rects}, editing,
//        swap(productId), set(fn, label), remove(), toggleEdit(), selectWall(), faceName(t) }
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
    <button class="btn${ctx.editing ? ' primary' : ''}" data-tp-edit title="E. Drag a selected section up or down in the view; a field's top or bottom edge resizes it; a gap between boxes moves that divider.">${ctx.editing ? 'DONE EDITING (E)' : 'EDIT BY DRAGGING (E)'}</button>
    ${ctx.editing ? '<div class="empty" style="margin:6px 0">Drag any selected section up or down. On wainscoting, drag its top or bottom edge to resize it, or the gap between two boxes to resize them. Shift-click adds sections.</div>' : ''}
    ${p ? productCardHtml(p, { evidence: true }) : '<div class="empty">Several products.</div>'}`;
  if (!crownOnly) {
    const yVal = same(list, t => t.y);
    html += `<div class="field-row">${lenField(fields ? 'Bottom edge' : 'Height to bottom', 'y', yVal)}${fields ? lenField('Field height', 'h', same(list, t => t.h)) : ''}</div>`;
    // Several sections at different heights move together by the same amount.
    if (!one) html += `<div class="field-row"><div class="field"><label>Raise by (minus lowers)</label><input type="text" data-raise value="" placeholder="${escapeHtml(fmtLen(IN))}" title="Every selected section moves up by this much; start with a minus sign to lower them."></div></div>`;
  }
  if (one && style && style.kind === 'field') {
    const lay = ctx.layoutOf(one);
    if (style.boxes || style.bays) {
      const what = style.bays ? 'Bays across' : 'Boxes across';
      html += `<div class="field-row">
        <div class="field"><label>${what} (blank = fit)</label><input type="number" min="1" max="60" step="1" data-int="cols" value="${one.cols || ''}" placeholder="${lay.cols || ''}"></div>
        <div class="field"><label>Rows</label><input type="number" min="1" max="12" step="1" data-int="rows" value="${one.rows || 1}"></div>
      </div>`;
      if (one.style === 'picture-frame') html += `<div class="field-row">${lenField('Gap between boxes', 'gap', one.gap, fmtLen(.1))}${lenField('Inset from edges', 'inset', one.inset, fmtLen(.09))}</div>`;
      if (style.bays) html += `<div class="field-row">${lenField('Batten spacing (when fitting)', 'spacing', one.spacing, fmtLen(p && p.spacing || .45))}</div>`;
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
    } else if (style.planks) {
      html += `<div class="field-row">${lenField('Board spacing', 'spacing', one.spacing, fmtLen(p ? (p.pitch || p.W) : .09))}</div>`;
    }
  }
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
  root.querySelectorAll('[data-len]').forEach(inp => inp.onchange = () => {
    const key = inp.dataset.len, raw = inp.value.trim();
    if (!raw && ['gap', 'inset', 'spacing'].includes(key)) return ctx.set(t => { t[key] = null; }, 'trim ' + key);
    const v = parseLen(raw, 'inches');
    if (!Number.isFinite(v) || v < 0) return ctx.rerender();
    if (key === 'y') return ctx.set(t => ctx.setY(t, v), 'trim height');
    if (key === 'h') return ctx.set(t => { if (isField(t)) t.h = Math.max(.08, Math.min(v, ctx.wallHeight(t) - t.y)); }, 'trim field height');
    if (key === 'from' || key === 'to') return ctx.set(t => {
      const L = ctx.wallLength(t), f = Math.max(0, Math.min(1, v / L));
      if (key === 'from') t.f0 = Math.min(f, t.f1 - .01); else t.f1 = Math.max(f, t.f0 + .01);
    }, 'trim extent');
    ctx.set(t => { t[key] = v; }, 'trim ' + key);
  });
  const raise = q('[data-raise]');
  if (raise) raise.onchange = () => {
    const raw = raise.value.trim(), sign = raw.startsWith('-') ? -1 : 1;
    const v = parseLen(raw.replace(/^[+-]\s*/, ''), 'inches');
    if (!raw || !Number.isFinite(v) || v <= 0) return ctx.rerender();
    ctx.raise(sign * v);
  };
  root.querySelectorAll('[data-int]').forEach(inp => inp.onchange = () => {
    const key = inp.dataset.int, n = parseInt(inp.value, 10);
    ctx.set(t => {
      if (key === 'cols') { t.cols = Number.isInteger(n) && n >= 1 ? Math.min(60, n) : null; t.widths = null; }
      else { t.rows = Number.isInteger(n) && n >= 1 ? Math.min(12, n) : 1; t.heights = null; }
    }, 'trim boxes');
  });
  // Box widths: the typed box takes that width, the others keep their shares of what is left.
  const shares = (inputs, attr, prop) => inputs.forEach(inp => inp.onchange = () => {
    const i = +inp.dataset[attr], v = parseLen(inp.value.trim(), 'inches');
    if (!one || !Number.isFinite(v) || v <= .02) return ctx.rerender();
    const now = [...inputs].map(x => parseLen(x.defaultValue, 'inches'));     // as drawn before this edit
    const total = now.reduce((s, x) => s + x, 0), others = total - now[i], rest = total - v;
    if (rest <= .02 * (now.length - 1) || others <= 0) return ctx.rerender();
    const out = now.map((x, k) => k === i ? v : x * rest / others);
    ctx.set(t => { t[prop] = out.map(x => Math.round(x * 10000) / 10000); if (prop === 'widths') t.cols = t.cols || out.length; }, prop === 'widths' ? 'trim box width' : 'trim row height');
  });
  shares(root.querySelectorAll('[data-width]'), 'width', 'widths');
  shares(root.querySelectorAll('[data-rowh]'), 'rowh', 'heights');
  const even = q('[data-even]'); if (even) even.onclick = () => ctx.set(t => { t.widths = null; }, 'even box widths');
  const evenRows = q('[data-even-rows]'); if (evenRows) evenRows.onclick = () => ctx.set(t => { t.heights = null; }, 'even row heights');
  const mat = q('[data-tp-mat]'); if (mat) mat.onchange = () => ctx.set(t => { t.material = mat.value || null; }, 'trim finish');
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
    <div class="field"><label>Trim</label><select data-trim-product>${options}</select></div>
    <button class="btn" data-trim-add>${escapeHtml(opts.button || 'ADD TRIM')}</button>`;
}
export function bindAddTrim(root, faces, add) {
  const btn = root.querySelector('[data-trim-add]');
  if (!btn) return;
  btn.onclick = () => {
    const faceSel = root.querySelector('[data-trim-face]');
    const face = faces[faceSel ? +faceSel.value : 0];
    add(root.querySelector('[data-trim-product]').value, face);
  };
}
