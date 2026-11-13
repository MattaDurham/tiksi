// MEASURE view: step through a walk-through video's frames, read the tape, record readings.
// The local frame service (server/video_frames.py) supplies a 1 fps contact sheet, seconds
// where a yellow tape blade is likely visible, and the sharpest full-resolution frame near a
// moment. It ranks frames for review; a person reads the numbers. Without the service the
// browser's own player supplies frames. Readings live on the property (measurements.js) and
// unexplained ones collect in ASK THE OWNER with their frames.

import { activeProperty, touch, escapeHtml, fmtLen, fmtBytes, getFile, units } from './store.js';
import { restoreGeometryEdit } from './edit-history.js';
import {
  DIRECTIONS, CONFIDENCE, parseReading, fmtReading, fmtTime, measurements, measurementById, addMeasurement, updateMeasurement,
  removeMeasurement, elementTargets, targetKey, targetFor, currentValue, readingState, canApply, applyMeasurement, askOwnerList, askOwnerText, needsOwner,
} from './measurements.js';
import {
  VIDEO_ACCEPT, isVideoFile, addVideoFromFile, deleteVideo, videoCapabilities, openJob, jobStatus, cancelJobs, sheetUrl, revokeSheetUrls,
  fetchFrame, keepAnalysis, videoBlob, captureVideoFrame, seek, saveFrameAsset,
} from './videos.js';

const TILE_W = 96, ZOOM_MAX = 16;
const SUGGESTIONS = ['base cabinet width', 'base cabinet height', 'base cabinet depth', 'wall cabinet width', 'wall cabinet height', 'wall cabinet depth',
  'tall cabinet width', 'counter depth', 'counter height', 'backsplash height', 'toe kick height', 'sink base width', 'sink width', 'range width',
  'range opening', 'dishwasher opening', 'fridge opening width', 'fridge opening height', 'fridge surround depth', 'door leaf width', 'door leaf height',
  'door opening width', 'door casing width', 'window width', 'window height', 'window sill height', 'ceiling height', 'wall length'];

let el = null, prop = null, caps = null;
const view = { videoId: null, t: 0, zoom: { s: 1, x: 0, y: 0 }, crop: null, cropMode: false, editingId: null, autoZoom: true, box: null };
let frame = null;            // { videoId, t, url, blob, info, kind: 'server' | 'player' }
let loading = null;          // pending frame promise
let token = 0, loadTimer = null, pollTimer = null, player = null, playerUrl = null;
let importing = null, dragDepth = 0, statusText = '', draft = null;
const assetUrls = new Map(); // frame asset id -> object URL

// ---------- data ----------
const videos = () => prop.videos || (prop.videos = []);
const current = () => videos().find(v => v.id === view.videoId) || null;
const candidates = v => (v?.analysis?.candidates || []).slice().sort((a, b) => a.t - b.t);
const sheetsReady = v => v?.analysis?.state === 'ready' && v.analysis.sheets > 0;
function mode(v) {
  if (!v) return 'none';
  if (!caps) return 'pending';
  if (caps?.ffmpeg && v.analysis?.state !== 'failed') return 'server';
  return v.playable ? 'player' : 'none';
}
function say(text) { statusText = text; const s = el?.querySelector('[data-status]'); if (s) s.textContent = text; }

// ---------- import ----------
async function addFiles(list) {
  const files = Array.from(list || []);
  if (!files.length) return;
  const others = files.filter(f => !isVideoFile(f));
  const batch = importing = { done: 0, total: files.length - others.length, failed: others.map(f => f.name + ': not a video (add photos in PHOTOS)') };
  const target = prop;
  renderVideos();
  let last = null;
  for (const f of files.filter(isVideoFile)) {
    try { last = await addVideoFromFile(target, f); }
    catch (e) { batch.failed.push(e.message || String(e)); }
    batch.done++; if (el) renderVideos();
  }
  importing = null;
  if (el && target.id === prop?.id) { if (last) select(last.id); else render(); }
  if (batch.failed.length) alert('Not added:\n' + batch.failed.join('\n'));
}

// ---------- analysis ----------
// Disk saves replace the workspace objects and remount the view, so everything asynchronous
// keeps ids, not records, and session state (opened jobs, polls, the frame) outlives a mount.
const jobs = new Map();      // video id -> promise of its opened job (once per session)
let polling = null;          // video id being polled
function liveVideo(id) { return (activeProperty()?.videos || []).find(v => v.id === id) || null; }

function ensureAnalysis(v) {
  if (!caps?.ffmpeg || !v) return Promise.resolve(null);
  if (!jobs.has(v.id)) {
    const id = v.id;
    jobs.set(id, openJob(v).then(job => {
      const live = liveVideo(id);
      if (live) {
        const changed = keepAnalysis(live, job);
        if (changed || !live.hash) { live.hash = live.hash || job.id; touch(); }
      }
      if (['queued', 'analyzing'].includes(job.state)) poll(id);
      if (el) render();
      return job;
    }, e => {
      const live = liveVideo(id);
      if (live) { live.analysis = { ...(live.analysis || {}), state: 'failed', error: e.message, candidates: live.analysis?.candidates || [] }; touch(); }
      jobs.delete(id); if (el) render();
      return null;
    }));
  } else if (['queued', 'analyzing'].includes(v.analysis?.state)) poll(v.id);
  return jobs.get(v.id);
}
function poll(id) {
  if (polling === id && pollTimer) return;
  clearTimeout(pollTimer); polling = id;
  pollTimer = setTimeout(async () => {
    pollTimer = null;
    const v = liveVideo(id);
    if (!v?.hash) return;
    try {
      const job = await jobStatus(v.hash), live = liveVideo(id);
      if (!live) return;
      keepAnalysis(live, job);
      if (['queued', 'analyzing'].includes(job.state)) { if (el && current()?.id === id) { renderVideos(); renderTimeline(); } poll(id); return; }
      polling = null; touch(); if (el) render();
    } catch (e) { polling = null; say('Analysis status unavailable: ' + e.message); }
  }, 900);
}

// ---------- frames ----------
function select(id) {
  if (view.videoId !== id) {
    view.videoId = id; view.t = 0; view.crop = null; view.box = null; view.editingId = null; dropFrame();
    resetZoom(); releasePlayer(); renderForm();
  }
  const v = current();
  render();
  if (v) { ensureAnalysis(v); if (!frame || frame.videoId !== v.id || view.pending) goTo(view.t, view.pending || {}); else renderPosition(); }
}

