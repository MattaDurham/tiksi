// What a device has changed and the Mac has not confirmed yet, kept in the browser's own
// storage so that a locked phone, a switched app or a dropped tab does not lose it.
//
// The Mac's project files stay the only place a project lives. This is a waiting room: a
// page writes its unsent state here, the next page that opens on this device sends it
// (js/disk-workspace.js, through the same merge and review as any offline edit), and it is
// removed once the Mac confirms. IndexedDB is used because it also works on the plain-http
// address a phone opens over Tailscale, where service workers do not.
//
// Two stores. `states` holds one record per page, under the page's own name: its unsent
// records and the list of `spaces` its originals are in. `files` holds originals under
// [space, id], where the space is the name of the page that wrote them. A page writes only
// under its own name and removes only the exact records it wrote or sent, so two pages
// never overwrite or clear each other's copy.
//
// Nothing here may stop a save: when the storage is missing, full or refused, a write
// answers false and a read answers null (not an empty list: "could not read" must never be
// taken for "nothing kept"), and the page carries on as before.

const DATABASE = 'tiksi-unsent';
// Larger originals are not copied here: the copy would not fit beside the original in a
// phone's memory. They exist only in the open page until they are sent, and the page says so.
export const keptLimits = { maxFileBytes: 100 * 1024 * 1024 };

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
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); opening = null; };
        // A phone may drop the connection while the page is in the background: open it again next time.
        db.onclose = () => { opening = null; };
        resolve(db);
      };
      request.onerror = () => reject(request.error || new Error('Browser storage is unavailable'));
      request.onblocked = () => reject(new Error('Browser storage is busy'));
    });
    opening.catch(() => { opening = null; });
    return opening;
  }
  // One operation at a time, in the order asked: a file kept and then confirmed is never
  // removed before it was written. `failed` is what a failure answers.
  let queue = Promise.resolve();
  function inOrder(work, failed = false) {
    const result = queue.then(work).catch(error => {
      console.warn('unsent changes:', error && error.message || error);
      // The connection may be the thing that failed: the next operation starts with a new one.
      const stale = opening; opening = null;
      if (stale) stale.then(db => db.close(), () => {});
      return failed;
    });
    queue = result; return result;
  }
  const done = tx => new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(true);
    tx.onerror = tx.onabort = () => reject(tx.error || new Error('Browser storage write failed'));
  });
  const all = request => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result || []); request.onerror = () => reject(request.error); });
  const one = request => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });

  return {
    // Open the storage ahead of need: when a page is being hidden there is no time to wait for it.
    ready() { return inOrder(async () => { await open(); return true; }); },
    // The unsent state of one page, replacing what it kept before.
    keepState(owner, state) {
      return inOrder(async () => { const tx = (await open()).transaction('states', 'readwrite'); tx.objectStore('states').put({ ...state, owner }); return done(tx); });
    },
    // One original, under the name of the page that adds it. False when it was not kept.
    keepFile(space, id, record) {
      if (!record || !record.buffer || record.buffer.byteLength > keptLimits.maxFileBytes) return Promise.resolve(false);
      return inOrder(async () => { const tx = (await open()).transaction('files', 'readwrite'); tx.objectStore('files').put({ owner: space, id, record }); return done(tx); });
    },
    // Remove a page's state and the named originals ([space, id]) in one step. With `at`,
    // the state goes only if it is still the one written at that moment: a page that has
    // written again since keeps its copy.
    settle(owner, { state = false, at, files = [] } = {}) {
      return inOrder(async () => {
        const tx = (await open()).transaction(['states', 'files'], 'readwrite');
        const states = tx.objectStore('states'), store = tx.objectStore('files');
        if (state) {
          if (at === undefined) states.delete(owner);
          else { const now = await one(states.get(owner)); if (now && now.at === at) states.delete(owner); }
        }
        for (const key of files) store.delete(key);
        return done(tx);
      });
    },
    // What is kept on this device, without the originals' bytes: { states, fileKeys } with
    // fileKeys as [space, id]. Null when it could not be read.
    list() {
      return inOrder(async () => {
        const tx = (await open()).transaction(['states', 'files']);
        const [states, fileKeys] = await Promise.all([all(tx.objectStore('states').getAll()), all(tx.objectStore('files').getAllKeys())]);
        return { states, fileKeys };
      }, null);
    },
    // The originals in these spaces: [{ space, id, record }]. Null when they could not be read.
    filesIn(spaces) {
      return inOrder(async () => {
        const index = (await open()).transaction('files').objectStore('files').index('owner');
        const found = await Promise.all(spaces.map(space => all(index.getAll(space))));
        return found.flat().map(file => ({ space: file.owner, id: file.id, record: file.record }));
      }, null);
    },
    // Remove the storage itself, for a browser that keeps nothing and read that nothing is kept.
    forget() {
      return inOrder(async () => {
        const stale = opening; opening = null;
        if (stale) (await stale).close();
        await new Promise((resolve, reject) => { const request = factory.deleteDatabase(DATABASE); request.onsuccess = request.onblocked = () => resolve(); request.onerror = () => reject(request.error); });
        return true;
      });
    },
  };
}
