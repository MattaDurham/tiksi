"""SketchUp mirror: wall elevation loops always; real SKP write/edit/read with the SDK."""
import ctypes as C
import copy
import json
import math
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile

from server.sketchup_convert import library_path
from server.sketchup_mirror import wall_loops, extrude_wall
from server.model_conversion import ModelConversionService, ConversionError

WORKER = Path(__file__).resolve().parent.parent / 'server/sketchup_mirror.py'

# A synthetic 4 x 3 m room on one level: four walls, a door and a window on the south wall.
SPEC = {
    'format': 'tiksi-sketchup-mirror', 'version': 1,
    'property': {'id': 'prop-synthetic', 'name': 'Synthetic room'},
    'levels': [{'id': 'lvl-0', 'name': 'Main level', 'elevation': 0, 'height': 2.5}],
    'walls': [
        {'id': 'w-s', 'level': 'lvl-0', 'ax': 0, 'ay': 0, 'bx': 4, 'by': 0, 'thickness': 0.1, 'height': 2.5, 'elevation': 0,
         'holes': [{'id': 'o-door', 'type': 'door', 't': 0.25, 'width': 0.9, 'height': 2.0, 'sill': 0, 's0': 0.55, 's1': 1.45, 'v0': 0, 'v1': 2.0},
                   {'id': 'o-win', 'type': 'window', 't': 0.75, 'width': 1.0, 'height': 1.2, 'sill': 0.9, 's0': 2.5, 's1': 3.5, 'v0': 0.9, 'v1': 2.1}]},
        {'id': 'w-e', 'level': 'lvl-0', 'ax': 4, 'ay': 0, 'bx': 4, 'by': 3, 'thickness': 0.1, 'height': 2.5, 'elevation': 0, 'holes': []},
        {'id': 'w-n', 'level': 'lvl-0', 'ax': 4, 'ay': 3, 'bx': 0, 'by': 3, 'thickness': 0.1, 'height': 2.5, 'elevation': 0, 'holes': []},
        {'id': 'w-w', 'level': 'lvl-0', 'ax': 0, 'ay': 3, 'bx': 0, 'by': 0, 'thickness': 0.1, 'height': 2.5, 'elevation': 0, 'holes': []},
    ],
    'rooms': [{'id': 'r-1', 'level': 'lvl-0', 'name': 'Studio', 'elevation': 0, 'pts': [[0, 0], [4, 0], [4, 3], [0, 3]]}],
    'underlays': [],
}

# The same room with finishes, as mirrorSpec resolves them: sage inside the south wall,
# brick outside, drywall elsewhere, an oak floor, trim doors and glass windows.
SAGE = {'id': 'mat-sage', 'name': 'Sage paint', 'color': '#8fa58a'}
BRICK = {'id': 'mat-brick', 'name': 'Brick, red', 'color': '#9c4a3a'}
DRYWALL = {'id': 'mat-drywall', 'name': 'Drywall, painted', 'color': '#d8d4cc'}
OAK = {'id': 'mat-oak', 'name': 'White oak flooring', 'color': '#c9a06a'}
TRIM = {'id': 'mat-trim', 'name': 'Trim, painted semi-gloss', 'color': '#f4f2ec'}
GLASS = {'id': 'mat-glass', 'name': 'Glass, clear', 'color': '#d2e7ee'}


def finished(sage=SAGE):
    spec = copy.deepcopy(SPEC)
    for w in spec['walls']:
        w['materials'] = {'pos': dict(sage if w['id'] == 'w-s' else DRYWALL), 'neg': dict(BRICK), 'other': dict(BRICK)}
        for h in w['holes']:
            h['material'] = dict(GLASS if h['type'] == 'window' else TRIM)
    spec['rooms'][0]['material'] = dict(OAK)
    return spec


def rgb(hex_color):
    return tuple(int(hex_color[i:i + 2], 16) for i in (1, 3, 5))


