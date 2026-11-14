// The MODEL inspector's sections for an imported model: its materials (each once, with how many
// parts use it, bound to library records), its components (each definition once, with its count
// through the nesting, a way to select its instances, and a link to a real product), the
// component the selected part belongs to, and converting an old flattened SKP import again.
// viewer3d.js renders modelPanelHtml into the scan inspector and calls bindModelPanel.
//
// ctx: { prop, scan, obj (the loaded wrapper or null), picks (selected part keys), models (the
//        property's loaded models: [{ scan, root }]), reload(), rerender(), select(keys), toast }

import { ws, uid, touch, escapeHtml, fmtMoney, fmtArea, materialById, getFile } from './store.js';
import { normalizeScenes, bringInScenes, scenesShown } from './sketchup-scenes.js';
import { modelTakeoff, createModelEstimate, createComponentEstimate, finishAmount, amountText } from './model-takeoff.js';
import { modelComponents, instanceOf, instanceChain, componentKeyOf, componentProductRecord, componentProductEvidence, componentIdentityStatus, normalizeComponentProduct, linkComponentProduct, unlinkComponentProduct,
  componentSchedule, propertyComponentSchedule, convertedWithComponents } from './model-components.js';
import { identityLine, colourLine, productLine } from './material-identity.js';
import { materialTitle } from './materials.js';
import { modelParts, partKey, partByKey } from './tags-scene.js';

const FILTER_AT = 12;
let filter = '';

function hexOf(m) { return m && m.color && m.color.getHexString ? '#' + m.color.getHexString() : '#999999'; }
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : (many || one + 's'));

// Part keys of a model, by mesh, computed once per call.
function keysByMesh(scan, obj) {
  const map = new Map();
  for (const part of modelParts(obj)) map.set(part.object, partKey(scan.id, part));
  return map;
}
const inner = obj => obj && obj.userData && obj.userData.inner;
// The loaded file's scene under the wrapper: where scans.js shared its materials on load.
const modelRoot = obj => { const i = inner(obj); return (i && i.children.length === 1 ? i.children[0] : i) || null; };

function materialsHtml(scan, obj) {
  const slots = modelTakeoff(modelRoot(obj));
  const q = filter.trim().toLowerCase();
  const rows = slots.map(slot => {
    const bound = materialById(scan.materialBindings && scan.materialBindings[slot.key]);
    const known = materialById(scan.materialIdentities && scan.materialIdentities[slot.key]);
    const rec = bound || known;
    const facts = rec ? [identityLine(rec), colourLine(rec), productLine(rec, ws.data.products)].filter(Boolean) : [];
    const amount = rec ? amountText(finishAmount(rec, slot.areaM2)) : '';
    const hidden = q && !(slot.name + ' ' + (rec ? rec.name + ' ' + facts.join(' ') : '')).toLowerCase().includes(q);
    return `<div class="field mp-row" data-mp-slot="${escapeHtml(slot.key)}" ${hidden ? 'hidden' : ''}>
      <label title="${escapeHtml(slot.name)}"><i class="mp-swatch" style="background:${escapeHtml(hexOf(slot.material))}"></i>${escapeHtml(slot.name)}
        <span class="faint">· ${escapeHtml(plural(slot.parts, 'part'))} · ${escapeHtml(fmtArea(slot.areaM2))}</span></label>
      <select data-model-material="${escapeHtml(slot.key)}"><option value="">Original surface${known ? ' · ' + escapeHtml(known.name) : ''}</option>${ws.data.materials.map(m => `<option value="${escapeHtml(m.id)}" title="${escapeHtml(materialTitle(m))}" ${scan.materialBindings?.[slot.key] === m.id ? 'selected' : ''}>${escapeHtml(m.name)}</option>`).join('')}</select>
      ${facts.length || amount ? `<div class="mp-facts">${facts.map(f => `<span>${escapeHtml(f)}</span>`).join('')}${amount ? `<span class="mp-amount">${escapeHtml(amount)}</span>` : ''}</div>` : ''}
    </div>`;
  }).join('');
  return `<h3>MATERIALS · ${slots.length}</h3>
    <p class="empty">Each material of the model once, with the parts that use it. Choosing a library material changes every part that uses it. Names and colours do not establish a product identity.</p>
    ${slots.length > FILTER_AT ? `<input type="search" class="search-input" data-mp-filter placeholder="filter materials..." value="${escapeHtml(filter)}">` : ''}
    ${rows}
    <button class="btn" data-estimate>CREATE FINISH ESTIMATE</button><p class="empty">Measured triangle surface areas. Map only finish surfaces to include; review overlaps and waste in Scope before ordering. Amounts come from the coverage stored on a material and are estimates from area.</p>`;
}

