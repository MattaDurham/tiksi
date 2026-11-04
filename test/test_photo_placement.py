"""Photo placement: request checks, job lifecycle and HTTP posture with a stand-in worker, and,
when the optional NumPy + OpenCV runtime is installed, a full placement against a synthetic
textured room rendered here. Only temporary directories; never the owner's stores."""
import base64
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request

from server.photo_placement import PhotoPlacementService, PlacementError, validate, MAX_PHOTOS, INSTALL

ROOT = Path(__file__).resolve().parent.parent
RUNTIME = Path(os.environ.get('TIKSI_PHOTO_PLACEMENT_PYTHON') or ROOT / '.tiksi-state/photo-placement/venv/bin/python')
JPEG = base64.b64encode(b'\xff\xd8\xff\xe0' + b'\0' * 64).decode()
IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

FAKE_WORKER = r'''
import json, sys, time
from pathlib import Path
mode, folder = sys.argv[1], Path(sys.argv[2])
request = json.loads((folder / 'request.json').read_text())
def emit(event): print('TIKSI ' + json.dumps(event), flush=True)
if mode == 'sleep': time.sleep(30)
if mode == 'fail': emit({'error': 'No keyframes belong to the listed tracking segments'}); sys.exit(1)
if mode == 'crash': sys.stderr.write('Traceback: something broke\n'); sys.exit(3)
emit({'progress': {'done': 0, 'total': len(request['photos']), 'stage': 'Placing photos'}})
for photo in request['photos']:
    assert (folder / 'photos' / photo['file']).read_bytes().startswith(b'\xff\xd8\xff')
    emit({'result': {'id': photo['id'], 'ok': True, 'pose': [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 'inliers': 40, 'matches': 90,
                     'rmsPx': 1.5, 'keyframes': ['a'], 'reason': '', 'w': photo['w'], 'h': photo['h'], 'stride': request['stride']}})
'''


def photo(identifier='p1', **extra):
    return {'id': identifier, 'name': identifier + '.jpg', 'jpeg': JPEG, 'w': 1600, 'h': 1200, 'fx': 1300.0, 'fy': 1300.0,
            'cx': 800.0, 'cy': 600.0, 'takenAt': None, **extra}


def make_export(folder):
    for name in ('cameras', 'images', 'depth', 'confidence'): (folder / name).mkdir(parents=True, exist_ok=True)
    return folder


def wait(service, identifier, seconds=60):
    end = time.time() + seconds
    while time.time() < end:
        with service.lock: job = service.public(service.job(identifier))
        if job['status'] not in ('queued', 'running'): return job
        time.sleep(0.05)
    raise AssertionError('placement did not settle: ' + json.dumps(job))


