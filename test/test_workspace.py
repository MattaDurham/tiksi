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

    def test_missing_assets_fail_without_overwrite(self):
        self.commit(workspace())
        with self.assertRaises(WorkspaceError): self.commit(workspace('Bad'), {'missing': {'hash': 'f' * 64, 'size': 4}})
        path = Path(self.service.paths['prop-a']); self.assertTrue(path.exists())
        with zipfile.ZipFile(path) as archive: self.assertEqual(json.loads(archive.read('workspace.json'))['properties'][0]['name'], 'A')

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


def two(a='A', b='B'):
    data = workspace(a); data['properties'].append({'id': 'prop-b', 'name': b, 'scans': [], 'photos': []})
    return data


def project_name(path):
    with zipfile.ZipFile(path) as archive: return json.loads(archive.read('workspace.json'))['properties'][0]['name']


class UnavailableProjectTests(unittest.TestCase):
    """One project file moved, renamed, unplugged or damaged leaves the other projects working."""
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.service = WorkspaceService(self.root / 'workspace', self.root / 'projects')
        self.commit(two())
        self.a, self.b = Path(self.service.paths['prop-a']), Path(self.service.paths['prop-b'])
        self.away = self.root / 'elsewhere' / 'A.tiksi'; self.away.parent.mkdir()

    def tearDown(self): self.temp.cleanup()

    def commit(self, data, revision=None, service=None, **extra):
        service = service or self.service
        revision = service.snapshot()['revision'] if revision is None else revision
        return service.commit({'revision': revision, 'data': data, 'assets': {}, 'projectData': {p['id']: {**data, 'properties': [p]} for p in data['properties']}, **extra})

    def visible(self, service=None):
        snapshot = (service or self.service).snapshot()
        return [p['name'] for p in snapshot['data']['properties']], snapshot

    def test_a_moved_project_file_leaves_the_other_projects_loading_and_saving(self):
        self.a.rename(self.away)
        names, snapshot = self.visible()
        self.assertEqual(names, ['B'], 'only the missing project is left out')
        self.assertEqual([(u['id'], u['path'], u['reason']) for u in snapshot['unavailable']], [('prop-a', str(self.a), 'missing')])
        self.assertIn(str(self.a), snapshot['unavailable'][0]['message'], 'the message names the file')
        self.assertNotIn('prop-a', snapshot['paths'])
        # A device that has seen the snapshot saves the rest as usual.
        data = {**snapshot['data'], 'properties': [{**snapshot['data']['properties'][0], 'name': 'B revised'}]}
        self.commit(data)
        self.assertEqual(project_name(self.b), 'B revised')
        self.assertFalse(self.a.exists(), 'nothing is written where the missing file was')
        self.assertNotIn('prop-a', self.service.state.get('archived', {}), 'a missing project is not treated as deleted')
        # Put back, it returns with its own contents, and both keep saving.
        self.away.rename(self.a)
        names, snapshot = self.visible()
        self.assertEqual(sorted(names), ['A', 'B revised']); self.assertEqual(snapshot['unavailable'], [])
        self.commit(two('A again', 'B revised'))
        self.assertEqual((project_name(self.a), project_name(self.b)), ('A again', 'B revised'))

    def test_the_server_starts_with_a_project_file_missing(self):
        self.a.unlink()
        restarted = WorkspaceService(self.root / 'workspace', self.root / 'projects')
        names, snapshot = self.visible(restarted)
        self.assertEqual(names, ['B']); self.assertEqual(snapshot['unavailable'][0]['path'], str(self.a))
        data = {**snapshot['data'], 'properties': [{**snapshot['data']['properties'][0], 'name': 'B after restart'}]}
        self.commit(data, service=restarted)
        self.assertEqual(project_name(self.b), 'B after restart')
        self.assertFalse(self.a.exists())

    def test_the_real_server_starts_and_answers_with_a_project_file_missing(self):
        import subprocess, sys, urllib.request
        self.a.unlink()
        root = Path(__file__).resolve().parent.parent
        child = subprocess.Popen([sys.executable, str(root / 'tools/serve.py'), '--port', '0', '--state-dir', str(self.root),
                                  '--projects-dir', str(self.root / 'projects')], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        try:
            line = child.stdout.readline()
            self.assertIn('listening on', line, 'the server started')
            port = line.strip().rsplit(':', 1)[1]
            def get(path, token=''):
                request = urllib.request.Request('http://127.0.0.1:' + port + path, headers={'X-Tiksi-Workspace': '1', 'X-Tiksi-Token': token})
                with urllib.request.urlopen(request, timeout=10) as response: return json.loads(response.read())
            token = get('/api/workspace/capabilities')['token']
            snapshot = get('/api/workspace', token)
            self.assertEqual([p['name'] for p in snapshot['data']['properties']], ['B'])
            self.assertEqual(snapshot['unavailable'][0]['path'], str(self.a))
        finally:
            child.terminate(); child.wait(timeout=10); child.stdout.close()

    def test_the_same_project_found_at_a_new_path_takes_the_old_place(self):
        moved = self.root / 'projects' / 'Moved here' / 'A renamed.tiksi'; moved.parent.mkdir()
        self.a.rename(moved)
        names, snapshot = self.visible()
        self.assertEqual(sorted(names), ['A', 'B']); self.assertEqual(snapshot['unavailable'], [])
        self.assertEqual(self.service.paths['prop-a'], str(moved))
        self.commit(two('A at its new path'))
        self.assertEqual(project_name(moved), 'A at its new path')
        self.assertFalse(self.a.exists(), 'the old path is not written again')
        restarted = WorkspaceService(self.root / 'workspace', self.root / 'projects')
        self.assertEqual(restarted.snapshot()['paths']['prop-a'], str(moved))

    def test_a_copy_beside_a_registered_file_that_is_still_there_stays_a_copy(self):
        backup = self.root / 'projects' / 'Backup' / 'A.tiksi'; backup.parent.mkdir()
        backup.write_bytes(self.a.read_bytes())
        self.commit(two('A edited'))
        self.assertEqual(self.service.paths['prop-a'], str(self.a))
        self.assertEqual((project_name(self.a), project_name(backup)), ('A edited', 'A'))

    def test_a_damaged_project_file_is_left_alone_and_the_rest_keep_saving(self):
        damaged = b'not a project file any more'
        self.a.write_bytes(damaged)
        names, snapshot = self.visible()
        self.assertEqual(names, ['B']); self.assertEqual(snapshot['unavailable'][0]['reason'], 'unreadable')
        self.assertIn(str(self.a), snapshot['unavailable'][0]['message'])
        data = {**snapshot['data'], 'properties': [{**snapshot['data']['properties'][0], 'name': 'B revised'}]}
        self.commit(data)
        self.assertEqual(self.a.read_bytes(), damaged, 'the damaged file is never replaced')
        self.assertEqual(project_name(self.b), 'B revised')

    def test_a_device_that_still_edits_a_missing_project_has_its_copy_kept_and_is_told(self):
        before = self.service.snapshot()['revision']
        self.a.unlink()
        # A device that has not polled since sends both projects, the missing one edited.
        revision = self.commit(two('A edited offline', 'B revised'), revision=self.service.snapshot()['revision'])
        self.assertFalse(self.a.exists(), 'nothing is written at the missing path')
        self.assertEqual(project_name(self.b), 'B revised')
        kept = list((self.service.root / 'history').glob('unavailable-project-*.tiksi'))
        self.assertEqual(len(kept), 1)
        self.assertEqual(project_name(kept[0]), 'A edited offline', 'the edit is kept, not lost')
        self.assertGreater(self.service.snapshot()['revision'], revision, 'the device reads the workspace again and sees A left out')
        self.assertGreater(revision, before)

    def test_open_and_mirror_requests_for_a_missing_project_name_the_file(self):
        self.a.unlink()
        service = self.service
        for path, command in (('/api/workspace/open/prop-a', 'POST'), ('/api/workspace/mirror/prop-a/info', 'GET'), ('/api/workspace/mirror/prop-a', 'PUT')):
            class Handler:
                client_address = ('127.0.0.1', 1234); connection = Mock()
                headers = {'Host': 'localhost:8888', 'X-Tiksi-Workspace': '1', 'X-Tiksi-Token': service.token, 'Content-Length': '2', 'X-File-Mtime': '0'}
                rfile = io.BytesIO(b'{}'); wfile = io.BytesIO()
                def send_response(self, status): self.status = status
                def send_header(self, *args): pass
                def end_headers(self): pass
            Handler.path, Handler.command = path, command
            h = Handler(); service.dispatch(h)
            reply = json.loads(h.wfile.getvalue())
            self.assertEqual((h.status, reply.get('code')), (409, 'project-unavailable'), path)
            self.assertIn(str(self.a), reply['error'])
        self.assertFalse(self.a.with_suffix('.skp').exists())


def picture(payload, mime='image/png'):
    """A stored picture's reference, as js/picture-assets.js writes it."""
    import hashlib
    return 'tiksi-picture:' + mime + ':pic-' + hashlib.sha256(payload).hexdigest()


class PictureFileTests(unittest.TestCase):
    """Pictures saved as files: references in the records, the bytes beside the originals."""
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.service = WorkspaceService(self.root / 'runtime', self.root / 'projects')

    def tearDown(self): self.temp.cleanup()

    def commit(self, data, revision=None, slices=None, **extra):
        revision = self.service.snapshot()['revision'] if revision is None else revision
        slices = slices if slices is not None else {p['id']: {**data, 'properties': [p]} for p in data['properties']}
        # As over HTTP: the server gets its own copy, never the test's live objects.
        return self.service.commit(json.loads(json.dumps({'revision': revision, 'data': data, 'assets': {}, 'projectData': slices, 'pictureFiles': True, **extra})))

    def store(self, payload):
        self.service.store_blob(io.BytesIO(payload))
        return picture(payload)

    def test_pictures_travel_in_the_project_bundle_and_return_after_losing_the_transport_cache(self):
        thumb, plan = b'\x89PNG synthetic thumbnail ' * 40, b'\x89PNG synthetic floor plan ' * 4000
        data = workspace(); prop = data['properties'][0]
        prop['photos'] = [{'id': 'ph-a', 'thumb': self.store(thumb)}]
        prop['levels'] = [{'id': 'lvl-0', 'plan': {'img': self.store(plan), 'imgW': 10, 'imgH': 10}}]
        self.commit(data)
        saved = self.service.snapshot()
        self.assertEqual({a['kind'] for a in saved['assets'].values()}, {'picture'}, 'the server lists every referenced picture')
        with zipfile.ZipFile(self.service.paths['prop-a']) as archive:
            files = {item['id']: archive.read(item['path']) for item in json.loads(archive.read('manifest.json'))['files']}
            self.assertEqual(json.loads(archive.read('workspace.json'))['properties'], data['properties'])
        self.assertEqual(sorted(files.values()), sorted([thumb, plan]), 'the project file holds both pictures byte for byte')
        import shutil
        shutil.rmtree(self.root / 'runtime')
        restored = WorkspaceService(self.root / 'runtime', self.root / 'projects')
        for identifier, payload in (('pic-' + prop['photos'][0]['thumb'][-64:], thumb), ('pic-' + prop['levels'][0]['plan']['img'][-64:], plan)):
            self.assertEqual((restored.root / 'blobs' / identifier[4:]).read_bytes(), payload)
        self.assertEqual(restored.snapshot()['data']['properties'], data['properties'])

    def test_a_reference_without_its_file_is_refused(self):
        data = workspace(); data['properties'][0]['photos'] = [{'id': 'ph-a', 'thumb': picture(b'never uploaded')}]
        with self.assertRaises(WorkspaceError) as caught: self.commit(data)
        self.assertIn('picture', str(caught.exception))
        self.assertEqual(self.service.snapshot()['revision'], 0)

    def test_an_older_tab_cannot_save_over_picture_references(self):
        data = workspace(); data['properties'][0]['photos'] = [{'id': 'ph-a', 'thumb': self.store(b'synthetic picture' * 80)}]
        self.commit(data)
        blank = workspace(); blank['properties'][0]['photos'] = [{'id': 'ph-a', 'thumb': ''}]
        revision = self.service.snapshot()['revision']
        with self.assertRaises(WorkspaceError) as caught:
            self.service.commit({'revision': revision, 'data': blank, 'assets': {}, 'projectData': {'prop-a': blank}})
        self.assertEqual(caught.exception.status, 426)
        self.assertEqual(self.service.snapshot()['data']['properties'][0]['photos'][0]['thumb'], data['properties'][0]['photos'][0]['thumb'])
        # Before any picture is a file, an older tab still saves as it always did.
        fresh = WorkspaceService(self.root / 'other', self.root / 'other-projects')
        inline = workspace(); inline['properties'][0]['photos'] = [{'id': 'ph-a', 'thumb': 'data:image/png;base64,' + 'A' * 2000}]
        self.assertEqual(fresh.commit({'revision': 0, 'data': inline, 'assets': {}, 'projectData': {'prop-a': inline}}), 1)

    def test_unchanged_project_files_are_named_not_sent(self):
        data = workspace(); data['properties'].append({'id': 'prop-b', 'name': 'B', 'scans': [], 'photos': []})
        self.commit(data)
        files = {i: Path(p).stat().st_mtime_ns for i, p in self.service.paths.items()}
        data['properties'][1]['name'] = 'B revised'
        b = data['properties'][1]
        self.commit(data, slices={'prop-b': {**data, 'properties': [b]}}, unchangedProjects=['prop-a'])
        self.assertEqual(Path(self.service.paths['prop-a']).stat().st_mtime_ns, files['prop-a'], 'the unchanged project file is not rewritten')
        with zipfile.ZipFile(self.service.paths['prop-b']) as archive:
            self.assertEqual(json.loads(archive.read('workspace.json'))['properties'][0]['name'], 'B revised')
        # A project named as unchanged that differs from the held file is sent again.
        data['properties'][0]['name'] = 'A changed without its file'
        with self.assertRaises(WorkspaceError) as caught:
            self.commit(data, slices={'prop-b': {**data, 'properties': [b]}}, unchangedProjects=['prop-a'])
        self.assertEqual((caught.exception.status, caught.exception.code), (409, 'resend-projects'))
        # Every project must still be either sent or named.
        with self.assertRaises(WorkspaceError): self.commit(data, slices={'prop-b': {**data, 'properties': [b]}})
        with self.assertRaises(WorkspaceError): self.commit(data, slices={'prop-a': {**data, 'properties': [data['properties'][0]]}, 'prop-b': {**data, 'properties': [b]}}, unchangedProjects=['prop-a'])

    def handler(self, path, command='GET', body=b'', headers=None):
        service = self.service
        class Handler:
            client_address = ('127.0.0.1', 1234); connection = Mock()
            def __init__(self):
                self.path, self.command = path, command
                self.headers = {'Host': 'localhost:8888', 'X-Tiksi-Workspace': '1', 'X-Tiksi-Token': service.token, 'Content-Length': str(len(body)), **(headers or {})}
                self.rfile, self.wfile, self.sent = io.BytesIO(body), io.BytesIO(), {}
            def send_response(self, status): self.status = status
            def send_header(self, key, value): self.sent[key] = value
            def end_headers(self): pass
        h = Handler(); service.dispatch(h)
        return h

    def test_http_save_answers_with_paths_and_pictures_are_cached_by_the_browser(self):
        payload = b'synthetic picture bytes' * 100
        data = workspace(); data['properties'][0]['photos'] = [{'id': 'ph-a', 'thumb': self.store(payload)}]
        caps = json.loads(self.handler('/api/workspace/capabilities').wfile.getvalue())
        self.assertIn('picture-files', caps['features'])
        body = json.dumps({'revision': 0, 'data': data, 'assets': {}, 'projectData': {'prop-a': data}, 'pictureFiles': True}).encode()
        saved = self.handler('/api/workspace', 'PUT', body)
        reply = json.loads(saved.wfile.getvalue())
        self.assertEqual(saved.status, 200, reply)
        self.assertEqual(reply['paths'], self.service.paths, 'a save answers with the project paths, so no second read is needed')
        digest = data['properties'][0]['photos'][0]['thumb'][-64:]
        first = self.handler('/api/workspace/blobs/' + digest)
        self.assertEqual((first.status, first.wfile.getvalue()), (200, payload))
        self.assertIn('immutable', first.sent['Cache-Control'])
        again = self.handler('/api/workspace/blobs/' + digest, headers={'If-None-Match': first.sent['ETag']})
        self.assertEqual((again.status, again.wfile.getvalue()), (304, b''))

    def test_unchanged_property_records_are_named_not_sent(self):
        data = workspace(); data['properties'].append({'id': 'prop-b', 'name': 'B', 'scans': [], 'photos': [{'id': 'ph-b', 'thumb': self.store(b'synthetic picture' * 90)}]})
        self.commit(data)
        a, b = data['properties']
        changed = {**data, 'properties': [{**a, 'name': 'A revised'}]}
        self.commit(changed, slices={'prop-a': {**data, 'properties': [changed['properties'][0]]}}, unchangedProjects=['prop-b'], propertyOrder=['prop-a', 'prop-b'])
        saved = self.service.snapshot()['data']['properties']
        self.assertEqual(saved, [{**a, 'name': 'A revised'}, b], 'the named property is kept exactly, in order')
        self.assertIn('pic-' + b['photos'][0]['thumb'][-64:], self.service.snapshot()['assets'], 'its pictures stay listed')
        # A name the server does not hold is sent again, and nothing is written.
        revision = self.service.snapshot()['revision']
        with self.assertRaises(WorkspaceError) as caught:
            self.commit({**data, 'properties': []}, slices={}, unchangedProjects=['prop-a', 'prop-b', 'prop-c'], propertyOrder=['prop-a', 'prop-b', 'prop-c'])
        self.assertEqual(caught.exception.code, 'resend-projects')
        self.assertEqual(self.service.snapshot()['revision'], revision)
        with self.assertRaises(WorkspaceError): self.commit(changed, propertyOrder=['prop-b'])
