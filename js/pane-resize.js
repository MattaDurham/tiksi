// tiksi - drag the border of a view's right-hand pane to resize it.
// A pane opts in with data-side-pane="<key>"; its layout (the pane's parent) then reads the width
// from --side-w, and each key remembers its own width in this browser.

const MIN_W = 220;
const MIN_MAIN = 320;     // the content column beside the pane never gets narrower than this
const STEP = 16;          // arrow-key step
const KEY = k => 'tiksi.sidePane.' + k;

const tracked = new Map();   // pane -> { handle, ro }

function saved(key) {
  try { const w = Number(localStorage.getItem(KEY(key))); return w > 0 ? w : 0; } catch (e) { return 0; }
}
function remember(key, w) {
  try { if (w) localStorage.setItem(KEY(key), String(Math.round(w))); else localStorage.removeItem(KEY(key)); } catch (e) { /* not fatal */ }
}

// The in-flow column just before the pane: the one that gives up width as the pane grows.
function mainOf(pane) {
  let m = pane.previousElementSibling;
  while (m && /absolute|fixed/.test(getComputedStyle(m).position)) m = m.previousElementSibling;
  return m;
}

function maxWidth(pane) {
  const main = mainOf(pane);
  // A closed pane has no geometry yet; it is clamped again when it opens.
  if (!main || !pane.offsetParent) return 720;
  return Math.max(MIN_W, pane.getBoundingClientRect().right - main.getBoundingClientRect().left - MIN_MAIN);
}

const clamp = (pane, w) => Math.round(Math.min(Math.max(w, MIN_W), maxWidth(pane)));

function apply(pane, w) {
  const layout = pane.parentElement;
  if (w) layout.style.setProperty('--side-w', clamp(pane, w) + 'px');
  else layout.style.removeProperty('--side-w');
  const t = tracked.get(pane);
  if (t) place(pane, t.handle);
  // Canvases that only listen to the window (measure's frame stage) re-fit too.
  window.dispatchEvent(new Event('resize'));
}

// Sits on the pane's left border; hidden when the pane is closed or stacked under the content.
function place(pane, handle) {
  const layout = pane.parentElement;
  const beside = !!pane.offsetParent && pane.offsetWidth > 0
    && getComputedStyle(layout).gridTemplateColumns.split(' ').length > 1;
  handle.hidden = !beside;
  if (!beside) return;
  const main = mainOf(pane);
  const gap = main ? pane.offsetLeft - (main.offsetLeft + main.offsetWidth) : 0;
  handle.style.left = (pane.offsetLeft - gap / 2 - 4) + 'px';
  handle.style.top = pane.offsetTop + 'px';
  handle.style.height = pane.offsetHeight + 'px';
}

function attach(pane) {
  const key = pane.dataset.sidePane;
  const layout = pane.parentElement;
  layout.classList.add('side-resizable');
  const handle = document.createElement('div');
  handle.className = 'side-handle';
  handle.tabIndex = 0;
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', 'vertical');
  handle.setAttribute('aria-label', 'Resize panel');
  handle.title = 'Drag to resize. Double-click to reset.';
  layout.append(handle);

  const w = saved(key);
  if (w) layout.style.setProperty('--side-w', clamp(pane, w) + 'px');

  handle.onpointerdown = e => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX, startW = pane.getBoundingClientRect().width;
    let frame = 0, next = startW;
    document.body.classList.add('side-resizing');
    handle.onpointermove = ev => {
      next = startW + (startX - ev.clientX);
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; apply(pane, next); });
    };
    handle.onpointerup = handle.onpointercancel = () => {
      handle.onpointermove = handle.onpointerup = handle.onpointercancel = null;
      document.body.classList.remove('side-resizing');
      if (frame) cancelAnimationFrame(frame);
      apply(pane, next);
      remember(key, clamp(pane, next));
    };
  };
  handle.ondblclick = () => { remember(key, 0); apply(pane, 0); };
  handle.onkeydown = e => {
    const d = e.key === 'ArrowLeft' ? STEP : e.key === 'ArrowRight' ? -STEP : 0;
    if (!d) return;
    e.preventDefault();
    const nw = clamp(pane, pane.getBoundingClientRect().width + d);
    apply(pane, nw);
    remember(key, nw);
  };

  // Re-place on any size change of the pane or its layout; a saved width re-clamps to the window.
  const ro = new ResizeObserver(() => {
    const sw = saved(key);
    if (sw) { const c = clamp(pane, sw) + 'px'; if (layout.style.getPropertyValue('--side-w') !== c) layout.style.setProperty('--side-w', c); }
    place(pane, handle);
  });
  ro.observe(pane);
  ro.observe(layout);
  tracked.set(pane, { handle, ro });
  place(pane, handle);
}

function sweep(root) {
  for (const [pane, t] of tracked) {
    if (!pane.isConnected) { t.ro.disconnect(); t.handle.remove(); tracked.delete(pane); }
  }
  root.querySelectorAll('[data-side-pane]').forEach(pane => { if (!tracked.has(pane)) attach(pane); });
}

// Views re-render their markup freely, so watch the view root and attach to new panes as they appear.
export function initPaneResize(root) {
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => { queued = false; sweep(root); });
  }).observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
  sweep(root);
}
