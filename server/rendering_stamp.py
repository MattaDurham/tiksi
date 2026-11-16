"""The view label a rendering carries inside its own file, so Tiksi files it under the right saved view.

Whatever makes a rendering of a saved view (Tiksi's RENDER THIS VIEW, a render engine, an image
model driven by an agent) writes which view it shows into the picture's XMP metadata, the
standard metadata block of PNG, JPEG and WebP files. Tiksi reads it when it lists the project
folder (project_photos.py) and when a picture is added in the send window, and puts the
rendering on that view. `scripts/stamp-rendering.py` writes and reads it.

The label is one XMP description in Tiksi's namespace:
    <rdf:Description rdf:about="" xmlns:tiksi="https://thedurham.nyc/ns/tiksi/1.0/"
      tiksi:property="prop-..." tiksi:propertyName="..." tiksi:view="sv-..." tiksi:viewName="Living"
      tiksi:room="Living" tiksi:renderedAt="2026-11-16T14:32:00Z" tiksi:by="..."/>
Every field is optional. Tiksi matches the view by its id, then by its name, then by the room
(a view named for the room, or named for it first: "Kitchen, north wall"). A file that already
has XMP keeps it: the label is added beside what is there, and replaces an older Tiksi label.

The same reading and writing is in js/rendering-stamp.js for the page; test fixtures check that
both agree."""
import re
import struct
import zlib
from html import escape, unescape

NS = 'https://thedurham.nyc/ns/tiksi/1.0/'
FIELDS = ('property', 'propertyName', 'view', 'viewName', 'room', 'renderedAt', 'by')
XMP_JPEG = b'http://ns.adobe.com/xap/1.0/\x00'
XMP_PNG = b'XML:com.adobe.xmp'
PNG_SIGNATURE = b'\x89PNG\r\n\x1a\n'
MAX_VALUE = 200
# Our own description, as written: one self-closing element.
OURS = re.compile(r'<rdf:Description\b[^>]*\bxmlns:tiksi="' + re.escape(NS) + r'"[^>]*/>\s*')
ATTRIBUTE = re.compile(r'\btiksi:(' + '|'.join(FIELDS) + r')\s*=\s*"([^"]*)"')
ELEMENT = re.compile(r'<tiksi:(' + '|'.join(FIELDS) + r')>([^<]*)</tiksi:\1>')


class StampError(ValueError):
    pass


def clean(value):
    return re.sub(r'[\x00-\x1f\x7f]', ' ', str(value or '')).strip()[:MAX_VALUE]


def label_from_xmp(text):
    """The Tiksi fields in an XMP packet (attribute or element form), or None."""
    if NS not in text: return None
    out = {}
    for name, value in ATTRIBUTE.findall(text) + ELEMENT.findall(text):
        value = clean(unescape(value))
        if value and name not in out: out[name] = value
    return out or None


def description(label):
    fields = ''.join(f' tiksi:{k}="{escape(clean(label[k]), quote=True)}"' for k in FIELDS if clean(label.get(k)))
    return f'<rdf:Description rdf:about="" xmlns:tiksi="{NS}"{fields}/>'


def packet_with(existing, label):
    """An XMP packet holding `label`: `existing` (str or None) with any older Tiksi label replaced."""
    ours = description(label)
    if existing and '</rdf:RDF>' in existing:
        kept = OURS.sub('', existing)
        return kept.replace('</rdf:RDF>', ours + '</rdf:RDF>', 1)
    return ('<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>'
            '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
            + ours + '</rdf:RDF></x:xmpmeta><?xpacket end="w"?>')


# ---------- reading: only the headers are read, never the picture itself ----------

def read_label(path):
    """The label in a picture file, or None. Reads chunk and segment headers, skipping the image data."""
    try:
        with open(path, 'rb') as f: return read_label_stream(f)
    except OSError: return None


def label_of_bytes(data):
    import io
    return read_label_stream(io.BytesIO(data))


def read_label_stream(f):
    try:
        head = f.read(12)
        if head[:8] == PNG_SIGNATURE: f.seek(8); return _png_label(f)
        if head[:2] == b'\xff\xd8': f.seek(2); return _jpeg_label(f)
        if head[:4] == b'RIFF' and head[8:12] == b'WEBP': return _webp_label(f)
    except (ValueError, struct.error, zlib.error): return None
    return None


def _png_xmp(data):
    """The text of an iTXt chunk holding XMP, or None."""
    keyword, _, rest = data.partition(b'\x00')
    if keyword != XMP_PNG or len(rest) < 2: return None
    compressed = rest[0]
    _, _, rest = rest[2:].partition(b'\x00')   # language tag
    _, _, text = rest.partition(b'\x00')       # translated keyword
    return (zlib.decompress(text) if compressed else text).decode('utf-8', 'replace')


