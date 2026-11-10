"""Local frames from walk-through videos for tape-measure review: probe, 1 fps contact
sheets, tape-blade candidates and the sharpest full-resolution frame near a moment.

ffmpeg/ffprobe run from argument lists (never a shell) in a per-video cache folder keyed by
the video's SHA-256, sandboxed on macOS. The cache is derived and disposable: the original
video lives in the project (.tiksi) and is never altered here."""
import hashlib
import json
import logging
import math
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from urllib.parse import urlsplit

log = logging.getLogger('tiksi.video_frames')

MAX_BYTES = 600 * 1024 * 1024
# A login item's PATH lacks Homebrew, so the live service would miss an installed ffmpeg.
TOOL_DIRS = ('/opt/homebrew/bin', '/usr/local/bin')


def find_tool(name, dirs=TOOL_DIRS):
    found = shutil.which(name)
    if found: return found
    for folder in dirs:
        path = Path(folder) / name
        if path.is_file() and os.access(path, os.X_OK): return str(path)
    return None
MAX_SECONDS = 3600
CACHE_BYTES = 4 * 1024 ** 3
CACHE_JOBS = 12
THUMB_W, COLS, ROWS = 192, 10, 10        # one contact sheet = 100 seconds at 1 fps
ANALYSIS_W = 160                         # tape detection works on a small RGB copy of each second
BURST_FPS, BURST_SPAN, SHARP_W = 10, 1.0, 480
HASH = re.compile(r'^[a-f0-9]{64}$')
# Yellow blade: hue 40-70 deg, saturated and bright; a candidate is one elongated component
# of at least 0.2% (and at most 25%) of the frame, at least 4x longer than it is wide.
HUE, MIN_SAT, MIN_VAL, MIN_AREA, MAX_AREA, MIN_ELONGATION = (40, 70), 0.45, 0.35, 0.002, 0.25, 4.0


class VideoError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def even(value): return max(2, int(round(value / 2)) * 2)


def tape_component(data, w, h):
    """Best yellow, elongated component in an RGB frame, or None. Explainable on purpose:
    an HSV mask, 8-connected components, and the ratio of principal axes."""
    mask = bytearray(w * h)
    lo, hi = HUE
    for i, (r, g, b) in enumerate(zip(data[0::3], data[1::3], data[2::3])):
        mx = r if r > g else g
        if mx < MIN_VAL * 255 or b >= r or b >= g: continue   # yellow has blue as its minimum
        d = mx - b
        if d < MIN_SAT * mx: continue
        hue = 60 * (g - b) / d if mx == r else 120 - 60 * (r - b) / d
        if lo <= hue <= hi: mask[i] = 1
    best, total = None, w * h
    for start in range(total):
        if not mask[start]: continue
        mask[start] = 0; stack = [start]
        n = sx = sy = sxx = syy = sxy = 0; x0, y0, x1, y1 = w, h, 0, 0
        while stack:
            i = stack.pop(); y, x = divmod(i, w)
            n += 1; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y
            x0, y0, x1, y1 = min(x0, x), min(y0, y), max(x1, x), max(y1, y)
            for dy in (-1, 0, 1):
                yy = y + dy
                if yy < 0 or yy >= h: continue
                for dx in (-1, 0, 1):
                    xx = x + dx
                    if 0 <= xx < w and mask[yy * w + xx]: mask[yy * w + xx] = 0; stack.append(yy * w + xx)
        area = n / total
        if area < MIN_AREA or area > MAX_AREA: continue
        mx, my = sx / n, sy / n
        cxx, cyy, cxy = sxx / n - mx * mx, syy / n - my * my, sxy / n - mx * my
        half, root = (cxx + cyy) / 2, math.sqrt(max(0.0, ((cxx - cyy) / 2) ** 2 + cxy * cxy))
        # A pixel has variance 1/12 along each axis, so a one-pixel-thick blade is not infinite.
        elongation = math.sqrt((half + root + 1 / 12) / (half - root + 1 / 12))
        if elongation < MIN_ELONGATION: continue
        score = min(1.0, area / 0.02) * min(1.0, elongation / 12)
        if not best or score > best['score']:
            best = {'score': round(score, 3), 'area': round(area, 4), 'elongation': round(elongation, 1),
                    'box': [round(x0 / w, 4), round(y0 / h, 4), round((x1 + 1 - x0) / w, 4), round((y1 + 1 - y0) / h, 4)]}
    return best


