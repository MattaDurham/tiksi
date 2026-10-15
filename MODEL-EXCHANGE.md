# Capture, edit, estimate

FILE is the home for Open/Import, Save/Save As, 3D exchange and Settings. Imports
add or update matching properties; they do not replace unrelated properties.
Replacement is an explicit Settings → Workspace backup & maintenance action.
Cmd+S and Cmd+O remain available. File drops use the same import dispatcher.

1. Capture a room with Polycam or overlapping photographs. FILE → Import accepts
   capture files, photos and Polycam links. PHOTO TO 3D uses the existing local
   reconstruction engine; MODEL displays meshes, clouds and splats. Use the pin
   tool to attach the original photographs to actual surfaces. Camera positions
   cannot be inferred reliably from ordinary photos without reconstruction poses.
2. FILE → 3D exchange exports the floorplan or a selected imported model to native
   SketchUp/Blender files or GLB. Edit it in the other app and save/export it.
3. Bring back the file, select its prior model (or Tiksi floorplan), and preserve
   the drawing origin. The before model stays saved. BEFORE / AFTER switches the
   3D design while pinned photos and project work remain in the same property.
4. Select the model, inspect surface names/areas, and map finishes to Tiksi's
   material catalog. Original material IDs and exact unique names are recognized
   without replacing the original shader. Explicit material choices change the
   appearance and stay saved in the project.
5. CREATE FINISH ESTIMATE creates scope items from the mapped triangle surface
   areas. Saved, uniquely matched product prices **per square foot** populate the
   estimate and product links. Other units/ambiguous products require a quote in
   Scope. Review coverage, overlaps, waste, labour and pricing in Scope/Budget;
   Sourcing, Products and Cut Sheets hold the material selection/order information.
   Generating a takeoff does not place a purchase or invent supplier pricing.

The native engines are separate local converter processes. They operate on
uploaded copies; no editor document is opened or overwritten. Successful originals
and full texture packages travel in `.tiksi` saves. Private converter history is
separate server state, with downloadable source/log/interpretation handoffs for
Codex or Claude. Delete server copies separately in the File panel.

## Implemented format routes

| Format / application | Into Tiksi | Out of Tiksi | Preservation / interpretation boundary |
| --- | --- | --- | --- |
| SketchUp SKP | Installed C API → GLB | C API → native SKP | Faces including holes, nested placements, names, diffuse textures/UVs, colours, metre conversion. Native output is grouped editable triangle faces. Scenes, guides, dynamic components and PBR extensions remain in original SKP. Front-face materials drive the mesh. |
| Blender BLEND | Installed Blender → GLB | GLB → packed native BLEND | Evaluated geometry/PBR materials; automatic script execution disabled. Linked libraries must be made local. Pack images or include relative resources in one ZIP. Procedural history remains in original BLEND. |
| GLB / glTF 2.0 | Browser; ZIP embeds external buffers/images | Self-contained GLB | Mesh hierarchy, PBR maps, UVs, transforms and recognized Tiksi/IFC/Rhino IDs. Compression uses local Blender when needed. Static design editing; source animations/rigs are retained in original bytes. |
| COLLADA DAE | Browser converter, ZIP for textures | DAE + texture ZIP | Metres from declared units, Y/Z-up, static triangles, diffuse colours/textures and names. Other shading is reduced; X-up needs reinterpretation. |
| Wavefront OBJ | Browser; ZIP includes MTL/maps | OBJ + MTL + texture ZIP | Triangle geometry/normals/UVs/diffuse material data. Output uses metres/Y-up; OBJ has no unit metadata. |
| FBX | Browser → static GLB | Use Blender native / GLB | FBX centimetre-unit factor and Z/Y-up handling, diffuse/normal/emissive maps. Original retains animation and unsupported shading. |
| 3DS | Browser → static GLB | Use OBJ/GLB | Meshes, names and diffuse textures; scale must be checked because units are ambiguous. |
| IFC (Revit/ArchiCAD/Bonsai/etc.) | IfcOpenShell → GLB | IFC4 tessellated building hierarchy | GlobalIds, classes, property sets, measured placement and colours. Tessellation is explicit; BIM relationships/parametric geometry remain in the source. Unsupported element geometry fails with diagnostics instead of silently disappearing. |
| STEP / IGES (CAD solids) | OpenCASCADE → GLB | Use native CAD original + GLB/IFC | Solid/surface tessellation, 0.1 mm deflection; OpenCASCADE millimetres → metres/Z-up conversion. Assembly/history/material reconstruction needs an agent/source CAD app. |
| Rhino 3DM | rhino3dm → GLB | Use GLB/OBJ in Rhino | Saved mesh/render-mesh geometry, object IDs, names, instance placement and diffuse material data. Unmeshed NURBS/curves produce an interpretation handoff; preserve render meshes when saving. |
| DXF | ezdxf surfaces → GLB | Use SketchUp/other app's CAD export | MESH/3DFACE geometry and layers, declared units. Drafting linework produces a coordinate/layer interpretation report; an agent can propose walls after confirming height and relevant layers. |
| E57 | LibE57Format → LAS | Original E57 / LAS | Valid points, scan poses and RGB; scanner photos/channels remain in source. |
| LAZ | laspy/lazrs → uncompressed LAS | Original LAZ / LAS | Decompression retains source channels; display follows Tiksi's existing LAS importer. |
| LAS, PCD, XYZ/PTS | Existing point-cloud importer | Save original capture | GPU display budget does not alter original bytes. Clouds are references until a mesh/plan is reconstructed. |
| PLY | Mesh/cloud/Gaussian detection | Save original or mesh GLB/STL | Vertex colour supported; properties outside the rendered representation remain in source. |
| STL | ASCII/binary mesh import | Binary STL | Geometry only, unitless; output coordinates are metres. |
| SPLAT, SPZ, KSPLAT, SOG, Gaussian PLY | Existing splat renderer | Save original capture | Reference imagery; not fabricated into CAD solids. |
| RVT / DWG and other proprietary native formats without a local reader | Source + diagnostic handoff | Original + host-app bridge | `integrations/` includes SketchUp CAD-to-GLB and Revit IFC export commands. Execute in the licensed authoring app, then import the converted result. No fake geometry or destructive replacement. |

