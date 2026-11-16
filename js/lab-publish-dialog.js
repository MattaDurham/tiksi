// The SEND TO THE LAB window (FILE > Project): everything the client page will get, to look
// over before it goes. Which projects it offers beside Existing and the short name of each,
// which tags the furniture switch turns off, the page's name in the lab, and the saved views:
// each view with a switch, and under it the renderings of that view (view-renderings.js), each
// with its own switch and the name the client sees. SEND makes the copy (lab-publish.js), has
// the client page's own code take the pictures of the views (lab-pictures.js) and sends it all
// through the Mac.

import { ws, escapeHtml, touch } from './store.js';
import { labSettings, labStatus, sendToLab, renderingLabel, MAX_RENDERINGS, SEND_STEPS } from './lab-publish.js';
import { viewPictures } from './lab-pictures.js';
import { picturesByView, looseRenderings, tagPicture, pictureDay } from './view-renderings.js';
import { loadFolderPhotos, folderOnlyPictures, folderPreviewUrl, keepRecord, photoById } from './photos-store.js';

export async function openLabDialog(prop) {
  if (!prop) return;
  document.querySelector('[data-lab-dialog]')?.close();
  const s = labSettings(prop, ws.data.projects);
  const tags = prop.tags || [];
  const dialog = document.createElement('dialog');
  dialog.className = 'file-dialog lab-dialog'; dialog.dataset.labDialog = '';
  dialog.setAttribute('aria-label', 'Send to the lab');
  dialog.innerHTML = `<header class="file-heading"><div><h2>Send to the lab</h2><p>${escapeHtml(prop.name || 'Property')}</p></div><button class="btn" data-lab-close>CLOSE</button></header>
    <p data-lab-where>Asking the Mac where sends go…</p>
    <label>Page name in the lab <input type="text" data-lab-slug value="${escapeHtml(s.slug)}" spellcheck="false" autocomplete="off"></label>
    <p class="lab-url" data-lab-url></p>
    <h3>Projects</h3>
    ${s.projects.length ? `<p>Each project ticked is offered beside Existing, under its short name.</p>
      <div class="lab-projects">${s.projects.map(p => `<div class="lab-project"><label><input type="checkbox" data-lab-on="${escapeHtml(p.id)}" ${p.on ? 'checked' : ''}> ${escapeHtml(p.name)}</label>
        <input type="text" data-lab-label="${escapeHtml(p.id)}" value="${escapeHtml(p.label)}" maxlength="32" aria-label="Short name for ${escapeHtml(p.name)}"></div>`).join('')}</div>`
      : '<p>No project has pieces of the model yet, so the page shows Existing only. In MODEL, select pieces and choose their project in the PROJECT section.</p>'}
    <h3>Furniture switch</h3>
    <p>The furniture switch hides the pieces on these tags.</p>
    <div class="lab-tags">${tags.filter(t => t.id !== 'tag-scan').map(t => `<label><input type="checkbox" data-lab-tag="${escapeHtml(t.id)}" ${s.furnitureTags.includes(t.id) ? 'checked' : ''}> ${escapeHtml(t.name)}</label>`).join('')}</div>
    <h3>Views and renderings</h3>
    <div data-lab-views><p>Reading the project's pictures…</p></div>
    <p>Left out: products, prices, project scope and notes, every other photo, notes, measurements, documents and the scan capture. Pieces hidden in MODEL stay hidden.</p>
    ${s.sentAt ? `<p>Last sent ${escapeHtml(new Date(s.sentAt).toLocaleString())}. Sending again replaces it at the same link.</p>` : ''}
    <p class="lab-summary" data-lab-summary></p>
    <div class="file-actions"><button class="btn primary" data-lab-send>SEND</button></div>
    <progress data-lab-progress max="1" value="0" hidden></progress>
    <p role="status" data-lab-status></p>
    <ol class="lab-steps" data-lab-steps hidden></ol>
    <div class="file-actions" data-lab-done hidden></div>`;
  document.body.append(dialog);
  dialog.showModal();
  const previews = [];   // object URLs of folder pictures shown here, let go when the window closes
  dialog.addEventListener('close', () => { for (const u of previews) URL.revokeObjectURL(u); dialog.remove(); });
  const q = sel => dialog.querySelector(sel);
  q('[data-lab-close]').onclick = () => dialog.close();
  let status = null;
  const showUrl = () => { const slug = q('[data-lab-slug]').value.trim(); q('[data-lab-url]').textContent = status ? (status.upload ? status.site + slug + '/' : 'Preview on this Mac: ' + location.origin + status.preview + slug + '/') : ''; };
  q('[data-lab-slug]').oninput = showUrl;

  // ---------- the saved views and their renderings ----------
  const viewsOff = new Set(s.views.filter(v => !v.on).map(v => v.id));
  const renderingsOff = new Set(s.renderingsOff);
  const labels = s.renderingLabels;
  // The switches are kept as they are flipped, so a look-over can stop and carry on later.
  const keep = () => ({ viewsOff: [...viewsOff], renderingsOff: [...renderingsOff], renderingLabels: Object.fromEntries(Object.entries(labels).filter(([, v]) => v)) });
  const remember = () => { prop.lab = { ...(prop.lab && typeof prop.lab === 'object' ? prop.lab : {}), ...keep() }; touch(); };
  const projectsOn = () => s.projects.filter(p => dialog.querySelector(`[data-lab-on="${CSS.escape(p.id)}"]`)?.checked);
  let pictures = (prop.photos || []).slice();
  const byView = () => picturesByView(prop, pictures);
  // What goes: the views ticked, and on each the renderings ticked, up to the most a send carries.
  const going = () => {
    const map = byView(), views = (prop.savedViews || []).filter(v => !viewsOff.has(v.id)), renderings = [];
    for (const v of views) for (const { picture: p } of map.get(v.id) || []) {
      if (!renderingsOff.has(p.id) && renderings.length < MAX_RENDERINGS) renderings.push({ id: p.id, viewId: v.id, label: renderingLabel(labels[p.id]), day: pictureDay(p) });
    }
    return { views, renderings, all: [...map.values()].reduce((n, l) => n + l.length, 0) };
  };
  const summary = () => {
    const g = going(), total = (prop.savedViews || []).length, n = projectsOn().length;
    q('[data-lab-summary]').textContent = 'Going to the client: ' + g.views.length + ' of ' + total + ' saved view' + (total === 1 ? '' : 's')
      + ', Existing' + (n ? ' and ' + n + ' project' + (n === 1 ? '' : 's') : '') + ', ' + g.renderings.length + ' of ' + g.all + ' rendering' + (g.all === 1 ? '' : 's') + ' on a view.';
  };
  const thumbOf = p => {
    if (p.thumb) return `<img src="${escapeHtml(p.thumb)}" alt="">`;
    return `<img alt="" data-lab-preview="${escapeHtml(p.file ? p.file.path : '')}">`;
  };
  const viewChoice = (p, viewId) => `<select data-lab-rendering-view="${escapeHtml(p.id)}" aria-label="The saved view ${escapeHtml(p.name || 'this rendering')} shows with">
    <option value="">On no view</option>${(prop.savedViews || []).map(v => `<option value="${escapeHtml(v.id)}" ${v.id === viewId ? 'selected' : ''}>${escapeHtml(v.name)}</option>`).join('')}</select>`;
  const drawViews = () => {
    const host = q('[data-lab-views]'), views = prop.savedViews || [];
    if (!views.length) {
      host.innerHTML = '<p>This property has no saved views: the page opens on the whole model. Save views in MODEL to give the client places to jump to.</p>';
      summary(); return;
    }
    const map = byView(), loose = looseRenderings(prop, pictures);
    const first = views.find(v => !viewsOff.has(v.id));
    const card = (p, by, viewId) => {
      const on = !renderingsOff.has(p.id), isNew = on && s.renderingsSent && !s.renderingsSent.includes(p.id);
      return `<div class="lab-rendering${on ? '' : ' off'}" data-lab-card="${escapeHtml(p.id)}">
        <label class="lab-rendering-pic" title="${escapeHtml(p.name || '')}"><input type="checkbox" data-lab-rendering="${escapeHtml(p.id)}" ${on ? 'checked' : ''} aria-label="Send ${escapeHtml(p.name || 'this rendering')}">${thumbOf(p)}${isNew ? '<b class="lab-new">NEW</b>' : ''}</label>
        <input type="text" data-lab-rendering-label="${escapeHtml(p.id)}" value="${escapeHtml(labels[p.id] || '')}" maxlength="48" placeholder="Rendering" aria-label="The name the client sees for ${escapeHtml(p.name || 'this rendering')}">
        <span class="lab-rendering-note">${escapeHtml(pictureDay(p) || '')}${by === 'name' ? ' · by its file name' : ''}</span>
        ${viewChoice(p, viewId)}</div>`;
    };
    host.innerHTML = `<p>Each saved view ticked shows on the client page as a small picture under the model${first ? '; the page opens at ' + escapeHtml(first.name) : ''}. A click on it opens its iterations (Existing and each project that changes that view) and the renderings ticked under it here: an iteration changes the model, a rendering opens as a picture floating over it. Type the name the client sees under a rendering, or leave it as "Rendering" with its date.</p>
      <div class="file-actions lab-all"><button type="button" class="btn" data-lab-all="1">TICK EVERY VIEW</button><button type="button" class="btn" data-lab-all="0">UNTICK EVERY VIEW</button></div>
      <div class="lab-views">${views.map(v => {
        const list = map.get(v.id) || [], on = !viewsOff.has(v.id);
        return `<section class="lab-view${on ? '' : ' off'}"><label class="lab-view-head"><span><input type="checkbox" data-lab-view="${escapeHtml(v.id)}" ${on ? 'checked' : ''}> ${escapeHtml(v.name)}</span>
          <small>${list.length ? list.length + ' rendering' + (list.length === 1 ? '' : 's') : 'no renderings'}</small></label>
          ${list.length ? `<div class="lab-renderings">${list.map(({ picture, by }) => card(picture, by, v.id)).join('')}</div>` : ''}</section>`;
      }).join('')}</div>
      ${loose.length ? `<details class="lab-loose"><summary>${loose.length} rendering${loose.length === 1 ? '' : 's'} on no saved view: not sent</summary>
        <p>A rendering goes to the client with the saved view it is on. RENDER THIS VIEW in MODEL puts a rendering on its view; a rendering made elsewhere goes on the view its file is named for, or choose its view here.</p>
        <div class="lab-renderings">${loose.slice(0, 60).map(p => `<div class="lab-rendering" data-lab-card="${escapeHtml(p.id)}"><span class="lab-rendering-pic" title="${escapeHtml(p.name || '')}">${thumbOf(p)}</span>
          <span class="lab-rendering-note">${escapeHtml(p.name || '')}</span>${viewChoice(p, '')}</div>`).join('')}</div></details>` : ''}`;
    // Folder pictures with no thumbnail of their own get the Mac's small copy.
    for (const img of host.querySelectorAll('img[data-lab-preview]')) {
      const path = img.dataset.labPreview;
      if (path) folderPreviewUrl(prop, path, 256).then(u => { previews.push(u); if (img.isConnected) img.src = u; }).catch(() => {});
    }
    summary();
  };
  q('[data-lab-views]').addEventListener('change', e => {
    const t = e.target;
    if (t.dataset.labView) { if (t.checked) viewsOff.delete(t.dataset.labView); else viewsOff.add(t.dataset.labView); remember(); drawViews(); }
    else if (t.dataset.labRendering) { if (t.checked) renderingsOff.delete(t.dataset.labRendering); else renderingsOff.add(t.dataset.labRendering); remember(); drawViews(); }
    else if (t.dataset.labRenderingLabel) { labels[t.dataset.labRenderingLabel] = renderingLabel(t.value); t.value = labels[t.dataset.labRenderingLabel]; remember(); }
    else if (t.dataset.labRenderingView !== undefined) {
      // Choosing a view for a rendering is kept on the picture itself, as in PHOTOS.
      const id = t.dataset.labRenderingView, item = pictures.find(p => p.id === id);
      if (!item) return;
      const rec = photoById(prop, id) || keepRecord(prop, item);
      tagPicture(rec, t.value);
      touch();
      pictures = pictures.map(p => p.id === id ? rec : p);
      drawViews();
    }
  });
  q('[data-lab-views]').addEventListener('click', e => {
    const b = e.target.closest('[data-lab-all]');
    if (!b) return;
    viewsOff.clear();
    if (b.dataset.labAll === '0') for (const v of prop.savedViews || []) viewsOff.add(v.id);
    remember(); drawViews();
  });
  dialog.addEventListener('change', e => { if (e.target.dataset.labOn) summary(); });
  drawViews();

  try {
    status = await labStatus();
    q('[data-lab-where]').textContent = status.upload ? 'Sends go online to the lab on thedurham.nyc, and to a preview copy on this Mac.' : status.reason;
  } catch (e) { q('[data-lab-where]').textContent = e.message; q('[data-lab-send]').disabled = true; }
  showUrl();
  // The renderings in the project's folder that Tiksi has no record of yet are listed too.
  loadFolderPhotos(prop).then(() => {
    if (!dialog.isConnected) return;
    const have = new Set((prop.photos || []).map(p => p.id));
    pictures = (prop.photos || []).concat(folderOnlyPictures(prop).filter(p => !have.has(p.id)));
    drawViews();
  }).catch(e => console.warn('The project folder\'s pictures could not be listed:', e));

  // ---------- the send, a part at a time ----------
  // Each part of SEND_STEPS is a row: waiting, under way (with its count, a small bar and how long
  // it has taken so far), done, or nothing to do. The rendering being sent shows beside its row,
  // and the client page taking the views' pictures shows in theirs.
  const clock = ms => { const t = Math.max(0, Math.round(ms / 1000)); return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'); };
  let rows = new Map(), ticker = 0;
  const startSteps = () => {
    const list = q('[data-lab-steps]');
    for (const r of rows.values()) if (r.url) URL.revokeObjectURL(r.url);
    list.innerHTML = SEND_STEPS.map(x => `<li class="lab-step waiting" data-lab-step="${x.id}"><span class="lab-step-mark" aria-hidden="true"></span>
      <div class="lab-step-body"><div class="lab-step-head"><b>${escapeHtml(x.name)}</b><time></time></div><span class="lab-step-text">Waiting</span>
      <progress max="1" value="0" hidden></progress><div class="lab-step-extra"></div></div><img class="lab-step-picture" alt="" hidden></li>`).join('');
    list.hidden = false;
    rows = new Map(SEND_STEPS.map(x => [x.id, { li: list.querySelector(`[data-lab-step="${x.id}"]`), state: 'waiting', started: 0, ended: 0, url: '' }]));
    clearInterval(ticker);
    ticker = setInterval(() => { for (const r of rows.values()) if (r.state === 'running') r.li.querySelector('time').textContent = clock(performance.now() - r.started); }, 500);
  };
  const showStep = st => {
    const r = st && rows.get(st.id);
    if (!r) return;
    const now = performance.now();
    if (st.state === 'running' && r.state !== 'running') r.started = now;
    if (st.state !== 'running' && r.state === 'running') r.ended = now;
    r.state = st.state;
    r.li.className = 'lab-step ' + st.state;
    if (st.text) r.li.querySelector('.lab-step-text').textContent = st.text;
    r.li.querySelector('time').textContent = r.started ? clock((st.state === 'running' ? now : r.ended || now) - r.started) : '';
    const bar = r.li.querySelector('progress');
    const f = typeof st.fraction === 'number' ? st.fraction : st.total ? st.done / st.total : null;
    bar.hidden = st.state !== 'running' || f === null;
    if (f !== null) bar.value = Math.min(1, Math.max(0, f));
    const img = r.li.querySelector('.lab-step-picture');
    if (st.picture) { if (r.url) URL.revokeObjectURL(r.url); r.url = URL.createObjectURL(st.picture); img.src = r.url; img.hidden = false; }
    if (st.state !== 'running') img.hidden = true;
    if (st.state === 'running') {
      // Every part before this one is over by now.
      for (const [id, o] of rows) { if (id === st.id) break; if (o.state === 'waiting') showStep({ id, state: 'none', text: 'Nothing to do' }); }
    }
  };
  const failSteps = () => { for (const [id, r] of rows) if (r.state === 'running') showStep({ id, state: 'failed', text: 'Stopped here' }); clearInterval(ticker); };
  dialog.addEventListener('close', () => { clearInterval(ticker); for (const r of rows.values()) if (r.url) URL.revokeObjectURL(r.url); });

  q('[data-lab-send]').onclick = async () => {
    const btn = q('[data-lab-send]'), bar = q('[data-lab-progress]'), out = q('[data-lab-status]'), done = q('[data-lab-done]');
    const g = going();
    const choice = {
      slug: q('[data-lab-slug]').value.trim(),
      projects: projectsOn().map(p => ({ id: p.id, label: dialog.querySelector(`[data-lab-label="${CSS.escape(p.id)}"]`).value.trim() || p.label })),
      furnitureTags: [...dialog.querySelectorAll('[data-lab-tag]')].filter(i => i.checked).map(i => i.dataset.labTag),
      views: g.views.map(v => v.id), renderings: g.renderings, keep: keep(),
    };
    btn.disabled = true; bar.hidden = false; done.hidden = true; out.textContent = '';
    startSteps();
    try {
      const r = await sendToLab(prop.id, choice, {
        progress: (text, f, st) => { if (text) out.textContent = text; bar.value = f; showStep(st); },
        pictures: opts => viewPictures({ ...opts, host: rows.get('pictures').li.querySelector('.lab-step-extra') }),
      });
      clearInterval(ticker);
      out.textContent = (r.uploaded ? 'Sent. The lab page shows this copy now.' : 'Sent to this Mac\'s preview copy. It is not online: this Mac has no upload key for the lab.')
        + ' It has ' + r.views + ' saved view' + (r.views === 1 ? '' : 's') + ' and ' + r.renderings + ' rendering' + (r.renderings === 1 ? '' : 's') + '.' + (r.notes.length ? ' ' + r.notes.join(' ') : '');
      done.innerHTML = `<a class="btn primary" href="${escapeHtml(r.preview)}" target="_blank" rel="noopener">OPEN THE PREVIEW</a>${r.uploaded ? `<a class="btn" href="${escapeHtml(r.url)}" target="_blank" rel="noopener">OPEN THE LAB PAGE</a>` : ''}`;
      done.hidden = false;
      s.renderingsSent = (prop.lab && prop.lab.renderingsSent) || [];
      drawViews();
    } catch (e) {
      failSteps();
      out.textContent = e.message + ' The page in the lab still shows what was sent before.';
    } finally { btn.disabled = false; }
  };
}
