"""Onboarding's media and document tools (scripts/onboard-media.py, server/product_docs.py)
and the SketchUp mirror's product meshes and solids. Synthetic media in temporary folders."""
import email.message
import importlib.util
import io
import json
import math
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
import urllib.error
import zlib

from server.product_docs import check_url, fetch_document, DocumentError, MAX_BYTES
from server.sketchup_convert import library_path
from server.workspace import WorkspaceService

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('onboard_media', ROOT / 'scripts/onboard-media.py')
media = importlib.util.module_from_spec(spec); spec.loader.exec_module(media)
PUBLIC = lambda host: ['93.184.216.34']
FFMPEG = shutil.which('ffmpeg') and shutil.which('ffprobe')


class Response(io.BytesIO):
    def __init__(self, data, mime, status=200, disposition=None):
        super().__init__(data)
        self.status = status
        self.headers = email.message.Message()
        self.headers['Content-Type'] = mime
        self.headers['Content-Length'] = str(len(data))
        if disposition: self.headers['Content-Disposition'] = disposition


def redirect(url, location):
    headers = email.message.Message(); headers['Location'] = location
    return urllib.error.HTTPError(url, 302, 'Found', headers, None)


class DocumentFetchTests(unittest.TestCase):
    def test_only_public_web_addresses(self):
        for url in ['http://localhost/a.pdf', 'http://127.0.0.1/a.pdf', 'http://10.1.2.3/a.pdf', 'http://[::1]/a.pdf', 'file:///etc/passwd',
                    'ftp://example.com/a.pdf', 'https://user:pw@example.com/a.pdf', 'https://example.com:8443/a.pdf', 'http://printer.local/a.pdf']:
            with self.assertRaises(DocumentError, msg=url): check_url(url, PUBLIC)
        with self.assertRaises(DocumentError, msg='a public name that resolves to this Mac'):
            check_url('https://sneaky.example.com/a.pdf', lambda host: ['127.0.0.1'])
        self.assertEqual(check_url('https://maker.example.com/a.pdf', PUBLIC), 'https://maker.example.com/a.pdf')

    def test_redirects_are_checked_again_and_pdf_bytes_decide_the_type(self):
        pdf = b'%PDF-1.7\n' + b'x' * 100
        def opener(url):
            if url == 'https://maker.example.com/spec': raise redirect(url, '/files/FFBD-spec.pdf')
            if url == 'https://maker.example.com/files/FFBD-spec.pdf': return Response(pdf, 'application/octet-stream')
            if url == 'https://maker.example.com/sneaky': raise redirect(url, 'http://192.168.1.1/admin')
            raise AssertionError('unexpected ' + url)
        data, info = fetch_document('https://maker.example.com/spec', opener, PUBLIC)
        self.assertEqual(data, pdf)
        self.assertEqual((info['mime'], info['filename'], info['url']), ('application/pdf', 'FFBD-spec.pdf', 'https://maker.example.com/files/FFBD-spec.pdf'))
        with self.assertRaises(DocumentError): fetch_document('https://maker.example.com/sneaky', opener, PUBLIC)

    def test_web_pages_lies_and_oversize_files_are_refused(self):
        with self.assertRaisesRegex(DocumentError, 'Only PDF and image'):
            fetch_document('https://maker.example.com/p', lambda u: Response(b'<html></html>', 'text/html'), PUBLIC)
        with self.assertRaisesRegex(DocumentError, 'not the application/pdf'):
            fetch_document('https://maker.example.com/p.pdf', lambda u: Response(b'<html>', 'application/pdf'), PUBLIC)
        big = Response(b'%PDF', 'application/pdf'); big.headers.replace_header('Content-Length', str(MAX_BYTES + 1))
        with self.assertRaisesRegex(DocumentError, 'larger than 60 MB'):
            fetch_document('https://maker.example.com/big.pdf', lambda u: big, PUBLIC)

    def test_fetch_docs_saves_into_the_project_folder_with_a_source_note(self):
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp) / 'Example House' / 'Tiksi' / 'Example House.tiksi'
            project.parent.mkdir(parents=True); project.write_bytes(b'zip')
            pdf = b'%PDF-1.4 spec'
            opener = lambda url: Response(pdf, 'application/pdf', disposition='attachment; filename="DW24 Spec Sheet.pdf"')
            result = media.fetch_docs(project, 'Acme', 'DW/24', ['https://maker.example.com/a', 'http://10.0.0.1/b.pdf'], ['spec-sheet'], opener=opener, resolver=PUBLIC)
            self.assertEqual(Path(result['root']).name, 'Example House', 'documents go beside the Tiksi folder, in the project folder')
            doc = result['documents'][0]
            self.assertEqual(doc['path'], 'Product documents/Acme DW-24/DW24 Spec Sheet.pdf')
            self.assertEqual((Path(result['root']) / doc['path']).read_bytes(), pdf)
            note = (Path(result['root']) / 'Product documents/Acme DW-24/DW24 Spec Sheet.SOURCE.txt').read_text()
            self.assertIn('Source: https://maker.example.com/a', note); self.assertIn('SHA-256: ' + doc['sha256'], note)
            self.assertEqual(doc['kind'], 'spec-sheet')
            self.assertEqual(len(result['failed']), 1)

    def test_workspace_keeps_product_models_and_documents(self):
        data = {'properties': [{'scans': [], 'photos': [], 'fixtures': [{'product': {'asset': {'fileId': 'product-1', 'sourceFileId': 'source-1'}}}, {'product': None}]}],
                'products': [{'documents': [{'fileId': 'doc-1'}, {'path': 'Product documents/x.pdf'}]}]}
        self.assertEqual(WorkspaceService.referenced(data), {'product-1', 'source-1', 'doc-1'})


