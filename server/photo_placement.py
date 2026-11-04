"""Automatic photo placement against a Polycam "raw data" keyframe export.

Given ordinary site photos, find the camera each one was taken from, in model coordinates:
SIFT features of the photo are matched against the export's keyframes, matched keyframe
features are lifted to 3D through the keyframes' LiDAR depth maps, and PnP with RANSAC
solves the photo's pose.

The web server side of this file is standard library only. The heavy work runs in a separate
process with the optional NumPy + OpenCV runtime that tools/install-photo-placement.py puts in
ignored instance state (`<state>/photo-placement/venv`), sandboxed on macOS (no network, writes
only to its job folder and the keyframe descriptor cache). Photos sent by the browser are kept
only while their job runs; keyframe descriptors are a derived, disposable cache keyed by the
export's path and file times. The export itself is only read."""
import base64
import binascii
import hashlib
import json
import math
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import threading
import time
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent.parent
INSTALL = 'python3 tools/install-photo-placement.py'
MAX_BODY = 60 * 1024 * 1024        # 50 photos of about 1 MB each in base64, with headroom
MAX_PHOTOS = 50
MAX_SIDE = 2048                    # the browser sends long side <= 1600; a little slack for rounding
MAX_JOBS = 20                      # retained job records; photos are removed when a job ends
MAX_STRIDE = 64
DEFAULT_STRIDE = 4
JOB_TIMEOUT = 30 * 60
CACHE_EXPORTS = 4                  # descriptor caches kept for this many exports, least recent dropped
JOB_ID = re.compile(r'^[a-f0-9]{32}$')
TERMINAL = {'done', 'failed', 'cancelled'}
# Matching and solving. Keyframes are 1024 x 768; depth maps 256 x 192 millimetres.
SIFT_FEATURES = 3000
RATIO = 0.75
RETRIEVAL_FEATURES = 800           # strongest lifted features per keyframe used to rank keyframes
SHORTLIST = 16                     # keyframes verified geometrically before the best are pooled
TOP_KEYFRAMES = 6
MIN_INLIERS = 30
# A pose that explains under a quarter of the pooled matches was wrong in the real-export check
# (58 cm off with 15%); every correct one there explained 38% or more.
MIN_INLIER_SHARE = 0.25
DEPTH_RANGE = (0.2, 5.0)           # metres
# ARKit depth confidence is stored as 0 / medium / 255. SIFT keypoints sit on texture and edges,
# where confidence is rarely high: on a real export only 36% of keypoints had 255, against 99%
# with any confidence, and accepting medium doubled the photos placed at the same accuracy.
CONFIDENCE_MIN = 1
CONTRAST = 0.02                    # SIFT contrast threshold; 0.04 (the default) starves dim rooms
DEPTH_EDGE = 0.04                  # reject depth samples whose 3x3 neighbourhood varies by more than 4%
REPROJECTION = 0.006               # RANSAC threshold as a fraction of the photo's long side
CACHE_VERSION = f'sift{SIFT_FEATURES}-c{CONTRAST}-conf{CONFIDENCE_MIN}-edge{DEPTH_EDGE}-v1'


class PlacementError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def count(value):
    return isinstance(value, int) and not isinstance(value, bool)


def decode_jpeg(text):
    if not isinstance(text, str) or not text: raise PlacementError('Each photo needs its JPEG as base64 text')
    if text.startswith('data:'):
        head, _, text = text.partition(',')
        if ';base64' not in head: raise PlacementError('Photo data URLs must be base64')
    try: data = base64.b64decode(text, validate=True)
    except (binascii.Error, ValueError): raise PlacementError('A photo is not valid base64')
    if not data.startswith(b'\xff\xd8\xff'): raise PlacementError('Photos must be JPEG images')
    return data


