// Fixtures in the console: propose them from a scan (scan-fixtures.js in a worker), review
// the proposals one by one, add one by hand, and edit a selected one in the inspector. Every
// change goes through the shared geometry history, so Undo and Redo cover fixtures too.

import { ws, uid, touch, fmtLen, parseLen, escapeHtml, getFile, levelById, levelHeight, wallsOn } from './store.js';
import { productRecordFor, linkFixtureProduct, applyRecordToFixtures, normaliseProductRecord, DOC_LABEL } from './product-records.js';
import { DETAIL_DEFAULTS } from './fixture-detail.js';
import { beginGeometryEdit } from './edit-history.js';
import { FIXTURE_KINDS, fixtureLabel, fixtureShape, fixtureTemplate, normaliseFixture, runLength, roomOfFixture, productFit, productLabel, PRODUCT_CONFIDENCE } from './fixtures.js';
import { detectFixtures } from './scan-fixtures.js';
import { materialSelectHtml } from './materials.js';
import { meshFromObject3D } from './scan2plan.js';
import { loadMesh, applyScanTransform } from './scans.js';

function runWorker(pos, idx, options, say) {
  return new Promise((resolve, reject) => {
    const inline = () => { try { resolve(detectFixtures(pos, idx, options, say)); } catch (e) { reject(e); } };
    let worker = null;
    try { worker = new Worker(new URL('./scan-fixtures.worker.js', import.meta.url), { type: 'module' }); } catch (e) { worker = null; }
    if (!worker) return inline();
    let settled = false;
    worker.onmessage = e => {
      const m = e.data;
      if (m.type === 'progress') say && say(m.stage, m.frac);
      else { settled = true; worker.terminate(); if (m.type === 'done') resolve(m.result); else reject(new Error(m.message)); }
    };
    worker.onerror = () => { if (settled) return; settled = true; worker.terminate(); inline(); };
    const p = new Float32Array(pos), i = new Uint32Array(idx);
    worker.postMessage({ pos: p, idx: i, options }, [p.buffer, i.buffer]);
  });
}

// Proposals for every level of `prop` from a mesh scan. `object` is the scan as MODEL holds
// it (placed); without one the bytes are loaded and placed from the scan record.
export async function proposeFixtures(prop, scan, hooks, object) {
  const say = (m, f) => hooks && hooks.progress && hooks.progress(m, f);
  if (!scan || scan.kind !== 'mesh') throw new Error('fixtures are read from mesh scans only');
  let obj = object, own = false;
  if (!obj) {
    say('Loading ' + scan.name, 0.05);
    const rec = await getFile(scan.id);
    if (!rec || !rec.buffer) throw new Error('the scan bytes are not in this browser (re-import the file)');
    obj = await loadMesh(rec.buffer, scan.format || String(scan.name || '').split('.').pop().toLowerCase());
    applyScanTransform(scan, obj);
    own = true;
  }
  try {
    obj.updateMatrixWorld(true);
    const { pos, idx } = meshFromObject3D(obj);
    const levels = prop.levels.map(l => ({ id: l.id, name: l.name, elevation: l.elevation, height: levelHeight(prop, l.id),
      walls: wallsOn(prop, l.id).map(w => ({ ax: w.ax, ay: w.ay, bx: w.bx, by: w.by, thickness: w.thickness })) }));
    const result = await runWorker(pos, idx, { matrix: Array.from(obj.matrixWorld.elements), levels }, (stage, frac) => say('Reading fixtures: ' + stage, 0.1 + 0.85 * (frac || 0)));
    say(null);
    return result.fixtures.map((f, i) => Object.assign(f, { proposalId: 'p' + (i + 1), provenance: Object.assign({}, f.provenance, { scanId: scan.id }) }));
  } finally {
    if (own) obj.traverse(o => { if (o.geometry) o.geometry.dispose(); const ms = Array.isArray(o.material) ? o.material : o.material ? [o.material] : []; for (const m of ms) { if (m.map) m.map.dispose(); m.dispose(); } });
  }
}

