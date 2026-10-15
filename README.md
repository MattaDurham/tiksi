# tiksi

An open, local-first design console for renovation and construction programs.
Floorplans to 3D models to materials, products, budgets, schedules and cut sheets,
in one instrument, in the browser, with no frontend build step. An optional local
server adds photo reconstruction and live material research.

The name is Quechua. In the old chronicles the Andean creator god carries the
honorific Apu Qun Tiksi Wiraqucha, and *tiksi* is the word in the middle:
foundation, origin, base. It is the same idea BIM software calls a datum, the
reference frame every level, grid and measurement hangs from. The myth fits the
tool twice over: at Tiwanaku, Viracocha is said to have sculpted humanity as
stone models first, then brought them to life. Model first, then build.

Live app: https://mattadurham.github.io/tiksi/

## What it does

Design side:

- Upload a floorplan image (photo, scan or PDF export) as a tracing underlay,
  or send any site photo to the plan from the photo gallery
- Calibrate real-world scale from any known dimension
- Trace walls with endpoint/axis/angle snapping; place doors and windows; outline rooms.
  Walls are sticky: dragging a wall slides its straight run along its normal and the
  walls, room corners and openings joined to it follow; dragging a corner moves every
  wall end at that joint. Hold Alt (Option) to move one wall on its own
- Generate a 3D model from the plan: solid walls with real openings (headers over
  doors, sills under windows), glazed windows, per-room floor slabs and ceilings
- Render it photoreal: a physical sun and sky driven by time of day and heading,
  image-based lighting, ambient occlusion, real glass with reflections and
  refraction, night mode with interior lights, quality presets down to laptop level
- Edit the model manually: select any wall, floor or ceiling in 3D, change
  thickness, height or material, slide walls with a drag gizmo (joined walls follow),
  delete elements
- Assign building materials from a library of procedural PBR materials (drywall,
  plaster, brick, block, stone, wood, tile, concrete, carpet, siding, marble,
  metal, glass), tune colour, roughness, tile size and grout, or build a
  photo-based material from a close-up of the real surface
- Keep photos with the model: site conditions, reference images and 360
  panoramas in a gallery per property, filtered by room and tagged to walls,
  floors and scope items; pin photos on surfaces in the 3D model one after another
  (PHOTOS > PLACE IN 3D), each linking to the room and wall it lands on; use an
  equirectangular panorama as the sky so light and reflections come from the
  actual site
- Import scans as reference geometry: point clouds (PLY, PCD, XYZ, PTS, LAS),
  meshes (OBJ, STL, GLB/GLTF from phone lidar apps like Polycam or Scaniverse) and
  Gaussian splats (3DGS PLY, .splat, .spz, .ksplat), with colour-by-height,
  point budgets and x-ray mode for alignment
- Import complete OBJ/MTL/texture or glTF/buffer/texture ZIP bundles as portable
  GLBs, preserving normal, roughness, ambient occlusion and emissive maps.
  External dependencies must be bundled; compressed glTF extensions requiring
  Draco, meshopt or Basis, and LAZ, E57, USDZ, FBX and DAE are unsupported.
- Reconstruct a textured 3D object or outdoor scene from overlapping photographs
  on a supported Mac using Apple Object Capture. Originals retain their exact
  bytes. See [photo reconstruction setup and limits](RECONSTRUCTION.md).
- Use Ultra rendering with sharper procedural materials and export independent
  high-resolution PNGs up to the graphics hardware and memory limits.
- Start a property from a Polycam share link, in one step: paste a
  `poly.cam/capture/...` link into NEW PROPERTY (or anywhere in the console, or
  into the address bar as `#/import/<capture id>`) and tiksi fetches the mesh
  straight from Polycam, keeps it as a reference scan, finds every floor level,
  squares the scan up to its walls, renders a calibrated plan underlay from the
  scan for each level, and proposes walls, rooms, doors and windows to correct
  rather than draw, with a starter project carrying the takeoffs
- Multi-level plans: a property has one or more levels, each with its own
  elevation, wall height and underlay; the plan editor works one level at a time,
  the 3D view stacks them with per-level visibility and the section cut
