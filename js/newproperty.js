// NEW PROPERTY: one field that takes a name or a Polycam share link. A name makes a blank
// property. A link makes the property from the scan, in one go: resolve the page, download
// the model, keep it as a reference scan, square it up, propose walls, rooms, doors and
// windows, render the plan underlay from the scan itself, keep the cover photo, and seed a
// starter project with the takeoffs. If the browser cannot reach the model (Polycam does
// not let other sites read its files unless a relay helps), the property still exists with
// its link, the embedded Polycam viewer shows the capture, and the same pipeline runs on
// the file the user downloads from Polycam and drops here.

import { ws, touch, propertyTemplate, escapeHtml, fmtBytes, fmtLen, fmtArea, polyArea, getFile, activeProperty } from './store.js';
import { parseCaptureUrl, resolveCapture, downloadAsset, fetchCover, fetchCaptureDirect, fetchCoverDirect, relaysFor, DEFAULT_RELAYS } from './polycam.js';
import { importScanBytes, SCAN_ACCEPT } from './scans.js';
import { placeScanBytes, seedProject, proposalSummary } from './scan2plan.js';
import { chooseScanPlacement } from './scanplace.js';
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
// opts.url pre-fills a link; opts.into (a property id) adds the scan to that property instead
// of making a new one. A link pasted or dropped while a property is open offers both: it goes
// into the open property when that property has no plan or scan yet (made by name, photos
// first), otherwise into a new property unless the person picks the open one. The + button
// starts on a new property.
export function openNewPropertyDialog(opts) {
  opts = opts || {};
  if (dlg) { if (run) return; closeDialog(); }
  const here = opts.into ? ws.data.properties.find(p => p.id === opts.into) : activeProperty();
  const blank = here && !here.walls.length && !here.rooms.length && !(here.scans || []).length;
  let into = here && (opts.into || (opts.url && blank)) ? here.id : '';
  const linkOnly = !!opts.into;
  const el = document.createElement('div');
  el.className = 'modal-backdrop';
  el.id = 'np-dialog';
  el.dataset.state = 'idle';
  const relay = relaySetting();
  const custom = relay !== 'auto' && relay !== 'off';
  el.innerHTML = `
    <div class="modal np" role="dialog" aria-modal="true" aria-labelledby="np-title">
      <div class="modal-head">
        <h2 id="np-title" data-np-title>${icon('plus')}NEW PROPERTY</h2>
        <button class="btn ghost icon-btn" data-np-close title="Close (Esc)">${icon('close')}</button>
      </div>
      <div class="modal-body np-body">
        <div class="field">
          <label data-np-label>Name, or a Polycam share link</label>
          <input type="text" data-np-input autocomplete="off" spellcheck="false" placeholder="12 Elm Street, or https://poly.cam/capture/..." value="${escapeHtml(opts.url || '')}">
        </div>
        ${here ? `<div class="field" data-np-into-row hidden>
          <label>Where the scan goes</label>
          <div class="seg">
            <button type="button" class="seg-btn" data-into="" style="flex:1">A NEW PROPERTY</button>
            <button type="button" class="seg-btn" data-into="${escapeHtml(here.id)}" style="flex:1" title="${escapeHtml(here.name)}">ADD TO ${escapeHtml(here.name.length > 22 ? here.name.slice(0, 20) + '..' : here.name).toUpperCase()}</button>
          </div>
          <small class="np-small" data-np-into-note></small>
        </div>` : ''}
        <p class="np-hint" data-np-hint></p>
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
  const create = () => submit(input.value, into, linkOnly);
  el.querySelector('[data-np-create]').onclick = create;
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); create(); } });
  const refresh = () => {
    const link = parseCaptureUrl(input.value);
    const target = into && here ? here : null;
    const row = el.querySelector('[data-np-into-row]');
    if (row) {
      row.hidden = !link && !opts.into;
      row.querySelectorAll('[data-into]').forEach(b => b.classList.toggle('active', b.dataset.into === into));
      const note = row.querySelector('[data-np-into-note]');
      note.textContent = target
        ? (target.walls.length ? 'It joins what is there: you choose next floor, replace a floor, or a separate building once it is read.' : 'The plan is proposed from the scan; the photos already here stay.')
        : 'A new property is made from the scan.';
    }
    el.querySelector('[data-np-title]').innerHTML = target ? icon('scan') + 'ADD A POLYCAM SCAN' : icon('plus') + 'NEW PROPERTY';
    el.querySelector('[data-np-label]').textContent = linkOnly ? 'Polycam share link' : 'Name, or a Polycam share link';
    input.placeholder = linkOnly ? 'https://poly.cam/capture/...' : '12 Elm Street, or https://poly.cam/capture/...';
    el.querySelector('[data-np-hint]').innerHTML = target
      ? 'Paste a <b>poly.cam/capture</b> link and the scan joins <b>' + escapeHtml(target.name) + '</b>: it is kept as a reference scan, and its walls, rooms, doors and windows are proposed into the plan.'
      : 'Paste a <b>poly.cam/capture</b> link and tiksi builds the property from the scan: the model stays as a reference scan, a calibrated plan underlay is rendered from it, and walls, rooms, doors and windows are proposed for you to correct rather than draw.';
    el.querySelector('[data-np-create]').innerHTML = link ? icon('scan') + (target ? 'ADD SCAN' : 'BUILD FROM SCAN') : icon('plus') + (target ? 'ADD SCAN' : 'CREATE');
  };
  el.querySelectorAll('[data-into]').forEach(b => b.onclick = () => { into = b.dataset.into; refresh(); input.focus(); });
  input.addEventListener('input', refresh);
  refresh();
  input.focus();
  if (opts.url) input.select();
  if (opts.autoStart && parseCaptureUrl(opts.url || '')) submit(opts.url, into, linkOnly);
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

function submit(value, into, linkOnly) {
  const text = String(value || '').trim();
  if (!text) { setStatus(linkOnly ? 'Paste a Polycam share link.' : 'Type a name or paste a link.', 'warn'); return; }
  const link = parseCaptureUrl(text);
  if (!link && linkOnly) { setStatus('That is not a Polycam share link (poly.cam/capture/...).', 'warn'); return; }
  if (!link) {
    const p = propertyTemplate(text);
    ws.data.properties.push(p);
    ws.data.settings.activePropertyId = p.id;
    touch();
    closeDialog();
    app.refresh(); app.remount();
    return;
  }
  startLinkImport(link, into);
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

async function startLinkImport(link, intoId) {
  if (run) return;
  const target = intoId ? ws.data.properties.find(p => p.id === intoId) || null : null;
  const existing = target || findExisting(link);
  const created = !existing;
  let prop = existing;
  const newSource = () => ({ kind: 'polycam', url: link.url, captureId: link.captureId, embedUrl: link.embedUrl, title: '', status: 'pending', addedAt: new Date().toISOString() });
  if (!prop) {
    prop = propertyTemplate('Polycam ' + link.captureId.slice(0, 8));
    prop.source = newSource();
    ws.data.properties.push(prop);
  } else if (!prop.source) prop.source = newSource();
  // The property's own source record follows this capture only when it is this capture: a
  // second scan added to a property keeps the first one as the property's source.
  const src = prop.source && prop.source.captureId === link.captureId ? prop.source : { status: 'pending' };
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
  let scan = prop.scans.find(s => s.source && s.source.captureId === link.captureId) || null;
  try {
    if (existing && scan && (prop.walls.length || scan.kind !== 'mesh')) {
      log(target ? 'This capture is already in ' + prop.name : 'This capture is already a property here', 'ok', existing.name);
      finish(prop, null, null);
      return;
    }
    let bytes = null;
    // 0. Try public viewer compatibility artifacts before reading the share page.
    if (!scan) {
      const step0 = log('Fetching the model from Polycam', 'run', 'public viewer artifacts; availability depends on the capture');
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
        step0.warn(e.status === 404 ? 'No public mesh artifact. Share or download access may be disabled; an exported file also works.' : String(e && e.message || e));
      }
    }
    // 1-3. Otherwise the share page: title, cover, model (direct, then through a relay if allowed).
    let page = null;
    if (!bytes && !scan) {
      const step1 = log('Reading the share page', 'run');
      try {
        page = await resolveCapture(link, { relays: relayList, signal, onRoute: via => step1.detail(via === 'direct' ? 'asking Polycam directly' : 'through a relay') });
        if (page.title) {
          src.title = page.title;
          if (created) { prop.name = page.title; app.refresh(); dlg.querySelector('[data-np-name]').textContent = prop.name; }
          touch();
        }
        step1.ok((page.title ? '"' + page.title + '"' : 'no title') + (page.via === 'direct' ? '' : ' via relay') + (page.assets.length ? ', model found' : ', no model link on the page'));
      } catch (e) {
        if (signal.aborted) throw e;
        step1.warn(e.blocked ? 'blocked by the browser (' + e.message + ')' : e.message);
      }
      if (page && page.assets.length) {
        // A page can expose multiple exports. Skip unsupported ones and keep trying when
        // a signed URL expired or a preferred model fails, rather than taking only slot 0.
        const supported = page.assets.filter(a => /^(glb|gltf|ply|obj|stl|zip|spz|splat|ksplat|sog|las|pcd|xyz|pts|bin)$/.test(a.ext));
        for (const asset of supported) {
          const step2 = log('Downloading the model', 'run', asset.url.replace(/^https?:\/\//, '').slice(0, 80));
          try {
            const candidate = await downloadAsset(asset, link, {
              relays: relayList, signal,
              onRoute: via => step2.detail(via === 'direct' ? 'direct from Polycam storage' : 'through a relay'),
              onProgress: (got, total) => progress('Downloading ' + fmtBytes(got) + (total ? ' of ' + fmtBytes(total) : ''), total ? got / total : 0.5),
            });
            // Validate and store now so a corrupt candidate does not prevent the next one.
            scan = await importScanBytes(candidate.buffer, candidate.name, prop, { ...hooks, signal }, { source: { kind: 'polycam', url: link.url, captureId: link.captureId } });
            if (!scan) throw new Error('Not a supported scan');
            progress(null); step2.ok(fmtBytes(candidate.size) + (candidate.via === 'direct' ? '' : ' via relay')); break;
          } catch (e) { if (signal.aborted) throw e; progress(null); step2.warn(e.message); }
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
      src.status = 'blocked';
      touch();
      log('The model could not be fetched from here', 'warn', 'Polycam did not give the browser a readable file');
      showFallback(link, prop);
      return;
    }
    // 4. Keep the model, square it up, propose the plan.
    if (bytes) {
      const step4 = log('Storing the scan in this browser', 'run');
      scan = await importScanBytes(bytes.buffer, bytes.name, prop, { ...hooks, signal }, { source: { kind: 'polycam', url: link.url, captureId: link.captureId } });
      if (!scan) throw new Error('the file is not a scan tiksi can read');
      step4.ok(scan.name + ', ' + fmtBytes(bytes.size));
    }
    src.status = 'resolved';
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
  const joining = prop.walls.length > 0;
  const step = log(joining ? 'Fitting the scan against the plan that is here' : 'Squaring up the scan and proposing the plan', 'run');
  const rec = await getFile(scan.id);
  if (!rec || !rec.buffer) throw new Error('scan bytes are missing from storage');
  if (scan.kind !== 'mesh') { step.warn('only meshes can be planned; ' + scan.kind + ' scans are kept as reference'); finish(prop, null, null); return; }
  const { result, applied, mode } = await placeScanBytes(prop, scan, rec.buffer, hooks, fit => chooseScanPlacement(fit, scan.name));
  if (signal && signal.aborted) throw signal.reason || new Error('Cancelled');
  if (mode === 'reference') { step.ok('kept as reference; the plan is unchanged'); finish(prop, null, null); return; }
  if (applied) step.ok(proposalSummary(result, applied));
  else step.warn(proposalSummary(result, applied));
  let project = null;
  if (applied) {
    const added = mode === 'level' || mode === 'beside';
    project = seedProject(prop, applied, (added ? prop.name + ': ' + scan.name : (prop.source && prop.source.title ? prop.source.title : prop.name)) + ': scope from scan');
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
  c.onclick = () => { if (run) { run.abort.abort(new Error('cancelled')); return; } closeDialog(); app.remount(); };
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
      <span>In Polycam: open the capture, <b>Download</b>, choose <b>GLB</b> or the complete <b>GLTF/OBJ ZIP</b> (PLY and STL also work), then drop the file on this box. The scan, the underlay and the proposed plan follow automatically.</span>
      <div class="np-drop-row">
        <a class="btn" href="${escapeHtml(link.url)}" target="_blank" rel="noopener">${icon('link')}OPEN ON POLYCAM</a>
        <button class="btn primary" data-np-choose>${icon('upload')}CHOOSE FILE</button>
        <input type="file" data-np-file accept="${SCAN_ACCEPT}" hidden>
      </div>
    </div>`;
  const drop = fb.querySelector('[data-np-drop]');
  const file = fb.querySelector('[data-np-file]');
  fb.querySelector('[data-np-choose]').onclick = () => file.click();
  file.onchange = () => { const f = file.files[0]; file.value = ''; if (f) attachFile(prop, f, link); };
  const hasFiles = e => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  drop.addEventListener('dragover', e => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; drop.classList.add('over'); } });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', e => { if (!hasFiles(e)) return; e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) attachFile(prop, f, link); });
  showCloseOnly();
  setStatus('The property is ready; the scan is one download away.', 'warn');
}

