"""Explicit opening details keep their physical shape and their editable opening bounds."""
import ctypes as C
import json
import math
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

from server.sketchup_convert import API, Ref, library_path
from server.sketchup_mirror import opening_detail_parts, scaled_opening_detail, get_data, to_ref, face_bounds, face_ring, group_transform, multiply, apply, baseboard_part, scaled_baseboard, IN

ROOT = Path(__file__).resolve().parent.parent
TRIM = {'id': 'trim', 'name': 'Trim', 'color': '#eeeeee'}
GLASS = {'id': 'glass', 'name': 'Glass', 'color': '#d2e7ee', 'opacity': .25}
METAL = {'id': 'metal', 'name': 'Brass', 'color': '#aa8833'}


def door(hinge='start', shown=True):
    return {'id': 'door', 'type': 'door', 't': .25, 'width': .8, 'height': 2.0, 'sill': 0,
            's0': .6, 's1': 1.4, 'v0': 0, 'v1': 2.0,
            'detail': {'door': {'hinge': hinge, 'style': 'slab', 'hardware': 'knob', 'leafWidth': .75,
                                'leafHeight': 1.95, 'leafThickness': .034925}},
            'resolved': {'leaves': 1, 'hinge': hinge, 'style': 'slab', 'hardware': 'knob', 'knobShape': 'round',
                         'leafWidth': .75, 'leafHeight': 1.95, 'leafThickness': .034925,
                         'jambWidth': .022, 'casingWidth': .07, 'casingDepth': .016, 'swingSide': 1},
            'shownOpen': shown, 'sides': {'pos': True, 'neg': True}, 'material': TRIM,
            'trimMaterial': TRIM, 'glassMaterial': GLASS, 'metalMaterial': METAL}


def window():
    return {'id': 'window', 'type': 'window', 't': .75, 'width': 1.0, 'height': 1.2, 'sill': .8,
            's0': 2.5, 's1': 3.5, 'v0': .8, 'v1': 2.0,
            'detail': {'window': {'type': 'double-hung', 'upperColumns': 3, 'upperRows': 2,
                                  'lowerColumns': 1, 'lowerRows': 1}},
            'resolved': {'type': 'double-hung', 'frameWidth': .045, 'sashWidth': .035, 'muntinWidth': .022,
                         'upper': {'columns': 3, 'rows': 2}, 'lower': {'columns': 1, 'rows': 1}},
            'sides': {'pos': True, 'neg': False}, 'material': GLASS, 'trimMaterial': TRIM,
            'glassMaterial': GLASS, 'metalMaterial': METAL}


def spec():
    return {'format': 'tiksi-sketchup-mirror', 'version': 1,
            'property': {'id': 'synthetic', 'name': 'Synthetic detail test'},
            'levels': [{'id': 'level', 'name': 'Main', 'elevation': 0, 'height': 2.5}],
            'walls': [{'id': 'wall', 'level': 'level', 'ax': 0, 'ay': 0, 'bx': 4, 'by': 0,
                       'height': 2.5, 'thickness': .1, 'elevation': 0, 'holes': [door(), window()]}],
            'rooms': [{'id': 'room', 'level': 'level', 'name': 'Room', 'elevation': 0,
                       'pts': [[0, .05], [4, .05], [4, 3], [0, 3]], 'material': TRIM,
                       'ceilingHeight': 2.5, 'ceilingMaterial': TRIM,
                       'thresholds': [{'pts': [[.6, -.05], [1.4, -.05], [1.4, .05], [.6, .05]], 'material': TRIM}]}],
            'underlays': []}


