// What a device has changed and the Mac has not confirmed yet, kept in the browser's own
// storage so that a locked phone, a switched app or a dropped tab does not lose it.
//
// The Mac's project files stay the only place a project lives. This is a waiting room: a
// page writes its unsent state here, the next page that opens on this device sends it
// (js/disk-workspace.js, through the same merge and review as any offline edit), and it is
// removed once the Mac confirms. IndexedDB is used because it also works on the plain-http
// address a phone opens over Tailscale, where service workers do not.
//
// Every page writes under its own name (`owner`), so two tabs never overwrite each other.
// Nothing here may stop a save: when the storage is missing, full or refused, every
// function answers false or an empty list and the page carries on as before.

const DATABASE = 'tiksi-unsent';
// Larger originals are not copied here: the copy would not fit beside the original in a
// phone's memory. They stay in the page until they are sent, as before.
export const MAX_KEPT_FILE_BYTES = 100 * 1024 * 1024;

export function unsentStore(factory = globalThis.indexedDB) {
  let opening = null;
  function open() {
    if (!opening) opening = new Promise((resolve, reject) => {
      const request = factory.open(DATABASE, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('states', { keyPath: 'owner' });
        db.createObjectStore('files', { keyPath: ['owner', 'id'] }).createIndex('owner', 'owner');
      };
      request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); opening = null; }; resolve(request.result); };
      request.onerror = () => reject(request.error || new Error('Browser storage is unavailable'));
      request.onblocked = () => reject(new Error('Browser storage is busy'));
    });
    opening.catch(() => { opening = null; });
    return opening;
  }
  // One write at a time, in the order asked: a file kept and then confirmed is never
  // removed before it was written.
  let queue = Promise.resolve();
  function inOrder(work) {
    const result = queue.then(work).catch(error => { console.warn('unsent changes:', error && error.message || error); return false; });
    queue = result; return result;
  }
  const done = tx => new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(true);
    tx.onerror = tx.onabort = () => reject(tx.error || new Error('Browser storage write failed'));
  });
  const all = request => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result || []); request.onerror = () => reject(request.error); });

  return {
    // Open the storage ahead of need: when a page is being hidden there is no time to wait for it.
    ready() { return inOrder(async () => { await open(); return true; }); },
    // The unsent state of one page, replacing what it kept before.
    keepState(owner, state) {
      return inOrder(async () => { const tx = (await open()).transaction('states', 'readwrite'); tx.objectStore('states').put({ ...state, owner }); return done(tx); });
    },
    keepFile(owner, id, record) {
      if (!record || !record.buffer || record.buffer.byteLength > MAX_KEPT_FILE_BYTES) return Promise.resolve(false);
      return inOrder(async () => { const tx = (await open()).transaction('files', 'readwrite'); tx.objectStore('files').put({ owner, id, record }); return done(tx); });
    },
    // The Mac has confirmed everything except the files named in `stillUnsent`.
    confirmed(owner, stillUnsent = new Set(), { state = true } = {}) {
      return inOrder(async () => {
        const tx = (await open()).transaction(['states', 'files'], 'readwrite');
        if (state) tx.objectStore('states').delete(owner);
        const files = tx.objectStore('files');
        for (const key of await all(files.index('owner').getAllKeys(owner))) if (!stillUnsent.has(key[1])) files.delete(key);
        return done(tx);
      });
    },
    // Everything kept on this device: [{ owner, state, files: [{ id, record }] }], oldest first.
    everything() {
      return inOrder(async () => {
        const tx = (await open()).transaction(['states', 'files']);
        const [states, files] = await Promise.all([all(tx.objectStore('states').getAll()), all(tx.objectStore('files').getAll())]);
        const byOwner = new Map(states.map(state => [state.owner, { owner: state.owner, state, files: [] }]));
        for (const file of files) {
          if (!byOwner.has(file.owner)) byOwner.set(file.owner, { owner: file.owner, state: null, files: [] });
          byOwner.get(file.owner).files.push({ id: file.id, record: file.record });
        }
        return [...byOwner.values()].sort((a, b) => (a.state?.at || 0) - (b.state?.at || 0));
      }).then(found => found || []);
    },
    remove(owner) {
      return inOrder(async () => {
        const tx = (await open()).transaction(['states', 'files'], 'readwrite');
        tx.objectStore('states').delete(owner);
        const files = tx.objectStore('files');
        for (const key of await all(files.index('owner').getAllKeys(owner))) files.delete(key);
        return done(tx);
      });
    },
  };
}
