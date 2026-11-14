"""Send a property to its client page in the lab on thedurham.nyc.

The page in MODEL's SEND TO THE LAB builds a view-only copy of one property (lab-publish.js) and
hands it here a file at a time. Each file is kept in this Mac's own copy of what was sent
(`<state>/lab/<slug>/data/...`) and, when the Mac has the lab's upload key, put in the website's
file storage (a Cloudflare R2 bucket) under the same key, `<slug>/data/<path>`. The website serves
`/lab/<slug>/data/*` from that storage to the people the lab lets in.

What is sent, in the order that keeps a viewer's page whole while a new copy goes up:
  data/app/<code>/...      the Tiksi code the page runs (js, css, the three.js files), once per
                           version of the code; a marker file written last says it is all there
  data/v/<version>/...     the property, its models and the pictures of its saved views
  data/current.json        which version and which code to show: written last, so the page
                           switches from the old copy to the new one in one step
Older versions are removed after a send, keeping the newest two, and older code with them.

The upload key is read from ~/.r2-credentials (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,
R2_SECRET_ACCESS_KEY, one KEY=VALUE per line), the file the website's own tools use. It never
leaves this Mac and is never shown. Without it, sends go to this Mac's copy only, and
/lab-preview/<slug>/ shows that copy here."""
import datetime
import hashlib
import hmac
import json
import mimetypes
import os
from pathlib import Path
import re
import secrets
import shutil
import time
import threading
import urllib.error
import urllib.parse
import urllib.request
from urllib.parse import unquote, urlsplit
from xml.etree import ElementTree

ROOT = Path(__file__).resolve().parents[1]
SLUG = re.compile(r'^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$')
PART = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$')
MAX_FILE = 512 * 1024 * 1024
BUCKET = 'thedurham-lab-data'
SITE = 'https://thedurham.nyc/lab/'
KEEP_VERSIONS = 2
# The code the client page needs. pdf.js and Spark (splats) load only on demand, and a client
# page opens neither, so they stay behind.
APP_DIRS = ('js', 'css', 'vendor/addons')
APP_FILES = ('client.html', 'vendor/three.module.min.js', 'vendor/three.core.min.js', 'vendor/THREE-LICENSE.txt', 'LICENSE')
TYPES = {'.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
         '.glb': 'model/gltf-binary', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
         '.webp': 'image/webp', '.svg': 'image/svg+xml', '.html': 'text/html; charset=utf-8', '.txt': 'text/plain',
         '.wasm': 'application/wasm', '.ply': 'application/octet-stream', '.bin': 'application/octet-stream'}


class LabError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def content_type(name):
    ext = os.path.splitext(name)[1].lower()
    return TYPES.get(ext) or mimetypes.guess_type(name)[0] or 'application/octet-stream'


def clean_path(path):
    """`a/b/c.ext` with every part a plain name, or a LabError."""
    parts = [p for p in str(path or '').split('/')]
    if not parts or len(parts) > 8 or not all(PART.match(p) for p in parts): raise LabError('Not a lab file name: ' + str(path)[:120])
    return '/'.join(parts)


def read_credentials(path):
    """{'account', 'key', 'secret'} from a KEY=VALUE file, or None when it is missing or incomplete."""
    try: text = Path(path).expanduser().read_text(encoding='utf-8')
    except OSError: return None
    values = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line: continue
        if line.startswith('export '): line = line[7:].strip()
        k, v = line.split('=', 1)
        values[k.strip()] = v.strip().strip('"').strip("'")
    out = {'account': values.get('R2_ACCOUNT_ID', ''), 'key': values.get('R2_ACCESS_KEY_ID', ''), 'secret': values.get('R2_SECRET_ACCESS_KEY', '')}
    return out if all(out.values()) else None