- Scan to plan for any mesh scan already in a property: PROPOSE PLAN FROM SCAN in
  the plan inspector or the 3D scan inspector runs the same pipeline
- Scans are additive: a Polycam link or scan file added to a property that already
  has a plan is fitted against it and offered as the next floor, a rescan that
  replaces the floor it matches, a separate building beside it, or reference only

Program side:

- Capture project ideas, scope them into line items with quantity, unit and
  low/likely/high budget ranges
- Link scope items to model elements (the digital-twin thread: a wall knows which
  scope item rebuilds it, which products are specified for it, and which site
  photos document it)
- Select a material, model element or product to open live sourcing. Run a focused
  web research agent or a specialist team, compare products, fit, suppliers,
  pricing and evidence, and save selections with their original source history.
- Generate printable cut sheets: per scope item (elements, takeoffs, materials,
  site photos, specified products, budget line) and per product
- Run the current-budget report: select and deselect projects against a budget
  cap, roll up by project and category, print it
- Generate a schedule: critical-path method over each project's dependencies,
  rendered as a Gantt chart with float, dependency arrows and a today line

## Running it

The design console works on a static server. Use the included local server for
reconstruction and live research:

```
git clone https://github.com/MattaDurham/tiksi
cd tiksi
python3 tools/serve.py --port 8642
# open http://localhost:8642
```

Or use the hosted copy at the GitHub Pages link above. First run loads a demo
workspace (a generic colonial with a realistic renovation program) so every view
has something to show; replace it with your own property whenever you like.

### Local Mac app and Tailscale

For the local app, run `python3 tools/serve.py --host 0.0.0.0 --port 8642` and
open `http://localhost:8642/` in Chrome. Install Tiksi using the install button
in the address bar to give it its own app window and Dock launcher. This server
serves only the app assets; repository files, saved data, and directory listings
are excluded. Binding to `0.0.0.0` makes the app reachable on the local network
and through the Mac's Tailscale address.

For automatic startup, use your operating system's service manager. Keep the
installation's paths, service label and restart instructions in the private
`AGENTS.local.md` file, rather than in public source code.

With Tailscale connected on both devices and the Mac awake, open
`http://<Mac-Tailscale-IP>:8642/` on your phone. Tailscale Serve can optionally
provide an HTTPS URL once Serve/HTTPS is enabled for the tailnet. The shell and
forms adapt to narrow screens; detailed model editing still benefits from a
desktop. Browser storage and selected project
folders belong to each device: serving the app from the Mac does not sync its
workspace or expose its saved projects. Shared project storage would require a
server API. The hosted GitHub Pages copy and the local copy also have separate
browser storage; use project files or workspace bundles to transfer data.

### Live material and fixture sourcing

Live research needs the included local server and a current Codex CLI signed in
on the server's host. Use `codex login`, then confirm `codex login status`
succeeds. The research screen reports whether the local provider is ready.
The static GitHub Pages app can display saved products but cannot launch agents.

Select a material and click **SOURCE THIS MATERIAL**, select an element in the
model, or use **RESEARCH ALTERNATIVES** on a product. Add a budget, price unit,
region, finish, dimensions and required specifications to the brief. Choose a
focused agent or **Deep specialist team**: three concurrent agents investigate
specifications, suppliers and prices, and alternatives including sustainability
and reviews. You can keep browsing while research runs, return for results, or
cancel it. Up to two research jobs can run at once.

Compare candidates and inspect their cited evidence, vendor offers, fit notes,
conflicts and unknowns before saving them to Products and linking scope items.
Evidence records when a source was retrieved and whether it was opened or only
returned by search. Displayed prices require an opened vendor source with a
matching currency and unit. Claims are extracted by agents, so confirm final
fit and purchasing details with the source. Saving retains the research history
in project files; it does not purchase anything.

## From a Polycam link

Share a capture from Polycam (link sharing on), then hand the link to tiksi:

- paste it into the NEW PROPERTY dialog (the `+` next to the property selector),
  paste it anywhere in the console, or drop it on the window from another tab
