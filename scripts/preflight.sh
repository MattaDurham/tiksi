#!/bin/sh
set -eu
if [ "${1:-}" = '--list' ]; then
  echo 'syntax: all application, tool, test and server source parses'
  echo 'private-state: no tracked private files, credentials or configured owner identifiers'
  echo 'unit: Node regressions and isolated Python lifecycle/server tests'
  echo 'browser: all registered Playwright end-to-end checks on temporary ports'
  exit 0
fi
if [ "$#" -ne 0 ]; then echo 'Unknown preflight argument' >&2; exit 1; fi
npm run check
npm test
npm run test:e2e
