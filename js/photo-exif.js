// The camera data a photo file carries (EXIF), and the lens it implies. Pure: takes bytes,
// returns numbers. Reads JPEG (APP1) and, by searching for the "Exif" header, HEIC/HEIF and
// TIFF-wrapped files too. Only the tags Tiksi uses are read.

const TAGS_IFD0 = { 0x010f: 'make', 0x0110: 'model', 0x0112: 'orientation', 0x8769: 'exifPointer' };
const TAGS_EXIF = {
  0x920a: 'focalLength', 0xa405: 'focal35', 0xa434: 'lensModel', 0x9003: 'dateTimeOriginal',
  0x9011: 'offsetTimeOriginal', 0x9291: 'subsecTimeOriginal', 0xa002: 'pixelW', 0xa003: 'pixelH',
};
const DIAG_35MM = Math.hypot(36, 24);   // 43.27 mm: the 35 mm-equivalent is defined on the diagonal

// The TIFF block inside the file: after "Exif\0\0" in JPEG APP1 or HEIC, or the file itself.
function tiffStart(u8) {
  if (u8.length < 8) return -1;
  const isTiff = i => (u8[i] === 0x49 && u8[i + 1] === 0x49 && u8[i + 2] === 0x2a && u8[i + 3] === 0)
    || (u8[i] === 0x4d && u8[i + 1] === 0x4d && u8[i + 2] === 0 && u8[i + 3] === 0x2a);
  if (isTiff(0)) return 0;
  const limit = Math.min(u8.length - 10, 4 * 1024 * 1024);
  for (let i = 0; i < limit; i++) {
    if (u8[i] === 0x45 && u8[i + 1] === 0x78 && u8[i + 2] === 0x69 && u8[i + 3] === 0x66 && u8[i + 4] === 0 && u8[i + 5] === 0 && isTiff(i + 6)) return i + 6;
  }
  return -1;
}

// { make, model, orientation, focalLength (mm), focal35 (mm), lensModel, pixelW, pixelH,
//   takenAt (ISO 8601 with the camera's offset when it recorded one, else local time without zone) }
// or null when the file carries no EXIF.
export function readExif(buffer) {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const t = tiffStart(u8);
  if (t < 0) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset + t, u8.length - t);
  const le = dv.getUint8(0) === 0x49;
  const u16 = o => dv.getUint16(o, le), u32 = o => dv.getUint32(o, le);
  const out = {};
  const SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
  function value(entry) {
    const type = u16(entry + 2), count = u32(entry + 4), size = (SIZES[type] || 1) * count;
    const at = size <= 4 ? entry + 8 : u32(entry + 8);
    if (at + size > dv.byteLength) return undefined;
    if (type === 2) { let s = ''; for (let i = 0; i < count; i++) { const c = dv.getUint8(at + i); if (!c) break; s += String.fromCharCode(c); } return s.trim(); }
    if (type === 3) return u16(at);
    if (type === 4) return u32(at);
    if (type === 5 || type === 10) { const n = type === 5 ? u32(at) : dv.getInt32(at, le), d = type === 5 ? u32(at + 4) : dv.getInt32(at + 4, le); return d ? n / d : undefined; }
    return undefined;
  }
  function ifd(offset, tags) {
    if (offset < 8 || offset + 2 > dv.byteLength) return;
    const n = u16(offset);
    for (let i = 0; i < n; i++) {
      const e = offset + 2 + i * 12;
      if (e + 12 > dv.byteLength) return;
      const name = tags[u16(e)];
      if (!name) continue;
      try { const v = value(e); if (v !== undefined && v !== '') out[name] = v; } catch (err) { /* a damaged tag is skipped */ }
    }
  }
  try { ifd(u32(4), TAGS_IFD0); if (out.exifPointer) ifd(out.exifPointer, TAGS_EXIF); }
  catch (e) { return Object.keys(out).length ? tidy(out) : null; }
  return tidy(out);
}

function tidy(o) {
  delete o.exifPointer;
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(o.dateTimeOriginal || '');
  if (m) {
    const sub = /^\d+$/.test(String(o.subsecTimeOriginal || '')) ? '.' + String(o.subsecTimeOriginal).padEnd(3, '0').slice(0, 3) : '';
    const off = /^[+-]\d{2}:\d{2}$/.test(o.offsetTimeOriginal || '') ? o.offsetTimeOriginal : '';
    o.takenAt = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${sub}${off}`;
  }
  delete o.dateTimeOriginal; delete o.subsecTimeOriginal; delete o.offsetTimeOriginal;
  for (const k of ['focalLength', 'focal35']) if (!(o[k] > 0)) delete o[k];
  if (!(o.orientation >= 1 && o.orientation <= 8)) delete o.orientation;
  return o;
}

// Milliseconds since the epoch for an EXIF takenAt, or NaN. A time without a zone is read as UTC
// so two times from the same camera still compare; give `defaultOffset` ('-04:00') to place it.
export function takenAtMs(takenAt, defaultOffset = 'Z') {
  if (typeof takenAt !== 'string' || !takenAt) return NaN;
  const zoned = /[zZ]|[+-]\d{2}:\d{2}$/.test(takenAt) ? takenAt : takenAt + defaultOffset;
  return Date.parse(zoned);
}

// The lens for an image shown at w x h pixels (after the phone's rotation), from the
// 35 mm-equivalent focal length: { fx, fy, cx, cy, hfov, vfov, f35, source } or null.
export function lensFromExif(exif, w, h) {
  if (!exif || !(w > 0) || !(h > 0) || !(exif.focal35 > 0)) return null;
  const fx = exif.focal35 * Math.hypot(w, h) / DIAG_35MM;
  return lensFromIntrinsics(fx, fx, w / 2, h / 2, w, h, { f35: exif.focal35, source: 'exif' });
}

export function lensFromIntrinsics(fx, fy, cx, cy, w, h, extra) {
  const deg = r => r * 180 / Math.PI;
  return Object.assign({ fx, fy, cx, cy, w, h, hfov: deg(2 * Math.atan(w / (2 * fx))), vfov: deg(2 * Math.atan(h / (2 * fy))) }, extra || {});
}
