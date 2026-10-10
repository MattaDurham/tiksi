#!/usr/bin/env python3
"""Seed or compare the private operating file without overwriting owner changes."""
import argparse
import difflib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['seed', 'diff'])
    args = parser.parse_args()
    template, local = ROOT / 'AGENTS.local.example.md', ROOT / 'AGENTS.local.md'
    if args.command == 'seed':
        if local.exists() or local.is_symlink():
            print('AGENTS.local.md already exists; preserved.')
        else:
            with local.open('x', encoding='utf-8') as output:
                output.write(template.read_text(encoding='utf-8'))
            print('Seeded git-ignored AGENTS.local.md; customize its installation section.')
    else:
        if not local.exists():
            parser.error('AGENTS.local.md is missing; run seed first')
        print(''.join(difflib.unified_diff(template.read_text(encoding='utf-8').splitlines(True),
                                         local.read_text(encoding='utf-8').splitlines(True),
                                         fromfile='public template', tofile='private local file')), end='')

if __name__ == '__main__':
    main()