class Requests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.projects = Path(self.temp.name) / 'projects'
        self.export = make_export(self.projects / 'House' / 'keyframes')

    def tearDown(self): self.temp.cleanup()

    def body(self, **changes):
        return {'exportDir': str(self.export), 'sessions': {'0': IDENTITY, '3': IDENTITY}, 'photos': [photo()], 'options': {'stride': 4}, **changes}

    def refused(self, body, text, status=400, projects=True):
        with self.assertRaises(PlacementError) as caught: validate(body, self.projects if projects else None)
        self.assertIn(text, str(caught.exception)); self.assertEqual(caught.exception.status, status)

    def test_a_good_request_is_normalised_and_unknown_fields_ignored(self):
        export, sessions, photos, stride = validate(self.body(extra=1, photos=[photo(note='x'), photo('p2', jpeg='data:image/jpeg;base64,' + JPEG)]), self.projects)
        self.assertEqual(export, self.export.resolve()); self.assertEqual(sorted(sessions), ['0', '3']); self.assertEqual(stride, 4)
        self.assertEqual(photos[1]['jpeg'][:3], b'\xff\xd8\xff'); self.assertNotIn('note', photos[0])
        self.assertEqual(validate(self.body(options=None), self.projects)[3], 4, 'stride defaults to 4')

    def test_the_export_must_be_a_raw_export_inside_the_projects_folder(self):
        self.refused(self.body(), 'knows none', 422, projects=False)
        outside = make_export(Path(self.temp.name) / 'elsewhere')
        self.refused(self.body(exportDir=str(outside)), 'inside a Tiksi project folder')
        self.refused(self.body(exportDir=str(self.projects / 'House' / 'keyframes' / '..' / '..' / '..' / 'elsewhere')), 'inside a Tiksi project folder')
        self.refused(self.body(exportDir='House/keyframes'), 'absolute')
        self.refused(self.body(exportDir=str(self.projects / 'missing')), 'does not exist', 404)
        (self.projects / 'Plain').mkdir(); self.refused(self.body(exportDir=str(self.projects / 'Plain')), 'missing cameras/, images/, depth/')
        link = self.projects / 'Link'; link.symlink_to(outside)
        self.refused(self.body(exportDir=str(link)), 'inside a Tiksi project folder')

    def test_wrong_types_are_refused(self):
        self.refused(self.body(sessions={}), 'sessions')
        self.refused(self.body(sessions={'0': IDENTITY[:15]}), '16 finite numbers')
        self.refused(self.body(sessions={'0': IDENTITY[:15] + [float('nan')]}), '16 finite numbers')
        self.refused(self.body(sessions={'zero': IDENTITY}), 'segment numbers')
        self.refused(self.body(photos=[]), 'non-empty')
        self.refused(self.body(photos=[photo(str(i)) for i in range(MAX_PHOTOS + 1)]), f'At most {MAX_PHOTOS}', 413)
        self.refused(self.body(photos=[photo(), photo()]), 'unique')
        self.refused(self.body(photos=[photo(w='1600')]), 'whole pixels')
        self.refused(self.body(photos=[photo(w=True)]), 'whole pixels')
        self.refused(self.body(photos=[photo(fx=-1)]), 'positive')
        self.refused(self.body(photos=[photo(takenAt=5)]), 'takenAt')
        self.refused(self.body(photos=[photo(jpeg='not base64!')]), 'base64')
        self.refused(self.body(photos=[photo(jpeg=base64.b64encode(b'\x89PNG\r\n').decode())]), 'JPEG')
        self.refused(self.body(options={'stride': 0}), 'stride')
        self.refused(self.body(options={'stride': 2.5}), 'stride')
        self.refused(self.body(options=[]), 'options')
        self.refused([], 'JSON object')


