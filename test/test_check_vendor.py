"""The vendor record check fails when a bundled library changes or appears unrecorded."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent

class VendorRecordTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='tiksi-vendor-record-')
        self.root = Path(self.temp.name)
        (self.root / 'vendor/lib/parts').mkdir(parents=True)
        (self.root / 'vendor/lib/lib.min.js').write_text('export const v = 1;\n', encoding='utf-8')
        (self.root / 'vendor/lib/parts/a.js').write_text('export const a = 1;\n', encoding='utf-8')
        record = {'libraries': [{'name': 'Synthetic', 'version': '1.0.0', 'source': 'https://example.com/lib-1.0.0.tgz',
                                 'paths': ['lib'], 'files': {'lib/lib.min.js': ''}}]}
        (self.root / 'vendor/VERSIONS.json').write_text(json.dumps(record), encoding='utf-8')
        self.assertEqual(self.check('--update').returncode, 0)
    def tearDown(self): self.temp.cleanup()
    def check(self, *args):
        return subprocess.run(['python3', str(ROOT / 'scripts/check-vendor.py'), *args], cwd=self.root,
                              capture_output=True, text=True, encoding='utf-8')
    def test_a_recorded_tree_passes(self):
        self.assertEqual(self.check().returncode, 0)
    def test_a_changed_main_file_fails(self):
        (self.root / 'vendor/lib/lib.min.js').write_text('export const v = 2;\n', encoding='utf-8')
        result = self.check()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('vendor/lib/lib.min.js: changed since Synthetic 1.0.0 was recorded', result.stderr)
    def test_a_changed_or_added_part_fails(self):
        (self.root / 'vendor/lib/parts/a.js').write_text('export const a = 2;\n', encoding='utf-8')
        self.assertNotEqual(self.check().returncode, 0)
    def test_a_file_no_library_owns_fails(self):
        (self.root / 'vendor/other.js').write_text('x', encoding='utf-8')
        result = self.check()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('vendor/other.js: belongs to no library', result.stderr)
    def test_the_real_record_matches_the_real_files(self):
        result = subprocess.run(['python3', str(ROOT / 'scripts/check-vendor.py')], cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

if __name__ == '__main__': unittest.main()
