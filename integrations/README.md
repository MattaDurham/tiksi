# Host-app bridges

Most files now convert directly in Tiksi. Proprietary formats with a licensed
host-only importer can use these small commands. They export uploaded/current
geometry into Tiksi's implemented interchange formats; they do not invent geometry.
Host application APIs and licenses apply. Neither plugin is installed automatically.

## SketchUp CAD → GLB

Load `sketchup/tiksi_bridge.rb` in SketchUp 2024+ through its Ruby console, or
install it in your user Plugins folder. Extensions → Tiksi offers:

- Convert CAD file to Tiksi GLB: requires an empty document, invokes SketchUp's
  installed CAD importer, exports the converted result, then rolls back the
  import. An unrelated open document is refused and preserved.
- Save current model for Tiksi: explicit export of the active model to GLB.

An agent in the loop can call `TiksiBridge.convert(source_path, output_path)`
inside SketchUp. The resulting GLB opens through Tiksi FILE. CAD support depends
on SketchUp's installed/licensed importer. The Ruby file parses locally; its host
conversion command has not been exercised automatically against SketchUp's GUI.

[SketchUp importer API](https://ruby.sketchup.com/Sketchup/Model.html#import-instance_method)

## Revit → IFC

On a Windows machine with Revit 2025/2026 and .NET 8:

```powershell
dotnet build integrations/revit/Tiksi.Revit.csproj -p:RevitApiDir="C:\Program Files\Autodesk\Revit 2026"
```

Copy `Tiksi.addin.example` to the user Revit Addins directory as `Tiksi.addin` and
replace its Assembly placeholder with the compiled DLL path. Open the desired RVT
in Revit and invoke External Tools → Export for Tiksi. It asks for an IFC output,
exports property sets/base quantities, and rolls back the export transaction so
the source document remains unchanged. Import the IFC in Tiksi to inspect
geometry, GlobalIds, classes, properties and materials.

This bridge is source-level integration: the build and Revit-host execution are
unverified on the macOS development host. It requires the licensed Revit runtime;
Tiksi's IFC reader/writer itself is exercised with the local IfcOpenShell engine.
