"""Open a project's SketchUp mirror in the installed SketchUp.

The browser keeps a project folder through the File System Access API, which never tells
anyone where that folder is. What it can say is the mirror's file name, its size and
modification time, and the names of the folders it sits in. Spotlight finds files by name;
the one whose size and time agree is the browser's file. A path found once comes back from
the browser as a hint and is checked the same way, so a moved folder is simply looked up
again. Without Spotlight (switched off, or the folder not indexed yet) a bounded walk of the
home folder stands in.

Only a person at this Mac can ask: the request must come from loopback to a loopback host.
"""
import ipaddress
import os
from pathlib import Path
import stat
import subprocess
import time
from urllib.parse import urlsplit

MTIME_SLACK_MS = 2000      # FAT and exFAT volumes keep modification times to two seconds
WALK_SECONDS = 4.0
SKIP_DIRS = {'node_modules', '__pycache__'}


class OpenError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def at_this_mac(client_address, host_header):
    """True when a browser on this Mac asked: loopback client and a loopback Host name."""
    try:
        ip = ipaddress.ip_address(str(client_address or '').split('%')[0])
    except ValueError:
        return False
    if ip.version == 6 and ip.ipv4_mapped: ip = ip.ipv4_mapped
    host = urlsplit('//' + (host_header or '')).hostname or ''
    if host != 'localhost' and not host.endswith('.localhost'):
        try:
            if not ipaddress.ip_address(host).is_loopback: return False
        except ValueError:
            return False
    return ip.is_loopback


def sketchup_app():
    """The SketchUp.app whose SDK the mirror uses, or None to let macOS pick the .skp handler."""
    from server.sketchup_convert import library_path
    lib = library_path()
    if not lib: return None
    app = lib.parents[3] if len(lib.parents) > 3 else None   # SketchUp.app/Contents/Frameworks/X.framework/X
    return app if app and app.suffix == '.app' and app.is_dir() else None


def valid_name(name):
    return (isinstance(name, str) and 4 < len(name) <= 255 and name.lower().endswith('.skp')
            and not name.startswith('.') and not any(c in name for c in '/\\\0'))


def spotlight(name):
    escaped = name.replace('\\', '\\\\').replace('"', '\\"').replace('*', '\\*')
    try:
        out = subprocess.run(['mdfind', 'kMDItemFSName == "' + escaped + '"'], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return []
    return [Path(line) for line in out.stdout.splitlines() if line.startswith('/')]


def walk(name, roots, seconds=WALK_SECONDS):
    deadline = time.monotonic() + seconds
    for root in roots:
        for here, dirs, files in os.walk(root):
            if time.monotonic() > deadline: return
            top = Path(here) == Path(root)
            dirs[:] = [d for d in dirs if not d.startswith('.') and d not in SKIP_DIRS and not (top and d == 'Library')]
            if name in files: yield Path(here) / name


def same_file(path, name, size, mtime_ms):
    try:
        st = os.stat(path)
    except OSError:
        return False
    return (path.name == name and stat.S_ISREG(st.st_mode) and st.st_size == size
            and abs(st.st_mtime * 1000 - mtime_ms) <= MTIME_SLACK_MS)


def locate(request, search=spotlight, roots=None):
    """The one file on disk the browser described: { name, size, mtime, folder?, parent?, hint? }."""
    name, size, mtime = request.get('name'), request.get('size'), request.get('mtime')
    if not valid_name(name): raise OpenError('Invalid SketchUp file name')
    if not isinstance(size, int) or isinstance(size, bool) or size <= 0: raise OpenError('Invalid file size')
    if not isinstance(mtime, (int, float)) or isinstance(mtime, bool) or mtime <= 0: raise OpenError('Invalid modification time')
    folder, parent, hint = (request.get(k) if isinstance(request.get(k), str) else '' for k in ('folder', 'parent', 'hint'))

    def score(p):
        return (2 if folder and p.parent.name == folder else 0) + (1 if parent and p.parent.parent.name == parent else 0)

    if hint and os.path.isabs(hint):
        p = Path(hint)
        if same_file(p, name, size, mtime) and (not folder or p.parent.name == folder): return p
    found = []
    for source in (lambda: search(name), lambda: walk(name, roots if roots is not None else [Path.home()])):
        for p in source():
            if p not in found and same_file(p, name, size, mtime): found.append(p)
        if found: break
    if not found:
        raise OpenError('Could not find ' + name + ' on this Mac. If its folder is on a drive Spotlight does not index, open the file in SketchUp yourself.', 404)
    best = max(score(p) for p in found)
    chosen = [p for p in found if score(p) == best]
    if len(chosen) > 1:
        raise OpenError(str(len(chosen)) + ' copies of ' + name + ' match; open the one in the project folder in SketchUp yourself.', 409)
    return chosen[0]


def open_file(path, app, run=subprocess.run):
    args = ['open', '-a', str(app), str(path)] if app else ['open', str(path)]
    try:
        result = run(args, capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired) as e:
        raise OpenError('SketchUp did not open: ' + str(e), 422)
    if result.returncode:
        raise OpenError('SketchUp did not open ' + path.name + ': ' + (result.stderr or '').strip()[:300], 422)


def open_in_sketchup(request, search=spotlight, roots=None, run=subprocess.run, app=None):
    path = locate(request, search, roots)
    app = app if app is not None else sketchup_app()
    open_file(path, app, run)
    return {'path': str(path), 'app': app.stem if app else ''}