class WallLoopTests(unittest.TestCase):
    def test_plain_wall_is_one_rectangle(self):
        loops = wall_loops(4, 2.5, [])
        self.assertEqual(loops, [([(0.0, 0.0), (4, 0.0), (4, 2.5), (0.0, 2.5)], [])])

    def test_door_notches_and_window_is_inner_loop(self):
        (outer, inners), = wall_loops(4, 2.5, SPEC['walls'][0]['holes'])
        self.assertIn((0.55, 2.0), outer)
        self.assertEqual(len(inners), 1)
        self.assertEqual(sorted(inners[0]), [(2.5, 0.9), (2.5, 2.1), (3.5, 0.9), (3.5, 2.1)])

    def test_full_height_opening_splits_wall(self):
        loops = wall_loops(4, 2.5, [{'s0': 1, 's1': 2, 'v0': 0, 'v1': 2.5}])
        self.assertEqual([(o[0][0], o[1][0]) for o, _ in loops], [(0.0, 1), (2, 4)])

    def test_extrusion_has_front_back_and_sides(self):
        points, faces = extrude_wall(wall_loops(4, 2.5, []), 0.1)
        self.assertEqual(len(points), 8)
        self.assertEqual(len(faces), 6)


@unittest.skipUnless(library_path(), 'SketchUp SDK not installed')
class NativeMirrorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def run_worker(self, op, folder):
        r = subprocess.run([sys.executable, str(WORKER), op, str(folder)], capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(r.stdout.strip().splitlines()[-1])

    def write(self, spec, existing=None):
        job = self.root / ('write-' + str(len(list(self.root.iterdir()))))
        job.mkdir()
        (job / 'mirror.json').write_text(json.dumps(spec))
        if existing:
            shutil.copy(existing, job / 'existing.skp')
        self.run_worker('write', job)
        return job / 'model.skp'

    def read(self, skp):
        job = self.root / ('read-' + str(len(list(self.root.iterdir()))))
        job.mkdir()
        shutil.copy(skp, job / 'source.skp')
        self.run_worker('read', job)
        return json.loads((job / 'mirror-read.json').read_text())

    def test_round_trip_reads_back_what_was_written(self):
        got = self.read(self.write(SPEC))
        self.assertEqual(got['model']['propertyId'], 'prop-synthetic')
        self.assertEqual(sorted(w['id'] for w in got['walls']), ['w-e', 'w-n', 'w-s', 'w-w'])
        for w in got['walls']:
            for k in ('ax', 'ay', 'bx', 'by', 'thickness', 'height'):
                self.assertAlmostEqual(w['now'][k], w['base'][k], places=4, msg=w['id'] + ' ' + k)
        south = next(w for w in got['walls'] if w['id'] == 'w-s')
        self.assertEqual(sorted(o['id'] for o in south['openings']), ['o-door', 'o-win'])
        for o in south['openings']:
            for k in ('t', 'width', 'height', 'sill'):
                self.assertAlmostEqual(o['now'][k], o['base'][k], places=4, msg=o['id'] + ' ' + k)
        room, = got['rooms']
        self.assertEqual(room['now']['name'], 'Studio')
        self.assertEqual(sorted(map(tuple, room['now']['pts'])), sorted(map(tuple, room['base']['pts'])))
        self.assertEqual(got['untagged'], {'faces': 0, 'groups': 0, 'instances': 0})

    def test_sketchup_edits_are_read_and_rewrite_keeps_sketchup_geometry(self):
        skp = self.write(SPEC)
        edited = self.root / 'edited.skp'
        edit_like_sketchup(skp, edited)
        got = self.read(edited)
        east = [w for w in got['walls'] if w['id'] == 'w-e']
        self.assertEqual(len(east), 2, 'the copied wall keeps its id; the browser renames the copy')
        moved = min(east, key=lambda w: w['now']['ax'])
        self.assertAlmostEqual(moved['now']['ax'], 4.0, places=4)
        copy = max(east, key=lambda w: w['now']['ax'])
        self.assertAlmostEqual(copy['now']['ax'], 5.0, places=4)
        north = next(w for w in got['walls'] if w['id'] == 'w-n')
        self.assertAlmostEqual(north['now']['height'], 3.0, places=4)
        self.assertEqual(got['rooms'], [], 'the room group was deleted in SketchUp')
        self.assertEqual(got['untagged']['faces'], 1)
        # Writing Tiksi's state over the edited file replaces Tiksi groups and keeps the face.
        again = self.read(self.write(SPEC, existing=edited))
        self.assertEqual(sorted(w['id'] for w in again['walls']), ['w-e', 'w-n', 'w-s', 'w-w'])
        self.assertEqual(len(again['rooms']), 1)
        self.assertEqual(again['untagged']['faces'], 1)

    @unittest.skipUnless(shutil.which('node'), 'Node not installed')
    def test_browser_spec_and_merge_agree_with_native_files(self):
        """Tiksi's own spec through real SKP files: finishes painted, no false changes, and a SketchUp move lands."""
        repo = Path(__file__).resolve().parent.parent
        script = """
globalThis.indexedDB = { open() { throw new Error('none'); } };
const store = await import(process.argv[1] + '/js/store.js');
const m = await import(process.argv[1] + '/js/sketchup-mirror.js');
const fs = await import('node:fs');
const p = store.propertyTemplate('Contract'); p.id = 'prop-contract'; const L = p.levels[0].id;
const wall = (id, ax, ay, bx, by) => ({ id, level: L, ax, ay, bx, by, thickness: 0.114, height: null, material: 'mat-drywall' });
p.walls.push(wall('w-s', 0, 0, 5, 0), wall('w-e', 5, 0, 5, 3.5), wall('w-n', 5, 3.5, 0, 3.5), wall('w-w', 0, 3.5, 0, 0));
p.openings.push({ id: 'o-d', wallId: 'w-s', type: 'door', t: 0.2, width: 0.914, height: 2.032 },
  { id: 'o-w', wallId: 'w-e', type: 'window', t: 0.5, width: 1.2, height: 1.2, sill: 0.8 },
  { id: 'o-edge', wallId: 'w-n', type: 'door', t: 0.01, width: 0.9, height: 2.0 });
p.rooms.push({ id: 'r-1', level: L, name: 'Living', pts: [[0, 0], [5, 0], [5, 3.5], [0, 3.5]], material: 'mat-oak', ceilingMaterial: null });
const mats = [{ id: 'mat-drywall', name: 'Drywall, painted', color: '#d8d4cc' }, { id: 'mat-oak', name: 'White oak flooring', color: '#c9a06a' },
  { id: 'mat-trim', name: 'Trim, painted semi-gloss', color: '#f4f2ec' }, { id: 'mat-glass', name: 'Glass, clear', color: '#d2e7ee' }];
const [op, a, b] = process.argv.slice(2);
if (op === 'spec') fs.writeFileSync(a, JSON.stringify(m.mirrorSpec(p, mats)));
else {
  const r = m.mergeMirror(p, JSON.parse(fs.readFileSync(a, 'utf8')), m.syncedState(p));
  const e = p.walls.find(w => w.id === 'w-e');
  console.log(JSON.stringify({ applied: r.applied, added: r.added, deleted: r.deleted, conflicts: r.conflicts.length, east: [e.ax, e.bx] }));
}
"""
        def node(*args):
            r = subprocess.run(['node', '--input-type=module', '-e', script, str(repo), *args], capture_output=True, text=True, timeout=60)
            self.assertEqual(r.returncode, 0, r.stderr)
            return r.stdout.strip().splitlines()[-1] if r.stdout.strip() else ''
        job = self.root / 'contract'; job.mkdir()
        node('spec', str(job / 'mirror.json'))
        self.run_worker('write', job)
        floor, = [f for f in painted_faces(job / 'model.skp') if f['id'] == 'r-1']
        self.assertEqual(floor['seen from'](0, 0, 1), ('Tiksi: White oak flooring', rgb('#c9a06a')))
        unedited = self.root / 'unedited.json'
        (unedited).write_text(json.dumps(self.read(job / 'model.skp')))
        self.assertEqual(json.loads(node('merge', str(unedited))), {'applied': [], 'added': [], 'deleted': [], 'conflicts': 0, 'east': [5, 5]})
        moved = self.root / 'moved.skp'
        move_group(job / 'model.skp', moved, 'w-e', 0.5)
        edited = self.root / 'edited.json'
        edited.write_text(json.dumps(self.read(moved)))
        self.assertEqual(json.loads(node('merge', str(edited))), {'applied': ['w-e'], 'added': [], 'deleted': [], 'conflicts': 0, 'east': [5.5, 5.5]})

    def test_written_faces_wear_their_finishes(self):
        faces = painted_faces(self.write(finished()))
        south = [f for f in faces if f['id'] == 'w-s']
        sage, = [f for f in south if 'Tiksi: Sage paint' in (f['front'][0], f['back'][0])]
        self.assertAlmostEqual(sage['plan'][1], 0.05, places=3, msg='the pos face is the one inside the room')
        self.assertEqual(sage['seen from'](0, 1), ('Tiksi: Sage paint', rgb(SAGE['color'])), 'painted on the side that faces the room')
        brick, = [f for f in south if abs(f['plan'][1] + 0.05) < 1e-3]
        self.assertEqual(brick['seen from'](0, -1), ('Tiksi: Brick, red', rgb(BRICK['color'])))
        ends = [f for f in south if abs(abs(f['plan'][1]) - 0.05) > 1e-3]
        self.assertTrue(ends and all(f['front'][0] == f['back'][0] == 'Tiksi: Brick, red' for f in ends), 'ends, top and reveals')
        north_inside, = [f for f in faces if f['id'] == 'w-n' and abs(f['plan'][1] - 2.95) < 1e-3]
        self.assertEqual(north_inside['seen from'](0, -1)[0], 'Tiksi: Drywall, painted')
        floor, = [f for f in faces if f['id'] == 'r-1']
        self.assertEqual(floor['seen from'](0, 0, 1), ('Tiksi: White oak flooring', rgb(OAK['color'])), 'the floor seen from above')
        door, = [f for f in faces if f['id'] == 'o-door']
        window, = [f for f in faces if f['id'] == 'o-win']
        self.assertEqual((door['front'][0], door['back'][0]), ('Tiksi: Trim, painted semi-gloss',) * 2)
        self.assertEqual((window['front'], window['back']), (('Tiksi: Glass, clear', rgb(GLASS['color'])),) * 2)
        self.assertEqual(sorted(model_materials(self.root / 'write-0' / 'model.skp')),
                         sorted('Tiksi: ' + m['name'] for m in (SAGE, BRICK, DRYWALL, OAK, TRIM, GLASS)))

    def test_rewrite_repaints_by_name_and_keeps_sketchup_work(self):
        skp = self.write(finished())
        edited = self.root / 'painted.skp'
        draw_painted_face(skp, edited, 'Sage paint', (10, 20, 30))      # the user's own material, same name minus the prefix
        again = self.write(finished(dict(SAGE, color='#334455')), existing=edited)
        mats = model_materials(again)
        self.assertEqual(len(mats), 7, 'six Tiksi materials reused by name, plus the user\'s own')
        self.assertEqual(mats['Tiksi: Sage paint'], (0x33, 0x44, 0x55), 'the new Tiksi colour')
        self.assertEqual(mats['Sage paint'], (10, 20, 30), 'a material Tiksi does not own is untouched')
        faces = painted_faces(again)
        sage, = [f for f in faces if f['id'] == 'w-s' and abs(f['plan'][1] - 0.05) < 1e-3]
        self.assertEqual(sage['seen from'](0, 1), ('Tiksi: Sage paint', (0x33, 0x44, 0x55)))
        loose, = [f for f in faces if f['id'] is None]
        self.assertEqual(loose['front'], ('Sage paint', (10, 20, 30)), 'geometry drawn in SketchUp survives with its paint')
        self.assertEqual(len(model_materials(self.write(finished(dict(SAGE, color='#334455')), existing=again))), 7, 'repeat writes add nothing')
        # A Tiksi material someone gave a texture in SketchUp keeps it, untinted, through a rewrite.
        textured = self.root / 'textured.skp'
        add_texture(again, textured, 'Tiksi: White oak flooring', self.root / 'grain.png')
        kept = self.write(finished(), existing=textured)
        self.assertEqual(material_type(kept, 'Tiksi: White oak flooring'), 1, 'still SUMaterialType_Textured, not colorized')
        self.assertEqual(model_materials(kept)['Tiksi: Sage paint'], rgb(SAGE['color']), 'colour-only materials follow Tiksi')
        got = self.read(again)
        self.assertEqual(sorted(w['id'] for w in got['walls']), ['w-e', 'w-n', 'w-s', 'w-w'])
        self.assertEqual(got['untagged']['faces'], 1)

    def test_bad_or_missing_finishes_still_write(self):
        spec = finished()
        spec['rooms'][0]['material'] = {'id': 'mat-oak', 'name': 'White oak flooring', 'color': 'oak'}
        del spec['walls'][1]['materials']
        job = self.root / 'bad'; job.mkdir()
        (job / 'mirror.json').write_text(json.dumps(spec))
        result = self.run_worker('write', job)
        self.assertEqual(result['warnings'], ["Tiksi: White oak flooring has no usable colour (oak); left at the SketchUp default"])
        faces = painted_faces(job / 'model.skp')
        floor, = [f for f in faces if f['id'] == 'r-1']
        self.assertEqual(floor['seen from'](0, 0, 1)[0], 'Tiksi: White oak flooring')
        self.assertTrue(all(f['front'][0] is None and f['back'][0] is None for f in faces if f['id'] == 'w-e'), 'a wall without finishes is left unpainted')
        self.assertEqual(model_materials(self.write(SPEC)), {}, 'a spec from before finishes paints nothing')

    def test_mirror_of_another_property_is_refused(self):
        skp = self.write(SPEC)
        other = dict(SPEC, property={'id': 'prop-other', 'name': 'Other'})
        job = self.root / 'refuse'; job.mkdir()
        (job / 'mirror.json').write_text(json.dumps(other)); shutil.copy(skp, job / 'existing.skp')
        r = subprocess.run([sys.executable, str(WORKER), 'write', str(job)], capture_output=True, text=True, timeout=60)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('different Tiksi property', r.stderr)

    def test_service_round_trip_through_job_folders(self):
        service = ModelConversionService(self.root / 'state')
        try:
            package = io_zip({'mirror.json': json.dumps(SPEC).encode()})
            skp = service.mirror('write', package)
            self.assertTrue(skp.startswith(b'\xff\xfe\xff') or len(skp) > 1000)
            got = json.loads(service.mirror('read', skp))
            self.assertEqual(len(got['walls']), 4)
            self.assertFalse(any((self.root / 'state' / 'mirror').iterdir()), 'mirror jobs leave no files behind')
        finally:
            service.close()


class MirrorServiceBoundsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.service = ModelConversionService(Path(self.temp.name))

    def tearDown(self):
        self.service.close(); self.temp.cleanup()

    def test_without_sketchup_the_mirror_says_so(self):
        self.service.sketchup = False
        with self.assertRaises(ConversionError) as caught:
            self.service.mirror('read', b'abc')
        self.assertEqual(caught.exception.status, 422)
        self.assertFalse(self.service.capabilities()['mirror'])

    def test_rejects_unknown_operation_and_bad_packages(self):
        self.service.sketchup = True
        with self.assertRaises(ConversionError):
            self.service.mirror('delete', b'abc')
        with self.assertRaises(ConversionError):
            self.service.mirror('write', b'not a zip')
        with self.assertRaises(ConversionError):
            self.service.mirror('write', io_zip({'../escape.json': b'{}'}))
        with self.assertRaises(ConversionError):
            self.service.mirror('write', io_zip({'existing.skp': b'abc'}))

    def test_busy_service_refuses_mirror(self):
        self.service.sketchup = True   # the lock is checked before any native call, so no SDK is needed
        self.service.lock.acquire()
        try:
            with self.assertRaises(ConversionError) as caught:
                self.service.mirror('read', b'abc')
            self.assertEqual(caught.exception.status, 409)
        finally:
            self.service.lock.release()


def io_zip(entries):
    import io
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, 'w') as z:
        for name, data in entries.items():
            z.writestr(name, data)
    return stream.getvalue()