function releasePlayer() {
  if (player) { player.pause(); player.removeAttribute('src'); player.load(); }
  player = null;
  if (playerUrl) URL.revokeObjectURL(playerUrl);
  playerUrl = null;
}

async function ensurePlayer(v) {
  if (player && player.dataset.videoId === v.id) return player;
  releasePlayer();
  const blob = await videoBlob(v);
  if (!blob) throw new Error('The original video is not on this device.');
  player = document.createElement('video');
  player.className = 'ms-media'; player.muted = true; player.playsInline = true; player.preload = 'auto'; player.dataset.videoId = v.id;
  playerUrl = URL.createObjectURL(blob); player.src = playerUrl;
  await new Promise((resolve, reject) => { player.onloadeddata = resolve; player.onerror = () => reject(new Error('This browser cannot decode the video.')); });
  return player;
}

// Go to a time. A burst looks for the sharpest frame near it, judged inside the tape's box.
function goTo(t, opts = {}) {
  const v = current();
  if (!v) return;
  const end = v.duration || v.analysis?.seconds || 0;
  view.t = Math.max(0, Math.min(end ? end : t, t));
  view.box = opts.box || null; view.pending = { ...opts, now: true };
  if (opts.box && view.autoZoom) zoomTo(pad(opts.box, 0.6));
  renderPosition();
  clearTimeout(loadTimer);
  const my = ++token;
  loadTimer = setTimeout(() => { loading = loadFrame(v, view.t, opts, my).catch(e => { if (my === token) { say(e.message); renderStage(); } }); }, opts.now ? 0 : 160);
}

async function loadFrame(v, t, opts, my) {
  const m = mode(v);
  if (m === 'server') {
    const region = opts.burst ? (view.crop || (opts.box && pad(opts.box, 0.4))) : null;
    say(opts.burst ? 'Finding the sharpest frame near ' + fmtTime(t) + '…' : '');
    const job = await ensureAnalysis(v);
    if (!job) throw new Error(liveVideo(v.id)?.analysis?.error || 'The frame service could not open this video.');
    const { blob, info } = await fetchFrame(job.id, t, { burst: !!opts.burst, region });
    if (my !== token) return;
    if (frame?.url && frame.kind === 'server') URL.revokeObjectURL(frame.url);
    frame = { videoId: v.id, t: info.seconds ?? t, url: URL.createObjectURL(blob), blob, info, kind: 'server', burst: !!opts.burst };
    view.t = frame.t; view.pending = null;
    say(opts.burst && info.sharpness?.length ? 'Sharpest of ' + info.sharpness.length + ' frames near ' + fmtTime(t) + ': ' + fmtTime(frame.t) + '.' : '');
  } else if (m === 'player') {
    const p = await ensurePlayer(v);
    await seek(p, t);
    if (my !== token) return;
    frame = { videoId: v.id, t: p.currentTime, url: null, blob: null, info: { width: p.videoWidth, height: p.videoHeight }, kind: 'player' }; view.pending = null;
  } else return;
  renderStage(); renderPosition();
}

// The frame shown at view.t, loading it now if a step is still debounced or in flight.
async function currentFrameBlob() {
  const v = current();
  if (!v) return null;
  if (view.pending || !frame || frame.videoId !== v.id || Math.abs(frame.t - view.t) > 0.05) {
    clearTimeout(loadTimer);
    const my = ++token;
    loading = loadFrame(v, view.t, view.pending || {}, my);
  }
  if (loading) await loading.catch(() => {});
  if (!frame || frame.videoId !== v.id || Math.abs(frame.t - view.t) > 0.05) return null;
  if (frame.kind === 'server') return frame.blob;
  if (frame.kind === 'player' && player) return captureVideoFrame(player);
  return null;
}

