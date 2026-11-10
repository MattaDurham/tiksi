// The Mac's project files are authoritative. Browser state is an in-memory working
// copy; legacy browser stores are read once and removed only after a disk save.
import { ws, emptyWorkspace, replaceWorkspace, onChange, touch, whenHydrated, projectSlice, listAllFileIds, storedFileIds, getCachedFile, cacheFile, setFileBackend, useDiskPersistence, finishBrowserMigration, setSaveStatus } from './store.js';
import { mergeShared, sameJson } from './workspace-merge.js';
import { syncMirror, mirrorCapabilities, mirrorSpec, specSignature, mirrorFileName } from './sketchup-mirror.js';
import { pictureFiles, pictureRefs, mapStrings } from './picture-assets.js';
import { unsentStore } from './unsent.js';

export let diskWorkspace = null;
// A JSON-shaped copy whose objects are all new; strings are immutable and shared.
const copy = value => mapStrings(value, s => s);

// A request to the Mac has no limit on its whole duration: a large scan over a slow link
// takes as long as it takes. It is given up only when no byte has moved, in either
// direction, for `stallMs`; `answerMs` is the wait for the Mac's answer once everything was
// sent (it may be writing a large project file).
export const transferLimits = { stallMs: 45000, answerMs: 120000 };
// The largest original the Mac stores (MAX_BLOB in server/workspace.py).
const MAX_FILE_BYTES = 600 * 1024 * 1024;
// True on every device but the Mac's own desktop browser: another machine on the network,
// or a phone-sized or touch screen. Those keep what they have not sent (js/unsent.js).
function awayFromTheMac() {
  const host = location.hostname;
  const here = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');
  return !here || matchMedia('(max-width: 760px), (pointer: coarse)').matches;
}
function stalled(ms) {
  const error = new Error('The connection to the Mac stopped: nothing moved for ' + Math.round(ms / 1000) + ' seconds');
  error.stalled = true; return error;
}
const answer = (status, buffer) => ({ status, ok: status >= 200 && status < 300, async arrayBuffer() { return buffer; }, async json() { return JSON.parse(new TextDecoder().decode(buffer)); } });
// A request with a body. XMLHttpRequest reports the bytes as they leave, which fetch cannot.
function sendBody(url, method, headers, body) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let timer, waited = 0;
    const watch = ms => { clearTimeout(timer); waited = ms; timer = setTimeout(() => xhr.abort(), ms); };
    xhr.open(method, url); xhr.responseType = 'arraybuffer';
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = () => watch(transferLimits.stallMs);
    xhr.upload.onload = () => watch(transferLimits.answerMs);
    xhr.onprogress = () => watch(transferLimits.stallMs);
    xhr.onload = () => { clearTimeout(timer); resolve(answer(xhr.status, xhr.response)); };
    xhr.onerror = () => { clearTimeout(timer); reject(new TypeError('Could not reach the Mac')); };
    xhr.onabort = () => { clearTimeout(timer); reject(stalled(waited)); };
    watch(transferLimits.stallMs); xhr.send(body);
  });
}
// A request without a body: the answer is read piece by piece, so a download that keeps
// arriving is never cut off.
async function readBody(url, method, headers, cache) {
  const control = new AbortController();
  let timer, waited = 0;
  const watch = ms => { clearTimeout(timer); waited = ms; timer = setTimeout(() => control.abort(), ms); };
  try {
    watch(transferLimits.answerMs);
    const r = await fetch(url, { method, headers, cache, signal: control.signal });
    if (!r.body) return answer(r.status, await r.arrayBuffer());
    // The Mac states the size of a file it sends: the bytes go straight into their final place.
    const stated = Number(r.headers.get('Content-Length'));
    let bytes = new Uint8Array(Number.isInteger(stated) && stated > 0 ? stated : 65536), size = 0;
    for (const reader = r.body.getReader(); ;) {
      watch(transferLimits.stallMs);
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > bytes.byteLength) { const grown = new Uint8Array(Math.max(bytes.byteLength * 2, size + value.byteLength)); grown.set(bytes.subarray(0, size)); bytes = grown; }
      bytes.set(value, size); size += value.byteLength;
    }
    return answer(r.status, size === bytes.byteLength ? bytes.buffer : bytes.slice(0, size).buffer);
  } catch (error) { throw control.signal.aborted ? stalled(waited) : error; }
  finally { clearTimeout(timer); }
}