def validate(payload, roots):
    """Check a job request; returns (export Path, sessions, photos with bytes, stride).
    `roots` are the folders scans may be read from: the projects folder and every folder that
    holds a project file this server keeps. Unknown fields are ignored; known fields of the wrong
    type are refused."""
    if not isinstance(payload, dict): raise PlacementError('Expected a JSON object')
    if isinstance(roots, (str, os.PathLike)): roots = [roots]
    roots = [Path(r).resolve() for r in (roots or [])]
    if not roots:
        raise PlacementError('Photo placement reads scans only from project folders, and this server knows none', 422)
    export = payload.get('exportDir')
    if not isinstance(export, str) or not export or '\0' in export: raise PlacementError('exportDir must be the path of a Polycam raw export folder')
    if not os.path.isabs(export): raise PlacementError('exportDir must be an absolute path')
    folder = Path(export).resolve()
    if not any(folder.is_relative_to(r) for r in roots): raise PlacementError('exportDir must be inside a Tiksi project folder on this Mac')
    if not folder.is_dir(): raise PlacementError('exportDir does not exist', 404)
    missing = [name for name in ('cameras', 'images', 'depth') if not (folder / name).is_dir()]
    if missing: raise PlacementError('exportDir is not a Polycam raw export: missing ' + ', '.join(n + '/' for n in missing))
    sessions = payload.get('sessions')
    if not isinstance(sessions, dict) or not sessions: raise PlacementError('sessions must map at least one tracking segment to a 4x4 matrix')
    clean = {}
    for key, matrix in sessions.items():
        if not re.fullmatch(r'\d{1,4}', key): raise PlacementError('sessions keys must be tracking segment numbers')
        if not isinstance(matrix, list) or len(matrix) != 16 or not all(finite(v) for v in matrix): raise PlacementError('Each session must be 16 finite numbers (row-major 4x4)')
        clean[str(int(key))] = [float(v) for v in matrix]
    photos = payload.get('photos')
    if not isinstance(photos, list) or not photos: raise PlacementError('photos must be a non-empty list')
    if len(photos) > MAX_PHOTOS: raise PlacementError(f'At most {MAX_PHOTOS} photos can be placed in one job', 413)
    out, seen = [], set()
    for photo in photos:
        if not isinstance(photo, dict): raise PlacementError('Each photo must be an object')
        identifier, name = photo.get('id'), photo.get('name', '')
        if not isinstance(identifier, str) or not 0 < len(identifier) <= 200: raise PlacementError('Each photo needs an id string')
        if identifier in seen: raise PlacementError('Photo ids must be unique')
        seen.add(identifier)
        if not isinstance(name, str): raise PlacementError('Photo names must be strings')
        w, h = photo.get('w'), photo.get('h')
        if not (count(w) and count(h) and 16 <= w <= MAX_SIDE and 16 <= h <= MAX_SIDE): raise PlacementError(f'Photo w and h must be whole pixels up to {MAX_SIDE}')
        fx, fy, cx, cy = (photo.get(k) for k in ('fx', 'fy', 'cx', 'cy'))
        if not all(finite(v) for v in (fx, fy, cx, cy)) or fx <= 0 or fy <= 0: raise PlacementError('Photo intrinsics fx, fy, cx, cy must be numbers, with fx and fy positive')
        taken = photo.get('takenAt')
        if taken is not None and not isinstance(taken, str): raise PlacementError('takenAt must be an ISO 8601 string or null')
        out.append({'id': identifier, 'name': name[:300], 'w': w, 'h': h, 'fx': float(fx), 'fy': float(fy), 'cx': float(cx), 'cy': float(cy),
                    'takenAt': taken, 'jpeg': decode_jpeg(photo.get('jpeg'))})
    options = payload.get('options', {})
    if options is None: options = {}
    if not isinstance(options, dict): raise PlacementError('options must be an object')
    stride = options.get('stride', DEFAULT_STRIDE)
    if not count(stride) or not 1 <= stride <= MAX_STRIDE: raise PlacementError(f'options.stride must be a whole number from 1 to {MAX_STRIDE}')
    return folder, clean, out, stride


