"""SketchUp build archive and hook journal against synthetic projects, never local-data."""
import contextlib
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / 'scripts/sketchup-build.py'
SPEC = importlib.util.spec_from_file_location('tiksi_sketchup_build', SCRIPT)
sb = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sb)

PREFIX = 'mcp__00000000-0000-4000-8000-000000000000__'
SESSION = 'synthetic-session-1'
MODEL = sb.SKP_MAGIC + b'\x00synthetic model bytes'

class Models(BaseHTTPRequestHandler):
    """Serves registered bytes the way the cloud's signed download links do."""
    files = {}

    def do_GET(self):
        body = self.files.get(self.path.split('?', 1)[0])
        self.send_response(200 if body is not None else 404)
        self.end_headers()
        self.wfile.write(body if body is not None else b'missing')

    def log_message(self, *args):
        pass

class SketchUpBuildTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Models)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='tiksi-sketchup-build-test-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.data = self.base / 'local-data'
        self.project = self.data / 'synthetic-house'
        self.project.mkdir(parents=True)
        env = patch.dict(os.environ, {'TIKSI_LOCAL_DATA': str(self.data)})
        env.start()
        self.addCleanup(env.stop)
        Models.files = {}

    # Synthetic hook events, shaped like Claude Code's for the SketchUp cloud MCP.
    def build(self, code, clean=False, error=None, session=SESSION):
        payload = {'session_id': session, 'transcript_path': str(self.base / 'transcript.jsonl'),
                   'cwd': str(self.base), 'tool_name': PREFIX + 'build_model',
                   'tool_input': {'code': code, **({'clean': True} if clean else {})}}
        if error: payload.update(hook_event_name='PostToolUseFailure', error=error)
        else: payload.update(hook_event_name='PostToolUse', tool_response=[
            {'type': 'text', 'text': json.dumps({'result': {'ok': 1}, 'logs': None})}])
        return sb.run_hook(payload, self.data)

    def save(self, cloud, step, filename='Room.skp', body=MODEL, session=SESSION):
        path = f'/mcp/v1/sketchup/dl/{cloud}/{step:03d}-save/room.skp'
        Models.files[path] = body
        link = f'http://127.0.0.1:{self.server.server_port}{path}?t=synthetic-token'
        response = {'success': True, 'download_url': link, 'filename': filename, 'session_ended': False}
        return sb.run_hook({'session_id': session, 'hook_event_name': 'PostToolUse',
                            'tool_name': PREFIX + 'save_model', 'tool_input': {'filename': filename},
                            'tool_response': [{'type': 'text', 'text': json.dumps(response)}]}, self.data)

    def stop(self, active=False, session=SESSION):
        return sb.run_hook({'session_id': session, 'hook_event_name': 'Stop', 'stop_hook_active': active}, self.data)

    def cli(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = sb.main(list(argv))
        return code, out.getvalue(), err.getvalue()

    def events(self, session=SESSION):
        return sb.read_lines(self.data / sb.JOURNAL / session / 'events.jsonl')

    def file(self, name, text):
        path = self.base / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(text if isinstance(text, bytes) else text.encode('utf-8'))
        return path

    def room_session(self):
        """Two cloud sessions: an expired draft, then a clean build saved as two options."""
        self.build('probe_a()')                                   # 1  cloud A step 1
        self.save('a' * 8 + '-old', 2, 'Draft.skp')               # 2  cloud A step 2
        self.build('probe_b()')                                   # 3  cloud B step 1
        self.build('walls()', clean=True)                         # 4  step 2
        self.build('racks()  # ä')                                # 5  step 3
        self.build('typo(', error='SyntaxError: typo')            # 6  step 4
        self.save('b' * 8 + '-new', 5)                            # 7  step 5: option 1
        self.build('option_two()')                                # 8  step 6
        return self.save('b' * 8 + '-new', 7)                     # 9  step 7: option 2

    def test_hook_journals_every_call_and_downloads_each_save(self):
        self.assertIsNone(self.build('walls()', clean=True))
        self.assertIsNone(self.build('bad()', error='NameError: bad'))
        result = self.save('c' * 8, 3)
        folder = self.data / sb.JOURNAL / SESSION
        events = self.events()
        self.assertEqual([event['seq'] for event in events], [1, 2, 3])
        self.assertEqual((folder / events[0]['file']).read_text(encoding='utf-8'), 'walls()')
        self.assertTrue(events[0]['clean'])
        self.assertEqual((events[1]['ok'], events[1]['error']), (False, 'NameError: bad'))
        self.assertEqual((folder / events[1]['file']).read_text(encoding='utf-8'), 'bad()')
        save = events[2]
        self.assertEqual((save['cloud_session'], save['cloud_step'], save['name']), ('c' * 8, 3, 'Room.skp'))
        self.assertEqual((folder / save['file']).read_bytes(), MODEL)
        self.assertEqual(save['sha256'], hashlib.sha256(MODEL).hexdigest())
        context = result['hookSpecificOutput']['additionalContext']
        self.assertEqual(result['hookSpecificOutput']['hookEventName'], 'PostToolUse')
        self.assertIn('#3', context)
        self.assertIn('calls 1-2', context)
        self.assertIn(f'--session {SESSION} --save 3', context)
        self.assertNotIn('unverified', context)
        # Other tools on the same server, and other servers, are not journaled.
        self.assertIsNone(sb.run_hook({'session_id': SESSION, 'hook_event_name': 'PostToolUse',
                                       'tool_name': PREFIX + 'read_skill', 'tool_input': {}}, self.data))
        self.assertEqual(len(self.events()), 3)

    def test_archive_replays_only_the_calls_that_built_each_saved_option(self):
        self.room_session()
        post = self.file('labels.py', 'print("label")\n')
        builder = self.file('drafts/builder.py', 'walls()\nracks()\n')
        code, out, err = self.cli('archive', '--project', 'synthetic-house', '--label', 'draft-2',
                                  '--session', SESSION, '--save', '7', '--save', '9', '--code', str(builder),
                                  '--post', str(post), '--step', 'Run post/labels.py on each model',
                                  '--note', 'Option 2 adds the second rack.', '--source', 'synthetic conversation')
        self.assertEqual(code, 0, err)
        target = self.project / 'build' / 'draft-2'
        self.assertEqual(out.strip(), str(target))
        self.assertEqual(sorted(path.relative_to(target).as_posix() for path in target.rglob('*') if path.is_file()), [
            'README.md', 'calls/0004.py', 'calls/0005.py', 'calls/0006.py', 'calls/0008.py', 'code/builder.py',
            'manifest.json', 'models/0009-Room.skp', 'models/Room.skp', 'post/labels.py'])
        self.assertEqual((target / 'calls/0005.py').read_text(encoding='utf-8'), 'racks()  # ä')
        self.assertEqual((target / 'models/Room.skp').read_bytes(), MODEL)
        readme = (target / 'README.md').read_text(encoding='utf-8')
        steps = re.findall(r'^\d+\. .*$', readme.split('### Exact replay')[1].split('##')[0], re.M)
        self.assertEqual(steps, [
            '1. `build_model` with `clean: true` and the code in `calls/0004.py`.',
            '2. `build_model` and the code in `calls/0005.py`.',
            '3. `build_model` and the code in `calls/0006.py` (failed when recorded).',
            '4. `save_model` with filename "Room.skp"; the result is `models/Room.skp`.',
            '5. `build_model` and the code in `calls/0008.py`.',
            '6. `save_model` with filename "Room.skp"; the result is `models/0009-Room.skp`.'])
        self.assertIn('1. `build_model` with `clean: true` and the code in `code/builder.py`.', readme)
        self.assertIn('1. Run post/labels.py on each model', readme)
        self.assertIn('Source: synthetic conversation.', readme)
        manifest = json.loads((target / 'manifest.json').read_text(encoding='utf-8'))
        self.assertEqual([(item['save'], item['verified']) for item in manifest['replay']], [(7, True), (9, True)])
        self.assertNotIn('synthetic-token', json.dumps(manifest))
        self.assertEqual(sb.verify(target), [])
        self.assertEqual(self.cli('verify', str(target))[0], 0)
        rows = self.cli('pending', '--session', SESSION)[1].splitlines()
        self.assertEqual([('#2' in row, 'not filed' in row) for row in rows], [(True, True), (False, False), (False, False)])
        self.assertIn(f'filed in {target}', rows[1])
        # A label is written once; nothing is overwritten.
        code, _, err = self.cli('archive', '--project', 'synthetic-house', '--label', 'draft-2', '--session', SESSION)
        self.assertEqual(code, 1)
        self.assertIn('choose a new label', err)

    def test_new_cloud_session_without_clean_starts_from_its_first_call(self):
        self.build('old()', clean=True)
        self.save('d' * 8, 2)
        self.build('fresh()')
        self.build('more()')
        self.save('e' * 8, 3)
        target, plans = sb.archive(self.args(session=SESSION), self.data)
        self.assertEqual([call['seq'] for call in plans[0]['calls']], [3, 4])
        self.assertTrue(plans[0]['verified'])
        self.assertIn('1. `build_model` with `clean: true` and the code in `calls/0003.py`.',
                      (target / 'README.md').read_text(encoding='utf-8'))

    def test_journal_that_began_mid_session_is_archived_but_flagged(self):
        self.build('late()')
        self.save('f' * 8, 5)
        code, _, err = self.cli('archive', '--project', 'synthetic-house', '--label', 'late', '--session', SESSION)
        self.assertEqual(code, 0, err)
        self.assertIn('3 earlier call(s) are missing', err)
        manifest = json.loads((self.project / 'build/late/manifest.json').read_text(encoding='utf-8'))
        self.assertFalse(manifest['replay'][0]['verified'])
        self.assertIn('Check save 2 by hand', (self.project / 'build/late/README.md').read_text(encoding='utf-8'))

    def args(self, **values):
        defaults = dict(project='synthetic-house', label='draft-1', code=[], session=None, save=[], skp=[],
                        post=[], step=[], note=[], source=None)
        defaults.update(values)
        return type('Args', (), defaults)()

    def test_archive_from_builder_files_without_a_journal(self):
        first, second = self.file('a.py', 'walls()\n'), self.file('b.py', 'racks()\n')
        model = self.file('exports/Room v8.skp', MODEL)
        target, plans = sb.archive(self.args(code=[first, second], skp=[str(model)], step=['Add labels']), self.data)
        self.assertEqual(plans, [])
        readme = (target / 'README.md').read_text(encoding='utf-8')
        self.assertIn('1. `build_model` with `clean: true` and the code in `code/a.py`.', readme)
        self.assertIn('2. `build_model` and the code in `code/b.py`.', readme)
        self.assertNotIn('Exact replay', readme)
        self.assertEqual((target / 'models/Room v8.skp').read_bytes(), MODEL)
        self.assertEqual(sb.verify(target), [])

    def test_archive_rejects_bad_inputs_and_leaves_no_partial_folder(self):
        code_file = self.file('a.py', 'walls()\n')
        page = self.file('expired.skp', b'<html>link expired</html>')
        with self.assertRaisesRegex(sb.BuildError, 'not a SketchUp model'):
            sb.archive(self.args(code=[code_file], skp=[str(page)]), self.data)
        with self.assertRaisesRegex(sb.BuildError, 'No model to keep'):
            sb.archive(self.args(code=[code_file]), self.data)
        with self.assertRaisesRegex(sb.BuildError, 'Give the build code'):
            sb.archive(self.args(skp=[str(page)]), self.data)
        with self.assertRaisesRegex(sb.BuildError, 'add --session'):
            sb.archive(self.args(code=[code_file], save=[3]), self.data)
        with self.assertRaisesRegex(sb.BuildError, 'No file at'):
            sb.archive(self.args(code=[self.base / 'missing.py']), self.data)
        with self.assertRaisesRegex(sb.BuildError, 'No project folder'):
            sb.archive(self.args(project='nowhere', code=[code_file]), self.data)
        with self.assertRaisesRegex(sb.BuildError, 'label'):
            sb.archive(self.args(label='../escape', code=[code_file]), self.data)
        self.assertEqual(list((self.project / 'build').iterdir()), [])
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as stopped:
            sb.main(['archive', '--project', 'synthetic-house', '--label', 'x', '--unknown'])
        self.assertEqual(stopped.exception.code, 2)

    def test_error_page_downloads_are_refused_and_reported(self):
        self.build('walls()', clean=True)
        result = self.save('g' * 8, 2, body=b'<html>expired</html>')
        save = self.events()[-1]
        self.assertNotIn('file', save)
        self.assertIn('not a SketchUp model', save['download_error'])
        self.assertIn('NOT downloaded', result['hookSpecificOutput']['additionalContext'])
        with self.assertRaisesRegex(sb.BuildError, 'never downloaded'):
            sb.archive(self.args(session=SESSION), self.data)
        self.assertEqual(list((self.project / 'build').iterdir()), [])
        # The link still serves the model: archive fetches it then.
        Models.files[next(iter(Models.files))] = MODEL
        target, _ = sb.archive(self.args(session=SESSION), self.data)
        self.assertEqual((target / 'models/Room.skp').read_bytes(), MODEL)
        with self.assertRaisesRegex(sb.BuildError, 'https'):
            sb.fetch('file:///etc/hosts', self.base / 'x.skp')

    def test_stop_holds_a_turn_once_for_each_unfiled_save(self):
        self.assertIsNone(self.stop())
        self.build('walls()', clean=True)
        self.assertIsNone(self.stop())
        self.save('h' * 8, 2)
        held = self.stop()
        self.assertEqual(held['decision'], 'block')
        self.assertIn('#2', held['reason'])
        self.assertIsNone(self.stop(active=True))
        self.assertIsNone(self.stop())
        self.build('racks()')
        self.save('h' * 8, 4)
        self.assertIn('#4', self.stop()['reason'])
        self.build('doors()')
        self.save('h' * 8, 6)
        sb.archive(self.args(session=SESSION), self.data)
        self.assertIsNone(self.stop())
        self.assertIsNone(self.stop(session='another-session'))

    def test_archive_refuses_a_folder_git_would_track(self):
        repo = self.base / 'repo'
        (repo / 'plans' / 'house').mkdir(parents=True)
        (repo / 'local-data' / 'house').mkdir(parents=True)
        subprocess.run(['git', 'init', '-q', str(repo)], check=True)
        (repo / '.gitignore').write_text('local-data/\n', encoding='utf-8')
        code_file, model = self.file('a.py', 'walls()\n'), self.file('m.skp', MODEL)
        with self.assertRaisesRegex(sb.BuildError, 'tracked by Git'):
            sb.archive(self.args(project=str(repo / 'plans/house'), code=[code_file], skp=[str(model)]), self.data)
        target, _ = sb.archive(self.args(project=str(repo / 'local-data/house'), code=[code_file],
                                         skp=[str(model)]), self.data)
        self.assertTrue((target / 'manifest.json').is_file())

    def test_verify_reports_changed_missing_and_unlisted_files(self):
        target, _ = sb.archive(self.args(code=[self.file('a.py', 'walls()\n')],
                                         skp=[str(self.file('m.skp', MODEL))]), self.data)
        (target / 'code/a.py').write_text('changed()\n', encoding='utf-8')
        (target / 'models/m.skp').unlink()
        (target / 'extra.txt').write_text('stray\n', encoding='utf-8')
        self.assertEqual(sb.verify(target), ['changed code/a.py', 'missing models/m.skp', 'not in manifest extra.txt'])
        code, _, err = self.cli('verify', str(target))
        self.assertEqual(code, 1)
        self.assertIn('changed code/a.py', err)

    def test_configured_hooks_run_the_journal_through_the_shell(self):
        settings = json.loads((ROOT / '.claude/settings.json').read_text(encoding='utf-8'))['hooks']
        entry = settings['PostToolUse'][0]
        for name, matches in [(PREFIX + 'build_model', True), (PREFIX + 'save_model', True),
                              (PREFIX + 'build_model_v2', False), ('Bash', False), (PREFIX + 'read_skill', False)]:
            self.assertEqual(bool(re.search(entry['matcher'], name)), matches, name)
        self.assertEqual(settings['PostToolUseFailure'][0]['matcher'], entry['matcher'])
        payload = {'session_id': SESSION, 'hook_event_name': 'PostToolUse', 'tool_name': PREFIX + 'build_model',
                   'tool_input': {'code': 'walls()', 'clean': True}, 'tool_response': []}
        env = {**os.environ, 'CLAUDE_PROJECT_DIR': str(ROOT), 'TIKSI_LOCAL_DATA': str(self.data)}
        result = subprocess.run(['sh', '-c', entry['hooks'][0]['command']], input=json.dumps(payload), text=True,
                                capture_output=True, env=env, cwd=self.base)
        self.assertEqual((result.returncode, result.stdout), (0, ''), result.stderr)
        self.assertEqual(self.events()[0]['file'], 'calls/0001.py')
        # A checkout without the script (main before this lands) stays silent.
        elsewhere = {**env, 'CLAUDE_PROJECT_DIR': str(self.base)}
        result = subprocess.run(['sh', '-c', settings['Stop'][0]['hooks'][0]['command']], input='{}', text=True,
                                capture_output=True, env=elsewhere, cwd=self.base)
        self.assertEqual((result.returncode, result.stdout), (0, ''))

    def test_hook_failures_reach_the_agent_without_blocking(self):
        env = {**os.environ, 'TIKSI_LOCAL_DATA': str(self.data)}
        bad = {'session_id': '../escape', 'hook_event_name': 'PostToolUse', 'tool_name': PREFIX + 'build_model',
               'tool_input': {'code': 'walls()'}, 'tool_response': []}
        result = subprocess.run([sys.executable, str(SCRIPT), 'hook'], input=json.dumps(bad), text=True,
                                capture_output=True, env=env)
        self.assertEqual(result.returncode, 0)
        context = json.loads(result.stdout)['hookSpecificOutput']['additionalContext']
        self.assertIn('could not journal', context)
        self.assertIn('--code', context)
        self.assertFalse((self.data / sb.JOURNAL).exists())
        result = subprocess.run([sys.executable, str(SCRIPT), 'hook'], input='not json', text=True,
                                capture_output=True, env=env)
        self.assertEqual((result.returncode, result.stdout), (0, ''))

if __name__ == '__main__':
    unittest.main()