def painted_faces(source):
    """Every face in the model: the Tiksi id of its group (None for loose geometry), its centre
    in plan metres [x, y, z], each side's (material name, rgb), and 'seen from'(x, y[, z]): the
    side visible from that plan direction."""
    from server.sketchup_convert import API, Ref, Point, Color
    from server.sketchup_mirror import get_data, to_ref, group_transform, face_ring, apply, multiply, skp_to_plan
    api = API(); model = Ref(); out = []

    def side(face, name):
        mat = Ref()
        if api.call(name, face, C.byref(mat), optional=True) or not mat.ptr:
            return (None, None)
        color = Color(); api.call('SUMaterialGetColor', mat, C.byref(color))
        return (api.text('SUMaterialGetName', mat), (color.red, color.green, color.blue))

    def walk(entities, m, owner):
        for face in api.collection(entities, 'Faces'):
            ring = [apply(m, p) for p in face_ring(api, face)]
            centre = [sum(p[i] for p in ring) / len(ring) for i in range(3)]
            n = Point(); api.call('SUFaceGetNormal', face, C.byref(n))
            o, tip = apply(m, [0, 0, 0]), apply(m, [n.x, n.y, n.z])
            normal = [tip[i] - o[i] for i in range(3)]
            front, back = side(face, 'SUFaceGetFrontMaterial'), side(face, 'SUFaceGetBackMaterial')
            # Plan (x, y, z) is SketchUp (x, -y, z).
            seen = lambda x, y, z=0, normal=normal, front=front, back=back: front if normal[0] * x - normal[1] * y + normal[2] * z > 0 else back
            out.append({'id': owner, 'plan': skp_to_plan(centre) + [centre[2] * 0.0254], 'front': front, 'back': back, 'seen from': seen})
        for g in api.collection(entities, 'Groups'):
            data = get_data(api, to_ref(api, 'SUGroupToEntity', g))
            walk(api.ref('SUGroupGetEntities', g), multiply(m, group_transform(api, g)), (data or {}).get('id', owner))

    try:
        api.call('SUModelCreateFromFile', C.byref(model), str(source).encode())
        walk(api.ref('SUModelGetEntities', model), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], None)
        return out
    finally:
        if model.ptr: api.call('SUModelRelease', C.byref(model))
        api.lib.SUTerminate()