const pct = v => Number.isFinite(v) ? Math.round(v * 100) + '%' : '';
export function fixtureSummary(f) {
  if (fixtureShape(f) === 'run') {
    const parts = [fmtLen(runLength(f)) + ' long', fmtLen(f.depth) + ' deep'];
    parts.push(f.kind === 'base-run' ? 'top ' + fmtLen(f.h) : fmtLen(f.y0) + ' to ' + fmtLen(f.y0 + f.h));
    return parts.join(', ');
  }
  return (f.subtype === 'table-round' ? 'Ø ' + fmtLen(f.w) : fmtLen(f.w) + ' x ' + fmtLen(f.d)) + ', top ' + fmtLen((f.y0 || 0) + f.h);
}

// The review list. Resolves with the fixtures added (possibly none).
export function openFixtureReview(prop, proposals, opts = {}) {
  return new Promise(resolve => {
    const scanId = proposals[0] && proposals[0].provenance.scanId;
    const earlier = (prop.fixtures || []).filter(f => f.provenance && f.provenance.source === 'scan' && f.provenance.scanId === scanId);
    const dialog = document.createElement('dialog');
    dialog.className = 'file-dialog fx-review';
    const levelName = id => (levelById(prop, id) || {}).name || '';
    dialog.innerHTML = `<h2>Fixtures from the scan</h2>
      <p>${proposals.length ? 'Each line is a proposal read from ' + escapeHtml(opts.scanName || 'the scan') + ', with how sure the reading is and what it rests on. Tick the ones that are really there; you can change sizes afterwards in MODEL.' : 'Nothing inside the rooms could be read from this scan. Add fixtures by hand in MODEL.'}</p>
      <ul class="fx-list">${proposals.map(f => `<li><label><input type="checkbox" data-fx="${escapeHtml(f.proposalId)}" ${f.provenance.confidence >= 0.5 ? 'checked' : ''}>
        <span><b>${escapeHtml(fixtureLabel(f))}</b>${prop.levels.length > 1 ? ' · ' + escapeHtml(levelName(f.level)) : ''} · ${escapeHtml(fixtureSummary(f))}<small>${escapeHtml(f.evidence || '')}</small></span>
        <em title="Confidence">${pct(f.provenance.confidence)}</em></label></li>`).join('')}</ul>
      ${earlier.length ? `<label class="v-export-check"><input type="checkbox" data-replace checked> Replace the ${earlier.length} fixture${earlier.length === 1 ? '' : 's'} proposed from this scan before (edited ones stay)</label>` : ''}
      <div class="file-actions">${proposals.length ? '<button class="btn primary" data-add>ADD SELECTED</button><button class="btn" data-all>SELECT ALL</button><button class="btn" data-none>SELECT NONE</button>' : ''}<button class="btn" data-skip>${proposals.length ? 'SKIP' : 'CLOSE'}</button></div>`;
    document.body.append(dialog);
    dialog.showModal();
    const boxes = [...dialog.querySelectorAll('[data-fx]')];
    const done = added => { dialog.close(); dialog.remove(); resolve(added); };
    dialog.addEventListener('cancel', e => { e.preventDefault(); done([]); });
    dialog.querySelector('[data-skip]').onclick = () => done([]);
    const all = dialog.querySelector('[data-all]'), none = dialog.querySelector('[data-none]');
    if (all) all.onclick = () => boxes.forEach(b => { b.checked = true; });
    if (none) none.onclick = () => boxes.forEach(b => { b.checked = false; });
    const add = dialog.querySelector('[data-add]');
    if (add) add.onclick = () => {
      const chosen = new Set(boxes.filter(b => b.checked).map(b => b.dataset.fx));
      const replace = !!dialog.querySelector('[data-replace]:checked');
      done(acceptProposals(prop, proposals.filter(f => chosen.has(f.proposalId)), { replaceFrom: replace ? scanId : null }));
    };
  });
}

