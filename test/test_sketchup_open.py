"""Edit in SketchUp: finding the browser's mirror file and opening it, on synthetic folders."""
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

from server.model_conversion import ModelConversionService
from server.sketchup_open import OpenError, at_this_mac, locate, open_file


def described(path, **extra):
    st = os.stat(path)
    return dict({'name': path.name, 'size': st.st_size, 'mtime': int(st.st_mtime * 1000)}, **extra)


class Run:
    def __init__(self, code=0, stderr=''):
        self.calls, self.code, self.stderr = [], code, stderr

    def __call__(self, args, **kwargs):
        self.calls.append(args)
        return type('Result', (), {'returncode': self.code, 'stderr': self.stderr})()


class LocateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def skp(self, rel, data=b'synthetic skp', mtime=1_700_000_000):
        p = self.root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
        os.utime(p, (mtime, mtime))
        return p

    def test_finds_the_file_whose_size_and_time_agree(self):
        mine = self.skp('A/Tiksi/House.skp')
        self.skp('B/Tiksi/House.skp', data=b'another house, longer')
        self.skp('C/Tiksi/House.skp', mtime=1_600_000_000)
        found = locate(described(mine), search=lambda name: sorted(self.root.rglob(name)), roots=[])
        self.assertEqual(found, mine)

    def test_a_valid_hint_skips_the_search(self):
        mine = self.skp('A/Tiksi/House.skp')
        def search(name): raise AssertionError('searched despite a valid hint')
        self.assertEqual(locate(described(mine, hint=str(mine), folder='Tiksi'), search=search, roots=[]), mine)

    def test_a_stale_hint_is_looked_up_again(self):
        old = self.skp('Old/Tiksi/House.skp')
        moved = self.skp('New/Tiksi/House.skp', data=b'saved again in SketchUp')
        found = locate(described(moved, hint=str(old)), search=lambda name: [moved], roots=[])
        self.assertEqual(found, moved)

    def test_copies_are_told_apart_by_their_folders(self):
        mine = self.skp('12 Example Lane/Tiksi/House.skp')
        self.skp('Backup/Tiksi/House.skp')
        self.skp('Elsewhere/House.skp')
        everything = lambda name: sorted(self.root.rglob(name))
        self.assertEqual(locate(described(mine, folder='Tiksi', parent='12 Example Lane'), search=everything, roots=[]), mine)
        with self.assertRaises(OpenError) as caught:
            locate(described(mine, folder='Tiksi'), search=everything, roots=[])
        self.assertEqual(caught.exception.status, 409)

    def test_without_spotlight_a_walk_of_the_roots_finds_it(self):
        mine = self.skp('Projects/Lakeside/House.skp')
        self.skp('.hidden/House.skp')
        self.assertEqual(locate(described(mine), search=lambda name: [], roots=[self.root]), mine)

    def test_nothing_matching_is_reported_not_guessed(self):
        mine = self.skp('A/House.skp')
        wrong = described(mine)
        wrong['size'] += 1
        with self.assertRaises(OpenError) as caught:
            locate(wrong, search=lambda name: [mine], roots=[self.root])
        self.assertEqual(caught.exception.status, 404)

    def test_requests_are_validated(self):
        mine = self.skp('A/House.skp')
        for bad in [dict(described(mine), name='../House.skp'), dict(described(mine), name='House.tiksi'),
                    dict(described(mine), name='.skp'), dict(described(mine), size=0), dict(described(mine), size=True),
                    dict(described(mine), mtime='yesterday')]:
            with self.assertRaises(OpenError):
                locate(bad, search=lambda name: [mine], roots=[])

    def test_opening_names_the_sketchup_app_and_reports_failure(self):
        mine = self.skp('A/House.skp')
        run = Run()
        open_file(mine, Path('/Applications/SketchUp 2026/SketchUp.app'), run)
        self.assertEqual(run.calls, [['open', '-a', '/Applications/SketchUp 2026/SketchUp.app', str(mine)]])
        with self.assertRaises(OpenError) as caught:
            open_file(mine, None, Run(code=1, stderr='LSOpenURLsWithRole() failed'))
        self.assertEqual(caught.exception.status, 422)