class OpeningDetailGeometryTests(unittest.TestCase):
    def test_end_hinge_mirrors_start_hinge_without_changing_leaf_size(self):
        start = next(p for p in opening_detail_parts(door('start'), .1) if p['name'] == 'Slab leaf')
        end = next(p for p in opening_detail_parts(door('end'), .1) if p['name'] == 'Slab leaf')
        points = lambda p: sorted(tuple(round(q, 9) for q in v) for v in p['points'])
        mirrored = dict(start, points=[[.8-x, y, z] for x, y, z in start['points']])
        self.assertEqual(points(end), points(mirrored))
        # Actual leaf edges keep their stated width/height even while open.
        p = start['points']
        self.assertAlmostEqual(math.dist(p[0], p[1]), .75)
        self.assertAlmostEqual(math.dist(p[0], p[4]), 1.95)
        self.assertTrue(all(v[1] < .02 for v in p), 'positive plan swing maps to negative SketchUp y')

    def test_closed_slab_and_round_knobs_have_no_panel_or_lever_geometry(self):
        parts = opening_detail_parts(door(shown=False), .1)
        self.assertEqual(sum(p['name'] == 'Slab leaf' for p in parts), 1)
        self.assertEqual(sum(p['name'] == 'Door knob' for p in parts), 2)
        self.assertFalse(any('panel' in p['name'].lower() or 'lever' in p['name'].lower() for p in parts))
        leaf = next(p for p in parts if p['name'] == 'Slab leaf')
        self.assertAlmostEqual(max(v[1] for v in leaf['points'])-min(v[1] for v in leaf['points']), .034925)

    def test_double_hung_six_over_one_does_not_add_lower_grille(self):
        parts = opening_detail_parts(window(), .1)
        names = [p['name'] for p in parts]
        self.assertEqual(names.count('Upper sash vertical muntin'), 2)
        self.assertEqual(names.count('Upper sash horizontal muntin'), 1)
        self.assertFalse(any(n.startswith('Lower sash') and 'muntin' in n for n in names))
        self.assertIn('Lower sash glass', names)
        self.assertIn('Upper sash glass', names)

    def test_double_hung_sash_depth_follows_the_interior_side(self):
        h = window()
        for sides, lower_depth in (({'pos': True}, -.025), ({'neg': True}, .025)):
            h['sides'] = sides
            parts = opening_detail_parts(h, .1)
            lower = next(p for p in parts if p['name'] == 'Lower sash glass')
            upper = next(p for p in parts if p['name'] == 'Upper sash glass')
            depth = lambda p: (min(v[1] for v in p['points'])+max(v[1] for v in p['points']))/2
            self.assertAlmostEqual(depth(lower), lower_depth)
            self.assertAlmostEqual(depth(upper), -lower_depth)
            self.assertAlmostEqual(max(v[2] for v in lower['points']), .6-.035/2)
            self.assertAlmostEqual(min(v[2] for v in upper['points']), .6+.035/2)
            lower_rails = [p for p in parts if p['name'] == 'Lower sash rail']
            upper_rails = [p for p in parts if p['name'] == 'Upper sash rail']
            self.assertAlmostEqual(max(v[2] for p in lower_rails for v in p['points']), .6+.035/2)
            self.assertAlmostEqual(min(v[2] for p in upper_rails for v in p['points']), .6-.035/2)

    def test_glazed_pair_has_two_glass_leaves_and_four_faceted_knobs(self):
        h = door(shown=False)
        h['resolved'].update(leaves=2, leafWidth=.372, knobShape='faceted')
        h['leafGlazing'] = {'glass': [.06, .312, .16, 1.88], 'panel': None}
        parts = opening_detail_parts(h, .1)
        self.assertEqual(sum(p['name'] == 'Leaf glass' for p in parts), 2)
        knobs = [p for p in parts if p['name'] == 'Door knob']
        self.assertEqual(len(knobs), 4)
        self.assertTrue(all(len(p['points']) == 42 and len(p['faces']) == 80 for p in knobs))
        self.assertFalse(any(p['name'] == 'Slab leaf' for p in parts))

    def test_zero_casing_dimensions_omit_the_casing(self):
        for key in ('casingWidth', 'casingDepth'):
            h = door(); h['resolved'][key] = 0
            self.assertFalse(any('casing' in p['name'] for p in opening_detail_parts(h, .1)))

    def test_detail_scale_preserves_unedited_precision_and_does_not_mutate_source(self):
        detail = {'door': {'leafWidth': .750123456, 'leafHeight': 1.95, 'leafThickness': .034925,
                           'hinge': 'end', 'hardware': 'knob'}, 'window': {'upperColumns': 3}}
        self.assertEqual(scaled_opening_detail(detail, 1, 1, 1), detail)
        scaled = scaled_opening_detail(detail, 2, 3, 4)
        self.assertEqual(scaled['door']['leafWidth'], 1.500247)
        self.assertEqual(scaled['door']['leafHeight'], 7.8)
        self.assertEqual(scaled['door']['leafThickness'], .104775)
        self.assertEqual(detail['door']['leafWidth'], .750123456)
        self.assertEqual(scaled['window']['upperColumns'], 3)

    def test_legacy_hole_uses_existing_pane_and_plain_opening_has_no_detail(self):
        h = door(); h.pop('detail')
        self.assertEqual(opening_detail_parts(h, .1), [])
        h = door(); h['plain'] = True
        self.assertEqual(opening_detail_parts(h, .1), [])



