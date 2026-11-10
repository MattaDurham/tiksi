// Procedural PBR material system. Every texture is synthesised on the CPU from the
// material record (no image assets in the repo), or derived from a property photo.
//
// Contract (consumed by the 3D viewer and the materials view):
//   materialFor(mat, opts?)     -> THREE.Material  cached per record content; maps tile in METERS
//                                                  (map.repeat = 1/tile), so geometry UVs are meters.
//   swatchUrl(mat, size, cb?)   -> string | null   cached dataURL of a lit sample chip; null while it
//                                                  is still rendering (cb(url) fires when ready).
//   disposeMaterials()          -> void            drop every cached texture, material and the renderer.
//
// Why the maps are generated lazily: a 512..1024 px synthesis costs 50..400 ms of CPU. Materials are
// returned immediately with their flat tint so the first paint never waits; a cooperative scheduler
// then fills the maps in ~12 ms slices between frames and flags the material for update.

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { photoBytes } from './photos-store.js';
import { synthesize, normalsJob, hints, tileOf, num, clamp, PATTERNS } from './texture-synth.js';

const FALLBACK = { id: '', name: 'Fallback', color: '#d8d4cc', pattern: 'flat', tile: [1, 1], roughness: 0.9, metalness: 0, normalScale: 1, accent: null, photoId: null };
const SWATCH_RES = 256;          // texture resolution behind a swatch; the chip is tiny
const HI_RES = new Set(['wood', 'stone', 'marble']);
const SLICE_MS = 12;             // per-tick CPU budget of the synthesis scheduler
// GPU mip chains + retained albedo; higher resolution sets need a byte cap. These are the desktop
// limits; a touch device is given lower ones through setTextureLimits (render-quality.js deviceLimits).
const DESKTOP_TEX_BYTES = 256 * 1024 * 1024, DESKTOP_TEX_ENTRIES = 56;
let MAX_TEX_BYTES = DESKTOP_TEX_BYTES;
let textureQuality = 'high';
let MAX_TEX_ENTRIES = DESKTOP_TEX_ENTRIES;      // LRU cap on full texture sets (a 1024 set is ~16 MB of maps)
const MAX_TRANSIENT_ENTRIES = 8; // of which editor-preview variants: the current one and a few recent
const MAX_SWATCHES = 200;        // cached swatch PNGs (~50 KB each); a long editing session mints many

// The pattern samplers and the pixel work live in texture-synth.js (no three.js, so a background
// helper can run them too).

// The page's own run of a set, in scheduler slices (used when there is no background helper).
function* synthJob(mat, res, entry) {
  const made = yield* synthesize(mat, res, () => entry.cancelled);
  if (!made || entry.cancelled) return;
  finishEntry(entry, mat, made.N, made.col, made.nrm, made.orm, THREE.RepeatWrapping);
}