class PhotoPlacementService:
    def __init__(self, root, projects_dir=None, python=None, worker_command=None, project_folders=None):
        self.root = Path(root).resolve(); self.root.mkdir(parents=True, exist_ok=True)
        (self.root / 'jobs').mkdir(exist_ok=True); (self.root / 'cache').mkdir(exist_ok=True)
        self.projects_dir = Path(projects_dir).resolve() if projects_dir else None
        # The folders of the project files the workspace keeps (each property's own folder).
        self.project_folders = project_folders or (lambda: [])
        # TIKSI_PHOTO_PLACEMENT_PYTHON names another interpreter that has numpy and cv2.
        self.python = Path(python or os.environ.get('TIKSI_PHOTO_PLACEMENT_PYTHON') or self.root / 'venv/bin/python')
        # Explicit process seam for portable tests; HTTP callers cannot configure it.
        self.worker_command = list(worker_command) if worker_command else None
        self.token = secrets.token_urlsafe(32)
        self.lock = threading.RLock(); self.worker = threading.Lock(); self.checking = threading.Lock()
        self.jobs = {}; self.processes = {}; self.threads = {}; self.closed = False
        self.runtime = None; self.checked = 0.0
        for folder in (self.root / 'jobs').iterdir():
            if not folder.is_dir() or not JOB_ID.fullmatch(folder.name): continue
            try:
                job = json.loads((folder / 'job.json').read_text(encoding='utf-8'))
                if job['id'] != folder.name or not isinstance(job.get('progress'), dict) or not isinstance(job.get('results'), list): raise ValueError
            except (OSError, ValueError, KeyError, TypeError): shutil.rmtree(folder, ignore_errors=True); continue
            if job.get('status') not in TERMINAL:
                job.update(status='failed', error='Tiksi restarted before this placement finished; run it again')
            shutil.rmtree(folder / 'photos', ignore_errors=True)
            self.jobs[job['id']] = job; self.save(job)

    # ---------- availability ----------
    def roots(self):
        try: extra = [Path(p) for p in self.project_folders()]
        except Exception: extra = []
        return ([self.projects_dir] if self.projects_dir else []) + extra

    def availability(self):
        if not self.roots():
            return False, 'Photo placement reads Polycam exports from project folders, and this server knows none yet. Save the project to a folder first.'
        if self.worker_command: return True, ''
        if not self.python.is_file():
            return False, f'Photo placement needs its local NumPy + OpenCV runtime. Run {INSTALL} on the Mac running Tiksi.'
        with self.checking:   # not the job lock: the first check can take seconds
            # A working runtime is remembered; a broken one is checked again after a minute.
            if self.runtime is None or (not self.runtime[0] and time.time() - self.checked > 60):
                try:
                    check = subprocess.run([str(self.python), '-I', '-c', 'import cv2, numpy; cv2.SIFT_create()'], capture_output=True, timeout=60)
                    self.runtime = (check.returncode == 0, '' if check.returncode == 0 else f'The photo placement runtime is broken (OpenCV did not load). Run {INSTALL} again.')
                except (OSError, subprocess.TimeoutExpired):
                    self.runtime = (False, f'The photo placement runtime did not start. Run {INSTALL} again.')
                self.checked = time.time()
            return self.runtime

    def capabilities(self):
        available, reason = self.availability()
        return {'available': available, 'reason': reason, 'install': INSTALL, 'token': self.token,
                'maxPhotos': MAX_PHOTOS, 'maxBytes': MAX_BODY, 'maxSide': MAX_SIDE, 'stride': DEFAULT_STRIDE}

    def active_jobs(self):
        with self.lock: return sum(1 for job in self.jobs.values() if job['status'] not in TERMINAL)

    # ---------- job records ----------
    def save(self, job):
        folder = self.root / 'jobs' / job['id']
        try:
            temp = folder / 'job.tmp'; temp.write_text(json.dumps(job, allow_nan=False), encoding='utf-8'); os.replace(temp, folder / 'job.json')
        except FileNotFoundError: pass   # removed while the worker was finishing

    @staticmethod
    def public(job):
        return {key: json.loads(json.dumps(job[key])) for key in ('id', 'status', 'progress', 'results', 'error')}

    def job(self, identifier):
        job = self.jobs.get(identifier) if JOB_ID.fullmatch(identifier or '') else None
        if not job: raise PlacementError('Photo placement job not found', 404)
        return job

    def create(self, payload):
        if self.closed: raise PlacementError('Tiksi is shutting down', 503)
        available, reason = self.availability()
        if not available: raise PlacementError(reason, 503)
        export, sessions, photos, stride = validate(payload, self.roots())
        with self.lock:
            if len(self.jobs) >= MAX_JOBS:
                finished = sorted((j for j in self.jobs.values() if j['status'] in TERMINAL), key=lambda j: j.get('createdAt', 0))
                for old in finished[:len(self.jobs) - MAX_JOBS + 1]:
                    shutil.rmtree(self.root / 'jobs' / old['id'], ignore_errors=True); self.jobs.pop(old['id'], None)
            if len(self.jobs) >= MAX_JOBS: raise PlacementError('Too many photo placements are waiting; wait for one to finish', 409)
            identifier = secrets.token_hex(16)
            folder = self.root / 'jobs' / identifier
            (folder / 'photos').mkdir(parents=True)
            request = {'exportDir': str(export), 'sessions': sessions, 'stride': stride, 'photos': []}
            for index, photo in enumerate(photos):
                file = f'{index:03d}.jpg'
                (folder / 'photos' / file).write_bytes(photo.pop('jpeg'))
                request['photos'].append({**photo, 'file': file})
            (folder / 'request.json').write_text(json.dumps(request), encoding='utf-8')
            job = {'id': identifier, 'status': 'queued', 'progress': {'done': 0, 'total': len(photos), 'stage': 'Waiting for another placement to finish'},
                   'results': [], 'error': None, 'createdAt': time.time(), 'photos': len(photos)}
            self.jobs[identifier] = job; self.save(job)
            thread = threading.Thread(target=self.run, args=(identifier,), name='tiksi-photo-placement', daemon=True)
            self.threads[identifier] = thread; thread.start()
            return {'id': identifier, 'status': 'queued'}

    def cancel(self, identifier):
        """DELETE: a queued or running job is cancelled and kept; a finished one is removed."""
        with self.lock:
            job = self.job(identifier)
            if job['status'] in TERMINAL:
                if identifier in self.processes: raise PlacementError('Wait for the worker to stop before removing this job', 409)
                shutil.rmtree(self.root / 'jobs' / identifier, ignore_errors=True); self.jobs.pop(identifier, None)
                return {**self.public(job), 'removed': True}
            job.update(status='cancelled', error=None); job['progress']['stage'] = 'Cancelled'; self.save(job)
            process = self.processes.get(identifier)
            if process and process.poll() is None: process.terminate()
            return self.public(job)

    def close(self):
        with self.lock:
            self.closed = True
            for identifier, process in self.processes.items():
                if process.poll() is None: process.kill()
                job = self.jobs.get(identifier)
                if job and job['status'] not in TERMINAL: job.update(status='failed', error='Tiksi shut down before this placement finished'); self.save(job)
            threads = list(self.threads.values())
        for thread in threads: thread.join(5)

    # ---------- worker process ----------
    def command(self, folder, cache):
        if self.worker_command: return self.worker_command + [str(folder), str(cache)]
        return [str(self.python), '-I', str(Path(__file__).resolve()), 'worker', str(folder), str(cache)]

    def sandboxed(self, args, folder, cache, export):
        sandbox = shutil.which('sandbox-exec') if sys.platform == 'darwin' and not self.worker_command else None
        if not sandbox: return args
        quote = lambda path: json.dumps(str(Path(path).resolve()))
        reads = [folder, cache, export, Path(__file__).resolve().parent, self.python.parent.parent, self.python.resolve().parent.parent]
        profile = ('(version 1)(allow default)(deny network*)(deny file-write*)(allow file-write* (subpath ' + quote(folder) + ') (subpath ' + quote(cache) + ') (literal "/dev/null"))'
                   '(deny file-read-data (subpath "/Users") (subpath "/Volumes") (subpath "/private/var/folders"))(allow file-read-data '
                   + ' '.join('(subpath ' + quote(p) + ')' for p in reads) + ')')
        return [sandbox, '-p', profile, *args]

    def evict_cache(self, keep):
        caches = sorted((p for p in (self.root / 'cache').iterdir() if p.is_dir() and p.name != keep), key=lambda p: p.stat().st_mtime, reverse=True)
        for old in caches[CACHE_EXPORTS - 1:]: shutil.rmtree(old, ignore_errors=True)

    def run(self, identifier):
        with self.worker:
            folder = self.root / 'jobs' / identifier
            with self.lock:
                job = self.jobs.get(identifier)
                if not job or job['status'] != 'queued' or self.closed: self.threads.pop(identifier, None); return
                request = json.loads((folder / 'request.json').read_text(encoding='utf-8'))
                cache_key = hashlib.sha256(request['exportDir'].encode('utf-8')).hexdigest()[:24]
                cache = self.root / 'cache' / cache_key; cache.mkdir(exist_ok=True); os.utime(cache)
                self.evict_cache(cache_key)
                job['status'] = 'running'; job['progress'] = {'done': 0, 'total': job['photos'], 'stage': 'Starting'}; self.save(job)
                env = {'PATH': '/usr/bin:/bin', 'TMPDIR': str(folder), 'LC_ALL': 'C', 'OPENCV_LOG_LEVEL': 'ERROR', 'OMP_NUM_THREADS': str(max(1, (os.cpu_count() or 2) - 1))}
                args = self.sandboxed(self.command(folder, cache), folder, cache, Path(request['exportDir']))
                log = (folder / 'worker.log').open('wb')
                try:
                    process = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=log, cwd=folder, env=env, text=True, encoding='utf-8')
                except OSError:
                    log.close(); job.update(status='failed', error='The photo placement worker could not be started'); self.save(job); return
                self.processes[identifier] = process
            expired = threading.Event()
            def expire(): expired.set(); process.kill()
            timer = threading.Timer(JOB_TIMEOUT, expire); timer.daemon = True; timer.start()
            failure = None
            try:
                for line in process.stdout:
                    if not line.startswith('TIKSI '): continue
                    try: event = json.loads(line[6:])
                    except ValueError: continue
                    with self.lock:
                        if job['status'] != 'running': continue
                        if isinstance(event.get('progress'), dict):
                            p = event['progress']
                            job['progress'] = {'done': int(p.get('done', 0)), 'total': int(p.get('total', 0)), 'stage': str(p.get('stage', ''))[:200]}
                        if isinstance(event.get('result'), dict): job['results'].append(event['result'])
                        if event.get('error'): failure = str(event['error'])[:1000]
                        self.save(job)
                code = process.wait()
            finally:
                timer.cancel(); log.close(); process.stdout.close()
                if process.poll() is None: process.kill(); process.wait()
            with self.lock:
                self.processes.pop(identifier, None)
                shutil.rmtree(folder / 'photos', ignore_errors=True)
                if job['status'] == 'running':
                    if expired.is_set(): job.update(status='failed', error='Photo placement exceeded its 30-minute limit; try fewer photos or a larger stride')
                    elif code or failure:
                        tail = (folder / 'worker.log').read_text(encoding='utf-8', errors='replace').strip().splitlines()[-1:] if (folder / 'worker.log').is_file() else []
                        job.update(status='failed', error=failure or ('Photo placement stopped unexpectedly' + (': ' + tail[0][:300] if tail else '')))
                    else:
                        job['status'] = 'done'; job['progress'] = {'done': job['photos'], 'total': job['photos'], 'stage': 'Done'}
                    job['finishedAt'] = time.time()
                    self.save(job)
                self.threads.pop(identifier, None)

    # ---------- HTTP ----------
    def dispatch(self, h):
        base = '/api/photo-placement'; path = urlsplit(h.path).path
        if path != base and not path.startswith(base + '/'): return False
        try:
            from server.workspace import WorkspaceService
            # Same posture as the workspace: this Mac or Tailscale, same origin, a non-simple header.
            if not WorkspaceService.trusted_peer(h.client_address[0]): raise PlacementError('Photo placement requires this Mac or Tailscale', 403)
            origin = h.headers.get('Origin')
            if origin and urlsplit(origin).netloc != h.headers.get('Host'): raise PlacementError('Use the Tiksi app on this server', 403)
            if h.headers.get('Sec-Fetch-Site') == 'cross-site': raise PlacementError('Cross-site photo placement requests are refused', 403)
            if path == base + '/capabilities' and h.command == 'GET': return self.reply(h, 200, self.capabilities())
            if not secrets.compare_digest(h.headers.get('X-Tiksi-Token', ''), self.token): raise PlacementError('Reconnect to the photo placement service', 403)
            if path == base + '/jobs' and h.command == 'POST':
                if h.headers.get('Transfer-Encoding'): raise PlacementError('Chunked request bodies are not supported', 411)
                try: length = int(h.headers.get('Content-Length', ''))
                except ValueError: raise PlacementError('Content-Length is required', 411)
                if not 0 < length <= MAX_BODY: raise PlacementError('A placement request must be smaller than 60 MB', 413)
                h.connection.settimeout(120)
                data = h.rfile.read(length)
                if len(data) != length: raise PlacementError('The request ended early')
                try: payload = json.loads(data)
                except (ValueError, UnicodeDecodeError): raise PlacementError('The request must be JSON')
                return self.reply(h, 202, self.create(payload))
            parts = path[len(base):].strip('/').split('/')
            if len(parts) == 2 and parts[0] == 'jobs':
                if h.command == 'GET':
                    with self.lock: return self.reply(h, 200, self.public(self.job(parts[1])))
                if h.command == 'DELETE': return self.reply(h, 200, self.cancel(parts[1]))
            raise PlacementError('Photo placement endpoint not found', 404)
        except PlacementError as e:
            h.close_connection = True   # a refused upload may leave unread bytes
            return self.reply(h, e.status, {'error': str(e)})
        except Exception:
            h.close_connection = True
            return self.reply(h, 500, {'error': 'Photo placement failed; the scan and photos are unchanged.'})

    @staticmethod
    def reply(h, status, value):
        data = json.dumps(value, allow_nan=False).encode('utf-8')
        h.send_response(status); h.send_header('Content-Type', 'application/json'); h.send_header('Content-Length', str(len(data)))
        h.send_header('Cache-Control', 'no-store'); h.end_headers(); h.wfile.write(data)
        return True


