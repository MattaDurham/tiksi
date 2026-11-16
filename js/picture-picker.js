// Every photo and rendering of a property, to choose some and put them on a saved view: the send
// window's BROWSE ALL PHOTOS AND RENDERINGS and a view's CHOOSE FROM PHOTOS (lab-publish-dialog.js).
// It lists the property's photo records and the project folder's pictures Tiksi has no record of,
// newest first, as Renderings, Photos or All, with a search by name, and says which view each is
// on. Thumbnails load as they scroll into sight. Choosing is the caller's: `onPick(ids, viewId)`.

import { escapeHtml } from './store.js';
import { isRendering, viewOfPicture, pictureDay } from './view-renderings.js';
import { folderPreviewUrl } from './photos-store.js';

const PAGE = 120;
const when = p => Date.parse(p.renderedAt || p.takenAt || p.createdAt) || 0;
// Pictures the picker offers: not documents, panoramas or the frames of a scan capture.
export const pickable = p => !!p && p.kind !== 'document' && p.kind !== 'pano' && !(p.file && p.file.group === 'scan');

// Which of `pictures` show under `tab` ('renderings' | 'photos' | 'all') and match `find`.
export function pickerList(prop, pictures, { tab = 'renderings', find = '', where = 'any' } = {}) {
  const words = String(find || '').toLowerCase().split(/\s+/).filter(Boolean);
  return (pictures || []).filter(pickable)
    .filter(p => tab === 'all' || (tab === 'renderings') === isRendering(p))
    .filter(p => { if (where === 'any') return true; const on = !!viewOfPicture(prop, p); return where === 'on' ? on : !on; })
    .filter(p => { const name = String((p.file && p.file.path) || p.name || '').toLowerCase(); return words.every(w => name.includes(w)); })
    .sort((a, b) => when(b) - when(a));
}

