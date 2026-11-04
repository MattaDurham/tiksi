// Phone layout: the model fills the screen and everything else lives in one side panel.
// Made for the field and for showing clients: no toolbars, no inspector, big touch targets.
// It switches on by itself on phone-sized screens; FIELD VIEW (rail foot) and DESKTOP
// LAYOUT (the panel) override that in this browser.

import { escapeHtml } from './store.js';
import { fieldState, fieldAction, fieldWalk } from './viewer3d.js';

const PREF = 'tiksi.layout';          // 'phone' | 'desktop' | absent (follow the screen)
const SMALL = '(max-width: 760px), (max-height: 500px) and (pointer: coarse)';
const MENU_SVG = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>';
const CLOSE_SVG = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
const FRAME_SVG = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>';
const ARROW = d => `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
const ARROWS = { forward: 'm6 15 6-6 6 6', back: 'm6 9 6 6 6-6', left: 'm15 6-6 6 6 6', right: 'm9 6 6 6-6 6' };
const ARROW_LABELS = { forward: 'Walk forward', back: 'Walk back', left: 'Step left', right: 'Step right' };

let media = null, viewName = '', els = null, open = false;

function preference() { try { return localStorage.getItem(PREF) || ''; } catch (e) { return ''; } }
function setPreference(v) { try { if (v) localStorage.setItem(PREF, v); else localStorage.removeItem(PREF); } catch (e) { /* this browser only */ } }

// Phone layout when forced on, or on a small screen unless forced off.
export function phoneLayout() {
  const pref = preference();
  if (pref === 'phone') return true;
  if (pref === 'desktop') return false;
  return !!(media && media.matches);
}

export function initField() {
  media = window.matchMedia(SMALL);
  media.addEventListener('change', apply);
  build();
  apply();
  document.addEventListener('click', e => {
    const t = e.target.closest('[data-field-layout]');
    if (!t) return;
    // FIELD VIEW is a link to the model, so the switch also lands there.
    setLayout(t.dataset.fieldLayout);
  });
}

// Called by the router after each view mounts.
export function fieldRouted(name) {
  // A background sync rebuilds the same view; only a new page closes the panel.
  const samePage = name === viewName;
  viewName = name;
  const title = document.querySelector(`#rail a[data-view="${name}"]`);
  els.title.textContent = name === 'guide' ? 'Guide' : pageLabel(title ? title.textContent : name);
  document.documentElement.classList.toggle('fd-model', name === 'model');
  if (samePage) render(); else close();
  refreshChrome();
}

function setLayout(which) {
  // Choosing what the screen would pick anyway clears the override.
  const auto = !!(media && media.matches);
  setPreference((which === 'phone') === auto ? '' : which);
  apply();
  close();
}

function apply() {
  const on = phoneLayout();
  const root = document.documentElement;
  if (root.classList.contains('phone') !== on) root.classList.toggle('phone', on);
  // UNDO and REDO move into the slim bar on a phone (editing pages show them there) and back
  // beside the save status on the desktop. The buttons keep their ids and handlers.
  const history = document.getElementById('edit-history');
  if (history && els) {
    if (on && history.parentElement !== els.bar) els.bar.append(history);
    else if (!on && history.parentElement === els.bar) document.getElementById('save-status')?.before(history);
  }
  refreshChrome();
}

function pageLabel(text) {
  const t = String(text || '').trim().toLowerCase();
  return (t.charAt(0).toUpperCase() + t.slice(1)).replace(/\b3d\b/, '3D');
}

