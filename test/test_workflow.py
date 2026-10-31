"""Lifecycle and landing guards against disposable repositories, never real main."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location('tiksi_branch', ROOT / 'scripts/branch.py')
branch = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(branch)

class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='tiksi-workflow-test-')
        self.root = Path(self.temp.name) / 'repo'
        self.root.mkdir()
        self.git('init', '-b', 'main')
        self.git('config', 'user.name', 'Synthetic Test')
        self.git('config', 'user.email', 'test@example.com')
        for name in ['tools', 'scripts', 'server']:
            (self.root / name).mkdir()
        shutil.copy(ROOT / 'tools/serve.py', self.root / 'tools/serve.py')
        shutil.copy(ROOT / 'server/workspace.py', self.root / 'server/workspace.py')
        (self.root / 'server/__init__.py').write_text('', encoding='utf-8')
        (self.root / 'scripts/preflight.sh').write_text('#!/bin/sh\nexit 0\n', encoding='utf-8')
        (self.root / 'index.html').write_text('<html><body>fixture</body></html>', encoding='utf-8')
        (self.root / 'AGENTS.local.example.md').write_text('Synthetic instructions\n', encoding='utf-8')
        (self.root / '.gitignore').write_text('.worktrees/\nAGENTS.local.md\n.tiksi-*\n', encoding='utf-8')
        self.git('add', '.')
        self.git('commit', '-m', 'Synthetic root')
        self.workflow = branch.Workflow(self.root)
        self.children = []
        # Concurrent suites have distinct disposable Git repositories and locks.
        # Keep synthetic servers away from owner preview ports and each other.
        with socket.socket() as candidate:
            candidate.bind(('127.0.0.1', 0))
            port = candidate.getsockname()[1]
        port_patch = patch.multiple(branch, PORT_MIN=port, PORT_MAX=min(65535, port + 99))
        port_patch.start()
        self.addCleanup(port_patch.stop)

    def tearDown(self):
        for slug in self.children:
            try:
                target = self.workflow.target(slug)
                data = self.workflow.metadata(target)
                if data and self.workflow.probe(data): self.workflow.stop(slug)
            except branch.WorkflowError: pass
        self.temp.cleanup()

    def git(self, *args, cwd=None):
        return subprocess.check_output(['git', *args], cwd=cwd or self.root, text=True, encoding='utf-8', stderr=subprocess.STDOUT).strip()

    def start(self, slug='feature'):
        target = self.workflow.start(slug)
        self.children.append(slug)
        return target

    def green_pr(self, target):
        return {'number': 1, 'state': 'OPEN', 'isDraft': False,
                'headRefOid': self.git('rev-parse', 'HEAD', cwd=target),
                'url': 'https://example.com/pr/1', 'statusCheckRollup': [
                    {'name': name, 'status': 'COMPLETED', 'conclusion': 'SUCCESS'}
                    for name in ['Regression (ubuntu-latest)', 'Regression (macos-latest)']]}

    def test_start_isolated_from_live_and_adopt_idempotent(self):
        target = self.start()
        self.assertNotEqual(target, self.root)
        self.assertEqual(self.git('branch', '--show-current', cwd=target), 'codex/feature')
        self.assertEqual(self.git('branch', '--show-current'), 'main')
        local = target / 'AGENTS.local.md'
        local.write_text('Owner edit\n', encoding='utf-8')
        self.workflow.adopt('feature')
        self.assertEqual(local.read_text(encoding='utf-8'), 'Owner edit\n')
        self.assertEqual(self.git('status', '--porcelain'), '')
        with self.assertRaises(branch.WorkflowError): self.workflow.start('../unsafe')

    def test_previews_health_reuse_fresh_archive_stop(self):
        target = self.start()
        metadata = self.workflow.serve('feature')
        self.assertGreaterEqual(metadata['port'], 8643)
        self.assertEqual(metadata['host'], '127.0.0.1')
        self.assertIsNotNone(self.workflow.probe(metadata))
        self.assertEqual(self.workflow.serve('feature')['pid'], metadata['pid'])
        saved = target / '.tiksi-state/project.json'
        saved.write_text('{"synthetic":true}', encoding='utf-8')
        fresh = self.workflow.serve('feature', fresh=True)
        self.assertNotEqual(fresh['instanceId'], metadata['instanceId'])
        self.assertEqual(fresh['port'], metadata['port'])
        with self.assertRaisesRegex(branch.WorkflowError, 'different interface'):
            self.workflow.serve('feature', host='0.0.0.0')
        archived = list((target / '.tiksi-state-archive').glob('*/project.json'))
        self.assertEqual(len(archived), 1)
        self.assertFalse(saved.exists())
        url = f'http://localhost:{fresh["port"]}/'
        with urllib.request.urlopen(url, timeout=2) as response:
            self.assertIn('PREVIEW codex/feature', response.read().decode('utf-8'))
        for private in ['/.git/config', '/AGENTS.local.md', '/.tiksi-state/project.json', '/tools/serve.py', '/js/../README.md', '/%2e%2e/index.html']:
            with self.assertRaises(urllib.error.HTTPError) as failure:
                urllib.request.urlopen(url.rstrip('/') + private, timeout=2)
            self.assertIn(failure.exception.code, (403, 404))
            failure.exception.close()
        request = urllib.request.Request(url, headers={'Host': 'attacker.example.com'})
        with self.assertRaises(urllib.error.HTTPError) as failure:
            urllib.request.urlopen(request, timeout=2)
        self.assertEqual(failure.exception.code, 403)
        failure.exception.close()
        self.workflow.stop('feature')
        self.assertIsNone(self.workflow.probe(fresh))
        self.assertEqual(self.git('status', '--porcelain'), '')

    def test_stale_pid_and_active_jobs_never_signalled(self):
        target = self.start()
        stale = {'pid': os.getpid(), 'port': 8642, 'instanceId': 'not-real'}
        branch.atomic_json(target / '.tiksi-instance.json', stale)
        with patch.object(self.workflow, 'probe', return_value=None), patch.object(branch.os, 'kill') as kill:
            with self.assertRaises(branch.WorkflowError): self.workflow.stop('feature')
            kill.assert_not_called()
        # Verify the actual service active-jobs response, not a source spelling.
        with self.assertRaisesRegex(branch.WorkflowError, 'still alive'):
            self.workflow.serve('feature')
        (target / '.tiksi-instance.json').unlink()
        data = self.workflow.serve('feature')
        class Response:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self): return b'{"activeJobs":1}'
        class Opener:
            def open(self, *args, **kwargs): return Response()
        with patch.object(self.workflow, 'probe', return_value=data), patch.object(branch.urllib.request, 'build_opener', return_value=Opener()), patch.object(branch.os, 'kill') as kill:
            with self.assertRaisesRegex(branch.WorkflowError, 'active reconstruction'):
                self.workflow.stop('feature')
            kill.assert_not_called()

    def test_merge_gates_dirty_stale_draft_and_failed_checks(self):
        target = self.start()
        info = self.green_pr(target)
        self.assertEqual(self.workflow.gate('feature', info), target)
        with self.assertRaisesRegex(branch.WorkflowError, 'owner'):
            self.workflow.merge('feature')
        for changes in [{'baseRefName': 'codex/baseline'}, {'isDraft': True}, {'headRefOid': '0' * 40}, {'statusCheckRollup': []},
                        {'statusCheckRollup': [{'status': 'IN_PROGRESS', 'conclusion': None}]},
                        {'statusCheckRollup': [{'status': 'COMPLETED', 'conclusion': 'FAILURE'}]}]:
            with self.subTest(changes=changes), self.assertRaises(branch.WorkflowError):
                self.workflow.gate('feature', {**info, **changes})
        (target / 'dirty.txt').write_text('preserve me', encoding='utf-8')
        with self.assertRaisesRegex(branch.WorkflowError, 'dirty'):
            self.workflow.gate('feature', info)
        with self.assertRaisesRegex(branch.WorkflowError, 'Dirty'):
            self.workflow.discard('feature', owner_approved=True)
        self.assertTrue((target / 'dirty.txt').exists())
        (target / 'dirty.txt').unlink()
        (self.root / 'index.html').write_text('changed live', encoding='utf-8')
        with self.assertRaisesRegex(branch.WorkflowError, 'Live tracked'):
            self.workflow.gate('feature', info)
        self.git('add', '.'); self.git('commit', '-m', 'main moved')
        with self.assertRaisesRegex(branch.WorkflowError, 'current local main'):
            self.workflow.gate('feature', info)

    def test_discard_archives_state_and_requires_owner(self):
        target = self.start()
        with self.assertRaisesRegex(branch.WorkflowError, 'owner'):
            self.workflow.discard('feature')
        (target / '.tiksi-state').mkdir()
        (target / '.tiksi-state/project.json').write_text('synthetic private snapshot', encoding='utf-8')
        self.workflow.discard('feature', owner_approved=True)
        self.assertFalse(target.exists())
        archives = list((self.workflow.records / 'archives').glob('*/.tiksi-state/project.json'))
        self.assertEqual(len(archives), 1)
        self.assertEqual(archives[0].read_text(encoding='utf-8'), 'synthetic private snapshot')
        self.assertEqual(self.git('status', '--porcelain'), '')

    def test_discard_never_closes_pr_already_in_main(self):
        target = self.start()
        self.git('remote', 'add', 'origin', 'https://example.com/synthetic.git')
        info = self.green_pr(target)  # identical head already in main
        with patch.object(self.workflow, 'gh') as gh, patch.object(self.workflow, 'pr_info', return_value=info):
            with self.assertRaisesRegex(branch.WorkflowError, 'never close'):
                self.workflow.discard('feature', owner_approved=True)
            self.assertNotIn(('pr', 'close', 'codex/feature'), [tuple(call.args) for call in gh.call_args_list])
        self.assertTrue(target.exists())

    def test_service_dispatch_aggregates_busy_guard_and_closes_both_services(self):
        target = self.start()
        (target / 'server').mkdir(exist_ok=True)
        template = """from pathlib import Path
