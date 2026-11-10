"""Every service address refuses a caller that is neither this Mac nor on its Tailscale network."""
import http.client
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import unittest

from server.folder_intake import FolderIntakeService
from server.model_conversion import ModelConversionService
from server.material_research import MaterialResearchService
from server.peers import trusted_peer
from server.photo_placement import PhotoPlacementService
from server.reconstruction import ReconstructionService
from server.video_frames import VideoFrameService
from server.workspace import WorkspaceService

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('tiksi_serve_callers', ROOT / 'tools/serve.py')
serve = importlib.util.module_from_spec(spec); spec.loader.exec_module(serve)

SERVICES = ('workspace', 'reconstruction', 'material-research', 'model-conversion', 'video', 'photo-placement', 'folder-intake')
# What each service's own page sends when it asks for capabilities.
PAGE_HEADERS = {'workspace': {'X-Tiksi-Workspace': '1'}, 'video': {'X-Tiksi-Video': '1'}, 'folder-intake': {'X-Tiksi-Folder': '1'}}


class PeerRule(unittest.TestCase):
    def test_this_mac_and_tailscale_are_trusted_and_everything_else_is_not(self):
        for address in ('127.0.0.1', '::1', '::ffff:127.0.0.1', '100.64.0.1', '100.101.102.103', '100.127.255.254', 'fd7a:115c:a1e0::1', '::ffff:100.80.1.2'):
            self.assertTrue(trusted_peer(address), address)
        for address in ('192.168.1.9', '10.0.0.4', '172.16.5.5', '169.254.10.10', '100.63.255.255', '100.128.0.1', '8.8.8.8',
                        'fe80::1', 'fe80::1%en0', 'fd00::1', '::ffff:192.168.1.9', '', 'localhost', None):
            self.assertFalse(trusted_peer(address), repr(address))
        self.assertTrue(WorkspaceService.trusted_peer('100.80.1.2'), 'the project-file service uses the same rule')
        self.assertFalse(WorkspaceService.trusted_peer('192.168.1.2'))


