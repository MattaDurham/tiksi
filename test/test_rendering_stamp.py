"""The view label a rendering carries (server/rendering_stamp.py, scripts/stamp-rendering.py) and the
folder listing that reads it. Synthetic pictures in test/fixtures/rendering-stamp and temporary folders."""
import importlib.util
import io
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from contextlib import redirect_stdout, redirect_stderr

from server import project_photos as photos
from server.rendering_stamp import StampError, label_of_bytes, read_label, stamp_bytes

ROOT = Path(__file__).resolve().parent.parent
FIX = ROOT / 'test/fixtures/rendering-stamp'
spec = importlib.util.spec_from_file_location('stamp_rendering', ROOT / 'scripts/stamp-rendering.py')
cli = importlib.util.module_from_spec(spec); spec.loader.exec_module(cli)
LABEL = {'view': 'sv-1', 'viewName': 'Living', 'room': 'Living', 'by': 'test'}
FOREIGN = ('<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
           '<rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:CreatorTool="Some engine"/></rdf:RDF></x:xmpmeta><?xpacket end="w"?>')


class Stamp(unittest.TestCase):
    def test_both_copies_read_each_others_labels(self):
        for ext in ('png', 'jpg'):
            self.assertEqual(read_label(FIX / f'js-stamped.{ext}'), {'property': 'prop-test', 'propertyName': 'Test house', 'view': 'sv-kitchen',
                                                                     'viewName': 'Kitchen, north wall', 'room': 'Kitchen', 'by': 'javascript'}, ext)
            self.assertEqual(read_label(FIX / f'py-stamped.{ext}')['viewName'], 'Living & "Dining"', ext)
            self.assertIsNone(read_label(FIX / f'plain.{ext}'), ext)

    def test_stamping_again_replaces_the_label_and_keeps_the_picture(self):
        for ext in ('png', 'jpg'):
            plain = (FIX / f'plain.{ext}').read_bytes()
            once = stamp_bytes(plain, LABEL)
            twice = stamp_bytes(once, {'viewName': 'Kitchen'})
            self.assertEqual(label_of_bytes(twice), {'viewName': 'Kitchen'})
            self.assertEqual(twice.count(b'xmlns:tiksi'), 1)
            # The picture's own data is untouched: the end of the file (image data) is the same.
            self.assertTrue(twice.endswith(plain[-40:]), ext)

    def test_other_metadata_is_kept(self):
        import struct, zlib
        png = (FIX / 'plain.png').read_bytes()
        body = b'XML:com.adobe.xmp\x00\x00\x00\x00\x00' + FOREIGN.encode()
        chunk = struct.pack('>I', len(body)) + b'iTXt' + body + struct.pack('>I', zlib.crc32(b'iTXt' + body) & 0xffffffff)
        with_foreign = png[:33] + chunk + png[33:]
        out = stamp_bytes(with_foreign, LABEL)
        self.assertIn(b'xmp:CreatorTool="Some engine"', out)
        self.assertEqual(label_of_bytes(out)['viewName'], 'Living')

    def test_other_files_and_empty_labels_are_refused(self):
        with self.assertRaises(StampError): stamp_bytes(b'GIF89a....', LABEL)
        with self.assertRaises(StampError): stamp_bytes((FIX / 'plain.png').read_bytes(), {'by': ''})
        self.assertIsNone(label_of_bytes(b'not a picture'))
        self.assertIsNone(label_of_bytes((FIX / 'plain.png').read_bytes()[:20]), 'a file cut short has no label, and no error')


class Command(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.dir = Path(self.temp.name)

    def run_cli(self, *args):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            try: code = cli.main([str(a) for a in args])
            except SystemExit as e: code = e.code
        return code, out.getvalue(), err.getvalue()

    def test_the_command_labels_in_place_and_reads_back(self):
        f = shutil.copy(FIX / 'plain.jpg', self.dir / 'Living - walnut.jpg')
        code, out, _ = self.run_cli(f, '--view-name', 'Living', '--room', 'Living', '--by', 'image model', '--rendered-at', '2026-11-16T12:00:00Z')
        self.assertEqual(code, 0)
        self.assertEqual(read_label(f), {'viewName': 'Living', 'room': 'Living', 'renderedAt': '2026-11-16T12:00:00Z', 'by': 'image model'})
        code, out, _ = self.run_cli(f, '--read')
        self.assertEqual(json.loads(out)['label']['viewName'], 'Living')

    def test_the_command_needs_a_view_or_room_and_refuses_other_files(self):
        f = shutil.copy(FIX / 'plain.png', self.dir / 'a.png')
        self.assertEqual(self.run_cli(f, '--by', 'x')[0], 2)
        self.assertIsNone(read_label(f))
        gif = self.dir / 'a.gif'; gif.write_bytes(b'GIF89a')
        code, _, err = self.run_cli(gif, '--room', 'Living')
        self.assertEqual(code, 1); self.assertIn('PNG and JPEG', err)
        self.assertEqual(self.run_cli(f, '--room', 'Living', '--nonsense')[0], 2, 'an unknown flag fails')

    def test_out_leaves_the_original(self):
        f = shutil.copy(FIX / 'plain.png', self.dir / 'a.png')
        code, _, _ = self.run_cli(f, '--room', 'Hall', '--out', self.dir / 'b.png')
        self.assertEqual(code, 0)
        self.assertIsNone(read_label(f)); self.assertEqual(read_label(self.dir / 'b.png')['room'], 'Hall')


class Listing(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'Project'

    def put(self, rel, data):
        p = self.root / rel; p.parent.mkdir(parents=True, exist_ok=True); p.write_bytes(data); return p

    def test_a_labelled_picture_is_a_rendering_with_its_label(self):
        png = (FIX / 'plain.png').read_bytes()
        self.put('Photos/out-1.png', stamp_bytes(png, LABEL))
        self.put('Photos/site.png', png)
        self.put('Renders/kitchen.jpg', (FIX / 'js-stamped.jpg').read_bytes())
        self.put('Photos/IMG_1.jpg', (FIX / 'py-stamped.jpg').read_bytes())   # a camera folder's JPEG is not opened
        self.put('Scan/cameras/1.json', b'{}'); self.put('Scan/images/1.png', stamp_bytes(png, LABEL))
        files = {f['path']: f for f in photos.list_photos(self.root)['files']}
        self.assertEqual((files['Photos/out-1.png']['group'], files['Photos/out-1.png']['stamp']['viewName']), ('rendering', 'Living'))
        self.assertEqual((files['Photos/site.png']['group'], 'stamp' in files['Photos/site.png']), ('photo', False))
        self.assertEqual(files['Renders/kitchen.jpg']['stamp']['view'], 'sv-kitchen')
        self.assertNotIn('stamp', files['Photos/IMG_1.jpg'])
        self.assertEqual((files['Scan/images/1.png']['group'], 'stamp' in files['Scan/images/1.png']), ('scan', False))

    def test_a_label_written_later_is_listed_and_one_taken_out_goes(self):
        import os, time
        p = self.put('Renders/a.png', (FIX / 'plain.png').read_bytes())
        self.assertNotIn('stamp', photos.list_photos(self.root)['files'][0])
        p.write_bytes(stamp_bytes(p.read_bytes(), LABEL)); os.utime(p, (time.time() + 5, time.time() + 5))
        self.assertEqual(photos.list_photos(self.root)['files'][0]['stamp']['room'], 'Living')


if __name__ == '__main__':
    unittest.main()
