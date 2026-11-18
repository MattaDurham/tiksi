// PRODUCTS in a window of its own, floating over the other pages: moved by its title bar, sized
// from its corner, and kept where it was left (per browser). Its parts are PRODUCTS' own
// (products-hub.js), in a hub that leaves the address alone, so MODEL stays open underneath and
// trim catalog cards drag straight onto the model and its panel (product-drag.js).
// There is one PRODUCTS at a time: FLOAT in the tab moves it here and goes to MODEL; DOCK, or
// opening the PRODUCTS tab, puts it back in the tab.

const KEY = 'tiksi.productsFloat';
let win = null, view = null, opening = null;

export function productsFloating() { return !!win; }

function readPlace() {
  try { const v = JSON.parse(localStorage.getItem(KEY) || 'null'); if (v && [v.x, v.y, v.w, v.h].every(Number.isFinite)) return v; } catch { /* storage closed */ }
  return null;
}
function keepPlace() {
  if (!win) return;
  const r = win.getBoundingClientRect();
  try { localStorage.setItem(KEY, JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) })); } catch { /* storage closed */ }
}
// Keep the title bar on screen, whatever the window was resized to since.
function clampInto(x, y, w, h) {
  const vw = innerWidth, vh = innerHeight;
  w = Math.max(320, Math.min(w, vw - 16)); h = Math.max(260, Math.min(h, vh - 16));
  x = Math.max(8 - w + 120, Math.min(x, vw - 120)); y = Math.max(8, Math.min(y, vh - 40));
  return { x, y, w, h };
}
function place(p) {
  const c = clampInto(p.x, p.y, p.w, p.h);
  Object.assign(win.style, { left: c.x + 'px', top: c.y + 'px', width: c.w + 'px', height: c.h + 'px' });
}

// Open PRODUCTS floating, at `part` ('products', 'materials', 'trim', 'find'). From the tab
// (`fromTab`), the tab is left for MODEL first so the two never hold the same part at once.
export function openProductsFloat(part = 'trim', opts = {}) {
  if (opts.fromTab) {
    window.addEventListener('hashchange', () => openProductsFloat(part), { once: true });
    location.hash = '#/model';
    return Promise.resolve();
  }
  if (win) {
    if (part && view && view.part() !== part) win.querySelector(`.doc-parts [data-part="${part}"]`)?.click();
    win.querySelector('.pf-bar button')?.focus();
    return Promise.resolve();
  }
  if (opening) return opening;
  opening = Promise.all([import('./hub.js'), import('./products-hub.js')]).then(([{ hub }, { PARTS, partOf }]) => {
    opening = null;
    if (win) return;
    view = hub({ label: 'Products', parts: PARTS, partOf, floating: true });
    win = document.createElement('section');
    win.className = 'pf-win';
    win.setAttribute('role', 'dialog');
    win.setAttribute('aria-label', 'Products, floating');
    win.innerHTML = `<header class="pf-bar" title="Drag to move">
        <span class="pf-title">PRODUCTS</span><span class="pf-sp"></span>
        <button type="button" class="btn small" data-pf-dock title="Put PRODUCTS back in its tab and go there">DOCK</button>
        <button type="button" class="btn small" data-pf-close title="Close the floating window" aria-label="Close">CLOSE</button>
      </header><div class="pf-body"></div>`;
    document.body.appendChild(win);
    place(readPlace() || { x: 24, y: 120, w: Math.min(620, innerWidth - 48), h: Math.min(640, innerHeight - 160) });
    view.mount(win.querySelector('.pf-body'), part);
    win.querySelector('[data-pf-close]').onclick = () => closeProductsFloat();
    win.querySelector('[data-pf-dock]').onclick = () => {
      const at = PARTS.find(p => p.id === view.part()) || PARTS[0];
      closeProductsFloat();
      location.hash = at.addr;
    };
    bindMove(win.querySelector('.pf-bar'));
    new ResizeObserver(() => keepPlace()).observe(win);
    addEventListener('resize', onWindowResize);
  });
  return opening;
}

export function closeProductsFloat() {
  if (!win) return;
  keepPlace();
  try { view.unmount(); } catch (e) { console.error(e); }
  win.remove(); win = null; view = null;
  removeEventListener('resize', onWindowResize);
}

function onWindowResize() {
  if (!win) return;
  const r = win.getBoundingClientRect();
  place({ x: r.left, y: r.top, w: r.width, h: r.height });
}

function bindMove(bar) {
  bar.addEventListener('pointerdown', e => {
    if (e.button !== 0 || e.target.closest('button')) return;
    e.preventDefault();
    const r = win.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
    bar.setPointerCapture(e.pointerId);
    const move = ev => place({ x: ev.clientX - dx, y: ev.clientY - dy, w: r.width, h: r.height });
    const up = () => { bar.removeEventListener('pointermove', move); bar.removeEventListener('pointerup', up); bar.removeEventListener('pointercancel', up); keepPlace(); };
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', up);
    bar.addEventListener('pointercancel', up);
  });
}