function makeTexture(data, N, wrap, srgb, tile) {
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = wrap;
  t.repeat.set(1 / tile[0], 1 / tile[1]);
  t.anisotropy = textureQuality === 'ultra' ? 16 : textureQuality === 'low' ? 2 : textureQuality === 'medium' ? 4 : 8;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

function finishEntry(entry, mat, N, col, nrm, orm, wrap) {
  const tile = tileOf(mat);
  entry.maps = {
    map: makeTexture(col, N, wrap, true, tile),
    normalMap: makeTexture(nrm, N, wrap, false, tile),
    orm: makeTexture(orm, N, wrap, false, tile),
  };
  entry.albedo = col; entry.res = N;
  entry.status = 'ready';
  const ws = entry.waiters; entry.waiters = [];
  for (const w of ws) { try { w(entry); } catch (e) { console.error(e); } }
  // Variants queued faster than they synthesise were not evictable when the next one was minted;
  // trim now that this one is ready, so a long slider drag does not leave a dozen sets resident.
  evictTextures(entry);
}

// ---------- photo pipeline ----------
async function photoJob(mat, res, entry) {
  let bmp = null;
  try {
    const bytes = mat.photoId ? await photoBytes(mat.photoId) : null;
    if (bytes) bmp = await createImageBitmap(new Blob([bytes]));
  } catch (e) { bmp = null; }
  if (entry.cancelled) { if (bmp && bmp.close) bmp.close(); return; }
  // Photo gone: leave the material on its flat tint.
  if (!bmp) { finishFlat(entry); return; }
  let col;
  try {
    const N = res;
    const c = document.createElement('canvas');
    c.width = N; c.height = N;
    const g = c.getContext('2d', { willReadFrequently: true });
    // Flip vertically: DataTexture rows start at v = 0 (bottom), canvases at the top.
    g.translate(0, N); g.scale(1, -1);
    g.drawImage(bmp, 0, 0, N, N);
    col = new Uint8Array(g.getImageData(0, 0, N, N).data.buffer);
  } catch (e) {
    console.error('photo texture failed for ' + entry.key, e);
    finishFlat(entry); return;
  } finally { if (bmp.close) bmp.close(); }
  enqueue(photoMapsJob(mat, res, col, entry), entry);
}

// A texture set that cannot be made (photo gone, or its synthesis threw) settles on the material's
// flat tint: status 'ready' with no maps. It must not stay pending: MODEL redraws every 400 ms while
// any set is pending and counts as settled only once none are, so one failed set kept the model
// redrawing for as long as it was open, and the browser checks waited for it until they gave up.
function finishFlat(entry) {
  if (entry.status === 'ready') return;
  entry.maps = null; entry.status = 'ready';
  const ws = entry.waiters; entry.waiters = [];
  for (const w of ws) { try { w(entry); } catch (e) { console.error(e); } }
}

// Derive roughness + normals from the photo's luminance, in scheduler slices like the synth jobs.
function* photoMapsJob(mat, N, col, entry) {
  const n = N * N;
  const hgt = new Float32Array(n), orm = new Uint8Array(n * 4);
  const R = clamp(num(mat.roughness, 0.8), 0.02, 1);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const l = (0.299 * col[i * 4] + 0.587 * col[i * 4 + 1] + 0.114 * col[i * 4 + 2]) / 255;
      hgt[i] = l;
      orm[i * 4] = 255; orm[i * 4 + 1] = clamp((R + (0.5 - l) * 0.35) * 255, 8, 255); orm[i * 4 + 2] = 255; orm[i * 4 + 3] = 255;
    }
    if ((y & 63) === 63) yield;
  }
  // Light blur so JPEG grain does not become normal-map noise.
  const blurred = new Float32Array(n);
  for (let y = 0; y < N; y++) {
    const ym = ((y - 1 + N) % N) * N, y0 = y * N, yp = ((y + 1) % N) * N;
    for (let x = 0; x < N; x++) {
      const xm = (x - 1 + N) % N, xp = (x + 1) % N;
      blurred[y0 + x] = (hgt[ym + xm] + hgt[ym + x] + hgt[ym + xp] + hgt[y0 + xm] + hgt[y0 + x] + hgt[y0 + xp] + hgt[yp + xm] + hgt[yp + x] + hgt[yp + xp]) / 9;
    }
    if ((y & 31) === 31) yield;
  }
  const nrm = new Uint8Array(n * 4);
  const tile = tileOf(mat);
  yield* normalsJob(blurred, N, 0.006 / (tile[0] / N), 0.006 / (tile[1] / N), nrm);
  if (entry.cancelled) return;
  finishEntry(entry, mat, N, col, nrm, orm, THREE.MirroredRepeatWrapping);
}

