// The one-pager's editor and the prompt when Tiksi closes.
//
// EDITOR (FILE > Project > ONE-PAGER, DOCUMENTS): the text on the left, the page on the right,
// SAVE VERSION at the bottom. Edits land on the property as they are typed; a saved version is a
// PDF among the property's documents, and the page notes which project it was made of.
//
// CLOSING: the browser asks "Leave site?" when a page wants a word before it closes; that is
// the only hook a web app has. Tiksi asks only when the one-pager is behind the project (or
// has no version yet; FILE > Settings changes that). Choosing to stay brings up Tiksi's own
// question, UPDATE THE ONE-PAGER?, which saves the next version right there; choosing to
// leave closes without it. NOT NOW keeps quiet until the project changes again.

import { ws, touch, activeProperty, projectSlice, onWorkspaceReplace, escapeHtml as esc, fmtDate, isoToday } from './store.js';
import { icon } from './icons.js';
import { normalizeOnePager, draftOnePager, latestVersion, onePagerStatus, shouldAskOnClose, projectSignature, DEFAULT_PROMPT, SHOW_KEYS, MAX_HIGHLIGHTS } from './one-pager.js';
import { PAGE_CSS, PAGE_W, PAGE_H, pageCuts } from './one-pager-page.js';
import { pageAssets, pageMarkup, onePagerPdf, saveOnePagerVersion, versionInProgress, heroCandidates, latestVersionBytes } from './one-pager-render.js';

let app = { refresh() {}, remount() {}, toast() {} };
let editor = null;    // the open editor dialog
let prompt = null;    // the open closing prompt
let snoozed = '';     // "<property id>:<signature>" NOT NOW was chosen for
let stayTimer = 0, unloading = false;

const SHOW_LABELS = { budget: 'Budget range', schedule: 'Schedule', rooms: 'Rooms and area', plan: 'Floor plan', products: 'Specified products' };

export function initOnePager(hooks) {
  app = Object.assign(app, hooks || {});
  window.addEventListener('pagehide', () => { unloading = true; clearTimeout(stayTimer); });
  window.addEventListener('beforeunload', e => {
    const prop = activeProperty();
    if (!prop || prompt || versionInProgress() || !wantsPrompt(prop)) return;
    e.preventDefault();
    e.returnValue = '';
    // The browser's own question comes first. If the page is still here a moment later, the
    // person chose to stay: ask Tiksi's question now.
    clearTimeout(stayTimer);
    stayTimer = setTimeout(() => { if (!unloading && !prompt) openClosePrompt(prop); }, 150);
  });
}

export function promptMode() {
  const m = ws.data && ws.data.settings && ws.data.settings.onePagerPrompt;
  return m === 'always' || m === 'never' || m === 'changed' ? m : DEFAULT_PROMPT;
}
function wantsPrompt(prop) {
  const slice = projectSlice(prop.id);
  if (!shouldAskOnClose(prop, slice, promptMode())) return false;
  return snoozed !== prop.id + ':' + projectSignature(slice);
}
// For tests and the FILE panel: would closing now ask?
export function closeWouldAsk(prop = activeProperty()) { return !!prop && wantsPrompt(prop); }

export function onePagerStatusText(prop) {
  if (!prop) return '';
  return onePagerStatus(prop, projectSlice(prop.id)).text;
}

// ---------- onboarding ----------

// A new property's first draft: the text from what is known, then version 1 as a PDF. Returns
// the version, or null when the property already has one.
export async function makeFirstOnePager(prop, { progress } = {}) {
  normalizeOnePager(prop);
  if (draftOnePager(prop, ws.data, { force: !prop.onePager.customized })) touch();
  if (latestVersion(prop)) return null;
  // A property always gets its first version, but not a clipped one in silence.
  const assets = await pageAssets(prop);
  const cuts = await cutsOffScreen(prop, assets, 'Version 1');
  const r = await saveOnePagerVersion(prop, { progress, assets });
  if (cuts.length) {
    const text = 'One-pager version 1 for ' + (prop.name || 'this property') + ' is cut off: ' + cuts.join('; ') + '. OPEN ONE-PAGER to shorten it and save version 2.';
    progress && progress(text);
    app.toast && app.toast(text, 'error');
  }
  return r.version;
}

