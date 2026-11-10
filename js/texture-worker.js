// The background helper that makes material textures (see textures.js): one set per message,
// run straight through, its three pixel maps handed back without a copy. The same code the
// page runs in slices when no helper can start (texture-synth.js), so the pixels are the same.
import { synthesize } from './texture-synth.js';

self.onmessage = e => {
  const { mat, res } = e.data;
  const began = performance.now();
  try {
    const run = synthesize(mat, res);
    let step = run.next();
    while (!step.done) step = run.next();
    const { N, col, nrm, orm } = step.value;
    self.postMessage({ ok: true, ms: performance.now() - began, N, col, nrm, orm }, [col.buffer, nrm.buffer, orm.buffer]);
  } catch (err) {
    self.postMessage({ ok: false, ms: performance.now() - began, error: String(err && err.message || err) });
  }
};
