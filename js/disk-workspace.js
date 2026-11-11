// The Mac's project files are authoritative. Browser state is an in-memory working
// copy; legacy browser stores are read once and removed only after a disk save.
import { ws, emptyWorkspace, replaceWorkspace, adoptRecord, onChange, touch, whenHydrated, projectSlice, listAllFileIds, storedFileIds, getCachedFile, cacheFile, deleteFiles, setFileBackend, useDiskPersistence, finishBrowserMigration, setSaveStatus } from './store.js';
import { mergeShared, sameJson } from './workspace-merge.js';
import { syncMirror, mirrorCapabilities, mirrorSpec, specSignature, mirrorFileName } from './sketchup-mirror.js';
import { pictureFiles, pictureRefs, mapStrings } from './picture-assets.js';
import { unsentStore } from './unsent.js';
import { touchDevice } from './render-quality.js';

export let diskWorkspace = null;
// A JSON-shaped copy whose objects are all new; strings are immutable and shared.
const copy = value => mapStrings(value, s => s);

// A request to the Mac has no limit on its whole duration: a large scan over a slow link
// takes as long as it takes. It is given up only when no byte has moved, in either
// direction, for `stallMs`; `answerMs` is the wait for the Mac's answer once everything was
// sent (it may be writing a large project file).
export const transferLimits = { stallMs: 45000, answerMs: 120000 };
// Originals read from the Mac are kept in page memory only up to these sizes: one file up to
// `fileBytes`, and `totalBytes` of them together (the ones read longest ago go first). The
// Mac marks a stored original as never changing, so the browser's own cache answers the next
// read; anything larger is handed to whoever asked and not held here at all. A phone gets a
// smaller share: a page that fills its memory is dropped by the phone.
export const originalLimits = touchDevice()
  ? { fileBytes: 16 * 1024 * 1024, totalBytes: 64 * 1024 * 1024 }
  : { fileBytes: 48 * 1024 * 1024, totalBytes: 256 * 1024 * 1024 };
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
const SMALL_ANSWER_BYTES = 256 * 1024;
async function readBody(url, method, headers, cache) {
  const control = new AbortController();
  let timer, waited = 0;
  const watch = ms => { clearTimeout(timer); waited = ms; timer = setTimeout(() => control.abort(), ms); };
  try {
    watch(transferLimits.answerMs);
    const r = await fetch(url, { method, headers, cache, signal: control.signal });
    // The Mac states the size of what it sends. A small answer (every question about the
    // workspace) is taken whole: it either arrives within the stall limit or it has stalled.
    // (Chromium also reports a body read piece by piece as a cancelled request now and then,
    // though every byte arrived; small answers are most of the requests.)
    const stated = Number(r.headers.get('Content-Length'));
    if (!r.body || Number.isInteger(stated) && stated <= SMALL_ANSWER_BYTES) { watch(transferLimits.stallMs); return answer(r.status, await r.arrayBuffer()); }
    // A file: the bytes go straight into their final place, and the limit is on each pause.
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

// The values two copies disagree on, in words: [{ what, here, there }]. A path such as
// data.properties.<id>.walls.<id>.ax becomes "Harbour house: walls, w-e, ax"; a record is
// named by its `name` where it has one. `here` and `there` are given for plain values, and
// for a record one side removed.
export function describeConflicts(paths, local, remote) {
  const plain = v => typeof v === 'string' ? '“' + (v.length > 60 ? v.slice(0, 59) + '…' : v) + '”' : typeof v === 'object' && v !== null ? null : String(v);
  return paths.map(path => {
    const words = [];
    let l = local, r = remote;
    for (const part of path.split('.')) {
      const step = v => Array.isArray(v) ? v.find(x => x && x.id === part) : v && typeof v === 'object' ? v[part] : undefined;
      const list = Array.isArray(l) || Array.isArray(r);
      l = step(l); r = step(r);
      const named = [l, r].find(v => v && typeof v === 'object' && typeof v.name === 'string' && v.name);
      if (list) words.push(named ? named.name : part);
      else if (part !== 'data' && part !== 'properties') words.push(part === 'assets' ? 'original files' : part);
    }
    const what = words.length > 1 ? words[0] + ': ' + words.slice(1).join(', ') : words[0] || 'the whole copy';
    if (l === undefined || r === undefined) return { what, here: l === undefined ? 'removed' : 'changed', there: r === undefined ? 'removed' : 'changed' };
    const here = plain(l), there = plain(r);
    return here !== null && there !== null ? { what, here, there } : { what };
  });
}

// What a device is looking at is its own: which property is open, which level of each
// property, and which tags are switched on. These sit in the shared records (every page
// reads them there), but they are not project content. A device keeps its own choices in
// its browser, puts them back whenever shared data arrives, and saves the records with the
// values the Mac already holds, so one device's view never moves another's and two devices
// looking at different things is never a conflict.
const VIEW_KEY = 'tiksi.device.view.v1';
export function deviceView(storage = (() => { try { return globalThis.localStorage; } catch (error) { return null; } })()) {
  let own = { property: null, levels: {}, tags: {} };
  try { const kept = JSON.parse(storage.getItem(VIEW_KEY)); if (kept && typeof kept === 'object') own = { property: kept.property || null, levels: kept.levels || {}, tags: kept.tags || {} }; } catch (ignored) {}
  let written = JSON.stringify(own);
  return {
    // Take this device's choices from the open records (after any edit).
    note(data) {
      own.property = data.settings.activePropertyId || own.property;
      for (const p of data.properties) {
        own.levels[p.id] = p.activeLevelId;
        if ((p.tags || []).length) own.tags[p.id] = Object.fromEntries(p.tags.map(t => [t.id, t.visible !== false]));
      }
      const text = JSON.stringify(own);
      if (text === written) return;
      written = text;
      try { storage.setItem(VIEW_KEY, text); } catch (ignored) { /* kept for as long as this page is open */ }
    },
    // Put this device's choices into records that arrived from the Mac. A property, level or
    // tag this device has not seen yet starts as the Mac has it.
    impose(data) {
      if (own.property && data.properties.some(p => p.id === own.property)) data.settings.activePropertyId = own.property;
      for (const p of data.properties) {
        const level = own.levels[p.id], tags = own.tags[p.id];
        if (level && (p.levels || []).some(l => l.id === level)) p.activeLevelId = level;
        if (tags) for (const t of p.tags || []) if (t.id in tags) t.visible = tags[t.id];
      }
      return data;
    },
    // The same records as they are saved: with the Mac's view values, not this device's.
    shared(data, agreed) {
      if (!agreed) return data;
      const held = new Map((agreed.properties || []).map(p => [p.id, p]));
      const open = agreed.settings && agreed.settings.activePropertyId;
      if (data.properties.some(p => p.id === open)) data.settings.activePropertyId = open;
      for (const p of data.properties) {
        const was = held.get(p.id);
        if (!was) continue;
        if ((p.levels || []).some(l => l.id === was.activeLevelId)) p.activeLevelId = was.activeLevelId;
        const tags = new Map((was.tags || []).map(t => [t.id, t]));
        for (const t of p.tags || []) { const w = tags.get(t.id); if (!w) continue; if ('visible' in w) t.visible = w.visible; else delete t.visible; }
      }
      return data;
    },
  };
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
  // The same note from an earlier page's kept copy, not yet checked with the Mac: id -> entry.
  const heldHints = new Map();
  // Save rounds are numbered, to tell an original acknowledged in this round from one counted
  // on from an earlier round.
  let round = 0, reusedEarlier = false;
  // Projects the Mac lists but cannot read just now (file missing or unreadable), as the Mac
  // describes them: [{ id, name, path, reason, message }]. They are in no record here.
  let unavailable = [];
  let picturesIn = Promise.resolve();
  function noteUnavailable(list) {
    const next = Array.isArray(list) ? list : [];
    if (sameJson(next, unavailable)) return;
    unavailable = next;
    onRemote?.({ properties: new Set(), keys: new Map(), materials: false, other: false });
  }
  // The data version this page's code writes. A copy saved by newer code holds values this
  // page would tidy away; it must not save over them.
  const ownVersion = emptyWorkspace().version;
  function refuseIfOlder(...copies) {
    const newest = Math.max(0, ...copies.map(c => Number(c && c.version) || 0));
    if (newest <= ownVersion) return;
    const error = new Error('This tab runs an older Tiksi than the copy on the Mac was saved with. Reload it before changing anything here');
    error.status = 426; throw error;
  }
  // Every save carries an id of this page's own, so a Mac that keeps save ids can say later
  // whether a save arrived (the reply may never have reached a page that was then dropped).
  // `upcoming` is the id of the next save, which will hold everything the page holds when it
  // is made. `sentSaves` are the last saves sent, each with the records it was made from
  // and the ids it went out under (a retry of the same records adds an id). A kept copy
  // lists the ids of every sent save made from exactly its records, and `upcoming`: if the
  // Mac committed any of them, it has everything in that copy.
  let saveCount = 0, sentSaves = [];
  const nextSaveId = () => owner + '-save-' + (++saveCount);
  let upcoming = null;
  const coveredBy = local => sentSaves.filter(sent => sameJson(sent.form, local)).flatMap(sent => sent.ids);
  // Away from the Mac, what has not reached it is also kept in this browser's storage, so a
  // locked phone, a switched app or a dropped tab loses nothing; the next page opened on
  // this device sends it (sendKept below). The browser on the Mac keeps nothing here.
  let unsent = awayFromTheMac() ? unsentStore() : null;
  // The name this page keeps under, for as long as it lives. It carries the time the page
  // opened, so originals a long-gone page left behind can be told from a live page's.
  const owner = 'page-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  // Kept originals this page wrote or took over from an earlier page: id -> the space they
  // are in. Each is removed, by its own key, once the Mac has confirmed it; nothing else is.
  const mine = new Map();
  // Originals that could not be kept (too large, or the browser's storage refused): id ->
  // name. They exist only in this open page until they are sent, and the status line says so.
  const notKept = new Map();
  const onlyHere = () => unsent ? [...notKept].filter(([id]) => changedFiles.has(id)).map(([, name]) => name) : [];
  let keepTimer, keeping = null, keepAgain = false, keptHere = false, keptMark = '', keptBase, baseJson = { of: undefined, text: 'null' };
  // True from taking a new agreed copy until the open workspace shows it. In between, `base`
  // holds other devices' changes that the workspace does not have yet: a copy kept then
  // would, when sent later, undo them. The copy kept before stays as it is meanwhile.
  let settling = false;
  // True while an earlier page's kept copy is being put into this page (takeNext below).
  let taking = false;
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
        if (settling || taking) continue;   // the step in progress brings the kept copy up to date when it ends
        for (const id of [...notKept.keys()]) if (!changedFiles.has(id)) notKept.delete(id);
        if (!upcoming) upcoming = nextSaveId();
        const mark = [edits, pending, changedFiles.size, heldByMac.size, mine.size, notKept.size, sentSaves.map(sent => sent.ids.length).join(), upcoming].join('|'), agreed = base;
        if (mark === keptMark && keptBase === agreed) continue;
        // While an older browser store is still being moved to the Mac, that store is the kept
        // copy. Without an agreed copy there is nothing to merge a kept one against later.
        const local = pending && !migration && agreed ? savedFormNow() : null;
        // Originals the Mac has confirmed go; those still waiting for their save, or for the
        // record that names them, stay.
        const sent = [...mine].filter(([id]) => !changedFiles.has(id)), keys = sent.map(([id, space]) => [space, id]);
        let written;
        if (!local || !changedFiles.size && sameJson(local, agreed.data)) {
          written = await unsent.settle(owner, { state: true, files: keys }); keptHere = false;
        } else {
          // An original that was not kept gets another try with every kept copy.
          for (const id of [...notKept.keys()]) await keepFile(id, false);
          // The agreed copy is large and changes only with a confirmed save: serialized once each.
          if (baseJson.of !== agreed) baseJson = { of: agreed, text: JSON.stringify(agreed) };
          const held = {}; for (const [id, at] of heldByMac) held[id] = at.entry;
          written = keptHere = await unsent.keepState(owner, { at: Date.now(), base: baseJson.text, assets: JSON.stringify(assets), local: JSON.stringify(local), held,
            saveIds: [...coveredBy(local), upcoming],
            spaces: [...new Set([owner, ...mine.values()])], notKept: Object.fromEntries([...notKept].filter(([id]) => changedFiles.has(id))) });
          if (written) await unsent.settle(owner, { files: keys });
        }
        // A write that failed is tried again the next time round, not taken as done.
        if (written) { keptMark = mark; keptBase = agreed; for (const [id] of sent) mine.delete(id); }
        keptChanged();
      } while (keepAgain);
    })().catch(error => console.warn('unsent changes:', error)).finally(() => { keeping = null; });
    return keeping;
  }
  const keepSoon = () => { if (unsent) { clearTimeout(keepTimer); keepTimer = setTimeout(keepUnsent, 150); } };
  // An original is kept the moment it is added: it is the one thing that cannot be made
  // again. One that could not be kept is remembered, so the page can say it exists only here.
  async function keepFile(id, say = true) {
    if (!unsent) return;
    let record = null, kept = false;
    try { record = await getCachedFile(id); kept = await unsent.keepFile(owner, id, record); } catch (error) { console.warn('unsent changes:', error); }
    if (kept) { mine.set(id, owner); notKept.delete(id); }
    else if (record?.buffer && changedFiles.has(id)) notKept.set(id, typeof record.name === 'string' && record.name ? record.name : 'an original');
    if (say) keptChanged();
  }
  // What is kept changed: the line says so where it speaks of it (a failure, or originals
  // that exist only in this open page). Any other text on the line is left alone.
  function keptChanged() {
    if (failure || onlyHere().length !== Number(statusLine?.dataset.keepOpen || 0)) repaint();
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
  const view = deviceView();
  const savedFormNow = () => view.shared(pictures ? pictures.slim(ws.data).data : copy(ws.data), base?.data);
  const pictureAssets = data => pictures ? pictures.assetsFor(pictureRefs(data).keys()) : {};
  // The status line also says which kind of state it shows, for the phone bar and for
  // styling: saved, sending, waiting (not saved yet, tried again by itself) or refused (not
  // saved, and trying again cannot help). `detail` is the full explanation, shown on hover.
  // Other parts of the app write the same line; the kind holds only for the text set here.
  const statusLine = document.getElementById('save-status');
  let statusText = null;
  if (statusLine) new MutationObserver(() => {
    if (statusLine.textContent !== statusText) { delete statusLine.dataset.saveState; delete statusLine.dataset.keepOpen; statusLine.removeAttribute('title'); }
  }).observe(statusLine, { childList: true, characterData: true, subtree: true });
  function status(text, busy = false, kind = busy ? 'sending' : 'saved', detail = '') {
    statusText = text; setSaveStatus(text, busy);
    if (!statusLine) return;
    statusLine.dataset.saveState = kind;
    detail = detail || { 'SAVED TO DISK': 'Everything here is saved in the Mac’s project files.', 'SAVING TO DISK': 'Sending what changed to the Mac.',
      'SENDING WHAT THIS DEVICE KEPT': 'Sending what this device kept from the last time Tiksi was open here.' }[text] || '';
    // Originals that are in this open page and nowhere else: the person must know not to close it.
    const only = kind === 'saved' ? [] : onlyHere();
    if (only.length) {
      detail += (detail ? ' ' : '') + (only.length === 1 ? only[0] + ' is' : only.length + ' originals (' + only.slice(0, 3).join(', ') + (only.length > 3 ? ', …' : '') + ') are') +
        ' only in this open page until the Mac has ' + (only.length === 1 ? 'it' : 'them') + ': keep this page open.';
      statusLine.dataset.keepOpen = String(only.length);
    } else delete statusLine.dataset.keepOpen;
    if (detail) statusLine.title = detail; else statusLine.removeAttribute('title');
  }
  // True while a copy an earlier page kept is on its way to the Mac.
  let replaying = false;
  const savingText = () => replaying ? 'SENDING WHAT THIS DEVICE KEPT' : 'SAVING TO DISK';
  const settledText = () => cleanupNotice ? 'SAVED TO DISK — CLOSE OLDER TIKSI TABS' : pending ? savingText() : 'SAVED TO DISK';
  // Put this module's own state back on the line: after another part of the app wrote its
  // message there, or when what the line should say has changed under an unchanged text.
  function repaint() {
    if (failure) showFailure();
    else if (pending) status(savingText(), true);
  }
  // The last round that failed: { hold, tries, retryAt }. `hold` is a save the Mac refused for
  // a reason that sending it again cannot change; it waits for an edit or for the person.
  let failure = null;
  function changed() {
    edits++;
    if (applying) return;
    view.note(ws.data);
    pending = true; failure = null; status(savingText(), true);
    clearTimeout(timer); timer = setTimeout(() => sync().catch(failed), 700);
    keepSoon();
  }
  const brief = text => { const t = String(text || '').trim(); return t.length > 72 ? t.slice(0, 71).trimEnd() + '…' : t; };
  function failed(error) {
    if (failure && failure.error === error) return;   // one failed round, reported to several callers
    console.error('project-file sync:', error);
    // Edits kept arriving while saving: nothing failed, the next round finishes them.
    if (error.unfinished) { status(savingText(), true); return; }
    // `pending` is left as it was: a lost connection with nothing to save is not unsaved work.
    const answered = typeof error.status === 'number';
    // Refused for good: records the Mac will not take (400), too large (413), a tab too old
    // to save (426). Anything else it answers may pass by itself, a project file another
    // program is still writing for one (422), and is tried again.
    const refused = answered && [400, 413, 426].includes(error.status) && !error.resend;
    const tries = (failure && !failure.hold ? failure.tries : 0) + 1;
    // A Mac that answers with a fault is sent the same save less and less often, up to once a
    // minute. One that cannot be reached is asked again at the usual pace: reconnecting is cheap.
    const wait = (answered || error.stalled) && tries > 1 ? Math.min(60000, 2500 * 2 ** (tries - 1)) : 0;
    failure = { hold: refused && pending, tries, retryAt: Date.now() + wait, refused, error };
    showFailure();
  }
  function showFailure() {
    const { refused, error } = failure;
    const here = pending && keptHere ? (onlyHere().length ? ' The records changed here are kept on this device until the Mac has them.' : ' What changed here is kept on this device until the Mac has it.') : '';
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
  // Originals read from the Mac and held in page memory, oldest read first: id -> bytes.
  const heldOriginals = new Map();
  function holdOriginal(id, bytes) {
    heldOriginals.delete(id); heldOriginals.set(id, bytes);
    let total = 0; for (const size of heldOriginals.values()) total += size;
    for (const [old, size] of heldOriginals) {
      if (total <= originalLimits.totalBytes) break;
      if (old === id) continue;
      heldOriginals.delete(old); total -= size;
      // Only what the Mac holds unchanged is let go; it is read again when next wanted.
      if (!changedFiles.has(old)) deleteFiles([old]);
    }
  }
  async function download(remote) {
    // The Mac marks an original as never changing: the browser may answer from its own cache.
    const buffer = await (await request('/blobs/' + remote.hash, { cache: 'default' })).arrayBuffer();
    if (buffer.byteLength !== remote.size) throw new Error('Project asset download was truncated');
    return buffer;
  }
  async function read(id, local) {
    const remote = assets[id];
    if (!remote || changedFiles.has(id)) return local;
    if (local?.sharedHash === remote.hash) { if (heldOriginals.has(id)) holdOriginal(id, heldOriginals.get(id)); return local; }
    const meta = { id, name: remote.name, format: remote.format, kind: remote.kind, mime: remote.mime, sharedHash: remote.hash };
    // Too large to hold: the bytes go straight to whoever asked, uncopied, and are not kept.
    if (remote.size > originalLimits.fileBytes) return { ...meta, buffer: await download(remote), owned: true };
    const key = id + ':' + remote.hash;
    if (!inFlightFiles.has(key)) inFlightFiles.set(key, (async () => {
      const buffer = await download(remote);
      const value = { ...meta, buffer };
      if (assets[id]?.hash === remote.hash && !changedFiles.has(id)) { await cacheFile(id, buffer, value); holdOriginal(id, buffer.byteLength); }
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
      if (uploaded && held.round !== round) reusedEarlier = true;
      // An earlier page noted that the Mac acknowledged this original: ask the Mac, once.
      const hint = !uploaded && heldHints.get(id);
      if (hint) {
        heldHints.delete(id);
        if (hint.size === local.buffer.byteLength && await macHolds(hint.hash)) { uploaded = hint; reusedEarlier = true; heldByMac.set(id, { buffer: local.buffer, entry: hint, round: 0 }); }
      }
      if (!uploaded) {
        uploaded = await (await request('/blobs', { method: 'POST', body: local.buffer })).json();
        if (uploaded.size !== local.buffer.byteLength) throw new Error('An upload was incomplete');
        heldByMac.set(id, { buffer: local.buffer, entry: uploaded, round });
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
    try {
      // This device's own view goes back in before the records are compared and shown.
      const change = replaceWorkspace(data, { source: 'shared', prepare: next => view.impose(next) });
      view.note(ws.data);
      await whenHydrated(); onRemote?.(change);
    }
    finally { applying = false; }
  }
  // Two copies changed the same value. Both are preserved on the Mac first; then the person
  // is shown which values differ and chooses a side. `other` names where the other copy
  // comes from: the copy saved on the Mac (which may hold another device's edits), or the
  // SketchUp model.
  async function resolveMerge(ancestor, local, remote, other = 'the saved copy') {
    let result = mergeShared(ancestor, local, remote);
    if (!result.conflicts.length) return result.value;
    status('PROJECT COPIES NEED REVIEW', true);
    // Preserve both exact variants before a choice, including rejected offline
    // edits that have never been a committed server revision.
    const preserved = [];
    for (const value of [local, remote]) {
      let recovery = value;
      if (!value.data || !value.assets) {
        const data = savedFormNow();
        data.properties = data.properties.map(p => p.id === value.id ? (pictures ? pictures.slim(value).data : copy(value)) : p);
        recovery = { data, assets: { ...await fileManifest(data, assets), ...pictureAssets(data) } };
      }
      const kept = await (await request('/recovery', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(recovery) })).json().catch(() => ({}));
      if (typeof kept.recovery === 'string') preserved.push(kept.recovery);
    }
    const lines = describeConflicts(result.conflicts, local, remote);
    const dialog = document.createElement('dialog'); dialog.className = 'file-dialog'; dialog.dataset.copiesDiffer = '';
    dialog.innerHTML = '<h2>Two copies of this project differ</h2><p data-what></p><ul data-values></ul><p data-more></p><p data-kept></p><div class="file-actions"><button class="btn primary" data-mac></button><button class="btn" data-local>USE THIS WINDOW’S VALUES</button></div>';
    dialog.querySelector('[data-what]').textContent = 'This window and ' + other + ' hold different values for the same ' + (result.conflicts.length === 1 ? 'thing' : result.conflicts.length + ' things') +
      '. Choose which to use for ' + (result.conflicts.length === 1 ? 'it' : 'them') + '; everything else from both copies is combined. Saving from this window waits for the choice.';
    for (const line of lines.slice(0, 12)) {
      const item = document.createElement('li'), what = document.createElement('strong');
      what.textContent = line.what; item.append(what);
      if (line.here !== undefined) item.append(' — this window: ' + line.here + '; ' + other + ': ' + line.there);
      dialog.querySelector('[data-values]').append(item);
    }
    dialog.querySelector('[data-more]').textContent = lines.length > 12 ? 'and ' + (lines.length - 12) + ' more.' : '';
    dialog.querySelector('[data-kept]').textContent = 'Both copies are preserved first, whichever you choose' + (preserved.length ? ': ' + preserved.join(' and ') + ' in the history folder beside the Mac’s project files.' : '.');
    dialog.querySelector('[data-mac]').textContent = 'USE ' + other.replace(/^the /, 'THE ').toUpperCase() + '’S VALUES';
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
    round++; reusedEarlier = false;
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
      noteUnavailable(remote.unavailable);
      if (!pending && remote.data) {
        // Nothing unsaved here and the saved copy is from newer code: load that code, once.
        if (Number(remote.data.version) > ownVersion && reloadOnceFor(remote.data.version)) return;
        await fetchPictures(remote.data, remote.assets);
        if (!pending) {
          revision = remote.revision; assets = remote.assets; base = { data: remote.data, assets };
          await apply(remote.data); status('SAVED TO DISK'); return;
        }
      }
    }
    refuseIfOlder(remote && remote.data, base && base.data);
    const remoteRevision = remote ? remote.revision : revision;
    // The id this round's save will carry, taken before the records are read: a copy kept
    // before this moment is wholly inside the save.
    const saveId = upcoming || nextSaveId();
    upcoming = nextSaveId();
    const saved = pictures ? await pictures.slimStored(() => ws.data) : { data: copy(ws.data) };
    const sentData = view.shared(saved.data, base?.data);
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
      status(pending ? savingText() : 'SAVED TO DISK', pending);
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
      (pictures ? ',"pictureFiles":true' : '') + (migrationPack ? ',"migration":' + JSON.stringify(migrationPack) : '') + ',"saveId":' + JSON.stringify(saveId) + '}';
    // Remember what this save was made from, so a kept copy of the same records can name it.
    const again = sentSaves.find(sent => sameJson(sent.form, sentData));
    if (again) again.ids = [...again.ids, saveId].slice(-20);
    else sentSaves = [...sentSaves, { form: sentData, ids: [saveId] }].slice(-3);
    keepUnsent();
    let reply;
    try {
      reply = await (await request('', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body })).json();
    } catch (error) {
      savedSlices = { revision: -1, json: {} };
      // The Mac did not accept the save, and this round counted on originals acknowledged in
      // an earlier one: upload them again and try once more. A round that uploaded every
      // original itself has nothing to send again, so its refusal stands.
      if (error.status === 400 && reusedEarlier) { heldByMac.clear(); error.resend = true; }
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
        status(savingText(), true);
      }
      throw error;
    }
    let current;
    settling = true;
    try {
      revision = reply.revision; assets = accepted.assets; base = accepted;
      noteUnavailable(reply.unavailable);
      savedSlices = { revision, json: sliceJson };
      paths = reply.paths || (await (await request()).json()).paths || {};
      // Blob upload alone is not a save acknowledgment. Keep replacements dirty
      // across revision retries, while preserving any still-newer in-flight edit.
      for (const [id, buffer] of uploadedFiles) if ((await getCachedFile(id))?.buffer === buffer) {
        changedFiles.delete(id); heldByMac.delete(id);
        // The Mac has it now: it counts toward what page memory holds, or is let go when too large.
        if (buffer.byteLength > originalLimits.fileBytes) deleteFiles([id]); else holdOriginal(id, buffer.byteLength);
      }
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
        if (!pending) { if (replaying) { replaying = false; status(settledText(), cleanupNotice); } recovered(); return; }
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
        const accepted = await resolveMerge(before, ws.data.properties[index], working, 'the SketchUp model');
        // The merged values go into the record that is already there: an open page, a dialog
        // or a slow action holding it keeps the live one. The open page is then redrawn.
        const live = ws.data.properties[index];
        const keys = [...new Set([...Object.keys(live), ...Object.keys(accepted)])].filter(key => !sameJson(live[key], accepted[key]));
        adoptRecord(live, accepted); touch();
        onRemote?.({ properties: new Set([prop.id]), keys: new Map([[prop.id, keys]]), materials: false, other: false });
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
  }, get paths() { return paths; }, get folder() { return cap.projectsFolder; }, get pending() { return pending; },
  // Projects whose file the Mac cannot read just now, and taking one off the Mac's list for
  // good (no file is deleted; a Mac that does not offer this answers that it cannot).
  get unavailable() { return unavailable; },
  // Settles when every property's pictures are in the open records: an export waits for it,
  // so a file written in the first seconds holds its pictures and not references to them.
  whenPictures() { return picturesIn; },
  async forgetUnavailable(id) {
    const reply = await (await request('/unavailable/' + encodeURIComponent(id) + '/forget', { method: 'POST' })).json();
    noteUnavailable(reply.unavailable);
    return reply;
  } };
  // Load newer code once for a copy saved by it; a second time would mean the Mac serves the
  // older code itself, and reloading again would not help.
  function reloadOnceFor(version) {
    try {
      if (sessionStorage.getItem('tiksi.reloaded.for') === String(version)) return false;
      sessionStorage.setItem('tiksi.reloaded.for', String(version));
    } catch (error) { return false; }
    location.reload();
    return true;
  }
  const initial = await (await request()).json();
  unavailable = Array.isArray(initial.unavailable) ? initial.unavailable : [];
  // The copy on the Mac was saved by newer code than this page runs: load that code, once,
  // before showing anything (nothing can be unsaved yet).
  if (initial.data && Number(initial.data.version) > ownVersion && reloadOnceFor(initial.data.version)) await new Promise(() => {});
  revision = initial.revision; paths = initial.paths || {}; assets = initial.assets || {};
  // The first screen needs the pictures of the property it opens on, not of every property:
  // those are fetched first, the rest once the app is open (laterPictures below).
  const opensOn = initial.data && view.impose({ settings: { ...initial.data.settings }, properties: initial.data.properties.map(p => ({ id: p.id })) }).settings.activePropertyId;
  const firstShown = initial.data && initial.data.properties.some(p => p.id === opensOn) ? { ...initial.data, properties: initial.data.properties.filter(p => p.id === opensOn) } : initial.data;
  if (initial.data) await fetchPictures(firstShown, assets);
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
  // The app does not wait for that save: it opens on the kept records while they are sent.
  async function macHolds(hash) {
    try { return [200, 304].includes((await readBody('/api/workspace/blobs/' + hash, 'GET', { ...headers, 'If-None-Match': '"' + hash + '"' }, 'no-store')).status); }
    catch (error) { return false; }
  }
  // Pages of this browser that are open now say so: what they kept is theirs to send.
  const pages = typeof BroadcastChannel === 'function' ? new BroadcastChannel('tiksi-unsent') : null;
  const openNames = new Set();
  if (pages) pages.onmessage = event => {
    if (event.data?.here) openNames.add(event.data.here);
    if (event.data?.ask) pages.postMessage({ here: owner });
  };
  async function openElsewhere() {
    if (!pages) return openNames;
    pages.postMessage({ ask: true, here: owner });
    await new Promise(resolve => setTimeout(resolve, 250));
    return openNames;
  }
  async function keptDatabaseExists() {
    try { return typeof indexedDB.databases === 'function' && (await indexedDB.databases()).some(d => d.name === 'tiksi-unsent'); }
    catch (error) { return false; }
  }
  const openedAt = name => parseInt(String(name).split('-')[1], 36) || 0;
  // Kept copies of earlier pages still to send, oldest first; one is taken up at a time.
  const waiting = [];
  async function sendKept() {
    // A window that was narrow when it kept something may be wide now: it still sends it.
    const store = unsent || (await keptDatabaseExists() ? unsentStore() : null);
    if (!store || !await store.ready()) return;
    const listed = await store.list();
    // Not read is not empty: what could not be read is left exactly as it is.
    if (!listed) return;
    if (!listed.states.length && !listed.fileKeys.length) { if (!unsent) await store.forget(); return; }
    const open = await openElsewhere();
    // Originals no kept state names, left by a page that opened over a week ago and is not
    // open now: the record that would have named them never got as far as this storage.
    const named = new Set(listed.states.flatMap(state => state.spaces || [state.owner]));
    const stale = listed.fileKeys.filter(([space]) => space !== owner && !named.has(space) && !open.has(space) && Date.now() - openedAt(space) > 7 * 86400000);
    if (stale.length) await store.settle(owner, { files: stale });
    const states = listed.states.filter(state => state.owner !== owner && !open.has(state.owner)).sort((a, b) => (a.at || 0) - (b.at || 0));
    if (!states.length) return;
    unsent = store;
    waiting.push(...states);
    await takeNext();
  }
  // Take up the next kept copy, when nothing in this page is unsent: the copy becomes the
  // open workspace, so anything unsent here goes to the Mac first.
  async function takeNext() {
    while (waiting.length && !pending && !running && !settling && !taking) {
      const entry = waiting[0], spaces = entry.spaces || [entry.owner];
      let kept = null, lost = [];
      taking = true;
      try {
        try { kept = { base: JSON.parse(entry.base), assets: JSON.parse(entry.assets), local: JSON.parse(entry.local), held: entry.held || {} }; } catch (ignored) {}
        const files = await unsent.filesIn(spaces);
        if (!files) { waiting.shift(); continue; }   // not readable now: it stays kept for the next time Tiksi opens
        // The Mac already committed a save that held everything in this copy (its reply never
        // reached the page that sent it): there is nothing to send, and merging it again
        // could undo what was changed on the Mac since.
        if (kept && await committedAlready(entry.saveIds)) {
          await unsent.settle(entry.owner, { state: true, at: entry.at, files: files.map(file => [file.space, file.id]) });
          waiting.shift(); continue;
        }
        const usable = files.filter(file => file.record?.buffer);
        // Nothing to send: a kept state that merges into the Mac's copy without changing it
        // is already there.
        const nothing = !kept || !kept.local || !usable.length && base && (() => {
          const merged = mergeShared(kept.base?.data, kept.local, base.data);
          return !merged.conflicts.length && sameJson(merged.value, base.data);
        })();
        if (nothing) {
          // Unreadable records are left where they are; a copy the Mac already has is cleared.
          if (kept && kept.local) await unsent.settle(entry.owner, { state: true, at: entry.at, files: files.map(file => [file.space, file.id]) });
          waiting.shift(); continue;
        }
        await fetchPictures(kept.local, { ...assets, ...(kept.assets || {}) });
        // Something was changed here while the copy was being read: it is sent first.
        if (pending || running || settling) return;
        // Originals the kept records name for the first time whose bytes are nowhere: not in
        // this storage, not on the Mac. They were only in the page that closed.
        // (A photo record says whether it ever had an original; a model or a video always has.)
        const before = new Set(kept.base ? listAllFileIds(kept.base.data) : []), have = new Set(usable.map(file => file.id));
        const gone = id => !before.has(id) && !have.has(id) && !assets[id] && !(kept.assets || {})[id];
        lost = kept.local.properties.flatMap(p => [...(p.photos || []).filter(r => r.original === true), ...(p.videos || []), ...(p.scans || [])])
          .filter(r => gone(r.id) || r.originalFileId && gone(r.originalFileId)).map(r => (entry.notKept || {})[r.id] || r.name || 'an original');
        // From here the open records, the copy they are merged against and the changed
        // originals change together, with nothing else running in between.
        for (const { id, space, record } of usable) {
          await cacheFile(id, record.buffer, record); changedFiles.add(id); mine.set(id, space);
          if (kept.held[id]) heldHints.set(id, kept.held[id]);
        }
        // Without the copy it last agreed with the Mac there is no common ancestor: every
        // difference is then put to the person instead of being decided either way.
        base = kept.base || undefined;
        assets = kept.assets || {}; revision = -1; savedSlices = { revision: -1, json: {} };
        await apply(kept.local);
        pending = true; edits++; replaying = true; status(savingText(), true);
      } finally { taking = false; }
      waiting.shift();
      // Under this page's own name first; only then does the earlier page's state go, and
      // only if it is still the one read here. At no moment is the copy in neither place.
      await keepUnsent();
      if (keptHere) await unsent.settle(entry.owner, { state: true, at: entry.at });
      else confirmedLater.push(entry);
      if (lost.length) tellLost(lost);
      sync().catch(failed);
      return;
    }
  }
  // Ask a Mac that keeps save ids whether it committed any of these. A Mac that does not
  // (its answer has no `save`) is not asked twice, and the copy is merged as before.
  async function committedAlready(ids) {
    if (!Array.isArray(ids)) return false;
    for (const id of ids.filter(id => typeof id === 'string' && id).slice(-21).reverse()) {
      let answer;
      try { answer = await (await request('/head?saveId=' + encodeURIComponent(id))).json(); } catch (error) { return false; }
      if (!answer || !answer.save) return false;
      if (answer.save.committed === true) return true;
    }
    return false;
  }
  // Earlier pages' states that could not be copied under this page's name: they stay until
  // the Mac has confirmed what they hold.
  const confirmedLater = [];
  // Say plainly which originals did not survive the page that closed.
  function tellLost(names) {
    const dialog = document.createElement('dialog'); dialog.className = 'file-dialog'; dialog.dataset.lostOriginals = '';
    dialog.innerHTML = '<h2>Some originals were not kept</h2><p data-what></p><p>Their records are in the project without a file. Add the files again from the device they came from.</p><div class="file-actions"><button class="btn primary" data-ok>OK</button></div>';
    dialog.querySelector('[data-what]').textContent = (names.length === 1 ? 'One original was' : names.length + ' originals were') +
      ' only in the page that closed and could not be kept on this device: ' + names.join(', ') + '.';
    document.body.append(dialog); dialog.showModal();
    dialog.querySelector('[data-ok]').onclick = () => { dialog.close(); dialog.remove(); };
  }
  try { await sendKept(); } catch (error) { console.warn('unsent changes:', error); }
  // The other properties' pictures, behind the open app. They go into the open records in
  // place; a page that shows any of them is told, as for a change from another device.
  async function laterPictures() {
    if (!pictures || !initial.data || firstShown === initial.data) return;
    await pictures.fetchMissing(ws.data, assets);
    const filled = new Set();
    for (const p of ws.data.properties) if (pictures.fill(p)) filled.add(p.id);
    if (pictures.fill(ws.data) || filled.size) onRemote?.({ properties: filled, keys: new Map([...filled].map(id => [id, null])), materials: false, other: false });
  }
  picturesIn = laterPictures().catch(error => console.warn('pictures of the other properties:', error));
  onChange(changed);
  setInterval(() => {
    // Another part of the app may have written its own message over this module's state
    // (an export, a "save as"): a save that failed, or is still on its way, shows again.
    if (statusLine && statusLine.textContent !== statusText && (failure || pending)) repaint();
    // A refused save waits for a change; a faulting Mac is asked again after a growing pause.
    if (running || failure && (failure.hold || Date.now() < failure.retryAt)) return;
    // Everything here is on the Mac: an earlier page's state that could not be copied under
    // this page's name can go now, and the next kept copy can be taken up.
    if (!pending && !failure) {
      for (const entry of confirmedLater.splice(0)) unsent?.settle(entry.owner, { state: true, at: entry.at });
      if (waiting.length) { takeNext().catch(error => console.warn('unsent changes:', error)); return; }
    }
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
