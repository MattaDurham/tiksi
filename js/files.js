// Projects are files. This module gives the console a real Save: the active property, with
// its scope, products, custom materials, scans and photos, as one .tiksi file that opens
// anywhere. Three layers, each working without a server:
//
//   SAVE / SAVE AS   In Chrome and Edge the File System Access API writes to a file you
//                    chose once; every later Save is silent (Cmd+S). Elsewhere Save downloads.
//   PROJECT FOLDER   Pick a folder once (an iCloud Drive, Dropbox or OneDrive folder syncs it
//                    across machines) and every property is kept there as <name>.tiksi,
//                    rewritten a few seconds after each change. OPEN lists what the folder holds.
//                    A property can instead have a folder of its own: pick the project's folder
//                    and Tiksi keeps its files in a Tiksi folder inside it, beside the project's
//                    other documents. Only that property is written there.
//   OPEN             A picker, a drop on the window, a folder entry, or #/open?url=<file> for a
//                    project hosted anywhere that allows cross-origin reads.
//
// Browser autosave (localStorage + IndexedDB) stays as it was; this is the durable copy.
// With the local server and SketchUp available, the folder also keeps <name>.skp beside each
// project and the two stay connected both ways (sketchup-mirror.js).

import {
  ws, activeProperty, projectSlice, projectFileName, exportProjectBlob, importProject, readBundle, importBundle,
  putFile, getFile, deleteFile, handleKey, setSaveStatus, mergeWorkspace, replaceWorkspace, touch,
} from './store.js';
import { syncMirror, mirrorCapabilities, mirrorChangedOnDisk, MirrorBusy } from './sketchup-mirror.js';

export const FSA = typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function';
export const FSA_DIR = typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
const PICKER_TYPES = [{ description: 'tiksi project', accept: { 'application/zip': ['.tiksi', '.zip'] } }];
const OPEN_PICKER_TYPES = [{ description: 'tiksi project or workspace', accept: { 'application/zip': ['.tiksi', '.zip'], 'application/json': ['.json'] } }];
const FOLDER_MAP_KEY = 'tiksi.folder.v1';
const SYNC_DELAY_MS = 4000;

let app = { remount() {}, refresh() {}, afterReplace() {}, opened() {} };
export function initFiles(hooks) { app = Object.assign(app, hooks || {}); }

// ---------- state ----------
const state = {
  fileHandles: new Map(),   // propId -> FileSystemFileHandle (this session)
  savedSig: new Map(),      // propId -> signature at the last file/folder save
  folder: null,             // FileSystemDirectoryHandle when linked and permitted
  folderName: '',
  folderNeedsPermission: false,
  folderMap: {},            // propId -> { file, sig, mtime, own?, folderName?, shared? } persisted across sessions
  projectFolders: new Map(),   // propId -> { handle, name, permitted } for properties kept in a folder of their own
  syncTimer: null,
  syncing: false,
  conflicts: new Set(),     // propIds whose folder file is newer than what we last wrote
  mirror: { available: null, errors: new Map(), poll: null },   // SketchUp mirror (see below)
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
  const folder = folderOf(propId), entry = state.folderMap[propId];
  if (folder && entry && entry.file) return { kind: 'folder', name: entry.file, folder: folderLabel(propId) || folder.name };
  return null;
}

