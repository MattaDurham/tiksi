// NEW PROPERTY: one field that takes a name or a Polycam share link. A name makes a blank
// property. A link makes the property from the scan, in one go: resolve the page, download
// the model, keep it as a reference scan, square it up, propose walls, rooms, doors and
// windows, render the plan underlay from the scan itself, keep the cover photo, and seed a
// starter project with the takeoffs. If the browser cannot reach the model (Polycam does
// not let other sites read its files unless a relay helps), the property still exists with
// its link, the embedded Polycam viewer shows the capture, and the same pipeline runs on
// the file the user downloads from Polycam and drops here.

import { ws, touch, propertyTemplate, escapeHtml, fmtBytes, fmtLen, fmtArea, polyArea, getFile } from './store.js';
import { parseCaptureUrl, resolveCapture, downloadAsset, fetchCover, fetchCaptureDirect, fetchCoverDirect, relaysFor, DEFAULT_RELAYS } from './polycam.js';
import { importScanBytes, SCAN_ACCEPT } from './scans.js';
import { planFromScanBytes, seedProject, proposalSummary } from './scan2plan.js';
import { addPhotoFromFile } from './photos-store.js';
import { icon } from './icons.js';

let app = { remount() {}, refresh() {} };
let dlg = null;          // the open dialog element
let run = null;          // the pipeline in flight: { abort: AbortController, prop }

export function initNewProperty(hooks) { app = Object.assign(app, hooks || {}); }

// ---------- settings ----------
function relaySetting() { return ws.data.settings.linkRelay || 'auto'; }
function setRelaySetting(v) { ws.data.settings.linkRelay = v; touch(); }

// ---------- dialog ----------
export function openNewPropertyDialog(opts) {
  opts = opts || {};
  if (dlg) { if (run) return; closeDialog(); }
  const el = document.createElement('div');
  el.className = 'modal-backdrop';
  el.id = 'np-dialog';
  el.dataset.state = 'idle';
  const relay = relaySetting();
  const custom = relay !== 'auto' && relay !== 'off';
  el.innerHTML = `
    <div class="modal np" role="dialog" aria-modal="true" aria-labelledby="np-title">
      <div class="modal-head">
        <h2 id="np-title">${icon('plus')}NEW PROPERTY</h2>
        <button class="btn ghost icon-btn" data-np-close title="Close (Esc)">${icon('close')}</button>
      </div>
      <div class="modal-body np-body">
        <div class="field">
          <label>Name, or a Polycam share link</label>
          <input type="text" data-np-input autocomplete="off" spellcheck="false" placeholder="12 Elm Street, or https://poly.cam/capture/..." value="${escapeHtml(opts.url || '')}">
        </div>
        <p class="np-hint">Paste a <b>poly.cam/capture</b> link and tiksi builds the property from the scan: the model stays as a reference scan, a calibrated plan underlay is rendered from it, and walls, rooms, doors and windows are proposed for you to correct rather than draw.</p>
        <label class="tool-check np-relay" title="Browsers cannot read another site's files unless that site allows it. A relay adds that permission for a public link; it sees the link and returns the public bytes, nothing else. Your workspace never leaves this browser.">
          ${icon('link')}<span>USE A PUBLIC RELAY IF POLYCAM BLOCKS THE BROWSER</span><input type="checkbox" data-np-relay ${relay === 'off' ? '' : 'checked'}>
        </label>
        <details class="np-adv" ${custom ? 'open' : ''}>
          <summary>Relay address</summary>
          <div class="field"><input type="text" data-np-relay-url placeholder="${escapeHtml(DEFAULT_RELAYS[0])}" value="${custom ? escapeHtml(relay) : ''}" spellcheck="false">
          <small class="np-small">Blank uses the built-in public relays in turn. Put your own here (a Cloudflare Worker, say); <code>{url}</code> stands for the link.</small></div>
        </details>
      </div>
      <div class="modal-foot">
        <span class="np-status" data-np-status></span>
        <span style="flex:1"></span>
        <button class="btn" data-np-cancel>CANCEL</button>
        <button class="btn primary" data-np-create>${icon('plus')}CREATE</button>
      </div>
    </div>`;
  document.body.appendChild(el);
  dlg = el;
  const input = el.querySelector('[data-np-input]');
  const onKey = e => {
    if (e.key === 'Escape') { e.preventDefault(); if (!run) closeDialog(); }
  };
  el._cleanup = () => window.removeEventListener('keydown', onKey);
  window.addEventListener('keydown', onKey);
  el.querySelector('[data-np-close]').onclick = () => { if (!run) closeDialog(); };
  el.querySelector('[data-np-cancel]').onclick = () => { if (run) run.abort.abort(new Error('cancelled')); else closeDialog(); };
  el.addEventListener('pointerdown', e => { if (e.target === el && !run) closeDialog(); });
  el.querySelector('[data-np-relay]').onchange = e => setRelaySetting(e.target.checked ? (el.querySelector('[data-np-relay-url]').value.trim() || 'auto') : 'off');
  el.querySelector('[data-np-relay-url]').onchange = e => { const v = e.target.value.trim(); if (el.querySelector('[data-np-relay]').checked) setRelaySetting(v || 'auto'); };
  const create = () => submit(input.value);
  el.querySelector('[data-np-create]').onclick = create;
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); create(); } });
  input.addEventListener('input', () => {
    const link = parseCaptureUrl(input.value);
    el.querySelector('[data-np-create]').innerHTML = link ? icon('scan') + 'BUILD FROM SCAN' : icon('plus') + 'CREATE';
  });
  input.dispatchEvent(new Event('input'));
  input.focus();
  if (opts.url) input.select();
  if (opts.autoStart && parseCaptureUrl(opts.url || '')) submit(opts.url);
}