class BaseboardGeometryTests(unittest.TestCase):
    def test_rounded_profile_has_correct_envelope_and_four_curved_segments(self):
        segment = {'s0': .2, 's1': 1.3, 'height': .15, 'depth': .02, 'profile': 'rounded', 'side': 'pos'}
        part = baseboard_part(segment, .1)
        self.assertEqual(len(part['points']), 16)
        self.assertEqual(len(part['faces']), 10)
        self.assertEqual(min(p[0] for p in part['points']), .2)
        self.assertEqual(max(p[0] for p in part['points']), 1.3)
        self.assertAlmostEqual(min(p[1] for p in part['points']), -.07)
        self.assertAlmostEqual(max(p[1] for p in part['points']), -.05)
        self.assertAlmostEqual(max(p[2] for p in part['points']), .15)
        top = [p for p in part['points'][:8] if p[2] > .14]
        self.assertEqual(len(top), 5)
        opposite = baseboard_part(dict(segment, side='neg'), .1)
        self.assertEqual(opposite['points'], [[x, -y, z] for x, y, z in part['points']])

    def test_explicit_profile_radius_overrides_default(self):
        segment = {'s0': 0, 's1': 1, 'height': .15, 'depth': .02, 'radius': .004, 'profile': 'rounded', 'side': 'pos'}
        part = baseboard_part(segment, .1)
        points = part['points'][:8]
        self.assertAlmostEqual(points[2][2], .146)
        self.assertAlmostEqual(points[6][1], -.066)
        self.assertAlmostEqual(points[6][2], .15)
        self.assertEqual(len(baseboard_part(dict(segment, radius=0), .1)['points']), 8)
        self.assertEqual(scaled_baseboard({'radius': .004}, 2, 3)['radius'], .008)

    def test_rectangular_and_disabled_profiles(self):
        segment = {'s0': 0, 's1': 1, 'height': .12, 'depth': .01, 'profile': 'rectangular', 'side': 'neg'}
        part = baseboard_part(segment, .1)
        self.assertEqual((len(part['points']), len(part['faces'])), (8, 6))
        self.assertIsNone(baseboard_part(dict(segment, height=0), .1))
        self.assertIsNone(baseboard_part(dict(segment, depth=0), .1))
        self.assertIsNone(baseboard_part(dict(segment, s1=0), .1))

    def test_baseboard_scaling_preserves_labels_and_unscaled_precision(self):
        raw = {'height': .123456789, 'depth': .012345678, 'profile': 'rounded'}
        self.assertEqual(scaled_baseboard(raw, 1, 1), raw)
        scaled = scaled_baseboard(raw, 2, 3)
        self.assertEqual(scaled, {'height': .37037, 'depth': .024691, 'profile': 'rounded'})
        self.assertEqual(raw['height'], .123456789)


