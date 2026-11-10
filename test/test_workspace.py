"""Disk project sharing: synthetic bundles and temporary directories only."""
import contextlib
import io
import ipaddress
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch
import zipfile
from server.peers import Tailnet
from server.workspace import WorkspaceService, WorkspaceError, MAX_JSON


def fresh(data):
    """A copy, as a save request arrives: never the same objects the server already holds."""
    return json.loads(json.dumps(data))


def workspace(name='A'):
    return {'version': 2, 'settings': {}, 'properties': [{'id': 'prop-a', 'name': name, 'scans': [], 'photos': []}], 'projects': [], 'materials': [], 'products': []}


class WorkspaceTests(unittest.TestCase):
    def setUp(self):
        # 100.80.1.2 is a phone on this tailnet; the Mac's real Tailscale is never asked.
        trusted = patch('server.peers.TAILNET', Tailnet(ask=lambda: frozenset({ipaddress.ip_address('100.80.1.2')})))
        trusted.start(); self.addCleanup(trusted.stop)
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

    def two_with_originals(self):
        """Two properties, listed Zed before Alpha (the reverse of their file paths), each with an original."""
        data = {**workspace(), 'properties': []}; assets = {}
        for identifier, name in (('prop-z', 'Zed'), ('prop-a', 'Alpha')):
            digest, size = self.service.store_blob(io.BytesIO(name.encode() * 50000))
            data['properties'].append({'id': identifier, 'name': name, 'scans': [{'id': 'scan-' + identifier, 'name': 'Scan'}], 'photos': []})
            assets['scan-' + identifier] = {'hash': digest, 'size': size, 'format': 'glb', 'name': 'room.glb'}
        self.commit(data, assets)
        return data

    def test_a_restart_with_nothing_changed_copies_nothing_and_changes_no_revision(self):
        data = self.two_with_originals()
        before = self.service.snapshot()
        with patch.object(WorkspaceService, 'store_blob', side_effect=AssertionError('an original was copied again')):
            restarted = WorkspaceService(self.root / 'runtime', self.root / 'projects')
            after = restarted.snapshot()
        self.assertEqual(after['revision'], before['revision'], 'open pages do not reload')
        self.assertEqual([p['name'] for p in after['data']['properties']], ['Zed', 'Alpha'], 'the order is kept')
        self.assertEqual(after['data'], before['data']); self.assertEqual(after['assets'], before['assets'])
        # Saving after the restart still works and the next restart is still quiet.
        self.service = restarted
        data['properties'][0]['name'] = 'Zed revised'
        self.commit(data, before['assets'])
        revision = restarted.snapshot()['revision']
        self.assertEqual(WorkspaceService(self.root / 'runtime', self.root / 'projects').snapshot()['revision'], revision)

    def test_a_project_file_changed_elsewhere_is_fingerprinted_without_copying_originals_already_held(self):
        self.two_with_originals()
        path = Path(self.service.paths['prop-a'])
        os.utime(path, ns=(path.stat().st_atime_ns, path.stat().st_mtime_ns + 10 ** 9))  # touched by another program
        with patch.object(WorkspaceService, 'store_blob', side_effect=AssertionError('an original already held was copied again')):
            restarted = WorkspaceService(self.root / 'runtime', self.root / 'projects')
        self.assertEqual([p['name'] for p in restarted.snapshot()['data']['properties']], ['Zed', 'Alpha'])

    def test_a_restart_with_a_project_still_missing_changes_no_revision(self):
        self.two_with_originals()
        Path(self.service.paths['prop-a']).unlink()
        revision = self.service.snapshot()['revision']
        restarted = WorkspaceService(self.root / 'runtime', self.root / 'projects')
        self.assertEqual(restarted.snapshot()['revision'], revision)
        self.assertEqual([u['id'] for u in restarted.snapshot()['unavailable']], ['prop-a'])

    def test_saved_catalog_copies_are_thinned_to_recent_then_daily_then_monthly(self):
        from server.workspace import prune_history, KEEP_SAVES
        folder = self.root / 'history-test'; folder.mkdir()
        now = 1_800_000_000.0; day = 86400
        # Ten saves a day for 200 days, newest last; plus copies that are never removed.
        revision = 0
        for age in range(199, -1, -1):
            for hour in range(10):
                revision += 1
                path = folder / (str(revision) + '.json'); path.write_text('{}')
                os.utime(path, (now - age * day - (10 - hour) * 3600,) * 2)
        keep = [folder / 'conflict-x.tiksi', folder / 'unreadable-save-note-1.json', folder / '12.unreadable-3.json']
        for path in keep: path.write_text('{}')
        removed = prune_history(folder, now)
        left = sorted(int(p.stem) for p in folder.glob('*.json') if p.stem.isdigit())
        self.assertEqual(left[-KEEP_SAVES:], list(range(revision - KEEP_SAVES + 1, revision + 1)), 'every recent save is kept')
        older = left[:-KEEP_SAVES]
        ages = [(now - (folder / (str(r) + '.json')).stat().st_mtime) / day for r in older]
        recent_days = {int(a) for a in ages if a <= 90}
        self.assertGreaterEqual(len(recent_days), 85, 'one a day for the last 90 days')
        self.assertLessEqual(sum(a > 91 for a in ages), 5, 'then one a month')
        self.assertLess(len(left), 160, 'bounded: far fewer than the 2000 saves')
        self.assertTrue(all(p.exists() for p in keep), 'recovery copies and set-aside notes are never removed')
        self.assertEqual(len(removed) + len(left), 2000)

    def test_saving_keeps_a_bounded_number_of_catalog_copies(self):
        for count in range(70): self.commit(workspace('A ' + str(count)))
        copies = [p for p in (self.root / 'runtime' / 'history').glob('*.json') if p.stem.isdigit()]
        self.assertEqual(len(copies), 50, 'seventy saves in one day keep the newest fifty copies')

    def test_stored_originals_nothing_refers_to_are_removed_after_a_grace_period(self):
        from server.workspace import BLOB_GRACE
        data = self.two_with_originals()
        kept = {a['hash'] for a in self.service.state['assets'].values()}
        old_history = self.root / 'runtime' / 'history' / '1.json'
        stray_old, _ = self.service.store_blob(io.BytesIO(b'replaced scan, long ago'))
        in_history, _ = self.service.store_blob(io.BytesIO(b'scan an older kept save refers to'))
        stray_new, _ = self.service.store_blob(io.BytesIO(b'uploaded, save not here yet'))
        old_history.write_text(json.dumps({'revision': 1, 'assets': {'s': {'hash': in_history}}}))
        now = time.time()
        for digest in (stray_old, in_history, *kept):
            os.utime(self.root / 'runtime' / 'blobs' / digest, (now - BLOB_GRACE - 10,) * 2)
        self.assertEqual(self.service.collect_blobs(now), 1)
        held = {p.name for p in (self.root / 'runtime' / 'blobs').iterdir()}
        self.assertNotIn(stray_old, held)
        self.assertTrue({in_history, stray_new, *kept} <= held)
        self.commit(data, self.service.state['assets'])

    def scanned(self, payload=b'synthetic scan ' * 200000):
        digest, size = self.service.store_blob(io.BytesIO(payload))
        data = workspace(); data['properties'][0]['scans'] = [{'id': 'scan-a', 'name': 'Scan'}]
        assets = {'scan-a': {'hash': digest, 'size': size, 'format': 'glb', 'name': 'room.glb'}}
        self.commit(data, assets)
        return data, assets, payload

    def test_a_save_that_changes_only_records_rewrites_only_the_end_of_the_project_file(self):
        data, assets, payload = self.scanned()
        path = Path(self.service.paths['prop-a'])
        with zipfile.ZipFile(path) as archive: before = {i.filename: i.header_offset for i in archive.infolist()}
        data = fresh(data); data['properties'][0]['notes'] = 'one word'
        with patch.object(WorkspaceService, 'bundle', side_effect=AssertionError('the whole project file was written again')):
            self.commit(data, assets)
        with zipfile.ZipFile(path) as archive:
            self.assertIsNone(archive.testzip())
            self.assertEqual(json.loads(archive.read('workspace.json'))['properties'][0]['notes'], 'one word')
            item = json.loads(archive.read('manifest.json'))['files'][0]
            self.assertEqual(archive.read(item['path']), payload)
            self.assertEqual(archive.getinfo(item['path']).header_offset, before[item['path']], 'the scan stays where it was')
        # A restart reads it back the same, and a second records-only save works too.
        restarted = WorkspaceService(self.root / 'runtime', self.root / 'projects')
        self.assertEqual(restarted.snapshot()['data']['properties'][0]['notes'], 'one word')
        self.service = restarted
        data = fresh(data); data['properties'][0]['notes'] = 'two words'
        with patch.object(WorkspaceService, 'bundle', side_effect=AssertionError('the whole project file was written again')):
            self.commit(data, assets)
        self.assertEqual(WorkspaceService(self.root / 'runtime', self.root / 'projects').snapshot()['data']['properties'][0]['notes'], 'two words')

    def test_a_save_that_changes_originals_or_meets_a_file_changed_elsewhere_writes_the_whole_file(self):
        data, assets, payload = self.scanned()
        path = Path(self.service.paths['prop-a'])
        digest, size = self.service.store_blob(io.BytesIO(b'a photo'))
        data = fresh(data); data['properties'][0]['photos'] = [{'id': 'photo-a', 'name': 'Photo'}]
        assets['photo-a'] = {'hash': digest, 'size': size, 'mime': 'image/jpeg'}
        real = WorkspaceService.bundle; calls = []
        def counted(*args, **kwargs): calls.append(1); return real(*args, **kwargs)
        with patch.object(WorkspaceService, 'bundle', counted): self.commit(data, assets)
        self.assertEqual(len(calls), 1, 'a new original: the whole file')
        # A file another program rewrote is read again before the save, whatever its layout.
        with zipfile.ZipFile(path) as archive: members = {i.filename: archive.read(i) for i in archive.infolist()}
        with zipfile.ZipFile(path, 'w') as archive:
            for name in ('workspace.json', 'manifest.json'): archive.writestr(name, members[name])
            for name, value in members.items():
                if name not in ('workspace.json', 'manifest.json'): archive.writestr(name, value)
        data = fresh(data); data['properties'][0]['notes'] = 'after an outside change'
        with patch.object(WorkspaceService, 'bundle', counted): self.commit(data, assets)
        self.assertEqual(len(calls), 2, 'records ahead of the originals: the whole file')
        with zipfile.ZipFile(path) as archive:
            self.assertEqual(json.loads(archive.read('workspace.json'))['properties'][0]['notes'], 'after an outside change')
            self.assertEqual(archive.namelist()[-1], 'workspace.json', 'written afresh with the records last')

    def test_a_records_rewrite_that_fails_leaves_the_project_file_whole_and_the_save_still_goes_through(self):
        data, assets, payload = self.scanned()
        path = Path(self.service.paths['prop-a']); before = path.read_bytes()
        real = zipfile.ZipFile.writestr; seen = []
        def failing(archive, name, *args, **kwargs):
            seen.append(name)
            if archive.mode == 'a' and name == 'workspace.json': raise OSError(28, 'No space left on device')
            return real(archive, name, *args, **kwargs)
        data = fresh(data); data['properties'][0]['notes'] = 'after a failed rewrite'
        with patch.object(zipfile.ZipFile, 'writestr', failing), self.assertLogs('tiksi.workspace', 'WARNING'):
            self.commit(data, assets)
        self.assertIn('workspace.json', seen)
        with zipfile.ZipFile(path) as archive:
            self.assertEqual(json.loads(archive.read('workspace.json'))['properties'][0]['notes'], 'after a failed rewrite')
            self.assertEqual(archive.read(json.loads(archive.read('manifest.json'))['files'][0]['path']), payload)
        self.assertEqual([p.name for p in path.parent.iterdir() if p.suffix == '.tmp'], [])
        self.assertNotEqual(path.read_bytes(), before)

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

    def test_open_on_this_mac_opens_documents_and_only_shows_anything_else_in_finder(self):
        self.commit(workspace())
        folder = Path(self.service.paths['prop-a']).parent
        files = {'Product documents/spec sheet.PDF': 'opened', 'Photos/kitchen.heic': 'opened', 'Drawings/plan.dwg': 'opened',
                 'Downloads/installer.command': 'shown', 'Downloads/run.sh': 'shown', 'Downloads/page.html': 'shown',
                 'Downloads/link.webloc': 'shown', 'Downloads/no extension': 'shown', 'Downloads/Tool.app': 'shown',
                 'Product documents': 'opened', 'Version 1.2': 'opened'}
        folders = {'Downloads/Tool.app', 'Product documents', 'Version 1.2'}
        for relative in files:
            target = folder / relative
            if relative in folders: target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(b'synthetic')
        self.service.run = Mock(return_value=Mock(returncode=0, stderr=''))
        for relative, expected in files.items():
            data = json.dumps({'path': relative}).encode()
            class Handler:
                path = '/api/workspace/open/prop-a'; command = 'POST'; client_address = ('127.0.0.1', 1234); connection = Mock()
                headers = {'Host': 'localhost:8888', 'Content-Length': str(len(data)), 'X-Tiksi-Workspace': '1', 'X-Tiksi-Token': self.service.token}
                rfile = io.BytesIO(data); wfile = io.BytesIO()
                def send_response(self, status): self.status = status
                def send_header(self, *args): pass
                def end_headers(self): pass
            handler = Handler(); self.service.dispatch(handler)
            reply = json.loads(handler.wfile.getvalue())
            self.assertEqual((handler.status, reply['action']), (200, expected), relative)
            command = self.service.run.call_args[0][0]
            target = str((folder / relative).resolve())
            self.assertEqual(command, ['open', target] if expected == 'opened' else ['open', '-R', target], relative)

    def test_an_alias_or_a_package_folder_is_only_shown_in_finder(self):
        from server.workspace import opens_directly, finder_flags, IS_ALIAS, HAS_BUNDLE
        folder = self.root / 'documents'; folder.mkdir()
        def made(name, contents=b'%PDF-1.7 synthetic'):
            (folder / name).write_bytes(contents); return folder / name
        plain = made('spec sheet.pdf')
        bookmark = made('spec sheet alias.pdf', b'book\0\0\0\0mark\0\0\0\0synthetic bookmark')
        flagged = made('drawing.dwg')
        package = folder / 'Installer'; (package / 'Contents' / 'MacOS').mkdir(parents=True)
        bundle = folder / 'Marked'; bundle.mkdir()
        listed = folder / 'Listed'; (listed / 'Contents').mkdir(parents=True); (listed / 'Contents' / 'Info.plist').write_text('<plist/>')
        ordinary = folder / 'Site photos'; (ordinary / 'Contents').mkdir(parents=True)
        marks = {flagged: IS_ALIAS, bundle: HAS_BUNDLE}
        flags = lambda target: marks.get(Path(target), 0)
        decided = {path.name: opens_directly(path, flags) for path in (plain, bookmark, flagged, package, bundle, listed, ordinary)}
        self.assertEqual(decided, {'spec sheet.pdf': True, 'spec sheet alias.pdf': False, 'drawing.dwg': False,
                                   'Installer': False, 'Marked': False, 'Listed': False, 'Site photos': True})
        if sys.platform == 'darwin':
            # The Finder flags are read from the file itself.
            import ctypes
            info = bytearray(32); info[0:4] = b'alis'; info[4:8] = b'MACS'; info[8:10] = IS_ALIAS.to_bytes(2, 'big')
            self.assertEqual(ctypes.CDLL(None).setxattr(os.fsencode(plain), b'com.apple.FinderInfo', bytes(info), 32, 0, 0), 0)
            self.assertEqual(finder_flags(plain), IS_ALIAS)
            self.assertFalse(opens_directly(plain))

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

    def test_a_half_written_save_note_found_at_start_is_set_aside_and_blocks_nothing(self):
        self.commit(workspace('Saved'))
        torn = b'{"state": {"revision": 2, "da'
        (self.service.root / 'pending.json').write_bytes(torn)
        with self.assertLogs('tiksi.workspace', 'WARNING'):
            restarted = WorkspaceService(self.service.root, self.root / 'projects')
        self.assertEqual(restarted.snapshot()['data']['properties'][0]['name'], 'Saved')
        self.assertFalse((restarted.root / 'pending.json').exists())
        aside = list((restarted.root / 'history').glob('unreadable-save-note-*.json'))
        self.assertEqual([p.read_bytes() for p in aside], [torn], 'the note is kept, byte for byte')
        self.service = restarted
        self.commit(workspace('Saved again'))
        self.assertEqual(WorkspaceService(restarted.root, self.root / 'projects').snapshot()['data']['properties'][0]['name'], 'Saved again')

    def test_a_save_cut_off_while_writing_its_note_leaves_no_note_behind(self):
        self.commit(workspace('Before'))
        path = Path(self.service.paths['prop-a']); before = path.read_bytes()
        real = json.dump
        def torn(value, out, *args, **kwargs):
            if isinstance(value, dict) and set(value) == {'state', 'files'}:
                out.write('{"state": {"revi'); out.flush()
                raise OSError('Synthetic full disk')
            return real(value, out, *args, **kwargs)
        with patch('server.workspace.json.dump', side_effect=torn):
            with self.assertRaises(OSError): self.commit(workspace('Cut off'))
        self.assertEqual(path.read_bytes(), before, 'no project file was replaced')
        self.assertEqual(self.service.snapshot()['data']['properties'][0]['name'], 'Before', 'the next request works')
        self.assertEqual(WorkspaceService(self.service.root, self.root / 'projects').snapshot()['data']['properties'][0]['name'], 'Before', 'and so does the next start')
        self.commit(workspace('After'))
        with zipfile.ZipFile(path) as archive: self.assertEqual(json.loads(archive.read('workspace.json'))['properties'][0]['name'], 'After')

    def test_a_note_whose_project_file_has_since_gone_does_not_block_the_rest(self):
        data = workspace(); data['properties'].append({'id': 'prop-b', 'name': 'B', 'scans': [], 'photos': []})
        self.commit(data)
        a = Path(self.service.paths['prop-a'])
        state = json.loads((self.service.root / 'current.json').read_text())
        (self.service.root / 'pending.json').write_text(json.dumps({'state': state, 'files': [[str(a) + '.gone.tmp', str(a)]]}))
        a.unlink()
        restarted = WorkspaceService(self.service.root, self.root / 'projects')
        snapshot = restarted.snapshot()
        self.assertEqual([p['name'] for p in snapshot['data']['properties']], ['B'])
        self.assertEqual(snapshot['unavailable'][0]['id'], 'prop-a')

    def test_a_half_written_history_copy_is_set_aside_and_written_again(self):
        self.commit(workspace('First'))
        revision = self.service.snapshot()['revision']
        catalog = (self.service.root / 'current.json').read_bytes()
        history = self.service.root / 'history' / (str(revision) + '.json')
        history.write_bytes(catalog[:len(catalog) // 2])   # as an earlier failed copy left it
        self.commit(workspace('Second'))
        self.assertEqual(history.read_bytes(), catalog, 'the history copy for that revision is whole')
        aside = list(history.parent.glob(str(revision) + '.unreadable-*.json'))
        self.assertEqual([p.read_bytes() for p in aside], [catalog[:len(catalog) // 2]], 'the broken copy is kept, not deleted')
        self.assertEqual(list(history.parent.glob('*.tmp')), [])

    def test_sketchup_mirror_files_are_written_through_their_own_spare_files(self):
        self.commit(workspace())
        source = Path(self.service.paths['prop-a'])
        # A spare file left in the way by another save, under the old fixed names.
        for name in ('.' + source.stem + '.mirror.tmp', source.stem + '.skp.tmp'): (source.parent / name).mkdir()
        def call(path, command, body=b'', headers=None):
            service = self.service
            class Handler:
                client_address = ('127.0.0.1', 1234); connection = Mock()
                def __init__(self):
                    self.path, self.command = path, command
                    self.headers = {'Host': 'localhost:8888', 'X-Tiksi-Workspace': '1', 'X-Tiksi-Token': service.token, 'Content-Length': str(len(body)), **(headers or {})}
                    self.rfile, self.wfile = io.BytesIO(body), io.BytesIO()
                def send_response(self, status): self.status = status
                def send_header(self, *args): pass
                def end_headers(self): pass
            h = Handler(); service.dispatch(h)
            return h.status, h.wfile.getvalue()
        state = json.dumps({'file': source.name, 'mirror': {'sig': 'synthetic'}}).encode()
        self.assertEqual(call('/api/workspace/mirror/prop-a/state', 'PUT', state)[0], 200)
        self.assertEqual(json.loads((source.parent / ('.' + source.stem + '.mirror.json')).read_text()), json.loads(state))
        self.assertEqual(call('/api/workspace/mirror/prop-a', 'PUT', b'synthetic skp', {'X-File-Mtime': '0'})[0], 200)
        self.assertEqual(source.with_suffix('.skp').read_bytes(), b'synthetic skp')
        self.assertEqual([p.name for p in source.parent.glob('.*.tmp') if p.is_file()], [])

    def test_a_sketchup_model_upload_is_received_in_pieces_into_its_own_spare_file(self):
        self.commit(workspace())
        source = Path(self.service.paths['prop-a']); model = source.with_suffix('.skp')
        body = bytes(range(256)) * (6 * 4096)
        test = self
        class Pieces(io.BytesIO):
            def read(self, amount=-1):
                test.assertTrue(0 < amount <= 4 * 1024 * 1024, 'the model is read in pieces, not whole: ' + str(amount))
                return super().read(amount)
        def put(stamp, data):
            class Handler:
                path = '/api/workspace/mirror/prop-a'; command = 'PUT'; client_address = ('127.0.0.1', 1)
                connection = type('C', (), {'settimeout': lambda self, t: None})()
                def send_response(self, status): self.status = status
                def send_header(self, *args): pass
                def end_headers(self): pass
            h = Handler(); h.rfile = Pieces(data); h.wfile = io.BytesIO()
            h.headers = {'Host': 'localhost:8888', 'X-Tiksi-Workspace': '1', 'X-Tiksi-Token': self.service.token, 'Content-Length': str(len(data)), 'X-File-Mtime': stamp}
            self.service.dispatch(h); return h.status
        self.assertEqual(put('0', body), 200)
        self.assertEqual(model.read_bytes(), body)
        self.assertEqual(put('0', b'stale'), 409, 'a model changed meanwhile is not overwritten')
        self.assertEqual(model.read_bytes(), body)
        self.assertEqual([p.name for p in source.parent.iterdir() if p.name.endswith('.tmp')], [], 'no spare file is left')

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


def three(a='A', b='B', c='C'):
    data = two(a, b); data['properties'].append({'id': 'prop-c', 'name': c, 'scans': [], 'photos': []})
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

    def on_a_drive(self):
        """A third project, C, kept on a separate drive, with an older copy in the projects folder."""
        self.drive = self.root / 'drive'; folder = self.drive / 'Client work'; folder.mkdir(parents=True)
        self.c = Path(self.service.plan_destination('prop-c', str(folder), 'C'))
        self.commit(three('A', 'B', 'C old'))
        self.assertEqual(self.service.paths['prop-c'], str(self.c))
        self.old_c = self.root / 'projects' / 'Copied earlier' / 'C.tiksi'; self.old_c.parent.mkdir()
        self.old_c.write_bytes(self.c.read_bytes())
        self.commit(three('A', 'B', 'C newer'))
        self.assertEqual((project_name(self.c), project_name(self.old_c)), ('C newer', 'C old'))

    def unmount(self): self.drive.rename(self.root / 'drive-not-mounted')

    def mount(self): (self.root / 'drive-not-mounted').rename(self.drive)

    def test_a_project_on_a_drive_that_is_not_mounted_waits_for_it_and_an_older_copy_does_not_take_over(self):
        self.on_a_drive()
        self.unmount()
        restarted = WorkspaceService(self.root / 'workspace', self.root / 'projects')
        names, snapshot = self.visible(restarted)
        self.assertEqual(sorted(names), ['A', 'B'], 'the older copy is not shown in its place')
        self.assertEqual([(u['id'], u['reason']) for u in snapshot['unavailable']], [('prop-c', 'missing')])
        self.assertEqual(restarted.paths['prop-c'], str(self.c), 'the drive path stays registered')
        data = {**snapshot['data'], 'properties': [p if p['id'] != 'prop-b' else {**p, 'name': 'B revised'} for p in snapshot['data']['properties']]}
        self.commit(data, service=restarted)
        self.mount()
        names, snapshot = self.visible(restarted)
        self.assertEqual(sorted(names), ['A', 'B revised', 'C newer'])
        self.assertEqual(restarted.paths['prop-c'], str(self.c))
        self.assertEqual(snapshot['unavailable'], [])
        self.assertEqual(project_name(self.old_c), 'C old', 'the older copy is left as it was')
        self.assertEqual(WorkspaceService(self.root / 'workspace', self.root / 'projects').paths['prop-c'], str(self.c))

    def test_a_save_cut_off_with_its_drive_then_unplugged_finishes_when_the_drive_returns(self):
        self.on_a_drive()
        real = os.replace
        def interrupt(source, destination):
            if str(destination) == str(self.c): raise OSError('Synthetic: the drive went away mid-save')
            return real(source, destination)
        with patch('server.workspace.os.replace', side_effect=interrupt):
            with self.assertRaises(OSError): self.commit(three('A', 'B', 'C newest'))
        self.assertTrue((self.service.root / 'pending.json').exists())
        self.unmount()
        with self.assertLogs('tiksi.workspace', 'WARNING'):
            restarted = WorkspaceService(self.root / 'workspace', self.root / 'projects')
        names, snapshot = self.visible(restarted)
        self.assertEqual(sorted(names), ['A', 'B'])
        self.assertEqual(snapshot['unavailable'][0]['id'], 'prop-c')
        self.assertTrue((restarted.root / 'pending-files.json').exists(), 'the move still to do is kept')
        # Another start before the drive returns still keeps it.
        restarted = WorkspaceService(self.root / 'workspace', self.root / 'projects')
        self.assertTrue((restarted.root / 'pending-files.json').exists())
        self.mount()
        names, snapshot = self.visible(restarted)
        self.assertEqual(sorted(names), ['A', 'B', 'C newest'], 'the save that was cut off is the one shown')
        self.assertEqual(project_name(self.c), 'C newest')
        self.assertFalse((restarted.root / 'pending-files.json').exists())
        self.assertEqual(list(self.c.parent.glob('*.tmp')), [], 'no spare file is left behind')
        self.commit(three('A', 'B', 'C after'), service=restarted)
        self.assertEqual(project_name(self.c), 'C after')

    def test_a_project_file_the_mac_cannot_read_sets_aside_only_its_own_project(self):
        original = self.a.read_bytes()
        def zipped(workspace_json):
            def write():
                with zipfile.ZipFile(self.a, 'w') as archive:
                    archive.writestr('workspace.json', workspace_json); archive.writestr('manifest.json', '{"files": []}')
            return write
        def no_permission():
            if hasattr(os, 'geteuid') and os.geteuid() == 0: self.skipTest('root reads any file')
            self.a.chmod(0)
        real_zip = zipfile.ZipFile
        def failing(path, *args, **kwargs):
            if isinstance(path, (str, os.PathLike)) and Path(path) == self.a: raise OSError(5, "Input/output error")
            return real_zip(path, *args, **kwargs)
        cases = {'no read permission': (no_permission, None),
                 'workspace.json is a list': (zipped('[]'), None),
                 'products are not records': (zipped(json.dumps({**workspace('A'), 'products': 'x'})), None),
                 'manifest is a list': (zipped(json.dumps(workspace('A'))), None),
                 'a failing drive': (lambda: None, patch('server.workspace.zipfile.ZipFile', side_effect=failing)),
                 'gone between the check and the read': (self.a.unlink, patch('server.workspace.file_state', return_value='file'))}
        for label, (damage, during) in cases.items():
            with self.subTest(label):
                if label == 'manifest is a list':
                    with zipfile.ZipFile(self.a, 'w') as archive:
                        archive.writestr('workspace.json', json.dumps({**workspace('A'), 'properties': [{'id': 'prop-a', 'name': 'A', 'scans': [], 'photos': []}]}))
                        archive.writestr('manifest.json', '[]')
                else: damage()
                with (during or contextlib.nullcontext()):
                    # The server starts with the file in this state.
                    restarted = WorkspaceService(self.root / 'workspace', self.root / 'projects')
                    names, snapshot = self.visible(restarted)
                    self.assertEqual([n[0] for n in names], ['B'], 'only A is left out')
                    self.assertEqual([(u['id'], u['reason']) for u in snapshot['unavailable']], [('prop-a', 'unreadable')])
                    data = {**snapshot['data'], 'properties': [{**snapshot['data']['properties'][0], 'name': 'B ' + label}]}
                    self.commit(data, service=restarted)
                self.assertEqual(project_name(self.b), 'B ' + label)
                if self.a.exists(): self.a.chmod(0o644)
                self.a.write_bytes(original)
                names, snapshot = self.visible(restarted)
                self.assertEqual(sorted(names), ['A', 'B ' + label], 'it returns once readable')

    def test_a_project_gone_for_good_can_be_taken_off_the_list_and_no_file_is_touched(self):
        self.a.rename(self.away)
        self.assertEqual([u['id'] for u in self.service.snapshot()['unavailable']], ['prop-a'])
        with self.assertRaises(WorkspaceError) as refused: self.service.forget('prop-b')
        self.assertEqual(refused.exception.status, 409, 'a project whose file is there cannot be taken off')
        files = {p: p.read_bytes() for p in self.root.rglob('*.tiksi')}
        def call(identifier):
            class Handler:
                path = '/api/workspace/unavailable/' + identifier + '/forget'; command = 'POST'; client_address = ('127.0.0.1', 1)
                headers = {'Host': 'localhost:8888', 'X-Tiksi-Workspace': '1', 'X-Tiksi-Token': self.service.token}
                def send_response(self, status): self.status = status
                def send_header(self, *args): pass
                def end_headers(self): pass
            h = Handler(); h.wfile = io.BytesIO(); self.service.dispatch(h)
            return h.status, json.loads(h.wfile.getvalue())
        before = self.service.snapshot()['revision']
        status, reply = call('prop-a')
        self.assertEqual((status, reply['unavailable']), (200, []))
        self.assertGreater(reply['revision'], before, 'every device sees it leave on its next poll')
        names, snapshot = self.visible()
        self.assertEqual((names, snapshot['unavailable']), (['B'], []))
        self.assertNotIn('prop-a', snapshot['paths'])
        self.assertEqual({p: p.read_bytes() for p in self.root.rglob('*.tiksi')}, files, 'no project file was deleted, moved or written')
        self.assertTrue(any(b'prop-a' in p.read_bytes() for p in (self.root / 'workspace' / 'history').glob('*.json')), 'its record stays in the saved copies')
        restarted = WorkspaceService(self.root / 'workspace', self.root / 'projects')
        self.assertEqual(restarted.snapshot()['unavailable'], [])
        self.assertEqual(call('prop-a')[0], 409, 'nothing left to take off')
        data = two('A', 'B again'); data['properties'] = data['properties'][1:]
        self.commit(data, service=restarted)
        self.assertEqual(project_name(self.b), 'B again', 'the rest keep saving')

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