// ---------- zoom, pan, crop ----------
// The blade's box with a margin: a little along it, more across it, so the numbers fit.
function pad(box, f) {
  const [x, y, w, h] = box, px = w * f * 0.25 + 0.02, py = Math.max(h * f * 2, 0.04);
  const x0 = Math.max(0, x - px), y0 = Math.max(0, y - py), x1 = Math.min(1, x + w + px), y1 = Math.min(1, y + h + py);
  return [x0, y0, x1 - x0, y1 - y0];
}
function resetZoom() { view.zoom = { s: 1, x: 0, y: 0 }; }
function fit() {
  const stage = el?.querySelector('.ms-stage'), v = current();
  if (!stage || !v) return null;
  const W = frame?.info?.width || v.width || 16, H = frame?.info?.height || v.height || 9;
  const sw = stage.clientWidth, sh = stage.clientHeight, k = Math.min(sw / W, sh / H);
  return { sw, sh, w: W * k, h: H * k, left: (sw - W * k) / 2, top: (sh - H * k) / 2 };
}
function zoomTo(box) {
  const f = fit();
  if (!f) return;
  const [x, y, w, h] = box, s = Math.min(ZOOM_MAX, Math.max(1, 0.9 * Math.min(f.sw / (w * f.w), f.sh / (h * f.h))));
  view.zoom = { s, x: f.sw / 2 - f.left - s * (x + w / 2) * f.w, y: f.sh / 2 - f.top - s * (y + h / 2) * f.h };
  applyTransform();
}
function zoomBy(factor, cx, cy) {
  const f = fit();
  if (!f) return;
  const z = view.zoom, s = Math.min(ZOOM_MAX, Math.max(1, z.s * factor));
  const px = cx == null ? f.sw / 2 - f.left : cx - f.left, py = cy == null ? f.sh / 2 - f.top : cy - f.top;
  view.zoom = s === 1 ? { s: 1, x: 0, y: 0 } : { s, x: px - (px - z.x) * s / z.s, y: py - (py - z.y) * s / z.s };
  applyTransform();
}
function applyTransform() {
  const canvas = el?.querySelector('.ms-canvas'), f = fit();
  if (!canvas || !f) return;
  Object.assign(canvas.style, { left: f.left + 'px', top: f.top + 'px', width: f.w + 'px', height: f.h + 'px',
    transform: `translate(${view.zoom.x}px, ${view.zoom.y}px) scale(${view.zoom.s})` });
  const zoom = el.querySelector('[data-zoom-level]');
  if (zoom) zoom.textContent = Math.round(view.zoom.s * 100) + '%';
}
function normalised(e) {
  const r = el.querySelector('.ms-canvas').getBoundingClientRect();
  return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
}
function bindStage() {
  const stage = el.querySelector('.ms-stage');
  stage.addEventListener('wheel', e => {
    e.preventDefault();
    const r = stage.getBoundingClientRect();
    zoomBy(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
  stage.addEventListener('pointerdown', e => {
    if (e.button !== 0 || !el.querySelector('.ms-canvas')) return;
    stage.setPointerCapture(e.pointerId);
    const start = { x: e.clientX, y: e.clientY, zx: view.zoom.x, zy: view.zoom.y, n: normalised(e) };
    const crop = view.cropMode || e.shiftKey;
    const move = ev => {
      if (crop) {
        const n = normalised(ev), x = Math.min(start.n[0], n[0]), y = Math.min(start.n[1], n[1]);
        view.crop = [x, y, Math.abs(n[0] - start.n[0]), Math.abs(n[1] - start.n[1])]; renderOverlay();
      } else { view.zoom.x = start.zx + ev.clientX - start.x; view.zoom.y = start.zy + ev.clientY - start.y; applyTransform(); }
    };
    const up = () => {
      stage.removeEventListener('pointermove', move); stage.removeEventListener('pointerup', up); stage.removeEventListener('pointercancel', up);
      if (crop) { if (view.crop && (view.crop[2] < 0.01 || view.crop[3] < 0.01)) view.crop = null; view.cropMode = false; renderToolbar(); renderOverlay(); }
    };
    stage.addEventListener('pointermove', move); stage.addEventListener('pointerup', up); stage.addEventListener('pointercancel', up);
  });
  stage.addEventListener('dblclick', () => { if (view.crop) zoomTo(view.crop); else zoomBy(view.zoom.s > 1 ? 0 : 3); });
}

// ---------- readings ----------
function formValues() {
  const f = el.querySelector('.ms-form'), q = s => f.querySelector(s);
  const attach = q('[data-f=attach]').value;
  const target = attach && attach !== 'note' ? elementTargets(prop).find(t => targetKey(t) === attach) : null;
  return { input: q('[data-f=input]').value, text: q('[data-f=text]').value, direction: q('[data-f=direction]').value,
    confidence: (f.querySelector('[data-f=confidence]:checked') || {}).value || 'probable', note: q('[data-f=note]').value,
    element: target ? { kind: target.kind, id: target.id, dim: target.dim } : null, noteOnly: attach === 'note' };
}

async function saveReading() {
  const v = current();
  if (!v) return;
  const values = formValues(), value = parseReading(values.input);
  if (values.input.trim() && !Number.isFinite(value)) { say('Not a length: "' + values.input + '". Try 33 1/2, 2\'-9 1/2" or 85 cm, or leave it blank and mark it unreadable.'); return; }
  if (!values.input.trim() && values.confidence !== 'unreadable') { say('Enter the value on the tape, or mark the reading unreadable.'); return; }
  const editing = view.editingId && measurementById(prop, view.editingId), propId = prop.id;
  const button = el.querySelector('[data-act=save]'); if (button) button.disabled = true;
  try {
    let frameAssetId = editing?.frameAssetId || null;
    const moved = !editing || Math.abs(editing.seconds - view.t) > 0.01;
    if (moved) {
      const blob = await currentFrameBlob();
      frameAssetId = blob ? await saveFrameAsset(blob, (v.name || 'video').replace(/\.[^.]+$/, '') + ' @ ' + fmtTime(view.t).replace(':', 'm') + 's.jpg') : null;
    }
    const fields = { ...values, videoId: v.id, seconds: Math.round(view.t * 1000) / 1000, crop: view.crop, frameAssetId };
    // The awaits above can straddle a disk save that replaces the property object.
    const target = activeProperty();
    if (!target || target.id !== propId) throw new Error('the property changed while the frame was saved');
    if (el) prop = target;
    const m = editing ? updateMeasurement(target, editing.id, fields) : addMeasurement(target, fields);
    view.editingId = null; view.crop = null; renderForm();
    say('Saved ' + (Number.isFinite(m.value) ? fmtReading(m.value) : 'an unreadable reading') + ' at ' + fmtTime(m.seconds) + (frameAssetId ? ' with its frame.' : ' (no frame could be captured).') + (needsOwner(prop, m) ? ' It is in ASK THE OWNER.' : ''));
    render();
    el?.querySelector('.ms-stage')?.focus();   // arrows step on; Enter returns to the value field
  } catch (e) { say('Could not save the reading: ' + e.message); }
  finally { if (button) button.disabled = false; }
}

function editReading(id) {
  const m = measurementById(prop, id);
  if (!m) return;
  if (m.videoId !== view.videoId && videos().some(v => v.id === m.videoId)) { view.videoId = m.videoId; dropFrame(); releasePlayer(); ensureAnalysis(current()); }
  view.editingId = id; view.crop = m.crop;
  renderForm(); render();
  goTo(m.seconds, { now: true });
  if (m.crop) zoomTo(pad(m.crop, 0.3));
}

function apply(id) {
  const m = measurementById(prop, id), before = m && currentValue(prop, m.element), label = m && targetFor(prop, m.element)?.label;
  try {
    applyMeasurement(prop, id);
    say('Applied: ' + label + ' ' + fmtLen(before) + ' → ' + fmtReading(m.value) + '. UNDO in the top bar reverts it.');
  } catch (e) { say(e.message); }
  render();
}

async function frameUrl(id) {
  if (!id) return null;
  if (!assetUrls.has(id)) assetUrls.set(id, getFile(id).then(r => r?.buffer ? URL.createObjectURL(new Blob([r.buffer], { type: 'image/jpeg' })) : null));
  return assetUrls.get(id);
}

// A small picture of a reading's crop for the ASK THE OWNER rows: each row used to decode and
// scale a full-size video frame, and the rows are drawn again on every redraw. One per frame
// and crop, kept with the frame URLs (and freed with them).
const THUMB_W = 240;
function cropThumbUrl(m) {
  const crop = m.crop || [0, 0, 1, 1], key = 'thumb:' + m.frameAssetId + ':' + crop.join(',');
  if (!assetUrls.has(key)) assetUrls.set(key, frameUrl(m.frameAssetId).then(async url => {
    if (!url) return null;
    const img = new Image(); img.src = url; await img.decode();
    const [x, y, w, h] = crop, sw = Math.max(1, w * img.naturalWidth), sh = Math.max(1, h * img.naturalHeight);
    const k = Math.min(1, THUMB_W / sw), c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(sw * k)); c.height = Math.max(1, Math.round(sh * k));
    c.getContext('2d').drawImage(img, x * img.naturalWidth, y * img.naturalHeight, sw, sh, 0, 0, c.width, c.height);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
    return blob ? URL.createObjectURL(blob) : null;
  }).catch(() => null));
  return assetUrls.get(key);
}

// ---------- render ----------
function render() {
  if (!el) return;
  renderVideos(); renderToolbar(); renderStage(); renderTimeline(); renderLists();
}

function renderVideos() {
  const list = el?.querySelector('.ms-video-list');
  if (!list) return;
  const head = el.querySelector('[data-head-sub]');
  head.textContent = importing ? 'IMPORTING ' + importing.done + ' / ' + importing.total : videos().length + ' video' + (videos().length === 1 ? '' : 's') + ' · ' + measurements(prop).length + ' reading' + (measurements(prop).length === 1 ? '' : 's');
  head.classList.toggle('busy', !!importing);
  el.querySelector('[data-service]').textContent = caps?.ffmpeg ? 'Frame service ready: contact sheets, tape candidates and sharpest frames.' : (caps?.detail || 'Checking the frame service…');
  list.innerHTML = videos().length ? videos().map(v => {
    const a = v.analysis, n = measurements(prop).filter(m => m.videoId === v.id).length;
    const chip = !a ? (caps?.ffmpeg ? '<span class="chip">NOT ANALYSED</span>' : v.playable ? '<span class="chip">BROWSER PLAYER</span>' : '<span class="chip red">CANNOT DECODE HERE</span>')
      : a.state === 'ready' ? `<span class="chip accent">${a.candidates.length} TAPE SECOND${a.candidates.length === 1 ? '' : 'S'}</span>`
      : ['queued', 'analyzing'].includes(a.state) ? `<span class="chip">ANALYSING ${a.seconds ? Math.round(100 * Math.min(1, (a.done || 0) / a.seconds)) : 0}%</span>`
      : a.state === 'failed' ? '<span class="chip red">NOT READABLE</span>' : '<span class="chip">' + escapeHtml(a.state.toUpperCase()) + '</span>';
    return `<button class="ms-video ${v.id === view.videoId ? 'active' : ''}" data-video="${escapeHtml(v.id)}" aria-label="${escapeHtml(v.name)}">
      <span class="ms-video-thumb">${v.thumb ? `<img src="${escapeHtml(v.thumb)}" alt="">` : '<span>VIDEO</span>'}</span>
      <span class="ms-video-body"><b>${escapeHtml(v.name)}</b><small>${v.duration ? fmtTime(v.duration) : '-'} · ${v.width ? v.width + '×' + v.height : 'size unknown'} · ${fmtBytes(v.byteLength || 0)}</small>
      <span class="ms-chips">${chip}${n ? `<span class="chip">${n} READING${n === 1 ? '' : 'S'}</span>` : ''}</span>
      ${a?.state === 'failed' && a.error ? `<small class="ms-error">${escapeHtml(a.error)}</small>` : ''}</span></button>`;
  }).join('') : `<p class="ms-empty">Add a phone video of the walk-through: someone holding a tape against cabinets, doors, appliances and fixtures. MP4 or MOV, up to 600 MB. The original is kept in the project.</p>`;
  list.querySelectorAll('[data-video]').forEach(b => b.onclick = () => select(b.dataset.video));
}

function renderToolbar() {
  const bar = el?.querySelector('.ms-toolbar'), v = current();
  if (!bar) return;
  if (!v) { bar.innerHTML = ''; return; }
  const a = v.analysis, busy = a && ['queued', 'analyzing'].includes(a.state), server = mode(v) === 'server';
  bar.innerHTML = `
    <span class="ms-time" data-time>${fmtTime(view.t)} / ${fmtTime(v.duration || a?.seconds || 0)}</span>
    <div class="ms-group" role="group" aria-label="Step through the video">
      <button class="btn small" data-act="prev-cand" title="Previous tape candidate (Shift+←)" ${candidates(v).length ? '' : 'disabled'}>◀ TAPE</button>
      <button class="btn small" data-act="back" title="Back one second (←); , steps 0.1 s">◀ 1 S</button>
      <button class="btn small" data-act="fwd" title="Forward one second (→); . steps 0.1 s">1 S ▶</button>
      <button class="btn small" data-act="next-cand" title="Next tape candidate (Shift+→)" ${candidates(v).length ? '' : 'disabled'}>TAPE ▶</button>
    </div>
    <button class="btn small" data-act="burst" title="Sharpest of ~10 frames within half a second, judged inside the crop (B)" ${server ? '' : 'disabled'}>SHARPEST NEAR HERE</button>
    <div class="ms-group" role="group" aria-label="Zoom">
      <button class="btn small" data-act="zoom-out" aria-label="Zoom out">−</button><span class="ms-zoom" data-zoom-level>${Math.round(view.zoom.s * 100)}%</span><button class="btn small" data-act="zoom-in" aria-label="Zoom in">+</button>
      <button class="btn small" data-act="zoom-fit" title="Whole frame (0)">FIT</button>
      <button class="btn small ${view.cropMode ? 'on' : ''}" data-act="crop" title="Drag a box around the tape reading (C, or Shift+drag)">CROP</button>
      ${view.crop ? '<button class="btn small" data-act="zoom-crop">ZOOM TO CROP</button><button class="btn small ghost" data-act="clear-crop">CLEAR CROP</button>' : ''}
    </div>
    <label class="ms-check"><input type="checkbox" data-auto-zoom ${view.autoZoom ? 'checked' : ''}> zoom to tape</label>
    ${busy ? '<button class="btn small" data-act="cancel">CANCEL ANALYSIS</button>' : ''}
    ${caps?.ffmpeg && a && ['cancelled', 'interrupted', 'failed'].includes(a.state) ? '<button class="btn small" data-act="reanalyse">ANALYSE AGAIN</button>' : ''}
    <button class="btn small danger" data-act="delete-video">DELETE VIDEO</button>`;
  const act = (name, fn) => { const b = bar.querySelector(`[data-act=${name}]`); if (b) b.onclick = fn; };
  act('back', () => goTo(view.t - 1)); act('fwd', () => goTo(view.t + 1));
  act('prev-cand', () => stepCandidate(-1)); act('next-cand', () => stepCandidate(1));
  act('burst', () => goTo(view.t, { burst: true, box: view.box, now: true }));
  act('zoom-in', () => zoomBy(1.5)); act('zoom-out', () => zoomBy(1 / 1.5)); act('zoom-fit', () => { resetZoom(); applyTransform(); });
  act('crop', () => { view.cropMode = !view.cropMode; renderToolbar(); });
  act('zoom-crop', () => zoomTo(view.crop)); act('clear-crop', () => { view.crop = null; renderToolbar(); renderOverlay(); });
  act('cancel', async () => { try { await cancelJobs(); say('Analysis cancelled. ANALYSE AGAIN resumes it.'); } catch (e) { say(e.message); } });
  act('reanalyse', () => { jobs.delete(v.id); if (v.analysis) v.analysis.state = 'queued'; ensureAnalysis(v); });
  act('delete-video', async () => {
    const n = measurements(prop).filter(m => m.videoId === v.id).length;
    if (!confirm('Delete "' + v.name + '" from this project?' + (n ? ' Its ' + n + ' reading' + (n === 1 ? '' : 's') + ' and their saved frames are kept.' : ''))) return;
    releasePlayer(); dropFrame(); jobs.delete(v.id); await deleteVideo(prop, v.id); view.videoId = videos()[0]?.id || null; select(view.videoId);
  });
  const auto = bar.querySelector('[data-auto-zoom]'); if (auto) auto.onchange = () => { view.autoZoom = auto.checked; };
}

function stepCandidate(dir) {
  const list = candidates(current()), at = Math.round(view.t);
  const c = dir > 0 ? list.find(x => x.t > at) : list.slice().reverse().find(x => x.t < at);
  if (c) { view.crop = null; goTo(c.t, { burst: true, box: c.box, now: true }); }
  else say(dir > 0 ? 'No later tape candidate. Step with → to check the rest by eye.' : 'No earlier tape candidate.');
}

function renderStage() {
  const stage = el?.querySelector('.ms-stage'), v = current();
  if (!stage) return;
  if (!v) { stage.innerHTML = '<div class="ms-stage-msg">Choose or add a video.</div>'; return; }
  const m = mode(v);
  if (m === 'pending') { stage.innerHTML = '<div class="ms-stage-msg">Checking the frame service…</div>'; return; }
  if (m === 'none') {
    const why = caps.ffmpeg ? 'Neither this browser nor ffmpeg on this Mac can decode this video' + (v.analysis?.error ? ' (' + escapeHtml(v.analysis.error) + ')' : '') + '.'
      : 'This browser cannot play this video, and ' + escapeHtml((caps.detail || 'The frame service is unavailable.').replace(/^./, c => c.toLowerCase()));
    stage.innerHTML = `<div class="ms-stage-msg">${why} The original is kept in the project. Readings can still be typed against a time on the scrubber below.</div>`;
    return;
  }
  let canvas = stage.querySelector('.ms-canvas');
  if (!canvas) { stage.innerHTML = '<div class="ms-canvas"></div><div class="ms-stage-msg" hidden></div>'; canvas = stage.querySelector('.ms-canvas'); }
  const media = canvas.querySelector('.ms-media');
  if (m === 'server' && frame?.kind === 'server' && frame.videoId === v.id) {
    if (!media || media.tagName !== 'IMG') { canvas.innerHTML = '<img class="ms-media" alt="Video frame">'; }
    const img = canvas.querySelector('img'); if (img.src !== frame.url) img.src = frame.url;
  } else if (m === 'player' && player) {
    if (media !== player) { canvas.innerHTML = ''; canvas.append(player); }
  } else if (!media) {
    canvas.innerHTML = '<div class="ms-media ms-loading">Loading frame…</div>';
  }
  for (const k of ['ms-box', 'ms-crop']) if (!canvas.querySelector('.' + k)) canvas.insertAdjacentHTML('beforeend', `<div class="${k}" hidden></div>`);
  applyTransform(); renderOverlay();
}

function renderOverlay() {
  const canvas = el?.querySelector('.ms-canvas');
  if (!canvas) return;
  const place = (node, box) => {
    if (!node) return;
    node.hidden = !box;
    if (box) Object.assign(node.style, { left: box[0] * 100 + '%', top: box[1] * 100 + '%', width: box[2] * 100 + '%', height: box[3] * 100 + '%' });
  };
  place(canvas.querySelector('.ms-box'), view.box && !view.crop ? view.box : null);
  place(canvas.querySelector('.ms-crop'), view.crop);
}

function renderPosition() {
  const v = current();
  if (!el || !v) return;
  const t = el.querySelector('[data-time]'); if (t) t.textContent = fmtTime(view.t) + ' / ' + fmtTime(v.duration || v.analysis?.seconds || 0);
  const at = el.querySelector('[data-at]'); if (at && !view.editingId) at.textContent = 'at ' + fmtTime(view.t);
  const range = el.querySelector('[data-scrub]'); if (range && document.activeElement !== range) range.value = view.t;
  const sec = Math.floor(view.t + 1e-6);
  el.querySelectorAll('.ms-tile.cur').forEach(n => n.classList.remove('cur'));
  const tile = el.querySelector(`.ms-tile[data-t="${sec}"]`);
  if (tile) { tile.classList.add('cur'); tile.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
  const c = candidates(v).find(x => x.t === sec), info = el.querySelector('.ms-frame-info');
  if (info) info.textContent = [frame?.burst && frame.info?.sharpness?.length ? 'sharpest of ' + frame.info.sharpness.length + ' frames' : '',
    c ? 'tape candidate: yellow strip ' + (c.area * 100).toFixed(1) + '% of frame, ' + Math.round(c.elongation) + ':1 long (score ' + c.score + ')' : '',
    frame?.info?.width ? frame.info.width + '×' + frame.info.height + ' frame' : ''].filter(Boolean).join(' · ');
}

async function renderTimeline() {
  const host = el?.querySelector('.ms-timeline'), v = current();
  if (!host) return;
  if (!v) { host.innerHTML = ''; return; }
  const end = v.duration || v.analysis?.seconds || 0, a = v.analysis;
  const progress = a && ['queued', 'analyzing'].includes(a.state) ? `<span class="ms-progress">Analysing ${a.seconds ? Math.round(100 * Math.min(1, (a.done || 0) / a.seconds)) : 0}%: contact sheet and tape candidates</span>` : '';
  host.innerHTML = `<div class="ms-scrub"><input type="range" min="0" max="${end}" step="0.1" value="${view.t}" data-scrub aria-label="Video time">${progress}</div><div class="ms-strip" role="list"></div>`;
  const scrub = host.querySelector('[data-scrub]');
  scrub.oninput = () => goTo(parseFloat(scrub.value));
  if (!sheetsReady(v)) return;
  const [tw, th] = a.tile, h = Math.round(TILE_W * th / tw), seconds = a.seconds, cands = new Map(a.candidates.map(c => [c.t, c]));
  const read = new Set(measurements(prop).filter(m => m.videoId === v.id).map(m => Math.floor(m.seconds)));
  const strip = host.querySelector('.ms-strip'), per = a.cols * a.rows, html = [];
  for (let t = 0; t < seconds; t++) {
    const c = cands.get(t), i = t % per;
    html.push(`<button class="ms-tile ${c ? 'cand' : ''} ${read.has(t) ? 'read' : ''}" role="listitem" data-t="${t}" data-sheet="${Math.floor(t / per) + 1}" style="width:${TILE_W}px;height:${h}px;background-size:${a.cols * TILE_W}px ${a.rows * h}px;background-position:-${(i % a.cols) * TILE_W}px -${Math.floor(i / a.cols) * h}px" title="${fmtTime(t)}${c ? ' · tape candidate' : ''}" aria-label="${fmtTime(t)}${c ? ', tape candidate' : ''}">${c ? `<i style="width:${Math.round(c.score * 100)}%"></i>` : ''}<span>${t}</span></button>`);
  }
  strip.innerHTML = html.join('');
  strip.querySelectorAll('.ms-tile').forEach(b => b.onclick = () => { const t = +b.dataset.t, c = cands.get(t); if (c) view.crop = null; goTo(t, c ? { burst: true, box: c.box, now: true } : {}); });
  renderPosition();
  for (let n = 1; n <= a.sheets; n++) {
    try {
      const url = await sheetUrl(v.hash, n);
      if (!el || current() !== v) return;
      strip.querySelectorAll(`.ms-tile[data-sheet="${n}"]`).forEach(b => b.style.backgroundImage = `url("${url}")`);
    } catch (e) { say('Contact sheet unavailable: ' + e.message); return; }
  }
}

// The form is rebuilt only when its subject changes, so a poll or save never eats typing.
function renderForm() {
  const form = el?.querySelector('.ms-form'), v = current();
  if (!form) return;
  const editing = view.editingId && measurementById(prop, view.editingId);
  const targets = elementTargets(prop), groups = [...new Set(targets.map(t => t.group))];
  const attach = editing ? (editing.element ? targetKey(editing.element) : editing.status === 'assigned' ? 'note' : '') : '';
  form.innerHTML = `
      <div class="kicker">${editing ? 'EDIT READING' : 'RECORD A READING'} <span class="ms-at" data-at>at ${fmtTime(view.t)}</span></div>
      ${v ? '' : '<p class="muted">Choose a video first.</p>'}
      <div class="field"><label for="ms-input">Value on the tape</label><input id="ms-input" type="text" data-f="input" autocomplete="off" placeholder="33 1/2  ·  2'-9 1/2&quot;  ·  85 cm" value="${escapeHtml(editing?.input || '')}"><small class="ms-echo" data-echo></small></div>
      <div class="field"><label for="ms-text">What was measured</label><input id="ms-text" type="text" data-f="text" list="ms-suggest" placeholder="e.g. sink base width" value="${escapeHtml(editing?.text || '')}">
        <datalist id="ms-suggest">${SUGGESTIONS.map(s => `<option value="${escapeHtml(s)}">`).join('')}</datalist></div>
      <div class="field-row">
        <div class="field"><label for="ms-dir">Direction</label><select id="ms-dir" data-f="direction"><option value="">-</option>${DIRECTIONS.map(d => `<option value="${d}" ${editing?.direction === d ? 'selected' : ''}>${d}</option>`).join('')}</select></div>
        <div class="field"><label>Confidence</label><div class="ms-seg" role="radiogroup" aria-label="Confidence">${CONFIDENCE.map(c => `<label><input type="radio" name="ms-conf" data-f="confidence" value="${c}" ${(editing?.confidence || 'clear') === c ? 'checked' : ''}><span>${c}</span></label>`).join('')}</div></div>
      </div>
      <div class="field"><label for="ms-attach">Attach to</label><select id="ms-attach" data-f="attach">
        <option value="">Not yet: ask the owner</option><option value="note" ${attach === 'note' ? 'selected' : ''}>Note only (keep the reading)</option>
        ${groups.map(g => `<optgroup label="${escapeHtml(g)}">${targets.filter(t => t.group === g).map(t => `<option value="${escapeHtml(targetKey(t))}" ${attach === targetKey(t) ? 'selected' : ''}>${escapeHtml(t.label)} (now ${escapeHtml(fmtLen(t.current))})</option>`).join('')}</optgroup>`).join('')}
      </select></div>
      <div class="field"><label for="ms-note">Note</label><textarea id="ms-note" data-f="note" rows="2" placeholder="e.g. hook on the left face frame">${escapeHtml(editing?.note || '')}</textarea></div>
      <div class="ms-form-actions"><button class="btn primary" data-act="save" ${v ? '' : 'disabled'}>${editing ? 'UPDATE READING' : 'SAVE READING'}</button>
        ${editing ? '<button class="btn" data-act="new">NEW READING</button><button class="btn danger" data-act="remove">DELETE</button>' : ''}</div>
      <p class="ms-status" role="status" data-status>${escapeHtml(statusText)}</p>`;
  const q = sel => form.querySelector(sel);
  if (draft && draft.editingId === view.editingId) {
    const d = draft.values;
    q('[data-f=input]').value = d.input; q('[data-f=text]').value = d.text; q('[data-f=direction]').value = d.direction; q('[data-f=note]').value = d.note;
    const radio = form.querySelector(`[data-f=confidence][value="${d.confidence}"]`); if (radio) radio.checked = true;
    q('[data-f=attach]').value = d.noteOnly ? 'note' : d.element ? targetKey(d.element) : '';
    if (draft.focus) setTimeout(() => form.querySelector(`[data-f="${draft?.focus}"]`)?.focus(), 0);
  }
  setTimeout(() => { draft = null; }, 0);
  const echo = () => {
    const raw = q('[data-f=input]').value, value = parseReading(raw), bare = /^[\d\s./½¼¾⅛⅜⅝⅞-]+$/.test(raw.trim());
    q('[data-echo]').textContent = !raw.trim() ? '' : Number.isFinite(value) ? '= ' + fmtReading(value) + (bare ? ' (bare numbers are ' + (units() === 'metric' ? 'millimetres' : 'inches') + ')' : '') : 'not a length';
    q('[data-echo]').classList.toggle('bad', !!raw.trim() && !Number.isFinite(value));
  };
  q('[data-f=input]').oninput = echo; echo();
  form.querySelectorAll('input:not([type=radio]), select').forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); saveReading(); } }));
  const act = (name, fn) => { const b = q(`[data-act=${name}]`); if (b) b.onclick = fn; };
  act('save', saveReading);
  act('new', () => { view.editingId = null; renderForm(); renderLists(); });
  act('remove', () => { removeMeasurement(prop, view.editingId); view.editingId = null; say('Reading deleted.'); renderForm(); render(); });
}

