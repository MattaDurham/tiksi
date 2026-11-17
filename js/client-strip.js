// The saved views on the client page (client-view.js): a strip of small pictures under the
// model, one per saved view. A click on a picture goes to that view and opens what there is
// more of it, beside it:
//   - its iterations ("Existing" and each project sent that changes what the view shows): a
//     click changes the model to that one, from wherever the camera is;
//   - its renderings: a click opens the picture in a window floating over the model, which can
//     be dragged, resized and closed while the model stays in use behind it.
// A view with neither just goes there. "Iterations" is the owner's word for them.
//
// The pictures come with the copy (lab-publish.js): copy.viewPictures = { view id: { state id:
// path } } and copy.renderings = [{ id, view, label, day, w, h, path, thumb }]. A copy sent
// without pictures of its views shows them by name, and offers every project under each.

import { escapeHtml } from './store.js';
import { EXISTING } from './project-pieces.js';

const dayWords = day => {
  const d = new Date(day + 'T12:00:00');
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '';
};
export const renderingTitle = r => (r.label || 'Rendering') + (r.day && dayWords(r.day) ? ' · ' + dayWords(r.day) : '');

// `states` = [{ id, label }] with Existing first; `show()` is the state on now and `setShow(id)`
// changes it; `goTo(viewId)` moves the camera. Returns { refresh({ view, shown }), openRendering(id), state() }.
// A view gone to from the left pane or the phone panel opens what it has, as a click on it does.
export function mountStrip({ copy, data, states, show, setShow, goTo }) {
  const views = (copy.property && copy.property.savedViews) || [];
  const pictures = copy.viewPictures && typeof copy.viewPictures === 'object' ? copy.viewPictures : null;
  const renderings = new Map(views.map(v => [v.id, []]));
  for (const r of Array.isArray(copy.renderings) ? copy.renderings : []) if (renderings.has(r.view)) renderings.get(r.view).push(r);
  const url = path => data + path;
  // The iterations of a view: Existing and the projects that show it differently (every project
  // when the copy has no pictures).
  const iterationsOf = v => pictures ? states.filter(s => s.id === EXISTING || !!(pictures[v.id] && pictures[v.id][s.id])) : states;
  const pictureOf = (v, stateId) => (pictures && pictures[v.id] && (pictures[v.id][stateId] || pictures[v.id][EXISTING])) || '';
  const hasMore = v => iterationsOf(v).length > 1 || renderings.get(v.id).length > 0;

  let activeId = null;   // the view the camera last went to
  let openId = null;     // the view whose iterations and renderings are open
  let shown = true;
  let pop = null;        // { viewId, index, el } while a rendering floats over the model
  const el = document.createElement('nav');
  el.className = 'cl-strip';
  el.setAttribute('aria-label', 'Saved views');

  function draw() {
    const now = show();
    const focus = document.activeElement && el.contains(document.activeElement) ? document.activeElement.dataset : null;
    el.innerHTML = views.map(v => {
      const its = iterationsOf(v), rs = renderings.get(v.id), more = its.length > 1 || rs.length > 0, open = more && v.id === openId;
      const src = pictureOf(v, now), extra = (its.length > 1 ? its.length : 0) + rs.length;
      const said = [its.length > 1 ? its.length + ' iterations' : '', rs.length ? rs.length + (rs.length === 1 ? ' rendering' : ' renderings') : ''].filter(Boolean).join(', ');
      return `<div class="cl-view${open ? ' open' : ''}${v.id === activeId ? ' on' : ''}" data-view="${escapeHtml(v.id)}">
        <button type="button" class="cl-thumb" data-go="${escapeHtml(v.id)}" ${more ? `aria-expanded="${open}"` : ''} title="${escapeHtml(v.name + (said ? ': ' + said : ''))}">
          ${src ? `<img src="${escapeHtml(url(src))}" alt="" draggable="false">` : ''}
          <span class="cl-name">${escapeHtml(v.name)}</span>${more ? `<b class="cl-count" aria-hidden="true">${extra}</b>` : ''}
        </button>${open ? `<div class="cl-more" role="group" aria-label="${escapeHtml('Iterations and renderings of ' + v.name)}">${
          (its.length > 1 ? its : []).map(s => {
            const p = pictures && pictures[v.id] && pictures[v.id][s.id];
            return `<button type="button" class="cl-card cl-iter${s.id === now ? ' on' : ''}" data-state="${escapeHtml(s.id)}" aria-pressed="${s.id === now}" title="${escapeHtml(s.label + ': show this in the model')}">
              ${p ? `<img src="${escapeHtml(url(p))}" alt="" draggable="false">` : ''}<i class="cl-kind">MODEL</i><span class="cl-name">${escapeHtml(s.label)}</span></button>`;
          }).join('')}${rs.map((r, i) => `<button type="button" class="cl-card cl-pic" data-rendering="${i}" title="${escapeHtml(renderingTitle(r) + ': open the picture')}">
              <img src="${escapeHtml(url(r.thumb))}" alt="" draggable="false"><i class="cl-kind">RENDERING</i><span class="cl-name">${escapeHtml(renderingTitle(r))}</span></button>`).join('')}</div>` : ''}
      </div>`;
    }).join('');
    if (focus) {
      const again = focus.go ? el.querySelector(`[data-go="${CSS.escape(focus.go)}"]`) : focus.state ? el.querySelector(`[data-state="${CSS.escape(focus.state)}"]`) : focus.rendering ? el.querySelector(`[data-rendering="${CSS.escape(focus.rendering)}"]`) : null;
      if (again) again.focus({ preventScroll: true });
    }
  }
  // Bring the open view and what it opened into the strip's own scroll, without moving the page.
  function reveal() {
    const box = el.querySelector('.cl-view.open') || el.querySelector('.cl-view.on');
    if (!box) return;
    const left = box.offsetLeft - 6, right = box.offsetLeft + box.offsetWidth + 6;
    if (left < el.scrollLeft || box.offsetWidth > el.clientWidth) el.scrollTo({ left, behavior: 'smooth' });
    else if (right > el.scrollLeft + el.clientWidth) el.scrollTo({ left: right - el.clientWidth, behavior: 'smooth' });
  }
  function attach() {
    const wrap = document.querySelector('.v-wrap');
    if (!wrap) return;
    if (el.parentNode !== wrap) wrap.append(el);
    wrap.classList.toggle('cl-strip-on', shown && views.length > 0);
  }
  function refresh(now = {}) {
    if ('view' in now && (now.view || null) !== activeId) {
      // Gone to from elsewhere (the left pane, the phone panel): the view opens what it has.
      activeId = now.view || null;
      const v = views.find(x => x.id === activeId);
      openId = v && hasMore(v) ? v.id : null;
      requestAnimationFrame(reveal);
    }
    if ('shown' in now) shown = now.shown !== false;
    el.hidden = !shown || !views.length;
    attach();
    draw();
  }

  el.addEventListener('click', e => {
    const t = e.target.closest('button');
    if (!t || !el.contains(t)) return;
    if (t.dataset.go) {
      const v = views.find(x => x.id === t.dataset.go);
      if (!v) return;
      // A click on the open view closes what it opened; the camera goes to the view either way.
      openId = hasMore(v) && openId !== v.id ? v.id : null;
      activeId = v.id;
      goTo(v.id);
      draw();
      reveal();
    } else if (t.dataset.state) setShow(t.dataset.state);
    else if (t.dataset.rendering) openPop(t.closest('[data-view]').dataset.view, Number(t.dataset.rendering));
  });
  // A mouse wheel moves the strip sideways.
  el.addEventListener('wheel', e => {
    if (el.scrollWidth <= el.clientWidth || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    el.scrollLeft += e.deltaY;
    e.preventDefault();
  }, { passive: false });

  // ---------- a rendering, floating over the model ----------
  function closePop() {
    if (!pop) return;
    pop.el.remove();
    pop = null;
  }
  function showPop() {
    const list = renderings.get(pop.viewId), r = list[pop.index], v = views.find(x => x.id === pop.viewId);
    pop.el.setAttribute('aria-label', 'Rendering of ' + v.name);
    pop.el.querySelector('.cl-pop-title').textContent = v.name + ' · ' + renderingTitle(r);
    pop.el.querySelector('.cl-pop-count').textContent = list.length > 1 ? (pop.index + 1) + ' of ' + list.length : '';
    for (const b of pop.el.querySelectorAll('[data-pop="prev"], [data-pop="next"]')) b.hidden = list.length < 2;
    const img = pop.el.querySelector('img');
    img.alt = v.name + ', ' + renderingTitle(r);
    img.src = url(r.path);
  }
  function stepPop(by) {
    const n = renderings.get(pop.viewId).length;
    pop.index = (pop.index + by + n) % n;
    showPop();
  }
  function openPop(viewId, index) {
    const list = renderings.get(viewId) || [];
    if (!list[index]) return;
    // Another rendering takes the window that is open, where the person put it.
    if (pop) { pop.viewId = viewId; pop.index = index; showPop(); pop.el.focus({ preventScroll: true }); return; }
    const box = document.createElement('div');
    box.className = 'cl-pop';
    box.setAttribute('role', 'dialog');
    box.tabIndex = -1;
    box.innerHTML = `<header class="cl-pop-bar"><span class="cl-pop-title"></span><span class="cl-pop-count"></span>
      <button type="button" data-pop="prev" aria-label="The rendering before" title="The rendering before (left arrow)">&#8249;</button>
      <button type="button" data-pop="next" aria-label="The next rendering" title="The next rendering (right arrow)">&#8250;</button>
      <button type="button" data-pop="close" aria-label="Close the picture" title="Close (Esc)">&#215;</button></header>
      <div class="cl-pop-body"><img alt="" draggable="false"></div>`;
    document.body.append(box);
    pop = { viewId, index, el: box };
    // As large as the window allows around the picture's own shape, clear of the strip.
    const r = list[index], shape = r.w > 0 && r.h > 0 ? r.w / r.h : 3 / 2, bar = 44;
    // Over the model, not the left pane beside it.
    const vw = window.innerWidth, vh = window.innerHeight, narrow = vw <= 760;
    const wrap = document.querySelector('.v-wrap'), over = wrap && !narrow ? wrap.getBoundingClientRect() : { left: 0, width: vw };
    let w = narrow ? vw - 16 : Math.min(over.width * 0.74, 1080), h = w / shape + bar;
    const room = vh * (narrow ? 0.72 : 0.74);
    if (h > room) { h = room; w = Math.max(240, (h - bar) * shape); }
    box.style.width = Math.round(w) + 'px'; box.style.height = Math.round(h) + 'px';
    box.style.left = Math.round(Math.max(8, over.left + (over.width - w) / 2)) + 'px';
    box.style.top = Math.round(Math.max(8, (vh - h) / 2 - (narrow ? 20 : 56))) + 'px';
    showPop();
    box.focus({ preventScroll: true });

    box.addEventListener('click', e => {
      const b = e.target.closest('[data-pop]');
      if (!b) return;
      if (b.dataset.pop === 'close') closePop(); else stepPop(b.dataset.pop === 'prev' ? -1 : 1);
    });
    box.addEventListener('keydown', e => {
      if (e.key === 'Escape') closePop();
      else if (e.key === 'ArrowLeft' && renderings.get(pop.viewId).length > 1) stepPop(-1);
      else if (e.key === 'ArrowRight' && renderings.get(pop.viewId).length > 1) stepPop(1);
      else return;
      e.preventDefault(); e.stopPropagation();
    });
    // Dragged by its bar; at least a strip of it stays on the screen.
    const head = box.querySelector('.cl-pop-bar');
    let grab = null;
    head.addEventListener('pointerdown', e => {
      if (e.target.closest('button')) return;
      const rect = box.getBoundingClientRect();
      grab = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
      head.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    head.addEventListener('pointermove', e => {
      if (!grab) return;
      const x = Math.min(window.innerWidth - 80, Math.max(80 - box.offsetWidth, e.clientX - grab.dx));
      const y = Math.min(window.innerHeight - 44, Math.max(0, e.clientY - grab.dy));
      box.style.left = Math.round(x) + 'px'; box.style.top = Math.round(y) + 'px';
    });
    const drop = () => { grab = null; };
    head.addEventListener('pointerup', drop);
    head.addEventListener('pointercancel', drop);
  }

  refresh();
  return {
    refresh,
    // Open the rendering sent as `id` (r1, r2...) over the model, and its view in the strip.
    openRendering(id) {
      for (const [viewId, list] of renderings) {
        const index = list.findIndex(r => r.id === id);
        if (index < 0) continue;
        openId = viewId; draw(); reveal();
        openPop(viewId, index);
        return true;
      }
      return false;
    },
    // For checks: what the strip shows.
    state: () => ({ active: activeId, open: openId, shown, pop: pop ? { view: pop.viewId, index: pop.index } : null }),
  };
}
