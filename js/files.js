// Projects are files. This module gives the console a real Save: the active property, with
// its scope, products, custom materials, scans and photos, as one .tiksi file that opens
// anywhere. Three layers, each working without a server:
//
//   SAVE / SAVE AS   In Chrome and Edge the File System Access API writes to a file you
//                    chose once; every later Save is silent (Cmd+S). Elsewhere Save downloads.
//   PROJECT FOLDER   Pick a folder once (an iCloud Drive, Dropbox or OneDrive folder syncs it
//                    across machines) and every property is kept there as <name>.tiksi,
//                    rewritten a few seconds after each change. OPEN lists what the folder holds.
//   OPEN             A picker, a drop on the window, a folder entry, or #/open?url=<file> for a
//                    project hosted anywhere that allows cross-origin reads.
//
// Browser autosave (localStorage + IndexedDB) stays as it was; this is the durable copy.

import {
  ws, activeProperty, projectSlice, projectFileName, exportProjectBlob, importProject, readBundle, importBundle,
  putFile, getFile, deleteFile, handleKey, setSaveStatus,
} from './store.js';

export const FSA = typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function';
export const FSA_DIR = typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
const PICKER_TYPES = [{ description: 'tiksi project', accept: { 'application/zip': ['.tiksi', '.zip'] } }];
const FOLDER_MAP_KEY = 'tiksi.folder.v1';
const SYNC_DELAY_MS = 4000;

let app = { remount() {}, refresh() {}, afterReplace() {} };
export function initFiles(hooks) { app = Object.assign(app, hooks || {}); }

// ---------- state ----------
const state = {
  fileHandles: new Map(),   // propId -> FileSystemFileHandle (this session)
  savedSig: new Map(),      // propId -> signature at the last file/folder save
  folder: null,             // FileSystemDirectoryHandle when linked and permitted
  folderName: '',
  folderNeedsPermission: false,
  folderMap: {},            // propId -> { file, sig, mtime } persisted across sessions
  syncTimer: null,
  syncing: false,
  conflicts: new Set(),     // propIds whose folder file is newer than what we last wrote
  listeners: new Set(),
};
export function filesState() { return state; }
export function onFilesChange(fn) { state.listeners.add(fn); return () => state.listeners.delete(fn); }
function notify() { for (const fn of state.listeners) { try { fn(); } catch (e) { console.error(e); } } }

function loadFolderMap() {
  try { state.folderMap = JSON.parse(localStorage.getItem(FOLDER_MAP_KEY) || '{}') || {}; } catch (e) { state.folderMap = {}; }
}
function saveFolderMap() {
  try { localStorage.setItem(FOLDER_MAP_KEY, JSON.stringify(state.folderMap)); } catch (e) { /* not fatal */ }
}

// A cheap signature of what a project file would contain, so unchanged properties are not
// rewritten and the SAVE button can show that a file is behind the browser copy.
export function signatureOf(propId) {
  const slice = projectSlice(propId);
  if (!slice) return '';
  const s = JSON.stringify(slice);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36) + ':' + s.length;
}
export function isDirty(propId) {
  const sig = state.savedSig.get(propId) || (state.folderMap[propId] && state.folderMap[propId].sig);
  return !sig || sig !== signatureOf(propId);
}
export function saveTarget(propId) {
  if (state.fileHandles.has(propId)) return { kind: 'file', name: state.fileHandles.get(propId).name };
  if (state.folder && state.folderMap[propId]) return { kind: 'folder', name: state.folderMap[propId].file };
  return null;
}

// ---------- permissions ----------
async function ensurePermission(handle, interactive) {
  if (!handle || !handle.queryPermission) return true;
  const opts = { mode: 'readwrite' };
  try {
    if ((await handle.queryPermission(opts)) === 'granted') return true;
    if (!interactive) return false;
    return (await handle.requestPermission(opts)) === 'granted';
  } catch (e) { return false; }
}