function productOptions(selectedId) {
  return '<option value="">(type a maker and model number)</option>' + ws.data.products.map(p =>
    `<option value="${escapeHtml(p.id)}" ${p.id === selectedId ? 'selected' : ''}>${escapeHtml([p.name, p.brand && !String(p.name || '').includes(p.brand) ? p.brand : '', p.model].filter(Boolean).join(' · '))}</option>`).join('');
}

function componentsHtml(scan, obj, comps) {
  if (!comps.length) return '';
  const byKey = new Map(comps.map(c => [c.key, c]));
  const schedule = new Map(componentSchedule(ws.data, scan, inner(obj)).map(r => [r.key, r]));
  let total = 0, priced = 0;
  const rows = comps.map(c => {
    const r = schedule.get(c.key);
    total += r.extended; if (r.unitPrice) priced++;
    return componentRow(scan, c, byKey, r);
  }).join('');
  return componentsFoot(comps, rows, priced, total);
}
function componentEvidenceHtml(evidence, label = 'Identity') {
  if (!evidence) return '';
  const dimensions = typeof evidence.dims_mm === 'string' ? evidence.dims_mm : Object.entries(evidence.dims_mm || {}).map(([k, v]) => k + ': ' + v).join('; ');
  const sources = typeof evidence.evidence === 'string' ? [evidence.evidence] : Object.entries(evidence.evidence || {}).flatMap(([aspect, claim]) => {
    if (!claim || typeof claim !== 'object') return [];
    const words = [claim.source, claim.note].filter(v => typeof v === 'string' && v.trim());
    return words.length ? [aspect + ': ' + words.join(' — ')] : [];
  });
  if (evidence.evidenceText) sources.unshift(evidence.evidenceText);
  return `<div class="mp-facts"><span>${escapeHtml(label)}: ${escapeHtml(componentIdentityStatus(evidence))}</span></div>
    ${evidence.uncertainty ? `<div class="mp-facts"><span>Unresolved: ${escapeHtml(evidence.uncertainty)}</span></div>` : ''}
    ${sources.length || dimensions || evidence.documents?.length || evidence.url ? `<details class="mp-evidence"><summary>EVIDENCE</summary>
      ${sources.map(source => `<p>${escapeHtml(source)}</p>`).join('')}
      ${dimensions ? `<p>Recorded dimensions (mm): ${escapeHtml(dimensions)}</p>` : ''}
      ${evidence.documents?.length ? `<p>Documents: ${evidence.documents.map(escapeHtml).join('; ')}</p>` : ''}
      ${evidence.url ? `<a href="${escapeHtml(evidence.url)}" target="_blank" rel="noopener noreferrer">Source</a>` : ''}</details>` : ''}`;
}
function componentRow(scan, c, byKey, r, card = false) {
    const rec = componentProductRecord(ws.data, scan, c.key);
    const evidence = componentProductEvidence(scan, c.key);
    const identity = evidence && [evidence.brand, evidence.model].filter(Boolean).join(' · ');
    const installed = evidence || {}, proposal = normalizeComponentProduct(installed.proposedProduct);
    const activeProposal = proposal && !proposal.unlinked, editingLink = activeProposal ? proposal : installed;

    const within = c.parents.map(k => byKey.get(k)?.name).filter(Boolean);
    const holds = Object.entries(c.contains).map(([k, n]) => n + ' × ' + (byKey.get(k)?.name || 'component'));
    return `<div class="mp-comp" data-mp-comp="${escapeHtml(c.key)}">
      <div class="mp-comp-head"><b title="${escapeHtml(c.definitionId ? 'SketchUp definition ' + c.definitionId : c.name)}">${escapeHtml(c.name)}</b><span class="mp-count">× ${c.count}</span></div>
      ${within.length || holds.length ? `<div class="mp-facts">${within.length ? `<span>inside ${escapeHtml(within.join(', '))}</span>` : ''}${holds.length ? `<span>each holds ${escapeHtml(holds.join(', '))}</span>` : ''}</div>` : ''}
      ${c.description ? `<div class="mp-facts"><span>${escapeHtml(c.description.slice(0, 200))}</span></div>` : ''}
      <div class="mp-facts">${rec ? `<span>${escapeHtml(productLine({ product: { productId: rec.id } }, ws.data.products) || rec.name || 'Product')}</span>${r.unitPrice ? `<span>${escapeHtml(fmtMoney(r.unitPrice))} each · ${escapeHtml(fmtMoney(r.extended))}</span>` : `<span class="faint">${escapeHtml(r.priceNote || 'no price yet')}</span>`}` : `${evidence ? `<span>${escapeHtml(identity || evidence.name || 'Recorded component evidence')}</span>` : ''}<span class="faint">no product linked</span>`}</div>
      ${componentEvidenceHtml(evidence)}
      ${proposal ? componentEvidenceHtml(proposal, proposal.unlinked ? 'Previous proposed match' : 'Proposed match') : ''}
      ${card ? '' : `<div class="mp-actions"><button class="btn" data-mp-select="${escapeHtml(c.key)}" title="Select and outline every instance">SELECT ${c.count}</button></div>`}
      <p class="empty">Installed identity: ${escapeHtml(productLine({ product: installed }, ws.data.products) || 'unidentified')} (${escapeHtml(componentIdentityStatus(installed))}). Linking a product does not change the geometry.${activeProposal ? ' A separate proposed purchasable match is linked below.' : ''}</p>
      <details class="mp-link"><summary>${rec ? 'CHANGE PRODUCT' : 'LINK PRODUCT'}</summary>
        <div class="field"><label>From the products list</label><select data-mp-product>${productOptions(rec ? rec.id : '')}</select></div>
        <div class="field-row"><div class="field"><label>Maker</label><input type="text" data-mp-brand value="${escapeHtml(rec ? rec.brand || '' : '')}" placeholder="e.g. Kohler"></div>
          <div class="field"><label>Model number</label><input type="text" data-mp-model value="${escapeHtml(rec ? rec.model || '' : '')}" placeholder="e.g. K-7505-BN"></div></div>
        <div class="field"><label>Product name</label><input type="text" data-mp-name value="${escapeHtml(rec ? rec.name || '' : '')}" placeholder="optional"></div>
        <div class="field"><label>Identity status</label><select data-mp-identity>${['unknown','observed','proposed'].map(k => `<option value="${k}" ${editingLink.identityStatus === k ? 'selected' : ''}>${k === 'proposed' ? 'Proposed purchasable match' : k}</option>`).join('')}</select></div>
        <div class="field"><label>Identity evidence reference</label><input type="text" data-mp-evidence value="${escapeHtml(editingLink.evidence?.identity?.source || '')}"></div>
        <button class="btn" data-mp-link="${escapeHtml(c.key)}">LINK</button>${rec ? `<button class="btn" data-mp-unlink="${escapeHtml(c.key)}">${activeProposal ? 'UNLINK PROPOSED MATCH' : 'UNLINK'}</button>` : ''}
      </details>
    </div>`;
}
function componentsFoot(comps, rows, priced, total) {
  return `<h3>COMPONENTS · ${comps.length}</h3>
    <p class="empty">Each component definition once, counted through its nesting. Same definition, same thing; separately defined components stay separate even when they look alike.</p>
    ${rows}
    <div class="stat-line"><span>Priced components</span><b>${priced} of ${comps.length} · ${escapeHtml(fmtMoney(total))}</b></div>
    <button class="btn" data-component-estimate>CREATE COMPONENT ESTIMATE</button>`;
}

