"""Every service address refuses a caller that is neither this Mac nor on its Tailscale network."""
import http.client
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from server.folder_intake import FolderIntakeService
from server.model_conversion import ModelConversionService
from server.material_research import MaterialResearchService
from server import peers
from server.peers import Tailnet, trusted_peer
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


def tailnet(*addresses):
    """A tailnet as the local Tailscale daemon would describe it."""
    return Tailnet(ask=lambda: frozenset(ipaddress.ip_address(a) for a in addresses))


class Clock:
    def __init__(self): self.now = 1000.0
    def __call__(self): return self.now


class PeerRule(unittest.TestCase):
    def test_when_tailscale_has_never_answered_only_this_mac_is_trusted(self):
        clock = Clock()
        failures = (lambda: None, lambda: (_ for _ in ()).throw(OSError('no daemon')),
                    lambda: peers.tailnet_addresses({'Self': {}, 'Peer': ['not', 'an', 'object']}))
        for ask in failures:
            with patch.object(peers, 'TAILNET', Tailnet(ask=ask, clock=clock)), self.assertLogs('tiksi.peers', 'WARNING') as logged:
                for address in ('127.0.0.1', '::1', '::ffff:127.0.0.1'):
                    self.assertTrue(trusted_peer(address), address)
                for address in ('100.64.0.1', '100.101.102.103', 'fd7a:115c:a1e0::1', '::ffff:100.80.1.2', '192.168.1.9', '8.8.8.8', '', None):
                    self.assertFalse(trusted_peer(address), repr(address))
                for _ in range(20): trusted_peer('100.64.0.1')
                self.assertEqual(peers.refusal('100.64.0.1'), peers.UNASKED, 'the refused device is told why')
                self.assertEqual(peers.refusal('192.168.1.9'), peers.REFUSED)
                self.assertFalse(WorkspaceService.trusted_peer('100.80.1.2'), 'the project-file service uses the same rule')
            refused = [r for r in logged.records if 'Refused' in r.getMessage()]
            self.assertEqual(len(refused), 1, 'the refusal is logged at most once a minute, not per request')
            self.assertIn('only this Mac is trusted', refused[0].getMessage())
            clock.now += Tailnet.QUIET

    def test_when_tailscale_stops_answering_the_last_answer_is_kept(self):
        clock = Clock(); answer = [frozenset({ipaddress.ip_address('100.101.102.103')})]
        def ask():
            if answer[0] == 'shape': return peers.tailnet_addresses({'Self': {}, 'Peer': 'garbled'})
            return answer[0]
        with patch.object(peers, 'TAILNET', Tailnet(ask=ask, clock=clock)), self.assertLogs('tiksi.peers', 'WARNING') as logged:
            self.assertTrue(trusted_peer('100.101.102.103'))
            for failure in (None, 'shape'):
                answer[0] = failure
                clock.now += Tailnet.FRESH
                self.assertTrue(trusted_peer('100.101.102.103'), 'a device on the last good answer stays trusted')
                clock.now += Tailnet.RETRY
                self.assertFalse(trusted_peer('100.64.0.1'), 'a failed answer never opens the whole range')
                self.assertEqual(peers.refusal('100.64.0.1'), peers.REFUSED)
        self.assertEqual(len(logged.records), 1, 'one warning while Tailscale keeps failing')
        self.assertIn('last answer is used', logged.records[0].getMessage())

    def test_the_tailscale_command_is_found_outside_a_short_path(self):
        with tempfile.TemporaryDirectory() as temp:
            app = Path(temp) / 'Tailscale'
            app.write_text('#!/bin/sh\n'); app.chmod(0o755)
            missing = str(Path(temp) / 'absent')
            self.assertEqual(peers.find_cli(which=lambda name: None, candidates=(missing, str(app))), str(app))
            self.assertIsNone(peers.find_cli(which=lambda name: None, candidates=(missing,)))
            self.assertEqual(peers.find_cli(which=lambda name: '/on/path/tailscale', candidates=(str(app),)), '/on/path/tailscale')
            # The command in the Mac app answers only when TERM is set; a launch agent sets none.
            app.write_text('#!/bin/sh\nif [ -n "$TERM" ]; then echo \'{"Self": {"TailscaleIPs": ["100.70.0.1"]}, "Peer": {}}\'; else echo "The app window failed to start"; fi\n')
            bare = {k: v for k, v in os.environ.items() if k != 'TERM'}
            with patch.dict(os.environ, bare, clear=True):
                status = peers.tailscale_status(cli=str(app))
            self.assertEqual(peers.tailnet_addresses(status), {ipaddress.ip_address('100.70.0.1')}, 'this Mac itself is on the list')
        self.assertIn('/Applications/Tailscale.app/Contents/MacOS/Tailscale', peers.CLI_PATHS)
        self.assertIn('/opt/homebrew/bin/tailscale', peers.CLI_PATHS)
        self.assertIn('/usr/local/bin/tailscale', peers.CLI_PATHS)

    def test_when_tailscale_answers_only_its_devices_are_trusted(self):
        clock = Clock(); asked = []
        devices = {'100.101.102.103', 'fd7a:115c:a1e0::5'}
        def ask():
            asked.append(clock.now)
            return frozenset(ipaddress.ip_address(a) for a in devices)
        with patch.object(peers, 'TAILNET', Tailnet(ask=ask, clock=clock)):
            for address in ('127.0.0.1', '::1', '100.101.102.103', '::ffff:100.101.102.103', 'fd7a:115c:a1e0::5'):
                self.assertTrue(trusted_peer(address), address)
            # Another device in the same range, such as a neighbour on a hotel or mobile network.
            for address in ('100.64.0.1', '100.101.102.104', 'fd7a:115c:a1e0::6', '192.168.1.9'):
                self.assertFalse(trusted_peer(address), address)
            self.assertEqual(len(asked), 1, 'one answer serves many requests')
            for _ in range(50): trusted_peer('100.64.0.1')
            self.assertEqual(len(asked), 1, 'a stranger does not make the server ask on every request')
            # A phone just added to the tailnet is let in within a few seconds.
            devices.add('100.90.0.7')
            clock.now += Tailnet.RETRY
            self.assertTrue(trusted_peer('100.90.0.7'))
            self.assertEqual(len(asked), 2)
            # A device removed from the tailnet is refused once the answer is old.
            devices.discard('100.101.102.103')
            clock.now += Tailnet.FRESH
            self.assertFalse(trusted_peer('100.101.102.103'))

    def test_tailscale_status_is_read_for_this_mac_and_its_devices(self):
        status = {'BackendState': 'Running', 'Self': {'TailscaleIPs': ['100.70.0.1', 'fd7a:115c:a1e0::1']},
                  'Peer': {'key1': {'TailscaleIPs': ['100.70.0.2', 'fd7a:115c:a1e0::2']}, 'key2': {'TailscaleIPs': None}}}
        self.assertEqual(peers.tailnet_addresses(status), {ipaddress.ip_address(a) for a in ('100.70.0.1', 'fd7a:115c:a1e0::1', '100.70.0.2', 'fd7a:115c:a1e0::2')})
        self.assertEqual(peers.this_mac_tailscale_address(status), '100.70.0.1')
        self.assertEqual(peers.tailnet_addresses({'BackendState': 'Stopped', 'Self': {}, 'Peer': None}), frozenset(), 'a stopped Tailscale trusts no address in its range')
        for garbled in ([], {'Self': [], 'Peer': {}}, {'Self': {}, 'Peer': []}, {'Self': {}, 'Peer': {'k': 'x'}}, {'Self': {'TailscaleIPs': '100.70.0.1'}}):
            with self.assertRaises(ValueError, msg=repr(garbled)): peers.tailnet_addresses(garbled)
        self.assertIsNone(peers.this_mac_tailscale_address({'Self': []}))


