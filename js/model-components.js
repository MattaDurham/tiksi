// An imported model's components, the SketchUp way. server/sketchup_convert.py writes each
// component definition's geometry once and each instance as a glTF node whose extras name the
// definition (sketchupComponent, sketchupDefinitionId, sketchupInstance...). Nested instances are
// nodes under nodes, so a cabinet placed 8 times with 4 hinges of 6 screws each is drawn as 8
// cabinets, 32 hinges and 192 screws, and that is what is counted.
//
// Identity is the definition, never the name: two faucets that look alike but were defined
// separately are two components. The key is the definition's SketchUp GUID ('def:<guid>'),
// which stays the same when the same SKP is converted again, so product links and counts
// survive a reconversion.
//
// A component can be linked to a PRODUCTS record (ws.data.products): scan.componentProducts[key]
// = { productId, brand, model, name, ...evidence }. Inline evidence stays with the component
// even when its optional product record is absent; it is not a priced product. Pure: no DOM.

import { safeUrl } from './material-identity.js';

const ID_OK = /^[\w.:-]{1,80}$/;
const text = (v, n) => typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '';
const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

export function isInstanceNode(o) {
  const u = o && o.userData;
  return !!(u && typeof u.sketchupComponent === 'string' && u.sketchupComponent);
}
export function componentKeyOf(o) {
  const u = o.userData;
  return typeof u.sketchupDefinitionId === 'string' && u.sketchupDefinitionId ? 'def:' + u.sketchupDefinitionId : 'name:' + u.sketchupComponent;
}
// The instance a part belongs to: the innermost instance node around it, below the model's root.
export function instanceOf(object, root) {
  for (let o = object; o && o !== root; o = o.parent) {
    if (isInstanceNode(o)) return o;
    if (o.userData && o.userData.inner === o) break;
  }
  return null;
}
// Every instance around a part, innermost first (a screw, its hinge, its cabinet).
export function instanceChain(object, root) {
  const out = [];
  for (let o = object; o && o !== root; o = o.parent) {
    if (o.userData && o.userData.inner === o) break;
    if (isInstanceNode(o)) out.push(o);
  }
  return out;
}

// Does the model say it was converted with components (a converter from before this did not)?
export function convertedWithComponents(root) {
  let yes = false;
  root.traverse(o => { if (!yes && o.userData && (o.userData.sketchupComponents || isInstanceNode(o))) yes = true; });
  return yes;
}

// The model's component definitions: [{ key, name, definitionId, description, count (instances
// drawn, multiplied through the nesting), instances (their nodes), parts (meshes drawn by them,
// nested ones included), parents (keys of the components it sits in), contains: { key: count per
// one instance } }], sorted by name. Unique groups are not components.
export function modelComponents(root) {
  if (!root) return [];
  const byKey = new Map();
  root.traverse(o => {
    if (!isInstanceNode(o)) return;
    const key = componentKeyOf(o);
    let c = byKey.get(key);
    if (!c) {
      const u = o.userData;
      c = { key, name: u.sketchupComponent, definitionId: u.sketchupDefinitionId || '', description: typeof u.sketchupDescription === 'string' ? u.sketchupDescription : '',
        count: 0, instances: [], parts: [], parents: new Set(), contains: {} };
      byKey.set(key, c);
    }
    c.count++;
    c.instances.push(o);
    o.traverse(m => { if (m.isMesh) c.parts.push(m); });
    const outer = instanceOf(o.parent, root);
    if (outer) c.parents.add(componentKeyOf(outer));
  });
  // What one instance of each holds directly (the first instance stands for the definition).
  for (const c of byKey.values()) {
    const first = c.instances[0];
    first.traverse(o => {
      if (o === first || !isInstanceNode(o) || instanceOf(o.parent, root) !== first) return;
      const k = componentKeyOf(o);
      c.contains[k] = (c.contains[k] || 0) + 1;
    });
  }
  return [...byKey.values()].map(c => ({ ...c, parents: [...c.parents] })).sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}