// What the page would cut off, laid out out of sight exactly as the editor's preview lays it
// out, for saves made without the editor open.
export async function cutsOffScreen(prop, assets, version) {
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = 'position:fixed;left:-20000px;top:0;width:' + PAGE_W + 'px;height:' + PAGE_H + 'px;overflow:hidden;visibility:hidden;pointer-events:none';
  host.innerHTML = '<style>' + PAGE_CSS + '</style><div class="op-preview-page">' + pageMarkup(prop, assets, { version, date: isoToday() }) + '</div>';
  document.body.appendChild(host);
  try {
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    await Promise.all([...host.querySelectorAll('img')].map(i => i.decode().catch(() => {})));
    return pageCuts(host.querySelector('.op-page'));
  } finally { host.remove(); }
}

// ---------- the editor ----------

function fieldHtml(o) {
  return `
    <div class="field"><label>Headline</label><input type="text" data-f="headline" maxlength="90" value="${esc(o.headline)}" placeholder="${esc(activeProperty()?.name || 'The property')}"></div>
    <div class="field"><label>Tagline</label><input type="text" data-f="tagline" maxlength="140" value="${esc(o.tagline)}" placeholder="Renovation proposal"></div>
    <div class="field"><label>Summary</label><textarea data-f="summary" rows="7" maxlength="1100" placeholder="What the project is, what the work covers, what it costs and when it happens.">${esc(o.summary)}</textarea></div>
    <div class="field"><label>Highlights <span class="faint">one per line, up to ${MAX_HIGHLIGHTS}</span></label><textarea data-f="highlights" rows="4" placeholder="Kitchen refresh: $42,000 likely">${esc(o.highlights.join('\n'))}</textarea></div>
    <div class="field-row">
      <div class="field"><label>Prepared for</label><input type="text" data-f="client" maxlength="80" value="${esc(o.client)}" placeholder="The client"></div>
      <div class="field"><label>Prepared by</label><input type="text" data-f="preparedBy" maxlength="80" value="${esc(o.preparedBy)}" placeholder="You, or your studio"></div>
    </div>
    <div class="field"><label>Contact line</label><input type="text" data-f="contact" maxlength="120" value="${esc(o.contact)}" placeholder="email · phone"></div>`;
}

function heroOptions(prop, o) {
  const cands = heroCandidates(prop);
  const auto = cands[0];
  const opts = [`<option value="">Automatic${auto ? ': ' + esc(auto.label) : ''}</option>`];
  const seen = new Set();
  for (const c of cands) { if (seen.has(c.id)) continue; seen.add(c.id); opts.push(`<option value="${esc(c.id)}" ${o.hero === c.id ? 'selected' : ''}>${esc(c.kind === 'rendering' ? 'Rendering: ' + c.label : c.kind === 'photo' ? 'Photo: ' + c.label : c.label)}</option>`); }
  if (o.hero && !seen.has(o.hero)) opts.push(`<option value="${esc(o.hero)}" selected>A picture that is no longer here</option>`);
  return opts.join('');
}

function versionsHtml(prop) {
  const list = (prop.onePager.versions || []).slice().reverse();
  if (!list.length) return '<p class="np-small">No version saved yet. SAVE VERSION 1 makes the first PDF.</p>';
  return `<p class="np-small">Saved versions, newest first. Each is a PDF in this property's documents.</p><div class="op-versions">${list.map(v => `<button type="button" class="link-btn" data-op-version="${v.n}" title="Download version ${v.n}">v${v.n} · ${esc(v.date ? fmtDate(v.date) : 'undated')}</button>`).join('')}</div>`;
}

