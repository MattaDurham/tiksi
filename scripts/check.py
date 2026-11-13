#!/usr/bin/env python3
"""Syntax, name, vendor and public-state checks; no real projects or services are touched.

  check.py          everything
  check.py --fast   syntax and private data only (the owner said the checks are not needed)

It checks the tree in the current folder with the check scripts beside this file, so the
merge tool can run the live checkout's checks against a branch copy: a branch cannot weaken
the checks that grade it.
"""
from pathlib import Path
import ast
import subprocess
import sys

ROOT = Path.cwd()
HERE = Path(__file__).resolve().parent
args = sys.argv[1:]
if args not in ([], ['--fast']):
    print(f'Unknown argument {args[0]}', file=sys.stderr)
    sys.exit(2)
fast = args == ['--fast']
failed = False
for path in sorted(ROOT.glob('*.js')):
    result = subprocess.run(['node', '--check', str(path)])
    failed = failed or bool(result.returncode)
for folder in ['js', 'scripts', 'tools', 'test', 'tests']:
    for path in sorted((ROOT / folder).glob('*.js')) + sorted((ROOT / folder).glob('*.mjs')):
        result = subprocess.run(['node', '--check', str(path)])
        failed = failed or bool(result.returncode)
for folder in ['scripts', 'tools', 'server', 'test', 'tests']:
    for path in sorted((ROOT / folder).glob('*.py')):
        try: ast.parse(path.read_text(encoding='utf-8'), filename=str(path))
        except SyntaxError as exc:
            print(exc, file=sys.stderr); failed = True
commands = [[sys.executable, str(HERE / 'check-private.py'), '--tree']]
if not fast:
    commands = [['node', str(HERE / 'check-names.mjs')],
                [sys.executable, str(HERE / 'check-names.py')],
                [sys.executable, str(HERE / 'check-vendor.py')]] + commands
for command in commands:
    result = subprocess.run(command, cwd=ROOT)
    failed = failed or bool(result.returncode)
sys.exit(failed)
