"""Exercise discovery's server imports from an actual script subprocess."""
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent

class PythonRunnerTests(unittest.TestCase):
    def test_root_server_imports_and_both_test_directories(self):
        with tempfile.TemporaryDirectory(prefix='tiksi-runner-test-') as directory:
            root = Path(directory)
            (root / 'server').mkdir()
            (root / 'server/__init__.py').write_text('', encoding='utf-8')
            (root / 'server/fixture.py').write_text('VALUE = 42\n', encoding='utf-8')
            for folder in ['test', 'tests']:
                (root / folder).mkdir()
                source = 'import unittest\nfrom server.fixture import VALUE\nclass ImportTest(unittest.TestCase):\n    def test_import(self): self.assertEqual(VALUE, 42)\n'
                (root / folder / ('test_' + folder + '_imports.py')).write_text(source, encoding='utf-8')
            result = subprocess.run(['python3', str(ROOT / 'scripts/unit.py')], cwd=root,
                                    text=True, encoding='utf-8', capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('Ran 2 tests', result.stderr)

if __name__ == '__main__': unittest.main()
