#!/usr/bin/env python3
"""Reject private paths and obvious credentials in staged or tracked text, and private words
in what a push makes public: the branch name, commit messages and pull request text.

  check-private.py --staged             the staged files (the pre-commit hook)
  check-private.py --tree               every tracked file
  check-private.py --push BRANCH [--base main] [--text TEXT] [--text-file FILE]
                                        the branch name, the messages of the commits in
                                        BASE..BRANCH, and the given title and body text

The private word list has one word or phrase per line ("#" starts a comment). It is read from
`tiksi-private-patterns` in the Git folder that every branch copy shares, and from
`.tiksi-private-patterns` in this checkout and in the main checkout, so a branch copy made by
scripts/branch.sh sees the same list. Words match however they are cased or joined
("Some Street", some-street, SOME_STREET), in file contents, file paths, the branch name,
commit messages and PR text. Matches are never printed.

On this Mac a missing or empty list fails --tree and --push, naming where the list goes; the
pre-commit check (--staged) only warns. On GitHub's machines (GITHUB_ACTIONS=true) there is no
private list by design, so its absence is only noted.
"""
import os
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

def candidate_files(root):
    """Where a list may be: the shared Git folder first (the place to put it), then this
    checkout and the main checkout."""
    files = []
    try:
        common = Path(git('rev-parse', '--path-format=absolute', '--git-common-dir').decode('utf-8').strip())
        files.append(common / 'tiksi-private-patterns')
        if common.name == '.git': files.append(common.parent / PATTERNS_NAME)
    except (subprocess.CalledProcessError, OSError):
        pass
    files.append(root / PATTERNS_NAME)
    seen, out = set(), []
    for path in files:
        key = path.resolve()
        if key not in seen:
            seen.add(key)
            out.append(path)
    return out

def pattern_files(root):
    return [path for path in candidate_files(root) if path.is_file()]

def missing_list(root):
    """A message when no list holds a word, else None."""
    if load_patterns(root): return None
    where = candidate_files(root)
    found = [p for p in where if p.is_file()]
    state = f'the list at {found[0]} holds no words' if found else 'no private word list was found'
    return (f'{state}; looked in {", ".join(str(p) for p in where)}. Put one private word or phrase '
            f'per line in {where[0]}, which every branch copy reads.')

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
    return names_private(text, patterns)

def names_private(text, patterns):
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
        if names_private(path, patterns):
            problems.append('a file path names a private word; rename the file (path withheld)')
            continue
        if path.startswith('vendor/'): continue
        try:
            payload = git('show', ':' + path) if staged else (root / path).read_bytes()
            if len(payload) > 2_000_000 or b'\0' in payload: continue
            text = payload.decode('utf-8')
        except (OSError, UnicodeError, subprocess.CalledProcessError): continue
        if any(pattern.search(text) for pattern in SECRETS) or names_private(text, patterns):
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
    missing = missing_list(root)
    if missing:
        if os.environ.get('GITHUB_ACTIONS') == 'true' or args.staged:
            print(f'Note: {missing}', file=sys.stderr)
        else:
            problems.append(f'error: {missing} The private-data check cannot pass without it.')
    for problem in problems: print(problem, file=sys.stderr)
    return bool(problems)

if __name__ == '__main__': sys.exit(main())
