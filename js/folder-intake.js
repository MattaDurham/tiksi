// A property from a folder: what a picked folder holds and how each file would come in.
//
// A folder reaches Tiksi two ways. On the Mac that runs Tiksi's server, the server opens the
// Mac's own folder window and reads the files where they are (server/folder_intake.py), so the
// project can be kept in that folder. Anywhere else the browser's own folder picker hands the
// files over. Both give the same shape: { name, path, files: [{ path, size }], read(path) }.
//
// Sorting is by file name only, so it is the same in both cases and can be checked without a
// browser. Two things need a look inside a file, and `inspectFolder` does them: a small text
// file may hold a Polycam share link, and a glTF or OBJ model names the files it needs.

import { parseCaptureUrl } from './polycam.js';

export const MAX_FILE_BYTES = 600 * 1024 * 1024;      // the project asset limit
const MAX_NOTE_BYTES = 256 * 1024;                    // a link note is a few hundred bytes
const MAX_MODEL_TEXT_BYTES = 32 * 1024 * 1024;        // a .gltf's JSON; its geometry is in .bin files

// In the order they are imported and shown.
export const KINDS = [
  ['link', 'Polycam link', 'Polycam links'],
  ['model', '3D scan or model', '3D scans and models'],
  ['cameras', 'Polycam raw capture', 'Polycam raw captures'],
  ['photo', 'Photo', 'Photos'],
  ['document', 'PDF', 'PDFs'],
  ['video', 'Video', 'Videos'],
  ['audio', 'Audio recording', 'Audio recordings'],
  ['project', 'Tiksi project file', 'Tiksi project files'],
  ['other', 'Other file', 'Other files'],
];
// Kinds Tiksi brings into the property. The rest stay in the folder and are listed, never hidden.
export const IMPORTED = new Set(['link', 'model', 'photo', 'document', 'video']);

const EXT = {
  model: new Set(['skp', 'blend', 'ifc', 'step', 'stp', 'iges', 'igs', 'dxf', 'las', 'laz', 'usd', 'usda', 'usdc', 'usdz', 'rvt', 'dwg', '3dm', 'e57', 'ply',
    'splat', 'spz', 'ksplat', 'sog', 'obj', 'dae', 'fbx', '3ds', 'glb', 'gltf', 'stl', 'zip', 'pcd', 'xyz', 'pts', 'c4d', 'max', 'ma', 'mb', 'rfa', 'dwf']),
  photo: new Set(['jpg', 'jpeg', 'png', 'webp', 'avif', 'gif', 'bmp', 'heic', 'heif', 'tif', 'tiff']),
  document: new Set(['pdf']),
  video: new Set(['mp4', 'mov', 'm4v', 'qt', 'avi', 'mkv', 'webm', 'wmv', '3gp', 'mts', 'm2ts']),
  audio: new Set(['m4a', 'mp3', 'wav', 'aac', 'aif', 'aiff', 'caf', 'flac', 'ogg', 'oga', 'opus', 'amr', 'wma']),
  project: new Set(['tiksi']),
  note: new Set(['rtf', 'txt', 'md', 'webloc', 'url', 'html', 'htm']),
};
const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', avif: 'image/avif', gif: 'image/gif', bmp: 'image/bmp',
  heic: 'image/heic', heif: 'image/heif', tif: 'image/tiff', tiff: 'image/tiff', pdf: 'application/pdf',
  mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v', qt: 'video/quicktime',
};
// The folders of a Polycam raw data export; `cameras` and `images` together mark one.
const CAPTURE_DIRS = new Set(['cameras', 'images', 'depth', 'confidence', 'corrected_cameras', 'corrected_images']);
// Models whose textures and buffers are separate files beside them.
const WITH_COMPANIONS = new Set(['gltf', 'obj']);

