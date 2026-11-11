"""A short fingerprint of the app's served files, so an open page can notice that the Mac now
serves different code (a merge into the checkout the live app serves from) and reload.

The fingerprint covers index.html and every file under js/, css/ and vendor/: each file's
path, size and time modified, never its contents. Reading those for the app's few hundred
files takes a couple of milliseconds; it is done at most once every few seconds, inside the
request that finds the last reading old, and every other request returns the kept value."""
import hashlib
import os
from pathlib import Path
import threading
import time

SERVED_FILES = ('index.html',)
SERVED_FOLDERS = ('js', 'css', 'vendor')


class CodeVersion:
    def __init__(self, root, every=5.0, clock=time.monotonic):
        self.root, self.every, self.clock = Path(root), every, clock
        self.lock = threading.Lock()
        self.current, self.read_at = self.scan(), clock()

    def scan(self):
        rows = []
        def add(path, relative):
            try: info = path.stat()
            except OSError: return
            rows.append(f'{relative}\0{info.st_size}\0{info.st_mtime_ns}')
        for name in SERVED_FILES: add(self.root / name, name)
        for folder in SERVED_FOLDERS:
            for directory, folders, names in os.walk(self.root / folder):
                # Hidden files and folders (.DS_Store, editor spares) are not served.
                folders[:] = [f for f in folders if not f.startswith('.')]
                base = Path(directory)
                for name in names:
                    if not name.startswith('.'): add(base / name, (base / name).relative_to(self.root).as_posix())
        rows.sort()
        return hashlib.sha256('\n'.join(rows).encode('utf-8')).hexdigest()[:16]

    def value(self):
        if self.clock() - self.read_at >= self.every and self.lock.acquire(blocking=False):
            # One request reads the folders again; any that arrive meanwhile get the kept value.
            try:
                if self.clock() - self.read_at >= self.every:
                    self.current, self.read_at = self.scan(), self.clock()
            finally: self.lock.release()
        return self.current