// Accepted proposals become fixtures (one undo step). `replaceFrom` drops earlier unedited
// proposals from that scan first, so proposing again does not stack copies.
export function acceptProposals(prop, list, opts = {}) {
  if (!list.length && !opts.replaceFrom) return [];
  beginGeometryEdit(prop, 'add fixtures from scan');
  prop.fixtures = prop.fixtures || [];
  if (opts.replaceFrom) prop.fixtures = prop.fixtures.filter(f => !(f.provenance && f.provenance.source === 'scan' && f.provenance.scanId === opts.replaceFrom));
  const ids = new Set(prop.levels.map(l => l.id)), added = [];
  for (const p of list) {
    const { proposalId, evidence, ...rec } = p;
    const f = normaliseFixture(Object.assign(rec, { id: uid('fx') }), ids);
    if (!f) continue;
    f.provenance.evidence = evidence || '';
    f.roomId = roomOfFixture(prop.rooms, f);
    prop.fixtures.push(f);
    added.push(f);
  }
  touch();
  return added;
}

// A fixture added by hand where the person is looking.
export function addFixture(prop, kind, subtype, at) {
  beginGeometryEdit(prop, 'add fixture');
  const f = normaliseFixture(Object.assign(fixtureTemplate(kind, subtype, at), { id: uid('fx') }), new Set(prop.levels.map(l => l.id)));
  f.roomId = roomOfFixture(prop.rooms, f);
  (prop.fixtures = prop.fixtures || []).push(f);
  touch();
  return f;
}

export function addFixtureHtml() {
  const opts = Object.entries(FIXTURE_KINDS).flatMap(([kind, k]) => k.subtypes.length
    ? k.subtypes.map(s => `<option value="${kind}:${s}">${escapeHtml(fixtureLabel({ kind, subtype: s }))}</option>`)
    : [`<option value="${kind}:">${escapeHtml(k.label)}</option>`]).join('');
  return `<div class="tool-sep"></div><div class="field"><label>Add a fixture</label><select data-fx-kind>${opts}</select></div><button class="btn" data-fx-add>ADD FIXTURE HERE</button>`;
}

const len = (label, key, value, hint) => `<div class="field"><label>${label}</label><input type="text" data-fx-len="${key}" value="${escapeHtml(fmtLen(value))}"${hint ? ` title="${escapeHtml(hint)}"` : ''}></div>`;