class R2:
    """The few S3 calls a send needs, signed with AWS Signature Version 4 (R2's region is 'auto')."""
    def __init__(self, creds, bucket=BUCKET, endpoint=None, opener=None):
        self.creds, self.bucket = creds, bucket
        self.endpoint = (endpoint or f"https://{creds['account']}.r2.cloudflarestorage.com").rstrip('/')
        self.opener = opener or urllib.request.urlopen

    def _request(self, method, key='', query=None, body=b'', headers=None):
        url = urlsplit(self.endpoint)
        path = '/' + self.bucket + ('/' + urllib.parse.quote(key, safe='/-_.~') if key else '')
        q = sorted((query or {}).items())
        query_string = '&'.join(urllib.parse.quote(k, safe='-_.~') + '=' + urllib.parse.quote(str(v), safe='-_.~') for k, v in q)
        now = datetime.datetime.now(datetime.timezone.utc)
        amz_date, day = now.strftime('%Y%m%dT%H%M%SZ'), now.strftime('%Y%m%d')
        payload = hashlib.sha256(body).hexdigest()
        h = {'host': url.netloc, 'x-amz-content-sha256': payload, 'x-amz-date': amz_date}
        for k, v in (headers or {}).items(): h[k.lower()] = v
        signed = ';'.join(sorted(h))
        canonical = '\n'.join([method, path, query_string, ''.join(f'{k}:{h[k].strip()}\n' for k in sorted(h)), signed, payload])
        scope = f'{day}/auto/s3/aws4_request'
        to_sign = '\n'.join(['AWS4-HMAC-SHA256', amz_date, scope, hashlib.sha256(canonical.encode()).hexdigest()])
        k = ('AWS4' + self.creds['secret']).encode()
        for part in (day, 'auto', 's3', 'aws4_request'): k = hmac.new(k, part.encode(), hashlib.sha256).digest()
        signature = hmac.new(k, to_sign.encode(), hashlib.sha256).hexdigest()
        h['authorization'] = f"AWS4-HMAC-SHA256 Credential={self.creds['key']}/{scope}, SignedHeaders={signed}, Signature={signature}"
        req = urllib.request.Request(self.endpoint + path + ('?' + query_string if query_string else ''), data=body if method in ('PUT', 'POST') else None, method=method)
        for name, value in h.items():
            if name != 'host': req.add_header(name, value)
        try:
            with self.opener(req, timeout=120) as resp: return resp.status, resp.read()
        except urllib.error.HTTPError as e: return e.code, e.read() if hasattr(e, 'read') else b''
        except (urllib.error.URLError, OSError) as e: raise LabError('The website\'s file storage could not be reached: ' + str(getattr(e, 'reason', e))[:200], 502)

    def put(self, key, body, ctype):
        status, data = self._request('PUT', key, body=body, headers={'content-type': ctype})
        if status >= 300: raise LabError(f'The website\'s file storage refused {key} ({status}): ' + data[:200].decode('utf-8', 'replace'), 502)

    def exists(self, key):
        status, _ = self._request('HEAD', key)
        if status == 404: return False
        if status >= 300: raise LabError(f'The website\'s file storage could not be asked about {key} ({status})', 502)
        return True

    def list(self, prefix):
        keys, token = [], None
        while True:
            q = {'list-type': '2', 'prefix': prefix}
            if token: q['continuation-token'] = token
            status, data = self._request('GET', query=q)
            if status >= 300: raise LabError(f'The website\'s file storage could not list {prefix} ({status})', 502)
            root = ElementTree.fromstring(data)
            ns = root.tag.split('}')[0] + '}' if root.tag.startswith('{') else ''
            keys += [c.findtext(ns + 'Key') for c in root.findall(ns + 'Contents')]
            token = root.findtext(ns + 'NextContinuationToken')
            if not token: return [k for k in keys if k]

    def delete(self, key):
        status, _ = self._request('DELETE', key)
        if status >= 300 and status != 404: raise LabError(f'The website\'s file storage would not remove {key} ({status})', 502)


def app_files(root=ROOT):
    """The code files a client page runs, as sorted relative paths."""
    out = []
    for d in APP_DIRS:
        base = root / d
        if not base.is_dir(): continue
        for p in base.rglob('*'):
            rel = p.relative_to(root).as_posix()
            if p.is_file() and not any(part.startswith('.') for part in rel.split('/')): out.append(rel)
    for f in APP_FILES:
        if (root / f).is_file(): out.append(f)
    return sorted(set(out))


def app_version(root=ROOT, files=None):
    """A short name for exactly this code: the same files give the same name."""
    return snapshot_version({rel: (root / rel).read_bytes() for rel in (files if files is not None else app_files(root))})


def snapshot_version(snapshot):
    h = hashlib.sha256()
    for rel in sorted(snapshot):
        h.update(rel.encode() + b'\0' + hashlib.sha256(snapshot[rel]).digest())
    return h.hexdigest()[:16]