// ---------- scheduler ----------
// Cooperative: jobs are generators that yield every few rows. We run them in idle time when the
// browser offers it (so a live 3D view keeps its frame rate) and otherwise in short timeouts.
const jobs = [];
let ticking = false;
const hasIdle = typeof requestIdleCallback === 'function';
function enqueue(gen, entry) {
  gen.entry = entry;
  jobs.push(gen);
  if (!ticking) { ticking = true; later(); }
}
function later() { if (hasIdle) requestIdleCallback(tick, { timeout: 24 }); else setTimeout(tick, 0); }
function tick(deadline) {
  const t0 = performance.now();
  let budget = SLICE_MS;
  if (deadline && !deadline.didTimeout) budget = Math.max(2, Math.min(SLICE_MS, deadline.timeRemaining() - 1));
  while (jobs.length && performance.now() - t0 < budget) {
    const j = jobs[0];
    const s = performance.now();
    let r;
    try { r = j.next(); }
    catch (e) {
      console.error('texture synthesis failed for ' + (j.entry ? j.entry.key : '?'), e);
      r = { done: true };
      if (j.entry && !j.entry.cancelled) finishFlat(j.entry);
    }
    if (j.entry) j.entry.cpuMs = (j.entry.cpuMs || 0) + performance.now() - s;
    if (r.done) jobs.shift();
  }
  if (jobs.length) later(); else ticking = false;
}

// ---------- background helper ----------
// Making a set is 50..400 ms of pure computing. In the page, even sliced, that is time taken
// from frames and taps, and where the browser has no idle callback the slices run back to back.
// So the sets are made in a background helper (texture-worker.js), one at a time, and the page
// only wraps the finished pixels in textures. Where no helper can start (a page opened from a
// file, a browser that refuses), or the helper dies, the page makes them itself as before.
let helper = null, helperBroken = false, helperJob = null;
const helperQueue = [];   // { snap, res, entry } waiting for the helper
function helperReady() {
  if (helper) return true;
  if (helperBroken || typeof Worker !== 'function') return false;
  try { helper = new Worker(new URL('./texture-worker.js', import.meta.url), { type: 'module' }); }
  catch (e) { helperBroken = true; return false; }
  helper.onmessage = helperDone;
  helper.onerror = helperFailed;
  return true;
}
function startSynthesis(snap, res, entry) {
  if (!helperReady()) { enqueue(synthJob(snap, res, entry), entry); return; }
  helperQueue.push({ snap, res, entry });
  feedHelper();
}
function feedHelper() {
  while (!helperJob && helperQueue.length) {
    const job = helperQueue.shift();
    if (job.entry.cancelled) continue;     // evicted or replaced while it waited
    helperJob = job;
    helper.postMessage({ mat: job.snap, res: job.res });
  }
}
function helperDone(e) {
  const job = helperJob, d = e.data;
  helperJob = null;
  if (job && !job.entry.cancelled) {
    job.entry.workerMs = d.ms || 0;
    const t = performance.now();
    if (d.ok) finishEntry(job.entry, job.snap, d.N, d.col, d.nrm, d.orm, THREE.RepeatWrapping);
    else { console.error('texture synthesis failed for ' + job.entry.key, d.error); finishFlat(job.entry); }
    job.entry.cpuMs = (job.entry.cpuMs || 0) + performance.now() - t;
  }
  feedHelper();
}
// The helper could not load or stopped: nothing it held is lost, the page makes those sets.
function helperFailed(err) {
  if (err && err.preventDefault) err.preventDefault();
  helperBroken = true;
  try { helper.terminate(); } catch (e) { /* already gone */ }
  helper = null;
  const left = helperJob ? [helperJob, ...helperQueue] : [...helperQueue];
  helperJob = null; helperQueue.length = 0;
  for (const job of left) if (!job.entry.cancelled) enqueue(synthJob(job.snap, job.res, job.entry), job.entry);
}

// Number of texture sets still being synthesised (views can throttle their render loops meanwhile).
export function pendingTextureJobs() { return [...texCache.values()].filter(e => !e.cancelled && e.status !== 'ready').length; }

export function setTextureQuality(quality) { textureQuality = quality; }

