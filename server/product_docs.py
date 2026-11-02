"""Product documents from the public web: a spec sheet, installation guide with its
dimension drawing, or owner's manual, fetched for a fixture's identified product so the
browser can save it in the project's folder (the browser cannot read other sites' files).

Only public http(s) addresses are fetched, checked again after every redirect against the
addresses the name resolves to (never this Mac, the local network or link-local ranges).
Only PDFs and images are returned, at most 60 MB, and nothing is kept here: the bytes go
back to the browser with their SHA-256. The same `fetch_document` serves the onboarding
script (scripts/onboard-products.py)."""
import hashlib
import ipaddress
import json
import re
import secrets
import socket
from urllib.parse import urlsplit, unquote
import urllib.error
import urllib.request

MAX_BYTES = 60 * 1024 * 1024
TIMEOUT = 30
MAX_REDIRECTS = 4
TYPES = {'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp'}
AGENT = 'Tiksi product documents (local, owner-initiated)'


class DocumentError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def resolve(host):
    return [info[4][0] for info in socket.getaddrinfo(host, None)]


def check_url(url, resolver=resolve):
    """The URL when it is a public http(s) address; DocumentError otherwise."""
    if not isinstance(url, str) or len(url) > 4096:
        raise DocumentError('Send one document address')
    parts = urlsplit(url)
    host = parts.hostname or ''
    if parts.scheme not in ('http', 'https') or not host or parts.username or parts.password:
        raise DocumentError('Only public http or https addresses are fetched')
    if parts.port not in (None, 80, 443):
        raise DocumentError('Only the standard web ports are fetched')
    if host == 'localhost' or host.endswith(('.local', '.localhost', '.internal')) or '.' not in host.strip('[]'):
        raise DocumentError('Local addresses are not fetched')
    try:
        addresses = [ipaddress.ip_address(host.strip('[]'))]
    except ValueError:
        try:
            addresses = [ipaddress.ip_address(a.split('%')[0]) for a in resolver(host)]
        except OSError:
            raise DocumentError('The address does not resolve', 502) from None
    if not addresses or any(not a.is_global for a in addresses):
        raise DocumentError('Local addresses are not fetched')
    return url


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs): return None


def open_url(url):
    request = urllib.request.Request(url, headers={'User-Agent': AGENT, 'Accept': 'application/pdf,image/*;q=0.8'})
    return urllib.request.build_opener(NoRedirect).open(request, timeout=TIMEOUT)


def filename_of(url, disposition):
    m = re.search(r"filename\*?=(?:UTF-8'')?\"?([^\";]+)", disposition or '', re.I)
    name = unquote(m.group(1)) if m else unquote(urlsplit(url).path.rsplit('/', 1)[-1])
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', '-', name).strip(' .')[:120]
    return name or 'document'


