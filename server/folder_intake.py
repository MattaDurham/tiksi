"""A property from a folder: the owner picks a folder on this Mac and Tiksi lists and reads it.

The folder is picked in the Mac's own folder window, which this server opens, so only a person
sitting at the Mac can hand one over. A pick names one folder. Tiksi reads files inside it and
never writes, moves, renames or deletes anything there. The one thing added to the folder is the
project's own `Tiksi` folder, written by the project-file service on the first save."""
from datetime import datetime, timezone
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import threading
import time
from urllib.parse import parse_qs, unquote, urlsplit

MAX_FILES = 20000                 # a site-visit folder is hundreds of files; a home folder is not one
MAX_PICKS = 8                     # folders remembered at once; the oldest is forgotten first
CHOOSE_SECONDS = 600              # how long the Mac's folder window may stay open
CHUNK = 1024 * 1024
PICK_ID = re.compile(r'^[A-Za-z0-9_-]{16,64}$')
PROMPT = 'Choose the folder to make a Tiksi property from'


class FolderError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def choose_folder_on_mac(run=subprocess.run, which=shutil.which):
    """The folder the person picks in the Mac's folder window, or None when they cancel."""
    tool = which('osascript') or ('/usr/bin/osascript' if os.access('/usr/bin/osascript', os.X_OK) else None)
    if not tool: raise FolderError('This computer has no folder window Tiksi can open; choose the folder in the browser instead', 501)
    # `activate` brings the window in front of the browser; without it the window opens behind.
    script = ['-e', 'activate', '-e', 'POSIX path of (choose folder with prompt "' + PROMPT + '")']
    try: result = run([tool, *script], capture_output=True, text=True, timeout=CHOOSE_SECONDS)
    except subprocess.TimeoutExpired: return None
    except OSError as error: raise FolderError('The folder window could not be opened: ' + str(error), 500)
    if result.returncode:
        # -128 is AppleScript's "User canceled".
        if '-128' in (result.stderr or ''): return None
        raise FolderError('The folder window could not be opened: ' + (result.stderr or '').strip()[:300], 500)
    return (result.stdout or '').strip() or None


def hidden(name): return name.startswith('.') or name in ('Thumbs.db', 'desktop.ini', 'Icon\r')


def list_folder(root, limit=MAX_FILES):
    """Every readable file under `root`, as paths relative to it. Hidden files, links and the
    project's own top-level `Tiksi` folder are left out and counted."""
    files, skipped, truncated = [], {'hidden': 0, 'links': 0, 'unreadable': 0, 'tiksi': 0}, False
    def unreadable(error): skipped['unreadable'] += 1
    for folder, names, leaves in os.walk(root, followlinks=False, onerror=unreadable):
        here = Path(folder)
        keep = []
        for name in sorted(names):
            path = here / name
            if hidden(name): skipped['hidden'] += 1
            elif path.is_symlink(): skipped['links'] += 1
            elif here == root and name == 'Tiksi': skipped['tiksi'] += 1
            else: keep.append(name)
        names[:] = keep
        for name in sorted(leaves):
            path = here / name
            if hidden(name): skipped['hidden'] += 1; continue
            if path.is_symlink(): skipped['links'] += 1; continue
            try: info = path.stat()
            except OSError: skipped['unreadable'] += 1; continue
            if not path.is_file(): skipped['unreadable'] += 1; continue
            if len(files) >= limit: truncated = True; break
            files.append({'path': path.relative_to(root).as_posix(), 'size': info.st_size,
                          'modified': datetime.fromtimestamp(info.st_mtime, timezone.utc).isoformat(timespec='seconds')})
        if truncated: break
    files.sort(key=lambda f: f['path'].lower())
    return files, skipped, truncated