// ---------- products ----------
export function normalizeComponentProduct(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  const out = { productId: typeof p.productId === 'string' && ID_OK.test(p.productId) ? p.productId : null, brand: text(p.brand, 120), model: text(p.model, 120), name: text(p.name, 200) };
  for (const [field, limit] of [['status', 120], ['evidence', 4000], ['uncertainty', 4000]]) {
    const value = text(p[field], limit);
    if (value) out[field] = value;
  }
  const url = safeUrl(p.url);
  if (url) out.url = url;
  if (Array.isArray(p.documents)) {
    const documents = [...new Set(p.documents.slice(0, 32).map(v => text(v, 500)).filter(Boolean))];
    if (documents.length) out.documents = documents;
  }
  if (typeof p.dims_mm === 'string') {
    const value = text(p.dims_mm, 1000);
    if (value) out.dims_mm = value;
  } else if (p.dims_mm && typeof p.dims_mm === 'object' && !Array.isArray(p.dims_mm)) {
    const entries = Object.entries(p.dims_mm).slice(0, 32).flatMap(([key, value]) => {
      const name = text(key, 80);
      if (!name || ['__proto__', 'constructor', 'prototype'].includes(name)) return [];
      if (typeof value === 'number' && Number.isFinite(value)) return [[name, value]];
      const description = text(value, 300);
      return description ? [[name, description]] : [];
    });
    if (entries.length) out.dims_mm = Object.fromEntries(entries);
  }
  return out.productId || out.brand || out.model || out.name || out.status || out.evidence || out.uncertainty || out.dims_mm || out.documents || out.url ? out : null;
}

export function componentProductEvidence(scan, key) {
  return normalizeComponentProduct(scan && scan.componentProducts && scan.componentProducts[key]);
}

export function componentIdentityStatus(p) {
  const status = text(p && p.status, 120);
  const labels = { identified: 'Identified', likely: 'Likely match', 'proposed-match': 'Proposed match',
    'as-scanned': 'Observed geometry; product identity unverified', 'observed-type': 'Observed type; maker and model unverified',
    unidentified: 'Unidentified' };
  return Object.hasOwn(labels, status) ? labels[status] : status || 'Identification not verified';
}
export function componentProductRecord(data, scan, key) {
  const p = scan && scan.componentProducts && scan.componentProducts[key];
  if (!p || !data || !Array.isArray(data.products)) return null;
  if (p.productId) { const r = data.products.find(x => x.id === p.productId); if (r) return r; }
  if (!p.brand || !p.model) return null;
  return data.products.find(r => same(r.brand, p.brand) && same(r.model, p.model)) || null;
}

// Link a component definition to a product: an existing PRODUCTS record by id, or the one its
// maker and model number name (found, else made). The record is kept with the property, so it
// travels in the project file. Returns { record, created }.
export function linkComponentProduct(data, prop, scan, component, fields, newId) {
  let record = null, created = false;
  if (fields.productId) {
    record = data.products.find(r => r.id === fields.productId) || null;
    if (!record) throw new Error('That product is not in the products list.');
  } else {
    const brand = text(fields.brand, 120), model = text(fields.model, 120);
    if (!brand || !model) throw new Error('Give the maker and the model number, or choose a product from the list.');
    record = data.products.find(r => same(r.brand, brand) && same(r.model, model)) || null;
    if (!record) {
      record = { id: newId('prod'), name: text(fields.name, 200) || [brand, model].join(' '), brand, model, category: text(fields.category, 40) || 'other',
        url: '', manufacturerUrl: '', price: 0, unit: 'ea', imageUrl: '', specs: '', itemIds: [],
        notes: 'Component "' + component.name + '" in the model ' + (scan.name || '') + '.' };
      data.products.push(record);
      created = true;
    }
  }
  if (prop) { record.propertyIds = Array.isArray(record.propertyIds) ? record.propertyIds : []; if (!record.propertyIds.includes(prop.id)) record.propertyIds.push(prop.id); }
  const previous = componentProductEvidence(scan, component.key);
  const sameIdentity = previous && (previous.productId === record.id ||
    (previous.brand && previous.model && same(previous.brand, record.brand) && same(previous.model, record.model)));
  scan.componentProducts = scan.componentProducts || {};
  scan.componentProducts[component.key] = normalizeComponentProduct({ ...(sameIdentity ? previous : {}), productId: record.id, brand: record.brand, model: record.model, name: component.name });
  return { record, created };
}
export function unlinkComponentProduct(scan, key) {
  if (scan && scan.componentProducts) delete scan.componentProducts[key];
}

