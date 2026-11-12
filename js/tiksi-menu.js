// The Tiksi menu: the logo in the top bar opens every command of the current view, so the
// screen can stay clear. Each group can also be put on the screen (ON SCREEN) or taken off it;
// that choice is this browser's (localStorage), the same for every project.
//
// A view registers what it offers with setMenuProvider(() => groups), where a group is
//   { title, screen?: { id, on }, items: [{ label, key?, active?, run, keep? }] }
// `screen` is the on-screen element the group's switch shows or hides. The app adds the
// list of sections (PLAN, MODEL, ...) and its own switch for the section list on the left.

import { icon } from './icons.js';

const KEY = 'tiksi.onScreen.v1';
const listeners = new Set();
let prefs = readPrefs();
let provider = null, menuEl = null, button = null;

function readPrefs() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}
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
  try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* private window: this session only */ }
  for (const fn of listeners) { try { fn(id, !!on); } catch (e) { console.error(e); } }
  applyAppScreen();
}
// Forget every ON SCREEN choice: the screen goes back to how Tiksi starts ({ all: true } puts
// every group on it instead).
export function resetScreen(all = false) {
  prefs = all ? { all: true } : {};
  try { if (all) localStorage.setItem(KEY, JSON.stringify(prefs)); else localStorage.removeItem(KEY); } catch { /* this session only */ }
  for (const fn of listeners) { try { fn('*', null); } catch (e) { console.error(e); } }
  applyAppScreen();
}
export function onScreenChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function setMenuProvider(fn) { provider = fn; if (menuEl) render(); return () => { if (provider === fn) provider = null; }; }

function applyAppScreen() {
  const app = document.getElementById('app');
  if (app) app.classList.toggle('no-rail', !onScreen('app.rail', true));
}

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function appGroup() {
  const links = [...document.querySelectorAll('#rail a[data-view]')];
  const current = (location.hash.match(/^#\/([\w-]+)/) || [])[1] || '';
  return {
    title: 'Go to', screen: { id: 'app.rail', on: onScreen('app.rail', true), label: 'Section list on the left' },
    items: links.map(a => ({ label: a.textContent.trim(), active: a.dataset.view === current, run: () => { location.hash = a.getAttribute('href'); } })),
  };
}

let groups = [];
function render() {
  if (!menuEl) return;
  groups = [...(provider ? provider() : []), appGroup()].filter(g => g && (g.items.length || g.screen));
  menuEl.innerHTML = groups.map((g, gi) => `<section class="tk-group">
      <header><span>${esc(g.title.toUpperCase())}</span>${g.screen ? `<label class="tk-pin" title="${esc(g.screen.label || 'Show this group on the screen')}"><input type="checkbox" data-screen="${esc(g.screen.id)}" ${g.screen.on ? 'checked' : ''}><span>ON SCREEN</span></label>` : ''}</header>
      ${g.items.map((it, ii) => `<button class="tk-item ${it.active ? 'active' : ''}" role="menuitem" data-item="${gi}:${ii}" ${it.disabled ? 'disabled' : ''}><span>${esc(it.label)}</span>${it.key ? `<kbd>${esc(it.key)}</kbd>` : ''}</button>`).join('')}
    </section>`).join('') + '<p class="tk-foot">Turn a group ON SCREEN to keep it beside the view. Keyboard shortcuts work either way. <button class="link-btn" data-screen-reset>Back to the default screen</button></p>';
  menuEl.querySelector('[data-screen-reset]').onclick = () => { resetScreen(); render(); };
  menuEl.querySelectorAll('[data-screen]').forEach(i => i.onchange = () => { setOnScreen(i.dataset.screen, i.checked); render(); });
  menuEl.querySelectorAll('[data-item]').forEach(b => b.onclick = () => {
    const [gi, ii] = b.dataset.item.split(':').map(Number), it = groups[gi] && groups[gi].items[ii];
    if (!it) return;
    if (!it.keep) close();
    it.run();
    if (it.keep) render();
  });
}
function outside(e) { if (menuEl && !menuEl.contains(e.target) && !button.contains(e.target)) close(); }
function onKey(e) { if (e.key === 'Escape' && menuEl) { close(); button.focus(); } }
export function openMenu() {
  if (menuEl) return;
  menuEl = document.createElement('div');
  menuEl.className = 'tk-menu';
  menuEl.setAttribute('role', 'menu');
  menuEl.setAttribute('aria-label', 'Tiksi menu');
  document.body.appendChild(menuEl);
  const r = button.getBoundingClientRect();
  menuEl.style.left = Math.max(8, r.left) + 'px';
  menuEl.style.top = (r.bottom + 6) + 'px';
  render();
  button.setAttribute('aria-expanded', 'true');
  setTimeout(() => document.addEventListener('pointerdown', outside), 0);
  document.addEventListener('keydown', onKey);
}
export function close() {
  if (!menuEl) return;
  menuEl.remove(); menuEl = null;
  button.setAttribute('aria-expanded', 'false');
  document.removeEventListener('pointerdown', outside);
  document.removeEventListener('keydown', onKey);
}
export function isMenuOpen() { return !!menuEl; }

// The top bar's logo becomes the menu button.
export function initTiksiMenu() {
  const brand = document.querySelector('#topbar .brand');
  if (!brand || button) return;
  button = document.createElement('button');
  button.type = 'button';
  button.className = 'brand tk-button';
  button.id = 'tiksi-menu';
  button.title = 'Tiksi menu: every tool and view, and what stays on the screen';
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  button.innerHTML = brand.innerHTML + `<span class="tk-caret">${icon('chevron-down')}</span>`;
  brand.replaceWith(button);
  button.onclick = () => (menuEl ? close() : openMenu());
  window.addEventListener('hashchange', close);
  applyAppScreen();
}