function closeDialog() {
  if (!dlg) return;
  if (dlg._cleanup) dlg._cleanup();
  dlg.remove();
  dlg = null;
}

function setStatus(text, kind) {
  const s = dlg && dlg.querySelector('[data-np-status]');
  if (!s) return;
  s.textContent = text || '';
  s.className = 'np-status ' + (kind || '');
}

function submit(value) {
  const text = String(value || '').trim();
  if (!text) { setStatus('Type a name or paste a link.', 'warn'); return; }
  const link = parseCaptureUrl(text);
  if (!link) {
    const p = propertyTemplate(text);
    ws.data.properties.push(p);
    ws.data.settings.activePropertyId = p.id;
    touch();
    closeDialog();
    app.refresh(); app.remount();
    return;
  }
  startLinkImport(link);
}

// ---------- the pipeline ----------
function relays() {
  const on = dlg ? dlg.querySelector('[data-np-relay]').checked : relaySetting() !== 'off';
  if (!on) return [];
  const custom = dlg ? dlg.querySelector('[data-np-relay-url]').value.trim() : '';
  return relaysFor(custom || relaySetting());
}

function findExisting(link) {
  return ws.data.properties.find(p => p.source && p.source.kind === 'polycam' && p.source.captureId === link.captureId) || null;
}

// The dialog turns into a worksheet: a step log on the left, the embedded capture on the right.
function renderRunning(link, prop) {
  const body = dlg.querySelector('.np-body');
  body.innerHTML = `
    <div class="np-run">
      <div class="np-left">
        <div class="np-target"><span class="np-kicker">FROM POLYCAM</span><b data-np-name>${escapeHtml(prop.name)}</b>
          <a class="np-link" href="${escapeHtml(link.url)}" target="_blank" rel="noopener">${escapeHtml(link.url.replace(/^https?:\/\//, ''))}</a></div>
        <ol class="np-log" data-np-log></ol>
        <div class="np-progress" data-np-progress hidden><div class="np-prog-label"></div><div class="np-prog-bar"><div class="np-prog-fill"></div></div></div>
        <div data-np-fallback hidden></div>
        <div data-np-result hidden></div>
      </div>
      <div class="np-right">
        <div class="np-embed"><iframe src="${escapeHtml(link.embedUrl)}" title="Polycam capture viewer" allow="fullscreen; xr-spatial-tracking" loading="lazy" referrerpolicy="no-referrer"></iframe></div>
        <small class="np-small">Polycam's own viewer of the capture (needs the internet; the property does not).</small>
      </div>
    </div>`;
  dlg.querySelector('[data-np-create]').hidden = true;
}

function log(label, state, detail) {
  const ol = dlg && dlg.querySelector('[data-np-log]');
  if (!ol) return null;
  const li = document.createElement('li');
  li.className = 'np-step ' + (state || 'run');
  li.innerHTML = `<span class="np-dot"></span><span class="np-step-text">${escapeHtml(label)}</span>${detail ? `<small>${escapeHtml(detail)}</small>` : ''}`;
  ol.appendChild(li);
  li.scrollIntoView({ block: 'nearest' });
  return {
    ok(d) { li.className = 'np-step ok'; if (d != null) setDetail(li, d); },
    warn(d) { li.className = 'np-step warn'; if (d != null) setDetail(li, d); },
    fail(d) { li.className = 'np-step fail'; if (d != null) setDetail(li, d); },
    detail(d) { setDetail(li, d); },
  };
}
function setDetail(li, d) {
  let s = li.querySelector('small');
  if (!s) { s = document.createElement('small'); li.appendChild(s); }
  s.textContent = d;
}

