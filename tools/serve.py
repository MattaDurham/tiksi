#!/usr/bin/env python3
"""Serve public Tiksi assets and optional local services, excluding private files."""
import argparse
import email.utils
import errno
import html
import io
import ipaddress
import json
import logging
import os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import faulthandler
import signal
import socket
import sys
import threading
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parent.parent
# The service packages live at the repository root, whatever folder this file is started from.
if str(ROOT) not in sys.path: sys.path.insert(0, str(ROOT))
from server.peers import refusal, this_mac_tailscale_address, trusted_peer
from server.ranges import Part, byte_range
PUBLIC_FILES = {'index.html', 'manifest.webmanifest', 'app-icon.svg'}
PUBLIC_DIRS = {'css', 'js', 'vendor'}

class AppHandler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map,
                      '.js': 'text/javascript', '.webmanifest': 'application/manifest+json'}
    # Persistent connections. Python's server speaks HTTP/1.0 unless told otherwise, which closes
    # the connection after every answer: a page opening with two hundred modules, pictures and
    # fonts made two hundred TCP connections, and every poll and save made one more. Under that
    # churn Linux drops connection attempts now and then, and the browser retries them only
    # after 1, 2, 4, 8 and 16 seconds, so a reload could sit for half a minute (the field-view
    # browser check hit this about half the time). With HTTP/1.1 a browser keeps a handful of
    # connections and sends every request down them, so there is nothing to drop.
    protocol_version = 'HTTP/1.1'
    # An idle connection gives its thread back; browsers close theirs long before this.
    timeout = 600

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def send_response(self, code, message=None):
        self.response_status = code
        super().send_response(code, message)

    def log_request(self, code='-', size='-'):
        # Every open page asks for the revision every few seconds; a successful read is not news.
        # Writes, refusals and failures are still logged.
        if self.command in ('GET', 'HEAD') and isinstance(code, int) and code < 400: return
        super().log_request(code, size)

    def log_error(self, format, *args):
        # An idle connection timing out is the normal end of a persistent connection, not an error.
        if format.startswith('Request timed out'): return
        super().log_error(format, *args)

    def valid_host(self):
        # Refuse DNS rebinding through arbitrary Host names. Numeric LAN and
        # Tailscale IPs work when explicitly binding beyond loopback.
        try:
            host = urlsplit('//' + self.headers.get('Host', '')).hostname
            if host in {'localhost', self.server.allowed_hostname, *getattr(self.server, 'allowed_hosts', [])}: return True
            address = ipaddress.ip_address(host or '')
            return address.is_loopback or self.server.remote_access
        except ValueError: return False

    def service_caller_refused(self):
        # Every address under /api/ is a service on this Mac: project files, photo to 3D, model
        # conversion, material research, video frames, photo placement. Each hands its access
        # token to whoever asks its capabilities address, so who may ask is decided here, once,
        # before any service sees the request. A service added later is covered without a check
        # of its own. The page itself (index.html, css, js, vendor) holds no project data.
        # The path is read the way every service reads it, so nothing a service would answer
        # can pass by under a different spelling.
        path = urlsplit(self.path).path
        if path != '/api' and not path.startswith('/api/'): return False
        return not trusted_peer(self.client_address[0])

    def dispatch(self):
        if not self.valid_host():
            self.send_error(403, 'Host is not allowed')
            return True
        if self.service_caller_refused():
            payload = (json.dumps({'error': refusal(self.client_address[0])}) + '\n').encode('utf-8')
            self.send_response(403)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(payload)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(payload)
            return True
        for name in ('workspace', 'reconstruction', 'material_research', 'model_conversion', 'video_frames', 'photo_placement', 'folder_intake'):
            service = getattr(self.server, name, None)
            if service and service.dispatch(self): return True
        return False

    def do_GET(self):
        if not self.dispatch(): super().do_GET()

    def do_HEAD(self):
        if not self.valid_host(): self.send_error(403, 'Host is not allowed')
        else: super().do_HEAD()

    def do_POST(self):
        # A request with a body closes its connection afterwards: a service that refuses an
        # upload may leave part of the body unread, and the next request must not read it.
        self.close_connection = True
        if not self.dispatch(): self.send_error(404)

    do_PUT = do_POST
    do_DELETE = do_POST

    def instance(self):
        path = getattr(self.server, 'instance_file', None)
        metadata = {}
        if path:
            try: metadata = json.loads(path.read_text(encoding='utf-8'))
            except (OSError, ValueError): pass
        result = {key: metadata[key] for key in ('slug', 'branch', 'port', 'instanceId', 'head', 'live') if key in metadata}
        result.update({'pid': os.getpid(), 'port': self.server.server_port,
                       'live': metadata.get('live', self.server.server_port == 8642), 'activeJobs': 0})
        for name in ('workspace', 'reconstruction', 'material_research', 'model_conversion', 'video_frames', 'photo_placement', 'folder_intake'):
            service = getattr(self.server, name, None)
            if service:
                active = getattr(service, 'active_jobs', None)
                # Optional adapter contract: active_jobs() is an integer count.
                if callable(active): result['activeJobs'] += active()
        return result

    def send_head(self):
        if not self.valid_host():
            self.send_error(403, 'Host is not allowed'); return None
        # HEAD reaches here without passing dispatch().
        if self.service_caller_refused():
            self.send_error(403, refusal(self.client_address[0])); return None
        path = unquote(urlsplit(self.path).path)
        if path == '/api/instance':
            payload = (json.dumps(self.instance()) + '\n').encode('utf-8')
            return self.bytes_response(payload, 'application/json')
        parts = path.strip('/').split('/')
        if '\\' in path or any(part in {'.', '..'} or part.startswith('.') for part in parts):
            self.send_error(404); return None
        if parts != [''] and not (len(parts) == 1 and parts[0] in PUBLIC_FILES or parts[0] in PUBLIC_DIRS):
            self.send_error(404); return None
        target = Path(self.translate_path(self.path)).resolve()
        if not target.is_relative_to(ROOT):
            self.send_error(404); return None
        if target == ROOT: target = ROOT / 'index.html'
        if target == ROOT / 'index.html':
            document = target.read_text(encoding='utf-8').replace('name="tiksi-storage" content="portable"', 'name="tiksi-storage" content="project-files"')
            if not getattr(self.server, 'instance_file', None):
                return self.bytes_response(document.encode('utf-8'), 'text/html; charset=utf-8')
            metadata = self.instance()
            badge = '<div style="position:fixed;bottom:8px;right:8px;z-index:2147483647;padding:6px 10px;background:#f3c467;color:#1b1b1b;font:12px monospace;border-radius:4px;pointer-events:none" aria-label="Branch preview">PREVIEW ' + html.escape(metadata.get('branch', 'unknown')) + ' / ' + html.escape(metadata.get('head', '')[:8]) + '</div>'
            document = document.replace('</body>', badge + '\n</body>')
            return self.bytes_response(document.encode('utf-8'), 'text/html; charset=utf-8')
        return self.static_file(target)

    def static_file(self, target):
        """A public file, with a validator for reuse and a single byte range when one is asked
        for (video in the guide plays and seeks without downloading the whole clip)."""
        if not target.is_file():
            self.send_error(404); return None
        try:
            source = target.open('rb'); info = os.fstat(source.fileno())
        except OSError:
            self.send_error(404); return None
        tag = '"%x-%x"' % (info.st_mtime_ns, info.st_size)
        modified = email.utils.formatdate(info.st_mtime, usegmt=True)
        if self.not_modified(tag, info.st_mtime):
            source.close()
            self.send_response(304); self.send_header('ETag', tag); self.end_headers()
            return None
        kind = self.guess_type(str(target))
        # A range is honoured unless If-Range names another version of the file.
        asked = self.headers.get('Range') if self.headers.get('If-Range', tag) in (tag, modified) else None
        wanted = byte_range(asked, info.st_size)
        if wanted == 'unsatisfiable':
            source.close()
            self.send_response(416); self.send_header('Content-Range', 'bytes */%d' % info.st_size)
            self.send_header('Content-Length', '0'); self.end_headers()
            return None
        if wanted:
            start, end = wanted
            source.seek(start)
            self.send_response(206)
            self.send_header('Content-Range', 'bytes %d-%d/%d' % (start, end, info.st_size))
            length, body = end - start + 1, Part(source, end - start + 1)
        else:
            self.send_response(200)
            length, body = info.st_size, source
        self.send_header('Content-Type', kind)
        self.send_header('Content-Length', str(length))
        self.send_header('Last-Modified', modified)
        self.send_header('ETag', tag)
        self.send_header('Accept-Ranges', 'bytes')
        self.end_headers()
        return body

    def not_modified(self, tag, mtime):
        match = self.headers.get('If-None-Match')
        if match is not None: return tag in [t.strip() for t in match.split(',')] or match.strip() == '*'
        since = self.headers.get('If-Modified-Since')
        if not since: return False
        try: return int(mtime) <= email.utils.parsedate_to_datetime(since).timestamp()
        except (TypeError, ValueError, IndexError, OverflowError): return False

    def bytes_response(self, payload, content_type):
        self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        return io.BytesIO(payload)

    def list_directory(self, path):
        self.send_error(404); return None

    def send_header(self, keyword, value):
        key = keyword.lower()
        if key == 'cache-control': self.cache_policy_sent = True
        if key in ('content-length', 'transfer-encoding'): self.body_framed = True
        super().send_header(keyword, value)

    def end_headers(self):
        # Revalidate by default; a response that sets its own policy (stored pictures) keeps it.
        if not getattr(self, 'cache_policy_sent', False): self.send_header('Cache-Control', 'no-cache')
        self.cache_policy_sent = False
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'same-origin')
        # On a persistent connection the browser must be able to see where a body ends. A
        # response with a body but no Content-Length (and not chunked) ends it by closing.
        status = getattr(self, 'response_status', 200)
        if not getattr(self, 'body_framed', False) and status >= 200 and status not in (204, 304) and self.command != 'HEAD':
            self.send_header('Connection', 'close')
        self.body_framed = False
        super().end_headers()

class AppServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    # A page opens a burst of module requests while other tabs and phones keep syncing. With
    # Python's default backlog of 5, Linux drops the extra connections and the browser retries
    # them only after 1, 2, 4, 8 and 16 seconds, so a page can sit half-loaded for 30 seconds.
    request_queue_size = 128

class AppServer6(AppServer):
    address_family = socket.AF_INET6

LOOPBACK_NAMES = {'127.0.0.1', 'localhost', '::1'}
# Everything a request handler reads from its server; every listening address shares one set.
SHARED = ('instance_file', 'allowed_hostname', 'allowed_hosts', 'remote_access', 'workspace', 'reconstruction',
          'material_research', 'model_conversion', 'video_frames', 'photo_placement', 'folder_intake')
log = logging.getLogger('tiksi.serve')

def resolve_host(host):
    """An address to listen on. 'tailscale' is this Mac's Tailscale address, None until Tailscale has one."""
    return this_mac_tailscale_address() if host == 'tailscale' else host

def bind(address, port):
    return (AppServer6 if ':' in address else AppServer)((address, port), AppHandler)

def share(source, target):
    for name in SHARED: setattr(target, name, getattr(source, name, None))

def listen_later(host, port, primary, servers, stopping, every=10):
    """Keep trying an address that is not on this Mac yet (Tailscale not up, say); serve it once it is."""
    logged = False
    while not stopping.wait(0 if not logged else every):
        try:
            address = resolve_host(host)
            if address is None: raise OSError(errno.EADDRNOTAVAIL, 'this Mac has no Tailscale address yet')
            server = bind(address, port)
        except OSError as error:
            if not logged: log.warning('Cannot listen on %s yet (%s); trying again every %d seconds.', host, error, every)
            logged = True
            continue
        share(primary, server)
        server.allowed_hosts = [*primary.allowed_hosts, address]
        servers.append(server)
        print(f'Tiksi listening on {address}:{port}', flush=True)
        if stopping.is_set(): server.server_close(); return
        server.serve_forever()
        return

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', action='append', help='address to listen on (default 127.0.0.1); repeat it to listen on several, '
                        'for example --host 127.0.0.1 --host tailscale, where "tailscale" is this Mac\'s Tailscale address')
    parser.add_argument('--port', type=int, default=8642)
    parser.add_argument('--instance-file', type=Path)
    parser.add_argument('--state-dir', type=Path, default=ROOT / '.tiksi-state')
    parser.add_argument('--projects-dir', type=Path, help='private project folders served to this Mac and its Tailscale clients')
    parser.add_argument('--allowed-host', action='append', default=[], help='explicit trusted proxy hostname, e.g. a Tailscale Serve name')
    args = parser.parse_args()
    hosts = args.host or ['127.0.0.1']
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(name)s: %(message)s', stream=sys.stderr)
    # The first address must be served now: a port in use there stops the start, as it always has.
    first = resolve_host(hosts[0])
    if first is None: parser.error('this Mac has no Tailscale address; list an address that is on this Mac first, such as 127.0.0.1')
    with bind(first, args.port) as server:
        port = server.server_port
        servers, later, stopping = [server], [], threading.Event()
        for host in hosts[1:]:
            # The other addresses are served too; one that is not on this Mac yet is tried again in the background.
            address = resolve_host(host)
            try:
                if address is None: raise OSError(errno.EADDRNOTAVAIL, 'not on this Mac yet')
                servers.append(bind(address, port))
            except OSError as error:
                if error.errno == errno.EADDRINUSE: raise
                later.append(host)
        server.instance_file = args.instance_file
        server.allowed_hostname = first
        server.allowed_hosts = [*args.allowed_host, *(s.server_address[0] for s in servers)]
        server.remote_access = any(h not in LOOPBACK_NAMES for h in hosts)
        sys.path.insert(0, str(ROOT))
        from server.workspace import WorkspaceService
        server.workspace = WorkspaceService(args.state_dir / 'workspace', args.projects_dir)
        def tidy(every=86400):
            # Stored originals nothing refers to any more are removed a minute after start, then daily.
            while not stopping.wait(60 if every is None else every):
                try: server.workspace.collect_blobs()
                except Exception: log.exception('Could not tidy the stored originals')
                every = 86400
        threading.Thread(target=tidy, args=(None,), daemon=True).start()
        server.reconstruction = None
        server.material_research = None
        if (ROOT / 'server/reconstruction.py').exists():
            sys.path.insert(0, str(ROOT))
            from server.reconstruction import ReconstructionService
            server.reconstruction = ReconstructionService(args.state_dir / 'reconstruction')
        if (ROOT / 'server/material_research.py').exists():
            sys.path.insert(0, str(ROOT))
            from server.material_research import MaterialResearchService
            server.material_research = MaterialResearchService(args.state_dir / 'material-research')
        if (ROOT / 'server/model_conversion.py').exists():
            sys.path.insert(0, str(ROOT))
            from server.model_conversion import ModelConversionService
            server.model_conversion = ModelConversionService(args.state_dir / 'converters')
        server.video_frames = None
        if (ROOT / 'server/video_frames.py').exists():
            # Frames from walk-through videos (MEASURE); reports honestly when ffmpeg is absent.
            from server.video_frames import VideoFrameService
            server.video_frames = VideoFrameService(args.state_dir / 'video-frames')
        server.photo_placement = None
        if (ROOT / 'server/photo_placement.py').exists():
            # Places site photos against a Polycam keyframe export; reports honestly when its runtime is absent.
            from server.photo_placement import PhotoPlacementService
            folders = lambda: [Path(p).parent for p in list(getattr(server.workspace, 'paths', {}).values())] + [server.workspace.projects_dir]
            server.photo_placement = PhotoPlacementService(args.state_dir / 'photo-placement', projects_dir=args.projects_dir, project_folders=folders)
        server.folder_intake = None
        if (ROOT / 'server/folder_intake.py').exists():
            # A property from a folder the owner picks on this Mac; files are read there, never changed.
            from server.folder_intake import FolderIntakeService
            server.folder_intake = FolderIntakeService(server.workspace)
        for other in servers[1:]: share(server, other)
        def shutdown(signum, frame):
            stopping.set()
            for each in list(servers): threading.Thread(target=each.shutdown, daemon=True).start()
        # A hung test asks for every thread's stack with SIGUSR1 (written to stderr).
        if hasattr(signal, 'SIGUSR1'): faulthandler.register(signal.SIGUSR1, all_threads=True)
        signal.signal(signal.SIGTERM, shutdown)
        signal.signal(signal.SIGINT, shutdown)
        for each in servers:
            print(f'Tiksi listening on {each.server_address[0]}:{port}', flush=True)
            if each is not server: threading.Thread(target=each.serve_forever, daemon=True).start()
        for host in later: threading.Thread(target=listen_later, args=(host, port, server, servers, stopping), daemon=True).start()
        try: server.serve_forever()
        finally:
            stopping.set()
            for each in servers[1:]: each.server_close()
            for name in ('reconstruction', 'material_research', 'model_conversion', 'video_frames', 'photo_placement', 'folder_intake'):
                service = getattr(server, name, None)
                if service: service.close()

if __name__ == '__main__': main()
