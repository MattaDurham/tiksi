#!/usr/bin/env python3
"""Syntax and public-state checks; no real projects or services are touched."""
from pathlib import Path
import ast
import subprocess
import sys

ROOT = Path.cwd()
failed = False
for folder in ['js', 'scripts', 'tools', 'test']:
    for path in sorted((ROOT / folder).glob('*.js')) + sorted((ROOT / folder).glob('*.mjs')):
        result = subprocess.run(['node', '--check', str(path)])
        failed = failed or bool(result.returncode)
for folder in ['scripts', 'tools', 'server', 'test']:
    for path in sorted((ROOT / folder).glob('*.py')):
        try: ast.parse(path.read_text(encoding='utf-8'), filename=str(path))
        except SyntaxError as exc:
            print(exc, file=sys.stderr); failed = True
result = subprocess.run([sys.executable, str(ROOT / 'scripts/check-private.py'), '--tree'])
failed = failed or bool(result.returncode)
sys.exit(failed)
