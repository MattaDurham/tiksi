// A rail tab made of parts, each its own page module, chosen from a strip at the top: PHOTOS
// (photos, videos), PRODUCTS (products, materials, find a product) and DOCUMENTS (drawings and
// files, job documents, cut sheets, send). Each part keeps its own address, so a link to a part
// (#/materials?select=<id>, #/sheets?item=<id>) opens that part with its query, and UNDO and REDO
// are the open part's own.
//
// hub({ label, parts: [{ id, label, icon, load, addr }], partOf(hash), floating, actions })
// returns a view module. `floating`: the hub is in a window of its own over another page
// (products-float.js); its parts then leave the address alone and are told so when they mount.
// `actions`: [{ id, label, title, icon, run(part) }] buttons at the right end of the strip.

import { icon } from './icons.js';

export function hub({ label, parts, partOf, floating = false, actions = [] }) {
  let el = null, child = null, current = '', token = 0;
  function open(id) {
    if (!el) return;
    const own = ++token;
    if (child) { try { child.unmount(); } catch (e) { console.error(e); } child = null; }
    current = id;
    if (!floating) window.dispatchEvent(new CustomEvent('tiksi:part', { detail: id }));
    el.querySelectorAll('.doc-parts [data-part]').forEach(b => { const on = b.dataset.part === id; b.classList.toggle('active', on); b.setAttribute('aria-selected', on); });
    const body = el.querySelector('.hub-body');
    body.dataset.part = id;
    body.textContent = 'Opening…';
    parts.find(p => p.id === id).load().then(mod => {
      if (own !== token || !el) return;
      body.textContent = '';
      child = mod; mod.mount(body, { floating });
    }).catch(err => { if (own === token && el) body.innerHTML = `<p class="note" role="alert">This part could not open (${String(err && err.message || err)}). The others still work.</p>`; });
  }
  return {
    // `first`: the part to open (a floating hub has no address of its own to read it from).
    mount(root, first) {
      el = root;
      el.innerHTML = `<div class="doc-hub"><div class="hub-strip"><nav class="doc-parts seg" role="tablist" aria-label="${label}">${parts.map(p =>
        `<button type="button" class="seg-btn" role="tab" data-part="${p.id}">${icon(p.icon)}<span>${p.label}</span></button>`).join('')}</nav>${actions.length ? `<span class="hub-actions">${actions.map(a =>
        `<button type="button" class="btn small" data-hub-action="${a.id}" title="${a.title || ''}">${a.icon ? icon(a.icon) : ''}<span>${a.label}</span></button>`).join('')}</span>` : ''}</div><div class="doc-body hub-body"></div></div>`;
      el.querySelectorAll('.doc-parts [data-part]').forEach(b => b.onclick = () => {
        if (b.dataset.part === current) return;
        if (!floating) history.replaceState(null, '', parts.find(p => p.id === b.dataset.part).addr);
        open(b.dataset.part);
      });
      el.querySelectorAll('[data-hub-action]').forEach(b => b.onclick = () => actions.find(a => a.id === b.dataset.hubAction).run(current));
      open(typeof first === 'string' && parts.some(p => p.id === first) ? first : partOf(location.hash));
    },
    unmount() {
      token++;
      if (child) { try { child.unmount(); } catch (e) { console.error(e); } }
      child = null; el = null; current = '';
    },
    undo() { child?.undo?.(); },
    redo() { child?.redo?.(); },
    sharedChange(keys) { return child?.sharedChange?.(keys); },
    part: () => current,
  };
}
