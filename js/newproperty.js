// NEW PROPERTY: one field that takes a name or a Polycam share link. A name makes a blank
// property. A link makes the property from the scan, in one go: resolve the page, download
// the model, keep it as a reference scan, square it up, propose walls, rooms, doors and
// windows, render the plan underlay from the scan itself, keep the cover photo, and seed a
// starter project with the takeoffs. If the browser cannot reach the model (Polycam does
// not let other sites read its files unless a relay helps), the property still exists with
// its link, the embedded Polycam viewer shows the capture, and the same pipeline runs on
// the file the user downloads from Polycam and drops here.
//
// CHOOSE A FOLDER makes the property from a folder of site-visit files instead: it lists what
// the folder holds, the person names the property and unticks what should stay out, and the
// scans, photos, PDFs and videos come in through the same importers the rest of Tiksi uses.
// A note in the folder holding a Polycam link brings that scan in as above.

import { ws, touch, propertyTemplate, escapeHtml, fmtBytes, fmtLen, fmtArea, roomsFloorArea, getFile, activeProperty } from './store.js';
import { parseCaptureUrl, resolveCapture, downloadAsset, fetchCover, fetchCaptureDirect, fetchCoverDirect, relaysFor, DEFAULT_RELAYS } from './polycam.js';
import { importScanBytes, importScanFile, SCAN_ACCEPT } from './scans.js';
import { placeScanBytes, seedProject, proposalSummary } from './scan2plan.js';
import { proposeFixtures, openFixtureReview } from './fixtures-ui.js';
import { chooseScanPlacement } from './scanplace.js';
import { addPhotoFromFile } from './photos-store.js';
import { icon } from './icons.js';
import { makeFirstOnePager, openOnePagerEditor } from './one-pager-dialog.js';
import { addDocumentFromFile } from './documents.js';
import { addVideoFromFile } from './videos.js';
import {
  classifyFolder, inspectFolder, summarize, suggestName, folderService, folderServiceKnown, chooseFolderOnMac, pickFolderInBrowser,
  IMPORTED, baseName, dirName,
} from './folder-intake.js';

let app = { remount() {}, refresh() {}, toast() {} };
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
        ${linkOnly ? '' : `<div class="np-folder" data-np-folder-row>
          <button type="button" class="btn" data-np-folder>${icon('folder')}CHOOSE A FOLDER…</button>
          <small class="np-small">Or pick the folder you put a site visit in: its scans, photos, videos and PDFs come in together, and you choose what stays out before anything is made.</small>
        </div>`}
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
  const folderBtn = el.querySelector('[data-np-folder]');
  if (folderBtn) {
    // Learn now whether the Mac's folder window is on offer, so the click itself need not wait.
    folderService();
    folderBtn.onclick = () => startFolder(input.value);
  }
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
  if (opts.folder && folderBtn) startFolder('');
}

function closeDialog() {
  if (!dlg) return;
  if (dlg._cleanup) dlg._cleanup();
  // The server forgets a picked folder once its dialog is gone.
  if (dlg._folder) dlg._folder.forget();
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
    // Every property starts with a one-pager: its first draft is version 1, made right away.
    makeFirstOnePager(p).then(v => { if (v) app.toast('One-pager version 1 saved for ' + p.name + '. FILE > Project > OPEN ONE-PAGER edits it.'); })
      .catch(e => { console.error(e); app.toast('The first one-pager could not be made: ' + (e.message || e), 'error'); });
    return;
  }
  startLinkImport(link, into);
}

