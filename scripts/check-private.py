#!/usr/bin/env python3
"""Reject private paths and obvious credentials in staged or tracked text, and private words
in what a push makes public: the branch name, commit messages and pull request text.

  check-private.py --staged             the staged files (the pre-commit hook)
  check-private.py --tree               every tracked file
  check-private.py --push BRANCH [--base main] [--text TEXT] [--text-file FILE]
                                        the branch name, the messages of the commits in
                                        BASE..BRANCH, and the given title and body text

The private word list is `.tiksi-private-patterns`, one word or phrase per line, read from
this checkout and from the main checkout that every branch copy shares, so a branch copy
made by scripts/branch.sh sees the same list. Matches are never printed.
"""
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
PATTERNS_NAME = '.tiksi-private-patterns'

def git(*args):
    return subprocess.check_output(['git', *args])

def pattern_files(root):
    """This checkout's list, then the main checkout's (shared by every linked branch copy)."""
    files = [root / PATTERNS_NAME]
    try:
        common = Path(git('rev-parse', '--path-format=absolute', '--git-common-dir').decode('utf-8').strip())
        if common.name == '.git': files.append(common.parent / PATTERNS_NAME)
        files.append(common / 'tiksi-private-patterns')
    except (subprocess.CalledProcessError, OSError):
        pass
    seen, out = set(), []
    for path in files:
        key = path.resolve()
        if key not in seen and path.is_file():
            seen.add(key)
            out.append(path)
    return out

def load_patterns(root):
    patterns = []
    for path in pattern_files(root):
        patterns += [line.strip() for line in path.read_text(encoding='utf-8').splitlines()
                     if line.strip() and not line.startswith('#')]
    return patterns

def loose(text):
    """Lower case, every run of other characters one space: "12-Synthetic_Lane" -> "12 synthetic lane"."""
    return ' ' + ' '.join(re.findall(r'[a-z0-9]+', text.lower())) + ' '

def private_text(text, patterns):
    """Whether free text names a private word, however it is cased or joined (a branch name
    writes "Some Street" as some-street), or carries a credential."""
    if any(pattern.search(text) for pattern in SECRETS): return True
    flat = loose(text)
    return any(loose(p).strip() and loose(p) in flat for p in patterns)

def check(root, staged=False):
    paths = (git('diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z') if staged
             else git('ls-files', '-z')).decode('utf-8').split('\0')
    patterns = load_patterns(root)
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

def check_push(root, branch, base, texts):
    patterns = load_patterns(root)
    problems = []
    if private_text(branch, patterns):
        problems.append('branch name: names a private word; rename the branch before pushing (value withheld)')
    log = git('log', '--format=%h%x00%B%x01', f'{base}..{branch}').decode('utf-8')
    for entry in filter(None, (item.strip() for item in log.split('\x01'))):
        commit, _, message = entry.partition('\0')
        if private_text(message, patterns):
            problems.append(f'commit {commit}: its message names a private word or credential; reword it before pushing (value withheld)')
    for label, text in texts:
        if private_text(text, patterns):
            problems.append(f'{label}: names a private word or credential (value withheld)')
    return problems

def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--staged', action='store_true')
    parser.add_argument('--tree', action='store_true')
    parser.add_argument('--push', metavar='BRANCH')
    parser.add_argument('--base', default='main')
    parser.add_argument('--text', action='append', default=[])
    parser.add_argument('--text-file', action='append', default=[])
    args = parser.parse_args()
    root = Path(git('rev-parse', '--show-toplevel').decode('utf-8').strip())
    if args.push:
        texts = [('pull request title', t) for t in args.text]
        texts += [(f'pull request text ({Path(f).name})', Path(f).read_text(encoding='utf-8')) for f in args.text_file]
        problems = check_push(root, args.push, args.base, texts)
    else:
        problems = check(root, args.staged)
    for problem in problems: print(problem, file=sys.stderr)
    return bool(problems)

if __name__ == '__main__': sys.exit(main())
