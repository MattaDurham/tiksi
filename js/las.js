// Dependency-free binary parsers for scan files: uncompressed LAS 1.2-1.4 (point formats
// 0-10) and PLY point clouds (ascii / binary, either endianness). Nothing here imports
// three.js on purpose: the same module is loaded inside a Worker (see workerMain) so
// multi-million point files parse without freezing the console.
//
// Output convention: positions are Float32 triplets already in the viewer's frame
// (x east, y up, z south), re-centred so the cloud sits near the origin with its lowest
// point at y = 0; colours are Uint8 RGB triplets or null.

const LAS_RGB_OFFSET = { 2: 20, 3: 28, 5: 28, 7: 30, 8: 30, 10: 30 };

export function isLAS(buffer) {
  if (buffer.byteLength < 227) return false;
  const u = new Uint8Array(buffer, 0, 4);
  return u[0] === 76 && u[1] === 65 && u[2] === 83 && u[3] === 70;   // "LASF"
}

export function lasHeader(buffer) {
  const dv = new DataView(buffer);
  const versionMajor = dv.getUint8(24), versionMinor = dv.getUint8(25);
  const headerSize = dv.getUint16(94, true);
  const offset = dv.getUint32(96, true);
  const formatRaw = dv.getUint8(104);
  const format = formatRaw & 0x3f;
  const compressed = (formatRaw & 0x80) !== 0;
  const recordLength = dv.getUint16(105, true);
  let count = dv.getUint32(107, true);
  if (versionMinor >= 4 && headerSize >= 375) {
    const big = dv.getBigUint64(247, true);
    if (big > 0n) count = Number(big);
  }
  const scale = [dv.getFloat64(131, true), dv.getFloat64(139, true), dv.getFloat64(147, true)];
  const off = [dv.getFloat64(155, true), dv.getFloat64(163, true), dv.getFloat64(171, true)];
  const max = [dv.getFloat64(179, true), dv.getFloat64(195, true), dv.getFloat64(211, true)];
  const min = [dv.getFloat64(187, true), dv.getFloat64(203, true), dv.getFloat64(219, true)];
  return { versionMajor, versionMinor, headerSize, offset, format, compressed, recordLength, count, scale, off, min, max };
}

// opts.onProgress(fraction) is called every ~200k points.
export function parseLAS(buffer, opts) {
  opts = opts || {};
  if (!isLAS(buffer)) throw new Error('Not a LAS file (missing LASF signature)');
  const h = lasHeader(buffer);
  if (h.compressed) throw new Error('LAZ (compressed LAS) needs decompression first; export uncompressed LAS or PLY');
  if (h.format > 10) throw new Error('Unsupported LAS point format ' + h.format);
  const dv = new DataView(buffer);
  const available = Math.floor((buffer.byteLength - h.offset) / h.recordLength);
  const count = Math.max(0, Math.min(h.count || available, available));
  const rgbAt = LAS_RGB_OFFSET[h.format];
  const positions = new Float32Array(count * 3);
  const colors = new Uint8Array(count * 3);
  // Re-centre in double precision: UTM-scale coordinates would lose centimetres in float32.
  const cx = (h.min[0] + h.max[0]) / 2, cy = (h.min[1] + h.max[1]) / 2, cz = h.min[2];
  const useHeaderCentre = isFinite(cx) && isFinite(cy) && isFinite(cz) && h.max[0] >= h.min[0];
  let ox = 0, oy = 0, oz = 0;
  if (useHeaderCentre) { ox = cx; oy = cy; oz = cz; }
  else if (count) {
    ox = dv.getInt32(h.offset, true) * h.scale[0] + h.off[0];
    oy = dv.getInt32(h.offset + 4, true) * h.scale[1] + h.off[1];
    oz = dv.getInt32(h.offset + 8, true) * h.scale[2] + h.off[2];
  }
  let maxRgb = 0, maxI = 1;
  let p = h.offset;
  for (let i = 0; i < count; i++, p += h.recordLength) {
    const x = dv.getInt32(p, true) * h.scale[0] + h.off[0] - ox;
    const y = dv.getInt32(p + 4, true) * h.scale[1] + h.off[1] - oy;
    const z = dv.getInt32(p + 8, true) * h.scale[2] + h.off[2] - oz;
    positions[i * 3] = x; positions[i * 3 + 1] = z; positions[i * 3 + 2] = -y;   // LAS z-up -> y-up, north -> -z
    if (rgbAt != null) {
      const r = dv.getUint16(p + rgbAt, true), g = dv.getUint16(p + rgbAt + 2, true), b = dv.getUint16(p + rgbAt + 4, true);
      if (r > maxRgb) maxRgb = r; if (g > maxRgb) maxRgb = g; if (b > maxRgb) maxRgb = b;
      colors[i * 3] = r; colors[i * 3 + 1] = g; colors[i * 3 + 2] = b;   // rescanned below if 16-bit
    } else {
      const inten = dv.getUint16(p + 12, true);
      if (inten > maxI) maxI = inten;
      colors[i * 3] = inten & 0xff; colors[i * 3 + 1] = inten >> 8; colors[i * 3 + 2] = 0;
    }
    if (opts.onProgress && (i & 0x3ffff) === 0) opts.onProgress(i / count);
  }
  if (rgbAt != null) {
    // 16-bit colour: rescan and shift to 8-bit (files written with 8-bit values keep them).
    const shift = maxRgb > 255;
    if (shift) {
      p = h.offset;
      for (let i = 0; i < count; i++, p += h.recordLength) {
        colors[i * 3] = dv.getUint16(p + rgbAt, true) >> 8;
        colors[i * 3 + 1] = dv.getUint16(p + rgbAt + 2, true) >> 8;
        colors[i * 3 + 2] = dv.getUint16(p + rgbAt + 4, true) >> 8;
      }
    }
  } else {
    // Intensity only: a warm grey ramp (stretch to the observed range).
    for (let i = 0; i < count; i++) {
      const inten = colors[i * 3] | (colors[i * 3 + 1] << 8);
      const t = Math.min(1, Math.pow(inten / maxI, 0.6));
      colors[i * 3] = 40 + 210 * t; colors[i * 3 + 1] = 38 + 200 * t; colors[i * 3 + 2] = 34 + 180 * t;
    }
  }
  if (opts.onProgress) opts.onProgress(1);
  return { positions, colors, count, hasColor: rgbAt != null };
}

