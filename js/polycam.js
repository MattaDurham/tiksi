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
