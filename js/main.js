import { saveOfflineSnapshot, readOfflineSnapshot } from './offline-store.js';
import { showOfflineWorkspace } from './offline-view.js';
// App shell: routing, topbar, property management, persistence wiring.

import {
  ws, load, save, touch, onChange, activeProperty, replaceWorkspace, mergeWorkspace,
  exportBundle, importBundle, listAllFileIds, orphanFiles, deleteFiles, whenHydrated,
  setSaveStatus, fmtBytes, escapeHtml, projectSlice, unreadableWorkspace, setAsideUnreadableWorkspace,
  units, fmtLen, INCH_PRECISIONS, MM_PRECISIONS, inchPrecision, mmPrecision, inchPrecisionLabel, mmPrecisionLabel, precisionLabel,
} from './store.js';
import { openExchangeDialog } from './exchange-dialog.js';
import { SCAN_ACCEPT, importScanFile } from './scans.js';
import { addPhotoFromFile } from './photos-store.js';
import { ensureBuiltinMaterials } from './materials.js';
import { disposeMaterials } from './textures.js';
import { revokePhotoUrls } from './photos-store.js';
import { demoWorkspace } from './demo.js';
import { connectDiskWorkspace, diskWorkspace } from './disk-workspace.js';
import { editHistoryState, onEditHistoryChange } from './edit-history.js';
import { icon } from './icons.js';
import { initPaneResize } from './pane-resize.js';
import { initTiksiMenu, setRestartAction } from './tiksi-menu.js';
import { restartTiksi } from './restart.js';
import { initField, fieldRouted, phoneLayout } from './field.js';
import * as plan2d from './plan2d.js';
import * as viewer3d from './viewer3d.js';
const materialsview = lazyView(() => import('./materialsview.js'));
const photos = lazyView(() => import('./photos.js'));
const measure = lazyView(() => import('./measure.js'));
import { isVideoFile, addVideoFromFile } from './videos.js';
const reconstruction = lazyView(() => import('./reconstruction.js'));
const research = lazyView(() => import('./research.js'));
const projects = lazyView(() => import('./projects.js'));
const products = lazyView(() => import('./products.js'));
const budget = lazyView(() => import('./budget.js'));
const schedule = lazyView(() => import('./schedule.js'));
const cutsheets = lazyView(() => import('./cutsheets.js'));
const documentcenter = lazyView(() => import('./documentcenter.js'));
const guide = lazyView(() => import('./guide.js'));
import { initNewProperty, openNewPropertyDialog, dialogOpen } from './newproperty.js';
import { initOnePager, openOnePagerEditor, promptMode } from './one-pager-dialog.js';
import { draftOnePager, onePagerStatus, PROMPT_MODES } from './one-pager.js';
import { parseCaptureUrl } from './polycam.js';
import {
  initFiles, bindFileIntake, saveProject, openProjectPicker, openFromFile, openFromUrl, linkFolder, unlinkFolder, reconnectFolder,
  linkProjectFolder, unlinkProjectFolder, projectFolder,
  listFolder, openFromFolder, scheduleFolderSync, filesState, onFilesChange, isDirty, saveTarget, FSA, FSA_DIR, mirrorStatus,
  editInSketchUp, NeedsFolder,
} from './files.js';

function lazyView(load) {
  let module, mounted = false, token = 0;
  return {
    mount(root, onError) {
      const own = ++token; root.textContent = 'Opening…';
      load().then(value => { module = value; if (own !== token) return; root.textContent = ''; mounted = true; module.mount(root); })
        .catch(error => { if (own === token) onError(error); });
    },
    unmount() { token++; if (mounted) module?.unmount?.(); mounted = false; },
    undo() { if (mounted) module?.undo?.(); },
    redo() { if (mounted) module?.redo?.(); },
    sharedChange(keys) { return mounted && module?.sharedChange?.(keys); },
  };
}

const VIEWS = {
  plan: plan2d,
  model: viewer3d,
  materials: materialsview,
  photos,
  measure,
  reconstruct: reconstruction,
  research,
  projects,
  products,
  budget,
  schedule,
  sheets: cutsheets,
  documents: documentcenter,
  guide,
};

let currentView = null;
let currentName = '';

async function boot() {
  if ('serviceWorker' in navigator && isSecureContext) navigator.serviceWorker.register('/service-worker.js').then(async registration => {
    await navigator.serviceWorker.ready;
    const urls = performance.getEntriesByType('resource').map(r => r.name);
    (registration.active || navigator.serviceWorker.controller)?.postMessage({ type: 'cache-shell', urls });
  }).catch(e => console.warn('Offline shell unavailable', e));
  const had = load();
  await whenHydrated();
  try { await connectDiskWorkspace({ hadLocal: had, onRemote: sharedChange }); }
  catch (error) {
    try { const cached = await readOfflineSnapshot(); if (cached) ws.data = cached; } catch { /* storage may be unavailable */ }
    if (showOfflineWorkspace(error)) return; error.projectFiles = true; throw error;
  }
  let offlineTimer;
  const keepOffline = () => { clearTimeout(offlineTimer); offlineTimer = setTimeout(() => saveOfflineSnapshot(ws.data).catch(e => console.warn('Offline snapshot unavailable', e)), 350); };
  keepOffline(); onChange(keepOffline);
  // This browser holds the workspace itself, and what it holds could not be read. Nothing is
  // loaded over it and nothing is saved until the person has decided (with the Mac's project
  // files the unreadable text was already preserved there when they were connected).
  if (!diskWorkspace && unreadableWorkspace()) { showUnreadableWorkspace(); return; }
  if (!diskWorkspace) askToKeepStorage();
  if (!diskWorkspace && (!had || ws.data.properties.length === 0 && ws.data.projects.length === 0)) {
    replaceWorkspace(demoWorkspace());
  }
  ensureBuiltinMaterials();
  // Every property has a one-pager: draft the text of any that has none, and keep the text of
  // the ones never edited by hand in step with their project.
  if (ws.data.properties.map(p => draftOnePager(p, ws.data)).some(Boolean)) touch();
  if (diskWorkspace) diskWorkspace.changed();
  save();
  // Photo thumbnails come back from IndexedDB asynchronously; the first render waits for them.
  await whenHydrated();

  bindTopbar();
  initTiksiMenu();
  if (diskWorkspace && diskWorkspace.canRestart()) setRestartAction(() => restartTiksi(diskWorkspace));
  initField();
  initPaneResize(document.getElementById('view'));
  bindHistoryControls();
  refreshTopbar();
  onChange(refreshTopbar);
  // Projects are files: SAVE, the FILE menu, drops, Cmd+S/Cmd+O, and the linked folder.
  initFiles({ remount: remountView, refresh: refreshTopbar, afterReplace: afterWorkspaceReplaced, opened: confirmOpened, confirmReplace });
  bindFileIntake(importAnyFile);
  onChange(() => { scheduleFolderSync(); refreshSaveButton(); });
  onFilesChange(refreshSaveButton);
  reconnectFolder(false).then(refreshSaveButton).catch(() => refreshSaveButton());
  refreshSaveButton();
  initNewProperty({ remount: remountView, refresh: refreshTopbar, toast: showToast });
  initOnePager({ remount: remountView, refresh: refreshTopbar, toast: showToast });
  bindLinkIntake();

  window.addEventListener('hashchange', route);
  route();
}