def model_materials(source):
    """{name: rgb} of every material in the model."""
    from server.sketchup_convert import API, Ref, Color
    api = API(); model = Ref()
    try:
        api.call('SUModelCreateFromFile', C.byref(model), str(source).encode())
        count = C.c_size_t(); api.call('SUModelGetNumMaterials', model, C.byref(count))
        refs = (Ref * max(1, count.value))()
        if count.value: api.call('SUModelGetMaterials', model, count, refs, C.byref(count))
        out = {}
        for ref in refs[:count.value]:
            color = Color(); api.call('SUMaterialGetColor', ref, C.byref(color))
            out[api.text('SUMaterialGetName', ref)] = (color.red, color.green, color.blue)
        return out
    finally:
        if model.ptr: api.call('SUModelRelease', C.byref(model))
        api.lib.SUTerminate()


def draw_painted_face(source, output, name, color):
    """A loose face drawn in SketchUp and painted with a material of the user's own."""
    from server.sketchup_convert import API, Ref, Color
    from server.sketchup_mirror import fill
    api = API(); model = Ref()
    try:
        api.call('SUModelCreateFromFile', C.byref(model), str(source).encode())
        entities = api.ref('SUModelGetEntities', model)
        fill(api, entities, [[0, 0, 200], [40, 0, 200], [40, 40, 200], [0, 40, 200]], [([0, 1, 2, 3], [])])
        mat = Ref(); api.call('SUMaterialCreate', C.byref(mat)); api.call('SUMaterialSetName', mat, name.encode())
        api.call('SUMaterialSetColor', mat, C.byref(Color(*color, 255)))
        api.call('SUModelAddMaterials', model, C.c_size_t(1), (Ref * 1)(mat))
        for face in api.collection(entities, 'Faces'):
            api.call('SUFaceSetFrontMaterial', face, mat)
        api.call('SUModelSaveToFile', model, str(output).encode())
    finally:
        if model.ptr: api.call('SUModelRelease', C.byref(model))
        api.lib.SUTerminate()