export function editorOpen() { return !!editor; }

export function openOnePagerEditor(prop = activeProperty(), opts = {}) {
  if (!prop) { alert('Create or open a property first.'); return null; }
  closeEditor();
  let o = normalizeOnePager(prop);
  if (draftOnePager(prop, ws.data)) touch();
  const dlg = document.createElement('dialog');
  dlg.className = 'op-dialog';
  dlg.setAttribute('aria-label', 'One-pager of ' + prop.name);
  dlg.innerHTML = `
    <header class="op-dlg-head">
      <h2>${icon('file')}ONE-PAGER <span class="op-dlg-name">${esc(prop.name)}</span></h2>
      <span class="op-dlg-status" data-op-status></span>
      <button type="button" class="btn ghost icon-btn" data-op-close title="Close (Esc)">${icon('close')}</button>
    </header>
    <div class="op-dlg-body">
      <form class="op-form" data-op-form onsubmit="return false">
        ${fieldHtml(o)}
        <div class="field"><label>Picture at the top</label><select data-op-hero>${heroOptions(prop, o)}</select></div>
        <div class="field"><label>On the page</label><div class="op-show">${SHOW_KEYS.map(k => `<label class="tool-check"><span>${esc(SHOW_LABELS[k])}</span><input type="checkbox" data-show="${k}" ${o.show[k] ? 'checked' : ''}></label>`).join('')}</div></div>
        <div class="op-draft-row">
          <button type="button" class="btn small" data-op-redraft title="Write the headline, tagline, summary and highlights again from the project as it is now">${icon('refresh', { size: 11 })}REDRAFT FROM THE PROJECT</button>
          <small class="np-small" data-op-draft-note></small>
        </div>
        <div data-op-versions>${versionsHtml(prop)}</div>
      </form>
      <div class="op-preview-wrap"><p class="np-status fail" data-op-cuts role="alert" hidden></p><div class="op-preview" data-op-preview><style>${PAGE_CSS}</style><div class="op-preview-page" data-op-page></div></div></div>
    </div>
    <footer class="op-dlg-foot">
      <span class="np-status" data-op-note role="status"></span>
      <span style="flex:1"></span>
      <button type="button" class="btn" data-op-download title="Download the page as it looks now, as a PDF">${icon('export')}DOWNLOAD PDF</button>
      <button type="button" class="btn" data-op-send hidden title="Send the newest saved version">${icon('external')}SEND…</button>
      <button type="button" class="btn primary" data-op-save></button>
    </footer>`;
  document.body.appendChild(dlg);
  editor = dlg;
  dlg.addEventListener('close', () => { if (editor === dlg) editor = null; dlg.remove(); });
  dlg.querySelector('[data-op-close]').onclick = () => dlg.close();
  dlg.addEventListener('cancel', e => { if (busy) e.preventDefault(); });
  const note = dlg.querySelector('[data-op-note]');
  const say = (t, kind) => { note.textContent = t || ''; note.className = 'np-status ' + (kind || ''); };
  const form = dlg.querySelector('[data-op-form]');
  const page = dlg.querySelector('[data-op-page]');
  let assets = null, assetsKey = null, assetsJob = null, previewTimer = 0, busy = false;

  const refreshStatus = () => {
    const st = onePagerStatus(prop, projectSlice(prop.id));
    dlg.querySelector('[data-op-status]').textContent = st.text;
    dlg.querySelector('[data-op-status]').dataset.state = st.state;
    const n = (latestVersion(prop)?.n || 0) + 1;
    dlg.querySelector('[data-op-save]').innerHTML = icon('save') + 'SAVE VERSION ' + n;
    dlg.querySelector('[data-op-draft-note]').textContent = o.customized ? 'The text was edited by hand, so it stays as it is until you redraft it.' : 'The text follows the project until you edit it.';
    dlg.querySelector('[data-op-versions]').innerHTML = versionsHtml(prop);
    bindVersions();
    const send = dlg.querySelector('[data-op-send]');
    send.hidden = !(latestVersion(prop) && navigator.canShare && navigator.canShare({ files: [new File([''], 'x.pdf', { type: 'application/pdf' })] }));
  };
  const loadAssets = async () => {
    const key = o.hero + '|' + (prop.photos || []).length + '|' + (prop.walls || []).length + '|' + (prop.rooms || []).length;
    if (assets && assetsKey === key) return assets;
    if (assetsJob && assetsKey === key) return assetsJob;
    assetsKey = key;
    assetsJob = pageAssets(prop).then(a => { if (assetsKey === key) { assets = a; assetsJob = null; } return a; });
    return assetsJob;
  };
  const drawPreview = async () => {
    try {
      const a = await loadAssets();
      if (!editor) return;
      page.innerHTML = pageMarkup(prop, a, { version: 'Version ' + ((latestVersion(prop)?.n || 0) + 1) + ' (draft)', date: isoToday() });
      fitPreview();
      showCuts();
    } catch (e) { console.error(e); say('The page could not be drawn: ' + (e.message || e), 'fail'); }
  };
  const fitPreview = () => {
    const wrap = dlg.querySelector('[data-op-preview]');
    const k = Math.min(1, (wrap.clientWidth - 2) / PAGE_W);
    page.style.transform = 'scale(' + k + ')';
    wrap.style.height = Math.round(PAGE_H * k) + 'px';
  };
  // Text the page has no room for is clipped on the PDF too: say so before it is saved.
  const showCuts = () => {
    const cuts = pageCuts(page.querySelector('.op-page')), box = dlg.querySelector('[data-op-cuts]');
    box.hidden = !cuts.length;
    box.textContent = cuts.length ? 'Cut off on the page: ' + cuts.join('; ') + '. Shorten the text or turn parts off before you save.' : '';
  };
  const schedulePreview = () => { clearTimeout(previewTimer); previewTimer = setTimeout(drawPreview, 250); };
  const readField = (el) => {
    const k = el.dataset.f, v = el.value;
    if (k === 'highlights') o.highlights = v.split('\n').map(s => s.trim()).filter(Boolean).slice(0, MAX_HIGHLIGHTS);
    else o[k] = k === 'summary' ? v.trim().slice(0, 1100) : v.trim();
    if (['headline', 'tagline', 'summary', 'highlights'].includes(k)) o.customized = true;
  };
  form.querySelectorAll('[data-f]').forEach(el => {
    // Typing is an edit from the first key: marked as one, it is kept beside a save from
    // another device instead of being overwritten by it.
    el.addEventListener('input', () => { readField(el); touch(); schedulePreview(); });
    el.addEventListener('change', () => { readField(el); touch(); refreshStatus(); });
  });
  dlg.querySelector('[data-op-hero]').onchange = e => { o.hero = e.target.value; touch(); schedulePreview(); };
  form.querySelectorAll('[data-show]').forEach(c => c.onchange = () => { o.show[c.dataset.show] = c.checked; touch(); schedulePreview(); });
  dlg.querySelector('[data-op-redraft]').onclick = () => {
    if (o.customized && !confirm('Replace the headline, tagline, summary and highlights with text drafted from the project as it is now?')) return;
    draftOnePager(prop, ws.data, { force: true });
    touch();
    for (const el of form.querySelectorAll('[data-f]')) if (el !== document.activeElement) el.value = el.dataset.f === 'highlights' ? o.highlights.join('\n') : o[el.dataset.f];
    refreshStatus(); schedulePreview();
    say('Text drafted from the project.', 'ok');
  };
  const run = async (fn) => {
    if (busy) return;
    busy = true;
    dlg.querySelectorAll('button').forEach(b => b.disabled = true);
    try { await fn(); }
    catch (e) { console.error(e); say((e && e.message) || String(e), 'fail'); }
    finally { busy = false; if (editor === dlg) dlg.querySelectorAll('button').forEach(b => b.disabled = false); }
  };
  dlg.querySelector('[data-op-save]').onclick = () => run(async () => {
    const r = await saveOnePagerVersion(prop, { progress: t => say(t, ''), assets: await loadAssets() });
    say('Version ' + r.version.n + ' saved: ' + r.doc.name + ' is in this property\'s documents.', 'ok');
    refreshStatus(); app.refresh();
    if (opts.onSaved) opts.onSaved(r);
  });
  dlg.querySelector('[data-op-download]').onclick = () => run(async () => {
    say('Laying out the page…', '');
    const bytes = await onePagerPdf(prop, { version: 'Draft', date: isoToday(), assets: await loadAssets() });
    download(new Blob([bytes], { type: 'application/pdf' }), (prop.name || 'Property') + ' - one-pager draft - ' + isoToday() + '.pdf');
    say('PDF downloaded.', 'ok');
  });
  dlg.querySelector('[data-op-send]').onclick = () => run(async () => {
    const v = latestVersion(prop), bytes = await latestVersionBytes(prop);
    if (!bytes) throw new Error('The newest version\'s file is not on this computer.');
    const file = new File([bytes], (prop.photos || []).find(p => p.id === v.documentId)?.name || 'one-pager.pdf', { type: 'application/pdf' });
    await navigator.share({ files: [file], title: prop.name + ' one-pager' });
    say('Sent version ' + v.n + '.', 'ok');
  });
  function bindVersions() {
    dlg.querySelectorAll('[data-op-version]').forEach(b => b.onclick = () => run(async () => {
      const v = prop.onePager.versions.find(x => x.n === +b.dataset.opVersion);
      const rec = v && (prop.photos || []).find(p => p.id === v.documentId);
      const { photoBytes } = await import('./photos-store.js');
      const buf = rec && await photoBytes(rec.id);
      if (!buf) throw new Error('The file of version ' + b.dataset.opVersion + ' is not on this computer.');
      download(new Blob([buf], { type: 'application/pdf' }), rec.name);
    }));
  }
  const onResize = () => { if (editor === dlg) fitPreview(); };
  window.addEventListener('resize', onResize);
  // The Mac's project files can replace the open records (another device saved): follow the
  // property's new record, or close when the property is gone.
  const offReplace = onWorkspaceReplace((before, after) => {
    const fresh = (after.properties || []).find(x => x.id === prop.id);
    if (!fresh) { dlg.close(); return; }
    prop = fresh; o = normalizeOnePager(prop); assets = null; assetsKey = null;
    for (const el of form.querySelectorAll('[data-f]')) if (el !== document.activeElement) el.value = el.dataset.f === 'highlights' ? o.highlights.join('\n') : o[el.dataset.f];
    dlg.querySelector('[data-op-hero]').innerHTML = heroOptions(prop, o);
    form.querySelectorAll('[data-show]').forEach(c => { c.checked = !!o.show[c.dataset.show]; });
    refreshStatus(); schedulePreview();
  });
  dlg.addEventListener('close', () => { window.removeEventListener('resize', onResize); offReplace(); });
  dlg.showModal();
  refreshStatus();
  drawPreview();
  return dlg;
}

