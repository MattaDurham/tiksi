// tiksi - MODEL BESIDE: the 3D model in a pane next to any other page.
// The switch in the top bar puts the model on the right of the page; the bar between them drags
// to share the width (arrow keys move it, a double-click puts it back to half). Both choices are
// remembered in this browser. On the MODEL page the model is the page itself, and the phone
// layout has no room for two panes, so neither shows the second pane.
//
// While the model is beside a page, links on that page that open an element in MODEL
// (#/model?select=<id>) select it in the pane instead of leaving the page, and the page can
// outline its own records there with showInModel (model-focus.js).

import * as viewer3d from './viewer3d.js';
import { setModelFocus, showInModel } from './model-focus.js';
import { icon } from './icons.js';

const WANT = 'tiksi.modelBeside';          // '1' when the person wants the model beside pages
const SPLIT = 'tiksi.modelBeside.split';   // the page's share of the width, 0.2 to 0.8
const MIN_PANE = 280;                      // neither side gets narrower than this (px)
const STEP = 24;                           // arrow-key step (px)

let stage, view, bar, pane, body, toggle;
let wanted = false, mounted = false, pageName = '', offFocus = null;

const read = k => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* not remembered */ } };
const phone = () => document.documentElement.classList.contains('phone');
const stacked = () => !!stage && getComputedStyle(stage).flexDirection === 'column';

export function besideWanted() { return wanted; }
export function besideShown() { return mounted; }

