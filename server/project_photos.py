"""The PHOTOS view reads a project's photos from the project's own folder, where they stay.

Tiksi keeps no copy of these photos. It lists every picture in the project folder and all its
subfolders, sends a photo, or a smaller copy of it, when the page asks, and writes the photos
taken or dropped in Tiksi into the folder's `Photos` folder. What Tiksi knows about a photo (its
notes, its pin in the model, whether it was selected) is kept in the project file with the
photo's path in the folder.

Each picture is in one of three groups, decided by where it sits:
  scan       a keyframe photo of a Polycam raw data export (a folder holding `cameras` and
             `images`); the export's depth and confidence maps are measurements, not pictures,
             and are not listed
  rendering  a picture whose name or folder says render, or in a build folder (`build`,
             `sketchup-build`), where SketchUp build pictures are filed
  photo      everything else
Tiksi's own `Tiksi` folder, hidden files and links are never listed."""
import hashlib
import mimetypes
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import threading
import time

from server.workspace import WorkspaceError, PREVIEW_SIZES, smaller_copy

PICTURES = {'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png', 'webp': 'image/webp', 'avif': 'image/avif',
            'gif': 'image/gif', 'bmp': 'image/bmp', 'heic': 'image/heic', 'heif': 'image/heif', 'tif': 'image/tiff', 'tiff': 'image/tiff'}
MAX_FILES = 50000                 # a project folder with scan exports holds about 10,000 pictures
CAPTURE_PICTURES = ('images', 'corrected_images')
CAPTURE_DATA = ('depth', 'confidence')
# Where photos added in Tiksi go, inside the project folder.
ADD_FOLDERS = ('Photos', 'Photos/Renderings', 'Photos/Scan frames')
MAX_HASH_PATHS = 64
MAX_HASH_BYTES = 4 * 1024 ** 3
RENDER_WORD = re.compile(r'render', re.I)
# A build folder (build, sketchup-build, Wine cellar/build): SketchUp build pictures are filed there.
BUILD_WORD = re.compile(r'(?:^|[^a-z])build(?:$|[^a-z])', re.I)
WRITE_LOCK = threading.Lock()
# The folder's pictures by size, read once for a run of added photos (a move of many at once).
SIZES = {}
SIZES_FOR = 30


def hidden(name): return name.startswith('.') or name in ('Thumbs.db', 'desktop.ini', 'Icon\r')


def extension(name):
    dot = name.rfind('.')
    return name[dot + 1:].lower() if dot > 0 else ''


def key_of(relative):
    """The id a listed photo goes by in the page until Tiksi keeps a record of it."""
    return 'pf-' + hashlib.sha256(relative.encode('utf-8')).hexdigest()[:20]


def group_of(parts, scan):
    if scan or [part.lower() for part in parts[:2]] == ['photos', 'scan frames']: return 'scan'
    if any(BUILD_WORD.search(part) for part in parts[:-1]) or any(RENDER_WORD.search(part) for part in parts): return 'rendering'
    return 'photo'