// How much generated texture this device keeps at once: `bytes` of maps and `sets` of them.
// Lowering a limit frees the least recently shown sets straight away.
export function setTextureLimits({ bytes, sets } = {}) {
  const newBytes = Number.isFinite(bytes) && bytes > 0 ? bytes : DESKTOP_TEX_BYTES;
  const newSets = Number.isFinite(sets) && sets > 0 ? Math.floor(sets) : DESKTOP_TEX_ENTRIES;
  if (newBytes !== MAX_TEX_BYTES || newSets !== MAX_TEX_ENTRIES) overLimitLogged = false;   // a new limit may be said once too
  MAX_TEX_BYTES = newBytes; MAX_TEX_ENTRIES = newSets;
  evictTextures();
}
export function textureLimits() { return { bytes: MAX_TEX_BYTES, sets: MAX_TEX_ENTRIES }; }

// ---------- what the model is showing ----------
// The limits are for sets nobody is looking at. A set in the model the 3D view has built is
// never evicted: it is on a surface on screen, so freeing it saves nothing (it would be uploaded
// again for the next frame and synthesised again on the next rebuild) and only adds work. If
// the model alone needs more than the device's limit, all of it is kept and that is logged once.
//
// The 3D view says what its model holds in two ways. beginTextureBuild() marks the start of a
// model build: every non-transient set asked for from then on belongs to it (and sets left
// over from before are trimmed to the limit there). setTextureUse(fn) gives a function that
// returns the sources of the colour maps on the surfaces in the scene right now; it covers the
// ground and the imported models, which are not rebuilt with the model. setTextureUse(null)
// (the view closed) ends both.
let buildMark = Infinity, texturesInUse = null, overLimitLogged = false;
export function beginTextureBuild() { buildMark = clock; evictTextures(); }
export function setTextureUse(fn) {
  texturesInUse = typeof fn === 'function' ? fn : null;
  if (!texturesInUse) buildMark = Infinity;
}

// Debug aid: synthesis cost per cached texture set.
export function textureStats() {
  return [...texCache.values()].map(e => ({ key: e.key, res: e.res, status: e.status, cpuMs: Math.round(e.cpuMs || 0), workerMs: Math.round(e.workerMs || 0) }));
}

// ---------- caches ----------
// Two kinds of texture entry share texCache. The viewer's sets are requested through materialFor()
// with no options and are what the model is built from; the materials editor asks for its preview
// variants with { transient: true }. Eviction takes transient entries first (and keeps only a few of
// them), so browsing or editing the library never throws away the sets the model is showing.
const texCache = new Map();     // texKey -> entry { status, maps, albedo, waiters, lastUsed, matKeys, transient, res }
const matCache = new Map();     // matKey -> THREE.Material
const swatchCache = new Map();  // swatchKey -> dataURL (insertion order doubles as LRU order)
const swatchPending = new Map();// swatchKey -> [cb]
let clock = 0;

function normRec(mat) { return (mat && typeof mat === 'object') ? mat : FALLBACK; }
function texKey(mat, res) {
  const t = tileOf(mat);
  return [mat.pattern || 'flat', mat.color, mat.accent || '', t[0], t[1], num(mat.roughness, 0.8), num(mat.metalness, 0),
    mat.pattern === 'photo' ? (mat.photoId || '') : '', res, hintKey(mat)].join('|');
}
function hintKey(mat) { const h = hints(mat); return Object.keys(h).filter(k => h[k]).join(','); }
function resFor(mat) {
  if (textureQuality === 'ultra') return HI_RES.has(mat.pattern) || mat.pattern === 'photo' ? 2048 : 1024;
  if (textureQuality === 'low') return HI_RES.has(mat.pattern) ? 512 : 256;
  return HI_RES.has(mat.pattern) || mat.pattern === 'photo' ? 1024 : 512;
}
function hasMaps(mat) { const p = PATTERNS[mat.pattern]; return !!(p && p.maps !== false) || mat.pattern === 'photo'; }

// Jobs run later, in slices; they must see the record as it was when queued, not as the editor
// keeps mutating it.
function snapshot(mat) {
  return {
    id: mat.id, name: mat.name, pattern: mat.pattern, color: mat.color, accent: mat.accent, tile: tileOf(mat),
    roughness: mat.roughness, metalness: mat.metalness, normalScale: mat.normalScale, photoId: mat.photoId,
  };
}