class Lifecycle(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); base = Path(self.temp.name)
        self.projects = base / 'projects'; self.export = make_export(self.projects / 'House' / 'keyframes')
        self.script = base / 'fake_worker.py'; self.script.write_text(FAKE_WORKER)
        self.state = base / 'state'

    def tearDown(self): self.temp.cleanup()

    def service(self, mode='ok'):
        return PhotoPlacementService(self.state, projects_dir=self.projects, worker_command=[sys.executable, str(self.script), mode])

    def body(self, n=2):
        return {'exportDir': str(self.export), 'sessions': {'0': IDENTITY}, 'photos': [photo('p%d' % i) for i in range(n)], 'options': {'stride': 2}}

    def body_for(self, export):
        return {**self.body(1), 'exportDir': str(export)}

    def test_missing_runtime_is_reported_with_the_install_command(self):
        service = PhotoPlacementService(self.state, projects_dir=self.projects, python=str(Path(self.temp.name) / 'no-python'))
        caps = service.capabilities()
        self.assertFalse(caps['available']); self.assertIn(INSTALL, caps['reason']); self.assertEqual(caps['install'], INSTALL); self.assertTrue(caps['token'])
        with self.assertRaises(PlacementError) as caught: service.create(self.body())
        self.assertEqual(caught.exception.status, 503)
        without = PhotoPlacementService(self.state, projects_dir=None, worker_command=[sys.executable, str(self.script), 'ok'])
        self.assertFalse(without.capabilities()['available']); self.assertIn('knows none', without.capabilities()['reason'])
        # A property saved to its own folder (as the live app keeps them) makes that folder readable.
        own = PhotoPlacementService(self.state, projects_dir=None, project_folders=lambda: [self.projects / 'House'], worker_command=[sys.executable, str(self.script), 'ok'])
        self.assertTrue(own.capabilities()['available'])
        self.assertEqual(validate(self.body_for(self.export), own.roots())[0], self.export.resolve())
        with self.assertRaises(PlacementError): validate(self.body_for(make_export(Path(self.temp.name) / 'other' / 'keyframes')), own.roots())

    def test_a_job_runs_reports_results_and_drops_its_photos(self):
        service = self.service()
        created = service.create(self.body())
        self.assertEqual(created['status'], 'queued'); self.assertRegex(created['id'], '^[a-f0-9]{32}$')
        job = wait(service, created['id'])
        self.assertEqual(job['status'], 'done', job); self.assertIsNone(job['error'])
        self.assertEqual([r['id'] for r in job['results']], ['p0', 'p1']); self.assertEqual(job['results'][0]['stride'], 2)
        self.assertEqual(job['progress'], {'done': 2, 'total': 2, 'stage': 'Done'})
        self.assertFalse((self.state / 'jobs' / created['id'] / 'photos').exists(), 'photos are not kept after the job')
        self.assertEqual(service.active_jobs(), 0)
        removed = service.cancel(created['id']); self.assertTrue(removed['removed'])
        with self.assertRaises(PlacementError): service.job(created['id'])

    def test_worker_errors_and_crashes_fail_the_job_plainly(self):
        service = self.service('fail'); job = wait(service, service.create(self.body())['id'])
        self.assertEqual(job['status'], 'failed'); self.assertIn('tracking segments', job['error'])
        service = self.service('crash'); job = wait(service, service.create(self.body())['id'])
        self.assertEqual(job['status'], 'failed'); self.assertIn('stopped unexpectedly', job['error'])

    def test_cancel_stops_a_running_worker_and_restart_marks_unfinished_jobs(self):
        service = self.service('sleep')
        identifier = service.create(self.body())['id']
        end = time.time() + 10
        while identifier not in service.processes and time.time() < end: time.sleep(0.02)
        self.assertEqual(service.active_jobs(), 1)
        self.assertEqual(service.cancel(identifier)['status'], 'cancelled')
        self.assertEqual(wait(service, identifier)['status'], 'cancelled')
        second = service.create(self.body())['id']
        with service.lock:
            job = service.jobs[second]; job['status'] = 'running'; service.save(job)
        service.cancel(second); service.close()
        record = json.loads((self.state / 'jobs' / second / 'job.json').read_text())
        record['status'] = 'running'; (self.state / 'jobs' / second / 'job.json').write_text(json.dumps(record))
        restarted = self.service()
        self.assertEqual(restarted.public(restarted.job(second))['status'], 'failed')
        self.assertIn('restarted', restarted.job(second)['error'])

    def test_http_requires_token_same_origin_and_trusted_peer(self):
        spec = importlib.util.spec_from_file_location('tiksi_serve', ROOT / 'tools/serve.py'); serve = importlib.util.module_from_spec(spec); spec.loader.exec_module(serve)
        class Quiet(serve.AppHandler):
            def log_message(self, *args): pass
        service = self.service()
        server = serve.AppServer(('127.0.0.1', 0), Quiet)
        server.instance_file = None; server.allowed_hostname = '127.0.0.1'; server.allowed_hosts = []; server.remote_access = False
        server.workspace = None; server.photo_placement = service
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        base = 'http://127.0.0.1:%d/api/photo-placement' % server.server_port
        def call(path, method='GET', headers=None, body=None):
            data = json.dumps(body).encode() if isinstance(body, (dict, list)) else body
            request = urllib.request.Request(base + path, data=data, method=method, headers={'Content-Type': 'application/json', **(headers or {})})
            try:
                with urllib.request.urlopen(request) as response: return response.status, json.loads(response.read())
            except urllib.error.HTTPError as error: return error.code, json.loads(error.read())
        try:
            status, caps = call('/capabilities'); self.assertEqual(status, 200)
            self.assertEqual((caps['available'], caps['reason'], caps['install']), (True, '', INSTALL))
            ok = {'X-Tiksi-Token': caps['token']}
            self.assertEqual(call('/jobs', 'POST', {'X-Tiksi-Token': 'wrong'}, self.body())[0], 403)
            self.assertEqual(call('/capabilities', headers={'Origin': 'http://evil.example'})[0], 403)
            self.assertEqual(call('/jobs', 'POST', {**ok, 'Sec-Fetch-Site': 'cross-site'}, self.body())[0], 403)
            self.assertEqual(call('/jobs', 'POST', ok, b'{nope')[0], 400)
            status, error = call('/jobs', 'POST', ok, {**self.body(), 'exportDir': '/etc'}); self.assertEqual(status, 400); self.assertIn('Tiksi project folder', error['error'])
            status, created = call('/jobs', 'POST', ok, self.body()); self.assertEqual((status, created['status']), (202, 'queued'))
            wait(service, created['id'])
            status, job = call('/jobs/' + created['id'], headers=ok)
            self.assertEqual(status, 200); self.assertEqual(sorted(job), ['error', 'id', 'progress', 'results', 'status']); self.assertEqual(job['status'], 'done')
            self.assertEqual(call('/jobs/' + '0' * 32, headers=ok)[0], 404)
            self.assertEqual(call('/jobs/../../etc', headers=ok)[0], 404)
            self.assertEqual(call('/jobs/' + created['id'], 'DELETE', ok)[0], 200)
            self.assertEqual(call('/jobs/' + created['id'], headers=ok)[0], 404)
        finally:
            server.shutdown(); server.server_close()
        class Remote:
            path = '/api/photo-placement/capabilities'; command = 'GET'; client_address = ('192.168.1.9', 1); headers = {}; wfile = io.BytesIO()
            def send_response(self, status): self.status = status
            def send_header(self, *args): pass
            def end_headers(self): pass
        remote = Remote(); service.dispatch(remote); self.assertEqual(remote.status, 403, 'LAN peers outside Tailscale are refused')


