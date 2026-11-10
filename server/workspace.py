"""Private, revisioned workspace and immutable assets shared by this Mac's clients."""
import ctypes
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import sys
import threading
import tempfile
import time
import zipfile
from urllib.parse import urlsplit

from server.peers import trusted_peer

log = logging.getLogger('tiksi.workspace')
MAX_JSON = 32 * 1024 * 1024
# A save envelope includes shared metadata, portable project slices and, during
# migration, the recovery copy. Each can be valid while their sum exceeds one
# workspace's metadata budget. Keep that budget independent of HTTP transport.
MAX_WORKSPACE_REQUEST = 4 * MAX_JSON
MAX_BLOB = 600 * 1024 * 1024
HASH = re.compile(r'^[a-f0-9]{64}$')
# Pictures saved as files (js/picture-assets.js): a record holds
# `tiksi-picture:<mime>:pic-<sha256>` and the bytes are the blob with that hash.
PICTURE_PREFIX = 'tiksi-picture:'
PICTURE_REF = re.compile(r'^tiksi-picture:([a-z0-9.+-]+/[a-z0-9.+-]+):pic-([a-f0-9]{64})$')
# What this server does beyond the original protocol; clients use only what is listed.
FEATURES = ('picture-files', 'partial-projects', 'partial-properties', 'commit-paths')


def picture_refs(value):
    """Every picture reference in a JSON value: asset id -> mime."""
    found, stack = {}, [value]
    while stack:
        item = stack.pop()
        if isinstance(item, str):
            if item.startswith(PICTURE_PREFIX):
                match = PICTURE_REF.match(item)
                if match: found['pic-' + match[2]] = match[1]
        elif isinstance(item, dict): stack.extend(item.values())
        elif isinstance(item, list): stack.extend(item)
    return found


class WorkspaceError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


# Kinds of file "Open on this Mac" hands to the Mac's default app: documents, pictures,
# videos and drawings or models. Anything else (an app, a script, a shortcut, a web page) is
# shown in Finder instead, so a click never launches a program that ended up in the folder.
DOCUMENT_TYPES = frozenset((
    '.pdf', '.txt', '.md', '.rtf', '.rtfd', '.csv', '.tsv', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
    '.pages', '.numbers', '.key', '.odt', '.ods', '.odp',
    '.jpg', '.jpeg', '.png', '.gif', '.heic', '.heif', '.tif', '.tiff', '.webp', '.bmp', '.dng',
    '.mov', '.mp4', '.m4v',
    '.skp', '.dwg', '.dxf', '.ifc', '.usdz', '.glb', '.gltf', '.obj', '.stl', '.ply', '.3dm', '.e57', '.las', '.laz'))


# Finder flags (in a file's or folder's Finder information) that mark an alias, and a folder
# the Mac treats as one item, a package (an app, a plug-in, a document bundle).
IS_ALIAS, HAS_BUNDLE = 0x8000, 0x2000
# The start of an alias file's contents (a bookmark).
ALIAS_START = b'book\0\0\0\0mark'


def finder_flags(target):
    """The Finder flags of a file or folder; 0 when it has none or this is not a Mac."""
    if sys.platform != 'darwin': return 0
    try:
        libc = ctypes.CDLL(None)
        libc.getxattr.restype = ctypes.c_ssize_t
        libc.getxattr.argtypes = (ctypes.c_char_p, ctypes.c_char_p, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_uint32, ctypes.c_int)
        info = ctypes.create_string_buffer(32)
        size = libc.getxattr(os.fsencode(target), b'com.apple.FinderInfo', info, 32, 0, 0)
        return int.from_bytes(info.raw[8:10], 'big') if size >= 10 else 0
    except (OSError, AttributeError, ValueError): return 0


def opens_directly(target, flags=finder_flags):
    """True for a document, or a plain folder (opened in Finder); False for anything to show in
    Finder only: a program, an alias (even one named like a document) or a package folder."""
    target = Path(target)
    marked = flags(target)
    suffix = target.suffix.lower()
    if target.is_dir():
        # A folder named like a bundle (Example.app, Tool.workflow) is a program to the Mac, and
        # so is one marked as a package or holding an app's contents, whatever its name.
        if suffix[1:].isalpha() or marked & HAS_BUNDLE: return False
        return not ((target / 'Contents' / 'Info.plist').exists() or (target / 'Contents' / 'MacOS').exists())
    if suffix not in DOCUMENT_TYPES or marked & IS_ALIAS: return False
    try:
        with open(target, 'rb') as source: start = source.read(len(ALIAS_START))
    except OSError: return False
    return start != ALIAS_START


def open_in_folder(folder, relative, run=subprocess.run):
    """Open a document or folder inside a project folder with the Mac's default app (Finder for
    folders). Any other kind of file is shown in Finder, selected, and not opened.
    Returns the target and 'opened' or 'shown'."""
    if not isinstance(relative, str) or len(relative) > 1024 or '\0' in relative or relative.startswith(('/', '\\')):
        raise WorkspaceError('Invalid project file path')
    parts = Path(relative).parts
    if any(part in ('..',) for part in parts): raise WorkspaceError('Invalid project file path')
    root = Path(folder).resolve()
    target = (root / relative).resolve()
    if not target.is_relative_to(root): raise WorkspaceError('Invalid project file path')
    if not target.exists(): raise WorkspaceError((relative or 'The project folder') + ' is not in the project folder on this Mac', 404)
    action = 'opened' if target == root or opens_directly(target) else 'shown'
    command = ['open', str(target)] if action == 'opened' else ['open', '-R', str(target)]
    try: result = run(command, capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired) as error: raise WorkspaceError('Could not open ' + target.name + ': ' + str(error), 422)
    if result.returncode: raise WorkspaceError('Could not open ' + target.name + ': ' + (result.stderr or '').strip()[:300], 422)
    return target, action


