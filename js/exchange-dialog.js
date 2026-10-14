import { converterCapabilities, conversionJobs, conversionPacket, cancelConversion } from './native-conversion.js';
import { EXCHANGE_FORMATS, exportModel } from './model-exchange.js';
import { SCAN_ACCEPT, importScanFile } from './scans.js';
import { escapeHtml, getFile, touch } from './store.js';

export function downloadModel(blob, name) {
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function downloadOriginal(scan) {
  const record = await getFile(scan.originalFileId || scan.id);
  if (!record?.buffer) throw new Error('Original file is missing from browser storage');
  downloadModel(new Blob([record.buffer]), scan.originalName || scan.name);
}

export function openExchangeDialog(prop, { selected, imported, changed, hooks, host, close } = {}) {
  const dialog = document.createElement(host ? 'div' : 'dialog'); dialog.className = 'v-export-dialog';
  const captures = prop.scans || [];
  const meshes = (prop.scans || []).filter(s => s.kind === 'mesh');
  dialog.innerHTML = `<form method="dialog"><h3>Edit in your modeling app</h3>
    <p>Build here, edit in Blender or SketchUp, then bring the exported model back. Keep a .tiksi project for your editable plan, scope and photos.</p>
    <label>Export source <select data-source><option value="design">Tiksi floorplan — all levels</option>${captures.map(s => `<option value="${escapeHtml(s.id)}" ${s.id === selected || s.id === prop.modelSourceId ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}</select></label>
    <label>Format <select data-format>${EXCHANGE_FORMATS.map(([id,name])=>`<option value="${id}">${name}</option>`).join('')}</select></label>
    <p data-format-note></p><p data-engines role="status">Checking native engines…</p>
    <label class="v-export-check"><input type="checkbox" data-include> Include visible imported meshes with floorplan</label>
    <button type="button" class="btn" data-save-model>SAVE 3D MODEL</button><button type="button" class="btn" data-save-original>SAVE ORIGINAL CAPTURE</button>
    <hr><h3>BRING BACK / IMPORT</h3>
    <p>In Blender: File → Import → glTF 2.0; edit; File → Export → GLB. In current SketchUp: File → Import → GLB; edit; File → Export → 3D Model → GLB. Preserve the drawing origin. For older SketchUp use COLLADA. ZIP the DAE/OBJ/FBX with all its texture files.</p>
    <label>Revision of <select data-revision><option value="">New model</option><option value="design" ${!selected ? 'selected':''}>Tiksi floorplan</option>${captures.map(s=>`<option value="${escapeHtml(s.id)}" ${s.id===selected?'selected':''}>${escapeHtml(s.name)}</option>`).join('')}</select></label>
    <label class="v-export-check"><input type="checkbox" data-show-return checked> Show returned model in place of the floorplan in 3D</label>
    <p>Imports preserve file coordinates (metres/Y-up for GLB). Earlier models remain saved and hidden. Imported triangles do not update parametric walls, dimensions or budgets; use Propose plan to review a new floorplan.</p>
    <input type="file" class="hidden-file" data-return-file accept="${SCAN_ACCEPT},.skp,.blend,.ifc,.rvt,.dwg,.dxf,.3dm,.usd,.usdz,.laz,.e57">
    <button type="button" class="btn" data-import-model>IMPORT / BRING BACK MODEL</button>
    <label class="v-export-check"><input type="checkbox" data-native ${prop.modelSourceId?'':'checked'}> Show Tiksi floorplan in 3D</label>
    <details><summary>Formats and limits</summary><p>Direct mesh import: GLB, glTF, OBJ, DAE, FBX, 3DS, PLY and STL. ZIP multi-file models with their textures. Point clouds: PLY, LAS, PCD, XYZ/PTS. Splats: SPLAT, SPZ, KSPLAT, SOG, Gaussian PLY.</p><p>Native SKP and BLEND, IFC, STEP/IGES, Rhino render meshes, DXF surfaces, USD, E57 and compressed LAZ use local converters. RVT, DWG, unmeshed Rhino objects and drafting-only DXF retain an agent handoff when a reader or interpretation is needed. Procedural modifiers, BIM relationships, application scenes and animations are not an editable Tiksi design. Save the source application file too. Material names and colours are evidence, not verified product identities.</p></details>
    <details><summary>Conversion history / agent handoffs</summary><p>Handoffs contain the original upload, converter logs and an interpretation report when available. Save the ZIP for Codex or Claude. Server copies are separate from .tiksi saves.</p><button type="button" class="btn" data-history>REFRESH CONVERSIONS</button><div data-jobs></div></details>
    <button type="button" class="btn" data-cancel-conversion hidden>CANCEL CONVERSION</button><p role="status" data-status></p><div class="v-export-actions"><button class="btn" data-close>CLOSE</button></div></form>`;
  if(host) {host.append(dialog);dialog.className='exchange-panel';dialog.close=close || (()=>{});dialog.querySelector('[data-close]').remove();} else {document.body.append(dialog);dialog.showModal();dialog.addEventListener('close',()=>dialog.remove());}
  let busy = false;
  const status = dialog.querySelector('[data-status]'), source = dialog.querySelector('[data-source]'), format = dialog.querySelector('[data-format]');
  const note = () => {dialog.querySelector('[data-save-original]').disabled=source.value==='design';dialog.querySelector('[data-save-model]').disabled=source.value!=='design'&&!meshes.some(s=>s.id===source.value);dialog.querySelector('[data-format-note]').textContent=EXCHANGE_FORMATS.find(f=>f[0]===format.value)[2];dialog.querySelector('[data-include]').disabled=source.value!=='design';};
  converterCapabilities().then(cap=>{
    dialog.querySelector('[data-engines]').textContent='Local engines: SketchUp '+(cap.sketchup?'ready':'needs SDK')+' · Blender '+(cap.blender?'ready':'needs installation')+' · IFC/CAD '+(cap.cad?'ready':'needs tools/install-converters.py');
    for(const option of format.options) if(option.value==='blend'&&!cap.blender || option.value==='skp'&&!cap.sketchup || option.value==='ifc'&&!cap.cad)option.disabled=true;
  }).catch(e=>{dialog.querySelector('[data-engines]').textContent=e.message;for(const option of format.options)if(['blend','skp','ifc'].includes(option.value))option.disabled=true;});
  source.onchange=note; format.onchange=note; note();
  const run = async fn => {
    if(busy) return; busy=true;
    dialog.querySelectorAll('button').forEach(b=>b.disabled=true);
    const cancel=dialog.querySelector('[data-cancel-conversion]');cancel.hidden=false;cancel.disabled=false;cancel.onclick=()=>cancelConversion().catch(e=>status.textContent=e.message);
    dialog.oncancel=e=>e.preventDefault();
    try {await fn();} catch(e) {status.textContent=e.message;}
    finally {dialog.querySelector('[data-cancel-conversion]').hidden=true;busy=false;dialog.oncancel=null;dialog.querySelectorAll('button').forEach(b=>b.disabled=false);hooks?.progress?.(null);note();}
  };
  dialog.querySelector('[data-save-original]').onclick=()=>run(()=>downloadOriginal(captures.find(s=>s.id===source.value)));
  dialog.querySelector('[data-save-model]').onclick=()=>run(async()=>{
    status.textContent='Packing geometry and textures…';
    const out=await exportModel(prop,{format:format.value,source:source.value==='design'?'design':'model',scanId:source.value,includeModels:dialog.querySelector('[data-include]').checked});
    downloadModel(out.blob,out.name);status.textContent='Saved '+out.name+(out.warnings?.length?' · '+out.warnings.join(' '):'');
  });
  const file = dialog.querySelector('[data-return-file]');
  dialog.querySelector('[data-import-model]').onclick=()=>file.click();
  file.onchange=()=>run(async()=>{
    const upload=file.files[0];file.value='';if(!upload)return;
    status.textContent='Validating '+upload.name+'…';
    const revision=dialog.querySelector('[data-revision]').value;
    const prior=captures.find(s=>s.id===revision);
    const scan=await importScanFile(upload,prop,hooks);
    if(!scan) {status.textContent='This format needs conversion. See Formats and limits.';return;}
    // A returned file contains world-space coordinates exported by Tiksi. Applying the
    // prior placement again would double its translation, rotation and scale.
    if(prior && scan.kind==='mesh') {scan.revisionOf=prior.id;prior.visible=false;}
    if(revision==='design') scan.revisionOf='design';
    if(revision && scan.kind==='mesh') prop.designComparison={beforeId:revision,afterId:scan.id,view:'after'};
    if(scan.kind==='mesh' && dialog.querySelector('[data-show-return]').checked) prop.modelSourceId=scan.id;
    touch();await imported?.(scan);dialog.close();
  });
  const history=async()=>{
    const jobs=await conversionJobs(), list=dialog.querySelector('[data-jobs]');list.replaceChildren();
    if(!jobs.length)list.textContent='No native conversions yet.';
    for(const job of jobs) {
      const row=document.createElement('div'), label=document.createElement('p');label.textContent=job.inputFormat+' → '+job.outputFormat+' · '+job.state+(job.error?' · '+job.error:'');row.append(label);
      const save=document.createElement('button');save.type='button';save.className='btn';save.textContent='SAVE AGENT HANDOFF';save.onclick=()=>run(async()=>downloadModel(await conversionPacket(job.id),'tiksi-conversion-'+job.id+'.zip'));row.append(save);
      const del=document.createElement('button');del.type='button';del.className='btn';del.textContent='DELETE SERVER COPY';del.onclick=()=>run(async()=>{await conversionPacket(job.id,true);await history();});row.append(del);list.append(row);
    }
  };
  dialog.querySelector('[data-history]').onclick=()=>run(history);
  dialog.querySelector('[data-native]').onchange=e=>{if(e.target.checked)delete prop.modelSourceId;else if(selected || meshes.length)prop.modelSourceId=selected || meshes.at(-1).id;touch();changed?.();};
  return dialog;
}