// Once, at start: the pane, the bar, the switch and the link and layout watchers.
export function initBeside({ onOpenModel } = {}) {
  stage = document.getElementById('stage');
  view = document.getElementById('view');
  bar = document.getElementById('beside-bar');
  pane = document.getElementById('beside');
  toggle = document.getElementById('btn-beside');
  if (!stage || !view || !bar || !pane) return;
  wanted = read(WANT) === '1';
  pane.innerHTML = `<div class="bs-head"><span class="bs-title">${icon('model', { size: 13 })}MODEL</span>
    <button type="button" class="btn small ghost" data-bs-open title="Open the MODEL page with this view">OPEN MODEL</button>
    <button type="button" class="bs-close" data-bs-close title="Close the model beside the page" aria-label="Close the model beside the page">${icon('close', { size: 13 })}</button></div>
    <div class="bs-body"></div>`;
  body = pane.querySelector('.bs-body');
  pane.querySelector('[data-bs-close]').onclick = () => setWanted(false);
  pane.querySelector('[data-bs-open]').onclick = () => { if (onOpenModel) onOpenModel(); else location.hash = '#/model'; };
  if (toggle) toggle.onclick = () => setWanted(!wanted);
  applySplit(Number(read(SPLIT)) || 0.5);
  bindBar();
  // A link on the page that would open an element in MODEL selects it here instead.
  document.addEventListener('click', e => {
    if (!mounted || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest && e.target.closest('a[href^="#/model?select="]');
    if (!a || !view.contains(a)) return;
    const m = /[?&]select=([^&]+)/.exec(a.getAttribute('href'));
    if (!m) return;
    e.preventDefault();
    if (!showInModel([decodeURIComponent(m[1])], { frame: 'always' })) flash('That element is not in the model.');
  }, true);
  // The phone layout comes and goes with the window and the FILE > Settings choice.
  new MutationObserver(() => syncBeside(pageName)).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  showToggle();
}

function setWanted(on) {
  wanted = !!on;
  write(WANT, wanted ? '1' : null);
  showToggle();
  syncBeside(pageName);
}

function showToggle() {
  if (!toggle) return;
  toggle.setAttribute('aria-pressed', String(wanted));
  toggle.classList.toggle('on', wanted);
  toggle.title = wanted ? 'The model shows beside every page. Click to close it.' : 'Show the model beside the other pages';
}

// After a page opens (main.js): show or take away the pane for it. The pane stays open, with
// its camera, while the person moves between pages.
export function syncBeside(name) {
  pageName = name;
  if (!stage) return;
  const show = wanted && name && name !== 'model' && !phone();
  if (show && !mounted) {
    stage.classList.add('beside');
    bar.hidden = false; pane.hidden = false;
    body.innerHTML = '';
    viewer3d.keepViewOnNextMount();
    viewer3d.mountBeside(body);
    mounted = true;
    offFocus = setModelFocus((ids, opts) => viewer3d.showElements(ids, opts));
    window.dispatchEvent(new Event('resize'));
  } else if (!show && mounted) closeBeside();
  else if (!show) { stage.classList.remove('beside'); bar.hidden = true; pane.hidden = true; }
}

// Take the model out of the pane (before the MODEL page opens it, or to rebuild it).
export function closeBeside() {
  if (!stage) return;
  if (mounted) {
    if (offFocus) { offFocus(); offFocus = null; }
    try { viewer3d.unmount(); } catch (e) { console.error('the model beside the page could not close', e); }
    viewer3d.keepViewOnNextMount();
    mounted = false;
    body.innerHTML = '';
  }
  stage.classList.remove('beside');
  bar.hidden = true; pane.hidden = true;
  window.dispatchEvent(new Event('resize'));
}

// A change from another device: the model redraws what it can in place, else it is rebuilt
// with the same camera.
export function besideSharedChange(keys) {
  if (!mounted) return;
  if (keys && viewer3d.sharedChange(keys)) return;
  closeBeside();
  syncBeside(pageName);
}

// ---------- the bar between the page and the model ----------
let share = 0.5;
function applySplit(f) {
  share = Math.min(0.8, Math.max(0.2, f || 0.5));
  stage.style.setProperty('--beside-page', (share * 100).toFixed(2) + '%');
  if (bar) bar.setAttribute('aria-valuenow', String(Math.round(share * 100)));
}
// The page's share for a page side of `px` pixels, keeping both sides at least MIN_PANE wide.
function shareFor(px) {
  const r = stage.getBoundingClientRect(), whole = (stacked() ? r.height : r.width) - (stacked() ? bar.offsetHeight : bar.offsetWidth);
  if (whole <= 2 * MIN_PANE) return 0.5;
  return Math.min(whole - MIN_PANE, Math.max(MIN_PANE, px)) / whole;
}
function pagePx() { const r = view.getBoundingClientRect(); return stacked() ? r.height : r.width; }
function settle() { write(SPLIT, String(Math.round(share * 1000) / 1000)); window.dispatchEvent(new Event('resize')); }

function bindBar() {
  bar.setAttribute('role', 'separator');
  bar.setAttribute('aria-label', 'Share the width between the page and the model');
  bar.setAttribute('aria-valuemin', '20'); bar.setAttribute('aria-valuemax', '80');
  bar.tabIndex = 0;
  bar.title = 'Drag to share the width between the page and the model. Double-click for half and half.';
  bar.onpointerdown = e => {
    if (e.button !== 0) return;
    e.preventDefault();
    bar.setPointerCapture(e.pointerId);
    const vertical = stacked(), start = vertical ? e.clientY : e.clientX, from = pagePx();
    document.body.classList.add('beside-resizing', vertical ? 'beside-rows' : 'beside-cols');
    let frame = 0, next = from;
    const move = ev => {
      next = from + ((vertical ? ev.clientY : ev.clientX) - start);
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; applySplit(shareFor(next)); });
    };
    const up = () => {
      bar.removeEventListener('pointermove', move); bar.removeEventListener('pointerup', up); bar.removeEventListener('pointercancel', up);
      cancelAnimationFrame(frame); frame = 0;
      applySplit(shareFor(next));
      document.body.classList.remove('beside-resizing', 'beside-rows', 'beside-cols');
      settle();
    };
    bar.addEventListener('pointermove', move); bar.addEventListener('pointerup', up); bar.addEventListener('pointercancel', up);
  };
  bar.ondblclick = () => { applySplit(0.5); settle(); };
  bar.onkeydown = e => {
    const back = stacked() ? 'ArrowUp' : 'ArrowLeft', on = stacked() ? 'ArrowDown' : 'ArrowRight';
    if (e.key !== back && e.key !== on) return;
    e.preventDefault();
    applySplit(shareFor(pagePx() + (e.key === on ? STEP : -STEP)));
    settle();
  };
}

function flash(text) {
  const n = document.createElement('div');
  n.className = 'bs-flash'; n.setAttribute('role', 'status'); n.textContent = text;
  pane.append(n);
  setTimeout(() => n.remove(), 2600);
}