function renderLists() {
  const list = el?.querySelector('.ms-list'), askHost = el?.querySelector('.ms-ask');
  if (!list) return;
  const own = measurements(prop).filter(m => m.videoId === view.videoId).sort((a, b) => a.seconds - b.seconds), ask = askOwnerList(prop);
  list.innerHTML = `<div class="kicker">READINGS ON THIS VIDEO <span class="ms-count">${own.length}</span></div>
      ${own.length ? own.map(readingRow).join('') : '<p class="muted">None yet. Step to a frame where the tape is legible, crop to the numbers, and record what it says.</p>'}`;
  askHost.innerHTML = `<div class="kicker">ASK THE OWNER <span class="ms-count">${ask.length}</span>${ask.length ? '<button class="btn small" data-act="copy-ask">COPY LIST</button>' : ''}</div>
      ${ask.length ? ask.map(askRow).join('') : '<p class="muted">Every reading says what it is and where it belongs.</p>'}
      <textarea class="ms-ask-text" data-ask-text readonly hidden aria-label="Questions for the owner"></textarea>`;
  const copy = askHost.querySelector('[data-act=copy-ask]');
  if (copy) copy.onclick = async () => {
    const text = askOwnerText(prop), area = askHost.querySelector('[data-ask-text]');
    try { await navigator.clipboard.writeText(text); say('Copied ' + ask.length + ' question' + (ask.length === 1 ? '' : 's') + '. Send the frames with it: each one is saved in the project.'); }
    catch (e) { area.hidden = false; area.value = text; area.select(); say('Copy the selected list.'); }
  };
  for (const host of [list, askHost]) {
    host.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => editReading(b.dataset.edit));
    host.querySelectorAll('[data-apply]').forEach(b => b.onclick = e => { e.stopPropagation(); apply(b.dataset.apply); });
  }
  askHost.querySelectorAll('[data-frame]').forEach(async holder => {
    const m = measurementById(prop, holder.dataset.frame), url = m && m.frameAssetId ? await cropThumbUrl(m) : null;
    if (!holder.isConnected) return;
    if (!url) { holder.classList.add('none'); holder.textContent = 'NO FRAME'; return; }
    const img = new Image();
    img.alt = 'Frame at ' + fmtTime(m.seconds); img.src = url; img.dataset.cropThumb = '';
    Object.assign(img.style, { width: '100%', height: '100%', left: '0', top: '0', objectFit: 'cover' });
    holder.append(img);
  });
}