function propertyScheduleHtml(models) {
  const withComponents = models.filter(m => m.root && modelComponents(m.root).length);
  if (withComponents.length < 2) return '';
  const rows = propertyComponentSchedule(ws.data, withComponents);
  const total = rows.reduce((s, r) => s + r.extended, 0);
  return `<details class="mp-all"><summary>ALL MODELS · ${rows.length} components · ${escapeHtml(fmtMoney(total))}</summary>
    <table class="mp-table"><tr><th>Component</th><th>Count</th><th>Each</th><th>Total</th></tr>${rows.slice(0, 200).map(r => `<tr><td title="${escapeHtml(r.models.join(', '))}">${escapeHtml(r.product || r.name)}</td><td>${r.count}</td><td>${r.unitPrice ? escapeHtml(fmtMoney(r.unitPrice)) : '–'}</td><td>${r.extended ? escapeHtml(fmtMoney(r.extended)) : '–'}</td></tr>`).join('')}</table></details>`;
}

// Which component the selected part belongs to, innermost first.
function selectedPartHtml(scan, obj, picks, comps) {
  if (!picks || picks.length !== 1) return '';
  const part = partByKey(obj, picks[0]);
  if (!part) return '';
  const chain = instanceChain(part.object, inner(obj));
  if (!chain.length) return '';
  const byKey = new Map(comps.map(c => [c.key, c]));
  const c = byKey.get(componentKeyOf(chain[0]));
  const n = c ? c.instances.indexOf(chain[0]) + 1 : 0;
  return `<div class="mp-part"><div class="stat-line"><span>Component</span><b>${escapeHtml(chain[0].userData.sketchupComponent)}</b></div>
    ${chain.length > 1 ? `<div class="mp-facts"><span>inside ${escapeHtml(chain.slice(1).map(o => o.userData.sketchupComponent).join(' › '))}</span></div>` : ''}
    ${c ? `<div class="mp-facts"><span>instance ${n} of ${c.count}${chain[0].userData.sketchupInstanceName ? ' · ' + escapeHtml(chain[0].userData.sketchupInstanceName) : ''}</span></div><button class="btn" data-mp-select="${escapeHtml(c.key)}">SELECT ALL ${c.count}</button>` : ''}</div>`;
}

