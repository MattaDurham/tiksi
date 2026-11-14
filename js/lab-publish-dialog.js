// The SEND TO THE LAB window (FILE > Project): which projects the client page offers beside
// Existing and the short name of each, which tags the furniture switch turns off, and the page's name
// in the lab. SEND makes the copy (lab-publish.js) and sends it through the Mac.

import { ws, escapeHtml } from './store.js';
import { labSettings, labStatus, sendToLab } from './lab-publish.js';

export async function openLabDialog(prop) {
  if (!prop) return;
  document.querySelector('[data-lab-dialog]')?.close();
  const s = labSettings(prop, ws.data.projects);
  const tags = prop.tags || [];
  const views = prop.savedViews || [];
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
    <h3>Views</h3>
    <p>${views.length ? `The client gets the ${views.length} saved view${views.length === 1 ? '' : 's'}, by name, as in MODEL. The page opens at the first, ${escapeHtml(views[0].name)}.` : 'This property has no saved views: the page opens on the whole model. Save views in MODEL to give the client places to jump to.'}</p>
    <p>Left out: products, prices, project scope and notes, photos, notes, measurements, documents and the scan capture. Pieces hidden in MODEL stay hidden.</p>
    ${s.sentAt ? `<p>Last sent ${escapeHtml(new Date(s.sentAt).toLocaleString())}. Sending again replaces it at the same link.</p>` : ''}
    <div class="file-actions"><button class="btn primary" data-lab-send>SEND</button></div>
    <progress data-lab-progress max="1" value="0" hidden></progress>
    <p role="status" data-lab-status></p>
    <div class="file-actions" data-lab-done hidden></div>`;
  document.body.append(dialog);
  dialog.showModal();
  dialog.addEventListener('close', () => dialog.remove());
  const q = sel => dialog.querySelector(sel);
  q('[data-lab-close]').onclick = () => dialog.close();
  let status = null;
  const showUrl = () => { const slug = q('[data-lab-slug]').value.trim(); q('[data-lab-url]').textContent = status ? (status.upload ? status.site + slug + '/' : 'Preview on this Mac: ' + location.origin + status.preview + slug + '/') : ''; };
  q('[data-lab-slug]').oninput = showUrl;
  try {
    status = await labStatus();
    q('[data-lab-where]').textContent = status.upload ? 'Sends go online to the lab on thedurham.nyc, and to a preview copy on this Mac.' : status.reason;
  } catch (e) { q('[data-lab-where]').textContent = e.message; q('[data-lab-send]').disabled = true; }
  showUrl();
  q('[data-lab-send]').onclick = async () => {
    const btn = q('[data-lab-send]'), bar = q('[data-lab-progress]'), out = q('[data-lab-status]'), done = q('[data-lab-done]');
    const choice = {
      slug: q('[data-lab-slug]').value.trim(),
      projects: s.projects.filter(p => dialog.querySelector(`[data-lab-on="${CSS.escape(p.id)}"]`)?.checked).map(p => ({ id: p.id, label: dialog.querySelector(`[data-lab-label="${CSS.escape(p.id)}"]`).value.trim() || p.label })),
      furnitureTags: [...dialog.querySelectorAll('[data-lab-tag]')].filter(i => i.checked).map(i => i.dataset.labTag),
    };
    btn.disabled = true; bar.hidden = false; done.hidden = true; out.textContent = '';
    try {
      const r = await sendToLab(prop.id, choice, { progress: (text, f) => { out.textContent = text; bar.value = f; } });
      out.textContent = r.uploaded ? 'Sent. The lab page shows this copy now.' : 'Sent to this Mac\'s preview copy. It is not online: this Mac has no upload key for the lab.';
      done.innerHTML = `<a class="btn primary" href="${escapeHtml(r.preview)}" target="_blank" rel="noopener">OPEN THE PREVIEW</a>${r.uploaded ? `<a class="btn" href="${escapeHtml(r.url)}" target="_blank" rel="noopener">OPEN THE LAB PAGE</a>` : ''}`;
      done.hidden = false;
    } catch (e) {
      out.textContent = e.message + ' The page in the lab still shows what was sent before.';
    } finally { btn.disabled = false; }
  };
}
