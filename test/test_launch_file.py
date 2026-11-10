"""The Claude preview settings start the real server on a preview port, on this Mac only, with
a state folder of its own: never a bare file server, never the live port or the live state."""
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import unittest
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
LAUNCH = json.loads((ROOT / '.claude/launch.json').read_text(encoding='utf-8'))


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


class LaunchFileTests(unittest.TestCase):
    def test_every_configuration_is_the_real_server_on_a_private_preview_port(self):
        for config in LAUNCH['configurations']:
            with self.subTest(name=config['name']):
                port = config['port']
                self.assertNotEqual(port, 8642, 'the live port belongs to the live app')
                self.assertTrue(8643 <= port <= 8699, 'previews use 8643-8699')
                command = ' '.join([config['runtimeExecutable'], *config['runtimeArgs']])
                self.assertNotIn('http.server', command)
                self.assertIn(f'--port {port}', command)
                with tempfile.TemporaryDirectory(prefix='tiksi-launch-test-') as temp:
                    self.start_and_probe(config, port, Path(temp))

    def start_and_probe(self, config, port, temp):
        # Run the configured command as written, on a free port instead of its own so the test
        # never meets a preview someone has open, with TMPDIR pointing at a throwaway folder.
        test_port = free_port()
        args = [a.replace(f'--port {port}', f'--port {test_port}') for a in config['runtimeArgs']]
        env = {**os.environ, 'TMPDIR': str(temp)}
        child = subprocess.Popen([config['runtimeExecutable'], *args], cwd=ROOT, env=env,
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            for _ in range(100):
                try:
                    with opener.open(f'http://127.0.0.1:{test_port}/api/instance', timeout=1) as response:
                        instance = json.load(response)
                    break
                except (OSError, ValueError):
                    time.sleep(0.1)
            else:
                self.fail('the configured server did not answer')
            self.assertIs(instance.get('live'), False, 'it is not the live app')
            with opener.open(f'http://127.0.0.1:{test_port}/', timeout=2) as response:
                self.assertIn('<div id="app">', response.read().decode('utf-8'))
            for private in ['/.git/config', '/AGENTS.local.md', '/.tiksi-state/', '/local-data/']:
                with self.assertRaises(urllib.error.HTTPError, msg=private) as failure:
                    opener.open(f'http://127.0.0.1:{test_port}{private}', timeout=2)
                self.assertIn(failure.exception.code, (403, 404))
                failure.exception.close()
            # Its state folder is its own, outside the checkout, so it never shares the live
            # app's or a branch preview's .tiksi-state.
            made = [p for p in temp.iterdir()]
            self.assertTrue(made, 'the server made its state folder under TMPDIR')
            self.assertFalse((ROOT / '.tiksi-state' / 'launch-preview').exists())
            # It listens on this Mac only.
            with socket.socket() as probe:
                probe.settimeout(1)
                outside = self.outside_address()
                if outside:
                    self.assertNotEqual(probe.connect_ex((outside, test_port)), 0, 'reachable from the network')
        finally:
            child.terminate()
            child.wait(timeout=10)

    def outside_address(self):
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
                s.connect(('192.0.2.1', 9))  # documentation address; nothing is sent
                address = s.getsockname()[0]
            return None if address.startswith('127.') else address
        except OSError:
            return None


if __name__ == '__main__': unittest.main()
