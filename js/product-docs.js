// Product documents for an identified fixture: the manufacturer's spec sheet, installation
// guide (with its dimension drawing) and owner's manual, then retailers' copies. They are
// fetched through the local server (server/product_docs.py), saved in the project's folder
// under "Product documents/<Brand Model>/" with a SOURCE.txt beside each, and listed on the
// PRODUCTS record (product-records.js). Without a project folder they are kept inside the
// project file instead.
//
// FIND DOCUMENTS asks the local research service (server/material_research.py) for the
// documents and overall dimensions; it returns cited addresses and facts, which are fetched
// and applied here. Nothing is bought, submitted or signed in to.

import { ws, uid, touch, putFile } from './store.js';
import { projectFolderHandles } from './files.js';
import { normaliseDocument, normaliseProductRecord, documentFolderName, sourceNote, documentKind, dimsFromFacts, applyRecordToFixtures, DOC_LABEL } from './product-records.js';

let caps = null;
async function capabilities() {
  if (caps) return caps;
  const r = await fetch('/api/product-docs/capabilities', { headers: { 'X-Tiksi-Docs': '1' } });
  if (!r.ok || !(r.headers.get('content-type') || '').includes('json')) throw new Error('Fetching documents needs the Tiksi local server');
  return (caps = await r.json());
}

export async function fetchDocument(url) {
  const cap = await capabilities();
  const r = await fetch('/api/product-docs/fetch', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tiksi-Docs': '1', 'X-Tiksi-Token': cap.token }, body: JSON.stringify({ url }) });
  if (r.status === 403) caps = null;
  if (!r.ok) { let e = 'HTTP ' + r.status; try { e = (await r.json()).error || e; } catch (x) { /* not JSON */ } throw new Error(e); }
  return { bytes: new Uint8Array(await r.arrayBuffer()), info: JSON.parse(r.headers.get('X-Document-Info') || '{}') };
}

async function dirAt(root, path) {
  let dir = root;
  for (const part of path.split('/').filter(Boolean)) dir = await dir.getDirectoryHandle(part, { create: true });
  return dir;
}
async function writeFile(dir, name, bytes) {
  const handle = await dir.getFileHandle(name, { create: true });
  const out = await handle.createWritable();
  await out.write(bytes); await out.close();
}

// Save one fetched document for `record`, in the project's folder when it has one. Returns
// the document entry (already on the record), or the existing entry for the same bytes.
export async function saveDocument(prop, record, bytes, info, meta = {}) {
  normaliseProductRecord(record);
  const dup = record.documents.find(d => d.sha256 && d.sha256 === info.sha256);
  if (dup) return dup;
  const doc = { kind: meta.kind || documentKind(meta.title || info.filename, info.url), title: meta.title || info.filename, url: info.url, sha256: info.sha256,
    bytes: info.bytes, mime: info.mime, fetchedAt: new Date().toISOString(), path: '', fileId: null };
  const folder = projectFolderHandles(prop.id);
  if (folder) {
    const sub = documentFolderName(record), dir = await dirAt(folder.root, sub);
    let name = info.filename;
    for (let n = 2; await exists(dir, name); n++) name = info.filename.replace(/(\.[^.]+)?$/, ' (' + n + ')$1');
    await writeFile(dir, name, bytes);
    doc.path = (folder.prefix ? folder.prefix + '/' : '') + sub + '/' + name;
    await writeFile(dir, name.replace(/\.[^.]+$/, '') + '.SOURCE.txt', new TextEncoder().encode(sourceNote(record, doc)));
  } else {
    doc.fileId = uid('doc');
    await putFile(doc.fileId, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { name: info.filename, mime: info.mime, kind: 'document' });
  }
  record.documents.push(normaliseDocument(doc));
  touch();
  return record.documents[record.documents.length - 1];
}
async function exists(dir, name) {
  try { await dir.getFileHandle(name); return true; } catch (e) { return false; }
}

// Ask the research service for the product's documents and dimensions, fetch every cited PDF
// or drawing, and size linked fixtures from the dimensions when the record has none yet.
// `say(text)` reports progress. Resolves { saved, failed, dims }.
export async function findDocuments(prop, record, say = () => {}) {
  const label = [record.brand, record.model].filter(Boolean).join(' ');
  say('Searching for the ' + label + ' spec sheet, installation guide and manual');
  const capsR = await (await fetch('/api/material-research/capabilities')).json();
  if (!capsR.available) throw new Error('Web research is not available on this Mac (' + (capsR.reason || 'no research agent') + '). Add document addresses by hand.');
  const headers = { 'Content-Type': 'application/json', 'X-Tiksi-Token': capsR.token };
  const body = { query: label + ': find the manufacturer specification sheet, installation instructions with the dimension drawing, and the owner\'s manual as PDF links (manufacturer first, then retailers), and the overall width, depth and height.',
    mode: 'focused', context: { name: label, category: record.category || '' }, constraints: { specifications: 'Cite direct PDF addresses where they exist. Overall dimensions as width, depth (including handles) and height.' } };
  let job = (await (await fetch('/api/material-research', { method: 'POST', headers, body: JSON.stringify(body) })).json()).job;
  if (!job) throw new Error('The research service refused the request');
  while (job.status === 'queued' || job.status === 'running') {
    await new Promise(r => setTimeout(r, 3000));
    job = (await (await fetch('/api/material-research/' + job.id, { headers })).json()).job;
    say('Searching (' + job.status + ')');
  }
  if (!['completed', 'partial'].includes(job.status)) throw new Error('Research ' + job.status + (job.error ? ': ' + job.error : ''));
  const match = (job.products || []).filter(p => !p.model || String(p.model).toLowerCase().replace(/\W/g, '').includes(String(record.model).toLowerCase().replace(/\W/g, '')));
  const urls = new Map();
  for (const p of match.length ? match : job.products || []) for (const e of p.sourceEvidence || []) if (e.url && !urls.has(e.url)) urls.set(e.url, e.title || '');
  const saved = [], failed = [];
  for (const [url, title] of urls) {
    if (!/\.pdf(\?|#|$)|spec|install|manual|dimension|drawing|guide/i.test(url + ' ' + title)) continue;   // product pages stay as sources
    try {
      say('Fetching ' + (title || url));
      const { bytes, info } = await fetchDocument(url);
      saved.push(await saveDocument(prop, record, bytes, info, { title }));
    } catch (e) { failed.push({ url, error: String(e && e.message || e) }); }
  }
  let dims = null;
  if (!record.dims) {
    const facts = (match[0] || {}).specifications || [];
    dims = dimsFromFacts(facts);
    if (dims) {
      const src = facts.find(f => /width|depth|height/i.test(f.name)) || {};
      record.dims = { ...dims, source: { title: 'Researched specifications', url: src.sourceUrl || '' } };
      normaliseProductRecord(record);
      applyRecordToFixtures(ws.data, record);
    }
  }
  touch();
  return { saved, failed, dims };
}

export { DOC_LABEL };