class ServiceCallers(unittest.TestCase):
    """The real server with all seven real services; only the caller's address is set by the test."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); state = Path(self.temp.name)
        self.caller = '127.0.0.1'
        # The tailnet has one other device; the Mac's real Tailscale is never asked.
        trusted = patch.object(peers, 'TAILNET', tailnet('100.101.102.103')); trusted.start(); self.addCleanup(trusted.stop)
        test = self
        class Handler(serve.AppHandler):
            def setup(self):
                super().setup()
                self.client_address = (test.caller, self.client_address[1])
            def log_message(self, format, *args): test.logged.append(format % args)
        self.logged = []
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
        for caller in ('192.168.1.9', '10.0.0.4', '100.128.0.1', '169.254.10.10', '100.64.9.9'):
            self.caller = caller
            for service in SERVICES:
                status, body = self.call('/api/' + service + '/capabilities', headers=PAGE_HEADERS.get(service))
                self.assertEqual(status, 403, (caller, service))
                self.assertNotIn(tokens[service].encode(), body, (caller, service))
                self.assertIn('error', json.loads(body))
        self.assertEqual(self.seen, [], 'no service is handed a request from an untrusted caller')

    def test_a_device_refused_because_tailscale_cannot_be_asked_is_told_why(self):
        self.caller = '100.101.102.103'
        with patch.object(peers, 'TAILNET', Tailnet(ask=lambda: None)), self.assertLogs('tiksi.peers', 'WARNING'):
            for service in SERVICES:
                status, body = self.call('/api/' + service + '/capabilities', headers=PAGE_HEADERS.get(service))
                self.assertEqual(status, 403, service)
                self.assertEqual(json.loads(body)['error'], peers.UNASKED, service)
            self.caller = '127.0.0.1'
            self.assertEqual(self.call('/api/workspace/capabilities', headers=PAGE_HEADERS['workspace'])[0], 200, 'this Mac is still served')
        self.assertEqual(self.seen, ['workspace'])

    def test_routine_successful_reads_are_not_logged_but_writes_and_failures_are(self):
        token = json.loads(self.call('/api/workspace/capabilities', headers=PAGE_HEADERS['workspace'])[1])['token']
        for _ in range(5):
            self.assertEqual(self.call('/api/workspace/head', headers={**PAGE_HEADERS['workspace'], 'X-Tiksi-Token': token})[0], 200)
        self.assertEqual(self.call('/index.html')[0], 200)
        self.assertEqual(self.logged, [], 'every page polls every few seconds; those reads fill no log')
        self.assertEqual(self.call('/js/not-there.js')[0], 404)
        self.call('/api/workspace/recovery', 'POST', {**PAGE_HEADERS['workspace'], 'X-Tiksi-Token': token}, b'{}')
        self.assertTrue(any('404' in line for line in self.logged), self.logged)
        self.assertTrue(any('POST /api/workspace/recovery' in line for line in self.logged), self.logged)

    def test_through_tailscale_serve_only_signed_in_tailnet_devices_get_services(self):
        # Tailscale Serve and Funnel both pass requests on from this Mac, under the Mac's https name.
        self.server.allowed_hosts = ['mac.example-tailnet.ts.net']
        proxied = {'Host': 'mac.example-tailnet.ts.net'}
        for service in SERVICES:
            headers = {**PAGE_HEADERS.get(service, {}), **proxied}
            status, body = self.call('/api/' + service + '/capabilities', headers={**headers, 'Tailscale-User-Login': 'owner@example.com'})
            self.assertEqual(status, 200, ('through Serve, from a signed-in device', service))
            status, body = self.call('/api/' + service + '/capabilities', headers=headers)
            self.assertEqual(status, 403, ('through Funnel, from anyone', service))
            self.assertNotIn(b'token', body)
            self.assertIn('signed in to this tailnet', json.loads(body)['error'])
        self.assertEqual(self.call('/api/instance', 'HEAD', proxied)[0], 403)
        self.assertEqual(self.call('/index.html', headers=proxied)[0], 200, 'the page itself still loads')
        # A browser on this Mac, by any of its own names, is served as before.
        for host in ('localhost:8642', '127.0.0.1:8642'):
            self.assertEqual(self.call('/api/workspace/capabilities', headers={**PAGE_HEADERS['workspace'], 'Host': host})[0], 200, host)

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

    def test_a_service_that_fails_writes_the_real_error_to_the_server_log(self):
        token = json.loads(self.call('/api/workspace/capabilities', headers=PAGE_HEADERS['workspace'])[1])['token']
        cases = (('workspace', 'snapshot', OSError, '/api/workspace', {'X-Tiksi-Workspace': '1', 'X-Tiksi-Token': token}),
                 ('model_conversion', 'capabilities', RuntimeError, '/api/model-conversion/capabilities', {}),
                 ('video_frames', 'capabilities', RuntimeError, '/api/video/capabilities', PAGE_HEADERS['video']),
                 ('photo_placement', 'capabilities', RuntimeError, '/api/photo-placement/capabilities', {}))
        for name, method, kind, path, headers in cases:
            fault = 'synthetic fault in ' + name
            with patch.object(getattr(self.server, name), method, side_effect=kind(fault)), self.assertLogs('tiksi.' + name, 'ERROR') as logged:
                status, body = self.call(path, headers=headers)
            self.assertEqual(status, 500, name)
            self.assertNotIn(fault, body.decode(), 'the page still gets a plain sentence')
            record = '\n'.join(logged.output)
            self.assertIn(fault, record, name)
            self.assertIn('Traceback', record, 'where it happened is logged too: ' + name)
            self.assertIn(path, record, name)

    def test_the_page_itself_still_loads_for_any_device(self):
        # The page holds no project data; the caller check is about the services behind it.
        self.caller = '192.168.1.9'
        status, body = self.call('/')
        self.assertEqual(status, 200); self.assertIn(b'<html', body.lower())
        self.assertEqual(self.call('/js/main.js')[0], 200)


class ListeningAddresses(unittest.TestCase):
    """The real server, started as the Mac starts it, listening on more than one named address."""

    def start(self, *hosts):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        args = [sys.executable, str(ROOT / 'tools/serve.py'), '--port', '0', '--state-dir', self.temp.name, '--projects-dir', self.temp.name + '/projects']
        for host in hosts: args += ['--host', host]
        child = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        def stop():
            child.terminate(); child.wait(timeout=10); child.stdout.close(); child.stderr.close()
        self.addCleanup(stop)
        line = child.stdout.readline()
        self.assertIn('listening on', line)
        return child, int(line.strip().rsplit(':', 1)[1])

    def status(self, host, port):
        connection = http.client.HTTPConnection(host, port, timeout=5)
        try:
            connection.request('GET', '/api/instance'); return connection.getresponse().status
        finally: connection.close()

    def test_one_server_listens_on_every_address_it_is_given(self):
        try: socket.create_server(('::1', 0), family=socket.AF_INET6).close()
        except OSError: self.skipTest('this machine has no IPv6 loopback')
        child, port = self.start('127.0.0.1', '::1')
        self.assertIn('::1:' + str(port), child.stdout.readline())
        self.assertEqual(self.status('127.0.0.1', port), 200)
        self.assertEqual(self.status('::1', port), 200)

    def test_an_address_not_on_this_mac_yet_does_not_stop_the_start(self):
        # 192.0.2.1 is reserved for documentation, so no machine has it (as Tailscale's address before it is up).
        child, port = self.start('127.0.0.1', '192.0.2.1')
        self.assertEqual(self.status('127.0.0.1', port), 200)
        deadline = time.time() + 10
        lines = []
        while time.time() < deadline:
            lines.append(child.stderr.readline())
            if 'Cannot listen on 192.0.2.1' in lines[-1]: break
        self.assertIn('Cannot listen on 192.0.2.1', lines[-1], 'the log says which address is waiting')

    def test_by_default_only_this_mac_can_reach_the_server(self):
        child, port = self.start()
        self.assertEqual(self.status('127.0.0.1', port), 200)


if __name__ == '__main__': unittest.main()