export const extOf = path => { const name = baseName(path), dot = name.lastIndexOf('.'); return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''; };
export const baseName = path => String(path || '').split('/').pop();
export const dirName = path => { const parts = String(path || '').split('/'); parts.pop(); return parts.join('/'); };
export const mimeOf = path => MIME[extOf(path)] || '';
// The first folder level a file sits in: '' for the top of the picked folder.
export const groupOf = path => { const parts = String(path || '').split('/'); return parts.length > 1 ? parts[0] : ''; };

function kindByName(path) {
  const ext = extOf(path);
  for (const kind of ['project', 'photo', 'document', 'video', 'audio', 'model']) if (EXT[kind].has(ext)) return kind;
  return 'other';
}

// files: [{ path, size }] with '/'-separated paths relative to the picked folder.
// Returns items: [{ kind, path, size, group, tooLarge?, companions?, count?, note? }].
export function classifyFolder(files) {
  const list = (files || []).filter(f => f && typeof f.path === 'string' && f.path).map(f => ({ path: f.path, size: Number(f.size) || 0 }));
  // A Polycam raw export: a folder holding both cameras/ and images/. Its thousands of
  // keyframe files are one item, never site photos.
  const dirs = new Map();
  for (const f of list) {
    const parts = f.path.split('/');
    if (parts.length >= 2 && CAPTURE_DIRS.has(parts[parts.length - 2])) {
      const root = parts.slice(0, -2).join('/');
      const rec = dirs.get(root) || dirs.set(root, { names: new Set(), files: [] }).get(root);
      rec.names.add(parts[parts.length - 2]); rec.files.push(f);
    }
  }
  const items = [], used = new Set();
  for (const [root, rec] of dirs) {
    if (!rec.names.has('cameras') || !rec.names.has('images')) continue;
    for (const f of rec.files) used.add(f.path);
    items.push({ kind: 'cameras', path: root, size: rec.files.reduce((n, f) => n + f.size, 0), group: groupOf(root ? root + '/x' : 'x'),
      count: rec.files.filter(f => f.path.split('/').slice(-2)[0] === 'cameras').length });
  }
  for (const f of list) {
    if (used.has(f.path)) continue;
    const kind = kindByName(f.path), item = { kind, path: f.path, size: f.size, group: groupOf(f.path) };
    if (!f.size) { item.kind = 'other'; item.note = 'The file is empty.'; }
    else if (kind !== 'other' && kind !== 'project' && f.size > MAX_FILE_BYTES) item.tooLarge = true;
    items.push(item);
  }
  return sortItems(items);
}

function sortItems(items) {
  const order = new Map(KINDS.map(([id], i) => [id, i]));
  return items.sort((a, b) => order.get(a.kind) - order.get(b.kind) || a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' }));
}

// References a .gltf makes to other files, relative to itself.
export function gltfReferences(text) {
  let json;
  try { json = JSON.parse(text); } catch (e) { return []; }
  const out = [];
  for (const key of ['buffers', 'images']) for (const rec of Array.isArray(json?.[key]) ? json[key] : []) {
    if (rec && typeof rec.uri === 'string' && !/^data:/i.test(rec.uri) && !/^[a-z][a-z0-9+.-]*:/i.test(rec.uri)) {
      try { out.push(decodeURIComponent(rec.uri)); } catch (e) { out.push(rec.uri); }
    }
  }
  return out;
}

// Texture files a .mtl names (map_Kd, map_Bump, bump, disp, decal, refl, norm, with options).
export function mtlReferences(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.trim().match(/^(?:map_\w+|bump|disp|decal|refl|norm)\s+(.+)$/i);
    if (!m) continue;
    // Options come first (-bm 1.0, -o 0 0 0); the file name is what is left.
    const name = m[1].replace(/-\w+(?:\s+-?[\d.]+)+\s+/g, '').trim();
    if (name) out.push(name.replace(/\\/g, '/'));
  }
  return out;
}

function resolvePath(dir, relative) {
  const parts = dir ? dir.split('/') : [];
  for (const part of String(relative).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) return null; parts.pop(); } else parts.push(part);
  }
  return parts.join('/');
}