function stateChip(state) {
  return { unassigned: '<span class="chip">UNASSIGNED</span>', assigned: '<span class="chip">ASSIGNED</span>', applied: '<span class="chip green">APPLIED</span>',
    changed: '<span class="chip accent" title="The model no longer holds this value (undone or edited since)">NOT IN MODEL</span>', missing: '<span class="chip red">ELEMENT GONE</span>' }[state] || '';
}
function readingRow(m) {
  const state = readingState(prop, m), target = targetFor(prop, m.element), problem = canApply(prop, m);
  const applyBtn = m.element && state !== 'applied' ? `<button class="btn small ${problem ? '' : 'primary'}" data-apply="${escapeHtml(m.id)}" ${problem ? `disabled title="${escapeHtml(problem)}"` : `title="Set ${escapeHtml(target?.label || '')} to ${escapeHtml(fmtReading(m.value))}"`}>APPLY</button>` : '';
  return `<div class="ms-reading ${m.id === view.editingId ? 'active' : ''}" data-reading="${escapeHtml(m.id)}">
    <button class="ms-reading-main" data-edit="${escapeHtml(m.id)}"><span class="ms-reading-time">${fmtTime(m.seconds)}</span>
      <b>${Number.isFinite(m.value) ? escapeHtml(fmtReading(m.value)) : 'unreadable'}</b> <span>${escapeHtml(m.text || 'what is this?')}</span>
      <small>${[m.direction, m.confidence, target ? target.label : m.status === 'assigned' && !m.element ? 'note only' : ''].filter(Boolean).map(escapeHtml).join(' · ')}</small></button>
    <span class="ms-reading-side">${stateChip(state)}${applyBtn}</span></div>`;
}
function askRow(m) {
  const why = m.confidence === 'unreadable' ? 'Numbers not readable' : !m.text.trim() ? 'What was measured?' : readingState(prop, m) === 'missing' ? 'Its element is gone' : 'Which element is this?';
  const name = videos().find(v => v.id === m.videoId)?.name || 'video removed';
  return `<button class="ms-ask-row" data-edit="${escapeHtml(m.id)}"><span class="ms-ask-frame" data-frame="${escapeHtml(m.id)}"></span>
    <span><b>${escapeHtml(why)}</b><small>${escapeHtml(name)} at ${fmtTime(m.seconds)} · ${Number.isFinite(m.value) ? escapeHtml(fmtReading(m.value)) : 'no value'}${m.text ? ' · ' + escapeHtml(m.text) : ''}</small></span></button>`;
}

