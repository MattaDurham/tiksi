// Web Worker wrapper around scan2plan so the console stays responsive while a
// scan is vectorized. Message in: { pos: Float32Array, idx: Uint32Array, options }.
// Messages out: { type: 'progress', stage, frac } ... { type: 'done', result } | { type: 'error', message }.

import { scanToPlan } from './scan2plan-core.js';

self.onmessage = e => {
  const { pos, idx, options } = e.data;
  try {
    const result = scanToPlan(pos, idx, options, (stage, frac) => self.postMessage({ type: 'progress', stage, frac }));
    self.postMessage({ type: 'done', result });
  } catch (err) {
    self.postMessage({ type: 'error', message: err && err.message ? err.message : String(err) });
  }
};