function reconvertHtml(scan, obj) {
  if (!/\.skp$/i.test(scan.originalName || '') || !scan.originalFileId || scan.originalFileId === scan.id) return '';
  if (convertedWithComponents(inner(obj))) return '';
  return `<div class="mp-reconvert"><p class="empty">This SketchUp model was converted before Tiksi kept components, so its parts are separate copies. Converting it again from the original SKP keeps each component definition once with its instances. Material choices and tags carry over.</p>
    <button class="btn" data-mp-reconvert>CONVERT AGAIN FROM THE ORIGINAL SKP</button></div>`;
}

// A SketchUp model's scenes as saved views (sketchup-scenes.js): how many there are, how many
// have a view, and a button that reads them from the original SKP and makes or updates the views.
function scenesHtml(prop, scan) {
  if (!/\.skp$/i.test(scan.originalName || '') || !scan.originalFileId) return '';
  const n = normalizeScenes(scan.sketchupScenes).length, shown = n ? scenesShown(prop, scan) : 0;
  const line = !scan.sketchupScenes ? 'The scenes of the original SKP have not been read yet.'
    : !n ? 'The original SKP has no scenes.'
    : plural(n, 'scene') + ' in the SKP; ' + (shown === n ? 'each one is a saved view' : shown + ' ' + (shown === 1 ? 'is a saved view' : 'are saved views')) + ', in the tabs over the model.';
  const label = n && shown ? 'UPDATE THE VIEWS FROM THE SKP\'S SCENES' : 'MAKE SAVED VIEWS FROM THE SKP\'S SCENES';
  return `<div class="mp-scenes"><h3>SKETCHUP SCENES</h3><p class="empty">${escapeHtml(line)} A scene's view keeps its camera and the tags it hides, and puts away Tiksi's own walls and rooms, which the SKP does not have; section cuts and styles stay in the SKP.</p>
    <button class="btn" data-mp-scenes>${label}</button></div>`;
}

