import { sha256 } from './sha256.js';
// Walk-through videos (MEASURE): originals kept byte for byte like photos, plus a client for
// the local frame service (server/video_frames.py). Without the service, frames come from
// the browser's own player, so static hosting can still review a video it can decode.
//
// Video record: { id, name, mime, byteLength, hash, createdAt, duration, width, height, thumb,
//   playable, notes, analysis: null | { state, seconds, tile, cols, rows, sheets, candidates:
//   [{ t, score, area, elongation, box }], error, analyzedAt } }

import { ws, uid, touch, putFile, getFile, deleteFile } from './store.js';
import { working } from './work-in-progress.js';

export const VIDEO_ACCEPT = '.mp4,.mov,.m4v,video/mp4,video/quicktime,video/x-m4v';
export const MAX_VIDEO_BYTES = 600 * 1024 * 1024;   // the project asset limit
const MIME_BY_EXT = { mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v', qt: 'video/quicktime' };
const THUMB_MAX = 240;
// ISO base media (MP4/QuickTime) files open with one of these boxes at byte 4.
const BOXES = new Set(['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip', 'pnot', 'uuid']);

const ext = name => String(name || '').split('.').pop().toLowerCase();
export function isVideoFile(file) {
  return !!file && (String(file.type || '').startsWith('video/') || /\.(mp4|mov|m4v|qt|avi|mkv|webm|wmv|3gp|mts|m2ts)$/i.test(file.name || ''));
}

// Refuses honestly what Tiksi cannot read; keeps everything it can (even a video this browser
// cannot play: the frame service may still decode it).
// (Counted as work in progress from the first byte read: see work-in-progress.js.)
export function addVideoFromFile(prop, file) { return working(addVideo(prop, file)); }
async function addVideo(prop, file) {
  const kind = ext(file.name);
  if (!MIME_BY_EXT[kind] && !['video/mp4', 'video/quicktime', 'video/x-m4v'].includes(file.type)) throw new Error(file.name + ': only MP4 and MOV videos are supported (convert it to MP4 first)');
  if (file.size > MAX_VIDEO_BYTES) throw new Error(file.name + ': videos over 600 MB cannot be kept in a project; trim it or export it at a lower resolution');
  if (!file.size) throw new Error(file.name + ': the file is empty');
  const header = await file.slice(0, 8).arrayBuffer();
  const buffer = file;
  const box = new TextDecoder('latin1').decode(new Uint8Array(header, Math.min(4, header.byteLength), Math.min(4, Math.max(0, header.byteLength - 4))));
  if (!BOXES.has(box)) throw new Error(file.name + ': not an MP4/MOV video (the file does not start like one; it may be damaged)');
  const mime = MIME_BY_EXT[kind] || file.type;
  const meta = await browserMetadata(file);
  const id = uid('vid');
  await putFile(id, buffer, { name: file.name || 'video', mime, kind: 'video', original: true });
  const rec = {
    id, name: file.name || 'Video', mime, byteLength: file.size, hash: await sha256(buffer), createdAt: new Date().toISOString(),
    duration: meta.duration, width: meta.width, height: meta.height, thumb: meta.thumb, playable: meta.playable, notes: '', analysis: null,
  };
  // A disk save may have replaced the property object while the file was read.
  const live = ws.data?.properties.find(p => p.id === prop.id) || prop;
  live.videos = live.videos || [];
  live.videos.push(rec);
  touch();
  return rec;
}

// Several files at once (PHOTOS drops): every refusal is reported, nothing is dropped silently.
export async function importVideos(target, files) {
  const added = [], failed = [];
  for (const f of files) { try { added.push(await addVideoFromFile(target, f)); } catch (e) { failed.push(e.message || String(e)); } }
  return { added, failed };
}

export async function deleteVideo(prop, id) {
  const v = (prop.videos || []).find(x => x.id === id);
  prop.videos = (prop.videos || []).filter(x => x.id !== id);
  touch();
  // Readings keep their saved frames; the video's server cache is derived and can go.
  try { await deleteFile(id); } catch (e) { console.error('could not delete the video file', e); }
  if (v?.hash) deleteJob(v.hash).catch(() => {});
}

function withTimeout(promise, ms, fallback) { return Promise.race([promise, new Promise(r => setTimeout(() => r(fallback), ms))]); }

// Duration, size and a poster from the browser's decoder, when it has one for this codec.
async function browserMetadata(blob) {
  const none = { duration: null, width: null, height: null, thumb: '', playable: false };
  if (typeof document === 'undefined') return none;
  const url = URL.createObjectURL(blob);
  const video = document.createElement('video');
  video.muted = true; video.preload = 'auto'; video.playsInline = true;
  try {
    const ok = await withTimeout(new Promise(resolve => { video.onloadeddata = () => resolve(true); video.onerror = () => resolve(false); video.src = url; }), 8000, false);
    if (!ok || !video.videoWidth) return none;
    const out = { duration: Number.isFinite(video.duration) ? video.duration : null, width: video.videoWidth, height: video.videoHeight, thumb: '', playable: true };
    await seek(video, Math.min(1, (out.duration || 0) / 2));
    const s = Math.min(1, THUMB_MAX / Math.max(out.width, out.height)), c = document.createElement('canvas');
    c.width = Math.round(out.width * s); c.height = Math.round(out.height * s);
    c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
    out.thumb = c.toDataURL('image/jpeg', 0.75);
    return out;
  } catch (e) { return none; }
  finally { video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url); }
}