export function fixtureInspectorHtml(prop, f) {
  const k = FIXTURE_KINDS[f.kind], box = fixtureShape(f) === 'box';
  const room = (prop.rooms || []).find(r => r.id === roomOfFixture(prop.rooms, f));
  const pv = f.provenance || {};
  const fields = box ? [
    k.subtypes.length > 1 ? `<div class="field"><label>Type</label><select data-fx-subtype>${k.subtypes.map(s => `<option value="${s}" ${s === f.subtype ? 'selected' : ''}>${escapeHtml(fixtureLabel({ kind: f.kind, subtype: s }))}</option>`).join('')}</select></div>` : '',
    `<div class="field-row">${len('X', 'x', f.x)}${len('Y', 'y', f.y)}</div>`,
    `<div class="field"><label>Rotation (degrees)</label><input type="number" step="5" data-fx-rot value="${Math.round((f.rot || 0) * 10) / 10}"></div>`,
    `<div class="field-row">${len(f.subtype === 'table-round' ? 'Diameter' : 'Width', 'w', f.w)}${f.subtype === 'table-round' ? '' : len('Depth', 'd', f.d)}</div>`,
    `<div class="field-row">${len('Height', 'h', f.h)}${len('Bottom', 'y0', f.y0 || 0)}</div>`,
    f.subtype === 'sofa' ? len('Seat height', 'seat', f.seat) : '',
  ] : [
    `<div class="stat-line"><span>Length</span><b>${fmtLen(runLength(f))}</b></div>`,
    len('Depth from the wall', 'depth', f.depth),
    f.kind === 'base-run' ? `<div class="field-row">${len('Counter height', 'h', f.h)}${len('Counter thickness', 'counterT', f.counterT)}</div>
      <div class="field-row">${len('Toe kick', 'toeKick', f.toeKick)}${len('Overhang', 'overhang', f.overhang)}</div>`
      : `<div class="field-row">${len('Underside', 'y0', f.y0)}${len('Height', 'h', f.h)}</div>`,
    `<button class="btn" data-fx-flip title="The body extends to the other side of its back line">FLIP SIDE</button>`,
  ];
  const mats = f.kind === 'base-run' || f.subtype === 'vanity'
    ? `<div class="field"><label>Counter / top</label>${materialSelectHtml('', f.material, 'data-fx-mat="material"')}</div><div class="field"><label>Cabinets</label>${materialSelectHtml('', f.bodyMaterial, 'data-fx-mat="bodyMaterial"')}</div>`
    : f.kind === 'wall-run' ? `<div class="field"><label>Cabinets</label>${materialSelectHtml('', f.bodyMaterial, 'data-fx-mat="bodyMaterial"')}</div>`
      : `<div class="field"><label>Finish</label>${materialSelectHtml('', f.material, 'data-fx-mat="material"')}</div>`;
  return `<h3>${escapeHtml(k.label.toUpperCase())}</h3>
    <div class="field"><label>Name</label><input type="text" data-fx-name value="${escapeHtml(f.name || '')}" placeholder="${escapeHtml(fixtureLabel(Object.assign({}, f, { name: '' })))}"></div>
    <div class="stat-line"><span>Level</span><b>${escapeHtml((levelById(prop, f.level) || {}).name || '')}</b></div>
    ${room ? `<div class="stat-line"><span>Room</span><b>${escapeHtml(room.name || '')}</b></div>` : ''}
    ${fields.join('')}
    ${mats}
    <div class="field"><label>Source</label><select data-fx-source>${[['scan', 'Read from the scan'], ['user', 'Drawn or edited'], ['tape', 'Tape measured']].map(([v, l]) => `<option value="${v}" ${pv.source === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    ${pv.source === 'scan' && Number.isFinite(pv.confidence) ? `<div class="stat-line"><span>Scan confidence</span><b>${pct(pv.confidence)}</b></div>` : ''}
    ${pv.evidence ? `<p class="empty">${escapeHtml(pv.evidence)}</p>` : ''}
    ${productHtml(f)}
    <button class="btn danger" data-fx-del>DELETE FIXTURE</button>`;
}

const CONF_LABEL = { confirmed: 'Confirmed (read)', likely: 'Likely (visual match)', unidentified: 'Not identified' };
const confSelect = (key, value, disabled) => `<select data-fx-pconf="${key}" ${disabled ? 'disabled' : ''}>${PRODUCT_CONFIDENCE.map(c => `<option value="${c}" ${c === value ? 'selected' : ''}>${CONF_LABEL[c]}</option>`).join('')}</select>`;
const clock = t => Math.floor(t / 60) + ':' + String(Math.floor(t % 60)).padStart(2, '0');
function evidenceLine(e) {
  const where = [e.media, e.at != null ? 'at ' + clock(e.at) : '', e.keyframe ? 'keyframe ' + e.keyframe : ''].filter(Boolean).join(' ');
  const reads = e.reads.length ? ' (reads the ' + e.reads.join(' and ') + ')' : '';
  return `<li>${escapeHtml(where + reads)}${e.note ? '<small>' + escapeHtml(e.note) + '</small>' : ''}</li>`;
}
const pctOf = v => Math.round(v * 100) + '%';

// The PRODUCTS record behind the fixture: its documents and the drawing's dimensions.
function recordHtml(f) {
  const r = productRecordFor(ws.data, f);
  if (!r) return f.product && f.product.brand ? '<p class="empty">Enter the model too, and Tiksi files the product in PRODUCTS and looks for its spec sheet, installation drawing and manual.</p>' : '';
  normaliseProductRecord(r);
  const dims = r.dims || {};
  const docs = r.documents.map(d => `<li><b>${escapeHtml(DOC_LABEL[d.kind])}</b>${escapeHtml(d.title)}<small>${escapeHtml(d.path ? 'In the project folder: ' + d.path : d.fileId ? 'Kept in the project file' : 'Not saved')}${d.url ? ' · <a href="' + escapeHtml(d.url) + '" target="_blank" rel="noopener noreferrer">source</a>' : ''}</small></li>`).join('');
  const dl = (label, key) => `<div class="field"><label>${label}</label><input type="text" data-fx-dim="${key}" value="${dims[key] ? escapeHtml(fmtLen(dims[key])) : ''}" placeholder="from the drawing"></div>`;
  return `<div class="stat-line"><span>In PRODUCTS as</span><b>${escapeHtml(r.name || [r.brand, r.model].join(' '))}</b></div>
    <div class="field"><label>Documents</label>${docs ? `<ul class="fx-evidence">${docs}</ul>` : `<p class="empty">${r.documentsSearchedAt ? 'None found yet.' : 'None saved yet.'}</p>`}</div>
    <div class="fx-actions"><button class="btn" data-fx-finddocs title="Search the manufacturer, then retailers, for the spec sheet, installation guide and manual, and save them in the project folder">FIND DOCUMENTS</button><button class="btn" data-fx-adddoc title="Save a document from its web address">ADD DOCUMENT BY ADDRESS</button></div>
    <div class="field-row">${dl('Drawing width', 'w')}${dl('Drawing depth', 'd')}${dl('Drawing height', 'h')}</div>
    ${f.product.dimsFrom ? `<p class="empty">Sized from ${escapeHtml(f.product.dimsFrom)}; the wall side stays where it was measured.</p>` : ''}`;
}

const LENGTH_KEYS = new Set(['backguard', 'kick', 'tank', 'counter']);
const DETAIL_LABEL = { fuel: 'Fuel', burners: 'Burners', knobs: 'Knobs', backguard: 'Backguard height', drawer: 'Storage drawer', window: 'Oven window', kick: 'Toe kick height',
  controls: 'Controls', handle: 'Handle', layout: 'Layout', split: 'Split (share of height below)', hinge: 'Hinges on', style: 'Style', display: 'Display', bowl: 'Bowl',
  tank: 'Rim height', doors: 'Doors', sink: 'Sink', counter: 'Top thickness', apron: 'Apron front', head: 'Shower head', spout: 'Tub spout', door: 'Door', circuits: 'Circuits',
  supply: 'Supply line', pipes: 'Pipes', shape: 'Shape', trap: 'P-trap' };
const CHOICE_LIST = { fuel: ['gas', 'electric'], controls: ['front', 'top', 'right'], handle: ['bar', 'pocket'], hinge: ['right', 'left'], bowl: ['elongated', 'round'],
  sink: ['undermount', 'vessel', 'none'], door: ['open', 'closed'], supply: ['braided', 'rigid'], shape: ['round', 'square'],
  layout: { fridge: ['top-freezer', 'bottom-freezer', 'french', 'side-by-side', 'single'], 'washer-dryer': ['stacked', 'front-washer', 'front-dryer', 'top-washer'] },
  style: { 'range-hood': ['under-cabinet', 'chimney'], faucet: ['single-lever', 'pull-down', 'two-handle'], light: ['flush', 'pendant'] } };

// The numbers the detailed stand-in is built from (fixture-detail.js), as the drawing gives them.
function detailHtml(f) {
  const def = DETAIL_DEFAULTS[f.subtype];
  if (!def || fixtureShape(f) !== 'box' || (f.product && f.product.asset)) return '';
  const d = f.detail || def;
  const fields = Object.keys(def).map(k => {
    const v = d[k], label = escapeHtml(DETAIL_LABEL[k] || k);
    if (typeof def[k] === 'boolean') return `<label class="v-export-check"><input type="checkbox" data-fx-detail="${k}" ${v ? 'checked' : ''}> ${label}</label>`;
    if (Array.isArray(def[k])) return `<div class="field"><label>${label} (one per line: number, label, amps)</label><textarea data-fx-circuits rows="4" placeholder="1 Kitchen counter 20A">${escapeHtml((v || []).map(c => [c.n, c.label, c.amps ? c.amps + 'A' : ''].filter(Boolean).join(' ')).join('\n'))}</textarea></div>`;
    if (LENGTH_KEYS.has(k)) return `<div class="field"><label>${label}</label><input type="text" data-fx-detail-len="${k}" value="${escapeHtml(fmtLen(v))}"></div>`;
    if (typeof def[k] === 'number') return `<div class="field"><label>${label}</label><input type="number" step="${k === 'split' ? 0.01 : 1}" data-fx-detail-num="${k}" value="${v}"></div>`;
    const list = Array.isArray(CHOICE_LIST[k]) ? CHOICE_LIST[k] : (CHOICE_LIST[k] || {})[f.subtype] || [v];
    return `<div class="field"><label>${label}</label><select data-fx-detail="${k}">${list.map(o => `<option value="${o}" ${o === v ? 'selected' : ''}>${escapeHtml(o.replace(/-/g, ' '))}</option>`).join('')}</select></div>`;
  });
  return `<details class="fx-detail"><summary>BUILT FROM</summary>${fields.join('')}</details>`;
}

// "12 Bath GFCI 20A" -> { n: 12, label: 'Bath GFCI', amps: 20 }
function parseCircuits(textValue) {
  return String(textValue || '').split('\n').map(l => l.trim()).filter(Boolean).map(l => {
    const m = /^(\d+)?\s*(.*?)\s*(?:(\d+)\s*a(?:mps?)?)?$/i.exec(l);
    return { n: m && m[1] ? +m[1] : null, label: m ? m[2] : l, amps: m && m[3] ? +m[3] : null, poles: /2[- ]?pole|double/i.test(l) ? 2 : 1 };
  });
}

// What the real product is, how sure the reading is, what it rests on, and its 3D model.
export function productHtml(f) {
  const p = f.product || { brand: '', brandConfidence: 'unidentified', model: '', modelConfidence: 'unidentified', evidence: [], sources: [] };
  const box = fixtureShape(f) === 'box', a = p.asset, fit = productFit(f);
  const stretched = fit && fit.off > 0.1;
  const model = !box ? '' : a ? `<div class="stat-line"><span>3D model</span><b title="${escapeHtml(a.name)}">${escapeHtml(a.name || 'Attached')}</b></div>
      ${a.origin ? `<p class="empty"><a href="${escapeHtml(a.origin)}" target="_blank" rel="noopener noreferrer">${escapeHtml(a.originName || 'Source of the model')}</a>${a.license ? ' · ' + escapeHtml(a.license) : ''}</p>` : ''}
      <div class="stat-line" ${stretched ? 'data-fx-stretch' : ''}><span>Fit to the measured box</span><b>${fit.scale.map(pctOf).join(' × ')}</b></div>
      ${stretched ? `<p class="empty">The model is ${pctOf(fit.off)} off the measured size on one side. Check the measurement, or use the model's own size if the model is right.</p>` : ''}
      <div class="fx-actions"><button class="btn" data-fx-turn title="Turn the model a quarter turn so its front faces the room">TURN 90°</button><button class="btn" data-fx-usesize title="Make the box the model's real size: ${escapeHtml(fit.size.map(v => fmtLen(v)).join(' × '))}">USE MODEL SIZE</button></div>
      <button class="btn" data-fx-unmodel>REMOVE 3D MODEL</button>`
    : `<p class="empty">${escapeHtml(p.assetNote || 'Stand-in shape: no 3D model of the real product is attached.')}</p>`;
  return `<div class="tool-sep"></div><h3>PRODUCT</h3>
    <div class="field"><label>Brand</label><input type="text" data-fx-ptext="brand" value="${escapeHtml(p.brand)}" placeholder="Not identified"></div>
    <div class="field"><label>Brand is</label>${confSelect('brandConfidence', p.brandConfidence, !p.brand)}</div>
    <div class="field"><label>Model</label><input type="text" data-fx-ptext="model" value="${escapeHtml(p.model)}" placeholder="Not read" ${p.brand ? '' : 'disabled'}></div>
    <div class="field"><label>Model is</label>${confSelect('modelConfidence', p.modelConfidence, !p.model)}</div>
    <p class="empty" data-fx-confnote>Confirmed means a logo or rating label was read in a photo, video or scan keyframe listed below; without one it stays Likely.</p>
    ${p.evidence.length ? `<div class="field"><label>Evidence</label><ul class="fx-evidence">${p.evidence.map(evidenceLine).join('')}</ul></div>` : ''}
    ${p.sources.length ? `<div class="field"><label>Sources</label><ul class="fx-evidence">${p.sources.map(x => `<li><a href="${escapeHtml(x.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(x.title || new URL(x.url).hostname)}</a></li>`).join('')}</ul></div>` : ''}
    ${recordHtml(f)}
    ${detailHtml(f)}
    ${model}
    ${box ? `<label class="btn" title="A GLB, SketchUp, OBJ, FBX, DAE or 3DS model of this product, scaled to the measured box">ATTACH 3D MODEL<input type="file" data-fx-model accept=".glb,.gltf,.zip,.skp,.obj,.fbx,.dae,.3ds,.stl,.ply,.blend,.usdz" hidden></label>` : ''}`;
}

// on: { changed(): rebuild the views, deleted(): clear the selection }
export function bindFixtureInspector(root, prop, f, on) {
  const edit = (label, fn, keepSource) => {
    beginGeometryEdit(prop, label);
    fn();
    // A scan reading someone corrected is theirs now; a tape measurement stays one.
    if (!keepSource && f.provenance && f.provenance.source === 'scan') f.provenance = Object.assign({}, f.provenance, { source: 'user' });
    normaliseFixture(f, new Set(prop.levels.map(l => l.id)));
    f.roomId = roomOfFixture(prop.rooms, f);
    touch(); on.changed();
  };
  root.querySelectorAll('[data-fx-len]').forEach(input => input.onchange = () => {
    const key = input.dataset.fxLen, v = parseLen(input.value);
    const free = key === 'x' || key === 'y' || key === 'y0';
    if (!Number.isFinite(v) || (!free && v <= 0)) { on.changed(); return; }
    edit('edit fixture', () => { f[key] = v; if (key === 'w' && f.subtype === 'table-round') f.d = v; });
  });
  const rot = root.querySelector('[data-fx-rot]');
  if (rot) rot.onchange = () => { const v = parseFloat(rot.value); if (Number.isFinite(v)) edit('rotate fixture', () => { f.rot = ((v % 360) + 360) % 360; }); };
  const sub = root.querySelector('[data-fx-subtype]');
  if (sub) sub.onchange = () => edit('change fixture type', () => { f.subtype = sub.value; }, true);
  const name = root.querySelector('[data-fx-name]');
  if (name) name.onchange = () => edit('rename fixture', () => { f.name = name.value.trim().slice(0, 120); }, true);
  const flip = root.querySelector('[data-fx-flip]');
  if (flip) flip.onclick = () => edit('flip fixture', () => { f.side = -f.side; });
  root.querySelectorAll('[data-fx-mat]').forEach(s => s.onchange = () => edit('change fixture finish', () => { f[s.dataset.fxMat] = s.value || null; }, true));
  const src = root.querySelector('[data-fx-source]');
  if (src) src.onchange = () => edit('mark fixture source', () => { f.provenance = Object.assign({}, f.provenance, { source: src.value }); }, true);
  const product = () => f.product || (f.product = { brand: '', evidence: [], sources: [] });
  // The one trigger: a brand and model file the product in PRODUCTS, size the fixture from the
  // drawing's numbers when the record has them, and go looking for its documents once.
  const identify = () => {
    normaliseFixture(f, new Set(prop.levels.map(l => l.id)));
    const link = linkFixtureProduct(ws.data, prop, f, uid);
    if (link && !link.record.documents.length && !link.record.documentsSearchedAt) {
      link.record.documentsSearchedAt = new Date().toISOString();
      searchDocuments(link.record);
    }
  };
  const searchDocuments = async record => {
    const say = on.say || (() => {});
    try {
      const { findDocuments } = await import('./product-docs.js');
      const r = await findDocuments(prop, record, m => say(m));
      say(r.saved.length ? 'Saved ' + r.saved.length + ' document' + (r.saved.length === 1 ? '' : 's') + ' for ' + record.name + (r.failed.length ? '; ' + r.failed.length + ' could not be fetched' : '') : 'No documents could be fetched for ' + record.name + '. Add them by address.', r.saved.length ? 'ok' : 'warn');
      on.changed();
    } catch (e) { say(String(e && e.message || e), 'warn'); }
  };
  root.querySelectorAll('[data-fx-ptext]').forEach(input => input.onchange = () => edit('edit fixture product', () => {
    product()[input.dataset.fxPtext] = input.value.trim().slice(0, 80);
    identify();
  }, true));
  root.querySelectorAll('[data-fx-pconf]').forEach(sel => sel.onchange = () => edit('edit fixture product', () => { product()[sel.dataset.fxPconf] = sel.value; }, true));
  const record = productRecordFor(ws.data, f);
  const find = root.querySelector('[data-fx-finddocs]');
  if (find && record) find.onclick = () => { record.documentsSearchedAt = new Date().toISOString(); searchDocuments(record); };
  const adddoc = root.querySelector('[data-fx-adddoc]');
  if (adddoc && record) adddoc.onclick = async () => {
    const url = prompt('Web address of the spec sheet, installation guide or manual (PDF or image):');
    if (!url) return;
    try {
      const { fetchDocument, saveDocument } = await import('./product-docs.js');
      const { bytes, info } = await fetchDocument(url.trim());
      await saveDocument(prop, record, bytes, info);
      on.changed();
    } catch (e) { alert('Could not save the document: ' + (e && e.message || e)); }
  };
  root.querySelectorAll('[data-fx-dim]').forEach(input => input.onchange = () => {
    const v = input.value.trim() ? parseLen(input.value) : null;
    if (v !== null && !(v > 0)) { on.changed(); return; }
    edit('size from drawing', () => {
      record.dims = Object.assign({}, record.dims, { [input.dataset.fxDim]: v, source: (record.dims && record.dims.source) || { title: 'Entered from the drawing' } });
      normaliseProductRecord(record);
      applyRecordToFixtures(ws.data, record);
    }, true);
  });
  const setDetail = (k, v) => edit('edit fixture detail', () => { f.detail = Object.assign({}, f.detail, { [k]: v }); }, true);
  root.querySelectorAll('[data-fx-detail]').forEach(el => el.onchange = () => setDetail(el.dataset.fxDetail, el.type === 'checkbox' ? el.checked : el.value));
  root.querySelectorAll('[data-fx-detail-num]').forEach(el => el.onchange = () => { const v = parseFloat(el.value); if (Number.isFinite(v)) setDetail(el.dataset.fxDetailNum, v); });
  root.querySelectorAll('[data-fx-detail-len]').forEach(el => el.onchange = () => { const v = parseLen(el.value); if (Number.isFinite(v)) setDetail(el.dataset.fxDetailLen, v); });
  const circuits = root.querySelector('[data-fx-circuits]');
  if (circuits) circuits.onchange = () => setDetail('circuits', parseCircuits(circuits.value));
  const turn = root.querySelector('[data-fx-turn]');
  if (turn) turn.onclick = () => edit('turn product model', () => { f.product.asset.turn = ((f.product.asset.turn || 0) + 90) % 360; }, true);
  const unmodel = root.querySelector('[data-fx-unmodel]');
  if (unmodel) unmodel.onclick = () => edit('remove product model', () => { f.product.asset = null; }, true);
  const usesize = root.querySelector('[data-fx-usesize]');
  if (usesize) usesize.onclick = () => edit('use product size', () => { [f.w, f.d, f.h] = productFit(f).size.map(v => Math.round(v * 1e4) / 1e4); });
  const pick = root.querySelector('[data-fx-model]');
  if (pick) pick.onchange = async () => {
    const file = pick.files && pick.files[0];
    if (!file) return;
    try {
      const { attachProductModel } = await import('./fixture-products.js');
      await attachProductModel(prop, f, file);
      f.roomId = roomOfFixture(prop.rooms, f);
      on.changed();
    } catch (e) { alert('Could not attach ' + file.name + ': ' + (e && e.message || e)); }
  };
  root.querySelector('[data-fx-del]').onclick = () => {
    beginGeometryEdit(prop, 'delete fixture');
    prop.fixtures = prop.fixtures.filter(x => x.id !== f.id);
    touch(); on.deleted();
  };
}
