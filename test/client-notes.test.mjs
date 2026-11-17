// The client's stars and comments on renderings (js/client-notes.js), against a stand-in for the
// website's note store that keeps one row per (page, id) and replaces only the caller's own rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNotes, notesPage } from '../js/client-notes.js';

function memoryStorage() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m };
}
function store(email, rows = new Map()) {
  const puts = [];
  const fetch = async (url, opts = {}) => {
    const page = new URL(url, 'http://x').searchParams.get('page');
    const json = v => ({ ok: true, headers: { get: () => 'application/json' }, json: async () => v });
    if ((opts.method || 'GET') === 'GET') return json({ page, viewer: { email, admin: email === 'owner@example.invalid' }, annotations: [...rows.values()].filter(r => r.page === page).map(r => ({ ...r.payload, created_by: r.by, status: 'open' })) });
    const body = JSON.parse(opts.body);
    for (const [id, r] of rows) if (r.page === page && r.by === email) rows.delete(id);
    for (const a of body.annotations) rows.set(page + '|' + a.id, { page, by: email, payload: a });
    puts.push(body.annotations.length);
    return json({ ok: true });
  };
  return { fetch, rows, puts };
}

test('the notes page is the client page\'s own name with /renderings', () => {
  assert.equal(notesPage('/lab/12-synthetic-lane/'), '/lab/12-synthetic-lane/renderings');
  assert.equal(notesPage('/lab/house/index.html'), '/lab/house/renderings');
  assert.equal(notesPage('/lab-preview/house/'), null, 'the Mac\'s preview copy keeps them in the browser');
  assert.equal(notesPage('/lab/api/annotations'), null);
  assert.equal(notesPage('/'), null);
});

test('a star and a comment go to the website, under an id of their own per person', async () => {
  const rows = new Map(), page = '/lab/house/renderings';
  const a = store('owner@example.invalid', rows), b = store('client@example.invalid', rows);
  const owner = createNotes({ page, fetch: a.fetch, storage: memoryStorage() });
  const client = createNotes({ page, fetch: b.fetch, storage: memoryStorage() });
  await owner.load(); await client.load();
  assert.equal(owner.where(), 'online');
  client.set('k1', { star: true, view: 'v-a' });
  await client.flush();
  owner.set('k1', { comment: 'Warmer light', view: 'v-a' });
  await owner.flush();
  assert.equal(rows.size, 2, 'both notes on the same rendering are kept');
  assert.deepEqual([...rows.values()].map(r => [r.by, r.payload.id]).sort(), [['client@example.invalid', 'rendering:k1:client@example.invalid'], ['owner@example.invalid', 'rendering:k1:owner@example.invalid']]);
  // The owner reads the client's note beside their own.
  const again = createNotes({ page, fetch: a.fetch, storage: memoryStorage() });
  await again.load();
  assert.deepEqual(again.get('k1').comment, 'Warmer light');
  assert.deepEqual(again.others('k1'), [{ by: 'client@example.invalid', star: true, comment: '' }]);
  // Taking the star off and leaving no comment removes the client's row.
  client.set('k1', { star: false });
  await client.flush();
  assert.deepEqual([...rows.values()].map(r => r.by), ['owner@example.invalid']);
});

test('typing goes up a moment later, once; the browser keeps a copy at once', async () => {
  const s = store('client@example.invalid'), storage = memoryStorage();
  const notes = createNotes({ page: '/lab/house/renderings', fetch: s.fetch, storage });
  await notes.load();
  notes.set('k2', { comment: 'W' }, { soon: true });
  notes.set('k2', { comment: 'Wa' }, { soon: true });
  notes.set('k2', { comment: 'Wal' }, { soon: true });
  assert.equal(s.puts.length, 0);
  assert.equal(JSON.parse(storage.m.get('tiksi.clientNotes.v1:/lab/house/renderings')).k2.comment, 'Wal');
  await notes.flush();
  assert.equal(s.puts.length, 1);
});

test('without the website the notes stay in this browser, and go up when it is reachable', async () => {
  const storage = memoryStorage(), page = '/lab/house/renderings';
  const off = createNotes({ page, remote: false, storage });
  await off.load();
  off.set('k3', { star: true, view: 'v-w' });
  assert.equal(off.where(), 'browser');
  const back = createNotes({ page, remote: false, storage });
  assert.equal(back.get('k3').star, true, 'kept in this browser');
  // The same browser on the website: its newer note goes up.
  const s = store('client@example.invalid');
  const on = createNotes({ page, fetch: s.fetch, storage });
  await on.load();
  await on.flush();
  assert.deepEqual([...s.rows.values()].map(r => [r.payload.rendering, r.payload.star]), [['k3', true]]);
  // A store that cannot be reached leaves it in the browser.
  const broken = createNotes({ page, fetch: async () => { throw new Error('offline'); }, storage: memoryStorage() });
  await broken.load();
  assert.equal(broken.where(), 'browser');
});