function progress(label, frac) {
  const p = dlg && dlg.querySelector('[data-np-progress]');
  if (!p) return;
  if (label == null) { p.hidden = true; return; }
  p.hidden = false;
  p.querySelector('.np-prog-label').textContent = label;
  p.querySelector('.np-prog-fill').style.width = Math.round((frac == null ? 0.5 : Math.min(1, Math.max(0, frac))) * 100) + '%';
}

const hooks = {
  progress,
  toast(msg, kind) { log(msg, kind === 'warn' ? 'warn' : (kind === 'error' ? 'fail' : 'ok')); },
};

async function startLinkImport(link) {
  if (run) return;
  const existing = findExisting(link);
  let prop = existing;
  if (!prop) {
    prop = propertyTemplate('Polycam ' + link.captureId.slice(0, 8));
    prop.source = { kind: 'polycam', url: link.url, captureId: link.captureId, embedUrl: link.embedUrl, title: '', status: 'pending', addedAt: new Date().toISOString() };
    ws.data.properties.push(prop);
  }
  ws.data.settings.activePropertyId = prop.id;
  touch();
  app.refresh();
  // Read the relay choice now: the worksheet replaces the form (and its checkbox) next.
  const relayList = relays();
  run = { abort: new AbortController(), prop, link, relays: relayList };
  dlg.dataset.state = 'running';
  renderRunning(link, prop);
  setStatus('Working. The property already exists; cancelling keeps it.', '');
  const signal = run.abort.signal;
  let scan = prop.scans.find(s => s.kind === 'mesh') || null;
  try {
    if (existing && scan && prop.walls.length) {
      log('This capture is already a property here', 'ok', existing.name);
      finish(prop, null, null);
      return;
    }
    let bytes = null;
    // 0. The model straight from the endpoint Polycam's own viewer uses (open CORS, no relay).
    if (!scan) {
      const step0 = log('Fetching the model from Polycam', 'run', 'the viewer endpoint, no relay');
      try {
        bytes = await fetchCaptureDirect(link, {
          signal,
          onProgress: (label, got, total) => progress('Downloading ' + label + ': ' + fmtBytes(got) + (total ? ' of ' + fmtBytes(total) : ''), total ? got / total : 0.5),
        });
        progress(null);
        step0.ok(fmtBytes(bytes.size) + (bytes.textures ? ', textured' : ''));
        if (!prop.photos.some(ph => ph.source === 'polycam-cover')) {
          const file = await fetchCoverDirect(link, { signal });
          if (file) {
            try { const ph = await addPhotoFromFile(prop, file); ph.source = 'polycam-cover'; ph.notes = 'Cover image from Polycam.'; touch(); log('Kept the cover image as a site photo', 'ok'); }
            catch (e) { /* not important */ }
          }
        }
      } catch (e) {
        if (signal.aborted) throw e;
        progress(null);
        step0.warn(e.status === 404 ? 'Polycam has no raw mesh at that link (is link sharing on?)' : String(e && e.message || e));
      }
    }
    // 1-3. Otherwise the share page: title, cover, model (direct, then through a relay if allowed).
    let page = null;
    if (!bytes && !scan) {
      const step1 = log('Reading the share page', 'run');
      try {
        page = await resolveCapture(link, { relays: relayList, signal, onRoute: via => step1.detail(via === 'direct' ? 'asking Polycam directly' : 'through a relay') });
        if (page.title) { prop.name = page.title; prop.source.title = page.title; touch(); app.refresh(); dlg.querySelector('[data-np-name]').textContent = prop.name; }
        step1.ok((page.title ? '"' + page.title + '"' : 'no title') + (page.via === 'direct' ? '' : ' via relay') + (page.assets.length ? ', model found' : ', no model link on the page'));
      } catch (e) {
        if (signal.aborted) throw e;
        step1.warn(e.blocked ? 'blocked by the browser (' + e.message + ')' : e.message);
      }
      if (page && page.assets.length) {
        const asset = page.assets[0];
        const step2 = log('Downloading the model', 'run', asset.url.replace(/^https?:\/\//, '').slice(0, 80));
        try {
          bytes = await downloadAsset(asset, link, {
            relays: relayList, signal,
            onRoute: via => step2.detail(via === 'direct' ? 'direct from Polycam storage' : 'through a relay'),
            onProgress: (got, total) => progress('Downloading ' + fmtBytes(got) + (total ? ' of ' + fmtBytes(total) : ''), total ? got / total : 0.5),
          });
          progress(null);
          step2.ok(fmtBytes(bytes.size) + (bytes.via === 'direct' ? '' : ' via relay'));
        } catch (e) {
          if (signal.aborted) throw e;
          progress(null);
          step2.warn(e.message);
        }
      }
      if (page && page.image && !prop.photos.some(ph => ph.source === 'polycam-cover')) {
        const file = await fetchCover(page.image, { relays: relayList, signal });
        if (file) {
          try { const ph = await addPhotoFromFile(prop, file); ph.source = 'polycam-cover'; ph.notes = 'Cover image from Polycam.'; touch(); log('Kept the cover image as a site photo', 'ok'); }
          catch (e) { /* not important */ }
        }
      }
    }
    if (!bytes && !scan) {
      prop.source.status = 'blocked';
      touch();
      log('The model could not be fetched from here', 'warn', 'Polycam did not give the browser a readable file');
      showFallback(link, prop);
      return;
    }
    // 4. Keep the model, square it up, propose the plan.
    if (bytes) {
      const step4 = log('Storing the scan in this browser', 'run');
      scan = await importScanBytes(bytes.buffer, bytes.name, prop, hooks, { source: { kind: 'polycam', url: link.url, captureId: link.captureId } });
      if (!scan) throw new Error('the file is not a scan tiksi can read');
      step4.ok(scan.name + ', ' + fmtBytes(bytes.size));
    }
    prop.source.status = 'resolved';
    touch();
    await proposePlan(prop, scan, signal);
  } catch (e) {
    console.error(e);
    if (signal.aborted) { log('Cancelled', 'warn'); setStatus('Cancelled. The property stays; use PROPOSE PLAN FROM SCAN later.', 'warn'); }
    else { log('Failed', 'fail', String(e && e.message || e)); setStatus('Something went wrong; the property was kept.', 'fail'); }
    dlg.dataset.state = 'failed';
    run = null;
    showCloseOnly();
  }
}

async function proposePlan(prop, scan, signal) {
  const step = log('Squaring up the scan and proposing the plan', 'run');
  const rec = await getFile(scan.id);
  if (!rec || !rec.buffer) throw new Error('scan bytes are missing from storage');
  if (scan.kind !== 'mesh') { step.warn('only meshes can be planned; ' + scan.kind + ' scans are kept as reference'); finish(prop, null, null); return; }
  const { result, applied } = await planFromScanBytes(prop, scan, rec.buffer, hooks);
  if (signal && signal.aborted) return;
  if (applied) step.ok(proposalSummary(result, applied));
  else step.warn(proposalSummary(result, applied));
  let project = null;
  if (applied) {
    project = seedProject(prop, applied, (prop.source && prop.source.title ? prop.source.title : prop.name) + ': scope from scan');
    if (project) { ws.data.projects.push(project); touch(); log('Seeded a starter project with the takeoffs', 'ok', project.items.length + ' scope items linked to the model'); }
  }
  finish(prop, result, applied);
}

function finish(prop, result, applied) {
  run = null;
  dlg.dataset.state = 'done';
  app.refresh();
  const box = dlg.querySelector('[data-np-result]');
  const floor = prop.rooms.reduce((n, r) => n + polyArea(r.pts), 0);
  const levels = prop.levels || [];
  box.hidden = false;
  box.innerHTML = `
    <div class="np-summary">
      <div class="kpi"><span class="k-label">WALLS</span><span class="k-value">${prop.walls.length}</span></div>
      <div class="kpi"><span class="k-label">ROOMS</span><span class="k-value">${prop.rooms.length}</span></div>
      <div class="kpi"><span class="k-label">OPENINGS</span><span class="k-value">${prop.openings.length}</span></div>
      <div class="kpi"><span class="k-label">FLOOR</span><span class="k-value small">${escapeHtml(fmtArea(floor))}</span></div>
      ${levels.length > 1
        ? `<div class="kpi"><span class="k-label">LEVELS</span><span class="k-value">${levels.length}</span></div>`
        : `<div class="kpi"><span class="k-label">CEILING</span><span class="k-value small">${escapeHtml(fmtLen(levels[0] ? levels[0].height : prop.wallHeight))}</span></div>`}
    </div>
    <div class="np-actions">
      <button class="btn primary" data-np-go="plan">${icon('plan')}OPEN PLAN</button>
      <button class="btn" data-np-go="model">${icon('model')}OPEN MODEL</button>
    </div>`;
  box.querySelectorAll('[data-np-go]').forEach(b => b.onclick = () => { closeDialog(); location.hash = '#/' + b.dataset.npGo; app.remount(); });
  showCloseOnly();
  setStatus(applied ? 'Done. Every proposed element is editable; the underlay of every level is the scan itself.' : 'Done.', 'ok');
}

function showCloseOnly() {
  const c = dlg.querySelector('[data-np-cancel]');
  c.textContent = 'CLOSE';
  c.onclick = () => { closeDialog(); app.remount(); };
}

// Blocked: the property exists, the embed shows the capture; the model comes in by hand.
function showFallback(link, prop) {
  run = null;
  dlg.dataset.state = 'blocked';
  app.refresh();
  const fb = dlg.querySelector('[data-np-fallback]');
  fb.hidden = false;
  fb.innerHTML = `
    <div class="np-drop" data-np-drop tabindex="0">
      <span class="empty-ic">${icon('upload')}</span>
      <b>Drop the model file here</b>
      <span>In Polycam: open the capture, <b>Download</b>, choose <b>GLB</b> (or GLTF, OBJ, PLY), then drop the file on this box. The scan, the underlay and the proposed plan follow automatically.</span>
      <div class="np-drop-row">
        <a class="btn" href="${escapeHtml(link.url)}" target="_blank" rel="noopener">${icon('link')}OPEN ON POLYCAM</a>
        <button class="btn primary" data-np-choose>${icon('upload')}CHOOSE FILE</button>
        <input type="file" data-np-file accept="${SCAN_ACCEPT}" hidden>
      </div>
    </div>`;
  const drop = fb.querySelector('[data-np-drop]');
  const file = fb.querySelector('[data-np-file]');
  fb.querySelector('[data-np-choose]').onclick = () => file.click();
  file.onchange = () => { const f = file.files[0]; file.value = ''; if (f) attachFile(prop, f); };
  const hasFiles = e => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  drop.addEventListener('dragover', e => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; drop.classList.add('over'); } });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', e => { if (!hasFiles(e)) return; e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) attachFile(prop, f); });
  showCloseOnly();
  setStatus('The property is ready; the scan is one download away.', 'warn');
}