def write_whole(destination, data):
    """Write bytes through a spare file of its own (hidden, uniquely named) and rename it into
    place, so the file is whole or unchanged, and two writes at once never share a spare file."""
    destination = Path(destination)
    with tempfile.NamedTemporaryFile(dir=destination.parent, prefix='.' + destination.name + '.', suffix='.tmp', delete=False) as out:
        temp = Path(out.name)
        try: out.write(data); out.flush(); os.fsync(out.fileno())
        except BaseException: out.close(); temp.unlink(missing_ok=True); raise
    try: os.replace(temp, destination)
    except BaseException: temp.unlink(missing_ok=True); raise


def file_state(path):
    """'file' for a regular file, 'missing' when nothing is there, 'unreadable' when the Mac
    cannot even look (no permission, a failing drive)."""
    try: info = os.stat(path)
    except (FileNotFoundError, NotADirectoryError, ValueError): return 'missing'
    except OSError: return 'unreadable'
    return 'file' if stat.S_ISREG(info.st_mode) else 'missing'


def replace_in_place(records, belongs, replacement):
    """records with those that belong replaced by replacement, at the place of the first of them."""
    out, placed = [], False
    for record in records:
        if not belongs(record): out.append(record)
        elif not placed: out.extend(replacement); placed = True
    if not placed: out.extend(replacement)
    return out


def project_file_base(name):
    """A property's name as a file name: no path or reserved characters, at most 80 long."""
    return re.sub(r'[\\/:*?"<>|\x00-\x1f]', ' ', str(name)).strip(' .')[:80] or 'Project'


