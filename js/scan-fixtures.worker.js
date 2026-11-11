// Web Worker wrapper around scan-fixtures so the console stays responsive while a scan is
// read for fixtures. Message in: { pos, idx, options }. Out: progress, then done | error.

import { detectFixtures } from './scan-fixtures.js';

self.onmessage = e => {
  const { pos, idx, options } = e.data;
  // The helper loaded and has the job: from here a failure is the job's, not the helper's.
  self.postMessage({ type: 'started' });
  try {
    const result = detectFixtures(pos, idx, options, (stage, frac) => self.postMessage({ type: 'progress', stage, frac }));
    self.postMessage({ type: 'done', result });
  } catch (err) {
    self.postMessage({ type: 'error', message: err && err.message ? err.message : String(err) });
  }
};
