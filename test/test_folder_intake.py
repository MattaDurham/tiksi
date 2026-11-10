"""A property from a picked folder: synthetic folders in temporary directories only."""
import http.client
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
from urllib.parse import quote

from server.folder_intake import FolderIntakeService, FolderError, choose_folder_on_mac, list_folder
from server.workspace import WorkspaceService

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('tiksi_serve_folder', ROOT / 'tools/serve.py')
serve = importlib.util.module_from_spec(spec); spec.loader.exec_module(serve)


def site_visit(root):
    """A folder the way it comes back from a site visit, plus what must never be read."""
    visit = root / 'visit'
    (visit / 'Side project').mkdir(parents=True)
    (visit / 'Tiksi').mkdir()
    (visit / '.hidden').mkdir()
    (visit / 'IMG_1.jpeg').write_bytes(b'\xff\xd8 synthetic photo')
    (visit / 'walk.MOV').write_bytes(b'\x00\x00\x00\x18ftypqt   synthetic video')
    (visit / 'Polycam link.rtf').write_text('{\\rtf1 https://poly.cam/capture/AAAAAAAA-1111-2222-3333-444444444444\\\n}', encoding='utf-8')
    (visit / 'Side project' / 'IMG_2.jpeg').write_bytes(b'\xff\xd8 second photo')
    (visit / 'Tiksi' / 'Earlier.tiksi').write_bytes(b'an earlier project file')
    (visit / '.DS_Store').write_bytes(b'finder')
    (visit / '.hidden' / 'secret.txt').write_text('hidden', encoding='utf-8')
    (root / 'outside.txt').write_text('outside the picked folder', encoding='utf-8')
    os.symlink(root / 'outside.txt', visit / 'link-out.txt')
    os.symlink(root, visit / 'link-dir')
    return visit


class Listing(unittest.TestCase):
    def test_lists_plain_files_and_counts_what_it_leaves_out(self):
        with tempfile.TemporaryDirectory() as temp:
            visit = site_visit(Path(temp).resolve())
            files, skipped, truncated = list_folder(visit)
            self.assertEqual([f['path'] for f in files], ['IMG_1.jpeg', 'Polycam link.rtf', 'Side project/IMG_2.jpeg', 'walk.MOV'])
            self.assertEqual(next(f for f in files if f['path'] == 'IMG_1.jpeg')['size'], len(b'\xff\xd8 synthetic photo'))
            self.assertEqual(skipped, {'hidden': 2, 'links': 2, 'unreadable': 0, 'tiksi': 1})
            self.assertFalse(truncated)

    def test_a_folder_with_too_many_files_is_cut_off_and_says_so(self):
        with tempfile.TemporaryDirectory() as temp:
            for i in range(5): (Path(temp) / f'{i}.jpg').write_bytes(b'x')
            files, _, truncated = list_folder(Path(temp), limit=3)
            self.assertEqual(len(files), 3); self.assertTrue(truncated)


