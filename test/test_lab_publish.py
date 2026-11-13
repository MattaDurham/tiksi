"""SEND TO THE LAB on the Mac: the copy kept here, the upload to the website's file storage (a
stand-in that records requests), the code sent once per version, old copies pruned, and the
preview. Synthetic files in temporary directories only; nothing reaches the network."""
import hashlib
import http.client
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
import urllib.error
from urllib.parse import urlsplit, parse_qs, unquote

from server.lab_publish import LabPublishService, LabError, R2, read_credentials, app_files, app_version, clean_path

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('tiksi_serve_lab', ROOT / 'tools/serve.py')
serve = importlib.util.module_from_spec(spec); spec.loader.exec_module(serve)


class FakeStorage:
    """An S3-shaped store: PUT, HEAD, DELETE on /<bucket>/<key> and ListObjectsV2 on /<bucket>."""
    def __init__(self):
        self.objects, self.requests = {}, []

    def __call__(self, req, timeout=None):
        url = urlsplit(req.full_url)
        parts = url.path.lstrip('/').split('/', 1)
        key = unquote(parts[1]) if len(parts) > 1 else ''
        headers = {k.lower(): v for k, v in req.header_items()}
        self.requests.append((req.get_method(), key, headers, req.data))
        method = req.get_method()
        if method == 'PUT': self.objects[key] = (req.data, headers.get('content-type')); return Reply(200, b'')
        if method == 'HEAD':
            if key in self.objects: return Reply(200, b'')
            raise urllib.error.HTTPError(req.full_url, 404, 'Not Found', {}, io.BytesIO(b''))
        if method == 'DELETE': self.objects.pop(key, None); return Reply(204, b'')
        prefix = parse_qs(url.query).get('prefix', [''])[0]
        body = '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' + ''.join(f'<Contents><Key>{k}</Key></Contents>' for k in sorted(self.objects) if k.startswith(prefix)) + '</ListBucketResult>'
        return Reply(200, body.encode())


class Reply:
    def __init__(self, status, body): self.status, self.body = status, body
    def read(self): return self.body
    def __enter__(self): return self
    def __exit__(self, *a): return False


def credentials(folder):
    path = folder / 'r2'
    path.write_text('# synthetic\nexport R2_ACCOUNT_ID=acct123\nR2_ACCESS_KEY_ID="AKSYNTHETIC"\nR2_SECRET_ACCESS_KEY=s3cr3t\n', encoding='utf-8')
    return path


def app_root(folder):
    root = folder / 'app'
    for rel, text in {'js/client-view.js': 'export {}', 'js/sub/x.js': '1', 'css/client.css': 'a{}', 'vendor/three.module.min.js': '//three',
                      'vendor/addons/libs/f.js': '//f', 'vendor/pdfjs/pdf.min.js': '//big', 'client.html': '<!doctype html>', 'js/.DS_Store': 'x'}.items():
        p = root / rel; p.parent.mkdir(parents=True, exist_ok=True); p.write_text(text, encoding='utf-8')
    return root


