// The page's own SHA-256 (used where the browser offers none) against Node's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sha256Here, sha256 } from '../js/sha256.js';

const sum = bytes => createHash('sha256').update(bytes).digest('hex');
function bytesOf(size, seed = 1) { const b = new Uint8Array(size); let x = seed; for (let i = 0; i < size; i++) { x = (x * 1103515245 + 12345) >>> 0; b[i] = x >>> 16; } return b; }

test('the sum worked out in the page equals the real one at every awkward length', async () => {
  for (const size of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 121, 127, 128, 129, 1000, 65536, 65537]) {
    const bytes = bytesOf(size, size + 7);
    assert.equal(await sha256Here(bytes.buffer), sum(bytes), size + ' bytes');
  }
  assert.equal(await sha256Here(new TextEncoder().encode('abc').buffer), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('a file worked out in several stretches, with pauses, gives the same sum', async () => {
  const bytes = bytesOf(300000, 42);
  let pauses = 0;
  assert.equal(await sha256Here(bytes.buffer, { stretch: 64 * 1024, pause: async () => { pauses++; } }), sum(bytes));
  assert.ok(pauses >= 4, 'it paused between stretches');
  assert.equal(await sha256(bytes.buffer), sum(bytes), 'and the browser\'s own sum, where there is one, is the same');
});