def _png_label(f):
    while True:
        header = f.read(8)
        if len(header) < 8: return None
        length, kind = struct.unpack('>I4s', header)
        if kind == b'iTXt' and length < 4 * 1024 * 1024:
            text = _png_xmp(f.read(length)); f.seek(4, 1)
            label = label_from_xmp(text) if text else None
            if label: return label
            continue
        if kind == b'IEND': return None
        f.seek(length + 4, 1)


def _jpeg_label(f):
    while True:
        marker = f.read(2)
        if len(marker) < 2 or marker[0] != 0xFF: return None
        if marker[1] in (0xD9, 0xDA): return None          # end, or the image data starts
        if 0xD0 <= marker[1] <= 0xD7 or marker[1] == 0x01: continue
        length = struct.unpack('>H', f.read(2))[0]
        if marker[1] == 0xE1 and length > len(XMP_JPEG) + 2:
            body = f.read(length - 2)
            if body.startswith(XMP_JPEG):
                label = label_from_xmp(body[len(XMP_JPEG):].decode('utf-8', 'replace'))
                if label: return label
            continue
        f.seek(length - 2, 1)


def _webp_label(f):
    f.seek(12)
    while True:
        header = f.read(8)
        if len(header) < 8: return None
        kind, length = struct.unpack('<4sI', header)
        if kind == b'XMP ' and length < 4 * 1024 * 1024:
            return label_from_xmp(f.read(length).decode('utf-8', 'replace'))
        f.seek(length + (length & 1), 1)


# ---------- writing ----------

def _png_chunk(kind, data):
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xFFFFFFFF)


def stamp_bytes(data, label):
    """`data` (a PNG or JPEG file) with `label` written into its XMP. Raises StampError otherwise."""
    if not any(clean(label.get(k)) for k in FIELDS): raise StampError('The label is empty: give at least the view or the room.')
    if data[:8] == PNG_SIGNATURE: return _stamp_png(data, label)
    if data[:2] == b'\xff\xd8': return _stamp_jpeg(data, label)
    raise StampError('Only PNG and JPEG renderings can carry the label; save the rendering as one of those.')


def _stamp_png(data, label):
    pos, chunks, existing = 8, [], None
    while pos + 8 <= len(data):
        length, kind = struct.unpack('>I4s', data[pos:pos + 8])
        end = pos + 12 + length
        if end > len(data): raise StampError('The PNG file is cut short.')
        body = data[pos + 8:pos + 8 + length]
        if kind == b'iTXt' and body.startswith(XMP_PNG + b'\x00'):
            if existing is None: existing = _png_xmp(body)
        else: chunks.append(data[pos:end])
        pos = end
        if kind == b'IEND': break
    if not chunks or chunks[0][4:8] != b'IHDR': raise StampError('Not a PNG file Tiksi can read.')
    text = packet_with(existing, label).encode('utf-8')
    xmp = _png_chunk(b'iTXt', XMP_PNG + b'\x00\x00\x00\x00\x00' + text)
    return PNG_SIGNATURE + chunks[0] + xmp + b''.join(chunks[1:])


def _stamp_jpeg(data, label):
    pos, kept, existing = 2, [], None
    while pos + 4 <= len(data):
        if data[pos] != 0xFF: raise StampError('Not a JPEG file Tiksi can read.')
        marker = data[pos + 1]
        if marker in (0xDA, 0xD9): break                    # the image data: copied as it is
        if 0xD0 <= marker <= 0xD7 or marker == 0x01: kept.append(data[pos:pos + 2]); pos += 2; continue
        length = struct.unpack('>H', data[pos + 2:pos + 4])[0]
        segment = data[pos:pos + 2 + length]
        if marker == 0xE1 and segment[4:].startswith(XMP_JPEG):
            if existing is None: existing = segment[4 + len(XMP_JPEG):].decode('utf-8', 'replace')
        else: kept.append(segment)
        pos += 2 + length
    body = XMP_JPEG + packet_with(existing, label).encode('utf-8')
    if len(body) + 2 > 0xFFFF: raise StampError('The JPEG file\'s metadata is too large to add the label to.')
    xmp = b'\xff\xe1' + struct.pack('>H', len(body) + 2) + body
    # After the JFIF and Exif segments (APP0, APP1), where XMP readers look for it.
    at = 0
    while at < len(kept) and kept[at][:2] in (b'\xff\xe0', b'\xff\xe1'): at += 1
    return b'\xff\xd8' + b''.join(kept[:at]) + xmp + b''.join(kept[at:]) + data[pos:]
