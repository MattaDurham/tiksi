"""The real server answering for the page's own files and stored originals: ranges, reuse, size."""
import gzip
import http.client
import importlib.util
import io
import ipaddress
import json
from pathlib import Path
import re
import tempfile
import threading
import unittest
from unittest.mock import patch

from server import peers
from server.peers import Tailnet
from server.workspace import WorkspaceService

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('tiksi_serve_static', ROOT / 'tools/serve.py')
serve = importlib.util.module_from_spec(spec); spec.loader.exec_module(serve)
CLIP = '/js/guide-assets/plan.mp4'
WORKSPACE = {'X-Tiksi-Workspace': '1'}


class StaticFiles(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); state = Path(self.temp.name)
        trusted = patch.object(peers, 'TAILNET', Tailnet(ask=lambda: frozenset({ipaddress.ip_address('100.101.102.103')})))
        trusted.start(); self.addCleanup(trusted.stop)
        class Handler(serve.AppHandler):
            def log_message(self, *args): pass
        self.server = server = serve.AppServer(('127.0.0.1', 0), Handler)
        server.instance_file = None; server.allowed_hostname = '127.0.0.1'; server.allowed_hosts = []; server.remote_access = False
        server.workspace = WorkspaceService(state / 'workspace', state / 'projects')
        self.thread = threading.Thread(target=server.serve_forever, daemon=True); self.thread.start()
        self.token = json.loads(self.call('/api/workspace/capabilities', headers=WORKSPACE)[2])['token']

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join(timeout=3); self.temp.cleanup()

    def call(self, path, method='GET', headers=None, body=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=10)
        try:
            connection.request(method, path, body=body, headers=headers or {})
            response = connection.getresponse()
            return response.status, {k.lower(): v for k, v in response.getheaders()}, response.read()
        finally: connection.close()

    def test_a_guide_clip_is_sent_in_the_part_asked_for(self):
        whole = (ROOT / CLIP.lstrip('/')).read_bytes(); size = len(whole)
        status, headers, body = self.call(CLIP)
        self.assertEqual((status, body), (200, whole)); self.assertEqual(headers['accept-ranges'], 'bytes')
        for asked, start, end in (('bytes=0-99', 0, 99), ('bytes=100-', 100, size - 1), ('bytes=-10', size - 10, size - 1), ('bytes=5-999999999', 5, size - 1)):
            status, headers, body = self.call(CLIP, headers={'Range': asked})
            self.assertEqual(status, 206, asked)
            self.assertEqual(body, whole[start:end + 1], asked)
            self.assertEqual(headers['content-range'], 'bytes %d-%d/%d' % (start, end, size), asked)
            self.assertEqual(int(headers['content-length']), end - start + 1, asked)
        status, headers, body = self.call(CLIP, headers={'Range': 'bytes=%d-' % size})
        self.assertEqual(status, 416); self.assertEqual(headers['content-range'], 'bytes */%d' % size)
        # A range for another version of the file gets the whole current file.
        status, _, body = self.call(CLIP, headers={'Range': 'bytes=0-9', 'If-Range': '"another-version"'})
        self.assertEqual((status, body), (200, whole))
        # Several ranges at once are not split up: the whole file comes back.
        self.assertEqual(self.call(CLIP, headers={'Range': 'bytes=0-1,5-6'})[0], 200)

    def test_a_stored_original_is_sent_in_the_part_asked_for(self):
        payload = bytes(range(256)) * 400
        digest, _ = self.server.workspace.store_blob(io.BytesIO(payload))
        auth = {**WORKSPACE, 'X-Tiksi-Token': self.token}
        status, headers, body = self.call('/api/workspace/blobs/' + digest, headers={**auth, 'Range': 'bytes=1000-1999'})
        self.assertEqual((status, body), (206, payload[1000:2000]))
        self.assertEqual(headers['content-range'], 'bytes 1000-1999/%d' % len(payload))
        self.assertEqual(self.call('/api/workspace/blobs/' + digest, headers={**auth, 'Range': 'bytes=999999-'})[0], 416)
        self.assertEqual(self.call('/api/workspace/blobs/' + digest, headers=auth)[2], payload)


    def test_text_is_sent_compressed_to_a_browser_that_accepts_it(self):
        whole = (ROOT / 'js/main.js').read_bytes()
        status, headers, body = self.call('/js/main.js', headers={'Accept-Encoding': 'gzip, deflate, br'})
        self.assertEqual((status, headers.get('content-encoding')), (200, 'gzip'))
        self.assertEqual(gzip.decompress(body), whole)
        self.assertLess(len(body), len(whole) / 2)
        self.assertIn('Accept-Encoding', headers.get('vary', ''))
        tag = headers['etag']
        self.assertEqual(self.call('/js/main.js', headers={'Accept-Encoding': 'gzip', 'If-None-Match': tag})[0], 304)
        status, headers, body = self.call('/js/main.js')
        self.assertEqual((status, body, headers.get('content-encoding')), (200, whole, None), 'no gzip asked for: none sent')
        self.assertNotEqual(headers['etag'], tag, 'each encoding has its own validator')
        status, headers, body = self.call('/', headers={'Accept-Encoding': 'gzip'})
        self.assertEqual(headers.get('content-encoding'), 'gzip'); self.assertIn(b'tiksi-storage', gzip.decompress(body))
        # Video and pictures are not compressed again.
        self.assertIsNone(self.call(CLIP, headers={'Accept-Encoding': 'gzip'})[1].get('content-encoding'))

    def test_libraries_and_style_sheets_are_addressed_by_fingerprint_and_kept_without_asking(self):
        page = self.call('/')[2].decode()
        imports = json.loads(re.search(r'<script type="importmap">(.*?)</script>', page, re.S)[1])['imports']
        three = imports['three']
        self.assertRegex(three, r'^\./vendor/three\.module\.min\.js\?v=[0-9a-f]{16}$')
        self.assertEqual(imports['./vendor/three.module.min.js'], three, 'a bare and a relative import of one library reach one address')
        loader = imports['three/addons/loaders/GLTFLoader.js']
        self.assertEqual(imports['./vendor/addons/loaders/GLTFLoader.js'], loader)
        self.assertNotIn('./js/main.js', imports, "the page's own scripts keep their addresses")
        sheet = re.search(r'<link rel="stylesheet" href="(\./css/console\.css\?v=[0-9a-f]{16})"', page)[1]
        for address in (three, loader, sheet):
            status, headers, _ = self.call(address.lstrip('.'))
            self.assertEqual(status, 200, address)
            self.assertEqual(headers.get('cache-control'), 'public, max-age=31536000, immutable', address)
        # An old fingerprint, or none, is asked about each time.
        self.assertEqual(self.call('/vendor/three.module.min.js?v=0000000000000000')[1].get('cache-control'), 'no-cache')
        self.assertEqual(self.call('/vendor/three.module.min.js')[1].get('cache-control'), 'no-cache')
        self.assertEqual(self.call('/js/main.js')[1].get('cache-control'), 'no-cache')


if __name__ == '__main__': unittest.main()
