"""Executed by Blender with --factory-startup --disable-autoexec; never run user scripts."""
import json
from pathlib import Path
import sys
import bpy

source, output = map(Path, sys.argv[sys.argv.index('--') + 1:])
if source.suffix.lower() == '.blend':
    bpy.ops.wm.open_mainfile(filepath=str(source), load_ui=False, use_scripts=False)
    if bpy.data.libraries: raise ValueError('Linked Blender libraries must be made local and packed before importing')
    for img in bpy.data.images:
        if img.source == 'FILE' and not img.packed_file and not Path(bpy.path.abspath(img.filepath)).resolve().is_relative_to(source.parent):
            raise ValueError('Blender image is not packed: ' + img.name + '. Use File > External Data > Pack Resources, or include resources in a ZIP.')
else:
    bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete(use_global=False)
    if source.suffix.lower() in {'.usd', '.usda', '.usdc', '.usdz'}:
        bpy.ops.wm.usd_import(filepath=str(source), import_textures_mode='IMPORT', import_textures_dir=str(output.parent / 'textures'))
    elif source.suffix.lower() == '.fbx': bpy.ops.import_scene.fbx(filepath=str(source))
    else: bpy.ops.import_scene.gltf(filepath=str(source))
if output.suffix == '.blend':
    bpy.ops.file.pack_all(); bpy.ops.wm.save_as_mainfile(filepath=str(output))
else:
    bpy.ops.export_scene.gltf(filepath=str(output), export_format='GLB', export_apply=True, export_extras=True, export_animations=False, export_cameras=False, export_lights=False)
print('TIKSI_CONVERSION ' + json.dumps({'warnings': ['Blender evaluated geometry and PBR materials converted; procedural editing stays in the original native file.']}))
