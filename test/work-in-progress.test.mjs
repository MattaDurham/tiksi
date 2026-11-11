// Work that is in the page and not yet in the store counts for exactly as long as it runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { working, workInProgress } from '../js/work-in-progress.js';

test('work counts until it ends, however it ends', async () => {
  assert.equal(workInProgress(), false);
  let finish, fail;
  const one = working(new Promise(resolve => { finish = resolve; }));
  const two = working(new Promise((resolve, reject) => { fail = reject; }));
  assert.equal(workInProgress(), true);
  finish('done');
  assert.equal(await one, 'done', 'the work itself is handed back');
  assert.equal(workInProgress(), true, 'the other one is still running');
  fail(new Error('could not be read'));
  await assert.rejects(two, /could not be read/, 'a failure reaches the caller as before');
  assert.equal(workInProgress(), false, 'and work that failed no longer counts');
});

test('a value that is not a promise ends at once', async () => {
  assert.equal(working(42), 42);
  await Promise.resolve();
  assert.equal(workInProgress(), false);
});
