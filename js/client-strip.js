// The renderings on the client page (client-view.js). The saved views are the pills along the top
// of the model (viewer3d.js, as in MODEL); along the bottom runs a strip with:
//   - the iterations, when a project was sent ("Existing" and each project): a click changes the
//     model to that one, from wherever the camera is. "Iterations" is the owner's word for them;
//   - a small picture of every rendering, of every view, in the order of the views. The ones of
//     the view on screen are marked, and the strip brings them into sight when the view changes.
// A click on a rendering opens it in a window floating over the model, which can be dragged,
// resized and closed while the model stays in use behind it. Its arrows (and the arrow keys) step
// through every rendering, of every view, and the model goes to the view of the one showing.
// Going to another view while the window is open shows that view's first rendering. SEE THROUGH
// lays the rendering over the whole model, half clear, at the size that lines it up with the
// view's camera, so the model shows through it.
//
// Each rendering can carry the client's star and comment (client-notes.js); the window has both,
// and a starred or commented rendering is marked in the strip.
//
// The pictures come with the copy (lab-publish.js): copy.renderings = [{ id, key, view, label, day,
// w, h, path, thumb }] (key: the rendering's id in Tiksi; older copies have none).

import { escapeHtml } from './store.js';

const dayWords = day => {
  const d = new Date(day + 'T12:00:00');
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '';
};
export const renderingTitle = r => (r.label || 'Rendering') + (r.day && dayWords(r.day) ? ' · ' + dayWords(r.day) : '');
export const renderingKey = r => r.key || r.id;
const STAR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.2l2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 17l-5.4 2.9 1.1-6.1-4.5-4.2 6.1-.8z"/></svg>';
const NOTE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z"/></svg>';
const sayWhere = { online: 'Saved on the website for you.', failed: 'Not saved on the website yet; kept in this browser.', browser: 'Kept in this browser only.' };

