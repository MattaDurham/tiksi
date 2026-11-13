// The desktop frame around the pages: the Tiksi menu, the page tabs across the top and the
// left pane.
//
// The Tiksi menu (the logo at the top left) holds the project list, FILE, GUIDE, UNDO and REDO,
// the phone layout and the switch for the left pane. The page tabs (PLAN, MODEL, ...) run across
// the top; right-click them to show the icon alone or the icon and the word. The save status sits
// at the right end of the top bar.
//
// The left pane holds every command the current page offers, in groups. A page registers them
// with setMenuProvider(() => groups), where a group is
//   { title, screen?: { id, on, label }, items: [{ label, key?, active?, run, icon?, dot?, act?, data?, cls?, title?, disabled? }] }
// Each group folds to its header and opens again (a click on the header); that choice is this
// browser's. `screen` is an element over the page that the group's eye shows or hides (the saved
// view tabs, the display bar, ...); that choice is this browser's too (localStorage), the same for
// every project. `act` and `data` become data- attributes on the item's button.

import { icon } from './icons.js';

const KEY = 'tiksi.onScreen.v1', SHUT = 'tiksi.paneShut.v1', TABS = 'tiksi.tabLabels.v1';
const listeners = new Set();
let prefs = readPrefs();
let provider = null, menuEl = null, button = null, restartAction = null;

function readJson(key) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}
function writeJson(key, v) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* private window: this session only */ }
}
function readPrefs() { return readJson(KEY); }

// Whether an element is on the screen. { all: true } in the stored choices puts everything on
// it (browser tests that drive the on-screen buttons use that); a choice stored for one element
// beside it still counts ({ all: true, 'model.objects': false } is everything but that one).
export function onScreen(id, fallback) {
  if (typeof prefs[id] === 'boolean') return prefs[id];
  return prefs.all === true ? true : fallback;
}
export function setOnScreen(id, on) {
  prefs = readPrefs();
  prefs[id] = !!on;
  delete prefs.all;
  writeJson(KEY, prefs);
  for (const fn of listeners) { try { fn(id, !!on); } catch (e) { console.error(e); } }
  refreshPane();
}
// Forget every ON SCREEN choice: the screen goes back to how Tiksi starts ({ all: true } puts
// every element on it instead). Folded pane groups open again.
export function resetScreen(all = false) {
  prefs = all ? { all: true } : {};
  try { if (all) localStorage.setItem(KEY, JSON.stringify(prefs)); else localStorage.removeItem(KEY); localStorage.removeItem(SHUT); } catch { /* this session only */ }
  for (const fn of listeners) { try { fn('*', null); } catch (e) { console.error(e); } }
  refreshPane();
}
export function onScreenChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
// RESTART TIKSI at the bottom of the menu, shown once the Mac's server offers it (js/main.js).
export function setRestartAction(fn) { restartAction = fn; if (menuEl) renderMenu(); }
export function setMenuProvider(fn) {
  provider = fn;
  refreshPane();
  return () => { if (provider === fn) { provider = null; refreshPane(); } };
}

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const attr = k => String(k).replace(/[^\w-]/g, '').replace(/[A-Z]/g, c => '-' + c.toLowerCase());

