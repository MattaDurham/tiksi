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
  into the address bar as `#/import?url=...`) and tiksi fetches the capture, keeps
  the model as a reference scan, squares it up to its walls, renders a calibrated
  plan underlay from the scan itself, and proposes walls, rooms, doors and windows
  to correct rather than draw, with a starter project carrying the takeoffs
- Scan to plan for any mesh scan already in a property: PROPOSE PLAN FROM SCAN in
  the plan inspector or the 3D scan inspector runs the same pipeline (floor and
  ceiling levels, wall faces paired into walls with their real thickness, rooms
  from the floor, openings from the gaps in each wall's mid-height profile)

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
- or open `https://mattadurham.github.io/tiksi/#/import?url=<the link>` directly

What happens next, in the dialog's step log: the share page is read for the
capture's title, cover image and model file; the model is downloaded and stored in
this browser; the floor and ceiling are found; the scan is rotated to its dominant
wall direction and lifted so the floor sits at zero; horizontal cuts at five heights
become occupancy grids; long straight runs in the upper cuts become wall faces, pairs
of faces a wall with its measured thickness, single faces a wall of default
thickness on the blind side; the floor is flooded into rooms whose polygons snap to
the wall centrelines; gaps in a wall's mid-height profile become doors (open to the
floor) or windows (wall below the sill); a top-down orthographic render of the
aligned scan becomes the plan underlay, calibrated by construction; a project is
seeded with flooring, paint and opening takeoffs linked to the elements. Polycam's
own viewer for the capture is embedded in the dialog while this runs. Everything
proposed is ordinary plan data afterwards: drag, retype, delete, undo.

Two things can stop the browser short of the model. Polycam's share page may not
name a downloadable file, and browsers refuse to read another site's files unless
that site allows it (CORS). When direct access fails, tiksi can ask a public relay
for the public link (the relay sees the link and returns the bytes; nothing from
your workspace is sent); that is on by default and can be turned off or pointed at
a relay of your own in the dialog. When nothing gets through, the property still
exists with its link and the embedded viewer, and the dialog (and the plan
inspector) take the file you download from Polycam yourself: Download, GLB, drop it
on the box. The same pipeline runs from there.

## Where your data lives

Entirely in your browser. The workspace autosaves to localStorage; scan files and
full-resolution photos go to IndexedDB. Nothing is uploaded anywhere. EXPORT
writes a bundle (.zip) with the workspace JSON plus every scan and photo, so a
property moves to another machine in one file; the JSON-only export is still
there for a light backup. IMPORT restores either. That is the entire privacy
model: the code is public, your house is not.

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
flow has an end-to-end check that runs the real page in headless Chromium against a
mock Polycam share page (direct, relayed, blocked-then-dropped, and deep-linked),
with a synthetic two-room lidar-style capture as the fixture:

```
node tools/fixture-room.mjs             # writes tools/fixtures/room.glb
node tools/e2e-polycam.mjs              # needs Playwright with Chromium
node tools/debug-scan2plan.mjs my.glb   # prints the proposal for any mesh file
```

## Roadmap

- IFC import/export (via web-ifc) so models round-trip with Revit and friends
- PDF floorplan import (pdf.js) and multi-level plans
- Automatic wall vectorization from floorplan images
- E57 lidar; scan-to-plan for point clouds and splats (meshes are done), walls off
  the Manhattan grid, multi-level scans
- Roofs, stairs, sections and elevations
- Assisted product research (agentic lookup into the registry)
- Cost database with per-assembly unit pricing

## Built in public

This tool is being built live, in the open, with Claude as the pair. The commit
history is the build log. Issues and ideas are welcome.

MIT licensed. Vendored three.js retains its own MIT license (THREE-LICENSE.txt),
as does Spark (SPARK-LICENSE.txt).