@unittest.skipUnless(library_path(), 'SketchUp SDK not installed')
class NativeOpeningDetailTests(unittest.TestCase):
    def test_open_leaf_handing_on_rotated_wall_matches_world_coordinates(self):
        angle = math.radians(60)
        ux, uy, nx, ny = math.cos(angle), math.sin(angle), -math.sin(angle), math.cos(angle)
        for hinge in ('start', 'end'):
            with self.subTest(hinge=hinge), tempfile.TemporaryDirectory() as temp:
                root = Path(temp); source = spec(); source['rooms'] = []
                wall = source['walls'][0]
                wall.update(ax=1, ay=2, bx=1+4*ux, by=2+4*uy, holes=[door(hinge)])
                (root/'mirror.json').write_text(json.dumps(source))
                result = subprocess.run([sys.executable, str(ROOT/'server/sketchup_mirror.py'), 'write', str(root)],
                                        capture_output=True, text=True, timeout=60)
                self.assertEqual(result.returncode, 0, result.stderr)
                points = named_world_points(root/'model.skp', 'Slab leaf')
                self.assertEqual(len(points), 8)
                centre = [sum(q[i] for q in points)/8 for i in range(3)]
                along = .6 + (.022+.003 if hinge == 'start' else .8-.022-.003)
                direction = 1 if hinge == 'start' else -1
                along += direction*.75/2*math.cos(math.radians(25))
                normal = .75/2*math.sin(math.radians(25))
                expected = [1+ux*along+nx*normal, 2+uy*along+ny*normal, .01+1.95/2]
                for actual, wanted in zip(centre, expected):
                    self.assertAlmostEqual(actual, wanted, places=7)
                distances = sorted({round(math.dist(points[0], q), 6) for q in points[1:]})
                self.assertIn(.75, distances, 'the world-space leaf edge preserves its specified width')
                self.assertIn(1.95, distances, 'the world-space leaf edge preserves its specified height')

    def test_native_baseboards_do_not_change_wall_bounds_or_bridge_doorway(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); source = spec()
            wall = source['walls'][0]
            wall['baseboardPos'] = {'height': .15, 'depth': .02, 'profile': 'rounded'}
            wall['baseboardNeg'] = {'height': 0, 'depth': .01, 'profile': 'rectangular'}
            wall['baseboards'] = [dict(wall['baseboardPos'], s0=a, s1=b, side='pos', material=TRIM)
                                  for a, b in ((0, .6), (1.4, 4))]
            (root/'mirror.json').write_text(json.dumps(source))
            for operation in ('write', 'read'):
                if operation == 'read':
                    shutil.copy(root/'model.skp', root/'source.skp')
                result = subprocess.run([sys.executable, str(ROOT/'server/sketchup_mirror.py'), operation, str(root)],
                                        capture_output=True, text=True, timeout=60)
                self.assertEqual(result.returncode, 0, result.stderr)
            read = json.loads((root/'mirror-read.json').read_text())
            self.assertEqual(read['walls'][0]['now'], read['walls'][0]['base'])
            self.assertEqual(read['walls'][0]['now']['baseboardPos'], wall['baseboardPos'])
            self.assertEqual(read['walls'][0]['now']['baseboardNeg']['height'], 0)
            points = named_world_points(root/'model.skp', 'Baseboard pos')
            self.assertFalse(any(.600001 < p[0] < 1.399999 for p in points))
            self.assertAlmostEqual(max(p[2] for p in points), .15)
            self.assertAlmostEqual(max(p[1] for p in points), .07)
            self.assertEqual(inspect_groups(root/'model.skp')['wall']['children'].count('Baseboard pos'), 2)
            self.assertEqual(named_world_points(root/'model.skp', 'Baseboard neg'), [])

    def test_detailed_model_roundtrip_keeps_opening_and_room_dimensions(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); source = spec()
            source['walls'][0]['holes'][0]['floorContinuity'] = False
            source['walls'][0]['holes'][0]['configuration'] = {'leaves': 1, 'doorState': 'open'}
            (root / 'mirror.json').write_text(json.dumps(source))
            for operation in ('write', 'read'):
                if operation == 'read':
                    shutil.copy(root / 'model.skp', root / 'source.skp')
                result = subprocess.run([sys.executable, str(ROOT / 'server/sketchup_mirror.py'), operation, str(root)],
                                        capture_output=True, text=True, timeout=60)
                self.assertEqual(result.returncode, 0, result.stderr)
            read = json.loads((root / 'mirror-read.json').read_text())
            self.assertEqual(read['warnings'], [])
            for opening in read['walls'][0]['openings']:
                self.assertEqual(opening['now'], opening['base'])
            self.assertFalse(read['walls'][0]['openings'][0]['now']['floorContinuity'])
            self.assertEqual(read['walls'][0]['openings'][0]['now']['configuration'], {'leaves': 1, 'doorState': 'open'})
            self.assertEqual(read['rooms'][0]['now'], read['rooms'][0]['base'])
            observed = inspect_groups(root / 'model.skp')
            self.assertTrue(observed['door']['hidden'], 'the dimension anchor must be invisible')
            self.assertIn('Slab leaf', observed['door']['children'])
            self.assertEqual(observed['door']['children'].count('Door knob'), 2)
            self.assertIn('Upper sash glass', observed['window']['children'])
            self.assertIn('Floor through opening', observed['room']['children'])
            ceiling = observed['room']['parts']['Finished ceiling']
            self.assertAlmostEqual(ceiling[0][2] / IN, 2.5)
            self.assertAlmostEqual(ceiling[1][2] / IN, 2.527)