# =====================================================================================
# Worker: runs inside the NumPy + OpenCV runtime, never inside the web server.
# =====================================================================================

def three_pose(rvec, tvec):
    """OpenCV world->camera (x right, y down, z forward) to a row-major camera->model matrix
    in three.js camera axes (x right, y up, looking down -z)."""
    import cv2
    import numpy as np
    R, _ = cv2.Rodrigues(np.asarray(rvec, dtype=np.float64))
    t = np.asarray(tvec, dtype=np.float64).reshape(3)
    Rcw = R.T; C = -Rcw @ t
    M = np.eye(4); M[:3, :3] = Rcw @ np.diag([1.0, -1.0, -1.0]); M[:3, 3] = C
    return [float(v) for v in M.reshape(-1)]


def read_keyframes(export, sessions):
    """Sorted keyframes whose tracking segment has a session matrix."""
    frames = []
    for path in sorted((export / 'cameras').glob('*.json')):
        try: camera = json.loads(path.read_text(encoding='utf-8'))
        except (OSError, ValueError): continue
        segment = str(int(camera.get('tracking_segment', 0) or 0))
        if segment not in sessions: continue
        try:
            pose = [[float(camera[f't_{r}{c}']) for c in range(4)] for r in range(3)]
            intr = [float(camera[k]) for k in ('fx', 'fy', 'cx', 'cy')]
            size = (int(camera.get('width') or 0), int(camera.get('height') or 0))
        except (KeyError, TypeError, ValueError): continue
        frames.append({'stem': path.stem, 'segment': segment, 'pose': pose, 'intrinsics': intr, 'size': size,
                       'blur': float(camera.get('blur_score') or 0.0)})
    return frames