// ---------- the left pane ----------
let paneGroups = [], paneHtml = null, paneQueued = false;
// Pages call this whenever what they offer may have changed; one redraw per turn of the page.
export function refreshPane() {
  if (paneQueued) return;
  paneQueued = true;
  queueMicrotask(() => { paneQueued = false; renderPane(); });
}
const groupId = g => g.id || g.title;
function itemHtml(it, gi, ii) {
  const data = Object.entries(it.data || {}).map(([k, v]) => ` data-${attr(k)}="${esc(v)}"`).join('');
  const title = it.title || it.label + (it.key ? ' (' + it.key + ')' : '');
  return `<button type="button" class="sd-item${it.cls ? ' ' + esc(it.cls) : ''}${it.active ? ' active' : ''}" data-item="${gi}:${ii}"${it.act ? ` data-act="${esc(it.act)}"` : ''}${data}${it.disabled ? ' disabled' : ''}${it.pressed != null ? ` aria-pressed="${!!it.pressed}"` : ''} title="${esc(title)}">`
    + (it.icon ? icon(it.icon) : '<span class="sd-gap"></span>')
    + (it.dot != null ? `<i class="sd-dot" style="background:${esc(it.dot)}"></i>` : '')
    + `<span class="sd-label">${esc(it.label)}</span>${it.key ? `<kbd class="key">${esc(it.key)}</kbd>` : ''}</button>`;
}
function renderPane() {
  const side = document.getElementById('side'), app = document.getElementById('app');
  if (!side || !app) return;
  paneGroups = (provider ? provider() : []).filter(g => g && (g.items.length || g.screen));
  const shown = paneGroups.length > 0 && onScreen('app.side', true);
  app.classList.toggle('no-side', !shown);
  side.hidden = !shown;
  const shut = readJson(SHUT);
  const html = paneGroups.map((g, gi) => {
    const id = groupId(g), closed = shut[id] === true;
    const eye = g.screen ? `<button type="button" class="sd-eye${g.screen.on ? ' on' : ''}" data-screen="${esc(g.screen.id)}" aria-pressed="${!!g.screen.on}" title="${esc((g.screen.on ? 'Hide ' : 'Show ') + (g.screen.label || 'this group over the page').replace(/^./, c => c.toLowerCase()))}">${icon(g.screen.on ? 'eye' : 'eye-off')}</button>` : '';
    return `<section class="sd-group${closed ? ' shut' : ''}" data-group="${esc(id)}">
      <header><button type="button" class="sd-head" data-fold="${gi}" aria-expanded="${!closed}" title="${closed ? 'Open' : 'Fold'} ${esc(g.title)}">${icon('chevron-down')}<span>${esc(g.title.toUpperCase())}</span></button>${eye}</header>
      ${closed || !g.items.length ? '' : `<div class="sd-items">${g.items.map((it, ii) => itemHtml(it, gi, ii)).join('')}</div>`}
    </section>`;
  }).join('');
  if (html === paneHtml) return;
  paneHtml = html;
  side.innerHTML = html;
}
// Fold or open one group. Returns whether it is open now.
export function setGroupOpen(id, open) {
  const shut = readJson(SHUT);
  if (open) delete shut[id]; else shut[id] = true;
  writeJson(SHUT, shut);
  renderPane();
  return open;
}
function bindPane() {
  const side = document.getElementById('side');
  if (!side || side.dataset.bound) return;
  side.dataset.bound = '1';
  side.addEventListener('click', e => {
    const fold = e.target.closest('[data-fold]');
    if (fold) {
      const g = paneGroups[+fold.dataset.fold];
      if (g) setGroupOpen(groupId(g), fold.getAttribute('aria-expanded') !== 'true');
      return;
    }
    const eye = e.target.closest('[data-screen]');
    if (eye) { setOnScreen(eye.dataset.screen, eye.getAttribute('aria-pressed') !== 'true'); return; }
    const b = e.target.closest('[data-item]');
    if (!b || b.disabled) return;
    const [gi, ii] = b.dataset.item.split(':').map(Number), it = paneGroups[gi] && paneGroups[gi].items[ii];
    if (!it) return;
    it.run();
    refreshPane();
  });
}