async function writeHandle(handle, blob) {
  const w = await handle.createWritable();
  try { await w.write(blob); } finally { await w.close(); }
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- save ----------
// Save the property as a project file. With the File System Access API the first Save asks
// where; later Saves write there silently (the handle is remembered in IndexedDB across
// sessions, permission permitting). opts.as forces the picker. Elsewhere it downloads.
export async function saveProject(prop, opts) {
  opts = opts || {};
  prop = prop || activeProperty();
  if (!prop) return null;
  const pack = async () => {
    setSaveStatus('PACKING', true);
    try { return await exportProjectBlob(prop.id); }
    catch (e) { setSaveStatus('SAVE FAILED', true); throw e; }
  };
  if (!FSA) {
    const out = await pack();
    download(out.blob, out.name);
    state.savedSig.set(prop.id, signatureOf(prop.id));
    setSaveStatus('DOWNLOADED ' + out.name.toUpperCase(), false);
    notify();
    return { via: 'download', name: out.name, bytes: out.bytes };
  }
  // The picker needs the click's user activation, which packing a large scan would outlive:
  // ask where first, pack second.
  let handle = opts.as ? null : (state.fileHandles.get(prop.id) || await rememberedHandle(prop.id));
  if (handle && !(await ensurePermission(handle, true))) handle = null;
  let pickerFailed = null;
  if (!handle) {
    try {
      handle = await window.showSaveFilePicker({ suggestedName: projectFileName(prop), types: PICKER_TYPES, id: 'tiksi-projects' });
    } catch (e) {
      if (e && e.name === 'AbortError') { setSaveStatus('SAVED', false); return null; }
      pickerFailed = e;
    }
  }
  const out = await pack();
  if (!handle) {
    console.warn('save picker unavailable, downloading instead', pickerFailed);
    download(out.blob, out.name);
    state.savedSig.set(prop.id, signatureOf(prop.id));
    setSaveStatus('DOWNLOADED ' + out.name.toUpperCase(), false);
    notify();
    return { via: 'download', name: out.name, bytes: out.bytes };
  }
  if (!state.fileHandles.has(prop.id) || state.fileHandles.get(prop.id) !== handle) {
    state.fileHandles.set(prop.id, handle);
    try { await putFile(handleKey(prop.id), null, { kind: 'handle', handle }); } catch (e) { /* remembered for this session only */ }
  }
  try {
    setSaveStatus('WRITING', true);
    await writeHandle(handle, out.blob);
  } catch (e) {
    setSaveStatus('SAVE FAILED', true);
    throw new Error('Could not write ' + handle.name + ': ' + (e && e.message || e));
  }
  state.savedSig.set(prop.id, signatureOf(prop.id));
  const t = new Date();
  setSaveStatus('SAVED ' + handle.name.toUpperCase() + ' ' + String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0'), false);
  notify();
  return { via: 'file', name: handle.name, bytes: out.bytes };
}

async function rememberedHandle(propId) {
  try {
    const rec = await getFile(handleKey(propId));
    if (rec && rec.handle) { state.fileHandles.set(propId, rec.handle); return rec.handle; }
  } catch (e) { /* no handle */ }
  return null;
}

// ---------- open ----------
export async function openFromFile(file) {
  const { data, manifest } = await readBundle(file);
  const isProject = manifest && manifest.format === 'tiksi-project';
  if (!isProject && data.properties.length > 1) {
    // A whole-workspace bundle: the existing IMPORT semantics (replace, after asking) apply.
    const ok = await importBundle(file);
    if (ok) app.afterReplace();
    return ok ? data.properties.map(p => p.id) : null;
  }
  const ids = await importProject(file);
  for (const id of ids) state.savedSig.set(id, signatureOf(id));
  app.refresh(); app.remount();
  setSaveStatus('OPENED ' + file.name.toUpperCase(), false);
  notify();
  return ids;
}

export async function openProjectPicker() {
  if (FSA) {
    let handles;
    try { handles = await window.showOpenFilePicker({ multiple: true, types: PICKER_TYPES, id: 'tiksi-projects' }); }
    catch (e) { if (e && e.name === 'AbortError') return null; throw e; }
    const ids = [];
    for (const h of handles) {
      const file = await h.getFile();
      const got = await openFromFile(file);
      if (got) {
        ids.push(...got);
        // Opening a project file makes it the Save target for that property.
        if (got.length === 1 && (await ensurePermission(h, false))) {
          state.fileHandles.set(got[0], h);
          try { await putFile(handleKey(got[0]), null, { kind: 'handle', handle: h }); } catch (e) { /* session only */ }
        }
      }
    }
    return ids;
  }
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.tiksi,.zip,.json'; input.multiple = true; input.hidden = true;
    document.body.appendChild(input);
    input.onchange = async () => {
      const ids = [];
      try { for (const f of input.files) { const got = await openFromFile(f); if (got) ids.push(...got); } }
      catch (e) { alert('Open failed: ' + (e && e.message || e)); }
      input.remove();
      resolve(ids);
    };
    input.click();
  });
}