class FolderIntakeService:
    def __init__(self, workspace=None, chooser=None):
        self.workspace = workspace
        # Automated checks name the folder through TIKSI_CHOOSE_FOLDER instead of opening a window.
        preset = os.environ.get('TIKSI_CHOOSE_FOLDER')
        self.chooser = chooser or ((lambda: preset or None) if preset is not None else choose_folder_on_mac)
        self.token = secrets.token_urlsafe(32)
        self.lock = threading.Lock()
        self.choosing = threading.Lock()
        self.picks = {}

    def close(self): pass

    @staticmethod
    def at_this_mac(address):
        try:
            ip = ipaddress.ip_address(address)
            if getattr(ip, 'ipv4_mapped', None): ip = ip.ipv4_mapped
            return ip.is_loopback
        except ValueError: return False

    def capabilities(self, address):
        return {'token': self.token, 'choose': self.at_this_mac(address), 'maxFiles': MAX_FILES}

    def check_root(self, chosen):
        if not isinstance(chosen, str) or not chosen or '\0' in chosen or not os.path.isabs(chosen): raise FolderError('That is not a folder on this Mac')
        root = Path(chosen).resolve()
        if not root.is_dir(): raise FolderError('That folder is no longer there', 404)
        home = Path.home().resolve()
        if root == home or root in home.parents:
            raise FolderError('Choose the folder of one site visit, not the whole home folder or disk', 422)
        return root

    def describe(self, identifier, pick):
        files, skipped, truncated = list_folder(pick['root'])
        return {'id': identifier, 'name': pick['root'].name, 'path': str(pick['root']), 'files': files, 'skipped': skipped, 'truncated': truncated}

    def choose(self):
        # One folder window at a time: a second click waits for nothing and says so.
        if not self.choosing.acquire(blocking=False): raise FolderError('A folder window is already open on the Mac', 409)
        try: chosen = self.chooser()
        finally: self.choosing.release()
        if not chosen: return {'cancelled': True}
        root = self.check_root(chosen)
        identifier = secrets.token_urlsafe(18)
        with self.lock:
            self.picks[identifier] = {'root': root, 'at': time.time()}
            while len(self.picks) > MAX_PICKS: self.picks.pop(min(self.picks, key=lambda k: self.picks[k]['at']))
        return self.describe(identifier, self.picks[identifier])

    def pick(self, identifier):
        with self.lock: pick = self.picks.get(identifier) if PICK_ID.fullmatch(identifier or '') else None
        if not pick: raise FolderError('Choose the folder again; Tiksi no longer remembers it', 404)
        if not pick['root'].is_dir(): raise FolderError('That folder is no longer there', 404)
        return pick

    def file(self, identifier, relative):
        """A file inside a picked folder, checked to be a plain visible file under that folder."""
        root = self.pick(identifier)['root']
        if not isinstance(relative, str) or not relative or len(relative) > 2048 or '\0' in relative or '\\' in relative or relative.startswith('/'):
            raise FolderError('Invalid file path')
        parts = relative.split('/')
        if any(part in ('', '.', '..') or hidden(part) for part in parts) or parts[0] == 'Tiksi': raise FolderError('Invalid file path')
        target = root.joinpath(*parts)
        # A link anywhere on the way could lead outside the folder: refuse rather than follow.
        walk = root
        for part in parts:
            walk = walk / part
            if walk.is_symlink(): raise FolderError('Links are not read', 403)
        if not target.resolve().is_relative_to(root): raise FolderError('Invalid file path')
        if not target.is_file(): raise FolderError(relative + ' is no longer in the folder', 404)
        return target

    def keep_in_folder(self, identifier, property_id, name):
        """Plan the project file of a property not saved yet: <picked folder>/Tiksi/<name>.tiksi."""
        root = self.pick(identifier)['root']
        if not self.workspace: raise FolderError('Project files are not kept on this server', 501)
        from server.workspace import WorkspaceError
        try: return {'path': self.workspace.plan_destination(property_id, root / 'Tiksi', name)}
        except WorkspaceError as error: raise FolderError(str(error), error.status)

    def forget(self, identifier):
        with self.lock: self.picks.pop(identifier, None)
        return {}

    # ---------- HTTP ----------
    def dispatch(self, h):
        base = '/api/folder-intake'; split = urlsplit(h.path); path = split.path
        if path != base and not path.startswith(base + '/'): return False
        try:
            from server.peers import trusted_peer
            # Same posture as the project files: this Mac or Tailscale, same origin, a non-simple header.
            if not trusted_peer(h.client_address[0]): raise FolderError('Folders are read only for this Mac or Tailscale', 403)
            origin = h.headers.get('Origin')
            if origin and urlsplit(origin).netloc != h.headers.get('Host'): raise FolderError('Use the Tiksi app on this server', 403)
            if h.headers.get('Sec-Fetch-Site') == 'cross-site': raise FolderError('Cross-site folder requests are refused', 403)
            if h.headers.get('X-Tiksi-Folder') != '1': raise FolderError('Use the Tiksi folder client', 403)
            if path == base + '/capabilities' and h.command == 'GET': return self.reply(h, 200, self.capabilities(h.client_address[0]))
            if not secrets.compare_digest(h.headers.get('X-Tiksi-Token', ''), self.token): raise FolderError('Reconnect to the folder service', 403)
            try: length = int(h.headers.get('Content-Length', '0') or 0)
            except ValueError: raise FolderError('Invalid content length')
            if path == base + '/choose' and h.command == 'POST':
                # The window opens on the Mac's screen, so only a caller at the Mac may ask for it.
                if not self.at_this_mac(h.client_address[0]): raise FolderError('The folder window opens on the Mac; from another device choose the folder in the browser', 403)
                return self.reply(h, 200, self.choose())
            parts = path[len(base):].strip('/').split('/')
            if len(parts) >= 2 and parts[0] == 'picks':
                identifier = parts[1]
                if len(parts) == 2 and h.command == 'GET': return self.reply(h, 200, self.describe(identifier, self.pick(identifier)))
                if len(parts) == 2 and h.command == 'DELETE': return self.reply(h, 200, self.forget(identifier))
                if len(parts) == 3 and parts[2] == 'file' and h.command == 'GET':
                    relative = (parse_qs(split.query, keep_blank_values=True).get('path') or [''])[0]
                    return self.send_file(h, self.file(identifier, relative))
                if len(parts) == 3 and parts[2] == 'keep' and h.command == 'POST':
                    if not 0 < length <= 4096: raise FolderError('Invalid request', 413)
                    try: request = json.loads(h.rfile.read(length))
                    except ValueError: raise FolderError('The request must be JSON')
                    if not isinstance(request, dict) or not isinstance(request.get('propertyId'), str) or not isinstance(request.get('name'), str): raise FolderError('propertyId and name are required')
                    return self.reply(h, 200, self.keep_in_folder(identifier, request['propertyId'], request['name']))
            raise FolderError('Folder endpoint not found', 404)
        except FolderError as e:
            h.close_connection = True
            return self.reply(h, e.status, {'error': str(e)})
        except Exception:
            h.close_connection = True
            return self.reply(h, 500, {'error': 'The folder could not be read; nothing in it was changed.'})

    @staticmethod
    def send_file(h, target):
        size = target.stat().st_size
        with target.open('rb') as source:
            h.send_response(200); h.send_header('Content-Type', 'application/octet-stream'); h.send_header('Content-Length', str(size)); h.send_header('Cache-Control', 'no-store')
            h.end_headers()
            sent = 0
            # Exactly `size` bytes: a file that grows or shrinks while it is read must not leave
            # the connection with a body of another length.
            while sent < size:
                chunk = source.read(min(CHUNK, size - sent))
                if not chunk: h.close_connection = True; break
                h.wfile.write(chunk); sent += len(chunk)
        return True

    @staticmethod
    def reply(h, status, value):
        data = json.dumps(value).encode('utf-8')
        h.send_response(status); h.send_header('Content-Type', 'application/json'); h.send_header('Content-Length', str(len(data))); h.send_header('Cache-Control', 'no-store')
        h.end_headers(); h.wfile.write(data)
        return True
