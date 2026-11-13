import { ws, activeProperty, touch, uid, escapeHtml } from './store.js';

export function keepRemoved(prop, kind, records, parentId = null) {
  if (!prop || !records.length) return;
  prop.removedRecords ||= [];
  const ids=new Set(records.map(r=>r.id));
  const dependentIds=kind==='item'?(ws.data.projects.find(p=>p.id===parentId)?.items || []).filter(r=>(r.deps || []).some(id=>ids.has(id))).map(r=>r.id):[];
  prop.removedRecords.push({ id: uid('removed'), kind, parentId, dependentIds, at: new Date().toISOString(), records: structuredClone(records) });
}
export function restoreRemoved(prop, id) {
  const entry = prop.removedRecords?.find(r => r.id === id);
  if (!entry) throw new Error('Recovery record no longer exists.');
  const target = entry.kind === 'item' ? ws.data.projects.find(p => p.id === entry.parentId)?.items : ws.data[entry.kind];
  if (!target) throw new Error('Restore the parent scope first.');
  if (entry.records.some(r => target.some(x => x.id === r.id))) throw new Error('A record with this ID already exists; the current version was preserved.');
  target.push(...structuredClone(entry.records));
  for(const id of entry.dependentIds || []){const dependent=target.find(r=>r.id===id);if(dependent)dependent.deps=[...new Set([...(dependent.deps || []),...entry.records.map(r=>r.id)])];}
  prop.removedRecords = prop.removedRecords.filter(r => r.id !== id);
  touch();
}
export function openRecovery(rerender) {
  const prop = activeProperty(); if (!prop) return;
  const dialog = document.createElement('dialog'); dialog.className = 'dialog';
  const entries = prop.removedRecords || [];
  dialog.innerHTML = `<h2>Removed records</h2><p>Restore records with their original IDs and evidence. Existing records are never overwritten.</p>${entries.length ? entries.map(e => `<p>${escapeHtml(e.at)} · ${escapeHtml(e.records.map(r => r.name || r.id).join(', '))} <button class="btn" data-restore="${escapeHtml(e.id)}">RESTORE</button></p>`).join('') : '<p>No removed records for this project.</p>'}<p role="status"></p><button class="btn" data-history>SAVED CONFLICT COPIES</button><button class="btn" data-close>CLOSE</button>`;
  document.body.append(dialog); dialog.showModal();
  dialog.querySelector('[data-history]').onclick = async () => { dialog.close(); await openSavedCopies(rerender); };
  dialog.querySelector('[data-close]').onclick = () => dialog.close();
  dialog.onclose = () => dialog.remove();
  dialog.querySelectorAll('[data-restore]').forEach(b => b.onclick = () => {
    try { restoreRemoved(prop, b.dataset.restore); dialog.close(); rerender(); }
    catch (e) { dialog.querySelector('[role=status]').textContent = e.message; }
  });
}

async function openSavedCopies(rerender) {
  const { diskWorkspace } = await import('./disk-workspace.js');
  if (!diskWorkspace) { alert('Saved conflict copies are available when connected to the Mac.'); return; }
  const dialog=document.createElement('dialog');dialog.className='dialog';document.body.append(dialog);dialog.showModal();dialog.onclose=()=>dialog.remove();
  dialog.innerHTML='<h2>Saved conflict copies</h2><p data-status>Loading…</p><div data-copies></div><section data-preview></section><button class="btn" data-close>CLOSE</button>';
  dialog.querySelector('[data-close]').onclick=()=>dialog.close();
  const status=dialog.querySelector('[data-status]');
  try {
    const {copies}=await diskWorkspace.recoveryCopies();status.textContent='Preview before restoring. Your current workspace is preserved as another recovery copy first.';
    dialog.querySelector('[data-copies]').innerHTML=copies.map((c,i)=>`<p>${escapeHtml(new Date(c.modified*1000).toLocaleString())} · ${Math.round(c.size/1024)} KB <button class="btn" data-copy="${i}">COMPARE</button></p>`).join('') || '<p>No saved conflict copies.</p>';
    dialog.querySelectorAll('[data-copy]').forEach(b=>b.onclick=async()=>{
      try {
        const copy=copies[+b.dataset.copy], summary=await diskWorkspace.recoverySummary(copy.name), preview=dialog.querySelector('[data-preview]');
        preview.innerHTML=`<h3>Copy contents</h3>${summary.properties.map(p=>{const now=ws.data.properties.find(q=>q.id===p.id);return `<p>${escapeHtml(p.name)}: ${p.walls} walls / ${p.rooms} floor regions. Current: ${now?.walls?.length || 0} walls / ${now?.rooms?.length || 0} floor regions.</p>`;}).join('')}<p>${summary.products} product records; ${summary.scopes} scopes. Restoring imports every project in this copy and may replace records with matching IDs.</p><button class="btn" data-restore-copy>RESTORE THIS COPY</button>`;
        preview.querySelector('[data-restore-copy]').onclick=async()=>{try{await diskWorkspace.restoreRecovery(copy.name);dialog.close();rerender();}catch(e){status.textContent=e.message;}};
      } catch(e) {status.textContent=e.message;}
    });
  }catch(e){status.textContent=e.message;}
}
