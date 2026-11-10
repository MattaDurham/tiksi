#!/bin/sh
set -eu
# The checks beside this file grade the tree in the current folder. The merge tool runs the
# live checkout's copy of this file inside the branch copy, so a branch cannot weaken the
# syntax, name and private-state checks or the allowance of skipped tests that grade it; the
# unit tests themselves are the branch's own.
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ "${1:-}" = '--list' ]; then
  echo 'syntax: all application, tool, test and server source parses'
  echo 'names: every import resolves and every name used is defined (app, tools, tests, Python)'
  echo 'private-state: no tracked private files, credentials or configured owner identifiers'
  echo 'unit: Node regressions and isolated Python lifecycle/server tests'
  echo 'open: the app opens once in a windowless browser with no page errors (--merge)'
  echo 'browser: all registered Playwright end-to-end checks on temporary ports (not with --merge)'
  exit 0
fi
if [ "${1:-}" = '--fast' ]; then
  # The owner skipped the checks: keep only the seconds-long syntax and private-state pass.
  python3 "$HERE/check.py" --fast
  exit 0
fi
if [ "${1:-}" = '--merge' ]; then
  # The merge into main: syntax, names, private state, unit tests and one browser open of the
  # app. The full browser checks run in main's online checks after the push.
  python3 "$HERE/check.py"
  node --test --test-concurrency=1 test/*.test.mjs
  python3 "$HERE/unit.py"
  node "$HERE/smoke-open.mjs"
  exit 0
fi
if [ "$#" -ne 0 ]; then echo 'Unknown preflight argument' >&2; exit 1; fi
python3 "$HERE/check.py"
npm test
npm run test:e2e
