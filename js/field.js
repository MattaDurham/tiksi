// Phone layout: the model fills the screen and everything else lives in one side panel.
// Made for the field and for showing clients: no toolbars, no inspector, big touch targets.
// It switches on by itself on phone-sized screens; FIELD VIEW (rail foot), PHONE LAYOUT (the
// top bar, whenever the desktop layout was chosen on a small or touch screen) and DESKTOP
// LAYOUT (the panel) override that in this browser.
//
// Two separate questions, two separate tests:
//   - which layout: the phone layout on a small screen (SMALL in js/screen.js; the page rules
//     for small screens use the same query, and a test keeps them equal), unless chosen;
//   - finger or mouse: touchDevice() from render-quality.js, marked as html.touch. Only that
//     makes controls finger-sized, so a narrow Mac window keeps its mouse sizes.

import { escapeHtml, activeProperty } from './store.js';
import { fieldState, fieldAction, fieldWalk } from './viewer3d.js';
import { touchDevice } from './render-quality.js';
import { addPhotoFromFile } from './photos-store.js';
import { SMALL } from './screen.js';
import { raiseSmallText } from './touch-text.js';

const PREF = 'tiksi.layout';          // 'phone' | 'desktop' | absent (follow the screen)
const MENU_SVG = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>';
const CLOSE_SVG = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
const FRAME_SVG = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>';
const ARROW = d => `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
const ARROWS = { forward: 'm6 15 6-6 6 6', back: 'm6 9 6 6 6-6', left: 'm15 6-6 6 6 6', right: 'm9 6 6 6-6 6' };
const ARROW_LABELS = { forward: 'Walk forward', back: 'Walk back', left: 'Step left', right: 'Step right' };

// What the bar says for each state of the save status line (js/disk-workspace.js marks it).
// One or two short words, so the state is never cut off on a phone; the tap gives the rest.
// "Keep open" is for originals that are in this open page and nowhere else yet.
const SAVE_LABELS = { saved: 'Saved', sending: 'Sending', waiting: 'Waiting', refused: 'Not saved', open: 'Keep open' };

let media = null, viewName = '', els = null, open = false, noteTimer = null;
let pendingTool = '', taskTimer = 0, captureNote = '';

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
  // A finger, not a mouse: controls grow to finger size (css/field.css, css/console.css).
  // On a touch device the pages' small text is raised to 12 points (js/touch-text.js), once.
  const markTouch = () => { const on = touchDevice(); document.documentElement.classList.toggle('touch', on); if (on) raiseSmallText(); };
  markTouch();
  try { window.matchMedia('(hover: none) and (pointer: coarse)').addEventListener('change', markTouch); } catch (e) { /* older browser: decided once */ }
  build();
  apply();
  document.addEventListener('click', e => {
    const t = e.target.closest('[data-field-layout]');
    if (!t) return;
    // FIELD VIEW is a link to the model, so the switch also lands there; PHONE LAYOUT does the same.
    setLayout(t.dataset.fieldLayout);
    if (t.dataset.fieldLayout === 'phone' && t.tagName === 'BUTTON') location.hash = '#/model';
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
  // Which page is showing, for rules that leave PLAN and MODEL to their own styles.
  document.documentElement.dataset.view = name;
  if (samePage) render(); else close();
  // A note started from another page: MODEL is up now, so its note tool can take the tap.
  if (name === 'model' && pendingTool) { const t = pendingTool; pendingTool = ''; setTimeout(() => { fieldAction('tool', t); refreshChrome(); }, 0); }
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
  // The desktop layout chosen on a phone keeps a way back on screen: the top bar shows it.
  if (els) els.back.hidden = on || !(media && media.matches || touchDevice());
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
  bar.innerHTML = `<button type="button" class="fd-btn fd-menu" aria-label="Open the view panel" aria-expanded="false" aria-controls="fd-panel">${MENU_SVG}</button><span class="fd-title"></span>
    <button type="button" class="fd-save" data-state="saved" aria-controls="fd-save-note" aria-expanded="false"><i aria-hidden="true"></i><span>${SAVE_LABELS.saved}</span></button>`;
  // The full wording of the save state, shown under the bar when the state is tapped.
  const note = document.createElement('div');
  note.className = 'fd-save-note';
  note.id = 'fd-save-note';
  note.setAttribute('role', 'status');
  note.hidden = true;
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
  // While a capture waits for a tap on the model: what to tap, and DONE to stop.
  const task = document.createElement('div');
  task.className = 'fd-task';
  task.setAttribute('role', 'status');
  task.hidden = true;
  task.innerHTML = '<span></span><button type="button" class="fd-task-clear" hidden style="flex:none;min-width:64px;min-height:44px;border-radius:10px;border:1px solid var(--line-2);background:transparent;color:var(--ink);font-size:15px;touch-action:manipulation">Clear</button><button type="button" class="fd-task-done">Done</button>';
  // The camera for the panel's TAKE A PHOTO: one photo per tap, added to this property.
  const camera = document.createElement('input');
  camera.type = 'file'; camera.accept = 'image/*'; camera.setAttribute('capture', 'environment');
  camera.className = 'hidden-file'; camera.dataset.fieldCamera = ''; camera.hidden = true;
  host.append(bar, note, frame, pad, task, scrim, panel, camera);
  // The way back from the desktop layout, in the top bar where that layout always shows it.
  const back = document.createElement('button');
  back.type = 'button'; back.className = 'tb-btn fd-return'; back.dataset.fieldLayout = 'phone'; back.hidden = true;
  back.textContent = 'PHONE LAYOUT';
  back.title = 'Back to the phone layout: the model full screen, with one side panel';
  document.querySelector('#topbar .topbar-group:last-child')?.prepend(back);
  els = { bar, menu: bar.querySelector('.fd-menu'), title: bar.querySelector('.fd-title'), save: bar.querySelector('.fd-save'), note, frame, pad, task, scrim, panel, camera, back };
  watchSave();
  task.querySelector('.fd-task-done').onclick = () => { fieldAction('tool', 'select'); refreshChrome(); };
  task.querySelector('.fd-task-clear').onclick = () => { fieldAction('clear-measures'); refreshChrome(); };
  camera.onchange = () => { const f = camera.files && camera.files[0]; camera.value = ''; if (f) addCapturedPhoto(f); };

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

// The save status line sits in the topbar, which a phone does not show. The bar repeats it:
// saved, sending, waiting for the Mac, or not saved. A tap gives the status line's own words.
function watchSave() {
  const line = document.getElementById('save-status');
  if (!line) { els.save.hidden = true; return; }
  const words = () => line.title || line.textContent.trim();
  const update = () => {
    const text = line.textContent.trim();
    // Other parts of the app write the line without marking it: go by what it shows.
    const state = line.dataset.saveState || (/FAILED|NOT SAVED/.test(text) ? 'refused' : line.classList.contains('busy') ? 'sending' : 'saved');
    els.save.dataset.state = state;
    const keepOpen = !!line.dataset.keepOpen && (state === 'sending' || state === 'waiting');
    els.save.querySelector('span').textContent = keepOpen ? SAVE_LABELS.open : SAVE_LABELS[state] || SAVE_LABELS.sending;
    els.save.setAttribute('aria-label', 'Save state: ' + text);
    if (!els.note.hidden) els.note.textContent = words();
  };
  const hide = () => { clearTimeout(noteTimer); els.note.hidden = true; els.save.setAttribute('aria-expanded', 'false'); };
  els.save.onclick = () => {
    if (!els.note.hidden) { hide(); return; }
    els.note.textContent = words();
    els.note.hidden = false;
    els.save.setAttribute('aria-expanded', 'true');
    clearTimeout(noteTimer); noteTimer = setTimeout(hide, 8000);
  };
  document.addEventListener('pointerdown', e => { if (!els.note.hidden && !els.save.contains(e.target) && !els.note.contains(e.target)) hide(); });
  new MutationObserver(update).observe(line, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['class', 'data-save-state', 'data-keep-open', 'title'] });
  update();
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

// The overview button and walk pad follow the view's mode; the banner follows the tool.
function refreshChrome() {
  if (!els) return;
  const st = phoneLayout() && viewName === 'model' ? fieldState() : null;
  els.frame.hidden = !st;
  els.pad.hidden = !st || st.mode !== 'walk';
  // MODEL says what a tap does while a tool or PHOTO MODE is on (measuring, noting, placing a
  // photo), and whether there are measurements to clear.
  const task = st && st.task;
  els.task.hidden = !task;
  if (task) els.task.querySelector('span').textContent = task.text;
  els.task.querySelector('.fd-task-clear').hidden = !(task && task.clear);
  // MODEL ends the tool itself once the tap lands (or chains to the next photo): look again
  // shortly while a banner is up, and stop looking once it is gone.
  clearTimeout(taskTimer);
  if (task) taskTimer = setTimeout(refreshChrome, 400);
}

// TAKE A PHOTO: the photo joins this property's PHOTOS, then MODEL asks where it was taken
// (the PIN PHOTO path PHOTOS > PIN IN 3D uses). Without a model to tap, it stays in PHOTOS.
async function addCapturedPhoto(file) {
  const prop = activeProperty();
  if (!prop) return;
  try {
    const rec = await addPhotoFromFile(prop, file);
    const canPin = (prop.walls || []).length || (prop.scans || []).length;
    captureNote = canPin ? '' : 'Photo added to PHOTOS.';
    // one=1: MODEL places this photo and stops, never moving on to an older unpinned one.
    location.hash = canPin ? '#/model?pin=' + encodeURIComponent(rec.id) + '&one=1' : '#/photos?select=' + encodeURIComponent(rec.id);
  } catch (e) {
    captureNote = 'The photo could not be added: ' + (e.message || e);
    show();
  }
}

function startNote() {
  close();
  if (viewName === 'model') { fieldAction('tool', 'note'); refreshChrome(); return; }
  pendingTool = 'note';
  location.hash = '#/model';
}

function onPanelClick(e) {
  const t = e.target.closest('button, a');
  if (!t || !els.panel.contains(t)) return;
  if (t.matches('.fd-close')) { close(); return; }
  if (t.dataset.capture === 'photo') { close(); els.camera.click(); return; }
  if (t.dataset.capture === 'note') { startNote(); return; }
  if (t.dataset.file != null) { close(); document.getElementById('btn-file')?.click(); return; }
  if (t.dataset.page) { close(); return; }      // an ordinary link; the router does the rest
  const act = t.dataset.act;
  if (!act) return;
  // Renaming asks for the name; deleting asks first.
  let value;
  if (act === 'view-rename') { value = prompt('Name of this view', t.dataset.label || ''); if (!value || !value.trim()) return; }
  if (act === 'view-delete' && !confirm('Delete the saved view "' + (t.dataset.label || '') + '"?')) return;
  fieldAction(act, t.dataset.id, value);
  // Moving the camera, or starting a tool that waits for taps on the model, closes the panel
  // so the view can be seen; switches stay open for more.
  if (act === 'mode' || act === 'camera' || act === 'position' || act === 'view' || act === 'tool' || act === 'compare' || act === 'load-scan') close();
  else render();
  refreshChrome();
}

function render() {
  if (!els || !open) return;
  // Flipping a switch redraws the panel: keep it scrolled where the finger was.
  const body = els.panel.querySelector('.fd-body'), scrolled = body ? body.scrollTop : 0;
  const st = viewName === 'model' ? fieldState() : null;
  const sel = document.getElementById('property-select');
  const props = sel ? Array.from(sel.options).filter(o => o.value) : [];
  const section = (title, body) => body ? `<section class="fd-section"><h2>${title}</h2>${body}</section>` : '';
  const sw = (act, it) => `<button type="button" class="fd-switch" role="switch" aria-checked="${!!it.on}" data-act="${act}" data-id="${escapeHtml(it.id)}" ${it.disabled ? 'disabled' : ''}>
      ${it.color ? `<b class="fd-dot" style="background:${escapeHtml(it.color)}"></b>` : ''}<span>${escapeHtml(it.label)}</span>${it.count != null ? `<small>${it.count}</small>` : ''}<i aria-hidden="true"></i></button>`;
  let model = '';
  if (st) {
    const modes = [['orbit', 'Orbit'], ['walk', 'Walk'], ['top', 'Top']]
      .map(([id, label]) => `<button type="button" class="fd-seg ${st.mode === id ? 'on' : ''}" aria-pressed="${st.mode === id}" data-act="mode" data-id="${id}">${label}</button>`).join('');
    const cams = st.cameras.map(c => `<button type="button" class="fd-chip" data-act="camera" data-id="${c.id}">${escapeHtml(c.label)}</button>`).join('');
    const saved = st.views.map(v => `<button type="button" class="fd-chip ${v.on ? 'on' : ''}" data-act="view" data-id="${escapeHtml(v.id)}">${escapeHtml(v.label)}</button>`).join('')
      + '<button type="button" class="fd-chip fd-add" data-act="save-view">+ Save this view</button>';
    const spots = st.positions.map(p => `<button type="button" class="fd-chip" data-act="position" data-id="${escapeHtml(p.id)}">${escapeHtml(p.label)}</button>`).join('');
    // The cut slides up and down, side to side or front to back, or stands facing you (custom).
    const range = st.section ? `<div class="fd-chips fd-cut-kinds" role="group" aria-label="Which way the cut slides">${st.section.kinds.map(k => `<button type="button" class="fd-chip ${k.on ? 'on' : ''}" aria-pressed="${k.on}" data-act="section-kind" data-id="${k.id}">${escapeHtml(k.label)}</button>`).join('')}</div>
      <label class="fd-range"><span>Cut position</span><output>${escapeHtml(st.section.label)}</output>
        <input type="range" data-section-height min="${st.section.min}" max="${st.section.max}" step="${st.section.step}" value="${st.section.value}" aria-label="Section cut position"></label>` : '';
    // Only switches that do something here: no scan, no furniture, no photos pinned, no notes.
    const show = st.show.filter(s => !s.disabled && s.count !== 0);
    // Marking up: Measure by two taps (a note is under Capture). The banner over the model then
    // says what a tap does, with DONE and CLEAR.
    const measure = st.tools.filter(t => t.id === 'measure' || t.id === 'markup').map(t => `<button type="button" class="fd-chip ${t.on ? 'on' : ''}" aria-pressed="${t.on}" data-act="tool" data-id="${t.id}">${escapeHtml(t.label)}</button>`).join('')
      + (st.measures ? `<button type="button" class="fd-chip" data-act="clear-measures">Clear ${st.measures === 1 ? 'the measurement' : st.measures + ' measurements'}</button>` : '');
    // The saved view that is open can be renamed, set to what the view shows now, or deleted.
    const openView = st.views.find(v => v.on);
    const editView = openView ? `<div class="fd-chips" role="group" aria-label="The open saved view">${[['view-rename', 'Rename'], ['view-update', 'Update to this view'], ['view-delete', 'Delete']]
      .map(([act, label]) => `<button type="button" class="fd-chip" data-act="${act}" data-id="${escapeHtml(openView.id)}" data-label="${escapeHtml(openView.label)}">${label}</button>`).join('')}</div>` : '';
    const compare = st.compare.length ? `<div class="fd-segs" role="group" aria-label="Before or after">${st.compare.map(c =>
      `<button type="button" class="fd-seg ${c.on ? 'on' : ''}" aria-pressed="${c.on}" data-act="compare" data-id="${c.id}">${escapeHtml(c.label)}</button>`).join('')}</div>` : '';
    // Scans this device did not load because of their size: what and why, and a way to load one anyway.
    const tooLarge = st.tooLarge.map(s => `<div class="fd-too-large" style="margin:0 0 12px"><div style="font-size:14.5px;color:var(--ink)">${escapeHtml(s.label)}</div>
        <div style="font-size:13px;line-height:1.4;color:var(--dim);margin:2px 0 8px">Not loaded: ${escapeHtml(s.detail)}. Loading it could close this page.</div>
        <button type="button" class="fd-chip" data-act="load-scan" data-id="${escapeHtml(s.id)}">Load anyway</button></div>`).join('');
    // The lens: iPhone 17 Pro 0.5x, 1x and 2x, so the view frames the model as its pictures do.
    const lenses = (st.lenses || []).map(l => `<button type="button" class="fd-seg ${l.on ? 'on' : ''}" aria-pressed="${l.on}" data-act="lens" data-id="${escapeHtml(l.id)}">${escapeHtml(l.label)}</button>`).join('');
    model = section('View', `<div class="fd-segs" role="group" aria-label="How to move">${modes}</div><div class="fd-chips">${cams}</div>${lenses ? `<div class="fd-segs" role="group" aria-label="Lens" style="margin-top:8px">${lenses}</div>` : ''}`)
      + section('Measure', `<div class="fd-chips">${measure}</div>`)
      + section('Before and after', compare)
      + section('Too large for this device', tooLarge)
      + section('Saved views', `<div class="fd-chips">${saved}</div>${editView}`)
      + section('Positions', spots && `<div class="fd-chips">${spots}</div>`)
      + section('Show', show.map(s => sw('show', s) + (s.id === 'section' ? range : '')).join(''))
      + section('Tags', st.tags.map(t => sw('tag', t)).join(''))
      + section('Levels', st.levels.length > 1 && st.levels.map(l => sw('level', l)).join(''))
      // On a touch device the quality is the device's own (render-quality.js); otherwise the property's.
      + section(touchDevice() ? 'Quality on this device' : 'Quality', `<div class="fd-segs fd-quality" role="group" aria-label="Drawing quality">${st.quality.map(q =>
        `<button type="button" class="fd-seg ${q.on ? 'on' : ''}" aria-pressed="${q.on}" data-act="quality" data-id="${escapeHtml(q.id)}">${escapeHtml(q.label)}</button>`).join('')}</div>`);
  }
  // Capture comes first: on site the phone is the camera and the notebook for this property.
  const capture = props.length ? section('Capture', `<div class="fd-capture">
      <button type="button" class="fd-cap" data-capture="photo">Take a photo</button>
      <button type="button" class="fd-cap" data-capture="note">Add a note</button></div>${captureNote ? `<p class="fd-cap-note" role="status">${escapeHtml(captureNote)}</p>` : ''}`) : '';
  captureNote = '';
  const pages = Array.from(document.querySelectorAll('#rail a[data-view]'))
    .map(a => `<a class="fd-link ${a.dataset.view === viewName ? 'on' : ''}" data-page href="${escapeHtml(a.getAttribute('href'))}" ${a.dataset.view === viewName ? 'aria-current="page"' : ''}>${escapeHtml(pageLabel(a.textContent))}</a>`).join('')
    // The GUIDE lives in the top bar, which a phone does not show.
    + `<a class="fd-link ${viewName === 'guide' ? 'on' : ''}" data-page href="#/guide" ${viewName === 'guide' ? 'aria-current="page"' : ''}>Guide</a>`;
  const propPicker = props.length > 1
    ? `<select id="fd-property" aria-label="Property">${props.map(o => `<option value="${escapeHtml(o.value)}" ${o.selected ? 'selected' : ''}>${escapeHtml(o.textContent)}</option>`).join('')}</select>`
    : `<div class="fd-prop-name">${escapeHtml(props[0] ? props[0].textContent : 'No property')}</div>`;
  els.panel.innerHTML = `
    <header class="fd-head">${propPicker}<button type="button" class="fd-btn fd-close" aria-label="Close the view panel">${CLOSE_SVG}</button></header>
    <div class="fd-body">
      ${capture}
      ${model}
      ${section('Pages', `<nav class="fd-links" aria-label="Pages">${pages}<button type="button" class="fd-link" data-file>File</button></nav>`)}
      <button type="button" class="fd-desktop" data-field-layout="desktop">Desktop layout</button>
    </div>`;
  const fresh = els.panel.querySelector('.fd-body');
  if (fresh && scrolled) fresh.scrollTop = scrolled;
}
