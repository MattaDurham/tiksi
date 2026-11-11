// Pictures saved as files. Photo and video thumbnails, floor-plan underlays, uploaded
// product images and any other large inline data: URL stay data: URLs in the open
// workspace, where every view uses them directly. On the Mac's project files each one is
// stored once, by content, beside the other originals, and the saved records carry a short
// reference instead: `tiksi-picture:<mime>:pic-<sha256>`. The reference names the exact
// bytes, so a picture that did not change is never sent again, and loading turns it back
// into the identical data: URL (same bytes, same text).
//
// The open workspace may still hold a reference when its file could not be read; it is
// kept as it is, so a save never drops a picture it could not show.

export const PICTURE_PREFIX = 'tiksi-picture:';
const REF = /^tiksi-picture:([a-z0-9.+-]+\/[a-z0-9.+-]+):(pic-[a-f0-9]{64})$/;
const DATA_URL = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/;
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
// Smaller inline values (an icon, a blank pixel) are cheaper to leave in the record.
export const MIN_PICTURE_CHARS = 1024;

export function isPictureRef(value) { return typeof value === 'string' && value.startsWith(PICTURE_PREFIX) && REF.test(value); }
export function parsePictureRef(value) {
  const m = typeof value === 'string' && REF.exec(value);
  return m ? { mime: m[1], id: m[2], hash: m[2].slice(4) } : null;
}
export function pictureRef(mime, hash) { return PICTURE_PREFIX + mime + ':pic-' + hash; }
const candidate = v => typeof v === 'string' && v.length >= MIN_PICTURE_CHARS && v.startsWith('data:');

// A data: URL whose base64 text is canonical, so its bytes encode back to the same text.
// Returns { mime, base64 } or null (a value that stays inline).
export function parseDataUrl(url) {
  const m = DATA_URL.exec(url);
  if (!m) return null;
  const b64 = m[2];
  if (b64.length % 4) return null;
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  if (pad && b64.length < 4) return null;
  const last = B64.indexOf(b64[b64.length - 1 - pad]);
  if (pad === 2 && (last & 15)) return null;
  if (pad === 1 && (last & 3)) return null;
  return { mime: m[1], base64: b64 };
}

export async function dataUrlBytes(url) {
  return new Uint8Array(await (await fetch(url)).arrayBuffer());
}

export async function bytesToDataUrl(bytes, mime) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (typeof FileReader !== 'undefined' && typeof Blob !== 'undefined') {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('Could not read a picture'));
      reader.readAsDataURL(new Blob([u8], { type: mime }));
    });
  }
  return 'data:' + mime + ';base64,' + Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString('base64');
}

// Every picture reference in a value: id -> mime.
export function pictureRefs(value, out = new Map()) {
  const stack = [value];
  while (stack.length) {
    const v = stack.pop();
    if (typeof v === 'string') { if (v.startsWith(PICTURE_PREFIX)) { const r = parsePictureRef(v); if (r) out.set(r.id, r.mime); } }
    else if (Array.isArray(v)) { for (const x of v) if (x && typeof x === 'object' || typeof x === 'string') stack.push(x); }
    else if (v && typeof v === 'object') { for (const k in v) { const x = v[k]; if (x && typeof x === 'object' || typeof x === 'string') stack.push(x); } }
  }
  return out;
}

// A JSON-shaped copy of `value` whose strings pass through `map`. Undefined object fields
// are left out, as JSON would. Every object and array is new, so later edits to the
// original never reach the copy.
export function mapStrings(value, map) {
  if (typeof value === 'string') return map(value);
  if (Array.isArray(value)) { const out = new Array(value.length); for (let i = 0; i < value.length; i++) out[i] = mapStrings(value[i], map); return out; }
  if (value && typeof value === 'object') {
    if (typeof value.toJSON === 'function') return mapStrings(value.toJSON(), map);
    const out = {};
    for (const k in value) { const v = value[k]; if (v !== undefined && typeof v !== 'function') out[k] = mapStrings(v, map); }
    return out;
  }
  return value;
}

// Replace picture references in a bundle's records with data: URLs read from the bundle's
// own files (`bytesOf(id)` -> Uint8Array | null). Returns the ids it could not find.
export async function inlineBundlePictures(data, bytesOf) {
  const urls = new Map(), missing = [];
  for (const [id, mime] of pictureRefs(data)) {
    const bytes = bytesOf(id);
    if (bytes) urls.set(id, await bytesToDataUrl(bytes, mime)); else missing.push(id);
  }
  if (urls.size) replaceInPlace(data, s => { const r = s.startsWith(PICTURE_PREFIX) && parsePictureRef(s); return r && urls.has(r.id) ? urls.get(r.id) : s; });
  return missing;
}

function replaceInPlace(node, map) {
  if (Array.isArray(node)) { for (let i = 0; i < node.length; i++) { const v = node[i]; if (typeof v === 'string') node[i] = map(v); else if (v && typeof v === 'object') replaceInPlace(v, map); } }
  else if (node && typeof node === 'object') for (const k in node) { const v = node[k]; if (typeof v === 'string') node[k] = map(v); else if (v && typeof v === 'object') replaceInPlace(v, map); }
}

