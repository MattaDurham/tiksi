"""Tests use private temporary state and fake workers; no owner's files are read."""
import base64
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
from pathlib import Path
import struct
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen
import zipfile

from server.obj2glb import convert
from server.reconstruction import APIError, ReconstructionService

PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==")
PHOTO = b"\xff\xd8\xff\xe1Synthetic camera EXIF original bytes\xff\xd9"
OBJ = "mtllib model.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nvt 0 0\nvt 1 0\nvt 0 1\nvn 0 0 1\nusemtl surface\nf 1/1/1 2/2/1 3/3/1\n"
WORKER = '''import base64,json,pathlib,sys,time
if sys.argv[1] == '--check': print(json.dumps({'event':'available'}));sys.exit(0)
folder = pathlib.Path(sys.argv[2])
quality = sys.argv[3]
if quality == 'full': time.sleep(60)
if quality == 'raw': print(json.dumps({'event':'error','message':'Cannot align these images'}));sys.exit(1)
folder.mkdir()
(folder/'model.obj').write_text(OBJ,encoding='utf-8')
(folder/'model.mtl').write_text('newmtl surface\\nmap_Kd texture.png\\nnorm texture.png\\nmap_ao texture.png\\nmap_Pr texture.png\\ndisp displacement.exr\\n',encoding='utf-8')
(folder/'texture.png').write_bytes(base64.b64decode(PNG))
(folder/'displacement.exr').write_bytes(b'Synthetic native EXR preservation')
print(json.dumps({'event':'progress','progress':.8}))
print(json.dumps({'event':'warning','message':'Synthetic skipped image'}))
print(json.dumps({'event':'complete'}))
'''


def document(path):
    data = path.read_bytes()
    magic, version, length = struct.unpack_from('<4sII', data)
    assert magic == b'glTF' and version == 2 and length == len(data)
    size = struct.unpack_from('<I', data, 12)[0]
    return json.loads(data[20:20+size]), data


class ReconstructionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='tiksi-reconstruction-test-')
        self.root = Path(self.temp.name)
        self.worker = self.root / 'worker.py'
        self.worker.write_text('OBJ=' + repr(OBJ) + '\nPNG=' + repr(base64.b64encode(PNG).decode()) + '\n' + WORKER, encoding='utf-8')
        self.service = ReconstructionService(self.root / 'state', engine=self.worker, engine_command=[sys.executable, str(self.worker)])

    def tearDown(self):
        self.service.close()
        limit = time.monotonic() + 5
        while self.service.processes and time.monotonic() < limit: time.sleep(.02)
        self.temp.cleanup()

    def photos(self, quality='medium'):
        job = self.service.create({'name': 'Test model', 'quality': quality})
        for _ in range(20): self.service.upload(job['id'], 'original.JPG', len(PHOTO), io.BytesIO(PHOTO))
        return self.service.jobs[job['id']]

    def wait(self, job):
        limit = time.monotonic() + 10
        while job['state'] not in {'complete','failed','cancelled','interrupted'} and time.monotonic() < limit: time.sleep(.02)
        self.assertIn(job['state'], {'complete','failed','cancelled','interrupted'})
        return job

    def test_real_process_job_packages_textures_and_preserves_original_upload(self):
        job = self.photos()
        self.assertEqual((self.root/'state'/job['id']/'images/image-0000.jpg').read_bytes(), PHOTO)
        self.service.start(job['id']); self.wait(job)
        self.assertEqual(job['state'], 'complete', job['error'])
        doc, _ = document(self.root/'state'/job['id']/'model.glb')
        self.assertEqual(job['stats']['triangles'], 1)
        self.assertEqual(len(doc['images']), 4)
        self.assertIn('normalTexture', doc['materials'][0])
        self.assertIn('occlusionTexture', doc['materials'][0])
        self.assertTrue(all('uri' not in i for i in doc['images']))
        self.assertIn('Synthetic skipped image', job['warnings'])
        self.assertIn('glTF does not apply displacement', job['warnings'][1])
        self.assertIn('metallicRoughnessTexture', doc['materials'][0]['pbrMetallicRoughness'])
        self.assertEqual(job['stats']['displacementMaps'], 1)

    def test_failure_is_reported_without_model_success(self):
        job = self.photos('raw'); self.service.start(job['id']); self.wait(job)
        self.assertEqual(job['state'], 'failed'); self.assertIn('Cannot align', job['error'])
        self.assertFalse((self.root/'state'/job['id']/'model.glb').exists())

    def test_cancel_stops_worker_and_only_one_job_can_run(self):
        job = self.photos('full'); other = self.photos()
        self.service.start(job['id'])
        with self.assertRaises(APIError) as caught: self.service.start(other['id'])
        self.assertEqual(caught.exception.code, 409)
        self.service.cancel(job['id'])
        self.wait(job); self.assertEqual(job['state'], 'cancelled')
        deadline = time.monotonic()+3
        while self.service.processes and time.monotonic()<deadline: time.sleep(.02)
        self.assertEqual(self.service.processes, {})
        self.service.delete(job['id']); self.assertFalse((self.root/'state'/job['id']).exists())
        self.assertEqual(self.service.jobs[other['id']]['state'], 'draft')

    def test_restart_marks_inflight_jobs_interrupted(self):
        job = self.photos(); job['state'] = 'running'; self.service._save(job)
        restarted = ReconstructionService(self.root/'state', engine=self.worker)
        self.assertEqual(restarted.jobs[job['id']]['state'], 'interrupted')
        self.assertIn('stopped', restarted.jobs[job['id']]['error'])
        restarted.close()

    def test_limits_invalid_bytes_and_minimum_are_enforced(self):
        job = self.service.create({})
        for name, body in [('payload.exe', PHOTO), ('wrong.jpg', b'not a photo')]:
            with self.assertRaises(APIError): self.service.upload(job['id'], name, len(body), io.BytesIO(body))
        self.assertEqual(self.service.jobs[job['id']]['images'], 0)
        with self.assertRaises(APIError): self.service.start(job['id'])
        with self.assertRaises(APIError): self.service.upload(job['id'], 'x.jpg', 100000000, io.BytesIO(b''))
        with self.assertRaises(APIError): self.service.upload(job['id'], 'x.jpg', len(PHOTO), io.BytesIO(PHOTO[:3]))
        self.assertEqual(self.service.jobs[job['id']]['state'], 'draft')
        with patch('server.reconstruction.MAX_IMAGES', 1):
            self.service.upload(job['id'], 'a.jpg', len(PHOTO), io.BytesIO(PHOTO))
            with self.assertRaises(APIError): self.service.upload(job['id'], 'b.jpg', len(PHOTO), io.BytesIO(PHOTO))
        with patch('server.reconstruction.MAX_JOBS', 1):
            with self.assertRaises(APIError): self.service.create({})

    def test_http_requires_server_token_and_blocks_cross_origin(self):
        service = self.service
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self): service.dispatch(self)
            def do_POST(self): service.dispatch(self)
            def do_PUT(self): service.dispatch(self)
            def do_DELETE(self): service.dispatch(self)
            def log_message(self, *args): pass
        server = ThreadingHTTPServer(('localhost',0),Handler)
        worker = threading.Thread(target=server.serve_forever, daemon=True); worker.start()
        base = 'http://localhost:' + str(server.server_address[1]) + '/api/reconstruction'
        try:
            with urlopen(base+'/capabilities', timeout=3) as response: caps=json.load(response)
            for headers in [{}, {'X-Tiksi-Token':caps['token'],'Origin':'https://evil.example.com'}, {'X-Tiksi-Token':caps['token'],'Sec-Fetch-Site':'cross-site'}]:
                with self.assertRaises(HTTPError) as caught: urlopen(Request(base+'/jobs',data=b'{}',headers=headers),timeout=3)
                self.assertEqual(caught.exception.code,403)
                caught.exception.close()
            headers={'X-Tiksi-Token':caps['token'],'Content-Type':'application/json'}
            with urlopen(Request(base+'/jobs',data=b'{}',headers=headers), timeout=3) as response: job=json.load(response)
            with self.assertRaises(HTTPError) as caught:
                urlopen(Request(base+'/jobs/'+job['id']+'/images',data=b'not jpeg',method='PUT',headers={**headers,'X-Image-Name':'x.jpg'}),timeout=3)
            self.assertEqual(caught.exception.code,415)
            caught.exception.close()
            with urlopen(Request(base+'/jobs/'+job['id'],headers=headers),timeout=3) as response: self.assertEqual(json.load(response)['images'],0)
            with urlopen(Request(base+'/jobs/'+job['id'],method='DELETE',headers=headers),timeout=3) as response: self.assertTrue(json.load(response)['removed'])
            generated = self.photos(); self.service.start(generated['id']); self.wait(generated)
            with urlopen(Request(base+'/jobs/'+generated['id']+'/native',headers=headers),timeout=3) as response:
                archive=zipfile.ZipFile(io.BytesIO(response.read()))
                self.assertEqual(archive.read('displacement.exr'),b'Synthetic native EXR preservation')
                self.assertIn('texture.png',archive.namelist());archive.close()
        finally: server.shutdown(); server.server_close(); worker.join(timeout=3)

    def test_obj_converter_rejects_texture_path_escape_and_invalid_indices(self):
        folder = self.root/'model'; folder.mkdir()
        obj = folder/'model.obj'; obj.write_text(OBJ,encoding='utf-8')
        (folder/'model.mtl').write_text('newmtl surface\nmap_Kd ../../secret.png\n',encoding='utf-8')
        with self.assertRaisesRegex(ValueError,'outside'): convert(obj,folder/'model.glb')
        obj.write_text('v 0 0 0\nf 1 2 3\n',encoding='utf-8')
        with self.assertRaisesRegex(ValueError,'index'): convert(obj,folder/'model.glb')

    def test_engine_missing_is_named_and_create_is_rejected(self):
        service = ReconstructionService(self.root/'unbuilt')
        self.assertFalse(service.capabilities()['available'])
        with self.assertRaises(APIError) as caught: service.create({})
        self.assertEqual(caught.exception.code,503)
        service.close()


if __name__ == '__main__': unittest.main()