// Every request counts as a use, cache hits included; a set stops being transient the moment a
// non-transient consumer (the model) asks for it.
function touchEntry(entry, transient) {
  entry.lastUsed = ++clock;
  if (!transient) entry.transient = false;
}

function ensureTextures(mat, res, transient) {
  const key = texKey(mat, res);
  let entry = texCache.get(key);
  if (entry) { touchEntry(entry, transient); return entry; }
  entry = { key, res, status: 'pending', maps: null, albedo: null, waiters: [], lastUsed: ++clock, matKeys: new Set(), cancelled: false, transient: !!transient };
  texCache.set(key, entry);
  const snap = snapshot(mat);
  if (snap.pattern === 'photo') photoJob(snap, res, entry);
  else startSynthesis(snap, res, entry);
  evictTextures();
  return entry;
}
function whenReady(entry, cb) { if (entry.status === 'ready') cb(entry); else entry.waiters.push(cb); }

// Only ready entries are candidates (a pending one has a job and waiters on it), never `keep` (the
// set that just finished, whose consumers were handed it a moment ago), never a set a swatch
// render is still queued for and never a set in the model the 3D view is showing (see above). Editor variants go first, oldest first, and never more than
// MAX_TRANSIENT_ENTRIES of them survive; the model's sets are touched on every rebuild, so among
// the rest the LRU order really is "least recently shown".
function evictTextures(keep) {
  const byAge = (a, b) => a.lastUsed - b.lastUsed;
  const awaited = new Set();
  for (const k of swatchPending.keys()) awaited.add(k.slice(0, k.lastIndexOf('#')));
  let onScreen = null;
  if (texturesInUse) { try { onScreen = texturesInUse(); } catch (e) { console.error(e); } }
  const shown = e => !e.transient && (e.lastUsed > buildMark || !!(onScreen && e.maps && onScreen.has(e.maps.map.source)));
  const ready = [...texCache.values()].filter(e => e.status === 'ready' && e !== keep && !awaited.has(e.key) && !shown(e));
  const transient = ready.filter(e => e.transient).sort(byAge);
  let drop = transient.slice(0, Math.max(0, transient.length - MAX_TRANSIENT_ENTRIES));
  const over = texCache.size - drop.length - MAX_TEX_ENTRIES;
  if (over > 0) {
    const rest = transient.slice(drop.length).concat(ready.filter(e => !e.transient).sort(byAge));
    drop = drop.concat(rest.slice(0, over));
  }
  // Three maps with full mip chains (~16 bytes/texel) plus retained RGBA albedo.
  const bytes = e => e.maps ? e.res * e.res * 20 : 0;
  let resident = [...texCache.values()].reduce((sum, e) => sum + bytes(e), 0) - drop.reduce((sum, e) => sum + bytes(e), 0);
  for (const e of ready.sort(byAge)) {
    if (resident <= MAX_TEX_BYTES) break;
    if (!drop.includes(e)) { drop.push(e); resident -= bytes(e); }
  }
  for (const e of drop) {
    disposeEntry(e);
    texCache.delete(e.key);
  }
  if (!overLimitLogged) {
    const held = [...texCache.values()].filter(e => e.status === 'ready' && shown(e));
    const heldBytes = held.reduce((sum, e) => sum + bytes(e), 0);
    if (held.length > MAX_TEX_ENTRIES || heldBytes > MAX_TEX_BYTES) {
      overLimitLogged = true;
      console.warn('textures: the model on screen uses ' + held.length + ' texture sets (' + Math.round(heldBytes / 1048576) + ' MB), over this device\'s limit of ' + MAX_TEX_ENTRIES + ' sets and ' + Math.round(MAX_TEX_BYTES / 1048576) + ' MB. They are on screen, so all are kept.');
    }
  }
}
function disposeEntry(e) {
  e.cancelled = true;
  if (e.maps) for (const k of Object.keys(e.maps)) e.maps[k].dispose();
  for (const mk of e.matKeys) { const m = matCache.get(mk); if (m) { m.dispose(); matCache.delete(mk); } }
}

