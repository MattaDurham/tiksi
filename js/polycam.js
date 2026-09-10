// Polycam share links. A capture shared from the app has a public page at
// poly.cam/capture/<id> (and an embeddable viewer at /capture/<id>/embed). This module
// recognises those links, reads what the share page exposes (title, cover image, a
// downloadable model) and fetches the model bytes, all from the browser and with nothing
// but the public link ever leaving it.
//
// Two things stand between a link and the bytes. Polycam does not promise a model file on
// the share page, and browsers refuse to read another site's page unless that site allows
// it (CORS). So every fetch tries the direct route first and, when the user allows it,
// falls back to a public relay that adds the missing permission: the relay sees the public
// URL and returns the public bytes, nothing else. When neither works the caller falls back
// to the file the user downloads from Polycam themselves.

const POLYCAM_HOSTS = /(^|\.)poly\.cam$/i;
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])$/i;
const URL_IN_TEXT = /https?:\/\/[^\s<>"'`]+/i;
const CAPTURE_PATH = /\/capture\/([0-9a-z][0-9a-z-]{5,})/i;
const ASSET_EXT = /\.(glb|gltf|ply|obj|splat|spz|ksplat|las|laz|usdz|zip)(?=$|[?#])/i;
const ASSET_RANK = { glb: 100, gltf: 90, ply: 80, obj: 70, spz: 60, splat: 58, ksplat: 56, las: 40, laz: 20, usdz: 5, zip: 3 };

export const DEFAULT_RELAYS = [
  'https://api.allorigins.win/raw?url={url}',
  'https://corsproxy.io/?url={url}',
];
const FETCH_TIMEOUT_MS = 45000;
const DOWNLOAD_TIMEOUT_MS = 8 * 60 * 1000;
const MAX_BYTES = 600 * 1024 * 1024;

// { url, captureId, origin, embedUrl, host } for a Polycam capture link found in `text`, else null.
export function parseCaptureUrl(text) {
  const m = String(text || '').match(URL_IN_TEXT);
  if (!m) return null;
  let u;
  try { u = new URL(m[0].replace(/[.,;:)\]]+$/, '')); } catch (e) { return null; }
  const host = u.hostname.toLowerCase();
  if (!POLYCAM_HOSTS.test(host) && !LOOPBACK.test(host)) return null;
  const pm = u.pathname.match(CAPTURE_PATH);
  if (!pm) return null;
  const captureId = pm[1];
  const base = u.origin + '/capture/' + captureId;
  return { url: base, captureId, origin: u.origin, embedUrl: base + '/embed', host, local: LOOPBACK.test(host) };
}

export function isPolycamLink(text) { return !!parseCaptureUrl(text); }

export function relayUrl(template, url) {
  const t = String(template || '').trim();
  if (!t) return null;
  return t.includes('{url}') ? t.replace('{url}', encodeURIComponent(url)) : t + encodeURIComponent(url);
}

// Which relays to use: 'off' -> none, 'auto' or empty -> the defaults, anything else -> that template.
export function relaysFor(setting) {
  const s = String(setting || 'auto').trim();
  if (s === 'off') return [];
  if (s === 'auto' || !s) return DEFAULT_RELAYS.slice();
  return [s];
}

function withTimeout(ms, signal) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(new Error('timed out after ' + Math.round(ms / 1000) + ' s')), ms);
  if (signal) signal.addEventListener('abort', () => ctl.abort(signal.reason), { once: true });
  return { signal: ctl.signal, done: () => clearTimeout(t) };
}