def tiny_png(path):
    import struct, zlib
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    raw = b''.join(b'\x00' + bytes([120, 80, 40] * 2) for _ in range(2))
    path.write_bytes(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 2, 2, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))


def add_texture(source, output, name, png):
    from server.sketchup_convert import API, Ref
    tiny_png(png)
    api = API(); model = Ref()
    try:
        api.call('SUModelCreateFromFile', C.byref(model), str(source).encode())
        mat = find_material(api, model, name)
        tex = Ref(); api.call('SUTextureCreateFromFile', C.byref(tex), str(png).encode(), C.c_double(1), C.c_double(1))
        api.call('SUMaterialSetTexture', mat, tex)
        api.call('SUModelSaveToFile', model, str(output).encode())
    finally:
        if model.ptr: api.call('SUModelRelease', C.byref(model))
        api.lib.SUTerminate()


def material_type(source, name):
    from server.sketchup_convert import API, Ref
    api = API(); model = Ref()
    try:
        api.call('SUModelCreateFromFile', C.byref(model), str(source).encode())
        kind = C.c_int(); api.call('SUMaterialGetType', find_material(api, model, name), C.byref(kind))
        return kind.value
    finally:
        if model.ptr: api.call('SUModelRelease', C.byref(model))
        api.lib.SUTerminate()


