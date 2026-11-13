"""Generated wall trim stays exact in native files; unsupported edits stay in SketchUp."""
import ctypes as C
from collections import Counter
import json
import math
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

from server.sketchup_convert import API, Color, Ref, Transform, library_path
from server.sketchup_mirror import IN, apply, face_ring, fill, frame, get_data, group_transform, multiply, new_group, plan_to_skp, set_data, to_ref


ROOT = Path(__file__).resolve().parent.parent
WORKER = ROOT / 'server/sketchup_mirror.py'


def trim_spec():
    source = {'id': 'trim-synthetic', 'wallId': 'wall-synthetic', 'side': 1,
              'style': 'crown', 'product': 'synthetic-profile', 'f0': .1, 'f1': .9,
              'evidence': {'status': 'proposed-match', 'note': 'Synthetic specification evidence'}}
    # Deliberately non-coplanar triangles exercise the actual section, not merely its bounds.
    product = {'id': 'synthetic-profile', 'profile': 'synthetic-section', 'W': .2, 'T': .03}
    trim = {'id': source['id'], 'name': 'Synthetic profiled trim', 'tag': 'Trim details', 'source': source, 'product': product,
            'meshSig': 'synthetic-profile-triangles-v1',
            'parts': [
                {'role': 'profile', 'positions': [.2, 2.2, .05, 3.8, 2.2, .05, .2, 2.35, .08,
                                                  .2, 2.35, .08, 3.8, 2.2, .05, 3.8, 2.4, .07],
                 'material': {'id': 'profile-paint', 'name': 'Synthetic trim paint', 'color': '#d8b791'}},
                {'role': 'backer', 'positions': [.3, 2.2, .052, 3.7, 2.2, .052, .3, 2.3, .052],
                 'material': {'id': 'backer-paint', 'name': 'Synthetic backer paint', 'color': '#232323'}},
            ]}
    return {'format': 'tiksi-sketchup-mirror', 'version': 1,
            'property': {'id': 'synthetic-trim-project', 'name': 'Synthetic trim geometry'},
            'levels': [{'id': 'level', 'name': 'Main', 'elevation': .4, 'height': 2.5}],
            'tags': [{'name': 'Trim details', 'visible': True}],
            'walls': [{'id': source['wallId'], 'level': 'level', 'ax': 1, 'ay': 2, 'bx': 5, 'by': 2,
                       'thickness': .1, 'height': 2.5, 'elevation': .4, 'holes': [],
                       'trims': [trim], 'trimState': {'version': 1, 'records': [
                           {'source': source, 'product': product}]}}],
            'rooms': [], 'fixtures': [], 'underlays': []}


def with_model(path, operation, output=None):
    api, model = API(), Ref()
    try:
        api.call('SUModelCreateFromFile', C.byref(model), str(path).encode())
        result = operation(api, api.ref('SUModelGetEntities', model), model)
        if output:
            api.call('SUModelSaveToFile', model, str(output).encode())
        return result
    finally:
        if model.ptr:
            api.call('SUModelRelease', C.byref(model))
        api.lib.SUTerminate()


def group_of(api, entities, kind):
    for group in api.collection(entities, 'Groups'):
        data = get_data(api, to_ref(api, 'SUGroupToEntity', group)) or {}
        if data.get('kind') == kind:
            return group, data
    raise AssertionError('Missing native ' + kind + ' group')


