// The Mac's project files are authoritative. Browser state is an in-memory working
// copy; legacy browser stores are read once and removed only after a disk save.
import { ws, emptyWorkspace, replaceWorkspace, onChange, touch, whenHydrated, projectSlice, listAllFileIds, storedFileIds, getCachedFile, cacheFile, setFileBackend, useDiskPersistence, finishBrowserMigration, setSaveStatus } from './store.js';
import { mergeShared } from './workspace-merge.js';
import { syncMirror, mirrorCapabilities } from './sketchup-mirror.js';

export let diskWorkspace = null;
const copy = value => JSON.parse(JSON.stringify(value));

export function prepareDiskProjects(data) {
  const prepared = copy(data);
  // Portable project files carry the photos needed by their custom materials,
  // including a source sampled in another project. Make that evidence explicit
  // in the shared records too, so disk reload and connected clients agree.
  for (const prop of prepared.properties) prop.photos = projectSlice(prop.id, prepared).properties[0].photos;
  return { data: prepared, projectData: Object.fromEntries(prepared.properties.map(p => [p.id, projectSlice(p.id, prepared)])) };
}

export async function connectDiskWorkspace({ hadLocal, onRemote }) {
  if (document.querySelector('meta[name="tiksi-storage"]')?.content !== 'project-files') return null;
  const headers = { 'X-Tiksi-Workspace': '1' };
  let cap;
  const response = await fetch('/api/workspace/capabilities', { headers, cache: 'no-store', signal: AbortSignal.timeout(10000) });
  // A server/network failure never changes a disk-backed installation into a
  // separate browser store. Only explicitly portable HTML uses static mode.
  if (!response.ok) throw new Error('Project-file server unavailable (' + response.status + ')');
  cap = await response.json();
  headers['X-Tiksi-Token'] = cap.token;
  let rawLegacy = null, probedIds = null;
  try { rawLegacy = localStorage.getItem('tiksi.workspace.v1'); } catch (ignored) {}
  let hasLegacyDatabase = false;
  try {
    if (typeof indexedDB.databases === 'function') hasLegacyDatabase = (await indexedDB.databases()).some(d => d.name === 'tiksi-files');
    else { probedIds = await storedFileIds(); hasLegacyDatabase = probedIds.length > 0; }
  } catch (ignored) {}
  const needsMigration = hadLocal || rawLegacy !== null || hasLegacyDatabase;
  let applying = false, pending = false, running = null, timer, base, revision = 0, paths = {}, assets = {}, migration = needsMigration, cleanupNotice = false;
  const changedFiles = new Set(), inFlightFiles = new Map();
  async function request(path = '', options = {}) {
    const r = await fetch('/api/workspace' + path, { ...options, headers: { ...headers, ...(options.headers || {}) }, cache: 'no-store', signal: AbortSignal.timeout(120000) });
    if (r.status === 403) {
      const refreshed = await fetch('/api/workspace/capabilities', { headers: { 'X-Tiksi-Workspace': '1' }, cache: 'no-store', signal: AbortSignal.timeout(10000) });
      if (!refreshed.ok) throw new Error('Project-file server unavailable');
      cap = await refreshed.json(); headers['X-Tiksi-Token'] = cap.token;
      throw new Error('Reconnected to project files; retrying');
    }
    if (!r.ok) {
      let message = 'Project-file request failed (' + r.status + ')';
      try { message = (await r.json()).error || message; } catch (ignored) {}
      const error = new Error(message); error.status = r.status; throw error;
    }
    return r;
  }
  function status(text, busy = false) { setSaveStatus(text, busy); }
  function changed() {
    if (applying) return;
    pending = true; status('SAVING TO DISK', true);
    clearTimeout(timer); timer = setTimeout(() => sync().catch(failed), 700);
  }
  function failed(error) {
    pending = true;
    status('NOT SAVED TO DISK — RETRYING', true);
    console.error('project-file sync:', error);
  }
  async function read(id, local) {
    const remote = assets[id];
    if (!remote || changedFiles.has(id) || local?.sharedHash === remote.hash) return local;
    const key = id + ':' + remote.hash;
    if (!inFlightFiles.has(key)) inFlightFiles.set(key, (async () => {
      const r = await request('/blobs/' + remote.hash);
      const buffer = await r.arrayBuffer();
      if (buffer.byteLength !== remote.size) throw new Error('Project asset download was truncated');
      const value = { id, buffer, name: remote.name, format: remote.format, kind: remote.kind, mime: remote.mime, sharedHash: remote.hash };
      if (assets[id]?.hash === remote.hash && !changedFiles.has(id)) await cacheFile(id, buffer, value);
      return value;
    })().finally(() => inFlightFiles.delete(key)));
    return inFlightFiles.get(key);
  }
  async function fileManifest(data, starting, identifiers = listAllFileIds(data)) {
    const out = {};
    for (const id of new Set(identifiers)) {
      const local = await getCachedFile(id);
      if (starting[id] && !changedFiles.has(id) && (!migration || !local?.buffer)) { out[id] = starting[id]; continue; }
      if (!local?.buffer) { if (starting[id]) out[id] = starting[id]; continue; }
      const uploaded = await (await request('/blobs', { method: 'POST', body: local.buffer })).json();
      out[id] = { ...uploaded };
      for (const k of ['name', 'format', 'kind', 'mime']) if (typeof local[k] === 'string') out[id][k] = local[k];
      // A later replacement must remain dirty while this upload is in progress.
      const now = await getCachedFile(id);
      if (now?.buffer === local.buffer) { changedFiles.delete(id); await cacheFile(id, local.buffer, { ...local, sharedHash: uploaded.hash }); }
    }
    return out;
  }
  async function apply(data) {
    applying = true;
    try { replaceWorkspace(data); await whenHydrated(); onRemote?.(); }
    finally { applying = false; }
  }
  async function resolveMerge(ancestor, local, remote) {
    let result = mergeShared(ancestor, local, remote);
    if (!result.conflicts.length) return result.value;
    status('PROJECT COPIES NEED REVIEW', true);
    // No side is discarded: old browser bytes stay until migration succeeds,
    // and each overwritten disk revision is retained by the server.
    const dialog = document.createElement('dialog'); dialog.className = 'file-dialog';
    dialog.innerHTML = '<h2>Project copies differ</h2><p>This device and the Mac contain different edits to the same records. Both copies are preserved until you choose which values to use. Changes to other records will be combined.</p><p data-count></p><div class="file-actions"><button class="btn primary" data-mac>USE MAC VALUES</button><button class="btn" data-local>USE THIS DEVICE’S VALUES</button></div>';
    dialog.querySelector('[data-count]').textContent = result.conflicts.length + ' conflicting values';
    document.body.append(dialog); dialog.showModal();
    const choice = await new Promise(resolve => {
      dialog.addEventListener('cancel', e => e.preventDefault());
      dialog.querySelector('[data-mac]').onclick = () => resolve('mac');
      dialog.querySelector('[data-local]').onclick = () => resolve('local');
    });
    dialog.close(); dialog.remove();
    if (choice === 'mac') result = mergeShared(ancestor, remote, local);
    return result.value;
  }
  async function cleanupMigration() {
    try { await finishBrowserMigration(); cleanupNotice = false; }
    catch (error) { cleanupNotice = true; console.warn(error); }
  }
  async function cycle() {
    await whenHydrated();
    const head = await (await request('/head')).json();
    if (!pending && head.revision === revision) {
      if (cleanupNotice) {
        await cleanupMigration();
        status(cleanupNotice ? 'SAVED TO DISK — CLOSE OLDER TIKSI TABS' : 'SAVED TO DISK', cleanupNotice);
      }
      return;
    }
    const remote = await (await request()).json();
    paths = remote.paths || {};
    if (!pending && remote.data) {
      revision = remote.revision; assets = remote.assets; base = { data: copy(remote.data), assets: copy(assets) };
      await apply(remote.data); status('SAVED TO DISK'); return;
    }
    const sentData = copy(ws.data);
    const sentAssets = await fileManifest(sentData, assets);
    if (migration && !migrationPack) migrationPack = { data: legacyRecovery, assets: await fileManifest(legacyRecovery, {}, legacyIds) };
    const local = { data: sentData, assets: sentAssets };
    const accepted = remote.data ? await resolveMerge(base, local, { data: remote.data, assets: remote.assets }) : local;
    const prepared = prepareDiskProjects(accepted.data);
    accepted.data = prepared.data;
    const projectData = prepared.projectData;
    const saved = await (await request('', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: remote.revision, ...accepted, projectData, migration: migrationPack }) })).json();
    revision = saved.revision; assets = accepted.assets; base = copy(accepted);
    const after = mergeShared(sentData, ws.data, accepted.data);
    pending = JSON.stringify(after.value) !== JSON.stringify(accepted.data) || listAllFileIds(after.value).some(id => changedFiles.has(id));
    await apply(after.value);
    paths = (await (await request()).json()).paths || {};
    if (migration) {
      // All originals must be on disk before removing their last browser copy.
      migration = false; migrationPack = null;
      await cleanupMigration();
    }
    status(cleanupNotice ? 'SAVED TO DISK — CLOSE OLDER TIKSI TABS' : pending ? 'SAVING TO DISK' : 'SAVED TO DISK', pending || cleanupNotice);
  }
  async function sync() {
    if (running) return running;
    running = (async () => {
      for (let round = 0; round < 4; round++) { await cycle(); if (!pending) return; }
      throw new Error('More edits arrived during saving; the next sync will finish them.');
    })().finally(() => { running = null; });
    return running;
  }
  if (hadLocal) {
    try {
      const draft = JSON.parse(sessionStorage.getItem('tiksi.research.session.v1') || 'null');
      const property = ws.data.properties.find(p => p.id === (draft?.context?.propertyId || ws.data.settings.activePropertyId));
      if (draft && property && !property.researchSession) property.researchSession = draft;
    } catch (ignored) {}
  }
  const legacyRecovery = copy(ws.data);
  if (!hadLocal && rawLegacy !== null) legacyRecovery.unreadableLegacyWorkspace = rawLegacy;
  const legacyIds = needsMigration ? (probedIds || await storedFileIds()) : [];
  let legacyFolderMap = {}, migrationPack = null, mirrorRunning = false;
  if (hadLocal) { try { legacyFolderMap = JSON.parse(localStorage.getItem('tiksi.folder.v1') || '{}'); } catch (ignored) {} }
  useDiskPersistence({ changed });
  setFileBackend({ read, changed(id) { changedFiles.add(id); changed(); } });
  async function mirror(prop) {
    const before = copy(ws.data.properties.find(p => p.id === prop.id) || prop);
    const working = copy(before);
    const endpoint = '/mirror/' + encodeURIComponent(prop.id);
    const info = await (await request(endpoint + '/info')).json();
    const entry = await (await request(endpoint + '/state')).json();
    entry.file = info.file;
    if (!entry.mirror && legacyFolderMap[prop.id]?.mirror) entry.mirror = legacyFolderMap[prop.id].mirror;
    let version = info.mtime;
    const folder = {
      async getFileHandle(name, options) {
        const now = await (await request(endpoint + '/info')).json(); version = now.mtime;
        if (!now.exists && !options?.create) throw new DOMException('Mirror not found', 'NotFoundError');
        return { async getFile() {
          const stat = await (await request(endpoint + '/info')).json(); version = stat.mtime;
          return { name, size: stat.size, lastModified: Number(stat.mtime) / 1e6, async arrayBuffer() { return (await request(endpoint)).arrayBuffer(); } };
        }, async createWritable() { return { async write(blob) { await request(endpoint, { method: 'PUT', body: blob, headers: { 'X-File-Mtime': version } }); }, async close() {} }; } };
      },
    };
    const result = await syncMirror(folder, working, entry, async (handle, blob) => { const writer = await handle.createWritable(); await writer.write(blob); await writer.close(); });
    await request(endpoint + '/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(entry) });
    if (result.changed) {
      const index = ws.data.properties.findIndex(p => p.id === prop.id);
      if (index >= 0) {
        const accepted = await resolveMerge(before, ws.data.properties[index], working);
        ws.data.properties[index] = accepted; touch(); await sync();
      }
    }
  }
  async function pollMirrors() {
    if (mirrorRunning || pending || ws.data.settings.sketchupMirror === false) return;
    const available = await mirrorCapabilities();
    if (!available.openSketchUp) return; // one desktop owns authoring; phones read the same results
    mirrorRunning = true;
    try { for (const prop of ws.data.properties) if (paths[prop.id]) await mirror(prop); }
    catch (error) { console.warn('disk mirror:', error.message); }
    finally { mirrorRunning = false; }
  }
  diskWorkspace = { sync, changed, syncSketchUp: mirror, async openSketchUp(prop) {
    await sync();
    const deadline = Date.now() + 120000;
    while (mirrorRunning) { if (Date.now() > deadline) throw new Error('SketchUp sync is still busy; try again after it finishes.'); await new Promise(r => setTimeout(r, 100)); }
    await mirror(prop);
    return (await request('/mirror/' + encodeURIComponent(prop.id) + '/open', { method: 'POST' })).json();
  }, get paths() { return paths; }, get folder() { return cap.projectsFolder; }, get pending() { return pending; } };
  const initial = await (await request()).json();
  revision = initial.revision; paths = initial.paths || {}; assets = initial.assets || {};
  if (needsMigration) {
    // Stage a legacy migration as a merge; never seed an empty phone over the Mac.
    if (!hadLocal && initial.data) await apply(initial.data);
    pending = true;
    await sync();
  } else if (initial.data) {
    base = { data: copy(initial.data), assets: copy(assets) };
    await apply(initial.data);
    await finishBrowserMigration({ clearFiles: false });
    status('SAVED TO DISK');
  } else {
    await apply(emptyWorkspace()); pending = true; await sync();
    await finishBrowserMigration({ clearFiles: false });
  }
  onChange(changed);
  setInterval(() => sync().catch(failed), 2500);
  setInterval(pollMirrors, 10000);
  window.addEventListener('online', () => sync().catch(failed));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync().catch(failed); });
  window.addEventListener('beforeunload', e => { if (pending) { e.preventDefault(); e.returnValue = ''; } });
  return diskWorkspace;
}