// `states` = [{ id, label }] with Existing first; `show()` is the state on now and `setShow(id)`
// changes it; `goTo(viewId)` moves the camera to a saved view; `notes` = createNotes(...).
// Returns { refresh({ view }), openRendering(id), state() }.
export function mountStrip({ copy, data, states, show, setShow, goTo, notes }) {
  const views = (copy.property && copy.property.savedViews) || [];
  const name = new Map(views.map(v => [v.id, v.name]));
  const sent = Array.isArray(copy.renderings) ? copy.renderings : [];
  // Every rendering, in the order of the views, each view's in the order sent.
  const all = views.flatMap(v => sent.filter(r => r.view === v.id));
  const url = path => data + path;
  const titleOf = r => name.get(r.view) + ' · ' + renderingTitle(r);

  let activeId = null;   // the view the camera last went to
  let pop = null;        // { index, el, see, was } while a rendering floats over the model
  const el = document.createElement('nav');
  el.className = 'cl-strip';
  el.setAttribute('aria-label', 'Renderings');

  function draw() {
    const now = show();
    const focus = document.activeElement && el.contains(document.activeElement) ? document.activeElement.dataset : null;
    const iters = states.length > 1 ? `<div class="cl-iters" role="group" aria-label="Iterations">${states.map(s =>
      `<button type="button" class="cl-iter${s.id === now ? ' on' : ''}" data-state="${escapeHtml(s.id)}" aria-pressed="${s.id === now}" title="${escapeHtml(s.label + ': show this in the model')}">${escapeHtml(s.label)}</button>`).join('')}</div>` : '';
    el.innerHTML = iters + all.map((r, i) => {
      const n = notes ? notes.get(renderingKey(r)) : null, here = r.view === activeId, open = pop && pop.index === i;
      return `<button type="button" class="cl-card${here ? ' here' : ''}${open ? ' open' : ''}" data-rendering="${i}" title="${escapeHtml(titleOf(r) + ': open the picture')}">
        <img src="${escapeHtml(url(r.thumb))}" alt="" draggable="false" loading="lazy"><span class="cl-name">${escapeHtml(name.get(r.view))}</span>
        ${n && (n.star || n.comment.trim()) ? `<span class="cl-marks">${n.star ? `<i class="cl-mark star" title="Starred">${STAR}</i>` : ''}${n.comment.trim() ? `<i class="cl-mark note" title="Has a comment">${NOTE}</i>` : ''}</span>` : ''}
      </button>`;
    }).join('');
    el.hidden = !all.length && !iters;
    if (focus) {
      const again = focus.state ? el.querySelector(`[data-state="${CSS.escape(focus.state)}"]`) : focus.rendering ? el.querySelector(`[data-rendering="${CSS.escape(focus.rendering)}"]`) : null;
      if (again) again.focus({ preventScroll: true });
    }
  }
  // Bring the renderings of the view on screen (or the one open) into the strip's own scroll,
  // without moving the page.
  function reveal() {
    const first = el.querySelector('.cl-card.open') || el.querySelector('.cl-card.here');
    if (!first) return;
    const cards = pop ? [first] : [...el.querySelectorAll('.cl-card.here')], last = cards[cards.length - 1];
    const left = first.offsetLeft - 6, right = last.offsetLeft + last.offsetWidth + 6;
    if (left < el.scrollLeft || right - left > el.clientWidth) el.scrollTo({ left, behavior: 'smooth' });
    else if (right > el.scrollLeft + el.clientWidth) el.scrollTo({ left: right - el.clientWidth, behavior: 'smooth' });
  }
  function attach() {
    const wrap = document.querySelector('.v-wrap');
    if (!wrap) return;
    if (el.parentNode !== wrap) wrap.append(el);
    wrap.classList.toggle('cl-strip-on', !el.hidden);
  }
  function refresh(now = {}) {
    if ('view' in now && (now.view || null) !== activeId) {
      activeId = now.view || null;
      // Gone to another view with a rendering open: that view's first rendering shows, if it has one.
      if (pop && all[pop.index].view !== activeId) {
        const i = all.findIndex(r => r.view === activeId);
        if (i >= 0) { pop.index = i; showPop(); }
      }
      requestAnimationFrame(reveal);
    }
    draw();
    attach();
  }

  el.addEventListener('click', e => {
    const t = e.target.closest('button');
    if (!t || !el.contains(t)) return;
    if (t.dataset.state) setShow(t.dataset.state);
    else if (t.dataset.rendering) openPop(Number(t.dataset.rendering));
  });
  // A mouse wheel moves the strip sideways.
  el.addEventListener('wheel', e => {
    if (el.scrollWidth <= el.clientWidth || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    el.scrollLeft += e.deltaY;
    e.preventDefault();
  }, { passive: false });
  if (notes) notes.onChange(() => { draw(); if (pop) showNote(); });

  // ---------- a rendering, floating over the model ----------
  function closePop() {
    if (!pop) return;
    if (notes) notes.flush();
    pop.el.remove();
    pop = null;
    draw();
  }
  // The model goes to the view of the rendering showing.
  function follow() {
    const r = all[pop.index];
    if (r.view !== activeId) { activeId = r.view; goTo(r.view); }
  }
  function showPop() {
    const r = all[pop.index];
    pop.el.setAttribute('aria-label', 'Rendering of ' + name.get(r.view));
    pop.el.querySelector('.cl-pop-title').textContent = titleOf(r);
    pop.el.querySelector('.cl-pop-count').textContent = all.length > 1 ? (pop.index + 1) + ' of ' + all.length : '';
    for (const b of pop.el.querySelectorAll('[data-pop="prev"], [data-pop="next"]')) b.hidden = all.length < 2;
    const img = pop.el.querySelector('.cl-pop-body img');
    img.alt = name.get(r.view) + ', ' + renderingTitle(r);
    img.src = url(r.path);
    showNote();
    draw();
    reveal();
  }
  // The star, the comment box and, for the owner, what everyone else said about this rendering.
  function showNote() {
    const box = pop.el.querySelector('.cl-pop-note');
    if (!notes) { box.hidden = true; return; }
    const key = renderingKey(all[pop.index]), n = notes.get(key);
    const star = box.querySelector('[data-pop="star"]');
    star.setAttribute('aria-pressed', String(n.star));
    star.title = n.star ? 'Take the star off this rendering' : 'Star this rendering: one you like';
    const text = box.querySelector('textarea');
    if (text.dataset.key !== key) { text.value = n.comment; text.dataset.key = key; }
    else if (document.activeElement !== text && text.value !== n.comment) text.value = n.comment;
    box.querySelector('.cl-pop-saved').textContent = n.star || n.comment.trim() ? sayWhere[notes.where()] : '';
    const others = notes.others(key);
    box.querySelector('.cl-pop-others').innerHTML = others.map(o => `<p><b>${escapeHtml(o.by)}</b>${o.star ? `<i class="cl-mark star">${STAR}</i>` : ''}${o.comment.trim() ? ' ' + escapeHtml(o.comment) : ''}</p>`).join('');
  }
  function stepPop(by) {
    pop.index = (pop.index + by + all.length) % all.length;
    follow();
    showPop();
  }
  // Over the model, at a size that keeps the picture's shape, clear of the strip.
  function place(r) {
    const box = pop.el, shape = r.w > 0 && r.h > 0 ? r.w / r.h : 3 / 2, bar = 44, foot = notes ? 92 : 0;
    const vw = window.innerWidth, vh = window.innerHeight, narrow = vw <= 760;
    const wrap = document.querySelector('.v-wrap'), over = wrap && !narrow ? wrap.getBoundingClientRect() : { left: 0, width: vw };
    let w = narrow ? vw - 16 : Math.min(over.width * 0.74, 1080), h = w / shape + bar + foot;
    const room = vh * (narrow ? 0.8 : 0.78);
    if (h > room) { h = room; w = Math.max(240, (h - bar - foot) * shape); }
    box.style.width = Math.round(w) + 'px'; box.style.height = Math.round(h) + 'px';
    box.style.left = Math.round(Math.max(8, over.left + (over.width - w) / 2)) + 'px';
    box.style.top = Math.round(Math.max(8, (vh - h) / 2 - (narrow ? 10 : 40))) + 'px';
  }
  // SEE THROUGH: the window moves into the model's frame, under its pills and strip, and covers
  // it; the picture, half clear, is as tall as the model on the screen, so it lines up with the
  // view's camera (its angle is a vertical one).
  function setSee(on) {
    if (!pop || pop.see === on) return;
    const box = pop.el, wrap = document.querySelector('.v-wrap');
    if (on && !wrap) return;
    if (on) {
      pop.was = { left: box.style.left, top: box.style.top, width: box.style.width, height: box.style.height };
      // The camera goes back to the view, so the model is where the rendering was made from.
      activeId = all[pop.index].view; goTo(activeId);
      for (const k of ['left', 'top', 'width', 'height']) box.style[k] = '';
      wrap.append(box);
    } else {
      document.body.append(box);
      if (pop.was) Object.assign(box.style, pop.was);
    }
    box.focus({ preventScroll: true });
    pop.see = on;
    box.classList.toggle('see', on);
    const b = box.querySelector('[data-pop="see"]');
    b.setAttribute('aria-pressed', String(on));
    b.title = on ? 'Show the rendering whole again' : 'See through: lay the rendering over the model, half clear';
  }

  function openPop(index) {
    if (!all[index]) return;
    // Another rendering takes the window that is open, where the person put it.
    if (pop) { pop.index = index; follow(); showPop(); pop.el.focus({ preventScroll: true }); return; }
    const box = document.createElement('div');
    box.className = 'cl-pop';
    box.setAttribute('role', 'dialog');
    box.tabIndex = -1;
    box.innerHTML = `<header class="cl-pop-bar"><span class="cl-pop-title"></span><span class="cl-pop-count"></span>
      <button type="button" class="cl-pop-see" data-pop="see" aria-pressed="false" title="See through: lay the rendering over the model, half clear"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="12" height="12" rx="1.5"/><rect x="9" y="8" width="12" height="12" rx="1.5"/></svg><span>SEE THROUGH</span></button>
      <button type="button" data-pop="prev" aria-label="The rendering before" title="The rendering before (left arrow)">&#8249;</button>
      <button type="button" data-pop="next" aria-label="The next rendering" title="The next rendering (right arrow)">&#8250;</button>
      <button type="button" data-pop="close" aria-label="Close the picture" title="Close (Esc)">&#215;</button></header>
      <div class="cl-pop-body"><img alt="" draggable="false"></div>
      <footer class="cl-pop-note">
        <button type="button" class="cl-pop-star" data-pop="star" aria-pressed="false">${STAR}</button>
        <div class="cl-pop-say"><textarea rows="2" maxlength="4000" placeholder="A comment on this rendering" aria-label="Your comment on this rendering"></textarea>
          <span class="cl-pop-saved" aria-live="polite"></span><div class="cl-pop-others"></div></div>
      </footer>`;
    document.body.append(box);
    pop = { index, el: box, see: false, was: null };
    follow();
    place(all[index]);
    showPop();
    box.focus({ preventScroll: true });

    box.addEventListener('click', e => {
      const b = e.target.closest('[data-pop]');
      if (!b) return;
      const act = b.dataset.pop;
      if (act === 'close') closePop();
      else if (act === 'see') setSee(!pop.see);
      else if (act === 'star') { const key = renderingKey(all[pop.index]); notes.set(key, { star: !notes.get(key).star, view: all[pop.index].view }); }
      else stepPop(act === 'prev' ? -1 : 1);
    });
    const text = box.querySelector('textarea');
    text.addEventListener('input', () => notes.set(text.dataset.key, { comment: text.value, view: all[pop.index].view }, { soon: true }));
    text.addEventListener('blur', () => notes.flush());
    box.addEventListener('keydown', e => {
      if (e.target === text) { if (e.key === 'Escape') { text.blur(); box.focus({ preventScroll: true }); e.preventDefault(); } e.stopPropagation(); return; }
      if (e.key === 'Escape') closePop();
      else if (e.key === 'ArrowLeft' && all.length > 1) stepPop(-1);
      else if (e.key === 'ArrowRight' && all.length > 1) stepPop(1);
      else return;
      e.preventDefault(); e.stopPropagation();
    });
    // Dragged by its bar; at least a strip of it stays on the screen.
    const head = box.querySelector('.cl-pop-bar');
    let grab = null;
    head.addEventListener('pointerdown', e => {
      if (e.target.closest('button') || pop.see) return;
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
    // Open the rendering sent as `id` (r1, r2...) over the model.
    openRendering(id) {
      const index = all.findIndex(r => r.id === id);
      if (index < 0) return false;
      openPop(index);
      return true;
    },
    // For checks: what the strip and the window show.
    state: () => ({ active: activeId, cards: all.length, here: all.filter(r => r.view === activeId).length,
      pop: pop ? { index: pop.index, id: all[pop.index].id, view: all[pop.index].view, see: pop.see } : null }),
  };
}