- or open `https://mattadurham.github.io/tiksi/#/import/<capture id>` directly
  (`#/import?url=<the link>` works too)

What happens next, in the dialog's step log: Tiksi tries the public edited,
original and raw model artifacts, validates the downloaded model, packs it
into one textured GLB and stored in this browser, along with the capture's cover
image as a site photo. Then scan to plan runs in a Web Worker:

1. Wall direction: an area-weighted histogram of horizontal face normals (mod 90
   degrees) gives the dominant axis; the scan is rotated so walls run square.
2. Levels: peaks in the height histogram of horizontal area are floors and
   ceilings. With a consistently oriented mesh (every phone scan) floors face up
   and ceilings down; otherwise surfaces pair by height alone. A bottom level under
   2.25 m becomes "Basement", a top level without a flat ceiling "Attic".
3. Column coverage: each level is rasterized at 2 cm; every cell carries a bitmask
   of 10 cm height slices that contain vertical geometry. A wall fills nearly every
   slice up to the ceiling, furniture a few, a doorway none.
4. Walls: high-coverage cells that reach the ceiling, filtered to thin straight
   runs (thick blobs are furniture), group into axis-aligned bands; collinear bands
   merge across door-sized gaps, exterior walls also across window-sized gaps
   (glass returns nothing to lidar); ends extend to the perpendicular wall they
   meet.
5. Openings: along each wall, an empty column with floor visible under it is a
   door; on an exterior wall an empty band with wall above it is a window.
6. Rooms: the floor-or-ceiling footprint minus the walls, as connected components,
   traced and simplified to rectilinear polygons snapped to the wall lines.

Every level then gets a top-down orthographic render of the aligned scan, cut at
1.3 m above its floor, as its plan underlay, calibrated by construction; a project
is seeded with flooring, paint and opening takeoffs linked to the elements (prices
blank). Polycam's own viewer for the capture is embedded in the dialog while this
runs. Everything proposed is ordinary plan data afterwards: drag, retype, delete,
undo. Expect to fix a few things by hand: walls behind tall furniture, glass
walls and diagonal walls (only the two main axes are traced) are the usual gaps,
and the underlay makes those edits a matter of dragging a line over a photo.

A link can also join a property that already exists: ADD POLYCAM SCAN in the plan
inspector, POLYCAM LINK in the model's scan list, or the choice the dialog offers
when a link is pasted while a property is open (it starts on the open property when
that property has no plan yet, say one made by name to hold photos first). When the
property already has a plan, the new scan's proposal is turned through the four
right angles and slid onto the existing walls, and scored on how much of its outline
and of its inside walls land on them. The dialog then asks what the scan is, with
the best reading first: the next floor (stacked on top, lined up), a rescan
(rebuilds only the floor it matches), a separate building (placed 3 m beside, on the
same floor), or reference geometry only. This is geometry, not recognition; the
person adding the scan has the last word.

If the direct endpoint has nothing (a capture that is not shared, or one without a
mesh), the dialog falls back to reading the share page for a model file; browsers
refuse to read another site's page unless that site allows it (CORS), so tiksi can
then ask a public relay for the public link (the relay sees the link and returns
the bytes; nothing from your workspace is sent). That fallback is on by default and
can be turned off or pointed at a relay of your own in the dialog. When nothing
gets through, no successful model import is claimed. The dialog explains access,
missing-asset and format failures and accepts a model downloaded from Polycam:
use a GLB or a complete GLTF/OBJ ZIP bundle. The same pipeline runs from there.
A share link does not guarantee public artifact access. Polycam's authenticated
API requires its own account entitlements; Tiksi does not silently reuse browser
credentials.

## Saving, opening and sharing

A property is a project file: `<name>.tiksi` holds the property, its projects,
the products they specify, the custom materials it uses, and every scan and
photo, so it opens anywhere with nothing missing. Three ways to keep it, none of
which needs a server:

- **SAVE (Cmd+S).** In Chrome and Edge the first save asks where; every later
  save writes there silently, and the file is remembered across visits. Other
  browsers download the file. SAVE AS (Cmd+Shift+S) picks a new file. The SAVE
  button carries a dot while the browser copy is ahead of the file.