class ServiceCallers(unittest.TestCase):
    """The real server with all seven real services; only the caller's address is set by the test."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); state = Path(self.temp.name)
        self.caller = '127.0.0.1'
        test = self
        class Handler(serve.AppHandler):
            def setup(self):
                super().setup()
                self.client_address = (test.caller, self.client_address[1])
            def log_message(self, *args): pass
        self.server = server = serve.AppServer(('127.0.0.1', 0), Handler)
        server.instance_file = None; server.allowed_hostname = '127.0.0.1'; server.allowed_hosts = []; server.remote_access = False
        server.workspace = WorkspaceService(state / 'workspace', state / 'projects')
        server.reconstruction = ReconstructionService(state / 'reconstruction')
        server.material_research = MaterialResearchService(state / 'material-research')
        server.model_conversion = ModelConversionService(state / 'converters')
        server.video_frames = VideoFrameService(state / 'video-frames')
        server.photo_placement = PhotoPlacementService(state / 'photo-placement', projects_dir=state / 'projects', project_folders=lambda: [])
        server.folder_intake = FolderIntakeService(server.workspace, chooser=lambda: None)
        # seen: a service was offered the request. answered: it took the request as its own.
        self.seen = []; self.answered = []
        for name in ('workspace', 'reconstruction', 'material_research', 'model_conversion', 'video_frames', 'photo_placement', 'folder_intake'):
            service = getattr(server, name); inner = service.dispatch
            def dispatch(handler, name=name, inner=inner):
                self.seen.append(name)
                taken = inner(handler)
                if taken: self.answered.append(name)
                return taken
            service.dispatch = dispatch
        self.thread = threading.Thread(target=server.serve_forever, daemon=True); self.thread.start()

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join(timeout=3)
        for name in ('reconstruction', 'material_research', 'model_conversion', 'video_frames', 'photo_placement'):
            getattr(self.server, name).close()
        self.temp.cleanup()

    def call(self, path, method='GET', headers=None, body=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        try:
            connection.request(method, path, body=body, headers=headers or {})
            response = connection.getresponse()
            return response.status, response.read()
        finally: connection.close()

    def test_this_mac_and_a_tailscale_device_get_every_service(self):
        for caller in ('127.0.0.1', '100.101.102.103'):
            self.caller = caller
            for service in SERVICES:
                status, body = self.call('/api/' + service + '/capabilities', headers=PAGE_HEADERS.get(service))
                self.assertEqual(status, 200, (caller, service, body))
                self.assertTrue(json.loads(body)['token'], (caller, service))
            self.assertEqual(self.call('/api/instance')[0], 200, caller)

    def test_another_device_on_the_wifi_gets_no_token_from_any_service(self):
        self.caller = '127.0.0.1'
        tokens = {service: json.loads(self.call('/api/' + service + '/capabilities', headers=PAGE_HEADERS.get(service))[1])['token'] for service in SERVICES}
        self.seen.clear()
        for caller in ('192.168.1.9', '10.0.0.4', '100.128.0.1', '169.254.10.10'):
            self.caller = caller
            for service in SERVICES:
                status, body = self.call('/api/' + service + '/capabilities', headers=PAGE_HEADERS.get(service))
                self.assertEqual(status, 403, (caller, service))
                self.assertNotIn(tokens[service].encode(), body, (caller, service))
                self.assertIn('error', json.loads(body))
        self.assertEqual(self.seen, [], 'no service is handed a request from an untrusted caller')

    def test_a_stolen_token_is_still_refused_for_every_method(self):
        tokens = {service: json.loads(self.call('/api/' + service + '/capabilities', headers=PAGE_HEADERS.get(service))[1])['token'] for service in SERVICES}
        self.seen.clear(); self.caller = '192.168.1.9'
        for service in SERVICES:
            headers = {**PAGE_HEADERS.get(service, {}), 'X-Tiksi-Token': tokens[service]}
            for method, path in (('GET', '/jobs'), ('POST', '/jobs'), ('PUT', '/jobs/' + '0' * 32 + '/images'), ('DELETE', '/jobs/' + '0' * 32), ('POST', '/convert'), ('POST', '/cancel'), ('GET', '')):
                body = b'{}' if method in ('POST', 'PUT') else None
                self.assertEqual(self.call('/api/' + service + path, method, headers, body)[0], 403, (service, method, path))
        self.assertEqual(self.seen, [])

    def test_other_spellings_of_a_service_address_do_not_get_past(self):
        self.caller = '192.168.1.9'
        for path in ('/api', '/api/', '/api/instance', '/api/reconstruction/capabilities/', '/api/reconstruction/capabilities?x=1',
                     '/api/model-conversion/capabilities#x', 'http://127.0.0.1/api/material-research/capabilities', '/api/not-a-service'):
            self.assertEqual(self.call(path)[0], 403, path)
        self.assertEqual(self.call('/api/instance', 'HEAD')[0], 403)
        self.assertEqual(self.seen, [])
        # Spellings the check does not match are ones no service takes as its own either.
        for path in ('//api/reconstruction/capabilities', '/%61pi/reconstruction/capabilities', '/API/reconstruction/capabilities', '/js/../api/reconstruction/capabilities'):
            status, body = self.call(path)
            self.assertNotEqual(status, 200, path); self.assertNotIn(b'token', body, path)
        self.assertEqual(self.answered, [])

    def test_the_page_itself_still_loads_for_any_device(self):
        # The page holds no project data; the caller check is about the services behind it.
        self.caller = '192.168.1.9'
        status, body = self.call('/')
        self.assertEqual(status, 200); self.assertIn(b'<html', body.lower())
        self.assertEqual(self.call('/js/main.js')[0], 200)


if __name__ == '__main__': unittest.main()