// ---------- schedule ----------
const unitPrice = r => r && Number.isFinite(+r.price) && +r.price > 0 ? +r.price : 0;
const perEach = r => !r || !r.unit || ['ea', 'each', 'unit', 'pc', 'pcs'].includes(String(r.unit).toLowerCase());

// One row per component definition of a model: total drawn count, linked product, unit price
// (from the products list, only when it is priced per each) and extended cost.
export function componentSchedule(data, scan, root) {
  return modelComponents(root).map(c => {
    const record = componentProductRecord(data, scan, c.key);
    const priced = record && perEach(record) ? unitPrice(record) : 0;
    return { key: c.key, name: c.name, count: c.count, contains: c.contains, parents: c.parents, scanId: scan.id, model: scan.name || '',
      productId: record ? record.id : null, brand: record ? record.brand || '' : '', productModel: record ? record.model || '' : '', product: record ? record.name || '' : '',
      unit: record ? record.unit || 'ea' : 'ea', unitPrice: priced, extended: priced * c.count, priceNote: record && !perEach(record) ? 'Priced per ' + record.unit + ', not each' : '' };
  });
}

// The property's schedule across its loaded models: rows of one linked product add up, since
// the same product in two models is the same thing to order; unlinked components stay per model.
export function propertyComponentSchedule(data, models) {
  const rows = new Map();
  for (const { scan, root } of models) for (const r of componentSchedule(data, scan, root)) {
    const key = r.productId ? 'prod:' + r.productId : scan.id + '|' + r.key;
    const row = rows.get(key);
    if (!row) { rows.set(key, { ...r, models: [r.model] }); continue; }
    row.count += r.count; row.extended = row.unitPrice * row.count;
    if (!row.models.includes(r.model)) row.models.push(r.model);
  }
  return [...rows.values()].sort((a, b) => b.extended - a.extended || a.name.localeCompare(b.name));
}

// ---------- reconverting a model converted before components were kept ----------
// Tags are stored per part path, and a reconverted file has new paths. Each old tagged part
// hands its tag to the new parts with its name and file tag that sit inside its bounds.
// `oldParts` / `newParts`: [{ key, name, fileTag, box (world THREE.Box3) }]. Returns
// { assigned: { newKey: tagId }, matched, unmatched }.
export function carryPartTags(tagOf, oldParts, newParts) {
  const assigned = {};
  let matched = 0;
  const volume = b => Math.max(0, b.max.x - b.min.x) * Math.max(0, b.max.y - b.min.y) * Math.max(0, b.max.z - b.min.z);
  for (const np of newParts) {
    const c = np.box.getCenter(np.box.min.clone());
    let best = null;
    for (const op of oldParts) {
      if (!(op.key in tagOf) || op.name !== np.name || (op.fileTag || '') !== (np.fileTag || '')) continue;
      const b = op.box, e = 0.01;
      if (c.x < b.min.x - e || c.x > b.max.x + e || c.y < b.min.y - e || c.y > b.max.y + e || c.z < b.min.z - e || c.z > b.max.z + e) continue;
      if (!best || volume(b) < volume(best.box)) best = op;
    }
    if (best) { assigned[np.key] = tagOf[best.key]; matched++; }
  }
  return { assigned, matched, unmatched: newParts.length - matched };
}