class WorkspaceService:
    run = staticmethod(subprocess.run)

    def __init__(self, root, projects_dir=None):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        (self.root / 'blobs').mkdir(exist_ok=True)
        (self.root / 'history').mkdir(exist_ok=True)
        self.lock = threading.RLock()
        self.jobs = 0
        self.token = secrets.token_urlsafe(32)
        identity = self.root / 'identity'
        if not identity.exists(): identity.write_text(secrets.token_hex(16), encoding='utf-8')
        self.identity = identity.read_text(encoding='utf-8').strip()
        self.path = self.root / 'current.json'
        self.projects_dir = Path(projects_dir or self.root / 'projects').resolve()
        self.projects_dir.mkdir(parents=True, exist_ok=True)
        self.stamps = {}
        self.recover()
        # A damaged store must fail visibly, never become an empty workspace.
        self.state = json.loads(self.path.read_text(encoding='utf-8')) if self.path.exists() else {'revision': 0, 'data': None, 'assets': {}}
        self.paths = self.state.get('paths', {})
        # Registered projects whose file is missing or cannot be read: id -> (path, reason).
        # Only these are left out; every other project keeps loading and saving. Kept with the
        # catalog, so a restart with the same file still missing is no change.
        self.unavailable = {i: tuple(v) for i, v in (self.state.get('unavailable') or {}).items()}
        # Project files as this server last wrote or read them: path -> [mtime_ns, size]. A file
        # that still matches at start is not fingerprinted again, original by original.
        self.known = {name: tuple(v) for name, v in (self.state.get('stamps') or {}).items()}
        # Unreadable registered files and their (mtime, size), so one is not re-read every poll.
        self.unreadable = {}
        self.has_pictures = bool(picture_refs(self.state.get('data')))
        self.stamps = {}
        self.parts = {}
        self.part_assets = {}
        # Where a property made from a picked folder will be kept, until its first save writes it.
        self.planned = {}
        self.refresh()

    def active_jobs(self):
        return self.jobs

    def plan_destination(self, identifier, folder, name):
        """Name the file a property not saved yet will be written to on its first save:
        <folder>/<name>.tiksi. Nothing is written here. A property that already has a file keeps it."""
        if not isinstance(identifier, str) or not 0 < len(identifier) <= 160: raise WorkspaceError('Invalid property')
        with self.lock:
            if identifier in self.paths or identifier in self.state.get('archived', {}): raise WorkspaceError('This property already has a project file', 409)
            base = project_file_base(name)
            taken = {str(Path(p)) for p in list(self.paths.values()) + list(self.state.get('archived', {}).values()) + [v for k, v in self.planned.items() if k != identifier]}
            dest = Path(folder) / (base + '.tiksi')
            count = 1
            # An earlier project file in the same folder is never overwritten.
            while dest.exists() or str(dest) in taken:
                count += 1
                dest = Path(folder) / (base + ' ' + str(count) + '.tiksi')
            self.planned[identifier] = str(dest)
            while len(self.planned) > 64: self.planned.pop(next(iter(self.planned)))
            return str(dest)

    def project_folder(self, identifier):
        # A project file sits in its folder, or in that folder's Tiksi/ subfolder (see refresh).
        folder = Path(self.paths[identifier]).parent
        return folder.parent if folder.name == 'Tiksi' else folder

    def set_aside(self, note, kind):
        """Move an unreadable note into the history folder, kept for inspection, never deleted."""
        aside = self.root / 'history' / ('unreadable-' + kind + '-' + str(time.time_ns()) + '.json')
        os.replace(note, aside)
        log.warning('An unreadable %s was set aside as %s; the project files were not changed by it.', kind.replace('-', ' '), aside)

    @staticmethod
    def read_pairs(files):
        if not isinstance(files, list) or not all(
                isinstance(pair, list) and len(pair) == 2 and all(isinstance(item, str) for item in pair) for pair in files):
            raise ValueError('unexpected file list')
        return files

    def place_files(self, files):
        """Move each finished spare file over its project file. A pair whose spare file and
        project file are both missing (the drive they are on is not mounted, say) is not done
        yet: it is returned, to be done when they appear."""
        left = []
        for source, destination in files:
            if Path(source).exists():
                os.replace(source, destination)
                self.stamps.pop(destination, None)
            # A spare file that is gone while its project file is there was already moved into place.
            elif not Path(destination).exists(): left.append([source, destination])
        return left

    def keep_unplaced(self, left):
        """Record pairs still to be done, together with any recorded earlier."""
        note = self.root / 'pending-files.json'
        held = []
        if note.exists():
            try: held = self.read_pairs(json.loads(note.read_text(encoding='utf-8')))
            except (ValueError, TypeError, UnicodeDecodeError): self.set_aside(note, 'file-note')
        pairs = held + [pair for pair in left if pair not in held]
        if pairs: write_whole(note, json.dumps(pairs).encode('utf-8'))
        elif note.exists(): note.unlink()

    def finish_files(self):
        """Finish the moves an earlier save could not do because their drive was not mounted."""
        note = self.root / 'pending-files.json'
        if not note.exists(): return
        try: pairs = self.read_pairs(json.loads(note.read_text(encoding='utf-8')))
        except (ValueError, TypeError, UnicodeDecodeError):
            self.set_aside(note, 'file-note'); return
        left = self.place_files(pairs)
        if left == pairs: return
        if left: write_whole(note, json.dumps(left).encode('utf-8'))
        else: note.unlink()
        log.info('Finished %d project file move(s) left from an earlier save.', len(pairs) - len(left))

    def recover(self):
        journal = self.root / 'pending.json'
        if not journal.exists(): return False
        try:
            pending = json.loads(journal.read_text(encoding='utf-8'))
            files = self.read_pairs(pending['files'])
            if not isinstance(pending['state'], dict): raise ValueError('unexpected save note')
        except (ValueError, KeyError, TypeError, UnicodeDecodeError):
            # The note is complete before any project file is replaced, so a note that cannot
            # be read means that save never started: every project file is as it was. The
            # note is kept for inspection, and so are the save's spare files.
            self.set_aside(journal, 'save-note')
            return False
        left = self.place_files(files)
        temp = self.root / 'current.tmp'
        with temp.open('w', encoding='utf-8') as out:
            json.dump(pending['state'], out); out.flush(); os.fsync(out.fileno())
        os.replace(temp, self.path)
        # Moves that could not be done yet are recorded before the note goes, and done when
        # their files appear; until then the project shows as unavailable.
        if left:
            self.keep_unplaced(left)
            log.warning('%d project file(s) from the last save are on a drive or folder that is not there; they are moved into place when it is.', len(left))
        journal.unlink()
        return True

    def refresh(self):
        """Project bundles, including external edits, outrank the cached catalog."""
        if self.recover():
            self.state = json.loads(self.path.read_text(encoding='utf-8'))
            self.paths = self.state['paths']
            self.stamps, self.parts, self.part_assets = {}, {}, {}
            self.known = {name: tuple(v) for name, v in (self.state.get('stamps') or {}).items()}
        self.finish_files()
        # A registered file that is not there, or cannot be looked at, marks only its own
        # project unavailable.
        unavailable = {}
        for i, name in self.paths.items():
            found = file_state(name)
            if found != 'file': unavailable[i] = (name, found)
        # If the same project turns up at another path the server scans, that path takes its
        # place, but only when the missing file's folder is still there (it was moved or
        # renamed) or it was in the projects folder. When the folder is gone too, as when the
        # drive it is on is not mounted, the project waits for it.
        replaceable = {i for i, (name, reason) in unavailable.items() if reason == 'missing' and self.moved_away(name)}
        registered = {name: i for i, name in self.paths.items()}
        candidates = set(self.paths.values())
        for directory in (self.projects_dir, *[p for p in self.projects_dir.iterdir() if p.is_dir()]):
            candidates.update(str(p) for p in directory.glob('*.tiksi'))
            candidates.update(str(p) for p in (directory / 'Tiksi').glob('*.tiksi'))
        changed = False
        before = None
        for name in sorted(candidates):
            path = Path(name)
            if file_state(name) != 'file': continue
            stamp = None
            try:
                found = path.stat()
                stamp = (found.st_mtime_ns, found.st_size)
                if name in registered and self.unreadable.get(name) == stamp:
                    unavailable[registered[name]] = (name, 'unreadable'); continue
                if self.stamps.get(name) == stamp: continue
                with zipfile.ZipFile(path) as archive:
                    info = archive.getinfo('workspace.json')
                    if info.file_size > MAX_JSON: raise WorkspaceError('Project metadata exceeds 32 MB', 413)
                    data = json.loads(archive.read(info))
                    if not isinstance(data, dict): raise ValueError('Project metadata is not an object')
                    for key in ('projects', 'materials', 'products'):
                        records = data.get(key, [])
                        if not isinstance(records, list) or not all(isinstance(r, dict) and (key == 'projects' or 'id' in r) for r in records):
                            raise ValueError('Project ' + key + ' are not a list of records')
                    props = data.get('properties', [])
                    if len(props) != 1 or not isinstance(props[0], dict) or not isinstance(props[0].get('id'), str): continue
                    identifier = props[0]['id']
                    if identifier in self.state.get('archived', {}): continue
                    # Explicitly registered file wins over a duplicate backup in another folder,
                    # unless the registered file is gone: then this copy is where it went.
                    if identifier in self.paths and self.paths[identifier] != name and identifier not in replaceable: continue
                    if archive.getinfo('manifest.json').file_size > MAX_JSON: raise WorkspaceError('Project manifest exceeds 32 MB', 413)
                    manifest = json.loads(archive.read('manifest.json'))
                    members = manifest.get('files', [])
                    if len(members) > 10000: raise WorkspaceError('Project contains too many original files', 413)
                    if sum(archive.getinfo(item['path']).file_size for item in members) > 4 * 1024 ** 3: raise WorkspaceError('Project originals exceed 4 GB', 413)
                    assets = {}
                    # This server wrote or read the file at exactly this time and size, so the
                    # fingerprints in its manifest are the ones it checked then.
                    trusted = self.known.get(name) == stamp
                    for item in members:
                        member = archive.getinfo(item['path'])
                        if member.file_size > MAX_BLOB: raise WorkspaceError('Project asset exceeds 600 MB', 413)
                        held = self.root / 'blobs' / str(item.get('hash', ''))
                        if trusted and HASH.fullmatch(str(item.get('hash', ''))) and held.is_file() and held.stat().st_size == member.file_size:
                            digest, size = item['hash'], member.file_size
                        else: digest, size = self.store_member(archive, member)
                        assets[item['id']] = {k: v for k, v in item.items() if k in ('name', 'format', 'mime', 'kind')}
                        assets[item['id']].update(hash=digest, size=size)
            except (zipfile.BadZipFile, KeyError, ValueError, AttributeError, TypeError, OSError) as error:
                # The file is left exactly as it is, and only its own project is set aside. A
                # file whose contents are wrong is read again only once it changes; one the Mac
                # could not read (permission, a failing drive) is tried again on the next look.
                if name in registered:
                    unavailable[registered[name]] = (name, 'unreadable')
                    if stamp is not None and not isinstance(error, OSError): self.unreadable[name] = stamp
                continue
            self.unreadable.pop(name, None)
            unavailable.pop(identifier, None)
            # Whether anything really changed is decided at the end, against the catalog as it was.
            if before is None: before = json.dumps([self.state['data'], self.state['assets'], self.paths], sort_keys=True)
            current = self.state['data']
            if current is None:
                current = {**data, 'properties': [], 'projects': [], 'materials': [], 'products': []}
                self.state['data'] = current
            # A property read again keeps its place in the list; a new one goes at the end.
            current['properties'] = replace_in_place(current['properties'], lambda p: p['id'] == identifier, props)
            current['projects'] = replace_in_place(current['projects'], lambda p: p.get('propertyId') == identifier, data.get('projects', []))
            for key in ('materials', 'products'):
                records = {r['id']: r for r in current[key]}
                records.update({r['id']: r for r in data.get(key, [])})
                current[key] = list(records.values())
            self.state['assets'].update(assets)
            self.paths[identifier] = name
            self.parts[identifier] = data
            self.part_assets[identifier] = assets
            self.stamps[name] = stamp
            self.known[name] = stamp
            changed = True
        if changed and before == json.dumps([self.state['data'], self.state['assets'], self.paths], sort_keys=True):
            # Files read again (after a restart, say) with the same contents: devices need not reload.
            self.persist_catalog()
            changed = False
        for identifier, (name, _) in unavailable.items():
            # Read again in full when it comes back, even with the same time and size.
            self.stamps.pop(name, None)
        if unavailable != self.unavailable:
            # Every device sees the change on its next poll: the project leaves, or returns.
            self.unavailable = unavailable
            changed = True
        if changed:
            self.state['revision'] += 1
            self.has_pictures = bool(picture_refs(self.state['data']))
            self.persist_catalog()

    def moved_away(self, name):
        """True when a missing project file's folder is still there, or the file was in the
        projects folder: then a copy found elsewhere is where it went."""
        old = Path(name)
        try: return old.parent.is_dir() or old.is_relative_to(self.projects_dir)
        except (OSError, ValueError): return False

    def persist_catalog(self):
        self.state['paths'] = self.paths
        self.state['unavailable'] = {i: list(v) for i, v in self.unavailable.items()}
        live = set(self.paths.values())
        self.state['stamps'] = {name: list(v) for name, v in self.known.items() if name in live}
        temp = self.root / 'current.tmp'
        with temp.open('w', encoding='utf-8') as out:
            json.dump(self.state, out, ensure_ascii=False)
            out.flush()
            os.fsync(out.fileno())
        os.replace(temp, self.path)

    def store_member(self, archive, member):
        """Fingerprint one original in a project file; copy it into the blob store only when the
        store does not hold it yet."""
        digest = hashlib.sha256()
        with archive.open(member) as source:
            while chunk := source.read(1024 * 1024): digest.update(chunk)
        held = self.root / 'blobs' / digest.hexdigest()
        if held.is_file() and held.stat().st_size == member.file_size: return digest.hexdigest(), member.file_size
        with archive.open(member) as source: return self.store_blob(source)

    def store_blob(self, source):
        digest = hashlib.sha256()
        size = 0
        temp = None
        try:
            with tempfile.NamedTemporaryFile(dir=self.root / 'blobs', delete=False) as out:
                temp = Path(out.name)
                while chunk := source.read(1024 * 1024):
                    size += len(chunk)
                    if size > MAX_BLOB: raise WorkspaceError('Asset exceeds 600 MB', 413)
                    digest.update(chunk)
                    out.write(chunk)
                out.flush()
                os.fsync(out.fileno())
            result = digest.hexdigest()
            dest = self.root / 'blobs' / result
            if dest.exists(): temp.unlink()
            else: os.replace(temp, dest)
            return result, size
        finally:
            if temp is not None and temp.exists(): temp.unlink()

    def picture_assets(self, data, assets):
        """Manifest entries for every picture `data` references; each file must be stored."""
        entries = {}
        for identifier, mime in picture_refs(data).items():
            digest = identifier.removeprefix('pic-')
            path = self.root / 'blobs' / digest
            if not path.is_file(): raise WorkspaceError('Upload every referenced picture before saving')
            given = assets.get(identifier)
            if given is not None and (not isinstance(given, dict) or given.get('hash') != digest): raise WorkspaceError('Invalid picture reference')
            entries[identifier] = {'mime': mime, 'kind': 'picture', **(given or {}), 'hash': digest, 'size': path.stat().st_size}
        return entries

    def unavailable_projects(self):
        """What the page is told about each project left out: its name, the path, and why."""
        names = {p.get('id'): p.get('name') for p in (self.state.get('data') or {}).get('properties', []) if isinstance(p, dict)}
        out = []
        for identifier, (path, reason) in sorted(self.unavailable.items()):
            name = names.get(identifier) or Path(path).stem
            if reason == 'missing': message = name + ': the project file is not at ' + path + '. Put it back, or reconnect the drive it is on; the other projects keep saving.'
            else: message = name + ': the project file at ' + path + ' cannot be read. It has been left exactly as it is; the other projects keep saving.'
            out.append({'id': identifier, 'name': name, 'path': path, 'reason': reason, 'message': message})
        return out

    def visible_paths(self):
        return {i: name for i, name in self.paths.items() if i not in self.unavailable}

    def snapshot(self):
        with self.lock:
            self.refresh()
            value = {k: json.loads(json.dumps(self.state.get(k))) for k in ('revision', 'data', 'assets')}
            value['paths'] = self.visible_paths()
            data = value['data']
            if data and self.unavailable:
                # A project whose file is not readable is left out, so no device can edit a copy
                # of it that would have nowhere to be saved. It comes back when its file does.
                data['properties'] = [p for p in data.get('properties', []) if p.get('id') not in self.unavailable]
                data['projects'] = [p for p in data.get('projects', []) if p.get('propertyId') not in self.unavailable]
            value['unavailable'] = self.unavailable_projects()
            return value

    @staticmethod
    def check_records(data):
        if not isinstance(data, dict) or not all(isinstance(data.get(k), list) for k in ('properties', 'projects', 'materials', 'products')) or not isinstance(data.get('settings'), dict):
            raise WorkspaceError('Invalid workspace')
        for key in ('properties', 'projects', 'materials', 'products'):
            records = data[key]
            if any(not isinstance(p, dict) or not isinstance(p.get('id'), str) or not 0 < len(p['id']) <= 160 for p in records) or len({p['id'] for p in records}) != len(records):
                raise WorkspaceError('Workspace records need unique valid identities')

    def check_assets(self, data, assets):
        if not isinstance(assets, dict) or len(assets) > 100000:
            raise WorkspaceError('Invalid asset manifest')
        pictures = self.picture_assets(data, assets)
        assets = {**assets, **pictures}
        for identifier, asset in assets.items():
            if not isinstance(identifier, str) or not 0 < len(identifier) <= 160 or not isinstance(asset, dict) or not HASH.fullmatch(str(asset.get('hash', ''))):
                raise WorkspaceError('Invalid asset reference')
            path = self.root / 'blobs' / asset['hash']
            if not path.is_file() or asset.get('size') != path.stat().st_size:
                raise WorkspaceError('Upload every referenced asset before saving')
        return pictures, assets

    @staticmethod
    def resend(message):
        error = WorkspaceError(message + '; sending them again', 409)
        error.code = 'resend-projects'
        return error

    def commit(self, request):
        if not isinstance(request, dict) or type(request.get('revision')) is not int:
            raise WorkspaceError('A base revision is required')
        data, assets = request.get('data'), request.get('assets')
        self.check_records(data)
        order = request.get('propertyOrder')
        if order is not None and (not isinstance(order, list) or not all(isinstance(i, str) for i in order) or len(set(order)) != len(order) or not {p['id'] for p in data['properties']} <= set(order)):
            raise WorkspaceError('Invalid property order')
        with self.lock:
            self.refresh()
            if request['revision'] != self.state['revision']:
                raise WorkspaceError('Workspace changed on another device', 409)
            if order is not None:
                # Properties the client did not change since this revision are named, not
                # sent: the revision check above makes the held record exactly the client's.
                held = {p['id']: p for p in (self.state.get('data') or {}).get('properties', [])}
                sent = {p['id']: p for p in data['properties']}
                if any(i not in sent and i not in held for i in order): raise self.resend('Projects changed on disk')
                data = {**data, 'properties': [sent.get(i) or held[i] for i in order]}
                self.check_records(data)
            pictures, assets = self.check_assets(data, assets)
            # A tab running an older Tiksi would read picture references as broken images
            # and save them blank. It must reload before it can write.
            if (pictures or self.has_pictures) and request.get('pictureFiles') is not True:
                raise WorkspaceError('This Tiksi tab is out of date; reload it to keep saving', 426)
            value = {'revision': self.state['revision'] + 1, 'data': data, 'assets': assets}
            encoded = json.dumps(value, ensure_ascii=False).encode('utf-8')
            if len(encoded) > MAX_JSON: raise WorkspaceError('Workspace metadata exceeds 32 MB', 413)
            if self.path.exists():
                # Keep every committed revision for recovery; assets are never garbage-collected here.
                history = self.root / 'history' / (str(self.state['revision']) + '.json')
                self.keep_history(history)
            slices = request.get('projectData')
            # A project file the client did not change since the revision it saved against
            # is named instead of sent; the server already holds exactly that file.
            unchanged = request.get('unchangedProjects', [])
            if not isinstance(slices, dict) or not isinstance(unchanged, list) or not all(isinstance(i, str) for i in unchanged) or set(slices) & set(unchanged) or len(set(unchanged)) != len(unchanged) or set(slices) | set(unchanged) != {p.get('id') for p in data['properties']}:
                raise WorkspaceError('Every project must have a complete project file')
            by_id = {p['id']: p for p in data['properties']}
            for identifier in unchanged:
                held = self.parts.get(identifier)
                if not isinstance(held, dict) or held.get('properties') != [by_id[identifier]]:
                    raise self.resend('Project files changed on disk')
            slices = {**{i: self.parts[i] for i in unchanged}, **slices}
            migration = request.get('migration')
            if migration:
                self.archive_copy(migration, 'browser-migration')
            staged = []
            destinations = {}
            try:
                for prop in data['properties']:
                    identifier = prop['id']
                    part = slices[identifier]
                    if not isinstance(part, dict) or part.get('properties') != [prop]: raise WorkspaceError('Project file does not match workspace')
                    if identifier in self.unavailable:
                        # Its file is missing or unreadable: nothing is written at that path. A
                        # device that still had the project and changed it gets its copy kept
                        # in the server's recovery copies; the rest of the save goes ahead.
                        destinations[identifier] = self.paths[identifier]
                        relevant = {i: assets[i] for i in self.referenced(part) if i in assets}
                        if self.parts.get(identifier) != part or self.part_assets.get(identifier) != relevant:
                            self.archive_copy({'data': part, 'assets': relevant}, 'unavailable-project')
                        continue
                    base = project_file_base(prop.get('name', 'Project'))
                    folder = self.projects_dir / (base + '-' + hashlib.sha256(identifier.encode()).hexdigest()[:8])
                    dest = Path(self.paths.get(identifier) or self.state.get('archived', {}).get(identifier) or self.planned.get(identifier) or str(folder / (base + '.tiksi')))
                    destinations[identifier] = str(dest)
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    files = self.referenced(part)
                    relevant = {i: assets[i] for i in files if i in assets}
                    if self.parts.get(identifier) == part and self.part_assets.get(identifier) == relevant: continue
                    # The bundle itself contains every available original. The blob directory
                    # is a rebuildable transport cache, never the only copy of a saved asset.
                    with tempfile.NamedTemporaryFile(dir=dest.parent, suffix='.tmp', delete=False) as out:
                        temp = Path(out.name)
                    staged.append((temp, dest, identifier))
                    self.bundle(temp, part, relevant)
                    # History stores metadata revisions against immutable original blobs,
                    # avoiding a full copy of a large scan on every note/geometry edit.
                # All files are complete before replacing any canonical file. A durable
                # journal lets startup finish a multi-project commit after interruption.
                # A project left out while its file is unavailable keeps its registered path.
                value['paths'] = {**{i: name for i, (name, _) in self.unavailable.items()}, **destinations}
                value['archived'] = {**self.state.get('archived', {}), **{i: name for i, name in self.paths.items() if i not in slices and i not in self.unavailable}}
                for i in slices: value['archived'].pop(i, None)
                journal = self.root / 'pending.json'
                # The note is written in full to a spare file and then renamed, so a crash or a
                # full disk leaves either the whole note or none.
                note = self.root / 'pending.tmp'
                try:
                    with note.open('w', encoding='utf-8') as out:
                        json.dump({'state': value, 'files': [[str(a), str(b)] for a, b, _ in staged]}, out)
                        out.flush(); os.fsync(out.fileno())
                    os.replace(note, journal)
                finally:
                    if note.exists(): note.unlink()
                for temp, dest, identifier in staged:
                    os.replace(temp, dest)
                    self.stamps[str(dest)] = self.known[str(dest)] = (dest.stat().st_mtime_ns, dest.stat().st_size)
                self.state, self.paths = value, value['paths']
                for i in destinations: self.planned.pop(i, None)
                self.has_pictures = bool(pictures)
                held_parts, held_assets = self.parts, self.part_assets
                self.parts = {i: (held_parts[i] if i in self.unavailable and i in held_parts else part) for i, part in slices.items()}
                self.part_assets = {i: (held_assets.get(i, {}) if i in self.unavailable and i in held_parts else {k: assets[k] for k in self.referenced(part) if k in assets}) for i, part in slices.items()}
                saved = value['revision']
                if any(i in self.unavailable for i in slices):
                    # One more revision, so the device that sent an unavailable project reads
                    # the workspace again and sees that project left out, with its message.
                    self.state = {**value, 'revision': saved + 1}
                self.persist_catalog()
                journal.unlink()
            finally:
                for temp, _, _ in staged:
                    if temp.exists() and not (self.root / 'pending.json').exists(): temp.unlink()
            return saved

    def keep_history(self, history):
        """Copy the catalog into history, whole or not at all. A copy left half written by an
        earlier failure is set aside (never deleted) and written again."""
        if history.exists():
            try:
                json.loads(history.read_text(encoding='utf-8'))
                return
            except (ValueError, UnicodeDecodeError):
                os.replace(history, history.with_name(history.stem + '.unreadable-' + str(time.time_ns()) + '.json'))
        write_whole(history, self.path.read_bytes())

    def archive_copy(self, record, label='conflict'):
        """Preserve a declined/uncommitted variant without changing canonical data."""
        with self.lock:
            if not isinstance(record, dict) or not isinstance(record.get('data'), dict) or not isinstance(record.get('assets'), dict): raise WorkspaceError('Invalid recovery copy')
            if len(json.dumps(record['data'], ensure_ascii=False).encode()) > MAX_JSON: raise WorkspaceError('Recovery metadata exceeds 32 MB', 413)
            record = {**record, 'assets': {**record['assets'], **self.picture_assets(record['data'], record['assets'])}}
            for asset in record['assets'].values():
                if not isinstance(asset, dict) or not HASH.fullmatch(str(asset.get('hash', ''))): raise WorkspaceError('Invalid recovery asset')
                path = self.root / 'blobs' / asset['hash']
                if not path.is_file() or path.stat().st_size != asset.get('size'): raise WorkspaceError('Incomplete recovery asset')
            tag = hashlib.sha256(json.dumps(record, sort_keys=True).encode()).hexdigest()
            destination = self.root / 'history' / (label + '-' + tag + '.tiksi')
            if not destination.exists():
                with tempfile.NamedTemporaryFile(dir=destination.parent, suffix='.tmp', delete=False) as out: temp = Path(out.name)
                try:
                    self.bundle(temp, record['data'], record['assets'], 'tiksi-bundle')
                    os.replace(temp, destination)
                finally:
                    if temp.exists(): temp.unlink()
            return destination.name

    def bundle(self, destination, data, assets, format='tiksi-project'):
        entries = [{**asset, 'id': i, 'path': 'files/' + hashlib.sha256(i.encode()).hexdigest() + '.bin'} for i, asset in assets.items()]
        with zipfile.ZipFile(destination, 'w', zipfile.ZIP_STORED) as archive:
            archive.writestr('workspace.json', json.dumps(data, ensure_ascii=False))
            archive.writestr('manifest.json', json.dumps({'format': format, 'version': 1, 'app': 'tiksi', 'files': entries}))
            for entry in entries: archive.write(self.root / 'blobs' / entry['hash'], entry['path'])
        with Path(destination).open('rb') as saved: os.fsync(saved.fileno())

    @staticmethod
    def referenced(data):
        ids = set()
        for prop in data.get('properties', []):
            for scan in prop.get('scans', []):
                ids.add(scan['id'])
                if scan.get('originalFileId'): ids.add(scan['originalFileId'])
            ids.update(p['id'] for p in prop.get('photos', []))
            # Walk-through videos and the frames saved with tape readings are originals too.
            ids.update(v['id'] for v in prop.get('videos', []) if isinstance(v, dict) and isinstance(v.get('id'), str))
            ids.update(m['frameAssetId'] for m in prop.get('measurements', []) if isinstance(m, dict) and isinstance(m.get('frameAssetId'), str))
        # Pictures anywhere in the project's records (thumbnails, plan underlays, product images).
        ids.update(picture_refs(data))
        return ids

    def check_available(self, identifier):
        with self.lock:
            self.refresh()
            if identifier in self.unavailable:
                found = next(p for p in self.unavailable_projects() if p['id'] == identifier)
                error = WorkspaceError(found['message'], 409)
                error.code = 'project-unavailable'
                raise error

    # One definition of a trusted caller, shared with the server's own check (tools/serve.py).
    trusted_peer = staticmethod(trusted_peer)

    def dispatch(self, h):
        path = urlsplit(h.path).path
        if path != '/api/workspace' and not path.startswith('/api/workspace/'): return False
        with self.lock: self.jobs += 1
        try:
            if not self.trusted_peer(h.client_address[0]): raise WorkspaceError('Workspace access requires this Mac or Tailscale', 403)
            origin = h.headers.get('Origin')
            if origin and urlsplit(origin).netloc != h.headers.get('Host'): raise WorkspaceError('Use the Tiksi app on this server', 403)
            # Even reads require a non-simple header. Cross-origin websites cannot read or
            # seed private state, including when fetch metadata is absent on HTTP origins.
            if h.headers.get('X-Tiksi-Workspace') != '1': raise WorkspaceError('Use the Tiksi workspace client', 403)
            if path == '/api/workspace/capabilities' and h.command == 'GET':
                self.reply(h, 200, {'instanceId': self.identity, 'token': self.token, 'storage': 'project-files', 'projectsFolder': str(self.projects_dir), 'features': list(FEATURES)})
                return True
            if not secrets.compare_digest(h.headers.get('X-Tiksi-Token', ''), self.token): raise WorkspaceError('Reconnect to the workspace server', 403)
            if path == '/api/workspace/head' and h.command == 'GET':
                with self.lock:
                    self.refresh()
                    revision = self.state['revision']
                self.reply(h, 200, {'revision': revision})
            elif path == '/api/workspace' and h.command == 'GET':
                self.reply(h, 200, self.snapshot())
            elif path == '/api/workspace' and h.command == 'PUT':
                payload = self.read(h, MAX_WORKSPACE_REQUEST)
                try: request = json.loads(payload)
                except (ValueError, UnicodeDecodeError): raise WorkspaceError('Workspace must be JSON')
                revision = self.commit(request)
                with self.lock: paths, unavailable = self.visible_paths(), self.unavailable_projects()
                self.reply(h, 200, {'revision': revision, 'paths': paths, 'unavailable': unavailable})
            elif path == '/api/workspace/recovery' and h.command == 'POST':
                payload = self.read(h, MAX_WORKSPACE_REQUEST)
                try: record = json.loads(payload)
                except (ValueError, UnicodeDecodeError): raise WorkspaceError('Recovery copy must be JSON')
                self.reply(h, 200, {'recovery': self.archive_copy(record)})
            elif path == '/api/workspace/blobs' and h.command == 'POST':
                length = self.length(h, MAX_BLOB)
                class Upload:
                    remaining = length
                    def read(self, amount):
                        if not self.remaining: return b''
                        data = h.rfile.read(min(amount, self.remaining))
                        if not data: raise WorkspaceError('Upload was truncated')
                        self.remaining -= len(data)
                        return data
                digest, size = self.store_blob(Upload())
                self.reply(h, 200, {'hash': digest, 'size': size})
            elif path.startswith('/api/workspace/mirror/'):
                from server.sketchup_open import at_this_mac
                identifier = path.removeprefix('/api/workspace/mirror/')
                action = identifier.rsplit('/', 1)[-1]
                if action in ('state', 'open', 'info'): identifier = identifier.rsplit('/', 1)[0]
                if identifier not in self.paths: raise WorkspaceError('Project not found', 404)
                self.check_available(identifier)
                source = Path(self.paths[identifier])
                model = source.with_suffix('.skp')
                state_path = source.parent / ('.' + source.stem + '.mirror.json')
                if action == 'info' and h.command == 'GET':
                    self.reply(h, 200, {'file': source.name, 'exists': model.exists(), 'size': model.stat().st_size if model.exists() else 0, 'mtime': str(model.stat().st_mtime_ns) if model.exists() else '0'})
                elif action == 'state':
                    if h.command == 'PUT':
                        value = json.loads(self.read(h, MAX_JSON))
                        write_whole(state_path, json.dumps(value).encode('utf-8'))
                    value = json.loads(state_path.read_text(encoding='utf-8')) if state_path.exists() else {'file': source.name}
                    self.reply(h, 200, value)
                elif action == 'open' and h.command == 'POST':
                    if not at_this_mac(h.client_address[0], h.headers.get('Host')): raise WorkspaceError('Open SketchUp on the Mac; the model remains viewable here', 403)
                    if not model.exists(): raise WorkspaceError('The SketchUp mirror has not been created yet', 404)
                    service = getattr(h.server, 'model_conversion', None)
                    if service is None: raise WorkspaceError('SketchUp service unavailable', 422)
                    from server.sketchup_open import OpenError
                    try: opened = service.open_sketchup({'name': model.name, 'size': model.stat().st_size, 'mtime': model.stat().st_mtime * 1000, 'folder': model.parent.name, 'hint': str(model)})
                    except OpenError as error: raise WorkspaceError(str(error), error.status)
                    self.reply(h, 200, {'file': model.name, **opened})
                elif h.command == 'GET':
                    if not model.exists(): raise WorkspaceError('Mirror not found', 404)
                    h.send_response(200); h.send_header('Content-Type', 'application/octet-stream'); h.send_header('Content-Length', str(model.stat().st_size)); h.send_header('X-File-Mtime', str(model.stat().st_mtime_ns)); h.send_header('Cache-Control', 'no-store'); h.end_headers()
                    with model.open('rb') as source:
                        while chunk := source.read(1024 * 1024): h.wfile.write(chunk)
                elif h.command == 'PUT':
                    stamp = lambda: str(model.stat().st_mtime_ns) if model.exists() else '0'
                    if h.headers.get('X-File-Mtime') != stamp(): raise WorkspaceError('SketchUp model changed; retry before overwriting', 409)
                    # The model is received into a spare file of its own beside it, never held
                    # whole in memory, and renamed into place only if nobody changed it meanwhile.
                    temp = self.receive(h, MAX_BLOB, model)
                    try:
                        with self.lock:
                            if h.headers.get('X-File-Mtime') != stamp(): raise WorkspaceError('SketchUp model changed; retry before overwriting', 409)
                            os.replace(temp, model)
                    finally: temp.unlink(missing_ok=True)
                    self.reply(h, 200, {})
                else: raise WorkspaceError('Mirror endpoint not found', 404)
            elif path.startswith('/api/workspace/open/') and h.command == 'POST':
                # Product documents and the project folder, opened in Finder or Preview on this Mac.
                from server.sketchup_open import at_this_mac
                identifier = path.removeprefix('/api/workspace/open/')
                if identifier not in self.paths: raise WorkspaceError('This property has no project folder yet; save it to disk first', 404)
                self.check_available(identifier)
                if not at_this_mac(h.client_address[0], h.headers.get('Host')): raise WorkspaceError('Project files open on the Mac running Tiksi; use Tiksi at localhost on that Mac', 422)
                try: request = json.loads(self.read(h, 64 * 1024))
                except (ValueError, UnicodeDecodeError): raise WorkspaceError('Open request must be JSON')
                if not isinstance(request, dict): raise WorkspaceError('Open request must be an object')
                target, action = open_in_folder(self.project_folder(identifier), request.get('path', ''), self.run)
                # action is 'opened', or 'shown' when the file is not a document and was only shown in Finder.
                self.reply(h, 200, {'path': str(target.relative_to(self.project_folder(identifier).resolve())), 'folder': self.project_folder(identifier).name, 'action': action})
            elif path.startswith('/api/workspace/blobs/') and h.command == 'GET':
                digest = path.removeprefix('/api/workspace/blobs/')
                if not HASH.fullmatch(digest): raise WorkspaceError('Asset not found', 404)
                dest = self.root / 'blobs' / digest
                if not dest.is_file(): raise WorkspaceError('Asset not found', 404)
                # A blob is named by its content and never changes: this browser may keep it.
                tag = '"' + digest + '"'
                if tag in [t.strip() for t in h.headers.get('If-None-Match', '').split(',')]:
                    h.send_response(304)
                    h.send_header('ETag', tag)
                    h.send_header('Cache-Control', 'private, max-age=31536000, immutable')
                    h.end_headers()
                    return True
                h.send_response(200)
                h.send_header('Content-Type', 'application/octet-stream')
                h.send_header('Content-Length', str(dest.stat().st_size))
                h.send_header('ETag', tag)
                h.send_header('Cache-Control', 'private, max-age=31536000, immutable')
                h.end_headers()
                with dest.open('rb') as source:
                    while chunk := source.read(1024 * 1024): h.wfile.write(chunk)
            else: raise WorkspaceError('Workspace endpoint not found', 404)
        except WorkspaceError as error:
            h.close_connection = True
            self.reply(h, error.status, {'error': str(error), **({'code': error.code} if getattr(error, 'code', None) else {})})
        except (OSError, ValueError, TypeError, KeyError):
            # The page gets a plain sentence; the server log gets the real error and where it happened.
            log.exception('Project files could not be updated (%s %s)', h.command, path)
            h.close_connection = True
            self.reply(h, 500, {'error': 'Project files could not be updated. Existing copies and recovery data have been preserved.'})
        finally:
            with self.lock: self.jobs -= 1
        return True

    @staticmethod
    def length(h, limit):
        try: length = int(h.headers.get('Content-Length', '0'))
        except ValueError: raise WorkspaceError('Invalid content length')
        if not 0 < length <= limit: raise WorkspaceError('Upload exceeds the workspace limit', 413)
        h.connection.settimeout(120)
        return length

    @classmethod
    def receive(cls, h, limit, destination):
        """Copy a request body into a hidden spare file beside destination, in pieces, flushed to
        disk; the caller renames it into place. Nothing is left behind if the upload breaks off."""
        length = cls.length(h, limit)
        destination = Path(destination)
        with tempfile.NamedTemporaryFile(dir=destination.parent, prefix='.' + destination.name + '.', suffix='.tmp', delete=False) as out:
            temp = Path(out.name)
            try:
                left = length
                while left:
                    chunk = h.rfile.read(min(1024 * 1024, left))
                    if not chunk: raise WorkspaceError('Upload was truncated')
                    out.write(chunk); left -= len(chunk)
                out.flush(); os.fsync(out.fileno())
            except BaseException: out.close(); temp.unlink(missing_ok=True); raise
        return temp

    @classmethod
    def read(cls, h, limit):
        length = cls.length(h, limit)
        data = h.rfile.read(length)
        if len(data) != length: raise WorkspaceError('Upload was truncated')
        return data

    @staticmethod
    def reply(h, status, value):
        data = json.dumps(value).encode('utf-8')
        h.send_response(status)
        h.send_header('Content-Type', 'application/json')
        h.send_header('Content-Length', str(len(data)))
        h.send_header('Cache-Control', 'no-store')
        h.end_headers()
        h.wfile.write(data)
