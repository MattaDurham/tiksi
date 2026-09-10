# tiksi

An open, local-first design console for renovation and construction programs.
Floorplans to 3D models to materials, products, budgets, schedules and cut sheets,
in one instrument, in the browser, with no build step and no backend.

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
- Trace walls with endpoint/axis/angle snapping; place doors and windows; outline rooms
- Generate a 3D model from the plan: solid walls with real openings (headers over
  doors, sills under windows), glazed windows, per-room floor slabs and ceilings
- Render it photoreal: a physical sun and sky driven by time of day and heading,
  image-based lighting, ambient occlusion, real glass with reflections and
  refraction, night mode with interior lights, quality presets down to laptop level
- Edit the model manually: select any wall, floor or ceiling in 3D, change
  thickness, height or material, slide walls with a drag gizmo, delete elements
- Assign building materials from a library of procedural PBR materials (drywall,
  plaster, brick, block, stone, wood, tile, concrete, carpet, siding, marble,
  metal, glass), tune colour, roughness, tile size and grout, or build a
  photo-based material from a close-up of the real surface
- Keep photos with the model: site conditions, reference images and 360
  panoramas in a gallery per property, filtered by room and tagged to walls,
  floors and scope items; pin any photo on a surface in the 3D model; use an
  equirectangular panorama as the sky so light and reflections come from the
  actual site
- Import scans as reference geometry: point clouds (PLY, PCD, XYZ, LAS),
  meshes (OBJ, GLB/GLTF from phone lidar apps like Polycam or Scaniverse) and
  Gaussian splats (3DGS PLY, .splat, .spz, .ksplat), with colour-by-height,
  point budgets and x-ray mode for alignment
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

Program side:

- Capture project ideas, scope them into line items with quantity, unit and
  low/likely/high budget ranges
- Link scope items to model elements (the digital-twin thread: a wall knows which
  scope item rebuilds it, which products are specified for it, and which site
  photos document it)
- Research products anywhere, then capture them in a registry with vendor link,
  model number, price and specs
- Generate printable cut sheets: per scope item (elements, takeoffs, materials,
  site photos, specified products, budget line) and per product
- Run the current-budget report: select and deselect projects against a budget
  cap, roll up by project and category, print it
- Generate a schedule: critical-path method over each project's dependencies,
  rendered as a Gantt chart with float, dependency arrows and a today line

## Running it

It is a static page. Any web server works:

```
git clone https://github.com/MattaDurham/tiksi
cd tiksi
python3 -m http.server 8642
# open http://localhost:8642
```

Or use the hosted copy at the GitHub Pages link above. First run loads a demo
workspace (a generic colonial with a realistic renovation program) so every view
has something to show; replace it with your own property whenever you like.

## From a Polycam link

Share a capture from Polycam (link sharing on), then hand the link to tiksi:

- paste it into the NEW PROPERTY dialog (the `+` next to the property selector),
  paste it anywhere in the console, or drop it on the window from another tab
- or open `https://mattadurham.github.io/tiksi/#/import/<capture id>` directly
  (`#/import?url=<the link>` works too)

What happens next, in the dialog's step log: the raw mesh is fetched from the
endpoint Polycam's own viewer uses (`/api/capture/<id>/artifacts/raw.gltf`, which
Polycam's storage serves with open CORS, so no third party is involved), packed
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

If the direct endpoint has nothing (a capture that is not shared, or one without a
mesh), the dialog falls back to reading the share page for a model file; browsers
refuse to read another site's page unless that site allows it (CORS), so tiksi can
then ask a public relay for the public link (the relay sees the link and returns
the bytes; nothing from your workspace is sent). That fallback is on by default and
can be turned off or pointed at a relay of your own in the dialog. When nothing
gets through, the property still exists with its link and the embedded viewer, and
the dialog (and the plan inspector) take the file you download from Polycam
yourself: Download, GLB, drop it on the box. The same pipeline runs from there.

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
- **OPEN.** A `.tiksi` from the picker (Cmd+O), dropped on the window, chosen
  from the folder, or hosted anywhere that allows cross-origin reads through
  `#/open?url=<file>` (a raw GitHub or gist URL, a Dropbox direct link). Opening
  a file replaces the property of the same id, so re-opening updates rather than
  duplicates, and everything else in the workspace stays.

The whole workspace still exports as a bundle (.zip) or plain JSON and imports
back, from the same FILE menu.

## Where your data lives

Entirely in your browser, plus the files you save. The workspace autosaves to
localStorage; scan files, full-resolution photos, photo thumbnails and plan
underlays go to IndexedDB, so the localStorage copy stays small. Nothing is
uploaded anywhere. That is the entire privacy model: the code is public, your
house is not.

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

## Testing

There is no build, and the app has no test framework of its own. The scan-to-plan
core has a dependency-free regression test on a synthetic two-storey house, and
the share-link flow has an end-to-end check that runs the real page in headless
Chromium against a mock Polycam share page (direct, relayed, blocked-then-dropped,
and deep-linked), with a synthetic two-room lidar-style capture as the fixture:

```
node test/scan2plan.test.mjs            # the core: levels, walls, rooms, openings
node test/project-files.test.mjs        # project files: slice one property, merge it back
node tools/fixture-room.mjs             # writes tools/fixtures/room.glb
node tools/e2e-polycam.mjs              # needs Playwright with Chromium
node tools/debug-scan2plan.mjs my.glb   # prints the proposal for any mesh file, in plain Node
```

## Roadmap

- IFC import/export (via web-ifc) so models round-trip with Revit and friends
- PDF floorplan import (pdf.js)
- Automatic wall vectorization from floorplan images
- E57 lidar; scan-to-plan for point clouds and splats (meshes are done), walls off
  the Manhattan grid, stairs
- Roofs, stairs, sections and elevations
- Assisted product research (agentic lookup into the registry)
- Cost database with per-assembly unit pricing

## Built in public

This tool is being built live, in the open, with Claude as the pair. The commit
history is the build log. Issues and ideas are welcome.

MIT licensed. Vendored three.js retains its own MIT license (THREE-LICENSE.txt),
as does Spark (SPARK-LICENSE.txt).