// ---------- the pipeline ----------
function relays() {
  const box = dlg && dlg.querySelector('[data-np-relay]');
  const on = box ? box.checked : relaySetting() !== 'off';
  if (!on) return [];
  const custom = box ? dlg.querySelector('[data-np-relay-url]').value.trim() : '';
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
    // A mesh already kept from this capture, with no plan yet, goes straight to the plan.
    if (scan) { src.status = 'resolved'; touch(); }
    else {
      scan = await fetchLinkScan(link, prop, src, created, signal, relayList);
      if (!scan) { showFallback(link, prop); return; }
    }
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

// Steps 0 to 4 of a link: the public viewer artifacts, else the share page (title, cover,
// model), then the model kept as a scan of `prop`. Returns the scan, or null when Polycam gave
// the browser no readable file (`src.status` is then 'blocked'). `created` is true when the
// property was just made from this link and takes the capture's title as its name.
async function fetchLinkScan(link, prop, src, created, signal, relayList) {
  let scan = null;
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
    return null;
  }
  // 4. Keep the model.
  if (bytes) {
    const step4 = log('Storing the scan in this browser', 'run');
    scan = await importScanBytes(bytes.buffer, bytes.name, prop, { ...hooks, signal }, { source: { kind: 'polycam', url: link.url, captureId: link.captureId } });
    if (!scan) throw new Error('the file is not a scan tiksi can read');
    step4.ok(scan.name + ', ' + fmtBytes(bytes.size));
  }
  src.status = 'resolved';
  touch();
  return scan;
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
  if (applied && !result.review?.required) step.ok(proposalSummary(result, applied));
  else step.warn(proposalSummary(result, applied));
  let project = null;
  if (applied) {
    const added = mode === 'level' || mode === 'beside';
    project = seedProject(prop, applied, (added ? prop.name + ': ' + scan.name : (prop.source && prop.source.title ? prop.source.title : prop.name)) + ': scope from scan');
    if (project) { ws.data.projects.push(project); touch(); log('Seeded a starter project with the takeoffs', 'ok', project.items.length + ' scope items linked to the model'); }
    // What stands in the rooms, read now and offered for review when the run is done.
    const fx = log('Reading counters, cabinets and furniture from the scan', 'run');
    try {
      const proposals = await proposeFixtures(prop, scan, hooks);
      fx?.ok(proposals.length ? proposals.length + ' proposed for review' : 'none found');
      finish(prop, result, applied, proposals.length ? { proposals, scanName: scan.name } : null);
      return;
    } catch (e) { console.error(e); fx?.warn('skipped: ' + String(e && e.message || e)); }
  }
  finish(prop, result, applied);
}