def sharpness(data, w, h):
    """Variance of the 4-neighbour Laplacian of a grayscale frame: higher is sharper."""
    total = count = 0; squares = 0
    for y in range(1, h - 1):
        row, up, down = y * w, (y - 1) * w, (y + 1) * w
        for x in range(1, w - 1):
            v = 4 * data[row + x] - data[row + x - 1] - data[row + x + 1] - data[up + x] - data[down + x]
            total += v; squares += v * v; count += 1
    if not count: return 0.0
    mean = total / count
    return squares / count - mean * mean


class VideoFrameService:
    def __init__(self, root, ffmpeg=None, ffprobe=None):
        self.root = Path(root); self.root.mkdir(parents=True, exist_ok=True)
        self.token = secrets.token_urlsafe(32)
        # TIKSI_FFMPEG / TIKSI_FFPROBE name other binaries; an empty value turns frames off.
        self.ffmpeg = ffmpeg if ffmpeg is not None else os.environ.get('TIKSI_FFMPEG', find_tool('ffmpeg'))
        self.ffprobe = ffprobe if ffprobe is not None else os.environ.get('TIKSI_FFPROBE', find_tool('ffprobe'))
        self.lock = threading.RLock(); self.analysis = threading.Lock(); self.frames = threading.Lock()
        self.processes = {}; self.threads = {}; self.closed = False
        # Bursts are temporary; analyses interrupted by a restart can be resumed on request.
        for folder in self.root.iterdir():
            if not folder.is_dir(): continue
            for temp in folder.glob('burst-*'): shutil.rmtree(temp, ignore_errors=True)
            job = self.load(folder.name)
            if job and job['state'] in ('queued', 'analyzing'): job.update(state='interrupted'); self.save(job)

    def available(self): return bool(self.ffmpeg and self.ffprobe)

    def capabilities(self):
        return {'token': self.token, 'ffmpeg': self.available(), 'maxBytes': MAX_BYTES, 'maxSeconds': MAX_SECONDS,
                'sheet': {'cols': COLS, 'rows': ROWS, 'width': THUMB_W}, 'formats': ['.mp4', '.mov', '.m4v'],
                'detail': None if self.available() else 'Frame extraction needs ffmpeg on the Mac running Tiksi (brew install ffmpeg). Videos are still kept in the project and can be reviewed in the browser player.'}

    def active_jobs(self):
        with self.lock: return sum(1 for t in self.threads.values() if t.is_alive())

    # ---------- job records ----------
    def folder(self, identifier):
        if not HASH.fullmatch(identifier or ''): raise VideoError('Video not found', 404)
        return self.root / identifier

    def load(self, identifier):
        try: return json.loads((self.root / identifier / 'job.json').read_text(encoding='utf-8'))
        except (OSError, ValueError): return None

    def save(self, job):
        folder = self.root / job['id']
        try: temp = folder / 'job.tmp'; temp.write_text(json.dumps(job), encoding='utf-8'); os.replace(temp, folder / 'job.json')
        except FileNotFoundError: pass   # deleted while an analysis was finishing

    def source(self, identifier):
        folder = self.folder(identifier)
        ref = folder / 'source.ref'
        path = Path(ref.read_text(encoding='utf-8')) if ref.is_file() else folder / 'source.video'
        if not path.is_file(): raise VideoError('The cached video is gone; open it again', 410)
        return path

    def public(self, job):
        job = dict(job); job.pop('usedAt', None)
        if job['state'] == 'analyzing':
            job['progress'] = round(min(1.0, job.get('done', 0) / max(1, job.get('seconds', 1))), 3)
        return job

    def evict(self, incoming):
        """Keep the derived cache bounded: least recently used videos go first."""
        with self.lock:
            jobs = []
            for folder in self.root.iterdir():
                job = self.load(folder.name) if folder.is_dir() else None
                if not job: continue
                size = sum(p.stat().st_size for p in folder.rglob('*') if p.is_file())
                jobs.append((job.get('usedAt', 0), folder, size))
            jobs.sort(key=lambda item: item[0])
            total = sum(size for _, _, size in jobs)
            while jobs and (len(jobs) >= CACHE_JOBS or total + incoming > CACHE_BYTES):
                _, folder, size = jobs.pop(0)
                if folder.name in self.threads and self.threads[folder.name].is_alive(): continue
                shutil.rmtree(folder, ignore_errors=True); total -= size
            if len(jobs) >= CACHE_JOBS or total + incoming > CACHE_BYTES: raise VideoError('The video cache is busy; wait for the current analysis to finish', 409)

    # ---------- processes ----------
    def run(self, args, folder, timeout, identifier, reads=(), stdout=None, consume=None):
        """Run one ffmpeg/ffprobe process. `consume(pipe)` reads stdout while it runs."""
        if self.closed: raise VideoError('Video service is stopping', 503)
        env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'TMPDIR': str(folder), 'LC_ALL': 'C'}
        sandbox = shutil.which('sandbox-exec') if sys.platform == 'darwin' else None
        if sandbox:
            quote = lambda path: json.dumps(str(Path(path).resolve()))
            allowed = [folder, *reads, Path(args[0]).resolve().parent.parent]
            profile = ('(version 1)(allow default)(deny network*)(deny file-write*)(allow file-write* (subpath ' + quote(folder) + ') (literal "/dev/null"))'
                       '(deny file-read-data (subpath "/Users") (subpath "/Volumes") (subpath "/private/var/folders"))(allow file-read-data '
                       + ' '.join('(subpath ' + quote(p) + ')' for p in allowed) + ')')
            args = [sandbox, '-p', profile, *args]
        log = (folder / 'ffmpeg.log').open('wb')
        try:
            process = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE if consume else (stdout or subprocess.DEVNULL), stderr=log, cwd=folder, env=env)
        except OSError: log.close(); raise VideoError('ffmpeg could not be started', 422)
        with self.lock: self.processes.setdefault(identifier, set()).add(process)
        expired = threading.Event()
        def expire(): expired.set(); process.kill()
        timer = threading.Timer(timeout, expire); timer.start()
        try:
            if consume: consume(process.stdout)
            code = process.wait()
        finally:
            timer.cancel(); log.close()
            if consume: process.stdout.close()
            with self.lock: self.processes.get(identifier, set()).discard(process)
            if process.poll() is None: process.kill(); process.wait()
        text = (folder / 'ffmpeg.log').read_text(encoding='utf-8', errors='replace')[-4000:]
        if expired.is_set(): raise VideoError('Video processing exceeded its time limit', 504)
        if code < 0: raise VideoError('Video processing was stopped', 409)
        return code, text

    def cancel(self, identifier=None):
        with self.lock:
            targets = [identifier] if identifier else list(self.processes)
            stopped = 0
            for key in targets:
                for process in list(self.processes.get(key, ())):
                    if process.poll() is None: process.terminate(); stopped += 1
                job = self.load(key) if HASH.fullmatch(key or '') else None
                if job and job['state'] in ('queued', 'analyzing'): job['cancel'] = True; self.save(job)
        return {'cancelled': stopped}

    def close(self):
        self.closed = True
        with self.lock:
            for processes in self.processes.values():
                for process in processes:
                    if process.poll() is None: process.kill()
            threads = list(self.threads.values())
        for thread in threads: thread.join(5)

    # ---------- probe ----------
    def probe(self, path, folder, identifier):
        args = [self.ffprobe, '-v', 'error', '-f', 'mov', '-protocol_whitelist', 'file',
                '-show_entries', 'format=duration,format_name:stream=index,codec_type,codec_name,width,height,avg_frame_rate,duration:stream_side_data=rotation:stream_tags=rotate',
                '-of', 'json', 'file:' + str(path)]
        out = folder / 'probe.json'
        with out.open('wb') as stream: code, log = self.run(args, folder, 30, identifier, reads=[path], stdout=stream)
        try: info = json.loads(out.read_text(encoding='utf-8') or '{}')
        except ValueError: info = {}
        out.unlink(missing_ok=True)
        if code: raise VideoError('This is not a readable MP4/MOV video (' + (log.strip().splitlines() or ['unknown format'])[-1][:160] + ')', 422)
        video = next((s for s in info.get('streams', []) if s.get('codec_type') == 'video'), None)
        if not video or not video.get('width') or not video.get('height'): raise VideoError('The file has no video track', 422)
        try: duration = float(info.get('format', {}).get('duration') or video.get('duration') or 0)
        except ValueError: duration = 0
        if not 0 < duration: raise VideoError('The video has no readable duration; it may be truncated', 422)
        if duration > MAX_SECONDS: raise VideoError('Videos longer than one hour are not analysed; trim it first', 413)
        rotation = 0
        for side in video.get('side_data_list', []) or []:
            if 'rotation' in side: rotation = int(float(side['rotation']))
        if not rotation and video.get('tags', {}).get('rotate'): rotation = -int(float(video['tags']['rotate']))
        w, h = int(video['width']), int(video['height'])
        if abs(rotation) % 180 == 90: w, h = h, w
        num, _, den = str(video.get('avg_frame_rate') or '0/1').partition('/')
        try: fps = float(num) / float(den or 1)
        except (ValueError, ZeroDivisionError): fps = 0
        return {'duration': round(duration, 3), 'width': w, 'height': h, 'codec': video.get('codec_name', ''), 'fps': round(fps, 3), 'rotation': rotation}

    # ---------- open / analyse ----------
    def open(self, digest=None, body=None, length=0, blobs=None):
        """Find or create the cache entry for a video. `body` streams an upload; otherwise the
        hash must name a cached video or a workspace blob already on this Mac."""
        if not self.available(): raise VideoError(self.capabilities()['detail'], 422)
        if digest is not None and not HASH.fullmatch(digest): raise VideoError('Invalid video hash')
        with self.lock:
            if digest and (self.root / digest / 'job.json').is_file():
                job = self.load(digest); job['usedAt'] = time.time(); self.save(job)
                if job['state'] in ('interrupted', 'cancelled'): self.start(job)
                return self.public(self.load(digest))
        # A video the workspace already holds is read in place instead of uploaded twice.
        reference = blobs / digest if digest and not length and blobs and (blobs / digest).is_file() else None
        if not reference and not length: return {'id': digest, 'upload': True}   # not an error: the client sends the bytes next
        if length and not 0 < length <= MAX_BYTES: raise VideoError('Videos must be smaller than 600 MB', 413)
        self.evict(0 if reference else length)
        staging = Path(tempfile.mkdtemp(prefix='incoming-', dir=self.root))
        try:
            if reference: identifier = digest
            else:
                sha, size = hashlib.sha256(), 0
                with (staging / 'source.video').open('wb') as out:
                    while size < length:
                        chunk = body.read(min(1024 * 1024, length - size))
                        if not chunk: raise VideoError('Upload was truncated')
                        size += len(chunk); sha.update(chunk); out.write(chunk)
                identifier = sha.hexdigest()
                if digest and digest != identifier: raise VideoError('Uploaded bytes do not match their hash')
            with self.lock:
                folder = self.root / identifier
                if (folder / 'job.json').is_file(): return self.open(identifier)
                if reference: (staging / 'source.ref').write_text(str(reference), encoding='utf-8')
                os.replace(staging, folder); staging = None
            try: probe = self.probe(self.source(identifier), folder, identifier)
            except Exception:
                shutil.rmtree(folder, ignore_errors=True); raise
            seconds = max(1, math.ceil(probe['duration'] - 1e-6))   # fps=1 emits t = 0, 1, ... < duration
            tile = [THUMB_W, even(THUMB_W * probe['height'] / probe['width'])]
            job = {'id': identifier, 'state': 'queued', 'probe': probe, 'seconds': seconds, 'done': 0, 'tile': tile,
                   'cols': COLS, 'rows': ROWS, 'sheets': 0, 'candidates': [], 'error': '', 'createdAt': time.time(), 'usedAt': time.time()}
            self.save(job); self.start(job)
            return self.public(self.load(identifier))
        finally:
            if staging: shutil.rmtree(staging, ignore_errors=True)

    def start(self, job):
        with self.lock:
            if job['id'] in self.threads and self.threads[job['id']].is_alive(): return
            job.update(state='queued', error='', done=0, candidates=[], cancel=False); self.save(job)
            thread = threading.Thread(target=self.analyse, args=(job['id'],), daemon=True)
            self.threads[job['id']] = thread; thread.start()

    def analyse(self, identifier):
        with self.analysis:
            job = self.load(identifier)
            if not job or job.get('cancel'):
                if job: job.update(state='cancelled'); self.save(job)
                return
            folder = self.root / identifier; sheets = folder / 'sheets'
            shutil.rmtree(sheets, ignore_errors=True); sheets.mkdir()
            job.update(state='analyzing'); self.save(job)
            aw = ANALYSIS_W; ah = even(aw * job['probe']['height'] / job['probe']['width']); frame = aw * ah * 3
            candidates = []
            def consume(pipe):
                second = 0
                while True:
                    data = pipe.read(frame)
                    if len(data) < frame: return
                    found = tape_component(data, aw, ah)
                    if found: candidates.append({'t': second, **found})
                    second += 1
                    if second % 5 == 0:
                        with self.lock:
                            current = self.load(identifier) or job
                            current['done'] = second; self.save(current)
            tw, th = job['tile']
            try: source = self.source(identifier)
            except VideoError as e: job.update(state='failed', error=str(e)); self.save(job); return
            graph = f'[0:v]fps=1,split=2[s][a];[s]scale={tw}:{th},tile={COLS}x{ROWS}[t];[a]scale={aw}:{ah},format=rgb24[r]'
            args = [self.ffmpeg, '-nostdin', '-v', 'error', '-f', 'mov', '-protocol_whitelist', 'file,pipe', '-i', 'file:' + str(source),
                    '-filter_complex', graph, '-map', '[t]', '-q:v', '5', 'file:' + str(sheets / 'sheet_%03d.jpg'), '-map', '[r]', '-f', 'rawvideo', 'pipe:1']
            try:
                code, log = self.run(args, folder, max(120, job['probe']['duration'] * 3), identifier, reads=[source], consume=consume)
                if code: raise VideoError('ffmpeg could not decode this video: ' + (log.strip().splitlines() or ['unknown error'])[-1][:200], 422)
                state, error = 'ready', ''
            except VideoError as e:
                state, error = ('cancelled' if (self.load(identifier) or {}).get('cancel') else 'failed'), str(e)
            except Exception as e:  # keep a readable record instead of a stuck "analyzing"
                state, error = 'failed', 'Analysis failed: ' + type(e).__name__
            with self.lock:
                job = self.load(identifier)
                if not job: return
                job.update(state=state, error=error, candidates=candidates, done=job['seconds'] if state == 'ready' else job.get('done', 0),
                           sheets=len(list(sheets.glob('sheet_*.jpg'))), analyzedAt=time.time())
                self.save(job)

    # ---------- frames ----------
    def frame(self, identifier, t, burst=False, region=None):
        """Full-resolution JPEG at `t`, or the sharpest of a short burst around it (judged
        inside `region`, normalised x, y, w, h, when given). When some burst frames show a
        blade, the choice is among those: a crisp frame without the tape reads nothing.
        Returns (bytes, info)."""
        if not self.available(): raise VideoError(self.capabilities()['detail'], 422)
        job = self.load(self.folder(identifier).name)
        if not job: raise VideoError('Video not found', 404)
        probe = job['probe']; duration = probe['duration']
        if not isinstance(t, (int, float)) or not math.isfinite(t): raise VideoError('Invalid time')
        # The last decodable frame starts one frame period before the end.
        t = min(max(0.0, float(t)), max(0.0, duration - max(0.05, 1 / probe['fps'] if probe.get('fps') else 0.05)))
        if region is not None:
            if not (isinstance(region, list) and len(region) == 4 and all(isinstance(v, (int, float)) and math.isfinite(v) for v in region)): raise VideoError('Invalid region')
            x, y, w, h = [float(v) for v in region]
            if not (0 <= x < 1 and 0 <= y < 1 and 0.01 <= w and 0.01 <= h and x + w <= 1.0001 and y + h <= 1.0001): raise VideoError('Invalid region')
            region = [x, y, min(w, 1 - x), min(h, 1 - y)]
        if not self.frames.acquire(timeout=60): raise VideoError('Another frame is being extracted', 409)
        folder = self.root / identifier; temp = None
        try:
            source = self.source(identifier)
            temp = Path(tempfile.mkdtemp(prefix='burst-', dir=folder))
            base = [self.ffmpeg, '-nostdin', '-v', 'error']
            ins = ['-f', 'mov', '-protocol_whitelist', 'file,pipe', '-i', 'file:' + str(source)]
            if not burst:
                path = temp / 'frame.jpg'
                for at in (t, max(0.0, t - 0.5)):   # variable frame rates can leave a gap at the end
                    code, log = self.run(base + ['-ss', f'{at:.3f}'] + ins + ['-frames:v', '1', '-q:v', '2', 'file:' + str(path)], temp, 60, identifier, reads=[source])
                    if not code and path.is_file(): t = at; break
                if code or not path.is_file(): raise VideoError('No frame could be decoded at this time', 422)
                return path.read_bytes(), {'seconds': round(t, 3), 'sharpness': [], 'width': probe['width'], 'height': probe['height']}
            start = max(0.0, t - BURST_SPAN / 2); span = max(0.1, min(BURST_SPAN, duration - start))
            crop = '' if not region else f'crop=iw*{region[2]:.4f}:ih*{region[3]:.4f}:iw*{region[0]:.4f}:ih*{region[1]:.4f},'
            rw, rh = (region[2] * probe['width'], region[3] * probe['height']) if region else (probe['width'], probe['height'])
            gw = min(SHARP_W, even(rw)); gh = even(gw * rh / rw); size = gw * gh; scores = []
            def consume(pipe):
                while len(data := pipe.read(size)) == size: scores.append(sharpness(data, gw, gh))
            aw = ANALYSIS_W; ah = even(aw * probe['height'] / probe['width'])
            graph = f'[0:v]fps={BURST_FPS},split=3[f][g][h];[g]{crop}scale={gw}:{gh},format=gray[r];[h]scale={aw}:{ah},format=rgb24[c]'
            code, log = self.run(base + ['-ss', f'{start:.3f}', '-t', f'{span:.3f}'] + ins + ['-filter_complex', graph, '-map', '[f]', '-q:v', '2',
                                 'file:' + str(temp / 'f_%03d.jpg'), '-map', '[c]', '-f', 'rawvideo', 'file:' + str(temp / 'tape.rgb'),
                                 '-map', '[r]', '-f', 'rawvideo', 'pipe:1'], temp, 120, identifier, reads=[source], consume=consume)
            files = sorted(temp.glob('f_*.jpg'))
            if code or not files or not scores: raise VideoError('No frames could be decoded near this time', 422)
            count = min(len(files), len(scores)); raw = (temp / 'tape.rgb').read_bytes() if (temp / 'tape.rgb').is_file() else b''
            tape = [bool(len(raw) >= (i + 1) * aw * ah * 3 and tape_component(raw[i * aw * ah * 3:(i + 1) * aw * ah * 3], aw, ah)) for i in range(count)]
            eligible = [i for i in range(count) if tape[i]] or list(range(count))
            best = max(eligible, key=lambda i: scores[i])
            info = {'seconds': round(start + best / BURST_FPS, 3), 'sharpness': [[round(start + i / BURST_FPS, 3), round(scores[i], 1)] for i in range(count)],
                    'tape': tape, 'width': probe['width'], 'height': probe['height']}
            return files[best].read_bytes(), info
        finally:
            self.frames.release()
            if temp: shutil.rmtree(temp, ignore_errors=True)
            with self.lock:
                job = self.load(identifier)
                if job: job['usedAt'] = time.time(); self.save(job)

    def delete(self, identifier):
        folder = self.folder(identifier)
        if not folder.is_dir(): raise VideoError('Video not found', 404)
        self.cancel(identifier)
        thread = self.threads.get(identifier)
        if thread: thread.join(10)
        shutil.rmtree(folder, ignore_errors=True)
        return {}

    # ---------- HTTP ----------
    def dispatch(self, h):
        base = '/api/video'; path = urlsplit(h.path).path
        if path != base and not path.startswith(base + '/'): return False
        try:
            from server.workspace import WorkspaceService
            # Same posture as the workspace: this Mac or Tailscale, same origin, a non-simple header.
            if not WorkspaceService.trusted_peer(h.client_address[0]): raise VideoError('Video frames require this Mac or Tailscale', 403)
            origin = h.headers.get('Origin')
            if origin and urlsplit(origin).netloc != h.headers.get('Host'): raise VideoError('Use the Tiksi app on this server', 403)
            if h.headers.get('Sec-Fetch-Site') == 'cross-site': raise VideoError('Cross-site video requests are refused', 403)
            if h.headers.get('X-Tiksi-Video') != '1': raise VideoError('Use the Tiksi video client', 403)
            if path == base + '/capabilities' and h.command == 'GET': return self.reply(h, 200, self.capabilities())
            if not secrets.compare_digest(h.headers.get('X-Tiksi-Token', ''), self.token): raise VideoError('Reconnect to the video service', 403)
            try: length = int(h.headers.get('Content-Length', '0') or 0)
            except ValueError: raise VideoError('Invalid content length')
            if path == base + '/cancel' and h.command == 'POST': return self.reply(h, 200, self.cancel())
            if path == base + '/jobs' and h.command == 'POST':
                # The body is not read when the hash is already known here: never reuse the connection.
                if length: h.connection.settimeout(120); h.close_connection = True
                workspace = getattr(h.server, 'workspace', None)
                digest = h.headers.get('X-Video-Hash') or None
                return self.reply(h, 200, self.open(digest, h.rfile, length, workspace.root / 'blobs' if workspace else None))
            parts = path[len(base):].strip('/').split('/')
            if len(parts) >= 2 and parts[0] == 'jobs':
                identifier = self.folder(parts[1]).name
                job = self.load(identifier)
                if not job: raise VideoError('Video not found', 404)
                if len(parts) == 2 and h.command == 'GET': return self.reply(h, 200, self.public(job))
                if len(parts) == 2 and h.command == 'DELETE': return self.reply(h, 200, self.delete(identifier))
                if len(parts) == 4 and parts[2] == 'sheet' and h.command == 'GET' and parts[3].isdigit():
                    sheet = self.root / identifier / 'sheets' / f'sheet_{int(parts[3]):03d}.jpg'
                    if not 0 < int(parts[3]) < 1000 or not sheet.is_file(): raise VideoError('Contact sheet not ready', 404)
                    return self.reply(h, 200, sheet.read_bytes(), 'image/jpeg')
                if len(parts) == 3 and parts[2] == 'frame' and h.command == 'POST':
                    if not 0 < length <= 4096: raise VideoError('Invalid frame request', 413)
                    try: request = json.loads(h.rfile.read(length))
                    except ValueError: raise VideoError('Frame request must be JSON')
                    if not isinstance(request, dict): raise VideoError('Frame request must be an object')
                    data, info = self.frame(identifier, request.get('t'), bool(request.get('burst')), request.get('region'))
                    return self.reply(h, 200, data, 'image/jpeg', {'X-Frame-Info': json.dumps(info)})
            raise VideoError('Video endpoint not found', 404)
        except VideoError as e:
            h.close_connection = True
            return self.reply(h, e.status, {'error': str(e)})
        except Exception:
            log.exception('Video processing failed (%s %s)', h.command, path)
            h.close_connection = True
            return self.reply(h, 500, {'error': 'Video processing failed; the original video is unchanged.'})

    @staticmethod
    def reply(h, status, value, mime='application/json', extra=None):
        data = value if isinstance(value, bytes) else json.dumps(value).encode('utf-8')
        h.send_response(status); h.send_header('Content-Type', mime); h.send_header('Content-Length', str(len(data))); h.send_header('Cache-Control', 'no-store')
        for name, header in (extra or {}).items(): h.send_header(name, header)
        h.end_headers(); h.wfile.write(data)
        return True