class Picks(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.visit = site_visit(self.root)
        self.workspace = WorkspaceService(self.root / 'runtime', self.root / 'projects')
        self.chosen = str(self.visit)
        self.service = FolderIntakeService(self.workspace, chooser=lambda: self.chosen)

    def tearDown(self): self.temp.cleanup()

    def test_a_pick_reads_only_plain_visible_files_inside_the_folder(self):
        pick = self.service.choose()
        self.assertEqual((pick['name'], pick['path']), ('visit', str(self.visit)))
        self.assertEqual(self.service.file(pick['id'], 'Side project/IMG_2.jpeg').read_bytes(), b'\xff\xd8 second photo')
        for bad in ('../outside.txt', '/etc/hosts', 'link-out.txt', 'link-dir/outside.txt', '.DS_Store', '.hidden/secret.txt', 'Tiksi/Earlier.tiksi',
                    'Side project/../../outside.txt', 'Side project', '', 'missing.jpg', 'a\\b', 'IMG_1.jpeg\0'):
            with self.assertRaises(FolderError, msg=repr(bad)): self.service.file(pick['id'], bad)
        with self.assertRaises(FolderError): self.service.file('not-a-pick-identifier', 'IMG_1.jpeg')
        self.service.forget(pick['id'])
        with self.assertRaises(FolderError) as gone: self.service.file(pick['id'], 'IMG_1.jpeg')
        self.assertEqual(gone.exception.status, 404)

    def test_cancelling_the_folder_window_picks_nothing(self):
        self.chosen = None
        self.assertEqual(self.service.choose(), {'cancelled': True})
        self.assertEqual(self.service.picks, {})

    def test_the_home_folder_and_its_parents_are_refused(self):
        for whole in (str(Path.home()), str(Path.home().parent), '/'):
            self.chosen = whole
            with self.assertRaises(FolderError) as refused: self.service.choose()
            self.assertEqual(refused.exception.status, 422, whole)
        self.chosen = 'relative/folder'
        with self.assertRaises(FolderError): self.service.choose()
        self.chosen = str(self.root / 'gone')
        with self.assertRaises(FolderError) as missing: self.service.choose()
        self.assertEqual(missing.exception.status, 404)

    def test_only_the_newest_picks_are_remembered(self):
        first = self.service.choose()['id']
        for _ in range(8): last = self.service.choose()['id']
        with self.assertRaises(FolderError): self.service.pick(first)
        self.assertEqual(self.service.pick(last)['root'], self.visit)

    def test_the_first_save_writes_the_project_file_into_the_picked_folder(self):
        pick = self.service.choose()
        before = sorted(p.relative_to(self.visit).as_posix() for p in self.visit.rglob('*'))
        planned = self.service.keep_in_folder(pick['id'], 'prop-a', 'Smith / kitchen')['path']
        self.assertEqual(planned, str(self.visit / 'Tiksi' / 'Smith   kitchen.tiksi'))
        self.assertEqual(sorted(p.relative_to(self.visit).as_posix() for p in self.visit.rglob('*')), before, 'planning writes nothing')
        data = {'version': 2, 'settings': {}, 'properties': [{'id': 'prop-a', 'name': 'Smith / kitchen', 'scans': [], 'photos': []}], 'projects': [], 'materials': [], 'products': []}
        self.workspace.commit({'revision': self.workspace.snapshot()['revision'], 'data': data, 'assets': {}, 'projectData': {'prop-a': data}})
        self.assertEqual(self.workspace.paths['prop-a'], planned)
        self.assertTrue(Path(planned).is_file())
        self.assertEqual(self.workspace.planned, {})
        self.assertEqual(self.workspace.project_folder('prop-a'), self.visit)
        self.assertEqual((self.visit / 'Tiksi' / 'Earlier.tiksi').read_bytes(), b'an earlier project file', 'an earlier project file is untouched')
        self.assertEqual((self.visit / 'IMG_1.jpeg').read_bytes(), b'\xff\xd8 synthetic photo')
        # A restarted server finds the project again where it was written.
        restarted = WorkspaceService(self.root / 'runtime', self.root / 'projects')
        self.assertEqual(restarted.paths['prop-a'], planned)
        with self.assertRaises(FolderError) as twice: self.service.keep_in_folder(pick['id'], 'prop-a', 'Again')
        self.assertEqual(twice.exception.status, 409)

    def test_a_project_file_already_in_the_folder_is_never_overwritten(self):
        pick = self.service.choose()
        self.assertEqual(self.service.keep_in_folder(pick['id'], 'prop-b', 'Earlier')['path'], str(self.visit / 'Tiksi' / 'Earlier 2.tiksi'))
        self.assertEqual(self.service.keep_in_folder(pick['id'], 'prop-c', 'Earlier')['path'], str(self.visit / 'Tiksi' / 'Earlier 3.tiksi'))


class FolderWindow(unittest.TestCase):
    def run_with(self, returncode=0, stdout='', stderr='', error=None):
        def run(args, **kwargs):
            self.args = args
            if error: raise error
            return subprocess.CompletedProcess(args, returncode, stdout, stderr)
        return choose_folder_on_mac(run=run, which=lambda name: '/usr/bin/osascript')

    def test_the_picked_path_comes_back_and_a_cancel_is_nothing(self):
        self.assertEqual(self.run_with(stdout='/Users/someone/Site visit/\n'), '/Users/someone/Site visit/')
        self.assertEqual(self.args[0], '/usr/bin/osascript')
        self.assertIsNone(self.run_with(returncode=1, stderr='execution error: User canceled. (-128)'))
        self.assertIsNone(self.run_with(error=subprocess.TimeoutExpired('osascript', 600)))
        with self.assertRaises(FolderError): self.run_with(returncode=1, stderr='something else broke')


class OverHttp(unittest.TestCase):
    """The real server: who may ask, the token, and file bytes exactly as they are on disk."""
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.visit = site_visit(self.root)
        self.server = serve.AppServer(('127.0.0.1', 0), serve.AppHandler)
        self.server.instance_file = None; self.server.allowed_hostname = '127.0.0.1'; self.server.allowed_hosts = []; self.server.remote_access = False
        self.server.workspace = WorkspaceService(self.root / 'runtime', self.root / 'projects')
        self.server.folder_intake = FolderIntakeService(self.server.workspace, chooser=lambda: str(self.visit))
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.temp.cleanup()

    def ask(self, method, path, headers=None, body=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=10)
        connection.request(method, '/api/folder-intake' + path, body=body, headers={'X-Tiksi-Folder': '1', **(headers or {})})
        response = connection.getresponse(); data = response.read(); connection.close()
        return response.status, data

    def test_choose_list_read_and_refusals(self):
        self.assertEqual(self.ask('GET', '/capabilities', {'X-Tiksi-Folder': '0'})[0], 403)
        status, data = self.ask('GET', '/capabilities'); cap = json.loads(data)
        self.assertEqual((status, cap['choose']), (200, True))
        self.assertEqual(self.ask('POST', '/choose')[0], 403, 'no token')
        self.assertEqual(self.ask('POST', '/choose', {'X-Tiksi-Token': cap['token'], 'Origin': 'http://elsewhere.example'})[0], 403)
        token = {'X-Tiksi-Token': cap['token']}
        status, data = self.ask('POST', '/choose', token); pick = json.loads(data)
        self.assertEqual(status, 200)
        self.assertEqual([f['path'] for f in pick['files']], ['IMG_1.jpeg', 'Polycam link.rtf', 'Side project/IMG_2.jpeg', 'walk.MOV'])
        status, data = self.ask('GET', '/picks/' + pick['id'] + '/file?path=' + quote('Side project/IMG_2.jpeg'), token)
        self.assertEqual((status, data), (200, b'\xff\xd8 second photo'))
        self.assertEqual(self.ask('GET', '/picks/' + pick['id'] + '/file?path=' + quote('../outside.txt'), token)[0], 400)
        self.assertEqual(self.ask('GET', '/picks/' + pick['id'] + '/file?path=link-out.txt', token)[0], 403)
        status, data = self.ask('POST', '/picks/' + pick['id'] + '/keep', {**token, 'Content-Type': 'application/json'}, json.dumps({'propertyId': 'prop-a', 'name': 'Visit'}))
        self.assertEqual((status, json.loads(data)['path']), (200, str(self.visit / 'Tiksi' / 'Visit.tiksi')))
        self.assertEqual(self.ask('DELETE', '/picks/' + pick['id'], token)[0], 200)
        self.assertEqual(self.ask('GET', '/picks/' + pick['id'], token)[0], 404)

    def test_the_folder_window_is_only_for_a_caller_at_the_mac(self):
        self.assertTrue(FolderIntakeService.at_this_mac('127.0.0.1')); self.assertTrue(FolderIntakeService.at_this_mac('::ffff:127.0.0.1'))
        for elsewhere in ('100.80.1.2', '192.168.1.4', '', 'localhost'): self.assertFalse(FolderIntakeService.at_this_mac(elsewhere), elsewhere)
        self.assertFalse(self.server.folder_intake.capabilities('100.80.1.2')['choose'])


if __name__ == '__main__': unittest.main()