// The disk client's picture files. `upload(bytes)` stores bytes and answers { hash, size };
// `download(hash)` answers the stored bytes (Uint8Array or ArrayBuffer).
export function pictureFiles({ upload, download, concurrency = 6 }) {
  const refByUrl = new Map();   // inline data: URL -> reference, or null when it stays inline
  const urlByRef = new Map();   // reference -> data: URL
  const assetById = new Map();  // pic-<hash> -> { hash, size, mime, kind }

  function remember(url, ref, asset) {
    refByUrl.set(url, ref); urlByRef.set(ref, url);
    if (asset) assetById.set(parsePictureRef(ref).id, asset);
  }

  // The saved form of `data`: a fresh copy with every known picture replaced by its
  // reference. Pictures not stored yet stay inline and are listed in `unknown`.
  function slim(data) {
    const unknown = new Set(), ids = new Set();
    const copy = mapStrings(data, s => {
      if (s.startsWith(PICTURE_PREFIX)) { const r = parsePictureRef(s); if (r) ids.add(r.id); return s; }
      if (!candidate(s)) return s;
      const ref = refByUrl.get(s);
      if (ref === undefined) { unknown.add(s); return s; }
      if (ref === null) return s;
      ids.add(parsePictureRef(ref).id);
      return ref;
    });
    return { data: copy, unknown, ids };
  }

  // Store pictures that have no file yet. Values that would not come back as the same
  // text (an unusual header, non-canonical base64) are marked to stay inline.
  async function store(urls) {
    await pool([...urls], concurrency, async url => {
      if (refByUrl.has(url)) return;
      const parsed = parseDataUrl(url);
      if (!parsed) { refByUrl.set(url, null); return; }
      const bytes = await dataUrlBytes(url);
      const saved = await upload(bytes);
      if (!saved || saved.size !== bytes.byteLength) throw new Error('A picture upload was incomplete');
      remember(url, pictureRef(parsed.mime, saved.hash), { hash: saved.hash, size: saved.size, mime: parsed.mime, kind: 'picture' });
    });
  }

  // slim(getData()) after storing every picture it holds; edits made while uploading
  // are picked up by the next round.
  async function slimStored(getData, rounds = 4) {
    for (let i = 0; ; i++) {
      const result = slim(getData());
      if (!result.unknown.size || i === rounds) return result;
      await store(result.unknown);
    }
  }

  // Download every picture saved `data` references that is not here yet. A reference
  // whose file cannot be read stays a reference (see the top of this file).
  async function fetchMissing(data, assets) {
    for (const [id, asset] of Object.entries(assets || {})) if (id.startsWith('pic-') && asset && typeof asset.hash === 'string') assetById.set(id, asset);
    const wanted = [...pictureRefs(data)].map(([id, mime]) => PICTURE_PREFIX + mime + ':' + id).filter(ref => !urlByRef.has(ref));
    const failed = [];
    await pool(wanted, concurrency, async ref => {
      const { mime, id, hash } = parsePictureRef(ref);
      try {
        const bytes = new Uint8Array(await download(hash));
        const url = await bytesToDataUrl(bytes, mime);
        remember(url, ref, { ...(assetById.get(id) || {}), hash, size: bytes.byteLength, mime, kind: 'picture' });
      } catch (error) { failed.push(ref); console.warn('picture file unavailable:', ref, error.message); }
    });
    return failed;
  }

  // The open form of saved `data`: a fresh copy with every downloaded picture inline.
  function inflate(data) {
    return mapStrings(data, s => s.startsWith(PICTURE_PREFIX) ? urlByRef.get(s) || s : s);
  }

  // Manifest entries for the pictures a saved copy references.
  function assetsFor(ids) {
    const out = {};
    for (const id of ids) { const a = assetById.get(id); if (a) out[id] = { hash: a.hash, size: a.size, mime: a.mime, kind: 'picture' }; }
    return out;
  }

  // Drop remembered pictures that neither saved copy nor open workspace still uses.
  function forget(keepIds) {
    for (const [url, ref] of refByUrl) {
      if (ref && keepIds.has(parsePictureRef(ref).id)) continue;
      refByUrl.delete(url); if (ref) urlByRef.delete(ref);
    }
    for (const id of assetById.keys()) if (!keepIds.has(id)) assetById.delete(id);
  }

  // Put pictures that have arrived since into records that are already open, in place.
  // Returns how many references were filled.
  function fill(data) {
    let filled = 0;
    replaceInPlace(data, s => { const url = s.startsWith(PICTURE_PREFIX) && urlByRef.get(s); if (!url) return s; filled++; return url; });
    return filled;
  }

  return { slim, store, slimStored, fetchMissing, inflate, fill, assetsFor, forget, get size() { return urlByRef.size; } };
}

async function pool(items, limit, work) {
  let next = 0;
  const errors = [];
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      try { await work(item); } catch (error) { errors.push(error); }
    }
  }));
  if (errors.length) throw errors[0];
}