// ---------- public: materialFor ----------
function applyMaps(material, mat, entry) {
  if (!entry.maps) return;
  material.map = entry.maps.map;
  material.normalMap = entry.maps.normalMap;
  material.roughnessMap = entry.maps.orm;
  material.metalnessMap = entry.maps.orm;
  material.aoMap = entry.maps.orm;
  material.aoMapIntensity = 1;
  material.color.set(0xffffff);       // the tint is baked into the colour map
  material.roughness = 1;             // absolute roughness lives in the map's G channel
  material.needsUpdate = true;
}

function buildMaterial(mat, opts, res, key) {
  const pattern = mat.pattern || 'flat';
  const base = {
    color: new THREE.Color(mat.color || '#d8d4cc'),
    roughness: clamp(num(mat.roughness, 0.8), 0.02, 1),
    metalness: clamp(num(mat.metalness, 0), 0, 1),
    envMapIntensity: 1,
    side: opts.side != null ? opts.side : THREE.FrontSide,
  };
  if (opts.transparent) { base.transparent = true; base.opacity = opts.opacity != null ? opts.opacity : 1; }
  else if (opts.opacity != null && opts.opacity < 1) { base.transparent = true; base.opacity = opts.opacity; }
  let m;
  if (pattern === 'glass') {
    m = new THREE.MeshPhysicalMaterial(Object.assign(base, {
      transmission: 0.9, roughness: clamp(num(mat.roughness, 0.05), 0, 1), ior: 1.52, thickness: 0.006,
      transparent: true, opacity: opts.opacity != null ? opts.opacity : 1, metalness: 0,
      side: opts.side != null ? opts.side : THREE.DoubleSide, depthWrite: false,
    }));
    return m;
  }
  if (pattern === 'marble' || pattern === 'tile') {
    const h = hints(mat);
    const coat = pattern === 'marble' ? (h.quartz ? 0.35 : 0.6) : (h.slate ? 0 : (h.gloss || h.zellige) ? 0.7 : 0.35);
    m = new THREE.MeshPhysicalMaterial(Object.assign(base, { clearcoat: coat, clearcoatRoughness: pattern === 'marble' ? 0.08 : 0.15 }));
  } else {
    m = new THREE.MeshStandardMaterial(base);
  }
  const ns = clamp(num(mat.normalScale, 1), 0, 2);
  m.normalScale = new THREE.Vector2(ns, ns);
  m.userData.cacheKey = key;
  m.userData.materialId = mat.id || '';
  if (hasMaps(mat)) {
    const entry = ensureTextures(mat, res, opts.transient);
    entry.matKeys.add(key);
    whenReady(entry, e => { if (!e.cancelled) applyMaps(m, mat, e); });
  }
  return m;
}

function materialForRes(mat, opts, res) {
  opts = opts || {};
  const key = texKey(mat, res) + '#' + num(mat.normalScale, 1) + '|' +
    (opts.side != null ? opts.side : '') + '|' + (opts.transparent ? 1 : 0) + '|' + (opts.opacity != null ? opts.opacity : '');
  let m = matCache.get(key);
  if (m) {
    // A hit is a use too: without this the model's sets kept their creation-time stamp and were
    // the LRU's first victims whenever the library minted a few variants.
    if (hasMaps(mat)) { const e = texCache.get(texKey(mat, res)); if (e) touchEntry(e, opts.transient); }
    return m;
  }
  m = buildMaterial(mat, opts, res, key);
  matCache.set(key, m);
  return m;
}

// opts: side / transparent / opacity as for MeshStandardMaterial, plus `transient` for a preview
// that will move on (its texture set is evicted before anything the model uses).
export function materialFor(mat, opts) {
  mat = normRec(mat);
  return materialForRes(mat, opts, resFor(mat));
}

