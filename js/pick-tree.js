// The tree of boxes behind MODEL's pick index (pick-index.js), the part that only computes: no
// three.js and no page here. This one file is also the background helper: pick-index.js starts
// it as a worker (see the end), so the helper builds trees with the code the page falls back to
// and the app has one file for both.

const LEAF = 8;                     // items per leaf

// The tree for `count` items. `bounds(i, box)` writes item i's min and max into box[0..5];
// `centre(i, axis)` is its centre on one axis. Nodes are laid out parent first, the left child
// straight after its parent:
//   box    Float32Array, 6 per node (min x y z, max x y z)
//   a, b   Uint32Array per node: a leaf has b = its item count (never 0) and a = where its
//          items start in `order`; an inner node has b = 0 and a = its right child
//   order  the items, grouped by leaf
export function buildTree(count, bounds, centre) {
  const order = new Uint32Array(count);
  for (let i = 0; i < count; i++) order[i] = i;
  if (!count) return { box: new Float32Array(0), a: new Uint32Array(0), b: new Uint32Array(0), order, nodes: 0 };
  // Room for a balanced tree; an uneven one grows it.
  let box = new Float32Array(6 * (4 * Math.ceil(count / LEAF) + 8)), a = new Uint32Array(box.length / 6), b = new Uint32Array(box.length / 6);
  let nodes = 0;
  const grow = () => {
    const nb = new Float32Array(box.length * 2); nb.set(box); box = nb;
    const na = new Uint32Array(a.length * 2); na.set(a); a = na;
    const nbb = new Uint32Array(b.length * 2); nbb.set(b); b = nbb;
  };
  const tmp = new Float32Array(6);
  // An explicit stack of [start, end, parent to patch (or -1)]: no recursion depth to run out of.
  const stack = [0, count, -1];
  while (stack.length) {
    const patch = stack.pop(), end = stack.pop(), start = stack.pop();
    if (nodes * 6 >= box.length) grow();
    const node = nodes++;
    if (patch >= 0) a[patch] = node;      // this is the right child of `patch`
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let cMinX = Infinity, cMinY = Infinity, cMinZ = Infinity, cMaxX = -Infinity, cMaxY = -Infinity, cMaxZ = -Infinity;
    for (let k = start; k < end; k++) {
      const i = order[k];
      bounds(i, tmp);
      if (tmp[0] < minX) minX = tmp[0]; if (tmp[1] < minY) minY = tmp[1]; if (tmp[2] < minZ) minZ = tmp[2];
      if (tmp[3] > maxX) maxX = tmp[3]; if (tmp[4] > maxY) maxY = tmp[4]; if (tmp[5] > maxZ) maxZ = tmp[5];
      const cx = (tmp[0] + tmp[3]) / 2, cy = (tmp[1] + tmp[4]) / 2, cz = (tmp[2] + tmp[5]) / 2;
      if (cx < cMinX) cMinX = cx; if (cx > cMaxX) cMaxX = cx;
      if (cy < cMinY) cMinY = cy; if (cy > cMaxY) cMaxY = cy;
      if (cz < cMinZ) cMinZ = cz; if (cz > cMaxZ) cMaxZ = cz;
    }
    box[node * 6] = minX; box[node * 6 + 1] = minY; box[node * 6 + 2] = minZ;
    box[node * 6 + 3] = maxX; box[node * 6 + 4] = maxY; box[node * 6 + 5] = maxZ;
    const n = end - start;
    if (n <= LEAF) { a[node] = start; b[node] = n; continue; }
    // Split where the centres are widest, at the middle of their spread.
    const dx = cMaxX - cMinX, dy = cMaxY - cMinY, dz = cMaxZ - cMinZ;
    const axis = dx >= dy && dx >= dz ? 0 : (dy >= dz ? 1 : 2);
    const cut = axis === 0 ? (cMinX + cMaxX) / 2 : axis === 1 ? (cMinY + cMaxY) / 2 : (cMinZ + cMaxZ) / 2;
    let i = start, j = end - 1;
    while (i <= j) {
      if (centre(order[i], axis) < cut) i++;
      else { const t = order[i]; order[i] = order[j]; order[j] = t; j--; }
    }
    // Centres all in one place: halve the list so the tree still ends.
    let mid = i;
    if (mid === start || mid === end) mid = start + (n >> 1);
    b[node] = 0;
    stack.push(mid, end, node);     // right, patched into a[node] when it is laid out
    stack.push(start, mid, -1);     // left comes straight after this node
  }
  return { box: box.subarray(0, nodes * 6), a: a.subarray(0, nodes), b: b.subarray(0, nodes), order, nodes };
}