def find_material(api, model, name):
    from server.sketchup_convert import Ref
    count = C.c_size_t(); api.call('SUModelGetNumMaterials', model, C.byref(count))
    refs = (Ref * max(1, count.value))()
    if count.value: api.call('SUModelGetMaterials', model, count, refs, C.byref(count))
    return next(r for r in refs[:count.value] if api.text('SUMaterialGetName', r) == name)


def move_group(source, output, element_id, dx_metres):
    from server.sketchup_convert import API, Ref, Transform
    from server.sketchup_mirror import get_data, to_ref, matrix
    api = API(); model = Ref()
    try:
        api.call('SUModelCreateFromFile', C.byref(model), str(source).encode())
        for g in api.collection(api.ref('SUModelGetEntities', model), 'Groups'):
            data = get_data(api, to_ref(api, 'SUGroupToEntity', g))
            if data and data.get('id') == element_id:
                t = Transform(); api.call('SUGroupGetTransform', g, C.byref(t))
                m = matrix(t); m[12] += dx_metres / 0.0254; t.values[:] = m
                api.call('SUGroupSetTransform', g, C.byref(t))
        api.call('SUModelSaveToFile', model, str(output).encode())
    finally:
        if model.ptr: api.call('SUModelRelease', C.byref(model))
        api.lib.SUTerminate()


