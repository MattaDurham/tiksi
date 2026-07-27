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

Live app: https://helladuckets.github.io/tiksi/

## What it does

Design side:

- Upload a floorplan image (photo, scan or PDF export) as a tracing underlay
- Calibrate real-world scale from any known dimension
- Trace walls with endpoint/axis/angle snapping; place doors and windows; outline rooms
- Generate a 3D model from the plan: solid walls with real openings (headers over
  doors, sills under windows), glazed windows, per-room floor slabs
- Edit the model manually: select any wall or floor in 3D, change thickness,
  height or material, slide walls with a drag gizmo, delete elements
- Import lidar scans (PLY point clouds, OBJ, GLB/GLTF from phone apps like
  Polycam or Scaniverse) as reference geometry, with x-ray mode for alignment
- Assign building materials from a library, or add custom ones

Program side:

- Capture project ideas, scope them into line items with quantity, unit and
  low/likely/high budget ranges
- Link scope items to model elements (the digital-twin thread: a wall knows which
  scope item rebuilds it, and which products are specified for it)
- Research products anywhere, then capture them in a registry with vendor link,
  model number, price and specs
- Generate printable cut sheets: per scope item (elements, takeoffs, materials,
  specified products, budget line) and per product
- Run the current-budget report: select and deselect projects against a budget
  cap, roll up by project and category, print it
- Generate a schedule: critical-path method over each project's dependencies,
  rendered as a Gantt chart with float, dependency arrows and a today line

## Running it

It is a static page. Any web server works:

```
git clone https://github.com/Helladuckets/tiksi
cd tiksi
python3 -m http.server 8642
# open http://localhost:8642
```

Or use the hosted copy at the GitHub Pages link above. First run loads a demo
workspace (a generic colonial with a realistic renovation program) so every view
has something to show; replace it with your own property whenever you like.

## Where your data lives

Entirely in your browser. The workspace autosaves to localStorage; lidar scan
files go to IndexedDB. Nothing is uploaded anywhere. EXPORT writes the whole
workspace to a JSON file you own; IMPORT restores it. That is the entire privacy
model: the code is public, your house is not.

## How it is built

- One page, vanilla JavaScript ES modules, no build step, no framework
- [three.js](https://threejs.org) (vendored, r185) is the only runtime dependency
- 2D plan editor on canvas; Gantt and report graphics as inline SVG; cut sheets
  and reports print through the browser
- All lengths stored in meters, displayed in feet/inches or metric; money in USD

The data model deliberately follows BIM thinking in miniature: geometry elements
(walls, openings, rooms) are first-class objects with identity, so scope items,
products and schedules can reference them, the way a Revit element carries its
type, materials and quantities. IFC-class interoperability is on the roadmap, not
faked in v1.

## Roadmap

- IFC import/export (via web-ifc) so models round-trip with Revit and friends
- PDF floorplan import (pdf.js) and multi-level plans
- Automatic wall vectorization from floorplan images
- E57/LAS lidar formats; scan-to-plan assisted tracing
- Roofs, stairs, sections and elevations
- Assisted product research (agentic lookup into the registry)
- Cost database with per-assembly unit pricing

## Built in public

This tool is being built live, in the open, with Claude as the pair. The commit
history is the build log. Issues and ideas are welcome.

MIT licensed. Vendored three.js retains its own MIT license (THREE-LICENSE.txt).
