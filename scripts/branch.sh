#!/bin/sh
# Portable entry point; all lifecycle rules live in branch.py.
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec python3 "$SCRIPT_DIR/branch.py" "$@"