// Visit every leaf whose box the ray (origin o, direction d, both arrays of 3) passes through
// within `pad` of. `leaf(start, count)` gets a run of `order`.
export function walkRay(tree, o, d, pad, leaf) {
  const { box, a, b } = tree;
  if (!tree.nodes) return;
  const ix = 1 / d[0], iy = 1 / d[1], iz = 1 / d[2];
  const stack = [0];
  while (stack.length) {
    const node = stack.pop(), k = node * 6;
    let t0 = ((ix >= 0 ? box[k] - pad : box[k + 3] + pad) - o[0]) * ix, t1 = ((ix >= 0 ? box[k + 3] + pad : box[k] - pad) - o[0]) * ix;
    const ty0 = ((iy >= 0 ? box[k + 1] - pad : box[k + 4] + pad) - o[1]) * iy, ty1 = ((iy >= 0 ? box[k + 4] + pad : box[k + 1] - pad) - o[1]) * iy;
    if (t0 > ty1 || ty0 > t1) continue;
    if (ty0 > t0 || t0 !== t0) t0 = ty0;
    if (ty1 < t1 || t1 !== t1) t1 = ty1;
    const tz0 = ((iz >= 0 ? box[k + 2] - pad : box[k + 5] + pad) - o[2]) * iz, tz1 = ((iz >= 0 ? box[k + 5] + pad : box[k + 2] - pad) - o[2]) * iz;
    if (t0 > tz1 || tz0 > t1) continue;
    if (tz1 < t1 || t1 !== t1) t1 = tz1;
    if (t1 < 0) continue;           // the box is behind the ray
    if (b[node]) leaf(a[node], b[node]);
    else { stack.push(a[node]); stack.push(node + 1); }
  }
}


// The tree over a mesh's triangles: `positions` with `stride` numbers per vertex starting at
// `offset`, and `index` (three vertex numbers per triangle) or null for a plain triangle list.
export function triangleTreeFrom(positions, stride, offset, index, vertices) {
  const P = positions, I = index;
  const count = Math.floor((I ? I.length : vertices) / 3);
  const vx = (v, axis) => P[v * stride + offset + axis];
  const bounds = (t, out) => {
    const i0 = I ? I[t * 3] : t * 3, i1 = I ? I[t * 3 + 1] : t * 3 + 1, i2 = I ? I[t * 3 + 2] : t * 3 + 2;
    for (let k = 0; k < 3; k++) {
      const p = vx(i0, k), q = vx(i1, k), r = vx(i2, k);
      out[k] = p < q ? (p < r ? p : r) : (q < r ? q : r);
      out[k + 3] = p > q ? (p > r ? p : r) : (q > r ? q : r);
    }
  };
  const centre = (t, axis) => {
    const i0 = I ? I[t * 3] : t * 3, i1 = I ? I[t * 3 + 1] : t * 3 + 1, i2 = I ? I[t * 3 + 2] : t * 3 + 2;
    const p = vx(i0, axis), q = vx(i1, axis), r = vx(i2, axis);
    return ((p < q ? (p < r ? p : r) : (q < r ? q : r)) + (p > q ? (p > r ? p : r) : (q > r ? q : r))) / 2;
  };
  return buildTree(count, bounds, centre);
}
// The tree over a cloud's points (three numbers per point).
export function pointTreeFrom(positions, count) {
  const P = positions;
  const bounds = (i, out) => { out[0] = out[3] = P[i * 3]; out[1] = out[4] = P[i * 3 + 1]; out[2] = out[5] = P[i * 3 + 2]; };
  return buildTree(count, bounds, (i, axis) => P[i * 3 + axis]);
}

// ---------- as the background helper ----------
// One geometry per message, its vertices in, its tree out, nothing copied on the way back.
if (typeof globalThis.WorkerGlobalScope === 'function' && globalThis instanceof globalThis.WorkerGlobalScope) {
  globalThis.onmessage = e => {
    const { id, kind, positions, stride, offset, index, count } = e.data;
    try {
      const tree = kind === 'points' ? pointTreeFrom(positions, count) : triangleTreeFrom(positions, stride, offset, index, count);
      // The arrays are views trimmed to the tree's size: send exact copies of the used part.
      const box = tree.box.slice(), a = tree.a.slice(), b = tree.b.slice();
      globalThis.postMessage({ id, ok: true, box, a, b, order: tree.order, nodes: tree.nodes }, [box.buffer, a.buffer, b.buffer, tree.order.buffer]);
    } catch (err) {
      globalThis.postMessage({ id, ok: false, error: String(err && err.message || err) });
    }
  };
}