// A Polycam link can arrive three ways besides the dialog: pasted anywhere in the console,
// dropped on it from another window, or in the address bar (#/import?url=...), which is
// what makes "share the link with tiksi" a single step.
function bindLinkIntake() {
  const editable = t => t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  document.addEventListener('paste', e => {
    if (dialogOpen() || editable(e.target)) return;
    const text = e.clipboardData && e.clipboardData.getData('text/plain');
    if (!parseCaptureUrl(text)) return;
    e.preventDefault();
    openNewPropertyDialog({ url: parseCaptureUrl(text).url });
  });
  const hasUrl = e => e.dataTransfer && Array.from(e.dataTransfer.types || []).some(t => t === 'text/uri-list' || t === 'text/plain') && !Array.from(e.dataTransfer.types || []).includes('Files');
  window.addEventListener('dragover', e => { if (hasUrl(e) && !dialogOpen()) { e.preventDefault(); e.dataTransfer.dropEffect = 'link'; } });
  window.addEventListener('drop', e => {
    if (!hasUrl(e) || dialogOpen()) return;
    const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
    const link = parseCaptureUrl(text);
    if (!link) return;
    e.preventDefault();
    openNewPropertyDialog({ url: link.url });
  });
}

// #/import?url=<share link> (or #/new?url=): consume the query, then start the import.
function importFromHash() {
  // Accepted: #/import?url=<share link>, #/import?polycam=<id>, and the shortest form,
  // #/import/<capture id> (or a full link in that slot).
  const m = /^#\/(?:import|new)(?:\/([^?]+))?(?:\?(.*))?$/.exec(location.hash);
  if (!m) return false;
  const params = new URLSearchParams(m[2] || '');
  let raw = params.get('url') || params.get('polycam') || '';
  if (!raw && m[1]) { const slot = decodeURIComponent(m[1]); raw = /^https?:\/\//i.test(slot) ? slot : 'https://poly.cam/capture/' + slot; }
  else if (raw && !/^https?:\/\//i.test(raw)) raw = 'https://poly.cam/capture/' + raw;
  history.replaceState(null, '', '#/plan');
  const link = parseCaptureUrl(raw);
  if (link) openNewPropertyDialog({ url: link.url, autoStart: true });
  else openNewPropertyDialog({ url: raw });
  return true;
}

// #/open?url=<project file>: open a hosted .tiksi into this workspace, then show it.
function openFromHash() {
  const m = /^#\/open(?:\?(.*))?$/.exec(location.hash);
  if (!m) return false;
  const url = new URLSearchParams(m[1] || '').get('url') || '';
  history.replaceState(null, '', '#/plan');
  if (!url) { openProjectPicker().catch(e => alert(e.message)); return true; }
  openFromUrl(url).then(() => { location.hash = '#/plan'; remountView(); }).catch(e => alert('Open failed: ' + e.message));
  return true;
}

// A view that throws while tearing down must never wedge navigation: log it and move on.
function unmountCurrent() {
  if (!currentView || !currentView.unmount) return;
  try { currentView.unmount(); } catch (e) { console.error('unmount failed', e); }
}

function route() {
  // Views may carry a query (#/model?pin=<photoId>); the view reads it from location.hash itself.
  // Phones open on the model: it is what gets shown on site.
  const name = (location.hash.replace(/^#\//, '').split('?')[0] || (phoneLayout() ? 'model' : 'plan'));
  const head = name.split('/')[0];
  if ((head === 'import' || head === 'new') && importFromHash()) { if (!currentView) route(); return; }
  if (head === 'open' && openFromHash()) { if (!currentView) route(); return; }
  const view = VIEWS[name] || VIEWS.plan;
  unmountCurrent();
  currentName = VIEWS[name] ? name : 'plan';
  currentView = view;
  const guideEntry = document.querySelector('.guide-entry');
  if (currentName === 'guide') guideEntry?.setAttribute('aria-current', 'page');
  else guideEntry?.removeAttribute('aria-current');
  document.querySelectorAll('#rail a[data-view]').forEach(a =>
    a.classList.toggle('active', a.dataset.view === currentName));
  // Page tabs wider than the window scroll; the current one is kept in sight.
  const tab = document.querySelector('#rail a.active'), rail = tab && tab.parentElement;
  if (tab && rail.scrollWidth > rail.clientWidth) {
    const left = tab.offsetLeft - rail.offsetLeft;   // both measured from the top bar
    rail.scrollLeft = Math.max(0, Math.min(rail.scrollLeft, left - 8), left + tab.offsetWidth - rail.clientWidth + 8);
  }
  openPage();
}

function remountView() {
  unmountCurrent();
  openPage();
}

// Open the current page. A page that fails to open says so itself, with a way to try again;
// the rest of the app (the other pages, saving) goes on working.
function openPage() {
  const root = document.getElementById('view');
  root.innerHTML = '';
  const failed = error => {
    console.error(currentName + ' could not open', error);
    unmountCurrent();
    const label = document.querySelector(`#rail a[data-view="${currentName}"]`)?.textContent.trim() || currentName.toUpperCase();
    root.innerHTML = `<div class="view-scroll page-open-failed" role="alert"><div class="kicker">${escapeHtml(label)}</div>
      <p>${escapeHtml(label)} could not open (${escapeHtml(String(error && error.message || error))}). The other pages still work, and nothing saved is affected.</p>
      <p><button class="btn primary" data-reload>RELOAD</button></p></div>`;
    root.querySelector('[data-reload]').onclick = () => location.reload();
  };
  try { currentView.mount(root, failed); }
  catch (error) { failed(error); }
  refreshHistoryControls();
  fieldRouted(currentName);
}

// The workspace this browser stores could not be read (the hosted copy and the copy opened
// as a file keep everything in the browser). The stored text is left as it was found.
function showUnreadableWorkspace() {
  const found = unreadableWorkspace(), host = document.getElementById('view');
  setSaveStatus('STORED WORKSPACE UNREADABLE', true);
  host.innerHTML = `<div class="view-scroll page-open-failed" role="alert"><div class="kicker">WORKSPACE</div>
    <p>The workspace stored in this browser could not be read (${escapeHtml(found.error)}). Nothing has been changed or saved over it.</p>
    <p>Save the stored text as a file first; it can be repaired and opened again. Starting with an empty workspace keeps the stored text in this browser under another name.</p>
    <p><button class="btn primary" data-keep>SAVE THE STORED TEXT AS A FILE</button> <button class="btn" data-start>START WITH AN EMPTY WORKSPACE</button></p><p role="status" data-said></p></div>`;
  host.querySelector('[data-keep]').onclick = () => {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([found.raw], { type: 'application/json' }));
    link.download = 'tiksi-workspace-unreadable.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 60000);
  };
  host.querySelector('[data-start]').onclick = () => {
    if (setAsideUnreadableWorkspace()) location.reload();
    else host.querySelector('[data-said]').textContent = 'The stored text could not be copied aside (this browser\'s storage is full or closed), so it was left where it is. Save it as a file first.';
  };
}

// A browser may clear a site's storage after a week without a visit unless it has agreed to
// keep it. Ask once, and say in FILE, Settings what it answered.
let storageKept = null;
function askToKeepStorage() {
  if (typeof navigator === 'undefined' || !navigator.storage || typeof navigator.storage.persist !== 'function') return;
  navigator.storage.persist().then(kept => { storageKept = !!kept; }, () => {});
}

// Called after the whole workspace was swapped out: drop GPU/material caches and object URLs
// that belong to the old data, then make sure builtin materials exist and redraw.
function afterWorkspaceReplaced() {
  disposeMaterials();
  revokePhotoUrls();
  ensureBuiltinMaterials();
  remountView();

}

// Another device saved, or a SketchUp save or this device's kept copy was merged in. The
// records are already updated in place (store.js keepRecords); `change` says which. The open
// page is touched only as far as the change reaches it:
// - nothing it shows changed (another property, or only what the other device is looking
//   at): it is left exactly as it is;
// - a text field has the cursor, or a dialog is open: the redraw waits until that is over,
//   so nothing being typed is lost;
// - the page can redraw from the changed records (MODEL does, keeping camera, mode and
//   loaded scans): it does that; any other page is rebuilt, MODEL with its camera kept.
let heldChange = null, holdWatch = null;
function sharedChange(change) {
  ensureBuiltinMaterials();
  if (!currentView) return;
  change = change || { all: true, properties: new Set(), keys: new Map() };
  if (heldChange) {
    for (const id of change.properties) heldChange.properties.add(id);
    for (const [id, keys] of change.keys) heldChange.keys.set(id, heldChange.keys.has(id) && heldChange.keys.get(id) && keys ? [...new Set([...heldChange.keys.get(id), ...keys])] : null);
    for (const flag of ['all', 'materials', 'other']) heldChange[flag] = heldChange[flag] || change[flag];
  } else heldChange = { all: !!change.all, materials: !!change.materials, other: !!change.other, properties: new Set(change.properties), keys: new Map(change.keys) };
  // A page that cannot redraw is that page's fault, shown on that page: the change itself is
  // in the records, and saving goes on.
  try { showSharedChange(); } catch (error) { console.error('the page could not show a change from another device', error); }
}
function enteringText() {
  const a = document.activeElement;
  return !!a && (a.isContentEditable || a.matches('textarea, input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=button]):not([type=file]):not([type=color])'));
}
function showSharedChange() {
  if (!heldChange) return;
  refreshTopbar();
  if (enteringText() || document.querySelector('dialog[open]')) {
    // Leaving the field or closing the dialog shows it (`close` does not bubble: capture).
    if (!holdWatch) {
      holdWatch = () => setTimeout(showSharedChange, 0);
      document.addEventListener('focusout', holdWatch); document.addEventListener('close', holdWatch, true);
    }
    return;
  }
  if (holdWatch) { document.removeEventListener('focusout', holdWatch); document.removeEventListener('close', holdWatch, true); holdWatch = null; }
  const change = heldChange; heldChange = null;
  const active = activeProperty();
  const whole = change.all || change.other || change.materials;
  // PROJECTS lists every property; the other pages show the open one.
  const reaches = whole || (active && change.properties.has(active.id)) || (currentName === 'projects' && change.properties.size > 0);
  if (!reaches) return;
  if (change.all || change.materials) disposeMaterials();
  const keys = active && change.keys.get(active.id);
  if (!whole && keys && currentView.sharedChange && currentView.sharedChange(keys)) { refreshHistoryControls(); return; }
  revokePhotoUrls();
  if (currentName === 'model') viewer3d.keepViewOnNextMount();
  remountView();
}

// IMPORT and DEMO leave the previous workspace's scans and photos in IndexedDB on purpose
// (a JSON-only export of it, re-imported on this machine, still finds them), so removing
// them is always the user's call: offered right after a replacement, and any time later
// from EXPORT > CLEAN STORAGE.
async function offerStorageCleanup(afterReplace) {
  let orphans;
  try { orphans = await orphanFiles({ sizes: true }); } catch (e) { console.error(e); return; }
  const n = orphans.ids.length;
  if (!n) { if (!afterReplace) setSaveStatus('STORAGE CLEAN', false); return; }
  const them = n === 1 ? 'it' : 'them';
  const msg = n + ' stored file' + (n === 1 ? '' : 's') + ' (' + fmtBytes(orphans.bytes) + ') ' +
    (afterReplace ? 'belonged to the previous workspace and nothing here references ' + them : (n === 1 ? 'is' : 'are') + ' not referenced by this workspace') + '.\n\n' +
    'Remove ' + them + ' from browser storage? Keep ' + them + ' if you plan to re-import a JSON-only export of the workspace that used ' + them + ' on this machine' +
    (afterReplace ? ' (EXPORT > CLEAN STORAGE can remove ' + them + ' later).' : '.');
  if (!confirm(msg)) return;
  try {
    await deleteFiles(orphans.ids);
    setSaveStatus('FREED ' + fmtBytes(orphans.bytes), false);
  } catch (e) {
    console.error('storage cleanup failed', e);
    alert('Could not remove the files: ' + String(e && e.message || e));
  }
}

// ---------- topbar ----------
function refreshHistoryControls() {
  const group = document.getElementById('edit-history');
  if (!group) return;
  group.hidden = !['plan', 'model', 'measure'].includes(currentName);
  const state = editHistoryState(activeProperty());
  for (const direction of ['undo', 'redo']) {
    const button = document.getElementById('btn-' + direction), item = state[direction];
    button.disabled = !item.available;
    const name = direction === 'undo' ? 'Undo' : 'Redo';
    button.title = item.blocked ? name + ' unavailable: this geometry changed elsewhere.'
      : item.available ? name + ' ' + item.label + (direction === 'undo' ? ' (Cmd/Ctrl+Z)' : ' (Cmd/Ctrl+Shift+Z or Ctrl+Y)')
      : 'Nothing to ' + direction;
  }
}
function bindHistoryControls() {
  for (const direction of ['undo', 'redo']) {
    const button = document.getElementById('btn-' + direction);
    button.innerHTML = icon(direction) + '<span>' + direction.toUpperCase() + '</span>';
    button.onclick = () => { currentView?.[direction]?.(); refreshHistoryControls(); };
  }
  onEditHistoryChange(refreshHistoryControls);
  window.addEventListener('keydown', e => {
    if (!['plan', 'model', 'measure'].includes(currentName) || !(e.ctrlKey || e.metaKey) || e.altKey) return;
    if (e.target?.matches('input, textarea, select') || e.target?.isContentEditable || document.querySelector('dialog[open]')) return;
    const key = e.key.toLowerCase();
    if (key !== 'z' && !(e.ctrlKey && key === 'y')) return;
    e.preventDefault(); e.stopImmediatePropagation();
    currentView?.[key === 'y' || e.shiftKey ? 'redo' : 'undo']?.();
  });
}
function bindTopbar() {
  const sel = document.getElementById('property-select');
  sel.onchange = () => {
    ws.data.settings.activePropertyId = sel.value;
    touch();
    remountView();
  };

  document.addEventListener('tiksi:files',e=>openFileMenu(e.detail?.tab || 'project',e.detail?.selected));
  document.addEventListener('tiksi:edit-in-sketchup',()=>openInSketchUp());
  document.addEventListener('tiksi:one-pager',()=>openOnePagerEditor(activeProperty()));

  const fileBtn = document.getElementById('btn-file');
  fileBtn.onclick = () => openFileMenu();
}

// One home for project files, capture, exchange and settings. Import merges by default.
async function importAnyFile(file) {
  if (/\.(tiksi|json)$/i.test(file.name)) return openFromFile(file);
  if (/\.zip$/i.test(file.name)) {
    // Inspect the archive before routing it; a model ZIP is not a workspace replacement.
    const { unpackModelZip } = await import('./scanbundle.js');
    const archive = unpackModelZip(await file.arrayBuffer());
    if (archive.has('workspace.json')) return openFromFile(file);
  }
  const prop = activeProperty();
  if (!prop) throw new Error('Create a property before importing a capture.');
  if (/\.(jpe?g|png|webp|heic|heif|tiff?|avif)$/i.test(file.name)) {
    await addPhotoFromFile(prop, file); touch(); return 'photo';
  }
  // Walk-through videos are measurement evidence: kept as originals and reviewed in MEASURE.
  if (isVideoFile(file)) { await addVideoFromFile(prop, file); return 'measure'; }
  const scan = await importScanFile(file, prop);
  if (!scan) throw new Error('Choose a supported model or a native source for conversion.');
  viewer3d.focusScanOnMount(scan.id);
  return 'model';
}

function openFileMenu(initialTab = 'project', selected) {
  document.querySelector('[data-file-dialog]')?.close();
  const prop=activeProperty(), dialog=document.createElement('dialog');
  dialog.className='file-dialog';dialog.dataset.fileDialog='';dialog.setAttribute('aria-label','Files and settings');
  dialog.innerHTML=`<header class="file-heading"><div><h2>Files & settings</h2><p>${escapeHtml(prop?.name || 'Workspace')}</p></div><button class="btn" data-close-file aria-label="Close files and settings">CLOSE</button></header>
    <nav class="file-tabs" aria-label="File actions">${[['project','Project'],['capture','Import'],['exchange','3D exchange'],['settings','Settings']].map(([id,label])=>`<button class="btn" data-file-tab="${id}">${label}</button>`).join('')}</nav>
    <section data-file-panel="project"><h3>Save your project</h3><p>A .tiksi file keeps your plan, models, original captures, pinned photos, materials and project work together.</p>
      <div class="file-actions"><button class="btn primary" data-project-save>SAVE PROJECT</button><button class="btn" data-project-as>SAVE AS…</button><button class="btn" data-project-open>OPEN / IMPORT…</button></div><p data-file-target></p>
      <div class="file-actions"><button class="btn" data-new-property>NEW PROPERTY</button><button class="btn" data-new-folder>NEW PROPERTY FROM A FOLDER…</button></div>
      <h3>One-pager</h3><p>A one-page teaser of this property for its client: the picture, the pitch, the scope, the budget and the schedule. Every saved version is a PDF among the property's documents; the newest is the one to send.</p>
      <p class="op-file-status" data-op-file-status></p><div class="file-actions"><button class="btn primary" data-one-pager>OPEN ONE-PAGER</button></div></section>
    <section data-file-panel="capture" hidden><h3>Bring your room into Tiksi</h3><p>Choose photos, a walk-through video, a scan, a 3D model or a saved project. Imported projects add or update properties here.</p><button class="btn primary" data-capture-open>CHOOSE FILES…</button><button class="btn" data-polycam>POLYCAM LINK</button><button class="btn" data-photo3d>PHOTOS → 3D</button></section>
    <section data-file-panel="exchange" hidden data-file-exchange></section>
    <section data-file-panel="settings" hidden><h3>Display</h3><div class="file-units"><span id="file-units-label">Units</span><div class="seg" role="group" aria-labelledby="file-units-label"><button type="button" class="seg-btn" data-units-choice="imperial">INCHES</button><button type="button" class="seg-btn" data-units-choice="metric">MILLIMETRES</button></div></div><label>Precision <select data-file-precision></select></label><p data-units-example></p><details><summary>Model environment</summary><div data-file-env></div></details><div data-unavailable-list></div><h3>Where this project is kept</h3><p data-own-folder-label></p><div class="file-actions"><button class="btn primary" data-own-folder-link>CHOOSE FOLDER</button><button class="btn" data-folder-open>OPEN FROM FOLDER</button><button class="btn" data-own-folder-unlink>STOP KEEPING IT IN A FOLDER</button></div>
      <label>Keep a SketchUp mirror (.skp) beside each project <input type="checkbox" data-mirror-on></label><p data-mirror-label></p>
      <h3>One-pager</h3><label>Ask to update the one-pager when Tiksi closes <select data-op-prompt>${PROMPT_MODES.map(([id,label])=>`<option value="${id}">${escapeHtml(label)}</option>`).join('')}</select></label><p>Closing Tiksi first shows the browser's own Leave site? question. Choose Cancel to stay and Tiksi asks whether to save the next version; choose Leave to close without it.</p>
      <details><summary>Workspace backup & maintenance</summary><h3>Projects without their own folder</h3><p data-folder-label></p><div class="file-actions"><button class="btn" data-folder-link>KEEP THEM IN ONE FOLDER</button><button class="btn" data-folder-unlink>UNLINK</button></div><p>Project saves are usually enough. A workspace backup carries every property.</p><button class="btn" data-workspace-save>SAVE WORKSPACE BACKUP</button><button class="btn" data-demo>ADD DEMO PROJECTS</button><button class="btn" data-storage>CLEAN UNUSED STORAGE</button><div data-mac-cleanup hidden><button class="btn" data-mac-cleanup-list>CLEAN UNUSED STORAGE ON THE MAC</button><p data-mac-cleanup-plan></p><button class="btn" data-mac-cleanup-remove hidden>REMOVE</button></div><p>Replace workspace is available only when you intentionally want to restore a full backup.</p><button class="btn" data-workspace-replace>REPLACE FROM BACKUP…</button></details></section>
    <p role="status" data-file-status></p><input type="file" data-any-file hidden multiple accept=".tiksi,.json,${SCAN_ACCEPT},.c4d,.max,.ma,.mb,.rfa,.dwf,.mtl,.bin,.tga,.jpg,.jpeg,.png,.webp,.heic,.heif,.tif,.tiff,.avif,.mp4,.mov,.m4v"><input type="file" data-replace-file hidden accept=".json,.zip,.tiksi">`;
  document.body.append(dialog);dialog.showModal();dialog.addEventListener('close',()=>dialog.remove());
  const envHost=dialog.querySelector('[data-file-env]');
  if(currentName==='model')viewer3d.mountEnvironmentSettings(envHost);
  else {envHost.innerHTML='<button class="btn" data-open-model-settings>OPEN MODEL SETTINGS</button>';envHost.querySelector('button').onclick=()=>{dialog.close();history.replaceState(null,'','#/model');route();openFileMenu('settings');};}
  const status=dialog.querySelector('[data-file-status]'), on=(selector,fn)=>dialog.querySelector(selector).onclick=fn;
  const refresh=()=>{
    const st=filesState(),target=prop && saveTarget(prop.id);
    dialog.querySelector('[data-file-target]').textContent=target?'Saving to '+target.name:'Choose a file on first save. Cmd+S saves again; Cmd+O opens a project.';
    const own=prop&&projectFolder(prop.id);
    dialog.querySelector('[data-own-folder-label]').textContent=!prop?'Open a property to choose where it is kept.'
      :own?(own.permitted?'Kept in '+own.label+'. Only this project is written there.':'Kept in '+own.label+', which needs permission again: RECONNECT FOLDER asks for it.')
      :st.folder?'Kept in '+st.folderName+' with the other projects that have no folder of their own. CHOOSE FOLDER keeps it in its own folder instead.'
      :'Kept in this browser only. CHOOSE FOLDER and pick the project\'s folder: Tiksi keeps its files in a Tiksi folder inside it, beside the project\'s other documents.';
    const ownLink=dialog.querySelector('[data-own-folder-link]');ownLink.disabled=!FSA_DIR||!prop;ownLink.textContent=own&&!own.permitted?'RECONNECT FOLDER':'CHOOSE FOLDER';
    dialog.querySelector('[data-own-folder-unlink]').disabled=!own;
    dialog.querySelector('[data-folder-label]').textContent=st.folderNeedsPermission?st.folderName+' needs permission again: RECONNECT asks for it.':st.folder?'Saved as files in '+st.folderName+'.':'They are kept in this browser only. Pick one folder to keep them all there as files.';
    const sharedLink=dialog.querySelector('[data-folder-link]');sharedLink.textContent=st.folderNeedsPermission?'RECONNECT':'KEEP THEM IN ONE FOLDER';
    dialog.querySelector('[data-folder-link]').disabled=!FSA_DIR;dialog.querySelector('[data-folder-open]').disabled=!st.folder&&!(own&&own.permitted);dialog.querySelector('[data-folder-unlink]').disabled=!st.folder && !st.folderNeedsPermission;
    dialog.querySelector('[data-mirror-on]').checked=ws.data.settings.sketchupMirror!==false;dialog.querySelector('[data-mirror-label]').textContent=prop?mirrorStatus(prop.id):'';
    const opStatus=dialog.querySelector('[data-op-file-status]');if(prop){const st=onePagerStatus(prop,projectSlice(prop.id));opStatus.textContent=st.text;opStatus.dataset.state=st.state;}else opStatus.textContent='Open a property to see its one-pager.';dialog.querySelector('[data-one-pager]').disabled=!prop;
    const goneHost = dialog.querySelector('[data-unavailable-list]'), gone = diskWorkspace ? diskWorkspace.unavailable : [];
    // Only a project whose file is missing can be taken off the list (the Mac refuses the
    // others: an unreadable file is still there). The Mac cannot tell a deleted file from one
    // on a drive that is not connected, so the question shows where the file was.
    goneHost.innerHTML = gone.length ? '<h3>Projects the Mac cannot read just now</h3>' + gone.map(u => `<p data-unavailable="${escapeHtml(u.id)}">${escapeHtml(u.message || u.name || u.id)}${u.reason === 'missing' ? ` <button class="btn" data-forget="${escapeHtml(u.id)}">REMOVE FROM LIST</button>` : ''}</p>`).join('') : '';
    goneHost.querySelectorAll('[data-forget]').forEach(b => b.onclick = () => run(async () => {
      const u = diskWorkspace.unavailable.find(x => x.id === b.dataset.forget);
      if (!u || !confirm('Take ' + (u.name || 'this project') + ' off the Mac\'s list?\n\nIts file was at:\n' + (u.path || '(the Mac did not say where)') +
        '\n\nIf that is on a drive that is not connected, connect the drive instead: the project then comes back by itself.\n\nNo file is deleted. A file that turns up again inside the Mac\'s projects folder brings the project back; a file kept anywhere else has to be opened again by hand (FILE, OPEN / IMPORT).')) return 'Nothing changed.';
      try { await diskWorkspace.forgetUnavailable(u.id); }
      catch (e) { throw new Error(e.status === 404 ? 'The Tiksi running on this Mac cannot take a project off its list yet. Nothing changed.' : e.message); }
      refreshTopbar();
      return (u.name || 'The project') + ' is off the list. No file was deleted.';
    }));
    if (!diskWorkspace && storageKept !== null) dialog.querySelector('[data-folder-label]').textContent += storageKept ? ' This browser has agreed to keep its storage.' : ' This browser may clear its storage after a while without a visit: save a workspace backup now and then.';
    if (diskWorkspace) {
      dialog.querySelector('[data-own-folder-label]').textContent = prop ? (diskWorkspace.paths[prop.id] || 'A project folder is created on its first save.') : diskWorkspace.folder;
      dialog.querySelector('[data-folder-label]').textContent = 'All projects are files on this Mac. Desktop and Tailscale clients use the same project folders. A phone or another computer keeps only what it has not sent yet in its browser, until the Mac has it.';
      for (const selector of ['[data-own-folder-link]', '[data-own-folder-unlink]', '[data-folder-open]', '[data-folder-link]', '[data-folder-unlink]', '[data-storage]']) dialog.querySelector(selector).hidden = true;
    }
  };
  const stopWatching=onFilesChange(refresh);dialog.addEventListener('close',stopWatching);
  let busy=false;
  const run=async fn=>{if(busy)return;busy=true;const disabled=Array.from(dialog.querySelectorAll('button')).filter(b=>!b.disabled);disabled.forEach(b=>b.disabled=true);dialog.oncancel=e=>e.preventDefault();try {status.textContent='Working…';const said=await fn();status.textContent=typeof said==='string'?said:'Done.';refresh();}catch(e){status.textContent=e.message;}finally{busy=false;dialog.oncancel=null;disabled.forEach(b=>b.disabled=false);refresh();}};
  let exchangeMounted=false;
  const mountExchange=()=>{if(exchangeMounted)return;exchangeMounted=true;if(currentName==='model'){const image=document.createElement('button');image.className='btn';image.textContent='SAVE VIEW IMAGE';image.dataset.saveView='';image.onclick=()=>{dialog.close();viewer3d.openStillDialog();};dialog.querySelector('[data-file-exchange]').append(image);}if(prop) openExchangeDialog(prop,{selected,host:dialog.querySelector('[data-file-exchange]'),close:()=>dialog.close(),imported:async scan=>{viewer3d.focusScanOnMount(scan.id);refreshTopbar();if(currentName==='model')remountView();else location.hash='#/model';},changed:remountView});};
  const tab=id=>{if(id==='exchange')mountExchange();dialog.querySelectorAll('[data-file-panel]').forEach(p=>p.hidden=p.dataset.filePanel!==id);dialog.querySelectorAll('[data-file-tab]').forEach(b=>{b.classList.toggle('active',b.dataset.fileTab===id);b.setAttribute('aria-current',b.dataset.fileTab===id?'true':'false');});};
  dialog.querySelectorAll('[data-file-tab]').forEach(b=>b.onclick=()=>tab(b.dataset.fileTab));tab(initialTab);refresh();
  on('[data-close-file]',()=>dialog.close());
  on('[data-project-save]',()=>run(()=>saveProject(prop)));on('[data-project-as]',()=>run(()=>saveProject(prop,{as:true})));
  const input=dialog.querySelector('[data-any-file]');
  on('[data-project-open]',()=>input.click());on('[data-capture-open]',()=>input.click());
  input.onchange=()=>run(async()=>{const files=Array.from(input.files);input.value='';let type;
    const models=files.filter(f=>/\.(gltf|obj|dae|fbx|3ds|usd|usda|usdc|blend)$/i.test(f.name));
    if(files.length>1 && models.length===1){
      const {zipSync}=await import('three/addons/libs/fflate.module.js'),entries={};
      for(const f of files){if(entries[f.name])throw new Error('Two resources have the same name; import a ZIP retaining the folder structure.');entries[f.name]=new Uint8Array(await f.arrayBuffer());}
      type=await importAnyFile(new File([zipSync(entries)],models[0].name+'.zip'));
    } else for(const file of files)type=await importAnyFile(file);ensureBuiltinMaterials();refreshTopbar();if(type==='model'&&currentName!=='model')location.hash='#/model';else if(type==='photo'&&currentName!=='photos')location.hash='#/photos';else if(type==='measure'&&currentName!=='measure')location.hash='#/measure';else remountView();dialog.close();});
  on('[data-new-property]',()=>{dialog.close();openNewPropertyDialog();});
  // The folder of a site visit: its scans, photos, videos and PDFs become a property in one go.
  on('[data-new-folder]',()=>{dialog.close();openNewPropertyDialog({folder:true});});
  on('[data-one-pager]',()=>{dialog.close();openOnePagerEditor(prop);});
  dialog.querySelector('[data-op-prompt]').value=promptMode();
  dialog.querySelector('[data-op-prompt]').onchange=e=>{ws.data.settings.onePagerPrompt=e.target.value;touch();};
  on('[data-polycam]',()=>{dialog.close();openNewPropertyDialog({into:prop?.id});});
  on('[data-photo3d]',()=>{dialog.close();location.hash='#/reconstruct';});
  // Units and precision: inches (feet and inches, to 1/16" unless changed) or millimetres.
  const showUnits=()=>{
    const metric=units()==='metric', s=ws.data.settings;
    dialog.querySelectorAll('[data-units-choice]').forEach(b=>{const on=b.dataset.unitsChoice===s.units;b.classList.toggle('active',on);b.setAttribute('aria-pressed',String(on));});
    const pick=dialog.querySelector('[data-file-precision]');
    pick.innerHTML=metric?MM_PRECISIONS.map(n=>`<option value="${n}">${escapeHtml(mmPrecisionLabel(n))}</option>`).join(''):INCH_PRECISIONS.map(n=>`<option value="${n}">${escapeHtml(inchPrecisionLabel(n))}</option>`).join('');
    pick.value=String(metric?mmPrecision():inchPrecision());
    dialog.querySelector('[data-units-example]').textContent='Lengths show like '+fmtLen(0.8509)+' and '+fmtLen(3.81)+', to the nearest '+precisionLabel()+'. Areas show in '+(metric?'square metres.':'square feet.');
  };
  dialog.querySelectorAll('[data-units-choice]').forEach(b=>b.onclick=()=>{if(ws.data.settings.units===b.dataset.unitsChoice)return;ws.data.settings.units=b.dataset.unitsChoice;touch();showUnits();remountView();});
  dialog.querySelector('[data-file-precision]').onchange=e=>{ws.data.settings[units()==='metric'?'mmPrecision':'inchPrecision']=Number(e.target.value);touch();showUnits();remountView();};
  showUnits();
  on('[data-folder-link]',()=>run(async()=>{
    if(filesState().folderNeedsPermission)return await reconnectFolder(true)?'Reconnected '+filesState().folderName+'.':'Permission was not given; nothing changed.';
    const dir=await linkFolder();return dir?'Projects without their own folder are now saved in '+dir.name+'.':'No folder chosen; nothing changed.';}));
  dialog.querySelector('[data-mirror-on]').onchange=e=>{ws.data.settings.sketchupMirror=e.target.checked;touch();scheduleFolderSync(0);refresh();};
  on('[data-folder-open]',()=>openFolderList(dialog.querySelector('[data-folder-open]')));
  on('[data-folder-unlink]',()=>run(async()=>{await unlinkFolder();return 'Unlinked. Projects without their own folder are kept in this browser only.';}));
  on('[data-own-folder-link]',()=>run(async()=>{
    const dir=await linkProjectFolder(prop);if(!dir)return 'No folder chosen; nothing changed.';
    refreshTopbar();remountView();const own=projectFolder(prop.id);
    return own&&own.permitted?'Kept in '+own.label+'.':'Permission was not given; nothing changed.';}));
  on('[data-own-folder-unlink]',()=>run(async()=>{await unlinkProjectFolder(prop.id);const st=filesState();
    return st.folder?'Back with the other projects in '+st.folderName+'. The files in its folder stay where they are.':'Kept in this browser only now. The files in its folder stay where they are.';}));
  on('[data-workspace-save]',()=>run(runExportBundle));on('[data-storage]',()=>run(()=>offerStorageCleanup(false)));
  // The Mac's own clean-up: shown only when the Mac's server offers it to this caller. A press
  // lists what would go; REMOVE sends back exactly that list. A touch device sees the list only:
  // removing is done from the Mac.
  const macBox=dialog.querySelector('[data-mac-cleanup]'),macPlanText=dialog.querySelector('[data-mac-cleanup-plan]'),macRemove=dialog.querySelector('[data-mac-cleanup-remove]');
  let cleaner=null,cleanupChecked=false,cleanupPlan=null,cleanupText=null;
  macBox.closest('details').addEventListener('toggle',async e=>{
    if(!e.target.open||!diskWorkspace||cleanupChecked)return;cleanupChecked=true;
    cleanupText=await import('./mac-cleanup.js');cleaner=await cleanupText.macCleanup();macBox.hidden=!cleaner;});
  const showPlan=(plan,lead='')=>{
    cleanupPlan=plan;const touch=!cleanupText.removesHere();
    macPlanText.textContent=lead+cleanupText.describePlan(plan,fmtBytes)+(plan.count&&touch?' Removing is done from Tiksi on the Mac itself.':'');
    macRemove.hidden=!plan.count||touch;};
  on('[data-mac-cleanup-list]',()=>run(async()=>{showPlan(await cleaner.list());return cleanupPlan.count?'Nothing is removed until REMOVE is pressed.':'Nothing to remove.';}));
  on('[data-mac-cleanup-remove]',()=>run(async()=>{
    try{const done=await cleaner.remove(cleanupPlan);cleanupPlan=null;macRemove.hidden=true;macPlanText.textContent=cleanupText.describeResult(done,fmtBytes);return macPlanText.textContent;}
    catch(error){if(error.code!=='cleanup-changed'||!error.plan)throw error;
      showPlan(error.plan,'What can be removed changed since it was listed, so nothing was removed. The new list: ');return 'Look at the new list before removing.';}}));
  on('[data-demo]',()=>{mergeWorkspace(freshDemo());ensureBuiltinMaterials();refreshTopbar();remountView();dialog.close();});
  const replace=dialog.querySelector('[data-replace-file]');on('[data-workspace-replace]',()=>replace.click());
  replace.onchange=()=>run(async()=>{const file=replace.files[0];replace.value='';if(!file)return;
    if(!confirm('Replace the workspace with '+file.name+'? This is the explicit backup-restore action.'))return;
    if(/\.json$/i.test(file.name))replaceWorkspace(JSON.parse(await file.text()));else if(!await importBundle(file,{confirm:false}))return;
    afterWorkspaceReplaced();refreshTopbar();dialog.close();});
}

// The demo projects, as records of their own. The demo's property and projects have fixed
// ids; added a second time they would replace whatever was built on the first, so a demo
// whose ids are already here gets new ones.
function freshDemo() {
  const demo = demoWorkspace();
  const here = new Set([...ws.data.properties, ...ws.data.projects].map(r => r.id));
  const tail = '-' + Date.now().toString(36);
  let text = JSON.stringify(demo);
  for (const id of [...demo.properties, ...demo.projects].map(r => r.id)) if (here.has(id)) text = text.split(JSON.stringify(id)).join(JSON.stringify(id + tail));
  return JSON.parse(text);
}

// A project file that holds something already open here and different: say what would be
// replaced by what, and ask. The open copy carries no date of its own, so the file's date and
// what each holds are shown.
function confirmReplace({ file, same, others }) {
  const count = (n, one) => n + ' ' + one + (n === 1 ? '' : 's');
  const holds = (p, projects) => [count((p.walls || []).length, 'wall'), count((p.rooms || []).length, 'room'), count((p.photos || []).length, 'photo'), count((p.scans || []).length, 'model'), count(projects, 'project')].join(', ');
  const named = file ? file.name : 'the file';
  const when = file && file.lastModified ? ' (saved ' + new Date(file.lastModified).toLocaleString() + ')' : '';
  const lines = same.map(({ incoming, current, projects }) =>
    '“' + (current.name || incoming.name) + '” is already open here.\n  Open here: ' + holds(current, ws.data.projects.filter(pr => pr.propertyId === current.id).length) +
    '\n  In ' + named + when + ': ' + holds(incoming, projects));
  // Projects, products and custom materials with the same id and different content.
  const list = (records, one) => records.length ? [count(records.length, one) + ' open here ' + (records.length === 1 ? 'differs' : 'differ') + ' from ' + named + when + ': ' +
    records.slice(0, 6).map(r => '“' + (r.name || r.id) + '”').join(', ') + (records.length > 6 ? ' and ' + (records.length - 6) + ' more' : '') + '.'] : [];
  if (others) lines.push(...list(others.projects, 'project'), ...list(others.products, 'product'), ...list(others.materials, 'material'));
  return confirm(lines.join('\n\n') + '\n\nReplace what is open here with the file\'s? ' + (same.length ? 'A replaced property\'s projects that are not in the file are removed, and undo is cleared. ' : '') + 'Cancel keeps what is open.');
}

// EDIT IN SKETCHUP (PLAN and MODEL tool columns): open this project's .skp in SketchUp. Without a
// folder there is no .skp yet, so Settings opens where the folder is chosen.
let openingSketchUp = false;
async function openInSketchUp() {
  const prop = activeProperty();
  if (openingSketchUp || !prop) return;
  openingSketchUp = true;
  showToast('Bringing ' + prop.name + ' up to date in its SketchUp model…', 'info');
  try {
    const r = await editInSketchUp(prop);
    showToast('Opened ' + r.file + ' in ' + r.app + '. Save there and the changes come back here.');
  } catch (e) {
    if (e instanceof NeedsFolder) {
      openFileMenu('settings');
      const status = document.querySelector('[data-file-dialog] [data-file-status]');
      if (status) status.textContent = e.message;
    } else showToast(e.message, 'error');
  } finally { openingSketchUp = false; }
}

// One-line confirmation at the bottom of the window (styles: .toast in console.css). Inside an
// open dialog so a modal does not cover it.
function showToast(text, kind) {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const el = document.createElement('div');
  el.className = 'toast ' + (kind || 'ok'); el.setAttribute('role', 'status'); el.textContent = text;
  (document.querySelector('dialog[open]') || document.body).append(el);
  setTimeout(() => { el.classList.add('leaving'); setTimeout(() => el.remove(), 200); }, 6000);
}

// Opening a project always says what it opened, also when that file was already open here.
function confirmOpened({ ids, name, replaced }) {
  const props = ids.map(id => ws.data.properties.find(p => p.id === id)).filter(Boolean);
  if (!props.length) { showToast('Opened ' + name + ', but it holds no properties.', 'error'); return; }
  if (props.length > 1) { showToast('Opened ' + name + ': ' + props.length + ' properties' + (replaced.length ? ', ' + replaced.length + ' of them replacing this browser\'s copy' : '') + '.'); return; }
  const p = props[0], count = (n, one) => n + ' ' + one + (n === 1 ? '' : 's');
  showToast('Opened ' + p.name + (replaced.includes(p.id) ? ', replacing this browser\'s copy' : '') + ': ' + count((p.scans || []).length, 'model') + ', ' + count((p.photos || []).length, 'photo') + ', ' + count((p.walls || []).length, 'wall') + '.');
}

async function openFolderList(anchor) {
  // The shared folder, plus the active project's own folder when it has one.
  const prop = activeProperty(), st = filesState(), own = prop && st.projectFolders.get(prop.id);
  const folders = [st.folder, own && own.permitted ? own.handle : null].filter(Boolean);
  let entries = [];
  try { for (const folder of folders) entries.push(...await listFolder(folder)); } catch (e) { alert('Could not read the folder: ' + e.message); return; }
  const names = folders.map(f => f.name).join(' OR ');
  if (!entries.length) { openMenu(anchor, [{ label: 'NO PROJECT FILES IN ' + names.toUpperCase(), hint: 'save a property and it appears here', run() {} }]); return; }
  openMenu(anchor, entries.map(en => ({
    label: en.name.replace(/\.tiksi$/i, '').toUpperCase(),
    hint: (folders.length > 1 ? en.folder.name + ': ' : '') + fmtBytes(en.size) + ', ' + new Date(en.lastModified).toLocaleString() + (en.inWorkspace ? ' (open here)' : ''),
    run: () => openFromFolder(en).catch(e => alert('Open failed: ' + e.message)),
  })));
}

// SAVE shows a dot when the browser copy is ahead of the file, red when the folder holds a newer file.
function refreshSaveButton() {
  const btn = document.getElementById('btn-file');
  if (!btn) return;
  const prop = activeProperty();
  const st = filesState();
  if (!prop) { btn.classList.remove('dirty', 'warn'); btn.title = 'Save this property as a project file (Cmd+S)'; return; }
  const target = saveTarget(prop.id);
  const conflict = st.conflicts.has(prop.id);
  btn.classList.toggle('warn', conflict);
  btn.classList.toggle('dirty', !conflict && isDirty(prop.id));
  btn.title = conflict ? 'A newer ' + target.name + ' is in ' + (target.folder || st.folderName) + '. FILE > OPEN FROM FOLDER pulls it in; SAVE would keep this copy.'
    : target ? (isDirty(prop.id) ? 'Changes since the last save to ' + target.name + ' (Cmd+S)' : 'Saved to ' + target.name)
    : 'Save this property as a project file (Cmd+S)';
}

async function runExportBundle() {
  const btn = document.getElementById('btn-file');
  btn.disabled = true;
  setSaveStatus('BUNDLING', true);
  try {
    if (diskWorkspace) await diskWorkspace.whenPictures();
    const r = await exportBundle();
    setSaveStatus('EXPORTED ' + r.fileCount + ' FILE' + (r.fileCount === 1 ? '' : 'S'), false);
  } catch (e) {
    console.error('bundle export failed', e);
    setSaveStatus('EXPORT FAILED', true);
    alert('Bundle export failed: ' + e.message);
  } finally {
    btn.disabled = false;
  }
}

// Small anchored menu under a topbar button. Closes on choice, outside click or Escape.
function openMenu(anchor, items) {
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'tb-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = items.map((it, i) => `
    <button class="tb-menu-item ${it.primary ? 'primary' : ''} ${it.sep ? 'sep' : ''}" role="menuitem" data-i="${i}" ${it.disabled ? 'disabled' : ''}>
      <span>${escapeHtml(it.label)}</span>${it.hint ? `<small>${escapeHtml(it.hint)}</small>` : ''}
    </button>`).join('');
  const r = anchor.getBoundingClientRect();
  menu.style.top = (r.bottom + 6) + 'px';
  menu.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
  document.body.appendChild(menu);
  menu.querySelectorAll('.tb-menu-item').forEach(b => b.onclick = () => { closeMenu(); items[+b.dataset.i].run(); });
  const onKey = e => { if (e.key === 'Escape') { closeMenu(); anchor.focus(); } };
  const onDown = e => { if (!menu.contains(e.target) && e.target !== anchor) closeMenu(); };
  menu._cleanup = () => { window.removeEventListener('keydown', onKey); window.removeEventListener('pointerdown', onDown, true); };
  window.addEventListener('keydown', onKey);
  window.addEventListener('pointerdown', onDown, true);
  menu.querySelector('.tb-menu-item').focus();
}
function closeMenu() {
  const m = document.querySelector('.tb-menu');
  if (!m) return;
  if (m._cleanup) m._cleanup();
  m.remove();
}

function refreshTopbar() {
  const sel = document.getElementById('property-select');
  const d = ws.data;
  const active = activeProperty();
  // A project the Mac lists but cannot read just now stays in the list, greyed, with the
  // reason: it has not vanished, and it comes back by itself when its file does.
  const gone = diskWorkspace ? diskWorkspace.unavailable : [];
  sel.innerHTML = (d.properties.map(p =>
    `<option value="${escapeHtml(p.id)}" ${active && p.id === active.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')
    || '<option value="">(no property)</option>')
    + gone.map(u => `<option value="" disabled data-unavailable="${escapeHtml(u.id)}" title="${escapeHtml(u.message || '')}">${escapeHtml(u.name || 'A project')} (${u.reason === 'missing' ? 'file missing' : 'file cannot be read'})</option>`).join('');
  sel.title = gone.length ? gone.map(u => u.message).join('\n') : '';
  document.querySelectorAll('#units-seg .seg-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.units === d.settings.units));
  refreshSaveButton();
  refreshHistoryControls();
}

boot().catch(error => {
  console.error(error);
  const host = document.getElementById('view');
  // Only a failure to reach or read the Mac's project files is reported as that. Anything
  // else that stops the app starting is said as what it is.
  if (error && error.projectFiles) {
    setSaveStatus('PROJECT FILES UNAVAILABLE', true);
    host.textContent = 'Could not open the Mac’s project files. Reconnect to the Mac and reload. Existing files and browser migration data have been preserved. ' + error.message;
    return;
  }
  setSaveStatus('TIKSI COULD NOT START', true);
  host.innerHTML = `<div class="view-scroll page-open-failed" role="alert"><div class="kicker">TIKSI</div>
    <p>Tiksi could not start (${escapeHtml(String(error && error.message || error))}). This is not a problem with the Mac’s project files, and nothing saved is affected.</p>
    <p><button class="btn primary" data-reload>RELOAD</button></p></div>`;
  host.querySelector('[data-reload]').onclick = () => location.reload();
});