async function attachFile(prop, file, link) {
  if (run) return;
  run = { abort: new AbortController(), prop };
  dlg.dataset.state = 'running';
  dlg.querySelector('[data-np-cancel]').textContent = 'CANCEL';
  dlg.querySelector('[data-np-fallback]').hidden = true;
  const signal = run.abort.signal;
  const step = log('Reading ' + file.name, 'run', fmtBytes(file.size));
  try {
    const buffer = await file.arrayBuffer();
    const scan = await importScanBytes(buffer, file.name, prop, { ...hooks, signal }, { source: { kind: 'polycam', url: link.url, captureId: link.captureId } });
    if (!scan) throw new Error('not a scan tiksi can read');
    step.ok(scan.kind + ' stored in this browser');
    if (prop.source && prop.source.captureId === link.captureId) { prop.source.status = 'resolved'; touch(); }
    await proposePlan(prop, scan, signal);
  } catch (e) {
    console.error(e);
    step.fail(String(e && e.message || e));
    run = null;
    dlg.dataset.state = 'blocked';
    showCloseOnly();
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
  const out = await placeScanBytes(prop, scan, rec.buffer, viewHooks, fit => chooseScanPlacement(fit, scan.name));
  if (out.applied) {
    const project = seedProject(prop, out.applied, prop.name + ': scope from ' + scan.name);
    if (project) { ws.data.projects.push(project); touch(); }
  }
  return Object.assign({ scan }, out);
}

export function dialogOpen() { return !!dlg; }
