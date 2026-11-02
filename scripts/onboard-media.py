#!/usr/bin/env python3
"""Onboarding's brand pass and document pass, as commands an agent runs over a project's
media (see ONBOARDING.md). It prepares views to read, never reads logos itself:

  photo-tiles      full-resolution overlapping crops of each photo (3 x 3 by default), so a
                   small logo or rating label is seen at the camera's own pixels
  video-sharp      the sharpest full-resolution frame of every few seconds of a video, chosen
                   by edge variance from a dense burst (thumbnails are too small to read)
  keyframe-check   whether a Polycam keyframes folder (cameras/*.json, depth/*.png) is
                   consistent with ARKit's camera convention, from depth reprojection
  keyframe-sheets  numbered contact sheets of every Nth keyframe, to find first sightings
  keyframe-angles  from one sighting (keyframe and pixel), every other keyframe that sees
                   the same spot, nearest and sharpest first, with full-resolution crops
  fetch-docs       spec sheets, installation drawings and manuals from public addresses,
                   saved in the project's folder under "Product documents/<Brand Model>/"
                   with a SOURCE.txt each; prints the document entries for the findings
  convert-model    a product's 3D model (.skp, .fbx, .obj, .dae, .3ds, .usdz...) to GLB with
                   the installed SketchUp or Blender, keeping the original untouched

Outputs go to --out; source media are only read. Prints one JSON summary per command."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile
import zlib

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from server.video_frames import sharpness, even  # noqa: E402

IMAGES = {'.jpg', '.jpeg', '.png', '.heic', '.heif', '.tif', '.tiff', '.webp'}


def ffmpeg(*args, capture=False):
    exe = shutil.which('ffmpeg')
    if not exe: raise SystemExit('ffmpeg is needed (brew install ffmpeg)')
    result = subprocess.run([exe, '-nostdin', '-v', 'error', '-y', *map(str, args)], capture_output=True)
    if result.returncode: raise RuntimeError('ffmpeg failed: ' + result.stderr.decode('utf-8', 'replace')[-400:])
    return result.stdout if capture else None


def probe_size(path):
    exe = shutil.which('ffprobe')
    out = subprocess.run([exe, '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:stream_side_data=rotation:format=duration',
                          '-of', 'json', str(path)], capture_output=True, check=True).stdout
    info = json.loads(out or b'{}')
    s = (info.get('streams') or [{}])[0]
    w, h = int(s.get('width') or 0), int(s.get('height') or 0)
    rot = next((int(float(d['rotation'])) for d in s.get('side_data_list') or [] if 'rotation' in d), 0)
    if abs(rot) % 180 == 90: w, h = h, w
    return w, h, float((info.get('format') or {}).get('duration') or 0)


def readable(path, scratch):
    """A path ffmpeg can decode: HEIC goes through macOS sips first."""
    if path.suffix.lower() in {'.heic', '.heif'} and shutil.which('sips'):
        out = Path(scratch) / (path.stem + '.jpg')
        subprocess.run(['sips', '-s', 'format', 'jpeg', str(path), '--out', str(out)], capture_output=True, check=True)
        return out
    return path


# ---------- photos ----------

def photo_tiles(paths, out, grid=3, overlap=0.25):
    out.mkdir(parents=True, exist_ok=True)
    files = [p for path in paths for p in (sorted(path.iterdir()) if path.is_dir() else [path]) if p.suffix.lower() in IMAGES]
    index = []
    with tempfile.TemporaryDirectory() as scratch:
        for path in files:
            src = readable(path, scratch)
            w, h, _ = probe_size(src)
            if not w: continue
            tw, th = w / (grid - (grid - 1) * overlap), h / (grid - (grid - 1) * overlap)
            for r in range(grid):
                for c in range(grid):
                    x, y = round(c * tw * (1 - overlap)), round(r * th * (1 - overlap))
                    cw, ch = min(round(tw), w - x), min(round(th), h - y)
                    name = f'{path.stem}_r{r + 1}c{c + 1}.jpg'
                    ffmpeg('-i', src, '-vf', f'crop={cw}:{ch}:{x}:{y}', '-q:v', '2', out / name)
                    index.append({'photo': path.name, 'tile': name, 'crop': [round(x / w, 4), round(y / h, 4), round(cw / w, 4), round(ch / h, 4)]})
    (out / 'tiles.json').write_text(json.dumps(index, indent=1), encoding='utf-8')
    return {'photos': len(files), 'tiles': len(index), 'out': str(out)}


# ---------- video ----------

def video_sharp(video, out, every=2.0, fps=10, width=480, start=0.0, end=None):
    """Score every frame of a dense burst (`fps`) on a small grey copy, keep the sharpest
    moment of each `every`-second window, then extract those moments at full resolution."""
    out.mkdir(parents=True, exist_ok=True)
    w, h, duration = probe_size(video)
    if not duration: raise SystemExit('No readable duration in ' + str(video))
    end = min(end or duration, duration)
    gw = min(width, even(w)); gh = even(gw * h / w); size = gw * gh
    raw = ffmpeg('-ss', f'{start:.3f}', '-t', f'{end - start:.3f}', '-i', video, '-vf', f'fps={fps},scale={gw}:{gh},format=gray', '-f', 'rawvideo', 'pipe:1', capture=True)
    scores = [sharpness(raw[i:i + size], gw, gh) for i in range(0, len(raw) - size + 1, size)]
    best = {}
    for k, score in enumerate(scores):
        t = start + k / fps
        window = int((t - start) // every)
        if window not in best or score > best[window][1]: best[window] = (t, score)
    frames = []
    for window, (t, score) in sorted(best.items()):
        name = f'{Path(video).stem}_{int(t // 60):02d}m{t % 60:05.2f}s.jpg'
        ffmpeg('-ss', f'{t:.3f}', '-i', video, '-frames:v', '1', '-q:v', '2', out / name)
        frames.append({'video': Path(video).name, 'at': round(t, 3), 'sharpness': round(score, 1), 'frame': name})
    (out / 'frames.json').write_text(json.dumps(frames, indent=1), encoding='utf-8')
    return {'video': Path(video).name, 'frames': len(frames), 'scored': len(scores), 'width': w, 'height': h, 'out': str(out)}


# ---------- Polycam keyframes ----------

def png16(path):
    """A 16-bit greyscale PNG (Polycam depth, millimetres) as (w, h, values)."""
    data = Path(path).read_bytes()
    if data[:8] != b'\x89PNG\r\n\x1a\n': raise ValueError('not a PNG: ' + str(path))
    i, idat, w, h = 8, b'', 0, 0
    while i < len(data):
        n, = struct.unpack('>I', data[i:i + 4]); kind = data[i + 4:i + 8]; body = data[i + 8:i + 8 + n]; i += 12 + n
        if kind == b'IHDR':
            w, h, depth, color = struct.unpack('>IIBB', body[:10])
            if depth != 16 or color != 0: raise ValueError('depth maps must be 16-bit greyscale')
        elif kind == b'IDAT': idat += body
    raw, stride, out, prev, p = zlib.decompress(idat), w * 2, bytearray(), bytearray(w * 2), 0
    for _ in range(h):
        f, line = raw[p], bytearray(raw[p + 1:p + 1 + stride]); p += 1 + stride
        for x in range(stride):
            a = line[x - 2] if x >= 2 else 0; b = prev[x]; c = prev[x - 2] if x >= 2 else 0
            if f == 1: line[x] = (line[x] + a) & 255
            elif f == 2: line[x] = (line[x] + b) & 255
            elif f == 3: line[x] = (line[x] + (a + b) // 2) & 255
            elif f == 4:
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                line[x] = (line[x] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        out += line; prev = line
    return w, h, struct.unpack('>%dH' % (w * h), bytes(out))


class Keyframes:
    """A Polycam raw keyframes folder: images/<id>.jpg, cameras/<id>.json (intrinsics and
    t_00..t_23, the camera-to-world transform) and depth/<id>.png (millimetres)."""

    def __init__(self, folder):
        self.root = Path(folder)
        self.ids = sorted(p.stem for p in (self.root / 'cameras').glob('*.json'))
        if not self.ids: raise SystemExit('No cameras/*.json in ' + str(folder))
        self.cams, self.depths = {}, {}

    def cam(self, kid):
        if kid not in self.cams:
            c = json.loads((self.root / 'cameras' / (kid + '.json')).read_text(encoding='utf-8'))
            c['R'] = [[c['t_%d%d' % (r, k)] for k in range(3)] for r in range(3)]
            c['t'] = [c['t_%d3' % r] for r in range(3)]
            self.cams[kid] = c
        return self.cams[kid]

    def depth(self, kid):
        if kid not in self.depths:
            path = self.root / 'depth' / (kid + '.png')
            self.depths[kid] = png16(path) if path.is_file() else None
            if len(self.depths) > 64: self.depths.pop(next(iter(self.depths)))
        return self.depths[kid]

    def depth_at(self, kid, u, v):
        d, c = self.depth(kid), self.cam(kid)
        if not d: return None
        w, h, vals = d
        x, y = int(u * w / c['width']), int(v * h / c['height'])
        if not (0 <= x < w and 0 <= y < h): return None
        mm = vals[y * w + x]
        return mm / 1000 if mm else None

    # ARKit: the camera looks down -Z with +Y up in the image.
    def unproject(self, kid, u, v, z):
        c = self.cam(kid)
        ray = [(u - c['cx']) / c['fx'], -(v - c['cy']) / c['fy'], -1.0]
        return [c['t'][r] + sum(c['R'][r][k] * ray[k] * z for k in range(3)) for r in range(3)]

    def project(self, kid, p):
        c = self.cam(kid)
        d = [p[r] - c['t'][r] for r in range(3)]
        q = [sum(c['R'][r][k] * d[r] for r in range(3)) for k in range(3)]
        z = -q[2]
        if z <= 0.05: return None
        u, v = c['cx'] + c['fx'] * q[0] / z, c['cy'] - c['fy'] * q[1] / z
        return (u, v, z) if 0 <= u < c['width'] and 0 <= v < c['height'] else None

    def image(self, kid):
        for ext in ('.jpg', '.jpeg', '.png'):
            p = self.root / 'images' / (kid + ext)
            if p.is_file(): return p
        return None


def keyframe_check(folder, samples=40):
    """How well neighbouring keyframes agree when depth is carried from one to the next:
    the share of reprojected depth samples within 10% of the next frame's own depth map."""
    kf = Keyframes(folder)
    step = max(1, len(kf.ids) // samples)
    agree = total = 0
    for i in range(0, len(kf.ids) - 2, step):
        a, b = kf.ids[i], kf.ids[i + 2]
        c = kf.cam(a)
        for fu, fv in ((0.3, 0.35), (0.7, 0.35), (0.5, 0.5), (0.3, 0.65), (0.7, 0.65)):
            u, v = fu * c['width'], fv * c['height']
            z = kf.depth_at(a, u, v)
            if not z: continue
            hit = kf.project(b, kf.unproject(a, u, v, z))
            if not hit: continue
            total += 1
            zb = kf.depth_at(b, hit[0], hit[1])
            if zb and abs(zb - hit[2]) / hit[2] < 0.1: agree += 1
    share = agree / total if total else 0
    return {'keyframes': len(kf.ids), 'samples': total, 'agree': round(share, 3), 'consistent': share >= 0.5,
            'note': 'Poses follow the ARKit convention; keyframe-angles can be trusted' if share >= 0.5 else
                    'Depth does not carry between neighbouring keyframes: use keyframe-sheets and read frames one by one'}


def keyframe_sheets(folder, out, every=10, cols=6, rows=5, width=320):
    kf = Keyframes(folder)
    out.mkdir(parents=True, exist_ok=True)
    chosen = [k for k in kf.ids[::every] if kf.image(k)]
    per = cols * rows; sheets = []
    for s in range(0, len(chosen), per):
        group = chosen[s:s + per]
        with tempfile.TemporaryDirectory() as tmp:
            for n, kid in enumerate(group):
                index = kf.ids.index(kid)
                ffmpeg('-i', kf.image(kid), '-vf', f"scale={width}:-2,drawtext=text='#{index}':x=6:y=6:fontsize=22:fontcolor=yellow:box=1:boxcolor=black@0.6",
                       Path(tmp) / f'{n:03d}.jpg')
            name = f'keyframes_{s // per + 1:03d}.jpg'
            ffmpeg('-framerate', '1', '-i', Path(tmp) / '%03d.jpg', '-vf', f'tile={cols}x{rows}', '-frames:v', '1', '-q:v', '3', out / name)
        sheets.append({'sheet': name, 'keyframes': [{'index': kf.ids.index(k), 'id': k} for k in group]})
    (out / 'sheets.json').write_text(json.dumps(sheets, indent=1), encoding='utf-8')
    return {'keyframes': len(kf.ids), 'sheets': len(sheets), 'every': every, 'out': str(out)}


def keyframe_angles(folder, sighting, out, top=12, window=0.5):
    """From `sighting` ('<index or id>:<u>,<v>' in keyframe pixels), every keyframe whose
    camera sees that 3D point without something nearer in front of it (its own depth map),
    ranked by distance and centring; each gets a crop about `window` metres across."""
    kf = Keyframes(folder)
    head, _, pix = sighting.partition(':')
    kid = kf.ids[int(head)] if head.isdigit() and len(head) < 8 else head
    if kid not in kf.ids: raise SystemExit('No keyframe ' + head)
    u, v = (float(x) for x in pix.split(','))
    z = kf.depth_at(kid, u, v) or kf.cam(kid).get('center_depth')
    if not z: raise SystemExit('No depth at that pixel')
    point = kf.unproject(kid, u, v, z)
    seen = []
    for other in kf.ids:
        hit = kf.project(other, point)
        if not hit: continue
        zo = kf.depth_at(other, hit[0], hit[1])
        if zo and zo < hit[2] * 0.85: continue                 # something stands in front
        c = kf.cam(other)
        centred = 1 - math.hypot(hit[0] / c['width'] - 0.5, hit[1] / c['height'] - 0.5) / 0.71
        # ARKit can re-localise between tracking segments; same-segment poses agree best.
        same = c.get('tracking_segment') == kf.cam(kid).get('tracking_segment')
        seen.append({'index': kf.ids.index(other), 'id': other, 'pixel': [round(hit[0]), round(hit[1])], 'distance': round(hit[2], 3),
                     'sameSegment': same, 'score': round(centred / max(0.3, hit[2]) * (2 if same else 1), 4)})
    seen.sort(key=lambda s: -s['score'])
    out.mkdir(parents=True, exist_ok=True)
    for s in seen[:top]:
        c = kf.cam(s['id']); img = kf.image(s['id'])
        if not img: continue
        half = min(max(48, round(c['fx'] * window / s['distance'] / 2)), min(c['width'], c['height']) // 2)
        x0 = min(max(0, s['pixel'][0] - half), c['width'] - 2 * half); y0 = min(max(0, s['pixel'][1] - half), c['height'] - 2 * half)
        s['crop'] = f"kf{s['index']:05d}.jpg"
        ffmpeg('-i', img, '-vf', f'crop={2 * half}:{2 * half}:{x0}:{y0}', '-q:v', '2', out / s['crop'])
    (out / 'angles.json').write_text(json.dumps({'sighting': {'id': kid, 'index': kf.ids.index(kid), 'pixel': [u, v], 'depth': z, 'point': point}, 'seen': seen[:top]}, indent=1), encoding='utf-8')
    return {'sighting': kf.ids.index(kid), 'seenIn': len(seen), 'crops': min(top, len(seen)), 'out': str(out)}


# ---------- documents ----------

def project_root(project):
    """The project's own folder: the one holding the .tiksi, or its parent when the .tiksi
    lives in a "Tiksi" folder inside it (as the app keeps it)."""
    folder = Path(project).resolve().parent
    return folder.parent if folder.name.lower() == 'tiksi' else folder


def fetch_docs(project, brand, model, urls, kinds=None, titles=None, opener=None, resolver=None):
    from server.product_docs import fetch_document, open_url, resolve
    import datetime
    root = project_root(project)
    name = ' '.join(x for x in (brand, model) if x) or 'Product'
    sub = 'Product documents/' + ''.join('-' if ch in '\\/:*?"<>|' or ord(ch) < 32 else ch for ch in name).strip()[:80]
    folder = root / sub
    entries, failed = [], []
    for i, url in enumerate(urls):
        try:
            data, info = fetch_document(url, opener or open_url, resolver or resolve)
        except ValueError as e:
            failed.append({'url': url, 'error': str(e)}); continue
        folder.mkdir(parents=True, exist_ok=True)
        target = folder / info['filename']
        n = 2
        while target.exists() and hashlib.sha256(target.read_bytes()).hexdigest() != info['sha256']:
            target = folder / (Path(info['filename']).stem + f' ({n})' + Path(info['filename']).suffix); n += 1
        target.write_bytes(data)
        title = (titles or [])[i] if titles and i < len(titles) else target.name
        entry = {'kind': (kinds or [])[i] if kinds and i < len(kinds) else None, 'title': title, 'path': str(target.relative_to(root)).replace('\\', '/'),
                 'url': info['url'], 'sha256': info['sha256'], 'bytes': info['bytes'], 'mime': info['mime'],
                 'fetchedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds')}
        (folder / (target.stem + '.SOURCE.txt')).write_text('\n'.join([
            'Document: ' + title, 'Product: ' + name, 'Source: ' + info['url'], 'Fetched: ' + entry['fetchedAt'],
            'SHA-256: ' + info['sha256'], 'Bytes: ' + str(info['bytes']), '']), encoding='utf-8')
        entries.append(entry)
    return {'root': str(root), 'documents': entries, 'failed': failed}


# ---------- 3D models ----------

def convert_model(source, out):
    source, out = Path(source), Path(out)
    ext = source.suffix.lower()
    if ext == '.glb':
        shutil.copyfile(source, out); return {'glb': str(out), 'converter': 'none'}
    if ext == '.skp':
        args = [sys.executable, str(ROOT / 'server/sketchup_convert.py'), str(source), str(out)]; converter = 'SketchUp'
    else:
        blender = shutil.which('blender') or '/Applications/Blender.app/Contents/MacOS/Blender'
        if not Path(blender).exists(): raise SystemExit('Converting ' + ext + ' needs Blender')
        args = [blender, '--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1',
                '--python', str(ROOT / 'server/blender_convert.py'), '--', str(source), str(out)]; converter = 'Blender'
    result = subprocess.run(args, capture_output=True, timeout=600)
    if result.returncode or not out.is_file():
        raise SystemExit('Conversion failed: ' + result.stderr.decode('utf-8', 'replace')[-600:])
    return {'glb': str(out), 'converter': converter, 'source': str(source), 'sourceSha256': hashlib.sha256(source.read_bytes()).hexdigest()}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('photo-tiles'); p.add_argument('paths', nargs='+', type=Path); p.add_argument('--out', type=Path, required=True); p.add_argument('--grid', type=int, default=3)
    p = sub.add_parser('video-sharp'); p.add_argument('video', type=Path); p.add_argument('--out', type=Path, required=True)
    p.add_argument('--every', type=float, default=2.0); p.add_argument('--fps', type=float, default=10); p.add_argument('--start', type=float, default=0); p.add_argument('--end', type=float)
    p = sub.add_parser('keyframe-check'); p.add_argument('keyframes', type=Path)
    p = sub.add_parser('keyframe-sheets'); p.add_argument('keyframes', type=Path); p.add_argument('--out', type=Path, required=True); p.add_argument('--every', type=int, default=10)
    p = sub.add_parser('keyframe-angles'); p.add_argument('keyframes', type=Path); p.add_argument('--sighting', required=True, help='<keyframe index or id>:<u>,<v>')
    p.add_argument('--out', type=Path, required=True); p.add_argument('--top', type=int, default=12); p.add_argument('--window', type=float, default=0.5)
    p = sub.add_parser('fetch-docs'); p.add_argument('--project', type=Path, required=True, help='the .tiksi file; documents go in its project folder')
    p.add_argument('--brand', required=True); p.add_argument('--model', required=True); p.add_argument('urls', nargs='+')
    p.add_argument('--kind', action='append', choices=['spec-sheet', 'installation', 'manual', 'drawing', 'warranty', 'other'])
    p = sub.add_parser('convert-model'); p.add_argument('source', type=Path); p.add_argument('--out', type=Path, required=True)
    a = parser.parse_args(argv)
    if a.command == 'photo-tiles': result = photo_tiles(a.paths, a.out, a.grid)
    elif a.command == 'video-sharp': result = video_sharp(a.video, a.out, a.every, a.fps, start=a.start, end=a.end)
    elif a.command == 'keyframe-check': result = keyframe_check(a.keyframes)
    elif a.command == 'keyframe-sheets': result = keyframe_sheets(a.keyframes, a.out, a.every)
    elif a.command == 'keyframe-angles': result = keyframe_angles(a.keyframes, a.sighting, a.out, a.top, a.window)
    elif a.command == 'fetch-docs': result = fetch_docs(a.project, a.brand, a.model, a.urls, a.kind)
    else: result = convert_model(a.source, a.out)
    print(json.dumps(result, indent=1))


if __name__ == '__main__':
    main()