// One component definition's card on its own (the object panel shows it for the selected
// object): its count, what it holds, its product and the product link.
export function componentCardHtml(ctx, key) {
  const { scan, obj } = ctx;
  if (!obj || !inner(obj)) return '';
  const comps = modelComponents(inner(obj)), c = comps.find(x => x.key === key);
  if (!c) return '';
  const r = componentSchedule(ws.data, scan, inner(obj)).find(x => x.key === key);
  return `<div class="model-panel"><h3>PRODUCT</h3>${componentRow(scan, c, new Map(comps.map(x => [x.key, x])), r, true)}</div>`;
}

export function modelPanelHtml(ctx) {
  const { scan, obj, picks } = ctx;
  if (!obj || !inner(obj)) return '';
  const comps = modelComponents(inner(obj));
  return `<div class="model-panel">${selectedPartHtml(scan, obj, picks, comps)}${reconvertHtml(scan, obj)}${ctx.prop ? scenesHtml(ctx.prop, scan) : ''}${materialsHtml(scan, obj)}${componentsHtml(scan, obj, comps)}${propertyScheduleHtml(ctx.models || [])}</div>`;
}

export function bindModelPanel(root, ctx) {
  const { prop, scan, obj, toast } = ctx;
  const panel = root.querySelector('.model-panel');
  if (!panel || !obj) return;
  const say = (msg, kind) => toast && toast(msg, kind || 'ok');
  const f = panel.querySelector('[data-mp-filter]');
  if (f) f.oninput = () => {
    filter = f.value;
    const q = filter.trim().toLowerCase();
    panel.querySelectorAll('[data-mp-slot]').forEach(row => { row.hidden = !!q && !row.textContent.toLowerCase().includes(q) && !row.querySelector('select option:checked')?.textContent.toLowerCase().includes(q); });
  };
  panel.querySelectorAll('[data-model-material]').forEach(input => input.onchange = async () => {
    scan.materialBindings = scan.materialBindings || {};
    if (input.value) scan.materialBindings[input.dataset.modelMaterial] = input.value; else delete scan.materialBindings[input.dataset.modelMaterial];
    touch();
    try { await ctx.reload(); } catch (e) { say(e.message, 'error'); }
  });
  const estimate = panel.querySelector('[data-estimate]');
  if (estimate) estimate.onclick = () => { try { const pr = createModelEstimate(prop, scan, modelRoot(obj)); say('Created ' + pr.name + '. Review quantities and prices in Scope / Budget.'); } catch (e) { say(e.message, 'warn'); } };
  const compEstimate = panel.querySelector('[data-component-estimate]');
  if (compEstimate) compEstimate.onclick = () => { try { const pr = createComponentEstimate(prop, scan, inner(obj)); say('Created ' + pr.name + ' with ' + plural(pr.items.length, 'component') + '. Review counts and prices in Scope / Budget.'); } catch (e) { say(e.message, 'warn'); } };
  panel.querySelectorAll('[data-mp-select]').forEach(b => b.onclick = () => {
    const c = modelComponents(inner(obj)).find(x => x.key === b.dataset.mpSelect);
    if (!c) return;
    if (ctx.selectComponent) { ctx.selectComponent(c); return; }
    const keys = keysByMesh(scan, obj), picks = [...new Set(c.parts.map(m => keys.get(m)).filter(Boolean))];
    if (picks.length) ctx.select(picks);
  });
  panel.querySelectorAll('.mp-comp').forEach(row => {
    const key = row.dataset.mpComp;
    const link = row.querySelector('[data-mp-link]'), unlink = row.querySelector('[data-mp-unlink]'), pick = row.querySelector('[data-mp-product]');
    if (pick) pick.onchange = () => {
      const rec = ws.data.products.find(p => p.id === pick.value);
      row.querySelector('[data-mp-brand]').value = rec ? rec.brand || '' : '';
      row.querySelector('[data-mp-model]').value = rec ? rec.model || '' : '';
      row.querySelector('[data-mp-name]').value = rec ? rec.name || '' : '';
    };
    if (link) link.onclick = () => {
      const c = modelComponents(inner(obj)).find(x => x.key === key);
      try {
        const { record, created } = linkComponentProduct(ws.data, prop, scan, c, { productId: pick.value || null, brand: row.querySelector('[data-mp-brand]').value,
          identityStatus: row.querySelector('[data-mp-identity]').value, evidence: { identity: { source: row.querySelector('[data-mp-evidence]').value } }, model: row.querySelector('[data-mp-model]').value, name: row.querySelector('[data-mp-name]').value }, uid);
        touch(); ctx.rerender();
        say(c.name + ' × ' + c.count + ' is linked to ' + (record.name || record.model) + (created ? ' (added to Products; add its price there)' : '') + '.');
      } catch (e) { say(e.message, 'warn'); }
    };
    if (unlink) unlink.onclick = () => { unlinkComponentProduct(scan, key, scan.componentProducts?.[key]?.proposedProduct && !scan.componentProducts[key].proposedProduct.unlinked ? 'proposed' : 'all'); touch(); ctx.rerender(); };
  });
  const scenes = panel.querySelector('[data-mp-scenes]');
  if (scenes) scenes.onclick = async () => {
    const label = scenes.textContent;
    scenes.disabled = true; scenes.textContent = 'READING THE SCENES…';
    try {
      const original = await getFile(scan.originalFileId);
      if (!original || !original.buffer) throw new Error('The original SKP is not in this browser.');
      const { sketchupScenes } = await import('./native-conversion.js');
      scan.sketchupScenes = normalizeScenes(await sketchupScenes(original.buffer));
      const r = bringInScenes(prop, scan);
      touch(); ctx.viewsChanged && ctx.viewsChanged(); ctx.rerender();
      say(!scan.sketchupScenes.length ? scan.name + ' has no scenes.' : plural(r.added, 'new saved view') + ', ' + plural(r.updated, 'view') + ' updated from ' + plural(scan.sketchupScenes.length, 'scene') + (r.skipped ? '; ' + r.skipped + ' did not fit (a property keeps 100 views)' : '') + '.');
    } catch (e) { say('Could not read the scenes: ' + e.message, 'error'); scenes.disabled = false; scenes.textContent = label; }
  };
  const again = panel.querySelector('[data-mp-reconvert]');
  if (again) again.onclick = async () => {
    again.disabled = true; again.textContent = 'CONVERTING…';
    try {
      const { convertAgain } = await import('./model-reconvert.js');
      const r = await convertAgain(prop, scan, obj);
      await ctx.reload();
      say('Converted ' + scan.name + ' again: ' + plural(r.components, 'component definition') + ', ' + plural(r.materials, 'material') + '. Tags carried to ' + plural(r.matched, 'part') + (r.unmatched ? '; ' + r.unmatched + ' new parts take automatic tags' : '') + '.');
    } catch (e) { say('Could not convert again: ' + e.message + ' The model stays as it was.', 'error'); again.disabled = false; again.textContent = 'CONVERT AGAIN FROM THE ORIGINAL SKP'; }
  };
}

// For the tag line ("Part: Wine bottle"): the component a part's mesh belongs to, if any.
export function partComponentName(obj, object) {
  const inst = instanceOf(object, inner(obj));
  return inst ? inst.userData.sketchupComponent : '';
}
