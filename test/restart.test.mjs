// RESTART TIKSI (js/restart.js): asks first, names a long job before stopping it, and reloads
// only once the Mac's server answers with a new start time.
import test from 'node:test';
import assert from 'node:assert/strict';

// The few page pieces js/restart.js touches.
const added = [];
globalThis.document = {
  getElementById: id => added.find(el => el.id === id) || null,
  createElement: () => ({ setAttribute() {}, remove() { added.splice(added.indexOf(this), 1); } }),
  body: { appendChild: el => added.push(el) },
};
let starts = [];
globalThis.fetch = async () => ({ ok: true, json: async () => ({ started: starts.length > 1 ? starts.shift() : starts[0] }) });
const { restartTiksi } = await import('../js/restart.js');

function workspace(busy) {
  const calls = [];
  return { calls, async restart(force) {
    calls.push(force);
    if (busy && !force) { const e = new Error('Still running on the Mac: photo to 3D. Restarting stops it.'); e.code = 'busy'; throw e; }
    return { restarting: true };
  } };
}

test('a no at the first question restarts nothing', async () => {
  const ws = workspace(false);
  assert.equal(await restartTiksi(ws, { ask: () => false }), false);
  assert.deepEqual(ws.calls, []);
});

test('the page reloads once the server answers with a new start time', async () => {
  starts = [100, 100, 100, 200];
  let reloaded = 0;
  const ws = workspace(false);
  assert.equal(await restartTiksi(ws, { ask: () => true, reload: () => reloaded++, waitMs: 10000 }), true);
  assert.deepEqual(ws.calls, [false]);
  assert.equal(reloaded, 1);
});

test('a long job is named and stopped only after a second yes', async () => {
  const questions = [];
  const ws = workspace(true);
  assert.equal(await restartTiksi(ws, { ask: q => { questions.push(q); return questions.length === 1; } }), false);
  assert.deepEqual(ws.calls, [false]);
  assert.match(questions[1], /photo to 3D/);
  assert.equal(added.length, 0, 'the cover is taken away');
  starts = [300, 400];
  const again = workspace(true);
  assert.equal(await restartTiksi(again, { ask: () => true, reload() {}, waitMs: 10000 }), true);
  assert.deepEqual(again.calls, [false, true]);
});

test('a refused restart says why and leaves the page as it was', async () => {
  const told = [];
  const ws = { async restart() { throw new Error('Unsaved changes could not be saved'); } };
  assert.equal(await restartTiksi(ws, { ask: () => true, tell: m => told.push(m) }), false);
  assert.match(told[0], /did not restart: Unsaved changes/);
  assert.equal(added.length, 0);
});