// Looks inside the few files whose meaning is not in their name. `readText(path)` returns the
// file's text. Changes `items` in place and returns it:
//   - a small text file holding a Polycam share link becomes a 'link' item with `link`
//   - a .gltf or .obj gains `companions` (the buffers, materials and textures it names), and
//     those files stop being photos or other files of their own
export async function inspectFolder(items, readText) {
  const byPath = new Map(items.map(i => [i.path, i]));
  const lower = new Map(items.map(i => [i.path.toLowerCase(), i.path]));
  const find = path => path == null ? null : byPath.has(path) ? path : lower.get(path.toLowerCase()) || null;
  for (const item of items) {
    if (item.kind !== 'other' || item.note || !EXT.note.has(extOf(item.path)) || item.size > MAX_NOTE_BYTES) continue;
    let link = null;
    try { link = parseCaptureUrl(noteText(await readText(item.path))); } catch (e) { link = null; }
    if (link) { item.kind = 'link'; item.link = link; }
  }
  const taken = new Set();
  for (const item of items) {
    const ext = extOf(item.path);
    if (item.kind !== 'model' || !WITH_COMPANIONS.has(ext) || item.tooLarge) continue;
    const dir = dirName(item.path), names = [];
    try {
      if (ext === 'gltf') { if (item.size <= MAX_MODEL_TEXT_BYTES) names.push(...gltfReferences(await readText(item.path))); }
      else {
        // An OBJ names its material files in `mtllib` lines, but the file can be hundreds of
        // megabytes; the material files beside it are read instead.
        const mtls = items.filter(i => extOf(i.path) === 'mtl' && dirName(i.path) === dir && i.size <= MAX_NOTE_BYTES * 16).map(i => i.path);
        for (const mtl of mtls) { names.push(baseName(mtl)); names.push(...mtlReferences(await readText(mtl))); }
      }
    } catch (e) { item.note = 'Its companion files could not be read: ' + (e.message || e); }
    const companions = [], missing = [];
    for (const name of [...new Set(names)]) {
      const path = find(resolvePath(dir, name));
      if (path && path !== item.path) companions.push(path); else if (!path) missing.push(name);
    }
    item.companions = companions;
    if (missing.length) item.missing = missing;
    for (const path of companions) taken.add(path);
  }
  for (let i = items.length - 1; i >= 0; i--) if (taken.has(items[i].path)) items.splice(i, 1);
  // Two notes naming the same capture are one scan.
  const seen = new Set();
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind !== 'link') continue;
    if (seen.has(item.link.captureId)) { item.kind = 'other'; item.note = 'The same Polycam link as another file in the folder.'; delete item.link; }
    else seen.add(item.link.captureId);
  }
  return sortItems(items);
}