// ---------- keyboard and drops ----------
function onKeyDown(e) {
  if (!el || e.metaKey || e.ctrlKey || e.altKey || document.querySelector('dialog[open]')) return;
  if (e.target?.matches?.('input, textarea, select') && e.target.type !== 'range') return;
  const v = current();
  if (!v) return;
  const keys = { ArrowLeft: () => e.shiftKey ? stepCandidate(-1) : goTo(view.t - 1), ArrowRight: () => e.shiftKey ? stepCandidate(1) : goTo(view.t + 1),
    ',': () => goTo(view.t - 0.1), '.': () => goTo(view.t + 0.1), b: () => goTo(view.t, { burst: true, box: view.box, now: true }),
    c: () => { view.cropMode = !view.cropMode; renderToolbar(); }, '0': () => { resetZoom(); applyTransform(); }, '+': () => zoomBy(1.5), '=': () => zoomBy(1.5), '-': () => zoomBy(1 / 1.5),
    Enter: () => el.querySelector('[data-f=input]')?.focus() };
  const fn = keys[e.key];
  if (fn) { e.preventDefault(); fn(); }
}
const hasFiles = e => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
function onDragEnter(e) { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; el.querySelector('.ms-drop').hidden = false; }
function onDragOver(e) { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }
function onDragLeave(e) { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) el.querySelector('.ms-drop').hidden = true; }
function onDrop(e) { if (!hasFiles(e)) return; e.preventDefault(); dragDepth = 0; el.querySelector('.ms-drop').hidden = true; addFiles(e.dataTransfer.files); }
function onResize() { applyTransform(); }

