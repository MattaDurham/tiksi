// App shell: routing, topbar, property management, persistence wiring.

import {
  ws, load, save, touch, onChange, activeProperty, replaceWorkspace,
  exportWorkspace, exportBundle, importBundle, listAllFileIds, orphanFiles, deleteFiles, whenHydrated,
  setSaveStatus, fmtBytes, escapeHtml,
} from './store.js';
import { ensureBuiltinMaterials } from './materials.js';
import { disposeMaterials } from './textures.js';
import { revokePhotoUrls } from './photos-store.js';
import { demoWorkspace } from './demo.js';
import * as plan2d from './plan2d.js';
import * as viewer3d from './viewer3d.js';
import * as materialsview from './materialsview.js';
import * as photos from './photos.js';
import * as projects from './projects.js';
import * as products from './products.js';
import * as budget from './budget.js';
import * as schedule from './schedule.js';
import * as cutsheets from './cutsheets.js';
import { initNewProperty, openNewPropertyDialog, dialogOpen } from './newproperty.js';
import { parseCaptureUrl } from './polycam.js';

const VIEWS = {
  plan: plan2d,
  model: viewer3d,
  materials: materialsview,
  photos,
  projects,
  products,
  budget,
  schedule,
  sheets: cutsheets,
};

let currentView = null;
let currentName = '';

async function boot() {
  const had = load();
  if (!had || ws.data.properties.length === 0 && ws.data.projects.length === 0) {
    replaceWorkspace(demoWorkspace());
  }
  ensureBuiltinMaterials();
  save();
  // Photo thumbnails come back from IndexedDB asynchronously; the first render waits for them.
  await whenHydrated();

  bindTopbar();
  refreshTopbar();
  onChange(refreshTopbar);
  initNewProperty({ remount: remountView, refresh: refreshTopbar });
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

// A view that throws while tearing down must never wedge navigation: log it and move on.
function unmountCurrent() {
  if (!currentView || !currentView.unmount) return;
  try { currentView.unmount(); } catch (e) { console.error('unmount failed', e); }
}

function route() {
  // Views may carry a query (#/model?pin=<photoId>); the view reads it from location.hash itself.
  const name = (location.hash.replace(/^#\//, '').split('?')[0] || 'plan');
  const head = name.split('/')[0];
  if ((head === 'import' || head === 'new') && importFromHash()) { if (!currentView) route(); return; }
  const view = VIEWS[name] || VIEWS.plan;
  unmountCurrent();
  currentName = VIEWS[name] ? name : 'plan';
  currentView = view;
  document.querySelectorAll('#rail a[data-view]').forEach(a =>
    a.classList.toggle('active', a.dataset.view === currentName));
  const root = document.getElementById('view');
  root.innerHTML = '';
  view.mount(root);
}

function remountView() {
  unmountCurrent();
  const root = document.getElementById('view');
  root.innerHTML = '';
  currentView.mount(root);
}

// Called after the whole workspace was swapped out: drop GPU/material caches and object URLs
// that belong to the old data, then make sure builtin materials exist and redraw.
function afterWorkspaceReplaced() {
  disposeMaterials();
  revokePhotoUrls();
  ensureBuiltinMaterials();
  remountView();
  offerStorageCleanup(true);
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
function bindTopbar() {
  const sel = document.getElementById('property-select');
  sel.onchange = () => {
    ws.data.settings.activePropertyId = sel.value;
    touch();
    remountView();
  };

  document.getElementById('property-new').onclick = () => openNewPropertyDialog();

  document.querySelectorAll('#units-seg .seg-btn').forEach(b => b.onclick = () => {
    ws.data.settings.units = b.dataset.units;
    touch();
    remountView();
  });

  const exportBtn = document.getElementById('btn-export');
  exportBtn.onclick = async () => {
    // No binary files: a JSON export is complete on its own. With scans or photos, offer the
    // bundle (recommended) or the light JSON-only export; with leftovers in storage, cleanup.
    const n = listAllFileIds().length;
    let stray = 0;
    try { stray = (await orphanFiles()).ids.length; } catch (e) { /* storage unavailable: nothing to clean */ }
    if (!n && !stray) { exportWorkspace(); return; }
    const items = n ? [
      { label: 'BUNDLE (.zip)', hint: 'workspace + ' + n + ' scan/photo file' + (n === 1 ? '' : 's'), primary: true, run: runExportBundle },
      { label: 'WORKSPACE ONLY (.json)', hint: 'no binary files', run: exportWorkspace },
    ] : [{ label: 'WORKSPACE (.json)', primary: true, run: exportWorkspace }];
    if (stray) items.push({ label: 'CLEAN STORAGE', hint: stray + ' stored file' + (stray === 1 ? '' : 's') + ' nothing here uses', run: () => offerStorageCleanup(false) });
    openMenu(exportBtn, items);
  };

  const importFile = document.getElementById('import-file');
  importFile.accept = '.json,.zip,application/json,application/zip';
  document.getElementById('btn-import').onclick = () => importFile.click();
  importFile.onchange = async () => {
    const file = importFile.files[0];
    importFile.value = '';
    if (!file) return;
    try {
      if (await isZipFile(file)) {
        if (!(await importBundle(file))) return;
      } else {
        const data = JSON.parse(await file.text());
        if (!data || !Array.isArray(data.properties)) throw new Error('not a tiksi workspace file');
        if (!confirm('Replace the current workspace with "' + file.name + '"? Export first if you want a backup.')) return;
        replaceWorkspace(data);
      }
      afterWorkspaceReplaced();
    } catch (e) {
      alert('Import failed: ' + e.message);
    }
  };

  document.getElementById('btn-demo').onclick = () => {
    if (!confirm('Load the demo workspace? This replaces everything currently here (export first for a backup).')) return;
    replaceWorkspace(demoWorkspace());
    afterWorkspaceReplaced();
  };
}

async function runExportBundle() {
  const btn = document.getElementById('btn-export');
  btn.disabled = true;
  setSaveStatus('BUNDLING', true);
  try {
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

async function isZipFile(file) {
  if (/\.zip$/i.test(file.name)) return true;
  if (/\.json$/i.test(file.name)) return false;
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  return head[0] === 0x50 && head[1] === 0x4b && head[2] === 3 && head[3] === 4;   // "PK\3\4"
}

// Small anchored menu under a topbar button. Closes on choice, outside click or Escape.
function openMenu(anchor, items) {
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'tb-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = items.map((it, i) => `
    <button class="tb-menu-item ${it.primary ? 'primary' : ''}" role="menuitem" data-i="${i}">
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
  sel.innerHTML = d.properties.map(p =>
    `<option value="${escapeHtml(p.id)}" ${active && p.id === active.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')
    || '<option value="">(no property)</option>';
  document.querySelectorAll('#units-seg .seg-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.units === d.settings.units));
}

boot();
