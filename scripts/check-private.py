#!/usr/bin/env python3
"""Reject private paths and obvious credentials in staged or tracked text."""
import argparse
from pathlib import Path
import re
import subprocess
import sys

PRIVATE = re.compile(r'(^|/)(AGENTS\.local\.md|\.tiksi-private-patterns|\.tiksi-state[^/]*|\.tiksi-instance\.json|\.tiksi-preview\.log|\.env(?:\.[^/]+)?|local-data|data|\.worktrees|node_modules)(/|$)|\.(tiksi|sqlite3?|db|pem|key)$', re.I)
SECRETS = [re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),
           re.compile(r'\bgh[pousr]_[A-Za-z0-9]{30,}\b'),
           re.compile(r'\bAKIA[A-Z0-9]{16}\b'),
           re.compile(r'\bsk-(?:proj-)?[A-Za-z0-9_-]{40,}\b')]

def git(*args):
    return subprocess.check_output(['git', *args])

def check(root, staged=False):
    paths = (git('diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z') if staged
             else git('ls-files', '-z')).decode('utf-8').split('\0')
    patterns_file = root / '.tiksi-private-patterns'
    patterns = [line.strip() for line in patterns_file.read_text(encoding='utf-8').splitlines()
                if line.strip() and not line.startswith('#')] if patterns_file.exists() else []
    problems = []
    for path in filter(None, paths):
        if PRIVATE.search(path):
            problems.append(f'{path}: private path must remain ignored')
            continue
        if path.startswith('vendor/'): continue
        try:
            payload = git('show', ':' + path) if staged else (root / path).read_bytes()
            if len(payload) > 2_000_000 or b'\0' in payload: continue
            text = payload.decode('utf-8')
        except (OSError, UnicodeError, subprocess.CalledProcessError): continue
        if any(pattern.search(text) for pattern in SECRETS) or any(pattern in text for pattern in patterns):
            problems.append(f'{path}: possible private identifier or credential (value withheld)')
    return problems

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--staged', action='store_true')
    parser.add_argument('--tree', action='store_true')
    args = parser.parse_args()
    root = Path(git('rev-parse', '--show-toplevel').decode('utf-8').strip())
    problems = check(root, args.staged)
    for problem in problems: print(problem, file=sys.stderr)
    return bool(problems)

if __name__ == '__main__': sys.exit(main())