def fetch_document(url, opener=open_url, resolver=resolve):
    """(bytes, info) for a public PDF or image. info: url (after redirects), mime, ext,
    sha256, bytes, filename."""
    current = check_url(url, resolver)
    for _ in range(MAX_REDIRECTS + 1):
        try:
            response = opener(current)
        except urllib.error.HTTPError as e:
            if e.code in (301, 302, 303, 307, 308) and e.headers.get('Location'):
                current = check_url(urllib.request.urljoin(current, e.headers['Location']), resolver)
                continue
            raise DocumentError('The site answered ' + str(e.code), 502) from None
        except (urllib.error.URLError, OSError) as e:
            raise DocumentError('The site could not be reached (' + str(getattr(e, 'reason', e))[:120] + ')', 502) from None
        break
    else:
        raise DocumentError('Too many redirects', 502)
    with response:
        status = getattr(response, 'status', 200)
        if status in (301, 302, 303, 307, 308):
            raise DocumentError('Too many redirects', 502)
        declared = int(response.headers.get('Content-Length') or 0)
        if declared > MAX_BYTES:
            raise DocumentError('Documents larger than 60 MB are not fetched', 413)
        data = response.read(MAX_BYTES + 1)
        if len(data) > MAX_BYTES:
            raise DocumentError('Documents larger than 60 MB are not fetched', 413)
        mime = (response.headers.get('Content-Type') or '').split(';')[0].strip().lower()
        # Servers often label a PDF as a generic download; the bytes decide.
        if data.startswith(b'%PDF-'): mime = 'application/pdf'
        elif data.startswith(b'\x89PNG'): mime = 'image/png'
        elif data.startswith(b'\xff\xd8\xff'): mime = 'image/jpeg'
        elif data[:4] == b'RIFF' and data[8:12] == b'WEBP': mime = 'image/webp'
        elif mime in TYPES: raise DocumentError('The file is not the ' + mime + ' it claims to be', 422)
        if mime not in TYPES:
            raise DocumentError('Only PDF and image documents are saved (this address returned ' + (mime or 'an unknown type') + ')', 415)
        name = filename_of(current, response.headers.get('Content-Disposition'))
        if not name.lower().endswith('.' + TYPES[mime]) and not (TYPES[mime] == 'jpg' and name.lower().endswith('.jpeg')):
            name += '.' + TYPES[mime]
        return data, {'url': current, 'mime': mime, 'ext': TYPES[mime], 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data), 'filename': name}


class ProductDocsService:
    def __init__(self, opener=open_url, resolver=resolve):
        self.token = secrets.token_urlsafe(32)
        self.opener, self.resolver = opener, resolver

    def active_jobs(self): return 0
    def close(self): pass

    def dispatch(self, h):
        base = '/api/product-docs'
        path = urlsplit(h.path).path
        if path != base and not path.startswith(base + '/'):
            return False
        try:
            from server.workspace import WorkspaceService
            if not WorkspaceService.trusted_peer(h.client_address[0]): raise DocumentError('Product documents require this Mac or Tailscale', 403)
            origin = h.headers.get('Origin')
            if origin and urlsplit(origin).netloc != h.headers.get('Host'): raise DocumentError('Use the Tiksi app on this server', 403)
            if h.headers.get('Sec-Fetch-Site') == 'cross-site': raise DocumentError('Cross-site requests are refused', 403)
            if h.headers.get('X-Tiksi-Docs') != '1': raise DocumentError('Use the Tiksi documents client', 403)
            if path == base + '/capabilities' and h.command == 'GET':
                return self.reply(h, 200, {'token': self.token, 'maxBytes': MAX_BYTES, 'types': sorted(TYPES)})
            if not secrets.compare_digest(h.headers.get('X-Tiksi-Token', ''), self.token): raise DocumentError('Reconnect to the documents service', 403)
            if path == base + '/fetch' and h.command == 'POST':
                try: length = int(h.headers.get('Content-Length', '0') or 0)
                except ValueError: raise DocumentError('Invalid content length')
                if not 0 < length <= 8192: raise DocumentError('Invalid document request', 413)
                try: request = json.loads(h.rfile.read(length))
                except ValueError: raise DocumentError('Document request must be JSON')
                if not isinstance(request, dict) or set(request) - {'url'}: raise DocumentError('Send only the document address')
                data, info = fetch_document(request.get('url'), self.opener, self.resolver)
                return self.reply(h, 200, data, info['mime'], {'X-Document-Info': json.dumps(info)})
            raise DocumentError('Documents endpoint not found', 404)
        except DocumentError as e:
            h.close_connection = True
            return self.reply(h, e.status, {'error': str(e)})
        except Exception:
            h.close_connection = True
            return self.reply(h, 500, {'error': 'The document could not be fetched'})

    @staticmethod
    def reply(h, status, value, mime='application/json', extra=None):
        data = value if isinstance(value, bytes) else json.dumps(value).encode('utf-8')
        h.send_response(status); h.send_header('Content-Type', mime); h.send_header('Content-Length', str(len(data))); h.send_header('Cache-Control', 'no-store')
        for name, header in (extra or {}).items(): h.send_header(name, header)
        h.end_headers(); h.wfile.write(data)
        return True
