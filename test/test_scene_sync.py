"""Saved views <-> SketchUp scenes in the sync file, and the standard view set, on synthetic
models only: the browser's spec written by the real SketchUp C API, edited the way SketchUp
saves a file, read back and merged by the browser's code (test/scene-sync-driver.mjs)."""
import ctypes as C
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

from server.sketchup_convert import library_path
from server.standard_scenes import standard_set

REPO = Path(__file__).resolve().parent.parent
WORKER = REPO / 'server/sketchup_mirror.py'
DRIVER = REPO / 'test/scene-sync-driver.mjs'
FIXTURE = REPO / 'test/fixtures/standard-views.json'


def close(test, got, want, path='set'):
    if isinstance(want, dict):
        test.assertEqual(set(got), set(want), path)
        for k in want: close(test, got[k], want[k], path + '.' + k)
    elif isinstance(want, list):
        test.assertEqual(len(got), len(want), path)
        for i, (a, b) in enumerate(zip(got, want)): close(test, a, b, f'{path}[{i}]')
    elif isinstance(want, float) or isinstance(got, float):
        test.assertAlmostEqual(got, want, delta=2e-6, msg=path)
    else:
        test.assertEqual(got, want, path)


class StandardRulesTests(unittest.TestCase):
    def test_python_makes_the_same_set_as_the_browser(self):
        """server/standard_scenes.py and js/standard-views.js: one set from one building."""
        for case in json.loads(FIXTURE.read_text(encoding='utf-8'))['cases']:
            close(self, standard_set(case['input']), case['views'], case['about'])

    def test_short_walls_and_straight_runs(self):
        pts = [[0, 0], [2, 0], [4, 0], [4, 3], [0.3, 3], [0.3, 2.8], [0, 2.8]]   # a 7 7/8" jog
        room = {'id': 'r', 'name': 'Den', 'level': 'l', 'z': 0, 'height': 2.4, 'pts': pts}
        names = [v['name'] for v in standard_set({'north': 0, 'levels': [{'id': 'l', 'name': 'L', 'elevation': 0, 'height': 2.4}], 'rooms': [room], 'walls': []})]
        self.assertEqual(names, ['Overview', 'Plan', 'Den, north wall', 'Den, east wall', 'Den, south wall', 'Den, west wall'])


def api_model(path):
    from server.sketchup_convert import API, Ref
    api = API(); model = Ref()
    api.call('SUModelCreateFromFile', C.byref(model), os.fsencode(path))
    return api, model


def close_model(api, model, save=None):
    from server.sketchup_convert import Ref  # noqa: F401
    try:
        if save: api.call('SUModelSaveToFile', model, os.fsencode(save))
    finally:
        api.call('SUModelRelease', C.byref(model)); api.lib.SUTerminate()


def edit_like_sketchup(source, output, move=None, rename=None, delete=None, add=None, recut=None):
    """What an owner does in SketchUp, through the C API: move a scene's camera (metres along
    world x), rename one, delete one, add a scene hiding a tag, move a scene's cut."""
    from server.sketchup_convert import Ref, Point, Vector
    from server.sketchup_scenes import model_scenes, model_layers, Plane, FLAG_USE_SECTION_PLANES
    api, model = api_model(source)
    try:
        by_name = {api.text('SUSceneGetName', s): s for s in model_scenes(api, model)}
        if move:
            name, dx = move
            cam = Ref(); api.call('SUSceneGetCamera', by_name[name], C.byref(cam))
            e, t, u = Point(), Point(), Vector()
            api.call('SUCameraGetOrientation', cam, C.byref(e), C.byref(t), C.byref(u))
            e.x += dx / 0.0254; t.x += dx / 0.0254
            api.call('SUCameraSetOrientation', cam, C.byref(e), C.byref(t), C.byref(u))
            api.call('SUSceneSetCamera', by_name[name], cam)
        if rename:
            api.call('SUSceneSetName', by_name[rename[0]], rename[1].encode())
        if delete:
            api.call('SUModelRemoveScenes', model, C.c_size_t(1), (Ref * 1)(by_name[delete]))
        if add:
            name, hidden = add
            scene = Ref(); api.call('SUSceneCreate', C.byref(scene)); api.call('SUSceneSetName', scene, name.encode())
            index = C.c_int(); api.call('SUModelAddScene', model, C.c_int(-1), scene, C.byref(index))
            cam = Ref(); api.call('SUCameraCreate', C.byref(cam))
            api.call('SUCameraSetOrientation', cam, C.byref(Point(160, 20, 60)), C.byref(Point(40, -60, 40)), C.byref(Vector(0, 0, 1)))
            api.call('SUCameraSetPerspectiveFrustumFOV', cam, C.c_double(40))
            api.call('SUSceneSetCamera', scene, cam); api.call('SUCameraRelease', C.byref(cam))
            api.call('SUSceneSetUseCamera', scene, C.c_bool(True)); api.call('SUSceneSetUseHiddenLayers', scene, C.c_bool(True))
            if hidden: api.call('SUSceneAddLayer', scene, model_layers(api, model)[hidden])
        if recut:
            # Slide the scene's own section plane `inches` along its normal (toward the camera here).
            name, inches = recut
            scene = by_name[name]
            n = C.c_size_t(); api.call('SUSceneGetNumActiveSectionPlanes', scene, C.byref(n))
            refs = (Ref * n.value)(); api.call('SUSceneGetActiveSectionPlanes', scene, n, refs, C.byref(n))
            p = Plane(); api.call('SUSectionPlaneGetPlane', refs[0], C.byref(p))
            p.d += inches
            api.call('SUSectionPlaneSetPlane', refs[0], C.byref(p))
    finally:
        close_model(api, model, output)