# Renders a textured box room from known ARKit poses into a Polycam-style raw export, plus one
# photo from a pose between keyframes with different intrinsics. Runs inside the OpenCV runtime.
SYNTHETIC = r'''
import json, sys, math
from pathlib import Path
import numpy as np, cv2
out = Path(sys.argv[1]); rng = np.random.default_rng(11)
LO, HI = np.array([-2.0, 0.0, -1.5]), np.array([2.0, 2.5, 1.5])
def texture():
    t = np.zeros((600, 600), np.float32)
    for size, weight in ((8, 1.0), (24, 0.6), (70, 0.35)):
        t += weight * cv2.resize(rng.random((size, size)).astype(np.float32), (600, 600), interpolation=cv2.INTER_CUBIC)
    t = (t - t.min()) / (t.max() - t.min()); return (t * 235 + 10).astype(np.float32)
walls = {(axis, side): texture() for axis in range(3) for side in range(2)}
def pose(position, yaw, pitch):
    cy, sy, cp, sp = math.cos(yaw), math.sin(yaw), math.cos(pitch), math.sin(pitch)
    Ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]]); Rx = np.array([[1, 0, 0], [0, cp, -sp], [0, sp, cp]])
    T = np.eye(4); T[:3, :3] = Ry @ Rx; T[:3, 3] = position; return T
def render(T, w, h, fx, fy, cx, cy):
    u, v = np.meshgrid(np.arange(w) + 0.0, np.arange(h) + 0.0)
    d = np.stack([(u - cx) / fx, -(v - cy) / fy, -np.ones_like(u)], -1) @ T[:3, :3].T
    o = T[:3, 3]; best = np.full(u.shape, np.inf); image = np.zeros(u.shape, np.float32)
    for axis in range(3):
        for side, bound in enumerate((LO[axis], HI[axis])):
            with np.errstate(divide='ignore', invalid='ignore'): t = (bound - o[axis]) / d[..., axis]
            hit = (t > 0) & (t < best)
            p = o + d * t[..., None]
            a, b = [k for k in range(3) if k != axis]
            ta = (p[..., a] - LO[a]) / (HI[a] - LO[a]) * 599; tb = (p[..., b] - LO[b]) / (HI[b] - LO[b]) * 599
            inside = hit & (ta >= 0) & (ta <= 599) & (tb >= 0) & (tb <= 599)
            sample = cv2.remap(walls[(axis, side)], np.nan_to_num(ta).astype(np.float32), np.nan_to_num(tb).astype(np.float32), cv2.INTER_LINEAR)
            image[inside] = sample[inside]; best[inside] = t[inside]
    return image, best   # z-depth equals t because the camera-space ray has z = -1
for name in ('cameras', 'images', 'depth', 'confidence'): (out / 'keyframes' / name).mkdir(parents=True, exist_ok=True)
W, H, F = 320, 240, 250.0
for n in range(36):
    yaw = n * math.radians(10); T = pose([0.3 * math.cos(yaw * 1.5), 1.4, 0.3 * math.sin(yaw * 1.5)], yaw, math.radians(-10 + 8 * math.sin(yaw * 2)))
    image, depth = render(T, W, H, F, F, W / 2, H / 2)
    stem = '%012d' % (100000000 + n * 1000000)
    cv2.imwrite(str(out / 'keyframes/images' / (stem + '.jpg')), image.astype(np.uint8), [cv2.IMWRITE_JPEG_QUALITY, 92])
    small = cv2.resize(depth.astype(np.float32), (W // 4, H // 4), interpolation=cv2.INTER_NEAREST)
    cv2.imwrite(str(out / 'keyframes/depth' / (stem + '.png')), np.clip(small * 1000, 0, 65535).astype(np.uint16))
    cv2.imwrite(str(out / 'keyframes/confidence' / (stem + '.png')), np.full(small.shape, 255, np.uint8))
    camera = {'fx': F, 'fy': F, 'cx': W / 2, 'cy': H / 2, 'width': W, 'height': H, 'tracking_segment': 0 if n < 30 else 1, 'blur_score': 100.0 + n, 'timestamp': n}
    camera.update({'t_%d%d' % (r, c): float(T[r, c]) for r in range(3) for c in range(4)})
    (out / 'keyframes/cameras' / (stem + '.json')).write_text(json.dumps(camera))
T = pose([0.15, 1.3, 0.1], math.radians(125), math.radians(-4))
w, h, f = 400, 300, 300.0
image, _ = render(T, w, h, f, f, w / 2 + 3, h / 2 - 2)
ok, jpeg = cv2.imencode('.jpg', image.astype(np.uint8), [cv2.IMWRITE_JPEG_QUALITY, 90])
print(json.dumps({'jpeg': jpeg.tobytes().hex(), 'w': w, 'h': h, 'fx': f, 'fy': f, 'cx': w / 2 + 3, 'cy': h / 2 - 2, 'pose': T.reshape(-1).tolist()}))
'''


