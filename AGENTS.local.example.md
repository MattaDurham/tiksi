# Tiksi local operating instructions

This file is the public starting template for the git-ignored `AGENTS.local.md`.
The private copy belongs to its installation. Template changes are reviewed
manually; `scripts/agents-local.py diff` shows the differences.

## Code and previews

Work in an isolated `codex/<slug>` worktree. Do not change the live primary
checkout except during an owner-authorized merge. Never stop or restart live
port 8642 or its service. Static changes take effect on reload; server changes
need an owner-authorized restart after landing.

Use `scripts/branch.sh start <slug>` or `adopt [slug]` for existing worktrees.
Use `serve <slug> --fresh --local` for review. `--local` binds loopback only;
previews always default to loopback. Sharing beyond the Mac is an explicit
`--host` choice. Each port has separate browser storage; a preview does not
inherit the live browser's workspace. Transfer a project/workspace bundle with
the app's import tools when the owner requests that, never copy browser stores.
Server runtime is isolated in `.tiksi-state/`. Fresh previews preserve the
previous runtime snapshot; they refuse to interrupt active reconstruction jobs.
Do not refresh a preview hosting an active session.

## Branch handoff

1. Bring the branch up to date with local main in its worktree; resolve conflicts
   there. Run `scripts/preflight.sh` (including browser checks).
2. Serve the current branch with `scripts/branch.sh serve <slug> --fresh --local`.
3. `scripts/branch.sh pr <slug> --title "..." --body-file <file>` pushes the
   branch and creates/updates a draft PR. Branch development requested by the
   owner includes this step. No permission is inferred to push main.
4. Start `gh pr checks <number> --watch` in the background; never wait on it
   before the handoff. Fix, commit, push and recheck failures. Rerun once a
   check that fails on a test your change cannot affect.
5. Report preview URL, behavior changed, branch/PR, completed verification,
   whether online checks are still running, and private state touched. Offer Merge it / Keep testing / Discard when finished.

"Merge it" authorizes the entire landing, run end to end without waiting for
online checks that are still running: update/retest branch, make PR ready, then
`scripts/branch.sh merge <slug> --owner-approved`. The command requires a clean
live main, clean branch, exact PR head and latest main included. A check that
finished without passing (failed, cancelled, timed out) refuses the merge; a
check still running or not yet started only warns. It runs the local preflight,
merges, pushes main, then cleans up if GitHub reads Merged. Then watch main's
checks for the merge in the background and fix main if they fail: with the
branch's checks possibly unfinished, main's run is the one that grades the merge.
When the owner says the checks are not needed (a change to text only, say), add
`--skip-checks`: it ignores the online checks and runs only the seconds-long
syntax and private-state pass. Use it only on the owner's word.
It never restarts the live service. If a step fails, report the actual state and
finish the authorized remaining steps when safe. Never close a PR whose head is
already in main. `discard <slug> --owner-approved` refuses dirty worktrees and
stops only the authenticated preview belonging to that branch.

## Privacy and quality

Save owner projects externally or in ignored `local-data/`. Runtime, exports,
preview logs, screenshot artifacts and `AGENTS.local.md` stay ignored. Install
`sh scripts/install-hooks.sh` to check staged paths and credentials before each
commit; preflight checks the whole tracked tree. Private identifiers can be put
one per line in ignored `.tiksi-private-patterns` for the local guard. This guard
is a backstop; review public commits, PR prose and images yourself.

Use UTF-8 for text reads/writes. Unknown command flags must fail. File imports
must retain original bytes, report unsupported/corrupt files honestly, and
never silently drop assets. Changes to workflow gates apply to later landings;
do not skip existing gates to land a new gate. Use synthetic fixture data and
meaningful assertions of behavior, including failures, not source-text tests.

## This installation

Add private paths, service labels, restart instructions and owner preferences
here. They must not be promoted automatically into the public template.
