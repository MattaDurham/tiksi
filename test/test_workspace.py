"""Disk project sharing: synthetic bundles and temporary directories only."""
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
import zipfile
from server.workspace import WorkspaceService, WorkspaceError, MAX_JSON


def workspace(name='A'):
    return {'version': 2, 'settings': {}, 'properties': [{'id': 'prop-a', 'name': name, 'scans': [], 'photos': []}], 'projects': [], 'materials': [], 'products': []}


class WorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.service = WorkspaceService(self.root / 'runtime', self.root / 'projects')

    def tearDown(self): self.temp.cleanup()

    def commit(self, data, assets=None, revision=None, **extra):
        revision = self.service.snapshot()['revision'] if revision is None else revision
        return self.service.commit({'revision': revision, 'data': data, 'assets': assets or {}, 'projectData': {p['id']: {**data, 'properties': [p]} for p in data['properties']}, **extra})

    def test_complete_project_bundle_survives_loss_of_transport_cache(self):
        payload = b'synthetic original scan\x00\x01'
        digest, size = self.service.store_blob(io.BytesIO(payload))
        data = workspace(); data['properties'][0]['scans'] = [{'id': 'scan-a', 'name': 'Synthetic scan'}]
        self.commit(data, {'scan-a': {'hash': digest, 'size': size, 'format': 'glb', 'name': 'room.glb'}})
        saved = Path(self.service.paths['prop-a'])
        with zipfile.ZipFile(saved) as archive:
            self.assertEqual(json.loads(archive.read('workspace.json'))['properties'], data['properties'])
            item = json.loads(archive.read('manifest.json'))['files'][0]
            self.assertEqual(archive.read(item['path']), payload)
        import shutil
        shutil.rmtree(self.root / 'runtime')
        restored = WorkspaceService(self.root / 'runtime', self.root / 'projects')
        self.assertEqual(restored.snapshot()['data']['properties'], data['properties'])
        self.assertEqual((restored.root / 'blobs' / digest).read_bytes(), payload)

    def test_videos_and_measurement_frames_travel_in_the_project_bundle(self):
        video, frame, stray = b'\x00\x00\x00\x18ftypmp42 synthetic video', b'\xff\xd8 synthetic frame', b'unreferenced'
        assets = {}
        for key, payload, kind in (('vid-a', video, 'video'), ('mf-a', frame, 'frame'), ('mf-stray', stray, 'frame')):
            digest, size = self.service.store_blob(io.BytesIO(payload)); assets[key] = {'hash': digest, 'size': size, 'kind': kind}
        data = workspace(); prop = data['properties'][0]
        prop['videos'] = [{'id': 'vid-a', 'name': 'walkthrough.mov', 'mime': 'video/quicktime'}]
        prop['measurements'] = [{'id': 'ms-a', 'videoId': 'vid-a', 'seconds': 12, 'frameAssetId': 'mf-a', 'value': 0.8382},
                                {'id': 'ms-b', 'videoId': 'vid-a', 'seconds': 13, 'frameAssetId': None, 'value': None}]
        self.commit(data, assets)
        with zipfile.ZipFile(self.service.paths['prop-a']) as archive:
            files = {item['id']: archive.read(item['path']) for item in json.loads(archive.read('manifest.json'))['files']}
        self.assertEqual(files, {'vid-a': video, 'mf-a': frame}, 'the video and the saved frame are kept; an unreferenced frame is not')
        restarted = WorkspaceService(self.root / 'runtime', self.root / 'projects')
        self.assertEqual(restarted.snapshot()['data']['properties'][0]['measurements'][0]['frameAssetId'], 'mf-a')
        self.assertEqual(set(restarted.part_assets['prop-a']), {'vid-a', 'mf-a'})

    def test_fixtures_travel_in_the_project_file_and_come_back_from_disk(self):
        data = workspace()
        data['properties'][0]['fixtures'] = [
            {'id': 'fx-run', 'level': 'lvl-0', 'kind': 'base-run', 'pts': [[0, 0], [2.4, 0]], 'side': 1, 'depth': 0.62, 'y0': 0, 'h': 0.91,
             'corners': [None, None], 'material': 'mat-quartz', 'provenance': {'source': 'scan', 'confidence': 0.82, 'scanId': 'scan-a'}},
            {'id': 'fx-bed', 'level': 'lvl-0', 'kind': 'furniture', 'subtype': 'bed', 'x': 3, 'y': 2, 'rot': 90, 'w': 2.0, 'd': 1.57, 'y0': 0, 'h': 0.59,
             'provenance': {'source': 'tape', 'confidence': None}},
        ]
        self.commit(data)
        with zipfile.ZipFile(Path(self.service.paths['prop-a'])) as archive:
            self.assertEqual(json.loads(archive.read('workspace.json'))['properties'][0]['fixtures'], data['properties'][0]['fixtures'])
        import shutil
        shutil.rmtree(self.root / 'runtime')
        restored = WorkspaceService(self.root / 'runtime', self.root / 'projects')
        self.assertEqual(restored.snapshot()['data']['properties'][0]['fixtures'], data['properties'][0]['fixtures'])

    def test_stale_device_cannot_overwrite_and_external_file_edit_is_seen(self):
        revision = self.commit(workspace())
        self.commit(workspace('Newer'))
        with self.assertRaises(WorkspaceError) as caught: self.commit(workspace('Stale'), revision=revision)
        self.assertEqual(caught.exception.status, 409)
        path = Path(self.service.paths['prop-a'])
        self.service.bundle(path, workspace('External edit'), {})
        self.assertEqual(self.service.snapshot()['data']['properties'][0]['name'], 'External edit')

    def test_unchanged_projects_not_rewritten_and_deletion_retains_original(self):
        data = workspace(); self.commit(data)
        path = Path(self.service.paths['prop-a']); stamp = path.stat().st_mtime_ns
        self.commit(data)
        self.assertEqual(path.stat().st_mtime_ns, stamp)
        data['properties'] = []; self.commit(data)
        self.assertTrue(path.exists())
        restarted = WorkspaceService(self.service.root, self.root / 'projects')
        self.assertEqual(restarted.snapshot()['data']['properties'], [])

    def test_migration_archives_unreferenced_originals_before_cleanup(self):
        digest, size = self.service.store_blob(io.BytesIO(b'orphan original'))
        self.commit(workspace(), migration={'data': workspace(), 'assets': {'orphan': {'hash': digest, 'size': size, 'name': 'old.jpg'}}})
        archive_path = next((self.service.root / 'history').glob('browser-migration-*.tiksi'))
        with zipfile.ZipFile(archive_path) as archive:
            entry = json.loads(archive.read('manifest.json'))['files'][0]
            self.assertEqual(archive.read(entry['path']), b'orphan original')

    def test_declined_copy_is_complete_atomic_and_does_not_change_current_project(self):
        self.commit(workspace('Canonical'))
        digest, size = self.service.store_blob(io.BytesIO(b'declined original'))
        record = {'data': workspace('Offline draft'), 'assets': {'photo-a': {'hash': digest, 'size': size, 'name': 'draft.jpg'}}}
        before = self.service.snapshot()
        name = self.service.archive_copy(record)
        self.assertEqual(self.service.archive_copy(record), name)
        self.assertEqual(self.service.snapshot(), before)
        with zipfile.ZipFile(self.service.root / 'history' / name) as archive:
            self.assertEqual(json.loads(archive.read('workspace.json')), record['data'])
            entry = json.loads(archive.read('manifest.json'))['files'][0]
            self.assertEqual(archive.read(entry['path']), b'declined original')
        with patch.object(self.service, 'bundle', side_effect=OSError('Synthetic archive interruption')):
            with self.assertRaises(OSError): self.service.archive_copy({'data': workspace('Interrupted'), 'assets': {}})
        self.assertEqual(len(list((self.service.root / 'history').glob('conflict-*.tiksi'))), 1)
        self.assertEqual(list((self.service.root / 'history').glob('*.tmp')), [])

    def test_http_migration_accepts_recovery_and_project_copies_of_large_metadata(self):
        data = workspace()
        data['properties'][0]['notes'] = 'synthetic evidence ' + 'x' * (12 * 1024 * 1024)
        body = json.dumps({'revision': 0, 'data': data, 'assets': {},
                           'projectData': {'prop-a': data},
                           'migration': {'data': data, 'assets': {}}}).encode()
        self.assertGreater(len(body), MAX_JSON)
        class Handler:
            path = '/api/workspace'; command = 'PUT'; client_address = ('127.0.0.1', 1234)
            connection = Mock()
            headers = {'Host': 'localhost:8888', 'Content-Length': str(len(body)),
                       'X-Tiksi-Workspace': '1', 'X-Tiksi-Token': self.service.token}
            rfile = io.BytesIO(body); wfile = io.BytesIO()
            def send_response(self, status): self.status = status
            def send_header(self, *args): pass
            def end_headers(self): pass
        handler = Handler()
        self.service.dispatch(handler)
        self.assertEqual(handler.status, 200, handler.wfile.getvalue())
        paths = [Path(self.service.paths['prop-a']),
                 next((self.service.root / 'history').glob('browser-migration-*.tiksi'))]
        for path in paths:
            with zipfile.ZipFile(path) as archive:
                self.assertEqual(json.loads(archive.read('workspace.json'))['properties'], data['properties'])

    def test_open_route_opens_only_paths_inside_the_project_folder_from_this_mac(self):
        self.commit(workspace())
        folder = Path(self.service.paths['prop-a']).parent
        doc = folder / 'Product documents' / 'Example X1' / 'manual.pdf'
        doc.parent.mkdir(parents=True); doc.write_bytes(b'synthetic manual')
        (self.root / 'outside.txt').write_text('not a project file')
        self.service.run = Mock(return_value=Mock(returncode=0, stderr=''))
        def post(body, client='127.0.0.1', identifier='prop-a'):
            data = json.dumps(body).encode()
            class Handler:
                path = '/api/workspace/open/' + identifier; command = 'POST'; client_address = (client, 1234)
                connection = Mock()
                headers = {'Host': 'localhost:8888', 'Content-Length': str(len(data)), 'X-Tiksi-Workspace': '1', 'X-Tiksi-Token': self.service.token}
                rfile = io.BytesIO(data); wfile = io.BytesIO()
                def send_response(self, status): self.status = status
                def send_header(self, *args): pass
                def end_headers(self): pass
            handler = Handler(); self.service.dispatch(handler)
            return handler.status, json.loads(handler.wfile.getvalue())
        status, reply = post({'path': 'Product documents/Example X1/manual.pdf'})
        self.assertEqual(status, 200, reply)
        self.assertEqual(self.service.run.call_args[0][0], ['open', str(doc.resolve())])
        self.assertEqual(post({'path': ''})[0], 200)
        self.assertEqual(self.service.run.call_args[0][0], ['open', str(folder.resolve())])
        self.service.run.reset_mock()
        for bad in ('../outside.txt', '/etc/hosts', 'Product documents/../../outside.txt'):
            self.assertEqual(post({'path': bad})[0], 400, bad)
        self.assertEqual(post({'path': 'Product documents/missing.pdf'})[0], 404)
        self.assertEqual(post({'path': ''}, identifier='prop-missing')[0], 404)
        status, reply = post({'path': ''}, client='100.80.1.2')
        self.assertEqual(status, 422); self.assertIn('Mac running Tiksi', reply['error'])
        self.service.run.assert_not_called()

    def test_missing_assets_and_missing_project_file_fail_without_overwrite(self):
        self.commit(workspace())
        with self.assertRaises(WorkspaceError): self.commit(workspace('Bad'), {'missing': {'hash': 'f' * 64, 'size': 4}})
        path = Path(self.service.paths['prop-a']); self.assertTrue(path.exists()); path.unlink()
        with self.assertRaises(WorkspaceError): self.service.snapshot()

    def test_interrupted_commit_finishes_from_journal_without_losing_projects(self):
        self.commit(workspace())
        original_replace = __import__('os').replace
        failed = False
        def interrupt(source, destination):
            nonlocal failed
            if str(destination).endswith('.tiksi') and not failed:
                failed = True
                raise OSError('Synthetic interrupted save')
            return original_replace(source, destination)
        with patch('server.workspace.os.replace', side_effect=interrupt):
            with self.assertRaises(OSError): self.commit(workspace('Recovered'))
        self.assertTrue((self.service.root / 'pending.json').exists())
        restored = WorkspaceService(self.service.root, self.root / 'projects')
        self.assertEqual(restored.snapshot()['data']['properties'][0]['name'], 'Recovered')
        self.assertFalse((self.service.root / 'pending.json').exists())

    def test_http_reads_require_trusted_peer_same_origin_and_custom_header(self):
        class Handler:
            path = '/api/workspace'; command = 'GET'; client_address = ('100.80.1.2', 1234)
            headers = {'Host': '100.80.1.1:8888'}; wfile = io.BytesIO()
            def send_response(self, status): self.status = status
            def send_header(self, *args): pass
            def end_headers(self): pass
        handler = Handler()
        self.service.dispatch(handler); self.assertEqual(handler.status, 403)
        handler.headers.update({'X-Tiksi-Workspace': '1', 'X-Tiksi-Token': self.service.token, 'Origin': 'http://other.example'})
        self.service.dispatch(handler); self.assertEqual(handler.status, 403)
        handler.headers.pop('Origin'); handler.wfile = io.BytesIO()
        snapshot = self.service.snapshot
        def checked_snapshot():
            self.assertEqual(self.service.active_jobs(), 1)
            return snapshot()
        with patch.object(self.service, 'snapshot', side_effect=checked_snapshot): self.service.dispatch(handler)
        self.assertEqual(handler.status, 200)
        self.assertEqual(self.service.active_jobs(), 0)
        handler.client_address = ('192.168.1.2', 1234)
        self.service.dispatch(handler); self.assertEqual(handler.status, 403)
