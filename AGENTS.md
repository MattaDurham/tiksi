# Tiksi agent instructions

This repository is public. Project files, photos, scans, databases, credentials,
and machine configuration are private and never belong in git.

Before changing code, read `AGENTS.local.md`. If it is missing, seed a private
copy from `AGENTS.local.example.md` with `python3 scripts/agents-local.py seed`.
Instructions live in these AGENTS files; do not add model-specific rule files.

- One line of work uses one `codex/<slug>` branch in its own Git worktree:
  `scripts/branch.sh start <slug>`. An existing worktree can use `adopt`.
- Never edit the primary live checkout or stop/restart its server. Live owns
  port 8642. Branch previews use separate ports starting at 8643.
- Anchor shell commands to the absolute worktree path. Preserve other agents'
  changes and commit only the files you own.
- Run `npm run check`, `npm test`, and relevant browser checks. Tests use
  synthetic projects and temporary directories, never the owner's stores.
- Requests to develop branches authorize commits and draft PRs for that work.
  Landing on main, pushing main, and discarding unmerged work require the
  owner's explicit instruction. Local/private instructions can narrow this.
- Hand over a running preview, a PR, completed CI results, and a clear account
  of private state touched. Watch CI and fix failures yourself.
