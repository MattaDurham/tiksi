"""The guard checks staged bytes and names, withholding private matches."""
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
    def guard(self):
        return subprocess.run(['python3', str(ROOT / 'scripts/check-private.py'), '--staged'],
                              cwd=self.root, capture_output=True, text=True, encoding='utf-8')
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

if __name__ == '__main__': unittest.main()