// Fetch `url` directly, then through each relay. Resolves { response, via } or throws the
// last error with `.attempts` describing every route tried.
export async function fetchVia(url, opts) {
  opts = opts || {};
  const relays = opts.relays || [];
  const attempts = [];
  const routes = [{ via: 'direct', target: url }].concat(relays.map(r => ({ via: r, target: relayUrl(r, url) })).filter(r => r.target));
  for (const route of routes) {
    if (opts.signal && opts.signal.aborted) throw opts.signal.reason || new Error('cancelled');
    const t = withTimeout(opts.timeout || FETCH_TIMEOUT_MS, opts.signal);
    try {
      if (opts.onRoute) opts.onRoute(route.via);
      const response = await fetch(route.target, { mode: 'cors', credentials: 'omit', redirect: 'follow', signal: t.signal, headers: opts.headers || {} });
      if (!response.ok) { attempts.push({ via: route.via, error: 'HTTP ' + response.status }); t.done(); continue; }
      return { response, via: route.via, attempts, done: t.done };
    } catch (e) {
      t.done();
      // A TypeError is the browser's way of saying CORS or network; the relay may get through.
      attempts.push({ via: route.via, error: e && e.name === 'AbortError' ? String(e.message || 'timed out') : (e && e.message) || String(e) });
    }
  }
  const err = new Error(attempts.length ? attempts.map(a => (a.via === 'direct' ? 'direct' : 'relay') + ': ' + a.error).join('; ') : 'no route');
  err.attempts = attempts;
  err.blocked = attempts.every(a => /Failed to fetch|NetworkError|Load failed|timed out|HTTP 4|HTTP 5/i.test(a.error));
  throw err;
}

