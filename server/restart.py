"""Restarting the server that serves Tiksi, from the page (RESTART TIKSI in the Tiksi menu).

The server starts again in place: the same process (same process id, so the Mac's list of
background jobs and a branch preview's records still name it) runs the same command again,
reading the code now in its folder. Long jobs would stop, so a restart asked while one runs is
refused unless the page says to go ahead. A save in progress is let finish first."""
import os
import sys
import threading
import time

from server.workspace import WorkspaceError

# The services whose jobs a restart would stop, and what the page calls each.
JOBS = (('reconstruction', 'photo to 3D'), ('material_research', 'material research'),
        ('model_conversion', 'model conversion'), ('video_frames', 'video frames'),
        ('photo_placement', 'photo placement'), ('folder_intake', 'reading a folder'))


class Restart:
    def __init__(self, server, stop, delay=0.3):
        # stop() makes every listening server leave its loop; main() then calls finish().
        self.server, self.stop, self.delay = server, stop, delay
        self.wanted = threading.Event()

    def busy(self):
        names = []
        for attribute, name in JOBS:
            count = getattr(getattr(self.server, attribute, None), 'active_jobs', None)
            try:
                if callable(count) and count(): names.append(name)
            except Exception: names.append(name)
        return names

    def __call__(self, force=False):
        busy = self.busy()
        if busy and not force:
            error = WorkspaceError('Still running on the Mac: ' + ', '.join(busy) + '. Restarting stops it.', 409)
            error.code = 'busy'
            raise error
        if not self.wanted.is_set():
            self.wanted.set()
            # The answer goes out first; then the servers stop.
            timer = threading.Timer(self.delay, self.stop)
            timer.daemon = True
            timer.start()
        return {'restarting': True, 'stopped': busy}

    def finish(self, wait=10.0, clock=time.monotonic, sleep=time.sleep, execv=os.execv):
        """Called once the servers have stopped: start again in place if a restart was asked."""
        if not self.wanted.is_set(): return False
        workspace = getattr(self.server, 'workspace', None)
        deadline = clock() + wait
        while workspace is not None and workspace.jobs and clock() < deadline: sleep(0.05)
        # Held to the end, so no save is half-written when the process is replaced.
        if workspace is not None: workspace.lock.acquire()
        for stream in (sys.stdout, sys.stderr):
            try: stream.flush()
            except (OSError, ValueError): pass
        execv(sys.executable, list(sys.orig_argv))
        return True
