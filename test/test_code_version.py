"""The fingerprint of the app's served files, which an open page compares to notice new code."""
import http.client
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import unittest

from server.code_version import CodeVersion

ROOT = Path(__file__).resolve().parent.parent


class Clock:
    def __init__(self): self.now = 1000.0
    def __call__(self): return self.now


class Fingerprint(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.root = Path(self.temp.name)
        (self.root / 'js').mkdir(); (self.root / 'css').mkdir(); (self.root / 'vendor/lib').mkdir(parents=True)
        (self.root / 'index.html').write_text('<!doctype html>')
        (self.root / 'js/main.js').write_text('export const a = 1;')
        (self.root / 'css/app.css').write_text('body{}')
        (self.root / 'vendor/lib/x.js').write_text('x')
        self.clock = Clock()
        self.version = CodeVersion(self.root, every=5, clock=self.clock)

    def tearDown(self): self.temp.cleanup()

    def later(self, seconds=5): self.clock.now += seconds

    def test_it_is_short_and_stays_the_same_while_nothing_changes(self):
        first = self.version.value()
        self.assertRegex(first, r'^[0-9a-f]{16}$')
        self.later(); self.assertEqual(self.version.value(), first)
        self.assertEqual(CodeVersion(self.root).value(), first, 'a restart gives the same value for the same files')

    def test_a_changed_added_or_removed_served_file_changes_it(self):
        seen = {self.version.value()}
        changes = [lambda: (self.root / 'js/main.js').write_text('export const a = 22;'),
                   lambda: (self.root / 'js/new.js').write_text('new'),
                   lambda: (self.root / 'vendor/lib/x.js').unlink(),
                   lambda: (self.root / 'css/app.css').write_text('body{color:red}'),
                   lambda: (self.root / 'index.html').write_text('<!doctype html><title>t</title>')]
        for change in changes:
            change(); self.later()
            value = self.version.value()
            self.assertNotIn(value, seen); seen.add(value)

    def test_a_file_rewritten_with_the_same_size_counts_by_its_time(self):
        first = self.version.value()
        target = self.root / 'js/main.js'
        target.write_text('export const b = 1;')
        os.utime(target, ns=(target.stat().st_atime_ns, target.stat().st_mtime_ns + 1_000_000_000))
        self.later()
        self.assertNotEqual(self.version.value(), first)

    def test_files_the_app_does_not_serve_leave_it_alone(self):
        first = self.version.value()
        (self.root / 'js/.DS_Store').write_text('finder')
        (self.root / 'README.md').write_text('notes')
        (self.root / 'server').mkdir(); (self.root / 'server/x.py').write_text('pass')
        self.later()
        self.assertEqual(self.version.value(), first)

    def test_the_folders_are_read_again_at_most_every_few_seconds(self):
        first = self.version.value()
        (self.root / 'js/main.js').write_text('export const a = 333;')
        self.later(4.9)
        self.assertEqual(self.version.value(), first, 'not read again within the interval')
        self.later(0.1)
        self.assertNotEqual(self.version.value(), first)

    def test_a_missing_folder_is_not_an_error(self):
        (self.root / 'vendor/lib/x.js').unlink(); (self.root / 'vendor/lib').rmdir(); (self.root / 'vendor').rmdir()
        self.assertRegex(CodeVersion(self.root).value(), r'^[0-9a-f]{16}$')

    def test_reading_it_costs_nothing_noticeable(self):
        version = CodeVersion(ROOT)
        started = time.perf_counter(); version.value(); scan = time.perf_counter() - started
        self.assertLess(scan, 0.5, 'one scan of the real app folders')
        started = time.perf_counter()
        for _ in range(10000): version.value()
        self.assertLess((time.perf_counter() - started) / 10000, 0.0001, 'a request between scans')


class HeadAnswer(unittest.TestCase):
    def test_the_server_reports_the_code_version_with_the_revision(self):
        with tempfile.TemporaryDirectory() as temp:
            with socket.socket() as probe:
                probe.bind(('127.0.0.1', 0)); port = probe.getsockname()[1]
            child = subprocess.Popen([sys.executable, str(ROOT / 'tools/serve.py'), '--port', str(port), '--state-dir', temp,
                                      '--projects-dir', str(Path(temp) / 'projects')],
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                def call(path, headers):
                    for _ in range(100):
                        try:
                            connection = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
                            connection.request('GET', path, headers=headers)
                            response = connection.getresponse()
                            return response.status, json.loads(response.read())
                        except (ConnectionRefusedError, OSError): time.sleep(0.05)
                    raise AssertionError('the server did not start')
                headers = {'X-Tiksi-Workspace': '1'}
                headers['X-Tiksi-Token'] = call('/api/workspace/capabilities', headers)[1]['token']
                status, head = call('/api/workspace/head', headers)
                self.assertEqual(status, 200)
                self.assertEqual(head['codeVersion'], CodeVersion(ROOT).value())
                self.assertIsInstance(head['revision'], int)
            finally:
                child.terminate(); child.wait(timeout=10)


if __name__ == '__main__': unittest.main()
