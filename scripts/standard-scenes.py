#!/usr/bin/env python3
"""Add Tiksi's standard scenes to a SketchUp model, by the rules MODEL uses for saved views
(js/standard-views.js, server/standard_scenes.py): an overview, a plan from above for each
level (parallel, north up, cut 4'-0" above the floor) and one cut-open parallel elevation for
each wall of each room, each elevation with its own section plane.

  python3 scripts/standard-scenes.py SOURCE.skp OUTPUT.skp [--rooms ROOMS.json] [--north DEG]

The rooms come from ROOMS.json ({ north, levels, rooms, walls } in plan metres, see
server/standard_scenes.py), or else from the Tiksi groups of a SketchUp sync file. Running it
again refreshes the scenes it made (ids 'std-...') and leaves every other scene alone. Every
SketchUp build script runs it on the model it saves, so each model has the set.

Needs SketchUp 2025 or later installed on this Mac (for the scenes' section cuts). It never
writes over its source or into a Trimble Connect Sync folder.
"""
import argparse
import ctypes as C
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from server.sketchup_convert import API, Ref  # noqa: E402
from server.standard_scenes import add_standard_scenes, from_sync_file, standard_set  # noqa: E402


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('source', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--rooms', type=Path, help='the building as JSON: { north, levels, rooms, walls }')
    parser.add_argument('--north', type=float, help='degrees north is turned from up the plan (overrides the JSON)')
    args = parser.parse_args(argv)
    source, output = args.source.resolve(), args.output.resolve()
    if not source.is_file(): parser.error(f'{args.source} is not a file')
    if output == source: parser.error('write the scenes into a new file, not over the source')
    if 'Trimble Connect Sync' in output.parts: parser.error('never write into a Trimble Connect Sync folder')
    api = API(); model = Ref(); warnings = []
    try:
        api.call('SUModelCreateFromFile', C.byref(model), os.fsencode(source))
        data = json.loads(args.rooms.read_text(encoding='utf-8')) if args.rooms else from_sync_file(api, model)
        if args.north is not None: data['north'] = args.north
        if not standard_set(data):
            raise SystemExit('No rooms or walls to make the standard scenes from: pass --rooms')
        count = add_standard_scenes(api, model, data, warnings)
        output.parent.mkdir(parents=True, exist_ok=True)
        api.call('SUModelSaveToFile', model, os.fsencode(output))
    finally:
        if model.ptr: api.call('SUModelRelease', C.byref(model))
        api.lib.SUTerminate()
    for w in warnings: print('warning:', w, file=sys.stderr)
    print(f'{count} standard scene{"s" if count != 1 else ""} in {output}')


if __name__ == '__main__':
    main()