function build() {
  const host = document.getElementById('app');
  const bar = document.createElement('div');
  bar.className = 'fd-bar';
  bar.innerHTML = `<button type="button" class="fd-btn fd-menu" aria-label="Open the view panel" aria-expanded="false" aria-controls="fd-panel">${MENU_SVG}</button><span class="fd-title"></span>`;
  const frame = document.createElement('button');
  frame.type = 'button';
  frame.className = 'fd-btn fd-frame';
  frame.setAttribute('aria-label', 'Show the whole model');
  frame.innerHTML = FRAME_SVG;
  const pad = document.createElement('div');
  pad.className = 'fd-walk';
  pad.hidden = true;
  pad.setAttribute('role', 'group');
  pad.setAttribute('aria-label', 'Walk');
  pad.innerHTML = Object.keys(ARROWS).map(d => `<button type="button" class="fd-btn" data-walk="${d}" aria-label="${ARROW_LABELS[d]}">${ARROW(ARROWS[d])}</button>`).join('');
  const scrim = document.createElement('div');
  scrim.className = 'fd-scrim';
  const panel = document.createElement('aside');
  panel.className = 'fd-panel';
  panel.id = 'fd-panel';
  panel.setAttribute('aria-label', 'View panel');
  panel.setAttribute('aria-hidden', 'true');
  panel.inert = true;
  host.append(bar, frame, pad, scrim, panel);
  els = { bar, menu: bar.querySelector('.fd-menu'), title: bar.querySelector('.fd-title'), frame, pad, scrim, panel };

  els.menu.onclick = () => (open ? close() : show());
  scrim.onclick = close;
  frame.onclick = () => { fieldAction('camera', 'frame'); refreshChrome(); };
  document.addEventListener('keydown', e => { if (open && e.key === 'Escape') close(); });
  // Hold to move. Pointer capture keeps the button pressed while a thumb slides off it.
  for (const b of pad.querySelectorAll('[data-walk]')) {
    const dir = b.dataset.walk;
    const stop = () => { b.classList.remove('down'); fieldWalk(dir, false); };
    b.addEventListener('pointerdown', e => { e.preventDefault(); try { b.setPointerCapture(e.pointerId); } catch (err) { /* still works */ } b.classList.add('down'); fieldWalk(dir, true); });
    b.addEventListener('pointerup', stop);
    b.addEventListener('pointercancel', stop);
    b.addEventListener('lostpointercapture', stop);
    b.addEventListener('contextmenu', e => e.preventDefault());
  }
  panel.addEventListener('click', onPanelClick);
  panel.addEventListener('input', e => {
    const r = e.target.closest('[data-section-height]');
    if (!r) return;
    fieldAction('section-height', null, r.value);
    const st = fieldState();
    const out = panel.querySelector('.fd-range output');
    if (out && st && st.section) out.textContent = st.section.label;
  });
  panel.addEventListener('change', e => {
    if (e.target.id !== 'fd-property') return;
    // The topbar's selector owns switching properties; drive it so both stay in step.
    const sel = document.getElementById('property-select');
    if (!sel) return;
    sel.value = e.target.value;
    sel.dispatchEvent(new Event('change'));
    render();
  });
}

function show() {
  open = true;
  render();
  document.documentElement.classList.add('fd-open');
  els.panel.setAttribute('aria-hidden', 'false');
  els.panel.inert = false;
  els.menu.setAttribute('aria-expanded', 'true');
  els.menu.setAttribute('aria-label', 'Close the view panel');
}
function close() {
  if (!els) return;
  const had = open;
  open = false;
  document.documentElement.classList.remove('fd-open');
  els.panel.setAttribute('aria-hidden', 'true');
  els.panel.inert = true;
  els.menu.setAttribute('aria-expanded', 'false');
  els.menu.setAttribute('aria-label', 'Open the view panel');
  if (had && els.panel.contains(document.activeElement)) els.menu.focus();
}

// The overview button and walk pad follow the view's mode.
function refreshChrome() {
  if (!els) return;
  const st = phoneLayout() && viewName === 'model' ? fieldState() : null;
  els.frame.hidden = !st;
  els.pad.hidden = !st || st.mode !== 'walk';
}

function onPanelClick(e) {
  const t = e.target.closest('button, a');
  if (!t || !els.panel.contains(t)) return;
  if (t.matches('.fd-close')) { close(); return; }
  if (t.dataset.file != null) { close(); document.getElementById('btn-file')?.click(); return; }
  if (t.dataset.page) { close(); return; }      // an ordinary link; the router does the rest
  const act = t.dataset.act;
  if (!act) return;
  fieldAction(act, t.dataset.id);
  // Moving the camera closes the panel so the view can be seen; switches stay open for more.
  if (act === 'mode' || act === 'camera' || act === 'position') close();
  else render();
  refreshChrome();
}

