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

## Onboarding a property with a coding agent

Claude, Codex and other coding agents follow the same process. Start here for a new
property **and** when taking over a partially built one. Read `AGENTS.local.md`
for this installation's project home and operating instructions (seed it as
described below if absent). Read any private AGENTS.md governing that folder
for local templates and source locations. If the session starts inside the private property
folder, explicitly open these files in the Tiksi checkout. The folder importer
collects supported files and can propose a plan. The agent owns the evidence
review and the handoff. Work to the owner's brief. A floor estimate, an existing-condition model
and a fabrication package require different evidence.

1. **Find the property and the current revision.** Record the brief, property ID
   when available, working folder, current bundle and any linked native model.
   Check FILE → Settings for the saved path. Inspect the bundle's property ID,
   plans and build notes before creating another property. Distinguish an owner's
   edited model, an as-built or permit set, a Tiksi mirror, a backup and a
   proposed design. Use revision history, embedded models or content hashes to
   resolve competing copies. Preserve the owner's latest edits and keep a
   restorable baseline before changing an existing build.
2. **Account for the visit.** In the private project folder keep one onboarding
   record, or extend its existing README/evidence ledger. Inventory originals by
   relative path, type, revision and disposition (reviewed, pending, unreadable,
   duplicate with evidence, or outside scope). Include files the app skipped,
   archives and their companion files. Check import warnings and truncated lists.
   Preserve original bytes and scope out unrelated records. For a name-only
   property, record the brief and missing sources and do the work that the brief
   already supports. For a folder or link, retain the capture ID and any raw
   keyframes, poses, depth or confidence data available.
3. **Read the evidence.** Review plans, revisions and room photos. Work through
   walkthroughs for distinct tape readings in MEASURE. Record frame/time, room,
   element, endpoints, units and legibility. Index relevant visit audio by
   timestamp and speaker when known, using an available authorized transcription
   method or marking it pending. Tie each reading or owner observation to its
   source. Preserve conflicting readings and distinguish slab, rough opening,
   finished opening and clear passage. Resolve what the evidence supports and
   group the remaining questions with the specific photo or measurement needed.
4. **Establish the shell before detailing.** Check scale, orientation, north
   when relevant, origin and finished-floor datum against independent controls.
   Check camera poses against the mesh before transferring keyframe coordinates.
   If registration fails, use individual frames for visual evidence and record the limit.
   Save alignment transforms and residuals. Use the scan floor review for mixed
   indoor/outdoor surfaces, porches, slopes, stairs and landings. Check adjacency,
   envelope, soffits, wall faces, ceilings and thresholds room by room. Walk the
   numbered door/window schedule against photos for size, jamb, swing, handing,
   glazing, casing and adjoining space. Include closed, obscured and visibly
   missing elements in the ledger. A plan-only or photo-only intake can stop
   at a calibrated underlay or a partial shell with its gaps recorded.
5. **Reconcile the room and its products.** Use matched photo/scan views and
   sections to check location, elevations, dimensions, collisions and omissions.
   Keep measured, observed, inferred and unknown geometry distinct from installed
   product identity or proposed substitutions. Record source references on the
   model where supported and in the ledger otherwise. Inspect full-resolution
   crops for labels. Record what each label actually establishes about brand,
   model and suffix. Attach the matching spec, installation drawing or manual
   with its page and revision to the product. Check visible service connections
   and keep concealed routes unknown unless documented. Use the whole-space
   product checklist above. Keep finishes per face and light-dependent photo
   colour matches provisional. Use separate existing/proposed tags or iterations
   when exploring design changes. Consult the [evidence and recovery guide](docs/accuracy-and-evidence.md).
6. **Follow the requested work through its outputs.** For scope and pricing,
   link rooms/elements/products to the property project and its subprojects.
   Recheck quantities after a model edit, preserve manual scope, and identify
   allowances, price dates/units, locality and labor assumptions. Use the
   [price book sources](docs/price-book-sources.md). For buildable assemblies
   derive parts from common datums, actual stock and installation interfaces.
   Check dimensions, joins, clearances, waste and assembly sequence against the
   drawings, cut list and order. Use a relevant private template if available
   and refresh its inputs for this job. Label parts by wall, role and position
   as well as mark. Record any required field or trade checks.
7. **Prove the handoff on the saved revision.** File supported findings on the
   property through the normal Tiksi workflow. With an external builder, compare
   its baseline to the latest saved bundle before applying changes. Reconcile
   concurrent edits and preserve IDs, original assets and existing scopes.
   Reopen a copy of the deliverable.
   Check the model against independent source views or tape controls, including
   the largest discrepancy and an obstructed area when present. Record residuals
   and the tolerance appropriate for the intended use. Verify the linked
   photos, documents, products, scope and quantities open and belong to this
   property. For native exchange, read back the actual file, check scenes, tags,
   finishes and editable parts, and document losses using [MODEL-EXCHANGE.md](MODEL-EXCHANGE.md).
   Archive builders and label renderings by view as specified below. Check the
   one-pager, sheets, estimates and client selections against the same revision
   before delivery. A preview can publish to the real client site too. Send only
   when the owner requests publication.

Leave enough in the private record for the next session to resume: source
inventory, current revision and rebuild path, completed checks, open discrepancies,
affected deliverables, and the next action. A useful evidence row is
`room/element | claim | source + page/frame/time | measured/observed/inferred/unknown | model value and difference | decision or next check`.
For example, a tape frame may establish a door leaf width while its rough
opening and hidden framing still need a field check. Update the related
schedule, takeoff and sheets when the measurement changes. Report which uses
the evidence supports and which still depend on a missing source.

## Working on Tiksi

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
- A rendering made from a saved view or a SketchUp scene belongs to that view: file it in the
  project's renders folder with the view's name first (`Kitchen, north wall - walnut.png`), or
  put it on the view in PHOTOS (SAVED VIEW). Tiksi's own RENDER THIS VIEW does this itself.
  The client page shows a rendering only under its view, and only while SEND TO THE LAB has it
  ticked; a rendering on no view is never sent.
- Every rendering of a saved view made outside Tiksi (an image model, a render engine, SketchUp)
  carries that view's label inside the file, so Tiksi files it under the right view by itself:
  save it as PNG or JPEG, then run `python3 scripts/stamp-rendering.py <file> --view-name "<view>"
  --room "<room>" --by "<what made it>"` (add `--property` and `--view` ids when known) before
  filing it in the renders folder. SEND TO THE LAB > a view's COPY LABEL gives the exact command;
  paste it into the request to whatever makes the rendering. `--read` shows a file's label.
- Every SketchUp model a build script saves gets Tiksi's standard scenes (an
  overview, a plan per level, a cut-open elevation per wall of each room) by
  the rules MODEL uses: `python3 scripts/standard-scenes.py <in.skp> <out.skp>
  --rooms <rooms.json>`, filed as a `--post` step.