// The folder a property is kept in: its own folder when it has one, otherwise the shared
// project folder. A property with a folder of its own is never written to the shared folder,
// not even while its own folder waits for permission.
function folderOf(propId) {
  const own = state.projectFolders.get(propId);
  if (own) return own.permitted ? own.handle : null;
  return state.folder;
}
function anyFolder() {
  return !!state.folder || Array.from(state.projectFolders.values()).some(f => f.permitted);
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
  try { await w.write(blob); await w.close(); }
  catch (e) { if (typeof w.abort === 'function') { try { await w.abort(); } catch (ignored) {} } throw e; }
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
  let savedSig;
  const pack = async () => {
    savedSig = signatureOf(prop.id);
    setSaveStatus('PACKING', true);
    try { return await exportProjectBlob(prop.id); }
    catch (e) { setSaveStatus('SAVE FAILED', true); throw e; }
  };
  if (!FSA) {
    const out = await pack();
    download(out.blob, out.name);
    state.savedSig.set(prop.id, savedSig);
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
    state.savedSig.set(prop.id, savedSig);
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
  state.savedSig.set(prop.id, savedSig);
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
  let parsed;
  if (/\.json$/i.test(file.name)) {
    const data = JSON.parse(await file.text());
    if (!data || !Array.isArray(data.properties)) throw new Error('not a tiksi workspace file');
    parsed = { data, manifest: null };
  } else parsed = await readBundle(file);
  const { data, manifest } = parsed;
  const before = new Set(ws.data.properties.map(p => p.id));
  // Opening always adds/updates imported properties. Replacement is a separate explicit action.
  const ids = /\.json$/i.test(file.name) ? mergeWorkspace(data, { fromFile: true }) : await importProject(file);
  for (const id of ids) state.savedSig.set(id, signatureOf(id));
  app.refresh(); app.remount();
  setSaveStatus('OPENED ' + file.name.toUpperCase(), false);
  notify();
  try { app.opened({ ids, name: file.name, replaced: ids.filter(id => before.has(id)) }); } catch (e) { console.error(e); }
  return ids;
}

export async function openProjectPicker() {
  if (FSA) {
    let handles;
    try { handles = await window.showOpenFilePicker({ multiple: true, types: OPEN_PICKER_TYPES, id: 'tiksi-projects' }); }
    catch (e) { if (e && e.name === 'AbortError') return null; throw e; }
    const ids = [];
    for (const h of handles) {
      const file = await h.getFile();
      const got = await openFromFile(file);
      if (got) {
        ids.push(...got);
        // Opening a project file makes it the Save target for that property.
        // JSON is metadata, while SAVE produces a portable ZIP project. Never overwrite
        // an opened JSON file with archive bytes under its original .json name.
        if (got.length === 1 && !/\.json$/i.test(file.name) && (await ensurePermission(h, false))) {
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
    input.oncancel = () => { input.remove(); resolve(null); };
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
  state.folderMap = ownEntries(); saveFolderMap();
  try { await putFile(handleKey('folder'), null, { kind: 'handle', handle: dir }); } catch (e) { /* session only */ }
  notify();
  scheduleFolderSync(0);
  return dir;
}

export async function unlinkFolder() {
  state.folder = null; state.folderName = ''; state.folderNeedsPermission = false;
  state.folderMap = ownEntries(); saveFolderMap();
  for (const id of Array.from(state.conflicts)) if (!state.projectFolders.has(id)) state.conflicts.delete(id);
  try { await deleteFile(handleKey('folder')); } catch (e) { /* nothing */ }
  notify();
}

// Properties kept in folders of their own keep their records when the shared folder changes.
function ownEntries() {
  const kept = {};
  for (const [id, entry] of Object.entries(state.folderMap)) if (entry && entry.own) kept[id] = entry;
  return kept;
}

// On boot: find the remembered folders. Without a user gesture permissions can only be
// queried; when one is not granted, FILE > Settings offers to reconnect it (interactive).
export async function reconnectFolder(interactive) {
  loadFolderMap();
  const shared = await reconnectSharedFolder(interactive);
  const own = await reconnectProjectFolders(interactive);
  notify();
  if (shared || own) scheduleFolderSync(0);
  return shared || own;
}

async function reconnectSharedFolder(interactive) {
  let rec = null;
  try { rec = await getFile(handleKey('folder')); } catch (e) { /* no store */ }
  if (!rec || !rec.handle) return false;
  const dir = rec.handle;
  state.folderName = dir.name;
  if (await ensurePermission(dir, !!interactive)) {
    state.folder = dir; state.folderNeedsPermission = false;
    return true;
  }
  state.folder = null; state.folderNeedsPermission = true;
  return false;
}

async function reconnectProjectFolders(interactive, only) {
  let any = false;
  for (const [id, entry] of Object.entries(state.folderMap)) {
    if (!entry || !entry.own || (only && id !== only)) continue;
    const known = state.projectFolders.get(id);
    let root = (known && (known.root || known.handle)) || null;
    if (!root) { try { root = (await getFile(handleKey('folder:' + id)))?.handle || null; } catch (e) { /* no store */ } }
    // Without its handle the property stays unwritten until its folder is linked again.
    const permitted = !!root && await ensurePermission(root, !!interactive);
    let handle = root;
    if (permitted && entry.sub) { try { handle = await root.getDirectoryHandle(entry.sub, { create: true }); } catch (e) { handle = null; } }
    state.projectFolders.set(id, { handle, root, name: entry.folderName || (handle ? handle.name : ''), parentName: entry.parentName, permitted: permitted && !!handle });
    any = any || (permitted && !!handle);
  }
  return any;
}

// ---------- a project's own folder ----------
// { name, parentName, label, permitted } when the property is kept in a folder of its own, otherwise null.
export function projectFolder(propId) {
  const own = state.projectFolders.get(propId);
  return own ? { name: own.name, parentName: own.parentName || null, label: folderLabel(propId), permitted: own.permitted } : null;
}

// "68 Chatsworth › Tiksi" when Tiksi made its folder inside the one picked, else the folder's name.
export function folderLabel(propId) {
  const own = state.projectFolders.get(propId);
  if (!own) return '';
  return own.parentName ? own.parentName + ' \u203a ' + own.name : own.name;
}

// The folder Tiksi keeps a project in, given the folder that was picked: the picked folder itself
// when it is a Tiksi folder or already holds this project's file, otherwise a Tiksi folder inside
// it (made when missing), so the project's own documents stay beside Tiksi's files.
async function tiksiFolderIn(dir, prop) {
  if (/^tiksi$/i.test(dir.name)) return { folder: dir, sub: null };
  try { await dir.getFileHandle(projectFileName(prop)); return { folder: dir, sub: null }; }
  catch (e) { if (e.name !== 'NotFoundError' && e.name !== 'TypeMismatchError') throw e; }
  return { folder: await dir.getDirectoryHandle('Tiksi', { create: true }), sub: 'Tiksi' };
}

// Keep one property in a folder of its own. Pick the project's folder and Tiksi uses a Tiksi
// folder inside it (see tiksiFolderIn). Returns null when no folder was chosen. When the folder
// already holds the property's project file (a project moved there), `choose` decides whether to
// open it ('open') or keep this browser's copy ('keep'); keeping writes the browser copy beside it
// under a new name, so no file is overwritten.
export async function linkProjectFolder(prop, opts) {
  opts = opts || {};
  if (!FSA_DIR) throw new Error('This browser cannot keep a project folder (Chrome and Edge can). Use SAVE to write project files instead.');
  if (!prop) throw new Error('Open a property first.');
  const own = state.projectFolders.get(prop.id);
  if (own && (own.root || own.handle) && !own.permitted && !opts.pick) {
    if (await reconnectProjectFolders(true, prop.id)) { notify(); scheduleFolderSync(0); return state.projectFolders.get(prop.id).handle; }
  }
  let picked;
  try { picked = await window.showDirectoryPicker({ mode: 'readwrite', id: 'tiksi-project-folder' }); }
  catch (e) { if (e && e.name === 'AbortError') return null; throw e; }
  const { folder: dir, sub } = await tiksiFolderIn(picked, prop);
  const previous = state.folderMap[prop.id];
  const parentName = sub ? picked.name : undefined;
  state.projectFolders.set(prop.id, { handle: dir, root: picked, name: dir.name, parentName, permitted: true });
  state.folderMap[prop.id] = { own: true, folderName: dir.name, parentName, sub: sub || undefined, shared: previous && !previous.own ? previous : (previous && previous.shared) || undefined };
  state.conflicts.delete(prop.id);
  try { await putFile(handleKey('folder:' + prop.id), null, { kind: 'handle', handle: picked }); } catch (e) { /* session only */ }
  const existing = (await listFolder(dir)).find(en => en.name === projectFileName(prop));
  if (existing) {
    const choose = opts.choose || (en => (window.confirm(dir.name + ' already holds ' + en.name + ' (saved ' + new Date(en.lastModified).toLocaleString() + '). Open it?\n\nOK opens that file and replaces this browser\'s copy of ' + prop.name + '. Cancel keeps this browser\'s copy and saves it beside the file under a new name.') ? 'open' : 'keep'));
    if ((await choose(existing)) === 'open') { saveFolderMap(); notify(); await openFromFolder(existing, dir); return dir; }
  }
  saveFolderMap();
  notify();
  scheduleFolderSync(0);
  return dir;
}

// Back to the shared project folder. The files in the project's own folder stay where they are.
export async function unlinkProjectFolder(propId) {
  const entry = state.folderMap[propId];
  state.projectFolders.delete(propId);
  if (entry && entry.shared) state.folderMap[propId] = entry.shared;
  else delete state.folderMap[propId];
  state.conflicts.delete(propId);
  saveFolderMap();
  try { await deleteFile(handleKey('folder:' + propId)); } catch (e) { /* nothing */ }
  notify();
  scheduleFolderSync(0);
}

// Every .tiksi in a folder (the shared one by default):
// [{ name, size, lastModified, handle, folder, propId, inWorkspace }].
export async function listFolder(folder) {
  folder = folder || state.folder;
  if (!folder) return [];
  const out = [];
  for await (const [name, h] of folder.entries()) {
    if (h.kind !== 'file' || !/\.tiksi$/i.test(name)) continue;
    let f = null;
    try { f = await h.getFile(); } catch (e) { continue; }
    const propId = Object.keys(state.folderMap).find(id => state.folderMap[id].file === name && folderOf(id) === folder);
    out.push({ name, size: f.size, lastModified: f.lastModified, handle: h, folder, propId: propId || null, inWorkspace: !!(propId && ws.data.properties.some(p => p.id === propId)) });
  }
  out.sort((a, b) => b.lastModified - a.lastModified);
  return out;
}

// Open a listed file and keep that property in the folder it came from.
export async function openFromFolder(entry, folder) {
  folder = folder || entry.folder || state.folder;
  const file = await entry.handle.getFile();
  const ids = await openFromFile(file);
  if (ids && ids.length === 1) {
    const id = ids[0], record = { file: entry.name, sig: signatureOf(id), mtime: file.lastModified };
    const before = state.folderMap[id];
    if (folder !== state.folder) {
      // Opened from a project's own folder: the property is kept there from now on. When that is
      // the folder it is already linked to, keep how it was reached (a Tiksi folder inside the pick).
      const same = state.projectFolders.get(id)?.handle === folder && before && before.own;
      state.folderMap[id] = Object.assign(record, { own: true, folderName: folder.name, parentName: same ? before.parentName : undefined, sub: same ? before.sub : undefined,
        shared: before && !before.own ? before : before && before.shared });
      if (state.projectFolders.get(id)?.handle !== folder) {
        state.projectFolders.set(id, { handle: folder, name: folder.name, permitted: true });
        try { await putFile(handleKey('folder:' + id), null, { kind: 'handle', handle: folder }); } catch (e) { /* session only */ }
      }
    } else if (before && before.own) before.shared = record;   // it stays in its own folder
    else state.folderMap[id] = record;
    saveFolderMap();
    state.conflicts.delete(id);
    notify();
    scheduleFolderSync();
  }
  return ids;
}

// Called on every workspace change; writes changed properties a few seconds later.
export function scheduleFolderSync(delay) {
  if (!anyFolder()) return;
  clearTimeout(state.syncTimer);
  state.syncTimer = setTimeout(() => { syncFolder().catch(e => { setSaveStatus('FOLDER SAVE FAILED', true); console.error('folder sync failed', e); }); }, delay == null ? SYNC_DELAY_MS : delay);
}

export async function syncFolder() {
  if (!anyFolder() || state.syncing) return;
  state.syncing = true;
  let wrote = 0, mirrored = 0;
  startMirrorPoll();
  try {
    if (state.folder && !(await ensurePermission(state.folder, false))) { state.folder = null; state.folderNeedsPermission = true; notify(); }
    for (const own of state.projectFolders.values()) {
      if (own.permitted && !(await ensurePermission(own.root || own.handle, false))) { own.permitted = false; notify(); }
    }
    if (!anyFolder()) return;
    const mirrorOn = await mirrorEnabled();
    for (const prop of ws.data.properties) {
      // Each property is written only to its own folder, or to the shared one when it has none.
      const folder = folderOf(prop.id);
      if (!folder) continue;
      const sig = signatureOf(prop.id);
      const entry = state.folderMap[prop.id];
      const wanted = (await uniqueName(prop, entry && entry.file, folder));
      if (!(entry && entry.sig === sig && entry.file === wanted)) {
        // Someone else (another machine, through the synced folder) wrote a newer file: keep
        // theirs, flag it, and let OPEN FROM FOLDER pull it in on purpose.
        if (entry && entry.file) {
          try {
            const h = await folder.getFileHandle(entry.file);
            const f = await h.getFile();
            if (entry.mtime && f.lastModified !== entry.mtime) { state.conflicts.add(prop.id); continue; }
          } catch (e) { if (e.name !== 'NotFoundError') throw e; /* file gone: write it again */ }
        }
        const out = await exportProjectBlob(prop.id);
        if (folderOf(prop.id) !== folder) continue;   // relinked while packing
        const h = await folder.getFileHandle(wanted, { create: true });
        await writeHandle(h, out.blob);
        const f = await h.getFile();
        if (entry && entry.file && entry.file !== wanted) { try { await folder.removeEntry(entry.file); } catch (e) { /* renamed copy stays */ } }
        state.folderMap[prop.id] = Object.assign({}, entry, { file: wanted, sig, mtime: f.lastModified });
        state.savedSig.set(prop.id, sig);
        state.conflicts.delete(prop.id);
        wrote++;
      }
      if (mirrorOn && await mirrorProperty(prop, folder)) mirrored++;
    }
    saveFolderMap();
    if (wrote || mirrored) {
      const t = new Date();
      setSaveStatus((mirrored ? 'FROM SKETCHUP ' : 'FOLDER ') + String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0'), false);
    }
    if (mirrored) { app.refresh(); app.remount(); }
  } finally {
    state.syncing = false;
    notify();
    if (wrote && ws.data.properties.some(p => folderOf(p.id) && (!state.folderMap[p.id] || state.folderMap[p.id].sig !== signatureOf(p.id)))) scheduleFolderSync();
  }
}

// ---------- SketchUp mirror ----------
// On by default wherever it can run: a linked folder, the local server, SketchUp installed.
async function mirrorEnabled() {
  if (ws.data.settings.sketchupMirror === false) return false;
  const cap = await mirrorCapabilities();
  state.mirror.available = !!cap.mirror;
  return state.mirror.available;
}

// Returns true when SketchUp edits were merged into the property.
async function mirrorProperty(prop, folder) {
  const entry = state.folderMap[prop.id];
  if (!entry) return false;
  try {
    const { changed } = await syncMirror(folder, prop, entry, writeHandle);
    state.mirror.errors.delete(prop.id);
    if (changed) touch();
    return changed;
  } catch (e) {
    if (e instanceof MirrorBusy) { scheduleFolderSync(); return false; }   // a model conversion is running
    state.mirror.errors.set(prop.id, e && e.message || String(e));
    console.error('SketchUp mirror failed', e);
    return false;
  }
}

// A .skp saved in SketchUp shows up as a new modification time; look every few seconds.
function startMirrorPoll() {
  if (state.mirror.poll) return;
  state.mirror.poll = setInterval(async () => {
    if (!anyFolder()) { clearInterval(state.mirror.poll); state.mirror.poll = null; return; }
    if (state.syncing || !state.mirror.available || ws.data.settings.sketchupMirror === false) return;
    for (const prop of ws.data.properties) {
      const folder = folderOf(prop.id);
      if (!folder) continue;
      try { if (await mirrorChangedOnDisk(folder, state.folderMap[prop.id])) { scheduleFolderSync(0); return; } }
      catch (e) { /* the next tick tries again */ }
    }
  }, 4000);
}

export function mirrorStatus(propId) {
  if (ws.data.settings.sketchupMirror === false) return 'SketchUp mirror is off.';
  const own = state.projectFolders.get(propId);
  if (own && !own.permitted) return 'SketchUp mirror waits for this project\'s folder (' + folderLabel(propId) + ') to be reconnected.';
  if (!folderOf(propId)) return 'Choose a folder for this project to keep a SketchUp mirror (.skp) beside it.';
  if (state.mirror.available === false) return 'SketchUp mirror needs the local Tiksi server on a Mac with SketchUp installed.';
  if (state.mirror.errors.has(propId)) return 'SketchUp mirror: ' + state.mirror.errors.get(propId);
  const ms = state.folderMap[propId] && state.folderMap[propId].mirror;
  if (!ms || !ms.file) return 'SketchUp mirror: written with the next folder save.';
  const hm = t => { const d = new Date(t); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
  let text = 'SketchUp mirror: ' + ms.file + (ms.at ? ', written ' + hm(ms.at) : '') + '.';
  const r = ms.report;
  if (r) {
    text += ' Last SketchUp save (' + hm(r.at) + '): ' + r.applied + ' changed, ' + r.added + ' added, ' + r.deleted + ' deleted';
    if (r.conflicts && r.conflicts.length) text += ', ' + r.conflicts.length + ' conflict' + (r.conflicts.length === 1 ? '' : 's') + ' kept the Tiksi version';
    text += '.';
    if (r.untagged && (r.untagged.faces || r.untagged.groups || r.untagged.instances)) text += ' Geometry drawn outside Tiksi groups stays in SketchUp only.';
  }
  return text;
}

// <name>.tiksi, or <name> (2).tiksi when another property or file already owns that name in the folder.
async function uniqueName(prop, current, folder) {
  folder = folder || state.folder;
  const base = projectFileName(prop);
  const taken = new Set(Object.keys(state.folderMap).filter(id => id !== prop.id && folderOf(id) === folder).map(id => state.folderMap[id].file));
  const available = async name => {
    if (taken.has(name)) return false;
    if (name === current) return true;
    try { await folder.getFileHandle(name); return false; }
    catch (e) { if (e.name === 'NotFoundError') return true; throw e; }
  };
  if (await available(base)) return base;
  if (current && current.startsWith(base.replace(/\.tiksi$/, '')) && !taken.has(current)) return current;
  for (let n = 2; ; n++) {
    const alt = base.replace(/\.tiksi$/, ' (' + n + ').tiksi');
    if (await available(alt)) return alt;
  }
}

// ---------- window-level intake ----------
export function bindFileIntake(intake) {
  const hasFiles = e => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  const isProjectFile = f => /\.(tiksi|zip|json)$/i.test(f.name);
  window.addEventListener('dragover', e => {
    if (!hasFiles(e)) return;
    const f = e.dataTransfer.items && e.dataTransfer.items[0];
    if (f && f.kind === 'file') { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }
  });
  window.addEventListener('drop', async e => {
    if (!hasFiles(e) || e.defaultPrevented || document.querySelector('dialog[open], .modal-backdrop')) return;
    const files = Array.from(e.dataTransfer.files).filter(f => intake || isProjectFile(f));
    if (!files.length) return;
    e.preventDefault();
    try { for (const f of files) await (intake ? intake(f) : openFromFile(f)); app.refresh(); app.remount(); }
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
