// The client's stars and comments on the renderings of a client page in the lab (client-strip.js).
//
// On thedurham.nyc they are kept by the website's own note store (/lab/api/annotations, the one
// its page notes use), under a page of their own, `/lab/<slug>/renderings`, so the website's note
// layer on the page itself never replaces them. The store keeps each signed-in person's notes
// apart: a client reads and replaces only their own; the owner (an admin there) also reads
// everyone else's, which the page shows under the owner's own. Each note is one row:
//   { id: 'rendering:<key>:<email>', kind: 'tiksi-rendering', rendering: key, view, star, comment, at }
// where `key` is the rendering's name from the send (lab-publish.js renderingKey, the same from
// one send to the next). The store keeps one row per id on a page, whoever wrote it, so the id
// carries the person's email too: two people's notes on one rendering never replace each other.
//
// Anywhere else (this Mac's /lab-preview/ copy, a check) and whenever the store cannot be reached,
// the notes stay in this browser only, and `where()` says so. They are kept in this browser in
// any case, so a note typed while the store is out of reach is not lost and goes up with the
// next change.

const KIND = 'tiksi-rendering';
const clean = s => String(s || '').slice(0, 4000);

// `page` is the store's page for these notes; `remote` false keeps them in this browser only.
export function createNotes({ page, remote = true, fetch: get = (...a) => fetch(...a), storage = safeStorage() } = {}) {
  const LOCAL = 'tiksi.clientNotes.v1:' + page;
  const own = new Map();          // key -> { star, comment, view, at }
  let others = new Map();         // key -> [{ by, star, comment }]
  let online = false, viewer = null, timer = 0, saving = null, again = false, failed = false;
  const listeners = new Set();
  const told = () => { for (const fn of listeners) { try { fn(); } catch (e) { console.error(e); } } };

  try {
    const kept = JSON.parse((storage && storage.getItem(LOCAL)) || '{}');
    for (const [k, n] of Object.entries(kept && typeof kept === 'object' ? kept : {})) if (n && typeof n === 'object') own.set(k, { star: !!n.star, comment: clean(n.comment), view: n.view || '', at: n.at || 0 });
  } catch { /* nothing kept */ }
  const keep = () => { try { storage && storage.setItem(LOCAL, JSON.stringify(Object.fromEntries(own))); } catch { /* this visit only */ } };
  const url = () => '/lab/api/annotations?page=' + encodeURIComponent(page);

  async function load() {
    if (!remote) return;
    try {
      const r = await get(url(), { credentials: 'same-origin', cache: 'no-store' });
      if (!r.ok || !(r.headers.get('content-type') || '').includes('json')) return;
      const body = await r.json();
      viewer = body.viewer || null;
      online = true;
      const mine = viewer && viewer.email || '';
      const theirs = new Map(), fromStore = new Map();
      for (const a of Array.isArray(body.annotations) ? body.annotations : []) {
        if (!a || a.kind !== KIND || typeof a.rendering !== 'string') continue;
        const n = { star: !!a.star, comment: clean(a.comment), view: a.view || '', at: Number(a.at) || 0 };
        if (!a.created_by || a.created_by === mine) fromStore.set(a.rendering, n);
        else (theirs.get(a.rendering) || theirs.set(a.rendering, []).get(a.rendering)).push({ by: a.created_by, star: n.star, comment: n.comment });
      }
      others = theirs;
      // The newer of the store's note and this browser's wins; this browser's newer ones go up.
      let newer = false;
      for (const [k, n] of fromStore) { const here = own.get(k); if (!here || (n.at || 0) >= (here.at || 0)) own.set(k, n); }
      for (const [k, n] of own) { const there = fromStore.get(k); if (!there || (n.at || 0) > (there.at || 0)) newer = true; }
      keep();
      told();
      if (newer) save();
    } catch { /* this browser only */ }
  }

  async function save() {
    clearTimeout(timer); timer = 0;
    keep();
    if (!online) return;
    if (saving) { again = true; return saving; }
    const annotations = [...own].filter(([, n]) => n.star || n.comment.trim())
      .map(([k, n]) => ({ id: 'rendering:' + k + ':' + ((viewer && viewer.email) || 'me'), kind: KIND, rendering: k, view: n.view, star: n.star, comment: n.comment, at: n.at }));
    saving = (async () => {
      try {
        const r = await get(url(), { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ annotations }) });
        failed = !r.ok;
      } catch { failed = true; }
      saving = null;
      told();
      if (again) { again = false; return save(); }
    })();
    return saving;
  }
  function saveSoon(ms = 700) { clearTimeout(timer); keep(); timer = setTimeout(save, ms); }

  return {
    load,
    get: key => own.get(key) || { star: false, comment: '', view: '', at: 0 },
    others: key => others.get(key) || [],
    // Change this person's note on one rendering; a star goes up at once, typing a moment later.
    set(key, change, { soon = false } = {}) {
      const was = own.get(key) || { star: false, comment: '', view: '', at: 0 };
      own.set(key, { ...was, ...change, comment: clean('comment' in change ? change.comment : was.comment), at: Date.now() });
      told();
      if (soon) saveSoon(); else save();
    },
    flush: () => (timer ? save() : saving || Promise.resolve()),
    // 'online' (kept on the website), 'failed' (the website refused the last change; it is kept
    // in this browser and goes up with the next one) or 'browser' (this browser only).
    where: () => (online ? (failed ? 'failed' : 'online') : 'browser'),
    viewer: () => viewer,
    onChange: fn => { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

// The notes' page in the store for the client page at `path` (/lab/<slug>/...), or null when the
// page is not one of the website's lab pages.
export function notesPage(path) {
  const m = /^\/lab\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)(?:\/|$)/.exec(path || '');
  return m && m[1] !== 'api' ? '/lab/' + m[1] + '/renderings' : null;
}

function safeStorage() { try { return window.localStorage; } catch { return null; } }