def edit_like_sketchup(source, output):
    """What a person might do in SketchUp: move a wall, raise another, copy one, delete the
    room and draw a loose face. Uses only public SDK calls on a copy of the mirror."""
    from server.sketchup_convert import API, Ref, Point, Transform
    from server.sketchup_mirror import get_data, set_data, to_ref, fill, new_group, matrix
    api = API(); model = Ref()
    try:
        api.call('SUModelCreateFromFile', C.byref(model), str(source).encode())
        entities = api.ref('SUModelGetEntities', model)
        groups = {}
        for g in api.collection(entities, 'Groups'):
            data = get_data(api, to_ref(api, 'SUGroupToEntity', g))
            if data: groups[data['id']] = (g, data)
        # Raise the north wall to 3 m: scale its group vertically by 3 / 2.5.
        g, _ = groups['w-n']
        t = Transform(); api.call('SUGroupGetTransform', g, C.byref(t))
        m = matrix(t); m[8:11] = [v * 3.0 / 2.5 for v in m[8:11]]
        t.values[:] = m; api.call('SUGroupSetTransform', g, C.byref(t))
        # Copy the east wall 1 m further east (a copy carries the same dictionary).
        g, data = groups['w-e']
        t = Transform(); api.call('SUGroupGetTransform', g, C.byref(t))
        m = matrix(t); m[12] += 1 / 0.0254
        copy = new_group(api, entities, 'Wall copy', m)
        h = 2.5 / 0.0254; w = 3 / 0.0254
        fill(api, api.ref('SUGroupGetEntities', copy), [[0, 0, 0], [w, 0, 0], [w, 0, h], [0, 0, h]], [([0, 1, 2, 3], [])])
        set_data(api, to_ref(api, 'SUGroupToEntity', copy), data)
        # Delete the room.
        g, _ = groups['r-1']
        api.call('SUEntitiesErase', entities, C.c_size_t(1), (Ref * 1)(to_ref(api, 'SUGroupToEntity', g)))
        # A loose face drawn directly in the model.
        fill(api, entities, [[0, 0, 200], [40, 0, 200], [40, 40, 200], [0, 40, 200]], [([0, 1, 2, 3], [])])
        api.call('SUModelSaveToFile', model, str(output).encode())
    finally:
        if model.ptr: api.call('SUModelRelease', C.byref(model))
        api.lib.SUTerminate()


if __name__ == '__main__':
    unittest.main()
