#!/usr/bin/env python3
"""Check that vendor/VERSIONS.json records every bundled library file as it is.

Each library in the record names its version, where it came from and the files it owns, with
a checksum for its main files and one checksum over all of its files together. The check
fails when a file under vendor/ belongs to no library, or when a checksum no longer matches:
a library updated without updating its record.

  check-vendor.py            check the record against vendor/
  check-vendor.py --update   rewrite the checksums from the files (after a deliberate update)
"""
import hashlib
import json
from pathlib import Path
import sys

ROOT = Path.cwd()
VENDOR = ROOT / 'vendor'
RECORD = VENDOR / 'VERSIONS.json'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def owned(library):
    """Files a library owns: its listed files and every file under its listed folders."""
    files = set()
    for item in library['paths']:
        path = VENDOR / item
        if path.is_dir(): files.update(p for p in path.rglob('*') if p.is_file())
        elif path.is_file(): files.add(path)
    return sorted(files)


def tree_sha(files):
    digest = hashlib.sha256()
    for path in files:
        digest.update(path.relative_to(VENDOR).as_posix().encode('utf-8') + b'\0' + sha(path).encode('ascii') + b'\n')
    return digest.hexdigest()


def main():
    args = sys.argv[1:]
    if args not in ([], ['--update']):
        print(f'Unknown argument {args[0]}', file=sys.stderr)
        return 2
    if not VENDOR.is_dir(): return 0
    if not RECORD.is_file():
        print('vendor/VERSIONS.json is missing: every bundled library needs its version recorded', file=sys.stderr)
        return 1
    record = json.loads(RECORD.read_text(encoding='utf-8'))
    problems, claimed = [], set()
    for library in record['libraries']:
        files = owned(library)
        claimed.update(files)
        if args == ['--update']:
            library['files'] = {name: sha(VENDOR / name) for name in library.get('files', {})}
            library['allFiles'] = {'count': len(files), 'sha256': tree_sha(files)}
            continue
        for name, expected in library.get('files', {}).items():
            path = VENDOR / name
            if not path.is_file(): problems.append(f'vendor/{name}: listed for {library["name"]} but missing')
            elif sha(path) != expected:
                problems.append(f'vendor/{name}: changed since {library["name"]} {library["version"]} was recorded')
        summary = library.get('allFiles', {})
        if summary.get('count') != len(files) or summary.get('sha256') != tree_sha(files):
            problems.append(f'{library["name"]}: its files under vendor/ changed since {library["version"]} was recorded '
                            f'({len(files)} files, recorded {summary.get("count")})')
    extra = [p for p in VENDOR.rglob('*') if p.is_file() and p != RECORD and p not in claimed and p.name != '.DS_Store']
    for path in sorted(extra):
        problems.append(f'{path.relative_to(ROOT).as_posix()}: belongs to no library in vendor/VERSIONS.json')
    if args == ['--update']:
        RECORD.write_text(json.dumps(record, indent=2) + '\n', encoding='utf-8')
        print('Rewrote the checksums in vendor/VERSIONS.json; check the versions and sources by hand.')
        return 1 if extra else 0
    for problem in problems: print(problem, file=sys.stderr)
    return 1 if problems else 0


if __name__ == '__main__': sys.exit(main())