def inspect_trim(path):
    def inspect(api, entities, model):
        wall, wall_data = group_of(api, entities, 'wall')
        trim, trim_data = group_of(api, api.ref('SUGroupGetEntities', wall), 'trim-detail')
        drawing = to_ref(api, 'SUGroupToDrawingElement', trim)
        layer = api.ref('SUDrawingElementGetLayer', drawing)
        faces = []

        def material(face, method):
            mat = api.ref(method, face)
            colour = Color(); api.call('SUMaterialGetColor', mat, C.byref(colour))
            return api.text('SUMaterialGetName', mat), (colour.red, colour.green, colour.blue)

        def walk(inner, transform):
            for face in api.collection(inner, 'Faces'):
                # Recover Tiksi's wall-local coordinates after every nested group transform.
                points = [apply(transform, point) for point in face_ring(api, face)]
                oriented = [tuple(round(v, 9) for v in (p[0]/IN, p[2]/IN, -p[1]/IN)) for p in points]
                faces.append({'points': sorted(oriented), 'oriented': oriented,
                              'front': material(face, 'SUFaceGetFrontMaterial'),
                              'back': material(face, 'SUFaceGetBackMaterial')})
            for child in api.collection(inner, 'Groups'):
                walk(api.ref('SUGroupGetEntities', child), multiply(transform, group_transform(api, child)))

        walk(api.ref('SUGroupGetEntities', trim), group_transform(api, trim))
        return {'wall': wall_data, 'trim': trim_data, 'name': api.text('SUGroupGetName', trim),
                'tag': api.text('SULayerGetName', layer), 'faces': faces}
    return with_model(path, inspect)


def expected_faces(trim):
    faces = []
    for part in trim['parts']:
        colour = part['material']['color']
        finish = ('Tiksi: ' + part['material']['name'], tuple(int(colour[i:i+2], 16) for i in (1, 3, 5)))
        for i in range(0, len(part['positions']), 9):
            oriented = [tuple(round(v, 9) for v in part['positions'][j:j+3]) for j in (i, i+3, i+6)]
            faces.append({'points': sorted(oriented), 'oriented': oriented, 'front': finish, 'back': finish})
    return faces


def face_counts(faces):
    return Counter((tuple(face['points']), face['front'], face['back']) for face in faces)


def area_vector(points):
    a, b, c = points
    u, v = [b[i]-a[i] for i in range(3)], [c[i]-a[i] for i in range(3)]
    return [(u[1]*v[2]-u[2]*v[1])/2, (u[2]*v[0]-u[0]*v[2])/2, (u[0]*v[1]-u[1]*v[0])/2]


def edit_native(source, output, action):
    def edit(api, entities, model):
        wall, _ = group_of(api, entities, 'wall')
        inner = api.ref('SUGroupGetEntities', wall)
        trim, _ = group_of(api, inner, 'trim-detail')
        values = group_transform(api, wall)
        target = wall
        if action == 'rigid':
            angle = .4
            values = frame(plan_to_skp(3, 4, .4), (math.cos(angle), -math.sin(angle)))
        elif action.startswith('scale-'):
            axis = 'xyz'.index(action[-1])
            for i in range(axis*4, axis*4+3):
                values[i] *= 1.2
        elif action == 'reflect':
            values[:4] = [-v for v in values[:4]]
        elif action == 'shear':
            values[4] += .1
        elif action == 'tilt':
            c, s = math.cos(.1), math.sin(.1)
            tilt = [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]
            values = multiply(values, tilt)
        elif action == 'raise':
            values[14] += .3*IN
        elif action == 'trim-move':
            target, values = trim, group_transform(api, trim)
            values[12] += .1*IN
        elif action == 'opening-move':
            target, _ = group_of(api, inner, 'opening')
            values = group_transform(api, target)
            values[12] += .1*IN
        elif action == 'trim-delete':
            api.call('SUEntitiesErase', inner, C.c_size_t(1), (Ref*1)(to_ref(api, 'SUGroupToEntity', trim)))
            return
        elif action in ('trim-face', 'wall-face'):
            target_inner = api.ref('SUGroupGetEntities', trim) if action == 'trim-face' else inner
            fill(api, target_inner, [[100, 0, 0], [101, 0, 0], [101, 0, 1]], [([0, 1, 2], [])])
            return
        else:
            raise AssertionError('Unknown synthetic mutation ' + action)
        transform = Transform(); transform.values[:] = values
        api.call('SUGroupSetTransform', target, C.byref(transform))
    with_model(source, edit, output)