// Resolve when the material's maps are on the GPU-ready side (used by the previews).
export function whenMaterialReady(mat, cb, opts) {
  mat = normRec(mat);
  if (!hasMaps(mat)) { cb(); return; }
  const entry = ensureTextures(mat, resFor(mat), opts && opts.transient);
  // Someone is waiting on this set: it goes to the front of the helper's queue, ahead of sets
  // that were only asked for.
  const at = helperQueue.findIndex(job => job.entry === entry);
  if (at > 0) helperQueue.unshift(helperQueue.splice(at, 1)[0]);
  whenReady(entry, () => cb());
}

// ---------- public: swatches ----------
let pv = null;   // shared preview renderer/scene, created on first use

// The studio IBL lives in a render target, which a lost context cannot restore from source data
// like an ordinary texture; rebuild it whenever the context comes back or swatches lose their sheen.
function rigEnvironment(rig) {
  if (rig.env) rig.env.dispose();
  const room = new RoomEnvironment();
  const pmrem = new THREE.PMREMGenerator(rig.renderer);
  rig.env = pmrem.fromScene(room, 0.04).texture;
  pmrem.dispose();
  room.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
  rig.scene.environment = rig.env;
}

function previewRig() {
  if (pv) return pv;
  let renderer = null;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true, powerPreference: 'low-power' });
  } catch (e) { renderer = null; }
  if (!renderer) { pv = { renderer: null }; return pv; }
  renderer.setPixelRatio(1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.8;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#161c22');
  const rig = { renderer, scene, lost: false, env: null };
  rigEnvironment(rig);
  scene.environmentIntensity = 0.55;
  // The browser drops the least recently flushed context when a page holds too many, and this
  // off-screen canvas only flushes when a swatch renders. three preventDefault()s the loss so the
  // context is restorable; while it is gone, swatches fall back to their albedo and are not cached.
  renderer.domElement.addEventListener('webglcontextlost', () => { rig.lost = true; });
  renderer.domElement.addEventListener('webglcontextrestored', () => { rig.lost = false; rigEnvironment(rig); });
  const camera = new THREE.PerspectiveCamera(28, 1, 0.05, 20);
  camera.position.set(0.62, 1.2, 1.78);
  camera.lookAt(0, -0.04, 0);
  // Low, raking key so relief (mortar, plank bevels, laps) reads on the chip.
  const key = new THREE.DirectionalLight(0xfff2e2, 1.6);
  key.position.set(-2.2, 1.1, 1.4);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xbcd0e6, 0.3);
  fill.position.set(1.5, 0.8, -1);
  scene.add(fill);
  // The chip: a bevelled 1 x 1 m sample with UVs in meters (RoundedBox faces are 0..1 already).
  const geo = new RoundedBoxGeometry(1, 0.09, 1, 3, 0.02);
  const idle = new THREE.MeshStandardMaterial({ color: 0x888888 });
  const chip = new THREE.Mesh(geo, idle);
  chip.rotation.y = -0.35;
  scene.add(chip);
  // A dark plinth behind glass so transmission has something to refract.
  const back = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), new THREE.MeshStandardMaterial({ color: 0x1b232b, roughness: 1 }));
  back.rotation.x = -Math.PI / 2; back.position.y = -0.2;
  scene.add(back);
  Object.assign(rig, { camera, chip, idle });
  pv = rig;
  return pv;
}

function rigLost(rig) {
  const gl = rig.renderer.getContext();
  return rig.lost || !gl || gl.isContextLost();
}

function rememberSwatch(key, url) {
  swatchCache.set(key, url);
  while (swatchCache.size > MAX_SWATCHES) swatchCache.delete(swatchCache.keys().next().value);
}

// A swatch's 256-res maps have no reader once its PNG is cached, so they are dropped straight after
// the render unless another size of the same swatch is still waiting on them (card 160 / picker 48).
// Re-minting one later costs ~30 ms; keeping all of them cost the model its texture slots.
function releaseSwatchMaps(tk) {
  for (const k of swatchPending.keys()) if (k.startsWith(tk + '#')) return;
  const e = texCache.get(tk);
  if (e && e.res === SWATCH_RES && e.status === 'ready') { disposeEntry(e); texCache.delete(tk); }
}

