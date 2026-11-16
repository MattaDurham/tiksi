#!/usr/bin/env python3
"""Write a saved view's label into a rendering, so Tiksi files it under that view.

Run it on every rendering of a saved view made outside Tiksi (an image model, a render engine,
SketchUp) before filing it in the project folder's renders folder. Tiksi reads the label when it
lists the folder and puts the rendering on the view: by the view's id, else its name, else the
room (see server/rendering_stamp.py). In Tiksi, SEND TO THE LAB > a view's COPY LABEL gives the
exact command for that view.

  python3 scripts/stamp-rendering.py "Living - walnut.png" --view-name "Living" --room "Living" --by "image model"
  python3 scripts/stamp-rendering.py render.jpg --property prop-1 --view sv-2 --view-name "Kitchen, north wall"
  python3 scripts/stamp-rendering.py render.png --read

PNG and JPEG only. The file is rewritten in place (or to --out); its picture is not changed, and
any metadata it had is kept."""
import argparse
import datetime
import json
import os
from pathlib import Path
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server.rendering_stamp import FIELDS, StampError, read_label, stamp_bytes  # noqa: E402


def main(argv=None):
    ap = argparse.ArgumentParser(description='Write (or read) the saved-view label a rendering carries for Tiksi.')
    ap.add_argument('files', nargs='+', type=Path, help='the rendering file(s), PNG or JPEG')
    ap.add_argument('--read', action='store_true', help='print the label each file carries, and change nothing')
    ap.add_argument('--property', help="the property's id in Tiksi")
    ap.add_argument('--property-name', help="the property's name")
    ap.add_argument('--view', help="the saved view's id in Tiksi")
    ap.add_argument('--view-name', help="the saved view's name, as Tiksi shows it")
    ap.add_argument('--room', help='the room the view looks at')
    ap.add_argument('--by', help='what made the rendering (a model, an engine, a person)')
    ap.add_argument('--rendered-at', help='when it was made (ISO 8601); now when left out')
    ap.add_argument('--out', type=Path, help='write the labelled copy here instead of changing the file (one file only)')
    a = ap.parse_args(argv)
    if a.read:
        for f in a.files: print(json.dumps({'file': str(f), 'label': read_label(f)}))
        return 0
    if a.out and len(a.files) != 1: ap.error('--out takes one file')
    label = {'property': a.property, 'propertyName': a.property_name, 'view': a.view, 'viewName': a.view_name, 'room': a.room, 'by': a.by,
             'renderedAt': a.rendered_at or datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}
    if not (a.view or a.view_name or a.room): ap.error('give the view (--view or --view-name) or the room (--room)')
    label = {k: v for k, v in label.items() if v}
    failed = 0
    for f in a.files:
        try:
            out = stamp_bytes(f.read_bytes(), label)
            target = a.out or f
            with tempfile.NamedTemporaryFile(dir=target.parent, prefix='.' + target.name + '.', delete=False) as tmp: tmp.write(out)
            if target.exists(): os.chmod(tmp.name, target.stat().st_mode & 0o777)
            os.replace(tmp.name, target)
            print(json.dumps({'file': str(target), 'label': {k: label[k] for k in FIELDS if k in label}}))
        except (OSError, StampError) as e:
            failed += 1
            print(f'{f}: {e}', file=sys.stderr)
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