// Saved records never share objects with `data`: only properties that gain photos are new.
export function prepareDiskProjects(data) {
  // Portable project files carry the photos needed by their custom materials,
  // including a source sampled in another project. Make that evidence explicit
  // in the shared records too, so disk reload and connected clients agree.
  const properties = data.properties.map(p => {
    const photos = projectSlice(p.id, data).properties[0].photos;
    return photos === p.photos ? p : { ...p, photos };
  });
  const prepared = { ...data, properties };
  return { data: prepared, projectData: Object.fromEntries(properties.map(p => [p.id, projectSlice(p.id, prepared)])) };
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
  let applying = false, pending = false, running = null, timer, base, revision = 0, paths = {}, assets = {}, migration = needsMigration, cleanupNotice = false, edits = 0;
  const changedFiles = new Set(), inFlightFiles = new Map();
  // Originals this page has uploaded that no save has confirmed yet: id -> { buffer, entry }.
  // The Mac stores a file by its content and keeps it, so a round that failed part-way sends
  // only the files the Mac does not hold yet.
  const heldByMac = new Map();
  // Away from the Mac, what has not reached it is also kept in this browser's storage, so a
  // locked phone, a switched app or a dropped tab loses nothing; the next page opened on
  // this device sends it (sendKept below). The browser on the Mac keeps nothing here.
  let unsent = awayFromTheMac() ? unsentStore() : null;
  // The name this page keeps under. A page that takes over what an earlier page kept takes its name too.
  let owner = 'page-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  let keepTimer, keeping = null, keepAgain = false, keptHere = false, keptMark = '', keptBase, baseJson = { of: undefined, text: 'null' };
  // True from taking a new agreed copy until the open workspace shows it. In between, `base`
  // holds other devices' changes that the workspace does not have yet: a copy kept then
  // would, when sent later, undo them. The copy kept before stays as it is meanwhile.
  let settling = false;
  // Bring the kept copy up to date: the last copy agreed with the Mac, this page's records
  // as they would be saved, and which originals the Mac already holds. Nothing is written
  // when nothing changed since the last time, and nothing is kept once the Mac has it all.
  function keepUnsent() {
    if (!unsent) return Promise.resolve();
    clearTimeout(keepTimer);
    if (keeping) { keepAgain = true; return keeping; }
    keeping = (async () => {
      do {
        keepAgain = false;
        if (settling) continue;   // the round in progress brings the kept copy up to date when it ends
        const mark = [owner, edits, pending, changedFiles.size, heldByMac.size].join('|'), agreed = base;
        if (mark === keptMark && keptBase === agreed) continue;
        // While an older browser store is still being moved to the Mac, that store is the kept
        // copy. Without an agreed copy there is nothing to merge a kept one against later.
        const local = pending && !migration && agreed ? savedFormNow() : null;
        let written;
        if (!local || !changedFiles.size && sameJson(local, agreed.data)) {
          // Originals still waiting for the record that names them, or for their save, stay.
          written = await unsent.confirmed(owner, changedFiles); keptHere = false;
        } else {
          // The agreed copy is large and changes only with a confirmed save: serialized once each.
          if (baseJson.of !== agreed) baseJson = { of: agreed, text: JSON.stringify(agreed) };
          const held = {}; for (const [id, at] of heldByMac) held[id] = at.entry;
          written = keptHere = await unsent.keepState(owner, { at: Date.now(), base: baseJson.text, assets: JSON.stringify(assets), local: JSON.stringify(local), held });
          if (written) await unsent.confirmed(owner, changedFiles, { state: false });
        }
        // A write that failed is tried again the next time round, not taken as done.
        if (written) { keptMark = mark; keptBase = agreed; }
        if (failure) showFailure();
      } while (keepAgain);
    })().catch(error => console.warn('unsent changes:', error)).finally(() => { keeping = null; });
    return keeping;
  }
  const keepSoon = () => { if (unsent) { clearTimeout(keepTimer); keepTimer = setTimeout(keepUnsent, 150); } };
  // An original is kept the moment it is added: it is the one thing that cannot be made again.
  async function keepFile(id) {
    if (!unsent) return;
    try { await unsent.keepFile(owner, id, await getCachedFile(id)); } catch (error) { console.warn('unsent changes:', error); }
  }
  // What a newer server can do: keep pictures as files, take only the project files and
  // property records that changed, and answer a save with the project paths.
  const features = new Set(Array.isArray(cap.features) ? cap.features : []);
  // The project files last acknowledged, as sent: { revision, json: { id: text } }.
  let savedSlices = { revision: -1, json: {} };
  async function request(path = '', options = {}) {
    const sent = { ...headers, ...(options.headers || {}) };
    const r = options.body == null ? await readBody('/api/workspace' + path, options.method || 'GET', sent, options.cache || 'no-store')
      : await sendBody('/api/workspace' + path, options.method || 'POST', sent, options.body);
    if (r.status === 403) {
      const refreshed = await fetch('/api/workspace/capabilities', { headers: { 'X-Tiksi-Workspace': '1' }, cache: 'no-store', signal: AbortSignal.timeout(10000) });
      if (!refreshed.ok) throw new Error('Project-file server unavailable');
      cap = await refreshed.json(); headers['X-Tiksi-Token'] = cap.token;
      const error = new Error('Reconnected to project files; retrying'); error.status = 403; throw error;
    }
    if (!r.ok) {
      let message = 'Project-file request failed (' + r.status + ')', code;
      try { const body = await r.json(); message = body.error || message; code = body.code; } catch (ignored) {}
      const error = new Error(message); error.status = r.status; error.code = code; throw error;
    }
    return r;
  }
  // Pictures are stored once by content; a stored picture never changes, so the
  // browser's own cache answers a repeat download (see the server's blob headers).
  const pictures = features.has('picture-files') ? pictureFiles({
    upload: async bytes => (await request('/blobs', { method: 'POST', body: bytes })).json(),
    download: async hash => (await request('/blobs/' + hash, { cache: 'default' })).arrayBuffer(),
  }) : null;
  // The open workspace in its saved form, synchronously: known pictures as references,
  // new ones still inline (the next save stores them).
  const savedFormNow = () => pictures ? pictures.slim(ws.data).data : copy(ws.data);
  const pictureAssets = data => pictures ? pictures.assetsFor(pictureRefs(data).keys()) : {};
  // The status line also says which kind of state it shows, for the phone bar and for
  // styling: saved, sending, waiting (not saved yet, tried again by itself) or refused (not
  // saved, and trying again cannot help). `detail` is the full explanation, shown on hover.
  // Other parts of the app write the same line; the kind holds only for the text set here.
  const statusLine = document.getElementById('save-status');
  let statusText = null;
  if (statusLine) new MutationObserver(() => {
    if (statusLine.textContent !== statusText) { delete statusLine.dataset.saveState; statusLine.removeAttribute('title'); }
  }).observe(statusLine, { childList: true, characterData: true, subtree: true });
  function status(text, busy = false, kind = busy ? 'sending' : 'saved', detail = '') {
    statusText = text; setSaveStatus(text, busy);
    if (!statusLine) return;
    statusLine.dataset.saveState = kind;
    detail = detail || { 'SAVED TO DISK': 'Everything here is saved in the Mac’s project files.', 'SAVING TO DISK': 'Sending what changed to the Mac.' }[text] || '';
    if (detail) statusLine.title = detail; else statusLine.removeAttribute('title');
  }
  const settledText = () => cleanupNotice ? 'SAVED TO DISK — CLOSE OLDER TIKSI TABS' : pending ? 'SAVING TO DISK' : 'SAVED TO DISK';
  // The last round that failed: { hold, tries, retryAt }. `hold` is a save the Mac refused for
  // a reason that sending it again cannot change; it waits for an edit or for the person.
  let failure = null;
  function changed() {
    edits++;
    if (applying) return;
    pending = true; failure = null; status('SAVING TO DISK', true);
    clearTimeout(timer); timer = setTimeout(() => sync().catch(failed), 700);
    keepSoon();
  }
  const brief = text => { const t = String(text || '').trim(); return t.length > 72 ? t.slice(0, 71).trimEnd() + '…' : t; };
  function failed(error) {
    if (failure && failure.error === error) return;   // one failed round, reported to several callers
    console.error('project-file sync:', error);
    // Edits kept arriving while saving: nothing failed, the next round finishes them.
    if (error.unfinished) { status('SAVING TO DISK', true); return; }
    // `pending` is left as it was: a lost connection with nothing to save is not unsaved work.
    const answered = typeof error.status === 'number';
    const refused = answered && error.status >= 400 && error.status < 500 && ![403, 408, 409, 429].includes(error.status) && !error.resend;
    const tries = (failure && !failure.hold ? failure.tries : 0) + 1;
    // A Mac that answers with a fault is sent the same save less and less often, up to once a
    // minute. One that cannot be reached is asked again at the usual pace: reconnecting is cheap.
    const wait = (answered || error.stalled) && tries > 1 ? Math.min(60000, 2500 * 2 ** (tries - 1)) : 0;
    failure = { hold: refused && pending, tries, retryAt: Date.now() + wait, refused, error };
    showFailure();
  }
  function showFailure() {
    const { refused, error } = failure;
    const here = pending && keptHere ? ' What changed here is kept on this device until the Mac has it.' : '';
    const said = String(error.message || '').replace(/[.\s]+$/, '') + '.';
    if (refused) status((pending ? 'NOT SAVED: ' : 'PROJECT FILES: ') + brief(error.message), true, 'refused', said + (pending ? ' Sending the same save again cannot help, so it is not retried until something changes here.' : '') + here);
    else {
      const reason = typeof error.status === 'number' ? brief(error.message) : error.stalled ? 'THE MAC STOPPED ANSWERING' : 'CANNOT REACH THE MAC';
      status(pending ? 'NOT SAVED TO DISK — RETRYING: ' + reason : reason + ' — RETRYING', true, 'waiting', (typeof error.status === 'number' || error.stalled ? said : 'This device cannot reach the Mac.') + (pending ? ' The save is tried again by itself.' : '') + here);
    }
  }
  // A round that went through after a failed one: the failure text must not stay up.
  function recovered() {
    if (!failure) return;
    failure = null; status(settledText(), pending || cleanupNotice);
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
  async function fileManifest(data, starting, identifiers = listAllFileIds(data), uploadedFiles = new Map()) {
    const out = {};
    for (const id of new Set(identifiers)) {
      const local = await getCachedFile(id);
      if (starting[id] && !changedFiles.has(id) && (!migration || !local?.buffer)) { out[id] = starting[id]; continue; }
      if (!local?.buffer) { if (starting[id]) out[id] = starting[id]; continue; }
      if (local.buffer.byteLength > MAX_FILE_BYTES) {
        // Said here, in words, instead of as an upload the Mac cuts off again and again.
        const error = new Error((local.name || 'A file') + ' is ' + Math.round(local.buffer.byteLength / 1048576) + ' MB; the Mac accepts files up to ' + MAX_FILE_BYTES / 1048576 + ' MB');
        error.status = 413; throw error;
      }
      const held = heldByMac.get(id);
      let uploaded = held && held.buffer === local.buffer ? held.entry : null;
      if (!uploaded) {
        uploaded = await (await request('/blobs', { method: 'POST', body: local.buffer })).json();
        if (uploaded.size !== local.buffer.byteLength) throw new Error('An upload was incomplete');
        heldByMac.set(id, { buffer: local.buffer, entry: uploaded });
        keepSoon();
      }
      out[id] = { ...uploaded };
      for (const k of ['name', 'format', 'kind', 'mime']) if (typeof local[k] === 'string') out[id][k] = local[k];
      // A later replacement must remain dirty while this upload is in progress.
      const now = await getCachedFile(id);
      if (now?.buffer === local.buffer) await cacheFile(id, local.buffer, { ...local, sharedHash: uploaded.hash });
      uploadedFiles.set(id, local.buffer);
    }
    return out;
  }
  // Download any pictures `saved` references, before computing what to show: the
  // replacement itself then happens without a pause in which an edit could slip by.
  async function fetchPictures(saved, manifest) { if (pictures) await pictures.fetchMissing(saved, manifest); }
  // Show saved records. They become a fresh open copy, so `base` is never changed.
  async function apply(saved) {
    const data = pictures ? pictures.inflate(saved) : copy(saved);
    applying = true;
    try { replaceWorkspace(data, { source: 'shared' }); await whenHydrated(); onRemote?.(); }
    finally { applying = false; }
  }
  async function resolveMerge(ancestor, local, remote) {
    let result = mergeShared(ancestor, local, remote);
    if (!result.conflicts.length) return result.value;
    status('PROJECT COPIES NEED REVIEW', true);
    // Preserve both exact variants before a choice, including rejected offline
    // edits that have never been a committed server revision.
    for (const value of [local, remote]) {
      let recovery = value;
      if (!value.data || !value.assets) {
        const data = savedFormNow();
        data.properties = data.properties.map(p => p.id === value.id ? (pictures ? pictures.slim(value).data : copy(value)) : p);
        recovery = { data, assets: { ...await fileManifest(data, assets), ...pictureAssets(data) } };
      }
      await request('/recovery', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(recovery) });
    }
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
    // The full workspace is read only when another device or an outside edit saved since
    // the last revision this client knows; otherwise that revision is `base` itself.
    let remote = null;
    if (head.revision !== revision || !base) {
      remote = await (await request()).json();
      paths = remote.paths || {};
      if (!pending && remote.data) {
        await fetchPictures(remote.data, remote.assets);
        if (!pending) {
          revision = remote.revision; assets = remote.assets; base = { data: remote.data, assets };
          await apply(remote.data); status('SAVED TO DISK'); return;
        }
      }
    }
    const remoteRevision = remote ? remote.revision : revision;
    const saved = pictures ? await pictures.slimStored(() => ws.data) : { data: copy(ws.data) };
    const sentData = saved.data;
    const uploadedFiles = new Map();
    const sentAssets = { ...await fileManifest(sentData, assets, listAllFileIds(sentData), uploadedFiles), ...pictureAssets(sentData) };
    if (migration && !migrationPack) migrationPack = { data: legacyRecovery, assets: await fileManifest(legacyRecovery, {}, legacyIds) };
    const local = { data: sentData, assets: sentAssets };
    // Compare like with like: a picture this client already stored reads as its reference on
    // every side, so a copy saved before pictures were files never looks like an edit to them.
    const known = state => state && pictures ? { ...state, data: pictures.slim(state.data).data } : state;
    const accepted = remote && remote.data ? await resolveMerge(known(base), local, known({ data: remote.data, assets: remote.assets })) : local;
    const prepared = prepareDiskProjects(accepted.data);
    accepted.data = prepared.data;
    if (!remote && !migration && base && sameJson(accepted.data, base.data) && sameJson(accepted.assets, base.assets)) {
      // Nothing differs from the revision on disk: no new version to write. An original put
      // again with the bytes the Mac already names is as confirmed as it can be.
      for (const [id, buffer] of uploadedFiles) if ((await getCachedFile(id))?.buffer === buffer) { changedFiles.delete(id); heldByMac.delete(id); }
      pending = listAllFileIds(accepted.data).some(id => changedFiles.has(id)) || !sameJson(savedFormNow(), sentData);
      status(pending ? 'SAVING TO DISK' : 'SAVED TO DISK', pending);
      return;
    }
    // Each project file is serialized once: the text is both what is sent and what the
    // next save compares with. Unchanged files are named, not sent, when the server is
    // still at the revision they were acknowledged in.
    const partial = features.has('partial-projects') && savedSlices.revision === remoteRevision;
    const sliceJson = {}, sent = [], unchanged = [];
    for (const [id, slice] of Object.entries(prepared.projectData)) {
      const json = sliceJson[id] = JSON.stringify(slice);
      if (partial && savedSlices.json[id] === json) unchanged.push(id); else sent.push(JSON.stringify(id) + ':' + json);
    }
    // Likewise a property record equal to the one on disk at that revision is named only.
    const onDisk = remote ? remote.data : base?.data;
    let dataJson = null, order = '';
    if (features.has('partial-properties') && Array.isArray(onDisk?.properties)) {
      const held = new Map(onDisk.properties.map(p => [p.id, p]));
      dataJson = JSON.stringify({ ...accepted.data, properties: accepted.data.properties.filter(p => !held.has(p.id) || !sameJson(p, held.get(p.id))) });
      order = ',"propertyOrder":' + JSON.stringify(accepted.data.properties.map(p => p.id));
    }
    const body = '{"revision":' + JSON.stringify(remoteRevision) + ',"data":' + (dataJson ?? JSON.stringify(accepted.data)) + order + ',"assets":' + JSON.stringify(accepted.assets) +
      ',"projectData":{' + sent.join(',') + '}' + (features.has('partial-projects') ? ',"unchangedProjects":' + JSON.stringify(unchanged) : '') +
      (pictures ? ',"pictureFiles":true' : '') + (migrationPack ? ',"migration":' + JSON.stringify(migrationPack) : '') + '}';
    let reply;
    try {
      reply = await (await request('', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body })).json();
    } catch (error) {
      savedSlices = { revision: -1, json: {} };
      // The Mac did not accept the save while this page counted on originals uploaded in an
      // earlier round: upload them again and try once more before taking it as refused.
      if (error.status === 400 && heldByMac.size) { heldByMac.clear(); error.resend = true; }
      if (error.code === 'resend-projects') throw error;   // retried at once with every project file
      if ([403, 409].includes(error.status)) {
        // Carry the reviewed choice into the retry. Re-ask only if the remote
        // value changed again, rather than replaying the same migration dialog.
        const remoteState = remote && remote.data ? { data: remote.data, assets: remote.assets } : base;
        settling = true;
        try {
          base = remoteState; assets = accepted.assets;
          for (const [id, buffer] of uploadedFiles) if (accepted.assets[id]?.hash !== sentAssets[id]?.hash && (await getCachedFile(id))?.buffer === buffer) { changedFiles.delete(id); heldByMac.delete(id); }
          await fetchPictures(accepted.data, accepted.assets);
          const current = savedFormNow(), retry = mergeShared(sentData, current, accepted.data).value;
          if (!sameJson(retry, current)) await apply(retry);
        } finally { settling = false; }
        status('SAVING TO DISK', true);
      }
      throw error;
    }
    let current;
    settling = true;
    try {
      revision = reply.revision; assets = accepted.assets; base = accepted;
      savedSlices = { revision, json: sliceJson };
      paths = reply.paths || (await (await request()).json()).paths || {};
      // Blob upload alone is not a save acknowledgment. Keep replacements dirty
      // across revision retries, while preserving any still-newer in-flight edit.
      for (const [id, buffer] of uploadedFiles) if ((await getCachedFile(id))?.buffer === buffer) { changedFiles.delete(id); heldByMac.delete(id); }
      await fetchPictures(accepted.data, accepted.assets);
      current = savedFormNow();
      const after = mergeShared(sentData, current, accepted.data);
      pending = !sameJson(after.value, accepted.data) || listAllFileIds(after.value).some(id => changedFiles.has(id));
      // A save that brought nothing new back leaves the open view alone: replacing the workspace
      // remounts it, and MODEL would load every imported model again after each click.
      if (!sameJson(after.value, current)) await apply(after.value);
    } finally { settling = false; }
    if (pictures) pictures.forget(new Set([...pictureRefs(accepted.data).keys(), ...pictureRefs(current).keys()]));
    if (migration) {
      // All originals must be on disk before removing their last browser copy.
      migration = false; migrationPack = null;
      await cleanupMigration();
    }
    status(settledText(), pending || cleanupNotice);
  }
  async function sync() {
    if (running) return running;
    running = (async () => {
      for (let round = 0; round < 4; round++) {
        try { await cycle(); }
        catch (error) { if (![403, 409].includes(error.status) || round === 3) throw error; continue; }
        if (!pending) { recovered(); return; }
      }
      const error = new Error('More edits arrived during saving; the next sync will finish them.');
      error.unfinished = true; throw error;
    })().finally(() => { running = null; keepUnsent(); });
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
  setFileBackend({ read, changed(id) { changedFiles.add(id); keepFile(id); changed(); } });
  // A poll whose .skp and project are as they were at the last quiet poll does nothing:
  // no copies, no reads of the model and no write of the mirror state.
  const quietMirrors = new Map();
  function mirrorUpToDate(prop, info, entry) {
    const ms = entry.mirror;
    if (!ms || !info.exists || ms.file !== mirrorFileName(info.file) || ms.mtime !== Number(info.mtime) / 1e6 || ms.size !== info.size) return false;
    const spec = mirrorSpec(prop, ws.data.materials);
    return specSignature(spec) === ms.sig && spec.underlays.every(u => (ms.underlays || {})[u.level] === u.sig);
  }
  async function mirror(prop, polling = false) {
    const endpoint = '/mirror/' + encodeURIComponent(prop.id);
    let info, entry;
    if (polling) {
      const live = ws.data.properties.find(p => p.id === prop.id) || prop;
      info = await (await request(endpoint + '/info')).json();
      const key = [edits, info.exists, info.mtime, info.size, info.file].join('|');
      if (quietMirrors.get(prop.id) === key) return;
      entry = await (await request(endpoint + '/state')).json();
      if (mirrorUpToDate(live, info, entry)) { quietMirrors.set(prop.id, key); return; }
    }
    quietMirrors.delete(prop.id);
    const before = copy(ws.data.properties.find(p => p.id === prop.id) || prop);
    const working = copy(before);
    if (!info) info = await (await request(endpoint + '/info')).json();
    if (!entry) entry = await (await request(endpoint + '/state')).json();
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
    const result = await syncMirror(folder, working, entry, async (handle, blob) => { const writer = await handle.createWritable(); await writer.write(blob); await writer.close(); }, ws.data.materials);
    await request(endpoint + '/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(entry) });
    if (result.changed) {
      const index = ws.data.properties.findIndex(p => p.id === prop.id);
      if (index >= 0) {
        const accepted = await resolveMerge(before, ws.data.properties[index], working);
        ws.data.properties[index] = accepted; touch();
        // An open page holds the record it was built with. Rebuild it on the merged one, as
        // after another device's save, or its next edits change a record nothing saves.
        onRemote?.();
        await sync();
      }
    }
  }
  async function pollMirrors() {
    if (mirrorRunning || pending || ws.data.settings.sketchupMirror === false) return;
    const available = await mirrorCapabilities();
    if (!available.openSketchUp) return; // one desktop owns authoring; phones read the same results
    mirrorRunning = true;
    try { for (const prop of ws.data.properties) if (paths[prop.id]) await mirror(prop, true); }
    catch (error) { console.warn('disk mirror:', error.message); }
    finally { mirrorRunning = false; }
  }
  diskWorkspace = { sync, changed, syncSketchUp: prop => mirror(prop), async openSketchUp(prop) {
    await sync();
    const deadline = Date.now() + 120000;
    while (mirrorRunning) { if (Date.now() > deadline) throw new Error('SketchUp sync is still busy; try again after it finishes.'); await new Promise(r => setTimeout(r, 100)); }
    await mirror(prop);
    return (await request('/mirror/' + encodeURIComponent(prop.id) + '/open', { method: 'POST' })).json();
  }, async openProjectPath(prop, path = '') {
    // A product document or the project folder itself, opened in Finder/Preview on this Mac.
    return (await request('/open/' + encodeURIComponent(prop.id), { method: 'POST', body: JSON.stringify({ path }), headers: { 'Content-Type': 'application/json' } })).json();
  }, get paths() { return paths; }, get folder() { return cap.projectsFolder; }, get pending() { return pending; } };
  const initial = await (await request()).json();
  revision = initial.revision; paths = initial.paths || {}; assets = initial.assets || {};
  if (initial.data) await fetchPictures(initial.data, assets);
  if (needsMigration) {
    // Stage a legacy migration as a merge; never seed an empty phone over the Mac.
    if (!hadLocal && initial.data) await apply(initial.data);
    pending = true;
    await sync();
  } else if (initial.data) {
    base = { data: initial.data, assets };
    await apply(initial.data);
    await finishBrowserMigration({ clearFiles: false });
    status('SAVED TO DISK');
  } else {
    await apply(emptyWorkspace()); pending = true; await sync();
    await finishBrowserMigration({ clearFiles: false });
  }
  // Send what an earlier page on this device kept and never got to the Mac. A kept state is
  // put back the way a page that had been offline holds it: the last copy it agreed with the
  // Mac as the base, its own records as the open workspace, its originals as changed files.
  // The save that follows is the ordinary one: if the Mac has moved on the two are merged,
  // and a record changed on both sides is put to the person with both copies preserved first.
  async function macHolds(hash) {
    try { return [200, 304].includes((await readBody('/api/workspace/blobs/' + hash, 'GET', { ...headers, 'If-None-Match': '"' + hash + '"' }, 'no-store')).status); }
    catch (error) { return false; }
  }
  // Pages of this browser that are open now answer with the name they keep under: what they
  // kept is theirs to send.
  const pages = typeof BroadcastChannel === 'function' ? new BroadcastChannel('tiksi-unsent') : null;
  const openNames = new Set();
  if (pages) pages.onmessage = event => {
    if (event.data?.ask) { if (unsent) pages.postMessage({ here: owner }); }
    else if (event.data?.here) openNames.add(event.data.here);
  };
  async function openElsewhere() {
    if (!pages) return openNames;
    openNames.clear(); pages.postMessage({ ask: true });
    await new Promise(resolve => setTimeout(resolve, 250));
    return openNames;
  }
  async function keptDatabaseExists() {
    try { return typeof indexedDB.databases === 'function' && (await indexedDB.databases()).some(d => d.name === 'tiksi-unsent'); }
    catch (error) { return false; }
  }
  async function sendKept() {
    // A window that was narrow when it kept something may be wide now: it still sends it.
    const store = unsent || (await keptDatabaseExists() ? unsentStore() : null);
    if (!store || !await store.ready()) return;
    const entries = await store.everything();
    if (!entries.length) { if (!unsent) await store.forget(); return; }
    unsent = store;
    const open = await openElsewhere();
    for (const entry of entries) {
      if (open.has(entry.owner)) continue;
      let kept = null;
      try { const s = entry.state; if (s) kept = { base: JSON.parse(s.base), assets: JSON.parse(s.assets), local: JSON.parse(s.local), held: s.held || {} }; } catch (ignored) {}
      const files = entry.files.filter(file => file.record?.buffer);
      // Nothing to send: an original whose record was never kept cannot be placed, and a kept
      // state that merges into the Mac's copy without changing it is already there.
      const nothing = !kept || !kept.local || !files.length && base && (() => {
        const merged = mergeShared(kept.base?.data, kept.local, base.data);
        return !merged.conflicts.length && sameJson(merged.value, base.data);
      })();
      if (nothing) { await unsent.remove(entry.owner); continue; }
      // Take the earlier page's name: what it kept stays where it is, under a page that is
      // open again, until the Mac confirms it. Nothing is copied and nothing is removed first.
      owner = entry.owner;
      for (const { id, record } of files) {
        await cacheFile(id, record.buffer, record); changedFiles.add(id);
        const held = kept.held[id];
        if (held && held.size === record.buffer.byteLength && await macHolds(held.hash)) heldByMac.set(id, { buffer: record.buffer, entry: held });
      }
      await fetchPictures(kept.local, { ...assets, ...(kept.assets || {}) });
      // Without the copy it last agreed with the Mac there is no common ancestor: every
      // difference is then put to the person instead of being decided either way.
      base = kept.base || undefined;
      assets = kept.assets || {}; revision = -1; savedSlices = { revision: -1, json: {} };
      await apply(kept.local);
      pending = true; edits++; status('SENDING WHAT THIS DEVICE KEPT', true);
      await sync();
      await keepUnsent();   // confirmed: the kept copy is cleared before the next one is taken up
    }
  }
  try { await sendKept(); } catch (error) { failed(error); }
  onChange(changed);
  setInterval(() => {
    // A refused save waits for a change; a faulting Mac is asked again after a growing pause.
    if (running || failure && (failure.hold || Date.now() < failure.retryAt)) return;
    sync().catch(failed);
  }, 2500);
  setInterval(pollMirrors, 10000);
  // Coming back online, or back to this page, is a reason to try at once whatever happened before.
  const tryNow = () => { if (failure) { failure.hold = false; failure.retryAt = 0; } sync().catch(failed); };
  window.addEventListener('online', tryNow);
  // A hidden page may be frozen or dropped at any moment (a locked phone, a switched app):
  // what is unsent is kept and sent now, not after the usual short wait.
  const leaving = () => {
    if (!pending) return;
    keepUnsent();
    if (!failure?.hold) { clearTimeout(timer); sync().catch(failed); }
  };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') tryNow(); else leaving(); });
  window.addEventListener('pagehide', leaving);
  window.addEventListener('beforeunload', e => { if (pending) { e.preventDefault(); e.returnValue = ''; } });
  return diskWorkspace;
}