def candidates(frames, stride, exclude=()):
    """One keyframe per run of `stride`: the sharpest. Polycam's blur_score rises with image
    detail (on a real export it ranks like the Laplacian variance, Spearman +0.81), so the
    highest score is kept."""
    excluded = set(exclude); picked = []
    for start in range(0, len(frames), stride):
        window = [f for f in frames[start:start + stride] if f['stem'] not in excluded]
        if window: picked.append(max(window, key=lambda f: f['blur']))
    return picked


def describe(export, frame, cache, sift):
    """SIFT features of one keyframe that have trustworthy depth, lifted to Polycam world.
    Cached on disk; returns (world points float32 (N,3), descriptors uint8 (N,128))."""
    import cv2
    import numpy as np
    stem = frame['stem']
    files = [export / 'cameras' / (stem + '.json'), export / 'images' / (stem + '.jpg'), export / 'depth' / (stem + '.png'), export / 'confidence' / (stem + '.png')]
    signature = CACHE_VERSION + '|' + '|'.join(f'{p.name}:{p.stat().st_mtime_ns}:{p.stat().st_size}' if p.is_file() else f'{p.name}:-' for p in files)
    target = cache / (stem + '.npz')
    if target.is_file():
        try:
            with np.load(target, allow_pickle=False) as data:
                if str(data['signature']) == signature: return data['points'], data['descriptors']
        except (OSError, ValueError, KeyError): pass
    image = cv2.imread(str(files[1]), cv2.IMREAD_GRAYSCALE)
    depth = cv2.imread(str(files[2]), cv2.IMREAD_UNCHANGED)
    points, descriptors = np.zeros((0, 3), np.float32), np.zeros((0, 128), np.uint8)
    if image is not None and depth is not None and depth.ndim == 2:
        confidence = cv2.imread(str(files[3]), cv2.IMREAD_UNCHANGED) if files[3].is_file() else None
        keypoints, desc = sift.detectAndCompute(image, None)
        if keypoints and desc is not None:
            ih, iw = image.shape
            fx, fy, cx, cy = frame['intrinsics']
            if frame['size'][0] and frame['size'][0] != iw:   # intrinsics are for the camera JSON's width/height
                s = iw / frame['size'][0]; fx, fy, cx, cy = fx * s, fy * s, cx * s, cy * s
            metres = depth.astype(np.float32) / 1000.0
            valid = (metres >= DEPTH_RANGE[0]) & (metres <= DEPTH_RANGE[1])
            if confidence is not None and confidence.shape == depth.shape: valid &= confidence >= CONFIDENCE_MIN
            kernel = np.ones((3, 3), np.uint8)
            high = cv2.dilate(np.where(valid, metres, 0).astype(np.float32), kernel)
            low = cv2.erode(np.where(valid, metres, 1e6).astype(np.float32), kernel)
            valid &= (high - low) <= DEPTH_EDGE * metres
            uv = np.array([k.pt for k in keypoints], np.float64)
            response = np.array([k.response for k in keypoints])
            dh, dw = depth.shape
            j = np.clip(np.round((uv[:, 0] + 0.5) * dw / iw - 0.5).astype(int), 0, dw - 1)
            i = np.clip(np.round((uv[:, 1] + 0.5) * dh / ih - 0.5).astype(int), 0, dh - 1)
            keep = valid[i, j]
            d = metres[i, j][keep].astype(np.float64); u, v = uv[keep, 0], uv[keep, 1]
            camera = np.stack([(u - cx) / fx * d, -(v - cy) / fy * d, -d, np.ones_like(d)], axis=1)   # ARKit camera axes
            world = camera @ np.asarray(frame['pose'], np.float64).T
            order = np.argsort(-response[keep])
            points = world[order].astype(np.float32)
            descriptors = np.clip(np.round(desc[keep][order]), 0, 255).astype(np.uint8)
    temp = cache / (stem + '.tmp.npz')
    np.savez(temp, signature=np.array(signature), points=points, descriptors=descriptors)
    os.replace(temp, target)
    return points, descriptors