// ---------- PLY ----------
const PLY_TYPES = {
  char: 1, int8: 1, uchar: 1, uint8: 1, short: 2, int16: 2, ushort: 2, uint16: 2,
  int: 4, int32: 4, uint: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8,
};
function normType(t) {
  return ({ char: 'int8', int8: 'int8', uchar: 'uint8', uint8: 'uint8', short: 'int16', int16: 'int16', ushort: 'uint16', uint16: 'uint16',
    int: 'int32', int32: 'int32', uint: 'uint32', uint32: 'uint32', float: 'float32', float32: 'float32', double: 'float64', float64: 'float64' })[t] || t;
}

export function parsePLYHeader(buffer) {
  const head = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 1 << 16));
  let text = '';
  for (let i = 0; i < head.length; i++) text += String.fromCharCode(head[i]);
  const endIdx = text.indexOf('end_header');
  if (!text.startsWith('ply') || endIdx < 0) throw new Error('Not a PLY file');
  let headerLength = endIdx + 'end_header'.length;
  if (text[headerLength] === '\r') headerLength++;
  if (text[headerLength] === '\n') headerLength++;
  const lines = text.slice(0, endIdx).split(/\r?\n/);
  const out = { format: 'ascii', elements: [], headerLength, isGaussian: false, hasFaces: false };
  let cur = null;
  for (const raw of lines) {
    const t = raw.trim().split(/\s+/);
    if (t[0] === 'format') out.format = t[1];
    else if (t[0] === 'element') { cur = { name: t[1], count: parseInt(t[2], 10) || 0, props: [] }; out.elements.push(cur); }
    else if (t[0] === 'property' && cur) {
      if (t[1] === 'list') cur.props.push({ name: t[4], isList: true, countType: normType(t[2]), itemType: normType(t[3]) });
      else cur.props.push({ name: t[2], type: normType(t[1]) });
    }
  }
  const v = out.elements.find(e => e.name === 'vertex');
  const names = new Set(v ? v.props.map(p => p.name) : []);
  out.isGaussian = names.has('f_dc_0') || names.has('opacity') || names.has('scale_0');
  const f = out.elements.find(e => e.name === 'face');
  out.hasFaces = !!(f && f.count > 0);
  out.vertexCount = v ? v.count : 0;
  return out;
}

function reader(dv, type, little) {
  switch (type) {
    case 'int8': return o => dv.getInt8(o);
    case 'uint8': return o => dv.getUint8(o);
    case 'int16': return o => dv.getInt16(o, little);
    case 'uint16': return o => dv.getUint16(o, little);
    case 'int32': return o => dv.getInt32(o, little);
    case 'uint32': return o => dv.getUint32(o, little);
    case 'float32': return o => dv.getFloat32(o, little);
    case 'float64': return o => dv.getFloat64(o, little);
    default: throw new Error('Unsupported PLY property type ' + type);
  }
}