@unittest.skipUnless(RUNTIME.is_file(), 'photo placement runtime not installed (' + INSTALL + ')')
class SyntheticPlacement(unittest.TestCase):
    def test_a_photo_of_a_synthetic_room_is_placed_in_model_coordinates(self):
        import math
        with tempfile.TemporaryDirectory() as temp:
            projects = Path(temp) / 'projects'; projects.mkdir()
            made = subprocess.run([str(RUNTIME), '-I', '-c', SYNTHETIC, str(projects)], capture_output=True, text=True, timeout=300)
            self.assertEqual(made.returncode, 0, made.stderr[-2000:])
            shot = json.loads(made.stdout)
            # Model world = Polycam world turned 90 degrees about +x (y-up to z-up) and moved.
            S = [1, 0, 0, 5.0, 0, 0, -1, -2.0, 0, 1, 0, 0.5, 0, 0, 0, 1]
            service = PhotoPlacementService(Path(temp) / 'state', projects_dir=projects, python=str(RUNTIME))
            self.assertTrue(service.capabilities()['available'], service.capabilities()['reason'])
            body = {'exportDir': str(projects / 'keyframes'), 'sessions': {'0': S}, 'options': {'stride': 2},
                    'photos': [{'id': 'room', 'name': 'room.jpg', 'jpeg': base64.b64encode(bytes.fromhex(shot['jpeg'])).decode(),
                                **{k: shot[k] for k in ('w', 'h', 'fx', 'fy', 'cx', 'cy')}, 'takenAt': None}]}
            started = time.time(); job = wait(service, service.create(body)['id'], 300)
            self.assertEqual(job['status'], 'done', job); result = job['results'][0]
            self.assertTrue(result['ok'], result); self.assertGreaterEqual(result['inliers'], 30); self.assertLess(result['rmsPx'], 2.0)
            self.assertTrue(all(int(stem) < 130000000 for stem in result['keyframes']), 'segment 1 has no session, so it is not used')
            mul = lambda A, B: [[sum(A[r][k] * B[k][c] for k in range(4)) for c in range(4)] for r in range(4)]
            rows = lambda flat: [flat[i:i + 4] for i in range(0, 16, 4)]
            expected, got = mul(rows(S), rows(shot['pose'])), rows(result['pose'])
            self.assertLess(math.dist([expected[r][3] for r in range(3)], [got[r][3] for r in range(3)]), 0.03, 'within 3 cm')
            trace = sum(expected[k][r] * got[k][r] for r in range(3) for k in range(3))
            self.assertLess(math.degrees(math.acos(max(-1, min(1, (trace - 1) / 2)))), 0.5, 'within half a degree')
            self.assertEqual([result[k] for k in ('w', 'h', 'fx')], [shot['w'], shot['h'], shot['fx']])
            first = time.time() - started
            # A second job reuses the cached keyframe descriptors.
            again = wait(service, service.create(body)['id'], 300)
            self.assertTrue(again['results'][0]['ok']); self.assertTrue(any((Path(temp) / 'state' / 'cache').rglob('*.npz')))
            self.assertLess(time.time() - started - first, first + 5)


if __name__ == '__main__': unittest.main()
