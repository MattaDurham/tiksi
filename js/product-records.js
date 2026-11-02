// The installed product behind a fixture, as a PRODUCTS record (ws.data.products): brand,
// model, category, the documents saved for it (spec sheet, installation drawing, owner's
// manual) and the dimensions read off them. Pure functions, shared by the inspector, the
// onboarding scripts' Node tests and the workspace loader.
//
// One trigger for both ways a product gets an identity (onboarding's brand pass, or someone
// typing the brand and model): linkFixtureProduct finds or creates the record and links the
// fixture to it; the record's dimensions then size every fixture linked to it
// (applyRecordToFixtures), so the geometry is rebuilt whenever the identity or the numbers
// change, in MODEL and in the SketchUp mirror alike.
//
// documents: [{ kind, title, path (inside the project's folder), fileId (when kept in the
//   project file instead), url (where it came from), sha256, bytes, mime, fetchedAt }]
// dims: { w, d, h (metres, as the drawing gives them: depth including handles), detail
//   (fixture-detail.js numbers: kick height, freezer split...), source: { title, url, page } }

import { publicUrl, normaliseFixture } from './fixtures.js';
import { normaliseDetail } from './fixture-detail.js';

export const DOC_KINDS = ['spec-sheet', 'installation', 'manual', 'drawing', 'warranty', 'other'];
export const DOC_LABEL = { 'spec-sheet': 'Spec sheet', installation: 'Installation guide', manual: "Owner's manual", drawing: 'Dimension drawing', warranty: 'Warranty', other: 'Document' };
const text = (v, n) => typeof v === 'string' ? v.trim().slice(0, n) : '';
const HEX64 = /^[a-f0-9]{64}$/;
const ID = /^[\w.:-]{1,80}$/;

// Which kind a document is, from its title or address.
export function documentKind(title, url) {
  const s = (String(title || '') + ' ' + String(url || '')).toLowerCase();
  if (/install|installation|\binst\b|\bii\b/.test(s)) return 'installation';
  if (/dimension|drawing|cad|cut ?sheet|cutout|schematic/.test(s)) return 'drawing';
  if (/spec|data ?sheet|product ?sheet|product ?info|specification/.test(s)) return 'spec-sheet';
  if (/manual|use[\s_-]*(and|&)[\s_-]*care|owner|user[\s_-]*guide/.test(s)) return 'manual';
  if (/warrant/.test(s)) return 'warranty';
  return 'other';
}

export function normaliseDocument(d) {
  if (!d || typeof d !== 'object') return null;
  const path = text(d.path, 400).replace(/\\/g, '/');
  if (path && (path.startsWith('/') || path.split('/').includes('..'))) return null;
  const fileId = typeof d.fileId === 'string' && ID.test(d.fileId) ? d.fileId : null;
  const url = publicUrl(d.url) || '';
  if (!path && !fileId && !url) return null;
  return { kind: DOC_KINDS.includes(d.kind) ? d.kind : documentKind(d.title, d.url), title: text(d.title, 200), path, fileId, url,
    sha256: typeof d.sha256 === 'string' && HEX64.test(d.sha256) ? d.sha256 : '', bytes: Number.isFinite(d.bytes) && d.bytes >= 0 ? Math.round(d.bytes) : null,
    mime: text(d.mime, 80), fetchedAt: text(d.fetchedAt, 40) };
}

export function normaliseDims(dims, subtype) {
  if (!dims || typeof dims !== 'object') return null;
  const m = v => Number.isFinite(v) && v > 0.005 && v < 20 ? Math.round(v * 1e4) / 1e4 : null;
  const out = { w: m(dims.w), d: m(dims.d), h: m(dims.h), detail: null, source: null };
  if (dims.detail && typeof dims.detail === 'object') out.detail = subtype ? normaliseDetail(subtype, dims.detail) || null : { ...dims.detail };
  const s = dims.source;
  if (s && typeof s === 'object') out.source = { title: text(s.title, 200), url: publicUrl(s.url) || '', page: Number.isInteger(s.page) && s.page > 0 ? s.page : null };
  return out.w || out.d || out.h || out.detail ? out : null;
}