function closeEditor() { if (editor) { const d = editor; editor = null; d.close(); } }

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// ---------- the question when Tiksi closes ----------

export function promptOpen() { return !!prompt; }

export function openClosePrompt(prop = activeProperty()) {
  if (!prop || prompt) return null;
  normalizeOnePager(prop);
  const st = onePagerStatus(prop, projectSlice(prop.id));
  const next = (latestVersion(prop)?.n || 0) + 1;
  const dlg = document.createElement('dialog');
  dlg.className = 'op-dialog op-prompt';
  dlg.setAttribute('aria-label', 'Update the one-pager?');
  const text = st.state === 'none'
    ? esc(prop.name) + ' has no one-pager yet. Make version 1 now, so there is always one to send?'
    : st.state === 'behind'
      ? esc(prop.name) + ': ' + esc(st.text.replace(/\.$/, '')) + '. Save version ' + next + ' before you close?'
      : esc(prop.name) + ': ' + esc(st.text.replace(/\.$/, '')) + '. Save it again as version ' + next + '?';
  dlg.innerHTML = `
    <header class="op-dlg-head"><h2>${icon('file')}UPDATE THE ONE-PAGER?</h2></header>
    <div class="op-prompt-body">
      <p data-op-prompt-text>${text}</p>
      <p class="np-small">The newest version is the one to send. Closing Tiksi without it keeps the last one.</p>
      <p class="np-status" data-op-prompt-note role="status"></p>
    </div>
    <footer class="op-dlg-foot">
      <button type="button" class="btn" data-op-later>NOT NOW</button>
      <span style="flex:1"></span>
      <button type="button" class="btn" data-op-review>${icon('edit')}REVIEW FIRST</button>
      <button type="button" class="btn primary" data-op-update>${icon('save')}UPDATE NOW</button>
    </footer>`;
  document.body.appendChild(dlg);
  prompt = dlg;
  const offReplace = onWorkspaceReplace((before, after) => { const fresh = (after.properties || []).find(x => x.id === prop.id); if (fresh) prop = fresh; else dlg.close(); });
  dlg.addEventListener('close', () => { if (prompt === dlg) prompt = null; offReplace(); dlg.remove(); });
  const note = dlg.querySelector('[data-op-prompt-note]');
  const say = (t, kind) => { note.textContent = t || ''; note.className = 'np-status ' + (kind || ''); };
  let busy = false;
  dlg.addEventListener('cancel', e => { if (busy) e.preventDefault(); else snooze(prop); });
  dlg.querySelector('[data-op-later]').onclick = () => { snooze(prop); dlg.close(); };
  dlg.querySelector('[data-op-review]').onclick = () => { dlg.close(); openOnePagerEditor(prop); };
  let warned = '';   // the cut-off text already shown: a second UPDATE NOW saves as it is
  dlg.querySelector('[data-op-update]').onclick = async () => {
    if (busy) return;
    busy = true;
    dlg.querySelectorAll('button').forEach(b => b.disabled = true);
    try {
      // The text the save will print: drafted afresh unless it was written by hand.
      if (draftOnePager(prop, ws.data)) touch();
      const assets = await pageAssets(prop);
      const cuts = await cutsOffScreen(prop, assets, 'Version ' + next);
      const cutText = cuts.length ? 'Cut off on the page: ' + cuts.join('; ') + '.' : '';
      if (cutText && cutText !== warned) {
        warned = cutText;
        say(cutText + ' REVIEW FIRST to shorten it, or UPDATE NOW again to save it as it is.', 'fail');
        note.setAttribute('role', 'alert');
        dlg.querySelectorAll('button').forEach(b => b.disabled = false);
        return;
      }
      const r = await saveOnePagerVersion(prop, { progress: t => say(t, ''), assets });
      dlg.querySelector('[data-op-prompt-text]').textContent = 'Version ' + r.version.n + ' saved: ' + r.doc.name + '. Close Tiksi when you are ready.';
      say('', '');
      app.refresh();
      dlg.querySelector('.op-dlg-foot').innerHTML = '<span style="flex:1"></span><button type="button" class="btn primary" data-op-done>DONE</button>';
      dlg.querySelector('[data-op-done]').onclick = () => dlg.close();
      dlg.querySelector('[data-op-done]').focus();
    } catch (e) {
      console.error(e);
      say('The version could not be saved: ' + ((e && e.message) || e), 'fail');
      dlg.querySelectorAll('button').forEach(b => b.disabled = false);
    } finally { busy = false; }
  };
  dlg.showModal();
  dlg.querySelector('[data-op-update]').focus();
  return dlg;
}

function snooze(prop) { snoozed = prop.id + ':' + projectSignature(projectSlice(prop.id)); }