// #/open?url=<project file>. The host must allow cross-origin reads (GitHub raw and gist
// URLs, Dropbox direct links and most object storage do).
export async function openFromUrl(url) {
  setSaveStatus('FETCHING', true);
  let res;
  try { res = await fetch(url, { mode: 'cors', credentials: 'omit' }); }
  catch (e) { setSaveStatus('OPEN FAILED', true); throw new Error('Could not fetch ' + url + ' (the host must allow cross-origin reads).'); }
  if (!res.ok) { setSaveStatus('OPEN FAILED', true); throw new Error('Fetching ' + url + ' failed (' + res.status + ').'); }
  const blob = await res.blob();
  const name = decodeURIComponent((url.split('?')[0].split('/').pop() || 'project.tiksi'));
  const file = new File([blob], name, { type: blob.type || 'application/zip' });
  return openFromFile(file);
}

// ---------- project folder ----------
export async function linkFolder() {
  if (!FSA_DIR) throw new Error('This browser cannot keep a project folder (Chrome and Edge can). Use SAVE to write project files instead.');
  let dir;
  try { dir = await window.showDirectoryPicker({ mode: 'readwrite', id: 'tiksi-folder' }); }
  catch (e) { if (e && e.name === 'AbortError') return null; throw e; }
  state.folder = dir; state.folderName = dir.name; state.folderNeedsPermission = false;
  state.folderMap = {}; saveFolderMap();
  try { await putFile(handleKey('folder'), null, { kind: 'handle', handle: dir }); } catch (e) { /* session only */ }
  notify();
  scheduleFolderSync(0);
  return dir;
}

export async function unlinkFolder() {
  state.folder = null; state.folderName = ''; state.folderNeedsPermission = false;
  state.folderMap = {}; saveFolderMap();
  state.conflicts.clear();
  try { await deleteFile(handleKey('folder')); } catch (e) { /* nothing */ }
  notify();
}

// On boot: find the remembered folder. Without a user gesture the permission can only be
// queried; when it is not granted the topbar offers RECONNECT, which calls this with interactive.
export async function reconnectFolder(interactive) {
  loadFolderMap();
  let rec = null;
  try { rec = await getFile(handleKey('folder')); } catch (e) { /* no store */ }
  if (!rec || !rec.handle) return false;
  const dir = rec.handle;
  state.folderName = dir.name;
  if (await ensurePermission(dir, !!interactive)) {
    state.folder = dir; state.folderNeedsPermission = false;
    notify();
    scheduleFolderSync(0);
    return true;
  }
  state.folder = null; state.folderNeedsPermission = true;
  notify();
  return false;
}

// Every .tiksi in the folder: [{ name, size, lastModified, handle, inWorkspace }].
export async function listFolder() {
  if (!state.folder) return [];
  const out = [];
  for await (const [name, h] of state.folder.entries()) {
    if (h.kind !== 'file' || !/\.tiksi$/i.test(name)) continue;
    let f = null;
    try { f = await h.getFile(); } catch (e) { continue; }
    const propId = Object.keys(state.folderMap).find(id => state.folderMap[id].file === name);
    out.push({ name, size: f.size, lastModified: f.lastModified, handle: h, propId: propId || null, inWorkspace: !!(propId && ws.data.properties.some(p => p.id === propId)) });
  }
  out.sort((a, b) => b.lastModified - a.lastModified);
  return out;
}

