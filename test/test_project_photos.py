"""Photos read from a project's own folder: synthetic folders in temporary directories only."""
import hashlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock

from server import project_photos as photos
from server.workspace import WorkspaceService, WorkspaceError


def workspace():
    return {'version': 2, 'settings': {}, 'properties': [{'id': 'prop-a', 'name': 'A', 'scans': [], 'photos': []}], 'projects': [], 'materials': [], 'products': []}


def write(path, data=b'synthetic picture'):
    path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(data); return path


class ListingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'Project'

    def test_every_subfolder_is_listed_in_its_group_and_tiksi_and_hidden_files_are_not(self):
        write(self.root / 'IMG_0001.HEIC')
        write(self.root / 'Site visit' / 'Kitchen' / 'wall.jpg')
        write(self.root / 'Source media' / 'keyframes' / 'cameras' / '1.json', b'{}')
        write(self.root / 'Source media' / 'keyframes' / 'images' / '1.jpg')
        write(self.root / 'Source media' / 'keyframes' / 'depth' / '1.png')
        write(self.root / 'Source media' / 'keyframes' / 'confidence' / '1.png')
        write(self.root / 'build' / 'finishes-v1' / 'kitchen.png')
        write(self.root / 'Wine cellar' / 'renders' / 'cellar.jpg')
        write(self.root / 'Wine cellar' / 'build' / 'draft-8.png')
        write(self.root / 'Review' / 'sketchup-build' / 'view.png')
        write(self.root / 'Rebuilding notes' / 'beam.jpg')
        write(self.root / 'Tiksi' / 'thumb.jpg')
        write(self.root / '.hidden' / 'a.jpg')
        write(self.root / '.DS_Store.jpg')
        write(self.root / 'notes.pdf')
        # An images folder with no cameras beside it is an ordinary folder of photos.
        write(self.root / 'Reference' / 'images' / 'tile.png')
        # Frames Tiksi took from a scan are filed in Photos/Scan frames.
        write(self.root / 'Photos' / 'Scan frames' / 'Scan frame 3.jpg')
        (self.root / 'link.jpg').symlink_to(self.root / 'IMG_0001.HEIC')
        listed = {f['path']: f for f in photos.list_photos(self.root)['files']}
        self.assertEqual({p: f['group'] for p, f in listed.items()}, {
            'IMG_0001.HEIC': 'photo', 'Site visit/Kitchen/wall.jpg': 'photo', 'Reference/images/tile.png': 'photo',
            'Source media/keyframes/images/1.jpg': 'scan', 'Photos/Scan frames/Scan frame 3.jpg': 'scan',
            'build/finishes-v1/kitchen.png': 'rendering', 'Wine cellar/renders/cellar.jpg': 'rendering',
            'Wine cellar/build/draft-8.png': 'rendering', 'Review/sketchup-build/view.png': 'rendering', 'Rebuilding notes/beam.jpg': 'photo'})
        wall = listed['Site visit/Kitchen/wall.jpg']
        self.assertEqual((wall['name'], wall['mime'], wall['size']), ('wall.jpg', 'image/jpeg', len(b'synthetic picture')))
        self.assertEqual(wall['key'], photos.key_of('Site visit/Kitchen/wall.jpg'))
        self.assertRegex(wall['key'], r'^pf-[0-9a-f]{20}$')
        self.assertEqual(listed['IMG_0001.HEIC']['mime'], 'image/heic')

    def test_a_folder_too_large_says_it_was_cut_short(self):
        for n in range(5): write(self.root / f'{n}.jpg')
        listed = photos.list_photos(self.root, limit=3)
        self.assertEqual((len(listed['files']), listed['truncated']), (3, True))

    def test_only_pictures_inside_the_folder_are_read(self):
        write(self.root / 'Photos' / 'a.jpg')
        write(self.root / 'Tiksi' / 'b.jpg')
        write(self.root / 'doc.pdf')
        write(self.root.parent / 'outside.jpg')
        (self.root / 'Photos' / 'link.jpg').symlink_to(self.root.parent / 'outside.jpg')
        self.assertEqual(photos.resolve(self.root, 'Photos/a.jpg'), self.root.resolve() / 'Photos' / 'a.jpg')
        for bad, status in (('../outside.jpg', 400), ('/etc/hosts.jpg', 400), ('Tiksi/b.jpg', 400), ('.x/a.jpg', 400),
                            ('doc.pdf', 415), ('Photos/link.jpg', 403), ('Photos/missing.jpg', 404), ('', 400)):
            with self.assertRaises(WorkspaceError, msg=bad) as caught: photos.resolve(self.root, bad)
            self.assertEqual(caught.exception.status, status, bad)


class PlaceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'Project'; self.root.mkdir()
        photos.SIZES.clear()

    def received(self, data):
        return photos.receive_into(self.root, io.BytesIO(data).read, len(data))

    def test_a_new_photo_goes_into_photos_and_never_over_another_file(self):
        write(self.root / 'Photos' / 'kitchen.jpg', b'an earlier, different photo')
        temp, digest = self.received(b'a new kitchen photo')
        self.assertEqual(digest, hashlib.sha256(b'a new kitchen photo').hexdigest())
        self.assertTrue(temp.name.startswith('.'), 'the spare file is hidden from the listing')
        relative, written = photos.place(self.root, 'Photos', 'kitchen.jpg', temp, digest)
        self.assertEqual((relative, written), ('Photos/kitchen (2).jpg', True))
        self.assertEqual((self.root / relative).read_bytes(), b'a new kitchen photo')
        self.assertEqual((self.root / 'Photos' / 'kitchen.jpg').read_bytes(), b'an earlier, different photo')
        self.assertFalse(temp.exists())

    def test_a_photo_already_in_the_folder_is_not_written_twice(self):
        write(self.root / 'Reference Docs' / 'IMG_7216.jpeg', b'the same bytes')
        temp, digest = self.received(b'the same bytes')
        self.assertEqual(photos.place(self.root, 'Photos', 'IMG_7216.jpeg', temp, digest), ('Reference Docs/IMG_7216.jpeg', False))
        self.assertFalse((self.root / 'Photos').exists())
        self.assertFalse(temp.exists())
        # Two photos added one after the other with the same bytes become one file.
        temp, digest = self.received(b'brand new')
        first = photos.place(self.root, 'Photos', 'a.jpg', temp, digest)
        temp, digest = self.received(b'brand new')
        self.assertEqual(photos.place(self.root, 'Photos', 'b.jpg', temp, digest), (first[0], False))

    def test_photos_are_added_only_to_the_photos_folders(self):
        temp, digest = self.received(b'x')
        with self.assertRaises(WorkspaceError): photos.place(self.root, '../elsewhere', 'a.jpg', temp, digest)
        temp.unlink()
        self.assertEqual(photos.place(self.root, 'Photos/Renderings', 'r.jpg', *self.received(b'render')), ('Photos/Renderings/r.jpg', True))

    def test_names_are_cleaned_and_given_a_picture_extension(self):
        self.assertEqual(photos.clean_name('../../.evil/x.jpg'), 'x.jpg')
        self.assertEqual(photos.clean_name('.hidden.png'), 'hidden.png')
        self.assertEqual(photos.clean_name('capture', 'image/heic'), 'capture.heic')
        self.assertEqual(photos.clean_name('', ''), 'Photo.jpg')
        self.assertEqual(photos.clean_name('a:b.JPG'), 'a-b.JPG')


class RouteTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.service = WorkspaceService(self.root / 'runtime', self.root / 'projects')
        self.service.commit({'revision': 0, 'data': workspace(), 'assets': {}, 'projectData': {'prop-a': workspace()}})
        self.folder = self.service.project_folder('prop-a')
        self.service.run = Mock(return_value=Mock(returncode=0, stdout='pixelWidth: 4032\n  pixelHeight: 3024\n', stderr=''))
        photos.SIZES.clear()

    def call(self, path, command='GET', body=b'', headers=None):
        service = self.service
        class Handler:
            client_address = ('127.0.0.1', 1234); connection = Mock()
            rfile = io.BytesIO(body); wfile = io.BytesIO()
            def send_response(self, status): self.status = status
            def send_header(self, name, value): self.sent[name] = value
            def end_headers(self): pass
        handler = Handler(); handler.path = path; handler.command = command; handler.sent = {}
        handler.headers = {'Host': 'localhost:8888', 'Content-Length': str(len(body)), 'X-Tiksi-Workspace': '1', 'X-Tiksi-Token': service.token, **(headers or {})}
        service.dispatch(handler)
        return handler

    def test_the_folder_is_listed_and_a_photo_is_sent_with_a_tag_the_browser_asks_again_with(self):
        write(self.folder / 'Site' / 'a.jpg', b'photo bytes')
        listed = json.loads(self.call('/api/workspace/photos/prop-a').wfile.getvalue())
        self.assertEqual(listed['folder'], self.folder.name)
        self.assertEqual([f['path'] for f in listed['files']], ['Site/a.jpg'])
        sent = self.call('/api/workspace/photos/prop-a/file?path=Site%2Fa.jpg')
        self.assertEqual((sent.status, sent.wfile.getvalue(), sent.sent['Content-Type']), (200, b'photo bytes', 'image/jpeg'))
        again = self.call('/api/workspace/photos/prop-a/file?path=Site%2Fa.jpg', headers={'If-None-Match': sent.sent['ETag']})
        self.assertEqual((again.status, again.wfile.getvalue()), (304, b''))
        os.utime(self.folder / 'Site' / 'a.jpg', ns=(1, 1))
        self.assertEqual(self.call('/api/workspace/photos/prop-a/file?path=Site%2Fa.jpg', headers={'If-None-Match': sent.sent['ETag']}).status, 200, 'an edited file is sent again')
        part = self.call('/api/workspace/photos/prop-a/file?path=Site%2Fa.jpg', headers={'Range': 'bytes=0-4'})
        self.assertEqual((part.status, part.wfile.getvalue()), (206, b'photo'))

    def test_a_property_with_no_folder_and_a_path_outside_are_refused(self):
        self.assertEqual(self.call('/api/workspace/photos/prop-missing').status, 404)
        self.assertEqual(self.call('/api/workspace/photos/prop-a/file?path=..%2F..%2Fsecret.jpg').status, 400)
        self.assertEqual(self.call('/api/workspace/photos/prop-a/file?path=Tiksi%2Fx.jpg').status, 400)
        no_token = self.call('/api/workspace/photos/prop-a', headers={'X-Tiksi-Token': 'wrong'})
        self.assertEqual(no_token.status, 403)

    def test_a_preview_is_made_once_with_the_macs_image_tool(self):
        write(self.folder / 'big.heic', b'heic bytes')
        def sips(command, **kwargs):
            if '--out' in command: Path(command[command.index('--out') + 1]).write_bytes(b'small jpeg')
            return Mock(returncode=0, stdout='pixelWidth: 4032\n  pixelHeight: 3024\n', stderr='')
        self.service.run = Mock(side_effect=sips)
        with unittest.mock.patch('shutil.which', return_value='/usr/bin/sips'):
            first = self.call('/api/workspace/photos/prop-a/preview?path=big.heic&size=256')
            self.assertEqual((first.status, first.wfile.getvalue(), first.sent['Content-Type']), (200, b'small jpeg', 'image/jpeg'))
            calls = self.service.run.call_count
            self.assertEqual(self.call('/api/workspace/photos/prop-a/preview?path=big.heic&size=256').wfile.getvalue(), b'small jpeg')
            self.assertEqual(self.service.run.call_count, calls, 'the copy is kept')
            self.assertEqual(self.call('/api/workspace/photos/prop-a/preview?path=big.heic&size=300').status, 400)

    def test_a_photo_sent_from_the_page_is_written_into_photos(self):
        sent = self.call('/api/workspace/photos/prop-a/add?name=IMG_1.jpg', 'POST', b'phone photo', {'Content-Type': 'image/jpeg'})
        reply = json.loads(sent.wfile.getvalue())
        self.assertEqual(sent.status, 200, reply)
        self.assertEqual((reply['path'], reply['written'], reply['w'], reply['h']), ('Photos/IMG_1.jpg', True, 4032, 3024))
        self.assertEqual(reply['sha256'], hashlib.sha256(b'phone photo').hexdigest())
        self.assertEqual((self.folder / 'Photos' / 'IMG_1.jpg').read_bytes(), b'phone photo')
        self.assertEqual([p.name for p in self.folder.iterdir() if p.name.startswith('.tiksi-photo-')], [], 'no spare file is left')
        refused = self.call('/api/workspace/photos/prop-a/add?name=x.jpg&folder=..', 'POST', b'x')
        self.assertEqual(refused.status, 400)
        self.assertEqual([p.name for p in self.folder.iterdir() if p.name.startswith('.tiksi-photo-')], [], 'a refused photo leaves nothing')

    def test_a_stored_original_is_copied_into_photos_only_when_its_bytes_match_its_name(self):
        digest, _ = self.service.store_blob(io.BytesIO(b'held photo'))
        body = json.dumps({'hash': digest, 'name': 'porch.jpg', 'folder': 'Photos'}).encode()
        reply = json.loads(self.call('/api/workspace/photos/prop-a/keep', 'POST', body).wfile.getvalue())
        self.assertEqual((reply['path'], reply['sha256']), ('Photos/porch.jpg', digest))
        self.assertEqual((self.folder / 'Photos' / 'porch.jpg').read_bytes(), b'held photo')
        (self.service.root / 'blobs' / digest).write_bytes(b'damaged')
        body = json.dumps({'hash': digest, 'name': 'porch2.jpg'}).encode()
        self.assertEqual(self.call('/api/workspace/photos/prop-a/keep', 'POST', body).status, 409)
        self.assertFalse((self.folder / 'Photos' / 'porch2.jpg').exists())
        missing = json.dumps({'hash': 'f' * 64, 'name': 'x.jpg'}).encode()
        self.assertEqual(self.call('/api/workspace/photos/prop-a/keep', 'POST', missing).status, 404)

    def test_hashes_find_a_moved_photo(self):
        write(self.folder / 'Moved' / 'a.jpg', b'moved bytes')
        body = json.dumps({'paths': ['Moved/a.jpg', 'missing.jpg', '../x.jpg']}).encode()
        reply = json.loads(self.call('/api/workspace/photos/prop-a/hashes', 'POST', body).wfile.getvalue())
        self.assertEqual(reply, {'hashes': {'Moved/a.jpg': hashlib.sha256(b'moved bytes').hexdigest()}})


if __name__ == '__main__': unittest.main()
