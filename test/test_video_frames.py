"""Video frames for tape review: synthetic ffmpeg videos in temporary directories only."""
import hashlib
import io
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request

from server.video_frames import VideoFrameService, VideoError, tape_component, sharpness, find_tool

FFMPEG, FFPROBE = shutil.which('ffmpeg'), shutil.which('ffprobe')
ROOT = Path(__file__).resolve().parent.parent
YELLOW, ORANGE = '0xF2C811', '0xD08030'


def make(path, source, filters=None, extra=()):
    args = [FFMPEG, '-v', 'error', '-y', '-f', 'lavfi', '-i', source]
    if filters: args += ['-vf', filters]
    subprocess.run(args + [*extra, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(path)], check=True)
    return path


def jpeg_size(data):
    """Width and height from a baseline/progressive JPEG's SOF marker."""
    i = 2
    while i < len(data):
        marker, length = data[i + 1], int.from_bytes(data[i + 2:i + 4], 'big')
        if marker in (0xC0, 0xC1, 0xC2): return int.from_bytes(data[i + 7:i + 9], 'big'), int.from_bytes(data[i + 5:i + 7], 'big')
        i += 2 + length
    raise AssertionError('no JPEG frame header')


def wait(service, identifier, states=('queued', 'analyzing'), seconds=30):
    end = time.time() + seconds
    while time.time() < end:
        job = service.load(identifier)
        if job['state'] not in states: return job
        time.sleep(0.05)
    raise AssertionError('analysis did not settle: ' + json.dumps(service.load(identifier)))