class Units(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.dir = Path(self.temp.name)
    def tearDown(self): self.temp.cleanup()

    def test_credentials_are_read_only_when_complete(self):
        self.assertEqual(read_credentials(credentials(self.dir)), {'account': 'acct123', 'key': 'AKSYNTHETIC', 'secret': 's3cr3t'})
        (self.dir / 'half').write_text('R2_ACCOUNT_ID=a\n', encoding='utf-8')
        self.assertIsNone(read_credentials(self.dir / 'half'))
        self.assertIsNone(read_credentials(self.dir / 'missing'))

    def test_names_must_be_plain(self):
        self.assertEqual(clean_path('v/1/files/a.glb'), 'v/1/files/a.glb')
        for bad in ('../x', 'a//b', '/a', 'a/.hidden', 'a/b c', ''):
            with self.assertRaises(LabError, msg=bad): clean_path(bad)

    def test_a_signed_upload_carries_its_hash_and_signature(self):
        store = FakeStorage()
        r2 = R2({'account': 'acct123', 'key': 'AKSYNTHETIC', 'secret': 's3cr3t'}, 'bucket', opener=store)
        r2.put('slug/data/v/1/a b.json', b'{"x":1}', 'application/json')
        method, key, headers, body = store.requests[0]
        self.assertEqual((method, key, body), ('PUT', 'slug/data/v/1/a b.json', b'{"x":1}'))
        self.assertEqual(headers['x-amz-content-sha256'], hashlib.sha256(b'{"x":1}').hexdigest())
        self.assertRegex(headers['authorization'], r'^AWS4-HMAC-SHA256 Credential=AKSYNTHETIC/\d{8}/auto/s3/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$')
        self.assertNotIn('s3cr3t', json.dumps(headers))
        self.assertTrue(r2.exists('slug/data/v/1/a b.json'))
        self.assertFalse(r2.exists('slug/data/nothing'))
        self.assertEqual(r2.list('slug/'), ['slug/data/v/1/a b.json'])

    def test_the_code_goes_once_per_version_marker_last(self):
        store = FakeStorage()
        root = app_root(self.dir)
        files = app_files(root)
        self.assertEqual(files, ['client.html', 'css/client.css', 'js/client-view.js', 'js/sub/x.js', 'vendor/addons/libs/f.js', 'vendor/three.module.min.js'])
        svc = LabPublishService(self.dir / 'state', credentials=credentials(self.dir), endpoint='https://r2.test', opener=store, root=root)
        out = svc.send_app('house')
        self.assertEqual(out, {'app': app_version(root), 'sent': len(files)})
        puts = [k for m, k, _, _ in store.requests if m == 'PUT']
        self.assertEqual(puts[-1], f"house/data/app/{out['app']}/.complete")
        self.assertEqual(store.objects[f"house/data/app/{out['app']}/js/client-view.js"][1], 'text/javascript')
        self.assertEqual(svc.send_app('house')['sent'], 0, 'already there, here and online')
        (root / 'js/client-view.js').write_text('export const changed = 1', encoding='utf-8')
        self.assertNotEqual(svc.send_app('house')['app'], out['app'])

    def test_without_a_key_sends_stay_on_this_mac(self):
        svc = LabPublishService(self.dir / 'state', credentials=self.dir / 'none')
        self.assertFalse(svc.capabilities()['upload'])
        self.assertEqual(svc.store('house', 'v/1/property.json', b'{}'), {'path': 'v/1/property.json', 'bytes': 2, 'uploaded': False})
        self.assertEqual((self.dir / 'state/lab/house/data/v/1/property.json').read_bytes(), b'{}')
        with self.assertRaises(LabError): svc.store('House!', 'a.json', b'')

    def test_pruning_keeps_the_newest_two_and_the_ones_asked(self):
        store = FakeStorage()
        svc = LabPublishService(self.dir / 'state', credentials=credentials(self.dir), endpoint='https://r2.test', opener=store)
        for i, v in enumerate(['v1', 'v2', 'v3', 'v4']):
            svc.store('house', f'v/{v}/property.json', b'{}')
            os.utime(self.dir / f'state/lab/house/data/v/{v}', (time.time() - 100 + i, time.time() - 100 + i))
        out = svc.prune('house', ['v1'])
        self.assertEqual(out['kept'], ['v1', 'v3', 'v4'])
        self.assertEqual(sorted(p.name for p in (self.dir / 'state/lab/house/data/v').iterdir()), ['v1', 'v3', 'v4'])
        self.assertEqual(sorted(store.objects), ['house/data/v/v1/property.json', 'house/data/v/v3/property.json', 'house/data/v/v4/property.json'])
        # Older code goes too, once current.json names the new one.
        for code in ('aaaa1111', 'bbbb2222'): svc.store('house', f'app/{code}/js/x.js', b'1')
        svc.store('house', 'current.json', b'{"version": "v4", "app": "bbbb2222"}')
        self.assertEqual(svc.prune('house', ['v4'])['app'], 'bbbb2222')
        self.assertEqual([p.name for p in (self.dir / 'state/lab/house/data/app').iterdir()], ['bbbb2222'])
        self.assertNotIn('house/data/app/aaaa1111/js/x.js', store.objects)
        self.assertIn('house/data/app/bbbb2222/js/x.js', store.objects)


class OverHttp(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.dir = Path(self.temp.name)
        self.store = FakeStorage()
        self.server = serve.AppServer(('127.0.0.1', 0), serve.AppHandler)
        self.server.instance_file = None; self.server.allowed_hostname = '127.0.0.1'; self.server.allowed_hosts = []; self.server.remote_access = False
        self.server.lab_publish = LabPublishService(self.dir / 'state', credentials=credentials(self.dir), endpoint='https://r2.test', opener=self.store, root=app_root(self.dir))
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.temp.cleanup()

    def ask(self, method, path, headers=None, body=None):
        c = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=10)
        c.request(method, path, body=body, headers=headers or {})
        r = c.getresponse(); data = r.read(); c.close()
        return r.status, data

    def test_send_then_preview(self):
        status, data = self.ask('GET', '/api/lab/capabilities')
        cap = json.loads(data)
        self.assertEqual((status, cap['upload']), (200, True))
        self.assertNotIn('s3cr3t', data.decode())
        self.assertEqual(self.ask('PUT', '/api/lab/files/house/v/1/property.json', body=b'{}')[0], 403, 'no token')
        token = {'X-Tiksi-Token': cap['token']}
        self.assertEqual(self.ask('PUT', '/api/lab/files/house/v/1/property.json', {**token, 'Origin': 'http://elsewhere.example'}, b'{}')[0], 403)
        status, data = self.ask('PUT', '/api/lab/files/house/v/1/property.json', token, b'{"format":"tiksi-client"}')
        self.assertEqual((status, json.loads(data)['uploaded']), (200, True))
        self.assertEqual(self.store.objects['house/data/v/1/property.json'], (b'{"format":"tiksi-client"}', 'application/json'))
        self.assertEqual(self.ask('PUT', '/api/lab/files/house/../x', token, b'{}')[0], 400)
        status, data = self.ask('POST', '/api/lab/app/house', token, b'{}')
        self.assertEqual(status, 200)
        # The preview: the page itself, then the copy kept on this Mac.
        status, page = self.ask('GET', '/lab-preview/house/')
        self.assertEqual((status, page), (200, b'<!doctype html>'))
        self.assertEqual(self.ask('GET', '/lab-preview/house/data/v/1/property.json'), (200, b'{"format":"tiksi-client"}'))
        self.assertEqual(self.ask('GET', '/lab-preview/house/data/%2e%2e/%2e%2e/r2')[0], 404)
        self.assertEqual(self.ask('GET', '/lab-preview/House/')[0], 404)


if __name__ == '__main__':
    unittest.main()