@unittest.skipUnless(library_path(), 'SketchUp SDK not installed')
class NativeSceneSyncTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.root = Path(self.temp.name)
        self.state = self.root / 'state.json'

    def tearDown(self):
        self.temp.cleanup()

    def node(self, *args):
        r = subprocess.run(['node', str(DRIVER), *map(str, args)], capture_output=True, text=True, timeout=60, cwd=REPO)
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(r.stdout.strip().splitlines()[-1]) if r.stdout.strip() else None

    def worker(self, op, folder):
        r = subprocess.run([sys.executable, str(WORKER), op, str(folder)], capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(r.stdout.strip().splitlines()[-1])

    def write(self, existing=None):
        job = self.root / ('write-' + str(len(list(self.root.iterdir()))))
        job.mkdir()
        self.node('spec', self.state, job / 'mirror.json')
        if existing: shutil.copy(existing, job / 'existing.skp')
        self.worker('write', job)
        return job / 'model.skp'

    def merge(self, skp):
        job = self.root / ('read-' + str(len(list(self.root.iterdir()))))
        job.mkdir()
        shutil.copy(skp, job / 'source.skp')
        self.worker('read', job)
        self.last_read = json.loads((job / 'mirror-read.json').read_text())
        return self.node('merge', self.state, job / 'mirror-read.json')

    def scenes(self, skp):
        from server.sketchup_scenes import read_views, section_planes
        api, model = api_model(skp)
        try:
            views = read_views(api, model)
            planes = len(section_planes(api, api.ref('SUModelGetEntities', model)))
        finally:
            close_model(api, model)
        return views, planes

    def test_views_become_scenes_and_a_round_trip_changes_nothing(self):
        start = self.node('init', self.state)
        mine = [v for v in start['views'] if v['name'] != 'Imported scene']
        self.assertEqual(len(mine), 7)   # overview, plan, four elevations, the owner's view
        skp = self.write()
        scenes, planes = self.scenes(skp)
        # One scene per view, in Tiksi's order, each with the view's id; the imported model's view is not one.
        self.assertEqual([s['name'] for s in scenes], [v['name'] for v in mine])
        self.assertEqual([s['id'] for s in scenes], [v['id'] for v in mine])
        self.assertTrue(all(s['origin'] == 'tiksi' for s in scenes))
        by = {s['name']: s for s in scenes}
        # The plan: parallel, straight down, cut 4'-0" up, the level's tag not hidden (one level).
        plan = by['Plan']['camera']
        self.assertFalse(plan['perspective'])
        self.assertLess(plan['target'][1] - plan['eye'][1], 0)
        self.assertAlmostEqual(by['Plan']['cut']['point'][1], 1.2192, places=4)
        self.assertEqual(by['Plan']['cut']['normal'], [0.0, 1.0, 0.0])
        # An elevation: parallel, level, its cut 1" inside the far wall, taking away the camera's side.
        north = by['Studio, north wall']
        self.assertFalse(north['camera']['perspective'])
        self.assertAlmostEqual(north['camera']['eye'][1], north['camera']['target'][1], places=6)
        self.assertAlmostEqual(north['cut']['point'][2], 3 - 0.0254, places=4)
        self.assertEqual([round(v, 4) for v in north['cut']['normal']], [0.0, 0.0, 1.0])
        # The owner's view: perspective at its angle, Furniture hidden, no cut.
        corner = by['Corner look']
        self.assertTrue(corner['camera']['perspective'])
        self.assertAlmostEqual(corner['camera']['fov'], 55, places=4)
        self.assertEqual(corner['hiddenTags'], ['Furniture'])
        self.assertNotIn('cut', corner)
        self.assertEqual(planes, 5)   # the plan's cut and the four elevations'
        # As SketchUp itself saves a cut-open elevation (the 57 scenes of a real shop-drawings
        # model all do): the camera stands on the side the plane takes away, and the plane's
        # normal points the way the camera looks, at what stays.
        from server.sketchup_convert import Ref, Point, Vector
        from server.sketchup_scenes import model_scenes, Plane
        api, model = api_model(skp)
        try:
            checked = 0
            for scene in model_scenes(api, model):
                n = C.c_size_t(); api.call('SUSceneGetNumActiveSectionPlanes', scene, C.byref(n))
                if not n.value: continue
                refs = (Ref * n.value)(); api.call('SUSceneGetActiveSectionPlanes', scene, n, refs, C.byref(n))
                p = Plane(); api.call('SUSectionPlaneGetPlane', refs[0], C.byref(p))
                cam = Ref(); api.call('SUSceneGetCamera', scene, C.byref(cam))
                e, t, u = Point(), Point(), Vector(); api.call('SUCameraGetOrientation', cam, C.byref(e), C.byref(t), C.byref(u))
                self.assertLess(p.a * e.x + p.b * e.y + p.c * e.z + p.d, 0)
                self.assertGreater(p.a * (t.x - e.x) + p.b * (t.y - e.y) + p.c * (t.z - e.z), 0)
                checked += 1
            self.assertEqual(checked, 5)
        finally:
            close_model(api, model)
        # Read straight back: nothing changed on either side.
        self.assertEqual({k: self.merge(skp)[k] for k in ('applied', 'added', 'deleted', 'conflicts')}, {'applied': [], 'added': [], 'deleted': 0, 'conflicts': []})
        # Written again over itself: the same scenes and cuts, none piled up.
        again = self.write(skp)
        scenes2, planes2 = self.scenes(again)
        self.assertEqual([(s['id'], s['name']) for s in scenes2], [(s['id'], s['name']) for s in scenes])
        self.assertEqual(planes2, 5)
        self.assertEqual(self.merge(again)['applied'], [])

    def test_sketchup_edits_come_back_and_a_new_scene_keeps_its_view(self):
        self.node('init', self.state)
        skp = self.write()
        self.merge(skp)
        edited = self.root / 'edited.skp'
        edit_like_sketchup(skp, edited, move=('Studio, east wall', 0.3), rename=('Corner look', 'Corner, from the door'),
                           delete='Studio, south wall', add=('Detail', 'Furniture'), recut=('Studio, north wall', 6))
        r = self.merge(edited)
        self.assertEqual(sorted(r['applied']), ['Corner, from the door', 'Studio, east wall', 'Studio, north wall'])
        self.assertEqual(r['added'], ['Detail'])
        self.assertEqual(r['deleted'], 1)
        self.assertEqual(r['conflicts'], [])
        views = {v['name']: v for v in r['views']}
        self.assertNotIn('Studio, south wall', views)
        east = views['Studio, east wall']
        self.assertAlmostEqual(east['camera']['target'][0], 4.3, places=4)   # moved 11 13/16" (0.3 m) east
        self.assertTrue(east['camera']['parallel'])
        # The north wall's cut slid 6" toward its camera; still the view's own cut, still on.
        cut = views['Studio, north wall']['section']
        self.assertTrue(cut['on'])
        self.assertAlmostEqual(cut['planes'][0]['pos'][2], 3 - 0.0254 + 6 * 0.0254, places=4)
        detail = views['Detail']
        self.assertEqual(detail['source'], {'app': 'sketchup-sync', 'scene': 'Detail'})
        self.assertFalse(detail['camera'].get('parallel', False))
        self.assertAlmostEqual(detail['camera']['fov'], 40, places=4)
        self.assertEqual([on for on in detail['tags'].values()].count(False), 1)
        # The next write tags the new scene instead of adding another; reading it again changes nothing.
        rewritten = self.write(edited)
        scenes, planes = self.scenes(rewritten)
        names = [s['name'] for s in scenes]
        self.assertEqual(names.count('Detail'), 1)
        detail_scene = next(s for s in scenes if s['name'] == 'Detail')
        self.assertEqual(detail_scene['id'], detail['id'])
        self.assertEqual(detail_scene['origin'], 'sketchup')
        self.assertEqual(planes, 4)   # the south wall's cut went with its view
        again = self.merge(rewritten)
        self.assertEqual((again['applied'], again['added'], again['deleted'], again['conflicts']), ([], [], 0, []))
        self.assertEqual(len(again['views']), len(r['views']))

    def test_both_sides_changed_one_view_keeps_tiksi(self):
        self.node('init', self.state)
        skp = self.write()
        self.merge(skp)
        self.node('tiksi-move', self.state, 'Studio, west wall')
        edited = self.root / 'edited.skp'
        edit_like_sketchup(skp, edited, move=('Studio, west wall', -0.4))
        r = self.merge(edited)
        self.assertEqual(r['applied'], [])
        self.assertEqual(r['conflicts'], ['changed in both; kept the Tiksi version'])
        west = next(v for v in r['views'] if v['name'] == 'Studio, west wall')
        self.assertAlmostEqual(west['camera']['target'][0], 0.5, places=4)   # Tiksi's move, 1'-7 11/16" (0.5 m)

    def test_build_scripts_add_the_same_standard_scenes(self):
        """scripts/standard-scenes.py on a SketchUp file with no Tiksi groups, rooms from JSON:
        the standard set as scenes; running again refreshes them and leaves the owner's alone."""
        from server.sketchup_convert import API, Ref
        api = API(); model = Ref(); api.call('SUModelCreate', C.byref(model))
        blank = self.root / 'blank.skp'
        close_model(api, model, blank)
        case = json.loads(FIXTURE.read_text(encoding='utf-8'))['cases'][0]
        rooms = self.root / 'rooms.json'; rooms.write_text(json.dumps(case['input']))
        script = REPO / 'scripts/standard-scenes.py'
        first = self.root / 'first.skp'
        r = subprocess.run([sys.executable, str(script), str(blank), str(first), '--rooms', str(rooms)], capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)
        mine = self.root / 'mine.skp'
        edit_like_sketchup(first, mine, add=('Owner scene', None))
        second = self.root / 'second.skp'
        r = subprocess.run([sys.executable, str(script), str(mine), str(second), '--rooms', str(rooms)], capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)
        scenes, planes = self.scenes(second)
        owner = [s for s in scenes if s['name'] == 'Owner scene']
        self.assertEqual(len(owner), 1)
        self.assertNotIn('id', owner[0])
        scenes = [s for s in scenes if s['name'] != 'Owner scene']
        self.assertEqual([s['name'] for s in scenes], [v['name'] for v in case['views']])
        self.assertTrue(all(s['id'].startswith('std-') for s in scenes))
        self.assertEqual(planes, len(case['views']) - 1)   # every view but the overview has a cut
        for scene, view in zip(scenes, case['views']):
            self.assertEqual(scene['camera']['perspective'], not view['camera'].get('parallel', False))
            for got, want in zip(scene['camera']['target'], view['camera']['target']):
                self.assertAlmostEqual(got, want, delta=1e-4)
        # Its own output is refused as its own target, and a Trimble Connect Sync folder is never written.
        bad = subprocess.run([sys.executable, str(script), str(second), str(second), '--rooms', str(rooms)], capture_output=True, text=True, timeout=60)
        self.assertNotEqual(bad.returncode, 0)
        sync = self.root / 'Trimble Connect Sync' / 'x.skp'
        bad = subprocess.run([sys.executable, str(script), str(second), str(sync), '--rooms', str(rooms)], capture_output=True, text=True, timeout=60)
        self.assertNotEqual(bad.returncode, 0)
        self.assertFalse(sync.exists())


if __name__ == '__main__':
    unittest.main()