// The words of a note, whatever wrapped them: RTF control words and braces, the tags and quotes
// of HTML or of a .webloc. Only good enough to find a link; never shown.
function noteText(raw) {
  return String(raw || '').replace(/\\\r?\n/g, ' ').replace(/\\[a-z]+-?\d* ?/gi, ' ').replace(/[{}\\<>"']/g, ' ');
}

// What the review screen shows: per kind, how many files and how many bytes.
export function summarize(items) {
  const out = [];
  for (const [kind, one, many] of KINDS) {
    const of = items.filter(i => i.kind === kind);
    if (!of.length) continue;
    out.push({ kind, label: of.length === 1 ? one : many, count: of.length, bytes: of.reduce((n, i) => n + i.size, 0), imported: IMPORTED.has(kind), items: of });
  }
  return out;
}

// A property name from a folder name: the folder name, without the dates and counters download
// tools add at the end ("Smith kitchen (2)", "site-visit-2026-11-10").
export function suggestName(folderName) {
  const name = String(folderName || '').replace(/[_]+/g, ' ').replace(/\s*\(\d+\)\s*$/, '').replace(/\s+/g, ' ').trim();
  return name || 'New property';
}

// ---------- where a folder comes from ----------
const HEADERS = { 'X-Tiksi-Folder': '1' };
let capabilities = null;
// What `folderService` last learned, without waiting: a click handler must open the browser's
// folder picker in the same turn as the click.
export const folderServiceKnown = () => capabilities;

// What the server offers: null on static hosting, else { choose: true|false }.
export async function folderService() {
  if (typeof document === 'undefined' || document.querySelector('meta[name="tiksi-storage"]')?.content !== 'project-files') return null;
  if (capabilities) return capabilities;
  try {
    const r = await fetch('/api/folder-intake/capabilities', { headers: HEADERS, cache: 'no-store', signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    capabilities = await r.json();
    return capabilities;
  } catch (e) { return null; }
}

async function call(path, options = {}) {
  const cap = await folderService();
  if (!cap) throw new Error('The folder service is not running on this server');
  let r = await fetch('/api/folder-intake' + path, { ...options, headers: { ...HEADERS, 'X-Tiksi-Token': cap.token, ...(options.headers || {}) }, cache: 'no-store' });
  if (r.status === 403 && !options.retried) {
    // The server restarted and has a new token.
    capabilities = null;
    const again = await folderService();
    if (again && again.token !== cap.token) return call(path, { ...options, retried: true });
  }
  if (!r.ok) {
    let message = 'The folder could not be read (' + r.status + ')';
    try { message = (await r.json()).error || message; } catch (e) { /* not JSON */ }
    const error = new Error(message); error.status = r.status; throw error;
  }
  return r;
}

// Opens the Mac's folder window (through the server) and waits for the pick. Null on cancel.
export async function chooseFolderOnMac() {
  const pick = await (await call('/choose', { method: 'POST' })).json();
  if (!pick || pick.cancelled) return null;
  const id = pick.id;
  return {
    where: 'mac', name: pick.name, path: pick.path, files: pick.files, skipped: pick.skipped, truncated: !!pick.truncated,
    async read(path) {
      const blob = await (await call('/picks/' + id + '/file?path=' + encodeURIComponent(path))).blob();
      return new File([blob], baseName(path), { type: mimeOf(path) });
    },
    // The project file of a property not saved yet will be written to <folder>/Tiksi/.
    async keepIn(propertyId, name) { return (await (await call('/picks/' + id + '/keep', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ propertyId, name }) })).json()).path; },
    forget() { return call('/picks/' + id, { method: 'DELETE' }).catch(() => {}); },
  };
}

// A folder from the browser's own folder picker (<input type="file" webkitdirectory>).
export function folderFromFiles(fileList) {
  const all = Array.from(fileList || []), byPath = new Map(), skipped = { hidden: 0 };
  let name = '';
  for (const file of all) {
    const parts = String(file.webkitRelativePath || file.name).split('/');
    // The picker puts the folder's own name first.
    if (parts.length > 1) { const top = parts.shift(); name = name || top; }
    if (parts.some(p => p.startsWith('.') || p === 'Thumbs.db' || p === 'desktop.ini')) { skipped.hidden++; continue; }
    if (parts[0] === 'Tiksi' && parts.length > 1) { skipped.tiksi = (skipped.tiksi || 0) + 1; continue; }
    byPath.set(parts.join('/'), file);
  }
  return {
    where: 'browser', name: name || 'Folder', path: null, skipped, truncated: false,
    files: [...byPath].map(([path, file]) => ({ path, size: file.size })),
    async read(path) {
      const file = byPath.get(path);
      if (!file) throw new Error(path + ' is not in the chosen folder');
      return file.type || !mimeOf(path) ? file : new File([file], file.name, { type: mimeOf(path) });
    },
    forget() {},
  };
}

export function pickFolderInBrowser() {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file'; input.webkitdirectory = true; input.multiple = true; input.hidden = true;
    input.dataset.folderInput = '';
    document.body.append(input);
    const done = value => { input.remove(); resolve(value); };
    input.onchange = () => done(input.files && input.files.length ? folderFromFiles(input.files) : null);
    input.addEventListener('cancel', () => done(null));
    input.click();
  });
}