// Vertices only (faces are skipped); colours from red/green/blue or r/g/b in any width.
export function parsePLYPoints(buffer, header, opts) {
  opts = opts || {};
  header = header || parsePLYHeader(buffer);
  const vert = header.elements.find(e => e.name === 'vertex');
  if (!vert) throw new Error('PLY has no vertex element');
  const count = vert.count;
  const positions = new Float32Array(count * 3);
  const idx = name => vert.props.findIndex(p => p.name === name);
  const ix = idx('x'), iy = idx('y'), iz = idx('z');
  if (ix < 0 || iy < 0 || iz < 0) throw new Error('PLY vertices lack x/y/z');
  let ir = idx('red'), ig = idx('green'), ib = idx('blue');
  if (ir < 0) { ir = idx('r'); ig = idx('g'); ib = idx('b'); }
  const hasColor = ir >= 0 && ig >= 0 && ib >= 0;
  const colors = hasColor ? new Uint8Array(count * 3) : null;
  const colorScale = hasColor ? (vert.props[ir].type === 'float32' || vert.props[ir].type === 'float64' ? 255 : (vert.props[ir].type === 'uint16' ? 1 / 257 : 1)) : 1;
  // Vertex is always the first element in practice; if not, we cannot skip unknown list data cheaply.
  if (header.elements[0] !== vert) throw new Error('PLY vertex element must come first');

  if (header.format === 'ascii') {
    const text = new TextDecoder().decode(new Uint8Array(buffer, header.headerLength));
    let pos = 0, i = 0;
    const n = text.length;
    while (i < count && pos < n) {
      let end = text.indexOf('\n', pos);
      if (end < 0) end = n;
      const line = text.slice(pos, end).trim();
      pos = end + 1;
      if (!line) continue;
      const t = line.split(/\s+/);
      positions[i * 3] = +t[ix]; positions[i * 3 + 1] = +t[iy]; positions[i * 3 + 2] = +t[iz];
      if (hasColor) { colors[i * 3] = +t[ir] * colorScale; colors[i * 3 + 1] = +t[ig] * colorScale; colors[i * 3 + 2] = +t[ib] * colorScale; }
      i++;
      if (opts.onProgress && (i & 0x3ffff) === 0) opts.onProgress(i / count);
    }
  } else {
    const little = header.format === 'binary_little_endian';
    const dv = new DataView(buffer);
    if (vert.props.some(p => p.isList)) throw new Error('PLY vertex list properties are not supported');
    const offsets = []; let stride = 0;
    for (const p of vert.props) { offsets.push(stride); stride += PLY_TYPES[p.type] || 4; }
    const rx = reader(dv, vert.props[ix].type, little), ry = reader(dv, vert.props[iy].type, little), rz = reader(dv, vert.props[iz].type, little);
    const rr = hasColor ? reader(dv, vert.props[ir].type, little) : null;
    const rg = hasColor ? reader(dv, vert.props[ig].type, little) : null;
    const rb = hasColor ? reader(dv, vert.props[ib].type, little) : null;
    const ox = offsets[ix], oy = offsets[iy], oz = offsets[iz];
    const or = offsets[ir], og = offsets[ig], ob = offsets[ib];
    const avail = Math.floor((buffer.byteLength - header.headerLength) / stride);
    const n = Math.min(count, avail);
    let p = header.headerLength;
    for (let i = 0; i < n; i++, p += stride) {
      positions[i * 3] = rx(p + ox); positions[i * 3 + 1] = ry(p + oy); positions[i * 3 + 2] = rz(p + oz);
      if (hasColor) { colors[i * 3] = rr(p + or) * colorScale; colors[i * 3 + 1] = rg(p + og) * colorScale; colors[i * 3 + 2] = rb(p + ob) * colorScale; }
      if (opts.onProgress && (i & 0x3ffff) === 0) opts.onProgress(i / n);
    }
  }
  if (opts.onProgress) opts.onProgress(1);
  return { positions, colors, count, hasColor };
}

// Recentre any point set: x/z about the bounding centre, y so the lowest point sits at 0.
export function recentre(positions) {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  if (!isFinite(minX)) return { shift: [0, 0, 0] };
  const sx = (minX + maxX) / 2, sy = minY, sz = (minZ + maxZ) / 2;
  for (let i = 0; i < positions.length; i += 3) { positions[i] -= sx; positions[i + 1] -= sy; positions[i + 2] -= sz; }
  return { shift: [sx, sy, sz] };
}

// Worker entry: the viewer spawns a module Worker from a Blob that imports this file.
export function workerMain(self) {
  self.onmessage = e => {
    const { id, format, buffer, recentreLas } = e.data;
    const onProgress = f => self.postMessage({ id, progress: f });
    try {
      let res;
      if (format === 'las') res = parseLAS(buffer, { onProgress });
      else res = parsePLYPoints(buffer, null, { onProgress });
      if (recentreLas !== false) res.shift = recentre(res.positions).shift;
      const transfer = [res.positions.buffer];
      if (res.colors) transfer.push(res.colors.buffer);
      self.postMessage({ id, ok: true, positions: res.positions, colors: res.colors, count: res.count, hasColor: res.hasColor, shift: res.shift }, transfer);
    } catch (err) {
      self.postMessage({ id, ok: false, error: err && err.message ? err.message : String(err) });
    }
  };
}
