// Real multi-view photogrammetry: original camera files -> this Mac's native engine ->
// textured, self-contained GLB -> the existing scan import and alignment workflow.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { activeProperty, escapeHtml } from './store.js';
import { photoBytes } from './photos-store.js';
import { importScanBytes, disposeScanObject } from './scans.js';

const BASE = '/api/reconstruction';
const TYPES = /\.(jpe?g|png|heic|heif|tiff?)$/i;
const PHOTO_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/heic': '.heic', 'image/heif': '.heif', 'image/tiff': '.tiff' };
let root = null, property = null, capabilities = null, job = null, jobs = [];
let serverToken = '';
let files = [], galleryIds = new Set(), busy = false, message = '', poll = null, mountEpoch = 0;
let preview = null, modelBytes = null, modelId = null;
const terminal = new Set(['complete', 'failed', 'cancelled', 'interrupted']);
const humanBytes = n => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1024).toFixed(0) + ' KB';
const err = error => String(error && error.message || error);

async function api(path, options = {}) {
  const response = await fetch(BASE + path, { ...options, headers: { 'X-Tiksi-Token': serverToken, ...options.headers }, cache: 'no-store' });
  if (!response.ok) {
    let detail;
    try { detail = (await response.json()).error; } catch (_) { detail = 'Local reconstruction service is unavailable (HTTP ' + response.status + ').'; }
    throw new Error(detail || 'Reconstruction request failed');
  }
  return response;
}
async function json(path, options) { return (await api(path, options)).json(); }
function setMessage(text) { message = text; if (root) root.querySelector('.rc-message').textContent = text; }
function selectedCount() { return files.length + galleryIds.size; }
function addFiles(list) {
  const invalid = [];
  for (const file of Array.from(list || [])) {
    if (!TYPES.test(file.name)) { invalid.push(file.name); continue; }
    if (file.size > (capabilities?.maxImageBytes || 60 * 1048576)) { invalid.push(file.name + ' exceeds 60 MB'); continue; }
    if (!files.some(f => f.name === file.name && f.size === file.size && f.lastModified === file.lastModified)) files.push(file);
  }
  if (invalid.length) setMessage('Not added: ' + invalid.join(', ') + '. Use original JPEG, PNG, HEIC/HEIF or TIFF photographs.');
  renderSelection();
}
function renderSelection() {
  if (!root) return;
  const element = root.querySelector('.rc-selection');
  element.textContent = selectedCount() + ' photos selected' + (files.length ? ' · ' + humanBytes(files.reduce((sum, f) => sum + f.size, 0)) + ' of new originals' : '');
  root.querySelector('[data-action=start]').disabled = busy || !capabilities?.available || selectedCount() < (capabilities?.minImages || 20);
  root.querySelector('[data-action=clear]').disabled = busy || !selectedCount();
  root.querySelector('.rc-file-list').textContent = files.map(f => f.name).join(', ');
}
function renderGallery() {
  if (!root) return;
  const gallery = (property.photos || []).filter(p => p.kind !== 'pano' && (PHOTO_EXT[p.mime] || TYPES.test(p.name || '')));
  root.querySelector('.rc-gallery').innerHTML = gallery.length ? gallery.map(p => `<label class="rc-photo">
    <input type="checkbox" value="${escapeHtml(p.id)}" ${galleryIds.has(p.id) ? 'checked' : ''} ${busy ? 'disabled' : ''}>
    <img src="${escapeHtml(p.thumb || '')}" alt="" loading="lazy"><span>${escapeHtml(p.name)}<small>${p.w} × ${p.h}${p.original ? ' · original' : ' · older saved copy'}</small></span></label>`).join('') : '<p>Add overlapping photographs here or in PHOTOS. Panoramas are reference images and are excluded from reconstruction.</p>';
  root.querySelector('.rc-gallery').onchange = event => {
    if (!event.target.matches('input[type=checkbox]')) return;
    event.target.checked ? galleryIds.add(event.target.value) : galleryIds.delete(event.target.value);
    renderSelection();
  };
}
function renderJobs() {
  if (!root) return;
  const select = root.querySelector('.rc-job-select');
  select.innerHTML = '<option value="">Choose a previous reconstruction</option>' + jobs.slice().sort((a, b) => b.createdAt - a.createdAt).map(j => `<option value="${j.id}" ${job?.id === j.id ? 'selected' : ''}>${escapeHtml(j.name)} · ${escapeHtml(j.quality)} · ${escapeHtml(j.state)}</option>`).join('');
}
function renderJob() {
  if (!root) return;
  const area = root.querySelector('.rc-job');
  if (!job) { area.innerHTML = '<p>Your reconstruction will appear here. You can leave this view while the Mac processes it.</p>'; return; }
  const active = ['running', 'converting', 'draft'].includes(job.state);
  const complete = job.state === 'complete';
  area.innerHTML = `<h3>${escapeHtml(job.name)} <span>${escapeHtml(job.state.toUpperCase())}</span></h3>
    <p>${job.images} original photos · ${escapeHtml(job.quality)} detail · ${humanBytes(job.bytes)}</p>
    ${job.state === 'running' ? `<progress max="1" value="${job.progress || 0}"></progress><p>${Math.round((job.progress || 0) * 100)}% · Native reconstruction on your Mac</p>` : ''}
    ${job.state === 'converting' ? '<p>Packaging geometry and full-resolution textures into a portable GLB…</p>' : ''}
    ${job.stats ? `<p>${Number(job.stats.triangles).toLocaleString()} triangles · ${job.stats.textures} texture${job.stats.textures === 1 ? '' : 's'} · ${humanBytes(job.stats.bytes)}</p>` : ''}
    ${job.error ? `<p class="rc-error" role="alert">${escapeHtml(job.error)}</p>` : ''}
    ${job.warnings?.length ? `<details><summary>${job.warnings.length} engine notices</summary><ul>${job.warnings.map(w => '<li>' + escapeHtml(w) + '</li>').join('')}</ul></details>` : ''}
    <div class="rc-actions">
      ${active ? '<button class="btn" data-job=cancel>Cancel reconstruction</button>' : ''}
      ${complete ? '<button class="btn" data-job=preview>Review in 3D</button><button class="btn" data-job=download>Save GLB</button><button class="btn" data-job=native>Save native OBJ and maps</button><button class="btn primary" data-job=import>Add to this property</button>' : ''}
      ${terminal.has(job.state) || job.state === 'draft' ? '<button class="btn" data-job=delete>Remove job and its photo copies</button>' : ''}
    </div>
    ${complete ? '<p class="rc-note">Review the result before importing. Check scale using a known measurement in MODEL; ordinary photographs may have no metric scale. Gaps and blurred regions need better source photos.</p>' : ''}`;
  area.querySelector('[data-job=cancel]')?.addEventListener('click', async () => {
    try { job = await json('/jobs/' + job.id + '/cancel', { method: 'POST' }); renderJob(); } catch (error) { setMessage(err(error)); }
  });
  area.querySelector('[data-job=delete]')?.addEventListener('click', async () => {
    if (!confirm('Remove this job, its uploaded photo copies and generated model from this Mac? Photos in your library and imported property models stay saved.')) return;
    try { await json('/jobs/' + job.id, { method: 'DELETE' }); job = null; clearPreview(); await refresh(); renderJob(); } catch (error) { setMessage(err(error)); }
  });
  area.querySelector('[data-job=preview]')?.addEventListener('click', () => review().catch(error => setMessage(err(error))));
  area.querySelector('[data-job=download]')?.addEventListener('click', async () => {
    const selectedJob = job;
    try {
      const bytes = await getModel(selectedJob);
      const url = URL.createObjectURL(new Blob([bytes], { type: 'model/gltf-binary' }));
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = (selectedJob.name.replace(/[^\w -]/g, '').trim() || 'Photo model') + '.glb'; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (error) { setMessage(err(error)); }
  });
  area.querySelector('[data-job=native]')?.addEventListener('click', async () => {
    const selectedJob = job;
    try {
      setMessage('Preparing original native geometry and texture maps…');
      const blob = await (await api('/jobs/' + selectedJob.id + '/native')).blob();
      const url = URL.createObjectURL(blob), anchor = document.createElement('a');
      anchor.href = url; anchor.download = (selectedJob.name.replace(/[^\w -]/g, '').trim() || 'Photo model') + '-native.zip'; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      setMessage('Native OBJ archive saved, including original texture and displacement maps when produced by the engine.');
    } catch (error) { setMessage(err(error)); }
  });
  area.querySelector('[data-job=import]')?.addEventListener('click', async event => {
    const targetProperty = property, selectedJob = job;
    event.target.disabled = true;
    try {
      const bytes = await getModel(selectedJob);
      const scan = await importScanBytes(bytes, selectedJob.name + '.glb', targetProperty, { toast: setMessage, progress: label => label && setMessage(label) },
        { source: 'local-photogrammetry', reconstructionQuality: selectedJob.quality, reconstructionImages: selectedJob.images });
      if (!scan) throw new Error('The generated model could not be imported.');
      setMessage('Textured model added to ' + (targetProperty.name || 'the property') + '. Open MODEL to position and calibrate it.');
      if (root && property === targetProperty) root.querySelector('.rc-open-model').hidden = false;
    } catch (error) { setMessage(err(error)); }
    finally { if (event.target.isConnected) event.target.disabled = false; }
  });
}
async function getModel(selected = job) {
  if (!selected || selected.state !== 'complete') throw new Error('The model is not ready.');
  const id = selected.id;
  if (modelId === id && modelBytes) return modelBytes;
  const bytes = await (await api('/jobs/' + id + '/model')).arrayBuffer();
  modelBytes = bytes; modelId = id;
  return bytes;
}
async function reconstruct() {
  if (busy) return;
  const selectedFiles = files.slice(), selectedPhotos = (property.photos || []).filter(p => galleryIds.has(p.id));
  const max = capabilities.maxImages;
  if (selectedCount() > max) { setMessage('Select at most ' + max + ' photographs for one reconstruction.'); return; }
  const form = root;
  const name = form.querySelector('[name=name]').value.trim() || 'Photo model';
  const quality = form.querySelector('[name=quality]').value;
  const order = form.querySelector('[name=order]').value;
  busy = true; renderSelection(); renderGallery();
  try {
    clearPreview();
    let uploadingJob = await json('/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, quality, order }) });
    const uploadingId = uploadingJob.id;
    job = uploadingJob;
    renderJob();
    const sources = selectedFiles.map(file => ({ name: file.name, blob: file }));
    // Keep source buffers out of a second whole-batch memory copy.
    for (let i = 0; i < selectedFiles.length + selectedPhotos.length; i++) {
      const photo = selectedPhotos[i - selectedFiles.length];
      let source = sources[i];
      if (photo) {
        const bytes = await photoBytes(photo.id);
        if (!bytes) throw new Error('Original bytes are missing for ' + photo.name + '. Re-upload the photo first.');
        source = { name: PHOTO_EXT[photo.mime] ? 'library-photo' + PHOTO_EXT[photo.mime] : photo.name, blob: new Blob([bytes], { type: photo.mime }) };
      }
      setMessage('Sending original photo ' + (i + 1) + ' / ' + (selectedFiles.length + selectedPhotos.length) + ' to your Mac…');
      uploadingJob = await json('/jobs/' + uploadingId + '/images', { method: 'PUT', headers: { 'X-Image-Name': encodeURIComponent(source.name), 'Content-Type': source.blob.type || 'application/octet-stream' }, body: source.blob });
      if (job?.id === uploadingId) { job = uploadingJob; renderJob(); }
    }
    uploadingJob = await json('/jobs/' + uploadingId + '/start', { method: 'POST' });
    if (job?.id === uploadingId) job = uploadingJob;
    setMessage('Reconstruction is running on your Mac. You can leave this view; keep the Mac awake.');
    renderJob(); await refresh();
  } catch (error) { setMessage(err(error)); await refresh().catch(() => {}); }
  finally { busy = false; renderSelection(); renderGallery(); }
}
async function refresh() {
  const epoch = mountEpoch;
  const data = await json('/jobs');
  if (!root || epoch !== mountEpoch) return;
  jobs = data.jobs;
  if (job) job = jobs.find(j => j.id === job.id) || null;
  renderJobs(); renderJob();
}
function clearPreview() {
  if (preview) {
    preview.observer.disconnect(); preview.controls.dispose();
    disposeScanObject(preview.scene); preview.renderer.dispose(); preview.renderer.domElement.remove(); preview = null;
  }
  modelBytes = null; modelId = null;
}
async function review() {
  const selectedId = job?.id, epoch = mountEpoch;
  setMessage('Loading textured model for review…');
  const bytes = await getModel();
  const object = (await new GLTFLoader().parseAsync(bytes, '')).scene;
  if (!root || epoch !== mountEpoch || job?.id !== selectedId) { disposeScanObject(object); return; }
  if (preview) { preview.observer.disconnect(); preview.controls.dispose(); disposeScanObject(preview.scene); preview.renderer.dispose(); preview.renderer.domElement.remove(); }
  const element = root.querySelector('.rc-preview');
  element.querySelector('p').hidden = true;
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0x171b22);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 2.8));
  const sunlight = new THREE.DirectionalLight(0xffffff, 2); sunlight.position.set(3, 5, 4); scene.add(sunlight);
  scene.add(object);
  const bounds = new THREE.Box3().setFromObject(object), centre = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3()), radius = Math.max(size.x, size.y, size.z, .01);
  const camera = new THREE.PerspectiveCamera(42, 1, radius / 1000, radius * 100);
  camera.position.copy(centre).add(new THREE.Vector3(radius * 1.5, radius, radius * 1.8));
  const renderer = new THREE.WebGLRenderer({ antialias: true }); renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1;
  element.appendChild(renderer.domElement);
  const controls = new OrbitControls(camera, renderer.domElement); controls.target.copy(centre); controls.update();
  const render = () => renderer.render(scene, camera);
  controls.addEventListener('change', render);
  const observer = new ResizeObserver(() => { const w = element.clientWidth, h = Math.max(240, element.clientHeight); renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix(); render(); });
  observer.observe(element); preview = { scene, renderer, controls, observer }; render();
  setMessage('Drag to orbit, pinch or scroll to inspect the actual reconstructed geometry and textures.');
}