- **A project folder.** FILE > LINK A PROJECT FOLDER picks a folder once; from
  then on every property is kept there as its own `.tiksi`, rewritten a few
  seconds after each change. Put the folder in iCloud Drive, Dropbox or OneDrive
  and your projects follow you to the next machine, where OPEN FROM FOLDER lists
  them. If the folder holds a newer copy than this browser (you edited elsewhere),
  SAVE turns red and OPEN FROM FOLDER pulls it in rather than overwriting it.
- **A SketchUp mirror.** With a project folder linked and the local server running on a
  Mac with SketchUp installed, every `<name>.tiksi` in the folder gets a `<name>.skp` beside
  it. Walls (with their openings cut), openings, room floors, level tags and plan underlays
  are SketchUp groups that carry their Tiksi ids. Save the `.skp` in SketchUp and Tiksi reads
  it back within seconds: moved, stretched, raised or deleted walls, slid openings, reshaped
  or renamed rooms and copied groups come into the plan. Change the plan in Tiksi and the
  `.skp` is rewritten without touching anything you drew outside the Tiksi groups. If both
  sides changed the same element between syncs, Tiksi keeps its version and FILE > Settings
  lists the conflict. Turn it off there with "Keep a SketchUp mirror".
- **OPEN.** A `.tiksi` from the picker (Cmd+O), dropped on the window, chosen
  from the folder, or hosted anywhere that allows cross-origin reads through
  `#/open?url=<file>` (a raw GitHub or gist URL, a Dropbox direct link). Opening
  a file replaces the property of the same id, so re-opening updates rather than
  duplicates, and everything else in the workspace stays.

The whole workspace still exports as a bundle (.zip) or plain JSON and imports
back, from the same FILE menu.

## Where your data lives

The workspace lives in your browser, plus the files you save. It autosaves to
localStorage; scan files, full-resolution photos, photo thumbnails and plan
underlays go to IndexedDB, so the localStorage copy stays small. Nothing is
uploaded by ordinary editing. Photo reconstruction explicitly sends selected
original photos to this Mac's local server and keeps private job files in ignored
runtime storage. Live sourcing sends only the submitted brief and visible
constraints to web research agents; saved evidence travels in project files.
The code is public; projects, photos, scans and job state stay out of Git.

## How it is built

