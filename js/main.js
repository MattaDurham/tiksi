// App shell: routing, topbar, property management, persistence wiring.

import {
  ws, load, save, touch, onChange, activeProperty, replaceWorkspace, mergeWorkspace,
  exportBundle, importBundle, listAllFileIds, orphanFiles, deleteFiles, whenHydrated,
  setSaveStatus, fmtBytes, escapeHtml,
} from './store.js';
import { openExchangeDialog } from './exchange-dialog.js';
import { SCAN_ACCEPT, importScanFile } from './scans.js';
import { addPhotoFromFile } from './photos-store.js';
import { ensureBuiltinMaterials } from './materials.js';
import { disposeMaterials } from './textures.js';
import { revokePhotoUrls } from './photos-store.js';
import { demoWorkspace } from './demo.js';
import * as plan2d from './plan2d.js';
import * as viewer3d from './viewer3d.js';
import * as materialsview from './materialsview.js';
import * as photos from './photos.js';
import * as reconstruction from './reconstruction.js';
import * as research from './research.js';
import * as projects from './projects.js';
import * as products from './products.js';
import * as budget from './budget.js';
import * as schedule from './schedule.js';
import * as cutsheets from './cutsheets.js';
import * as guide from './guide.js';
import { initNewProperty, openNewPropertyDialog, dialogOpen } from './newproperty.js';
import { parseCaptureUrl } from './polycam.js';
import {
  initFiles, bindFileIntake, saveProject, openProjectPicker, openFromFile, openFromUrl, linkFolder, unlinkFolder, reconnectFolder,
  linkProjectFolder, unlinkProjectFolder, projectFolder,
  listFolder, openFromFolder, scheduleFolderSync, filesState, onFilesChange, isDirty, saveTarget, FSA, FSA_DIR, mirrorStatus,
} from './files.js';