// ---------- the page tabs ----------
// Right-click a tab: the icon alone, or the icon and the word (the default).
export function tabLabels() { const v = readJson(TABS).show; return v === 'icons' ? 'icons' : 'words'; }
export function setTabLabels(which) {
  writeJson(TABS, { show: which === 'icons' ? 'icons' : 'words' });
  applyTabLabels();
}
function applyTabLabels() {
  const app = document.getElementById('app');
  if (app) app.classList.toggle('tabs-icons', tabLabels() === 'icons');
}
let tabMenu = null;
function closeTabMenu() {
  if (!tabMenu) return;
  tabMenu.remove(); tabMenu = null;
  document.removeEventListener('pointerdown', tabOutside, true);
  document.removeEventListener('keydown', tabKey, true);
}
function tabOutside(e) { if (tabMenu && !tabMenu.contains(e.target)) closeTabMenu(); }
function tabKey(e) { if (e.key === 'Escape') { e.preventDefault(); closeTabMenu(); } }
export function openTabMenu(x, y) {
  closeTabMenu();
  close();
  tabMenu = document.createElement('div');
  tabMenu.className = 'tk-tabmenu';
  tabMenu.setAttribute('role', 'menu');
  tabMenu.setAttribute('aria-label', 'Page tabs');
  const now = tabLabels();
  tabMenu.innerHTML = [['icons', 'Icon only'], ['words', 'Icon and word']].map(([id, label]) =>
    `<button type="button" role="menuitemradio" aria-checked="${now === id}" class="tk-item${now === id ? ' active' : ''}" data-tab-labels="${id}"><span>${label}</span></button>`).join('');
  document.body.appendChild(tabMenu);
  const w = tabMenu.offsetWidth || 180;
  tabMenu.style.left = Math.max(8, Math.min(x, window.innerWidth - w - 8)) + 'px';
  tabMenu.style.top = (y + 4) + 'px';
  tabMenu.querySelectorAll('[data-tab-labels]').forEach(b => b.onclick = () => { setTabLabels(b.dataset.tabLabels); closeTabMenu(); });
  setTimeout(() => {
    document.addEventListener('pointerdown', tabOutside, true);
    document.addEventListener('keydown', tabKey, true);
  }, 0);
  tabMenu.querySelector('[aria-checked="true"]')?.focus();
}
function bindTabs() {
  const rail = document.getElementById('rail');
  if (!rail || rail.dataset.bound) return;
  rail.dataset.bound = '1';
  // A tab showing its icon alone still names its page on hover and to a screen reader.
  rail.querySelectorAll('a[data-view]').forEach(a => {
    const name = a.textContent.trim();
    if (!a.title) a.title = name;
    a.setAttribute('aria-label', name);
  });
  rail.addEventListener('contextmenu', e => { e.preventDefault(); openTabMenu(e.clientX, e.clientY); });
  // Tabs wider than the window scroll sideways; the mouse wheel scrolls them too.
  rail.addEventListener('wheel', e => {
    if (rail.scrollWidth <= rail.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    rail.scrollLeft += e.deltaY;
    e.preventDefault();
  }, { passive: false });
  // A tab cut off at either end fades there, so it is plain that more tabs are out of sight.
  const edges = () => {
    rail.classList.toggle('more-left', rail.scrollLeft > 1);
    rail.classList.toggle('more-right', rail.scrollLeft + rail.clientWidth < rail.scrollWidth - 1);
  };
  rail.addEventListener('scroll', edges, { passive: true });
  if (typeof ResizeObserver === 'function') new ResizeObserver(edges).observe(rail);
  edges();
  applyTabLabels();
}

// ---------- the Tiksi menu ----------
function outside(e) { if (menuEl && !menuEl.contains(e.target) && !button.contains(e.target)) close(); }
function onKey(e) { if (e.key === 'Escape' && menuEl) { close(); button.focus(); } }
function renderMenu() {
  const top = document.getElementById('tk-top');
  menuEl.innerHTML = `<section class="tk-group tk-top-host"></section>
    <section class="tk-group"><header><span>SCREEN</span></header>
      <label class="tk-item tk-check"><span>Left pane</span><input type="checkbox" data-side ${onScreen('app.side', true) ? 'checked' : ''}></label>
      <button type="button" class="tk-item" data-tab-toggle><span>Page tabs: ${tabLabels() === 'icons' ? 'show icon and word' : 'show icon only'}</span></button>
      <button type="button" class="tk-item" data-field-layout="phone" data-close-menu><span>Phone layout (field view)</span></button>
    </section>
    <p class="tk-foot"><button class="link-btn" data-screen-reset>Back to the default screen</button> · <a href="https://github.com/MattaDurham/tiksi" target="_blank" rel="noopener" data-close-menu>GitHub</a></p>`
    + (restartAction ? '<div class="tk-group tk-last"><button class="tk-item" role="menuitem" data-restart title="Save, then start the Mac\'s Tiksi server again with its newest code; this page reloads when it is back"><span>RESTART TIKSI</span></button></div>' : '');
  if (top) menuEl.querySelector('.tk-top-host').append(top);
  menuEl.querySelector('[data-screen-reset]').onclick = () => { resetScreen(); renderMenu(); };
  menuEl.querySelector('[data-side]').onchange = e => setOnScreen('app.side', e.target.checked);
  const restart = menuEl.querySelector('[data-restart]');
  if (restart) restart.onclick = () => { close(); restartAction(); };
  menuEl.querySelector('[data-tab-toggle]').onclick = () => { setTabLabels(tabLabels() === 'icons' ? 'words' : 'icons'); renderMenu(); };
}
function park() {
  const top = document.getElementById('tk-top'), hold = document.getElementById('tk-hold');
  if (top && hold && top.parentElement !== hold) hold.append(top);
}
export function openMenu() {
  if (menuEl) return;
  closeTabMenu();
  menuEl = document.createElement('div');
  menuEl.className = 'tk-menu';
  menuEl.setAttribute('role', 'menu');
  menuEl.setAttribute('aria-label', 'Tiksi menu');
  document.body.appendChild(menuEl);
  const r = button.getBoundingClientRect();
  menuEl.style.left = Math.max(8, r.left) + 'px';
  menuEl.style.top = (r.bottom + 6) + 'px';
  renderMenu();
  // A choice made in the menu closes it: FILE, GUIDE, another project. UNDO and REDO keep it
  // open, so a run of steps back stays one click each.
  menuEl.addEventListener('click', e => {
    const t = e.target.closest('button, a');
    if (!t || !menuEl.contains(t)) return;
    if (t.matches('#btn-undo, #btn-redo, [data-tab-toggle], [data-screen-reset]')) return;
    if (t.closest('#tk-top') || t.hasAttribute('data-close-menu')) setTimeout(close, 0);
  });
  menuEl.addEventListener('change', e => { if (e.target.id === 'property-select') setTimeout(close, 0); });
  button.setAttribute('aria-expanded', 'true');
  setTimeout(() => document.addEventListener('pointerdown', outside), 0);
  document.addEventListener('keydown', onKey);
}
export function close() {
  if (!menuEl) return;
  // Keys go back to the page (Cmd+Z, the tools' letters), not to a control put away.
  if (menuEl.contains(document.activeElement)) document.activeElement.blur();
  park();
  menuEl.remove(); menuEl = null;
  button.setAttribute('aria-expanded', 'false');
  document.removeEventListener('pointerdown', outside);
  document.removeEventListener('keydown', onKey);
}
export function isMenuOpen() { return !!menuEl; }

// The top bar's logo becomes the menu button; the page tabs and the left pane start listening.
export function initTiksiMenu() {
  const brand = document.querySelector('#topbar .brand');
  if (!brand || button) return;
  button = document.createElement('button');
  button.type = 'button';
  button.className = 'brand tk-button';
  button.id = 'tiksi-menu';
  button.title = 'Tiksi menu: the project, FILE, GUIDE, undo and redo, and what stays on the screen';
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  button.innerHTML = brand.innerHTML + `<span class="tk-caret">${icon('chevron-down')}</span>`;
  brand.replaceWith(button);
  button.onclick = () => (menuEl ? close() : openMenu());
  window.addEventListener('hashchange', () => { close(); closeTabMenu(); });
  bindTabs();
  bindPane();
  refreshPane();
}