// ---------- undo / redo (the top bar's controls) ----------
export function undo() { if (prop && restoreGeometryEdit(prop, 'undo')) { say('Undone.'); render(); } }
export function redo() { if (prop && restoreGeometryEdit(prop, 'redo')) { say('Redone.'); render(); } }

// ---------- mount / unmount ----------
let dropRoot = null;
export function mount(root) {
  prop = activeProperty(); el = root;
  if (!prop) { root.innerHTML = '<div class="view-scroll"><div class="kicker">MEASURE</div><p class="muted">No property yet. Create one with NEW PROPERTY under FILE.</p></div>'; el = null; return; }
  const wanted = new URLSearchParams(location.hash.split('?')[1] || '').get('video');
  if (wanted && videos().some(v => v.id === wanted)) view.videoId = wanted;
  if (!videos().some(v => v.id === view.videoId)) { view.videoId = videos()[0]?.id || null; view.t = 0; view.editingId = null; dropFrame(); }
  root.innerHTML = `
    <div class="ms-layout">
      <aside class="ms-videos">
        <div class="ms-head"><span class="view-title">MEASURE</span><span class="view-sub" data-head-sub></span></div>
        <div class="ms-actions"><button class="btn primary" data-act="add">ADD VIDEO</button><input type="file" class="hidden-file" data-file accept="${VIDEO_ACCEPT}" multiple></div>
        <p class="ms-service" data-service></p>
        <div class="ms-video-list"></div>
      </aside>
      <section class="ms-main" aria-label="Frame review">
        <div class="ms-toolbar toolbar"></div>
        <div class="ms-stage" tabindex="0" aria-label="Frame: scroll to zoom, drag to pan, Shift+drag to crop"></div>
        <div class="ms-frame-info"></div>
        <div class="ms-timeline"></div>
      </section>
      <aside class="ms-side inspector" data-side-pane="measure"><section class="ms-form" aria-label="Record a reading"></section><section class="ms-list" aria-label="Readings on this video"></section><section class="ms-ask" aria-label="Ask the owner"></section></aside>
      <div class="ms-drop" hidden><div class="ph-drop-box">DROP VIDEOS TO ADD THEM TO ${escapeHtml(prop.name).toUpperCase()}</div></div>
    </div>`;
  const input = root.querySelector('[data-file]');
  root.querySelector('[data-act=add]').onclick = () => input.click();
  input.onchange = () => { addFiles(input.files); input.value = ''; };
  bindStage(); renderForm();
  dropRoot = root;
  for (const [type, fn] of [['dragenter', onDragEnter], ['dragover', onDragOver], ['dragleave', onDragLeave], ['drop', onDrop]]) dropRoot.addEventListener(type, fn);
  window.addEventListener('keydown', onKeyDown); window.addEventListener('resize', onResize);
  render();
  videoCapabilities().then(c => { caps = c; if (!el) return; render(); if (current()) select(view.videoId); });
}

export function unmount() {
  if (dropRoot) for (const [type, fn] of [['dragenter', onDragEnter], ['dragover', onDragOver], ['dragleave', onDragLeave], ['drop', onDrop]]) dropRoot.removeEventListener(type, fn);
  dropRoot = null;
  window.removeEventListener('keydown', onKeyDown); window.removeEventListener('resize', onResize);
  // Keep the typed draft and focus: a disk save remounts the view while someone types.
  const form = el?.querySelector('.ms-form [data-f=input]') && formValues();
  if (form) draft = { editingId: view.editingId, values: form, focus: document.activeElement?.closest?.('.ms-form') ? document.activeElement.dataset.f : null };
  clearTimeout(loadTimer); token++;
  releasePlayer();
  if (frame?.kind === 'player') frame = null;
  for (const p of assetUrls.values()) p.then(u => u && URL.revokeObjectURL(u), () => {});
  assetUrls.clear();
  loading = null; dragDepth = 0; el = null; prop = null;
}

// Leaving a video for good: its frame, and its sheet images, are no longer needed.
function dropFrame() {
  if (frame?.url) URL.revokeObjectURL(frame.url);
  frame = null; revokeSheetUrls();
}