const VIEWS = {
  plan: plan2d,
  model: viewer3d,
  materials: materialsview,
  photos,
  reconstruct: reconstruction,
  research,
  projects,
  products,
  budget,
  schedule,
  sheets: cutsheets,
  guide,
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
  // Projects are files: SAVE, the FILE menu, drops, Cmd+S/Cmd+O, and the linked folder.
  initFiles({ remount: remountView, refresh: refreshTopbar, afterReplace: afterWorkspaceReplaced });
  bindFileIntake(importAnyFile);
  onChange(() => { scheduleFolderSync(); refreshSaveButton(); });
  onFilesChange(refreshSaveButton);
  reconnectFolder(false).then(refreshSaveButton).catch(() => refreshSaveButton());
  refreshSaveButton();
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
  const name = (location.hash.replace(/^#\//, '').split('?')[0] || 'plan');
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

  document.addEventListener('tiksi:files',e=>openFileMenu(e.detail?.tab || 'project',e.detail?.selected));

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
      <button class="btn" data-new-property>NEW PROPERTY</button></section>
    <section data-file-panel="capture" hidden><h3>Bring your room into Tiksi</h3><p>Choose photos, a scan, a 3D model or a saved project. Imported projects add or update properties here.</p><button class="btn primary" data-capture-open>CHOOSE FILES…</button><button class="btn" data-polycam>POLYCAM LINK</button><button class="btn" data-photo3d>PHOTOS → 3D</button></section>
    <section data-file-panel="exchange" hidden data-file-exchange></section>
    <section data-file-panel="settings" hidden><h3>Display</h3><label>Units <select data-file-units><option value="imperial">Feet / square feet</option><option value="metric">Metres / square metres</option></select></label><details><summary>Model environment</summary><div data-file-env></div></details><h3>Project folder</h3><p data-folder-label></p><div class="file-actions"><button class="btn" data-folder-link>LINK FOLDER</button><button class="btn" data-folder-open>OPEN FROM FOLDER</button><button class="btn" data-folder-unlink>UNLINK</button></div>
      <h3>This project's folder</h3><p data-own-folder-label></p><div class="file-actions"><button class="btn" data-own-folder-link>LINK THIS PROJECT'S FOLDER</button><button class="btn" data-own-folder-unlink>USE THE SHARED FOLDER</button></div>
      <label>Keep a SketchUp mirror (.skp) beside each project <input type="checkbox" data-mirror-on></label><p data-mirror-label></p>
      <details><summary>Workspace backup & maintenance</summary><p>Project saves are usually enough. A workspace backup carries every property.</p><button class="btn" data-workspace-save>SAVE WORKSPACE BACKUP</button><button class="btn" data-demo>ADD DEMO PROJECTS</button><button class="btn" data-storage>CLEAN UNUSED STORAGE</button><p>Replace workspace is available only when you intentionally want to restore a full backup.</p><button class="btn" data-workspace-replace>REPLACE FROM BACKUP…</button></details></section>
    <p role="status" data-file-status></p><input type="file" data-any-file hidden multiple accept=".tiksi,.json,${SCAN_ACCEPT},.c4d,.max,.ma,.mb,.rfa,.dwf,.mtl,.bin,.tga,.jpg,.jpeg,.png,.webp,.heic,.heif,.tif,.tiff,.avif"><input type="file" data-replace-file hidden accept=".json,.zip,.tiksi">`;
  document.body.append(dialog);dialog.showModal();dialog.addEventListener('close',()=>dialog.remove());
  const envHost=dialog.querySelector('[data-file-env]');
  if(currentName==='model')viewer3d.mountEnvironmentSettings(envHost);
  else {envHost.innerHTML='<button class="btn" data-open-model-settings>OPEN MODEL SETTINGS</button>';envHost.querySelector('button').onclick=()=>{dialog.close();history.replaceState(null,'','#/model');route();openFileMenu('settings');};}
  const status=dialog.querySelector('[data-file-status]'), on=(selector,fn)=>dialog.querySelector(selector).onclick=fn;
  const refresh=()=>{
    const st=filesState(),target=prop && saveTarget(prop.id);
    dialog.querySelector('[data-file-target]').textContent=target?'Saving to '+target.name:'Choose a file on first save. Cmd+S saves again; Cmd+O opens a project.';
    dialog.querySelector('[data-folder-label]').textContent=st.folderName || 'Optionally keep project files in a synced folder.';
    const own=prop&&projectFolder(prop.id);
    dialog.querySelector('[data-own-folder-label]').textContent=!prop?'Open a property to give it a folder of its own.':own?('Kept in '+own.name+(own.permitted?'. Only this project is written there.':', which needs permission again: LINK THIS PROJECT\'S FOLDER reconnects it.')):'Kept in the shared folder. A folder of its own keeps this project beside its other documents, for example in a Tiksi folder inside the project\'s folder.';
    const ownLink=dialog.querySelector('[data-own-folder-link]');ownLink.disabled=!FSA_DIR||!prop;ownLink.textContent=own&&!own.permitted?'RECONNECT THIS PROJECT\'S FOLDER':'LINK THIS PROJECT\'S FOLDER';
    dialog.querySelector('[data-own-folder-unlink]').disabled=!own;
    dialog.querySelector('[data-folder-link]').disabled=!FSA_DIR;dialog.querySelector('[data-folder-open]').disabled=!st.folder&&!(own&&own.permitted);dialog.querySelector('[data-folder-unlink]').disabled=!st.folder && !st.folderNeedsPermission;
    dialog.querySelector('[data-mirror-on]').checked=ws.data.settings.sketchupMirror!==false;dialog.querySelector('[data-mirror-label]').textContent=prop?mirrorStatus(prop.id):'';
  };
  const stopWatching=onFilesChange(refresh);dialog.addEventListener('close',stopWatching);
  let busy=false;
  const run=async fn=>{if(busy)return;busy=true;const disabled=Array.from(dialog.querySelectorAll('button')).filter(b=>!b.disabled);disabled.forEach(b=>b.disabled=true);dialog.oncancel=e=>e.preventDefault();try {status.textContent='Working…';await fn();status.textContent='Done.';refresh();}catch(e){status.textContent=e.message;}finally{busy=false;dialog.oncancel=null;disabled.forEach(b=>b.disabled=false);refresh();}};
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
    } else for(const file of files)type=await importAnyFile(file);ensureBuiltinMaterials();refreshTopbar();if(type==='model'&&currentName!=='model')location.hash='#/model';else if(type==='photo'&&currentName!=='photos')location.hash='#/photos';else remountView();dialog.close();});
  on('[data-new-property]',()=>{dialog.close();openNewPropertyDialog();});
  on('[data-polycam]',()=>{dialog.close();openNewPropertyDialog({into:prop?.id});});
  on('[data-photo3d]',()=>{dialog.close();location.hash='#/reconstruct';});
  dialog.querySelector('[data-file-units]').value=ws.data.settings.units;
  dialog.querySelector('[data-file-units]').onchange=e=>{ws.data.settings.units=e.target.value;touch();remountView();};
  on('[data-folder-link]',()=>run(()=>filesState().folderNeedsPermission?reconnectFolder(true):linkFolder()));
  dialog.querySelector('[data-mirror-on]').onchange=e=>{ws.data.settings.sketchupMirror=e.target.checked;touch();scheduleFolderSync(0);refresh();};
  on('[data-folder-open]',()=>openFolderList(dialog.querySelector('[data-folder-open]')));on('[data-folder-unlink]',()=>{unlinkFolder();refresh();});
  on('[data-own-folder-link]',()=>run(async()=>{await linkProjectFolder(prop);refreshTopbar();remountView();}));on('[data-own-folder-unlink]',()=>run(()=>unlinkProjectFolder(prop.id)));
  on('[data-workspace-save]',()=>run(runExportBundle));on('[data-storage]',()=>run(()=>offerStorageCleanup(false)));
  on('[data-demo]',()=>{mergeWorkspace(demoWorkspace());ensureBuiltinMaterials();refreshTopbar();remountView();dialog.close();});
  const replace=dialog.querySelector('[data-replace-file]');on('[data-workspace-replace]',()=>replace.click());
  replace.onchange=()=>run(async()=>{const file=replace.files[0];replace.value='';if(!file)return;
    if(!confirm('Replace the workspace with '+file.name+'? This is the explicit backup-restore action.'))return;
    if(/\.json$/i.test(file.name))replaceWorkspace(JSON.parse(await file.text()));else if(!await importBundle(file,{confirm:false}))return;
    afterWorkspaceReplaced();refreshTopbar();dialog.close();});
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
  sel.innerHTML = d.properties.map(p =>
    `<option value="${escapeHtml(p.id)}" ${active && p.id === active.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')
    || '<option value="">(no property)</option>';
  document.querySelectorAll('#units-seg .seg-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.units === d.settings.units));
  refreshSaveButton();
}

boot();