def png16(path, w, h, values):
    rows = b''.join(b'\x00' + struct.pack('>%dH' % w, *values[y * w:(y + 1) * w]) for y in range(h))
    chunk = lambda kind, body: struct.pack('>I', len(body)) + kind + body + struct.pack('>I', zlib.crc32(kind + body) & 0xffffffff)
    path.write_bytes(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 16, 0, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b''))


def keyframes(root, depth_mm=3000, shuffle=False):
    """Cameras along x looking at a wall 3 m away (ARKit: looking down -Z), with depth maps."""
    for name in ('cameras', 'depth', 'images'): (root / name).mkdir(parents=True, exist_ok=True)
    for k in range(12):
        kid = str(380000000000 + k * 1000)
        cam = {'fx': 700.0, 'fy': 700.0, 'cx': 512.0, 'cy': 384.0, 'width': 1024, 'height': 768, 'center_depth': depth_mm / 1000, 'tracking_segment': 0}
        for r in range(3):
            for c in range(3): cam['t_%d%d' % (r, c)] = 1.0 if r == c else 0.0
        cam.update(t_03=0.1 * k, t_13=0.0, t_23=0.0)
        (root / 'cameras' / (kid + '.json')).write_text(json.dumps(cam))
        values = [((k * 7919 + i * 104729) % 4000 + 500) if shuffle else depth_mm for i in range(32 * 24)]
        png16(root / 'depth' / (kid + '.png'), 32, 24, values)
    return root