function finish(prop, result, applied, fixtures) {
  run = null;
  app.refresh();
  const box = dlg.querySelector('[data-np-result]');
  const floor = roomsFloorArea(prop.rooms);
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
      ${fixtures ? `<button class="btn" data-np-fixtures>${icon('scan')}REVIEW ${fixtures.proposals.length} FIXTURE${fixtures.proposals.length === 1 ? '' : 'S'}</button>` : ''}
      <button class="btn primary" data-np-go="model">${icon('model')}OPEN MODEL</button>
      <button class="btn" data-np-onepager-open hidden>${icon('file')}OPEN ONE-PAGER</button>
    </div>`;
  // The first one-pager is part of making the property: version 1, from the scan's cover
  // photo (or the model) and the proposed plan and scope. The dialog reads done once it is in.
  const opStep = log('Making the first one-pager', 'run');
  makeFirstOnePager(prop, { progress: t => opStep && opStep.detail(t) })
    .then(v => { if (opStep) opStep.ok(v ? 'version ' + v.n + ' saved to the documents' : 'already there'); const b = dlg && dlg.querySelector('[data-np-onepager-open]'); if (b) { b.hidden = false; b.onclick = () => { closeDialog(); app.remount(); openOnePagerEditor(prop); }; } })
    .catch(e => { console.error(e); if (opStep) opStep.warn('not made: ' + (e.message || e)); })
    .finally(() => { if (dlg) dlg.dataset.state = 'done'; });
  box.querySelectorAll('[data-np-go]').forEach(b => b.onclick = () => { closeDialog(); location.hash = '#/' + b.dataset.npGo; app.remount(); });
  const fxBtn = box.querySelector('[data-np-fixtures]');
  if (fxBtn) fxBtn.onclick = async () => {
    const added = await openFixtureReview(prop, fixtures.proposals, { scanName: fixtures.scanName });
    fxBtn.disabled = true;
    fxBtn.textContent = added.length ? 'ADDED ' + added.length + ' FIXTURE' + (added.length === 1 ? '' : 'S') : 'NO FIXTURES ADDED';
    app.refresh();
  };
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

// ---------- a property from a folder ----------
let folderBusy = false;
const onDisk = () => document.querySelector('meta[name="tiksi-storage"]')?.content === 'project-files';
const STAYS = {
  audio: 'Tiksi does not keep audio recordings yet.',
  cameras: 'Attach it from MODEL once the scan is in: its keyframes place the photos.',
  project: 'Already a Tiksi project: FILE > OPEN / IMPORT opens it.',
  other: 'Tiksi does not read this kind of file.',
};

async function startFolder(typedName) {
  if (run || folderBusy || !dlg) return;
  folderBusy = true;
  const el = dlg;
  let source = null;
  try {
    // The browser's own picker must open while the click still counts, so what the server
    // offers is taken from what is already known, or waited for only briefly.
    const known = folderServiceKnown() || await Promise.race([folderService(), new Promise(r => setTimeout(() => r(null), 1500))]);
    if (known && known.choose) {
      setStatus('Choose the folder in the window that opened on the Mac.', '');
      el.querySelectorAll('[data-np-folder], [data-np-create]').forEach(b => { b.disabled = true; });
      source = await chooseFolderOnMac();
    } else source = await pickFolderInBrowser();
    if (dlg !== el) { if (source) source.forget(); return; }
    if (!source) { setStatus('No folder chosen; nothing changed.', 'warn'); return; }
    setStatus('Reading ' + source.name + '…', '');
    const items = await inspectFolder(classifyFolder(source.files), async path => (await source.read(path)).text());
    if (dlg !== el) { source.forget(); return; }
    renderFolderReview(source, items, typedName);
  } catch (e) {
    console.error(e);
    if (source) source.forget();
    if (dlg === el) setStatus(String(e && e.message || e), 'fail');
  } finally {
    folderBusy = false;
    if (dlg === el && el.dataset.state === 'idle') el.querySelectorAll('[data-np-folder], [data-np-create]').forEach(b => { b.disabled = false; });
  }
}

// What the folder holds, before anything is made: a name, every file that would come in (each
// can be unticked), and every file that stays where it is with the reason.
function renderFolderReview(source, items, typedName) {
  dlg._folder = source;
  dlg.dataset.state = 'review';
  const typed = String(typedName || '').trim();
  const name = (typed && !parseCaptureUrl(typed) ? typed : '') || suggestName(source.name);
  const groups = summarize(items);
  const coming = groups.filter(g => g.imported), staying = groups.filter(g => !g.imported);
  const usable = i => IMPORTED.has(i.kind) && !i.tooLarge;
  const subfolders = [...new Set(items.filter(i => usable(i) && i.group).map(i => i.group))].sort((a, b) => a.localeCompare(b));
  const index = new Map(items.map((item, n) => [item, n]));
  const where = source.where === 'mac'
    ? 'The project file will be kept in this folder, in a <b>Tiksi</b> folder that Tiksi adds. The files are copied into the project; nothing in the folder is moved, renamed or deleted.'
    : onDisk() ? 'The files are copied to Tiksi\'s projects folder on the Mac. The folder you picked is not changed.'
    : 'The files are copied into this browser; SAVE PROJECT writes them to a .tiksi file. The folder you picked is not changed.';
  const row = item => {
    const label = item.kind === 'link' ? item.link.url.replace(/^https?:\/\//, '') + '  (in ' + item.path + ')' : item.path;
    const extra = item.tooLarge ? 'over 600 MB: stays in the folder'
      : [item.kind === 'link' ? 'the scan is downloaded from Polycam' : fmtBytes(item.size),
        item.companions && item.companions.length ? '+ ' + item.companions.length + ' companion file' + (item.companions.length === 1 ? '' : 's') : '',
        item.missing && item.missing.length ? 'names ' + item.missing.length + ' file' + (item.missing.length === 1 ? '' : 's') + ' not in the folder' : ''].filter(Boolean).join(' · ');
    return `<li><label><input type="checkbox" data-nf-item="${index.get(item)}" ${item.tooLarge ? 'disabled' : 'checked'}><span class="nf-path">${escapeHtml(label)}</span><small>${escapeHtml(extra)}</small></label></li>`;
  };
  const body = dlg.querySelector('.np-body');
  body.innerHTML = `
    <div class="nf-review">
      <div class="field"><label>Property name</label><input type="text" data-nf-name autocomplete="off" spellcheck="false" value="${escapeHtml(name)}"></div>
      <p class="np-hint"><b>${escapeHtml(source.path || source.name)}</b><br>${where}</p>
      ${subfolders.length ? `<div class="nf-groups"><span class="np-kicker">SUBFOLDERS</span>${subfolders.map(g =>
        `<label class="tool-check"><input type="checkbox" data-nf-group="${escapeHtml(g)}" checked><span>${escapeHtml(g)}</span><small>${items.filter(i => usable(i) && i.group === g).length} to import</small></label>`).join('')}</div>` : ''}
      ${coming.length ? coming.map(g => `<details class="nf-kind" ${g.count <= 12 ? 'open' : ''}>
        <summary><input type="checkbox" data-nf-kind="${g.kind}" checked aria-label="${escapeHtml(g.label)}"><b>${escapeHtml(g.label)}</b><span data-nf-count="${g.kind}"></span></summary>
        <ul>${g.items.map(row).join('')}</ul></details>`).join('') : '<p class="np-hint">Nothing in this folder is a kind of file Tiksi imports. CREATE makes an empty property kept here.</p>'}
      ${staying.length ? `<div class="nf-stay"><span class="np-kicker">STAYS IN THE FOLDER, NOT IMPORTED</span>${staying.map(g => `<details class="nf-kind">
        <summary><b>${escapeHtml(g.label)}</b><span>${g.count} · ${escapeHtml(fmtBytes(g.bytes))}</span></summary>
        <ul>${g.items.map(item => `<li><span class="nf-path">${escapeHtml(item.path)}${item.kind === 'cameras' ? ' (' + item.count + ' camera frames)' : ''}</span><small>${escapeHtml(item.note || STAYS[item.kind])}</small></li>`).join('')}</ul></details>`).join('')}</div>` : ''}
      ${source.truncated ? '<p class="np-hint nf-warn">This folder holds more files than Tiksi lists at once; only the first 20,000 are shown. Pick the folder of one site visit.</p>' : ''}
      ${source.skipped && source.skipped.hidden ? `<small class="np-small">${source.skipped.hidden} hidden file${source.skipped.hidden === 1 ? ' was' : 's were'} left out.</small>` : ''}
    </div>`;
  const boxes = () => Array.from(body.querySelectorAll('[data-nf-item]'));
  const chosen = () => boxes().filter(b => b.checked && !b.disabled).map(b => items[Number(b.dataset.nfItem)]);
  const createBtn = dlg.querySelector('[data-np-create]');
  const refresh = () => {
    const picked = chosen();
    for (const g of coming) {
      const mine = boxes().filter(b => items[Number(b.dataset.nfItem)].kind === g.kind), on = mine.filter(b => b.checked && !b.disabled);
      body.querySelector(`[data-nf-count="${g.kind}"]`).textContent = on.length + ' of ' + g.count + ' · ' + fmtBytes(on.reduce((n, b) => n + items[Number(b.dataset.nfItem)].size, 0));
      const all = body.querySelector(`[data-nf-kind="${g.kind}"]`);
      all.checked = on.length > 0; all.indeterminate = on.length > 0 && on.length < mine.filter(b => !b.disabled).length;
    }
    for (const box of body.querySelectorAll('[data-nf-group]')) {
      const mine = boxes().filter(b => !b.disabled && items[Number(b.dataset.nfItem)].group === box.dataset.nfGroup), on = mine.filter(b => b.checked);
      box.checked = on.length > 0; box.indeterminate = on.length > 0 && on.length < mine.length;
    }
    createBtn.innerHTML = icon('plus') + (picked.length ? 'CREATE FROM ' + picked.length + ' FILE' + (picked.length === 1 ? '' : 'S') : 'CREATE EMPTY');
  };
  const setAll = (test, on) => { for (const b of boxes()) if (!b.disabled && test(items[Number(b.dataset.nfItem)])) b.checked = on; refresh(); };
  body.querySelectorAll('[data-nf-item]').forEach(b => { b.onchange = refresh; });
  body.querySelectorAll('[data-nf-kind]').forEach(b => { b.onchange = () => setAll(i => i.kind === b.dataset.nfKind, b.checked); b.onclick = e => e.stopPropagation(); });
  body.querySelectorAll('[data-nf-group]').forEach(b => { b.onchange = () => setAll(i => i.group === b.dataset.nfGroup, b.checked); });
  const nameInput = body.querySelector('[data-nf-name]');
  dlg.querySelector('[data-np-title]').innerHTML = icon('folder') + 'NEW PROPERTY FROM A FOLDER';
  createBtn.hidden = false; createBtn.disabled = false;
  createBtn.onclick = () => {
    const value = nameInput.value.trim();
    if (!value) { setStatus('Give the property a name.', 'warn'); nameInput.focus(); return; }
    runFolder(source, value, chosen(), items);
  };
  nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); createBtn.click(); } });
  refresh();
  setStatus('Nothing is made until you press CREATE.', '');
  nameInput.focus(); nameInput.select();
}

function renderFolderRunning(source, prop) {
  const body = dlg.querySelector('.np-body');
  body.innerHTML = `
    <div class="np-run solo">
      <div class="np-left">
        <div class="np-target"><span class="np-kicker">FROM A FOLDER</span><b data-np-name>${escapeHtml(prop.name)}</b>
          <span class="np-link">${escapeHtml(source.path || source.name)}</span></div>
        <ol class="np-log" data-np-log></ol>
        <div class="np-progress" data-np-progress hidden><div class="np-prog-label"></div><div class="np-prog-bar"><div class="np-prog-fill"></div></div></div>
        <div data-np-fallback hidden></div>
        <div data-np-result hidden></div>
      </div>
    </div>`;
  dlg.querySelector('[data-np-create]').hidden = true;
}

// A model and the files it names, as one package the scan importer unpacks.
async function modelFile(source, item) {
  const file = await source.read(item.path);
  if (!item.companions || !item.companions.length) return file;
  const { zipSync } = await import('three/addons/libs/fflate.module.js');
  const dir = dirName(item.path), entries = {};
  const inside = path => dir && path.startsWith(dir + '/') ? path.slice(dir.length + 1) : baseName(path);
  entries[baseName(item.path)] = new Uint8Array(await file.arrayBuffer());
  for (const path of item.companions) entries[inside(path)] = new Uint8Array(await (await source.read(path)).arrayBuffer());
  return new File([zipSync(entries, { level: 0 })], baseName(item.path) + '.zip');
}

function whyNot(e, item) {
  const said = e && e.message ? e.message : '';
  // The photo importer only knows that the browser could not decode the bytes.
  if (item.kind === 'photo' && (!said || /decode/i.test(said))) return /\.(heic|heif)$/i.test(item.path) ? 'this browser cannot read HEIC photos; export it as JPEG' : 'this browser cannot read the picture; the file may be damaged';
  return said || String(e || 'could not be read');
}

async function runFolder(source, name, chosen, items) {
  if (run || !dlg) return;
  const el = dlg, prop = propertyTemplate(name);
  el.querySelectorAll('[data-np-create], [data-nf-name]').forEach(b => { b.disabled = true; });
  // Where the project file goes is settled before the property exists, so its first save
  // already writes to the picked folder.
  let keptAt = null, keepError = null;
  if (source.keepIn) { try { keptAt = await source.keepIn(prop.id, name); } catch (e) { keepError = e; } }
  if (dlg !== el) return;
  ws.data.properties.push(prop);
  ws.data.settings.activePropertyId = prop.id;
  touch();
  app.refresh();
  const relayList = relays();
  run = { abort: new AbortController(), prop };
  dlg.dataset.state = 'running';
  renderFolderRunning(source, prop);
  setStatus('Working. The property already exists; cancelling keeps what is in so far.', '');
  const signal = run.abort.signal;
  // A disk save may replace the property object while a file is being read.
  const live = () => ws.data.properties.find(p => p.id === prop.id) || prop;
  const stop = () => { if (signal.aborted) throw signal.reason || new Error('cancelled'); };
  const failed = [];
  let planScan = null;
  try {
    if (keptAt) log('The project file will be kept in the folder', 'ok', keptAt);
    else if (keepError) log('The project file could not be placed in the folder; it goes to Tiksi\'s projects folder', 'warn', keepError.message || String(keepError));
    for (const item of chosen.filter(i => i.kind === 'link')) {
      stop();
      const link = item.link, p = live();
      if (!p.source) { p.source = { kind: 'polycam', url: link.url, captureId: link.captureId, embedUrl: link.embedUrl, title: '', status: 'pending', addedAt: new Date().toISOString() }; touch(); }
      const src = p.source.captureId === link.captureId ? p.source : { status: 'pending' };
      log('Polycam link in ' + item.path, 'ok', link.url);
      const scan = await fetchLinkScan(link, p, src, false, signal, relayList);
      if (scan) { if (!planScan && scan.kind === 'mesh') planScan = scan; }
      else failed.push({ item, reason: 'Polycam did not give the browser the model. Download it from Polycam into the folder, or use FILE > Import > POLYCAM LINK.' });
    }
    for (const item of chosen.filter(i => i.kind === 'model')) {
      stop();
      const step = log('Reading ' + item.path, 'run', fmtBytes(item.size));
      try {
        const scan = await importScanFile(await modelFile(source, item), live(), { ...hooks, signal });
        if (!scan) throw new Error('not a scan or model Tiksi can read');
        progress(null);
        step.ok(scan.kind + ' kept' + (item.companions && item.companions.length ? ' with ' + item.companions.length + ' companion file' + (item.companions.length === 1 ? '' : 's') : ''));
        if (!planScan && scan.kind === 'mesh') planScan = scan;
      } catch (e) {
        if (signal.aborted) throw e;
        progress(null);
        const reason = whyNot(e, item);
        step.fail(reason); failed.push({ item, reason, shown: true });
      }
    }
    const batch = async (kind, label, add) => {
      const list = chosen.filter(i => i.kind === kind);
      if (!list.length) return;
      const step = log(label, 'run', '0 of ' + list.length + ' in');
      let ok = 0;
      for (let i = 0; i < list.length; i++) {
        stop();
        const item = list[i];
        progress(label + ': ' + baseName(item.path) + ' (' + (i + 1) + ' of ' + list.length + ')', i / list.length);
        try { await add(await source.read(item.path), item); ok++; }
        catch (e) { if (signal.aborted) throw e; console.error(e); failed.push({ item, reason: whyNot(e, item) }); }
        step.detail(ok + ' of ' + list.length + ' in');
      }
      progress(null);
      if (ok === list.length) step.ok(ok + ' of ' + list.length + ' in');
      else step.warn(ok + ' of ' + list.length + ' in; ' + (list.length - ok) + ' could not be read');
    };
    // A property kept in this folder shows the folder's photos where they are (PHOTOS reads the
    // folder): nothing is copied into Tiksi.
    const photosHere = chosen.filter(i => i.kind === 'photo').length;
    if (keptAt && photosHere) log(photosHere + ' photo' + (photosHere === 1 ? ' stays' : 's stay') + ' in the folder and show in PHOTOS', 'ok');
    else await batch('photo', 'Photos', async (file, item) => {
      const rec = await addPhotoFromFile(live(), file);
      // A photo from a subfolder says so, since the gallery is one list.
      if (item.group) { rec.notes = 'From the folder ' + dirName(item.path) + '.'; touch(); }
    });
    await batch('document', 'PDFs', file => addDocumentFromFile(live(), file));
    await batch('video', 'Videos', file => addVideoFromFile(live(), file));
    for (const f of failed) if (!f.shown && f.item.kind !== 'link') log('Not imported: ' + f.item.path, 'fail', f.reason);
    for (const f of failed) if (f.item.kind === 'link') log('The Polycam scan is not in yet', 'warn', f.reason);
    const left = items.filter(i => !chosen.includes(i));
    if (left.length) {
      const kinds = summarize(left).map(g => g.count + ' ' + g.label.toLowerCase()).join(', ');
      log(left.length + ' file' + (left.length === 1 ? ' was' : 's were') + ' left in the folder, unchanged', 'ok', kinds);
    }
    stop();
    if (planScan) await proposePlan(live(), planScan, signal);
    else finish(live(), null, null);
  } catch (e) {
    console.error(e);
    if (signal.aborted) { log('Cancelled', 'warn'); setStatus('Cancelled. The property stays with what was imported so far.', 'warn'); }
    else { log('Failed', 'fail', String(e && e.message || e)); setStatus('Something went wrong; the property was kept with what was imported so far.', 'fail'); }
    dlg.dataset.state = 'failed';
    run = null;
    showCloseOnly();
  }
}

export function dialogOpen() { return !!dlg; }
