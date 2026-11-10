// Fixtures in the console: propose them from a scan (scan-fixtures.js in a worker), review
// the proposals one by one, add one by hand, and edit a selected one in the inspector. Every
// change goes through the shared geometry history, so Undo and Redo cover fixtures too.

import { uid, touch, fmtLen, parseLen, escapeHtml, getFile, levelById, levelHeight, wallsOn } from './store.js';
import { beginGeometryEdit } from './edit-history.js';
import { FIXTURE_KINDS, fixtureLabel, fixtureShape, fixtureTemplate, normaliseFixture, runLength, roomOfFixture } from './fixtures.js';
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
    // A helper that dies is reported, not rerun here, where the same job would freeze the page.
    worker.onerror = e => { if (e && e.preventDefault) e.preventDefault(); if (settled) return; settled = true; worker.terminate(); reject(new Error('Fixture detection stopped' + (e && e.message ? ' (' + e.message + ')' : '') + '. The scan may be too large for this browser.')); };
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
    <button class="btn danger" data-fx-del>DELETE FIXTURE</button>`;
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
  root.querySelector('[data-fx-del]').onclick = () => {
    beginGeometryEdit(prop, 'delete fixture');
    prop.fixtures = prop.fixtures.filter(x => x.id !== f.id);
    touch(); on.deleted();
  };
}