def named_world_points(path, name):
    api, model = API(), Ref(); out = set()
    identity = [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]
    def walk(entities, matrix):
        for group in api.collection(entities, 'Groups'):
            transform = multiply(matrix, group_transform(api, group))
            inner = api.ref('SUGroupGetEntities', group)
            if api.text('SUGroupGetName', group) == name:
                for face in api.collection(inner, 'Faces'):
                    for point in face_ring(api, face):
                        x, y, z = apply(transform, point)
                        out.add((round(x/IN, 9), round(-y/IN, 9), round(z/IN, 9)))
            walk(inner, transform)
    try:
        api.call('SUModelCreateFromFile', C.byref(model), str(path).encode())
        walk(api.ref('SUModelGetEntities', model), identity)
        return sorted(out)
    finally:
        if model.ptr:
            api.call('SUModelRelease', C.byref(model))
        api.lib.SUTerminate()


def inspect_groups(path):
    api, model = API(), Ref(); out = {}
    def walk(entities):
        for group in api.collection(entities, 'Groups'):
            data = get_data(api, to_ref(api, 'SUGroupToEntity', group))
            inner = api.ref('SUGroupGetEntities', group)
            if data and data.get('id'):
                hidden = []
                for face in api.collection(inner, 'Faces'):
                    value = C.c_bool()
                    api.call('SUDrawingElementGetHidden', to_ref(api, 'SUFaceToDrawingElement', face), C.byref(value))
                    hidden.append(value.value)
                children = list(api.collection(inner, 'Groups'))
                names = [api.text('SUGroupGetName', child) for child in children]
                out[data['id']] = {'hidden': bool(hidden) and all(hidden), 'children': names,
                                   'parts': {name: face_bounds(api, api.ref('SUGroupGetEntities', child))
                                             for name, child in zip(names, children)}}
            walk(inner)
    try:
        api.call('SUModelCreateFromFile', C.byref(model), str(path).encode())
        walk(api.ref('SUModelGetEntities', model))
        return out
    finally:
        if model.ptr:
            api.call('SUModelRelease', C.byref(model))
        api.lib.SUTerminate()