Generic meshes cannot faithfully recreate arbitrary CAD constraints or BIM assemblies.
Use the existing **Propose plan** review to reconstruct walls/rooms/openings, or have
Codex/Claude reinterpret a handoff into reviewed Tiksi elements. Texture/material names
are useful evidence; verified manufacturer/product identity comes from sourcing.

## Local setup

Blender is discovered from PATH or its standard macOS application location. The
SketchUp C API is discovered in installed macOS SketchUp; another SDK library can be
configured with `TIKSI_SKETCHUP_API`. Neither proprietary engine is redistributed.

Install the optional CAD readers into **the branch instance's ignored state**:

```sh
python3 tools/install-converters.py --state-dir .tiksi-state
```

A compatible Python 3.13/3.12 interpreter is selected when available. Dependency
versions are pinned to the tested converter runtime. `TIKSI_CAD_PYTHON` optionally
selects an existing converter-only Python environment. Native conversion needs the
local server; the static browser still handles its supported open mesh formats.

Each upload is limited to 600 MB, expanded ZIPs to 600 MB/10,000 entries; one native
conversion runs at a time, five-minute timeout, up to 20 retained jobs/2 GB history.
On macOS converter processes have no network access and cannot read owner home
files outside their uploaded job, code/runtime and OS temporary space. Source
files, diagnostics, native outputs and dependencies stay outside Git.

## Verification

`tools/e2e-exchange.mjs` exercises actual browser export/import, original archive
retention, mapped material identity, transformed surface takeoff, product links,
File UI on mobile, before/after and agent handoffs. When installed it runs genuine
native SketchUp/Blender and IFC conversions, including textured native SKP. Native
engine checks report skips on hosts without those engines; browser format checks
always run. `test/test_model_conversion.py` checks bounded inputs, service origin/
token requirements, lifecycle and real native SDK geometry when available.

Primary specifications and host APIs:

- [SketchUp C API](https://extensions.sketchup.com/developers/sketchup_c_api/sketchup/index.html)
- [SketchUp GLB interchange](https://help.sketchup.com/en/sketchup/working-gltf-files)
- [SketchUp COLLADA](https://help.sketchup.com/en/sketchup/importing-and-exporting-collada-files)
- [Blender glTF](https://docs.blender.org/manual/en/5.1/addons/import_export/scene_gltf2.html)
- [IfcOpenShell geometry](https://docs.ifcopenshell.org/ifcopenshell-python/geometry_processing.html)
- [Rhino render meshes](https://mcneel.github.io/rhino3dm/python/api/BrepFace.html)
- [LibE57Format Python wrapper](https://github.com/davidcaron/pye57)
- [Khronos glTF specification](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html)