def root_sift(descriptors):
    """RootSIFT (L1 normalise, square root): Euclidean distance then compares like the
    Hellinger kernel, which on the real export kept more correct matches than plain SIFT."""
    import numpy as np
    d = np.asarray(descriptors, np.float32)
    return np.sqrt(d / (d.sum(axis=1, keepdims=True) + 1e-7))


def solve(object_points, image_points, K, long_side, iterations=4000, subset=None):
    """RANSAC PnP (on `subset` when given) then Levenberg-Marquardt refinement, re-collecting
    inliers among all the points. Returns (rvec, tvec, inlier indices, rms px) or None."""
    import cv2
    import numpy as np
    if len(object_points) < 6: return None
    threshold = max(2.0, REPROJECTION * long_side)
    obj = np.ascontiguousarray(object_points, np.float64).reshape(-1, 1, 3)
    img = np.ascontiguousarray(image_points, np.float64).reshape(-1, 1, 2)
    pick = np.arange(len(obj)) if subset is None else np.asarray(subset)
    if len(pick) < 6: return None
    # MAGSAC++ held up best when most matches are wrong (wide baselines on a dim, noisy scan).
    params = cv2.UsacParams(); params.threshold = threshold; params.confidence = 0.9999; params.maxIterations = iterations
    params.score = cv2.SCORE_METHOD_MAGSAC; params.loMethod = cv2.LOCAL_OPTIM_SIGMA; params.sampler = cv2.SAMPLING_UNIFORM
    try: found = cv2.solvePnPRansac(obj[pick], img[pick], K, None, params=params)
    except cv2.error: return None
    ok, rvec, tvec, inliers = found[0], found[-3], found[-2], found[-1]
    if not ok or inliers is None or len(inliers) < 6: return None
    index = pick[inliers.reshape(-1)]
    for _ in range(2):   # refine, then re-collect inliers at the same threshold against the refined pose
        rvec, tvec = cv2.solvePnPRefineLM(obj[index], img[index], K, None, rvec, tvec)
        projected, _ = cv2.projectPoints(obj, rvec, tvec, K, None)
        error = np.linalg.norm(projected.reshape(-1, 2) - img.reshape(-1, 2), axis=1)
        # Points behind the camera can project inside the image; never count them.
        depth = (cv2.Rodrigues(rvec)[0] @ obj.reshape(-1, 3).T + tvec.reshape(3, 1))[2]
        index = np.nonzero((error < threshold) & (depth > 0))[0]
        if len(index) < 6: return None
    rms = float(np.sqrt(np.mean(error[index] ** 2)))
    return rvec, tvec, index, rms