- One page, vanilla JavaScript ES modules, no build step, no framework
- [three.js](https://threejs.org) (vendored, r185) does the rendering: physically
  based materials, procedural textures generated on the fly, post-processing for
  ambient occlusion and anti-aliasing, a physical sky
- [Spark](https://sparkjs.dev) (vendored, MIT) renders Gaussian splats; it loads
  lazily, only when a property actually contains one
- 2D plan editor on canvas; Gantt and report graphics as inline SVG; cut sheets
  and reports print through the browser
- Bundles are plain ZIP files (fflate, shipped with three.js): a workspace.json,
  a manifest and the original scan and photo bytes
- All lengths stored in meters, displayed in feet/inches or metric; money in USD

The data model deliberately follows BIM thinking in miniature: geometry elements
(walls, openings, rooms) are first-class objects with identity, so scope items,
products, photos and schedules can reference them, the way a Revit element
carries its type, materials and quantities. IFC-class interoperability is on the
roadmap, not faked in v1.

## Development workflow

Tiksi follows the same branch-first review workflow as Vira: one feature branch,
one isolated worktree, one independently served preview, and one draft pull
request. The primary checkout and its port 8642 app stay available during work.
Use the portable shell entry point from any worktree (Python 3.10+ and Node 22+):

```sh
python3 scripts/agents-local.py seed   # private operating rules, preserved on repeat
sh scripts/install-hooks.sh           # staged private-file and credential guard
scripts/branch.sh start better-imports
cd .worktrees/better-imports           # use the absolute path printed by start
npm ci
scripts/branch.sh serve better-imports --fresh --local
scripts/branch.sh list
```

Branches use `codex/<slug>`. New worktrees live under the ignored `.worktrees/`
directory; `adopt [slug]` provisions a worktree created elsewhere. Every command
finds the actual worktree through Git. `serve` prints a `localhost` URL on an
available port from 8643 through 8699. Preview pages show their branch and commit.
Existing previews are reused; `--fresh` stops only that verified branch preview
and archives its previous server runtime before starting a new instance. Active
reconstruction jobs block stop/fresh/discard. The live process is never stopped.

Previews bind loopback by default; `--local` makes that intent explicit. An
explicit `--host 0.0.0.0` exposes a preview on LAN/Tailscale interfaces for phone
review. Each port has its own browser workspace: the live app's browser data is
not copied. Import an owner-approved `.tiksi` project or workspace bundle through
the preview's FILE menu for review with real projects. Preview runtime and logs,
project files and personal operating rules remain ignored by Git. Discard archives
private runtime under Git's private workflow directory before deleting the tree.

After committing and verifying a branch:

```sh
scripts/preflight.sh
scripts/branch.sh pr better-imports --title "Improve imports" --body-file /tmp/pr-body.txt
# Draft by default. Watch all checks, fix failures and push updated commits.
gh pr checks --watch
```

For dependent feature branches, `pr <slug> --base codex/<baseline>` reviews only
that feature's commits; retarget to main and rerun CI before landing.

The owner chooses whether to merge, keep testing or discard. Only the owner's
explicit merge instruction authorizes `pr <slug> --ready` followed by
`merge <slug> --owner-approved`. Landing requires both trees clean, current local
main included, an open ready PR at the exact local commit, successful Linux and
macOS CI, and a local preflight. It merges and pushes main, then removes the spent
worktree only when GitHub confirms Merged. It never restarts the live service.
A failed push leaves the actual local merge visible for recovery. A PR whose head
is in main is never closed. `discard <slug> --owner-approved` rejects dirty trees
and preserves their files rather than offering a force-delete shortcut.

Public instructions live in `AGENTS.md` and `AGENTS.local.example.md`; the
owner's `AGENTS.local.md` is seeded once and never overwritten by template
updates. `python3 scripts/agents-local.py diff` supports deliberate review.

## Testing

Install the pinned test dependencies and browser once. The app itself still has
no build step or runtime npm dependencies:

```sh
npm ci
npx playwright install chromium
npm run check       # syntax and tracked private-state guard
npm test            # Node regressions and isolated Python lifecycle/server tests
npm run test:e2e    # every tools/e2e-*.mjs against temporary test ports
npm run preflight  # all of the above
```

Browser checks use synthetic scans and projects. The runner assigns temporary
ports; tests never bind or stop the live app on 8642. CI runs preflight on macOS
and Linux, installs headless Chromium, and retains screenshots on failure. The
branch lifecycle tests build disposable repositories and verify dirty-tree,
stale-PID, PR-head, CI, merged-PR and preview-service protections without touching
the real main branch, live service or owner projects. `scripts/preflight.sh --list`
names the enforced local checks. Local owner-specific identifiers can be listed
in ignored `.tiksi-private-patterns`; the private guard reports only filenames,
never the matching values.

Additional focused tools remain available:

```sh
node test/scan2plan.test.mjs
node test/project-files.test.mjs
node tools/fixture-room.mjs
node tools/debug-scan2plan.mjs my.glb
```

## Roadmap

- IFC import/export (via web-ifc) so models round-trip with Revit and friends
- PDF floorplan import (pdf.js)
- Automatic wall vectorization from floorplan images
- E57 lidar; scan-to-plan for point clouds and splats (meshes are done), walls off
  the Manhattan grid, stairs
- Roofs, stairs, sections and elevations
- Cost database with per-assembly unit pricing

## Built in public

This tool is built in the open with reviewed branches and pull requests. The
commit history is the build log. Issues and ideas are welcome.

MIT licensed. Vendored three.js retains its own MIT license (THREE-LICENSE.txt),
as does Spark (SPARK-LICENSE.txt).

3D editing, native-file converters, before/after and measured finish estimates are described in [MODEL-EXCHANGE.md](MODEL-EXCHANGE.md). FILE consolidates open/import, project saving, model exchange and settings.