// Read a response body with progress; content-length may be missing (chunked or relayed).
export async function readBody(response, onProgress, limit) {
  const total = +(response.headers.get('content-length') || 0) || 0;
  if (!response.body || !response.body.getReader) {
    const buf = await response.arrayBuffer();
    if (onProgress) onProgress(buf.byteLength, buf.byteLength);
    return buf;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.byteLength;
    if (got > (limit || MAX_BYTES)) { reader.cancel(); throw new Error('file is larger than ' + Math.round((limit || MAX_BYTES) / 1048576) + ' MB'); }
    if (onProgress) onProgress(got, total);
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out.buffer;
}

// ---------- share page ----------
function unescapeJsonish(s) {
  return s.replace(/\\u0026/g, '&').replace(/\\u003d/gi, '=').replace(/\\u002f/gi, '/').replace(/\\\//g, '/').replace(/&amp;/g, '&').replace(/\\"/g, '"');
}
function meta(html, prop) {
  const re = new RegExp('<meta[^>]+(?:property|name)=["\']' + prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '["\'][^>]*content=["\']([^"\']*)["\']', 'i');
  const re2 = new RegExp('<meta[^>]+content=["\']([^"\']*)["\'][^>]*(?:property|name)=["\']' + prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '["\']', 'i');
  const m = html.match(re) || html.match(re2);
  return m ? decodeEntities(m[1]) : '';
}
function decodeEntities(s) {
  return String(s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n));
}
function cleanTitle(t) {
  return String(t || '').replace(/\s*[|–—-]\s*Polycam.*$/i, '').replace(/\s+/g, ' ').trim();
}

// Everything useful the page carries. Assets are ranked by how loadable they are here.
export function parseCapturePage(html, link) {
  html = String(html || '');
  const text = unescapeJsonish(html);
  const title = cleanTitle(meta(html, 'og:title') || (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || '');
  const image = meta(html, 'og:image') || meta(html, 'twitter:image');
  const description = meta(html, 'og:description') || meta(html, 'description');
  const seen = new Map();
  const consider = (raw, bonus) => {
    let u = String(raw || '').trim();
    if (!u || u.length > 2000) return;
    if (u.startsWith('//')) u = 'https:' + u;
    else if (u.startsWith('/')) u = (link && link.origin ? link.origin : '') + u;
    if (!/^https?:\/\//i.test(u)) return;
    const em = u.match(ASSET_EXT);
    const ext = em ? em[1].toLowerCase() : '';
    if (!ext && !bonus) return;
    let score = (ASSET_RANK[ext] || 0) + (bonus || 0);
    if (link && link.captureId && u.includes(link.captureId)) score += 15;
    if (/textured|texture|mesh|model|decimated/i.test(u)) score += 5;
    if (/thumb|preview|poster/i.test(u)) score -= 30;
    if (/\.(jpe?g|png|webp|mp4)(?=$|[?#])/i.test(u)) return;
    const prev = seen.get(u);
    if (!prev || prev.score < score) seen.set(u, { url: u, ext: ext || 'bin', score });
  };
  const urlRe = /https?:\/\/[^\s"'<>\\)]+?\.(?:glb|gltf|ply|obj|splat|spz|ksplat|las|laz|usdz|zip)(?:\?[^\s"'<>\\)]*)?/gi;
  for (const m of text.matchAll(urlRe)) consider(m[0], 0);
  const keyRe = /"((?:glb|gltf|mesh|model|textured|download|asset)[A-Za-z0-9_]*(?:Url|URL|url|Uri|Href|href))"\s*:\s*"([^"]+)"/g;
  for (const m of text.matchAll(keyRe)) consider(m[2], /glb|gltf/i.test(m[1]) ? 20 : 8);
  const assets = Array.from(seen.values()).sort((a, b) => b.score - a.score);
  return { title, image, description, assets };
}

export function fileNameFromUrl(url, fallback) {
  try {
    const u = new URL(url);
    const base = decodeURIComponent(u.pathname.split('/').pop() || '');
    if (base && /\.[a-z0-9]{2,6}$/i.test(base)) return base.replace(/[^\w.\- ]+/g, '_');
  } catch (e) { /* not a URL */ }
  return fallback;
}

// Resolve a link to { title, image, description, assets, via }. The share page comes
// first; when it names no model, the lighter embed page is read too (same capture, a
// viewer-only document that has to reference the model it draws).
export async function resolveCapture(link, opts) {
  opts = opts || {};
  let page = null, lastErr = null;
  for (const url of [link.url, link.embedUrl]) {
    try {
      const { response, via, done } = await fetchVia(url, { relays: opts.relays, signal: opts.signal, onRoute: opts.onRoute, timeout: FETCH_TIMEOUT_MS });
      let html;
      try { html = await response.text(); } finally { done(); }
      const p = parseCapturePage(html, link);
      p.via = via;
      if (!page) page = p;
      else { if (!page.title) page.title = p.title; if (!page.image) page.image = p.image; page.assets = p.assets; }
      if (page.assets.length) break;
    } catch (e) {
      if (opts.signal && opts.signal.aborted) throw e;
      lastErr = e;
      if (page) break;   // the share page read fine and just named no model: the embed failing is not news
    }
  }
  if (!page) throw lastErr || new Error('could not read the share page');
  return page;
}

// Download an asset to an ArrayBuffer with progress, direct then relayed.
export async function downloadAsset(asset, link, opts) {
  opts = opts || {};
  const name = fileNameFromUrl(asset.url, 'polycam-' + (link ? link.captureId.slice(0, 8) : 'capture') + '.' + (asset.ext === 'bin' ? 'glb' : asset.ext));
  const { response, via, done } = await fetchVia(asset.url, { relays: opts.relays, signal: opts.signal, onRoute: opts.onRoute, timeout: DOWNLOAD_TIMEOUT_MS });
  let buffer;
  try { buffer = await readBody(response, opts.onProgress); } finally { done(); }
  if (!buffer.byteLength) throw new Error('empty file');
  // A relay that answers with an HTML error page instead of the model must not become a scan.
  const head = new Uint8Array(buffer, 0, Math.min(16, buffer.byteLength));
  const ascii = String.fromCharCode.apply(null, head);
  if (/^\s*<(!doctype|html)/i.test(ascii)) throw new Error('the route returned a web page instead of the model');
  return { buffer, name, via, size: buffer.byteLength };
}

// Cover image as a File, or null when nothing could read it (never fatal).
export async function fetchCover(url, opts) {
  if (!url) return null;
  try {
    const { response, done } = await fetchVia(url, { relays: (opts && opts.relays) || [], signal: opts && opts.signal, timeout: 20000 });
    let blob;
    try { blob = await response.blob(); } finally { done(); }
    if (!blob.size || !/^image\//.test(blob.type || '')) return null;
    const ext = (blob.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
    return new File([blob], 'polycam-cover.' + ext, { type: blob.type });
  } catch (e) { return null; }
}

// ---------- direct route: the endpoint Polycam's own viewer uses ----------
// The share page is not readable cross-origin, but the model its viewer draws is:
// /api/capture/<id>/artifacts/raw.gltf (with raw_geometry.bin and textures/*.jpg) redirects
// to Polycam's storage, which answers with open CORS. Fetched first, before any page read
// or relay, so a public capture needs no third party at all. The parts are packed into one
// texture-baked GLB so the scan is a single self-contained file in browser storage.

export function artifactUrl(link, name) {
  return link.origin + '/api/capture/' + link.captureId + '/artifacts/' + name;
}

function decodeDataUri(uri) {
  const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(uri);
  if (!m) throw new Error('unreadable data URI');
  if (!m[2]) return new TextEncoder().encode(decodeURIComponent(m[3])).buffer;
  const bin = atob(m[3]);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

// Rebuild a glTF as a single self-contained GLB: one buffer, base-colour textures embedded,
// other texture slots (normal, occlusion, emissive, metal-rough) dropped.
export function packGlb(gltfIn, buffers, images) {
  const gltf = JSON.parse(JSON.stringify(gltfIn));
  const parts = [];
  let offset = 0;
  const pad4 = () => { const pad = (4 - (offset % 4)) % 4; if (pad) { parts.push(new Uint8Array(pad)); offset += pad; } };
  const bufferOffsets = buffers.map(b => { const o = offset; parts.push(new Uint8Array(b)); offset += b.byteLength; pad4(); return o; });
  gltf.bufferViews = (gltf.bufferViews || []).map(bv => Object.assign({}, bv, { buffer: 0, byteOffset: (bv.byteOffset || 0) + bufferOffsets[bv.buffer || 0] }));
  const keptImages = new Map();
  const newImages = [], newTextures = [];
  for (const m of gltf.materials || []) {
    delete m.normalTexture; delete m.occlusionTexture; delete m.emissiveTexture;
    if (m.pbrMetallicRoughness) delete m.pbrMetallicRoughness.metallicRoughnessTexture;
    const t = m.pbrMetallicRoughness && m.pbrMetallicRoughness.baseColorTexture;
    if (!t) continue;
    const tex = gltf.textures && gltf.textures[t.index];
    const img = tex && images[tex.source];
    if (!img) { delete m.pbrMetallicRoughness.baseColorTexture; continue; }
    if (!keptImages.has(tex.source)) {
      const data = new Uint8Array(img.data);
      gltf.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.byteLength });
      parts.push(data); offset += data.byteLength; pad4();
      keptImages.set(tex.source, newImages.length);
      newImages.push({ bufferView: gltf.bufferViews.length - 1, mimeType: img.mime });
    }
    newTextures.push(Object.assign({}, tex, { source: keptImages.get(tex.source) }));
    t.index = newTextures.length - 1;
  }
  gltf.images = newImages; gltf.textures = newTextures;
  gltf.buffers = [{ byteLength: offset }];
  gltf.asset = Object.assign({}, gltf.asset, { generator: ((gltf.asset && gltf.asset.generator) ? gltf.asset.generator + ' via ' : '') + 'tiksi' });
  const jsonBytes = new TextEncoder().encode(JSON.stringify(gltf));
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const total = 12 + 8 + jsonBytes.length + jsonPad + 8 + offset;
  const out = new ArrayBuffer(total);
  const dv = new DataView(out), u8 = new Uint8Array(out);
  dv.setUint32(0, 0x46546C67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.length + jsonPad, true); dv.setUint32(16, 0x4E4F534A, true);
  u8.set(jsonBytes, 20);
  for (let i = 0; i < jsonPad; i++) u8[20 + jsonBytes.length + i] = 0x20;
  let p = 20 + jsonBytes.length + jsonPad;
  dv.setUint32(p, offset, true); dv.setUint32(p + 4, 0x004E4942, true); p += 8;
  for (const part of parts) { u8.set(part, p); p += part.byteLength; }
  return out;
}

// Fetch the raw mesh straight from Polycam and pack it as a GLB. Resolves
// { buffer, name, size, via: 'direct', textures } or throws (with .status on an HTTP error);
// a 404 means the capture is not shared or has no mesh.
export async function fetchCaptureDirect(link, opts) {
  opts = opts || {};
  const say = opts.onProgress || (() => {});
  const get = async (name, label, limit) => {
    const t = withTimeout(opts.timeout || DOWNLOAD_TIMEOUT_MS, opts.signal);
    try {
      const r = await fetch(artifactUrl(link, name), { mode: 'cors', credentials: 'omit', redirect: 'follow', signal: t.signal });
      if (!r.ok) { const e = new Error(label + ': HTTP ' + r.status); e.status = r.status; throw e; }
      return await readBody(r, (got, total) => say(label, got, total), limit);
    } finally { t.done(); }
  };
  const gltfBuf = await get('raw.gltf', 'the capture index', 8 * 1024 * 1024);
  let gltf;
  try { gltf = JSON.parse(new TextDecoder().decode(gltfBuf)); } catch (e) { throw new Error('the capture index is not glTF'); }
  if (!gltf.buffers || !gltf.meshes || !gltf.meshes.length) throw new Error('the capture has no mesh (point-cloud captures are not supported yet)');
  const buffers = [];
  for (const b of gltf.buffers) {
    if (!b.uri) throw new Error('the capture index references a buffer without a location');
    buffers.push(b.uri.startsWith('data:') ? decodeDataUri(b.uri) : await get(b.uri, 'the mesh (' + (b.byteLength / 1048576).toFixed(1) + ' MB)'));
  }
  // Only base-colour textures are worth carrying (normal maps are large and never shown).
  const wanted = new Set();
  for (const m of gltf.materials || []) {
    const t = m.pbrMetallicRoughness && m.pbrMetallicRoughness.baseColorTexture;
    if (t && gltf.textures && gltf.textures[t.index]) wanted.add(gltf.textures[t.index].source);
  }
  const images = {};
  for (const si of wanted) {
    const img = gltf.images && gltf.images[si];
    if (!img || img.bufferView != null || !img.uri) continue;
    const mime = img.mimeType || (/\.png(?=$|[?#])/i.test(img.uri) ? 'image/png' : 'image/jpeg');
    try { images[si] = { mime, data: img.uri.startsWith('data:') ? decodeDataUri(img.uri) : await get(img.uri, 'the texture') }; }
    catch (e) { if (opts.signal && opts.signal.aborted) throw e; /* untextured is still a scan */ }
  }
  const buffer = packGlb(gltf, buffers, images);
  if (buffer.byteLength < 1024) throw new Error('the packed mesh is empty');
  return { buffer, name: 'polycam-' + link.captureId.slice(0, 8) + '.glb', size: buffer.byteLength, via: 'direct', textures: Object.keys(images).length };
}

// The capture's thumbnail from the same endpoint, as a File; null when it is not there.
export async function fetchCoverDirect(link, opts) {
  const t = withTimeout(20000, opts && opts.signal);
  try {
    const r = await fetch(artifactUrl(link, 'thumbnail.jpg'), { mode: 'cors', credentials: 'omit', redirect: 'follow', signal: t.signal });
    if (!r.ok) return null;
    const blob = await r.blob();
    if (!blob.size || !/^image\//.test(blob.type || '')) return null;
    return new File([blob], 'polycam-cover.jpg', { type: blob.type });
  } catch (e) { return null; }
  finally { t.done(); }
}
