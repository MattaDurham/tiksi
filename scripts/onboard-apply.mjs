#!/usr/bin/env node
// Write onboarding's product findings into a Tiksi project file (ONBOARDING.md): each
// fixture's brand and model with how sure they are, the evidence and sources, the documents
// saved in the project folder (scripts/onboard-media.py fetch-docs), the drawing's dimensions
// and detail numbers, and the real product's 3D model (a GLB, fitted to the measured box).
// It uses the app's own rules (fixtures.js, product-records.js), so a confirmed brand without
// evidence that reads it is stored as likely, exactly as in the app.
//
//   node scripts/onboard-apply.mjs --project in.tiksi --findings findings.json --out out.tiksi
//
// findings.json:
//   { "property": "<id or name, optional>", "checkedAt": "2026-11-02",
//     "fixtures": [{
//       "fixture": "<fixture id>" | "match": { "subtype": "dishwasher", "room": "Kitchen" }
//         | "create": { "kind": "fitting", "subtype": "panel", "level": "<id>", "x": 1, "y": 2, "rot": 90, "w": .., "d": .., "h": .., "y0": .. },
//       "brand": "Frigidaire", "brandConfidence": "confirmed", "model": "FFBD2412SS", "modelConfidence": "likely",
//       "evidence": [{ "media": "IMG_5782.MOV", "at": 213.4, "reads": ["brand"], "note": "logo on the control strip" }],
//       "sources": [{ "url": "https://...", "title": "..." }],
//       "detail": { "kick": 0.11 },
//       "dims": { "w": 0.6, "d": 0.62, "h": 0.86, "source": { "title": "Installation guide p. 4", "url": "https://..." } },
//       "documents": [ <entries printed by onboard-media.py fetch-docs> ],
//       "model3d": { "glb": "model.glb", "source": "original.skp", "origin": "https://3dwarehouse...", "originName": "SketchUp 3D Warehouse", "license": "...", "turn": 0 },
//       "assetNote": "Searched 3D Warehouse, BIMobject and the manufacturer: no model" }] }
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { basename, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { unzipSync, zipSync, strFromU8, strToU8 } = await import(resolve(ROOT, 'vendor/addons/libs/fflate.module.js'));
const fx = await import(resolve(ROOT, 'js/fixtures.js'));
const pr = await import(resolve(ROOT, 'js/product-records.js'));

export const newId = prefix => prefix + '-' + randomBytes(5).toString('hex');

// Bounds of a GLB's meshes in its own coordinates: accessor min/max carried through the node tree.
export function glbBounds(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('not a GLB file');
  const len = dv.getUint32(12, true);
  if (dv.getUint32(16, true) !== 0x4e4f534a) throw new Error('GLB has no JSON chunk');
  const doc = JSON.parse(new TextDecoder().decode(u8.subarray(20, 20 + len)));
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  const mul = (a, b) => { const o = new Array(16).fill(0); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]; return o; };
  const trs = n => {
    if (n.matrix) return n.matrix;
    const [x, y, z, w] = n.rotation || [0, 0, 0, 1], [sx, sy, sz] = n.scale || [1, 1, 1], t = n.translation || [0, 0, 0];
    return [(1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0, 2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
      2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0, t[0], t[1], t[2], 1];
  };
  const visit = (i, parent, depth) => {
    if (depth > 64) throw new Error('GLB node tree too deep');
    const n = doc.nodes[i], m = mul(parent, trs(n));
    for (const prim of (n.mesh != null ? doc.meshes[n.mesh].primitives : [])) {
      const acc = doc.accessors[prim.attributes.POSITION];
      if (!acc || !acc.min || !acc.max) continue;
      for (const X of [acc.min[0], acc.max[0]]) for (const Y of [acc.min[1], acc.max[1]]) for (const Z of [acc.min[2], acc.max[2]]) {
        const p = [m[0] * X + m[4] * Y + m[8] * Z + m[12], m[1] * X + m[5] * Y + m[9] * Z + m[13], m[2] * X + m[6] * Y + m[10] * Z + m[14]];
        for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
      }
    }
    for (const c of n.children || []) visit(c, m, depth + 1);
  };
  const scene = doc.scenes ? doc.scenes[doc.scene || 0] : { nodes: (doc.nodes || []).map((_, i) => i) };
  for (const i of scene.nodes || []) visit(i, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 0);
  if (!(hi[0] > lo[0])) throw new Error('GLB has no measurable geometry');
  return { min: lo, max: hi };
}

function findFixture(prop, finding) {
  if (finding.fixture) return (prop.fixtures || []).find(f => f.id === finding.fixture) || null;
  if (finding.match) {
    const room = finding.match.room && (prop.rooms || []).find(r => String(r.name).toLowerCase() === String(finding.match.room).toLowerCase());
    return (prop.fixtures || []).find(f => f.subtype === finding.match.subtype && (!room || fx.roomOfFixture(prop.rooms, f) === room.id)) || null;
  }
  return null;
}

// Apply findings to a parsed project (workspace data + files). Returns the report; mutates.
export function applyFindings(data, files, manifest, findings, readFile = p => readFileSync(p)) {
  const prop = findings.property ? data.properties.find(p => p.id === findings.property || p.name === findings.property) : data.properties[0];
  if (!prop) throw new Error('No property ' + findings.property + ' in this project');
  data.products = data.products || [];
  const levels = new Set((prop.levels || []).map(l => l.id)), report = [];
  for (const finding of findings.fixtures || []) {
    let f = findFixture(prop, finding);
    if (!f && finding.create) {
      const c = finding.create;
      f = Object.assign(fx.fixtureTemplate(c.kind, c.subtype, { level: c.level || (prop.levels[0] || {}).id, x: c.x, y: c.y, rot: c.rot }), c, { id: newId('fx') });
      f.provenance = { source: 'user', confidence: null, evidence: 'Placed during onboarding' };
      prop.fixtures = prop.fixtures || [];
      prop.fixtures.push(f);
    }
    if (!f) { report.push({ finding: finding.fixture || finding.match, error: 'no such fixture; give "create" to place one' }); continue; }
    const p = Object.assign({}, f.product, {
      brand: finding.brand || '', brandConfidence: finding.brandConfidence, model: finding.model || '', modelConfidence: finding.modelConfidence,
      evidence: finding.evidence || [], sources: finding.sources || [], assetNote: finding.assetNote || '', checkedAt: finding.checkedAt || findings.checkedAt || '' });
    if (finding.model3d) {
      const m = finding.model3d, glb = new Uint8Array(readFile(m.glb));
      const bounds = glbBounds(glb), sha = createHash('sha256').update(glb).digest('hex');
      const fileId = 'product-' + sha.slice(0, 16);
      if (!files[fileId]) files[fileId] = { bytes: glb, entry: { id: fileId, kind: 'product', path: 'files/' + fileId + '.glb', name: basename(m.glb), format: 'glb', size: glb.length } };
      let sourceFileId = null;
      if (m.source) {
        const src = new Uint8Array(readFile(m.source)), ssha = createHash('sha256').update(src).digest('hex'), ext = extname(m.source).slice(1).toLowerCase() || 'bin';
        sourceFileId = 'source-' + ssha.slice(0, 16);
        if (!files[sourceFileId]) files[sourceFileId] = { bytes: src, entry: { id: sourceFileId, kind: 'source', path: 'files/' + sourceFileId + '.' + ext, name: basename(m.source), format: ext, size: src.length } };
      }
      p.asset = { fileId, format: 'glb', name: basename(m.source || m.glb), sourceFileId, sourceName: m.source ? basename(m.source) : '', origin: m.origin || '', originName: m.originName || '', license: m.license || '', turn: m.turn || 0, bounds };
    }
    f.product = p;
    if (finding.detail) f.detail = Object.assign({}, f.detail, finding.detail);
    fx.normaliseFixture(f, levels);
    const link = pr.linkFixtureProduct(data, prop, f, newId);
    const out = { fixture: f.id, label: fx.fixtureLabel(f), product: fx.productLabel(f), confidence: fx.productConfidenceText(f.product) };
    if (link) {
      const record = link.record;
      record.documents = [...(record.documents || []), ...(finding.documents || [])];
      if (finding.dims) record.dims = Object.assign({}, record.dims, finding.dims);
      if (!record.url && f.product.sources[0]) record.url = f.product.sources[0].url;
      record.fixtureSubtype = f.subtype || null;
      pr.normaliseProductRecord(record);
      pr.applyRecordToFixtures(data, record);
      Object.assign(out, { productRecord: record.id, created: link.created, documents: record.documents.length, dims: record.dims || null });
    }
    const fit = fx.productFit(f);
    if (fit) out.modelFit = { scale: fit.scale.map(v => Math.round(v * 1000) / 1000), warning: fit.off > 0.1 ? 'the model is ' + Math.round(fit.off * 100) + '% off the measured box: check the model, its units or the measurement' : null };
    report.push(out);
  }
  return report;
}

function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!['--project', '--findings', '--out'].includes(k)) throw new Error('unknown option ' + k + ' (use --project, --findings, --out)');
    args[k.slice(2)] = argv[++i];
  }
  if (!args.project || !args.findings || !args.out) throw new Error('usage: onboard-apply.mjs --project in.tiksi --findings findings.json --out out.tiksi');
  if (resolve(args.out) === resolve(args.project)) throw new Error('write to a new file; compare it, then replace the original yourself');
  const zipped = unzipSync(new Uint8Array(readFileSync(args.project)));
  const data = JSON.parse(strFromU8(zipped['workspace.json']));
  const manifest = zipped['manifest.json'] ? JSON.parse(strFromU8(zipped['manifest.json'])) : { format: 'tiksi-project', version: 1, app: 'tiksi', files: [] };
  const findings = JSON.parse(readFileSync(args.findings, 'utf8'));
  const base = dirname(resolve(args.findings));
  const files = {};
  const report = applyFindings(data, files, manifest, findings, p => readFileSync(resolve(base, p)));
  const entries = {};
  for (const [name, bytes] of Object.entries(zipped)) if (name !== 'workspace.json' && name !== 'manifest.json') entries[name] = [bytes, { level: 0 }];
  for (const { bytes, entry } of Object.values(files)) {
    if (!manifest.files.some(e => e.id === entry.id)) manifest.files.push(entry);
    entries[entry.path] = [bytes, { level: 0 }];
  }
  entries['workspace.json'] = [strToU8(JSON.stringify(data, null, 1)), { level: 6 }];
  entries['manifest.json'] = [strToU8(JSON.stringify(manifest, null, 1)), { level: 6 }];
  const tmp = args.out + '.tmp';
  writeFileSync(tmp, zipSync(entries));
  renameSync(tmp, args.out);
  console.log(JSON.stringify({ out: args.out, fixtures: report }, null, 1));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(1); }
}
