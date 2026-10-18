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
- A SketchUp cloud model (`build_model`/`save_model`) changes only by re-running
  its code, so file every saved model's build beside it with
  `python3 scripts/sketchup-build.py archive --project <local-data folder>
  --label <draft>`: `--session` replays the Claude Code hook's journal in
  `local-data/.sketchup-journal/`, `--code` takes builder files, and `--post`
  and `--step` record local post-steps. No hook reminder after `save_model`
  means no journal: save the code you ran to files and use `--code`.
