// The view label a rendering carries inside its own file (XMP metadata), so Tiksi files it under
// the right saved view. The page's copy of server/rendering_stamp.py, which explains the label;
// test/fixtures/rendering-stamp/ holds files both copies must read the same way.
// Pure: bytes in, bytes or a label out. No DOM.

export const NS = 'https://thedurham.nyc/ns/tiksi/1.0/';
export const FIELDS = ['property', 'propertyName', 'view', 'viewName', 'room', 'renderedAt', 'by'];
const XMP_JPEG = 'http://ns.adobe.com/xap/1.0/\0';
const XMP_PNG = 'XML:com.adobe.xmp';
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const MAX_VALUE = 200;

const enc = new TextEncoder(), dec = new TextDecoder();
const clean = v => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_VALUE);
const unescapeXml = s => s.replace(/&(lt|gt|quot|apos|amp|#(\d+)|#x([0-9a-f]+));/gi, (m, n, d, h) =>
  d ? String.fromCodePoint(+d) : h ? String.fromCodePoint(parseInt(h, 16)) : ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' })[n.toLowerCase()]);
const escapeXml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
const ascii = (b, at, n) => String.fromCharCode(...b.subarray(at, at + n));
const u32 = (b, at) => ((b[at] << 24) >>> 0) + (b[at + 1] << 16) + (b[at + 2] << 8) + b[at + 3];
const u32le = (b, at) => b[at] + (b[at + 1] << 8) + (b[at + 2] << 16) + ((b[at + 3] << 24) >>> 0);
const isPng = b => PNG_SIGNATURE.every((x, i) => b[i] === x);
const isJpeg = b => b[0] === 0xff && b[1] === 0xd8;
const bytesOf = data => data instanceof Uint8Array ? data : new Uint8Array(data);

// The Tiksi fields in an XMP packet, or null.
export function labelFromXmp(text) {
  if (!text || !text.includes(NS)) return null;
  const out = {};
  const names = FIELDS.join('|');
  for (const m of text.matchAll(new RegExp('\\btiksi:(' + names + ')\\s*=\\s*"([^"]*)"', 'g'))) { const v = clean(unescapeXml(m[2])); if (v && !(m[1] in out)) out[m[1]] = v; }
  for (const m of text.matchAll(new RegExp('<tiksi:(' + names + ')>([^<]*)</tiksi:\\1>', 'g'))) { const v = clean(unescapeXml(m[2])); if (v && !(m[1] in out)) out[m[1]] = v; }
  return Object.keys(out).length ? out : null;
}

async function inflate(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

// The text of a PNG iTXt chunk holding XMP, or null. (A compressed one needs `await`.)
async function pngXmp(body) {
  const zero = body.indexOf(0);
  if (zero < 0 || ascii(body, 0, zero) !== XMP_PNG) return null;
  const compressed = body[zero + 1];
  let at = body.indexOf(0, zero + 3);           // after the language tag
  at = body.indexOf(0, at + 1);                  // after the translated keyword
  if (at < 0) return null;
  const text = body.subarray(at + 1);
  return dec.decode(compressed ? await inflate(text) : text);
}

// The label in a picture's bytes (ArrayBuffer or Uint8Array), or null.
export async function readLabel(data) {
  const b = bytesOf(data);
  try {
    if (isPng(b)) {
      for (let at = 8; at + 8 <= b.length;) {
        const length = u32(b, at), kind = ascii(b, at + 4, 4);
        if (kind === 'iTXt') { const label = labelFromXmp(await pngXmp(b.subarray(at + 8, at + 8 + length))); if (label) return label; }
        if (kind === 'IEND') return null;
        at += 12 + length;
      }
      return null;
    }
    if (isJpeg(b)) {
      for (let at = 2; at + 4 <= b.length;) {
        if (b[at] !== 0xff) return null;
        const m = b[at + 1];
        if (m === 0xd9 || m === 0xda) return null;
        if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) { at += 2; continue; }
        const length = (b[at + 2] << 8) + b[at + 3];
        if (m === 0xe1 && ascii(b, at + 4, XMP_JPEG.length) === XMP_JPEG) {
          const label = labelFromXmp(dec.decode(b.subarray(at + 4 + XMP_JPEG.length, at + 2 + length)));
          if (label) return label;
        }
        at += 2 + length;
      }
      return null;
    }
    if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') {
      for (let at = 12; at + 8 <= b.length;) {
        const kind = ascii(b, at, 4), length = u32le(b, at + 4);
        if (kind === 'XMP ') return labelFromXmp(dec.decode(b.subarray(at + 8, at + 8 + length)));
        at += 8 + length + (length & 1);
      }
    }
  } catch (e) { return null; }
  return null;
}

function description(label) {
  const fields = FIELDS.filter(k => clean(label[k])).map(k => ' tiksi:' + k + '="' + escapeXml(clean(label[k])) + '"').join('');
  return '<rdf:Description rdf:about="" xmlns:tiksi="' + NS + '"' + fields + '/>';
}
const OURS = new RegExp('<rdf:Description\\b[^>]*\\bxmlns:tiksi="' + NS.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') + '"[^>]*/>\\s*', 'g');
export function packetWith(existing, label) {
  const ours = description(label);
  if (existing && existing.includes('</rdf:RDF>')) return existing.replace(OURS, '').replace('</rdf:RDF>', ours + '</rdf:RDF>');
  return '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
    + ours + '</rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
}

let crcTable = null;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  }
  let c = 0xffffffff;
  for (const x of bytes) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const concat = parts => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; };