function render() {
  if (!els || !open) return;
  const st = viewName === 'model' ? fieldState() : null;
  const sel = document.getElementById('property-select');
  const props = sel ? Array.from(sel.options).filter(o => o.value) : [];
  const section = (title, body) => body ? `<section class="fd-section"><h2>${title}</h2>${body}</section>` : '';
  const sw = (act, it) => `<button type="button" class="fd-switch" role="switch" aria-checked="${!!it.on}" data-act="${act}" data-id="${escapeHtml(it.id)}" ${it.disabled ? 'disabled' : ''}>
      <span>${escapeHtml(it.label)}</span>${it.count != null ? `<small>${it.count}</small>` : ''}<i aria-hidden="true"></i></button>`;
  let model = '';
  if (st) {
    const modes = [['orbit', 'Orbit'], ['walk', 'Walk'], ['top', 'Top']]
      .map(([id, label]) => `<button type="button" class="fd-seg ${st.mode === id ? 'on' : ''}" aria-pressed="${st.mode === id}" data-act="mode" data-id="${id}">${label}</button>`).join('');
    const cams = st.cameras.map(c => `<button type="button" class="fd-chip" data-act="camera" data-id="${c.id}">${escapeHtml(c.label)}</button>`).join('');
    const spots = st.positions.map(p => `<button type="button" class="fd-chip" data-act="position" data-id="${escapeHtml(p.id)}">${escapeHtml(p.label)}</button>`).join('');
    const range = st.section ? `<label class="fd-range"><span>Cut height</span><output>${escapeHtml(st.section.label)}</output>
        <input type="range" data-section-height min="${st.section.min.toFixed(2)}" max="${st.section.max.toFixed(2)}" step="0.05" value="${st.section.value}" aria-label="Section cut height"></label>` : '';
    // Only switches that do something here: no scan, no furniture, no photos pinned, no notes.
    const show = st.show.filter(s => !s.disabled && s.count !== 0);
    model = section('View', `<div class="fd-segs" role="group" aria-label="How to move">${modes}</div><div class="fd-chips">${cams}</div>`)
      + section('Positions', spots && `<div class="fd-chips">${spots}</div>`)
      + section('Show', show.map(s => sw('show', s) + (s.id === 'section' ? range : '')).join(''))
      + section('Tags', st.tags.map(t => sw('tag', t)).join(''))
      + section('Levels', st.levels.length > 1 && st.levels.map(l => sw('level', l)).join(''));
  }
  const pages = Array.from(document.querySelectorAll('#rail a[data-view]'))
    .map(a => `<a class="fd-link ${a.dataset.view === viewName ? 'on' : ''}" data-page href="${escapeHtml(a.getAttribute('href'))}" ${a.dataset.view === viewName ? 'aria-current="page"' : ''}>${escapeHtml(pageLabel(a.textContent))}</a>`).join('');
  const propPicker = props.length > 1
    ? `<select id="fd-property" aria-label="Property">${props.map(o => `<option value="${escapeHtml(o.value)}" ${o.selected ? 'selected' : ''}>${escapeHtml(o.textContent)}</option>`).join('')}</select>`
    : `<div class="fd-prop-name">${escapeHtml(props[0] ? props[0].textContent : 'No property')}</div>`;
  els.panel.innerHTML = `
    <header class="fd-head">${propPicker}<button type="button" class="fd-btn fd-close" aria-label="Close the view panel">${CLOSE_SVG}</button></header>
    <div class="fd-body">
      ${model}
      ${section('Pages', `<nav class="fd-links" aria-label="Pages">${pages}<button type="button" class="fd-link" data-file>File</button></nav>`)}
      <button type="button" class="fd-desktop" data-field-layout="desktop">Desktop layout</button>
    </div>`;
}
