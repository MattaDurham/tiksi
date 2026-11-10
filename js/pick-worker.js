// The background helper that builds pick trees (see pick-index.js): one geometry per message,
// its vertices in, its tree out, nothing copied on the way back.
import { triangleTreeFrom, pointTreeFrom } from './pick-tree.js';

self.onmessage = e => {
  const { id, kind, positions, stride, offset, index, count } = e.data;
  try {
    const tree = kind === 'points' ? pointTreeFrom(positions, count) : triangleTreeFrom(positions, stride, offset, index, count);
    // The arrays are views trimmed to the tree's size: send exact copies of the used part.
    const box = tree.box.slice(), a = tree.a.slice(), b = tree.b.slice();
    self.postMessage({ id, ok: true, box, a, b, order: tree.order, nodes: tree.nodes }, [box.buffer, a.buffer, b.buffer, tree.order.buffer]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