export function openPicturePicker({ host, prop, pictures, viewId = '', onPick }) {
  const views = prop.savedViews || [];
  const box = document.createElement('dialog');
  box.className = 'file-dialog picture-picker';
  box.setAttribute('aria-label', 'Photos and renderings');
  const count = tab => pickerList(prop, pictures, { tab }).length;
  box.innerHTML = `<header class="file-heading"><div><h2>Photos and renderings</h2><p>${escapeHtml(prop.name || 'Property')}: choose pictures, then the saved view they show with.</p></div><button class="btn" data-pp-close>CLOSE</button></header>
    <div class="pp-bar">
      <div class="pp-tabs" role="tablist">${[['renderings', 'RENDERINGS'], ['photos', 'PHOTOS'], ['all', 'ALL']].map(([id, name]) => `<button type="button" class="btn" role="tab" data-pp-tab="${id}">${name} <small>${count(id)}</small></button>`).join('')}</div>
      <input type="search" data-pp-find placeholder="Find by name or folder" aria-label="Find pictures by name or folder">
      <select data-pp-where aria-label="Which pictures"><option value="any">On a view or not</option><option value="off">On no view</option><option value="on">On a view</option></select>
    </div>
    <div class="pp-grid" data-pp-grid></div>
    <div class="file-actions pp-more" data-pp-more hidden><button type="button" class="btn" data-pp-more-btn>SHOW MORE</button></div>
    <footer class="pp-foot"><span data-pp-chosen>Nothing chosen</span>
      <label>Show with <select data-pp-view>${views.map(v => `<option value="${escapeHtml(v.id)}" ${v.id === viewId ? 'selected' : ''}>${escapeHtml(v.name)}</option>`).join('')}<option value="">No view (take them off)</option></select></label>
      <button type="button" class="btn primary" data-pp-put disabled>PUT ON THE VIEW</button></footer>`;
  (host || document.body).append(box);
  box.showModal();
  const q = sel => box.querySelector(sel);
  const urls = [];
  const chosen = new Set();
  let tab = 'renderings', list = [], shown = 0;
  const seen = new IntersectionObserver(entries => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const img = e.target; seen.unobserve(img);
      folderPreviewUrl(prop, img.dataset.ppPath, 256).then(u => { urls.push(u); if (img.isConnected) img.src = u; }).catch(() => img.classList.add('pp-none'));
    }
  }, { root: q('[data-pp-grid]'), rootMargin: '400px' });
  const close = () => box.close();
  box.addEventListener('close', () => { seen.disconnect(); for (const u of urls) URL.revokeObjectURL(u); box.remove(); });
  q('[data-pp-close]').onclick = close;

  const card = p => {
    const hit = viewOfPicture(prop, p);
    const thumb = p.thumb ? `<img src="${escapeHtml(p.thumb)}" alt="">` : p.file && p.file.path ? `<img alt="" data-pp-path="${escapeHtml(p.file.path)}">` : '<span class="pp-none"></span>';
    const where = p.file && p.file.path ? p.file.path.split('/').slice(0, -1).join('/') : '';
    return `<button type="button" class="pp-card${chosen.has(p.id) ? ' on' : ''}" data-pp-id="${escapeHtml(p.id)}" aria-pressed="${chosen.has(p.id)}" title="${escapeHtml((p.file && p.file.path) || p.name || '')}">
      <span class="pp-pic">${thumb}${hit ? `<b class="pp-on">${escapeHtml(hit.view.name)}</b>` : ''}</span>
      <span class="pp-name">${escapeHtml(p.name || '')}</span>
      <span class="pp-note">${escapeHtml([pictureDay(p), where].filter(Boolean).join(' · '))}</span></button>`;
  };
  const more = () => {
    const grid = q('[data-pp-grid]'), next = list.slice(shown, shown + PAGE);
    grid.insertAdjacentHTML('beforeend', next.map(card).join(''));
    shown += next.length;
    for (const img of grid.querySelectorAll('img[data-pp-path]:not([data-pp-watch])')) { img.dataset.ppWatch = '1'; seen.observe(img); }
    q('[data-pp-more]').hidden = shown >= list.length;
    q('[data-pp-more-btn]').textContent = 'SHOW ' + Math.min(PAGE, list.length - shown) + ' MORE (' + (list.length - shown) + ' left)';
  };
  const draw = () => {
    list = pickerList(prop, pictures, { tab, find: q('[data-pp-find]').value, where: q('[data-pp-where]').value });
    for (const b of box.querySelectorAll('[data-pp-tab]')) b.classList.toggle('primary', b.dataset.ppTab === tab);
    const grid = q('[data-pp-grid]');
    grid.innerHTML = list.length ? '' : '<p class="pp-empty">No pictures here.</p>';
    shown = 0; more();
  };
  const tally = () => {
    q('[data-pp-chosen]').textContent = chosen.size ? chosen.size + ' chosen' : 'Nothing chosen';
    q('[data-pp-put]').disabled = !chosen.size;
    q('[data-pp-put]').textContent = q('[data-pp-view]').value ? 'PUT ON THE VIEW' : 'TAKE OFF THEIR VIEW';
  };
  box.addEventListener('click', e => {
    const t = e.target.closest('[data-pp-tab]');
    if (t) { tab = t.dataset.ppTab; draw(); return; }
    const c = e.target.closest('[data-pp-id]');
    if (c) {
      const id = c.dataset.ppId;
      if (chosen.has(id)) chosen.delete(id); else chosen.add(id);
      c.classList.toggle('on', chosen.has(id)); c.setAttribute('aria-pressed', String(chosen.has(id)));
      tally(); return;
    }
    if (e.target.closest('[data-pp-more-btn]')) more();
  });
  let typing = 0;
  q('[data-pp-find]').oninput = () => { clearTimeout(typing); typing = setTimeout(draw, 150); };
  q('[data-pp-where]').onchange = draw;
  q('[data-pp-view]').onchange = tally;
  q('[data-pp-put]').onclick = () => { onPick([...chosen], q('[data-pp-view]').value); close(); };
  draw(); tally();
  return box;
}