class PureMeasures(unittest.TestCase):
    def frame(self, w, h, rects):
        data = bytearray([128] * (w * h * 3))
        for (x0, y0, x1, y1, rgb) in rects:
            for y in range(y0, y1):
                for x in range(x0, x1): data[(y * w + x) * 3:(y * w + x) * 3 + 3] = bytes(rgb)
        return bytes(data)

    def test_only_elongated_yellow_components_are_tape(self):
        w, h = 160, 90
        self.assertIsNone(tape_component(self.frame(w, h, []), w, h))
        self.assertIsNone(tape_component(self.frame(w, h, [(60, 30, 80, 50, (242, 200, 17))]), w, h), 'a yellow square is not a blade')
        self.assertIsNone(tape_component(self.frame(w, h, [(20, 40, 140, 44, (208, 128, 48))]), w, h), 'an orange (wood) strip is not a blade')
        self.assertIsNone(tape_component(self.frame(w, h, [(20, 40, 24, 41, (242, 200, 17))]), w, h), 'a few yellow pixels are noise')
        found = tape_component(self.frame(w, h, [(20, 40, 140, 44, (242, 200, 17))]), w, h)
        self.assertGreater(found['elongation'], 20); self.assertEqual(found['box'], [0.125, 0.4444, 0.75, 0.0444])
        diagonal = self.frame(w, h, [(10 + i, 10 + i // 2, 13 + i, 12 + i // 2, (242, 200, 17)) for i in range(0, 120)])
        self.assertIsNotNone(tape_component(diagonal, w, h), 'a diagonal blade still counts')

    def test_laplacian_variance_ranks_detail_above_flat(self):
        flat = bytes([100] * 64 * 64)
        checker = bytes([255 if (x // 2 + y // 2) % 2 else 0 for y in range(64) for x in range(64)])
        self.assertEqual(sharpness(flat, 64, 64), 0)
        self.assertGreater(sharpness(checker, 64, 64), 1000)


class WithoutFfmpeg(unittest.TestCase):
    def test_missing_ffmpeg_is_reported_not_hidden(self):
        with tempfile.TemporaryDirectory() as temp:
            service = VideoFrameService(temp, ffmpeg='', ffprobe='')
            caps = service.capabilities()
            self.assertFalse(caps['ffmpeg']); self.assertIn('ffmpeg', caps['detail'])
            with self.assertRaises(VideoError) as caught: service.open(None, io.BytesIO(b'x'), 1)
            self.assertEqual(caught.exception.status, 422); self.assertIn('ffmpeg', str(caught.exception))
            self.assertEqual(list(Path(temp).iterdir()), [], 'nothing is cached without a decoder')
            with patch.dict(os.environ, {'TIKSI_FFMPEG': '', 'TIKSI_FFPROBE': ''}):
                self.assertFalse(VideoFrameService(temp).capabilities()['ffmpeg'], 'an empty override turns frames off')

    def test_homebrew_tools_found_without_path(self):
        # The live service starts from a login item whose PATH has no Homebrew folder.
        with tempfile.TemporaryDirectory() as temp:
            bin_dir = Path(temp) / 'bin'; bin_dir.mkdir()
            tool = bin_dir / 'ffmpeg'; tool.write_text('#!/bin/sh\n'); tool.chmod(0o755)
            plain = bin_dir / 'ffprobe'; plain.write_text('not executable')
            with patch.dict(os.environ, {'PATH': '/usr/bin:/bin'}), patch('shutil.which', return_value=None):
                self.assertEqual(find_tool('ffmpeg', (str(bin_dir),)), str(tool))
                self.assertIsNone(find_tool('ffprobe', (str(bin_dir),)), 'a file that cannot run is not a tool')
                self.assertIsNone(find_tool('ffmpeg', (str(Path(temp) / 'missing'),)))


@unittest.skipUnless(FFMPEG and FFPROBE, 'ffmpeg/ffprobe are not installed; the no-ffmpeg path is tested above')
class WithFfmpeg(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.media = tempfile.TemporaryDirectory(); folder = Path(cls.media.name)
        # Seconds 0-1: an elongated orange (wood) strip; 2-4: a yellow blade with black ticks;
        # 6-7: a yellow square. Only the blade should be a candidate.
        ticks = ','.join(f"drawbox=x={70 + 20 * i}:y=80:w=2:h=4:color=black:t=fill:enable='between(t,2,4.5)'" for i in range(9))
        cls.tape = make(folder / 'tape.mp4', 'color=c=0x808080:s=320x180:r=10:d=8',
                        f"drawbox=x=60:y=40:w=200:h=8:color={ORANGE}:t=fill:enable='between(t,0,1.5)',"
                        f"drawbox=x=60:y=80:w=200:h=8:color={YELLOW}:t=fill:enable='between(t,2,4.5)',{ticks},"
                        f"drawbox=x=140:y=60:w=40:h=40:color={YELLOW}:t=fill:enable='between(t,6,7.5)'")
        # Detail everywhere, blurred except 2.4-2.6 s: the sharpest burst frame lies there.
        cls.blur = make(folder / 'blur.mp4', 'testsrc2=s=320x180:r=10:d=4', "boxblur=6:enable='not(between(t,2.4,2.6))'")
        # A crisp frame without the blade (1.6 s) and softer frames with it (2-3 s).
        cls.choice = make(folder / 'choice.mp4', 'color=c=0x808080:s=320x180:r=10:d=4',
                          f"drawgrid=w=16:h=16:t=2:c=white,drawbox=x=60:y=80:w=200:h=8:color={YELLOW}:t=fill:enable='between(t,2,3)',"
                          "boxblur=1:enable='between(t,2,3)',boxblur=8:enable='not(between(t,1.6,1.69))*not(between(t,2,3))'")
        cls.rotated = folder / 'rotated.mp4'
        plain = make(folder / 'plain.mp4', 'color=c=0x808080:s=320x180:r=10:d=2')
        subprocess.run([FFMPEG, '-v', 'error', '-y', '-display_rotation', '90', '-i', str(plain), '-c', 'copy', str(cls.rotated)], check=True)
        cls.audio = folder / 'tone.m4a'
        subprocess.run([FFMPEG, '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=d=1', '-c:a', 'aac', str(cls.audio)], check=True)

    @classmethod
    def tearDownClass(cls): cls.media.cleanup()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.root = Path(self.temp.name) / 'cache'
        self.service = VideoFrameService(self.root)

    def tearDown(self): self.service.close(); self.temp.cleanup()

    def upload(self, path, digest=None):
        data = Path(path).read_bytes()
        return self.service.open(digest, io.BytesIO(data), len(data))

    def leftovers(self): return [p.name for p in self.root.rglob('*') if p.name.startswith(('incoming-', 'burst-'))]

    def test_tape_candidates_contact_sheet_and_dedupe(self):
        job = self.upload(self.tape)
        self.assertEqual(job['id'], hashlib.sha256(self.tape.read_bytes()).hexdigest())
        self.assertEqual((job['probe']['width'], job['probe']['height'], job['seconds']), (320, 180, 8))
        job = wait(self.service, job['id'])
        self.assertEqual(job['state'], 'ready', job['error'])
        self.assertEqual([c['t'] for c in job['candidates']], [2, 3, 4], 'the blade seconds, not the wood strip or the square')
        self.assertEqual(job['sheets'], 1); self.assertEqual(job['tile'], [192, 108])
        sheet = (self.root / job['id'] / 'sheets' / 'sheet_001.jpg').read_bytes()
        self.assertEqual(jpeg_size(sheet), (192 * 10, 108 * 10))
        again = self.service.open(job['id'])
        self.assertEqual(again['state'], 'ready', 'a known hash needs no second upload')
        self.assertEqual(len([p for p in self.root.iterdir() if p.is_dir()]), 1)
        self.assertEqual(self.leftovers(), [])
        self.assertEqual(self.service.open(hashlib.sha256(b'other').hexdigest()), {'id': hashlib.sha256(b'other').hexdigest(), 'upload': True}, 'an unknown hash asks for the upload')

    def test_workspace_blob_is_read_in_place(self):
        blobs = Path(self.temp.name) / 'blobs'; blobs.mkdir()
        digest = hashlib.sha256(self.tape.read_bytes()).hexdigest(); shutil.copy(self.tape, blobs / digest)
        job = wait(self.service, self.service.open(digest, blobs=blobs)['id'])
        self.assertEqual(job['state'], 'ready'); self.assertFalse((self.root / digest / 'source.video').exists())
        self.assertEqual((self.root / digest / 'source.ref').read_text(), str(blobs / digest))
        with self.assertRaises(VideoError) as caught: self.upload(self.blur, digest='0' * 64)
        self.assertIn('do not match', str(caught.exception)); self.assertEqual(self.leftovers(), [])

    def test_burst_returns_sharpest_full_resolution_frame(self):
        job = self.upload(self.blur)
        data, info = self.service.frame(job['id'], 2.2, burst=True)
        self.assertGreaterEqual(info['seconds'], 2.4); self.assertLessEqual(info['seconds'], 2.6)
        self.assertEqual(jpeg_size(data), (320, 180))
        best = max(score for _, score in info['sharpness'])
        self.assertTrue(all(score < best / 2 for t, score in info['sharpness'] if not 2.4 <= t <= 2.6), info['sharpness'])
        data, info = self.service.frame(job['id'], 1.0, burst=True, region=[0.25, 0.25, 0.5, 0.5])
        self.assertEqual(jpeg_size(data), (320, 180), 'the region steers sharpness; the frame stays whole')
        data, info = self.service.frame(job['id'], 99)
        self.assertEqual(info['seconds'], 3.9, 'a time past the end is clamped to the last frame')
        for region in ([0, 0, 2, 1], [0.9, 0, 0.5, 1], 'all', [0, 0, 0.001, 0.5]):
            with self.assertRaises(VideoError): self.service.frame(job['id'], 1, burst=True, region=region)
        with self.assertRaises(VideoError): self.service.frame(job['id'], float('nan'))
        self.assertEqual(self.leftovers(), [], 'burst folders are removed')

    def test_burst_prefers_frames_that_show_the_blade(self):
        job = self.upload(self.choice)
        _, info = self.service.frame(job['id'], 2.0, burst=True)
        self.assertGreaterEqual(info['seconds'], 2.0, info)
        sharpest = max(info['sharpness'], key=lambda item: item[1])
        self.assertLess(sharpest[0], 1.7, 'the crispest frame of the burst has no blade')
        self.assertEqual([t >= 2.0 for t, _ in info['sharpness']], info['tape'])
        _, plain = self.service.frame(job['id'], 1.4, burst=True)
        self.assertFalse(any(plain['tape'])); self.assertLess(abs(plain['seconds'] - 1.6), 0.06, 'with no blade anywhere, sharpness alone decides')

    def test_rotation_reports_display_dimensions(self):
        job = self.upload(self.rotated)
        self.assertEqual((job['probe']['width'], job['probe']['height']), (180, 320))
        data, _ = self.service.frame(job['id'], 0.5)
        self.assertEqual(jpeg_size(data), (180, 320))

    def test_corrupt_audio_only_and_truncated_files_fail_honestly(self):
        cases = {b'not a video at all' * 100: 'not a readable MP4/MOV', self.audio.read_bytes(): 'no video track',
                 self.tape.read_bytes()[:len(self.tape.read_bytes()) // 2]: 'not a readable MP4/MOV'}
        for data, message in cases.items():
            with self.assertRaises(VideoError) as caught: self.service.open(None, io.BytesIO(data), len(data))
            self.assertEqual(caught.exception.status, 422); self.assertIn(message, str(caught.exception))
        self.assertEqual(list(self.root.iterdir()), [], 'failed probes leave no cache entries')
        with self.assertRaises(VideoError) as caught: self.service.open(None, io.BytesIO(b''), 700 * 1024 * 1024)
        self.assertEqual(caught.exception.status, 413)
        with self.assertRaises(VideoError) as caught: self.service.open(None, io.BytesIO(b'abc'), 10)
        self.assertIn('truncated', str(caught.exception)); self.assertEqual(self.leftovers(), [])

    def test_cancel_stops_a_running_analysis_and_delete_cleans_up(self):
        # A stand-in decoder that never finishes: cancel must stop it and record why.
        slow = Path(self.temp.name) / 'bin'; slow.mkdir()
        (slow / 'ffmpeg').write_text('#!/bin/sh\nexec sleep 30\n'); (slow / 'ffmpeg').chmod(0o755)
        service = VideoFrameService(self.root, ffmpeg=str(slow / 'ffmpeg'), ffprobe=FFPROBE)
        data = self.tape.read_bytes(); job = service.open(None, io.BytesIO(data), len(data))
        wait(service, job['id'], states=('queued',))
        started = time.time(); self.assertEqual(service.cancel(job['id'])['cancelled'], 1)
        job = wait(service, job['id'])
        self.assertEqual(job['state'], 'cancelled'); self.assertLess(time.time() - started, 10)
        self.assertEqual(service.active_jobs(), 0)
        resumed = VideoFrameService(self.root, ffmpeg=FFMPEG, ffprobe=FFPROBE)
        self.assertIn(resumed.open(job['id'])['state'], ('queued', 'analyzing', 'ready'), 'opening a cancelled video resumes it')
        self.assertEqual(wait(resumed, job['id'])['state'], 'ready')
        resumed.delete(job['id'])
        self.assertFalse((self.root / job['id']).exists())

    def test_interrupted_analysis_is_marked_on_restart(self):
        job = wait(self.service, self.upload(self.tape)['id'])
        job.update(state='analyzing'); self.service.save(job)
        (self.root / job['id'] / 'burst-stale').mkdir()
        restarted = VideoFrameService(self.root)
        self.assertEqual(restarted.load(job['id'])['state'], 'interrupted'); self.assertEqual(self.leftovers(), [])

    def test_http_requires_header_token_and_trusted_peer(self):
        spec = importlib.util.spec_from_file_location('tiksi_serve', ROOT / 'tools/serve.py'); serve = importlib.util.module_from_spec(spec); spec.loader.exec_module(serve)
        class Quiet(serve.AppHandler):
            def log_message(self, *args): pass
        server = serve.AppServer(('127.0.0.1', 0), Quiet)
        server.instance_file = None; server.allowed_hostname = '127.0.0.1'; server.allowed_hosts = []; server.remote_access = False
        server.workspace = None; server.video_frames = self.service
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        base = 'http://127.0.0.1:%d/api/video' % server.server_port
        def call(path, method='GET', headers=None, body=None):
            request = urllib.request.Request(base + path, data=body, method=method, headers=headers or {})
            try:
                with urllib.request.urlopen(request) as response: return response.status, response.read(), response.headers
            except urllib.error.HTTPError as error: return error.code, error.read(), error.headers
        try:
            self.assertEqual(call('/capabilities')[0], 403, 'a plain cross-site style GET is refused')
            status, body, _ = call('/capabilities', headers={'X-Tiksi-Video': '1'})
            caps = json.loads(body); self.assertEqual(status, 200); self.assertTrue(caps['ffmpeg'])
            ok = {'X-Tiksi-Video': '1', 'X-Tiksi-Token': caps['token']}
            self.assertEqual(call('/jobs', 'POST', {'X-Tiksi-Video': '1', 'X-Tiksi-Token': 'wrong'}, b'x')[0], 403)
            self.assertEqual(call('/capabilities', headers={**ok, 'Origin': 'http://evil.example'})[0], 403)
            status, body, _ = call('/jobs', 'POST', {**ok, 'X-Video-Hash': '1' * 64})
            self.assertEqual(status, 200); self.assertTrue(json.loads(body)['upload'])
            status, body, _ = call('/jobs', 'POST', ok, self.tape.read_bytes()); job = json.loads(body)
            self.assertEqual(status, 200); wait(self.service, job['id'])
            status, body, headers = call('/jobs/' + job['id'] + '/frame', 'POST', ok, json.dumps({'t': 3, 'burst': True}).encode())
            self.assertEqual(status, 200); self.assertEqual(body[:2], b'\xff\xd8'); self.assertGreaterEqual(json.loads(headers['X-Frame-Info'])['seconds'], 2.0)
            status, body, _ = call('/jobs/' + job['id'] + '/sheet/1', headers=ok); self.assertEqual((status, body[:2]), (200, b'\xff\xd8'))
            self.assertEqual(call('/jobs/' + job['id'] + '/sheet/2', headers=ok)[0], 404)
            self.assertEqual(call('/jobs/../../etc/frame', 'POST', ok, b'{}')[0], 404)
            self.assertEqual(call('/jobs/' + job['id'], 'DELETE', ok)[0], 200)
            self.assertEqual(call('/jobs/' + job['id'], headers=ok)[0], 404)
        finally:
            server.shutdown(); server.server_close()
        class Remote:
            path = '/api/video/capabilities'; command = 'GET'; client_address = ('192.168.1.9', 1); headers = {'X-Tiksi-Video': '1'}; wfile = io.BytesIO()
            def send_response(self, status): self.status = status
            def send_header(self, *args): pass
            def end_headers(self): pass
        remote = Remote(); self.service.dispatch(remote); self.assertEqual(remote.status, 403, 'LAN peers outside Tailscale are refused')


if __name__ == '__main__': unittest.main()