async function attachFile(prop, file) {
  if (run) return;
  run = { abort: new AbortController(), prop };
  dlg.dataset.state = 'running';
  dlg.querySelector('[data-np-fallback]').hidden = true;
  const step = log('Reading ' + file.name, 'run', fmtBytes(file.size));
  try {
    const buffer = await file.arrayBuffer();
    const scan = await importScanBytes(buffer, file.name, prop, hooks, prop.source ? { source: { kind: prop.source.kind, url: prop.source.url, captureId: prop.source.captureId } } : null);
    if (!scan) throw new Error('not a scan tiksi can read');
    step.ok(scan.kind + ' stored in this browser');
    if (prop.source) { prop.source.status = 'resolved'; touch(); }
    await proposePlan(prop, scan, run.abort.signal);
  } catch (e) {
    console.error(e);
    step.fail(String(e && e.message || e));
    run = null;
    dlg.dataset.state = 'blocked';
    dlg.querySelector('[data-np-fallback]').hidden = false;
    setStatus('Could not use that file: ' + String(e && e.message || e), 'fail');
  }
}

// Used by the plan view's ATTACH SCAN FILE and by drops elsewhere: the same path, no dialog.
export async function attachScanFileToProperty(prop, file, viewHooks) {
  const buffer = await file.arrayBuffer();
  const scan = await importScanBytes(buffer, file.name, prop, viewHooks, prop.source ? { source: { kind: prop.source.kind, url: prop.source.url, captureId: prop.source.captureId } } : null);
  if (!scan) return null;
  if (prop.source) { prop.source.status = 'resolved'; touch(); }
  if (scan.kind !== 'mesh') return { scan, result: null, applied: null };
  const rec = await getFile(scan.id);
  const out = await planFromScanBytes(prop, scan, rec.buffer, viewHooks);
  if (out.applied) {
    const project = seedProject(prop, out.applied, prop.name + ': scope from scan');
    if (project) { ws.data.projects.push(project); touch(); }
  }
  return Object.assign({ scan }, out);
}

export function dialogOpen() { return !!dlg; }