def copy_trim_to_top_level(source, output, kind='trim-detail', detach=False):
    """A native copy retains its dictionary; copying it outside the wall changes ownership."""
    def edit(api, entities, model):
        wall, _ = group_of(api, entities, 'wall')
        parent = api.ref('SUGroupGetEntities', wall)
        trim, _ = group_of(api, parent, 'trim-detail')
        world = multiply(group_transform(api, wall), group_transform(api, trim))
        if kind == 'trim-part':
            parent = api.ref('SUGroupGetEntities', trim)
            trim, _ = group_of(api, parent, kind)
            world = multiply(world, group_transform(api, trim))

        def copy_group(group, destination, transform):
            copied = new_group(api, destination, api.text('SUGroupGetName', group), transform)
            before, after = api.ref('SUGroupGetEntities', group), api.ref('SUGroupGetEntities', copied)
            for face in api.collection(before, 'Faces'):
                points = face_ring(api, face)
                fill(api, after, points, [(list(range(len(points))), [])])
            for child in api.collection(before, 'Groups'):
                copy_group(child, after, group_transform(api, child))
            data = get_data(api, to_ref(api, 'SUGroupToEntity', group))
            if data is not None:
                set_data(api, to_ref(api, 'SUGroupToEntity', copied), data)

        copy_group(trim, entities, world)
        if detach:
            api.call('SUEntitiesErase', parent, C.c_size_t(1), (Ref*1)(to_ref(api, 'SUGroupToEntity', trim)))
    with_model(source, edit, output)


def edit_trim_appearance(source, output, action):
    def edit(api, entities, model):
        wall, _ = group_of(api, entities, 'wall')
        trim, _ = group_of(api, api.ref('SUGroupGetEntities', wall), 'trim-detail')
        part, _ = group_of(api, api.ref('SUGroupGetEntities', trim), 'trim-part')
        face = api.collection(api.ref('SUGroupGetEntities', part), 'Faces')[0]
        if action.startswith('paint-'):
            material = api.ref('SUMaterialCreate')
            api.call('SUMaterialSetName', material, b'Synthetic native repaint')
            api.call('SUMaterialSetColor', material, C.byref(Color(25, 90, 160, 255)))
            api.call('SUModelAddMaterials', model, C.c_size_t(1), (Ref*1)(material))
            api.call('SUFaceSetFrontMaterial' if action == 'paint-front' else 'SUFaceSetBackMaterial', face, material)
        elif action in ('same-material-colour', 'same-material-opacity'):
            material = api.ref('SUFaceGetFrontMaterial', face)
            if action.endswith('colour'):
                api.call('SUMaterialSetColor', material, C.byref(Color(25, 90, 160, 255)))
            else:
                api.call('SUMaterialSetUseOpacity', material, C.c_bool(True))
                api.call('SUMaterialSetOpacity', material, C.c_double(.4))
        else:
            drawing = to_ref(api, 'SUFaceToDrawingElement', face) if action.endswith('face') else to_ref(api, 'SUGroupToDrawingElement', trim)
            if action.startswith('retag-'):
                layer = api.ref('SULayerCreate')
                api.call('SULayerSetName', layer, b'Synthetic native trim tag')
                api.call('SUModelAddLayers', model, C.c_size_t(1), (Ref*1)(layer))
                api.call('SUDrawingElementSetLayer', drawing, layer)
            elif action.startswith('hide-'):
                api.call('SUDrawingElementSetHidden', drawing, C.c_bool(True))
            else:
                raise AssertionError('Unknown appearance edit ' + action)
    with_model(source, edit, output)


