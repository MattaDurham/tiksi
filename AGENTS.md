# Tiksi agent instructions

This repository is public. Project files, photos, scans, databases, credentials,
and machine configuration are private and never belong in git.

Tiksi designs real spaces with real products and buildable assemblies. Ground
products and materials in identifiable manufacturer models, product lines or
specifications that can be sourced for the project. For observed spaces, identify
the actual product where possible; otherwise label the closest purchasable match
as a proposed match, with its evidence and uncertainty. For new work, follow the
owner's brand, price tier, finish, performance and other specification preferences.
Choose products for the space and brief, independently of whether a 3D file exists.

Use [PRODUCT-MODEL-SOURCES.md](PRODUCT-MODEL-SOURCES.md) for its whole-space
checklist, product sources and specification workflow. This applies to electrical
fixtures, outlet covers, light bulbs, trim, windows, siding, roofing and flooring
as well as appliances, plumbing, hardware, furniture and the other listed systems.
Use a suitable existing model of the selected product when available. When
drawing custom geometry, obtain the real product's specifications and details
and model its dimensions, profiles, finishes and installation interfaces accurately.
Keep product identity and specification evidence whether the geometry is imported
or custom-built; distinguish documented facts from inferred details. Preserve
custom build code and keep downloads and project sourcing records private.

Quote every length, height, width, depth, clearance and other dimension to the owner
in feet and inches, to the nearest 1/16": 2'-9 1/2", 8'-0", 3/4". Below 1 ft, inches
alone (33 1/2" may also stay in inches when a tape would read it that way). Areas are
square feet. This covers chat, reports, pages, drawings' notes, PR text and product
specifications: convert a metric source (a spec sheet in mm, a scan in metres) and
give feet and inches first, keeping the source's own figure in parentheses only as
evidence, e.g. 2'-11 7/16" (900 mm). Code, stored data and file formats keep metres.
In the app, lengths show in inches to 1/16" by default; FILE > Settings switches to
millimetres and sets the precision.

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
- Hand over a running preview, a PR, the CI status (finished or still running),
  and a clear account of private state touched. Watch CI and fix failures
  yourself. "Merge it" never waits for checks still running; it stops only on a
  check that already failed, and main's own checks are watched after the push.
- A SketchUp cloud model (`build_model`/`save_model`) changes only by re-running
  its code, so file every saved model's build beside it with
  `python3 scripts/sketchup-build.py archive --project <local-data folder>
  --label <draft>`: `--session` replays the Claude Code hook's journal in
  `local-data/.sketchup-journal/`, `--code` takes builder files, and `--post`
  and `--step` record local post-steps. No hook reminder after `save_model`
  means no journal: save the code you ran to files and use `--code`.
- Every SketchUp model a build script saves gets Tiksi's standard scenes (an
  overview, a plan per level, a cut-open elevation per wall of each room) by
  the rules MODEL uses: `python3 scripts/standard-scenes.py <in.skp> <out.skp>
  --rooms <rooms.json>`, filed as a `--post` step.