def list_photos(folder, limit=MAX_FILES):
    """Every picture in the project folder: {'files': [...], 'truncated': bool}. Each file is
    {key, path, name, size, mtime (ms), mime, group}, path relative to the folder with '/'."""
    root = Path(folder).resolve()
    files, truncated = [], False
    captures = set()          # folders holding a Polycam export's keyframe photos
    measurements = set()      # its depth and confidence maps
    for current, names, leaves in os.walk(root, followlinks=False):
        here = Path(current)
        relative_dir = here.relative_to(root)
        keep = []
        for name in names:
            if hidden(name) or (here == root and name == 'Tiksi') or (here / name).is_symlink(): continue
            keep.append(name)
        names[:] = sorted(keep)
        if 'cameras' in names:
            captures.update(here / name for name in CAPTURE_PICTURES if name in names)
            measurements.update(here / name for name in CAPTURE_DATA if name in names)
        if here in measurements:
            names[:] = []; continue
        scan = here in captures
        for name in sorted(leaves):
            ext = extension(name)
            if hidden(name) or ext not in PICTURES: continue
            target = here / name
            try: info = target.lstat()
            except OSError: continue
            if not os.path.isfile(target) or target.is_symlink(): continue
            if len(files) >= limit: truncated = True; break
            relative = (relative_dir / name).as_posix()
            files.append({'key': key_of(relative), 'path': relative, 'name': name, 'size': info.st_size,
                          'mtime': info.st_mtime_ns // 1_000_000, 'mime': PICTURES[ext], 'group': group_of(Path(relative).parts, scan)})
        if truncated: break
    return {'files': files, 'truncated': truncated}


def resolve(folder, relative):
    """The picture at `relative` inside the project folder, refusing anything outside it, a link,
    a hidden file or anything not a picture."""
    if not isinstance(relative, str) or not relative or len(relative) > 1024 or '\0' in relative or relative.startswith(('/', '\\')):
        raise WorkspaceError('Invalid photo path')
    parts = Path(relative).parts
    if any(part in ('..', '.') or hidden(part) for part in parts) or parts[0] == 'Tiksi': raise WorkspaceError('Invalid photo path')
    if extension(parts[-1]) not in PICTURES: raise WorkspaceError('Not a photo', 415)
    root = Path(folder).resolve()
    walk = root
    for part in parts:
        walk = walk / part
        if walk.is_symlink(): raise WorkspaceError('Links are not read', 403)
    if not walk.resolve().is_relative_to(root): raise WorkspaceError('Invalid photo path')
    if not walk.is_file(): raise WorkspaceError(relative + ' is not in the project folder on this Mac', 404)
    return walk


def sha256_of(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as source:
        while chunk := source.read(1024 * 1024): digest.update(chunk)
    return digest.hexdigest()


def tag_of(path):
    info = path.stat()
    return '"' + str(info.st_size) + '-' + str(info.st_mtime_ns) + '"'


def preview(cache, path, longest, run=subprocess.run):
    """A JPEG copy of a folder picture at most `longest` pixels on its longest side, kept in the
    Mac's preview cache under the file's path, size and time (an edited file gets a new copy).
    Returns the copy, or the picture itself when it is no bigger and a browser shows it."""
    if longest not in PREVIEW_SIZES: raise WorkspaceError('Ask for size ' + ', '.join(map(str, PREVIEW_SIZES)))
    info = path.stat()
    name = hashlib.sha256(f'{path}|{info.st_size}|{info.st_mtime_ns}'.encode('utf-8')).hexdigest()
    cache = Path(cache); cache.mkdir(parents=True, exist_ok=True)
    shows = extension(path.name) in ('jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'bmp')
    return smaller_copy(path, cache, name, longest, run, keep_original=shows)


def pixel_size(path, run=subprocess.run):
    """(width, height) read by the Mac's image tool, or None."""
    tool = shutil.which('sips') or ('/usr/bin/sips' if Path('/usr/bin/sips').is_file() else None)
    if not tool: return None
    try: found = run([tool, '-g', 'pixelWidth', '-g', 'pixelHeight', str(path)], capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired): return None
    sizes = [int(v) for v in re.findall(r'pixel(?:Width|Height): (\d+)', found.stdout or '')]
    return tuple(sizes) if not found.returncode and len(sizes) == 2 else None


def describe(folder, path, run=subprocess.run):
    root = Path(folder).resolve()
    info = path.stat()
    size = pixel_size(path, run)
    relative = path.relative_to(root).as_posix()
    scan = path.parent.name in CAPTURE_PICTURES and (path.parent.parent / 'cameras').is_dir()
    return {'path': relative, 'key': key_of(relative), 'group': group_of(Path(relative).parts, scan), 'name': path.name, 'size': info.st_size, 'mtime': info.st_mtime_ns // 1_000_000,
            'mime': PICTURES[extension(path.name)], 'sha256': sha256_of(path), **({'w': size[0], 'h': size[1]} if size else {})}


def hashes(folder, paths):
    """sha256 of each listed picture: {path: hex}. Paths that are not pictures in the folder are left out."""
    if not isinstance(paths, list) or len(paths) > MAX_HASH_PATHS or not all(isinstance(p, str) for p in paths):
        raise WorkspaceError(f'Send at most {MAX_HASH_PATHS} paths')
    out, total = {}, 0
    for relative in dict.fromkeys(paths):
        try: path = resolve(folder, relative)
        except WorkspaceError: continue
        total += path.stat().st_size
        if total > MAX_HASH_BYTES: raise WorkspaceError('Those photos are too large to compare at once', 413)
        out[relative] = sha256_of(path)
    return out


def clean_name(name, mime=''):
    """A file name for a photo written into the folder: its own name, without folders or hidden
    starts, with a picture extension (from its type when it has none)."""
    base = re.sub(r'[\x00-\x1f/\\:]', '-', str(name or '').split('/')[-1].split('\\')[-1]).strip().lstrip('.')[:180]
    ext = extension(base)
    if ext not in PICTURES:
        guess = next((e for e, m in PICTURES.items() if m == mime), None) or (mimetypes.guess_extension(mime or '') or '.jpg').lstrip('.')
        if guess not in PICTURES: guess = 'jpg'
        base = (base or 'Photo') + '.' + guess
    return base


def same_file_in_folder(folder, size, digest):
    """A picture already in the project folder with exactly these bytes, or None. Only files of
    the same size are read, so a large folder is not read through."""
    root = Path(folder).resolve()
    now = time.monotonic()
    seen = SIZES.get(root)
    if not seen or now - seen[0] > SIZES_FOR:
        seen = SIZES[root] = (now, {})
        for found in list_photos(root)['files']: seen[1].setdefault(found['size'], []).append(found['path'])
    candidates = seen[1].get(size, [])[:MAX_HASH_PATHS]
    for found in candidates:
        try:
            if sha256_of(root / found) == digest: return found
        except OSError: continue
    return None


def place(folder, subfolder, name, temp, digest):
    """Put a received photo (`temp`, inside the project folder) into `subfolder` under `name`,
    never over another file. A photo whose exact bytes are already somewhere in the folder is not
    written twice: that file is used. Returns (relative path, whether it was written)."""
    if subfolder not in ADD_FOLDERS: raise WorkspaceError('Photos are added to ' + ' or '.join(ADD_FOLDERS))
    root = Path(folder).resolve()
    size = temp.stat().st_size
    with WRITE_LOCK:
        existing = same_file_in_folder(root, size, digest)
        if existing:
            temp.unlink(missing_ok=True)
            return existing, False
        target_dir = root / subfolder
        target_dir.mkdir(parents=True, exist_ok=True)
        stem, ext = (name.rsplit('.', 1) + [''])[:2]
        target, count = target_dir / name, 1
        while target.exists():
            count += 1
            target = target_dir / f'{stem} ({count}).{ext}'
        os.replace(temp, target)
        relative = target.relative_to(root).as_posix()
        if root in SIZES: SIZES[root][1].setdefault(size, []).append(relative)
        return relative, True


def receive_into(folder, read, length):
    """Copy `length` bytes from read(n) into a hidden spare file in the project folder; returns
    (path, sha256). Nothing is left behind when the upload breaks off."""
    root = Path(folder).resolve()
    digest = hashlib.sha256()
    with tempfile.NamedTemporaryFile(dir=root, prefix='.tiksi-photo-', suffix='.tmp', delete=False) as out:
        temp = Path(out.name)
        try:
            left = length
            while left:
                chunk = read(min(1024 * 1024, left))
                if not chunk: raise WorkspaceError('Upload was truncated')
                out.write(chunk); digest.update(chunk); left -= len(chunk)
            out.flush(); os.fsync(out.fileno())
        except BaseException: out.close(); temp.unlink(missing_ok=True); raise
    return temp, digest.hexdigest()


def copy_into(folder, source):
    """Copy a stored original into a hidden spare file in the project folder; returns (path, sha256)."""
    with open(source, 'rb') as stream:
        return receive_into(folder, stream.read, Path(source).stat().st_size)