const be32 = n => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);

// `data` (a PNG or JPEG) with `label` written into its XMP, as a Uint8Array. Throws for any other file.
export async function stampBytes(data, label) {
  const b = bytesOf(data);
  if (!FIELDS.some(k => clean(label[k]))) throw new Error('The label is empty: give at least the view or the room.');
  if (isPng(b)) {
    const chunks = []; let existing = null;
    for (let at = 8; at + 8 <= b.length;) {
      const length = u32(b, at), kind = ascii(b, at + 4, 4), end = at + 12 + length;
      if (end > b.length) throw new Error('The PNG file is cut short.');
      const body = b.subarray(at + 8, at + 8 + length);
      if (kind === 'iTXt' && ascii(body, 0, XMP_PNG.length + 1) === XMP_PNG + '\0') { if (existing === null) existing = await pngXmp(body); }
      else chunks.push(b.subarray(at, end));
      at = end;
      if (kind === 'IEND') break;
    }
    if (!chunks.length || ascii(chunks[0], 4, 4) !== 'IHDR') throw new Error('Not a PNG file Tiksi can read.');
    const data2 = concat([enc.encode('iTXt' + XMP_PNG), new Uint8Array(5), enc.encode(packetWith(existing, label))]);
    const xmp = concat([be32(data2.length - 4), data2, be32(crc32(data2))]);
    return concat([new Uint8Array(PNG_SIGNATURE), chunks[0], xmp, ...chunks.slice(1)]);
  }
  if (isJpeg(b)) {
    const kept = []; let existing = null, at = 2;
    while (at + 4 <= b.length) {
      if (b[at] !== 0xff) throw new Error('Not a JPEG file Tiksi can read.');
      const m = b[at + 1];
      if (m === 0xda || m === 0xd9) break;
      if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) { kept.push(b.subarray(at, at + 2)); at += 2; continue; }
      const length = (b[at + 2] << 8) + b[at + 3], seg = b.subarray(at, at + 2 + length);
      if (m === 0xe1 && ascii(seg, 4, XMP_JPEG.length) === XMP_JPEG) { if (existing === null) existing = dec.decode(seg.subarray(4 + XMP_JPEG.length)); }
      else kept.push(seg);
      at += 2 + length;
    }
    const body = concat([enc.encode(XMP_JPEG), enc.encode(packetWith(existing, label))]);
    if (body.length + 2 > 0xffff) throw new Error('The JPEG file\'s metadata is too large to add the label to.');
    const xmp = concat([new Uint8Array([0xff, 0xe1, ((body.length + 2) >> 8) & 255, (body.length + 2) & 255]), body]);
    let n = 0;
    while (n < kept.length && kept[n][0] === 0xff && (kept[n][1] === 0xe0 || kept[n][1] === 0xe1)) n++;
    return concat([new Uint8Array([0xff, 0xd8]), ...kept.slice(0, n), xmp, ...kept.slice(n), b.subarray(at)]);
  }
  throw new Error('Only PNG and JPEG renderings can carry the label; save the rendering as one of those.');
}

// The label for a rendering of saved view `view` of property `prop`.
export function labelFor(prop, view, extra = {}) {
  const room = roomOfView(prop, view);
  return { property: prop.id, propertyName: prop.name || '', view: view.id, viewName: view.name || '', room: room ? room.name || '' : '', ...extra };
}

// The room a saved view is named for: "Kitchen" or "Kitchen, north wall" is the Kitchen.
export function roomOfView(prop, view) {
  const slug = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const v = slug(view && view.name);
  let best = null;
  for (const r of prop.rooms || []) {
    const s = slug(r.name);
    if (s && (v === s || v.startsWith(s + '-')) && (!best || s.length > slug(best.name).length)) best = r;
  }
  return best;
}