def place(request, photos_dir, cache, emit=lambda event: None, exclude=()):
    """Place every photo of a job request. Results are emitted as they are found and returned."""
    import cv2
    import numpy as np
    export = Path(request['exportDir'])
    sessions = {k: np.asarray(v, np.float64).reshape(4, 4) for k, v in request['sessions'].items()}
    emit({'progress': {'done': 0, 'total': len(request['photos']), 'stage': 'Reading keyframes'}})
    frames = read_keyframes(export, sessions)
    picked = candidates(frames, int(request.get('stride') or DEFAULT_STRIDE), exclude)
    if not picked: raise PlacementError('No keyframes belong to the listed tracking segments')
    sift = cv2.SIFT_create(nfeatures=SIFT_FEATURES, contrastThreshold=CONTRAST)
    started = time.time(); library = []
    for n, frame in enumerate(picked):
        if n % 10 == 0: emit({'progress': {'done': n, 'total': len(picked), 'stage': 'Describing keyframes'}})
        points, descriptors = describe(export, frame, cache, sift)
        if len(points) < 12: continue
        S = sessions[frame['segment']]
        model = (np.hstack([points.astype(np.float64), np.ones((len(points), 1))]) @ S.T)[:, :3]
        library.append({'stem': frame['stem'], 'model': model, 'descriptors': descriptors})
    describe_seconds = time.time() - started
    if not library: raise PlacementError('No keyframe has usable depth; check that the export includes depth/ maps')
    # Retrieval: each keyframe's strongest features, ratio-tested against the photo (kf -> photo).
    owners = np.concatenate([np.full(min(RETRIEVAL_FEATURES, len(k['descriptors'])), n, np.int32) for n, k in enumerate(library)])
    retrieval = np.concatenate([k['descriptors'][:RETRIEVAL_FEATURES] for k in library])   # uint8; converted in blocks
    matcher = cv2.BFMatcher(cv2.NORM_L2)
    results = []
    for n, photo in enumerate(request['photos']):
        emit({'progress': {'done': n, 'total': len(request['photos']), 'stage': 'Placing photos'}})
        t0 = time.time()
        result = {'id': photo['id'], 'ok': False, 'pose': None, **{k: photo[k] for k in ('fx', 'fy', 'cx', 'cy', 'w', 'h')},
                  'inliers': 0, 'matches': 0, 'rmsPx': None, 'keyframes': [], 'reason': ''}
        try:
            result.update(place_one(photo, photos_dir, library, owners, retrieval, matcher, sift))
        except Exception as error:   # one unreadable photo never stops the others
            result['reason'] = 'Placement failed: ' + str(error)[:200]
        result['seconds'] = round(time.time() - t0, 2)
        results.append(result); emit({'result': result})
    emit({'progress': {'done': len(request['photos']), 'total': len(request['photos']), 'stage': 'Done'}, 'describeSeconds': round(describe_seconds, 2)})
    return results