// A PRODUCTS record with its documents and dimensions in shape (other fields untouched).
export function normaliseProductRecord(pr) {
  if (!pr || typeof pr !== 'object') return pr;
  const seen = new Set();
  pr.documents = (Array.isArray(pr.documents) ? pr.documents : []).map(normaliseDocument).filter(d => {
    if (!d) return false;
    const key = d.sha256 || d.path || d.fileId || d.url;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).slice(0, 60);
  const dims = normaliseDims(pr.dims, typeof pr.fixtureSubtype === 'string' ? pr.fixtureSubtype : null);
  if (dims) pr.dims = dims; else delete pr.dims;
  return pr;
}

const CATEGORY = { appliance: 'appliance', bath: 'plumbing', furniture: 'other', 'base-run': 'cabinetry', 'wall-run': 'cabinetry' };
const FITTING_CATEGORY = { faucet: 'plumbing', 'shower-trim': 'plumbing', shutoff: 'plumbing', drain: 'plumbing', panel: 'electrical', light: 'lighting',
  thermostat: 'hvac', 'line-set': 'hvac', vent: 'hvac', 'outdoor-unit': 'hvac' };
export function fixtureCategory(f) {
  if (f.subtype === 'mini-split' || f.subtype === 'water-heater') return f.subtype === 'mini-split' ? 'hvac' : 'plumbing';
  return f.kind === 'fitting' ? FITTING_CATEGORY[f.subtype] || 'other' : CATEGORY[f.kind] || 'other';
}

const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

// The PRODUCTS record a fixture's product is, by link or by brand and model.
export function productRecordFor(data, f) {
  const p = f && f.product;
  if (!p || !data || !Array.isArray(data.products)) return null;
  if (p.productId) { const byId = data.products.find(r => r.id === p.productId); if (byId) return byId; }
  if (!p.brand || !p.model) return null;
  return data.products.find(r => same(r.brand, p.brand) && same(r.model, p.model)) || null;
}

// The one trigger: a fixture whose product now has a brand and model gets a PRODUCTS record
// (found or made) and is linked to it; the record's dimensions, if any, size the fixture.
// `newId` makes ids. Returns { record, created, resized } or null when there is no identity.
export function linkFixtureProduct(data, prop, f, newId) {
  const p = f && f.product;
  if (!p || !p.brand || !p.model) { if (p) delete p.productId; return null; }
  let record = productRecordFor(data, f), created = false;
  if (record && !(same(record.brand, p.brand) && same(record.model, p.model))) record = null;    // the identity changed
  if (!record) {
    record = { id: newId('prod'), name: [p.brand, p.model].join(' '), brand: p.brand, model: p.model, category: fixtureCategory(f),
      url: (p.sources[0] || {}).url || '', price: 0, unit: 'ea', imageUrl: '', specs: '', notes: '', itemIds: [], documents: [], fixtureSubtype: f.subtype || null };
    data.products.push(record);
    created = true;
  }
  p.productId = record.id;
  const resized = applyDims(f, record, prop);
  return { record, created, resized };
}

// Size a box fixture to the drawing: width and depth about its back face (the wall side stays
// where the scan or tape put it), height from its bottom; the drawing's detail numbers merge
// into the fixture's. Returns true when anything changed.
function applyDims(f, record, prop) {
  const dims = record && record.dims;
  if (!dims || !Number.isFinite(f.w)) return false;
  const before = JSON.stringify([f.x, f.y, f.w, f.d, f.h, f.detail]);
  const a = (f.rot || 0) * Math.PI / 180, nv = [-Math.sin(a), Math.cos(a)];
  if (dims.d) { const shift = (f.d - dims.d) / 2; f.x += nv[0] * shift; f.y += nv[1] * shift; f.d = dims.d; }
  if (dims.w) f.w = dims.w;
  if (dims.h) f.h = dims.h;
  if (dims.detail) f.detail = Object.assign({}, f.detail, dims.detail);
  normaliseFixture(f, prop ? new Set((prop.levels || []).map(l => l.id)) : null);
  const changed = before !== JSON.stringify([f.x, f.y, f.w, f.d, f.h, f.detail]);
  if (changed) f.product.dimsFrom = dims.source && (dims.source.title || dims.source.url) || 'product record';
  return changed;
}

// A record's dimensions changed: resize every fixture linked to it, in every property.
// Returns the fixtures that changed.
export function applyRecordToFixtures(data, record) {
  const changed = [];
  for (const prop of data.properties || []) for (const f of prop.fixtures || []) {
    if (f.product && f.product.productId === record.id && applyDims(f, record, prop)) changed.push(f);
  }
  return changed;
}

// Where a product's documents go in the project's folder: "Product documents/<Brand Model>".
export function documentFolderName(record) {
  const name = [record.brand, record.model].filter(Boolean).join(' ') || record.name || 'Product';
  return 'Product documents/' + name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80);
}

// The SOURCE.txt written beside each download: what it is, where it came from, its checksum.
export function sourceNote(record, doc) {
  return [
    (DOC_LABEL[doc.kind] || 'Document') + ': ' + (doc.title || doc.path.split('/').pop()),
    'Product: ' + [record.brand, record.model].filter(Boolean).join(' '),
    'Source: ' + doc.url,
    'Fetched: ' + doc.fetchedAt,
    'SHA-256: ' + doc.sha256,
    'Bytes: ' + doc.bytes,
    '',
  ].join('\n');
}

// Overall dimensions from research facts ({ name, value }): "Width 23 7/8 in", "Depth: 610 mm".
export function dimsFromFacts(facts) {
  const out = {};
  for (const f of facts || []) {
    const name = String(f && f.name || '').toLowerCase(), value = String(f && f.value || '');
    const key = /\bwidth\b/.test(name) ? 'w' : /\bdepth\b/.test(name) ? 'd' : /\bheight\b/.test(name) ? 'h' : null;
    if (!key || out[key] || /(door open|cutout|opening|cavity|interior|packag|shipping|carton)/.test(name)) continue;
    const m = parseLength(value);
    if (m) out[key] = m;
  }
  return out.w || out.d || out.h ? out : null;
}

// A length in metres from "23 7/8 in", "23.875\"", "60.6 cm", "606 mm", "2 ft 1 in"; null if unreadable.
export function parseLength(s) {
  const t = String(s).replace(/″|''/g, '"').replace(/′/g, "'").toLowerCase();
  let m = /(\d+(?:\.\d+)?)\s*mm\b/.exec(t);
  if (m) return +m[1] / 1000;
  if ((m = /(\d+(?:\.\d+)?)\s*cm\b/.exec(t))) return +m[1] / 100;
  const ft = /(\d+(?:\.\d+)?)\s*(?:ft|feet|')/.exec(t);
  const inch = /(\d+(?:\.\d+)?)(?:[\s-]+(\d+)\s*\/\s*(\d+))?\s*(?:in\b|inch|inches|")/.exec(t);
  if (!ft && !inch) return null;
  const inches = (ft ? +ft[1] * 12 : 0) + (inch ? +inch[1] + (inch[2] ? +inch[2] / +inch[3] : 0) : 0);
  return inches > 0 ? Math.round(inches * 0.0254 * 1e4) / 1e4 : null;
}