function albedoDataUrl(entry, mat, size) {
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const g = c.getContext('2d');
  if (entry && entry.albedo) {
    const N = entry.res;
    const src = document.createElement('canvas');
    src.width = N; src.height = N;
    src.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(entry.albedo.buffer), N, N), 0, 0);
    g.drawImage(src, 0, 0, size, size);
  } else {
    g.fillStyle = mat.color || '#888';
    g.fillRect(0, 0, size, size);
  }
  return c.toDataURL('image/png');
}

// Always settles the key: waiters get a URL (lit chip, or the albedo fallback) even if the render
// throws, so a card can never be left waiting forever. Only a real render is cached; a fallback
// produced while the context is lost is retried on the next request.
function renderSwatch(mat, size, key) {
  const rig = previewRig();
  let url = null, cacheable = true;
  if (rig.renderer) {
    if (rigLost(rig)) cacheable = false;
    else {
      try {
        rig.chip.material = materialForRes(mat, { transient: true }, SWATCH_RES);
        rig.renderer.setSize(size, size, false);
        rig.renderer.render(rig.scene, rig.camera);
        url = rig.renderer.domElement.toDataURL('image/png');
      } catch (e) {
        console.error('swatch render failed', e);
        url = null;
      } finally {
        rig.chip.material = rig.idle;
      }
      // The context can go between the check and the read; a blank PNG must not be cached.
      if (rigLost(rig)) { url = null; cacheable = false; }
    }
  }
  if (!url) url = albedoDataUrl(hasMaps(mat) ? texCache.get(texKey(mat, SWATCH_RES)) : null, mat, size);
  if (cacheable) rememberSwatch(key, url);
  const cbs = swatchPending.get(key) || [];
  swatchPending.delete(key);
  for (const cb of cbs) { try { cb(url); } catch (e) { console.error(e); } }
  if (cacheable && hasMaps(mat)) releaseSwatchMaps(texKey(mat, SWATCH_RES));
  return url;
}

export function swatchUrl(mat, size, cb) {
  mat = normRec(mat);
  size = size || 96;
  const key = texKey(mat, SWATCH_RES) + '#' + num(mat.normalScale, 1) + '@' + size;
  const hit = swatchCache.get(key);
  if (hit) {
    // Re-insert so the bound behaves as an LRU rather than dropping the oldest-minted first.
    swatchCache.delete(key); swatchCache.set(key, hit);
    return hit;
  }
  let list = swatchPending.get(key);
  if (list) { if (cb) list.push(cb); return null; }
  list = cb ? [cb] : [];
  swatchPending.set(key, list);
  // Snapshot the record: the caller may keep editing it while the maps are still being synthesised.
  const snap = Object.assign({}, mat, { tile: tileOf(mat) });
  const go = () => { if (!swatchCache.has(key) && swatchPending.has(key)) renderSwatch(snap, size, key); };
  if (hasMaps(snap)) whenReady(ensureTextures(snap, SWATCH_RES, true), () => setTimeout(go, 0));
  else setTimeout(go, 0);
  return null;
}

// ---------- public: dispose ----------
export function disposeMaterials() {
  jobs.length = 0; ticking = false;
  helperQueue.length = 0;   // a set the helper is making now is dropped when it comes back (cancelled below)
  for (const e of texCache.values()) { e.cancelled = true; if (e.maps) for (const k of Object.keys(e.maps)) e.maps[k].dispose(); }
  texCache.clear();
  for (const m of matCache.values()) m.dispose();
  matCache.clear();
  swatchCache.clear();
  swatchPending.clear();
  if (pv && pv.renderer) {
    pv.chip.geometry.dispose();
    if (pv.env) pv.env.dispose();
    pv.scene.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material && o.material.dispose) o.material.dispose(); });
    pv.renderer.dispose();
    pv.renderer.forceContextLoss();
  }
  pv = null;
}

// Exposed for the materials view: the pattern list the synthesiser knows about.
export const PATTERN_NAMES = Object.keys(PATTERNS);