def place_one(photo, photos_dir, library, owners, retrieval, matcher, sift):
    import cv2
    import numpy as np
    image = cv2.imread(str(Path(photos_dir) / photo['file']), cv2.IMREAD_GRAYSCALE)
    if image is None: return {'reason': 'The photo could not be decoded'}
    h, w = image.shape
    fx, fy, cx, cy = photo['fx'], photo['fy'], photo['cx'], photo['cy']
    if (w, h) != (photo['w'], photo['h']):   # intrinsics describe w x h; scale them to the decoded image
        sx, sy = w / photo['w'], h / photo['h']; fx, fy, cx, cy = fx * sx, fy * sy, cx * sx, cy * sy
    K = np.array([[fx, 0, cx], [0, fy, cy], [0, 0, 1]], np.float64)
    keypoints, desc = sift.detectAndCompute(image, None)
    if desc is None or len(keypoints) < MIN_INLIERS: return {'reason': 'The photo has too little texture to match'}
    desc = root_sift(desc); uv = np.array([k.pt for k in keypoints], np.float64)
    index = cv2.flann_Index(desc, {'algorithm': 1, 'trees': 4})
    good = np.zeros(len(retrieval), bool)
    for start in range(0, len(retrieval), 50000):
        _, distance = index.knnSearch(root_sift(retrieval[start:start + 50000]), 2, params={'checks': 32})
        good[start:start + 50000] = distance[:, 0] < (RATIO ** 2) * distance[:, 1]   # FLANN returns squared L2
    votes = np.bincount(owners[good], minlength=len(library))
    shortlist = [int(i) for i in np.argsort(-votes)[:SHORTLIST] if votes[i] >= 8]
    if not shortlist: return {'reason': 'No keyframe looks like this photo; it may show a part of the site the scan did not cover'}
    long_side = max(w, h); verified = []
    for i in shortlist:
        # Ratio test photo -> keyframe, kept only when the keyframe feature's own nearest photo
        # feature is the same one (mutual): wide baselines otherwise yield mostly wrong pairs.
        target = root_sift(library[i]['descriptors'])
        pairs = matcher.knnMatch(desc, target, k=2)
        back = {m.queryIdx: m.trainIdx for m in matcher.match(target, desc)}
        matches = [(m.queryIdx, m.trainIdx) for m, *rest in pairs if rest and m.distance < RATIO * rest[0].distance and back.get(m.trainIdx) == m.queryIdx]
        if len(matches) < 12: continue
        q, t = np.array(matches).T
        solved = solve(library[i]['model'][t], uv[q], K, long_side, iterations=2000)
        verified.append((len(solved[2]) if solved else 0, i, q, t, solved[2] if solved else np.zeros(0, int)))
    verified.sort(key=lambda item: -item[0])
    top = [item for item in verified[:TOP_KEYFRAMES] if item[0] >= 8]
    if not top: return {'reason': 'Matches with the scan did not agree on one camera position'}
    obj = np.concatenate([library[item[1]]['model'][item[3]] for item in top]); img = np.concatenate([uv[item[2]] for item in top])
    # The pooled RANSAC samples from each keyframe's own consensus, then the refined pose is
    # scored against every pooled match, so inliers and rmsPx describe all of them.
    offsets = np.cumsum([0] + [len(item[2]) for item in top])
    seeds = np.concatenate([offsets[n] + item[4] for n, item in enumerate(top)])
    stems = [library[item[1]]['stem'] for item in top]
    solved = solve(obj, img, K, long_side, iterations=10000, subset=seeds)
    base = {'matches': int(len(obj)), 'keyframes': stems}
    if not solved: return {**base, 'reason': 'Matches with the scan did not agree on one camera position'}
    rvec, tvec, inliers, rms = solved
    base.update(inliers=int(len(inliers)), rmsPx=round(rms, 3))
    if len(inliers) < MIN_INLIERS:
        return {**base, 'reason': f'Only {len(inliers)} matches agree with one camera position; at least {MIN_INLIERS} are needed'}
    if len(inliers) < MIN_INLIER_SHARE * len(obj):
        return {**base, 'reason': f'Only {len(inliers)} of {len(obj)} matches agree with one camera position, too few to trust'}
    return {**base, 'ok': True, 'pose': three_pose(rvec, tvec), 'reason': ''}


def worker(folder, cache):
    folder, cache = Path(folder), Path(cache)
    def emit(event): print('TIKSI ' + json.dumps(event, allow_nan=False), flush=True)
    try:
        request = json.loads((folder / 'request.json').read_text(encoding='utf-8'))
        place(request, folder / 'photos', cache, emit)
    except PlacementError as error:
        emit({'error': str(error)}); return 1
    except ImportError:
        emit({'error': f'The photo placement runtime is missing NumPy or OpenCV. Run {INSTALL} again.'}); return 1
    return 0


if __name__ == '__main__':
    if len(sys.argv) == 4 and sys.argv[1] == 'worker': sys.exit(worker(sys.argv[2], sys.argv[3]))
    sys.exit('usage: photo_placement.py worker <job folder> <cache folder>')
