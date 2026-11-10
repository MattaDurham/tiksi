"""The guard checks staged bytes and names, withholding private matches."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent

class PrivateGuardTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='tiksi-private-guard-')
        self.root = Path(self.temp.name)
        self.git('init', '-b', 'main')
    def tearDown(self): self.temp.cleanup()
    def git(self, *args):
        subprocess.run(['git', *args], cwd=self.root, check=True, capture_output=True)
    def guard(self, *args, cwd=None, github=False):
        env = {k: v for k, v in os.environ.items() if k != 'GITHUB_ACTIONS'}
        if github: env['GITHUB_ACTIONS'] = 'true'
        return subprocess.run(['python3', str(ROOT / 'scripts/check-private.py'), *(args or ['--staged'])],
                              cwd=cwd or self.root, capture_output=True, text=True, encoding='utf-8', env=env)
    def word_list(self, text='Synthetic Lane\n'):
        path = Path(subprocess.check_output(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'],
                                            cwd=self.root, text=True).strip()) / 'tiksi-private-patterns'
        path.write_text(text, encoding='utf-8')
        return path
    def commit(self, message, cwd=None):
        subprocess.run(['git', '-c', 'user.name=Synthetic Test', '-c', 'user.email=test@example.com',
                        'commit', '--allow-empty', '-qm', message], cwd=cwd or self.root, check=True)
    def stage(self, name, text):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding='utf-8')
        self.git('add', name)
    def test_private_names_rejected_even_if_content_harmless(self):
        self.stage('AGENTS.local.md', 'synthetic notes')
        self.assertNotEqual(self.guard().returncode, 0)
    def test_staged_secret_detected_after_working_copy_cleaned(self):
        value = 'ghp_' + 'A' * 40
        self.stage('settings.js', 'const token = "' + value + '";')
        (self.root / 'settings.js').write_text('const token = null;', encoding='utf-8')
        result = self.guard()
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn(value, result.stderr)
        self.assertIn('settings.js', result.stderr)
    def test_custom_private_identifier_and_clean_code(self):
        self.stage('app.js', 'export const title = "Tiksi";')
        self.assertEqual(self.guard().returncode, 0)
        (self.root / '.tiksi-private-patterns').write_text('Synthetic Owner Identifier\n', encoding='utf-8')
        self.stage('app.js', 'const label = "Synthetic Owner Identifier";')
        result = self.guard()
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('Synthetic Owner Identifier', result.stderr)
    def test_deleted_secret_does_not_block_removal(self):
        self.git('config', 'user.name', 'Synthetic Test')
        self.git('config', 'user.email', 'test@example.com')
        self.stage('example.txt', 'ghp_' + 'B' * 40)
        self.git('commit', '-m', 'synthetic historical secret')
        self.git('rm', 'example.txt')
        self.assertEqual(self.guard().returncode, 0)

    def test_push_reads_branch_name_commit_messages_and_pr_text(self):
        (self.root / '.tiksi-private-patterns').write_text('Synthetic Lane\n', encoding='utf-8')
        self.commit('Root')
        self.git('checkout', '-qb', 'codex/plain')
        self.commit('Plain change')
        self.assertEqual(self.guard('--push', 'codex/plain').returncode, 0)
        body = self.root / 'body.md'
        body.write_text('Floors for 12 Synthetic Lane.\n', encoding='utf-8')
        for args in (['--text', 'Kitchen at synthetic-lane'], ['--text-file', str(body)]):
            result = self.guard('--push', 'codex/plain', *args)
            self.assertNotEqual(result.returncode, 0, args)
            self.assertNotIn('ynthetic', result.stderr)
        self.commit('Measure the hall at SYNTHETIC_LANE')
        result = self.guard('--push', 'codex/plain')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('commit ', result.stderr)
        self.assertNotIn('SYNTHETIC', result.stderr)
        self.git('checkout', '-qb', 'codex/12-synthetic-lane', 'main')
        result = self.guard('--push', 'codex/12-synthetic-lane')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('branch name', result.stderr)
        # Commits already in main are not graded again: only what this push adds.
        self.git('checkout', '-q', 'main')
        self.commit('Older message naming Synthetic Lane')
        self.git('checkout', '-qb', 'codex/later')
        self.commit('Plain later change')
        self.assertEqual(self.guard('--push', 'codex/later').returncode, 0)
    def test_a_branch_copy_reads_the_main_checkouts_word_list(self):
        self.commit('Root')
        (self.root / '.gitignore').write_text('.worktrees/\n.tiksi-private-patterns\n', encoding='utf-8')
        self.git('add', '.gitignore')
        self.commit('Ignore')
        copy = self.root / '.worktrees' / 'feature'
        self.git('worktree', 'add', '-qb', 'codex/feature', str(copy))
        (copy / 'notes.js').write_text('export const where = "Synthetic Lane";\n', encoding='utf-8')
        subprocess.run(['git', 'add', 'notes.js'], cwd=copy, check=True)
        self.assertEqual(self.guard('--staged', cwd=copy).returncode, 0)
        (self.root / '.tiksi-private-patterns').write_text('Synthetic Lane\n', encoding='utf-8')
        self.assertNotEqual(self.guard('--staged', cwd=copy).returncode, 0)
        self.commit('A Synthetic Lane fix', cwd=copy)
        self.assertNotEqual(self.guard('--push', 'codex/feature', cwd=copy).returncode, 0)

    def test_no_word_list_fails_the_tree_and_push_checks_on_this_mac_only(self):
        self.stage('app.js', 'export const title = "Tiksi";')
        self.commit('Root')
        for args in (['--tree'], ['--push', 'main', '--base', 'main']):
            result = self.guard(*args)
            self.assertNotEqual(result.returncode, 0, args)
            self.assertIn('no private word list was found', result.stderr)
            self.assertIn('tiksi-private-patterns', result.stderr)
            # GitHub's machines have no private list by design: noted, not failed.
            online = self.guard(*args, github=True)
            self.assertEqual(online.returncode, 0, online.stderr)
            self.assertIn('Note: no private word list was found', online.stderr)
        self.assertEqual(self.guard('--staged').returncode, 0)
        listed = self.word_list('# only a comment\n')
        result = self.guard('--tree')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('holds no words', result.stderr)
        listed.write_text('Synthetic Lane\n', encoding='utf-8')
        self.assertEqual(self.guard('--tree').returncode, 0)
    def test_file_contents_and_paths_match_however_written(self):
        self.word_list()
        self.stage('notes.js', 'export const where = "12 SYNTHETIC-lane";')
        result = self.guard('--staged')
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('SYNTHETIC', result.stderr)
        self.git('rm', '-q', '--cached', 'notes.js')
        self.stage('plans/synthetic_lane_floor.md', 'plain text')
        result = self.guard('--staged')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('a file path names a private word', result.stderr)
        self.assertNotIn('synthetic_lane', result.stderr)
        self.git('rm', '-q', '--cached', 'plans/synthetic_lane_floor.md')
        self.stage('plans/kitchen.md', 'synthetically plain')
        self.assertEqual(self.guard('--staged').returncode, 0)

if __name__ == '__main__': unittest.main()