@unittest.skipUnless(library_path(), 'SketchUp SDK not installed')
class NativeTrimDetailTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def job(self, label):
        folder = self.root / (label + '-' + str(len(list(self.root.iterdir()))))
        folder.mkdir()
        return folder

    def worker(self, operation, folder, success=True):
        result = subprocess.run([sys.executable, str(WORKER), operation, str(folder)], capture_output=True, text=True, timeout=60)
        if success:
            self.assertEqual(result.returncode, 0, result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0, 'Unsupported native trim edit was silently accepted')
            self.assertIn('trim', result.stderr.lower())
        return result

    def write(self, spec):
        folder = self.job('write')
        (folder/'mirror.json').write_text(json.dumps(spec), encoding='utf-8')
        self.worker('write', folder)
        return folder/'model.skp'

    def read(self, model):
        folder = self.job('read')
        shutil.copy(model, folder/'source.skp')
        self.worker('read', folder)
        return json.loads((folder/'mirror-read.json').read_text(encoding='utf-8'))

    def test_triangles_materials_tag_and_source_survive_without_changing_wall_bounds(self):
        spec = trim_spec(); wall = spec['walls'][0]; trim = wall['trims'][0]
        model = self.write(spec)
        actual = inspect_trim(model)
        self.assertEqual(actual['name'], trim['name'])
        self.assertEqual(actual['tag'], trim['tag'])
        self.assertEqual(actual['trim']['id'], trim['id'])
        self.assertEqual(actual['trim']['source'], trim['source'])
        self.assertEqual(actual['trim']['product'], trim['product'])
        self.assertEqual(actual['trim']['meshSig'], trim['meshSig'])
        self.assertEqual(actual['wall']['base']['trimState'], wall['trimState'])
        self.assertEqual(actual['wall']['base']['trimGeometry'], [{'id': trim['id'], 'meshSig': trim['meshSig']}])
        self.assertEqual(face_counts(actual['faces']), face_counts(expected_faces(trim)))
        read = self.read(model)
        self.assertEqual(read['warnings'], [])
        self.assertEqual(read['unsupportedGeometry'], [])
        self.assertEqual(read['walls'][0]['now'], read['walls'][0]['base'])
        self.assertEqual(read['walls'][0]['now']['trimState'], wall['trimState'])
        self.assertEqual(read['walls'][0]['now']['trimGeometry'], [{'id': trim['id'], 'meshSig': trim['meshSig']}])

    def test_proper_horizontal_rigid_move_keeps_exact_trim_state(self):
        spec = trim_spec(); original = self.write(spec); moved = self.root/'rigid.skp'
        edit_native(original, moved, 'rigid')
        read = self.read(moved)
        self.assertEqual(read['unsupportedGeometry'], [])
        now = read['walls'][0]['now']
        self.assertEqual(now['trimState'], spec['walls'][0]['trimState'])
        for key, wanted in {'ax': 3, 'ay': 4, 'bx': 3+4*math.cos(.4), 'by': 4+4*math.sin(.4),
                            'height': 2.5, 'thickness': .1, 'elevation': .4}.items():
            self.assertAlmostEqual(now[key], wanted, places=6, msg=key)
        self.assertEqual(inspect_trim(moved)['faces'], inspect_trim(original)['faces'])

    def test_nonrepresentable_wall_transforms_abort_read_and_preserve_native_file(self):
        original = self.write(trim_spec())
        for action in ('scale-x', 'scale-y', 'scale-z', 'reflect', 'shear', 'tilt', 'raise'):
            with self.subTest(action=action):
                folder = self.job(action)
                edit_native(original, folder/'source.skp', action)
                before = (folder/'source.skp').read_bytes()
                self.worker('read', folder, success=False)
                self.assertEqual((folder/'source.skp').read_bytes(), before)
                self.assertFalse((folder/'mirror-read.json').exists(), 'no partial merge payload is produced')

    def test_local_wall_and_trim_changes_abort_read_and_rewrite(self):
        spec = trim_spec(); original = self.write(spec)
        for action in ('trim-move', 'trim-delete', 'trim-face', 'wall-face'):
            with self.subTest(action=action):
                folder = self.job(action)
                edit_native(original, folder/'source.skp', action)
                before = (folder/'source.skp').read_bytes()
                self.worker('read', folder, success=False)
                self.assertEqual((folder/'source.skp').read_bytes(), before)
                self.assertFalse((folder/'mirror-read.json').exists())
                shutil.copy(folder/'source.skp', folder/'existing.skp')
                (folder/'mirror.json').write_text(json.dumps(spec), encoding='utf-8')
                result = subprocess.run([sys.executable, str(WORKER), 'write', str(folder)], capture_output=True, text=True, timeout=60)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual((folder/'existing.skp').read_bytes(), before)
                self.assertFalse((folder/'model.skp').exists())

    def test_moving_an_opening_cannot_silently_recut_the_attached_trim(self):
        spec = trim_spec()
        spec['walls'][0]['holes'] = [{'id': 'opening-synthetic', 'type': 'door', 't': .25,
                                    'width': .8, 'height': 2, 'sill': 0,
                                    's0': .6, 's1': 1.4, 'v0': 0, 'v1': 2}]
        original = self.write(spec)
        folder = self.job('opening-move')
        edit_native(original, folder/'source.skp', 'opening-move')
        before = (folder/'source.skp').read_bytes()
        self.worker('read', folder, success=False)
        self.assertEqual((folder/'source.skp').read_bytes(), before)
        self.assertFalse((folder/'mirror-read.json').exists())

    def test_detached_or_copied_trim_is_not_ignored_or_erased(self):
        spec = trim_spec(); original = self.write(spec)
        for kind, detach in (('trim-detail', False), ('trim-detail', True), ('trim-part', False)):
            with self.subTest(kind=kind, detached=detach):
                folder = self.job('detached-trim')
                copy_trim_to_top_level(original, folder/'source.skp', kind=kind, detach=detach)
                before = (folder/'source.skp').read_bytes()
                self.worker('read', folder, success=False)
                self.assertEqual((folder/'source.skp').read_bytes(), before)
                self.assertFalse((folder/'mirror-read.json').exists())
                shutil.copy(folder/'source.skp', folder/'existing.skp')
                (folder/'mirror.json').write_text(json.dumps(spec), encoding='utf-8')
                self.worker('write', folder, success=False)
                self.assertEqual((folder/'existing.skp').read_bytes(), before)
                self.assertFalse((folder/'model.skp').exists(), 'the detached native work is never silently replaced')

    @unittest.skipUnless(shutil.which('node'), 'Node not installed')
    def test_javascript_catalog_triangles_and_native_merge_agree_for_five_styles(self):
        script = """
import assert from 'node:assert/strict';
import fs from 'node:fs';
globalThis.indexedDB = { open() { throw new Error('no IndexedDB under Node'); } };
const [repo, op, style, file] = process.argv.slice(1);
const store = await import(repo + '/js/store.js');
const { trimTemplate } = await import(repo + '/js/trims.js');
const { catalogFor } = await import(repo + '/js/trim-catalog.js');
const { trimMeshParts } = await import(repo + '/js/trim-mesh.js');
const mirror = await import(repo + '/js/sketchup-mirror.js');
const p = store.propertyTemplate('Synthetic native trim contract'); p.id = 'synthetic-trim-contract';
const wall = { id: 'wall', level: p.levels[0].id, ax: 0, ay: 0, bx: 4, by: 0,
  thickness: .15, height: 2.44, material: 'mat-drywall' };
p.walls = [wall]; p.rooms = []; p.openings = [];
p.trims = [{ ...trimTemplate(style, catalogFor(style)[0].id, wall, 1, { wallHeight: 2.44 }),
  id: 'trim-section', evidence: { geometry: { status: 'inferred', source: 'Synthetic specification' } } }];
const materials = [{ id: 'mat-drywall', name: 'Synthetic wall finish', color: '#d8d4cc' },
  { id: 'mat-trim', name: 'Synthetic trim finish', color: '#f4f2ec' }];
if (op === 'spec') {
  const spec = mirror.mirrorSpec(p, materials);
  const native = spec.walls[0].trims[0];
  const generated = trimMeshParts(p.trims[0], wall, { walls: p.walls, rooms: [], wallHeight: 2.44 }, []);
  const geometry = parts => parts.map(({role, positions}) => ({role, positions}));
  assert.deepEqual(geometry(native.parts), geometry(generated.parts));
  assert.ok(native.parts.length && native.parts.every(part => part.positions.length));
  fs.writeFileSync(file, JSON.stringify(spec));
} else {
  const before = JSON.stringify(p);
  const report = mirror.mergeMirror(p, JSON.parse(fs.readFileSync(file, 'utf8')), mirror.syncedState(p));
  console.log(JSON.stringify({ applied: report.applied, added: report.added, deleted: report.deleted,
    conflicts: report.conflicts, blocked: !!report.blockWrite, unchanged: before === JSON.stringify(p) }));
}
"""

        def node(operation, style, path):
            result = subprocess.run(['node', '--input-type=module', '-e', script, str(ROOT), operation, style, str(path)],
                                    capture_output=True, text=True, timeout=60)
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout) if result.stdout.strip() else None

        for style in ('baseboard', 'board-batten', 'chair-rail', 'picture-frame', 'wainscot-cap'):
            with self.subTest(style=style):
                folder = self.job(style)
                node('spec', style, folder/'mirror.json')
                spec = json.loads((folder/'mirror.json').read_text(encoding='utf-8'))
                wall = spec['walls'][0]; trim = wall['trims'][0]
                self.worker('write', folder)
                actual = inspect_trim(folder/'model.skp')
                written, expected = face_counts(actual['faces']), face_counts(expected_faces(trim))
                # The SDK welds coincident opposing caps at mitred frame joints: this
                # fixture's 800 triangles contain 180 paired caps, yielding 620 native
                # surfaces. Require every exact surface and both paints, unchanged
                # exterior winding/area, and prove every consolidation is such a cap.
                self.assertEqual(written, Counter({key: 1 for key in expected}))
                vectors = {}
                for face in expected_faces(trim):
                    key = next(iter(face_counts([face])))
                    vectors.setdefault(key, []).append(area_vector(face['oriented']))
                paired_caps = 0
                for face in actual['faces']:
                    key = next(iter(face_counts([face])))
                    originals = vectors[key]; native = area_vector(face['oriented'])
                    if len(originals) == 1:
                        self.assertLess(math.dist(native, originals[0]), 1e-12, 'exterior oriented area is unchanged')
                    else:
                        self.assertEqual(style, 'picture-frame')
                        self.assertEqual(len(originals), 2)
                        self.assertLess(math.hypot(*(a+b for a,b in zip(*originals))), 1e-12, 'the duplicate cap normals oppose')
                        self.assertLess(abs(originals[0][2]), 1e-12, 'the cap lies across the moulding depth')
                        self.assertLess(abs(abs(originals[0][0])-abs(originals[0][1])), 1e-12, 'the cap is a 45-degree mitre')
                        self.assertLess(min(math.dist(native, vector) for vector in originals), 1e-12)
                        self.assertEqual(face['front'], face['back'], 'one double-painted face preserves both opposing caps')
                        paired_caps += 1
                self.assertEqual(paired_caps, sum(expected.values())-sum(written.values()))
                if style == 'picture-frame':
                    self.assertGreater(paired_caps, 0, 'the fixture exercises welded opposing caps')
                for key in ('source', 'product', 'meshSig'):
                    self.assertEqual(actual['trim'][key], trim[key], key)
                shutil.copy(folder/'model.skp', folder/'source.skp')
                self.worker('read', folder)
                read = json.loads((folder/'mirror-read.json').read_text(encoding='utf-8'))
                self.assertEqual(read['warnings'], [])
                self.assertEqual(read['unsupportedGeometry'], [])
                result_wall = read['walls'][0]
                self.assertEqual(result_wall['now'], result_wall['base'])
                self.assertEqual(result_wall['now']['trimState'], wall['trimState'])
                self.assertEqual(result_wall['now']['trimGeometry'], [{'id': trim['id'], 'meshSig': trim['meshSig']}])
                self.assertEqual(node('merge', style, folder/'mirror-read.json'),
                                 {'applied': [], 'added': [], 'deleted': [], 'conflicts': [], 'blocked': False, 'unchanged': True})

    def test_native_trim_appearance_changes_are_preserved_for_review(self):
        spec = trim_spec(); original = self.write(spec)
        for action in ('paint-front', 'paint-back', 'same-material-colour', 'same-material-opacity',
                       'retag-group', 'retag-face', 'hide-group', 'hide-face'):
            with self.subTest(action=action):
                folder = self.job(action)
                edit_trim_appearance(original, folder/'source.skp', action)
                before = (folder/'source.skp').read_bytes()
                self.worker('read', folder, success=False)
                self.assertEqual((folder/'source.skp').read_bytes(), before)
                self.assertFalse((folder/'mirror-read.json').exists())
                shutil.copy(folder/'source.skp', folder/'existing.skp')
                (folder/'mirror.json').write_text(json.dumps(spec), encoding='utf-8')
                self.worker('write', folder, success=False)
                self.assertEqual((folder/'existing.skp').read_bytes(), before)
                self.assertFalse((folder/'model.skp').exists())


if __name__ == '__main__':
    unittest.main()