export async function openFromFolder(entry) {
  const file = await entry.handle.getFile();
  const ids = await openFromFile(file);
  if (ids && ids.length === 1) {
    state.folderMap[ids[0]] = { file: entry.name, sig: signatureOf(ids[0]), mtime: file.lastModified };
    saveFolderMap();
    state.conflicts.delete(ids[0]);
    notify();
  }
  return ids;
}

// Called on every workspace change; writes changed properties a few seconds later.
export function scheduleFolderSync(delay) {
  if (!state.folder) return;
  clearTimeout(state.syncTimer);
  state.syncTimer = setTimeout(() => { syncFolder().catch(e => console.error('folder sync failed', e)); }, delay == null ? SYNC_DELAY_MS : delay);
}

export async function syncFolder() {
  if (!state.folder || state.syncing) return;
  state.syncing = true;
  let wrote = 0;
  try {
    if (!(await ensurePermission(state.folder, false))) { state.folder = null; state.folderNeedsPermission = true; notify(); return; }
    for (const prop of ws.data.properties) {
      const sig = signatureOf(prop.id);
      const entry = state.folderMap[prop.id];
      const wanted = (await uniqueName(prop, entry && entry.file));
      if (entry && entry.sig === sig && entry.file === wanted) continue;
      // Someone else (another machine, through the synced folder) wrote a newer file: keep
      // theirs, flag it, and let OPEN FROM FOLDER pull it in on purpose.
      if (entry && entry.file === wanted) {
        try {
          const h = await state.folder.getFileHandle(entry.file);
          const f = await h.getFile();
          if (entry.mtime && f.lastModified > entry.mtime + 2000) { state.conflicts.add(prop.id); continue; }
        } catch (e) { /* file gone: write it again */ }
      }
      const out = await exportProjectBlob(prop.id);
      const h = await state.folder.getFileHandle(wanted, { create: true });
      await writeHandle(h, out.blob);
      const f = await h.getFile();
      if (entry && entry.file !== wanted) { try { await state.folder.removeEntry(entry.file); } catch (e) { /* renamed copy stays */ } }
      state.folderMap[prop.id] = { file: wanted, sig, mtime: f.lastModified };
      state.savedSig.set(prop.id, sig);
      state.conflicts.delete(prop.id);
      wrote++;
    }
    saveFolderMap();
    if (wrote) {
      const t = new Date();
      setSaveStatus('FOLDER ' + String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0'), false);
    }
  } finally {
    state.syncing = false;
    notify();
  }
}

// <name>.tiksi, or <name> (2).tiksi when another property already owns that file name.
async function uniqueName(prop, current) {
  const base = (await import('./store.js')).projectFileName(prop);
  const taken = new Set(Object.keys(state.folderMap).filter(id => id !== prop.id).map(id => state.folderMap[id].file));
  if (!taken.has(base)) return base;
  if (current && current.startsWith(base.replace(/\.tiksi$/, ''))) return current;
  for (let n = 2; n < 100; n++) { const alt = base.replace(/\.tiksi$/, ' (' + n + ').tiksi'); if (!taken.has(alt)) return alt; }
  return base;
}

// ---------- window-level intake ----------
export function bindFileIntake() {
  const hasFiles = e => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  const isProjectFile = f => /\.(tiksi|zip|json)$/i.test(f.name);
  window.addEventListener('dragover', e => {
    if (!hasFiles(e)) return;
    const f = e.dataTransfer.items && e.dataTransfer.items[0];
    if (f && f.kind === 'file') { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }
  });
  window.addEventListener('drop', async e => {
    if (!hasFiles(e)) return;
    const files = Array.from(e.dataTransfer.files).filter(isProjectFile);
    if (!files.length) return;
    e.preventDefault();
    try { for (const f of files) await openFromFile(f); }
    catch (err) { alert('Open failed: ' + (err && err.message || err)); }
  });
  window.addEventListener('keydown', e => {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    const k = e.key.toLowerCase();
    if (k === 's') { e.preventDefault(); saveProject(activeProperty(), { as: e.shiftKey }).catch(err => alert(err.message)); }
    else if (k === 'o' && !e.shiftKey) { e.preventDefault(); openProjectPicker().catch(err => alert(err.message)); }
  });
}
