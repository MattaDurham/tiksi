"""The real server answering for the page's own files and stored originals: ranges, reuse, size."""
import gzip
import hashlib
import http.client
import importlib.util
import io
import ipaddress
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import zipfile

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


    def test_a_page_can_ask_whether_the_mac_holds_an_original_without_downloading_it(self):
        payload = b'synthetic original ' * 1000
        digest, _ = self.server.workspace.store_blob(io.BytesIO(payload))
        auth = {**WORKSPACE, 'X-Tiksi-Token': self.token}
        status, headers, body = self.call('/api/workspace/blobs/' + digest, 'HEAD', auth)
        self.assertEqual((status, body), (200, b'')); self.assertEqual(int(headers['content-length']), len(payload))
        self.assertEqual(self.call('/api/workspace/blobs/' + 'f' * 64, 'HEAD', auth)[0], 404)
        self.assertEqual(self.call('/api/workspace/blobs/' + digest, 'HEAD', WORKSPACE)[0], 403, 'the token is still needed')
        # The connection stays usable after a HEAD answer: the next answer is read whole.
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=10)
        try:
            for method in ('HEAD', 'GET', 'HEAD', 'GET'):
                connection.request(method, '/api/workspace/blobs/' + digest, headers=auth)
                response = connection.getresponse(); got = response.read()
                self.assertEqual((response.status, got), (200, payload if method == 'GET' else b''), method)
        finally: connection.close()
        status, _, body = self.call('/api/workspace/blobs/held', 'POST', {**auth, 'Content-Type': 'application/json'},
                                    json.dumps({'hashes': [digest, 'f' * 64, 'not a hash', digest]}).encode())
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {'held': [digest], 'sizes': {digest: len(payload)}})


    def test_an_original_sent_in_pieces_continues_where_a_stalled_upload_stopped(self):
        payload = bytes(range(256)) * 4000; digest = hashlib.sha256(payload).hexdigest(); size = len(payload)
        auth = {**WORKSPACE, 'X-Tiksi-Token': self.token}
        def put(offset, piece, declared=size):
            status, _, body = self.call('/api/workspace/uploads/' + digest, 'PUT', {**auth, 'X-Upload-Size': str(declared), 'X-Upload-Offset': str(offset)}, piece)
            return status, json.loads(body)
        ask = lambda: json.loads(self.call('/api/workspace/uploads/' + digest, headers=auth)[2])
        self.assertEqual(ask(), {'hash': digest, 'size': None, 'received': 0, 'done': False})
        self.assertEqual(put(0, payload[:300000]), (200, {'hash': digest, 'size': size, 'received': 300000, 'done': False}))
        # The next piece stalls: the connection breaks after 123456 of its 400000 bytes.
        raw = socket.create_connection(('127.0.0.1', self.server.server_port), timeout=10)
        head = ('PUT /api/workspace/uploads/%s HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Tiksi-Workspace: 1\r\nX-Tiksi-Token: %s\r\n'
                'X-Upload-Size: %d\r\nX-Upload-Offset: 300000\r\nContent-Length: 400000\r\n\r\n') % (digest, self.token, size)
        raw.sendall(head.encode() + payload[300000:423456]); raw.shutdown(socket.SHUT_WR)
        try: raw.recv(65536)
        finally: raw.close()
        for _ in range(100):
            if ask()['received'] == 423456: break
            time.sleep(0.02)
        self.assertEqual(ask()['received'], 423456, 'what arrived is kept')
        status, reply = put(0, payload[:10])
        self.assertEqual((status, reply['code'], reply['received']), (409, 'upload-offset', 423456), 'a piece from the wrong place is refused and told where to start')
        self.assertEqual(put(423456, payload[423456:]), (200, {'hash': digest, 'size': size, 'received': size, 'done': True}))
        self.assertEqual(self.call('/api/workspace/blobs/' + digest, headers=auth)[2], payload, 'it is a stored original now')
        self.assertTrue(ask()['done'])
        self.assertEqual(list((self.server.workspace.root / 'uploads').iterdir()), [], 'nothing of the upload is left behind')
        # The whole-file upload still works as before.
        status, _, body = self.call('/api/workspace/blobs', 'POST', auth, b'whole file at once')
        self.assertEqual((status, json.loads(body)['hash']), (200, hashlib.sha256(b'whole file at once').hexdigest()))

    def test_an_original_that_does_not_match_its_hash_is_not_stored(self):
        auth = {**WORKSPACE, 'X-Tiksi-Token': self.token}; digest = 'a' * 64
        status, _, body = self.call('/api/workspace/uploads/' + digest, 'PUT', {**auth, 'X-Upload-Size': '5', 'X-Upload-Offset': '0'}, b'wrong')
        self.assertEqual(status, 422)
        self.assertFalse((self.server.workspace.root / 'blobs' / digest).exists())
        self.assertEqual(json.loads(self.call('/api/workspace/uploads/' + digest, headers=auth)[2])['received'], 0, 'it starts again from nothing')


    def save(self, name, save_id=None, revision=None):
        data = {'version': 2, 'settings': {}, 'properties': [{'id': 'prop-a', 'name': name, 'scans': [], 'photos': []}], 'projects': [], 'materials': [], 'products': []}
        auth = {**WORKSPACE, 'X-Tiksi-Token': self.token}
        if revision is None: revision = json.loads(self.call('/api/workspace/head', headers=auth)[2])['revision']
        request = {'revision': revision, 'data': data, 'assets': {}, 'pictureFiles': True, 'projectData': {'prop-a': {**data}}, **({'saveId': save_id} if save_id else {})}
        status, _, body = self.call('/api/workspace', 'PUT', {**auth, 'Content-Type': 'application/json'}, json.dumps(request).encode())
        return status, json.loads(body)

    def test_a_save_sent_twice_with_its_id_is_committed_once(self):
        auth = {**WORKSPACE, 'X-Tiksi-Token': self.token}
        ask = lambda save_id: json.loads(self.call('/api/workspace/saves?id=' + save_id, headers=auth)[2])
        self.assertEqual(ask('phone-1:7'), {'saveId': 'phone-1:7', 'committed': False, 'revision': None})
        start = json.loads(self.call('/api/workspace/head', headers=auth)[2])['revision']
        status, first = self.save('Kitchen', 'phone-1:7', start)
        self.assertEqual(status, 200); self.assertEqual((first['saveId'], first['repeated']), ('phone-1:7', False))
        self.save('Kitchen, edited on the Mac')
        path = Path(self.server.workspace.paths['prop-a']); before = path.read_bytes()
        # The phone froze before it saw the answer and sends the same save again on its next open.
        status, again = self.save('Kitchen', 'phone-1:7', start)
        self.assertEqual(status, 200)
        self.assertEqual((again['revision'], again['repeated']), (first['revision'], True), 'answered with the revision that commit made')
        self.assertEqual(path.read_bytes(), before, 'the later edit on the Mac is not undone')
        self.assertEqual(ask('phone-1:7'), {'saveId': 'phone-1:7', 'committed': True, 'revision': first['revision']})
        head = json.loads(self.call('/api/workspace/head?saveId=phone-1%3A7', headers=auth)[2])
        self.assertEqual(head['save'], {'saveId': 'phone-1:7', 'committed': True, 'revision': first['revision']})
        self.assertGreater(head['revision'], first['revision'])
        # The record survives a restart and is never written into a project file.
        restarted = WorkspaceService(self.server.workspace.root, self.server.workspace.projects_dir)
        self.assertEqual(restarted.committed('phone-1:7'), first['revision'])
        with zipfile.ZipFile(path) as archive: self.assertNotIn(b'phone-1:7', archive.read('workspace.json'))
        self.assertEqual(self.save('Kitchen', 'x' * 201)[0], 400)
        # The same id with a different save is refused, not taken as already done.
        status, reused = self.save('Kitchen, something else', 'phone-1:7')
        self.assertEqual((status, reused.get('code')), (409, 'save-id-reused'))
        self.assertEqual(path.read_bytes(), before, 'nothing of it was written')


    def test_a_phone_gets_a_smaller_copy_of_a_large_picture_made_on_the_mac(self):
        # The Mac's image tool (sips) is stood in for, so this runs on any computer: it reports a
        # picture's size and writes a smaller copy, as sips does.
        calls = []
        def image_tool(command, **kwargs):
            calls.append(command[1])
            if command[1] == '-g': return subprocess.CompletedProcess(command, 0, '  pixelWidth: 1800\n  pixelHeight: 1200\n', '')
            Path(command[-1]).write_bytes(b'\xff\xd8 smaller copy, longest side ' + command[2].encode())
            return subprocess.CompletedProcess(command, 0, '', '')
        self.server.workspace.run = image_tool
        photo = b'\xff\xd8 a large synthetic photo ' * 2000
        digest, size = self.server.workspace.store_blob(io.BytesIO(photo))
        auth = {**WORKSPACE, 'X-Tiksi-Token': self.token}
        with patch('server.workspace.shutil.which', return_value='/usr/bin/sips'):
            status, headers, body = self.call('/api/workspace/blobs/' + digest + '?size=512', headers=auth)
            self.assertEqual((status, headers['content-type'], headers['x-tiksi-preview'], body), (200, 'image/jpeg', 'smaller', b'\xff\xd8 smaller copy, longest side 512'))
            self.assertEqual(self.call('/api/workspace/blobs/' + digest + '?size=512', headers={**auth, 'If-None-Match': headers['etag']})[0], 304)
            self.assertEqual(self.call('/api/workspace/blobs/' + digest + '?size=512', headers=auth)[2], body)
            self.assertEqual(calls, ['-g', '-Z'], 'the copy is made once and kept')
            # A picture already that small comes back as it is; an odd size is refused.
            status, headers, body = self.call('/api/workspace/blobs/' + digest + '?size=2048', headers=auth)
            self.assertEqual((status, headers['x-tiksi-preview'], body), (200, 'original', photo))
            self.assertEqual(self.call('/api/workspace/blobs/' + digest + '?size=777', headers=auth)[0], 400)

    def test_a_file_that_is_not_a_picture_gets_no_smaller_copy_and_the_page_is_told(self):
        digest, _ = self.server.workspace.store_blob(io.BytesIO(b'a scan, not a picture'))
        auth = {**WORKSPACE, 'X-Tiksi-Token': self.token}
        status, _, body = self.call('/api/workspace/blobs/' + digest + '?size=512', headers=auth)
        self.assertEqual((status, json.loads(body).get('code')), (415, 'no-preview'))
        with patch('server.workspace.shutil.which', return_value=None), patch('server.workspace.Path.is_file', autospec=True, side_effect=lambda p: 'sips' not in str(p) and os.path.isfile(p)):
            status, _, body = self.call('/api/workspace/blobs/' + digest + '?size=256', headers=auth)
        self.assertEqual((status, json.loads(body).get('code')), (415, 'no-preview'), 'a Mac without the image tool says so')


if __name__ == '__main__': unittest.main()
