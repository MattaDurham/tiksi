#!/bin/sh
set -eu
# Git hooks are shared by linked worktrees. Resolve each commit's own tree.
HOOK_DIR=$(git rev-parse --path-format=absolute --git-path hooks)
mkdir -p "$HOOK_DIR"
if [ -e "$HOOK_DIR/pre-commit" ] && ! grep -q 'Tiksi private-state guard' "$HOOK_DIR/pre-commit"; then
  echo 'Existing pre-commit hook preserved; integrate scripts/check-private.py manually.' >&2
  exit 1
fi
cat > "$HOOK_DIR/pre-commit" <<'HOOK'
#!/bin/sh
# Tiksi private-state guard
set -eu
ROOT=$(git rev-parse --show-toplevel)
exec python3 "$ROOT/scripts/check-private.py" --staged
HOOK
chmod +x "$HOOK_DIR/pre-commit"
echo 'Installed Tiksi staged private-state guard.'