export function seek(video, t) {
  return withTimeout(new Promise(resolve => {
    if (Math.abs(video.currentTime - t) < 0.001 && video.readyState >= 2) return resolve(true);
    video.onseeked = () => resolve(true); video.currentTime = t;
  }), 5000, false);
}

// The current frame of a <video> at full resolution, as a JPEG blob.
export function captureVideoFrame(video) {
  const c = document.createElement('canvas');
  c.width = video.videoWidth; c.height = video.videoHeight;
  c.getContext('2d').drawImage(video, 0, 0);
  return new Promise((resolve, reject) => c.toBlob(b => b ? resolve(b) : reject(new Error('The frame could not be captured')), 'image/jpeg', 0.92));
}

export async function videoBlob(v) {
  const rec = await getFile(v.id);
  return rec?.buffer ? new Blob([rec.buffer], { type: v.mime || rec.mime || 'video/mp4' }) : null;
}

// A saved frame is an original of its own: it travels in the .tiksi with the reading.
export async function saveFrameAsset(blob, name) {
  const id = uid('mf');
  await putFile(id, await blob.arrayBuffer(), { name, mime: 'image/jpeg', kind: 'frame', original: true });
  return id;
}

// ---------- the local frame service ----------
let caps = null;
export async function videoCapabilities(refresh) {
  if (caps && !refresh) return caps;
  try {
    const r = await fetch('/api/video/capabilities', { headers: { 'X-Tiksi-Video': '1' } });
    caps = r.ok ? await r.json() : { ffmpeg: false, detail: r.status === 403 ? 'Frame extraction is available only on this Mac or over Tailscale.' : 'The local Tiksi server is not running.' };
  } catch (e) { caps = { ffmpeg: false, detail: 'Frame extraction needs the local Tiksi server (python3 tools/serve.py) and ffmpeg.' }; }
  if (!caps.ffmpeg && !caps.detail) caps.detail = 'Frame extraction is unavailable.';
  return caps;
}

async function call(path, opts = {}) {
  const c = await videoCapabilities();
  if (!c.ffmpeg) throw new Error(c.detail);
  const r = await fetch('/api/video' + path, { ...opts, headers: { 'X-Tiksi-Video': '1', 'X-Tiksi-Token': c.token, ...(opts.headers || {}) } });
  if (r.status === 403 && !opts.retried) { caps = null; return call(path, { ...opts, retried: true }); }   // the server restarted
  if (!r.ok) {
    let info = {}; try { info = await r.json(); } catch (e) { /* not JSON */ }
    throw Object.assign(new Error(info.error || 'Video service error ' + r.status), { status: r.status });
  }
  return r;
}

// Opens (or creates) the analysis of a video; uploads only when this Mac lacks its bytes.
export async function openJob(v) {
  if (v.hash) {
    const known = await (await call('/jobs', { method: 'POST', headers: { 'X-Video-Hash': v.hash } })).json();
    if (!known.upload) return known;
  }
  const rec = await getFile(v.id);
  if (!rec?.buffer) throw new Error('The original video is not on this device; open the project where it was added.');
  const job = await (await call('/jobs', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', ...(v.hash ? { 'X-Video-Hash': v.hash } : {}) }, body: rec.buffer })).json();
  if (!v.hash) { v.hash = job.id; touch(); }
  return job;
}
export async function jobStatus(hash) { return (await call('/jobs/' + hash)).json(); }
export async function deleteJob(hash) { await call('/jobs/' + hash, { method: 'DELETE' }); }
export async function cancelJobs() { await call('/cancel', { method: 'POST' }); }

const sheetUrls = new Map();   // hash/n -> object URL
export async function sheetUrl(hash, n) {
  const key = hash + '/' + n;
  if (!sheetUrls.has(key)) sheetUrls.set(key, call('/jobs/' + hash + '/sheet/' + n).then(r => r.blob()).then(b => URL.createObjectURL(b)).catch(e => { sheetUrls.delete(key); throw e; }));
  return sheetUrls.get(key);
}
export function revokeSheetUrls() {
  for (const p of sheetUrls.values()) p.then(u => URL.revokeObjectURL(u), () => {});
  sheetUrls.clear();
}

// Full-resolution frame at t; burst picks the sharpest of ~8 frames around it, judged inside region.
export async function fetchFrame(hash, t, { burst = false, region = null } = {}) {
  const r = await call('/jobs/' + hash + '/frame', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ t, burst, region }) });
  return { blob: await r.blob(), info: JSON.parse(r.headers.get('X-Frame-Info') || '{}') };
}

// The analysis fields kept on the record, so candidates survive a cleared server cache.
export function keepAnalysis(v, job) {
  const before = JSON.stringify([v.analysis, v.duration, v.width, v.height]);
  v.analysis = { state: job.state, seconds: job.seconds, tile: job.tile, cols: job.cols, rows: job.rows, sheets: job.sheets, error: job.error || '',
    candidates: (job.candidates || []).map(c => ({ t: c.t, score: c.score, area: c.area, elongation: c.elongation, box: c.box })), analyzedAt: job.analyzedAt || null };
  if (job.probe) { v.duration = job.probe.duration; v.width = job.probe.width; v.height = job.probe.height; }
  return JSON.stringify([v.analysis, v.duration, v.width, v.height]) !== before;   // whether a save is needed
}