def app_snapshot(root=ROOT, tries=5):
    """Every code file's bytes, read in one go, and the version they make. A merge into main can
    change the code while it is read (a send once went up half old, half new and the page could not
    start), so the files are read until two reads in a row agree; those bytes are what goes up."""
    def read():
        out = {}
        for rel in app_files(root):
            try: out[rel] = (root / rel).read_bytes()
            except FileNotFoundError: pass
        return out
    last = read()
    for _ in range(tries):
        now = read()
        if now == last: return now, snapshot_version(now)
        last = now
        time.sleep(0.5)
    raise LabError('Tiksi\'s code kept changing while it was read for the send (a merge in progress?). Send again in a minute.', 503)


class LabPublishService:
    def __init__(self, state_dir, credentials='~/.r2-credentials', bucket=BUCKET, endpoint=None, opener=None, root=ROOT):
        self.mirror = Path(state_dir) / 'lab'
        self.credentials, self.bucket, self.endpoint, self.opener, self.root = credentials, bucket, endpoint, opener, root
        self.token = secrets.token_urlsafe(32)
        self.lock = threading.Lock()

    def close(self): pass

    def remote(self):
        creds = read_credentials(self.credentials)
        return R2(creds, self.bucket, self.endpoint, self.opener) if creds else None

    def capabilities(self):
        has = self.remote() is not None
        return {'token': self.token, 'upload': has, 'site': SITE, 'preview': '/lab-preview/',
                'reason': '' if has else 'This Mac has no upload key for the lab (~/.r2-credentials), so a send goes to this Mac\'s preview copy only.'}

    # ---------- storing ----------
    def local_path(self, slug, rel):
        return self.mirror / slug / 'data' / rel

    def store(self, slug, rel, body, remote=None):
        if not SLUG.match(slug): raise LabError('Not a lab page name: ' + slug[:80])
        rel = clean_path(rel)
        target = self.local_path(slug, rel)
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_name('.' + target.name + '.part')
        tmp.write_bytes(body)
        os.replace(tmp, target)
        r = remote if remote is not None else self.remote()
        if r: r.put(f'{slug}/data/{rel}', body, content_type(rel))
        return {'path': rel, 'bytes': len(body), 'uploaded': bool(r)}

    def send_app(self, slug):
        """The code the page runs, sent once per version of it; returns its version name."""
        if not SLUG.match(slug): raise LabError('Not a lab page name: ' + slug[:80])
        snapshot, version = app_snapshot(self.root)
        marker = f'app/{version}/.complete'
        remote = self.remote()
        here = self.local_path(slug, marker).exists()
        there = remote.exists(f'{slug}/data/{marker}') if remote else True
        if here and there: return {'app': version, 'sent': 0}
        sent = 0
        for rel in sorted(snapshot):
            body = snapshot[rel]
            key = f'app/{version}/{rel}'
            self.store_raw(slug, key, body, remote if not there else None)
            sent += 1
        self.store_raw(slug, marker, b'ok\n', remote if not there else None)
        return {'app': version, 'sent': sent}

    def store_raw(self, slug, key, body, remote):
        target = self.local_path(slug, key)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(body)
        if remote: remote.put(f'{slug}/data/{key}', body, content_type(key))

    def prune(self, slug, keep):
        """Remove sent versions other than `keep` (and the newest KEEP_VERSIONS), and code other than
        the version current.json names, here and online."""
        if not SLUG.match(slug): raise LabError('Not a lab page name: ' + slug[:80])
        keep = {k for k in keep if isinstance(k, str) and PART.match(k)}
        base = self.mirror / slug / 'data' / 'v'
        removed = 0
        if base.is_dir():
            versions = sorted((p for p in base.iterdir() if p.is_dir()), key=lambda p: p.stat().st_mtime, reverse=True)
            keep |= {p.name for p in versions[:KEEP_VERSIONS]}
            for p in versions:
                if p.name not in keep: shutil.rmtree(p, ignore_errors=True); removed += 1
        # The code: only the version current.json names is kept.
        app = None
        try: app = json.loads(self.local_path(slug, 'current.json').read_text(encoding='utf-8')).get('app')
        except (OSError, ValueError, AttributeError): pass
        codes = self.mirror / slug / 'data' / 'app'
        if app and codes.is_dir():
            for p in codes.iterdir():
                if p.is_dir() and p.name != app: shutil.rmtree(p, ignore_errors=True)
        remote = self.remote()
        if remote:
            for key in remote.list(f'{slug}/data/v/'):
                parts = key.split('/')
                if len(parts) > 3 and parts[3] not in keep: remote.delete(key)
            if app:
                for key in remote.list(f'{slug}/data/app/'):
                    parts = key.split('/')
                    if len(parts) > 3 and parts[3] != app: remote.delete(key)
        return {'removed': removed, 'kept': sorted(keep), 'app': app}

    # ---------- HTTP ----------
    def dispatch(self, h):
        split = urlsplit(h.path); path = unquote(split.path)
        if path.startswith('/lab-preview/'): return self.preview(h, path)
        base = '/api/lab'
        if path != base and not path.startswith(base + '/'): return False
        try:
            from server.peers import trusted_peer
            if not trusted_peer(h.client_address[0]): raise LabError('The lab sender answers only this Mac or Tailscale', 403)
            origin = h.headers.get('Origin')
            if origin and urlsplit(origin).netloc != h.headers.get('Host'): raise LabError('Use the Tiksi app on this server', 403)
            if h.headers.get('Sec-Fetch-Site') == 'cross-site': raise LabError('Cross-site requests are refused', 403)
            if path == base + '/capabilities' and h.command == 'GET': return self.reply(h, 200, self.capabilities())
            if not secrets.compare_digest(h.headers.get('X-Tiksi-Token', ''), self.token): raise LabError('Reconnect to the lab sender', 403)
            try: length = int(h.headers.get('Content-Length', '0') or 0)
            except ValueError: raise LabError('Invalid content length')
            if length < 0 or length > MAX_FILE: raise LabError('That file is too large to send', 413)
            parts = path[len(base):].strip('/').split('/', 2)
            if len(parts) == 3 and parts[0] == 'files' and h.command == 'PUT':
                body = h.rfile.read(length) if length else b''
                if len(body) != length: raise LabError('The file arrived incomplete')
                with self.lock: return self.reply(h, 200, self.store(parts[1], parts[2], body))
            if len(parts) == 2 and parts[0] in ('app', 'prune') and h.command == 'POST':
                request = json.loads(h.rfile.read(length) or b'{}') if length else {}
                with self.lock:
                    if parts[0] == 'app': return self.reply(h, 200, self.send_app(parts[1]))
                    return self.reply(h, 200, self.prune(parts[1], request.get('keep') or []))
            raise LabError('Lab endpoint not found', 404)
        except LabError as e:
            h.close_connection = True
            return self.reply(h, e.status, {'error': str(e)})
        except ValueError:
            h.close_connection = True
            return self.reply(h, 400, {'error': 'The request could not be read'})
        except Exception:
            h.close_connection = True
            return self.reply(h, 500, {'error': 'The lab send failed; what was already online is unchanged.'})

    def preview(self, h, path):
        """/lab-preview/<slug>/ is this Mac's copy of a lab page: the page itself, then data/... ."""
        from server.peers import trusted_peer
        if not trusted_peer(h.client_address[0]): h.send_error(403); return True
        rest = path[len('/lab-preview/'):]
        slug, _, rel = rest.partition('/')
        if not SLUG.match(slug): h.send_error(404); return True
        if rel in ('', 'index.html'): target = self.root / 'client.html'
        elif rel.startswith('data/'):
            try: target = self.local_path(slug, clean_path(rel[5:]))
            except LabError: h.send_error(404); return True
        else: h.send_error(404); return True
        if not target.is_file(): h.send_error(404); return True
        body = target.read_bytes()
        h.send_response(200)
        h.send_header('Content-Type', content_type(target.name))
        h.send_header('Content-Length', str(len(body)))
        h.send_header('Cache-Control', 'no-store')
        h.end_headers()
        if h.command != 'HEAD' and not getattr(h, 'drop_body', False): h.wfile.write(body)
        return True

    @staticmethod
    def reply(h, status, value):
        data = json.dumps(value).encode('utf-8')
        h.send_response(status); h.send_header('Content-Type', 'application/json'); h.send_header('Content-Length', str(len(data))); h.send_header('Cache-Control', 'no-store')
        h.end_headers()
        if not getattr(h, 'drop_body', False): h.wfile.write(data)
        return True
