// The Mac clean-up control offers REMOVE only where every page agrees the device is not a touch
// device, and describes a plan in plain sentences. No server or browser: the page module alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TOUCH_DEVICE_QUERY } from '../js/render-quality.js';
import { removesHere, describePlan, describeResult } from '../js/mac-cleanup.js';

const screen = matching => { globalThis.matchMedia = query => ({ matches: matching.includes(query) }); };
const bytes = n => n + ' B';

test('REMOVE follows the touch test every page uses', t => {
  t.after(() => { delete globalThis.matchMedia; });
  screen([TOUCH_DEVICE_QUERY, '(pointer: coarse)', '(hover: none)']);
  assert.equal(removesHere(), false, 'a phone sees the list only');
  screen(['(pointer: coarse)', '(hover: hover)']);
  assert.equal(removesHere(), true, 'a coarse pointer that can hover is no touch device to any page');
  screen([]);
  assert.equal(removesHere(), true, 'the Mac offers REMOVE');
});

test('a plan and its result are said in plain sentences', () => {
  assert.match(describePlan({ count: 0, bytes: 0, copies: [], originals: [] }, bytes), /^Nothing on the Mac can be removed/);
  const plan = { count: 3, bytes: 30, copies: [{ name: '1.json', bytes: 10 }], originals: [{ hash: 'a', bytes: 10 }, { hash: 'b', bytes: 10 }] };
  assert.match(describePlan(plan, bytes), /^A clean-up would remove 1 saved copy and 2 stored originals, 30 B in all\. Removing cannot be undone\. Always kept: /);
  assert.equal(describeResult({ copies: 1, originals: 2, bytes: 30 }, bytes), 'Removed 1 saved copy and 2 stored originals from the Mac; 30 B freed.');
});
