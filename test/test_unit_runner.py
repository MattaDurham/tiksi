"""The Python test runner names every skip and fails when skips grow past the allowance."""
import json
import platform
import shutil
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent

SUITE = '''import os, unittest
class Synthetic(unittest.TestCase):
    def test_runs(self): self.assertTrue(True)
    @unittest.skipUnless(os.environ.get('SYNTHETIC_TOOL'), 'Synthetic tool not installed')
    def test_needs_tool(self): pass
    @unittest.skipUnless(os.environ.get('SYNTHETIC_TOOL'), 'Synthetic tool not installed')
    def test_needs_tool_too(self): pass
'''

class UnitRunnerTests(unittest.TestCase):
    def run_unit(self, allowance):
        with tempfile.TemporaryDirectory(prefix='tiksi-unit-runner-') as temp:
            root = Path(temp)
            (root / 'test').mkdir()
            (root / 'test/test_synthetic.py').write_text(SUITE, encoding='utf-8')
            skips = root / 'skips.json'
            skips.write_text(json.dumps({'systems': {platform.system(): allowance, 'Plan9': {'Synthetic tool not installed': 99}}}), encoding='utf-8')
            return subprocess.run(['python3', str(ROOT / 'scripts/unit.py'), '--skips', str(skips)], cwd=root,
                                  capture_output=True, text=True, encoding='utf-8')

    def test_skips_within_the_allowance_pass_and_are_named(self):
        result = self.run_unit({'Synthetic tool not installed': 2})
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('skipped: test_synthetic.Synthetic.test_needs_tool: Synthetic tool not installed', result.stdout)

    def test_more_skips_than_allowed_fail(self):
        result = self.run_unit({'Synthetic tool not installed': 1})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('2 test(s) skipped because "Synthetic tool not installed", more than the 1', result.stderr)

    def test_a_skip_for_an_unlisted_reason_fails(self):
        result = self.run_unit({})
        self.assertNotEqual(result.returncode, 0)

    def test_the_allowance_beside_the_runner_wins_over_the_branchs_own(self):
        # The merge check runs the live checkout's runner inside the branch copy.
        with tempfile.TemporaryDirectory(prefix='tiksi-unit-live-') as temp:
            live, copy = Path(temp) / 'live', Path(temp) / 'copy'
            (live / 'scripts').mkdir(parents=True)
            shutil.copy(ROOT / 'scripts/unit.py', live / 'scripts/unit.py')
            (live / 'scripts/unit-skips.json').write_text(json.dumps({'systems': {platform.system(): {}}}), encoding='utf-8')
            (copy / 'test').mkdir(parents=True)
            (copy / 'scripts').mkdir()
            (copy / 'test/test_synthetic.py').write_text(SUITE, encoding='utf-8')
            (copy / 'scripts/unit-skips.json').write_text(json.dumps({'systems': {platform.system(): {'Synthetic tool not installed': 9}}}), encoding='utf-8')
            result = subprocess.run(['python3', str(live / 'scripts/unit.py')], cwd=copy, capture_output=True, text=True, encoding='utf-8')
            self.assertNotEqual(result.returncode, 0, result.stdout)

    def test_unknown_flags_fail(self):
        result = subprocess.run(['python3', str(ROOT / 'scripts/unit.py'), '--bogus'], cwd=ROOT, capture_output=True)
        self.assertNotEqual(result.returncode, 0)

if __name__ == '__main__': unittest.main()
