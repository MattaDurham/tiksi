#!/usr/bin/env python3
"""Run every Python regression suite in either repository test directory.

Optional tools the tests need (the CAD and photo-placement runtimes) are looked for in this
checkout's private state folder, then in the main checkout's, which branch copies share; an
environment variable already set wins. Every skipped test is printed with its reason, and the
run fails when more tests skip for a reason than scripts/unit-skips.json allows, or a test
skips for a reason it does not list: a skip that grows hides a test that stopped running.
The allowance is kept per system (Linux for the online checks, Darwin for this Mac), and the
merge check reads it from the live checkout's copy of this file's folder, so a branch cannot
raise its own allowance.
"""
import argparse
from collections import Counter
import json
import os
import platform
from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path.cwd().resolve()
HERE = Path(__file__).resolve().parent
RUNTIMES = {'TIKSI_CAD_PYTHON': '.tiksi-state/converters/venv/bin/python',
            'TIKSI_PHOTO_PLACEMENT_PYTHON': '.tiksi-state/photo-placement/venv/bin/python'}


def main_checkout():
    try:
        common = Path(subprocess.check_output(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'],
                                              cwd=ROOT, text=True, stderr=subprocess.DEVNULL).strip())
        return common.parent if common.name == '.git' else None
    except (OSError, subprocess.CalledProcessError):
        return None


def find_runtimes():
    bases = [ROOT] + [b for b in [main_checkout()] if b and b.resolve() != ROOT]
    for name, rel in RUNTIMES.items():
        if os.environ.get(name): continue
        for base in bases:
            if (base / rel).is_file():
                os.environ[name] = str(base / rel)
                break


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--skips', type=Path, default=HERE / 'unit-skips.json', help='the skip allowance file')
    args = parser.parse_args()
    find_runtimes()
    # Script execution puts scripts/ on sys.path; app server packages live at root.
    sys.path.insert(0, str(ROOT))
    suite = unittest.TestSuite()
    for folder in ('test', 'tests'):
        if Path(folder).is_dir():
            suite.addTests(unittest.TestLoader().discover(folder, pattern='test_*.py'))
    result = unittest.TextTestRunner(verbosity=1).run(suite)
    budget_file = args.skips
    data = json.loads(budget_file.read_text(encoding='utf-8')) if budget_file.exists() else {}
    system = platform.system()
    budget = data.get('systems', {}).get(system, {}) if 'systems' in data else data.get('reasons', {})
    reasons = Counter()
    for test, reason in result.skipped:
        print(f'skipped: {test.id()}: {reason}')
        # Reasons with a variable tail (an install hint) are counted by their first words.
        key = next((r for r in budget if reason.startswith(r)), reason)
        reasons[key] += 1
    over = [(r, n) for r, n in reasons.items() if n > budget.get(r, 0)]
    for reason, count in over:
        print(f'error: {count} test(s) skipped because "{reason}", more than the {budget.get(reason, 0)} '
              f'{budget_file.name} allows on {system}', file=sys.stderr)
    if result.skipped: print(f'{len(result.skipped)} skipped: ' + '; '.join(f'{n} {r}' for r, n in reasons.items()))
    return 0 if result.wasSuccessful() and not over else 1


if __name__ == '__main__': sys.exit(main())