class RequestOriginTests(unittest.TestCase):
    def test_only_a_browser_on_this_mac_may_ask(self):
        self.assertTrue(at_this_mac('127.0.0.1', 'localhost:8642'))
        self.assertTrue(at_this_mac('::1', '127.0.0.1:8643'))
        self.assertTrue(at_this_mac('::ffff:127.0.0.1', '[::1]:8642'))
        self.assertFalse(at_this_mac('192.168.1.20', 'localhost:8642'))
        self.assertFalse(at_this_mac('127.0.0.1', 'mac.tailnet.ts.net'))
        self.assertFalse(at_this_mac('127.0.0.1', '192.168.1.5:8642'))
        self.assertFalse(at_this_mac('', ''))


class EndpointTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.service = ModelConversionService(Path(self.temp.name))
        self.service.sketchup = True
        self.asked = []
        self.service.open_sketchup = lambda request: self.asked.append(request) or {'path': '/synthetic/House.skp', 'app': 'SketchUp'}

    def tearDown(self):
        self.service.close()
        self.temp.cleanup()

    def call(self, body, client='127.0.0.1', host='localhost:8643', token=None):
        data = json.dumps(body).encode()
        service = self.service
        class Handler:
            path = '/api/model-conversion/open-in-sketchup'; command = 'POST'
            client_address = (client, 50000)
            headers = {'Host': host, 'Content-Length': str(len(data)), 'X-Tiksi-Token': service.token if token is None else token}
            rfile = io.BytesIO(data); wfile = io.BytesIO()
            def send_response(self, status): self.status = status
            def send_header(self, *args): pass
            def end_headers(self): pass
        h = Handler()
        self.assertTrue(self.service.dispatch(h))
        return h.status, json.loads(h.wfile.getvalue() or b'{}')

    def test_opens_for_a_local_browser_with_the_token(self):
        status, reply = self.call({'name': 'House.skp', 'size': 10, 'mtime': 1})
        self.assertEqual((status, reply['path']), (200, '/synthetic/House.skp'))
        self.assertEqual(self.asked, [{'name': 'House.skp', 'size': 10, 'mtime': 1}])

    def test_refuses_other_machines_missing_tokens_and_missing_sketchup(self):
        self.assertEqual(self.call({'name': 'House.skp'}, client='10.0.0.7')[0], 403)
        self.assertEqual(self.call({'name': 'House.skp'}, token='wrong')[0], 403)
        self.service.sketchup = False
        self.assertEqual(self.call({'name': 'House.skp'})[0], 422)
        self.assertEqual(self.asked, [])

    def capabilities(self, client, host='localhost:8643'):
        class Handler:
            path = '/api/model-conversion/capabilities'; command = 'GET'
            client_address = (client, 50000)
            headers = {'Host': host}
            wfile = io.BytesIO()
            def send_response(self, status): self.status = status
            def send_header(self, *args): pass
            def end_headers(self): pass
        h = Handler()
        self.assertTrue(self.service.dispatch(h))
        self.assertEqual(h.status, 200)
        return json.loads(h.wfile.getvalue())

    def test_only_this_macs_browser_is_offered_it(self):
        self.assertEqual(self.capabilities('127.0.0.1')['openSketchUp'], sys.platform == 'darwin')
        self.assertFalse(self.capabilities('10.0.0.7')['openSketchUp'])
        self.assertFalse(self.capabilities('127.0.0.1', host='mac.tailnet.ts.net')['openSketchUp'])
        self.service.sketchup = False
        self.assertFalse(self.capabilities('127.0.0.1')['openSketchUp'])


if __name__ == '__main__':
    unittest.main()