class SERVICE:
    def __init__(self, state_dir):
        self.state = Path(state_dir)
        self.state.mkdir(parents=True, exist_ok=True)
    def active_jobs(self):
        marker = self.state / 'busy'
        return int(marker.read_text(encoding='utf-8')) if marker.exists() else 0
    def dispatch(self, handler):
        if handler.path != '/api/NAME/mock': return False
        payload = b'NAME'
        handler.send_response(200)
        handler.send_header('Content-Length', str(len(payload)))
        handler.end_headers()
        handler.wfile.write(payload)
        return True
    def close(self):
        (self.state / 'closed').write_text('closed', encoding='utf-8')
"""
        for name, cls in [('reconstruction', 'ReconstructionService'), ('material_research', 'MaterialResearchService')]:
            (target / 'server' / (name + '.py')).write_text(template.replace('SERVICE', cls).replace('NAME', name), encoding='utf-8')
        metadata = self.workflow.serve('feature')
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        for name in ['reconstruction', 'material_research']:
            with opener.open(f'http://localhost:{metadata["port"]}/api/{name}/mock', timeout=2) as response:
                self.assertEqual(response.read().decode('utf-8'), name)
        reconstruction = target / '.tiksi-state/reconstruction'
        research = target / '.tiksi-state/material-research'
        (reconstruction / 'busy').write_text('2', encoding='utf-8')
        (research / 'busy').write_text('3', encoding='utf-8')
        self.assertEqual(self.workflow.probe(metadata)['activeJobs'], 5)
        with self.assertRaisesRegex(branch.WorkflowError, 'active reconstruction'):
            self.workflow.stop('feature')
        self.assertIsNotNone(self.workflow.probe(metadata))
        (reconstruction / 'busy').unlink()
        (research / 'busy').unlink()
        self.workflow.stop('feature')
        self.assertTrue((reconstruction / 'closed').exists())
        self.assertTrue((research / 'closed').exists())

    def add_origin(self):
        remote = Path(self.temp.name) / 'remote.git'
        self.git('init', '--bare', str(remote))
        self.git('remote', 'add', 'origin', str(remote))
        self.git('push', '-u', 'origin', 'main')
        return remote

    def commit_feature(self, target):
        (target / 'index.html').write_text('<html><body>upgraded fixture</body></html>', encoding='utf-8')
        self.git('add', 'index.html', cwd=target)
        self.git('commit', '-m', 'Upgrade synthetic fixture', cwd=target)

    def test_pr_pushes_exact_head_and_is_draft_by_default(self):
        remote = self.add_origin()
        target = self.start()
        self.commit_feature(target)
        with patch.object(self.workflow, 'gh', return_value='https://example.com/pr/1') as gh, patch.object(self.workflow, 'pr_info', return_value=None):
            with self.assertRaisesRegex(branch.WorkflowError, 'body file'):
                self.workflow.pr('feature', body_file='/does/not/exist')
            self.workflow.pr('feature', title='Synthetic upgrade')
            create = next(call.args for call in gh.call_args_list if call.args[:2] == ('pr', 'create'))
            self.assertIn('--draft', create)
        self.assertEqual(self.git('rev-parse', 'codex/feature', cwd=remote), self.git('rev-parse', 'HEAD', cwd=target))
        self.assertEqual(self.git('rev-parse', 'main', cwd=remote), self.git('rev-parse', 'main'))

    def test_authorized_merge_lands_pushes_and_removes_only_spent_worktree(self):
        remote = self.add_origin()
        target = self.start()
        self.commit_feature(target)
        head = self.git('rev-parse', 'HEAD', cwd=target)
        self.git('push', '-u', 'origin', 'codex/feature', cwd=target)
        info = self.green_pr(target)
        def pr_state(*args, **kwargs):
            merged = subprocess.run(['git', 'merge-base', '--is-ancestor', head, 'main'], cwd=self.root).returncode == 0
            return {**info, 'state': 'MERGED' if merged else 'OPEN'}
        with patch.object(self.workflow, 'pr_info', side_effect=pr_state), patch.object(self.workflow, 'gh'):
            self.workflow.merge('feature', owner_approved=True)
        self.assertFalse(target.exists())
        self.assertEqual(self.git('rev-parse', 'main', cwd=remote), self.git('rev-parse', 'main'))
        self.assertIn('upgraded fixture', (self.root / 'index.html').read_text(encoding='utf-8'))
        self.assertEqual(self.git('status', '--porcelain'), '')
        self.assertEqual(len(self.git('rev-list', '--parents', '-n', '1', 'main').split()), 3)

    def test_unknown_flags_and_primary_adoption_rejected(self):
        result = subprocess.run(['python3', str(ROOT / 'scripts/branch.py'), 'serve', 'example', '--unknown'], cwd=self.root, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        with self.assertRaises(branch.WorkflowError): self.workflow.adopt('main')

if __name__ == '__main__': unittest.main()