class KeyframeTests(unittest.TestCase):
    def test_depth_png_round_trip(self):
        with tempfile.TemporaryDirectory() as tmp:
            png16(Path(tmp) / 'd.png', 3, 2, [0, 1, 65535, 300, 4000, 12])
            self.assertEqual(media.png16(Path(tmp) / 'd.png'), (3, 2, (0, 1, 65535, 300, 4000, 12)))

    def test_consistent_poses_pass_the_check_and_scrambled_depth_fails_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            good = media.keyframe_check(keyframes(Path(tmp) / 'good'))
            self.assertTrue(good['consistent']); self.assertGreater(good['agree'], 0.95)
            bad = media.keyframe_check(keyframes(Path(tmp) / 'bad', shuffle=True))
            self.assertFalse(bad['consistent'])

    def test_one_sighting_finds_the_same_spot_in_other_keyframes(self):
        with tempfile.TemporaryDirectory() as tmp:
            kf = media.Keyframes(keyframes(Path(tmp) / 'kf'))
            point = kf.unproject(kf.ids[0], 600, 300, 3.0)
            self.assertEqual([round(v, 4) for v in point], [round(88 / 700 * 3, 4), round(84 / 700 * 3, 4), -3.0])
            u, v, z = kf.project(kf.ids[5], point)
            self.assertAlmostEqual(u, 600 - 0.5 * 700 / 3, places=6); self.assertAlmostEqual(v, 300, places=6); self.assertAlmostEqual(z, 3.0)
            self.assertIsNone(kf.project(kf.ids[0], [0, 0, 3.0]), 'behind the camera')

    @unittest.skipUnless(FFMPEG, 'ffmpeg not installed')
    def test_angles_write_crops_for_the_best_views(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = keyframes(Path(tmp) / 'kf')
            for p in (root / 'cameras').glob('*.json'):
                media.ffmpeg('-f', 'lavfi', '-i', 'testsrc=size=1024x768:rate=1', '-frames:v', '1', root / 'images' / (p.stem + '.jpg'))
            result = media.keyframe_angles(root, '0:512,384', Path(tmp) / 'out', top=4)
            self.assertEqual(result['seenIn'], 12)
            angles = json.loads((Path(tmp) / 'out' / 'angles.json').read_text())
            self.assertEqual(angles['seen'][0]['index'], 0, 'the sighting itself is the most centred view')
            self.assertEqual(len(list((Path(tmp) / 'out').glob('kf*.jpg'))), 4)


@unittest.skipUnless(FFMPEG, 'ffmpeg not installed')
class VideoAndPhotoTests(unittest.TestCase):
    def test_sharpest_frame_of_each_window_is_kept_at_full_resolution(self):
        with tempfile.TemporaryDirectory() as tmp:
            video = Path(tmp) / 'walk.mp4'
            # Four seconds of a detailed pattern, blurred except between 1.4 and 1.6 s and after 3 s.
            media.ffmpeg('-f', 'lavfi', '-i', 'testsrc2=size=640x480:rate=20:duration=4', '-vf',
                         "gblur=sigma=8:enable='not(between(t,1.4,1.6)+gte(t,3))'", '-pix_fmt', 'yuv420p', video)
            result = media.video_sharp(video, Path(tmp) / 'frames', every=2.0, fps=10)
            frames = json.loads((Path(tmp) / 'frames' / 'frames.json').read_text())
            self.assertEqual(len(frames), 2)
            self.assertTrue(1.35 <= frames[0]['at'] <= 1.65, frames[0])
            self.assertGreaterEqual(frames[1]['at'], 2.95)
            self.assertEqual(media.probe_size(Path(tmp) / 'frames' / frames[0]['frame'])[:2], (640, 480))
            self.assertEqual(result['width'], 640)

    def test_photos_become_overlapping_full_resolution_tiles(self):
        with tempfile.TemporaryDirectory() as tmp:
            photos = Path(tmp) / 'photos'; photos.mkdir()
            media.ffmpeg('-f', 'lavfi', '-i', 'testsrc=size=1200x900:rate=1', '-frames:v', '1', photos / 'IMG_0001.jpg')
            (photos / 'notes.txt').write_text('not a photo')
            result = media.photo_tiles([photos], Path(tmp) / 'tiles')
            self.assertEqual((result['photos'], result['tiles']), (1, 9))
            tiles = json.loads((Path(tmp) / 'tiles' / 'tiles.json').read_text())
            w, h, _ = media.probe_size(Path(tmp) / 'tiles' / tiles[0]['tile'])
            self.assertEqual((w, h), (480, 360), 'a third of the width and height plus the overlap, at camera pixels')
            self.assertEqual(tiles[-1]['crop'][0] + tiles[-1]['crop'][2], 1.0)


@unittest.skipUnless(library_path(), 'SketchUp SDK not installed')
class MirrorProductTests(unittest.TestCase):
    def test_product_mesh_and_solid_parts_write_and_read_back_the_box(self):
        with tempfile.TemporaryDirectory() as tmp:
            job = Path(tmp) / 'job'; (job / 'product').mkdir(parents=True)
            # A 0.6 x 0.6 x 0.85 m box of triangles in the fixture's own frame (u, v, h).
            corners = [(u, v, h) for u in (-0.3, 0.3) for v in (-0.3, 0.3) for h in (0, 0.85)]
            quads = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
            positions = []
            for a, b, c, d in quads:
                for tri in ((a, b, c), (a, c, d)): positions += [x for i in tri for x in corners[i]]
            (job / 'product' / 'fx-dw.json').write_text(json.dumps({'format': 'tiksi-product-mesh', 'version': 1, 'meshes': [{'name': 'Door', 'color': '#c9cbcd', 'positions': positions}]}))
            n = 12
            ring = [(0.1 * math.cos(2 * math.pi * k / n), 0.5 + 0.1 * math.sin(2 * math.pi * k / n)) for k in range(n)]
            solid = [[u, -0.3, y] for u, y in ring] + [[u, -0.25, y] for u, y in ring]
            faces = [list(range(n)), list(range(2 * n - 1, n - 1, -1))] + [[k, (k + 1) % n, n + (k + 1) % n, n + k] for k in range(n)]
            spec = {'format': 'tiksi-sketchup-mirror', 'version': 1, 'property': {'id': 'prop-p', 'name': 'Products'}, 'levels': [{'id': 'l', 'name': 'L', 'elevation': 0, 'height': 2.5}],
                    'walls': [], 'rooms': [], 'underlays': [], 'fixtures': [
                        {'id': 'fx-dw', 'level': 'l', 'elevation': 0, 'name': 'Dishwasher: Acme DW-24', 'kind': 'appliance', 'subtype': 'dishwasher', 'shape': 'box', 'origin': [2, 3.7], 'angle': 0,
                         'parts': [{'pts': [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]], 'z0': 0, 'z1': 0.85, 'material': {'name': 'Stainless', 'color': '#c9cbcd'}}],
                         'base': {'kind': 'appliance', 'subtype': 'dishwasher', 'shape': 'box', 'x': 2, 'y': 3.7, 'rot': 0, 'w': 0.6, 'd': 0.6, 'y0': 0, 'h': 0.85},
                         'product': {'brand': 'Acme', 'model': 'DW-24', 'brandConfidence': 'confirmed', 'modelConfidence': 'likely', 'fileId': 'product-1'}, 'mesh': 'product/fx-dw.json'},
                        {'id': 'fx-range', 'level': 'l', 'elevation': 0, 'name': 'Range', 'kind': 'appliance', 'subtype': 'range', 'shape': 'box', 'origin': [4, 3.7], 'angle': 0,
                         'parts': [{'pts': [[-0.3, -0.25], [0.3, -0.25], [0.3, 0.3], [-0.3, 0.3]], 'z0': 0, 'z1': 0.9, 'material': {'name': 'Stainless', 'color': '#c9cbcd'}},
                                   {'solid': solid, 'faces': faces, 'material': {'name': 'Black trim', 'color': '#18191b'}}],
                         'base': {'kind': 'appliance', 'subtype': 'range', 'shape': 'box', 'x': 4, 'y': 3.7, 'rot': 0, 'w': 0.6, 'd': 0.6, 'y0': 0, 'h': 0.9}}]}
            (job / 'mirror.json').write_text(json.dumps(spec))
            worker = ROOT / 'server/sketchup_mirror.py'
            r = subprocess.run([sys.executable, str(worker), 'write', str(job)], capture_output=True, text=True, timeout=120)
            self.assertEqual(r.returncode, 0, r.stderr)
            read = Path(tmp) / 'read'; read.mkdir(); shutil.copy(job / 'model.skp', read / 'source.skp')
            r = subprocess.run([sys.executable, str(worker), 'read', str(read)], capture_output=True, text=True, timeout=120)
            self.assertEqual(r.returncode, 0, r.stderr)
            got = {f['id']: f['now'] for f in json.loads((read / 'mirror-read.json').read_text())['fixtures']}
            for fid, (x, y, h) in {'fx-dw': (2, 3.7, 0.85), 'fx-range': (4, 3.7, 0.9)}.items():
                now = got[fid]
                self.assertAlmostEqual(now['x'], x, places=4); self.assertAlmostEqual(now['y'], y, places=4)
                self.assertAlmostEqual(now['w'], 0.6, places=4); self.assertAlmostEqual(now['d'], 0.6, places=4); self.assertAlmostEqual(now['h'], h, places=4)

    @unittest.skipUnless(shutil.which('node'), 'Node not installed')
    def test_every_detailed_fixture_reads_back_unchanged_through_a_real_skp(self):
        script = """
globalThis.indexedDB = { open() { throw new Error('none'); } };
const store = await import(process.argv[1] + '/js/store.js');
const m = await import(process.argv[1] + '/js/sketchup-mirror.js');
const fx = await import(process.argv[1] + '/js/fixtures.js');
const fs = await import('node:fs');
const p = store.propertyTemplate('Every fixture'); p.id = 'prop-every'; const L = p.levels[0].id;
let k = 0;
for (const [kind, def] of Object.entries(fx.FIXTURE_KINDS)) for (const sub of def.subtypes) {
  p.fixtures.push(Object.assign(fx.fixtureTemplate(kind, sub, { level: L, x: (k % 6) * 2.5, y: Math.floor(k / 6) * 2.5, rot: (k * 37) % 360 }), { id: 'fx-' + sub }));
  k++;
}
p.fixtures = fx.normaliseFixtures(p.fixtures, p);
const [op, a] = process.argv.slice(2);
if (op === 'spec') fs.writeFileSync(a, JSON.stringify(m.mirrorSpec(p, [])));
else { const r = m.mergeMirror(p, JSON.parse(fs.readFileSync(a, 'utf8')), m.syncedState(p)); console.log(JSON.stringify({ applied: r.applied, added: r.added, deleted: r.deleted, n: p.fixtures.length })); }
"""
        def node(*args):
            r = subprocess.run(['node', '--input-type=module', '-e', script, str(ROOT), *args], capture_output=True, text=True, timeout=60)
            self.assertEqual(r.returncode, 0, r.stderr)
            return json.loads(r.stdout.strip().splitlines()[-1]) if r.stdout.strip() else None
        with tempfile.TemporaryDirectory() as tmp:
            job = Path(tmp) / 'job'; job.mkdir()
            node('spec', str(job / 'mirror.json'))
            worker = ROOT / 'server/sketchup_mirror.py'
            r = subprocess.run([sys.executable, str(worker), 'write', str(job)], capture_output=True, text=True, timeout=300)
            self.assertEqual(r.returncode, 0, r.stderr)
            read = Path(tmp) / 'read'; read.mkdir(); shutil.copy(job / 'model.skp', read / 'source.skp')
            r = subprocess.run([sys.executable, str(worker), 'read', str(read)], capture_output=True, text=True, timeout=300)
            self.assertEqual(r.returncode, 0, r.stderr)
            got = node('merge', str(read / 'mirror-read.json'))
            self.assertEqual((got['applied'], got['added'], got['deleted']), ([], [], []), 'a detailed fixture must read back as the box it was written from')
            self.assertGreater(got['n'], 25)


if __name__ == '__main__':
    unittest.main()