export function mount(container) {
  root = container; property = activeProperty(); mountEpoch++;
  if (!property) {
    root.innerHTML = '<div class="view-scroll"><span class="view-title">PHOTO TO 3D</span><p>Create a property from the PROPERTY selector before reconstructing a model.</p></div>';
    return;
  }
  files = []; galleryIds.clear(); capabilities = null; message = '';
  root.classList.add('reconstruction-view');
  root.innerHTML = `<div class="rc-head"><div><span class="view-title">PHOTO TO 3D</span><p>Build a textured model from overlapping photographs on your Mac.</p></div><a href="#/photos" class="btn">PHOTO LIBRARY</a></div>
    <div class="rc-layout"><section class="rc-capture">
      <div class="rc-engine" role="status">Checking local reconstruction engine…</div>
      <details class="rc-recipe" open><summary>Capture a sharper, more complete model</summary>
        <ol><li>Take 60–150 sharp photos around the same stationary object or section of your site. Aim for roughly 70% overlap between neighbors.</li>
          <li>Make two or three passes at different heights. Walk slowly, keep lighting consistent, and fill the frame with textured surfaces.</li>
          <li>Keep original camera files. Avoid digital zoom, motion blur, reflective glass and moving subjects. A single image or panorama cannot recover hidden geometry.</li>
          <li>For large rooms or outdoor sites, capture smaller overlapping sections first. Measure a known distance so you can check scale after importing.</li></ol>
        <p>JPEG, PNG, HEIC/HEIF and TIFF originals are accepted by the Mac engine. HEIC can upload here even when your browser cannot preview it. This is local Object Capture photogrammetry; each result is a mesh, not a survey-grade map or Gaussian splat.</p></details>
      <label>Model name<input name="name" value="Photo model" maxlength="120"></label>
      <div class="rc-options"><label>Detail<select name="quality"><option value="preview">Preview · quick capture check</option><option value="reduced">Reduced · phone friendly</option><option value="medium" selected>Medium · detailed textured model</option><option value="full">Full · maximum practical detail</option><option value="raw">Raw · highest detail, large files</option></select></label>
        <label>Photo order<select name="order"><option value="unordered">Unordered photos</option><option value="sequential">Sequential camera pass</option></select></label></div>
      <p class="rc-note">Full and raw require more memory and processing time. No input photos are resized by Tiksi. The engine reports any automatic downsampling.</p>
      <div class="rc-actions"><button class="btn" data-action=upload>Choose original photos</button><button class="btn" data-action=camera>Take a photo</button><button class="btn" data-action=clear>Clear selection</button></div>
      <input type="file" class="hidden-file rc-upload" accept=".jpg,.jpeg,.png,.heic,.heif,.tif,.tiff" multiple>
      <input type="file" class="hidden-file rc-camera" accept="image/*" capture="environment">
      <p class="rc-selection"></p><p class="rc-file-list"></p>
      <details><summary>Choose photos from this property's library</summary><p>Older saved photos may have been reduced to 2048 pixels; use original files for better reconstruction.</p><div class="rc-gallery"></div></details>
      <button class="btn primary rc-start" data-action=start>RECONSTRUCT 3D MODEL</button>
      <p class="rc-note">20–300 photos · up to 60 MB each · 2 GB per job. Uploaded copies and models stay in this local instance until you remove the job. No cloud upload.</p>
      <p class="rc-message" role="status" aria-live="polite"></p>
    </section><section class="rc-results"><label>Saved jobs on this Mac<select class="rc-job-select"></select></label><div class="rc-job"></div>
      <div class="rc-preview"><p>Review reconstructed surfaces and textures here.</p></div><a href="#/model" class="btn rc-open-model" hidden>OPEN MODEL TO ALIGN AND CALIBRATE</a></section></div>`;
  const upload = root.querySelector('.rc-upload'), camera = root.querySelector('.rc-camera');
  root.querySelector('[data-action=upload]').onclick = () => upload.click();
  root.querySelector('[data-action=camera]').onclick = () => camera.click();
  for (const input of [upload, camera]) input.onchange = () => { if (!busy) addFiles(input.files); input.value = ''; };
  root.querySelector('[data-action=clear]').onclick = () => { files = []; galleryIds.clear(); renderSelection(); renderGallery(); };
  root.querySelector('[data-action=start]').onclick = reconstruct;
  root.querySelector('.rc-job-select').onchange = event => { clearPreview(); job = jobs.find(j => j.id === event.target.value) || null; renderJob(); };
  renderSelection(); renderGallery(); renderJobs(); renderJob();
  const epoch = mountEpoch;
  fetch(BASE + '/capabilities', { cache: 'no-store' }).then(async response => {
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error('Photo reconstruction needs the local Tiksi server. Open your Mac or Tailscale instance; GitHub Pages cannot run the native engine.');
    const data = await response.json();
    if (!root || epoch !== mountEpoch) return;
    capabilities = data;
    serverToken = data.token;
    root.querySelector('.rc-engine').textContent = data.available ? 'Apple Object Capture is ready · original photos process locally on your Mac' : data.reason;
    renderSelection(); await refresh();
    poll = setInterval(() => { if (!busy) refresh().catch(error => setMessage(err(error))); }, 2500);
  }).catch(error => { if (root && epoch === mountEpoch) root.querySelector('.rc-engine').textContent = err(error); });
}
export function unmount() {
  mountEpoch++; clearInterval(poll); poll = null; clearPreview();
  if (root) root.classList.remove('reconstruction-view');
  root = null; property = null;
}
