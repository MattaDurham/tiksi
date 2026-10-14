#!/usr/bin/env python3
"""Serve public Tiksi assets and optional local services, excluding private files."""
import argparse
import html
import io
import ipaddress
import json
import os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import signal
import sys
import threading
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parent.parent
PUBLIC_FILES = {'index.html', 'manifest.webmanifest', 'app-icon.svg'}
PUBLIC_DIRS = {'css', 'js', 'vendor'}

class AppHandler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map,
                      '.js': 'text/javascript', '.webmanifest': 'application/manifest+json'}

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def valid_host(self):
        # Refuse DNS rebinding through arbitrary Host names. Numeric LAN and
        # Tailscale IPs work when explicitly binding beyond loopback.
        try:
            host = urlsplit('//' + self.headers.get('Host', '')).hostname
            if host in {'localhost', self.server.allowed_hostname, *getattr(self.server, 'allowed_hosts', [])}: return True
            address = ipaddress.ip_address(host or '')
            return address.is_loopback or self.server.remote_access
        except ValueError: return False

    def dispatch(self):
        if not self.valid_host():
            self.send_error(403, 'Host is not allowed')
            return True
        for name in ('reconstruction', 'material_research', 'model_conversion'):
            service = getattr(self.server, name, None)
            if service and service.dispatch(self): return True
        return False

    def do_GET(self):
        if not self.dispatch(): super().do_GET()

    def do_HEAD(self):
        if not self.valid_host(): self.send_error(403, 'Host is not allowed')
        else: super().do_HEAD()

    def do_POST(self):
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
        for name in ('reconstruction', 'material_research', 'model_conversion'):
            service = getattr(self.server, name, None)
            if service:
                active = getattr(service, 'active_jobs', None)
                # Optional adapter contract: active_jobs() is an integer count.
                if callable(active): result['activeJobs'] += active()
        return result

    def send_head(self):
        if not self.valid_host():
            self.send_error(403, 'Host is not allowed'); return None
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
        if target == ROOT / 'index.html' and getattr(self.server, 'instance_file', None):
            metadata = self.instance()
            badge = '<div style="position:fixed;bottom:8px;right:8px;z-index:2147483647;padding:6px 10px;background:#f3c467;color:#1b1b1b;font:12px monospace;border-radius:4px;pointer-events:none" aria-label="Branch preview">PREVIEW ' + html.escape(metadata.get('branch', 'unknown')) + ' / ' + html.escape(metadata.get('head', '')[:8]) + '</div>'
            document = target.read_text(encoding='utf-8').replace('</body>', badge + '\n</body>')
            return self.bytes_response(document.encode('utf-8'), 'text/html; charset=utf-8')
        return super().send_head()

    def bytes_response(self, payload, content_type):
        self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        return io.BytesIO(payload)

    def list_directory(self, path):
        self.send_error(404); return None

    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'same-origin')
        super().end_headers()

class AppServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8642)
    parser.add_argument('--instance-file', type=Path)
    parser.add_argument('--state-dir', type=Path, default=ROOT / '.tiksi-state')
    parser.add_argument('--allowed-host', action='append', default=[], help='explicit trusted proxy hostname, e.g. a Tailscale Serve name')
    args = parser.parse_args()
    with AppServer((args.host, args.port), AppHandler) as server:
        server.instance_file = args.instance_file
        server.allowed_hostname = args.host
        server.allowed_hosts = args.allowed_host
        server.remote_access = args.host not in {'127.0.0.1', 'localhost', '::1'}
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
        def shutdown(signum, frame):
            threading.Thread(target=server.shutdown, daemon=True).start()
        signal.signal(signal.SIGTERM, shutdown)
        signal.signal(signal.SIGINT, shutdown)
        print(f'Tiksi listening on {args.host}:{server.server_port}', flush=True)
        try: server.serve_forever()
        finally:
            for name in ('reconstruction', 'material_research', 'model_conversion'):
                service = getattr(server, name, None)
                if service: service.close()

if __name__ == '__main__': main()
