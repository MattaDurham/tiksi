"""RESTART TIKSI: the server starts again in place. Temporary folders only."""
import http.client
import json
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import Mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from server.restart import Restart
from server.workspace import WorkspaceError


class Busy:
    def __init__(self, count): self.count = count
    def active_jobs(self): return self.count


class RestartTests(unittest.TestCase):
    def server(self, **services):
        workspace = Mock(jobs=0, lock=threading.RLock())
        return Mock(spec=['workspace', *services], workspace=workspace, **services)

    def test_a_running_job_refuses_a_restart_until_the_page_says_go_ahead(self):
        stop = threading.Event()
        restart = Restart(self.server(reconstruction=Busy(1), video_frames=Busy(0)), stop.set, delay=0)
        with self.assertRaises(WorkspaceError) as refused:
            restart()
        self.assertEqual((refused.exception.status, refused.exception.code), (409, 'busy'))
        self.assertIn('photo to 3D', str(refused.exception))
        self.assertNotIn('video frames', str(refused.exception))
        self.assertFalse(restart.wanted.is_set())
        self.assertEqual(restart(force=True), {'restarting': True, 'stopped': ['photo to 3D']})
        self.assertTrue(stop.wait(2), 'the servers are told to stop')

    def test_finish_waits_for_a_save_then_runs_the_same_command_again(self):
        server = self.server()
        server.workspace.jobs = 1
        restart = Restart(server, lambda: None, delay=0)
        execv = Mock()
        self.assertFalse(restart.finish(execv=execv), 'nothing was asked')
        execv.assert_not_called()
        restart()
        def sleep(_): server.workspace.jobs = 0
        self.assertTrue(restart.finish(sleep=sleep, execv=execv))
        execv.assert_called_once_with(sys.executable, list(sys.orig_argv))
        self.assertEqual(server.workspace.jobs, 0, 'the save in progress finished first')


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0)); return s.getsockname()[1]


class RealServer(unittest.TestCase):
    """The real server, restarted from the page's address, answers again from the same process."""

    def call(self, port, method, path, headers=None):
        connection = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
        try:
            connection.request(method, path, headers={'X-Tiksi-Workspace': '1', **(headers or {})})
            r = connection.getresponse(); return r.status, json.loads(r.read() or b'null')
        finally: connection.close()

    def test_restart_answers_then_the_same_process_listens_again(self):
        temp = tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup)
        port = free_port()
        child = subprocess.Popen([sys.executable, str(ROOT / 'tools/serve.py'), '--port', str(port), '--state-dir', temp.name,
                                  '--projects-dir', temp.name + '/projects'], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        def stop():
            child.terminate()
            try: child.wait(timeout=10)
            except subprocess.TimeoutExpired: child.kill(); child.wait(timeout=10)
            child.stdout.close()
        self.addCleanup(stop)
        def listening():
            # The server's log shares the output; read on to its next 'listening on' line.
            for line in child.stdout:
                if 'listening on' in line: return True
            return False
        self.assertTrue(listening())
        status, before = self.call(port, 'GET', '/api/instance')
        status, cap = self.call(port, 'GET', '/api/workspace/capabilities')
        self.assertIn('restart', cap['features'])
        self.assertEqual(self.call(port, 'POST', '/api/workspace/restart', {'X-Tiksi-Token': cap['token']}),
                         (202, {'restarting': True, 'stopped': []}))
        self.assertTrue(listening(), 'the server started again')
        status, after = self.call(port, 'GET', '/api/instance')
        self.assertEqual((status, after['pid']), (200, child.pid), 'the same process')
        self.assertGreater(after['started'], before['started'])
        self.assertIsNone(child.poll())
        refused, _ = self.call(port, 'POST', '/api/workspace/restart', {'X-Tiksi-Token': cap['token']})
        self.assertEqual(refused, 403, 'the old token is not taken after a restart')


if __name__ == '__main__':
    unittest.main()
